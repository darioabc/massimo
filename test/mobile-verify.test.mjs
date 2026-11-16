// The second round of 0.6.0 mobile edges, one test per issue the fix
// verification found (R regressions, I and L incomplete fixes, T fixes no
// test guarded, P bugs found in passing): the files massimo owns, the Swift
// floors, the bundle a colour is read from, colour sets dedupe must keep,
// what detect proposes, the Android outputs and readers, and config.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { CATALOG, COMPOSE_OUT, EXTRA, OWNED, colorset, entry, px, SWIFT_OUT, XCASSETS_OUT, XML_OUT, extracted, put, read, readConfig, repo, scratch, srgb, tok, tokensMode, tokensRun, writeConfig } from './mobile-helpers.mjs'

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
