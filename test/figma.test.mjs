// The Figma mirror: variables, scopes and styles from the tokens, recording
// what a file holds (with the one-mode Starter case), and a three-way drift
// report that puts each change down to code, to Figma, or to both.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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

test('a one-mode collection in a file that has a two-mode one is missing a mode, not on a one-mode plan', () => {
  const partial = exportOf(wanted, (e) => {
    e.collections[1].modes = ['Light']
    delete e.collections[1].variables[0].values.Dark
    e.collections.push({ name: 'Elsewhere', modes: ['Light', 'Dark'], variables: [] })
    return e
  })
  const { mirror, mismatches } = recordMirror(wanted, partial, { date: 'd' })
  assert.equal(mirror.modes, 'all')
  assert.deepEqual(mismatches, ['variable color/accent (Dark) is missing in Figma, rgba(255, 255, 255, 1) in code'])
})

// A library made by hand before massimo: its own names and collection, raw
// values where code has references, and the CSS variable in its code syntax.
const coded = {
  defaultMode: 'Light',
  collections: [
    { name: 'Primitives', modes: ['Light'], variables: [{ name: 'color/paper', type: 'COLOR', values: { Light: { r: 0.9, g: 0.9, b: 0.8, a: 1 } }, codeSyntax: { WEB: 'var(--paper)' } }, { name: 'color/ink', type: 'COLOR', values: { Light: { r: 0.1, g: 0.1, b: 0.1, a: 1 } }, codeSyntax: { WEB: 'var(--ink)' } }] },
    { name: 'Semantic', modes: ['Light', 'Dark'], variables: [{ name: 'color/ground', type: 'COLOR', values: { Light: { alias: 'color/paper', collection: 'Primitives' }, Dark: { alias: 'color/ink', collection: 'Primitives' } }, codeSyntax: { WEB: 'var(--c-ground)' } }] },
  ],
  textStyles: [],
  effectStyles: [],
}
const handmade = () => ({
  collections: [
    {
      name: 'Paper',
      modes: ['Light', 'Dark'],
      variables: [
        { id: 'V:1', name: 'c-ground', type: 'COLOR', codeSyntax: { WEB: 'var(--c-ground)' }, values: { Light: { r: 0.9, g: 0.9, b: 0.8, a: 1 }, Dark: { r: 0.1, g: 0.1, b: 0.1, a: 1 } } },
        { id: 'V:2', name: 'tone-block/c-ground', type: 'COLOR', codeSyntax: { WEB: 'var(--c-ground)' }, values: { Light: { r: 0.8, g: 0.3, b: 0.1, a: 1 }, Dark: { r: 0.9, g: 0.5, b: 0.4, a: 1 } } },
      ],
    },
  ],
  textStyles: [],
  effectStyles: [],
})

test('a library made by hand is paired by code syntax, compared resolved, and never duplicated', () => {
  const { mirror, mismatches, notes } = recordMirror(coded, handmade(), { date: '2026-11-07' })
  // color/ground is c-ground: references resolved, its own name and collection kept.
  assert.ok(!mismatches.some((m) => /color\/ground/.test(m)), mismatches.join('\n'))
  assert.deepEqual(mismatches, ['variable color/paper is not in Figma', 'variable color/ink is not in Figma'])
  assert.ok(notes.includes('variable color/ground is c-ground in Figma (Paper), paired by its code syntax --c-ground'))
  assert.ok(notes.includes('tone-block/c-ground (Paper) also names --c-ground in its code syntax; c-ground (Paper) was paired with color/ground'))
  assert.deepEqual({ figmaName: mirror.variables['color/ground'].figmaName, match: mirror.variables['color/ground'].match }, { figmaName: 'c-ground', match: 'code' })
  assert.equal(mirror.modes, 'all')
  // Recorded again, the pair is still one made by code syntax, compared resolved.
  const again = recordMirror(coded, handmade(), { date: 'd', previous: mirror })
  assert.ok(again.notes.includes('variable color/ground is c-ground in Figma (Paper), paired by its code syntax --c-ground'))
  assert.equal(again.mirror.variables['color/ground'].match, 'code')
  assert.ok(!again.mismatches.some((m) => /color\/ground/.test(m)))
  // A value that really differs is still a mismatch, shown resolved.
  const off = handmade()
  off.collections[0].variables[0].values.Dark = { r: 1, g: 0, b: 0, a: 1 }
  assert.ok(recordMirror(coded, off, { date: 'd' }).mismatches.includes('variable color/ground (Dark) is rgba(255, 0, 0, 1) in Figma, rgba(26, 26, 26, 1) in code'))
  // Drift follows the pair: a designer's edit is a Figma change under both names; the override is only in Figma.
  const edited = handmade()
  edited.collections[0].variables[0].values.Light = { r: 1, g: 1, b: 1, a: 1 }
  const { sections } = driftReport(coded, mirror, edited)
  assert.deepEqual(sections.figma, ['`color/ground` (`c-ground` in Figma) (Light): mirrored rgba(230, 230, 204, 1), now rgba(255, 255, 255, 1) in Figma'])
  assert.deepEqual(sections.onlyFigma, ['`tone-block/c-ground`: made in Figma, not in code'])
})

test('a variable renamed in Figma stays paired by the id recorded last time', () => {
  const { mirror } = recordMirror(wanted, exportOf(wanted), { date: '2026-11-01' })
  // read-library.js names every reference by its target's current name.
  const renamed = exportOf(wanted, (e) => {
    e.collections[0].variables[0].name = 'color/brand'
    e.collections[1].variables[0].values.Light = { alias: 'color/brand', collection: 'Primitives' }
    return e
  })
  const again = recordMirror(wanted, renamed, { date: 'd', previous: mirror })
  assert.ok(!again.mismatches.some((m) => /color\/blue/.test(m)), again.mismatches.join('\n'))
  assert.ok(again.notes.includes('variable color/blue is color/brand in Figma, paired by the id recorded last time'))
  assert.deepEqual(again.mismatches, [])
  const { sections } = driftReport(wanted, mirror, renamed)
  assert.deepEqual(sections.onlyFigma, [])
  assert.deepEqual(sections.figma, [])
  // An id now on a variable of another type is not the same variable.
  const swapped = JSON.parse(JSON.stringify(mirror))
  swapped.variables['color/blue'].id = mirror.variables['space/2'].id
  assert.ok(!recordMirror(wanted, exportOf(wanted), { date: 'd', previous: swapped }).mismatches.some((m) => /is FLOAT, not COLOR/.test(m)))
  // Ids are local to a file: recorded against another file, the id is not used.
  const elsewhere = recordMirror(wanted, renamed, { date: 'd', previous: { ...mirror, fileKey: 'OLD' }, fileKey: 'NEW' })
  assert.ok(elsewhere.mismatches.includes('variable color/blue is not in Figma'))
})

test('a reference to a variable paired by code syntax is compared in code terms', () => {
  const code = {
    defaultMode: 'Light',
    collections: [{ name: 'Tokens', modes: ['Light'], variables: [
      { name: 'color/blue', type: 'COLOR', values: { Light: { r: 0, g: 0, b: 1, a: 1 } }, codeSyntax: { WEB: 'var(--color-blue)' } },
      { name: 'color/accent', type: 'COLOR', values: { Light: { alias: 'color/blue', collection: 'Tokens' } }, codeSyntax: { WEB: 'var(--color-accent)' } },
    ] }],
    textStyles: [],
    effectStyles: [],
  }
  const figma = { collections: [
    { name: 'Brand', modes: ['Light'], variables: [{ id: 'B:1', name: 'brand-blue', type: 'COLOR', codeSyntax: { WEB: 'var(--color-blue)' }, values: { Light: { r: 0, g: 0, b: 1, a: 1 } } }] },
    { name: 'Tokens', modes: ['Light'], variables: [{ id: 'T:1', name: 'color/accent', type: 'COLOR', values: { Light: { alias: 'brand-blue', collection: 'Brand' } } }] },
  ], textStyles: [], effectStyles: [] }
  const { mismatches, mirror } = recordMirror(code, figma, { date: 'd' })
  assert.deepEqual(mismatches, [])
  assert.equal(driftReport(code, mirror, figma).total, 0)
})

test('drift: a change to what a hand-made variable points at is a Figma change; a missing mode then filled is none', () => {
  const code = {
    defaultMode: 'Light',
    collections: [{ name: 'Semantic', modes: ['Light', 'Dark'], variables: [{ name: 'color/ground', type: 'COLOR', values: { Light: { r: 0.9, g: 0.9, b: 0.8, a: 1 }, Dark: { r: 0.1, g: 0.1, b: 0.1, a: 1 } }, codeSyntax: { WEB: 'var(--c-ground)' } }] }],
    textStyles: [],
    effectStyles: [],
  }
  const figma = (paper, dark) => ({ collections: [
    { name: 'Raw', modes: ['Light', 'Dark'], variables: [{ id: 'R:1', name: 'paper', type: 'COLOR', values: { Light: paper, Dark: paper } }] },
    { name: 'Paper', modes: ['Light', 'Dark'], variables: [{ id: 'P:1', name: 'c-ground', type: 'COLOR', codeSyntax: { WEB: 'var(--c-ground)' }, values: { Light: { alias: 'paper', collection: 'Raw' }, ...(dark ? { Dark: dark } : {}) } }] },
  ], textStyles: [], effectStyles: [] })
  const first = figma({ r: 0.9, g: 0.9, b: 0.8, a: 1 }, null)
  const { mirror, mismatches } = recordMirror(code, first, { date: 'd' })
  assert.deepEqual(mismatches, ['variable color/ground (Dark) is missing in Figma, rgba(26, 26, 26, 1) in code'])
  // Dark added in Figma with code's value: no change.
  assert.equal(driftReport(code, mirror, figma({ r: 0.9, g: 0.9, b: 0.8, a: 1 }, { r: 0.1, g: 0.1, b: 0.1, a: 1 })).sections.figma.length, 0)
  // The primitive it points at moved: a Figma change, shown resolved.
  const { sections } = driftReport(code, mirror, figma({ r: 1, g: 0, b: 0, a: 1 }, null))
  assert.deepEqual(sections.figma, ['`color/ground` (`c-ground` in Figma) (Light): mirrored rgba(230, 230, 204, 1), now rgba(255, 0, 0, 1) in Figma'])
})

test('one name in two collections: the one first in the file is paired by code syntax, the other is noted and stays in Figma', () => {
  const code = { defaultMode: 'Light', collections: [{ name: 'Semantic', modes: ['Light'], variables: [{ name: 'color/ground', type: 'COLOR', values: { Light: { r: 1, g: 1, b: 1, a: 1 } }, codeSyntax: { WEB: 'var(--c-ground)' } }] }], textStyles: [], effectStyles: [] }
  const figma = { collections: [
    { name: 'Page', modes: ['Light'], variables: [{ id: 'A', name: 'c-ground', type: 'COLOR', codeSyntax: { WEB: 'var(--c-ground)' }, values: { Light: { r: 1, g: 1, b: 1, a: 1 } } }] },
    { name: 'Tone block', modes: ['Light'], variables: [{ id: 'B', name: 'c-ground', type: 'COLOR', codeSyntax: { WEB: 'var(--c-ground)' }, values: { Light: { r: 1, g: 0, b: 0, a: 1 } } }] },
  ], textStyles: [], effectStyles: [] }
  const { mismatches, notes, mirror } = recordMirror(code, figma, { date: 'd' })
  assert.deepEqual(mismatches, [])
  assert.equal(mirror.variables['color/ground'].figmaCollection, 'Page')
  assert.ok(notes.includes('c-ground (Tone block) also names --c-ground in its code syntax; c-ground (Page) was paired with color/ground'), notes.join('\n'))
  assert.deepEqual(driftReport(code, mirror, figma).sections.onlyFigma, ['`c-ground`: made in Figma, not in code'])
})

test('drift: a Figma variable now paired with another code variable is not reported as still in Figma', () => {
  const { mirror } = recordMirror(wanted, exportOf(wanted), { date: '2026-11-01' })
  // Renamed blue to brand on both sides.
  const code = JSON.parse(JSON.stringify(wanted))
  code.collections[0].variables[0].name = 'color/brand'
  code.collections[1].variables[0].values.Light = { alias: 'color/brand', collection: 'Primitives' }
  const figma = exportOf(code, (e) => {
    e.collections[0].variables[0].id = 'VariableID:color/blue'
    return e
  })
  const { sections } = driftReport(code, mirror, figma)
  assert.ok(sections.code.includes('`color/blue`: removed from code; its Figma variable is now paired with `color/brand`; record the mirror again'), sections.code.join('\n'))
  assert.ok(!sections.code.some((l) => /still in Figma/.test(l)))
  assert.deepEqual(sections.figma, [])
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
    // --pairs reads and reports, and writes nothing.
    const pairs = run('tokens', t, ['figma', '--pairs', exportPath])
    assert.equal(pairs.status, 0, pairs.stderr)
    assert.match(pairs.stdout, /(\d+) of \1 variables pair with the file \(\1 by name, 0 by id, 0 by code syntax\), 0 differences; nothing written/)
    assert.ok(!existsSync(join(t.project, 'figma', 'mirror.json')))
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
    assert.match(run('tokens', t, ['figma']).stderr, /usage: tokens\.mjs figma --pairs <export\.json> \| --record/)
  } finally {
    t.cleanup()
  }
})
