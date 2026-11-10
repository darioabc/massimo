// Colour semantics, contrast and themes: extract pairs text with the
// background of its group and says what it could not propose, check says how
// many contrast pairs it checked, and the kit's :root takes the default
// theme's colour scheme.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SCRIPTS, read, readJson, run, withTokens } from './helpers.mjs'

function repo(files, config) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-colours-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  writeFileSync(join(root, 'massimo.config.json'), JSON.stringify(config))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const tokens = (root, ...args) => spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), ...args, '--root', root], { encoding: 'utf8' })
const draft = (root, name) => join(root, 'design-system', 'tokens', 'draft', name)

test('extract pairs text no name pairs with the background of its group, and check reads the pairs', () => {
  const r = repo(
    {
      'src/styles/base.css': ':root {\n  --bg: #0d0e12;\n  --text: #d8dae2;\n  --text-faint: #5c6170;\n  --text-disabled: #3a3d46;\n  --text-on-accent: #0d0e12;\n  --accent: #7aa2f7;\n}\n',
      'src/app.css': '.hint { color: var(--text-faint); background: var(--bg); }',
      'package.json': '{"name":"acme"}',
    },
    { tokens: { styleFiles: ['src/styles/base.css'] } },
  )
  try {
    const out = tokens(r.root, 'extract')
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(draft(r.root, 'base.tokens.json'))
    for (const name of ['text', 'text-faint']) assert.deepEqual(base.color[name].$extensions.massimo.contrast, { on: 'color.bg', use: 'text' }, name)
    // Text on something else is left to a pair by hand, and disabled text
    // needs no contrast at all.
    for (const name of ['text-on-accent', 'text-disabled']) assert.equal(base.color[name].$extensions?.massimo?.contrast, undefined, name)
    assert.match(read(draft(r.root, 'report.md')), /\| `color\.text-faint` \| #5c6170 \| src\/styles\/base\.css \| contrast checked as text on color\.bg, guessed as its group's background \|/)
    // No theme beyond the default, said with the reason.
    assert.match(out.stderr, /note: No dark theme is proposed: the sources set no colour for a dark theme\. If the app has one theme only, nothing is missing; if that theme is dark, set tokens\.defaultMode to dark\.\n/)
    const check = tokens(r.root, 'check', '--source', draft(r.root, 'tokens.resolver.json'))
    assert.equal(check.status, 0, check.stderr)
    assert.match(check.stderr, /warn: light: color\.text-faint on color\.bg is 3\.12:1, needs 4\.5:1 for text/)
    assert.match(check.stdout, /up to date \(\d+ tokens, 0 stale, 1 contrast failure\)/)
    // A dark default is the dark theme, so nothing is said about one.
    writeFileSync(join(r.root, 'massimo.config.json'), JSON.stringify({ tokens: { styleFiles: ['src/styles/base.css'], defaultMode: 'dark' } }))
    const dark = tokens(r.root, 'extract')
    assert.equal(dark.status, 0, dark.stderr)
    assert.ok(!dark.stderr.includes('No dark theme'), dark.stderr)
  } finally {
    r.cleanup()
  }
})

test('a repo coloured with Tailwind palette classes: extract says it proposes no semantic colour and no dark theme, and why', () => {
  const r = repo(
    {
      'src/styles/app.css': '@import "tailwindcss";\n@theme {\n  --color-neutral-400: #a3a3a3;\n  --color-neutral-600: #525252;\n}\n',
      'src/components/Card.tsx': 'export const Card = () => <p className="text-neutral-600 dark:text-neutral-400 bg-white dark:bg-neutral-900" />\n',
      'package.json': '{"name":"acme"}',
    },
    { styling: ['tailwind4'], tokens: { styleFiles: ['src/styles/app.css'] } },
  )
  try {
    const out = tokens(r.root, 'extract')
    assert.equal(out.status, 0, out.stderr)
    const notes = [
      /No semantic colour is proposed: the code sets its colours with 4 Tailwind palette classes \(most used: [^)]+\), which extract does not turn into semantic tokens, and the sources name no colour by its job\. Add the text, background, border and accent tokens when reviewing colour semantics, each an alias of a primitive\./,
      /No dark theme is proposed: the code switches its colours with 2 dark: variants of Tailwind palette classes, which extract does not read, and the sources set no colour for a dark theme\./,
    ]
    const report = read(draft(r.root, 'report.md')).split('## Notes')[1] ?? ''
    for (const n of notes) {
      assert.match(out.stderr, new RegExp(`note: ${n.source}`))
      assert.match(report, new RegExp(`- ${n.source}`))
    }
    // And check says plainly that it checked no pair.
    const check = tokens(r.root, 'check', '--source', draft(r.root, 'tokens.resolver.json'))
    assert.equal(check.status, 0, check.stderr)
    assert.match(check.stdout, /up to date \(\d+ tokens, 0 stale, no contrast pairs checked\)/)
  } finally {
    r.cleanup()
  }
})

test('a colour the sources alias to another is their own semantic layer, so extract does not ask for one', () => {
  const r = repo(
    {
      'src/styles/base.css': ':root {\n  --blue-500: #3b82f6;\n  --gray-900: #111827;\n  --gray-50: #f9fafb;\n  --card: var(--gray-50);\n  --ink-strong: var(--gray-900);\n  --action: var(--blue-500);\n}\n[data-theme="dark"] {\n  --card: var(--gray-900);\n  --ink-strong: var(--gray-50);\n}\n',
      'src/app.css': '.x { color: var(--ink-strong); background: var(--card); }',
      'package.json': '{"name":"acme"}',
    },
    { tokens: { styleFiles: ['src/styles/base.css'] } },
  )
  try {
    const out = tokens(r.root, 'extract')
    assert.equal(out.status, 0, out.stderr)
    assert.equal(readJson(draft(r.root, 'base.tokens.json')).color.card.$value, '{color.gray-50}')
    assert.ok(!out.stderr.includes('No semantic colour'), out.stderr)
    assert.ok(!out.stderr.includes('No dark theme'), out.stderr)
  } finally {
    r.cleanup()
  }
})

test('check says how many contrast pairs it checked when none fails', () => {
  const doc = {
    color: {
      $type: 'color',
      white: { $value: '#ffffff' },
      ink: { $value: '#111111' },
      text: { $value: '{color.ink}', $extensions: { massimo: { on: 'color.white', contrast: 4.5 } } },
      muted: { $value: '#555555', $extensions: { massimo: { on: 'color.white', contrast: 4.5 } } },
    },
  }
  const t = withTokens(doc)
  try {
    assert.equal(run('tokens', t, ['build']).status, 0)
    const check = run('tokens', t, ['check'])
    assert.equal(check.status, 0, check.stderr)
    assert.match(check.stdout, /up to date \(4 tokens, 0 stale, 0 contrast failures in 2 pairs\)/)
  } finally {
    t.cleanup()
  }
})

test('the kit\'s :root carries the default theme\'s colour scheme, and a light theme under a dark default sets its own', () => {
  const doc = { color: { $type: 'color', bg: { $value: '#0d0e12', $extensions: { massimo: { modes: { light: '#ffffff' } } } } } }
  const t = withTokens(doc, { defaultMode: 'dark' })
  try {
    assert.equal(run('tokens', t, ['kit']).status, 0)
    const kit = read(t.project, 'kit', 'kit.css')
    assert.match(kit, /\n:root \{\n {2}color-scheme: dark;\n {2}--color-bg: #0d0e12;\n\}/)
    assert.match(kit, /\[data-theme="light"\] \{\n {2}color-scheme: light;\n {2}--color-bg: #ffffff;\n\}/)
  } finally {
    t.cleanup()
  }
})
