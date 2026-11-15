// The android-xml output: values/massimo_tokens.xml and, when a colour
// changes in dark mode, values-night/massimo_tokens.xml, in the res folder the
// output names. Never the app's own colors.xml or dimens.xml. Every name is
// the token's whole path in snake_case (color_brand_primary), and before
// anything is written each one is checked against the resources the module
// already declares in every res/values*/ file: a clash stops the build with a
// list, since two resources of one name and type do not compile.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resourceName } from './mobile-names.mjs'
import { inSrgb, numberText } from './mobile-units.mjs'
import { moduleValueFiles, xmlResources } from './readers-mobile.mjs'

const hex = (c) => {
  const s = inSrgb(c)
  const b = (x) => Math.round(x * 255).toString(16).toUpperCase().padStart(2, '0')
  return { text: `#${b(s.a)}${b(s.r)}${b(s.g)}${b(s.b)}`, clipped: s.clipped }
}
const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/--/g, '- -')

function xmlFile(header, lines) {
  return ['<?xml version="1.0" encoding="utf-8"?>', `<!-- ${escapeXml(header)} -->`, '<!-- massimo mobile output, format 1 -->', '<resources>', ...lines.map((l) => `    ${l}`), '</resources>', ''].join('\n')
}

// The resources the output declares: [{ type, name, line, night }].
export function androidPlan(entries, options) {
  const resources = []
  const skipped = []
  const notes = []
  for (const e of entries) {
    const name = resourceName(e.t)
    const v = e.value
    if (v.color) {
      const day = hex(v.color)
      if (day.clipped || v.color.space === 'display-p3') notes.push(`${e.t.name}: Android colour resources are sRGB, so its ${v.color.space === 'display-p3' ? 'Display P3' : v.color.converted ?? ''} value was converted${day.clipped ? ' and clipped' : ''}`)
      resources.push({ type: 'color', name, line: `<color name="${name}">${day.text}</color>` })
      if (e.dark) resources.push({ type: 'color', name, night: true, line: `<color name="${name}">${hex(e.dark.color).text}</color>` })
    } else if (v.points !== undefined) {
      const u = e.group === 'Typography' ? options.fontUnit : 'dp'
      resources.push({ type: 'dimen', name, line: `<dimen name="${name}">${numberText(v.points)}${u}</dimen>` })
    } else if (v.number !== undefined) {
      resources.push({ type: 'dimen', name, line: `<item name="${name}" format="float" type="dimen">${numberText(v.number)}</item>` })
    } else if (v.ms !== undefined) {
      resources.push({ type: 'integer', name, line: `<integer name="${name}">${Math.round(v.ms)}</integer>` })
    } else if (v.text) {
      resources.push({ type: 'dimen', name: `${name}_size`, line: `<dimen name="${name}_size">${numberText(v.text.size)}${options.fontUnit}</dimen>` })
      if (v.text.lineHeight !== null) resources.push({ type: 'dimen', name: `${name}_line_height`, line: `<dimen name="${name}_line_height">${numberText(v.text.lineHeight)}${options.fontUnit}</dimen>` })
      notes.push(`${e.t.name}: Android resources carry its size and line height; its family, weight and letter spacing are in the compose output`)
    } else {
      skipped.push({ token: e.t.name, why: `is a ${e.type}, which has no Android value resource; the compose output carries it` })
    }
  }
  return { resources, skipped, notes }
}

// Names the module already declares that the output would declare again:
// [{ type, name, file }]. `owned` are files massimo wrote, left out.
export function resourceClashes(root, resDir, resources, owned = new Set()) {
  const out = []
  const wanted = new Map(resources.filter((r) => !r.night).map((r) => [`${r.type}:${r.name}`, r]))
  for (const file of moduleValueFiles(root, resDir)) {
    if (owned.has(file) || /\/massimo_tokens\.xml$/.test(file)) continue
    let text = ''
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    for (const r of xmlResources(text)) {
      const type = r.type === 'dimen' || r.type === 'color' || r.type === 'integer' ? r.type : null
      if (type && wanted.has(`${type}:${r.name}`)) out.push({ type, name: r.name, file })
    }
  }
  return out
}

// The files, as { path, text }: values/ always, values-night/ when a colour changes in the dark.
export function buildAndroidXml(plan, resDir, header) {
  const dir = resDir.replace(/\/+$/, '')
  const files = [{ path: `${dir}/values/massimo_tokens.xml`, text: xmlFile(header, plan.resources.filter((r) => !r.night).map((r) => r.line)) }]
  const night = plan.resources.filter((r) => r.night)
  if (night.length > 0) files.push({ path: `${dir}/values-night/massimo_tokens.xml`, text: xmlFile(header, night.map((r) => r.line)) })
  return files
}
