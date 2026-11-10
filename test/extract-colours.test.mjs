// tokens.mjs extract, colours: in a Tailwind repo a proposed colour never
// takes a name Tailwind's palette gives another colour, semantic colours
// follow how the page is painted, a numbered ramp is no semantic layer, and
// a cluster is covered by the nearest token, never by a transparent one.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { propose } from '../scripts/lib/propose.mjs'
import { TAILWIND_COLORS, TAILWIND_STEPS } from '../scripts/lib/tailwind-colors.mjs'
import { parseColor, toHex } from '../scripts/lib/color.mjs'
import { SCRIPTS, read, readJson } from './helpers.mjs'

function repo(files, config) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-colours-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  writeFileSync(join(root, 'massimo.config.json'), JSON.stringify(config))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const extract = (root) => spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), 'extract', '--root', root], { encoding: 'utf8' })
const draft = (root, ...parts) => join(root, 'design-system', 'tokens', 'draft', ...parts)

// A cluster as the audit writes it.
const cluster = (representative, roles, members = [representative]) => ({
  representative,
  count: Object.values(roles).reduce((n, c) => n + c, 0),
  members: members.map((value) => ({ value })),
  roles,
})
const colours = (out) => Object.fromEntries(out.tokens.filter((t) => t.type === 'color' && t.source === 'audit' && !String(t.value).startsWith('{')).map((t) => [t.path.join('.'), t.value]))
const fromCss = () => ({})

// Whether a token name is one of Tailwind's palette names for another colour.
const shadows = (version, path, value) => {
  const [, family, step] = path.split('.')
  const i = TAILWIND_STEPS.indexOf(Number(step))
  const theirs = TAILWIND_COLORS[version][family]?.[i]
  return theirs !== undefined && toHex(parseColor(theirs)) !== toHex(parseColor(value))
}

test("in a Tailwind repo a colour takes Tailwind's palette name only at Tailwind's value for that version", () => {
  const audit = {
    colorClusters: [
      cluster('#eab308', { text: 7 }), // Tailwind 3's yellow-500, which lightness alone calls 300
      cluster('#00aa77', { text: 3 }),
      cluster('#94a3b8', { text: 5 }), // Tailwind 3's slate-400, in the blue hue band
      cluster('#22c55e', { bg: 3 }), // Tailwind 3's green-500
      cluster('#cc9900', { text: 4 }),
    ],
  }
  const v3 = propose({ sources: [], audit, fromCss, styling: ['tailwind3'] })
  const named = colours(v3)
  assert.equal(named['color.yellow.500'], '#eab308')
  assert.equal(named['color.slate.400'], '#94a3b8')
  assert.equal(named['color.green.500'], '#22c55e')
  for (const [path, value] of Object.entries(named)) assert.ok(!shadows('tailwind3', path, value), `${path} ${value}`)
  assert.ok(Object.entries(named).some(([path, value]) => value === '#00aa77' && /^color\.green\.\d+$/.test(path) && !TAILWIND_STEPS.includes(Number(path.split('.')[2]))), JSON.stringify(named))
  assert.deepEqual(v3.report.find((r) => r.value === '#eab308').note, "Tailwind's yellow-500")
  assert.match(v3.report.find((r) => r.value === '#00aa77').note, /^not Tailwind's green-\d+, so named off Tailwind's steps$/)
  // Tailwind 4's palette is another: its green-500 is not #22c55e.
  const v4 = colours(propose({ sources: [], audit, fromCss, styling: ['tailwind4'] }))
  assert.equal(v4['color.green.500'], undefined)
  for (const [path, value] of Object.entries(v4)) assert.ok(!shadows('tailwind4', path, value), `${path} ${value}`)
  // A repo without Tailwind names its colours as before.
  const plain = colours(propose({ sources: [], audit, fromCss, styling: ['css'] }))
  assert.equal(plain['color.yellow.300'], '#eab308')
})

test('a Tailwind config whose colours went unread keeps every proposed colour off Tailwind\'s steps', () => {
  const audit = { colorClusters: [cluster('#22c55e', { bg: 3 })] }
  const sources = [{ kind: 'tailwind', tokens: [], notes: [], partial: ['color'], extendOnly: [] }]
  const named = colours(propose({ sources, audit, fromCss, styling: ['tailwind3'] }))
  assert.deepEqual(Object.keys(named).map((p) => TAILWIND_STEPS.includes(Number(p.split('.')[2]))), [false])
})

test("a light app's semantic colours come from its body rule, never a dark template's background or a button's white text", () => {
  const app = [
    '.panel-a { background: #0a0a0f; } .panel-b { background: #0a0a0f; } .panel-c { background: #0a0a0f; }',
    '.t1 { color: #555577; } .t2 { color: #555577; } .t3 { color: #555577; } .t4 { color: #555577; }',
    '.s1 { color: #8888aa; } .s2 { color: #8888aa; }',
    '.btn-a { background: #d43bd4; color: #ffffff; } .btn-b { background: #d43bd4; color: #ffffff; } .btn-c { background: #d43bd4; color: #ffffff; }',
  ].join('\n')
  const r = repo(
    { 'src/styles/main.css': 'body {\n  background: #f0f0f8;\n  min-height: 100vh;\n}\n', 'src/app.css': app, 'package.json': '{"name":"acme"}' },
    { styling: ['tailwind3'], tokens: { styleFiles: ['src/styles/main.css'] } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(draft(r.root, 'base.tokens.json'))
    const report = read(draft(r.root, 'report.md'))
    const target = (alias) => alias.slice(1, -1).split('.').reduce((node, k) => node[k], base)
    // The page background is the body's, set once, and kept as a primitive.
    assert.equal(target(base.color.bg.default.$value).$value.hex, '#f0f0f8')
    assert.match(report, /\| `color\.bg\.default` \| \{color\.neutral\.\d+\} \| the page's background, set on body in src\/styles\/main\.css \|/)
    // Dark text that reads on it, not the button's white.
    assert.equal(target(base.color.text.default.$value).$value.hex, '#555577')
    assert.deepEqual(base.color.text.default.$extensions.massimo.contrast, { on: 'color.bg.default', use: 'text' })
    for (const t of Object.values(base.color.text)) assert.notEqual(target(t.$value).$value.hex, '#ffffff')
    for (const t of Object.values(base.color.bg)) assert.notEqual(target(t.$value).$value.hex, '#0a0a0f')
  } finally {
    r.cleanup()
  }
  // With no body rule, a light app whose only page-sized background is dark
  // gets no semantic colour, and the note says why.
  const audit = { colorClusters: [cluster('#0a0a0f', { bg: 5 }), cluster('#ffffff', { text: 3 }), cluster('#555577', { text: 17 })] }
  const none = propose({ sources: [], audit, fromCss, styling: ['tailwind3'], defaultMode: 'light' })
  assert.equal(none.tokens.filter((t) => /^color\.(?:bg|text|border|accent)\./.test(t.path.join('.'))).length, 0)
  assert.ok(none.notes.some((n) => /^No semantic colour is proposed: the most used background in the code, #0a0a0f, is dark while tokens\.defaultMode is light/.test(n)), none.notes.join('\n'))
  // The same app set to dark keeps its dark background.
  const dark = propose({ sources: [], audit, fromCss, styling: ['tailwind3'], defaultMode: 'dark' })
  assert.ok(dark.tokens.some((t) => t.path.join('.') === 'color.bg.default'))
})

test("the page's colours from @apply and the dark selector: a config colour, Tailwind's own, and the dark theme's values", () => {
  const r = repo(
    {
      'src/styles/main.css': [
        '@tailwind base;',
        '@layer base {',
        '  body {',
        '    @apply bg-white text-slate-900 antialiased dark:bg-surface-900;',
        '  }',
        '}',
        '.dark body { color: #cccccc; }',
        '@media (min-width: 640px) { body { background: #ff0000; } }',
        '',
      ].join('\n'),
      'tailwind.config.js': "module.exports = { theme: { extend: { colors: { surface: { 900: '#0f0f23', 800: '#13132b', 700: '#1a1a35' } } } } }\n",
      'src/app.css': '.a { color: #333344; } .b { color: #333344; } .c { background: #f4f4f7; } .d { background: #f4f4f7; }\n',
      'package.json': '{"name":"acme"}',
    },
    { styling: ['tailwind3'], tokens: { styleFiles: ['src/styles/main.css'], tailwindConfig: 'tailwind.config.js' } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(draft(r.root, 'base.tokens.json'))
    const dark = readJson(draft(r.root, 'theme', 'dark.tokens.json'))
    const target = (alias) => alias.slice(1, -1).split('.').reduce((node, k) => node[k], base)
    // bg-white and text-slate-900 are Tailwind's own: slate-900 keeps Tailwind's name and value.
    assert.equal(target(base.color.bg.default.$value).$value.hex, '#ffffff')
    assert.equal(base.color.text.default.$value, '{color.slate.900}')
    assert.equal(base.color.slate['900'].$value.hex, '#0f172a')
    // The dark theme: the config's surface.900 from dark:, and the dark selector's text.
    assert.equal(dark.color.bg.default.$value, '{color.surface.900}')
    assert.equal(target(dark.color.text.default.$value).$value.hex, '#cccccc')
    // A rule at a width is not the page.
    assert.ok(!JSON.stringify(base).includes('#ff0000'))
    // The surface ramp is primitives: no step is described as a background.
    assert.equal(base.color.surface['900'].$description, undefined)
  } finally {
    r.cleanup()
  }
})

test('a numbered ramp named like a role is primitives: semantic colours are proposed from usage, or the note says why not', () => {
  const surface = ['950', '900', '800', '700'].map((step, i) => ({ path: ['color', 'surface', step], type: 'color', value: ['#0a0a1a', '#0f0f23', '#13132b', '#1a1a35'][i], modes: {}, source: 'tailwind.config.js' }))
  const sources = [{ kind: 'tailwind', tokens: surface, notes: [] }]
  const audit = { colorClusters: [cluster('#0f0f23', { bg: 4 }), cluster('#ffffff', { text: 6 }), cluster('#ffffff66', { text: 3 })] }
  const out = propose({ sources, audit, fromCss, styling: ['tailwind3'], defaultMode: 'dark' })
  const byPath = Object.fromEntries(out.tokens.map((t) => [t.path.join('.'), t]))
  assert.equal(byPath['color.surface.900'].description ?? '', '')
  assert.equal(byPath['color.bg.default'].value, '{color.surface.900}')
  assert.equal(byPath['color.text.default'].contrast.on, 'color.bg.default')
  // With nothing to propose from, the note says no semantic colour is proposed.
  const bare = propose({ sources, audit: { colorClusters: [] }, fromCss, styling: ['tailwind3'], defaultMode: 'dark' })
  assert.ok(bare.notes.some((n) => n.startsWith('No semantic colour is proposed:')), bare.notes.join('\n'))
})

test('a cluster is covered by the nearest token, and a transparent token covers no translucent colour', () => {
  const tokens = [
    { path: ['color', 'background'], type: 'color', value: '#f9fafb' },
    { path: ['color', 'transparent'], type: 'color', value: 'transparent' },
    { path: ['color', 'white'], type: 'color', value: '#fff' },
  ].map((t) => ({ ...t, modes: {}, source: 'src/colors.css' }))
  const audit = { colorClusters: [cluster('#ffffff', { bg: 25 }), cluster('#0000000d', { shadow: 5, bg: 4 }, ['#0000000d', '#0000000a'])] }
  const out = propose({ sources: [{ kind: 'css', tokens, notes: [] }], audit, fromCss })
  const note = (token) => out.report.find((r) => r.token === token).note
  assert.match(note('color.white'), /^covers #ffffff, used 25× in code/)
  assert.doesNotMatch(note('color.background'), /covers/)
  assert.doesNotMatch(note('color.transparent'), /covers/)
  assert.equal(colours(out)['color.overlay.black-5'], '#0000000d')
})
