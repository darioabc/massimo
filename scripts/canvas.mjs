#!/usr/bin/env node
// Build an exploration's canvas: one page that shows every round's
// directions side by side in scaled frames, with rationale and verdicts, so
// the user compares real renders instead of reading descriptions.
//
//   canvas.mjs <topic-dir> [--inline]
//
// Writes <topic-dir>/index.html (frames load the round files; serve the
// project folder with serve.mjs). --inline also writes index.inline.html,
// a single self-contained file (kit and directions inlined) for hosts that
// publish one page.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fail, parseArgs } from './lib/project.mjs'
import { escapeHtml } from './lib/text.mjs'

const { _: args, flags } = parseArgs()
if (!args[0]) fail('usage: canvas.mjs <topic-dir> [--inline]')
const topicDir = resolve(args[0])
if (!existsSync(topicDir)) fail(`no such folder: ${topicDir}`)

const topic = basename(topicDir)
const briefPath = join(topicDir, 'brief.md')
const title = existsSync(briefPath) ? (readFileSync(briefPath, 'utf8').match(/^#\s+(.+)$/m)?.[1] ?? topic) : topic

const rounds = readdirSync(topicDir)
  .filter((d) => /^round-\d+$/.test(d) && existsSync(join(topicDir, d, 'round.json')))
  .map((d) => {
    const meta = JSON.parse(readFileSync(join(topicDir, d, 'round.json'), 'utf8'))
    // The folder decides which round this is; round.json cannot point elsewhere.
    return { ...meta, dir: d, n: Number(d.slice(6)), directions: directionsOf(d, meta.directions) }
  })
  .sort((a, b) => b.n - a.n)

if (!rounds.length) fail(`no round-N/round.json under ${topicDir}`)

// A direction's file must be an .html file inside its own round folder; anything
// else (a path out of the folder, a missing file) is left off the canvas.
function directionsOf(dir, list) {
  return (Array.isArray(list) ? list : []).filter((d) => {
    const ok = typeof d?.file === 'string' && basename(d.file) === d.file && /\.html?$/i.test(d.file) && existsSync(join(topicDir, dir, d.file))
    if (!ok) process.stderr.write(`canvas: skipped a direction in ${dir}/round.json: ${JSON.stringify(d?.file)} is not an .html file in that folder\n`)
    return ok
  })
}

// The kit sits at <projectDir>/kit/kit.css, three levels above a round.
const kitPath = resolve(topicDir, '..', '..', 'kit', 'kit.css')
const kit = existsSync(kitPath) ? readFileSync(kitPath, 'utf8') : ''

const esc = escapeHtml

function frameSrc(round, file, inline) {
  if (!inline) return `src="${esc(`${round.dir}/${file}`)}"`
  // A function, so a $& or $' in the kit stays text instead of a replacement pattern.
  const html = readFileSync(join(topicDir, round.dir, file), 'utf8').replace(
    /<link[^>]+href=["'](?:\.\.\/)+kit\/kit\.css["'][^>]*>/,
    () => `<style>${kit.replace(/<\//g, '<\\/')}</style>`,
  )
  return `srcdoc="${esc(html)}"`
}

function verdictBadge(round) {
  const v = round.verdict
  if (!v) return '<span class="badge pending">awaiting decision</span>'
  const label = { lock: 'locked', seed: 'seeded next round', none: 'none picked', stop: 'stopped' }[v.decision] ?? v.decision
  return `<span class="badge ${esc(v.decision)}">${esc(label)}${v.pick ? `: ${esc(v.pick)}` : ''}</span>${v.feedback ? `<p class="feedback">${esc(v.feedback)}</p>` : ''}`
}

// Frames are sandboxed. By default a mockup runs no script and keeps its
// origin, so the canvas can flip its theme. A direction marked `scripts: true`
// runs its script in an opaque origin instead, out of the theme switch's reach;
// the two are never granted together, which would undo the sandbox.
const sandboxOf = (d) => (d.scripts === true ? 'allow-scripts' : 'allow-same-origin')

function direction(round, d, inline) {
  const width = Number(d.width) || 1280
  const height = Number(d.height) || 800
  const picked = round.verdict?.pick === d.file
  return `
      <figure class="direction${picked ? ' picked' : ''}" style="--w:${width};--h:${height}">
        <div class="frame"><iframe title="${esc(d.title)}" loading="lazy" sandbox="${sandboxOf(d)}" width="${width}" height="${height}" ${frameSrc(round, d.file, inline)}></iframe></div>
        <figcaption>
          <h3>${esc(d.title)}${picked ? ' <span class="badge lock">picked</span>' : ''}</h3>
          ${d.rationale ? `<p>${esc(d.rationale)}</p>` : ''}
          <p class="meta">${[d.scope && `scope: ${esc(d.scope)}`, d.changed && `changed: ${esc(d.changed)}`, `${width}×${height}`, d.scripts === true && 'interactive, theme switch off'].filter(Boolean).join(' · ')}${inline ? '' : ` · <a href="${esc(`${round.dir}/${d.file}`)}" target="_blank" rel="noopener">open full size</a>`}</p>
        </figcaption>
      </figure>`
}

function page(inline) {
  const sections = rounds
    .map(
      (r, i) => `
  <details class="round"${i === 0 ? ' open' : ''}>
    <summary><h2>Round ${r.n}</h2>${verdictBadge(r)}</summary>
    ${r.framing ? `<p class="framing">${esc(r.framing)}</p>` : ''}
    <div class="row">${(r.directions ?? []).map((d) => direction(r, d, inline)).join('')}
    </div>
  </details>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<!-- GENERATED by massimo canvas.mjs from round-N/round.json. Do not edit by hand. -->
<style>
  :root { --bg: #f6f6f4; --fg: #1b1b1a; --muted: #6b6b66; --line: #e2e2dd; --card: #fff; --accent: #c8102e; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg: #131312; --fg: #ededea; --muted: #9a9a94; --line: #2c2c2a; --card: #1c1c1b; --accent: #ff4d5e; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  header { padding: 24px 32px 8px; display: flex; flex-wrap: wrap; gap: 16px; align-items: baseline; justify-content: space-between; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  header p { margin: 4px 0 0; color: var(--muted); }
  .themes { display: flex; gap: 4px; }
  .themes button { font: inherit; padding: 4px 10px; border: 1px solid var(--line); background: var(--card); color: var(--fg); border-radius: 6px; cursor: pointer; }
  .themes button[aria-pressed="true"] { border-color: var(--fg); }
  .round { margin: 8px 32px 24px; border-top: 1px solid var(--line); }
  .round > summary { list-style: none; cursor: pointer; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 16px 0 8px; }
  .round > summary::-webkit-details-marker { display: none; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .framing { margin: 0 0 12px; color: var(--muted); max-width: 72ch; }
  .feedback { flex-basis: 100%; margin: 0; color: var(--muted); }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .badge.lock { border-color: var(--accent); color: var(--accent); }
  .row { display: flex; gap: 32px; overflow-x: auto; padding-bottom: 16px; align-items: flex-start; }
  .direction { --scale: min(1, calc(640 / var(--w))); margin: 0; flex: none; width: calc(var(--w) * var(--scale) * 1px); }
  .frame { width: calc(var(--w) * var(--scale) * 1px); height: calc(var(--h) * var(--scale) * 1px); overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .picked .frame { outline: 2px solid var(--accent); outline-offset: 3px; }
  iframe { border: 0; transform: scale(var(--scale)); transform-origin: 0 0; display: block; }
  figcaption h3 { margin: 12px 0 4px; font-size: 14px; font-weight: 600; }
  figcaption p { margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: 12px; }
  .meta a { color: inherit; }
</style>
</head>
<body>
<header>
  <div>
    <h1>${esc(title)}</h1>
    <p>${rounds.length} round${rounds.length === 1 ? '' : 's'} · latest is round ${rounds[0].n}</p>
  </div>
  <div class="themes" role="group" aria-label="Mockup theme">
    <button type="button" data-theme-choice="" aria-pressed="true">Auto</button>
    <button type="button" data-theme-choice="light" aria-pressed="false">Light</button>
    <button type="button" data-theme-choice="dark" aria-pressed="false">Dark</button>
  </div>
</header>
${sections}
<script>
  // Flip every mockup's data-theme so both themes can be judged from one page.
  let choice = ''
  const apply = (frame) => {
    try {
      const root = frame.contentDocument && frame.contentDocument.documentElement
      if (!root) return
      if (choice) root.setAttribute('data-theme', choice)
      else if (root.dataset.massimoOriginalTheme !== undefined) root.setAttribute('data-theme', root.dataset.massimoOriginalTheme)
    } catch (e) {}
  }
  document.querySelectorAll('iframe').forEach((f) => f.addEventListener('load', () => {
    try { const r = f.contentDocument.documentElement; r.dataset.massimoOriginalTheme = r.getAttribute('data-theme') || '' } catch (e) {}
    apply(f)
  }))
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.addEventListener('click', () => {
    choice = b.dataset.themeChoice
    document.querySelectorAll('[data-theme-choice]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
    document.querySelectorAll('iframe').forEach(apply)
  }))
</script>
</body>
</html>
`
}

writeFileSync(join(topicDir, 'index.html'), page(false))
const written = [join(topicDir, 'index.html')]
if (flags.inline) {
  writeFileSync(join(topicDir, 'index.inline.html'), page(true))
  written.push(join(topicDir, 'index.inline.html'))
}
process.stdout.write(`canvas: ${rounds.length} round(s), ${rounds.reduce((n, r) => n + (r.directions?.length ?? 0), 0)} direction(s) → ${written.join(', ')}\n`)
