// A web colour written with CSS color() and no alpha (color(display-p3 1 0.5
// 0)) keeps its three components from extract through every output: the
// golden files under test/golden/color-function.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { colorFromCss } from '../scripts/lib/color.mjs'
import { golden, read, run } from './helpers.mjs'

const base = mkdtempSync(join(tmpdir(), 'massimo-color-function-'))
after(() => rmSync(base, { recursive: true, force: true }))
const root = join(base, 'repo')
const files = {
  'package.json': JSON.stringify({ name: 'site', private: true, dependencies: { react: '19.0.0', vite: '6.0.0' } }, null, 2),
  'src/styles/tokens.css': ':root {\n  --color-brand: color(display-p3 1 0.5 0);\n  --color-ink: color(srgb 0.1 0.2 0.3);\n  --color-wide: color(rec2020 0.4 0.6 0.2);\n  --color-faded: color(display-p3 1 0.5 0 / 0.5);\n  --color-plain: #336699;\n}\n',
  'massimo.config.json': JSON.stringify({ version: 1, projectDir: 'ds', tokens: { source: 'ds/tokens/tokens.resolver.json', styleFiles: ['src/styles/tokens.css'], outputs: [{ format: 'css', path: 'src/styles/tokens.generated.css' }, { format: 'json', path: 'src/styles/tokens.flat.json' }] } }, null, 2),
}
for (const [path, text] of Object.entries(files)) {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}
const ctx = { root, project: join(root, 'ds') }
const same = (name, text) => assert.equal(text, golden(`color-function/${name}`, text) ?? text, name)

test('color() with no alpha keeps its three components', () => {
  for (const css of ['color(display-p3 1 0.5 0)', 'color(srgb 0.1 0.2 0.3)', 'color(rec2020 0.4 0.6 0.2)', 'color(xyz 0.2 0.3 0.4)']) {
    assert.equal(colorFromCss(css).components.length, 3, css)
  }
  assert.deepEqual(colorFromCss('color(display-p3 1 0.5 0)').components, [1, 0.5, 0])
  assert.equal(colorFromCss('color(display-p3 1 0.5 0)').alpha, undefined)
})

test('golden: extract and build a style sheet of color() values', () => {
  const x = run('tokens', ctx, ['extract'])
  assert.equal(x.status, 0, x.stderr)
  same('draft/base.tokens.json', read(ctx.project, 'tokens', 'draft', 'base.tokens.json'))
  cpSync(join(ctx.project, 'tokens', 'draft'), join(ctx.project, 'tokens'), { recursive: true })
  const b = run('tokens', ctx, ['build'])
  assert.equal(b.status, 0, b.stderr)
  same('build/tokens.generated.css', read(root, 'src', 'styles', 'tokens.generated.css'))
  same('build/tokens.flat.json', read(root, 'src', 'styles', 'tokens.flat.json'))
  assert.equal(run('tokens', ctx, ['check']).status, 0)
})
