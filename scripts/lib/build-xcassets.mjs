// The xcassets output: an asset catalog massimo owns, with one colour set per
// colour token and a dark appearance where the colour changes in dark mode,
// written the way Xcode writes it ("key" : value, keys in order, 8-bit
// components as 0xRR) so a colour set read from an app's catalog builds back
// the same. A Contents.json cannot hold a comment, so each says
// `"author" : "massimo"` and the catalog's files are listed as massimo's in
// <project>/tokens/mobile-outputs.json.
//
// A colour whose colour set in the app's own catalog has high-contrast
// entries, or any other entry a token cannot hold (a Display P3 gamut,
// another idiom), is skipped: the colour stays in the app's catalog as it
// is, the rest build, and the build lists it.

import { byteOf, outOfRange } from './mobile-units.mjs'
import { assetName, collisions } from './mobile-names.mjs'
import { hasHighContrast } from './readers-mobile.mjs'

// JSON as Xcode writes it: two spaces, and a space either side of the colon.
export function xcodeJson(value) {
  return `${JSON.stringify(value, null, 2).replace(/^(\s*"(?:[^"\\]|\\.)*"): /gm, '$1 : ')}\n`
}

const info = { author: 'massimo', version: 1 }

// One component as Xcode writes it, in the form the colour set it was read
// from used (`$extensions.massimo.mobile.form`): 0xRR by default, or an
// 8-bit integer, when it is an 8-bit step; else a number with three places
// (more when three would change it).
function componentText(n, form = 'hex') {
  const byte = byteOf(n)
  if (byte !== null && form === 'integer') return String(byte)
  if (byte !== null && form !== 'float') return `0x${byte.toString(16).toUpperCase().padStart(2, '0')}`
  const three = n.toFixed(3)
  return Math.abs(Number(three) - n) < 5e-7 ? three : String(Number(n.toFixed(6)))
}

function colorJson(c, form) {
  const extended = c.space === 'srgb' && outOfRange(c)
  const text = (n) => componentText(n, form)
  return {
    'color-space': c.space === 'display-p3' ? 'display-p3' : extended ? 'extended-srgb' : 'srgb',
    components: { alpha: c.a.toFixed(3), blue: text(c.b), green: text(c.g), red: text(c.r) },
  }
}

// What the catalog holds: { colors: [{ entry, name }], skipped: [{ token,
// why }], notes }. `teamSets` maps a colour set name in the app's own
// catalogs to what was read from it.
export function xcassetsPlan(entries, teamSets = new Map()) {
  const colors = []
  const skipped = []
  const notes = []
  const unsafe = []
  for (const e of entries.filter((x) => x.type === 'color')) {
    const name = assetName(e.t)
    // A name is folders and a colour set name: a step that is empty, . or .. would write outside the catalog.
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some((step) => !step.trim() || step === '.' || step === '..')) {
      unsafe.push({ token: e.t.name, name })
      continue
    }
    const team = teamSets.get(name)
    if (e.t.mobile?.contrast || (team && hasHighContrast(team))) {
      const reason = `has high-contrast entries${team ? ` in ${team.folder}` : ''}, which massimo does not model yet`
      skipped.push({ token: e.t.name, reason, why: `${reason}; it stays in the app's catalog as it is`, asset: name })
      continue
    }
    // Entries a token cannot hold (a Display P3 gamut, another idiom): the
    // owned set would not carry them, so the app's set stays whole and is
    // never listed as a duplicate for --dedupe to remove.
    const variants = team ? team.variants ?? [] : Array.isArray(e.t.mobile?.variants) ? e.t.mobile.variants : []
    if (variants.length > 0) {
      const reason = `has entries massimo does not model yet (${variants.join(', ')})${team ? ` in ${team.folder}` : ''}`
      skipped.push({ token: e.t.name, reason, why: `${reason}; it stays in the app's catalog as it is`, asset: name })
      continue
    }
    if (e.value.color.converted) notes.push(`${e.t.name}: converted from ${e.value.color.converted} to sRGB for the catalog`)
    colors.push({ entry: e, name })
  }
  // An alias of a colour left in the app's catalog would lose what that
  // colour keeps there: it is left out too, and reads that colour's set.
  const left = new Map(skipped.map((s) => [s.token, s]))
  for (const c of [...colors]) {
    const to = c.entry.target ? left.get(c.entry.target.name) : null
    if (!to) continue
    colors.splice(colors.indexOf(c), 1)
    const reason = `points at ${c.entry.target.name}, which ${to.reason}`
    skipped.push({ token: c.entry.t.name, reason, why: `${reason}; it reads that colour's set in the app's catalog`, asset: to.asset })
  }
  return { colors, skipped, notes, unsafe, collisions: collisions(colors.map((c) => ({ name: c.name, token: c.entry.t.name }))) }
}

// Every file of the catalog at `dir` (repo-relative), as { path, text }.
export function buildXcassets(plan, dir) {
  const files = [{ path: `${dir}/Contents.json`, text: xcodeJson({ info }) }]
  const folders = new Set()
  for (const { entry, name } of [...plan.colors].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const parts = name.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
    const form = entry.t.mobile?.form
    const colors = [{ color: colorJson(entry.value.color, form), idiom: 'universal' }]
    if (entry.dark) colors.push({ appearances: [{ appearance: 'luminosity', value: 'dark' }], color: colorJson(entry.dark.color, form), idiom: 'universal' })
    files.push({ path: `${dir}/${name}.colorset/Contents.json`, text: xcodeJson({ colors, info }) })
  }
  for (const folder of [...folders].sort()) files.push({ path: `${dir}/${folder}/Contents.json`, text: xcodeJson({ info, properties: { 'provides-namespace': true } }) })
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
