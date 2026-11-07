// A project that sets none of the audit's newer keys gets the same audit, byte
// for byte, as the release before them: the same latest.json, latest.md and
// baseline.json. The fixture holds what those keys would change (a header
// key with a role, a spacing primitive, a var() in an arbitrary value, media
// widths and screen variants), so a key that leaks into the default shows here.
//
// The golden files were written by massimo 0.2.1. Never regenerate them to
// make this test pass: a difference is a change existing projects would see.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { golden, read, run, scratch } from './helpers.mjs'

const ctx = scratch()
after(() => ctx.cleanup())

writeFileSync(join(ctx.root, 'src', 'adopt.tsx'), [
  '// ds:group Primitives / Actions',
  '// ds:inputs --local-x',
  '// ds:theme print',
  'export const Adopt = () => (',
  '  <div',
  '    className="min-[400px]:flex lg:p-2 max-sm:hidden bg-[var(--brand-teal)] text-[color:var(--color-primary)]"',
  "    style={{ gap: 'var(--local-x)', padding: 'var(--spacing-1)', color: 'var(--color-neutral-500)' }}",
  '  />',
  ')',
  '',
].join('\n'))
writeFileSync(join(ctx.root, 'src', 'adopt.css'), [
  '/* ds:breakpoint 30rem the bar folds */',
  '@media (min-width: 30rem) { .x { color: var(--color-neutral-0); } }',
  '@media (width >= 400px) { .y { margin: var(--spacing-2); } }',
  '',
].join('\n'))

test('with no newer key set, the audit writes what 0.2.1 wrote', () => {
  process.env.MASSIMO_TODAY = '2026-01-02'
  const r = run('audit', ctx, ['--baseline'])
  assert.equal(r.status, 0, r.stderr)
  for (const name of ['latest.json', 'latest.md', 'baseline.json']) {
    const now = read(ctx.project, 'audits', name)
    const expected = golden(`audit-unchanged/${name}`, now)
    if (expected !== undefined) assert.equal(now, expected, name)
  }
  const check = run('audit', ctx, ['--check'])
  assert.equal(check.status, 0, check.stderr)
  assert.equal(check.stdout, golden('audit-unchanged/check.txt', check.stdout) ?? check.stdout)
})
