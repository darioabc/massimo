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
  assert.equal(phase.note, 'found lane, headers, graph, ratchet, tokens, design-md; start with adopt.mjs scan')
  assert.match(read(project, 'STATUS.md'), /\| Adopt the repo's own setup \| ○ to do \| found lane/)
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
  assert.deepEqual(asset('stories', 'gate:lab-integration.mjs').consumers, [{ file: 'astro.config.mjs', line: 1, class: 'deploy', how: 'imports' }])
  const phase = readJson(project, 'state.json').phases.find((p) => p.id === 'adopt')
  assert.deepEqual([phase.status, phase.note], ['in_progress', 'graph found, stories found, audit found, tokens found, docs found'])
})

test('the proposed config holds what scan can fill', () => {
  assert.deepEqual(readJson(project, 'adopt', 'config.proposed.json'), {
    version: 1,
    graph: {
      extraKeys: ['breakpoint', 'inputs', 'owner', 'styles', 'theme'],
      keys: { breakpoint: 'breakpoint', inputs: 'definitions', styles: { role: 'list', under: 'src/styles' }, theme: { role: 'scope', values: ['kiosk', 'print'] } },
      taxonomy: { tiers: ['Foundations', 'Primitives', 'Shells', 'Pages', 'Components'], groups: ['Foundations / Icons', 'Primitives / Status', 'Primitives / Actions', 'Shells / Site', 'Pages / Home', 'Components / Cards'] },
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

test('status prints the ledger; --json prints it whole', () => {
  const r = adopt('status')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^stories  found  2026-11-07  -      4       0         \d+, \d+, \d+, \d+$/m)
  assert.match(r.stdout, /^ {2}generator:scripts\/build-system\.mjs {2}retire, lost, found, \d+ consumers$/m)
  assert.deepEqual(JSON.parse(adopt('status', '--json').stdout), ledger())
})

test('mark moves a class forward, needs a batch to cut over, and goes back only with --force', () => {
  assert.equal(adopt('mark', 'stories', 'mapped').stdout, 'stories: found -> mapped\n')
  const noBatch = adopt('mark', 'stories', 'cut-over')
  assert.equal(noBatch.status, 1)
  assert.match(noBatch.stderr, /cut-over needs --batch <id>/)
  assert.equal(adopt('mark', 'stories', 'cut-over', '--batch', 'adopt-3').stdout, 'stories: mapped -> cut-over (batch adopt-3)\n')
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
  writeFileSync(inv, savedInv)
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
