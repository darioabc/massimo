// The csf lane's registry: every story file read in place, every state with
// its id, route, merged meta and span, in the index order; and what the
// other tracks build on it: Ladle's meta.json shape, the redirect table and
// the hashes that pin a design target.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { compileGlobs, walk } from '../scripts/lib/glob.mjs'
import { ladleMeta, laneRegistry, normalHash, redirectTable, spanHash } from '../scripts/lib/lane.mjs'
import { DEFAULTS, deepMerge } from '../scripts/lib/project.mjs'
import { readCsf } from '../scripts/lib/stories-read.mjs'
import { FIXTURES } from './helpers.mjs'

const ROOT = join(FIXTURES, 'csf-lane')
const fixtureConfig = JSON.parse(readFileSync(join(ROOT, 'massimo.config.json'), 'utf8'))
const configWith = (stories = {}) => deepMerge(DEFAULTS, deepMerge(fixtureConfig, { stories }))
const storyFiles = (config) => walk(ROOT).filter(compileGlobs(config.stories.include))
const fixture = (stories = {}) => {
  const config = configWith(stories)
  return laneRegistry({ root: ROOT, config, files: storyFiles(config), read: (f) => readFileSync(join(ROOT, f), 'utf8') })
}
// A registry of files held in memory, keyed by path; a null source cannot be read.
const fromText = (sources, stories = {}) => {
  const read = (f) => {
    if (sources[f] === null) throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
    return sources[f]
  }
  return laneRegistry({ root: '.', config: deepMerge(DEFAULTS, { stories: { lane: 'csf', ...stories } }), files: Object.keys(sources), read })
}

test('the fixture under Ladle ids: every state in the order the globs give, the home, no problems', () => {
  const registry = fixture()
  assert.equal(registry.format, 1)
  assert.equal(registry.ids, 'ladle')
  assert.deepEqual(registry.problems, [])
  assert.equal(registry.home, 'foundations--welcome--start-here')
  assert.deepEqual(registry.order, [
    'foundations--welcome--start-here',
    'primitives--actions--button--primary',
    'primitives--actions--button--log--in-button',
    'primitives--actions--button--sized',
    'patterns--cards--card--plain',
    'patterns--cards--card--with-footer',
    'patterns--gauge--editor--empty',
    'patterns--gauge--editor--five-steps',
    'pages--review--summary--side-by-side',
    'pages--review--summary--overview',
    'pages--review--summary--state-b--admin',
    'explorations--new-header--wide',
    'explorations--new-header--narrow',
  ])
  // The include globs leave out the test file beside Button's stories.
  assert.equal(Object.keys(registry.files).length, 7)
})

test('a test file the include globs let through is still not a story file', () => {
  const registry = fromText({
    'src/X.stories.tsx': "export default { title: 'Pages / X' }\nexport const Plain = () => null\n",
    'src/X.stories.test.tsx': "export default { title: 'Pages / X test' }\nexport const Mounts = () => null\n",
  })
  assert.deepEqual(Object.keys(registry.files), ['src/X.stories.tsx'])
  assert.deepEqual(Object.keys(registry.stories), ['pages--x--plain'])
  assert.deepEqual(registry.problems, [])
})

test('each state carries its route, title, name, file, merged meta, flags and span', () => {
  const { stories } = fixture()
  assert.deepEqual(stories['primitives--actions--button--log--in-button'], {
    id: 'primitives--actions--button--log--in-button',
    slug: 'primitives--actions--button',
    state: 'log--in-button',
    title: 'Primitives / Actions / Button',
    levels: ['Primitives', 'Actions', 'Button'],
    name: 'Log-In button',
    file: 'src/components/Button.stories.tsx',
    export: 'LogIn',
    meta: { width: 375 },
    args: false,
    argTypes: false,
    parameters: false,
    span: { start: 9, end: 9 },
  })
  const sized = stories['primitives--actions--button--sized']
  assert.deepEqual([sized.args, sized.argTypes, sized.span], [true, true, { start: 13, end: 15 }])
  assert.equal(stories['pages--review--summary--overview'].parameters, true)
  assert.deepEqual(stories['patterns--cards--card--with-footer'].meta, { drift: 'The footer gap is 12px here and 16px in the design.' })
  // The story's own meta goes over the file's.
  const exploration = 'A taller header with the search field inline, kept for the next review.'
  assert.deepEqual(stories['explorations--new-header--wide'].meta, { exploration })
  assert.deepEqual(stories['explorations--new-header--narrow'].meta, { exploration, width: 375 })
  assert.deepEqual(stories['patterns--gauge--editor--empty'].meta, {})
})

test('one slug holds two files that share a title, and each file keeps its own ids and type import', () => {
  const registry = fixture()
  assert.deepEqual(registry.slugs['pages--review--summary'], {
    title: 'Pages / Review / Summary',
    files: ['src/pages/review/Compare.stories.tsx', 'src/pages/review/Summary.stories.tsx'],
    ids: ['pages--review--summary--side-by-side', 'pages--review--summary--overview', 'pages--review--summary--state-b--admin'],
  })
  const header = registry.files['src/explorations/NewHeader.stories.tsx']
  assert.deepEqual([header.title, header.slug, header.ids, header.unreadable], ['Explorations / New header', 'explorations--new-header', ['explorations--new-header--wide', 'explorations--new-header--narrow'], []])
  assert.deepEqual([header.typeImport.start, header.typeImport.spec, header.typeImport.names], [0, '@ladle/react', ['Story', 'StoryDefault']])
})

test('under export ids, states come from the export and never split a word', () => {
  const registry = fixture({ ids: 'export' })
  assert.equal(registry.ids, 'export')
  assert.deepEqual(registry.problems, [])
  assert.ok(registry.stories['primitives--actions--button--log-in'])
  assert.ok(registry.stories['pages--review--summary--state-b-admin'])
  assert.equal(registry.stories['primitives--actions--button--log-in'].name, 'Log-In button')
})

test('with no order globs, the index runs by title, then file path, then export order', () => {
  const registry = fixture({ order: null })
  assert.deepEqual(registry.order.slice(0, 5), [
    'explorations--new-header--wide',
    'explorations--new-header--narrow',
    'foundations--welcome--start-here',
    'pages--review--summary--side-by-side',
    'pages--review--summary--overview',
  ])
})

test('a state name used twice within one slug is a duplicate id, wherever the second one is', () => {
  const registry = fromText(
    {
      'src/a/One.stories.tsx': "export default { title: 'Pages / Shared' }\nexport const Plain = () => null\nexport const Other = () => null\nOther.storyName = 'Plain'\n",
      'src/b/Two.stories.tsx': "export default { title: 'Pages / Shared' }\nexport const Plain = () => null\n",
    },
    { ids: 'ladle' },
  )
  assert.deepEqual(registry.problems, [
    { rule: 'story-files', file: 'src/a/One.stories.tsx', detail: 'Other has the id pages--shared--plain, which Plain has too' },
    { rule: 'story-files', file: 'src/b/Two.stories.tsx', detail: "Plain has the id pages--shared--plain, which src/a/One.stories.tsx's Plain has too" },
  ])
  assert.deepEqual(Object.keys(registry.stories), ['pages--shared--plain'])
})

test('a file with no title, an export list it cannot read, and a home no story has are problems', () => {
  const registry = fromText(
    {
      'src/Loose.stories.tsx': 'export const Plain = () => null\n',
      'src/Untitled.stories.tsx': "export default { component: X }\nexport const Plain = () => null\n",
      'src/Barrel.stories.tsx': "export default { title: 'Pages / Barrel' }\nexport * from './more'\n",
      'src/Broken.stories.tsx': null,
    },
    { home: 'pages--gone--plain' },
  )
  assert.deepEqual(registry.problems.map((p) => [p.rule, p.file, p.detail]), [
    ['story-files', 'src/Barrel.stories.tsx', 'it passes on every export of ./more, which are not listed'],
    ['story-files', 'src/Broken.stories.tsx', 'it cannot be read (ENOENT)'],
    ['story-files', 'src/Loose.stories.tsx', 'it declares no title, so its states take their slug from the file name'],
    ['story-files', 'src/Untitled.stories.tsx', 'it declares no title, so its states take their slug from the file name'],
    ['story-files', null, 'stories.home is pages--gone--plain, which no story has'],
  ])
  // Files with no title still list their states, under the file's name.
  assert.deepEqual(Object.keys(registry.stories), ['loose--plain', 'untitled--plain'])
  assert.equal(registry.home, null)
})

test('under Ladle ids, a file of named stories with no default export is Ladle\'s own form: no problem, ids from its name', () => {
  const registry = fromText(
    {
      'src/panel/Header.stories.tsx': "import type { Story } from '@ladle/react'\nexport const Plain: Story = () => null\nexport const WithButton: Story = () => null\n",
      'src/Empty.stories.tsx': 'const a = 1\n',
    },
    { ids: 'ladle' },
  )
  assert.deepEqual(registry.problems.map((p) => [p.file, p.detail]), [['src/Empty.stories.tsx', 'it has no default export, so it is not a CSF file']])
  assert.deepEqual(Object.keys(registry.stories), ['header--plain', 'header--with-button'])
})

test('an exported class is a state, and its span runs to the end of its body', () => {
  const registry = fromText(
    { 'src/Legacy.stories.tsx': "import * as React from 'react'\n\nexport default { title: 'Pages / Legacy' }\n\nexport class Panel extends React.Component {\n  render() {\n    return null\n  }\n}\n\nexport const After = () => null\n" },
    { ids: 'ladle' },
  )
  assert.deepEqual(registry.problems, [])
  assert.deepEqual(Object.keys(registry.stories), ['pages--legacy--panel', 'pages--legacy--after'])
  assert.deepEqual(registry.stories['pages--legacy--panel'].span, { start: 5, end: 9 })
})

// Where a storyName or a story meta is set, beyond the plain case.
const ASSIGNED = {
  // Set on the declared name, and exported under another.
  'src/Local.stories.tsx': "export default { title: 'Pages / Local' }\n\nconst Inner = () => null\nInner.storyName = 'Renamed inside'\nInner.meta = { width: 1 }\n\nexport { Inner as Outer }\n",
  // Set inside a function, not by the module's own statements.
  'src/Nested.stories.tsx': "export default { title: 'Pages / Nested' }\n\nexport const Plain = () => null\n\nfunction setup() {\n  Plain.storyName = 'Set in a function'\n  Plain.meta = { width: 1 }\n}\nsetup()\n",
  // Indented, but still one of the module's own statements.
  'src/Indented.stories.tsx': "export default { title: 'Pages / Indented' }\n\nexport const A = () => null\n  A.storyName = 'Indented name'\n",
  // Set twice.
  'src/Twice.stories.tsx': "export default { title: 'Pages / Twice' }\n\nexport const A = () => null\nA.storyName = 'First'\nA.storyName = 'Second'\nA.meta = { width: 1 }\nA.meta = { width: 2 }\n",
}

test('a storyName or meta counts where Ladle reads it: by exported name, at the top level, the last one', () => {
  const registry = fromText(ASSIGNED, { ids: 'ladle' })
  assert.deepEqual(registry.problems, [])
  assert.deepEqual(Object.fromEntries(Object.values(registry.stories).map((s) => [s.id, s.meta])), {
    'pages--local--outer': {},
    'pages--nested--plain': {},
    'pages--indented--indented-name': {},
    'pages--twice--second': { width: 2 },
  })
  // Under export ids the renamed story keeps what its declared name was given.
  const local = fromText(ASSIGNED).stories['pages--local--outer']
  assert.deepEqual([local.name, local.meta], ['Renamed inside', { width: 1 }])
})

test("under Ladle ids, an unreadable storyName and an export Ladle refuses are problems", () => {
  const registry = fromText({ 'src/X.stories.tsx': "export default { title: 'Pages / X' }\nexport const A = () => null\nA.storyName = label\nexport const B__C = () => null\n" }, { ids: 'ladle' })
  assert.deepEqual(registry.problems.map((p) => p.detail), [
    'the id of A comes from its storyName, which is not statically readable',
    'Ladle refuses the export B__C, since it keeps "__" for its own encoding',
  ])
  assert.deepEqual(fromText({ 'src/X.stories.tsx': "export default { title: 'Pages / X' }\nexport const A = () => null\nA.storyName = label\n" }).problems, [])
})

test("ladleMeta has Ladle's shape: under Ladle ids, name and levels split the id as Ladle does", () => {
  const meta = ladleMeta(fixture())
  assert.deepEqual(meta.about, { generator: 'massimo', format: 1 })
  assert.equal(Object.keys(meta.stories)[0], 'foundations--welcome--start-here')
  assert.deepEqual(meta.stories['pages--review--summary--state-b--admin'], {
    name: 'Admin',
    levels: ['Pages', 'Review', 'Summary', 'State b'],
    locStart: 11,
    locEnd: 11,
    filePath: 'src/pages/review/Summary.stories.tsx',
    namedExport: 'StateB_Admin',
    meta: {},
  })
  const own = ladleMeta(fixture({ ids: 'export' })).stories['pages--review--summary--state-b-admin']
  assert.deepEqual([own.name, own.levels], ['State b admin', ['Pages', 'Review', 'Summary']])
})

test('the redirect table sends each old id to its route, by id or by file and export', () => {
  const ladle = fixture()
  assert.deepEqual(redirectTable(ladle, ['primitives--actions--button--log--in-button', 'pages--gone--plain']), {
    'pages--gone--plain': null,
    'primitives--actions--button--log--in-button': '/stories/primitives--actions--button/log--in-button',
  })
  // Under export ids the id changed, so Ladle's meta.json finds it by file and export.
  const old = ladleMeta(ladle).stories
  const table = redirectTable(fixture({ ids: 'export' }), old)
  assert.equal(table['primitives--actions--button--log--in-button'], '/stories/primitives--actions--button/log-in')
  assert.equal(table['pages--review--summary--state-b--admin'], '/stories/pages--review--summary/state-b-admin')
  assert.ok(Object.values(table).every(Boolean))
})

const FROZEN = `import type { Story } from '@ladle/react'
import { Header } from './Header'

export default { title: 'Explorations / Header' }

const pad = 16

export const Wide: Story = () => <Header pad={pad} />
`

test('normalHash holds when only the type import moves, and not for any other edit', () => {
  const hash = (text) => normalHash(text, readCsf(text, 'x.stories.tsx').typeImports[0])
  const before = hash(FROZEN)
  assert.match(before, /^[0-9a-f]{64}$/)
  assert.equal(hash(FROZEN.replace("'@ladle/react'", "'../stories/story'")), before)
  assert.equal(hash(FROZEN.replace("'@ladle/react'", '"../../stories/story.ts"')), before)
  assert.notEqual(hash(FROZEN.replace('const pad = 16', 'const pad = 12')), before)
  assert.notEqual(hash(FROZEN.replace('{ Story }', '{ Story, StoryDefault }')), before)
  assert.notEqual(normalHash(FROZEN, null), before)
})

test('spanHash names the export that changed, not the one that only moved', () => {
  const span = (text) => readCsf(text, 'x.stories.tsx').stories[0].span
  const moved = FROZEN.replace('const pad = 16\n', 'const pad = 16\nconst gap = 8\n')
  assert.notDeepEqual(span(moved), span(FROZEN))
  assert.equal(spanHash(moved, span(moved)), spanHash(FROZEN, span(FROZEN)))
  const edited = FROZEN.replace('<Header pad={pad} />', '<Header pad={pad} wide />')
  assert.notEqual(spanHash(edited, span(edited)), spanHash(FROZEN, span(FROZEN)))
  assert.equal(spanHash(FROZEN, null), '')
})
