// tokens.mjs extract: a full proposed set from what a repo already uses, its
// sources first and the code's own values for the gaps, with a report that
// says where each value came from and what was assumed.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { SCRIPTS, read, readJson } from './helpers.mjs'

function repo(files, config) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-extract-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  writeFileSync(join(root, 'massimo.config.json'), JSON.stringify(config))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const extract = (root) => spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), 'extract', '--root', root], { encoding: 'utf8' })

test('a repo with raw values and no tokens: ramps, semantics, contrast, scales, type and motion from the code', () => {
  const css = [
    '.page { background: #fafafa; color: #171717; }',
    '.card { background: #fafafa; border: 1px solid #e5e5e5; color: #171717; padding: 16px; margin: 8px; border-radius: 8px; box-shadow: 0 1px 2px #0000001a; }',
    '.muted { color: #737373; font-size: 14px; line-height: 1.5; transition: opacity 150ms ease-out; }',
    '.title { font-size: 24px; font-weight: 700; padding: 16px; margin: 8px; border-radius: 8px; box-shadow: 0 1px 2px #0000001a; }',
    '.row { border: 1px solid #e5e5e5; gap: 12px; padding: 12px; font-size: 14px; color: #737373; z-index: 10; }',
    '.btn { background: #2563eb; color: #fafafa; font-size: 16px; font-size: 16px; font-weight: 400; transition: transform 300ms ease-out; background: #2563eb; }',
    '.odd { padding: 7px; }',
    'body, .hero { font-family: Inter, sans-serif; }',
    '.lead { font-family: Inter, sans-serif; }',
  ].join('\n')
  const r = repo({ 'src/app.css': css, 'package.json': '{"name":"acme"}' }, { tokens: { styleFiles: [] } })
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const dir = join(r.root, 'design-system', 'tokens', 'draft')
    const base = readJson(dir, 'base.tokens.json')
    const report = read(dir, 'report.md')
    // Ramps from the clusters, named by lightness.
    assert.deepEqual(Object.keys(base.color.neutral).filter((k) => !k.startsWith('$')).sort(), ['100', '50', '600', '950'])
    assert.equal(base.color.blue['600'].$value.hex, '#2563eb')
    assert.equal(base.color.overlay, undefined) // a shadow's colour stays in the shadow
    // Semantic colours from the roles, each with a description and a contrast pair.
    assert.equal(base.color.bg.default.$value, '{color.neutral.50}') // the neutral page, not the blue button
    assert.equal(base.color.accent.default.$value, '{color.blue.600}')
    assert.match(base.color.bg.default.$description, /^Background\. Used \d+× as a background, most in src\/app\.css\.$/)
    assert.equal(base.color.text.default.$value, '{color.neutral.950}')
    assert.deepEqual(base.color.text.default.$extensions.massimo.contrast, { on: 'color.bg.default', use: 'text' })
    assert.deepEqual(base.color.border.default.$extensions.massimo.contrast, { on: 'color.bg.default', use: 'ui' })
    // Scales: spacing on the grid, radius, type sizes named around the body size.
    assert.deepEqual(Object.keys(base.spacing).filter((k) => !k.startsWith('$')).sort(), ['2', '3', '4'])
    assert.deepEqual(base.radius.sm.$value, { value: 0.5, unit: 'rem' })
    assert.deepEqual(Object.keys(base.font.size).filter((k) => !k.startsWith('$')).sort(), ['base', 'sm'])
    // Typography composites, with what was assumed said in the report.
    assert.deepEqual(base.typography.base.$value.fontSize, '{font.size.base}')
    assert.match(report, /\| `typography\.sm` \| 0\.875rem \/ 1\.5, weight 400 \| the size scale \| assumed line height 1\.5, the most used/)
    // The rest: shadow, border with its colour as a reference, motion, layers.
    assert.equal(base.shadow.$type, 'shadow')
    assert.equal(base.border.default.$value.color, '{color.neutral.100}')
    assert.deepEqual(base.duration.fast.$value, { value: 150, unit: 'ms' })
    assert.deepEqual(base.ease.standard.$value, [0, 0, 0.58, 1])
    assert.equal(base.z['10'].$value, 10)
    // A value used once is reported, not proposed.
    assert.match(report, /\| Spacing \| 7px \| 1 \| off the 4px grid \|/)
    assert.match(out.stdout, /from the code\), \d+ too rare to propose/)
    // The draft passes the strict reader.
    const check = spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), 'build', '--root', r.root], {
      encoding: 'utf8',
      env: { ...process.env },
    })
    writeFileSync(join(r.root, 'massimo.config.json'), JSON.stringify({ tokens: { source: 'design-system/tokens/draft/tokens.resolver.json', outputs: [{ format: 'css', path: 'tokens.css' }] } }))
    const build = spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), 'build', '--root', r.root], { encoding: 'utf8' })
    assert.equal(build.status, 0, build.stderr)
    assert.match(read(r.root, 'tokens.css'), /--color-bg-default: var\(--color-neutral-50\);/)
    assert.ok(check)
  } finally {
    r.cleanup()
  }
})

test('sources come first: a Tailwind config and CSS variables, with references between them', () => {
  const r = repo(
    {
      'src/global.css': ':root { --rgb-base-100: 250 250 250; --rgb-base-content: 23 23 23; }\n',
      'tailwind.config.js': `module.exports = { theme: { extend: {
        colors: { base: { 100: 'rgb(var(--rgb-base-100) / <alpha-value>)', content: 'rgb(var(--rgb-base-content) / <alpha-value>)' } },
        fontFamily: { sans: ['Inter', 'sans-serif'] },
        fontSize: { body: ['1rem', { lineHeight: '1.5rem' }], title: ['2rem', '1.2'] },
      } } }`,
      'src/page.tsx': 'export const P = () => <div className="bg-base-100 text-base-content text-body" />\n',
    },
    { tokens: { styleFiles: ['src/global.css'], tailwindConfig: 'tailwind.config.js' } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(r.root, 'design-system', 'tokens', 'draft', 'base.tokens.json')
    assert.equal(base.color.base['100'].$value, '{other.rgb-base-100}') // Tailwind's colour points at the CSS channels
    assert.deepEqual(base.other['rgb-base-100'].$extensions.massimo, { cssVar: '--rgb-base-100', css: '250 250 250' })
    assert.equal(base.color.base.content.$extensions.massimo.contrast.on, 'color.base.100')
    // Type steps from the config are exact: no assumptions for them.
    assert.deepEqual(base.typography.body.$value, { fontFamily: '{font.sans}', fontSize: '{text.body}', fontWeight: 400, lineHeight: 1.5, letterSpacing: { value: 0, unit: 'px' } })
    assert.equal(base.typography.title.$value.lineHeight, 1.2)
    assert.match(read(r.root, 'design-system', 'tokens', 'draft', 'report.md'), /\| `typography\.body` \| 1rem \/ 1\.5, weight 400 \| a type step in the config \| assumed weight 400/)
  } finally {
    r.cleanup()
  }
})
