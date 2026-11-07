// Modes: an alias follows its target into every mode, mode blocks use the
// app's own selectors, mode names never collide, two tokens never share a
// CSS variable, and Figma gets each collection's own modes.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { read, readJson, run, scratch, withTokens } from './helpers.mjs'

const themed = {
  color: {
    $type: 'color',
    a: { $value: '#111111', $extensions: { massimo: { modes: { dark: '#eeeeee', brand: '#ff0000' } } } },
    b: { $value: '{color.a}' },
  },
}

test('kit and preview: an alias takes its target\'s dark value', () => {
  const t = withTokens(themed)
  try {
    assert.equal(run('tokens', t, ['build']).status, 0)
    const kit = read(t.project, 'kit', 'kit.css')
    assert.match(kit, /\[data-theme="dark"\] \{\n {2}color-scheme: dark;\n {2}--color-a: #eeeeee;\n {2}--color-b: #eeeeee;\n\}/)
    assert.match(kit, /\[data-theme="brand"\] \{\n {2}--color-a: #ff0000;\n {2}--color-b: #ff0000;\n\}/)
    // The css output stays linked, so only the target is redeclared.
    assert.match(read(t.root, 'src', 'styles', 'tokens.generated.css'), /\[data-theme="dark"\] \{\n {2}--color-a: #eeeeee;\n\}/)
    assert.equal(run('tokens', t, ['preview']).status, 0)
    assert.match(read(t.project, 'tokens', 'preview.html'), /--color-b: #eeeeee;/)
  } finally {
    t.cleanup()
  }
})

test('kit from the style files: a var() chain follows its target into dark', () => {
  const t = scratch()
  try {
    const path = join(t.root, 'massimo.config.json')
    const config = JSON.parse(read(path))
    writeFileSync(path, JSON.stringify({ ...config, tokens: { source: 'nope/tokens.json', styleFiles: ['src/styles/theme.css'] } }))
    assert.equal(run('tokens', t, ['kit']).status, 0)
    const kit = read(t.project, 'kit', 'kit.css')
    const dark = /\[data-theme="dark"\] \{[^}]*\}/.exec(kit)[0]
    assert.match(dark, /--color-brand: #00ffee;/) // --color-brand: var(--brand-teal), and .dark sets --brand-teal
  } finally {
    t.cleanup()
  }
})

test('mode blocks follow darkSelector, and the media query opts out of the matching light selector', () => {
  const t = withTokens(themed, { darkSelector: '.dark' })
  try {
    assert.equal(run('tokens', t, ['build']).status, 0)
    const css = read(t.root, 'src', 'styles', 'tokens.generated.css')
    assert.match(css, /^\.dark \{$/m)
    assert.match(css, /^\.brand \{$/m)
    assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\.light\) \{/)
    assert.ok(!css.includes('data-theme'))
    const kit = read(t.project, 'kit', 'kit.css')
    assert.match(kit, /^\.dark, \[data-theme="dark"\] \{$/m)
    assert.match(kit, /^\.brand, \[data-theme="brand"\] \{$/m)
    assert.match(kit, /:root:not\(\.light\):not\(\[data-theme="light"\]\) \{/)
  } finally {
    t.cleanup()
  }
})

test('tokens.selectors names a mode\'s selector; darkMedia false drops the media query everywhere', () => {
  const t = withTokens(themed, { darkMedia: false, selectors: { brand: '[data-brand="acme"]' } })
  try {
    assert.equal(run('tokens', t, ['build']).status, 0)
    const css = read(t.root, 'src', 'styles', 'tokens.generated.css')
    assert.match(css, /^\[data-brand="acme"\] \{$/m)
    assert.ok(!css.includes('prefers-color-scheme'))
    assert.ok(!read(t.project, 'kit', 'kit.css').includes('prefers-color-scheme'))
  } finally {
    t.cleanup()
  }
})

test('the default mode has a name, and a mode that repeats it is an error', () => {
  const day = withTokens(themed, { defaultMode: 'day' })
  const explicit = withTokens({ color: { $type: 'color', a: { $value: '#111111', $extensions: { massimo: { modes: { default: '#222222' } } } } } })
  const light = withTokens({ color: { $type: 'color', a: { $value: '#111111', $extensions: { massimo: { modes: { light: '#222222' } } } } } })
  try {
    assert.equal(run('tokens', day, ['build']).status, 0)
    assert.deepEqual(readJson(day.project, 'tokens', 'figma-variables.json').collections[0].modes, ['Day', 'Dark', 'Brand'])
    assert.match(read(day.root, 'src', 'styles', 'tokens.generated.css'), /^\[data-theme="brand"\] \{$/m)
    for (const [ctx, mode] of [[explicit, 'default'], [light, 'light']]) {
      const r = run('tokens', ctx, ['build'])
      assert.equal(r.status, 1)
      assert.match(r.stderr, new RegExp(`color\\.a: "${mode}" is the default mode`))
    }
  } finally {
    day.cleanup()
    explicit.cleanup()
    light.cleanup()
  }
})

test('two tokens that map to one CSS variable are an error naming both', () => {
  const cases = [
    [{ color: { $type: 'color', 'a-b': { $value: '#111111' }, a: { b: { $value: '#222222' } } } }, /color\.a-b and color\.a\.b both map to the CSS variable --color-a-b/],
    [{ color: { $type: 'color', a: { $value: '#111111' }, b: { $value: '#222222', $extensions: { massimo: { cssVar: '--color-a' } } } } }, /color\.a and color\.b both map to the CSS variable --color-a/],
    [
      {
        type: {
          h1: { $type: 'typography', $value: { fontFamily: 'Inter', fontSize: { value: 2, unit: 'rem' }, fontWeight: 700, lineHeight: 1.2, letterSpacing: { value: 0, unit: 'px' } } },
          'h1-font-size': { $type: 'dimension', $value: { value: 1, unit: 'rem' } },
        },
      },
      /type\.h1 and type\.h1-font-size both map to the CSS variable --type-h1-font-size/,
    ],
  ]
  for (const [doc, message] of cases) {
    const t = withTokens(doc)
    try {
      const r = run('tokens', t, ['build'])
      assert.equal(r.status, 1)
      assert.match(r.stderr, message)
    } finally {
      t.cleanup()
    }
  }
})

test('figma: em stays a string, aliases name their collection, each collection keeps its own modes', () => {
  const t = withTokens({
    color: {
      $type: 'color',
      blue: { $value: '#0000ff' },
      accent: { $value: '{color.blue}', $extensions: { massimo: { collection: 'Brand' } } },
      surface: { $value: '#ffffff', $extensions: { massimo: { modes: { dark: '#000000' } } } },
    },
    space: { $type: 'dimension', md: { $value: '1rem' }, tight: { $value: '-0.02em' } },
  })
  try {
    assert.equal(run('tokens', t, ['build']).status, 0)
    const figma = readJson(t.project, 'tokens', 'figma-variables.json')
    const byName = (n) => figma.collections.flatMap((c) => c.variables).find((v) => v.name === n)
    // Primitives has a Dark mode (color.surface changes), so every primitive fills it.
    assert.deepEqual(byName('space/md'), { name: 'space/md', type: 'FLOAT', values: { Light: 16, Dark: 16 }, description: '', codeSyntax: { WEB: 'var(--space-md)' } })
    assert.equal(byName('space/tight').type, 'STRING')
    assert.equal(byName('space/tight').values.Light, '-0.02em')
    assert.deepEqual(byName('color/accent').values, { Light: { alias: 'color/blue', collection: 'Primitives' } })
    const modes = Object.fromEntries(figma.collections.map((c) => [c.name, c.modes]))
    assert.deepEqual(modes, { Primitives: ['Light', 'Dark'], Brand: ['Light'] })
  } finally {
    t.cleanup()
  }
})
