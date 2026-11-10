// Repo-wide conventions: the project folder is never hard-coded, private
// leftovers stay out, sorting never depends on the locale, the manifests point
// at a page that exists, and agents that must not write say so in their tools.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { SCRIPTS_VERSION } from '../scripts/lib/project.mjs'
import { CLASS_LIBRARIES, classLibraries } from '../scripts/lib/source.mjs'
import { isOpen, hookContext, progressMarkdown } from '../scripts/lib/state.mjs'

const repo = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..')

function files(dir, ext) {
  const out = []
  for (const name of readdirSync(join(repo, dir))) {
    const rel = join(dir, name)
    if (statSync(join(repo, rel)).isDirectory()) out.push(...files(rel, ext))
    else if (ext.test(name)) out.push(rel)
  }
  return out
}
const text = (rel) => readFileSync(join(repo, rel), 'utf8')
const docs = [...files('skills', /\.md$/), ...files('agents', /\.md$/), ...files('reference', /\.md$/), ...files('templates', /./)]
const scripts = files('scripts', /\.mjs$/)

test('the project folder is never hard-coded in skills, agents, references or scripts', () => {
  for (const f of [...docs, ...scripts]) assert.ok(!text(f).includes('design-system/'), f)
})

test('no em dashes in the docs, the skills or anything a script writes', () => {
  for (const f of [...docs, ...scripts, 'README.md', 'CHANGELOG.md']) assert.ok(!text(f).includes('\u2014'), f)
})

test('no private leftovers', () => {
  for (const f of [...docs, ...scripts, ...files('test/fixtures', /./)]) {
    assert.ok(!/fiuto|FIU-/i.test(text(f)), f)
  }
})

// massimo learnt adoption on a real repo; its names and its own vocabulary
// stay there, so fixtures and tests use generic ones.
test('no names or vocabulary from the repos massimo was proven on', () => {
  const banned = /folio|dariocodipietro|@parked:|ds:island|ds:sheet|tone-ink|--paper-\d/i
  for (const f of [...docs, ...scripts, ...files('test', /\.mjs$/), ...files('test/fixtures', /./), 'CHANGELOG.md']) {
    if (f.endsWith('conventions.test.mjs')) continue
    assert.ok(!banned.test(text(f)), f)
  }
  // The README names its author under Made by, and nowhere else.
  assert.ok(!banned.test(text('README.md').replace(/^## Made by\n[\s\S]*?(?=^## )/m, '')), 'README.md')
})

test('sorting never depends on the locale', () => {
  for (const f of scripts) assert.ok(!text(f).includes('localeCompare'), f)
})

test('the manifests point at the README on GitHub', () => {
  const plugin = JSON.parse(text('.claude-plugin/plugin.json'))
  const market = JSON.parse(text('.claude-plugin/marketplace.json'))
  assert.equal(plugin.homepage, 'https://github.com/darioabc/massimo#readme')
  assert.equal(market.plugins[0].homepage, 'https://github.com/darioabc/massimo#readme')
})

const frontmatter = (rel) => Object.fromEntries(
  /^---\n([\s\S]*?)\n---/.exec(text(rel))[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]),
)

test('reviewers cannot write, and the ideator can write but not edit or run commands', () => {
  for (const name of ['reviewer', 'visual-reviewer']) {
    const tools = frontmatter(`agents/${name}.md`).tools.split(/,\s*/)
    assert.deepEqual(tools, ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], name)
  }
  const ideator = frontmatter('agents/ideator.md').tools.split(/,\s*/)
  assert.ok(ideator.includes('Write'))
  for (const tool of ['Edit', 'Bash', 'NotebookEdit']) assert.ok(!ideator.includes(tool), tool)
})

test('class libraries: DaisyUI when the styling names it, and the config adds others', () => {
  assert.deepEqual(classLibraries({ styling: ['css'] }), [])
  const libs = classLibraries({ styling: ['tailwind4', 'daisyui'], graph: { classLibraries: { acme: { roots: ['ui-btn'], colors: ['brand'] } } } })
  assert.deepEqual(libs.map((l) => l.id), ['acme', 'daisyui'])
  assert.deepEqual(libs[0].roots, ['ui-btn'])
  assert.equal(libs[1].roots.length, CLASS_LIBRARIES.daisyui.roots.length)
  assert.ok(libs[1].notRoots.every((re) => re instanceof RegExp))
})

test('STATUS.md and the session hook agree on which explorations are open', () => {
  const state = {
    updatedAt: '2026-11-07T10:00:00.000Z',
    phases: [{ id: 'setup', status: 'done', note: '' }],
    explorations: ['framing', 'reviewing', 'fidelity', 'handed-off', 'built', 'parked'].map((status, i) => ({ topic: `t${i}`, status, round: 1 })),
  }
  assert.deepEqual(state.explorations.filter(isOpen).map((e) => e.status), ['framing', 'reviewing', 'fidelity'])
  assert.match(progressMarkdown(state), /continue with `\/massimo:ux t0`/)
  const hook = hookContext(state, 'design-system')
  assert.match(hook, /Open explorations: t0 \(round 1, framing\); t1 \(round 1, reviewing\); t2 \(round 1, fidelity\)\./)
})

test('one version everywhere: the CHANGELOG, the scripts and both manifests', () => {
  const changelog = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8').match(/^## (\d+\.\d+\.\d+)/m)[1]
  const plugin = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'plugin.json'), 'utf8')).version
  const market = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8')).plugins.map((p) => p.version)
  assert.deepEqual([changelog, plugin, ...market], [SCRIPTS_VERSION, SCRIPTS_VERSION, ...market.map(() => SCRIPTS_VERSION)])
})
