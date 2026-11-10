// tokens.mjs extract, readers and scales: Sass interpolation is read or
// named, a Tailwind config's names from elsewhere and spreads are named,
// a type step's line height is read whole, theme.extend adds to Tailwind's
// scale, and a few literal sizes are not the type scale the body is set in.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { propose } from '../scripts/lib/propose.mjs'
import { readCss, readTailwindConfig } from '../scripts/lib/readers.mjs'
import { cssRules } from '../scripts/lib/sheets.mjs'
import { parseCustomProperties } from '../scripts/lib/source.mjs'
import { SCRIPTS, read, readJson } from './helpers.mjs'

function repo(files, config) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-scales-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  if (config) writeFileSync(join(root, 'massimo.config.json'), JSON.stringify(config))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const extract = (root) => spawnSync(process.execPath, [join(SCRIPTS, 'tokens.mjs'), 'extract', '--root', root], { encoding: 'utf8' })
const draft = (root, ...parts) => join(root, 'design-system', 'tokens', 'draft', ...parts)
const fromCss = () => ({})

const SASS = [
  "@use '../helpers' as *;",
  ':root {',
  '  --radius-none: 0;',
  '  --radius-xs: #{toRem(2)};',
  '  --radius-sm: #{px-to-rem(6, 12)};',
  '  --shadow-xs: 0 #{toRem(1)} #{toRem(2)} 0 rgba(0, 0, 0, 0.05);',
  "  --gap-lg: #{'24px'};",
  '  --gap-xl: #{$base * 2};',
  '}',
  '.card-#{$name} { --inside: 1px; }',
  '',
].join('\n')

test('Sass interpolation: every declaration is kept as written, read when it can be, and named when it needs Sass', () => {
  const props = parseCustomProperties(SASS, 'vars.scss')
  assert.deepEqual(props.filter((p) => p.scope === 'root').map((p) => [p.name, p.value]), [
    ['--radius-none', '0'],
    ['--radius-xs', '#{toRem(2)}'],
    ['--radius-sm', '#{px-to-rem(6, 12)}'],
    ['--shadow-xs', '0 #{toRem(1)} #{toRem(2)} 0 rgba(0, 0, 0, 0.05)'],
    ['--gap-lg', "#{'24px'}"],
    ['--gap-xl', '#{$base * 2}'],
  ])
  // An interpolated selector opens its block where it should.
  assert.equal(props.find((p) => p.name === '--inside').selector, '.card-#{$name}')
  // The stylesheet reader the inventory and mirror use keeps them as written too.
  const rules = cssRules(SASS, 'vars.scss')
  assert.deepEqual(rules[0].decls.map((d) => d.prop), ['--radius-none', '--radius-xs', '--radius-sm', '--shadow-xs', '--gap-lg', '--gap-xl'])
  const r = repo({ 'vars.scss': SASS })
  try {
    const { tokens, notes } = readCss(r.root, ['vars.scss'])
    const value = (name) => tokens.find((t) => t.cssVar === name)?.value
    assert.equal(value('--radius-xs'), '0.125rem')
    assert.equal(value('--radius-sm'), '0.5rem') // the call's own base
    assert.equal(value('--shadow-xs'), '0 0.0625rem 0.125rem 0 rgba(0, 0, 0, 0.05)')
    assert.equal(value('--gap-lg'), '24px')
    assert.equal(value('--gap-xl'), undefined)
    assert.ok(notes.includes('vars.scss: read 3 values written with a Sass rem conversion as rem at 16px a rem, such as --radius-xs: #{toRem(2)} as 0.125rem; if the function\'s base is not 16px, correct those tokens'), notes.join('\n'))
    assert.ok(notes.includes('vars.scss: --gap-xl (#{$base * 2}) holds Sass interpolation that needs Sass to evaluate, so it was left out; add its value by hand'), notes.join('\n'))
  } finally {
    r.cleanup()
  }
})

test('a Tailwind 3 config: a section that is a name from another module, and spreads, are named, never read as tokens', () => {
  const r = repo({
    'tailwind.config.js': [
      "import { brandColors } from './config/colors'",
      "import sizes from './config/sizes'",
      'export default {',
      '  theme: {',
      '    colors: brandColors,',
      "    fontSize: { ...sizes, tiny: ['7px', 'normal'], small: ['14px', { lineHeight: '20px' }], body: ['16px', 1.5] },",
      "    extend: { colors: { accent: { ...accentRamp, 500: '#ff5500' } } },",
      '  },',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const { tokens, notes, typeSteps, partial } = readTailwindConfig(r.root, 'tailwind.config.js')
    assert.ok(!tokens.some((t) => t.path.includes('expr')), JSON.stringify(tokens.map((t) => t.path)))
    assert.deepEqual(notes, [
      'tailwind.config.js: theme.colors is brandColors from ./config/colors, which is not read here, so it was skipped',
      'tailwind.config.js: theme.fontSize spreads sizes from ./config/sizes, which was left out',
      'tailwind.config.js: theme.extend.colors.accent spreads accentRamp, which was left out',
    ])
    assert.deepEqual(partial.sort(), ['color', 'text'])
    // Both parts of a size tuple are read, as written.
    const step = (name) => typeSteps.find((s) => s.path.join('.') === `text.${name}`)
    assert.equal(step('tiny').lineHeight, 'normal')
    assert.equal(step('small').lineHeight, '20px')
    assert.equal(step('body').lineHeight, '1.5')
    assert.equal(tokens.find((t) => t.path.join('.') === 'color.accent.500').value, '#ff5500')
  } finally {
    r.cleanup()
  }
})

test("a type step's line height is a number whatever the config writes; normal is assumed and said", () => {
  const sources = [{
    kind: 'tailwind',
    tokens: [
      { path: ['font', 'sans'], type: 'fontFamily', value: ['Inter', 'sans-serif'], modes: {}, source: 'tailwind.config.js' },
      ...[['tiny', '7px'], ['small', '14px'], ['wide', '18px']].map(([n, v]) => ({ path: ['text', n], type: 'dimension', value: v, modes: {}, source: 'tailwind.config.js' })),
    ],
    typeSteps: [
      { path: ['text', 'tiny'], size: '7px', lineHeight: 'normal' },
      { path: ['text', 'small'], size: '14px', lineHeight: '20px' },
      { path: ['text', 'wide'], size: '18px', lineHeight: '150%' },
    ],
    notes: [],
  }]
  const out = propose({ sources, audit: {}, fromCss })
  const composite = (n) => out.tokens.find((t) => t.path.join('.') === `typography.${n}`).value
  assert.equal(composite('tiny').lineHeight, 1.5)
  assert.equal(composite('small').lineHeight, 1.4286)
  assert.equal(composite('wide').lineHeight, 1.5)
  const row = out.report.find((r) => r.token === 'typography.tiny')
  assert.equal(row.value, '7px / 1.5, weight 400')
  assert.match(row.note, /assumed line height 1\.5, as the code sets none for body text, in place of the config's normal/)
})

test("theme.extend.spacing adds to Tailwind's spacing scale, which the code's values are on", () => {
  const r = repo(
    {
      'tailwind.config.js': "module.exports = { theme: { extend: { spacing: { 13: '3.25rem', 15: '3.75rem', 17: '4.25rem', 18: '4.5rem' } } } }\n",
      'src/app.css': '.a { padding: 16px; } .b { padding: 16px; } .c { margin: 8px; } .d { margin: 8px; } .e { gap: 52px; } .f { gap: 52px; }\n',
      'package.json': '{"name":"acme"}',
    },
    { styling: ['tailwind3'], tokens: { styleFiles: [], tailwindConfig: 'tailwind.config.js' } },
  )
  try {
    const out = extract(r.root)
    assert.equal(out.status, 0, out.stderr)
    const base = readJson(draft(r.root, 'base.tokens.json'))
    const report = read(draft(r.root, 'report.md'))
    assert.deepEqual(base.spacing['4'].$value, { value: 1, unit: 'rem' })
    assert.deepEqual(base.spacing['2'].$value, { value: 0.5, unit: 'rem' })
    assert.doesNotMatch(report, /not on the existing spacing scale/)
  } finally {
    r.cleanup()
  }
  // A scale theme.spacing sets is the whole scale, as before.
  const own = repo(
    {
      'tailwind.config.js': "module.exports = { theme: { spacing: { 1: '4px', 2: '8px', 3: '12px' } } }\n",
      'src/app.css': '.a { padding: 20px; } .b { padding: 20px; }\n',
      'package.json': '{"name":"acme"}',
    },
    { styling: ['tailwind3'], tokens: { styleFiles: [], tailwindConfig: 'tailwind.config.js' } },
  )
  try {
    assert.equal(extract(own.root).status, 0)
    assert.match(read(draft(own.root, 'report.md')), /\| Spacing \| 20px \| 2 \| not on the existing spacing scale \|/)
  } finally {
    own.cleanup()
  }
})

test('the type scale: a few small sizes, or a scale with a part left unread, do not close it, and the body rule gives the base size', () => {
  const css = 'body { font-size: 16px; }\n.a { font-size: 12px; } .b { font-size: 12px; } .c { font-size: 14px; } .d { font-size: 14px; }\n'
  const config = (fontSize) => `module.exports = { theme: { fontSize: ${fontSize} } }\n`
  const run = (fontSize) => {
    const r = repo(
      { 'tailwind.config.js': config(fontSize), 'src/base.css': css, 'package.json': '{"name":"acme"}' },
      { styling: ['tailwind3'], tokens: { styleFiles: [], tailwindConfig: 'tailwind.config.js' } },
    )
    try {
      const out = extract(r.root)
      assert.equal(out.status, 0, out.stderr)
      return { base: readJson(draft(r.root, 'base.tokens.json')), report: read(draft(r.root, 'report.md')), stderr: out.stderr }
    } finally {
      r.cleanup()
    }
  }
  const sizes = (base) => Object.keys(base.font?.size ?? {}).filter((k) => !k.startsWith('$')).sort()
  // Three small literal sizes beside a spread of the real scale.
  const spread = run("{ ...sizes, xxxs: ['8px', '1.25'], xxs: ['10px', '1.25'], label: ['7px', 'normal'] }")
  assert.deepEqual(sizes(spread.base), ['base', 'sm', 'xs'])
  assert.doesNotMatch(spread.report, /not on the existing type scale/)
  assert.match(spread.stderr, /note: The sources leave part of the type scale unread/)
  // The same three sizes alone are badge sizes, all below the body size: no scale either.
  assert.deepEqual(sizes(run("{ xxxs: '8px', xxs: '10px', label: '7px' }").base), ['base', 'sm', 'xs'])
  // A scale that spans the body size is closed, and the body rule's size still gives the base.
  const closed = run("{ xs: '12px', sm: '13px', lg: '18px', xl: '24px' }")
  assert.deepEqual(sizes(closed.base), ['base'])
  assert.match(closed.report, /\| `font\.size\.base` \| 1rem \| 16px used 1× in code \| Tailwind's text-base; the body size, set on body in src\/base\.css, which the sources' type scale lacks \|/)
  assert.match(closed.report, /\| Typography \| 14px \| 2 \| not on the existing type scale \|/)
})
