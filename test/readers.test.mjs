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
  assert.deepEqual([t['color.text'].modes.dark, t['color.text'].cssModes.dark], ['rgb(236 229 209 / 0.88)', 'rgb(var(--sand-200) / 0.88)'])
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
  assert.ok(notes.includes('--c-text is also set inside .band-block, html.dark .band-block; its token holds the page\'s value'), notes.join('\n'))
  assert.ok(notes.includes("--gap is also set under @media (max-width: 60rem) :root; its token holds the value outside that, and massimo's outputs do not write the override"), notes.join('\n'))
})

test('CSS: light and dark by media query, and a token set only under a condition takes that value', () => {
  const { tokens, notes } = readCss(dir, ['conditions.css'])
  const t = byPath(tokens)
  assert.deepEqual([t['color.bg'].value, t['color.bg'].modes.dark], ['#ffffff', '#000000'])
  assert.deepEqual([t['color.brand'].value, t['color.brand'].modes.dark], ['#0055ff', '#88aaff'])
  assert.equal(t['duration.base'].value, '200ms')
  assert.ok(notes.includes('--brand is set only under @supports (--css: variables); its token takes that value'), notes.join('\n'))
  assert.ok(notes.includes('--duration-base is set only under @media (prefers-reduced-motion: no-preference); its token takes that value'))
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

test('a theme module: a theme call with a selector before its object, every exported palette, and the objects not read named', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'massimo-theme-'))
  try {
    writeFileSync(join(tmp, 'themes.css.ts'), [
      "import { createGlobalTheme } from '@vanilla-extract/css'",
      "import { vars } from './contract.css'",
      "createGlobalTheme(':root', vars, {",
      "  color: { brand: '#ff8800', text: '#111111' },",
      "  radius: { sm: '4px' },",
      '})',
      'createGlobalTheme(\'[data-theme="dark"]\', vars, {',
      "  color: { brand: '#ffaa33', text: '#eeeeee' },",
      '})',
      '',
    ].join('\n'))
    const themes = readThemeObject(tmp, 'themes.css.ts')
    const t = byPath(themes.tokens)
    assert.equal(t['color.brand'].value, '#ff8800')
    assert.equal(t['radius.sm'].value, '4px')
    assert.ok(themes.notes.includes(`themes.css.ts: read createGlobalTheme(':root', vars, {…}); createGlobalTheme('[data-theme="dark"]', vars, {…}) is another object, which was not read`), themes.notes.join('\n'))

    writeFileSync(join(tmp, 'colors.ts'), [
      "export const color = { black: '#101010', gray50: '#fafafa' } as const",
      "export const accentColor = { default: '#ff9900' } as const",
      "export const themeLight: ThemeSet = { primary: '#2255ff' }",
      "export const themeDark: ThemeSet = { primary: '#88aaff' }",
      '',
    ].join('\n'))
    const colors = readThemeObject(tmp, 'colors.ts')
    const c = byPath(colors.tokens)
    assert.equal(c['color.black'].value, '#101010')
    assert.equal(c['color.gray50'].value, '#fafafa')
    assert.equal(c['other.primary'].value, '#2255ff')
    assert.ok(colors.notes.includes('colors.ts: read themeLight; themeDark, accentColor are other objects, which were not read'), colors.notes.join('\n'))

    // An object exported under another name is never the theme: breakpoints get their note, anything else is named.
    writeFileSync(join(tmp, 'screens.ts'), "export const breakpoints = { sm: '640px', md: '768px' }\nexport const colors = { brand: '#ff0000' }\n")
    const screens = readThemeObject(tmp, 'screens.ts')
    assert.deepEqual(screens.tokens.map((x) => [x.path.join('.'), x.value]), [['color.brand', '#ff0000']])
    assert.deepEqual(screens.notes, ['screens.ts: breakpoints are breakpoints, which massimo does not read as tokens'])
    writeFileSync(join(tmp, 'setup.ts'), "export const config = { prefix: 'acme', cssVarRoot: ':root' }\nexport const colors = { brand: '#ff0000' }\n")
    const setup = readThemeObject(tmp, 'setup.ts')
    assert.deepEqual(setup.tokens.map((x) => [x.path.join('.'), x.value]), [['color.brand', '#ff0000']])
    assert.deepEqual(setup.notes, ['setup.ts: read the exports named like theme keys; config is another object, which was not read'])
    writeFileSync(join(tmp, 'options.ts'), "export const config = { prefix: 'acme' }\n")
    assert.deepEqual(readThemeObject(tmp, 'options.ts'), { tokens: [], notes: ['options.ts: no theme object found to read; config is not named like a theme or a part of one, so it was not read'] })
    // A selector in backticks, with nothing interpolated, is a leading argument like a quoted one.
    writeFileSync(join(tmp, 'global.css.ts'), "createGlobalTheme(`:root`, vars, { color: { brand: '#ff8800' } })\n")
    assert.equal(byPath(readThemeObject(tmp, 'global.css.ts').tokens)['color.brand'].value, '#ff8800')

    // A contract's strings are CSS variable names; the theme beside it holds the values.
    writeFileSync(join(tmp, 'contract.css.ts'), "export const vars = createGlobalThemeContract({ color: { brand: 'color-brand' } })\n")
    assert.deepEqual(readThemeObject(tmp, 'contract.css.ts'), { tokens: [], notes: ['contract.css.ts: a theme contract names CSS variables, not values, so it was not read'] })
    writeFileSync(join(tmp, 'theme.css.ts'), "export const vars = createThemeContract({ color: { brand: null } })\nexport const light = createTheme(vars, { color: { brand: '#0055ff' } })\n")
    assert.equal(byPath(readThemeObject(tmp, 'theme.css.ts').tokens)['color.brand'].value, '#0055ff')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('the object reader never runs code and stops at what it cannot read', () => {
  const src = "module.exports = { a: 'x', b: [1, 'two', { c: true }], d: fn(1, { e: 2 }), 'f-g': `h`, i: `${j}`, ...k, l() { return 1 } }"
  const obj = findObject(src, [/module\.exports\s*=\s*/])
  assert.deepEqual(JSON.parse(JSON.stringify(obj)), { a: 'x', b: [1, 'two', { c: true }], d: { expr: 'fn(1, { e: 2 })' }, 'f-g': 'h', i: { expr: '`${j}`' }, l: { expr: 'l()' } })
  // A minus or a dot before something other than a digit is not a number.
  assert.deepEqual(findObject('export default { n: -.5, m: -2 }\nconst KEY = /^sb-.+-token$/', [/export default\s*/]), { n: -0.5, m: -2 })
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

// A scratch folder of style files, for a reader test that needs its own.
function sheets(files) {
  const base = mkdtempSync(join(tmpdir(), 'massimo-readers-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(base, name), text)
  return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('CSS: a dark :root keeps its values as the default when a light-theme block sets others, and the light values are noted', () => {
  const s = sheets({
    'docs.css': [
      ':root { --backdrop: #272727cc; --accent: #ff801f; --same: #111111; }',
      ":root[data-theme='light'] { --backdrop: #f6f6f699; --accent: #b73d00; --same: #111111; --only-light: #ffffff; }",
      '[data-theme="light"] { --accent: #c04000; }',
    ].join('\n'),
  })
  try {
    const { tokens, notes } = readCss(s.base, ['docs.css'])
    const t = byPath(tokens)
    assert.deepEqual([t['color.backdrop'].value, t['color.accent'].value, t['color.same'].value, t['color.only-light'].value], ['#272727cc', '#ff801f', '#111111', '#ffffff'])
    assert.deepEqual(notes, [
      "--accent and --backdrop are set under :root in docs.css and, differently, under :root[data-theme='light'] in docs.css, which massimo reads as the same default theme; the tokens keep the values under :root in docs.css",
      '--accent is set under :root in docs.css and, differently, under [data-theme="light"] in docs.css, which massimo reads as the same default theme; its token keeps the value under :root in docs.css',
    ])
  } finally {
    s.cleanup()
  }
})

test('CSS: two files that set one property differently: the first keeps its value and its source, the other is noted; one selector again in one file is the cascade', () => {
  const s = sheets({
    'a.css': ':root { --accent: #ff801f; --gap: 1rem; }\n.dark { --accent: #ffa057; --ink: #000000; }\n:root { --gap: 2rem; }',
    'b.css': ':root { --accent: #f76b15; --gap: 2rem; --ink: #ffffff; }\n.dark { --accent: #ffffff; }',
  })
  try {
    const { tokens, notes } = readCss(s.base, ['a.css', 'b.css'])
    const t = byPath(tokens)
    assert.deepEqual([t['color.accent'].value, t['color.accent'].modes.dark, t['color.accent'].source], ['#ff801f', '#ffa057', 'a.css'])
    assert.equal(t['spacing.base'].value, '2rem') // the later :root in a.css, which b.css repeats
    // A token's source is the file its default value comes from.
    assert.deepEqual([t['color.ink'].value, t['color.ink'].modes.dark, t['color.ink'].source], ['#ffffff', '#000000', 'b.css'])
    assert.deepEqual(notes, [
      '--accent is set under :root in a.css and, differently, under :root in b.css, which massimo reads as the same default theme; its token keeps the value under :root in a.css',
      '--accent is set under .dark in a.css and, differently, under .dark in b.css, which massimo reads as the same dark theme; its token keeps the value under .dark in a.css',
    ])
  } finally {
    s.cleanup()
  }
})

test('CSS: a light-theme block before :root gives way to it, since :root is the default theme, and its values are noted', () => {
  const s = sheets({
    'docs.css': [
      "[data-theme='light'] { --backdrop: #f6f6f699; --accent: #b73d00; --only-light: #ffffff; }",
      ':root { --backdrop: #272727cc; --accent: #ff801f; }',
      '.light { --accent: #c04000; }',
      ':root { --accent: #ff9933; }',
    ].join('\n'),
  })
  try {
    const { tokens, notes } = readCss(s.base, ['docs.css'])
    const t = byPath(tokens)
    // The later :root replaces the earlier one in the same file, as the cascade does.
    assert.deepEqual([t['color.backdrop'].value, t['color.accent'].value, t['color.only-light'].value], ['#272727cc', '#ff9933', '#ffffff'])
    assert.deepEqual(notes, [
      "--accent and --backdrop are set under :root in docs.css and, differently, under [data-theme='light'] in docs.css, which massimo reads as the same default theme; the tokens keep the values under :root in docs.css",
      '--accent is set under :root in docs.css and, differently, under .light in docs.css, which massimo reads as the same default theme; its token keeps the value under :root in docs.css',
    ])
  } finally {
    s.cleanup()
  }
})

test('CSS: two files whose light-dark() values differ in their dark side keep the first, with a note', () => {
  const s = sheets({
    'a.css': ':root { --bg: light-dark(#ffffff, #111111); }',
    'b.css': ':root { --bg: light-dark(#ffffff, #222222); }',
  })
  try {
    const { tokens, notes } = readCss(s.base, ['a.css', 'b.css'])
    const t = byPath(tokens)
    assert.deepEqual([t['color.bg'].value, t['color.bg'].modes.dark], ['#ffffff', '#111111'])
    assert.deepEqual(notes, ['--bg is set under :root in a.css and, differently, under :root in b.css, which massimo reads as the same dark theme; its token keeps the value under :root in a.css'])
  } finally {
    s.cleanup()
  }
})

test('CSS: the dark side of light-dark() gives way to a dark theme value, before or after it, with no note', () => {
  const s = sheets({ 'a.css': ':root { --bg: light-dark(#ffffff, #111111); }\n.dark { --bg: #000000; }\n.dark { --fg: #eeeeee; }\n:root { --fg: light-dark(#111111, #fafafa); }' })
  try {
    const { tokens, notes } = readCss(s.base, ['a.css'])
    const t = byPath(tokens)
    assert.deepEqual([t['color.bg'].value, t['color.bg'].modes.dark, t['color.fg'].value, t['color.fg'].modes.dark], ['#ffffff', '#000000', '#111111', '#eeeeee'])
    assert.deepEqual(notes, [])
  } finally {
    s.cleanup()
  }
})

test('Tokens Studio in the W3C form: $value, $type and $description make a token, a composite included', () => {
  const doc = {
    'primitive/color': { color: { black: { $type: 'color', $value: '#000000', $description: 'Ink' } } },
    'primitive/typography': {
      typography: { body: { $type: 'typography', $value: { fontFamily: 'Inter', fontSize: '16px', fontWeight: '400', lineHeight: '1.5' } } },
    },
    $themes: [],
    $metadata: { tokenSetOrder: ['primitive/color', 'primitive/typography'] },
  }
  assert.equal(isTokensStudio(doc), true)
  const out = fromTokensStudio(doc, [], 'tokens.json')
  assert.deepEqual(out.color.black, { $value: '#000000', $type: 'color', $description: 'Ink' })
  assert.deepEqual(out.typography.body, { $value: { fontFamily: 'Inter', fontSize: '16px', fontWeight: '400', lineHeight: '1.5' }, $type: 'typography' })
  const shadow = fromTokensStudio({ $metadata: {}, s: { $value: { x: 0, y: 2, blur: 4, spread: 0, color: '#0003' }, $type: 'boxShadow' } })
  assert.deepEqual(shadow.s.$value, { color: '#0003', offsetX: '0px', offsetY: '2px', blur: '4px', spread: '0px' })
})

test('Tokens Studio: sets merge deeply in order, a later token replaces the earlier whole, and one that refers to its own path keeps the earlier token', () => {
  const doc = {
    'primitive/color': { color: { gray: { 900: { $type: 'color', $value: '#111111' } }, brand: { $type: 'color', $value: '#ff6600', $description: 'Old' } } },
    'primitive/typography': { typography: { fontFamily: { base: { $type: 'fontFamilies', $value: 'Inter, sans-serif' } } } },
    'semantic/color': { color: { background: { default: { $type: 'color', $value: '{color.gray.900}' } }, brand: { $type: 'color', $value: '#ee5500' } } },
    'semantic/typography': { typography: { fontFamily: { base: { $type: 'fontFamilies', $value: '{typography.fontFamily.base}', $description: 'Every UI text' } } } },
    $themes: [],
    $metadata: { tokenSetOrder: ['primitive/color', 'primitive/typography', 'semantic/color', 'semantic/typography'] },
  }
  const notes = []
  const out = fromTokensStudio(doc, notes, 'tokens/tokens.json')
  assert.deepEqual(out.color.gray[900], { $value: '#111111', $type: 'color' })
  assert.deepEqual(out.color.background.default, { $value: '{color.gray.900}', $type: 'color' })
  assert.deepEqual(out.color.brand, { $value: '#ee5500', $type: 'color' })
  assert.deepEqual(out.typography.fontFamily.base, { $value: 'Inter, sans-serif', $type: 'fontFamily', $description: 'Every UI text' })
  assert.deepEqual(notes, [
    "tokens/tokens.json: typography.fontFamily.base in semantic/typography refers to itself, which Tokens Studio reads as the same path in an earlier set; kept the earlier token, with this one's description",
  ])
})
