#!/usr/bin/env node
// Read a front-end repo and report its stack as JSON: framework, styling,
// existing story tools, candidate component folders and style files, path
// aliases, scripts, and a suggested massimo.config.json. The start skill
// shows this to the user to confirm before anything is written.
//
//   detect.mjs [--root <dir>]

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { compare } from './lib/glob.mjs'
import { adoptableSummary } from './lib/inventory.mjs'
import { CONFIG_FILE, DEFAULTS, findRoot, parseArgs, readJson } from './lib/project.mjs'

const { flags } = parseArgs()
const root = flags.root ? flags.root : findRoot()
const pkg = readJson(join(root, 'package.json'), {}) ?? {}
const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
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
// the root declares workspaces; its files would only muddle this one's picture.
const listed = listFiles()
const nested = pkg.workspaces
  ? []
  : listed.filter((f) => f !== 'package.json' && f.endsWith('/package.json')).map((f) => f.slice(0, -'package.json'.length))
const files = listed.filter((f) => !nested.some((dir) => f.startsWith(dir)))

function detectFramework() {
  const vite = has('vite')
  if (has('next')) return existsSync(join(root, 'app')) || existsSync(join(root, 'src/app')) ? 'next-app' : 'next-pages'
  if (has('astro')) return 'astro'
  if (has('@sveltejs/kit')) return 'sveltekit'
  if (has('nuxt') || has('nuxt3')) return 'nuxt'
  if (has('@remix-run/react') || has('@react-router/dev')) return 'react-router'
  if (has('@angular/core')) return 'angular'
  if (vite && (has('preact') || has('@preact/preset-vite'))) return 'vite-preact'
  if (vite && has('vue')) return 'vite-vue'
  if (vite && has('svelte')) return 'vite-svelte'
  if (vite && has('solid-js')) return 'vite-solid'
  if (vite && has('react')) return 'vite-react'
  if (has('react-scripts') || (has('webpack') && has('react'))) return 'webpack-react'
  if (vite) return 'vite'
  return 'unknown'
}

function detectStyling() {
  const out = []
  // The package's own Tailwind version decides; the CSS only tells when it is not a dependency.
  const tw = major('tailwindcss')
  const cssText = styleFileStats.map((s) => s.text).join('\n')
  if (tw) out.push(tw >= 4 ? 'tailwind4' : 'tailwind3')
  else if (/@import\s+["']tailwindcss["']/.test(cssText)) out.push('tailwind4')
  else if (/@tailwind\s+base/.test(cssText)) out.push('tailwind3')
  if (has('daisyui')) out.push('daisyui')
  if (existsSync(join(root, 'components.json'))) out.push('shadcn')
  if (files.some((f) => /\.module\.(css|scss)$/.test(f))) out.push('css-modules')
  if (has('sass') || has('node-sass') || files.some((f) => /\.s[ac]ss$/.test(f))) out.push('sass')
  if (has('less')) out.push('less')
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
    if (has(dep)) out.push(id)
  }
  if (!out.length) out.push('css')
  return out
}

function detectStoryTools() {
  const out = []
  if (Object.keys(deps).some((d) => d === 'storybook' || d.startsWith('@storybook/')) || files.some((f) => f.startsWith('.storybook/'))) out.push('storybook')
  if (has('@ladle/react') || files.some((f) => f.startsWith('.ladle/'))) out.push('ladle')
  if (has('histoire')) out.push('histoire')
  if (has('react-cosmos')) out.push('react-cosmos')
  const storyFiles = files.filter((f) => /\.(stories|story)\.[a-z]+$/.test(f))
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

// Folders whose files look like components, ranked by how many they hold.
function componentDirs() {
  const counts = new Map()
  for (const f of files) {
    if (!COMPONENT_EXT.test(f) || /\.(stories|story|test|spec)\./.test(f)) continue
    const m = f.match(/^(.*?\/(?:components|ui|primitives|design-system|elements|atoms|molecules))\//)
    if (!m) continue
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
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
    const customProps = (text.match(/--[a-zA-Z0-9-_]+\s*:/g) ?? []).length
    const theme = /@theme\b|@plugin\s+["']daisyui\/theme["']|@tailwind\s+base|@import\s+["']tailwindcss["']/.test(text)
    return { file: f, customProps, theme, text }
  })

// The project folder's own outputs, such as kit.css, are massimo's, not the
// repo's.
function styleFiles() {
  return styleFileStats
    .filter((s) => !s.file.startsWith(ownDir))
    .filter((s) => s.customProps >= 5 || s.theme)
    .sort((a, b) => Number(b.theme) - Number(a.theme) || b.customProps - a.customProps || compare(a.file, b.file))
    .map(({ file, customProps, theme }) => ({ file, customProps, theme }))
}

// Other places the repo keeps design values, for `tokens.mjs extract`: a
// Tailwind 3 config, theme or token modules, and token JSON files (DTCG or
// Tokens Studio). Read by name and, for JSON, by a quick look inside.
function tokenSources(projectDir) {
  const ours = (f) => f.startsWith(`${projectDir}/`)
  const tailwindConfig = ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs', 'tailwind.config.cjs'].find((f) => files.includes(f)) ?? null
  const themeFiles = files
    .filter((f) => /(^|\/)(theme|tokens|design-tokens|stitches\.config|panda\.config)\.(ts|tsx|js|mjs|cjs)$/.test(f) || /\.css\.ts$/.test(f) && /(theme|tokens|vars)/i.test(f))
    .filter((f) => !ours(f))
    .slice(0, 5)
  const importFiles = files
    .filter((f) => /\.tokens\.json$|(^|\/)tokens\.json$|(^|\/)\$themes\.json$|(^|\/)tokens\/[^/]+\.json$/.test(f))
    .filter((f) => !ours(f) && f !== 'package.json')
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

function aliases() {
  const out = {}
  for (const name of ['tsconfig.json', 'jsconfig.json', 'tsconfig.app.json']) {
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
      if (!k.endsWith('/*') || !v?.[0]?.endsWith('/*')) continue
      const target = join(base, v[0].slice(0, -1)).split(sep).join('/').replace(/^\.\//, '')
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

// The port a framework's dev server uses when none is given.
function frameworkPort() {
  const framework = detectFramework()
  if (framework.startsWith('next') || framework === 'nuxt' || framework === 'react-router') return 3000
  if (framework === 'astro') return 4321
  if (framework === 'angular') return 4200
  if (framework.startsWith('vite') || framework === 'sveltekit') return 5173
  return null
}

function packageManager() {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun'
  return 'npm'
}

const framework = detectFramework()
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
const styles = styleFiles()
const stories = detectStoryTools()
const lane = stories.lane?.dir ? stories.lane : null
const extByFramework = {
  'vite-vue': 'vue',
  nuxt: 'vue',
  'vite-svelte': 'svelte',
  sveltekit: 'svelte',
  astro: '{astro,tsx,jsx,vue,svelte}',
}
const ext = extByFramework[framework] ?? '{tsx,jsx}'
const topDirs = dirs.slice(0, 3).map((d) => d.dir)
const srcRoot = existsSync(join(root, 'src')) ? 'src' : '.'

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
    include: (topDirs.length ? topDirs : [`${srcRoot === '.' ? '' : 'src/'}components`]).map((d) => `${d}/**/*.${ext}`),
    exclude: DEFAULTS.components.exclude,
  },
  consumers: [`${srcRoot === '.' ? '' : 'src/'}**/*.{tsx,jsx,ts,js,mjs,vue,svelte,astro}`].concat(framework === 'next-app' && !existsSync(join(root, 'src/app')) ? ['app/**/*.{tsx,jsx,ts,js}'] : []),
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
    source: `${projectDir}/tokens/tokens.resolver.json`,
    styleFiles: styles.slice(0, 3).map((s) => s.file),
    ...tokenSources(projectDir),
  },
  // The audit reads the same tree as the consumers, so a repo with no src/ is still audited.
  audit: {
    include: [`${srcRoot === '.' ? '' : 'src/'}**/*.{css,scss,sass,less,tsx,jsx,ts,js,vue,svelte,astro,html}`],
    // A lane stages components with fixture values on purpose: not drift.
    exclude: [...DEFAULTS.audit.exclude.map((g) => (srcRoot === '.' ? g.replace(/^src\//, '') : g)), ...(lane && !DEFAULTS.audit.exclude.includes(`${lane.dir}/**`) ? [`${lane.dir}/**`] : [])],
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
  monorepo: Boolean(pkg.workspaces) || existsSync(join(root, 'pnpm-workspace.yaml')) || existsSync(join(root, 'turbo.json')),
  scripts: { dev: pkg.scripts?.dev ?? null, build: pkg.scripts?.build ?? null },
  devPort: devPort(),
  componentDirs: dirs.slice(0, 10),
  nestedPackages: nested,
  styleFiles: styles.slice(0, 10),
  aliases: suggestedConfig.aliases,
  suggestedConfig,
  ...(adoptable.length > 0 ? { adoptable } : {}),
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
