// Files written by a newer massimo are refused by name, never guessed at;
// a project that needs newer scripts says so; lowering a baseline never
// drops what this version did not measure; and a plugin run says when the
// project's vendored copy is older.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { SCRIPTS_VERSION, olderThan } from '../scripts/lib/project.mjs'
import { readJson, run, scratch } from './helpers.mjs'

const contexts = []
after(() => contexts.forEach((c) => c.cleanup()))
const fresh = () => {
  const ctx = scratch()
  contexts.push(ctx)
  return ctx
}
const config = (ctx, extra) => {
  const path = join(ctx.root, 'massimo.config.json')
  writeFileSync(path, JSON.stringify({ ...readJson(path), ...extra }))
}
const updateHint = /update massimo \(init\.mjs --update-scripts\)/

test('versions compare part by part', () => {
  assert.ok(olderThan('0.2.9', '0.2.10'))
  assert.ok(!olderThan('0.3.0', '0.2.10'))
  assert.ok(!olderThan('0.2.1', '0.2.1'))
})

test('a config in a newer format, or one that needs newer scripts, is refused by name', () => {
  const ctx = fresh()
  config(ctx, { version: 2 })
  const r = run('graph', ctx)
  assert.equal(r.status, 1)
  assert.match(r.stderr, new RegExp(`massimo\\.config\\.json is format 2, and these scripts \\(${SCRIPTS_VERSION.replace(/\./g, '\\.')}\\) read up to 1`))
  assert.match(r.stderr, updateHint)
  config(ctx, { version: 1, minScripts: '9.0.0' })
  const r2 = run('audit', ctx)
  assert.equal(r2.status, 1)
  assert.match(r2.stderr, /needs massimo scripts 9\.0\.0 or later/)
  config(ctx, { minScripts: SCRIPTS_VERSION })
  assert.equal(run('graph', ctx).status, 0)
})

test('a graph.json or baseline.json in a newer format is refused, not read as this one', () => {
  const ctx = fresh()
  assert.equal(run('graph', ctx).status, 0)
  writeFileSync(join(ctx.project, 'graph.json'), JSON.stringify({ version: 2, nodes: [] }))
  const docs = run('docs', ctx)
  assert.equal(docs.status, 1)
  assert.match(docs.stderr, /graph\.json is format 2/)
  mkdirSync(join(ctx.project, 'audits'), { recursive: true })
  writeFileSync(join(ctx.project, 'audits', 'baseline.json'), JSON.stringify({ version: 2, kinds: {} }))
  for (const flag of ['--check', '--lower']) {
    const r = run('audit', ctx, [flag])
    assert.equal(r.status, 1, flag)
    assert.match(r.stderr, /audits\/baseline\.json is format 2/)
  }
})

test('--lower keeps a kind it did not measure: skipped this run, or unknown to these scripts', () => {
  const ctx = fresh()
  assert.equal(run('audit', ctx, ['--baseline']).status, 0)
  const path = join(ctx.project, 'audits', 'baseline.json')
  const doc = readJson(path)
  const future = { count: 3, offenders: { 'src/a.css: 1': 3 } }
  doc.kinds['future-kind'] = future
  // With no Tailwind in styling, this run skips the Tailwind palette kind.
  const held = { count: 2, offenders: { 'src/b.tsx: bg-red-500': 2 } }
  doc.kinds['tailwind-palette'] = held
  writeFileSync(path, JSON.stringify(doc))
  config(ctx, { styling: [] })
  const r = run('audit', ctx, ['--lower'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /kept future-kind, which these scripts do not measure/)
  const after_ = readJson(path)
  assert.deepEqual(after_.kinds['future-kind'], future)
  assert.deepEqual(readJson(ctx.project, 'audits', 'latest.json').skipped['tailwind-palette'], 'no Tailwind in styling')
  assert.deepEqual(after_.kinds['tailwind-palette'], held)
  const check = run('audit', ctx, ['--check'])
  assert.match(check.stdout, /the baseline also tracks future-kind, which these scripts do not check: update massimo/)
})

test('run from the plugin, a script warns when the vendored copy is older', () => {
  const ctx = fresh()
  mkdirSync(join(ctx.project, 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(ctx.project, 'scripts', 'lib', 'project.mjs'), "export const SCRIPTS_VERSION = '0.1.0'\n")
  const r = run('graph', ctx)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /warn: the project's vendored scripts are 0\.1\.0, older than this/)
})
