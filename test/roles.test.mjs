// Header roles and taxonomy placement: a repo's own ds: keys read through
// the roles massimo knows, and a file's group from its header, its path or
// its parked marker.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { headerRoles, keyRoles, knownKeys, placeFile, tierOf, tierOrder } from '../scripts/lib/roles.mjs'
import { extractRules } from '../scripts/lib/source.mjs'

const config = {
  graph: {
    extraKeys: ['owner'],
    keys: {
      inputs: 'definitions',
      styles: { role: 'list', under: 'src/styles' },
      theme: { role: 'scope', values: ['print', 'kiosk'] },
      breakpoint: 'breakpoint',
    },
  },
}

const read = (source) => {
  const { roles } = keyRoles(config)
  return headerRoles(extractRules(source, knownKeys(config)).entries, roles, { exists: (p) => p === 'src/styles/card.css' })
}

test('extractRules keeps every ds: line with its line number and a stray colon', () => {
  const { entries } = extractRules('// ds:group Primitives / Actions\n// ds:theme: print\nconst a = 1\n// ds:theme kiosk\n', ['theme'])
  assert.deepEqual(entries, [
    { key: 'group', value: 'Primitives / Actions', line: 1 },
    { key: 'theme', value: 'print', line: 2, colon: true },
    { key: 'theme', value: 'kiosk', line: 4 },
  ])
})

test('knownKeys joins the role keys and the plain extra keys', () => {
  assert.deepEqual(knownKeys(config), ['inputs', 'styles', 'theme', 'breakpoint', 'owner'])
})

test('an unknown role is reported, not guessed', () => {
  const { roles, problems } = keyRoles({ graph: { keys: { styles: 'stylesheet', inputs: 'definitions' } } })
  assert.deepEqual([...roles.keys()], ['inputs'])
  assert.match(problems[0], /graph\.keys\.styles has role "stylesheet"/)
})

test('definitions are custom property names, and anything else is a problem', () => {
  const r = read('// ds:inputs --gap, --edge\n// ds:inputs width\n')
  assert.deepEqual(r.definitions, ['--gap', '--edge'])
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0].message, /"width" is not one/)
  assert.equal(r.problems[0].line, 2)
})

test('a list item under a folder must exist there', () => {
  const r = read('// ds:styles card.css, missing.css\n')
  assert.deepEqual(r.lists, { styles: ['card.css'] })
  assert.match(r.problems[0].message, /"missing.css", which is not a file in src\/styles/)
})

test('a scope holds one value from its set, once', () => {
  assert.deepEqual(read('// ds:theme print\n').scopes, { theme: 'print' })
  assert.match(read('// ds:theme print\n// ds:theme kiosk\n').problems[0].message, /second time/)
  assert.match(read('// ds:theme poster\n').problems[0].message, /one of print, kiosk/)
  assert.match(read('// ds:theme\n').problems[0].message, /has no value/)
})

test('a breakpoint is a width and a reason', () => {
  assert.deepEqual(read('// ds:breakpoint 22.50rem the bar folds\n').breakpoints, [{ width: '22.5rem', reason: 'the bar folds' }])
  assert.match(read('// ds:breakpoint 22.5rem\n').problems[0].message, /a width and a reason/)
})

const taxonomy = {
  tiers: ['Primitives', 'Pages', 'Internal', 'Explorations'],
  rules: [
    { files: 'src/pages/index.astro', group: 'Pages / Home' },
    { files: ['src/pages/**/*.ts'], group: 'Internal / Endpoints' },
  ],
  parked: { marker: '@kept:', group: 'Explorations / Kept' },
}

test('a declared group wins, then the parked marker, then the first path rule', () => {
  assert.deepEqual(placeFile('src/pages/index.astro', '', 'Pages / Landing', taxonomy), { group: 'Pages / Landing', tier: 'Pages', derived: false, parked: false })
  assert.deepEqual(placeFile('src/pages/index.astro', '', null, taxonomy), { group: 'Pages / Home', tier: 'Pages', derived: true, parked: false })
  assert.deepEqual(placeFile('src/pages/api/feed.ts', '// @kept: until the feed returns', null, taxonomy), { group: 'Explorations / Kept', tier: 'Explorations', derived: true, parked: true })
  assert.deepEqual(placeFile('src/pages/api/feed.ts', '', null, taxonomy), { group: 'Internal / Endpoints', tier: 'Internal', derived: true, parked: false })
  assert.deepEqual(placeFile('src/lib/x.ts', '', null, taxonomy), { group: null, tier: null, derived: false, parked: false })
  assert.deepEqual(placeFile('src/lib/x.ts', '', null, null), { group: null, tier: null, derived: false, parked: false })
})

test('the tier order comes from the taxonomy when it has one', () => {
  assert.equal(tierOf('Primitives / Actions'), 'Primitives')
  assert.equal(tierOf(null), null)
  assert.deepEqual(tierOrder({ graph: { taxonomy } }), taxonomy.tiers)
  assert.equal(tierOrder({ graph: { taxonomy: null } })[0], 'Foundations')
})
