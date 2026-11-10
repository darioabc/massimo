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

// The files the vite-csf recipe writes as they are, which name the tool they
// replace on purpose (its root element, its ids, its links): the lane's HTML
// entry and Vite config at the root, and the shell, canvas, story types and
// declarations beside the entry's module script, as repo-relative paths, the
// ones that exist only. A project's own files there, such as the frame, are
// not among them.
const RECIPE_FILES = ['main.tsx', 'Shell.tsx', 'Canvas.tsx', 'story.ts', 'massimo.d.ts']
export function recipeFiles(root) {
  const [script] = moduleScripts(root, LANE_HTML)
  if (!script) return []
  const folder = posix.dirname(script)
  const inFolder = RECIPE_FILES.map((f) => (folder === '.' ? f : `${folder}/${f}`))
  return [LANE_HTML, 'vite.stories.config.ts', ...inFolder].filter((f) => existsSync(join(root, f))).sort(compare)
}

// The files only the csf recipe writes beside the entry's module script. A
// lane of the repo's own, or one the native recipe wrote, has a main.tsx and
// may have a story.ts, but none of these.
const CSF_ONLY = new Set(['Shell.tsx', 'Canvas.tsx', 'massimo.d.ts'])

// The folder of the csf lane's scaffold, as a repo-relative path, or null:
// the folder beside the entry's module script, once the config sets
// stories.lane to "csf" and that folder holds a file only the csf recipe
// writes (its shell, canvas or declarations). The native recipe writes the
// entry and main.tsx too, so neither counts, and without the opt-in no folder
// is taken. A lane found in this folder is massimo's own output, written from
// the recipe, not a lane the repo had.
export function csfScaffold(root, config) {
  if (config?.stories?.lane !== 'csf') return null
  const file = recipeFiles(root).find((f) => posix.dirname(f) !== '.' && CSF_ONLY.has(posix.basename(f)))
  return file ? posix.dirname(file) : null
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

// ── class names in CSS ───────────────────────────────────────────────────────

// A CSS escape, and a class name as a selector writes it, escapes kept.
const ESCAPE = String.raw`\\(?:[0-9a-fA-F]{1,6}\s?|[\s\S])`
const NAME_CHAR = String.raw`(?:${ESCAPE}|[\w\u0080-￿-])`
const IDENT = String.raw`(?:--|-?(?:${ESCAPE}|[A-Za-z_\u0080-￿]))${NAME_CHAR}*`

const unescape = (name) =>
  name.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|([\s\S]))/g, (_, hex, ch) => {
    if (!hex) return ch
    const code = parseInt(hex, 16)
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '�' : String.fromCodePoint(code)
  })

// A stylesheet with comments blanked, strings and unquoted url() emptied,
// and every escape kept whole, so a quote or brace a class name escapes, as
// in `.before\:content-\[\'\'\]`, stays part of the name.
const plainCss = (cssText) =>
  cssText.replace(/\\[\s\S]|\/\*[\s\S]*?\*\/|(["'])(?:\\[\s\S]|(?!\1)[^\\\n])*\1|\burl\((?!\s*["'])(?:\\[\s\S]|[^)\\])*\)/gi, (m, quote) => (m[0] === '\\' ? m : quote ? '""' : m[0] === '/' ? ' ' : 'url()'))

// The class names a selector names, anywhere in it, unescaped. An escape or
// an attribute selector is passed over whole, so neither starts a name. An
// escape inside the brackets is passed over one character at a time, so a
// bracket that never closes costs no more than its length.
const CLASS = new RegExp(String.raw`${ESCAPE}|\[(?:\\[\s\S]|[^\]\\])*\]|\.(${IDENT})`, 'g')
const classesIn = (selector) => [...selector.matchAll(CLASS)].filter((m) => m[1]).map((m) => unescape(m[1]))

// The style rules of a stylesheet, in order, as { prelude, parent, ats }:
// `parent` is the style rule a nested rule sits in, or null, and `ats` names
// the at-rules around it, outermost first. Only rule preludes are read, so a
// decimal in a value or a name in a url() is not taken for a class, and the
// steps of a @keyframes are no style rules.
function styleRules(cssText) {
  const css = plainCss(cssText)
  const rules = []
  const stack = []
  let start = 0
  for (const m of css.matchAll(/\\[\s\S]|[{};]/g)) {
    if (m[0].length > 1) continue
    const prelude = css.slice(start, m.index).trim()
    start = m.index + 1
    if (m[0] === '}') stack.pop()
    if (m[0] !== '{') continue
    const outer = stack[stack.length - 1] ?? { ats: [], rule: null }
    if (prelude.startsWith('@')) {
      stack.push({ ats: [...outer.ats, (/^@([\w-]+)/.exec(prelude)?.[1] ?? '').toLowerCase()], rule: outer.rule })
      continue
    }
    const rule = { prelude, parent: outer.rule, ats: outer.ats }
    if (!outer.ats.some((at) => at.endsWith('keyframes'))) rules.push(rule)
    stack.push({ ats: outer.ats, rule })
  }
  return rules
}

// A selector list split at its top-level commas.
function selectorList(text) {
  const out = []
  let depth = 0
  let last = 0
  for (const m of text.matchAll(/\\[\s\S]|[()[\],]/g)) {
    if (m[0] === '(' || m[0] === '[') depth += 1
    else if (m[0] === ')' || m[0] === ']') depth = Math.max(0, depth - 1)
    else if (m[0] === ',' && depth === 0) {
      out.push(text.slice(last, m.index).trim())
      last = m.index + 1
    }
  }
  out.push(text.slice(last).trim())
  return out.filter(Boolean)
}

// A rule's selectors with nesting resolved: `&` stands for each selector of
// the rule around it, and a selector with no `&` sits inside that rule.
function selectorsOf(rule, memo) {
  if (!memo.has(rule)) {
    const own = selectorList(rule.prelude)
    const nested = (parent) => own.map((s) => (s.replace(/\\[\s\S]/g, '').includes('&') ? s.replace(/\\[\s\S]|&/g, (m) => (m === '&' ? parent : m)) : `${parent} ${s}`))
    memo.set(rule, rule.parent === null ? own : selectorsOf(rule.parent, memo).flatMap(nested))
  }
  return memo.get(rule)
}

// The index of the bracket that closes one opened just before `from`, or -1.
function closer(text, from, open, close) {
  let depth = 1
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1
    else if (text[i] === open) depth += 1
    else if (text[i] === close && (depth -= 1) === 0) return i
  }
  return -1
}

// A complex selector as its compounds, each a list of { kind, name, args }:
// kind 'class', 'pseudo' (a pseudo-class or pseudo-element, `args` what its
// brackets hold), 'any' (`*`) or 'other' (a type, id or attribute). Null
// when it does not read, as an `&` with no rule around it.
const PART = new RegExp(String.raw`(\s*[>+~]\s*|\s+)|\.(${IDENT})|::?(${IDENT})(\()?|(\*)|(#${NAME_CHAR}+|${IDENT})|(\[)`, 'y')
function compoundsOf(selector) {
  const out = [[]]
  let i = 0
  while (i < selector.length) {
    PART.lastIndex = i
    const m = PART.exec(selector)
    if (m === null) return null
    i = PART.lastIndex
    const here = out[out.length - 1]
    if (m[1] !== undefined) out.push([])
    else if (m[2] !== undefined) here.push({ kind: 'class', name: unescape(m[2]) })
    else if (m[3] !== undefined) {
      let args = null
      if (m[4]) {
        const end = closer(selector, i, '(', ')')
        if (end === -1) return null
        args = selector.slice(i, end)
        i = end + 1
      }
      here.push({ kind: 'pseudo', name: m[3].toLowerCase(), args })
    } else if (m[5] !== undefined) here.push({ kind: 'any' })
    else if (m[6] !== undefined) here.push({ kind: 'other' })
    else {
      const end = closer(selector, i, '[', ']')
      if (end === -1) return null
      i = end + 1
      here.push({ kind: 'other' })
    }
  }
  return out.filter((c) => c.length > 0)
}

// The selectors a selector that is one :is() or :where() holds, or null.
function heldList(compounds) {
  const lone = compounds.length === 1 && compounds[0].length === 1 ? compounds[0][0] : null
  return lone?.kind === 'pseudo' && lone.args !== null && (lone.name === 'is' || lone.name === 'where') ? selectorList(lone.args) : null
}

// The class a complex selector is the own rule of, as a list of none or one:
// the selector names that class and no other, the class's compound holds
// nothing else but pseudo-classes and pseudo-elements, and any other compound
// holds nothing but those or `*`, as Tailwind's `:where(.space-x-4 >
// :not(:last-child))` does. A selector that is one :is() or :where() is read
// as the list it holds.
function ownIn(selector) {
  const compounds = compoundsOf(selector)
  if (compounds === null || compounds.length === 0) return []
  const list = heldList(compounds)
  if (list !== null) return list.flatMap(ownIn)
  const named = new Set(classesIn(selector))
  const home = compounds.filter((c) => c.some((p) => p.kind === 'class'))
  if (named.size !== 1 || home.length !== 1 || home[0].filter((p) => p.kind === 'class').length !== 1) return []
  const holds = (compound, kinds) => compound.every((p) => kinds.includes(p.kind))
  if (!holds(home[0], ['class', 'pseudo']) || !compounds.every((c) => c === home[0] || holds(c, ['pseudo', 'any']))) return []
  return [...named]
}

// Whether a variant class's name names the class `other`: each piece of it
// between slashes occurs in the name, and not inside a longer run of letters
// and digits, as `group` and `item` do in `group-hover/item:flex`.
const WORD_CHAR = /[A-Za-z0-9]/
function namesClass(name, other) {
  return other.split('/').filter(Boolean).every((piece) => {
    for (let at = name.indexOf(piece); at !== -1; at = name.indexOf(piece, at + 1)) {
      if (!WORD_CHAR.test(name[at - 1] ?? '') && !WORD_CHAR.test(name[at + piece.length] ?? '')) return true
    }
    return false
  })
}

// The classes with a variant a complex selector holds, as a list: each one a
// compound names, when every other class a compound names is one its variant
// names, as `.group` is for `.group:hover .group-hover\:flex`. So a package's
// sheet that scopes one under its own class, as in `.widget
// .hover\:opacity-90:hover`, holds none. A class inside a pseudo-class's
// brackets, as in Tailwind 4's `:where(.group)`, is the variant's. A selector
// that is one :is() or :where() is read as the list it holds, and one that
// does not read holds every class with a variant it names.
function variantsIn(selector) {
  const compounds = compoundsOf(selector)
  if (compounds === null) return classesIn(selector).filter((name) => name.includes(':'))
  const list = heldList(compounds)
  if (list !== null) return list.flatMap(variantsIn)
  const names = compounds.flat().filter((p) => p.kind === 'class').map((p) => p.name)
  return names.filter((name) => name.includes(':') && names.every((other) => other === name || namesClass(name, other)))
}

// The at-rules a rule of a class's own may sit in.
const WRAPPERS = new Set(['media', 'supports', 'layer', 'container'])

// The class names a stylesheet's selectors name, unescaped, as a Set.
export function cssClasses(cssText) {
  const out = new Set()
  for (const rule of styleRules(cssText)) for (const name of classesIn(rule.prelude)) out.add(name)
  return out
}

// The classes a stylesheet holds, unescaped, as a Set: each class that has a
// rule of its own (see ownIn), at the top level or inside @media, @supports,
// @layer or @container. A class a package's sheet scopes under its own, as
// in `.widget .note`, or a component library names beside another, as in
// `.tooltip.tooltip-open`, is not held. A class whose name carries a variant
// (an escaped colon, as in `.md\:p-4` or `.\[\&\>div\]\:static`) is held
// beside the classes its variant names and inside any at-rule (see
// variantsIn), since its variant is what puts other selectors and at-rules
// around it; under a package's class it is not held either.
export function ownClasses(cssText) {
  const out = new Set()
  const memo = new Map()
  for (const rule of styleRules(cssText)) {
    const selectors = selectorsOf(rule, memo)
    for (const selector of selectors) for (const name of variantsIn(selector)) out.add(name)
    if (!rule.ats.every((at) => WRAPPERS.has(at))) continue
    for (const selector of selectors) for (const name of ownIn(selector)) if (!name.includes(':')) out.add(name)
  }
  return out
}

// A class with square brackets, as Tailwind reads one inside a class
// string: from the start of a word, each bracket opening the word or
// following `-`, `:`, `@`, `/` or `!`, holding anything but whitespace,
// with one level of brackets inside, as in `has-[[data-open=true]]:flex`.
const BRACKETED = /(?<![^\s"'`{}=;<>|\\$])(?:[^\s"'`{}=;<>|\\$[\]]*[-:@/!])?\[(?:[^\s[\]]|\[[^\s[\]]*\])+\](?:[^\s"'`{}=;<>|\\$[\]]*[-:@/!]\[(?:[^\s[\]]|\[[^\s[\]]*\])+\])*[^\s"'`{}=;<>|\\$[\]]*/g

// A word as Tailwind also reads it: a selector's dot, an opening parenthesis
// and the punctuation that ends a phrase are no part of a class, so
// `.p-N`, `(p-N)` and `p-N,` each name p-N too. A word with square
// brackets is left whole, since its brackets may hold any of them.
const bareWords = (word) => (word.includes('[') ? [] : word.split(',')).map((w) => w.replace(/^[.(]+/, '').replace(/[.,:)]+$/, '')).filter((w) => w !== '' && w !== word)

// The words in a source file that could be class names: whatever sits
// between whitespace, quotes, brackets of JSX and template syntax, each also
// as Tailwind reads it (see bareWords), and each class with square brackets
// whole, whose brackets may hold a quote, an `=` or a `>`, as in
// `data-[state=open]:block` or `before:content-['']`. A word that opens with
// a bracket counts when it is an arbitrary property or variant (a colon
// inside or right after the brackets), so an array or an index in code
// makes no word.
export function sourceWords(text) {
  const words = new Set()
  for (const word of text.split(/[\s"'`{}=;<>|\\$]+/)) {
    if (word === '') continue
    words.add(word)
    for (const bare of bareWords(word)) words.add(bare)
  }
  for (const [word] of text.matchAll(BRACKETED)) if (!word.startsWith('[') || /^\[[^\]]*:|\]:/.test(word)) words.add(word)
  return words
}
