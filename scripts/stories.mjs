#!/usr/bin/env node
// The csf story lane from the command line: what the registry holds, whether
// the lane is sound, and whether the lane's CSS leaked into the app's.
//
//   stories.mjs index            files, slugs and states per root
//   stories.mjs index --json     the registry itself (format 1), for tools
//   stories.mjs --check          exit 1 when the lane has a fault; writes nothing
//   stories.mjs leak --app <dir> --lane <dir> [--probe <class>] [--before <dir>]
//                                compare the CSS of an app build and a lane build
//
// --check fails on registry problems, a frozen design target that changed,
// the graph's csf lane problems (except a node with no story), a base CSS
// that holds `@source not`, app code that imports a module only stories use,
// and a lane scaffold whose type file is from another format. It warns on
// story-only modules the app's entry CSS does not exclude, and prints the
// files per root and the live nodes no story reaches without failing.
//
// leak refuses a build folder git does not ignore, so a build never reaches a
// commit. With --probe the class must be in the lane's CSS and not the app's.
// --before names an earlier app build: the classes the app's CSS lost since
// then must not occur in an app file. With neither, every class found only in
// story files, story-only modules and the lane's scaffold folder, and in no
// other file git keeps (the app's CSS, docs and tests included), is looked up
// in the app's CSS.
//
// Shared flags: --root <dir> --config <file> --project-dir <dir>

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGraph } from './graph.mjs'
import { compare, compileGlobs, walk } from './lib/glob.mjs'
import { cssClasses, cssLayoutProblems, sourceWords, storyOnly } from './lib/lane-css.mjs'
import { frozenProblems } from './lib/convert.mjs'
import { laneRegistry } from './lib/lane.mjs'
import { fail, loadConfig, parseArgs, warnIfVendoredOlder } from './lib/project.mjs'
import { createResolver, isStoryFile, isTestFile } from './lib/source.mjs'
import { typesLine } from './lib/vite-stories.mjs'

const LANES = ['native', 'manifest', 'csf']
const APP_TEXT = /\.(?:tsx?|jsx?|mjs|cjs|mts|cts|vue|svelte|astro|html|mdx)$/
// Files no class name comes from: images, fonts, media, archives and lock files.
const NOT_TEXT = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|ogg|webm|mov|pdf|zip|gz|tgz|br|wasm|lockb)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i

// The first line the scaffold's type file carries, as the plugin writes it.
export { typesLine }

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// Whether git ignores a folder: true, false, or null when git cannot say. A
// folder outside the repo can never reach a commit, so it counts as ignored.
export function gitIgnored(root, dir) {
  const inside = relative(root, dir)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return true
  const probe = `${inside.split(sep).join('/')}/index`
  const r = spawnSync('git', ['check-ignore', '-q', '--', probe], { cwd: root })
  if (r.status === 0) return true
  if (r.status === 1) return false
  return null
}

// The files among `files` that git ignores, as a Set; empty when git cannot say.
export function gitIgnoredFiles(root, files) {
  if (files.length === 0) return new Set()
  const r = spawnSync('git', ['check-ignore', '--stdin', '-z'], { cwd: root, input: `${files.join('\0')}\0`, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) return new Set()
  return new Set(r.stdout.toString().split('\0').filter(Boolean))
}

// Every repo file the lane reads: the walk minus the lane build's output folder.
export function repoFiles(root, config) {
  const out = (config.stories.outDir ?? '').replace(/^\.\//, '').replace(/\/+$/, '')
  return walk(root, { ignore: config.ignore }).filter((f) => !out || !(f === out || f.startsWith(`${out}/`)))
}

export function registryOf(root, config, files) {
  const include = compileGlobs(config.stories.include)
  return laneRegistry({ root, config, files: files.filter(include), read: (f) => readFileSync(join(root, f), 'utf8') })
}

// The registry's counts per root (the first part of a title), in the registry's order.
export function rootCounts(registry) {
  const roots = new Map()
  for (const id of registry.order) {
    const s = registry.stories[id]
    const root = s.levels[0] ?? s.slug
    const r = roots.get(root) ?? roots.set(root, { root, files: new Set(), slugs: new Set(), states: 0 }).get(root)
    r.files.add(s.file)
    r.slugs.add(s.slug)
    r.states += 1
  }
  return [...roots.values()].map((r) => ({ root: r.root, files: r.files.size, slugs: r.slugs.size, states: r.states }))
}

export function indexText(registry) {
  const roots = rootCounts(registry)
  const files = Object.keys(registry.files).length
  const states = registry.order.length
  const lines = [`massimo stories: ${plural(files, 'file')}, ${plural(Object.keys(registry.slugs).length, 'slug')}, ${plural(states, 'state')} in ${plural(roots.length, 'root')} (ids: ${registry.ids})`]
  const width = Math.max(0, ...roots.map((r) => r.root.length))
  for (const r of roots) lines.push(`  ${r.root.padEnd(width)}  ${plural(r.files, 'file')}, ${plural(r.slugs, 'slug')}, ${plural(r.states, 'state')}`)
  if (registry.home) lines.push(`home: ${registry.home}`)
  if (registry.problems.length > 0) lines.push(`${plural(registry.problems.length, 'problem')}: run stories.mjs --check`)
  return `${lines.join('\n')}\n`
}

// What `--check` finds: { registry, problems, warnings, notes }, each
// problem and warning { rule, file, detail }. `graph` and `frozen` default to
// the real checks and can be replaced in a test.
export function checkLane({ root, config, files = repoFiles(root, config), graph = buildGraph, frozen = frozenProblems }) {
  const registry = registryOf(root, config, files)
  const problems = [...registry.problems]
  const warnings = []
  const notes = []

  for (const p of frozen(root, config)) {
    problems.push(typeof p === 'string' ? { rule: 'frozen', file: null, detail: p } : { rule: p.rule ?? 'frozen', file: p.file ?? null, detail: p.detail ?? p.message ?? '' })
  }

  // The graph's csf rules. A node with no story is information here, never a fault.
  let storyLane = null
  try {
    const built = graph(root, config, 'stories.mjs')
    storyLane = (built.json ?? built).storyLane ?? null
  } catch (e) {
    problems.push({ rule: 'graph', file: null, detail: e instanceof Error ? e.message : String(e) })
  }
  if (storyLane?.lane === 'csf') {
    for (const p of storyLane.problems ?? []) if (p.rule !== 'no-story') problems.push(p)
    const none = (storyLane.problems ?? []).filter((p) => p.rule === 'no-story')
    if (none.length > 0) {
      const shown = none.slice(0, 12).map((p) => p.file)
      notes.push(`${plural(none.length, 'live node')} no story reaches: ${shown.join(', ')}${none.length > shown.length ? `, and ${none.length - shown.length} more` : ''}`)
    }
  }

  for (const p of cssLayoutProblems({ root, config, files, resolver: createResolver(root, config) })) (p.severity === 'warn' ? warnings : problems).push(p)

  // A scaffold written by another format of the plugin reads a registry it may not understand.
  const expected = typesLine()
  for (const file of files.filter((f) => f === 'massimo.d.ts' || f.endsWith('/massimo.d.ts'))) {
    const first = readFileSync(join(root, file), 'utf8').split('\n', 1)[0].replace(/^﻿/, '').trimEnd()
    if (first !== expected) problems.push({ rule: 'scaffold', file, detail: `its first line is "${first}", but this plugin writes "${expected}"; update the lane scaffold` })
  }

  notes.unshift(`files per root: ${rootCounts(registry).map((r) => `${r.root} ${r.files}`).join(', ') || 'none'}`)
  const order = (list) => list.sort((a, b) => compare(a.rule, b.rule) || compare(a.file ?? '', b.file ?? '') || compare(a.detail, b.detail))
  return { registry, problems: order(problems), warnings: order(warnings), notes }
}

const line = (p) => `  [${p.rule}] ${p.file ? `${p.file}: ` : ''}${p.detail}`

// ── leak ─────────────────────────────────────────────────────────────────────

function cssIn(dir) {
  const files = walk(dir).filter((f) => f.endsWith('.css'))
  return cssClasses(files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n'))
}

// The edit that keeps story-only files out of the app's CSS while the lane
// still reads them (layout A): the exclusions live in an entry CSS of the
// app's own, which imports the base CSS the lane imports. With no entry set,
// it proposes app.css beside the base. Each path is written from the entry's
// folder, since Tailwind reads a `@source` path from the file that declares it.
// `scaffold` is the lane's scaffold folder, excluded whole, or null.
export function layoutEdit(config, storyOnly, scaffold = null) {
  const appCss = config.stories.appCss ?? {}
  const base = typeof appCss.base === 'string' ? appCss.base : null
  const outside = storyOnly.filter((f) => scaffold === null || !f.startsWith(`${scaffold}/`))
  const excluded = [...outside, ...(scaffold === null ? [] : [scaffold]), ...config.stories.include]
  if (base === null) {
    return [
      'The app must keep story-only files out of its CSS in an entry of its own (layout A), and stories.appCss names no base CSS:',
      '  1. Set stories.appCss.base to the CSS file the app\'s main module imports, and run leak again for the exact edit.',
      '  2. The files that entry will exclude, from the repo root:',
      ...excluded.map((p) => `    ${p}`),
    ]
  }
  const entry = typeof appCss.entry === 'string' ? appCss.entry : posix.join(posix.dirname(base), 'app.css')
  const from = posix.dirname(entry)
  const here = (p) => posix.relative(from, p) || '.'
  const spec = here(base).startsWith('.') ? here(base) : `./${here(base)}`
  return [
    `The lane imports ${base}, so the app keeps story-only files out of its CSS in an entry of its own (layout A):`,
    `  1. ${typeof appCss.entry === 'string' ? `Make ${entry} start` : `Create ${entry}`} with @import "${spec}"; then the exclusions:`,
    ...excluded.map((p) => `    @source not "${here(p)}";`),
    `  2. Point the app's main module at ${entry} instead of ${base}.`,
    `  3. Keep @source not out of ${base} and the sheets it imports: there it would drop the lane's own classes too.`,
    ...(typeof appCss.entry === 'string' ? [] : [`  4. Set stories.appCss.entry to "${entry}", so stories.mjs --check reads the layout.`]),
  ]
}

// Compare an app build's CSS with a lane build's. Returns { ok, lines }.
// `isIgnored` checks a build folder and `ignoredFiles` lists the repo files
// git ignores; both can be replaced in a test.
export function leakReport({ root, config, files = repoFiles(root, config), app, lane, probe = null, before = null, isIgnored = gitIgnored, ignoredFiles = gitIgnoredFiles }) {
  const lines = []
  const folders = [['--app', app], ['--lane', lane], ...(before ? [['--before', before]] : [])]
  for (const [flag, dir] of folders) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return { ok: false, lines: [`${flag} ${dir} is not a folder`] }
    const ignored = isIgnored(root, dir)
    if (ignored !== true) {
      const shown = relative(root, dir) || dir
      return { ok: false, lines: [`${flag} ${shown} is ${ignored === false ? 'not ignored by git' : 'not a folder git can check'}, so a build could reach a commit; add it to .gitignore and run the check again`] }
    }
  }
  const appClasses = cssIn(app)
  const laneClasses = cssIn(lane)

  const include = compileGlobs(config.stories.include)
  const { modules, scaffold } = storyOnly({ root, config, files, resolver: createResolver(root, config) })
  const storyOnlyFiles = new Set(modules)
  const inScaffold = (file) => scaffold !== null && file.startsWith(`${scaffold}/`)
  // Tailwind takes a class from any file it reads for the app, so a word in
  // the app's own CSS, its docs or its tests is no leak (`appText`). A class
  // the app's CSS lost counts when the app's own code uses it (`appCode`).
  // The build folders and the files git ignores are read by neither. Every
  // file of the lane's scaffold folder, its stylesheets included, is the lane's.
  const builds = [app, lane, before].filter(Boolean).map((d) => relative(root, d).split(sep).join('/'))
  const ignored = ignoredFiles(root, files)
  const storyWords = new Set()
  const appText = new Set()
  const appCode = new Map()
  for (const file of files) {
    if (NOT_TEXT.test(file) || ignored.has(file) || builds.some((d) => file.startsWith(`${d}/`))) continue
    const test = isTestFile(file)
    const inLane = !test && (isStoryFile(file) || include(file) || storyOnlyFiles.has(file) || inScaffold(file))
    const code = !inLane && !test && APP_TEXT.test(file) && !/\.d\.[cm]?ts$/.test(file)
    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    for (const w of sourceWords(text)) {
      if (inLane) storyWords.add(w)
      else appText.add(w)
      if (code && !appCode.has(w)) appCode.set(w, file)
    }
    // A stylesheet's own selectors name classes its CSS defines itself: the
    // app's, or for one of the lane's stylesheets, the lane's.
    if (/\.(?:css|scss|sass|less|pcss)$/.test(file)) for (const c of cssClasses(text)) (inLane ? storyWords : appText).add(c)
  }

  let leaked = []
  if (probe !== null) {
    if (!laneClasses.has(probe)) return { ok: false, lines: [`the class ${probe} is not in the lane's CSS, so this probe proves nothing`] }
    if (appClasses.has(probe)) leaked = [probe]
    lines.push(leaked.length > 0 ? `leak: ${probe} is in the app's CSS` : `ok: ${probe} is in the lane's CSS and not the app's`)
  } else if (!before) {
    // A scan by words: a class a package's stylesheet or a CSS plugin gives the
    // app, under a name only stories use, shows here too; --probe settles one.
    leaked = [...storyWords].filter((w) => !appText.has(w) && laneClasses.has(w) && appClasses.has(w)).sort(compare)
    if (leaked.length > 0) lines.push(`leak: ${plural(leaked.length, 'class', 'classes')} only stories use ${leaked.length === 1 ? 'is' : 'are'} in the app's CSS: ${leaked.slice(0, 20).join(', ')}${leaked.length > 20 ? `, and ${leaked.length - 20} more` : ''}`)
    else lines.push('ok: no class only stories use is in the app\'s CSS')
  }

  let lost = []
  if (before) {
    lost = [...cssIn(before)].filter((c) => !appClasses.has(c) && appCode.has(c)).sort(compare)
    if (lost.length > 0) lines.push(`lost: the app's CSS no longer has ${plural(lost.length, 'class', 'classes')} an app file uses: ${lost.slice(0, 20).map((c) => `${c} (${appCode.get(c)})`).join(', ')}${lost.length > 20 ? `, and ${lost.length - 20} more` : ''}`)
    else lines.push('ok: the app\'s CSS lost no class an app file uses')
  }

  if (leaked.length > 0) lines.push('', ...layoutEdit(config, modules, scaffold))
  return { ok: leaked.length === 0 && lost.length === 0, lines }
}

// ── command line ─────────────────────────────────────────────────────────────

function main() {
  const { _: args, flags } = parseArgs()
  const sub = flags.check ? 'check' : args[0]
  if (!['check', 'index', 'leak'].includes(sub)) fail('usage: stories.mjs index [--json] | --check | leak --app <dir> --lane <dir> [--probe <class>] [--before <dir>]')
  const { root, config, projectDir } = loadConfig(flags)
  warnIfVendoredOlder(projectDir, import.meta.url)
  const lane = String(config.stories.lane ?? 'native')
  if (!LANES.includes(lane)) fail(`stories.lane is "${lane}", which stories.mjs does not know. Use "native", "manifest" or "csf".`)
  if (lane !== 'csf') {
    if (sub === 'check') {
      process.stdout.write(`massimo stories: nothing to check, stories.lane is "${lane}" and this check reads a csf lane\n`)
      return
    }
    fail(`stories.mjs ${sub} reads a csf lane, and stories.lane is "${lane}". Set stories.lane to "csf" first.`)
  }

  if (sub === 'index') {
    const registry = registryOf(root, config, repoFiles(root, config))
    process.stdout.write(flags.json ? `${JSON.stringify(registry, null, 2)}\n` : indexText(registry))
    return
  }

  if (sub === 'leak') {
    for (const key of ['app', 'lane']) if (typeof flags[key] !== 'string') fail('usage: stories.mjs leak --app <dir> --lane <dir> [--probe <class>] [--before <dir>]')
    const { ok, lines } = leakReport({
      root,
      config,
      app: resolve(flags.app),
      lane: resolve(flags.lane),
      probe: typeof flags.probe === 'string' ? flags.probe : null,
      before: typeof flags.before === 'string' ? resolve(flags.before) : null,
    })
    process.stdout.write(`${lines.join('\n')}\n`)
    if (!ok) process.exit(1)
    return
  }

  const { registry, problems, warnings, notes } = checkLane({ root, config })
  const counts = `${plural(Object.keys(registry.files).length, 'file')}, ${plural(registry.order.length, 'state')}`
  for (const n of notes) process.stdout.write(`note: ${n}\n`)
  if (warnings.length > 0) process.stdout.write(`${warnings.map((w) => `warn${line(w)}`).join('\n')}\n`)
  if (problems.length > 0) {
    process.stderr.write(`massimo stories: ${plural(problems.length, 'problem')} (${counts})\n${problems.map(line).join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write(`massimo stories: ok (${counts})\n`)
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (entry === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}
