// The second round of 0.6.0 mobile edges, one test per issue the fix
// verification found (R regressions, I and L incomplete fixes, T fixes no
// test guarded, P bugs found in passing): the files massimo owns, the Swift
// floors, the bundle a colour is read from, colour sets dedupe must keep,
// what detect proposes, the Android outputs and readers, and config.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { iosWire } from '../scripts/lib/platform-ios.mjs'
import { minScriptsWarning, needsScripts } from '../scripts/lib/project.mjs'
import { swiftColorLiterals } from '../scripts/lib/lang-swift.mjs'
import { kotlinColorLiterals } from '../scripts/lib/lang-kotlin.mjs'
import { readAndroidValues } from '../scripts/lib/readers-mobile.mjs'
import { CATALOG, COMPOSE_OUT, detect, run, EXTRA, OWNED, colorset, entry, px, SWIFT_OUT, XCASSETS_OUT, XML_OUT, extracted, put, read, readConfig, repo, scratch, srgb, tok, tokensMode, tokensRun, writeConfig } from './mobile-helpers.mjs'

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
  // On a disk that ignores case the new spelling is the edited file, so the
  // build refuses it; on one that keeps case it is a new file, and the edited
  // one is left as it is.
  const ignoresCase = existsSync(join(b, 'ios/App/Designtokens.swift'))
  assert.equal(tokensRun(b, ['build']).status, ignoresCase ? 1 : 0)
  assert.match(readFileSync(join(b, 'ios/App', readdirSync(join(b, 'ios/App')).sort()[0]), 'utf8'), /our tweak, keep/)
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
  // A key inside the repo as written, through a symlink that leads out.
  const through = repo({ config: tokensMode([XML_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  mkdirSync(join(through, '..', 'shared'))
  writeFileSync(join(through, '..', 'shared', 'keep.txt'), 'not massimo\'s\n')
  symlinkSync(join(through, '..', 'shared'), join(through, 'link'))
  put(through, { 'ds/tokens/mobile-outputs.json': { format: 1, writtenBy: '0.6.0', files: { 'link/keep.txt': hash } } })
  assert.equal(tokensRun(through, ['build', '--prune']).status, 0)
  assert.ok(existsSync(join(through, '..', 'shared', 'keep.txt')))
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

// ── The Swift output ────────────────────────────────────────────────────────

// Colours built from components (no catalog), with and without a dark value, one out of sRGB.
const TRAIT_SET = [
  tok(['color', 'surface'], 'color', srgb('#ffffff'), { modes: { dark: srgb('#1c1c1e') } }),
  tok(['color', 'ink'], 'color', srgb('#111111')),
  tok(['color', 'vivid'], 'color', { colorSpace: 'oklch', components: [0.7, 0.3, 30] }, { modes: { dark: srgb('#000000') } }),
  tok(['color', 'wide'], 'color', { colorSpace: 'display-p3', components: [1, 0.2, 0.1] }, { modes: { dark: { colorSpace: 'display-p3', components: [0.9, 0.1, 0.1] } } }),
  tok(['text', 'title'], 'typography', { fontFamily: 'Inter', fontSize: px(22), fontWeight: 600, lineHeight: 1.2, letterSpacing: px(0) }),
  tok(['text', 'note'], 'typography', { fontFamily: 'ui-rounded', fontSize: px(11), fontWeight: 400, lineHeight: 1.2, letterSpacing: px(0) }),
]
const traitBuild = () => {
  const root = repo({ config: tokensMode([SWIFT_OUT], { uikit: true, textStyles: { 'text.title': 'title2', 'text.note': 'caption2' } }), tokens: TRAIT_SET })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  return { root, r, swift: read(root, SWIFT_OUT.path) }
}

// R2 R3 P7
test('Swift colours built from components use only what iOS 13 and macOS 10.15 have, keep extended sRGB on macOS, and compile on watchOS', () => {
  const { swift, r } = traitBuild()
  assert.doesNotMatch(swift, /Color\(uiColor:|Color\(nsColor:|NSColor\(srgbRed:/)
  assert.match(swift, /#if canImport\(UIKit\) && !os\(watchOS\)\n {8}static let surface = Color\(UIColor \{ \$0\.userInterfaceStyle == \.dark \?/)
  assert.match(swift, /#elseif canImport\(AppKit\)\n {8}static let vivid = Color\(NSColor\(name: nil\) \{ \$0\.bestMatch\(from: \[\.aqua, \.darkAqua\]\) == \.darkAqua \? NSColor\(red: 0, green: 0, blue: 0, alpha: 1\) : NSColor\(red: 1\.172538, green: -0\.139477, blue: -0\.128339, alpha: 1\) \}\)/)
  // A colour with no dark value is the same on every platform.
  assert.match(swift, /\n {8}static let ink = Color\(\.sRGB, red: 0\.0667, green: 0\.0667, blue: 0\.0667, opacity: 1\)\n/)
  // The UIKit twins need what watchOS lacks, so they are left out there.
  assert.match(swift, /#if canImport\(UIKit\) && !os\(watchOS\)\n {4}enum UIColors/)
  // Text styles iOS 13 lacks, and Font.custom(relativeTo:), fall back where they are missing.
  assert.match(swift, /if #available\(iOS 14\.0, macOS 11\.0, tvOS 14\.0, watchOS 7\.0, \*\)/)
  assert.match(r.stdout, /on watchOS, which has no light and dark appearance, colours built from their components take their light value/)
})

// R2 R3 P7, compiled: only where Xcode is installed.
const xcrun = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).status === 0
test('the Swift output type-checks for iOS 13 and 17, macOS 10.15 and 12, and watchOS', { skip: !xcrun && 'needs Xcode' }, () => {
  const { root } = traitBuild()
  const file = join(root, SWIFT_OUT.path)
  for (const [sdk, target] of [['iphonesimulator', 'arm64-apple-ios13.0-simulator'], ['iphonesimulator', 'arm64-apple-ios17.0-simulator'], ['macosx', 'x86_64-apple-macos10.15'], ['macosx', 'arm64-apple-macos12.0'], ['watchsimulator', 'arm64-apple-watchos7.0-simulator']]) {
    const sdkPath = spawnSync('xcrun', ['--sdk', sdk, '--show-sdk-path'], { encoding: 'utf8' })
    if (sdkPath.status !== 0) continue
    const c = spawnSync('xcrun', ['--sdk', sdk, 'swiftc', '-typecheck', '-target', target, '-swift-version', '5', file], { encoding: 'utf8', cwd: tmpdir() })
    assert.equal(c.status, 0, `${target}: ${c.stderr}`)
  }
})

// P6
test('a description with a lone carriage return stays inside its Swift doc comment', () => {
  const root = repo({ config: tokensMode([SWIFT_OUT]), tokens: [tok(['spacing', 'gutter'], 'dimension', px(16), { description: 'line one\rline two' }), tok(['spacing', 'gap'], 'dimension', px(8), { description: 'cr\r/*x' })] })
  assert.equal(tokensRun(root, ['build']).status, 0)
  const swift = read(root, SWIFT_OUT.path)
  assert.doesNotMatch(swift, /\r/)
  assert.match(swift, /\/\/\/ line one\n {8}\/\/\/ line two\n/)
  assert.match(swift, /\/\/\/ cr\n {8}\/\/\/ \/\*x\n/)
})

// R8
test('a font family named like a property of every object (constructor, __proto__) is a family to bundle, not a system design', () => {
  const root = repo({ config: tokensMode([SWIFT_OUT, COMPOSE_OUT], { textStyles: { 'text.body': 'body' } }), tokens: [tok(['font', 'family', 'odd'], 'fontFamily', ['constructor', 'sans-serif']), tok(['text', 'body'], 'typography', { fontFamily: '__proto__', fontSize: px(14), fontWeight: 400, lineHeight: 1.4, letterSpacing: px(0) })] })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(read(root, SWIFT_OUT.path), /static let familyOdd: String = "constructor"/)
  assert.match(read(root, SWIFT_OUT.path), /Font\.custom\("__proto__", size: 14/)
  assert.match(read(root, COMPOSE_OUT.path), /familyOdd: String = "constructor"/)
})

// L10
test('ui-rounded and cursive say what each platform writes for them, with nothing to bundle', () => {
  const root = repo({ config: tokensMode([SWIFT_OUT, COMPOSE_OUT], { textStyles: { 'text.fancy': 'body' } }), tokens: [tok(['font', 'family', 'round'], 'fontFamily', ['ui-rounded', 'sans-serif']), tok(['font', 'family', 'script'], 'fontFamily', ['cursive']), tok(['text', 'fancy'], 'typography', { fontFamily: 'cursive', fontSize: px(14), fontWeight: 400, lineHeight: 1.4, letterSpacing: px(0) })] })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /font\.family\.round: Android has no rounded system font, so ui-rounded is written as default/)
  assert.match(r.stdout, /font\.family\.script: iOS has no cursive system font, so cursive is the system font there/)
  assert.doesNotMatch(r.stdout, /cursive must be (bundled|added)/)
  const kt = read(root, COMPOSE_OUT.path)
  assert.match(kt, /familyScript: String = "cursive"/)
  assert.match(kt, /fancy: TextStyle = TextStyle\(fontFamily = FontFamily\.Cursive/)
  assert.match(read(root, SWIFT_OUT.path), /static let fancy = DesignTokensTextStyle\(font: Font\.system\(\.body\)/)
})

// I6
test('an alias of a colour with high-contrast entries keeps them: it reads that colour\'s set, or is left out and listed', () => {
  const alias = (root) => {
    const file = join(root, 'ds/tokens/base.tokens.json')
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    doc.bg = { $type: 'color', surface: { $value: '{color.Surface}' } }
    writeFileSync(file, JSON.stringify(doc, null, 2))
  }
  const swiftOnly = extracted({ colors: 'tokens', outputs: [{ format: 'swift', path: 'Sources/DesignSystem/DesignTokens.swift' }] }).root
  alias(swiftOnly)
  const a = tokensRun(swiftOnly, ['build'])
  assert.equal(a.status, 0, a.stderr)
  assert.match(read(swiftOnly, 'Sources/DesignSystem/DesignTokens.swift'), /public static let bgSurface = Color\("Surface", bundle: \.module\)/)
  const both = extracted({ colors: 'tokens', outputs: [{ format: 'xcassets', path: OWNED }, { format: 'swift', path: 'Sources/DesignSystem/DesignTokens.swift' }] }).root
  alias(both)
  const b = tokensRun(both, ['build'])
  assert.equal(b.status, 0, b.stderr)
  assert.ok(!existsSync(join(both, OWNED, 'Bg/Surface.colorset')))
  assert.match(b.stdout, /not carried over to Sources\/DesignSystem\/Resources\/MassimoTokens\.xcassets: bg\.surface points at color\.Surface, which has high-contrast entries/)
  assert.match(read(both, 'Sources/DesignSystem/DesignTokens.swift'), /public static let bgSurface = Color\("Surface", bundle: \.module\)/)
})

// T6
test('tokens mode with no catalog holding a high-contrast colour leaves it out and lists it, never building it without those entries', () => {
  const { root } = extracted({ colors: 'tokens', outputs: [{ format: 'swift', path: 'Sources/DesignSystem/DesignTokens.swift' }] })
  const config = readConfig(root)
  config.tokens.mobileSources = [{ kind: 'xcassets', path: EXTRA }]
  writeConfig(root, config)
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /not carried over to Sources\/DesignSystem\/DesignTokens\.swift: color\.Surface has high-contrast entries, which massimo does not model yet, and no catalog this build reads holds it; it is left out rather than built without them/)
  assert.doesNotMatch(read(root, 'Sources/DesignSystem/DesignTokens.swift'), /static let surface/)
})

// ── The bundle a colour is read from ────────────────────────────────────────

const ink = colorset([entry('#112233')])
const PBX = `// !$*UTF8*$!
{
	objects = {
		AA01 /* App */ = {
			isa = PBXFileSystemSynchronizedRootGroup;
			path = App;
			sourceTree = "<group>";
		};
		AA02 /* DesignSystem */ = {
			isa = PBXFileSystemSynchronizedRootGroup;
			path = DesignSystem;
			sourceTree = "<group>";
		};
		BB01 /* App */ = {
			isa = PBXNativeTarget;
			fileSystemSynchronizedGroups = (
				AA01 /* App */,
			);
			name = App;
			productType = "com.apple.product-type.application";
		};
		BB02 /* DesignSystem */ = {
			isa = PBXNativeTarget;
			fileSystemSynchronizedGroups = (
				AA02 /* DesignSystem */,
			);
			name = DesignSystem;
			productType = "com.apple.product-type.framework";
		};
	};
}
`
const XCODEGEN = 'name: App\noptions:\n  bundleIdPrefix: com.example\ntargets:\n  App:\n    type: application\n    platform: iOS\n    sources: [App]\n  DesignSystem:\n    type: framework\n    platform: iOS\n    sources:\n      - path: DesignSystem\n'
const TUIST_APP = 'import ProjectDescription\n\nlet project = Project(name: "App", targets: [\n    .target(name: "App", destinations: .iOS, product: .app, bundleId: "com.example.app", sources: ["Sources/**"], resources: ["Resources/**"]),\n])\n'
const TUIST_DS = 'import ProjectDescription\n\nlet project = Project(name: "DesignSystem", targets: [\n    .target(name: "DesignSystem", destinations: .iOS, product: .framework, bundleId: "com.example.ds", sources: ["Sources/**"], resources: ["Resources/**"]),\n])\n'
const twoTargets = (layout) => {
  const [app, ds, files] = {
    xcodeproj: ['App', 'DesignSystem', { 'App.xcodeproj/project.pbxproj': PBX }],
    xcodegen: ['App', 'DesignSystem', { 'project.yml': XCODEGEN }],
    tuist: ['Projects/App/Resources', 'Projects/DesignSystem/Resources', { 'Workspace.swift': 'import ProjectDescription\nlet workspace = Workspace(name: "App", projects: ["Projects/*"])\n', 'Projects/App/Project.swift': TUIST_APP, 'Projects/DesignSystem/Project.swift': TUIST_DS }],
  }[layout]
  const out = layout === 'tuist' ? 'Projects/DesignSystem/Sources/DesignTokens.swift' : 'DesignSystem/DesignTokens.swift'
  const root = repo({
    files: { ...files, [`${app}/Assets.xcassets/Contents.json`]: { info: { author: 'xcode', version: 1 } }, [`${app}/Assets.xcassets/AppTint.colorset/Contents.json`]: ink, [`${ds}/Colors.xcassets/Contents.json`]: { info: { author: 'xcode', version: 1 } }, [`${ds}/Colors.xcassets/Brand.colorset/Contents.json`]: ink },
    config: { platforms: { ios: {} }, tokens: { source: 'ds/tokens/tokens.resolver.json', outputs: [{ format: 'swift', path: out }], mobile: { colors: 'catalog' }, mobileSources: [{ kind: 'xcassets', path: `${ds}/Colors.xcassets` }, { kind: 'xcassets', path: `${app}/Assets.xcassets` }] } },
    tokens: [tok(['color', 'AppTint'], 'color', srgb('#112233'), { mobile: { asset: 'AppTint' } }), tok(['color', 'Brand'], 'color', srgb('#112233'), { mobile: { asset: 'Brand' } })],
  })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  return { r, swift: read(root, out), out, app }
}

// I1
test('a Swift file in one Xcode, XcodeGen or Tuist target never reads a colour from another target\'s catalog', () => {
  for (const [layout, label] of [['xcodeproj', 'the Xcode target DesignSystem'], ['xcodegen', 'the XcodeGen target DesignSystem'], ['tuist', 'the Tuist target DesignSystem']]) {
    const { r, swift, out, app } = twoTargets(layout)
    assert.doesNotMatch(swift, /appTint/, layout)
    assert.match(swift, /static let brand = Color\("Brand", bundle: designTokensBundle\)/, layout)
    assert.ok(r.stdout.includes(`not carried over to ${out}: color.AppTint is in ${app}/Assets.xcassets, which is not in the bundle this file reads (${label})`), `${layout}: ${r.stdout}`)
  }
})

// I2
test('--dedupe never removes a colour set from a catalog that compiles into another bundle than the owned one', () => {
  const { root } = extracted({ colors: 'tokens', outputs: [{ format: 'xcassets', path: 'App/MassimoTokens.xcassets' }, { format: 'swift', path: 'Sources/DesignSystem/DesignTokens.swift' }] })
  const b = tokensRun(root, ['build'])
  assert.equal(b.status, 0, b.stderr)
  assert.doesNotMatch(b.stdout, /duplicates:/)
  const d = tokensRun(root, ['build', '--dedupe'])
  assert.equal(d.status, 0, d.stderr)
  assert.doesNotMatch(d.stdout, /removed \d+ colour set/)
  assert.ok(existsSync(join(root, CATALOG, 'Brand/Primary.colorset/Contents.json')))
  // The other way round: the owned catalog in the package, the app's catalog with the same names.
  const app = extracted({ colors: 'tokens', outputs: [{ format: 'xcassets', path: OWNED }], files: { 'App/Assets.xcassets/Contents.json': { info: { author: 'xcode', version: 1 } }, 'App/Assets.xcassets/Ink.colorset/Contents.json': ink }, sources: [{ kind: 'xcassets', path: EXTRA }, { kind: 'xcassets', path: 'App/Assets.xcassets' }] }).root
  const config = readConfig(app)
  config.tokens.mobileSources = [{ kind: 'xcassets', path: 'App/Assets.xcassets' }]
  writeConfig(app, config)
  assert.equal(tokensRun(app, ['build', '--dedupe']).status, 0)
  assert.ok(existsSync(join(app, 'App/Assets.xcassets/Ink.colorset/Contents.json')))
})

// R6
test('a colour set name in two catalogs is read from the one in this file\'s bundle, whatever order mobileSources lists them in', () => {
  const brand = readFileSync(join('test/fixtures/ios-spm', CATALOG, 'Brand/Primary.colorset/Contents.json'), 'utf8')
  for (const appFirst of [true, false]) {
    const sources = [{ kind: 'xcassets', path: 'MyApp/Assets.xcassets' }, { kind: 'xcassets', path: CATALOG }]
    const { root } = extracted({ colors: 'catalog', outputs: [{ format: 'swift', path: 'Sources/DesignSystem/DesignTokens.swift' }], files: { 'MyApp/Assets.xcassets/Contents.json': { info: { author: 'xcode', version: 1 } }, 'MyApp/Assets.xcassets/Brand/Contents.json': { info: { author: 'xcode', version: 1 }, properties: { 'provides-namespace': true } }, 'MyApp/Assets.xcassets/Brand/Primary.colorset/Contents.json': brand }, sources: appFirst ? sources : [...sources].reverse() })
    const r = tokensRun(root, ['build'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(read(root, 'Sources/DesignSystem/DesignTokens.swift'), /public static let brandPrimary = Color\("Brand\/Primary", bundle: \.module\)/, `app first: ${appFirst}`)
  }
})

// L18
test('a package target named through a constant is a package target: public, and read from .module', () => {
  const root = repo({
    files: { 'Package.swift': '// swift-tools-version: 5.9\nimport PackageDescription\n\nlet ds = "DesignSystem"\nlet package = Package(\n    name: "Acme",\n    products: [.library(name: ds, targets: [ds])],\n    targets: [.target(name: ds, resources: [.process("Colors.xcassets")])]\n)\n', 'Sources/DesignSystem/Colors.xcassets/Contents.json': { info: { author: 'xcode', version: 1 } }, 'Sources/DesignSystem/Colors.xcassets/Brand.colorset/Contents.json': ink },
    config: { platforms: { ios: {} }, tokens: { source: 'ds/tokens/tokens.resolver.json', outputs: [{ format: 'swift', path: 'Sources/DesignSystem/DesignTokens.swift' }], mobile: { colors: 'catalog' }, mobileSources: [{ kind: 'xcassets', path: 'Sources/DesignSystem/Colors.xcassets' }] } },
    tokens: [tok(['color', 'Brand'], 'color', srgb('#112233'), { mobile: { asset: 'Brand' } })],
  })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  const swift = read(root, 'Sources/DesignSystem/DesignTokens.swift')
  assert.match(swift, /public enum DesignTokens/)
  assert.match(swift, /public static let brand = Color\("Brand", bundle: \.module\)/)
  assert.match(r.stdout, /wired: Sources\/DesignSystem\/DesignTokens\.swift sits in the Swift package target DesignSystem/)
})

// T7
test('tokens mode leaves out and lists a colour whose owned catalog compiles into another bundle than the Swift file', () => {
  const { root } = extracted({ colors: 'tokens', outputs: [{ format: 'xcassets', path: OWNED }, { format: 'swift', path: 'App/DesignTokens.swift' }] })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /not carried over to App\/DesignTokens\.swift: color\.Accent is in Sources\/DesignSystem\/Resources\/MassimoTokens\.xcassets, which is not in the bundle this file reads/)
  assert.doesNotMatch(read(root, 'App/DesignTokens.swift'), /Color\("Accent"/)
})

// ── Colour sets --dedupe must keep ──────────────────────────────────────────

const draftColor = (root, name) => {
  const doc = JSON.parse(read(root, 'ds/tokens/base.tokens.json'))
  return name.split('.').reduce((at, k) => at?.[k], doc)
}
// Extracted in tokens mode with the owned catalog in the package, built with --dedupe.
const dedupe = (files, edit = null) => {
  const { root, extract } = extracted({ colors: 'tokens', outputs: [{ format: 'xcassets', path: OWNED }], files })
  if (edit) edit(root)
  const r = tokensRun(root, ['build', '--dedupe'])
  assert.equal(r.status, 0, r.stderr)
  return { root, r, extract }
}

// I3
test('a colour set with a localized entry, or two entries for one appearance, is never deduped, and its base entry is the value', () => {
  const loc = (first) => colorset(first ? [entry('#FF0000'), { ...entry('#00FF00'), locale: 'fr' }] : [{ ...entry('#00FF00'), locale: 'fr' }, entry('#FF0000')])
  const { root, r } = dedupe({ [`${CATALOG}/Loc.colorset/Contents.json`]: loc(true), [`${CATALOG}/LocFirst.colorset/Contents.json`]: loc(false), [`${CATALOG}/Twice.colorset/Contents.json`]: colorset([entry('#FF0000'), entry('#0000FF')]) })
  for (const name of ['Loc', 'LocFirst', 'Twice']) {
    assert.ok(existsSync(join(root, CATALOG, `${name}.colorset/Contents.json`)), name)
    assert.ok(!existsSync(join(root, OWNED, `${name}.colorset`)), name)
  }
  assert.match(r.stdout, /color\.Loc has entries massimo does not model yet \(an entry for the locale fr\)/)
  assert.match(r.stdout, /color\.Twice has entries massimo does not model yet \(two entries for the any appearance\)/)
  assert.equal(draftColor(root, 'color.Loc').$value.hex, '#ff0000')
  assert.equal(draftColor(root, 'color.LocFirst').$value.hex, '#ff0000')
})

// I4
test('a colour set whose Contents.json cannot be read is never deduped, and the build says why', () => {
  const conflict = '{\n  "colors" : [\n<<<<<<< HEAD\n    { "color" : { "color-space" : "display-p3", "components" : { "alpha" : "1.000", "blue" : "0x33", "green" : "0x22", "red" : "0x11" } }, "idiom" : "universal" }\n=======\n    { "color" : { "color-space" : "srgb", "components" : { "alpha" : "1.000", "blue" : "0x33", "green" : "0x22", "red" : "0x11" } }, "idiom" : "universal" }\n>>>>>>> theirs\n  ]\n}\n'
  const { root, r } = dedupe({}, (at) => writeFileSync(join(at, EXTRA, 'Ink.colorset/Contents.json'), conflict))
  assert.equal(readFileSync(join(root, EXTRA, 'Ink.colorset/Contents.json'), 'utf8'), conflict)
  assert.match(r.stdout, /color\.Ink has entries massimo does not model yet \(a Contents\.json massimo cannot read\)/)
})

// L5
test('a colour set with only Display P3 entries is read from them, and never called empty', () => {
  const p3 = (idiom) => entry('#FF2010', { gamut: 'display-P3', idiom })
  const { root, extract } = dedupe({ [`${CATALOG}/IphoneP3Only.colorset/Contents.json`]: colorset([p3('iphone'), entry('#FF2010', { gamut: 'sRGB', idiom: 'ipad' })]), [`${CATALOG}/UniversalP3Only.colorset/Contents.json`]: colorset([p3('universal')]) })
  for (const name of ['IphoneP3Only', 'UniversalP3Only']) {
    assert.doesNotMatch(extract.stdout + read(root, 'ds/tokens/draft/report.md'), new RegExp(`${name}\\.colorset: holds no colour`))
    assert.doesNotMatch(read(root, 'ds/tokens/draft/report.md'), new RegExp(`${name}\\.colorset: has display-P3 gamut entries, which are not read; the sRGB ones are`))
    assert.equal(draftColor(root, `color.${name}`).$value.colorSpace, 'display-p3', name)
    assert.ok(existsSync(join(root, CATALOG, `${name}.colorset/Contents.json`)), name)
  }
})

// T5
test('every variant check keeps a team colour set from --dedupe: any differing from light, an unknown appearance, an unreadable entry, and variants the token records', () => {
  const sets = {
    [`${EXTRA}/Ink.colorset/Contents.json`]: colorset([entry('#112233'), { ...entry('#445566'), appearances: [{ appearance: 'luminosity', value: 'light' }] }, entry('#EEF0F5', { appearance: 'dark' })]),
    [`${CATALOG}/Dim.colorset/Contents.json`]: colorset([entry('#123456'), { ...entry('#654321'), appearances: [{ appearance: 'luminosity', value: 'dim' }] }]),
    [`${CATALOG}/Sys.colorset/Contents.json`]: colorset([entry('#123456'), { appearances: [{ appearance: 'luminosity', value: 'dark' }], color: { platform: 'ios', reference: 'systemBlueColor' }, idiom: 'universal' }]),
  }
  const { root, r } = dedupe(sets)
  for (const [name, why] of [['Ink', 'an any-appearance entry that differs from the light one'], ['Dim', 'an entry for the appearance'], ['Sys', 'a dark entry it cannot read']]) {
    assert.ok(r.stdout.includes(`color.${name} has entries massimo does not model yet (${why}`), `${name}: ${r.stdout}`)
    assert.ok(Object.keys(sets).some((p) => p.includes(`${name}.colorset`) && existsSync(join(root, p))), name)
  }
  // A token that records variants, with no app catalog holding its set.
  const lone = repo({ config: tokensMode([XCASSETS_OUT]), tokens: [tok(['color', 'ink'], 'color', srgb('#112233'), { mobile: { asset: 'Ink', variants: ['display-P3 gamut'] } })] })
  const l = tokensRun(lone, ['build'])
  assert.equal(l.status, 0, l.stderr)
  assert.match(l.stdout, /color\.ink has entries massimo does not model yet \(display-P3 gamut\)/)
  assert.ok(!existsSync(join(lone, XCASSETS_OUT.path, 'Ink.colorset')))
})

// ── What detect proposes for iOS ────────────────────────────────────────────

const VIEW = 'import SwiftUI\n\nstruct Card: View {\n    var body: some View { Text("Hi") }\n}\n'
const PBX_ONE = (name) => `// !$*UTF8*$!\n{\n\tobjects = {\n\t\tA1 /* ${name} */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tname = ${name};\n\t\t};\n\t};\n}\n`
const iosOf = (files) => detect(put(join(scratch(), 'repo'), files)).platforms?.find((p) => p.id === 'ios') ?? null
const WEB = { 'package.json': { name: 'site', dependencies: { next: '15.0.0', react: '19.0.0' } }, 'app/page.tsx': 'export default function Page() { return null }\n' }

// R4
test('detect finds every real iOS app: past a UI-less package that sorts first, Swift 6 and attribute imports, AppKit, Objective-C, XcodeGen includes, and UI past the sample', () => {
  const server = { 'api/Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "Api", targets: [.executableTarget(name: "App", dependencies: [])])\n', 'api/Sources/App/main.swift': 'import Vapor\n\nlet app = Application()\n' }
  const app = { 'ios/Acme.xcodeproj/project.pbxproj': PBX_ONE('Acme'), 'ios/Acme/ContentView.swift': VIEW }
  assert.equal(iosOf({ ...WEB, ...server, ...app })?.root, 'ios')
  for (const line of ['public import SwiftUI', 'package import SwiftUI', 'internal import UIKit', '@preconcurrency import UIKit', '@_exported import SwiftUI', 'import struct SwiftUI.Color', 'import AppKit']) {
    assert.ok(iosOf({ 'Acme.xcodeproj/project.pbxproj': PBX_ONE('Acme'), 'Acme/View.swift': `${line}\n\nlet x = 1\n` }), line)
  }
  const objc = iosOf({ 'Acme.xcodeproj/project.pbxproj': PBX_ONE('Acme'), 'Acme/AppDelegate.m': '#import <UIKit/UIKit.h>\n@implementation AppDelegate\n@end\n', 'Acme/Base.lproj/Main.storyboard': '<document/>\n', 'Acme/Assets.xcassets/Contents.json': { info: { author: 'xcode', version: 1 } }, 'Acme/Assets.xcassets/Ink.colorset/Contents.json': colorset([entry('#112233')]) })
  assert.ok(objc, 'an Objective-C UIKit app')
  assert.deepEqual(objc.ui, ['uikit'])
  const included = iosOf({ 'project.yml': 'name: Acme\ninclude:\n  - targets.yml\n', 'targets.yml': 'targets:\n  Acme:\n    type: application\n    supportedDestinations: [iOS]\n    sources: [Acme]\n', 'Acme/View.swift': VIEW })
  assert.equal(included?.project.kind, 'xcodegen')
  const block = iosOf({ 'project.yml': 'name: Acme\ntargets:\n  Acme:\n    type: application\n    platform:\n      - iOS\n    sources: [Acme]\n', 'Acme/View.swift': VIEW })
  assert.equal(block?.project.kind, 'xcodegen')
  const many = { 'Acme.xcodeproj/project.pbxproj': PBX_ONE('Acme') }
  for (let i = 0; i < 605; i++) many[`Acme/Model${String(i).padStart(3, '0')}.swift`] = `struct Model${i} {}\n`
  many['Acme/ZView.swift'] = VIEW
  assert.ok(iosOf(many), 'UI past the first 600 files')
})

// T3
test('a project.yml that is not an XcodeGen spec beside a real iOS app never becomes its project', () => {
  const deploy = { 'project.yml': 'name: deploy\nservices: [api]\ntargets:\n  api: {}\n' }
  const atRoot = iosOf({ ...deploy, 'Acme.xcodeproj/project.pbxproj': PBX_ONE('Acme'), 'Acme/View.swift': VIEW })
  assert.deepEqual(atRoot.project, { kind: 'xcodeproj', path: 'Acme.xcodeproj' })
  const below = iosOf({ ...deploy, 'ios/Acme.xcodeproj/project.pbxproj': PBX_ONE('Acme'), 'ios/Acme/View.swift': VIEW })
  assert.equal(below.root, 'ios')
  assert.deepEqual(below.project, { kind: 'xcodeproj', path: 'ios/Acme.xcodeproj' })
})

// I7
test('the wire step reads the project whose folder holds the output, whatever project the config names', () => {
  const synced = (name) => `// !$*UTF8*$!\n{\n\tobjects = {\n\t\tB1 /* ${name} */ = {\n\t\t\tisa = PBXFileSystemSynchronizedRootGroup;\n\t\t\tpath = ${name};\n\t\t};\n\t\tA1 /* ${name} */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tfileSystemSynchronizedGroups = (\n\t\t\t\tB1 /* ${name} */,\n\t\t\t);\n\t\t};\n\t};\n}\n`
  const text = { 'Demo.xcodeproj/project.pbxproj': synced('Demo'), 'Store.xcodeproj/project.pbxproj': synced('Store') }
  const files = [...Object.keys(text), 'Demo/App.swift', 'Store/App.swift', 'App.xcworkspace/contents.xcworkspacedata']
  for (const block of [{ root: '.', project: { kind: 'xcodeproj', path: 'Demo.xcodeproj' } }, { root: './', project: { kind: 'xcodeproj', path: 'Demo.xcodeproj' } }, { root: '.', project: { kind: 'xcworkspace', path: 'App.xcworkspace' } }]) {
    const w = iosWire('Store/DesignTokens.swift', files, (f) => text[f] ?? null, block)
    assert.equal(w.needed, false, `${JSON.stringify(block)}: ${w.step}`)
    assert.match(w.step, /sits in Store, a folder Xcode keeps in sync/)
  }
  // detect names the project that holds the app's catalog.
  const d = iosOf({ ...text, 'Demo/App.swift': VIEW, 'Store/App.swift': VIEW, 'Store/Assets.xcassets/Contents.json': { info: { author: 'xcode', version: 1 } }, 'Store/Assets.xcassets/Ink.colorset/Contents.json': colorset([entry('#112233')]) })
  assert.deepEqual(d.project, { kind: 'xcodeproj', path: 'Store.xcodeproj' })
})

// L13
test('detect proposes a design-system target from an older Xcode project, any project.yml shape, and the project it names', () => {
  const classic = '// !$*UTF8*$!\n{\n\tobjects = {\n\t\tG1 /* DesignSystem */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t);\n\t\t\tpath = DesignSystem;\n\t\t\tsourceTree = "<group>";\n\t\t};\n\t\tA1 /* Acme */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tname = Acme;\n\t\t};\n\t\tA2 /* DesignSystem */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tname = DesignSystem;\n\t\t};\n\t};\n}\n'
  assert.equal(iosOf({ 'Acme.xcodeproj/project.pbxproj': classic, 'Acme/App.swift': VIEW, 'DesignSystem/Card.swift': VIEW }).designSystem?.path, 'DesignSystem')
  // The proposed project, not the first .xcodeproj under the root.
  assert.equal(iosOf({ 'Acme.xcodeproj/project.pbxproj': classic, 'Aaa/Aaa.xcodeproj/project.pbxproj': PBX_ONE('Aaa'), 'Acme/App.swift': VIEW, 'DesignSystem/Card.swift': VIEW }).designSystem?.path, 'DesignSystem')
  const shapes = [
    'name: Acme # the app\ntargets:\n    App:\n        type: application\n        platform: iOS\n        sources: [App]\n    DesignSystem:\n        type: framework\n        platform: iOS\n        sources: [DesignSystem] # shared\n',
    'name: Acme\ntargets:\n  App:\n    platform: iOS\n    sources: [App]\n  DesignSystem:\n    platform: iOS\n    sources:\n      # the views\n      - {path: DesignSystem, name: Views}\n',
    'name: Acme\ntargets:\n  App:\n    platform: iOS\n    sources: [App]\n  DesignSystem:\n    platform: iOS\n    sources:\n      - name: Views\n        path: ./Kit/../DesignSystem\n',
  ]
  for (const yml of shapes) {
    const ios = iosOf({ 'project.yml': yml, 'App/App.swift': VIEW, 'DesignSystem/Card.swift': VIEW })
    assert.equal(ios.designSystem?.path, 'DesignSystem', yml)
  }
})

// L14
test('a catalog deep in Resources gets its Swift beside the sources, a Workspace.swift in the app is no Tuist manifest, and Tuist helpers are not app code', () => {
  const nested = iosOf({ 'project.yml': 'name: Acme\ntargets:\n  App:\n    platform: iOS\n    sources: [App]\n', 'App/Sources/View.swift': VIEW, 'App/Resources/Assets/Colors.xcassets/Contents.json': { info: { author: 'xcode', version: 1 } }, 'App/Resources/Assets/Colors.xcassets/Ink.colorset/Contents.json': colorset([entry('#112233')]) })
  assert.deepEqual(nested.suggestedOutputs.map((o) => o.path), ['App/Sources/DesignTokens.swift'])
  const plain = iosOf({ 'Acme.xcodeproj/project.pbxproj': PBX_ONE('Acme'), 'Acme/View.swift': VIEW, 'Acme/Workspace.swift': 'struct Workspace {}\n' })
  assert.deepEqual(plain.project, { kind: 'xcodeproj', path: 'Acme.xcodeproj' })
  const tuist = iosOf({ 'Project.swift': 'import ProjectDescription\nlet project = Project(name: "Acme")\n', 'Tuist.swift': 'import ProjectDescription\nlet tuist = Tuist()\n', 'Tuist/ProjectDescriptionHelpers/Project+Templates.swift': 'import ProjectDescription\nextension Project {}\n', 'Sources/View.swift': VIEW })
  assert.equal(tuist.swiftFiles, 1)
})

// R5
test('the colour counts keep hard-coded components wrapped in a conversion or parentheses', () => {
  const swift = 'let a = UIColor(red: CGFloat(18) / 255.0, green: CGFloat(52) / 255.0, blue: CGFloat(86) / 255.0, alpha: 1)\nlet b = Color(red: Double(0x12) / 255, green: Double(0x34) / 255, blue: Double(0x56) / 255)\nlet c = UIColor(red: (250.0 / 255.0), green: 0.5, blue: 0.5, alpha: 1)\nlet d = Color(red: r, green: g, blue: b)\nlet e = UIColor(red: CGFloat(r) / 255, green: 0, blue: 0, alpha: 1)\n'
  assert.deepEqual(swiftColorLiterals(swift).map((f) => f.line), [1, 2, 3])
  const kotlin = 'val a = Color.rgb((0.1f * 255).toInt(), 0, 0)\nval b = Color(18 / 255f, 52 / 255f, 86 / 255f)\nval c = Color.rgb(r, g, b)\n'
  assert.deepEqual(kotlinColorLiterals(kotlin).map((f) => f.line), [1, 2])
})

// ── The Android outputs and readers ─────────────────────────────────────────

const androidBuild = (tokens, outputs = [COMPOSE_OUT, XML_OUT], extra = {}) => {
  const root = repo({ config: tokensMode(outputs, extra), tokens })
  const r = tokensRun(root, ['build'])
  return { root, r }
}
// The light colour, in the colours class of either shape (an object's override, or a constructor argument).
const composeColor = (kt, name) => new RegExp(String.raw`(?:override val ${name}: Color = | ${name} = )(Color\([^\n]*\))`).exec(kt)?.[1] ?? null
const floats = (text) => [...text.matchAll(/(?:red|green|blue) = (-?[\d.]+)f/g)].map((m) => Number(m[1]))

// L1
test('Compose never writes a colour component outside 0..1: a colour just past the sRGB edge, and a Display P3 one', () => {
  const { root, r } = androidBuild([
    tok(['color', 'orange', '200'], 'color', { colorSpace: 'oklch', components: [0.901, 0.076, 70.697] }),
    tok(['color', 'indigo', '50'], 'color', { colorSpace: 'oklch', components: [0.962, 0.018, 272.314] }),
    tok(['color', 'wide'], 'color', { colorSpace: 'display-p3', components: [1.2, -0.1, 0.5] }),
  ], [COMPOSE_OUT])
  assert.equal(r.status, 0, r.stderr)
  const kt = read(root, COMPOSE_OUT.path)
  for (const name of ['orange200', 'indigo50', 'wide']) {
    const c = composeColor(kt, name)
    assert.ok(c, name)
    assert.ok(floats(c).every((n) => n >= 0 && n <= 1), `${name}: ${c}`)
  }
  assert.match(r.stdout, /color\.wide: Compose colours hold 0 to 1, so its Display P3 value was clipped/)
})

// L2
test('android-xml says when a dark value was converted or clipped, as it does for the day value', () => {
  const { r } = androidBuild([
    tok(['color', 'night'], 'color', srgb('#336699'), { modes: { dark: { colorSpace: 'oklch', components: [0.7, 0.3, 30] } } }),
    tok(['color', 'ext'], 'color', { colorSpace: 'srgb', components: [1.1, -0.05, 0.2] }),
  ], [XML_OUT])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /note: color\.night: Android colour resources are sRGB, so its dark oklch value was converted and clipped/)
  assert.match(r.stdout, /note: color\.ext: Android colour resources are sRGB, so its extended sRGB value was clipped/)
  assert.doesNotMatch(r.stdout, /its {2}value/)
})

// L3
test('a lab, lch, hsl or hwb colour is converted from its components, kept or clipped as any other, with or without a hex', () => {
  const { root, r } = androidBuild([
    tok(['color', 'labx'], 'color', { colorSpace: 'lab', components: [60, 90, 60], hex: '#ff002f' }),
    tok(['color', 'lchx'], 'color', { colorSpace: 'lch', components: [60, 130, 30] }),
    tok(['color', 'hslx'], 'color', { colorSpace: 'hsl', components: [210, 50, 40] }),
    tok(['color', 'hwbx'], 'color', { colorSpace: 'hwb', components: [0, 20, 30] }),
  ], [SWIFT_OUT, XCASSETS_OUT, COMPOSE_OUT, XML_OUT])
  assert.equal(r.status, 0, r.stderr)
  const swift = read(root, SWIFT_OUT.path)
  assert.doesNotMatch(r.stdout, /not a colour these outputs can write/)
  for (const name of ['Labx', 'Lchx', 'Hslx', 'Hwbx']) assert.ok(existsSync(join(root, XCASSETS_OUT.path, `${name}.colorset/Contents.json`)), name)
  assert.equal(JSON.parse(read(root, `${XCASSETS_OUT.path}/Labx.colorset/Contents.json`)).colors[0].color['color-space'], 'extended-srgb')
  assert.match(swift, /static let labx = Color\("Labx"/)
  assert.match(r.stdout, /color\.labx: Compose colours are sRGB here, so its lab value was converted and clipped/)
  assert.match(r.stdout, /color\.lchx: Android colour resources are sRGB, so its lch value was converted and clipped/)
  assert.match(read(root, `${XML_OUT.path}/values/massimo_tokens.xml`), /<color name="color_hslx">#FF336699<\/color>/)
})

// P2
test('extract run again after a build never reads the values massimo wrote as the app\'s own', () => {
  const root = repo({ fixture: 'android-compose', config: { platforms: { android: {} }, tokens: { source: 'ds/tokens/tokens.resolver.json', outputs: [], mobileSources: [{ kind: 'android-values', include: ['core/designsystem/src/main/res/values*/*.xml'] }] } } })
  const first = tokensRun(root, ['extract'])
  assert.equal(first.status, 0, first.stderr)
  const count = /(\d+) tokens/.exec(first.stdout)[1]
  cpSync(join(root, 'ds/tokens/draft'), join(root, 'ds/tokens'), { recursive: true })
  const config = readConfig(root)
  config.tokens.outputs = [{ format: 'android-xml', path: 'core/designsystem/src/main/res' }]
  writeConfig(root, config)
  assert.equal(tokensRun(root, ['build']).status, 0)
  const again = tokensRun(root, ['extract'])
  assert.equal(again.status, 0, again.stderr)
  assert.equal(/(\d+) tokens/.exec(again.stdout)[1], count)
})

// P3
test('the Compose colours class takes no constructor arguments, so any number of colours loads on the JVM', () => {
  const many = Array.from({ length: 130 }, (_, i) => tok(['color', `c${i}`], 'color', srgb(`#${(i * 1234567 % 0xffffff).toString(16).padStart(6, '0')}`), { modes: { dark: srgb('#000000') } }))
  const { root, r } = androidBuild(many, [COMPOSE_OUT])
  assert.equal(r.status, 0, r.stderr)
  const kt = read(root, COMPOSE_OUT.path)
  assert.doesNotMatch(kt, /data class DesignTokensColors\(/)
  assert.match(kt, /public abstract class DesignTokensColors \{\n {4}public abstract val c0: Color\n/)
  assert.match(kt, /private object LightColors : DesignTokensColors\(\) \{\n {4}override val c0: Color = Color\(0xFF000000\)\n/)
  assert.match(kt, /public val LightDesignTokensColors: DesignTokensColors = LightColors\n/)
})

// P5
test('a resource name that is a Java keyword is renamed, and the build says so', () => {
  const { root, r } = androidBuild([tok(['default'], 'dimension', px(8)), tok(['class'], 'number', 2), tok(['new'], 'color', srgb('#6f4d09'))], [XML_OUT])
  assert.equal(r.status, 0, r.stderr)
  const xml = read(root, `${XML_OUT.path}/values/massimo_tokens.xml`)
  assert.match(xml, /<dimen name="token_default">8dp<\/dimen>/)
  assert.match(xml, /<item name="token_class" format="float" type="dimen">2<\/item>/)
  assert.match(xml, /<color name="token_new">#FF6F4D09<\/color>/)
  assert.match(r.stdout, /note: default: "default" is a reserved word in Java, so its Android resource is token_default/)
})

// P8
test('a colour state list in res/color with a token\'s resource name stops the build, as a values clash does', () => {
  const root = repo({ config: tokensMode([XML_OUT]), tokens: [tok(['color', 'brand'], 'color', srgb('#6200ee'))], files: { 'android/core/src/main/res/color/color_brand.xml': '<?xml version="1.0" encoding="utf-8"?>\n<selector xmlns:android="http://schemas.android.com/apk/res/android">\n    <item android:color="#6200ee"/>\n</selector>\n' } })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /color color_brand in android\/core\/src\/main\/res\/color\/color_brand\.xml/)
  assert.ok(!existsSync(join(root, XML_OUT.path, 'values/massimo_tokens.xml')))
})

// L11
test('an Android reference to a resource left out says so, and a cycle through values-night drops only the night value', () => {
  const root = put(join(scratch(), 'repo'), {
    'core/src/main/res/values/dimens.xml': '<resources><dimen name="card_padding">@dimen/gutter</dimen><dimen name="gutter">@dimen/m3_comp_card_padding</dimen><dimen name="spacing_md">16dp</dimen><dimen name="hairline">1px</dimen></resources>',
    'core/src/main/res/values-night/dimens.xml': '<resources><dimen name="spacing_md">@dimen/card_padding</dimen></resources>',
    'core/src/main/res/values/colors.xml': '<resources><color name="a">@color/b</color><color name="b">#112233</color><color name="c">#445566</color><color name="tint">?attr/colorPrimary</color></resources>',
    'core/src/main/res/values-night/colors.xml': '<resources><color name="b">@color/a</color><color name="c">@color/tint</color></resources>',
  })
  const files = ['core/src/main/res/values/dimens.xml', 'core/src/main/res/values-night/dimens.xml', 'core/src/main/res/values/colors.xml', 'core/src/main/res/values-night/colors.xml']
  const { tokens, notes } = readAndroidValues(root, files)
  assert.ok(notes.includes('core/src/main/res/values-night/dimens.xml: spacing_md points at @dimen/card_padding, which is left out; its night value is left out too'), notes.join('\n'))
  assert.ok(notes.includes('core/src/main/res/values-night/colors.xml: c points at @color/tint, which is left out; its night value is left out too'), notes.join('\n'))
  assert.ok(notes.some((n) => /b: its night value points round in a cycle \(@color\/a, @color\/b\); its night value is left out/.test(n)), notes.join('\n'))
  const b = tokens.find((t) => t.mobile.resource === 'b')
  assert.ok(!('dark' in b.modes))
  // The tokens build: no cycle reaches the model.
  const r = repo({ fixture: null, config: { platforms: { android: {} }, tokens: { source: 'ds/tokens/tokens.resolver.json', outputs: [], mobileSources: [{ kind: 'android-values', include: ['core/src/main/res/values*/*.xml'] }] } }, files: Object.fromEntries(files.map((f) => [f, readFileSync(join(root, f), 'utf8')])) })
  const x = tokensRun(r, ['extract'])
  assert.equal(x.status, 0, x.stderr)
})

// L12
test('with two design-system modules and no values yet, the token outputs go in the module detect names', () => {
  const root = put(join(scratch(), 'repo'), {
    'settings.gradle.kts': 'include(":app", ":core:designsystem", ":core:ui", ":core:data")\n',
    'app/build.gradle.kts': 'plugins { id("com.android.application") }\nandroid { namespace = "com.example.app"\n buildFeatures { compose = true } }\n',
    'core/designsystem/build.gradle.kts': 'plugins { id("com.android.library") }\nandroid { namespace = "com.example.designsystem" }\n',
    'core/designsystem/src/main/kotlin/com/example/designsystem/Button.kt': 'package com.example.designsystem\n',
    'core/ui/src/main/kotlin/com/example/ui/Card.kt': 'package com.example.ui\n',
  })
  const android = detect(root).platforms.find((p) => p.id === 'android')
  assert.equal(android.designSystem.path, 'core/designsystem')
  assert.deepEqual(android.suggestedOutputs.map((o) => o.path), ['core/designsystem/src/main/kotlin/com/example/designsystem/DesignTokens.kt', 'core/designsystem/src/main/res'])
})

// ── Cross-platform shells, config and the web ───────────────────────────────

const IOS_APP = (dir) => ({ [`${dir}/Runner.xcodeproj/project.pbxproj`]: PBX_ONE('Runner'), [`${dir}/Runner/AppDelegate.swift`]: 'import UIKit\n\nclass AppDelegate: UIResponder {}\n' })
const ANDROID_APP = (dir, settings = 'include(":app")\n') => ({ [`${dir}/settings.gradle`]: settings, [`${dir}/app/build.gradle`]: 'plugins { id "com.android.application" }\nandroid { namespace "com.example.app" }\n', [`${dir}/app/src/main/java/com/example/app/MainActivity.kt`]: 'package com.example.app\n\nclass MainActivity\n', [`${dir}/app/src/main/res/values/colors.xml`]: '<resources><color name="brand">#6200ee</color></resources>\n' })
const platformsOf = (root) => (detect(root).platforms ?? []).map((p) => `${p.id}@${p.root}`)

// I8
test('a cross-platform shell is never a mobile platform: Tauri with no package.json, Capacitor with its own native paths, React Native folders beside the package, and detect run inside a shell', () => {
  const tauri = put(join(scratch(), 'repo'), { ...WEB, 'desktop/src-tauri/Cargo.toml': '[package]\nname = "desk"\n', 'desktop/src-tauri/tauri.conf.json': '{"productName":"desk"}\n', 'desktop/src-tauri/gen/apple/project.yml': 'name: desk\ntargets:\n  desk:\n    platform: iOS\n    sources: [Sources]\n', ...IOS_APP('desktop/src-tauri/gen/apple'), ...ANDROID_APP('desktop/src-tauri/gen/android', 'include ":app"\napply from: "tauri.settings.gradle"\n') })
  assert.deepEqual(platformsOf(tauri), [])
  const tauriRoot = put(join(scratch(), 'repo'), { 'src-tauri/Cargo.toml': '[package]\nname = "desk"\n', 'src-tauri/tauri.conf.json': '{"productName":"desk"}\n', 'index.html': '<!doctype html>\n', ...ANDROID_APP('src-tauri/gen/android') })
  assert.deepEqual(platformsOf(tauriRoot), [])
  const capacitor = put(join(scratch(), 'repo'), { ...WEB, 'capacitor.config.json': '{"appId":"com.example","webDir":"out","ios":{"path":"native/ios"},"android":{"path":"native/android"}}\n', ...IOS_APP('native/ios/App'), ...ANDROID_APP('native/android') })
  assert.deepEqual(platformsOf(capacitor), [])
  const rn = put(join(scratch(), 'repo'), { 'app/package.json': { name: 'app', dependencies: { 'react-native': '0.76.0' } }, 'ios/Podfile': "require_relative '../app/node_modules/react-native/scripts/react_native_pods'\ntarget 'App' do\n  use_react_native!\nend\n", ...IOS_APP('ios'), ...ANDROID_APP('android', 'pluginManagement { includeBuild("../app/node_modules/@react-native/gradle-plugin") }\ninclude ":app"\n') })
  assert.deepEqual(platformsOf(rn), [])
  const inside = put(join(scratch(), 'repo'), { 'package.json': { name: 'app', dependencies: { 'react-native': '0.76.0' } }, ...IOS_APP('ios'), ...ANDROID_APP('android') })
  assert.deepEqual(platformsOf(join(inside, 'ios')), [])
  assert.deepEqual(platformsOf(join(inside, 'android')), [])
  const flutter = put(join(scratch(), 'repo'), { 'pubspec.yaml': 'name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n', ...IOS_APP('ios'), ...ANDROID_APP('android') })
  assert.deepEqual(platformsOf(join(flutter, 'ios')), [])
})

// T4
test('a Flutter app is never a mobile platform: at the root, in a subfolder, or as a workspace member', () => {
  const flutter = (dir) => ({ [`${dir}pubspec.yaml`]: 'name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n', [`${dir}lib/main.dart`]: 'void main() {}\n', ...IOS_APP(`${dir}ios`), ...ANDROID_APP(`${dir}android`) })
  assert.deepEqual(platformsOf(put(join(scratch(), 'repo'), flutter(''))), [])
  assert.deepEqual(platformsOf(put(join(scratch(), 'repo'), { ...WEB, ...flutter('mobile_app/') })), [])
  assert.deepEqual(platformsOf(put(join(scratch(), 'repo'), { 'package.json': { name: 'mono', private: true, workspaces: ['apps/*'] }, 'apps/site/package.json': { name: 'site', dependencies: { next: '15.0.0' } }, ...flutter('apps/shop/') })), [])
})

// L15
test('the README of a project with no web platform points at no web graph and no ds:check script', () => {
  const root = repo({ fixture: 'ios-spm', config: { platforms: { ios: {} }, tokens: { source: 'ds/tokens/tokens.resolver.json', outputs: [] } } })
  const r = run('docs', root)
  assert.equal(r.status, 0, r.stderr)
  const readme = read(root, 'ds/README.md')
  assert.doesNotMatch(readme, /graph\.mjs|ds:check script yet/)
  assert.match(readme, /The component graph reads web code, and this project declares no web platform, so it has none\./)
  assert.match(readme, /`node ds\/scripts\/check\.mjs` runs every massimo check that applies to the project/)
})

// L16
test('tokens.breakpoints and guard.extraChecks, both from 0.3.0, set minScripts and warn without it', () => {
  for (const raw of [{ tokens: { breakpoints: { scale: ['40rem'] } } }, { guard: { extraChecks: [{ name: 'lint', run: 'npm run lint' }] } }]) {
    assert.equal(needsScripts(raw), '0.3.0', JSON.stringify(raw))
    assert.ok(minScriptsWarning(raw), JSON.stringify(raw))
  }
  assert.equal(needsScripts({ guard: { extraChecks: [] } }), null)
})

// L17
test('init refuses a malformed platforms value before it writes anything, in a dry run too', () => {
  for (const dry of [true, false]) {
    const root = put(join(scratch(), 'repo'), WEB)
    const r = spawnSync(process.execPath, [join('scripts', 'init.mjs'), '--root', root, '--no-agents-file', '--config-json', '{"platforms":["web","ios"]}', ...(dry ? ['--dry-run'] : [])], { encoding: 'utf8' })
    assert.equal(r.status, 1, `${dry}: ${r.stdout}`)
    assert.match(r.stderr, /platforms must map web, ios or android to a block/)
    assert.ok(!existsSync(join(root, 'massimo.config.json')), `dry: ${dry}`)
  }
})

// P4
test('a project whose default mode is dark extracts its iOS and Android colours, keeping the light ones', () => {
  const ios = repo({ fixture: 'ios-spm', config: { platforms: { ios: {} }, tokens: { source: 'ds/tokens/tokens.resolver.json', defaultMode: 'dark', outputs: [], mobile: { colors: 'tokens' }, mobileSources: [{ kind: 'xcassets', path: 'Sources/DesignSystem/Resources/*.xcassets' }] } } })
  const i = tokensRun(ios, ['extract'])
  assert.equal(i.status, 0, i.stderr)
  const base = JSON.parse(read(ios, 'ds/tokens/draft/base.tokens.json'))
  const light = JSON.parse(read(ios, 'ds/tokens/draft/theme/light.tokens.json'))
  assert.ok(base.color.Surface.$value.hex !== light.color.Surface.$value.hex)
  cpSync(join(ios, 'ds/tokens/draft'), join(ios, 'ds/tokens'), { recursive: true })
  const config = readConfig(ios)
  config.tokens.outputs = [{ format: 'xcassets', path: OWNED }]
  writeConfig(ios, config)
  assert.equal(tokensRun(ios, ['build']).status, 0)
  const set = JSON.parse(read(ios, `${OWNED}/Brand/Primary.colorset/Contents.json`))
  const team = JSON.parse(readFileSync(join('test/fixtures/ios-spm', CATALOG, 'Brand/Primary.colorset/Contents.json'), 'utf8'))
  const pick = (doc, dark) => doc.colors.find((c) => Boolean(c.appearances?.some((a) => a.value === 'dark')) === dark && !c.appearances?.some((a) => a.appearance === 'contrast')).color.components.red
  assert.equal(pick(set, false), pick(team, false))
  assert.equal(pick(set, true), pick(team, true))
  const android = repo({ fixture: 'android-compose', config: { platforms: { android: {} }, tokens: { source: 'ds/tokens/tokens.resolver.json', defaultMode: 'dark', outputs: [], mobileSources: [{ kind: 'android-values', include: ['core/designsystem/src/main/res/values*/*.xml'] }] } } })
  const a = tokensRun(android, ['extract'])
  assert.equal(a.status, 0, a.stderr)
})

// L4
test('a dark default named Dark, or behind a second modifier, keeps its light values, and a third mode\'s note names what the outputs hold', () => {
  const capital = repo({ config: { ...tokensMode([XML_OUT]), tokens: { ...tokensMode([XML_OUT]).tokens, defaultMode: 'Dark' } }, tokens: [tok(['color', 'surface'], 'color', srgb('#111111'), { modes: { Light: srgb('#ffffff') } })], defaultMode: 'Dark' })
  const c = tokensRun(capital, ['build'])
  assert.equal(c.status, 0, c.stderr)
  assert.match(read(capital, `${XML_OUT.path}/values/massimo_tokens.xml`), /#FFFFFFFF/)
  assert.match(read(capital, `${XML_OUT.path}/values-night/massimo_tokens.xml`), /#FF111111/)
  const two = repo({ config: tokensMode([XML_OUT]), tokens: [tok(['color', 'surface'], 'color', srgb('#111111'), { modes: { light: srgb('#ffffff') } })], defaultMode: 'dark' })
  const resolver = join(two, 'ds/tokens/tokens.resolver.json')
  const doc = JSON.parse(readFileSync(resolver, 'utf8'))
  doc.modifiers = { brand: { contexts: { acme: [] }, default: 'acme' }, ...doc.modifiers }
  doc.resolutionOrder = [{ $ref: '#/sets/base' }, { $ref: '#/modifiers/brand' }, { $ref: '#/modifiers/theme' }]
  writeFileSync(resolver, JSON.stringify(doc, null, 2))
  const t = tokensRun(two, ['build'])
  assert.equal(t.status, 0, t.stderr)
  assert.match(read(two, `${XML_OUT.path}/values/massimo_tokens.xml`), /#FFFFFFFF/)
  assert.match(read(two, `${XML_OUT.path}/values-night/massimo_tokens.xml`), /#FF111111/)
  const third = repo({ config: { ...tokensMode([COMPOSE_OUT]), tokens: { ...tokensMode([COMPOSE_OUT]).tokens, defaultMode: 'dark' } }, tokens: [tok(['color', 'surface'], 'color', srgb('#111111'), { modes: { light: srgb('#ffffff'), contrast: srgb('#000000') } })], defaultMode: 'dark' })
  const r = tokensRun(third, ['build'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /color\.surface: its contrast value is not carried over: the mobile outputs hold the light and dark values only/)
})
