// The second round of 0.6.0 mobile edges, one test per issue the fix
// verification found (R regressions, I and L incomplete fixes, T fixes no
// test guarded, P bugs found in passing): the files massimo owns, the Swift
// floors, the bundle a colour is read from, colour sets dedupe must keep,
// what detect proposes, the Android outputs and readers, and config.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { COMPOSE_OUT, OWNED, SWIFT_OUT, XCASSETS_OUT, XML_OUT, extracted, put, read, readConfig, repo, scratch, srgb, tok, tokensMode, tokensRun, writeConfig } from './mobile-helpers.mjs'

const listed = (root) => JSON.parse(read(root, 'ds/tokens/mobile-outputs.json')).files
const git = (root, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' })

// ── The files massimo owns ──────────────────────────────────────────────────

// R1
test('a checkout that turned the outputs\' line endings into CRLF builds: git\'s conversion is not a hand edit', () => {
  const root = repo({ config: tokensMode([COMPOSE_OUT, XML_OUT, SWIFT_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'), { modes: { dark: srgb('#bb86fc') } })] })
  assert.equal(tokensRun(root, ['build']).status, 0)
  for (const path of Object.keys(listed(root))) writeFileSync(join(root, path), read(root, path).replace(/\n/g, '\r\n'))
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(tokensRun(root, ['check']).status, 0)
  // A hand edit is still one, and the message offers a way out that always works.
  writeFileSync(join(root, COMPOSE_OUT.path), read(root, COMPOSE_OUT.path).replace('package', '// ours\npackage'))
  const edited = tokensRun(root, ['build'])
  assert.equal(edited.status, 1)
  assert.match(edited.stderr, /changed by hand[\s\S]*delete it and build again/)
})

// R7
test('a mobile output in a sibling folder of the same git repo builds when the config sits in a subfolder', () => {
  const base = scratch()
  const root = repo({ config: tokensMode([{ format: 'swift', path: '../ios/App/DesignTokens.swift' }]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  const top = join(root, '..')
  git(top, 'init', '-q')
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(top, 'ios/App/DesignTokens.swift')))
  assert.ok(base)
  // Outside the git repo it is still refused, and the message names no symlink when there is none.
  const lone = repo({ config: tokensMode([{ format: 'swift', path: '../ios/App/DesignTokens.swift' }]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  const out = tokensRun(lone, ['build'])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /outside the repo/)
  assert.doesNotMatch(out.stderr, /symlink/)
})

// R9
test('check lists a listed path that has become a folder instead of crashing', () => {
  const root = repo({ config: tokensMode([SWIFT_OUT, XML_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  assert.equal(tokensRun(root, ['build']).status, 0)
  const config = readConfig(root)
  config.tokens.outputs = [XML_OUT]
  writeConfig(root, config)
  const file = join(root, SWIFT_OUT.path)
  execFileSync('rm', [file])
  mkdirSync(file)
  put(root, { [`${SWIFT_OUT.path}/Inside.swift`]: 'let x = 1\n' })
  const c = tokensRun(root, ['check'])
  assert.equal(c.status, 1)
  assert.doesNotMatch(c.stderr, /EISDIR/)
  assert.match(c.stderr, /orphan: ios\/App\/DesignTokens\.swift/)
  const b = tokensRun(root, ['build', '--prune'])
  assert.equal(b.status, 0, b.stderr)
  assert.ok(existsSync(join(file, 'Inside.swift')))
  assert.equal(tokensRun(root, ['check']).status, 0)
})

// I5
test('a dangling symlink at an output path never lets a build write outside the repo', () => {
  const root = repo({ config: tokensMode([SWIFT_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  const outside = join(root, '..', 'outside')
  mkdirSync(join(root, 'ios/App'), { recursive: true })
  symlinkSync('../../../outside/pwned.swift', join(root, SWIFT_OUT.path))
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /outside the repo \(a symlink on the way leads out\)/)
  assert.ok(!existsSync(join(outside, 'pwned.swift')))
})

// L6
test('a case-only rename of an output reaches the disk, and a renamed catalog is never read as the app\'s', () => {
  const root = repo({ config: tokensMode([SWIFT_OUT, XCASSETS_OUT], { }), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  const config = readConfig(root)
  config.tokens.mobileSources = [{ kind: 'xcassets', path: 'ios/App/*.xcassets' }]
  writeConfig(root, config)
  assert.equal(tokensRun(root, ['build']).status, 0)
  config.tokens.outputs = [{ format: 'swift', path: 'ios/App/Designtokens.swift' }, { format: 'xcassets', path: 'ios/App/Massimotokens.xcassets' }]
  writeConfig(root, config)
  const r = tokensRun(root, ['build', '--prune', '--dedupe'])
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /duplicates|removed \d+ colour set/)
  const names = readdirSync(join(root, 'ios/App')).sort()
  assert.deepEqual(names, ['Designtokens.swift', 'Massimotokens.xcassets'])
  assert.ok(existsSync(join(root, 'ios/App/Massimotokens.xcassets/Primary.colorset/Contents.json')))
  assert.deepEqual(Object.keys(listed(root)).filter((p) => p.endsWith('.swift')), ['ios/App/Designtokens.swift'])
  assert.equal(tokensRun(root, ['check']).status, 0)
})

// T2
test('a listed path that is a second name of a file the build writes is never pruned as an orphan of itself (a case-only rename, or a hard link)', () => {
  // Linux CI has no disk that ignores case, so the same file under two names is made with a hard link.
  const root = repo({ config: tokensMode([SWIFT_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  assert.equal(tokensRun(root, ['build']).status, 0)
  const other = 'ios/App/Tokens.swift'
  linkSync(join(root, SWIFT_OUT.path), join(root, other))
  const files = listed(root)
  writeFileSync(join(root, 'ds/tokens/mobile-outputs.json'), JSON.stringify({ format: 1, writtenBy: '0.6.0', files: { ...files, [other]: files[SWIFT_OUT.path] } }))
  const r = tokensRun(root, ['build', '--prune'])
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /removed/)
  assert.ok(existsSync(join(root, other)))
})

// L7
test('a plain build never asks to OK a dedupe of a colour set behind a symlink leading outside the repo', () => {
  const base = scratch()
  put(base, { 'shared/Colors.xcassets/Contents.json': { info: { author: 'xcode', version: 1 } }, 'shared/Colors.xcassets/Ink.colorset/Contents.json': { colors: [{ color: { 'color-space': 'srgb', components: { alpha: '1.000', blue: '0x33', green: '0x22', red: '0x11' } }, idiom: 'universal' }], info: { author: 'xcode', version: 1 } } })
  const root = repo({ config: tokensMode([XCASSETS_OUT]), tokens: [tok(['color', 'ink'], 'color', srgb('#112233'), { mobile: { asset: 'Ink' } })] })
  mkdirSync(join(root, 'ios/Shared'), { recursive: true })
  symlinkSync(join(base, 'shared/Colors.xcassets'), join(root, 'ios/Shared/Colors.xcassets'))
  const config = readConfig(root)
  config.tokens.mobileSources = [{ kind: 'xcassets', path: 'ios/Shared/Colors.xcassets' }]
  writeConfig(root, config)
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /run build --dedupe/)
  assert.match(r.stdout, /ios\/Shared\/Colors\.xcassets\/Ink\.colorset/)
})

// L8
test('a hand edit that keeps massimo\'s header is never written over: off the list and back, renamed in case, or with no list at all', () => {
  const edit = (root, path) => writeFileSync(join(root, path), read(root, path).replace('enum DesignTokens', '// our tweak, keep\nenum DesignTokens'))
  // Off the list (released as the team's), then the output is added again.
  const a = repo({ config: tokensMode([SWIFT_OUT, XML_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  assert.equal(tokensRun(a, ['build']).status, 0)
  edit(a, SWIFT_OUT.path)
  const config = readConfig(a)
  config.tokens.outputs = [XML_OUT]
  writeConfig(a, config)
  assert.equal(tokensRun(a, ['build', '--prune']).status, 0)
  config.tokens.outputs = [SWIFT_OUT, XML_OUT]
  writeConfig(a, config)
  const back = tokensRun(a, ['build'])
  assert.equal(back.status, 1)
  assert.match(read(a, SWIFT_OUT.path), /our tweak, keep/)
  // Renamed only in case.
  const b = repo({ config: tokensMode([SWIFT_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  assert.equal(tokensRun(b, ['build']).status, 0)
  edit(b, SWIFT_OUT.path)
  const cb = readConfig(b)
  cb.tokens.outputs = [{ format: 'swift', path: 'ios/App/Designtokens.swift' }]
  writeConfig(b, cb)
  assert.equal(tokensRun(b, ['build']).status, 1)
  assert.match(readFileSync(join(b, 'ios/App', readdirSync(join(b, 'ios/App'))[0]), 'utf8'), /our tweak, keep/)
  // With no mobile-outputs.json.
  const c = repo({ config: tokensMode([SWIFT_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  assert.equal(tokensRun(c, ['build']).status, 0)
  edit(c, SWIFT_OUT.path)
  execFileSync('rm', [join(c, 'ds/tokens/mobile-outputs.json')])
  const none = tokensRun(c, ['build'])
  assert.equal(none.status, 1)
  assert.match(read(c, SWIFT_OUT.path), /our tweak, keep/)
})

// T1
test('containment: a listed key outside the repo is never removed, an output outside it or behind a symlink leading out is refused, and --dedupe leaves a set behind one in place', () => {
  // A key that leaves the repo, with the real hash of the file there.
  const root = repo({ config: tokensMode([XML_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  writeFileSync(join(root, '..', 'keep.txt'), 'not massimo\'s\n')
  const hash = execFileSync('shasum', ['-a', '256', join(root, '..', 'keep.txt')], { encoding: 'utf8' }).split(' ')[0]
  put(root, { 'ds/tokens/mobile-outputs.json': { format: 1, writtenBy: '0.6.0', files: { '../keep.txt': hash } } })
  assert.equal(tokensRun(root, ['build', '--prune']).status, 0)
  assert.ok(existsSync(join(root, '..', 'keep.txt')))
  // A path with .. that leaves the repo, and an output folder that is a symlink leading out.
  const up = repo({ config: tokensMode([{ format: 'swift', path: '../Out.swift' }]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  assert.equal(tokensRun(up, ['build']).status, 1)
  assert.ok(!existsSync(join(up, '..', 'Out.swift')))
  const linked = repo({ config: tokensMode([SWIFT_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  mkdirSync(join(linked, '..', 'elsewhere'))
  mkdirSync(join(linked, 'ios'))
  symlinkSync(join(linked, '..', 'elsewhere'), join(linked, 'ios/App'))
  const l = tokensRun(linked, ['build'])
  assert.equal(l.status, 1)
  assert.match(l.stderr, /a symlink on the way leads out/)
  assert.deepEqual(readdirSync(join(linked, '..', 'elsewhere')), [])
  // --dedupe and a team set behind a symlink leading out.
  const base = scratch()
  const set = { colors: [{ color: { 'color-space': 'srgb', components: { alpha: '1.000', blue: '0x33', green: '0x22', red: '0x11' } }, idiom: 'universal' }], info: { author: 'xcode', version: 1 } }
  put(base, { 'shared/Colors.xcassets/Contents.json': { info: { author: 'xcode', version: 1 } }, 'shared/Colors.xcassets/Ink.colorset/Contents.json': set })
  const d = repo({ config: tokensMode([XCASSETS_OUT]), tokens: [tok(['color', 'ink'], 'color', srgb('#112233'), { mobile: { asset: 'Ink' } })] })
  mkdirSync(join(d, 'ios/Shared'), { recursive: true })
  symlinkSync(join(base, 'shared/Colors.xcassets'), join(d, 'ios/Shared/Colors.xcassets'))
  const dc = readConfig(d)
  dc.tokens.mobileSources = [{ kind: 'xcassets', path: 'ios/Shared/Colors.xcassets' }]
  writeConfig(d, dc)
  const dd = tokensRun(d, ['build', '--dedupe'])
  assert.equal(dd.status, 0, dd.stderr)
  assert.match(dd.stdout, /left in place, since a symlink leads outside the repo/)
  assert.ok(existsSync(join(base, 'shared/Colors.xcassets/Ink.colorset/Contents.json')))
})

// L9
test('after a dedupe, catalog mode never reads a colour set from the catalog massimo wrote, which --prune then removes', () => {
  const { root } = extracted({ colors: 'tokens', outputs: [{ format: 'xcassets', path: OWNED }, { format: 'swift', path: 'Sources/DesignSystem/DesignTokens.swift' }] })
  assert.equal(tokensRun(root, ['build', '--dedupe']).status, 0)
  const config = readConfig(root)
  config.tokens.mobile.colors = 'catalog'
  config.tokens.outputs = [{ format: 'swift', path: 'Sources/DesignSystem/DesignTokens.swift' }]
  writeConfig(root, config)
  const r = tokensRun(root, ['build', '--prune'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!existsSync(join(root, OWNED)))
  const swift = read(root, 'Sources/DesignSystem/DesignTokens.swift')
  assert.doesNotMatch(swift, /Color\("Brand\/Primary"/)
  assert.match(r.stdout, /color\.Brand\.Primary is not a colour set in the app's catalog/)
  assert.equal(tokensRun(root, ['check']).status, 0)
})
