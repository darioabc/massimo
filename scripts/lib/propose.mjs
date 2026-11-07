// A full token set proposed from what a repo already uses. Values come from
// the repo, never from taste: first what its sources define (token files,
// CSS custom properties, a Tailwind config, a theme object, a Figma export),
// then the audit's counts for what the code uses without a token. Where a
// composite needs a part the code never states (a typography step's letter
// spacing), the proposal says it assumed it. Every value records where it
// came from, so a reviewer can approve or change it family by family.
//
// propose({ sources, audit }) returns { tokens, report, outliers, notes }:
// tokens in the readers' shape, a report line per token
// ({ family, token, value, from, note }), values seen too rarely to become a
// token, and plain notes.

import { parseColor, toHex, toOklab } from './color.mjs'
import { compare } from './glob.mjs'
import { isAlias } from './source.mjs'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const key = (path) => path.join('.')

export const FAMILIES = ['color', 'typography', 'spacing', 'radius', 'shadow', 'border', 'motion', 'z-index', 'opacity']

// ── Merging what the sources define ────────────────────────────────────────

// Sources in order of trust: a token file first, then CSS, then config and
// theme code, then a Figma export. A path a later source repeats is dropped
// with a note; `var(--x)` becomes a reference to the token that sets --x.
export function mergeSources(sources) {
  const order = ['tokens', 'css', 'tailwind', 'theme', 'figma']
  const tokens = []
  const notes = []
  const seen = new Map()
  for (const kind of order) {
    for (const src of sources.filter((s) => s.kind === kind)) {
      for (const t of src.tokens) {
        const k = key(t.path)
        if (seen.has(k)) {
          if (JSON.stringify(seen.get(k).value) !== JSON.stringify(t.value)) notes.push(`${k} is in ${seen.get(k).source} and ${t.source}; kept the one from ${seen.get(k).source}`)
          continue
        }
        const copy = { ...t, modes: { ...t.modes } }
        seen.set(k, copy)
        tokens.push(copy)
      }
      notes.push(...(src.notes ?? []))
    }
  }
  const byVar = new Map(tokens.filter((t) => t.cssVar).map((t) => [t.cssVar, t]))
  const resolveVar = (v) => {
    const m = typeof v === 'string' && /^var\(\s*(--[\w-]+)\s*\)$/.exec(v.trim())
    const target = m && byVar.get(m[1])
    return target ? `{${key(target.path)}}` : v
  }
  for (const t of tokens) {
    t.value = resolveVar(t.value)
    for (const [m, v] of Object.entries(t.modes)) t.modes[m] = resolveVar(v)
  }
  // A source that gave no type: read one from the value (the draft's report
  // says so, and the user checks it); a reference takes its target's.
  for (const t of tokens) if (!t.type && !isAlias(t.value)) t.type = guessType(t)
  const byKey = new Map(tokens.map((t) => [key(t.path), t]))
  for (const t of tokens) {
    for (let hop = 0, cur = t; !t.type && hop < 8 && isAlias(cur.value); hop++) {
      cur = byKey.get(cur.value.slice(1, -1))
      if (!cur) break
      if (cur.type) t.type = cur.type
    }
  }
  return { tokens, notes }
}

// What a value with no type reads as. Only for sources that give none (CSS,
// theme objects); a DTCG file's types are never guessed.
function guessType(t) {
  const v = String(t.value ?? '').trim()
  if (Array.isArray(t.value)) return t.path[0] === 'font' ? 'fontFamily' : null
  if (parseColor(v)) return 'color'
  if (/^-?\d*\.?\d+(px|rem)$/.test(v) || v === '0') return 'dimension'
  if (/^-?\d*\.?\d+(ms|s)$/.test(v)) return 'duration'
  if (/^cubic-bezier\(/.test(v)) return 'cubicBezier'
  if (['font', 'fonts', 'font-family'].includes(t.path[0]) && !/^\d/.test(v)) return /^\d{3}$/.test(v) ? 'fontWeight' : 'fontFamily'
  if (['shadow', 'shadows', 'elevation'].includes(t.path[0])) return 'shadow'
  return null
}

// Add a note to a token's report row.
function noteOn(report, token, note) {
  const row = report.find((r) => r.token === token)
  if (row) row.note = row.note ? `${row.note}; ${note}` : note
}

// ── Colour: ramps from the clusters, semantics from the roles ──────────────

const oklch = (c) => {
  const { L, a, b } = toOklab(c)
  return { L, C: Math.hypot(a, b), H: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 }
}
// OKLCH hue bands, set where common palettes put their families (blue near 262°, pink near 354°).
const HUES = [[30, 'red'], [70, 'orange'], [105, 'yellow'], [165, 'green'], [220, 'teal'], [275, 'blue'], [310, 'violet'], [360, 'pink']]
const familyOf = (c) => {
  const { C, H } = oklch(c)
  return C < 0.03 ? 'neutral' : HUES.find(([upTo]) => H < upTo)[1]
}
// Ramp steps by OKLCH lightness, the way most scales are named.
const STEPS = [[50, 0.97], [100, 0.94], [200, 0.88], [300, 0.81], [400, 0.71], [500, 0.62], [600, 0.53], [700, 0.45], [800, 0.37], [900, 0.29], [950, 0.2]]

// A name for the job a role does: bg, text, border…
const ROLE_NAMES = { bg: ['bg', 'default', 'subtle', 'muted'], text: ['text', 'default', 'muted', 'subtle'], border: ['border', 'default', 'subtle', 'strong'] }
const ROLE_WORDS = { bg: 'Background', text: 'Text', border: 'Borders and dividers' }

// Drafted descriptions for names a system already uses.
function describeByName(name) {
  const last = name.split('.').filter((p) => p !== '$root').pop()
  const on = /^(.+)-(content|foreground|fg)$/.exec(last) ?? /^on-(.+)$/.exec(last)
  if (on) return `Text and icons on ${on[1] === 'base' ? 'base backgrounds' : on[1]}`
  if (/^(base-100|bg|background|surface|canvas|page)$/.test(last) || /(^|\.)(bg|background|surface)(\.|$)/.test(name)) return 'Background'
  if (/^base-\d+$/.test(last)) return 'Raised or recessed background'
  if (/^(text|fg|foreground|content|base-content|ink)$/.test(last) || /(^|\.)(text|fg|foreground)(\.|$)/.test(name)) return 'Text'
  if (/border|divider|stroke|outline|ring|input/.test(last)) return 'Borders and dividers'
  if (/^(primary|brand)$/.test(last)) return 'Brand colour for primary actions and emphasis'
  if (/^(secondary|accent)$/.test(last)) return `${last[0].toUpperCase()}${last.slice(1)} colour for supporting actions and highlights`
  if (/^(error|danger|destructive)$/.test(last)) return 'Errors and destructive actions'
  if (/^(success|warning|info)$/.test(last)) return `${last[0].toUpperCase()}${last.slice(1)} messages`
  if (/^(muted|neutral)$/.test(last)) return 'Quiet surfaces and secondary text'
  return null
}

// The contrast pair a name implies: `primary-content` sits on `primary`.
function pairByName(t, byLast) {
  const last = t.path.filter((p) => p !== '$root').pop()
  const parentPath = t.path.slice(0, -1)
  // Nested, as Tailwind configs write it: base.content sits on base.100 (or base itself).
  if (/^(content|foreground|fg)$/.test(last) && parentPath.length > 0) {
    for (const guess of ['$root', 'DEFAULT', 'default', '100', 'background', 'bg']) {
      const g = byLast.get(key([...parentPath, guess]))
      if (g) return key(g.path)
    }
  }
  const on = /^(.+)-(content|foreground|fg)$/.exec(last) ?? /^on-(.+)$/.exec(last)
  if (!on) return null
  const sibling = byLast.get(key([...parentPath, on[1]])) ?? byLast.get(key([...parentPath, on[1], '$root']))
  if (sibling) return key(sibling.path)
  // DaisyUI and shadcn pair base-content with base-100, foreground with background.
  for (const guess of [`${on[1]}-100`, 'background', 'base-100']) {
    const g = byLast.get(key([...parentPath, guess]))
    if (g) return key(g.path)
  }
  return null
}

function proposeColors(existing, audit, report, outliers, minCount) {
  const out = []
  const colorTokens = existing.filter((t) => t.type === 'color' || (!t.type && !isAlias(t.value) && parseColor(String(t.value))))
  const literal = colorTokens.map((t) => ({ t, c: parseColor(String(t.value)) })).filter((x) => x.c)
  const near = (c) => literal.find((x) => Math.abs(x.c.a - c.a) < 0.05 && Math.hypot(...Object.values(toOklab(x.c)).map((v, i) => v - Object.values(toOklab(c))[i])) < 0.02)
  // Where each colour is used most, for the descriptions.
  const fileOf = new Map()
  for (const f of audit?.findings ?? []) {
    if (f.kind !== 'color' && !(f.kind === 'arbitrary' && f.sub === 'color')) continue
    const raw = f.kind === 'arbitrary' ? /\[(.*)\]/.exec(f.value)?.[1].replace(/_/g, ' ') : f.value
    const c = parseColor(raw ?? '')
    if (!c) continue
    const hex = toHex(c)
    const m = fileOf.get(hex) ?? new Map()
    m.set(f.file, (m.get(f.file) ?? 0) + 1)
    fileOf.set(hex, m)
  }
  const mostIn = (hex) => [...(fileOf.get(hex) ?? new Map()).entries()].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))[0]?.[0]

  // Primitives: clusters the code uses with no token near them.
  const used = new Map()
  const proposed = []
  for (const cl of audit?.colorClusters ?? []) {
    const c = parseColor(cl.representative)
    if (!c || c.a === 0) continue
    // A colour only ever used inside a shadow belongs to the shadow token.
    const roles = Object.keys(cl.roles ?? {})
    if (roles.length > 0 && roles.every((r) => r === 'shadow')) continue
    const match = near(c)
    if (match) {
      noteOn(report, key(match.t.path), `covers ${cl.representative}, used ${cl.count}× in code`)
      cl.token = key(match.t.path)
      continue
    }
    if (cl.count < minCount) {
      outliers.push({ family: 'color', value: cl.representative, count: cl.count, note: 'used once; use a token instead, or keep it with a reason' })
      continue
    }
    // A translucent colour is an overlay, named by its opacity; a solid one a ramp step.
    const family = c.a < 1 ? 'overlay' : familyOf(c)
    const { L } = oklch(c)
    const taken = used.get(family) ?? new Set()
    const step = family === 'overlay'
      ? String(Math.round(c.a * 100))
      : STEPS.slice().sort((a, b) => Math.abs(a[1] - L) - Math.abs(b[1] - L)).map(([s]) => s).find((s) => !taken.has(s))
    taken.add(step)
    used.set(family, taken)
    const path = ['color', family, String(step)]
    const value = c.a < 1 ? toHex(c) : cl.representative
    proposed.push({ path, cluster: cl })
    out.push({ path, type: 'color', value, modes: {}, description: '', source: 'audit' })
    cl.token = key(path)
    report.push({ family: 'color', token: key(path), value, from: `used ${cl.count}× in code${mostIn(cl.representative) ? `, most in ${mostIn(cl.representative)}` : ''}`, note: cl.members.length > 1 ? `merges ${cl.members.map((m) => m.value).join(', ')}` : '' })
  }

  // Semantics: only when the sources have no semantic layer of their own.
  const all = [...existing, ...out]
  const byLast = new Map(all.map((t) => [key(t.path), t]))
  const hasSemantics = existing.some((t) => (t.type === 'color' || isAlias(t.value)) && describeByName(key(t.path)))
  if (hasSemantics) {
    for (const t of existing) {
      if (t.type !== 'color' && !(isAlias(t.value) && t.type === 'color')) continue
      const d = describeByName(key(t.path))
      if (d && !t.description) {
        t.description = d
        noteOn(report, key(t.path), `description drafted from its name: "${d}"; check it`)
      }
      const on = pairByName(t, byLast)
      if (on && !t.contrast) {
        t.contrast = { on, use: 'text' }
        noteOn(report, key(t.path), `contrast checked as text on ${on}`)
      }
    }
  } else {
    const byRole = { bg: [], text: [], border: [] }
    for (const cl of audit?.colorClusters ?? []) {
      if (!cl.token) continue
      for (const [role, n] of Object.entries(cl.roles ?? {})) if (byRole[role]) byRole[role].push({ cl, n })
    }
    const semantic = {}
    const isNeutral = (cl) => familyOf(parseColor(cl.representative)) === 'neutral'
    for (const [role, all] of Object.entries(byRole)) {
      const [group, ...names] = ROLE_NAMES[role]
      // Pages, text and borders are mostly neutral; a coloured background is usually the accent.
      const list = all.filter(({ n }) => n >= minCount).sort((a, b) => Number(isNeutral(b.cl)) - Number(isNeutral(a.cl)) || b.n - a.n || compare(a.cl.representative, b.cl.representative))
      if (role === 'bg') {
        const accent = list.find(({ cl }) => !isNeutral(cl))
        if (accent && list.some(({ cl }) => isNeutral(cl))) {
          list.splice(list.indexOf(accent), 1)
          const where = mostIn(accent.cl.representative)
          const path = ['color', 'accent', 'default']
          out.push({ path, type: 'color', value: `{${accent.cl.token}}`, modes: {}, description: `Accent, for primary actions and highlights. Used ${accent.n}× as a background${where ? `, most in ${where}` : ''}.`, source: 'audit' })
          report.push({ family: 'color', token: key(path), value: `{${accent.cl.token}}`, from: `the most used coloured background, ${accent.n}× in code`, note: 'description drafted from usage; check it' })
        }
      }
      const picked = []
      for (const { cl, n } of list) {
        if (picked.some((p) => p.cl.token === cl.token) || picked.length >= names.length) continue
        const name = names[picked.length]
        const path = ['color', group, name]
        const where = mostIn(cl.representative)
        const description = `${ROLE_WORDS[role]}${name === 'default' ? '' : `, ${name}`}. Used ${n}× as ${role === 'bg' ? 'a background' : role === 'text' ? 'text' : 'a border'}${where ? `, most in ${where}` : ''}.`
        picked.push({ cl, path })
        out.push({ path, type: 'color', value: `{${cl.token}}`, modes: {}, description, source: 'audit' })
        report.push({ family: 'color', token: key(path), value: `{${cl.token}}`, from: `${ROLE_WORDS[role].toLowerCase()} role, ${n}× in code`, note: 'description drafted from usage; check it' })
      }
      semantic[role] = picked
    }
    const bg = semantic.bg?.[0]
    if (bg) {
      for (const { path } of semantic.text ?? []) {
        const t = out.find((x) => key(x.path) === key(path))
        t.contrast = { on: key(bg.path), use: 'text' }
      }
      // Borders are not paired: WCAG 1.4.11 asks 3:1 only of a border that
      // identifies a control, and most dividers are decorative.
      for (const { path } of semantic.border ?? []) {
        noteOn(report, key(path), `contrast not checked; if this border identifies a control, pair it with { "on": "${key(bg.path)}", "use": "ui" }`)
      }
    }
  }
  return out
}

// ── Scales: spacing, radius, type ──────────────────────────────────────────

const rem = (px) => `${Number((px / 16).toFixed(4))}rem`
const pxOf = (text) => {
  const m = /^(-?\d*\.?\d+)(px|rem)$/.exec(String(text).trim())
  return m ? Number(m[1]) * (m[2] === 'rem' ? 16 : 1) : null
}
const existingPx = (tokens, groups) => new Set(tokens.filter((t) => groups.includes(t.path[0])).map((t) => pxOf(t.value)).filter((n) => n !== null))

function proposeSpacing(existing, audit, report, outliers, minCount) {
  const histogram = audit?.spacing?.histogram ?? []
  const have = existingPx(existing, ['spacing', 'space'])
  const weighted = histogram.reduce((n, s) => n + s.count, 0)
  const on = (base) => histogram.filter((s) => s.px % base === 0).reduce((n, s) => n + s.count, 0)
  const base = weighted === 0 ? 4 : on(4) / weighted >= 0.7 ? 4 : on(2) / weighted >= 0.7 ? 2 : 1
  const out = []
  for (const s of histogram) {
    if (s.px === 0 || have.has(s.px)) continue
    if (s.count < minCount || s.px % base !== 0) {
      outliers.push({ family: 'spacing', value: `${s.px}px`, count: s.count, note: s.px % base !== 0 ? `off the ${base}px grid` : 'used once' })
      continue
    }
    const path = ['spacing', String(s.px / 4).replace('.', '_')]
    out.push({ path, type: 'dimension', value: rem(s.px), modes: {}, description: '', source: 'audit' })
    report.push({ family: 'spacing', token: key(path), value: rem(s.px), from: `${s.px}px used ${s.count}× in code`, note: `on the ${base}px grid` })
  }
  return out
}

function proposeRadius(existing, audit, report, outliers, minCount) {
  const have = existingPx(existing, ['radius', 'radii', 'rounded'])
  const counts = new Map()
  for (const f of audit?.findings ?? []) if (f.category === 'radius' && f.px !== undefined) counts.set(f.px, (counts.get(f.px) ?? 0) + 1)
  const values = [...counts.entries()].filter(([px]) => px > 0 && !have.has(px)).sort((a, b) => a[0] - b[0])
  const names = ['sm', 'md', 'lg', 'xl', '2xl', '3xl']
  const out = []
  let i = 0
  for (const [px, count] of values) {
    if (count < minCount) {
      outliers.push({ family: 'radius', value: `${px}px`, count, note: 'used once' })
      continue
    }
    const name = px >= 999 ? 'full' : names[i++] ?? String(px)
    out.push({ path: ['radius', name], type: 'dimension', value: px >= 999 ? '9999px' : rem(px), modes: {}, description: '', source: 'audit' })
    report.push({ family: 'radius', token: `radius.${name}`, value: px >= 999 ? '9999px' : rem(px), from: `${px}px used ${count}× in code`, note: '' })
  }
  return out
}

const WEIGHT_NAMES = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' }
const WEIGHT_CLASSES = { thin: 100, extralight: 200, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 }
const LEADING_CLASSES = { none: 1, tight: 1.25, snug: 1.375, normal: 1.5, relaxed: 1.625, loose: 2 }
const SIZE_NAMES_UP = ['lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl']
const SIZE_NAMES_DOWN = ['sm', 'xs', '2xs']

const inventoryCounts = (audit, family, read) => {
  const out = new Map()
  for (const { value, count } of audit?.inventory?.[family] ?? []) {
    const v = read(value)
    if (v !== null && v !== undefined) out.set(v, (out.get(v) ?? 0) + count)
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1] || compare(String(a[0]), String(b[0])))
}

function proposeType(existing, audit, typeSteps, report, outliers, minCount) {
  const out = []
  // Families: the sources' first, then the audit's.
  const families = existing.filter((t) => t.type === 'fontFamily')
  if (families.length === 0) {
    const names = { sans: null, serif: null, mono: null }
    for (const { family, count } of audit?.fontFamilies ?? []) {
      const kind = /mono|code|courier|consolas|menlo/i.test(family) ? 'mono' : /serif/i.test(family) && !/sans/i.test(family) ? 'serif' : 'sans'
      if (names[kind] || count < 1) continue
      names[kind] = family
      out.push({ path: ['font', 'family', kind], type: 'fontFamily', value: family, modes: {}, description: '', source: 'audit' })
      report.push({ family: 'typography', token: `font.family.${kind}`, value: family, from: `used ${count}× in code`, note: '' })
    }
  }
  const familyRef = existing.find((t) => t.type === 'fontFamily' && /sans|body|base|default/.test(key(t.path))) ?? families[0] ?? out.find((t) => t.type === 'fontFamily')
  // Weights.
  const weights = inventoryCounts(audit, 'fontWeight', (v) => {
    const c = /^class font-(\w+)$/.exec(v)
    if (c) return WEIGHT_CLASSES[c[1]] ?? null
    if (/^\d{3}$/.test(v)) return Number(v)
    return { normal: 400, bold: 700 }[v] ?? null
  })
  const haveWeights = new Set(existing.filter((t) => t.type === 'fontWeight').map((t) => Number(t.value)))
  for (const [w, count] of weights) {
    if (haveWeights.has(w) || !WEIGHT_NAMES[w]) continue
    const path = ['font', 'weight', WEIGHT_NAMES[w]]
    out.push({ path, type: 'fontWeight', value: String(w), modes: {}, description: '', source: 'audit' })
    report.push({ family: 'typography', token: key(path), value: String(w), from: `used ${count}× in code`, note: '' })
  }
  // Line heights, unitless.
  const leadings = inventoryCounts(audit, 'lineHeight', (v) => {
    const c = /^class leading-(\w+)$/.exec(v)
    if (c) return LEADING_CLASSES[c[1]] ?? null
    return /^\d*\.?\d+$/.test(v) ? Number(v) : null
  })
  // Sizes: the sources' first, then the audit's, named around the body size.
  const haveSizes = existingPx(existing, ['text', 'font-size'])
  const sizes = (audit?.typeSizes ?? []).filter((s) => s.count >= minCount && !haveSizes.has(s.px)).sort((a, b) => a.px - b.px)
  for (const s of (audit?.typeSizes ?? []).filter((s) => s.count < minCount)) outliers.push({ family: 'typography', value: `${s.px}px`, count: s.count, note: 'a font size used once' })
  const body = [...(audit?.typeSizes ?? [])].filter((s) => s.px >= 14 && s.px <= 18).sort((a, b) => b.count - a.count || Math.abs(a.px - 16) - Math.abs(b.px - 16))[0]?.px ?? 16
  const below = sizes.filter((s) => s.px < body).reverse()
  const above = sizes.filter((s) => s.px > body)
  const named = [
    ...below.map((s, i) => [SIZE_NAMES_DOWN[i] ?? `${i + 3}xs`, s]),
    ...sizes.filter((s) => s.px === body).map((s) => ['base', s]),
    ...above.map((s, i) => [SIZE_NAMES_UP[i] ?? `${i + 2}xl`, s]),
  ]
  for (const [name, s] of named) {
    const path = ['font', 'size', name]
    out.push({ path, type: 'dimension', value: rem(s.px), modes: {}, description: '', source: 'audit' })
    report.push({ family: 'typography', token: key(path), value: rem(s.px), from: `${s.px}px used ${s.count}× in code`, note: name === 'base' ? 'the body size' : '' })
  }
  // Composites: exact from a Tailwind config's type steps, otherwise one per
  // size from the most-used parts, with every assumed part said.
  const sizeTokens = [...existing.filter((t) => ['text', 'font-size'].includes(t.path[0]) && pxOf(t.value) !== null), ...out.filter((t) => key(t.path).startsWith('font.size.'))]
  if (sizeTokens.length === 0) return out
  if (!familyRef) {
    report.push({ family: 'typography', token: '(none)', value: '', from: '', note: 'the code sets no font family, so no typography composites were proposed; add font.family.sans first' })
    return out
  }
  const commonLeading = leadings[0]?.[0]
  const bodyWeight = weights.find(([w]) => w <= 500)?.[0] ?? 400
  const headingWeight = weights.find(([w]) => w >= 600)?.[0] ?? bodyWeight
  const ref = (t) => `{${key(t.path)}}`
  const weightRef = (w) => {
    const t = [...existing, ...out].find((x) => x.type === 'fontWeight' && Number(x.value) === w)
    return t ? ref(t) : w
  }
  for (const size of sizeTokens) {
    const px = pxOf(size.value)
    const step = typeSteps.find((s) => key(s.path) === key(size.path))
    const assumed = []
    const lineHeight = (() => {
      if (step?.lineHeight !== undefined) {
        const lh = pxOf(step.lineHeight)
        return lh !== null ? Number((lh / px).toFixed(4)) : Number(step.lineHeight)
      }
      if (commonLeading !== undefined) {
        assumed.push(`line height ${commonLeading}, the most used`)
        return commonLeading
      }
      assumed.push(`line height ${px >= 24 ? 1.2 : 1.5}, as no line height is set in the code`)
      return px >= 24 ? 1.2 : 1.5
    })()
    const weight = step?.fontWeight !== undefined ? Number(step.fontWeight) : px >= 24 ? headingWeight : bodyWeight
    if (step?.fontWeight === undefined) assumed.push(`weight ${weight}, the most used ${px >= 24 ? 'heavy' : 'regular'} weight`)
    const letterSpacing = step?.letterSpacing ?? '0px'
    if (step?.letterSpacing === undefined) assumed.push('no letter spacing')
    const name = size.path.filter((p) => p !== '$root').slice(-1)[0]
    const path = ['typography', name]
    const value = { fontFamily: ref(familyRef), fontSize: ref(size), fontWeight: weightRef(weight), lineHeight, letterSpacing }
    out.push({ path, type: 'typography', value, modes: {}, description: '', source: step ? step.source ?? 'config' : 'audit' })
    report.push({ family: 'typography', token: key(path), value: `${size.value} / ${lineHeight}, weight ${weight}`, from: step ? 'a type step in the config' : 'the size scale', note: assumed.length ? `assumed ${assumed.join(', ')}` : '' })
  }
  return out
}

// ── Shadows, borders, motion, layers, opacity ──────────────────────────────

function proposeRest(existing, audit, colorTokens, report, outliers, minCount, fromCss) {
  const out = []
  const has = (type) => existing.some((t) => t.type === type)
  // Shadows, by blur.
  if (!has('shadow')) {
    const shadows = (audit?.inventory?.shadow ?? []).filter((s) => !s.value.startsWith('class ')).map((s) => ({ ...s, parsed: fromCss('shadow', s.value) })).filter((s) => !s.parsed.error)
    const blurOf = (v) => [].concat(v).reduce((n, l) => Math.max(n, l.blur?.value ?? 0), 0)
    shadows.sort((a, b) => blurOf(a.parsed.value) - blurOf(b.parsed.value))
    const names = ['sm', 'md', 'lg', 'xl']
    const kept = shadows.filter((s) => {
      if (s.count >= minCount) return true
      outliers.push({ family: 'shadow', value: s.value, count: s.count, note: 'used once' })
      return false
    })
    kept.forEach((s, i) => {
      const path = ['shadow', names[i] ?? String(i + 1)]
      out.push({ path, type: 'shadow', value: s.value, modes: {}, description: '', source: 'audit' })
      report.push({ family: 'shadow', token: key(path), value: s.value, from: `used ${s.count}× in code`, note: '' })
    })
    const tw = (audit?.inventory?.shadow ?? []).filter((s) => s.value.startsWith('class '))
    if (tw.length) report.push({ family: 'shadow', token: '(none)', value: tw.map((s) => s.value.slice(6)).join(', '), from: 'Tailwind classes', note: "Tailwind's own shadows; give them tokens if the design should own them" })
  }
  // Borders: the most used shorthands, their colour as a reference where a token matches.
  if (!has('border')) {
    const colorOf = (css) => {
      const c = parseColor(css)
      const hit = c && colorTokens.find((t) => !isAlias(t.value) && parseColor(String(t.value)) && toHex(parseColor(String(t.value))) === toHex(c))
      return hit ? `{${key(hit.path)}}` : css
    }
    const borders = (audit?.inventory?.border ?? []).filter((b) => {
      if (b.value.startsWith('class ')) return false
      if (b.count >= minCount) return true
      outliers.push({ family: 'border', value: b.value, count: b.count, note: 'used once' })
      return false
    }).slice(0, 3)
    borders.forEach((b, i) => {
      const parts = b.value.split(/\s+/)
      const width = parts.find((p) => pxOf(p) !== null)
      const style = parts.find((p) => /^(solid|dashed|dotted|double)$/.test(p)) ?? 'solid'
      const color = parts.filter((p) => p !== width && p !== style).join(' ')
      if (!width || !parseColor(color)) return
      const path = ['border', i === 0 ? 'default' : `alt-${i}`]
      out.push({ path, type: 'border', value: { width, style, color: colorOf(color) }, modes: {}, description: '', source: 'audit' })
      report.push({ family: 'border', token: key(path), value: b.value, from: `used ${b.count}× in code`, note: '' })
    })
  }
  // Motion: durations and easings.
  if (!has('duration')) {
    const ms = inventoryCounts(audit, 'duration', (v) => {
      const c = /^class duration-(\d+)$/.exec(v)
      if (c) return Number(c[1])
      const m = /^(\d*\.?\d+)(ms|s)$/.exec(v)
      return m ? Number(m[1]) * (m[2] === 's' ? 1000 : 1) : null
    }).sort((a, b) => a[0] - b[0])
    const names = ms.length <= 3 ? ['fast', 'normal', 'slow'].slice(ms.length === 1 ? 1 : 0) : []
    ms.forEach(([v, count], i) => {
      const path = ['duration', names[i] ?? String(v)]
      out.push({ path, type: 'duration', value: `${v}ms`, modes: {}, description: '', source: 'audit' })
      report.push({ family: 'motion', token: key(path), value: `${v}ms`, from: `used ${count}× in code`, note: '' })
    })
  }
  if (!has('cubicBezier')) {
    const easings = inventoryCounts(audit, 'easing', (v) => {
      const c = /^class ease-(\w[\w-]*)$/.exec(v)
      if (c) return { linear: 'linear', in: 'ease-in', out: 'ease-out', 'in-out': 'ease-in-out' }[c[1]] ?? null
      return /^steps\(/.test(v) ? null : v
    })
    easings.forEach(([v, count], i) => {
      const name = i === 0 ? 'standard' : { 'ease-in': 'in', 'ease-out': 'out', 'ease-in-out': 'in-out', linear: 'linear', ease: 'ease' }[v] ?? `alt-${i}`
      const path = ['ease', name]
      out.push({ path, type: 'cubicBezier', value: v, modes: {}, description: '', source: 'audit' })
      report.push({ family: 'motion', token: key(path), value: v, from: `used ${count}× in code`, note: i === 0 ? 'the most used easing' : '' })
    })
  }
  // Layers and opacity.
  if (!existing.some((t) => t.path[0] === 'z')) {
    for (const [v, count] of inventoryCounts(audit, 'zIndex', (x) => (/^class -?z-(\d+)$/.exec(x)?.[1] ?? (/^-?\d+$/.test(x) ? x : null)))) {
      if (Number(v) === 0) continue
      out.push({ path: ['z', String(v)], type: 'number', value: String(v), modes: {}, description: '', source: 'audit' })
      report.push({ family: 'z-index', token: `z.${v}`, value: String(v), from: `used ${count}× in code`, note: '' })
    }
  }
  if (!existing.some((t) => t.path[0] === 'opacity')) {
    for (const [v, count] of inventoryCounts(audit, 'opacity', (x) => (/^class opacity-(\d+)$/.exec(x) ? Number(/\d+/.exec(x)[0]) / 100 : /^\d*\.?\d+$/.test(x) ? Number(x) : null))) {
      if (v <= 0 || v >= 1) continue
      if (count < minCount) {
        outliers.push({ family: 'opacity', value: String(v), count, note: 'used once' })
        continue
      }
      const name = String(Math.round(v * 100))
      out.push({ path: ['opacity', name], type: 'number', value: String(v), modes: {}, description: '', source: 'audit' })
      report.push({ family: 'opacity', token: `opacity.${name}`, value: String(v), from: `used ${count}× in code`, note: '' })
    }
  }
  return out
}

// ── The whole proposal ─────────────────────────────────────────────────────

// `fromCss` is dtcg.mjs's converter, passed in so this module stays small.
export function propose({ sources, audit, fromCss, minCount = 2 }) {
  const { tokens: existing, notes } = mergeSources(sources)
  const report = []
  const outliers = []
  for (const t of existing) {
    const family = t.type === 'color' ? 'color' : ['fontFamily', 'fontWeight', 'typography'].includes(t.type) || ['text', 'font', 'leading', 'tracking'].includes(t.path[0]) ? 'typography' : t.path[0] === 'spacing' || t.path[0] === 'space' ? 'spacing' : t.path[0] === 'radius' ? 'radius' : t.type === 'shadow' ? 'shadow' : t.type === 'duration' || t.type === 'cubicBezier' ? 'motion' : 'other'
    report.push({ family, token: key(t.path), value: isObject(t.value) || Array.isArray(t.value) ? JSON.stringify(t.value) : String(t.value), from: t.source, note: '' })
  }
  const colors = proposeColors(existing, audit, report, outliers, minCount)
  const typeSteps = sources.flatMap((s) => s.typeSteps ?? [])
  const out = [
    ...existing,
    ...colors,
    ...proposeType(existing, audit, typeSteps, report, outliers, minCount),
    ...proposeSpacing(existing, audit, report, outliers, minCount),
    ...proposeRadius(existing, audit, report, outliers, minCount),
  ]
  out.push(...proposeRest(existing, audit, out.filter((t) => t.type === 'color'), report, outliers, minCount, fromCss))
  return { tokens: out, report, outliers, notes }
}
