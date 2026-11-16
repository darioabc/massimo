// The platform model in the config: a config with no platforms is web only
// and loads as it always did; a platform block merges over its adapter's
// defaults, never the web keys, and its lists keep every default (the union
// rule); the keys 0.6.0 added each need 0.6.0, a config that uses one with
// too low a minScripts gets a warning from state and check; and check skips
// the web graph in a project with no web platform.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DEFAULTS, SCRIPTS_NEEDS, deepMerge, loadConfig, minScriptsWarning, needsScripts, platformBlock, withMinScripts } from '../scripts/lib/project.mjs'
import { adapterFor, hasWeb, platformsOf } from '../scripts/lib/platforms.mjs'
import { SCRIPTS } from './helpers.mjs'

const made = []
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })))
function project(config) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-platforms-'))
  made.push(root)
  writeFileSync(join(root, 'massimo.config.json'), JSON.stringify(config))
  mkdirSync(join(root, 'design-system'), { recursive: true })
  writeFileSync(join(root, 'design-system', 'state.json'), JSON.stringify({ massimo: '0.6.0', updatedAt: '2026-11-15T00:00:00.000Z', phases: [], explorations: [] }))
  return root
}

test('a config with no platforms loads exactly as before: no platforms key, every web default in place', () => {
  const root = project({ framework: 'vite-react' })
  const { config } = loadConfig({ root })
  assert.ok(!('platforms' in config))
  const expected = deepMerge(structuredClone(DEFAULTS), { framework: 'vite-react' })
  assert.deepEqual({ ...config, tokens: { ...config.tokens, source: null } }, expected)
  assert.deepEqual(platformsOf(config), [{ id: 'web' }])
  assert.ok(hasWeb(config))
})

test('an ios block keeps node_modules and .git ignored and an android block keeps build: lists are a union, never replaced', () => {
  const root = project({ components: { include: ['src/components/**/*.tsx'] }, platforms: { ios: { root: 'ios', ignore: ['Vendor'], components: { exclude: ['**/Mocks/**'] } }, android: { root: 'android', ignore: ['generated'] } } })
  const { config } = loadConfig({ root })
  const ios = config.platforms.ios
  for (const name of ['node_modules', '.git', 'Pods', 'DerivedData', 'Vendor']) assert.ok(ios.ignore.includes(name), name)
  for (const glob of ['**/*.test.*', '**/Tests/**', '**/Mocks/**']) assert.ok(ios.components.exclude.includes(glob), glob)
  assert.ok(ios.audit.exclude.includes('**/*.d.ts'))
  const android = config.platforms.android
  for (const name of ['build', 'node_modules', '.gradle', 'generated']) assert.ok(android.ignore.includes(name), name)
  // The web keys never reach a platform block.
  assert.deepEqual(ios.components.include, [])
  assert.deepEqual(config.components.include, ['src/components/**/*.tsx'])
  assert.equal(ios.root, 'ios')
  assert.deepEqual(ios.ui, ['swiftui'])
  assert.deepEqual(android.ui, ['compose'])
})

test('platformsOf lists web first, then iOS and Android; web runs only when listed once platforms are declared', () => {
  const both = { platforms: { android: platformBlock('android', {}), web: {}, ios: platformBlock('ios', {}) } }
  assert.deepEqual(platformsOf(both).map((p) => p.id), ['web', 'ios', 'android'])
  assert.ok(hasWeb(both))
  assert.ok(!hasWeb({ platforms: { ios: {} } }))
  assert.equal(adapterFor('ios').tokens.formats.join(), 'swift,xcassets')
  assert.equal(adapterFor('android').tokens.formats.join(), 'compose,android-xml')
  assert.equal(adapterFor('flutter'), null)
})

test('each key 0.6.0 added needs 0.6.0; the 0.4.0 stories keys still need 0.4.0', () => {
  const cases = {
    platforms: { platforms: { ios: {} } },
    'a mobile token output (swift, xcassets, compose or android-xml)': { tokens: { outputs: [{ format: 'compose', path: 'x.kt' }] } },
    'tokens.outputs[].platform': { tokens: { outputs: [{ format: 'css', path: 'x.css', platform: 'web' }] } },
    'tokens.mobile': { tokens: { mobile: { namespace: 'Tokens' } } },
    'tokens.mobileSources': { tokens: { mobileSources: [] } },
  }
  for (const row of SCRIPTS_NEEDS.filter((r) => r.version === '0.6.0')) {
    assert.ok(row.what in cases, row.what)
    assert.equal(needsScripts(cases[row.what]), '0.6.0', row.what)
  }
  assert.equal(needsScripts({ tokens: { outputs: [{ format: 'css', path: 'x.css' }] } }), null)
  assert.equal(needsScripts({ stories: { lane: 'csf' }, platforms: {} }), '0.6.0')
  assert.equal(needsScripts({ stories: { lane: 'csf' } }), '0.4.0')
})

test('withMinScripts sets minScripts after version, never lowers one, and leaves a web config as it was', () => {
  assert.deepEqual(Object.keys(withMinScripts({ version: 1, projectDir: 'x', platforms: {} })), ['version', 'minScripts', 'projectDir', 'platforms'])
  assert.equal(withMinScripts({ minScripts: '0.9.0', platforms: {} }).minScripts, '0.9.0')
  const web = { version: 1, framework: 'astro' }
  assert.equal(withMinScripts(web), web)
})

test('state and check warn when a hand-edited config needs a newer minScripts than it says', () => {
  assert.equal(minScriptsWarning({ minScripts: '0.6.0', platforms: {} }), null)
  assert.match(minScriptsWarning({ minScripts: '0.5.0', platforms: {} }), /uses platforms, which needs massimo scripts 0\.6\.0, and its minScripts is 0\.5\.0/)
  const root = project({ projectDir: 'design-system', platforms: { ios: {} } })
  const state = spawnSync(process.execPath, [join(SCRIPTS, 'state.mjs'), 'show', '--root', root], { encoding: 'utf8' })
  assert.equal(state.status, 0, state.stderr)
  assert.match(state.stderr, /massimo: warn: massimo\.config\.json uses platforms, which needs massimo scripts 0\.6\.0, and its minScripts is not set/)
  const check = spawnSync(process.execPath, [join(SCRIPTS, 'check.mjs'), '--root', root], { encoding: 'utf8' })
  assert.match(check.stderr, /set "minScripts": "0\.6\.0"/)
})

test('check skips the web graph in a project with no web platform, and runs it when web is listed', () => {
  const mobile = project({ minScripts: '0.6.0', platforms: { ios: {} } })
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'check.mjs'), '--root', mobile], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /skip {2}graph {3}the graph reads web code, and this project declares no web platform/)
  const both = project({ minScripts: '0.6.0', platforms: { web: {}, ios: {} } })
  const r2 = spawnSync(process.execPath, [join(SCRIPTS, 'check.mjs'), '--root', both], { encoding: 'utf8' })
  assert.match(r2.stdout, /(pass|fail) {2}graph {3}node design-system\/scripts\/graph\.mjs --check/)
})
