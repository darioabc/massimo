// Converting a Ladle repo to the csf lane: working records per story file,
// the frozen design targets, and the removal patch for the tool's type import.
//
// The story files stay where they are. The one thing that changes in them is
// the specifier of the type import (`import type { Story } from '@ladle/react'`),
// which points at the lane's own types once the tool goes. A record keeps a
// hash of each file with that specifier blanked, so a later check can prove
// nothing else moved. A design target is frozen instead: its whole text is
// pinned by sha256 in `stories.frozen`, and no edit reaches it.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { compare } from './glob.mjs'
import { normalHash, spanHash } from './lane.mjs'
import { stripComments } from './source.mjs'
import { readCsf } from './stories-read.mjs'

export const LADLE_MODULE = '@ladle/react'
export const DEFAULT_TYPES_FILE = 'src/stories/story.ts'
export const LEGACY_TYPES_FILE = 'src/stories/legacy-story-types.d.ts'
export const RECORD_FORMAT = 1
export const REMOVAL_FORMAT = 1

// The story types the lane's scaffold writes to the default types file; the
// declaration for a frozen file uses them when that file is not there yet.
export const DEFAULT_STORY_TYPES = `import type { ReactNode } from 'react'

export type ArgType = { control?: { type: string }; options?: readonly unknown[]; defaultValue?: unknown; name?: string; description?: string }

export type Story<P = {}> = ((props: P) => ReactNode) & {
  storyName?: string
  meta?: Record<string, unknown>
  parameters?: Record<string, unknown>
  args?: Partial<P> & Record<string, unknown>
  argTypes?: Record<string, ArgType>
}

export type StoryDefault<P = {}> = { title: string; meta?: Record<string, unknown>; args?: Partial<P>; argTypes?: Record<string, ArgType> }
`

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const isStoryType = (t) => t.names.includes('Story') || t.names.includes('StoryDefault')
const readFrom = (root) => (file) => readFileSync(join(root, file), 'utf8')

// sha256 of a file's bytes, or null when it is not there.
export function fileSha(root, file) {
  try {
    return sha256(readFileSync(join(root, file)))
  } catch {
    return null
  }
}

// The type import of a story file that the edits are about: the one import
// of the story types, and whether it comes from one of `specs` (the tool, or
// the relative path to the types file once the patch is applied). Returns
// { found, why } where `why` is 'none' (no import of the story types), 'two'
// (more than one) or 'other' (from another module) when there is no single
// import from those.
function typeImportOf(csf, specs) {
  const imports = csf.typeImports.filter(isStoryType)
  if (imports.length === 0) return { found: null, why: 'none' }
  if (imports.length > 1) return { found: null, why: 'two' }
  if (!specs.includes(imports[0].spec)) return { found: null, why: 'other' }
  return { found: imports[0], why: null }
}

const WHY = {
  none: 'it has no type import of Story or StoryDefault, so it is compared as a whole',
  two: 'it imports the story types in more than one statement, so it is compared as a whole',
  other: 'it imports the story types from another module than the tool, so it is compared as a whole',
}

// One record per story file, keyed by repo path, sorted by path. A record
// holds the file's raw sha256, its normal hash (the file with its type
// import's specifier blanked), the type import, whether the file is pinned
// in `frozen`, one entry per state with its span hash, what the reader could
// not read, and the lines a person passes over by hand.
export function conversionRecords(registry, { root, frozen = [], tool = LADLE_MODULE, typesFile = DEFAULT_TYPES_FILE, read = readFrom(root) } = {}) {
  const pinned = new Map(frozen.map((f) => [f.file, f]))
  const records = []
  for (const file of Object.keys(registry.files).sort(compare)) {
    let text
    try {
      text = read(file)
    } catch {
      continue
    }
    const csf = readCsf(text, file)
    const info = registry.files[file]
    const { found, why } = typeImportOf(csf, [tool, relativeSpecifier(file, typesFile)])
    const handPass = []
    if (why) handPass.push({ kind: 'type-import', story: null, detail: WHY[why] })
    const argsInStory = []
    const states = info.ids.map((id) => {
      const s = registry.stories[id]
      const own = csf.stories.find((x) => x.export === s.export)
      if (s.args || s.argTypes) argsInStory.push(s.export)
      if (s.parameters) handPass.push({ kind: 'parameters', story: s.export, detail: 'it sets parameters, which the canvas does not read' })
      return { id, export: s.export, storyName: own?.storyName ?? null, meta: s.meta, args: s.args, argTypes: s.argTypes, parameters: s.parameters, span: s.span, spanHash: spanHash(text, s.span) }
    })
    for (const name of argsInStory) handPass.push({ kind: 'args', story: name, detail: 'it sets args or argTypes, which stay in the file and apply at run time' })
    if ((csf.args || csf.argTypes) && argsInStory.length === 0) handPass.push({ kind: 'args', story: null, detail: 'its default export sets args or argTypes, which stay in the file and apply at run time' })
    records.push({
      format: RECORD_FORMAT,
      file,
      title: info.title,
      slug: info.slug,
      sha256: sha256(Buffer.from(text)),
      normalHash: normalHash(text, found),
      typeImport: found ? { spec: found.spec, names: found.names } : null,
      frozen: pinned.has(file) ? { sha256: pinned.get(file).sha256, since: pinned.get(file).since ?? null } : null,
      states,
      unreadable: info.unreadable,
      handPass,
    })
  }
  return records
}

// What the records add up to: files, states, frozen files, the files with an
// args or argTypes, the stories with parameters and the files compared whole.
export function recordsSummary(records) {
  const hand = (kind) => records.flatMap((r) => r.handPass.filter((h) => h.kind === kind).map((h) => ({ file: r.file, ...h })))
  return {
    files: records.length,
    states: records.reduce((n, r) => n + r.states.length, 0),
    frozen: records.filter((r) => r.frozen).length,
    argsFiles: records.filter((r) => r.handPass.some((h) => h.kind === 'args')).map((r) => r.file),
    parametersStories: hand('parameters'),
    wholeFiles: hand('type-import'),
  }
}

const filled = (v) => (typeof v === 'string' ? v.trim() !== '' : v === true)

// Files that look like design targets to freeze: those whose default export
// sets a meta key that `policy.bannerByRoot` names (any key, with no policy
// only `exploration`) to text. The default export's own meta is read from the
// file with `read` (a repo path to its text); a file that cannot be read is
// left out. Returns [{ file, key }] sorted by path.
export function frozenCandidates(registry, policy, { root, read = readFrom(root) } = {}) {
  const keys = policy?.bannerByRoot && typeof policy.bannerByRoot === 'object' ? [...new Set(Object.values(policy.bannerByRoot))] : ['exploration']
  const out = []
  for (const file of Object.keys(registry?.files ?? {}).sort(compare)) {
    let meta
    try {
      meta = readCsf(read(file), file).meta.meta
    } catch {
      continue
    }
    const key = keys.find((k) => filled(meta?.[k]))
    if (key) out.push({ file, key })
  }
  return out
}

// A frozen entry for `file` as it is now.
export function freezeEntry(root, file, since) {
  return { file, sha256: fileSha(root, file), since }
}

// Frozen files that changed since they were pinned, as { rule, file, detail }.
// A file that is gone is a retired design target and no problem.
export function frozenProblems(root, config) {
  const out = []
  for (const f of config?.stories?.frozen ?? []) {
    if (typeof f?.file !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256 ?? '')) {
      out.push({ rule: 'story-frozen', file: f?.file ?? null, detail: 'its stories.frozen entry needs a file and its sha256' })
      continue
    }
    const now = fileSha(root, f.file)
    if (now === null || now === f.sha256) continue
    out.push({ rule: 'story-frozen', file: f.file, detail: `it is a design target pinned since ${f.since ?? 'an unknown date'} and it has changed: restore it, or pin the new text with convert stories --refreeze ${f.file}` })
  }
  return out
}

// Re-pin a frozen file: its sha256 as it is now and `since`. Returns
// { file, old, new, since, frozen } where `frozen` is the whole list to write
// to `stories.frozen`; the caller writes the config. Throws when the file is
// not in the list or is not there.
export function refreeze(root, config, file, { since } = {}) {
  const list = config?.stories?.frozen ?? []
  const entry = list.find((f) => f.file === file)
  if (!entry) throw new Error(`${file} is not in stories.frozen: ${list.length ? `it holds ${list.map((f) => f.file).join(', ')}` : 'the list is empty'}`)
  const now = fileSha(root, file)
  if (now === null) throw new Error(`${file} is not there, so there is nothing to pin: remove its entry from stories.frozen`)
  const pinned = { ...entry, sha256: now, since }
  return { file, old: entry.sha256 ?? null, new: now, since, frozen: list.map((f) => (f === entry ? pinned : f)) }
}

// Pin one more story file: its sha256 as it is now and `since`, added to the
// end of the list. Returns { file, since, sha256, frozen } like refreeze. Throws
// when the file is not a story file of the lane, is not there, or is pinned.
export function freeze(root, config, registry, file, { since } = {}) {
  const list = config?.stories?.frozen ?? []
  if (list.some((f) => f.file === file)) throw new Error(`${file} is already in stories.frozen: convert stories --refreeze ${file} pins it again`)
  if (!registry?.files?.[file]) throw new Error(`${file} is not a story file of the lane: stories.include matches ${Object.keys(registry?.files ?? {}).length} files`)
  const entry = freezeEntry(root, file, since)
  if (entry.sha256 === null) throw new Error(`${file} is not there, so there is nothing to pin`)
  return { file, sha256: entry.sha256, since, frozen: [...list, entry] }
}

// ── The types file ──────────────────────────────────────────────────────────

// Whether a types file holds only non-relative `import type` lines and
// `export type` (or `export interface`) declarations. Returns
// { problems: [text], names: [exported name] }. A statement head is a line
// outside every bracket that starts at the left margin or with a statement
// keyword, however far it is indented; the lines under it are its body. A
// relative module specifier anywhere is refused too, since the declaration
// sits in the tool's module, which cannot reach a relative path.
const STATEMENT = /^(?:import|export|const|let|var|function|class|declare|type|interface|enum|namespace|module|abstract|async)\b/

const RELATIVE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])\.[^'"]*\1/

export function checkTypesFile(text, file = 'story.ts') {
  const code = stripComments(text, file)
  const problems = []
  const names = []
  let depth = 0
  let quote = null
  for (const line of code.split('\n')) {
    const t = line.trim()
    const head = depth === 0 && quote === null && t !== '' && (/^\S/.test(line) || STATEMENT.test(t))
    if (RELATIVE.test(t)) problems.push(`${t} is a relative import, which a declaration in the tool's module cannot hold`)
    if (head) {
      const imp = /^import\s+type\b[^'"]*(['"])([^'"]*)\1\s*;?\s*$/.exec(t)
      const decl = /^export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/.exec(t)
      if (decl) names.push(decl[1])
      else if (!imp) problems.push(`${t} is neither an import type line nor an export type declaration`)
    }
    for (const c of line) {
      if (quote) {
        if (c === quote) quote = null
      } else if (c === "'" || c === '"' || c === '`') quote = c
      else if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) depth--
    }
    if (quote && quote !== '`') quote = null
  }
  return { problems, names }
}

// The ambient file that declares the tool's module with the types text, so a
// file that still imports the tool type-checks once the package goes. The
// text sits inside the declaration, indented; its imports are non-relative.
function ambientDeclaration(tool, typesText, typesFile) {
  const body = typesText
    .replace(/\s+$/, '')
    .split('\n')
    .map((l) => (l === '' ? '' : `  ${l}`))
    .join('\n')
  return `// The story types that files still importing ${tool} use. Written by massimo\n// adopt convert stories, from ${typesFile}; delete it with the last such file.\ndeclare module '${tool}' {\n${body}\n}\n`
}

// ── The removal edits and patch ─────────────────────────────────────────────

const stripExt = (p) => p.replace(/\.(?:d\.)?[cm]?tsx?$/, '')

// The specifier a story file uses to reach the types file.
function relativeSpecifier(file, typesFile) {
  const path = posix.relative(posix.dirname(file), stripExt(typesFile))
  return path.startsWith('.') ? path : `./${path}`
}

// The edits that take the tool's type import out of every story file that is
// not frozen: the specifier of the one import of Story or StoryDefault from
// `tool` becomes a relative path to `typesFile`. Returns
//   [{ file, start, end, before, after }]
// (offsets into the file's text, the quoted specifier before and after),
// then, when a file still imports the tool, one
//   { file, create: true, text }
// for the ambient declaration. A file whose import cannot be rewritten (it has
// none, two, or one from another module, or names the types file lacks) is left
// out. `typesText` is the text of the types file; `names` those it exports.
export function removalEdits(registry, { root, tool = LADLE_MODULE, typesFile = DEFAULT_TYPES_FILE, typesText = DEFAULT_STORY_TYPES, frozen = [], read = readFrom(root) } = {}) {
  const pinned = new Set(frozen.map((f) => f.file))
  const exported = new Set(checkTypesFile(typesText, typesFile).names)
  const edits = []
  let leftover = false
  for (const file of Object.keys(registry?.files ?? {}).sort(compare)) {
    const text = read(file)
    const csf = readCsf(text, file)
    const imports = csf.typeImports.filter(isStoryType)
    const { found } = typeImportOf(csf, [tool, relativeSpecifier(file, typesFile)])
    // An import already pointing at the types file is done, and no edit.
    const usable = found && found.spec === tool && !pinned.has(file) && found.names.every((n) => exported.has(n))
    if (!usable) {
      if (imports.some((t) => t.spec === tool)) leftover = true
      continue
    }
    const statement = text.slice(found.start, found.end)
    const quoted = /(['"])[^'"\n]*\1$/.exec(statement)
    if (!statement.startsWith('import') || !quoted) {
      leftover = true
      continue
    }
    const q = quoted[1]
    const at = found.start + quoted.index
    edits.push({ file, start: at, end: at + quoted[0].length, before: quoted[0], after: `${q}${relativeSpecifier(file, typesFile)}${q}` })
  }
  if (leftover) {
    const text = ambientDeclaration(tool, typesText, typesFile)
    // Not again once the patch has put it there.
    let there = null
    try {
      there = read(LEGACY_TYPES_FILE)
    } catch {}
    if (there !== text) edits.push({ file: LEGACY_TYPES_FILE, create: true, text })
  }
  return edits
}

// The text with one specifier edit applied.
export const applyEdit = (text, edit) => text.slice(0, edit.start) + edit.after + text.slice(edit.end)

// A unified diff of one file whose lines changed in place (the same number of
// lines before and after), three lines of context, as `git apply` reads it.
function lineDiff(file, before, after) {
  const eol = before.endsWith('\n')
  const a = (eol ? before.slice(0, -1) : before).split('\n')
  const b = (eol ? after.slice(0, -1) : after).split('\n')
  const changed = a.flatMap((line, i) => (line === b[i] ? [] : [i]))
  const head = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`]
  const out = []
  const marker = (i) => (!eol && i === a.length - 1 ? ['\\ No newline at end of file'] : [])
  let k = 0
  while (k < changed.length) {
    let last = changed[k]
    const first = changed[k]
    k++
    while (k < changed.length && changed[k] - last <= 6) last = changed[k++]
    const from = Math.max(0, first - 3)
    const to = Math.min(a.length - 1, last + 3)
    const body = []
    for (let i = from; i <= to; i++) {
      if (a[i] === b[i]) body.push(` ${a[i]}`, ...marker(i))
      else body.push(`-${a[i]}`, ...marker(i), `+${b[i]}`, ...marker(i))
    }
    out.push(`@@ -${from + 1},${to - from + 1} +${from + 1},${to - from + 1} @@`, ...body)
  }
  return [...head, ...out].join('\n')
}

// The patch for the edits that removalEdits returned: one diff per edited
// file, then each created file as a new file. `git apply` takes it from the
// repo root.
export function removalPatch(edits, read) {
  const parts = []
  const byFile = new Map()
  for (const e of edits.filter((x) => !x.create)) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e])
  for (const [file, list] of [...byFile].sort((x, y) => compare(x[0], y[0]))) {
    const before = read(file)
    parts.push(lineDiff(file, before, [...list].sort((x, y) => y.start - x.start).reduce(applyEdit, before)))
  }
  for (const e of edits.filter((x) => x.create).sort((x, y) => compare(x.file, y.file))) {
    const lines = e.text.replace(/\n$/, '').split('\n')
    parts.push([`diff --git a/${e.file} b/${e.file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${e.file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n'))
  }
  return parts.length ? `${parts.join('\n')}\n` : ''
}

// ── The check ───────────────────────────────────────────────────────────────

// The records read back against the files now. A file pinned in `frozen` is
// left to frozenProblems; every other file's normal hash must equal its
// record's, and the exports whose span hash moved are named. Returns
// { problems: [{ file, detail }], wholeFiles: [file], checked, frozen }.
export function checkRecords(records, { root, frozen = [], read = readFrom(root) } = {}) {
  const pinned = new Set(frozen.map((f) => f.file))
  const out = { problems: [], wholeFiles: [], checked: 0, frozen: 0 }
  for (const r of records) {
    if (pinned.has(r.file)) {
      out.frozen++
      continue
    }
    if (!r.typeImport) out.wholeFiles.push(r.file)
    let text
    try {
      text = read(r.file)
    } catch {
      out.problems.push({ file: r.file, detail: 'it is gone' })
      continue
    }
    const csf = readCsf(text, r.file)
    const imports = csf.typeImports.filter(isStoryType)
    out.checked++
    if (normalHash(text, r.typeImport ? (imports[0] ?? null) : null) === r.normalHash) continue
    const moved = r.states.filter((s) => {
      const now = csf.stories.find((x) => x.export === s.export)
      return !now || spanHash(text, now.span) !== s.spanHash
    })
    const added = csf.stories.filter((x) => !r.states.some((s) => s.export === x.export))
    const named = [...moved.map((s) => `${s.export} changed`), ...added.map((x) => `${x.export} is new`)]
    out.problems.push({ file: r.file, detail: `it changed outside its type import${named.length ? `: ${named.join(', ')}` : ', outside every export (its imports, its default export or a helper)'}` })
  }
  return out
}
