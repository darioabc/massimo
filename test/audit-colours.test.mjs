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
    "const fill = '#d35400'",
    '',
  ].join('\n'))
  const latest = audit(ctx)
  for (const hex of ['#c0392b', '#2980b9', '#27ae60', '#8e44ad']) assert.deepEqual(cluster(latest, hex)?.roles, { fill: 1 }, hex)
  assert.deepEqual(cluster(latest, '#d35400')?.roles, { other: 1 })
})

test('the nearest token follows channel triplets and var() chains in the style files', () => {
  const ctx = fresh()
  appendFileSync(join(ctx.root, 'src', 'styles', 'theme.css'), ':root {\n  --teal-9: 184 58% 28%;\n  --color-teal: hsl(var(--teal-9));\n}\n')
  writeFileSync(join(ctx.root, 'src', 'teal.tsx'), "export const T = () => <p style={{ color: '#1e6c71' }} />\n")
  const near = cluster(audit(ctx), '#1e6c71')?.nearestToken
  // The triplet holds the colour itself, so it is named before the var() that reads it.
  assert.equal(near?.name, '--teal-9')
  assert.equal(near?.value, '#1e6b71')
  assert.ok(near.distance < 0.01, String(near.distance))
  assert.match(read(ctx.project, 'audits', 'latest.md'), /- #1e6c71 ×1 · nearest token `--teal-9` #1e6b71/)
})

test('primitive reads wait for a token set with aliases, and the audit says why', () => {
  const flat = { color: { $type: 'color', bg: { $value: '#ffffff' }, text: { $value: '#111111' } } }
  const ctx = fresh(withTokens(flat))
  writeFileSync(join(ctx.root, 'src', 'reads.tsx'), "export const R = () => <p style={{ color: 'var(--color-text)', background: 'var(--color-bg)' }} />\n")
  const unread = audit(ctx)
  assert.deepEqual(unread.findings.filter((f) => f.kind === 'primitive-read'), [])
  assert.match(unread.skipped['primitive-read'], /^the token set has no aliases yet/)
  assert.match(read(ctx.project, 'audits', 'latest.md'), /- primitive-read: skipped \(the token set has no aliases yet, so it has no semantic tokens to read instead of its primitives\)/)
  // One semantic token that aliases a primitive: the reads of primitives count again.
  const aliased = { color: { ...flat.color, fg: { $value: '{color.text}' } } }
  writeFileSync(join(ctx.root, 'design-system', 'tokens', 'tokens.json'), JSON.stringify(aliased))
  const counted = audit(ctx)
  assert.deepEqual(counted.findings.filter((f) => f.kind === 'primitive-read' && f.file === 'src/reads.tsx').map((f) => f.value), ['--color-bg', '--color-text'])
  assert.equal(counted.skipped['primitive-read'], undefined)
})
