// CSS colour parsing and maths for massimo: parse any colour a stylesheet is
// likely to hold into sRGB, measure distance in OKLab (so "nearly the same
// grey" is a number), and compute WCAG 2.x contrast.
//
// Wide-gamut input (oklch, display-p3, lab) is converted and clamped to sRGB;
// the audit and the contrast checks only need sRGB-accurate answers.

const clamp01 = (n) => Math.min(1, Math.max(0, n))

const NAMED = {
  black: '#000000',
  white: '#ffffff',
  transparent: '#00000000',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  pink: '#ffc0cb',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  navy: '#000080',
  teal: '#008080',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  lime: '#00ff00',
  maroon: '#800000',
  olive: '#808000',
  brown: '#a52a2a',
}

// sRGB transfer functions.
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const fromLinear = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

const rgbaFromLinear = (r, g, b, a = 1) => ({
  r: clamp01(fromLinear(clamp01(r))),
  g: clamp01(fromLinear(clamp01(g))),
  b: clamp01(fromLinear(clamp01(b))),
  a: clamp01(a),
})

function parseHex(hex) {
  const h = hex.slice(1)
  if (!/^[0-9a-f]+$/i.test(h)) return null
  let full
  if (h.length === 3 || h.length === 4) full = [...h].map((c) => c + c).join('')
  else if (h.length === 6 || h.length === 8) full = h
  else return null
  const n = (i) => parseInt(full.slice(i, i + 2), 16) / 255
  return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) : 1 }
}

function hueToDeg(token) {
  if (token === 'none') return 0
  const m = /^(-?[\d.]+(?:e-?\d+)?)(deg|rad|grad|turn)?$/i.exec(token)
  if (!m) return NaN
  const v = parseFloat(m[1])
  switch ((m[2] || 'deg').toLowerCase()) {
    case 'rad':
      return (v * 180) / Math.PI
    case 'grad':
      return v * 0.9
    case 'turn':
      return v * 360
    default:
      return v
  }
}

// A number token; a `%` token maps 100% to `pctScale`.
function num(token, pctScale = 1) {
  if (token === undefined) return NaN
  if (token === 'none') return 0
  if (token.endsWith('%')) return (parseFloat(token) / 100) * pctScale
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(token)) return NaN
  return parseFloat(token)
}

function alphaOf(token) {
  if (token === undefined) return 1
  const a = num(token, 1)
  return Number.isNaN(a) ? NaN : clamp01(a)
}

function hslToRgb(h, s, l) {
  const hh = ((h % 360) + 360) % 360
  const f = (n) => {
    const k = (n + hh / 30) % 12
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

function oklabToRgb(L, a, b, alpha) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  return rgbaFromLinear(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    alpha,
  )
}

function xyzD65ToRgb(x, y, z, alpha) {
  return rgbaFromLinear(
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
    alpha,
  )
}

// CIE Lab (D50) -> sRGB, Bradford-adapted to D65.
function labToRgb(L, a, b, alpha) {
  const fy = (L + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const eps = 216 / 24389
  const kappa = 24389 / 27
  const inv = (t) => (t ** 3 > eps ? t ** 3 : (116 * t - 16) / kappa)
  const x50 = inv(fx) * 0.3457 / 0.3585
  const y50 = L > kappa * eps ? ((L + 16) / 116) ** 3 : L / kappa
  const z50 = inv(fz) * (1 - 0.3457 - 0.3585) / 0.3585
  const x = 0.9555766 * x50 - 0.0230393 * y50 + 0.0631636 * z50
  const y = -0.0282895 * x50 + 1.0099416 * y50 + 0.0210077 * z50
  const z = 0.0122982 * x50 - 0.020483 * y50 + 1.3299098 * z50
  return xyzD65ToRgb(x, y, z, alpha)
}

function displayP3ToRgb(r, g, b, alpha, linearInput = false) {
  const lin = linearInput ? [r, g, b] : [toLinear(clamp01(r)), toLinear(clamp01(g)), toLinear(clamp01(b))]
  const [lr, lg, lb] = lin
  const x = 0.4865709486482162 * lr + 0.26566769316909306 * lg + 0.1982172852343625 * lb
  const y = 0.2289745640697488 * lr + 0.6917385218365064 * lg + 0.079286914093745 * lb
  const z = 0 * lr + 0.04511338185890264 * lg + 1.043944368900976 * lb
  return xyzD65ToRgb(x, y, z, alpha)
}

function parseFunctional(name, args) {
  if (/var\(|calc\(|\$\{|<alpha-value>/i.test(args)) return null
  const slash = args.indexOf('/')
  let main = slash === -1 ? args : args.slice(0, slash)
  const alphaTok = slash === -1 ? undefined : args.slice(slash + 1).trim()
  let parts = main.split(/[\s,]+/).filter(Boolean)
  let alphaToken = alphaTok
  // Legacy comma syntax: rgba(0, 0, 0, 0.5)
  if (slash === -1 && parts.length === 4 && name !== 'color') {
    alphaToken = parts[3]
    parts = parts.slice(0, 3)
  }
  const a = alphaOf(alphaToken)
  if (Number.isNaN(a)) return null

  if (name === 'rgb' || name === 'rgba') {
    if (parts.length !== 3) return null
    const c = parts.map((p) => (p.endsWith('%') ? num(p, 1) : num(p) / 255))
    if (c.some(Number.isNaN)) return null
    return { r: clamp01(c[0]), g: clamp01(c[1]), b: clamp01(c[2]), a }
  }
  if (name === 'hsl' || name === 'hsla') {
    if (parts.length !== 3) return null
    const h = hueToDeg(parts[0])
    const s = num(parts[1], 1)
    const l = num(parts[2], 1)
    if ([h, s, l].some(Number.isNaN)) return null
    const sat = parts[1].endsWith('%') || parts[1] === 'none' ? s : s / 100
    const lig = parts[2].endsWith('%') || parts[2] === 'none' ? l : l / 100
    const [r, g, b] = hslToRgb(h, clamp01(sat), clamp01(lig))
    return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a }
  }
  if (name === 'hwb') {
    if (parts.length !== 3) return null
    const h = hueToDeg(parts[0])
    let w = num(parts[1], 1)
    let bl = num(parts[2], 1)
    if ([h, w, bl].some(Number.isNaN)) return null
    if (!parts[1].endsWith('%')) w /= 100
    if (!parts[2].endsWith('%')) bl /= 100
    if (w + bl >= 1) {
      const g = w / (w + bl)
      return { r: g, g, b: g, a }
    }
    const [r, g, b] = hslToRgb(h, 1, 0.5).map((v) => v * (1 - w - bl) + w)
    return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a }
  }
  if (name === 'oklab' || name === 'oklch') {
    if (parts.length !== 3) return null
    const L = num(parts[0], 1)
    if (name === 'oklab') {
      const A = num(parts[1], 0.4)
      const B = num(parts[2], 0.4)
      if ([L, A, B].some(Number.isNaN)) return null
      return oklabToRgb(L, A, B, a)
    }
    const C = num(parts[1], 0.4)
    const H = hueToDeg(parts[2])
    if ([L, C, H].some(Number.isNaN)) return null
    const rad = (H * Math.PI) / 180
    return oklabToRgb(L, C * Math.cos(rad), C * Math.sin(rad), a)
  }
  if (name === 'lab' || name === 'lch') {
    if (parts.length !== 3) return null
    const L = num(parts[0], 100)
    if (name === 'lab') {
      const A = num(parts[1], 125)
      const B = num(parts[2], 125)
      if ([L, A, B].some(Number.isNaN)) return null
      return labToRgb(L, A, B, a)
    }
    const C = num(parts[1], 150)
    const H = hueToDeg(parts[2])
    if ([L, C, H].some(Number.isNaN)) return null
    const rad = (H * Math.PI) / 180
    return labToRgb(L, C * Math.cos(rad), C * Math.sin(rad), a)
  }
  if (name === 'color') {
    const space = parts[0]?.toLowerCase()
    const c = parts.slice(1).map((p) => num(p, 1))
    if (c.length !== 3 || c.some(Number.isNaN)) return null
    if (space === 'srgb') return { r: clamp01(c[0]), g: clamp01(c[1]), b: clamp01(c[2]), a }
    if (space === 'srgb-linear') return rgbaFromLinear(c[0], c[1], c[2], a)
    if (space === 'display-p3') return displayP3ToRgb(c[0], c[1], c[2], a)
    return null
  }
  return null
}

// Parse a CSS colour string to sRGB `{ r, g, b, a }` (each 0-1), or null when
// it is not a colour this module understands (var(), currentColor, calc()...).
export function parseColor(input) {
  if (typeof input !== 'string') return null
  const str = input.trim().toLowerCase()
  if (!str) return null
  if (str[0] === '#') return parseHex(str)
  if (NAMED[str]) return parseHex(NAMED[str])
  const m = /^(rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(\s*([\s\S]*?)\s*\)$/.exec(str)
  if (!m) return null
  return parseFunctional(m[1], m[2])
}

// OKLab { L, a, b } of an sRGB colour (alpha ignored).
export function toOklab({ r, g, b }) {
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

// Euclidean distance in OKLab; ~0.02 is a just-noticeable difference.
export function deltaE(c1, c2) {
  const a = toOklab(c1)
  const b = toOklab(c2)
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b)
}

export function relativeLuminance({ r, g, b }) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

const over = (fg, bg) => {
  const a = fg.a ?? 1
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  }
}

// WCAG 2.x contrast ratio (1-21). A translucent foreground is composited over
// the background; a translucent background is composited over white.
export function contrastRatio(fg, bg) {
  const solidBg = (bg.a ?? 1) < 1 ? over(bg, { r: 1, g: 1, b: 1 }) : bg
  const solidFg = over(fg, solidBg)
  const l1 = relativeLuminance(solidFg)
  const l2 = relativeLuminance(solidBg)
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

// Lowercase #rrggbb, or #rrggbbaa when translucent.
export function toHex({ r, g, b, a = 1 }) {
  const h = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}${a < 1 ? h(a) : ''}`
}
