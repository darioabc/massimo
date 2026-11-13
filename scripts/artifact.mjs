#!/usr/bin/env node
// The design system as a reader's folder: a brand book, tokens as lists, a
// page and a still preview per component, fonts, assets and the files the
// previews load. It follows the layout of a Claude design system artifact, in
// plain Markdown, JSON, HTML and CSS, so any agent, a person or a static host
// reads the same folder. This script builds and compares files; it never
// publishes, so the folder serves whichever tool does.
//
//   artifact.mjs pages      write the pages the project folder keeps: components/<Name>/README.md
//                           from the graph, and sections/<name>.md for the tokens the lists cannot hold
//   artifact.mjs pages --check
//                           exit 1 when a page is out of date; writes nothing
//   artifact.mjs plan       what a build would hold and leave out; writes nothing
//   artifact.mjs build      write <project>/artifact/project/, files.json and report.md
//   artifact.mjs record --url <url> [--target <name>]
//                           remember where the folder was published, from which tokens and graph
//   artifact.mjs status     whether what was published is behind the tokens or the graph
//
// The project folder holds the reader's side in the same shape the build
// publishes: README.md (the brand book), sections/*.md (further sections,
// the generated ones and any the team writes), components/<Name>/README.md,
// assets/<Group>/ and fonts/. build adds what differs in form: tokens.json as
// lists, a preview per component, and the files those previews load.
//
// build reads the token set, <project>/graph.json and a static build of the
// story lane, and runs nothing of the repo's. --built <dir> names the lane
// build (else artifact.built, else stories.outDir); with none, components
// get their page and no preview. A preview is the story's built page without
// its scripts, so a lane that draws its states in the browser gets a page
// and a note instead. --out <dir> writes somewhere other than
// <project>/artifact. --components "<tier or group>, ..." builds those tiers
// or groups only, over artifact.components, for a first, smaller folder.
//
// Files under <project>/artifact/kept/ are copied over the build as they are:
// a cover, an index, anything the tool that publishes needs. What the token
// lists cannot hold (motion, borders, gradients, CSS-only values) is written
// as sections of the brand book, never dropped.
//
// Shared flags: --root <dir> --config <file> --project-dir <dir>

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAGE_MARK, SECTION_MARK, builtPagePaths, componentId, componentReadme, contentTypeOf, fontFaces, isMedia, listTokens, previewFromPage, rewriteCssUrls, sectionsFor, themeScript } from './lib/artifact.mjs'
import { compare, expandGlobs } from './lib/glob.mjs'
import { SCRIPTS_VERSION, fail, loadConfig, parseArgs, readJson, rel, scriptCommand, today, warnIfVendoredOlder } from './lib/project.mjs'
import { truthy } from './lib/text.mjs'
import { helpAndExit } from './lib/help.mjs'
import { tokenEntries } from './tokens.mjs'

helpAndExit(import.meta.url)

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`
const FONT_CAP = 1024 * 1024

// The nodes that get a page: every node with a story, or the tiers and
// groups artifact.components names (a tier, or "Tier / Group").
function chosenNodes(graph, config) {
  const wanted = config.artifact?.components
  const named = Array.isArray(wanted) && wanted.length > 0 ? new Set(wanted.map((w) => String(w).trim())) : null
  const nodes = (graph?.nodes ?? []).filter((n) => {
    if (named) return named.has(n.tier ?? '') || named.has(n.group ?? '')
    return (n.stories?.length ?? 0) > 0
  })
  // Two nodes of one name take the second's folder into its own folder name.
  // Names that differ only by case count as one: a file system may fold them.
  const seen = new Set()
  return nodes.map((node) => {
    let id = componentId(node.name)
    if (seen.has(id.toLowerCase())) id = componentId(`${node.name}_${basename(dirname(node.file))}`)
    for (let n = 2; seen.has(id.toLowerCase()); n++) id = componentId(`${node.name}_${n}`)
    seen.add(id.toLowerCase())
    return { id, node }
  })
}

function walkFiles(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir).sort(compare)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walkFiles(path, base))
    else out.push(path.slice(base.length + 1).split('\\').join('/'))
  }
  return out
}

// What the token set gives: the lists, what they leave out, and the sections
// written for it. Null fields when the repo has no token set yet.
function tokenSide(root, config, title) {
  const set = tokenEntries(root, config)
  if (!set) return { set: null, doc: null, left: [], sections: {} }
  const { doc, left } = listTokens(set, { name: title })
  return { set, doc, left, sections: sectionsFor(left, set.modes) }
}

// The pages the project folder keeps, as Map(path under the project folder ->
// text): a page per chosen component, and a section per kind of token the
// lists cannot hold.
function pagesOf({ root, config, projectDir }) {
  const title = config.artifact?.title ?? basename(root)
  const tokens = tokenSide(root, config, title)
  const graph = readJson(join(projectDir, 'graph.json'), null)
  const chosen = chosenNodes(graph, config)
  const pages = new Map()
  for (const { id, node } of chosen) pages.set(`components/${id}/README.md`, componentReadme(node))
  for (const [name, text] of Object.entries(tokens.sections)) pages.set(`sections/${name}`, text)
  return { pages, tokens, graph, chosen, title }
}

// The generated pages on disk that a fresh run would no longer write: a
// component that left the graph, a section whose tokens are gone.
function stalePages(projectDir, pages) {
  const out = []
  const components = join(projectDir, 'components')
  if (existsSync(components)) {
    for (const f of walkFiles(components)) {
      const path = `components/${f}`
      if (basename(f) === 'README.md' && !pages.has(path) && readFileSync(join(projectDir, path), 'utf8').trimEnd().endsWith(PAGE_MARK)) out.push(path)
    }
  }
  const sections = join(projectDir, 'sections')
  if (existsSync(sections)) {
    for (const f of walkFiles(sections)) {
      const path = `sections/${f}`
      if (f.endsWith('.md') && !pages.has(path) && readFileSync(join(projectDir, path), 'utf8').startsWith(SECTION_MARK)) out.push(path)
    }
  }
  return out
}

// Everything a build writes, in memory: files as Map(path under project/ ->
// Buffer or string), and what was left out, as report lines.
function assemble({ root, config, projectDir, builtDir }) {
  const files = new Map()
  const notes = []
  const { pages, tokens, graph, chosen, title } = pagesOf({ root, config, projectDir })
  const { set, doc, left } = tokens
  if (!set) notes.push('No token set yet, so the folder has no tokens.json. Run the tokens phase first.')

  // The brand book: the project's own README, else a line that says what is here.
  const readme = join(projectDir, 'README.md')
  if (existsSync(readme)) files.set('README.md', readFileSync(readme, 'utf8'))
  else {
    files.set('README.md', `This is the design system of ${title}, read from its code. It holds ${set ? `${set.entries.length} tokens` : 'no tokens yet'} and ${chosen.length} ${chosen.length === 1 ? 'component' : 'components'}.\n`)
    notes.push(`No ${rel(root, readme)} yet, so the brand book is one line. The guard phase writes it.`)
  }
  if (!graph) notes.push(`No ${rel(root, join(projectDir, 'graph.json'))} yet, so the folder has no components. Run the graph phase first.`)

  // Sections: the team's own, then the generated ones as they would be written now.
  const sectionsDir = join(projectDir, 'sections')
  if (existsSync(sectionsDir)) {
    for (const f of walkFiles(sectionsDir)) {
      if (!f.endsWith('.md') || f.includes('/')) continue
      const text = readFileSync(join(sectionsDir, f), 'utf8')
      if (!text.startsWith(SECTION_MARK)) files.set(f, text)
    }
  }
  for (const [path, text] of pages) {
    if (path.startsWith('sections/')) files.set(path.slice('sections/'.length), text)
    else files.set(path, text)
  }

  // Assets and fonts the project folder keeps, then the repo files the config names.
  for (const dir of ['assets', 'fonts']) {
    const from = join(projectDir, dir)
    if (existsSync(from)) for (const f of walkFiles(from)) files.set(`${dir}/${f}`, readFileSync(join(from, f)))
  }
  for (const entry of [].concat(config.artifact?.assets ?? [])) {
    const group = typeof entry?.group === 'string' ? entry.group.trim().replace(/[\\/]+/g, ' ') : ''
    if (!group || !entry.include) {
      notes.push('An artifact.assets entry needs a group and an include, as { "group": "Logos", "include": ["public/logo*.svg"] }.')
      continue
    }
    const found = expandGlobs(root, entry.include, [], config.ignore ?? [])
    if (found.length === 0) notes.push(`artifact.assets: nothing matches ${JSON.stringify(entry.include)} for the group ${group}.`)
    for (const f of found) files.set(`assets/${group}/${basename(f)}`, readFileSync(join(root, f)))
  }

  // Components: a preview where the lane's build has the story's page.
  const storyUrl = config.stories?.storyUrl ?? null
  const script = themeScript(config)
  const select = config.artifact?.previewSelect ?? null
  const height = Number(config.artifact?.previewHeight) || 320
  const assets = new Set()
  const stylesheets = new Set()
  const previews = { built: 0, none: [] }
  for (const { id, node } of chosen) {
    let skip = null
    const slug = node.direct?.[0] ?? null
    if (!builtDir) skip = 'no build of the story lane was given'
    else if (!slug) skip = 'no story of its own'
    else {
      const page = builtPagePaths(storyUrl, slug).map((p) => join(builtDir, p)).find((p) => existsSync(p))
      if (!page) skip = storyUrl?.includes('{slug}') ? `no built page for the story ${slug}` : 'stories.storyUrl has no {slug}, so the built page cannot be found'
      else {
        const made = previewFromPage(readFileSync(page, 'utf8'), { group: node.group?.split(' / ').pop() ?? null, height, fromDir: `components/${id}`, select, script, title: node.name })
        if (made.empty) skip = made.empty
        else {
          files.set(`components/${id}/preview.html`, made.html)
          for (const a of made.assets) assets.add(a)
          for (const s of made.stylesheets) stylesheets.add(s)
        }
      }
    }
    if (skip) previews.none.push({ name: node.name, why: skip })
    else previews.built++
  }

  // The built site's files the previews load, and the fonts its CSS declares.
  const fonts = new Map()
  const missing = []
  if (builtDir) {
    for (const sheet of [...stylesheets].sort(compare)) {
      const from = join(builtDir, sheet)
      if (!existsSync(from)) {
        missing.push(sheet)
        continue
      }
      const css = readFileSync(from, 'utf8')
      for (const face of fontFaces(css)) if (!fonts.has(`${face.family}\u0000${face.weight}\u0000${face.style}`)) fonts.set(`${face.family}\u0000${face.weight}\u0000${face.style}`, face)
      files.set(`site${sheet}`, rewriteCssUrls(css, posix.dirname(`site${sheet}`), assets))
    }
    for (const asset of [...assets].sort(compare)) {
      if (files.has(`site${asset}`)) continue
      const from = join(builtDir, asset)
      if (existsSync(from) && statSync(from).isFile()) files.set(`site${asset}`, readFileSync(from))
      else if (existsSync(join(from, 'index.html'))) continue
      else missing.push(asset)
    }
    const listed = []
    for (const face of [...fonts.values()].sort((a, b) => compare(a.family, b.family) || compare(a.weight, b.weight) || compare(a.style, b.style))) {
      const from = join(builtDir, face.path)
      if (!existsSync(from)) continue
      const bytes = readFileSync(from)
      if (bytes.length > FONT_CAP) {
        notes.push(`The font ${face.path} is over 1 MB, so the type view does not list it. The previews still load it.`)
        continue
      }
      const file = `fonts/${basename(face.path)}`
      files.set(file, bytes)
      listed.push({ family: face.family, file, weight: face.weight, style: face.style })
    }
    if (doc && listed.length > 0) doc.type = { fonts: listed, families: doc.type?.families ?? {}, groups: doc.type?.groups ?? [] }
  }
  if (doc) {
    doc.meta = { source: 'massimo', massimo: SCRIPTS_VERSION, tokens: set.files }
    files.set('tokens.json', jsonText(doc))
  }

  // Files kept for the tool that publishes go in last, as they are.
  const kept = join(projectDir, 'artifact', 'kept')
  const keptFiles = existsSync(kept) ? walkFiles(kept) : []
  for (const f of keptFiles) files.set(f, readFileSync(join(kept, f)))

  return { files, notes, left, chosen, previews, missing, set, graph, title, keptFiles }
}

function reportText({ notes, left, chosen, previews, missing, set, title, files, keptFiles, commands }) {
  const uploads = [...files.keys()].filter((f) => f.startsWith('assets/') && isMedia(f)).length
  const lines = [`# ${title}: the design system folder`, '', `Built by massimo ${SCRIPTS_VERSION}. ${files.size} files.`, '']
  lines.push('## What it holds', '')
  lines.push(`- Tokens: ${set ? `${set.entries.length - left.length} of ${set.entries.length} in the token lists, in ${set.modes.length} ${set.modes.length === 1 ? 'theme' : 'themes'} (${set.modes.join(', ')})` : 'none'}`)
  lines.push(`- Components: ${chosen.length} with a page, ${previews.built} with a preview`)
  lines.push(`- Assets: ${[...files.keys()].filter((f) => f.startsWith('assets/')).length} files, ${uploads} of them pictures, videos or PDFs`)
  lines.push(`- Kept files copied over the build: ${keptFiles.length}`)
  lines.push('')
  if (notes.length > 0) lines.push('## Notes', '', ...notes.map((n) => `- ${n}`), '')
  if (left.length > 0) {
    lines.push('## Tokens outside the lists', '', 'Each is written in a section of the brand book instead.', '', '| Token | Type | Section | Why |', '|---|---|---|---|')
    for (const t of [...left].sort((a, b) => compare(a.name, b.name))) lines.push(`| \`--${t.name}\` | ${t.type ?? ''} | ${t.section}.md | ${t.reason} |`)
    lines.push('')
  }
  if (previews.none.length > 0) {
    lines.push('## Components without a preview', '', '| Component | Why |', '|---|---|')
    for (const p of previews.none) lines.push(`| ${p.name} | ${p.why} |`)
    lines.push('')
  }
  if (missing.length > 0) lines.push('## Files the previews name that the build does not hold', '', ...missing.map((m) => `- \`${m}\``), '')
  lines.push(
    '## Publishing',
    '',
    'The folder is `project/` beside this file. `files.json` lists each file with its size and media type, and marks with `"upload": true` the pictures, videos and PDFs under `assets/`.',
    '',
    '1. Any tool that takes files: send `project/` as it is. Every path inside it is relative, so it also opens from a static host or from disk.',
    '2. A Claude design system artifact: make one from the Design System type, upload each file marked `"upload": true` as an asset, write `project/design-system.json` (the index, with each upload under `assetGroups`) and a cover at `project/components/Cover/preview.html`, then send the files, at most 255 in one call. Keep the index and the cover under `kept/`, beside this file, so the next build carries them.',
    `3. Then run \`${commands.record}\`, so \`${commands.status}\` can say when the published copy falls behind.`,
    '',
  )
  return lines.join('\n')
}

// What `record` remembers and `status` compares: the tokens' hash and the graph's.
function sourceHashes({ root, config, projectDir }) {
  const set = tokenEntries(root, config)
  const graphPath = join(projectDir, 'graph.json')
  return { tokensHash: set?.hash ?? null, graphHash: existsSync(graphPath) ? sha256(readFileSync(graphPath)) : null }
}

function main() {
  const { _: positionals, flags } = parseArgs()
  const mode = positionals[0]
  const MODES = ['pages', 'plan', 'build', 'record', 'status']
  if (!MODES.includes(mode)) fail(`usage: artifact.mjs <${MODES.join('|')}>`, 2)
  const { root, config, projectDir } = loadConfig(flags)
  warnIfVendoredOlder(projectDir, import.meta.url)
  const shown = (abs) => {
    const r = rel(root, abs)
    return r.startsWith('..') ? abs : r
  }
  const outDir = typeof flags.out === 'string' ? resolve(flags.out) : join(projectDir, 'artifact')
  const mirrorPath = join(projectDir, 'artifact', 'mirror.json')
  const commands = { record: scriptCommand(root, projectDir, 'artifact', 'record --url <url>'), status: scriptCommand(root, projectDir, 'artifact', 'status') }
  if (typeof flags.components === 'string') config.artifact = { ...config.artifact, components: flags.components.split(',').map((c) => c.trim()).filter(Boolean) }

  if (mode === 'pages') {
    const { pages, chosen } = pagesOf({ root, config, projectDir })
    const stale = stalePages(projectDir, pages)
    const changed = [...pages.keys()].filter((path) => !existsSync(join(projectDir, path)) || readFileSync(join(projectDir, path), 'utf8') !== pages.get(path))
    const sections = [...pages.keys()].filter((p) => p.startsWith('sections/')).length
    const summary = `${chosen.length} component ${chosen.length === 1 ? 'page' : 'pages'}, ${sections} token ${sections === 1 ? 'section' : 'sections'}`
    if (truthy(flags.check)) {
      for (const path of changed) process.stderr.write(`  out of date: ${shown(join(projectDir, path))}${existsSync(join(projectDir, path)) ? '' : ' (missing)'}\n`)
      for (const path of stale) process.stderr.write(`  no longer written: ${shown(join(projectDir, path))}\n`)
      if (changed.length + stale.length > 0) {
        process.stdout.write(`massimo artifact pages: out of date (${changed.length} to write, ${stale.length} to remove). Run: ${scriptCommand(root, projectDir, 'artifact', 'pages')}\n`)
        process.exit(1)
      }
      process.stdout.write(`massimo artifact pages: up to date (${summary})\n`)
      return
    }
    for (const path of changed) {
      const to = join(projectDir, path)
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, pages.get(path))
    }
    for (const path of stale) {
      rmSync(join(projectDir, path))
      // A component's folder goes with its page when nothing else is in it.
      const dir = dirname(join(projectDir, path))
      if (path.startsWith('components/') && readdirSync(dir).length === 0) rmSync(dir, { recursive: true })
    }
    process.stdout.write(`massimo artifact pages: ${summary} in ${shown(projectDir) || '.'}; wrote ${changed.length}, removed ${stale.length}\n`)
    return
  }

  if (mode === 'record') {
    if (typeof flags.url !== 'string' || !/^https?:\/\//.test(flags.url)) fail('usage: artifact.mjs record --url <url> [--target <name>]', 2)
    const previous = readJson(mirrorPath, {}) ?? {}
    const built = readJson(join(outDir, 'files.json'), null)
    const mirror = { ...previous, target: typeof flags.target === 'string' ? flags.target : previous.target ?? 'claude', url: flags.url, syncedAt: today(), ...sourceHashes({ root, config, projectDir }), files: built?.files?.length ?? previous.files ?? null }
    mkdirSync(dirname(mirrorPath), { recursive: true })
    writeFileSync(mirrorPath, jsonText(mirror))
    process.stdout.write(`massimo artifact: recorded ${mirror.url} as published on ${mirror.syncedAt} in ${shown(mirrorPath)}\n`)
    return
  }

  if (mode === 'status') {
    const mirror = readJson(mirrorPath, null)
    if (!mirror?.url) {
      process.stdout.write(`massimo artifact: nothing published yet (no ${shown(mirrorPath)})\n`)
      return
    }
    const now = sourceHashes({ root, config, projectDir })
    const behind = [...(now.tokensHash !== mirror.tokensHash ? ['the tokens'] : []), ...(now.graphHash !== mirror.graphHash ? ['the graph'] : [])]
    process.stdout.write(behind.length > 0
      ? `massimo artifact: behind ${behind.join(' and ')} since ${mirror.syncedAt} (${mirror.url}). Run: ${scriptCommand(root, projectDir, 'artifact', 'build')}, then publish again\n`
      : `massimo artifact: current as published on ${mirror.syncedAt} (${mirror.url})\n`)
    return
  }

  const given = typeof flags.built === 'string' ? flags.built : config.artifact?.built ?? config.stories?.outDir ?? null
  const builtDir = given ? resolve(root, given) : null
  if (typeof flags.built === 'string' && !existsSync(builtDir)) fail(`no folder at ${shown(builtDir)}; build the story lane first`)
  const result = assemble({ root, config, projectDir, builtDir: builtDir && existsSync(builtDir) ? builtDir : null })
  if (!builtDir || !existsSync(builtDir)) result.notes.push(`No build of the story lane${given ? ` at ${given}` : ''}, so components have a page and no preview. Build the lane, then pass --built <dir>.`)
  const { files, left, chosen, previews, set } = result
  const bytes = [...files.values()].reduce((n, v) => n + Buffer.byteLength(v), 0)
  const summary = `${set ? `${set.entries.length - left.length} of ${set.entries.length} tokens in the lists` : 'no tokens'}, ${chosen.length} ${chosen.length === 1 ? 'component' : 'components'} (${previews.built} with a preview), ${files.size} files, ${(bytes / 1e6).toFixed(1)} MB`

  if (mode === 'plan') {
    for (const n of result.notes) process.stderr.write(`  note: ${n}\n`)
    process.stdout.write(`massimo artifact plan: ${summary}; nothing written\n`)
    return
  }

  // build
  const projectOut = join(outDir, 'project')
  rmSync(projectOut, { recursive: true, force: true })
  const manifest = []
  for (const path of [...files.keys()].sort(compare)) {
    const data = files.get(path)
    const to = join(projectOut, path)
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, data)
    manifest.push({ path: `project/${path}`, bytes: Buffer.byteLength(data), type: contentTypeOf(path), ...(path.startsWith('assets/') && isMedia(path) ? { upload: true } : {}) })
  }
  writeFileSync(join(outDir, 'files.json'), jsonText({ generatedBy: 'massimo artifact', title: result.title, files: manifest }))
  writeFileSync(join(outDir, 'report.md'), reportText({ ...result, commands }))
  // The build is regenerated any time, so git need not keep it.
  const ignore = join(outDir, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, 'project/\nfiles.json\nreport.md\n')
  for (const n of result.notes) process.stderr.write(`  note: ${n}\n`)
  process.stdout.write(`massimo artifact build: ${summary}; wrote ${shown(projectOut)}, ${shown(join(outDir, 'files.json'))} and ${shown(join(outDir, 'report.md'))}\n`)
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (entry === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}
