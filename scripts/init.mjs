#!/usr/bin/env node
// Set up a massimo project in a repo: massimo.config.json, the project
// folder with its templates and state, vendored scripts, and npm scripts.
// Never overwrites a file that exists; re-running is safe and reports what
// it skipped. Run from the plugin (first time) or from the vendored copy.
//
//   init.mjs [--root <dir>] [--config-json '<json overrides>'] [--update-scripts] [--no-npm-scripts] [--dry-run]

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globToRegExp } from './lib/glob.mjs'
import { CONFIG_FILE, DEFAULTS, SCRIPTS_VERSION, deepMerge, fail, findRoot, loadConfig, parseArgs, readJson, rel, vendoredVersion as vendoredVersionOf } from './lib/project.mjs'
import { emptyState, renderStatus, saveState, setPhase } from './lib/state.mjs'
import { helpAndExit } from './lib/help.mjs'

helpAndExit(import.meta.url)

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

// detect's report, run once when something needs it; null when it fails.
let detected
function detect() {
  if (detected !== undefined) return detected
  try {
    const out = execFileSync(process.execPath, [join(here, 'detect.mjs'), '--root', root], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    detected = JSON.parse(out.toString())
  } catch (e) {
    report.warnings.push(`detect failed, using defaults: ${e.message.split('\n')[0]}`)
    detected = null
  }
  return detected
}

// 1. Config: detect's suggestion, with the caller's overrides on top.
const configPath = join(root, CONFIG_FILE)
let planned = null
if (!existsSync(configPath)) {
  const suggested = detect()?.suggestedConfig ?? {}
  let overrides = {}
  if (typeof flags['config-json'] === 'string') {
    try {
      overrides = JSON.parse(flags['config-json'])
    } catch (e) {
      fail(`--config-json is not valid JSON: ${e.message}`)
    }
  }
  planned = deepMerge(suggested, overrides)
  write(configPath, `${JSON.stringify(planned, null, 2)}\n`)
} else {
  report.skipped.push(CONFIG_FILE)
}

// A dry run writes no config, so it reports from the config it would write.
function plannedConfig(raw) {
  const config = deepMerge(structuredClone(DEFAULTS), raw)
  return { config, projectDir: isAbsolute(config.projectDir) ? config.projectDir : join(root, config.projectDir) }
}
const { projectDir, config } = dry && planned ? plannedConfig(planned) : loadConfig({ root })
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
  // The adopt phase is to do only when the repo has a setup of its own.
  const adoptable = detect()?.adoptable ?? []
  if (adoptable.length > 0) {
    setPhase(state, 'adopt', 'todo', `found ${[...new Set(adoptable.map((a) => a.kind))].join(', ')}; start with /massimo:adopt`)
    report.adoptable = adoptable
  }
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

// 5. A prettier check over the whole repo would flag the vendored scripts and
// the files massimo writes in the project folder, which keep massimo's own
// format. When the repo checks its formatting with prettier and its ignore
// file does not cover the project folder, name the line to add; write nothing.
const PRETTIER_CONFIGS = ['.prettierrc', ...['json', 'json5', 'yaml', 'yml', 'toml', 'js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].map((e) => `.prettierrc.${e}`), ...['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].map((e) => `prettier.config.${e}`)]

// Whether a list of ignore patterns, as .prettierignore holds them (the
// .gitignore syntax), leaves `path` out: the last pattern that matches the
// path or a folder above it decides, and `!` takes a path back in.
function ignoredBy(lines, path) {
  const parts = path.split('/')
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'))
  let ignored = false
  for (const raw of lines) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const negate = line.startsWith('!')
    if (negate) line = line.slice(1)
    line = line.replace(/\/+$/, '')
    // A pattern with a slash is read from the ignore file's folder; one
    // without matches a name at any depth.
    const anchored = line.includes('/')
    const re = globToRegExp(line.replace(/^\/+/, ''))
    if (prefixes.some((p) => re.test(anchored ? p : p.slice(p.lastIndexOf('/') + 1)))) ignored = !negate
  }
  return ignored
}

function prettierWarnings() {
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const here = real(root)
  let top = here
  try {
    top = real(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim())
  } catch {
    // not a git checkout: the root alone
  }
  const out = []
  for (const dir of [...new Set([here, top])]) {
    let pkg = {}
    try {
      pkg = readJson(join(dir, 'package.json'), {}) ?? {}
    } catch {
      // an unreadable package.json says nothing about prettier
    }
    const workflows = join(dir, '.github', 'workflows')
    const ci = dir === top && existsSync(workflows) && readdirSync(workflows).some((f) => /\.ya?ml$/.test(f) && /\bprettier\b/.test(readFileSync(join(workflows, f), 'utf8')))
    const script = Object.values(pkg.scripts ?? {}).some((cmd) => /\bprettier\b/.test(String(cmd)))
    const uses = PRETTIER_CONFIGS.some((f) => existsSync(join(dir, f))) || Object.hasOwn(pkg, 'prettier') || Object.hasOwn({ ...pkg.dependencies, ...pkg.devDependencies }, 'prettier') || script || ci
    if (!uses) continue
    const folder = rel(dir, join(here, projectRel))
    if (!folder || folder.startsWith('..')) continue
    const ignoreFile = join(dir, '.prettierignore')
    const lines = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8').split(/\r?\n/) : []
    if (['scripts/init.mjs', 'STATUS.md'].every((f) => ignoredBy(lines, `${folder}/${f}`))) continue
    const shown = rel(here, ignoreFile)
    out.push(`this repo checks its formatting with prettier and ${shown} does not cover ${folder}/, so a format check would flag the vendored scripts and the files massimo writes there; add the line "${folder}/" to ${shown}`)
  }
  return out
}
report.warnings.push(...prettierWarnings())

report.projectDir = projectRel
report.framework = config.framework
report.scriptsVersion = SCRIPTS_VERSION
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
