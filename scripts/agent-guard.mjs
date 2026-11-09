#!/usr/bin/env node
// PreToolUse hook for file writes. An agent's tool list cannot limit a tool
// to one folder, so this keeps massimo's reviewers from writing at all and
// its ideator inside the project's explorations folder. Every other session
// and agent passes untouched, and any error lets the call through, so the
// hook can never stall work that is not massimo's.
//
// Reads the hook input on stdin; answers with a deny decision on stdout.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { helpAndExit } from './lib/help.mjs'

helpAndExit(import.meta.url)

const READ_ONLY = new Set(['reviewer', 'visual-reviewer'])
const EXPLORATIONS_ONLY = new Set(['ideator'])

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
  process.exit(0)
}

// The real path of a file that may not exist yet: its nearest existing folder,
// with symlinks followed, and the rest of the path on top.
function realTarget(path) {
  let dir = path
  const rest = []
  while (!existsSync(dir)) {
    rest.unshift(basename(dir))
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return join(realpathSync(dir), ...rest)
}

async function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const type = String(input.agent_type ?? '')
  const scoped = type.startsWith('massimo:')
  const name = scoped ? type.slice('massimo:'.length) : type
  if (!READ_ONLY.has(name) && !EXPLORATIONS_ONLY.has(name)) return
  const cwd = input.cwd || process.cwd()
  // The host may name a plugin agent without its prefix. A bare name only
  // counts in a repo with a massimo project, so another plugin's "reviewer"
  // elsewhere is left alone.
  const { findRoot, loadConfig } = await import('./lib/project.mjs')
  // A config these scripts cannot use is still a massimo project: keep guarding.
  const { exists, projectDir } = loadConfig({ root: findRoot(cwd) }, { gate: false })
  if (!scoped && !exists) return
  if (READ_ONLY.has(name)) deny(`massimo's ${name} reviews and writes nothing; return the findings instead.`)
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path
  if (typeof file !== 'string') return
  const allowed = realTarget(join(projectDir, 'explorations'))
  const target = realTarget(resolve(cwd, file))
  if (target !== allowed && !target.startsWith(allowed + sep)) {
    deny(`massimo's ideator writes only its round files, inside ${allowed}; ${file} is outside it.`)
  }
}

try {
  await main()
} catch {
  // A broken input or project file must never block a tool call.
}
process.exit(0)
