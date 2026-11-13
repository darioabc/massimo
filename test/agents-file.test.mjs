// Any agent can run massimo from the repo: init copies the playbooks beside
// the scripts and keeps a block in AGENTS.md that says where to start.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SCRIPTS } from './helpers.mjs'

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-agents-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const init = (root, args = []) => spawnSync(process.execPath, [join(SCRIPTS, 'init.mjs'), ...args, '--root', root], { encoding: 'utf8' })
const text = (...parts) => readFileSync(join(...parts), 'utf8')

test('init copies the playbooks and writes the AGENTS.md block, naming every playbook', () => {
  const r = repo({ 'package.json': '{"dependencies":{"react":"18"}}', 'src/components/Button.tsx': 'export default 1' })
  try {
    const out = init(r.root)
    assert.equal(out.status, 0, out.stderr)
    const playbooks = join(r.root, 'design-system', 'playbooks')
    for (const f of ['skills/ux/SKILL.md', 'skills/artifact/SKILL.md', 'agents/reviewer.md', 'reference/project.md', 'reference/method.md', 'templates/STATUS.md']) assert.ok(existsSync(join(playbooks, f)), f)
    // The copy is the plugin's file, byte for byte.
    assert.equal(text(playbooks, 'skills', 'ux', 'SKILL.md'), text(SCRIPTS, '..', 'skills', 'ux', 'SKILL.md'))
    const agents = text(r.root, 'AGENTS.md')
    assert.match(agents, /^# Agents\n\n<!-- massimo:agents:start -->\n## Design system \(massimo\)\n/)
    assert.ok(agents.endsWith('<!-- massimo:agents:end -->\n'))
    for (const name of readdirSync(join(SCRIPTS, '..', 'skills'))) assert.match(agents, new RegExp(`\\b${name}\\b`), name)
    assert.match(agents, /`design-system\/playbooks\/skills\/<name>\/SKILL\.md`/)
    assert.match(agents, /`<plugin>` is `design-system\/playbooks`/)
    assert.match(agents, /`node design-system\/scripts\/check\.mjs` runs every check CI runs\./)
    assert.ok(JSON.parse(out.stdout).created.includes('AGENTS.md'))
  } finally {
    r.cleanup()
  }
})

test("the block goes into the repo's own AGENTS.md and is replaced in place on an update", () => {
  const r = repo({ 'package.json': '{}', 'AGENTS.md': '# House rules\n\nUse pnpm.\n' })
  try {
    assert.equal(init(r.root).status, 0)
    const first = text(r.root, 'AGENTS.md')
    assert.ok(first.startsWith('# House rules\n\nUse pnpm.\n\n<!-- massimo:agents:start -->\n'))
    // A second run leaves it alone; an update rewrites only what sits between the markers.
    assert.equal(init(r.root).status, 0)
    assert.equal(text(r.root, 'AGENTS.md'), first)
    writeFileSync(join(r.root, 'AGENTS.md'), first.replace('## Design system (massimo)', '## Old heading').replace('Use pnpm.', 'Use pnpm.\n\nAnd tabs.') + '\nAfter.\n')
    const out = init(r.root, ['--update-scripts'])
    assert.equal(out.status, 0, out.stderr)
    const next = text(r.root, 'AGENTS.md')
    assert.ok(next.includes('## Design system (massimo)') && !next.includes('## Old heading'))
    assert.ok(next.includes('And tabs.') && next.endsWith('<!-- massimo:agents:end -->\n\nAfter.\n'))
    assert.ok(JSON.parse(out.stdout).updated.includes('AGENTS.md'))
  } finally {
    r.cleanup()
  }
})

test('--no-agents-file leaves AGENTS.md alone, and a project folder of another name is the one the block names', () => {
  const r = repo({ 'package.json': '{}' })
  const other = repo({ 'package.json': '{}' })
  try {
    assert.equal(init(r.root, ['--no-agents-file']).status, 0)
    assert.ok(!existsSync(join(r.root, 'AGENTS.md')))
    assert.ok(existsSync(join(r.root, 'design-system', 'playbooks', 'skills', 'start', 'SKILL.md')))
    assert.equal(init(other.root, ['--config-json', '{"projectDir":".massimo"}']).status, 0)
    assert.match(text(other.root, 'AGENTS.md'), /`\.massimo\/playbooks\/skills\/<name>\/SKILL\.md`/)
    assert.ok(existsSync(join(other.root, '.massimo', 'playbooks', 'agents', 'ideator.md')))
  } finally {
    r.cleanup()
    other.cleanup()
  }
})
