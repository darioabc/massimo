// Design-system graph generator: reads the component source once and writes
// graph.md (one file a fresh agent can read to learn what the component system
// contains) and graph.json (the same facts for tools).
//
// Every node records what it composes, who composes it, which story covers it,
// which packages, tokens and class-library parts it leans on, the `ds:` rules it
// declares in its own header, and the ticket ids found in the file. Nothing is
// authored by hand, and the output is deterministic (sorted, no timestamps),
// so `--check` is a byte comparison a CI job can run.
//
// Usage:
//   node <project>/scripts/graph.mjs            write graph.md and graph.json
//   node <project>/scripts/graph.mjs --check    regenerate in memory, exit 1 if stale
// Shared flags: --root <dir> --config <file> --project-dir <dir>

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compare, compileGlobs, expandGlobs, walk } from './lib/glob.mjs'
import { fail, loadConfig, parseArgs, readJson, rel, scriptCommand, warnIfVendoredOlder } from './lib/project.mjs'
import {
  classLibraries,
  componentName,
  createResolver,
  extractExports,
  extractImports,
  extractRules,
  isStoryFile,
  isTestFile,
  parseCustomProperties,
  stringLiterals,
  stripComments,
} from './lib/source.mjs'
import { readTokenSource } from './lib/dtcg.mjs'
import { callSiteUsage, componentProps, componentStates } from './lib/props.mjs'
import { natural, truthy } from './lib/text.mjs'

const COLOR_UTILITIES = 'bg|text|border|ring|outline|fill|stroke|from|via|to|divide|placeholder|caret|accent|decoration|shadow'
const STORY_EXTS = /\.(?:tsx?|jsx?|mjs|vue|svelte|astro|mdx?)$/
const CODE_EXTS = /\.(?:tsx?|jsx?|mjs|cjs|mts|cts|vue|svelte|astro)$/
const TOKEN_GROUPS = ['color', 'spacing', 'radius', 'font', 'text', 'shadow', 'other']

const MAX_COMPONENT_LIST = 40
const MAX_FILE_LIST = 12
const MAX_STORY_LIST = 3
const STORY_QUEUE_MD = 20
const UNRESOLVED_MD = 30

const lower = (s) => s.toLowerCase()
const byName = (a, b) => compare(lower(a), lower(b)) || compare(a, b)

const sortedUnique = (iterable, cmp = compare) => [...new Set(iterable)].sort(cmp)

// The component root a class token names in a class library (`btn-primary`
// -> `btn`), or null. A bare root counts only where the string is plainly a
// class list; a utility the library lists as not a root never counts.
function rootOf(lib, token, classy) {
  if (lib.rootSet.has(token)) return classy ? token : null
  for (const root of lib.byLength) {
    if (token.startsWith(`${root}-`)) return lib.notRoots.some((re) => re.test(token)) ? null : root
  }
  return null
}

// Text just before a string that marks it as a class list (`className="`,
// `cn(`, `clsx([`...), and a token that can only be a class (`gap-2`, `md:flex`).
const CLASS_CONTEXT = /(?:\bclass(?:Name)?|classList|class:list|\btw)\s*[=:]\s*\{?\s*\[?\s*[`'"]?$|\b(?:cn|clsx|cx|twMerge|classNames|cva|tv)\s*\(\s*\[?\s*$/
const CLASS_LIKE = /[-:/\[\]]/

// A sentence, not a class list: punctuation followed by a space or the end.
const isProse = (text) => /[.,!?;](?:\s|$)/.test(text.replace(/\$\{[^}]*\}/g, ' ').trim())

// `hover:!btn-primary` -> `btn-primary`
const bareClass = (raw) => raw.slice(raw.lastIndexOf(':') + 1).replace(/^!|!$/g, '')

// Area a non-node importer is grouped under: the first directory under `src/`,
// or the first directory of the path when there is no `src/`.
function areaOf(file) {
  const parts = file.replace(/^src\//, '').split('/')
  return parts.length > 1 ? parts[0] : 'root'
}

// Unique display names: basename, `index` -> parent directory, and duplicates
// prefixed with as many parent directories as it takes to tell them apart.
function assignNames(files) {
  const logical = (f) => {
    const noExt = f.replace(/\.[^./]+$/, '')
    const parts = noExt.split('/')
    if (parts[parts.length - 1] === 'index' && parts.length > 1) parts.pop()
    return parts
  }
  const names = new Map()
  const groups = new Map()
  for (const f of files) {
    const name = componentName(f)
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(f)
  }
  for (const [name, group] of groups) {
    if (group.length === 1) {
      names.set(group[0], name)
      continue
    }
    let depth = 2
    let resolved = false
    const maxDepth = Math.max(...group.map((f) => logical(f).length))
    for (; depth <= maxDepth && !resolved; depth++) {
      const candidate = group.map((f) => logical(f).slice(-depth).join('/'))
      if (new Set(candidate).size === group.length) {
        group.forEach((f, i) => names.set(f, candidate[i]))
        resolved = true
      }
    }
    if (!resolved) group.forEach((f) => names.set(f, f))
  }
  return names
}


function tokenGroup(name) {
  const first = name.replace(/^--/, '').split('-')[0]
  return TOKEN_GROUPS.includes(first) && first !== 'other' ? first : 'other'
}

// Everything the graph needs, computed from source. Pure apart from reads:
// returns { json, markdown, warnings } so --check and tests can reuse it.
// A component's props with how its call sites use them, and the states it styles.
function propsAndStates(source, file, name, importers) {
  const own = componentProps(source, file, componentName(file))
  const usage = callSiteUsage(componentName(file), importers)
  const props = own.map((p) => (usage[p.name] ? { ...p, usage: usage[p.name] } : p))
  for (const [prop, values] of Object.entries(usage)) {
    if (!own.some((p) => p.name === prop)) props.push({ name: prop, from: 'usage', usage: values })
  }
  props.sort((a, b) => compare(a.name, b.name))
  return { props, states: componentStates(source, props) }
}

export function buildGraph(root, config, command = "graph.mjs") {
  const warnings = []
  const all = walk(root, { ignore: config.ignore })
  const storyGlob = compileGlobs(config.stories.include)
  const isStory = (f) => storyGlob(f) || (isStoryFile(f) && STORY_EXTS.test(f))

  const nodeFiles = expandGlobs(root, config.components.include, config.components.exclude, config.ignore, all).filter(
    (f) => !isStory(f) && !isTestFile(f),
  )
  const nodeSet = new Set(nodeFiles)
  const storyFiles = all.filter(isStory)
  const consumerFiles = expandGlobs(root, config.consumers, [], config.ignore, all).filter(
    (f) => !isStory(f) && !isTestFile(f) && !nodeSet.has(f),
  )

  const resolveImport = createResolver(root, config)
  const nameOf = assignNames(nodeFiles)

  // Parse a file once: its resolved imports and, lazily, its exports.
  const infoCache = new Map()
  function infoOf(file) {
    let info = infoCache.get(file)
    if (info !== undefined) return info
    info = null
    if (CODE_EXTS.test(file)) {
      const source = readFileSync(join(root, file), 'utf8')
      const edges = []
      const unresolved = []
      const packages = []
      const reexports = []
      for (const imp of extractImports(source, file)) {
        const hit = resolveImport(file, imp.spec)
        if (hit.unresolved) unresolved.push(hit.unresolved)
        if (imp.typeOnly) continue
        if (hit.pkg) packages.push(hit.pkg)
        if (!hit.file) continue
        if (imp.kind === 'export-from') reexports.push({ file: hit.file, ...imp.reexport })
        else edges.push({ file: hit.file, names: imp.names })
      }
      let exportsCache = null
      info = { edges, unresolved, packages, reexports, exportNames: () => (exportsCache ??= extractExports(source, file)) }
    }
    infoCache.set(file, info)
    return info
  }

  // Which graph nodes does importing `names` from `target` reach? The target
  // itself when it is a node, plus whatever a barrel file re-exports under
  // those names.
  function reach(target, names) {
    const out = new Set()
    const seen = new Set()
    const visit = (file, wanted, depth) => {
      if (nodeSet.has(file)) out.add(file)
      if (depth > 4 || seen.has(file)) return
      seen.add(file)
      const info = infoOf(file)
      if (!info) return
      const wantsAll = wanted.includes('*')
      for (const r of info.reexports) {
        if (r.ns) {
          if (wantsAll || wanted.includes(r.ns)) visit(r.file, ['*'], depth + 1)
        } else if (r.star) {
          const known = infoOf(r.file)?.exportNames() ?? []
          const exposed = [...known, componentName(r.file)]
          if (wantsAll || wanted.some((n) => exposed.includes(n))) visit(r.file, wanted, depth + 1)
        } else {
          const hit = r.pairs.filter((p) => wantsAll || wanted.includes(p.name))
          if (hit.length > 0) visit(r.file, hit.map((p) => p.orig), depth + 1)
        }
      }
    }
    visit(target, names, 0)
    return out
  }

  // Importer -> nodes it uses, for nodes and consumers; story -> nodes it covers.
  const importersOf = new Map(nodeFiles.map((f) => [f, new Set()]))
  const composes = new Map(nodeFiles.map((f) => [f, new Set()]))
  const packages = new Map(nodeFiles.map((f) => [f, new Set()]))
  const unresolved = new Map()
  for (const file of [...nodeFiles, ...consumerFiles]) {
    const info = infoOf(file)
    if (!info) continue
    for (const spec of info.unresolved) {
      if (!unresolved.has(spec)) unresolved.set(spec, new Set())
      unresolved.get(spec).add(file)
    }
    if (nodeSet.has(file)) for (const pkg of info.packages) packages.get(file).add(pkg)
    for (const edge of info.edges) {
      for (const target of reach(edge.file, edge.names)) {
        if (target === file) continue
        importersOf.get(target).add(file)
        if (nodeSet.has(file)) composes.get(file).add(target)
      }
    }
  }

  const storiesOf = new Map(nodeFiles.map((f) => [f, new Set()]))
  const stemOf = (f) => f.replace(/\.(?:stories|story)\.[^./]+$/, '')
  const nodeByStem = new Map(nodeFiles.map((f) => [f.replace(/\.[^./]+$/, ''), f]))
  for (const story of storyFiles) {
    const info = infoOf(story)
    if (info) {
      for (const spec of info.unresolved) {
        if (!unresolved.has(spec)) unresolved.set(spec, new Set())
        unresolved.get(spec).add(story)
      }
      for (const edge of info.edges) for (const target of reach(edge.file, edge.names)) storiesOf.get(target)?.add(story)
    }
    const sibling = nodeByStem.get(stemOf(story))
    if (sibling) storiesOf.get(sibling).add(story)
  }

  // Style harvesting reads the colour names the styleFiles define.
  const styleFiles = expandGlobs(root, config.tokens.styleFiles, [], config.ignore, all)
  const customProps = []
  for (const f of styleFiles) {
    customProps.push(...parseCustomProperties(readFileSync(join(root, f), 'utf8'), f))
  }
  const libraries = classLibraries(config).map((lib) => ({
    ...lib,
    rootSet: new Set(lib.roots),
    byLength: [...lib.roots].sort((a, b) => b.length - a.length || compare(a, b)),
  }))
  const colorNames = sortedUnique([
    ...customProps.map((p) => /^--color-([\w-]+)$/.exec(p.name)?.[1]).filter(Boolean),
    ...libraries.flatMap((lib) => lib.colors),
  ])
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const colorRe = colorNames.length
    ? new RegExp(
        `^(?:${COLOR_UTILITIES})-(?:[trblxyse]-)?(${[...colorNames].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?:/.+)?$`,
      )
    : null

  const ticketRe = config.ticketPattern ? new RegExp(config.ticketPattern, 'g') : null
  const faults = []

  // Call sites are read once each, however many components they use.
  const textOf = new Map()
  const text = (f) => {
    if (!textOf.has(f)) textOf.set(f, readFileSync(join(root, f), 'utf8'))
    return textOf.get(f)
  }
  const nodes = nodeFiles.map((file) => {
    const source = readFileSync(join(root, file), 'utf8')
    const code = stripComments(source, file)
    const classes = Object.fromEntries(libraries.map((lib) => [lib.id, new Set()]))
    const tokens = new Set()
    for (const { text, start } of stringLiterals(code, file)) {
      if (isProse(text)) continue
      const words = text.split(/[\s"'`{}(),;]+/).filter(Boolean).map(bareClass)
      if (words.length === 0) continue
      // A bare word like `label` or `list` is only a class when the string is
      // plainly a class list; `btn-primary`-style tokens always count.
      const classy = CLASS_CONTEXT.test(code.slice(Math.max(0, start - 48), start)) || words.some(CLASS_LIKE.test, CLASS_LIKE)
      for (const token of words) {
        for (const lib of libraries) {
          const component = rootOf(lib, token, classy)
          if (component) classes[lib.id].add(component)
        }
        const m = colorRe?.exec(token)
        if (m) tokens.add(m[1])
      }
    }
    const cssVars = new Set()
    for (const m of code.matchAll(/var\(\s*(--[\w-]+)/g)) if (!m[1].startsWith('--tw-')) cssVars.add(m[1])
    const header = extractRules(source, config.graph?.extraKeys ?? [])
    for (const key of header.unknown) {
      warnings.push(`${file}: unknown header key "ds:${key}"`)
      faults.push({ file, key: `ds:${key}` })
    }
    const { group: groupValue, 'no-story': noStory, ...rules } = header.rules
    const groupParts = (groupValue ?? '').split('/').map((p) => p.trim()).filter(Boolean)
    const decisions = ticketRe ? sortedUnique(source.match(ticketRe) ?? [], natural) : []
    const composedBy = {}
    for (const importer of sortedUnique(importersOf.get(file))) {
      const area = nodeSet.has(importer) ? 'components' : areaOf(importer)
      ;(composedBy[area] ??= []).push(importer)
    }
    const sortedAreas = {}
    for (const area of Object.keys(composedBy).sort(compare)) sortedAreas[area] = composedBy[area]
    return {
      name: nameOf.get(file),
      file,
      tier: groupParts[0] ?? null,
      group: groupParts.length > 0 ? groupParts.join(' / ') : null,
      noStory: noStory ?? null,
      stories: sortedUnique(storiesOf.get(file)),
      exports: extractExports(source, file),
      composes: [...composes.get(file)].map((f) => nameOf.get(f)).sort(byName),
      composedBy: sortedAreas,
      usage: importersOf.get(file).size,
      ...propsAndStates(source, file, nameOf.get(file), [...importersOf.get(file)].map((f) => ({ file: f, text: text(f) }))),
      packages: sortedUnique(packages.get(file)),
      style: {
        classes: Object.fromEntries(Object.entries(classes).filter(([, set]) => set.size > 0).map(([id, set]) => [id, sortedUnique(set)])),
        tokens: sortedUnique(tokens),
        cssVars: sortedUnique(cssVars),
      },
      rules,
      decisions,
    }
  })
  nodes.sort((a, b) => byName(a.name, b.name) || compare(a.file, b.file))

  const withStory = nodes.filter((n) => n.stories.length > 0).length
  const noStory = nodes.filter((n) => n.stories.length === 0 && n.noStory !== null).length
  const storyQueue = nodes
    .filter((n) => n.stories.length === 0 && n.noStory === null)
    .map((n) => ({ name: n.name, file: n.file, usage: n.usage }))
    .sort((a, b) => b.usage - a.usage || byName(a.name, b.name))

  const tokenNames = sortedUnique(customProps.map((p) => p.name).filter((n) => !n.startsWith('--tw-')))
  const groups = Object.fromEntries(TOKEN_GROUPS.map((g) => [g, []]))
  for (const name of tokenNames) groups[tokenGroup(name)].push(name)
  let dtcg = null
  try {
    const set = readTokenSource(root, config)
    if (set) dtcg = { path: config.tokens.source, count: set.tokens.length }
  } catch (err) {
    warnings.push(err.message)
  }

  const unresolvedMap = {}
  for (const spec of [...unresolved.keys()].sort(compare)) unresolvedMap[spec] = [...unresolved.get(spec)].sort(compare)
  const rulesNodes = nodes.filter((n) => Object.keys(n.rules).length > 0).map((n) => n.name)

  const json = {
    version: 1,
    generatedBy: 'massimo graph',
    summary: {
      components: nodes.length,
      withStory,
      withoutStory: nodes.length - withStory - noStory,
      noStory,
      tokens: tokenNames.length,
      nodesWithRules: rulesNodes.length,
      unresolvedImports: Object.keys(unresolvedMap).length,
      headerFaults: faults.length,
    },
    tokens: {
      styleFiles,
      total: tokenNames.length,
      groups: Object.fromEntries(Object.entries(groups).filter(([, v]) => v.length > 0)),
      dtcg,
    },
    storyQueue,
    nodes,
    unresolved: unresolvedMap,
    faults: faults.sort((a, b) => compare(a.file, b.file) || compare(a.key, b.key)),
  }
  return { json, markdown: renderMarkdown(json, rulesNodes, command), warnings }
}

const code = (s) => `\`${s}\``

const TIER_ORDER = ['Foundations', 'Primitives', 'Patterns', 'Shells', 'Pages', 'Explorations']
const tierRank = (tier) => {
  const i = TIER_ORDER.indexOf(tier)
  return i === -1 ? TIER_ORDER.length : i
}

// One line per node, grouped by tier then group; nodes without `ds:group` come last.
function renderIndex(nodes) {
  const buckets = new Map()
  for (const n of nodes) {
    const key = n.group ?? 'Ungrouped'
    if (!buckets.has(key)) buckets.set(key, { tier: n.tier, nodes: [] })
    buckets.get(key).nodes.push(n)
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === 'Ungrouped' || b === 'Ungrouped') return (a === 'Ungrouped') - (b === 'Ungrouped')
    const ta = buckets.get(a).tier
    const tb = buckets.get(b).tier
    return tierRank(ta) - tierRank(tb) || compare(ta, tb) || compare(a, b)
  })
  const out = []
  for (const key of keys) {
    out.push(`**${key}**`, '')
    for (const n of buckets.get(key).nodes) {
      const story = n.stories.length > 0 ? 'story ✓' : n.noStory !== null ? 'no-story' : 'story ✗'
      out.push(`- ${n.name}: ${story} · used by ${n.usage}`)
    }
    out.push('')
  }
  return out
}

function listWithCap(items, cap) {
  return items.length > cap ? `${items.slice(0, cap).join(', ')}, +${items.length - cap} more` : items.join(', ')
}

function renderNode(node, nameByFile) {
  const lines = [`### ${node.name}`]
  const head = [`file ${code(node.file)}`]
  if (node.stories.length === 0) head.push(node.noStory === null ? 'no story' : `no story on purpose${node.noStory ? `: ${node.noStory}` : ''}`)
  else head.push(`${node.stories.length > 1 ? 'stories' : 'story'} ${listWithCap(node.stories.map(code), MAX_STORY_LIST)}`)
  if (node.exports.length > 0) head.push(`exports ${node.exports.join(', ')}`)
  lines.push(`- ${head.join(' · ')}`)
  lines.push(
    `- used by ${node.usage} ${node.usage === 1 ? 'file' : 'files'} · composes: ${node.composes.length > 0 ? node.composes.join(', ') : 'none'}`,
  )
  const areas = Object.entries(node.composedBy).map(([area, files]) => {
    if (area === 'components') {
      const names = files.map((f) => nameByFile.get(f)).sort(byName)
      return `${area} (${files.length}): ${listWithCap(names, MAX_COMPONENT_LIST)}`
    }
    return `${area} (${files.length}): ${listWithCap(files, MAX_FILE_LIST)}`
  })
  lines.push(`- composed by: ${areas.length > 0 ? areas.join(' · ') : 'none'}`)
  if (node.packages.length > 0) lines.push(`- packages: ${node.packages.join(', ')}`)
  const style = []
  for (const [id, roots] of Object.entries(node.style.classes)) style.push(`${id} ${roots.join(', ')}`)
  if (node.style.tokens.length > 0) style.push(`tokens ${node.style.tokens.join(', ')}`)
  if (node.style.cssVars.length > 0) style.push(`vars ${node.style.cssVars.join(', ')}`)
  if (style.length > 0) lines.push(`- style: ${style.join(' · ')}`)
  if (node.props?.length > 0) {
    const describe = (p) => {
      const bits = []
      if (p.values) bits.push(p.values.join(' | '))
      if (p.default !== undefined) bits.push(`default ${p.default === '' ? '""' : p.default}`)
      if (p.usage) bits.push(`used ${Object.entries(p.usage).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ×${n}`).join(', ')}`)
      if (p.kind) bits.push(p.kind)
      return bits.length > 0 ? `${p.name} (${bits.join('; ')})` : p.name
    }
    lines.push(`- props: ${node.props.map(describe).join(' · ')}`)
  }
  if (node.states?.length > 0) lines.push(`- states: ${node.states.join(', ')}`)
  const rules = Object.entries(node.rules).map(([k, v]) => `${k} ${v}`)
  if (node.group) rules.unshift(`group ${node.group}`)
  if (rules.length > 0) lines.push(`- rules: ${rules.join(' · ')}`)
  if (node.decisions.length > 0) lines.push(`- decisions: ${node.decisions.join(', ')}`)
  return lines.join('\n')
}

function renderMarkdown(json, rulesNodes, command) {
  const { summary, tokens, storyQueue, nodes, unresolved, faults } = json
  const nameByFile = new Map(nodes.map((n) => [n.file, n.name]))
  const out = []
  out.push('# Design-system graph', '')
  out.push(`<!-- Generated by massimo graph. Do not edit by hand. Regenerate: ${command} -->`, '')
  out.push('How to read a node:', '')
  out.push('1. `composes` lists the graph nodes the file imports; `composed by` lists who imports it, grouped by area with counts. Stories and tests are not counted. Long lists end in `+N more`; `graph.json` has them all.')
  out.push('2. `style` lists the component classes of a class library such as DaisyUI, the theme colour tokens and the custom properties (`var(--x)`) the file references.')
  out.push('3. `decisions` are the ticket ids found in the file; open the ticket or the file header for the why.')
  out.push('4. `rules` are declared in the file itself as comment lines: `ds:group Tier / Group`, `ds:parents`, `ds:children`, `ds:never`, `ds:use-when`. `ds:no-story <reason>` marks a component that has no story on purpose. A value may wrap onto the comment lines after it.', '')

  out.push('## Summary', '')
  const intentional = summary.noStory > 0 ? `, ${summary.noStory} without on purpose` : ''
  out.push(`1. Components: ${summary.components} (${summary.withStory} with a story, ${summary.withoutStory} without${intentional}).`)
  const dtcg = tokens.dtcg ? `; ${tokens.dtcg.count} in ${code(tokens.dtcg.path)}` : ''
  out.push(`2. Tokens: ${summary.tokens} custom properties in ${tokens.styleFiles.length} style ${tokens.styleFiles.length === 1 ? 'file' : 'files'}${dtcg}.`)
  out.push(`3. Nodes carrying \`ds:\` rules: ${rulesNodes.length > 0 ? rulesNodes.join(', ') : 'none'}.`)
  out.push(`4. Unresolved imports: ${summary.unresolvedImports}${summary.unresolvedImports > 0 ? ' (listed below; fix them with `aliases` in massimo.config.json)' : ''}.`)
  out.push(`5. Header faults: ${summary.headerFaults}${summary.headerFaults > 0 ? ' (listed below)' : ''}.`, '')

  if (faults.length > 0) {
    out.push('## Header faults', '')
    out.push('A `ds:` key the graph does not know, so its value was ignored. Known keys: `ds:group`, `ds:no-story`, `ds:parents`, `ds:children`, `ds:never`, `ds:use-when`.', '')
    for (const f of faults) out.push(`- ${code(f.file)} · ${code(f.key)}`)
    out.push('')
  }

  out.push('## Index', '')
  out.push('One line per component, grouped by tier and group from each file\'s `ds:group` line.', '')
  out.push(...renderIndex(nodes))

  out.push('## Story queue', '')
  if (storyQueue.length === 0) {
    out.push('Every component has a story or is marked `ds:no-story`.', '')
  } else {
    out.push(`Components without a story and not marked \`ds:no-story\`, most used first (${Math.min(STORY_QUEUE_MD, storyQueue.length)} of ${storyQueue.length}).`, '')
    storyQueue.slice(0, STORY_QUEUE_MD).forEach((n, i) => out.push(`${i + 1}. ${n.name} · ${n.usage} ${n.usage === 1 ? 'file' : 'files'} · ${code(n.file)}`))
    out.push('')
  }

  out.push('## Tokens', '')
  if (tokens.styleFiles.length === 0) {
    out.push('No style files configured (`tokens.styleFiles`).', '')
  } else {
    out.push(`Defined in ${tokens.styleFiles.map(code).join(', ')}.`, '')
    for (const [group, names] of Object.entries(tokens.groups)) out.push(`- ${group} (${names.length}): ${names.join(', ')}`)
    out.push('')
  }

  const specs = Object.keys(unresolved)
  if (specs.length > 0) {
    out.push('## Unresolved imports', '')
    out.push(`${specs.length} relative or alias ${specs.length === 1 ? 'import points' : 'imports point'} at nothing, so the edges through them are missing from the graph.`, '')
    for (const spec of specs.slice(0, UNRESOLVED_MD)) {
      const files = unresolved[spec]
      out.push(`- ${code(spec)} · ${files.length} ${files.length === 1 ? 'file' : 'files'}: ${listWithCap(files, 3)}`)
    }
    if (specs.length > UNRESOLVED_MD) out.push(`- +${specs.length - UNRESOLVED_MD} more in graph.json`)
    out.push('')
  }

  out.push('## Components', '')
  if (nodes.length === 0) out.push('No files matched `components.include`.', '')
  for (const node of nodes) out.push(renderNode(node, nameByFile), '')
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set(['check'])

function main() {
  const argv = process.argv.slice(2).map((a) => (a.startsWith('--') && BOOLEAN_FLAGS.has(a.slice(2)) ? `${a}=true` : a))
  const { flags } = parseArgs(argv)
  const { root, config, projectDir } = loadConfig(flags)
  warnIfVendoredOlder(projectDir, import.meta.url)
  const { json, markdown, warnings } = buildGraph(root, config, scriptCommand(root, projectDir, 'graph'))
  if (json.faults.length > 0 && !truthy(flags.check)) {
    process.stderr.write(`massimo graph: ${json.faults.length} header ${json.faults.length === 1 ? 'fault' : 'faults'}; see "Header faults" in graph.md\n`)
  }
  for (const w of warnings.filter((w) => !w.includes('unknown header key'))) process.stderr.write(`massimo graph: ${w}\n`)
  if (json.nodes.length === 0) {
    process.stderr.write('massimo graph: no files matched components.include; check the globs in massimo.config.json\n')
  }
  const files = [
    ['graph.md', markdown],
    ['graph.json', `${JSON.stringify(json, null, 2)}\n`],
  ]
  const shown = (name) => {
    const r = rel(root, join(projectDir, name))
    return r.startsWith('..') ? join(projectDir, name) : r
  }
  const s = json.summary
  const stats = `${s.components} components, ${s.withStory} with a story, ${s.unresolvedImports} unresolved imports`

  if (truthy(flags.check)) {
    const bad = []
    for (const [name, text] of files) {
      const path = join(projectDir, name)
      if (!existsSync(path)) bad.push(`${shown(name)} (missing)`)
      else if (readFileSync(path, 'utf8') !== text) bad.push(`${shown(name)} (stale)`)
    }
    if (bad.length > 0) {
      process.stderr.write(`massimo graph: out of date: ${bad.join(', ')}. Run: ${scriptCommand(root, projectDir, 'graph')}\n`)
      process.exit(1)
    }
    process.stdout.write(`massimo graph: up to date (${stats})\n`)
    return
  }
  mkdirSync(projectDir, { recursive: true })
  for (const [name, text] of files) writeFileSync(join(projectDir, name), text)
  process.stdout.write(`massimo graph: wrote ${shown('graph.md')} and graph.json (${stats})\n`)
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (entry === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}
