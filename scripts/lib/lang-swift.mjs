// A tolerant reader for Swift source, enough to count what the code
// hard-codes without a compiler: comments and string contents are blanked
// (offsets kept, so a match still knows its line), then plain patterns find
// colour literals. It is the first slice of the scanner the mobile audit will
// share with the component graph, so it errs on the side of reading less:
// anything it cannot see as a literal is not counted.

// Blank every comment and the contents of every string, keeping newlines and
// offsets. Line and block comments, block comments nested as Swift and Kotlin
// allow, "..." and """...""" strings, and Swift's raw #"..."# strings. A
// string that holds nothing but a hex colour keeps its text, so a call such
// as Color(hex: "#FF0000") is still seen.
export function maskSource(text, { raw = true } = {}) {
  const out = text.split('')
  const n = text.length
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '
  }
  const HEX_ONLY = /^#?(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/
  let i = 0
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? n : end
      blank(i, stop)
      i = stop
      continue
    }
    if (c === '/' && next === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++
          j += 2
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      blank(i, j)
      i = j
      continue
    }
    // Raw strings: #"..."#, ##"..."##, and their triple-quoted forms.
    if (raw && c === '#' && /^#+"/.test(text.slice(i, i + 8))) {
      const hashes = /^#+/.exec(text.slice(i))[0]
      const triple = text.startsWith('"""', i + hashes.length)
      const open = hashes.length + (triple ? 3 : 1)
      const close = `${triple ? '"""' : '"'}${hashes}`
      const end = text.indexOf(close, i + open)
      const stop = end === -1 ? n : end + close.length
      blank(i + open, end === -1 ? n : end)
      i = stop
      continue
    }
    if (c === '"') {
      const triple = text.startsWith('"""', i)
      const quote = triple ? '"""' : '"'
      let j = i + quote.length
      while (j < n) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text.startsWith(quote, j)) break
        if (!triple && text[j] === '\n') break
        j++
      }
      const inner = text.slice(i + quote.length, j)
      if (!HEX_ONLY.test(inner)) blank(i + quote.length, j)
      i = Math.min(n, j + (text.startsWith(quote, j) ? quote.length : 0))
      continue
    }
    i++
  }
  return out.join('')
}

// The 1-based line of each offset, by a sorted list of newline offsets.
export function lineAt(text) {
  const breaks = []
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') breaks.push(i)
  return (offset) => {
    let lo = 0
    let hi = breaks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (breaks[mid] < offset) lo = mid + 1
      else hi = mid
    }
    return lo + 1
  }
}

// Colour literals in Swift: SwiftUI, UIKit, AppKit and Core Graphics
// initialisers that take components, #colorLiteral, and the common
// hex-taking initialisers apps add themselves.
// A component must be a number, so Color(red: r, …) in a hex helper is not
// counted; a number in brackets or a conversion (CGFloat(18) / 255) is one.
const NUMBER = String.raw`\s*(?:\(\s*)*(?:(?:CGFloat|Double|Float)\s*\(\s*)?[-+]?(?:\d|\.\d)`
const SWIFT_COLOR = [
  new RegExp(String.raw`\b(?:Color|UIColor|NSColor)\s*\(\s*(?:\.\w+\s*,\s*)?(?:red|white|hue|displayP3Red)\s*:${NUMBER}`, 'g'),
  new RegExp(String.raw`\bCGColor\s*\(\s*(?:red|srgbRed|gray|genericGrayGamma2_2Gray)\s*:${NUMBER}`, 'g'),
  /#colorLiteral\s*\(/g,
  /\b(?:Color|UIColor|NSColor)\s*\(\s*(?:hex|hexString|rgb|rgba|argb)\s*:\s*(?:"#?[0-9A-Fa-f]{3,8}"|0x[0-9A-Fa-f]{6,8})/g,
]

// Every colour literal in a Swift file, as { line, text }.
export function swiftColorLiterals(text) {
  const masked = maskSource(text)
  const line = lineAt(text)
  const found = []
  for (const re of SWIFT_COLOR) {
    for (const m of masked.matchAll(re)) found.push({ offset: m.index, line: line(m.index), text: m[0].replace(/\s+/g, ' ') })
  }
  return found.sort((a, b) => a.offset - b.offset).map(({ line: l, text: t }) => ({ line: l, text: t }))
}
