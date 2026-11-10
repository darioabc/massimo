// Stylesheets read as their author wrote them, for the token mirror and the
// token inventory: every rule with its declarations, each declaration with
// its line and the comment written just before it, and every member of a
// selector list on its own, under the at-rules around it. parseCssBlocks
// (lib/source.mjs) reads the same blocks but drops the comments and joins a
// selector list into one theme or scope.
//
// Which members are themes is the config's to say: tokens.darkSelector,
// tokens.selectors and tokens.darkMedia, as the build writes them. Any other
// selector is a scope, kept by its own text, never read as a theme.

import { parseColor, toHex } from './color.mjs'
import { compare, compileGlobs } from './glob.mjs'
import { PREFIX_GROUPS, SUFFIX_GROUPS, channelColor } from './readers.mjs'
import { DECLARED_PROPERTY, atRuleKind, classifyMember, interpolationEnd, scanSource, selectorMembers } from './source.mjs'

const clean = (s) => s.replace(/\s+/g, ' ').trim()

const RULE = /[\u2500-\u257f]+|-{3,}|={3,}/
const RULES = new RegExp(RULE.source, 'g')

// A comment's text without its markers, its `*` gutters and the rules drawn
// with box-drawing or repeated dashes around a section heading, which ends
// in a full stop so it does not run into the sentence after it.
export function commentText(raw) {
  const lines = raw
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((l) => {
      const text = clean(l.replace(/^\s*\*+(?!\/)\s?/, ''))
      if (!RULE.test(text)) return text
      const heading = clean(text.replace(RULES, ' '))
      return heading && !/[.:;!?]$/.test(heading) ? `${heading}.` : heading
    })
  return clean(lines.join(' '))
}

// Every rule in a stylesheet that holds declarations, in source order, as
// { headers, decls: [{ prop, value, line, comment }] }. `headers` is the chain
// of at-rule preludes and selectors from the outermost block in. `comment` is
// the comment just before the declaration, or else one after it on its line.
// A comment that opens a section (one that draws a rule, or the first in its
// block above a declaration with a comment of its own) is the section's, not
// the declaration's. Values keep what the author wrote, `!important` too,
// with whitespace and comments inside them collapsed.
export function cssRules(css, file = 'x.css') {
  const { comments } = scanSource(css, { block: true, line: /\.(?:scss|sass|less|styl)$/i.test(file) })
  let text = css
  if (comments.length > 0) {
    let out = ''
    let from = 0
    for (const [start, end] of comments) {
      out += css.slice(from, start) + css.slice(start, end).replace(/[^\n]/g, ' ')
      from = end
    }
    text = out + css.slice(from)
  }
  const lineStarts = [0]
  for (let i = 0; i < css.length; i++) if (css[i] === '\n') lineStarts.push(i + 1)
  const lineOf = (offset) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const blank = (from, to) => /^\s*$/.test(css.slice(from, to))
  const sameLine = (a, b) => !css.slice(a, b).includes('\n')
  // The comment that ends just before `at`, after `boundary`; one on the
  // line of the `;` that closed the previous declaration is that one's.
  // `rule` says it draws a rule, `first` that nothing comes before it in
  // its block.
  const leading = (boundary, at) => {
    for (let k = comments.length - 1; k >= 0; k--) {
      const [s, e] = comments[k]
      if (e > at) continue
      if (s <= boundary || !blank(e, at)) return null
      if (css[boundary] === ';' && sameLine(boundary, s)) return null
      const raw = css.slice(s, e)
      return { text: commentText(raw), rule: RULE.test(raw), first: css[boundary] === '{' && blank(boundary + 1, s) }
    }
    return null
  }
  const trailing = (end) => {
    const next = comments.find(([s]) => s > end)
    return next && sameLine(end, next[0]) && blank(end + 1, next[0]) ? commentText(css.slice(next[0], next[1])) : null
  }

  const rules = []
  const stack = []
  let buf = ''
  let start = -1
  let boundary = -1
  let paren = 0
  const take = (c, i) => {
    if (start < 0 && !/\s/.test(c)) start = i
    buf += c
  }
  const flush = (end) => {
    const top = stack[stack.length - 1]
    const stmt = buf.trim()
    const at = start
    buf = ''
    start = -1
    if (!top || !stmt) return
    const colon = stmt.indexOf(':')
    if (colon === -1) return
    const prop = stmt.slice(0, colon).trim()
    if (!DECLARED_PROPERTY.test(prop)) return
    const lead = leading(boundary, at)
    const trail = css[end] === ';' ? trailing(end) : null
    const opens = lead && (lead.rule || (lead.first && trail))
    const comment = opens ? trail : lead?.text || trail
    top.decls.push({ prop, value: clean(stmt.slice(colon + 1)), line: lineOf(at), comment: comment || '' })
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'") {
      const from = i
      i++
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i++
        i++
      }
      for (let k = from; k <= Math.min(i, text.length - 1); k++) take(text[k], k)
      continue
    }
    // A Sass interpolation (`#{toRem(2)}`) is part of the text it sits in.
    if (c === '#' && text[i + 1] === '{') {
      const end = interpolationEnd(text, i)
      for (let k = i; k <= end; k++) take(text[k], k)
      i = end
      continue
    }
    if (c === '(') paren++
    else if (c === ')') paren = Math.max(0, paren - 1)
    if (paren > 0) {
      take(c, i)
    } else if (c === '{') {
      const rule = { headers: [...stack.map((r) => r.header), clean(buf)], header: clean(buf), decls: [] }
      stack.push(rule)
      rules.push(rule)
      buf = ''
      start = -1
      boundary = i
    } else if (c === '}') {
      flush(i)
      stack.pop()
      boundary = i
    } else if (c === ';') {
      flush(i)
      boundary = i
    } else {
      take(c, i)
    }
  }
  return rules.filter((r) => r.decls.length > 0).map(({ headers, decls }) => ({ headers, decls }))
}

const GROUPING = /^@(?:media|supports|container|layer)\b/i

// A rule's selector list with nesting resolved (`&` stands for the parent,
// and a nested selector without one sits inside it), split into members, and
// the at-rules around it. A rule that is itself an at-rule (`@theme`,
// `@font-face`, a DaisyUI theme) has that prelude as its one member; a
// `@media` nested in a style rule is a condition on that rule.
export function ruleSelectors(headers) {
  const inner = headers[headers.length - 1]
  const selectors = headers.filter((h) => !h.startsWith('@'))
  if (inner.startsWith('@') && !(GROUPING.test(inner) && selectors.length > 0)) {
    return { members: [inner], conditions: headers.slice(0, -1).filter((h) => h.startsWith('@')), atRule: true }
  }
  const conditions = headers.filter((h) => h.startsWith('@'))
  let list = null
  for (const h of selectors) {
    list = list === null
      ? selectorMembers(h)
      : selectorMembers(h).flatMap((m) => list.map((p) => (m.includes('&') ? m.replace(/&/g, p) : `${p} ${m}`)))
  }
  return { members: list.map(clean), conditions, atRule: false }
}

// The key a value is filed under: the member, after every at-rule around it
// but @layer, which changes nothing about where it applies.
export const selectorKey = (member, conditions) => [...conditions.filter((c) => !/^@layer\b/i.test(c)), member].join(' ')

const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2')

// A selector as a theme is matched by: whitespace collapsed, and an
// attribute's plain value without its quotes, so `[data-theme='brand']`,
// `[data-theme="brand"]` and `[data-theme=brand]` are one theme.
const ATTRIBUTE = /\[\s*([\w-]+)\s*([~|^$*]?=)\s*(["']?)([\w-]+)\3\s*([is])?\s*\]/gi
export const canonicalSelector = (s) => clean(s).replace(ATTRIBUTE, (_, name, op, _q, value, flag) => `[${name}${op}${value}${flag ? ` ${flag}` : ''}]`)

// Where the config's themes are: `place(member, conditions, rule)` gives the
// mode a member's values belong to ('default', 'dark' or a named theme), or
// null for a scope. The default theme is the root (`:root`, `html`); a mode
// is the selector the build writes for it, and dark is also the
// colour-scheme query on the root when tokens.darkMedia is on. `@theme` is
// the default theme, and a DaisyUI theme block is the theme it names.
export function themePlacer(config) {
  const dark = canonicalSelector(config.tokens.darkSelector ?? '')
  const named = new Map(Object.entries(config.tokens.selectors ?? {}).map(([mode, s]) => [canonicalSelector(String(s)), mode === (config.tokens.defaultMode ?? 'light') ? 'default' : mode]))
  const selectorOf = new Map([[dark, 'dark'], ...named])
  const place = (member, conditions, rule = null) => {
    const live = conditions.filter((c) => atRuleKind(c).kind !== 'transparent')
    if (live.length === 0) {
      if (/^@theme\b/.test(member)) return 'default'
      if (/^@plugin\s+["']daisyui\/theme["']/i.test(member)) {
        const meta = Object.fromEntries((rule?.decls ?? []).filter((d) => !d.prop.startsWith('--')).map((d) => [d.prop, unquote(d.value)]))
        const name = meta.name ?? 'theme'
        if (meta.prefersdark === 'true' || /dark/i.test(name)) return 'dark'
        return meta.default === 'true' || /light/i.test(name) ? 'default' : name
      }
      if (member.startsWith('@')) return null
      if (classifyMember(member).scope === 'root') return 'default'
      return selectorOf.get(canonicalSelector(member)) ?? null
    }
    const scheme = live.length === 1 ? atRuleKind(live[0]) : null
    if (config.tokens.darkMedia && scheme?.kind === 'scheme' && scheme.mode === 'dark' && !member.startsWith('@') && classifyMember(member).scope === 'root') return 'dark'
    return null
  }
  // The theme a scope sits inside (`html.dark .band-block`), as { mode,
  // theme }, `theme` being the theme's selector as canonicalSelector writes it.
  const inside = (member) => {
    const own = canonicalSelector(member)
    for (const [selector, mode] of selectorOf) if (selector && own.startsWith(`${selector} `)) return { mode, theme: selector }
    return null
  }
  // The theme a scope's selector looks like by the names themes usually
  // have (`.dark`, `[data-theme="brand"]`), for a note; null when it does not.
  const looksLikeTheme = (member, conditions) => {
    if (member.startsWith('@') || conditions.some((c) => atRuleKind(c).kind !== 'transparent')) return null
    const c = classifyMember(member)
    return c.scope === 'selector' ? c.mode : null
  }
  return { place, inside, looksLikeTheme }
}

// Every custom property declaration in a set of sheets, one entry per member
// of its selector list: { file, name, value, member, conditions, key, mode,
// line, comment }, in file order then source order. `mode` is the theme the
// config places the member in, or null for a scope. `pairs` maps each scope
// to the theme it shares a rule with (a theme other than the default wins).
export function sheetDeclarations(sheets, config) {
  const { place } = themePlacer(config)
  const out = []
  const pairs = new Map()
  for (const { file, css } of sheets) {
    for (const rule of cssRules(css, file)) {
      const { members, conditions } = ruleSelectors(rule.headers)
      const modes = members.map((m) => place(m, conditions, rule))
      const shared = modes.find((m) => m && m !== 'default') ?? modes.find(Boolean) ?? null
      members.forEach((member, i) => {
        const key = selectorKey(member, conditions)
        const prior = pairs.get(key)
        if (!modes[i] && shared && (!prior || prior === 'default')) pairs.set(key, shared)
      })
      for (const d of rule.decls) {
        if (!d.prop.startsWith('--')) continue
        members.forEach((member, i) => {
          out.push({ file, name: d.prop, value: d.value, member, conditions, key: selectorKey(member, conditions), mode: modes[i], line: d.line, comment: d.comment })
        })
      }
    }
  }
  return { declarations: out, pairs }
}

// ── The token inventory ─────────────────────────────────────────────────────

const IMPORTANT = /\s*!important$/i
const VAR_CALL = /var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g

// A value with its var() reads replaced through `lookup`, as a colour: hex
// when opaque, `rgb(r g b / a)` when not; null when it is not one, or a read
// stays unresolved. Channel triplets read as the colour they stand for.
export function resolveColour(value, lookup) {
  let text = value.replace(IMPORTANT, '')
  for (let k = 0; k < 8 && text.includes('var('); k++) {
    const next = text.replace(VAR_CALL, (call, name, fallback) => lookup(name)?.replace(IMPORTANT, '') ?? (fallback === undefined ? call : fallback.trim()))
    if (next === text) break
    text = next
  }
  if (text.includes('var(')) return null
  const channels = channelColor(text.trim())
  const c = parseColor(channels ? channels.value : text)
  if (!c) return null
  return c.a >= 1 ? toHex(c) : `rgb(${[c.r, c.g, c.b].map((x) => Math.round(x * 255)).join(' ')} / ${Number(c.a.toFixed(4))})`
}

// massimo's families for a custom property: by its value when it is a
// colour, else by the prefixes and suffixes systems name families with (a
// suffix counts only where its stem has two, as `--h1-size` and
// `--h1-leading` do), the same reading as the CSS reader's.
const FAMILY_OF_GROUP = {
  color: 'color', text: 'typography', 'font-weight': 'typography', leading: 'typography', tracking: 'typography', font: 'typography',
  spacing: 'spacing', radius: 'radius', shadow: 'shadow', 'border-width': 'border', duration: 'motion', ease: 'motion', z: 'z-index', opacity: 'opacity',
}
function builtInFamilies(names) {
  const stems = new Map()
  for (const name of names) {
    const bare = name.slice(2)
    for (const [re, group] of SUFFIX_GROUPS) {
      if (re.test(bare)) stems.set(bare.replace(re, ''), new Set([...(stems.get(bare.replace(re, '')) ?? []), group]))
    }
  }
  return (name, colour) => {
    if (colour) return 'color'
    const bare = name.slice(2)
    const prefix = PREFIX_GROUPS.find(([re]) => re.test(bare))
    if (prefix) return FAMILY_OF_GROUP[prefix[1]] ?? 'other'
    const suffix = SUFFIX_GROUPS.find(([re]) => re.test(bare))
    return suffix && stems.get(bare.replace(suffix[0], ''))?.size >= 2 ? FAMILY_OF_GROUP[suffix[1]] : 'other'
  }
}

// The layer rules of tokens.inventory, in order: a list of file globs, or
// { files, names, selectors }, each a list of globs, where `selectors` is
// matched against the selector a token is first declared under.
function layerRules(inventory) {
  return Object.entries(inventory?.layers ?? {}).map(([name, rule]) => {
    const r = Array.isArray(rule) ? { files: rule } : rule ?? {}
    const test = (globs) => (globs ? compileGlobs(globs) : () => true)
    return { name, files: test(r.files), names: test(r.names), selectors: test(r.selectors) }
  })
}

const TYPE_PROPS = new Set(['font', 'font-family', 'font-size', 'font-weight', 'line-height'])

// Every custom property a set of sheets declares, as tokens/resolved.json
// holds them: one token per file and name, with its layer, its family, and
// its values in source order, one per selector (each member of a selector
// list on its own), each with the colour it resolves to in its theme. A
// value reads its own selector's values first, then its theme's, then the
// root's. Each sheet reads its own declarations, then those of the sheets
// tokens.styleFiles names, which load with every page, and never another
// listed sheet's. Then the type classes and the @font-face rules.
export function inventoryOf(sheets, config) {
  const inventory = config.tokens.inventory ?? {}
  const { place, inside } = themePlacer(config)
  const { declarations, pairs } = sheetDeclarations(sheets, config)
  const shared = compileGlobs(config.tokens.styleFiles ?? [])
  const sheetOf = (file) => (shared(file) ? '' : file)
  // Values by sheet, then by selector (`key`) or by theme (`mode`).
  const values = new Map()
  const put = (id, name, value) => (values.get(id) ?? values.set(id, new Map()).get(id)).set(name, value)
  for (const d of declarations) {
    put(`${sheetOf(d.file)}\nkey\n${canonicalSelector(d.key)}`, d.name, d.value)
    if (d.mode) put(`${sheetOf(d.file)}\nmode\n${d.mode}`, d.name, d.value)
  }
  // The theme a value is read in, as { mode, theme }: its own; a theme's
  // selector under a condition (`html.dark` at a phone width) that theme; a
  // dark colour-scheme query around it dark, when tokens.darkMedia is on; the
  // theme it sits inside; or a theme it shares a rule with, since a rule like
  // `html.dark, .band-dark` makes the scope a stand-in for it.
  const contextOf = (d) => {
    if (d.mode) return { mode: d.mode, theme: null }
    if (config.tokens.darkMedia && d.conditions.some((c) => atRuleKind(c).mode === 'dark')) return { mode: 'dark', theme: null }
    const bare = d.member.startsWith('@') ? null : place(d.member, [])
    if (bare) return { mode: bare, theme: bare === 'default' ? null : canonicalSelector(d.member) }
    return inside(d.member) ?? { mode: pairs.get(d.key) ?? 'default', theme: null }
  }
  const lookupFor = (d) => {
    const { mode, theme } = contextOf(d)
    const own = sheetOf(d.file)
    const from = (kind, id) => [own, ...(own ? [''] : [])].map((sheet) => values.get(`${sheet}\n${kind}\n${id}`))
    const maps = [...from('key', canonicalSelector(d.key)), ...(theme ? from('key', theme) : []), ...(mode !== 'default' ? from('mode', mode) : []), ...from('mode', 'default')]
    return (name) => maps.find((m) => m?.has(name))?.get(name)
  }
  const tokens = []
  const byKey = new Map()
  for (const d of declarations) {
    const key = `${d.file}\n${d.name}`
    if (!byKey.has(key)) {
      const token = { name: d.name, file: d.file, layer: null, family: null, values: [] }
      byKey.set(key, token)
      tokens.push(token)
    }
    const resolved = resolveColour(d.value, lookupFor(d))
    byKey.get(key).values.push({ selector: d.key, value: d.value, ...(resolved ? { resolved } : {}) })
  }
  const layers = layerRules(inventory)
  const families = Object.entries(inventory.families ?? {}).map(([name, globs]) => ({ name, test: compileGlobs(globs) }))
  const builtIn = builtInFamilies(tokens.map((t) => t.name))
  for (const t of tokens) {
    t.layer = layers.length === 0 ? 'tokens' : layers.find((l) => l.files(t.file) && l.names(t.name) && l.selectors(t.values[0].selector))?.name ?? 'other'
    t.family = families.find((f) => f.test(t.name))?.name ?? builtIn(t.name, t.values.some((v) => v.resolved))
  }

  // Type classes: those tokens.inventory.typeClasses names, wherever a
  // selector uses them, or else every class that is a selector on its own
  // in a rule that sets a size, line height, weight or family.
  const named = inventory.typeClasses ? compileGlobs(inventory.typeClasses) : null
  const typeClasses = new Set()
  const faces = []
  for (const { file, css } of sheets) {
    for (const rule of cssRules(css, file)) {
      const { members, atRule } = ruleSelectors(rule.headers)
      if (atRule && /^@font-face$/i.test(members[0])) {
        const get = (prop) => rule.decls.filter((d) => d.prop === prop).pop()?.value ?? ''
        faces.push({ family: unquote(get('font-family')), weight: get('font-weight') || 'normal', style: get('font-style') || 'normal', src: /url\(\s*["']?([^"')]+)/.exec(get('src'))?.[1] ?? '', file })
        continue
      }
      if (atRule) continue
      const setsType = rule.decls.some((d) => TYPE_PROPS.has(d.prop))
      for (const member of members) {
        if (named) for (const [, cls] of member.matchAll(/\.([\w-]+)/g)) if (named(cls)) typeClasses.add(cls)
        if (!named && setsType && /^\.[\w-]+$/.test(member)) typeClasses.add(member.slice(1))
      }
    }
  }
  const order = (a, b) => compare(a.family, b.family) || compare(a.style, b.style) || compare(a.weight, b.weight) || compare(a.file, b.file) || compare(a.src, b.src)
  return { tokens, typeClasses: [...typeClasses].sort(compare), faces: faces.sort(order) }
}
