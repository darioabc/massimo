// Design-system audit: finds raw design values that should be tokens, and
// judges the economy of the system (few colours, few sizes, one spacing unit,
// few families) in the spirit of Massimo Vignelli's canon.
//
// Finding kinds: color, arbitrary (Tailwind `p-[6px]`), length (raw px/rem in
// spacing, size, type, radius and border declarations), font-family,
// primitive-read (a var() of a primitive token outside the token files),
// undefined-var (a var() with no fallback and no definition anywhere),
// tailwind-palette (`text-red-600` in a repo with its own colour tokens).
//
// Writes audits/latest.json and audits/latest.md. The ratchet is per offender:
// baseline.json keys are "<file>: <value>" with counts, and --check fails when
// any offender rises or a new one appears, even if the kind's total holds.
//
// Usage:
//   node <project>/scripts/audit.mjs                  write the report
//   node <project>/scripts/audit.mjs --baseline       also record every offender as the baseline
//   node <project>/scripts/audit.mjs --lower          also lower the baseline where counts fell (never records a rise)
//   node <project>/scripts/audit.mjs --check          no writes; exit 1 if an offender rose or is new, 2 if no baseline
//   node <project>/scripts/audit.mjs --cluster 0.03   OKLab distance that merges colours into one cluster
// Shared flags: --root <dir> --config <file> --project-dir <dir>

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deltaE, parseColor, toHex } from './lib/color.mjs'
import { compare, compileGlobs, expandGlobs, walk } from './lib/glob.mjs'
import { fail, loadConfig, parseArgs, readJson, rel, scriptCommand, today } from './lib/project.mjs'
import {
  classLibraries,
  flattenDtcg,
  isAlias,
  parseCustomProperties,
  stringLiterals,
  stripComments,
} from './lib/source.mjs'
import { readTokenSource } from './lib/dtcg.mjs'
import { truthy } from './lib/text.mjs'

export const KINDS = [
  'color',
  'arbitrary',
  'length',
  'font-family',
  'primitive-read',
  'undefined-var',
  'tailwind-palette',
]

const TOP_FILES = 15
const MD_CLUSTERS = 20
const MD_LINE_CAP = 200
const MD_PER_FILE = 10

// ── Patterns ────────────────────────────────────────────────────────────────

const HEX = /(?<![\w&#/.-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g
// Text before a `#` that makes it a fragment, id or selector rather than a colour.
const HEX_NOT_COLOR =
  /(?:(?<![\w-])(?:href|to|id|for|src|poster|action|cite|hash|anchor|target|xlink:href|data-[\w-]+|aria-[\w-]+)\s*[=:]\s*\{?\s*['"`]?[^'"`\s]*|url\(\s*['"]?[^)'"]*|(?:querySelector(?:All)?|closest|matches|getElementById)\(\s*['"`][^'"`]*)$/i
const COLOR_FN = /(?<![\w$.-])(?:rgba?|hsla?|hwb|oklab|oklch|lab|lch|color)\(/gi

const ARBITRARY =
  /(?<![\w[\]$.-])((?:[\w-]+(?:-\[[^\]\s]*\])?:|\[[^\]\s]*\]:)*)(!?-?[a-z][a-z0-9]*(?:-[a-z0-9]+)*)-\[((?:[^[\]\s]|\[[^\]\s]*\])+)\](?:\/(?:[\w.]+|\[[^\]\s]*\]))?(?![\w:[-])/g

const LENGTH_TOKEN = /(?<![\w.#-])(-?\d*\.?\d+)(px|rem|em)\b/g

const SIDE = '(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?'
const CSS_PROP = `margin${SIDE}|padding${SIDE}|gap|row-gap|column-gap|grid-gap|inset${SIDE}|top|right|bottom|left|width|height|min-width|max-width|min-height|max-height|font-size|line-height|letter-spacing|border-radius|border-(?:top|bottom|start|end)-(?:left|right|start|end)-radius|border-width|border-(?:top|right|bottom|left)-width|outline-offset`
const CSS_DECL = new RegExp(`(?<![\\w$.(-])(${CSS_PROP})['"]?\\s*:\\s*`, 'g')
const CAMEL_SIDE = '(?:Top|Right|Bottom|Left|Block|Inline)?(?:Start|End)?'
const JS_PROP = `margin${CAMEL_SIDE}|padding${CAMEL_SIDE}|gap|rowGap|columnGap|inset${CAMEL_SIDE}|top|right|bottom|left|width|height|minWidth|maxWidth|minHeight|maxHeight|fontSize|lineHeight|letterSpacing|borderRadius|border(?:Top|Bottom|Start|End)(?:Left|Right|Start|End)Radius|borderWidth|border(?:Top|Right|Bottom|Left)Width|outlineOffset`
const JS_DECL = new RegExp(`(?<![\\w$.-])(${JS_PROP})\\s*:\\s*`, 'g')
// Props where a bare number in a style object is read as px.
const UNITLESS_PX = /^(?:margin|padding|gap|rowGap|columnGap|fontSize|letterSpacing|borderRadius|border\w*Radius|borderWidth|border\w*Width|outlineOffset)/

const FONT_FAMILY_CSS = /(?<![\w$.(-])font-family['"]?\s*:\s*/g
const FONT_FAMILY_JS = /(?<![\w$.-])fontFamily\s*:\s*/g

const VAR_READ = /var\(\s*(--[\w-]+)\s*(,)?/g
const VAR_DEF = /(?<![\w-])(--[\w-]+)['"]?\s*:/g
const DEFINITION_SOURCES = /\.(?:css|scss|sass|less|styl|html?|astro|vue|svelte|mdx?|[cm]?[jt]sx?)$/i
const RUNTIME_VAR = /^--(?:tw|radix|astro|vite)-/
const TAILWIND4_NAMESPACES =
  /^--(?:color|spacing|font|text|radius|shadow|inset-shadow|drop-shadow|blur|perspective|aspect|ease|animate|breakpoint|container|tracking|leading|default)(?:-|$)/

const DEFAULT_PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const PALETTE_UTILITY = new RegExp(
  `^-?(?:bg|text|border-[xytrblse]|border|ring-offset|ring|outline|fill|stroke|from|via|to|decoration|divide|placeholder|caret|accent|shadow)-(black|white|(?:${DEFAULT_PALETTE})-(?:50|[1-9]00|950))(?:/[\\w.[\\]]+)?$`,
)

const TEXT_SCALE = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128 }
const TEXT_UTILITY = /^text-(xs|sm|base|lg|xl|[2-9]xl)$/

const SPACING_UTILITY = /^-?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|start|end|scroll-[mp][xytrblse]?)$/
const SIZE_UTILITY = /^(?:w|h|size|min-w|max-w|min-h|max-h|basis)$/
const TYPE_UTILITY = /^text$/
const LEADING_UTILITY = /^(?:leading|tracking)$/
const RADIUS_UTILITY = /^rounded(?:-[a-z]{1,2})?$/

// ── Small helpers ───────────────────────────────────────────────────────────

function lineIndex(source) {
  const starts = [0]
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) starts.push(i + 1)
  return {
    starts,
    lineOf(offset) {
      let lo = 0
      let hi = starts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid] <= offset) lo = mid
        else hi = mid - 1
      }
      return lo + 1
    },
  }
}

// The source line around `offset`, trimmed, at most 120 characters.
function snippetOf(source, li, offset) {
  const line = li.lineOf(offset)
  const start = li.starts[line - 1]
  const end = source.indexOf('\n', start)
  const text = source.slice(start, end === -1 ? source.length : end).replace(/\r$/, '')
  if (text.trim().length <= 120) return text.trim()
  const col = offset - start
  const from = Math.max(0, col - 40)
  return `${from > 0 ? '…' : ''}${text.slice(from, from + 116).trim()}…`
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim()
const round2 = (n) => Math.round(n * 100) / 100
const px = (n, unit) => round2(unit === 'px' ? n : n * 16)

// Text from `i` up to the end of a CSS value (`;`, `}`, `]` or newline at paren depth 0).
function readCssValue(code, i) {
  let depth = 0
  let j = i
  for (; j < code.length; j++) {
    const c = code[j]
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && (c === ';' || c === '}' || c === ']' || c === '\n')) break
  }
  return code.slice(i, j)
}

// A JS style-object value: a quoted string's content, or a bare literal.
function readJsValue(code, i) {
  const q = code[i]
  if (q === '"' || q === "'" || q === '`') {
    const end = code.indexOf(q, i + 1)
    return { text: code.slice(i + 1, end === -1 ? code.length : end), quoted: true }
  }
  let j = i
  let depth = 0
  for (; j < code.length; j++) {
    const c = code[j]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    if (depth < 0 || (depth === 0 && (c === ',' || c === '}' || c === '\n'))) break
  }
  return { text: code.slice(i, j).trim(), quoted: false }
}

// Matching `)` for the `(` at `open`, or -1.
function closeParen(code, open) {
  let depth = 0
  for (let i = open; i < code.length && i < open + 200; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')' && --depth === 0) return i
  }
  return -1
}

// `value` with var() and url() calls blanked to spaces, keeping offsets.
const stripVarsAndUrls = (v) => {
  let out = v
  for (let guard = 0; guard < 5; guard++) {
    const next = out.replace(/(?:var|url)\([^()]*\)/g, (m) => ' '.repeat(m.length))
    if (next === out) break
    out = next
  }
  return out
}

function lengthCategory(prop) {
  if (/^(?:margin|padding|gap|row-?gap|column-?gap|grid-gap|inset|top|right|bottom|left)/i.test(prop)) return 'spacing'
  if (/^(?:width|height|min|max)/i.test(prop)) return 'size'
  if (/^font-?size/i.test(prop)) return 'type'
  if (/^(?:line-?height|letter-?spacing)/i.test(prop)) return 'leading'
  if (/radius/i.test(prop)) return 'radius'
  return 'border'
}

// Tailwind class tokens inside every string literal, variants stripped, with
// the offset of each in `code`.
function classTokens(code, file) {
  const out = []
  for (const { text, start } of stringLiterals(code, file)) {
    for (const m of text.matchAll(/[^\s"'`{}(),;]+/g)) {
      const bare = m[0].slice(m[0].lastIndexOf(':') + 1).replace(/^!|!$/g, '')
      if (bare) out.push({ token: bare, offset: start + m.index })
    }
  }
  return out
}

// ── What a colour is used for ───────────────────────────────────────────────

// The job a raw colour does where it sits: a background, text, a border, an
// SVG fill, a shadow, or something else. Read from the CSS property or JS key
// before it on the same line, or from the Tailwind utility around it.
const ROLE_OF = [
  [/^(?:background(?:-color|-image)?|bg|backgroundColor|background)$/i, 'bg'],
  [/^(?:color|text|caret-color|caretColor|placeholder)$/i, 'text'],
  [/^(?:border(?:-\w+)*|outline(?:-color)?|ring|stroke|divide|borderColor|outlineColor|border\w*Color)$/i, 'border'],
  [/^(?:fill|stop-color|stopColor)$/i, 'fill'],
  [/^(?:box-shadow|boxShadow|shadow|text-shadow|textShadow|drop-shadow)$/i, 'shadow'],
]
// The role a Tailwind utility gives its colour (`bg`, `text`, `border-t`…).
function utilityRole(utility) {
  const prop = utility.replace(/-[trblxyse]$/, '')
  if (/^(?:from|via|to)$/.test(prop)) return 'bg'
  return ROLE_OF.find(([re]) => re.test(prop))?.[1] ?? 'other'
}

function colorRole(code, offset) {
  const lineStart = code.lastIndexOf('\n', offset) + 1
  const before = code.slice(lineStart, offset)
  const utility = /(?:^|[\s"'`])-?(bg|text|border(?:-[trblxyse])?|ring|outline|fill|stroke|divide|shadow|from|via|to|decoration|accent|caret|placeholder)-\[$/.exec(before)
  const prop = utility?.[1].replace(/-[trblxyse]$/, '') ?? /([A-Za-z-]+)['"]?\s*:\s*[^:;{}]*$/.exec(before)?.[1]
  if (!prop) return 'other'
  if (/^(?:from|via|to)$/.test(prop)) return 'bg'
  return ROLE_OF.find(([re]) => re.test(prop))?.[1] ?? 'other'
}

// ── The inventory: values the audit counts but does not ratchet ────────────

// Families a token set needs that the finding kinds do not cover. They are
// counted for the token proposals, never baselined, so an older project's
// ratchet does not move when they are added.
const INVENTORY_CSS = /(?<![\w$.(-])(line-height|letter-spacing|font-weight|box-shadow|border|border-(?:top|right|bottom|left)|transition|transition-duration|transition-timing-function|animation|animation-duration|animation-timing-function|z-index|opacity)\s*:\s*/g
const INVENTORY_JS = /(?<![\w$.-])(lineHeight|letterSpacing|fontWeight|boxShadow|border|borderTop|borderRight|borderBottom|borderLeft|transition|transitionDuration|transitionTimingFunction|animationDuration|animationTimingFunction|zIndex|opacity)\s*:\s*/g
const FAMILY_OF = {
  'line-height': 'lineHeight', lineHeight: 'lineHeight', 'letter-spacing': 'letterSpacing', letterSpacing: 'letterSpacing',
  'font-weight': 'fontWeight', fontWeight: 'fontWeight', 'box-shadow': 'shadow', boxShadow: 'shadow', 'z-index': 'zIndex', zIndex: 'zIndex', opacity: 'opacity',
}
const TAILWIND_INVENTORY = [
  [/^leading-(.+)$/, 'lineHeight'],
  [/^tracking-(.+)$/, 'letterSpacing'],
  [/^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/, 'fontWeight'],
  [/^shadow(?:-(?!\[)[\w-]+)?$/, 'shadow'],
  [/^-?z-(\d+|auto)$/, 'zIndex'],
  [/^opacity-(\d+)$/, 'opacity'],
  [/^duration-(\d+)$/, 'duration'],
  [/^ease-(linear|in|out|in-out)$/, 'easing'],
  [/^border(?:-[trblxy])?(?:-\d+)?$/, 'border'],
]
const DURATION = /(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g
const EASING = /cubic-bezier\([^)]*\)|steps\([^)]*\)|\b(?:ease-in-out|ease-in|ease-out|ease|linear)\b/g

function inventoryOf(code, isCss, tokens, inv) {
  const count = (family, value) => {
    const v = collapse(String(value))
    if (!v || /var\(|^(?:inherit|initial|unset|revert|none|normal)$/i.test(v)) return
    const map = (inv[family] ??= new Map())
    map.set(v, (map.get(v) ?? 0) + 1)
  }
  const take = (prop, value) => {
    const family = FAMILY_OF[prop]
    if (family) return count(family, value)
    if (/^border/i.test(prop)) return /\d/.test(value) && count('border', value)
    for (const d of value.matchAll(DURATION)) count('duration', d[0])
    for (const e of value.matchAll(EASING)) count('easing', e[0])
  }
  for (const m of code.matchAll(INVENTORY_CSS)) {
    const value = readCssValue(code, m.index + m[0].length)
    // A quoted value is a JS style object's, which the JS pass reads.
    if (!/^\s*['"`]/.test(value)) take(m[1], value)
  }
  if (!isCss) {
    for (const m of code.matchAll(INVENTORY_JS)) {
      const { text, quoted } = readJsValue(code, m.index + m[0].length)
      if (quoted || /^-?\d*\.?\d+$/.test(text)) take(m[1], text)
    }
  }
  for (const { token } of tokens) {
    for (const [re, family] of TAILWIND_INVENTORY) if (re.test(token)) count(family, `class ${token}`)
  }
}

// ── Per-file scan ───────────────────────────────────────────────────────────

function scanFile(file, source, ctx) {
  const code = stripComments(source, file)
  const li = lineIndex(source)
  const findings = []
  const reads = []
  const defs = new Set()
  const isCss = /\.(?:css|scss|sass|less|styl)$/i.test(file)
  const claimed = new Uint8Array(code.length)

  const add = (offset, kind, value, extra = {}) => {
    findings.push({
      file,
      line: li.lineOf(offset),
      kind,
      ...(extra.sub ? { sub: extra.sub } : {}),
      ...(extra.category ? { category: extra.category } : {}),
      value,
      snippet: snippetOf(source, li, offset),
      ...(extra.px !== undefined ? { px: extra.px } : {}),
      ...(kind === 'color' || extra.sub === 'color' ? { role: extra.role ?? colorRole(code, offset) } : {}),
    })
  }

  // Tailwind arbitrary values first: they own their brackets, so the colour
  // and length scans below skip what they claimed.
  if (!isCss) {
    for (const m of code.matchAll(ARBITRARY)) {
      const name = m[2].replace(/^!/, '')
      const utility = name.replace(/^-/, '')
      let value = m[3].replace(/_/g, ' ')
      const hint = /^(color|length|percentage|number|url|image|position|size|family|absolute-size|relative-size):/.exec(value)
      if (hint) value = value.slice(hint[0].length)
      if (/^(?:content|will-change|font|transition)$/.test(utility) || /var\(/.test(value) || /^url\(/.test(value)) continue
      claimed.fill(1, m.index, m.index + m[0].length)
      const color = hint?.[1] === 'color' || parseColor(value) !== null || /^#[0-9a-f]{3,8}$/i.test(value)
      const length = !color && (/^-?[\d.]+(?:px|rem|em|%|vw|vh|vmin|vmax|ch|ex|pt|cm|mm|in|svh|dvh|svw|dvw|lvh)$/.test(value) || (/calc\(/.test(value) && /\d(?:px|rem|em)/.test(value)))
      const sub = color ? 'color' : length ? 'length' : 'other'
      let category
      let pixels
      if (length) {
        const t = /^(-?[\d.]+)(px|rem|em)$/.exec(value)
        if (t) pixels = px(Math.abs(parseFloat(t[1])), t[2])
        if (SPACING_UTILITY.test(name)) category = 'spacing'
        else if (SIZE_UTILITY.test(utility)) category = 'size'
        else if (TYPE_UTILITY.test(utility)) category = 'type'
        else if (LEADING_UTILITY.test(utility)) category = 'leading'
        else if (RADIUS_UTILITY.test(utility)) category = 'radius'
        else if (/^(?:border|outline|ring)/.test(utility)) category = 'border'
      }
      add(m.index, 'arbitrary', `${name}-[${m[3]}]`, { sub, category, px: pixels, role: color ? utilityRole(utility) : undefined })
    }
  }

  // Colours: hex, then functional notation.
  for (const m of code.matchAll(HEX)) {
    if (claimed[m.index]) continue
    const lineStart = li.starts[li.lineOf(m.index) - 1]
    if (HEX_NOT_COLOR.test(code.slice(lineStart, m.index))) continue
    if (/^\s*\{/.test(code.slice(m.index + m[0].length, m.index + m[0].length + 8))) continue
    add(m.index, 'color', m[0])
  }
  for (const m of code.matchAll(COLOR_FN)) {
    if (claimed[m.index]) continue
    const open = m.index + m[0].length - 1
    const close = closeParen(code, open)
    if (close === -1) continue
    const text = code.slice(m.index, close + 1)
    if (/var\(/.test(text) || parseColor(text) === null) continue
    add(m.index, 'color', collapse(text))
  }

  // Raw lengths in CSS declarations and in JS style objects. A token is keyed
  // on its own offset, so a declaration both scans reach is counted once.
  const seenLengths = new Set()
  const lengthFindings = (valueStart, prop, value) => {
    const cleaned = stripVarsAndUrls(value)
    for (const t of cleaned.matchAll(LENGTH_TOKEN)) {
      const n = parseFloat(t[1])
      if (n === 0 || (n === 1 && t[2] === 'px')) continue
      const at = valueStart + t.index
      if (seenLengths.has(at)) continue
      seenLengths.add(at)
      const category = lengthCategory(prop)
      add(at, 'length', `${t[1]}${t[2]}`, { sub: category, category, px: px(Math.abs(n), t[2]) })
    }
  }
  for (const m of code.matchAll(CSS_DECL)) {
    const start = m.index + m[0].length
    lengthFindings(start, m[1], readCssValue(code, start))
  }
  for (const m of code.matchAll(JS_DECL)) {
    const prop = m[1]
    const start = m.index + m[0].length
    const { text, quoted } = readJsValue(code, start)
    if (quoted) {
      lengthFindings(start + 1, prop, text)
    } else if (UNITLESS_PX.test(prop) && /^-?\d+$/.test(text)) {
      const n = parseFloat(text)
      if (n !== 0 && n !== 1 && !seenLengths.has(start)) {
        seenLengths.add(start)
        const category = lengthCategory(prop)
        add(start, 'length', `${text}px`, { sub: category, category, px: Math.abs(n) })
      }
    }
  }

  // Font families.
  const familyFinding = (offset, raw) => {
    const value = collapse(raw)
    if (!value || /var\(/.test(value) || /^(?:inherit|initial|unset|revert)$/i.test(value)) return
    const fontFace = code.lastIndexOf('@font-face', offset)
    if (fontFace !== -1 && code.indexOf('}', fontFace) > offset) return
    add(offset, 'font-family', value)
  }
  for (const m of code.matchAll(FONT_FAMILY_CSS)) familyFinding(m.index, readCssValue(code, m.index + m[0].length))
  for (const m of code.matchAll(FONT_FAMILY_JS)) {
    const { text, quoted } = readJsValue(code, m.index + m[0].length)
    if (quoted) familyFinding(m.index, text)
  }

  // Class tokens: Tailwind palette utilities and the type scale in use.
  const tokens = isCss ? [] : classTokens(code, file)
  for (const m of code.matchAll(/@apply\s+([^;}\n]+)/g)) {
    for (const raw of m[1].split(/\s+/)) {
      if (raw) tokens.push({ token: raw.slice(raw.lastIndexOf(':') + 1).replace(/^!|!$/g, ''), offset: m.index })
    }
  }
  inventoryOf(code, isCss, tokens, ctx.inventory)
  for (const { token, offset } of tokens) {
    const t = TEXT_UTILITY.exec(token)
    if (t) ctx.tailwindText.set(TEXT_SCALE[t[1]], (ctx.tailwindText.get(TEXT_SCALE[t[1]]) ?? 0) + 1)
    if (ctx.palette) {
      const p = PALETTE_UTILITY.exec(token)
      if (p && !ctx.ownColors.has(p[1])) add(offset, 'tailwind-palette', token.replace(/^-/, ''))
    }
  }

  // var() reads and every way a custom property can be set.
  for (const m of code.matchAll(VAR_READ)) {
    const name = m[1]
    const end = m.index + m[0].indexOf(name) + name.length
    if (code[end] === '$') continue // `var(--space-${n})` is built at runtime
    if (!m[2]) reads.push({ name, line: li.lineOf(m.index), snippet: snippetOf(source, li, m.index) })
    if (ctx.primitives.has(name)) add(m.index, 'primitive-read', name)
  }
  collectDefinitions(code, defs)

  return { findings, reads, defs }
}

function collectDefinitions(code, defs) {
  for (const m of code.matchAll(VAR_DEF)) defs.add(m[1])
  for (const m of code.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) defs.add(m[1])
  for (const m of code.matchAll(/style:(--[\w-]+)/g)) defs.add(m[1])
  for (const m of code.matchAll(/define:vars\s*=\s*\{\{([^}]*)\}\}/g)) {
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].trim().replace(/^['"]|['"]$/g, '')
      if (key) defs.add(key.startsWith('--') ? key : `--${key}`)
    }
  }
}

// ── The audit ───────────────────────────────────────────────────────────────

const normalizeValue = (kind, value) => {
  const v = collapse(value)
  return kind === 'color' ? v.toLowerCase() : v
}

export function offendersOf(findings) {
  const kinds = {}
  for (const kind of KINDS) kinds[kind] = {}
  for (const f of findings) {
    const key = `${f.file}: ${normalizeValue(f.kind, f.value)}`
    kinds[f.kind][key] = (kinds[f.kind][key] ?? 0) + 1
  }
  return kinds
}

function baselineDocument(offenders, skipped) {
  const kinds = {}
  for (const kind of KINDS) {
    if (skipped.has(kind)) continue
    const keys = Object.keys(offenders[kind]).sort(compare)
    kinds[kind] = {
      count: keys.reduce((n, k) => n + offenders[kind][k], 0),
      offenders: Object.fromEntries(keys.map((k) => [k, offenders[kind][k]])),
    }
  }
  return {
    version: 1,
    generatedBy: 'massimo audit',
    note: 'Raw design values by kind and offender ("<file>: <value>": count). `audit.mjs --check` fails when any offender rises or a new one appears, even if the kind total holds. `--lower` records only counts that fell and never a rise. Raise or add an offender by hand, in a reviewed change that says why; move a key by hand when a file is renamed.',
    kinds,
  }
}

// What --lower would record, and what rose. Each offender keeps the lower of
// its baseline and current count; new or rising offenders are never recorded.
// A kind the baseline lacks starts at its current counts.
function lowerBaseline(baseline, offenders, skipped) {
  const kinds = {}
  const rises = []
  let lowered = 0
  let dropped = 0
  for (const kind of KINDS) {
    if (skipped.has(kind)) continue
    const base = baseline.kinds?.[kind]
    const current = offenders[kind]
    if (!base) {
      const keys = Object.keys(current).sort(compare)
      kinds[kind] = { count: keys.reduce((n, k) => n + current[k], 0), offenders: Object.fromEntries(keys.map((k) => [k, current[k]])) }
      continue
    }
    const kept = {}
    for (const key of Object.keys(base.offenders).sort(compare)) {
      const was = base.offenders[key]
      const now = current[key] ?? 0
      const next = Math.min(was, now)
      if (next === 0) dropped++
      else kept[key] = next
      if (next < was && next > 0) lowered++
    }
    for (const key of Object.keys(current)) {
      if (current[key] > (base.offenders[key] ?? 0)) rises.push({ kind, key, from: base.offenders[key] ?? 0, to: current[key] })
    }
    kinds[kind] = { count: Object.values(kept).reduce((a, b) => a + b, 0), offenders: kept }
  }
  return { document: { ...baseline, kinds }, rises, lowered, dropped }
}

// Offenders that rose or are new against the baseline; kinds the baseline does
// not track are left out, and `fell` counts offenders that dropped or vanished.
function compareToBaseline(baseline, offenders, skipped) {
  const rises = []
  let fell = 0
  const untracked = []
  for (const kind of KINDS) {
    if (skipped.has(kind)) continue
    const base = baseline.kinds?.[kind]
    if (!base) {
      untracked.push(kind)
      continue
    }
    for (const [key, now] of Object.entries(offenders[kind])) {
      const was = base.offenders[key] ?? 0
      if (now > was) rises.push({ kind, key, from: was, to: now })
    }
    for (const [key, was] of Object.entries(base.offenders)) if ((offenders[kind][key] ?? 0) < was) fell++
  }
  rises.sort((a, b) => compare(a.kind, b.kind) || compare(a.key, b.key))
  return { rises, fell, untracked }
}

// Blank the value of every `--name: value` declaration, keeping line breaks
// so line numbers stay true. `var(--x)` reads are untouched (no colon).
export function maskTokenDeclarations(text) {
  return text.replace(/(--[\w-]+\s*:)([^;{}]*)/g, (_, decl, value) => decl + value.replace(/[^\n]/g, ' '))
}

export function runAudit(root, config, { cluster = 0.03 } = {}) {
  const all = walk(root, { ignore: config.ignore })
  const styleFiles = expandGlobs(root, config.tokens.styleFiles, [], config.ignore, all)
  const outputPaths = (config.tokens.outputs ?? []).map((o) => o.path).filter(Boolean)
  const tokenFiles = new Set([...styleFiles, ...outputPaths])
  const projectRel = (() => {
    const r = rel(root, join(root, config.projectDir))
    return r.startsWith('..') ? null : r
  })()
  const isProjectFile = projectRel ? compileGlobs([`${projectRel}/**`]) : () => false
  const skipped = new Map()

  // Tokens: colours the repo already has, DTCG primitives and definitions.
  const customProps = []
  for (const f of styleFiles) customProps.push(...parseCustomProperties(readFileSync(join(root, f), 'utf8'), f))
  let dtcgTokens = []
  try {
    dtcgTokens = readTokenSource(root, config)?.tokens ?? []
  } catch {
    // an invalid token file is tokens.mjs's problem to report
  }
  const primitives = new Set(dtcgTokens.filter((t) => !isAlias(t.value)).map((t) => t.cssVar))
  if (dtcgTokens.length === 0) skipped.set('primitive-read', 'no token set yet')

  const styling = config.styling ?? []
  const libraries = classLibraries(config)
  const hasTailwind = styling.some((s) => /^tailwind/.test(s))
  const ownColors = new Set([
    ...customProps.map((p) => /^--color-([\w-]+)$/.exec(p.name)?.[1]).filter(Boolean),
    ...dtcgTokens.filter((t) => t.path[0] === 'color').map((t) => t.path.slice(1).join('-')),
  ])
  const palette = hasTailwind && ownColors.size > 0
  if (!palette) skipped.set('tailwind-palette', hasTailwind ? 'no colour tokens of its own' : 'no Tailwind in styling')

  // Generated token outputs are skipped whole. Style files are audited too:
  // only their custom property declarations are where raw values belong, so
  // those are masked (maskTokenDeclarations) and every other rule is checked.
  const outputSet = new Set(outputPaths)
  const styleSet = new Set(styleFiles)
  const scanned = expandGlobs(root, [...config.audit.include, ...styleFiles], config.audit.exclude, config.ignore, all).filter(
    (f) => !outputSet.has(f) && !isProjectFile(f),
  )
  const scannedSet = new Set(scanned)
  const ctx = { primitives, palette, ownColors, tailwindText: new Map(), inventory: {} }
  const findings = []
  const allReads = []
  const defined = new Set()
  for (const file of scanned) {
    const raw = readFileSync(join(root, file), 'utf8')
    const source = styleSet.has(file) ? maskTokenDeclarations(raw) : raw
    const result = scanFile(file, source, ctx)
    findings.push(...result.findings)
    for (const r of result.reads) allReads.push({ file, ...r })
    for (const d of result.defs) defined.add(d)
  }

  // Definitions also come from token files and from every other stylesheet,
  // component, content and script file in the repo (inline `style="--x: 1"`,
  // MDX, setProperty), so a var set outside audit.include is not "undefined".
  for (const f of all) {
    if (scannedSet.has(f) || !(tokenFiles.has(f) || DEFINITION_SOURCES.test(f))) continue
    const text = readFileSync(join(root, f), 'utf8')
    if (text.length < 1_000_000) collectDefinitions(text, defined)
  }
  for (const t of dtcgTokens) defined.add(t.cssVar)
  for (const p of customProps) defined.add(p.name)
  // A class library's themes set its colours and variables, and its components read their own.
  for (const lib of libraries) {
    for (const n of lib.colors) defined.add(`--color-${n}`)
    for (const n of lib.vars) defined.add(`--${n}`)
  }
  const libraryVar = libraries.some((lib) => lib.roots.length > 0)
    ? new RegExp(`^--(?:${libraries.flatMap((lib) => lib.roots).join('|')})-`)
    : null
  for (const r of allReads) {
    if (defined.has(r.name) || RUNTIME_VAR.test(r.name)) continue
    if (styling.includes('tailwind4') && TAILWIND4_NAMESPACES.test(r.name)) continue
    if (libraryVar?.test(r.name)) continue
    findings.push({ file: r.file, line: r.line, kind: 'undefined-var', value: r.name, snippet: r.snippet })
  }

  findings.sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.kind, b.kind) || compare(a.value, b.value))

  // Aggregates.
  const totals = Object.fromEntries(KINDS.map((k) => [k, 0]))
  const perFile = new Map()
  for (const f of findings) {
    totals[f.kind]++
    perFile.set(f.file, (perFile.get(f.file) ?? 0) + 1)
  }
  const topFiles = [...perFile.entries()]
    .sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))
    .slice(0, TOP_FILES)
    .map(([file, count]) => ({ file, count }))

  const colorMap = new Map()
  const colorSources = findings.filter((f) => f.kind === 'color' || (f.kind === 'arbitrary' && f.sub === 'color'))
  for (const f of colorSources) {
    const raw = f.kind === 'arbitrary' ? /\[(.*)\]/.exec(f.value)?.[1].replace(/_/g, ' ').replace(/^color:/, '') ?? f.value : f.value
    const parsed = parseColor(raw)
    const key = parsed ? toHex(parsed) : collapse(raw).toLowerCase()
    const entry = colorMap.get(key) ?? { value: key, count: 0, forms: new Map(), parsed, roles: {} }
    entry.count++
    if (f.role) entry.roles[f.role] = (entry.roles[f.role] ?? 0) + 1
    entry.forms.set(collapse(raw), (entry.forms.get(collapse(raw)) ?? 0) + 1)
    colorMap.set(key, entry)
  }
  const colors = [...colorMap.values()].sort((a, b) => b.count - a.count || compare(a.value, b.value))
  const tokenColors = []
  for (const p of customProps) {
    const parsed = parseColor(p.value)
    if (parsed && parsed.a > 0 && !p.name.startsWith('--tw-')) tokenColors.push({ name: p.name, value: toHex(parsed), parsed })
  }
  const clusters = []
  for (const c of colors) {
    if (!c.parsed) {
      clusters.push({ rep: c, members: [c] })
      continue
    }
    const home = clusters.find((cl) => cl.rep.parsed && Math.abs(cl.rep.parsed.a - c.parsed.a) < 0.05 && deltaE(cl.rep.parsed, c.parsed) <= cluster)
    if (home) home.members.push(c)
    else clusters.push({ rep: c, members: [c] })
  }
  const colorClusters = clusters
    .map((cl) => {
      let nearest = null
      if (cl.rep.parsed) {
        for (const t of tokenColors) {
          const d = deltaE(cl.rep.parsed, t.parsed)
          if (!nearest || d < nearest.distance) nearest = { name: t.name, value: t.value, distance: d }
        }
      }
      // What the cluster's colours are used for, most-used job first.
      const roles = {}
      for (const m of cl.members) for (const [role, n] of Object.entries(m.roles)) roles[role] = (roles[role] ?? 0) + n
      return {
        representative: cl.rep.value,
        count: cl.members.reduce((n, m) => n + m.count, 0),
        roles: Object.fromEntries(Object.entries(roles).sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))),
        members: cl.members.map((m) => ({ value: m.value, count: m.count })),
        nearestToken: nearest ? { name: nearest.name, value: nearest.value, distance: Math.round(nearest.distance * 10000) / 10000 } : null,
      }
    })
    .sort((a, b) => b.count - a.count || compare(a.representative, b.representative))

  const spacingMap = new Map()
  const typeMap = new Map()
  const bump = (map, key, source) => {
    const e = map.get(key) ?? { px: key, count: 0, sources: { css: 0, arbitrary: 0, tailwind: 0 } }
    e.count++
    e.sources[source]++
    map.set(key, e)
  }
  for (const f of findings) {
    if (f.px === undefined) continue
    const source = f.kind === 'arbitrary' ? 'arbitrary' : 'css'
    if (f.category === 'spacing') bump(spacingMap, f.px, source)
    if (f.category === 'type') bump(typeMap, f.px, source)
  }
  for (const [size, count] of ctx.tailwindText) {
    const e = typeMap.get(size) ?? { px: size, count: 0, sources: { css: 0, arbitrary: 0, tailwind: 0 } }
    e.count += count
    e.sources.tailwind += count
    typeMap.set(size, e)
  }
  const offGrid = (n) => Math.abs(n / 4 - Math.round(n / 4)) > 1e-6
  const spacing = [...spacingMap.values()].sort((a, b) => a.px - b.px).map((e) => ({ px: e.px, count: e.count, offGrid: offGrid(e.px) }))
  const typeSizes = [...typeMap.values()].sort((a, b) => a.px - b.px)

  const familyMap = new Map()
  for (const f of findings.filter((x) => x.kind === 'font-family')) {
    const first = splitFamilies(f.value)[0] ?? f.value
    familyMap.set(first, (familyMap.get(first) ?? 0) + 1)
  }
  const fontFamilies = [...familyMap.entries()].sort((a, b) => b[1] - a[1] || compare(a[0], b[0])).map(([family, count]) => ({ family, count }))

  const canon = {
    distinctColors: colors.length,
    colorClusters: colorClusters.length,
    distinctFontSizes: typeSizes.length,
    distinctFontFamilies: fontFamilies.length,
    offGridSpacingValues: spacing.filter((s) => s.offGrid).length,
    arbitraryValues: totals.arbitrary,
  }

  return {
    findings,
    scannedFiles: scanned.length,
    totals,
    topFiles,
    colors: colors.map((c) => ({ value: c.value, count: c.count, forms: [...c.forms.keys()].sort(compare).slice(0, 4) })),
    colorClusters,
    spacing: { histogram: spacing, offGridOccurrences: spacing.filter((s) => s.offGrid).reduce((n, s) => n + s.count, 0) },
    typeSizes,
    fontFamilies,
    canon,
    // Counted, never ratcheted: the families a token set needs beyond the findings.
    inventory: Object.fromEntries(
      Object.entries(ctx.inventory)
        .sort((a, b) => compare(a[0], b[0]))
        .map(([family, map]) => [family, [...map.entries()].sort((a, b) => b[1] - a[1] || compare(a[0], b[0])).map(([value, count]) => ({ value, count }))]),
    ),
    skipped: Object.fromEntries([...skipped.entries()].sort((a, b) => compare(a[0], b[0]))),
    cluster,
  }
}

// `"Geist Sans", system-ui, sans-serif` -> ['Geist Sans', 'system-ui', 'sans-serif']
function splitFamilies(value) {
  const out = []
  let cur = ''
  let quote = null
  for (const c of value) {
    if (quote) {
      if (c === quote) quote = null
      else cur += c
    } else if (c === '"' || c === "'") quote = c
    else if (c === ',') {
      out.push(cur.trim())
      cur = ''
    } else cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(Boolean)
}

// ── Report ──────────────────────────────────────────────────────────────────

function renderMarkdown(result, date, command) {
  const { canon, totals, topFiles, colorClusters, spacing, typeSizes, fontFamilies, findings, skipped } = result
  const out = []
  const total = findings.length
  out.push('# Design-system audit', '')
  out.push(`<!-- Generated by massimo audit. Do not edit by hand. Regenerate: ${command} -->`, '')
  out.push(`${date} · ${result.scannedFiles} files scanned · ${total} findings. Full detail in \`latest.json\`.`, '')

  out.push('## Canon', '')
  out.push('The economy of the system: few colours, few sizes, one spacing unit, few families. Lower is better.', '')
  out.push(`- Distinct colours: ${canon.distinctColors}`)
  out.push(`- Colour clusters (within ${result.cluster} OKLab): ${canon.colorClusters}`)
  out.push(`- Distinct font sizes: ${canon.distinctFontSizes}`)
  out.push(`- Distinct font families: ${canon.distinctFontFamilies}`)
  out.push(`- Off-grid spacing values (not a multiple of 4px): ${canon.offGridSpacingValues}`)
  out.push(`- Arbitrary values: ${canon.arbitraryValues}`, '')

  out.push('## Findings by kind', '')
  for (const kind of KINDS) {
    out.push(skipped[kind] ? `- ${kind}: skipped (${skipped[kind]})` : `- ${kind}: ${totals[kind]}`)
  }
  out.push('')

  out.push('## Top files', '')
  if (topFiles.length === 0) out.push('No findings.')
  topFiles.forEach((f, i) => out.push(`${i + 1}. \`${f.file}\` · ${f.count}`))
  out.push('')

  out.push('## Colour clusters', '')
  if (colorClusters.length === 0) out.push('No raw colours.')
  for (const c of colorClusters.slice(0, MD_CLUSTERS)) {
    const roles = Object.entries(c.roles ?? {}).map(([role, n]) => `${role} ${n}`).join(', ')
    const near = c.nearestToken ? ` · nearest token \`${c.nearestToken.name}\` ${c.nearestToken.value} (${c.nearestToken.distance})` : ''
    const members = c.members.length > 1 ? ` · merges ${c.members.map((m) => `${m.value}×${m.count}`).join(', ')}` : ''
    out.push(`- ${c.representative} ×${c.count}${members}${near}${roles ? ` · used as ${roles}` : ''}`)
  }
  if (colorClusters.length > MD_CLUSTERS) out.push(`- +${colorClusters.length - MD_CLUSTERS} more clusters in latest.json`)
  out.push('')

  out.push('## Spacing', '')
  if (spacing.histogram.length === 0) out.push('No raw spacing values.')
  else {
    out.push(`${spacing.offGridOccurrences} of ${spacing.histogram.reduce((n, s) => n + s.count, 0)} raw spacing values sit off the 4px grid.`, '')
    for (const s of spacing.histogram) out.push(`- ${s.px}px ×${s.count}${s.offGrid ? ' (off grid)' : ''}`)
  }
  out.push('')

  out.push('## Type sizes', '')
  if (typeSizes.length === 0) out.push('No font sizes found.')
  for (const t of typeSizes) {
    const via = Object.entries(t.sources).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ')
    out.push(`- ${t.px}px ×${t.count} (${via})`)
  }
  out.push('')

  out.push('## Font families', '')
  if (fontFamilies.length === 0) out.push('No raw font families.')
  for (const f of fontFamilies) out.push(`- ${f.family} ×${f.count}`)
  out.push('')

  // Counted for the token proposals, never ratcheted.
  const INVENTORY_TITLES = { lineHeight: 'Line heights', letterSpacing: 'Letter spacing', fontWeight: 'Font weights', shadow: 'Shadows', border: 'Borders', duration: 'Durations', easing: 'Easings', zIndex: 'Z-index', opacity: 'Opacity' }
  const families = Object.entries(result.inventory ?? {}).filter(([, list]) => list.length > 0)
  if (families.length > 0) {
    out.push('## Inventory', '', 'Values the token set will need, counted where the code uses them. They are not findings and never join the baseline.', '')
    for (const [family, list] of families) {
      out.push(`- ${INVENTORY_TITLES[family] ?? family}: ${list.slice(0, 8).map((v) => `${v.value} ×${v.count}`).join(', ')}${list.length > 8 ? `, +${list.length - 8} more` : ''}`)
    }
    out.push('')
  }

  out.push('## Findings', '')
  const startLength = out.length
  const byFile = new Map()
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, [])
    byFile.get(f.file).push(f)
  }
  const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length || compare(a[0], b[0]))
  let shown = 0
  for (const [file, list] of files) {
    if (out.length - startLength >= MD_LINE_CAP) break
    out.push(`### ${file} (${list.length})`)
    for (const f of list.slice(0, MD_PER_FILE)) out.push(`- L${f.line} ${f.kind}${f.sub ? `/${f.sub}` : ''} \`${f.value.replace(/`/g, "'")}\``)
    if (list.length > MD_PER_FILE) out.push(`- +${list.length - MD_PER_FILE} more`)
    out.push('')
    shown++
  }
  if (files.length === 0) out.push('None.')
  else if (shown < files.length) out.push(`${files.length - shown} more files with findings: see latest.json.`)
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set(['check', 'baseline', 'lower'])
const usage = (message) => fail(message, 2)

function main() {
  const argv = process.argv.slice(2).map((a) => (a.startsWith('--') && BOOLEAN_FLAGS.has(a.slice(2)) ? `${a}=true` : a))
  const { flags } = parseArgs(argv)
  const { root, config, projectDir } = loadConfig(flags)
  const check = truthy(flags.check)
  const wantBaseline = truthy(flags.baseline)
  const wantLower = truthy(flags.lower)
  if (check && (wantBaseline || wantLower)) usage('--check writes nothing; do not combine it with --baseline or --lower')
  if (wantBaseline && wantLower) usage('choose one of --baseline (record everything) and --lower (only lower)')
  let cluster = 0.03
  if (flags.cluster !== undefined) {
    cluster = Number(flags.cluster)
    if (!Number.isFinite(cluster) || cluster <= 0) usage('--cluster takes a positive number, e.g. 0.03')
  }

  const result = runAudit(root, config, { cluster })
  const skipped = new Set(Object.keys(result.skipped))
  const offenders = offendersOf(result.findings)
  const baselinePath = join(projectDir, 'audits', 'baseline.json')
  const shown = (name) => {
    const r = rel(root, join(projectDir, 'audits', name))
    return r.startsWith('..') ? join(projectDir, 'audits', name) : r
  }
  const stats = `${result.findings.length} findings in ${result.scannedFiles} files`

  if (check) {
    if (!existsSync(baselinePath)) {
      process.stderr.write(`massimo audit: no baseline at ${shown('baseline.json')}. Run: ${scriptCommand(root, projectDir, 'audit', '--baseline')}\n`)
      process.exit(2)
    }
    const { rises, fell, untracked } = compareToBaseline(readJson(baselinePath, {}), offenders, skipped)
    if (rises.length > 0) {
      for (const r of rises) {
        process.stderr.write(`  ${r.kind}  ${r.key}  ${r.from === 0 ? 'new' : `${r.from} -> ${r.to}`}${r.from === 0 && r.to > 1 ? ` (x${r.to})` : ''}\n`)
      }
      process.stdout.write(`massimo audit: ${rises.length} ${rises.length === 1 ? 'offender' : 'offenders'} rose or ${rises.length === 1 ? 'is' : 'are'} new against the baseline (${stats})\n`)
      process.exit(1)
    }
    const hints = []
    if (fell > 0) hints.push(`${fell} ${fell === 1 ? 'offender' : 'offenders'} fell: run --lower to record it`)
    if (untracked.length > 0) hints.push(`not in the baseline yet: ${untracked.join(', ')} (run --lower to start tracking)`)
    process.stdout.write(`massimo audit: within baseline (${stats})${hints.length > 0 ? `. ${hints.join('; ')}` : ''}\n`)
    return
  }

  const date = today()
  const auditsDir = join(projectDir, 'audits')
  mkdirSync(auditsDir, { recursive: true })
  const { findings, ...summary } = result
  const json = { version: 1, generatedBy: 'massimo audit', date, ...summary, findings }
  writeFileSync(join(auditsDir, 'latest.json'), `${JSON.stringify(json, null, 2)}\n`)
  writeFileSync(join(auditsDir, 'latest.md'), renderMarkdown(result, date, scriptCommand(root, projectDir, 'audit')))
  let extra = ''
  if (wantBaseline) {
    writeFileSync(baselinePath, `${JSON.stringify(baselineDocument(offenders, skipped), null, 2)}\n`)
    extra = `; baseline written to ${shown('baseline.json')}`
  } else if (wantLower) {
    if (!existsSync(baselinePath)) {
      process.stderr.write(`massimo audit: no baseline to lower at ${shown('baseline.json')}. Run: ${scriptCommand(root, projectDir, 'audit', '--baseline')}\n`)
      process.exit(2)
    }
    const lowered = lowerBaseline(readJson(baselinePath, {}), offenders, skipped)
    writeFileSync(baselinePath, `${JSON.stringify(lowered.document, null, 2)}\n`)
    for (const r of lowered.rises) {
      process.stderr.write(`  not recorded: ${r.kind}  ${r.key}  ${r.from === 0 ? 'new' : `${r.from} -> ${r.to}`}\n`)
    }
    extra = `; baseline lowered (${lowered.lowered} lowered, ${lowered.dropped} dropped${lowered.rises.length > 0 ? `, ${lowered.rises.length} rises not recorded` : ''})`
  }
  const c = result.canon
  process.stdout.write(
    `massimo audit: ${stats}; ${c.distinctColors} colours in ${c.colorClusters} clusters, ${c.distinctFontSizes} font sizes, ${c.distinctFontFamilies} families, ${c.offGridSpacingValues} off-grid spacing values; wrote ${shown('latest.md')}${extra}\n`,
  )
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (entry === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}
