#!/usr/bin/env node
// Screenshots and pixel diffs through Playwright, so tidy batches, translations
// and cutovers can be checked as before/after images instead of by eye. Exits 3
// when Playwright cannot be found; skills then fall back to the host's browser
// tools.
//
//   shoot.mjs --url <url> --out <file.png> [--width 1280] [--height 800] [--full] [--scheme light|dark] [--wait 300] [--selector <css>] [--dom <file.txt>]
//   shoot.mjs --batch <shots.json>      (array of { url, out, width, height, full, scheme, wait, selector, dom })
//   shoot.mjs --diff <a.png> <b.png> --out <diff.png> [--threshold 0.05]
//   shoot.mjs --pairs <pairs.json> --out <dir> [--max-diff 0] [--threshold 0.05]
//
// --dom also saves what the page holds as text (its accessibility tree, or its
// HTML on an older Playwright), for reviewers who read a render without a browser.
//
// --pairs takes an array of { name, a, b, width, height, scheme, selector, full,
// mode }, where a and b are URLs or paths. Two URLs are shot and diffed; two PNG
// paths are only diffed. Files land in --out as <name>.a.png, <name>.b.png and
// <name>.diff.png. mode "dom" compares each page's text snapshot instead of its
// pixels, for pages with live motion that no freeze can hold still: the files
// are <name>.a.txt, <name>.b.txt and <name>.diff.txt, and a and b may be
// snapshot paths too. It prints one JSON line per pair, then a summary line,
// and exits 1 when any pair is over --max-diff (a percentage, default 0) or the
// two images differ in size. --width, --height, --scheme and --full set the
// defaults a pair does not state, and --wait and --threshold apply to every pair.
//
// Determinism, for shots that must come out the same twice:
//   --reduced-motion  emulate prefers-reduced-motion: reduce
//   --settle          wait for document.fonts.ready, for every iframe to load
//                     (lazy ones are woken) and for each iframe's fonts
//   --freeze          stop CSS animations and transitions in every frame
// --pairs turns all three on. Motion driven by script (canvas, WebGL, a
// rotating hero) is not held still by any of them; compare those with mode "dom".
//
// --playwright <path> loads Playwright from another checkout instead of the
// repo's own install. The path is a package folder (node_modules/playwright), a
// node_modules folder or a repo root. It is imported in place, never linked.
//
// Prints one JSON line per shot, diff or pair.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fail, findRoot, parseArgs } from './lib/project.mjs'
import {
  DETERMINISTIC,
  FREEZE_CSS,
  booleanize,
  compareText,
  determinism,
  diffArgs,
  isUrl,
  loadChromium,
  pairFiles,
  parsePairs,
  percent,
  pngSize,
  summarise,
  verdict,
} from './lib/shoot.mjs'

// These flags take no value, so a word after one is not swallowed as its value.
const { _: args, flags } = parseArgs(booleanize(process.argv.slice(2), ['freeze', 'reduced-motion', 'settle']))
const root = flags.root ? resolve(flags.root) : findRoot()

const SETTLE_LIMIT = 15000

async function chromiumOrExit() {
  const playwright = typeof flags.playwright === 'string' ? flags.playwright : undefined
  const chromium = await loadChromium({ root, playwright })
  if (chromium) return chromium
  process.stderr.write(
    playwright
      ? `massimo: no Playwright found at ${playwright}. Give a package folder (node_modules/playwright), a node_modules folder or a repo root that has it installed.\n`
      : 'massimo: Playwright is not installed in this repo. Install it (npm i -D playwright && npx playwright install chromium), or capture with your browser tool.\n',
  )
  process.exit(3)
}

// Runs in each frame before the page's own scripts: adds the freeze style as
// soon as the document has a root element.
function injectStyle(css) {
  const add = () => {
    const el = document.createElement('style')
    el.textContent = css
    ;(document.head ?? document.documentElement).append(el)
  }
  if (document.documentElement) return add()
  const watch = new MutationObserver(() => {
    if (!document.documentElement) return
    watch.disconnect()
    add()
  })
  watch.observe(document, { childList: true })
}

// Runs in the page: wakes lazy iframes and resolves with how many of the ones
// that were still on their blank first document had not loaded within `limit`.
// An iframe that already holds its document never fires `load` again, so only
// a blank one with something to load is waited for. A cross-origin frame
// refuses the look and has loaded already.
async function wakeFrames(limit) {
  const pending = []
  for (const f of document.querySelectorAll('iframe[loading="lazy"]')) {
    const src = f.getAttribute('src') ?? ''
    let blank = false
    try {
      blank = f.contentWindow.location.href === 'about:blank' && ((src !== '' && src !== 'about:blank') || f.hasAttribute('srcdoc'))
    } catch {
      blank = false
    }
    f.setAttribute('loading', 'eager')
    if (blank) pending.push(new Promise((res) => f.addEventListener('load', res, { once: true })))
  }
  let done = 0
  for (const p of pending) p.then(() => done++)
  await Promise.race([Promise.all(pending), new Promise((res) => setTimeout(res, limit))])
  return pending.length - done
}

// Fonts and iframes, so a shot does not catch the page half drawn.
async function settle(page) {
  const unloaded = await page.evaluate(wakeFrames, SETTLE_LIMIT)
  if (unloaded) throw new Error(`${unloaded} iframe${unloaded === 1 ? '' : 's'} did not load within ${SETTLE_LIMIT / 1000} seconds`)
  for (const frame of page.frames()) {
    try {
      await frame.waitForLoadState('load')
      await frame.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true))
    } catch (err) {
      // a frame that went away while settling has nothing to wait for
      if (!/detached|closed|destroyed/i.test(err.message)) throw err
    }
  }
}

const NO_CONTROLS = { reducedMotion: false, freeze: false, settle: false }

async function openPage(browser, s, det) {
  const width = Number(s.width ?? 1280)
  const height = Number(s.height ?? 800)
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: s.scheme ?? 'light',
    deviceScaleFactor: 1,
    ...(det.reducedMotion ? { reducedMotion: 'reduce' } : {}),
  })
  try {
    if (det.freeze) await context.addInitScript(injectStyle, FREEZE_CSS)
    const page = await context.newPage()
    await page.goto(s.url, { waitUntil: 'networkidle' })
    if (det.settle) await settle(page)
    if (s.wait) await page.waitForTimeout(Number(s.wait))
    return { context, page, width, height }
  } catch (err) {
    await context.close()
    throw err
  }
}

// What the page holds as text: its accessibility tree, or its HTML on an
// older Playwright.
async function domText(page, selector) {
  const scope = page.locator(selector ?? 'body').first()
  const tree = typeof scope.ariaSnapshot === 'function' ? await scope.ariaSnapshot().catch(() => null) : null
  return tree ?? (await page.content())
}

function writeOut(file, data) {
  const out = resolve(file)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, data)
  return out
}

async function shoot(browser, s, det = NO_CONTROLS) {
  const { context, page, width, height } = await openPage(browser, s, det)
  try {
    const out = resolve(s.out)
    mkdirSync(dirname(out), { recursive: true })
    if (s.selector) await page.locator(s.selector).first().screenshot({ path: out })
    else await page.screenshot({ path: out, fullPage: Boolean(s.full) })
    const dom = s.dom ? writeOut(s.dom, await domText(page, s.selector)) : undefined
    return { url: s.url, out, width, height, ...(dom ? { dom } : {}) }
  } finally {
    await context.close()
  }
}

// Only the text snapshot, for a pair in dom mode.
async function snapshot(browser, s, det) {
  const { context, page } = await openPage(browser, s, det)
  try {
    return writeOut(s.dom, await domText(page, s.selector))
  } finally {
    await context.close()
  }
}

// The diff runs inside the browser on canvases, so it needs no image
// library: changed pixels are painted red over a faded copy of the original.
async function diff(browser, a, b, out, threshold) {
  const page = await browser.newPage()
  const result = await page.evaluate(
    async ({ a, b, threshold }) => {
      const load = (src) =>
        new Promise((res, rej) => {
          const i = new Image()
          i.onload = () => res(i)
          i.onerror = rej
          i.src = src
        })
      const [ia, ib] = await Promise.all([load(`data:image/png;base64,${a}`), load(`data:image/png;base64,${b}`)])
      const w = Math.max(ia.width, ib.width)
      const h = Math.max(ia.height, ib.height)
      const pixels = (img) => {
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const x = c.getContext('2d')
        x.fillStyle = '#fff'
        x.fillRect(0, 0, w, h)
        x.drawImage(img, 0, 0)
        return x.getImageData(0, 0, w, h).data
      }
      const da = pixels(ia)
      const db = pixels(ib)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      const od = ctx.createImageData(w, h)
      const limit = threshold * 765
      let changed = 0
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])
        if (d > limit) {
          changed++
          od.data[i] = 230
          od.data[i + 1] = 20
          od.data[i + 2] = 60
        } else {
          const v = 255 - (255 - (da[i] + da[i + 1] + da[i + 2]) / 3) * 0.2
          od.data[i] = od.data[i + 1] = od.data[i + 2] = v
        }
        od.data[i + 3] = 255
      }
      ctx.putImageData(od, 0, 0)
      return {
        width: w,
        height: h,
        changed,
        total: w * h,
        sizeMismatch: ia.width !== ib.width || ia.height !== ib.height,
        png: canvas.toDataURL('image/png').split(',')[1],
      }
    },
    { a: readFileSync(a).toString('base64'), b: readFileSync(b).toString('base64'), threshold },
  )
  await page.close()
  mkdirSync(dirname(resolve(out)), { recursive: true })
  writeFileSync(resolve(out), Buffer.from(result.png, 'base64'))
  const { png, ...stats } = result
  return { a, b, out: resolve(out), ...stats, percent: percent(stats.changed, stats.total) }
}

// One side of a pair: a URL is shot (or snapshotted) into the pair's files, a
// path is used where it is.
async function pairSide(browser, pair, which, files) {
  const src = pair[which]
  if (!isUrl(src)) {
    if (!existsSync(src)) throw new Error(`no such file: ${src}`)
    return resolve(src)
  }
  const s = { url: src, width: pair.width, height: pair.height, scheme: pair.scheme, selector: pair.selector, full: pair.full, wait: flags.wait }
  if (pair.mode === 'dom') return snapshot(browser, { ...s, dom: files[which] }, DETERMINISTIC)
  return (await shoot(browser, { ...s, out: files[which] }, DETERMINISTIC)).out
}

async function runPair(browser, pair, { out, threshold, maxDiff }) {
  const files = pairFiles(out, pair.name, pair.mode)
  const a = await pairSide(browser, pair, 'a', files)
  const b = await pairSide(browser, pair, 'b', files)
  if (pair.mode === 'dom') {
    const { diff: text, linesA, linesB, changed, total, percent: pct } = compareText(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'))
    const { ok, reasons } = verdict({ changed, total }, maxDiff)
    return { name: pair.name, mode: 'dom', a, b, diff: writeOut(files.diff, text ? `${text}\n` : ''), linesA, linesB, changed, total, percent: pct, ok, ...(ok ? {} : { reasons }) }
  }
  const stats = await diff(browser, a, b, files.diff, threshold)
  const sizes = [a, b].map((f) => pngSize(readFileSync(f))).map((z) => (z ? `${z.width}x${z.height}` : 'unknown'))
  const { ok, reasons } = verdict({ ...stats, sizes }, maxDiff)
  const { out: diffFile, a: _a, b: _b, ...numbers } = stats
  return { name: pair.name, mode: 'pixel', a, b, diff: diffFile, ...numbers, ok, ...(ok ? {} : { reasons }) }
}

// A pairs file that cannot be run stops here, before a browser starts.
function readPairs() {
  if (flags.pairs === true || !flags.out || flags.out === true) fail('usage: shoot.mjs --pairs <pairs.json> --out <dir> [--max-diff 0] [--threshold 0.05]')
  const file = resolve(flags.pairs)
  if (!existsSync(file)) fail(`no such pairs file: ${flags.pairs}`)
  let list
  try {
    list = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    fail(`${flags.pairs} is not valid JSON: ${err.message}`)
  }
  const { pairs, problems } = parsePairs(list, { width: flags.width, height: flags.height, scheme: flags.scheme, full: flags.full })
  if (problems.length) fail(`${flags.pairs}: ${problems.join('; ')}`)
  const maxDiff = Number(flags['max-diff'] ?? 0)
  if (!Number.isFinite(maxDiff) || maxDiff < 0) fail('--max-diff is a percentage, 0 or more')
  return { pairs, out: resolve(flags.out), maxDiff, threshold: Number(flags.threshold ?? 0.05) }
}

let jobs
if (flags.diff) {
  const { a, b } = diffArgs(args, flags)
  if (!a || !b || !flags.out) fail('usage: shoot.mjs --diff <a.png> <b.png> --out <diff.png> [--threshold 0.05]')
  for (const f of [a, b]) if (!existsSync(f)) fail(`no such image: ${f}`)
  jobs = { diff: { a, b, out: flags.out, threshold: Number(flags.threshold ?? 0.05) } }
} else if (flags.pairs) {
  jobs = { pairs: readPairs() }
} else if (flags.batch) {
  jobs = { shots: JSON.parse(readFileSync(resolve(flags.batch), 'utf8')) }
} else if (flags.url && flags.out) {
  jobs = { shots: [flags] }
} else {
  fail('usage: shoot.mjs --url <url> --out <file.png> | --batch <shots.json> | --diff <a.png> <b.png> --out <diff.png> | --pairs <pairs.json> --out <dir>')
}

const chromium = await chromiumOrExit()
const browser = await chromium.launch()
try {
  if (jobs.diff) {
    const { a, b, out, threshold } = jobs.diff
    process.stdout.write(`${JSON.stringify(await diff(browser, a, b, out, threshold))}\n`)
  } else if (jobs.pairs) {
    const results = []
    for (const pair of jobs.pairs.pairs) {
      let line
      try {
        line = await runPair(browser, pair, jobs.pairs)
      } catch (err) {
        // one pair that cannot load must not hide the others
        line = { name: pair.name, mode: pair.mode, ok: false, error: err.message }
      }
      results.push(line)
      process.stdout.write(`${JSON.stringify(line)}\n`)
    }
    const summary = summarise(results, jobs.pairs.maxDiff)
    process.stdout.write(`${JSON.stringify(summary)}\n`)
    if (!summary.ok) process.exitCode = 1
  } else {
    const base = determinism(flags)
    for (const s of jobs.shots) process.stdout.write(`${JSON.stringify(await shoot(browser, s, determinism(s, base)))}\n`)
  }
} finally {
  await browser.close()
}
