// A tolerant reader for Kotlin source, the counterpart of lang-swift.mjs:
// comments and string contents blanked with offsets kept, then plain
// patterns for colour literals. It counts only what reads as a literal.

import { lineAt, maskSource } from './lang-swift.mjs'

// Colour literals in Kotlin: Compose's Color(0xAARRGGBB) and Color(r, g, b)
// with numbers, android.graphics.Color's parseColor, rgb and argb, and the
// core-ktx "#RRGGBB".toColorInt().
const KOTLIN_COLOR = [
  /\bColor\s*\(\s*0x[0-9A-Fa-f]{6,8}(?:L|UL|u)?\s*\)/g,
  /\bColor\s*\(\s*(?:red\s*=\s*)?-?(?:\d+\.?\d*|\.\d+)f?\s*,/g,
  /\bColor\s*\.\s*(?:parseColor\s*\(\s*"#?[0-9A-Fa-f]{3,8}"|rgb\s*\(|argb\s*\(|valueOf\s*\(\s*-?\d)/g,
  /"#?[0-9A-Fa-f]{6,8}"\s*\.\s*toColorInt\s*\(/g,
]

// Every colour literal in a Kotlin file, as { line, text }.
export function kotlinColorLiterals(text) {
  const masked = maskSource(text, { raw: false })
  const line = lineAt(text)
  const found = []
  for (const re of KOTLIN_COLOR) {
    for (const m of masked.matchAll(re)) found.push({ offset: m.index, line: line(m.index), text: m[0].replace(/\s+/g, ' ') })
  }
  return found.sort((a, b) => a.offset - b.offset).map(({ line: l, text: t }) => ({ line: l, text: t }))
}
