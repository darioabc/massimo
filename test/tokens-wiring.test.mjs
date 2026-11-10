// Wiring into Tailwind 4: extract reads @theme's colour wiring
// (`--color-primary: var(--primary)`) as wiring, not as tokens, and the
// tailwind4 output writes it again; the output never makes one of Tailwind's
// own text-* classes set a weight or letter spacing, and keeps a token whose
// own variable is a Tailwind theme name it has no section for.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SCRIPTS, read, readJson, run, withTokens } from './helpers.mjs'

function repo(files, config) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-wiring-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  writeFileSync(join(root, 'massimo.config.json'), JSON.stringify(config))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const tokens = (root, ...args) => spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), ...args, '--root', root], { encoding: 'utf8' })
const draft = (root, name) => join(root, 'design-system', 'tokens', 'draft', name)

const SHEET = [
  '@import "tailwindcss";',
  '@custom-variant dark (&:is(.dark *));',
  '@theme inline {',
  '  --color-background: var(--background);',
  '  --color-foreground: var(--foreground);',
  '  --color-primary: var(--primary);',
  '  --color-primary-foreground: var(--primary-foreground);',
  '  --color-accent: var(--accent);',
  '  --color-chart-1: var(--chart-1);',
  '  --color-brand: var(--primary);',
  '  --radius-lg: var(--radius);',
  '}',
  ':root {',
  '  --radius: 0.625rem;',
  '  --background: oklch(1 0 0);',
  '  --foreground: oklch(0.145 0 0);',
  '  --primary: oklch(0.205 0 0);',
  '  --primary-foreground: oklch(0.985 0 0);',
  '  --accent: oklch(0.97 0 0);',
  '  --chart-1: oklch(0.646 0.222 41.116);',
  '  --ring: var(--color-primary);',
  '}',
  '.dark {',
  '  --background: oklch(0.145 0 0);',
  '  --foreground: oklch(0.985 0 0);',
  '  --primary: oklch(0.922 0 0);',
  '  --primary-foreground: oklch(0.205 0 0);',
  '}',
  '',
].join('\n')

test('extract on a Tailwind 4 sheet that wires its colours in @theme proposes one colour group, each colour under its own variable, and the tailwind4 output wires them again', () => {
  const r = repo(
    { 'src/index.css': SHEET, 'package.json': '{"name":"acme"}' },
    {
      styling: ['tailwind4'],
      tokens: {
        styleFiles: ['src/index.css'],
        source: 'design-system/tokens/draft/tokens.resolver.json',
        darkSelector: '.dark',
        darkMedia: false,
        outputs: [{ format: 'css', path: 'src/tokens.css' }, { format: 'tailwind4', path: 'src/tokens.theme.css' }],
      },
    },
  )
  try {
    const out = tokens(r.root, 'extract')
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(draft(r.root, 'base.tokens.json'))
    const colors = Object.keys(base.color).filter((k) => !k.startsWith('$')).sort()
    // No color.color-* aliases and nothing under other: the wiring is not a token.
    assert.deepEqual(colors, ['accent', 'background', 'brand', 'chart-1', 'foreground', 'primary', 'primary-foreground', 'ring'])
    assert.equal(base.other, undefined)
    for (const name of ['accent', 'background', 'chart-1', 'foreground', 'primary', 'primary-foreground']) {
      assert.equal(base.color[name].$extensions.massimo.cssVar, `--${name}`, name)
      assert.ok(base.color[name].$value.colorSpace, name) // the colour itself, not a reference
    }
    // A mapping onto another name is a token of its own, and a var() of the wiring follows the colour.
    assert.equal(base.color.brand.$value, '{color.primary}')
    assert.equal(base.color.ring.$value, '{color.primary}')
    assert.equal(base.radius.lg.$value, '{radius.base}')
    const dark = readJson(draft(r.root, 'theme/dark.tokens.json'))
    assert.ok(dark.color.primary.$value.colorSpace)
    const report = read(draft(r.root, 'report.md'))
    assert.match(report, /src\/index\.css maps 6 colours in @theme to the variables that hold them, such as --color-accent: var\(--accent\)\. Those lines are Tailwind's wiring, not tokens of their own/)
    assert.doesNotMatch(report, /color\.color-|other\./)
    assert.match(report, /\| `color\.foreground` .*contrast checked as text on color\.background/)

    const build = tokens(r.root, 'build')
    assert.equal(build.status, 0, build.stderr)
    const theme = read(r.root, 'src', 'tokens.theme.css')
    for (const name of ['background', 'foreground', 'primary', 'primary-foreground', 'accent', 'chart-1']) assert.match(theme, new RegExp(`--color-${name}: var\\(--${name}\\);`), name)
    assert.doesNotMatch(theme, /--color-color-|--color-other-/)
    const css = read(r.root, 'src', 'tokens.css')
    assert.match(css, /:root \{[\s\S]*--primary: oklch\(0\.205 0 0\);[\s\S]*\.dark \{[\s\S]*--primary: oklch\(0\.922 0 0\);/)
  } finally {
    r.cleanup()
  }
})

test('without Tailwind 4 in styling, the @theme lines stay tokens as before', () => {
  const r = repo({ 'src/index.css': SHEET, 'package.json': '{"name":"acme"}' }, { tokens: { styleFiles: ['src/index.css'] } })
  try {
    const out = tokens(r.root, 'extract')
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(draft(r.root, 'base.tokens.json'))
    assert.equal(base.color['color-accent'].$value, '{color.accent}')
    assert.doesNotMatch(read(draft(r.root, 'report.md')), /Tailwind's wiring/)
  } finally {
    r.cleanup()
  }
})

const typeDoc = {
  font: {
    sans: { $type: 'fontFamily', $value: ['Inter', 'sans-serif'] },
    size: {
      $type: 'dimension',
      sm: { $value: { value: 0.875, unit: 'rem' } },
      lg: { $value: { value: 1.125, unit: 'rem' } },
      '2xl': { $value: { value: 1.5, unit: 'rem' } },
    },
    weight: { $type: 'fontWeight', bold: { $value: 700 } },
  },
  typography: {
    $type: 'typography',
    // Tailwind's own steps: Tailwind's line heights for sm and 2xl, another one for lg.
    sm: { $value: { fontFamily: '{font.sans}', fontSize: '{font.size.sm}', fontWeight: 400, lineHeight: 1.4286, letterSpacing: { value: 0, unit: 'px' } } },
    lg: { $value: { fontFamily: '{font.sans}', fontSize: '{font.size.lg}', fontWeight: 400, lineHeight: 1.5, letterSpacing: { value: 0, unit: 'px' } } },
    '2xl': { $value: { fontFamily: '{font.sans}', fontSize: '{font.size.2xl}', fontWeight: '{font.weight.bold}', lineHeight: 1.3333, letterSpacing: { value: 0, unit: 'px' } } },
    // A step of the design's own keeps every part.
    lead: { $value: { fontFamily: '{font.sans}', fontSize: '{font.size.lg}', fontWeight: 500, lineHeight: 1.6, letterSpacing: { value: -0.2, unit: 'px' } } },
  },
  $extensions: {
    massimo: {
      cssOnly: {
        'other.animate-wiggle': { css: 'wiggle 1s ease-in-out infinite', cssVar: '--animate-wiggle' },
        'other.tracking-snug': { css: '-0.01em', cssVar: '--tracking-snug' },
        'other.breakpoint-xs': { css: '30rem', cssVar: '--breakpoint-xs' },
        'other.flag': { css: '1', cssVar: '--flag' },
      },
    },
  },
}

test("the tailwind4 output keeps Tailwind's own text-* classes as they render: no weight or letter spacing, and a line height only when it is Tailwind's", () => {
  const t = withTokens(typeDoc)
  try {
    const r = run('tokens', t, ['build'])
    assert.equal(r.status, 0, r.stderr)
    const tw4 = read(t.root, 'src', 'styles', 'tokens.tailwind.css')
    assert.match(tw4, /--text-sm: var\(--typography-sm-font-size\);\n\s*--text-sm--line-height: var\(--typography-sm-line-height\);/)
    assert.match(tw4, /--text-2xl--line-height: var\(--typography-2xl-line-height\);/)
    assert.match(tw4, /--text-lg: var\(--typography-lg-font-size\);/)
    assert.doesNotMatch(tw4, /--text-lg--line-height/) // 1.5 is not Tailwind's 1.5556
    assert.doesNotMatch(tw4, /--text-(?:sm|lg|2xl)--(?:font-weight|letter-spacing)/)
    // The design's own step is no class of Tailwind's, so it keeps every part.
    for (const part of ['line-height', 'letter-spacing', 'font-weight']) assert.match(tw4, new RegExp(`--text-lead--${part}: var\\(--typography-lead-${part}\\);`))
    // Tailwind 3's fontSize keeps its parts, as before.
    const exported = new Function('module', `${read(t.root, 'src', 'styles', 'tokens.tailwind.cjs')}; return module.exports`)({ exports: {} })
    assert.equal(exported.fontSize['2xl'][1].fontWeight, 'var(--typography-2xl-font-weight)')
  } finally {
    t.cleanup()
  }
})

test('the tailwind4 output keeps a token whose own variable is a Tailwind theme name with no section of its own, so wiring keeps its utility', () => {
  const t = withTokens(typeDoc)
  try {
    const r = run('tokens', t, ['build'])
    assert.equal(r.status, 0, r.stderr)
    const tw4 = read(t.root, 'src', 'styles', 'tokens.tailwind.css')
    assert.match(tw4, /--animate-wiggle: var\(--animate-wiggle\);/)
    assert.match(tw4, /--tracking-snug: var\(--tracking-snug\);/)
    // A breakpoint is read at build time, where a var() does not work, and a name outside Tailwind's theme is no utility.
    assert.doesNotMatch(tw4, /--breakpoint-xs|--flag/)
    assert.match(read(t.root, 'src', 'styles', 'tokens.generated.css'), /--animate-wiggle: wiggle 1s ease-in-out infinite;/)
  } finally {
    t.cleanup()
  }
})
