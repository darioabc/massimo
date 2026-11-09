// The parts of shoot.mjs that need no browser: reading a pairs file, the
// threshold verdict, comparing two text snapshots, and finding Playwright on
// disk. Kept apart so tests can cover them without Playwright installed.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// The packages that carry Playwright's `chromium`, in the order they are tried.
export const PLAYWRIGHT_NAMES = ['playwright', '@playwright/test', 'playwright-core']

// What `--freeze` injects into every frame: animations run to their end state at
// once, scrolling is not smooth and the text caret does not blink. Transitions
// are left alone on purpose: a transition of 0s never fires transitionend, so
// a page that finishes its reveal there would be shot in a state no visitor
// sees. Playwright's `animations: 'disabled'` (passed with the screenshots when
// freeze is on) finishes them instead, which fires the event.
export const FREEZE_CSS =
  '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;scroll-behavior:auto!important;caret-color:transparent!important}'

// --pairs turns every determinism control on.
export const DETERMINISTIC = { reducedMotion: true, freeze: true, settle: true }

const PAIR_FIELDS = ['name', 'a', 'b', 'width', 'height', 'scheme', 'selector', 'full', 'mode', 'reducedMotion', 'settle', 'freeze']
// The pair fields that switch one determinism control off (or back on).
const PAIR_CONTROLS = ['reducedMotion', 'settle', 'freeze']
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/

export const isUrl = (s) => /^(https?|file):\/\//i.test(s)

// A flag read from the command line or from a JSON entry: bare, `=true` or 1.
export const isOn = (v) => v === true || v === 'true' || v === '1' || v === 1

// A numeric flag: the fallback when it is absent, NaN when it is bare, empty,
// repeated or not a number, so a typo is caught instead of read as 1 or 0.
export function flagNumber(value, fallback) {
  if (value === undefined) return fallback
  return typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
}

// The three determinism controls for a shot. `src` is a flag set or a batch
// entry, `base` what applies when `src` does not say.
export function determinism(src = {}, base = {}) {
  const pick = (key, alias) => {
    const v = src[key] ?? src[alias]
    return v === undefined ? Boolean(base[key]) : isOn(v)
  }
  return { reducedMotion: pick('reducedMotion', 'reduced-motion'), freeze: pick('freeze'), settle: pick('settle') }
}

// `--diff a b` and `--diff` followed by two positionals both name the pair.
export function diffArgs(args, flags) {
  const a = flags.diff === true ? args[0] : flags.diff
  const b = flags.diff === true ? args[1] : args[0]
  return { a, b }
}

// A percentage rounded for printing.
export function percent(changed, total) {
  return Number(((changed / total) * 100).toFixed(3))
}

// Pass or fail for one pair. The printed percentage is rounded, so a single
// changed pixel on a large page prints 0 and must still fail at `maxDiff` 0:
// the verdict reads the exact ratio.
export function verdict({ changed, total, sizeMismatch = false, sizes }, maxDiff = 0) {
  const reasons = []
  if (sizeMismatch) reasons.push(sizes ? `sizes differ (${sizes.join(' and ')})` : 'sizes differ')
  if (total > 0 && (changed / total) * 100 > Number(maxDiff) + 1e-9) reasons.push(`${percent(changed, total)}% changed, over ${maxDiff}%`)
  return { ok: reasons.length === 0, reasons }
}

// The summary line that closes a pairs run.
export function summarise(results, maxDiff) {
  const failed = results.filter((r) => !r.ok).length
  return { summary: true, pairs: results.length, passed: results.length - failed, failed, maxDiff, ok: failed === 0 }
}

// Width and height of a PNG, read from its header.
export function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// A pairs file is a bare array of pairs, or { "format": 1, "pairs": [...] } for
// one that states its format. Returns the list, the format the file states (the
// caller refuses a newer one, through refuseNewer) and the problems with the
// wrapper. Nothing is read from a wrapper beyond those two fields.
export function pairsDocument(doc) {
  if (Array.isArray(doc)) return { list: doc, problems: [] }
  if (!doc || typeof doc !== 'object') return { list: null, problems: ['the pairs file must hold an array of pairs, or { "format": 1, "pairs": [...] }'] }
  const problems = []
  for (const key of Object.keys(doc)) if (key !== 'format' && key !== 'pairs') problems.push(`unknown field "${key}"`)
  if (!Number.isInteger(doc.format) || doc.format < 1) problems.push('"format" must be a whole number, 1 or more')
  if (!Array.isArray(doc.pairs)) problems.push('"pairs" must be an array of pairs')
  return { list: Array.isArray(doc.pairs) ? doc.pairs : null, format: doc.format, problems }
}

// Read the array of a pairs file: { name, a, b, width, height, scheme, selector,
// full, mode, reducedMotion, settle, freeze }. Returns the pairs with defaults
// filled in, and a list of problems instead of throwing, so every mistake is
// reported at once. An unknown field is a problem, because it is almost always
// a typo.
export function parsePairs(list, defaults = {}) {
  const problems = []
  if (!Array.isArray(list)) return { pairs: [], problems: ['the pairs file must hold an array'] }
  const seen = new Set()
  const pairs = []
  list.forEach((p, i) => {
    const where = `pair ${i + 1}${p && typeof p.name === 'string' ? ` (${p.name})` : ''}`
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      problems.push(`${where}: expected an object`)
      return
    }
    const bad = (why) => problems.push(`${where}: ${why}`)
    for (const key of Object.keys(p)) if (!PAIR_FIELDS.includes(key)) bad(`unknown field "${key}"`)
    // Compared without case: on a case-insensitive disk (macOS, Windows) two
    // names that differ only in case would write the same files.
    if (typeof p.name !== 'string' || !NAME_OK.test(p.name)) bad('name must be letters, digits, ".", "_", "-" and "/" between folders')
    else if (seen.has(p.name.toLowerCase())) bad('name is used twice (names are compared without case)')
    else seen.add(p.name.toLowerCase())
    for (const side of ['a', 'b']) if (typeof p[side] !== 'string' || !p[side]) bad(`${side} must be a URL or a file path`)
    const mode = p.mode ?? 'pixel'
    if (!['pixel', 'dom'].includes(mode)) bad(`mode must be "pixel" or "dom"`)
    const scheme = p.scheme ?? defaults.scheme ?? 'light'
    if (!['light', 'dark'].includes(scheme)) bad('scheme must be "light" or "dark"')
    const size = (key, fallback) => {
      const v = Number(p[key] ?? defaults[key] ?? fallback)
      if (!Number.isInteger(v) || v < 1) bad(`${key} must be a whole number above 0`)
      return v
    }
    const width = size('width', 1280)
    const height = size('height', 800)
    if (p.selector !== undefined && (typeof p.selector !== 'string' || !p.selector)) bad('selector must be a CSS or text selector')
    for (const key of PAIR_CONTROLS) if (p[key] !== undefined && typeof p[key] !== 'boolean') bad(`${key} must be true or false`)
    pairs.push({
      name: p.name,
      a: p.a,
      b: p.b,
      mode,
      width,
      height,
      scheme,
      full: p.full === undefined ? isOn(defaults.full) : isOn(p.full),
      ...(p.selector ? { selector: p.selector } : {}),
      ...Object.fromEntries(PAIR_CONTROLS.filter((key) => typeof p[key] === 'boolean').map((key) => [key, p[key]])),
    })
  })
  return { pairs: problems.length ? [] : pairs, problems }
}

// Where a pair writes its files under `--out`.
export function pairFiles(dir, name, mode) {
  const ext = mode === 'dom' ? 'txt' : 'png'
  return { a: join(dir, `${name}.a.${ext}`), b: join(dir, `${name}.b.${ext}`), diff: join(dir, `${name}.diff.${ext}`) }
}

// Line endings, trailing spaces and trailing blank lines are not a difference.
export function textLines(text) {
  const lines = String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// Past this many edits the line alignment is skipped, because the trace it
// keeps grows with the square of the edit count. The differing middle is then
// reported as removed then added, and the result says it was not aligned.
const MAX_EDITS = 3000

// The shortest edit script between two line lists, as [type, line] pairs in
// order, by Myers' O(ND) algorithm: cheap when the texts are close, which is
// what a check between two builds of one page expects. Null above MAX_EDITS.
function myers(x, y) {
  const n = x.length
  const m = y.length
  const top = Math.min(n + m, MAX_EDITS)
  const mid = top + 1
  // v[mid + k] is the furthest x reached on diagonal k (x - y) so far.
  const v = new Int32Array(2 * top + 3)
  // trace[d] keeps v for the diagonals -d..d once round d is done.
  const trace = []
  for (let d = 0; d <= top; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[mid + k - 1] < v[mid + k + 1])
      let px = down ? v[mid + k + 1] : v[mid + k - 1] + 1
      let py = px - k
      while (px < n && py < m && x[px] === y[py]) {
        px++
        py++
      }
      v[mid + k] = px
      if (px >= n && py >= m) return walkBack(trace, x, y, d)
    }
    trace.push(v.slice(mid - d, mid + d + 1))
  }
  return null
}

// The edits of the path myers found, read back from the end.
function walkBack(trace, x, y, edits) {
  const out = []
  let px = x.length
  let py = y.length
  for (let d = edits; d > 0; d--) {
    const prev = trace[d - 1]
    const at = d - 1
    const k = px - py
    const down = k === -d || (k !== d && prev[at + k - 1] < prev[at + k + 1])
    const pk = down ? k + 1 : k - 1
    const sx = prev[at + pk]
    const sy = sx - pk
    // the lines both share, back to where the edit ended
    const ex = down ? sx : sx + 1
    while (px > ex) {
      out.push([' ', x[--px]])
      py--
    }
    out.push(down ? ['+', y[sy]] : ['-', x[sx]])
    px = sx
    py = sy
  }
  while (px > 0) out.push([' ', x[--px]])
  return out.reverse()
}

// The edit script between two line lists: the lines both share at either end
// are peeled off, the middle is aligned. `aligned` is false when the middle was
// too different to align, so its percentage reads high.
export function editScript(x, y) {
  const ops = []
  let ai = 0
  let bi = 0
  const push = (t, s) => {
    ops.push({ t, s, a: ai, b: bi })
    if (t !== '+') ai++
    if (t !== '-') bi++
  }
  let head = 0
  while (head < x.length && head < y.length && x[head] === y[head]) head++
  let tail = 0
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++
  for (let i = 0; i < head; i++) push(' ', x[i])
  const mx = x.slice(head, x.length - tail)
  const my = y.slice(head, y.length - tail)
  // with nothing on one side there is nothing to align
  const edits = mx.length && my.length ? myers(mx, my) : null
  if (edits) for (const [t, s] of edits) push(t, s)
  else {
    for (const s of mx) push('-', s)
    for (const s of my) push('+', s)
  }
  for (let i = x.length - tail; i < x.length; i++) push(' ', x[i])
  return { ops, aligned: Boolean(edits) || !mx.length || !my.length }
}

// Changed lines with two lines of context, each stretch under an `@@ -a +b @@`
// header giving the 1-based line in each text.
function hunks(ops, context = 2) {
  const keep = new Array(ops.length).fill(false)
  ops.forEach((op, i) => {
    if (op.t === ' ') return
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true
  })
  const out = []
  let open = false
  ops.forEach((op, i) => {
    if (!keep[i]) {
      open = false
      return
    }
    if (!open) {
      out.push(`@@ -${op.a + 1} +${op.b + 1} @@`)
      open = true
    }
    out.push(`${op.t} ${op.s}`)
  })
  return out
}

// Compare two text snapshots. `changed` is the larger of the removed and added
// line counts and `total` the longer text, so the percentage reads like the
// pixel one: a quarter of the lines changed is 25. `aligned` is false when the
// texts differ too much to line up, and the percentage then reads high.
export function compareText(a, b) {
  const x = textLines(a)
  const y = textLines(b)
  const { ops, aligned } = editScript(x, y)
  const removed = ops.filter((o) => o.t === '-').length
  const added = ops.filter((o) => o.t === '+').length
  const changed = Math.max(removed, added)
  const total = Math.max(x.length, y.length)
  return {
    linesA: x.length,
    linesB: y.length,
    removed,
    added,
    changed,
    total,
    percent: total ? percent(changed, total) : 0,
    aligned,
    diff: hunks(ops).join('\n'),
  }
}

function readPackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

// The files to try for a `--playwright` path. The path is a Playwright package
// folder (node_modules/playwright), a node_modules folder, a repo root or the
// entry file itself. Returns [] when none of those hold a Playwright package.
export function playwrightEntries(input) {
  const base = resolve(input)
  if (existsSync(base) && statSync(base).isFile()) return [base]
  const out = []
  const addPackage = (dir) => {
    const pkg = readPackage(dir)
    if (!pkg || !PLAYWRIGHT_NAMES.includes(pkg.name)) return false
    out.push(join(dir, typeof pkg.main === 'string' ? pkg.main : 'index.js'))
    return true
  }
  if (addPackage(base)) return out
  for (const modules of [base, join(base, 'node_modules')]) {
    for (const name of PLAYWRIGHT_NAMES) addPackage(join(modules, name))
  }
  return out
}

// What the repo's own dependencies resolve to, as before `--playwright` existed.
function repoEntries(root) {
  const require = createRequire(join(root, 'package.json'))
  const out = []
  for (const name of PLAYWRIGHT_NAMES) {
    try {
      out.push(require.resolve(name))
    } catch {
      // not installed under this name
    }
  }
  return out
}

// ── The render sweep ────────────────────────────────────────────────────────

// What a sweep waits for when --ready is not given.
export const SWEEP_READY = 'html[data-story-ready]'
// Runs in the page: whether the ready element holds something drawn. For a
// root marker such as `<html data-story-ready>`, which always holds the head
// and the body, the story's mount is the page's own content: some child of
// the body, other than a script or a style, that holds an element. For any
// other element, it is a child of that element. It must not use anything
// from this file, since the browser gets its text alone.
export const SWEEP_FILLED = (selector) => {
  const el = document.querySelector(selector)
  if (!el) return false
  if (el !== document.documentElement) return el.childElementCount > 0
  const skip = ['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'LINK']
  return Array.from(document.body?.children ?? []).some((c) => !skip.includes(c.tagName) && c.childElementCount > 0)
}
// What a sweep waits after the ready selector matches, in milliseconds, before it
// reads html[data-story-error]: a state can fail in an effect after it was marked
// ready, and shows its error box without any page error.
export const SWEEP_SETTLE_MS = 500
// Runs in the page, after the ready selector matched: two animation frames, then
// `ms`, then whether the document is marked as failed. Like SWEEP_FILLED it
// must not use anything from this file.
export async function sweepSettle(ms) {
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  await new Promise((done) => setTimeout(done, ms))
  return document.documentElement.hasAttribute('data-story-error')
}
// The share of the baseline's states that must be ready before it can excuse
// anything.
export const SWEEP_FLOOR = 0.98

// The sweep's flags, read whole: `workers` and `timeout` (seconds) must be
// positive numbers, `settle-ms` a whole number from 0 to 10000, and `--sweep` takes a base URL. Returns the options and
// the problems, so a typo is caught before a browser starts.
export function sweepOptions(flags) {
  const problems = []
  const base = typeof flags.sweep === 'string' ? flags.sweep.replace(/\/+$/, '') : ''
  if (!isUrl(base)) problems.push('--sweep takes the base URL of a server, such as http://localhost:4650')
  const workers = flagNumber(flags.workers, 4)
  if (!Number.isInteger(workers) || workers < 1 || workers > 32) problems.push('--workers is a whole number from 1 to 32')
  const timeout = flagNumber(flags.timeout, 15)
  if (!(timeout > 0)) problems.push('--timeout is a number of seconds above 0')
  const ready = flags.ready === undefined ? SWEEP_READY : flags.ready
  if (typeof ready !== 'string' || !ready) problems.push('--ready takes a CSS selector')
  const settleMs = flagNumber(flags['settle-ms'], SWEEP_SETTLE_MS)
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 10000) problems.push('--settle-ms is a whole number of milliseconds from 0 to 10000')
  for (const key of ['ids-from', 'routes', 'sweep-baseline']) if (flags[key] !== undefined && (typeof flags[key] !== 'string' || !flags[key])) problems.push(`--${key} takes one file`)
  return { options: { base, workers, timeout, ready, settleMs, legacy: isOn(flags.legacy) }, problems }
}

// The ids of a Ladle-shaped meta.json: its `stories` keys, in file order.
export const idsOfMeta = (doc) => (doc && typeof doc.stories === 'object' && doc.stories !== null ? Object.keys(doc.stories) : [])

// Where a state is loaded: Ladle's `/?story=<id>&mode=preview` under
// --legacy, else the path `routes` gives the id (null when it gives none).
export function sweepUrl(base, id, { legacy = false, routes = {} } = {}) {
  if (legacy) return `${base}/?story=${encodeURIComponent(id)}&mode=preview`
  const path = routes[id]
  return typeof path === 'string' && path.startsWith('/') ? `${base}${path}` : null
}

// The sweep's verdicts (`[{ id, ok, why }]`) as its output document. With a
// baseline (a result of an earlier sweep), a failure the baseline also had is
// excused, but only when the baseline itself reached `floor` of its states:
// below that, nothing is excused, and the document says why. The excused
// set is always in the document.
export function sweepResult(base, verdicts, baseline = null, floor = SWEEP_FLOOR) {
  const failures = verdicts.filter((v) => !v.ok).map((v) => ({ id: v.id, why: v.why }))
  const out = { base, total: verdicts.length, ready: verdicts.length - failures.length, failed: failures, excused: [] }
  if (!baseline) return out
  const total = Number(baseline.total) || 0
  const rate = total > 0 ? Number(baseline.ready) / total : 0
  const had = new Set([...(baseline.failed ?? []), ...(baseline.excused ?? [])].map((f) => f.id))
  const trusted = rate >= floor
  out.failed = trusted ? failures.filter((f) => !had.has(f.id)) : failures
  out.excused = trusted ? failures.filter((f) => had.has(f.id)) : []
  const pct = Number((rate * 100).toFixed(2))
  out.baseline = { total, ready: Number(baseline.ready) || 0, rate: pct, floor: floor * 100, excusing: trusted, ...(trusted ? {} : { note: `the baseline reached ${pct}% ready, below ${floor * 100}%, so nothing is excused` }) }
  return out
}

// Playwright's chromium, loaded by absolute path so another checkout's install
// is used in place (never linked into this repo). `playwright` is the
// `--playwright` path; without it the repo's own install is used. Null when
// nothing loads.
export async function loadChromium({ root, playwright } = {}) {
  const entries = playwright ? playwrightEntries(playwright) : repoEntries(root)
  for (const entry of entries) {
    try {
      const mod = await import(pathToFileURL(entry).href)
      const chromium = mod.chromium ?? mod.default?.chromium
      if (chromium) return chromium
    } catch {
      // try the next one
    }
  }
  return null
}
