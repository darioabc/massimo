// Project state: the phase list, explorations, the generated progress block
// in STATUS.md, and the decision log. state.mjs is the CLI over this; the
// SessionStart hook reads it to tell a new session where the project stands.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCRIPTS_VERSION, today } from './project.mjs'

export const PHASES = [
  { id: 'setup', title: 'Set up the project', skill: 'start' },
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

const SYMBOL = { done: '✓', in_progress: '◐', todo: '○', skipped: '–' }
const LABEL = { done: 'done', in_progress: 'in progress', todo: 'to do', skipped: 'skipped' }

export const PROGRESS_START = '<!-- massimo:progress:start -->'
export const PROGRESS_END = '<!-- massimo:progress:end -->'

export function emptyState() {
  return {
    version: 1,
    massimo: SCRIPTS_VERSION,
    createdAt: today(),
    updatedAt: today(),
    phases: PHASES.map((p) => ({ id: p.id, status: 'todo', note: '', updatedAt: null })),
    explorations: [],
  }
}

export function statePath(projectDir) {
  return join(projectDir, 'state.json')
}

// Missing phases are added as `todo` in canonical order, so a project made
// by an older version keeps working after the phase list grows.
export function loadState(projectDir) {
  const path = statePath(projectDir)
  if (!existsSync(path)) return null
  const state = JSON.parse(readFileSync(path, 'utf8'))
  const byId = new Map((state.phases ?? []).map((p) => [p.id, p]))
  state.phases = PHASES.map((p) => byId.get(p.id) ?? { id: p.id, status: 'todo', note: '', updatedAt: null })
  state.explorations ??= []
  return state
}

export function saveState(projectDir, state) {
  state.updatedAt = today()
  state.massimo = SCRIPTS_VERSION
  writeFileSync(statePath(projectDir), `${JSON.stringify(state, null, 2)}\n`)
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
  phase.updatedAt = today()
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
  item.updatedAt = today()
  state.explorations.sort((a, b) => a.topic.localeCompare(b.topic))
  return item
}

export function progressMarkdown(state) {
  const lines = [`_Generated from state.json by state.mjs on ${state.updatedAt}. Do not edit this block by hand._`, '']
  lines.push('| Phase | Status | Progress | Run |', '|---|---|---|---|')
  for (const p of state.phases) {
    const meta = phaseMeta(p.id)
    lines.push(`| ${meta.title} | ${SYMBOL[p.status]} ${LABEL[p.status]} | ${escapeCell(p.note || '')} | \`/massimo:${meta.skill}\` |`)
  }
  const next = nextPhase(state)
  lines.push('')
  lines.push(next ? `**Next phase:** ${phaseMeta(next.id).title}, with \`/massimo:${phaseMeta(next.id).skill}\`.` : '**All phases are done or skipped.** Use `/massimo:ux` to design new surfaces.')
  const open = state.explorations.filter((e) => !['built', 'parked'].includes(e.status))
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
  if (next !== text) writeFileSync(path, next)
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
  if (!existsSync(path)) writeFileSync(path, '# Decisions\n\nAppend-only. Newest at the bottom.\n\n')
  const current = readFileSync(path, 'utf8')
  appendFileSync(path, `${current.endsWith('\n') ? '' : '\n'}${line}\n`)
  return line
}

// One compact paragraph for the SessionStart hook: enough for a fresh
// session to know a project exists, where it stands and how to resume.
export function hookContext(state, projectRel) {
  const phases = state.phases.map((p) => `${p.id} ${SYMBOL[p.status]}${p.note ? ` (${p.note})` : ''}`).join(', ')
  const next = nextPhase(state)
  const open = state.explorations.filter((e) => !['built', 'parked', 'handed-off'].includes(e.status))
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
