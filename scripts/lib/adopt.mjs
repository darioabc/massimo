// The adopt ledger: what becomes of each part of a repo's own design-system
// setup, kept in <project>/adopt/ledger.json. Per asset class and per asset:
// a decision (keep, convert or retire), a loss class (clean, carried, lost or
// blocker) with the lines that explain it, its consumers, and a state (found,
// mapped, shadowed, proven, cut-over, retired) with the date it moved and, at
// cut-over, the batch that moved it. A blocker stops its class at mapped.
//
// The ledger is the source of truth for the adopt phase. state.json's note
// for the phase is a view of it, rebuilt from here, since scripts older than
// 0.3.0 drop a phase they do not know when they save.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compare } from './glob.mjs'
import { DEFAULTS, FORMATS_READ, refuseNewer, today } from './project.mjs'

export const LEDGER_FORMAT = 1
export const CLASSES = ['graph', 'stories', 'audit', 'tokens', 'docs']
export const STATES = ['found', 'mapped', 'shadowed', 'proven', 'cut-over', 'retired']
export const DECISIONS = ['keep', 'convert', 'retire']
export const LOSSES = ['clean', 'carried', 'lost', 'blocker']

export const ledgerPath = (projectDir) => join(projectDir, 'adopt', 'ledger.json')
export const inventoryPath = (projectDir) => join(projectDir, 'adopt', 'inventory.json')
export const proposedPath = (projectDir) => join(projectDir, 'adopt', 'config.proposed.json')

const LEDGER_NOTE =
  'What becomes of each part of the repo\'s own setup. Edit a decision or a loss here once you have agreed it; adopt.mjs plan keeps your edits once an asset is past found, and adopt.mjs mark moves a class one state at a time. A blocker stops its class at mapped.'

// ── Reading ─────────────────────────────────────────────────────────────────

const isText = (v) => typeof v === 'string' && v.trim() !== ''

// The values the ledger may hold, so a hand edit with a typo is caught.
function ledgerProblems(ledger) {
  const out = []
  for (const [name, c] of Object.entries(ledger?.classes ?? {})) {
    if (!CLASSES.includes(name)) out.push(`class "${name}" is not one of ${CLASSES.join(', ')}`)
    if (!STATES.includes(c.state)) out.push(`${name} has state "${c.state}", not one of ${STATES.join(', ')}`)
    for (const a of c.assets ?? []) {
      if (!DECISIONS.includes(a.decision)) out.push(`${a.id} has decision "${a.decision}", not one of ${DECISIONS.join(', ')}`)
      if (!LOSSES.includes(a.loss)) out.push(`${a.id} has loss "${a.loss}", not one of ${LOSSES.join(', ')}`)
      if (!STATES.includes(a.state)) out.push(`${a.id} has state "${a.state}", not one of ${STATES.join(', ')}`)
    }
    if (c.accepted !== undefined && !(Array.isArray(c.accepted) && c.accepted.every((d) => isText(d?.key) && isText(d?.why) && (d.detail === undefined || typeof d.detail === 'string')))) {
      out.push(`${name}.accepted must be a list of { key, why, detail }, as adopt.mjs accept writes it`)
    }
    if (c.verify !== undefined && !(isText(c.verify?.ratchet) && typeof c.verify?.map === 'string')) out.push(`${name}.verify must be { ratchet, map, kept }, as adopt.mjs plan writes it`)
  }
  if (ledger?.historical !== undefined && !(Array.isArray(ledger.historical) && ledger.historical.every((h) => isText(h?.path)))) {
    out.push('historical must be a list of { path }, as adopt.mjs historical writes it')
  }
  return out
}

// The ledger, or null when there is none. A newer format is refused; a hand
// edit that names an unknown decision, loss or state is an error. With
// `quiet`, a ledger that cannot be used is null instead, for the session hook.
export function loadLedger(projectDir, { quiet = false } = {}) {
  const path = ledgerPath(projectDir)
  if (!existsSync(path)) return null
  let ledger
  try {
    ledger = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    if (quiet) return null
    throw new Error(`adopt/ledger.json is not valid JSON: ${e.message}`)
  }
  if (quiet) return typeof ledger?.format === 'number' && ledger.format <= FORMATS_READ.ledger && ledgerProblems(ledger).length === 0 ? ledger : null
  refuseNewer('ledger', ledger?.format, 'adopt/ledger.json')
  const problems = ledgerProblems(ledger)
  if (problems.length > 0) throw new Error(`adopt/ledger.json: ${problems.join('; ')}`)
  return ledger
}

// ── Planning ────────────────────────────────────────────────────────────────

const roleText = (r) => (typeof r === 'string' ? r : `${r.role}${r.under ? ` under ${r.under}` : ''}${r.values ? ` (${r.values.join(', ')})` : ''}`)
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const list = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

// The decision, loss and lines for one asset of the inventory. `config` tells
// a Ladle repo that opted in to the csf lane from one that did not.
function assess(asset, inv, config = {}) {
  const lane = inv.stories.lane
  const lines = []
  let decision = 'keep'
  let loss = 'clean'
  const worse = (l) => {
    if (LOSSES.indexOf(l) > LOSSES.indexOf(loss)) loss = l
  }
  const ratchet = inv.own.ratchets.find((r) => asset.paths.includes(r.path))
  switch (asset.kind) {
    case 'lane':
      lines.push(`The lane stays at ${lane.dir}/, with its scripts (${lane.scripts.join(', ')}) and port ${lane.port ?? 'unknown'}; massimo reads it through stories.lane and stories.manifest.`)
      break
    case 'gate':
      lines.push('The integration stays; it gates the lane behind the STORIES flag.')
      break
    case 'manifest': {
      const m = lane.manifest
      // Whole entries it cannot read, or no entries at all: massimo's list of
      // stories would be a guess.
      const whole = m.entriesNotReadable ?? []
      if (whole.length > 0 || m.entries === 0) {
        worse('blocker')
        if (m.entries === 0) lines.push(`massimo reads no entries from it${m.notReadable.length ? ` (${m.notReadable.join('; ')})` : ''}, so it cannot list the stories. Make the list a literal, then set this loss.`)
        else lines.push(`${plural(whole.length, 'entry is', 'entries are')} not statically readable, so massimo cannot list ${whole.length === 1 ? 'it' : 'them'}: ${whole.join('; ')}. Make each a literal, then set this loss.`)
      } else if (m.notReadable.length > 0) {
        worse('carried')
        lines.push(`${plural(m.notReadable.length, 'field is', 'fields are')} not statically readable; the lane still uses ${m.notReadable.length === 1 ? 'it' : 'them'}, and massimo's checks skip ${m.notReadable.length === 1 ? 'it' : 'them'}: ${m.notReadable.join('; ')}.`)
      } else lines.push(`All ${plural(m.entries, 'entry', 'entries')} read statically.`)
      break
    }
    case 'pages':
      lines.push(`${plural(lane.pageCount, 'page')} at ${lane.pages}${lane.frames ? `, ${plural(lane.frameCount, 'frame')} at ${lane.frames}` : ''}, ${plural(lane.states, 'state')}.`)
      if (lane.statesNotReadable > 0) {
        worse('carried')
        lines.push(`${plural(lane.statesNotReadable, 'state label is', 'state labels are')} not statically readable, so massimo does not check ${lane.statesNotReadable === 1 ? 'that state' : 'those states'}.`)
      }
      break
    case 'tool': {
      const t = inv.stories.tools.find((x) => `tool:${x.tool}` === asset.id)
      worse('carried')
      // A Ladle repo that set stories.lane to csf converts: its story files stay
      // where they are, and only the specifier of their type import changes.
      if (t.tool === 'ladle' && config?.stories?.lane === 'csf') {
        decision = 'convert'
        lines.push(`Its ${plural(t.stories, 'story', 'stories')} in ${plural(t.files, 'file')} stay where they are, read in place by the csf lane. Only the specifier of each file's type import changes, in a patch that convert stories writes for you to apply; the tool goes once nothing reads it.`)
        if (t.notReadable > 0) lines.push(`${plural(t.notReadable, 'file has', 'files have')} something not statically readable, listed in the inventory.`)
        if (t.withArgs > 0) lines.push(`${plural(t.withArgs, 'file uses', 'files use')} args or argTypes, which stay in the file and apply at run time; convert stories lists them for a hand pass.`)
        break
      }
      lines.push(`Its ${plural(t.stories, 'story', 'stories')} in ${plural(t.files, 'file')} stay in ${t.tool}; the graph credits them by file name. Moving them to the native lane is a later step.`)
      if (t.notReadable > 0) lines.push(`${plural(t.notReadable, 'file has', 'files have')} something not statically readable, listed in the inventory.`)
      if (t.withArgs > 0) lines.push(`${plural(t.withArgs, 'file uses', 'files use')} args or argTypes, which a move to the native lane turns into states by hand.`)
      break
    }
    case 'styles':
      lines.push('Stays the source of the tokens; tokens.mjs mirror keeps the token set as its checked mirror.')
      break
    case 'token-json':
      decision = 'retire'
      worse('carried')
      lines.push("The repo's own shape: an oracle to verify massimo's tokens/resolved.json against, never a source. Its readers move to tokens/resolved.json, then it goes with its writer.")
      break
    case 'graph':
    case 'index':
      decision = 'convert'
      worse('carried')
      lines.push(`${asset.kind === 'graph' ? `${plural(inv.own.docs.find((d) => asset.paths.includes(d.path))?.nodes ?? 0, 'node heading')}.` : 'An index of the same graph.'} massimo's graph.md and graph.json take over once verify graph matches it; it goes with its writer.`)
      break
    case 'tokens':
      decision = 'retire'
      worse('lost')
      lines.push("massimo writes no page like this one: tokens/resolved.json holds each token's values by selector, not what reads it. Accept the loss, or keep the page.")
      break
    case 'generator': {
      const g = inv.own.generators.find((x) => asset.paths.includes(x.path))
      decision = 'retire'
      worse('carried')
      lines.push(`Writes ${list(g.writes)}, run by ${g.scripts.length ? list(g.scripts) : 'no package script'}. It runs beside massimo until verify matches, then goes with its package scripts.`)
      for (const r of inv.own.ratchets.filter((x) => g.writes.includes(x.path) && x.unmapped.length > 0)) {
        worse('lost')
        lines.push(`Its ${plural(r.unmapped.length, 'rule')} with no massimo kind (${list(r.unmapped)}) go with it, unless a project check under guard.extraChecks keeps them.`)
      }
      break
    }
    case 'ratchet':
      decision = 'convert'
      if (ratchet.map) lines.push(`Seeds audits/baseline.json: audit.mjs --import ${ratchet.path} --map ${ratchet.map}.`)
      for (const rule of ratchet.unmapped) {
        const r = ratchet.rules.find((x) => x.rule === rule)
        worse('lost')
        lines.push(`${rule} (count ${r.count}) has no massimo kind: keep it as a project check under guard.extraChecks, or accept losing it.`)
      }
      break
    case 'notes':
      lines.push('Written by hand; it stays where it is.')
      break
    case 'design-md': {
      const d = inv.own.designMd.find((x) => asset.paths.includes(x.path))
      decision = 'convert'
      worse('carried')
      lines.push("extract reads its tokens and component rules as a source; massimo's own DESIGN.md output can take its place once they match.")
      if (d.problems.length > 0) lines.push(`Left out of its front matter: ${d.problems.join('; ')}.`)
      break
    }
    default:
      lines.push('massimo has no plan for this kind of asset yet.')
      worse('carried')
  }
  // A part that moves needs what reads it at build or run time repointed
  // first, and a generated doc that names it changes through its writer.
  const deploy = asset.consumers.filter((c) => c.class === 'deploy')
  if (decision !== 'keep' && deploy.length > 0) lines.push(`Read at build or run time by ${list(deploy.map((c) => `${c.file}${c.script ? ` (${c.script})` : ''}`))}: repoint ${deploy.length === 1 ? 'it' : 'them'} before cut-over.`)
  const written = new Map()
  for (const c of asset.consumers.filter((x) => x.writtenBy)) written.set(c.writtenBy, [...(written.get(c.writtenBy) ?? []), c.file])
  if (decision !== 'keep') for (const [writer, docs] of written) lines.push(`Named in ${list(docs)}, which ${writer} writes: change ${writer} and regenerate with it, rather than editing by hand.`)
  return { decision, loss, lines }
}

// The repo's own keys in use (beyond massimo's built-in ones) and the repo's
// scripts that read the headers: what makes the headers the repo's own
// setup. Headers with only the built-in keys and no reader of their own are
// massimo's already, with nothing to adopt.
const ownKeys = (inv) => inv.headers.keys.filter((k) => !k.builtin && k.files > 0)
const headerReaders = (inv) => inv.headers.readers ?? []
const hasOwnHeaders = (inv) => ownKeys(inv).length > 0 || headerReaders(inv).length > 0

// The header census as an asset of the graph class: the headers stay in the
// source, read through config roles.
function headersAsset(inv) {
  const lines = []
  let loss = 'clean'
  for (const k of ownKeys(inv)) {
    if (k.role) lines.push(`ds:${k.key} on ${plural(k.files, 'file')} has the role ${roleText(k.role)}.`)
    else if (k.proposed) lines.push(`ds:${k.key} on ${plural(k.files, 'file')}: read as ${roleText(k.proposed)}.`)
    else {
      loss = 'carried'
      lines.push(`ds:${k.key} on ${plural(k.files, 'file')}: no role fits, so it is read as an extra key and its values are not checked.`)
    }
  }
  const readers = headerReaders(inv)
  if (readers.length > 0) lines.push(`${list(readers)} ${readers.length === 1 ? 'reads' : 'read'} the ds: headers as well. The headers stay in the source unchanged, so ${readers.length === 1 ? 'it keeps' : 'they keep'} working.`)
  if (inv.headers.taxonomy) {
    lines.push(`${plural(inv.headers.taxonomy.groups.length, 'group')} in ${plural(inv.headers.taxonomy.tiers.length, 'tier')}, proposed as graph.taxonomy.`)
    lines.push('Scan proposes no path rules: add rules to graph.taxonomy.rules for the files without a ds:group line, or the graph reports each as having no group.')
  }
  return { id: 'headers', class: 'graph', kind: 'headers', paths: [], consumers: [], decision: 'keep', loss, lines }
}

const CUT_OVER = STATES.indexOf('cut-over')
// The furthest state an asset goes: a kept asset stays cut over, never retired.
const lastState = (a) => (a.decision === 'keep' ? CUT_OVER : STATES.length - 1)
// Where an asset stands against its class: a kept asset at the end of its
// way is as far on as a retired one.
const standing = (a) => (STATES.indexOf(a.state) >= lastState(a) ? STATES.length - 1 : STATES.indexOf(a.state))

// The ledger from an inventory. An asset past found was agreed with the user:
// it keeps its decision, loss, lines, state, date and batch (perhaps edited
// by hand) and takes the new consumers, and when the scan no longer finds it,
// it is kept and marked missing. An asset at found, or new to the scan, is
// planned afresh, and a class with a new asset goes back to found until it
// is agreed too, so nothing counts as mapped or cut over that was not.
export function planLedger(inv, previous = null, { date = today(), config = {} } = {}) {
  const assets = inv.assets.map((a) => ({ ...a, ...assess(a, inv, config) }))
  if (hasOwnHeaders(inv)) assets.push(headersAsset(inv))
  const classes = {}
  for (const cls of CLASSES) {
    const mine = assets.filter((a) => a.class === cls).sort((a, b) => compare(a.id, b.id))
    const was = previous?.classes?.[cls]
    if (mine.length === 0 && !was) continue
    const entries = mine.map((a) => {
      const old = was?.assets?.find((x) => x.id === a.id)
      const fresh = { id: a.id, kind: a.kind, paths: a.paths, decision: a.decision, loss: a.loss, lines: a.lines, consumers: a.consumers, state: 'found', date: old?.date ?? date, batch: null }
      return old && old.state !== 'found' ? { ...fresh, decision: old.decision, loss: old.loss, lines: old.lines, state: old.state, date: old.date, batch: old.batch } : fresh
    })
    for (const old of was?.assets ?? []) if (old.state !== 'found' && !mine.some((a) => a.id === old.id)) entries.push({ ...old, missing: true })
    // A class left with nothing in it has nothing to adopt.
    if (entries.length === 0) continue
    const wasAt = was ? STATES.indexOf(was.state) : 0
    const at = Math.min(wasAt, ...entries.filter((a) => !a.missing).map(standing))
    const same = was && at === wasAt
    const verify = cls === 'audit' ? auditVerify(inv, was?.verify) : null
    classes[cls] = {
      state: STATES[at],
      date: same ? was.date : date,
      batch: same ? was.batch : at >= CUT_OVER ? was.batch : null,
      assets: entries.sort((a, b) => compare(a.id, b.id)),
      ...(verify ? { verify } : {}),
      ...(was?.accepted?.length ? { accepted: was.accepted } : {}),
      ...(was?.converted ? { converted: was.converted } : {}),
    }
  }
  const historical = previous?.historical ?? []
  return { format: LEDGER_FORMAT, generatedBy: 'massimo adopt', note: LEDGER_NOTE, classes, ...(historical.length ? { historical } : {}) }
}

// What verify audit compares the audit with: the repo's ratchet, the map of
// its rules to massimo's kinds (by name, which you may edit here), and the
// rules with no kind, which the repo keeps, through guard.extraChecks. A map
// agreed on the same ratchet is kept as it was.
function auditVerify(inv, was) {
  const ratchet = inv.own.ratchets[0]
  if (!ratchet) return null
  if (was?.ratchet === ratchet.path) return was
  return { ratchet: ratchet.path, map: ratchet.map, kept: ratchet.unmapped }
}

// ── Accepting a difference, and historical docs ─────────────────────────────

// Accept a difference verify reports, by its key, with the reason and the
// detail verify gave it, so a later difference under the same key with
// another detail is open again; a key accepted before takes the new reason
// and detail. Returns a line on what changed.
export function acceptDifference(ledger, cls, key, why, { detail, date = today() } = {}) {
  const c = ledger.classes[cls]
  if (!c) throw new Error(`the ledger has no ${cls} class; it has ${Object.keys(ledger.classes).join(', ') || 'none'}`)
  if (!isText(key)) throw new Error('accept needs the key verify printed for the difference')
  if (!isText(why)) throw new Error('accept needs --why <text>: the reason the difference is fine, for whoever reads the ledger next')
  if (typeof detail !== 'string') throw new Error(`accept needs the detail verify gives ${key}`)
  const list = (c.accepted ?? []).filter((d) => d.key !== key)
  const again = list.length !== (c.accepted ?? []).length
  c.accepted = [...list, { key, why: why.trim(), detail, date }].sort((a, b) => compare(a.key, b.key))
  return `${cls}: ${again ? 'accepted again, with the new reason' : 'accepted'}: ${key}`
}

// Mark a doc historical: a record of how things were, which retire leaves as
// it is, so it does not hold a retirement up.
export function markHistorical(ledger, path, { date = today() } = {}) {
  const list = ledger.historical ?? []
  if (list.some((h) => h.path === path)) return `${path} is already historical`
  ledger.historical = [...list, { path, date }].sort((a, b) => compare(a.path, b.path))
  return `${path} is historical: retire leaves it as it is`
}

// ── Retiring a class ────────────────────────────────────────────────────────

// What retiring a class takes out, from the ledger and a fresh scan: the
// assets that go (marked retire, or convert, whose place massimo's own
// output takes), the package scripts that run them and the workflow jobs
// that run those, which go with them, and every other consumer, which must
// be repointed first unless it is a doc the ledger marks historical. Files
// a retiring generator also writes for another class are listed, as they
// lose their writer. A file that goes but that a generator which stays
// still writes (its code names the file) is a blocker: its writer would
// bring it back, and its check would fail without it. `jobAt(file, line)`
// names a workflow's job at a line.
export function retirePlan(ledger, cls, inv, { jobAt = () => null } = {}) {
  const c = ledger.classes[cls]
  const historical = new Set((ledger.historical ?? []).map((h) => h.path))
  const fresh = new Map(inv.assets.map((a) => [a.id, a]))
  const going = c.assets.filter((a) => a.decision !== 'keep' && !a.missing)
  const goingPaths = going.flatMap((a) => fresh.get(a.id)?.paths ?? a.paths)
  const goes = (file) => goingPaths.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p))
  const scripts = [...new Set(going.flatMap((a) => fresh.get(a.id)?.scripts ?? []))].sort(compare)
  const consumers = new Map()
  const jobs = new Map()
  for (const a of going) {
    for (const k of fresh.get(a.id)?.consumers ?? []) {
      if (goes(k.file)) continue
      if (k.class === 'ci' && k.how === 'runs' && scripts.includes(k.via)) {
        const job = jobAt(k.file, k.line)
        const id = `${k.file}#${job?.id ?? k.line}`
        jobs.set(id, { file: k.file, line: k.line, job: job?.id ?? null, name: job?.name ?? null, via: [...new Set([...(jobs.get(id)?.via ?? []), k.via])].sort(compare) })
        continue
      }
      // A file that depends on several assets is listed once, as its
      // strongest tie: a deploy read before a CI run before a mention.
      const id = `${k.file}#${k.script ?? ''}`
      const seen = consumers.get(id)
      const stronger = !seen || CONSUMER_CLASSES.indexOf(k.class) < CONSUMER_CLASSES.indexOf(seen.class)
      consumers.set(id, { ...(stronger ? k : seen), assets: [...(seen?.assets ?? []), a.id] })
    }
  }
  const all = [...consumers.values()].sort((x, y) => compare(x.file, y.file) || compare(x.script ?? '', y.script ?? ''))
  const kept = (k) => k.class === 'docs' && historical.has(k.file)
  // The class (and its state) of the ledger asset that holds a path.
  const classOf = (path) => {
    const [name, other] = Object.entries(ledger.classes).find(([, x]) => x.assets.some((a) => a.paths.includes(path))) ?? []
    return { class: name ?? null, state: other?.state ?? null }
  }
  const writers = going.filter((a) => a.kind === 'generator').flatMap((a) => inv.own.generators.filter((g) => a.paths.includes(g.path)))
  const elsewhere = [...new Set(writers.flatMap((g) => g.writes))].filter((p) => !goes(p)).sort(compare).map((path) => ({ path, ...classOf(path) }))
  // A generator of the fresh scan that stays and writes what goes: only what
  // its own code names (`named`), since a file's GENERATED note outlives the
  // change that stops its writer writing it.
  const holds = (p, file) => (p.endsWith('/') ? file.startsWith(p) : file === p)
  const written = []
  for (const g of inv.own.generators.filter((x) => !goes(x.path))) {
    for (const path of g.named ?? g.writes) {
      const a = going.find((x) => (fresh.get(x.id)?.paths ?? x.paths).some((p) => holds(p, path)))
      if (a) written.push({ path, asset: a.id, writer: g.path, ...classOf(g.path) })
    }
  }
  return {
    state: c.state,
    going: going.map((a) => ({ id: a.id, decision: a.decision, paths: fresh.get(a.id)?.paths ?? a.paths, found: fresh.has(a.id) })),
    scripts,
    jobs: [...jobs.values()].sort((x, y) => compare(x.file, y.file) || (x.line ?? 0) - (y.line ?? 0)),
    consumers: all.filter((k) => !kept(k)),
    historical: all.filter(kept),
    elsewhere,
    writers: written.sort((x, y) => compare(x.path, y.path) || compare(x.writer, y.writer)),
  }
}

// ── Moving a class ──────────────────────────────────────────────────────────

const blockersOf = (c) => c.assets.filter((a) => a.loss === 'blocker' && !a.missing)

// Move a class one state on: found, mapped, shadowed, proven, cut-over (with
// the batch id its commit carries), retired. Never past mapped while it has a
// blocker. With `force`, a repair: back, or more than one state on (cut-over
// still needs its batch). The assets behind the new state follow it (a kept
// asset stays cut over, never retired), and going back, those ahead of it;
// an asset already there keeps its date and batch. Returns a line on what
// changed.
export function markClass(ledger, cls, state, { batch = null, force = false, date = today() } = {}) {
  const c = ledger.classes[cls]
  if (!c) throw new Error(`the ledger has no ${cls} class; it has ${Object.keys(ledger.classes).join(', ') || 'none'}`)
  if (!STATES.includes(state)) throw new Error(`"${state}" is not a state; the states are ${STATES.join(', ')}`)
  const from = STATES.indexOf(c.state)
  const to = STATES.indexOf(state)
  if (to === from) return `${cls} is already ${state}`
  if (to < from && !force) throw new Error(`${cls} is ${c.state}; moving it back to ${state} needs --force`)
  if (to > from + 1 && !force) throw new Error(`${cls} is ${c.state}, so it moves to ${STATES[from + 1]} next: one state at a time, or --force to repair the ledger`)
  const blockers = blockersOf(c)
  if (to > STATES.indexOf('mapped') && blockers.length > 0) {
    throw new Error(`${cls} has ${plural(blockers.length, 'blocker')} (${blockers.map((a) => a.id).join(', ')}), so it cannot move past mapped: resolve ${blockers.length === 1 ? 'it' : 'each'}, then change its loss in adopt/ledger.json`)
  }
  const cuts = from < CUT_OVER && to >= CUT_OVER
  if (cuts && (typeof batch !== 'string' || !batch)) throw new Error('cut-over needs --batch <id>, the id the batch commit carries in its trailer')
  // The batch an asset or the class carries at `next`, coming from `was`.
  const batchAt = (next, was, kept) => (next < CUT_OVER ? null : was < CUT_OVER ? batch : kept)
  c.state = state
  c.date = date
  c.batch = batchAt(to, from, c.batch)
  for (const a of c.assets) {
    if (a.missing) continue
    const at = STATES.indexOf(a.state)
    const target = Math.min(to, lastState(a))
    if (to > from ? at >= target : at <= target) continue
    a.state = STATES[target]
    a.date = date
    a.batch = batchAt(target, at, a.batch)
  }
  return `${cls}: ${STATES[from]} -> ${state}${cuts ? ` (batch ${batch})` : ''}`
}

// ── Views ───────────────────────────────────────────────────────────────────

// The adopt phase as the ledger has it: done once every class is cut over
// or retired, in progress before that; the note names each class's state.
// A ledger with no classes has nothing to adopt, so the phase is skipped.
export function ledgerPhase(ledger) {
  const classes = Object.entries(ledger?.classes ?? {})
  if (classes.length === 0) return { status: 'skipped', note: 'nothing to adopt' }
  const done = classes.every(([, c]) => STATES.indexOf(c.state) >= STATES.indexOf('cut-over'))
  const blocked = classes.filter(([, c]) => blockersOf(c).length > 0).map(([name]) => name)
  const note = `${classes.map(([name, c]) => `${name} ${c.state}`).join(', ')}${blocked.length ? `; ${list(blocked)} blocked` : ''}`
  return { status: done ? 'done' : 'in_progress', note }
}

const CONSUMER_CLASSES = ['deploy', 'ci', 'hand-run', 'docs']

// The ledger as a table for a person: one row per class, then each asset
// with its decision, loss and consumers, and the lines that explain a loss
// that is not clean.
export function statusTable(ledger) {
  const rows = [['Class', 'State', 'Since', 'Batch', 'Assets', 'Blockers', 'Consumers (deploy, ci, hand-run, docs)']]
  for (const [name, c] of Object.entries(ledger.classes)) {
    const consumers = c.assets.flatMap((a) => a.consumers ?? [])
    rows.push([name, c.state, c.date, c.batch ?? '-', String(c.assets.length), String(blockersOf(c).length), CONSUMER_CLASSES.map((k) => consumers.filter((x) => x.class === k).length).join(', ')])
  }
  if (rows.length === 1) return 'The ledger has no classes: scan found nothing to adopt.\n'
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  const out = rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd())
  for (const [name, c] of Object.entries(ledger.classes)) {
    out.push('', `${name}:`)
    for (const a of c.assets) {
      out.push(`  ${a.id}  ${a.decision}, ${a.loss}, ${a.state}, ${plural((a.consumers ?? []).length, 'consumer')}${a.missing ? ', no longer found by scan' : ''}`)
      if (a.loss !== 'clean') for (const line of a.lines) out.push(`    ${line}`)
    }
  }
  return `${out.join('\n')}\n`
}

// ── The proposed config ─────────────────────────────────────────────────────

const RUN = { npm: 'npm run', pnpm: 'pnpm run', yarn: 'yarn', bun: 'bun run' }

// The config keys scan can fill: the header keys and their roles, the
// taxonomy, node kinds for pages and layouts with headers, the lane's
// manifest, pages, frames, dev command and port, and the lane folder kept out
// of the audit. With `lane: 'csf'` on a Ladle repo (the opt-in of
// `config --lane csf`), also the csf lane: Ladle's own settings as ids, the
// story glob, order, home, viewports and a port beside Ladle's, the frozen
// design targets in `frozen`, and the minScripts those keys need.
export function proposeConfig(inv, config = {}, { lane: laneKind = null, frozen = [] } = {}) {
  const proposed = { version: 1 }
  const graph = {}
  const extra = inv.headers.keys.filter((k) => !k.builtin && k.files > 0)
  if (extra.length > 0) graph.extraKeys = extra.map((k) => k.key).sort(compare)
  const roles = extra.filter((k) => !k.role && k.proposed)
  if (roles.length > 0) graph.keys = Object.fromEntries(roles.map((k) => [k.key, k.proposed]).sort((a, b) => compare(a[0], b[0])))
  if (inv.headers.taxonomy) graph.taxonomy = { tiers: inv.headers.taxonomy.tiers, groups: inv.headers.taxonomy.groups }
  if (Object.keys(inv.headers.kinds).length > 0) graph.kinds = inv.headers.kinds
  if (Object.keys(graph).length > 0) proposed.graph = graph
  const lane = inv.stories.lane
  if (lane) {
    const exts = lane.exts ?? []
    const run = RUN[config.packageManager] ?? RUN.npm
    proposed.stories = {
      ...(lane.manifest ? { lane: 'manifest', manifest: lane.manifest.path } : {}),
      ...(lane.pages ? { pages: lane.pages } : {}),
      ...(lane.frames ? { frames: lane.frames } : {}),
      ...(exts.length > 0 ? { include: [`${lane.dir}/**/*.${exts.length === 1 ? exts[0] : `{${exts.join(',')}}`}`] } : {}),
      ...(lane.devScript ? { devCommand: `${run} ${lane.devScript}` } : {}),
      ...(lane.port ? { port: lane.port, url: `http://localhost:${lane.port}${lane.route}`, storyUrl: `http://localhost:${lane.port}${lane.route}/{slug}` } : {}),
    }
    proposed.audit = { exclude: [`${lane.dir}/**`] }
  }
  const ladle = laneKind === 'csf' ? inv.stories.tools.find((t) => t.tool === 'ladle') : null
  if (ladle) {
    const s = ladle.settings ?? {}
    const ladlePort = s.port ?? ladle.port
    const port = ladlePort ? ladlePort + 1 : null
    proposed.minScripts = '0.4.0'
    proposed.stories = {
      ...proposed.stories,
      lane: 'csf',
      ids: 'ladle',
      ...(s.stories ? { include: [].concat(s.stories) } : {}),
      ...(s.storyOrder ? { order: s.storyOrder } : {}),
      ...(s.defaultStory ? { home: s.defaultStory } : {}),
      ...(s.widths ? { viewports: s.widths.map((w) => ({ label: w.label, width: w.width, height: 0 })) } : {}),
      ...(port ? { port, url: `http://localhost:${port}/stories`, storyUrl: `http://localhost:${port}/stories/{slug}/{state}` } : {}),
      ...(frozen.length > 0 ? { frozen } : {}),
    }
  }
  return proposed
}

// Lists merged item by item: the proposal adds what the user's list lacks.
const UNION = ['graph.extraKeys', 'audit.exclude', 'stories.include']
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const at = (obj, path) => path.reduce((o, k) => (isPlainObject(o) ? o[k] : undefined), obj)
// A glob with each `{a,b}` list in order, so `*.{ts,astro}` is `*.{astro,ts}`.
const sameGlob = (g) => (typeof g === 'string' ? g.replace(/\{([^{}]*)\}/g, (_, inner) => `{${inner.split(',').sort(compare).join(',')}}`) : g)

// The proposal merged into the user's config, adding keys and never
// overwriting a value the user set. A value is unset when it is missing,
// null, or massimo's default (the user did not choose it). Returns
// { merged, changes } where each change is { path, kind, from, to }: kind is
// add, default (a default replaced), extend (items added to a list) or kept
// (the user's value stays, and the proposal differs).
export function mergeAdding(current, proposed, path = []) {
  const merged = isPlainObject(current) ? { ...current } : {}
  const changes = []
  for (const [key, want] of Object.entries(proposed)) {
    const p = [...path, key]
    const name = p.join('.')
    const have = merged[key]
    const fallback = at(DEFAULTS, p)
    // A section massimo has (graph, graph.kinds) is merged key by key, so
    // each key shows as its own change; any other object is one value.
    if (isPlainObject(want) && (isPlainObject(have) || (have === undefined && isPlainObject(fallback)))) {
      const inner = mergeAdding(have ?? {}, want, p)
      merged[key] = inner.merged
      changes.push(...inner.changes)
    } else if (have === undefined || have === null) {
      merged[key] = want
      changes.push({ path: name, kind: 'add', from: have ?? null, to: want })
    } else if (same(have, want)) {
      continue
    } else if (UNION.includes(name) && Array.isArray(have) && Array.isArray(want)) {
      const added = want.filter((x) => !have.some((y) => same(sameGlob(x), sameGlob(y))))
      if (added.length === 0) continue
      merged[key] = [...have, ...added]
      changes.push({ path: name, kind: 'extend', from: have, to: merged[key] })
    } else if (fallback !== undefined && same(have, fallback)) {
      merged[key] = want
      changes.push({ path: name, kind: 'default', from: have, to: want })
    } else {
      changes.push({ path: name, kind: 'kept', from: have, to: want })
    }
  }
  return { merged, changes }
}

// The changes as diff lines: + added, ~ a default replaced or a list
// extended, = the user's value kept where the proposal differs.
export function changeLines(changes) {
  const show = (v) => JSON.stringify(v)
  return changes.map((c) =>
    c.kind === 'add'
      ? `+ ${c.path}: ${show(c.to)}`
      : c.kind === 'kept'
        ? `= ${c.path}: kept ${show(c.from)} (proposed ${show(c.to)})`
        : `~ ${c.path}: ${show(c.from)} -> ${show(c.to)}${c.kind === 'default' ? ' (was the default)' : ''}`,
  )
}
