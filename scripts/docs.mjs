#!/usr/bin/env node
// The design system's README, for a person or an agent to read first: what
// the system holds, where the tokens live and how to change them, each
// component with its usage rule, the checks CI runs, and how to start a
// design. Generated between massimo:docs markers from the token set, the
// graph and the config; the sections around the markers are the team's own
// and are never touched.
//
//   docs.mjs           write <project>/README.md (the generated block only, when the file exists)
//   docs.mjs --check   exit 1 when the generated block is out of date
//
// Shared flags: --root, --config, --project-dir.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTokenSource } from './lib/dtcg.mjs'
import { fail, loadConfig, parseArgs, readJson, refuseNewer, rel, scriptCommand, warnIfVendoredOlder, writeFileAtomic } from './lib/project.mjs'
import { tierOrder } from './lib/roles.mjs'
import { isAlias } from './lib/source.mjs'
import { truthy } from './lib/text.mjs'

export const DOCS_START = '<!-- massimo:docs:start -->'
export const DOCS_END = '<!-- massimo:docs:end -->'

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const typeFamily = (t) => ({ color: 'Colour', dimension: 'Size and space', fontFamily: 'Type', fontWeight: 'Type', typography: 'Type', shadow: 'Shadow', border: 'Border', duration: 'Motion', cubicBezier: 'Motion', transition: 'Motion', number: 'Number', gradient: 'Gradient', strokeStyle: 'Border', css: 'CSS only' }[t] ?? 'Other')

// The generated block, as Markdown.
export function docsBlock({ root, config, projectDir }) {
  const lines = []
  const projectRel = rel(root, projectDir) || '.'
  const pkg = readJson(join(root, 'package.json'), {}) ?? {}
  const run = (name, npm, args = '') => (pkg.scripts?.[npm] ? `\`npm run ${npm}\`` : `\`${scriptCommand(root, projectDir, name, args)}\``)

  // Tokens.
  let set = null
  try {
    set = readTokenSource(root, config)
  } catch (err) {
    lines.push(`The token set could not be read: ${err.message}`, '')
  }
  lines.push('## Tokens', '')
  if (!set) {
    lines.push(`No token set yet. The tokens phase writes one in \`${config.tokens.source}\`.`, '')
  } else {
    const themes = [set.defaultMode ?? config.tokens.defaultMode ?? 'light', ...(set.modeOrder ?? [...new Set(set.tokens.flatMap((t) => Object.keys(t.modes)))])]
    const typeOf = new Map(set.tokens.map((t) => [t.name, t.type ?? t.groupType]))
    const resolveType = (t, depth = 0) => typeOf.get(t.name) ?? (isAlias(t.value) && depth < 8 ? resolveType(set.tokens.find((x) => `{${x.name}}` === t.value) ?? {}, depth + 1) : null)
    const counts = new Map()
    for (const t of set.tokens) counts.set(typeFamily(resolveType(t)), (counts.get(typeFamily(resolveType(t))) ?? 0) + 1)
    lines.push(
      `${set.tokens.length} tokens in \`${config.tokens.source}\` (${set.format === '2025.10' ? 'W3C Design Tokens 2025.10' : 'the format massimo wrote before 0.2.0'}), in ${themes.length === 1 ? 'one theme' : `${themes.length} themes: ${themes.join(', ')}`}. ${[...counts.entries()].map(([f, n]) => `${f} ${n}`).join(', ')}.`,
      '',
      `Change a value in the token files, then run ${run('tokens', 'ds:tokens', 'build')}. Never edit a generated file; each says where it comes from. Components read the semantic tokens below, not the raw values or the ramps.`,
      '',
    )
    const outputs = config.tokens.outputs ?? []
    if (outputs.length) lines.push(`Built into: ${outputs.map((o) => `\`${o.path}\` (${o.format})`).join(', ')}.`, '')
    const semantic = set.tokens.filter((t) => t.description)
    if (semantic.length) {
      lines.push('| Token | Means |', '|---|---|')
      for (const t of semantic) lines.push(`| \`${cell(t.name)}\` | ${cell(t.description)}${t.deprecated ? ` (deprecated${typeof t.deprecated === 'string' ? `: ${cell(t.deprecated)}` : ''})` : ''} |`)
      lines.push('')
    }
    const pairs = set.tokens.filter((t) => t.on)
    if (pairs.length) {
      lines.push(`Contrast is checked in every theme for ${pairs.length} ${pairs.length === 1 ? 'pair' : 'pairs'} (WCAG 2.2: text 4.5:1, large text, UI and focus 3:1): ${pairs.map((t) => `\`${t.name}\` on \`${t.on}\``).join(', ')}.`, '')
    }
  }

  // Components.
  const graph = readJson(join(projectDir, 'graph.json'), null)
  refuseNewer('graph', graph?.version, 'graph.json')
  lines.push('## Components', '')
  if (!graph) {
    lines.push(`No component graph yet. Generate it with ${run('graph', 'ds:graph')}.`, '')
  } else {
    const nodes = graph.nodes ?? []
    const ruled = nodes.filter((n) => n.rules?.['use-when'])
    lines.push(`${nodes.length} components, ${nodes.filter((n) => n.stories?.length).length} with a story, ${ruled.length} with a usage rule. The full map, with who uses what, is \`${projectRel}/graph.md\`.`, '')
    const byTier = new Map()
    for (const n of nodes.filter((x) => x.tier)) {
      if (!byTier.has(n.tier)) byTier.set(n.tier, [])
      byTier.get(n.tier).push(n)
    }
    // The same tier order as graph.md: the taxonomy's, or massimo's own.
    const order = tierOrder(config)
    const tiers = [...byTier.keys()].sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)))
    for (const tier of tiers) {
      lines.push(`### ${tier}`, '', '| Component | Use it when | Props |', '|---|---|---|')
      for (const n of byTier.get(tier)) {
        const props = (n.props ?? []).filter((p) => p.values).map((p) => `${p.name}: ${p.values.join(', ')}`).join('; ')
        lines.push(`| ${cell(n.name)} | ${cell(n.rules?.['use-when'] ?? 'no rule yet')} | ${cell(props)} |`)
      }
      lines.push('')
    }
    const untiered = nodes.filter((n) => !n.tier)
    if (untiered.length) lines.push(`${untiered.length} ${untiered.length === 1 ? 'component has' : 'components have'} no \`ds:group\` yet: ${untiered.slice(0, 12).map((n) => n.name).join(', ')}${untiered.length > 12 ? ', and more' : ''}.`, '')
  }

  // Checks, Figma, designing.
  lines.push('## Checks', '')
  if (pkg.scripts?.['ds:check']) lines.push(`\`npm run ds:check\` runs in CI: \`${pkg.scripts['ds:check']}\`. It fails on a stale graph, a raw value beyond the audit's baseline, or a generated token file that is out of date.`, '')
  else lines.push('No `ds:check` script yet; the guard phase adds one for CI.', '')
  const mirror = readJson(join(projectDir, 'figma', 'mirror.json'), null)
  if (mirror?.syncedAt) {
    lines.push('## Figma', '', `The Figma library${mirror.fileKey ? ` (file \`${mirror.fileKey}\`)` : ''} mirrors these tokens, last recorded on ${mirror.syncedAt}${mirror.modes === 'default only' ? ', default theme only' : ''}. Code is the source of truth; \`${projectRel}/figma/drift.md\` lists what has moved since.`, '')
  }
  lines.push('## Designing', '', 'Start a design with `/massimo:ux <topic>`: it reviews the surface or frames the idea, generates mockups in these tokens, and turns the pick into a story and a handoff.', '')
  return lines.join('\n').trimEnd()
}

// Put the block between the markers, keeping everything around them.
export function withBlock(current, block, title) {
  const wrapped = `${DOCS_START}\n${block}\n${DOCS_END}`
  if (current === null) {
    return `# ${title}\n\nHow this repo's design system works. The part between the massimo markers is generated (\`docs.mjs\`); write anything else around it.\n\n${wrapped}\n\n## Who decides what\n\nName who approves token values, who approves component APIs, and who signs off a design.\n`
  }
  const s = current.indexOf(DOCS_START)
  const e = current.indexOf(DOCS_END)
  if (s !== -1 && e > s) return current.slice(0, s) + wrapped + current.slice(e + DOCS_END.length)
  return `${current.trimEnd()}\n\n${wrapped}\n`
}

function main() {
  const { flags } = parseArgs()
  const { root, config, projectDir } = loadConfig(flags)
  warnIfVendoredOlder(projectDir, import.meta.url)
  const path = join(projectDir, 'README.md')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null
  const pkg = readJson(join(root, 'package.json'), {}) ?? {}
  const next = withBlock(current, docsBlock({ root, config, projectDir }), `${config.name ?? pkg.name ?? 'The'} design system`)
  const shown = rel(root, path)
  if (truthy(flags.check)) {
    if (next !== current) {
      process.stderr.write(`massimo docs: ${shown} is out of date. Run: ${scriptCommand(root, projectDir, 'docs')}\n`)
      process.exit(1)
    }
    process.stdout.write(`massimo docs: ${shown} is up to date\n`)
    return
  }
  if (next !== current) writeFileAtomic(path, next)
  process.stdout.write(`massimo docs: ${current === null ? 'wrote' : next === current ? 'nothing changed in' : 'refreshed the generated part of'} ${shown}\n`)
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (entry === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}
