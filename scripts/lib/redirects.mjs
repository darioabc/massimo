// Proving the lane against the tool it replaces: which story ids a repo
// mentions, whether each resolves, and every edit the repo must make before
// the tool can go.
//
// An id is a run of kebab words joined by `--`. A mention that ends in `--`,
// or that a template continues (`...--${name}`), is a prefix: it stands for
// every id that starts with it.

import { join } from 'node:path'
import { DEFAULT_STORY_TYPES, DEFAULT_TYPES_FILE, LEGACY_TYPES_FILE, checkTypesFile } from './convert.mjs'
import { compare } from './glob.mjs'
import { writeFileAtomic } from './project.mjs'
import { isStoryFile, isTestFile, stripComments } from './source.mjs'

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// ── Ids ─────────────────────────────────────────────────────────────────────

const SEGMENT = '[a-z0-9]+(?:-[a-z0-9]+)*'
// Not the middle of a longer word, an anchor (`#`), a path (`/`), a file name
// (`.`), a flag (`-`) or a package scope (`@`).
const ID_SHAPE = new RegExp(`(?<![\\w#/.@$%&+~\\\\-])(${SEGMENT}(?:--${SEGMENT})*)(--)?`, 'g')
const STORY_WORDS = /\bstor(?:y|ies)\b|story=|\bids?\b|meta\.json|ladle|storybook/i

const idSet = (registry) => new Set(Object.keys(registry?.stories ?? {}))

// Whether a mention names a story: `id` for an id, `prefix` for a prefix
// that at least one id starts with, null for neither. An id that matches no
// id but heads others (`a--b` for `a--b--c`) is a prefix too: a template can
// continue a mention through a variable (`${card.story}--${state}`) without
// a `--` or `${` right after it.
function resolves(mention, prefix, ids) {
  if (!prefix && ids.has(mention)) return 'id'
  const head = prefix ? mention : `${mention}--`
  for (const id of ids) if (id.startsWith(head)) return 'prefix'
  return null
}

// The story ids and id prefixes `text` mentions, as `{ mention, line, prefix }`
// in text order (a mention may repeat). Whatever has the shape of an id is a
// mention when it names a story of the registry (or starts one, for a
// prefix), has three or more parts (a prefix, two), or stands on a line that
// talks about stories; a lone `a--b` or `a--` elsewhere (a class name, a
// word with a double hyphen) is left out. Anchors, paths, file names and
// flags are never ids.
export function idMentions(text, registry) {
  if (typeof text !== 'string' || !text.includes('--')) return []
  const ids = idSet(registry)
  const lineStarts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1)
  const lineAt = (at) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= at) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const out = []
  for (const m of text.matchAll(ID_SHAPE)) {
    let mention = m[1] + (m[2] ?? '')
    if (!mention.includes('--')) continue
    const end = m.index + m[0].length
    let prefix = Boolean(m[2])
    if (!prefix) {
      const next = text.slice(end, end + 3)
      if (next.startsWith('${')) prefix = true
      else if (next.startsWith('-${')) [mention, prefix] = [`${mention}-`, true]
      else if (/^[\w-]/.test(next) || /^\.[A-Za-z0-9]/.test(next)) continue
    }
    const line = lineAt(m.index)
    const parts = mention.split('--').filter(Boolean).length
    if (parts < (prefix ? 2 : 3) && !resolves(mention, prefix, ids)) {
      const from = lineStarts[line - 1]
      const to = text.indexOf('\n', from)
      if (!STORY_WORDS.test(text.slice(from, to === -1 ? text.length : to))) continue
    }
    out.push({ mention, line, prefix })
  }
  return out
}

// The mentions of `consumerFiles` (`[{ file, text }]`) held against the
// registry and, when given, the ids of the tool's own `meta.json`. A mention
// resolves when an id (or, for a prefix, at least one id) of the registry
// matches it. One that does not is `missing` when the tool's ids match it
// (the move would break it), and `dead` when they do not either (it was
// already broken). Without `oracleIds`, nothing is dead. Each mention counts
// once per file, at its first line.
export function mentionCoverage(consumerFiles, registry, oracleIds = null) {
  const ids = idSet(registry)
  const oracle = Array.isArray(oracleIds) ? new Set(oracleIds) : null
  const out = { files: 0, mentions: 0, resolved: 0, missing: [], dead: [] }
  for (const { file, text } of consumerFiles ?? []) {
    const seen = new Set()
    let any = false
    for (const m of idMentions(text, registry)) {
      const key = `${m.prefix ? 'p' : 'i'}:${m.mention}`
      if (seen.has(key)) continue
      seen.add(key)
      any = true
      out.mentions++
      if (resolves(m.mention, m.prefix, ids)) out.resolved++
      else if (oracle && !resolves(m.mention, m.prefix, oracle)) out.dead.push({ file, ...m })
      else out.missing.push({ file, ...m })
    }
    if (any) out.files++
  }
  const order = (a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.mention, b.mention)
  out.missing.sort(order)
  out.dead.sort(order)
  return out
}

// ── The edits the repo must make ────────────────────────────────────────────

// The package names a story tool ships as, from the repo's dependencies, or
// the tool's usual one when package.json lists none.
export function toolPackages(tool, pkg = {}) {
  const have = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })
  const match = {
    ladle: (n) => n === '@ladle/react' || n.startsWith('@ladle/'),
    storybook: (n) => n === 'storybook' || n.startsWith('@storybook/'),
    histoire: (n) => n === 'histoire' || n.startsWith('@histoire/'),
  }[tool]
  const found = match ? have.filter(match).sort(compare) : []
  if (found.length > 0) return found
  return { ladle: ['@ladle/react'], storybook: ['storybook'], histoire: ['histoire'] }[tool] ?? []
}

// The tool's scripts plus the package scripts that run one of them (`npm run
// ladle:build` inside `ladle:build:pages`), found to a fixed point, sorted.
function toolScripts(tool, read) {
  const found = new Set(tool.scripts ?? [])
  let all = {}
  try {
    all = JSON.parse(read('package.json') || '{}').scripts ?? {}
  } catch {
    // a package.json that does not parse names no scripts
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const [key, command] of Object.entries(all)) {
      if (found.has(key) || typeof command !== 'string') continue
      const runs = [...found].some((s) => new RegExp(`\\b(?:npm|pnpm|yarn|bun)\\s+(?:run(?:-script)?\\s+)?(?:-[\\w-]+\\s+)*${escapeRe(s)}(?![\\w:.-])`).test(command))
      if (runs) {
        found.add(key)
        grew = true
      }
    }
  }
  return [...found].sort(compare)
}

export const isBinaryPath = (file) => BINARY.test(file)
const BINARY = /\.(?:png|jpe?g|gif|webp|avif|ico|icns|bmp|svg|woff2?|ttf|otf|eot|mp[34]|mov|webm|wav|ogg|pdf|zip|gz|tgz|tar|map|wasm|lock|lockb|snap|sqlite|db|bin|psd|ai|sketch|fig)$/i
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|massimo\.config\.json)$/
const CODE_COMMENTS = /\.(?:[cm]?[jt]sx?|css|scss|less|astro|vue|svelte)$/
const HASH_COMMENTS = /\.(?:ya?ml|sh|toml|env|gitignore|npmrc|conf)$|(?:^|\/)\.[\w.-]+ignore$|(?:^|\/)\.[\w.-]*rc$/
const DOC_FILE = /\.(?:md|mdx|markdown|txt|rst)$/i

// The class of a file: ci, skill, test, docs or code. A mention on a line
// that is only a comment is a `comment` instead, whatever the file.
function fileClass(file) {
  if (file.startsWith('.github/')) return 'ci'
  if (file.startsWith('.claude/skills/') || file.startsWith('.claude/commands/') || file.startsWith('.claude/agents/')) return 'skill'
  if (DOC_FILE.test(file)) return 'docs'
  if (isTestFile(file) || /^(?:e2e|tests?|specs?|cypress)(?:[-_.][\w.-]*)?\//.test(file)) return 'test'
  return 'code'
}

// Where story ids are looked for: specs, scripts, skills, docs and CI. The
// app's own source and the story files hold none, the tool's folders go with
// the tool, and a JSON file is data (an id list, a pairs file), not a use.
export const idScope = (file) => !(file.startsWith('src/') && !isTestFile(file)) && !isStoryFile(file) && !/\.jsonl?$/i.test(file)

const PATH_REPLACEMENTS = [
  [/\.css$/, "read the app's base CSS (stories.appCss.base), which the lane imports, instead; rules only stories need go in the lane's own CSS"],
  [/(?:components|provider|decorators?|preview)\.[cm]?[jt]sx?$/, 'use the lane frame (stories.frame)'],
  [/vite\.config\.[cm]?[jt]s$/, "use the lane's Vite config"],
  [/config\.[cm]?[jt]s$/, 'use the stories keys of massimo.config.json'],
]
const pathReplacement = (token) => PATH_REPLACEMENTS.find(([re]) => re.test(token))?.[1] ?? "move it into the lane's folder, or delete it with the tool"

// Whether `file` is covered by a historical entry: the file itself, or a
// folder (an entry ending in `/`, or any parent folder of the file).
const isHistorical = (file, historical) => historical.some((h) => file === h || file.startsWith(h.endsWith('/') ? h : `${h}/`))

// Every edit the repo must make before the tool can go, as `{ file, line,
// class, uses, replacement, status }` sorted by file and line, one entry per
// line. Four passes join: (a) the consumer index's files, with every line
// that names the tool's folders, scripts, commands or port, not only the
// first; (b) the tool's package name in code, tests, CI and docs, and a path
// into its folder of node_modules, leaving out the one type import of a story
// file that the removal patch rewrites (a frozen file's is still valid: the
// legacy types file keeps it declared); (c) the story
// ids and prefixes that specs, scripts, skills and docs use; (d) the tool's
// name as a word, anywhere.
//
// `class` is code, test, ci, skill, docs, comment or prose. `status` is
// `open` (to make before retire), `valid` (still works on the lane: a port,
// an id that resolves), `dead` (an id the tool's own ids never had either),
// `historical` (in a path the ledger marks historical) or `prose` (the tool's
// name as a word only). Retire is blocked by `open` and by nothing else.
// `tool` is the inventory's tool record (`tool`, `config`, `scripts`, `port`),
// `files` the repo's files, `read(file)` a file's text, `oracleIds` the tool's
// own ids when known, `skip` folders to leave out (the project folder) and
// `frozen` the config's frozen entries, whose files the removal patch leaves,
// and `legacyTypes` the file the patch adds for them, which is not an edit.
// A frozen file's type import is valid only when the legacy types file
// declares every name it imports; otherwise it stays open. `lane` lists the
// files the lane's recipe writes as they are (see recipeFiles), which name
// the tool on purpose. Neither those nor a frozen file, which stays byte for
// byte, are listed for the tool's name as a word.
export function toolEdits({ consumers = [], packages = [], registry, tool, historical = [], read, files = [], oracleIds = null, skip = [], frozen = [], legacyTypes = LEGACY_TYPES_FILE, lane = [] } = {}) {
  if (!tool || typeof read !== 'function') return []
  const name = tool.tool ?? tool.name
  if (!name) return []
  const dirs = [...new Set((tool.config ?? []).filter((f) => f.includes('/')).map((f) => f.split('/')[0]))].sort(compare)
  const own = (file) => dirs.some((d) => file === d || file.startsWith(`${d}/`)) || skip.some((d) => file.startsWith(d))
  const ids = idSet(registry)
  const oracle = Array.isArray(oracleIds) ? new Set(oracleIds) : null
  const pinned = new Set(frozen.map((f) => f.file ?? f))
  const noProse = new Set([...pinned, ...lane])
  const declared = () => {
    const there = read(legacyTypes)
    if (there) return new Set([...there.matchAll(/\bexport\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
    return new Set(checkTypesFile(read(DEFAULT_TYPES_FILE) || DEFAULT_STORY_TYPES, DEFAULT_TYPES_FILE).names)
  }
  let declaredNames = null

  const pathRes = [...dirs, ...(tool.config ?? []).filter((f) => !f.includes('/'))].map((p) => new RegExp(`(?<![\\w.-])(${escapeRe(p)}(?![\\w-])(?:/[^\\s'"\`)>,;]*)?)`))
  // The scripts that run the tool, and the package scripts that run one of
  // them through npm, directly or through another script. A script only named
  // for the tool (`e2e:ladle` running a browser test) is not one of them.
  const scripts = toolScripts(tool, read)
  const scriptRes = scripts.map((s) => new RegExp(`(?:\\b(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?|["']run["']\\s*,\\s*["'])(${escapeRe(s)})(?![\\w:.-])`))
  const scriptKeys = scripts.map((s) => new RegExp(`^\\s*"(${escapeRe(s)})"\\s*:`))
  const commandRe = new RegExp(`\\b(?:npx\\s+|bunx\\s+|pnpm\\s+exec\\s+|yarn\\s+)?(${escapeRe(name)}\\s+(?:serve|dev|build|preview|start))\\b`)
  const packageRes = packages.map((p) => new RegExp(`(?<![\\w@./-])(${escapeRe(p)})(?![\\w-])`))
  const modulePathRes = packages.map((p) => new RegExp(`node_modules/(${escapeRe(p)})(?![\\w-])`))
  const portRe = tool.port ? new RegExp(`(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):${tool.port}(?!\\d)|--port[ =]${tool.port}(?!\\d)|\\bPORT=${tool.port}(?!\\d)|["']?port["']?\\s*:\\s*${tool.port}(?!\\d)`) : null
  const cap = name[0].toUpperCase() + name.slice(1)
  const wordRe = new RegExp(`(?<![A-Za-z])(?:${escapeRe(name)}|${escapeRe(cap)})(?![a-z])|${escapeRe(name.toUpperCase())}`)
  const consumerAt = new Map()
  for (const c of consumers) if (!consumerAt.has(c.file)) consumerAt.set(c.file, c)

  const out = []
  const scan = [...new Set([...files, ...consumerAt.keys(), 'package.json'])].filter((f) => !BINARY.test(f) && !LOCKFILE.test(f) && !own(f) && f !== legacyTypes).sort(compare)
  for (const file of scan) {
    const text = read(file)
    if (!text) continue
    const lines = text.split('\n')
    const hits = new Map()
    const hit = (line, reason) => {
      const h = hits.get(line) ?? { open: [], valid: [], dead: [], prose: [], skip: [] }
      hits.set(line, h)
      h[reason.kind].push(reason)
    }
    // The lines of the one type import the removal patch rewrites, or in a
    // frozen file the one it leaves for the legacy types file to declare.
    const patched = registry?.files?.[file]?.typeImport
    let kept = false
    if (patched && pinned.has(file)) {
      declaredNames ??= declared()
      kept = patched.names.every((n) => declaredNames.has(n))
    }
    const missing = patched && pinned.has(file) && !kept ? patched.names.filter((n) => !declaredNames.has(n)) : []
    const patchedLines = new Set()
    if (patched) {
      const from = text.slice(0, patched.start).split('\n').length
      const to = from + text.slice(patched.start, patched.end).split('\n').length - 1
      for (let n = from; n <= to; n++) patchedLines.add(n)
    }
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (!l) continue
      const n = i + 1
      let used = false
      for (const re of pathRes) {
        const m = re.exec(l)
        if (m) {
          const token = m[1].replace(/[.,]+$/, '')
          hit(n, { kind: 'open', uses: token, replacement: pathReplacement(token) })
          used = true
        }
      }
      for (const re of scriptRes) {
        const m = re.exec(l)
        if (!m) continue
        hit(n, { kind: 'open', uses: `script ${m[1]}`, replacement: "run the lane's script instead (see the vite-csf recipe)" })
        used = true
      }
      if (file === 'package.json') {
        for (const re of scriptKeys) {
          const m = re.exec(l)
          if (!m) continue
          hit(n, { kind: 'open', uses: `script ${m[1]}`, replacement: 'remove it, or point it at the lane' })
          used = true
        }
      }
      const cmd = commandRe.exec(l)
      if (cmd) {
        hit(n, { kind: 'open', uses: `command ${cmd[1].replace(/\s+/g, ' ')}`, replacement: "run the lane's dev and build scripts instead" })
        used = true
      }
      for (const re of packageRes) {
        const m = re.exec(l)
        if (!m) continue
        if (patchedLines.has(n) && missing.length > 0) {
          hit(n, { kind: 'open', uses: `package ${m[1]}`, replacement: `export ${missing.join(', ')} from the types file and run convert stories again, so the legacy types file declares ${missing.length === 1 ? 'it' : 'them'}` })
          used = true
          continue
        }
        if (patchedLines.has(n)) {
          used = true
          if (pinned.has(file)) hit(n, { kind: 'valid', uses: `package ${m[1]}`, replacement: 'nothing: the file is frozen, and the legacy types file keeps this import declared' })
          else hit(n, { kind: 'skip' })
          continue
        }
        hit(n, { kind: 'open', uses: `package ${m[1]}`, replacement: file === 'package.json' ? 'remove the dependency once nothing imports it' : "import the types from the lane's story.ts, or drop the import" })
        used = true
      }
      for (const re of modulePathRes) {
        const m = re.exec(l)
        if (!m) continue
        hit(n, { kind: 'open', uses: `package ${m[1]}`, replacement: 'the package goes with the tool: read the file from somewhere else, or drop the use' })
        used = true
      }
      if (portRe?.test(l)) {
        hit(n, { kind: 'valid', uses: `port ${tool.port}`, replacement: 'nothing, while stories.port is this port; set it when the tool goes' })
        used = true
      }
      if (!used && !noProse.has(file) && wordRe.test(l)) hit(n, { kind: 'prose', uses: `the word ${cap}`, replacement: 'reword it or leave it' })
    }
    if (idScope(file)) {
      for (const m of idMentions(text, registry)) {
        const found = resolves(m.mention, m.prefix, ids)
        const label = `${m.prefix ? 'id prefix' : 'id'} ${m.mention}`
        if (found) hit(m.line, { kind: 'valid', uses: label, replacement: found === 'prefix' ? 'nothing: it matches ids of the lane' : 'nothing: the id is the lane\'s too, and /?story=<id> renders in place' })
        else if (oracle && !resolves(m.mention, m.prefix, oracle)) hit(m.line, { kind: 'dead', uses: label, replacement: "no story has it, in the tool or in the lane: fix or drop it" })
        else hit(m.line, { kind: 'open', uses: label, replacement: 'no story of the lane has it: repoint it (the redirect map names the new route)' })
      }
    }
    for (const [line, h] of hits) {
      if (h.skip?.length && !h.open.length && !h.prose.length && !h.valid.length) continue
      const open = h.open.length > 0
      const kind = open ? 'open' : h.dead.length ? 'dead' : h.valid.length ? 'valid' : 'prose'
      const reasons = open ? h.open : kind === 'dead' ? h.dead : kind === 'valid' ? h.valid : h.prose
      const uses = [...new Set(reasons.map((r) => r.uses))].join(', ')
      const replacement = [...new Set(reasons.map((r) => r.replacement))].join('; ')
      let cls = kind === 'prose' ? 'prose' : fileClass(file)
      if (kind !== 'prose' && cls !== 'docs') cls = commentLine(file, text, line) ? 'comment' : cls
      const status = isHistorical(file, historical) && kind !== 'prose' ? 'historical' : kind
      out.push({ file, line, class: cls, uses, replacement, status })
    }
    // A consumer the index found that no line above explains stays listed.
    const c = consumerAt.get(file)
    if (c && !out.some((e) => e.file === file && (e.status === 'open' || e.status === 'historical' || e.status === 'valid'))) {
      const cls = c.class === 'docs' ? 'docs' : fileClass(file)
      out.push({ file, line: c.line ?? 1, class: cls, uses: `${name} (${c.how ?? 'names it'})`, replacement: 'repoint it at the lane', status: isHistorical(file, historical) ? 'historical' : 'open' })
    }
  }
  return out.sort((a, b) => compare(a.file, b.file) || a.line - b.line)
}

// Whether line `n` (1-based) of `text` holds only a comment, so that whatever
// it mentions is a comment mention. The last file's blanked copy is kept, as
// the lines of one file are asked for in a row.
let blanked = { text: null, lines: [] }
function commentLine(file, text, n) {
  const raw = text.split('\n')[n - 1] ?? ''
  if (HASH_COMMENTS.test(file)) return raw.trimStart().startsWith('#')
  if (!CODE_COMMENTS.test(file)) return false
  if (blanked.text !== text) {
    let lines
    try {
      lines = stripComments(text, file).split('\n')
    } catch {
      lines = text.split('\n')
    }
    blanked = { text, lines }
  }
  return (blanked.lines[n - 1] ?? '').trim() === '' && raw.trim() !== ''
}

const CLASS_ORDER = ['code', 'test', 'ci', 'skill', 'docs', 'comment', 'prose']

// The open edits: the ones that hold a retirement up.
export const openEdits = (edits) => edits.filter((e) => e.status === 'open')

// The edits as Markdown, for adopt/stories/edits.md: the open ones by class,
// then what still works, the dead ones, the historical ones and the prose.
export function editsMarkdown(edits, { tool = 'the tool', command = null } = {}) {
  const by = (status) => edits.filter((e) => e.status === status)
  const line = (e) => `- \`${e.file}:${e.line}\` uses ${e.uses}. Change: ${e.replacement}.`
  const lines = [`# Edits before ${tool} can go`, '', 'Written by massimo. These are the repo\'s own to make: massimo prints them and never makes them.', '']
  const open = by('open')
  lines.push(`## Open (${open.length})`, '', 'Each holds the retirement up until it is made.', '')
  if (open.length === 0) lines.push('None.', '')
  for (const cls of CLASS_ORDER) {
    const group = open.filter((e) => e.class === cls)
    if (group.length === 0) continue
    lines.push(`### ${cls} (${group.length})`, '', ...group.map(line), '')
  }
  const rest = [
    ['valid', 'Still works on the lane', 'Nothing to do before the tool goes.'],
    ['dead', 'Dead before the move', 'The tool\'s own ids never had these either.'],
    ['historical', 'Historical, left as they are', 'In paths the ledger marks historical.'],
  ]
  for (const [status, title, note] of rest) {
    const group = by(status)
    if (group.length === 0) continue
    lines.push(`## ${title} (${group.length})`, '', note, '', ...group.map(line), '')
  }
  const prose = by('prose')
  if (prose.length > 0) lines.push(`## Prose (${prose.length})`, '', `The tool's name as a word. Reword when convenient; none of these block.`, '', ...prose.map((e) => `- \`${e.file}:${e.line}\``), '')
  if (command) lines.push(`Run \`${command}\` for what is still open.`, '')
  return `${lines.join('\n').trimEnd()}\n`
}

// One line on the open edits, for a report.
export const editsSummary = (edits) => {
  const open = openEdits(edits)
  return `${plural(open.length, 'open edit')}, ${plural(edits.filter((e) => e.status === 'valid').length, 'mention')} that still work${edits.some((e) => e.status === 'dead') ? `, ${plural(edits.filter((e) => e.status === 'dead').length, 'dead id')}` : ''}`
}

// Write adopt/stories/edits.md under the project folder; returns its path.
export function writeEditsFile(projectDir, edits, opts = {}) {
  const path = join(projectDir, 'adopt', 'stories', 'edits.md')
  writeFileAtomic(path, editsMarkdown(edits, opts))
  return path
}
