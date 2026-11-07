// The Figma mirror: variables, scopes and styles from the tokens, recording
// what a file holds (with the one-mode Starter case), and a three-way drift
// report that puts each change down to code, to Figma, or to both.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { driftReport, recordMirror, sameValue } from '../scripts/lib/figma.mjs'
import { read, readJson, run, withTokens } from './helpers.mjs'

const wanted = {
  defaultMode: 'Light',
  collections: [
    {
      name: 'Primitives',
      modes: ['Light'],
      variables: [
        { name: 'color/blue', type: 'COLOR', values: { Light: { r: 0, g: 0, b: 1, a: 1 } } },
        { name: 'space/2', type: 'FLOAT', values: { Light: 8 } },
      ],
    },
    {
      name: 'Semantic',
      modes: ['Light', 'Dark'],
      variables: [{ name: 'color/accent', type: 'COLOR', values: { Light: { alias: 'color/blue', collection: 'Primitives' }, Dark: { r: 1, g: 1, b: 1, a: 1 } } }],
    },
  ],
  textStyles: [{ name: 'text/body' }],
  effectStyles: [{ name: 'shadow/card' }],
}

// What Figma would hold after a faithful mirror, with ids.
// A deep copy, so changing the export never changes what code wants.
const exportOf = (input, change = (x) => x) => {
  const doc = JSON.parse(JSON.stringify(input))
  return change({
    collections: doc.collections.map((c) => ({ ...c, variables: c.variables.map((v) => ({ ...v, id: `VariableID:${v.name}` })) })),
    textStyles: doc.textStyles.map((s) => ({ ...s, id: `S:${s.name}` })),
    effectStyles: doc.effectStyles.map((s) => ({ ...s, id: `S:${s.name}` })),
  })
}

test('values compare as Figma stores them', () => {
  assert.ok(sameValue({ r: 0.5, g: 0, b: 0, a: 1 }, { r: 0.5005, g: 0, b: 0, a: 1 }))
  assert.ok(!sameValue({ r: 0.5, g: 0, b: 0, a: 1 }, { r: 0.51, g: 0, b: 0, a: 1 }))
  assert.ok(sameValue(8, 8.0004))
  assert.ok(!sameValue({ alias: 'a', collection: 'X' }, { alias: 'a', collection: 'Y' }))
})

test('recording a faithful file: no mismatches, ids kept, components kept', () => {
  const { mirror, mismatches } = recordMirror(wanted, exportOf(wanted), { fileKey: 'abc', tokensHash: 'h', date: '2026-11-07', previous: { components: { 'src/Button.tsx': { nodeId: '1:2' } } } })
  assert.deepEqual(mismatches, [])
  assert.equal(mirror.modes, 'all')
  assert.equal(mirror.variables['color/accent'].id, 'VariableID:color/accent')
  assert.deepEqual(mirror.textStyles, { 'text/body': 'S:text/body' })
  assert.deepEqual(mirror.components, { 'src/Button.tsx': { nodeId: '1:2' } })
})

test('recording names every mismatch, and a one-mode file mirrors the default only', () => {
  const broken = exportOf(wanted, (e) => {
    e.collections[0].variables[1].values.Light = 12
    e.collections[0].variables.shift()
    e.textStyles = []
    return e
  })
  const { mismatches } = recordMirror(wanted, broken, { date: 'd' })
  assert.deepEqual(mismatches, [
    'variable color/blue is not in Figma',
    'variable space/2 (Light) is 12 in Figma, 8 in code',
    'text style text/body is not in Figma',
  ])
  const starter = exportOf(wanted, (e) => {
    e.collections[1].modes = ['Light']
    delete e.collections[1].variables[0].values.Dark
    return e
  })
  const { mirror, mismatches: none } = recordMirror(wanted, starter, { date: 'd' })
  assert.deepEqual(none, [])
  assert.equal(mirror.modes, 'default only')
  assert.deepEqual(Object.keys(mirror.variables['color/accent'].values), ['Light'])
})

test('drift: each change is put down to code, to Figma, or to both', () => {
  const { mirror } = recordMirror(wanted, exportOf(wanted), { date: '2026-11-01' })
  const code = JSON.parse(JSON.stringify(wanted))
  code.collections[0].variables[1].values.Light = 12 // code moved space/2
  code.collections[0].variables.push({ name: 'space/4', type: 'FLOAT', values: { Light: 16 } }) // new in code
  code.collections[1].variables[0].values.Dark = { r: 0, g: 0, b: 0, a: 1 } // both move color/accent dark
  const figma = exportOf(wanted, (e) => {
    e.collections[0].variables[0].values.Light = { r: 0, g: 0, b: 0.8, a: 1 } // a designer moved color/blue
    e.collections[1].variables[0].values.Dark = { r: 0.5, g: 0.5, b: 0.5, a: 1 }
    e.collections[0].variables.push({ name: 'color/pink', type: 'COLOR', values: { Light: { r: 1, g: 0.5, b: 0.8, a: 1 } } })
    e.effectStyles = []
    return e
  })
  const { markdown, sections, total } = driftReport(code, mirror, figma, { date: '2026-11-07' })
  assert.equal(total, 6)
  assert.deepEqual(sections.code, ['`space/2` (Light): mirrored 8, now 12 in code'])
  assert.deepEqual(sections.figma, ['`color/blue` (Light): mirrored rgba(0, 0, 255, 1), now rgba(0, 0, 204, 1) in Figma', 'effect style `shadow/card`: deleted in Figma'])
  assert.deepEqual(sections.both, ['`color/accent` (Dark): mirrored rgba(255, 255, 255, 1), now rgba(0, 0, 0, 1) in code and rgba(128, 128, 128, 1) in Figma'])
  assert.deepEqual(sections.onlyFigma, ['`color/pink`: made in Figma, not in code'])
  assert.deepEqual(sections.onlyCode, ['`space/4`: new in code, not mirrored yet'])
  assert.match(markdown, /^# Figma drift\n\n2026-11-07 · compared with the mirror recorded on 2026-11-01\./)
  assert.match(markdown, /## Figma changed\n\nA designer edited the library: for each, adopt it in code or revert Figma\./)
  assert.equal(driftReport(wanted, mirror, exportOf(wanted)).markdown.includes('Figma matches code. Nothing to do.'), true)
})

test('the CLI: build, record a faithful export, then drift after both sides move', () => {
  const t = withTokens({
    color: { $type: 'color', blue: { $value: '#0000ff' }, accent: { $value: '{color.blue}', $extensions: { massimo: { modes: { dark: '#ffffff' } } } } },
    motion: { $type: 'duration', fast: { $value: '0.15s' } },
    text: { $type: 'typography', body: { $value: { fontFamily: 'Inter', fontSize: '1rem', fontWeight: 400, lineHeight: '1.5', letterSpacing: '-0.01em' } } },
  })
  try {
    assert.equal(run('tokens', t, ['build']).status, 0)
    const figma = readJson(t.project, 'tokens', 'figma-variables.json')
    const byName = (n) => figma.collections.flatMap((c) => c.variables).find((v) => v.name === n)
    assert.deepEqual(byName('motion/fast').values, { Light: 150 }) // durations in ms
    assert.deepEqual(figma.textStyles[0], {
      name: 'text/body',
      description: '',
      fontFamily: 'Inter',
      fontWeight: 400,
      fontStyle: 'Regular',
      fontSize: 16,
      lineHeight: { unit: 'PERCENT', value: 150 },
      letterSpacing: { unit: 'PERCENT', value: -1 }, // em is a percentage of the font size in Figma
    })
    const exportPath = join(t.project, 'figma', 'export.json')
    mkdirSync(join(t.project, 'figma'), { recursive: true })
    writeFileSync(exportPath, JSON.stringify(exportOf(figma)))
    const recorded = run('tokens', t, ['figma', '--record', exportPath, '--file-key', 'KEY'])
    assert.equal(recorded.status, 0, recorded.stderr)
    assert.match(recorded.stdout, /recorded 3 variables, 1 text styles and 0 effect styles .*; 0 mismatches with code/)
    assert.equal(readJson(t.project, 'figma', 'mirror.json').fileKey, 'KEY')
    assert.match(run('tokens', t, ['check']).stdout, /figma mirror current/)

    writeFileSync(join(t.root, 'design-system', 'tokens', 'tokens.json'), JSON.stringify({
      color: { $type: 'color', blue: { $value: '#0000cc' }, accent: { $value: '{color.blue}', $extensions: { massimo: { modes: { dark: '#ffffff' } } } } },
      motion: { $type: 'duration', fast: { $value: '0.15s' } },
      text: { $type: 'typography', body: { $value: { fontFamily: 'Inter', fontSize: '1rem', fontWeight: 400, lineHeight: '1.5', letterSpacing: '-0.01em' } } },
    }))
    assert.match(run('tokens', t, ['check']).stdout, /figma mirror behind/)
    const drift = run('tokens', t, ['figma', '--drift', exportPath])
    assert.equal(drift.status, 0, drift.stderr)
    assert.match(drift.stdout, /1 difference since the mirror/)
    assert.match(read(t.project, 'figma', 'drift.md'), /## Code changed\n\nFigma is behind: mirror these again\.\n\n- `color\/blue` \(Light\): mirrored rgba\(0, 0, 255, 1\), now rgba\(0, 0, 204, 1\) in code/)
    assert.match(run('tokens', t, ['figma']).stderr, /usage: tokens\.mjs figma --record/)
  } finally {
    t.cleanup()
  }
})
