// A stand-in for Playwright that records what shoot.mjs asks of it, so the
// script's flow can be tested without a browser. The test copies this file to
// <folder>/node_modules/playwright/index.js.
//
//   FAKE_LOG       a file that receives one JSON line per call
//   FAKE_CHANGED   the changed-pixel count the in-browser diff reports
//   FAKE_MISMATCH  1 to report the two images as different sizes
const { appendFileSync, writeFileSync } = require('node:fs')

const log = (name, arg) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ name, arg })}\n`)
}

// The 24 bytes shoot.mjs reads a size from: signature, IHDR length, IHDR, 2 x 2.
const PNG = Buffer.alloc(33)
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(PNG)
PNG.writeUInt32BE(13, 8)
PNG.write('IHDR', 12)
PNG.writeUInt32BE(2, 16)
PNG.writeUInt32BE(2, 20)

const shot = (o) => {
  log('screenshot', { fullPage: o.fullPage })
  writeFileSync(o.path, PNG)
}

const page = {
  async goto(url) {
    log('goto', url)
  },
  // The diff passes an object; the settle step passes the time limit.
  async evaluate(fn, arg) {
    if (arg && typeof arg === 'object') {
      log('diff', { threshold: arg.threshold })
      return {
        width: 2,
        height: 2,
        changed: Number(process.env.FAKE_CHANGED ?? 0),
        total: 4,
        sizeMismatch: process.env.FAKE_MISMATCH === '1',
        png: PNG.toString('base64'),
      }
    }
    log('settle', arg)
    return 0
  },
  frames: () => [],
  screenshot: async (o) => shot(o),
  locator: (selector) => ({
    first: () => ({ screenshot: async (o) => shot(o), ariaSnapshot: async () => `tree of ${selector}` }),
  }),
  content: async () => '<html></html>',
  async waitForTimeout(ms) {
    log('wait', ms)
  },
  async close() {},
}

const context = {
  newPage: async () => page,
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
  newPage: async () => page,
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
