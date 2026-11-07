// docs.mjs: the design system's README, generated between markers from the
// token set, the graph and the config, with the team's own sections kept.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { SCRIPTS, read, run, scratch } from './helpers.mjs'

const docs = (ctx, args = []) => spawnSync(process.execPath, [join(SCRIPTS, 'docs.mjs'), ...args, '--root', ctx.root, '--project-dir', ctx.project], { encoding: 'utf8' })

test('the README: tokens with their meanings and pairs, components with rules and props', () => {
  const t = scratch()
  try {
    assert.equal(run('graph', t).status, 0)
    const r = docs(t)
    assert.equal(r.status, 0, r.stderr)
    const md = read(t.project, 'README.md')
    assert.match(md, /^# fixture-app design system\n/)
    assert.match(md, /11 tokens in `design-system\/tokens\/tokens\.json` \(the format massimo wrote before 0\.2\.0\), in 2 themes: light, dark\./)
    assert.match(md, /then run `node \.\.\/project\/scripts\/tokens\.mjs build`\./)
    assert.match(md, /\| `color\.bg\.default` \| Page background \|/)
    assert.match(md, /`color\.fg\.muted` on `color\.bg\.default`/)
    assert.match(md, /### Primitives\n\n\| Component \| Use it when \| Props \|\n\|---\|---\|---\|\n\| components\/Button \| a user presses something to run an action; wrap it for links via asChild \| loading: true, false \|/)
    assert.match(md, /## Who decides what/)
  } finally {
    t.cleanup()
  }
})

test('the team\'s own sections are kept, and --check notices a stale block', () => {
  const t = scratch()
  try {
    assert.equal(docs(t).status, 0)
    const path = join(t.project, 'README.md')
    writeFileSync(path, `${read(path)}\n## Our notes\n\nKeep this.\n`)
    assert.equal(docs(t, ['--check']).status, 0)
    // The tokens change; the generated block is now behind.
    writeFileSync(join(t.root, 'design-system', 'tokens', 'tokens.json'), JSON.stringify({ color: { $type: 'color', a: { $value: '#111111', $description: 'Ink' } } }))
    const stale = docs(t, ['--check'])
    assert.equal(stale.status, 1)
    assert.match(stale.stderr, /README\.md is out of date/)
    assert.equal(docs(t).status, 0)
    const md = read(path)
    assert.match(md, /\| `color\.a` \| Ink \|/)
    assert.match(md, /## Our notes\n\nKeep this\.\n$/)
  } finally {
    t.cleanup()
  }
})
