// A stand-in for Playwright that records what shoot.mjs asks of it, so the
// script's flow can be tested without a browser. The test copies this file to
// <folder>/node_modules/playwright/index.js.
//
//   FAKE_LOG        a file that receives one JSON line per call
//   FAKE_CHANGED    the changed-pixel count the in-browser diff reports
//   FAKE_MISMATCH   1 to report the two images as different sizes
//   FAKE_LAZY       n: the page holds a chain of n lazy iframes, each inside the
//                   one before; a frame wakes its child the first time it is asked
//   FAKE_UNLOADED   1: a woken frame reports that it did not load in time
//   FAKE_NO_MATCH   1: a selector matches nothing (waiting for it times out)
//   FAKE_ARIA_FAIL  1: the accessibility snapshot fails
//   FAKE_NO_ARIA    1: an older Playwright, with no accessibility snapshot
//   The sweep: each of these is a comma-separated list of texts, and a page
//   whose URL holds one of them behaves as named.
//   FAKE_SWEEP_NOMATCH  the ready selector never matches
//   FAKE_SWEEP_EMPTY    the ready element matches but holds no element (the
//                       story's mount is empty; the sweep's own check decides)
//   FAKE_SWEEP_ERROR    a page error fires while the page loads
//   FAKE_SWEEP_FAILED   the page is ready, then marks <html data-story-error>
//   FAKE_SLOW           (also a list) goto takes 300 ms and logs gotoEnd
const { appendFileSync, writeFileSync } = require('node:fs')

const log = (name, arg) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ name, arg })}\n`)
}

const timeout = (what) => Object.assign(new Error(`${what}: Timeout 5000ms exceeded.`), { name: 'TimeoutError' })

// The 24 bytes shoot.mjs reads a size from: signature, IHDR length, IHDR, 2 x 2.
const PNG = Buffer.alloc(33)
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(PNG)
PNG.writeUInt32BE(13, 8)
PNG.write('IHDR', 12)
PNG.writeUInt32BE(2, 16)
PNG.writeUInt32BE(2, 20)

const shot = (o) => {
  log('screenshot', { fullPage: o.fullPage, animations: o.animations })
  writeFileSync(o.path, PNG)
}

// The element a locator points at.
const element = (selector) => ({
  screenshot: async (o) => shot(o),
  waitFor: async (o) => {
    log('waitFor', { selector, ...o })
    if (process.env.FAKE_NO_MATCH === '1') throw timeout('locator.waitFor')
  },
  evaluate: async () => `<main data-from="${selector}"></main>`,
  ...(process.env.FAKE_NO_ARIA === '1'
    ? {}
    : {
        ariaSnapshot: async (o) => {
          log('ariaSnapshot', o)
          if (process.env.FAKE_ARIA_FAIL === '1') throw timeout('locator.ariaSnapshot')
          return `tree of ${selector}`
        },
      }),
})

// Whether the page's URL holds one of the texts an environment variable lists.
const listed = (name, url) => (process.env[name] ?? '').split(',').some((t) => t && url.includes(t))

const makePage = () => {
  const depth = Number(process.env.FAKE_LAZY ?? 0)
  const frames = []
  const handlers = {}
  let current = ''
  const addFrame = (level) => {
    const frame = {
      level,
      url: () => `http://x.test/frame${level}`,
      async evaluate(fn) {
        if (fn.name === 'wakeLazy') {
          log('wake', { level })
          if (level < depth && !frame.child) {
            frame.child = addFrame(level + 1)
            return { woke: 1, unloaded: process.env.FAKE_UNLOADED === '1' ? 1 : 0 }
          }
          return { woke: 0, unloaded: 0 }
        }
        log('fonts', { level })
        return true
      },
      async waitForLoadState(state, options) {
        log('loaded', { level, state, timeout: options?.timeout })
      },
    }
    frames.push(frame)
    return frame
  }
  addFrame(0)
  return {
    async goto(url) {
      current = url
      log('goto', url)
      if (listed('FAKE_SLOW', url)) {
        await new Promise((done) => setTimeout(done, 300))
        log('gotoEnd', url)
      }
      if (listed('FAKE_SWEEP_ERROR', url)) handlers.pageerror?.(new Error('boom'))
    },
    on(event, fn) {
      handlers[event] = fn
    },
    async waitForSelector(selector, o) {
      log('waitForSelector', { selector, ...o })
      if (listed('FAKE_SWEEP_NOMATCH', current)) throw timeout('page.waitForSelector')
    },
    // The predicate runs against a small document: <html> holding a head and
    // a body, whose one child is the mount, empty under FAKE_SWEEP_EMPTY.
    async waitForFunction(fn, arg, o) {
      log('waitForFunction', { arg, ...o })
      const node = (tagName, children = []) => ({ tagName, children, childElementCount: children.length })
      const mount = node('DIV', listed('FAKE_SWEEP_EMPTY', current) ? [] : [node('MAIN')])
      const body = node('BODY', [node('SCRIPT'), mount])
      const html = node('HTML', [node('HEAD'), body])
      const had = globalThis.document
      globalThis.document = { documentElement: html, body, querySelector: (sel) => (sel.startsWith('html') ? html : mount) }
      try {
        if (!fn(arg)) throw timeout('page.waitForFunction')
      } finally {
        globalThis.document = had
      }
    },
    // The sweep's settle step runs here and says whether the page is marked as failed.
    // Otherwise only the diff comes here; the shot settle step works frame by frame.
    async evaluate(fn, arg) {
      if (fn.name === 'sweepSettle') {
        log('sweepSettle', arg)
        return listed('FAKE_SWEEP_FAILED', current)
      }
      log('diff', { threshold: arg.threshold })
      return {
        width: 2,
        height: 2,
        changed: Number(process.env.FAKE_CHANGED ?? 0),
        total: 4,
        sizeMismatch: process.env.FAKE_MISMATCH === '1',
        png: PNG.toString('base64'),
      }
    },
    frames: () => frames.slice(),
    screenshot: async (o) => shot(o),
    locator: (selector) => ({ first: () => element(selector) }),
    content: async () => '<html></html>',
    async waitForTimeout(ms) {
      log('wait', ms)
    },
    async close() {},
  }
}

const context = {
  newPage: async () => makePage(),
  async addInitScript(fn, arg) {
    log('addInitScript', typeof arg)
  },
  async close() {
    log('contextClose')
  },
}

const browser = {
  async newContext(options) {
    log('newContext', options)
    return context
  },
  newPage: async () => makePage(),
  async close() {
    log('close')
  },
}

module.exports = {
  chromium: {
    async launch() {
      log('launch')
      return browser
    },
  },
}
