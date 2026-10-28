#!/usr/bin/env node
// Screenshots and pixel diffs through the repo's own Playwright, so tidy
// batches and translations can be checked as before/after images instead of
// by eye. Exits 3 when Playwright is not installed; skills then fall back to
// the host's browser tools.
//
//   shoot.mjs --url <url> --out <file.png> [--width 1280] [--height 800] [--full] [--scheme light|dark] [--wait 300] [--selector <css>]
//   shoot.mjs --batch <shots.json>      (array of { url, out, width, height, full, scheme, wait, selector })
//   shoot.mjs --diff <a.png> <b.png> --out <diff.png> [--threshold 0.05]
//
// Prints one JSON line per shot or diff.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fail, findRoot, parseArgs } from './lib/project.mjs'

const { _: args, flags } = parseArgs()
const root = flags.root ? resolve(flags.root) : findRoot()

async function loadChromium() {
  const require = createRequire(join(root, 'package.json'))
  for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
    try {
      const mod = await import(pathToFileURL(require.resolve(name)).href)
      const chromium = mod.chromium ?? mod.default?.chromium
      if (chromium) return chromium
    } catch {
      // try the next one
    }
  }
  process.stderr.write(
    'massimo: Playwright is not installed in this repo. Install it (npm i -D playwright && npx playwright install chromium), or capture with your browser tool.\n',
  )
  process.exit(3)
}

async function shoot(browser, s) {
  const width = Number(s.width ?? 1280)
  const height = Number(s.height ?? 800)
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: s.scheme ?? 'light', deviceScaleFactor: 1 })
  const page = await context.newPage()
  await page.goto(s.url, { waitUntil: 'networkidle' })
  if (s.wait) await page.waitForTimeout(Number(s.wait))
  const out = resolve(s.out)
  mkdirSync(dirname(out), { recursive: true })
  if (s.selector) await page.locator(s.selector).first().screenshot({ path: out })
  else await page.screenshot({ path: out, fullPage: Boolean(s.full) })
  await context.close()
  return { url: s.url, out, width, height }
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
  return { a, b, out: resolve(out), ...stats, percent: Number(((stats.changed / stats.total) * 100).toFixed(3)) }
}

let jobs
if (flags.diff) {
  const a = flags.diff === true ? args[0] : flags.diff
  const b = flags.diff === true ? args[1] : args[0]
  if (!a || !b || !flags.out) fail('usage: shoot.mjs --diff <a.png> <b.png> --out <diff.png> [--threshold 0.05]')
  for (const f of [a, b]) if (!existsSync(f)) fail(`no such image: ${f}`)
  jobs = { diff: { a, b, out: flags.out, threshold: Number(flags.threshold ?? 0.05) } }
} else if (flags.batch) {
  jobs = { shots: JSON.parse(readFileSync(resolve(flags.batch), 'utf8')) }
} else if (flags.url && flags.out) {
  jobs = { shots: [flags] }
} else {
  fail('usage: shoot.mjs --url <url> --out <file.png> | --batch <shots.json> | --diff <a.png> <b.png> --out <diff.png>')
}

const chromium = await loadChromium()
const browser = await chromium.launch()
try {
  if (jobs.diff) {
    const { a, b, out, threshold } = jobs.diff
    process.stdout.write(`${JSON.stringify(await diff(browser, a, b, out, threshold))}\n`)
  } else {
    for (const s of jobs.shots) process.stdout.write(`${JSON.stringify(await shoot(browser, s))}\n`)
  }
} finally {
  await browser.close()
}
