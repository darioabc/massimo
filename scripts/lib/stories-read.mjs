// A story lane read as text, never run: the manifest that lists its stories,
// and the labelled state blocks on each story page. A value that is not a
// literal (a call, a variable, a spread, a template with `${}`) is reported
// as not statically readable, never guessed.

import { parseArrayAt } from './jsobject.mjs'
import { stripComments } from './source.mjs'

// The fields a manifest entry may carry, beyond any of the lane's own:
//   slug         the route (`/stories/<slug>`) and the page's folder or name
//   title        `Root / Group / Name`, where Root and Group repeat the two fields below
//   description  one line on what the story shows
//   root, group  where the story sits: its component's tier and group
//   component    the file it covers, or a list of files
//   states       the page's state labels, in order
//   theme        a pinned theme, for a story that has no other
//   frame        true when the story also has a chrome-free frame page
//   reference    a design reference image, or a list of them
export const ENTRY_FIELDS = ['slug', 'title', 'description', 'root', 'group', 'component', 'states', 'theme', 'frame', 'reference']

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isSkipped = (v) => isObject(v) && ('expr' in v || 'spread' in v)
// Whether a value holds anything that is not a literal, at any depth.
const unreadableIn = (v) => isSkipped(v) || (Array.isArray(v) ? v.some(unreadableIn) : isObject(v) ? Boolean(v.__spreads) || Object.values(v).some(unreadableIn) : false)

const DECLARATION = /(?<![\w$.])(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*\[/g
const EXPORT_LIST = /(?<![\w$.])export\s*\{([^}]*)\}/g
const EXPORT_DEFAULT_NAME = /(?<![\w$.])export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m
const EXPORT_DEFAULT_ARRAY = /(?<![\w$.])export\s+default\s*\[/

// Every array literal the module exports, as { name, at } with `at` the
// offset of its `[`: `export const x = [`, a const exported by name, and
// `export default [`.
function exportedArrays(code) {
  const exported = new Set()
  for (const m of code.matchAll(EXPORT_LIST)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim()
      if (name) exported.add(name)
    }
  }
  const byDefault = EXPORT_DEFAULT_NAME.exec(code)
  if (byDefault) exported.add(byDefault[1])
  const out = []
  for (const m of code.matchAll(DECLARATION)) {
    if (m[1] || exported.has(m[2])) out.push({ name: m[2], at: m.index + m[0].length - 1 })
  }
  const anonymous = EXPORT_DEFAULT_ARRAY.exec(code)
  if (anonymous) out.push({ name: 'default', at: anonymous.index + anonymous[0].length - 1 })
  return out
}

// A manifest's entries, read from the exported array whose items carry a
// `slug` (one named `stories` first). Returns
//   { name, entries, unreadable }
// `entries` lines up with the array: each item's literal fields as written,
// or null for an item that is not an object literal. `unreadable` lists what
// was left out, as { entry, slug, field, detail }: `entry` is the item's
// index, `field` is null when the whole item is unreadable, and `...` when
// the item spreads another object in, so any field may come from there.
export function readManifest(text, file = 'manifest.ts') {
  const code = stripComments(text, file)
  const candidates = exportedArrays(code)
    .map((c) => ({ ...c, items: parseArrayAt(text, c.at) ?? [] }))
    .filter((c) => c.items.some((item) => isObject(item) && !isSkipped(item) && 'slug' in item))
    .sort((a, b) => (b.name === 'stories') - (a.name === 'stories'))
  const chosen = candidates[0]
  if (!chosen) return { name: null, entries: [], unreadable: [{ entry: null, slug: null, field: null, detail: `${file} exports no array of entries with a slug` }] }
  const entries = []
  const unreadable = []
  chosen.items.forEach((item, index) => {
    if (!isObject(item) || isSkipped(item)) {
      entries.push(null)
      unreadable.push({ entry: index, slug: null, field: null, detail: `entry ${index + 1} is not an object literal` })
      return
    }
    const slug = typeof item.slug === 'string' ? item.slug : null
    const entry = {}
    for (const [key, value] of Object.entries(item)) {
      if (unreadableIn(value)) unreadable.push({ entry: index, slug, field: key, detail: `${key} is not statically readable` })
      else entry[key] = value
    }
    if (item.__spreads) unreadable.push({ entry: index, slug, field: '...', detail: `spreads ${item.__spreads.join(', ')} into the entry` })
    entries.push(entry)
  })
  return { name: chosen.name, entries, unreadable }
}

// What an entry covers, as a list whether it names one file or several.
export const componentsOf = (entry) => (entry?.component === undefined ? [] : [].concat(entry.component).filter((c) => typeof c === 'string'))

// ── State blocks on a page ──────────────────────────────────────────────────

const blank = (s) => s.replace(/[^\n]/g, ' ')

// The template of a page with its frontmatter, HTML comments and JSX
// comments blanked, so offsets stay valid and nothing there reads as a tag.
function templateOf(text) {
  let out = text
  const fence = /^---[^\n]*\n/.exec(text)
  if (fence) {
    const close = text.indexOf('\n---', fence[0].length - 1)
    const end = close === -1 ? text.length : close + 4
    out = blank(text.slice(0, end)) + text.slice(end)
  }
  return out.replace(/<!--[\s\S]*?-->/g, blank).replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
}

function skipQuoted(src, i) {
  const quote = src[i]
  for (i++; i < src.length && src[i] !== quote; i++) if (src[i] === '\\') i++
  return i
}

function skipTemplate(src, i) {
  for (i++; i < src.length && src[i] !== '`'; i++) {
    if (src[i] === '\\') i++
    else if (src[i] === '$' && src[i + 1] === '{') {
      const close = closeBrace(src, i + 1)
      if (close === -1) return src.length
      i = close
    }
  }
  return i
}

// The `}` that closes the `{` at `open`, past strings and templates, or -1.
function closeBrace(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'") i = skipQuoted(src, i)
    else if (c === '`') i = skipTemplate(src, i)
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

// An attribute's `{...}` value: a string, a boolean or a number when it is
// one literal, else { expr } with its source.
function expressionValue(inner) {
  const s = inner.trim()
  const quoted = /^(["'])((?:\\.|(?!\1)[^\\\n])*)\1$/.exec(s)
  if (quoted) return quoted[2].replace(/\\(.)/g, '$1')
  const template = /^`((?:\\.|[^`\\$]|\$(?!\{))*)`$/.exec(s)
  if (template) return template[1].replace(/\\(.)/g, '$1')
  if (s === 'true' || s === 'false') return s === 'true'
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s)
  return { expr: s }
}

// The attributes of the tag whose name ends at `i`, up to its `>`, as an
// object; null when the tag never closes. A bare attribute is true, and a
// spread (`{...props}`) is kept under `...`.
function readAttributes(src, i) {
  const attrs = {}
  while (i < src.length) {
    while (/\s/.test(src[i] ?? '')) i++
    if (src[i] === '>' || (src[i] === '/' && src[i + 1] === '>')) return attrs
    if (src[i] === '{') {
      const close = closeBrace(src, i)
      if (close === -1) return null
      ;(attrs['...'] ??= []).push(src.slice(i + 1, close).trim())
      i = close + 1
      continue
    }
    const name = /^[^\s=/>{]+/.exec(src.slice(i, i + 200))?.[0]
    if (!name) return null
    i += name.length
    let j = i
    while (/\s/.test(src[j] ?? '')) j++
    if (src[j] !== '=') {
      attrs[name] = true
      continue
    }
    j++
    while (/\s/.test(src[j] ?? '')) j++
    if (src[j] === '"' || src[j] === "'") {
      const end = skipQuoted(src, j)
      attrs[name] = src.slice(j + 1, end)
      i = end + 1
    } else if (src[j] === '{') {
      const close = closeBrace(src, j)
      if (close === -1) return null
      attrs[name] = expressionValue(src.slice(j + 1, close))
      i = close + 1
    } else {
      const bare = /^[^\s>]+/.exec(src.slice(j))?.[0] ?? ''
      attrs[name] = bare
      i = j + bare.length
    }
  }
  return null
}

// Every state block on a story page, in order: its label (the `label` prop,
// or `name` as the plain recipe writes it), note, ground and flush. A value
// that is not a literal is { expr } with its source, so a check can tell a
// label it cannot read from one that is missing.
export function readStoryStates(text, { tag = 'StoryState' } = {}) {
  const template = templateOf(text)
  const out = []
  for (const m of template.matchAll(new RegExp(`<${tag}(?=[\\s/>])`, 'g'))) {
    const attrs = readAttributes(template, m.index + m[0].length)
    if (!attrs) continue
    const flush = attrs.flush === undefined ? false : attrs.flush === '' ? true : attrs.flush
    out.push({ label: attrs.label ?? attrs.name ?? null, note: attrs.note ?? null, ground: attrs.ground ?? null, flush })
  }
  return out
}

// ── Paths with a slug ───────────────────────────────────────────────────────

// A path pattern with `{slug}` filled in.
export const slugPath = (pattern, slug) => pattern.split('{slug}').join(slug)

// The files a `{slug}` pattern matches, as a Map of slug -> file, in file order.
export function slugFiles(pattern, files) {
  const re = new RegExp(`^${pattern.split('{slug}').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([^/]+)')}$`)
  const out = new Map()
  for (const f of files) {
    const m = re.exec(f)
    if (m && !out.has(m[1])) out.set(m[1], f)
  }
  return out
}
