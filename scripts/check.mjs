#!/usr/bin/env node
// ds:check: every massimo check that applies to this project, then the
// project's own, one line each, and exit 1 when any failed. It is what CI
// runs, so a check added here reaches every project on its next update.
//
//   graph    graph.mjs --check, always
//   stories  stories.mjs --check, when stories.lane is "csf"
//   audit    audit.mjs --check, when audits/baseline.json exists
//   tokens   tokens.mjs check, when the token set exists
//   docs     docs.mjs --check, when <project>/README.md has the massimo:docs markers
//   then each guard.extraChecks entry, { name, run }, run through a shell
//   from the repo root
//
// Usage:
//   node <project>/scripts/check.mjs
// Shared flags: --root <dir> --config <file> --project-dir <dir>

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOCS_START } from './docs.mjs'
import { fail, loadConfig, parseArgs, rel, scriptCommand, warnIfVendoredOlder } from './lib/project.mjs'
import { helpAndExit } from './lib/help.mjs'

helpAndExit(import.meta.url)

const here = dirname(fileURLToPath(import.meta.url))

// The checks for this project, in order: { name, command, args } for a
// massimo script, { name, shell } for a project command, or { name, skip }
// with the reason it does not apply, or { name, problem } for a bad entry.
export function checksFor({ root, config, projectDir }) {
  const script = (name, file, args) => ({ name, script: file, args, command: scriptCommand(root, projectDir, file, args.join(' ')) })
  const readme = join(projectDir, 'README.md')
  const checks = [
    script('graph', 'graph', ['--check']),
    ...(config.stories?.lane === 'csf' ? [script('stories', 'stories', ['--check'])] : []),
    existsSync(join(projectDir, 'audits', 'baseline.json')) ? script('audit', 'audit', ['--check']) : { name: 'audit', skip: 'no audit baseline yet' },
    existsSync(join(root, config.tokens.source)) ? script('tokens', 'tokens', ['check']) : { name: 'tokens', skip: 'no token set yet' },
    existsSync(readme) && readFileSync(readme, 'utf8').includes(DOCS_START) ? script('docs', 'docs', ['--check']) : { name: 'docs', skip: 'no generated README yet' },
  ]
  const extra = config.guard?.extraChecks ?? []
  ;(Array.isArray(extra) ? extra : [extra]).forEach((c, i) => {
    if (c && typeof c.name === 'string' && c.name.trim() && typeof c.run === 'string' && c.run.trim()) checks.push({ name: c.name.trim(), shell: c.run, command: c.run })
    else checks.push({ name: `guard.extraChecks[${i}]`, problem: 'needs a name and a run command, as { "name": "...", "run": "..." }' })
  })
  return checks
}

// Run one check from the repo root: its exit status and what it printed. A
// massimo script gets the same root, config and project folder as this run.
function runCheck(check, { root, configPath, projectDir, flags }) {
  const shared = ['--root', root, ...(flags.config ? ['--config', configPath] : []), ...(flags['project-dir'] ? ['--project-dir', projectDir] : [])]
  const r = check.shell
    ? spawnSync(check.shell, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : spawnSync(process.execPath, [join(here, `${check.script}.mjs`), ...check.args, ...shared], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `${r.error.message}\n` : ''}`
  return { ok: r.status === 0, output }
}

function main() {
  const { flags } = parseArgs()
  const { root, configPath, config, projectDir } = loadConfig(flags)
  warnIfVendoredOlder(projectDir, import.meta.url)
  const checks = checksFor({ root, config, projectDir })
  const width = Math.max(...checks.map((c) => c.name.length))
  let ran = 0
  let failed = 0
  for (const check of checks) {
    const name = check.name.padEnd(width)
    if (check.skip) {
      process.stdout.write(`skip  ${name}  ${check.skip}\n`)
      continue
    }
    ran++
    if (check.problem) {
      failed++
      process.stdout.write(`fail  ${name}  ${check.problem}\n`)
      continue
    }
    const { ok, output } = runCheck(check, { root, configPath, projectDir, flags })
    if (!ok) failed++
    process.stdout.write(`${ok ? 'pass' : 'fail'}  ${name}  ${check.command}\n`)
    if (!ok) for (const line of output.trimEnd().split('\n')) process.stdout.write(`      ${line}\n`)
  }
  const where = rel(root, projectDir) || '.'
  process.stdout.write(failed > 0 ? `massimo check: ${failed} of ${ran} checks failed (${where})\n` : `massimo check: ${ran} ${ran === 1 ? 'check' : 'checks'} passed (${where})\n`)
  if (failed > 0) process.exit(1)
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (entry === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}
