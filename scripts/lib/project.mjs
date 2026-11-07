// Shared plumbing for every massimo script: find the repo root, load
// massimo.config.json merged over the defaults, resolve the project dir,
// and parse the few CLI flags every script shares.
//
// Zero dependencies on purpose. These scripts get vendored into the target
// repo (design-system/scripts/) so CI and teammates without the plugin can
// run them, and a vendored script must not drag a dependency tree with it.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const CONFIG_FILE = 'massimo.config.json'
export const SCRIPTS_VERSION = '0.1.1'

export const DEFAULTS = {
  version: 1,
  projectDir: 'design-system',
  framework: 'unknown',
  packageManager: 'npm',
  styling: [],
  components: {
    include: ['src/components/**/*.{tsx,jsx,ts,js,vue,svelte,astro}'],
    exclude: ['**/*.test.*', '**/*.spec.*', '**/*.stories.*', '**/*.story.*', '**/__tests__/**', '**/*.d.ts'],
  },
  consumers: ['src/**/*.{tsx,jsx,ts,js,mjs,vue,svelte,astro}'],
  aliases: {},
  stories: {
    lane: 'native',
    include: ['src/**/*.story.{tsx,jsx,ts,js,vue,svelte,astro}'],
    devCommand: null,
    url: null,
    storyUrl: null,
    port: 4650,
  },
  tokens: {
    source: 'design-system/tokens/tokens.json',
    styleFiles: [],
    darkSelector: '[data-theme="dark"]',
    darkMedia: true,
    // The default mode's name (Figma's first mode, the selector dark mode's media query opts out of).
    defaultMode: 'light',
    // A selector per mode name, where the dark selector with the name swapped in does not fit.
    selectors: {},
    outputs: [],
  },
  audit: {
    include: ['src/**/*.{css,scss,sass,less,tsx,jsx,ts,js,vue,svelte,astro,html}'],
    // Stories stage components with fixture values on purpose; they are not drift.
    exclude: ['**/*.test.*', '**/*.spec.*', '**/*.d.ts', '**/*.stories.*', '**/*.story.*', 'src/stories/**'],
  },
  ignore: ['node_modules', 'dist', 'build', '.git', '.next', '.nuxt', '.svelte-kit', '.astro', '.output', 'coverage', '.turbo', '.vercel', '.cache', 'out'],
  graph: {
    // ds: header keys a repo uses beyond the built-in ones (parents, children,
    // never, use-when, group, no-story), so they are read instead of reported.
    extraKeys: [],
  },
  ticketPattern: null,
  figma: { fileKey: null },
}

// Flags that never take a value, so `--strict build` keeps `build` as a
// positional instead of reading it as the flag's value.
export const BOOLEAN_FLAGS = new Set(['check', 'baseline', 'lower', 'strict', 'json', 'inline', 'full', 'pretty', 'dry-run', 'update-scripts', 'no-npm-scripts'])

// Parse argv into positionals and flags. `--a b`, `--a=b`, and a bare `--a`
// (true) all work; a repeated flag collects into an array.
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      out._.push(arg)
      continue
    }
    let key = arg.slice(2)
    let value = true
    const eq = key.indexOf('=')
    if (eq !== -1) {
      value = key.slice(eq + 1)
      key = key.slice(0, eq)
    } else if (!BOOLEAN_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = argv[++i]
    }
    if (key in out.flags) {
      out.flags[key] = [].concat(out.flags[key], value)
    } else {
      out.flags[key] = value
    }
  }
  return out
}

// The repo root: git's toplevel when there is one, else the nearest
// directory holding a package.json, else where we started.
export function findRoot(start = process.cwd()) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: start,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    if (top) return top
  } catch {
    // not a git checkout
  }
  let dir = resolve(start)
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(start)
    dir = parent
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Objects merge key by key; arrays and scalars from `over` replace `base`.
export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v
  }
  return out
}

export function stripJsonComments(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && n === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else {
      out += c
    }
  }
  // Trailing commas are legal in tsconfig and jsonc.
  return out.replace(/,(\s*[}\]])/g, '$1')
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback
  return JSON.parse(stripJsonComments(readFileSync(path, 'utf8')))
}

// Load the config for a repo. Flags: --root <dir>, --config <file>,
// --project-dir <dir> (overrides config.projectDir, used by tests and dry runs).
export function loadConfig(flags = {}) {
  const root = flags.root ? resolve(flags.root) : findRoot()
  const configPath = flags.config ? resolve(flags.config) : join(root, CONFIG_FILE)
  const exists = existsSync(configPath)
  const raw = exists ? readJson(configPath, {}) : {}
  const config = deepMerge(DEFAULTS, raw)
  const projectDirFlag = flags['project-dir']
  const projectDir = projectDirFlag
    ? resolve(projectDirFlag)
    : isAbsolute(config.projectDir)
      ? config.projectDir
      : join(root, config.projectDir)
  return { root, configPath, exists, config, projectDir }
}

// Repo-relative POSIX path, stable across platforms for deterministic output.
export function rel(root, abs) {
  return relative(root, abs).split(sep).join('/')
}

// Local date as YYYY-MM-DD. MASSIMO_TODAY pins it for reproducible tests.
export function today() {
  if (process.env.MASSIMO_TODAY) return process.env.MASSIMO_TODAY
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function fail(message, code = 1) {
  process.stderr.write(`massimo: ${message}\n`)
  process.exit(code)
}
