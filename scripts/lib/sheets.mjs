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

import { atRuleKind, classifyMember, scanSource, selectorMembers } from './source.mjs'

const clean = (s) => s.replace(/\s+/g, ' ').trim()

const RULE = /[─-╿]+|-{3,}|={3,}/
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
// Values keep what the author wrote, `!important` too, with whitespace and
// comments inside them collapsed.
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
  const leading = (boundary, at) => {
    for (let k = comments.length - 1; k >= 0; k--) {
      const [s, e] = comments[k]
      if (e > at) continue
      if (s <= boundary || !blank(e, at)) return null
      if (css[boundary] === ';' && sameLine(boundary, s)) return null
      return commentText(css.slice(s, e))
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
    if (!/^[-\w]+$/.test(prop)) return
    const comment = leading(boundary, at) || (css[end] === ';' ? trailing(end) : null)
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

// Where the config's themes are: `place(member, conditions, rule)` gives the
// mode a member's values belong to ('default', 'dark' or a named theme), or
// null for a scope. The default theme is the root (`:root`, `html`); a mode
// is the selector the build writes for it, and dark is also the
// colour-scheme query on the root when tokens.darkMedia is on. `@theme` is
// the default theme, and a DaisyUI theme block is the theme it names.
export function themePlacer(config) {
  const dark = clean(config.tokens.darkSelector ?? '')
  const named = new Map(Object.entries(config.tokens.selectors ?? {}).map(([mode, s]) => [clean(String(s)), mode === (config.tokens.defaultMode ?? 'light') ? 'default' : mode]))
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
      return selectorOf.get(member) ?? null
    }
    const scheme = live.length === 1 ? atRuleKind(live[0]) : null
    if (config.tokens.darkMedia && scheme?.kind === 'scheme' && scheme.mode === 'dark' && !member.startsWith('@') && classifyMember(member).scope === 'root') return 'dark'
    return null
  }
  // The mode a scope's values are read in: the theme it sits inside
  // (`html.dark .band-block`), or a theme it shares a rule with, since a
  // rule like `html.dark, .band-dark` makes the scope a stand-in for it.
  const inside = (member) => {
    for (const [selector, mode] of selectorOf) if (selector && member.startsWith(`${selector} `)) return mode
    return null
  }
  // Why a selector that looks like a theme is kept as a scope, or null.
  const looksLikeTheme = (member, conditions) => {
    if (member.startsWith('@') || conditions.some((c) => atRuleKind(c).kind !== 'transparent')) return null
    const c = classifyMember(member)
    return c.scope === 'selector' ? c.mode : null
  }
  return { place, inside, looksLikeTheme, selectorFor: (mode) => [...selectorOf].find(([, m]) => m === mode)?.[0] ?? null }
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
