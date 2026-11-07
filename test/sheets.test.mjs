// lib/sheets.mjs on its own: which comment describes a declaration, how a
// theme's selector is matched, and what each value in the inventory reads
// its var() through.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalSelector, cssRules, inventoryOf, themePlacer } from '../scripts/lib/sheets.mjs'

const comments = (css) => Object.fromEntries(cssRules(css).flatMap((r) => r.decls.map((d) => [d.prop, d.comment])))
const config = (tokens = {}) => ({ tokens: { styleFiles: ['tokens.css'], darkSelector: 'html.dark', darkMedia: false, ...tokens } })
const resolvedAt = (doc, name, selector, file = 'tokens.css') => doc.tokens.find((t) => t.name === name && t.file === file).values.find((v) => v.selector === selector).resolved

test("a declaration's own comment describes it; a comment that opens a section does not", () => {
  const css = `:root {
  /* ── Palette ─────────── */
  --a: 1;
  --b: 2; /* two */

  /* ── Scale ───────────── */
  --c: 3; /* three */
  /* A plain note. */
  --d: 4; /* four */
}
.band {
  /* The band's mark. */
  --e: 5; /* its own */
}
.card {
  /* The card's ground. */
  --f: 6;
}`
  assert.deepEqual(comments(css), { '--a': '', '--b': 'two', '--c': 'three', '--d': 'A plain note.', '--e': 'its own', '--f': "The card's ground." })
})

test('a theme is matched by its selector, whatever the quotes and spaces round an attribute value', () => {
  assert.equal(canonicalSelector("[data-theme='brand']"), '[data-theme=brand]')
  assert.equal(canonicalSelector('[ data-theme = "brand" ]   .card'), '[data-theme=brand] .card')
  assert.equal(canonicalSelector('[data-theme="two words"]'), '[data-theme="two words"]')
  const { place, inside } = themePlacer({ tokens: { darkSelector: '[data-theme="dark"]', selectors: { brand: "html[data-theme='brand']" } } })
  assert.equal(place('[data-theme=dark]', []), 'dark')
  assert.equal(place('html[data-theme="brand"]', []), 'brand')
  assert.deepEqual(inside("[data-theme='dark'] .card"), { mode: 'dark', theme: '[data-theme=dark]' })
})

test('a theme under a condition, and a scope under the dark colour-scheme query, resolve in that theme', () => {
  const width = ':root { --a: 0 0 0; --b: rgb(var(--a)); } html.dark { --a: 255 255 255; } @media (max-width: 60rem) { html.dark { --b: rgb(var(--a) / 0.5); } }'
  assert.equal(resolvedAt(inventoryOf([{ file: 'tokens.css', css: width }], config()), '--b', '@media (max-width: 60rem) html.dark'), 'rgb(255 255 255 / 0.5)')

  const scheme = ':root { --a: #000000; } @media (prefers-color-scheme: dark) { :root { --a: #ffffff; } .band { --b: var(--a); } } .band { --b: var(--a); }'
  const doc = inventoryOf([{ file: 'tokens.css', css: scheme }], config({ darkSelector: '.dark', darkMedia: true }))
  assert.equal(resolvedAt(doc, '--b', '@media (prefers-color-scheme: dark) .band'), '#ffffff')
  assert.equal(resolvedAt(doc, '--b', '.band'), '#000000')
})

test("a theme's value reads its own selector before another one in the same theme", () => {
  const css = ':root { --a: #000000; } .dark { --a: #111111; --c: var(--a); } @media (prefers-color-scheme: dark) { :root { --a: #222222; --c: var(--a); } }'
  const doc = inventoryOf([{ file: 'tokens.css', css }], config({ darkSelector: '.dark', darkMedia: true }))
  assert.equal(resolvedAt(doc, '--c', '.dark'), '#111111')
  assert.equal(resolvedAt(doc, '--c', '@media (prefers-color-scheme: dark) :root'), '#222222')
})

test("each sheet resolves through its own declarations and the style files', never another listed sheet's", () => {
  const sheets = [
    { file: 'a.css', css: ':root { --brand: #ff0000; --accent: var(--brand); }' },
    { file: 'b.css', css: ':root { --brand: #0000ff; } .x { --edge: var(--brand); }' },
    { file: 'c.css', css: '.y { --edge: var(--brand); --ink: var(--ink-base); } .band { --rule: var(--ground); }' },
    { file: 'tokens.css', css: ':root { --brand: #00ff00; --ink-base: #111111; } .band { --ground: #333333; }' },
  ]
  const doc = inventoryOf(sheets, config())
  assert.equal(resolvedAt(doc, '--accent', ':root', 'a.css'), '#ff0000')
  assert.equal(resolvedAt(doc, '--edge', '.x', 'b.css'), '#0000ff')
  assert.equal(resolvedAt(doc, '--edge', '.y', 'c.css'), '#00ff00')
  assert.equal(resolvedAt(doc, '--ink', '.y', 'c.css'), '#111111')
  // The style files' scope of the same name applies to the sheet's own.
  assert.equal(resolvedAt(doc, '--rule', '.band', 'c.css'), '#333333')
})
