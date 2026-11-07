// Project state: init writes the git attributes, state.json changes land
// through a temporary file under a lock with ISO timestamps, and several runs
// at once all keep their change.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { stripJsonComments, withLock, writeFileAtomic } from '../scripts/lib/project.mjs'
import { SCRIPTS, read, readJson, scratch } from './helpers.mjs'

const ctx = scratch()
after(() => ctx.cleanup())
const project = join(ctx.root, 'design-system')
const runIn = (name, args = []) => spawnSync(process.execPath, [join(SCRIPTS, `${name}.mjs`), ...args, '--root', ctx.root], { encoding: 'utf8' })

test('init writes .gitattributes so decisions.md merges by keeping both sides', () => {
  const r = runIn('init', ['--no-npm-scripts'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(project, '.gitattributes'), 'decisions.md merge=union\n')
  assert.match(read(project, '.gitignore'), /^\*\.lock$/m)
})

test('state.json timestamps are ISO, and STATUS.md shows the date', () => {
  assert.equal(runIn('state', ['set', 'graph', 'in_progress', '--note', 'started']).status, 0)
  const state = readJson(project, 'state.json')
  assert.match(state.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.match(state.phases.find((p) => p.id === 'graph').updatedAt, /T\d{2}:/)
  assert.match(read(project, 'STATUS.md'), /state\.mjs on \d{4}-\d{2}-\d{2}\. /)
  assert.deepEqual(readdirSync(project).filter((f) => /\.(lock|tmp)$/.test(f)), [])
})

test('runs at the same time all keep their change', async () => {
  const runs = Array.from({ length: 6 }, (_, i) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [join(SCRIPTS, 'state.mjs'), 'explore', `topic-${i}`, '--status', 'framing', '--root', ctx.root])
      child.on('close', done)
    }).then(() =>
      new Promise((done) => {
        const child = spawn(process.execPath, [join(SCRIPTS, 'state.mjs'), 'decide', `decision ${i}`, '--root', ctx.root])
        child.on('close', done)
      }),
    ),
  )
  await Promise.all(runs)
  const topics = readJson(project, 'state.json').explorations.map((e) => e.topic)
  assert.deepEqual(topics, ['topic-0', 'topic-1', 'topic-2', 'topic-3', 'topic-4', 'topic-5'])
  const decisions = read(project, 'decisions.md')
  for (let i = 0; i < 6; i++) assert.match(decisions, new RegExp(`decision ${i}\\.$`, 'm'))
})

test('a lock left by a dead run is taken over; a live one waits its turn', () => {
  const file = join(project, 'x.json')
  writeFileSync(`${file}.lock`, '')
  const old = new Date(Date.now() - 60000)
  spawnSync('touch', ['-t', `${old.getFullYear()}01010000`, `${file}.lock`])
  assert.equal(withLock(file, () => 'ran'), 'ran')
  assert.ok(!existsSync(`${file}.lock`))
  writeFileAtomic(file, '{"a":1}\n')
  assert.equal(read(file), '{"a":1}\n')
})

test('JSONC: trailing commas go only outside strings, even before a comment', () => {
  const text = '{ "a": "x,}", "b": [1, 2, // two\n ], /* c */ "c": "y,]", }'
  assert.deepEqual(JSON.parse(stripJsonComments(text)), { a: 'x,}', b: [1, 2], c: 'y,]' })
})
