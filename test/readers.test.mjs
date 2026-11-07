// The readers: values an existing repo already keeps, read into one shape
// without running any of its code, with everything skipped said in a note.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { colorFromCss, colorModes, parseColor, toHex } from '../scripts/lib/color.mjs'
import { findObject } from '../scripts/lib/jsobject.mjs'
import { channelColor, fromTokensStudio, isTokensStudio, readCss, readFigmaExport, readTailwindConfig, readThemeObject } from '../scripts/lib/readers.mjs'
import { FIXTURES } from './helpers.mjs'

const dir = join(FIXTURES, 'readers')
const byPath = (tokens) => Object.fromEntries(tokens.map((t) => [t.path.join('.'), t]))

test('colours: every CSS named colour, color-mix() and light-dark()', () => {
  for (const name of ['rebeccapurple', 'lightgoldenrodyellow', 'darkslategrey', 'transparent']) assert.ok(parseColor(name), name)
  assert.equal(toHex(parseColor('color-mix(in srgb, red, blue)')), '#800080')
  assert.equal(toHex(parseColor('color-mix(in srgb, red 25%, blue)')), '#4000bf')
  assert.equal(toHex(parseColor('color-mix(in oklch, white, black)')), '#636363')
  assert.equal(toHex(parseColor('color-mix(in srgb, red 30%, transparent 30%)')), '#ff00004d') // a sum under 100% scales alpha
  assert.equal(parseColor('color-mix(in srgb, var(--x), red)'), null)
  assert.equal(toHex(parseColor('light-dark(#fff, #000)')), '#ffffff')
  assert.deepEqual(colorModes('light-dark(white, #111111)'), { light: 'white', dark: '#111111' })
  // Written in CSS, a colour keeps the precision it was written with.
  assert.deepEqual(colorFromCss('oklch(97.807% 0.029 256.847)').components, [0.97807, 0.029, 256.847])
})

test('CSS: channel triplets keep their channels as CSS, light-dark() splits into themes', () => {
  assert.deepEqual(channelColor('236 229 209'), { value: 'rgb(236 229 209)', css: '236 229 209' })
  assert.deepEqual(channelColor('210 40% 98%'), { value: 'hsl(210 40% 98%)', css: '210 40% 98%' })
  assert.equal(channelColor('1 2'), null)
  assert.equal(channelColor('300 2 3'), null)
  const { tokens } = readCss(dir, ['channels.css'])
  const t = byPath(tokens)
  assert.deepEqual(
    { type: t['color.rgb-base-100'].type, value: t['color.rgb-base-100'].value, css: t['color.rgb-base-100'].css, dark: t['color.rgb-base-100'].modes.dark, darkCss: t['color.rgb-base-100'].cssModes.dark },
    { type: 'color', value: 'rgb(236 229 209)', css: '236 229 209', dark: 'rgb(20 18 16)', darkCss: '20 18 16' },
  )
  assert.equal(t['color.background'].value, 'hsl(210 40% 98%)') // a colour by its value, whatever its name
  assert.deepEqual([t['color.surface'].value, t['color.surface'].modes.dark], ['#ffffff', '#111111'])
  assert.equal(t['color.brand'].cssVar, '--brand')
})

test('CSS: families from names, colours from values, rgb(var()) and clamp() resolved, type steps from stems', () => {
  const { tokens, notes, typeSteps } = readCss(dir, ['families.css'])
  const t = byPath(tokens)
  // A colour by its value: channels, rgb(var(--x)) as a reference, through var() chains.
  assert.equal(t['color.ink-900'].value, 'rgb(29 31 32)')
  assert.deepEqual([t['color.text'].value, t['color.text'].cssVar], ['{color.ink-900}', '--c-text'])
  // Each theme read on its own: an alias by default, a translucent colour or bare channels in dark.
  assert.deepEqual([t['color.text'].modes.dark, t['color.text'].cssModes.dark], ['rgb(236 229 209 / 0.88)', 'rgb(var(--paper-200) / 0.88)'])
  assert.deepEqual([t['color.block'].value, t['color.block'].modes.dark, t['color.block'].cssModes.dark], ['{color.ink-900}', 'rgb(0 0 0)', '0 0 0'])
  assert.equal(t['color.rgb-heading'].value, '{color.ink-900}')
  assert.equal(t['color.heading'].value, '{color.rgb-heading}')
  // rgb(var(--x) / a): the colour it makes in each theme, its CSS kept.
  assert.deepEqual(
    { value: t['color.line'].value, css: t['color.line'].css, dark: t['color.line'].modes.dark },
    { value: 'rgb(29 31 32 / 0.14)', css: 'rgb(var(--ink-900) / 0.14)', dark: 'rgb(250 250 247 / 0.14)' },
  )
  // Families by prefix, each keeping its own variable.
  assert.deepEqual(['spacing.1-5', 'radius.2', 'duration.1', 'ease.out', 'z.modal'].map((p) => t[p]?.cssVar), ['--space-1-5', '--radius-2', '--dur-1', '--ease-out', '--z-modal'])
  // Type parts by suffix where a stem has two of them; a lone -size is not type.
  assert.deepEqual(['text.h1', 'leading.h1', 'tracking.h1', 'font-weight.h1'].map((p) => t[p]?.cssVar), ['--h1-size', '--h1-leading', '--h1-tracking', '--h1-weight'])
  assert.ok(t['other.icon-size'])
  assert.ok(t['other.measure-text'])
  // A fluid size holds its largest value, its clamp() kept and said.
  assert.deepEqual([t['text.h1'].value, t['text.h1'].css], ['4rem', 'clamp(2.5rem, 1.6rem + 3vw, 4rem)'])
  assert.ok(notes.some((n) => /--h1-size is fluid .* holds the largest size, 4rem/.test(n)))
  // The stem as a type step, tracking in em turned to px at its size.
  assert.deepEqual(typeSteps, [{ path: ['text', 'h1'], source: 'families.css', lineHeight: '1', fontWeight: '900', fontWeightRef: '{font-weight.h1}', letterSpacing: '-2.56px' }])
})

test('CSS: a scoped override or a phone-width value is noted, never taken as the token', () => {
  const { tokens, notes } = readCss(dir, ['scopes.css'])
  const t = byPath(tokens)
  assert.deepEqual([t['color.text'].value, t['color.text'].modes.dark], ['#111111', '#eeeeee'])
  assert.equal(t['spacing.base'].value, '4rem') // --gap is spacing by its name
  assert.ok(notes.includes('--c-text is also set inside .tone-block, html.dark .tone-block; its token holds the page\'s value'), notes.join('\n'))
  assert.ok(notes.includes("--gap is also set under @media (max-width: 60rem) :root; its token holds the value outside that, and massimo's outputs do not write the override"), notes.join('\n'))
})

test('Tailwind 3 config: read as text, theme and extend, DEFAULT as $root, skips named', () => {
  const { tokens, notes, typeSteps } = readTailwindConfig(dir, 'tailwind.config.mjs')
  const t = byPath(tokens)
  assert.equal(t['radius.$root'].value, '0.25rem')
  assert.equal(t['radius.none'].value, '0')
  assert.deepEqual(t['font.sans'].value, ['Geist Sans'])
  assert.equal(t['color.base.100'].value, 'var(--rgb-base-100)') // rgb(var(--x) / <alpha-value>) points at the channels
  assert.equal(t['color.primary.$root'].value, '#0f766e')
  assert.equal(t['color.brand'].value, 'var(--brand)')
  assert.equal(t['color.current'], undefined)
  assert.equal(t['text.body'].value, '1rem')
  assert.equal(t['z.modal'].type, 'number')
  assert.deepEqual(typeSteps.find((s) => s.path.join('.') === 'text.body'), { path: ['text', 'body'], size: '1rem', lineHeight: '1.5rem', letterSpacing: '-0.01em', fontWeight: '400' })
  assert.deepEqual(typeSteps.find((s) => s.path.join('.') === 'text.hero').lineHeight, '1.1')
  assert.ok(notes.some((n) => /fontFamily\.sans spreads defaultTheme\.fontFamily\.sans, which was left out/.test(n)))
  assert.ok(notes.some((n) => /spacing\.gutter is computed \(computeGutter\(\)\)/.test(n)))
})

test('a CSS-in-JS theme: palette, scales and fonts, computed values named', () => {
  const { tokens, notes } = readThemeObject(dir, 'theme.ts')
  const t = byPath(tokens)
  assert.equal(t['color.primary.main'].value, '#1976d2')
  assert.equal(t['color.background.default'].value, '#fafafa')
  assert.equal(t['radius.sm'].value, '4px') // a bare number in a size scale is px
  assert.equal(t['font.body'].value, 'Inter, system-ui, sans-serif')
  assert.equal(t['font-weight.bold'].value, '700')
  assert.equal(t['shadow.card'].value, '0 1px 3px rgba(0,0,0,0.2)')
  assert.ok(notes.some((n) => /space is a list, so it was skipped/.test(n)))
  assert.ok(notes.some((n) => /breakpoints are breakpoints/.test(n)))
  assert.ok(notes.some((n) => /spacingUnit is computed \(brandSpacing \* 2\)/.test(n)))
})

test('the object reader never runs code and stops at what it cannot read', () => {
  const src = "module.exports = { a: 'x', b: [1, 'two', { c: true }], d: fn(1, { e: 2 }), 'f-g': `h`, i: `${j}`, ...k, l() { return 1 } }"
  const obj = findObject(src, [/module\.exports\s*=\s*/])
  assert.deepEqual(JSON.parse(JSON.stringify(obj)), { a: 'x', b: [1, 'two', { c: true }], d: { expr: 'fn(1, { e: 2 })' }, 'f-g': 'h', i: { expr: '`${j}`' }, l: { expr: 'l()' } })
})

test('Tokens Studio: sets merged in order, types and shadows converted, themes named', () => {
  const doc = {
    global: { color: { primary: { value: '#ff0000', type: 'color' } }, space: { md: { value: '16', type: 'spacing' } } },
    dark: { color: { primary: { value: '#aa0000', type: 'color' } } },
    $themes: [{ name: 'Dark', selectedTokenSets: { dark: 'enabled' } }],
    $metadata: { tokenSetOrder: ['global'] },
  }
  assert.equal(isTokensStudio(doc), true)
  assert.equal(isTokensStudio({ a: { $value: 1 } }), false)
  const notes = []
  const out = fromTokensStudio(doc, notes, 'tokens.json')
  assert.deepEqual(out.color.primary, { $value: '#ff0000', $type: 'color' })
  assert.deepEqual(out.space.md, { $value: '16', $type: 'dimension' })
  assert.match(notes[0], /themes \(Dark\) choose sets; the sets were read in order, the themes were not/)
  const shadow = fromTokensStudio({ s: { value: { x: 0, y: 2, blur: 4, spread: 0, color: '#0003', type: 'innerShadow' }, type: 'boxShadow' } })
  assert.deepEqual(shadow.s.$value, { color: '#0003', offsetX: '0px', offsetY: '2px', blur: '4px', spread: '0px', inset: true })
})

test('Figma variables from the REST API: paths, themes, aliases, types from scopes', () => {
  const base = mkdtempSync(join(tmpdir(), 'massimo-figma-'))
  try {
    writeFileSync(join(base, 'vars.json'), JSON.stringify({
      meta: {
        variableCollections: { c1: { id: 'c1', name: 'Tokens', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }] } },
        variables: {
          v1: { id: 'v1', name: 'color/blue', resolvedType: 'COLOR', variableCollectionId: 'c1', valuesByMode: { m1: { r: 0, g: 0, b: 1, a: 1 }, m2: { r: 0, g: 0, b: 0.5, a: 1 } } },
          v2: { id: 'v2', name: 'color/accent', resolvedType: 'COLOR', variableCollectionId: 'c1', valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: 'v1' }, m2: { type: 'VARIABLE_ALIAS', id: 'v1' } } },
          v3: { id: 'v3', name: 'space/md', resolvedType: 'FLOAT', scopes: ['GAP'], variableCollectionId: 'c1', valuesByMode: { m1: 16, m2: 16 } },
          v4: { id: 'v4', name: 'weight/bold', resolvedType: 'FLOAT', scopes: ['FONT_WEIGHT'], variableCollectionId: 'c1', valuesByMode: { m1: 700, m2: 700 } },
          v5: { id: 'v5', name: 'flag/beta', resolvedType: 'BOOLEAN', variableCollectionId: 'c1', valuesByMode: { m1: true, m2: false } },
          v6: { id: 'v6', name: 'surface', resolvedType: 'COLOR', variableCollectionId: 'c1', codeSyntax: { WEB: 'var(--surface)' }, valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 }, m2: { r: 0, g: 0, b: 0, a: 1 } } },
          v7: { id: 'v7', name: 'band/surface', resolvedType: 'COLOR', variableCollectionId: 'c1', codeSyntax: { WEB: 'var(--surface)' }, valuesByMode: { m1: { r: 1, g: 0, b: 0, a: 1 }, m2: { r: 1, g: 0, b: 0, a: 1 } } },
        },
      },
    }))
    const { tokens, notes, defaultMode } = readFigmaExport(base, 'vars.json')
    const t = byPath(tokens)
    assert.equal(defaultMode, 'light')
    assert.deepEqual([t['color.blue'].value, t['color.blue'].modes.dark], ['#0000ff', '#000080'])
    assert.equal(t['color.accent'].value, '{color.blue}')
    assert.deepEqual([t['space.md'].type, t['space.md'].value], ['dimension', '16px'])
    assert.equal(t['weight.bold'].type, 'fontWeight')
    assert.ok(notes.some((n) => /flag\/beta is a boolean variable, which has no design token/.test(n)))
    // A code syntax names the CSS variable; one variable takes it, the one named like it.
    assert.equal(t.surface.cssVar, '--surface')
    assert.equal(t['band.surface'].cssVar, null)
    assert.ok(notes.some((n) => /band\/surface also names --surface in its code syntax; only surface takes it/.test(n)))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
