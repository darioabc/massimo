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
//
// Read-only towards the repo: only massimo.config.json (config --write) and
// the files under <project>/adopt/ are written. Shared flags: --root,
// --config, --project-dir.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_KINDS } from './audit.mjs'
import { CLASSES, STATES, changeLines, inventoryPath, ledgerPath, ledgerPhase, loadLedger, markClass, mergeAdding, planLedger, proposeConfig, proposedPath, statusTable } from './lib/adopt.mjs'
import { buildInventory, inventoryMarkdown, repoFiles } from './lib/inventory.mjs'
import { DEFAULTS, deepMerge, fail, loadConfig, parseArgs, readJson, refuseNewer, rel, scriptCommand, stripJsonComments, writeFileAtomic } from './lib/project.mjs'
import { loadState, setPhase, statePath, updateState } from './lib/state.mjs'
import { truthy } from './lib/text.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// --write and --force take no value, so a positional after them stays one.
const { _: args, flags } = parseArgs(process.argv.slice(2).map((a) => (a === '--write' || a === '--force' ? `${a}=true` : a)))
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
    fail(`detect.mjs failed: ${e.message.split('\n')[0]}`)
  }
}

// The inventory of the repo as it is now. Before init, the config detect
// suggests stands in for the one init would write.
function scan() {
  const detected = detect()
  const pkg = readJson(join(root, 'package.json'), {}) ?? {}
  const effective = exists ? config : deepMerge(structuredClone(DEFAULTS), detected.suggestedConfig ?? {})
  const files = repoFiles(root, { ignore: effective.ignore, projectRel: exists ? projectRel : effective.projectDir, workspaces: Boolean(pkg.workspaces) })
  return buildInventory(root, { detected, config: effective, pkg, files, auditKinds: ALL_KINDS })
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
  default:
    fail(`unknown command "${command}". Commands: scan, plan, config, status, mark.`)
}
