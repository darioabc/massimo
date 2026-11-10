// tokens.mjs extract: a full proposed set from what a repo already uses, its
// sources first and the code's own values for the gaps, with a report that
// says where each value came from and what was assumed.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { propose } from '../scripts/lib/propose.mjs'
import { SCRIPTS, read, readJson } from './helpers.mjs'

function repo(files, config) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-extract-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  writeFileSync(join(root, 'massimo.config.json'), JSON.stringify(config))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const extract = (root) => spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), 'extract', '--root', root], { encoding: 'utf8' })

test('a repo with raw values and no tokens: ramps, semantics, contrast, scales, type and motion from the code', () => {
  const css = [
    '.page { background: #fafafa; color: #171717; }',
    '.card { background: #fafafa; border: 1px solid #e5e5e5; color: #171717; padding: 16px; margin: 8px; border-radius: 8px; box-shadow: 0 1px 2px #0000001a; }',
    '.muted { color: #737373; font-size: 14px; line-height: 1.5; transition: opacity 150ms ease-out; }',
    '.title { font-size: 24px; font-weight: 700; padding: 16px; margin: 8px; border-radius: 8px; box-shadow: 0 1px 2px #0000001a; }',
    '.row { border: 1px solid #e5e5e5; gap: 12px; padding: 12px; font-size: 14px; color: #737373; z-index: 10; }',
    '.menu { z-index: 10; }',
    '.btn { background: #2563eb; color: #fafafa; font-size: 16px; font-size: 16px; font-weight: 400; transition: transform 300ms ease-out; background: #2563eb; }',
    '.odd { padding: 7px; }',
    'body, .hero { font-family: Inter, sans-serif; }',
    '.lead { font-family: Inter, sans-serif; transition: opacity 150ms ease-out; }',
    '.tip { transition: transform 300ms ease-out; }',
  ].join('\n')
  const r = repo({ 'src/app.css': css, 'package.json': '{"name":"acme"}' }, { tokens: { styleFiles: [] } })
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const dir = join(r.root, 'design-system', 'tokens', 'draft')
    const base = readJson(dir, 'base.tokens.json')
    const report = read(dir, 'report.md')
    // Ramps from the clusters, named by lightness.
    assert.deepEqual(Object.keys(base.color.neutral).filter((k) => !k.startsWith('$')).sort(), ['100', '50', '600', '950'])
    assert.equal(base.color.blue['600'].$value.hex, '#2563eb')
    assert.equal(base.color.overlay, undefined) // a shadow's colour stays in the shadow
    // Semantic colours from the roles, each with a description and a contrast pair.
    assert.equal(base.color.bg.default.$value, '{color.neutral.50}') // the neutral page, not the blue button
    assert.equal(base.color.accent.default.$value, '{color.blue.600}')
    assert.match(base.color.bg.default.$description, /^Background\. Used \d+× as a background, most in src\/app\.css\.$/)
    assert.equal(base.color.text.default.$value, '{color.neutral.950}')
    assert.deepEqual(base.color.text.default.$extensions.massimo.contrast, { on: 'color.bg.default', use: 'text' })
    assert.equal(base.color.border.default.$extensions?.massimo?.contrast, undefined) // a divider is not held to 3:1
    assert.match(report, /\| `color\.border\.default` .*contrast not checked; if this border identifies a control/)
    // Scales: spacing on the grid, radius, type sizes named around the body size.
    assert.deepEqual(Object.keys(base.spacing).filter((k) => !k.startsWith('$')).sort(), ['2', '3', '4'])
    assert.deepEqual(base.radius.sm.$value, { value: 0.5, unit: 'rem' })
    assert.deepEqual(Object.keys(base.font.size).filter((k) => !k.startsWith('$')).sort(), ['base', 'sm'])
    // Typography composites, with what was assumed said in the report.
    assert.deepEqual(base.typography.base.$value.fontSize, '{font.size.base}')
    assert.match(report, /\| `typography\.sm` \| 0\.875rem \/ 1\.5, weight 400 \| the size scale \| assumed line height 1\.5, the most used/)
    // The rest: shadow, border with its colour as a reference, motion, layers.
    assert.equal(base.shadow.$type, 'shadow')
    assert.equal(base.border.default.$value.color, '{color.neutral.100}')
    assert.deepEqual(base.duration.fast.$value, { value: 150, unit: 'ms' })
    assert.deepEqual(base.ease.standard.$value, [0, 0, 0.58, 1])
    assert.equal(base.z['10'].$value, 10)
    // A value used once is reported, not proposed.
    assert.match(report, /\| Spacing \| 7px \| 1 \| off the 4px grid \|/)
    assert.match(out.stdout, /from the code\), \d+ values not proposed/)
    // The draft passes the strict reader.
    const check = spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), 'build', '--root', r.root], {
      encoding: 'utf8',
      env: { ...process.env },
    })
    writeFileSync(join(r.root, 'massimo.config.json'), JSON.stringify({ tokens: { source: 'design-system/tokens/draft/tokens.resolver.json', outputs: [{ format: 'css', path: 'tokens.css' }] } }))
    const build = spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), 'build', '--root', r.root], { encoding: 'utf8' })
    assert.equal(build.status, 0, build.stderr)
    assert.match(read(r.root, 'tokens.css'), /--color-bg-default: var\(--color-neutral-50\);/)
    assert.ok(check)
  } finally {
    r.cleanup()
  }
})

test('sources come first: a Tailwind config and CSS variables, with references between them', () => {
  const r = repo(
    {
      'src/global.css': ':root { --rgb-base-100: 250 250 250; --rgb-base-content: 23 23 23; }\n',
      'tailwind.config.js': `module.exports = { theme: { extend: {
        colors: { base: { 100: 'rgb(var(--rgb-base-100) / <alpha-value>)', content: 'rgb(var(--rgb-base-content) / <alpha-value>)' } },
        fontFamily: { sans: ['Inter', 'sans-serif'] },
        fontSize: { body: ['1rem', { lineHeight: '1.5rem' }], title: ['2rem', '1.2'] },
      } } }`,
      'src/page.tsx': 'export const P = () => <div className="bg-base-100 text-base-content text-body" />\n',
    },
    { tokens: { styleFiles: ['src/global.css'], tailwindConfig: 'tailwind.config.js' } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(r.root, 'design-system', 'tokens', 'draft', 'base.tokens.json')
    assert.equal(base.color.base['100'].$value, '{color.rgb-base-100}') // Tailwind's colour points at the CSS channels
    assert.deepEqual(base.color['rgb-base-100'].$extensions.massimo, { cssVar: '--rgb-base-100', css: '250 250 250' })
    assert.equal(base.color.base.content.$extensions.massimo.contrast.on, 'color.base.100')
    // Type steps from the config are exact: no assumptions for them.
    assert.deepEqual(base.typography.body.$value, { fontFamily: '{font.sans}', fontSize: '{text.body}', fontWeight: 400, lineHeight: 1.5, letterSpacing: { value: 0, unit: 'px' } })
    assert.equal(base.typography.title.$value.lineHeight, 1.2)
    assert.match(read(r.root, 'design-system', 'tokens', 'draft', 'report.md'), /\| `typography\.body` \| 1rem \/ 1\.5, weight 400 \| a type step in the config \| assumed weight 400/)
  } finally {
    r.cleanup()
  }
})

test('a system in custom properties: its families kept, one token per variable, the code only where it adds', () => {
  const r = repo(
    {
      'src/styles/tokens.css': `:root {
  --ink-900: 29 31 32;
  --sand-200: 236 229 209;
  --rgb-base-100: 250 250 247;
  --color-base-100: rgb(var(--rgb-base-100));
  --c-block: rgb(var(--ink-900));
  --c-on-block-strong: rgb(var(--sand-200));
  --rust-600: 200 78 34;
  --c-accent-bg: rgb(var(--rust-600));
  --c-on-accent-bg: rgb(var(--sand-200));
  --c-primary: rgb(var(--rust-600));
  --c-focus: var(--c-primary);
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-4: 1rem;
  --font-body: "Geist Sans", sans-serif;
  --font-display: "Fraunces", serif;
  --h1-size: 3rem;
  --h1-leading: 1.1;
}
`,
      'tailwind.config.js': `module.exports = { theme: { extend: { colors: { base: { 100: 'rgb(var(--rgb-base-100) / <alpha-value>)' }, primary: { DEFAULT: '#0f766e', foreground: '#ffffff' } } } } }`,
      'src/app.css': [
        '.a { padding: 18px; } .b { padding: 18px; }',
        '.s { background: #0000001f; } .t { background: #0000001f; }',
        '.u { background: #ffffff1f; } .v { background: #ffffff1f; }',
        '.w { color: oklch(0.5 0.2 262); } .x { color: oklch(0.5 0.2 262); }',
        '.y { color: oklch(0.57 0.2 262); } .z { color: oklch(0.57 0.2 262); }',
      ].join('\n'),
      'src/data/avatars.ts': "export const AVATARS = ['#7398c9', '#7398c9']\n",
    },
    { tokens: { styleFiles: ['src/styles/tokens.css', 'src/app.css'], tailwindConfig: 'tailwind.config.js' } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(r.root, 'design-system', 'tokens', 'draft', 'base.tokens.json')
    const report = read(r.root, 'design-system', 'tokens', 'draft', 'report.md')
    // Tailwind's base.100 and the stylesheet's --color-base-100 are one token.
    assert.equal(base.color['base-100'].$value, '{color.rgb-base-100}')
    assert.equal(base.color.base, undefined)
    assert.match(report, /color\.base\.100 \(tailwind\.config\.js\) and color\.base-100 \(src\/styles\/tokens\.css\) are both --color-base-100; kept color\.base-100/)
    // --c-primary is color.primary, which Tailwind's primary group also needs: it takes its own name.
    assert.equal(base.color['c-primary'].$extensions.massimo.cssVar, '--c-primary')
    assert.equal(base.color.focus.$value, '{color.c-primary}')
    assert.equal(base.color.primary.$root.$value.hex, '#0f766e')
    assert.match(report, /color\.primary \(src\/styles\/tokens\.css\) is also a group of other tokens; named it color\.c-primary/)
    // on-block-strong is text on block.
    assert.equal(base.color['on-block-strong'].$extensions.massimo.contrast.on, 'color.block')
    assert.equal(base.color['on-block-strong'].$description, 'Text and icons on block, strong')
    // Contrast is checked on channel colours too: paper on rust is 3.65:1.
    const check = spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), 'check', '--root', r.root, '--source', join(r.root, 'design-system', 'tokens', 'draft', 'tokens.resolver.json')], { encoding: 'utf8' })
    assert.equal(check.status, 0, check.stderr)
    assert.match(check.stderr, /color\.on-accent-bg on color\.accent-bg is 3\.6\d:1, needs 4\.5:1/)
    assert.match(check.stdout, /1 contrast failure/)
    // Overlays by their base: black and white, not two neutrals.
    assert.ok(base.color.overlay['black-12'] && base.color.overlay['white-12'])
    // Two blues near one step: the nearer takes it, the other the step between.
    const blues = Object.keys(base.color.blue).filter((k) => !k.startsWith('$'))
    assert.equal(blues.length, 2)
    assert.ok(blues.includes('600'), blues.join())
    assert.ok(blues.every((k) => Number(k) % 5 === 0) && !blues.every((k) => ['500', '600', '700'].includes(k)), blues.join())
    // The sources' spacing is a scale: the code's 18px is drift, not a new step.
    assert.deepEqual(Object.keys(base.spacing).filter((k) => !k.startsWith('$')), ['1', '2', '4'])
    assert.match(report, /\| Spacing \| 18px \| 2 \| not on the existing spacing scale \|/)
    // A palette in a data file is not a style.
    assert.match(report, /\| Colour \| #7398c9 \| 2 \| only in data or scripts, never as a style, most in src\/data\/avatars\.ts \|/)
    // The h1 step from its stem, on the display face.
    assert.deepEqual([base.typography.h1.$value.fontFamily, base.typography.h1.$value.lineHeight], ['{font.display}', 1.1])
    assert.match(report, /\| `typography\.h1` \| 3rem \/ 1\.1, weight 400 \| a type step in src\/styles\/tokens\.css \| assumed weight 400, as the code sets no heading weight, the font\.display face, for a heading step, no letter spacing \|/)
  } finally {
    r.cleanup()
  }
})

test('a Tailwind repo keeps Tailwind names, line heights and curves; text on a -bg sibling pairs with it', () => {
  const r = repo(
    {
      'src/index.css': '@import "tailwindcss";\n:root { --font-sans: "Geist Sans", sans-serif; --pill-solid-bg: #7c5cde; --pill-solid-content: #ffffff; --color-neutral: #333333; --noise: 0; }\n',
      'src/App.tsx': [
        'export const A = () => <p className="text-xs text-xs text-sm text-sm leading-none leading-none leading-none transition ease-out duration-200" />',
        'export const B = () => <p className="text-[13px] text-[13px] ease-out duration-200" />',
        "export const C = () => <p style={{ color: '#000000' }}><b style={{ color: '#000000' }} /></p>",
      ].join('\n'),
      'package.json': '{"name":"acme"}',
    },
    { styling: ['tailwind4'], tokens: { styleFiles: ['src/index.css'] } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(r.root, 'design-system', 'tokens', 'draft', 'base.tokens.json')
    const report = read(r.root, 'design-system', 'tokens', 'draft', 'report.md')
    assert.deepEqual(Object.keys(base.font.size).filter((k) => !k.startsWith('$')).sort(), ['13', 'sm', 'xs'])
    // Tailwind's own line height, not leading-none, which is for icons and badges.
    assert.equal(base.typography.sm.$value.lineHeight, 1.4286)
    assert.match(report, /\| `typography\.sm` .*assumed line height 1\.4286, Tailwind's for text-sm/)
    assert.equal(base.typography['13'].$value.lineHeight, 1.5) // no other line height in the code
    // ease-out the class is Tailwind's curve.
    assert.deepEqual(base.ease.standard.$value, [0, 0, 0.2, 1])
    assert.equal(base.color['pill-solid-content'].$extensions.massimo.contrast.on, 'color.pill-solid-bg')
    assert.equal(base.color['pill-solid-content'].$description, 'Text and icons on pill-solid')
    // color.neutral is the theme's token, so the code's greys go in gray.
    assert.equal(base.color.gray['950'].$value.hex, '#000000')
    assert.equal(base.color.neutral.$value.hex, '#333333')
    // A bare 0 outside a length group is a number: 0px would break where it is a flag.
    assert.equal(base.other.noise.$value, 0)
  } finally {
    r.cleanup()
  }
})

const draft = (root, ...parts) => join(root, 'design-system', 'tokens', 'draft', ...parts)

test('a Tailwind 4 ramp in @theme: a cluster with a colour near a step is covered, and a primitive never takes a variable a token has', () => {
  const r = repo(
    {
      'src/styles/theme.css': '@import "tailwindcss";\n@theme {\n  --color-orange-400: #fa5a15;\n}\n',
      'src/app.css': ['.a { color: #ff512f; }', '.b { color: #ff512f; }', '.c { color: #ff512f; }', '.d { color: #fa5a15; }', '.e { background: #f97316; }', '.f { background: #f97316; }'].join('\n'),
      'package.json': '{"name":"acme"}',
    },
    { styling: ['tailwind4'], tokens: { styleFiles: ['src/styles/theme.css'] } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(draft(r.root, 'base.tokens.json'))
    const report = read(draft(r.root, 'report.md'))
    // #ff512f is just past near for orange-400, but its cluster holds #fa5a15, which is orange-400.
    assert.match(report, /\| `color\.orange-400` \| #fa5a15 \| src\/styles\/theme\.css \| covers #ff512f \(its cluster holds #fa5a15\), used 4× in code \|/)
    // #f97316 is step 400 by its lightness, and --color-orange-400 is the ramp's: it takes the step beside it.
    assert.deepEqual(Object.keys(base.color.orange).filter((k) => !k.startsWith('$')), ['405'])
    assert.equal(base.color.orange['405'].$value.hex, '#f97316')
  } finally {
    r.cleanup()
  }
})

test('a Tailwind 3 ramp with a DEFAULT takes the code colours near it as new steps of its own', () => {
  const r = repo(
    {
      'tailwind.config.js': `module.exports = { theme: { extend: { colors: { orange: { DEFAULT: '#f97316', 400: '#fb923c' } } } } }`,
      'src/app.css': '.a { color: #c2410c; }\n.b { border-color: #c2410c; }\n',
      'package.json': '{"name":"acme"}',
    },
    { tokens: { styleFiles: [], tailwindConfig: 'tailwind.config.js' } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(draft(r.root, 'base.tokens.json'))
    assert.equal(base.color.orange['600'].$value.hex, '#c2410c')
    assert.equal(base.color['orange-scale'], undefined)
  } finally {
    r.cleanup()
  }
})

test('a stylesheet whose :root is dark and whose light theme sets other values keeps the :root values, and two files that disagree keep the first; both are said', () => {
  const r = repo(
    {
      'src/styles/docs.css': ":root {\n  --backdrop: #272727cc;\n  --accent: #ff801f;\n}\n:root[data-theme='light'] {\n  --backdrop: #f6f6f699;\n  --accent: #b73d00;\n}\n",
      'src/styles/main.css': ':root {\n  --accent: #f76b15;\n}\n',
      'src/app.css': '.a { padding: 16px; } .b { padding: 16px; }',
      'package.json': '{"name":"acme"}',
    },
    { tokens: { styleFiles: ['src/styles/docs.css', 'src/styles/main.css'] } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const report = read(draft(r.root, 'report.md'))
    assert.match(report, /\| `color\.backdrop` \| #272727cc \| src\/styles\/docs\.css \|/)
    assert.match(report, /\| `color\.accent` \| #ff801f \| src\/styles\/docs\.css \|/)
    const notes = [
      "--accent and --backdrop are set under :root in src/styles/docs.css and, differently, under :root[data-theme='light'] in src/styles/docs.css, which massimo reads as the same default theme; the tokens keep the values under :root in src/styles/docs.css",
      '--accent is set under :root in src/styles/docs.css and, differently, under :root in src/styles/main.css, which massimo reads as the same default theme; its token keeps the value under :root in src/styles/docs.css',
    ]
    for (const n of notes) {
      assert.ok(out.stderr.includes(`  note: ${n}\n`), out.stderr)
      assert.ok(report.split('## Notes')[1]?.includes(`- ${n}\n`), report)
    }
  } finally {
    r.cleanup()
  }
})

test('a Tokens Studio file in the W3C form: every set is read, references resolve across sets, and a self-reference keeps the primitive', () => {
  const studio = {
    'primitive/color': { color: { gray: { 50: { $type: 'color', $value: '#fafafa' }, 900: { $type: 'color', $value: '#111111' } } } },
    'primitive/spacing': { spacing: { 4: { $type: 'dimension', $value: '4px' }, 8: { $type: 'dimension', $value: '8px' }, 12: { $type: 'dimension', $value: '12px' } } },
    'primitive/typography': { typography: { fontFamily: { base: { $type: 'fontFamilies', $value: 'Inter, sans-serif' } } } },
    'semantic/dark/color': {
      color: {
        background: { default: { $type: 'color', $value: '{color.gray.900}', $description: 'Page background' } },
        foreground: { default: { $type: 'color', $value: '{color.gray.50}' } },
      },
    },
    'semantic/spacing': { spacing: { component: { xs: { $type: 'dimension', $value: '{spacing.4}' } } } },
    'semantic/typography': { typography: { fontFamily: { base: { $type: 'fontFamilies', $value: '{typography.fontFamily.base}' } } } },
    $themes: [],
    $metadata: { tokenSetOrder: ['primitive/color', 'primitive/spacing', 'primitive/typography', 'semantic/dark/color', 'semantic/spacing', 'semantic/typography'] },
  }
  const r = repo(
    { 'tokens/tokens.json': JSON.stringify(studio), 'src/app.css': '.a { padding: 16px; } .b { padding: 16px; }', 'package.json': '{"name":"acme"}' },
    { tokens: { styleFiles: [], importFiles: ['tokens/tokens.json'] } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /\(9 from 1 file, /)
    const base = readJson(draft(r.root, 'base.tokens.json'))
    assert.equal(base.color.gray['900'].$value.hex, '#111111')
    assert.equal(base.color.background.default.$value, '{color.gray.900}')
    assert.equal(base.color.background.default.$description, 'Page background')
    assert.equal(base.color.foreground.default.$value, '{color.gray.50}')
    assert.deepEqual(base.spacing['4'].$value, { value: 4, unit: 'px' })
    assert.equal(base.spacing.component.xs.$value, '{spacing.4}')
    assert.deepEqual(base.typography.fontFamily.base.$value, ['Inter', 'sans-serif'])
    const note = 'tokens/tokens.json: typography.fontFamily.base in semantic/typography refers to itself, which Tokens Studio reads as the same path in an earlier set; kept the earlier token'
    assert.ok(out.stderr.includes(`  note: ${note}\n`), out.stderr)
    assert.ok(read(draft(r.root, 'report.md')).includes(`- ${note}\n`))
  } finally {
    r.cleanup()
  }
})

test('an import file that gives no tokens is said, printed and in the report', () => {
  const r = repo(
    { 'tokens/brand.json': JSON.stringify({ brand: { primary: '#ff0000' } }), 'src/app.css': '.a { padding: 16px; } .b { padding: 16px; }', 'package.json': '{"name":"acme"}' },
    { tokens: { styleFiles: [], importFiles: ['tokens/brand.json'] } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const note = 'tokens/brand.json: read no tokens from it. A token is an object with a $value, or in a Tokens Studio file a value'
    assert.ok(out.stderr.includes(`  note: ${note}\n`), out.stderr)
    assert.ok(read(draft(r.root, 'report.md')).includes(`- ${note}\n`))
  } finally {
    r.cleanup()
  }
})

test('a Tailwind repo: a radius takes Tailwind\'s name only at Tailwind\'s size, its own classes are listed, and a repeated width is not dropped', () => {
  const r = repo(
    {
      'src/index.css': '@import "tailwindcss";\n',
      'src/Nav.tsx': [
        'export const A = () => <nav className="rounded-[40px] max-w-[80rem] p-4 px-4 rounded-lg" />',
        'export const B = () => <nav className="rounded-[40px] max-w-[80rem] md:p-4 gap-2 p-0 rounded-t-lg rounded-full" />',
        'export const C = () => <i className="rounded-[4px] rounded-[4px] w-[37px]" />',
      ].join('\n'),
      'package.json': '{"name":"acme"}',
    },
    { styling: ['tailwind4'], tokens: { styleFiles: ['src/index.css'] } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(draft(r.root, 'base.tokens.json'))
    const report = read(draft(r.root, 'report.md'))
    // 40px is off Tailwind's scale, so it never takes rounded-sm's name; 4px is Tailwind 4's sm.
    assert.deepEqual(base.radius['40'].$value, { value: 2.5, unit: 'rem' })
    assert.deepEqual(base.radius.sm.$value, { value: 0.25, unit: 'rem' })
    assert.match(report, /\| `radius\.40` \| 2\.5rem \| 40px used 2× in code \| off Tailwind's scale, named by its size \|/)
    assert.match(report, /\| `radius\.sm` \| 0\.25rem \| 4px used 2× in code \| Tailwind's rounded-sm \|/)
    // Tailwind's own classes, which need no tokens, are listed for both families.
    assert.match(report, /\| `\(none\)` \| rounded-lg ×2, rounded-full ×1 \| Tailwind classes \| Tailwind's own radii/)
    assert.match(report, /\| `\(none\)` \| 4 ×3, 2 ×1 \| Tailwind spacing classes \(p-, m-, gap- and the like\), by step \| Tailwind's own spacing scale/)
    // Widths: the repeated one with its reason, the one used once with the rest.
    assert.match(report, /\| Size \| 80rem \| 2 \| a width or height; massimo proposes no size tokens yet \|/)
    assert.match(report, /\| Size \| 37px \| 1 \| widths and heights used once each \|/)
    assert.match(report, /No token replaces a width or height \(massimo proposes no size tokens yet\), so keep those as they are\./)
  } finally {
    r.cleanup()
  }
  // Tailwind 3 names its radii one step apart from Tailwind 4, and its 4px is `rounded` itself.
  const audit = { findings: [2, 2, 4, 4].map((px) => ({ category: 'radius', px })) }
  const { report } = propose({ sources: [], audit, fromCss: () => ({}), styling: ['tailwind3'] })
  assert.deepEqual(report.filter((x) => x.family === 'radius').map((x) => [x.token, x.note]), [['radius.sm', "Tailwind's rounded-sm"], ['radius.4', "Tailwind's rounded, named by its size"]])
  // A name the sources already give a radius is not proposed again: the radius is named by its size.
  const own = repo(
    {
      'src/index.css': '@import "tailwindcss";\n@theme { --radius-sm: 0.5rem; }\n',
      'src/Tag.tsx': 'export const Tag = () => <i className="rounded-[4px] rounded-[4px]" />\n',
      'package.json': '{"name":"acme"}',
    },
    { styling: ['tailwind4'], tokens: { styleFiles: ['src/index.css'] } },
  )
  try {
    const out = extract(own.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(draft(own.root, 'base.tokens.json'))
    assert.deepEqual(base.radius.sm.$value, { value: 0.5, unit: 'rem' })
    assert.deepEqual(base.radius['4'].$value, { value: 0.25, unit: 'rem' })
    assert.match(read(draft(own.root, 'report.md')), /\| `radius\.4` \| 0\.25rem \| 4px used 2× in code \| the sources already define radius\.sm, so named by its size \|/)
  } finally {
    own.cleanup()
  }
})

test('the body size is the one the body rule sets, else the most used', () => {
  const css = [
    'body { color: #111111; font-size: 13px; }',
    '.a { font-size: 12px; } .b { font-size: 12px; } .c { font-size: 12px; }',
    '.d { font-size: 15px; } .e { font-size: 15px; } .f { font-size: 11px; } .g { font-size: 11px; }',
  ].join('\n')
  const r = repo({ 'src/base.css': css, 'package.json': '{"name":"acme"}' }, { tokens: { styleFiles: [] } })
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(draft(r.root, 'base.tokens.json'))
    // Set once, in the body rule, 13px is still the base; the names step from it.
    assert.deepEqual(base.font.size.base.$value, { value: 0.8125, unit: 'rem' })
    assert.deepEqual([base.font.size.sm, base.font.size.xs, base.font.size.lg].map((t) => t.$value.value), [0.75, 0.6875, 0.9375])
    assert.match(read(draft(r.root, 'report.md')), /\| `font\.size\.base` \| 0\.8125rem \| 13px used 1× in code \| the body size, set on body in src\/base\.css \|/)
  } finally {
    r.cleanup()
  }
  // A body rule inside @media sets the size on some screens only, so the plain body rule after it wins.
  const media = repo(
    { 'src/a.css': '@media (max-width: 600px) { body { font-size: 14px } }\nbody { font-size: 16px }\n.a { font-size: 12px } .b { font-size: 12px }\n', 'package.json': '{"name":"acme"}' },
    { tokens: { styleFiles: [] } },
  )
  try {
    const out = extract(media.root)
    assert.equal(out.status, 0, out.stderr)
    assert.deepEqual(readJson(draft(media.root, 'base.tokens.json')).font.size.base.$value, { value: 1, unit: 'rem' })
    assert.match(read(draft(media.root, 'report.md')), /\| `font\.size\.base` \| 1rem \| 16px used 1× in code \| the body size, set on body in src\/a\.css \|/)
  } finally {
    media.cleanup()
  }
  const audit = { typeSizes: [{ px: 12, count: 5 }, { px: 15, count: 2 }] }
  const { report } = propose({ sources: [], audit, fromCss: () => ({}) })
  assert.deepEqual(report.filter((x) => x.token.startsWith('font.size.')).map((x) => [x.token, x.value, x.note]), [
    ['font.size.base', '0.75rem', 'the most used size, taken as the body size'],
    ['font.size.lg', '0.9375rem', ''],
  ])
})

test('every draft name passes the check: a 0.01ms reset is no duration step', () => {
  const css = [
    '.a { transition: opacity 150ms ease; } .b { transition: opacity 150ms ease; }',
    '.c { transition: opacity 200ms ease; } .d { transition: opacity 200ms ease; }',
    '.e { transition: opacity 300ms ease; } .f { transition: opacity 300ms ease; }',
    '@media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms; transition-duration: 0.01ms; } }',
  ].join('\n')
  const r = repo({ 'src/app.css': css, 'package.json': '{"name":"acme"}' }, { tokens: { styleFiles: [] } })
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(draft(r.root, 'base.tokens.json'))
    assert.deepEqual(Object.keys(base.duration).filter((k) => !k.startsWith('$')), ['fast', 'normal', 'slow'])
    assert.match(read(draft(r.root, 'report.md')), /\| Motion \| 0\.01ms \| 2 \| under 1ms, which turns motion off rather than timing it \|/)
    assert.match(read(draft(r.root, 'report.md')), /No token replaces a duration under 1ms \(it switches motion off\), so keep those as they are\./)
    const check = spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), 'check', '--root', r.root, '--source', draft(r.root, 'tokens.resolver.json')], { encoding: 'utf8' })
    assert.equal(check.status, 0, check.stderr)
  } finally {
    r.cleanup()
  }
  // A theme's spacing step 0.5 is written 0_5, and a note names it.
  const steps = repo(
    { 'src/theme.ts': "export const theme = { space: { 0.5: '2px', 1: '4px', '1.5': '6px', 2: '8px' } }\n", 'package.json': '{"name":"acme"}' },
    { tokens: { styleFiles: [], themeFiles: ['src/theme.ts'] } },
  )
  try {
    const out = extract(steps.root)
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stderr, /note: src\/theme\.ts: a token name cannot hold a dot, so 2 names were written with _ instead: spacing\.0\.5 as spacing\.0_5, spacing\.1\.5 as spacing\.1_5/)
    const base = readJson(draft(steps.root, 'base.tokens.json'))
    assert.deepEqual(Object.keys(base.spacing).filter((k) => !k.startsWith('$')).sort(), ['0_5', '1', '1_5', '2'])
    const check = spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), 'check', '--root', steps.root, '--source', draft(steps.root, 'tokens.resolver.json')], { encoding: 'utf8' })
    assert.equal(check.status, 0, check.stderr)
  } finally {
    steps.cleanup()
  }
})

test('a repo without Tailwind: class-like strings are not Tailwind classes, and a theme contract\'s strings are not values', () => {
  const r = repo(
    {
      'src/theme/contract.css.ts': [
        "import { createGlobalThemeContract } from '@vanilla-extract/css'",
        'export const vars = createGlobalThemeContract(',
        "  { typography: { fontFamily: 'font-family' }, shadows: { sm: 'shadow-sm', lg: 'shadow-lg' } },",
        '  (value) => `acme-${value}`,',
        ')',
        '',
      ].join('\n'),
      'src/card.css.ts': [
        "export const card = style({ fontFamily: 'Inter, sans-serif', transition: 'opacity 150ms ease-in-out' })",
        "export const panel = style({ fontFamily: 'Inter, sans-serif', transition: 'opacity 150ms ease-in-out' })",
        '',
      ].join('\n'),
      'package.json': '{"name":"acme"}',
    },
    { styling: ['vanilla-extract'], tokens: { styleFiles: [] } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(draft(r.root, 'base.tokens.json'))
    const report = read(draft(r.root, 'report.md'))
    assert.deepEqual(Object.keys(base.font.family).filter((k) => !k.startsWith('$')), ['sans'])
    assert.equal(base.font.family.sans.$value, 'Inter')
    assert.ok(!report.includes('Tailwind'), report)
    // ease-in-out in a string is the CSS keyword, not Tailwind's curve.
    assert.deepEqual(base.ease.standard.$value, [0.42, 0, 0.58, 1])
    const audit = spawnSync(process.execPath, [join(SCRIPTS, 'audit.mjs'), '--root', r.root], { encoding: 'utf8' })
    assert.equal(audit.status, 0, audit.stderr)
    const latest = readJson(r.root, 'design-system', 'audits', 'latest.json')
    assert.deepEqual(latest.fontFamilies, [{ family: 'Inter', count: 2 }])
    assert.equal(latest.inventory.shadow, undefined)
  } finally {
    r.cleanup()
  }
})
