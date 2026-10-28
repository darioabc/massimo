import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contrastRatio, deltaE, parseColor, relativeLuminance, toHex, toOklab } from '../scripts/lib/color.mjs'

const hex = (s) => {
  const c = parseColor(s)
  return c && toHex(c)
}

test('parseColor reads hex in every length', () => {
  assert.equal(hex('#fff'), '#ffffff')
  assert.equal(hex('#0f08'), '#00ff0088')
  assert.equal(hex('#FF8800'), '#ff8800')
  assert.equal(hex('#ff880080'), '#ff880080')
  assert.equal(parseColor('#ff'), null)
  assert.equal(parseColor('#ggg'), null)
})

test('parseColor reads rgb and hsl in comma and space syntax', () => {
  assert.equal(hex('rgb(255, 128, 0)'), '#ff8000')
  assert.equal(hex('rgb(255 128 0 / 50%)'), '#ff800080')
  assert.equal(hex('rgba(255,128,0,.5)'), '#ff800080')
  assert.equal(hex('rgb(100% 50% 0%)'), '#ff8000')
  assert.equal(hex('hsl(30 100% 50%)'), '#ff8000')
  assert.equal(hex('hsla(210, 40%, 98%, 0.5)'), '#f8fafc80')
  assert.equal(hex('hwb(30 0% 0%)'), '#ff8000')
})

test('parseColor reads the modern colour spaces', () => {
  assert.equal(hex('oklch(100% 0 0)'), '#ffffff')
  assert.equal(hex('oklch(0.21 0.006 285.885)'), '#18181b')
  assert.equal(hex('oklab(0.7 0.1 0.1)'), '#e57f4e')
  assert.equal(hex('lab(100% 0 0)'), '#ffffff')
  assert.equal(hex('lab(52.2345% 40.1645 59.9971)'), '#c65d06')
  assert.equal(hex('lch(52.2345% 72.2 56.2)'), '#c65d06')
  assert.equal(hex('color(srgb 1 0.5 0)'), '#ff8000')
  assert.equal(hex('color(display-p3 1 0.5 0)'), '#ff7600')
})

test('parseColor: names, transparent, and things that are not colours', () => {
  assert.equal(hex('black'), '#000000')
  assert.equal(hex('white'), '#ffffff')
  assert.equal(hex('transparent'), '#00000000')
  for (const s of ['currentColor', 'var(--x)', 'rgb(var(--a) / 0.5)', 'inherit', '', 'calc(1px)', 'rgb(0 0)']) {
    assert.equal(parseColor(s), null, s)
  }
})

test('contrastRatio follows WCAG 2.x', () => {
  const white = parseColor('#fff')
  const black = parseColor('#000')
  assert.equal(contrastRatio(black, white), 21)
  assert.equal(contrastRatio(white, black), 21)
  assert.ok(Math.abs(contrastRatio(parseColor('#777'), white) - 4.48) < 0.005)
  // translucent foreground composites over the background
  assert.ok(Math.abs(contrastRatio(parseColor('rgb(0 0 0 / 50%)'), white) - contrastRatio(parseColor('#808080'), white)) < 0.05)
  assert.ok(relativeLuminance(white) > relativeLuminance(black))
})

test('deltaE is Euclidean distance in OKLab', () => {
  assert.ok(Math.abs(deltaE(parseColor('#fff'), parseColor('#000')) - 1) < 1e-6)
  assert.equal(deltaE(parseColor('#abc'), parseColor('#aabbcc')), 0)
  assert.ok(deltaE(parseColor('#777'), parseColor('#787878')) < 0.01)
  assert.ok(Math.abs(toOklab(parseColor('#fff')).L - 1) < 1e-6)
})
