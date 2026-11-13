#!/usr/bin/env node
// Set up a massimo project in a repo: massimo.config.json, the project
// folder with its templates and state, vendored scripts and playbooks, npm
// scripts, and a block in AGENTS.md that tells any coding agent how to run
// them. Never overwrites a file that exists; re-running is safe and reports
// what it skipped. Run from the plugin (first time) or from the vendored copy.
//
//   init.mjs [--root <dir>] [--config-json '<json overrides>'] [--update-scripts] [--no-npm-scripts] [--no-agents-file] [--dry-run]
//
// The playbooks are the plugin's skills, agents, references and templates,
// copied to <project>/playbooks/ with the scripts, so an agent with no plugin
// follows the same steps. --update-scripts refreshes both and the AGENTS.md
// block; --no-agents-file leaves AGENTS.md alone.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compare, globToRegExp } from './lib/glob.mjs'
import { parseArrayAt } from './lib/jsobject.mjs'
import { stripComments } from './lib/source.mjs'
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

// 3b. Playbooks: the plugin's skills, agents, references and templates, so an
// agent that has no plugin reads the same steps from the repo. They travel
// with the scripts: copied the first time and on --update-scripts.
const PLAYBOOK_DIRS = ['skills', 'agents', 'reference', 'templates']
const playbooksDir = join(projectDir, 'playbooks')
const refresh = !sameDir && (vendoredVersion === null || Boolean(flags['update-scripts']))
function copyTree(from, to) {
  for (const name of readdirSync(from).sort(compare)) {
    const src = join(from, name)
    if (statSync(src).isDirectory()) copyTree(src, join(to, name))
    else {
      const dest = join(to, name)
      ;(existsSync(dest) ? report.updated : report.created).push(rel(root, dest))
      if (!dry) {
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(src, dest)
      }
    }
  }
}
if (refresh) for (const dir of PLAYBOOK_DIRS) if (existsSync(join(pluginRoot, dir))) copyTree(join(pluginRoot, dir), join(playbooksDir, dir))

// 3c. AGENTS.md: where any agent starts. The block between the markers is
// massimo's; everything around it is the repo's own and is never touched.
const AGENTS_START = '<!-- massimo:agents:start -->'
const AGENTS_END = '<!-- massimo:agents:end -->'
function agentsBlock() {
  const from = existsSync(join(playbooksDir, 'skills')) ? join(playbooksDir, 'skills') : join(pluginRoot, 'skills')
  const names = existsSync(from) ? readdirSync(from).filter((n) => existsSync(join(from, n, 'SKILL.md'))).sort(compare) : []
  return [
    AGENTS_START,
    '## Design system (massimo)',
    '',
    `This repo keeps its design system with massimo, in \`${projectRel}/\`. Any coding agent can run it: the scripts are plain Node with no dependencies, and each piece of work has a playbook written as steps.`,
    '',
    `- Start with \`${projectRel}/STATUS.md\`: where the project stands and the next step.`,
    `- To run a phase or to design something, read its playbook and follow it: \`${projectRel}/playbooks/skills/<name>/SKILL.md\`${names.length > 0 ? `, where \`<name>\` is one of ${names.join(', ')}` : ''}. \`ux\` is the design loop: reviews, rounds of mockups, a pick, then a story and a handoff.`,
    `- In a playbook, \`<plugin>\` is \`${projectRel}/playbooks\`, and a script it names under \`<plugin>/scripts/\` is the same file under \`${projectRel}/scripts/\`. A \`/massimo:<name>\` command means the playbook of that name.`,
    `- Where a playbook dispatches a worker such as \`massimo:reviewer\`, start a fresh agent with \`${projectRel}/playbooks/agents/<name>.md\` as its instructions if your tool can; otherwise follow that file yourself, one worker at a time. A reviewer writes nothing, and the ideator writes only under \`${projectRel}/explorations/\`.`,
    '- Where a playbook names a tool your host lacks (a question prompt, a browser pane), do the same job in plain text: ask in words, give the URL to open.',
    `- \`node ${projectRel}/scripts/check.mjs\` runs every check CI runs.`,
    AGENTS_END,
  ].join('\n')
}
if (refresh && !flags['no-agents-file']) {
  const agentsPath = join(root, 'AGENTS.md')
  const current = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : null
  const block = agentsBlock()
  let next
  if (current === null) next = `# Agents\n\n${block}\n`
  else {
    const s = current.indexOf(AGENTS_START)
    const e = current.indexOf(AGENTS_END)
    next = s !== -1 && e > s ? current.slice(0, s) + block + current.slice(e + AGENTS_END.length) : `${current.trimEnd()}\n\n${block}\n`
  }
  if (next === current) report.skipped.push('AGENTS.md (the massimo block is current)')
  else {
    ;(current === null ? report.created : report.updated).push('AGENTS.md')
    if (!dry) writeFileSync(agentsPath, next)
  }
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

// 5. A format check over the whole repo would flag the vendored scripts and
// the files massimo writes in its own format: the project folder, and the
// config, which init and adopt write whole. When the repo checks its
// formatting and its ignore patterns leave either in, name what to add; write
// nothing.
const PRETTIER_CONFIGS = ['.prettierrc', ...['json', 'json5', 'yaml', 'yml', 'toml', 'js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].map((e) => `.prettierrc.${e}`), ...['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].map((e) => `prettier.config.${e}`)]

// The tools a format check runs, known by the command that runs one, each
// with the config files that hold its ignore patterns and the key they sit
// under.
const FORMAT_TOOLS = [
  { tool: 'prettier', check: /\bprettier\b[^\n;&|]*\s(?:--check|-c|--list-different|-l)\b/ },
  { tool: 'biome', check: /\bbiome\s+(?:ci|check|format)\b(?![^\n;&|]*\s--(?:write|fix|apply)\b)/, configs: ['biome.json', 'biome.jsonc'], key: 'files' },
  { tool: 'dprint', check: /\bdprint\s+check\b/, configs: ['dprint.json', 'dprint.jsonc', '.dprint.json', '.dprint.jsonc'], key: 'excludes' },
  { tool: 'oxfmt', check: /\boxfmt\b[^\n;&|]*\s--check\b/, configs: ['.oxfmtrc.json', '.oxfmtrc.jsonc'], key: 'ignorePatterns' },
]
// A package script by the name a format check usually has.
const FORMAT_SCRIPT = /^(?:format|fmt)[:-]check$|^check[:-](?:format|fmt)$/
// A package script a command runs.
const RUNS_SCRIPT = /\b(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun run)\s+([\w:.-]+)/g

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

// Whether a tool's config names `path` in its patterns: a string that, without
// a leading "!", "./", "/" or "**/" and a trailing "/", "/**" or "/**/*", is
// the path or a folder above it.
function namedIn(text, path) {
  return (text.match(/"(?:\\.|[^"\\])*"/g) ?? []).some((s) => {
    const p = s.slice(1, -1).replace(/^!/, '').replace(/^(?:\.\/|\/|\*\*\/)+/, '').replace(/\/(?:\*\*(?:\/\*)?)?$/, '')
    return p !== '' && (path === p || path.startsWith(`${p}/`))
  })
}

// The format checks CI runs from each folder: a tool a workflow runs itself
// counts at the top of the checkout, and one a package script it runs calls
// (or a script that one runs) counts in the folder whose package.json holds
// the script. A script named as a format check whose tool is none of the
// known ones is kept by name.
function ciFormatChecks(dirs, top, pkgs, workflowText) {
  const checks = new Map(dirs.map((d) => [d, { tools: new Set(), scripts: new Set() }]))
  for (const t of FORMAT_TOOLS) if (t.check.test(workflowText)) checks.get(top).tools.add(t.tool)
  for (const dir of dirs) {
    const scripts = pkgs.get(dir).scripts ?? {}
    const seen = new Set()
    const follow = (cmd, depth) => {
      for (const [, name] of cmd.matchAll(RUNS_SCRIPT)) {
        if (seen.has(name) || typeof scripts[name] !== 'string') continue
        seen.add(name)
        const tools = FORMAT_TOOLS.filter((t) => t.check.test(scripts[name])).map((t) => t.tool)
        for (const tool of tools) checks.get(dir).tools.add(tool)
        if (tools.length === 0 && FORMAT_SCRIPT.test(name)) checks.get(dir).scripts.add(name)
        if (depth < 3) follow(scripts[name], depth + 1)
      }
    }
    follow(workflowText, 0)
  }
  return checks
}

// The folder that holds the project and the top of its checkout, real paths;
// `dirs` is both, the root first.
function checkoutDirs() {
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const rootDir = real(root)
  let top = rootDir
  try {
    top = real(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: rootDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim())
  } catch {
    // not a git checkout: the root alone
  }
  return { rootDir, top, dirs: [...new Set([rootDir, top])] }
}

function formatWarnings() {
  const { rootDir, top, dirs } = checkoutDirs()
  const pkgs = new Map(
    dirs.map((dir) => {
      try {
        return [dir, readJson(join(dir, 'package.json'), {}) ?? {}]
      } catch {
        // an unreadable package.json says nothing about formatting
        return [dir, {}]
      }
    }),
  )
  let workflowText = ''
  try {
    const workflows = join(top, '.github', 'workflows')
    workflowText = readdirSync(workflows)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => readFileSync(join(workflows, f), 'utf8'))
      .join('\n')
  } catch {
    // no workflows
  }
  const ci = ciFormatChecks(dirs, top, pkgs, workflowText)
  const out = []
  for (const dir of dirs) {
    const pkg = pkgs.get(dir)
    // What massimo writes in its own format, as paths from this folder, and
    // the files that stand for each when a pattern is tested.
    const folder = rel(dir, join(rootDir, projectRel))
    if (!folder || folder.startsWith('..')) continue
    const configFile = rel(dir, join(rootDir, CONFIG_FILE))
    const own = [
      { name: `${folder}/`, line: `/${folder}/`, probes: [`${folder}/scripts/init.mjs`, `${folder}/STATUS.md`] },
      { name: configFile, line: `/${configFile}`, probes: [configFile] },
    ]
    const { tools, scripts } = ci.get(dir)
    const usesPrettier =
      tools.has('prettier') ||
      PRETTIER_CONFIGS.some((f) => existsSync(join(dir, f))) ||
      Object.hasOwn(pkg, 'prettier') ||
      Object.hasOwn({ ...pkg.dependencies, ...pkg.devDependencies }, 'prettier') ||
      Object.values(pkg.scripts ?? {}).some((cmd) => /\bprettier\b/.test(String(cmd))) ||
      (dir === top && /\bprettier\b/.test(workflowText))
    if (usesPrettier) {
      const ignoreFile = join(dir, '.prettierignore')
      const lines = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8').split(/\r?\n/) : []
      const left = own.filter((o) => !o.probes.every((p) => ignoredBy(lines, p)))
      const shown = rel(rootDir, ignoreFile)
      if (left.length > 0) {
        out.push(
          `this repo checks its formatting with prettier and ${shown} does not cover ${left.map((o) => o.name).join(' or ')}, so a format check would flag the vendored scripts and the files massimo writes in its own format; add ${left.length === 1 ? 'the line' : 'the lines'} ${left.map((o) => `"${o.line}"`).join(' and ')} to ${shown}`,
        )
      }
    }
    for (const t of FORMAT_TOOLS) {
      if (t.tool === 'prettier' || !tools.has(t.tool)) continue
      const config = t.configs.find((f) => existsSync(join(dir, f)))
      let text = ''
      try {
        if (config) text = readFileSync(join(dir, config), 'utf8')
      } catch {
        // an unreadable config leaves nothing out
      }
      const left = own.filter((o) => !o.probes.every((p) => namedIn(text, p))).map((o) => o.name)
      if (left.length === 0) continue
      const shown = config ? rel(rootDir, join(dir, config)) : null
      out.push(
        shown
          ? `this repo checks its formatting with ${t.tool} in CI and ${shown} does not leave out ${left.join(' or ')}, so the check would flag the vendored scripts and the files massimo writes in its own format; leave ${left.join(' and ')} out with the ${t.key} setting in ${shown}`
          : `this repo checks its formatting with ${t.tool} in CI, so the check would flag the vendored scripts and the files massimo writes in its own format; leave ${left.join(' and ')} out of what it checks`,
      )
    }
    // A check by a tool not known here: say what it must leave out.
    if (!usesPrettier && tools.size === 0) {
      for (const name of [...scripts].sort(compare)) {
        out.push(`this repo checks its formatting in CI with the script ${name}, which may flag the vendored scripts and the files massimo writes in its own format; leave ${own.map((o) => o.name).join(' and ')} out of what it checks`)
      }
    }
  }
  return out
}
report.warnings.push(...formatWarnings())

// 6. ESLint over the project folder would lint the vendored scripts, which
// keep massimo's own style. When a folder runs ESLint (eslint is a dependency
// of its package, or one of its package scripts runs eslint) and the flat
// config ESLint finds from there leaves the project folder in, name the
// ignore to add; write nothing.
const ESLINT_CONFIGS = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map((e) => `eslint.config.${e}`)
// A command that runs eslint.
const RUNS_ESLINT = /(?:^|[\s;&|(])eslint(?=$|[\s;&|)])/

// The ignore patterns a flat config lists as literals, in order: each
// `ignores` array and each globalIgnores() call.
function eslintIgnores(text, file) {
  const code = stripComments(text, file)
  const out = []
  for (const m of code.matchAll(/(?:(?<![\w$])["']?ignores["']?\s*:|\bglobalIgnores\s*\()\s*(?=\[)/g)) {
    for (const p of parseArrayAt(code, m.index + m[0].length) ?? []) if (typeof p === 'string') out.push(p)
  }
  return out
}

// Whether flat config ignore patterns, read from the config's folder, leave
// `path` out: a pattern matches the path or a folder above it, the last one
// that matches decides, and "!" takes a path back in.
function eslintIgnored(patterns, path) {
  const parts = path.split('/')
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'))
  let ignored = false
  for (const raw of patterns) {
    const negate = raw.startsWith('!')
    const pattern = (negate ? raw.slice(1) : raw).replace(/^(?:\.\/|\/)+/, '').replace(/\/+$/, '')
    if (!pattern) continue
    const re = globToRegExp(pattern)
    if (prefixes.some((p) => re.test(p))) ignored = !negate
  }
  return ignored
}

function eslintWarnings() {
  const { rootDir, top, dirs } = checkoutDirs()
  const out = []
  const seen = new Set()
  for (const dir of dirs) {
    let pkg = {}
    try {
      pkg = readJson(join(dir, 'package.json'), {}) ?? {}
    } catch {
      // an unreadable package.json says nothing about linting
    }
    const scripts = Object.entries(pkg.scripts ?? {}).filter(([, cmd]) => RUNS_ESLINT.test(String(cmd))).map(([name]) => name).sort(compare)
    const dependency = Object.hasOwn({ ...pkg.dependencies, ...pkg.devDependencies }, 'eslint')
    if (!dependency && scripts.length === 0) continue
    // The flat config ESLint finds from this folder: the nearest one up to the top of the checkout.
    let configDir = dir
    let config = null
    for (;;) {
      config = ESLINT_CONFIGS.find((f) => existsSync(join(configDir, f))) ?? null
      if (config || configDir === top || dirname(configDir) === configDir) break
      configDir = dirname(configDir)
    }
    if (!config) continue
    const path = join(configDir, config)
    if (seen.has(path)) continue
    seen.add(path)
    const folder = rel(configDir, join(rootDir, projectRel))
    if (!folder || folder.startsWith('..')) continue
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    if (eslintIgnored(eslintIgnores(text, config), `${folder}/scripts/init.mjs`)) continue
    const why = [...(dependency ? ['eslint is a dependency'] : []), ...(scripts.length > 0 ? [`${scripts.length === 1 ? 'the script' : 'the scripts'} ${scripts.join(', ')} ${scripts.length === 1 ? 'runs' : 'run'} it`] : [])].join(' and ')
    const shown = rel(rootDir, path)
    out.push(`this repo lints with ESLint (${why}) and ${shown} does not ignore ${folder}/, so a lint would flag the vendored scripts, which keep massimo's own style; add { ignores: ["${folder}/**"] } as its own entry in ${shown}`)
  }
  return out
}
report.warnings.push(...eslintWarnings())

report.projectDir = projectRel
report.framework = config.framework
report.scriptsVersion = SCRIPTS_VERSION
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
