// The ratchet for a repo that already keeps one: the story lane's policies
// read from graph.json, a legacy ratchet compared file by file before any
// baseline is recorded from it, and a check that fails while the baseline is
// behind the code.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { compareLegacy, parseMap } from '../scripts/audit.mjs'
import { readJson, run, scratch } from './helpers.mjs'

const contexts = []
after(() => contexts.forEach((c) => c.cleanup()))
const fresh = () => {
  const ctx = scratch('audit-adopt')
  contexts.push(ctx)
  return ctx
}
const patch = (ctx, edit) => {
  const path = join(ctx.root, 'massimo.config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  edit(config)
  writeFileSync(path, JSON.stringify(config))
}
const graph = (ctx, doc) => {
  mkdirSync(ctx.project, { recursive: true })
  writeFileSync(join(ctx.project, 'graph.json'), JSON.stringify(doc))
}
const storyLane = {
  problems: [
    { rule: 'story-title', file: 'src/stories/manifest.ts', detail: 'cards: "Cards" is not Root / Group / Name' },
    { rule: 'no-story', file: 'src/components/Card.astro', detail: 'no direct story' },
    { rule: 'no-story', file: 'src/components/Old.astro', detail: 'no direct story' },
    { rule: 'story-files', file: 'src/stories/pages/poster', detail: 'poster: a page directory with no manifest entry' },
    { rule: 'meta-check', file: 'scripts/x.mjs', detail: 'not a story kind' },
  ],
}
const withStories = (ctx) => patch(ctx, (c) => {
  c.stories = { manifest: 'src/stories/manifest.ts' }
  c.audit.exempt['no-story'] = { tiers: ['Explorations'] }
})
const legacy = (ctx, rules) => {
  const path = join(ctx.root, 'ratchet.json')
  writeFileSync(path, JSON.stringify({ note: 'counts by rule and offender', rules }))
  return path
}
const rule = (offenders) => ({ count: Object.values(offenders).reduce((a, b) => a + b, 0), offenders })

test('the story kinds come from graph.json, each problem a finding keyed "<file>: <detail>"', () => {
  const ctx = fresh()
  withStories(ctx)
  graph(ctx, { version: 1, nodes: [], storyLane })
  const r = run('audit', ctx, ['--baseline'])
  assert.equal(r.status, 0, r.stderr)
  const latest = readJson(ctx.project, 'audits', 'latest.json')
  assert.equal(latest.totals['story-title'], 1)
  assert.equal(latest.totals['story-files'], 1)
  assert.equal(latest.totals['story-states'], 0)
  assert.equal(latest.totals['no-story'], 1) // Old.astro is parked, so its tier is exempt
  assert.equal(latest.exempted['no-story'], 1)
  assert.match(readFileSync(join(ctx.project, 'audits', 'latest.md'), 'utf8'), /^### src\/stories\/manifest\.ts \(1\)\n- story-title `cards: "Cards" is not Root \/ Group \/ Name`$/m)
  const baseline = readJson(ctx.project, 'audits', 'baseline.json')
  assert.equal(baseline.version, 2)
  assert.deepEqual(baseline.kinds['story-title'].offenders, { 'src/stories/manifest.ts: cards: "Cards" is not Root / Group / Name': 1 })
  assert.deepEqual(baseline.kinds['no-story'].offenders, { 'src/components/Card.astro: no direct story': 1 })

  // A new problem the graph reports is a rise like any other.
  graph(ctx, { version: 1, nodes: [], storyLane: { problems: [...storyLane.problems, { rule: 'story-states', file: 'src/stories/manifest.ts', detail: 'cards: states [a] but the page labels [b]' }] } })
  const check = run('audit', ctx, ['--check'])
  assert.equal(check.status, 1)
  assert.match(check.stderr, /story-states {2}src\/stories\/manifest\.ts: cards: states \[a\] but the page labels \[b\] {2}new/)
})

test('a story problem may name a page directory, and an exemption for its kind still reads', () => {
  const ctx = fresh()
  withStories(ctx)
  patch(ctx, (c) => (c.audit.exempt['story-files'] = { tiers: ['Explorations'] }))
  mkdirSync(join(ctx.root, 'src', 'stories', 'pages', 'poster'), { recursive: true })
  graph(ctx, { version: 1, nodes: [], storyLane })
  for (const args of [[], ['--baseline'], ['--check']]) {
    const r = run('audit', ctx, args)
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`)
  }
  const latest = readJson(ctx.project, 'audits', 'latest.json')
  assert.equal(latest.totals['story-files'], 1)
  // Exempt by a glob, the directory's finding goes like a file's.
  patch(ctx, (c) => (c.audit.exempt['story-files'] = { files: ['src/stories/pages/*'] }))
  assert.equal(run('audit', ctx).status, 0)
  assert.equal(readJson(ctx.project, 'audits', 'latest.json').exempted['story-files'], 1)
})

test('without graph.json or its story lane the story kinds are skipped, and a newer graph.json is refused', () => {
  const ctx = fresh()
  withStories(ctx)
  let latest = (run('audit', ctx), readJson(ctx.project, 'audits', 'latest.json'))
  assert.equal(latest.skipped['story-title'], 'no graph.json yet: run graph.mjs')
  graph(ctx, { version: 1, nodes: [] })
  latest = (run('audit', ctx), readJson(ctx.project, 'audits', 'latest.json'))
  assert.equal(latest.skipped['no-story'], 'graph.json has no story lane yet: run graph.mjs')
  graph(ctx, { version: 2, nodes: [], storyLane })
  const newer = run('audit', ctx)
  assert.equal(newer.status, 1)
  assert.match(newer.stderr, /graph\.json is format 2/)
  // Without stories.manifest the audit never reads graph.json at all.
  const plain = fresh()
  graph(plain, { version: 2, nodes: [] })
  assert.equal(run('audit', plain).status, 0)
})

test('while the graph could not read the manifest, or check no-story, those kinds are skipped and --lower keeps them', () => {
  const ctx = fresh()
  withStories(ctx)
  graph(ctx, { version: 1, nodes: [], storyLane })
  assert.equal(run('audit', ctx, ['--baseline']).status, 0)
  const recorded = readJson(ctx.project, 'audits', 'baseline.json').kinds
  // The manifest stops reading: one whole problem, and nothing to measure.
  const whole = { rule: 'story-files', file: 'src/stories/manifest.ts', detail: 'stories is built from more than its array literal, so it is not statically readable', whole: true }
  graph(ctx, { version: 1, nodes: [], storyLane: { problems: [whole] } })
  let r = run('audit', ctx, ['--lower'])
  assert.equal(r.status, 0, r.stderr)
  let latest = readJson(ctx.project, 'audits', 'latest.json')
  for (const kind of ['story-title', 'story-files', 'story-states', 'no-story']) {
    assert.equal(latest.skipped[kind], 'the graph could not read the story manifest: stories is built from more than its array literal, so it is not statically readable', kind)
  }
  let kinds = readJson(ctx.project, 'audits', 'baseline.json').kinds
  for (const kind of ['story-title', 'story-files', 'story-states', 'no-story']) assert.deepEqual(kinds[kind], recorded[kind], kind)
  assert.equal(run('audit', ctx, ['--check']).status, 0)
  // An entry's component it cannot read: no-story is not checked, so it is not measured either.
  const notChecked = { 'no-story': 'the component of home is not statically readable, so any node could be the one a story covers' }
  graph(ctx, { version: 1, nodes: [], storyLane: { problems: storyLane.problems.filter((p) => p.rule !== 'no-story'), notChecked } })
  r = run('audit', ctx, ['--lower'])
  assert.equal(r.status, 0, r.stderr)
  latest = readJson(ctx.project, 'audits', 'latest.json')
  assert.equal(latest.skipped['no-story'], `the graph did not check it: ${notChecked['no-story']}`)
  assert.equal(latest.skipped['story-title'], undefined)
  kinds = readJson(ctx.project, 'audits', 'baseline.json').kinds
  assert.deepEqual(kinds['no-story'], recorded['no-story'])
})

test('--map pairs a rule with one kind or several, and a kind takes one rule', () => {
  assert.deepEqual(parseMap('raw-colour=color+tailwind-palette, breakpoint=breakpoint'), [
    { rule: 'raw-colour', kinds: ['color', 'tailwind-palette'] },
    { rule: 'breakpoint', kinds: ['breakpoint'] },
  ])
  assert.throws(() => parseMap('raw-colour=colour'), /"colour", which is not a kind/)
  assert.throws(() => parseMap('a=color,b=color'), /gives color both a and b/)
  assert.throws(() => parseMap('a'), /<rule>=<kind>/)
  const rows = compareLegacy(
    { rules: { 'raw-colour': rule({ 'src/a.css: #fff': 2, 'src/b.css: red': 1 }) } },
    parseMap('raw-colour=color+tailwind-palette'),
    { color: { 'src/a.css: #fff': 1 }, 'tailwind-palette': { 'src/a.css: bg-red-500': 1, 'src/b.css: text-red-600': 1 } },
    new Map(),
  )
  assert.deepEqual(rows[0].differs, [])
  assert.equal(rows[0].legacy, 3)
})

test('a legacy rule whose count its offenders do not add up to cannot be compared, so nothing is written', () => {
  const [row] = compareLegacy({ rules: { 'raw-colour': { count: 3, offenders: {} } } }, parseMap('raw-colour=color'), { color: {} }, new Map())
  assert.equal(row.broken, 'the legacy count is 3, but its offenders add up to 0')
  assert.equal(row.problem, row.broken)
  const ctx = fresh()
  const file = legacy(ctx, { 'primitive-read': { count: 2, offenders: { 'src/components/Card.astro: --sand-200': 1 } } })
  const r = run('audit', ctx, ['--import', file, '--map', 'primitive-read=primitive-read', '--write'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^primitive-read +primitive-read +1 +1 +the legacy count is 2, but its offenders add up to 1$/m)
  assert.match(r.stdout, /No baseline written\. primitive-read cannot be compared, as the table says: fix \S+ratchet\.json first\./)
  assert.ok(!existsSync(join(ctx.project, 'audits', 'baseline.json')))
})

test('an import records no baseline until every mapped rule matches file by file', () => {
  const ctx = fresh()
  withStories(ctx)
  graph(ctx, { version: 1, nodes: [], storyLane })
  const file = legacy(ctx, {
    'primitive-read': rule({ 'src/components/Card.astro: --sand-200': 1 }),
    breakpoint: rule({ 'src/components/Card.astro: @media 400px (min-[400px]:)': 3, 'src/lib/classes.ts: @media 80rem (xl:)': 1 }),
    'story-title': rule({ 'src/stories/manifest.ts: cards: "Cards" is not Root / Group / Name': 1 }),
    'meta-check': rule({}),
  })
  const map = ['--map', 'primitive-read=primitive-read,breakpoint=breakpoint,story-title=story-title']
  const bad = run('audit', ctx, ['--import', file, ...map, '--write'])
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /^rule +kinds +legacy +massimo +result$/m)
  assert.match(bad.stdout, /^primitive-read +primitive-read +1 +1 +match$/m)
  assert.match(bad.stdout, /^breakpoint +breakpoint +4 +5 +1 file differs$/m)
  assert.match(bad.stdout, /^story-title +story-title +1 +1 +match$/m)
  assert.match(bad.stdout, /^ {2}breakpoint {2}src\/components\/Card\.astro {2}legacy 3, massimo 4$/m)
  assert.match(bad.stdout, /Not mapped, so not imported: meta-check\./)
  assert.match(bad.stdout, /This audit also measures color, arbitrary, undefined-var, tailwind-palette, story-files, story-states, no-story, which no rule maps to/)
  assert.match(bad.stdout, /No baseline written\. breakpoint differs file by file/)
  assert.ok(!existsSync(join(ctx.project, 'audits', 'baseline.json')))

  // Counted the same, the baseline is recorded for the mapped kinds only.
  const good = legacy(ctx, {
    'primitive-read': rule({ 'src/components/Card.astro: --sand-200': 1 }),
    breakpoint: rule({ 'src/components/Card.astro: @media 400px': 4, 'src/lib/classes.ts: @media 80rem (xl:)': 1 }),
    'story-title': rule({ 'src/stories/manifest.ts: an entry with no title': 1 }),
  })
  const dry = run('audit', ctx, ['--import', good, ...map])
  assert.equal(dry.status, 0, dry.stdout)
  assert.match(dry.stdout, /Run again with --write to record the baseline/)
  assert.ok(!existsSync(join(ctx.project, 'audits', 'baseline.json')))
  const wrote = run('audit', ctx, ['--import', good, ...map, '--write'])
  assert.equal(wrote.status, 0, wrote.stdout)
  const baseline = readJson(ctx.project, 'audits', 'baseline.json')
  assert.equal(baseline.version, 2)
  assert.deepEqual(Object.keys(baseline.kinds), ['primitive-read', 'breakpoint', 'story-title'])
  // The keys are this audit's own, so --check reads them.
  assert.equal(baseline.kinds.breakpoint.offenders['src/components/Card.astro: @media 64rem (lg:)'], 1)
  const check = run('audit', ctx, ['--check'])
  assert.equal(check.status, 0, check.stderr)
  assert.match(check.stdout, /not in the baseline yet: color, arbitrary/)
})

test('a mapped kind this run does not measure cannot match, and --map needs --import', () => {
  const ctx = fresh()
  const file = legacy(ctx, { 'no-story': rule({}) })
  const r = run('audit', ctx, ['--import', file, '--map', 'no-story=no-story', '--write'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /not measured: no-story \(stories\.manifest is not set\)/)
  assert.match(r.stdout, /No baseline written\. no-story is not measured, as the table says\./)
  assert.equal(run('audit', ctx, ['--map', 'a=color']).status, 2)
  assert.equal(run('audit', ctx, ['--import', file, '--check']).status, 2)
  assert.equal(run('audit', ctx, ['--import', file, '--map', 'no-story=nope']).status, 2)
})

test('an import keeps the kinds a baseline already tracks that the map does not name', () => {
  const ctx = fresh()
  assert.equal(run('audit', ctx, ['--baseline']).status, 0)
  const path = join(ctx.project, 'audits', 'baseline.json')
  const before = readJson(path)
  before.kinds['future-kind'] = { count: 1, offenders: { 'src/a.css: x': 1 } }
  writeFileSync(path, JSON.stringify(before))
  const file = legacy(ctx, { 'primitive-read': rule({ 'src/components/Card.astro: --sand-200': 1 }) })
  const r = run('audit', ctx, ['--import', file, '--map', 'primitive-read=primitive-read', '--write'])
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /This audit also measures color, arbitrary, undefined-var, tailwind-palette, breakpoint, which no rule maps to; the baseline keeps them as they were\./)
  const after_ = readJson(path)
  assert.deepEqual(after_.kinds.breakpoint, before.kinds.breakpoint)
  assert.deepEqual(after_.kinds['future-kind'], before.kinds['future-kind'])

  // A kind the baseline does not track is named as left out.
  delete after_.kinds['tailwind-palette']
  writeFileSync(path, JSON.stringify(after_))
  const mixed = run('audit', ctx, ['--import', file, '--map', 'primitive-read=primitive-read'])
  assert.equal(mixed.status, 0, mixed.stdout)
  assert.match(mixed.stdout, /; the baseline keeps color, arbitrary, undefined-var, breakpoint as they were and leaves tailwind-palette out\./)
})

test('audit.failWhenBehind fails --check while an offender that fell is still in the baseline', () => {
  const ctx = fresh()
  assert.equal(run('audit', ctx, ['--baseline']).status, 0)
  const card = join(ctx.root, 'src', 'components', 'Card.astro')
  writeFileSync(card, readFileSync(card, 'utf8').replace('min-[400px]:flex ', ''))
  const lenient = run('audit', ctx, ['--check'])
  assert.equal(lenient.status, 0)
  assert.match(lenient.stdout, /1 offender fell: run --lower to record it/)
  patch(ctx, (c) => (c.audit.failWhenBehind = true))
  const strict = run('audit', ctx, ['--check'])
  assert.equal(strict.status, 1)
  assert.match(strict.stdout, /the baseline is behind the code: 1 offender fell\. Run: node \S+audit\.mjs --lower, and commit/)
  assert.match(strict.stderr, /breakpoint {2}src\/components\/Card\.astro: @media 400px \(min-\[400px\]:\) {2}1 -> 0/)
  assert.equal(run('audit', ctx, ['--lower']).status, 0)
  assert.equal(run('audit', ctx, ['--check']).status, 0)
})
