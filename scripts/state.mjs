#!/usr/bin/env node
// Read and update the design-system project's state, so every skill records
// progress the same way and the next session can resume from it.
//
//   state.mjs show [--json]
//   state.mjs next [--json]
//   state.mjs set <phase> <todo|in_progress|done|skipped> [--note "18/40 storied"]
//   state.mjs decide "<decision>" [--why "<reason>"] [--phase <id>] [--by <name>]
//   state.mjs explore <topic> [--arc review|ideate] [--target <surface>] [--round N] [--status <s>] [--pick <file>] [--note "…"]
//   state.mjs render
//
// Shared flags: --root, --config, --project-dir.

import { fail, loadConfig, parseArgs, rel } from './lib/project.mjs'
import {
  appendDecision,
  loadState,
  nextPhase,
  phaseMeta,
  progressMarkdown,
  renderStatus,
  setPhase,
  updateState,
  upsertExploration,
} from './lib/state.mjs'
import { helpAndExit } from './lib/help.mjs'

helpAndExit(import.meta.url)

const { _: args, flags } = parseArgs()
const [command = 'show', ...rest] = args
const { root, projectDir } = loadConfig(flags)
const projectRel = rel(root, projectDir) || '.'

const state = loadState(projectDir)
if (!state) fail(`no project at ${projectRel}/state.json. Run /massimo:start to set one up.`, 2)

const str = (v) => (v === undefined || v === true ? undefined : String(v))

switch (command) {
  case 'show': {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
      break
    }
    process.stdout.write(`Project: ${projectRel}/ (massimo ${state.massimo}, updated ${state.updatedAt})\n\n`)
    process.stdout.write(`${progressMarkdown(state)}\n`)
    break
  }
  case 'next': {
    const next = nextPhase(state)
    const out = next ? { phase: next.id, status: next.status, skill: phaseMeta(next.id).skill, note: next.note } : { phase: null }
    process.stdout.write(flags.json ? `${JSON.stringify(out)}\n` : next ? `${out.phase} (${out.status}) → /massimo:${out.skill}\n` : 'all phases done or skipped\n')
    break
  }
  case 'set': {
    const [phase, status] = rest
    if (!phase || !status) fail('usage: state.mjs set <phase> <status> [--note "…"]')
    try {
      updateState(projectDir, (s) => setPhase(s, phase, status, str(flags.note)))
    } catch (e) {
      fail(e.message)
    }
    process.stdout.write(`${phase}: ${status}${flags.note ? ` (${flags.note})` : ''}\n`)
    break
  }
  case 'decide': {
    const text = rest.join(' ')
    if (!text) fail('usage: state.mjs decide "<decision>" [--why "<reason>"] [--phase <id>] [--by <name>]')
    const line = appendDecision(projectDir, { text, why: str(flags.why), phase: str(flags.phase), by: str(flags.by) })
    process.stdout.write(`${line}\n`)
    break
  }
  case 'explore': {
    const [topic] = rest
    if (!topic || !/^[a-z0-9][a-z0-9-]*$/.test(topic)) fail('usage: state.mjs explore <kebab-case-topic> [--arc …] [--round N] [--status …] [--pick …]')
    try {
      const { result: item } = updateState(projectDir, (s) =>
        upsertExploration(s, topic, {
          arc: str(flags.arc),
          target: str(flags.target),
          round: str(flags.round),
          status: str(flags.status),
          pick: str(flags.pick),
          note: str(flags.note),
        }),
      )
      process.stdout.write(`${JSON.stringify(item)}\n`)
    } catch (e) {
      fail(e.message)
    }
    break
  }
  case 'render': {
    renderStatus(projectDir, state) ? process.stdout.write(`refreshed ${projectRel}/STATUS.md\n`) : fail(`${projectRel}/STATUS.md not found`)
    break
  }
  default:
    fail(`unknown command "${command}". Commands: show, next, set, decide, explore, render.`)
}
