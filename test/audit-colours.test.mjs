// What the audit says about colours: the job an SVG attribute's colour does,
// the nearest token through the style files' channels and var() chains, and
// primitive reads only against a token set that has semantic tokens.

import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { read, readJson, run, scratch, withTokens } from './helpers.mjs'

const contexts = []
after(() => contexts.forEach((c) => c.cleanup()))
const fresh = (ctx = scratch()) => {
  contexts.push(ctx)
  return ctx
}
const audit = (ctx) => {
  const r = run('audit', ctx)
  assert.equal(r.status, 0, r.stderr)
  return readJson(ctx.project, 'audits', 'latest.json')
}
const cluster = (latest, hex) => latest.colorClusters.find((c) => c.representative === hex)

test('SVG presentation attributes colour the drawing, so they are fills; a variable of that name holds data', () => {
  const ctx = fresh()
  writeFileSync(join(ctx.root, 'src', 'components', 'Glyph.astro'), [
    '<svg width="24" color="#c0392b" fill="none">',
    '  <path',
    '    fill="#2980b9"',
    "    stroke='#27ae60'",
    '  />',
    '</svg>',
    '',
  ].join('\n'))
  writeFileSync(join(ctx.root, 'src', 'glyph.tsx'), [
    'export const G = () => <svg><stop stopColor={"#8e44ad"} /></svg>',
    'export const F = () => <filter><feFlood flood-color="#0891b2" /><feFlood floodColor="#16a085" /></filter>',
    "const fill = '#d35400'",
    '',
  ].join('\n'))
  // Outside a tag, the same names are a reassignment, a class field and a
  // parameter's default: data, as before.
  writeFileSync(join(ctx.root, 'src', 'chart.tsx'), [
    'let color',
    "if (x) color = '#16a34a'",
    'class P {',
    "  color = '#dc2626'",
    '}',
    "function f(a, color = '#2563eb') {}",
    '',
  ].join('\n'))
  const latest = audit(ctx)
  for (const hex of ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#0891b2', '#16a085']) assert.deepEqual(cluster(latest, hex)?.roles, { fill: 1 }, hex)
  for (const hex of ['#d35400', '#16a34a', '#dc2626', '#2563eb']) assert.deepEqual(cluster(latest, hex)?.roles, { other: 1 }, hex)
})

test('the nearest token follows channel triplets and var() chains in the style files', () => {
  const ctx = fresh()
  appendFileSync(join(ctx.root, 'src', 'styles', 'theme.css'), ':root {\n  --teal-9: 184 58% 28%;\n  --color-teal: hsl(var(--teal-9));\n}\n.dark {\n  --teal-9: 184 58% 60%;\n}\n')
  writeFileSync(join(ctx.root, 'src', 'teal.tsx'), "export const T = () => <p style={{ color: '#1e6c71', background: '#5eccd4' }} />\n")
  const latest = audit(ctx)
  const near = cluster(latest, '#1e6c71')?.nearestToken
  // The triplet holds the colour itself, so it is named before the var() that reads it.
  assert.equal(near?.name, '--teal-9')
  assert.equal(near?.value, '#1e6b71')
  assert.ok(near.distance < 0.01, String(near.distance))
  const md = read(ctx.project, 'audits', 'latest.md')
  assert.match(md, /- #1e6c71 ×1 · nearest token `--teal-9` #1e6b71 \(/)
  // A value only another theme holds says which.
  const dark = cluster(latest, '#5eccd4')?.nearestToken
  assert.deepEqual(Object.keys(dark ?? {}), ['name', 'value', 'distance'])
  assert.equal(dark.name, '--teal-9')
  assert.match(md, /- #5eccd4 ×1 · nearest token `--teal-9` #5eccd4 in the dark theme \(/)
})

test('with no colour left in the style files, the nearest token comes from the token set, and latest.md names its theme', () => {
  const doc = {
    color: {
      $type: 'color',
      ink: { $value: '#1f2937' },
      mist: { $value: '#e5e7eb', $extensions: { massimo: { modes: { dark: '#3f4b5e' } } } },
      fg: { $value: '{color.ink}' },
    },
  }
  const ctx = fresh(withTokens(doc))
  // The hand-written declarations are gone: the token set's css output declares them now.
  writeFileSync(join(ctx.root, 'src', 'styles', 'theme.css'), ':root {\n  --page-max: 80rem;\n}\n')
  writeFileSync(join(ctx.root, 'src', 'raw.tsx'), "export const R = () => <p style={{ color: '#1f2938', background: '#3f4b5e' }} />\n")
  const latest = audit(ctx)
  assert.equal(cluster(latest, '#1f2938')?.nearestToken?.name, '--color-ink')
  // The theme is said in latest.md only; latest.json keeps its shape.
  assert.deepEqual(cluster(latest, '#3f4b5e')?.nearestToken, { name: '--color-mist', value: '#3f4b5e', distance: 0 })
  const md = read(ctx.project, 'audits', 'latest.md')
  assert.match(md, /- #3f4b5e ×1 · nearest token `--color-mist` #3f4b5e in the dark theme \(0\)/)
  assert.match(md, /- #1f2938 ×1 · nearest token `--color-ink` #1f2937 \(/)
})

test('primitive reads wait for a token set with aliases, and the audit says why', () => {
  const flat = { color: { $type: 'color', bg: { $value: '#ffffff' }, text: { $value: '#111111' } } }
  const ctx = fresh(withTokens(flat))
  writeFileSync(join(ctx.root, 'src', 'reads.tsx'), "export const R = () => <p style={{ color: 'var(--color-text)', background: 'var(--color-bg)' }} />\n")
  const unread = audit(ctx)
  assert.deepEqual(unread.findings.filter((f) => f.kind === 'primitive-read'), [])
  assert.match(unread.skipped['primitive-read'], /^the token set has no aliases yet/)
  assert.match(read(ctx.project, 'audits', 'latest.md'), /- primitive-read: skipped \(the token set has no aliases yet, so it has no semantic tokens to read instead of its primitives\)/)
  // One semantic token that aliases a primitive: the reads of that primitive
  // count again. No token aliases the background, so it is a role of its own.
  const aliased = { color: { ...flat.color, fg: { $value: '{color.text}' } } }
  writeFileSync(join(ctx.root, 'design-system', 'tokens', 'tokens.json'), JSON.stringify(aliased))
  const counted = audit(ctx)
  assert.deepEqual(counted.findings.filter((f) => f.kind === 'primitive-read' && f.file === 'src/reads.tsx').map((f) => f.value), ['--color-text'])
  assert.equal(counted.skipped['primitive-read'], undefined)
})

test('one alias elsewhere in the set leaves the colours no token aliases out of the primitives', () => {
  // Colours that are roles of their own beside a radius scale with one alias,
  // as an adopted shadcn draft has them, and a ramp a theme aliases.
  const srgb = (components) => ({ colorSpace: 'srgb', components })
  const doc = {
    color: {
      $type: 'color',
      primary: { $value: srgb([0.09, 0.09, 0.09]) },
      border: { $value: srgb([0.9, 0.9, 0.9]) },
      ink: { $value: srgb([0, 0, 0]) },
      page: { $value: srgb([1, 1, 1]), $extensions: { massimo: { modes: { dark: '{color.ink}' } } } },
    },
    radius: { $type: 'dimension', base: { $value: { value: 0.625, unit: 'rem' } }, lg: { $value: '{radius.base}' } },
  }
  const ctx = fresh(withTokens(doc))
  writeFileSync(
    join(ctx.root, 'src', 'reads.tsx'),
    "export const R = () => <p style={{ color: 'var(--color-primary)', borderColor: 'var(--color-border)', background: 'var(--color-ink)', borderRadius: 'var(--radius-base)' }} />\n",
  )
  const latest = audit(ctx)
  // The radius has an alias to read instead, and so has the ink, through the
  // dark theme of the page colour. The primary and border colours have none.
  assert.deepEqual(latest.findings.filter((f) => f.kind === 'primitive-read' && f.file === 'src/reads.tsx').map((f) => f.value), ['--color-ink', '--radius-base'])
  assert.equal(latest.skipped['primitive-read'], undefined)
})

test("a colour a composite token or a var() in a token's CSS refers to has an alias to read instead", () => {
  const srgb = (components) => ({ colorSpace: 'srgb', components })
  const px = (value) => ({ value, unit: 'px' })
  const doc = {
    color: {
      $type: 'color',
      line: { $value: srgb([0.9, 0.9, 0.9]) },
      shade: { $value: srgb([0, 0, 0]) },
      stop: { $value: srgb([0.2, 0.4, 0.8]) },
      ink: { $value: srgb([0.1, 0.1, 0.1]) },
      primary: { $value: srgb([0.09, 0.09, 0.09]) },
      scrim: { $value: srgb([0.1, 0.1, 0.1]), $extensions: { massimo: { css: 'rgb(var(--color-ink) / 0.5)' } } },
    },
    border: { card: { $type: 'border', $value: { color: '{color.line}', width: px(1), style: 'solid' } } },
    shadow: { card: { $type: 'shadow', $value: { color: '{color.shade}', offsetX: px(0), offsetY: px(1), blur: px(2), spread: px(0) } } },
    gradient: { hero: { $type: 'gradient', $value: [{ color: '{color.stop}', position: 0 }, { color: srgb([1, 1, 1]), position: 1 }] } },
    radius: { $type: 'dimension', base: { $value: px(4) }, card: { $value: '{radius.base}' } },
  }
  const ctx = fresh(withTokens(doc))
  writeFileSync(
    join(ctx.root, 'src', 'reads.tsx'),
    "export const R = () => <p style={{ borderColor: 'var(--color-line)', boxShadow: 'var(--color-shade)', background: 'var(--color-stop)', color: 'var(--color-ink)', outlineColor: 'var(--color-primary)', caretColor: 'var(--color-scrim)' }} />\n",
  )
  const latest = audit(ctx)
  // The border, the shadow and the gradient refer to the line, the shade and
  // the stop, and the scrim's CSS reads the ink. Nothing refers to the
  // primary or the scrim, so they are roles of their own.
  const reads = latest.findings.filter((f) => f.kind === 'primitive-read' && f.file === 'src/reads.tsx').map((f) => f.value)
  assert.deepEqual(reads.sort(), ['--color-ink', '--color-line', '--color-shade', '--color-stop'])
})

test("the nearest token keeps to the colour's opacity, and a token at another opacity never reads as a match", () => {
  const ctx = fresh()
  // Each translucent token comes before the opaque one of the same colour,
  // and the other way round, so the order of the sheet decides nothing.
  writeFileSync(join(ctx.root, 'src', 'styles', 'theme.css'), ':root {\n  --veil: #ffffff99;\n  --paper: #ffffff;\n  --violet: #6d28d9;\n  --violet-10: #6d28d91a;\n  --ink: #222222;\n}\n')
  writeFileSync(join(ctx.root, 'src', 'veils.tsx'), "export const V = () => <p style={{ color: '#ffffff', borderColor: '#6d28d91a', background: '#22222280', outlineColor: '#222222f5' }} />\n")
  const latest = audit(ctx)
  assert.deepEqual(cluster(latest, '#ffffff')?.nearestToken, { name: '--paper', value: '#ffffff', distance: 0 })
  assert.deepEqual(cluster(latest, '#6d28d91a')?.nearestToken, { name: '--violet-10', value: '#6d28d91a', distance: 0 })
  // No token is at half opacity: the nearest is the same colour, opaque, and
  // its distance is the opacity difference, not 0.
  assert.deepEqual(cluster(latest, '#22222280')?.nearestToken, { name: '--ink', value: '#222222', distance: 0.498 })
  assert.match(read(ctx.project, 'audits', 'latest.md'), /- #22222280 ×1 · nearest token `--ink` #222222 \(0\.498\)/)
  // Nearly opaque, the colour still takes the opaque token at its opacity,
  // and its distance is the opacity difference, not 0.
  assert.deepEqual(cluster(latest, '#222222f5')?.nearestToken, { name: '--ink', value: '#222222', distance: 0.0392 })

  // A token's opacity written as a fraction matches the same opacity in hex.
  const shade = fresh()
  writeFileSync(join(shade.root, 'src', 'styles', 'theme.css'), ':root {\n  --shade: rgba(0, 0, 0, 0.08);\n}\n')
  writeFileSync(join(shade.root, 'src', 'shade.tsx'), "export const S = () => <p style={{ boxShadow: '0 1px 2px #00000014' }} />\n")
  assert.deepEqual(cluster(audit(shade), '#00000014')?.nearestToken, { name: '--shade', value: '#00000014', distance: 0 })
})
