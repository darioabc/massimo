// --help and -h print a script's usage and exit 0 without reading or writing
// the repo: no inventory, no graph, no project folder, no vendored scripts.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { walk } from '../scripts/lib/glob.mjs'
import { SCRIPTS, scratch } from './helpers.mjs'

const contexts = []
after(() => contexts.forEach((c) => c.cleanup()))

// Every script, the two hooks included: a hook answers --help too, and reads no payload for it.
const NAMES = ['adopt', 'agent-guard', 'audit', 'canvas', 'check', 'detect', 'docs', 'graph', 'init', 'serve', 'session-start', 'shoot', 'state', 'stories', 'tokens']
const snapshot = (root) => walk(root).sort().map((f) => `${f}:${readFileSync(join(root, f), 'utf8').length}`)

for (const name of NAMES) {
  for (const flag of ['--help', '-h']) {
    test(`${name}.mjs ${flag} prints its usage and writes nothing`, () => {
      const ctx = scratch('csf-lane')
      contexts.push(ctx)
      const before = snapshot(ctx.root)
      const r = spawnSync(process.execPath, [join(SCRIPTS, `${name}.mjs`), flag, '--root', ctx.root, '--project-dir', ctx.project], { encoding: 'utf8', timeout: 20000, input: '' })
      assert.equal(r.status, 0, r.stderr)
      const header = readFileSync(join(SCRIPTS, `${name}.mjs`), 'utf8').split('\n').filter((l) => l.startsWith('//'))[0].slice(3)
      assert.ok(r.stdout.startsWith(header), r.stdout.slice(0, 120))
      assert.equal(r.stderr, '')
      assert.deepEqual(snapshot(ctx.root), before)
      assert.ok(!existsSync(ctx.project), 'no project folder')
    })
  }
}
