// What a component takes and shows: its props (from TypeScript types, Vue's
// defineProps, Svelte's props, Astro's Props, and cva or tv variant maps),
// their values and defaults, the states it styles (hover, focus, disabled…),
// and how call sites actually use each prop. Read from the source as text,
// like the rest of the graph; it aims for the right answer on ordinary
// components, not a full type checker.

import { parseObjectAt } from './jsobject.mjs'

// The `{…}` that starts at or after `from`, with what is between its braces.
function braceBody(src, from) {
  const open = src.indexOf('{', from)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i)
  }
  return null
}

// Split a type literal's body into its members, at depth 0.
function members(body) {
  const out = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    // The > of an arrow (=>) closes nothing.
    if ('{([<'.includes(c)) depth++
    else if ('})]'.includes(c) || (c === '>' && body[i - 1] !== '=')) depth--
    if (depth === 0 && (c === ';' || c === '\n' || c === ',')) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else {
      cur += c
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

// A prop's type as values (a union of string literals, or true/false) and a
// kind: an event handler, a slot for content, or a plain value.
function describeType(type) {
  const t = type.trim()
  const literals = [...t.matchAll(/(['"])([^'"]*)\1/g)].map((m) => m[2])
  if (literals.length > 0 && t.replace(/(['"])[^'"]*\1|\||\s/g, '') === '') return { values: literals }
  if (/^boolean$/.test(t)) return { values: ['true', 'false'] }
  if (/=>|^\(?\s*\(?(?:event|e)\b|EventHandler|^Function$/.test(t)) return { kind: 'handler' }
  if (/ReactNode|JSX\.Element|Snippet|VNode|ComponentChildren/.test(t)) return { kind: 'slot' }
  return {}
}

function propsFromTypeBody(body) {
  const out = []
  for (const m of members(stripComments(body))) {
    const p = /^(?:readonly\s+)?['"]?([A-Za-z_$][\w$-]*)['"]?(\?)?\s*:\s*([\s\S]+)$/.exec(m)
    if (!p) continue
    out.push({ name: p[1], optional: Boolean(p[2]), ...describeType(p[3]) })
  }
  return out
}

// Defaults from a destructuring like ({ variant = 'primary', size = 'md' }).
function defaultsIn(text) {
  const out = {}
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`]*)\2/g)) out[m[1]] = m[3]
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(true|false|-?\d+(?:\.\d+)?)\b/g)) out[m[1]] ??= m[2]
  return out
}

// cva('base', { variants: { variant: { primary: '…' } }, defaultVariants }) and tv({ … }).
function variantMaps(src) {
  const out = []
  for (const m of src.matchAll(/\b(?:cva|tv)\s*\(/g)) {
    let i = m.index + m[0].length
    // Skip a first string argument (cva's base classes).
    const rest = src.slice(i)
    const lead = /^\s*(?:(['"`])(?:\\.|(?!\1)[\s\S])*\1|\[[\s\S]*?\])\s*,\s*/.exec(rest)
    if (lead) i += lead[0].length
    const brace = src.indexOf('{', i)
    if (brace === -1 || /\S/.test(src.slice(i, brace))) continue
    const obj = parseObjectAt(src, brace)
    if (obj?.variants && typeof obj.variants === 'object') out.push(obj)
  }
  return out
}

// A component's props, read from its own source.
export function componentProps(source, file, name) {
  const src = source
  const props = new Map()
  const add = (list, from) => {
    for (const p of list) {
      const known = props.get(p.name) ?? { name: p.name }
      props.set(p.name, { ...p, ...known, values: known.values ?? p.values, kind: known.kind ?? p.kind, from: known.from ?? from })
    }
  }
  // TypeScript: <Name>Props, Props, or any *Props type.
  const typeDecl = [new RegExp(`(?:interface|type)\\s+${name}Props\\b`), /(?:interface|type)\s+Props\b/, /(?:interface|type)\s+\w*Props\b/]
    .map((re) => re.exec(src))
    .find(Boolean)
  if (typeDecl) {
    const body = braceBody(src, typeDecl.index + typeDecl[0].length)
    if (body !== null) add(propsFromTypeBody(body), 'type')
  }
  // Vue: defineProps<{…}>() or defineProps({…}).
  const vueType = /defineProps\s*<\s*\{/.exec(src)
  if (vueType) add(propsFromTypeBody(braceBody(src, vueType.index) ?? ''), 'type')
  const vueObj = !vueType && /defineProps\s*\(\s*\{/.exec(src)
  if (vueObj) {
    const obj = parseObjectAt(src, src.indexOf('{', vueObj.index))
    for (const [key, v] of Object.entries(obj ?? {})) {
      const def = v && typeof v === 'object' && 'default' in v && typeof v.default !== 'object' ? String(v.default) : undefined
      add([{ name: key, ...(def !== undefined ? { default: def } : {}) }], 'type')
    }
  }
  // Svelte 5 ($props) and Svelte 4 (export let).
  const runes = /let\s*\{([^}]*)\}\s*(?::[^=]*)?=\s*\$props\(\)/.exec(src)
  if (runes) {
    const defaults = defaultsIn(runes[1])
    add(runes[1].split(',').map((s) => s.trim().split(/[\s=:]/)[0]).filter((n) => n && !n.startsWith('...')).map((n) => ({ name: n, ...(defaults[n] ? { default: defaults[n] } : {}) })), 'type')
  }
  for (const m of src.matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)(?:\s*:\s*([^=;\n]+))?(?:\s*=\s*([^;\n]+))?/g)) {
    add([{ name: m[1], ...(m[2] ? describeType(m[2]) : {}), ...(m[3] ? { default: m[3].trim().replace(/^(['"`])(.*)\1$/, '$2') } : {}) }], 'type')
  }
  // cva and tv variant maps.
  for (const map of variantMaps(src)) {
    for (const [variant, options] of Object.entries(map.variants)) {
      if (!options || typeof options !== 'object') continue
      const def = map.defaultVariants?.[variant]
      const values = Object.keys(options)
      const known = props.get(variant)
      props.set(variant, { ...(known ?? {}), name: variant, values, ...(typeof def === 'string' || typeof def === 'boolean' ? { default: String(def) } : {}), from: known?.from ?? 'variants' })
    }
  }
  // Defaults from the component's own destructured parameters.
  const params = /\(\s*\{([^}]*)\}\s*(?::\s*[\w<>[\],\s|.]*)?\)\s*(?:=>|\{)/.exec(src)
  if (params) {
    for (const [k, v] of Object.entries(defaultsIn(params[1]))) {
      const known = props.get(k)
      if (known) known.default ??= v
    }
  }
  return [...props.values()].map(({ name: n, values, default: d, kind, optional, from }) => ({
    name: n,
    ...(values ? { values } : {}),
    ...(d !== undefined ? { default: d } : {}),
    ...(kind ? { kind } : {}),
    ...(optional ? { optional } : {}),
    from,
  }))
}

// The states a component styles: Tailwind state variants, CSS pseudo-classes,
// ARIA and data attributes, and props that name a state.
const STATE_PROPS = /^(disabled|loading|error|invalid|selected|checked|open|active|pressed|expanded|readOnly|required|busy)$/
export function componentStates(source, props = []) {
  const states = new Set()
  for (const m of source.matchAll(/(?<![\w-])(hover|focus-visible|focus-within|focus|active|disabled|visited|checked|invalid|required|placeholder-shown|open|group-hover|peer-checked|aria-[a-z-]+|data-\[[^\]]+\])(?=:)/g)) {
    states.add(m[1].replace(/^group-|^peer-/, ''))
  }
  for (const m of source.matchAll(/:(hover|focus-visible|focus-within|focus|active|disabled|checked|invalid|open)\b/g)) states.add(m[1])
  for (const m of source.matchAll(/\[(aria-[a-z-]+)(?:=["']?(\w+))?/g)) states.add(m[2] ? `${m[1]}=${m[2]}` : m[1])
  for (const p of props) if (STATE_PROPS.test(p.name)) states.add(p.name)
  return [...states].sort()
}

// How call sites set a component's props: for each prop, how many times each
// value was passed (`true` for a bare attribute, `{…}` for an expression).
export function callSiteUsage(name, files) {
  const usage = {}
  const tag = new RegExp(`<${name}\\b((?:[^>"'{]|"[^"]*"|'[^']*'|\\{[^}]*\\})*)\\/?>`, 'g')
  for (const { text } of files) {
    for (const m of text.matchAll(tag)) {
      for (const a of m[1].matchAll(/([A-Za-z_:@][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(['"`])([^'"`]*)\4\s*\}|\{([^}]*)\}))?/g)) {
        const prop = a[1]
        if (/^(key|ref|class|className|style|on[A-Z]|@|v-on:|:class|:style)/.test(prop)) continue
        const value = a[2] ?? a[3] ?? a[5] ?? (a[6] !== undefined ? (/^(true|false)$/.test(a[6].trim()) ? a[6].trim() : '{…}') : 'true')
        usage[prop] ??= {}
        usage[prop][value] = (usage[prop][value] ?? 0) + 1
      }
    }
  }
  return usage
}
