#!/usr/bin/env node
// Read a front-end repo and report its stack as JSON: framework, styling,
// existing story tools, candidate component folders and style files, path
// aliases, scripts, and a suggested massimo.config.json. The start skill
// shows this to the user to confirm before anything is written.
//
//   detect.mjs [--root <dir>]

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { colorModeSelector, tailwindDarkSelector } from './lib/dark-mode.mjs'
import { compare, compileGlobs, globToRegExp } from './lib/glob.mjs'
import { adoptableSummary } from './lib/inventory.mjs'
import { findObject } from './lib/jsobject.mjs'
import { csfScaffold } from './lib/lane-css.mjs'
import { nuxtComponentFolders, nuxtRootConfig, nuxtSrcDir, withNuxtFolders } from './lib/nuxt.mjs'
import { CONFIG_FILE, DEFAULTS, findRoot, parseArgs, readJson, workspaceGlobs } from './lib/project.mjs'
import { TAILWIND_CONFIG_STARTS } from './lib/readers.mjs'
import { stripComments, workspacePackages } from './lib/source.mjs'
import { helpAndExit } from './lib/help.mjs'

helpAndExit(import.meta.url)

const { flags } = parseArgs()
const root = flags.root ? flags.root : findRoot()
const pkg = readJson(join(root, 'package.json'), {}) ?? {}
const depsOf = (p) => ({ ...p?.dependencies, ...p?.devDependencies, ...p?.peerDependencies })

// The workspace root a package belongs to: the nearest folder above `dir`, up
// to the top of the checkout, that declares workspaces; null when there is
// none or its globs do not name the package.
function workspaceRootOf(dir) {
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const start = real(dir)
  let top = null
  try {
    top = real(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: start, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim())
  } catch {
    // not a git checkout: look up to the root of the file system
  }
  for (let at = start; at !== top; ) {
    const parent = dirname(at)
    if (parent === at) return null
    at = parent
    const globs = workspaceGlobs(at)
    if (globs.length > 0) return compileGlobs(globs)(relative(at, start).split(sep).join('/')) ? at : null
  }
  return null
}

// A package inside a workspace can use what the workspace root installs, so
// the root's dependencies count beneath the package's own.
const workspaceTop = workspaceRootOf(root)
let hoisted = {}
try {
  hoisted = workspaceTop ? depsOf(readJson(join(workspaceTop, 'package.json'), {})) : {}
} catch {
  // an unreadable package.json at the workspace root adds nothing
}
const deps = { ...hoisted, ...depsOf(pkg) }
const has = (name) => Object.hasOwn(deps, name)
const major = (name) => {
  const m = String(deps[name] ?? '').match(/(\d+)/)
  return m ? Number(m[1]) : null
}

const IGNORE = new Set(DEFAULTS.ignore)
const COMPONENT_EXT = /\.(tsx|jsx|vue|svelte|astro)$/
const STYLE_EXT = /\.(css|scss|sass|less|pcss)$/

// One file list feeds every heuristic below. git's view is best (it already
// honours .gitignore, so generated reports and build output stay out);
// a bounded walk is the fallback outside a git checkout.
function listFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).toString()
    const list = out.split('\n').filter((f) => f && !f.split('/').some((seg) => IGNORE.has(seg)))
    if (list.length) return list
  } catch {
    // not a git checkout
  }
  const found = []
  ;(function walk(dir, depth) {
    if (depth > 8 || found.length > 20000) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.storybook' && e.name !== '.ladle') continue
      if (IGNORE.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else found.push(relative(root, p).split(sep).join('/'))
    }
  })(root, 0)
  return found
}

// A folder with its own package.json is another app (a docs site, a demo) unless
// the root declares workspaces (package.json or pnpm-workspace.yaml); its files
// would only muddle this one's picture.
const workspaces = workspaceGlobs(root).length > 0
const listed = listFiles()
const nested = workspaces
  ? []
  : listed.filter((f) => f !== 'package.json' && f.endsWith('/package.json')).map((f) => f.slice(0, -'package.json'.length))
const files = listed.filter((f) => !nested.some((dir) => f.startsWith(dir)))
// The root's Tailwind 3 config, the one a Tailwind build or Nuxt's Tailwind module reads.
const tailwindConfigFile = ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs', 'tailwind.config.cjs'].find((f) => files.includes(f)) ?? null
// At a workspace root, the dependencies of each package it names: they tell
// the framework and the styling the root's own leave out.
const members = workspaces ? workspacePackages(root).map((m) => ({ dir: m.dir, deps: depsOf(m.pkg) })) : []

function detectFramework(have = has, dir = root) {
  const vite = have('vite')
  if (have('next')) return existsSync(join(dir, 'app')) || existsSync(join(dir, 'src/app')) ? 'next-app' : 'next-pages'
  if (have('astro')) return 'astro'
  if (have('@sveltejs/kit')) return 'sveltekit'
  if (have('nuxt') || have('nuxt3')) return 'nuxt'
  if (have('@remix-run/react') || have('@react-router/dev')) return 'react-router'
  if (have('@angular/core')) return 'angular'
  if (vite && (have('preact') || have('@preact/preset-vite'))) return 'vite-preact'
  if (vite && have('vue')) return 'vite-vue'
  if (vite && have('svelte')) return 'vite-svelte'
  if (vite && have('solid-js')) return 'vite-solid'
  if (vite && have('react')) return 'vite-react'
  if (have('react-scripts') || (have('webpack') && have('react'))) return 'webpack-react'
  if (vite) return 'vite'
  return 'unknown'
}

// The framework a package's own dependencies name. Those it sits beneath (a
// workspace root's) count only when its own name none, or Vite alone, so a
// framework installed at the workspace root never beats the package's own.
function frameworkOf(own, beneath, dir) {
  const found = detectFramework((name) => Object.hasOwn(own, name), dir)
  if (found !== 'unknown' && found !== 'vite') return found
  const both = { ...beneath, ...own }
  return detectFramework((name) => Object.hasOwn(both, name), dir)
}

// A workspace root that names no framework of its own (none, or Vite alone)
// takes the one most of its packages use, each package read with the root's
// dependencies beneath its own.
function repoFramework(own) {
  if ((own !== 'unknown' && own !== 'vite') || members.length === 0) return own
  const counts = new Map()
  for (const m of members) {
    const found = frameworkOf(m.deps, deps, join(root, m.dir))
    if (found !== 'unknown' && found !== 'vite') counts.set(found, (counts.get(found) ?? 0) + 1)
  }
  const [best] = [...counts].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))
  return best ? best[0] : own
}

// CSS with its comments taken out, and with `lines`, the // comments Sass and
// Less have too. A string or a url() is kept whole, since a glob such as
// "../**/*.tsx" holds a "/*" and a URL holds a "//".
const withoutComments = (css, lines = false) =>
  css.replace(lines ? /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|url\((?!\s*["'])[^)]*\))|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g : /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|url\((?!\s*["'])[^)]*\))|\/\*[\s\S]*?\*\//g, (m, kept) => kept ?? ' ')

function detectStyling() {
  const out = []
  // A workspace root's styling is its packages' styling too.
  const used = (name) => has(name) || members.some((m) => Object.hasOwn(m.deps, name))
  const majorIn = (d, name = 'tailwindcss') => Number(String(d[name] ?? '').match(/(\d+)/)?.[1] ?? 0)
  const anyMajor = (name) => major(name) ?? (members.reduce((n, m) => Math.max(n, majorIn(m.deps, name)), 0) || null)
  // Nuxt's Tailwind module brings Tailwind itself: its version 6 is Tailwind 3, 7 is Tailwind 4.
  const nuxtModule = anyMajor('@nuxtjs/tailwindcss')
  // The package's own Tailwind version decides; the CSS only tells when it is not a dependency.
  const tw = major('tailwindcss') ?? (members.reduce((n, m) => Math.max(n, majorIn(m.deps)), 0) || null) ?? (nuxtModule ? (nuxtModule >= 7 ? 4 : 3) : null)
  const cssText = styleFileStats.map((s) => s.css).join('\n')
  if (tw) out.push(tw >= 4 ? 'tailwind4' : 'tailwind3')
  else if (/@import\s+["']tailwindcss["']/.test(cssText)) out.push('tailwind4')
  else if (/@tailwind\s+base/.test(cssText)) out.push('tailwind3')
  // Nuxt's module of no readable version, or a Tailwind 3 config with no
  // other sign: the module injects the @tailwind lines itself.
  else if (used('@nuxtjs/tailwindcss') || tailwindConfigFile) out.push('tailwind3')
  if (used('daisyui')) out.push('daisyui')
  if (existsSync(join(root, 'components.json'))) out.push('shadcn')
  if (files.some((f) => /\.module\.(css|scss)$/.test(f))) out.push('css-modules')
  if (used('sass') || used('node-sass') || files.some((f) => /\.s[ac]ss$/.test(f))) out.push('sass')
  if (used('less')) out.push('less')
  // vanilla-extract shows in any of its packages (a bundler plugin at the
  // root, the runtime in a package) or in its *.css.ts files.
  const vanillaExtract = () => [deps, ...members.map((m) => m.deps)].some((d) => Object.keys(d).some((k) => k.startsWith('@vanilla-extract/'))) || files.some((f) => /\.css\.ts$/.test(f))
  for (const [dep, id] of [
    ['styled-components', 'styled-components'],
    ['@emotion/react', 'emotion'],
    ['@vanilla-extract/css', 'vanilla-extract'],
    ['unocss', 'unocss'],
    ['@pandacss/dev', 'panda'],
    ['@stitches/react', 'stitches'],
    ['@chakra-ui/react', 'chakra'],
    ['@mui/material', 'mui'],
    ['@mantine/core', 'mantine'],
    ['@radix-ui/themes', 'radix-themes'],
  ]) {
    if (used(dep) || (id === 'vanilla-extract' && vanillaExtract())) out.push(id)
  }
  if (!out.length) out.push('css')
  return out
}

function detectStoryTools() {
  const storyFiles = files.filter((f) => /\.(stories|story)\.[a-z]+$/.test(f))
  // The story tools a set of dependencies and a folder's config name.
  const toolsIn = (d, configured) => {
    const out = []
    if (Object.keys(d).some((k) => k === 'storybook' || k.startsWith('@storybook/')) || configured('.storybook')) out.push('storybook')
    if (Object.hasOwn(d, '@ladle/react') || configured('.ladle')) out.push('ladle')
    if (Object.hasOwn(d, 'histoire')) out.push('histoire')
    if (Object.hasOwn(d, 'react-cosmos')) out.push('react-cosmos')
    return out
  }
  const own = toolsIn(depsOf(pkg), (dir) => files.some((f) => f.startsWith(`${dir}/`)))
  // A package of a workspace that holds stories and names no story tool of
  // its own uses the one the workspace root installs or configures.
  const out = own.length === 0 && workspaceTop !== null && storyFiles.length > 0 ? toolsIn(hoisted, (dir) => existsSync(join(workspaceTop, dir))) : own
  return { tools: out, storyFiles: storyFiles.length, sample: storyFiles.slice(0, 5), lane: gatedLane() }
}

// A story lane the repo already built (massimo's shape, or its own): routes
// that exist only when an env flag is set (or a separate stories config),
// and a stories folder with a manifest or an index. Scaffolding a recipe
// over it would overwrite it. The folder is the one the gate names; with
// several candidates and none named, no lane is guessed.
const LANE_INDEX = /(?:^|\/)stories\/(?:index|Gallery|StoriesIndex|main|\+page|page(?:\.story)?)\.[a-z]+$/
const LANE_MANIFEST = /(?:^|\/)stories\/manifest\.(?:[cm]?[jt]s|json)$/
const NOT_A_LANE = /^(?:docs|content|public|dist|build|out|coverage|\.storybook|\.ladle)\//
const readText = (f) => {
  try {
    return readFileSync(join(root, f), 'utf8')
  } catch {
    return ''
  }
}

function gatedLane() {
  const scripts = Object.entries(pkg.scripts ?? {})
  const gated = scripts.filter(([, cmd]) => /\bSTORIES=(?:1|true)\b/.test(String(cmd)) || /--config\s+\S*stories\S*\.config\./.test(String(cmd)))
  const configs = files.filter((f) => /^(?:astro|nuxt|vite|next|svelte)\.config\.[cm]?[jt]s$/.test(f) || /^vite\.[\w-]*stories[\w-]*\.config\.[cm]?[jt]s$/.test(f))
  // A config and the local files it imports (a lane integration lives in one).
  const withImports = (f) => {
    const text = readText(f)
    return [text, ...[...text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => readText(join(f, '..', m[1])))]
  }
  const configGate = configs.find((f) => /stories/.test(f.split('/').pop()) || withImports(f).some((t) => /process\.env\.STORIES\b/.test(t)))
  if (gated.length === 0 && !configGate) return null
  // What the gate names: its scripts, and its config with what that imports.
  const gateText = [...gated.map(([, cmd]) => cmd), ...(configGate ? [configGate] : configs).flatMap(withImports)]
  const named = (dir) => gateText.some((t) => t.includes(dir))
  const dirOf = (f) => f.replace(/\/[^/]+$/, '')
  const candidates = [...new Set(files.filter((f) => (LANE_INDEX.test(f) || LANE_MANIFEST.test(f)) && !NOT_A_LANE.test(f)).map(dirOf))].sort(compare)
  const chosen = candidates.filter(named)
  const dir = chosen.length >= 1 ? chosen[0] : candidates.length === 1 ? candidates[0] : null
  if (!dir) return candidates.length > 1 ? { dir: null, candidates } : null
  const manifest = files.find((f) => LANE_MANIFEST.test(f) && (dirOf(f) === dir || named(dirOf(f)))) ?? null
  const index = files.find((f) => LANE_INDEX.test(f) && dirOf(f) === dir) ?? null
  const pages = files.filter((f) => f.startsWith(`${dir}/pages/`) && COMPONENT_EXT.test(f))
  // The dev script, never a build: dev, start or serve first.
  const notDev = /\b(?:build|generate|export|test|check|preview|deploy|lint)\b/
  const ranked = gated.filter(([name, cmd]) => !notDev.test(name) && !notDev.test(String(cmd)))
  const dev = ranked.find(([name, cmd]) => /\b(?:dev|start|serve)\b/.test(`${name} ${cmd}`)) ?? ranked[0] ?? null
  return {
    dir,
    manifest,
    index,
    gate: configGate ?? (gated.length ? 'package.json scripts' : null),
    devScript: dev?.[0] ?? null,
    port: dev ? portOf(String(dev[1])) : null,
    pages: pages.length,
    files: files.filter((f) => f.startsWith(`${dir}/`)).length,
  }
}

// The port a dev command serves on: --port, -p or a PORT= prefix, through one
// `npm run` hop; else the framework's default.
function portOf(cmd, hops = 0) {
  const m = cmd.match(/--port[ =](\d+)/) ?? cmd.match(/(?:^|\s)-p[ =]?(\d+)/) ?? cmd.match(/\bPORT=(\d+)/)
  if (m) return Number(m[1])
  const hop = /\b(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun run)\s+([\w:.-]+)/.exec(cmd)
  if (hop && hops < 1 && pkg.scripts?.[hop[1]]) return portOf(String(pkg.scripts[hop[1]]), hops + 1)
  return frameworkPort()
}

// Folders whose files look like components, ranked by how many they hold. A
// folder of packages that mostly hold one component each (three packages or
// more, most with three component files or fewer in their src/) is one
// folder, <parent>/*/src, in place of the named folders inside it.
function componentDirs() {
  const isComponent = (f) => COMPONENT_EXT.test(f) && !/\.(stories|story|test|spec)\./.test(f)
  const packageDirs = new Set(files.filter((f) => f.endsWith('/package.json')).map((f) => f.slice(0, -'/package.json'.length)))
  const inPackageSrc = (f) => {
    const m = f.match(/^(.+?)\/([^/]+)\/src\//)
    return m && packageDirs.has(`${m[1]}/${m[2]}`) ? { parent: m[1], name: m[2] } : null
  }
  const byParent = new Map()
  for (const f of files) {
    const at = isComponent(f) ? inPackageSrc(f) : null
    if (!at) continue
    const sizes = byParent.get(at.parent) ?? new Map()
    sizes.set(at.name, (sizes.get(at.name) ?? 0) + 1)
    byParent.set(at.parent, sizes)
  }
  const perPackage = new Set(
    [...byParent]
      .filter(([, sizes]) => {
        const small = [...sizes.values()].filter((n) => n <= 3).length
        return small >= 3 && small * 2 > sizes.size
      })
      .map(([parent]) => parent),
  )
  const counts = new Map()
  for (const f of files) {
    if (!isComponent(f)) continue
    const at = inPackageSrc(f)
    const dir = at && perPackage.has(at.parent) ? `${at.parent}/*/src` : f.match(/^((?:.*?\/)??(?:components|ui|primitives|design-system|elements|atoms|molecules))\//)?.[1]
    if (!dir) continue
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  return [...counts.entries()].map(([dir, count]) => ({ dir, count })).sort((a, b) => b.count - a.count || compare(a.dir, b.dir))
}

// A story tool's own stylesheet (.ladle/, .storybook/) mirrors the app's; the app's is the source.
const styleFileStats = files
  .filter((f) => STYLE_EXT.test(f) && !/\.module\./.test(f) && !/^\.(?:ladle|storybook)\//.test(f))
  .map((f) => {
    let text = ''
    try {
      const p = join(root, f)
      if (statSync(p).size < 512 * 1024) text = readFileSync(p, 'utf8')
    } catch {
      // unreadable, skip
    }
    // A comment that mentions Tailwind is not Tailwind, and a custom property
    // in a comment declares nothing.
    const css = withoutComments(text, /\.(?:scss|sass|less)$/.test(f))
    const customProps = (css.match(/--[a-zA-Z0-9-_]+\s*:/g) ?? []).length
    const theme = /@theme\b|@plugin\s+["']daisyui\/theme["']|@tailwind\s+base|@import\s+["']tailwindcss["']/.test(css)
    // A token output massimo built opens with its header.
    const generated = /Generated by massimo tokens\b/.test(text.slice(0, text.indexOf('\n') + 1 || 400))
    return { file: f, customProps, theme, css, generated }
  })

// The project folder's own outputs, such as kit.css, are massimo's, not the
// repo's, and so are the token outputs it builds (tokens.outputs, or a file
// that opens with its header). So are the folders that hold no UI styling. A
// file that declares no custom property never outranks one that does as a
// token source.
function styleFiles() {
  const outputs = new Set((existingConfig?.tokens?.outputs ?? []).map((o) => (typeof o?.path === 'string' ? o.path.replace(/^\.\//, '') : null)).filter(Boolean))
  return styleFileStats
    .filter((s) => !s.file.startsWith(ownDir) && !outputs.has(s.file) && !s.generated && !notUi.some((dir) => s.file.startsWith(`${dir}/`)))
    .filter((s) => s.customProps >= 5 || s.theme)
    .sort((a, b) => Number(b.customProps > 0) - Number(a.customProps > 0) || Number(b.theme) - Number(a.theme) || b.customProps - a.customProps || compare(a.file, b.file))
    .map(({ file, customProps, theme }) => ({ file, customProps, theme }))
}

// Other places the repo keeps design values, for `tokens.mjs extract`: a
// Tailwind 3 config, theme or token modules, and token JSON files (DTCG or
// Tokens Studio). Read by name and, for JSON, by a quick look inside. None
// from the folders that hold no UI styling.
function tokenSources(projectDir) {
  const leftOut = (f) => f.startsWith(`${projectDir}/`) || notUi.some((dir) => f.startsWith(`${dir}/`))
  const tailwindConfig = tailwindConfigFile
  const themeFiles = files
    .filter((f) => /(^|\/)(theme|tokens|design-tokens|stitches\.config|panda\.config)\.(ts|tsx|js|mjs|cjs)$/.test(f) || /\.css\.ts$/.test(f) && /(theme|tokens|vars)/i.test(f))
    .filter((f) => !leftOut(f))
    .slice(0, 5)
  const importFiles = files
    .filter((f) => /\.tokens\.json$|(^|\/)tokens\.json$|(^|\/)\$themes\.json$|(^|\/)tokens\/[^/]+\.json$/.test(f))
    .filter((f) => !leftOut(f) && f !== 'package.json')
    .filter((f) => {
      try {
        const p = join(root, f)
        if (statSync(p).size > 1024 * 1024) return false
        const text = readFileSync(p, 'utf8')
        // DTCG has $value; Tokens Studio has $themes, $metadata, or tokens with both value and type.
        return /"\$value"|"\$themes"|"\$metadata"/.test(text) || /\{\s*"value"\s*:[^{}]*"type"\s*:|\{\s*"type"\s*:[^{}]*"value"\s*:/.test(text)
      } catch {
        return false
      }
    })
    .slice(0, 5)
  return { tailwindConfig, themeFiles, importFiles }
}

// The tsconfig paths as config aliases: `@/*` to a folder, and an exact key
// such as `@scope/ui` to the file or folder it names. tsconfig.base.json is
// where a monorepo keeps the paths its packages share; it is read first, so
// a key the files that extend it also map takes their target.
function aliases() {
  const out = {}
  for (const name of ['tsconfig.base.json', 'tsconfig.json', 'jsconfig.json', 'tsconfig.app.json']) {
    let cfg
    try {
      cfg = readJson(join(root, name), null)
    } catch {
      continue
    }
    const paths = cfg?.compilerOptions?.paths
    if (!paths) continue
    const base = cfg.compilerOptions.baseUrl ?? '.'
    for (const [k, v] of Object.entries(paths)) {
      const first = Array.isArray(v) ? v[0] : null
      if (typeof first !== 'string') continue
      if (!k.includes('*') && !first.includes('*')) {
        out[k] = join(base, first).split(sep).join('/').replace(/^\.\//, '')
        continue
      }
      if (!k.endsWith('/*') || !first.endsWith('/*')) continue
      const target = join(base, first.slice(0, -1)).split(sep).join('/').replace(/^\.\//, '')
      out[k.slice(0, -1)] = target.endsWith('/') ? target : `${target}/`
    }
  }
  return out
}

function devPort() {
  const dev = String(pkg.scripts?.dev ?? '')
  const m = dev.match(/--port[ =](\d+)/) ?? dev.match(/-p (\d+)/)
  if (m) return Number(m[1])
  return frameworkPort()
}

// The port the repo's framework serves on when none is given.
function frameworkPort() {
  if (framework.startsWith('next') || framework === 'nuxt' || framework === 'react-router') return 3000
  if (framework === 'astro') return 4321
  if (framework === 'angular') return 4200
  if (framework.startsWith('vite') || framework === 'sveltekit') return 5173
  return null
}

// The lock file names the package manager. A package of a workspace with no
// lock file of its own uses the one at the workspace root.
function packageManager() {
  const dirs = workspaceTop && !existsSync(join(root, 'package-lock.json')) ? [root, workspaceTop] : [root]
  for (const dir of dirs) {
    if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
    if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
    if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun'
  }
  return 'npm'
}

// The root's own framework, and the one the repo reports, which a workspace
// root that names none takes from its packages.
const ownFramework = frameworkOf(depsOf(pkg), hoisted, root)
const framework = repoFramework(ownFramework)
const styling = detectStyling()
const dirs = componentDirs()
// A repo may already own a folder named design-system (a package, docs); only
// reuse the name when it is ours.
const projectDir = existsSync(join(root, 'design-system')) && !existsSync(join(root, 'design-system', 'state.json')) ? '.massimo' : 'design-system'

let existingConfig = null
try {
  existingConfig = readJson(join(root, CONFIG_FILE), null)
} catch {
  // an unreadable config: the project folder detect would choose stands in
}
const ownDir = `${String(existingConfig?.projectDir ?? projectDir).replace(/^\.\//, '').replace(/\/+$/, '')}/`

// Capacitor's folders, when the root has a capacitor.config: its native
// projects (android/, ios/) and the web folder it copies into them (its
// webDir). Only folders that hold files; a webDir git ignores, or one in a
// folder every script skips (dist, .output), needs no naming.
function capacitorFolders() {
  const file = ['capacitor.config.ts', 'capacitor.config.js', 'capacitor.config.mjs', 'capacitor.config.json'].find((f) => files.includes(f))
  if (!file) return []
  let webDir = null
  if (file.endsWith('.json')) {
    try {
      webDir = readJson(join(root, file), null)?.webDir ?? null
    } catch {
      // an unreadable config names no web folder
    }
  } else {
    webDir = /\bwebDir\s*:\s*(['"])([^'"\n]+)\1/.exec(stripComments(readText(file), file))?.[2] ?? null
  }
  const web = typeof webDir === 'string' ? webDir.trim().replace(/^\.\//, '').replace(/\/+$/, '') : ''
  const usable = web && web !== '.' && !web.startsWith('..') && !web.startsWith('/') && !web.split('/').some((seg) => IGNORE.has(seg))
  return ['android', 'ios', ...(usable ? [web] : [])].filter((dir, i, list) => list.indexOf(dir) === i && files.some((f) => f.startsWith(`${dir}/`)))
}

// Folders that hold no UI styling: a Nuxt app's server/ folder (its Nitro
// API, with email templates and seed data) and Capacitor's folders. The
// audit leaves them out, and no token source is suggested from them.
const appSrc = nuxtSrcDir(root, files, framework)
const nuxtServer = framework === 'nuxt' ? ['server', ...(appSrc ? [`${appSrc}/server`] : [])] : []
const notUi = [...nuxtServer.filter((dir) => files.some((f) => f.startsWith(`${dir}/`))), ...capacitorFolders()]

// How the app switches to its dark theme, for tokens.darkSelector and
// tokens.darkMedia, as { selector, media, from }; null when nothing says, so
// the defaults stand. Nuxt's color-mode module sets its class on <html>
// whatever the system prefers; else a Tailwind 3 config's darkMode names the
// selector dark: keys on. Either way the media query plays no part.
function darkMode() {
  if (has('@nuxtjs/color-mode')) {
    const nuxt = nuxtRootConfig(root) ?? {}
    const inline = (Array.isArray(nuxt.modules) ? nuxt.modules : []).find((m) => Array.isArray(m) && m[0] === '@nuxtjs/color-mode')?.[1]
    const selector = colorModeSelector(nuxt.colorMode, inline, major('@nuxtjs/color-mode'))
    if (selector) return { selector, media: false, from: '@nuxtjs/color-mode' }
  }
  if (tailwindConfigFile) {
    const selector = tailwindDarkSelector(findObject(stripComments(readText(tailwindConfigFile), tailwindConfigFile), TAILWIND_CONFIG_STARTS)?.darkMode)
    if (selector) return { selector, media: false, from: `${tailwindConfigFile} darkMode` }
  }
  return null
}
const dark = darkMode()

const styles = styleFiles()
const stories = detectStoryTools()
// The csf lane's scaffold is massimo's own lane, written from the recipe. It
// is reported with `csf: true`, so nothing is scaffolded over it, but the
// suggested config takes nothing from it and it is nothing to adopt.
if (stories.lane?.dir && stories.lane.dir === csfScaffold(root, existingConfig)) stories.lane.csf = true
const lane = stories.lane?.dir && !stories.lane.csf ? stories.lane : null
const extByFramework = {
  'vite-vue': 'vue',
  nuxt: 'vue',
  'vite-svelte': 'svelte',
  sveltekit: 'svelte',
  astro: '{astro,tsx,jsx,vue,svelte}',
}
const ext = extByFramework[framework] ?? '{tsx,jsx}'
// A Nuxt app's components are also the folders Nuxt registers, every layer's included.
const topDirs = withNuxtFolders(dirs.slice(0, 3).map((d) => d.dir), nuxtComponentFolders(root, files, framework))
const srcRoot = existsSync(join(root, 'src')) ? 'src' : '.'
// A Nuxt app's story lane sits in its source folder, where `~` points: app/
// in Nuxt 4's layout. One whose source folder is the root gets the stories
// exclude any other app gets.
const nuxtSrc = nuxtSrcDir(root, files, framework)
const nuxtStories = nuxtSrc ? `${nuxtSrc}/stories/**` : null

// The component globs, each one only if it matches a component file: the top
// component folders; else the components folder by convention; else the top
// folders that hold component files, most first. None when there is none.
function componentInclude() {
  const isComponent = (f) => COMPONENT_EXT.test(f) && !/\.(stories|story|test|spec)\./.test(f) && !/(^|\/)__tests__\//.test(f)
  const inside = (glob) => {
    const re = globToRegExp(glob)
    return files.filter((f) => re.test(f) && isComponent(f))
  }
  // The framework's extensions when they match a file in the folder, else
  // the extensions its component files have; null when it holds none.
  const globIn = (dir) => {
    if (inside(`${dir}/**/*.${ext}`).length > 0) return `${dir}/**/*.${ext}`
    const exts = [...new Set(inside(`${dir}/**/*`).map((f) => f.slice(f.lastIndexOf('.') + 1)))].sort(compare)
    return exts.length === 0 ? null : `${dir}/**/*.${exts.length === 1 ? exts[0] : `{${exts.join(',')}}`}`
  }
  const named = topDirs.map(globIn).filter(Boolean)
  if (named.length > 0) return named
  const conventional = globIn(srcRoot === '.' ? 'components' : 'src/components')
  if (conventional) return [conventional]
  const counts = new Map()
  for (const f of files) {
    if (!isComponent(f) || !f.includes('/') || f.startsWith('.')) continue
    const top = f.slice(0, f.indexOf('/'))
    counts.set(top, (counts.get(top) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))
    .slice(0, 3)
    .map(([top]) => globIn(top))
}

// The stories keys 0.3.0 wrote. A key added later is left out, so a config
// written by init holds none until a project opts in.
const storiesDefaults = Object.fromEntries(
  ['lane', 'include', 'devCommand', 'url', 'storyUrl', 'port', 'manifest', 'pages', 'frames', 'componentless'].map((k) => [k, DEFAULTS.stories[k]]),
)

const suggestedConfig = {
  version: 1,
  projectDir,
  framework,
  packageManager: packageManager(),
  styling,
  components: {
    include: componentInclude(),
    exclude: DEFAULTS.components.exclude,
  },
  // The app/ folder only when the root's own Next.js app keeps it there.
  consumers: [`${srcRoot === '.' ? '' : 'src/'}**/*.{tsx,jsx,ts,js,mjs,vue,svelte,astro}`].concat(ownFramework === 'next-app' && !existsSync(join(root, 'src/app')) ? ['app/**/*.{tsx,jsx,ts,js}'] : []),
  aliases: aliases(),
  // An existing gated lane is the lane: its pages are the stories, and its own
  // dev script and port run it.
  // A lane's pages are its stories; without a pages folder, its stories are
  // the *.story.* files the recipes keep beside components, never the lane's
  // own frames and wrappers.
  stories: lane
    ? {
        ...storiesDefaults,
        include: lane.pages > 0 ? [`${lane.dir}/pages/**/*.{astro,tsx,jsx,vue,svelte,ts}`] : [`${srcRoot === '.' ? '' : 'src/'}**/*.story.${ext}`],
        devCommand: lane.devScript ? `npm run ${lane.devScript}` : null,
        port: lane.port ?? DEFAULTS.stories.port,
        url: lane.port ? `http://localhost:${lane.port}/stories` : null,
      }
    : { ...storiesDefaults, include: [`${srcRoot === '.' ? '' : 'src/'}**/*.story.${ext}`] },
  tokens: {
    ...DEFAULTS.tokens,
    ...(dark ? { darkSelector: dark.selector, darkMedia: dark.media } : {}),
    source: `${projectDir}/tokens/tokens.resolver.json`,
    styleFiles: styles.slice(0, 3).map((s) => s.file),
    ...tokenSources(projectDir),
  },
  // The audit reads the same tree as the consumers, so a repo with no src/ is still audited.
  audit: {
    include: [`${srcRoot === '.' ? '' : 'src/'}**/*.{css,scss,sass,less,tsx,jsx,ts,js,vue,svelte,astro,html}`],
    // A lane stages components with fixture values on purpose: not drift.
    // Nor is a folder that holds no UI styling, where the audit reaches it.
    exclude: [
      ...DEFAULTS.audit.exclude.map((g) => (nuxtStories && g === 'src/stories/**' ? nuxtStories : srcRoot === '.' ? g.replace(/^src\//, '') : g)),
      ...(lane && !DEFAULTS.audit.exclude.includes(`${lane.dir}/**`) && `${lane.dir}/**` !== nuxtStories ? [`${lane.dir}/**`] : []),
      ...notUi.filter((dir) => srcRoot === '.' || dir.startsWith('src/')).map((dir) => `${dir}/**`),
    ],
  },
}

// What `adopt.mjs scan` would find: a lane or story tool, ds: keys beyond the
// built-in ones and those the config already gives a role or lists as extra,
// the repo's own graph, ratchet or token inventory, a DESIGN.md. Only listed
// when there is something, so the report of a repo with nothing to adopt is
// as it was.
const adoptable = adoptableSummary(root, files.filter((f) => !f.startsWith(ownDir)), { tools: stories.tools, lane, config: existingConfig ?? {} })

const result = {
  root,
  name: pkg.name ?? null,
  existingProject: existsSync(join(root, CONFIG_FILE)),
  framework,
  packageManager: suggestedConfig.packageManager,
  typescript: has('typescript') || existsSync(join(root, 'tsconfig.json')),
  styling,
  storyTools: stories,
  playwright: has('playwright') || has('@playwright/test'),
  // A root that holds packages and no framework of its own holds only apps.
  monorepo: workspaces || existsSync(join(root, 'turbo.json')) || (nested.length > 0 && framework === 'unknown'),
  scripts: { dev: pkg.scripts?.dev ?? null, build: pkg.scripts?.build ?? null },
  devPort: devPort(),
  componentDirs: dirs.slice(0, 10),
  nestedPackages: nested,
  styleFiles: styles.slice(0, 10),
  aliases: suggestedConfig.aliases,
  suggestedConfig,
  // Where the suggested dark selector comes from, only when one was read.
  ...(dark ? { darkMode: dark } : {}),
  ...(adoptable.length > 0 ? { adoptable } : {}),
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
