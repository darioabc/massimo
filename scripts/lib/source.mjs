// Source parsing shared by massimo's graph, audit and tokens scripts: strip
// comments and find string literals without a real parser, extract imports and
// exports, resolve import specifiers (relative, aliases, tsconfig paths),
// harvest `ds:` rule comments, and read CSS custom properties by block.
//
// Regex-and-scanner on purpose: the same code has to read React, Vue, Svelte
// and Astro files, and it must run with zero dependencies. It aims for the
// right answer on real-world source, not for a full grammar.

import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { readJson } from './project.mjs'

// ── Comment and string scanning ─────────────────────────────────────────────

export function isSfc(file) {
  return /\.(vue|svelte|astro)$/i.test(file)
}

function syntaxFor(file) {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'css':
      return { block: true }
    case 'scss':
    case 'sass':
    case 'less':
    case 'styl':
      return { block: true, line: true }
    case 'vue':
    case 'svelte':
    case 'astro':
    case 'html':
    case 'htm':
      return { block: true, line: true, html: true, templates: true, multiline: true }
    default:
      return { block: true, line: true, templates: true }
  }
}

// One pass over `source` that records comment ranges and string-literal
// content ranges as [start, end) offsets. Ordinary strings end at a newline so
// a stray apostrophe in markup text cannot swallow the rest of the file;
// template literals nest their `${}` expressions properly.
export function scanSource(source, syntax) {
  const n = source.length
  const comments = []
  const strings = []
  let i = 0

  const lineEnd = (from) => {
    const k = source.indexOf('\n', from)
    return k === -1 ? n : k
  }

  const readString = (quote) => {
    const start = i + 1
    let j = start
    while (j < n) {
      const c = source[j]
      if (c === '\\') {
        j += 2
        continue
      }
      if (c === quote) break
      if (c === '\n' && !(syntax.multiline && quote === '"')) break
      j++
    }
    const end = Math.min(j, n)
    strings.push([start, end])
    i = end < n && source[end] === quote ? end + 1 : end
  }

  const readTemplate = () => {
    const start = i + 1
    i = start
    while (i < n) {
      const c = source[i]
      if (c === '\\') {
        i += 2
      } else if (c === '`') {
        strings.push([start, i])
        i++
        return
      } else if (c === '$' && source[i + 1] === '{') {
        i += 2
        readCode(true)
        if (i < n) i++
      } else {
        i++
      }
    }
    strings.push([start, n])
  }

  const readCode = (inExpression) => {
    let depth = 0
    while (i < n) {
      const c = source[i]
      const d = source[i + 1]
      if (c === '/' && d === '/' && syntax.line && source[i - 1] !== ':') {
        const end = lineEnd(i)
        comments.push([i, end])
        i = end
      } else if (c === '/' && d === '*' && syntax.block) {
        const k = source.indexOf('*/', i + 2)
        const end = k === -1 ? n : k + 2
        comments.push([i, end])
        i = end
      } else if (c === '<' && syntax.html && source.startsWith('<!--', i)) {
        const k = source.indexOf('-->', i + 4)
        const end = k === -1 ? n : k + 3
        comments.push([i, end])
        i = end
      } else if (c === '"' || c === "'") {
        readString(c)
      } else if (c === '`' && syntax.templates) {
        readTemplate()
      } else if (inExpression && c === '{') {
        depth++
        i++
      } else if (inExpression && c === '}') {
        if (depth === 0) return
        depth--
        i++
      } else {
        i++
      }
    }
  }

  readCode(false)
  return { comments, strings }
}

// `source` with every comment blanked to spaces (newlines kept), so offsets and
// line numbers stay valid.
export function stripComments(source, file) {
  const { comments } = scanSource(source, syntaxFor(file))
  if (comments.length === 0) return source
  let out = ''
  let from = 0
  for (const [start, end] of comments) {
    out += source.slice(from, start) + source.slice(start, end).replace(/[^\n]/g, ' ')
    from = end
  }
  return out + source.slice(from)
}

// Every string literal in the file as `{ text, start }` (content only, with the
// offset of its first character; comments excluded).
export function stringLiterals(source, file) {
  return scanSource(source, syntaxFor(file)).strings.map(([s, e]) => ({ text: source.slice(s, e), start: s }))
}

// ── Imports and exports ─────────────────────────────────────────────────────

const IMPORT_FROM = /(?<![\w$.])import\s+(type\s+)?([\w$*\s{},]+?)\s*\bfrom\s*(['"])([^'"\n]+)\3/g
const IMPORT_SIDE_EFFECT = /(?<![\w$.])import\s*(['"])([^'"\n]+)\1/g
const EXPORT_FROM = /(?<![\w$.])export\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\3/g
const IMPORT_DYNAMIC = /(?<![\w$.])import\s*\(\s*(['"`])([^'"`\n$]+)\1\s*[,)]/g
const REQUIRE = /(?<![\w$.])require\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g

const braceItems = (clause) => {
  const m = /\{([\s\S]*)\}/.exec(clause)
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : []
}

// What an import clause binds: `default`, `*` (namespace) and the original
// names inside braces. Type-only when every binding is `type`-prefixed.
function parseImportClause(clause) {
  const names = []
  const braced = braceItems(clause)
  const head = clause.replace(/\{[\s\S]*\}/, '').replace(/,\s*$/, '').trim()
  if (/^\*\s*as\b/.test(head)) names.push('*')
  else if (head) names.push('default')
  let typeCount = 0
  for (const item of braced) {
    if (/^type\s/.test(item)) typeCount++
    const original = item.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
    if (original) names.push(original)
  }
  const typeOnly = !head && braced.length > 0 && typeCount === braced.length
  return { names, typeOnly }
}

// Imports a file declares, in first-seen order, as
// `{ spec, kind, typeOnly, names, reexport? }`. kind is static | side-effect |
// export-from | dynamic | require. `names` are the original names bound
// (`default`, `*` for a namespace or when unknowable). An export-from also
// carries `reexport: { star, ns, pairs: [{ orig, name }] }` so a barrel file
// can be followed. Commented-out imports are ignored, as is import-looking
// text inside string literals of plain script files. Astro/Vue/Svelte files
// are scanned whole, frontmatter and template included.
export function extractImports(source, file = 'x.tsx') {
  const code = stripComments(source, file)
  let inString = null
  if (!syntaxFor(file).html) {
    const mask = new Uint8Array(code.length)
    for (const [s, e] of scanSource(code, syntaxFor(file)).strings) mask.fill(1, s, e)
    inString = mask
  }
  const found = []
  const seen = new Set()
  const add = (match, entry) => {
    if (inString?.[match.index]) return
    const key = `${entry.kind}|${entry.typeOnly}|${entry.spec}|${entry.names.join(',')}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({ index: match.index, ...entry })
  }
  for (const m of code.matchAll(IMPORT_FROM)) {
    const { names, typeOnly } = parseImportClause(m[2])
    add(m, { spec: m[4], kind: 'static', typeOnly: Boolean(m[1]) || typeOnly, names })
  }
  for (const m of code.matchAll(IMPORT_SIDE_EFFECT)) {
    add(m, { spec: m[2], kind: 'side-effect', typeOnly: false, names: ['*'] })
  }
  for (const m of code.matchAll(EXPORT_FROM)) {
    const clause = m[2]
    const reexport = { star: false, ns: null, pairs: [] }
    if (clause.startsWith('*')) {
      const ns = /^\*\s+as\s+([\w$]+)/.exec(clause)
      if (ns) reexport.ns = ns[1]
      else reexport.star = true
    } else {
      for (const item of braceItems(clause)) {
        const [orig, alias] = item.replace(/^type\s+/, '').split(/\s+as\s+/).map((s) => s.trim())
        if (orig) reexport.pairs.push({ orig, name: alias || orig })
      }
    }
    add(m, { spec: m[4], kind: 'export-from', typeOnly: Boolean(m[1]), names: ['*'], reexport })
  }
  for (const m of code.matchAll(IMPORT_DYNAMIC)) {
    add(m, { spec: m[2], kind: 'dynamic', typeOnly: false, names: ['*'] })
  }
  for (const m of code.matchAll(REQUIRE)) {
    add(m, { spec: m[2], kind: 'require', typeOnly: false, names: ['*'] })
  }
  return found.sort((a, b) => a.index - b.index).map(({ index, ...rest }) => rest)
}

// The name a file goes by: basename without extension, or the parent directory
// for an `index` file.
export function componentName(file) {
  const base = basename(file).replace(/\.[^.]+$/, '')
  if (base !== 'index') return base
  const parent = basename(dirname(file.replace(/\\/g, '/')))
  return parent && parent !== '.' ? parent : base
}

const EXPORT_DECL =
  /(?<![\w$.])export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:const\s+)?(function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g
const EXPORT_DEFAULT = /(?<![\w$.])export\s+default\b(?!\s+(?:async\s+)?(?:function\*?|class)\s+[A-Za-z_$])/
const EXPORT_LIST = /(?<![\w$.])export\s+(?:type\s+)?\{([^}]*)\}/g
const EXPORT_NS = /(?<![\w$.])export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g

// Sorted export names of a file. A `.vue`/`.svelte`/`.astro` file always
// default-exports its component, named from the file.
export function extractExports(source, file = 'x.tsx') {
  const code = stripComments(source, file)
  const names = new Set()
  const sfc = isSfc(file)
  const svelte = /\.svelte$/i.test(file)
  if (sfc) names.add(componentName(file))
  for (const m of code.matchAll(EXPORT_DECL)) {
    if (svelte && (m[1] === 'let' || m[1] === 'var')) continue // props, not exports
    names.add(m[2])
  }
  for (const m of code.matchAll(EXPORT_LIST)) {
    for (const part of m[1].split(',')) {
      const spec = part.trim().replace(/^type\s+/, '')
      if (!spec) continue
      const name = spec.split(/\s+as\s+/).pop().trim()
      if (name) names.add(name)
    }
  }
  for (const m of code.matchAll(EXPORT_NS)) names.add(m[1])
  if (!sfc && EXPORT_DEFAULT.test(code)) names.add('default')
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// ── Import resolution ───────────────────────────────────────────────────────

const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue', '.svelte', '.astro']
const TS_SWAP = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }

function packageName(spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function readTsconfig(abs, depth = 0) {
  let json
  try {
    json = readJson(abs)
  } catch {
    return null
  }
  if (!json) return null
  const opts = json.compilerOptions || {}
  let baseUrl = opts.baseUrl != null ? resolve(dirname(abs), opts.baseUrl) : null
  let paths = opts.paths ? { base: baseUrl ?? dirname(abs), map: opts.paths } : null
  if (depth === 0 && typeof json.extends === 'string' && json.extends.startsWith('.')) {
    const target = resolve(dirname(abs), json.extends)
    const parent = [target, `${target}.json`].find((p) => existsSync(p) && statSync(p).isFile())
    const loaded = parent ? readTsconfig(parent, 1) : null
    if (loaded) {
      baseUrl = baseUrl ?? loaded.baseUrl
      paths = paths ?? loaded.paths
    }
  }
  return { baseUrl, paths, references: Array.isArray(json.references) ? json.references : [] }
}

// tsconfig/jsconfig files that can carry `paths`: the root ones and whatever
// they reference (Vite scaffolds put the aliases in tsconfig.app.json).
function loadTsconfigs(root) {
  const out = []
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const abs = join(root, name)
    const cfg = readTsconfig(abs)
    if (!cfg) continue
    out.push(cfg)
    for (const ref of cfg.references) {
      if (!ref || typeof ref.path !== 'string') continue
      let target = resolve(dirname(abs), ref.path)
      if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'tsconfig.json')
      const child = readTsconfig(target, 1)
      if (child) out.push(child)
    }
  }
  return out
}

// A resolver for one repo. `resolve(fromFile, spec)` returns exactly one of
//   { file }        a repo-relative POSIX path that exists
//   { pkg }         a bare package name (never resolved on disk)
//   { unresolved }  a relative or alias import that points at nothing
//   { external }    a URL or scheme import (node:, astro:, https:...)
export function createResolver(root, config = {}) {
  const stats = new Map()
  const isFile = (abs) => {
    let hit = stats.get(abs)
    if (hit === undefined) {
      try {
        hit = statSync(abs).isFile()
      } catch {
        hit = false
      }
      stats.set(abs, hit)
    }
    return hit
  }
  const toRel = (abs) => relative(root, abs).split(sep).join('/')

  const tryPath = (base) => {
    if (isFile(base)) return base
    const ext = /\.[a-z]+$/i.exec(base)?.[0]
    for (const swap of TS_SWAP[ext] ?? []) {
      const candidate = base.slice(0, -ext.length) + swap
      if (isFile(candidate)) return candidate
    }
    for (const e of RESOLVE_EXTS) if (isFile(base + e)) return base + e
    for (const e of RESOLVE_EXTS) if (isFile(join(base, `index${e}`))) return join(base, `index${e}`)
    return null
  }

  const aliases = Object.entries(config.aliases ?? {})
    .map(([key, target]) => ({ key, target: String(target) }))
    .sort((a, b) => b.key.length - a.key.length)

  const tsconfigs = loadTsconfigs(root)
  const baseUrls = [...new Set(tsconfigs.map((c) => c.baseUrl).filter(Boolean))]
  const patterns = []
  for (const cfg of tsconfigs) {
    if (!cfg.paths) continue
    for (const [pattern, targets] of Object.entries(cfg.paths.map)) {
      const star = pattern.indexOf('*')
      patterns.push({
        prefix: star === -1 ? pattern : pattern.slice(0, star),
        suffix: star === -1 ? '' : pattern.slice(star + 1),
        star: star !== -1,
        targets: [].concat(targets),
        base: cfg.paths.base,
      })
    }
  }
  patterns.sort((a, b) => b.prefix.length - a.prefix.length)

  // A package counts as real when node_modules has it or package.json lists it,
  // so a checkout without an install still tells packages from broken aliases.
  const declared = new Set()
  try {
    const pkg = readJson(join(root, 'package.json'), {})
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg[field] ?? {})) declared.add(name)
    }
  } catch {
    // unreadable package.json: fall back to node_modules alone
  }
  const installed = (spec) => declared.has(packageName(spec)) || existsSync(join(root, 'node_modules', packageName(spec)))

  return function resolveImport(fromFile, rawSpec) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(rawSpec) || rawSpec.startsWith('#')) return { external: rawSpec }
    const spec = rawSpec.replace(/[?#].*$/, '')
    const fromDir = dirname(join(root, fromFile))

    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      const hit = tryPath(resolve(fromDir, spec))
      return hit ? { file: toRel(hit) } : { unresolved: rawSpec }
    }
    if (spec.startsWith('/')) {
      for (const base of [join(root, spec), join(root, 'public', spec)]) {
        const hit = tryPath(base)
        if (hit) return { file: toRel(hit) }
      }
      return { unresolved: rawSpec }
    }

    let aliased = false
    for (const { key, target } of aliases) {
      if (spec === key || (spec.startsWith(key) && (key.endsWith('/') || spec[key.length] === '/'))) {
        aliased = true
        const rest = spec.slice(key.length).replace(/^\//, '')
        const base = join(root, target.replace(/^\.\//, ''), rest)
        const hit = tryPath(base)
        if (hit) return { file: toRel(hit) }
      }
    }
    for (const p of patterns) {
      const matches = p.star
        ? spec.startsWith(p.prefix) && spec.endsWith(p.suffix) && spec.length >= p.prefix.length + p.suffix.length
        : spec === p.prefix
      if (!matches) continue
      aliased = true
      const captured = p.star ? spec.slice(p.prefix.length, spec.length - p.suffix.length) : ''
      for (const target of p.targets) {
        const hit = tryPath(resolve(p.base, target.replace('*', captured)))
        if (hit) return { file: toRel(hit) }
      }
    }
    for (const base of baseUrls) {
      const hit = tryPath(resolve(base, spec))
      if (hit) return { file: toRel(hit) }
    }
    if (aliased && !installed(spec)) return { unresolved: rawSpec }
    return { pkg: packageName(spec) }
  }
}

// ── File classification ─────────────────────────────────────────────────────

export function isStoryFile(file) {
  return /\.(stories|story)\.[^./]+$/.test(file)
}

export function isTestFile(file) {
  return /\.(test|spec)\.[^./]+$/.test(file) || /_test\.[^./]+$/.test(file) || /(^|\/)__(tests|mocks)__\//.test(file)
}

// ── ds: rule comments ───────────────────────────────────────────────────────

export const RULE_KEYS = ['parents', 'children', 'never', 'use-when', 'group', 'no-story']

const RULE_START = /(?:\/\/+|\/\*+|<!--+|^[ \t]*\*+(?!\/))[ \t]*ds:([a-z][a-z-]*)(:?)(?:[ \t]+(.*?))?[ \t]*\r?$/
const COMMENT_CLOSE = /\*+\/\}?\s*$|--+>\s*$/

// The text of a pure comment line with its markers removed, or null when the
// line is code (or blank). A comment that is only a marker gives ''.
function commentText(line) {
  const t = line.trim()
  let text = null
  if (t.startsWith('//')) text = t.replace(/^\/\/+\s?/, '')
  else if (t.startsWith('{/*')) text = t.replace(/^\{\/\*+\s?/, '')
  else if (t.startsWith('/*')) text = t.replace(/^\/\*+\s?/, '')
  else if (t.startsWith('<!--')) text = t.replace(/^<!--+\s?/, '')
  else if (/^\*+(?!\/)/.test(t)) text = t.replace(/^\*+\s?/, '')
  return text === null ? null : text.replace(/\s*(?:\*+\/\}?|--+>)\s*$/, '').trim()
}

// `ds:` header lines in any comment syntax (`//`, `/* */`, ` * ` continuation,
// `<!-- -->`, `{/* */}`), one key per line: `ds:group Primitives / Actions`.
// A value wraps onto the comment lines after it until a blank comment line,
// code, or another `ds:` line. Repeated keys accumulate, joined by a space.
// Returns { rules, unknown, entries }: `rules` holds the known keys in
// RULE_KEYS order (a bare `ds:no-story` is kept as ''); `unknown` lists keys not
// in RULE_KEYS; `entries` is every `ds:` line as written, `{ key, value, line }`,
// for checks that need a repeat or a position the joined `rules` lose.
export function extractRules(source, extraKeys = []) {
  const keys = [...RULE_KEYS, ...extraKeys.filter((k) => !RULE_KEYS.includes(k))]
  const found = {}
  const unknown = []
  const entries = []
  let current = null
  const finish = () => {
    if (!current) return
    const value = current.parts.join(' ')
    entries.push({ key: current.key, value, line: current.line, ...(current.colon ? { colon: true } : {}) })
    if (!keys.includes(current.key)) {
      if (!unknown.includes(current.key)) unknown.push(current.key)
    } else if (value) {
      found[current.key] = found[current.key] ? `${found[current.key]} ${value}` : value
    } else if (current.key === 'no-story' && found[current.key] === undefined) {
      found[current.key] = ''
    }
    current = null
  }
  const lines = source.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = RULE_START.exec(line)
    if (m) {
      finish()
      const first = (m[3] ?? '').replace(/\s*(?:\*+\/\}?|--+>)\s*$/, '').trim()
      current = { key: m[1], colon: m[2] === ':', parts: first ? [first] : [], open: !COMMENT_CLOSE.test(line), line: i + 1 }
    } else if (current?.open) {
      const text = commentText(line)
      if (text) {
        current.parts.push(text)
        if (COMMENT_CLOSE.test(line)) current.open = false
      } else {
        finish()
      }
    } else {
      finish()
    }
  }
  finish()
  const rules = {}
  for (const key of keys) if (found[key] !== undefined) rules[key] = found[key]
  return { rules, unknown, entries }
}

// ── CSS custom properties ───────────────────────────────────────────────────

// Walk CSS and return every block that holds declarations, as
// `{ headers, decls: [{ prop, value }] }`; `headers` is the chain of selectors
// and at-rule preludes from the outermost block in. Comments are ignored.
export function parseCssBlocks(css, file = 'x.css') {
  const text = stripComments(css, file)
  const blocks = []
  const stack = []
  let buf = ''
  let paren = 0
  const clean = (s) => s.replace(/\s+/g, ' ').trim()

  const flush = () => {
    const top = stack[stack.length - 1]
    const stmt = buf.trim()
    buf = ''
    if (!top || !stmt) return
    const colon = stmt.indexOf(':')
    if (colon === -1) return
    const prop = stmt.slice(0, colon).trim()
    if (!/^[-\w]+$/.test(prop)) return
    const value = clean(stmt.slice(colon + 1)).replace(/\s*!important$/i, '')
    top.decls.push({ prop, value })
  }

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'") {
      const start = i
      i++
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i++
        i++
      }
      buf += text.slice(start, i + 1)
      continue
    }
    if (c === '(') paren++
    else if (c === ')') paren = Math.max(0, paren - 1)
    if (paren > 0) {
      buf += c
    } else if (c === '{') {
      const block = { headers: [...stack.map((b) => b.header), clean(buf)], header: clean(buf), decls: [] }
      buf = ''
      stack.push(block)
      blocks.push(block)
    } else if (c === '}') {
      flush()
      stack.pop()
    } else if (c === ';') {
      flush()
    } else {
      buf += c
    }
  }
  return blocks.filter((b) => b.decls.length > 0).map(({ headers, decls }) => ({ headers, decls }))
}

const unquote = (s) => s.replace(/^['"]|['"]$/g, '')

// A selector list split at its top-level commas (`:is(a, b)` stays whole).
function selectorMembers(selector) {
  const out = []
  let depth = 0
  let cur = ''
  for (const c of selector) {
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1)
    if (c === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

// The compounds of a complex selector, split at its combinators outside
// brackets and parentheses: `html.dark > body` gives html.dark and body.
function compounds(selector) {
  const out = []
  let depth = 0
  let cur = ''
  for (const c of selector.trim()) {
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1)
    if (depth === 0 && /[\s>+~]/.test(c)) {
      if (cur) out.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur) out.push(cur)
  return out
}

const THEME_ATTR = /^\[data-(?:theme|mode)\s*[~|^$*]?=\s*["']?([\w-]+)["']?\s*(?:[is]\s*)?\]$/i
const themeMode = (name) => (/dark/i.test(name) ? 'dark' : /^(light|default)$/i.test(name) ? 'default' : name)

// One compound: `root` (html, body, :root, :host), `theme` (a theme class
// or data attribute, with its mode), both, or `other` (anything else, which
// makes the selector a component's). A root with another qualifier
// (`html[dir="rtl"]`, `:root[data-density="compact"]`) is a variant of the
// root, an override like a condition. A bare `[data-theme]` means any theme
// and qualifies nothing. `:not()` is left out; the arguments of `:is()`
// and `:where()` are classified as selectors of their own.
function classifyCompound(compound) {
  let root = false
  let mode = null
  let qualified = false
  for (const part of compound.match(/:{1,2}[\w-]+(?:\((?:[^()]|\([^()]*\))*\))?|\.[\w-]+|\[[^\]]*\]|#[\w-]+|\*|[\w-]+/g) ?? []) {
    if (/^:not\(/i.test(part)) continue
    const wrapped = /^:(?:is|where)\((.*)\)$/i.exec(part)
    if (wrapped) {
      const inner = selectorMembers(wrapped[1]).map(classifyMember)
      if (inner.some((m) => m.scope === 'local')) return { kind: 'other' }
      if (inner.some((m) => m.scope === 'root')) root = true
      mode = inner.find((m) => m.scope === 'selector')?.mode ?? mode
      continue
    }
    if (/^(?:html|body|:root|:host(?:\(.*\))?)$/i.test(part)) root = true
    else if (/^\.(?:theme-|mode-)?dark(?:-mode|-theme)?$/i.test(part)) mode = 'dark'
    else if (/^\.(?:theme-|mode-)?light(?:-mode|-theme)?$/i.test(part)) mode = 'default'
    else if (THEME_ATTR.test(part)) mode = themeMode(THEME_ATTR.exec(part)[1])
    else if (/^\[data-(?:theme|mode)\]$/i.test(part)) continue
    else if (/^(?:\[|:)/.test(part)) qualified = true
    else return { kind: 'other' }
  }
  if (qualified && (!root || mode !== null)) return { kind: 'other' }
  return mode !== null ? { kind: 'theme', mode } : root ? { kind: 'root', qualified } : { kind: 'other' }
}

// One member of a selector list. A theme or the root only when every
// compound in it is one (`[data-theme="dark"] body`, `html.dark`); a member
// that reaches into the page (`html.dark .band-block`, `.dark .card`) is a
// component's scope, whatever theme it names.
function classifyMember(member) {
  const parts = compounds(member).map(classifyCompound)
  if (parts.length === 0 || parts.some((p) => p.kind === 'other')) return { mode: 'default', scope: 'local' }
  const theme = parts.filter((p) => p.kind === 'theme').pop()
  if (theme) return { mode: theme.mode, scope: 'selector' }
  return parts.some((p) => p.qualified) ? { mode: 'default', scope: 'variant', member } : { mode: 'default', scope: 'root' }
}

// What an enclosing at-rule means for the values inside it: `scheme` (a
// colour-scheme media query and nothing else: its mode), `transparent`
// (@layer, or a media query of only `screen` or `all`), or `condition` (a
// width, a motion preference, @supports, @container: an override). A colour
// scheme together with another feature is a condition in that scheme.
function atRuleKind(header) {
  if (/^@layer\b/i.test(header)) return { kind: 'transparent' }
  if (!/^@media\b/i.test(header)) return { kind: 'condition' }
  const query = header.replace(/^@media\s*/i, '')
  const features = query.match(/\([^()]*\)/g) ?? []
  const scheme = features.map((f) => /prefers-color-scheme\s*:\s*(dark|light)/i.exec(f)?.[1]).find(Boolean)
  const others = features.filter((f) => !/prefers-color-scheme/i.test(f))
  const types = query.replace(/\([^()]*\)/g, ' ').split(/[\s,]+/).filter((w) => w && !/^(?:and|only)$/i.test(w))
  const plain = others.length === 0 && !query.includes(',') && types.every((t) => /^(?:all|screen)$/i.test(t))
  const mode = scheme ? themeMode(scheme) : null
  if (plain) return mode ? { kind: 'scheme', mode } : { kind: 'transparent' }
  return { kind: 'condition', mode }
}

// Where a block's declarations apply: which mode (default, dark, or a named
// theme) and what kind of scope (root, @theme, DaisyUI theme plugin, a
// component-local selector, or `conditional`: a root value under a
// condition, such as a phone-width @media, which is an override and never
// the default). Each member of a selector list is classified on its own:
// `html.dark, .band-dark` sets the dark theme. A nested selector is read with
// its parent in place of `&`.
function classifyBlock(block) {
  const headers = block.headers
  let inner = headers[headers.length - 1]
  const rules = headers.slice(0, -1).filter((h) => h.startsWith('@')).map(atRuleKind)
  const schemeMode = rules.map((r) => r.mode).filter(Boolean).pop() ?? null
  const conditions = headers.slice(0, -1).filter((h, i, list) => h.startsWith('@') && atRuleKind(h).kind === 'condition')
  const dark = schemeMode === 'dark'

  if (/^@plugin\s+["']daisyui\/theme["']/i.test(inner)) {
    const meta = {}
    for (const { prop, value } of block.decls) if (!prop.startsWith('--')) meta[prop] = unquote(value)
    const name = meta.name ?? 'theme'
    const isDark = meta.prefersdark === 'true' || /dark/i.test(name) || dark
    const base = meta.default === 'true' || /light/i.test(name)
    return { mode: isDark ? 'dark' : base ? 'default' : name, scope: 'daisy', selector: inner }
  }
  if (/^@theme\b/.test(inner)) {
    return { mode: dark ? 'dark' : 'default', scope: 'theme', selector: inner }
  }
  if (inner.startsWith('@')) return { mode: dark ? 'dark' : 'default', scope: 'local', selector: inner }

  const parent = headers.slice(0, -1).filter((h) => !h.startsWith('@')).pop()
  if (parent) {
    inner = selectorMembers(inner)
      .flatMap((m) => selectorMembers(parent).map((p) => (m.includes('&') ? m.replace(/&/g, p) : `${p} ${m}`)))
      .join(', ')
  }
  const members = selectorMembers(inner).map(classifyMember)
  const pick = members.find((m) => m.scope === 'selector' && m.mode === 'dark') ?? members.find((m) => m.scope === 'selector') ?? members.find((m) => m.scope === 'root') ?? members.find((m) => m.scope === 'variant') ?? { mode: 'default', scope: 'local' }
  let { mode, scope } = pick
  if (schemeMode) mode = schemeMode
  if (scope === 'variant') conditions.push(pick.member)
  if (scope !== 'local' && conditions.length > 0) return { mode, scope: 'conditional', selector: inner, condition: conditions.join(' ') }
  return { mode, scope, selector: inner }
}

// Every custom property declared in a stylesheet:
// `{ name, value, mode, scope, selector }`, in source order.
export function parseCustomProperties(css, file = 'x.css') {
  const out = []
  for (const block of parseCssBlocks(css, file)) {
    const ctx = classifyBlock(block)
    for (const { prop, value } of block.decls) {
      if (prop.startsWith('--')) out.push({ name: prop, value, ...ctx })
    }
  }
  return out
}

// ── Class-based component libraries, shared by graph and audit ─────────────

// What the graph and audit know about a library whose components are CSS
// classes: its component roots (`btn-primary` reports as `btn`), the theme
// colour names it always provides, the custom properties its themes set, and
// utilities that only look like a root (`select-none` is Tailwind, not a
// select). A library is active when `styling` in the config names it; detect
// adds `daisyui`. `graph.classLibraries` in the config adds others, or
// extends a built-in one, in the same shape.
const DAISY_ROOTS = [
  'alert', 'avatar', 'badge', 'breadcrumbs', 'btn', 'calendar', 'card', 'carousel', 'chat', 'checkbox',
  'collapse', 'countdown', 'diff', 'divider', 'dock', 'drawer', 'dropdown', 'fab', 'fieldset', 'file-input',
  'filter', 'footer', 'hero', 'indicator', 'input', 'join', 'kbd', 'label', 'link', 'list', 'loading',
  'mask', 'menu', 'mockup', 'modal', 'navbar', 'progress', 'radial-progress', 'radio', 'range', 'rating',
  'select', 'skeleton', 'stack', 'stat', 'stats', 'status', 'steps', 'swap', 'tab', 'tabs', 'table',
  'textarea', 'timeline', 'toast', 'toggle', 'tooltip', 'validator',
]

const DAISY_COLOR_NAMES = [
  'base-100', 'base-200', 'base-300', 'base-content', 'primary', 'primary-content', 'secondary',
  'secondary-content', 'accent', 'accent-content', 'neutral', 'neutral-content', 'info', 'info-content',
  'success', 'success-content', 'warning', 'warning-content', 'error', 'error-content',
]

export const CLASS_LIBRARIES = {
  daisyui: {
    roots: DAISY_ROOTS,
    colors: DAISY_COLOR_NAMES,
    vars: ['radius-selector', 'radius-field', 'radius-box', 'size-selector', 'size-field', 'border', 'depth', 'noise'],
    notRoots: [
      '^select-(?:none|text|all|auto)$',
      '^list-(?:none|disc|decimal|inside|outside|image-.*|\\[.*)$',
      '^table-(?!zebra$|xs$|sm$|md$|lg$|xl$|pin-rows$|pin-cols$)',
      '^filter-',
      '^mask-(?!squircle|heart|hexagon|decagon|pentagon|diamond|square|circle|parallelogram|star|triangle|half)',
      '^tab-\\d',
    ],
  },
}

// The libraries active for a config, as `{ id, roots, colors, vars, notRoots }`
// with `notRoots` compiled, in id order.
export function classLibraries(config = {}) {
  const extra = config.graph?.classLibraries ?? {}
  const ids = new Set([...(config.styling ?? []).filter((s) => CLASS_LIBRARIES[s]), ...Object.keys(extra)])
  return [...ids].sort().map((id) => {
    const base = CLASS_LIBRARIES[id] ?? {}
    const more = extra[id] ?? {}
    const list = (key) => [...new Set([...(base[key] ?? []), ...(more[key] ?? [])])]
    return { id, roots: list('roots'), colors: list('colors'), vars: list('vars'), notRoots: list('notRoots').map((p) => new RegExp(p)) }
  })
}

// ── W3C design tokens (DTCG) ────────────────────────────────────────────────

export const isAlias = (v) => typeof v === 'string' && /^\{[^{}]+\}$/.test(v.trim())
export const aliasPath = (v) => v.trim().slice(1, -1).trim()

// A custom property name: `--` and then letters, digits, `_` or `-`.
export const CSS_VAR_NAME = /^--[\p{L}\p{N}_-]+$/u

// The CSS variable a token path maps to: segments joined by `-`, with anything
// a custom property name cannot hold turned into `-`.
export const cssVarFor = (path) => `--${path.join('-').replace(/[^\p{L}\p{N}_-]+/gu, '-')}`

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Flatten a DTCG document into tokens, in source order:
// `{ path, name, type, value, description, modes, cssVar, on, contrast, collection }`.
// `$type` is inherited from the enclosing group; `$extensions.massimo` carries
// modes, a cssVar override, a contrast pair (`on`, `contrast`) and a Figma
// collection override. Pass `problems` (an array) to collect what is wrong
// with the document, each as `{ level, path, message }`; a name with `{`, `}`
// or `.` is left out, since no reference could reach it.
export function flattenDtcg(doc, problems = null) {
  const out = []
  const report = (path, message) => problems?.push({ level: 'error', path: path.join('.') || '(root)', message })
  const visit = (node, path, inheritedType) => {
    if (!isObject(node)) return
    const type = node.$type ?? inheritedType
    if ('$value' in node) {
      const children = Object.keys(node).filter((k) => !k.startsWith('$'))
      if (children.length > 0) report(path, `has a $value and child tokens (${children.join(', ')}); a token cannot also be a group`)
      const ext = isObject(node.$extensions?.massimo) ? node.$extensions.massimo : {}
      let cssVar = cssVarFor(path)
      if (ext.cssVar !== undefined) {
        if (typeof ext.cssVar === 'string' && CSS_VAR_NAME.test(ext.cssVar)) cssVar = ext.cssVar
        else report(path, `$extensions.massimo.cssVar ${JSON.stringify(ext.cssVar)} is not a CSS custom property name (--letters-digits-dashes)`)
      }
      if (ext.modes !== undefined && !isObject(ext.modes)) report(path, '$extensions.massimo.modes must be an object of mode name to value')
      if (ext.contrast !== undefined && typeof ext.contrast !== 'number') report(path, '$extensions.massimo.contrast must be a number, such as 4.5')
      out.push({
        path,
        name: path.join('.'),
        type: type ?? null,
        value: node.$value,
        description: typeof node.$description === 'string' ? node.$description : '',
        modes: isObject(ext.modes) ? ext.modes : {},
        cssVar,
        on: typeof ext.on === 'string' ? ext.on : null,
        contrast: typeof ext.contrast === 'number' ? ext.contrast : 4.5,
        collection: typeof ext.collection === 'string' ? ext.collection : null,
      })
      return
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$')) continue
      if (/[{}.]/.test(key)) {
        report([...path, key], 'a token or group name cannot contain {, } or .')
        continue
      }
      visit(child, [...path, key], type)
    }
  }
  visit(doc, [], undefined)
  return out
}
