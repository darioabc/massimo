// lane-css.mjs: which modules only stories use, the `@source not` lines of a
// stylesheet, the CSS layout faults, and the class names a stylesheet defines.

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { walk } from '../scripts/lib/glob.mjs'
import { cssClasses, cssLayoutProblems, sourceNotLines, sourceWords, storyOnlyModules } from '../scripts/lib/lane-css.mjs'
import { DEFAULTS, deepMerge } from '../scripts/lib/project.mjs'
import { scratch } from './helpers.mjs'

const contexts = []
after(() => contexts.forEach((c) => c.cleanup()))

// A scratch copy of the csf-lane fixture with `extra` files written over it
// and `edit` applied to its config.
function lane(extra = {}, edit = () => {}) {
  const ctx = scratch('csf-lane')
  contexts.push(ctx)
  for (const [file, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(ctx.root, file)), { recursive: true })
    writeFileSync(join(ctx.root, file), text)
  }
  const raw = JSON.parse(readFileSync(join(ctx.root, 'massimo.config.json'), 'utf8'))
  edit(raw)
  const config = deepMerge(structuredClone(DEFAULTS), raw)
  return { root: ctx.root, config, files: walk(ctx.root, { ignore: config.ignore }) }
}

const layout = (c) => ({ ...c.stories, appCss: { base: 'src/styles/base.css', entry: 'src/styles/app.css' } })
const BASE = '@import "tailwindcss";\n'
const COMPONENTS = '@source not "../components";\n'
const ENTRY = `@import "./base.css";\n@source not "../pages/review/tableHarness.tsx";\n${COMPONENTS}`

test('a module only stories, tests and other such modules import is story-only', () => {
  const t = lane({
    'src/pages/review/rows.ts': 'export const FIXED = 3\n',
    'src/pages/review/tableHarness.tsx': `import { FIXED } from './rows'\nexport const ROWS = [FIXED]\nexport const ReviewTable = () => null\n`,
    'src/pages/review/tableHarness.test.tsx': `import { ROWS } from './tableHarness'\n`,
    'src/components/Button.stories.test.tsx': `import * as stories from './Button.stories'\nimport { testOnly } from './testOnly'\n`,
    'src/components/testOnly.ts': 'export const testOnly = 1\n',
  })
  // The fixture's components are imported by their stories alone, so they count too.
  assert.deepEqual(storyOnlyModules(t), ['src/components/Button.tsx', 'src/components/Card.tsx', 'src/components/gauge/Editor.tsx', 'src/pages/review/rows.ts', 'src/pages/review/tableHarness.tsx'])
})

test('a module only tests import is test support, not story-only, and neither is what only it imports', () => {
  const t = lane({
    'scripts/report.ts': `import { rule } from './rule'\nexport const report = rule\n`,
    'scripts/rule.ts': 'export const rule = 1\n',
    'scripts/report.test.ts': `import { report } from './report'\n`,
  })
  const only = storyOnlyModules(t)
  for (const f of ['scripts/report.ts', 'scripts/rule.ts']) assert.ok(!only.includes(f), f)
})

test('a module app code also imports stays app code, and so does what only it imports', () => {
  const t = lane({
    'src/shared.ts': 'export const shared = 1\n',
    'src/deep.ts': 'export const deep = 1\n',
    'src/App.tsx': `import { shared } from './shared'\nexport const App = () => shared\n`,
    'src/pages/review/tableHarness.tsx': `import { shared } from '../../shared'\nimport { deep } from '../../deep'\nexport const ROWS = [shared, deep]\nexport const ReviewTable = () => null\n`,
    'src/components/Button.stories.tsx': `import type { Story } from '@ladle/react'\nimport { shared } from '../shared'\nexport default { title: 'Primitives / Actions / Button' }\nexport const A: Story = () => shared\n`,
  })
  const only = storyOnlyModules(t)
  assert.ok(!only.includes('src/shared.ts'))
  assert.ok(only.includes('src/pages/review/tableHarness.tsx'))
  // deep.ts is imported by a story-only module alone, so the fixpoint takes it in.
  assert.ok(only.includes('src/deep.ts'))
})

test('a cycle nothing outside reaches, a type-only import and a file nobody imports are not story-only', () => {
  const t = lane({
    'src/a.ts': `import './b'\n`,
    'src/b.ts': `import './a'\n`,
    'src/orphan.ts': 'export const orphan = 1\n',
    'src/types.ts': 'export type T = string\n',
    'src/App.tsx': `import type { T } from './types'\nexport const App = (): T => ''\n`,
    'src/components/Card.stories.tsx': `import type { Story } from '@ladle/react'\nimport { Card } from './Card'\nimport type { T } from '../types'\nexport default { title: 'Patterns / Cards / Card' }\nexport const Plain: Story = () => Card\n`,
  })
  const only = storyOnlyModules(t)
  for (const f of ['src/a.ts', 'src/b.ts', 'src/orphan.ts', 'src/types.ts']) assert.ok(!only.includes(f), f)
})

test('stories.storyOnly adds files the import graph cannot see', () => {
  const t = lane({ 'src/fixtures/rows.json.ts': 'export default []\n', 'src/App.tsx': `import rows from './fixtures/rows.json'\nexport default rows\n` }, (c) => (c.stories.storyOnly = ['src/fixtures/**']))
  assert.ok(storyOnlyModules(t).includes('src/fixtures/rows.json.ts'))
  const plain = lane({ 'src/fixtures/rows.json.ts': 'export default []\n' })
  assert.ok(!storyOnlyModules(plain).includes('src/fixtures/rows.json.ts'))
})

test('sourceNotLines resolves each glob from the file that declares it', () => {
  const css = ['@import "./base.css";', '/* @source not "../old"; */', '@source "../stories";', "@source not '../pages/review';", '@source not inline("p-4");', '', '  @source not "/src/tmp/**";'].join('\n')
  assert.deepEqual(sourceNotLines(css, 'src/styles/app.css'), [
    { file: 'src/styles/app.css', line: 4, raw: '../pages/review', glob: 'src/pages/review' },
    { file: 'src/styles/app.css', line: 7, raw: '/src/tmp/**', glob: 'src/tmp/**' },
  ])
  assert.deepEqual(sourceNotLines('@source not "./gen/**/*.ts";\n', 'styles.css').map((l) => l.glob), ['gen/**/*.ts'])
  assert.deepEqual(sourceNotLines('@import "tailwindcss";\n', 'a.css'), [])
})

test('a layout with the exclusions in the entry CSS and a covered harness has no fault', () => {
  const t = lane({ 'src/styles/base.css': BASE, 'src/styles/app.css': ENTRY }, (c) => (c.stories = layout(c)))
  assert.deepEqual(cssLayoutProblems(t), [])
  assert.deepEqual(cssLayoutProblems(lane()), [], 'nothing is checked before stories.appCss names the base')
})

test('a base CSS that holds @source not is refused, and so is a sheet it imports', () => {
  const own = lane({ 'src/styles/base.css': `${BASE}@source not "../pages";\n`, 'src/styles/app.css': ENTRY }, (c) => (c.stories = layout(c)))
  const [one] = cssLayoutProblems(own)
  assert.equal(one.rule, 'css-base')
  assert.equal(one.file, 'src/styles/base.css')
  assert.match(one.detail, /line 2 has @source not "\.\.\/pages"/)
  assert.match(one.detail, /src\/styles\/app\.css/)

  const imported = lane({ 'src/styles/base.css': `${BASE}@import "./theme.css";\n`, 'src/styles/theme.css': '@source not "./x";\n', 'src/styles/app.css': ENTRY }, (c) => (c.stories = layout(c)))
  assert.deepEqual(cssLayoutProblems(imported).map((p) => [p.rule, p.file]), [['css-base', 'src/styles/theme.css']])
})

test('a missing base or entry CSS is a fault', () => {
  const t = lane({}, (c) => (c.stories = layout(c)))
  assert.deepEqual(cssLayoutProblems(t).filter((p) => p.rule === 'css-base').map((p) => p.file), ['src/styles/app.css', 'src/styles/base.css'])
})

test('app code that imports a story-only module, or a file the entry CSS excludes, is refused', () => {
  const t = lane(
    {
      'src/styles/base.css': BASE,
      'src/styles/app.css': `${ENTRY}@source not "../legacy";\n`,
      'src/fixtures/rows.ts': 'export const rows = []\n',
      'src/legacy/old.ts': 'export const old = 1\n',
      'src/App.tsx': `import { rows } from './fixtures/rows'\nimport { old } from './legacy/old'\nexport const App = () => [rows, old]\n`,
    },
    (c) => {
      c.stories = layout(c)
      c.stories.storyOnly = ['src/fixtures/**']
    },
  )
  assert.deepEqual(cssLayoutProblems(t).filter((p) => p.rule === 'css-app-import').map((p) => [p.file, p.detail]), [
    ['src/App.tsx', 'it imports src/fixtures/rows.ts, which only stories use'],
    ['src/App.tsx', "it imports src/legacy/old.ts, which src/styles/app.css excludes from the app's CSS"],
  ])
})

test('a story-only module the entry CSS does not exclude is a warning, not a fault', () => {
  const t = lane({ 'src/styles/base.css': BASE, 'src/styles/app.css': `@import "./base.css";\n${COMPONENTS}` }, (c) => (c.stories = layout(c)))
  const found = cssLayoutProblems(t)
  assert.deepEqual(found, [
    { rule: 'css-uncovered', file: 'src/pages/review/tableHarness.tsx', detail: "only stories use it, but src/styles/app.css does not exclude it from the app's CSS", severity: 'warn' },
  ])
})

test('with no entry CSS the exclusions are not read, but the base is still checked', () => {
  const t = lane({ 'src/styles/base.css': `${BASE}@source not "../x";\n` }, (c) => (c.stories = { ...c.stories, appCss: { base: 'src/styles/base.css', entry: null } }))
  assert.deepEqual(cssLayoutProblems(t).map((p) => p.rule), ['css-base'])
})

test('cssClasses reads class selectors, unescaped, and nothing from values, urls or at-rules', () => {
  const css = [
    '/* .commented { } */',
    '.btn, .btn-lg:hover > .icon { margin: 0.5rem; background: url(./x.1.png) }',
    '.w-\\[13\\.37rem\\] { width: 13.37rem }',
    '.md\\:p-4 { padding: 1rem }',
    '.\\32xl\\:p-2 { padding: .5rem }',
    '@media (min-width: 40rem) { .sm\\:flex { display: flex } }',
    '@layer utilities { .nested { color: red; .inner { color: blue } } }',
    '.a::before { content: ".fake" }',
  ].join('\n')
  assert.deepEqual([...cssClasses(css)].sort(), ['2xl:p-2', 'a', 'btn', 'btn-lg', 'icon', 'inner', 'md:p-4', 'nested', 'sm:flex', 'w-[13.37rem]'])
})

test('sourceWords splits on whitespace, quotes and JSX punctuation but keeps utility syntax', () => {
  const words = sourceWords(`<div className={\`w-[13.37rem] \${on ? 'p-4' : "md:flex"}\`} data-x="a b" />`)
  for (const w of ['w-[13.37rem]', 'p-4', 'md:flex', 'a', 'b']) assert.ok(words.has(w), w)
})
