// The csf lane's URLs: the index, a slug, a state, Ladle's own `?story=`
// links, and the query that carries preview mode, switches and args. The
// module imports nothing, since the plugin inlines its text for the browser.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { argsFromSearch, orderIds, parseLaneUrl, shellUrl, stateUrl } from '../scripts/lib/lane-route.mjs'
import { SCRIPTS } from './helpers.mjs'

const parsed = (pathname, search = '') => {
  const { kind, slug, state, selected, preview, switches, args, oldId } = parseLaneUrl(pathname, search)
  return { kind, slug, state, selected, preview, switches, args, oldId }
}
const base = { kind: 'missing', slug: null, state: null, selected: null, preview: false, switches: {}, args: {}, oldId: null }

test('the index, at / and at /stories, with the state the shell selects', () => {
  assert.deepEqual(parsed('/'), { ...base, kind: 'index' })
  assert.deepEqual(parsed('/stories'), { ...base, kind: 'index' })
  assert.deepEqual(parsed('/stories/'), { ...base, kind: 'index' })
  assert.deepEqual(parsed('/stories', '?s=patterns--cards--card--plain'), { ...base, kind: 'index', selected: 'patterns--cards--card--plain' })
})

test('a slug and a state, with preview mode, switches and args', () => {
  assert.deepEqual(parsed('/stories/patterns--cards--card'), { ...base, kind: 'slug', slug: 'patterns--cards--card' })
  assert.deepEqual(parsed('/stories/patterns--cards--card/with-footer', '?mode=preview&theme=dark&arg-size=lg'), {
    ...base,
    kind: 'state',
    slug: 'patterns--cards--card',
    state: 'with-footer',
    preview: true,
    switches: { theme: 'dark' },
    args: { size: 'lg' },
  })
  // A Ladle state can hold `--` of its own; the route keeps it whole.
  assert.deepEqual(parsed('/stories/pages--review--summary/state-b--admin/'), { ...base, kind: 'state', slug: 'pages--review--summary', state: 'state-b--admin' })
  assert.equal(parsed(`/stories/${encodeURIComponent('café')}/plain`).slug, 'café')
})

test("Ladle's links render in place: /?story=<id>, with mode=preview and args", () => {
  assert.deepEqual(parsed('/', '?story=patterns--cards--card--plain'), { ...base, kind: 'legacy', oldId: 'patterns--cards--card--plain' })
  assert.deepEqual(parsed('/', '?story=primitives--actions--button--sized&mode=preview&arg-size=lg'), {
    ...base,
    kind: 'legacy-preview',
    preview: true,
    args: { size: 'lg' },
    oldId: 'primitives--actions--button--sized',
  })
  assert.equal(parsed('/index.html', '?story=a--b').kind, 'legacy')
})

test('a path the lane does not serve is missing', () => {
  for (const path of ['/other', '/stories/a/b/c', '/storiesx', '/stories/%E0%A4%A/plain']) assert.equal(parsed(path).kind, 'missing', path)
})

test('state and shell URLs, and a round trip through the parser', () => {
  const entry = { slug: 'primitives--actions--button', state: 'log--in-button' }
  assert.equal(stateUrl(entry), '/stories/primitives--actions--button/log--in-button')
  assert.equal(stateUrl(entry, { preview: true, switches: { theme: 'dark', dir: null } }), '/stories/primitives--actions--button/log--in-button?mode=preview&theme=dark')
  assert.equal(stateUrl({}), '')
  assert.equal(shellUrl('pages--review--summary--state-b--admin'), '/stories?s=pages--review--summary--state-b--admin')
  const args = { size: 'lg', label: 'two words, 100%', count: 3, open: true, tags: ['a', 'b'] }
  const url = new URL(stateUrl(entry, { preview: true, switches: { theme: 'dark' }, args }), 'http://localhost')
  assert.deepEqual(parsed(url.pathname, url.search), {
    ...base,
    kind: 'state',
    ...entry,
    preview: true,
    switches: { theme: 'dark' },
    args: { size: 'lg', label: 'two words, 100%', count: '3', open: 'true', tags: '["a","b"]' },
  })
})

test("args from a query string, decoded as Ladle decodes them", () => {
  assert.deepEqual(argsFromSearch('?arg-size=lg&arg-is-open=true&mode=preview&arg-=x'), { size: 'lg', 'is-open': 'true' })
  // Ladle runs a value through encodeURI before the query encodes it again.
  assert.deepEqual(argsFromSearch('?arg-label=two%2520words'), { label: 'two words' })
  assert.deepEqual(argsFromSearch('?arg-share=100%25'), { share: '100%' })
  assert.deepEqual(argsFromSearch(''), {})
})

test("orderIds follows Ladle's storyOrder: prefixes before a *, exact ids otherwise, the rest after", () => {
  const ids = ['pages--home--plain', 'patterns--cards--card--plain', 'foundations--welcome--start-here', 'patterns--cards--card--with-footer', 'explorations--new-header--wide']
  assert.deepEqual(orderIds(ids, ['foundations--*', 'Patterns--Cards--Card--With-Footer', 'patterns--*', 'missing--id']), [
    'foundations--welcome--start-here',
    'patterns--cards--card--with-footer',
    'patterns--cards--card--plain',
    'pages--home--plain',
    'explorations--new-header--wide',
  ])
  assert.deepEqual(orderIds(ids, ['*']), ids)
  assert.deepEqual(orderIds(ids, null), ids)
})

test('the module runs with nothing imported, as the plugin inlines it', () => {
  const text = readFileSync(join(SCRIPTS, 'lib', 'lane-route.mjs'), 'utf8')
  assert.ok(!/^\s*import\b/m.test(text))
  const inlined = new Function(`${text.replace(/^export /gm, '')}\nreturn { parseLaneUrl, stateUrl }`)()
  assert.equal(inlined.parseLaneUrl('/stories/a/b', '').kind, 'state')
  assert.equal(inlined.stateUrl({ slug: 'a', state: 'b' }), '/stories/a/b')
})
