// Where an existing repo already keeps design values, read into one shape so
// they can be proposed as tokens: CSS custom properties (with themes, @theme,
// DaisyUI themes, light-dark() and channel triplets), a Tailwind 3 config, a
// CSS-in-JS or JS theme object, an existing DTCG or Tokens Studio file, and
// Figma variables exported as JSON. JavaScript is read as text, never run.
//
// Every reader returns { tokens, notes }. A token is
//   { path, type, value, modes, css, cssVar, description, source }
// with `value` and `modes` as CSS text or a DTCG value, `type` when the source
// says it (null to be typed later from the value), `css` when the exact CSS
// differs from what the value converts to (an RGB channel triplet), `cssVar`
// when the source has one, and `source` naming the file. `notes` are plain
// sentences about what was skipped and why.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { colorModes, parseColor } from './color.mjs'
import { stripJsonComments } from './project.mjs'
import { isAlias, parseCustomProperties } from './source.mjs'
import { cssVarOf } from './figma.mjs'
import { findObject, leaves } from './jsobject.mjs'
import { natural } from './text.mjs'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const token = (path, fields) => ({ path, type: null, value: undefined, modes: {}, css: null, cssVar: null, description: '', source: '', ...fields })

// ── CSS custom properties ──────────────────────────────────────────────────

const CHANNELS_RGB = /^(\d{1,3}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)$/
const CHANNELS_HSL = /^(-?\d+(?:\.\d+)?(?:deg)?)\s+(\d+(?:\.\d+)?%)\s+(\d+(?:\.\d+)?%)$/

// A custom property holding only colour channels (`236 229 209`, or shadcn's
// `210 40% 98%`), which a stylesheet wraps as rgb(var(--x) / <alpha-value>):
// the colour it stands for, and the channels kept as its exact CSS.
export function channelColor(value) {
  const rgb = CHANNELS_RGB.exec(value)
  if (rgb && rgb.slice(1).every((n) => Number(n) <= 255)) return { value: `rgb(${value})`, css: value }
  if (CHANNELS_HSL.exec(value)) return { value: `hsl(${value})`, css: value }
  return null
}

// The group a custom property's token goes in, from the prefixes and
// suffixes systems name their families with: `--space-4` is spacing,
// `--dur-2` a duration, and `--h1-size` with `--h1-leading` a type step. A
// colour is known by its value instead, since its name rarely says so
// (`--sand-200`, `--c-text`).
const PREFIX_GROUPS = [
  [/^(?:color|colour|clr|c)(?:-|$)/, 'color'],
  [/^(?:spacing|space|sp|gap)(?:-|$)/, 'spacing'],
  [/^(?:radius|radii|rounded)(?:-|$)/, 'radius'],
  [/^(?:font-size|fs|text)(?:-|$)/, 'text'],
  [/^(?:font-weight|fw)(?:-|$)/, 'font-weight'],
  [/^(?:line-height|lh|leading)(?:-|$)/, 'leading'],
  [/^(?:letter-spacing|tracking)(?:-|$)/, 'tracking'],
  [/^(?:font-family|font|ff)(?:-|$)/, 'font'],
  [/^(?:shadow|elevation)(?:-|$)/, 'shadow'],
  [/^(?:duration|dur)(?:-|$)/, 'duration'],
  [/^(?:easing|ease)(?:-|$)/, 'ease'],
  [/^(?:z-index|z|layer)(?:-|$)/, 'z'],
  [/^opacity(?:-|$)/, 'opacity'],
  [/^(?:border-width|stroke)(?:-|$)/, 'border-width'],
  [/^size(?:-|$)/, 'size'],
]
const SUFFIX_GROUPS = [
  [/-(?:font-size|size|fs)$/, 'text'],
  [/-(?:line-height|leading|lh)$/, 'leading'],
  [/-(?:letter-spacing|tracking)$/, 'tracking'],
  [/-(?:font-weight|weight)$/, 'font-weight'],
]
const WRAPPED = /^(rgba?|hsla?)\(\s*var\(\s*(--[\w-]+)\s*\)\s*(?:\/\s*(\d*\.?\d+%?)\s*)?\)$/
const VAR = /^var\(\s*(--[\w-]+)\s*\)$/
const CLAMP = /^clamp\(\s*(-?\d*\.?\d+(?:px|rem))\s*,[^,]+,\s*(-?\d*\.?\d+(?:px|rem))\s*\)$/

// Every custom property the style files declare outside a component's own
// selector, by name, with its value per theme. A light-dark() value splits
// into its two themes. `rgb(var(--x))` over a channel triplet is a
// reference to it, and `rgb(var(--x) / 0.14)` the colour it makes in each
// theme, its exact CSS kept. A fluid clamp() size takes its largest value,
// its CSS kept too. Stems with a size and a line height, weight or tracking
// (`--h1-size`, `--h1-leading`) come back as type steps.
export function readCss(root, files) {
  const entries = new Map()
  // Values set only inside a component's scope or under a condition: said in
  // a note when the same property is a token, never taken as its value. A
  // property set only under a condition takes that value, with a note.
  const elsewhere = new Map()
  const onlyUnder = new Map()
  for (const file of files) {
    for (const p of parseCustomProperties(readFileSync(join(root, file), 'utf8'), file)) {
      if (p.name.startsWith('--tw-')) continue
      if (p.scope === 'conditional') {
        const e = onlyUnder.get(p.name) ?? { default: undefined, modes: {}, source: file, condition: p.condition }
        if (p.condition === e.condition) {
          if (p.mode === 'default') e.default ??= p.value
          else e.modes[p.mode] ??= p.value
        }
        onlyUnder.set(p.name, e)
      }
      if (p.scope === 'local' || p.scope === 'conditional') {
        const list = elsewhere.get(p.name) ?? []
        const where = p.scope === 'conditional' ? `${p.condition} ${p.selector}` : p.selector
        if (!list.some((x) => x.where === where)) list.push({ where, conditional: p.scope === 'conditional' })
        elsewhere.set(p.name, list)
        continue
      }
      const e = entries.get(p.name) ?? { default: undefined, modes: {}, source: file }
      const split = colorModes(p.value)
      if (split && p.mode === 'default') {
        e.default = split.light
        e.modes.dark ??= split.dark
      } else if (p.mode === 'default') {
        e.default = p.value
      } else {
        e.modes[p.mode] = p.value
      }
      entries.set(p.name, e)
    }
  }
  const notes = []
  for (const [name, e] of [...onlyUnder].sort((a, b) => natural(a[0], b[0]))) {
    if (entries.has(name)) continue
    entries.set(name, e)
    elsewhere.delete(name)
    notes.push(`${name} is set only under ${e.condition}; its token takes that value`)
  }
  for (const [name, list] of [...elsewhere].sort((a, b) => natural(a[0], b[0]))) {
    if (!entries.has(name)) continue
    const conditional = list.filter((x) => x.conditional).map((x) => x.where)
    const scoped = list.filter((x) => !x.conditional).map((x) => x.where)
    const few = (l) => `${l.slice(0, 3).join(', ')}${l.length > 3 ? ` and ${l.length - 3} more` : ''}`
    if (conditional.length) notes.push(`${name} is also set under ${few(conditional)}; its token holds the value outside that, and massimo's outputs do not write the override`)
    if (scoped.length) notes.push(`${name} is also set inside ${few(scoped)}; its token holds the page's value`)
  }
  const allModes = [...new Set([...entries.values()].flatMap((e) => Object.keys(e.modes)))]
  const valueIn = (name, mode) => {
    const e = entries.get(name)
    return e && (e.modes[mode] ?? e.default ?? Object.values(e.modes)[0])
  }
  // The channel triplet a property holds in a theme, through var() chains.
  const channelsOf = (name, mode, depth = 0) => {
    const v = valueIn(name, mode)
    if (v === undefined || depth > 8) return null
    if (channelColor(v)) return v
    const m = VAR.exec(v)
    return m ? channelsOf(m[1], mode, depth + 1) : null
  }
  const colorish = (name, depth = 0) => {
    const v = valueIn(name, 'default')
    if (v === undefined || depth > 8) return false
    if (channelColor(v) || parseColor(v) || /^(?:color-mix|light-dark)\(/.test(v)) return true
    const m = VAR.exec(v) ?? WRAPPED.exec(v)
    return m ? (m[2] ? channelsOf(m[2], 'default') !== null : colorish(m[1], depth + 1)) : false
  }
  // Stems that two type suffixes share (`--h1-size` and `--h1-leading`).
  const stems = new Map()
  for (const name of entries.keys()) {
    const bare = name.slice(2)
    for (const [re, group] of SUFFIX_GROUPS) {
      if (!re.test(bare)) continue
      const stem = bare.replace(re, '')
      stems.set(stem, new Set([...(stems.get(stem) ?? []), group]))
    }
  }
  const idOf = new Map()
  const taken = new Set()
  for (const name of [...entries.keys()].sort(natural)) {
    const bare = name.slice(2)
    let path
    if (colorish(name)) {
      path = ['color', bare.replace(/^(?:color|colour|clr|c)(?:-|$)/, '')]
    } else {
      const prefix = PREFIX_GROUPS.find(([re]) => re.test(bare))
      const suffix = SUFFIX_GROUPS.find(([re]) => re.test(bare))
      if (prefix && prefix[1] !== 'color') path = [prefix[1], bare.replace(prefix[0], '')]
      else if (suffix && stems.get(bare.replace(suffix[0], ''))?.size >= 2) path = [suffix[1], bare.replace(suffix[0], '')]
      else path = ['other', bare]
    }
    if (!path[1]) path[1] = 'base'
    // Two properties with one name after their prefix keep their whole names.
    if (taken.has(path.join('.'))) path = [path[0] === 'other' ? 'other' : path[0], bare]
    if (taken.has(path.join('.'))) path = ['other', bare]
    taken.add(path.join('.'))
    idOf.set(name, path)
  }
  const aliasOf = (value) => {
    const m = VAR.exec(value)
    if (m && idOf.get(m[1])) return `{${idOf.get(m[1]).join('.')}}`
    const w = WRAPPED.exec(value)
    if (w && !w[3] && idOf.get(w[2]) && channelsOf(w[2], 'default') !== null) return `{${idOf.get(w[2]).join('.')}}`
    return value
  }
  // `rgb(var(--x) / 0.14)`: the colour it makes in a theme.
  const withAlpha = (value, mode) => {
    const w = WRAPPED.exec(value)
    if (!w || !w[3]) return null
    const channels = channelsOf(w[2], mode)
    return channels ? `${w[1].replace(/a$/, '')}(${channels} / ${w[3]})` : null
  }
  const tokens = []
  const typeSteps = []
  for (const name of [...entries.keys()].sort(natural)) {
    const e = entries.get(name)
    const path = idOf.get(name)
    const first = e.default ?? Object.values(e.modes)[0]
    const t = token(path, { value: aliasOf(first), cssVar: name, source: e.source })
    // A theme that repeats the default adds nothing; with no default, the first theme is it.
    const extra = e.default !== undefined ? Object.entries(e.modes) : Object.entries(e.modes).slice(1)
    for (const [mode, v] of extra) if (aliasOf(v) !== t.value) t.modes[mode] = aliasOf(v)
    // Each theme's value on its own terms: channels, or rgb(var(--x) / a).
    const colorFrom = (v, mode) => {
      if (isAlias(v)) return null
      const c = channelColor(v)
      if (c) return c
      const w = withAlpha(v, mode)
      return w ? { value: w, css: v } : null
    }
    const own = colorFrom(t.value, 'default')
    if (own) Object.assign(t, { type: 'color', css: own.css, value: own.value })
    // rgb(var(--x)) became a reference to --x, which holds channels: the CSS
    // keeps the wrapper, so the variable still holds a colour.
    if (isAlias(t.value) && WRAPPED.test(first.trim())) t.css = first.trim()
    for (const [mode, v] of Object.entries(t.modes)) {
      const raw = e.modes[mode]
      if (isAlias(v) && raw !== undefined && WRAPPED.test(raw.trim())) t.cssModes = { ...(t.cssModes ?? {}), [mode]: raw.trim() }
      const c = colorFrom(v, mode)
      if (!c) continue
      t.type = 'color'
      t.modes[mode] = c.value
      t.cssModes = { ...(t.cssModes ?? {}), [mode]: c.css }
    }
    // rgb(var(--x) / a) with no value of its own in a theme follows --x there.
    if (withAlpha(first, 'default')) {
      for (const mode of allModes) {
        if (mode in e.modes) continue
        const v = withAlpha(first, mode)
        if (v && v !== t.value) {
          t.modes[mode] = v
          t.cssModes = { ...(t.cssModes ?? {}), [mode]: first }
        }
      }
    }
    const fluid = typeof t.value === 'string' && CLAMP.exec(t.value)
    if (fluid) {
      t.css = t.value
      t.value = fluid[2]
      notes.push(`${name} is fluid (${t.css}); its token holds the largest size, ${fluid[2]}, and the CSS output keeps the clamp()`)
    }
    tokens.push(t)
  }
  for (const [stem, groups] of stems) {
    if (!groups.has('text') || groups.size < 2) continue
    const size = tokens.find((t) => t.cssVar && idOf.get(t.cssVar)?.join('.') === `text.${stem}`)
    if (!size) continue
    const part = (group) => tokens.find((t) => t.path[0] === group && t.path[1] === stem)
    const step = { path: size.path, source: size.source }
    const lh = part('leading')
    if (lh && !isAlias(lh.value)) step.lineHeight = lh.value
    const w = part('font-weight')
    if (w && /^\d{3}$/.test(String(w.value))) Object.assign(step, { fontWeight: w.value, fontWeightRef: `{${w.path.join('.')}}` })
    const tr = part('tracking')
    const sizePx = /^(-?\d*\.?\d+)(px|rem)$/.exec(String(size.value))
    const em = tr && /^(-?\d*\.?\d+)em$/.exec(String(tr.value))
    if (em && sizePx) step.letterSpacing = `${Number((Number(em[1]) * Number(sizePx[1]) * (sizePx[2] === 'rem' ? 16 : 1)).toFixed(3))}px`
    else if (tr && /^-?\d*\.?\d+(px|rem)$/.test(String(tr.value))) step.letterSpacing = tr.value
    typeSteps.push(step)
  }
  return { tokens, notes, typeSteps, count: entries.size }
}

// ── A Tailwind 3 config ────────────────────────────────────────────────────

// Theme sections and the token group each becomes.
const TAILWIND_SECTIONS = {
  colors: ['color', 'color'],
  spacing: ['spacing', 'dimension'],
  borderRadius: ['radius', 'dimension'],
  fontFamily: ['font', 'fontFamily'],
  fontSize: ['text', 'dimension'],
  fontWeight: ['font-weight', 'fontWeight'],
  lineHeight: ['leading', null],
  letterSpacing: ['tracking', 'dimension'],
  boxShadow: ['shadow', 'shadow'],
  borderWidth: ['border-width', 'dimension'],
  transitionDuration: ['duration', 'duration'],
  transitionTimingFunction: ['ease', 'cubicBezier'],
  zIndex: ['z', 'number'],
  opacity: ['opacity', 'number'],
}

// A value as the reader passes it on: `rgb(var(--x) / <alpha-value>)` and
// `var(--x)` become a reference to the custom property, resolved later.
function cssValue(v) {
  if (typeof v === 'number') return String(v)
  if (typeof v !== 'string') return null
  const wrapped = /^(?:rgba?|hsla?|oklch|oklab)\(\s*var\(\s*(--[\w-]+)\s*\)\s*(?:\/\s*<alpha-value>\s*)?\)$/.exec(v.trim())
  if (wrapped) return `var(${wrapped[1]})`
  return v.trim()
}

// The theme a Tailwind 3 config sets (both `theme` and `theme.extend`), read
// as text. Spreads of Tailwind's own defaults and anything computed are
// skipped and named in the notes; nothing in the file is run.
export function readTailwindConfig(root, file) {
  const src = readFileSync(join(root, file), 'utf8')
  const config = findObject(src, [/export\s+default\s*(?:defineConfig\(\s*|\{\s*\.\.\.)?/, /module\.exports\s*=\s*/, /defineConfig\(\s*/, /const\s+config(?:\s*:\s*[\w.]+)?\s*=\s*/])
  const notes = []
  if (!config) return { tokens: [], notes: [`${file}: no config object found to read`] }
  const theme = isObject(config.theme) ? config.theme : {}
  const tokens = []
  const typeSteps = []
  for (const layer of [theme, isObject(theme.extend) ? theme.extend : {}]) {
    for (const [section, [group, type]] of Object.entries(TAILWIND_SECTIONS)) {
      const values = layer[section]
      if (values === undefined) continue
      if (!isObject(values)) {
        notes.push(`${file}: theme.${section} is ${values?.expr ? `computed (${values.expr})` : 'not an object'}, so it was skipped`)
        continue
      }
      for (const [path, v] of leaves(values)) {
        const at = [group, ...path.map((p) => (p === 'DEFAULT' ? '$root' : p))]
        if (v && typeof v === 'object' && ('expr' in v || 'spread' in v)) {
          notes.push(`${file}: theme.${section}.${path.join('.')} is computed (${v.expr ?? v.spread}), so it was skipped`)
          continue
        }
        if (section === 'fontFamily') {
          const list = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string')
          const skipped = (Array.isArray(v) ? v : []).filter((x) => typeof x !== 'string')
          if (skipped.length) notes.push(`${file}: theme.${section}.${path.join('.')} spreads ${skipped.map((x) => x.spread ?? x.expr).join(', ')}, which was left out`)
          if (list.length) tokens.push(token(at, { type, value: list, source: file }))
          continue
        }
        if (section === 'fontSize' && Array.isArray(v)) {
          // [size, lineHeight] or [size, { lineHeight, letterSpacing, fontWeight }]: a type step.
          const [size, extra] = v
          tokens.push(token(at, { type, value: cssValue(size), source: file }))
          typeSteps.push({ path: at, size: cssValue(size), ...(isObject(extra) ? extra : typeof extra === 'string' ? { lineHeight: extra } : {}) })
          continue
        }
        if (Array.isArray(v)) {
          notes.push(`${file}: theme.${section}.${path.join('.')} is a list, so it was skipped`)
          continue
        }
        const value = cssValue(v)
        if (value === null || /^(currentColor|inherit|transparent|current)$/i.test(value)) continue
        tokens.push(token(at, { type, value, source: file }))
      }
    }
  }
  return { tokens, notes, typeSteps }
}

// ── A JS or TS theme object (CSS-in-JS) ────────────────────────────────────

// Common theme keys and the token group each becomes.
const THEME_KEYS = [
  [/^(colors?|palette)$/i, 'color', 'color'],
  [/^(space|spacing|spaces)$/i, 'spacing', 'dimension'],
  [/^(radii|radius|borderRadius|shape)$/i, 'radius', 'dimension'],
  [/^(fonts|fontFamily|fontFamilies)$/i, 'font', 'fontFamily'],
  [/^(fontSizes|fontSize)$/i, 'text', 'dimension'],
  [/^(fontWeights|fontWeight)$/i, 'font-weight', 'fontWeight'],
  [/^(lineHeights|lineHeight)$/i, 'leading', null],
  [/^(letterSpacings|letterSpacing)$/i, 'tracking', 'dimension'],
  [/^(shadows|boxShadow|elevation)$/i, 'shadow', 'shadow'],
  [/^(zIndices|zIndex)$/i, 'z', 'number'],
  [/^(durations|duration)$/i, 'duration', 'duration'],
  [/^(easings|easing|transitions?)$/i, 'ease', 'cubicBezier'],
]

// The first theme-like object in a JS or TS file (`createTheme({…})`,
// `export const theme = {…}`, `export default {…}`), read as text.
export function readThemeObject(root, file) {
  const src = readFileSync(join(root, file), 'utf8')
  const obj = findObject(src, [
    /(?:createTheme|extendTheme|createStitches|defineConfig|defineTokens|createGlobalTheme|createThemeContract)\s*\(\s*(?:[\w.]+\s*,\s*)?/,
    /export\s+const\s+(?:theme|tokens)\w*(?:\s*:\s*[\w.<>]+)?\s*=\s*/,
    /const\s+(?:theme|tokens)\w*(?:\s*:\s*[\w.<>]+)?\s*=\s*/,
    /export\s+default\s*/,
    /module\.exports\s*=\s*/,
  ])
  const notes = []
  if (!obj) return { tokens: [], notes: [`${file}: no theme object found to read`] }
  const root_ = isObject(obj.theme) ? obj.theme : isObject(obj.tokens) ? obj.tokens : obj
  const tokens = []
  for (const [key, section] of Object.entries(root_)) {
    if (/^(breakpoints|screens|media|mq)$/i.test(key)) {
      notes.push(`${file}: ${key} are breakpoints, which massimo does not read as tokens`)
      continue
    }
    if (section && typeof section === 'object' && ('expr' in section || 'spread' in section)) {
      notes.push(`${file}: ${key} is computed (${section.expr ?? section.spread}), so it was skipped`)
      continue
    }
    const match = THEME_KEYS.find(([re]) => re.test(key))
    const [group, type] = match ? [match[1], match[2]] : ['other', null]
    const entries = isObject(section) ? leaves(section) : [[[], section]]
    for (const [path, v] of entries) {
      const at = [group, ...(match ? path : [key, ...path])].filter((p) => p !== undefined)
      if (v && typeof v === 'object' && ('expr' in v || 'spread' in v)) {
        notes.push(`${file}: ${[key, ...path].join('.')} is computed (${v.expr ?? v.spread}), so it was skipped`)
        continue
      }
      if (typeof v === 'function' || v === null || typeof v === 'boolean') continue
      if (Array.isArray(v)) {
        if (type === 'fontFamily' && v.every((x) => typeof x === 'string')) tokens.push(token(at, { type, value: v, source: file }))
        else notes.push(`${file}: ${[key, ...path].join('.')} is a list, so it was skipped`)
        continue
      }
      // A bare number in a spacing or size scale is pixels in most theme libraries.
      const value = typeof v === 'number' && type === 'dimension' ? `${v}px` : cssValue(v)
      if (value !== null) tokens.push(token(at.length > 1 ? at : [group, 'base'], { type, value, source: file }))
    }
  }
  return { tokens, notes }
}

// ── An existing token file: DTCG or Tokens Studio ──────────────────────────

// Tokens Studio's types, as DTCG types.
const STUDIO_TYPES = {
  color: 'color', sizing: 'dimension', spacing: 'dimension', borderRadius: 'dimension', borderWidth: 'dimension', dimension: 'dimension',
  fontSizes: 'dimension', letterSpacing: 'dimension', paragraphSpacing: 'dimension', fontFamilies: 'fontFamily', fontWeights: 'fontWeight',
  lineHeights: 'number', opacity: 'number', number: 'number', boxShadow: 'shadow', typography: 'typography', border: 'border',
}

// A Tokens Studio file (values and types without a $), as DTCG. Token sets
// merge in $metadata.tokenSetOrder; $themes, which pick sets, are named in the notes.
export function fromTokensStudio(doc, notes = [], file = '') {
  // A file with $metadata or $themes holds token sets; any other is one set.
  const order = Array.isArray(doc.$metadata?.tokenSetOrder)
    ? doc.$metadata.tokenSetOrder
    : Array.isArray(doc.$themes)
      ? Object.keys(doc).filter((k) => !k.startsWith('$'))
      : null
  const sets = order ? order.filter((k) => isObject(doc[k])).map((k) => doc[k]) : [doc]
  if (Array.isArray(doc.$themes) && doc.$themes.length > 0) notes.push(`${file}: Tokens Studio themes (${doc.$themes.map((t) => t.name).join(', ')}) choose sets; the sets were read in order, the themes were not`)
  const convert = (node) => {
    if (!isObject(node)) return node
    if ('value' in node && ('type' in node || !Object.values(node).some(isObject))) {
      const out = { $value: shadowFromStudio(node.value) }
      if (node.type) out.$type = STUDIO_TYPES[node.type] ?? node.type
      if (node.description) out.$description = node.description
      return out
    }
    return Object.fromEntries(Object.entries(node).filter(([k]) => !k.startsWith('$')).map(([k, v]) => [k, convert(v)]))
  }
  return sets.map(convert).reduce((a, b) => ({ ...a, ...b }), {})
}

// Tokens Studio writes a shadow as { x, y, blur, spread, color, type }.
function shadowFromStudio(v) {
  const one = (s) =>
    isObject(s) && 'x' in s && 'y' in s
      ? { color: s.color, offsetX: px(s.x), offsetY: px(s.y), blur: px(s.blur ?? 0), spread: px(s.spread ?? 0), ...(s.type === 'innerShadow' ? { inset: true } : {}) }
      : s
  return Array.isArray(v) ? v.map(one) : one(v)
}
const px = (n) => (typeof n === 'number' || /^-?\d*\.?\d+$/.test(String(n)) ? `${n}px` : String(n))

// Tokens Studio files carry $themes or $metadata, or tokens with `value` and no `$value`.
export function isTokensStudio(doc) {
  if (!isObject(doc)) return false
  if (Array.isArray(doc.$themes) || isObject(doc.$metadata)) return true
  const text = JSON.stringify(doc)
  return text.includes('"value":') && !text.includes('"$value":')
}

export function readJsonFile(root, file) {
  return JSON.parse(stripJsonComments(readFileSync(join(root, file), 'utf8')))
}

// ── Figma variables exported as JSON ───────────────────────────────────────

// A Figma variables export as tokens: the REST API's local variables
// (`meta.variables`, `meta.variableCollections`) or what massimo's
// read-library.js returns. Names with `/` become paths, the first mode is the
// default and the others become themes, aliases become references.
export function readFigmaExport(root, file) {
  const doc = readJsonFile(root, file)
  const notes = []
  const collections = []
  if (isObject(doc.meta?.variables)) {
    const byId = doc.meta.variables
    const cols = doc.meta.variableCollections ?? {}
    for (const c of Object.values(cols)) {
      const modes = c.modes ?? []
      const first = modes.find((m) => m.modeId === c.defaultModeId) ?? modes[0]
      const ordered = [first, ...modes.filter((m) => m !== first)].filter(Boolean)
      const variables = Object.values(byId)
        .filter((v) => v.variableCollectionId === c.id && !v.remote)
        .map((v) => ({
          name: v.name,
          type: v.resolvedType,
          scopes: v.scopes ?? [],
          description: v.description ?? '',
          codeSyntax: v.codeSyntax ?? {},
          values: Object.fromEntries(ordered.map((m) => {
            const raw = v.valuesByMode?.[m.modeId]
            return [m.name, raw?.type === 'VARIABLE_ALIAS' ? { alias: byId[raw.id]?.name ?? raw.id } : raw]
          })),
        }))
      collections.push({ name: c.name, modes: ordered.map((m) => m.name), variables })
    }
  } else if (Array.isArray(doc.collections)) {
    collections.push(...doc.collections)
  } else {
    return { tokens: [], notes: [`${file}: not a Figma variables export massimo knows`] }
  }
  // The CSS variable a variable's code syntax names goes to one variable only:
  // the one named like it, else the first (a scoped override such as
  // band-block/c-ground keeps its own name).
  const claims = new Map()
  for (const c of collections) {
    for (const v of c.variables ?? []) {
      const web = cssVarOf(v.codeSyntax?.WEB)
      if (web) claims.set(web, [...(claims.get(web) ?? []), v])
    }
  }
  const cssVarFor_ = new Map()
  for (const [web, list] of claims) {
    const bare = web.slice(2)
    const owner = list.find((v) => v.name === bare) ?? list.find((v) => v.name.split('/').pop() === bare) ?? list[0]
    cssVarFor_.set(owner, web)
    for (const v of list) if (v !== owner) notes.push(`${file}: ${v.name} also names ${web} in its code syntax; only ${owner.name} takes it`)
  }
  const tokens = []
  for (const c of collections) {
    const [first, ...others] = c.modes ?? Object.keys(c.variables?.[0]?.values ?? {})
    for (const v of c.variables ?? []) {
      const path = v.name.split('/').map((p) => p.trim()).filter(Boolean)
      const text = (raw) => {
        if (isObject(raw) && 'alias' in raw) return `{${String(raw.alias).split('/').join('.')}}`
        if (v.type === 'COLOR' && isObject(raw)) {
          const hex = (n) => Math.round(n * 255).toString(16).padStart(2, '0')
          return `#${hex(raw.r)}${hex(raw.g)}${hex(raw.b)}${(raw.a ?? 1) < 1 ? hex(raw.a) : ''}`
        }
        return raw
      }
      let type = { COLOR: 'color', STRING: null, BOOLEAN: undefined }[v.type]
      const scopes = v.scopes ?? []
      if (v.type === 'FLOAT') type = scopes.includes('FONT_WEIGHT') ? 'fontWeight' : scopes.includes('OPACITY') ? 'number' : 'dimension'
      if (v.type === 'STRING' && scopes.includes('FONT_FAMILY')) type = 'fontFamily'
      if (type === undefined) {
        notes.push(`${file}: ${v.name} is a ${v.type.toLowerCase()} variable, which has no design token`)
        continue
      }
      const value = (raw) => {
        const t = text(raw)
        return type === 'dimension' && typeof t === 'number' ? `${t}px` : t
      }
      const t = token(path, { type, value: value(v.values?.[first]), cssVar: cssVarFor_.get(v) ?? null, description: v.description ?? '', source: file })
      for (const m of others) if (JSON.stringify(v.values?.[m]) !== JSON.stringify(v.values?.[first])) t.modes[m.toLowerCase()] = value(v.values?.[m])
      tokens.push(t)
    }
  }
  return { tokens, notes, defaultMode: collections[0]?.modes?.[0]?.toLowerCase() ?? null }
}
