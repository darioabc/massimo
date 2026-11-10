// A full token set proposed from what a repo already uses. Values come from
// the repo, never from taste: first what its sources define (token files,
// CSS custom properties, a Tailwind config, a theme object, a Figma export),
// then the audit's counts for what the code uses without a token. Where a
// composite needs a part the code never states (a typography step's letter
// spacing), the proposal says it assumed it. Every value records where it
// came from, so a reviewer can approve or change it family by family.
//
// propose({ sources, audit, defaultMode }) returns { tokens, report, outliers, notes }:
// tokens in the readers' shape, a report line per token
// ({ family, token, value, from, note }), the values the code uses that did not become a
// token, and plain notes.

import { contrastRatio, parseColor, toHex, toOklab } from './color.mjs'
import { compare } from './glob.mjs'
import { CLASS_LIBRARIES, aliasPath, cssVarFor, isAlias } from './source.mjs'
import { TAILWIND_COLORS, TAILWIND_STEPS } from './tailwind-colors.mjs'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const key = (path) => path.join('.')

// The family each reader group reports under.
const FAMILY_OF_GROUP = { spacing: 'spacing', space: 'spacing', radius: 'radius', shadow: 'shadow', 'border-width': 'border', duration: 'motion', ease: 'motion', z: 'z-index', opacity: 'opacity' }

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
  // Two names for one CSS variable are one token: a Tailwind config's
  // base.100 and a stylesheet's --color-base-100. The first source keeps it,
  // and references to the other name are pointed at it.
  const byCssVar = new Map()
  const renamed = new Map()
  const varOf = (t) => t.cssVar ?? cssVarFor(t.path.filter((p) => p !== '$root'))
  for (const kind of order) {
    for (const src of sources.filter((s) => s.kind === kind)) {
      // A token name cannot hold a dot, so a key such as a spacing step's 0.5
      // is named 0_5; a CSS variable the source gave keeps its name, and a
      // reference to the dotted name follows the token.
      const dotted = new Map()
      for (const read of src.tokens) {
        const t = read.path.some((p) => String(p).includes('.')) ? { ...read, path: read.path.map((p) => String(p).replace(/\./g, '_')) } : read
        if (t !== read) {
          dotted.set(read.source, [...(dotted.get(read.source) ?? []), `${key(read.path)} as ${key(t.path)}`])
          renamed.set(key(read.path), key(t.path))
        }
        const k = key(t.path)
        const same = seen.get(k) ?? byCssVar.get(varOf(t))
        if (same) {
          const kept = key(same.path)
          if (kept !== k) {
            renamed.set(k, kept)
            notes.push(`${k} (${t.source}) and ${kept} (${same.source}) are both ${varOf(t)}; kept ${kept}`)
          } else if (JSON.stringify(same.value) !== JSON.stringify(t.value)) {
            notes.push(`${k} is in ${same.source} and ${t.source}; kept the one from ${same.source}`)
          }
          continue
        }
        const copy = { ...t, modes: { ...t.modes } }
        seen.set(k, copy)
        byCssVar.set(varOf(copy), copy)
        tokens.push(copy)
      }
      notes.push(...(src.notes ?? []))
      for (const [file, names] of dotted) {
        const shown = `${names.slice(0, 6).join(', ')}${names.length > 6 ? `, +${names.length - 6} more` : ''}`
        notes.push(`${file}: a token name cannot hold a dot, so ${names.length === 1 ? 'one name was' : `${names.length} names were`} written with _ instead: ${shown}`)
      }
    }
  }
  // A token whose name another source uses as a group (--c-accent read as
  // color.accent, beside Tailwind's accent.DEFAULT and accent.foreground)
  // takes its own variable's name, or the group's $root, so neither is lost.
  const paths = new Set(tokens.map((t) => key(t.path)))
  const groups = new Set(tokens.flatMap((t) => t.path.slice(0, -1).map((_, i) => key(t.path.slice(0, i + 1)))))
  for (const t of tokens) {
    const k = key(t.path)
    if (!groups.has(k)) continue
    const free = (p) => !paths.has(key(p)) && !groups.has(key(p))
    const next = [t.cssVar ? [t.path[0], t.cssVar.slice(2)] : null, [...t.path, '$root']].find((p) => p && free(p))
    if (!next) continue
    renamed.set(k, key(next))
    notes.push(`${k} (${t.source}) is also a group of other tokens; named it ${key(next)}`)
    paths.delete(k)
    paths.add(key(next))
    t.path = next
  }
  const byVar = new Map(tokens.filter((t) => t.cssVar).map((t) => [t.cssVar, t]))
  const resolveVar = (v) => {
    if (isAlias(v) && renamed.has(aliasPath(v))) return `{${renamed.get(aliasPath(v))}}`
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
  // A bare 0 is a length only where the group is one (DaisyUI's --noise: 0 is a flag).
  if (/^-?\d*\.?\d+(px|rem)$/.test(v) || (v === '0' && ['spacing', 'space', 'radius', 'size', 'border-width', 'text'].includes(t.path[0]))) return 'dimension'
  if (/^-?\d*\.?\d+(ms|s)$/.test(v)) return 'duration'
  if (/^cubic-bezier\(/.test(v)) return 'cubicBezier'
  if (['font', 'fonts', 'font-family'].includes(t.path[0]) && !/^\d/.test(v)) return /^\d{3}$/.test(v) ? 'fontWeight' : 'fontFamily'
  if (['shadow', 'shadows', 'elevation'].includes(t.path[0])) return 'shadow'
  if (t.path[0] === 'font-weight' && /^\d{3}$/.test(v)) return 'fontWeight'
  if (['z', 'opacity', 'leading'].includes(t.path[0]) && /^-?\d*\.?\d+$/.test(v)) return 'number'
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
// The step a lightness falls at between the standard ones, by straight lines
// between them: L 0.66 is about 455. Lighter than 50 runs toward 0, darker
// than 950 toward 1000.
const stepAt = (L) => {
  if (L >= STEPS[0][1]) return 50 * (1 - (L - STEPS[0][1]) / (1 - STEPS[0][1]))
  for (let i = 1; i < STEPS.length; i++) {
    const [s0, l0] = STEPS[i - 1]
    const [s1, l1] = STEPS[i]
    if (L >= l1) return s0 + ((l0 - L) / (l0 - l1)) * (s1 - s0)
  }
  const [s, l] = STEPS[STEPS.length - 1]
  return s + ((l - L) / l) * (1000 - s)
}

// A name for the job a role does: bg, text, border…
const ROLE_NAMES = { bg: ['bg', 'default', 'subtle', 'muted'], text: ['text', 'default', 'muted', 'subtle'], border: ['border', 'default', 'subtle', 'strong'] }
const ROLE_WORDS = { bg: 'Background', text: 'Text', border: 'Borders and dividers' }

// Drafted descriptions for names a system already uses. A numbered step is
// a ramp's, whatever its group is called (surface.900 is a primitive).
function describeByName(name) {
  const last = name.split('.').filter((p) => p !== '$root').pop()
  if (/^\d+$/.test(last)) return null
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
  // on-block-strong is strong text on block: try block-strong, then block,
  // each also as a -bg (pill-solid-content sits on pill-solid-bg).
  const words = on[1].split('-')
  for (let n = words.length; n > 0; n--) {
    const name = words.slice(0, n).join('-')
    for (const guess of [name, `${name}-bg`, `${name}-background`]) {
      const sibling = byLast.get(key([...parentPath, guess])) ?? byLast.get(key([...parentPath, guess, '$root']))
      if (sibling && sibling !== t) return key(sibling.path)
    }
  }
  // DaisyUI and shadcn pair base-content with base-100, foreground with background.
  for (const guess of [`${on[1]}-100`, 'background', 'base-100']) {
    const g = byLast.get(key([...parentPath, guess]))
    if (g) return key(g.path)
  }
  return null
}

// A text colour no name pairs sits on the background of its group: text,
// text-dim and fg-muted on bg (or background), a nested text.muted on the
// bg beside its group. Text on something else (text-on-primary, an inverse
// text) is left to a pair by hand, and disabled text, which needs no
// contrast, is not paired.
const TEXT_NAME = /^(?:text|fg|foreground|ink)(?:-(?!on-)[\w-]+)?$/
function backgroundOfGroup(t, byLast) {
  const parts = t.path.filter((p) => p !== '$root')
  const last = parts[parts.length - 1]
  const textual = TEXT_NAME.test(last) || parts.slice(1, -1).some((p) => /^(?:text|fg|foreground)$/.test(p))
  if (!textual || /inverse|inverted|disabled|(?:^|-)on-/.test(last)) return null
  for (let n = parts.length - 1; n >= 1; n--) {
    for (const name of ['bg', 'background']) {
      for (const tail of [[], ['default'], ['DEFAULT'], ['$root']]) {
        const g = byLast.get(key([...parts.slice(0, n), name, ...tail]))
        if (g && g !== t && g.type === 'color') return key(g.path)
      }
    }
  }
  return null
}

// `tailwind` is the Tailwind version the repo styles with, or null; `page`
// is what the style files' body, html or :root rules paint (readCss's
// page); `unread` says a source left colours unread, which may use any of
// Tailwind's names; `gaps.reason`, when set, says why no semantic colour
// came out.
function proposeColors(existing, audit, report, outliers, minCount, { tailwind = null, page = null, defaultMode = 'light', gaps = {}, unread = false } = {}) {
  const out = []
  const colorTokens = existing.filter((t) => t.type === 'color' || (!t.type && !isAlias(t.value) && parseColor(String(t.value))))
  // A fully transparent token paints nothing, so it covers no colour.
  const literal = colorTokens.map((t) => ({ t, c: parseColor(String(t.value)) })).filter((x) => x.c && x.c.a > 0)
  const distance = (a, b) => Math.hypot(...Object.values(toOklab(a)).map((v, i) => v - Object.values(toOklab(b))[i]))
  // The nearest token within a just-noticeable difference and the same alpha; the first of equals.
  const near = (c) => literal.filter((x) => Math.abs(x.c.a - c.a) < 0.05 && distance(x.c, c) < 0.02).reduce((best, x) => (best && distance(best.c, c) <= distance(x.c, c) ? best : x), null)
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

  // Tailwind's own palette for the version the repo styles with. A step of
  // one of its families is a name Tailwind already gives a colour, which a
  // token wired into Tailwind would recolour, so a colour takes such a name
  // only when it is Tailwind's value there; `paletteNames` finds those
  // names by colour. When the config's own colours went unread, any of
  // those names may be the repo's, so none is taken.
  const palette = tailwind ? TAILWIND_COLORS[tailwind] ?? null : null
  const paletteNames = new Map()
  for (const [family, list] of Object.entries(palette ?? {})) {
    list.forEach((v, i) => {
      const hex = toHex(parseColor(v))
      paletteNames.set(hex, [...(paletteNames.get(hex) ?? []), [family, String(TAILWIND_STEPS[i])]])
    })
  }
  const tailwindStep = (family, step) => Boolean(palette?.[family]) && TAILWIND_STEPS.includes(Number(step))

  // Primitives: clusters the code uses with no token near them, in a group
  // no token already holds (DaisyUI's color.neutral is a token: its greys
  // go in gray), never at a CSS variable a token already has (a Tailwind 4
  // --color-orange-400 is the token color.orange-400, so color.orange.400
  // would take its variable). Only a step's variable can clash: a group
  // writes none of its own, so a Tailwind 3 ramp's DEFAULT (--color-orange)
  // leaves the ramp open to new steps.
  const names = new Set(existing.map((t) => key(t.path)))
  const owned = new Set(existing.map((t) => t.cssVar ?? cssVarFor(t.path.filter((p) => p !== '$root'))))
  const groupFor = (family) => [family, ...(family === 'neutral' ? ['gray'] : []), `${family}-scale`].find((g) => !names.has(`color.${g}`))
  const used = new Map()
  const free = (family, s) => !(used.get(family) ?? new Set()).has(s) && !owned.has(cssVarFor(['color', family, s]))
  // The name a new primitive takes, with a note when Tailwind's palette
  // decided it. A solid colour that is Tailwind's own takes Tailwind's name.
  // A translucent colour is an overlay, named by its base and opacity
  // (black-12, white-6, blue-20); a solid one a ramp step by lightness. When
  // the nearest standard step is taken, or is Tailwind's for another
  // colour, the step between that its lightness gives (85, 435…) keeps the
  // ramp in order; a repeated name gets a suffix.
  const nameFor = (c) => {
    if (c.a >= 1 && !unread) {
      const hue = familyOf(c)
      const own = (paletteNames.get(toHex(c)) ?? []).slice().sort((x, y) => Number(y[0] === hue) - Number(x[0] === hue))
      const exact = own.find(([family, s]) => !names.has(`color.${family}`) && free(family, s))
      if (exact) return { family: exact[0], step: exact[1], note: `Tailwind's ${exact[0]}-${exact[1]}` }
    }
    const family = groupFor(c.a < 1 ? 'overlay' : familyOf(c))
    const { L } = oklch(c)
    const open = (s) => free(family, s) && !tailwindStep(family, s)
    if (family.startsWith('overlay')) {
      const solid = { ...c, a: 1 }
      const base = familyOf(solid) !== 'neutral' ? familyOf(solid) : oklch(solid).L > 0.9 ? 'white' : oklch(solid).L < 0.25 ? 'black' : 'neutral'
      const name = `${base}-${Math.round(c.a * 100)}`
      let step = name
      for (let i = 2; !open(step); i++) step = `${name}-${i}`
      return { family, step, note: '' }
    }
    const nearest = String(STEPS.slice().sort((x, y) => Math.abs(x[1] - L) - Math.abs(y[1] - L))[0][0])
    const note = tailwindStep(family, nearest) ? `not Tailwind's ${family}-${nearest}, so named off Tailwind's steps` : ''
    if (open(nearest)) return { family, step: nearest, note }
    let n = Math.min(995, Math.max(5, Math.round(stepAt(L) / 5) * 5))
    while (!open(String(n)) && n < 995) n += 5
    while (!open(String(n))) n -= 5
    return { family, step: String(n), note }
  }
  const addPrimitive = (c, value, from, note) => {
    const name = nameFor(c)
    used.set(name.family, (used.get(name.family) ?? new Set()).add(name.step))
    const path = ['color', name.family, name.step]
    out.push({ path, type: 'color', value, modes: {}, description: '', source: 'audit' })
    report.push({ family: 'color', token: key(path), value, from, note: [name.note, note].filter(Boolean).join('; ') })
    return key(path)
  }

  // The page's own colours, as the style files' body, html or :root rules
  // set them: a source token (a var() of its variable, or an @apply class
  // that names it), or a colour (a literal, or a class of Tailwind's own).
  // The cluster of a colour the code uses is kept even when used once, as
  // the body size is; a colour the code uses nowhere else is a primitive of
  // its own.
  const byVar = new Map(colorTokens.map((t) => [t.cssVar ?? cssVarFor(t.path.filter((p) => p !== '$root')), t]))
  const byClass = new Map(colorTokens.filter((t) => t.path[0] === 'color').map((t) => [t.path.slice(1).filter((p) => p !== '$root').join('-'), t]))
  const clusterOf = (c) => (audit?.colorClusters ?? []).find((cl) => cl.members.some((m) => parseColor(m.value) && toHex(parseColor(m.value)) === toHex(c)))
  const pageParts = []
  for (const [mode, parts] of Object.entries(page ?? {})) {
    for (const [part, p] of Object.entries(parts)) {
      const at = { mode, part, where: `set on ${p.selector} in ${p.file}` }
      const v = /^var\(\s*(--[\w-]+)\s*\)$/.exec(p.value ?? '')?.[1]
      const token = v ? byVar.get(v) : p.class ? byClass.get(p.class) : null
      if (token) {
        pageParts.push({ ...at, key: key(token.path) })
        continue
      }
      const shade = /^([a-z]+)-(\d+)$/.exec(p.class ?? '')
      const raw = p.class ? (p.class === 'white' ? '#ffffff' : p.class === 'black' ? '#000000' : shade ? palette?.[shade[1]]?.[TAILWIND_STEPS.indexOf(Number(shade[2]))] : null) : v ? null : p.value
      const c = parseColor(raw ?? '')
      if (!c || c.a === 0) continue
      // A class names one exact colour; a literal is covered as a cluster is.
      const covered = p.class ? literal.find((x) => toHex(x.c) === toHex(c)) : near(c)
      pageParts.push({ ...at, colour: c, value: /^(?:#|[a-z]+\()/i.test(raw) ? raw : toHex(c), written: p.class ? `${part === 'color' ? 'text' : 'bg'}-${p.class}` : p.value, key: covered ? key(covered.t.path) : null, cluster: covered ? null : clusterOf(c) })
    }
  }
  const kept = new Set(pageParts.map((x) => x.cluster).filter(Boolean))

  for (const cl of audit?.colorClusters ?? []) {
    const c = parseColor(cl.representative)
    if (!c || c.a === 0) continue
    const roles = Object.keys(cl.roles ?? {})
    // A colour only ever used inside a shadow belongs to the shadow token.
    if (!kept.has(cl) && roles.length > 0 && roles.every((r) => r === 'shadow')) continue
    // Never set as a style anywhere: data in a script (an avatar palette, a chart's series).
    if (!kept.has(cl) && roles.length > 0 && roles.every((r) => r === 'other')) {
      outliers.push({ family: 'color', value: cl.representative, count: cl.count, note: `only in data or scripts, never as a style${mostIn(cl.representative) ? `, most in ${mostIn(cl.representative)}` : ''}` })
      continue
    }
    // A cluster is covered when any colour in it is near a token, not only
    // the one that names it.
    const byRepresentative = near(c)
    let byMember = null
    for (const m of byRepresentative ? [] : cl.members) {
      const mc = parseColor(m.value)
      const x = mc && near(mc)
      if (x) {
        byMember = { value: m.value, match: x }
        break
      }
    }
    const match = byRepresentative ?? byMember?.match
    if (match) {
      noteOn(report, key(match.t.path), `covers ${cl.representative}${byMember ? ` (its cluster holds ${byMember.value})` : ''}, used ${cl.count}× in code`)
      cl.token = key(match.t.path)
      continue
    }
    if (cl.count < minCount && !kept.has(cl)) {
      outliers.push({ family: 'color', value: cl.representative, count: cl.count, note: 'used once; use a token instead, or keep it with a reason' })
      continue
    }
    const where = mostIn(cl.representative)
    cl.token = addPrimitive(c, c.a < 1 ? toHex(c) : cl.representative, `used ${cl.count}× in code${where ? `, most in ${where}` : ''}`, cl.members.length > 1 ? `merges ${cl.members.map((m) => m.value).join(', ')}` : '')
  }
  for (const p of pageParts) {
    if (p.key) continue
    p.key = p.cluster?.token ?? pageParts.find((x) => x.key && x.colour && toHex(x.colour) === toHex(p.colour))?.key
    p.key ??= addPrimitive(p.colour, p.value, `the page's ${p.part === 'color' ? 'text colour' : 'background'}, ${p.written} ${p.where}`, '')
  }

  // Semantics: only when the sources have no semantic layer of their own.
  const all = [...existing, ...out]
  const byLast = new Map(all.map((t) => [key(t.path), t]))
  const hasSemantics = existing.some((t) => (t.type === 'color' || isAlias(t.value)) && describeByName(key(t.path)))
  if (hasSemantics) {
    for (const t of existing) {
      if (t.type !== 'color' && !(isAlias(t.value) && t.type === 'color')) continue
      const on = pairByName(t, byLast)
      // Text on something says what it sits on: on-block-strong is strong text on block.
      const last = t.path.filter((p) => p !== '$root').pop()
      let d = describeByName(key(t.path))
      const subject = /^on-(.+)$/.exec(last)?.[1] ?? /^(.+)-(?:content|foreground|fg)$/.exec(last)?.[1] ?? (/^(content|foreground|fg)$/.test(last) ? t.path.filter((p) => p !== '$root').slice(-2, -1)[0] : null)
      const target = on?.split('.').filter((p) => p !== '$root').pop()?.replace(/-(?:bg|background)$/, '')
      // Only a pair found by name says what it sits on; a fallback guess does not.
      if (subject && target && (subject === target || subject.startsWith(`${target}-`))) {
        const extra = subject.slice(target.length + 1)
        d = `Text and icons on ${/^base(-\d+)?$/.test(target) ? 'base backgrounds' : target}${extra ? `, ${extra}` : ''}`
      }
      if (d && !t.description) {
        t.description = d
        noteOn(report, key(t.path), `description drafted from its name: "${d}"; check it`)
      }
      if (on && !t.contrast) {
        t.contrast = { on, use: 'text' }
        noteOn(report, key(t.path), `contrast checked as text on ${on}`)
      }
      const bg = on || t.contrast ? null : backgroundOfGroup(t, byLast)
      if (bg) {
        t.contrast = { on: bg, use: 'text' }
        noteOn(report, key(t.path), `contrast checked as text on ${bg}, guessed as its group's background`)
      }
    }
  } else {
    // The colour a token stands for, through its references.
    const colourAt = (k) => {
      for (let hop = 0, t = byLast.get(k); t && hop < 8; hop++, t = byLast.get(aliasPath(t.value))) if (!isAlias(t.value)) return parseColor(String(t.value))
      return null
    }
    const byRole = { bg: [], text: [], border: [] }
    for (const cl of audit?.colorClusters ?? []) {
      if (!cl.token) continue
      for (const [role, n] of Object.entries(cl.roles ?? {})) if (byRole[role]) byRole[role].push({ cl, n, colour: parseColor(cl.representative) })
    }
    const semantic = {}
    const isNeutral = (cl) => familyOf(parseColor(cl.representative)) === 'neutral'
    const pageAt = (mode, part) => pageParts.find((p) => p.mode === mode && p.part === part) ?? null
    // A light default theme sits on a light background, a dark one on a dark one.
    const light = defaultMode !== 'dark'
    const isLight = (c) => oklch(c).L >= 0.5
    for (const [role, all] of Object.entries(byRole)) {
      const [group, ...names] = ROLE_NAMES[role]
      // Pages, text and borders are mostly neutral; a coloured background is usually the accent.
      const list = all.filter(({ n }) => n >= minCount).sort((a, b) => Number(isNeutral(b.cl)) - Number(isNeutral(a.cl)) || b.n - a.n || compare(a.cl.representative, b.cl.representative))
      const picked = []
      const push = (name, target, description, from, note) => {
        const path = ['color', group, name]
        picked.push({ target, path })
        out.push({ path, type: 'color', value: `{${target}}`, modes: {}, description, source: 'audit' })
        report.push({ family: 'color', token: key(path), value: `{${target}}`, from, note })
      }
      const pick = ({ cl, n }) => {
        const name = names[picked.length]
        const where = mostIn(cl.representative)
        push(name, cl.token, `${ROLE_WORDS[role]}${name === 'default' ? '' : `, ${name}`}. Used ${n}× as ${role === 'bg' ? 'a background' : role === 'text' ? 'text' : 'a border'}${where ? `, most in ${where}` : ''}.`, `${ROLE_WORDS[role].toLowerCase()} role, ${n}× in code`, 'description drafted from usage; check it')
      }
      const taken = (x) => picked.some((p) => p.target === x.cl.token)
      // The page's own background and text colour come first, as the defaults.
      const own = role === 'border' ? null : pageAt('default', role === 'bg' ? 'background' : 'color')
      if (own) push('default', own.key, `${ROLE_WORDS[role]}, the page's own, ${own.where}.`, `the page's ${role === 'bg' ? 'background' : 'text colour'}, ${own.where}`, 'description drafted from the style files; check it')
      if (role === 'bg') {
        const accent = list.find(({ cl }) => !isNeutral(cl) && cl.token !== own?.key)
        const withAccent = accent && (own || list.some(({ cl }) => isNeutral(cl)))
        // With no page background and no opaque background on the default
        // theme's side, the code's backgrounds belong to another theme: no
        // semantic colour is proposed, and the note says why.
        const opaque = list.filter((x) => x !== (withAccent ? accent : null) && x.colour.a >= 1)
        if (!own && opaque.length > 0 && !opaque.some((x) => isLight(x.colour) === light)) {
          gaps.reason = `the most used background in the code, ${opaque[0].cl.representative}, is ${light ? 'dark' : 'light'} while tokens.defaultMode is ${light ? 'light' : 'dark'}, and the style files set no page background; if the app is ${light ? 'dark' : 'light'}, set tokens.defaultMode to ${light ? 'dark' : 'light'} and extract again`
          break
        }
        if (withAccent) {
          list.splice(list.indexOf(accent), 1)
          const where = mostIn(accent.cl.representative)
          const path = ['color', 'accent', 'default']
          out.push({ path, type: 'color', value: `{${accent.cl.token}}`, modes: {}, description: `Accent, for primary actions and highlights. Used ${accent.n}× as a background${where ? `, most in ${where}` : ''}.`, source: 'audit' })
          report.push({ family: 'color', token: key(path), value: `{${accent.cl.token}}`, from: `the most used coloured background, ${accent.n}× in code`, note: 'description drafted from usage; check it' })
        }
        // With no page background, the default is the first opaque one on
        // the default theme's side; the others sit on its side, or are overlays.
        for (const x of list) {
          if (taken(x) || picked.length >= names.length) continue
          const base = picked[0] ? colourAt(picked[0].target) : null
          if (base ? x.colour.a >= 1 && isLight(x.colour) !== isLight(base) : x.colour.a < 1 || isLight(x.colour) !== light) continue
          pick(x)
        }
      } else if (role === 'text' && semantic.bg?.[0] && colourAt(semantic.bg[0].target)) {
        // Text that reads on the page background: the default the most used
        // at 4.5:1 or more, the others the most used between that and 3:1,
        // the stronger first. Greys come first, tinted ones too (a slate, a
        // violet grey); text the page cannot hold is text on something else.
        const ground = colourAt(semantic.bg[0].target)
        const ratio = (c) => contrastRatio(c, ground)
        const grey = (x) => oklch(x.colour).C < 0.06
        const order = (a, b) => Number(grey(b)) - Number(grey(a)) || b.n - a.n || ratio(b.colour) - ratio(a.colour) || compare(a.cl.representative, b.cl.representative)
        const readable = list.filter((x) => ratio(x.colour) >= 3).sort(order)
        if (!own) {
          const body = readable.find((x) => ratio(x.colour) >= 4.5)
          if (body) pick(body)
        }
        const top = picked[0] ? colourAt(picked[0].target) : null
        const below = readable.filter((x) => !taken(x) && (!top || ratio(x.colour) < ratio(top)))
        const greys = below.filter(grey)
        for (const x of (greys.length > 0 ? greys : below).slice(0, names.length - picked.length).sort((a, b) => ratio(b.colour) - ratio(a.colour))) pick(x)
      } else {
        for (const x of list) {
          if (taken(x) || picked.length >= names.length) continue
          pick(x)
        }
      }
      semantic[role] = picked
    }
    // The dark theme's page colours, from the style files' dark selector.
    if (light) {
      for (const [role, part] of [['bg', 'background'], ['text', 'color']]) {
        const dark = pageAt('dark', part)
        const t = semantic[role]?.[0] && out.find((x) => key(x.path) === key(semantic[role][0].path))
        if (!dark || !t || t.value === `{${dark.key}}`) continue
        t.modes = { dark: `{${dark.key}}` }
        noteOn(report, key(t.path), `dark theme {${dark.key}}, the page's own, ${dark.where}`)
      }
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

// daisyUI's built-in themes, which an app picks with `@plugin "daisyui"`:
// where their colours live and how to own them. With no colour of the app's
// own, the note says no semantic colour comes from the app's themes; with
// some (a `@plugin "daisyui/theme"` block), only that the built-in ones keep
// their values in the daisyui package. `classes`, when given, adds the
// Tailwind palette classes the code uses.
function daisyNote(daisy, owned, classes) {
  const and = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0])
  const role = (t) => (t.default && t.prefersdark ? ' (the default, also used when the system prefers dark)' : t.default ? ' (the default)' : t.prefersdark ? ' (used when the system prefers dark)' : '')
  const picked = daisy.all ? 'every daisyUI built-in theme (themes: all)' : `daisyUI's built-in ${daisy.themes.length === 1 ? 'theme' : 'themes'} ${and(daisy.themes.map((t) => `${t.name}${role(t)}`))}`
  const named = daisy.implicit ? `which @plugin "daisyui" turns on in ${daisy.file}, as it names no themes` : `which @plugin "daisyui" names in ${daisy.file}`
  const where = daisy.all ? 'theme/<name>.css' : and(daisy.themes.map((t) => `theme/${t.name}.css`))
  const top = (classes?.top ?? []).map((c) => c.name)
  const palette = classes?.count > 0 ? ` Apart from those, the code uses ${classes.count} Tailwind palette ${classes.count === 1 ? 'class' : 'classes'}${top.length ? ` (most used: ${and(top)})` : ''}, which extract does not turn into tokens.` : ''
  if (owned) return `The app also takes colours from ${picked}, ${named}. Their values live in the daisyui package (${where}), not in this repo, so no token here holds them. To own them as tokens, copy each theme's values into semantic colour tokens when reviewing colour semantics, one theme per mode.${palette}`
  return `No semantic colour is proposed from the app's themes: it takes its colours from ${picked}, ${named}. Their values live in the daisyui package (${where}), not in this repo, under daisyUI's colour names: ${and(CLASS_LIBRARIES.daisyui.colors)}. To own them as tokens, copy each theme's values into semantic colour tokens when reviewing colour semantics, one theme per mode, and map daisyUI's names onto them with a @plugin "daisyui/theme" block per theme.${palette}`
}

// What the colour proposal leaves out, and why: no semantic colour (text,
// background, border, accent), or no theme beyond the default when the
// default is not dark itself. Said only when the repo has colours at all:
// tokens, or Tailwind palette classes. An app on daisyUI's built-in themes
// gets a note on those themes, which answers the first (daisyUI's colours
// are named by their job) and, when the app has more than one theme, the
// second.
function colorGaps(existing, colors, audit, minCount, defaultMode, daisy = null, reason = null) {
  const classes = audit?.colorClasses
  const all = [...existing, ...colors].filter((t) => t.type === 'color')
  const any = all.length > 0 || classes?.count > 0
  if (!any && !daisy) return []
  const notes = []
  const many = (n, one, more) => `${n} ${n === 1 ? one : more}`
  const named = existing.some((t) => (t.type === 'color' || isAlias(t.value)) && describeByName(key(t.path)))
  // A colour the sources already alias to another is a semantic layer of
  // their own, whatever its name (--card: var(--gray-50)).
  const aliased = existing.some((t) => t.type === 'color' && [t.value, ...Object.values(t.modes ?? {})].some(isAlias))
  const noSemantic = any && !named && !aliased && !colors.some((t) => isAlias(t.value))
  if (daisy) {
    notes.push(daisyNote(daisy, existing.some((t) => t.type === 'color'), noSemantic ? classes : null))
  } else if (noSemantic) {
    const top = (classes?.top ?? []).map((c) => c.name)
    const examples = top.length > 1 ? `${top.slice(0, -1).join(', ')} and ${top[top.length - 1]}` : top[0]
    const why = reason ?? (classes?.count > 0
      ? `the code sets its colours with ${many(classes.count, 'Tailwind palette class', 'Tailwind palette classes')}${examples ? ` (most used: ${examples})` : ''}, which extract does not turn into semantic tokens, and the sources name no colour by its job`
      : `the sources name no colour by its job (such as bg, text or border), and the code uses no raw colour as a background, text or border ${minCount} times or more`)
    notes.push(`No semantic colour is proposed: ${why}. Add the text, background, border and accent tokens when reviewing colour semantics, each an alias of a primitive.`)
  }
  if (any && !daisy?.several && defaultMode !== 'dark' && !all.some((t) => Object.keys(t.modes ?? {}).length > 0)) {
    const why = classes?.dark > 0
      ? `the code switches its colours with ${many(classes.dark, 'dark: variant', 'dark: variants')} of Tailwind palette classes, which extract does not read, and the sources set no colour for a dark theme`
      : 'the sources set no colour for a dark theme'
    notes.push(`No dark theme is proposed: ${why}. If the app has one theme only, nothing is missing; if that theme is dark, set tokens.defaultMode to dark.`)
  }
  return notes
}

// ── Scales: spacing, radius, type ──────────────────────────────────────────

const rem = (px) => `${Number((px / 16).toFixed(4))}rem`
const pxOf = (text) => {
  const m = /^(-?\d*\.?\d+)(px|rem)$/.exec(String(text).trim())
  return m ? Number(m[1]) * (m[2] === 'rem' ? 16 : 1) : null
}
const existingPx = (tokens, groups) => new Set(tokens.filter((t) => groups.includes(t.path[0])).map((t) => pxOf(t.value)).filter((n) => n !== null))
// A number as a token name: a dot is not allowed in one, so 0.5 is 0_5.
const numberName = (n) => String(n).replace('.', '_')

// A length the code writes in em is relative to a font size (a font size's
// to its parent's, any other length's to its element's), so no rem token can
// hold it. A family's em lengths, by how each is written and by the px the
// audit counted it at, so a scale can leave them out of its counts.
function emLengths(audit, category, body = null) {
  const byValue = new Map()
  const byPx = new Map()
  let bodyLeft = typeof body?.px === 'number'
  for (const f of audit?.findings ?? []) {
    if (f.category !== category) continue
    const written = f.kind === 'arbitrary' ? /\[(.*)\]/.exec(f.value)?.[1] : f.value
    if (!/^-?\d*\.?\d+em$/.test(written ?? '')) continue
    // The body size in em, set by a body, html or :root rule, follows the
    // root size as rem does: it is the body size, not an em length.
    if (bodyLeft && f.file === body.file && Math.abs(parseFloat(written) * 16 - body.px) < 0.01) {
      bodyLeft = false
      continue
    }
    byValue.set(written, (byValue.get(written) ?? 0) + 1)
    if (f.px !== undefined) byPx.set(f.px, (byPx.get(f.px) ?? 0) + 1)
  }
  return { byValue, byPx }
}
// A count by px (a histogram, the type sizes) less the em lengths at each px.
const withoutEm = (list, em) => list.map((s) => ({ ...s, count: s.count - (em.byPx.get(s.px) ?? 0) })).filter((s) => s.count > 0)
// The em lengths of a family, under Not proposed in one row, most used first.
function emOutliers(em, family, outliers) {
  if (em.byValue.size === 0) return
  const list = [...em.byValue].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))
  const shown = list.slice(0, 8).map(([value, n]) => (n > 1 ? `${value} ×${n}` : value)).join(', ')
  const note = `in em, relative to the ${family === 'typography' ? "parent's" : "element's"} font size, so a rem token cannot hold ${list.length === 1 ? 'it' : 'them'}`
  outliers.push({ family, value: list.length > 8 ? `${shown}, +${list.length - 8} more` : shown, count: list.reduce((n, [, c]) => n + c, 0), note, em: true })
}

// Tailwind's own classes of a family the audit counted (`rounded-lg`, a
// spacing step), as one report row: Tailwind's scale needs no new tokens.
function tailwindClassRow(audit, family, from, note) {
  const list = audit?.forExtract?.classes?.[family] ?? []
  if (list.length === 0) return null
  const shown = list.slice(0, 12).map((c) => `${c.value} ×${c.count}`).join(', ')
  return { family, token: '(none)', value: list.length > 12 ? `${shown}, +${list.length - 12} more` : shown, from, note }
}

// `closed` says the sources' steps are the whole scale (see propose).
function proposeSpacing(existing, audit, report, outliers, minCount, tailwind, closed = existingPx(existing, ['spacing', 'space']).size >= 3) {
  const em = emLengths(audit, 'spacing')
  const histogram = withoutEm(audit?.spacing?.histogram ?? [], em)
  const have = existingPx(existing, ['spacing', 'space'])
  const weighted = histogram.reduce((n, s) => n + s.count, 0)
  const on = (base) => histogram.filter((s) => s.px % base === 0).reduce((n, s) => n + s.count, 0)
  const base = weighted === 0 ? 4 : on(4) / weighted >= 0.7 ? 4 : on(2) / weighted >= 0.7 ? 2 : 1
  const out = []
  for (const s of histogram) {
    if (s.px === 0 || have.has(s.px)) continue
    // Three or more steps in the sources are a scale, and the code's other
    // values are drift for tidy; fewer (Tailwind 4's --spacing) leave gaps.
    if (closed) {
      outliers.push({ family: 'spacing', value: `${s.px}px`, count: s.count, note: 'not on the existing spacing scale' })
      continue
    }
    if (s.count < minCount || s.px % base !== 0) {
      outliers.push({ family: 'spacing', value: `${s.px}px`, count: s.count, note: s.px % base !== 0 ? `off the ${base}px grid` : 'used once' })
      continue
    }
    const path = ['spacing', String(s.px / 4).replace('.', '_')]
    out.push({ path, type: 'dimension', value: rem(s.px), modes: {}, description: '', source: 'audit' })
    report.push({ family: 'spacing', token: key(path), value: rem(s.px), from: `${s.px}px used ${s.count}× in code`, note: `on the ${base}px grid` })
  }
  emOutliers(em, 'spacing', outliers)
  const classes = tailwind && tailwindClassRow(audit, 'spacing', 'Tailwind spacing classes (p-, m-, gap- and the like), by step', "Tailwind's own spacing scale; give it tokens if the design should own it")
  if (classes) report.push(classes)
  return out
}

// Tailwind's radius scale by size in px, as each version names it. Tailwind
// 3's 4px is `rounded` itself, which has no name to give a token.
const TAILWIND_RADIUS = {
  tailwind4: { 2: 'xs', 4: 'sm', 6: 'md', 8: 'lg', 12: 'xl', 16: '2xl', 24: '3xl', 32: '4xl' },
  tailwind3: { 2: 'sm', 6: 'md', 8: 'lg', 12: 'xl', 16: '2xl', 24: '3xl' },
}

// `tailwind` is the Tailwind version the repo styles with, or null. There a
// radius takes Tailwind's name only when its size is Tailwind's for that
// name, so a token wired into Tailwind never changes what a class renders;
// any other radius is named by its size, a name Tailwind's scale never uses.
function proposeRadius(existing, audit, report, outliers, minCount, tailwind, closed = existingPx(existing, ['radius', 'radii', 'rounded']).size >= 3) {
  const have = existingPx(existing, ['radius', 'radii', 'rounded'])
  const em = emLengths(audit, 'radius')
  const counts = new Map()
  for (const f of audit?.findings ?? []) if (f.category === 'radius' && f.px !== undefined) counts.set(f.px, (counts.get(f.px) ?? 0) + 1)
  for (const [px, n] of em.byPx) counts.set(px, counts.get(px) - n)
  const values = [...counts.entries()].filter(([px, n]) => px > 0 && n > 0 && !have.has(px)).sort((a, b) => a[0] - b[0])
  const names = ['sm', 'md', 'lg', 'xl', '2xl', '3xl']
  const scale = tailwind ? TAILWIND_RADIUS[tailwind] : null
  // A name a source already gives a radius (by its path or its CSS variable)
  // is never proposed again; that radius is named by its size instead.
  const owned = new Set(existing.flatMap((t) => [key(t.path), t.cssVar ?? cssVarFor(t.path.filter((p) => p !== '$root'))]))
  const free = (name) => !owned.has(`radius.${name}`) && !owned.has(cssVarFor(['radius', name]))
  const out = []
  let i = 0
  for (const [px, count] of values) {
    if (count < minCount || closed) {
      outliers.push({ family: 'radius', value: `${px}px`, count, note: closed ? 'not on the existing radius scale' : 'used once' })
      continue
    }
    const full = px >= 999
    const wanted = full ? 'full' : scale ? scale[px] ?? numberName(px) : names[i++] ?? numberName(px)
    const name = [wanted, numberName(px)].find(free)
    if (name === undefined) {
      outliers.push({ family: 'radius', value: `${px}px`, count, note: `the sources already use the names radius.${wanted} and radius.${numberName(px)}` })
      continue
    }
    const note = name !== wanted
      ? `the sources already define radius.${wanted}, so named by its size`
      : !scale ? '' : full || scale[px] ? `Tailwind's rounded-${name}` : tailwind === 'tailwind3' && px === 4 ? "Tailwind's rounded, named by its size" : "off Tailwind's scale, named by its size"
    out.push({ path: ['radius', name], type: 'dimension', value: full ? '9999px' : rem(px), modes: {}, description: '', source: 'audit' })
    report.push({ family: 'radius', token: `radius.${name}`, value: full ? '9999px' : rem(px), from: `${px}px used ${count}× in code`, note })
  }
  emOutliers(em, 'radius', outliers)
  const classes = scale && tailwindClassRow(audit, 'radius', 'Tailwind classes', "Tailwind's own radii; give them tokens if the design should own them")
  if (classes) report.push(classes)
  return out
}

// Widths and heights (a max width, a container): massimo proposes no size
// family, so each value the code repeats is listed with that reason, and the
// ones used once are listed together, never dropped.
function sizeOutliers(audit, outliers, minCount) {
  const byPx = new Map()
  for (const f of audit?.findings ?? []) {
    if (f.category !== 'size' || f.px === undefined || f.px === 0) continue
    const written = f.kind === 'arbitrary' ? /\[(.*)\]/.exec(f.value)?.[1] ?? f.value : f.value
    const e = byPx.get(f.px) ?? { px: f.px, count: 0, forms: new Map() }
    e.count++
    e.forms.set(written, (e.forms.get(written) ?? 0) + 1)
    byPx.set(f.px, e)
  }
  const form = (e) => [...e.forms.entries()].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))[0][0]
  const all = [...byPx.values()].sort((a, b) => b.count - a.count || a.px - b.px)
  for (const e of all.filter((x) => x.count >= minCount)) {
    outliers.push({ family: 'size', value: form(e), count: e.count, note: 'a width or height; massimo proposes no size tokens yet' })
  }
  const once = all.filter((x) => x.count < minCount).sort((a, b) => a.px - b.px)
  if (once.length > 0) {
    const shown = once.slice(0, 6).map(form).join(', ')
    outliers.push({ family: 'size', value: once.length > 6 ? `${shown}, +${once.length - 6} more` : shown, count: once.reduce((n, x) => n + x.count, 0), note: 'widths and heights used once each' })
  }
}

const WEIGHT_NAMES = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' }
const WEIGHT_CLASSES = { thin: 100, extralight: 200, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 }
const LEADING_CLASSES = { none: 1, tight: 1.25, snug: 1.375, normal: 1.5, relaxed: 1.625, loose: 2 }
const SIZE_NAMES_UP = ['lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl']
const SIZE_NAMES_DOWN = ['sm', 'xs', '2xs']
// Tailwind's own type scale, by size: its name and line height (px, or unitless).
const TAILWIND_TEXT = { 12: ['xs', 16], 14: ['sm', 20], 16: ['base', 24], 18: ['lg', 28], 20: ['xl', 28], 24: ['2xl', 32], 30: ['3xl', 36], 36: ['4xl', 40], 48: ['5xl', 1], 60: ['6xl', 1], 72: ['7xl', 1], 96: ['8xl', 1], 128: ['9xl', 1] }

const inventoryCounts = (audit, family, read) => {
  const out = new Map()
  for (const { value, count } of audit?.inventory?.[family] ?? []) {
    const v = read(value)
    if (v !== null && v !== undefined) out.set(v, (out.get(v) ?? 0) + count)
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1] || compare(String(a[0]), String(b[0])))
}

function proposeType(existing, audit, typeSteps, report, outliers, minCount, tailwind, closed = existingPx(existing, ['text', 'font-size']).size >= 3) {
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
  const displayRef = existing.find((t) => t.type === 'fontFamily' && t !== familyRef && /display|heading|serif|title/.test(key(t.path)))
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
  // The body size: the one a body, html or :root rule sets, else the most used.
  const ruled = audit?.forExtract?.bodySize ?? null
  const em = emLengths(audit, 'type', ruled)
  const typeSizes = withoutEm(audit?.typeSizes ?? [], em)
  const body = ruled?.px ?? [...typeSizes].sort((a, b) => b.count - a.count || Math.abs(a.px - 16) - Math.abs(b.px - 16) || a.px - b.px)[0]?.px ?? 16
  // Three or more sizes in the sources are a scale; fewer leave gaps to
  // fill. A few sizes all on one side of the body size (a badge's 8px and
  // 10px) are extra steps, not the scale running text is set in.
  const spans = [...haveSizes].some((px) => px <= body) && [...haveSizes].some((px) => px >= body)
  const onScale = !closed || !spans
  // A size the body rule sets is kept even when the code repeats it nowhere
  // else, and even beside a scale the sources close, which lacks it.
  const kept = (s) => s.count >= minCount || s.px === ruled?.px
  const sizes = typeSizes.filter((s) => kept(s) && !haveSizes.has(s.px) && (onScale || s.px === ruled?.px)).sort((a, b) => a.px - b.px)
  for (const s of typeSizes.filter((s) => !haveSizes.has(s.px) && !sizes.includes(s))) {
    outliers.push({ family: 'typography', value: `${s.px}px`, count: s.count, note: onScale ? 'a font size used once' : 'not on the existing type scale' })
  }
  emOutliers(em, 'typography', outliers)
  const below = sizes.filter((s) => s.px < body).reverse()
  const above = sizes.filter((s) => s.px > body)
  // A Tailwind repo already names its sizes: keep Tailwind's names, and name
  // the rest by their size. Elsewhere, name them around the body size.
  const named = tailwind
    ? sizes.map((s) => [TAILWIND_TEXT[s.px]?.[0] ?? String(s.px).replace('.', '_'), s])
    : [
        ...below.map((s, i) => [SIZE_NAMES_DOWN[i] ?? `${i}xs`, s]),
        ...sizes.filter((s) => s.px === body).map((s) => ['base', s]),
        ...above.map((s, i) => [SIZE_NAMES_UP[i] ?? `${i}xl`, s]),
      ]
  // A name whose variable a source token already has (--font-size-base)
  // is named by its size instead.
  const ownedVars = new Set(existing.map((t) => t.cssVar ?? cssVarFor(t.path.filter((p) => p !== '$root'))))
  for (const [wanted, s] of named) {
    const name = [wanted, String(s.px).replace('.', '_')].find((n) => !ownedVars.has(cssVarFor(['font', 'size', n])))
    if (name === undefined) {
      outliers.push({ family: 'typography', value: `${s.px}px`, count: s.count, note: `the sources already use the variables ${cssVarFor(['font', 'size', wanted])} and ${cssVarFor(['font', 'size', String(s.px).replace('.', '_')])}` })
      continue
    }
    const path = ['font', 'size', name]
    out.push({ path, type: 'dimension', value: rem(s.px), modes: {}, description: '', source: 'audit' })
    const bodyNote = ruled ? `the body size, set on ${ruled.selector} in ${ruled.file}` : 'the most used size, taken as the body size'
    const twNote = TAILWIND_TEXT[s.px] ? `Tailwind's text-${name}` : "off Tailwind's scale, named by its size"
    const note = !onScale ? `${tailwind ? `${twNote}; ` : ''}${bodyNote}, which the sources' type scale lacks` : tailwind ? twNote : name === 'base' ? bodyNote : ''
    report.push({ family: 'typography', token: key(path), value: rem(s.px), from: `${s.px}px used ${s.count}× in code`, note })
  }
  // Composites: exact from a Tailwind config's type steps, otherwise one per
  // size from the most-used parts, with every assumed part said.
  const sizeTokens = [...existing.filter((t) => ['text', 'font-size'].includes(t.path[0]) && pxOf(t.value) !== null), ...out.filter((t) => key(t.path).startsWith('font.size.'))]
  if (sizeTokens.length === 0) return out
  if (!familyRef) {
    report.push({ family: 'typography', token: '(none)', value: '', from: '', note: 'the code sets no font family, so no typography composites were proposed; add font.family.sans first' })
    return out
  }
  // leading-none on an icon or a badge says nothing about running text: body
  // text takes the most used line height of 1.2 or more, headings 1 to 1.3.
  const bodyLeading = leadings.find(([v]) => v >= 1.2)?.[0]
  const headingLeading = leadings.find(([v]) => v >= 1 && v <= 1.3)?.[0]
  // Body text that sets no weight is 400, however often the code sets 500.
  const bodyWeight = 400
  const headingWeight = weights.find(([w]) => w >= 600)?.[0]
  const ref = (t) => `{${key(t.path)}}`
  const weightRef = (w) => {
    const t = [...existing, ...out].find((x) => x.type === 'fontWeight' && Number(x.value) === w)
    return t ? ref(t) : w
  }
  for (const size of sizeTokens) {
    const px = pxOf(size.value)
    const step = typeSteps.find((s) => key(s.path) === key(size.path))
    const assumed = []
    // A step's own line height: a length, a number or a percentage. Any
    // other (normal, a var()) is no number a composite can hold, so the
    // line height is assumed as for a step without one, and said.
    const written = step?.lineHeight === undefined ? null : String(step.lineHeight).trim()
    const own = written === null ? null : pxOf(written) !== null ? Number((pxOf(written) / px).toFixed(4)) : /^\d*\.?\d+%$/.test(written) ? Number((parseFloat(written) / 100).toFixed(4)) : /^\d*\.?\d+$/.test(written) ? Number(written) : null
    const instead = written !== null && own === null ? `, in place of ${step.source ?? 'the config'}'s ${written}` : ''
    const lineHeight = (() => {
      if (own !== null) return own
      const tw = tailwind && size.source === 'audit' && TAILWIND_TEXT[px]
      if (tw) {
        const lh = tw[1] === 1 ? 1 : Number((tw[1] / px).toFixed(4))
        assumed.push(`line height ${lh}, Tailwind's for text-${tw[0]}`)
        return lh
      }
      const common = px >= 24 ? headingLeading : bodyLeading
      if (common !== undefined) {
        assumed.push(`line height ${common}, the most used for ${px >= 24 ? 'headings' : 'body text'}${instead}`)
        return common
      }
      assumed.push(`line height ${px >= 24 ? 1.2 : 1.5}, as the code sets none for ${px >= 24 ? 'headings' : 'body text'}${instead}`)
      return px >= 24 ? 1.2 : 1.5
    })()
    const weight = step?.fontWeight !== undefined ? Number(step.fontWeight) : px >= 24 ? headingWeight ?? bodyWeight : bodyWeight
    if (step?.fontWeight === undefined) assumed.push(px >= 24 && headingWeight ? `weight ${weight}, the most used heading weight` : px >= 24 ? 'weight 400, as the code sets no heading weight' : 'weight 400, the default')
    const name = size.path.filter((p) => p !== '$root').slice(-1)[0]
    // A heading step takes the display face where the system has one.
    const heading = displayRef && /^(h[1-6]|display|heading|title|hero|name)(\b|-|$)/.test(name)
    if (heading) assumed.push(`the ${key(displayRef.path)} face, for a heading step`)
    else if (step && displayRef) assumed.push(`the ${key(familyRef.path)} face`)
    const letterSpacing = step?.letterSpacing ?? '0px'
    if (step?.letterSpacing === undefined) assumed.push('no letter spacing')
    const path = ['typography', name]
    const value = { fontFamily: ref(heading ? displayRef : familyRef), fontSize: ref(size), fontWeight: step?.fontWeightRef ?? weightRef(weight), lineHeight, letterSpacing }
    out.push({ path, type: 'typography', value, modes: {}, description: '', source: step ? step.source ?? 'config' : 'audit' })
    report.push({ family: 'typography', token: key(path), value: `${size.value} / ${lineHeight}, weight ${weight}`, from: step ? `a type step in ${step.source ?? 'the config'}` : 'the size scale', note: assumed.length ? `assumed ${assumed.join(', ')}` : '' })
  }
  return out
}

// ── Shadows, borders, motion, layers, opacity ──────────────────────────────

function proposeRest(existing, audit, colorTokens, report, outliers, minCount, fromCss, tailwind) {
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
    // Class strings are Tailwind's shadows only in a repo styled with Tailwind.
    const tw = tailwind ? (audit?.inventory?.shadow ?? []).filter((s) => s.value.startsWith('class ')) : []
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
    // Under 1ms (0.01ms in a reduced-motion reset) switches motion off; it is no step of the scale.
    const kept = ms.filter(([v, count]) => {
      if (count >= minCount && v >= 1) return true
      if (v > 0) outliers.push({ family: 'motion', value: `${v}ms`, count, note: v < 1 ? 'under 1ms, which turns motion off rather than timing it' : 'used once' })
      return false
    })
    const names = kept.length <= 3 ? ['fast', 'normal', 'slow'].slice(kept.length === 1 ? 1 : 0) : []
    kept.forEach(([v, count], i) => {
      const path = ['duration', names[i] ?? numberName(v)]
      out.push({ path, type: 'duration', value: `${v}ms`, modes: {}, description: '', source: 'audit' })
      report.push({ family: 'motion', token: key(path), value: `${v}ms`, from: `used ${count}× in code`, note: '' })
    })
  }
  if (!has('cubicBezier')) {
    // A Tailwind ease-* class is Tailwind's curve, not the CSS keyword of that name.
    const easings = inventoryCounts(audit, 'easing', (v) => {
      const c = /^class ease-(\w[\w-]*)$/.exec(v)
      if (c) return { linear: 'linear', in: 'cubic-bezier(0.4, 0, 1, 1)', out: 'cubic-bezier(0, 0, 0.2, 1)', 'in-out': 'cubic-bezier(0.4, 0, 0.2, 1)' }[c[1]] ?? null
      return /^steps\(/.test(v) ? null : v
    }).filter(([v, count]) => {
      if (count >= minCount) return true
      outliers.push({ family: 'motion', value: v, count, note: 'used once' })
      return false
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
      if (count < minCount) {
        outliers.push({ family: 'z-index', value: String(v), count, note: 'used once' })
        continue
      }
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
export function propose({ sources, audit, fromCss, minCount = 2, styling = [], defaultMode = 'light' }) {
  const { tokens: existing, notes } = mergeSources(sources)
  const report = []
  const outliers = []
  for (const t of existing) {
    const family = t.type === 'color' || t.path[0] === 'color'
      ? 'color'
      : ['fontFamily', 'fontWeight', 'typography'].includes(t.type) || ['text', 'font', 'font-weight', 'leading', 'tracking'].includes(t.path[0])
        ? 'typography'
        : FAMILY_OF_GROUP[t.path[0]] ?? (t.type === 'shadow' ? 'shadow' : t.type === 'duration' || t.type === 'cubicBezier' ? 'motion' : 'other')
    report.push({ family, token: key(t.path), value: isObject(t.value) || Array.isArray(t.value) ? JSON.stringify(t.value) : String(t.value), from: t.source, note: '' })
  }
  const tailwind = (styling ?? []).some((s) => /^tailwind/.test(s))
  // The Tailwind version, for the scales whose names changed in Tailwind 4
  // and for its colour palette.
  const tailwindVersion = !tailwind ? null : (styling ?? []).includes('tailwind3') && !(styling ?? []).includes('tailwind4') ? 'tailwind3' : 'tailwind4'
  const gaps = {}
  const page = sources.map((s) => s.page).find(Boolean) ?? null
  // Groups some of whose values a source left unread (a spread, or a value
  // from another module), by the readers' group names.
  const partial = new Set(sources.flatMap((s) => s.partial ?? []))
  const colors = proposeColors(existing, audit, report, outliers, minCount, { tailwind: tailwindVersion, page, defaultMode, gaps, unread: partial.has('color') })
  const daisy = sources.map((s) => s.daisyThemes).find(Boolean) ?? null
  notes.push(...colorGaps(existing, colors, audit, minCount, defaultMode, daisy, gaps.reason ?? null))
  const typeSteps = sources.flatMap((s) => s.typeSteps ?? [])
  // Three or more steps the sources define close a scale: the code's other
  // values are drift. Not when they come from a Tailwind config's
  // theme.extend alone, which adds to Tailwind's own scale, nor when a
  // source left part of the family unread (a spread, or a value from
  // another module): then the code's values fill the gaps, with a note.
  const extendOnly = new Set(sources.filter((s) => s.kind === 'tailwind').flatMap((s) => (s.extendOnly ?? []).flatMap((g) => [...new Set(s.tokens.map((t) => t.source))].map((file) => `${file}\n${g}`))))
  const closed = (family, groups) => {
    const steps = existingPx(existing.filter((t) => !extendOnly.has(`${t.source}\n${t.path[0]}`)), groups).size >= 3
    if (steps && groups.some((g) => partial.has(g))) {
      notes.push(`The sources leave part of the ${family} scale unread (see the notes on the Tailwind config), so the code's own ${family} values were proposed beside the steps that were read; check them against the part left out.`)
      return false
    }
    return steps
  }
  const out = [
    ...existing,
    ...colors,
    ...proposeType(existing, audit, typeSteps, report, outliers, minCount, tailwind, closed('type', ['text', 'font-size'])),
    ...proposeSpacing(existing, audit, report, outliers, minCount, tailwind, closed('spacing', ['spacing', 'space'])),
    ...proposeRadius(existing, audit, report, outliers, minCount, tailwindVersion, closed('radius', ['radius', 'radii', 'rounded'])),
  ]
  out.push(...proposeRest(existing, audit, out.filter((t) => t.type === 'color'), report, outliers, minCount, fromCss, tailwind))
  sizeOutliers(audit, outliers, minCount)
  return { tokens: out, report, outliers, notes }
}
