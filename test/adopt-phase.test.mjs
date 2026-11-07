// The adopt phase is optional: a project without its entry (made by 0.2.x)
// has it skipped, so its next step, its STATUS.md, its session hook and its
// done-over-total count are as they were. init sets it to do only when the
// repo has something to adopt, and when an older script drops the entry on
// save, the ledger brings it back.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { emptyState, hookBanner, hookContext, loadState, nextPhase, progressMarkdown, setPhase } from '../scripts/lib/state.mjs'
import { SCRIPTS, read, readJson, scratch } from './helpers.mjs'

// A project as 0.2.1 left it: no adopt entry, setup done, graph in progress.
const OLD_STATE = {
  version: 1,
  massimo: '0.2.1',
  createdAt: '2026-10-30T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
  phases: [
    { id: 'setup', status: 'done', note: 'astro, css', updatedAt: '2026-10-30T09:00:00.000Z' },
    { id: 'graph', status: 'in_progress', note: '12 of 20 components', updatedAt: '2026-11-01T09:00:00.000Z' },
    { id: 'stories', status: 'todo', note: '', updatedAt: null },
    { id: 'tokens', status: 'todo', note: '', updatedAt: null },
    { id: 'tidy', status: 'todo', note: '', updatedAt: null },
    { id: 'guard', status: 'todo', note: '', updatedAt: null },
    { id: 'figma', status: 'skipped', note: 'no Figma', updatedAt: '2026-10-30T09:00:00.000Z' },
  ],
  explorations: [],
}

// What 0.2.1 wrote in STATUS.md's block and its hook for that state.
const OLD_BLOCK = [
  '_Generated from state.json by state.mjs on 2026-11-01. Do not edit this block by hand._',
  '',
  '| Phase | Status | Progress | Run |',
  '|---|---|---|---|',
  '| Set up the project | ✓ done | astro, css | `/massimo:start` |',
  '| Map the component graph | ◐ in progress | 12 of 20 components | `/massimo:graph` |',
  '| Story lane and baseline stories | ○ to do |  | `/massimo:stories` |',
  '| Audit and define tokens | ○ to do |  | `/massimo:tokens` |',
  '| Tidy raw values and duplicates | ○ to do |  | `/massimo:tidy` |',
  '| Rules, docs and CI guard | ○ to do |  | `/massimo:guard` |',
  '| Mirror to Figma | – skipped | no Figma | `/massimo:figma` |',
  '',
  '**Next phase:** Map the component graph, with `/massimo:graph`.',
].join('\n')
const OLD_HOOK =
  'This repo has a massimo design-system project in design-system/. Phases: setup ✓ (astro, css), graph ◐ (12 of 20 components), stories ○, tokens ○, tidy ○, guard ○, figma – (no Figma). Next: graph via /massimo:graph. Before design-system or UI work, read design-system/STATUS.md. The user can resume with /massimo:start.'

const ctx = scratch()
after(() => ctx.cleanup())
const project = join(ctx.root, 'design-system')
mkdirSync(project, { recursive: true })
writeFileSync(join(project, 'state.json'), `${JSON.stringify(OLD_STATE, null, 2)}\n`)
const env = { ...process.env, MASSIMO_TODAY: '2026-11-07' }
const run = (name, args = []) => spawnSync(process.execPath, [join(SCRIPTS, `${name}.mjs`), ...args, '--root', ctx.root], { encoding: 'utf8', env })

test('a 0.2.x project reads with adopt skipped, and its next step, STATUS block, hook and count are unchanged', () => {
  const state = loadState(project)
  assert.deepEqual(state.phases[1], { id: 'adopt', status: 'skipped', note: '', updatedAt: null })
  assert.equal(nextPhase(state).id, 'graph')
  assert.equal(progressMarkdown(state), OLD_BLOCK)
  assert.equal(hookContext(state, 'design-system'), OLD_HOOK)
  assert.equal(hookBanner(state), 'massimo: design-system project 1/6 phases done, next: /massimo:graph')
  const next = run('state', ['next'])
  assert.equal(next.stdout, 'graph (in_progress) → /massimo:graph\n')
})

test('the session hook says the same for a 0.2.x project', () => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'session-start.mjs')], { encoding: 'utf8', env: { ...env, CLAUDE_PROJECT_DIR: ctx.root } })
  const out = JSON.parse(r.stdout)
  assert.equal(out.systemMessage, 'massimo: design-system project 1/6 phases done, next: /massimo:graph')
  assert.equal(out.hookSpecificOutput.additionalContext, OLD_HOOK)
})

test('a fresh project has adopt skipped and out of sight until init finds something to adopt', () => {
  const state = emptyState()
  assert.equal(state.phases.find((p) => p.id === 'adopt').status, 'skipped')
  assert.doesNotMatch(progressMarkdown(state), /Adopt/)
  assert.doesNotMatch(hookContext(state, 'ds'), /adopt/)
  assert.equal(hookBanner(state), 'massimo: design-system project 0/7 phases done, next: /massimo:start')
  setPhase(state, 'setup', 'done')
  setPhase(state, 'adopt', 'todo', 'found lane')
  assert.equal(nextPhase(state).id, 'adopt')
  assert.match(progressMarkdown(state), /\| Adopt the repo's own setup \| ○ to do \| found lane \| `\/massimo:adopt` \|/)
  assert.match(hookContext(state, 'ds'), /setup ✓, adopt ○ \(found lane\), graph ○.*Next: adopt via \/massimo:adopt\./)
  assert.equal(hookBanner(state), 'massimo: design-system project 1/8 phases done, next: /massimo:adopt')
  // Skipped by the user, with a reason, it shows.
  setPhase(state, 'adopt', 'skipped', 'native lane instead')
  assert.match(progressMarkdown(state), /\| Adopt the repo's own setup \| – skipped \| native lane instead \|/)
})

test('init on a repo with nothing to adopt leaves the phase skipped and unseen', () => {
  const plain = scratch('sheets')
  try {
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'init.mjs'), '--root', plain.root, '--no-npm-scripts'], { encoding: 'utf8', env })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).adoptable, undefined)
    const state = readJson(plain.root, 'design-system', 'state.json')
    assert.deepEqual(state.phases.find((p) => p.id === 'adopt'), { id: 'adopt', status: 'skipped', note: '', updatedAt: null })
    assert.doesNotMatch(read(plain.root, 'design-system', 'STATUS.md'), /Adopt/)
  } finally {
    plain.cleanup()
  }
})

test('init --update-scripts vendors adopt, leaves the old state.json as it was, and the copy reads it', () => {
  mkdirSync(join(project, 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(project, 'scripts', 'lib', 'project.mjs'), "export const SCRIPTS_VERSION = '0.2.0'\n")
  const before = read(project, 'state.json')
  const r = run('init', ['--update-scripts', '--no-npm-scripts'])
  assert.equal(r.status, 0, r.stderr)
  for (const f of ['scripts/adopt.mjs', 'scripts/lib/adopt.mjs', 'scripts/lib/inventory.mjs']) assert.ok(JSON.parse(r.stdout).created.includes(`design-system/${f}`), f)
  assert.equal(read(project, 'state.json'), before)
  const show = spawnSync(process.execPath, [join(project, 'scripts', 'state.mjs'), 'show', '--root', ctx.root], { encoding: 'utf8', env })
  assert.equal(show.status, 0, show.stderr)
  assert.doesNotMatch(show.stdout, /Adopt/)
  assert.match(show.stdout, /\*\*Next phase:\*\* Map the component graph/)
})

test('the start skill offers adopt when detect reports something adoptable, and Resume can route to it', () => {
  const skill = read(SCRIPTS, '..', 'skills', 'start', 'SKILL.md')
  assert.match(skill, /If detect reports `adoptable`/)
  assert.match(skill, /Recommend massimo's native story lane only when there is nothing to adopt/)
  assert.match(skill, /node <project>\/scripts\/adopt\.mjs`: `scan`, `plan`, `config`/)
  assert.match(skill, /invoke the phase skill: `adopt`/)
})

test('when an older script drops the adopt entry, the ledger brings it back', () => {
  const ledger = {
    format: 1,
    generatedBy: 'massimo adopt',
    classes: {
      graph: { state: 'mapped', date: '2026-11-05', batch: null, assets: [{ id: 'headers', decision: 'keep', loss: 'clean', state: 'mapped', consumers: [] }] },
      stories: { state: 'found', date: '2026-11-05', batch: null, assets: [{ id: 'lane:x', decision: 'keep', loss: 'blocker', state: 'found', consumers: [] }] },
    },
  }
  mkdirSync(join(project, 'adopt'), { recursive: true })
  writeFileSync(join(project, 'adopt', 'ledger.json'), JSON.stringify(ledger))
  // state.json still has no adopt entry, as a 0.2.x save leaves it.
  const state = loadState(project)
  assert.deepEqual(state.phases[1], { id: 'adopt', status: 'in_progress', note: 'graph mapped, stories found; stories blocked', updatedAt: null })
  assert.equal(nextPhase(state).id, 'adopt')
  assert.match(run('state', ['show']).stdout, /\| Adopt the repo's own setup \| ◐ in progress \| graph mapped, stories found; stories blocked \|/)
  // A ledger these scripts cannot read is left alone, and the phase stays skipped.
  writeFileSync(join(project, 'adopt', 'ledger.json'), JSON.stringify({ ...ledger, format: 2 }))
  assert.equal(loadState(project).phases[1].status, 'skipped')
})
