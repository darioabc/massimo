// Shared plumbing for every massimo script: find the repo root, load
// massimo.config.json merged over the defaults, resolve the project dir,
// and parse the few CLI flags every script shares.
//
// Zero dependencies on purpose. These scripts get vendored into the target
// repo (<project>/scripts/) so CI and teammates without the plugin can
// run them, and a vendored script must not drag a dependency tree with it.

import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CONFIG_FILE = 'massimo.config.json'
export const SCRIPTS_VERSION = '0.4.0'

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
    // A lane that lists its stories in a manifest (read as text, never run),
    // and where a slug's page and frame live, as paths with `{slug}`. Null
    // keeps finding stories by file name.
    manifest: null,
    pages: null,
    frames: null,
    // The places (`Root / Group`) where a manifest story may name no
    // component: token pages, decision records.
    componentless: [],
    // The csf lane (0.4.0): story files read in place, shown by a Vite plugin.
    // Every key below keeps its default until a project opts in, and a config
    // that sets one needs minScripts 0.4.0.
    // `ids` is `export` (slug and state from the file and the export) or
    // `ladle` (Ladle's rule, storyName first); `order` is id-prefix globs for
    // the index; `home` is the id that `/` and `/stories` open.
    ids: 'export',
    order: null,
    home: null,
    // [{ label, width, height }] in px, 0 fills the pane. Null means Phone
    // 390x844, Desktop 1440x900 and Full.
    viewports: null,
    // Story files whose states the shell may show together.
    sideBySide: [],
    // [{ name, label, attribute, values, unset, default }]; a null default asks the frame.
    switchers: [],
    // { <meta key>: { tone, lead } }, a banner per story-level or file-level meta key.
    banners: null,
    // A project module whose default export wraps every state.
    frame: null,
    // Globs of modules only stories use, beyond the ones the import graph finds.
    storyOnly: [],
    // { base, entry }: the CSS the lane imports, and the app's entry that holds `@source not`.
    appCss: null,
    // The lane build's output folder, and the host files it may write (`_redirects`).
    outDir: null,
    hostFiles: [],
    // [{ file, sha256, since }]: design targets kept byte for byte.
    frozen: [],
    // Title, coverage and banner rules, each off until a key is set.
    policy: null,
  },
  tokens: {
    // Defaults to <projectDir>/tokens/tokens.json (see loadConfig).
    source: null,
    styleFiles: [],
    darkSelector: '[data-theme="dark"]',
    darkMedia: true,
    // The default mode's name (Figma's first mode, the selector dark mode's media query opts out of).
    defaultMode: 'light',
    // A selector per mode name, where the dark selector with the name swapped in does not fit.
    selectors: {},
    // Other places the repo keeps design values, read by `tokens.mjs extract`:
    // a Tailwind 3 config, JS or TS theme objects, token files (DTCG or Tokens
    // Studio), and Figma variables exported as JSON.
    tailwindConfig: null,
    themeFiles: [],
    importFiles: [],
    figmaExport: null,
    outputs: [],
    // The media widths the audit's breakpoint kind allows: { scale: ['40rem'],
    // twins: ['40.0625rem'] }, the twins being each step's min-width partner.
    breakpoints: null,
    // The style files stay the source, and the token set at tokens.source is
    // their checked mirror (`tokens.mjs mirror`), which everything else reads.
    mirror: false,
    // What `tokens.mjs resolved` lists in tokens/resolved.json: { files,
    // layers, families, typeClasses }, all globs. Null lists tokens.styleFiles
    // as one layer.
    inventory: null,
  },
  audit: {
    include: ['src/**/*.{css,scss,sass,less,tsx,jsx,ts,js,vue,svelte,astro,html}'],
    // Stories stage components with fixture values on purpose; they are not drift.
    exclude: ['**/*.test.*', '**/*.spec.*', '**/*.d.ts', '**/*.stories.*', '**/*.story.*', 'src/stories/**'],
    // Kinds turned off by name, as { length: false }; true turns the Tailwind
    // palette kind on with the Tailwind config's colours as the repo's own.
    kinds: {},
    // Per kind, what it skips: { color: { roles: { theme: '*' }, tiers: [], groups: [], files: [] } }.
    exempt: {},
    // 'all' counts every Tailwind arbitrary value; 'color' only the colours.
    arbitrary: 'all',
    // 'all' reads every literal token as a primitive; 'color' only colours,
    // and with no token set yet, the literal colours tokens.styleFiles define.
    primitives: 'all',
    // --check also fails while the baseline is behind the code.
    failWhenBehind: false,
  },
  guard: {
    // Project commands ds:check runs as well, as [{ name, run }].
    extraChecks: [],
  },
  ignore: ['node_modules', 'dist', 'build', '.git', '.next', '.nuxt', '.svelte-kit', '.astro', '.output', 'coverage', '.turbo', '.vercel', '.cache', 'out'],
  graph: {
    // ds: header keys a repo uses beyond the built-in ones (parents, children,
    // never, use-when, group, no-story), so they are read instead of reported.
    extraKeys: [],
    // A repo's own keys with the role each plays (lib/roles.mjs): a role name,
    // or { role, values, under }.
    keys: {},
    // { tiers, groups, placement, rules, parked, require, notLive }: the tiers
    // in order, each group with a line on what belongs in it, the placement
    // test, path rules that give a file its group, the marker of a parked file
    // and its group, the keys each tier needs, and the tiers that are not live
    // code, so need no story. Null takes any group.
    taxonomy: null,
    // Node kinds beyond components, each a list of globs: { layout: [...], page: [...] }.
    kinds: {},
    // Imports read beyond import statements: 'mdx' (the import lines of MDX
    // files in the consumers) and 'glob' (import.meta.glob calls).
    edges: [],
    // 'anywhere' reads a ds: line in any comment; 'top' reads the first
    // comment block only, and a ds: line anywhere else is a fault.
    header: 'anywhere',
    // Header faults fail the write and --check, not only the report.
    strictFaults: false,
  },
  ticketPattern: null,
  figma: { fileKey: null },
}

// The stories keys 0.4.0 added. A config that sets one to a non-default value,
// or sets `lane` to "csf", needs these scripts at 0.4.0 or later, so its
// `minScripts` must say so: 0.3.0 would otherwise read it and ignore the keys.
export const STORIES_0_4_0_KEYS = ['ids', 'order', 'home', 'viewports', 'sideBySide', 'switchers', 'banners', 'frame', 'storyOnly', 'appCss', 'outDir', 'hostFiles', 'frozen', 'policy']

// The `minScripts` a raw config's stories section requires, or null when it
// uses nothing from 0.4.0.
export function needsScripts(raw) {
  const stories = raw?.stories
  if (!stories || typeof stories !== 'object') return null
  if (stories.lane === 'csf') return '0.4.0'
  const set = STORIES_0_4_0_KEYS.some((key) => key in stories && JSON.stringify(stories[key]) !== JSON.stringify(DEFAULTS.stories[key]))
  return set ? '0.4.0' : null
}

// Flags that never take a value, so `--strict build` keeps `build` as a
// positional instead of reading it as the flag's value.
export const BOOLEAN_FLAGS = new Set(['check', 'baseline', 'lower', 'strict', 'json', 'inline', 'full', 'pretty', 'dry-run', 'update-scripts', 'no-npm-scripts', 'freeze', 'reduced-motion', 'settle', 'legacy'])

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

// The project root: the nearest folder from `start` up to git's toplevel that
// holds massimo.config.json, so a project made in a package of a monorepo is
// found from inside that package; with none, git's toplevel. Outside git, the
// nearest folder up that holds massimo.config.json, else the nearest one
// holding a package.json, else where we started.
export function findRoot(start = process.cwd()) {
  try {
    const [top, prefix = ''] = execFileSync('git', ['rev-parse', '--show-toplevel', '--show-prefix'], {
      cwd: start,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .split('\n')
      .map((line) => line.trim())
    if (top) {
      const parts = prefix.split('/').filter(Boolean)
      for (let i = parts.length; i > 0; i--) {
        const dir = join(top, ...parts.slice(0, i))
        if (existsSync(join(dir, CONFIG_FILE))) return dir
      }
      return top
    }
  } catch {
    // not a git checkout
  }
  for (const file of [CONFIG_FILE, 'package.json']) {
    let dir = resolve(start)
    while (true) {
      if (existsSync(join(dir, file))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return resolve(start)
}

// The package globs a workspace root declares: package.json `workspaces` (a
// list, or an object with a `packages` list), then the `packages:` list of
// pnpm-workspace.yaml, read as text. A `!` glob takes folders out rather than
// naming any, and `.` names the root itself, so neither is listed. An empty
// list means the root declares no workspaces.
export function workspaceGlobs(root) {
  const out = []
  let pkg = null
  try {
    pkg = readJson(join(root, 'package.json'), null)
  } catch {
    // an unreadable package.json declares nothing
  }
  const declared = Array.isArray(pkg?.workspaces) ? pkg.workspaces : Array.isArray(pkg?.workspaces?.packages) ? pkg.workspaces.packages : []
  out.push(...declared)
  let yaml = ''
  try {
    yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  } catch {
    // no pnpm workspace file
  }
  out.push(...yamlPackages(yaml))
  const named = out.filter((g) => typeof g === 'string').map((g) => g.trim().replace(/\/+$/, ''))
  return [...new Set(named.filter((g) => g && g !== '.' && !g.startsWith('!')))]
}

// The items of the top-level `packages:` list in pnpm-workspace.yaml, block
// (`- packages/*`) or flow (`[packages/*, www]`), quoted or not.
function yamlPackages(text) {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((line) => /^packages[ \t]*:/.test(line))
  if (at === -1) return []
  const unquote = (item) => {
    const s = item.trim()
    const quoted = /^(['"])(.*?)\1[ \t]*(?:#.*)?$/.exec(s)
    return quoted ? quoted[2] : s.replace(/[ \t]+#.*$/, '').trim()
  }
  const rest = lines[at].replace(/^packages[ \t]*:/, '').replace(/[ \t]+#.*$/, '').trim()
  if (rest.startsWith('[')) return rest.replace(/^\[|\][ \t]*$/g, '').split(',').map(unquote).filter(Boolean)
  const items = []
  for (const line of lines.slice(at + 1)) {
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue
    const item = /^[ \t]*-[ \t]+(.*)$/.exec(line)
    if (!item) {
      if (/^\S/.test(line)) break
      continue
    }
    items.push(unquote(item[1]))
  }
  return items.filter(Boolean)
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

// JSONC to JSON: comments go, and so do trailing commas (legal in tsconfig and
// jsonc), but only outside strings, so a value like "a,}" is left alone.
export function stripJsonComments(text) {
  let out = ''
  let inString = false
  // The next offset that is not whitespace or a comment.
  const skip = (j) => {
    for (;;) {
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '/' && text[j + 1] === '/') {
        while (j < text.length && text[j] !== '\n') j++
      } else if (text[j] === '/' && text[j + 1] === '*') {
        const k = text.indexOf('*/', j + 2)
        j = k === -1 ? text.length : k + 2
      } else {
        return j
      }
    }
  }
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
    } else if (c === ',') {
      const j = skip(i + 1)
      if (text[j] !== '}' && text[j] !== ']') out += c
    } else {
      out += c
    }
  }
  return out
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback
  return JSON.parse(stripJsonComments(readFileSync(path, 'utf8')))
}

// Load the config for a repo. Flags: --root <dir>, --config <file>,
// --project-dir <dir> (overrides config.projectDir, used by tests and dry runs).
// Version strings compared part by part: 0.2.10 is newer than 0.2.9.
const versionParts = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0)
export function olderThan(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}

// The version of the scripts vendored in a project: null when there are
// none, `unknown` when its declaration cannot be read. Either quote style
// counts, since a formatter may have rewritten the copy.
export function vendoredVersion(projectDir) {
  const p = join(projectDir, 'scripts', 'lib', 'project.mjs')
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf8').match(/^export const SCRIPTS_VERSION = ['"]([^'"]+)['"]/m)?.[1] ?? 'unknown'
}

// Whether a vendored copy is known to be older; an unreadable one is not.
export const vendoredOlder = (version) => Boolean(version) && version !== 'unknown' && olderThan(version, SCRIPTS_VERSION)

// What to do about a file or config newer than these scripts.
const UPDATE = 'update massimo: the plugin, then its init.mjs --update-scripts for the project\'s copy'

// The newest format of each file this version reads. A file in a newer one
// was written by a newer massimo, and reading it as an older one would guess.
// baseline 2: it tracks a kind added in 0.3.0 (audit.mjs NEWER_KINDS).
// conversion, removal, redirects and registry are the 0.4.0 story-lane files.
export const FORMATS_READ = { config: 1, graph: 1, baseline: 2, resolved: 1, pairs: 1, inventory: 1, ledger: 1, conversion: 1, removal: 1, redirects: 1, registry: 1 }
// Why a file of `kind` at `version` is too new to read, or null.
export const newerMessage = (kind, version, where) =>
  typeof version === 'number' && version > FORMATS_READ[kind] ? `${where} is format ${version}, and these scripts (${SCRIPTS_VERSION}) read up to ${FORMATS_READ[kind]}: ${UPDATE}` : null
export function refuseNewer(kind, version, where, code = 1) {
  const message = newerMessage(kind, version, where)
  if (message) fail(message, code)
}

// Why a config cannot be used by these scripts, or null.
function configRefusal(raw) {
  const newer = newerMessage('config', raw?.version, CONFIG_FILE)
  if (newer) return newer
  if (typeof raw?.minScripts === 'string' && olderThan(SCRIPTS_VERSION, raw.minScripts)) return `${CONFIG_FILE} needs massimo scripts ${raw.minScripts} or later, and these are ${SCRIPTS_VERSION}: ${UPDATE}`
  return null
}

// Run from the plugin rather than the project's vendored copy, a script
// says when that copy is older, since CI and teammates run the copy.
export function warnIfVendoredOlder(projectDir, scriptUrl) {
  const here = dirname(fileURLToPath(scriptUrl))
  if (resolve(here) === resolve(join(projectDir, 'scripts'))) return
  const vendored = vendoredVersion(projectDir)
  if (vendoredOlder(vendored)) {
    process.stderr.write(`massimo: warn: the project's vendored scripts are ${vendored}, older than this ${SCRIPTS_VERSION}; run init.mjs --update-scripts so CI reads what this writes\n`)
  }
}

// Scripts stop on a config they cannot use; a hook passes `gate: false`,
// carries on, and reads `refusal` to say why, since a hook must never fail.
export function loadConfig(flags = {}, { gate = true } = {}) {
  const root = flags.root ? resolve(flags.root) : findRoot()
  const configPath = flags.config ? resolve(flags.config) : join(root, CONFIG_FILE)
  const exists = existsSync(configPath)
  const raw = exists ? readJson(configPath, {}) : {}
  const refusal = configRefusal(raw)
  if (refusal && gate) fail(refusal)
  const config = deepMerge(structuredClone(DEFAULTS), raw)
  const projectDirFlag = flags['project-dir']
  const projectDir = projectDirFlag
    ? resolve(projectDirFlag)
    : isAbsolute(config.projectDir)
      ? config.projectDir
      : join(root, config.projectDir)
  // The token source lives in the project folder unless the config says
  // otherwise: the 2025.10 resolver document, or an older tokens.json.
  if (!config.tokens.source) {
    const dir = rel(root, isAbsolute(config.projectDir) ? config.projectDir : join(root, config.projectDir))
    const older = `${dir}/tokens/tokens.json`
    const source = existsSync(join(root, older)) && !existsSync(join(root, dir, 'tokens', 'tokens.resolver.json')) ? older : `${dir}/tokens/tokens.resolver.json`
    // A copy: deepMerge shares DEFAULTS' nested objects, which must stay as they are.
    config.tokens = { ...config.tokens, source }
  }
  return { root, configPath, exists, config, projectDir, refusal }
}

// The command that runs a vendored script, from the repo root, for messages
// and generated-file headers, such as `node <project>/scripts/graph.mjs`.
export function scriptCommand(root, projectDir, name, args = '') {
  return `node ${rel(root, projectDir) || '.'}/scripts/${name}.mjs${args ? ` ${args}` : ''}`
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

// ISO 8601 timestamp. MASSIMO_NOW pins it, and MASSIMO_TODAY alone pins midnight of that day.
export function now() {
  if (process.env.MASSIMO_NOW) return process.env.MASSIMO_NOW
  if (process.env.MASSIMO_TODAY) return `${process.env.MASSIMO_TODAY}T00:00:00.000Z`
  return new Date().toISOString()
}

// Write through a temporary file and rename it into place, so a reader never
// sees half a file and a crash mid-write leaves the old one whole.
export function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  try {
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

// Run `fn` while holding `<path>.lock`, so two sessions updating one file take
// turns instead of losing each other's change. A lock older than 30 seconds
// is left by a run that died, and is taken over.
export function withLock(path, fn, { timeoutMs = 10000 } = {}) {
  const lock = `${path}.lock`
  const started = Date.now()
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'))
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30000) {
          rmSync(lock, { force: true })
          continue
        }
      } catch {
        continue // the holder just let go
      }
      if (Date.now() - started > timeoutMs) throw new Error(`${lock} is held by another massimo run; delete it if no run is going`)
      Atomics.wait(pause, 0, 0, 50)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

export function fail(message, code = 1) {
  process.stderr.write(`massimo: ${message}\n`)
  process.exit(code)
}
