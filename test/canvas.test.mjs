// The canvas frames mockups in a sandbox, reads only files inside each round
// folder, and inlines the kit as text.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { SCRIPTS, read } from './helpers.mjs'

const base = mkdtempSync(join(tmpdir(), 'massimo-canvas-'))
after(() => rmSync(base, { recursive: true, force: true }))
const topic = join(base, 'design-system', 'explorations', 'checkout')
const round = join(topic, 'round-1')
mkdirSync(round, { recursive: true })
mkdirSync(join(base, 'design-system', 'kit'), { recursive: true })
writeFileSync(join(base, 'design-system', 'kit', 'kit.css'), ':root { --x: "$&"; } /* $\' </style> */')
writeFileSync(join(base, 'secret.html'), '<p>outside</p>')
writeFileSync(join(round, 'Main.html'), '<link rel="stylesheet" href="../../../kit/kit.css"><p>main</p>')
writeFileSync(join(round, 'Live.html'), '<p>live</p><script>1</script>')
writeFileSync(
  join(round, 'round.json'),
  JSON.stringify({
    dir: '../../..',
    n: 99,
    directions: [
      { title: 'Main', file: 'Main.html' },
      { title: 'Live', file: 'Live.html', scripts: true },
      { title: 'Escape', file: '../../../../secret.html' },
      { title: 'Missing', file: 'Nope.html' },
    ],
  }),
)

const r = spawnSync(process.execPath, [join(SCRIPTS, 'canvas.mjs'), topic, '--inline'], { encoding: 'utf8' })

test('canvas builds, skipping directions outside the round folder', () => {
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /skipped a direction in round-1\/round\.json: "\.\.\/\.\.\/\.\.\/\.\.\/secret\.html"/)
  assert.match(r.stderr, /"Nope\.html" is not an \.html file in that folder/)
  const html = read(topic, 'index.html')
  assert.ok(!html.includes('secret'))
  assert.match(html, /<h2>Round 1<\/h2>/) // round.json cannot rename the round
  assert.match(html, /src="round-1\/Main\.html"/) // nor move it
})

test('frames are sandboxed; scripts only run where asked, and never with the same origin', () => {
  const html = read(topic, 'index.html')
  assert.match(html, /sandbox="allow-same-origin"[^>]*src="round-1\/Main\.html"/)
  assert.match(html, /sandbox="allow-scripts"[^>]*src="round-1\/Live\.html"/)
  assert.ok(!/allow-scripts allow-same-origin|allow-same-origin allow-scripts/.test(html))
  assert.match(html, /interactive, theme switch off/)
})

test('the inline kit is text: $& stays as written and cannot close the style block', () => {
  const inline = read(topic, 'index.inline.html')
  assert.match(inline, /--x: &quot;\$&amp;&quot;/)
  assert.match(inline, /\$&#39;|\$'/)
  assert.match(inline, /&lt;\\\/style&gt;/)
})
