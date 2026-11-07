// DESIGN.md, Google Labs' format for describing a design system to coding
// agents: YAML front matter with the tokens, then prose in fixed sections.
// The format is alpha, so massimo pins the version it writes: the front matter
// says `version: alpha`, as published in google-labs-code/design.md release
// 0.4.0 (2026-07-27). The format has no themes, so the file carries the
// default theme and its prose says where the others live.
//
// Spec: https://github.com/google-labs-code/design.md/blob/main/docs/spec.md

export const DESIGN_MD = { version: 'alpha', release: '0.4.0', released: '2026-07-27' }

// The prose sections, in the order the spec requires.
const SECTIONS = ['Overview', 'Colors', 'Typography', 'Layout', 'Elevation & Depth', 'Shapes', 'Components', "Do's and Don'ts"]

// ── A small YAML writer, enough for nested maps of strings and numbers ─────

const plainKey = /^[A-Za-z_][\w-]*$/
const yamlKey = (k) => (plainKey.test(k) ? k : JSON.stringify(k))
// Strings are always double-quoted (JSON's escaping is valid YAML), so a hex
// or a {reference} can never be read as a comment or a flow map.
const yamlScalar = (v) => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(String(v)))

export function yaml(value, indent = '') {
  const lines = []
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'object' && !Array.isArray(v)) {
      if (Object.keys(v).length === 0) continue
      lines.push(`${indent}${yamlKey(k)}:`, yaml(v, `${indent}  `))
    } else if (Array.isArray(v)) {
      lines.push(`${indent}${yamlKey(k)}:`, ...v.map((x) => `${indent}  - ${yamlScalar(x)}`))
    } else {
      lines.push(`${indent}${yamlKey(k)}: ${yamlScalar(v)}`)
    }
  }
  return lines.join('\n')
}

const setPath = (tree, path, value) => {
  let cur = tree
  path.slice(0, -1).forEach((k) => {
    if (typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  })
  cur[path[path.length - 1]] = value
}

// The document. `data` holds what tokens.mjs resolved:
//   name, source, defaultMode, otherModes, header,
//   colors / typography / rounded / spacing: [{ path, value, description }]
//   approximated: [{ name, css }], colours held here as their nearest sRGB hex
//   shadows: [{ name, css, description }], contrast: [{ token, on, needs, use }]
//   components: [{ name, useWhen, never }] from the graph, when there is one
export function designMd(data) {
  const front = { version: DESIGN_MD.version, name: data.name, description: data.description }
  for (const group of ['colors', 'typography', 'rounded', 'spacing']) {
    const tree = {}
    for (const t of data[group] ?? []) setPath(tree, t.path, t.value)
    if (Object.keys(tree).length > 0) front[group] = tree
  }
  const body = {}
  const themes = data.otherModes.length > 0
    ? ` The values here are the ${data.defaultMode} theme. DESIGN.md has no themes yet, so ${data.otherModes.join(', ')} live${data.otherModes.length === 1 ? 's' : ''} in code only: in ${data.source} and the CSS built from it.`
    : ''
  body.Overview = [`${data.name}'s design system, for people and coding agents. The tokens come from ${data.source}, the single source of truth; use them by name, never their raw values.${themes}`]
  const described = (list, prefix) => list.filter((t) => t.description).map((t) => `- \`${prefix}.${t.path.join('.')}\`: ${t.description}`)
  const colorLines = described(data.colors ?? [], 'colors')
  if (data.approximated?.length) {
    if (colorLines.length) colorLines.push('')
    colorLines.push('These colours are written in code in a form DESIGN.md does not read, so this file holds their nearest sRGB hex:', ...data.approximated.map((c) => `- \`${c.name}\`: ${c.css} in code`))
  }
  if (data.contrast?.length) {
    colorLines.push('', 'Pairs checked for contrast at WCAG 2.2 AA:', ...data.contrast.map((c) => `- \`${c.token}\` on \`${c.on}\`: at least ${c.needs}:1${c.use ? ` (${c.use})` : ''}`))
  }
  if (colorLines.length) body.Colors = colorLines
  const typeLines = described(data.typography ?? [], 'typography')
  if (typeLines.length) body.Typography = typeLines
  if (data.spacing?.length) body.Layout = [`The spacing scale: ${data.spacing.map((t) => `\`${t.path.join('.')}\` ${t.value}`).join(', ')}. Space between and inside elements comes from this scale.`]
  if (data.shadows?.length) body['Elevation & Depth'] = data.shadows.map((s) => `- \`${s.name}\`: ${s.css}${s.description ? `. ${s.description}` : ''}`)
  if (data.rounded?.length) body.Shapes = [`Corner radii: ${data.rounded.map((t) => `\`${t.path.join('.')}\` ${t.value}`).join(', ')}.`]
  const comps = (data.components ?? []).filter((c) => c.useWhen)
  if (comps.length) body.Components = comps.map((c) => `- **${c.name}**: ${c.useWhen}`)
  const nevers = (data.components ?? []).filter((c) => c.never)
  if (nevers.length) body["Do's and Don'ts"] = nevers.map((c) => `- Don't, in ${c.name}: ${c.never}`)

  const out = ['---', yaml(front), '---', '', `<!-- ${data.header} -->`, '', `# ${data.name}`, '']
  for (const s of SECTIONS) if (body[s]) out.push(`## ${s}`, '', ...body[s], '')
  return `${out.join('\n').trimEnd()}\n`
}
