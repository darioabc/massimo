// The graph on a csf lane: the story files read in place through the
// registry, the coverage split (own, direct, incidental), and the policies
// that stories.policy turns on, each off until it is set. The fixture is
// test/fixtures/csf-lane; every test writes its own files and config into a
// scratch copy.

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { golden, read, readJson, run, scratch } from './helpers.mjs'

// A scratch copy of the fixture with some files written over, and the config's
// `stories` (shallow) and `graph` (shallow) patched.
function variant({ files = {}, stories = {}, graph = {} } = {}) {
  const t = scratch('csf-lane')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(t.root, path)), { recursive: true })
    writeFileSync(join(t.root, path), text)
  }
  const path = join(t.root, 'massimo.config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  config.stories = { ...config.stories, ...stories }
  config.graph = { ...config.graph, ...graph, taxonomy: { ...config.graph.taxonomy, ...graph.taxonomy } }
  writeFileSync(path, JSON.stringify(config))
  return t
}

function graphOf(options) {
  const t = variant(options)
  try {
    const r = run('graph', t)
    assert.equal(r.status, 0, r.stderr)
    return { g: readJson(t.project, 'graph.json'), stderr: r.stderr, md: read(t.project, 'graph.md') }
  } finally {
    t.cleanup()
  }
}

// The problems of a csf lane as "rule · file · detail" lines, with no-story left out.
const found = (options) =>
  graphOf(options)
    .g.storyLane.problems.filter((p) => p.rule !== 'no-story')
    .map((p) => `${p.rule} · ${p.file} · ${p.detail}`)

const policy = (p, extra = {}) => ({ stories: { policy: p }, ...extra })

const story = (title, body = "export const Plain: Story = () => null\n", extra = '') => `import type { Story } from '@ladle/react'\n${extra}\nexport default { title: '${title}' }\n\n${body}`

test('a csf lane counts its files and states, and leaves a plain lane without a policy alone', () => {
  const { g } = graphOf()
  assert.equal(g.storyLane.lane, 'csf')
  assert.equal(g.storyLane.files, 7)
  assert.equal(g.storyLane.states, 13)
  assert.equal(g.storyLane.manifest, undefined)
  assert.equal(g.storyLane.entries, undefined)
  assert.deepEqual(g.storyLane.problems, [{ rule: 'no-story', file: 'src/components/Field.tsx', detail: 'no direct story' }])
  assert.deepEqual([g.storyLane.direct, g.storyLane.incidental, g.storyLane.none], [3, 0, 1])
})

test('with no policy, a bad title, a phantom level and a missing banner pass', () => {
  const files = {
    'src/components/Bad.stories.tsx': story('bad title!', 'export const State_One: Story = () => null\n'),
    'src/explorations/Bare.stories.tsx': story('Explorations / Bare'),
  }
  assert.deepEqual(found({ files }), [])
})

test('own coverage is the story beside a node or one titled with its group and name; direct is an import; incidental is import reach', () => {
  const files = {
    'src/components/Panel.tsx': "// ds:group Patterns / Cards\nimport { Field } from './Field'\nexport const Panel = () => <Field label=\"x\" />\n",
    'src/pages/Hosted.stories.tsx': story('Patterns / Cards / Panel', '', "import { Panel } from '../components/Panel'\n") + 'export const Hosted: Story = () => <Panel />\n',
  }
  const { g } = graphOf({ files })
  const node = (name) => g.nodes.find((n) => n.name === name)
  // Titled "Patterns / Cards / Panel" and importing Panel: its own and direct.
  assert.deepEqual([node('Panel').own, node('Panel').direct], [['patterns--cards--panel'], ['patterns--cards--panel']])
  // Field is only reached through Panel, so it is incidental and has no story of its own.
  assert.deepEqual([node('Field').own, node('Field').direct, node('Field').incidental], [[], [], ['patterns--cards--panel']])
  assert.deepEqual(node('Field').stories, [])
  assert.equal(g.storyLane.incidental, 1)
  // Button's story sits beside it and imports it.
  assert.deepEqual(node('Button').stories, ['src/components/Button.stories.tsx'])
  assert.deepEqual(g.storyLane.problems.map((p) => p.rule), ['no-story'])
})

test('a node a story only names in its title is own but not direct', () => {
  const files = { 'src/pages/Named.stories.tsx': story('Primitives / Inputs / Field') }
  const { g } = graphOf({ files })
  const field = g.nodes.find((n) => n.name === 'Field')
  assert.deepEqual([field.own, field.direct], [['primitives--inputs--field'], []])
})

test('roots: a title under a root the policy does not list is a story-title problem', () => {
  const files = { 'src/components/Odd.stories.tsx': story('Elsewhere / Odd / Thing') }
  assert.deepEqual(found(policy({ roots: ['Foundations', 'Primitives', 'Patterns', 'Pages', 'Explorations'] }, { files })), [
    'story-title · src/components/Odd.stories.tsx · "Elsewhere / Odd / Thing" starts with Elsewhere, which is not one of the roots Foundations, Primitives, Patterns, Pages, Explorations',
  ])
  assert.deepEqual(found({ files }), [])
})

test('titleParts counts the parts per root, and titleExact lets a title outside the count', () => {
  const files = { 'src/components/Short.stories.tsx': story('Patterns / Short'), 'src/components/Long.stories.tsx': story('Explorations / A / B') }
  const p = { titleParts: { default: 3, Explorations: 2 }, titleExact: ['Foundations / Welcome'] }
  assert.deepEqual(found(policy(p, { files })), [
    'story-title · src/components/Long.stories.tsx · "Explorations / A / B" has 3 parts, and a title under Explorations has 2',
    'story-title · src/components/Short.stories.tsx · "Patterns / Short" has 2 parts, and a title under Patterns has 3',
  ])
  // Without titleExact the fixture's own two-part Welcome title is a problem too.
  const bare = found(policy({ titleParts: p.titleParts }, { files: {} }))
  assert.deepEqual(bare, ['story-title · src/Welcome.stories.tsx · "Foundations / Welcome" has 2 parts, and a title under Foundations has 3'])
})

test('titleText checks every title part and every state name against the pattern and the forbidden words', () => {
  const files = {
    'src/components/Words.stories.tsx': story('Patterns / Notes / Old baseline', "export const Fine: Story = () => null\nexport const State_Two: Story = () => null\nexport const Named: Story = () => null\nNamed.storyName = 'Version v2'\n"),
  }
  const titleText = { pattern: '^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?: [A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)*$', forbidden: [{ pattern: '\\bbaselines?\\b', flags: 'i', what: 'the word baseline' }, { pattern: '\\bv\\d+\\b', flags: 'i', what: 'a version' }] }
  const words = found(policy({ titleText }, { files })).filter((line) => line.includes('Words.stories'))
  assert.deepEqual(words, [
    'story-title · src/components/Words.stories.tsx · the state Named (storyName "Version v2") has a version',
    'story-title · src/components/Words.stories.tsx · the state State_Two has characters or spacing that stories.policy.titleText.pattern does not allow',
    'story-title · src/components/Words.stories.tsx · the title part "Old baseline" has the word baseline',
  ])
})

test('a forbidden word is found in an export name read in words', () => {
  const files = { 'src/components/Hidden.stories.tsx': story('Patterns / Notes / Hidden', 'export const OpenV2: Story = () => null\n') }
  const titleText = { forbidden: [{ pattern: '\\bv\\d+\\b', flags: 'i', what: 'a version' }] }
  assert.deepEqual(found(policy({ titleText }, { files })), ['story-title · src/components/Hidden.stories.tsx · the state OpenV2 has a version'])
})

test('nameMatches: a story beside a node takes its group and name, ignoring case and punctuation', () => {
  const files = {
    'src/components/Button.stories.tsx': story('Primitives / Actions / BUTTON!'),
    'src/components/Card.stories.tsx': story('Patterns / Cards / Wrong name'),
  }
  assert.deepEqual(found(policy({ nameMatches: true }, { files })), [
    'story-title · src/components/Card.stories.tsx · "Patterns / Cards / Wrong name" is beside src/components/Card.tsx, so a story there is titled "Patterns / Cards / Card"',
  ])
  // Case and punctuation are ignored in the name.
  const ok = { 'src/components/Button.stories.tsx': story('Primitives / Actions / button') }
  assert.deepEqual(found(policy({ nameMatches: true }, { files: ok })), [])
  // The group has to be the node's.
  const moved = { 'src/components/Button.stories.tsx': story('Primitives / Inputs / Button') }
  assert.deepEqual(found(policy({ nameMatches: true }, { files: moved })).length, 1)
})

test('nameMatches: names renames a file stem, and a banner root or a not-live tier is exempt', () => {
  const files = {
    'src/components/gauge/Editor.stories.tsx': story('Patterns / Gauge / Step editor'),
    'src/components/Card.stories.tsx': story('Explorations / Anything').replace("{ title: 'Explorations / Anything' }", "{ title: 'Explorations / Anything', meta: { exploration: 'kept' } }"),
  }
  const base = { nameMatches: true, bannerByRoot: { Explorations: 'exploration' } }
  const loose = { files }
  assert.equal(found(policy(base, loose)).length, 1)
  assert.deepEqual(found(policy({ ...base, names: { Editor: 'Step editor' } }, loose)), [])
  const live = { graph: { taxonomy: { notLive: ['Explorations', 'Patterns'] } } }
  assert.deepEqual(found(policy({ ...base, bannerByRoot: {} }, { ...loose, ...live })), [])
})

test('titlePrefix: story files matching the globs start with one of the prefixes', () => {
  const files = { 'src/shared/_Shared.stories.tsx': story('Patterns / Cards / Shared'), 'src/shared/_Kept.stories.tsx': story('Explorations / Kept'), 'src/shared/Other.stories.tsx': story('Patterns / Cards / Other') }
  const p = { titlePrefix: [{ files: ['src/shared/_*.stories.tsx'], prefixes: ['Patterns / Shared / ', 'Explorations / '] }] }
  assert.deepEqual(found(policy(p, { files })), [
    'story-title · src/shared/_Shared.stories.tsx · "Patterns / Cards / Shared" does not start with "Patterns / Shared / " or "Explorations / "',
  ])
})

test('cleanIds: an id with a phantom level or an empty folder is a story-files problem', () => {
  assert.deepEqual(found(policy({ cleanIds: true })), [
    'story-files · src/components/Button.stories.tsx · LogIn: the id primitives--actions--button--log--in-button splits into 5 levels instead of 4',
    'story-files · src/pages/review/Summary.stories.tsx · StateB_Admin: the id pages--review--summary--state-b--admin splits into 5 levels instead of 4',
  ])
  assert.deepEqual(found({}), [])
})

test('ownStory by tier: every live node of the tier has its own story', () => {
  const p = { ownStory: [{ tiers: ['Primitives'], link: 'own' }] }
  assert.deepEqual(found(policy(p)), ['story-own · src/components/Field.tsx · no story of its own: add a story beside it (src/components/Field.stories.*) or one titled "Primitives / Inputs / Field"'])
  // A story titled with the group and name is enough for link own, not for link sibling.
  const files = { 'src/pages/Named.stories.tsx': story('Primitives / Inputs / Field') }
  assert.deepEqual(found(policy(p, { files })), [])
  assert.deepEqual(found(policy({ ownStory: [{ tiers: ['Primitives'], link: 'sibling' }] }, { files })), ['story-own · src/components/Field.tsx · no story of its own: add a story beside it (src/components/Field.stories.*)'])
  // A node marked ds:no-story is left alone.
  const marked = { 'src/components/Field.tsx': "// ds:group Primitives / Inputs\n// ds:no-story a wrapper with nothing to show\nexport const Field = () => null\n" }
  assert.deepEqual(found(policy(p, { files: marked })), [])
})

test('ownStory by file glob, with the sibling link', () => {
  const files = { 'src/blocks/alpha/Runner.tsx': "// ds:group Patterns / Cards\nexport const Runner = () => null\n", 'src/blocks/beta/Runner.tsx': "// ds:group Patterns / Cards\nexport const Runner = () => null\n", 'src/blocks/beta/Runner.stories.tsx': story('Patterns / Cards / Runner') }
  const options = { files, stories: { policy: { ownStory: [{ files: ['src/blocks/*/{Editor,Runner}.tsx'], link: 'sibling' }] } }, graph: {} }
  const t = variant(options)
  try {
    writeFileSync(join(t.root, 'massimo.config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(t.root, 'massimo.config.json'), 'utf8')), components: { include: ['src/components/**/*.tsx', 'src/blocks/**/*.tsx'], exclude: ['**/*.test.*', '**/*.stories.*'] } }))
    assert.equal(run('graph', t).status, 0)
    const problems = readJson(t.project, 'graph.json').storyLane.problems.filter((p) => p.rule === 'story-own')
    assert.deepEqual(problems.map((p) => p.file), ['src/blocks/alpha/Runner.tsx'])
  } finally {
    t.cleanup()
  }
})

test('a shared helper node with no story is flagged by no-story only, not by a rule that does not name it', () => {
  const { g } = graphOf(policy({ ownStory: [{ tiers: ['Patterns'], link: 'own' }], roots: ['Foundations', 'Primitives', 'Patterns', 'Pages', 'Explorations'] }))
  assert.deepEqual(g.storyLane.problems.map((p) => `${p.rule} ${p.file}`), ['no-story src/components/Field.tsx'])
})

test('bannerByRoot: a root\'s files carry its key, and no file outside the root does', () => {
  const files = {
    'src/explorations/NewHeader.stories.tsx': story('Explorations / New header').replace("export default", "export default"),
    'src/components/Stray.stories.tsx': story('Patterns / Cards / Stray').replace("{ title: 'Patterns / Cards / Stray' }", "{ title: 'Patterns / Cards / Stray', meta: { exploration: 'x' } }"),
    'src/components/Inner.stories.tsx': story('Patterns / Cards / Inner', 'export const Plain: Story = () => null\nPlain.meta = { exploration: "y" }\n'),
  }
  assert.deepEqual(found(policy({ bannerByRoot: { Explorations: 'exploration' } }, { files })), [
    'story-banner · src/components/Inner.stories.tsx · meta.exploration belongs to Explorations stories, and Plain sets it under Patterns',
    'story-banner · src/components/Stray.stories.tsx · meta.exploration belongs to Explorations stories, and the default export sets it under Patterns',
    'story-banner · src/explorations/NewHeader.stories.tsx · it sits under Explorations, so its default export needs meta.exploration as a non-empty string',
  ])
  // The fixture's own exploration file, untouched, passes.
  assert.deepEqual(found(policy({ bannerByRoot: { Explorations: 'exploration' } })), [])
})

test('a duplicate id across two files that share a slug is always a story-files problem', () => {
  const files = { 'src/pages/review/Extra.stories.tsx': story('Pages / Review / Summary', 'export const Overview: Story = () => null\n') }
  assert.deepEqual(found({ files }), [
    'story-files · src/pages/review/Summary.stories.tsx · Overview has the id pages--review--summary--overview, which src/pages/review/Extra.stories.tsx\'s Overview has too',
  ])
})

test('strictFaults fails story-own and story-banner, and leaves no-story to the audit', () => {
  const run1 = (options) => {
    const t = variant(options)
    try {
      return run('graph', t)
    } finally {
      t.cleanup()
    }
  }
  const strict = { graph: { strictFaults: true } }
  assert.equal(run1(strict).status, 0)
  const own = run1({ ...strict, stories: { policy: { ownStory: [{ tiers: ['Primitives'], link: 'own' }] } } })
  assert.equal(own.status, 1)
  assert.match(own.stderr, /story-own: no story of its own/)
  const banner = run1({ ...strict, stories: { policy: { bannerByRoot: { Pages: 'banner' } } } })
  assert.equal(banner.status, 1)
  assert.match(banner.stderr, /story-banner/)
})

test('an unknown lane warns and reads as native; an unknown policy option warns', () => {
  const unknown = graphOf({ stories: { lane: 'fancy' } })
  assert.match(unknown.stderr, /stories\.lane is "fancy", which is not a lane massimo knows/)
  assert.equal(unknown.g.storyLane, undefined)
  const option = graphOf(policy({ bogus: true }))
  assert.match(option.stderr, /stories\.policy\.bogus is not an option/)
  const bad = graphOf(policy({ titleText: { pattern: '(' } }))
  assert.match(bad.stderr, /stories\.policy\.titleText\.pattern is not a regular expression that compiles/)
})

test('a csf lane without the policy keys writes the same graph on every run', () => {
  assert.equal(graphOf().md, graphOf().md)
})

test('the fixture with every policy option on writes the golden graph', () => {
  const p = {
    roots: ['Foundations', 'Primitives', 'Patterns', 'Pages', 'Explorations'],
    titleParts: { default: 3, Explorations: 2 },
    titleExact: ['Foundations / Welcome'],
    titleText: { pattern: '^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?: [A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)*$', forbidden: [{ pattern: '\\bbaselines?\\b', flags: 'i', what: 'the word baseline' }] },
    nameMatches: true,
    names: {},
    ownStory: [{ tiers: ['Primitives'], link: 'own' }, { files: ['src/components/gauge/*.tsx'], link: 'sibling' }],
    bannerByRoot: { Explorations: 'exploration' },
    titlePrefix: [{ files: ['src/pages/**/*.stories.tsx'], prefixes: ['Pages / '] }],
    cleanIds: true,
  }
  const out = graphOf(policy(p))
  assert.equal(out.stderr, '')
  for (const [name, text] of [['graph.md', out.md], ['graph.json', `${JSON.stringify(out.g, null, 2)}\n`]]) {
    assert.equal(text, golden(`graph-csf/${name}`, text) ?? text, name)
  }
})
