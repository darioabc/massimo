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
import { colorModes } from './color.mjs'
import { stripJsonComments } from './project.mjs'
import { isAlias, parseCustomProperties, splitVarName } from './source.mjs'
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

// Every custom property the style files declare outside a component's own
// selector, by name, with its value per theme. A light-dark() value splits
// into its two themes.
export function readCss(root, files) {
  const entries = new Map()
  for (const file of files) {
    for (const p of parseCustomProperties(readFileSync(join(root, file), 'utf8'), file)) {
      if (p.scope === 'local' || p.name.startsWith('--tw-')) continue
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
  const idOf = new Map()
  for (const name of entries.keys()) {
    const { group, rest } = splitVarName(name)
    idOf.set(name, [group, rest || 'base'])
  }
  const aliasOf = (value) => {
    const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)
    const id = m && idOf.get(m[1])
    return id ? `{${id.join('.')}}` : value
  }
  const tokens = []
  for (const name of [...entries.keys()].sort(natural)) {
    const e = entries.get(name)
    const path = idOf.get(name)
    const first = e.default ?? Object.values(e.modes)[0]
    const t = token(path, { value: aliasOf(first), cssVar: name, source: e.source })
    // A theme that repeats the default adds nothing; with no default, the first theme is it.
    const extra = e.default !== undefined ? Object.entries(e.modes) : Object.entries(e.modes).slice(1)
    for (const [mode, v] of extra) if (aliasOf(v) !== t.value) t.modes[mode] = aliasOf(v)
    const channels = !isAlias(t.value) && channelColor(t.value)
    if (channels) {
      t.type = 'color'
      t.css = channels.css
      t.value = channels.value
      for (const [mode, v] of Object.entries(t.modes)) {
        const c = !isAlias(v) && channelColor(v)
        if (c) {
          t.modes[mode] = c.value
          t.cssModes = { ...(t.cssModes ?? {}), [mode]: c.css }
        }
      }
    }
    tokens.push(t)
  }
  return { tokens, notes: [], count: entries.size }
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
      const t = token(path, { type, value: value(v.values?.[first]), description: v.description ?? '', source: file })
      for (const m of others) if (JSON.stringify(v.values?.[m]) !== JSON.stringify(v.values?.[first])) t.modes[m.toLowerCase()] = value(v.values?.[m])
      tokens.push(t)
    }
  }
  return { tokens, notes, defaultMode: collections[0]?.modes?.[0]?.toLowerCase() ?? null }
}
