// The proof before a cut-over: what massimo makes of a repo, set beside what
// the repo's own tools wrote. The repo's generated graph (or its index) and
// its token inventory are read as text, tolerantly: a part that is there but
// does not read is listed as not readable, and a part the file does not state
// is left out of the comparison, never guessed. Every difference carries a
// key, so the ledger can accept one by name with a reason. Nothing here
// writes; adopt.mjs verify prints what these return.

import { compare } from './glob.mjs'
import { canonicalSelector } from './sheets.mjs'
import { selectorMembers } from './source.mjs'
import { slugPath } from './stories-read.mjs'

// The classes verify can prove; docs has nothing generated to compare.
export const VERIFY_CLASSES = ['graph', 'stories', 'audit', 'tokens']

const clean = (s) => String(s).replace(/\s+/g, ' ').trim()
const unticked = (s) => clean(s).replace(/^`(.*)`$/, '$1')
// A stated "none": `none`, `no graph nodes`, `no importer outside ...`.
const NONE = /^(?:none|no\b)/i
const sorted = (list) => [...new Set(list)].sort(compare)
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// Differences in a list keyed once each: a second one under a key joins the
// first one's detail. `shown` is the text printed for one when it says more
// than the detail an accept keeps, such as the line it was found on, which
// moves when a line is added above it while the difference stays the same.
function keyed() {
  const out = new Map()
  const add = (key, detail, shown = detail) => {
    const was = out.get(key)
    out.set(key, was ? { key, detail: `${was.detail}; ${detail}`, shown: `${was.shown}; ${shown}` } : { key, detail, shown })
  }
  const list = () => [...out.values()].sort((a, b) => compare(a.key, b.key)).map((d) => (d.shown === d.detail ? { key: d.key, detail: d.detail } : d))
  return { add, list }
}

// ── The repo's own graph ────────────────────────────────────────────────────

// A list as a graph line writes it: names split at commas, each without its
// backticks or a trailing note such as `(dynamic)`; a stated none is empty.
function names(text) {
  const t = clean(text)
  if (!t || NONE.test(t)) return []
  return t.split(/\s*,\s*/).map((n) => unticked(n.replace(/\s+\([^()]*\)$/, ''))).filter(Boolean)
}

// The file on a group line: the part after `·` that is a path, written
// `file \`src/x.astro\``, in backticks, or bare. In backticks a path is any
// text without a backtick, so route files such as `src/routes/+page.svelte`,
// `src/app/(shop)/cart/page.tsx` or `app/routes/posts.$slug.tsx` read; bare,
// it is one word. Either way it has a slash or a dot.
const PATH_PART = /^(?:file:?\s+)?(?:`([^`]*[/.][^`]*)`|([^\s`]*[/.][^\s`]*))$/
const pathIn = (text) => {
  const m = PATH_PART.exec(clean(text))
  return m ? (m[1] ?? m[2]).trim() : null
}

// The repo's own graph, from its Markdown: each `### <id>` heading, its file
// and group (`- group <Tier> / <Group> · file \`<path>\``, a trailing note
// such as `(from its path)` dropped), what it composes (`- composes: a, b`),
// who composes it (`- composed by:` then one `  - x` per line, or a list on
// the line) and its stories (`- stories: \`<route>\` (direct), ...` with
// each marked direct or incidental, or `none`). A part not stated stays null.
export function readGraphDoc(text) {
  const nodes = []
  const unreadable = []
  let node = null
  let list = null
  // A `###` heading of more than one word is a section, unless a group line
  // with a file follows it: then it is a node whose id cannot be read.
  const sections = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1
    if (/^#{1,6}[ \t]/.test(raw)) {
      list = null
      const heading = /^###[ \t]+(.+?)[ \t]*$/.exec(raw)
      node = heading ? { id: unticked(heading[1]), line, file: null, group: null, composes: null, composedBy: null, direct: null, incidental: null } : null
      if (node) (/\s/.test(node.id) ? sections : nodes).push(node)
      return
    }
    if (!node) return
    const item = /^[ \t]+[-*][ \t]+(.+?)[ \t]*$/.exec(raw)
    if (item && list) {
      node[list].push(...names(item[1]))
      return
    }
    list = null
    const body = /^[-*][ \t]+(.+?)[ \t]*$/.exec(raw)?.[1]
    if (!body) return
    const field = /^(group|file|composes|composed by|stories)\b:?\s*(.*)$/.exec(body)
    if (!field) return
    const [, name, rest] = field
    if (name === 'group') {
      const parts = rest.split(/\s+·\s+/)
      const group = clean(parts[0].replace(/\s*\([^()]*\)$/, ''))
      node.group = NONE.test(group) ? '' : group
      const file = parts.slice(1).map(pathIn).find(Boolean)
      if (file) node.file = file
    } else if (name === 'file') {
      const file = pathIn(rest)
      if (file) node.file = file
      else unreadable.push({ where: node.id, line, detail: `its file line, "${clean(rest)}", names no path` })
    } else if (name === 'composes') {
      node.composes = names(rest)
    } else if (name === 'composed by') {
      node.composedBy = names(rest)
      if (!clean(rest)) list = 'composedBy'
    } else {
      readStories(node, rest, line, unreadable)
    }
  })
  for (const n of nodes) if (!n.file) unreadable.push({ where: n.id, line: n.line, detail: 'no file on its group line, so it cannot be matched to a node' })
  for (const s of sections.filter((x) => x.file)) unreadable.push({ where: s.file, line: s.line, detail: `its heading, "${s.id}", is not one id, so the node is not compared` })
  return { kind: 'graph', nodes, unreadable: dedupeNodes(nodes, unreadable) }
}

// A stories line: each story marked direct or incidental. One without a mark
// leaves the node's coverage unstated, and is listed.
function readStories(node, rest, line, unreadable) {
  const items = clean(rest)
  if (!items || NONE.test(items)) {
    node.direct = []
    node.incidental = []
    return
  }
  const direct = []
  const incidental = []
  for (const item of items.split(/\s*,\s*/)) {
    const m = /^(.*?)\s+\((direct|incidental)\)$/.exec(item)
    if (!m) {
      unreadable.push({ where: node.id, line, detail: `the story "${item}" is marked neither direct nor incidental` })
      return
    }
    ;(m[2] === 'direct' ? direct : incidental).push(unticked(m[1]))
  }
  node.direct = direct
  node.incidental = incidental
}

// A heading twice, or two headings on one file, cannot be matched: both are
// listed, and the second is left out.
function dedupeNodes(nodes, unreadable) {
  const ids = new Set()
  const files = new Set()
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const twice = ids.has(n.id) ? `the heading ${n.id} appears twice` : n.file && files.has(n.file) ? `${n.file} has a second heading, ${n.id}` : null
    ids.add(n.id)
    if (n.file) files.add(n.file)
    if (!twice) continue
    unreadable.push({ where: n.id, line: n.line, detail: twice })
    nodes.splice(i--, 1)
  }
  return unreadable.sort((a, b) => a.line - b.line)
}

// The repo's own index, when it has no graph page: `## <Tier>`, then
// `### <Group>`, then a line per node, `- \`<id>\` · ...`, whose parts may
// say `story <routes>` (direct) or `seen in <routes>` (incidental only).
// It names no files: compareGraph matches each id to a node by its path.
export function readIndexDoc(text) {
  const nodes = []
  let tier = null
  let group = null
  text.split(/\r?\n/).forEach((raw, i) => {
    const h = /^(#{2,3})[ \t]+(.+?)[ \t]*$/.exec(raw)
    if (h) {
      if (h[1] === '##') [tier, group] = [clean(h[2]), null]
      else group = clean(h[2])
      return
    }
    const m = /^[-*][ \t]+`([^`]+)`(.*)$/.exec(raw)
    if (!m || !tier || !group) return
    const parts = m[2].split(/\s+·\s+/).map(clean)
    const listed = (word) => parts.filter((p) => p.startsWith(`${word} `)).flatMap((p) => names(p.slice(word.length + 1)))
    nodes.push({ id: m[1], line: i + 1, file: null, group: `${tier} / ${group}`, composes: null, composedBy: null, direct: listed('story'), incidental: listed('seen in'), categoryOnly: true })
  })
  return { kind: 'index', nodes, unreadable: dedupeNodes(nodes, []) }
}

// The repo's own graph as readGraphDoc reads it, or its index when no
// heading names a file (an index's `### Group` headings name none).
export function readRepoGraph(text) {
  const graph = readGraphDoc(text)
  if (graph.nodes.some((n) => n.file)) return graph
  const index = readIndexDoc(text)
  return index.nodes.length > 0 ? index : graph
}

// ── Story routes ────────────────────────────────────────────────────────────

// Where a story is served, as a path with `{slug}`: from stories.storyUrl,
// else stories.url and the slug, else /stories/{slug}; on a csf lane the
// route ends in `/{state}`, since it serves one state per document. A frame's path adds
// what its file adds to the page's (`{slug}/frame.astro` beside
// `{slug}/index.astro` is `/frame`); null when that cannot be told.
export function storyRoutes(config) {
  const s = config.stories ?? {}
  // A csf lane serves one state per document, so its route ends in `{state}`.
  const perState = s.lane === 'csf'
  const tailOf = (u) => `${String(u).replace(/\/$/, '')}/{slug}${perState ? '/{state}' : ''}`
  const url = s.storyUrl ?? (s.url ? tailOf(s.url) : null)
  const story = url ? url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '') || '/{slug}' : perState ? '/stories/{slug}/{state}' : '/stories/{slug}'
  const tail = (pattern) => (typeof pattern === 'string' && pattern.includes('{slug}') ? pattern.slice(pattern.lastIndexOf('{slug}') + 6).replace(/\.[^./]+$/, '').replace(/(?:^|\/)index$/, '') : null)
  const page = tail(s.pages)
  const frame = tail(s.frames)
  return { story, frame: frame !== null && (page === null || page === '') && story.includes('{slug}') ? `${story}${frame}` : null }
}

// A route with its placeholders filled: `{slug}`, `{state}`, `{id}` and
// `{scheme}`, each encoded as a URL part.
const fillRoute = (route, values) => route.replace(/\{(slug|state|id|scheme)\}/g, (_, key) => encodeURIComponent(values[key] ?? ''))

// The slug a route names, by the story route's pattern, or the route as it
// is when the pattern does not fit (so a difference shows, rather than a
// guess). A `{state}` in the pattern is any one path part.
function slugReader(route) {
  const [before, after = ''] = route.split('{slug}')
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${esc(before)}(.+?)${esc(after).replace('\\{state\\}', '[^/]+')}/?$`)
  return (r) => re.exec(r)?.[1] ?? r
}

// ── The graph compared ──────────────────────────────────────────────────────

const coverageOf = (direct, incidental) => (direct.length > 0 ? 'direct' : incidental.length > 0 ? 'incidental' : 'none')

// massimo's graph (graph.json as buildGraph makes it) against the repo's
// own, node by node by file: the node set, each node's group, what it
// composes, who composes it, and its story coverage (direct, incidental
// only or none, and with a story manifest the stories themselves). Returns
// the rows of the table, the differences by key and notes.
export function compareGraph(repo, json, { route = '/stories/{slug}' } = {}) {
  const diffs = keyed()
  const notes = []
  const ours = new Map(json.nodes.map((n) => [n.file, n]))
  const fileOfName = new Map(json.nodes.map((n) => [n.name, n.file]))
  // The line is printed, never kept: a line added above would reopen an accept.
  for (const u of repo.unreadable) diffs.add(`unreadable:${u.where}`, u.detail, `line ${u.line}: ${u.detail}`)
  // An index names ids only: one matches the node whose path ends with it.
  const nodes = repo.nodes.map((n) => {
    if (n.file) return n
    const hits = json.nodes.filter((x) => {
      const bare = x.file.replace(/\.[^./]+$/, '')
      return x.name === n.id || bare === n.id || bare.endsWith(`/${n.id}`)
    })
    if (hits.length === 1) return { ...n, file: hits[0].file }
    const detail = `${hits.length === 0 ? 'no node of massimo\'s has this id or a path ending in it' : `the id fits ${hits.length} nodes (${hits.map((h) => h.file).join(', ')})`}, so it is not compared`
    diffs.add(`unreadable:${n.id}`, detail, `line ${n.line}: ${detail}`)
    return n
  }).filter((n) => n.file)
  const theirs = new Map(nodes.map((n) => [n.file, n]))
  const idOf = new Map(nodes.map((n) => [n.file, n.id]))
  const fileOfId = new Map(nodes.map((n) => [n.id, n.file]))
  const label = (file) => idOf.get(file) ?? ours.get(file)?.name ?? file
  const slug = slugReader(route)
  const lane = Boolean(json.storyLane)

  const both = [...theirs.keys()].filter((f) => ours.has(f)).sort(compare)
  for (const f of [...theirs.keys()].filter((x) => !ours.has(x))) diffs.add(`node:${f}`, `${theirs.get(f).id} is in the repo's graph, not massimo's`)
  for (const f of [...ours.keys()].filter((x) => !theirs.has(x))) diffs.add(`node:${f}`, `${ours.get(f).name} is in massimo's graph, not the repo's`)

  // Per aspect: [same, differ, not stated].
  const tally = { group: [0, 0, 0], composes: [0, 0, 0], 'composed by': [0, 0, 0], coverage: [0, 0, 0] }
  const count = (aspect, stated, agrees) => {
    tally[aspect][stated ? (agrees ? 0 : 1) : 2]++
  }
  const twoSides = (theirsList, oursList) => {
    const only = (a, b) => a.filter((x) => !b.includes(x))
    const parts = []
    if (only(theirsList, oursList).length) parts.push(`only the repo's: ${only(theirsList, oursList).join(', ')}`)
    if (only(oursList, theirsList).length) parts.push(`only massimo's: ${only(oursList, theirsList).join(', ')}`)
    return parts.join('; ')
  }
  for (const f of both) {
    const t = theirs.get(f)
    const o = ours.get(f)
    // Group: a stated none is no group.
    if (t.group !== null) {
      const agrees = (t.group || null) === (o.group ?? null)
      count('group', true, agrees)
      if (!agrees) diffs.add(`group:${f}`, `the repo files it in ${t.group || 'no group'}, massimo in ${o.group ?? 'no group'}`)
    } else count('group', false)
    // Composes: the repo's ids and massimo's names, both as files.
    if (t.composes !== null) {
      const a = sorted(t.composes.map((id) => fileOfId.get(id) ?? `?${id}`))
      const b = sorted(o.composes.map((n) => fileOfName.get(n) ?? `?${n}`))
      count('composes', true, same(a, b))
      if (!same(a, b)) diffs.add(`composes:${f}`, twoSides(a.map(label), b.map(label)))
    } else count('composes', false)
    // Composed by: a node by its id, anything else by the repo's own label
    // when the importer sits under it (`content/posts`), else by its path.
    if (t.composedBy !== null) {
      const folders = t.composedBy.filter((l) => !fileOfId.has(l))
      const under = (file) => folders.find((l) => file === l || file.startsWith(`${l}/`) || file.includes(`/${l}/`))
      const a = sorted(t.composedBy)
      const b = sorted(Object.values(o.composedBy ?? {}).flat().map((file) => idOf.get(file) ?? (ours.has(file) ? ours.get(file).name : under(file) ?? file)))
      count('composed by', true, same(a, b))
      if (!same(a, b)) diffs.add(`composed-by:${f}`, twoSides(a, b))
    } else count('composed by', false)
    // Coverage: the stories themselves with a manifest on both sides, else
    // whether the node has a direct story, an incidental one or none.
    if (t.direct !== null) {
      const td = sorted(t.direct.map(slug))
      const ti = sorted(t.incidental.map(slug)).filter((s) => !td.includes(s))
      const od = lane ? sorted(o.direct) : o.stories.length > 0 ? ['(a story file)'] : []
      const oi = lane ? sorted(o.incidental) : []
      const whole = !t.categoryOnly && lane
      const agrees = whole ? same(td, od) && same(ti, oi) : coverageOf(td, ti) === coverageOf(od, oi)
      count('coverage', true, agrees)
      if (!agrees) {
        const parts = whole
          ? [twoSides(td, od) && `direct: ${twoSides(td, od)}`, twoSides(ti, oi) && `incidental: ${twoSides(ti, oi)}`].filter(Boolean)
          : [`the repo has ${coverageOf(td, ti)}, massimo ${coverageOf(od, oi)}`]
        diffs.add(`coverage:${f}`, parts.join('; '))
      }
    } else count('coverage', false)
  }

  const stated = repo.nodes.filter((n) => n.direct !== null)
  const split = (list, cov) => ['direct', 'incidental', 'none'].map((c) => String(list.filter((n) => cov(n) === c).length))
  const theirSplit = split(stated, (n) => coverageOf(n.direct, n.incidental.filter((s) => !n.direct.includes(s))))
  const ourSplit = lane ? [json.storyLane.direct, json.storyLane.incidental, json.storyLane.none].map(String) : split(json.nodes, (n) => (n.stories.length > 0 ? 'direct' : 'none'))
  // A row per aspect: the nodes in both graphs whose aspect the repo states.
  const aspectRow = (what, aspect, note = '') => {
    const [agree, differ, unstated] = tally[aspect]
    const notes = [unstated > 0 ? `${unstated} not stated by the repo` : '', note].filter(Boolean).join('; ')
    return [what, String(agree + differ), String(agree + differ), String(agree), String(differ), notes]
  }
  const coverageNote = repo.kind === 'index' ? 'the index lists coverage, not every story' : lane ? '' : 'massimo finds stories by file name, so only whether a node has one is compared'
  const rows = [
    ['What', 'Repo', 'massimo', 'Same', 'Differ', 'Note'],
    ['nodes', String(theirs.size), String(ours.size), String(both.length), String(theirs.size + ours.size - 2 * both.length), ''],
    aspectRow('group', 'group'),
    aspectRow('composes', 'composes'),
    aspectRow('composed by', 'composed by'),
    aspectRow('story coverage', 'coverage', coverageNote),
    ['  direct', theirSplit[0], ourSplit[0], '', '', ''],
    ['  incidental only', theirSplit[1], ourSplit[1], '', '', ''],
    ['  none', theirSplit[2], ourSplit[2], '', '', ''],
    ['not readable', String(repo.unreadable.length), '', '', String(repo.unreadable.length), ''],
  ]
  if (repo.kind === 'index') notes.push('Read from the index: it names no files, what each node composes or who composes it, so those are not compared.')
  return { rows, differences: diffs.list(), notes }
}

// ── The repo's own token inventory ──────────────────────────────────────────

// A selector and its value: [{ selector, value, resolved }], or an object of
// selector to value (or to { value, resolved }).
function valueList(values) {
  if (Array.isArray(values)) return values
  if (values && typeof values === 'object') return Object.entries(values).map(([selector, v]) => (v && typeof v === 'object' ? { selector, ...v } : { selector, value: v }))
  return null
}

// The tokens of the repo's own inventory: its `tokens` list, or the document
// when it is a list, each with a name, a file and values by selector, and a
// layer and family when it has them. The type classes, faces and breakpoints
// beside them come too. A token missing a part is listed, never guessed: by
// its name, else its file, and its place in the list (`at`) only for printing,
// since a token added above it moves that.
export function readTokenInventory(doc) {
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.tokens) ? doc.tokens : null
  if (!list) return { tokens: [], unreadable: [{ where: 'the file', detail: 'it holds no list of tokens: neither the document nor its "tokens" field is an array' }], extras: {} }
  const tokens = []
  const unreadable = []
  list.forEach((t, i) => {
    const named = typeof t?.name === 'string'
    const where = named ? t.name : typeof t?.file === 'string' ? `${t.file} (no name)` : '(no name or file)'
    const values = valueList(t?.values)
    const missing = [!named && 'name', typeof t?.file !== 'string' && 'file', !values && 'values by selector'].filter(Boolean)
    if (missing.length > 0) return unreadable.push({ where, detail: `it has no ${missing.join(' or ')}`, ...(named ? {} : { at: `token ${i + 1}` }) })
    const bad = values.filter((v) => typeof v?.selector !== 'string' || (typeof v.value !== 'string' && typeof v.value !== 'number'))
    if (bad.length > 0) return unreadable.push({ where: `${t.file} ${t.name}`, detail: `${plural(bad.length, 'value has', 'values have')} no selector or value` })
    tokens.push({
      name: t.name,
      file: t.file,
      ...(typeof t.layer === 'string' ? { layer: t.layer } : {}),
      ...(typeof t.family === 'string' ? { family: t.family } : {}),
      values: values.map((v) => ({ selector: v.selector, value: clean(v.value), ...(v.resolved !== undefined && v.resolved !== null ? { resolved: clean(v.resolved) } : {}) })),
    })
  })
  const extras = {}
  for (const key of ['typeClasses', 'faces', 'breakpoints']) if (doc && !Array.isArray(doc) && doc[key] !== undefined) extras[key] = doc[key]
  return { tokens, unreadable, extras }
}

// The members a selector list stands for in massimo's values, which files
// each member on its own: `.a, .b` is `.a` and `.b`, and a list under an
// at-rule (`@media (x) .a, .b`) is each member under it, the longest
// at-rule text that fits first. Null unless every member is there.
function listMembers(selector, have) {
  const parts = selectorMembers(selector).map(clean)
  if (parts.length < 2) return null
  const words = parts[0].split(' ')
  const prefixes = parts[0].startsWith('@') ? words.slice(1).map((_, i) => words.slice(0, words.length - 1 - i).join(' ')) : ['']
  for (const prefix of prefixes) {
    const keys = [parts[0], ...parts.slice(1).map((p) => (prefix ? `${prefix} ${p}` : p))].map(canonicalSelector)
    if (keys.every((k) => have.has(k))) return keys
  }
  return null
}

const json = (v) => JSON.stringify(v)

// tokens/resolved.json against the repo's own inventory, token by token (its
// file and name) and value by value (its selector): the value, and the
// resolved colour where the repo's file resolves one. A selector list the
// repo files as one is the same as its members filed one by one. The layer
// and family are compared where the repo's tokens carry them, and the type
// classes, faces and breakpoints where its file has them.
export function compareTokens(repo, resolved) {
  const diffs = keyed()
  for (const u of repo.unreadable) diffs.add(`unreadable:${u.where}`, u.detail, u.at ? `${u.at}: ${u.detail}` : u.detail)
  const key = (t) => `${t.file} ${t.name}`
  const ours = new Map((resolved.tokens ?? []).map((t) => [key(t), t]))
  const theirs = new Map(repo.tokens.map((t) => [key(t), t]))
  const tally = { values: [0, 0, 0], resolved: [0, 0, 0], layer: [0, 0, 0], family: [0, 0, 0] }
  let folded = 0
  // Values massimo resolves and the repo's file leaves unresolved, by file:
  // a reader of resolved.json sees a colour there it did not before.
  const more = new Map()
  for (const [k, t] of theirs) {
    const o = ours.get(k)
    if (!o) {
      diffs.add(`token:${k}`, 'in the repo\'s inventory, not in resolved.json')
      continue
    }
    for (const field of ['layer', 'family']) {
      if (t[field] === undefined) continue
      tally[field][t[field] === o[field] ? 0 : 1]++
      if (t[field] !== o[field]) diffs.add(`${field}:${k}`, `the repo's is ${t[field]}, massimo's ${o[field] ?? 'none'}`)
    }
    const have = new Map(o.values.map((v) => [canonicalSelector(v.selector), v]))
    const used = new Set()
    for (const v of t.values) {
      const own = canonicalSelector(v.selector)
      const members = have.has(own) ? [own] : listMembers(v.selector, have)
      if (!members) {
        tally.values[1]++
        diffs.add(`selector:${k} @ ${v.selector}`, `only in the repo's inventory (${v.value})`)
        continue
      }
      if (members.length > 1) folded++
      let agrees = true
      for (const m of members) {
        used.add(m)
        const ov = have.get(m)
        if (clean(ov.value) !== v.value) {
          agrees = false
          diffs.add(`value:${k} @ ${m}`, `the repo's is ${v.value}, massimo's ${clean(ov.value)}`)
        }
        if (v.resolved !== undefined) {
          const ok = ov.resolved !== undefined && clean(ov.resolved) === v.resolved
          tally.resolved[ok ? 0 : 1]++
          if (!ok) diffs.add(`resolved:${k} @ ${m}`, `the repo resolves it to ${v.resolved}, massimo ${ov.resolved === undefined ? 'does not resolve it' : `to ${clean(ov.resolved)}`}`)
        } else if (ov.resolved !== undefined) more.set(t.file, [...(more.get(t.file) ?? []), `${t.name} @ ${m}`])
      }
      tally.values[agrees ? 0 : 1]++
    }
    for (const [sel, ov] of have) if (!used.has(sel)) diffs.add(`selector:${k} @ ${sel}`, `only in resolved.json (${clean(ov.value)})`)
  }
  for (const k of ours.keys()) if (!theirs.has(k)) diffs.add(`token:${k}`, 'in resolved.json, not in the repo\'s inventory')
  for (const [file, list] of more) diffs.add(`resolved-more:${file}`, `massimo resolves ${plural(list.length, 'value')} the repo's inventory leaves unresolved, such as ${list.slice(0, 2).join(' and ')}`)
  const extra = [...more.values()].reduce((n, l) => n + l.length, 0)
  const both = [...theirs.keys()].filter((k) => ours.has(k)).length
  const tallyRow = (what, t, note = '') => [what, String(t[0] + t[1]), String(t[0] + t[1]), String(t[0]), String(t[1]), note]
  const rows = [
    ['What', 'Repo', 'massimo', 'Same', 'Differ', 'Note'],
    ['tokens', String(theirs.size), String(ours.size), String(both), String(theirs.size + ours.size - 2 * both), ''],
    tallyRow('values by selector', tally.values, folded > 0 ? `${plural(folded, 'selector list')} the repo files as one, massimo by member` : ''),
    tallyRow('resolved colours', tally.resolved, extra > 0 ? `massimo resolves ${extra} more, in ${plural(more.size, 'file')}` : ''),
  ]
  for (const field of ['layer', 'family']) if (tally[field][0] + tally[field][1] > 0) rows.push(tallyRow(field, tally[field]))
  for (const field of ['typeClasses', 'faces', 'breakpoints']) {
    if (repo.extras[field] === undefined) continue
    const agrees = json(repo.extras[field]) === json(resolved[field])
    rows.push([{ typeClasses: 'type classes', faces: 'faces', breakpoints: 'breakpoints' }[field], '', '', agrees ? 'yes' : '', agrees ? '' : 'yes', ''])
    if (!agrees) diffs.add(field, `the repo's file and resolved.json list different ${field === 'typeClasses' ? 'type classes' : field}`)
  }
  rows.push(['not readable', String(repo.unreadable.length), '', '', String(repo.unreadable.length), ''])
  return { rows, differences: diffs.list(), notes: [] }
}

// ── Story pairs ─────────────────────────────────────────────────────────────

// The widths a story is shot at: a phone and a desktop.
export const PAIR_SIZES = [{ width: 390, height: 844 }, { width: 1440, height: 900 }]
export const PAIRS_FORMAT = 1

// A pairs file for `shoot.mjs --pairs` from the manifest's entries: each at
// light and dark and at each of PAIR_SIZES, on its frame route when it has a
// frame (the lane's chrome stays out), with `a` and `b` the two servers'
// base URLs. An entry whose root is `domTier` is compared by its page text
// (mode dom), since whole pages carry motion no freeze holds still. Entries
// without a literal slug are skipped and counted.
//
// For a csf lane, `entries` are the registry's states and each side has its
// own route template (`aRoute`, `bRoute`, with `{id}`, `{slug}`, `{state}`
// and `{scheme}`): a pair per state, scheme and size, named
// `<slug>/<state>/<scheme>-<width>`, on a page of the first title part's
// tier `domTier` compared by text. A `selector` limits the shot to it.
export function storyPairs(entries, { a, b, routes, domTier = 'Pages', aRoute, bRoute, selector }) {
  const base = (url) => String(url).replace(/\/+$/, '')
  const pairs = []
  if (aRoute || bRoute) {
    const first = routes?.story ?? '/stories/{slug}/{state}'
    const sides = { a: aRoute ?? first, b: bRoute ?? first }
    let counted = 0
    let left = 0
    for (const state of entries) {
      if (!state || typeof state.slug !== 'string' || typeof state.state !== 'string') {
        left++
        continue
      }
      counted++
      const mode = state.levels?.[0] === domTier ? 'dom' : 'pixel'
      for (const scheme of ['light', 'dark']) {
        for (const { width, height } of PAIR_SIZES) {
          const at = (route) => fillRoute(route, { id: state.id, slug: state.slug, state: state.state, scheme })
          pairs.push({
            name: `${state.slug}/${state.state}/${scheme}-${width}`,
            a: `${base(a)}${at(sides.a)}`,
            b: `${base(b)}${at(sides.b)}`,
            width,
            height,
            scheme,
            mode,
            ...(mode === 'pixel' && !selector ? { full: true } : {}),
            ...(selector ? { selector } : {}),
          })
        }
      }
    }
    return { document: { format: PAIRS_FORMAT, pairs }, entries: counted, skipped: left }
  }
  let skipped = 0
  let shot = 0
  for (const entry of entries) {
    if (!entry || typeof entry.slug !== 'string') {
      skipped++
      continue
    }
    shot++
    const path = slugPath(entry.frame === true && routes.frame ? routes.frame : routes.story, entry.slug)
    const mode = entry.root === domTier ? 'dom' : 'pixel'
    for (const scheme of ['light', 'dark']) {
      for (const { width, height } of PAIR_SIZES) {
        pairs.push({ name: `${entry.slug}/${scheme}-${width}`, a: `${base(a)}${path}`, b: `${base(b)}${path}`, width, height, scheme, mode, ...(mode === 'pixel' ? { full: true } : {}) })
      }
    }
  }
  return { document: { format: PAIRS_FORMAT, pairs }, entries: shot, skipped }
}

// ── The csf lane against the tool's own ids ────────────────────────────────

// JSON with object keys in order, so two metas that differ only in key order
// are the same.
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => compare(p, q))) : x))

// The lane's registry against the stories of the tool's own meta.json
// (`oracle`, keyed by id): the same ids, and for each the same file, export
// and merged meta. Every difference is keyed `id:<id>`; the detail says which
// of the three differ, or that only one side has the id (and, when the other
// side gives the same export another id, which). Returns the table rows and
// the differences.
export function compareLane(oracle, registry) {
  const diffs = keyed()
  const ours = registry.stories
  const byExport = new Map(Object.values(ours).map((s) => [`${s.file}\n${s.export}`, s.id]))
  const theirByExport = new Map(Object.entries(oracle).map(([id, s]) => [`${s.filePath}\n${s.namedExport}`, id]))
  let same = 0
  let only = 0
  let other = 0
  let changed = 0
  for (const [id, s] of Object.entries(oracle)) {
    const mine = ours[id]
    if (!mine) {
      only++
      const moved = byExport.get(`${s.filePath}\n${s.namedExport}`)
      diffs.add(`id:${id}`, moved ? `the tool has it, and the lane gives ${s.filePath} ${s.namedExport} the id ${moved}` : `the tool has it (${s.filePath} ${s.namedExport}), the lane does not`)
      continue
    }
    const wrong = []
    if (mine.file !== s.filePath) wrong.push(`file ${s.filePath} against ${mine.file}`)
    if (mine.export !== s.namedExport) wrong.push(`export ${s.namedExport} against ${mine.export}`)
    if (canon(mine.meta ?? {}) !== canon(s.meta ?? {})) wrong.push('meta differs')
    if (wrong.length > 0) {
      changed++
      diffs.add(`id:${id}`, wrong.join('; '))
    } else same++
  }
  for (const id of Object.keys(ours)) {
    if (oracle[id]) continue
    other++
    const old = theirByExport.get(`${ours[id].file}\n${ours[id].export}`)
    diffs.add(`id:${id}`, old ? `the lane has it, and the tool gives ${ours[id].file} ${ours[id].export} the id ${old}` : `the lane has it (${ours[id].file} ${ours[id].export}), the tool does not`)
  }
  const rows = [
    ['What', 'Tool', 'Lane', 'Differ', 'Note'],
    ['states', String(Object.keys(oracle).length), String(Object.keys(ours).length), String(only + other), only + other ? `${only} only in the tool, ${other} only in the lane` : ''],
    ['file, export and meta', '', String(same + changed), String(changed), changed ? 'on ids both have' : ''],
  ]
  return { rows, differences: diffs.list(), same }
}

// What a pair that failed shows, as a difference: printed, its error or
// reasons as shoot.mjs gives them; kept by an accept, only what differs (its
// pixels or page text over the limit, its sizes, or that it could not be
// shot), never the measured percentage, so an accept holds while the pair
// still differs the same way.
export function shotDifference(result) {
  const shown = result.error ?? (result.reasons ?? []).join('; ')
  if (result.error !== undefined) return { key: `shot:${result.name}`, detail: 'it could not be shot', shown }
  const nature = (r) => (/^sizes differ\b/.test(r) ? 'its sizes differ' : /% changed, over /.test(r) ? `its ${result.mode === 'dom' ? 'page text differs' : 'pixels differ'} over the limit` : r)
  return { key: `shot:${result.name}`, detail: (result.reasons ?? []).map(nature).join('; '), shown }
}

// ── Settling against the ledger ─────────────────────────────────────────────

// The differences split by what the ledger accepts: open (to fix or accept),
// accepted (with the reason), and stale (accepted keys no longer found). A
// key holds only while its detail is the one accepted: a key whose detail
// changed since (another group, a higher count, more values) is open again,
// and so is one accepted without its detail, since what changed cannot be told.
// The detail is compared, never the printed text (`shown`), which may say more.
export function settle(differences, accepted = []) {
  const byKey = new Map(accepted.map((a) => [a.key, a]))
  const found = new Set(differences.map((d) => d.key))
  const open = []
  const held = []
  const reopened = (d, note) => ({ ...d, detail: `${d.detail}; ${note}`, ...(d.shown === undefined ? {} : { shown: `${d.shown}; ${note}` }), changed: true })
  for (const d of differences) {
    const a = byKey.get(d.key)
    if (!a) open.push(d)
    else if (typeof a.detail !== 'string') open.push(reopened(d, `accepted on ${a.date ?? 'an earlier day'} without the detail it had then, so a change cannot be told: accept it again if it still holds`))
    else if (a.detail !== d.detail) open.push(reopened(d, `changed since accepted on ${a.date ?? 'an earlier day'}: was ${a.detail}`))
    else held.push({ ...d, why: a.why })
  }
  return { open, accepted: held, stale: accepted.filter((a) => !found.has(a.key)).map((a) => a.key) }
}

// Rows as aligned text: numbers to the right, the rest to the left, and the
// head row as it is.
export function textTable(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? '').length)))
  const numeric = (s) => /^-?\d+$/.test(s)
  return rows
    .map((r, n) => r.map((cell, i) => (n > 0 && numeric(String(cell)) ? String(cell).padStart(widths[i]) : String(cell ?? '').padEnd(widths[i]))).join('  ').trimEnd())
    .join('\n')
}
