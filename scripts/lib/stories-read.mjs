// A story lane read as text, never run: the manifest that lists its stories,
// and the labelled state blocks on each story page. A value that is not a
// literal (a call, a variable, a spread, a template with `${}`), or a list
// built from more than its literal, is reported as not statically readable,
// never guessed.

import { parseArrayAt, parseObjectAt } from './jsobject.mjs'
import { stringLiterals, stripComments } from './source.mjs'

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
// What carries an expression on past a line break: `.concat(`, `[0]`, `+ x`...
const CONTINUES = /^(?:[.[(`+\-*/%?&|^<>=!]|in\b|instanceof\b)/
// A method that adds entries to an array or takes them out after it is declared.
const MUTATORS = ['push', 'unshift', 'splice']

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

// The end of a type after `as` or `satisfies` at `i`: the first `;`, `,`,
// line break or closing bracket outside the type's own brackets.
function skipType(code, i) {
  let depth = 0
  for (; i < code.length; i++) {
    const c = code[i]
    if (c === '"' || c === "'" || c === '`') i = skipQuoted(code, i)
    else if (c === '=' && code[i + 1] === '>') i++
    else if ('<([{'.includes(c)) depth++
    else if ('>)]}'.includes(c)) {
      if (depth === 0) return i
      depth--
    } else if (depth === 0 && (c === ';' || c === ',' || c === '\n')) return i
  }
  return i
}

// Whether the array literal that closes just before `i` is the whole value
// of its declaration: what follows is the end of the statement (`;`, `,`
// before another declarator, `}`, the end of the file, or a line break before
// anything that does not carry the expression on), after any `as` or
// `satisfies` type. `.concat(x)`, `.map(fn)` or `+ y` make it more.
function wholeValue(code, i) {
  for (;;) {
    const gap = /^\s*/.exec(code.slice(i))[0]
    i += gap.length
    if (i >= code.length || ';,}'.includes(code[i])) return true
    const word = /^(?:as|satisfies)\b/.exec(code.slice(i))
    if (word) {
      i = skipType(code, i + word[0].length)
      continue
    }
    return gap.includes('\n') && !CONTINUES.test(code.slice(i))
  }
}

// Why the array named `name`, whose `[` is at `at`, holds more entries than
// its literal shows, or null: an expression after it, or a call that adds or
// takes out entries later.
function builtFromMore(code, name, at) {
  const label = name === 'default' ? 'the default export' : name
  const close = closeBracket(code, at)
  if (close === -1 || !wholeValue(code, close + 1)) return `${label} is built from more than its array literal, so it is not statically readable`
  if (name === 'default') return null
  const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\.\\s*(${MUTATORS.join('|')})\\s*\\(`).exec(code)
  return call ? `${label} is changed by ${call[1]}() after it is declared, so it is not statically readable` : null
}

// A manifest's entries, read from the exported array whose items carry a
// `slug` (one named `stories` first). Returns
//   { name, entries, unreadable }
// `entries` lines up with the array: each item's literal fields as written,
// or null for an item that is not an object literal. `unreadable` lists what
// was left out, as { entry, slug, field, detail }: `entry` is the item's
// index, or null when the manifest as a whole cannot be read (then there are
// no entries); `field` is null when the whole item is unreadable, and `...`
// when the item spreads another object in, so any field may come from there.
export function readManifest(text, file = 'manifest.ts') {
  const code = stripComments(text, file)
  const candidates = exportedArrays(code)
    .map((c) => ({ ...c, items: parseArrayAt(text, c.at) ?? [] }))
    .filter((c) => c.items.some((item) => isObject(item) && !isSkipped(item) && 'slug' in item))
    .sort((a, b) => (b.name === 'stories') - (a.name === 'stories'))
  const chosen = candidates[0]
  const whole = (name, detail) => ({ name, entries: [], unreadable: [{ entry: null, slug: null, field: null, detail }] })
  if (!chosen) return whole(null, `${file} exports no array of entries with a slug`)
  // Entries the literal does not show (`[...].concat(more)`, a later push)
  // would make every check a guess, so none is made.
  const more = builtFromMore(code, chosen.name, chosen.at)
  if (more) return whole(chosen.name, more)
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
      const close = closeBracket(src, i + 1)
      if (close === -1) return src.length
      i = close
    }
  }
  return i
}

// The `}` or `]` that closes the `{` or `[` at `open`, past strings and
// templates, or -1.
export function closeBracket(src, open) {
  const opener = src[open]
  const closer = opener === '[' ? ']' : '}'
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'") i = skipQuoted(src, i)
    else if (c === '`') i = skipTemplate(src, i)
    else if (c === opener) depth++
    else if (c === closer && --depth === 0) return i
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
      const close = closeBracket(src, i)
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
      const close = closeBracket(src, j)
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
// that is not a literal is { expr } with its source, and a label that only a
// spread (`{...props}`) could give is { spread } with the spread's source, so
// a check can tell a label it cannot read from one that is missing (null).
export function readStoryStates(text, { tag = 'StoryState' } = {}) {
  const template = templateOf(text)
  const out = []
  for (const m of template.matchAll(new RegExp(`<${tag}(?=[\\s/>])`, 'g'))) {
    const attrs = readAttributes(template, m.index + m[0].length)
    if (!attrs) continue
    const flush = attrs.flush === undefined ? false : attrs.flush === '' ? true : attrs.flush
    const label = attrs.label ?? attrs.name ?? (attrs['...'] ? { spread: attrs['...'].map((s) => s.replace(/^\.\.\.\s*/, '')).join(', ') } : null)
    out.push({ label, note: attrs.note ?? null, ground: attrs.ground ?? null, flush })
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

// ── Story files of other tools ──────────────────────────────────────────────

const IDENT = /^[A-Za-z_$][\w$]*/
const META_LISTS = ['includeStories', 'excludeStories']
const escapeName = (name) => name.replace(/\$/g, '\\$')

// A string literal at the start of `s` (quotes, or a template without `${}`),
// as its value; null when what is there is not one.
function literalString(s) {
  const quoted = /^\s*(["'])((?:\\.|(?!\1)[^\\\n])*)\1/.exec(s)
  if (quoted) return quoted[2].replace(/\\(.)/g, '$1')
  const template = /^\s*`((?:\\.|[^`\\$]|\$(?!\{))*)`/.exec(s)
  return template ? template[1].replace(/\\(.)/g, '$1') : null
}

// The module each local import name comes from, as a Map.
function importBindings(code) {
  const out = new Map()
  for (const m of code.matchAll(/(?<![\w$.])import\s+(?:type\s+)?([\w$*\s{},]+?)\s*\bfrom\s*(['"])([^'"\n]+)\2/g)) {
    const head = m[1].replace(/\{[\s\S]*\}/, '').replace(/,\s*$/, '').trim()
    const ns = /^\*\s*as\s+([\w$]+)/.exec(head)
    if (ns) out.set(ns[1], m[3])
    else if (head) out.set(head, m[3])
    for (const item of /\{([\s\S]*)\}/.exec(m[1])?.[1].split(',') ?? []) {
      const local = item.replace(/^\s*type\s+/, '').split(/\s+as\s+/).pop().trim()
      if (local) out.set(local, m[3])
    }
  }
  return out
}

// `code` with the contents of its strings and templates blanked, offsets
// kept, so `export default` inside a string is not the module's own.
function stringsBlanked(text, code, file) {
  let out = ''
  let from = 0
  for (const { text: s, start } of stringLiterals(text, file)) {
    out += code.slice(from, start) + s.replace(/[^\n]/g, ' ')
    from = start + s.length
  }
  return out + code.slice(from)
}

// The module named in the string literal that ends the match `m` of a
// regex run on the blanked code, read from the code itself.
const moduleIn = (code, m) => /(['"])([^'"\n]+)\1\s*$/.exec(code.slice(m.index, m.index + m[0].length))?.[2] ?? null

// The object a CSF file default-exports: an inline literal, or the const it
// names. null when there is no default export, { expr } when it is not a
// literal. `blanked` is `code` with its strings blanked, where the export is
// looked for.
function csfDefault(text, code, blanked) {
  const m = /(?<![\w$.])export\s+default\s+\(?\s*/.exec(blanked)
  const named = /(?<![\w$.])export\s*\{[^}]*?\b([A-Za-z_$][\w$]*)\s+as\s+default\b/.exec(blanked)
  if (!m && !named) return null
  const after = m ? m.index + m[0].length : -1
  if (m && blanked[after] === '{') return parseObjectAt(text, after)
  const name = m ? IDENT.exec(blanked.slice(after))?.[0] : named[1]
  if (!name) return { expr: code.slice(after).split('\n')[0].trim() }
  const decl = new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${escapeName(name)}\\s*(?::[^=;]*)?=\\s*\\(?\\s*`).exec(blanked)
  if (decl && blanked[decl.index + decl[0].length] === '{') return parseObjectAt(text, decl.index + decl[0].length)
  return { expr: name }
}

// Whether the declaration whose name ends at `i` declares more names in the
// same statement (`export const A = {}, B = {}`): a comma outside brackets,
// before the statement ends, followed by another name and its `=`.
const NEXT_DECLARATOR = /,\s*[A-Za-z_$][\w$]*\s*(?::[^=;,]*)?=(?![=>])/y
const LINE_GAP = /\s*/y
function declaresMore(blanked, i) {
  const init = /^\s*(?::[^=;,]*)?=/.exec(blanked.slice(i, i + 400))
  if (!init) return /^\s*,/.test(blanked.slice(i, i + 40))
  let depth = 0
  for (let j = i + init[0].length; j < blanked.length; j++) {
    const c = blanked[j]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) {
      if (depth === 0) return false
      depth--
    } else if (depth > 0) continue
    else if (c === ';') return false
    else if (c === ',') {
      NEXT_DECLARATOR.lastIndex = j
      if (NEXT_DECLARATOR.test(blanked)) return true
    } else if (c === '\n') {
      LINE_GAP.lastIndex = j + 1
      LINE_GAP.test(blanked)
      const next = blanked.slice(LINE_GAP.lastIndex, LINE_GAP.lastIndex + 12)
      if (next[0] !== ',' && !CONTINUES.test(next)) return false
    }
  }
  return false
}

// The names a module exports beyond its default, in file order, as
// { name, local, at, from }: `local` is the name inside the module, and
// `from` the module a re-export comes from. `stars` lists the modules an
// `export * from` passes on whole, and `more` the exported declarations that
// go on to declare other names in the same statement. Exports are looked
// for in `blanked`, the code with its strings blanked.
function namedExports(code, blanked) {
  const found = []
  const more = []
  const add = (name, local, at, from = null) => {
    if (name && name !== 'default' && !found.some((f) => f.name === name)) found.push({ name, local, at, from })
  }
  for (const m of blanked.matchAll(/(?<![\w$.])export\s+(?:declare\s+)?(?:async\s+)?(const|let|var|function\*?)\s+([A-Za-z_$][\w$]*)/g)) {
    add(m[2], m[2], m.index)
    if (!m[1].startsWith('function') && declaresMore(blanked, m.index + m[0].length)) more.push(m[2])
  }
  for (const m of blanked.matchAll(/(?<![\w$.])export\s*\{([^}]*)\}\s*(?:from\s*(['"])[^'"\n]*\2)?/g)) {
    for (const part of m[1].split(',')) {
      if (/^\s*type\s/.test(part)) continue
      const [local, name = local] = part.split(/\s+as\s+/).map((s) => s.trim())
      add(name, local, m.index, m[2] ? moduleIn(code, m) : null)
    }
  }
  const stars = [...blanked.matchAll(/(?<![\w$.])export\s*\*\s*(?:as\s+[\w$]+\s*)?from\s*(['"])[^'"\n]*\1/g)].map((m) => moduleIn(code, m))
  return { found: found.sort((a, b) => a.at - b.at), stars, more }
}

// A CSF file (Component Story Format: Storybook's, which Ladle reads too)
// read as text. The default export gives the title, the component and the
// rest of the meta; every named export is a story, with its storyName (or a
// CSF3 object's `name`) and whether it sets args or argTypes. Returns
//   { title, component, meta, stories, args, argTypes, unreadable }
// where `component` is { name, from } (the identifier and the module it is
// imported from), `meta` holds the default export's other literal fields,
// `stories` is [{ export, storyName, args, argTypes }] in file order, and
// `unreadable` lists what was left out as { story, field, detail }, `story`
// being null for the default export or the whole file. A title left out is
// null: Storybook then takes it from the path.
export function readCsf(text, file = 'x.stories.tsx') {
  const code = stripComments(text, file)
  const blanked = stringsBlanked(text, code, file)
  const out = { title: null, component: null, meta: {}, stories: [], args: false, argTypes: false, unreadable: [] }
  const skip = (story, field, detail) => out.unreadable.push({ story, field, detail })
  if (/(?<![\w$.])storiesOf\s*\(/.test(blanked)) {
    skip(null, null, 'it uses storiesOf(), which adds its stories at run time')
    return out
  }
  const meta = csfDefault(text, code, blanked)
  let only = null
  let except = null
  if (meta === null) skip(null, null, 'it has no default export, so it is not a CSF file')
  else if (isSkipped(meta)) skip(null, null, `its default export is ${meta.expr ?? meta.spread}, not an object literal`)
  else {
    if (meta.__spreads) skip(null, '...', `the default export spreads ${meta.__spreads.join(', ')} into it`)
    for (const [key, value] of Object.entries(meta)) {
      if (key === 'args' || key === 'argTypes') out[key] = true
      else if (key === 'title') {
        if (typeof value === 'string') out.title = value
        else skip(null, 'title', 'title is not statically readable')
      } else if (key === 'component') {
        const name = isObject(value) && /^[A-Za-z_$][\w$.]*$/.test(value.expr ?? '') ? value.expr : null
        if (name) out.component = { name, from: importBindings(code).get(name.split('.')[0]) ?? null }
        else skip(null, 'component', 'component is not statically readable')
      } else if (META_LISTS.includes(key)) {
        if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
          if (key === 'includeStories') only = value
          else except = value
        } else skip(null, key, `${key} is not a list of names, so every named export is listed`)
      } else if (unreadableIn(value)) skip(null, key, `${key} is not statically readable`)
      else out.meta[key] = value
    }
  }
  const { found, stars, more } = namedExports(code, blanked)
  for (const from of stars) skip(null, null, `it passes on every export of ${from}, which are not listed`)
  for (const name of more) skip(name, null, `${name} is declared with more names in one statement, and the names after it are not listed`)
  const assigned = (name, prop) => new RegExp(`(?<![\\w$.])${escapeName(name)}\\.${prop}\\s*=\\s*`).exec(blanked)
  for (const { name, local, from } of found) {
    if (name === '__namedExportsOrder' || (only && !only.includes(name)) || except?.includes(name)) continue
    const story = { export: name, storyName: null, args: false, argTypes: false }
    if (from) {
      skip(name, null, `${name} is re-exported from ${from}`)
      out.stories.push(story)
      continue
    }
    // A CSF3 story is an object literal: its name, args and argTypes are keys.
    const value = new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${escapeName(local)}\\s*(?::[^=;]*)?=\\s*`).exec(blanked)
    const objectAt = value ? value.index + value[0].length : -1
    const object = objectAt !== -1 && blanked[objectAt] === '{' ? parseObjectAt(text, objectAt) : null
    if (object) {
      for (const key of ['name', 'storyName']) {
        if (object[key] === undefined) continue
        if (typeof object[key] === 'string') story.storyName = object[key]
        else skip(name, key, `${key} is not statically readable`)
      }
      story.args = 'args' in object
      story.argTypes = 'argTypes' in object
    }
    // CSF2 and Ladle set them on the export after it.
    const storyName = assigned(local, 'storyName')
    if (storyName) {
      const s = literalString(code.slice(storyName.index + storyName[0].length))
      if (s === null) skip(name, 'storyName', 'storyName is not statically readable')
      else story.storyName = s
    }
    story.args ||= Boolean(assigned(local, 'args'))
    story.argTypes ||= Boolean(assigned(local, 'argTypes'))
    out.args ||= story.args
    out.argTypes ||= story.argTypes
    out.stories.push(story)
  }
  return out
}

// Where the tag whose attributes start at `i` ends, as { selfClosing }, past
// quoted values and `{...}` expressions; null when it never closes.
function tagEnd(src, i) {
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'") i = skipQuoted(src, i)
    else if (c === '{') {
      const close = closeBracket(src, i)
      if (close === -1) return null
      i = close
    } else if (c === '>') return { selfClosing: src[i - 1] === '/' }
  }
  return null
}

// A Histoire story file (`*.story.vue`, `*.story.svelte`) read as text: each
// <Story> with its title and the titles of the <Variant>s inside it
// (`Hst.Story` and `Hst.Variant` in Svelte). A bound title (`:title`, or
// `title={...}` that is not a literal) is not statically readable; a missing
// one is null, since Histoire then names it. Returns
//   { stories: [{ title, variants: [title] }], unreadable: [{ story, field, detail }] }
export function readHistoire(text) {
  const template = templateOf(text)
  const out = { stories: [], unreadable: [] }
  const titleOf = (attrs, story, what) => {
    const bound = attrs[':title'] !== undefined || attrs['v-bind:title'] !== undefined
    const t = attrs.title
    if (!bound && (t === undefined || t === true)) return null
    if (!bound && typeof t === 'string') return t
    out.unreadable.push({ story, field: what.startsWith('variant') ? 'variant' : 'title', detail: `the title of ${what} is not statically readable` })
    return null
  }
  const open = []
  let loose = 0
  for (const m of template.matchAll(/<(\/?)((?:Hst\.)?(?:Story|Variant))(?=[\s/>])/g)) {
    const kind = m[2].replace(/^Hst\./, '')
    if (m[1]) {
      if (kind === 'Story') open.pop()
      continue
    }
    const at = m.index + m[0].length
    const attrs = readAttributes(template, at)
    const end = tagEnd(template, at)
    if (!attrs || !end) continue
    if (kind === 'Story') {
      const index = out.stories.length
      out.stories.push({ title: titleOf(attrs, index, `story ${index + 1}`), variants: [] })
      if (!end.selfClosing) open.push(index)
    } else if (open.length === 0) {
      loose++
    } else {
      const index = open[open.length - 1]
      const story = out.stories[index]
      story.variants.push(titleOf(attrs, index, `variant ${story.variants.length + 1} of story ${index + 1}`))
    }
  }
  if (loose > 0) out.unreadable.push({ story: null, field: 'variant', detail: `${loose} ${loose === 1 ? 'variant sits' : 'variants sit'} outside any <Story>` })
  return out
}
