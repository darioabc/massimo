// W3C Design Tokens 2025.10 for massimo. Reads token files (the format
// module) and resolver documents (the resolver module, where themes live),
// checks every value against the spec's types, reads the dialect massimo wrote
// before 0.2.0 and converts it, and writes 2025.10 back out.
//
// Spec: https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/
// and the resolver report published beside it. massimo writes curly-brace
// references only; it reads `$ref` (JSON Pointer), `$root` and `$extends` too.
//
// Everything massimo needs beyond the spec sits in `$extensions.massimo`: a
// CSS variable override (`cssVar`), a contrast pair (`contrast`), a Figma
// collection (`collection`), the exact CSS for a value the spec cannot hold
// (`css`), and, at a file's root, the format version (`format`) and values
// with no DTCG type at all (`cssOnly`).

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { DTCG_COLOR_SPACES, colorCss, colorFromCss } from './color.mjs'
import { stripJsonComments } from './project.mjs'
import { CSS_VAR_NAME, aliasPath, cssVarFor, flattenDtcg, isAlias } from './source.mjs'

// The format version massimo writes in `$extensions.massimo.format`. A file
// with a higher number was written by a newer massimo and is refused.
export const FORMAT_VERSION = 2
export const RESOLVER_VERSION = '2025.10'

export const TYPES = [
  'color', 'dimension', 'fontFamily', 'fontWeight', 'duration', 'cubicBezier', 'number',
  'strokeStyle', 'border', 'transition', 'shadow', 'gradient', 'typography',
]

export const FONT_WEIGHT_KEYWORDS = {
  thin: 100, hairline: 100, 'extra-light': 200, 'ultra-light': 200, light: 300, normal: 400, regular: 400, book: 400,
  medium: 500, 'semi-bold': 600, 'demi-bold': 600, bold: 700, 'extra-bold': 800, 'ultra-bold': 800, black: 900,
  heavy: 900, 'extra-black': 950, 'ultra-black': 950,
}

const STROKE_STYLES = ['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'outset', 'inset']

// WCAG 2.2 contrast minimums by what the colour is used for: text (1.4.3),
// large text (1.4.3), and non-text UI and focus indicators (1.4.11).
export const CONTRAST_USES = { text: 4.5, 'large-text': 3, ui: 3, focus: 3 }

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNum = (n) => typeof n === 'number' && Number.isFinite(n)
const clone = (v) => JSON.parse(JSON.stringify(v))

// ── Checking values against the spec ──────────────────────────────────────

const onlyKeys = (v, keys, what) => {
  const extra = Object.keys(v).filter((k) => !keys.includes(k))
  return extra.length > 0 ? `${what} cannot have ${extra.join(', ')}` : null
}

// Why a value is not a valid DTCG value of `type`, or null. A reference may
// stand anywhere a sub-value goes; its type is checked once the set resolves.
export function checkValue(type, v) {
  if (isAlias(v)) return null
  const sub = (t, x, where) => {
    if (x === undefined) return `is missing ${where}`
    const why = checkValue(t, x)
    return why ? `${where} ${why}` : null
  }
  const first = (...checks) => checks.find(Boolean) ?? null
  switch (type) {
    case 'color': {
      if (!isObject(v)) return 'must be a colour object, { "colorSpace": "srgb", "components": [r, g, b] }'
      if (!DTCG_COLOR_SPACES.includes(v.colorSpace)) return `has colorSpace ${JSON.stringify(v.colorSpace)}, which is not one of ${DTCG_COLOR_SPACES.join(', ')}`
      if (!Array.isArray(v.components) || v.components.length !== 3 || !v.components.every((c) => c === 'none' || isNum(c))) {
        return 'must have three components, each a number or "none"'
      }
      if (v.alpha !== undefined && !(isNum(v.alpha) && v.alpha >= 0 && v.alpha <= 1)) return 'has an alpha outside 0 to 1'
      if (v.hex !== undefined && !/^#[0-9a-fA-F]{6}$/.test(v.hex)) return 'has a hex fallback that is not six-digit #rrggbb'
      return onlyKeys(v, ['colorSpace', 'components', 'alpha', 'hex'], 'a colour')
    }
    case 'dimension':
    case 'duration': {
      const units = type === 'dimension' ? ['px', 'rem'] : ['ms', 's']
      if (!isObject(v) || !isNum(v.value)) return `must be { "value": <number>, "unit": "${units.join('" or "')}" }`
      if (!units.includes(v.unit)) return `has unit ${JSON.stringify(v.unit)}; a ${type} takes ${units.join(' or ')}`
      return onlyKeys(v, ['value', 'unit'], `a ${type}`)
    }
    case 'fontFamily':
      if (typeof v === 'string' && v.trim()) return null
      if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim())) return null
      return 'must be a font name or a list of font names'
    case 'fontWeight':
      if (isNum(v)) return v >= 1 && v <= 1000 ? null : 'must be from 1 to 1000'
      return typeof v === 'string' && v in FONT_WEIGHT_KEYWORDS ? null : `must be a number from 1 to 1000 or one of ${Object.keys(FONT_WEIGHT_KEYWORDS).join(', ')}`
    case 'cubicBezier':
      if (!Array.isArray(v) || v.length !== 4 || !v.every(isNum)) return 'must be four numbers, [x1, y1, x2, y2]'
      return v[0] < 0 || v[0] > 1 || v[2] < 0 || v[2] > 1 ? 'must keep x1 and x2 between 0 and 1' : null
    case 'number':
      return isNum(v) ? null : 'must be a number'
    case 'strokeStyle':
      if (typeof v === 'string') return STROKE_STYLES.includes(v) ? null : `must be one of ${STROKE_STYLES.join(', ')}`
      if (!isObject(v) || !Array.isArray(v.dashArray)) return 'must be a style keyword or { "dashArray": [...], "lineCap": ... }'
      return first(
        v.dashArray.map((d, i) => sub('dimension', d, `dashArray[${i}]`)).find(Boolean),
        ['round', 'butt', 'square'].includes(v.lineCap) ? null : 'has a lineCap that is not round, butt or square',
        onlyKeys(v, ['dashArray', 'lineCap'], 'a stroke style'),
      )
    case 'border':
      if (!isObject(v)) return 'must be { "color", "width", "style" }'
      return first(sub('color', v.color, 'color'), sub('dimension', v.width, 'width'), sub('strokeStyle', v.style, 'style'), onlyKeys(v, ['color', 'width', 'style'], 'a border'))
    case 'transition':
      if (!isObject(v)) return 'must be { "duration", "delay", "timingFunction" }'
      return first(
        sub('duration', v.duration, 'duration'),
        sub('duration', v.delay, 'delay'),
        sub('cubicBezier', v.timingFunction, 'timingFunction'),
        onlyKeys(v, ['duration', 'delay', 'timingFunction'], 'a transition'),
      )
    case 'shadow': {
      const one = (s, where) => {
        if (isAlias(s)) return null
        if (!isObject(s)) return `${where} must be a shadow object`
        if (s.inset !== undefined && typeof s.inset !== 'boolean') return `${where} has an inset that is not true or false`
        return first(
          sub('color', s.color, `${where}color`),
          ...['offsetX', 'offsetY', 'blur', 'spread'].map((k) => sub('dimension', s[k], `${where}${k}`)),
          onlyKeys(s, ['color', 'offsetX', 'offsetY', 'blur', 'spread', 'inset'], 'a shadow'),
        )
      }
      return Array.isArray(v) ? (v.length === 0 ? 'must have at least one shadow' : v.map((s, i) => one(s, `[${i}] `)).find(Boolean) ?? null) : one(v, '')
    }
    case 'gradient':
      if (!Array.isArray(v) || v.length === 0) return 'must be a list of stops, each { "color", "position" }'
      return v
        .map((s, i) => {
          if (isAlias(s)) return null
          if (!isObject(s)) return `[${i}] must be a stop`
          return first(sub('color', s.color, `[${i}] color`), sub('number', s.position, `[${i}] position`), onlyKeys(s, ['color', 'position'], 'a gradient stop'))
        })
        .find(Boolean) ?? null
    case 'typography':
      if (!isObject(v)) return 'must be { "fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight" }'
      return first(
        sub('fontFamily', v.fontFamily, 'fontFamily'),
        sub('dimension', v.fontSize, 'fontSize'),
        sub('fontWeight', v.fontWeight, 'fontWeight'),
        sub('dimension', v.letterSpacing, 'letterSpacing'),
        sub('number', v.lineHeight, 'lineHeight'),
        onlyKeys(v, ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight'], 'typography'),
      )
    default:
      return `has $type ${JSON.stringify(type)}, which is not a DTCG type (${TYPES.join(', ')})`
  }
}

// ── References: curly braces, JSON Pointer, $root and $extends ──────────────

// RFC 6901: "#/a/b~1c" -> ['a', 'b/c'].
export function pointerPath(pointer) {
  const hash = pointer.indexOf('#')
  const frag = hash === -1 ? '' : pointer.slice(hash + 1)
  if (frag === '' || frag === '/') return []
  return frag.replace(/^\//, '').split('/').map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'))
}

const at = (doc, path) => path.reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), doc)
const isToken = (node) => isObject(node) && ('$value' in node || ('$ref' in node && !Object.keys(node).some((k) => !k.startsWith('$'))))

// Turn `$extends` groups into plain groups and `$ref` pointers into curly
// references (or, for a pointer into part of a value, the part itself), so
// the rest of the reader sees one simple shape. Problems name the path.
export function expandDocument(input, problems = [], where = '') {
  const doc = clone(input)
  const report = (path, message, level = 'error') => problems.push({ level, path: [where, path.join('.')].filter(Boolean).join(': ') || '(root)', message })

  const refTarget = (ref) => {
    if (typeof ref === 'string' && isAlias(ref)) return aliasPath(ref).split('.')
    if (typeof ref === 'string' && ref.startsWith('#')) return pointerPath(ref)
    if (isObject(ref) && typeof ref.$ref === 'string' && ref.$ref.startsWith('#')) return pointerPath(ref.$ref)
    return null
  }

  // $extends: the target group's content, with this group's own items on top.
  const merging = []
  const expandGroup = (node, path) => {
    if (!isObject(node) || isToken(node)) return node
    if (node.$extends !== undefined) {
      const target = refTarget(node.$extends)
      const key = path.join('.')
      if (!target) {
        report(path, `$extends ${JSON.stringify(node.$extends)} is not a reference to a group`)
      } else if (merging.includes(key)) {
        report(path, `$extends goes round in a cycle: ${[...merging, key].join(' -> ')}`)
      } else {
        const base = at(doc, target)
        if (!isObject(base) || isToken(base)) {
          report(path, `$extends points at ${target.join('.')}, which is not a group`)
        } else {
          merging.push(key)
          const expanded = expandGroup(clone(base), target)
          merging.pop()
          const { $extends, ...own } = node
          node = mergeTree(expanded, own)
        }
      }
      delete node.$extends
    }
    for (const [k, child] of Object.entries(node)) if (!k.startsWith('$')) node[k] = expandGroup(child, [...path, k])
    return node
  }
  const expanded = expandGroup(doc, [])

  // $ref: to a token (or its $value) becomes "{a.b}"; into a value, the value itself.
  const fromPointer = (ref, path) => {
    const target = pointerPath(ref)
    const valueAt = target.indexOf('$value')
    const tokenPath = valueAt === -1 ? target : target.slice(0, valueAt)
    const token = at(expanded, tokenPath)
    if (!isToken(token)) {
      report(path, `$ref ${ref} does not point at a token`)
      return undefined
    }
    if (valueAt === -1 || valueAt === target.length - 1) return `{${tokenPath.join('.')}}`
    const part = at(expanded, target)
    if (part === undefined) report(path, `$ref ${ref} points at nothing`)
    else report(path, `$ref ${ref} points into part of a value; massimo copies that part in, so it no longer follows the source`, 'warning')
    return clone(part)
  }
  const refs = (v, path) => {
    if (isObject(v) && typeof v.$ref === 'string' && Object.keys(v).length === 1) {
      return v.$ref.startsWith('#') ? fromPointer(v.$ref, path) : (report(path, `$ref ${v.$ref} points outside this file`), undefined)
    }
    if (Array.isArray(v)) return v.map((x) => refs(x, path))
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, refs(x, path)]))
    return v
  }
  const walk = (node, path) => {
    if (!isObject(node)) return
    if (isToken(node)) {
      if (!('$value' in node) && typeof node.$ref === 'string') {
        node.$value = fromPointer(node.$ref, path)
        delete node.$ref
      }
      node.$value = refs(node.$value, path)
      return
    }
    for (const [k, child] of Object.entries(node)) if (!k.startsWith('$') || k === '$root') walk(child, [...path, k])
  }
  walk(expanded, [])
  return expanded
}

// Groups merge key by key; a token replaces a token, property by property, so
// an override that gives only `$value` keeps the rest of the token.
export function mergeTree(base, over) {
  if (!isObject(base) || !isObject(over)) return clone(over)
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (isObject(v) && isObject(base[k]) && isToken(v) === isToken(base[k])) out[k] = isToken(v) ? { ...base[k], ...clone(v) } : mergeTree(base[k], v)
    else out[k] = clone(v)
  }
  return out
}

// ── Reading a 2025.10 token file ───────────────────────────────────────────

const massimoOf = (node) => (isObject(node?.$extensions?.massimo) ? node.$extensions.massimo : {})

// The contrast pair a token declares: { on, use, ratio } with the ratio WCAG
// 2.2 asks for that use, or null. The old dialect's `on` + `contrast` number
// reads the same way.
function contrastOf(ext, report) {
  const c = ext.contrast
  if (isObject(c)) {
    if (typeof c.on !== 'string') report('$extensions.massimo.contrast needs "on", the token this colour sits on')
    if (c.use !== undefined && !(c.use in CONTRAST_USES)) report(`$extensions.massimo.contrast.use must be one of ${Object.keys(CONTRAST_USES).join(', ')}`)
    if (c.ratio !== undefined && !isNum(c.ratio)) report('$extensions.massimo.contrast.ratio must be a number, such as 4.5')
    const use = c.use ?? 'text'
    return typeof c.on === 'string' ? { on: c.on, use, ratio: isNum(c.ratio) ? c.ratio : CONTRAST_USES[use] ?? 4.5 } : null
  }
  if (typeof ext.on === 'string') {
    if (c !== undefined && !isNum(c)) report('$extensions.massimo.contrast must be a number, such as 4.5')
    return { on: ext.on, use: null, ratio: isNum(c) ? c : 4.5 }
  }
  return null
}

const FOREIGN = (extensions) => {
  if (!isObject(extensions)) return {}
  const { massimo, ...rest } = extensions
  return rest
}

// Flatten a 2025.10 token tree (already expanded) into massimo's token list.
// `$type` comes from the token, else from what a reference points at, else
// from the nearest group; tools must not guess it, so none is guessed here.
export function flattenFormat(doc, problems = [], where = '') {
  const out = []
  const report = (path, message, level = 'error') => problems.push({ level, path: [where, path.join('.')].filter(Boolean).join(': ') || '(root)', message })
  const visit = (node, path, groupType, deprecated) => {
    if (!isObject(node)) return
    if ('$value' in node) {
      const children = Object.keys(node).filter((k) => !k.startsWith('$'))
      if (children.length > 0) report(path, `has a $value and child tokens (${children.join(', ')}); a token cannot also be a group`)
      const ext = massimoOf(node)
      const named = path.filter((p) => p !== '$root')
      let cssVar = cssVarFor(named)
      if (ext.cssVar !== undefined) {
        if (typeof ext.cssVar === 'string' && CSS_VAR_NAME.test(ext.cssVar)) cssVar = ext.cssVar
        else report(path, `$extensions.massimo.cssVar ${JSON.stringify(ext.cssVar)} is not a CSS custom property name (--letters-digits-dashes)`)
      }
      if (node.$type !== undefined && typeof node.$type !== 'string') report(path, '$type must be a string')
      if (ext.css !== undefined && typeof ext.css !== 'string') report(path, '$extensions.massimo.css must be a string of CSS')
      const contrast = contrastOf(ext, (m) => report(path, m))
      const ownDeprecated = node.$deprecated ?? deprecated
      out.push({
        path,
        name: path.join('.'),
        type: typeof node.$type === 'string' ? node.$type : null,
        groupType: groupType ?? null,
        value: node.$value,
        description: typeof node.$description === 'string' ? node.$description : '',
        deprecated: ownDeprecated === undefined || ownDeprecated === false ? null : ownDeprecated,
        modes: {},
        css: typeof ext.css === 'string' ? ext.css : null,
        cssModes: {},
        cssVar,
        on: contrast?.on ?? null,
        contrast: contrast?.ratio ?? 4.5,
        use: contrast?.use ?? null,
        collection: typeof ext.collection === 'string' ? ext.collection : null,
        extensions: FOREIGN(node.$extensions),
        strict: true,
      })
      return
    }
    const type = typeof node.$type === 'string' ? node.$type : groupType
    const groupDeprecated = node.$deprecated ?? deprecated
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$') && key !== '$root') continue
      if (key !== '$root' && /[{}.]/.test(key)) {
        report([...path, key], 'a token or group name cannot contain {, } or .')
        continue
      }
      if (key === '$root' && !isToken(child)) {
        report([...path, key], '$root must be a token')
        continue
      }
      visit(child, [...path, key], type, groupDeprecated)
    }
  }
  visit(doc, [], undefined, undefined)
  return out
}

// Values with no DTCG type, kept at a file's root in `$extensions.massimo.cssOnly`:
// they reach the CSS outputs as written and nothing else.
export function cssOnlyTokens(doc, problems = [], where = '') {
  const list = massimoOf(doc).cssOnly
  if (list === undefined) return []
  if (!isObject(list)) {
    problems.push({ level: 'error', path: where || '(root)', message: '$extensions.massimo.cssOnly must be an object of token name to { css }' })
    return []
  }
  return Object.entries(list).map(([name, entry]) => ({
    path: name.split('.'),
    name,
    type: 'css',
    groupType: null,
    value: entry?.css,
    description: typeof entry?.description === 'string' ? entry.description : '',
    deprecated: null,
    modes: isObject(entry?.modes) ? { ...entry.modes } : {},
    css: null,
    cssModes: {},
    cssVar: typeof entry?.cssVar === 'string' && CSS_VAR_NAME.test(entry.cssVar) ? entry.cssVar : cssVarFor(name.split('.')),
    on: null,
    contrast: 4.5,
    use: null,
    collection: null,
    extensions: {},
    strict: false,
    cssOnly: true,
    after: typeof entry?.after === 'string' ? entry.after : null,
  }))
}

// Typed tokens with the CSS-only ones put back where they stood: after the
// token named in their `after`, or at the end.
export function inOrder(typed, cssOnly) {
  const out = [...typed]
  for (const c of cssOnly) {
    const i = c.after ? out.findIndex((t) => t.name === c.after) : -1
    if (i === -1) out.push(c)
    else out.splice(i + 1, 0, c)
  }
  return out
}

// The format version a file declares in `$extensions.massimo.format`, or null.
export const formatOf = (doc) => (isNum(massimoOf(doc).format) ? massimoOf(doc).format : null)

export const isResolver = (doc) => isObject(doc) && Array.isArray(doc.resolutionOrder)

// Whether a token file is the dialect massimo wrote before 0.2.0: no format
// version, and a sign only that dialect has (modes in its extensions, a colour
// or size written as CSS text, a bare number for a size). A plain 2025.10 file
// from another tool has none of these.
export function looksLegacy(doc) {
  if (formatOf(doc) !== null) return false
  let legacy = false
  const visit = (node, type) => {
    if (legacy || !isObject(node)) return
    const t = typeof node.$type === 'string' ? node.$type : type
    if ('$value' in node) {
      const v = node.$value
      if (isObject(massimoOf(node).modes)) legacy = true
      else if (typeof v === 'string' && !isAlias(v) && ['color', 'dimension', 'duration', 'cubicBezier', 'number', 'shadow'].includes(t)) legacy = true
      else if (isNum(v) && ['dimension', 'duration'].includes(t)) legacy = true
      else if (t === undefined && !isAlias(v)) legacy = true
      return
    }
    for (const [k, c] of Object.entries(node)) if (!k.startsWith('$')) visit(c, t)
  }
  visit(doc, undefined)
  return legacy
}

// ── Reading a resolver document ────────────────────────────────────────────

const readJsonFile = (path) => JSON.parse(stripJsonComments(readFileSync(path, 'utf8')))

const inside = (parent, child) => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel))
}

// A resolver document and everything it points at, as massimo's token list:
// each token's default value from the sets and every modifier's default
// context, and its value in each other context as a mode. `root` bounds which
// files a `$ref` may load.
export function readResolver(path, { root, problems = [] } = {}) {
  const where = relative(root ?? dirname(path), path).split(sep).join('/')
  const report = (message, level = 'error') => problems.push({ level, path: where, message })
  const doc = readJsonFile(path)
  const files = [where]
  if (doc.version !== RESOLVER_VERSION) {
    const newer = typeof doc.version === 'string' && doc.version > RESOLVER_VERSION
    report(newer ? `is resolver version ${doc.version}, newer than the ${RESOLVER_VERSION} this massimo reads; update massimo` : `needs "version": "${RESOLVER_VERSION}"`)
    return { tokens: [], files, defaultMode: null, contexts: [] }
  }
  const base = dirname(path)
  const fileCache = new Map()
  const loadSource = (source, label) => {
    if (isObject(source) && typeof source.$ref === 'string') {
      const ref = source.$ref
      if (ref.startsWith('#')) {
        const target = at(doc, pointerPath(ref))
        if (target === undefined) report(`${label}: $ref ${ref} points at nothing`)
        // A set referenced from a context brings its own sources.
        if (isObject(target) && Array.isArray(target.sources)) return target.sources.map((s, i) => loadSource(s, `${ref} source ${i}`)).reduce(mergeTree, {})
        return isObject(target) ? clone(target) : {}
      }
      const hash = ref.indexOf('#')
      const file = resolve(base, hash === -1 ? ref : ref.slice(0, hash))
      const bound = root ?? base
      if (!inside(realpathSync(bound), existsSync(file) ? realpathSync(file) : file)) {
        report(`${label}: $ref ${ref} points outside the repo`)
        return {}
      }
      if (!existsSync(file)) {
        report(`${label}: $ref ${ref} names a file that does not exist`)
        return {}
      }
      if (!fileCache.has(file)) {
        let json
        try {
          json = readJsonFile(file)
        } catch (err) {
          report(`${label}: ${ref} is not valid JSON: ${err.message}`)
          json = {}
        }
        const fileWhere = relative(root ?? base, file).split(sep).join('/')
        files.push(fileWhere)
        const format = formatOf(json)
        if (format !== null && format > FORMAT_VERSION) {
          problems.push({ level: 'error', path: fileWhere, message: `was written by a newer massimo (format ${format}; this one reads ${FORMAT_VERSION}); update massimo` })
        }
        fileCache.set(file, { json, where: fileWhere })
      }
      const { json } = fileCache.get(file)
      const part = hash === -1 ? json : at(json, pointerPath(ref.slice(hash)))
      return isObject(part) ? clone(part) : {}
    }
    if (isObject(source)) return clone(source)
    report(`${label}: a source must be a token tree or { "$ref": … }`)
    return {}
  }

  const sets = isObject(doc.sets) ? doc.sets : {}
  const modifiers = isObject(doc.modifiers) ? doc.modifiers : {}
  if (!Array.isArray(doc.resolutionOrder) || doc.resolutionOrder.length === 0) {
    report('needs a resolutionOrder listing its sets and modifiers')
    return { tokens: [], files, defaultMode: null, contexts: [] }
  }
  const order = doc.resolutionOrder.map((item, i) => {
    if (isObject(item) && typeof item.$ref === 'string') {
      const [kind, name] = pointerPath(item.$ref)
      if (kind === 'sets' && sets[name]) return { kind: 'set', name, sources: sets[name].sources ?? [] }
      if (kind === 'modifiers' && modifiers[name]) return { kind: 'modifier', name, ...modifiers[name] }
      report(`resolutionOrder[${i}]: ${item.$ref} is not a set or modifier in this document`)
      return null
    }
    if (isObject(item) && item.type === 'set') return { kind: 'set', name: item.name ?? `inline-${i}`, sources: item.sources ?? [] }
    if (isObject(item) && item.type === 'modifier') return { kind: 'modifier', ...item }
    report(`resolutionOrder[${i}] must be { "$ref": "#/sets/…" } or an inline set or modifier`)
    return null
  }).filter(Boolean)

  const contexts = []
  for (const m of order.filter((o) => o.kind === 'modifier')) {
    const names = isObject(m.contexts) ? Object.keys(m.contexts) : []
    if (names.length === 0) report(`modifier ${m.name} needs at least one context`)
    const fallback = m.default ?? names[0]
    if (m.default !== undefined && !names.includes(m.default)) report(`modifier ${m.name} has default "${m.default}", which is not one of its contexts`)
    for (const c of names) {
      if (contexts.some((x) => x.name === c && x.modifier !== m.name)) report(`context "${c}" is in two modifiers; massimo needs each context name once`)
      contexts.push({ modifier: m.name, name: c, isDefault: c === fallback })
    }
    m.fallback = fallback
  }

  // The token tree for one choice of contexts (every other modifier at its default).
  const treeFor = (choice) => {
    let tree = {}
    for (const item of order) {
      const sources = item.kind === 'set' ? item.sources : (item.contexts?.[choice[item.name] ?? item.fallback] ?? [])
      sources.forEach((s, i) => {
        tree = mergeTree(tree, loadSource(s, `${item.kind} ${item.name} source ${i}`))
      })
    }
    return tree
  }

  const baseTree = treeFor({})
  const tokens = inOrder(flattenFormat(expandDocument(baseTree, problems, where), problems, where), cssOnlyTokens(baseTree, problems, where))
  const byName = new Map(tokens.map((t) => [t.name, t]))
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  for (const ctx of contexts.filter((c) => !c.isDefault)) {
    const scratch = []
    const tree = treeFor({ [ctx.modifier]: ctx.name })
    const list = [...flattenFormat(expandDocument(tree, scratch, where), scratch, where), ...cssOnlyTokens(tree, scratch, where)]
    for (const p of scratch) if (!problems.some((q) => q.path === p.path && q.message === p.message)) problems.push(p)
    for (const t of list) {
      const b = byName.get(t.name)
      if (!b) {
        report(`${t.name} is defined only in the ${ctx.name} context; give it a default value in a set`)
        continue
      }
      if (!same(b.value, t.value)) b.modes[ctx.name] = t.value
      if (t.css !== b.css && t.css !== null) b.cssModes[ctx.name] = t.css
    }
  }
  const first = contexts.find((c) => c.isDefault)
  return { tokens, files, defaultMode: first?.name ?? null, contexts, cssOnly: [] }
}

// ── Any token source ───────────────────────────────────────────────────────

// The token set at `config.tokens.source` in whichever dialect it is: a
// resolver document, one 2025.10 file, or the tokens.json massimo wrote before
// 0.2.0. Returns null when there is no file; problems go into `problems`.
export function readTokenSource(root, config, problems = []) {
  const source = config.tokens.source
  const path = join(root, source)
  if (!existsSync(path)) return null
  let doc
  try {
    doc = readJsonFile(path)
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err.message}`)
  }
  if (isResolver(doc)) {
    const r = readResolver(path, { root, problems })
    const modeOrder = r.contexts.filter((c) => !c.isDefault).map((c) => c.name)
    return { tokens: r.tokens, problems, format: '2025.10', files: r.files, defaultMode: r.defaultMode, modeOrder }
  }
  const format = formatOf(doc)
  if (format !== null && format > FORMAT_VERSION) {
    throw new Error(`${source} was written by a newer massimo (format ${format}; this one reads ${FORMAT_VERSION}). Update massimo.`)
  }
  if (format !== null || !looksLegacy(doc)) {
    const tokens = inOrder(flattenFormat(expandDocument(doc, problems), problems), cssOnlyTokens(doc, problems))
    return { tokens, problems, format: '2025.10', files: [source] }
  }
  return { tokens: flattenDtcg(doc, problems), problems, format: 'legacy', files: [source] }
}

// ── The dialect before 0.2.0 ───────────────────────────────────────────────

const LENGTH = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem)$/
const EASINGS = { linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1] }

// Split CSS on top-level commas or spaces, leaving brackets and quotes whole.
export function splitCss(text, by = ',') {
  const out = []
  let depth = 0
  let quote = null
  let cur = ''
  for (const c of text) {
    if (quote) {
      cur += c
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    if (depth === 0 && (by === ',' ? c === ',' : /\s/.test(c))) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else {
      cur += c
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2')

// CSS text (or an old-dialect value) as a DTCG value of `type`. Returns
// { value } when it converts exactly, { value, css } when the value is the
// nearest DTCG form and only CSS keeps the exact one, or { error }.
export function fromCss(type, v) {
  if (isAlias(v)) return { value: v.trim() }
  const exact = (value) => ({ value })
  if (type === 'number') {
    if (isNum(v)) return exact(v)
    return typeof v === 'string' && /^-?(\d+\.?\d*|\.\d+)$/.test(v.trim()) ? exact(Number(v)) : { error: 'is not a number' }
  }
  if (type === 'dimension') {
    if (isNum(v)) return exact({ value: v, unit: 'px' })
    if (isObject(v)) return checkValue('dimension', v) ? { error: `is not a dimension: ${JSON.stringify(v)}` } : exact(v)
    const s = String(v).trim()
    if (s === '0') return exact({ value: 0, unit: 'px' })
    const m = LENGTH.exec(s)
    if (m) return exact({ value: Number(m[1]), unit: m[2] })
    const em = /^(-?(?:\d+\.?\d*|\.\d+))em$/.exec(s)
    if (em) return { value: { value: Number(em[1]) * 16, unit: 'px' }, css: s, note: `${s} is relative to the text it sits in, so CSS keeps it; outside CSS it is ${Number(em[1]) * 16}px at a 16px base` }
    return { error: `${JSON.stringify(s)} is not px or rem, so it has no DTCG dimension` }
  }
  if (type === 'duration') {
    if (isObject(v)) return checkValue('duration', v) ? { error: 'is not a duration' } : exact(v)
    const m = /^(-?(?:\d+\.?\d*|\.\d+))(ms|s)$/.exec(String(v).trim())
    return m ? exact({ value: Number(m[1]), unit: m[2] }) : { error: `${JSON.stringify(v)} is not a duration in ms or s` }
  }
  if (type === 'color') {
    if (isObject(v)) return checkValue('color', v) ? { error: 'is not a colour object' } : exact(v)
    const c = colorFromCss(String(v))
    if (!c) return { error: `${JSON.stringify(v)} is not a colour massimo can read` }
    // A colour written as CSS comes back as CSS in the same space, so this is exact.
    return exact(c)
  }
  if (type === 'fontFamily') {
    if (Array.isArray(v)) return exact(v.map((x) => unquote(String(x).trim())))
    const names = splitCss(String(v)).map(unquote)
    return names.length === 0 ? { error: 'is empty' } : exact(names.length === 1 ? names[0] : names)
  }
  if (type === 'fontWeight') {
    if (isNum(v)) return exact(v)
    const s = String(v).trim()
    if (/^\d+$/.test(s)) return exact(Number(s))
    return s in FONT_WEIGHT_KEYWORDS ? exact(s) : { error: `${JSON.stringify(s)} is not a font weight` }
  }
  if (type === 'cubicBezier') {
    if (Array.isArray(v)) return exact(v)
    const s = String(v).trim()
    if (EASINGS[s]) return exact(EASINGS[s])
    const m = /^cubic-bezier\(([^)]*)\)$/.exec(s)
    const nums = m ? m[1].split(',').map(Number) : []
    return nums.length === 4 && nums.every(Number.isFinite) ? exact(nums) : { error: `${JSON.stringify(s)} is not a cubic-bezier()` }
  }
  if (type === 'strokeStyle') return typeof v === 'string' && STROKE_STYLES.includes(v.trim()) ? exact(v.trim()) : isObject(v) ? exact(v) : { error: 'is not a stroke style' }
  if (type === 'shadow') {
    if (isObject(v) || Array.isArray(v)) return convertParts(type, v)
    const list = splitCss(String(v)).map(shadowFromCss)
    if (list.some((s) => !s)) return { error: `${JSON.stringify(v)} is not a box-shadow massimo can read` }
    return exact(list.length === 1 ? list[0] : list)
  }
  if (['border', 'transition', 'gradient', 'typography'].includes(type)) return isObject(v) || Array.isArray(v) ? convertParts(type, v) : { error: `is CSS text, not a ${type} object` }
  return { error: `has no DTCG type` }
}

// An old-dialect composite whose parts are CSS strings, part by part.
function convertParts(type, v) {
  const PARTS = {
    shadow: { color: 'color', offsetX: 'dimension', offsetY: 'dimension', blur: 'dimension', spread: 'dimension' },
    border: { color: 'color', width: 'dimension', style: 'strokeStyle' },
    transition: { duration: 'duration', delay: 'duration', timingFunction: 'cubicBezier' },
    typography: { fontFamily: 'fontFamily', fontSize: 'dimension', fontWeight: 'fontWeight', letterSpacing: 'dimension', lineHeight: 'number' },
  }
  const notes = []
  const one = (obj) => {
    if (isAlias(obj)) return obj
    const out = {}
    for (const [k, x] of Object.entries(obj)) {
      const partType = type === 'gradient' ? (k === 'color' ? 'color' : 'number') : PARTS[type]?.[k]
      if (!partType) {
        if (k === 'inset' && type === 'shadow') out[k] = Boolean(x)
        else return { error: `has a part "${k}" that a ${type} does not have` }
        continue
      }
      // A line height in px or rem is a multiple of the font size in DTCG.
      if (type === 'typography' && k === 'lineHeight' && typeof x === 'string' && LENGTH.test(x.trim()) && obj.fontSize) {
        const lh = fromCss('dimension', x).value
        const size = fromCss('dimension', obj.fontSize).value
        if (lh && size && lh.unit === size.unit) {
          out[k] = Number((lh.value / size.value).toFixed(4))
          continue
        }
      }
      if (type === 'typography' && k === 'letterSpacing' && typeof x === 'string' && /em$/.test(x.trim()) && !/rem$/.test(x.trim()) && obj.fontSize) {
        const size = fromCss('dimension', obj.fontSize).value
        if (size) {
          out[k] = { value: Number((parseFloat(x) * size.value).toFixed(4)), unit: size.unit }
          continue
        }
      }
      const r = fromCss(partType, x)
      if (r.error) return { error: `${k} ${r.error}` }
      if (r.css || r.approx) notes.push(`${k}: ${r.note}`)
      out[k] = r.value
    }
    return out
  }
  const value = Array.isArray(v) ? v.map(one) : one(v)
  const bad = [].concat(value).find((x) => x?.error)
  if (bad) return { error: bad.error }
  // A part that only CSS holds exactly makes the whole composite approximate outside CSS.
  return notes.length > 0 ? { value, approx: true, note: notes.join('; ') } : { value }
}

// One box-shadow layer: `[inset] x y [blur [spread]] color`, in any order CSS allows.
function shadowFromCss(text) {
  const parts = splitCss(text, ' ')
  const inset = parts.includes('inset')
  const lengths = []
  let color = null
  for (const p of parts) {
    if (p === 'inset') continue
    const d = fromCss('dimension', p)
    if (!d.error && !d.css) lengths.push(d.value)
    else if (colorFromCss(p) && !color) color = colorFromCss(p)
    else return null
  }
  if (lengths.length < 2 || lengths.length > 4) return null
  const zero = { value: 0, unit: 'px' }
  const out = {
    color: color ?? { colorSpace: 'srgb', components: [0, 0, 0], hex: '#000000' },
    offsetX: lengths[0],
    offsetY: lengths[1],
    blur: lengths[2] ?? zero,
    spread: lengths[3] ?? zero,
  }
  if (inset) out.inset = true
  return out
}

// ── Converting a token list between the two dialects ───────────────────────

// Old-dialect tokens (CSS strings, inferred types) as 2025.10 tokens. Each
// value converts exactly, converts with its exact CSS kept beside it, or, when
// the spec has no type for it, becomes a CSS-only value. `losses` lists every
// value that did not convert exactly, for the migration report.
// The types an untyped CSS value is tried as, in order, when the old dialect
// gave it none: what the text can be read as exactly decides it.
const UNTYPED_TRIES = ['shadow', 'duration', 'cubicBezier', 'dimension', 'number']

export function typedFromLegacy(tokens, typeOf) {
  const losses = []
  const out = tokens.map((t) => {
    let type = typeOf(t)
    const all = { default: t.value, ...t.modes }
    if (!TYPES.includes(type)) {
      const literal = Object.values(all).filter((v) => !isAlias(v))
      const fit = UNTYPED_TRIES.find((candidate) => literal.length > 0 && literal.every((v) => { const r = fromCss(candidate, v); return !r.error && !r.css }))
      if (fit) {
        losses.push({ token: t.name, kind: 'typed', detail: `had no type; read as a ${fit}, so check that is what it is` })
        type = fit
      }
    }
    const converted = {}
    const css = {}
    let failure = null
    for (const [mode, v] of Object.entries(all)) {
      const r = TYPES.includes(type) ? fromCss(type, v) : { error: 'has no DTCG type' }
      if (r.error) {
        failure = `${mode === 'default' ? '' : `${mode}: `}${r.error}`
        break
      }
      converted[mode] = r.value
      if (typeof r.css === 'string') css[mode] = r.css
      if (r.css || r.approx) {
        const where = mode === 'default' ? '' : `${mode}: `
        losses.push({ token: t.name, kind: r.css ? 'approximated' : 'changed', detail: `${where}${r.note}${r.css ? '' : '; the CSS outputs use the converted value too'}` })
      }
    }
    // The old dialect's 4.5:1 pair is a text pair, the WCAG 2.2 minimum for text.
    const use = t.use ?? (t.on && t.contrast === 4.5 ? 'text' : null)
    const shared = { ...t, use, strict: true, extensions: t.extensions ?? {}, deprecated: t.deprecated ?? null, groupType: t.type ?? null }
    if (failure) {
      losses.push({ token: t.name, kind: 'css-only', detail: `${failure}; it reaches the CSS outputs as written and nothing else` })
      return { ...shared, type: 'css', value: String(t.value), modes: Object.fromEntries(Object.entries(t.modes).map(([m, v]) => [m, String(v)])), css: null, cssModes: {}, strict: false, cssOnly: true }
    }
    const { default: value, ...modes } = converted
    const { default: cssDefault, ...cssModes } = css
    return { ...shared, type, value, modes, css: cssDefault ?? null, cssModes }
  })
  return { tokens: out, losses }
}

// ── Writing ────────────────────────────────────────────────────────────────

const setAt = (tree, path, node) => {
  let cur = tree
  path.slice(0, -1).forEach((k) => {
    cur[k] ??= {}
    cur = cur[k]
  })
  cur[path[path.length - 1]] = node
}

// The `$extensions` a token carries: other tools' kept as they were, massimo's
// for what the spec has no place for.
function extensionsOf(t, css) {
  const m = {}
  if (t.cssVar !== cssVarFor(t.path.filter((p) => p !== '$root'))) m.cssVar = t.cssVar
  if (t.on) m.contrast = t.use ? { on: t.on, use: t.use, ...(t.contrast !== CONTRAST_USES[t.use] ? { ratio: t.contrast } : {}) } : { on: t.on, ratio: t.contrast }
  if (t.collection) m.collection = t.collection
  if (css) m.css = css
  const ext = { ...(t.extensions ?? {}) }
  if (Object.keys(m).length > 0) ext.massimo = m
  return Object.keys(ext).length > 0 ? ext : null
}

// A token tree, with `$type` lifted to the highest group where every token
// below shares it, so a file reads like a hand-written one.
function treeOf(tokens, valueOf, cssOf) {
  const tree = {}
  for (const t of tokens) {
    const node = { $type: t.type, $value: valueOf(t) }
    if (t.description) node.$description = t.description
    if (t.deprecated) node.$deprecated = t.deprecated
    const ext = extensionsOf(t, cssOf(t))
    if (ext) node.$extensions = ext
    setAt(tree, t.path, node)
  }
  const typesBelow = (node) => (isToken(node) ? new Set([node.$type]) : new Set(Object.entries(node).filter(([k]) => !k.startsWith('$') || k === '$root').flatMap(([, c]) => [...typesBelow(c)])))
  // Never on the file's root: a resolver merges files, and a root $type would
  // spread to every token in the set.
  const lift = (node, inherited, top = false) => {
    if (isToken(node)) {
      if (node.$type === inherited) delete node.$type
      return node
    }
    const types = typesBelow(node)
    let own = inherited
    const out = {}
    if (!top && types.size === 1 && [...types][0] !== inherited) {
      own = [...types][0]
      out.$type = own
    }
    for (const [k, c] of Object.entries(node)) out[k] = k.startsWith('$') && k !== '$root' ? c : lift(c, own)
    return out
  }
  // Keep $type, $value, $description, $deprecated, $extensions in that order on every token.
  const order = (node) => {
    if (isToken(node)) {
      const out = {}
      for (const k of ['$type', '$value', '$description', '$deprecated', '$extensions']) if (k in node) out[k] = node[k]
      return out
    }
    const out = {}
    if (node.$type) out.$type = node.$type
    for (const [k, c] of Object.entries(node)) if (k !== '$type') out[k] = k.startsWith('$') && k !== '$root' ? c : order(c)
    return out
  }
  return order(lift(tree, undefined, true))
}

// JSON for token files, indented like JSON.stringify(v, null, 2) but in the
// order a reader expects: a token's own $-properties first and a group's $type
// and $description before its children, $extensions last. (JSON.stringify
// alone puts number-like names such as "100" before everything.)
const FIRST = ['$schema', 'version', 'name', '$type', '$value', '$description', '$deprecated', '$extends']
export function tokenJson(value) {
  const write = (v, indent) => {
    const pad = `${indent}  `
    if (Array.isArray(v)) return v.length === 0 ? '[]' : `[\n${v.map((x) => pad + write(x, pad)).join(',\n')}\n${indent}]`
    if (!isObject(v)) return JSON.stringify(v)
    const keys = Object.keys(v)
    if (keys.length === 0) return '{}'
    const ordered = [...FIRST.filter((k) => keys.includes(k)), ...keys.filter((k) => !FIRST.includes(k) && k !== '$extensions'), ...(keys.includes('$extensions') ? ['$extensions'] : [])]
    return `{\n${ordered.map((k) => `${pad}${JSON.stringify(k)}: ${write(v[k], pad)}`).join(',\n')}\n${indent}}`
  }
  return `${write(value, '')}\n`
}
const jsonText = tokenJson

// A 2025.10 token set as files, keyed by path relative to the tokens folder:
// the resolver document, `base.tokens.json`, and one file per other context
// under its modifier's folder. Values with no DTCG type go to the base file's
// `$extensions.massimo.cssOnly`.
export function writeTokenSet({ tokens, defaultMode = 'light', modifier = 'theme', name = 'Design tokens', description } = {}) {
  const typed = tokens.filter((t) => !t.cssOnly)
  const cssOnly = tokens.filter((t) => t.cssOnly)
  const modes = [...new Set(tokens.flatMap((t) => Object.keys(t.modes)))].sort((a, b) => (a === 'dark' ? -1 : b === 'dark' ? 1 : a < b ? -1 : a > b ? 1 : 0))
  const files = {}
  const root = { $description: description ?? `${name}. Written by massimo in the W3C Design Tokens format 2025.10.` }
  const baseTree = treeOf(typed, (t) => t.value, (t) => t.css)
  const ext = { format: FORMAT_VERSION }
  if (cssOnly.length > 0) {
    ext.cssOnly = Object.fromEntries(cssOnly.map((t) => {
      const entry = { css: t.value }
      // Where it stood among the tokens, so the outputs keep their order.
      const before = tokens[tokens.indexOf(t) - 1]
      if (before) entry.after = before.name
      if (Object.keys(t.modes).length > 0) entry.modes = t.modes
      if (t.cssVar !== cssVarFor(t.path)) entry.cssVar = t.cssVar
      if (t.description) entry.description = t.description
      return [t.name, entry]
    }))
  }
  files['base.tokens.json'] = jsonText({ ...root, ...baseTree, $extensions: { massimo: ext } })
  const contexts = { [defaultMode]: [] }
  for (const mode of modes) {
    const own = typed.filter((t) => mode in t.modes || mode in t.cssModes)
    const tree = treeOf(own, (t) => (mode in t.modes ? t.modes[mode] : t.value), (t) => t.cssModes[mode] ?? (mode in t.modes ? null : t.css))
    const onlyCss = cssOnly.filter((t) => mode in t.modes)
    const fileExt = { format: FORMAT_VERSION }
    if (onlyCss.length > 0) fileExt.cssOnly = Object.fromEntries(onlyCss.map((t) => [t.name, { css: t.modes[mode] }]))
    const file = `${modifier}/${mode}.tokens.json`
    files[file] = jsonText({ $description: `What changes in the ${mode} context.`, ...tree, $extensions: { massimo: fileExt } })
    contexts[mode] = [{ $ref: file }]
  }
  const resolver = {
    version: RESOLVER_VERSION,
    name,
    sets: { base: { sources: [{ $ref: 'base.tokens.json' }] } },
    ...(modes.length > 0 ? { modifiers: { [modifier]: { contexts, default: defaultMode } } } : {}),
    resolutionOrder: [{ $ref: '#/sets/base' }, ...(modes.length > 0 ? [{ $ref: `#/modifiers/${modifier}` }] : [])],
  }
  files['tokens.resolver.json'] = jsonText(resolver)
  return files
}

// A typed token list in the dialect massimo wrote before 0.2.0, so a repo
// still on an older massimo can read it. Values become CSS text (or the exact
// CSS kept beside them); `losses` lists what that dialect cannot hold.
export function writeLegacy(tokens, cssTextOf) {
  const losses = []
  const tree = {}
  for (const t of tokens) {
    if (t.path.includes('$root')) losses.push({ token: t.name, kind: 'unreadable', detail: 'massimo before 0.2.0 skips $root tokens' })
    const text = (mode) => {
      const css = mode === 'default' ? t.css : t.cssModes[mode]
      if (css) return css
      const v = mode === 'default' ? t.value : t.modes[mode]
      if (isAlias(v) || t.cssOnly) return v
      if (t.type === 'fontFamily' && Array.isArray(v)) return v
      if (t.type === 'number' && isNum(v)) return v
      return cssTextOf(t.type, v)
    }
    const node = { $type: t.cssOnly ? undefined : t.type, $value: text('default') }
    if (node.$type === undefined) delete node.$type
    if (t.description) node.$description = t.description
    if (t.deprecated) node.$deprecated = t.deprecated
    const m = {}
    const modes = Object.keys(t.modes)
    if (modes.length > 0) m.modes = Object.fromEntries(modes.map((mode) => [mode, text(mode)]))
    if (t.cssVar !== cssVarFor(t.path)) m.cssVar = t.cssVar
    if (t.on) {
      m.on = t.on
      m.contrast = t.contrast
    }
    if (t.collection) m.collection = t.collection
    const ext = { ...(t.extensions ?? {}) }
    if (Object.keys(m).length > 0) ext.massimo = m
    if (Object.keys(ext).length > 0) node.$extensions = ext
    setAt(tree, t.path, node)
  }
  return { doc: tree, losses }
}

export { colorCss }
