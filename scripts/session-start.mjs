#!/usr/bin/env node
// SessionStart hook. When the session opens in a repo that has a massimo
// project, tell Claude where it stands so work resumes instead of restarting.
// Silent everywhere else, and never fails a session: any error exits 0.

import { existsSync } from 'node:fs'
import { findRoot, loadConfig, rel } from './lib/project.mjs'
import { hookBanner, hookContext, loadState } from './lib/state.mjs'

try {
  const start = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const { exists, root, projectDir, refusal } = loadConfig({ root: findRoot(start) }, { gate: false })
  if (!exists || !existsSync(projectDir)) process.exit(0)
  const state = loadState(projectDir)
  if (!state) process.exit(0)
  // A config newer than these scripts: say so, and carry on.
  const banner = hookBanner(state)
  process.stdout.write(
    JSON.stringify({
      systemMessage: refusal ? `${banner}\nmassimo: ${refusal}` : banner,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `${hookContext(state, rel(root, projectDir) || '.')}${refusal ? `\n\nThe scripts cannot run here yet: ${refusal}.` : ''}`,
      },
    }),
  )
} catch {
  // A broken project file must never block a session from starting.
}
process.exit(0)
