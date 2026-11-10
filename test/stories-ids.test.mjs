// Story ids. Under `ladle` they must be Ladle's, character for character, so
// the vectors below were computed once by calling @ladle/react 5.1.1's own
// naming functions on these inputs. Under `export` they are massimo's own:
// lower-case words, never a `--` inside a part.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ladleFileId, ladleIdMeta, ladleStoryId, ladleTitleId } from '../scripts/lib/ladle-ids.mjs'
import { fileSlug, stateName, stateSlug, titleSlug } from '../scripts/lib/stories-read.mjs'

const STORY_SIDE = [
  ['ShadeOverTall', 'shade-over-tall'],
  ['Empty state', 'empty-state'],
  // An underscore is a break and the capital after it starts a word, so the id gains a level.
  ['StateB_Admin', 'state-b--admin'],
  // A capital after a hyphen gets a hyphen of its own.
  ['Log-In form', 'log--in-form'],
  ['URLField', 'url-field'],
  ['HTMLEditorURL', 'html-editor-url'],
  ['IDsList', 'i-ds-list'],
  ['PDFViewer', 'pdf-viewer'],
  ['Step2Done', 'step2-done'],
  ['With 3 items', 'with-3-items'],
  ['Dark mode (RTL)', 'dark-mode--rtl-'],
  ['Is it OK?', 'is-it-ok-'],
  ['Q&A', 'q--a'],
  ['_Leading', '--leading'],
  ['Two  spaces', 'two-spaces'],
]

const TITLE_SIDE = [
  // Lower-cased before the words are split, so the same hyphen stays single here.
  ['Patterns / Account / Log-In panel', 'patterns--account--log-in-panel'],
  ['Patterns / Layout / LTR layout (B-2)', 'patterns--layout--ltr-layout--b-2-'],
  ['Pages / Home', 'pages--home'],
  ['Foundations/Colors', 'foundations--colors'],
  ['Pages /  Many   spaces / Wide', 'pages--many-spaces--wide'],
  ['Patterns / Q&A card', 'patterns--q-a-card'],
  ['CamelTitle / InnerPart', 'cameltitle--innerpart'],
]

test('the story side of a Ladle id, as Ladle computes it', () => {
  for (const [name, id] of STORY_SIDE) assert.equal(ladleStoryId(name), id, name)
})

test('the title side of a Ladle id, as Ladle computes it', () => {
  for (const [title, id] of TITLE_SIDE) assert.equal(ladleTitleId(title), id, title)
  // The same words give different ids on the two sides.
  assert.notEqual(ladleTitleId('Log-In form'), ladleStoryId('Log-In form'))
})

test('a file with no title takes its name up to the first dot', () => {
  assert.equal(ladleFileId('src/FooBar.stories.tsx'), 'foo-bar')
  assert.equal(ladleFileId('src/a/my-card.stories.tsx'), 'my-card')
  assert.equal(fileSlug('src/FooBar.stories.tsx', 'ladle'), 'foo-bar')
  assert.equal(fileSlug('src/FooBar.stories.tsx'), 'foo-bar')
})

test("the name and levels Ladle's meta.json shows split the id on every --", () => {
  assert.deepEqual(ladleIdMeta('pages--home--empty-state'), { name: 'Empty state', levels: ['Pages', 'Home'] })
  assert.deepEqual(ladleIdMeta('patterns--account--log-in-panel--log--in-form'), { name: 'In form', levels: ['Patterns', 'Account', 'Log in panel', 'Log'] })
  assert.deepEqual(ladleIdMeta('pages--review--state-b--admin'), { name: 'Admin', levels: ['Pages', 'Review', 'State b'] })
  assert.deepEqual(ladleIdMeta('patterns--layout--ltr-layout--b-2---dark-mode--rtl-'), { name: 'Rtl ', levels: ['Patterns', 'Layout', 'Ltr layout', 'B 2', ' dark mode'] })
})

test('under ladle, the storyName gives the state when there is one, else the export', () => {
  assert.equal(stateSlug({ export: 'ShadeOverTall', storyName: null }, 'ladle'), 'shade-over-tall')
  assert.equal(stateSlug({ export: 'ShadeOverTall', storyName: 'Empty state' }, 'ladle'), 'empty-state')
  // An empty storyName falls back to the export, as in Ladle.
  assert.equal(stateSlug({ export: 'StateB_Admin', storyName: '' }, 'ladle'), 'state-b--admin')
  assert.equal(titleSlug('Patterns / Account / Log-In panel', 'ladle'), 'patterns--account--log-in-panel')
})

test('under export, slugs are lower-case words from the title and the export, never the storyName', () => {
  assert.equal(titleSlug('Patterns / Account / Log-In panel'), 'patterns--account--log-in-panel')
  assert.equal(titleSlug('Patterns / Layout / LTR layout (B-2)'), 'patterns--layout--ltr-layout-b-2')
  assert.equal(titleSlug('Patterns / Q&A card'), 'patterns--q-a-card')
  assert.equal(stateSlug({ export: 'ShadeOverTall', storyName: 'Empty state' }), 'shade-over-tall')
  assert.equal(stateSlug({ export: 'StateB_Admin' }), 'state-b-admin')
  assert.equal(stateSlug({ export: 'HTMLEditorURL' }), 'html-editor-url')
  assert.equal(stateSlug({ export: 'Step2Done' }), 'step2-done')
})

test("a state's name is its storyName, else its export in words", () => {
  assert.equal(stateName({ export: 'ShadeOverTall', storyName: 'Log-In form' }), 'Log-In form')
  assert.equal(stateName({ export: 'ShadeOverTall' }), 'Shade over tall')
  assert.equal(stateName({ export: 'URLField' }), 'URL field')
  assert.equal(stateName({ export: 'StateB_Admin' }), 'State b admin')
})
