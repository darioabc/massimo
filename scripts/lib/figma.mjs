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

// Variables by name: { collection, type, values, id }.
function variables(doc) {
  const out = new Map()
  for (const c of doc?.collections ?? []) {
    for (const v of c.variables ?? []) out.set(v.name, { collection: c.name, type: v.type, values: v.values ?? {}, id: v.id ?? null, modes: c.modes ?? Object.keys(v.values ?? {}) })
  }
  return out
}

const differences = (a, b, modes) => modes.filter((m) => m in a || m in b).filter((m) => !(m in a && m in b && sameValue(a[m], b[m])))

// Check an export against what code wants and remember it as mirror.json.
// Returns { mirror, mismatches }. When every collection in the file has one
// mode and code has several, the file is on a plan that allows one mode
// (Starter): only the default mode is compared, and the mirror says so. A
// one-mode collection in a file that has a two-mode one is just missing modes.
export function recordMirror(wanted, exported, { fileKey, tokensHash, date, previous = {} } = {}) {
  const want = variables(wanted)
  const have = variables(exported)
  const mismatches = []
  const defaultMode = wanted.defaultMode ?? 'Light'
  const oneModeFile = (exported?.collections ?? []).every((c) => (c.modes ?? []).length <= 1)
  let defaultOnly = false
  const recorded = {}
  for (const [name, w] of want) {
    const h = have.get(name)
    if (!h) {
      mismatches.push(`variable ${name} is not in Figma`)
      continue
    }
    if (h.collection !== w.collection) mismatches.push(`variable ${name} is in ${h.collection}, not ${w.collection}`)
    if (h.type !== w.type) mismatches.push(`variable ${name} is ${h.type}, not ${w.type}`)
    let modes = Object.keys(w.values)
    if (oneModeFile && modes.length > 1) {
      defaultOnly = true
      modes = [defaultMode]
    }
    for (const m of differences(w.values, h.values, modes)) {
      mismatches.push(`variable ${name} (${m}) is ${m in h.values ? show(h.values[m]) : 'missing'} in Figma, ${show(w.values[m])} in code`)
    }
    recorded[name] = { id: h.id, collection: w.collection, values: Object.fromEntries(modes.map((m) => [m, w.values[m]])) }
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
  return { mirror, mismatches }
}

// What changed since the mirror was recorded, on each side, as Markdown.
export function driftReport(wanted, mirror, exported, { date } = {}) {
  const want = variables(wanted)
  const have = variables(exported)
  const was = new Map(Object.entries(mirror?.variables ?? {}))
  const defaultMode = wanted.defaultMode ?? 'Light'
  const sections = { code: [], figma: [], both: [], onlyFigma: [], onlyCode: [] }
  const modesOf = (name) => (mirror?.modes === 'default only' ? [defaultMode] : [...new Set([...Object.keys(want.get(name)?.values ?? {}), ...Object.keys(was.get(name)?.values ?? {})])])
  for (const name of new Set([...want.keys(), ...have.keys(), ...was.keys()])) {
    const w = want.get(name)
    const h = have.get(name)
    const m = was.get(name)
    if (!m) {
      if (w && !h) sections.onlyCode.push(`\`${name}\`: new in code, not mirrored yet`)
      else if (h && !w) sections.onlyFigma.push(`\`${name}\`: made in Figma, not in code`)
      else if (w && h) sections.code.push(`\`${name}\`: new in code and already in Figma; record the mirror again`)
      continue
    }
    if (!w) sections.code.push(`\`${name}\`: removed from code${h ? '; still in Figma' : ''}`)
    if (!h) sections.figma.push(`\`${name}\`: deleted in Figma`)
    if (!w || !h) continue
    const modes = modesOf(name)
    const inCode = differences(w.values, m.values, modes)
    const inFigma = differences(h.values, m.values, modes)
    for (const mode of new Set([...inCode, ...inFigma])) {
      const line = `\`${name}\` (${mode}): mirrored ${show(m.values[mode])}`
      if (inCode.includes(mode) && inFigma.includes(mode)) sections.both.push(`${line}, now ${show(w.values[mode])} in code and ${show(h.values[mode])} in Figma`)
      else if (inCode.includes(mode)) sections.code.push(`${line}, now ${show(w.values[mode])} in code`)
      else sections.figma.push(`${line}, now ${show(h.values[mode])} in Figma`)
    }
  }
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
