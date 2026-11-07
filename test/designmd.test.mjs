// DESIGN.md: pinned to format version alpha, the default theme in the front
// matter with the other themes named in prose, colours kept as references,
// and the components' rules from the graph in their sections.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { yaml } from '../scripts/lib/designmd.mjs'
import { read, run, withTokens } from './helpers.mjs'

test('the YAML writer quotes every string and any key that is not a plain name', () => {
  assert.equal(yaml({ a: { '100': '#fff', b: 1.5, 'c d': '{x.y}' } }), 'a:\n  "100": "#fff"\n  b: 1.5\n  "c d": "{x.y}"')
})

test('a themed set: default theme in the front matter, dark named in prose, rules from the graph', () => {
  const t = withTokens(
    {
      color: {
        $type: 'color',
        neutral: { 0: { $value: '#ffffff' }, 950: { $value: '#0a0a0a' } },
        primary: { $value: '#14b8a6', $description: 'Main actions' },
        bg: { $value: '{color.neutral.0}', $description: 'Page background', $extensions: { massimo: { modes: { dark: '{color.neutral.950}' } } } },
      },
      radius: { $type: 'dimension', md: { $value: '6px' } },
    },
    { outputs: [{ format: 'designmd', path: 'DESIGN.md' }] },
  )
  try {
    mkdirSync(t.project, { recursive: true })
    writeFileSync(join(t.project, 'graph.json'), JSON.stringify({ nodes: [{ name: 'Button', rules: { 'use-when': 'one primary action per view', never: 'nest a Button in a Button' } }] }))
    const r = run('tokens', t, ['build'])
    assert.equal(r.status, 0, r.stderr)
    const md = read(t.root, 'DESIGN.md')
    assert.match(md, /^---\nversion: "alpha"\nname: "fixture-app"\ncolors:\n {2}neutral:\n {4}"0": "#ffffff"\n {4}"950": "#0a0a0a"\n {2}primary: "#14b8a6"\n {2}bg: "\{colors\.neutral\.0\}"\n/)
    assert.match(md, /Written as DESIGN\.md format version alpha \(google-labs-code\/design\.md 0\.4\.0\)\./)
    assert.match(md, /The values here are the light theme\. DESIGN\.md has no themes yet, so dark lives in code only/)
    assert.match(md, /## Colors\n\n- `colors\.primary`: Main actions\n- `colors\.bg`: Page background/)
    assert.match(md, /## Shapes\n\nCorner radii: `md` 6px\./)
    assert.match(md, /## Components\n\n- \*\*Button\*\*: one primary action per view/)
    assert.match(md, /## Do's and Don'ts\n\n- Don't, in Button: nest a Button in a Button/)
    // The sections keep the order the spec requires.
    const order = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1])
    assert.deepEqual(order, ['Overview', 'Colors', 'Shapes', 'Components', "Do's and Don'ts"])
    assert.equal(run('tokens', t, ['check']).status, 0) // DESIGN.md is checked for staleness like any output
  } finally {
    t.cleanup()
  }
})
