// How the lane's CSS and the app's CSS stay apart: which modules only stories
// use, which `@source not` lines the app's entry holds, and the layout faults
// that would leak story-only classes into the app.
//
// Layout A: the lane imports the app's base CSS, which holds no `@source not`
// (Tailwind lets one anywhere in the imported graph win over a positive
// `@source`), and the app's exclusions live in a separate entry file that
// imports the base. This module reads that layout from the config and the
// files; it writes nothing.

import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { compare, compileGlobs, globToRegExp } from './glob.mjs'
import { createResolver, extractImports, isStoryFile, isTestFile } from './source.mjs'

const SOURCE_EXT = /\.(?:tsx?|jsx?|mjs|cjs|mts|cts|vue|svelte|astro)$/
const isSource = (file) => SOURCE_EXT.test(file) && !/\.d\.[cm]?ts$/.test(file)
// The lane's HTML entry at the repo root, as the Vite plugin reads it by default.
const LANE_HTML = 'stories.html'

// Comments blanked out, newlines kept, so a line number still counts. A
// string is skipped whole: a glob such as "gen/**/*.ts" holds a "/**/".
const blankComments = (css) => css.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\/\*[\s\S]*?\*\//g, (m, str) => str ?? m.replace(/[^\n]/g, ' '))

// A glob as written in a stylesheet, as a repo-relative path from the file that declares it.
const fromDeclaringFile = (raw, cssFile) => (raw.startsWith('/') ? raw.replace(/^\/+/, '') : posix.normalize(posix.join(posix.dirname(cssFile), raw)))

// The `@source not "<glob>"` lines of a stylesheet, as { file, line, raw,
// glob }: `raw` as written and `glob` resolved from the declaring file (a
// repo-relative path). `@source not inline(...)` is a safelist rule, not an
// exclusion, and is not read.
export function sourceNotLines(cssText, cssFile) {
  const css = blankComments(cssText)
  const out = []
  for (const m of css.matchAll(/@source\s+not\s+(['"])([^'"\n]*)\1\s*;/g)) {
    out.push({ file: cssFile, line: css.slice(0, m.index).split('\n').length, raw: m[2], glob: fromDeclaringFile(m[2], cssFile) })
  }
  return out
}

// The relative stylesheets a stylesheet imports, as repo-relative paths.
function cssImports(cssText, cssFile) {
  const out = []
  for (const m of blankComments(cssText).matchAll(/@import\s+(?:url\(\s*)?(['"])([^'"\n]+)\1/g)) {
    if (m[2].startsWith('./') || m[2].startsWith('../')) out.push(fromDeclaringFile(m[2], cssFile))
  }
  return out
}

// Every `@source not` line in a stylesheet and the relative stylesheets it
// imports, however deep. A file that is missing is skipped.
function notLinesOfGraph(root, cssFile, seen = new Set()) {
  if (seen.has(cssFile)) return []
  seen.add(cssFile)
  let text
  try {
    text = readFileSync(join(root, cssFile), 'utf8')
  } catch {
    return []
  }
  return [...sourceNotLines(text, cssFile), ...cssImports(text, cssFile).flatMap((f) => notLinesOfGraph(root, f, seen))]
}

// Whether any of the lines drops `file`: its glob matches the path, or names a folder above it.
const excludedBy = (lines, file) => lines.some((l) => globToRegExp(l.glob).test(file) || file.startsWith(`${l.glob.replace(/\/+$/, '')}/`))

// The module scripts an HTML page at the repo root loads, as repo-relative
// paths. A page that is missing loads nothing.
function moduleScripts(root, html) {
  let text
  try {
    text = readFileSync(join(root, html), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const m of text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b([^>]*)>/gi)) {
    if (!/\btype\s*=\s*["']?module\b/i.test(m[1])) continue
    const src = /\bsrc\s*=\s*(["'])([^"']+)\1/i.exec(m[1])?.[2].replace(/[?#].*$/, '')
    if (!src || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(src)) continue
    out.push(src.startsWith('/') ? src.replace(/^\/+/, '') : posix.normalize(posix.join(posix.dirname(html), src)))
  }
  return out
}

// The import graph of the source files: who is a story or a test, what each
// imports at run time, the story-only set, and the lane's scaffold folder. A
// type-only import is not an edge, since the app takes nothing from it at
// run time.
function sourceGraph({ root, config, files, resolver }) {
  // The resolver is built on first use, so no files means no disk read.
  let built = null
  const resolve = resolver ?? ((from, spec) => (built ??= createResolver(root, config))(from, spec))
  const isStoryPath = compileGlobs(config?.stories?.include ?? [])
  // `stories` holds story files and tests, which are never app code; `own`
  // holds the story files alone, since only they make a module story-only.
  const stories = new Set()
  const own = new Set()
  const sources = []
  for (const file of files ?? []) {
    if (!isSource(file)) continue
    sources.push(file)
    const test = isTestFile(file)
    if (!test && (isStoryFile(file) || isStoryPath(file))) own.add(file)
    if (test || own.has(file)) stories.add(file)
  }
  const imports = new Map()
  const importers = new Map()
  for (const file of sources) {
    let text = ''
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      // an unreadable file imports nothing
    }
    const targets = new Set()
    for (const imp of extractImports(text, file)) {
      if (imp.typeOnly) continue
      const hit = resolve(file, imp.spec)
      if (hit.file && isSource(hit.file) && hit.file !== file) targets.add(hit.file)
    }
    imports.set(file, targets)
    for (const target of targets) (importers.get(target) ?? importers.set(target, new Set()).get(target)).add(file)
  }
  // Every module that story files and the lane's own files (`starts`) reach
  // at run time through modules that are not stories or tests, less each
  // one with an importer that is neither a story, a test nor still a member,
  // until none is left to drop. So a module that app code also imports never
  // gets in, nor does what only it imports; a module only tests import is
  // test support and stays out; a cycle that only stories reach gets in
  // whole, and a cycle nothing outside reaches stays out.
  const storyOnlyFrom = (starts) => {
    const only = new Set(starts.filter((f) => !stories.has(f)))
    const queue = [...own, ...only]
    while (queue.length > 0) {
      for (const target of imports.get(queue.pop()) ?? []) {
        if (stories.has(target) || only.has(target)) continue
        only.add(target)
        queue.push(target)
      }
    }
    for (let shrank = true; shrank; ) {
      shrank = false
      for (const file of only) {
        if ([...(importers.get(file) ?? [])].some((f) => !stories.has(f) && !only.has(f))) {
          only.delete(file)
          shrank = true
        }
      }
    }
    return only
  }

  // The lane's own files: the module script of its HTML entry and the frame,
  // and the scaffold folder that holds the script (`src/stories/` in the
  // recipe), whose files are all the lane's. The folder is not taken when it
  // is the repo root, holds the module script of another page at the root
  // (the app's own entry, which nothing imports), or holds a file that app
  // code imports at run time; then the script and the frame count alone.
  const known = new Set(sources)
  const scripts = known.size === 0 ? [] : moduleScripts(root, LANE_HTML).filter((f) => known.has(f))
  const frame = typeof config?.stories?.frame === 'string' ? config.stories.frame.replace(/^\.?\/+/, '') : null
  const seeds = [...scripts, ...(frame && known.has(frame) ? [frame] : [])]
  const folder = scripts.length > 0 ? posix.dirname(scripts[0]) : '.'
  const inFolder = (file) => file.startsWith(`${folder}/`)
  const pages = (files ?? []).filter((f) => !f.includes('/') && /\.html?$/i.test(f) && f !== LANE_HTML)
  let scaffold = folder !== '.' && !pages.some((page) => moduleScripts(root, page).some(inFolder)) ? folder : null
  let only = scaffold === null ? null : storyOnlyFrom([...seeds, ...sources.filter(inFolder)])
  if (scaffold !== null && !sources.filter(inFolder).every((f) => stories.has(f) || only.has(f))) scaffold = null
  if (scaffold === null) only = storyOnlyFrom(seeds)

  const declared = compileGlobs(config?.stories?.storyOnly ?? [])
  for (const file of sources) if (!stories.has(file) && declared(file)) only.add(file)
  return { sources, stories, imports, only, scaffold }
}

// What only stories use, as { modules, scaffold }. `modules` holds, as
// sorted repo-relative paths, the source files that are not stories or tests
// and that story files or the lane's own files reach, imported by nothing
// else (see above), plus whatever `stories.storyOnly` globs add. `scaffold`
// is the lane's scaffold folder, every file of which is the lane's, or null.
// `files` is every repo file.
export function storyOnly({ root, config, files, resolver } = {}) {
  const graph = sourceGraph({ root, config, files, resolver })
  return { modules: [...graph.only].sort(compare), scaffold: graph.scaffold }
}

// The modules of `storyOnly`, as sorted repo-relative paths.
export function storyOnlyModules({ root, config, files, resolver } = {}) {
  return storyOnly({ root, config, files, resolver }).modules
}

// What is wrong with the CSS layout, as { rule, file, detail } (and
// `severity: 'warn'` for a fault that only warns). Nothing is checked until
// `stories.appCss` names the base CSS.
//   css-base        the base CSS, or a sheet it imports, holds a `@source not`
//   css-app-import  app code imports a story-only module, or a file the entry CSS excludes
//   css-uncovered   (warn) a story-only module, or a file of the lane's
//                   scaffold folder, the entry CSS does not exclude
export function cssLayoutProblems({ root, config, files, resolver } = {}) {
  const appCss = config?.stories?.appCss
  if (!appCss || typeof appCss.base !== 'string') return []
  const base = appCss.base
  const entry = typeof appCss.entry === 'string' ? appCss.entry : null
  const out = []
  const add = (rule, file, detail, severity = 'error') => out.push({ rule, file, detail, ...(severity === 'warn' ? { severity } : {}) })

  if (!existsSync(join(root, base))) add('css-base', base, 'it does not exist, so the lane has no CSS to import')
  for (const l of notLinesOfGraph(root, base)) {
    add('css-base', l.file, `line ${l.line} has @source not "${l.raw}", which would drop those files from the lane's CSS as well; keep it in the app's entry CSS${entry ? ` (${entry})` : ''}`)
  }

  const graph = sourceGraph({ root, config, files, resolver })
  let excluded = () => false
  if (entry !== null) {
    if (!existsSync(join(root, entry))) add('css-base', entry, 'it does not exist, so the app has no entry CSS')
    const lines = notLinesOfGraph(root, entry)
    excluded = (file) => excludedBy(lines, file)
    // The scaffold folder is one warning, since one line excludes it.
    const scaffold = graph.scaffold
    const inScaffold = (file) => scaffold !== null && file.startsWith(`${scaffold}/`)
    if (graph.sources.some((file) => inScaffold(file) && !graph.stories.has(file) && !excluded(file))) {
      add('css-uncovered', scaffold, `the lane's scaffold is here, but ${entry} does not exclude it from the app's CSS`, 'warn')
    }
    for (const file of [...graph.only].sort(compare)) {
      if (!inScaffold(file) && !excluded(file)) add('css-uncovered', file, `only stories use it, but ${entry} does not exclude it from the app's CSS`, 'warn')
    }
  }
  for (const file of graph.sources) {
    if (graph.stories.has(file) || graph.only.has(file) || excluded(file)) continue
    for (const target of [...graph.imports.get(file)].sort(compare)) {
      if (graph.only.has(target)) add('css-app-import', file, `it imports ${target}, which only stories use`)
      else if (excluded(target)) add('css-app-import', file, `it imports ${target}, which ${entry} excludes from the app's CSS`)
    }
  }
  return out.sort((a, b) => compare(a.rule, b.rule) || compare(a.file, b.file) || compare(a.detail, b.detail))
}

// The class names a stylesheet's selectors use, unescaped, as a Set. Only
// rule preludes are read, so a decimal in a value or a name in a url() is not
// taken for a class.
export function cssClasses(cssText) {
  const css = blankComments(cssText)
    .replace(/(['"])(?:\\[\s\S]|(?!\1)[^\\\n])*\1/g, '""')
    .replace(/url\([^)]*\)/g, 'url()')
  const out = new Set()
  for (const m of css.matchAll(/(?<=^|[;{}])([^;{}]*)\{/g)) {
    const prelude = m[1].trim()
    if (prelude.startsWith('@')) continue
    for (const c of prelude.matchAll(/\.((?:\\(?:[0-9a-fA-F]{1,6}\s?|[\s\S])|[\w\u0080-￿-])+)/g)) {
      out.add(c[1].replace(/\\(?:([0-9a-fA-F]{1,6})\s?|([\s\S]))/g, (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch)))
    }
  }
  return out
}

// The words in a source file that could be class names: whatever sits
// between whitespace, quotes, brackets of JSX and template syntax.
export function sourceWords(text) {
  return new Set(text.split(/[\s"'`{}=;<>|\\$]+/).filter(Boolean))
}
