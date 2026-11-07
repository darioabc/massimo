// Read a JavaScript object literal without running it: Tailwind configs,
// CSS-in-JS themes and token modules. Literal strings, numbers, booleans,
// arrays and nested objects come back as values; anything else (a call, a
// variable, a function, a spread) comes back as { expr: '<source>' } or
// { spread: '<source>' }, so a reader can say what it skipped instead of
// guessing. Zero dependencies, like the rest of massimo's scripts.

const PUNCT = new Set(['{', '}', '[', ']', '(', ')', ':', ',', '?', ';'])

function tokenize(src) {
  const tokens = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
    } else if (c === '/' && src[i + 1] === '*') {
      const k = src.indexOf('*/', i + 2)
      i = k === -1 ? n : k + 2
    } else if (c === '"' || c === "'" || c === '`') {
      const start = i
      let value = ''
      let interpolated = false
      i++
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') {
          const next = src[i + 1]
          value += { n: '\n', t: '\t', r: '\r' }[next] ?? next
          i += 2
          continue
        }
        if (c === '`' && src[i] === '$' && src[i + 1] === '{') interpolated = true
        value += src[i++]
      }
      i++
      tokens.push({ kind: interpolated ? 'expr' : 'string', value, start, end: i })
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1])) || (c === '-' && /[0-9.]/.test(src[i + 1]))) {
      const m = /^-?(?:0x[0-9a-f]+|\d*\.?\d+(?:e[-+]?\d+)?)/i.exec(src.slice(i))
      tokens.push({ kind: 'number', value: Number(m[0]), start: i, end: i + m[0].length })
      i += m[0].length
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))
      tokens.push({ kind: 'ident', value: m[0], start: i, end: i + m[0].length })
      i += m[0].length
    } else if (src.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...', start: i, end: i + 3 })
      i += 3
    } else if (src.startsWith('=>', i)) {
      tokens.push({ kind: 'arrow', value: '=>', start: i, end: i + 2 })
      i += 2
    } else {
      tokens.push({ kind: PUNCT.has(c) ? c : 'op', value: c, start: i, end: i + 1 })
      i++
    }
  }
  return tokens
}

// Parse the object literal whose `{` is at `offset` in `src`.
export function parseObjectAt(src, offset) {
  const tokens = tokenize(src.slice(offset))
  let p = 0
  const peek = () => tokens[p]
  const text = (from, to) => src.slice(offset + from, offset + to).trim()

  // Skip one expression up to a `,` or closing bracket at this depth.
  const skipExpr = () => {
    const start = peek()?.start ?? 0
    let depth = 0
    while (p < tokens.length) {
      const t = peek()
      if (depth === 0 && (t.kind === ',' || t.kind === '}' || t.kind === ']' || t.kind === ')')) break
      if (t.kind === '{' || t.kind === '[' || t.kind === '(') depth++
      if (t.kind === '}' || t.kind === ']' || t.kind === ')') depth--
      p++
    }
    return { expr: text(start, tokens[p - 1]?.end ?? start) }
  }

  const value = () => {
    const t = peek()
    if (!t) return undefined
    const start = p
    let v
    if (t.kind === '{') v = object()
    else if (t.kind === '[') v = array()
    else if (t.kind === 'string' || t.kind === 'number') {
      p++
      v = t.value
    } else if (t.kind === 'ident' && ['true', 'false', 'null'].includes(t.value)) {
      p++
      v = t.value === 'null' ? null : t.value === 'true'
    } else {
      return skipExpr()
    }
    // A literal followed by more expression (`'a' + b`, `x.y`) is an expression.
    const next = peek()
    if (next && !(next.kind === ',' || next.kind === '}' || next.kind === ']' || next.kind === ')')) {
      p = start
      return skipExpr()
    }
    return v
  }

  const object = () => {
    p++ // {
    const out = {}
    const spreads = []
    while (p < tokens.length && peek().kind !== '}') {
      const t = peek()
      if (t.kind === 'spread') {
        p++
        const s = skipExpr()
        spreads.push(s.expr)
      } else {
        let key
        if (t.kind === 'ident' || t.kind === 'string' || t.kind === 'number') {
          key = String(t.value)
          p++
        } else if (t.kind === '[') {
          const s = skipExpr()
          key = `[${s.expr}]`
        } else {
          p++
          continue
        }
        if (peek()?.kind === ':') {
          p++
          out[key] = value()
        } else if (peek()?.kind === '(') {
          skipExpr() // a method
          out[key] = { expr: `${key}()` }
        } else {
          out[key] = { expr: key } // shorthand { foo }
        }
      }
      if (peek()?.kind === ',') p++
    }
    p++ // }
    if (spreads.length > 0) Object.defineProperty(out, '__spreads', { value: spreads, enumerable: false })
    return out
  }

  const array = () => {
    p++ // [
    const out = []
    while (p < tokens.length && peek().kind !== ']') {
      if (peek().kind === 'spread') {
        p++
        out.push({ spread: skipExpr().expr })
      } else {
        out.push(value())
      }
      if (peek()?.kind === ',') p++
    }
    p++ // ]
    return out
  }

  if (peek()?.kind !== '{') return null
  return object()
}

// The first object literal after any of `patterns` (regexes ending just
// before the `{`), or null.
export function findObject(src, patterns) {
  for (const re of patterns) {
    const m = re.exec(src)
    if (!m) continue
    const brace = src.indexOf('{', m.index + m[0].length - 1)
    if (brace === -1) continue
    const between = src.slice(m.index + m[0].length, brace)
    if (/[^\s(]/.test(between)) continue
    const obj = parseObjectAt(src, brace)
    if (obj) return obj
  }
  return null
}

// Every leaf under an object, as [path, value]; skipped expressions included.
export function leaves(obj, path = []) {
  const out = []
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !('expr' in v) && !('spread' in v)) out.push(...leaves(v, [...path, k]))
    else out.push([[...path, k], v])
  }
  return out
}
