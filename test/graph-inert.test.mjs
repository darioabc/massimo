// A project that sets none of the keys for adopting a repo's own setup gets
// the same graph.md, graph.json and README as the scripts wrote before them,
// byte for byte. The golden files were written by massimo 0.2.1.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULTS, STORIES_0_4_0_KEYS } from '../scripts/lib/project.mjs'
import { SCRIPTS, golden, read, run, scratch } from './helpers.mjs'

const docs = (ctx) => spawnSync(process.execPath, [join(SCRIPTS, 'docs.mjs'), '--root', ctx.root, '--project-dir', ctx.project], { encoding: 'utf8' })

function outputs(patch = null) {
  const t = scratch()
  try {
    if (patch) {
      const path = join(t.root, 'massimo.config.json')
      writeFileSync(path, JSON.stringify(patch(JSON.parse(readFileSync(path, 'utf8')))))
    }
    const g = run('graph', t)
    assert.equal(g.status, 0, g.stderr)
    assert.equal(docs(t).status, 0)
    return { md: read(t.project, 'graph.md'), json: read(t.project, 'graph.json'), readme: read(t.project, 'README.md') }
  } finally {
    t.cleanup()
  }
}

const same = (name, text) => assert.equal(text, golden(name, text) ?? text, name)

test('the app fixture, untouched, writes what 0.2.1 wrote', () => {
  const out = outputs()
  same('graph-app/graph.md', out.md)
  same('graph-app/graph.json', out.json)
  same('graph-app/README.md', out.readme)
})

test('extra keys and the native lane, set the 0.2.1 way, write what 0.2.1 wrote', () => {
  const out = outputs((c) => ({ ...c, stories: { ...c.stories, lane: 'native' }, graph: { extraKeys: ['bogus'] } }))
  same('graph-app-extra/graph.md', out.md)
  same('graph-app-extra/graph.json', out.json)
})

test('every 0.4.0 stories key at its default writes what 0.2.1 wrote', () => {
  const defaults = Object.fromEntries(STORIES_0_4_0_KEYS.map((key) => [key, DEFAULTS.stories[key]]))
  const out = outputs((c) => ({ ...c, stories: { ...c.stories, ...defaults } }))
  same('graph-app/graph.md', out.md)
  same('graph-app/graph.json', out.json)
  same('graph-app/README.md', out.readme)
})

test('a manifest lane writes the same story lane summary, with no csf fields', () => {
  const t = scratch('adopt')
  try {
    assert.equal(run('graph', t).status, 0)
    const lane = JSON.parse(read(t.project, 'graph.json')).storyLane
    assert.deepEqual(Object.keys(lane), ['manifest', 'entries', 'states', 'direct', 'incidental', 'none', 'problems'])
  } finally {
    t.cleanup()
  }
})
