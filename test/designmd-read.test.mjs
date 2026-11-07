// DESIGN.md read back: the front matter's tokens and the rules its prose
// gives components, in the subset of YAML the format uses. What the subset
// cannot hold is named with its line, never guessed.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { designMd, readDesignMd, readYaml } from '../scripts/lib/designmd.mjs'

test('what designMd writes, readDesignMd reads back', () => {
  const md = designMd({
    name: 'Acme',
    description: 'A shop.',
    source: 'tokens.json',
    defaultMode: 'light',
    otherModes: [],
    header: 'Generated',
    colors: [{ path: ['brand'], value: '#0f766e', description: 'The brand.' }],
    spacing: [{ path: ['md'], value: '16px' }],
    components: [{ name: 'Button', useWhen: 'a reader acts', never: 'two primaries side by side' }],
  })
  assert.deepEqual(readDesignMd(md), {
    version: 'alpha',
    name: 'Acme',
    description: 'A shop.',
    tokens: [
      { path: ['colors', 'brand'], value: '#0f766e' },
      { path: ['spacing', 'md'], value: '16px' },
    ],
    components: [{ name: 'Button', properties: {}, useWhen: 'a reader acts', never: 'two primaries side by side' }],
    rules: [],
    sections: ['Overview', 'Colors', 'Layout', 'Components', "Do's and Don'ts"],
    problems: [],
  })
})

const SPEC = `---
version: alpha
name: Daylight
colors:
  primary: "#1A1C1E"   # ink
  'on-primary': '#fff'
typography:
  headline:
    fontFamily: Public Sans
    fontSize: 48px
    weights: [400, 700]
spacing:
  scale:
    - 4px
    - 8px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
notes: |
  free text
---
# Daylight

## Components

- **Card**: groups one thing.
- Keep cards flat.

## Do's and Don'ts

- Don't, in Card: nest cards.
- Do use the scale.
`

test('the spec shape: nested token groups, component tokens, prose rules, and what is left out by line', () => {
  const d = readDesignMd(SPEC)
  assert.deepEqual(d.tokens, [
    { path: ['colors', 'primary'], value: '#1A1C1E' },
    { path: ['colors', 'on-primary'], value: '#fff' },
    { path: ['typography', 'headline', 'fontFamily'], value: 'Public Sans' },
    { path: ['typography', 'headline', 'fontSize'], value: '48px' },
    { path: ['spacing', 'scale'], value: ['4px', '8px'] },
  ])
  assert.deepEqual(d.components, [
    { name: 'button-primary', properties: { backgroundColor: '{colors.primary}' }, useWhen: null, never: null },
    { name: 'Card', properties: {}, useWhen: 'groups one thing.', never: 'nest cards.' },
  ])
  assert.deepEqual(d.rules, [
    { section: 'Components', text: 'Keep cards flat.' },
    { section: "Do's and Don'ts", text: 'Do use the scale.' },
  ])
  assert.deepEqual(d.problems.map((p) => p.line), [11, 19])
})

test('no front matter is a problem, not an error; a list of maps is left out', () => {
  assert.deepEqual(readDesignMd('# Plain\n').problems, [{ line: 1, message: 'there is no front matter between --- lines, so no tokens' }])
  const problems = []
  assert.deepEqual(readYaml('a:\n  - x: 1\n  - 2\nb: true\nc: ~\n"d e": -1.5', problems), { a: [2], b: true, c: null, 'd e': -1.5 })
  assert.deepEqual(problems, [{ line: 2, message: 'a list of maps, which this reader leaves out' }])
})
