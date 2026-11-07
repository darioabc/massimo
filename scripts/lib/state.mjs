// Project state: the phase list, explorations, the generated progress block
// in STATUS.md, and the decision log. state.mjs is the CLI over this; the
// SessionStart hook reads it to tell a new session where the project stands.

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ledgerPhase, loadLedger } from './adopt.mjs'
import { SCRIPTS_VERSION, now, today, withLock, writeFileAtomic } from './project.mjs'

// An optional phase only some repos have work for. A project without its
// entry gets it as `whenMissing`, never as to do, so a project made before
// the phase existed is not told it is next.
export const PHASES = [
  { id: 'setup', title: 'Set up the project', skill: 'start' },
  { id: 'adopt', title: "Adopt the repo's own setup", skill: 'adopt', optional: true, whenMissing: 'skipped' },
  { id: 'graph', title: 'Map the component graph', skill: 'graph' },
  { id: 'stories', title: 'Story lane and baseline stories', skill: 'stories' },
  { id: 'tokens', title: 'Audit and define tokens', skill: 'tokens' },
  { id: 'tidy', title: 'Tidy raw values and duplicates', skill: 'tidy' },
  { id: 'guard', title: 'Rules, docs and CI guard', skill: 'guard' },
  { id: 'figma', title: 'Mirror to Figma', skill: 'figma' },
]

export const STATUSES = ['todo', 'in_progress', 'done', 'skipped']

export const EXPLORATION_STATUSES = [
  'framing',
  'reviewing',
  'ideating',
  'awaiting-pick',
  'translating',
  'fidelity',
  'handed-off',
  'built',
  'parked',
]

// An exploration is open while the design loop still has work: until the
// handoff is written (then it is a build task), or the user parks it.
export const isOpen = (e) => !['handed-off', 'built', 'parked'].includes(e.status)

const SYMBOL = { done: '✓', in_progress: '◐', todo: '○', skipped: '–' }
const LABEL = { done: 'done', in_progress: 'in progress', todo: 'to do', skipped: 'skipped' }

export const PROGRESS_START = '<!-- massimo:progress:start -->'
export const PROGRESS_END = '<!-- massimo:progress:end -->'

export function emptyState() {
  return {
    version: 1,
    massimo: SCRIPTS_VERSION,
    createdAt: now(),
    updatedAt: now(),
    phases: PHASES.map((p) => ({ id: p.id, status: p.whenMissing ?? 'todo', note: '', updatedAt: null })),
    explorations: [],
  }
}

export function statePath(projectDir) {
  return join(projectDir, 'state.json')
}

// A phase state.json does not have. The adopt phase is rebuilt from its
// ledger when there is one with something in it, since an older script
// drops the entry when it saves; without one it is skipped.
function missingPhase(p, projectDir) {
  const ledger = p.id === 'adopt' ? loadLedger(projectDir, { quiet: true }) : null
  if (ledger && Object.keys(ledger.classes ?? {}).length > 0) return { id: p.id, ...ledgerPhase(ledger), updatedAt: null }
  return { id: p.id, status: p.whenMissing ?? 'todo', note: '', updatedAt: null }
}

// Missing phases are added in canonical order (as `todo`, or an optional
// phase's `whenMissing`), so a project made by an older version keeps
// working after the phase list grows.
export function loadState(projectDir) {
  const path = statePath(projectDir)
  if (!existsSync(path)) return null
  const state = JSON.parse(readFileSync(path, 'utf8'))
  const byId = new Map((state.phases ?? []).map((p) => [p.id, p]))
  state.phases = PHASES.map((p) => byId.get(p.id) ?? missingPhase(p, projectDir))
  state.explorations ??= []
  return state
}

// An optional phase nobody has touched stays out of STATUS.md and the
// session hook: it is skipped by default, not by a choice worth showing.
const shown = (p) => !(phaseMeta(p.id)?.optional && p.status === 'skipped' && !p.updatedAt && !p.note)

export function saveState(projectDir, state) {
  state.updatedAt = now()
  state.massimo = SCRIPTS_VERSION
  writeFileAtomic(statePath(projectDir), `${JSON.stringify(state, null, 2)}\n`)
}

// Load, change and save state.json under a lock, so two sessions updating the
// project at once both keep their change. `change` gets the loaded state.
export function updateState(projectDir, change) {
  return withLock(statePath(projectDir), () => {
    const state = loadState(projectDir)
    if (!state) throw new Error('no state.json to update')
    const result = change(state)
    saveState(projectDir, state)
    renderStatus(projectDir, state)
    return { state, result }
  })
}

export function phaseMeta(id) {
  return PHASES.find((p) => p.id === id) ?? null
}

export function nextPhase(state) {
  return state.phases.find((p) => p.status === 'in_progress') ?? state.phases.find((p) => p.status === 'todo') ?? null
}

export function setPhase(state, id, status, note) {
  if (!phaseMeta(id)) throw new Error(`unknown phase "${id}" (expected one of ${PHASES.map((p) => p.id).join(', ')})`)
  if (!STATUSES.includes(status)) throw new Error(`unknown status "${status}" (expected one of ${STATUSES.join(', ')})`)
  const phase = state.phases.find((p) => p.id === id)
  phase.status = status
  if (note !== undefined) phase.note = note
  phase.updatedAt = now()
  return phase
}

export function upsertExploration(state, topic, fields) {
  if (fields.status && !EXPLORATION_STATUSES.includes(fields.status)) {
    throw new Error(`unknown exploration status "${fields.status}" (expected one of ${EXPLORATION_STATUSES.join(', ')})`)
  }
  let item = state.explorations.find((e) => e.topic === topic)
  if (!item) {
    item = { topic, arc: null, target: null, round: 0, status: 'framing', pick: null, note: '', updatedAt: null }
    state.explorations.push(item)
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) item[k] = k === 'round' ? Number(v) : v
  }
  item.updatedAt = now()
  state.explorations.sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0))
  return item
}

export function progressMarkdown(state) {
  const lines = [`_Generated from state.json by state.mjs on ${String(state.updatedAt).slice(0, 10)}. Do not edit this block by hand._`, '']
  lines.push('| Phase | Status | Progress | Run |', '|---|---|---|---|')
  for (const p of state.phases.filter(shown)) {
    const meta = phaseMeta(p.id)
    lines.push(`| ${meta.title} | ${SYMBOL[p.status]} ${LABEL[p.status]} | ${escapeCell(p.note || '')} | \`/massimo:${meta.skill}\` |`)
  }
  const next = nextPhase(state)
  lines.push('')
  lines.push(next ? `**Next phase:** ${phaseMeta(next.id).title}, with \`/massimo:${phaseMeta(next.id).skill}\`.` : '**All phases are done or skipped.** Use `/massimo:ux` to design new surfaces.')
  const open = state.explorations.filter(isOpen)
  if (state.explorations.length) {
    lines.push('', '| Exploration | Arc | Round | Status | Pick |', '|---|---|---|---|---|')
    for (const e of state.explorations) {
      lines.push(`| \`${e.topic}\` | ${e.arc ?? ''} | ${e.round || ''} | ${e.status} | ${escapeCell(e.pick ?? '')} |`)
    }
    if (open.length) lines.push('', `Open explorations continue with \`/massimo:ux ${open[0].topic}\`.`)
  }
  return lines.join('\n')
}

function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

// Replace the generated block in STATUS.md. Missing markers are inserted
// after the first paragraph so a hand-edited file heals itself.
export function renderStatus(projectDir, state) {
  const path = join(projectDir, 'STATUS.md')
  if (!existsSync(path)) return false
  const text = readFileSync(path, 'utf8')
  const block = `${PROGRESS_START}\n${progressMarkdown(state)}\n${PROGRESS_END}`
  let next
  const s = text.indexOf(PROGRESS_START)
  const e = text.indexOf(PROGRESS_END)
  if (s !== -1 && e !== -1 && e > s) {
    next = text.slice(0, s) + block + text.slice(e + PROGRESS_END.length)
  } else {
    const firstSection = text.indexOf('\n## ')
    next = firstSection === -1 ? `${text.trimEnd()}\n\n${block}\n` : `${text.slice(0, firstSection)}\n${block}\n${text.slice(firstSection)}`
  }
  if (next !== text) writeFileAtomic(path, next)
  return true
}

export function appendDecision(projectDir, { text, why, phase, by }) {
  const path = join(projectDir, 'decisions.md')
  const parts = [`- ${today()}`]
  if (phase) parts.push(phase)
  const sentence = (t) => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`)
  let line = `${parts.join(' · ')} · ${sentence(text)}`
  if (why) line += ` Why: ${sentence(why)}`
  if (by) line += ` (${by.trim()})`
  withLock(path, () => {
    if (!existsSync(path)) writeFileSync(path, '# Decisions\n\nAppend-only. Newest at the bottom.\n\n')
    appendFileSync(path, `${endsWithNewline(path) ? '' : '\n'}${line}\n`)
  })
  return line
}

// Whether a file's last byte is a newline, read without loading the file.
function endsWithNewline(path) {
  const size = statSync(path).size
  if (size === 0) return true
  const fd = openSync(path, 'r')
  try {
    const byte = Buffer.alloc(1)
    readSync(fd, byte, 0, 1, size - 1)
    return byte[0] === 10
  } finally {
    closeSync(fd)
  }
}

// One compact paragraph for the SessionStart hook: enough for a fresh
// session to know a project exists, where it stands and how to resume.
export function hookContext(state, projectRel) {
  const phases = state.phases.filter(shown).map((p) => `${p.id} ${SYMBOL[p.status]}${p.note ? ` (${p.note})` : ''}`).join(', ')
  const next = nextPhase(state)
  const open = state.explorations.filter(isOpen)
  const parts = [
    `This repo has a massimo design-system project in ${projectRel}/.`,
    `Phases: ${phases}.`,
    next ? `Next: ${next.id} via /massimo:${phaseMeta(next.id).skill}.` : 'All phases are done or skipped.',
  ]
  if (open.length) parts.push(`Open explorations: ${open.map((e) => `${e.topic} (round ${e.round}, ${e.status})`).join('; ')}.`)
  parts.push(`Before design-system or UI work, read ${projectRel}/STATUS.md. The user can resume with /massimo:start.`)
  return parts.join(' ')
}

export function hookBanner(state) {
  const next = nextPhase(state)
  const done = state.phases.filter((p) => p.status === 'done').length
  const total = state.phases.filter((p) => p.status !== 'skipped').length
  return `massimo: design-system project ${done}/${total} phases done${next ? `, next: /massimo:${phaseMeta(next.id).skill}` : ''}`
}
