// The mobile token outputs: swift, xcassets, compose and android-xml built
// from one token set and compared with goldens in test/golden/mobile/; dark
// values in every output; names a language cannot hold renamed; files massimo
// did not write left alone; owned files tracked, orphans failing check and
// removed only with --prune; a resource clash stopping the build; a colour
// with high-contrast entries left in the app's catalog and listed; and a
// colour set read from a catalog building back the same.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { writeTokenSet } from '../scripts/lib/dtcg.mjs'
import { FIXTURES, SCRIPTS, golden } from './helpers.mjs'

const made = []
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })))

// A scratch repo: a fixture's files (or none), a config, and a token set.
function repo({ fixture = null, config = {}, tokens = null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'massimo-mobile-'))
  made.push(base)
  const root = join(base, 'repo')
  mkdirSync(root, { recursive: true })
  if (fixture) cpSync(join(FIXTURES, fixture), root, { recursive: true })
  writeFileSync(join(root, 'massimo.config.json'), JSON.stringify({ version: 1, minScripts: '0.6.0', projectDir: 'ds', ...config }, null, 2))
  if (tokens) for (const [name, text] of Object.entries(writeTokenSet({ tokens }))) {
    mkdirSync(join(root, 'ds', 'tokens', name, '..'), { recursive: true })
    writeFileSync(join(root, 'ds', 'tokens', name), text)
  }
  return root
}
const tokensRun = (root, args) => spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), ...args, '--root', root], { encoding: 'utf8' })
const read = (root, path) => readFileSync(join(root, path), 'utf8')
const files = (dir, base = dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n), base) : [join(dir, n).slice(base.length + 1)])).sort()

const srgb = (hex) => ({ colorSpace: 'srgb', components: [1, 3, 5].map((i) => Number((Number.parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4))), hex: hex.slice(0, 7), ...(hex.length > 7 ? { alpha: Number((Number.parseInt(hex.slice(7, 9), 16) / 255).toFixed(4)) } : {}) })
const px = (value, unit = 'px') => ({ value, unit })
const tok = (path, type, value, extra = {}) => ({ path, name: path.join('.'), type, value, modes: {}, description: '', cssVar: `--${path.join('-')}`, on: null, use: null, contrast: 4.5, collection: null, extensions: {}, deprecated: null, css: null, cssModes: {}, strict: true, ...extra })

// One of every kind of token the mobile outputs meet.
const SET = [
  tok(['color', 'brand', 'primary'], 'color', srgb('#6200ee'), { description: 'Primary actions', modes: { dark: srgb('#bb86fc') } }),
  tok(['color', 'surface'], 'color', srgb('#ffffff'), { modes: { dark: srgb('#1c1c1e') } }),
  tok(['color', 'primary'], 'color', '{color.brand.primary}'),
  tok(['color', 'on-primary'], 'color', srgb('#ffffff')),
  tok(['color', 'default'], 'color', srgb('#000000')),
  tok(['color', 'accent'], 'color', { colorSpace: 'display-p3', components: [1, 0.4, 0.2] }),
  tok(['color', 'vivid'], 'color', { colorSpace: 'oklch', components: [0.7, 0.3, 30] }),
  tok(['color', 'scrim'], 'color', srgb('#00000080')),
  tok(['spacing', '2'], 'dimension', px(8)),
  tok(['spacing', 'md'], 'dimension', px(1, 'rem')),
  tok(['spacing', 'gap-em'], 'dimension', px(8), { css: '0.5em' }),
  tok(['radius', 'lg'], 'dimension', px(12)),
  tok(['font', 'family', 'sans'], 'fontFamily', ['Inter', 'system-ui']),
  tok(['font', 'weight', 'bold'], 'fontWeight', 700),
  tok(['text', 'body'], 'typography', { fontFamily: '{font.family.sans}', fontSize: px(16), fontWeight: 400, lineHeight: 1.5, letterSpacing: px(0) }),
  tok(['text', 'caption'], 'typography', { fontFamily: 'system-ui', fontSize: px(12), fontWeight: 500, lineHeight: 1.25, letterSpacing: px(0.24) }),
  tok(['text', 'display'], 'typography', { fontFamily: 'Inter', fontSize: px(40), fontWeight: 700, lineHeight: 1.1, letterSpacing: px(0) }),
  tok(['motion', 'duration', 'fast'], 'duration', { value: 150, unit: 'ms' }),
  tok(['motion', 'ease', 'standard'], 'cubicBezier', [0.2, 0, 0, 1]),
  tok(['motion', 'fade'], 'transition', { duration: { value: 150, unit: 'ms' }, delay: { value: 0, unit: 'ms' }, timingFunction: [0.2, 0, 0, 1] }),
  tok(['shadow', 'card'], 'shadow', [{ color: srgb('#00000033'), offsetX: px(0), offsetY: px(2), blur: px(8), spread: px(0) }]),
  tok(['opacity', 'disabled'], 'number', 0.38),
]

const OUTPUTS = [
  { format: 'swift', path: 'ios/App/DesignTokens.swift' },
  { format: 'xcassets', path: 'ios/App/MassimoTokens.xcassets' },
  { format: 'compose', path: 'android/core/src/main/kotlin/com/example/tokens/DesignTokens.kt' },
  { format: 'android-xml', path: 'android/core/src/main/res' },
]
const TOKENS_MODE = { platforms: { ios: {}, android: {} }, tokens: { source: 'ds/tokens/tokens.resolver.json', outputs: OUTPUTS, mobile: { colors: 'tokens' } } }

test('golden: every mobile output built from one token set', () => {
  const root = repo({ config: TOKENS_MODE, tokens: SET })
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  const catalog = files(join(root, 'ios/App/MassimoTokens.xcassets')).map((f) => `== ${f}\n${read(root, `ios/App/MassimoTokens.xcassets/${f}`)}`).join('')
  const all = {
    'DesignTokens.swift': read(root, 'ios/App/DesignTokens.swift'),
    'MassimoTokens.xcassets.txt': catalog,
    'DesignTokens.kt': read(root, 'android/core/src/main/kotlin/com/example/tokens/DesignTokens.kt'),
    'values/massimo_tokens.xml': read(root, 'android/core/src/main/res/values/massimo_tokens.xml'),
    'values-night/massimo_tokens.xml': read(root, 'android/core/src/main/res/values-night/massimo_tokens.xml'),
    'build.txt': r.stdout,
  }
  for (const [name, text] of Object.entries(all)) assert.equal(text, golden(`mobile/${name}`, text) ?? text, name)
})

test('a colour with a dark value has it in every output', () => {
  const root = repo({ config: TOKENS_MODE, tokens: SET })
  assert.equal(tokensRun(root, ['build']).status, 0)
  const set = JSON.parse(read(root, 'ios/App/MassimoTokens.xcassets/Brand/Primary.colorset/Contents.json'))
  assert.deepEqual(set.colors[1].appearances, [{ appearance: 'luminosity', value: 'dark' }])
  assert.equal(set.colors[1].color.components.red, '0xBB')
  assert.match(read(root, 'ios/App/DesignTokens.swift'), /static let brandPrimary = Color\("Brand\/Primary", bundle: designTokensBundle\)/)
  const kotlin = read(root, 'android/core/src/main/kotlin/com/example/tokens/DesignTokens.kt')
  assert.match(kotlin, /public val DarkDesignTokensColors: DesignTokensColors = DesignTokensColors\(\n[\s\S]*brandPrimary = Color\(0xFFBB86FC\)/)
  assert.match(read(root, 'android/core/src/main/res/values-night/massimo_tokens.xml'), /<color name="color_brand_primary">#FFBB86FC<\/color>/)
})

test('the XML header goes after the declaration, and names a language cannot hold are renamed and said', () => {
  const root = repo({ config: TOKENS_MODE, tokens: SET })
  const r = tokensRun(root, ['build'])
  const xml = read(root, 'android/core/src/main/res/values/massimo_tokens.xml').split('\n')
  assert.equal(xml[0], '<?xml version="1.0" encoding="utf-8"?>')
  assert.match(xml[1], /^<!-- Generated by massimo tokens from /)
  assert.match(read(root, 'ios/App/DesignTokens.swift'), /static let defaultColor = /)
  assert.match(read(root, 'ios/App/DesignTokens.swift'), /static let spacing2: CGFloat = 8/)
  assert.match(r.stdout, /note: color\.default: "default" is a reserved word, so it is defaultColor in Swift/)
  assert.match(r.stdout, /note: spacing\.2: starts with a digit, so it is spacing2 in Swift/)
})

test('Display P3 and oklch say what happened to them, and what has no mobile value is listed', () => {
  const root = repo({ config: TOKENS_MODE, tokens: SET })
  const r = tokensRun(root, ['build'])
  assert.match(r.stdout, /note: color\.accent: Android colour resources are sRGB, so its Display P3 value was converted and clipped/)
  assert.match(r.stdout, /note: color\.vivid: converted from oklch to sRGB for the catalog/)
  assert.match(r.stdout, /note: spacing\.gap-em: its exact CSS \(0\.5em\) is the web's; the mobile outputs use its value/)
  assert.match(r.stdout, /not carried over to the mobile outputs: motion\.fade is a transition/)
  assert.match(r.stdout, /not carried over to ios\/App\/DesignTokens\.swift: text\.display has no iOS text style/)
  // P3 stays P3 where the platform holds it.
  assert.match(read(root, 'ios/App/MassimoTokens.xcassets/Accent.colorset/Contents.json'), /"color-space" : "display-p3"/)
  assert.match(read(root, 'android/core/src/main/kotlin/com/example/tokens/DesignTokens.kt'), /colorSpace = ColorSpaces\.DisplayP3/)
})

test('check passes after a build, fails on an edited output, and the owned files are listed with their hashes', () => {
  const root = repo({ config: TOKENS_MODE, tokens: SET })
  assert.equal(tokensRun(root, ['build']).status, 0)
  const owned = JSON.parse(read(root, 'ds/tokens/mobile-outputs.json'))
  assert.equal(owned.format, 1)
  assert.ok('ios/App/DesignTokens.swift' in owned.files)
  assert.ok('ios/App/MassimoTokens.xcassets/Contents.json' in owned.files)
  assert.equal(tokensRun(root, ['check']).status, 0)
  writeFileSync(join(root, 'ios/App/DesignTokens.swift'), `${read(root, 'ios/App/DesignTokens.swift')}// edited\n`)
  const r = tokensRun(root, ['check'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /stale: ios\/App\/DesignTokens\.swift/)
})

test('a file the build no longer makes fails check, is listed by build, and goes only with --prune', () => {
  const root = repo({ config: TOKENS_MODE, tokens: SET })
  assert.equal(tokensRun(root, ['build']).status, 0)
  // Drop the token that made Accent.colorset.
  const set = SET.filter((t) => t.name !== 'color.accent')
  for (const [name, text] of Object.entries(writeTokenSet({ tokens: set }))) writeFileSync(join(root, 'ds', 'tokens', name), text)
  const check = tokensRun(root, ['check'])
  assert.equal(check.status, 1)
  assert.match(check.stderr, /orphan: ios\/App\/MassimoTokens\.xcassets\/Accent\.colorset\/Contents\.json/)
  assert.match(check.stdout, /tokens\.mjs build --prune/)
  const build = tokensRun(root, ['build'])
  assert.match(build.stdout, /no longer built, still on disk: ios\/App\/MassimoTokens\.xcassets\/Accent\.colorset\/Contents\.json; run build --prune/)
  assert.ok(existsSync(join(root, 'ios/App/MassimoTokens.xcassets/Accent.colorset/Contents.json')))
  assert.equal(tokensRun(root, ['check']).status, 1)
  const prune = tokensRun(root, ['build', '--prune'])
  assert.match(prune.stdout, /removed 1 file the build no longer makes/)
  assert.ok(!existsSync(join(root, 'ios/App/MassimoTokens.xcassets/Accent.colorset')))
  assert.equal(tokensRun(root, ['check']).status, 0)
})

test('a file massimo did not write is never written over', () => {
  const root = repo({ config: TOKENS_MODE, tokens: SET })
  mkdirSync(join(root, 'ios/App'), { recursive: true })
  writeFileSync(join(root, 'ios/App/DesignTokens.swift'), 'import SwiftUI\n// the team\'s own\n')
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /these files exist and massimo did not write them, so the build leaves them alone and writes nothing: ios\/App\/DesignTokens\.swift/)
  assert.equal(read(root, 'ios/App/DesignTokens.swift'), 'import SwiftUI\n// the team\'s own\n')
  assert.ok(!existsSync(join(root, 'android/core/src/main/res/values/massimo_tokens.xml')))
})

test('the app\'s own colors.xml stays byte for byte, and a name it already declares stops the build with a list', () => {
  const root = repo({ fixture: 'android-compose', config: { platforms: { android: { ui: ['compose'] } }, tokens: { source: 'ds/tokens/tokens.resolver.json', outputs: [{ format: 'android-xml', path: 'core/designsystem/src/main/res' }] } }, tokens: SET })
  const before = read(root, 'core/designsystem/src/main/res/values/colors.xml')
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(root, 'core/designsystem/src/main/res/values/colors.xml'), before)
  writeFileSync(join(root, 'core/designsystem/src/main/res/values/extra.xml'), '<resources>\n    <color name="color_surface">#fff</color>\n    <dimen name="radius_lg">2dp</dimen>\n</resources>\n')
  const clash = tokensRun(root, ['build'])
  assert.equal(clash.status, 1)
  assert.match(clash.stderr, /color color_surface in core\/designsystem\/src\/main\/res\/values\/extra\.xml/)
  assert.match(clash.stderr, /dimen radius_lg in core\/designsystem\/src\/main\/res\/values\/extra\.xml/)
})

// ── From an app's own catalog ──────────────────────────────────────────────

// A glob on purpose: it also matches the catalog massimo writes, which must never count as the app's.
const IOS_SOURCES = [{ kind: 'xcassets', path: 'Sources/DesignSystem/Resources/*.xcassets' }]

// The ios-spm fixture with its catalog extracted and the draft taken as the token set.
function extracted(outputs, colors) {
  const root = repo({ fixture: 'ios-spm', config: { platforms: { ios: {} }, tokens: { source: 'ds/tokens/tokens.resolver.json', outputs: [], mobile: { colors }, mobileSources: IOS_SOURCES } } })
  const r = tokensRun(root, ['extract'])
  assert.equal(r.status, 0, r.stderr)
  cpSync(join(root, 'ds/tokens/draft'), join(root, 'ds/tokens'), { recursive: true })
  const path = join(root, 'massimo.config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  config.tokens.outputs = outputs
  writeFileSync(path, JSON.stringify(config))
  return root
}

test('catalog mode: the Swift output reads the app\'s catalog by name, public and from .module inside a package target', () => {
  const root = extracted([{ format: 'swift', path: 'Sources/DesignSystem/DesignTokens.swift' }], 'catalog')
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  const swift = read(root, 'Sources/DesignSystem/DesignTokens.swift')
  assert.match(swift, /public enum DesignTokens \{/)
  assert.match(swift, /public static let brandPrimary = Color\("Brand\/Primary", bundle: \.module\)/)
  // The catalog stays the source, so a colour with high-contrast entries is read like any other.
  assert.match(swift, /public static let surface = Color\("Surface", bundle: \.module\)/)
  assert.match(r.stdout, /wired: Sources\/DesignSystem\/DesignTokens\.swift sits in the Swift package target DesignSystem, which picks it up by itself/)
  // An owned catalog beside the app's would make every name twice.
  const path = join(root, 'massimo.config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  config.tokens.outputs.push({ format: 'xcassets', path: 'Sources/DesignSystem/Resources/MassimoTokens.xcassets' })
  writeFileSync(path, JSON.stringify(config))
  const both = tokensRun(root, ['build'])
  assert.equal(both.status, 1)
  assert.match(both.stderr, /catalog mode, where the app's own catalog stays the colour source/)
})

test('tokens mode: a colour with high-contrast entries is skipped, stays in the app\'s catalog as it was, and is listed', () => {
  const root = extracted([{ format: 'xcassets', path: 'Sources/DesignSystem/Resources/MassimoTokens.xcassets' }, { format: 'swift', path: 'Sources/DesignSystem/DesignTokens.swift' }], 'tokens')
  const team = read(root, 'Sources/DesignSystem/Resources/Colors.xcassets/Surface.colorset/Contents.json')
  const r = tokensRun(root, ['build'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /not carried over to Sources\/DesignSystem\/Resources\/MassimoTokens\.xcassets: color\.Surface has high-contrast entries in Sources\/DesignSystem\/Resources\/Colors\.xcassets\/Surface\.colorset/)
  assert.ok(!existsSync(join(root, 'Sources/DesignSystem/Resources/MassimoTokens.xcassets/Surface.colorset')))
  assert.ok(existsSync(join(root, 'Sources/DesignSystem/Resources/MassimoTokens.xcassets/Brand/Primary.colorset/Contents.json')))
  assert.equal(read(root, 'Sources/DesignSystem/Resources/Colors.xcassets/Surface.colorset/Contents.json'), team)
  // The Swift output still reads it, by the same name, from the app's catalog.
  assert.match(read(root, 'Sources/DesignSystem/DesignTokens.swift'), /public static let surface = Color\("Surface", bundle: \.module\)/)
})

test('a colour set with a dark appearance round-trips: read into tokens and built back, its colours are the same', () => {
  const root = extracted([{ format: 'xcassets', path: 'Sources/DesignSystem/Resources/MassimoTokens.xcassets' }], 'tokens')
  assert.equal(tokensRun(root, ['build']).status, 0)
  for (const name of ['Brand/Primary', 'Accent', 'Overlay']) {
    const before = JSON.parse(read(root, `Sources/DesignSystem/Resources/Colors.xcassets/${name}.colorset/Contents.json`)).colors
    const back = JSON.parse(read(root, `Sources/DesignSystem/Resources/MassimoTokens.xcassets/${name}.colorset/Contents.json`)).colors
    assert.deepEqual(back, before, name)
  }
  assert.deepEqual(JSON.parse(read(root, 'Sources/DesignSystem/Resources/MassimoTokens.xcassets/Brand/Contents.json')).properties, { 'provides-namespace': true })
  // The second catalog's colour is read and built too.
  assert.deepEqual(JSON.parse(read(root, 'Sources/DesignSystem/Resources/MassimoTokens.xcassets/Ink.colorset/Contents.json')).colors, JSON.parse(read(root, 'Sources/DesignSystem/Resources/Extra.xcassets/Ink.colorset/Contents.json')).colors)
})

test('--dedupe removes from the app\'s catalog the colour sets the owned catalog now holds, and nothing else', () => {
  const root = extracted([{ format: 'xcassets', path: 'Sources/DesignSystem/Resources/MassimoTokens.xcassets' }], 'tokens')
  const r = tokensRun(root, ['build'])
  assert.match(r.stdout, /duplicates: the owned catalog now holds 4 colour sets the app's catalog also has/)
  const d = tokensRun(root, ['build', '--dedupe'])
  assert.equal(d.status, 0, d.stderr)
  assert.match(d.stdout, /removed 4 colour sets from the app's catalog/)
  // A second build finds nothing to remove, and the owned catalog is whole.
  assert.doesNotMatch(tokensRun(root, ['build']).stdout, /duplicates:/)
  assert.equal(tokensRun(root, ['check']).status, 0)
  assert.ok(!existsSync(join(root, 'Sources/DesignSystem/Resources/Colors.xcassets/Brand/Primary.colorset')))
  assert.ok(existsSync(join(root, 'Sources/DesignSystem/Resources/Colors.xcassets/Surface.colorset/Contents.json')))
  assert.ok(existsSync(join(root, 'Sources/DesignSystem/Resources/MassimoTokens.xcassets/Brand/Primary.colorset/Contents.json')))
})

test('Figma variables gain iOS and Android code syntax only when the config declares those platforms', () => {
  const root = repo({ config: TOKENS_MODE, tokens: SET })
  assert.equal(tokensRun(root, ['build']).status, 0)
  const figma = JSON.parse(read(root, 'ds/tokens/figma-variables.json'))
  const v = figma.collections.flatMap((c) => c.variables).find((x) => x.name === 'color/brand/primary')
  assert.deepEqual(v.codeSyntax, { WEB: 'var(--color-brand-primary)', iOS: 'DesignTokens.Colors.brandPrimary', ANDROID: 'DesignTokens.colors.brandPrimary' })
  const web = repo({ config: { tokens: { source: 'ds/tokens/tokens.resolver.json', outputs: [] } }, tokens: SET })
  assert.equal(tokensRun(web, ['build']).status, 0)
  const plain = JSON.parse(read(web, 'ds/tokens/figma-variables.json')).collections.flatMap((c) => c.variables).find((x) => x.name === 'color/brand/primary')
  assert.deepEqual(plain.codeSyntax, { WEB: 'var(--color-brand-primary)' })
  assert.ok(!existsSync(join(web, 'ds/tokens/mobile-outputs.json')))
})
