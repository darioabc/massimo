// tokens.mjs extract: a full proposed set from what a repo already uses, its
// sources first and the code's own values for the gaps, with a report that
// says where each value came from and what was assumed.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
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
  --paper-200: 236 229 209;
  --rgb-base-100: 250 250 247;
  --color-base-100: rgb(var(--rgb-base-100));
  --c-block: rgb(var(--ink-900));
  --c-on-block-strong: rgb(var(--paper-200));
  --rust-600: 200 78 34;
  --c-accent-bg: rgb(var(--rust-600));
  --c-on-accent-bg: rgb(var(--paper-200));
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
