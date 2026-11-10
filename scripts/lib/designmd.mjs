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

// ── Reading a DESIGN.md ─────────────────────────────────────────────────────

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// One YAML scalar, or undefined (with a problem) for what the subset does not
// hold: a flow collection, a block scalar, an anchor, an alias or a tag.
function yamlValue(raw, line, problems) {
  const s = raw.trim()
  if (s.startsWith('"')) {
    const m = /^"(?:\\.|[^"\\])*"/.exec(s)
    try {
      if (m) return JSON.parse(m[0])
    } catch {
      // falls through to the problem below
    }
    problems.push({ line, message: `a double-quoted value that does not close or escape cleanly: ${s}` })
    return undefined
  }
  if (s.startsWith("'")) {
    const m = /^'((?:''|[^'])*)'/.exec(s)
    if (m) return m[1].replace(/''/g, "'")
    problems.push({ line, message: `a single-quoted value that does not close: ${s}` })
    return undefined
  }
  const plain = s.replace(/\s+#.*$/, '')
  if (/^[[{|>&*!]/.test(plain)) {
    problems.push({ line, message: `"${plain}" is YAML this reader leaves out (a flow collection, a block scalar, an anchor, an alias or a tag)` })
    return undefined
  }
  if (plain === 'true' || plain === 'false') return plain === 'true'
  if (plain === 'null' || plain === '~' || plain === '') return null
  if (/^-?\d+(?:\.\d+)?$/.test(plain)) return Number(plain)
  return plain
}

// The front matter as data: nested maps, lists of scalars, quoted and plain
// scalars and `#` comments, the subset DESIGN.md uses. What the subset cannot
// hold is named in `problems` with its line, and left out rather than
// guessed. `first` is the line number of the text's first line.
export function readYaml(text, problems = [], first = 1) {
  const lines = []
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*(?:#.*)?$/.test(raw)) return
    lines.push({ line: first + i, indent: raw.length - raw.trimStart().length, text: raw.trim() })
  })
  let at = 0
  const block = (indent) => {
    const isList = lines[at].text.startsWith('- ') || lines[at].text === '-'
    const out = isList ? [] : {}
    while (at < lines.length && lines[at].indent === indent) {
      const { line, text: t } = lines[at]
      at++
      if (isList) {
        const item = t.replace(/^-\s*/, '')
        if (!item.startsWith('- ') && /^(?:"[^"]*"|'[^']*'|[^\s"'#][^:#]*?)\s*:(?:\s|$)/.test(item)) problems.push({ line, message: 'a list of maps, which this reader leaves out' })
        else {
          const v = yamlValue(item, line, problems)
          if (v !== undefined) out.push(v)
        }
        while (at < lines.length && lines[at].indent > indent) at++
        continue
      }
      const m = /^("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\s"'#][^:#]*?)\s*:(?:\s+(.*))?$/.exec(t)
      if (!m) {
        problems.push({ line, message: `"${t}" is not a key and a value` })
        while (at < lines.length && lines[at].indent > indent) at++
        continue
      }
      const key = /^["']/.test(m[1]) ? yamlValue(m[1], line, problems) : m[1]
      const rest = (m[2] ?? '').replace(/^#.*$/, '').trim()
      if (rest) {
        const v = yamlValue(rest, line, problems)
        if (v !== undefined) out[key] = v
        while (at < lines.length && lines[at].indent > indent) at++
      } else if (at < lines.length && lines[at].indent > indent) {
        out[key] = block(lines[at].indent)
      } else {
        out[key] = null
      }
    }
    if (at < lines.length && lines[at].indent > indent) {
      problems.push({ line: lines[at].line, message: 'a line indented deeper than the block it sits in' })
      while (at < lines.length && lines[at].indent > indent) at++
    }
    return out
  }
  const out = {}
  while (at < lines.length) {
    const value = block(lines[at].indent)
    if (isMap(value)) Object.assign(out, value)
    else problems.push({ line: lines[0].line, message: 'the front matter is a list, not a map' })
  }
  return out
}

// Every leaf under a map, as [path, value].
function yamlLeaves(tree, path = []) {
  const out = []
  for (const [k, v] of Object.entries(tree)) {
    if (isMap(v)) out.push(...yamlLeaves(v, [...path, k]))
    else out.push([[...path, k], v])
  }
  return out
}

// A DESIGN.md read back: its front matter's tokens and the rules its prose
// gives components, for adopt's inventory and as a source extract can read.
// Returns
//   { version, name, description, tokens, components, rules, sections, problems }
// `tokens` is [{ path, value }] for every leaf of every token group (colors,
// typography, rounded, spacing and any other map), the group first in the
// path. `components` is [{ name, properties, useWhen, never }]: the front
// matter's `components` map, the Components section's `- **Name**: text`
// lines, and the Do's and Don'ts section's `- Don't, in Name: text` lines.
// `rules` holds every other bullet of those two sections as { section, text }.
export function readDesignMd(text) {
  const problems = []
  const fence = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!fence) problems.push({ line: 1, message: 'there is no front matter between --- lines, so no tokens' })
  const front = fence ? readYaml(fence[1], problems, 2) : {}
  const scalar = (v) => (v === undefined || v === null || isMap(v) || Array.isArray(v) ? null : String(v))
  const tokens = []
  const components = []
  const component = (name) => {
    let c = components.find((x) => x.name === name)
    if (!c) {
      c = { name, properties: {}, useWhen: null, never: null }
      components.push(c)
    }
    return c
  }
  for (const [group, tree] of Object.entries(front)) {
    if (group === 'components') {
      if (isMap(tree)) for (const [name, props] of Object.entries(tree)) component(name).properties = isMap(props) ? props : {}
    } else if (isMap(tree)) {
      for (const [path, value] of yamlLeaves(tree)) tokens.push({ path: [group, ...path], value })
    }
  }
  const sections = []
  const rules = []
  const body = fence ? text.slice(fence[0].length) : text
  let section = null
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      section = heading[1]
      sections.push(section)
      continue
    }
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line)
    if (!bullet || !/^(?:Components|Do's and Don'ts|Dos and Don'ts)$/i.test(section ?? '')) continue
    const use = /^\*\*(.+?)\*\*\s*:\s*(.+)$/.exec(bullet[1])
    const dont = /^Don['\u2019]t,\s*in\s+(.+?):\s*(.+)$/.exec(bullet[1])
    if (/^Components$/i.test(section) && use) component(use[1]).useWhen = use[2]
    else if (dont) component(dont[1]).never = dont[2]
    else rules.push({ section, text: bullet[1] })
  }
  return { version: scalar(front.version), name: scalar(front.name), description: scalar(front.description), tokens, components, rules, sections, problems }
}
