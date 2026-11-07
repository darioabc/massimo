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

// Variables by name: { name, collection, type, values, id, web, modes }, where
// `web` is the CSS variable its code syntax names.
function variables(doc) {
  const out = new Map()
  for (const c of doc?.collections ?? []) {
    for (const v of c.variables ?? []) {
      out.set(v.name, { name: v.name, collection: c.name, type: v.type, values: v.values ?? {}, id: v.id ?? null, web: cssVarOf(v.codeSyntax?.WEB), modes: c.modes ?? Object.keys(v.values ?? {}) })
    }
  }
  return out
}

const differences = (a, b, modes, same = sameValue) => modes.filter((m) => m in a || m in b).filter((m) => !(m in a && m in b && same(a[m], b[m], m)))

// A value with its references followed to the end, in one mode. A target
// with fewer modes (a ramp's one) gives its first mode's value.
function valueIn(vars, value, mode, depth = 0) {
  if (!(isObject(value) && 'alias' in value) || depth > 8) return value
  const target = vars.get(value.alias)
  if (!target) return value
  return valueIn(vars, target.values[mode] ?? target.values[target.modes[0]], mode, depth + 1)
}

// Code's variables paired with Figma's: by the id the mirror recorded (a
// variable renamed in Figma), by name, then by the CSS variable its code
// syntax names (a library made by hand before massimo). Where several Figma
// variables name one CSS variable, the one named like it is paired and the
// rest are noted. Returns { pairs: Map(code name -> { h, match }), notes }.
export function pairVariables(want, have, mirror = {}) {
  const pairs = new Map()
  const used = new Set()
  const notes = []
  const byId = new Map([...have.values()].filter((h) => h.id).map((h) => [h.id, h]))
  const take = (name, h, match) => {
    pairs.set(name, { h, match })
    used.add(h.name)
  }
  // A pair made by code syntax stays one on later records, so its values are
  // still compared resolved.
  for (const name of want.keys()) {
    const prior = mirror?.variables?.[name]
    const h = byId.get(prior?.id)
    if (h && !used.has(h.name)) take(name, h, h.name === name ? 'name' : prior.match === 'code' ? 'code' : 'id')
  }
  for (const name of want.keys()) if (!pairs.has(name) && have.has(name) && !used.has(name)) take(name, have.get(name), 'name')
  for (const [name, w] of want) {
    if (pairs.has(name) || !w.web) continue
    const found = [...have.values()].filter((h) => h.web === w.web && !used.has(h.name))
    if (found.length === 0) continue
    const bare = w.web.slice(2)
    const h = found.find((x) => x.name === bare) ?? found.find((x) => x.name.split('/').pop() === bare && found.filter((y) => y.name.split('/').pop() === bare).length === 1) ?? (found.length === 1 ? found[0] : null)
    if (!h) {
      notes.push(`${found.map((x) => x.name).join(', ')} all name ${w.web} in their code syntax, so none was paired with ${name}`)
      continue
    }
    take(name, h, 'code')
    for (const x of found) if (x !== h) notes.push(`${x.name} also names ${w.web} in its code syntax; ${h.name} was paired with ${name}`)
  }
  return { pairs, notes }
}

// Check an export against what code wants and remember it as mirror.json.
// Returns { mirror, mismatches }. When every collection in the file has one
// mode and code has several, the file is on a plan that allows one mode
// (Starter): only the default mode is compared, and the mirror says so. A
// one-mode collection in a file that has a two-mode one is just missing modes.
export function recordMirror(wanted, exported, { fileKey, tokensHash, date, previous = {} } = {}) {
  const want = variables(wanted)
  const have = variables(exported)
  const { pairs, notes } = pairVariables(want, have, previous)
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
    const same = byCode ? (a, b, m) => sameValue(valueIn(want, a, m), valueIn(have, b, m)) : sameValue
    for (const m of differences(w.values, h.values, modes, same)) {
      const shown = byCode ? (v, vars) => show(valueIn(vars, v, m)) : (v) => show(v)
      mismatches.push(`variable ${name} (${m}) is ${m in h.values ? shown(h.values[m], have) : 'missing'} in Figma, ${shown(w.values[m], want)} in code`)
    }
    recorded[name] = { id: h.id, collection: w.collection, values: Object.fromEntries(modes.map((m) => [m, w.values[m]])) }
    if (match !== 'name') Object.assign(recorded[name], { figmaName: h.name, match })
    if (byCode) recorded[name].figmaValues = Object.fromEntries(modes.filter((m) => m in h.values).map((m) => [m, h.values[m]]))
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
  const have = variables(exported)
  const was = new Map(Object.entries(mirror?.variables ?? {}))
  const defaultMode = wanted.defaultMode ?? 'Light'
  const sections = { code: [], figma: [], both: [], onlyFigma: [], onlyCode: [] }
  const modesOf = (name) => (mirror?.modes === 'default only' ? [defaultMode] : [...new Set([...Object.keys(want.get(name)?.values ?? {}), ...Object.keys(was.get(name)?.values ?? {})])])
  // Figma's side of each code variable: paired as record pairs them, or, for
  // one gone from code, by the id or Figma name the mirror kept.
  const { pairs } = pairVariables(want, have, mirror)
  const byId = new Map([...have.values()].filter((h) => h.id).map((h) => [h.id, h]))
  const figmaFor = (name) => pairs.get(name)?.h ?? byId.get(was.get(name)?.id) ?? have.get(was.get(name)?.figmaName ?? name) ?? null
  const matched = new Set()
  for (const name of new Set([...want.keys(), ...was.keys()])) {
    const w = want.get(name)
    const h = figmaFor(name)
    const m = was.get(name)
    if (h) matched.add(h.name)
    const label = h && h.name !== name ? `\`${name}\` (\`${h.name}\` in Figma)` : `\`${name}\``
    if (!m) {
      if (w && !h) sections.onlyCode.push(`${label}: new in code, not mirrored yet`)
      else if (w && h) sections.code.push(`${label}: new in code and already in Figma; record the mirror again`)
      continue
    }
    if (!w) sections.code.push(`${label}: removed from code${h ? '; still in Figma' : ''}`)
    if (!h) sections.figma.push(`${label}: deleted in Figma`)
    if (!w || !h) continue
    const modes = modesOf(name)
    // A variable made by hand is compared with what Figma held when recorded.
    const inFigmaWas = m.figmaValues ?? m.values
    const inCode = differences(w.values, m.values, modes)
    const inFigma = differences(h.values, inFigmaWas, modes)
    for (const mode of new Set([...inCode, ...inFigma])) {
      const line = (was_) => `${label} (${mode}): mirrored ${show(was_[mode])}`
      if (inCode.includes(mode) && inFigma.includes(mode)) sections.both.push(`${line(m.values)}, now ${show(w.values[mode])} in code and ${show(h.values[mode])} in Figma`)
      else if (inCode.includes(mode)) sections.code.push(`${line(m.values)}, now ${show(w.values[mode])} in code`)
      else sections.figma.push(`${line(inFigmaWas)}, now ${show(h.values[mode])} in Figma`)
    }
  }
  for (const h of have.values()) if (!matched.has(h.name)) sections.onlyFigma.push(`\`${h.name}\`: made in Figma, not in code`)
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
