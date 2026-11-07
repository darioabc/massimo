#!/usr/bin/env node
// Adopt a repo's own design-system setup instead of generating one: find
// what is there and who depends on it, decide what becomes of each part in
// a ledger, propose the config, and move each asset class through its
// states (found, mapped, shadowed, proven, cut-over, retired).
//
//   adopt.mjs scan [--json]       before init, print the inventory (Markdown, or
//                                 JSON with --json); after init, write it to
//                                 <project>/adopt/inventory.json and inventory.md
//   adopt.mjs plan                the ledger (adopt/ledger.json) and the proposed
//                                 config (adopt/config.proposed.json), from the inventory
//   adopt.mjs config [--write]    the proposed config as a diff against
//                                 massimo.config.json; --write merges it in, adding
//                                 keys and never overwriting a value you set (a config
//                                 with comments is left for you to edit by hand)
//   adopt.mjs status [--json]     the ledger as a table
//   adopt.mjs mark <class> <state> [--batch <id>] [--force]
//                                 move a class one state on; never past a blocker;
//                                 cut-over needs --batch; --force goes back or
//                                 skips states, to repair the ledger
//   adopt.mjs verify [<class>] [--against <file>] [--json]
//                                 compare massimo's graph, stories, audit or tokens
//                                 (all four without a class) with the repo's own, as a
//                                 table; exit 1 on a difference the ledger has not
//                                 accepted, or accepted with another detail. A class
//                                 that cannot run is one difference, error, and the
//                                 others still run. Records nothing: mark moves the class.
//     stories also: --pairs <file> --a <base url> --b <base url> [--dom-tier Pages]
//                                 write a shoot.mjs pairs file from the manifest;
//                                 --shoot [--out <dir>] [--playwright <path>] runs it
//                                 (--pairs and --out from --root when relative)
//   adopt.mjs accept <class> <key> --why <text>
//                                 accept a difference verify reports now, with the
//                                 reason and its detail; a key verify does not report
//                                 is refused. It takes the flags verify takes, for a
//                                 difference only they produce (--against, and
//                                 --pairs, --a, --b and --shoot for a shot)
//   adopt.mjs historical [<path>] mark a doc historical (retire leaves it), or list
//                                 them; a file code depends on is refused
//   adopt.mjs retire <class> --dry-run [--json]
//                                 what retiring a class takes out and who still depends
//                                 on it; exit 1 while a consumer remains outside the
//                                 historical docs, or a generator that stays still
//                                 writes what goes. It never deletes: the skill does,
//                                 on your OK
//
// Read-only towards the repo: only massimo.config.json (config --write), the
// files under <project>/adopt/, a pairs file (verify --pairs) and shots
// (verify --shoot) are written. Shared flags: --root, --config, --project-dir.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_KINDS, compareLegacy, notMeasured, offendersOf, parseMap, runAudit } from './audit.mjs'
import { buildGraph } from './graph.mjs'
import {
  CLASSES,
  STATES,
  acceptDifference,
  changeLines,
  inventoryPath,
  ledgerPath,
  ledgerPhase,
  loadLedger,
  markClass,
  markHistorical,
  mergeAdding,
  planLedger,
  proposeConfig,
  proposedPath,
  retirePlan,
  statusTable,
} from './lib/adopt.mjs'
import { buildInventory, inventoryMarkdown, laneRecord, readText, repoFiles, workflowJob } from './lib/inventory.mjs'
import { DEFAULTS, deepMerge, fail, loadConfig, newerMessage, parseArgs, readJson, refuseNewer, rel, scriptCommand, stripJsonComments, writeFileAtomic } from './lib/project.mjs'
import { parsePairs } from './lib/shoot.mjs'
import { loadState, setPhase, statePath, updateState } from './lib/state.mjs'
import { readManifest } from './lib/stories-read.mjs'
import { truthy } from './lib/text.mjs'
import { VERIFY_CLASSES, compareGraph, compareTokens, readRepoGraph, readTokenInventory, settle, shotDifference, storyPairs, storyRoutes, textTable } from './lib/verify.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// --write, --force and --shoot take no value, so a positional after them stays one.
const { _: args, flags } = parseArgs(process.argv.slice(2).map((a) => (['--write', '--force', '--shoot'].includes(a) ? `${a}=true` : a)))
const [command = 'scan', ...rest] = args
const { root, exists, config, configPath, projectDir } = loadConfig(flags)
const projectRel = rel(root, projectDir) || '.'
const shown = (name) => `${projectRel}/adopt/${name}`
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// detect.mjs's report: the framework, the story tools and lane, style files.
function detect() {
  try {
    const out = execFileSync(process.execPath, [join(here, 'detect.mjs'), '--root', root], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    return JSON.parse(out.toString())
  } catch (e) {
    throw new Error(`detect.mjs failed: ${e.message.split('\n')[0]}`)
  }
}

// The repo's files as scan reads them.
function scanFiles(effective, pkg) {
  return repoFiles(root, { ignore: effective.ignore, projectRel: exists ? projectRel : effective.projectDir, workspaces: Boolean(pkg.workspaces) })
}

// The inventory of the repo as it is now. Before init, the config detect
// suggests stands in for the one init would write.
function scan() {
  try {
    const detected = detect()
    const pkg = readJson(join(root, 'package.json'), {}) ?? {}
    const effective = exists ? config : deepMerge(structuredClone(DEFAULTS), detected.suggestedConfig ?? {})
    return buildInventory(root, { detected, config: effective, pkg, files: scanFiles(effective, pkg), auditKinds: ALL_KINDS })
  } catch (e) {
    fail(e.message)
  }
}

function needInit(what) {
  if (!exists) fail(`${what} needs a project: run init.mjs first (adopt.mjs scan works before it)`)
}

// The saved inventory, refused when a newer massimo wrote it.
function readInventory() {
  const path = inventoryPath(projectDir)
  if (!existsSync(path)) fail(`no ${shown('inventory.json')} yet: run ${scriptCommand(root, projectDir, 'adopt', 'scan')} first`)
  const inv = JSON.parse(readFileSync(path, 'utf8'))
  refuseNewer('inventory', inv.format, 'adopt/inventory.json')
  return inv
}

function readLedger() {
  try {
    return loadLedger(projectDir)
  } catch (e) {
    fail(e.message)
  }
}

// The adopt phase in state.json follows the ledger, with two exceptions: a
// ledger with nothing in it leaves a skipped phase as it is, and a phase the
// user skipped (with a note, or by hand) stays skipped through plan, until
// they mark a class.
const NOTHING = ledgerPhase({ classes: {} }).note
function syncPhase(ledger, { marked = false } = {}) {
  if (!existsSync(statePath(projectDir))) return
  const { status, note } = ledgerPhase(ledger)
  const now = loadState(projectDir)?.phases.find((p) => p.id === 'adopt')
  const userSkipped = now?.status === 'skipped' && now.note !== NOTHING && Boolean(now.note || now.updatedAt)
  if (now?.status === 'skipped' && (status === 'skipped' || (userSkipped && !marked))) return
  if (now?.status === status && now.note === note) return
  updateState(projectDir, (s) => setPhase(s, 'adopt', status, note))
}

const writeJson = (path, value) => writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)

// Before a file massimo wrote is replaced: refused when a newer massimo
// wrote it, by its `field` (format or version).
function refuseNewerFile(path, kind, field, where) {
  if (!existsSync(path)) return
  let doc = null
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return
  }
  refuseNewer(kind, doc?.[field], where)
}

// ── verify ──────────────────────────────────────────────────────────────────

// A path as the repo sees it, links followed on both sides, so a temp folder
// reached through a link still counts as inside; null when it is outside.
const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
const inRepo = (abs) => [rel(root, abs), rel(real(root), real(abs))].find((r) => !r.startsWith('..')) ?? null
const shownPath = (abs) => inRepo(abs) ?? abs
// A path given on the command line, from the repo root or absolute.
const repoFile = (path) => inRepo(resolve(root, path))

// Inside a verify class, a problem is that class's difference, never an
// exit: these throw where the commands would fail.
const newer = (kind, version, where) => {
  const message = newerMessage(kind, version, where)
  if (message) throw new Error(message)
}

// A vendored script run on the same repo, config and project as this run.
function runScript(name, argv) {
  const shared = ['--root', root, ...(flags.config ? ['--config', configPath] : []), ...(flags['project-dir'] ? ['--project-dir', projectDir] : [])]
  const r = spawnSync(process.execPath, [join(here, `${name}.mjs`), ...argv, ...shared], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status, stdout: r.stdout ?? '', text: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim() }
}
const lastLine = (text) => text.trim().split('\n').pop() ?? ''

// The repo's own file a class is compared with: --against, else the first
// asset of the ledger's class of one of `kinds`.
function againstFile(c, kinds) {
  if (typeof flags.against === 'string') {
    const file = repoFile(flags.against)
    if (!file) throw new Error(`--against ${flags.against} is not in the repo`)
    return file
  }
  for (const kind of kinds) {
    const a = c?.assets.find((x) => x.kind === kind && !x.missing)
    if (a) return a.paths[0]
  }
  return null
}

// massimo's graph, built once in memory for graph and stories.
let built = null
function graphJson() {
  if (!built) {
    try {
      built = buildGraph(root, config, scriptCommand(root, projectDir, 'graph')).json
    } catch (e) {
      throw new Error(`graph.mjs cannot build the graph: ${e.message}`)
    }
  }
  return built
}

// graph.json as graph.mjs last wrote it, and whether it is behind the code
// (not the graph built now); null when there is none.
function graphWritten() {
  const path = join(projectDir, 'graph.json')
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  let doc = null
  try {
    doc = JSON.parse(text)
  } catch {
    return { doc: null, behind: true }
  }
  newer('graph', doc?.version, 'graph.json')
  return { doc, behind: text !== `${JSON.stringify(graphJson(), null, 2)}\n` }
}
const graphBehind = (what) => `graph.json is behind the code, so ${what}: run ${scriptCommand(root, projectDir, 'graph')}`

function verifyGraph(ledger) {
  const file = againstFile(ledger.classes.graph, ['graph', 'index'])
  if (!file) return { skip: "the ledger names no graph or index of the repo's own: pass --against <file>" }
  const path = join(root, file)
  if (!existsSync(path)) return { title: `against ${file}`, differences: [{ key: 'against', detail: `${file} is not there, so there is nothing to compare with` }] }
  const repo = readRepoGraph(readFileSync(path, 'utf8'))
  return { title: `massimo's graph, built in memory, against ${file} (read as ${repo.kind === 'index' ? 'an index' : 'a graph'})`, ...compareGraph(repo, graphJson(), { route: storyRoutes(config).story }) }
}

// The lane as the scan's reader reads it now, from the lane detect finds,
// or null when detect finds none.
function liveLane() {
  const lane = detect()?.storyTools?.lane
  if (!lane?.dir) return null
  const pkg = readJson(join(root, 'package.json'), {}) ?? {}
  return laneRecord(root, scanFiles(config, pkg), pkg, lane)
}

// The lane: its entries and states as the scan's reader reads them now
// against graph.json (the graph built in memory when there is none yet),
// the problems massimo's checks find and the checks it could not make; with
// --pairs, a shoot pairs file from the manifest, and with --shoot, its verdict.
function verifyStories() {
  if (config.stories.lane !== 'manifest' || !config.stories.manifest) return { skip: 'stories.lane is not "manifest" with a stories.manifest, so there is no list of stories to verify' }
  const lane = graphJson().storyLane
  if (!lane) return { skip: 'the graph did not read a story lane' }
  const differences = []
  const notes = []
  const counted = (rule) => lane.problems.filter((p) => p.rule === rule).length
  const written = graphWritten()
  const theirs = written ? (written.doc?.storyLane ?? {}) : lane
  const live = liveLane()
  const scanned = live?.manifest?.path === config.stories.manifest ? live : null
  if (!live) notes.push('Scan finds no gated story lane here, so its reading is not compared.')
  else if (!scanned) differences.push({ key: 'lane', detail: `scan finds the lane's manifest at ${live.manifest?.path ?? 'none'}, and the config names ${config.stories.manifest}: point stories.manifest at the lane scan finds` })
  if (!written) notes.push('There is no graph.json yet, so the scan is compared with the graph built in memory.')
  const rows = [['What', 'Scan', 'massimo', 'Differ', 'Note']]
  const counts = { entries: [scanned?.manifest.entries, theirs.entries, lane.entries], states: [scanned?.states, theirs.states, lane.states] }
  let behind = false
  for (const [what, field] of [['manifest entries', 'entries'], ['states', 'states']]) {
    const [now, held, built] = counts[field]
    const differs = now !== undefined && now !== held
    // graph.json lags the code when the graph built now reads what scan reads.
    const lags = differs && Boolean(written) && built === now
    behind ||= lags
    rows.push([what, now === undefined ? '-' : String(now), held === undefined ? '-' : String(held), differs ? '1' : '0', lags ? 'graph.json is behind the code' : ''])
    if (differs && !lags) {
      differences.push({ key: field, detail: field === 'entries' ? `the scan's reader reads ${now} entries in ${config.stories.manifest}, and massimo's graph ${built}` : `the scan's reader counts ${now} states on the lane's pages, and massimo's graph ${built} on the pages of the manifest's entries` })
    }
  }
  if (behind) {
    const [[now, held], [statesNow, statesHeld]] = [counts.entries, counts.states]
    differences.push({ key: 'check:graph', detail: graphBehind(`it holds ${plural(held ?? 0, 'entry', 'entries')} and ${plural(statesHeld ?? 0, 'state')} where the lane has ${now} and ${statesNow}`) })
  }
  for (const rule of ['story-title', 'story-files', 'story-states']) rows.push([`problems: ${rule}`, '', String(counted(rule)), String(counted(rule)), ''])
  rows.push(['problems: no-story', '', String(counted('no-story')), '', "verify audit compares it with the repo's ratchet"])
  rows.push(['not statically readable', '', String(lane.unreadable?.length ?? 0), '', lane.unreadable?.length ? 'agreed as carried in the plan: massimo does not check those parts' : ''])
  const notChecked = Object.entries(lane.notChecked ?? {})
  rows.push(['checks not made', '', String(notChecked.length), String(notChecked.length), ''])
  for (const p of lane.problems) if (p.rule !== 'no-story') differences.push({ key: `${p.rule}:${p.file}: ${p.detail}`, detail: `a ${p.rule} problem in the lane` })
  for (const [rule, why] of notChecked) differences.push({ key: `not-checked:${rule}`, detail: why })
  if (flags.pairs !== undefined) rows.push(...storyShots(differences, notes))
  return { title: `the story lane at ${config.stories.manifest}: the scan's reading against ${written ? 'graph.json' : 'the graph built in memory'}, and the problems massimo's graph finds`, rows, differences, notes }
}

// A file in another massimo format than these scripts read, refused before
// it is replaced.
function refuseNewerOutput(path, kind, where) {
  if (!existsSync(path)) return
  let doc = null
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return
  }
  newer(kind, doc?.format, where)
}

// Write the pairs file for the lane and, with --shoot, run shoot.mjs on it
// and fold each pair's verdict into the differences. Returns the table rows.
// --pairs and --out are read from the repo root, as --against is.
function storyShots(differences, notes) {
  const domTier = typeof flags['dom-tier'] === 'string' ? flags['dom-tier'] : 'Pages'
  const manifest = readManifest(readText(root, config.stories.manifest), config.stories.manifest)
  const { document, entries, skipped } = storyPairs(manifest.entries, { a: flags.a, b: flags.b, routes: storyRoutes(config), domTier })
  const { problems } = parsePairs(document.pairs)
  if (problems.length > 0) throw new Error(`the pairs cannot be written: ${problems.join('; ')}`)
  const path = resolve(root, flags.pairs)
  refuseNewerOutput(path, 'pairs', shownPath(path))
  writeJson(path, document)
  const pairs = document.pairs
  const dom = pairs.filter((p) => p.mode === 'dom').length
  notes.push(`Wrote ${plural(pairs.length, 'pair')} to ${shownPath(path)}: ${plural(entries, 'entry', 'entries')} at light and dark, 390 and 1440 wide, each on its frame route where it has one; ${dom} compared by page text (root ${domTier})${skipped ? `; ${plural(skipped, 'entry')} with no literal slug left out` : ''}.`)
  const out = typeof flags.out === 'string' ? resolve(root, flags.out) : join(projectDir, 'shots', 'adopt', 'stories')
  // Passed through to shoot.mjs, which runs from the repo root: a Playwright
  // path given from here is made absolute first.
  const pass = ['max-diff', 'threshold', 'playwright'].flatMap((f) => (typeof flags[f] === 'string' ? [`--${f}`, f === 'playwright' ? resolve(flags[f]) : flags[f]] : []))
  const argv = ['--pairs', path, '--out', out, ...pass]
  if (!truthy(flags.shoot)) {
    notes.push(`Shoot them, with both servers up: ${scriptCommand(root, projectDir, 'shoot', [`--pairs ${shownPath(path)}`, `--out ${shownPath(out)}`, ...pass].join(' '))}, or run verify stories again with --shoot.`)
    return [['pairs', '', String(pairs.length), '', 'written, not shot']]
  }
  const r = runScript('shoot', argv)
  if (r.status === 2 || r.status === 3 || r.status === null) {
    differences.push({ key: 'shoot', detail: r.status === 3 ? 'shoot.mjs found no Playwright: pass --playwright <path> to a checkout that has it' : `shoot.mjs could not run the pairs: ${lastLine(r.text)}` })
    return [['pairs shot', '', '0', '1', 'shoot.mjs did not run']]
  }
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  const results = lines.filter((l) => l && !l.summary && typeof l.name === 'string')
  for (const p of results.filter((x) => !x.ok)) differences.push(shotDifference(p))
  const failed = results.filter((x) => !x.ok).length
  notes.push(`Shots and diffs are in ${shownPath(out)}.`)
  return [['pairs shot', '', String(results.length), String(failed), `${results.length - failed} within --max-diff`]]
}

// The audit against the repo's ratchet, rule by rule and file by file, by
// the map the ledger keeps (adopt.mjs plan proposes it from the rule names).
function verifyAudit(ledger) {
  const v = ledger.classes.audit?.verify
  if (!v) return { skip: "the ledger names no ratchet of the repo's own to compare the audit with" }
  const title = `the audit against ${v.ratchet}, by the map in ${shown('ledger.json')}`
  const legacy = readJson(join(root, v.ratchet), null)
  if (!legacy || typeof legacy.rules !== 'object' || legacy.rules === null) return { title, differences: [{ key: 'ratchet', detail: `${v.ratchet} is not there, or not a ratchet of the shape { rules: { <rule>: { count, offenders } } }` }] }
  // A map with no rule in it: plan found no rule whose name is a kind.
  const rules = Object.keys(legacy.rules)
  const fix = `name the massimo kind each rule counts in audit.verify.map in ${shown('ledger.json')}, as <rule>=<kind> pairs (the kinds: ${ALL_KINDS.join(', ')}), or keep the ratchet as the repo's own check`
  if (!v.map.split(',').some((p) => p.trim())) return { title, differences: [{ key: 'map', detail: `no rule of ${v.ratchet} (${rules.join(', ') || 'none'}) maps to a massimo kind, so there is nothing to compare: ${fix}` }] }
  let pairs
  try {
    pairs = parseMap(v.map)
  } catch (e) {
    return { title, differences: [{ key: 'map', detail: `audit.verify.map does not read: ${e.message.replace(/^--map /, 'it ')}; ${fix}` }] }
  }
  const result = runAudit(root, config, { projectDir })
  const compared = compareLegacy(legacy, pairs, offendersOf(result.findings), notMeasured(result))
  const differences = []
  // The story kinds count the problems graph.json holds: one behind the code
  // counts an old lane.
  if (result.kinds.includes('no-story') && graphWritten()?.behind) differences.push({ key: 'check:graph', detail: graphBehind('the story kinds count an old lane') })
  const rows = [['Rule', 'Kinds', 'Repo', 'massimo', 'Result']]
  for (const r of compared) {
    rows.push([r.rule, r.kinds.join(' + '), String(r.legacy), String(r.massimo), r.problem ?? (r.differs.length === 0 ? 'match' : `${plural(r.differs.length, 'file differs', 'files differ')}`)])
    if (r.problem) differences.push({ key: `rule:${r.rule}`, detail: r.problem })
    for (const d of r.differs) differences.push({ key: `offenders:${r.rule} ${d.file}`, detail: `the repo counts ${d.legacy}, massimo ${d.massimo}` })
  }
  const notes = result.warnings.map((w) => `Warning: ${w}.`)
  const mapped = new Set(pairs.map((p) => p.rule))
  const kept = Object.keys(legacy.rules).filter((r) => !mapped.has(r))
  if (kept.length > 0) notes.push(`Kept by the repo, with no massimo kind: ${kept.join(', ')}. Its own script checks ${kept.length === 1 ? 'it' : 'them'} through guard.extraChecks, or the plan accepts losing ${kept.length === 1 ? 'it' : 'them'}.`)
  const measured = result.kinds.filter((k) => !notMeasured(result).has(k) && !pairs.some((p) => p.kinds.includes(k)))
  if (measured.length > 0) notes.push(`massimo also measures ${measured.join(', ')}, which no rule maps to.`)
  return { title, rows, differences, notes }
}

// The token checks (the mirror when tokens.mirror is on, resolved.json
// always), then resolved.json against the repo's own token inventory.
function verifyTokens(ledger) {
  const differences = []
  const before = []
  // One line per check, as check.mjs prints them.
  const check = (name, why) => {
    const label = name.padEnd(8)
    if (why) return before.push(`skip  ${label}  ${why}`)
    const r = runScript('tokens', [name, '--check'])
    before.push(`${r.status === 0 ? 'pass' : 'fail'}  ${label}  ${lastLine(r.stdout || r.text)}`)
    if (r.status !== 0) differences.push({ key: `check:${name}`, detail: lastLine(r.stdout || r.text) })
  }
  check('mirror', config.tokens.mirror ? null : 'tokens.mirror is off')
  check('resolved')
  const file = againstFile(ledger.classes.tokens, ['token-json'])
  const resolvedPath = join(projectDir, 'tokens', 'resolved.json')
  const title = `the token checks, then ${shownPath(resolvedPath)} against ${file ?? "the repo's own inventory"}`
  if (!file) return { title, before, differences, notes: ["The ledger names no token inventory of the repo's own, so resolved.json is not compared: pass --against <file>."] }
  if (!existsSync(resolvedPath)) return { title, before, differences, notes: [`There is no resolved.json to compare: run ${scriptCommand(root, projectDir, 'tokens', 'resolved')}.`] }
  const ours = readJson(resolvedPath, null)
  newer('resolved', ours?.format, shownPath(resolvedPath))
  let doc = null
  try {
    doc = JSON.parse(readFileSync(join(root, file), 'utf8'))
  } catch (e) {
    differences.push({ key: 'against', detail: `${file} is not there or not JSON: ${e.message.split('\n')[0]}` })
    return { title, before, differences, notes: [] }
  }
  const compared = compareTokens(readTokenInventory(doc), ours ?? {})
  return { title, before, rows: compared.rows, differences: [...differences, ...compared.differences], notes: compared.notes }
}

const VERIFY = { graph: verifyGraph, stories: verifyStories, audit: verifyAudit, tokens: verifyTokens }

// One class verified inside its own guard: whatever stops it is that
// class's one difference, error, and the other classes still run.
function runVerify(name, ledger) {
  if (!ledger.classes[name]) return { skip: `the ledger has no ${name} class: scan found nothing of it to adopt` }
  try {
    return VERIFY[name](ledger)
  } catch (e) {
    return { title: 'it could not run', differences: [{ key: 'error', detail: `${e instanceof Error ? e.message : String(e)}. An error is fixed, never accepted` }] }
  }
}

// One class's report: its table, its notes and each difference, open or
// accepted with its reason, then what to do next. Returns the open count.
function verifyReport(cls, result, c) {
  const head = `massimo adopt verify ${cls}`
  if (result.skip) return { lines: [`${head}: skipped: ${result.skip}.`], open: 0 }
  const { open, accepted, stale } = settle(result.differences, c?.accepted)
  const lines = [`${head}: ${result.title}`, '']
  if (result.before?.length) lines.push(...result.before, '')
  if (result.rows) lines.push(textTable(result.rows), '')
  if (result.notes?.length) lines.push(...result.notes, '')
  const total = result.differences.length
  lines.push(`Differences: ${total}${total ? ` (${open.length} open, ${accepted.length} accepted)` : ''}.`)
  // The printed text may say more than the detail an accept keeps.
  const said = (d) => d.shown ?? d.detail
  for (const d of open) lines.push(`  open      ${d.key}  ${said(d)}`)
  for (const d of accepted) lines.push(`  accepted  ${d.key}  ${said(d)}. Why: ${d.why}`)
  if (stale.length) lines.push(`Accepted in the ledger but no longer found: ${stale.join('; ')}. Remove ${stale.length === 1 ? 'it' : 'them'} from ${shown('ledger.json')}.`)
  const changed = open.filter((d) => d.changed).length
  lines.push('', open.length > 0 ? `${cls}: ${plural(open.length, 'open difference')}${changed ? `, ${changed} of them changed since accepted` : ''}. Fix each, or accept one with its reason: ${scriptCommand(root, projectDir, 'adopt', `accept ${cls} '<key>' --why '<reason>'`)}` : passLine(cls, c))
  return { lines, open: open.length, result: { ...result, open, accepted, stale } }
}

// What a pass means for the ledger: the next mark towards proven.
function passLine(cls, c) {
  const at = STATES.indexOf(c.state)
  const proven = STATES.indexOf('proven')
  if (at >= proven) return `${cls} passes; it is already ${c.state}.`
  if (at === proven - 1) return `${cls} passes. Record it: ${scriptCommand(root, projectDir, 'adopt', `mark ${cls} proven`)}`
  return `${cls} passes. It is ${c.state}, and reaches proven one state at a time, through shadowed once the shadow CI job runs it: ${scriptCommand(root, projectDir, 'adopt', `mark ${cls} ${STATES[at + 1]}`)}`
}

// ── retire --dry-run ────────────────────────────────────────────────────────

function retireReport(cls, plan) {
  const lines = [`massimo adopt retire ${cls} --dry-run: ${cls} is ${plan.state}${STATES.indexOf(plan.state) < STATES.indexOf('cut-over') ? ', and retires only after cut-over' : ''}.`, '']
  if (plan.going.length === 0) return [...lines, `Nothing in ${cls} is marked retire or convert: it is all kept as the repo's own.`]
  lines.push(`Goes (${plan.going.length}: marked retire, or convert, whose place massimo's own output takes):`)
  for (const a of plan.going) lines.push(`  ${a.id}  ${a.decision}${a.found ? '' : ', already gone from the repo'}`)
  lines.push('', `Package scripts that run them, which go with them: ${plan.scripts.length ? plan.scripts.join(', ') : 'none'}.`)
  lines.push(`Workflow jobs that run those scripts, which go with them or lose the step${plan.jobs.length ? ':' : ': none.'}`)
  for (const j of plan.jobs) lines.push(`  ${j.file}${j.line ? `:${j.line}` : ''}  ${j.job ? `job ${j.job}${j.name ? ` (${j.name})` : ''}` : 'outside a job'}, runs ${j.via.join(', ')}`)
  if (plan.elsewhere.length) lines.push(`Files a generator that goes also writes, for other classes, which lose their writer: ${plan.elsewhere.map((e) => `${e.path} (${e.class ?? 'no class'}${e.state ? `, ${e.state}` : ''})`).join(', ')}.`)
  const where = (k) => `${k.file}${k.script ? ` (${k.script})` : ''}${k.line ? `:${k.line}` : ''}`
  const line = (k) => `  ${k.class.padEnd(8)}  ${where(k)}  ${k.how}${k.via ? ` through ${k.via}` : ''}${k.writtenBy ? `, written by ${k.writtenBy}` : ''}  (${k.assets.join(', ')})`
  if (plan.writers.length) {
    lines.push('', `Written by a generator that stays (${plan.writers.length}), whose code names ${plan.writers.length === 1 ? 'it' : 'them'}, so it would write ${plan.writers.length === 1 ? 'it' : 'them'} again and its check fails without ${plan.writers.length === 1 ? 'it' : 'them'}:`)
    for (const w of plan.writers) lines.push(`  ${w.path}  written by ${w.writer} (${w.class ?? 'no class'}${w.state ? `, ${w.state}` : ''}): retire it with its writer${w.class && w.class !== cls ? `, retire ${w.class} first` : ''}, or change its writer so it no longer writes it`)
  }
  lines.push('', `Consumers to repoint first (${plan.consumers.length}):`, ...(plan.consumers.length ? plan.consumers.map(line) : ['  none']))
  if (plan.historical.length) lines.push('', `Historical docs, left as they are (${plan.historical.length}):`, ...plan.historical.map(line))
  const holds = [
    plan.writers.length ? `${plural(plan.writers.length, 'file has', 'files have')} a writer that stays` : '',
    plan.consumers.length ? `${plural(plan.consumers.length, 'consumer remains', 'consumers remain')} outside the docs the ledger marks historical` : '',
  ].filter(Boolean)
  lines.push(
    '',
    holds.length > 0
      ? `Not clean: ${holds.join(', and ')}. ${plan.writers.length ? 'Retire each writer with what it writes or its class first, or change the writer so it no longer writes the file. ' : ''}${plan.consumers.length ? `Repoint each consumer first, or mark a doc that only records how things were with ${scriptCommand(root, projectDir, 'adopt', 'historical <path>')}. ` : ''}Then run this again.`
      : 'Clean: nothing outside the historical docs depends on what goes. The adopt skill removes it, its package scripts and its workflow jobs in one commit carrying an Adopt-Batch trailer, on your OK.',
  )
  return lines
}
const notClean = (plan) => plan.consumers.length > 0 || plan.writers.length > 0

// The flags verify takes, checked alike for verify and for accept, which
// passes them on to verify so it sees what verify saw.
function checkVerifyFlags(name, cls) {
  if (cls === undefined && flags.against !== undefined) fail('--against names the file one class is compared with: pass the class too')
  if (flags.pairs !== undefined && cls !== undefined && cls !== 'stories') fail(`--pairs goes with ${name} stories`)
  if (flags.pairs !== undefined && (typeof flags.pairs !== 'string' || typeof flags.a !== 'string' || typeof flags.b !== 'string')) fail('--pairs <file> needs --a <base url> and --b <base url>, the two servers whose stories are compared')
  if (flags.pairs === undefined && truthy(flags.shoot)) fail('--shoot runs the pairs file --pairs writes: pass --pairs <file> --a <base url> --b <base url>')
}

switch (command) {
  case 'scan': {
    const inv = scan()
    const md = inventoryMarkdown(inv, { command: scriptCommand(root, projectDir, 'adopt', 'scan') })
    if (!exists) {
      process.stdout.write(flags.json ? `${JSON.stringify(inv, null, 2)}\n` : md)
      break
    }
    refuseNewerFile(inventoryPath(projectDir), 'inventory', 'format', 'adopt/inventory.json')
    writeJson(inventoryPath(projectDir), inv)
    writeFileAtomic(join(projectDir, 'adopt', 'inventory.md'), md)
    const consumers = inv.assets.reduce((n, a) => n + a.consumers.length, 0)
    const keys = inv.headers.keys.filter((k) => k.files > 0).length
    process.stdout.write(`massimo adopt: ${plural(inv.assets.length, 'asset')}, ${plural(consumers, 'consumer')}, ${plural(keys, 'header key')} in use; wrote ${shown('inventory.json')} and inventory.md\n`)
    break
  }
  case 'plan': {
    needInit('plan')
    const inv = readInventory()
    const ledger = planLedger(inv, readLedger())
    refuseNewerFile(proposedPath(projectDir), 'config', 'version', 'adopt/config.proposed.json')
    writeJson(ledgerPath(projectDir), ledger)
    writeJson(proposedPath(projectDir), proposeConfig(inv, config))
    syncPhase(ledger)
    process.stdout.write(statusTable(ledger))
    const empty = Object.keys(ledger.classes).length === 0
    process.stdout.write(`\nWrote ${shown('ledger.json')} and ${shown('config.proposed.json')}. ${empty ? 'There is nothing to adopt; the config can still take what scan proposed: ' : 'Agree each loss, then: '}${scriptCommand(root, projectDir, 'adopt', 'config')}\n`)
    break
  }
  case 'config': {
    needInit('config')
    if (!existsSync(proposedPath(projectDir))) fail(`no ${shown('config.proposed.json')} yet: run ${scriptCommand(root, projectDir, 'adopt', 'plan')} first`)
    const proposed = readJson(proposedPath(projectDir), {})
    refuseNewer('config', proposed.version, 'adopt/config.proposed.json')
    const current = readJson(configPath, {}) ?? {}
    const { merged, changes } = mergeAdding(current, proposed)
    const lines = changeLines(changes)
    process.stdout.write(lines.length ? `${lines.join('\n')}\n` : 'massimo.config.json already holds everything proposed\n')
    if (truthy(flags.write)) {
      const text = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
      const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? '  '
      const writes = changes.filter((c) => c.kind !== 'kept').length
      // Writing the file anew would drop its comments, so they are the user's to keep.
      if (writes > 0 && text !== stripJsonComments(text)) {
        fail(`${rel(root, configPath)} has comments (or trailing commas), which --write would drop: make the changes above by hand, marked + and ~, then run config again to check`)
      }
      if (writes > 0) writeFileAtomic(configPath, `${JSON.stringify(merged, null, indent)}\n`)
      process.stdout.write(`${writes > 0 ? `wrote ${plural(writes, 'change')} to ${rel(root, configPath)}` : 'nothing to write'}${changes.some((c) => c.kind === 'kept') ? '; your values marked = were kept' : ''}\n`)
    }
    break
  }
  case 'status': {
    needInit('status')
    const ledger = readLedger()
    if (!ledger) fail(`no ${shown('ledger.json')} yet: run ${scriptCommand(root, projectDir, 'adopt', 'scan')}, then plan`)
    process.stdout.write(flags.json ? `${JSON.stringify(ledger, null, 2)}\n` : statusTable(ledger))
    break
  }
  case 'mark': {
    needInit('mark')
    const [cls, state] = rest
    if (!CLASSES.includes(cls) || !STATES.includes(state)) fail(`usage: adopt.mjs mark <${CLASSES.join('|')}> <${STATES.join('|')}> [--batch <id>] [--force]`)
    const ledger = readLedger()
    if (!ledger) fail(`no ${shown('ledger.json')} yet: run ${scriptCommand(root, projectDir, 'adopt', 'plan')} first`)
    let line
    try {
      line = markClass(ledger, cls, state, { batch: typeof flags.batch === 'string' ? flags.batch : null, force: truthy(flags.force) })
    } catch (e) {
      fail(e.message)
    }
    writeJson(ledgerPath(projectDir), ledger)
    syncPhase(ledger, { marked: true })
    process.stdout.write(`${line}\n`)
    break
  }
  case 'verify': {
    needInit('verify')
    const [cls] = rest
    if (cls !== undefined && !VERIFY_CLASSES.includes(cls)) fail(`usage: adopt.mjs verify [<${VERIFY_CLASSES.join('|')}>] [--against <file>]; docs has nothing generated to verify`)
    checkVerifyFlags('verify', cls)
    const ledger = readLedger()
    if (!ledger) fail(`no ${shown('ledger.json')} yet: run ${scriptCommand(root, projectDir, 'adopt', 'plan')} first`)
    const reports = (cls ? [cls] : VERIFY_CLASSES).map((name) => [name, verifyReport(name, runVerify(name, ledger), ledger.classes[name])])
    if (truthy(flags.json)) {
      const out = Object.fromEntries(reports.map(([name, r]) => [name, r.result ?? { skip: r.lines[0] }]))
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    } else {
      process.stdout.write(`${reports.map(([, r]) => r.lines.join('\n')).join('\n\n')}\n`)
      if (!cls) process.stdout.write(`\nmassimo adopt verify: ${reports.map(([name, r]) => `${name} ${r.result ? (r.open > 0 ? `${plural(r.open, 'open difference')}` : 'passes') : 'skipped'}`).join(', ')}\n`)
    }
    if (reports.some(([, r]) => r.open > 0)) process.exit(1)
    break
  }
  case 'accept': {
    needInit('accept')
    const [cls, key] = rest
    if (!VERIFY_CLASSES.includes(cls) || !key || rest.length > 2) fail(`usage: adopt.mjs accept <${VERIFY_CLASSES.join('|')}> '<key>' --why '<reason>' [the flags verify took: --against <file>, --pairs <file> --a <url> --b <url> --shoot], with the key verify printed, in quotes`)
    const why = typeof flags.why === 'string' ? flags.why : ''
    if (!why.trim()) fail('accept needs --why <text>: the reason the difference is fine, for whoever reads the ledger next')
    checkVerifyFlags('accept', cls)
    const ledger = readLedger()
    if (!ledger) fail(`no ${shown('ledger.json')} yet: run ${scriptCommand(root, projectDir, 'adopt', 'plan')} first`)
    if (!ledger.classes[cls]) fail(`the ledger has no ${cls} class; it has ${Object.keys(ledger.classes).join(', ') || 'none'}`)
    if (key === 'error') fail(`error means verify ${cls} could not run, and an error is fixed, never accepted: run verify ${cls} and fix what it says`)
    // What verify reports now, with the flags given here: the key must be
    // one of its differences, and its detail is kept, so a later change under
    // the key is open again.
    const result = runVerify(cls, ledger)
    if (result.skip) fail(`verify ${cls} is skipped, so it has nothing to accept: ${result.skip}`)
    const found = result.differences.find((d) => d.key === key)
    if (!found) {
      const { open } = settle(result.differences, ledger.classes[cls].accepted)
      const shot = key.startsWith('shot:') && !truthy(flags.shoot) ? ' A shot: key comes only from verify stories --pairs <file> --a <url> --b <url> --shoot: pass accept the same flags.' : ''
      fail(`verify ${cls} reports no difference with the key '${key}'. Its open keys: ${open.length ? open.map((d) => `'${d.key}'`).join(', ') : 'none'}. Copy the key as verify prints it, with the flags verify took.${shot}`)
    }
    let line
    try {
      line = acceptDifference(ledger, cls, key, why, { detail: found.detail })
    } catch (e) {
      fail(e.message)
    }
    writeJson(ledgerPath(projectDir), ledger)
    process.stdout.write(`${line}\n`)
    break
  }
  case 'historical': {
    needInit('historical')
    const ledger = readLedger()
    if (!ledger) fail(`no ${shown('ledger.json')} yet: run ${scriptCommand(root, projectDir, 'adopt', 'plan')} first`)
    const [path] = rest
    if (path === undefined) {
      const list = ledger.historical ?? []
      process.stdout.write(list.length ? `${list.map((h) => `${h.path}  since ${h.date}`).join('\n')}\n` : 'No doc is marked historical.\n')
      break
    }
    const file = repoFile(path)
    if (!file || !existsSync(join(root, file)) || !statSync(join(root, file)).isFile()) fail(`${path} is not a file in the repo`)
    // retire leaves only a docs use alone: a use in code still counts, so a
    // file with one is not a record of how things were.
    const uses = scan().assets.flatMap((a) => a.consumers.filter((k) => k.file === file && k.class !== 'docs').map((k) => `${k.script ? `its ${k.script} script ` : ''}${k.how} ${a.id}${k.via ? ` through ${k.via}` : ''}${k.line ? ` at line ${k.line}` : ''} (${k.class})`))
    if (uses.length > 0) fail(`${file} is not only a doc, so it cannot be historical: ${uses.join('; ')}. A use in code holds a retirement up whatever the ledger says: repoint it instead`)
    const line = markHistorical(ledger, file)
    writeJson(ledgerPath(projectDir), ledger)
    process.stdout.write(`${line}\n`)
    break
  }
  case 'retire': {
    needInit('retire')
    const [cls] = rest
    if (!CLASSES.includes(cls)) fail(`usage: adopt.mjs retire <${CLASSES.join('|')}> --dry-run`)
    if (!truthy(flags['dry-run'])) fail(`retire only lists what retiring ${cls} takes out: run it with --dry-run. Deleting is the adopt skill's job, one commit per batch, on your OK.`)
    const ledger = readLedger()
    if (!ledger) fail(`no ${shown('ledger.json')} yet: run ${scriptCommand(root, projectDir, 'adopt', 'plan')} first`)
    if (!ledger.classes[cls]) fail(`the ledger has no ${cls} class; it has ${Object.keys(ledger.classes).join(', ') || 'none'}`)
    const plan = retirePlan(ledger, cls, scan(), { jobAt: (file, line) => workflowJob(readText(root, file), line) })
    process.stdout.write(truthy(flags.json) ? `${JSON.stringify(plan, null, 2)}\n` : `${retireReport(cls, plan).join('\n')}\n`)
    if (notClean(plan)) process.exit(1)
    break
  }
  default:
    fail(`unknown command "${command}". Commands: scan, plan, config, status, mark, verify, accept, historical, retire.`)
}
