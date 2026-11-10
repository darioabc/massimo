#!/usr/bin/env node
// The csf story lane from the command line: what the registry holds, whether
// the lane is sound, and whether the lane's CSS leaked into the app's. Beside
// a Storybook the repo keeps, on any lane: each story's id and URL.
//
//   stories.mjs index            files, slugs and states per root
//   stories.mjs index --json     the registry itself (format 1), for tools
//   stories.mjs --check          exit 1 when the lane has a fault; writes nothing
//   stories.mjs leak --app <dir> --lane <dir> [--probe <class>] [--before <dir>]
//                                compare the CSS of an app build and a lane build
//   stories.mjs storybook [<file>...] [--json | --routes] [--against <index.json or url>]
//                                Storybook's id and URL for each story, by its rule
//
// storybook reads .storybook/main (or the folder the storybook dev script
// names with -c) and each story file as text, never running either. A
// <file> is a story file Storybook serves, or a component whose stories
// graph.json lists; with none, every story file. A story's URL is
// stories.storyUrl with {id} for the id, else Storybook's iframe URL on
// stories.url or the dev script's port. --against compares the ids with
// Storybook's own index (a saved index.json, or the URL of a running
// Storybook) and exits 1 on any difference; a story file massimo cannot read
// also exits 1. --routes prints { "<id>": "<path>" } for shoot.mjs --sweep
// --routes.
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
// --before names an earlier app build: it lists every class the app's CSS
// dropped since then, by where its name occurs, and fails when an app file
// uses one. With neither, every class found only in story files, story-only
// modules and the lane's scaffold folder, and in no other file git keeps (the
// app's CSS, docs and tests included), is looked up in the app's CSS. An app
// build has a class only by a rule of the class's own, never by a selector
// that names it under or beside another class, as a package's sheet or a
// component library writes one, unless the class's variant names that class,
// as `group-hover:flex` names `.group`.
//
// Shared flags: --root <dir> --config <file> --project-dir <dir>

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGraph } from './graph.mjs'
import { compare, compileGlobs, walk } from './lib/glob.mjs'
import { cssClasses, cssLayoutProblems, ownClasses, sourceWords, storyOnly } from './lib/lane-css.mjs'
import { frozenProblems } from './lib/convert.mjs'
import { laneRegistry } from './lib/lane.mjs'
import { fail, loadConfig, parseArgs, readJson, warnIfVendoredOlder } from './lib/project.mjs'
import { createResolver, isStoryFile, isTestFile } from './lib/source.mjs'
import { storybookDev, storybookIndex } from './lib/storybook.mjs'
import { laneRepoFiles, typesLine } from './lib/vite-stories.mjs'
import { helpAndExit } from './lib/help.mjs'

helpAndExit(import.meta.url)

const LANES = ['native', 'manifest', 'csf']
const APP_TEXT = /\.(?:tsx?|jsx?|mjs|cjs|mts|cts|vue|svelte|astro|html|mdx)$/
// Files no class name comes from: images, fonts, media, archives and lock files.
const NOT_TEXT = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|ogg|webm|mov|pdf|zip|gz|tgz|br|wasm|lockb)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i

// The first line the scaffold's type file carries, as the plugin writes it.
export { typesLine }

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// A path with its symlinks resolved, or as given when it does not exist.
const realPath = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

// Whether git ignores a folder: true, false, or null when git cannot say.
// Git is asked about the folder itself, from the top of the repo that holds
// it, so a path through a symlink or a --root below that top reads the same.
// A folder in no repo can never reach a commit, so it counts as ignored.
export function gitIgnored(_root, dir) {
  const env = { ...process.env, LC_ALL: 'C' }
  const real = realPath(dir)
  const top = spawnSync('git', ['-C', real, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env })
  if (top.error) return null
  if (top.status !== 0) return /not a git repository/i.test(top.stderr ?? '') ? true : null
  const toplevel = realPath(top.stdout.trim())
  const inside = relative(toplevel, real)
  if (inside === '') return false
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null
  const r = spawnSync('git', ['-C', toplevel, 'check-ignore', '-q', '--', `${inside.split(sep).join('/')}/index`], { env })
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

// Every repo file the lane reads: the walk minus the lane build's output
// folder, as the Vite plugin reads them.
export function repoFiles(root, config) {
  return laneRepoFiles(root, config)
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
  const problems = []
  const warnings = []
  const notes = []

  for (const p of frozen(root, config)) {
    problems.push(typeof p === 'string' ? { rule: 'frozen', file: null, detail: p } : { rule: p.rule ?? 'frozen', file: p.file ?? null, detail: p.detail ?? p.message ?? '' })
  }

  // The graph's csf rules, which carry the registry's own problems. A node
  // with no story is information here, never a fault.
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
  } else problems.push(...registry.problems)

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

// The classes a build's stylesheets name, or with `read` set to ownClasses,
// hold as rules of their own.
function cssIn(dir, read = cssClasses) {
  const out = new Set()
  for (const f of walk(dir)) if (f.endsWith('.css')) for (const c of read(readFileSync(join(dir, f), 'utf8'))) out.add(c)
  return out
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
      const inside = relative(realPath(root), realPath(dir))
      const shown = inside === '' || inside.startsWith('..') || isAbsolute(inside) ? dir : inside.split(sep).join('/')
      return { ok: false, lines: [`${flag} ${shown} is ${ignored === false ? 'not ignored by git' : 'not a folder git can check'}, so a build could reach a commit; add it to .gitignore and run the check again`] }
    }
  }
  // An app build holds a class only by a rule of the class's own: a
  // package's sheet that scopes a utility under its own class, or a
  // component library's compound, neither leaks a story's class into the
  // app nor keeps a class whose own rule the app's CSS dropped.
  const appClasses = cssIn(app, ownClasses)
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
  const realRoot = realPath(root)
  const builds = [app, lane, before].filter(Boolean).map((d) => relative(realRoot, realPath(d)).split(sep).join('/'))
  const ignored = ignoredFiles(root, files)
  const storyWords = new Set()
  const appText = new Set()
  // The classes the lane's own stylesheets hold by a rule of their own, and
  // the classes the app's stylesheets name.
  const laneRules = new Set()
  const appSheets = new Set()
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
    if (/\.(?:css|scss|sass|less|pcss)$/.test(file)) {
      for (const c of cssClasses(text)) {
        if (inLane) storyWords.add(c)
        else {
          appText.add(c)
          appSheets.add(c)
        }
      }
      if (inLane) for (const c of ownClasses(text)) laneRules.add(c)
    }
  }

  let leaked = []
  if (probe !== null) {
    if (!laneClasses.has(probe)) return { ok: false, lines: [`the class ${probe} is not in the lane's CSS, so this probe proves nothing`] }
    if (appClasses.has(probe)) leaked = [probe]
    lines.push(leaked.length > 0 ? `leak: ${probe} is in the app's CSS` : `ok: ${probe} is in the lane's CSS and not the app's`)
  } else if (!before) {
    // A scan by words: a class a package's stylesheet or a CSS plugin gives the
    // app a rule of its own for, under a name only stories use, shows here
    // too; --probe settles one.
    // A word elsewhere never excuses a class a stylesheet of the lane's
    // holds by a rule of its own and none of the app's names: Tailwind makes
    // no rule of a word it has no utility for, so that rule came from the
    // lane's sheet.
    const appsOwn = (w) => appSheets.has(w) || (appText.has(w) && !laneRules.has(w))
    leaked = [...storyWords].filter((w) => !appsOwn(w) && laneClasses.has(w) && appClasses.has(w)).sort(compare)
    if (leaked.length > 0) lines.push(`leak: ${plural(leaked.length, 'class', 'classes')} only stories use ${leaked.length === 1 ? 'is' : 'are'} in the app's CSS: ${leaked.slice(0, 20).join(', ')}${leaked.length > 20 ? `, and ${leaked.length - 20} more` : ''}`)
    else lines.push('ok: no class only stories use is in the app\'s CSS')
  }

  // Every class the app's CSS dropped since the build before, for a person
  // to review, grouped by where its name occurs. Only one that app code
  // uses fails the check.
  let lost = []
  if (before) {
    const dropped = [...cssIn(before, ownClasses)].filter((c) => !appClasses.has(c)).sort(compare)
    lost = dropped.filter((c) => appCode.has(c))
    const groups = [
      [lost, (n) => `app code uses ${n}`],
      [dropped.filter((c) => !appText.has(c) && !storyWords.has(c)), (n) => `no file git keeps names ${n}`],
      [dropped.filter((c) => appText.has(c) && !appCode.has(c)), (n) => `only files that are not app code, such as docs, tests and stylesheets, name ${n}`],
      [dropped.filter((c) => !appText.has(c) && storyWords.has(c)), (n) => `only story files and story-only modules name ${n}`],
    ]
    if (dropped.length === 0) lines.push('dropped: the app\'s CSS has every class the build before had')
    else lines.push(`dropped: ${plural(dropped.length, 'class', 'classes')} the build before had ${dropped.length === 1 ? 'is' : 'are'} not in the app's CSS`)
    for (const [list, label] of groups) if (list.length > 0) lines.push(`  ${label(list.length)}: ${list.join(', ')}`)
    if (dropped.length > lost.length) lines.push('  review the list: a class name app code builds at run time is no word in its file, so this check cannot see that the app needs it')
    if (lost.length > 0) lines.push(`lost: the app's CSS no longer has ${plural(lost.length, 'class', 'classes')} an app file uses: ${lost.slice(0, 20).map((c) => `${c} (${appCode.get(c)})`).join(', ')}${lost.length > 20 ? `, and ${lost.length - 20} more` : ''}`)
    else lines.push('ok: the app\'s CSS lost no class an app file uses')
  }

  if (leaked.length > 0) lines.push('', ...layoutEdit(config, modules, scaffold))
  return { ok: leaked.length === 0 && lost.length === 0, lines }
}

// ── A kept Storybook ────────────────────────────────────────────────────────

// Storybook's ids and URLs for the story files `names` asks for: a story file
// Storybook serves, or a component whose stories graph.json lists (only those
// Storybook serves); with no names, every story file it serves. Returns
// { main, files: [{ file, title, stories: [{ export, name, id, url }],
// problems, own }], unknown }, where `own` marks a component's own story
// file (its name beside the component's, listed first), `unknown` lists the
// names that are neither, and null means the repo has no Storybook main
// config.
export function storybookStories({ root, config, projectDir, names = [], files = walk(root, { ignore: config.ignore }) }) {
  const dev = storybookDev(readJson(join(root, 'package.json'), {})?.scripts ?? {})
  const index = storybookIndex(root, files, { configDir: dev?.configDir ?? '.storybook' })
  if (!index) return null
  const storyUrl = String(config.stories.storyUrl ?? '')
  const template = storyUrl.includes('{id}') ? storyUrl : `${String(config.stories.url ?? `http://localhost:${dev?.port ?? 6006}`).replace(/\/+$/, '')}/iframe.html?id={id}&viewMode=story`
  const byFile = new Map(index.files.map((f) => [f.file, f]))
  let graph = null
  const nodeStories = (name) => {
    graph ??= readJson(join(projectDir, 'graph.json'), null) ?? { nodes: [] }
    const node = (graph.nodes ?? []).find((n) => n.file === name)
    return node ? (node.stories ?? []).filter((f) => byFile.has(f)) : null
  }
  const wanted = new Set()
  const own = new Set()
  const unknown = []
  const stem = (f) => f.replace(/\.(?:stories|story)\.[^./]+$/, '').replace(/\.[^./]+$/, '')
  for (const name of names) {
    const asked = name.replace(/^\.\//, '')
    if (byFile.has(asked)) wanted.add(asked)
    else {
      const stories = nodeStories(asked)
      if (!stories) unknown.push(name)
      for (const f of stories ?? []) {
        wanted.add(f)
        if (stem(f) === stem(asked)) own.add(f)
      }
    }
  }
  const chosen = names.length === 0 ? index.files : index.files.filter((f) => wanted.has(f.file)).sort((a, b) => own.has(b.file) - own.has(a.file))
  return {
    main: index.main,
    files: chosen.map((f) => ({ ...f, stories: f.stories.map((st) => ({ ...st, url: template.split('{id}').join(st.id) })), ...(own.has(f.file) ? { own: true } : {}) })),
    unknown,
  }
}

// The ids massimo names beside Storybook's own index (`entries`, or the
// `stories` of an older index), for the files listed: { missing, extra },
// `missing` the ids Storybook does not have, `extra` the stories Storybook
// has for those files that massimo does not name. A docs entry is no story.
export function compareStorybookIndex(listed, index) {
  const theirs = Object.values(index?.entries ?? index?.stories ?? {}).filter((e) => e && (e.type ?? 'story') === 'story')
  const files = new Set(listed.map((f) => f.file))
  const ours = new Map(listed.flatMap((f) => f.stories.map((st) => [st.id, f.file])))
  const known = new Set(theirs.map((e) => e.id))
  const missing = [...ours].filter(([id]) => !known.has(id)).map(([id, file]) => ({ id, file }))
  const extra = theirs
    .filter((e) => files.has(String(e.importPath ?? '').replace(/^\.\//, '')) && !ours.has(e.id))
    .map((e) => ({ id: e.id, file: String(e.importPath).replace(/^\.\//, '') }))
  const order = (a, b) => compare(a.file, b.file) || compare(a.id, b.id)
  return { missing: missing.sort(order), extra: extra.sort(order) }
}

async function storybookCommand({ root, config, projectDir, names, flags }) {
  const found = storybookStories({ root, config, projectDir, names })
  if (!found) fail('stories.mjs storybook reads a Storybook config (.storybook/main.*, or the folder the storybook dev script names with -c), and there is none here')
  if (found.unknown.length > 0) fail(`${found.unknown.join(', ')}: neither a story file Storybook serves nor a component in graph.json (run graph.mjs if it is new)`)
  const problems = found.files.filter((f) => f.problems.length > 0)
  let compared = null
  if (typeof flags.against === 'string') {
    const from = flags.against
    let index
    if (/^https?:\/\//.test(from)) {
      const url = /\.json(?:\?|$)/.test(from) ? from : `${from.replace(/\/+$/, '')}/index.json`
      const r = await fetch(url).catch(() => null)
      if (!r?.ok) fail(`${url} ${r ? `answered ${r.status}` : 'did not answer'}: is Storybook running there?`)
      index = await r.json()
    } else index = readJson(resolve(from), null)
    if (!index || typeof index !== 'object') fail(`${from} is not Storybook's index.json`)
    compared = compareStorybookIndex(found.files, index)
  }
  if (flags.routes) {
    const routes = Object.fromEntries(found.files.flatMap((f) => f.stories.map((st) => [st.id, `${new URL(st.url).pathname}${new URL(st.url).search}`])))
    process.stdout.write(`${JSON.stringify(routes, null, 2)}\n`)
  } else if (flags.json) {
    process.stdout.write(`${JSON.stringify({ main: found.main, files: found.files, ...(compared ? compared : {}) }, null, 2)}\n`)
  } else {
    const lines = []
    for (const f of found.files) {
      lines.push(`${f.file}  ${f.title ?? '(no title read)'}${f.own ? "  (the component's own story)" : ''}`)
      for (const st of f.stories) lines.push(`  ${st.id}  ${st.url}`)
      for (const p of f.problems) lines.push(`  problem: ${p}`)
    }
    const count = found.files.reduce((n, f) => n + f.stories.length, 0)
    lines.push(`massimo stories: ${plural(found.files.length, 'story file')}, ${plural(count, 'story', 'stories')}, by Storybook's id rule from ${found.main}`)
    if (compared) {
      for (const m of compared.missing) lines.push(`missing in Storybook: ${m.id} (${m.file})`)
      for (const e of compared.extra) lines.push(`not named by massimo: ${e.id} (${e.file})`)
      if (compared.missing.length + compared.extra.length === 0) lines.push(`ok: every id matches Storybook's index`)
    }
    process.stdout.write(`${lines.join('\n')}\n`)
  }
  if (problems.length > 0 || (compared && compared.missing.length + compared.extra.length > 0)) process.exitCode = 1
}

// ── command line ─────────────────────────────────────────────────────────────

function main() {
  const { _: args, flags } = parseArgs()
  const sub = flags.check ? 'check' : args[0]
  if (!['check', 'index', 'leak', 'storybook'].includes(sub)) fail('usage: stories.mjs index [--json] | --check | leak --app <dir> --lane <dir> [--probe <class>] [--before <dir>] | storybook [<file>...] [--json | --routes] [--against <index.json or url>]')
  const { root, config, projectDir } = loadConfig(flags)
  warnIfVendoredOlder(projectDir, import.meta.url)
  // A kept Storybook serves its own stories, whatever the lane.
  if (sub === 'storybook') return storybookCommand({ root, config, projectDir, names: args.slice(1), flags })
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
    Promise.resolve(main()).catch((err) => fail(err instanceof Error ? err.message : String(err)))
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}
