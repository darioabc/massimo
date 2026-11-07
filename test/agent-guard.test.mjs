// The PreToolUse guard: massimo's reviewers write nothing, its ideator writes
// only inside the explorations folder, and everyone else passes untouched.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { SCRIPTS, scratch } from './helpers.mjs'

const ctx = scratch()
after(() => ctx.cleanup())
mkdirSync(join(ctx.root, 'design-system', 'explorations', 'checkout', 'round-1'), { recursive: true })
symlinkSync(join(ctx.root, 'src'), join(ctx.root, 'design-system', 'explorations', 'sneaky'))

function guard(input) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'agent-guard.mjs')], { input: JSON.stringify({ cwd: ctx.root, tool_name: 'Write', ...input }), encoding: 'utf8' })
  assert.equal(r.status, 0)
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null
}
const write = (agent, file) => guard({ agent_type: agent, tool_input: { file_path: file } })

test('anyone who is not a massimo agent passes', () => {
  assert.equal(guard({ tool_input: { file_path: 'src/x.ts' } }), null)
  assert.equal(write('Explore', 'src/x.ts'), null)
  assert.equal(write('massimo:translator', 'src/x.ts'), null)
})

test('the reviewers write nothing', () => {
  for (const agent of ['massimo:reviewer', 'massimo:visual-reviewer', 'reviewer']) {
    const out = write(agent, 'design-system/explorations/checkout/notes.md')
    assert.equal(out.permissionDecision, 'deny', agent)
  }
})

test('the ideator writes inside explorations only, symlinks followed', () => {
  assert.equal(write('massimo:ideator', 'design-system/explorations/checkout/round-1/Main.html'), null)
  assert.equal(write('ideator', join(ctx.root, 'design-system/explorations/checkout/round-2/new/Main.html')), null)
  for (const file of ['src/components/Button.tsx', 'design-system/tokens/tokens.json', 'design-system/explorations/../state.json', 'design-system/explorations/sneaky/x.tsx']) {
    const out = write('massimo:ideator', file)
    assert.equal(out?.permissionDecision, 'deny', file)
    assert.match(out.permissionDecisionReason, /writes only its round files/)
  }
})

test('a bare agent name outside a massimo repo is someone else\'s agent', () => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'agent-guard.mjs')], {
    input: JSON.stringify({ cwd: '/', agent_type: 'reviewer', tool_name: 'Write', tool_input: { file_path: '/tmp/x' } }),
    encoding: 'utf8',
  })
  assert.equal(r.stdout, '')
})

test('a broken input never blocks', () => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'agent-guard.mjs')], { input: 'not json', encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})
