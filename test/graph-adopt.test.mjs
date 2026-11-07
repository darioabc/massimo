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

const nodesByFile = (dir) => Object.fromEntries(readJson(dir, 'graph.json').nodes.map((n) => [n.file, n]))

test('layouts and pages are nodes of their kind, named by their path, and no longer consumers', () => {
  const byFile = nodesByFile(ctx.project)
  assert.equal(byFile['src/components/Button.astro'].kind, 'component')
  assert.equal(byFile['src/layouts/Shell.astro'].kind, 'layout')
  assert.equal(byFile['src/layouts/Shell.astro'].name, 'layouts/Shell')
  assert.equal(byFile['src/pages/index.astro'].kind, 'page')
  assert.equal(byFile['src/pages/index.astro'].name, 'pages/index')
  assert.equal(byFile['src/pages/index.astro'].group, 'Pages / Home')
  assert.equal(byFile['src/pages/feed.json.ts'].group, 'Internal / Endpoints')
  assert.deepEqual(byFile['src/pages/index.astro'].composes, ['Card', 'layouts/Shell'])
  assert.deepEqual(readJson(ctx.project, 'graph.json').summary.kinds, { component: 5, layout: 1, page: 2 })
  const md = read(ctx.project, 'graph.md')
  assert.match(md, /^1\. Nodes: 8 \(component 5, layout 1, page 2\)\. Stories: /m)
  assert.match(md, /^- pages\/index \(page\): story ✓ · used by 0$/m)
  assert.match(md, /^- file `src\/layouts\/Shell\.astro` · layout · no story on purpose: the home story shows it · exports Shell$/m)
})

test('MDX import lines and import.meta.glob calls are edges; an import in a fenced sample is not', () => {
  const byFile = nodesByFile(ctx.project)
  assert.deepEqual(byFile['src/components/Card.astro'].composedBy, { components: ['src/pages/index.astro'], content: ['src/content/notes/first.mdx'] })
  assert.deepEqual(byFile['src/components/Button.astro'].composedBy, { components: ['src/components/Card.astro', 'src/layouts/Shell.astro'] })
  // Relative patterns with `!` exclusions, and an alias pattern loaded lazily.
  assert.deepEqual(byFile['src/layouts/Shell.astro'].composes, ['Button', 'Legacy'])
  assert.deepEqual(byFile['src/pages/feed.json.ts'].composes, ['Icon'])
})

test('without graph.edges, MDX files and glob calls add nothing, as before', () => {
  const t = variant({}, (c) => ({ ...c, graph: { ...c.graph, edges: [] } }))
  try {
    assert.equal(run('graph', t).status, 0)
    const byFile = nodesByFile(t.project)
    assert.deepEqual(byFile['src/components/Card.astro'].composedBy, { components: ['src/pages/index.astro'] })
    assert.deepEqual(byFile['src/layouts/Shell.astro'].composes, ['Button'])
    assert.deepEqual(byFile['src/pages/feed.json.ts'].composes, [])
  } finally {
    t.cleanup()
  }
})

test('a manifest lane covers directly what a story\'s page, frame and helpers import and what it names; what those compose, incidentally', () => {
  const coverage = Object.fromEntries(Object.values(nodesByFile(ctx.project)).map((n) => [n.name, [n.direct, n.incidental]]))
  assert.deepEqual(coverage, {
    Button: [['button'], ['card', 'home']], // its page imports it
    Icon: [['button'], ['card', 'home']], // through the Stage helper the button page imports
    Card: [['card'], ['home']], // named, and imported by its frame
    'pages/index': [['home'], []], // named: the page only frames the route
    format: [[], ['card', 'home']],
    Legacy: [[], ['home']], // the shell's glob reaches it
    'layouts/Shell': [[], ['home']],
    'pages/feed.json': [[], []],
  })
  const g = readJson(ctx.project, 'graph.json')
  assert.deepEqual(g.storyLane, { manifest: 'src/stories/manifest.ts', entries: 4, states: 6, direct: 4, incidental: 3, none: 1, problems: [] })
  assert.equal(g.summary.withStory, 4)
  assert.deepEqual(nodesByFile(ctx.project)['src/components/Card.astro'].stories, ['src/stories/pages/card/index.astro'])
  const md = read(ctx.project, 'graph.md')
  assert.match(md, /Stories: 4 with a direct story, 3 seen only inside a parent's story, 1 with none; 1 marked `ds:no-story`\./)
  assert.match(md, /\n## Story lane\n\n`src\/stories\/manifest\.ts` lists 4 stories, with 6 states on their pages\./)
  assert.match(md, /^- format: incidental only · used by 1$/m)
  assert.match(md, /^- file `src\/components\/format\.ts` · no story of its own, seen inside `card`, `home` · exports price$/m)
})

test('without a manifest, stories are found by file name as before', () => {
  const t = variant({}, (c) => ({ ...c, stories: { ...c.stories, lane: 'native', manifest: null } }))
  try {
    assert.equal(run('graph', t).status, 0)
    const g = readJson(t.project, 'graph.json')
    assert.equal(g.storyLane, undefined)
    const button = g.nodes.find((n) => n.name === 'Button')
    assert.equal(button.direct, undefined)
    assert.deepEqual(button.stories, ['src/stories/pages/button/index.astro'])
  } finally {
    t.cleanup()
  }
})

// The fixture's four entries, to change one field at a time.
const ENTRIES = {
  colours: { slug: 'colours', title: 'Foundations / Colour / Palette', root: 'Foundations', group: 'Colour' },
  button: { slug: 'button', title: 'Primitives / Actions / Button', root: 'Primitives', group: 'Actions', component: 'src/components/Button.astro', states: ['Solid', 'Quiet'] },
  card: { slug: 'card', title: 'Components / Cards / Card', root: 'Components', group: 'Cards', component: ['src/components/Card.astro'], frame: true },
  home: { slug: 'home', title: 'Pages / Home / Home', root: 'Pages', group: 'Home', component: 'src/pages/index.astro' },
}
const manifest = (entries, tail = '') => `export const stories = [\n${entries.map((e) => `  ${JSON.stringify(e)},`).join('\n')}\n${tail}]\n`

// The lane's problems for a variant, as "rule · file · detail" lines, and
// the whole graph.json.
function laneOf(files, patch) {
  const t = variant(files, patch)
  try {
    const r = run('graph', t)
    assert.equal(r.status, 0, r.stderr)
    const g = readJson(t.project, 'graph.json')
    return { lines: g.storyLane.problems.map((p) => `${p.rule} · ${p.file} · ${p.detail}`), graph: g, md: read(t.project, 'graph.md') }
  } finally {
    t.cleanup()
  }
}

test('story-title: a title under its fields, its fields its component\'s group, and a component unless its place allows none', () => {
  const { colours, button, card, home } = ENTRIES
  const { lines } = laneOf({
    'src/stories/manifest.ts': manifest([
      { ...colours, title: 'Palette' },
      { ...button, title: 'Primitives / Action / Button' },
      { ...card, root: 'Primitives', group: 'Cards', title: 'Primitives / Cards / Card' },
      { ...home, component: 'src/pages/missing.astro' },
      { slug: 'motion', title: 'Foundations / Motion / Easing', root: 'Foundations', group: 'Motion' },
      { slug: 'kiosk', title: 'Kiosk / Screens / Idle', root: 'Kiosk', group: 'Screens' },
      { slug: 'chip', title: 'Primitives / Actions / Chip' },
    ]),
  })
  const title = lines.filter((l) => l.startsWith('story-title'))
  assert.deepEqual(title, [
    'story-title · src/stories/manifest.ts · button: "Primitives / Action / Button" is not under its fields, Primitives / Actions',
    'story-title · src/stories/manifest.ts · card: filed under Primitives / Cards, but Card is in Components / Cards',
    'story-title · src/stories/manifest.ts · chip: no root and group fields',
    'story-title · src/stories/manifest.ts · colours: "Palette" is not Root / Group / Name',
    'story-title · src/stories/manifest.ts · home: component "src/pages/missing.astro" is not a graph node',
    'story-title · src/stories/manifest.ts · kiosk: "Kiosk / Screens / Idle" is not Root / Group / Name',
    'story-title · src/stories/manifest.ts · motion: no component, but stories in Foundations / Motion cover one (a story without one goes in Foundations / Colour)',
  ])
})

test('story-files: an entry without its page, a page without an entry, a frame flag and a frame file that disagree', () => {
  const { colours, button, card, home } = ENTRIES
  const { lines } = laneOf({
    'src/stories/manifest.ts': manifest([colours, { ...button, frame: true }, { ...card, frame: false }, { ...home, slug: 'start' }]),
  })
  assert.deepEqual(lines.filter((l) => l.startsWith('story-files')), [
    'story-files · src/stories/manifest.ts · button: frame: true with no src/stories/pages/button/frame.astro',
    'story-files · src/stories/manifest.ts · card: src/stories/pages/card/frame.astro with no frame: true',
    'story-files · src/stories/manifest.ts · start: no src/stories/pages/start/index.astro',
    'story-files · src/stories/pages/home/index.astro · home: a page with no manifest entry',
  ])
})

test('story-states: a states list is the page\'s labels in order; a label it cannot read is reported, not guessed', () => {
  const { colours, button, card, home } = ENTRIES
  const swapped = laneOf({ 'src/stories/manifest.ts': manifest([colours, { ...button, states: ['Quiet', 'Solid'] }, card, home]) })
  assert.deepEqual(swapped.lines, ['story-states · src/stories/manifest.ts · button: states [Quiet, Solid] but the page labels [Solid, Quiet]'])
  const page = 'src/stories/pages/button/index.astro'
  const computed = laneOf({ [page]: '---\nimport Stage from "../../Stage.astro"\nconst n = 2\n---\n<StoryState label="Solid" /><StoryState label={`${n} rows`}><Stage /></StoryState>\n' })
  assert.deepEqual(computed.lines, [])
  assert.deepEqual(computed.graph.storyLane.unreadable, [{ file: page, detail: 'button: a state label is not statically readable, so its states are not checked' }])
  assert.match(computed.md, /Not statically readable, so not checked:\n\n- `src\/stories\/pages\/button\/index\.astro`: button: a state label/)
})

test('no-story: a live node with no direct story and no ds:no-story, whatever covers it incidentally', () => {
  const { lines, graph } = laneOf({ 'src/layouts/Shell.astro': '---\n// ds:group Shells / Site\n---\n<slot />\n' })
  // The shell shows only inside the home story; the module and the kept card are not live.
  assert.deepEqual(lines, ['no-story · src/layouts/Shell.astro · no direct story'])
  assert.deepEqual(graph.storyQueue.map((q) => q.name), ['layouts/Shell'])
})

test('a manifest entry it cannot read is listed and not checked, and its slug keeps its page', () => {
  const { colours, button, card } = ENTRIES
  const { lines, graph } = laneOf({
    'src/stories/manifest.ts': manifest([colours, button, card], "  { slug: 'home', title: titleOf('home'), component: HOME },\n"),
  })
  // No title check, and no "page with no entry" for home; without the
  // component it names, the home route has no direct story.
  assert.deepEqual(lines, ['no-story · src/pages/index.astro · no direct story'])
  assert.deepEqual(graph.storyLane.unreadable, [
    { file: 'src/stories/manifest.ts', detail: 'home: component is not statically readable' },
    { file: 'src/stories/manifest.ts', detail: 'home: title is not statically readable' },
  ])
})

test('strictFaults: story-title, story-files and story-states fail the run; no-story never does', () => {
  const strict = (c) => ({ ...c, graph: { ...c.graph, strictFaults: true } })
  const noStory = variant({ 'src/layouts/Shell.astro': '---\n// ds:group Shells / Site\n---\n<slot />\n' }, strict)
  try {
    assert.equal(run('graph', noStory).status, 0)
  } finally {
    noStory.cleanup()
  }
  const { colours, button, card, home } = ENTRIES
  const t = variant({ 'src/stories/manifest.ts': manifest([colours, { ...button, states: ['Solid'] }, card, home]) }, strict)
  try {
    const r = run('graph', t)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /src\/stories\/manifest\.ts: story-states: button: states \[Solid\] but the page labels \[Solid, Quiet\]/)
    assert.match(r.stderr, /graph\.strictFaults is on, so this fault fails the run/)
    assert.equal(run('graph', t, ['--check']).status, 1)
  } finally {
    t.cleanup()
  }
})

test('stories.lane: "manifest" needs stories.manifest, and "native" leaves a manifest unread', () => {
  const missing = variant({}, (c) => ({ ...c, stories: { ...c.stories, manifest: null } }))
  try {
    const r = run('graph', missing)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /stories\.lane is "manifest", so stories\.manifest must name the file that lists the stories/)
  } finally {
    missing.cleanup()
  }
  const native = variant({}, (c) => ({ ...c, stories: { ...c.stories, lane: 'native' } }))
  try {
    const r = run('graph', native)
    assert.equal(r.status, 0)
    assert.match(r.stderr, /stories\.manifest is set, but stories\.lane is "native", so stories are found by file name/)
    assert.equal(readJson(native.project, 'graph.json').storyLane, undefined)
  } finally {
    native.cleanup()
  }
  const gone = laneOf({}, (c) => ({ ...c, stories: { ...c.stories, manifest: 'src/stories/list.ts' } }))
  assert.deepEqual(gone.lines.filter((l) => l.startsWith('story-files')), ['story-files · src/stories/list.ts · stories.manifest names src/stories/list.ts, which does not exist'])
})

test('the README lists tiers in the taxonomy\'s order', () => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'docs.mjs'), '--root', ctx.root, '--project-dir', ctx.project], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const md = read(ctx.project, 'README.md')
  const order = ['### Foundations', '### Primitives', '### Components', '### Internal', '### Explorations'].map((s) => md.indexOf(s))
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), order.join(', '))
})
