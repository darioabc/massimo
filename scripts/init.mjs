#!/usr/bin/env node
// Set up a massimo project in a repo: massimo.config.json, the project
// folder with its templates and state, vendored scripts, and npm scripts.
// Never overwrites a file that exists; re-running is safe and reports what
// it skipped. Run from the plugin (first time) or from the vendored copy.
//
//   init.mjs [--root <dir>] [--config-json '<json overrides>'] [--update-scripts] [--no-npm-scripts] [--dry-run]

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_FILE, SCRIPTS_VERSION, deepMerge, fail, findRoot, loadConfig, parseArgs, readJson, rel, vendoredVersion as vendoredVersionOf } from './lib/project.mjs'
import { emptyState, renderStatus, saveState, setPhase } from './lib/state.mjs'

const { flags } = parseArgs()
const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const root = flags.root ? resolve(flags.root) : findRoot()
const dry = Boolean(flags['dry-run'])
const report = { root, created: [], updated: [], skipped: [], warnings: [] }

function write(path, content, { overwrite = false } = {}) {
  const shown = rel(root, path)
  if (existsSync(path) && !overwrite) {
    report.skipped.push(shown)
    return false
  }
  ;(existsSync(path) ? report.updated : report.created).push(shown)
  if (!dry) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return true
}

// 1. Config: detect's suggestion, with the caller's overrides on top.
const configPath = join(root, CONFIG_FILE)
if (!existsSync(configPath)) {
  let suggested = {}
  try {
    const out = execFileSync(process.execPath, [join(here, 'detect.mjs'), '--root', root], { stdio: ['ignore', 'pipe', 'pipe'] })
    suggested = JSON.parse(out.toString()).suggestedConfig
  } catch (e) {
    report.warnings.push(`detect failed, using defaults: ${e.message.split('\n')[0]}`)
  }
  let overrides = {}
  if (typeof flags['config-json'] === 'string') {
    try {
      overrides = JSON.parse(flags['config-json'])
    } catch (e) {
      fail(`--config-json is not valid JSON: ${e.message}`)
    }
  }
  write(configPath, `${JSON.stringify(deepMerge(suggested, overrides), null, 2)}\n`)
} else {
  report.skipped.push(CONFIG_FILE)
}

const { projectDir, config } = loadConfig({ root })
const projectRel = rel(root, projectDir)

// 2. Project folder and templates.
const templates = join(pluginRoot, 'templates')
for (const name of ['STATUS.md', 'product.md', 'decisions.md']) {
  const src = join(templates, name)
  if (!existsSync(src)) {
    report.warnings.push(`template ${name} missing from the plugin`)
    continue
  }
  write(join(projectDir, name), readFileSync(src, 'utf8').replaceAll('{{projectDir}}', projectRel))
}
write(
  join(projectDir, '.gitignore'),
  '# Screenshots are cheap to regenerate and heavy to keep, except the ones a\n# committed handoff, brief or baseline links to, which go in shots/kept/.\nshots/*\n!shots/kept/\n# Left by a run that stopped mid-write.\n*.lock\n*.tmp\n',
)
// A project made before 0.2.0 ignores every screenshot, so a handoff's links go dead for teammates.
const ignoreFile = join(projectDir, '.gitignore')
if (existsSync(ignoreFile) && /^shots\/\s*$/m.test(readFileSync(ignoreFile, 'utf8'))) {
  report.warnings.push(`${projectRel}/.gitignore ignores all of shots/; replace that line with "shots/*" and "!shots/kept/" so screenshots a handoff links to are committed`)
}
// Two branches that both log a decision merge by keeping both lines.
write(join(projectDir, '.gitattributes'), 'decisions.md merge=union\n')
for (const dir of ['explorations', 'handoffs', 'audits', 'tokens', 'kit']) {
  if (!dry) mkdirSync(join(projectDir, dir), { recursive: true })
}

if (!existsSync(join(projectDir, 'state.json'))) {
  const state = emptyState()
  setPhase(state, 'setup', 'in_progress', 'config and project folder created')
  report.created.push(`${projectRel}/state.json`)
  if (!dry) {
    saveState(projectDir, state)
    renderStatus(projectDir, state)
  }
} else {
  report.skipped.push(`${projectRel}/state.json`)
}

// 3. Vendored scripts, so CI and teammates without the plugin can run them.
const vendorDir = join(projectDir, 'scripts')
const vendoredVersion = vendoredVersionOf(projectDir)
const sameDir = resolve(vendorDir) === resolve(here)
if (sameDir) {
  report.warnings.push('running from the vendored copy: scripts were not refreshed (run the plugin copy with --update-scripts to update)')
} else if (vendoredVersion === null || flags['update-scripts']) {
  for (const sub of ['', 'lib']) {
    const from = join(here, sub)
    for (const name of readdirSync(from)) {
      if (!name.endsWith('.mjs')) continue
      const to = join(vendorDir, sub, name)
      ;(existsSync(to) ? report.updated : report.created).push(rel(root, to))
      if (!dry) {
        mkdirSync(dirname(to), { recursive: true })
        copyFileSync(join(from, name), to)
      }
    }
  }
} else if (vendoredVersion !== SCRIPTS_VERSION) {
  report.warnings.push(`vendored scripts are ${vendoredVersion}, the plugin has ${SCRIPTS_VERSION}: re-run init with --update-scripts`)
} else {
  report.skipped.push(`${projectRel}/scripts (already ${SCRIPTS_VERSION})`)
}

// 4. npm scripts. Phases add their own later (ds:stories, ds:tokens, ds:check).
const pkgPath = join(root, 'package.json')
if (!flags['no-npm-scripts'] && !existsSync(pkgPath)) {
  report.warnings.push(`no package.json, so no npm scripts were added; run the scripts with node, for example node ${projectRel}/scripts/serve.mjs`)
} else if (!flags['no-npm-scripts']) {
  const text = readFileSync(pkgPath, 'utf8')
  const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? '  '
  const pkg = readJson(pkgPath, {})
  pkg.scripts ??= {}
  const wanted = {
    'ds:graph': `node ${projectRel}/scripts/graph.mjs`,
    'ds:audit': `node ${projectRel}/scripts/audit.mjs`,
    'ds:serve': `node ${projectRel}/scripts/serve.mjs`,
  }
  let changed = false
  for (const [k, v] of Object.entries(wanted)) {
    if (pkg.scripts[k]) {
      if (pkg.scripts[k] !== v) report.warnings.push(`package.json already has a different "${k}" script; left it alone`)
      continue
    }
    pkg.scripts[k] = v
    changed = true
  }
  if (changed) {
    report.updated.push('package.json (scripts: ds:graph, ds:audit, ds:serve)')
    if (!dry) writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`)
  }
}

report.projectDir = projectRel
report.framework = config.framework
report.scriptsVersion = SCRIPTS_VERSION
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
