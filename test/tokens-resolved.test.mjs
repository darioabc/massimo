// tokens.mjs resolved: every custom property the style files declare, per
// selector, with the colour each value resolves to in its theme, the type
// classes, the @font-face rules and the breakpoints, in tokens/resolved.json
// (format 1). --check and tokens check keep it current; a newer format is
// refused by name.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { golden, read, readJson, run, scratch } from './helpers.mjs'

const contexts = []
after(() => contexts.forEach((c) => c.cleanup()))
// A sheets fixture with the mirror off, and these token keys.
const fresh = (tokens = {}, fixture = 'sheets') => {
  const ctx = scratch(fixture)
  contexts.push(ctx)
  const path = join(ctx.root, 'massimo.config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...config, tokens: { ...config.tokens, mirror: false, outputs: [], ...tokens } }))
  return ctx
}
const resolvedOf = (ctx) => readJson(ctx.project, 'tokens', 'resolved.json')
const token = (doc, name, file = 'src/styles/theme.css') => doc.tokens.find((t) => t.name === name && t.file === file)

const INVENTORY = {
  files: ['src/styles/*.css'],
  layers: {
    band: { files: ['src/styles/theme.css'], selectors: ['.band-*'] },
    palette: { files: ['src/styles/theme.css'], names: ['--{sand,ink,cream,accent}-[0-9]*'] },
    role: { files: ['src/styles/theme.css'], names: ['--c-*'] },
    scale: ['src/styles/theme.css'],
    island: ['src/styles/island.css'],
  },
  families: { Type: ['--{font,weight}*', '--h[1-6]*'], Space: ['--space-*'], Other: ['*'] },
  typeClasses: ['t-*'],
}
const BREAKPOINTS = { scale: ['40rem', '60rem'], twins: ['40.0625rem', '60.0625rem'] }

test('golden: every value per selector, resolved in its theme, with layers, families, type classes, faces and breakpoints', () => {
  const ctx = fresh({ inventory: INVENTORY, breakpoints: BREAKPOINTS })
  const r = run('tokens', ctx, ['resolved'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^massimo tokens resolved: 37 tokens from 2 files, 4 type classes, 2 faces; wrote \S*project\/tokens\/resolved\.json\n$/)
  const text = read(ctx.project, 'tokens', 'resolved.json')
  assert.equal(text, golden('resolved/resolved.json', text) ?? text)
  const doc = JSON.parse(text)
  assert.equal(doc.format, 1)
  assert.deepEqual(doc.files, ['src/styles/island.css', 'src/styles/theme.css'])
  assert.deepEqual(doc.breakpoints, BREAKPOINTS)
  assert.deepEqual(Object.keys(doc.tokens[0]), ['name', 'file', 'layer', 'family', 'values'])

  // Each member of a selector list on its own, in source order; each colour in its theme.
  assert.deepEqual(token(doc, '--c-text').values, [
    { selector: ':root', value: 'rgb(var(--ink-900))', resolved: '#1d1f20' },
    { selector: '.band-light', value: 'rgb(var(--ink-900))', resolved: '#1d1f20' },
    { selector: 'html.dark', value: 'rgb(var(--cream-50))', resolved: '#f2f0eb' },
    { selector: '.band-dark', value: 'rgb(var(--cream-50))', resolved: '#f2f0eb' },
    { selector: '.band-block', value: 'rgb(var(--sand-200))', resolved: '#ece5d1' },
    { selector: 'html.dark .band-block', value: 'rgb(var(--ink-950))', resolved: '#161718' },
    { selector: '.dark', value: '#ffffff', resolved: '#ffffff' },
  ])
  // A scope inside the dark theme reads dark values; a band that shares a rule
  // with html.dark reads them too; the light band and the block read the root's.
  const ground = Object.fromEntries(token(doc, '--c-ground').values.map((v) => [v.selector, v.resolved]))
  assert.equal(ground['.band-block'], '#c84e22')
  assert.equal(ground['html.dark .band-block'], '#ec8f62')
  assert.deepEqual(token(doc, '--c-mark').values, [{ selector: '.band-dark', value: 'var(--c-focus)', resolved: '#ec8f62' }])
  // A scope's own values come first: the hairline mixes each band's own text colour.
  const hairline = Object.fromEntries(token(doc, '--c-hairline').values.map((v) => [v.selector, v.resolved]))
  assert.deepEqual(hairline, { ':root': 'rgb(29 31 32 / 0.24)', '.band-light': 'rgb(29 31 32 / 0.24)', '.band-dark': 'rgb(242 240 235 / 0.24)', '.band-block': 'rgb(236 229 209 / 0.24)' })
  // An override under a condition keeps its at-rule; values as written, !important too.
  assert.deepEqual(token(doc, '--section-gap').values.map((v) => v.selector), [':root', '@media (max-width: 60rem) :root'])
  assert.equal(token(doc, '--c-focus').values[1].value, 'rgb(var(--accent-300)) !important')
  assert.deepEqual(token(doc, '--u', 'src/styles/island.css').values, [{ selector: '.island', value: '1' }, { selector: '@media print .island', value: '0.75' }])
  assert.equal(token(doc, '--island-ink', 'src/styles/island.css').values[0].resolved, '#333333')
  assert.equal(token(doc, '--island-rule', 'src/styles/island.css').values[0].resolved, 'rgb(29 31 32 / 0.2)')

  // Layers by file, name and first selector, in the order the config gives them.
  const layer = (name, file) => token(doc, name, file).layer
  assert.deepEqual(['--c-art', '--c-mark', '--sand-200', '--c-text', '--space-4', '--u'].map((n) => layer(n, n === '--u' ? 'src/styles/island.css' : undefined)), ['band', 'band', 'palette', 'role', 'scale', 'island'])
  assert.deepEqual(['--h2-size', '--font-body', '--weight-semibold', '--space-4', '--c-text'].map((n) => token(doc, n).family), ['Type', 'Type', 'Type', 'Space', 'Other'])
  assert.deepEqual(doc.typeClasses, ['t-body', 't-h2', 't-print', 't-quiet'])
  assert.deepEqual(doc.faces, [
    { family: 'Geist', weight: '100 900', style: 'normal', src: '/fonts/geist.woff2', file: 'src/styles/theme.css' },
    { family: 'Geist Print', weight: '400', style: 'normal', src: '../fonts/print.woff2', file: 'src/styles/island.css' },
  ])
})

test('without tokens.inventory: the style files as one layer, massimo families, classes that set a type step', () => {
  const ctx = fresh()
  assert.equal(run('tokens', ctx, ['resolved']).status, 0)
  const doc = resolvedOf(ctx)
  assert.deepEqual(doc.files, ['src/styles/theme.css'])
  assert.equal(doc.breakpoints, undefined)
  assert.deepEqual([...new Set(doc.tokens.map((t) => t.layer))], ['tokens'])
  const family = (name) => token(doc, name).family
  assert.deepEqual(
    ['--c-text', '--sand-200', '--space-4', '--h2-size', '--h2-leading', '--font-body', '--radius-2', '--dur-2', '--ease-out', '--z-bar', '--lift'].map(family),
    ['color', 'color', 'spacing', 'typography', 'typography', 'typography', 'radius', 'motion', 'motion', 'z-index', 'other'],
  )
  assert.deepEqual(doc.typeClasses, ['t-body', 't-h2'])
})

test('a theme under a condition, a scope under the dark colour-scheme query and a theme in other quotes resolve in their theme', () => {
  const ctx = fresh({}, 'sheets-modes')
  assert.equal(run('tokens', ctx, ['resolved']).status, 0)
  const doc = resolvedOf(ctx)
  const at = (name, selector) => token(doc, name).values.find((v) => v.selector === selector)
  assert.equal(at('--text', '@media (max-width: 40rem) .dark').resolved, 'rgb(242 240 235 / 0.5)')
  assert.equal(at('--band-text', '@media (prefers-color-scheme: dark) .band').resolved, 'rgb(242 240 235 / 0.9)')
  assert.equal(at('--band-text', '.band').resolved, 'rgb(29 31 32 / 0.8)')
  assert.equal(at('--mark', ':root').resolved, '#c84e22')
  // Each selector keeps the text the CSS wrote it with.
  assert.deepEqual(token(doc, '--paper').values.map((v) => v.selector), [':root', '.dark', '@media (prefers-color-scheme: dark) :root', "[data-theme='brand']"])
})

test('resolved --check and tokens check keep resolved.json current', () => {
  const ctx = fresh({ inventory: INVENTORY })
  const missing = run('tokens', ctx, ['resolved', '--check'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /stale: \S*project\/tokens\/resolved\.json \(missing\)/)
  // With an inventory and no token set, check keeps the inventory alone.
  const before = run('tokens', ctx, ['check'])
  assert.equal(before.status, 1)
  assert.match(before.stdout, /out of date \(no token set, resolved\.json behind\)\. Run: node \.\.\/project\/scripts\/tokens\.mjs resolved/)
  assert.equal(run('tokens', ctx, ['resolved']).status, 0)
  assert.match(run('tokens', ctx, ['resolved', '--check']).stdout, /up to date \(37 tokens from 2 files\)/)
  assert.match(run('tokens', ctx, ['check']).stdout, /up to date \(no token set, resolved\.json current\)/)
  const css = join(ctx.root, 'src', 'styles', 'island.css')
  writeFileSync(css, readFileSync(css, 'utf8').replace('--island-ink: #333;', '--island-ink: #222;'))
  assert.equal(run('tokens', ctx, ['resolved', '--check']).status, 1)
  assert.equal(run('tokens', ctx, ['check']).status, 1)
})

test('a resolved.json in a newer format is refused, never rewritten or called stale', () => {
  const ctx = fresh({ inventory: INVENTORY })
  assert.equal(run('tokens', ctx, ['resolved']).status, 0)
  const newer = `${JSON.stringify({ format: 2, tokens: [] })}\n`
  writeFileSync(join(ctx.project, 'tokens', 'resolved.json'), newer)
  for (const args of [['resolved'], ['resolved', '--check'], ['check']]) {
    const r = run('tokens', ctx, args)
    assert.equal(r.status, 1, args.join(' '))
    assert.match(r.stderr, /tokens\/resolved\.json is format 2, and these scripts \([\d.]+\) read up to 1: update massimo/, args.join(' '))
  }
  assert.equal(read(ctx.project, 'tokens', 'resolved.json'), newer)
})
