// Where a mobile app keeps its design values, read into the readers' token
// shape (lib/readers.mjs) so `tokens.mjs extract` proposes them like any
// other source: the colour sets of an Xcode asset catalog, and an Android
// module's res/values colours and dimensions. Both are plain text (JSON and
// XML) and are read as text; nothing is built or run.
//
// A token from here also carries `mobile`, kept in the token set as
// `$extensions.massimo.mobile`: the catalog name or resource name it came
// from, so the outputs write the same name back, and what the token set has
// no place for yet (a colour's high-contrast entries).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { toHex } from './color.mjs'
import { compare, compileGlobs, expandGlobs } from './glob.mjs'
import { stripJsonComments } from './project.mjs'

const token = (path, fields) => ({ path, type: null, value: undefined, modes: {}, css: null, cssVar: null, description: '', source: '', mobile: null, ...fields })
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const readJson = (path) => JSON.parse(stripJsonComments(readFileSync(path, 'utf8')))

// ── Xcode asset catalogs ───────────────────────────────────────────────────

// One component as Xcode writes it: "0xRR" (8-bit hex), "102" (8-bit) or
// "0.400" (floating point). Returns { value 0..1, exact8 } or null.
function component(raw) {
  const s = String(raw ?? '').trim()
  if (/^0x[0-9a-f]{1,2}$/i.test(s)) return { value: Number.parseInt(s.slice(2), 16) / 255, exact8: true, form: 'hex' }
  if (/^\d+$/.test(s)) return { value: Number(s) / 255, exact8: true, form: 'integer' }
  if (/^-?(?:\d+\.\d*|\.\d+)$/.test(s)) {
    const v = Number(s)
    return { value: v, exact8: Math.abs(v * 255 - Math.round(v * 255)) < 1e-9, form: 'float' }
  }
  return null
}

const fixed = (n) => String(Number(n.toFixed(6)))

// A colour entry's colour as CSS text, or { why } when it cannot be read.
// sRGB in 8-bit steps is hex; anything finer, and Display P3, is color().
export function colorEntryCss(color) {
  if (!isObject(color)) return { why: 'has no colour' }
  if (color.platform || color.reference) return { why: `is the system colour ${color.reference ?? color.platform}, which has no value to read` }
  const space = String(color['color-space'] ?? 'srgb')
  const c = isObject(color.components) ? color.components : {}
  // Alpha is a 0 to 1 number in every form Xcode writes, "1" included; only 0xRR is a byte.
  const alphaRaw = String(c.alpha ?? '1').trim()
  const alpha = /^0x/i.test(alphaRaw) ? component(alphaRaw) ?? { value: 1 } : Number.isFinite(Number(alphaRaw)) ? { value: Number(alphaRaw) } : { value: 1 }
  const a = alpha.value
  if (space === 'gray-gamma-22' || space === 'extended-gray') {
    const w = component(c.white)
    if (!w) return { why: `has a ${space} colour with no white component` }
    return { css: a < 1 ? `color(srgb ${fixed(w.value)} ${fixed(w.value)} ${fixed(w.value)} / ${fixed(a)})` : toHex({ r: w.value, g: w.value, b: w.value }), note: `is a ${space} colour, read as sRGB grey` }
  }
  const parts = ['red', 'green', 'blue'].map((k) => component(c[k]))
  if (parts.some((p) => p === null)) return { why: `has a ${space} colour whose components cannot be read` }
  const [r, g, b] = parts.map((p) => p.value)
  const form = parts[0].form
  // color() always states its alpha: read without one, its last component would be taken for the alpha.
  const alphaText = ` / ${fixed(a)}`
  if (space === 'display-p3') return { css: `color(display-p3 ${fixed(r)} ${fixed(g)} ${fixed(b)}${alphaText})`, form }
  if (space === 'extended-linear-srgb') return { css: `color(srgb-linear ${fixed(r)} ${fixed(g)} ${fixed(b)}${alphaText})`, form }
  if (space !== 'srgb' && space !== 'extended-srgb') return { why: `is in the colour space ${space}, which massimo does not read` }
  const outside = [r, g, b].some((v) => v < 0 || v > 1)
  const note = outside ? 'is an extended sRGB colour outside 0 to 1, which the token keeps and the other outputs clip' : null
  const eight = parts.every((p) => p.exact8) && (a === 1 || Math.abs(a * 255 - Math.round(a * 255)) < 1e-9) && !outside
  return { css: eight ? toHex({ r, g, b, a }) : `color(srgb ${fixed(r)} ${fixed(g)} ${fixed(b)}${alphaText})`, note, form }
}

// The keys of a colour entry a token holds; any other (locale, subtype…) is a variant.
const ENTRY_KEYS = ['idiom', 'appearances', 'color', 'display-gamut']

// Which appearance an entry is for: any, light, dark, or high contrast
// (in light or dark); null for an appearance massimo does not model.
function appearanceOf(entry) {
  const list = Array.isArray(entry.appearances) ? entry.appearances : []
  let luminosity = null
  let contrast = false
  for (const a of list) {
    if (a?.appearance === 'luminosity' && (a.value === 'light' || a.value === 'dark')) luminosity = a.value
    else if (a?.appearance === 'contrast' && a.value === 'high') contrast = true
    else return null
  }
  if (contrast) return luminosity === 'dark' ? 'contrast-dark' : 'contrast-light'
  return luminosity ?? 'any'
}

// The catalogs a mobileSources entry names: a path to an .xcassets folder, or
// a glob that matches catalog folders.
export function catalogPaths(root, path, ignore = []) {
  if (typeof path !== 'string' || !path.trim()) return []
  const clean = path.replace(/^\.\//, '').replace(/\/+$/, '')
  if (!/[*?{[]/.test(clean)) return existsSync(join(root, clean)) ? [clean] : []
  const match = compileGlobs([clean])
  const files = expandGlobs(root, ['**/*.xcassets/Contents.json'], [], ignore)
  return [...new Set(files.map((f) => f.slice(0, f.indexOf('.xcassets/') + '.xcassets'.length)))].filter(match).sort(compare)
}

// Every colour set in a catalog: { name (as Xcode names it, namespaces
// joined by "/"), folder (the .colorset's path), values: { any, light, dark,
// 'contrast-light', 'contrast-dark' } as CSS text, notes }.
export function catalogColors(root, catalog) {
  const out = []
  const base = join(root, catalog)
  if (!existsSync(base)) return out
  const visit = (dir, rel, namespace) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => compare(a.name, b.name))) {
      const path = join(dir, e.name)
      const relPath = `${rel}/${e.name}`
      if (e.name.endsWith('.colorset')) {
        out.push(readColorSet(path, relPath, [...namespace, e.name.slice(0, -'.colorset'.length)].join('/')))
        continue
      }
      // Other asset types (.imageset, .appiconset, .symbolset…) hold no colour.
      if (/\.[a-z]+set$/i.test(e.name) || e.name.endsWith('.xcassets')) continue
      let provides = false
      try {
        provides = readJson(join(path, 'Contents.json'))?.properties?.['provides-namespace'] === true
      } catch {
        // a folder with no Contents.json is a plain folder
      }
      visit(path, relPath, provides ? [...namespace, e.name] : namespace)
    }
  }
  visit(base, catalog, [])
  return out
}

function readColorSet(path, folder, name) {
  const notes = []
  const values = {}
  const forms = {}
  let doc = null
  try {
    doc = readJson(join(path, 'Contents.json'))
  } catch (err) {
    // What it holds cannot be known, so it is never the owned catalog's to replace.
    return { name, folder, values, notes: [`${folder}: Contents.json cannot be read (${err.message})`], refused: 1, variants: ['a Contents.json massimo cannot read'] }
  }
  const colors = Array.isArray(doc?.colors) ? doc.colors : []
  // One idiom is read: universal, else iphone, else the first there is.
  const idiomOf = (c) => c.idiom ?? 'universal'
  const idioms = [...new Set(colors.map(idiomOf))]
  const idiom = idioms.includes('universal') ? 'universal' : idioms.includes('iphone') ? 'iphone' : idioms[0]
  const others = idioms.filter((i) => i !== idiom)
  if (idiom !== 'universal' && idiom !== undefined) notes.push(`${folder}: has no universal entries; read the ${idiom} ones${others.length > 0 ? `, and the ${others.join(', ')} ones are not read` : ''}`)
  else if (others.length > 0) notes.push(`${folder}: also has entries for ${others.join(', ')}, which are not read`)
  // What the set holds that a token cannot, so a catalog massimo writes
  // would not carry it: such a set stays the app's, whole (see xcassetsPlan).
  const variants = new Set(others.map((i) => `the ${i} idiom`))
  // An entry refused with a reason already given, so the set is not called empty as well.
  let refused = 0
  const gamuts = new Set()
  const entries = colors.filter((c) => idiomOf(c) === idiom)
  // Wide-gamut entries are read only when the set has no sRGB ones: then they are its colour.
  const wideOnly = entries.length > 0 && entries.every((e) => e['display-gamut'] && e['display-gamut'] !== 'sRGB')
  const seen = new Set()
  for (const entry of entries) {
    // A key a token cannot hold (a locale, a subtype…) makes it another entry, never the base one.
    const extra = Object.keys(entry).filter((k) => !ENTRY_KEYS.includes(k))
    if (extra.length > 0) {
      const what = extra.map((k) => (k === 'locale' ? `an entry for the locale ${entry.locale}` : `an entry with ${k} ${JSON.stringify(entry[k])}`)).join(', ')
      notes.push(`${folder}: has ${what}, which is not read`)
      variants.add(what)
      refused++
      continue
    }
    if (entry['display-gamut'] && entry['display-gamut'] !== 'sRGB') {
      gamuts.add(entry['display-gamut'])
      if (!wideOnly) continue
    }
    const which = appearanceOf(entry)
    if (!which) {
      notes.push(`${folder}: has an entry for an appearance massimo does not read (${JSON.stringify(entry.appearances)})`)
      variants.add(`an entry for the appearance ${JSON.stringify(entry.appearances)}`)
      refused++
      continue
    }
    if (!entry.color) continue
    if (seen.has(which)) {
      notes.push(`${folder}: has two entries for the ${which} appearance; read the first`)
      variants.add(`two entries for the ${which} appearance`)
      continue
    }
    seen.add(which)
    const read = colorEntryCss(entry.color)
    if (read.why) {
      notes.push(`${folder}: the ${which} entry ${read.why}`)
      variants.add(`a ${which} entry it cannot read`)
      refused++
      continue
    }
    if (read.note) notes.push(`${folder}: the ${which} entry ${read.note}`)
    values[which] = read.css
    forms[which] = read.form
  }
  for (const g of gamuts) {
    notes.push(wideOnly ? `${folder}: has only ${g} gamut entries, which are read` : `${folder}: has ${g} gamut entries, which are not read; the sRGB ones are`)
    variants.add(wideOnly ? `${g} gamut entries only` : `${g} gamut`)
  }
  if (values.light && values.any && values.light !== values.any) variants.add('an any-appearance entry that differs from the light one')
  // How its components are written (0xRR, 102 or 0.400), so a build writes them back the same way.
  const form = forms.light ?? forms.any ?? null
  return { name, folder, values, notes, form, refused, variants: [...variants] }
}

// Whether a colour set has high-contrast entries, which the token set cannot
// hold before massimo models contrast.
export const hasHighContrast = (set) => 'contrast-light' in set.values || 'contrast-dark' in set.values

// The colour sets of the catalogs a source names, as tokens under `color`:
// the light (or any) entry is the value, the dark entry the dark mode, and
// the name Xcode gives it is kept in `mobile.asset`. High-contrast entries
// are kept in `mobile.contrast`, and the colour is listed in the notes.
// Whether two repo-relative paths are one file or folder on disk: the same
// spelling, or another one (a case-only rename on a disk that ignores case).
export function samePlace(root, a, b) {
  if (a === b) return true
  try {
    const x = statSync(join(root, a))
    const y = statSync(join(root, b))
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

// Whether a catalog is one massimo writes or wrote (`owned` lists them).
export const isOwnedCatalog = (root, owned, catalog) => owned.some((o) => samePlace(root, o, catalog))

export function readAssetCatalog(root, path, ignore = [], { owned = [] } = {}) {
  const notes = []
  const tokens = []
  // A catalog massimo writes (an xcassets output) is never read back as the app's own.
  const catalogs = catalogPaths(root, path, ignore).filter((c) => !isOwnedCatalog(root, owned, c))
  if (catalogs.length === 0) notes.push(`${path}: no asset catalog there`)
  const contrast = []
  for (const catalog of catalogs) {
    for (const set of catalogColors(root, catalog)) {
      notes.push(...set.notes)
      const base = set.values.light ?? set.values.any
      if (!base) {
        if (Object.keys(set.values).length > 0) notes.push(`${set.folder}: has no light or any-appearance entry, so no token`)
        else if (!set.refused) notes.push(`${set.folder}: holds no colour, so no token (an empty AccentColor, say)`)
        continue
      }
      if (set.values.light && set.values.any && set.values.light !== set.values.any) notes.push(`${set.folder}: its any-appearance entry (${set.values.any}) differs from its light one (${set.values.light}); the token takes the light one`)
      const mobile = { asset: set.name, catalog, ...(set.form && set.form !== 'hex' ? { form: set.form } : {}) }
      if (set.variants.length > 0) mobile.variants = set.variants
      if (hasHighContrast(set)) {
        mobile.contrast = Object.fromEntries([['light', set.values['contrast-light']], ['dark', set.values['contrast-dark']]].filter(([, v]) => v))
        contrast.push(set.name)
      }
      const t = token(['color', ...set.name.split('/')], { type: 'color', value: base, source: catalog, mobile })
      if (set.values.dark && set.values.dark !== base) t.modes.dark = set.values.dark
      tokens.push(t)
    }
  }
  if (contrast.length > 0) {
    const shown = `${contrast.slice(0, 8).join(', ')}${contrast.length > 8 ? `, +${contrast.length - 8} more` : ''}`
    notes.push(`${contrast.length} ${contrast.length === 1 ? 'colour has' : 'colours have'} high-contrast entries (${shown}). The token keeps them in $extensions.massimo.mobile.contrast; until massimo models contrast, an xcassets build leaves ${contrast.length === 1 ? 'that colour' : 'those colours'} in the app's catalog and lists ${contrast.length === 1 ? 'it' : 'them'}.`)
  }
  return { tokens, notes, catalogs }
}

// ── Android res/values ─────────────────────────────────────────────────────

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

// The simple resources an XML file declares: [{ type, name, value }], with
// comments taken out. `<item type="color" name="x">` counts as a colour.
export function xmlResources(text) {
  const code = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  const out = []
  // The tag name ends at a space, a slash or >, so <string-array> is never read as a <string>.
  for (const m of code.matchAll(/<(color|dimen|integer|bool|string|item|style|declare-styleable|attr|array|string-array|integer-array|plurals|fraction|drawable|id)(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g)) {
    const attrs = m[2]
    const attr = (key) => new RegExp(`\\b${key}\\s*=\\s*(["'])(.*?)\\1`).exec(attrs)?.[2]
    const name = attr('name')
    if (!name) continue
    let type = m[1]
    if (type === 'item') type = attr('type') ?? 'item'
    out.push({ type, name, value: m[3] === undefined ? null : unescapeXml(m[3].trim()) })
  }
  return out
}

// An Android colour as CSS: #RGB, #ARGB, #RRGGBB or #AARRGGBB, alpha first,
// as #RRGGBBAA; null when it is not one.
export function androidColor(text) {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(text).trim())
  if (!m) return null
  const h = m[1].toLowerCase()
  if (h.length === 3 || h.length === 6) return `#${h}`
  if (h.length === 4) return `#${h.slice(1)}${h[0]}`.replace(/^#(.{3})f$/, '#$1')
  return `#${h.slice(2)}${h.slice(0, 2)}`.replace(/^#(.{6})ff$/, '#$1')
}

const ANDROID_COLORS = { white: '#ffffff', black: '#000000', transparent: '#00000000' }

// The group a dimension's name puts it in.
function dimensionGroup(name, unit) {
  if (unit === 'sp') return 'text'
  const n = name.toLowerCase()
  if (/(?:^|_)(?:spacing|space|margin|padding|gap|inset|gutter)(?:_|$)/.test(n)) return 'spacing'
  if (/(?:radius|corner)/.test(n)) return 'radius'
  if (/elevation/.test(n)) return 'elevation'
  return 'size'
}

// The qualifier a values folder stands for: '' (values), 'dark'
// (values-night), or null for one massimo does not model (values-v31,
// values-land, values-sw600dp...).
function qualifierOf(file) {
  const dir = /(?:^|\/)(values(?:-[^/]+)?)\/[^/]+\.xml$/.exec(file)?.[1]
  if (dir === 'values') return ''
  if (dir === 'values-night') return 'dark'
  return null
}

// Colours and dimensions from res/values XML files, as tokens: a colour is
// `color.<name>`, a dimension `<group>.<name>` with the group read from its
// name (spacing, radius, elevation, size, or text for an sp size). values-night
// gives the dark mode. A reference (@color/x, @dimen/x) becomes a token
// reference; `?attr/` and other qualifiers are listed in the notes.
export function readAndroidValues(root, files) {
  const notes = []
  const byKey = new Map()
  const tokens = []
  const skipped = new Map()
  const night = []
  const ordered = [...files].sort((a, b) => Number(qualifierOf(a) === 'dark') - Number(qualifierOf(b) === 'dark') || compare(a, b))
  const refs = []
  for (const file of ordered) {
    const qualifier = qualifierOf(file)
    let text = ''
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      notes.push(`${file}: cannot be read`)
      continue
    }
    const resources = xmlResources(text).filter((r) => r.type === 'color' || r.type === 'dimen')
    if (qualifier === null) {
      if (resources.length > 0) skipped.set(file.replace(/\/[^/]+$/, ''), (skipped.get(file.replace(/\/[^/]+$/, '')) ?? 0) + resources.length)
      continue
    }
    for (const r of resources) {
      const value = r.value ?? ''
      let css = null
      let group = 'color'
      let type = 'color'
      if (r.type === 'color') {
        if (/^@color\//.test(value)) css = { ref: ['color', value.slice(7)] }
        else if (/^@android:color\//.test(value)) {
          const known = ANDROID_COLORS[value.slice(15)]
          if (!known) {
            notes.push(`${file}: ${r.name} is the system colour ${value}, which has no value to read`)
            continue
          }
          css = known
        } else css = androidColor(value)
        if (!css) {
          notes.push(`${file}: ${r.name} is ${value || 'empty'}, which is not a colour massimo reads${value.startsWith('?') ? ' (a theme attribute)' : ''}`)
          continue
        }
      } else {
        type = 'dimension'
        if (/^@dimen\//.test(value)) {
          css = { ref: ['dimen', value.slice(7)] }
          group = null
        } else {
          const m = /^(-?(?:\d+\.?\d*|\.\d+))(dp|dip|sp|px|pt|mm|in)$/.exec(value)
          if (!m) {
            notes.push(`${file}: ${r.name} is ${value || 'empty'}, which is not a dimension massimo reads`)
            continue
          }
          if (!['dp', 'dip', 'sp'].includes(m[2])) {
            // px is a screen pixel; pt, mm and in are physical sizes, which have no fixed dp value.
            notes.push(`${file}: ${r.name} is in ${m[2]}, ${m[2] === 'px' ? 'which does not scale with the screen' : 'a physical unit with no fixed dp value'}; left out`)
            continue
          }
          css = `${Number(m[1])}px`
          group = dimensionGroup(r.name, m[2] === 'sp' ? 'sp' : 'dp')
        }
      }
      const key = `${r.type}:${r.name}`
      if (qualifier === 'dark') {
        const t = byKey.get(key)
        if (!t) {
          notes.push(`${file}: ${r.name} is set for night only, so no token; give it a value in values/ first`)
          continue
        }
        night.push({ t, value: css, file })
        continue
      }
      if (byKey.has(key)) {
        notes.push(`${file}: ${r.name} is also in ${byKey.get(key).source}; kept the one from ${byKey.get(key).source}`)
        continue
      }
      const t = token([group ?? 'size', r.name], { type, value: css, source: file, mobile: { resource: r.name } })
      if (group === null) t.dimenRef = true
      byKey.set(key, t)
      tokens.push(t)
      if (isObject(css)) refs.push({ t, at: 'value' })
    }
  }
  // References point at the token their resource became. Each chain is
  // followed to the value it ends at first, so the order resources are
  // declared in never matters: a dimension takes its group from that value,
  // and a chain that ends at a resource no file read here declares (a
  // library's colour, say), or goes round, leaves out every token on it.
  const keyOf = (ref) => `${ref[0] === 'dimen' ? 'dimen' : 'color'}:${ref[1]}`
  const refOf = new Map(refs.map(({ t }) => [t, t.value.ref]))
  const ends = new Map()
  const follow = (t, seen = new Set()) => {
    if (!refOf.has(t)) return { end: t }
    if (ends.has(t)) return ends.get(t)
    if (seen.has(t)) return { end: null, cycle: true }
    seen.add(t)
    const next = byKey.get(keyOf(refOf.get(t)))
    const out = next ? follow(next, seen) : { end: null, missing: true }
    ends.set(t, out)
    return out
  }
  const shown = (ref) => `@${ref[0]}/${ref[1]}`
  for (const { t } of refs) {
    const { end, cycle } = follow(t)
    if (end) continue
    const ref = refOf.get(t)
    const direct = !byKey.has(keyOf(ref))
    notes.push(`${t.source}: ${t.mobile.resource} points at ${shown(ref)}, ${cycle ? 'and the references go round in a cycle' : direct ? 'which no file read here declares' : 'which is left out'}; left out${direct || cycle ? '' : ' too'}`)
  }
  const out = new Set(refs.filter(({ t }) => !follow(t).end).map(({ t }) => t))
  for (const t of out) {
    tokens.splice(tokens.indexOf(t), 1)
    for (const [k, v] of byKey) if (v === t) byKey.delete(k)
  }
  for (const t of tokens) {
    if (t.dimenRef) t.path = [follow(t).end.path[0], t.path[1]]
    delete t.dimenRef
  }
  for (const t of tokens) if (refOf.has(t)) t.value = `{${byKey.get(keyOf(refOf.get(t))).path.join('.')}}`
  for (const { t, value, file } of night) {
    if (out.has(t)) continue
    const target = isObject(value) ? byKey.get(keyOf(value.ref)) : null
    if (isObject(value) && !target) {
      notes.push(`${file}: ${t.mobile.resource} points at ${shown(value.ref)}, which no file read here declares`)
      continue
    }
    const v = target ? `{${target.path.join('.')}}` : value
    if (v !== t.value) t.modes.dark = v
  }
  for (const [dir, count] of [...skipped].sort((a, b) => compare(a[0], b[0]))) {
    notes.push(`${dir}: ${count} ${count === 1 ? 'value is' : 'values are'} for a qualifier massimo does not model yet (only values and values-night are read)`)
  }
  return { tokens, notes }
}

// The values files a mobileSources entry names: globs, matched against
// res/values*/ XML files.
export function androidValueFiles(root, include, ignore = []) {
  const globs = [].concat(include ?? []).filter((g) => typeof g === 'string')
  if (globs.length === 0) return []
  return expandGlobs(root, globs, [], ignore).filter((f) => /(?:^|\/)res\/values[^/]*\/[^/]+\.xml$/.test(f))
}

// Every values XML file of the module a res folder belongs to, for the clash
// check: <module>/src/<set>/res/values*/*.xml.
export function moduleValueFiles(root, resDir) {
  const at = resDir.replace(/\/+$/, '').indexOf('/src/')
  const module = at === -1 ? resDir.replace(/\/res\/?$/, '') : resDir.slice(0, at)
  const out = []
  const src = join(root, module, 'src')
  const sets = existsSync(src) && statSync(src).isDirectory() ? readdirSync(src) : []
  const resDirs = sets.length > 0 ? sets.map((s) => `${module}/src/${s}/res`) : [resDir.replace(/\/+$/, '')]
  for (const res of resDirs) {
    const abs = join(root, res)
    if (!existsSync(abs)) continue
    for (const dir of readdirSync(abs).filter((d) => /^values(?:-|$)/.test(d)).sort(compare)) {
      for (const f of readdirSync(join(abs, dir)).filter((n) => n.endsWith('.xml')).sort(compare)) out.push(`${res}/${dir}/${f}`)
    }
  }
  return out
}
