// Story files of other tools read as text: CSF (Storybook's format, which
// Ladle reads too) and Histoire's <Story> and <Variant> blocks. What is not
// a literal is listed as not statically readable, never guessed.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readCsf, readHistoire } from '../scripts/lib/stories-read.mjs'

const CSF3 = `
import type { Meta, StoryObj } from '@storybook/react'
import { Button } from './Button'
// export const Commented = {}
const meta = {
  title: 'Primitives/Button',
  component: Button,
  tags: ['autodocs'],
  decorators: [(Story) => <div><Story /></div>],
  excludeStories: ['helper'],
} satisfies Meta<typeof Button>
export default meta
type Story = StoryObj<typeof meta>
export const Primary: Story = { args: { primary: true } }
export const Large: Story = { name: 'Big one', argTypes: { size: { control: 'select' } } }
export const helper = () => 1
export const Computed: Story = { name: label('x') }
`

test('CSF3: the meta a const holds, object stories with their name, args and argTypes', () => {
  assert.deepEqual(readCsf(CSF3, 'Button.stories.tsx'), {
    title: 'Primitives/Button',
    component: { name: 'Button', from: './Button' },
    meta: { tags: ['autodocs'] },
    stories: [
      { export: 'Primary', storyName: null, args: true, argTypes: false },
      { export: 'Large', storyName: 'Big one', args: false, argTypes: true },
      { export: 'Computed', storyName: null, args: false, argTypes: false },
    ],
    args: true,
    argTypes: true,
    unreadable: [
      { story: null, field: 'decorators', detail: 'decorators is not statically readable' },
      { story: 'Computed', field: 'name', detail: 'name is not statically readable' },
    ],
  })
})

const CSF2 = `
import type { Story } from '@ladle/react'
import { Card as Tile } from '../Card'
export default {
  title: \`Components / Cards\`,
  component: Tile,
  meta: { exploration: true },
}
export const Plain: Story = () => <Tile />
Plain.storyName = 'Plain card'
export const Wide: Story = () => <Tile wide />
Wide.meta = { width: 900 }
Wide.args = { wide: true }
const Hidden = () => null
Hidden.storyName = name
export { Hidden as Secret }
export * from './more'
`

test('CSF2 and Ladle: function stories, storyName and args set after them, export lists', () => {
  const csf = readCsf(CSF2, 'Card.stories.tsx')
  assert.equal(csf.title, 'Components / Cards')
  assert.deepEqual(csf.component, { name: 'Tile', from: '../Card' })
  assert.deepEqual(csf.meta, { meta: { exploration: true } })
  assert.deepEqual(csf.stories, [
    { export: 'Plain', storyName: 'Plain card', args: false, argTypes: false },
    { export: 'Wide', storyName: null, args: true, argTypes: false },
    { export: 'Secret', storyName: null, args: false, argTypes: false },
  ])
  assert.deepEqual(csf.unreadable, [
    { story: null, field: null, detail: 'it passes on every export of ./more, which are not listed' },
    { story: 'Secret', field: 'storyName', detail: 'storyName is not statically readable' },
  ])
})

test('what a CSF reader cannot read is said, not guessed', () => {
  assert.match(readCsf('storiesOf("x", module).add("a", () => 1)', 'x.stories.js').unreadable[0].detail, /storiesOf\(\)/)
  const called = readCsf('export default defineMeta({ title: "x" })\nexport const A = {}', 'x.stories.ts')
  assert.equal(called.title, null)
  assert.deepEqual(called.unreadable, [{ story: null, field: null, detail: 'its default export is defineMeta, not an object literal' }])
  assert.deepEqual(called.stories.map((s) => s.export), ['A'])
  assert.match(readCsf('export const A = () => 1', 'x.stories.ts').unreadable[0].detail, /no default export/)
  const titled = readCsf('const t = "x"\nexport default { title: t, includeStories: /^[A-Z]/ }\nexport const A = 1', 'x.stories.ts')
  assert.deepEqual(titled.unreadable.map((u) => u.field), ['title', 'includeStories'])
  assert.deepEqual(readCsf('export default { includeStories: ["B"] }\nexport const A = 1\nexport const B = 2', 'x.stories.ts').stories.map((s) => s.export), ['B'])
  // No title: Storybook takes it from the path, so it is null and nothing is wrong.
  assert.deepEqual(readCsf('export default { component: X }\nexport const A = {}', 'x.stories.ts').unreadable, [])
})

test('an export written inside a string is not one, and a statement that declares several stories says so', () => {
  const quoted = readCsf("const s = \"export default { title: 'Fake' }\"\nconst t = `export const Ghost = 1`\nexport default { title: 'Real' }\nexport const A = () => <p>Hello, world</p>\n", 'x.stories.tsx')
  assert.equal(quoted.title, 'Real')
  assert.deepEqual(quoted.stories.map((s) => s.export), ['A'])
  assert.deepEqual(quoted.unreadable, [])
  const several = readCsf("export default { title: 'X' }\nexport const A = {}, B = { args: { a: 1 } }\nexport const C = {\n  args: { a: 1, b: 2 },\n}\n", 'x.stories.ts')
  assert.deepEqual(several.stories.map((s) => s.export), ['A', 'C'])
  assert.deepEqual(several.unreadable, [{ story: 'A', field: null, detail: 'A is declared with more names in one statement, and the names after it are not listed' }])
  // A re-export keeps its module, read from the code and not the blanked text.
  assert.deepEqual(readCsf("export default {}\nexport { D } from './d'\n", 'x.stories.ts').unreadable, [{ story: 'D', field: null, detail: 'D is re-exported from ./d' }])
})

const HISTOIRE = `<script setup>
import Button from './Button.vue'
</script>
<template>
  <Story title="Button">
    <Variant title="Primary"><Button /></Variant>
    <Variant :title="dynamic"><Button /></Variant>
    <Variant><Button /></Variant>
  </Story>
  <Story title="Other" />
  <!-- <Variant title="Retired" /> -->
</template>
`

test('Histoire: each story with its variants; a bound title is not statically readable, a missing one is null', () => {
  assert.deepEqual(readHistoire(HISTOIRE), {
    stories: [
      { title: 'Button', variants: ['Primary', null, null] },
      { title: 'Other', variants: [] },
    ],
    unreadable: [{ story: 0, field: 'variant', detail: 'the title of variant 2 of story 1 is not statically readable' }],
  })
  assert.deepEqual(readHistoire('<Hst.Story title="S"><Hst.Variant title={name} /><Hst.Variant title="V" /></Hst.Story><Hst.Variant title="Loose" />'), {
    stories: [{ title: 'S', variants: [null, 'V'] }],
    unreadable: [
      { story: 0, field: 'variant', detail: 'the title of variant 1 of story 1 is not statically readable' },
      { story: null, field: 'variant', detail: '1 variant sits outside any <Story>' },
    ],
  })
})
