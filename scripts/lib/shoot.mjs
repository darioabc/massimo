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
// once, transitions do not run, and the text caret does not blink.
export const FREEZE_CSS =
  '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;caret-color:transparent!important}'

// --pairs turns every determinism control on.
export const DETERMINISTIC = { reducedMotion: true, freeze: true, settle: true }

const PAIR_FIELDS = ['name', 'a', 'b', 'width', 'height', 'scheme', 'selector', 'full', 'mode']
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/

export const isUrl = (s) => /^(https?|file):\/\//i.test(s)

// A flag read from the command line or from a JSON entry: bare, `=true` or 1.
export const isOn = (v) => v === true || v === 'true' || v === '1' || v === 1

// parseArgs lets a bare flag swallow the word after it, so a flag that takes no
// value is rewritten to `--name=true` before parsing.
export function booleanize(argv, names) {
  const bare = new Set(names.map((n) => `--${n}`))
  return argv.map((a) => (bare.has(a) ? `${a}=true` : a))
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

// Read a pairs file: an array of { name, a, b, width, height, scheme, selector,
// full, mode }. Returns the pairs with defaults filled in, and a list of
// problems instead of throwing, so every mistake is reported at once. An
// unknown field is a problem, because it is almost always a typo.
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
    if (typeof p.name !== 'string' || !NAME_OK.test(p.name)) bad('name must be letters, digits, ".", "_", "-" and "/" between folders')
    else if (seen.has(p.name)) bad('name is used twice')
    else seen.add(p.name)
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

// Above this many cells the line alignment is skipped and the differing middle
// is reported as removed then added.
const ALIGN_LIMIT = 4_000_000

// The edit script between two line lists: the lines both share at either end are
// peeled off, the middle is aligned by longest common subsequence.
function editScript(x, y) {
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
  const n = mx.length
  const m = my.length
  if ((n + 1) * (m + 1) > ALIGN_LIMIT) {
    for (const s of mx) push('-', s)
    for (const s of my) push('+', s)
  } else {
    const w = m + 1
    const L = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * w + j] = mx[i] === my[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (mx[i] === my[j]) {
        push(' ', mx[i])
        i++
        j++
      } else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) push('-', mx[i++])
      else push('+', my[j++])
    }
    while (i < n) push('-', mx[i++])
    while (j < m) push('+', my[j++])
  }
  for (let i = x.length - tail; i < x.length; i++) push(' ', x[i])
  return ops
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
// pixel one: a quarter of the lines changed is 25.
export function compareText(a, b) {
  const x = textLines(a)
  const y = textLines(b)
  const ops = editScript(x, y)
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
