// What a component takes and shows: its props (from TypeScript types, Vue's
// defineProps, Svelte's props, Astro's Props, and cva or tv variant maps),
// their values and defaults, the states it styles (hover, focus, disabled…),
// and how call sites actually use each prop. Read from the source as text,
// like the rest of the graph; it aims for the right answer on ordinary
// components, not a full type checker.

import { parseArrayAt, parseObjectAt } from './jsobject.mjs'

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

// Each member keeps its type text as `type`, which componentProps reads and
// never returns.
function propsFromTypeBody(body) {
  const out = []
  for (const m of members(stripComments(body))) {
    const p = /^(?:readonly\s+)?['"]?([A-Za-z_$][\w$-]*)['"]?(\?)?\s*:\s*([\s\S]+)$/.exec(m)
    if (!p) continue
    out.push({ name: p[1], optional: Boolean(p[2]), type: p[3], ...describeType(p[3]) })
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

// The variant map of the cva or tv call whose arguments start at `i`, or null.
function mapAt(src, i) {
  // Skip a first string argument (cva's base classes).
  const rest = src.slice(i)
  const lead = /^\s*(?:(['"`])(?:\\.|(?!\1)[\s\S])*\1|\[[\s\S]*?\])\s*,\s*/.exec(rest)
  if (lead) i += lead[0].length
  const brace = src.indexOf('{', i)
  if (brace === -1 || /\S/.test(src.slice(i, brace))) return null
  const obj = parseObjectAt(src, brace)
  return obj?.variants && typeof obj.variants === 'object' ? obj : null
}

// cva('base', { variants: { variant: { primary: '…' } }, defaultVariants }) and tv({ … }).
function variantMaps(src) {
  const out = []
  for (const m of src.matchAll(/\b(?:cva|tv)\s*\(/g)) {
    const obj = mapAt(src, m.index + m[0].length)
    if (obj) out.push(obj)
  }
  return out
}

const escapeName = (s) => s.replace(/\$/g, '\\$')

// Where `src` binds `name` to a cva or tv call (`const buttonVariants = cva(`).
const mapBinding = (src, name) => new RegExp(`(?<![\\w$])(?:const|let|var)\\s+${escapeName(name)}\\s*(?::[^=]*)?=\\s*(?:cva|tv)\\s*\\(`).exec(src)

// The variant map bound to `name` in `src` (`const buttonVariants = cva(…)`), or null.
function namedMap(src, name) {
  const m = mapBinding(src, name)
  return m ? mapAt(src, m.index + m[0].length) : null
}

// Every literal string under a value read by parseObjectAt; a skipped
// expression gives none.
const stringsIn = (v) =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(stringsIn) : v && typeof v === 'object' && !('expr' in v) && !('spread' in v) ? Object.values(v).flatMap(stringsIn) : []

// The class strings of the variant map bound to `name` in `src`, for a call
// whose argument parseObjectAt read as `args` (null when it is no object
// literal): cva's base classes, tv's base and slots, each compound variant's
// class, and each variant's options. A variant the call sets to a literal
// reads that option alone, and one it leaves out reads its default, so
// `buttonVariants({ variant: 'outline' })` reads the outline classes; an
// expression, a spread or an argument that is no object reads every option.
// Null when `src` binds no variant map to `name`.
function mapClasses(src, name, args) {
  const m = mapBinding(src, name)
  const at = m ? m.index + m[0].length : -1
  const map = m ? mapAt(src, at) : null
  if (!map) return null
  const lead = /^\s*(?:(['"`])((?:\\.|(?!\1)[\s\S])*)\1|(\[))/.exec(src.slice(at))
  const base = !lead ? [] : lead[3] ? stringsIn(parseArrayAt(src, at + lead[0].length - 1)) : [lead[2]]
  const compound = [].concat(map.compoundVariants ?? [], map.compoundSlots ?? []).flatMap((c) => [...stringsIn(c?.class), ...stringsIn(c?.className)])
  const defaults = map.defaultVariants && typeof map.defaultVariants === 'object' ? map.defaultVariants : {}
  // The value the call gives a variant: undefined when it is not known, null for none.
  const given = (k) => (!args ? undefined : Object.hasOwn(args, k) ? args[k] : args.__spreads ? undefined : Object.hasOwn(defaults, k) ? defaults[k] : null)
  const variants = Object.entries(map.variants).flatMap(([k, options]) => {
    const v = given(k)
    if (v === null) return []
    const one = ['string', 'boolean', 'number'].includes(typeof v) && options && typeof options === 'object' && Object.hasOwn(options, String(v))
    return stringsIn(one ? options[String(v)] : options)
  })
  return [...base, ...stringsIn(map.base), ...stringsIn(map.slots), ...variants, ...compound]
}

// The class strings a component reads through the cva or tv maps it imports
// and calls (`buttonVariants({ variant })`), each call read as mapClasses
// reads it. `sourceOf(name)` is the source of the module the component
// imports `name` from, or null.
export function calledMapClasses(code, sourceOf) {
  const out = new Set()
  const sources = new Map()
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(\s*/g)) {
    if (!sources.has(m[1])) {
      const src = sourceOf(m[1])
      sources.set(m[1], src && mapBinding(src, m[1]) ? src : null)
    }
    const src = sources.get(m[1])
    if (!src) continue
    const at = m.index + m[0].length
    const args = code[at] === ')' ? {} : code[at] === '{' ? parseObjectAt(code, at) : null
    for (const list of mapClasses(src, m[1], args) ?? []) out.add(list)
  }
  return [...out]
}

// The values and default of a prop typed through a variant map, as
// shadcn-vue writes it: `variant?: ButtonVariants["variant"]`, with
// `type ButtonVariants = VariantProps<typeof buttonVariants>` and
// `const buttonVariants = cva(…)` in the component or in the module it
// imports them from (`sourceOf(name)` is that module's source, or null).
function typedVariant(type, src, sourceOf) {
  const ref = /^([A-Za-z_$][\w$]*)\s*\[\s*(['"])([^'"]+)\2\s*\]$/.exec(type.trim())
  if (!ref) return null
  const alias = new RegExp(`(?<![\\w$])type\\s+${escapeName(ref[1])}\\s*=\\s*VariantProps\\s*<\\s*typeof\\s+([A-Za-z_$][\\w$]*)\\s*>`)
  for (const typeSrc of [src, sourceOf(ref[1])]) {
    const a = typeSrc ? alias.exec(typeSrc) : null
    if (!a) continue
    for (const mapSrc of [typeSrc, src, sourceOf(a[1])]) {
      const map = mapSrc ? namedMap(mapSrc, a[1]) : null
      const options = map && Object.hasOwn(map.variants, ref[3]) ? map.variants[ref[3]] : null
      if (!options || typeof options !== 'object') continue
      const defaults = map.defaultVariants && typeof map.defaultVariants === 'object' ? map.defaultVariants : {}
      return { values: Object.keys(options), default: Object.hasOwn(defaults, ref[3]) ? defaults[ref[3]] : undefined }
    }
    return null
  }
  return null
}

// The literal defaults Vue's withDefaults(defineProps<…>(), { … }) gives.
function withDefaultsOf(src) {
  const m = /\bwithDefaults\s*\(\s*defineProps\s*<[\s\S]*?>\s*\(\s*\)\s*,\s*\{/.exec(src)
  const obj = m ? parseObjectAt(src, m.index + m[0].length - 1) : null
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => ['string', 'boolean', 'number'].includes(typeof v)).map(([k, v]) => [k, String(v)]))
}

// A component's props, read from its own source, and from the module it
// imports a variant map's type from when `sourceOf(name)` gives that
// module's source.
export function componentProps(source, file, name, sourceOf = null) {
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
  // Vue: defineProps<{…}>(), defineProps<Other & {…}>() or defineProps({…}).
  const vueType = /defineProps\s*<\s*(?:[A-Za-z_$][\w$.]*(?:<[^<>]*>)?\s*&\s*)*\{/.exec(src)
  if (vueType) add(propsFromTypeBody(braceBody(src, vueType.index + vueType[0].length - 1) ?? ''), 'type')
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
  // A prop typed through a variant map takes the map's values, and its
  // default from withDefaults(), else the map's defaultVariants.
  if (sourceOf) {
    let given = null
    for (const p of props.values()) {
      if (p.values || typeof p.type !== 'string') continue
      const v = typedVariant(p.type, src, sourceOf)
      if (!v) continue
      given ??= withDefaultsOf(src)
      p.values = v.values
      const def = given[p.name] ?? v.default
      if (p.default === undefined && (typeof def === 'string' || typeof def === 'boolean')) p.default = String(def)
    }
  }
  // Defaults from the component's own destructured parameters, and from an
  // Astro component's `const { variant = 'primary' } = Astro.props`.
  const params = /\(\s*\{([^}]*)\}\s*(?::\s*[\w<>[\],\s|.]*)?\)\s*(?:=>|\{)/.exec(src)
  const astro = /const\s*\{([^}]*)\}\s*(?::[^=]*)?=\s*Astro\.props\b/.exec(src)
  for (const destructured of [astro, params]) {
    if (!destructured) continue
    for (const [k, v] of Object.entries(defaultsIn(destructured[1]))) {
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

// The prop and value an attribute at a .vue call site sets, or null for one
// that sets no prop: a directive (v-if, v-for, v-model, v-slot, v-on, a bare
// v-bind), a slot (#name), an event (@name), key, ref, class, style, a
// listener, or a dynamic argument (`:[name]`), whose prop is not known.
// `:name` and `v-bind:name` bind an expression, which counts as its text when
// it is a quoted literal or true or false, else as `{…}`. A kebab-case name
// is the camelCase prop Vue matches it to; aria-* and data-* attributes keep
// their names.
function vueAttribute(raw, value, quoted) {
  if (/^(?:#|@|v-(?!bind:))|\[/.test(raw)) return null
  const bound = /^(?::|v-bind:)/.test(raw)
  const written = raw.replace(/^(?::|v-bind:)/, '').split('.')[0]
  const prop = /^(?:aria|data)-/.test(written) ? written : written.replace(/-(\w)/g, (_, c) => c.toUpperCase())
  if (!prop || /^(?:key|ref|class|style)$|^on[A-Z]/.test(prop)) return null
  if (!bound) return { prop, value }
  const expr = (quoted ?? '').trim()
  const literal = /^(['"])([^'"]*)\1$|^`((?:[^`$\\]|\$(?!\{))*)`$/.exec(expr)
  return { prop, value: literal ? literal[2] ?? literal[3] : /^(?:true|false)$/.test(expr) ? expr : '{…}' }
}

// An attribute in a tag: its name, then a value in quotes or braces. A .vue
// call site also names slots with `#`, and a directive's argument may be
// dynamic (`:[name]`, `v-bind:[name]`).
const ATTRIBUTE = /([A-Za-z_:@][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(['"`])([^'"`]*)\4\s*\}|\{([^}]*)\}))?/g
const VUE_ATTRIBUTE = /([A-Za-z_:@#][\w:.-]*(?:\[[^\]]*\][\w.-]*)?)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(['"`])([^'"`]*)\4\s*\}|\{([^}]*)\}))?/g

// How call sites set a component's props: for each prop, how many times each
// value was passed (`true` for a bare attribute, `{…}` for an expression).
// `files` are `{ file, text }`; a .vue call site is read as Vue reads it.
export function callSiteUsage(name, files) {
  const usage = {}
  const tag = new RegExp(`<${name}\\b((?:[^>"'{]|"[^"]*"|'[^']*'|\\{[^}]*\\})*)\\/?>`, 'g')
  for (const { file, text } of files) {
    const vue = /\.vue$/i.test(file ?? '')
    for (const m of text.matchAll(tag)) {
      for (const a of m[1].matchAll(vue ? VUE_ATTRIBUTE : ATTRIBUTE)) {
        let prop = a[1]
        if (!vue && /^(key|ref|class|className|style|on[A-Z]|@|v-on:|:class|:style)/.test(prop)) continue
        let value = a[2] ?? a[3] ?? a[5] ?? (a[6] !== undefined ? (/^(true|false)$/.test(a[6].trim()) ? a[6].trim() : '{…}') : 'true')
        if (vue) {
          const set = vueAttribute(prop, value, a[2] ?? a[3])
          if (!set) continue
          ;({ prop, value } = set)
        }
        usage[prop] ??= {}
        usage[prop][value] = (usage[prop][value] ?? 0) + 1
      }
    }
  }
  return usage
}
