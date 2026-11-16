// Units for the mobile token outputs. A px is one point on iOS and one dp on
// Android, a rem is `remBase` of them (16 unless tokens.mobile.remBase says
// otherwise), a font size is sp on Android (tokens.mobile.fontUnit) and
// points scaled with Dynamic Type on iOS, and a duration is seconds in Swift
// and milliseconds in Kotlin and Android resources. These are conventions
// (Style Dictionary's transform groups do the same), not part of the W3C
// format, so each one can be overridden in tokens.mobile.
//
// A length in em follows the font size it sits in, so it has no fixed value
// on either platform: it is reported as not carried over.

// The options every mobile builder reads, with their defaults. `colors` is
// "catalog" when a source lists an asset catalog, else "tokens".
export function mobileOptions(config) {
  const own = config?.tokens?.mobile && typeof config.tokens.mobile === 'object' ? config.tokens.mobile : {}
  const sources = Array.isArray(config?.tokens?.mobileSources) ? config.tokens.mobileSources : []
  const hasCatalog = sources.some((s) => s?.kind === 'xcassets')
  return {
    remBase: typeof own.remBase === 'number' && own.remBase > 0 ? own.remBase : 16,
    fontUnit: own.fontUnit === 'dp' ? 'dp' : 'sp',
    namespace: typeof own.namespace === 'string' && /^[A-Z][A-Za-z0-9]*$/.test(own.namespace) ? own.namespace : 'DesignTokens',
    package: typeof own.package === 'string' && own.package.trim() ? own.package.trim() : null,
    uikit: own.uikit === true,
    colors: own.colors === 'catalog' || own.colors === 'tokens' ? own.colors : hasCatalog ? 'catalog' : 'tokens',
    textStyles: own.textStyles && typeof own.textStyles === 'object' ? own.textStyles : {},
  }
}

const round = (n, places = 4) => Number(Number(n).toFixed(places))

// A DTCG dimension (or a CSS length) as points or dp, or null with the reason.
export function lengthOf(v, { remBase = 16 } = {}) {
  let value
  let unit
  if (v && typeof v === 'object' && typeof v.value === 'number') {
    value = v.value
    unit = v.unit ?? 'px'
  } else if (typeof v === 'number') {
    value = v
    unit = 'px'
  } else if (typeof v === 'string') {
    const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|pt|dp|sp)?\s*$/.exec(v)
    if (!m) return { value: null, why: `"${v}" is not a length` }
    value = Number(m[1])
    unit = m[2] ?? 'px'
  } else {
    return { value: null, why: 'is not a length' }
  }
  if (unit === 'px' || unit === 'pt' || unit === 'dp' || unit === 'sp') return { value: round(value) }
  if (unit === 'rem') return { value: round(value * remBase) }
  return { value: null, why: `is in ${unit}, which follows the font size it sits in and has no fixed value on a phone` }
}

// A DTCG duration as milliseconds, or null with the reason.
export function millisecondsOf(v) {
  if (v && typeof v === 'object' && typeof v.value === 'number') return v.unit === 's' ? { value: round(v.value * 1000) } : { value: round(v.value) }
  if (typeof v === 'string') {
    const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))(ms|s)\s*$/.exec(v)
    if (m) return { value: round(m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1])) }
  }
  if (typeof v === 'number') return { value: round(v) }
  return { value: null, why: 'is not a duration' }
}

// A number as Swift or Kotlin source: no trailing zeros, never exponent form.
export function numberText(n) {
  const r = round(n, 6)
  const s = String(r)
  return /e/i.test(s) ? r.toFixed(6).replace(/\.?0+$/, '') : s
}

// Kotlin's Float literal.
export const floatText = (n) => `${numberText(n)}f`

// iOS Font.TextStyle names, by the words a token's name may use for them.
export const TEXT_STYLES = ['largeTitle', 'title', 'title2', 'title3', 'headline', 'subheadline', 'body', 'callout', 'footnote', 'caption', 'caption2']

// The text style a typography token scales with: tokens.mobile.textStyles by
// path (false or "fixed" opts out), else the last segment of its name when it
// names a style (`large-title`, `caption-2`), else null.
export function textStyleOf(path, textStyles = {}) {
  const key = path.join('.')
  if (Object.hasOwn(textStyles, key)) {
    const v = textStyles[key]
    if (v === false || v === 'fixed') return { style: null, fixed: true }
    if (typeof v === 'string' && TEXT_STYLES.includes(v)) return { style: v, fixed: false }
    return { style: null, fixed: false, why: `tokens.mobile.textStyles["${key}"] is "${v}", which is not an iOS text style (${TEXT_STYLES.join(', ')})` }
  }
  for (const segment of [...path].reverse()) {
    const flat = String(segment).toLowerCase().replace(/[^a-z0-9]/g, '')
    const hit = TEXT_STYLES.find((s) => s.toLowerCase() === flat)
    if (hit) return { style: hit, fixed: false }
  }
  return { style: null, fixed: false }
}

// ── Values through references, and colours as components ───────────────────

const isAliasText = (v) => typeof v === 'string' && /^\{[^{}]+\}$/.test(v.trim())

// A value with every reference inside it (a typography's font family, a
// shadow's colour) replaced by what it resolves to in `mode`.
export function deepResolve(model, value, mode, depth = 0) {
  if (depth > 32) throw new Error('a reference goes round in a cycle')
  if (isAliasText(value)) {
    const next = model.byName.get(value.trim().slice(1, -1).trim())
    if (!next) throw new Error(`reference ${value} points at a token that does not exist`)
    return deepResolve(model, model.resolved(next, mode), mode, depth + 1)
  }
  if (Array.isArray(value)) return value.map((v) => deepResolve(model, v, mode, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepResolve(model, v, mode, depth + 1)]))
  return value
}

const toLinear = (c) => (Math.abs(c) <= 0.04045 ? c / 12.92 : Math.sign(c) * ((Math.abs(c) + 0.055) / 1.055) ** 2.4)
const fromLinear = (c) => (Math.abs(c) <= 0.0031308 ? c * 12.92 : Math.sign(c) * (1.055 * Math.abs(c) ** (1 / 2.4) - 0.055))
const P3_TO_SRGB = [
  [1.2249401763, -0.2249401763, 0],
  [-0.0420569547, 1.0420569547, 0],
  [-0.0196375546, -0.0786360456, 1.0982736002],
]
const mul = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])
function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
}

// A colour value (a DTCG colour object, or CSS text in the old dialect) as
// { space: 'srgb' | 'display-p3', r, g, b, a }, keeping Display P3 as it is
// for the outputs that hold it. `parseColor` reads what this does not.
export function colorValue(v, parseColor) {
  if (v && typeof v === 'object' && Array.isArray(v.components)) {
    const [x, y, z] = v.components.map((n) => (n === 'none' ? 0 : n))
    const a = typeof v.alpha === 'number' ? v.alpha : 1
    if (v.colorSpace === 'srgb') return { space: 'srgb', r: x, g: y, b: z, a }
    if (v.colorSpace === 'display-p3') return { space: 'display-p3', r: x, g: y, b: z, a }
    if (v.colorSpace === 'srgb-linear') return { space: 'srgb', r: fromLinear(x), g: fromLinear(y), b: fromLinear(z), a, converted: 'linear sRGB' }
    if (v.colorSpace === 'oklab' || v.colorSpace === 'oklch') {
      const [L, A, B] = v.colorSpace === 'oklab' ? [x, y, z] : [x, y * Math.cos((z * Math.PI) / 180), y * Math.sin((z * Math.PI) / 180)]
      const [r, g, b] = oklabToLinear(L, A, B).map(fromLinear)
      return { space: 'srgb', r, g, b, a, converted: v.colorSpace }
    }
  }
  // Any other space (hsl, hwb, lab, lch…) through its hex, which never holds
  // the alpha: a DTCG colour keeps that apart, in `alpha`.
  const css = typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.hex === 'string' ? v.hex : null
  const c = css ? parseColor(css) : null
  if (!c) return null
  const a = v && typeof v === 'object' && typeof v.alpha === 'number' ? v.alpha : c.a ?? 1
  return { space: 'srgb', r: c.r, g: c.g, b: c.b, a, converted: typeof v === 'object' ? v.colorSpace : null }
}

// A colour in sRGB, for the outputs that hold nothing else, with whether its
// components had to be clipped into 0..1.
export function inSrgb(c) {
  let [r, g, b] = [c.r, c.g, c.b]
  if (c.space === 'display-p3') [r, g, b] = mul(P3_TO_SRGB, [r, g, b].map(toLinear)).map(fromLinear)
  const clipped = [r, g, b].some((n) => n < -0.0005 || n > 1.0005)
  const clamp = (n) => Math.min(1, Math.max(0, n))
  return { r: clamp(r), g: clamp(g), b: clamp(b), a: clamp(c.a), clipped }
}

// Whether a colour's components sit outside 0..1 in its own space.
export const outOfRange = (c) => [c.r, c.g, c.b].some((n) => n < -0.0005 || n > 1.0005)

// 0..1 as an 8-bit byte when it is one (within the precision a token keeps),
// else null. A component outside 0..1 is never a byte: clamping it would
// write another colour.
export function byteOf(n) {
  const v = n * 255
  const byte = Math.round(v)
  return byte >= 0 && byte <= 255 && Math.abs(v - byte) < 0.015 ? byte : null
}
