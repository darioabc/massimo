// The mobile readers: an Xcode asset catalog (the ios-spm fixture is the
// contract, written as Xcode writes a catalog: a namespace folder, a second
// catalog, dark and high-contrast appearances, Display P3, an alpha and an
// empty AccentColor), Android res/values (alpha first, references,
// values-night, dimensions by name), and the Swift and Kotlin colour counts.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { kotlinColorLiterals } from '../scripts/lib/lang-kotlin.mjs'
import { maskSource, swiftColorLiterals } from '../scripts/lib/lang-swift.mjs'
import { androidColor, androidValueFiles, catalogColors, colorEntryCss, readAndroidValues, readAssetCatalog, xmlResources } from '../scripts/lib/readers-mobile.mjs'
import { FIXTURES } from './helpers.mjs'

const IOS = join(FIXTURES, 'ios-spm')
const ANDROID = join(FIXTURES, 'android-compose')

test('an Android colour is alpha first: #80FF0000 reads as 50% red', () => {
  assert.equal(androidColor('#80FF0000'), '#ff000080')
  assert.equal(androidColor('#FF6200EE'), '#6200ee')
  assert.equal(androidColor('#8F00'), '#f008')
  assert.equal(androidColor('#123'), '#123')
  assert.equal(androidColor('@color/x'), null)
})

test('an asset catalog reads into colour tokens: namespaces in the path, the dark appearance as a mode, the name kept', () => {
  const r = readAssetCatalog(IOS, 'Sources/DesignSystem/Resources/*.xcassets')
  const by = Object.fromEntries(r.tokens.map((t) => [t.path.join('.'), t]))
  assert.deepEqual(Object.keys(by).sort(), ['color.Accent', 'color.Brand.Primary', 'color.Ink', 'color.Overlay', 'color.Surface'])
  assert.equal(by['color.Brand.Primary'].value, '#6200ee')
  assert.deepEqual(by['color.Brand.Primary'].modes, { dark: '#bb86fc' })
  assert.equal(by['color.Brand.Primary'].mobile.asset, 'Brand/Primary')
  // The second catalog is read too.
  assert.equal(by['color.Ink'].mobile.catalog, 'Sources/DesignSystem/Resources/Extra.xcassets')
  // Display P3 stays Display P3; an alpha that is no 8-bit step stays exact.
  assert.equal(by['color.Accent'].value, 'color(display-p3 1 0.4 0.2 / 1)')
  assert.equal(by['color.Overlay'].value, 'color(srgb 0 0 0 / 0.5)')
  assert.ok(r.notes.some((n) => /AccentColor\.colorset: holds no colour/.test(n)))
})

test('high-contrast entries are kept beside the token and named in the notes, never dropped', () => {
  const r = readAssetCatalog(IOS, 'Sources/DesignSystem/Resources/Colors.xcassets')
  const surface = r.tokens.find((t) => t.mobile.asset === 'Surface')
  assert.deepEqual(surface.mobile.contrast, { light: '#ffffff', dark: '#000000' })
  assert.deepEqual(surface.modes, { dark: '#1c1c1e' })
  assert.ok(r.notes.some((n) => /1 colour has high-contrast entries \(Surface\)/.test(n)))
})

test('Xcode component forms: 8-bit hex, 8-bit integers, floats, grey, and system colours named', () => {
  assert.equal(colorEntryCss({ 'color-space': 'srgb', components: { red: '0x62', green: '0', blue: '238', alpha: '1.000' } }).css, '#6200ee')
  assert.equal(colorEntryCss({ 'color-space': 'srgb', components: { red: '0.400', green: '0.200', blue: '1.000', alpha: '1.000' } }).css, '#6633ff')
  assert.equal(colorEntryCss({ 'color-space': 'srgb', components: { red: '0.123', green: '0', blue: '0', alpha: '1' } }).css, 'color(srgb 0.123 0 0 / 1)')
  assert.equal(colorEntryCss({ 'color-space': 'gray-gamma-22', components: { white: '0.000', alpha: '1.000' } }).css, '#000000')
  assert.match(colorEntryCss({ platform: 'ios', reference: 'systemBlueColor' }).why, /system colour systemBlueColor/)
  const sets = catalogColors(IOS, 'Sources/DesignSystem/Resources/Colors.xcassets')
  assert.deepEqual(sets.map((s) => s.name), ['Accent', 'Brand/Primary', 'Overlay', 'Surface'])
})

test('Android res/values: colours, references, values-night as dark, dimensions grouped by name, and what is left out', () => {
  const files = androidValueFiles(ANDROID, ['core/designsystem/src/main/res/values*/*.xml'])
  const r = readAndroidValues(ANDROID, files)
  const by = Object.fromEntries(r.tokens.map((t) => [t.path.join('.'), t]))
  assert.equal(by['color.brand_primary'].value, '#6200ee')
  assert.deepEqual(by['color.brand_primary'].modes, { dark: '#bb86fc' })
  assert.equal(by['color.scrim'].value, '#00000080')
  assert.equal(by['color.on_brand'].value, '{color.paper}')
  assert.equal(by['color.system_white'].value, '#ffffff')
  assert.equal(by['spacing.spacing_small'].value, '4px')
  assert.equal(by['radius.corner_radius'].value, '8px')
  assert.equal(by['text.body_text'].value, '16px')
  assert.equal(by['color.brand_primary'].mobile.resource, 'brand_primary')
  assert.ok(!('color.themed' in by))
  assert.ok(r.notes.some((n) => /themed is \?attr\/colorPrimary/.test(n)))
  assert.ok(r.notes.some((n) => /hairline is in px/.test(n)))
  assert.ok(r.notes.some((n) => /values-v31: 1 value is for a qualifier/.test(n)))
})

test('resources are read without their comments, and <item type="color"> counts as a colour', () => {
  const r = xmlResources('<resources><!-- <color name="gone">#fff</color> --><item name="x" type="color">#000</item><dimen name="d">2dp</dimen></resources>')
  assert.deepEqual(r, [{ type: 'color', name: 'x', value: '#000' }, { type: 'dimen', name: 'd', value: '2dp' }])
})

test('Swift colour literals: initialisers with components and #colorLiteral, never in a comment or a string', () => {
  const text = [
    'let a = Color(red: 0.1, green: 0.2, blue: 0.3)',
    'let b = UIColor(white: 0.5, alpha: 1)',
    'let c = Color(.sRGB, red: 1, green: 0, blue: 0)',
    'let d = #colorLiteral(red: 1, green: 1, blue: 1, alpha: 1)',
    'let e = Color(hex: "#FF0000")',
    '// let f = Color(red: 1, green: 0, blue: 0)',
    '/* nested /* Color(red: 1, green: 0, blue: 0) */ still a comment */',
    'let g = "Color(red: 1, green: 0, blue: 0)"',
    'let h = #"Color(red: 1, green: 0, blue: 0)"#',
    'let i = Color("Brand/Primary")',
  ].join('\n')
  assert.deepEqual(swiftColorLiterals(text).map((f) => f.line), [1, 2, 3, 4, 5])
  assert.equal(maskSource('a "b" c').length, 7)
})

test('Kotlin colour literals: Color(0x…), numeric Color(…), parseColor and toColorInt, never in a comment or a string', () => {
  const text = [
    'val a = Color(0xFF6200EE)',
    'val b = Color(0.1f, 0.2f, 0.3f)',
    'val c = Color(red = 0.1f, green = 0f, blue = 0f)',
    'val d = android.graphics.Color.parseColor("#FF0000")',
    'val e = "#FF0000".toColorInt()',
    '// val f = Color(0xFF000000)',
    'val g = "Color(0xFF000000)"',
    'val h = Color.Red',
  ].join('\n')
  assert.deepEqual(kotlinColorLiterals(text).map((f) => f.line), [1, 2, 3, 4, 5])
})
