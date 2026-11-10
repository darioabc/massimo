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

import { parseColor, toHex, toOklab } from './color.mjs'
import { compare } from './glob.mjs'
import { CLASS_LIBRARIES, aliasPath, cssVarFor, isAlias } from './source.mjs'

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
  const proposed = []
  for (const cl of audit?.colorClusters ?? []) {
    const c = parseColor(cl.representative)
    if (!c || c.a === 0) continue
    // A colour only ever used inside a shadow belongs to the shadow token.
    const roles = Object.keys(cl.roles ?? {})
    if (roles.length > 0 && roles.every((r) => r === 'shadow')) continue
    // Never set as a style anywhere: data in a script (an avatar palette, a chart's series).
    if (roles.length > 0 && roles.every((r) => r === 'other')) {
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
    if (cl.count < minCount) {
      outliers.push({ family: 'color', value: cl.representative, count: cl.count, note: 'used once; use a token instead, or keep it with a reason' })
      continue
    }
    // A translucent colour is an overlay, named by its base and opacity
    // (black-12, white-6, blue-20); a solid one a ramp step by lightness. When
    // the nearest standard step is taken, the step between that its lightness
    // gives (85, 435…) keeps the ramp in order; a repeated name gets a suffix.
    const family = groupFor(c.a < 1 ? 'overlay' : familyOf(c))
    const { L } = oklch(c)
    const taken = used.get(family) ?? new Set()
    const free = (s) => !taken.has(s) && !owned.has(cssVarFor(['color', family, s]))
    let step
    if (family.startsWith('overlay')) {
      const solid = { ...c, a: 1 }
      const base = familyOf(solid) !== 'neutral' ? familyOf(solid) : oklch(solid).L > 0.9 ? 'white' : oklch(solid).L < 0.25 ? 'black' : 'neutral'
      const name = `${base}-${Math.round(c.a * 100)}`
      step = name
      for (let i = 2; !free(step); i++) step = `${name}-${i}`
    } else {
      const nearest = String(STEPS.slice().sort((x, y) => Math.abs(x[1] - L) - Math.abs(y[1] - L))[0][0])
      if (free(nearest)) {
        step = nearest
      } else {
        let n = Math.min(995, Math.max(5, Math.round(stepAt(L) / 5) * 5))
        while (!free(String(n)) && n < 995) n += 5
        while (!free(String(n))) n -= 5
        step = String(n)
      }
    }
    taken.add(step)
    used.set(family, taken)
    const path = ['color', family, step]
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

// daisyUI's built-in themes, which an app picks in `@plugin "daisyui"`:
// where their colours live and how to own them, said in place of the notes
// below, since those colours have names and themes the sources never show.
function daisyNote(daisy, classes) {
  const and = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0])
  const role = (t) => (t.default && t.prefersdark ? ' (the default, also used when the system prefers dark)' : t.default ? ' (the default)' : t.prefersdark ? ' (used when the system prefers dark)' : '')
  const picked = daisy.all ? 'every daisyUI built-in theme (themes: all)' : `daisyUI's built-in ${daisy.themes.length === 1 ? 'theme' : 'themes'} ${and(daisy.themes.map((t) => `${t.name}${role(t)}`))}`
  const where = daisy.all ? 'theme/<name>.css' : and(daisy.themes.map((t) => `theme/${t.name}.css`))
  const top = (classes?.top ?? []).map((c) => c.name)
  const palette = classes?.count > 0 ? ` Apart from those, the code uses ${classes.count} Tailwind palette ${classes.count === 1 ? 'class' : 'classes'}${top.length ? ` (most used: ${and(top)})` : ''}, which extract does not turn into tokens.` : ''
  return `No semantic colour is proposed from the app's themes: it takes its colours from ${picked}, which @plugin "daisyui" names in ${daisy.file}. Their values live in the daisyui package (${where}), not in this repo, under daisyUI's colour names: ${and(CLASS_LIBRARIES.daisyui.colors)}. To own them as tokens, copy each theme's values into semantic colour tokens when reviewing colour semantics, one theme per mode, and map daisyUI's names onto them with a @plugin "daisyui/theme" block per theme.${palette}`
}

// What the colour proposal leaves out, and why: no semantic colour (text,
// background, border, accent), or no theme beyond the default when the
// default is not dark itself. Said only when the repo has colours at all:
// tokens, or Tailwind palette classes. An app on daisyUI's built-in themes
// gets one note on those themes instead.
function colorGaps(existing, colors, audit, minCount, defaultMode, daisy = null) {
  const classes = audit?.colorClasses
  if (daisy) return [daisyNote(daisy, classes)]
  const all = [...existing, ...colors].filter((t) => t.type === 'color')
  if (all.length === 0 && !(classes?.count > 0)) return []
  const notes = []
  const many = (n, one, more) => `${n} ${n === 1 ? one : more}`
  const named = existing.some((t) => (t.type === 'color' || isAlias(t.value)) && describeByName(key(t.path)))
  // A colour the sources already alias to another is a semantic layer of
  // their own, whatever its name (--card: var(--gray-50)).
  const aliased = existing.some((t) => t.type === 'color' && [t.value, ...Object.values(t.modes ?? {})].some(isAlias))
  if (!named && !aliased && !colors.some((t) => isAlias(t.value))) {
    const top = (classes?.top ?? []).map((c) => c.name)
    const examples = top.length > 1 ? `${top.slice(0, -1).join(', ')} and ${top[top.length - 1]}` : top[0]
    const why = classes?.count > 0
      ? `the code sets its colours with ${many(classes.count, 'Tailwind palette class', 'Tailwind palette classes')}${examples ? ` (most used: ${examples})` : ''}, which extract does not turn into semantic tokens, and the sources name no colour by its job`
      : `the sources name no colour by its job (such as bg, text or border), and the code uses no raw colour as a background, text or border ${minCount} times or more`
    notes.push(`No semantic colour is proposed: ${why}. Add the text, background, border and accent tokens when reviewing colour semantics, each an alias of a primitive.`)
  }
  if (defaultMode !== 'dark' && !all.some((t) => Object.keys(t.modes ?? {}).length > 0)) {
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
function emLengths(audit, category) {
  const byValue = new Map()
  const byPx = new Map()
  for (const f of audit?.findings ?? []) {
    if (f.category !== category) continue
    const written = f.kind === 'arbitrary' ? /\[(.*)\]/.exec(f.value)?.[1] : f.value
    if (!/^-?\d*\.?\d+em$/.test(written ?? '')) continue
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

function proposeSpacing(existing, audit, report, outliers, minCount, tailwind) {
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
    if (have.size >= 3) {
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
function proposeRadius(existing, audit, report, outliers, minCount, tailwind) {
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
    if (count < minCount || have.size >= 3) {
      outliers.push({ family: 'radius', value: `${px}px`, count, note: have.size >= 3 ? 'not on the existing radius scale' : 'used once' })
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

function proposeType(existing, audit, typeSteps, report, outliers, minCount, tailwind) {
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
  // Three or more sizes in the sources are a scale; fewer leave gaps to fill.
  const onScale = haveSizes.size < 3
  // The body size: the one a body, html or :root rule sets, else the most used.
  const ruled = audit?.forExtract?.bodySize ?? null
  const em = emLengths(audit, 'type')
  const typeSizes = withoutEm(audit?.typeSizes ?? [], em)
  const body = ruled?.px ?? [...typeSizes].sort((a, b) => b.count - a.count || Math.abs(a.px - 16) - Math.abs(b.px - 16) || a.px - b.px)[0]?.px ?? 16
  // A size the body rule sets is kept even when the code repeats it nowhere else.
  const kept = (s) => s.count >= minCount || s.px === ruled?.px
  const sizes = typeSizes.filter((s) => kept(s) && !haveSizes.has(s.px) && onScale).sort((a, b) => a.px - b.px)
  for (const s of typeSizes.filter((s) => !haveSizes.has(s.px) && (!kept(s) || !onScale))) {
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
  for (const [name, s] of named) {
    const path = ['font', 'size', name]
    out.push({ path, type: 'dimension', value: rem(s.px), modes: {}, description: '', source: 'audit' })
    const bodyNote = ruled ? `the body size, set on ${ruled.selector} in ${ruled.file}` : 'the most used size, taken as the body size'
    const note = tailwind ? (TAILWIND_TEXT[s.px] ? `Tailwind's text-${name}` : "off Tailwind's scale, named by its size") : name === 'base' ? bodyNote : ''
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
    const lineHeight = (() => {
      if (step?.lineHeight !== undefined) {
        const lh = pxOf(step.lineHeight)
        return lh !== null ? Number((lh / px).toFixed(4)) : Number(step.lineHeight)
      }
      const tw = tailwind && size.source === 'audit' && TAILWIND_TEXT[px]
      if (tw) {
        const lh = tw[1] === 1 ? 1 : Number((tw[1] / px).toFixed(4))
        assumed.push(`line height ${lh}, Tailwind's for text-${tw[0]}`)
        return lh
      }
      const common = px >= 24 ? headingLeading : bodyLeading
      if (common !== undefined) {
        assumed.push(`line height ${common}, the most used for ${px >= 24 ? 'headings' : 'body text'}`)
        return common
      }
      assumed.push(`line height ${px >= 24 ? 1.2 : 1.5}, as the code sets none for ${px >= 24 ? 'headings' : 'body text'}`)
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
  const colors = proposeColors(existing, audit, report, outliers, minCount)
  const daisy = sources.map((s) => s.daisyThemes).find(Boolean) ?? null
  notes.push(...colorGaps(existing, colors, audit, minCount, defaultMode, daisy))
  const typeSteps = sources.flatMap((s) => s.typeSteps ?? [])
  const tailwind = (styling ?? []).some((s) => /^tailwind/.test(s))
  // The Tailwind version, for the scales whose names changed in Tailwind 4.
  const tailwindVersion = !tailwind ? null : (styling ?? []).includes('tailwind3') && !(styling ?? []).includes('tailwind4') ? 'tailwind3' : 'tailwind4'
  const out = [
    ...existing,
    ...colors,
    ...proposeType(existing, audit, typeSteps, report, outliers, minCount, tailwind),
    ...proposeSpacing(existing, audit, report, outliers, minCount, tailwind),
    ...proposeRadius(existing, audit, report, outliers, minCount, tailwindVersion),
  ]
  out.push(...proposeRest(existing, audit, out.filter((t) => t.type === 'color'), report, outliers, minCount, fromCss, tailwind))
  sizeOutliers(audit, outliers, minCount)
  return { tokens: out, report, outliers, notes }
}
