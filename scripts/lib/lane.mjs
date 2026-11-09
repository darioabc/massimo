// The csf lane's registry: every story file read in place, every state with
// its id, route, merged meta and source span. Read by the Vite plugin, by
// stories.mjs, the graph, convert and verify.
//
// An id is `${slug}--${state}`. Under `stories.ids: "ladle"` both halves
// follow Ladle's rule, which can put `--` inside a half, so ids are a table
// to look up and never a string to split.

import { createHash } from 'node:crypto'
import { compare } from './glob.mjs'
import { ladleIdMeta } from './ladle-ids.mjs'
import { orderIds, stateUrl } from './lane-route.mjs'
import { isTestFile } from './source.mjs'
import { fileSlug, listFaults, readCsf, stateName, stateSlug, titleSlug } from './stories-read.mjs'

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Ladle's meta merge (lodash.merge): plain objects merge key by key at any
// depth, arrays merge index by index, and any other value of the story's
// replaces the file's.
function mergeMeta(base, over) {
  if (Array.isArray(base) && Array.isArray(over)) {
    const out = [...base]
    over.forEach((v, i) => (out[i] = i < base.length ? mergeMeta(base[i], v) : v))
    return out
  }
  if (isPlain(base) && isPlain(over)) {
    const out = { ...base }
    for (const [key, v] of Object.entries(over)) out[key] = key in base ? mergeMeta(base[key], v) : v
    return out
  }
  return over === undefined ? base : over
}

// The type import that brings the story types in: the first type-only
// import of `Story` or `StoryDefault`. Found by name, so it is the same
// import before and after its specifier is rewritten.
const storyTypeImport = (csf) => csf.typeImports.find((t) => t.names.includes('Story') || t.names.includes('StoryDefault')) ?? null

const titleLevels = (title) => title.split('/').map((part) => part.trim()).filter(Boolean)

// The registry of `files` (repo-relative story paths), each read through
// `read(file)`. Test files are skipped. Problems, all under the rule
// `story-files`, are a file that cannot be read, a title or export list the
// reader cannot read in full, a file with no title, a storyName that a
// Ladle id needs and cannot be read, an export name Ladle refuses, a
// duplicate id, and a `stories.home` that names no story.
export function laneRegistry({ root, config, files, read } = {}) {
  const rule = config?.stories?.ids === 'ladle' ? 'ladle' : 'export'
  const registry = { format: 1, ids: rule, stories: {}, order: [], home: null, slugs: {}, files: {}, problems: [] }
  const problem = (file, detail) => registry.problems.push({ rule: 'story-files', file, detail })
  const sortKeys = new Map()
  for (const file of [...(files ?? [])].sort(compare)) {
    if (isTestFile(file)) continue
    let text
    try {
      text = read(file)
    } catch (e) {
      problem(file, `it cannot be read (${e.code ?? e.message})`)
      continue
    }
    const csf = readCsf(text, file)
    const faults = listFaults(csf)
    for (const u of faults) problem(file, u.story ? `${u.story}: ${u.detail}` : u.detail)
    if (csf.title === null && !faults.some((u) => u.story === null)) problem(file, 'it declares no title, so its states take their slug from the file name')
    const slug = csf.title === null ? fileSlug(file, rule) : titleSlug(csf.title, rule)
    const levels = csf.title === null ? [file.split('/').pop().split('.')[0]] : titleLevels(csf.title)
    const fileMeta = isPlain(csf.meta.meta) ? csf.meta.meta : {}
    const record = { title: csf.title, slug, ids: [], typeImport: storyTypeImport(csf), unreadable: csf.unreadable }
    registry.files[file] = record
    const group = (registry.slugs[slug] ??= { title: csf.title, files: [], ids: [] })
    group.files.push(file)
    csf.stories.forEach((s, index) => {
      if (rule === 'ladle') {
        if (s.export.includes('__')) problem(file, `Ladle refuses the export ${s.export}, since it keeps "__" for its own encoding`)
        if (csf.unreadable.some((u) => u.story === s.export && u.field === 'storyName')) problem(file, `the id of ${s.export} comes from its storyName, which is not statically readable`)
      }
      const state = stateSlug(s, rule)
      const id = `${slug}--${state}`
      const other = registry.stories[id]
      if (other) {
        problem(file, `${s.export} has the id ${id}, which ${other.file === file ? '' : `${other.file}'s `}${other.export} has too`)
        return
      }
      registry.stories[id] = {
        id,
        slug,
        state,
        title: csf.title,
        levels,
        name: stateName(s),
        file,
        export: s.export,
        meta: mergeMeta(fileMeta, s.meta ?? {}),
        args: s.args,
        argTypes: s.argTypes,
        parameters: s.parameters,
        span: s.span,
      }
      record.ids.push(id)
      group.ids.push(id)
      sortKeys.set(id, [csf.title ?? levels.join(' / '), file, index])
    })
  }
  // Title, then file path, then export order; the `stories.order` globs go first.
  const byTitle = [...sortKeys.keys()].sort((a, b) => {
    const [ta, fa, ia] = sortKeys.get(a)
    const [tb, fb, ib] = sortKeys.get(b)
    return compare(ta, tb) || compare(fa, fb) || ia - ib
  })
  registry.order = orderIds(byTitle, config?.stories?.order)
  const home = config?.stories?.home ?? null
  if (home !== null && registry.stories[home]) registry.home = home
  else if (home !== null) problem(null, `stories.home is ${home}, which no story has`)
  return registry
}

// The registry in the shape of Ladle's own meta.json, in the registry's
// order. Under Ladle's ids, `name` and `levels` are what Ladle shows for the
// id (it splits on every `--`); under export ids, the state's own name and
// its title's parts.
export function ladleMeta(registry) {
  const stories = {}
  for (const id of registry.order) {
    const s = registry.stories[id]
    const { name, levels } = registry.ids === 'ladle' ? ladleIdMeta(id) : s
    stories[id] = { name, levels, locStart: s.span?.start ?? null, locEnd: s.span?.end ?? null, filePath: s.file, namedExport: s.export, meta: s.meta }
  }
  return { about: { generator: 'massimo', format: registry.format ?? 1 }, stories }
}

// Old id to new route, for the ids a repo used before the lane, sorted by
// old id. `oldIds` is a list of ids, or the `stories` of Ladle's meta.json,
// whose filePath and namedExport find a story whose id changed. An old id
// that no story takes maps to null.
export function redirectTable(registry, oldIds) {
  const byExport = new Map(Object.values(registry.stories).map((s) => [`${s.file}\n${s.export}`, s]))
  const entries = Array.isArray(oldIds) ? oldIds.map((id) => [id, null]) : Object.entries(oldIds ?? {})
  const out = {}
  for (const [id, old] of entries.sort(([a], [b]) => compare(a, b))) {
    const story = registry.stories[id] ?? (old ? byExport.get(`${old.filePath}\n${old.namedExport}`) : undefined)
    out[id] = story ? stateUrl(story) : null
  }
  return out
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// What a type import's specifier becomes before hashing, quotes included.
const SPECIFIER_PLACEHOLDER = '"massimo:story-types"'

// sha256 of the file with the one type import's specifier (and its quotes)
// replaced by a placeholder, its names kept, so rewriting where the types
// come from keeps the hash and any other edit changes it. With no type
// import, the sha256 of the file as it is.
export function normalHash(text, typeImport) {
  let body = text
  if (typeImport) {
    const statement = text.slice(typeImport.start, typeImport.end)
    const quoted = /(['"])[^'"\n]*\1$/.exec(statement)
    if (statement.startsWith('import') && quoted) {
      const at = typeImport.start + quoted.index
      body = text.slice(0, at) + SPECIFIER_PLACEHOLDER + text.slice(at + quoted[0].length)
    }
  }
  return sha256(body)
}

// sha256 of one export's source, the lines its span covers, to name the
// export that moved. '' for a span that covers no line.
export function spanHash(text, span) {
  if (!span || !(span.start >= 1) || span.end < span.start) return ''
  return sha256(text.split('\n').slice(span.start - 1, span.end).join('\n'))
}
