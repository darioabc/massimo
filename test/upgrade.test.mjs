// A project made by massimo 0.1.1 comes forward cleanly: migrate waits for
// the vendored scripts, `init.mjs --update-scripts` brings them to this
// version without touching the project's files, the old tokens.json builds as
// before, the old state.json reads, and the vendored copy can then migrate.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { SCRIPTS_VERSION } from '../scripts/lib/project.mjs'
import { SCRIPTS, read, readJson, scratch } from './helpers.mjs'

const ctx = scratch()
after(() => ctx.cleanup())
const project = join(ctx.root, 'design-system')
const vendored = join(project, 'scripts')
const plugin = (name, args = []) => spawnSync(process.execPath, [join(SCRIPTS, `${name}.mjs`), ...args, '--root', ctx.root], { encoding: 'utf8' })
const local = (name, args = []) => spawnSync(process.execPath, [join(vendored, `${name}.mjs`), ...args, '--root', ctx.root], { encoding: 'utf8' })

// The project as 0.1.1 left it: date-only timestamps, all of shots/ ignored,
// no .gitattributes, and 0.1.1's scripts vendored.
const oldState = {
  version: 1,
  massimo: '0.1.1',
  createdAt: '2026-10-28',
  updatedAt: '2026-10-29',
  phases: [{ id: 'setup', status: 'done', note: 'react, tailwind4', updatedAt: '2026-10-28' }, { id: 'tokens', status: 'done', note: '11 tokens', updatedAt: '2026-10-29' }],
  explorations: [],
}
writeFileSync(join(project, 'state.json'), `${JSON.stringify(oldState, null, 2)}\n`)
writeFileSync(join(project, 'STATUS.md'), '# Design-system project\n\n<!-- massimo:progress:start -->\n<!-- massimo:progress:end -->\n\n## Where we are\n\nTokens done.\n')
writeFileSync(join(project, 'decisions.md'), '# Decisions\n\nAppend-only. Newest at the bottom.\n\n- 2026-10-28 · setup · Use the native lane.\n')
writeFileSync(join(project, '.gitignore'), 'shots/\n')
mkdirSync(join(vendored, 'lib'), { recursive: true })
writeFileSync(join(vendored, 'lib', 'project.mjs'), "export const SCRIPTS_VERSION = '0.1.1'\n")

test('migrate waits until the vendored scripts are updated', () => {
  const r = plugin('tokens', ['migrate'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, new RegExp(`are 0\\.1\\.1, older than this ${SCRIPTS_VERSION.replace(/\./g, '\\.')}; update them first`))
})

test('init --update-scripts brings the scripts forward and leaves the project as it was', () => {
  const tokensBefore = read(project, 'tokens', 'tokens.json')
  const r = plugin('init', ['--update-scripts', '--no-npm-scripts'])
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout)
  assert.equal(report.scriptsVersion, SCRIPTS_VERSION)
  assert.match(read(vendored, 'lib', 'project.mjs'), new RegExp(`SCRIPTS_VERSION = '${SCRIPTS_VERSION}'`))
  for (const f of ['dtcg.mjs', 'figma.mjs', 'readers.mjs', 'propose.mjs', 'props.mjs', 'jsobject.mjs', 'designmd.mjs', 'text.mjs']) {
    assert.ok(readdirSync(join(vendored, 'lib')).includes(f), f)
  }
  assert.ok(readdirSync(vendored).includes('docs.mjs'))
  // The project's own files are kept; only what 0.2.0 adds is new.
  assert.equal(read(project, 'tokens', 'tokens.json'), tokensBefore)
  assert.equal(readJson(project, 'state.json').updatedAt, '2026-10-29')
  assert.equal(read(project, '.gitattributes'), 'decisions.md merge=union\n')
  assert.ok(report.warnings.some((w) => /ignores all of shots\//.test(w)))
  assert.ok(report.skipped.includes('design-system/state.json'))
})

test('the updated copy reads the old state and builds the old tokens.json', () => {
  const show = local('state', ['show'])
  assert.equal(show.status, 0, show.stderr)
  assert.match(show.stdout, /massimo 0\.1\.1, updated 2026-10-29/)
  assert.equal(local('state', ['set', 'graph', 'in_progress']).status, 0)
  assert.match(readJson(project, 'state.json').updatedAt, /T\d{2}:\d{2}/)
  const build = local('tokens', ['build'])
  assert.equal(build.status, 0, build.stderr)
  assert.equal(local('tokens', ['check']).status, 0)
})

test('then it migrates, and every output builds the same', () => {
  const r = local('tokens', ['migrate'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /0 values not carried over exactly, 0 outputs changed/)
  assert.equal(readJson(ctx.root, 'massimo.config.json').tokens.source, 'design-system/tokens/tokens.resolver.json')
  assert.equal(local('tokens', ['build']).status, 0)
  assert.equal(local('tokens', ['check']).status, 0)
})
