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
import { aliasPath, atRuleKind, classifyMember, interpolationEnd, isAlias, parseCssBlocks, parseCustomProperties, selectorMembers, stripComments } from './source.mjs'
import { cssVarOf } from './figma.mjs'
import { findObject, leaves, parseObjectAt } from './jsobject.mjs'
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
export const PREFIX_GROUPS = [
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
export const SUFFIX_GROUPS = [
  [/-(?:font-size|size|fs)$/, 'text'],
  [/-(?:line-height|leading|lh)$/, 'leading'],
  [/-(?:letter-spacing|tracking)$/, 'tracking'],
  [/-(?:font-weight|weight)$/, 'font-weight'],
]
const WRAPPED = /^(rgba?|hsla?)\(\s*var\(\s*(--[\w-]+)\s*\)\s*(?:\/\s*(\d*\.?\d+%?)\s*)?\)$/
const VAR = /^var\(\s*(--[\w-]+)\s*\)$/
const CLAMP = /^clamp\(\s*(-?\d*\.?\d+(?:px|rem))\s*,[^,]+,\s*(-?\d*\.?\d+(?:px|rem))\s*\)$/

// Sass functions that turn pixels into rem, by name without dashes or
// underscores: toRem(12), px-to-rem(12), rem-calc(12).
const REM_FUNCTIONS = new Set(['torem', 'rem', 'pxtorem', 'px2rem', 'remcalc', 'calcrem', 'converttorem'])
const REM_CALL = /^([A-Za-z][\w-]*)\(\s*(-?\d*\.?\d+)(?:px)?\s*(?:,\s*(\d*\.?\d+)(?:px)?\s*)?\)$/

// A value with Sass interpolation (`#{toRem(2)}`) as plain CSS, where every
// interpolation holds what can be read without running Sass: a literal (a
// number, a length, a colour, a quoted string) or a rem conversion of a
// number, at 16px a rem unless the call gives its own base. `{ value, rem }`,
// `rem` being 'assumed' when a call with no base of its own was read at
// 16px a rem; null when any part needs Sass.
export function sassValue(value) {
  let out = ''
  let rem = false
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '#' || value[i + 1] !== '{') {
      out += value[i]
      continue
    }
    const end = interpolationEnd(value, i)
    if (value[end] !== '}') return null
    const inner = value.slice(i + 2, end).trim()
    i = end
    const quoted = /^(['"])(.*)\1$/.exec(inner)
    if (quoted) out += quoted[2]
    else if (/^-?\d*\.?\d+(?:px|rem|em|%|ms|s|deg|vh|vw)?$/.test(inner) || parseColor(inner)) out += inner
    else {
      const call = REM_CALL.exec(inner)
      if (!call || !REM_FUNCTIONS.has(call[1].replace(/[-_]/g, '').toLowerCase())) return null
      const base = call[3] === undefined ? 16 : Number(call[3])
      if (!base) return null
      out += `${Number((Number(call[2]) / base).toFixed(4))}rem`
      if (call[3] === undefined) rem = 'assumed'
    }
  }
  return { value: out.replace(/\s+/g, ' ').trim(), rem }
}

// The page's own colours: the background and text colour a body, html or
// :root rule sets (the body's first), in the default theme and in the dark
// one (a dark theme's selector, alone or on the root, or the dark
// colour-scheme query around a root rule). A rule under any other condition,
// or one for a part of the page, does not count. Each colour is
// `{ value }` (a colour, or a var()) or `{ class }` (a Tailwind colour name
// from an @apply list, such as surface-900), with the selector and file
// that set it. Null when no rule sets one. In the default theme a plain
// root rule wins over a light theme's selector, as in readCss.
const PAGE_RANK = (member) => {
  const last = member.trim().split(/[\s>+~]+/).pop()
  return /^body\b/i.test(last) ? 0 : /^:root\b/i.test(last) ? 2 : 1
}
const TEXT_NOT_COLOR = /^(?:xs|sm|base|lg|[2-9]?xl|left|center|right|justify|start|end|ellipsis|clip|wrap|nowrap|balance|pretty|opacity-.+)$/
const BG_NOT_COLOR = /^(?:auto|cover|contain|center|top|bottom|left|right|left-.+|right-.+|fixed|local|scroll|none|repeat|no-repeat|repeat-.+|clip-.+|origin-.+|gradient-.+|opacity-.+|blend-.+)$/
function pageColors(root, files) {
  const page = {}
  const set = (mode, part, colour, rank, selector, file) => {
    const at = (page[mode] ??= {})
    if (at[part] && at[part].rank < rank) return
    at[part] = { ...colour, rank, selector, file }
  }
  for (const file of files) {
    for (const block of parseCssBlocks(readFileSync(join(root, file), 'utf8'), file)) {
      const around = block.headers.slice(0, -1).filter((h) => h.startsWith('@')).map(atRuleKind)
      if (around.some((r) => r.kind === 'condition')) continue
      const scheme = around.map((r) => r.mode).filter(Boolean).pop() ?? null
      const selectors = block.headers.filter((h) => !h.startsWith('@'))
      if (selectors.length === 0 || block.headers[block.headers.length - 1].startsWith('@')) continue
      let members = selectorMembers(selectors[0])
      for (const h of selectors.slice(1)) members = selectorMembers(h).flatMap((m) => members.map((p) => (m.includes('&') ? m.replace(/&/g, p) : `${p} ${m}`)))
      for (const member of members) {
        const c = classifyMember(member)
        const mode = c.scope === 'root' ? scheme ?? 'default' : c.scope === 'selector' && ['default', 'dark'].includes(c.mode) ? c.mode : null
        if (!mode) continue
        // In the default theme a body, html or :root rule is the page, and a
        // light theme's selector (.light, .light body) comes after it.
        const rank = PAGE_RANK(member) + (mode === 'default' && c.scope !== 'root' ? 3 : 0)
        for (const { prop, value } of block.decls) {
          if (prop === '@apply') {
            // bg-* and text-* colour classes, and their dark: variants; any
            // other variant (hover:, md:) or an opacity modifier is not the page.
            for (const raw of value.split(/\s+/)) {
              const m = /^(?:(dark):)?!?(bg|text)-(.+?)!?$/.exec(raw)
              if (!m || m[3].includes('/') || (m[2] === 'text' ? TEXT_NOT_COLOR : BG_NOT_COLOR).test(m[3])) continue
              const arbitrary = /^\[(?:color:)?([^:\]]+)\]$/.exec(m[3])?.[1]
              if (m[3].startsWith('[') && !arbitrary) continue
              const colour = arbitrary ? { value: arbitrary.replace(/_/g, ' ') } : { class: m[3] }
              if (colour.value && !parseColor(colour.value) && !VAR.test(colour.value)) continue
              set(m[1] ? 'dark' : mode, m[2] === 'bg' ? 'background' : 'color', colour, rank, member, file)
            }
            continue
          }
          if (!['background', 'background-color', 'color'].includes(prop)) continue
          const v = value.trim()
          if (!(parseColor(v)?.a > 0) && !VAR.test(v)) continue
          set(mode, prop === 'color' ? 'color' : 'background', { value: v }, rank, member, file)
        }
      }
    }
  }
  for (const mode of Object.values(page)) for (const part of Object.values(mode)) delete part.rank
  return Object.keys(page).length > 0 ? page : null
}

// The custom properties of one style file, those whose name holds Sass
// interpolation (`--#{$prefix}radius`) too.
const styleProperties = (css, file) => parseCustomProperties(css, file, { interpolated: true })

// Every custom property the style files declare outside a component's own
// selector, by name, with its value per theme. A light-dark() value splits
// into its two themes. `rgb(var(--x))` over a channel triplet is a
// reference to it, and `rgb(var(--x) / 0.14)` the colour it makes in each
// theme, its exact CSS kept. A fluid clamp() size takes its largest value,
// its CSS kept too. Stems with a size and a line height, weight or tracking
// (`--h1-size`, `--h1-leading`) come back as type steps. `parse` reads one
// file's properties, by default with the ones whose name holds Sass
// interpolation, which are named in a note; the token mirror passes one that
// places each selector by the config's theme selectors instead of by the
// names themes usually have.
//
// Two places that set one property for the same mode with different values
// (a dark :root and its :root[data-theme='light'] override, which both read
// as the default theme, or two files): the token keeps the first value, from
// its own file, and a note names both selectors and files. A plain root
// block is the exception: it is the default theme, so its value replaces one
// a light theme's selector set before it, with the same note. The same
// selector again in the same file is the cascade's own override, so the
// later value replaces the earlier one. The dark side of light-dark() gives
// way to a value the dark theme sets itself; two light-dark() values from
// two places keep the first dark side, with the note. `cascade` makes every
// later value replace the earlier one, for the mirror, which has already
// chosen one selector per theme. `skipWiring` leaves out Tailwind 4's
// wiring of the colours, for a repo the tailwind4 output wires instead (see
// below).
export function readCss(root, files, parse = styleProperties, { cascade = false, skipWiring = false } = {}) {
  const entries = new Map()
  // Properties set anywhere outside an @theme block.
  const outsideTheme = new Set()
  // Where each mode's value of a property was set, and the values left out
  // because another place's value was kept, by the two places.
  const setBy = new Map()
  const clashes = new Map()
  const clash = (mode, kept, left, name) => {
    const pair = `${mode}\n${kept.selector}\n${kept.file}\n${left.selector}\n${left.file}`
    const c = clashes.get(pair) ?? { mode, kept, left, names: new Set() }
    c.names.add(name)
    clashes.set(pair, c)
  }
  // Values set only inside a component's scope or under a condition: said in
  // a note when the same property is a token, never taken as its value. A
  // property set only under a condition takes that value, with a note.
  const elsewhere = new Map()
  const onlyUnder = new Map()
  // Values written with Sass interpolation, by file: the ones read as plain
  // CSS (and whether a rem conversion was assumed), and the ones left out.
  const sass = new Map()
  for (const file of files) {
    for (const declared of parse(readFileSync(join(root, file), 'utf8'), file)) {
      let p = declared
      // A name or a value with Sass interpolation. A value is read when it
      // can be; a name only Sass can tell. The mirror (`cascade`) keeps the
      // author's text, which only Sass turns into CSS, so it leaves out
      // every such declaration.
      if (p.name.includes('#{') || p.value.includes('#{')) {
        const s = sass.get(file) ?? { read: [], left: [] }
        sass.set(file, s)
        const read = cascade || p.name.includes('#{') ? null : sassValue(p.value)
        if (!read) {
          if (!s.left.some((x) => x.name === p.name)) s.left.push({ name: p.name, raw: p.value })
          continue
        }
        if (read.rem === 'assumed' && !s.read.some((x) => x.name === p.name)) s.read.push({ name: p.name, raw: p.value, value: read.value })
        p = { ...p, value: read.value }
      }
      if (p.name.startsWith('--tw-')) continue
      if (p.scope !== 'theme') outsideTheme.add(p.name)
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
      const values = split && p.mode === 'default' ? [['default', split.light], ['dark', split.dark, true]] : [[p.mode, p.value]]
      for (const [mode, value, half] of values) {
        const at = `${p.name}\n${mode}`
        const first = setBy.get(at)
        const kept = mode === 'default' ? e.default : e.modes[mode]
        const here = { selector: p.selector, file, scope: p.scope }
        const samePlace = first && first.selector === p.selector && first.file === file
        // light-dark()'s dark side gives way to a value the dark theme sets itself.
        if (half) {
          if (kept === undefined) {
            e.modes.dark = value
            setBy.set(at, { ...here, half: true })
          } else if (!cascade && first?.half && !samePlace && value !== kept) {
            clash(mode, first, here, p.name)
          }
          continue
        }
        // A plain root block is the default theme: its value replaces one a
        // light theme's selector set before it.
        const rootOverLight = first && !first.half && first.scope === 'selector' && p.scope === 'root'
        if (!first || first.half || cascade || samePlace || rootOverLight) {
          if (mode === 'default') Object.assign(e, { default: value, source: file })
          else e.modes[mode] = value
          setBy.set(at, here)
          if (rootOverLight && !cascade && value !== kept) clash(mode, here, first, p.name)
        } else if (value !== kept) {
          clash(mode, first, here, p.name)
        }
      }
      entries.set(p.name, e)
    }
  }
  const notes = []
  for (const [file, { read, left }] of sass) {
    const few = (list, show) => `${list.slice(0, 3).map(show).join(', ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}`
    if (read.length > 0) {
      const [first] = read
      notes.push(`${file}: read ${read.length === 1 ? 'one value' : `${read.length} values`} written with a Sass rem conversion as rem at 16px a rem, ${read.length === 1 ? '' : 'such as '}${first.name}: ${first.raw} as ${first.value}; if the function's base is not 16px, correct ${read.length === 1 ? 'that token' : 'those tokens'}`)
    }
    if (left.length > 0) {
      const then = cascade ? 'the mirror keeps only what plain CSS can hold' : `add ${left.length === 1 ? 'its value' : 'their values'} by hand`
      notes.push(`${file}: ${few(left, (x) => `${x.name} (${x.raw})`)} ${left.length === 1 ? 'holds' : 'hold'} Sass interpolation that needs Sass to evaluate, so ${left.length === 1 ? 'it was' : 'they were'} left out; ${then}`)
    }
  }
  for (const { mode, kept, left, names } of clashes.values()) {
    const list = [...names].sort(natural)
    const named = list.length === 1 ? `${list[0]} is` : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]} are`
    notes.push(`${named} set under ${kept.selector} in ${kept.file} and, differently, under ${left.selector} in ${left.file}, which massimo reads as the same ${mode} theme; ${list.length === 1 ? 'its token keeps the value' : 'the tokens keep the values'} under ${kept.selector} in ${kept.file}`)
  }
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
  // A colour in every theme that a token can hold as one (a colour, its
  // channels, or a var() of one), not CSS such as color-mix() that only the
  // CSS outputs carry.
  const plainColor = (name, depth = 0) => {
    const e = entries.get(name)
    if (!e || depth > 8) return false
    return [e.default, ...Object.values(e.modes)].filter((v) => v !== undefined).every((v) => {
      if (channelColor(v) || parseColor(v)) return true
      const m = VAR.exec(v) ?? WRAPPED.exec(v)
      return m ? (m[2] ? channelsOf(m[2], 'default') !== null : plainColor(m[1], depth + 1)) : false
    })
  }
  // Tailwind 4's wiring of a colour: `--color-primary: var(--primary)` set
  // only in @theme, for every theme, where --primary holds a colour. With
  // `skipWiring` it is no token of its own: the colour keeps its own
  // variable and its name, color.primary, the tailwind4 output writes the
  // line again from it, and a var() of the wiring reads as a reference to
  // the colour. The line stays a token when the colour would be named
  // otherwise: its name starts like a colour prefix (--color-c-text), or
  // another property takes that name (--c-primary).
  const wiredTo = new Map()
  if (skipWiring) {
    for (const [name, e] of entries) {
      const bare = /^--color-([\w-]+)$/.exec(name)?.[1]
      if (!bare || /^(?:color|colour|clr|c)(?:-|$)/.test(bare) || outsideTheme.has(name) || Object.keys(e.modes).length > 0) continue
      if (['c', 'clr', 'colour'].some((p) => entries.has(`--${p}-${bare}`))) continue
      const target = `--${bare}`
      if (VAR.exec(String(e.default ?? '').trim())?.[1] === target && plainColor(target)) wiredTo.set(name, target)
    }
    const byFile = new Map()
    for (const name of wiredTo.keys()) byFile.set(entries.get(name).source, [...(byFile.get(entries.get(name).source) ?? []), name])
    for (const [file, names] of byFile) {
      const first = names.sort(natural)[0]
      const line = `${first}: var(${wiredTo.get(first)})`
      notes.push(names.length === 1
        ? `${file} maps one colour in @theme to the variable that holds it, ${line}. That line is Tailwind's wiring, not a token of its own: the colour keeps its own variable, and the tailwind4 output writes the wiring again`
        : `${file} maps ${names.length} colours in @theme to the variables that hold them, such as ${line}. Those lines are Tailwind's wiring, not tokens of their own: each colour keeps its own variable, and the tailwind4 output writes the wiring again`)
    }
  }
  // Stems that two type suffixes share (`--h1-size` and `--h1-leading`).
  const stems = new Map()
  for (const name of entries.keys()) {
    if (wiredTo.has(name)) continue
    const bare = name.slice(2)
    for (const [re, group] of SUFFIX_GROUPS) {
      if (!re.test(bare)) continue
      const stem = bare.replace(re, '')
      stems.set(stem, new Set([...(stems.get(stem) ?? []), group]))
    }
  }
  const idOf = new Map()
  const taken = new Set()
  for (const name of [...entries.keys()].filter((n) => !wiredTo.has(n)).sort(natural)) {
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
  const idFor = (name) => idOf.get(name) ?? idOf.get(wiredTo.get(name))
  const aliasOf = (value) => {
    const m = VAR.exec(value)
    if (m && idFor(m[1])) return `{${idFor(m[1]).join('.')}}`
    const w = WRAPPED.exec(value)
    if (w && !w[3] && idFor(w[2]) && channelsOf(w[2], 'default') !== null) return `{${idFor(w[2]).join('.')}}`
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
  for (const name of [...entries.keys()].filter((n) => !wiredTo.has(n)).sort(natural)) {
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
  // The page's own background and text colour, for extract's semantic
  // colours, and whether a file is one of the style files read, for its
  // note on a body rule elsewhere (a function, which JSON leaves out).
  const page = parse === styleProperties ? pageColors(root, files) : null
  const reads = (file) => files.includes(file)
  return { tokens, notes, typeSteps, count: entries.size, ...(page ? { page } : {}), reads }
}

// ── daisyUI's built-in themes ──────────────────────────────────────────────

// The built-in daisyUI themes a stylesheet picks with `@plugin "daisyui"`,
// as { file, all, implicit, several, themes: [{ name, default, prefersdark }] }.
// Their colours live in the daisyui package, so no reader sees them. A name
// that a `@plugin "daisyui/theme"` block defines is left out, since that
// block's colours are read as tokens, and such a block that is the default
// or the dark theme takes that role from the built-in one. `themes: all`
// picks every built-in theme; a bare `@plugin "daisyui";`, or a block with
// no themes, picks daisyUI's default ones (`implicit`). `several` is true
// when the app has more than one theme, its own included. Null when no style
// file picks one.
const DAISY_DEFAULT_THEMES = 'light --default, dark --prefersdark'
export function readDaisyThemes(root, files) {
  const unquote = (s) => s?.trim().replace(/^['"]|['"]$/g, '')
  const defined = new Set()
  const taken = { default: false, prefersdark: false }
  let picked = null
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const block of parseCssBlocks(text, file)) {
      const header = block.headers[block.headers.length - 1]
      const decl = (prop) => unquote(block.decls.find((d) => d.prop === prop)?.value)
      if (/^@plugin\s+["']daisyui\/theme["']$/i.test(header) && decl('name')) {
        defined.add(decl('name'))
        for (const role of ['default', 'prefersdark']) if (decl(role) === 'true') taken[role] = true
      }
      if (!picked && /^@plugin\s+["']daisyui["']$/i.test(header)) picked = { file, list: decl('themes') ?? DAISY_DEFAULT_THEMES, implicit: decl('themes') === undefined }
    }
    if (!picked && /@plugin\s+["']daisyui["']\s*;/i.test(stripComments(text, file))) picked = { file, list: DAISY_DEFAULT_THEMES, implicit: true }
  }
  if (!picked) return null
  if (/^all$/i.test(picked.list.trim())) return { file: picked.file, all: true, implicit: false, several: true, themes: [] }
  const listed = picked.list
    .split(',')
    .map((entry) => entry.trim().split(/\s+/))
    .map(([name, ...flags]) => [unquote(name ?? ''), flags])
    .filter(([name]) => name && !/^false$/i.test(name))
  const themes = listed
    .filter(([name]) => !defined.has(name))
    .map(([name, flags]) => ({ name, default: flags.includes('--default') && !taken.default, prefersdark: flags.includes('--prefersdark') && !taken.prefersdark }))
  const several = new Set([...listed.map(([name]) => name), ...defined]).size > 1
  return themes.length > 0 ? { file: picked.file, all: false, implicit: picked.implicit, several, themes } : null
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

// Where a Tailwind 3 config's object starts, for findObject. The audit reads
// screens and colours from the same place.
export const TAILWIND_CONFIG_STARTS = [/export\s+default\s*(?:defineConfig\(\s*|\{\s*\.\.\.)?/, /module\.exports\s*=\s*/, /defineConfig\(\s*/, /const\s+config(?:\s*:\s*[\w.]+)?\s*=\s*/]

// The theme a Tailwind 3 config sets (both `theme` and `theme.extend`), read
// as text. Spreads of Tailwind's own defaults and anything computed are
// skipped and named in the notes; nothing in the file is run. A section
// that is a name from elsewhere (`colors: brandColors`, often imported from
// another module) or that spreads one is named too, with the module it is
// imported from when the file says. `partial` lists the token groups some of
// whose values were left out that way, and `extendOnly` the groups only
// theme.extend sets, which add to Tailwind's own scale instead of replacing it.
export function readTailwindConfig(root, file) {
  const src = readFileSync(join(root, file), 'utf8')
  const config = findObject(src, TAILWIND_CONFIG_STARTS)
  const notes = []
  if (!config) return { tokens: [], notes: [`${file}: no config object found to read`] }
  const theme = isObject(config.theme) ? config.theme : {}
  const tokens = []
  const typeSteps = []
  const partial = new Set()
  const inTheme = new Set()
  const inExtend = new Set()
  // `name`, or `name from './module'` when an import names where it comes from.
  const named = (expr) => {
    const id = /^[A-Za-z_$][\w$]*/.exec(expr)?.[0]
    const from = id && new RegExp(`import\\s*(?:\\{[^}]*\\b${id.replace(/\$/g, '\\$')}\\b[^}]*\\}|${id.replace(/\$/g, '\\$')}\\b)[^;'"]*from\\s*['"]([^'"]+)['"]`).exec(src)?.[1]
    return from ? `${expr} from ${from}` : expr
  }
  // Spreads at any depth of a section, as [path after the section, spread].
  const spreadsIn = (obj, path = []) => [
    ...(obj.__spreads ?? []).map((s) => [path, s]),
    ...Object.entries(obj).filter(([, v]) => isObject(v) && !('expr' in v) && !('spread' in v)).flatMap(([k, v]) => spreadsIn(v, [...path, k])),
  ]
  const extend = isObject(theme.extend) ? theme.extend : {}
  for (const [layer, where] of [[theme, 'theme'], [extend, 'theme.extend']]) {
    for (const s of layer.__spreads ?? []) notes.push(`${file}: ${where} spreads ${named(s)}, which was left out`)
    for (const [section, [group, type]] of Object.entries(TAILWIND_SECTIONS)) {
      const values = layer[section]
      if (values === undefined) continue
      ;(layer === theme ? inTheme : inExtend).add(group)
      if (!isObject(values) || 'expr' in values || 'spread' in values) {
        notes.push(`${file}: ${where}.${section} is ${values?.expr ? `${named(values.expr)}, which is not read here` : 'not an object'}, so it was skipped`)
        partial.add(group)
        continue
      }
      for (const [path, s] of spreadsIn(values)) {
        notes.push(`${file}: ${where}.${[section, ...path].join('.')} spreads ${named(s)}, which was left out`)
        partial.add(group)
      }
      for (const [path, v] of leaves(values)) {
        const at = [group, ...path.map((p) => (p === 'DEFAULT' ? '$root' : p))]
        if (v && typeof v === 'object' && ('expr' in v || 'spread' in v)) {
          notes.push(`${file}: ${where}.${section}.${path.join('.')} is computed (${named(v.expr ?? v.spread)}), so it was skipped`)
          partial.add(group)
          continue
        }
        if (section === 'fontFamily') {
          const list = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string')
          const skipped = (Array.isArray(v) ? v : []).filter((x) => typeof x !== 'string')
          if (skipped.length) notes.push(`${file}: ${where}.${section}.${path.join('.')} spreads ${skipped.map((x) => x.spread ?? x.expr).join(', ')}, which was left out`)
          if (list.length) tokens.push(token(at, { type, value: list, source: file }))
          continue
        }
        if (section === 'fontSize' && Array.isArray(v)) {
          // [size, lineHeight] or [size, { lineHeight, letterSpacing, fontWeight }]:
          // a type step, its line height as written ('20px', '1.25', 'normal').
          const [size, extra] = v
          if (cssValue(size) === null) {
            notes.push(`${file}: ${where}.${section}.${path.join('.')} is computed (${size?.expr ?? size?.spread ?? 'not a size'}), so it was skipped`)
            partial.add(group)
            continue
          }
          const parts = isObject(extra) && !('expr' in extra) && !('spread' in extra) ? extra : typeof extra === 'string' || typeof extra === 'number' ? { lineHeight: String(extra) } : {}
          tokens.push(token(at, { type, value: cssValue(size), source: file }))
          typeSteps.push({ path: at, size: cssValue(size), ...parts })
          continue
        }
        if (Array.isArray(v)) {
          notes.push(`${file}: ${where}.${section}.${path.join('.')} is a list, so it was skipped`)
          continue
        }
        const value = cssValue(v)
        if (value === null || /^(currentColor|inherit|transparent|current)$/i.test(value)) continue
        tokens.push(token(at, { type, value, source: file }))
      }
    }
  }
  return { tokens, notes, typeSteps, partial: [...partial], extendOnly: [...inExtend].filter((g) => !inTheme.has(g)) }
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

// Where a theme object starts, most telling first. A theme call may take up
// to two arguments before its object: `createGlobalTheme(':root', vars, {…})`.
const THEME_STARTS = [
  /(?<![\w$])(?:createTheme|extendTheme|createStitches|defineConfig|defineTokens|createGlobalTheme)\s*\(\s*(?:(?:[\w.]+|'[^'\n]*'|"[^"\n]*"|`[^`$\n]*`)\s*,\s*){0,2}/g,
  /export\s+const\s+(?:theme|tokens)\w*(?:\s*:\s*[\w.<>]+)?\s*=\s*/g,
  /(?<![\w$])const\s+(?:theme|tokens)\w*(?:\s*:\s*[\w.<>]+)?\s*=\s*/g,
  /export\s+default\s*/g,
  /module\.exports\s*=\s*/g,
]
// Every object a module exports by name, `export const colors = {…}`.
const EXPORTED_OBJECT = /export\s+const\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[\w.<>[\]]+)?\s*=\s*(?=\{)/g
const THEME_CONTRACT = /(?<![\w$.])create(?:Global)?ThemeContract\s*\(/
// Theme keys and exports that hold breakpoints, which are not tokens.
const BREAKPOINT_KEYS = /^(breakpoints|screens|media|mq)$/i

// Every theme-like object in a module, in the order THEME_STARTS ranks them,
// then the other objects it exports by name, each once:
// { at, label, name?, obj, exported }, where `exported` marks the second kind.
function themeObjects(src) {
  const out = []
  const seen = new Set()
  const take = (m, label, name, exported = false) => {
    const rest = src.slice(m.index + m[0].length)
    const lead = /^[\s(]*/.exec(rest)[0]
    const at = m.index + m[0].length + lead.length
    if (src[at] !== '{' || seen.has(at)) return
    const obj = parseObjectAt(src, at)
    if (!obj) return
    seen.add(at)
    out.push({ at, label, name, obj, exported })
  }
  for (const re of THEME_STARTS) {
    for (const m of src.matchAll(re)) {
      const call = /^(\w+)\s*\(\s*([\s\S]*?)\s*,?\s*$/.exec(m[0].trim())
      const name = /const\s+([\w$]+)/.exec(m[0])?.[1]
      take(m, call ? `${call[1]}(${call[2] ? `${call[2]}, ` : ''}{…})` : name ?? (/^module/.test(m[0]) ? 'module.exports' : 'the default export'), name)
    }
  }
  for (const m of src.matchAll(EXPORTED_OBJECT)) take(m, m[1], m[1], true)
  return out
}

// The theme objects in a JS or TS file, read as text: the first theme-like
// one (`createTheme({…})`, `export const theme = {…}`, `export default {…}`)
// as the theme, and any export named like a theme key (`export const
// colors = {…}`) as that part of it. Every other object is named in a note.
// A theme contract holds the names of CSS variables, not values, and is
// never read.
export function readThemeObject(root, file) {
  const src = readFileSync(join(root, file), 'utf8')
  const notes = THEME_CONTRACT.test(src) ? [`${file}: a theme contract names CSS variables, not values, so it was not read`] : []
  const found = themeObjects(src)
  if (found.length === 0) return { tokens: [], notes: notes.length > 0 ? notes : [`${file}: no theme object found to read`] }
  const isSection = (o) => Boolean(o.name) && THEME_KEYS.some(([re]) => re.test(o.name))
  const isBreakpoints = (o) => Boolean(o.name) && BREAKPOINT_KEYS.test(o.name)
  const computed = (v) => Boolean(v) && typeof v === 'object' && ('expr' in v || 'spread' in v)
  // The theme is a theme call, a theme… or tokens… object or the default
  // export; an object exported under any other name never is.
  const main = found.find((o) => !o.exported && !isSection(o)) ?? null
  const obj = main?.obj ?? {}
  const root_ = isObject(obj.theme) ? obj.theme : isObject(obj.tokens) ? obj.tokens : obj
  // An export named like a theme key is that part of the theme, unless the
  // theme sets the key itself; an export named breakpoints joins it too, so
  // the breakpoints note names it. Any other object is named, not read.
  const parts = { ...root_ }
  const skipped = []
  let sections = 0
  for (const o of found) {
    if (o === main) continue
    if ((isSection(o) || (o.exported && isBreakpoints(o))) && (root_[o.name] === undefined || computed(root_[o.name]))) {
      parts[o.name] = o.obj
      if (isSection(o)) sections++
    } else skipped.push(o.label)
  }
  for (const s of root_.__spreads ?? []) notes.push(`${file}: the theme spreads ${s}, which was left out`)
  if (skipped.length > 0 && (main || sections > 0)) {
    notes.push(`${file}: read ${main ? main.label : 'the exports named like theme keys'}; ${skipped.join(', ')} ${skipped.length === 1 ? 'is another object, which was' : 'are other objects, which were'} not read`)
  } else if (skipped.length > 0) {
    notes.push(`${file}: no theme object found to read; ${skipped.join(', ')} ${skipped.length === 1 ? 'is not named like a theme or a part of one, so it was' : 'are not named like a theme or a part of one, so they were'} not read`)
  }
  const tokens = []
  for (const [key, section] of Object.entries(parts)) {
    if (BREAKPOINT_KEYS.test(key)) {
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

// A Tokens Studio file, as DTCG. A token has `value` and `type` (the older
// form) or `$value` and `$type` (the W3C form), and a description in either
// form. Token sets merge in $metadata.tokenSetOrder; $themes, which pick
// sets, are named in the notes.
export function fromTokensStudio(doc, notes = [], file = '') {
  // A file with $metadata or $themes holds token sets; any other is one set.
  const order = Array.isArray(doc.$metadata?.tokenSetOrder)
    ? doc.$metadata.tokenSetOrder
    : Array.isArray(doc.$themes)
      ? Object.keys(doc).filter((k) => !k.startsWith('$'))
      : null
  const names = order ? order.filter((k) => isObject(doc[k])) : [null]
  if (Array.isArray(doc.$themes) && doc.$themes.length > 0) notes.push(`${file}: Tokens Studio themes (${doc.$themes.map((t) => t.name).join(', ')}) choose sets; the sets were read in order, the themes were not`)
  const convert = (node) => {
    if (!isObject(node)) return node
    if ('$value' in node || ('value' in node && ('type' in node || !Object.values(node).some(isObject)))) {
      const out = { $value: shadowFromStudio('$value' in node ? node.$value : node.value) }
      const type = node.$type ?? node.type
      const description = node.$description ?? node.description
      if (type) out.$type = STUDIO_TYPES[type] ?? type
      if (description) out.$description = description
      return out
    }
    return Object.fromEntries(Object.entries(node).filter(([k]) => !k.startsWith('$')).map(([k, v]) => [k, convert(v)]))
  }
  // Sets merge deeply: a group merges key by key, and a token replaces the
  // token of its path in an earlier set whole. A token whose value refers to
  // its own path means the token of that path in an earlier set, as Tokens
  // Studio reads it, so the earlier one stays.
  const isToken = (node) => isObject(node) && '$value' in node
  const merge = (into, from, path, set) => {
    for (const [k, v] of Object.entries(from)) {
      const at = [...path, k].join('.')
      const prev = into[k]
      if (isToken(v) && isToken(prev) && isAlias(v.$value) && aliasPath(v.$value) === at) {
        const gave = !prev.$description && v.$description
        if (gave) prev.$description = v.$description
        notes.push(`${file}: ${at} in ${set} refers to itself, which Tokens Studio reads as the same path in an earlier set; kept the earlier token${gave ? ", with this one's description" : ''}`)
      } else if (isObject(v) && !isToken(v) && isObject(prev) && !isToken(prev)) {
        merge(prev, v, [...path, k], set)
      } else {
        into[k] = v
      }
    }
    return into
  }
  return names.reduce((out, name) => merge(out, convert(name === null ? doc : doc[name]), [], name), {})
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
