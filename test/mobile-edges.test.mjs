// Edges of the 0.6.0 mobile support, one test each: variants a team colour
// set holds that the owned catalog does not, the bundle a colour is read
// from, names in the shared colour scope, alpha and gamut in every output,
// mobile shells inside a workspace, Android references and resource names,
// a dark default mode, generic font families, code syntax, the files massimo
// owns (hashes, containment, case), and what detect proposes in less common
// layouts.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { writeTokenSet } from '../scripts/lib/dtcg.mjs'
import { swiftColorLiterals } from '../scripts/lib/lang-swift.mjs'
import { iosWire } from '../scripts/lib/platform-ios.mjs'
import { minScriptsWarning, needsScripts } from '../scripts/lib/project.mjs'
import { byteOf } from '../scripts/lib/mobile-units.mjs'
import { catalogColors, readAndroidValues, readAssetCatalog, xmlResources } from '../scripts/lib/readers-mobile.mjs'
import { FIXTURES, SCRIPTS } from './helpers.mjs'

const made = []
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })))

function scratch() {
  const base = mkdtempSync(join(tmpdir(), 'massimo-edges-'))
  made.push(base)
  return base
}
function put(root, files) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  return root
}
// A scratch repo: a fixture's files (or none), a config, a token set and more files.
function repo({ fixture = null, config = {}, tokens = null, files = {}, defaultMode = 'light' } = {}) {
  const root = join(scratch(), 'repo')
  mkdirSync(root, { recursive: true })
  if (fixture) cpSync(join(FIXTURES, fixture), root, { recursive: true })
  put(root, files)
  writeConfig(root, { version: 1, minScripts: '0.6.0', projectDir: 'ds', ...config })
  if (tokens) for (const [name, text] of Object.entries(writeTokenSet({ tokens, defaultMode }))) put(root, { [join('ds', 'tokens', name)]: text })
  return root
}
const writeConfig = (root, config) => writeFileSync(join(root, 'massimo.config.json'), JSON.stringify(config, null, 2))
const readConfig = (root) => JSON.parse(readFileSync(join(root, 'massimo.config.json'), 'utf8'))
const run = (name, root, args = []) => spawnSync(process.execPath, [join(SCRIPTS, `${name}.mjs`), ...args, '--root', root], { encoding: 'utf8' })
const tokensRun = (root, args) => run('tokens', root, args)
const read = (root, path) => readFileSync(join(root, path), 'utf8')
const detect = (root) => {
  const r = run('detect', root)
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

const srgb = (hex) => ({ colorSpace: 'srgb', components: [1, 3, 5].map((i) => Number((Number.parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4))), hex: hex.slice(0, 7), ...(hex.length > 7 ? { alpha: Number((Number.parseInt(hex.slice(7, 9), 16) / 255).toFixed(4)) } : {}) })
const px = (value, unit = 'px') => ({ value, unit })
const tok = (path, type, value, extra = {}) => ({ path, name: path.join('.'), type, value, modes: {}, description: '', cssVar: `--${path.join('-')}`, on: null, use: null, contrast: 4.5, collection: null, extensions: {}, deprecated: null, css: null, cssModes: {}, strict: true, ...extra })
const tokensMode = (outputs, extra = {}) => ({ platforms: { ios: {}, android: {} }, tokens: { source: 'ds/tokens/tokens.resolver.json', outputs, mobile: { colors: 'tokens', ...extra } } })
const SWIFT_OUT = { format: 'swift', path: 'ios/App/DesignTokens.swift' }
const XCASSETS_OUT = { format: 'xcassets', path: 'ios/App/MassimoTokens.xcassets' }
const COMPOSE_OUT = { format: 'compose', path: 'android/core/src/main/kotlin/com/example/tokens/DesignTokens.kt' }
const XML_OUT = { format: 'android-xml', path: 'android/core/src/main/res' }

// ── The ios-spm fixture, extracted and taken as the token set ─────────────

const CATALOG = 'Sources/DesignSystem/Resources/Colors.xcassets'
const EXTRA = 'Sources/DesignSystem/Resources/Extra.xcassets'
const OWNED = 'Sources/DesignSystem/Resources/MassimoTokens.xcassets'
const entry = (hex, { appearance = null, gamut = null, idiom = 'universal' } = {}) => ({
  ...(appearance ? { appearances: [{ appearance: 'luminosity', value: appearance }] } : {}),
  color: { 'color-space': gamut === 'display-P3' ? 'display-p3' : 'srgb', components: { alpha: '1.000', blue: `0x${hex.slice(5, 7)}`, green: `0x${hex.slice(3, 5)}`, red: `0x${hex.slice(1, 3)}` } },
  ...(gamut ? { 'display-gamut': gamut } : {}),
  idiom,
})
const colorset = (colors) => ({ colors, info: { author: 'xcode', version: 1 } })

function extracted({ outputs, colors, files = {}, sources = [{ kind: 'xcassets', path: 'Sources/DesignSystem/Resources/*.xcassets' }] }) {
  const root = repo({ fixture: 'ios-spm', files, config: { platforms: { ios: {} }, tokens: { source: 'ds/tokens/tokens.resolver.json', outputs: [], mobile: { colors }, mobileSources: sources } } })
  const r = tokensRun(root, ['extract'])
  assert.equal(r.status, 0, r.stderr)
  cpSync(join(root, 'ds/tokens/draft'), join(root, 'ds/tokens'), { recursive: true })
  const config = readConfig(root)
  config.tokens.outputs = outputs
  writeConfig(root, config)
  return { root, extract: r }
}

// #1
test('--dedupe never removes a team colour set holding a variant the owned catalog does not carry: it stays in the app catalog and is listed', () => {
  const ink = colorset([entry('#112233', { gamut: 'sRGB' }), entry('#112234', { gamut: 'display-P3' }), entry('#EEF0F5', { appearance: 'dark', gamut: 'sRGB' }), entry('#EEF0F6', { appearance: 'dark', gamut: 'display-P3' })])
  const overlay = JSON.parse(readFileSync(join(FIXTURES, 'ios-spm', CATALOG, 'Overlay.colorset/Contents.json'), 'utf8'))
  overlay.colors.push({ ...overlay.colors[0], idiom: 'ipad' })
  const { root, extract } = extracted({ outputs: [{ format: 'xcassets', path: OWNED }, { format: 'swift', path: 'Sources/DesignSystem/DesignTokens.swift' }], colors: 'tokens', files: { [`${EXTRA}/Ink.colorset/Contents.json`]: ink, [`${CATALOG}/Overlay.colorset/Contents.json`]: overlay } })
  assert.match(extract.stdout + extract.stderr, /Ink\.colorset: .*display-P3/)
  const before = { ink: read(root, `${EXTRA}/Ink.colorset/Contents.json`), overlay: read(root, `${CATALOG}/Overlay.colorset/Contents.json`) }
  const r = tokensRun(root, ['build', '--dedupe'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /not carried over to Sources\/DesignSystem\/Resources\/MassimoTokens\.xcassets: color\.Ink has entries massimo does not model yet \(display-P3 gamut\)/)
  assert.match(r.stdout, /color\.Overlay has entries massimo does not model yet \(the ipad idiom\)/)
  assert.equal(read(root, `${EXTRA}/Ink.colorset/Contents.json`), before.ink)
  assert.equal(read(root, `${CATALOG}/Overlay.colorset/Contents.json`), before.overlay)
  assert.ok(!existsSync(join(root, OWNED, 'Ink.colorset')))
  // The Swift output reads the kept set by name from the app's catalog; a set with nothing more is still deduped.
  assert.match(read(root, 'Sources/DesignSystem/DesignTokens.swift'), /static let ink = Color\("Ink", bundle: \.module\)/)
  assert.ok(!existsSync(join(root, CATALOG, 'Brand/Primary.colorset')))
})

// #2
test('catalog mode reads a colour only from the bundle its catalog compiles into; any other is skipped and listed', () => {
  const files = { 'App/Assets.xcassets/Contents.json': { info: { author: 'xcode', version: 1 } }, 'App/Assets.xcassets/AppTint.colorset/Contents.json': colorset([entry('#FF8800')]) }
  const sources = [{ kind: 'xcassets', path: 'Sources/DesignSystem/Resources/*.xcassets' }, { kind: 'xcassets', path: 'App/Assets.xcassets' }]
  const { root } = extracted({ outputs: [{ format: 'swift', path: 'Sources/DesignSystem/DesignTokens.swift' }], colors: 'catalog', files, sources })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  const swift = read(root, 'Sources/DesignSystem/DesignTokens.swift')
  assert.match(swift, /static let brandPrimary = Color\("Brand\/Primary", bundle: \.module\)/)
  assert.doesNotMatch(swift, /AppTint/)
  assert.match(r.stdout, /not carried over to Sources\/DesignSystem\/DesignTokens\.swift: color\.AppTint is in App\/Assets\.xcassets, which is not in the bundle this file reads/)
  // Outside the package, the package's colours are the ones out of reach.
  const config = readConfig(root)
  config.tokens.outputs = [{ format: 'swift', path: 'App/DesignTokens.swift' }]
  writeConfig(root, config)
  const app = tokensRun(root, ['build'])
  assert.equal(app.status, 0, app.stderr)
  const appSwift = read(root, 'App/DesignTokens.swift')
  assert.match(appSwift, /static let appTint = Color\("AppTint", bundle: designTokensBundle\)/)
  assert.doesNotMatch(appSwift, /Brand\/Primary/)
  assert.match(app.stdout, /color\.Brand\.Primary is in Sources\/DesignSystem\/Resources\/Colors\.xcassets, which is not in the bundle this file reads/)
})

// #3
test('a colour outside the color group keeps its group word in the shared Colors scope, and a real clash there stops the build', () => {
  const colors = [tok(['text', 'primary'], 'color', srgb('#111111')), tok(['border', 'primary'], 'color', srgb('#222222')), tok(['text', 'default'], 'color', srgb('#333333')), tok(['border', 'default'], 'color', srgb('#444444'))]
  const root = repo({ config: tokensMode([SWIFT_OUT, COMPOSE_OUT]), tokens: colors })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  const swift = read(root, SWIFT_OUT.path)
  // Once: a colour with no dark value is the same on every platform.
  for (const name of ['textPrimary', 'borderPrimary', 'textDefault', 'borderDefault']) assert.equal(swift.split(`static let ${name} = Color(`).length - 1, 1, name)
  assert.doesNotMatch(swift, /static let primary =/)
  const kt = read(root, COMPOSE_OUT.path)
  for (const name of ['textPrimary', 'borderPrimary', 'textDefault', 'borderDefault']) assert.equal(kt.split(`public val ${name}: Color,`).length - 1, 1, name)
  const clash = repo({ config: tokensMode([SWIFT_OUT]), tokens: [tok(['color', 'text-primary'], 'color', srgb('#111111')), tok(['text', 'primary'], 'color', srgb('#222222'))] })
  const c = tokensRun(clash, ['build'])
  assert.equal(c.status, 1)
  assert.match(c.stderr, /color\.text-primary and text\.primary would both be Colors\.textPrimary in Swift/)
})

// #4
test('a number or gradient under color is not a colour: it takes its own group, and Kotlin declares the colours class once', () => {
  const root = repo({ config: tokensMode([COMPOSE_OUT, SWIFT_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee')), tok(['color', 'disabled-alpha'], 'number', 0.38), tok(['color', 'brand-gradient'], 'gradient', [{ color: srgb('#000000'), position: 0 }, { color: srgb('#ffffff'), position: 1 }])] })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  const kt = read(root, COMPOSE_OUT.path)
  assert.equal(kt.split('DesignTokensColors(').length - 1, 3, 'the data class and its light and dark instances')
  assert.doesNotMatch(kt, /public object DesignTokensColors\b/)
  assert.equal(kt.split('public val colors:').length - 1, 1)
  assert.match(kt, /public object DesignTokensNumbers \{\n {4}public const val colorDisabledAlpha: Float = 0\.38f/)
})

// #5
test('an hsl colour keeps its alpha in every mobile output', () => {
  const scrim = tok(['color', 'scrim'], 'color', { colorSpace: 'hsl', components: [0, 0, 0], alpha: 0.5, hex: '#000000' })
  const root = repo({ config: tokensMode([XCASSETS_OUT, SWIFT_OUT, COMPOSE_OUT, XML_OUT]), tokens: [scrim] })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(read(root, `${XML_OUT.path}/values/massimo_tokens.xml`), /<color name="color_scrim">#80000000<\/color>/)
  assert.match(read(root, COMPOSE_OUT.path), /scrim = Color\(red = 0f, green = 0f, blue = 0f, alpha = 0\.5f\)/)
  assert.equal(JSON.parse(read(root, `${XCASSETS_OUT.path}/Scrim.colorset/Contents.json`)).colors[0].color.components.alpha, '0.500')
  assert.match(read(root, SWIFT_OUT.path), /static let scrim = Color\("Scrim", bundle: designTokensBundle\)/)
})

const VIVID = tok(['color', 'vivid'], 'color', { colorSpace: 'oklch', components: [0.7, 0.3, 30] })

// #6
test('Compose clips an sRGB colour outside 0..1 and says so, as the Android resources do', () => {
  const root = repo({ config: tokensMode([COMPOSE_OUT]), tokens: [VIVID] })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  const kt = read(root, COMPOSE_OUT.path)
  assert.match(kt, /vivid = Color\(0xFFFF0000\)/)
  assert.doesNotMatch(kt, /-0\.\d+f/)
  assert.match(r.stdout, /note: color\.vivid: Compose colours are sRGB here, so its oklch value was converted and clipped/)
})

// #7
test('a React Native, Expo or Capacitor app in a workspace member or a subfolder is not a platform', () => {
  const mobileApp = (dir) => ({
    [`${dir}/ios/App.xcodeproj/project.pbxproj`]: '// !$*UTF8*$!\n{\n\tobjects = {\n\t\tA1 /* App */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t};\n\t};\n}\n',
    [`${dir}/ios/App/AppDelegate.swift`]: 'import UIKit\n\nclass AppDelegate: UIResponder {}\n',
    [`${dir}/android/settings.gradle`]: "include ':app'\n",
    [`${dir}/android/app/build.gradle`]: "apply plugin: 'com.android.application'\n",
    [`${dir}/android/app/src/main/res/values/colors.xml`]: '<resources><color name="splash_bg">#FF112233</color></resources>\n',
  })
  const web = { 'apps/web/package.json': { name: 'web', dependencies: { next: '15.0.0', react: '19.0.0' } }, 'apps/web/app/page.tsx': 'export default function Page() { return null }\n' }
  const shells = {
    'react-native workspace member': { 'package.json': { name: 'mono', private: true, workspaces: ['apps/*'] }, ...web, 'apps/mobile/package.json': { name: 'mobile', dependencies: { 'react-native': '0.80.0' } }, ...mobileApp('apps/mobile') },
    'expo subfolder': { 'package.json': { name: 'site', dependencies: { next: '15.0.0', react: '19.0.0' } }, 'app/page.tsx': 'export default function Page() { return null }\n', 'mobile/package.json': { name: 'mobile', dependencies: { expo: '53.0.0' } }, ...mobileApp('mobile') },
    'capacitor workspace member': { 'package.json': { name: 'mono', private: true, workspaces: ['apps/*'] }, ...web, 'apps/mobile/package.json': { name: 'mobile', dependencies: { '@capacitor/core': '7.0.0' } }, 'apps/mobile/capacitor.config.ts': "export default { appId: 'x', webDir: 'dist' }\n", ...mobileApp('apps/mobile') },
  }
  for (const [name, files] of Object.entries(shells)) {
    const root = put(join(scratch(), 'repo'), files)
    const d = detect(root)
    assert.ok(!('platforms' in d), `${name}: ${JSON.stringify(d.platforms)}`)
    assert.ok(!('minScripts' in d.suggestedConfig), name)
  }
})

// #8
test('tokens mode with no xcassets output keeps a high-contrast colour whole: Swift reads it from the app catalog by name, and the build says so', () => {
  const { root } = extracted({ outputs: [{ format: 'swift', path: 'Sources/DesignSystem/DesignTokens.swift' }], colors: 'tokens' })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(read(root, 'Sources/DesignSystem/DesignTokens.swift'), /public static let surface = Color\("Surface", bundle: \.module\)/)
  assert.match(r.stdout, /note: color\.Surface has high-contrast entries in Sources\/DesignSystem\/Resources\/Colors\.xcassets\/Surface\.colorset, which massimo does not model yet; the Swift output reads it from the app's catalog by name, so they are kept/)
})

// #9
test('an extended sRGB component outside 0..1 is written as a number, never clamped to a byte', () => {
  assert.equal(byteOf(298.997 / 255), null)
  assert.equal(byteOf(-0.5 / 255), null)
  assert.equal(byteOf(1), 255)
  const root = repo({ config: tokensMode([XCASSETS_OUT]), tokens: [VIVID] })
  assert.equal(tokensRun(root, ['build']).status, 0)
  const c = JSON.parse(read(root, `${XCASSETS_OUT.path}/Vivid.colorset/Contents.json`)).colors[0].color
  assert.equal(c['color-space'], 'extended-srgb')
  assert.ok(Number(c.components.red) > 1.17, c.components.red)
})

const androidRepo = (files) => put(join(scratch(), 'repo'), files)
const VALUES = 'core/src/main/res/values'

// #10
test('an Android colour that points at a colour left out is left out too, with a note, and no alias dangles', () => {
  const root = androidRepo({ [`${VALUES}/colors.xml`]: '<resources>\n<color name="brand">@color/m3_ref_palette_dynamic_primary40</color>\n<color name="button_background">@color/brand</color>\n<color name="ink">#FF111111</color>\n</resources>\n' })
  const { tokens, notes } = readAndroidValues(root, [`${VALUES}/colors.xml`])
  assert.deepEqual(tokens.map((t) => [t.path.join('.'), t.value]), [['color.ink', '#111111']])
  assert.ok(notes.some((n) => /button_background points at @color\/brand, which is left out; left out too/.test(n)), notes.join('\n'))
})

// #11
test('a dimen alias declared before its target resolves through the chain to the target group', () => {
  const root = androidRepo({ [`${VALUES}/dimens.xml`]: '<resources>\n<dimen name="button_padding">@dimen/card_padding</dimen>\n<dimen name="card_padding">@dimen/spacing_md</dimen>\n<dimen name="spacing_md">16dp</dimen>\n</resources>\n' })
  const { tokens } = readAndroidValues(root, [`${VALUES}/dimens.xml`])
  assert.deepEqual(tokens.map((t) => [t.path.join('.'), t.value]), [['spacing.button_padding', '{spacing.card_padding}'], ['spacing.card_padding', '{spacing.spacing_md}'], ['spacing.spacing_md', '16px']])
})

// #12
test('the resource reader keeps the colours between a string-array and a later string, and reads single-quoted names', () => {
  const xml = '<resources>\n<string-array name="planets"><item>Mercury</item></string-array>\n<color name="brand">#FF6200EE</color>\n<dimen name=\'spacing_md\'>16dp</dimen>\n<integer-array name="ids"><item>1</item></integer-array>\n<integer name="count">3</integer>\n<string name="app_name">App</string>\n</resources>\n'
  assert.deepEqual(xmlResources(xml).map((r) => `${r.type}:${r.name}`), ['string-array:planets', 'color:brand', 'dimen:spacing_md', 'integer-array:ids', 'integer:count', 'string:app_name'])
})

// #13
test('a project.yml that is not an XcodeGen spec, or a Swift package with no UI, is not an iOS app', () => {
  const web = { 'package.json': { name: 'site', dependencies: { next: '15.0.0', react: '19.0.0' } }, 'app/page.tsx': 'export default function Page() { return null }\n' }
  const yml = put(join(scratch(), 'repo'), { ...web, 'deploy/project.yml': 'name: web\nservices: [api]\n' })
  assert.ok(!('platforms' in detect(yml)))
  const server = put(join(scratch(), 'repo'), { ...web, 'server/Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "Api", targets: [.executableTarget(name: "App", dependencies: [])])\n', 'server/Sources/App/main.swift': 'import Vapor\n\nlet app = Application()\n' })
  assert.ok(!('platforms' in detect(server)))
})

// #14
test('a multi-project Tuist workspace is rooted at the workspace, and the Swift output goes in a sources folder', () => {
  const literal = 'import SwiftUI\n\nlet tint = Color(red: 0.1, green: 0.2, blue: 0.3)\n'
  const root = put(join(scratch(), 'repo'), {
    'Workspace.swift': 'import ProjectDescription\nlet workspace = Workspace(name: "Acme", projects: ["Projects/*"])\n',
    'Tuist/Config.swift': 'import ProjectDescription\nlet config = Config()\n',
    'Projects/App/Project.swift': 'import ProjectDescription\nlet project = Project(name: "App")\n',
    'Projects/App/Sources/App.swift': literal,
    'Projects/DesignSystem/Project.swift': 'import ProjectDescription\nlet project = Project(name: "DesignSystem")\n',
    'Projects/DesignSystem/Sources/Button.swift': literal,
    'Projects/DesignSystem/Resources/Colors.xcassets/Contents.json': { info: { author: 'xcode', version: 1 } },
    'Projects/DesignSystem/Resources/Colors.xcassets/Ink.colorset/Contents.json': colorset([entry('#112233')]),
  })
  const ios = detect(root).platforms.find((p) => p.id === 'ios')
  assert.equal(ios.root, '.')
  assert.equal(ios.project.kind, 'tuist')
  assert.equal(ios.colorLiterals.count, 2)
  assert.deepEqual(ios.suggestedOutputs.map((o) => o.path), ['Projects/DesignSystem/Sources/DesignTokens.swift'])
})

// #15
test('two tokens that would share an Android resource name stop the build with both named', () => {
  const root = repo({ config: tokensMode([XML_OUT]), tokens: [tok(['text', 'body'], 'typography', { fontFamily: 'system-ui', fontSize: px(16), fontWeight: 400, lineHeight: 1.5, letterSpacing: px(0) }), tok(['text', 'body-size'], 'dimension', px(14))] })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /text\.body and text\.body-size would both be the dimen text_body_size/)
  assert.ok(!existsSync(join(root, XML_OUT.path, 'values/massimo_tokens.xml')))
})

// #16
test('a description holding /* never opens a comment in the Kotlin output', () => {
  const root = repo({ config: tokensMode([COMPOSE_OUT]), tokens: [tok(['spacing', 'gutter'], 'dimension', px(16), { description: 'Page gutter (see layout/*.css)' })] })
  assert.equal(tokensRun(root, ['build']).status, 0)
  const doc = read(root, COMPOSE_OUT.path).split('\n').find((l) => l.includes('Page gutter'))
  assert.doesNotMatch(doc.replace(/^\s*\/\*\*/, '').replace(/\*\/\s*$/, ''), /\/\*|\*\//)
})

// #17
test('a token set whose default mode is dark keeps its light values: light is the day value and the default the dark one', () => {
  const surface = tok(['color', 'surface'], 'color', srgb('#111111'), { modes: { light: srgb('#ffffff') } })
  const config = tokensMode([XCASSETS_OUT, COMPOSE_OUT, XML_OUT])
  config.tokens.defaultMode = 'dark'
  const root = repo({ config, tokens: [surface], defaultMode: 'dark' })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /light value is not carried over/)
  assert.match(read(root, `${XML_OUT.path}/values/massimo_tokens.xml`), /color_surface">#FFFFFFFF</)
  assert.match(read(root, `${XML_OUT.path}/values-night/massimo_tokens.xml`), /color_surface">#FF111111</)
  const kt = read(root, COMPOSE_OUT.path)
  assert.match(kt, /LightDesignTokensColors: DesignTokensColors = DesignTokensColors\(\n {4}surface = Color\(0xFFFFFFFF\)/)
  assert.match(kt, /DarkDesignTokensColors: DesignTokensColors = DesignTokensColors\(\n {4}surface = Color\(0xFF111111\)/)
  const set = JSON.parse(read(root, `${XCASSETS_OUT.path}/Surface.colorset/Contents.json`)).colors
  assert.equal(set[0].color.components.red, '0xFF')
  assert.equal(set[1].color.components.red, '0x11')
})

// #18
test('generic CSS families are the system font in a design, with nothing to bundle', () => {
  const tokens = [
    tok(['font', 'family', 'mono'], 'fontFamily', ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']),
    tok(['text', 'code'], 'typography', { fontFamily: '{font.family.mono}', fontSize: px(14), fontWeight: 400, lineHeight: 1.5, letterSpacing: px(0) }),
    tok(['text', 'quote'], 'typography', { fontFamily: ['ui-serif', 'Georgia', 'serif'], fontSize: px(16), fontWeight: 400, lineHeight: 1.5, letterSpacing: px(0) }),
  ]
  const root = repo({ config: tokensMode([SWIFT_OUT, COMPOSE_OUT], { textStyles: { 'text.code': 'body', 'text.quote': 'callout' } }), tokens })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  const swift = read(root, SWIFT_OUT.path)
  assert.match(swift, /static let code = DesignTokensTextStyle\(font: Font\.system\(\.body, design: \.monospaced\)/)
  assert.match(swift, /static let quote = DesignTokensTextStyle\(font: Font\.system\(\.callout, design: \.serif\)/)
  const kt = read(root, COMPOSE_OUT.path)
  assert.match(kt, /public val code: TextStyle = TextStyle\(fontFamily = FontFamily\.Monospace/)
  assert.match(kt, /public val quote: TextStyle = TextStyle\(fontFamily = FontFamily\.Serif/)
  assert.doesNotMatch(r.stdout, /must be bundled|add it as a font resource|must be added as a font resource/)
})

const codeSyntaxOf = (root, name) => JSON.parse(read(root, 'ds/tokens/figma-variables.json')).collections.flatMap((c) => c.variables).find((x) => x.name === name).codeSyntax

// #19
test('Figma code syntax names only what an output declares, in the scope it declares it', () => {
  const tokens = [tok(['color', 'primary'], 'color', srgb('#6200ee')), tok(['text', 'primary'], 'color', srgb('#111111')), tok(['text', 'display'], 'typography', { fontFamily: 'system-ui', fontSize: px(40), fontWeight: 700, lineHeight: 1.1, letterSpacing: px(0) })]
  const xmlOnly = repo({ config: tokensMode([XML_OUT]), tokens })
  assert.equal(tokensRun(xmlOnly, ['build']).status, 0)
  assert.deepEqual(codeSyntaxOf(xmlOnly, 'color/primary'), { WEB: 'var(--color-primary)', ANDROID: 'R.color.color_primary' })
  const both = repo({ config: tokensMode([SWIFT_OUT, COMPOSE_OUT]), tokens })
  assert.equal(tokensRun(both, ['build']).status, 0)
  assert.deepEqual(codeSyntaxOf(both, 'text/primary'), { WEB: 'var(--text-primary)', iOS: 'DesignTokens.Colors.textPrimary', ANDROID: 'DesignTokens.colors.textPrimary' })
  // With iOS declared but only a compose output, there is no iOS name to give.
  const composeOnly = repo({ config: tokensMode([COMPOSE_OUT]), tokens })
  assert.equal(tokensRun(composeOnly, ['build']).status, 0)
  assert.deepEqual(codeSyntaxOf(composeOnly, 'color/primary'), { WEB: 'var(--color-primary)', ANDROID: 'DesignTokens.colors.primary' })
})

// #20
test('a listed file changed by hand is never written over or pruned', () => {
  const root = repo({ config: tokensMode([COMPOSE_OUT, XML_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  assert.equal(tokensRun(root, ['build']).status, 0)
  const theirs = '// Our own theme, do not lose\npackage com.example.tokens\n'
  writeFileSync(join(root, COMPOSE_OUT.path), theirs)
  const again = tokensRun(root, ['build'])
  assert.equal(again.status, 1)
  assert.match(again.stderr, /changed by hand since massimo wrote/)
  assert.equal(read(root, COMPOSE_OUT.path), theirs)
  const config = readConfig(root)
  config.tokens.outputs = [XML_OUT]
  writeConfig(root, config)
  const prune = tokensRun(root, ['build', '--prune'])
  assert.equal(prune.status, 0, prune.stderr)
  assert.equal(read(root, COMPOSE_OUT.path), theirs)
  assert.match(prune.stdout, /changed by hand since massimo wrote it, so it is left as it is/)
  assert.ok(!(COMPOSE_OUT.path in JSON.parse(read(root, 'ds/tokens/mobile-outputs.json')).files))
  assert.equal(tokensRun(root, ['check']).status, 0)
})

// #21
test('a colour set name that climbs out of its catalog is refused, and a listed path outside the project is never removed', () => {
  const evil = repo({ config: tokensMode([XCASSETS_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'), { mobile: { asset: '../../../../outside/Evil' } })] })
  const r = tokensRun(evil, ['build'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /color\.primary: the colour set name "\.\.\/\.\.\/\.\.\/\.\.\/outside\/Evil" climbs out of the catalog/)
  assert.ok(!existsSync(join(evil, '..', 'outside')))
  const root = repo({ config: tokensMode([XML_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  writeFileSync(join(root, '..', 'keep.txt'), 'not massimo\'s\n')
  put(root, { 'ds/tokens/mobile-outputs.json': { format: 1, writtenBy: '0.6.0', files: { '../keep.txt': 'x' } } })
  const p = tokensRun(root, ['build', '--prune'])
  assert.equal(p.status, 0, p.stderr)
  assert.ok(existsSync(join(root, '..', 'keep.txt')))
})

// #22
test('a case-only rename of an output is never pruned as an orphan of itself', () => {
  const root = repo({ config: tokensMode([SWIFT_OUT]), tokens: [tok(['color', 'primary'], 'color', srgb('#6200ee'))] })
  assert.equal(tokensRun(root, ['build']).status, 0)
  const config = readConfig(root)
  config.tokens.outputs = [{ format: 'swift', path: 'ios/App/Designtokens.swift' }]
  writeConfig(root, config)
  const r = tokensRun(root, ['build', '--prune'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(root, 'ios/App/Designtokens.swift')))
  assert.equal(tokensRun(root, ['check']).status, 0)
})

// #23
test('the guard skill says which steps a project with no web platform skips', () => {
  const guard = readFileSync(join(SCRIPTS, '..', 'skills', 'guard', 'SKILL.md'), 'utf8')
  assert.match(guard, /declares platforms and no web platform/)
})

// #24
test('a design-system target in project.yml or in a folder Xcode keeps in sync is proposed as the components', () => {
  const view = 'import SwiftUI\n\nstruct Card: View {\n    var body: some View { Text("Hi") }\n}\n'
  const yml = put(join(scratch(), 'repo'), {
    'project.yml': 'name: Acme\ntargets:\n  App:\n    type: application\n    platform: iOS\n    sources: [App]\n  DesignSystem:\n    type: framework\n    platform: iOS\n    sources:\n      - path: DesignSystem\n',
    'App/App.swift': view,
    'DesignSystem/Card.swift': view,
  })
  const d = detect(yml)
  assert.equal(d.platforms[0].designSystem?.path, 'DesignSystem')
  assert.deepEqual(d.suggestedConfig.platforms.ios.components.include, ['DesignSystem/**/*.swift'])
  const pbx = put(join(scratch(), 'repo'), {
    'Acme.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n{\n\tobjects = {\n\t\tB1 /* DesignSystem */ = {\n\t\t\tisa = PBXFileSystemSynchronizedRootGroup;\n\t\t\tpath = DesignSystem;\n\t\t};\n\t\tA1 /* Acme */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t};\n\t\tA2 /* DesignSystem */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t};\n\t};\n}\n',
    'Acme/App.swift': view,
    'DesignSystem/Card.swift': view,
  })
  assert.equal(detect(pbx).platforms[0].designSystem?.path, 'DesignSystem')
})

// #25
test('an idiom-only colour set reads its iphone entry and says which entries it left', () => {
  const root = put(join(scratch(), 'cat'), {
    'Colors.xcassets/Contents.json': { info: { author: 'xcode', version: 1 } },
    'Colors.xcassets/Tint.colorset/Contents.json': colorset([entry('#FF0000', { idiom: 'iphone' }), entry('#0000FF', { idiom: 'ipad' })]),
    'Colors.xcassets/Link.colorset/Contents.json': colorset([{ color: { platform: 'ios', reference: 'systemBlueColor' }, idiom: 'universal' }]),
  })
  const sets = catalogColors(root, 'Colors.xcassets')
  const tint = sets.find((s) => s.name === 'Tint')
  assert.equal(tint.values.any, '#ff0000')
  assert.deepEqual(tint.notes, ['Colors.xcassets/Tint.colorset: has no universal entries; read the iphone ones, and the ipad ones are not read'])
  const notes = readAssetCatalog(root, 'Colors.xcassets').notes.filter((n) => n.includes('Link.colorset'))
  assert.equal(notes.length, 1, notes.join('\n'))
})

// #26
test('a dimension in pt, mm or in is left out as a physical unit, and px as one that does not scale', () => {
  const root = androidRepo({ [`${VALUES}/dimens.xml`]: '<resources>\n<dimen name="print_pt">12pt</dimen>\n<dimen name="ruler_mm">5mm</dimen>\n<dimen name="hairline_px">1px</dimen>\n</resources>\n' })
  const { notes } = readAndroidValues(root, [`${VALUES}/dimens.xml`])
  assert.ok(notes.some((n) => /print_pt is in pt, a physical unit with no fixed dp value; left out/.test(n)), notes.join('\n'))
  assert.ok(notes.some((n) => /ruler_mm is in mm, a physical unit with no fixed dp value; left out/.test(n)))
  assert.ok(notes.some((n) => /hairline_px is in px, which does not scale with the screen; left out/.test(n)))
})

// #27
test('the Swift colour count leaves out initialisers whose components are variables', () => {
  const swift = 'let a = Color(red: r, green: g, blue: b)\nlet b = UIColor(red: CGFloat(r) / 255, green: 0, blue: 0, alpha: 1)\nlet c = Color(red: 0.1, green: 0.2, blue: 0.3)\nlet d = Color(.sRGB, white: 0.5, opacity: 1)\nlet e = CGColor(red: x, green: 0, blue: 0, alpha: 1)\n'
  assert.deepEqual(swiftColorLiterals(swift).map((f) => f.line), [3, 4])
})

// #28
test('Swift colours built from components keep their dark value on macOS too', () => {
  const root = repo({ config: tokensMode([SWIFT_OUT]), tokens: [tok(['color', 'surface'], 'color', srgb('#ffffff'), { modes: { dark: srgb('#1c1c1e') } })] })
  assert.equal(tokensRun(root, ['build']).status, 0)
  const swift = read(root, SWIFT_OUT.path)
  assert.match(swift, /#elseif canImport\(AppKit\)\n {8}static let surface = Color\(NSColor\(name: nil\) \{ \$0\.bestMatch\(from: \[\.aqua, \.darkAqua\]\) == \.darkAqua \? NSColor\(red: 0\.1098/)
})

// #29
test('minScripts covers the keys 0.3.0 added', () => {
  assert.equal(needsScripts({ tokens: { mirror: true } }), '0.3.0')
  assert.equal(needsScripts({ audit: { kinds: { color: false } } }), '0.3.0')
  assert.equal(needsScripts({ graph: { strictFaults: true }, platforms: { ios: {} } }), '0.6.0')
  assert.match(minScriptsWarning({ tokens: { inventory: { files: ['a.css'] } } }), /uses tokens\.inventory, which needs massimo scripts 0\.3\.0/)
  assert.equal(minScriptsWarning({ minScripts: '0.3.0', tokens: { mirror: true } }), null)
})

// #30
test('a platforms value that is a list, an empty map or names an unknown platform is refused by name', () => {
  for (const platforms of [['web', 'ios'], {}, { web: {}, flutter: {} }]) {
    const root = repo({ config: { platforms } })
    const r = run('check', root)
    assert.notEqual(r.status, 0, JSON.stringify(platforms))
    assert.match(r.stderr, /massimo\.config\.json: platforms must map web, ios or android to a block/, JSON.stringify(platforms))
  }
})

// #31
test('with core:designsystem and core:ui, the components are those two modules, not every core module', () => {
  const root = put(join(scratch(), 'repo'), {
    'settings.gradle.kts': 'include(":app", ":core:designsystem", ":core:ui", ":core:data", ":core:network")\n',
    'app/build.gradle.kts': 'plugins { id("com.android.application") }\nandroid { buildFeatures { compose = true } }\n',
    'core/designsystem/build.gradle.kts': 'plugins { id("com.android.library") }\nandroid { namespace = "com.example.designsystem" }\n',
    'core/designsystem/src/main/kotlin/com/example/designsystem/Button.kt': 'package com.example.designsystem\n',
    'core/ui/src/main/kotlin/com/example/ui/Card.kt': 'package com.example.ui\n',
    'core/data/src/main/kotlin/com/example/data/Repo.kt': 'package com.example.data\n',
  })
  const android = detect(root).suggestedConfig.platforms.android
  assert.deepEqual(android.components.include, ['core/designsystem/**/src/main/**/*.kt', 'core/ui/**/src/main/**/*.kt'])
})

// #32
test('the iOS wire step reads the project that holds the output, not the first one in the repo', () => {
  const demo = '// !$*UTF8*$!\n{\n\tobjects = {\n\t\tA1 /* Demo */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t};\n\t};\n}\n'
  const store = '// !$*UTF8*$!\n{\n\tobjects = {\n\t\tB1 /* Store */ = {\n\t\t\tisa = PBXFileSystemSynchronizedRootGroup;\n\t\t\tpath = Store;\n\t\t};\n\t\tA1 /* Store */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t};\n\t};\n}\n'
  const files = ['Demo/Demo.xcodeproj/project.pbxproj', 'Store/Store.xcodeproj/project.pbxproj', 'Store/Store/App.swift']
  const text = { 'Demo/Demo.xcodeproj/project.pbxproj': demo, 'Store/Store.xcodeproj/project.pbxproj': store }
  const readText = (f) => text[f] ?? null
  for (const block of [{ root: '.', project: { kind: 'xcodeproj', path: 'Store/Store.xcodeproj' } }, { root: '.' }]) {
    const w = iosWire('Store/Store/DesignTokens.swift', files, readText, block)
    assert.equal(w.needed, false, w.step)
    assert.match(w.step, /sits in Store, a folder Xcode keeps in sync/)
  }
})
