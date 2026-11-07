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

const files = listFiles()

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
  const tw = major('tailwindcss')
  const cssText = styleFileStats.map((s) => s.text).join('\n')
  if (tw >= 4 || /@import\s+["']tailwindcss["']/.test(cssText)) out.push('tailwind4')
  else if (tw || /@tailwind\s+base/.test(cssText)) out.push('tailwind3')
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
  return { tools: out, storyFiles: storyFiles.length, sample: storyFiles.slice(0, 5) }
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

const styleFileStats = files
  .filter((f) => STYLE_EXT.test(f) && !/\.module\./.test(f))
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

function styleFiles() {
  return styleFileStats
    .filter((s) => s.customProps >= 5 || s.theme)
    .sort((a, b) => Number(b.theme) - Number(a.theme) || b.customProps - a.customProps || compare(a.file, b.file))
    .map(({ file, customProps, theme }) => ({ file, customProps, theme }))
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
const styles = styleFiles()
const stories = detectStoryTools()
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

// A repo may already own a folder named design-system (a package, docs); only
// reuse the name when it is ours.
const projectDir = existsSync(join(root, 'design-system')) && !existsSync(join(root, 'design-system', 'state.json')) ? '.massimo' : 'design-system'

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
  stories: { ...DEFAULTS.stories, include: [`${srcRoot === '.' ? '' : 'src/'}**/*.story.${ext}`] },
  tokens: {
    ...DEFAULTS.tokens,
    source: `${projectDir}/tokens/tokens.resolver.json`,
    styleFiles: styles.slice(0, 3).map((s) => s.file),
  },
  // The audit reads the same tree as the consumers, so a repo with no src/ is still audited.
  audit: {
    include: [`${srcRoot === '.' ? '' : 'src/'}**/*.{css,scss,sass,less,tsx,jsx,ts,js,vue,svelte,astro,html}`],
    exclude: DEFAULTS.audit.exclude.map((g) => (srcRoot === '.' ? g.replace(/^src\//, '') : g)),
  },
}

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
  styleFiles: styles.slice(0, 10),
  aliases: suggestedConfig.aliases,
  suggestedConfig,
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
