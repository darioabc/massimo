// Reading the W3C Design Tokens format 2025.10: types are never guessed,
// values are checked against their type, `$root`, `$extends` and `$ref` work,
// themes come from a resolver document, and a newer format is refused.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkValue, expandDocument, flattenFormat, looksLegacy, writeTokenSet } from '../scripts/lib/dtcg.mjs'
import { read, readJson, run, scratch, withTokens } from './helpers.mjs'

const MARK = { $extensions: { massimo: { format: 2 } } }
const px = (value) => ({ value, unit: 'px' })
const srgb = (r, g, b) => ({ colorSpace: 'srgb', components: [r, g, b] })

test('checkValue follows the spec for every type', () => {
  assert.equal(checkValue('color', srgb(1, 0, 0)), null)
  assert.match(checkValue('color', '#ff0000'), /must be a colour object/)
  assert.match(checkValue('color', { colorSpace: 'srgb', components: [1, 0] }), /three components/)
  assert.equal(checkValue('dimension', { value: 0.5, unit: 'rem' }), null)
  assert.match(checkValue('dimension', { value: 1, unit: 'em' }), /takes px or rem/)
  assert.match(checkValue('duration', { value: 1, unit: 'px' }), /takes ms or s/)
  assert.equal(checkValue('fontWeight', 'semi-bold'), null)
  assert.match(checkValue('fontWeight', 'Bold'), /must be a number from 1 to 1000/)
  assert.match(checkValue('cubicBezier', [2, 0, 1, 1]), /x1 and x2 between 0 and 1/)
  assert.match(checkValue('typography', { fontFamily: 'Inter', fontSize: px(16), fontWeight: 400, lineHeight: 1.5 }), /missing letterSpacing/)
  assert.match(checkValue('shadow', { color: srgb(0, 0, 0), offsetX: px(0), offsetY: px(1), blur: px(2), spread: px(0), glow: true }), /cannot have glow/)
  assert.equal(checkValue('border', { color: '{color.a}', width: px(1), style: 'solid' }), null) // a reference stands for any part
  assert.match(checkValue('string', 'x'), /not a DTCG type/)
})

test('a 2025.10 token with no type is an error, never a guess', () => {
  const t = withTokens({ ...MARK, size: { gap: { $value: px(4) } }, color: { $type: 'color', a: { $value: srgb(1, 1, 1) } } })
  try {
    const r = run('tokens', t, ['build'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /error: size\.gap: has no \$type, and no group above it sets one/)
  } finally {
    t.cleanup()
  }
})

test('a reference takes its target\'s type; a mismatch is an error', () => {
  const t = withTokens({ ...MARK, color: { $type: 'color', a: { $value: srgb(1, 1, 1) } }, size: { $type: 'dimension', x: { $value: '{color.a}' } }, b: { $value: '{color.a}' } })
  try {
    const r = run('tokens', t, ['build'])
    assert.equal(r.status, 0, r.stderr) // a group's $type does not override what a reference points at
    assert.match(read(t.root, 'src', 'styles', 'tokens.generated.css'), /--b: var\(--color-a\);/)
  } finally {
    t.cleanup()
  }
  const bad = withTokens({ ...MARK, color: { $type: 'color', a: { $value: srgb(1, 1, 1) } }, x: { $type: 'dimension', $value: '{color.a}' } })
  try {
    assert.match(run('tokens', bad, ['build']).stderr, /x: is a dimension but points at color\.a, a color/)
  } finally {
    bad.cleanup()
  }
})

test('$root, $extends and $ref', () => {
  const doc = {
    color: {
      $type: 'color',
      accent: { $root: { $value: srgb(0, 0, 1) }, hover: { $value: srgb(0, 0, 0.8) } },
      link: { $value: '{color.accent.$root}' },
      blue: { $value: srgb(0, 0, 1) },
      primary: { $ref: '#/color/blue/$value', $type: 'color' },
      tint: { $value: { colorSpace: 'srgb', components: [{ $ref: '#/color/blue/$value/components/0' }, 0, 1] } },
    },
    button: { $type: 'dimension', pad: { $value: px(8) }, gap: { $value: px(4) } },
    cta: { $extends: '{button}', pad: { $value: px(12) } },
  }
  const problems = []
  const tokens = flattenFormat(expandDocument(doc, problems), problems)
  const byName = Object.fromEntries(tokens.map((t) => [t.name, t]))
  assert.equal(byName['color.accent.$root'].cssVar, '--color-accent')
  assert.equal(byName['color.link'].value, '{color.accent.$root}')
  assert.equal(byName['color.primary'].value, '{color.blue}')
  assert.deepEqual(byName['color.tint'].value.components, [0, 0, 1]) // a pointer into part of a value is copied in
  assert.deepEqual(byName['cta.pad'].value, px(12))
  assert.deepEqual(byName['cta.gap'].value, px(4))
  assert.equal(byName['cta.gap'].groupType, 'dimension')
  assert.ok(problems.some((p) => p.level === 'warning' && /points into part of a value/.test(p.message)))
  const cycle = []
  expandDocument({ a: { $extends: '{b}' }, b: { $extends: '{a}' } }, cycle)
  assert.ok(cycle.some((p) => /cycle/.test(p.message)))
})

test('the dialect before 0.2.0 is told apart from 2025.10', () => {
  assert.equal(looksLegacy({ color: { $type: 'color', a: { $value: '#fff' } } }), true)
  assert.equal(looksLegacy({ size: { $type: 'dimension', a: { $value: 4 } } }), true)
  assert.equal(looksLegacy({ a: { $value: '#fff' } }), true)
  assert.equal(looksLegacy({ color: { $type: 'color', a: { $value: srgb(1, 1, 1) } } }), false)
  assert.equal(looksLegacy({ ...MARK, a: { $value: '#fff' } }), false)
})

function resolverProject(files) {
  const t = scratch()
  const dir = join(t.root, 'design-system', 'tokens')
  for (const [name, doc] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), typeof doc === 'string' ? doc : JSON.stringify(doc))
  }
  const configPath = join(t.root, 'massimo.config.json')
  const config = JSON.parse(read(configPath))
  config.tokens.source = 'design-system/tokens/tokens.resolver.json'
  writeFileSync(configPath, JSON.stringify(config))
  return t
}

test('a resolver document: contexts become modes, several modifiers, partial overrides', () => {
  const t = resolverProject({
    'tokens.resolver.json': {
      version: '2025.10',
      sets: { base: { sources: [{ $ref: 'base.tokens.json' }] } },
      modifiers: {
        theme: { contexts: { day: [], night: [{ $ref: 'night.tokens.json' }] }, default: 'day' },
        brand: { contexts: { core: [], acme: [{ color: { accent: { $value: srgb(1, 0, 0) } } }] }, default: 'core' },
      },
      resolutionOrder: [{ $ref: '#/sets/base' }, { $ref: '#/modifiers/theme' }, { $ref: '#/modifiers/brand' }],
    },
    'base.tokens.json': { ...MARK, color: { $type: 'color', bg: { $value: srgb(1, 1, 1) }, accent: { $value: srgb(0, 0, 1) } } },
    'night.tokens.json': { color: { bg: { $value: srgb(0, 0, 0) } } }, // only $value: the rest comes from the base
  })
  try {
    const r = run('tokens', t, ['build'])
    assert.equal(r.status, 0, r.stderr)
    const css = read(t.root, 'src', 'styles', 'tokens.generated.css')
    assert.match(css, /\[data-theme="night"\] \{\n {2}--color-bg: #000000;\n\}/)
    assert.match(css, /\[data-theme="acme"\] \{\n {2}--color-accent: #ff0000;\n\}/)
    assert.ok(!css.includes('prefers-color-scheme')) // no media query: there is no dark context
    const figma = readJson(t.project, 'tokens', 'figma-variables.json')
    assert.deepEqual(figma.collections[0].modes, ['Day', 'Night', 'Acme'])
  } finally {
    t.cleanup()
  }
})

test('a resolver from a newer spec, a file from a newer massimo, and a $ref out of the repo are refused', () => {
  const newer = resolverProject({ 'tokens.resolver.json': { version: '2026.10', resolutionOrder: [] } })
  const format = resolverProject({
    'tokens.resolver.json': { version: '2025.10', sets: { base: { sources: [{ $ref: 'base.tokens.json' }] } }, resolutionOrder: [{ $ref: '#/sets/base' }] },
    'base.tokens.json': { $extensions: { massimo: { format: 3 } }, color: { $type: 'color', a: { $value: srgb(1, 1, 1) } } },
  })
  const outside = resolverProject({
    'tokens.resolver.json': { version: '2025.10', sets: { base: { sources: [{ $ref: '../../../../../etc/passwd' }] } }, resolutionOrder: [{ $ref: '#/sets/base' }] },
  })
  try {
    assert.match(run('tokens', newer, ['build']).stderr, /is resolver version 2026\.10, newer than the 2025\.10 this massimo reads; update massimo/)
    assert.match(run('tokens', format, ['build']).stderr, /was written by a newer massimo \(format 3; this one reads 2\); update massimo/)
    assert.match(run('tokens', outside, ['build']).stderr, /points outside the repo/)
  } finally {
    newer.cleanup()
    format.cleanup()
    outside.cleanup()
  }
})

test('contrast pairs: WCAG 2.2 minimums by use, reported per theme', () => {
  const t = withTokens({
    ...MARK,
    color: {
      $type: 'color',
      bg: { $value: srgb(1, 1, 1) },
      grey: { $value: srgb(0.6, 0.6, 0.6), $extensions: { massimo: { contrast: { on: 'color.bg', use: 'ui' } } } },
      faint: { $value: srgb(0.6, 0.6, 0.6), $extensions: { massimo: { contrast: { on: 'color.bg', use: 'text' } } } },
      big: { $value: srgb(0.45, 0.45, 0.45), $extensions: { massimo: { contrast: { on: 'color.bg', use: 'large-text' } } } },
    },
  })
  try {
    assert.equal(run('tokens', t, ['build']).status, 0)
    const r = run('tokens', t, ['check'])
    assert.match(r.stderr, /warn: light: color\.grey on color\.bg is 2\.85:1, needs 3:1 for UI/)
    assert.match(r.stderr, /warn: light: color\.faint on color\.bg is 2\.85:1, needs 4\.5:1 for text/)
    assert.ok(!/color\.big/.test(r.stderr)) // 4.8:1 passes the large-text minimum
  } finally {
    t.cleanup()
  }
})

test('the writer refuses a name that is both a token and a group, rather than lose one', () => {
  const t = (path) => ({ path, name: path.join('.'), type: 'color', value: '#000000', modes: {}, cssModes: {}, css: null, cssVar: `--${path.join('-')}`, description: '' })
  assert.throws(() => writeTokenSet({ tokens: [t(['color', 'neutral']), t(['color', 'neutral', '950'])] }), /color\.neutral is a token and also the group of color\.neutral\.950/)
  assert.ok(writeTokenSet({ tokens: [t(['color', 'neutral', '$root']), t(['color', 'neutral', '950'])] })['base.tokens.json'])
})
