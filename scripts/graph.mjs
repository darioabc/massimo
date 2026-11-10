// Design-system graph generator: reads the component source once and writes
// graph.md (one file a fresh agent can read to learn what the component system
// contains) and graph.json (the same facts for tools).
//
// Every node records what it composes, who composes it, which story covers it,
// which packages, tokens and class-library parts it leans on, the `ds:` rules it
// declares in its own header, and the ticket ids found in the file. Nothing is
// authored by hand, and the output is deterministic (sorted, no timestamps),
// so `--check` is a byte comparison a CI job can run.
//
// Usage:
//   node <project>/scripts/graph.mjs            write graph.md and graph.json
//   node <project>/scripts/graph.mjs --check    regenerate in memory, exit 1 if stale
// Shared flags: --root <dir> --config <file> --project-dir <dir>

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compare, compileGlobs, expandGlobs, walk } from './lib/glob.mjs'
import { CONFIG_FILE, fail, loadConfig, parseArgs, readJson, refuseNewer, rel, scriptCommand, warnIfVendoredOlder } from './lib/project.mjs'
import { laneRegistry } from './lib/lane.mjs'
import { headerRoles, keyRoles, knownKeys, placeFile, tierOf, tierOrder } from './lib/roles.mjs'
import {
  RULE_KEYS,
  classLibraries,
  componentName,
  createResolver,
  extractExports,
  extractImports,
  extractRules,
  isStoryFile,
  isTestFile,
  parseCustomProperties,
  stringLiterals,
  stripComments,
} from './lib/source.mjs'
import { readTokenSource } from './lib/dtcg.mjs'
import { callSiteUsage, componentProps, componentStates } from './lib/props.mjs'
import { closeBracket, componentsOf, listFaults, readCsf, readManifest, readStoryStates, slugFiles, slugPath, stateName } from './lib/stories-read.mjs'
import { natural, truthy } from './lib/text.mjs'
import { helpAndExit } from './lib/help.mjs'

helpAndExit(import.meta.url)

const COLOR_UTILITIES = 'bg|text|border|ring|outline|fill|stroke|from|via|to|divide|placeholder|caret|accent|decoration|shadow'
const STORY_EXTS = /\.(?:tsx?|jsx?|mjs|vue|svelte|astro|mdx?)$/
const CODE_EXTS = /\.(?:tsx?|jsx?|mjs|cjs|mts|cts|vue|svelte|astro)$/
const MDX_EXT = /\.mdx$/i
// A story title: Root / Group / Name.
const STORY_TITLE = /^([^/]+?) \/ ([^/]+?) \/ ([^/]+)$/
// import.meta.glob, and in group 1 the opening of its call up to the first
// argument, with or without a type argument (one level of nesting).
const GLOB_CALL = /(?<![\w$])import\.meta\.glob(?:Eager)?(?![\w$])(\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\s*\(\s*)?/g
// A string literal with no `${}`, its text in group 2.
const PLAIN_STRING = /(['"`])((?:\\.|(?!\1)[^\\\n$]|\$(?!\{))*)\1/g
const EDGE_KINDS = ['mdx', 'glob']
// Framework configs, at any depth, that wire components in by path.
const FRAMEWORK_CONFIG = /(?:^|\/)astro\.config\.[cm]?[jt]s$/
const TOKEN_GROUPS = ['color', 'spacing', 'radius', 'font', 'text', 'shadow', 'other']

const MAX_COMPONENT_LIST = 40
const MAX_FILE_LIST = 12
const MAX_STORY_LIST = 3
const STORY_QUEUE_MD = 20
const UNRESOLVED_MD = 30

const lower = (s) => s.toLowerCase()
const byName = (a, b) => compare(lower(a), lower(b)) || compare(a, b)

const sortedUnique = (iterable, cmp = compare) => [...new Set(iterable)].sort(cmp)

// The component root a class token names in a class library (`btn-primary`
// -> `btn`), or null. A bare root counts only where the string is plainly a
// class list; a utility the library lists as not a root never counts.
function rootOf(lib, token, classy) {
  if (lib.rootSet.has(token)) return classy ? token : null
  for (const root of lib.byLength) {
    if (token.startsWith(`${root}-`)) return lib.notRoots.some((re) => re.test(token)) ? null : root
  }
  return null
}

// Text just before a string that marks it as a class list (`className="`,
// `cn(`, `clsx([`...), and a token that can only be a class (`gap-2`, `md:flex`).
const CLASS_CONTEXT = /(?:\bclass(?:Name)?|classList|class:list|\btw)\s*[=:]\s*\{?\s*\[?\s*[`'"]?$|\b(?:cn|clsx|cx|twMerge|classNames|cva|tv)\s*\(\s*\[?\s*$/
const CLASS_LIKE = /[-:/\[\]]/

// A sentence, not a class list: punctuation followed by a space or the end.
const isProse = (text) => /[.,!?;](?:\s|$)/.test(text.replace(/\$\{[^}]*\}/g, ' ').trim())

// `hover:!btn-primary` -> `btn-primary`
const bareClass = (raw) => raw.slice(raw.lastIndexOf(':') + 1).replace(/^!|!$/g, '')

// The import and export lines of an MDX file, as MDX reads them: from a line
// that opens with `import` or `export` to the next blank line, so an import
// that wraps stays whole. Fenced code is skipped: an import shown in a code
// sample imports nothing.
function mdxImports(text) {
  const out = []
  let fence = null
  let open = false
  for (const line of text.split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = null
      out.push('')
      continue
    }
    if (!open && f) {
      fence = f[1]
      out.push('')
      continue
    }
    if (open && !line.trim()) open = false
    else if (!open && /^(?:import|export)\b/.test(line)) open = true
    out.push(open ? line : '')
  }
  return out.join('\n')
}

// The patterns of an import.meta.glob call whose first argument starts at
// `at`: one string, or an array of strings. Null when they are not plain
// literals, which Vite would refuse too.
function globPatterns(code, at) {
  let args
  if (code[at] === '[') {
    const close = closeBracket(code, at)
    if (close === -1) return null
    args = code.slice(at + 1, close)
  } else {
    args = new RegExp(PLAIN_STRING.source, 'y').exec(code.slice(at))?.[0]
    if (!args) return null
  }
  if (args.replace(PLAIN_STRING, '').replace(/[\s,]/g, '') !== '') return null
  return [...args.matchAll(PLAIN_STRING)].map((m) => m[2].replace(/\\(.)/g, '$1'))
}

// Area a non-node importer is grouped under: the first directory under `src/`,
// or the first directory of the path when there is no `src/`.
function areaOf(file) {
  const parts = file.replace(/^src\//, '').split('/')
  return parts.length > 1 ? parts[0] : 'root'
}

// Unique display names: basename, `index` -> parent directory, and duplicates
// prefixed with as many parent directories as it takes to tell them apart.
function assignNames(files) {
  const logical = (f) => {
    const noExt = f.replace(/\.[^./]+$/, '')
    const parts = noExt.split('/')
    if (parts[parts.length - 1] === 'index' && parts.length > 1) parts.pop()
    return parts
  }
  const names = new Map()
  const groups = new Map()
  for (const f of files) {
    const name = componentName(f)
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(f)
  }
  for (const [name, group] of groups) {
    if (group.length === 1) {
      names.set(group[0], name)
      continue
    }
    let depth = 2
    let resolved = false
    const maxDepth = Math.max(...group.map((f) => logical(f).length))
    for (; depth <= maxDepth && !resolved; depth++) {
      const candidate = group.map((f) => logical(f).slice(-depth).join('/'))
      if (new Set(candidate).size === group.length) {
        group.forEach((f, i) => names.set(f, candidate[i]))
        resolved = true
      }
    }
    if (!resolved) group.forEach((f) => names.set(f, f))
  }
  return names
}


function tokenGroup(name) {
  const first = name.replace(/^--/, '').split('-')[0]
  return TOKEN_GROUPS.includes(first) && first !== 'other' ? first : 'other'
}

// ── ds: headers ─────────────────────────────────────────────────────────────

// A comment line that opens with `ds:`, whatever follows.
const DS_LINE = /^\s*(?:\/\/+|\/\*+|\*+|<!--+|\{\/\*+)\s*ds:/
const LEADING = /^\s*(?:#!|['"]use [\w ]+['"];?\s*$)/

// The first comment block of a file as 1-based [first, last] lines, or null:
// a run of `//` lines, or one `/* */` or `<!-- -->` comment. It starts at the
// first line with something on it, after an .astro file's frontmatter fence
// or a Vue or Svelte file's opening <script> tag, and after a shebang or a
// "use client" directive.
function headerBlock(lines, file) {
  let i = 0
  const skipBlank = () => {
    while (i < lines.length && lines[i].trim() === '') i++
  }
  skipBlank()
  if (/\.astro$/i.test(file) && lines[i]?.trim() === '---') i++
  else if (/\.(?:vue|svelte)$/i.test(file) && /^<script\b[^>]*>$/i.test(lines[i]?.trim() ?? '')) i++
  skipBlank()
  while (i < lines.length && LEADING.test(lines[i])) {
    i++
    skipBlank()
  }
  const first = lines[i]?.trim() ?? ''
  const start = i
  if (first.startsWith('//')) {
    while (i < lines.length && lines[i].trim().startsWith('//')) i++
    return [start + 1, i]
  }
  const close = first.startsWith('/*') || first.startsWith('{/*') ? '*/' : first.startsWith('<!--') ? '-->' : null
  if (!close) return null
  while (i < lines.length - 1 && !lines[i].includes(close)) i++
  return [start + 1, i + 1]
}

// A file's `ds:` header as { rules, unknown, entries, problems }. 'anywhere'
// reads every comment, as massimo always has. 'top' reads the first comment
// block only, and names as problems a `ds:` line anywhere else, a key
// written with a colon, a second ds:group and a line that opens with `ds:`
// but is not `ds:key value`; each problem is { key, line, message }. In
// 'top' every `ds:` line is a line of its own, so a malformed one ends the
// value above it instead of wrapping into it.
function readHeader(source, file, keys, mode) {
  let all = extractRules(source, keys)
  if (mode !== 'top') return { ...all, problems: [] }
  const lines = source.split(/\r?\n/)
  const keyLines = new Set(all.entries.map((e) => e.line))
  const malformed = new Set(lines.flatMap((line, k) => (DS_LINE.test(line) && !keyLines.has(k + 1) ? [k + 1] : [])))
  if (malformed.size > 0) all = extractRules(lines.map((line, k) => (malformed.has(k + 1) ? '' : line)).join('\n'), keys)
  const [from, to] = headerBlock(lines, file) ?? [0, -1]
  const known = [...RULE_KEYS, ...keys.filter((k) => !RULE_KEYS.includes(k))]
  const where = /\.astro$/i.test(file) ? 'the first comment block inside the frontmatter' : 'the first comment block at the top of the file'
  const found = {}
  const unknown = []
  const entries = []
  const problems = []
  for (const e of all.entries) {
    const problem = (message) => problems.push({ key: `ds:${e.key}`, line: e.line, message })
    if (e.line < from || e.line > to) problem(`ds:${e.key} sits outside the header, ${where}; move it there`)
    else if (e.colon) problem(`ds:${e.key}: is written with a colon; write "ds:${e.key} <value>"`)
    else if (e.key === 'group' && entries.some((x) => x.key === 'group')) problem('ds:group is declared a second time; keep one')
    else {
      entries.push(e)
      if (!known.includes(e.key)) {
        if (!unknown.includes(e.key)) unknown.push(e.key)
      } else if (e.value) found[e.key] = found[e.key] ? `${found[e.key]} ${e.value}` : e.value
      else if (e.key === 'no-story' && found[e.key] === undefined) found[e.key] = ''
    }
  }
  for (const line of malformed) problems.push({ key: 'ds:', line, message: 'a line opens with ds: but is not "ds:key value"' })
  const rules = {}
  for (const key of known) if (found[key] !== undefined) rules[key] = found[key]
  return { rules, unknown, entries, problems }
}

// Whether a taxonomy knows a group: by its glossary when it has one, else by
// its tiers, else any group goes.
function knowsGroup(taxonomy, group) {
  const groups = taxonomy?.groups
  if (Array.isArray(groups) && groups.length > 0) return groups.includes(group)
  if (groups && typeof groups === 'object' && Object.keys(groups).length > 0) return Object.prototype.hasOwnProperty.call(groups, group)
  const tiers = taxonomy?.tiers
  return Array.isArray(tiers) && tiers.length > 0 ? tiers.includes(tierOf(group)) : true
}

// The taxonomy's groups as [name, line] pairs, in its order.
const glossary = (taxonomy) => {
  const groups = taxonomy?.groups
  if (Array.isArray(groups)) return groups.map((g) => [g, ''])
  return groups && typeof groups === 'object' ? Object.entries(groups).map(([g, line]) => [g, typeof line === 'string' ? line : '']) : []
}

// The placement test as { tests: [{ tier, test }], notes }: `placement` is
// { tests, notes }, or the list of tests alone; a test is { tier, test } or
// [tier, test].
function placementOf(taxonomy) {
  const p = taxonomy?.placement
  const list = Array.isArray(p) ? p : Array.isArray(p?.tests) ? p.tests : []
  const tests = list.map((t) => (Array.isArray(t) ? { tier: t[0], test: t[1] } : { tier: t?.tier, test: t?.test })).filter((t) => typeof t.tier === 'string' && typeof t.test === 'string')
  const notes = Array.isArray(p?.notes) ? p.notes.filter((n) => typeof n === 'string') : []
  return { tests, notes }
}

// Everything the graph needs, computed from source. Pure apart from reads:
// returns { json, markdown, warnings } so --check and tests can reuse it.
// A component's props with how its call sites use them, and the states it styles.
function propsAndStates(source, file, name, importers) {
  const own = componentProps(source, file, componentName(file))
  const usage = callSiteUsage(componentName(file), importers)
  const props = own.map((p) => (usage[p.name] ? { ...p, usage: usage[p.name] } : p))
  for (const [prop, values] of Object.entries(usage)) {
    if (!own.some((p) => p.name === prop)) props.push({ name: prop, from: 'usage', usage: values })
  }
  props.sort((a, b) => compare(a.name, b.name))
  return { props, states: componentStates(source, props) }
}

// ── The csf lane ────────────────────────────────────────────────────────────

const POLICY_KEYS = ['roots', 'titleParts', 'titleExact', 'titleText', 'nameMatches', 'names', 'ownStory', 'bannerByRoot', 'titlePrefix', 'cleanIds']
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const stringList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])

// Two names match when their letters and digits match, ignoring case, spaces
// and hyphens: "AiDrawer" matches "AI drawer".
const nameKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const titlePartsOf = (title) => title.split('/').map((p) => p.trim()).filter(Boolean)
const stemOfNode = (file) => (file.split('/').pop() ?? file).replace(/\.[^.]+$/, '')
// A node's file name in words, as a story beside it is titled: `ModalOverlay`
// is "Modal overlay".
const wordsOfNode = (file) => stateName({ export: stemOfNode(file) })

// stories.policy as the csf checks use it, or null when it is not set. An
// option the graph does not know, or a pattern that does not compile, is a
// warning, and that rule is left off.
function readPolicy(raw, warnings) {
  if (raw === null || raw === undefined) return null
  if (!isPlainObject(raw)) {
    warnings.push('stories.policy is an object of options, so it is ignored')
    return null
  }
  for (const key of Object.keys(raw)) if (!POLICY_KEYS.includes(key)) warnings.push(`stories.policy.${key} is not an option, so it is ignored`)
  const regex = (source, flags, where) => {
    try {
      return new RegExp(source, typeof flags === 'string' ? flags : '')
    } catch {
      warnings.push(`${where} is not a regular expression that compiles, so it is ignored`)
      return null
    }
  }
  let titleText = null
  if (isPlainObject(raw.titleText)) {
    const pattern = typeof raw.titleText.pattern === 'string' ? regex(raw.titleText.pattern, '', 'stories.policy.titleText.pattern') : null
    const forbidden = []
    for (const [i, f] of (Array.isArray(raw.titleText.forbidden) ? raw.titleText.forbidden : []).entries()) {
      const re = typeof f?.pattern === 'string' ? regex(f.pattern, f.flags, `stories.policy.titleText.forbidden[${i}]`) : null
      if (re) forbidden.push({ re, what: typeof f.what === 'string' ? f.what : `text that matches ${f.pattern}` })
    }
    titleText = { pattern, forbidden }
  }
  const ownStory = []
  for (const rule of Array.isArray(raw.ownStory) ? raw.ownStory : []) {
    const link = rule?.link ?? 'own'
    if (!isPlainObject(rule) || !['own', 'sibling'].includes(link)) {
      warnings.push('stories.policy.ownStory has an entry whose link is not "own" or "sibling", so it is ignored')
      continue
    }
    ownStory.push({ tiers: stringList(rule.tiers), files: stringList(rule.files), link })
  }
  const names = {}
  for (const [stem, name] of Object.entries(isPlainObject(raw.names) ? raw.names : {})) {
    if (typeof name === 'string') names[stem] = name
    else warnings.push(`stories.policy.names.${stem} is not a string, so it is ignored`)
  }
  const titleParts = isPlainObject(raw.titleParts) ? Object.fromEntries(Object.entries(raw.titleParts).filter(([, n]) => Number.isInteger(n))) : null
  return {
    roots: stringList(raw.roots).length > 0 ? stringList(raw.roots) : null,
    titleParts,
    titleExact: new Set(stringList(raw.titleExact)),
    titleText,
    nameMatches: raw.nameMatches === true,
    names,
    ownStory,
    bannerByRoot: isPlainObject(raw.bannerByRoot) ? Object.fromEntries(Object.entries(raw.bannerByRoot).filter(([, k]) => typeof k === 'string' && k)) : {},
    titlePrefix: (Array.isArray(raw.titlePrefix) ? raw.titlePrefix : []).filter(isPlainObject).map((r) => ({ files: stringList(r.files), prefixes: stringList(r.prefixes) })),
    cleanIds: raw.cleanIds === true,
  }
}

// Why a piece of title or state text breaks stories.policy.titleText, as
// short phrases for a sentence; empty when it is fine. `alsoWords` is the
// text in words, where a forbidden word is looked for as well, since an
// export name has none of its words apart.
function textReasons(text, rule, alsoWords = null) {
  const reasons = []
  if (rule.pattern && !rule.pattern.test(text)) reasons.push('characters or spacing that stories.policy.titleText.pattern does not allow')
  for (const { re, what } of rule.forbidden) {
    if ((re.test(text) || (alsoWords !== null && re.test(alsoWords))) && !reasons.includes(what)) reasons.push(what)
  }
  return reasons
}

export function buildGraph(root, config, command = "graph.mjs") {
  const warnings = []
  const all = walk(root, { ignore: config.ignore })
  const storyGlob = compileGlobs(config.stories.include)
  const isStory = (f) => storyGlob(f) || (isStoryFile(f) && STORY_EXTS.test(f))

  const usable = (f) => !isStory(f) && !isTestFile(f)
  const componentFiles = expandGlobs(root, config.components.include, config.components.exclude, config.ignore, all).filter(usable)
  // Node kinds beyond components (layouts, pages...): a file a kind's globs
  // match is a node of that kind, the first kind in the config winning.
  const kinds = Object.entries(config.graph?.kinds ?? {}).filter(([, globs]) => [].concat(globs ?? []).length > 0)
  const kindOf = new Map()
  for (const [kind, globs] of kinds) {
    for (const f of expandGlobs(root, [].concat(globs), config.components.exclude, config.ignore, all).filter(usable)) if (!kindOf.has(f)) kindOf.set(f, kind)
  }
  for (const f of componentFiles) if (!kindOf.has(f)) kindOf.set(f, 'component')
  const nodeFiles = kinds.length > 0 ? [...kindOf.keys()].sort(compare) : componentFiles
  const nodeSet = new Set(nodeFiles)
  const storyFiles = all.filter(isStory)
  const consumerFiles = expandGlobs(root, config.consumers, [], config.ignore, all).filter(
    (f) => !isStory(f) && !isTestFile(f) && !nodeSet.has(f),
  )

  const resolveImport = createResolver(root, config)
  // Components go by their name; a node of another kind by its path without
  // `src/` and its extension (`pages/work/index`), which reads as its route.
  const nameOf = assignNames(kinds.length > 0 ? nodeFiles.filter((f) => kindOf.get(f) === 'component') : nodeFiles)
  if (kinds.length > 0) {
    const taken = new Set(nameOf.values())
    for (const f of nodeFiles.filter((x) => kindOf.get(x) !== 'component')) {
      const name = f.replace(/^src\//, '').replace(/\.[^./]+$/, '')
      nameOf.set(f, taken.has(name) ? f : name)
      taken.add(nameOf.get(f))
    }
  }
  const edgeKinds = new Set([].concat(config.graph?.edges ?? []))
  for (const kind of edgeKinds) {
    if (!EDGE_KINDS.includes(kind)) warnings.push(`graph.edges lists "${kind}"; its values are "mdx" and "glob", so that one adds no edges`)
  }

  // Every file an import.meta.glob call in `code` matches, its patterns read
  // relative to the file, from the root or through the aliases; a `!`
  // pattern takes its matches back out, as Vite does. A call or a pattern
  // it cannot follow is a warning, never a silent gap.
  function globTargets(file, code) {
    const out = new Set()
    for (const m of code.matchAll(GLOB_CALL)) {
      const patterns = m[1] === undefined ? null : globPatterns(code, m.index + m[0].length)
      if (!patterns) {
        warnings.push(`${file}: an import.meta.glob call whose patterns cannot be read as plain strings, so the files it loads are not edges`)
        continue
      }
      const keep = []
      const drop = []
      for (const pattern of patterns) {
        const negated = pattern.startsWith('!')
        const path = resolveImport.pathOf(file, negated ? pattern.slice(1) : pattern)
        if (path) (negated ? drop : keep).push(path)
        else warnings.push(`${file}: the import.meta.glob pattern "${pattern}" is not relative, from the root, through an alias or under a tsconfig baseUrl, so it matches nothing`)
      }
      const take = compileGlobs(keep)
      const leave = compileGlobs(drop)
      for (const f of all) if (f !== file && take(f) && !leave(f)) out.add(f)
    }
    return [...out]
  }

  // Parse a file once: its resolved imports and, lazily, its exports. An MDX
  // file is read for its import lines when graph.edges asks for it.
  const infoCache = new Map()
  function infoOf(file) {
    let info = infoCache.get(file)
    if (info !== undefined) return info
    info = null
    const mdx = edgeKinds.has('mdx') && MDX_EXT.test(file)
    if (CODE_EXTS.test(file) || mdx) {
      const text = readFileSync(join(root, file), 'utf8')
      const source = mdx ? mdxImports(text) : text
      const parseAs = mdx ? file.replace(MDX_EXT, '.mjs') : file
      const edges = []
      const unresolved = []
      const packages = []
      const reexports = []
      for (const imp of extractImports(source, parseAs)) {
        const hit = resolveImport(file, imp.spec)
        if (hit.unresolved) unresolved.push(hit.unresolved)
        if (imp.typeOnly) continue
        if (hit.pkg) packages.push(hit.pkg)
        if (!hit.file) continue
        if (imp.kind === 'export-from') reexports.push({ file: hit.file, ...imp.reexport })
        else edges.push({ file: hit.file, names: imp.names })
      }
      if (edgeKinds.has('glob')) for (const target of globTargets(file, stripComments(source, parseAs))) edges.push({ file: target, names: ['*'] })
      let exportsCache = null
      info = { edges, unresolved, packages, reexports, exportNames: () => (exportsCache ??= extractExports(source, parseAs)) }
    }
    infoCache.set(file, info)
    return info
  }

  // Which graph nodes does importing `names` from `target` reach? The target
  // itself when it is a node, plus whatever a barrel file re-exports under
  // those names.
  function reach(target, names) {
    const out = new Set()
    const seen = new Set()
    const visit = (file, wanted, depth) => {
      if (nodeSet.has(file)) out.add(file)
      if (depth > 4 || seen.has(file)) return
      seen.add(file)
      const info = infoOf(file)
      if (!info) return
      const wantsAll = wanted.includes('*')
      for (const r of info.reexports) {
        if (r.ns) {
          if (wantsAll || wanted.includes(r.ns)) visit(r.file, ['*'], depth + 1)
        } else if (r.star) {
          const known = infoOf(r.file)?.exportNames() ?? []
          const exposed = [...known, componentName(r.file)]
          if (wantsAll || wanted.some((n) => exposed.includes(n))) visit(r.file, wanted, depth + 1)
        } else {
          const hit = r.pairs.filter((p) => wantsAll || wanted.includes(p.name))
          if (hit.length > 0) visit(r.file, hit.map((p) => p.orig), depth + 1)
        }
      }
    }
    visit(target, names, 0)
    return out
  }

  // Importer -> nodes it uses, for nodes and consumers; story -> nodes it covers.
  const importersOf = new Map(nodeFiles.map((f) => [f, new Set()]))
  const composes = new Map(nodeFiles.map((f) => [f, new Set()]))
  const packages = new Map(nodeFiles.map((f) => [f, new Set()]))
  const unresolved = new Map()
  for (const file of [...nodeFiles, ...consumerFiles]) {
    const info = infoOf(file)
    if (!info) continue
    for (const spec of info.unresolved) {
      if (!unresolved.has(spec)) unresolved.set(spec, new Set())
      unresolved.get(spec).add(file)
    }
    if (nodeSet.has(file)) for (const pkg of info.packages) packages.get(file).add(pkg)
    for (const edge of info.edges) {
      for (const target of reach(edge.file, edge.names)) {
        if (target === file) continue
        importersOf.get(target).add(file)
        if (nodeSet.has(file)) composes.get(file).add(target)
      }
    }
  }
  // A framework config that names a component file in a quoted relative
  // path wires it in (Astro's `components: { Head: './src/components/Head.astro' }`),
  // so the config counts as a file that uses it.
  for (const wiring of all.filter((f) => FRAMEWORK_CONFIG.test(f))) {
    for (const { text: spec } of stringLiterals(readFileSync(join(root, wiring), 'utf8'), wiring)) {
      if (!/^\.\.?\//.test(spec)) continue
      const hit = resolveImport(wiring, spec)
      if (hit.file && nodeSet.has(hit.file) && hit.file !== wiring) importersOf.get(hit.file).add(wiring)
    }
  }

  const storiesOf = new Map(nodeFiles.map((f) => [f, new Set()]))
  const stemOf = (f) => f.replace(/\.(?:stories|story)\.[^./]+$/, '')
  const nodeByStem = new Map(nodeFiles.map((f) => [f.replace(/\.[^./]+$/, ''), f]))
  for (const story of storyFiles) {
    const info = infoOf(story)
    if (info) {
      for (const spec of info.unresolved) {
        if (!unresolved.has(spec)) unresolved.set(spec, new Set())
        unresolved.get(spec).add(story)
      }
      for (const edge of info.edges) for (const target of reach(edge.file, edge.names)) storiesOf.get(target)?.add(story)
    }
    const sibling = nodeByStem.get(stemOf(story))
    if (sibling) storiesOf.get(sibling).add(story)
  }

  // The nodes some story files import, directly or through the lane's own
  // helpers (story files that are not nodes) they import.
  function storyNodes(files) {
    const out = new Set()
    const seen = new Set()
    const queue = [...files]
    while (queue.length > 0) {
      const f = queue.shift()
      if (seen.has(f)) continue
      seen.add(f)
      for (const edge of infoOf(f)?.edges ?? []) {
        for (const target of reach(edge.file, edge.names)) out.add(target)
        if (!nodeSet.has(edge.file) && isStory(edge.file)) queue.push(edge.file)
      }
    }
    return out
  }

  // A lane that lists its stories in a manifest, read as text. An entry
  // covers directly the nodes its page and frame import and the files it
  // names; what those nodes compose, it covers incidentally.
  function readLane() {
    const { manifest, pages, frames } = config.stories
    const fileSet = new Set(all)
    const pageOf = (slug) => (pages ? slugPath(pages, slug) : null)
    const frameOf = (slug) => (frames ? slugPath(frames, slug) : null)
    const fileByName = new Map(nodeFiles.map((f) => [nameOf.get(f), f]))
    const lane = {
      manifest,
      entries: [],
      skipped: [],
      unreadable: [],
      states: 0,
      // Each page's state blocks, read once.
      blocks: new Map(),
      direct: new Map(nodeFiles.map((f) => [f, new Set()])),
      incidental: new Map(nodeFiles.map((f) => [f, new Set()])),
      pagesOf: new Map(nodeFiles.map((f) => [f, new Set()])),
      pageOf,
      frameOf,
      fileSet,
    }
    if (!fileSet.has(manifest)) return lane
    const read = readManifest(readFileSync(join(root, manifest), 'utf8'), manifest)
    lane.entries = read.entries
    lane.skipped = read.unreadable
    // A manifest unreadable as a whole is a problem of its own (laneProblems).
    for (const u of read.unreadable) if (u.entry !== null) lane.unreadable.push({ file: manifest, detail: u.slug ? `${u.slug}: ${u.detail}` : u.detail })
    for (const entry of lane.entries) {
      if (typeof entry?.slug !== 'string') continue
      const page = pageOf(entry.slug)
      const covered = storyNodes([page, frameOf(entry.slug)].filter((f) => f && fileSet.has(f)))
      for (const c of componentsOf(entry)) {
        const f = nodeSet.has(c) ? c : fileByName.get(c)
        if (f) covered.add(f)
      }
      const reached = new Set()
      const queue = [...covered]
      while (queue.length > 0) {
        for (const child of composes.get(queue.shift())) {
          if (covered.has(child) || reached.has(child)) continue
          reached.add(child)
          queue.push(child)
        }
      }
      const shown = page && fileSet.has(page) ? page : manifest
      for (const n of covered) {
        lane.direct.get(n).add(entry.slug)
        lane.pagesOf.get(n).add(shown)
      }
      for (const n of reached) lane.incidental.get(n).add(entry.slug)
      if (page && fileSet.has(page) && !lane.blocks.has(page)) {
        lane.blocks.set(page, readStoryStates(readFileSync(join(root, page), 'utf8')))
        lane.states += lane.blocks.get(page).length
      }
    }
    return lane
  }

  // What the lane's checks find, each { rule, file, detail }, sorted, with
  // no line numbers so a ratchet can key on them:
  //   story-title   a title that is not Root / Group / Name under its root and
  //                 group fields, a place that is not its component's group, or
  //                 no component outside stories.componentless
  //   story-files   an entry without its page, a page or frame without an
  //                 entry, a frame flag and a frame file that disagree
  //   story-states  a states list that is not the page's state labels, in
  //                 order, and a state with no label on a page whose entry
  //                 lists its states (reported against the page)
  //   no-story      a live node with no direct story and no ds:no-story
  // `file` is the manifest, the page with no entry, or the node with no story.
  // A field the manifest does not hold as a literal is not checked. A
  // manifest that cannot be read at all is one story-files problem, like a
  // missing one, marked `whole`, and nothing is checked against it. While an
  // entry's component cannot be read, any node could be the one it covers,
  // so no-story is not checked, and `lane.notChecked` says why.
  function laneProblems(lane, nodes, live) {
    const { manifest, pageOf, frameOf, fileSet } = lane
    const out = []
    const add = (rule, file, detail) => out.push({ rule, file, detail })
    if (!fileSet.has(manifest)) {
      out.push({ rule: 'story-files', file: manifest, detail: `stories.manifest names ${manifest}, which does not exist`, whole: true })
      return out
    }
    // With no entries read, every page would look like an orphan and every
    // live node like one with no story.
    const whole = lane.skipped.find((u) => u.entry === null)
    if (whole) {
      out.push({ rule: 'story-files', file: manifest, detail: whole.detail, whole: true })
      return out
    }
    const byFile = new Map(nodes.map((n) => [n.file, n]))
    const byName = new Map(nodes.map((n) => [n.name, n]))
    const roots = Array.isArray(taxonomy?.tiers) && taxonomy.tiers.length > 0 ? taxonomy.tiers : null
    const componentless = [].concat(config.stories.componentless ?? [])
    const skipped = new Map()
    for (const u of lane.skipped) {
      if (u.entry === null) continue
      if (!skipped.has(u.entry)) skipped.set(u.entry, new Set())
      skipped.get(u.entry).add(u.field)
    }
    lane.entries.forEach((entry, index) => {
      if (!entry) return
      const unread = skipped.get(index) ?? new Set()
      const slug = typeof entry.slug === 'string' ? entry.slug : null
      const where = slug ?? `an entry with no slug (${JSON.stringify(entry.title ?? '')})`
      if (!['title', 'root', 'group', 'component', '...'].some((f) => unread.has(f))) {
        const title = typeof entry.title === 'string' ? entry.title : ''
        const m = STORY_TITLE.exec(title)
        const place = `${entry.root} / ${entry.group}`
        const named = componentsOf(entry)
        if (!m || (roots && !roots.includes(m[1]))) add('story-title', manifest, `${where}: "${title}" is not Root / Group / Name`)
        else if (!entry.root || !entry.group) add('story-title', manifest, `${where}: no root and group fields`)
        else if (roots && !roots.includes(entry.root)) add('story-title', manifest, `${where}: root "${entry.root}" is not a tier of the taxonomy`)
        else if (`${m[1]} / ${m[2]}` !== place) add('story-title', manifest, `${where}: "${title}" is not under its fields, ${place}`)
        else if (named.length === 0) {
          if (!componentless.includes(place)) add('story-title', manifest, `${where}: no component, but stories in ${place} cover one (a story without one goes in ${componentless.length > 0 ? componentless.join(', ') : 'a place stories.componentless lists'})`)
        } else {
          for (const c of named) {
            const n = byFile.get(c) ?? byName.get(c)
            if (!n) add('story-title', manifest, `${where}: component "${c}" is not a graph node`)
            else if (n.group !== place) add('story-title', manifest, `${where}: filed under ${place}, but ${n.name} is in ${n.group ?? 'no group'}`)
          }
        }
      }
      if (!slug) return
      const page = pageOf(slug)
      const frame = frameOf(slug)
      if (page && !fileSet.has(page)) add('story-files', manifest, `${slug}: no ${page}`)
      if (frame && !unread.has('frame') && !unread.has('...')) {
        if (entry.frame === true && !fileSet.has(frame)) add('story-files', manifest, `${slug}: frame: true with no ${frame}`)
        if (entry.frame !== true && fileSet.has(frame)) add('story-files', manifest, `${slug}: ${frame} with no frame: true`)
      }
      if (Array.isArray(entry.states) && lane.blocks.has(page)) {
        // A label that is missing is a fault of the page; one that is there
        // but not a literal leaves the list unchecked.
        const labels = lane.blocks.get(page).map((s) => s.label)
        if (labels.includes(null)) add('story-states', page, `${slug}: a state with no label`)
        else if (labels.some((l) => typeof l !== 'string')) lane.unreadable.push({ file: page, detail: `${slug}: a state label is not statically readable, so its states are not checked` })
        else if (labels.join('\n') !== entry.states.join('\n')) add('story-states', manifest, `${slug}: states [${entry.states.join(', ')}] but the page labels [${labels.join(', ')}]`)
      }
    })
    // A page or frame no entry names, unless an entry's slug could not be read.
    if (!lane.entries.some((e) => !e || typeof e.slug !== 'string')) {
      const slugs = new Set(lane.entries.map((e) => e.slug))
      const orphans = new Map()
      for (const [pattern, what] of [[config.stories.pages, 'page'], [config.stories.frames, 'frame']]) {
        if (!pattern) continue
        for (const [slug, file] of slugFiles(pattern, all)) if (!slugs.has(slug) && !orphans.has(slug)) orphans.set(slug, { file, what })
      }
      for (const [slug, { file, what }] of orphans) add('story-files', file, `${slug}: a ${what} with no manifest entry`)
    }
    const unreadComponent = lane.skipped.filter((u) => u.entry !== null && (u.field === null || u.field === 'component' || u.field === '...'))
    if (unreadComponent.length > 0) {
      const where = [...new Set(unreadComponent.map((u) => u.slug ?? `entry ${u.entry + 1}`))].sort(compare)
      lane.notChecked = { 'no-story': `the component of ${where.join(', ')} is not statically readable, so any node could be the one a story covers` }
    } else {
      for (const n of nodes) if (live(n) && n.direct.length === 0 && n.noStory === null) add('no-story', n.file, 'no direct story')
    }
    const seen = new Set()
    return out
      .sort((a, b) => compare(a.rule, b.rule) || compare(a.file, b.file) || compare(a.detail, b.detail))
      .filter((p) => {
        const id = `${p.rule}\n${p.file}\n${p.detail}`
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
  }

  // A csf lane: story files read in place through the registry. A story file
  // covers a node directly when it imports it or sits beside it, and
  // incidentally when the node is reached through the modules it imports in
  // turn. Separate from both is what a node owns: the story beside it, or one
  // titled with its group and name (`ownStory` asks for it).
  function readCsfLane() {
    const policy = readPolicy(config.stories.policy, warnings)
    const texts = new Map()
    const readText = (f) => {
      if (!texts.has(f)) texts.set(f, readFileSync(join(root, f), 'utf8'))
      return texts.get(f)
    }
    const registry = laneRegistry({ root, config, files: storyFiles.filter(storyGlob), read: readText })
    const csfs = new Map()
    const csfOf = (f) => {
      if (!csfs.has(f)) csfs.set(f, readCsf(readText(f), f))
      return csfs.get(f)
    }
    const files = Object.keys(registry.files).sort(compare)
    const slugOf = (f) => registry.files[f].slug

    const unreadable = []
    for (const f of files) {
      for (const u of registry.files[f].unreadable) {
        if (listFaults({ unreadable: [u] }).length === 0) unreadable.push({ file: f, detail: u.story ? `${u.story}: ${u.detail}` : u.detail })
      }
    }

    // The modules a file imports, with the nodes behind any barrel.
    const adjacent = new Map()
    const next = (file) => {
      let out = adjacent.get(file)
      if (out) return out
      out = new Set()
      for (const edge of infoOf(file)?.edges ?? []) {
        if (!isTestFile(edge.file)) out.add(edge.file)
        for (const target of reach(edge.file, edge.names)) out.add(target)
      }
      adjacent.set(file, out)
      return out
    }
    const incidentalOf = new Map(nodeFiles.map((f) => [f, new Set()]))
    for (const f of files) {
      const seen = new Set([f])
      const queue = [f]
      while (queue.length > 0) {
        for (const target of next(queue.pop())) {
          if (seen.has(target)) continue
          seen.add(target)
          queue.push(target)
        }
      }
      for (const target of seen) if (nodeSet.has(target)) incidentalOf.get(target).add(slugOf(f))
    }

    const directFiles = new Map(nodeFiles.map((f) => [f, new Set([...storiesOf.get(f)].filter((s) => registry.files[s]))]))
    const siblings = new Map(nodeFiles.map((f) => [f, new Set()]))
    for (const f of files) {
      const node = nodeByStem.get(stemOf(f))
      if (node) siblings.get(node).add(f)
    }
    const titled = files.filter((f) => registry.files[f].title !== null).map((f) => ({ file: f, parts: titlePartsOf(registry.files[f].title) }))
    const nameFor = (nodeFile) => policy?.names[stemOfNode(nodeFile)] ?? wordsOfNode(nodeFile)
    // The story files that are a node's own: the one beside it, and those
    // titled "<group> / <name in words>".
    const ownFiles = (nodeFile, group) => ({
      sibling: siblings.get(nodeFile),
      titled: group ? titled.filter(({ parts }) => parts.length >= 2 && parts.slice(0, -1).join(' / ') === group && nameKey(parts[parts.length - 1]) === nameKey(nameFor(nodeFile))).map((t) => t.file) : [],
    })
    return {
      csf: true,
      registry,
      policy,
      files,
      csfOf,
      unreadable,
      nameFor,
      ownFiles,
      pagesOf: directFiles,
      coverage(nodeFile, group) {
        const own = ownFiles(nodeFile, group)
        const direct = new Set([...directFiles.get(nodeFile)].map(slugOf))
        return {
          own: sortedUnique([...own.sibling, ...own.titled].map(slugOf)),
          direct: sortedUnique(direct),
          incidental: sortedUnique([...incidentalOf.get(nodeFile)].filter((s) => !direct.has(s))),
        }
      },
    }
  }

  // What a csf lane's checks find, each { rule, file, detail }, sorted, with
  // no line numbers so a ratchet can key on them. The registry's problems and
  // no-story are always checked; the rest follow the options of stories.policy,
  // each off until it is set:
  //   story-title  roots, titleParts and titleExact, titleText, nameMatches
  //                (with names) and titlePrefix, against the story file
  //   story-files  the registry's (a duplicate id, a title or export list the
  //                reader cannot read, a home no story has) and cleanIds
  //   story-own    ownStory: a node with no story of the kind asked for,
  //                reported against the node
  //   story-banner bannerByRoot: a root's files carry its key, no other does
  //   no-story     a live node with no direct story and no ds:no-story
  function csfProblems(lane, nodes, live) {
    const { registry, policy, csfOf } = lane
    const out = []
    const add = (rule, file, detail) => out.push({ rule, file, detail })
    // Under Ladle's ids, a state exported under another name than it is
    // declared with takes neither its storyName nor its meta, as the registry has it.
    const ladleDropsOf = (s) => (config.stories.ids === 'ladle' && s.local !== s.export ? { ...s, storyName: null, meta: null } : s)
    for (const p of registry.problems) add(p.rule, p.file ?? CONFIG_FILE, p.detail)
    if (policy) {
      const nodeOfFile = new Map(nodes.map((n) => [n.file, n]))
      const notLiveTiers = new Set([].concat(taxonomy?.notLive ?? []))
      const bannerRoots = new Set(Object.keys(policy.bannerByRoot))
      for (const file of lane.files) {
        const info = registry.files[file]
        const title = info.title
        const csf = csfOf(file)
        const parts = title === null ? [] : titlePartsOf(title)
        const root = parts[0] ?? null
        const titleProblem = (detail) => add('story-title', file, detail)
        if (title !== null) {
          if (policy.roots && !policy.roots.includes(root)) titleProblem(`"${title}" starts with ${root}, which is not one of the roots ${policy.roots.join(', ')}`)
          if (policy.titleParts && !policy.titleExact.has(title)) {
            const wanted = policy.titleParts[root] ?? policy.titleParts.default
            if (Number.isInteger(wanted) && parts.length !== wanted) titleProblem(`"${title}" has ${parts.length} ${parts.length === 1 ? 'part' : 'parts'}, and a title under ${root} has ${wanted}`)
          }
          if (policy.titleText) {
            for (const part of parts) {
              const reasons = textReasons(part, policy.titleText)
              if (reasons.length > 0) titleProblem(`the title part "${part}" has ${reasons.join(' and ')}`)
            }
          }
          for (const rule of policy.titlePrefix) {
            if (!compileGlobs(rule.files)(file)) continue
            if (!rule.prefixes.some((prefix) => title.startsWith(prefix))) titleProblem(`"${title}" does not start with ${rule.prefixes.map((p) => `"${p}"`).join(' or ')}`)
          }
          // A title rooted in a bannerByRoot root is exempt, as a story that
          // is not about the node beside it; with no bannerByRoot, none is.
          const node = policy.nameMatches ? nodeOfFile.get(nodeByStem.get(stemOf(file))) : null
          if (node && node.group && !bannerRoots.has(root) && !notLiveTiers.has(node.tier)) {
            const prefix = `${node.group} / `
            const name = lane.nameFor(node.file)
            if (titlePartsOf(node.group).join(' / ') !== parts.slice(0, -1).join(' / ') || nameKey(parts[parts.length - 1]) !== nameKey(name)) titleProblem(`"${title}" is beside ${node.file}, so a story there is titled "${prefix}${name}"`)
          }
        }
        if (policy.titleText) {
          for (const story of csf.stories) {
            const s = ladleDropsOf(story)
            const text = s.storyName ?? s.export
            const reasons = textReasons(text, policy.titleText, s.storyName === null ? stateName(s) : null)
            if (reasons.length > 0) titleProblem(`the state ${s.export}${s.storyName === null ? '' : ` (storyName "${s.storyName}")`} has ${reasons.join(' and ')}`)
          }
        }
        if (policy.cleanIds && title !== null) {
          for (const id of info.ids) {
            const levels = id.split('--')
            const state = registry.stories[id].export
            if (levels.some((l) => l === '' || l.startsWith('-') || l.endsWith('-'))) add('story-files', file, `${state}: the id ${id} has an empty folder`)
            else if (levels.length !== parts.length + 1) add('story-files', file, `${state}: the id ${id} splits into ${levels.length} levels instead of ${parts.length + 1}`)
          }
        }
        // A file whose meta cannot be read whole cannot be checked for a key in it.
        const metaRead = !csf.unreadable.some((u) => u.story === null && u.field === 'meta')
        const fileMeta = isPlainObject(csf.meta.meta) ? csf.meta.meta : {}
        for (const [bannerRoot, key] of Object.entries(policy.bannerByRoot)) {
          if (root === bannerRoot) {
            if (metaRead && (typeof fileMeta[key] !== 'string' || fileMeta[key].trim() === '')) add('story-banner', file, `it sits under ${bannerRoot}, so its default export needs meta.${key} as a non-empty string`)
            continue
          }
          const stray = [...(key in fileMeta ? ['the default export'] : []), ...csf.stories.map(ladleDropsOf).filter((s) => s.meta && key in s.meta).map((s) => s.export)]
          if (stray.length > 0) add('story-banner', file, `meta.${key} belongs to ${bannerRoot} stories, and ${stray.join(', ')} sets it${root ? ` under ${root}` : ''}`)
        }
      }
      for (const rule of policy.ownStory) {
        const byGlob = rule.files.length > 0 ? compileGlobs(rule.files) : null
        for (const n of nodes) {
          if (!live(n) || n.noStory !== null) continue
          if (!rule.tiers.includes(n.tier) && !(byGlob && byGlob(n.file))) continue
          const own = lane.ownFiles(n.file, n.group)
          if (own.sibling.size > 0 || (rule.link === 'own' && own.titled.length > 0)) continue
          const beside = `a story beside it (${n.file.replace(/\.[^./]+$/, '')}.stories.*)`
          add('story-own', n.file, rule.link === 'own' ? `no story of its own: add ${beside}${n.group ? ` or one titled "${n.group} / ${lane.nameFor(n.file)}"` : ''}` : `no story of its own: add ${beside}`)
        }
      }
    }
    for (const n of nodes) if (live(n) && n.direct.length === 0 && n.noStory === null) add('no-story', n.file, 'no direct story')
    const seen = new Set()
    return out
      .sort((a, b) => compare(a.rule, b.rule) || compare(a.file, b.file) || compare(a.detail, b.detail))
      .filter((p) => {
        const id = `${p.rule}\n${p.file}\n${p.detail}`
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
  }

  // stories.lane says how stories are found: "manifest" reads the lane's
  // list and needs to know where it is, "csf" reads the story files in place
  // through the registry; anything else finds them by file name.
  const laneMode = config.stories.lane ?? 'native'
  if (laneMode === 'manifest' && !config.stories.manifest) {
    throw new Error('stories.lane is "manifest", so stories.manifest must name the file that lists the stories, such as src/stories/manifest.ts. Set it, or set stories.lane to "native" to find stories by file name.')
  }
  if (laneMode !== 'manifest' && config.stories.manifest) {
    warnings.push(`stories.manifest is set, but stories.lane is "${laneMode}", so ${laneMode === 'csf' ? 'the story files are read in place' : 'stories are found by file name'} and the manifest is not read; set stories.lane to "manifest" to read it`)
  }
  if (!['native', 'manifest', 'csf'].includes(laneMode)) {
    warnings.push(`stories.lane is "${laneMode}", which is not a lane massimo knows (native, manifest or csf), so stories are found by file name`)
  }
  const lane = laneMode === 'manifest' ? readLane() : laneMode === 'csf' ? readCsfLane() : null

  // Style harvesting reads the colour names the styleFiles define.
  const styleFiles = expandGlobs(root, config.tokens.styleFiles, [], config.ignore, all)
  const customProps = []
  for (const f of styleFiles) {
    customProps.push(...parseCustomProperties(readFileSync(join(root, f), 'utf8'), f))
  }
  const libraries = classLibraries(config).map((lib) => ({
    ...lib,
    rootSet: new Set(lib.roots),
    byLength: [...lib.roots].sort((a, b) => b.length - a.length || compare(a, b)),
  }))
  const colorNames = sortedUnique([
    ...customProps.map((p) => /^--color-([\w-]+)$/.exec(p.name)?.[1]).filter(Boolean),
    ...libraries.flatMap((lib) => lib.colors),
  ])
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const colorRe = colorNames.length
    ? new RegExp(
        `^(?:${COLOR_UTILITIES})-(?:[trblxyse]-)?(${[...colorNames].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?:/.+)?$`,
      )
    : null

  const ticketRe = config.ticketPattern ? new RegExp(config.ticketPattern, 'g') : null
  const faults = []
  // Where each fault sits, line included, for the message a strict run prints.
  const faultLines = []

  // How headers are read: the repo's own keys and their roles, the taxonomy
  // that places each node, and how much of the file counts as its header.
  const keys = knownKeys(config)
  const { roles, problems: roleProblems } = keyRoles(config)
  warnings.push(...roleProblems)
  const taxonomy = config.graph?.taxonomy && typeof config.graph.taxonomy === 'object' ? config.graph.taxonomy : null
  const headerMode = config.graph?.header ?? 'anywhere'
  if (!['anywhere', 'top'].includes(headerMode)) warnings.push(`graph.header is "${headerMode}"; it is "anywhere" or "top", so headers are read anywhere`)
  const exists = (path) => existsSync(join(root, path))

  // A node's place in the taxonomy: its declared group when the taxonomy
  // knows it, else what the parked marker or a path rule gives, with the
  // faults the taxonomy finds on the way.
  function place(file, source, declared, entries, fault) {
    const lineOf = (key) => entries.find((e) => e.key === key)?.line ?? null
    const known = declared === null || knowsGroup(taxonomy, declared)
    if (!known) fault('ds:group', `"${declared}" is not a group in graph.taxonomy`, lineOf('group'))
    const p = placeFile(file, source, known ? declared : null, taxonomy)
    if (p.derived && !knowsGroup(taxonomy, p.group)) fault('ds:group', `takes "${p.group}" from graph.taxonomy, which does not list that group`)
    if (!p.group && declared === null) fault('ds:group', 'has no group: add a ds:group line, or a path rule in graph.taxonomy.rules')
    for (const key of [].concat(taxonomy.require?.[p.tier] ?? [])) {
      if (!entries.some((e) => e.key === key && e.value.trim())) fault(`ds:${key}`, `a ${p.tier} node needs a ds:${key} line`)
    }
    const parked = taxonomy.parked
    if (parked?.group && p.group) {
      if (p.parked && p.group !== parked.group) fault('ds:group', `carries the parked marker ${parked.marker} but sits in ${p.group}; a parked node goes in ${parked.group}`, lineOf('group'))
      if (!p.parked && p.group === parked.group) fault('ds:group', `sits in ${parked.group} without the parked marker ${parked.marker}`, lineOf('group'))
    }
    return p
  }

  // Call sites are read once each, however many components they use.
  const textOf = new Map()
  const text = (f) => {
    if (!textOf.has(f)) textOf.set(f, readFileSync(join(root, f), 'utf8'))
    return textOf.get(f)
  }
  const nodes = nodeFiles.map((file) => {
    const source = readFileSync(join(root, file), 'utf8')
    const code = stripComments(source, file)
    const classes = Object.fromEntries(libraries.map((lib) => [lib.id, new Set()]))
    const tokens = new Set()
    for (const { text, start } of stringLiterals(code, file)) {
      if (isProse(text)) continue
      const words = text.split(/[\s"'`{}(),;]+/).filter(Boolean).map(bareClass)
      if (words.length === 0) continue
      // A bare word like `label` or `list` is only a class when the string is
      // plainly a class list; `btn-primary`-style tokens always count.
      const classy = CLASS_CONTEXT.test(code.slice(Math.max(0, start - 48), start)) || words.some(CLASS_LIKE.test, CLASS_LIKE)
      for (const token of words) {
        for (const lib of libraries) {
          const component = rootOf(lib, token, classy)
          if (component) classes[lib.id].add(component)
        }
        const m = colorRe?.exec(token)
        if (m) tokens.add(m[1])
      }
    }
    const cssVars = new Set()
    for (const m of code.matchAll(/var\(\s*(--[\w-]+)/g)) if (!m[1].startsWith('--tw-')) cssVars.add(m[1])
    const header = readHeader(source, file, keys, headerMode)
    for (const key of header.unknown) {
      warnings.push(`${file}: unknown header key "ds:${key}"`)
      faults.push({ file, key: `ds:${key}` })
      // Where it sits, for a strict run to name, since the warning is not printed.
      const line = header.entries.find((e) => e.key === key)?.line
      faultLines.push(`${file}${line ? `:${line}` : ''}: unknown header key "ds:${key}"`)
    }
    const fault = (key, message, line = null) => {
      faults.push({ file, key, message })
      faultLines.push(`${file}${line ? `:${line}` : ''}: ${message}`)
    }
    for (const p of header.problems) fault(p.key, p.message, p.line)
    if (roles.size > 0) for (const p of headerRoles(header.entries, roles, { exists }).problems) fault(`ds:${p.key}`, p.message, p.line)
    const { group: groupValue, 'no-story': noStory, ...rules } = header.rules
    const groupParts = (groupValue ?? '').split('/').map((p) => p.trim()).filter(Boolean)
    let group = groupParts.length > 0 ? groupParts.join(' / ') : null
    let tier = groupParts[0] ?? null
    const placed = taxonomy ? place(file, source, group, header.entries, fault) : {}
    if (taxonomy) ({ group, tier } = placed)
    const decisions = ticketRe ? sortedUnique(source.match(ticketRe) ?? [], natural) : []
    const composedBy = {}
    for (const importer of sortedUnique(importersOf.get(file))) {
      const area = nodeSet.has(importer) ? 'components' : areaOf(importer)
      ;(composedBy[area] ??= []).push(importer)
    }
    const sortedAreas = {}
    for (const area of Object.keys(composedBy).sort(compare)) sortedAreas[area] = composedBy[area]
    const coverage = lane?.csf
      ? lane.coverage(file, group)
      : lane
      ? { direct: sortedUnique(lane.direct.get(file)), incidental: sortedUnique([...lane.incidental.get(file)].filter((s) => !lane.direct.get(file).has(s))) }
      : {}
    return {
      name: nameOf.get(file),
      file,
      ...(kinds.length > 0 ? { kind: kindOf.get(file) } : {}),
      tier,
      group,
      ...(placed.derived ? { derived: true } : {}),
      ...(placed.parked ? { parked: true } : {}),
      noStory: noStory ?? null,
      stories: sortedUnique(lane ? lane.pagesOf.get(file) : storiesOf.get(file)),
      ...coverage,
      exports: extractExports(source, file),
      composes: [...composes.get(file)].map((f) => nameOf.get(f)).sort(byName),
      composedBy: sortedAreas,
      usage: importersOf.get(file).size,
      ...propsAndStates(source, file, nameOf.get(file), [...importersOf.get(file)].map((f) => ({ file: f, text: text(f) }))),
      packages: sortedUnique(packages.get(file)),
      style: {
        classes: Object.fromEntries(Object.entries(classes).filter(([, set]) => set.size > 0).map(([id, set]) => [id, sortedUnique(set)])),
        tokens: sortedUnique(tokens),
        cssVars: sortedUnique(cssVars),
      },
      rules,
      decisions,
    }
  })
  nodes.sort((a, b) => byName(a.name, b.name) || compare(a.file, b.file))

  // Live code needs a story; a tier the taxonomy marks not live (internal
  // modules, parked work) does not, and a node it cannot place is a fault.
  const notLive = new Set([].concat(taxonomy?.notLive ?? []))
  const live = (n) => !taxonomy || (Boolean(n.group) && !notLive.has(n.tier))

  const withStory = nodes.filter((n) => n.stories.length > 0).length
  const noStory = nodes.filter((n) => n.stories.length === 0 && n.noStory !== null).length
  const storyQueue = nodes
    .filter((n) => n.stories.length === 0 && n.noStory === null && (notLive.size === 0 || live(n)))
    .map((n) => ({ name: n.name, file: n.file, usage: n.usage }))
    .sort((a, b) => b.usage - a.usage || byName(a.name, b.name))
  const problems = lane ? (lane.csf ? csfProblems(lane, nodes, live) : laneProblems(lane, nodes, live)) : []

  const tokenNames = sortedUnique(customProps.map((p) => p.name).filter((n) => !n.startsWith('--tw-')))
  const groups = Object.fromEntries(TOKEN_GROUPS.map((g) => [g, []]))
  for (const name of tokenNames) groups[tokenGroup(name)].push(name)
  let dtcg = null
  try {
    const set = readTokenSource(root, config)
    if (set) dtcg = { path: config.tokens.source, count: set.tokens.length }
  } catch (err) {
    warnings.push(err.message)
  }

  const unresolvedMap = {}
  for (const spec of [...unresolved.keys()].sort(compare)) unresolvedMap[spec] = [...unresolved.get(spec)].sort(compare)
  const rulesNodes = nodes.filter((n) => Object.keys(n.rules).length > 0).map((n) => n.name)
  const faultList = uniqueFaults(faults)

  const json = {
    version: 1,
    generatedBy: 'massimo graph',
    summary: {
      components: nodes.length,
      withStory,
      withoutStory: nodes.length - withStory - noStory,
      noStory,
      tokens: tokenNames.length,
      nodesWithRules: rulesNodes.length,
      unresolvedImports: Object.keys(unresolvedMap).length,
      headerFaults: faultList.length,
      ...(kinds.length > 0 ? { kinds: kindCounts(nodes, kinds) } : {}),
    },
    tokens: {
      styleFiles,
      total: tokenNames.length,
      groups: Object.fromEntries(Object.entries(groups).filter(([, v]) => v.length > 0)),
      dtcg,
    },
    storyQueue,
    nodes,
    unresolved: unresolvedMap,
    faults: faultList,
    ...(lane ? { storyLane: laneSummary(lane, nodes, problems) } : {}),
  }
  const view = { order: tierOrder(config), taxonomy }
  return { json, markdown: renderMarkdown(json, rulesNodes, command, view), warnings, faultLines: sortedUnique(faultLines) }
}

// How many nodes of each kind: components first, then the config's kinds.
function kindCounts(nodes, kinds) {
  const out = { component: 0 }
  for (const [kind] of kinds) out[kind] = 0
  for (const n of nodes) out[n.kind] += 1
  return out
}

// The story lane in graph.json: where its manifest is, how many entries and
// states it holds (a csf lane: `lane: "csf"`, its story files and states),
// the coverage split (direct, incidental only, none), the problems its
// checks find, each { rule, file, detail } (and `whole` for a manifest that
// cannot be read at all), and the checks it could not make, as { rule: why }
// under `notChecked`.
function laneSummary(lane, nodes, problems) {
  const direct = nodes.filter((n) => n.direct.length > 0).length
  const incidental = nodes.filter((n) => n.direct.length === 0 && n.incidental.length > 0).length
  const unreadable = lane.unreadable.sort((a, b) => compare(a.file, b.file) || compare(a.detail, b.detail))
  // A csf lane has no manifest: it counts its story files and their states.
  const where = lane.csf
    ? { lane: 'csf', files: lane.files.length, states: Object.keys(lane.registry.stories).length }
    : { manifest: lane.manifest, entries: lane.entries.filter(Boolean).length, states: lane.states }
  return {
    ...where,
    direct,
    incidental,
    none: nodes.length - direct - incidental,
    problems,
    ...(unreadable.length > 0 ? { unreadable } : {}),
    ...(lane.notChecked ? { notChecked: lane.notChecked } : {}),
  }
}

// Faults sorted by file, key and message, each once.
function uniqueFaults(faults) {
  const seen = new Set()
  return faults
    .sort((a, b) => compare(a.file, b.file) || compare(a.key, b.key) || compare(a.message ?? '', b.message ?? ''))
    .filter((f) => {
      const id = `${f.file}\n${f.key}\n${f.message ?? ''}`
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
}

const code = (s) => `\`${s}\``

// A rank in a list, with anything not in it after everything that is.
const rankIn = (list, item) => {
  const i = list.indexOf(item)
  return i === -1 ? list.length : i
}

// One line per node, grouped by tier (in the taxonomy's order, or massimo's)
// then group (in the taxonomy's order, then by name); nodes without a group
// come last.
function renderIndex(nodes, view) {
  const groupOrder = glossary(view.taxonomy).map(([g]) => g)
  const buckets = new Map()
  for (const n of nodes) {
    const key = n.group ?? 'Ungrouped'
    if (!buckets.has(key)) buckets.set(key, { tier: n.tier, nodes: [] })
    buckets.get(key).nodes.push(n)
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === 'Ungrouped' || b === 'Ungrouped') return (a === 'Ungrouped') - (b === 'Ungrouped')
    const ta = buckets.get(a).tier
    const tb = buckets.get(b).tier
    return rankIn(view.order, ta) - rankIn(view.order, tb) || compare(ta, tb) || rankIn(groupOrder, a) - rankIn(groupOrder, b) || compare(a, b)
  })
  const out = []
  for (const key of keys) {
    out.push(`**${key}**`, '')
    for (const n of buckets.get(key).nodes) {
      // With a story lane, only a direct story counts; a node seen inside a
      // parent's story says so.
      const story = n.stories.length > 0 ? 'story ✓' : n.noStory !== null ? 'no-story' : n.incidental?.length > 0 ? 'incidental only' : 'story ✗'
      const kind = n.kind && n.kind !== 'component' ? ` (${n.kind})` : ''
      out.push(`- ${n.name}${kind}: ${story} · used by ${n.usage}`)
    }
    out.push('')
  }
  return out
}

function listWithCap(items, cap) {
  return items.length > cap ? `${items.slice(0, cap).join(', ')}, +${items.length - cap} more` : items.join(', ')
}

// A node's stories for its head line: the files, or with a story lane the
// slugs that cover it directly, else the ones it is seen inside.
function storyHead(node) {
  const listed = node.direct ?? node.stories
  if (listed.length > 0) return `${listed.length > 1 ? 'stories' : 'story'} ${listWithCap(listed.map(code), MAX_STORY_LIST)}`
  if (node.noStory !== null) return `no story on purpose${node.noStory ? `: ${node.noStory}` : ''}`
  if (node.incidental?.length > 0) return `no story of its own, seen inside ${listWithCap(node.incidental.map(code), MAX_STORY_LIST)}`
  return 'no story'
}

function renderNode(node, nameByFile) {
  const lines = [`### ${node.name}`]
  const head = [`file ${code(node.file)}`]
  if (node.kind && node.kind !== 'component') head.push(node.kind)
  head.push(storyHead(node))
  if (node.exports.length > 0) head.push(`exports ${node.exports.join(', ')}`)
  lines.push(`- ${head.join(' · ')}`)
  lines.push(
    `- used by ${node.usage} ${node.usage === 1 ? 'file' : 'files'} · composes: ${node.composes.length > 0 ? node.composes.join(', ') : 'none'}`,
  )
  const areas = Object.entries(node.composedBy).map(([area, files]) => {
    if (area === 'components') {
      const names = files.map((f) => nameByFile.get(f)).sort(byName)
      return `${area} (${files.length}): ${listWithCap(names, MAX_COMPONENT_LIST)}`
    }
    return `${area} (${files.length}): ${listWithCap(files, MAX_FILE_LIST)}`
  })
  lines.push(`- composed by: ${areas.length > 0 ? areas.join(' · ') : 'none'}`)
  if (node.packages.length > 0) lines.push(`- packages: ${node.packages.join(', ')}`)
  const style = []
  for (const [id, roots] of Object.entries(node.style.classes)) style.push(`${id} ${roots.join(', ')}`)
  if (node.style.tokens.length > 0) style.push(`tokens ${node.style.tokens.join(', ')}`)
  if (node.style.cssVars.length > 0) style.push(`vars ${node.style.cssVars.join(', ')}`)
  if (style.length > 0) lines.push(`- style: ${style.join(' · ')}`)
  if (node.props?.length > 0) {
    const describe = (p) => {
      const bits = []
      if (p.values) bits.push(p.values.join(' | '))
      if (p.default !== undefined) bits.push(`default ${p.default === '' ? '""' : p.default}`)
      if (p.usage) bits.push(`used ${Object.entries(p.usage).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ×${n}`).join(', ')}`)
      if (p.kind) bits.push(p.kind)
      return bits.length > 0 ? `${p.name} (${bits.join('; ')})` : p.name
    }
    lines.push(`- props: ${node.props.map(describe).join(' · ')}`)
  }
  if (node.states?.length > 0) lines.push(`- states: ${node.states.join(', ')}`)
  const rules = Object.entries(node.rules).map(([k, v]) => `${k} ${v}`)
  const from = node.derived ? (node.parked ? ' (from its parked marker)' : ' (from its path)') : ''
  if (node.group) rules.unshift(`group ${node.group}${from}`)
  if (rules.length > 0) lines.push(`- rules: ${rules.join(' · ')}`)
  if (node.decisions.length > 0) lines.push(`- decisions: ${node.decisions.join(', ')}`)
  return lines.join('\n')
}

// The taxonomy's placement test, its notes and its groups. The placement
// test keeps one `- <Tier>: <test>` line per question between its heading and
// the next, so a page can read it back with a pattern.
function renderTaxonomy(taxonomy) {
  const out = []
  const { tests, notes } = placementOf(taxonomy)
  if (tests.length > 0) {
    out.push('## Placement test', '', 'Ask each question in order; the first yes gives the node its tier.', '')
    for (const t of tests) out.push(`- ${t.tier}: ${t.test}`)
    out.push('')
    for (const note of notes) out.push(note, '')
  }
  const groups = glossary(taxonomy)
  if (groups.length > 0) {
    out.push('## Groups', '')
    for (const [group, line] of groups) out.push(line ? `- ${group}: ${line}` : `- ${group}`)
    out.push('')
  }
  return out
}

// The first summary line: how many nodes, of which kinds, and their stories.
// With a story lane the count that leads is direct coverage, since a node
// seen only inside a parent's story has no story of its own.
function nodesLine(summary, storyLane) {
  const kinds = summary.kinds ? ` (${Object.entries(summary.kinds).map(([kind, n]) => `${kind} ${n}`).join(', ')})` : ''
  const label = summary.kinds ? 'Nodes' : 'Components'
  const intentional = summary.noStory > 0 ? `, ${summary.noStory} without on purpose` : ''
  if (storyLane) {
    const marked = summary.noStory > 0 ? `; ${summary.noStory} marked \`ds:no-story\`` : ''
    return `1. ${label}: ${summary.components}${kinds}. Stories: ${storyLane.direct} with a direct story, ${storyLane.incidental} seen only inside a parent's story, ${storyLane.none} with none${marked}.`
  }
  if (summary.kinds) return `1. ${label}: ${summary.components}${kinds}: ${summary.withStory} with a story, ${summary.withoutStory} without${intentional}.`
  return `1. Components: ${summary.components} (${summary.withStory} with a story, ${summary.withoutStory} without${intentional}).`
}

// The story lane: where its list is, what it holds, how coverage is decided,
// and anything in it that could not be read without running it.
function renderLane(lane) {
  const out = ['## Story lane', '']
  if (lane.lane === 'csf') {
    out.push(`The story files are read in place: ${lane.files} ${lane.files === 1 ? 'file' : 'files'}, with ${lane.states} ${lane.states === 1 ? 'state' : 'states'}. A story covers a node directly when its file imports it or sits beside it, and incidentally when the node is reached through the modules that file imports in turn. A node's own story is the one beside it, or one titled with its group and name.`, '')
    out.push(`- Direct: ${lane.direct} · seen only inside a parent's story: ${lane.incidental} · none: ${lane.none}.`, '')
    out.push('The checks: `story-files` (every story file can be read in full and no two states share an id, and with `stories.policy.cleanIds` every id has one folder per title part), `story-title` (with `stories.policy`: the roots, the number of parts, the text of title parts and state names, the name a story beside a node takes, and title prefixes), `story-own` (`stories.policy.ownStory`: a node has a story of its own), `story-banner` (`stories.policy.bannerByRoot`: a root\'s files carry its banner key and no other file does) and `no-story` (every live node has a direct story or a `ds:no-story` line). With `graph.strictFaults`, all but the last fail the run; `no-story` is reported and never fails it.', '')
    if (lane.problems.length === 0) out.push('None of them finds a problem.', '')
    else {
      for (const p of lane.problems) out.push(`- ${code(p.rule)} · ${code(p.file)} · ${p.detail}`)
      out.push('')
    }
    if (lane.unreadable?.length > 0) {
      out.push('Not statically readable, so not checked:', '')
      for (const u of lane.unreadable) out.push(`- ${code(u.file)}: ${u.detail}`)
      out.push('')
    }
    return out
  }
  out.push(`${code(lane.manifest)} lists ${lane.entries} ${lane.entries === 1 ? 'story' : 'stories'}, with ${lane.states} ${lane.states === 1 ? 'state' : 'states'} on their pages. A story covers a node directly when its page or frame imports it (itself or through the lane's own helpers) or its entry names it, and covers what that node composes only incidentally.`, '')
  out.push(`- Direct: ${lane.direct} · seen only inside a parent's story: ${lane.incidental} · none: ${lane.none}.`, '')
  out.push('The checks: `story-title` (a title is Root / Group / Name under its root and group, which are its component\'s group), `story-files` (the manifest can be read, every entry has its page, every page and frame an entry, and a frame flag its frame), `story-states` (a states list is the page\'s state labels, in order, and every state there has a label) and `no-story` (every live node has a direct story or a `ds:no-story` line). With `graph.strictFaults`, the first three fail the run; the audit ratchets `no-story`.', '')
  if (lane.problems.length === 0) out.push('None of them finds a problem.', '')
  else {
    for (const p of lane.problems) out.push(`- ${code(p.rule)} · ${code(p.file)} · ${p.detail}`)
    out.push('')
  }
  if (lane.unreadable?.length > 0) {
    out.push('Not statically readable, so not checked:', '')
    for (const u of lane.unreadable) out.push(`- ${code(u.file)}: ${u.detail}`)
    out.push('')
  }
  for (const [rule, why] of Object.entries(lane.notChecked ?? {})) out.push(`${code(rule)} is not checked: ${why}.`, '')
  return out
}

function renderMarkdown(json, rulesNodes, command, view) {
  const { summary, tokens, storyQueue, nodes, unresolved, faults, storyLane } = json
  const nameByFile = new Map(nodes.map((n) => [n.file, n.name]))
  const out = []
  out.push('# Design-system graph', '')
  out.push(`<!-- Generated by massimo graph. Do not edit by hand. Regenerate: ${command} -->`, '')
  out.push('How to read a node:', '')
  out.push('1. `composes` lists the graph nodes the file imports; `composed by` lists who imports it, grouped by area with counts. Stories and tests are not counted. Long lists end in `+N more`; `graph.json` has them all.')
  out.push('2. `style` lists the component classes of a class library such as DaisyUI, the theme colour tokens and the custom properties (`var(--x)`) the file references.')
  out.push('3. `decisions` are the ticket ids found in the file; open the ticket or the file header for the why.')
  out.push('4. `rules` are declared in the file itself as comment lines: `ds:group Tier / Group`, `ds:parents`, `ds:children`, `ds:never`, `ds:use-when`. `ds:no-story <reason>` marks a component that has no story on purpose. A value may wrap onto the comment lines after it.', '')

  out.push('## Summary', '')
  out.push(nodesLine(summary, storyLane))
  const dtcg = tokens.dtcg ? `; ${tokens.dtcg.count} in ${code(tokens.dtcg.path)}` : ''
  out.push(`2. Tokens: ${summary.tokens} custom properties in ${tokens.styleFiles.length} style ${tokens.styleFiles.length === 1 ? 'file' : 'files'}${dtcg}.`)
  out.push(`3. Nodes carrying \`ds:\` rules: ${rulesNodes.length > 0 ? rulesNodes.join(', ') : 'none'}.`)
  out.push(`4. Unresolved imports: ${summary.unresolvedImports}${summary.unresolvedImports > 0 ? ' (listed below; fix them with `aliases` in massimo.config.json)' : ''}.`)
  out.push(`5. Header faults: ${summary.headerFaults}${summary.headerFaults > 0 ? ' (listed below)' : ''}.`, '')

  if (faults.length > 0) {
    out.push('## Header faults', '')
    if (faults.every((f) => f.message === undefined)) {
      out.push('A `ds:` key the graph does not know, so its value was ignored. Known keys: `ds:group`, `ds:no-story`, `ds:parents`, `ds:children`, `ds:never`, `ds:use-when`.', '')
    } else {
      out.push('A `ds:` header line the graph could not use, or a node the taxonomy cannot place. A key with no message is one the graph does not know, so its value was ignored; `graph.keys` and `graph.extraKeys` in massimo.config.json name a repo\'s own keys.', '')
    }
    for (const f of faults) out.push(f.message === undefined ? `- ${code(f.file)} · ${code(f.key)}` : `- ${code(f.file)} · ${code(f.key)} · ${f.message}`)
    out.push('')
  }

  out.push(...renderTaxonomy(view.taxonomy))
  if (storyLane) out.push(...renderLane(storyLane))

  out.push('## Index', '')
  out.push('One line per component, grouped by tier and group from each file\'s `ds:group` line.', '')
  out.push(...renderIndex(nodes, view))

  out.push('## Story queue', '')
  const story = storyLane ? 'a direct story' : 'a story'
  if (storyQueue.length === 0) {
    out.push(`Every component has ${story} or is marked \`ds:no-story\`.`, '')
  } else {
    out.push(`Components without ${story} and not marked \`ds:no-story\`, most used first (${Math.min(STORY_QUEUE_MD, storyQueue.length)} of ${storyQueue.length}).`, '')
    storyQueue.slice(0, STORY_QUEUE_MD).forEach((n, i) => out.push(`${i + 1}. ${n.name} · ${n.usage} ${n.usage === 1 ? 'file' : 'files'} · ${code(n.file)}`))
    out.push('')
  }

  out.push('## Tokens', '')
  if (tokens.styleFiles.length === 0) {
    out.push('No style files configured (`tokens.styleFiles`).', '')
  } else {
    out.push(`Defined in ${tokens.styleFiles.map(code).join(', ')}.`, '')
    for (const [group, names] of Object.entries(tokens.groups)) out.push(`- ${group} (${names.length}): ${names.join(', ')}`)
    out.push('')
  }

  const specs = Object.keys(unresolved)
  if (specs.length > 0) {
    out.push('## Unresolved imports', '')
    out.push(`${specs.length} relative or alias ${specs.length === 1 ? 'import points' : 'imports point'} at nothing, so the edges through them are missing from the graph.`, '')
    for (const spec of specs.slice(0, UNRESOLVED_MD)) {
      const files = unresolved[spec]
      out.push(`- ${code(spec)} · ${files.length} ${files.length === 1 ? 'file' : 'files'}: ${listWithCap(files, 3)}`)
    }
    if (specs.length > UNRESOLVED_MD) out.push(`- +${specs.length - UNRESOLVED_MD} more in graph.json`)
    out.push('')
  }

  out.push('## Components', '')
  if (nodes.length === 0) out.push('No files matched `components.include`.', '')
  for (const node of nodes) out.push(renderNode(node, nameByFile), '')
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set(['check'])

function main() {
  const argv = process.argv.slice(2).map((a) => (a.startsWith('--') && BOOLEAN_FLAGS.has(a.slice(2)) ? `${a}=true` : a))
  const { flags } = parseArgs(argv)
  const { root, config, projectDir } = loadConfig(flags)
  warnIfVendoredOlder(projectDir, import.meta.url)
  // A graph.json from a newer massimo is never checked against or overwritten.
  refuseNewer('graph', readJson(join(projectDir, 'graph.json'), null)?.version, 'graph.json')
  const { json, markdown, warnings, faultLines } = buildGraph(root, config, scriptCommand(root, projectDir, 'graph'))
  // With graph.strictFaults, header faults fail the run and the check: the
  // files are still written first, so the reader can see what to fix.
  const strict = config.graph?.strictFaults === true
  const check = truthy(flags.check)
  if (json.faults.length > 0 && (!check || strict)) {
    process.stderr.write(`massimo graph: ${json.faults.length} header ${json.faults.length === 1 ? 'fault' : 'faults'}; see "Header faults" in graph.md\n`)
  }
  // Story lane problems fail it too, apart from no-story, which the audit ratchets.
  const storyFaults = strict ? (json.storyLane?.problems ?? []).filter((p) => p.rule !== 'no-story') : []
  if (strict) for (const line of faultLines) process.stderr.write(`massimo graph: ${line}\n`)
  for (const p of storyFaults) process.stderr.write(`massimo graph: ${p.file}: ${p.rule}: ${p.detail}\n`)
  const failing = strict ? json.faults.length + storyFaults.length : 0
  const strictFailure = () => {
    if (failing === 0) return false
    process.stderr.write(`massimo graph: graph.strictFaults is on, so ${failing === 1 ? 'this fault fails' : `these ${failing} faults fail`} the ${check ? 'check' : 'run'}. Fix ${failing === 1 ? 'it' : 'them'}, or set graph.strictFaults to false to report faults without failing.\n`)
    return true
  }
  for (const w of warnings.filter((w) => !w.includes('unknown header key'))) process.stderr.write(`massimo graph: ${w}\n`)
  if (json.nodes.length === 0) {
    process.stderr.write('massimo graph: no files matched components.include; check the globs in massimo.config.json\n')
  }
  const files = [
    ['graph.md', markdown],
    ['graph.json', `${JSON.stringify(json, null, 2)}\n`],
  ]
  const shown = (name) => {
    const r = rel(root, join(projectDir, name))
    return r.startsWith('..') ? join(projectDir, name) : r
  }
  const s = json.summary
  const stats = `${s.components} ${s.kinds ? 'nodes' : 'components'}, ${s.withStory} with a ${json.storyLane ? 'direct story' : 'story'}, ${s.unresolvedImports} unresolved imports`

  if (check) {
    const bad = []
    for (const [name, text] of files) {
      const path = join(projectDir, name)
      if (!existsSync(path)) bad.push(`${shown(name)} (missing)`)
      else if (readFileSync(path, 'utf8') !== text) bad.push(`${shown(name)} (stale)`)
    }
    if (bad.length > 0) {
      process.stderr.write(`massimo graph: out of date: ${bad.join(', ')}. Run: ${scriptCommand(root, projectDir, 'graph')}\n`)
      strictFailure()
      process.exit(1)
    }
    if (strictFailure()) process.exit(1)
    process.stdout.write(`massimo graph: up to date (${stats})\n`)
    return
  }
  mkdirSync(projectDir, { recursive: true })
  for (const [name, text] of files) writeFileSync(join(projectDir, name), text)
  process.stdout.write(`massimo graph: wrote ${shown('graph.md')} and graph.json (${stats})\n`)
  if (strictFailure()) process.exit(1)
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (entry === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}
