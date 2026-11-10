// What extract leaves out of the draft, and says why: a length in em, which
// follows a font size, and the colours of daisyUI's built-in themes, which
// live in the daisyui package rather than the repo.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { propose } from '../scripts/lib/propose.mjs'
import { SCRIPTS, read, readJson } from './helpers.mjs'

function repo(files, config) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-gaps-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  writeFileSync(join(root, 'massimo.config.json'), JSON.stringify(config))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const extract = (root) => spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), 'extract', '--root', root], { encoding: 'utf8' })
const draft = (root, name) => join(root, 'design-system', 'tokens', 'draft', name)

test('a length in em is never proposed as a rem token: it is listed under Not proposed, and a px length at the same size still counts', () => {
  const css = [
    '.prose { font-size: 1.125em; }',
    '.prose small { font-size: 0.85em; border-radius: 0.35em; padding: 0.5em; }',
    '.prose code { font-size: 0.85em; border-radius: 0.35em; padding: 0.5em; }',
    '.card { padding: 8px; margin: 8px; border-radius: 4px; }',
    '.tile { border-radius: 4px; }',
    '.note { font-size: 14px; }',
    '.hint { font-size: 14px; }',
  ].join('\n')
  const r = repo({ 'src/app.css': css, 'src/App.tsx': 'export const A = () => <p className="text-[0.85em]" />', 'package.json': '{"name":"acme"}' }, { tokens: { styleFiles: [] } })
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(draft(r.root, 'base.tokens.json'))
    const report = read(draft(r.root, 'report.md'))
    // 0.85em is 13.6px against a 16px root, 0.35em 5.6px, 0.5em 8px: none of them a rem token.
    const sizes = Object.values(base.font?.size ?? {}).filter((t) => t.$value).map((t) => t.$value.value)
    assert.ok(!sizes.includes(0.85) && !sizes.includes(1.125), JSON.stringify(sizes))
    assert.deepEqual(Object.values(base.radius).filter((t) => t.$value).map((t) => t.$value.value), [0.25])
    assert.equal(base.spacing['2'].$value.value, 0.5) // 8px used twice in px
    assert.doesNotMatch(report, /13\.6px|5\.6px/)
    assert.match(report, /\| Typography \| 0\.85em ×3, 1\.125em \| 4 \| in em, relative to the parent's font size, so a rem token cannot hold them \|/)
    assert.match(report, /\| Radius \| 0\.35em ×2 \| 2 \| in em, relative to the element's font size, so a rem token cannot hold it \|/)
    assert.match(report, /\| Spacing \| 0\.5em ×2 \| 2 \| in em, relative to the element's font size, so a rem token cannot hold it \|/)
    assert.match(report, /No token replaces a length in em \(it follows a font size\), so keep those as they are\./)
    assert.match(report, /\| `spacing\.2` \| 0\.5rem \| 8px used 2× in code \|/)
  } finally {
    r.cleanup()
  }
})

test('an em length counted at a px size by an older audit, or with no px at all, is left out of the scales either way', () => {
  const audit = (px) => ({
    findings: [
      { kind: 'length', category: 'type', value: '0.85em', px },
      { kind: 'length', category: 'type', value: '0.85em', px },
      { kind: 'arbitrary', category: 'radius', value: 'rounded-[0.35em]', px: px && 5.6 },
      { kind: 'arbitrary', category: 'radius', value: 'rounded-[0.35em]', px: px && 5.6 },
    ],
    typeSizes: px ? [{ px, count: 2 }] : [],
    spacing: { histogram: [] },
  })
  for (const px of [13.6, undefined]) {
    const { tokens, outliers } = propose({ sources: [], audit: audit(px), fromCss: () => ({}) })
    assert.equal(tokens.filter((t) => ['font', 'radius'].includes(t.path[0])).length, 0, String(px))
    assert.deepEqual(outliers.map((o) => [o.family, o.value, o.count]), [['typography', '0.85em ×2', 2], ['radius', '0.35em ×2', 2]], String(px))
  }
})

test("an app on daisyUI's built-in themes is told where its colours live, not blamed for palette classes", () => {
  const r = repo(
    {
      'src/app.css': '@import "tailwindcss";\n@plugin "daisyui" {\n  themes: nord --default, dim --prefersdark;\n}\n@theme {\n  --font-sans: Inter, sans-serif;\n}\n',
      'src/App.tsx': [
        'export const A = () => <div className="bg-base-100 text-base-content"><p className="text-slate-500 dark:text-slate-400" /></div>',
        'export const B = () => <div className="bg-base-200 text-slate-500" />',
      ].join('\n'),
      'package.json': '{"name":"acme"}',
    },
    { styling: ['tailwind4', 'daisyui'], tokens: { styleFiles: ['src/app.css'] } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const report = read(draft(r.root, 'report.md'))
    assert.match(report, /it takes its colours from daisyUI's built-in themes nord \(the default\) and dim \(used when the system prefers dark\), which @plugin "daisyui" names in src\/app\.css\./)
    assert.match(report, /Their values live in the daisyui package \(theme\/nord\.css and theme\/dim\.css\), not in this repo, under daisyUI's colour names: base-100, base-200, base-300, base-content, primary,/)
    assert.match(report, /one theme per mode, and map daisyUI's names onto them with a @plugin "daisyui\/theme" block per theme\./)
    assert.match(report, /Apart from those, the code uses 3 Tailwind palette classes/)
    // Neither the palette classes nor the dark: variants are given as the reason.
    assert.doesNotMatch(report, /the code sets its colours with|No dark theme is proposed|If the app has one theme only/)
  } finally {
    r.cleanup()
  }
})

test('a daisyUI theme the style files define keeps the notes as before, and themes: false names none', () => {
  const sheet = (themes) =>
    `@import "tailwindcss";\n@plugin "daisyui" {\n  themes: ${themes};\n}\n@plugin "daisyui/theme" {\n  name: "acme";\n  default: true;\n  --color-base-100: #ffffff;\n  --color-base-content: #1f2937;\n}\n`
  for (const themes of ['acme --default', 'false']) {
    const r = repo(
      { 'src/app.css': sheet(themes), 'src/App.tsx': 'export const A = () => <div className="bg-base-100 text-slate-500 text-slate-500" />', 'package.json': '{"name":"acme"}' },
      { styling: ['tailwind4', 'daisyui'], tokens: { styleFiles: ['src/app.css'] } },
    )
    try {
      const out = extract(r.root)
      assert.equal(out.status, 0, out.stderr)
      const report = read(draft(r.root, 'report.md'))
      assert.doesNotMatch(report, /daisyui package/, themes)
      assert.match(report, /No dark theme is proposed/, themes)
    } finally {
      r.cleanup()
    }
  }
})

test("a bare @plugin \"daisyui\"; or a block with no themes picks daisyUI's light and dark themes, and quoted names are read without their quotes", () => {
  const sheets = {
    bare: '@import "tailwindcss";\n/* @plugin "daisyui" { themes: cupcake; } */\n@plugin "daisyui";\n@theme {\n  --font-sans: Inter, sans-serif;\n}\n',
    block: '@import "tailwindcss";\n@plugin "daisyui" {\n  logs: false;\n}\n@theme {\n  --font-sans: Inter, sans-serif;\n}\n',
    quoted: `@import "tailwindcss";\n@plugin "daisyui" {\n  themes: "light" --default, 'dark' --prefersdark;\n}\n@theme {\n  --font-sans: Inter, sans-serif;\n}\n`,
  }
  for (const [kind, sheet] of Object.entries(sheets)) {
    const r = repo(
      { 'src/app.css': sheet, 'src/App.tsx': 'export const A = () => <div className="bg-base-100 text-slate-500 dark:text-slate-400 bg-red-500" />', 'package.json': '{"name":"acme"}' },
      { styling: ['tailwind4', 'daisyui'], tokens: { styleFiles: ['src/app.css'] } },
    )
    try {
      const out = extract(r.root)
      assert.equal(out.status, 0, out.stderr)
      const report = read(draft(r.root, 'report.md'))
      const named = kind === 'quoted' ? 'which @plugin "daisyui" names in src/app.css' : 'which @plugin "daisyui" turns on in src/app.css, as it names no themes'
      assert.ok(report.includes(`it takes its colours from daisyUI's built-in themes light (the default) and dark (used when the system prefers dark), ${named}.`), kind)
      assert.match(report, /\(theme\/light\.css and theme\/dark\.css\)/, kind)
      assert.doesNotMatch(report, /the code sets its colours with|No dark theme is proposed/, kind)
    } finally {
      r.cleanup()
    }
  }
})

test("a daisyUI theme of the app's own beside a built-in one: the note says only where the built-in theme's values live", () => {
  const sheet = [
    '@import "tailwindcss";',
    '@plugin "daisyui" {',
    '  themes: light --default, acme --prefersdark;',
    '}',
    '@plugin "daisyui/theme" {',
    '  name: "acme";',
    '  prefersdark: true;',
    '  --color-base-100: #111827;',
    '  --color-base-content: #f9fafb;',
    '  --color-primary: #6366f1;',
    '}',
    '',
  ].join('\n')
  const r = repo(
    { 'src/app.css': sheet, 'src/App.tsx': 'export const A = () => <div className="bg-base-100 text-slate-500 dark:text-slate-300 bg-red-500" />', 'package.json': '{"name":"acme"}' },
    { styling: ['tailwind4', 'daisyui'], tokens: { styleFiles: ['src/app.css'] } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const report = read(draft(r.root, 'report.md'))
    assert.match(report, /\| `color\.primary` \| #6366f1 \| src\/app\.css \|/)
    assert.match(report, /The app also takes colours from daisyUI's built-in theme light \(the default\), which @plugin "daisyui" names in src\/app\.css\. Their values live in the daisyui package \(theme\/light\.css\), not in this repo, so no token here holds them\./)
    assert.doesNotMatch(report, /No semantic colour is proposed|No dark theme is proposed/)
  } finally {
    r.cleanup()
  }
})

test('a body size written in em is the body size, not a length in em', () => {
  const css = [
    'body { font-size: 0.875em; font-family: Inter, sans-serif; }',
    '.a { font-size: 14px; }',
    '.b { font-size: 20px; }',
    '.c { font-size: 20px; }',
    '.d { font-size: 0.75em; }',
    '.e { font-size: 0.75em; }',
  ].join('\n')
  const r = repo({ 'src/app.css': css, 'package.json': '{"name":"acme"}' }, { tokens: { styleFiles: [] } })
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const report = read(draft(r.root, 'report.md'))
    assert.match(report, /\| `font\.size\.base` \| 0\.875rem \| 14px used 2× in code \| the body size, set on body in src\/app\.css \|/)
    assert.match(report, /\| Typography \| 0\.75em ×2 \| 2 \| in em, relative to the parent's font size, so a rem token cannot hold it \|/)
    assert.doesNotMatch(report, /0\.875em/)
  } finally {
    r.cleanup()
  }
})

test("a theme of the app's own that is the default takes that role from daisyUI's light theme", () => {
  const sheet = '@import "tailwindcss";\n@plugin "daisyui";\n@plugin "daisyui/theme" {\n  name: "brand";\n  default: true;\n  --color-primary: #6366f1;\n}\n'
  const r = repo(
    { 'src/app.css': sheet, 'src/App.tsx': 'export const A = () => <div className="bg-primary text-slate-500 text-slate-500" />', 'package.json': '{"name":"acme"}' },
    { styling: ['tailwind4', 'daisyui'], tokens: { styleFiles: ['src/app.css'] } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const report = read(draft(r.root, 'report.md'))
    assert.match(report, /The app also takes colours from daisyUI's built-in themes light and dark \(used when the system prefers dark\), which @plugin "daisyui" turns on in src\/app\.css, as it names no themes\./)
  } finally {
    r.cleanup()
  }
})
