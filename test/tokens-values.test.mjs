// Every DTCG value type becomes real CSS: colour objects in any space, and the
// composites (typography, shadow, border, transition, gradient, strokeStyle),
// with references inside them kept as var() where outputs stay linked.

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { read, readJson, run, withTokens } from './helpers.mjs'

const doc = {
  color: {
    $type: 'color',
    ink: { $value: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.2 } },
    teal: { $value: { colorSpace: 'oklch', components: [0.7, 0.1, 200] } },
    vivid: { $value: { colorSpace: 'display-p3', components: [1, 0, 0], alpha: 0.5 } },
    white: { $value: { colorSpace: 'hsl', components: ['none', 0, 100] } },
    film: { $value: { colorSpace: 'rec2020', components: [0.5, 0.25, 1] } },
  },
  font: { family: { sans: { $type: 'fontFamily', $value: ['Inter', 'sans-serif'] } } },
  size: { lg: { $type: 'dimension', $value: { value: 1.125, unit: 'rem' } } },
  text: {
    body: {
      $type: 'typography',
      $value: { fontFamily: '{font.family.sans}', fontSize: '{size.lg}', fontWeight: 'semi-bold', lineHeight: 1.5, letterSpacing: { value: 0, unit: 'px' } },
    },
  },
  border: { thin: { $type: 'border', $value: { color: '{color.ink}', width: { value: 1, unit: 'px' }, style: 'solid' } } },
  motion: {
    emphasis: {
      $type: 'transition',
      $value: { duration: { value: 200, unit: 'ms' }, delay: { value: 0, unit: 'ms' }, timingFunction: [0.5, 0, 1, 1] },
    },
  },
  gradient: {
    sky: {
      $type: 'gradient',
      $value: [
        { color: { colorSpace: 'srgb', components: [0, 0, 1] }, position: 0 },
        { color: { colorSpace: 'srgb', components: [1, 0, 0] }, position: 1 },
      ],
    },
  },
  shadow: {
    ring: {
      $type: 'shadow',
      $value: [
        { color: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.2 }, offsetX: { value: 0, unit: 'px' }, offsetY: { value: 1, unit: 'px' }, blur: { value: 2, unit: 'px' }, spread: { value: 0, unit: 'px' } },
        { color: '{color.ink}', offsetX: { value: 0, unit: 'px' }, offsetY: { value: 0, unit: 'px' }, blur: { value: 0, unit: 'px' }, spread: { value: 1, unit: 'px' }, inset: true },
      ],
    },
  },
  stroke: { alert: { $type: 'strokeStyle', $value: { dashArray: [{ value: 0.5, unit: 'rem' }], lineCap: 'round' } } },
}

const t = withTokens(doc)
after(() => t.cleanup())
const style = (name) => read(t.root, 'src', 'styles', name)

test('build succeeds on every value type', () => {
  const r = run('tokens', t, ['build'])
  assert.equal(r.status, 0, r.stderr)
})

test('colour objects become CSS in their own space', () => {
  const css = style('tokens.generated.css')
  assert.match(css, /--color-ink: #00000033;/)
  assert.match(css, /--color-teal: oklch\(0\.7 0\.1 200\);/)
  assert.match(css, /--color-vivid: color\(display-p3 1 0 0 \/ 0\.5\);/)
  assert.match(css, /--color-white: hsl\(none 0% 100%\);/)
  assert.match(css, /--color-film: color\(rec2020 0\.5 0\.25 1\);/)
})

test('typography: the font shorthand, a variable per part, references kept linked', () => {
  const css = style('tokens.generated.css')
  assert.match(css, /--text-body: 600 var\(--size-lg\)\/1\.5 var\(--font-family-sans\);/)
  assert.match(css, /--text-body-font-family: var\(--font-family-sans\);/)
  assert.match(css, /--text-body-font-size: var\(--size-lg\);/)
  assert.match(css, /--text-body-font-weight: 600;/)
  assert.match(css, /--text-body-line-height: 1\.5;/)
  assert.match(css, /--text-body-letter-spacing: 0px;/)
  const kit = read(t.project, 'kit', 'kit.css')
  assert.match(kit, /--text-body: 600 1\.125rem\/1\.5 Inter, sans-serif;/) // literal everywhere in the kit
  assert.equal(readJson(t.root, 'src', 'styles', 'tokens.flat.json').tokens['text.body'].values.default, '600 1.125rem/1.5 Inter, sans-serif')
})

test('typography reaches Tailwind 4 and 3 as a font size with its parts', () => {
  const tw4 = style('tokens.tailwind.css')
  assert.match(tw4, /--text-body: var\(--text-body-font-size\);/)
  assert.match(tw4, /--text-body--line-height: var\(--text-body-line-height\);/)
  assert.match(tw4, /--text-body--letter-spacing: var\(--text-body-letter-spacing\);/)
  assert.match(tw4, /--text-body--font-weight: var\(--text-body-font-weight\);/)
  const exported = new Function('module', `${style('tokens.tailwind.cjs')}; return module.exports`)({ exports: {} })
  assert.deepEqual(exported.fontSize.body, [
    'var(--text-body-font-size)',
    { lineHeight: 'var(--text-body-line-height)', letterSpacing: 'var(--text-body-letter-spacing)', fontWeight: 'var(--text-body-font-weight)' },
  ])
})

test('border, transition, gradient, shadow and strokeStyle', () => {
  const css = style('tokens.generated.css')
  assert.match(css, /--border-thin: 1px solid var\(--color-ink\);/)
  assert.match(css, /--motion-emphasis: 200ms cubic-bezier\(0\.5, 0, 1, 1\) 0ms;/)
  assert.match(css, /--gradient-sky: linear-gradient\(#0000ff 0%, #ff0000 100%\);/)
  assert.match(css, /--shadow-ring: 0px 1px 2px 0px #00000033, inset 0px 0px 0px 1px var\(--color-ink\);/)
  assert.match(css, /--stroke-alert: dashed;/)
  const flat = readJson(t.root, 'src', 'styles', 'tokens.flat.json')
  assert.equal(flat.tokens['border.thin'].values.default, '1px solid #00000033') // references resolved in literal output
})

test('no output carries [object Object] or raw JSON', () => {
  const files = readdirSync(join(t.root, 'src', 'styles')).map((f) => read(t.root, 'src', 'styles', f))
  files.push(read(t.project, 'kit', 'kit.css'))
  for (const text of files) {
    assert.ok(!text.includes('[object Object]'))
    assert.ok(!text.includes('"colorSpace"'))
  }
})

test('the preview shows typography as text set in it', () => {
  assert.equal(run('tokens', t, ['preview']).status, 0)
  const html = read(t.project, 'tokens', 'preview.html')
  assert.match(html, /<h2>Typography<\/h2>/)
  assert.match(html, /style="font: var\(--text-body\); letter-spacing: var\(--text-body-letter-spacing\)"/)
})

test('a colour CSS cannot write is an error naming the token', () => {
  const bad = withTokens({ color: { $type: 'color', odd: { $value: { colorSpace: 'cmyk', components: [0, 0, 0] } }, ok: { $value: { colorSpace: 'cmyk', components: [0, 0, 0], hex: '#123456' } } } })
  try {
    const r = run('tokens', bad, ['build'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /color\.odd: colour space "cmyk" is not one CSS can write/)
  } finally {
    bad.cleanup()
  }
})

test('a reference inside a composite must point at a token', () => {
  const bad = withTokens({ border: { $type: 'border', x: { $value: { color: '{color.nope}', width: { value: 1, unit: 'px' }, style: 'solid' } } } })
  try {
    const r = run('tokens', bad, ['build'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /border\.x: reference \{color\.nope\} points at a token that does not exist/)
  } finally {
    bad.cleanup()
  }
})
