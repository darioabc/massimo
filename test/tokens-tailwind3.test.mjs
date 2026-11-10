// Wiring into Tailwind 3: the tailwind3 output never changes what one of
// Tailwind's own utilities renders. A step of Tailwind's type scale gets its
// size and Tailwind 3's own line height (or a source's), never a weight or
// letter spacing; a step a size token writes gets that size and the parts a
// source sets for it, which extract keeps from a config's [size, line-height]
// pair. In a Tailwind 3 project each opaque colour takes <alpha-value> over
// channels the css output writes, so opacity modifiers keep working. A family
// list that holds var() stays a list.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseColor } from '../scripts/lib/color.mjs'
import { SCRIPTS, read, readJson } from './helpers.mjs'

function repo(files, config) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-tailwind3-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body))
  }
  writeFileSync(join(root, 'massimo.config.json'), JSON.stringify(config))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const tokens = (root, ...args) => spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), ...args, '--root', root], { encoding: 'utf8' })
const exported = (root, path) => new Function('module', `${read(root, path)}; return module.exports`)({ exports: {} })

// The custom properties one block of a stylesheet declares, by name.
function declared(css, selector) {
  const at = css.indexOf(`${selector} {`)
  if (at < 0) return {}
  const body = css.slice(at, css.indexOf('\n}', at))
  return Object.fromEntries([...body.matchAll(/^\s*(--[\w-]+): (.+);$/gm)].map((m) => [m[1], m[2]]))
}
// A value with every var() replaced by what the declarations give it.
function resolve(value, vars) {
  let out = value
  for (let i = 0; i < 16 && /var\(--[\w-]+\)/.test(out); i++) out = out.replace(/var\((--[\w-]+)\)/g, (_, name) => vars[name] ?? `var(${name})`)
  return out
}

const MARK = { $extensions: { massimo: { format: 2 } } }
const rem = (value) => ({ value, unit: 'rem' })
const hex = (h) => ({ colorSpace: 'srgb', components: [1, 3, 5].map((i) => Number((parseInt(h.slice(i, i + 2), 16) / 255).toFixed(4))), hex: h })
const resolver = {
  version: '2025.10',
  name: 'Design tokens',
  sets: { base: { sources: [{ $ref: 'base.tokens.json' }] } },
  modifiers: { theme: { contexts: { light: [], dark: [{ $ref: 'theme/dark.tokens.json' }] }, default: 'light' } },
  resolutionOrder: [{ $ref: '#/sets/base' }, { $ref: '#/modifiers/theme' }],
}
const tailwind3 = (extra = {}) => ({
  styling: ['tailwind3'],
  tokens: {
    source: 'tokens/tokens.resolver.json',
    darkSelector: '.dark',
    darkMedia: false,
    outputs: [{ format: 'css', path: 'src/tokens.css' }, { format: 'tailwind3', path: 'tokens.tailwind.cjs' }],
    ...extra,
  },
})

const typeSet = {
  ...MARK,
  font: {
    sans: { $type: 'fontFamily', $value: ['Inter', 'sans-serif'] },
    size: { $type: 'dimension', xs: { $value: rem(0.75) }, sm: { $value: rem(0.875) }, lg: { $value: rem(1.125) }, '2xl': { $value: rem(1.5) }, '10': { $value: rem(0.625) } },
    weight: { $type: 'fontWeight', regular: { $value: 400 }, semibold: { $value: 600 } },
  },
  text: { $type: 'dimension', tiny: { $value: rem(0.5) }, 'tiny--line-height': { $type: 'number', $value: 1.2 } },
  typography: {
    $type: 'typography',
    xs: { $value: { fontFamily: '{font.sans}', fontSize: '{font.size.xs}', fontWeight: '{font.weight.regular}', lineHeight: 1.3333, letterSpacing: { value: 0, unit: 'px' } } },
    '2xl': { $value: { fontFamily: '{font.sans}', fontSize: '{font.size.2xl}', fontWeight: '{font.weight.semibold}', lineHeight: 1.3333, letterSpacing: { value: 0, unit: 'px' } } },
    // Not Tailwind's line height for text-lg: the class keeps Tailwind's.
    lg: { $value: { fontFamily: '{font.sans}', fontSize: '{font.size.lg}', fontWeight: 400, lineHeight: 1.5, letterSpacing: { value: 0, unit: 'px' } } },
    // A size token already writes text-10 and text-tiny: the composites add nothing.
    '10': { $value: { fontFamily: '{font.sans}', fontSize: '{font.size.10}', fontWeight: 400, lineHeight: 1.625, letterSpacing: { value: 0, unit: 'px' } } },
    tiny: { $value: { fontFamily: '{font.sans}', fontSize: '{text.tiny}', fontWeight: 400, lineHeight: 1.5, letterSpacing: { value: 0, unit: 'px' } } },
    // A step of the design's own that no size token writes keeps every part.
    lead: { $value: { fontFamily: '{font.sans}', fontSize: '{font.size.lg}', fontWeight: 500, lineHeight: 1.6, letterSpacing: { value: -0.2, unit: 'px' } } },
  },
}

test("Tailwind's own text-* steps keep Tailwind 3's line height and take no weight or letter spacing; a composite adds nothing to a step a size token writes", () => {
  const r = repo({ 'tokens/tokens.resolver.json': resolver, 'tokens/base.tokens.json': typeSet, 'tokens/theme/dark.tokens.json': {} }, tailwind3())
  try {
    const build = tokens(r.root, 'build')
    assert.equal(build.status, 0, build.stderr)
    const { fontSize } = exported(r.root, 'tokens.tailwind.cjs')
    assert.deepEqual(fontSize.xs, ['var(--typography-xs-font-size)', { lineHeight: '1rem' }])
    assert.deepEqual(fontSize['2xl'], ['var(--typography-2xl-font-size)', { lineHeight: '2rem' }])
    assert.deepEqual(fontSize.lg, ['var(--typography-lg-font-size)', { lineHeight: '1.75rem' }])
    // A size token alone on one of Tailwind's steps keeps Tailwind's line height too.
    assert.deepEqual(fontSize.sm, ['var(--font-size-sm)', { lineHeight: '1.25rem' }])
    assert.equal(fontSize['10'], 'var(--font-size-10)')
    // A source's own part goes inside its step's pair, never under a key of its own.
    assert.deepEqual(fontSize.tiny, ['var(--text-tiny)', { lineHeight: 'var(--text-tiny--line-height)' }])
    assert.equal(fontSize['tiny--line-height'], undefined)
    assert.deepEqual(fontSize.lead, ['var(--typography-lead-font-size)', { fontWeight: 'var(--typography-lead-font-weight)', lineHeight: 'var(--typography-lead-line-height)', letterSpacing: 'var(--typography-lead-letter-spacing)' }])
  } finally {
    r.cleanup()
  }
})

test("a project not on Tailwind 3 keeps a lone size token on one of Tailwind's steps as it was", () => {
  const r = repo({ 'tokens/tokens.resolver.json': resolver, 'tokens/base.tokens.json': typeSet, 'tokens/theme/dark.tokens.json': {} }, { ...tailwind3(), styling: ['tailwind4'] })
  try {
    const build = tokens(r.root, 'build')
    assert.equal(build.status, 0, build.stderr)
    const { fontSize } = exported(r.root, 'tokens.tailwind.cjs')
    assert.equal(fontSize.sm, 'var(--font-size-sm)')
    assert.deepEqual(fontSize.xs, ['var(--typography-xs-font-size)', { lineHeight: '1rem' }])
  } finally {
    r.cleanup()
  }
})

const colourSet = {
  ...MARK,
  color: {
    $type: 'color',
    brand: { '500': { $value: hex('#6366f1') } },
    surface: { '900': { $value: hex('#0f0f23') } },
    page: { $value: '{color.surface.900}' },
    veil: { $value: { colorSpace: 'srgb', components: [1, 1, 1], alpha: 0.1 } },
    sky: { $value: { colorSpace: 'oklch', components: [0.7, 0.2, 250] } },
    // A channel triplet, as a stylesheet keeps it for rgb(var(--x) / <alpha-value>).
    paper: { $value: hex('#fafaf7'), $extensions: { massimo: { css: '250 250 247', cssVar: '--rgb-paper' } } },
    card: { $value: '{color.paper}' },
  },
  opacity: { $type: 'number', '50': { $value: 0.5 } },
}
const colourDark = { color: { $type: 'color', surface: { '900': { $value: hex('#000000') } }, page: { $value: '{color.brand.500}' } } }

test('in a Tailwind 3 project each opaque colour takes <alpha-value> over channels the css output writes, in every theme, so an opacity modifier keeps working', () => {
  const r = repo({ 'tokens/tokens.resolver.json': resolver, 'tokens/base.tokens.json': colourSet, 'tokens/theme/dark.tokens.json': colourDark }, tailwind3())
  try {
    const build = tokens(r.root, 'build')
    assert.equal(build.status, 0, build.stderr)
    const { colors, opacity } = exported(r.root, 'tokens.tailwind.cjs')
    assert.equal(colors.brand['500'], 'rgb(var(--color-brand-500-rgb) / <alpha-value>)')
    assert.equal(colors.page, 'rgb(var(--color-page-rgb) / <alpha-value>)')
    assert.equal(colors.paper, 'rgb(var(--rgb-paper) / <alpha-value>)')
    assert.equal(colors.card, 'rgb(var(--color-card) / <alpha-value>)')
    // A translucent colour and one outside sRGB have no channels to give.
    assert.equal(colors.veil, 'var(--color-veil)')
    assert.equal(colors.sky, 'var(--color-sky)')
    const css = read(r.root, 'src', 'tokens.css')
    const root = declared(css, ':root')
    const dark = { ...root, ...declared(css, '.dark') }
    assert.equal(root['--color-brand-500-rgb'], '99 102 241')
    assert.equal(root['--color-page-rgb'], 'var(--color-surface-900-rgb)')
    assert.equal(declared(css, '.dark')['--color-surface-900-rgb'], '0 0 0')
    assert.equal(declared(css, '.dark')['--color-page-rgb'], 'var(--color-brand-500-rgb)')
    assert.doesNotMatch(css, /--color-(?:veil|sky|paper|card)-rgb|--rgb-paper-rgb/)
    // bg-page/50: Tailwind 3 puts the opacity where <alpha-value> is.
    for (const [vars, page] of [[root, '#0f0f23'], [dark, '#6366f1']]) {
      for (const name of ['page', 'card', 'brand']) {
        const colour = name === 'brand' ? colors.brand['500'] : colors[name]
        const own = parseColor(resolve(name === 'page' ? 'var(--color-page)' : name === 'card' ? 'var(--color-card)' : 'var(--color-brand-500)', vars).replace(/^(\d+ \d+ \d+)$/, 'rgb($1)'))
        const modified = parseColor(resolve(colour.replace('<alpha-value>', opacity['50']), vars))
        assert.deepEqual({ ...modified, a: Number(modified.a.toFixed(4)) }, { ...own, a: 0.5 }, `${name} at 50%`)
      }
      assert.equal(parseColor(resolve('var(--color-page)', vars)).r, parseColor(page).r)
    }
    assert.match(read(r.root, 'tokens.tailwind.cjs'), /\/\/ Spread it at the top of the config's theme\.extend: theme: \{ extend: \{ \.\.\.require\('\.\/tokens\.tailwind\.cjs'\), \/\* the config's other keys \*\/ \} \}\n\/\/ Colours written with <alpha-value> take opacity modifiers \(bg-primary\/50\); a colour written as var\(\) takes none\./)
  } finally {
    r.cleanup()
  }
})

test('a project not on Tailwind 3 writes its colours as before, and one with no css output gives <alpha-value> only to a variable that holds channels', () => {
  for (const config of [{ ...tailwind3(), styling: ['tailwind4'] }, tailwind3({ outputs: [{ format: 'tailwind3', path: 'tokens.tailwind.cjs' }] })]) {
    const r = repo({ 'tokens/tokens.resolver.json': resolver, 'tokens/base.tokens.json': colourSet, 'tokens/theme/dark.tokens.json': colourDark }, config)
    try {
      const build = tokens(r.root, 'build')
      assert.equal(build.status, 0, build.stderr)
      const { colors } = exported(r.root, 'tokens.tailwind.cjs')
      assert.equal(colors.brand['500'], 'var(--color-brand-500)')
      if (config.styling.includes('tailwind4')) {
        assert.equal(colors.paper, 'var(--rgb-paper)')
        assert.doesNotMatch(read(r.root, 'src', 'tokens.css'), /-rgb:/)
        assert.match(read(r.root, 'tokens.tailwind.cjs'), /\/\/ Use it as: module\.exports = \{ theme: \{ extend: require\('\.\/tokens\.tailwind\.cjs'\) \} \}/)
      } else {
        // A variable that already holds channels needs no css output.
        assert.equal(colors.paper, 'rgb(var(--rgb-paper) / <alpha-value>)')
      }
    } finally {
      r.cleanup()
    }
  }
})

test('a font family list that holds var() is written as a list, so the family it names still applies', () => {
  const r = repo(
    {
      'tokens/tokens.resolver.json': resolver,
      'tokens/base.tokens.json': { ...MARK, font: { $type: 'fontFamily', primary: { $value: ['var(--app-font-primary)', 'sans-serif'] }, display: { $value: ['Space Grotesk', 'var(--app-font-primary)', 'serif'] } } },
      'tokens/theme/dark.tokens.json': {},
    },
    tailwind3(),
  )
  try {
    const build = tokens(r.root, 'build')
    assert.equal(build.status, 0, build.stderr)
    const root = declared(read(r.root, 'src', 'tokens.css'), ':root')
    assert.equal(root['--font-primary'], 'var(--app-font-primary), sans-serif')
    assert.equal(root['--font-display'], '"Space Grotesk", var(--app-font-primary), serif')
    // font-primary renders the list a config's ['var(--app-font-primary)', 'sans-serif'] gives.
    assert.equal(resolve(exported(r.root, 'tokens.tailwind.cjs').fontFamily.primary, root), ['var(--app-font-primary)', 'sans-serif'].join(', '))
  } finally {
    r.cleanup()
  }
})

test("extract keeps a Tailwind 3 config's own [size, line-height] steps, and the outputs write each with the line height the config gives it", () => {
  const r = repo(
    {
      'src/styles.css': ':root {\n  --app-step-1: var(--app-scale-5);\n  --app-body-size: 1rem;\n  --app-heading-leading: 2.5rem;\n}\n',
      'tailwind.config.js': `module.exports = { theme: { extend: {
        fontFamily: { sans: ['Inter', 'sans-serif'] },
        fontSize: {
          micro: ['8px', '1.25'],
          'heading-1': ['var(--app-step-1)', 'var(--app-heading-leading)'],
          'body-1': ['var(--app-body-size)', { lineHeight: '1.5rem', letterSpacing: '-0.01em' }],
        },
      } } }`,
      'src/page.tsx': 'export const P = () => <div className="font-sans text-micro"><h1 className="text-heading-1">a</h1><p className="text-body-1">b</p></div>\n',
      'package.json': '{"name":"acme"}',
    },
    {
      styling: ['tailwind3'],
      tokens: {
        styleFiles: ['src/styles.css'],
        tailwindConfig: 'tailwind.config.js',
        source: 'design-system/tokens/draft/tokens.resolver.json',
        outputs: [{ format: 'css', path: 'src/tokens.css' }, { format: 'tailwind3', path: 'tokens.tailwind.cjs' }],
      },
    },
  )
  try {
    const out = tokens(r.root, 'extract')
    assert.equal(out.status, 0, out.stderr)
    const report = read(r.root, 'design-system', 'tokens', 'draft', 'report.md')
    assert.match(report, /\| `text\.heading-1--line-height` \| var\(--app-heading-leading\) \| tailwind\.config\.js \| the line height the config gives text-heading-1 \|/)
    assert.match(report, /\| `text\.body-1--letter-spacing` \| -0\.01em \| tailwind\.config\.js \| the letter spacing the config gives text-body-1 \|/)
    const build = tokens(r.root, 'build')
    assert.equal(build.status, 0, build.stderr)
    const { fontSize } = exported(r.root, 'tokens.tailwind.cjs')
    assert.deepEqual(fontSize['heading-1'], ['var(--text-heading-1)', { lineHeight: 'var(--text-heading-1--line-height)' }])
    assert.deepEqual(fontSize.micro, ['var(--text-micro)', { lineHeight: 'var(--text-micro--line-height)' }])
    assert.deepEqual(fontSize['body-1'], ['var(--text-body-1)', { lineHeight: 'var(--text-body-1--line-height)', letterSpacing: 'var(--text-body-1--letter-spacing)' }])
    // Each part resolves to what the config wrote.
    const vars = { ...declared(read(r.root, 'src', 'styles.css'), ':root'), ...declared(read(r.root, 'src', 'tokens.css'), ':root') }
    assert.equal(resolve('var(--text-heading-1--line-height)', vars), '2.5rem')
    assert.equal(resolve('var(--text-micro--line-height)', vars), '1.25')
    assert.equal(resolve('var(--text-body-1--line-height)', vars), '1.5rem')
    assert.equal(resolve('var(--text-body-1--letter-spacing)', vars), '-0.01em')
    // The composite keeps the typed values for the rest of the system.
    assert.equal(readJson(r.root, 'design-system', 'tokens', 'draft', 'base.tokens.json').typography.micro.$value.lineHeight, 1.25)
  } finally {
    r.cleanup()
  }
})

test("the tokens skill says how to merge the tailwind3 output into a config's own theme.extend and how @nuxtjs/tailwindcss reads it", () => {
  const skill = read(SCRIPTS, '..', 'skills', 'tokens', 'SKILL.md')
  assert.match(skill, /spread the output at its top: `extend: \{ \.\.\.require\('\.\/tokens\.tailwind\.cjs'\)/)
  assert.match(skill, /name by name, remove from each hand-written section the keys the output writes, merge what is left into the output's section/)
  assert.match(skill, /Keep every section the output does not write, such as `screens`, `animation`, `keyframes` and `backgroundImage`/)
  assert.match(skill, /`@nuxtjs\/tailwindcss`, the module loads the app's own `tailwind\.config`/)
  assert.match(skill, /`rgb\(var\(--x-rgb\) \/ <alpha-value>\)`/)
})
