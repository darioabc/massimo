// Tailwind palette classes in an app coloured with them: counted before the
// repo has colour tokens, findings once a token holds their colour (with
// that token as the fix), and counted, never ratcheted, while no token does.
// A config or a @theme that replaces Tailwind's palette makes every
// palette-named class the repo's own.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { read, readJson, run } from './helpers.mjs'

const contexts = []
after(() => contexts.forEach((c) => c.cleanup()))

// A scratch repo holding `files`, with `config` as its massimo.config.json.
function repoOf(files, config) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-palette-'))
  for (const [path, text] of Object.entries({ ...files, 'massimo.config.json': JSON.stringify(config) })) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const ctx = { root, project: join(root, 'ds'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
  contexts.push(ctx)
  return ctx
}

const configOf = (styling, tokens = {}, audit = {}) => ({
  version: 1,
  framework: 'vue',
  styling,
  components: { include: ['src/components/**/*.vue'], exclude: [] },
  tokens: { styleFiles: ['src/main.css'], outputs: [], ...tokens },
  audit: { include: ['src/**/*.{css,vue}'], ...audit },
})

const audit = (ctx, args = []) => {
  const r = run('audit', ctx, args)
  assert.equal(r.status, 0, r.stderr)
  return readJson(ctx.project, 'audits', 'latest.json')
}
const palette = (latest) => latest.findings.filter((f) => f.kind === 'tailwind-palette').map((f) => (f.token ? `${f.value} ${f.token}` : f.value))

// Tailwind 3's slate-400 is #94a3b8, which the token set's ink holds.
const PAGE = '<template>\n  <p class="text-slate-400 text-slate-700 bg-white text-red-600/50 bg-brand">Hi</p>\n  <p class="text-slate-700">Again</p>\n</template>\n'
const TOKENS = JSON.stringify({ color: { $type: 'color', ink: { $value: '#94a3b8' }, brand: { $value: '#123456' } } })

test('before any colour token, the report counts the palette classes; after, a class a token holds is a finding naming it, and the rest are counted, not ratcheted', () => {
  const files = { 'src/main.css': 'body { margin: 0; }\n', 'src/components/Page.vue': PAGE, 'tokens/base.tokens.json': TOKENS }
  const ctx = repoOf(files, configOf(['tailwind3'], { source: 'tokens/none.json' }))
  const before = audit(ctx)
  assert.equal(before.skipped['tailwind-palette'], 'no colour tokens of its own')
  assert.deepEqual(before.paletteClasses, {
    count: 5,
    distinct: 4,
    top: [
      { name: 'text-slate-700', count: 2 },
      { name: 'bg-white', count: 1 },
      { name: 'text-red-600/50', count: 1 },
      { name: 'text-slate-400', count: 1 },
    ],
  })
  const md = read(ctx.project, 'audits', 'latest.md')
  assert.match(md, /## Tailwind palette classes\n\nThe code uses 5 Tailwind palette classes, 4 distinct\. Most used: text-slate-700 ×2, bg-white ×1, text-red-600\/50 ×1, text-slate-400 ×1\./)
  assert.match(md, /a palette class whose colour a token holds is a finding, with that token as its fix/)

  // The adopted token set, built into Tailwind: bg-brand is the repo's own,
  // text-slate-400 renders the ink, and no token holds the other colours.
  writeFileSync(join(ctx.root, 'massimo.config.json'), JSON.stringify(configOf(['tailwind3'], { source: 'tokens/base.tokens.json', outputs: [{ format: 'tailwind3', path: 'tokens.tailwind.cjs' }] })))
  const after = audit(ctx, ['--baseline'])
  assert.deepEqual(palette(after), ['text-slate-400 --color-ink'])
  assert.deepEqual(after.paletteClasses, {
    count: 4,
    distinct: 3,
    top: [
      { name: 'text-slate-700', count: 2 },
      { name: 'bg-white', count: 1 },
      { name: 'text-red-600/50', count: 1 },
    ],
  })
  const md2 = read(ctx.project, 'audits', 'latest.md')
  assert.match(md2, /- tailwind-palette: 1 \(4 more palette classes counted, not ratcheted\)\n/)
  assert.match(md2, /4 Tailwind palette classes, 3 distinct, use a colour no token holds\./)
  assert.match(md2, /- L2 tailwind-palette `text-slate-400`, its colour is `--color-ink`\n/)
  assert.deepEqual(readJson(ctx.project, 'audits', 'baseline.json').kinds['tailwind-palette'], { count: 1, offenders: { 'src/components/Page.vue: text-slate-400': 1 } })

  // A token at the opacity a modifier sets holds that class too.
  writeFileSync(join(ctx.root, 'tokens', 'base.tokens.json'), JSON.stringify({ color: { ...JSON.parse(TOKENS).color, alert: { $value: '#dc262680' } } }))
  assert.deepEqual(palette(audit(ctx)), ['text-red-600/50 --color-alert', 'text-slate-400 --color-ink'])

  // Turned on in audit.kinds, every palette class is a finding, as before.
  writeFileSync(join(ctx.root, 'massimo.config.json'), JSON.stringify(configOf(['tailwind3'], { source: 'tokens/base.tokens.json', outputs: [{ format: 'tailwind3', path: 'tokens.tailwind.cjs' }] }, { kinds: { 'tailwind-palette': true } })))
  const on = audit(ctx)
  assert.deepEqual(palette(on), ['bg-white', 'text-red-600/50 --color-alert', 'text-slate-400 --color-ink', 'text-slate-700', 'text-slate-700'])
  assert.equal(on.paletteClasses, undefined)
})

test('in a Tailwind 4 app whose style files declare colours of their own, every palette class is a finding, as before', () => {
  const files = {
    'src/main.css': '@import "tailwindcss";\n@theme {\n  --color-brand: #123456;\n}\n',
    'src/components/Page.vue': PAGE,
  }
  const ctx = repoOf(files, configOf(['tailwind4']))
  const latest = audit(ctx)
  assert.deepEqual(palette(latest).sort(), ['bg-white', 'text-red-600/50', 'text-slate-400', 'text-slate-700', 'text-slate-700'])
  assert.equal(latest.paletteClasses, undefined)
  assert.doesNotMatch(read(ctx.project, 'audits', 'latest.md'), /Tailwind palette classes/)
})

test("a Tailwind config's theme.colors or a @theme reset replaces Tailwind's palette, so its classes are the repo's own", () => {
  const files = {
    'src/main.css': 'body { margin: 0; }\n',
    'src/components/Page.vue': PAGE,
    'src/colors.ts': "export const brandColors = { slate: { 400: '#8899aa' } }\n",
    'tailwind.config.js': "import { brandColors } from './src/colors'\n\nexport default {\n  content: ['./src/**/*.vue'],\n  theme: {\n    colors: brandColors,\n    extend: { spacing: { 13: '3.25rem' } },\n  },\n}\n",
    'tokens/base.tokens.json': TOKENS,
  }
  const tokens = { source: 'tokens/base.tokens.json', tailwindConfig: 'tailwind.config.js', outputs: [{ format: 'tailwind3', path: 'tokens.tailwind.cjs' }] }
  const ctx = repoOf(files, configOf(['tailwind3'], tokens))
  const why = "tailwind.config.js sets theme.colors, which replaces Tailwind's palette, so every palette-named class is one of the repo's own colours"
  const latest = audit(ctx)
  assert.deepEqual(palette(latest), [])
  assert.equal(latest.skipped['tailwind-palette'], why)
  assert.equal(latest.paletteClasses, undefined)
  // Turned on, the kind still has no palette of Tailwind's to hold.
  writeFileSync(join(ctx.root, 'massimo.config.json'), JSON.stringify(configOf(['tailwind3'], tokens, { kinds: { 'tailwind-palette': true } })))
  assert.equal(audit(ctx).skipped['tailwind-palette'], why)
  // Under extend, the palette stays.
  writeFileSync(join(ctx.root, 'tailwind.config.js'), "export default {\n  theme: {\n    extend: { colors: { brand: '#123456' } },\n  },\n}\n")
  assert.deepEqual(palette(audit(ctx)).sort(), ['bg-white', 'text-red-600/50', 'text-slate-400 --color-ink', 'text-slate-700', 'text-slate-700'])

  // Tailwind 4: a @theme that resets the colours.
  const four = repoOf({ ...files, 'src/main.css': '@import "tailwindcss";\n@theme {\n  --color-*: initial;\n  --color-brand: #123456;\n}\n' }, configOf(['tailwind4']))
  const reset = audit(four)
  assert.deepEqual(palette(reset), [])
  assert.equal(reset.skipped['tailwind-palette'], "src/main.css resets the theme's colours, which replaces Tailwind's palette, so every palette-named class is one of the repo's own colours")
})
