// Names for the mobile token outputs: a token path as a Swift or Kotlin
// identifier (lowerCamelCase), an asset catalog colour name (PascalCase
// folders that provide a namespace), and an Android resource name
// (snake_case). Each rule renames what the language cannot hold, a reserved
// word or a leading digit, and says so; two tokens that end up with one name
// are a collision, reported like two tokens that claim one CSS variable.

// Swift keywords a declaration cannot use bare, plus the member names Swift
// reserves on every type.
export const SWIFT_RESERVED = new Set([
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init', 'inout', 'internal', 'let', 'open',
  'operator', 'private', 'precedencegroup', 'protocol', 'public', 'rethrows', 'static', 'struct', 'subscript', 'typealias', 'var',
  'break', 'case', 'catch', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat', 'return',
  'throw', 'switch', 'where', 'while', 'Any', 'as', 'await', 'false', 'is', 'nil', 'self', 'Self', 'super', 'throws', 'true', 'try',
  'Type', 'Protocol',
])

// Kotlin's hard keywords, which no identifier may be without backticks.
export const KOTLIN_RESERVED = new Set([
  'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is', 'null', 'object', 'package',
  'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while',
])

// The words of a name: split on anything that is not a letter or digit, and
// where lower case meets upper case (`onPrimary` is on, Primary).
export function words(text) {
  return String(text)
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1)
// ASCII only: an identifier with a letter Swift or Kotlin reads differently is no help to anyone.
const ascii = (w) => w.normalize('NFKD').replace(/[^A-Za-z0-9]/g, '')

export function camelCase(parts) {
  const all = [].concat(parts).flatMap(words).map(ascii).filter(Boolean)
  return all.map((w, i) => (i === 0 ? w.toLowerCase() : cap(w.toLowerCase()))).join('')
}

export function pascalCase(parts) {
  return [].concat(parts).flatMap(words).map(ascii).filter(Boolean).map((w) => cap(w.toLowerCase())).join('')
}

export function snakeCase(parts) {
  return [].concat(parts).flatMap(words).map(ascii).filter(Boolean).map((w) => w.toLowerCase()).join('_')
}

// The group words a token's first path segment stands for, as the type that
// holds its members in the code outputs.
export const GROUPS = {
  color: 'Colors', colors: 'Colors',
  spacing: 'Spacing', space: 'Spacing',
  radius: 'Radius', radii: 'Radius', rounded: 'Radius',
  font: 'Typography', text: 'Typography', type: 'Typography', typography: 'Typography', 'font-size': 'Typography', leading: 'Typography', tracking: 'Typography', 'font-weight': 'Typography',
  shadow: 'Shadows', shadows: 'Shadows', elevation: 'Shadows',
  motion: 'Motion', duration: 'Motion', ease: 'Motion', easing: 'Motion', transition: 'Motion',
  size: 'Sizes', sizes: 'Sizes',
  border: 'Borders', 'border-width': 'Borders',
  opacity: 'Opacity',
  z: 'Layers', 'z-index': 'Layers', layer: 'Layers',
}

// The group a token sits in for the code outputs: its first path segment's,
// else by its type, else Other. Every colour sits in Colors, since that is
// where both code outputs declare colours: one under another group keeps
// that group's word (`text.primary` is `textPrimary`), so it does not meet
// `border.primary` there. A token under `color` that is not a colour (an
// opacity, a gradient) goes by its type, keeping the word `color`.
export function groupOf(path, type) {
  const first = String(path[0] ?? '')
  const mapped = GROUPS[first]
  if (type === 'color') return { name: 'Colors', dropFirst: mapped === 'Colors' }
  if (mapped && mapped !== 'Colors') return { name: mapped, dropFirst: true }
  const byType = { color: 'Colors', dimension: 'Sizes', fontFamily: 'Typography', fontWeight: 'Typography', typography: 'Typography', duration: 'Motion', cubicBezier: 'Motion', shadow: 'Shadows', border: 'Borders', number: 'Numbers', gradient: 'Gradients' }[type]
  return { name: byType ?? 'Other', dropFirst: false }
}

// A member name for a token inside its group: the path without the group's
// own segment and without `$root`, in lowerCamelCase. A name that starts with
// a digit takes the group's word in front (`spacing.2` is `spacing2`), and a
// reserved word takes the group's word after it (`color.default` is
// `defaultColor`). `reserved` is the language's set.
export function memberName(path, type, reserved) {
  const { name: group, dropFirst } = groupOf(path, type)
  const rest = path.filter((p) => p !== '$root').slice(dropFirst ? 1 : 0)
  const word = singular(group)
  const base = camelCase(rest.length > 0 ? rest : [word])
  if (!base) return { name: camelCase([word, 'token']), renamed: 'has no letters or digits' }
  if (/^\d/.test(base)) return { name: `${word.toLowerCase()}${cap(base)}`, renamed: 'starts with a digit' }
  if (reserved.has(base)) return { name: `${base}${cap(word)}`, renamed: `"${base}" is a reserved word` }
  return { name: base, renamed: null }
}

const SINGULAR = { Colors: 'color', Spacing: 'spacing', Radius: 'radius', Typography: 'text', Shadows: 'shadow', Motion: 'motion', Sizes: 'size', Borders: 'border', Opacity: 'opacity', Layers: 'layer', Numbers: 'number', Gradients: 'gradient', Other: 'token' }
const singular = (group) => SINGULAR[group] ?? 'token'

// An asset catalog colour name for a token: the name it was read from
// (`$extensions.massimo.mobile.asset`), else its path without the colour group,
// each segment PascalCase and joined by "/", every folder but the last a
// namespace.
export function assetName(t) {
  if (typeof t.mobile?.asset === 'string' && t.mobile.asset.trim()) return t.mobile.asset.trim()
  const rest = t.path.filter((p) => p !== '$root')
  const parts = (GROUPS[rest[0]] === 'Colors' && rest.length > 1 ? rest.slice(1) : rest).map((p) => pascalCase(p) || 'Color')
  return parts.join('/')
}

// An Android resource name: the whole path in snake_case, group included, so
// `color.brand.primary` is `color_brand_primary` and never meets a name the
// app's own colors.xml already uses for itself. A name that starts with a
// digit takes `token_` in front.
export function resourceName(t) {
  const name = snakeCase(t.path.filter((p) => p !== '$root'))
  return /^\d/.test(name) || !name ? `token_${name}` : name
}

// Collisions inside one scope: [{ name, tokens: [a, b] }] for every name two
// or more tokens map to.
export function collisions(entries) {
  const by = new Map()
  for (const e of entries) by.set(e.name, [...(by.get(e.name) ?? []), e.token])
  return [...by].filter(([, tokens]) => tokens.length > 1).map(([name, tokens]) => ({ name, tokens }))
}
