// A project that sets none of the token keys added for adopting a repo's own
// setup (tokens.mirror, tokens.inventory) extracts, builds and checks exactly
// as before: the golden files under test/golden/unchanged were written by the
// scripts before those keys existed.

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { readCss } from '../scripts/lib/readers.mjs'
import { FIXTURES, golden, read, run, scratch } from './helpers.mjs'

const ctx = scratch()
after(() => ctx.cleanup())
const same = (name, text) => assert.equal(text, golden(`unchanged/${name}`, text) ?? text, name)

test('extract writes the same draft and report', () => {
  const r = run('tokens', ctx, ['extract'])
  assert.equal(r.status, 0, r.stderr)
  const dir = join(ctx.project, 'tokens', 'draft')
  for (const f of ['tokens.resolver.json', 'base.tokens.json', 'theme/dark.tokens.json', 'report.md']) same(`draft/${f}`, read(dir, f))
})

test('build writes the same outputs, and check says the same', () => {
  assert.equal(run('tokens', ctx, ['build']).status, 0)
  const styles = join(ctx.root, 'src', 'styles')
  for (const f of readdirSync(styles).filter((n) => n.startsWith('tokens.') || n.startsWith('_tokens'))) same(`build/${f}`, read(styles, f))
  same('build/figma-variables.json', read(ctx.project, 'tokens', 'figma-variables.json'))
  same('build/kit.css', read(ctx.project, 'kit', 'kit.css'))
  const check = run('tokens', ctx, ['check'])
  assert.equal(check.status, 0, check.stderr)
  same('check.txt', `${check.stdout}${check.stderr}`)
})

test('the CSS reader reads every fixture as before', () => {
  const dir = join(FIXTURES, 'readers')
  for (const f of ['channels.css', 'conditions.css', 'families.css', 'scopes.css']) same(`readers/${f}.json`, `${JSON.stringify(readCss(dir, [f]), null, 2)}\n`)
})
