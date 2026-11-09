// A repo's own `ds:` header keys, read through the roles massimo knows, and a
// file's place in the repo's taxonomy. The graph, the audit and adopt all
// read headers this way, so a key means the same thing to each of them.
//
// Roles, set per key in `graph.keys` as a name or `{ role, values, under }`:
//   list         names, comma or space separated (`ds:styles card.css, list.css`);
//                with `under`, each must be a file in that folder
//   definitions  custom properties a parent or a script sets (`ds:inputs --x, --y`),
//                which the audit counts as defined in that file
//   scope        one value, at most once per file (`ds:theme print`); with
//                `values`, one of those; audit exemptions can name it
//   breakpoint   `<width> <reason>` (`ds:breakpoint 22.5rem the bar folds`), a
//                media width the audit's breakpoint kind allows in that file

import { compileGlobs } from './glob.mjs'

export const ROLES = ['list', 'definitions', 'scope', 'breakpoint']

const CUSTOM_PROPERTY = /^--[A-Za-z0-9_-]+$/
const WIDTH = /^(\d*\.?\d+)(rem|px|em)$/

// graph.keys as a Map of key -> { role, values, under }. A key whose role
// massimo does not know is left out and named in `problems`.
export function keyRoles(config) {
  const roles = new Map()
  const problems = []
  for (const [key, spec] of Object.entries(config?.graph?.keys ?? {})) {
    const s = typeof spec === 'string' ? { role: spec } : spec ?? {}
    if (!ROLES.includes(s.role)) {
      problems.push(`graph.keys.${key} has role "${s.role}"; the roles are ${ROLES.join(', ')}`)
      continue
    }
    roles.set(key, { role: s.role, values: Array.isArray(s.values) ? s.values : null, under: typeof s.under === 'string' ? s.under.replace(/\/+$/, '') : null })
  }
  return { roles, problems }
}

// Every key the header reader should treat as known beyond the built-in
// ones: the keys with a role, then the plain extra keys.
export function knownKeys(config) {
  return [...new Set([...Object.keys(config?.graph?.keys ?? {}), ...(config?.graph?.extraKeys ?? [])])]
}

const split = (value) => value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)

// What a file's header says through the roles. `entries` is extractRules'
// list of `ds:` lines, so a repeat or a bad value can name its line.
// `exists(path)` checks a `list` item against its folder.
export function headerRoles(entries, roles, { exists = () => true } = {}) {
  const out = { definitions: [], scopes: {}, breakpoints: [], lists: {}, problems: [] }
  const problem = (e, message) => out.problems.push({ key: e.key, line: e.line, message })
  for (const e of entries) {
    const spec = roles.get(e.key)
    if (!spec) continue
    const value = e.value.trim()
    if (!value) {
      problem(e, `ds:${e.key} has no value`)
      continue
    }
    if (spec.role === 'definitions') {
      const names = split(value)
      const bad = names.filter((n) => !CUSTOM_PROPERTY.test(n))
      if (bad.length > 0) problem(e, `ds:${e.key} takes custom property names, comma separated; "${bad.join(', ')}" is not one`)
      out.definitions.push(...names.filter((n) => !bad.includes(n)))
    } else if (spec.role === 'list') {
      const items = split(value)
      for (const item of items) {
        if (spec.under && !exists(`${spec.under}/${item}`)) problem(e, `ds:${e.key} names "${item}", which is not a file in ${spec.under}`)
        else (out.lists[e.key] ??= []).push(item)
      }
    } else if (spec.role === 'scope') {
      if (e.key in out.scopes) problem(e, `ds:${e.key} is declared a second time; keep one`)
      else if (/\s/.test(value)) problem(e, `ds:${e.key} takes one value, not "${value}"`)
      else if (spec.values && !spec.values.includes(value)) problem(e, `ds:${e.key} is one of ${spec.values.join(', ')}, not "${value}"`)
      else out.scopes[e.key] = value
    } else if (spec.role === 'breakpoint') {
      const [width, ...reason] = value.split(/\s+/)
      const m = WIDTH.exec(width)
      if (!m || reason.length === 0) problem(e, `ds:${e.key} takes a width and a reason, as "22.5rem the bar folds its sections"`)
      else out.breakpoints.push({ width: `${Number.parseFloat(m[1])}${m[2]}`, reason: reason.join(' ') })
    }
  }
  return out
}

// A group's tier: the part before the first slash.
export const tierOf = (group) => (group ? group.split('/')[0].trim() : null)

// A file's place: its declared `ds:group`; else, when it carries the parked
// marker, the parked group; else the first taxonomy rule whose files match.
// Returns { group, tier, derived, parked }.
export function placeFile(file, source, declared, taxonomy) {
  const parkedSpec = taxonomy?.parked
  const parked = Boolean(parkedSpec?.marker && source.includes(parkedSpec.marker))
  let group = declared?.trim() || null
  let derived = false
  if (!group && parked && parkedSpec.group) {
    group = parkedSpec.group
    derived = true
  }
  if (!group) {
    for (const rule of taxonomy?.rules ?? []) {
      if (compileGlobs([].concat(rule.files ?? []))(file)) {
        group = rule.group
        derived = true
        break
      }
    }
  }
  return { group, tier: tierOf(group), derived, parked }
}

// The tier order: the taxonomy's when it has one, else massimo's default.
export const DEFAULT_TIERS = ['Foundations', 'Primitives', 'Patterns', 'Shells', 'Pages', 'Explorations']
export const tierOrder = (config) => (Array.isArray(config?.graph?.taxonomy?.tiers) && config.graph.taxonomy.tiers.length > 0 ? config.graph.taxonomy.tiers : DEFAULT_TIERS)

// The roots a story title may start with. A csf lane's `stories.policy.roots`
// names them when they differ from the node tiers; with none set they are
// the tier order.
export const storyRoots = (config) => {
  const roots = config?.stories?.policy?.roots
  return Array.isArray(roots) && roots.length > 0 ? roots : tierOrder(config)
}
