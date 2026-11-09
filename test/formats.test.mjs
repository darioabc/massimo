// Files written by a newer massimo are refused by name, never guessed at;
// a project that needs newer scripts says so; lowering a baseline never
// drops what this version did not measure; and a plugin run says when the
// project's vendored copy is older. It also holds the 0.4.0 contract checks:
// the new defaults, the stories keys a fresh config writes, which config
// needs 0.4.0, and one test per stub module for the track that fills it.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import * as convert from '../scripts/lib/convert.mjs'
import * as lane from '../scripts/lib/lane.mjs'
import * as laneCss from '../scripts/lib/lane-css.mjs'
import * as laneRoute from '../scripts/lib/lane-route.mjs'
import { DEFAULTS, FORMATS_READ, SCRIPTS_VERSION, loadConfig, needsScripts, olderThan, parseArgs } from '../scripts/lib/project.mjs'
import * as redirects from '../scripts/lib/redirects.mjs'
import * as viteStories from '../scripts/lib/vite-stories.mjs'
import { SCRIPTS, readJson, run, scratch } from './helpers.mjs'

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
const updateHint = /update massimo: the plugin, then its init\.mjs --update-scripts for the project's copy/

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
  writeFileSync(join(ctx.project, 'audits', 'baseline.json'), JSON.stringify({ version: 3, kinds: {} }))
  for (const flag of ['--check', '--lower']) {
    const r = run('audit', ctx, [flag])
    assert.equal(r.status, 1, flag)
    assert.match(r.stderr, /audits\/baseline\.json is format 3, and these scripts \(\S+\) read up to 2/)
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

test('graph and audit --baseline never check against or overwrite a newer file', () => {
  const ctx = fresh()
  mkdirSync(ctx.project, { recursive: true })
  writeFileSync(join(ctx.project, 'graph.json'), JSON.stringify({ version: 2 }))
  const g = run('graph', ctx)
  assert.equal(g.status, 1)
  assert.match(g.stderr, /graph\.json is format 2/)
  assert.equal(readJson(ctx.project, 'graph.json').version, 2)
  mkdirSync(join(ctx.project, 'audits'), { recursive: true })
  writeFileSync(join(ctx.project, 'audits', 'baseline.json'), JSON.stringify({ version: 3, kinds: {} }))
  const a = run('audit', ctx, ['--baseline'])
  assert.equal(a.status, 1)
  assert.equal(readJson(ctx.project, 'audits', 'baseline.json').version, 3)
})

test('a vendored version in either quote style reads; one that cannot be read neither warns nor blocks', () => {
  for (const [line, warns] of [[`export const SCRIPTS_VERSION = "${SCRIPTS_VERSION}"\n`, false], ["export const SCRIPTS_VERSION = '0.1.0'\n", true], ['// no version here\n', false]]) {
    const ctx = fresh()
    mkdirSync(join(ctx.project, 'scripts', 'lib'), { recursive: true })
    writeFileSync(join(ctx.project, 'scripts', 'lib', 'project.mjs'), line)
    const r = run('graph', ctx)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(/vendored scripts are/.test(r.stderr), warns, line)
  }
})

test('the hooks never fail on a config these scripts cannot use: the guard still denies, the session still starts', () => {
  const ctx = fresh()
  config(ctx, { version: 2 })
  const guard = spawnSync(process.execPath, [join(SCRIPTS, 'agent-guard.mjs')], { input: JSON.stringify({ cwd: ctx.root, tool_name: 'Write', agent_type: 'massimo:reviewer', tool_input: { file_path: 'src/x.ts' } }), encoding: 'utf8' })
  assert.equal(guard.status, 0)
  assert.equal(JSON.parse(guard.stdout).hookSpecificOutput.permissionDecision, 'deny')
  mkdirSync(join(ctx.root, 'design-system'), { recursive: true })
  writeFileSync(join(ctx.root, 'design-system', 'state.json'), JSON.stringify({ version: 1, massimo: '0.2.0', createdAt: '2026-11-01', updatedAt: '2026-11-01', phases: [], explorations: [] }))
  const start = spawnSync(process.execPath, [join(SCRIPTS, 'session-start.mjs')], { env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.root }, encoding: 'utf8' })
  assert.equal(start.status, 0, start.stderr)
  assert.match(JSON.parse(start.stdout).systemMessage, /massimo\.config\.json is format 2/)
})

test('a project on 0.2.0 scripts is told to update, and a config asking for this version runs on these', () => {
  const ctx = fresh()
  const v = SCRIPTS_VERSION.replace(/\./g, '\\.')
  // init takes its project folder from the config; the other scripts here from --project-dir.
  for (const dir of [ctx.project, join(ctx.root, readJson(ctx.root, 'massimo.config.json').projectDir ?? 'design-system')]) {
    mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'lib', 'project.mjs'), "export const CONFIG_FILE = 'massimo.config.json'\nexport const SCRIPTS_VERSION = '0.2.0'\n")
  }
  assert.match(run('graph', ctx).stderr, new RegExp(`vendored scripts are 0\\.2\\.0, older than this ${v}`))
  const init = run('init', ctx, ['--no-npm-scripts'])
  assert.equal(init.status, 0, init.stderr)
  assert.ok(JSON.parse(init.stdout).warnings.some((w) => new RegExp(`vendored scripts are 0\\.2\\.0, the plugin has ${v}: re-run init with --update-scripts`).test(w)))
  config(ctx, { minScripts: SCRIPTS_VERSION })
  assert.equal(run('graph', ctx).status, 0)
})

// What 0.3.0 wrote under `stories`; a key added since stays out of a fresh config.
const STORIES_0_3_0 = ['lane', 'include', 'devCommand', 'url', 'storyUrl', 'port', 'manifest', 'pages', 'frames', 'componentless']

test('the 0.4.0 story keys all default to off', () => {
  const { stories } = DEFAULTS
  assert.deepEqual(
    Object.fromEntries(Object.entries(stories).filter(([k]) => !STORIES_0_3_0.includes(k))),
    { ids: 'export', order: null, home: null, viewports: null, sideBySide: [], switchers: [], banners: null, frame: null, storyOnly: [], appCss: null, outDir: null, hostFiles: [], frozen: [], policy: null },
  )
  assert.equal(stories.lane, 'native')
  assert.equal(stories.storyUrl, null)
})

test('the formats this version reads include the lane files, and --legacy takes no value', () => {
  assert.deepEqual(parseArgs(['--legacy', 'sweep']), { _: ['sweep'], flags: { legacy: true } })
  assert.deepEqual(
    Object.fromEntries(['conversion', 'removal', 'redirects', 'registry'].map((k) => [k, FORMATS_READ[k]])),
    { conversion: 1, removal: 1, redirects: 1, registry: 1 },
  )
  assert.equal(FORMATS_READ.config, 1)
  assert.equal(FORMATS_READ.graph, 1)
  assert.equal(FORMATS_READ.baseline, 2)
})

test('a config written by init holds exactly the stories keys 0.3.0 wrote', () => {
  const ctx = fresh()
  rmSync(join(ctx.root, 'massimo.config.json'))
  const r = run('init', ctx, ['--no-npm-scripts'])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(Object.keys(readJson(ctx.root, 'massimo.config.json').stories), STORIES_0_3_0)
})

test('detect suggests only the 0.3.0 stories keys, with or without a lane of its own', () => {
  // `app` has no lane; `legacy` has one, which takes detect's other branch.
  for (const fixture of ['app', 'legacy']) {
    const ctx = scratch(fixture)
    contexts.push(ctx)
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'detect.mjs'), '--root', ctx.root], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const report = JSON.parse(r.stdout)
    assert.equal(Boolean(report.storyTools.lane), fixture === 'legacy', fixture)
    assert.deepEqual(Object.keys(report.suggestedConfig.stories), STORIES_0_3_0, fixture)
  }
})

test('loadConfig accepts any lane value, so the scripts that cannot use it say so themselves', () => {
  const ctx = fresh()
  for (const value of ['native', 'manifest', 'csf', 'future-lane']) {
    config(ctx, { stories: { lane: value } })
    const loaded = loadConfig({ root: ctx.root })
    assert.equal(loaded.refusal, null, value)
    assert.equal(loaded.config.stories.lane, value)
  }
})

test('the lane module returns an empty registry for no story files', () => {
  const registry = lane.laneRegistry({ root: '.', config: DEFAULTS, files: [], read: () => '' })
  assert.deepEqual(registry, { format: 1, ids: 'export', stories: {}, order: [], home: null, slugs: {}, files: {}, problems: [] })
  assert.deepEqual(lane.ladleMeta(registry), { about: { generator: 'massimo', format: 1 }, stories: {} })
  assert.deepEqual(lane.redirectTable(registry, []), {})
})

test('a span hash of nothing is empty', () => {
  assert.equal(lane.spanHash('', { start: 0, end: 0 }), '')
})

test('the route helpers give empty results for empty input', () => {
  assert.deepEqual([laneRoute.stateUrl({}), laneRoute.orderIds([], []), laneRoute.argsFromSearch('')], ['', [], {}])
})

test('the css helpers return nothing until they are filled', () => {
  assert.deepEqual([laneCss.storyOnlyModules(), laneCss.sourceNotLines('', 'a.css'), laneCss.cssLayoutProblems()], [[], [], []])
})

test('the convert helpers return nothing until they are filled', () => {
  const registry = lane.laneRegistry({ root: '.', config: DEFAULTS, files: [], read: () => '' })
  assert.deepEqual([convert.conversionRecords(registry), convert.frozenCandidates(registry, null), convert.frozenProblems('.', DEFAULTS), convert.removalEdits(registry), convert.refreeze('.', DEFAULTS, 'a.tsx')], [[], [], [], [], null])
})

test('the redirect helpers return nothing until they are filled', () => {
  const registry = lane.laneRegistry({ root: '.', config: DEFAULTS, files: [], read: () => '' })
  assert.deepEqual([redirects.idMentions('', registry), redirects.mentionCoverage([], registry, []), redirects.toolEdits()], [[], { missing: [], dead: [] }, []])
})

test('the Vite plugin is a named object until it is filled', () => {
  assert.equal(viteStories.massimoStories().name, 'massimo-stories')
})

test('a config needs 0.4.0 only when it sets a 0.4.0 stories key to a non-default value', () => {
  assert.equal(needsScripts({}), null)
  assert.equal(needsScripts({ stories: { lane: 'manifest', port: 5000 } }), null)
  assert.equal(needsScripts({ stories: { ids: 'export', order: null, frozen: [] } }), null)
  assert.equal(needsScripts({ stories: { lane: 'csf' } }), '0.4.0')
  assert.equal(needsScripts({ stories: { home: 'a--b' } }), '0.4.0')
  assert.equal(needsScripts({ stories: { sideBySide: ['a.story.tsx'] } }), '0.4.0')
  assert.equal(needsScripts({ stories: { policy: { nameMatches: true } } }), '0.4.0')
})

test('the route module imports nothing, since the plugin inlines its text', () => {
  const text = readFileSync(join(SCRIPTS, 'lib', 'lane-route.mjs'), 'utf8')
  assert.ok(!/^\s*(import|export\s.*\sfrom)\b/m.test(text))
  assert.ok(!/\bimport\s*\(/.test(text))
})
