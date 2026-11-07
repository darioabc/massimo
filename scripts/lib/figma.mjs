// The Figma mirror, compared as data. `figma-variables.json` says what code
// wants in Figma; an export (what skills/figma/read-library.js returns from
// the file through the Plugin API) says what Figma holds; `mirror.json`
// remembers what was mirrored at the last sync. Recording checks the export
// against code and remembers it; drift compares all three, so a change is put
// down to code or to Figma.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Colours differ when a channel moves by more than half an 8-bit step; numbers
// by more than a thousandth (Figma stores floats).
export function sameValue(a, b) {
  if (isObject(a) && isObject(b) && 'alias' in a) return a.alias === b.alias && (a.collection ?? null) === (b.collection ?? null)
  if (isObject(a) && isObject(b) && 'r' in a) return ['r', 'g', 'b', 'a'].every((k) => Math.abs((a[k] ?? 1) - (b[k] ?? 1)) <= 1 / 510)
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 0.001
  return a === b
}

const show = (v) => (isObject(v) && 'alias' in v ? `{${v.alias}}` : isObject(v) && 'r' in v ? `rgba(${['r', 'g', 'b'].map((k) => Math.round(v[k] * 255)).join(', ')}, ${Number((v.a ?? 1).toFixed(3))})` : JSON.stringify(v))

// The custom property a code syntax names: `var(--c-ground)` or `--c-ground`.
export const cssVarOf = (syntax) => /^(?:var\(\s*)?(--[\w-]+)\s*\)?$/.exec(String(syntax ?? '').trim())?.[1] ?? null

// A Figma variable's key: its collection and name, since a file may hold
// one name in two collections.
const keyOf = (collection, name) => `${collection}\u0000${name}`
const keyOfVar = (h) => keyOf(h.collection, h.name)

// Variables as { name, collection, type, values, id, web, modes }, where `web`
// is the CSS variable its code syntax names. Code's are keyed by name (its
// names are unique); Figma's by collection and name.
function variables(doc, keyed = false) {
  const out = new Map()
  for (const c of doc?.collections ?? []) {
    for (const v of c.variables ?? []) {
      const k = keyed ? keyOf(c.name, v.name) : v.name
      if (!out.has(k)) out.set(k, { name: v.name, collection: c.name, type: v.type, values: v.values ?? {}, id: v.id ?? null, web: cssVarOf(v.codeSyntax?.WEB), modes: c.modes ?? Object.keys(v.values ?? {}) })
    }
  }
  return out
}

// Lookups into Figma's variables: by key, by name when the collection is
// unknown, and by id.
function figmaIndex(have) {
  const byId = new Map([...have.values()].filter((h) => h.id).map((h) => [h.id, h]))
  const named = (name) => [...have.values()].filter((h) => h.name === name)
  const find = (name, collection) => have.get(keyOf(collection, name)) ?? named(name)[0] ?? null
  return { byId, named, find }
}

const differences = (a, b, modes, same = sameValue) => modes.filter((m) => m in a || m in b).filter((m) => !(m in a && m in b && same(a[m], b[m], m)))

// A value with its references followed to the end, in one mode, through
// `find(name, collection)`. A target with fewer modes (a ramp's one) gives
// its first mode's value.
function valueIn(find, value, mode, depth = 0) {
  if (!(isObject(value) && 'alias' in value) || depth > 8) return value
  const target = find(value.alias, value.collection)
  if (!target) return value
  return valueIn(find, target.values[mode] ?? target.values[target.modes[0]], mode, depth + 1)
}

// Code's variables paired with Figma's: by the id the mirror recorded (a
// variable renamed in Figma; only for the same file and the same type), by
// name (in code's collection first), then by the CSS variable its code
// syntax names (a library made by hand before massimo). Where several Figma
// variables could pair, the first fitting one is paired and the rest are
// noted. Returns { pairs: Map(code name -> { h, match }), notes }.
export function pairVariables(want, have, mirror = {}, { fileKey } = {}) {
  const pairs = new Map()
  const used = new Set()
  const notes = []
  const { byId, named } = figmaIndex(have)
  const free = (h) => h && !used.has(keyOfVar(h))
  const take = (name, h, match) => {
    pairs.set(name, { h, match })
    used.add(keyOfVar(h))
  }
  // Ids are local to a file: a mirror recorded from another file says nothing.
  const sameFile = !fileKey || !mirror?.fileKey || fileKey === mirror.fileKey
  // A pair made by code syntax stays one on later records, so its values are
  // still compared resolved.
  if (sameFile) {
    for (const [name, w] of want) {
      const prior = mirror?.variables?.[name]
      const h = byId.get(prior?.id)
      if (free(h) && h.type === w.type) take(name, h, h.name === name && !prior.figmaName ? 'name' : prior.match === 'code' ? 'code' : 'id')
    }
  }
  for (const [name, w] of want) {
    if (pairs.has(name)) continue
    const found = named(name).filter(free)
    if (found.length === 0) continue
    const h = found.find((x) => x.collection === w.collection) ?? found[0]
    take(name, h, 'name')
    if (found.length > 1 && h.collection !== w.collection) notes.push(`${name} is in ${found.map((x) => x.collection).join(' and ')} in Figma; the one in ${h.collection} was paired`)
  }
  for (const [name, w] of want) {
    if (pairs.has(name) || !w.web) continue
    const found = [...have.values()].filter((h) => h.web === w.web && free(h))
    if (found.length === 0) continue
    const bare = w.web.slice(2)
    const exact = found.filter((x) => x.name === bare)
    const tail = found.filter((x) => x.name.split('/').pop() === bare)
    const h = exact[0] ?? (tail.length === 1 ? tail[0] : null) ?? (found.length === 1 ? found[0] : null)
    if (!h) {
      notes.push(`${found.map((x) => `${x.name} (${x.collection})`).join(', ')} all name ${w.web} in their code syntax, so none was paired with ${name}`)
      continue
    }
    take(name, h, 'code')
    for (const x of found) if (x !== h) notes.push(`${x.name} (${x.collection}) also names ${w.web} in its code syntax; ${h.name} (${h.collection}) was paired with ${name}`)
  }
  return { pairs, notes }
}

// A Figma value in code's terms: a reference to a paired variable names the
// code variable it is paired with, so a rename or a hand-made name in Figma
// is not a difference.
function inCodeTerms(pairs, want) {
  const codeOf = new Map([...pairs].map(([name, { h }]) => [keyOfVar(h), { alias: name, collection: want.get(name)?.collection }]))
  return (v) => (isObject(v) && 'alias' in v ? codeOf.get(keyOf(v.collection, v.alias)) ?? v : v)
}

// Check an export against what code wants and remember it as mirror.json.
// Returns { mirror, mismatches, notes }. When every collection in the file has
// one mode and code has several, the file is on a plan that allows one mode
// (Starter): only the default mode is compared, and the mirror says so. A
// one-mode collection in a file that has a two-mode one is just missing modes.
export function recordMirror(wanted, exported, { fileKey, tokensHash, date, previous = {} } = {}) {
  const want = variables(wanted)
  const have = variables(exported, true)
  const { find } = figmaIndex(have)
  const { pairs, notes } = pairVariables(want, have, previous, { fileKey })
  const codeTerms = inCodeTerms(pairs, want)
  const inCode = (n) => want.get(n)
  const mismatches = []
  const defaultMode = wanted.defaultMode ?? 'Light'
  const oneModeFile = (exported?.collections ?? []).every((c) => (c.modes ?? []).length <= 1)
  let defaultOnly = false
  const recorded = {}
  for (const [name, w] of want) {
    const pair = pairs.get(name)
    if (!pair) {
      mismatches.push(`variable ${name} is not in Figma`)
      continue
    }
    const { h, match } = pair
    // A variable paired by its code syntax was made by hand: its own name,
    // collection and references stand, and its values are compared resolved.
    const byCode = match === 'code'
    if (byCode) notes.push(`variable ${name} is ${h.name} in Figma (${h.collection}), paired by its code syntax ${w.web}`)
    else if (match === 'id') notes.push(`variable ${name} is ${h.name} in Figma, paired by the id recorded last time`)
    if (!byCode && h.collection !== w.collection) mismatches.push(`variable ${name} is in ${h.collection}, not ${w.collection}`)
    if (h.type !== w.type) mismatches.push(`variable ${name} is ${h.type}, not ${w.type}`)
    let modes = Object.keys(w.values)
    if (oneModeFile && modes.length > 1) {
      defaultOnly = true
      modes = [defaultMode]
    }
    const same = byCode ? (a, b, m) => sameValue(valueIn(inCode, a, m), valueIn(find, b, m)) : (a, b) => sameValue(a, codeTerms(b))
    for (const m of differences(w.values, h.values, modes, same)) {
      const figmaShown = m in h.values ? show(byCode ? valueIn(find, h.values[m], m) : h.values[m]) : 'missing'
      mismatches.push(`variable ${name} (${m}) is ${figmaShown} in Figma, ${show(byCode ? valueIn(inCode, w.values[m], m) : w.values[m])} in code`)
    }
    recorded[name] = { id: h.id, collection: w.collection, values: Object.fromEntries(modes.map((m) => [m, w.values[m]])) }
    if (match !== 'name') Object.assign(recorded[name], { figmaName: h.name, match })
    if (byCode) {
      const held = modes.filter((m) => m in h.values)
      recorded[name].figmaCollection = h.collection
      recorded[name].figmaValues = Object.fromEntries(held.map((m) => [m, h.values[m]]))
      recorded[name].figmaResolved = Object.fromEntries(held.map((m) => [m, valueIn(find, h.values[m], m)]))
    }
  }
  const styles = (kind) => {
    const found = new Map((exported?.[kind] ?? []).map((s) => [s.name, s.id ?? null]))
    const out = {}
    for (const s of wanted?.[kind] ?? []) {
      if (!found.has(s.name)) mismatches.push(`${kind === 'textStyles' ? 'text' : 'effect'} style ${s.name} is not in Figma`)
      else out[s.name] = found.get(s.name)
    }
    return out
  }
  const mirror = {
    fileKey: fileKey ?? previous.fileKey ?? null,
    syncedAt: date,
    tokensHash,
    modes: defaultOnly ? 'default only' : 'all',
    variables: recorded,
    textStyles: styles('textStyles'),
    effectStyles: styles('effectStyles'),
    components: previous.components ?? {},
  }
  return { mirror, mismatches, notes }
}

// What changed since the mirror was recorded, on each side, as Markdown.
export function driftReport(wanted, mirror, exported, { date } = {}) {
  const want = variables(wanted)
  const have = variables(exported, true)
  const { byId, find, named } = figmaIndex(have)
  const was = new Map(Object.entries(mirror?.variables ?? {}))
  const defaultMode = wanted.defaultMode ?? 'Light'
  const sections = { code: [], figma: [], both: [], onlyFigma: [], onlyCode: [] }
  const modesOf = (name) => (mirror?.modes === 'default only' ? [defaultMode] : [...new Set([...Object.keys(want.get(name)?.values ?? {}), ...Object.keys(was.get(name)?.values ?? {})])])
  // Figma's side of each code variable: paired as record pairs them, or, for
  // one gone from code, by the id or Figma name the mirror kept, unless that
  // Figma variable is now paired with another code variable.
  const { pairs } = pairVariables(want, have, mirror)
  const codeTerms = inCodeTerms(pairs, want)
  const inCode = (n) => want.get(n)
  const pairedTo = new Map([...pairs].map(([name, { h }]) => [keyOfVar(h), name]))
  const figmaFor = (name) => {
    if (pairs.has(name)) return { ...pairs.get(name), elsewhere: null }
    const m = was.get(name)
    const h = byId.get(m?.id) ?? (m?.figmaCollection ? find(m.figmaName, m.figmaCollection) : named(m?.figmaName ?? name)[0]) ?? null
    if (!h) return { h: null, match: null, elsewhere: null }
    const other = pairedTo.get(keyOfVar(h))
    return other && other !== name ? { h: null, match: null, elsewhere: other } : { h, match: m?.match ?? 'name', elsewhere: null }
  }
  const matched = new Set()
  for (const name of new Set([...want.keys(), ...was.keys()])) {
    const w = want.get(name)
    const { h, match, elsewhere } = figmaFor(name)
    const m = was.get(name)
    if (h) matched.add(keyOfVar(h))
    const label = h && h.name !== name ? `\`${name}\` (\`${h.name}\` in Figma)` : `\`${name}\``
    if (!m) {
      if (w && !h) sections.onlyCode.push(`${label}: new in code, not mirrored yet`)
      else if (w && h) sections.code.push(`${label}: new in code and already in Figma; record the mirror again`)
      continue
    }
    if (elsewhere) {
      sections.code.push(`${label}: ${w ? '' : 'removed from code; '}its Figma variable is now paired with \`${elsewhere}\`; record the mirror again`)
      continue
    }
    if (!w) sections.code.push(`${label}: removed from code${h ? '; still in Figma' : ''}`)
    if (!h) sections.figma.push(`${label}: deleted in Figma`)
    if (!w || !h) continue
    const modes = modesOf(name)
    // A variable made by hand is compared resolved, with what Figma resolved
    // to when recorded; one massimo made, in code's terms.
    const byCode = match === 'code'
    // A mode Figma lacked when recorded is undefined then; filled later with
    // code's value, it is Figma catching up, not a change.
    const codeThen = (mode) => (byCode ? valueIn(inCode, m.values[mode], mode) : m.values[mode])
    const figmaThen = (mode) => (byCode ? (m.figmaResolved ? m.figmaResolved[mode] : codeThen(mode)) : m.values[mode])
    const figmaNow = (mode) => (byCode ? valueIn(find, h.values[mode], mode) : codeTerms(h.values[mode]))
    const changedInCode = differences(w.values, m.values, modes)
    const changedInFigma = modes.filter((mode) => {
      const then = figmaThen(mode)
      const has = mode in h.values
      if (then === undefined) return has && !sameValue(figmaNow(mode), codeThen(mode))
      return !has || !sameValue(figmaNow(mode), then)
    })
    for (const mode of new Set([...changedInCode, ...changedInFigma])) {
      const now = mode in h.values ? show(figmaNow(mode)) : 'missing'
      const then = figmaThen(mode) === undefined ? 'missing' : show(figmaThen(mode))
      if (changedInCode.includes(mode) && changedInFigma.includes(mode)) sections.both.push(`${label} (${mode}): mirrored ${show(m.values[mode])}, now ${show(w.values[mode])} in code and ${now} in Figma`)
      else if (changedInCode.includes(mode)) sections.code.push(`${label} (${mode}): mirrored ${show(m.values[mode])}, now ${show(w.values[mode])} in code`)
      else sections.figma.push(`${label} (${mode}): mirrored ${then}, now ${now} in Figma`)
    }
  }
  for (const h of have.values()) if (!matched.has(keyOfVar(h))) sections.onlyFigma.push(`\`${h.name}\`: made in Figma, not in code`)
  for (const kind of ['textStyles', 'effectStyles']) {
    const label = kind === 'textStyles' ? 'text style' : 'effect style'
    const wanted_ = new Set((wanted?.[kind] ?? []).map((s) => s.name))
    const there = new Set((exported?.[kind] ?? []).map((s) => s.name))
    const mirrored = new Set(Object.keys(mirror?.[kind] ?? {}))
    for (const n of wanted_) if (!there.has(n)) (mirrored.has(n) ? sections.figma : sections.onlyCode).push(`${label} \`${n}\`: ${mirrored.has(n) ? 'deleted in Figma' : 'new in code, not mirrored yet'}`)
    for (const n of there) if (!wanted_.has(n)) (mirrored.has(n) ? sections.code : sections.onlyFigma).push(`${label} \`${n}\`: ${mirrored.has(n) ? 'removed from code; still in Figma' : 'made in Figma, not in code'}`)
  }
  const total = Object.values(sections).reduce((n, list) => n + list.length, 0)
  const lines = ['# Figma drift', '', `${date ?? ''} · compared with the mirror recorded on ${mirror?.syncedAt ?? 'an unknown date'}${mirror?.modes === 'default only' ? ', default mode only (the file allows one mode per collection)' : ''}.`, '']
  if (total === 0) lines.push('Figma matches code. Nothing to do.')
  const section = (title, why, list) => {
    if (list.length === 0) return
    lines.push(`## ${title}`, '', why, '', ...list.map((l) => `- ${l}`), '')
  }
  section('Code changed', 'Figma is behind: mirror these again.', sections.code)
  section('Figma changed', 'A designer edited the library: for each, adopt it in code or revert Figma.', sections.figma)
  section('Changed on both sides', 'Code and Figma both moved: decide which one stands.', sections.both)
  section('Only in Figma', 'Made in Figma and never in code: adopt it in code or remove it.', sections.onlyFigma)
  section('Only in code', 'Not mirrored yet: mirror them next time.', sections.onlyCode)
  return { markdown: `${lines.join('\n').trimEnd()}\n`, total, sections }
}
