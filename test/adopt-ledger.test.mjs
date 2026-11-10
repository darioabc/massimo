// The adopt ledger and its commands on a repo with its own setup: plan
// writes the ledger and a proposed config from the inventory, config shows
// the proposal as a diff and merges it in without overwriting the user's
// values, status prints the ledger, and mark moves a class forward, never
// past a blocker and never back without --force. The adopt phase follows.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { STATES, ledgerPhase, markClass, mergeAdding, planLedger } from '../scripts/lib/adopt.mjs'
import { SCRIPTS, read, readJson, scratch } from './helpers.mjs'

const ctx = scratch('legacy')
after(() => ctx.cleanup())
const env = { ...process.env, MASSIMO_TODAY: '2026-11-07' }
const script = (name, args = []) => spawnSync(process.execPath, [join(SCRIPTS, `${name}.mjs`), ...args, '--root', ctx.root], { encoding: 'utf8', env })
const adopt = (...args) => script('adopt', args)
const project = join(ctx.root, 'design-system')
const ledger = () => readJson(project, 'adopt', 'ledger.json')
const configFile = join(ctx.root, 'massimo.config.json')

test('init on a repo with something to adopt sets the adopt phase to do', () => {
  const r = script('init', ['--no-npm-scripts'])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).adoptable.map((a) => a.kind), ['lane', 'headers', 'graph', 'ratchet', 'tokens', 'design-md'])
  const phase = readJson(project, 'state.json').phases.find((p) => p.id === 'adopt')
  assert.equal(phase.status, 'todo')
  assert.equal(phase.note, 'found lane, headers, graph, ratchet, tokens, design-md; start with /massimo:adopt')
  // STATUS.md and the session hook route the phase to its skill, not to a script.
  const status = read(project, 'STATUS.md')
  assert.match(status, /\| Adopt the repo's own setup \| ○ to do \| found lane, headers, graph, ratchet, tokens, design-md; start with \/massimo:adopt \| `\/massimo:adopt` \|/)
  assert.match(status, /\*\*Next phase:\*\* Set up the project, with `\/massimo:start`\./)
  const hook = spawnSync(process.execPath, [join(SCRIPTS, 'session-start.mjs')], { encoding: 'utf8', env: { ...env, CLAUDE_PROJECT_DIR: ctx.root } })
  const context = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext
  assert.match(context, /adopt ○ \(found lane, headers, graph, ratchet, tokens, design-md; start with \/massimo:adopt\)/)
  for (const text of [status, context]) assert.doesNotMatch(text, /adopt\.mjs/)
})

test('plan needs the inventory, then writes the ledger and the proposed config', () => {
  const early = adopt('plan')
  assert.equal(early.status, 1)
  assert.match(early.stderr, /no design-system\/adopt\/inventory\.json yet: run node design-system\/scripts\/adopt\.mjs scan first/)
  assert.equal(adopt('scan').status, 0)
  const r = adopt('plan')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Class {4}State {2}Since {7}Batch/)
  const l = ledger()
  assert.equal(l.format, 1)
  assert.deepEqual(Object.keys(l.classes), ['graph', 'stories', 'audit', 'tokens', 'docs'])
  const asset = (cls, id) => l.classes[cls].assets.find((a) => a.id === id)
  const brief = (a) => [a.decision, a.loss, a.state, a.date, a.batch]
  assert.deepEqual(brief(asset('stories', 'lane:src/stories')), ['keep', 'clean', 'found', '2026-11-07', null])
  assert.deepEqual(brief(asset('stories', 'pages:src/stories/pages')), ['keep', 'carried', 'found', '2026-11-07', null])
  assert.deepEqual(brief(asset('graph', 'doc:docs/system/graph.md')), ['convert', 'carried', 'found', '2026-11-07', null])
  assert.deepEqual(brief(asset('graph', 'generator:scripts/build-system.mjs')), ['retire', 'lost', 'found', '2026-11-07', null])
  assert.deepEqual(brief(asset('graph', 'headers')), ['keep', 'carried', 'found', '2026-11-07', null])
  assert.deepEqual(brief(asset('audit', 'ratchet:docs/system/ratchet.json')), ['convert', 'lost', 'found', '2026-11-07', null])
  assert.deepEqual(brief(asset('tokens', 'tokens:docs/system/tokens.json')), ['retire', 'carried', 'found', '2026-11-07', null])
  assert.deepEqual(brief(asset('docs', 'notes:docs/system/notes.md')), ['keep', 'clean', 'found', '2026-11-07', null])
  assert.ok(asset('audit', 'ratchet:docs/system/ratchet.json').lines.includes('logo-colour (count 0) has no massimo kind: keep it as a project check under guard.extraChecks, or accept losing it.'))
  assert.ok(asset('tokens', 'tokens:docs/system/tokens.json').lines.includes('Read at build or run time by src/stories/foundations.ts: repoint it before cut-over.'))
  assert.ok(asset('graph', 'headers').lines.includes('ds:owner on 1 file: no role fits, so it is read as an extra key and its values are not checked.'))
  assert.ok(asset('graph', 'headers').lines.includes('scripts/build-system.mjs reads the ds: headers as well. The headers stay in the source unchanged, so it keeps working.'))
  assert.deepEqual(asset('stories', 'gate:lab-integration.mjs').consumers, [{ file: 'astro.config.mjs', line: 1, class: 'deploy', how: 'imports' }])
  assert.ok(asset('graph', 'doc:docs/system/graph.md').lines.includes('Named in docs/map.md, which scripts/make-map.mjs writes: change scripts/make-map.mjs and regenerate with it, rather than editing by hand.'))
  assert.ok(asset('graph', 'headers').lines.some((line) => /^Scan proposes no path rules: add rules to graph\.taxonomy\.rules/.test(line)))
  const phase = readJson(project, 'state.json').phases.find((p) => p.id === 'adopt')
  assert.deepEqual([phase.status, phase.note], ['in_progress', 'graph found, stories found, audit found, tokens found, docs found'])
})

test('the proposed config holds what scan can fill', () => {
  assert.deepEqual(readJson(project, 'adopt', 'config.proposed.json'), {
    version: 1,
    graph: {
      extraKeys: ['breakpoint', 'inputs', 'owner', 'styles', 'theme'],
      keys: { breakpoint: 'breakpoint', inputs: 'definitions', styles: { role: 'list', under: 'src/styles' }, theme: { role: 'scope', values: ['kiosk', 'print'] } },
      taxonomy: { tiers: ['Foundations', 'Primitives', 'Components', 'Shells', 'Pages'], groups: ['Foundations / Icons', 'Primitives / Status', 'Primitives / Actions', 'Components / Cards', 'Shells / Site', 'Pages / Home'] },
      kinds: { layout: ['src/layouts/**/*.astro'], page: ['src/pages/**/*.astro'] },
    },
    stories: {
      lane: 'manifest',
      manifest: 'src/stories/manifest.ts',
      pages: 'src/stories/pages/{slug}/index.astro',
      frames: 'src/stories/pages/{slug}/frame.astro',
      include: ['src/stories/**/*.{astro,ts}'],
      devCommand: 'npm run stories:dev',
      port: 4400,
      url: 'http://localhost:4400/stories',
      storyUrl: 'http://localhost:4400/stories/{slug}',
    },
    audit: { exclude: ['src/stories/**'] },
  })
})

test('config prints the proposal as a diff, and --write adds keys without overwriting the user', () => {
  const config = JSON.parse(readFileSync(configFile, 'utf8'))
  config.stories.devCommand = 'npm run lab'
  config.audit.exclude = ['**/*.test.*']
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`)
  const before = readFileSync(configFile, 'utf8')
  const diff = adopt('config')
  assert.equal(diff.status, 0, diff.stderr)
  const lines = diff.stdout.trim().split('\n')
  assert.ok(lines.includes('+ graph.extraKeys: ["breakpoint","inputs","owner","styles","theme"]'))
  assert.ok(lines.includes('+ graph.keys.theme: {"role":"scope","values":["kiosk","print"]}'))
  assert.ok(lines.includes('+ graph.kinds.page: ["src/pages/**/*.astro"]'))
  assert.ok(lines.includes('~ stories.lane: "native" -> "manifest" (was the default)'))
  assert.ok(lines.includes('+ stories.manifest: "src/stories/manifest.ts"'))
  assert.ok(lines.includes('= stories.devCommand: kept "npm run lab" (proposed "npm run stories:dev")'))
  assert.ok(lines.includes('~ audit.exclude: ["**/*.test.*"] -> ["**/*.test.*","src/stories/**"]'))
  assert.equal(readFileSync(configFile, 'utf8'), before, 'config without --write changes nothing')
  const write = adopt('config', '--write')
  assert.equal(write.status, 0, write.stderr)
  assert.match(write.stdout, /wrote \d+ changes to massimo\.config\.json; your values marked = were kept/)
  const merged = JSON.parse(readFileSync(configFile, 'utf8'))
  assert.equal(merged.stories.devCommand, 'npm run lab')
  assert.equal(merged.stories.lane, 'manifest')
  assert.deepEqual(merged.audit.exclude, ['**/*.test.*', 'src/stories/**'])
  assert.deepEqual(merged.graph.keys.styles, { role: 'list', under: 'src/styles' })
  assert.equal(adopt('config').stdout, '= stories.devCommand: kept "npm run lab" (proposed "npm run stories:dev")\n')
  // The config it wrote is one the scripts read.
  assert.equal(script('graph').status, 0)
})

test('config --write leaves a config with comments for a hand edit, and shows the changes to make', () => {
  const clean = readFileSync(configFile, 'utf8')
  const config = JSON.parse(clean)
  delete config.graph.kinds
  const text = `// The project folder: the docs build reads it.\n${JSON.stringify(config, null, 2)}\n`
  writeFileSync(configFile, text)
  const r = adopt('config', '--write')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^\+ graph\.kinds/m)
  assert.match(r.stderr, /massimo\.config\.json has comments \(or trailing commas\), which --write would drop: make the changes above by hand/)
  assert.equal(readFileSync(configFile, 'utf8'), text)
  // With nothing to write, the comments are no reason to fail.
  writeFileSync(configFile, `// The project folder: the docs build reads it.\n${clean}`)
  assert.equal(adopt('config', '--write').status, 0)
  writeFileSync(configFile, clean)
})

test('status prints the ledger; --json prints it whole', () => {
  const r = adopt('status')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^stories  found  2026-11-07  -      4       0         \d+, \d+, \d+, \d+$/m)
  assert.match(r.stdout, /^ {2}generator:scripts\/build-system\.mjs {2}retire, lost, found, \d+ consumers$/m)
  assert.deepEqual(JSON.parse(adopt('status', '--json').stdout), ledger())
})

test('mark moves a class one state on, needs a batch to cut over, and goes back only with --force', () => {
  assert.equal(adopt('mark', 'stories', 'mapped').stdout, 'stories: found -> mapped\n')
  const jump = adopt('mark', 'stories', 'cut-over', '--batch', 'adopt-3')
  assert.equal(jump.status, 1)
  assert.match(jump.stderr, /stories is mapped, so it moves to shadowed next: one state at a time, or --force to repair the ledger/)
  assert.equal(adopt('mark', 'stories', 'shadowed').status, 0)
  assert.equal(adopt('mark', 'stories', 'proven').status, 0)
  const noBatch = adopt('mark', 'stories', 'cut-over')
  assert.equal(noBatch.status, 1)
  assert.match(noBatch.stderr, /cut-over needs --batch <id>/)
  assert.equal(adopt('mark', 'stories', 'cut-over', '--batch', 'adopt-3').stdout, 'stories: proven -> cut-over (batch adopt-3)\n')
  const s = ledger().classes.stories
  assert.deepEqual([s.state, s.batch, s.assets[0].state, s.assets[0].batch], ['cut-over', 'adopt-3', 'cut-over', 'adopt-3'])
  const back = adopt('mark', 'stories', 'mapped')
  assert.equal(back.status, 1)
  assert.match(back.stderr, /stories is cut-over; moving it back to mapped needs --force/)
  assert.equal(adopt('mark', 'stories', 'mapped', '--force').stdout, 'stories: cut-over -> mapped\n')
  assert.equal(ledger().classes.stories.batch, null)
  assert.equal(adopt('mark', 'stories', 'mapped').stdout, 'stories is already mapped\n')
  const usage = adopt('mark', 'colours', 'mapped')
  assert.equal(usage.status, 1)
  assert.match(usage.stderr, /usage: adopt\.mjs mark <graph\|stories\|audit\|tokens\|docs>/)
  const phase = readJson(project, 'state.json').phases.find((p) => p.id === 'adopt')
  assert.equal(phase.note, 'graph found, stories mapped, audit found, tokens found, docs found')
})

test('a blocker stops its class at mapped, and a hand edit with a typo is caught', () => {
  const l = ledger()
  l.classes.audit.assets[0].loss = 'blocker'
  writeFileSync(join(project, 'adopt', 'ledger.json'), JSON.stringify(l))
  assert.equal(adopt('mark', 'audit', 'mapped').status, 0)
  const past = adopt('mark', 'audit', 'shadowed')
  assert.equal(past.status, 1)
  assert.match(past.stderr, /audit has 1 blocker \(ratchet:docs\/system\/ratchet\.json\), so it cannot move past mapped/)
  assert.match(readJson(project, 'state.json').phases.find((p) => p.id === 'adopt').note, /; audit blocked$/)
  const typo = ledger()
  typo.classes.audit.assets[0].loss = 'lossy'
  writeFileSync(join(project, 'adopt', 'ledger.json'), JSON.stringify(typo))
  const r = adopt('status')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /ratchet:docs\/system\/ratchet\.json has loss "lossy", not one of clean, carried, lost, blocker/)
  typo.classes.audit.assets[0].loss = 'lost'
  writeFileSync(join(project, 'adopt', 'ledger.json'), JSON.stringify(typo))
})

test('a newer ledger or inventory is refused: update massimo', () => {
  const path = join(project, 'adopt', 'ledger.json')
  const saved = readFileSync(path, 'utf8')
  writeFileSync(path, JSON.stringify({ ...JSON.parse(saved), format: 2 }))
  const r = adopt('status')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /adopt\/ledger\.json is format 2, and these scripts \([\d.]+\) read up to 1: update massimo/)
  writeFileSync(path, saved)
  const inv = join(project, 'adopt', 'inventory.json')
  const savedInv = readFileSync(inv, 'utf8')
  writeFileSync(inv, JSON.stringify({ ...JSON.parse(savedInv), format: 2 }))
  assert.match(adopt('plan').stderr, /adopt\/inventory\.json is format 2.*update massimo/)
  // Nor is one overwritten: scan keeps a newer inventory, and plan a newer proposed config.
  writeFileSync(inv, JSON.stringify({ ...JSON.parse(savedInv), format: 2, later: true }))
  const scan = adopt('scan')
  assert.equal(scan.status, 1)
  assert.match(scan.stderr, /adopt\/inventory\.json is format 2.*update massimo/)
  assert.equal(JSON.parse(readFileSync(inv, 'utf8')).later, true)
  writeFileSync(inv, savedInv)
  const proposed = join(project, 'adopt', 'config.proposed.json')
  const savedProposed = readFileSync(proposed, 'utf8')
  writeFileSync(proposed, JSON.stringify({ ...JSON.parse(savedProposed), version: 2 }))
  const ledgerBefore = readFileSync(path, 'utf8')
  const plan = adopt('plan')
  assert.equal(plan.status, 1)
  assert.match(plan.stderr, /adopt\/config\.proposed\.json is format 2.*update massimo/)
  assert.equal(JSON.parse(readFileSync(proposed, 'utf8')).version, 2)
  assert.equal(readFileSync(path, 'utf8'), ledgerBefore)
  writeFileSync(proposed, savedProposed)
})

test('planning again keeps what a class past found agreed, and marks what scan no longer finds', () => {
  const inv = readJson(project, 'adopt', 'inventory.json')
  const first = ledger()
  first.classes.stories.assets.find((a) => a.id === 'pages:src/stories/pages').loss = 'clean'
  first.classes.graph.assets.find((a) => a.id === 'doc:docs/system/graph.md').loss = 'clean'
  const smaller = { ...inv, assets: inv.assets.filter((a) => a.id !== 'gate:lab-integration.mjs' && a.id !== 'doc:docs/system/index.md') }
  const next = planLedger(smaller, first, { date: '2026-11-08' })
  // stories is mapped: its agreed loss stays, and the gate is kept as missing.
  assert.equal(next.classes.stories.assets.find((a) => a.id === 'pages:src/stories/pages').loss, 'clean')
  assert.equal(next.classes.stories.assets.find((a) => a.id === 'gate:lab-integration.mjs').missing, true)
  // graph is still found: planned afresh, and what is gone is gone.
  assert.equal(next.classes.graph.assets.find((a) => a.id === 'doc:docs/system/graph.md').loss, 'carried')
  assert.equal(next.classes.graph.assets.find((a) => a.id === 'doc:docs/system/index.md'), undefined)
  assert.equal(next.classes.graph.date, '2026-11-07')
  // A class at found whose assets are all gone has nothing left to adopt.
  const noDocs = planLedger({ ...inv, assets: inv.assets.filter((a) => a.class !== 'docs') }, first, { date: '2026-11-08' })
  assert.equal(first.classes.docs.state, 'found')
  assert.equal(noDocs.classes.docs, undefined)
})

test("an agreed asset that is massimo's own output leaves the ledger, and its class stays where it was", () => {
  const inv = readJson(project, 'adopt', 'inventory.json')
  const first = ledger()
  const smaller = { ...inv, assets: inv.assets.filter((a) => a.id !== 'lane:src/stories' && a.id !== 'gate:lab-integration.mjs') }
  const next = planLedger(smaller, first, { date: '2026-11-08', own: ['lane:src/stories'] })
  assert.equal(next.classes.stories.assets.find((a) => a.id === 'lane:src/stories'), undefined)
  // Any other asset scan no longer finds is still kept, as missing.
  assert.equal(next.classes.stories.assets.find((a) => a.id === 'gate:lab-integration.mjs').missing, true)
  assert.equal(next.classes.stories.state, first.classes.stories.state)
  // Without it, the same asset is kept as missing too.
  assert.equal(planLedger(smaller, first, { date: '2026-11-08' }).classes.stories.assets.find((a) => a.id === 'lane:src/stories').missing, true)
})

test('a new asset in a class past found starts at found, and takes its class back until it is agreed too', () => {
  const inv = readJson(project, 'adopt', 'inventory.json')
  const first = planLedger(inv, null, { date: 'd0' })
  for (const s of ['mapped', 'shadowed', 'proven']) markClass(first, 'stories', s, { date: 'd1' })
  markClass(first, 'stories', 'cut-over', { batch: 'b2', date: 'd2' })
  assert.equal(first.classes.stories.state, 'cut-over')
  // Ladle turns up in the next scan.
  const ladle = { tool: 'ladle', config: ['.ladle/config.mjs'], scripts: ['ladle'], port: null, files: 1, stories: 1, withArgs: 0, notReadable: 0 }
  const more = { ...inv, stories: { ...inv.stories, tools: [ladle] }, assets: [...inv.assets, { id: 'tool:ladle', class: 'stories', kind: 'tool', paths: ['.ladle/'], consumers: [] }] }
  const next = planLedger(more, first, { date: 'd3' })
  const s = next.classes.stories
  const tool = s.assets.find((a) => a.id === 'tool:ladle')
  const lane = s.assets.find((a) => a.id === 'lane:src/stories')
  assert.deepEqual([s.state, s.date, s.batch], ['found', 'd3', null])
  assert.deepEqual([tool.state, tool.date, tool.batch, tool.decision, tool.loss], ['found', 'd3', null, 'keep', 'carried'])
  assert.deepEqual([lane.state, lane.date, lane.batch], ['cut-over', 'd2', 'b2'])
  assert.equal(ledgerPhase(next).status, 'in_progress')
  // Marked through again, only the new asset moves; the others keep their batch.
  for (const st of ['mapped', 'shadowed', 'proven']) markClass(next, 'stories', st, { date: 'd4' })
  assert.equal(markClass(next, 'stories', 'cut-over', { batch: 'b3', date: 'd5' }), 'stories: proven -> cut-over (batch b3)')
  assert.deepEqual([tool.state, tool.batch, lane.state, lane.batch, lane.date], ['cut-over', 'b3', 'cut-over', 'b2', 'd2'])
  assert.deepEqual([s.state, s.batch], ['cut-over', 'b3'])
  // Planned again with nothing new, the class stays where it is.
  const again = planLedger(more, next, { date: 'd6' }).classes.stories
  assert.deepEqual([again.state, again.date, again.batch], ['cut-over', 'd5', 'b3'])
})

test('mark goes one state at a time; --force repairs, and passing cut-over still needs a batch', () => {
  const l = { classes: { graph: { state: 'found', date: 'x', batch: null, assets: [{ id: 'a', decision: 'convert', loss: 'clean', state: 'found' }] } } }
  assert.throws(() => markClass(l, 'graph', 'retired'), /graph is found, so it moves to mapped next: one state at a time/)
  assert.throws(() => markClass(l, 'graph', 'retired', { force: true }), /cut-over needs --batch <id>/)
  assert.equal(markClass(l, 'graph', 'proven', { force: true, date: 'd1' }), 'graph: found -> proven')
  assert.equal(markClass(l, 'graph', 'retired', { force: true, batch: 'b9', date: 'd2' }), 'graph: proven -> retired (batch b9)')
  assert.deepEqual([l.classes.graph.batch, l.classes.graph.assets[0].state, l.classes.graph.assets[0].batch], ['b9', 'retired', 'b9'])
  // Back from retired to cut-over keeps the batch that cut it over.
  assert.equal(markClass(l, 'graph', 'cut-over', { force: true, date: 'd3' }), 'graph: retired -> cut-over')
  assert.deepEqual([l.classes.graph.batch, l.classes.graph.assets[0].state, l.classes.graph.assets[0].batch], ['b9', 'cut-over', 'b9'])
})

test('a manifest is a blocker by what readManifest says of each entry, not by the wording of its message', () => {
  const inv = readJson(project, 'adopt', 'inventory.json')
  const manifestWith = (fields) => {
    const lane = { ...inv.stories.lane, manifest: { ...inv.stories.lane.manifest, ...fields } }
    return planLedger({ ...inv, stories: { ...inv.stories, lane } }).classes.stories.assets.find((a) => a.id === 'manifest:src/stories/manifest.ts')
  }
  assert.equal(manifestWith({ notReadable: ['cards: entry 2 is built by a call'], entriesNotReadable: ['cards: entry 2 is built by a call'] }).loss, 'blocker')
  assert.equal(manifestWith({ notReadable: ['cards: title is not statically readable'], entriesNotReadable: [] }).loss, 'carried')
  const none = manifestWith({ entries: 0, notReadable: ['the list is assembled elsewhere'], entriesNotReadable: ['the list is assembled elsewhere'] })
  assert.equal(none.loss, 'blocker')
  assert.match(none.lines[0], /^massimo reads no entries from it \(the list is assembled elsewhere\), so it cannot list the stories/)
})

test('a kept asset is cut over, never retired; the phase is done when every class is', () => {
  const l = {
    classes: {
      docs: { state: 'proven', date: 'x', batch: null, assets: [{ id: 'a', decision: 'keep', loss: 'clean', state: 'proven' }, { id: 'b', decision: 'retire', loss: 'lost', state: 'proven' }] },
      audit: { state: 'proven', date: 'x', batch: null, assets: [] },
    },
  }
  markClass(l, 'docs', 'cut-over', { batch: 'b1', date: 'd1' })
  markClass(l, 'docs', 'retired', { date: 'd2' })
  assert.deepEqual(l.classes.docs.assets.map((a) => [a.id, a.state, a.batch]), [['a', 'cut-over', 'b1'], ['b', 'retired', 'b1']])
  assert.equal(ledgerPhase(l).status, 'in_progress')
  markClass(l, 'audit', 'cut-over', { batch: 'b2' })
  assert.deepEqual(ledgerPhase(l), { status: 'done', note: 'docs retired, audit cut-over' })
  assert.deepEqual(STATES, ['found', 'mapped', 'shadowed', 'proven', 'cut-over', 'retired'])
})

test('merging adds what is missing, replaces a default, extends a list and keeps what the user set', () => {
  const { merged, changes } = mergeAdding(
    { stories: { lane: 'native', port: 9000, include: ['a/**'] }, graph: { taxonomy: null } },
    { version: 1, stories: { lane: 'manifest', port: 4400, include: ['b/**'], manifest: 'm.ts' }, graph: { taxonomy: { tiers: ['A'] }, kinds: { page: ['p/**'] } } },
  )
  assert.deepEqual(merged, { stories: { lane: 'manifest', port: 9000, include: ['a/**', 'b/**'], manifest: 'm.ts' }, graph: { taxonomy: { tiers: ['A'] }, kinds: { page: ['p/**'] } }, version: 1 })
  assert.deepEqual(changes.map((c) => [c.path, c.kind]), [
    ['version', 'add'],
    ['stories.lane', 'default'],
    ['stories.port', 'kept'],
    ['stories.include', 'extend'],
    ['stories.manifest', 'add'],
    ['graph.taxonomy', 'add'],
    ['graph.kinds.page', 'add'],
  ])
  // A glob written with its braces in another order is the same glob.
  assert.deepEqual(mergeAdding({ stories: { include: ['s/**/*.{tsx,astro}'] } }, { stories: { include: ['s/**/*.{astro,tsx}'] } }).changes, [])
})

test('the Ladle tool converts under the csf lane, and Ladle without it and Storybook keep their story files', () => {
  const inv = readJson(project, 'adopt', 'inventory.json')
  const tool = (name) => ({ tool: name, config: [`.${name}/config.mjs`], scripts: [name], port: null, files: 2, stories: 3, withArgs: 1, notReadable: 0 })
  const plan = (name, config) => {
    const more = { ...inv, stories: { ...inv.stories, tools: [tool(name)] }, assets: [...inv.assets, { id: `tool:${name}`, class: 'stories', kind: 'tool', paths: [`.${name}/`], consumers: [] }] }
    return planLedger(more, null, { date: 'd0', config }).classes.stories.assets.find((a) => a.id === `tool:${name}`)
  }
  const csf = { stories: { lane: 'csf' } }
  const ladle = plan('ladle', csf)
  assert.deepEqual([ladle.decision, ladle.loss], ['convert', 'carried'])
  assert.match(ladle.lines.join('\n'), /Its 3 stories in 2 files stay where they are, read in place by the csf lane/)
  assert.match(ladle.lines.join('\n'), /1 file uses args or argTypes, which stay in the file and apply at run time/)
  for (const [name, config] of [['ladle', undefined], ['ladle', { stories: { lane: 'manifest' } }], ['storybook', csf]]) {
    const kept = plan(name, config)
    assert.deepEqual([kept.decision, kept.loss], ['keep', 'carried'], name)
    assert.match(kept.lines.join('\n'), /Moving them to the native lane is a later step/)
  }
})
