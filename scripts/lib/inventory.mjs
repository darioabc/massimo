// What a repo already has for its design system, read without running any of
// it: story tools and lanes, the ds: header keys in its code, its own
// generated graph, ratchet and token files, a DESIGN.md, the script that
// writes them, and who depends on each. `adopt.mjs scan` writes this to
// <project>/adopt/inventory.json; detect.mjs reads a short summary of it so
// the start skill can offer adopt.

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { basename, join, posix } from 'node:path'
import { readDesignMd } from './designmd.mjs'
import { compare, compileGlobs, walk } from './glob.mjs'
import { stripJsonComments } from './project.mjs'
import { DEFAULT_TIERS, keyRoles, tierOf } from './roles.mjs'
import { RULE_KEYS, createResolver, extractImports, extractRules, isTestFile, stripComments } from './source.mjs'
import { readCsf, readHistoire, readManifest, readStoryStates } from './stories-read.mjs'

export const INVENTORY_FORMAT = 1

// Code that can carry a ds: header or an import.
const CODE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx|css|scss|sass|less|pcss)$/
const STYLE_EXT = /\.(?:css|scss|sass|less|pcss)$/
const MAX_BYTES = 1024 * 1024

// ── Files ───────────────────────────────────────────────────────────────────

// Every file of the repo as sorted repo-relative POSIX paths: git's list when
// there is one (it honours .gitignore, so build output stays out), else a
// walk. A folder with its own package.json is another app unless the root
// declares workspaces, and the project folder is massimo's own: both are left
// out, as is anything under an ignored folder name.
export function repoFiles(root, { ignore = [], projectRel = null, workspaces = false } = {}) {
  let list = null
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).toString()
    list = out.split('\n').filter(Boolean)
  } catch {
    // not a git checkout
  }
  if (!list || list.length === 0) list = walk(root, { ignore })
  const skip = new Set(ignore)
  list = list.filter((f) => !f.split('/').some((seg) => skip.has(seg)))
  const nested = workspaces ? [] : list.filter((f) => f !== 'package.json' && f.endsWith('/package.json')).map((f) => f.slice(0, -'package.json'.length))
  const own = projectRel && projectRel !== '.' ? `${projectRel}/` : null
  return [...new Set(list)].filter((f) => !nested.some((dir) => f.startsWith(dir)) && !(own && f.startsWith(own))).sort(compare)
}

// A file's text, or '' when it is missing, unreadable or too big to be source.
export function readText(root, file) {
  try {
    const p = join(root, file)
    if (statSync(p).size > MAX_BYTES) return ''
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

const readJsonText = (text) => {
  try {
    return JSON.parse(stripJsonComments(text))
  } catch {
    return null
  }
}
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const lineAt = (text, index) => text.slice(0, index).split('\n').length
const dirOf = (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')

// ── ds: header census ───────────────────────────────────────────────────────

// A ds: line counts when it opens its comment: `// ds:`, `/* ds:`, ` * ds:`,
// `<!-- ds:` or `{/* ds:`. One written inside another comment or a string, as
// a script that documents the grammar writes them, is an example.
const HEADER_LINE = /^\s*(?:\/\/+|\/\*+|\*+|<!--+|\{\/\*+)\s*ds:[a-z]/
const CUSTOM_PROPERTY = /^--[A-Za-z0-9_-]+$/
const BREAKPOINT_VALUE = /^\d*\.?\d+(?:rem|px|em)\s+\S/
const FILE_NAME = /^[\w.-]+\.[A-Za-z0-9]+$/
const words = (value) => value.split(/[\s,]+/).filter(Boolean)

// Every header line of a file, as extractRules reads it, without examples.
export function headerEntries(source) {
  if (!source.includes('ds:')) return []
  const lines = source.split(/\r?\n/)
  return extractRules(source).entries.filter((e) => HEADER_LINE.test(lines[e.line - 1] ?? ''))
}

// The files with a ds: header line, from the code files of the repo.
const headedFiles = (files, text) => files.filter((f) => CODE_EXT.test(f) && headerEntries(text(f)).length > 0)

// A role for a key massimo does not know, from the shape of its values, or
// null when none fits: custom property lists are definitions, `<width>
// <reason>` is a breakpoint, file names that all live in one folder are a
// list under it, and one word from a small set, once per file, is a scope.
export function proposeRole(values, { files = [], oncePerFile = true } = {}) {
  const items = values.map((v) => v.trim()).filter(Boolean)
  if (items.length === 0) return null
  if (items.every((v) => words(v).every((w) => CUSTOM_PROPERTY.test(w)))) return 'definitions'
  if (items.every((v) => BREAKPOINT_VALUE.test(v))) return 'breakpoint'
  const names = items.flatMap(words)
  if (names.every((n) => FILE_NAME.test(n))) {
    let shared = null
    for (const name of new Set(names)) {
      const dirs = new Set(files.filter((f) => basename(f) === name).map(dirOf))
      shared = shared === null ? dirs : new Set([...shared].filter((d) => dirs.has(d)))
    }
    const under = shared && shared.size === 1 ? [...shared][0] : null
    return under ? { role: 'list', under } : 'list'
  }
  const distinct = [...new Set(items)]
  if (oncePerFile && items.every((v) => /^[\w-]+$/.test(v)) && distinct.length <= 8 && distinct.length < items.length) {
    return { role: 'scope', values: distinct.sort(compare) }
  }
  return null
}

// Where a file sits when it is a page or a layout rather than a component:
// the folder up to `layouts`, or `pages`, `routes` or `app`, and its kind.
function kindFolder(file) {
  const parts = file.split('/')
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'layouts') return { kind: 'layout', dir: parts.slice(0, i + 1).join('/') }
    if (['pages', 'routes', 'app'].includes(parts[i])) return { kind: 'page', dir: parts.slice(0, i + 1).join('/') }
  }
  return null
}

// The census of every ds: header key in the repo's code: per key its files,
// lines, a few example files and values, whether massimo knows it (built in,
// with a role, or an extra key), and for a key it does not know a proposed
// role. The groups the headers declare come back with their tiers, as a
// proposed taxonomy, and the folders of pages and layouts that carry headers
// as proposed node kinds. The tiers are in the order `tierOrder` lists them
// (the headings of the repo's own index, from `tierSource`), then massimo's
// order, then as they first appear.
export function headerCensus(root, files, config = {}, text = (f) => readText(root, f), { tierOrder = [], tierSource = null } = {}) {
  const { roles } = keyRoles(config)
  const extra = new Set(config.graph?.extraKeys ?? [])
  const byKey = new Map()
  const groups = new Map()
  const headed = []
  const componentGlob = compileGlobs(config.components?.include ?? [])
  const kindDirs = new Map()
  for (const f of files) {
    if (!CODE_EXT.test(f)) continue
    const entries = headerEntries(text(f))
    if (entries.length === 0) continue
    headed.push(f)
    const seen = new Set()
    for (const e of entries) {
      let k = byKey.get(e.key)
      if (!k) {
        k = { key: e.key, files: [], lines: 0, values: [], repeats: false }
        byKey.set(e.key, k)
      }
      k.lines++
      k.values.push(e.value)
      if (seen.has(e.key)) k.repeats = true
      else k.files.push(f)
      seen.add(e.key)
    }
    const group = entries.find((e) => e.key === 'group')?.value.trim()
    if (group) {
      const g = groups.get(group) ?? { group, tier: tierOf(group), files: 0 }
      g.files++
      groups.set(group, g)
    }
    const folder = componentGlob(f) ? null : kindFolder(f)
    if (folder) kindDirs.set(`${folder.kind}|${folder.dir}`, folder)
  }
  // A role as the config writes it: its name, or { role, values, under }.
  const asWritten = (r) => (r.values || r.under ? { role: r.role, ...(r.values ? { values: r.values } : {}), ...(r.under ? { under: r.under } : {}) } : r.role)
  const keys = [...byKey.values()]
    .map((k) => {
      const builtin = RULE_KEYS.includes(k.key)
      const role = roles.get(k.key) ?? null
      const proposed = builtin || role ? null : proposeRole(k.values, { files, oncePerFile: !k.repeats })
      return {
        key: k.key,
        files: k.files.length,
        lines: k.lines,
        examples: k.files.slice(0, 3),
        builtin,
        role: role ? asWritten(role) : null,
        extra: extra.has(k.key),
        proposed,
        values: [...new Set(k.values.map((v) => (v.length > 80 ? `${v.slice(0, 77)}...` : v)))].sort(compare).slice(0, 8),
      }
    })
    .sort((a, b) => b.files - a.files || compare(a.key, b.key))
  // The built-in keys a repo does not use yet are known all the same.
  for (const key of RULE_KEYS) {
    if (!byKey.has(key)) keys.push({ key, files: 0, lines: 0, examples: [], builtin: true, role: null, extra: false, proposed: null, values: [] })
  }
  const seenGroups = [...groups.values()]
  const tiersSeen = [...new Set(seenGroups.map((g) => g.tier).filter(Boolean))]
  const listed = [...new Set(tierOrder)].filter((t) => tiersSeen.includes(t))
  const tiers = [...new Set([...listed, ...DEFAULT_TIERS.filter((t) => tiersSeen.includes(t)), ...tiersSeen])]
  const ordered = tiers.flatMap((t) => seenGroups.filter((g) => g.tier === t))
  const kinds = {}
  for (const { kind, dir } of [...kindDirs.values()].sort((a, b) => compare(a.dir, b.dir))) {
    const exts = [...new Set(files.filter((f) => f.startsWith(`${dir}/`) && CODE_EXT.test(f) && !STYLE_EXT.test(f) && !isTestFile(f)).map((f) => f.slice(f.lastIndexOf('.') + 1)))].sort(compare)
    if (exts.length === 0) continue
    ;(kinds[kind] ??= []).push(`${dir}/**/*.${exts.length === 1 ? exts[0] : `{${exts.join(',')}}`}`)
  }
  return {
    files: headed.length,
    keys,
    groups: ordered,
    taxonomy: ordered.length > 0 ? { tiers, groups: ordered.map((g) => g.group) } : null,
    ...(listed.length > 0 && tierSource ? { tiersFrom: tierSource } : {}),
    kinds,
  }
}

// ── Story tools and lanes ───────────────────────────────────────────────────

const CSF_FILE = /\.stories\.[cm]?[jt]sx?$/
const OTHER_STORY_FILE = /\.stories\.(?:mdx|svelte|vue)$|\.mdx$/
const HISTOIRE_FILE = /\.story\.(?:vue|svelte)$/
const TOOL_COMMAND = {
  storybook: /\b(?:storybook\s+(?:dev|build)|start-storybook|build-storybook)\b/,
  ladle: /\bladle\s+(?:serve|dev|build|preview)\b/,
  histoire: /\bhistoire\s+(?:dev|build|preview)\b/,
}
const TOOL_CONFIG = {
  storybook: (f) => f.startsWith('.storybook/'),
  ladle: (f) => f.startsWith('.ladle/'),
  histoire: (f) => /^histoire\.config\.[cm]?[jt]s$/.test(f),
}
const portIn = (cmd) => Number((/--port[ =](\d+)/.exec(cmd) ?? /(?:^|\s)-p[ =]?(\d+)/.exec(cmd) ?? /\bPORT=(\d+)/.exec(cmd))?.[1]) || null

// Each story file of the tools detect found, read statically, with what it
// could not read. A file no reader knows (MDX, Svelte CSF) is listed as not
// statically readable.
function storyFileRecords(root, files, tools, text) {
  const out = []
  for (const f of files) {
    if (isTestFile(f)) continue
    if (CSF_FILE.test(f)) {
      const csf = readCsf(text(f), f)
      out.push({
        file: f,
        format: 'csf',
        title: csf.title,
        component: csf.component,
        stories: csf.stories.map((s) => s.storyName ?? s.export),
        exports: csf.stories.map((s) => s.export),
        args: csf.args,
        argTypes: csf.argTypes,
        unreadable: csf.unreadable.map((u) => (u.story ? `${u.story}: ${u.detail}` : u.detail)),
      })
    } else if (HISTOIRE_FILE.test(f) && tools.includes('histoire')) {
      const h = readHistoire(text(f))
      out.push({
        file: f,
        format: 'histoire',
        title: h.stories[0]?.title ?? null,
        component: null,
        stories: h.stories.flatMap((s) => (s.variants.length > 0 ? s.variants.map((v) => `${s.title ?? '(untitled)'} / ${v ?? '(untitled)'}`) : [s.title ?? '(untitled)'])),
        exports: [],
        args: false,
        argTypes: false,
        unreadable: h.unreadable.map((u) => u.detail),
      })
    } else if (OTHER_STORY_FILE.test(f) && /\.stories\./.test(f)) {
      out.push({ file: f, format: 'other', title: null, component: null, stories: [], exports: [], args: false, argTypes: false, unreadable: ['this kind of story file is not statically readable'] })
    }
  }
  return out
}

// The tools detect found, each with its config, the package scripts that run
// it, its port and its story files.
function storyTools(tools, files, pkg, records) {
  return tools.map((tool) => {
    const scripts = Object.entries(pkg.scripts ?? {}).filter(([, cmd]) => TOOL_COMMAND[tool]?.test(String(cmd)))
    const own = records.filter((r) => (tool === 'histoire' ? r.format === 'histoire' : r.format !== 'histoire'))
    return {
      tool,
      config: files.filter((f) => TOOL_CONFIG[tool]?.(f)),
      scripts: scripts.map(([name]) => name).sort(compare),
      port: scripts.map(([, cmd]) => portIn(String(cmd))).find(Boolean) ?? null,
      files: own.length,
      stories: own.reduce((n, r) => n + r.stories.length, 0),
      withArgs: own.filter((r) => r.args || r.argTypes).length,
      notReadable: own.filter((r) => r.unreadable.length > 0).length,
    }
  })
}

// The lane detect found, read further: its gate's integration file, its page
// and frame patterns, its manifest's entries, the state blocks on its pages,
// the package scripts that run it and the folder its build writes to.
function laneRecord(root, files, pkg, lane, text) {
  if (!lane?.dir) return null
  const dir = lane.dir
  const pageIndex = files.filter((f) => new RegExp(`^${escapeRe(dir)}/pages/[^/]+/index\\.[a-z]+$`).test(f))
  const pageFlat = files.filter((f) => new RegExp(`^${escapeRe(dir)}/pages/[^/]+\\.[a-z]+$`).test(f))
  const extOf = (list) => {
    const counts = new Map()
    for (const f of list) counts.set(f.slice(f.lastIndexOf('.') + 1), (counts.get(f.slice(f.lastIndexOf('.') + 1)) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))[0]?.[0]
  }
  const pages = pageIndex.length >= pageFlat.length && pageIndex.length > 0 ? `${dir}/pages/{slug}/index.${extOf(pageIndex)}` : pageFlat.length > 0 ? `${dir}/pages/{slug}.${extOf(pageFlat)}` : null
  const frameFiles = files.filter((f) => new RegExp(`^${escapeRe(dir)}/pages/[^/]+/frame\\.[a-z]+$`).test(f))
  const frames = frameFiles.length > 0 ? `${dir}/pages/{slug}/frame.${extOf(frameFiles)}` : null
  const pageFiles = pages ? (pages.includes('/index.') ? pageIndex : pageFlat) : []
  let states = 0
  let statesNotReadable = 0
  for (const f of pageFiles) {
    for (const s of readStoryStates(text(f))) {
      states++
      if (typeof s.label !== 'string') statesNotReadable++
    }
  }
  // What it cannot read, and of that what is a whole entry (or the whole
  // list): readManifest says so by a null field, which a check can trust
  // where a message's wording may change.
  let manifest = null
  if (lane.manifest) {
    const m = readManifest(text(lane.manifest), lane.manifest)
    const shown = (u) => (u.slug ? `${u.slug}: ${u.detail}` : u.detail)
    manifest = {
      path: lane.manifest,
      list: m.name,
      entries: m.entries.filter(Boolean).length,
      notReadable: m.unreadable.map(shown),
      entriesNotReadable: m.unreadable.filter((u) => u.field === null).map(shown),
    }
  }
  // The integration a gate config imports: the local file that reads the flag.
  let integration = null
  if (lane.gate && lane.gate !== 'package.json scripts') {
    for (const spec of [...text(lane.gate).matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1])) {
      const base = posix.normalize(posix.join(dirOf(lane.gate) || '.', spec))
      const hit = [base, ...['.mjs', '.js', '.ts', '.cjs', '.mts'].map((e) => base + e)].find((f) => files.includes(f))
      if (hit && /process\.env\.STORIES\b/.test(text(hit))) integration = hit
    }
  }
  const gated = Object.entries(pkg.scripts ?? {}).filter(([, cmd]) => /\bSTORIES=(?:1|true)\b/.test(String(cmd)) || /--config\s+\S*stories\S*\.config\./.test(String(cmd)))
  const outDir = gated.map(([, cmd]) => /--outDir[ =](\S+)/.exec(String(cmd))?.[1]).find(Boolean) ?? null
  return {
    dir,
    gate: lane.gate,
    integration,
    index: lane.index,
    manifest,
    pages,
    frames,
    pageCount: pageFiles.length,
    frameCount: frameFiles.length,
    states,
    statesNotReadable,
    scripts: gated.map(([name]) => name).sort(compare),
    devScript: lane.devScript,
    port: lane.port,
    route: `/${basename(dir)}`,
    outDir: outDir ? outDir.replace(/^\.\//, '').replace(/\/$/, '') : null,
    files: files.filter((f) => f.startsWith(`${dir}/`)).length,
    // The kinds of code the lane holds, for a glob that covers all of it.
    exts: [...new Set(files.filter((f) => f.startsWith(`${dir}/`) && CODE_EXT.test(f) && !STYLE_EXT.test(f)).map((f) => f.slice(f.lastIndexOf('.') + 1)))].sort(compare),
  }
}

// ── The repo's own design-system files ──────────────────────────────────────

const MASSIMO_MADE = /Generated by massimo|"generatedBy":\s*"massimo/
const ID_HEADING = /^### [^\s]+\s*$/gm
const WRITER = /\b(?:generated|written)\s+(?:by|from)\s+`?\.?\/?[\w@./-]+\.(?:mjs|cjs|js|ts|mts|py|sh)\b/i
const DO_NOT_EDIT = /\bdo not edit\b|\bdon't edit\b/i

// Whether a file says another file writes it: a line near its top that names
// its writer (`generated by scripts/x.mjs`), or a comment there that says not
// to edit it. The bare word "generated" in prose is not enough.
function generatedMark(text) {
  const head = text.slice(0, 1200)
  if (head.split('\n').some((line) => WRITER.test(line))) return true
  const blocks = [...head.matchAll(/<!--([\s\S]*?)(?:-->|(?![\s\S]))|\/\*([\s\S]*?)(?:\*\/|(?![\s\S]))/g)].map((m) => m[1] ?? m[2])
  const lines = [...head.matchAll(/^\s*(?:\/\/|#)(.*)$/gm)].map((m) => m[1])
  return [...blocks, ...lines].some((c) => DO_NOT_EDIT.test(c))
}

// The names a graph's node headings may use for a file with a ds: header:
// its name without the extension, and each tail of its path
// (`case/Figure`, `components/case/Figure`).
function nodeNames(files) {
  const out = new Set()
  for (const f of files) {
    const parts = f.replace(/\.[^./]+$/, '').split('/')
    for (let i = 0; i < parts.length; i++) out.add(parts.slice(i).join('/'))
  }
  return out
}
const NOT_DOCS = /^(?:\.github|\.claude|\.vscode|node_modules)\/|(?:^|\/)(?:package(?:-lock)?|tsconfig[\w.-]*|jsconfig|composer|components)\.json$/
const isDtcg = (text) => /"\$value"|"\$themes"|"\$metadata"/.test(text) || /\{\s*"value"\s*:[^{}]*"type"\s*:|\{\s*"type"\s*:[^{}]*"value"\s*:/.test(text)

// What a generated page is, by its name: a token page, an index, or the graph.
const docKind = (f) => (/token/i.test(basename(f)) ? 'tokens' : /^(?:index|readme)\.md$/i.test(basename(f)) ? 'index' : 'graph')

// A JSON ratchet: { rules: { <rule>: { count, offenders } } }.
function ratchetRules(json) {
  const rules = isPlainObject(json?.rules) ? Object.entries(json.rules) : []
  const shaped = rules.filter(([, r]) => isPlainObject(r) && typeof r.count === 'number' && isPlainObject(r.offenders))
  if (shaped.length === 0 || shaped.length !== rules.length) return null
  return shaped.map(([rule, r]) => ({ rule, count: r.count, offenders: Object.keys(r.offenders).length }))
}

// A massimo audit kind for each ratchet rule by name (colour spelt either
// way, a `raw-` prefix dropped), and the rules with none.
export function proposedMap(rules, kinds) {
  const pairs = []
  const unmapped = []
  for (const { rule } of rules) {
    const name = rule.replace(/colour/g, 'color')
    const kind = [name, name.replace(/^raw-/, '')].find((k) => kinds.includes(k))
    if (kind) pairs.push(`${rule}=${kind}`)
    else unmapped.push(rule)
  }
  return { map: pairs.join(','), unmapped }
}

// The script a generated file names as its writer, when it is in the repo.
function writerNamed(text, files) {
  const m = /(?:generated|written)\s+(?:by|from)\s+`?([\w./-]+\.(?:mjs|cjs|js|ts|mts|py|sh))/i.exec(text.slice(0, 1200))
  return m && files.includes(m[1].replace(/^\.\//, '')) ? m[1].replace(/^\.\//, '') : null
}

// The files a package script runs directly (node, tsx, bun, python, sh),
// and the other package scripts it runs.
export function scriptRuns(cmd) {
  const s = String(cmd)
  const runs = [...s.matchAll(/(?:^|[\s;&|(])(?:node|tsx|ts-node|bun|deno run|python3?|sh|bash)\s+(?:-{1,2}[\w-]+(?:[ =]\S+)?\s+)*\.?\/?([\w@./-]+\.(?:mjs|cjs|js|ts|mts|py|sh))\b/g)].map((m) => m[1].replace(/^\.\//, ''))
  const scripts = [...s.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/g)].map((m) => m[1]).filter((n) => !['ci', 'install', 'i', 'exec', 'x', 'run'].includes(n))
  return { files: [...new Set(runs)], scripts: [...new Set(scripts)] }
}

// The repo's own design-system files: a generated graph or index (markdown
// that says what writes it, with `### <id>` node headings that name files
// with ds: headers), a ratchet, token JSON that is not DTCG (the repo's own
// shape: an oracle to test against, never a source), a DESIGN.md (front
// matter with tokens or components), the other files in the same folder
// (generated, or written by hand), and the script that writes them, found
// from what the files say and from the package scripts. The repo root is
// never a design-system folder: its README and changelog are the repo's own.
export function ownFiles(root, files, pkg, text = (f) => readText(root, f)) {
  const candidates = files.filter((f) => /\.(?:md|json)$/i.test(f) && !NOT_DOCS.test(f))
  const docs = []
  const ratchets = []
  const tokenFiles = []
  const designMd = []
  const folders = new Set()
  const addFolder = (f) => {
    if (dirOf(f)) folders.add(dirOf(f))
  }
  let names = null
  const namesFile = (heading) => (names ??= nodeNames(headedFiles(files, text))).has(heading.slice(4).trim())
  for (const f of candidates) {
    const t = text(f)
    if (!t || MASSIMO_MADE.test(t.slice(0, 2000))) continue
    if (/(?:^|\/)design\.md$/i.test(f)) {
      const d = readDesignMd(t)
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t)?.[1]
      if (front === undefined || (d.tokens.length === 0 && !/^components:/m.test(front))) continue
      const groups = {}
      for (const tok of d.tokens) groups[tok.path[0]] = (groups[tok.path[0]] ?? 0) + 1
      designMd.push({ path: f, version: d.version, name: d.name, tokens: groups, components: d.components.length, rules: d.components.filter((c) => c.useWhen || c.never).length + d.rules.length, problems: d.problems.map((p) => `line ${p.line}: ${p.message}`) })
      continue
    }
    if (f.endsWith('.json')) {
      const json = readJsonText(t)
      const rules = ratchetRules(json)
      if (rules) {
        ratchets.push({ path: f, rules, writer: writerNamed(String(json?.note ?? ''), files) })
        addFolder(f)
      } else if (/token/i.test(basename(f)) && !isDtcg(t)) {
        const tokenNames = new Set(t.match(/"--[\w-]+"/g) ?? [])
        if (tokenNames.size >= 3) {
          // JSON has no comments: a note near its top that says not to edit it is the mark.
          tokenFiles.push({ path: f, tokens: Array.isArray(json?.tokens) ? json.tokens.length : tokenNames.size, generated: generatedMark(t) || DO_NOT_EDIT.test(t.slice(0, 600)), writer: writerNamed(t, files) })
          addFolder(f)
        }
      }
      continue
    }
    const headings = t.match(ID_HEADING) ?? []
    if (headings.length >= 3 && generatedMark(t) && headings.filter(namesFile).length >= 3) {
      docs.push({ path: f, kind: docKind(f), nodes: headings.length, generated: true, writer: writerNamed(t, files) })
      addFolder(f)
    }
  }
  // The rest of each design-system folder: generated files and hand-written notes.
  const known = new Set([...docs, ...ratchets, ...tokenFiles].map((d) => d.path))
  for (const f of candidates) {
    if (known.has(f) || !f.endsWith('.md') || !folders.has(dirOf(f))) continue
    const t = text(f)
    if (!t || MASSIMO_MADE.test(t.slice(0, 2000))) continue
    const generated = generatedMark(t)
    docs.push({ path: f, kind: generated ? docKind(f) : 'notes', nodes: (t.match(ID_HEADING) ?? []).length, generated, writer: generated ? writerNamed(t, files) : null })
  }
  docs.sort((a, b) => compare(a.path, b.path))
  // The writer: the script the files name; failing that, a script a package
  // script runs that writes files and names their folder and one of them.
  const outputs = [...docs.filter((d) => d.generated), ...ratchets, ...tokenFiles.filter((t) => t.generated)]
  const writers = new Map()
  const addWriter = (path) => writers.get(path) ?? writers.set(path, { path, scripts: [], writes: [] }).get(path)
  for (const o of outputs) if (o.writer) addWriter(o.writer)
  const named = writers.size > 0
  const writesThem = (t) => /\bwriteFile(?:Sync)?\s*\(/.test(t) && [...folders].some((dir) => dir && t.includes(dir)) && outputs.some((o) => t.includes(basename(o.path)))
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    for (const f of scriptRuns(cmd).files) {
      if (files.includes(f) && (writers.has(f) || (!named && writesThem(text(f))))) addWriter(f).scripts.push(name)
    }
  }
  for (const w of writers.values()) {
    const t = text(w.path)
    w.writes = outputs.filter((o) => o.writer === w.path || t.includes(o.path) || (t.includes(dirOf(o.path)) && t.includes(basename(o.path)))).map((o) => o.path).sort(compare)
    w.scripts.sort(compare)
    for (const o of outputs) if (!o.writer && w.writes.includes(o.path)) o.writer = w.path
  }
  const generators = [...writers.values()].sort((a, b) => compare(a.path, b.path))
  return { docs, ratchets: ratchets.sort((a, b) => compare(a.path, b.path)), tokenFiles: tokenFiles.sort((a, b) => compare(a.path, b.path)), designMd, generators }
}

// ── Assets ──────────────────────────────────────────────────────────────────

// The things adopt tracks, each with its class (graph, stories, audit,
// tokens, docs), the paths it covers, and what names it in other files:
// script names, a port, a route, a build folder. `family` groups assets that
// move together, so the files of one are not counted as consumers of
// another.
export function assetList({ lane, tools, own, styleFiles = [] }) {
  const out = []
  const add = (a) => out.push({ dirs: [], scripts: [], port: null, route: null, outDir: null, family: null, ...a })
  if (lane) {
    const family = `lane:${lane.dir}`
    add({ id: `lane:${lane.dir}`, class: 'stories', kind: 'lane', paths: [], dirs: [lane.dir], scripts: lane.scripts, port: lane.port, route: lane.route, outDir: lane.outDir, family })
    // The integration is the lane's too, but outside its folder: what it
    // reads (the manifest) counts, and the lane's own files naming it do not.
    if (lane.integration) add({ id: `gate:${lane.integration}`, class: 'stories', kind: 'gate', paths: [lane.integration], skip: [lane.dir] })
    if (lane.manifest) add({ id: `manifest:${lane.manifest.path}`, class: 'stories', kind: 'manifest', paths: [lane.manifest.path], family })
    if (lane.pages) add({ id: `pages:${lane.dir}/pages`, class: 'stories', kind: 'pages', paths: [], dirs: [`${lane.dir}/pages`], family })
  }
  for (const t of tools) {
    const dirs = t.config.some((f) => f.includes('/')) ? [...new Set(t.config.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))] : []
    add({ id: `tool:${t.tool}`, class: 'stories', kind: 'tool', paths: t.config.filter((f) => !f.includes('/')), dirs, scripts: t.scripts, port: t.port, family: `tool:${t.tool}` })
  }
  for (const f of styleFiles) add({ id: `styles:${f}`, class: 'tokens', kind: 'styles', paths: [f] })
  const generated = new Set()
  for (const g of own.generators) {
    add({ id: `generator:${g.path}`, class: 'graph', kind: 'generator', paths: [g.path], scripts: g.scripts, family: `generator:${g.path}` })
    for (const p of g.writes) generated.add(p)
  }
  const familyOf = (o) => (o.writer ? `generator:${o.writer}` : null)
  for (const t of own.tokenFiles) add({ id: `tokens:${t.path}`, class: 'tokens', kind: 'token-json', paths: [t.path], family: familyOf(t), output: Boolean(t.writer) })
  for (const r of own.ratchets) add({ id: `ratchet:${r.path}`, class: 'audit', kind: 'ratchet', paths: [r.path], family: familyOf(r), output: Boolean(r.writer) })
  for (const d of own.docs) {
    const cls = d.kind === 'notes' ? 'docs' : d.kind === 'tokens' ? 'tokens' : 'graph'
    add({ id: `${d.kind === 'notes' ? 'notes' : 'doc'}:${d.path}`, class: cls, kind: d.kind, paths: [d.path], family: familyOf(d), output: Boolean(d.writer) || d.generated })
  }
  for (const d of own.designMd) add({ id: `design-md:${d.path}`, class: 'docs', kind: 'design-md', paths: [d.path] })
  return out.sort((a, b) => compare(a.id, b.id))
}

// ── Consumers ───────────────────────────────────────────────────────────────

const STRENGTH = ['imports', 'type-checks', 'runs', 'names', 'links', 'mentions', 'comment']
const BUILD_SCRIPTS = ['build', 'prebuild', 'postbuild']
const SCRIPT_DIRS = ['scripts', 'tools', 'bin']
const ROOT_CONFIG = /^[^/]+\.(?:json|jsonc|toml|ya?ml|[cm]?[jt]s)$/
const NOT_CONSUMERS = /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|massimo\.config\.json|package\.json)$/
const TYPE_CHECK = /\b(?:astro\s+check|tsc\b|vue-tsc|svelte-check|nuxi\s+typecheck)/

// The text patterns that name an asset: its paths, its folders, its package
// scripts as run by a package manager, its port, its route and its build
// folder. `basenames` lists the file names that count only beside their
// folder, for a writer that joins the two.
function needlesOf(asset) {
  const out = []
  const path = (p) => new RegExp(`(?<![\\w.-])${escapeRe(p)}(?![\\w-])`)
  for (const p of [...asset.paths, ...asset.dirs]) out.push(path(p))
  for (const s of asset.scripts) out.push(new RegExp(`(?:\\b(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?|["']run["']\\s*,\\s*["'])${escapeRe(s)}(?![\\w:.-])`))
  if (asset.port) out.push(new RegExp(`(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):${asset.port}(?!\\d)|--port[ =]${asset.port}(?!\\d)|\\bPORT=${asset.port}(?!\\d)|["']?port["']?\\s*:\\s*${asset.port}(?!\\d)`))
  if (asset.route) out.push(new RegExp(`(?<![\\w.-])${escapeRe(asset.route)}(?=[/"'\`\\s)?#]|$)`, 'm'))
  if (asset.outDir) out.push(path(asset.outDir))
  return out
}

// A workflow as the repo root sees it: comments blanked, and so is every job
// or step whose working-directory is another folder (its own, its job's, or
// the workflow's `defaults`), since its `npm run` names a nested app's
// scripts. In a step that changes folder with `cd <dir>`, what follows the
// cd is blanked too. Lines keep their numbers.
export function workflowText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, '$1'))
  const indentOf = (l) => l.length - l.trimStart().length
  const ROOT_DIR = /^(?:\.\/?|\$\{\{\s*github\.workspace\s*\}\}\/?|\$\{?GITHUB_WORKSPACE\}?\/?)$/
  const elsewhere = (chunk) => {
    const m = /working-directory:\s*['"]?([^'"\s]+)/.exec(chunk)
    return m ? !ROOT_DIR.test(m[1]) : null
  }
  const blank = (from, to) => {
    for (let i = from; i < to; i++) lines[i] = ''
  }
  // In a step's run script, from a `cd` into another folder to the end of
  // the step. A block script's lines sit deeper than its `run:` key.
  const blankAfterCd = (from, to) => {
    let runCol = null
    for (let i = from; i < to; i++) {
      const key = /^(\s*(?:-\s+)?)run:/.exec(lines[i])
      if (key) runCol = key[1].length
      else if (runCol === null || (lines[i].trim() && indentOf(lines[i]) <= runCol)) {
        runCol = null
        continue
      }
      const offset = key ? key[0].length : 0
      const m = /(?:^|[\s;&|(])cd\s+(['"]?)([^\s'";&|)]+)\1/.exec(lines[i].slice(offset))
      if (!m || ROOT_DIR.test(m[2])) continue
      lines[i] = lines[i].slice(0, offset + m.index)
      blank(i + 1, to)
      return
    }
  }
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (jobsAt === -1) return lines.join('\n')
  // The workflow's own defaults: the top-level block before or after jobs.
  const defaultsAt = lines.findIndex((l) => /^defaults:\s*$/.test(l))
  let workflowElsewhere = false
  if (defaultsAt !== -1) {
    let stop = defaultsAt + 1
    while (stop < lines.length && (!lines[stop].trim() || indentOf(lines[stop]) > 0)) stop++
    workflowElsewhere = elsewhere(lines.slice(defaultsAt, stop).join('\n')) === true
  }
  // Each job: its lines from its key to the next key at the same indent.
  const starts = []
  let jobIndent = null
  let end = lines.length
  for (let i = jobsAt + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const ind = indentOf(lines[i])
    if (ind === 0) {
      end = i
      break
    }
    jobIndent ??= ind
    if (ind === jobIndent) starts.push(i)
  }
  starts.forEach((start, n) => {
    const stop = starts[n + 1] ?? end
    const stepsAt = lines.slice(start, stop).findIndex((l) => /^\s*steps:\s*$/.test(l))
    const head = lines.slice(start, stepsAt === -1 ? stop : start + stepsAt).join('\n')
    const jobElsewhere = elsewhere(head) ?? workflowElsewhere
    if (stepsAt === -1) {
      if (jobElsewhere) blank(start, stop)
      return
    }
    let stepIndent = null
    const steps = []
    for (let i = start + stepsAt + 1; i < stop; i++) {
      if (/^\s*- /.test(lines[i]) && (stepIndent === null || indentOf(lines[i]) === stepIndent)) {
        stepIndent ??= indentOf(lines[i])
        steps.push(i)
      }
    }
    steps.forEach((s, k) => {
      const to = steps[k + 1] ?? stop
      const own = elsewhere(lines.slice(s, to).join('\n'))
      if (own === true || (own === null && jobElsewhere)) blank(s, to)
      else blankAfterCd(s, to)
    })
  })
  return lines.join('\n')
}

// The job of a workflow that holds a line: its key under `jobs:` and its
// `name:`, or null when the line is outside every job.
export function workflowJob(text, line) {
  const lines = text.split(/\r?\n/)
  const jobsAt = lines.findIndex((l) => /^jobs:\s*(?:#.*)?$/.test(l))
  if (jobsAt === -1 || !line || line - 1 <= jobsAt) return null
  let job = null
  let indent = null
  // The indent of the job's own keys, where its `name:` sits.
  let own = null
  for (let i = jobsAt + 1; i < lines.length && i < line; i++) {
    const l = lines[i]
    if (!l.trim() || /^\s*#/.test(l)) continue
    const at = l.length - l.trimStart().length
    if (at === 0) return null
    indent ??= at
    if (at === indent) {
      job = { id: /^\s*([\w.-]+):/.exec(l)?.[1] ?? l.trim(), name: null }
      own = null
      continue
    }
    own ??= at
    const name = at === own ? /^\s*name:\s*(['"]?)(.+?)\1\s*$/.exec(l) : null
    if (job && name && !job.name) job.name = name[2]
  }
  return job
}

// A component file (.astro, .vue, .svelte) with its markup blanked: what is
// left is the code that runs, its frontmatter, <script> and <style> blocks,
// and the import and read calls in its template. A path or a command in the
// markup is text a reader sees, a mention, not a read. Offsets are kept.
const MARKUP_FILE = /\.(?:astro|vue|svelte)$/
const READ_CALL = /(?<![\w$])(?:import|require|readFileSync|readFile|fetch|glob)\s*\(/g
export function markupBlanked(text, file) {
  if (!MARKUP_FILE.test(file)) return text
  const keep = []
  if (file.endsWith('.astro')) {
    const fence = /^\s*---[^\n]*\n/.exec(text)
    if (fence) {
      const close = text.indexOf('\n---', fence[0].length - 1)
      keep.push([0, close === -1 ? text.length : close + 4])
    }
  }
  for (const m of text.matchAll(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|(?![\s\S]))/gi)) keep.push([m.index, m.index + m[0].length])
  for (const m of text.matchAll(READ_CALL)) {
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < text.length && i < m.index + 400; i++) {
      if (text[i] === '(') depth++
      else if (text[i] === ')' && --depth === 0) break
    }
    keep.push([m.index, i + 1])
  }
  let out = ''
  let at = 0
  for (const [from, to] of keep.sort((a, b) => a[0] - b[0])) {
    if (to <= at) continue
    out += text.slice(at, Math.max(at, from)).replace(/[^\n]/g, ' ') + text.slice(Math.max(at, from), to)
    at = to
  }
  return out + text.slice(at).replace(/[^\n]/g, ' ')
}

// The first place `text` names the asset, as its offset, or -1. A file named
// by its bare name counts when the text also names its folder.
function firstMention(text, asset, needles) {
  let best = -1
  for (const re of needles) {
    const m = re.exec(text)
    if (m && (best === -1 || m.index < best)) best = m.index
  }
  if (best === -1) {
    for (const p of asset.paths) {
      const dir = dirOf(p)
      if (!dir || !text.includes(dir)) continue
      const m = new RegExp(`(?<![\\w.-])${escapeRe(basename(p))}(?![\\w-])`).exec(text)
      if (m) best = m.index
    }
  }
  return best
}

// Who depends on each asset: imports read from the repo's code (and CSS
// @import), the targets of Markdown links, and a plain text search of
// package.json scripts, workflows, .claude, the config files at the root,
// docs and code. Each consumer is classed deploy (app code or build config
// imports or reads it), ci (a workflow runs it), hand-run (a package script,
// a file under scripts/, or tooling under .claude) or docs (Markdown, or a
// code comment). A workflow that runs a package script which depends on an
// asset depends on it through that script.
export function consumerIndex(root, files, assets, { pkg = {}, config = {}, text: read = (f) => readText(root, f) } = {}) {
  const text = (f) => (/^\.github\/workflows\//.test(f) ? workflowText(read(f)) : read(f))
  const fileSet = new Set(files)
  const owns = (a, f) => a.paths.includes(f) || a.dirs.some((d) => f.startsWith(`${d}/`))
  const families = new Map()
  for (const a of assets) if (a.family) families.set(a.family, [...(families.get(a.family) ?? []), a])
  const outputs = new Set(assets.filter((a) => a.output).flatMap((a) => a.paths))
  // A file is never a consumer of itself, of an asset of its own family, or
  // of an asset whose `skip` folders hold it.
  const skipped = (a, f) => owns(a, f) || (a.family && families.get(a.family).some((b) => owns(b, f))) || (a.skip ?? []).some((d) => f.startsWith(`${d}/`))
  const needles = new Map(assets.map((a) => [a, needlesOf(a)]))
  const found = new Map(assets.map((a) => [a.id, new Map()]))
  const record = (a, key, entry) => {
    const m = found.get(a.id)
    const was = m.get(key)
    if (!was || STRENGTH.indexOf(entry.how) < STRENGTH.indexOf(was.how)) m.set(key, entry)
  }

  // What runs what: package scripts run files and other scripts, workflows
  // run package scripts and files.
  const scripts = Object.entries(pkg.scripts ?? {}).map(([name, cmd]) => ({ name, cmd: String(cmd), ...scriptRuns(cmd) }))
  const workflows = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))
  const workflowRuns = new Map(workflows.map((w) => [w, scriptRuns(text(w))]))
  const scriptsRunBy = (name, depth = 0, seen = new Set()) => {
    if (seen.has(name) || depth > 4) return []
    seen.add(name)
    const s = scripts.find((x) => x.name === name)
    return s ? [name, ...s.scripts.flatMap((n) => scriptsRunBy(n, depth + 1, seen))] : []
  }
  const ciScripts = new Set([...workflowRuns.values()].flatMap((r) => r.scripts.flatMap((n) => scriptsRunBy(n))))
  const ciFiles = new Set([...[...workflowRuns.values()].flatMap((r) => r.files), ...scripts.filter((s) => ciScripts.has(s.name)).flatMap((s) => s.files)])
  const runners = (f) => scripts.filter((s) => s.files.includes(f)).map((s) => s.name).sort(compare)
  const testsInCi = [...workflowRuns.values()].some((r) => r.scripts.some((n) => /^test/.test(n))) || workflows.some((w) => /\bnpx\s+(?:vitest|jest|playwright)\b/.test(text(w)))
  const classOf = (f, how) => {
    if (f.startsWith('.github/workflows/')) return 'ci'
    if (/\.md$/i.test(f) || how === 'comment' || how === 'links' || how === 'mentions') return 'docs'
    if (f.startsWith('.claude/')) return 'hand-run'
    if (isTestFile(f)) return testsInCi ? 'ci' : 'hand-run'
    if (SCRIPT_DIRS.includes(f.split('/')[0]) && f.includes('/')) return ciFiles.has(f) ? 'ci' : 'hand-run'
    return 'deploy'
  }
  // A doc that names its writer is regenerated, never edited by hand.
  const writers = new Map()
  const writerOf = (f) => {
    if (!writers.has(f)) writers.set(f, /\.md$/i.test(f) ? writerNamed(text(f), files) : null)
    return writers.get(f)
  }
  const entryFor = (f, how, line) => {
    const entry = { file: f, line, class: classOf(f, how), how }
    const by = runners(f)
    if (by.length > 0 && SCRIPT_DIRS.includes(f.split('/')[0])) entry.runBy = by
    if (writerOf(f)) entry.writtenBy = writerOf(f)
    return entry
  }

  // Imports, CSS @import and Markdown links.
  const resolve = createResolver(root, config)
  for (const f of files) {
    if (outputs.has(f) || !(CODE_EXT.test(f) || /\.md$/i.test(f))) continue
    const t = text(f)
    if (!t) continue
    const targets = []
    if (/\.md$/i.test(f)) {
      for (const m of t.matchAll(/\]\(\s*<?([^)\s>#?]+)/g)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(m[1]) || m[1].startsWith('#')) continue
        let link = m[1]
        try {
          link = decodeURI(link)
        } catch {
          // kept as written
        }
        const target = link.startsWith('/') ? link.slice(1) : posix.normalize(posix.join(dirOf(f) || '.', link))
        targets.push({ file: target.replace(/\/$/, ''), how: 'links', index: m.index })
      }
    } else {
      for (const imp of extractImports(t, f)) {
        const hit = resolve(f, imp.spec)
        if (hit.file) targets.push({ file: hit.file, how: 'imports', index: t.indexOf(imp.spec) })
      }
      if (STYLE_EXT.test(f) || /\.(?:astro|vue|svelte)$/.test(f)) {
        for (const m of stripComments(t, f).matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)) {
          const target = posix.normalize(posix.join(dirOf(f) || '.', m[1]))
          if (fileSet.has(target)) targets.push({ file: target, how: 'imports', index: m.index })
        }
      }
    }
    for (const target of targets) {
      for (const a of assets) {
        if (skipped(a, f)) continue
        if (owns(a, target.file) || a.dirs.includes(target.file)) record(a, f, entryFor(f, target.how, lineAt(t, Math.max(0, target.index))))
      }
    }
  }

  // Text: code, docs, workflows, .claude, root config files.
  const searchable = (f) =>
    !NOT_CONSUMERS.test(f) &&
    !outputs.has(f) &&
    (CODE_EXT.test(f) || /\.md$/i.test(f) || /^\.github\/workflows\//.test(f) || (f.startsWith('.claude/') && /\.(?:json|md|ya?ml|txt)$/.test(f)) || ROOT_CONFIG.test(f))
  for (const f of files) {
    if (!searchable(f)) continue
    const t = text(f)
    if (!t) continue
    let code = null
    let runs = null
    for (const a of assets) {
      if (skipped(a, f)) continue
      let at = firstMention(t, a, needles.get(a))
      if (at === -1) continue
      let how = /\.md$/i.test(f) ? 'mentions' : 'names'
      // In code, a mention outside comments is the one that counts, and in a
      // component file one in its markup is only a mention.
      if (how === 'names' && CODE_EXT.test(f)) {
        code ??= stripComments(t, f)
        const live = firstMention(code, a, needles.get(a))
        runs ??= markupBlanked(code, f)
        const run = runs === code ? live : firstMention(runs, a, needles.get(a))
        if (live === -1) how = 'comment'
        else if (run === -1) [how, at] = ['mentions', live]
        else at = run
      }
      record(a, f, entryFor(f, how, lineAt(t, at)))
    }
  }

  // Package scripts: what each names, the lane a type check covers, and the
  // assets a script reaches through the scripts it runs.
  const tsconfig = readJsonText(text('tsconfig.json')) ?? {}
  const covers = (dir) => {
    const asGlob = (p) => (/[*?{]/.test(p) ? p : `${p.replace(/^\.\//, '').replace(/\/$/, '')}/**`)
    const include = compileGlobs((tsconfig.include ?? ['**/*']).map(asGlob))
    const exclude = compileGlobs((tsconfig.exclude ?? []).map(asGlob))
    const probe = `${dir}/x.ts`
    return include(probe) && !exclude(probe)
  }
  const ownScript = (a, name) => a.scripts.includes(name)
  const scriptAssets = new Map(scripts.map((s) => [s.name, new Map()]))
  for (const s of scripts) {
    for (const a of assets) {
      if (ownScript(a, s.name)) continue
      if (firstMention(s.cmd, a, needles.get(a)) !== -1) scriptAssets.get(s.name).set(a, 'names')
      else if (a.kind === 'lane' && TYPE_CHECK.test(s.cmd) && covers(a.dirs[0])) scriptAssets.get(s.name).set(a, 'type-checks')
      else if (s.files.some((f) => owns(a, f))) scriptAssets.get(s.name).set(a, 'runs')
    }
  }
  // Through `npm run <other>`: an asset's own script, or one that depends on it.
  const reach = (name, seen = new Set()) => {
    if (seen.has(name)) return new Map()
    seen.add(name)
    const out = new Map(scriptAssets.get(name) ?? [])
    const s = scripts.find((x) => x.name === name)
    for (const other of s?.scripts ?? []) {
      for (const a of assets) if (ownScript(a, other) && !ownScript(a, name) && !out.has(a)) out.set(a, `runs ${other}`)
      for (const [a, how] of reach(other, seen)) if (!out.has(a) && !ownScript(a, name)) out.set(a, `through ${other}`)
    }
    return out
  }
  for (const s of scripts) {
    for (const [a, how] of reach(s.name)) {
      const cls = BUILD_SCRIPTS.includes(s.name) ? 'deploy' : ciScripts.has(s.name) ? 'ci' : 'hand-run'
      const entry = { file: 'package.json', script: s.name, line: null, class: cls, how: how.startsWith('runs') || how.startsWith('through') ? 'runs' : how }
      if (how.includes(' ')) entry.via = how.split(' ').pop()
      record(a, `package.json#${s.name}`, entry)
    }
  }
  // Workflows that run an asset's script, or a package script that depends on it.
  for (const [w, runs] of workflowRuns) {
    const t = text(w)
    for (const name of runs.scripts) {
      const reached = reach(name)
      for (const a of assets) {
        if (!ownScript(a, name) && !reached.has(a)) continue
        const m = new RegExp(`\\b(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?${escapeRe(name)}(?![\\w:.-])`).exec(t)
        record(a, w, { file: w, line: m ? lineAt(t, m.index) : null, class: 'ci', how: 'runs', via: name })
      }
    }
  }

  const out = {}
  for (const a of assets) {
    out[a.id] = [...found.get(a.id).values()].sort((x, y) => compare(x.file, y.file) || compare(x.script ?? '', y.script ?? ''))
  }
  return out
}

// ── The inventory ───────────────────────────────────────────────────────────

const STYLE_SOURCE = /--[\w-]+\s*:/g

// The whole inventory of a repo, from detect's report (its framework, story
// tools, lane and style files) and the repo's files. Read-only.
export function buildInventory(root, { detected, config = {}, pkg = {}, files, auditKinds = [] }) {
  const cache = new Map()
  const text = (f) => {
    if (!cache.has(f)) cache.set(f, readText(root, f))
    return cache.get(f)
  }
  const tools = detected?.storyTools?.tools?.filter((t) => TOOL_COMMAND[t]) ?? []
  const records = storyFileRecords(root, files, tools, text)
  const lane = laneRecord(root, files, pkg, detected?.storyTools?.lane, text)
  const own = ownFiles(root, files, pkg, text)
  // The repo's own index may list its tiers as headings: that is their order.
  const index = own.docs.find((d) => d.kind === 'index' && d.generated)
  const tierOrder = index ? [...text(index.path).matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)].map((m) => m[1]) : []
  const headers = headerCensus(root, files, config, text, { tierOrder, tierSource: index?.path ?? null })
  for (const r of own.ratchets) Object.assign(r, proposedMap(r.rules, auditKinds))
  // The style files the config names, or detect's suggestion before there is one.
  const styleFiles = (config.tokens?.styleFiles?.length ? config.tokens.styleFiles : detected?.suggestedConfig?.tokens?.styleFiles ?? []).filter((f) => files.includes(f) && (text(f).match(STYLE_SOURCE) ?? []).length > 0)
  const toolRecords = storyTools(tools, files, pkg, records)
  const assets = assetList({ lane, tools: toolRecords, own, styleFiles })
  const consumers = consumerIndex(root, files, assets, { pkg, config, text })
  return {
    format: INVENTORY_FORMAT,
    generatedBy: 'massimo adopt',
    framework: detected?.framework ?? config.framework ?? null,
    stories: { tools: toolRecords, lane, files: records },
    headers,
    own: { ...own, styleFiles },
    assets: assets.map((a) => ({ id: a.id, class: a.class, kind: a.kind, paths: [...a.paths, ...a.dirs.map((d) => `${d}/`)].sort(compare), ...(a.scripts.length ? { scripts: a.scripts } : {}), ...(a.port ? { port: a.port } : {}), ...(a.output ? { output: true } : {}), consumers: consumers[a.id] })),
  }
}

// ── The inventory as Markdown ───────────────────────────────────────────────

const CLASSES_SEEN = ['deploy', 'ci', 'hand-run', 'docs']
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)]
const where = (c) => `${c.file}${c.script ? ` (\`${c.script}\`)` : ''}${c.line ? `:${c.line}` : ''}`
const roleText = (r) => (r === null || r === undefined ? '' : typeof r === 'string' ? r : `${r.role}${r.under ? ` under ${r.under}` : ''}${r.values ? ` (${r.values.join(', ')})` : ''}`)
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// The inventory for a person to read: what was found, the header census,
// the repo's own files, and each asset's consumers.
export function inventoryMarkdown(inv, { command }) {
  const out = ['# Adopt inventory', '', `<!-- Generated by massimo adopt. Do not edit by hand. Regenerate: ${command} -->`, '']
  out.push('What this repo already has for its design system, read without running any of it, and who depends on each part. Check what it found before the plan step.', '')
  const consumers = inv.assets.flatMap((a) => a.consumers)
  const byClass = CLASSES_SEEN.map((c) => `${c} ${consumers.filter((x) => x.class === c).length}`).join(', ')
  const lane = inv.stories.lane
  const extra = inv.headers.keys.filter((k) => !k.builtin)
  out.push('## Summary', '')
  out.push(`- Story lane: ${lane ? `${lane.dir}${lane.manifest ? `, manifest ${lane.manifest.path} with ${plural(lane.manifest.entries, 'entry', 'entries')}` : ''}, ${plural(lane.pageCount, 'page')}, ${plural(lane.frameCount, 'frame')}, ${plural(lane.states, 'state')}` : 'none'}.`)
  out.push(`- Story tools: ${inv.stories.tools.length ? inv.stories.tools.map((t) => `${t.tool} (${plural(t.files, 'file')}, ${plural(t.stories, 'story', 'stories')})`).join(', ') : 'none'}.`)
  out.push(`- Header keys: ${plural(inv.headers.keys.filter((k) => k.files > 0).length, 'key')} in use on ${plural(inv.headers.files, 'file')}, ${extra.length} beyond the built-in ones.`)
  out.push(`- The repo's own files: ${plural(inv.own.docs.filter((d) => d.generated).length, 'generated doc')}, ${plural(inv.own.ratchets.length, 'ratchet')}, ${plural(inv.own.tokenFiles.length, 'token file')}, ${plural(inv.own.docs.filter((d) => !d.generated).length, 'hand-written note')}${inv.own.generators.length ? `, written by ${inv.own.generators.map((g) => g.path).join(', ')}` : ''}.`)
  out.push(`- DESIGN.md: ${inv.own.designMd.length ? inv.own.designMd.map((d) => d.path).join(', ') : 'none'}.`)
  out.push(`- Consumers: ${consumers.length} (${byClass}).`, '')

  out.push('## Stories', '')
  if (lane) {
    out.push('### The lane', '')
    out.push(
      ...table(['Field', 'Value'], [
        ['Folder', lane.dir],
        ['Gate', [lane.gate, lane.integration].filter(Boolean).join(', ')],
        ['Manifest', lane.manifest ? `${lane.manifest.path} (${lane.manifest.list}, ${plural(lane.manifest.entries, 'entry', 'entries')})` : 'none'],
        ['Pages', lane.pages ? `${lane.pages} (${lane.pageCount})` : 'none'],
        ['Frames', lane.frames ? `${lane.frames} (${lane.frameCount})` : 'none'],
        ['States', `${lane.states}${lane.statesNotReadable ? `, ${lane.statesNotReadable} not statically readable` : ''}`],
        ['Scripts', lane.scripts.join(', ')],
        ['Port and route', `${lane.port ?? 'unknown'}, ${lane.route}`],
        ['Build folder', lane.outDir ?? 'none'],
      ]),
      '',
    )
    if (lane.manifest?.notReadable.length) out.push('Not statically readable in the manifest:', '', ...lane.manifest.notReadable.map((u) => `- ${u}`), '')
  }
  if (inv.stories.tools.length) {
    out.push('### Story tools', '')
    out.push(...table(['Tool', 'Config', 'Scripts', 'Port', 'Files', 'Stories', 'With args', 'Not readable'], inv.stories.tools.map((t) => [t.tool, t.config.join(', '), t.scripts.join(', '), t.port ?? '', t.files, t.stories, t.withArgs, t.notReadable])), '')
    const unreadable = inv.stories.files.filter((f) => f.unreadable.length > 0)
    if (unreadable.length) out.push('Story files with something not statically readable:', '', ...unreadable.map((f) => `- ${f.file}: ${f.unreadable.join('; ')}`), '')
  }
  if (!lane && !inv.stories.tools.length) out.push('No story lane or story tool.', '')

  out.push('## Header keys', '')
  if (inv.headers.keys.length) {
    out.push(...table(['Key', 'Files', 'Lines', 'Known', 'Role', 'Proposed role', 'Examples'], inv.headers.keys.map((k) => [`ds:${k.key}`, k.files, k.lines, k.builtin ? 'built in' : k.role ? 'has a role' : k.extra ? 'extra key' : 'no', roleText(k.role), roleText(k.proposed) || (k.builtin || k.role ? '' : 'none fits'), k.examples.join(', ')])), '')
    if (inv.headers.groups.length) {
      out.push('### Groups', '', `Proposed tiers, in order${inv.headers.tiersFrom ? ` (as the headings of ${inv.headers.tiersFrom} list them)` : ''}: ${inv.headers.taxonomy.tiers.join(', ')}.`, '')
      out.push('Scan proposes no path rules: a file without a ds:group line has no group until you add a rule for it to graph.taxonomy.rules.', '')
      out.push(...table(['Group', 'Tier', 'Files'], inv.headers.groups.map((g) => [g.group, g.tier, g.files])), '')
    }
    const kinds = Object.entries(inv.headers.kinds)
    if (kinds.length) out.push('### Pages and layouts with headers', '', ...kinds.map(([kind, globs]) => `- ${kind}: ${globs.join(', ')}`), '')
  } else out.push('No ds: header lines.', '')

  out.push("## The repo's own files", '')
  const ownRows = [
    ...inv.own.docs.map((d) => [d.path, d.kind === 'notes' ? 'hand-written notes' : `generated ${d.kind}${d.nodes ? `, ${d.nodes} node headings` : ''}`, d.writer ?? '']),
    ...inv.own.ratchets.map((r) => [r.path, `ratchet, ${plural(r.rules.length, 'rule')}`, r.writer ?? '']),
    ...inv.own.tokenFiles.map((t) => [t.path, `token file in the repo's own shape, ${t.tokens} tokens: an oracle to test against, never a source`, t.writer ?? '']),
    ...inv.own.designMd.map((d) => [d.path, `DESIGN.md${d.version ? ` version ${d.version}` : ''}, ${Object.values(d.tokens).reduce((a, b) => a + b, 0)} tokens, ${plural(d.components, 'component')}`, '']),
    ...inv.own.generators.map((g) => [g.path, `generator, run by ${g.scripts.length ? g.scripts.join(', ') : 'no package script'}`, '']),
    ...inv.own.styleFiles.map((f) => [f, 'style file with custom properties', '']),
  ].sort((a, b) => compare(a[0], b[0]))
  if (ownRows.length) out.push(...table(['File', 'What', 'Written by'], ownRows), '')
  else out.push('None found.', '')
  for (const r of inv.own.ratchets) {
    out.push(`### ${r.path}`, '')
    const kindOf = new Map(r.map.split(',').filter(Boolean).map((p) => p.split('=')))
    out.push(...table(['Rule', 'Count', 'Offenders', 'massimo kind'], r.rules.map((x) => [x.rule, x.count, x.offenders, kindOf.get(x.rule) ?? 'none'])), '')
    if (r.map) out.push(`To compare it with the audit: \`audit.mjs --import ${r.path} --map ${r.map}\`.`, '')
  }
  for (const d of inv.own.designMd) {
    if (d.problems.length) out.push(`### ${d.path}`, '', 'Left out of the front matter:', '', ...d.problems.map((p) => `- ${p}`), '')
  }

  out.push('## Consumers', '', 'Who depends on each part: deploy (app code or build config imports or reads it), ci (a workflow runs it), hand-run (a package script, a file under scripts/ or tooling) or docs (Markdown, or a comment in code).', '')
  for (const a of inv.assets) {
    out.push(`### ${a.id}`, '', `${a.class}, ${a.kind}: ${a.paths.join(', ')}${a.scripts ? `; scripts ${a.scripts.join(', ')}` : ''}${a.port ? `; port ${a.port}` : ''}.`, '')
    if (a.consumers.length === 0) out.push('No consumers found.', '')
    else out.push(...table(['Consumer', 'Class', 'How'], a.consumers.map((c) => [where(c), c.class, `${c.how}${c.via ? ` (through \`${c.via}\`)` : ''}${c.runBy ? ` (run by ${c.runBy.join(', ')})` : ''}${c.writtenBy ? ` (written by ${c.writtenBy})` : ''}`])), '')
  }
  return `${out.join('\n').trimEnd()}\n`
}

// What scan would find, in a few lines, for detect: lanes and story tools,
// ds: keys beyond the built-in ones and the config's, a repo's own graph,
// ratchet or token inventory, and a DESIGN.md. Empty when there is nothing
// to adopt. A key of the repo's own in one file only (a typo, a stray line)
// is listed beside something else, but is not enough on its own.
export function adoptableSummary(root, files, { tools = [], lane = null, config = {} } = {}) {
  const cache = new Map()
  const text = (f) => {
    if (!cache.has(f)) cache.set(f, readText(root, f))
    return cache.get(f)
  }
  const out = []
  if (lane?.dir) out.push({ kind: 'lane', paths: [lane.dir], note: `a gated story lane${lane.manifest ? ' with a manifest' : ''}` })
  for (const t of tools.filter((x) => TOOL_COMMAND[x])) out.push({ kind: 'stories', paths: [], note: `${t} stories` })
  const census = headerCensus(root, files, config, text)
  const extra = census.keys.filter((k) => !k.builtin && !k.role && !k.extra)
  if (extra.length > 0) out.push({ kind: 'headers', paths: [], note: `ds: keys beyond the built-in ones: ${extra.map((k) => `${k.key} (${k.files})`).join(', ')}` })
  const own = ownFiles(root, files, {}, text)
  for (const d of own.docs.filter((x) => x.generated && x.nodes >= 3 && x.kind !== 'tokens')) out.push({ kind: 'graph', paths: [d.path], note: `a generated ${d.kind}, ${d.nodes} node headings` })
  for (const r of own.ratchets) out.push({ kind: 'ratchet', paths: [r.path], note: `a ratchet, ${r.rules.length} rules` })
  for (const t of own.tokenFiles) out.push({ kind: 'tokens', paths: [t.path], note: `the repo's own token file, ${t.tokens} tokens` })
  for (const d of own.designMd) out.push({ kind: 'design-md', paths: [d.path], note: 'a DESIGN.md' })
  const strayKeysOnly = out.length === 1 && out[0].kind === 'headers' && extra.every((k) => k.files < 2)
  return strayKeysOnly ? [] : out
}
