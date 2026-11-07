// A story lane read as text: the manifest's entries and the state blocks on
// a page, with anything that is not a literal reported instead of guessed.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { componentsOf, readManifest, readStoryStates, slugFiles, slugPath } from '../scripts/lib/stories-read.mjs'

const MANIFEST = `
/** Roots, in order. They carry no slug, so they are not the story list. */
export const ROOTS = [{ name: 'Foundations' }, { name: 'Primitives' }]

const base = { root: 'Primitives', group: 'Actions' }

export const stories: StoryEntry[] = [
  // A comment between entries is skipped.
  { slug: 'button', title: 'Primitives / Actions / Button', root: 'Primitives', group: 'Actions',
    component: 'src/components/Button.astro', states: ['Solid', \`Quiet\`], frame: true, owner: 'design' },
  { slug: 'card', title: 'Components / Cards / Card', component: ['src/components/Card.astro', 'src/components/CardList.astro'], theme: 'light', reference: ['card.png'] },
  { slug: 'menu', title: makeTitle('menu'), component: PATHS.menu },
  { ...base, slug: 'link', title: 'Primitives / Actions / Link' },
  entry('chip'),
]

export const ordered = [...stories]
`

test('a manifest is read from the exported array whose entries carry a slug', () => {
  const m = readManifest(MANIFEST, 'src/stories/manifest.ts')
  assert.equal(m.name, 'stories')
  assert.equal(m.entries.length, 5)
  assert.deepEqual(m.entries[0], {
    slug: 'button',
    title: 'Primitives / Actions / Button',
    root: 'Primitives',
    group: 'Actions',
    component: 'src/components/Button.astro',
    states: ['Solid', 'Quiet'],
    frame: true,
    owner: 'design',
  })
  assert.deepEqual(componentsOf(m.entries[0]), ['src/components/Button.astro'])
  assert.deepEqual(componentsOf(m.entries[1]), ['src/components/Card.astro', 'src/components/CardList.astro'])
  assert.deepEqual(m.entries[1].reference, ['card.png'])
  assert.equal(m.entries[4], null)
})

test('what is not a literal is reported as not statically readable, never guessed', () => {
  const m = readManifest(MANIFEST, 'src/stories/manifest.ts')
  assert.deepEqual(m.entries[2], { slug: 'menu' })
  assert.deepEqual(m.unreadable, [
    { entry: 2, slug: 'menu', field: 'title', detail: 'title is not statically readable' },
    { entry: 2, slug: 'menu', field: 'component', detail: 'component is not statically readable' },
    { entry: 3, slug: 'link', field: '...', detail: 'spreads base into the entry' },
    { entry: 4, slug: null, field: null, detail: 'entry 5 is not an object literal' },
  ])
  assert.deepEqual(readManifest('export default [{ slug: "a", title: "A" }]').entries, [{ slug: 'a', title: 'A' }])
  assert.deepEqual(readManifest('const list = [{ slug: "a" }]\nexport { list as stories }').entries, [{ slug: 'a' }])
  const none = readManifest('export const ROOTS = [{ name: "x" }]', 'm.ts')
  assert.deepEqual(none.entries, [])
  assert.match(none.unreadable[0].detail, /m\.ts exports no array of entries with a slug/)
})

test('a list built from more than its literal is not read at all, never read in part', () => {
  const list = "[{ slug: 'a', title: 'A' }, { slug: 'b', title: 'B' }]"
  const whole = (text) => {
    const m = readManifest(text, 'm.ts')
    assert.deepEqual(m.unreadable.filter((u) => u.entry === null), [], text)
    return m.entries.map((e) => e.slug)
  }
  for (const text of [
    `export const stories = ${list}`,
    `export const stories = ${list};\nexport const n = 2`,
    `export const stories: StoryEntry[] = ${list}\nexport const ordered = [...stories].map((s) => s)`,
    `export const stories = ${list} as const`,
    `export const stories = ${list} satisfies ReadonlyArray<Entry<'x'>>;`,
    `export const stories = ${list} as readonly StoryEntry[] // the list\n`,
    `export const stories = ${list}, count = 2`,
    `const list = ${list}\n\nexport { list as stories }`,
  ]) {
    assert.deepEqual(whole(text), ['a', 'b'], text)
  }
  const more = (text) => {
    const m = readManifest(text, 'm.ts')
    assert.deepEqual(m.entries, [], text)
    assert.equal(m.unreadable.length, 1, text)
    assert.equal(m.unreadable[0].entry, null)
    return m.unreadable[0].detail
  }
  const built = 'stories is built from more than its array literal, so it is not statically readable'
  assert.equal(more(`export const stories: StoryEntry[] = ${list}.concat(EXTRA)`), built)
  assert.equal(more(`export const stories = ${list}\n  .map((s) => ({ ...s, root: 'A' }))`), built)
  assert.equal(more(`export const stories = ${list} as StoryEntry[]\n  .filter(Boolean)`), built)
  assert.equal(more(`export const stories = ${list} + more`), built)
  assert.equal(more(`export default ${list}.concat(more)`), 'the default export is built from more than its array literal, so it is not statically readable')
  assert.equal(more(`export const stories = ${list}\nstories.push({ slug: 'c' })`), 'stories is changed by push() after it is declared, so it is not statically readable')
  // A list wrapped in a call is no array literal at all.
  assert.equal(more(`export const stories = defineStories(${list})`), 'm.ts exports no array of entries with a slug')
})

const PAGE = `---
import StoryState from '../../StoryState.astro'
// <StoryState label="In the frontmatter"> is not a state.
const hint = 'Hover it.'
---
<StoryFrame title="Button">
  <!-- <StoryState label="Retired" /> -->
  {/* <StoryState label="Also retired" /> */}
  <StoryState label="Solid" note={hint}><Button /></StoryState>
  <StoryState
    label={'Quiet'}
    note="On the tile, flush."
    ground="tile"
    flush
  ><Button tone="quiet" /></StoryState>
  <StoryState label={\`Disabled\`} flush={false} note={items.map((i) => i > 2).length > 0 ? 'a' : 'b'} />
  <StoryState label={\`\${count} rows\`}><List /></StoryState>
  <StoryState name="Recipe style" {...rest} />
</StoryFrame>
`

test('state blocks give their label, note, ground and flush; a computed one says so', () => {
  assert.deepEqual(readStoryStates(PAGE), [
    { label: 'Solid', note: { expr: 'hint' }, ground: null, flush: false },
    { label: 'Quiet', note: 'On the tile, flush.', ground: 'tile', flush: true },
    { label: 'Disabled', note: { expr: "items.map((i) => i > 2).length > 0 ? 'a' : 'b'" }, ground: null, flush: false },
    { label: { expr: '`${count} rows`' }, note: null, ground: null, flush: false },
    { label: 'Recipe style', note: null, ground: null, flush: false },
  ])
})

test('a state with no label is null; one only a spread could label says so', () => {
  const page = '<StoryState>No label</StoryState>\n<StoryState {...first} note="x" />\n<StoryState label="Set" {...rest} />\n'
  assert.deepEqual(readStoryStates(page).map((s) => s.label), [null, { spread: 'first' }, 'Set'])
})

test('a slug pattern names a file, and finds the slugs its files carry', () => {
  assert.equal(slugPath('src/stories/pages/{slug}/index.astro', 'card'), 'src/stories/pages/card/index.astro')
  const files = ['src/stories/pages/card/index.astro', 'src/stories/pages/card/frame.astro', 'src/stories/pages/menu/index.astro', 'src/stories/index.astro']
  assert.deepEqual([...slugFiles('src/stories/pages/{slug}/index.astro', files)], [
    ['card', 'src/stories/pages/card/index.astro'],
    ['menu', 'src/stories/pages/menu/index.astro'],
  ])
})
