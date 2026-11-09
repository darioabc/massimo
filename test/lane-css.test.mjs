// lane-css.mjs: which modules only stories use, the `@source not` lines of a
// stylesheet, the CSS layout faults, and the class names a stylesheet defines.

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { walk } from '../scripts/lib/glob.mjs'
import { cssClasses, cssLayoutProblems, ownClasses, sourceNotLines, sourceWords, storyOnly, storyOnlyModules } from '../scripts/lib/lane-css.mjs'
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

test('a cycle that only stories reach is story-only whole, and one app code also reaches is not', () => {
  const cycle = {
    'src/pages/review/harnessA.tsx': `import { b } from './harnessB'\nexport const A = () => b\n`,
    'src/pages/review/harnessB.tsx': `import { A } from './harnessA'\nexport const b = 1\nexport const useA = () => A\n`,
    'src/pages/review/Cycle.stories.tsx': `import { A } from './harnessA'\nexport default { title: 'Pages / Cycle' }\nexport const Plain = () => A\n`,
  }
  const only = storyOnlyModules(lane(cycle))
  for (const f of ['src/pages/review/harnessA.tsx', 'src/pages/review/harnessB.tsx']) assert.ok(only.includes(f), f)
  const shared = storyOnlyModules(lane({ ...cycle, 'src/App.tsx': `import { b } from './pages/review/harnessB'\nexport const App = () => b\n` }))
  for (const f of ['src/pages/review/harnessA.tsx', 'src/pages/review/harnessB.tsx']) assert.ok(!shared.includes(f), f)
})

// The lane's scaffold as the recipe writes it, in the folder of the HTML entry's module script.
const SCAFFOLD = {
  'stories.html': '<!doctype html>\n<html><body><!-- <script type="module" src="/src/old.tsx"></script> -->\n<script src="/src/stories/main.tsx?v=1" type="module"></script></body></html>\n',
  'src/stories/main.tsx': `import Shell from './Shell'\nimport Canvas from './Canvas'\nexport { Shell, Canvas }\n`,
  'src/stories/Shell.tsx': 'export default function Shell() { return null }\n',
  'src/stories/Canvas.tsx': 'export default function Canvas() { return null }\n',
  'src/stories/story.ts': 'export type Story = () => null\n',
  'src/stories/frame.tsx': `import { surface } from '../frameParts'\nexport default function Frame({ children }) { return children }\nexport const s = surface\n`,
  'src/frameParts.ts': 'export const surface = "story-surface"\n',
}
const framed = (c) => (c.stories.frame = 'src/stories/frame.tsx')

test('the lane\'s scaffold folder and what only it imports are story-only', () => {
  const found = storyOnly(lane(SCAFFOLD, framed))
  assert.equal(found.scaffold, 'src/stories')
  for (const f of ['src/stories/main.tsx', 'src/stories/Shell.tsx', 'src/stories/Canvas.tsx', 'src/stories/story.ts', 'src/stories/frame.tsx', 'src/frameParts.ts']) assert.ok(found.modules.includes(f), f)
  assert.deepEqual(storyOnlyModules(lane(SCAFFOLD, framed)), found.modules)
  // With no lane entry there is no scaffold folder, and the frame alone counts.
  const bare = storyOnly(lane({ ...SCAFFOLD, 'stories.html': '<html></html>\n' }, framed))
  assert.equal(bare.scaffold, null)
  assert.ok(bare.modules.includes('src/stories/frame.tsx') && bare.modules.includes('src/frameParts.ts'))
  assert.ok(!bare.modules.includes('src/stories/main.tsx'))
})

test('a folder that holds the app\'s own entry, or a file app code imports, is no scaffold folder', () => {
  // The lane's entry script sits beside the app's, which nothing imports.
  const beside = lane({
    'stories.html': '<script type="module" src="/src/lane.tsx"></script>\n',
    'index.html': '<script type="module" src="/src/main.tsx"></script>\n',
    'src/lane.tsx': `import { LaneOnly } from './laneOnly'\nexport const lane = LaneOnly\n`,
    'src/laneOnly.ts': 'export const LaneOnly = 1\n',
    'src/main.tsx': `import { App } from './App'\nexport const main = App\n`,
    'src/App.tsx': 'export const App = 1\n',
  })
  const found = storyOnly(beside)
  assert.equal(found.scaffold, null)
  assert.ok(found.modules.includes('src/lane.tsx') && found.modules.includes('src/laneOnly.ts'))
  for (const f of ['src/main.tsx', 'src/App.tsx']) assert.ok(!found.modules.includes(f), f)

  const imported = storyOnly(lane({ ...SCAFFOLD, 'src/App.tsx': `import Shell from './stories/Shell'\nexport const App = Shell\n` }, framed))
  assert.equal(imported.scaffold, null)
  assert.ok(!imported.modules.includes('src/stories/Shell.tsx'))
  assert.ok(imported.modules.includes('src/stories/main.tsx'))
})

test('the scaffold folder is one warning when the entry CSS does not exclude it, and none when it does', () => {
  const uncovered = lane({ ...SCAFFOLD, 'src/styles/base.css': BASE, 'src/styles/app.css': ENTRY }, (c) => {
    c.stories = layout(c)
    framed(c)
  })
  assert.deepEqual(cssLayoutProblems(uncovered), [
    { rule: 'css-uncovered', file: 'src/frameParts.ts', detail: "only stories use it, but src/styles/app.css does not exclude it from the app's CSS", severity: 'warn' },
    { rule: 'css-uncovered', file: 'src/stories', detail: "the lane's scaffold is here, but src/styles/app.css does not exclude it from the app's CSS", severity: 'warn' },
  ])
  const covered = lane({ ...SCAFFOLD, 'src/styles/base.css': BASE, 'src/styles/app.css': `${ENTRY}@source not "../stories";\n@source not "../frameParts.ts";\n` }, (c) => {
    c.stories = layout(c)
    framed(c)
  })
  assert.deepEqual(cssLayoutProblems(covered), [])
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

test('cssClasses reads a bracket that never closes before escaped class names in time that grows with its length', () => {
  // A Sass comment is not blanked, so the bracket in it reaches the selector.
  const css = `// see [docs\n.icon-${'\\31 0'.repeat(14)}{color:red}`
  const start = Date.now()
  assert.deepEqual([...cssClasses(css)], [`icon-${'10'.repeat(14)}`])
  assert.ok(Date.now() - start < 500, `${Date.now() - start} ms`)
})

test('sourceWords splits on whitespace, quotes and JSX punctuation but keeps utility syntax', () => {
  const words = sourceWords(`<div className={\`w-[13.37rem] \${on ? 'p-4' : "md:flex"}\`} data-x="a b" />`)
  for (const w of ['w-[13.37rem]', 'p-4', 'md:flex', 'a', 'b']) assert.ok(words.has(w), w)
})

test('sourceWords finds a class whose square brackets hold a quote, an = or a >, and makes no class of code', () => {
  const words = sourceWords(
    [
      '<div className="[&>div]:static data-[state=open]:block hover:[mask-type:luminance]" />',
      `const tip = cn('has-[[data-open=true]]:flex', \`before:content-[''] \${wide ? 'w-[13.37rem]' : ''}\`)`,
      `const v = rows['key'] ?? items[i>0 ? 1 : 0]; const f = (a: Array<string[]>) => a[0] === "x" ? [a=b] : c`,
    ].join('\n'),
  )
  for (const w of ['[&>div]:static', 'data-[state=open]:block', 'hover:[mask-type:luminance]', 'has-[[data-open=true]]:flex', "before:content-['']", 'w-[13.37rem]']) assert.ok(words.has(w), w)
  for (const w of ["rows['key']", "['key']", 'items[i>0', 'string[]>', '[a=b]']) assert.ok(!words.has(w), w)
})

// Tailwind 4's own output, minified, as a build writes it.
const UTILITIES = [
  String.raw`/*! tailwindcss v4 | MIT License */@layer theme{:root,:host{--spacing:.25rem}}`,
  String.raw`@layer utilities{.mt-10{margin-top:calc(var(--spacing) * 10)}.w-\[13\.37rem\]{width:13.37rem}.sr-only::before{content:""}`,
  String.raw`:where(.space-x-4>:not(:last-child)){margin-inline-start:calc(var(--spacing) * 4)}`,
  String.raw`@media (min-width:40rem){.sm\:flex{display:flex}}@media (hover:hover){.hover\:bg-red-500:hover{background-color:red}}`,
  String.raw`@supports (color:color-mix(in lab,red,red)){.bg-red-500\/50{background-color:color-mix(in oklab,red 50%,transparent)}}`,
  String.raw`@container (min-width:24rem){.\@sm\:p-2{padding:.5rem}}`,
  String.raw`.group-hover\:flex:is(:where(.group):hover *){display:flex}.dark\:p-4:where(.dark,.dark *){padding:1rem}`,
  String.raw`.\[\&\>div\]\:static>div{position:static}.\[\&_svg\]\:size-4 svg{width:1rem}`,
  String.raw`.before\:content-\[\'\'\]:before{content:var(--tw-content);--tw-content:""}`,
  String.raw`.data-\[state\=open\]\:block[data-state=open]{display:block}.has-\[\[data-open\=true\]\]\:flex:has([data-open=true]){display:flex}}`,
].join('')

test('ownClasses holds a class by a rule of its own, inside @media, @supports, @layer and @container too', () => {
  assert.deepEqual([...ownClasses(UTILITIES)].sort(), [
    '@sm:p-2',
    '[&>div]:static',
    '[&_svg]:size-4',
    "before:content-['']",
    'bg-red-500/50',
    'dark:p-4',
    'data-[state=open]:block',
    'group-hover:flex',
    'has-[[data-open=true]]:flex',
    'hover:bg-red-500',
    'mt-10',
    'sm:flex',
    'space-x-4',
    'sr-only',
    'w-[13.37rem]',
  ])
  // The loose read names the marker classes the variants sit under as well.
  assert.ok(cssClasses(UTILITIES).has('group') && cssClasses(UTILITIES).has('dark'))
  assert.ok(cssClasses(UTILITIES).has("before:content-['']"))
})

test('ownClasses leaves out a class a package scopes under its own, a component compound and other wrappers', () => {
  const css = [
    // A package's prebuilt sheet, every utility under the package's class.
    '.widget .mt-10{margin-top:2.5rem}.widget .p-10,.widget .w-24{padding:2.5rem}.widget{display:block}',
    // A component library's compound and its child rule.
    ':is(.tooltip.tooltip-open,.tooltip:hover)>.tooltip-content{opacity:1}.tooltip{position:relative}',
    '.btn:not(.btn-ghost){border-width:1px}.btn:hover{opacity:.9}',
    // Scoped by an element, an id, an attribute or @scope, or a keyframe step.
    'body .h-77{height:1px}#root .h-78{height:1px}[dir=rtl] .h-79{height:1px}@scope (.join){.join-item{border-radius:0}}',
    '@keyframes spin{from{rotate:0}50.5%{rotate:180deg}to{rotate:360deg}}',
    // Nested rules: the parent holds its class, and a child under it does not.
    '.card{padding:1rem;&:hover{opacity:.9}.title{font-weight:600}&.card-wide{width:100%}}',
  ].join('\n')
  assert.deepEqual([...ownClasses(css)].sort(), ['btn', 'card', 'tooltip', 'widget'])
  assert.deepEqual([...cssClasses(css)].sort(), ['btn', 'btn-ghost', 'card', 'card-wide', 'h-77', 'h-78', 'h-79', 'join-item', 'mt-10', 'p-10', 'title', 'tooltip', 'tooltip-content', 'tooltip-open', 'w-24', 'widget'])
})

test('ownClasses holds a class with a variant beside the classes its variant names, and not under a package\'s class', () => {
  const css = [
    // Tailwind 3 puts the classes a variant names around the class.
    String.raw`.group:hover .group-hover\:flex{display:flex}.group\/item:hover .group-hover\/item\:block{display:block}`,
    String.raw`.peer:checked~.peer-checked\:hidden{display:none}:is(.dark .dark\:bg-black){background:#000}`,
    String.raw`.group.is-open .group-\[\.is-open\]\:grid{display:grid}.theme-x .\[\.theme-x_\&\]\:p-4{padding:1rem}`,
    String.raw`@starting-style{.starting\:opacity-0{opacity:0}}`,
    // A package's sheet scopes its variants under its own class, flat or nested.
    String.raw`.widget .hover\:opacity-90:hover{opacity:.9}@media (min-width:22.5rem){.widget .min-\[360px\]\:block{display:block}}`,
    String.raw`.widget{display:block;.focus\:ring-2:focus{outline:0}}.b .hover\:bg-black:hover{background:#000}`,
    // A component's descendant, and a class named only inside a pseudo-class.
    String.raw`.sm\:card-md .card-body{padding:1rem}.btn:not(.md\:hidden){display:flex}`,
  ].join('\n')
  assert.deepEqual([...ownClasses(css)].sort(), [
    '[.theme-x_&]:p-4',
    'dark:bg-black',
    'group-[.is-open]:grid',
    'group-hover/item:block',
    'group-hover:flex',
    'peer-checked:hidden',
    'starting:opacity-0',
    'widget',
  ])
})
