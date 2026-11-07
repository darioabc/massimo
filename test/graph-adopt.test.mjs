// The graph on a repo with its own design-system setup: its header keys read
// through roles, its taxonomy placing every node, headers read from the top
// block only, and faults that fail the run when the repo asks for that.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { SCRIPTS, read, readJson, run, scratch } from './helpers.mjs'

const ctx = scratch('adopt')
after(() => ctx.cleanup())

// A scratch copy with some files written over and the config patched.
function variant(files = {}, patch = null) {
  const t = scratch('adopt')
  for (const [path, text] of Object.entries(files)) writeFileSync(join(t.root, path), text)
  if (patch) {
    const path = join(t.root, 'massimo.config.json')
    writeFileSync(path, JSON.stringify(patch(JSON.parse(readFileSync(path, 'utf8')))))
  }
  return t
}

// The faults a variant's graph reports, as "file · key · message" lines.
function faultsOf(files, patch) {
  const t = variant(files, patch)
  try {
    const r = run('graph', t)
    assert.equal(r.status, 0, r.stderr)
    return readJson(t.project, 'graph.json').faults.map((f) => [f.file, f.key, f.message].filter(Boolean).join(' · '))
  } finally {
    t.cleanup()
  }
}

test('a repo whose headers follow its own taxonomy has no faults', () => {
  const r = run('graph', ctx)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr, '')
  const g = readJson(ctx.project, 'graph.json')
  assert.deepEqual(g.faults, [])
  assert.equal(g.summary.headerFaults, 0)
})

test('each node takes its declared group, its path rule or its parked marker', () => {
  const byFile = Object.fromEntries(readJson(ctx.project, 'graph.json').nodes.map((n) => [n.file, n]))
  assert.equal(byFile['src/components/Button.astro'].group, 'Primitives / Actions')
  assert.equal(byFile['src/components/format.ts'].group, 'Internal / Modules')
  assert.equal(byFile['src/components/format.ts'].derived, true)
  assert.equal(byFile['src/components/format.ts'].tier, 'Internal')
  assert.equal(byFile['src/components/Legacy.astro'].parked, true)
  assert.equal(byFile['src/components/Legacy.astro'].derived, undefined)
  // Role keys are read as rules, not reported as unknown.
  assert.deepEqual(byFile['src/components/Button.astro'].rules, {
    'use-when': 'a reader runs an action; a link that only navigates uses the plain anchor.',
    inputs: '--button-edge',
    styles: 'card.css',
  })
  assert.match(read(ctx.project, 'graph.md'), /^- rules: group Internal \/ Modules \(from its path\)$/m)
})

test('graph.md carries the placement test in the shape a stories page reads back', () => {
  const md = read(ctx.project, 'graph.md')
  const section = md.match(/\n## Placement test\n([\s\S]*?)\n## /)?.[1]
  assert.ok(section)
  const placement = [...section.matchAll(/^- ([^:]+): (.+)$/gm)].map((m) => ({ tier: m[1], test: m[2].replace(/`/g, '') }))
  const config = readJson(ctx.root, 'massimo.config.json')
  assert.deepEqual(placement, config.graph.taxonomy.placement.tests)
  assert.match(section, /\nFoundations is asked before Primitives because an icon is a single-job part too\.\n/)
  assert.match(md, /\n## Groups\n\n- Foundations \/ Icons: draws a glyph, picked by name\.\n- Primitives \/ Actions: /)
})

test('the index follows the taxonomy\'s tier and group order', () => {
  const md = read(ctx.project, 'graph.md')
  const order = ['**Foundations / Icons**', '**Primitives / Actions**', '**Components / Cards**', '**Internal / Modules**', '**Explorations / Kept**'].map((s) => md.indexOf(s))
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), order.join(', '))
})

test('a role problem is a fault, and a key with a role is never unknown', () => {
  const faults = faultsOf({
    'src/components/Icon.tsx': '// ds:group Foundations / Icons\n// ds:inputs width\n// ds:theme poster\n// ds:styles missing.css\n// ds:breakpoint 30rem\nexport default function Icon() { return null }\n',
  })
  assert.deepEqual(faults, [
    'src/components/Icon.tsx · ds:breakpoint · ds:breakpoint takes a width and a reason, as "22.5rem the bar folds its sections"',
    'src/components/Icon.tsx · ds:inputs · ds:inputs takes custom property names, comma separated; "width" is not one',
    'src/components/Icon.tsx · ds:styles · ds:styles names "missing.css", which is not a file in src/styles',
    'src/components/Icon.tsx · ds:theme · ds:theme is one of print, kiosk, not "poster"',
  ])
})

test('the taxonomy faults an unknown group, a missing group, a missing required key and a parked mismatch', () => {
  const faults = faultsOf({
    'src/components/Icon.tsx': '// ds:group Foundations / Glyphs\nexport default function Icon() { return null }\n',
    'src/components/Card.astro': '---\nconst a = 1\n---\n<div />\n',
    'src/components/Button.astro': '---\n// ds:group Primitives / Actions\n---\n<button />\n',
    'src/components/Legacy.astro': '---\n// ds:group Components / Cards\n\n// @kept: until the new flow ships\n---\n<div />\n',
    'src/components/Tag.astro': '---\n// ds:group Explorations / Kept\n---\n<span />\n',
  })
  assert.deepEqual(faults, [
    'src/components/Button.astro · ds:use-when · a Primitives node needs a ds:use-when line',
    'src/components/Card.astro · ds:group · has no group: add a ds:group line, or a path rule in graph.taxonomy.rules',
    'src/components/Icon.tsx · ds:group · "Foundations / Glyphs" is not a group in graph.taxonomy',
    'src/components/Legacy.astro · ds:group · carries the parked marker @kept: but sits in Components / Cards; a parked node goes in Explorations / Kept',
    'src/components/Tag.astro · ds:group · sits in Explorations / Kept without the parked marker @kept:',
  ])
})

test('a top header: stray lines, a colon, a second group and a malformed line are faults', () => {
  const files = {
    'src/components/Icon.tsx': [
      '// ds:group Foundations / Icons',
      '// ds:group Primitives / Actions',
      '// ds:theme: print',
      '// ds:no_story kept for later',
      '',
      'export default function Icon() {',
      '  // ds:never inside a button',
      '  return null',
      '}',
      '',
    ].join('\n'),
  }
  assert.deepEqual(faultsOf(files), [
    'src/components/Icon.tsx · ds: · a line opens with ds: but is not "ds:key value"',
    'src/components/Icon.tsx · ds:group · ds:group is declared a second time; keep one',
    'src/components/Icon.tsx · ds:never · ds:never sits outside the header, the first comment block at the top of the file; move it there',
    'src/components/Icon.tsx · ds:theme · ds:theme: is written with a colon; write "ds:theme <value>"',
  ])
  // Read anywhere, as before: the stray line counts, the colon is tolerated,
  // the groups join and a line that is not a key wraps onto the value above.
  const anywhere = faultsOf(files, (c) => ({ ...c, graph: { ...c.graph, header: 'anywhere' } }))
  assert.deepEqual(anywhere, [
    'src/components/Icon.tsx · ds:group · "Foundations / Icons Primitives / Actions" is not a group in graph.taxonomy',
    'src/components/Icon.tsx · ds:theme · ds:theme takes one value, not "print ds:no_story kept for later"',
  ])
})

test('a header in an .astro file sits inside the frontmatter, after any blank line', () => {
  const faults = faultsOf({
    'src/components/Card.astro': '---\n\n// ds:group Components / Cards\nimport Button from "./Button.astro"\n// ds:theme print\n---\n<!-- ds:never in a list -->\n<Button />\n',
  })
  assert.deepEqual(faults, [
    'src/components/Card.astro · ds:never · ds:never sits outside the header, the first comment block inside the frontmatter; move it there',
    'src/components/Card.astro · ds:theme · ds:theme sits outside the header, the first comment block inside the frontmatter; move it there',
  ])
})

test('graph.md lists each fault with its message', () => {
  const t = variant({ 'src/components/Icon.tsx': '// ds:group Foundations / Glyphs\n// ds:bogus x\nexport default function Icon() { return null }\n' })
  try {
    assert.equal(run('graph', t).status, 0)
    const md = read(t.project, 'graph.md')
    assert.match(md, /^- `src\/components\/Icon\.tsx` · `ds:bogus`$/m)
    assert.match(md, /^- `src\/components\/Icon\.tsx` · `ds:group` · "Foundations \/ Glyphs" is not a group in graph\.taxonomy$/m)
  } finally {
    t.cleanup()
  }
})

test('strictFaults: the run writes the files, then fails and says why; so does the check', () => {
  const broken = { 'src/components/Icon.tsx': '// ds:group Foundations / Glyphs\nexport default function Icon() { return null }\n' }
  const t = variant(broken, (c) => ({ ...c, graph: { ...c.graph, strictFaults: true } }))
  try {
    const r = run('graph', t)
    assert.equal(r.status, 1)
    assert.match(r.stdout, /wrote .*graph\.md and graph\.json/)
    assert.match(r.stderr, /1 header fault; see "Header faults" in graph\.md/)
    assert.match(r.stderr, /src\/components\/Icon\.tsx:1: "Foundations \/ Glyphs" is not a group in graph\.taxonomy/)
    assert.match(r.stderr, /graph\.strictFaults is on, so this fault fails the run/)
    const c = run('graph', t, ['--check'])
    assert.equal(c.status, 1)
    assert.doesNotMatch(c.stderr, /out of date/)
    assert.match(c.stderr, /graph\.strictFaults is on, so this fault fails the check/)
  } finally {
    t.cleanup()
  }
  const off = variant(broken)
  try {
    const r = run('graph', off)
    assert.equal(r.status, 0)
    assert.match(r.stderr, /1 header fault; see "Header faults"/)
    assert.equal(run('graph', off, ['--check']).status, 0)
  } finally {
    off.cleanup()
  }
})

test('the README lists tiers in the taxonomy\'s order', () => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'docs.mjs'), '--root', ctx.root, '--project-dir', ctx.project], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const md = read(ctx.project, 'README.md')
  const order = ['### Foundations', '### Primitives', '### Components', '### Internal', '### Explorations'].map((s) => md.indexOf(s))
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), order.join(', '))
})
