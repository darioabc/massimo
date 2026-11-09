#!/usr/bin/env node
// Screenshots and pixel diffs through Playwright, so tidy batches, translations
// and cutovers can be checked as before/after images instead of by eye. Exits 3
// when Playwright cannot be found; skills then fall back to the host's browser
// tools.
//
//   shoot.mjs --url <url> --out <file.png> [--width 1280] [--height 800] [--full] [--scheme light|dark] [--wait 300] [--selector <css>] [--dom <file.txt>]
//   shoot.mjs --batch <shots.json>      (array of { url, out, width, height, full, scheme, wait, selector, dom })
//   shoot.mjs --diff <a.png> <b.png> --out <diff.png> [--threshold 0.05]
//   shoot.mjs --pairs <pairs.json> --out <dir> [--max-diff 0] [--threshold 0.05] [--workers 4]
//   shoot.mjs --sweep <base url> [--legacy | --routes <file>] [--ids-from <meta.json>] [--ready <selector>]
//             [--sweep-baseline <results.json>] [--workers 4] [--timeout 15] [--wait 500]
//
// --dom also saves what the page holds as text (its accessibility tree, or its
// HTML on an older Playwright), for reviewers who read a render without a browser.
//
// --pairs takes an array of { name, a, b, width, height, scheme, selector, full,
// mode, reducedMotion, settle, freeze }, or { "format": 1, "pairs": [...] }, where
// a and b are URLs or paths. Two URLs are shot and diffed; two PNG paths are only
// diffed. Files land in --out as <name>.a.png, <name>.b.png and <name>.diff.png.
// Names are compared without case. mode "dom" compares each page's text snapshot
// instead of its pixels, for pages with live motion that no freeze can hold still:
// the files are <name>.a.txt, <name>.b.txt and <name>.diff.txt, and a and b may be
// snapshot paths too. A selector that matches nothing fails the pair. The snapshot
// does not read inside iframes: point a pair at the frame's own route to compare
// framed content. It prints one JSON line per pair, then a summary line.
// --width, --height, --scheme and --full set the defaults a pair does not state,
// and --wait and --threshold apply to every pair. --max-diff is a percentage from
// 0 to 100 (default 0); --threshold is a fraction from 0 up to, but not including,
// 1 of the largest colour distance a pixel may move before it counts as changed.
//
// Determinism, for shots that must come out the same twice:
//   --reduced-motion  emulate prefers-reduced-motion: reduce
//   --settle          wake the lazy iframes and images in every frame, round by
//                     round until nothing is left, and wait for each frame to
//                     load and for its fonts
//   --freeze          stop CSS animations in every frame, have Playwright finish
//                     transitions and Web Animations at the screenshot, and
//                     bypass the page's Content-Security-Policy so the style fits
// --pairs turns all three on; --freeze=false and the like, or "freeze": false in a
// pair, turn one off. Motion driven by script (canvas, WebGL, a rotating hero) is
// not held still by any of them; compare those with mode "dom".
//
// --playwright <path> loads Playwright from another checkout instead of the
// repo's own install. The path is a package folder (node_modules/playwright), a
// node_modules folder or a repo root. It is imported in place, never linked.
//
// --sweep opens every story state of a server, each in a fresh browser context, and
// prints { base, total, ready, failed: [{ id, why }], excused } as one JSON line. A state
// passes when --ready (default html[data-story-ready]) matches, the matched element holds an
// element child, and no page error fired before the timeout (seconds, default 15). Then it
// waits two animation frames and --wait (milliseconds, default 500 here) and fails the state
// when html[data-story-error] is set, which a state that fails in an effect sets. A state
// marked that way is failed at once, without waiting for the ready selector. The ids
// come from --ids-from (the stories keys of a Ladle-shaped meta.json), else from the server's
// own /meta.json. --legacy loads each as /?story=<id>&mode=preview; --routes names a JSON
// file of { "<id>": "<path>" } to load instead, and gives the ids when --ids-from does not.
// --sweep-baseline takes the result of an earlier sweep: a failure it also had is excused,
// but only if that baseline reached 98% ready; below that nothing is excused. --workers is
// how many states load at once. Exit 1 when a state failed and was not excused.
//
// --pairs also takes --workers: how many pairs run at once (default 4), printed in file order.
//
// Exit codes:
//   0  every pair is within --max-diff, or the shots and diff were made
//   1  a pair is over --max-diff or could not run (the older modes also use 1
//      for a usage error)
//   2  a --pairs or --sweep usage or file error, or --playwright without one path
//   3  no Playwright
//
// Prints one JSON line per shot, diff or pair.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fail, findRoot, parseArgs, refuseNewer } from './lib/project.mjs'
import {
  DETERMINISTIC,
  FREEZE_CSS,
  compareText,
  determinism,
  diffArgs,
  flagNumber,
  isUrl,
  loadChromium,
  idsOfMeta,
  pairFiles,
  pairsDocument,
  parsePairs,
  percent,
  pngSize,
  summarise,
  SWEEP_FILLED,
  SWEEP_MARKED,
  sweepErrored,
  sweepFrames,
  sweepOptions,
  sweepResult,
  sweepUrl,
  verdict,
  within,
} from './lib/shoot.mjs'

const { _: args, flags } = parseArgs()
if ('playwright' in flags && (typeof flags.playwright !== 'string' || !flags.playwright)) fail('--playwright takes one path', 2)
const root = flags.root ? resolve(flags.root) : findRoot()

// How long settling waits for lazy content and for a frame to load, and how
// long a pair's dom selector is waited for.
const SETTLE_LIMIT = 15000
const SELECTOR_WAIT = 5000

async function chromiumOrExit() {
  const playwright = flags.playwright
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

// Runs in a frame: switches the lazy iframes and images it holds to eager and
// waits, up to `limit` milliseconds, for the ones that had not loaded. Resolves
// with how many it started and how many were still unloaded. An iframe that
// already holds its document never fires `load` again, so only a blank one with
// something to load is waited for. A cross-origin frame refuses the look and
// has loaded already.
async function wakeLazy(limit) {
  const waits = []
  for (const el of document.querySelectorAll('iframe[loading="lazy"], img[loading="lazy"]')) {
    let pending = false
    if (el.tagName === 'IMG') pending = !el.complete
    else {
      const src = el.getAttribute('src') ?? ''
      try {
        pending = el.contentWindow.location.href === 'about:blank' && ((src !== '' && src !== 'about:blank') || el.hasAttribute('srcdoc'))
      } catch {
        pending = false
      }
    }
    if (pending) {
      waits.push(
        new Promise((res) => {
          el.addEventListener('load', res, { once: true })
          el.addEventListener('error', res, { once: true })
        }),
      )
    }
    el.setAttribute('loading', 'eager')
  }
  let left = waits.length
  for (const p of waits) p.then(() => left--)
  await Promise.race([Promise.all(waits), new Promise((res) => setTimeout(res, limit))])
  return { woke: waits.length, unloaded: left }
}

const gone = (err) => /detached|closed|destroyed/i.test(err.message)

// Lazy content, iframes and fonts, so a shot does not catch the page half drawn.
async function settle(page) {
  const deadline = Date.now() + SETTLE_LIMIT
  // A frame woken in one round can hold lazy content of its own, which only the
  // next round finds, so go round again until a whole round wakes nothing.
  for (;;) {
    let woke = 0
    let unloaded = 0
    for (const frame of page.frames()) {
      try {
        const r = await frame.evaluate(wakeLazy, Math.max(deadline - Date.now(), 0))
        woke += r.woke
        unloaded += r.unloaded
      } catch (err) {
        // a frame that went away while settling has nothing to wait for
        if (!gone(err)) throw err
      }
    }
    if (unloaded) throw new Error(`${unloaded} lazy ${unloaded === 1 ? 'iframe or image' : 'iframes or images'} did not load within ${SETTLE_LIMIT / 1000} seconds`)
    if (!woke) break
    if (Date.now() >= deadline) throw new Error(`lazy content was still appearing after ${SETTLE_LIMIT / 1000} seconds`)
  }
  for (const frame of page.frames()) {
    // a frame that never navigated has nothing to load
    if (!frame.url()) continue
    try {
      await frame.waitForLoadState('load', { timeout: SETTLE_LIMIT })
      await frame.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true))
    } catch (err) {
      if (err.name === 'TimeoutError') throw new Error(`the frame at ${frame.url()} did not finish loading within ${SETTLE_LIMIT / 1000} seconds`)
      if (!gone(err)) throw err
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
    // the freeze style is injected, which a page's Content-Security-Policy may refuse
    ...(det.freeze ? { bypassCSP: true } : {}),
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
// older Playwright. `strict` is for a pair, whose pass or fail rests on it: a
// selector that matches nothing is an error, and so is a snapshot that fails,
// where the --dom flag falls back to the whole page's HTML.
async function domText(page, selector, strict = false) {
  const scope = page.locator(selector ?? 'body').first()
  if (strict && selector) {
    try {
      await scope.waitFor({ state: 'attached', timeout: SELECTOR_WAIT })
    } catch (err) {
      if (err.name !== 'TimeoutError') throw err
      throw new Error(`selector matched nothing: ${selector}`)
    }
  }
  if (typeof scope.ariaSnapshot !== 'function') return strict && selector ? scope.evaluate((el) => el.outerHTML) : page.content()
  if (strict) return scope.ariaSnapshot({ timeout: SELECTOR_WAIT })
  return (await scope.ariaSnapshot().catch(() => null)) ?? (await page.content())
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
    // finish transitions and stop endless animations, whatever the page runs
    const still = det.freeze ? { animations: 'disabled' } : {}
    if (s.selector) await page.locator(s.selector).first().screenshot({ path: out, ...still })
    else await page.screenshot({ path: out, fullPage: Boolean(s.full), ...still })
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
    return writeOut(s.dom, await domText(page, s.selector, true))
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
async function pairSide(browser, pair, which, files, det) {
  const src = pair[which]
  if (!isUrl(src)) {
    if (!existsSync(src)) throw new Error(`no such file: ${src}`)
    return resolve(src)
  }
  const s = { url: src, width: pair.width, height: pair.height, scheme: pair.scheme, selector: pair.selector, full: pair.full, wait: flags.wait }
  if (pair.mode === 'dom') return snapshot(browser, { ...s, dom: files[which] }, det)
  return (await shoot(browser, { ...s, out: files[which] }, det)).out
}

async function runPair(browser, pair, { out, threshold, maxDiff }) {
  const files = pairFiles(out, pair.name, pair.mode)
  // all three controls are on unless the flags or the pair say otherwise
  const det = determinism(pair, determinism(flags, DETERMINISTIC))
  const a = await pairSide(browser, pair, 'a', files, det)
  const b = await pairSide(browser, pair, 'b', files, det)
  if (pair.mode === 'dom') {
    const { diff: text, linesA, linesB, changed, total, percent: pct, aligned } = compareText(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'))
    const { ok, reasons } = verdict({ changed, total }, maxDiff)
    const line = { name: pair.name, mode: 'dom', a, b, diff: writeOut(files.diff, text ? `${text}\n` : ''), linesA, linesB, changed, total, percent: pct }
    return { ...line, ...(aligned ? {} : { aligned: false }), ok, ...(ok ? {} : { reasons }) }
  }
  const stats = await diff(browser, a, b, files.diff, threshold)
  const sizes = [a, b].map((f) => pngSize(readFileSync(f))).map((z) => (z ? `${z.width}x${z.height}` : 'unknown'))
  const { ok, reasons } = verdict({ ...stats, sizes }, maxDiff)
  const { out: diffFile, a: _a, b: _b, ...numbers } = stats
  return { name: pair.name, mode: 'pixel', a, b, diff: diffFile, ...numbers, ok, ...(ok ? {} : { reasons }) }
}

// A pairs file that cannot be run stops here, before a browser starts, with exit
// 2 so CI can tell a broken file from a pair over the limit.
function readPairs() {
  if (typeof flags.pairs !== 'string' || typeof flags.out !== 'string') fail('usage: shoot.mjs --pairs <pairs.json> --out <dir> [--max-diff 0] [--threshold 0.05] [--workers 4]', 2)
  const file = resolve(flags.pairs)
  if (!existsSync(file)) fail(`no such pairs file: ${flags.pairs}`, 2)
  let doc
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    fail(`${flags.pairs} is not valid JSON: ${err.message}`, 2)
  }
  const { list, format, problems: shape } = pairsDocument(doc)
  refuseNewer('pairs', format, flags.pairs, 2)
  if (shape.length) fail(`${flags.pairs}: ${shape.join('; ')}`, 2)
  const { pairs, problems } = parsePairs(list, { width: flags.width, height: flags.height, scheme: flags.scheme, full: flags.full })
  if (problems.length) fail(`${flags.pairs}: ${problems.join('; ')}`, 2)
  const maxDiff = flagNumber(flags['max-diff'], 0)
  if (!(maxDiff >= 0 && maxDiff <= 100)) fail('--max-diff is a percentage from 0 to 100', 2)
  const threshold = flagNumber(flags.threshold, 0.05)
  if (!(threshold >= 0 && threshold < 1)) fail('--threshold is a fraction from 0 up to, but not including, 1 (default 0.05); --max-diff is the percentage', 2)
  const workers = flagNumber(flags.workers, 4)
  if (!Number.isInteger(workers) || workers < 1 || workers > 32) fail('--workers is a whole number from 1 to 32', 2)
  return { pairs, out: resolve(flags.out), maxDiff, threshold, workers }
}

// A JSON file named by a flag, or exit 2.
function jsonFlag(name) {
  const file = resolve(flags[name])
  if (!existsSync(file)) fail(`no such file: ${flags[name]}`, 2)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return fail(`${flags[name]} is not valid JSON: ${err.message}`, 2)
  }
}

// The ids of a Ladle-shaped meta.json. One that massimo's own lane wrote, in
// a format newer than these scripts read, stops the sweep with exit 2.
function sweepIds(doc, where) {
  if (doc?.about?.generator === 'massimo') refuseNewer('registry', doc.about.format, where, 2)
  return idsOfMeta(doc)
}

// What the sweep needs, read before any browser starts: the options, the ids
// and where each loads, and the baseline. A server that answers nothing at
// all stops it here, once, instead of failing every state on its own.
async function readSweep() {
  const { options, problems } = sweepOptions(flags)
  if (!flags.legacy && !flags.routes) problems.push('--sweep needs --legacy (load /?story=<id>) or --routes <file> (a path for each id)')
  if (problems.length) fail(`usage: shoot.mjs --sweep <base url> [--legacy | --routes <file>] [--ids-from <meta.json>] [--ready <selector>] [--sweep-baseline <results.json>] [--workers 4] [--timeout 15] [--wait 500]: ${problems.join('; ')}`, 2)
  const routes = flags.routes ? jsonFlag('routes') : {}
  const given = flags['ids-from'] ? jsonFlag('ids-from') : null
  const baseline = flags['sweep-baseline'] ? jsonFlag('sweep-baseline') : null
  let ids = given ? sweepIds(given, flags['ids-from']) : null
  try {
    await fetch(options.base, { signal: AbortSignal.timeout(Math.min(options.timeout * 1000, 10000)) })
  } catch (err) {
    fail(`no server answers at ${options.base} (${err.cause?.code ?? err.message})`, 2)
  }
  if (!ids && flags.routes) ids = Object.keys(routes)
  else if (!ids) {
    try {
      ids = sweepIds(await (await fetch(`${options.base}/meta.json`)).json(), `${options.base}/meta.json`)
    } catch (err) {
      fail(`${options.base}/meta.json could not be read (${err.message}): name the ids with --ids-from <meta.json>`, 2)
    }
  }
  if (ids.length === 0) fail('the sweep found no ids to open', 2)
  return { ...options, ids, routes, baseline }
}

const SWEEP_ERROR = 'html[data-story-error] is set: the state failed'

// One state in a fresh browser context: ready, with an element inside the
// ready element, and after the wait no page error and no html[data-story-error].
// A state marked html[data-story-error] fails as soon as the mark is seen, even
// when it never became ready. The wait runs on this side, not in the page, and
// every step has a time limit, so a page that stubs timers or blocks its main
// thread fails its own state instead of the whole sweep.
async function sweepOne(browser, id, url, { ready, timeout, wait }) {
  if (url === null) return { id, ok: false, why: 'no route for this id' }
  const errors = []
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } })
  try {
    const page = await context.newPage()
    page.on('pageerror', (err) => errors.push(err.message))
    const limit = timeout * 1000
    const until = Date.now() + limit
    const erroredNow = async () => {
      const read = await within(page.evaluate(sweepErrored), limit)
      if (!read) throw new Error(`the page did not answer within ${timeout} seconds`)
      return read.value
    }
    try {
      await page.goto(url, { waitUntil: 'load', timeout: limit })
      await page.waitForFunction(SWEEP_MARKED, ready, { timeout: Math.max(until - Date.now(), 1) })
    } catch (err) {
      const why = err.name === 'TimeoutError' ? `${ready} did not match within ${timeout} seconds` : err.message.split('\n')[0]
      return { id, ok: false, why: errors.length ? `page error: ${errors[0]}; ${why}` : why }
    }
    try {
      if (await erroredNow()) return { id, ok: false, why: errors.length ? `page error: ${errors[0]}` : SWEEP_ERROR }
    } catch (err) {
      return { id, ok: false, why: errors.length ? `page error: ${errors[0]}` : err.message }
    }
    try {
      await page.waitForFunction(SWEEP_FILLED, ready, { timeout: Math.max(until - Date.now(), 1) })
    } catch (err) {
      if (err.name !== 'TimeoutError') return { id, ok: false, why: err.message.split('\n')[0] }
      return { id, ok: false, why: errors.length ? `page error: ${errors[0]}` : `${ready} matched but holds no element` }
    }
    let failed
    try {
      // The frames are a courtesy: a page that stubs them is not a failed state.
      await within(page.evaluate(sweepFrames), Math.min(1000, limit))
      await page.waitForTimeout(wait)
      failed = await erroredNow()
    } catch (err) {
      return { id, ok: false, why: errors.length ? `page error: ${errors[0]}` : err.message.split('\n')[0] }
    }
    if (errors.length) return { id, ok: false, why: `page error: ${errors[0]}` }
    return failed ? { id, ok: false, why: SWEEP_ERROR } : { id, ok: true }
  } catch (err) {
    return { id, ok: false, why: err.message.split('\n')[0] }
  } finally {
    await context.close()
  }
}

// Every id through `workers` loops at once, in the order given.
async function runSweep(browser, s) {
  const verdicts = new Array(s.ids.length)
  let next = 0
  const loop = async () => {
    while (next < s.ids.length) {
      const at = next++
      const id = s.ids[at]
      verdicts[at] = await sweepOne(browser, id, sweepUrl(s.base, id, { legacy: Boolean(s.legacy), routes: s.routes }), s)
    }
  }
  await Promise.all(Array.from({ length: Math.min(s.workers, s.ids.length) }, loop))
  return sweepResult(s.base, verdicts, s.baseline)
}

let jobs
if (flags.sweep !== undefined) {
  jobs = { sweep: await readSweep() }
} else if (flags.diff) {
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
  fail('usage: shoot.mjs --url <url> --out <file.png> | --batch <shots.json> | --diff <a.png> <b.png> --out <diff.png> | --pairs <pairs.json> --out <dir> | --sweep <base url> --legacy')
}

const chromium = await chromiumOrExit()
const browser = await chromium.launch()
try {
  if (jobs.sweep) {
    const result = await runSweep(browser, jobs.sweep)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.failed.length > 0) process.exitCode = 1
  } else if (jobs.diff) {
    const { a, b, out, threshold } = jobs.diff
    process.stdout.write(`${JSON.stringify(await diff(browser, a, b, out, threshold))}\n`)
  } else if (jobs.pairs) {
    // `workers` pairs at once; each line is printed once every pair before it has been
    const results = new Array(jobs.pairs.pairs.length)
    let next = 0
    let printed = 0
    const loop = async () => {
      while (next < results.length) {
        const at = next++
        const pair = jobs.pairs.pairs[at]
        let line
        try {
          line = await runPair(browser, pair, jobs.pairs)
        } catch (err) {
          // one pair that cannot load must not hide the others
          line = { name: pair.name, mode: pair.mode, ok: false, error: err.message }
        }
        results[at] = line
        while (printed < results.length && results[printed]) process.stdout.write(`${JSON.stringify(results[printed++])}\n`)
      }
    }
    await Promise.all(Array.from({ length: Math.min(jobs.pairs.workers, results.length) }, loop))
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
