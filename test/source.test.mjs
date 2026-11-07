import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  componentName,
  createResolver,
  extractExports,
  extractImports,
  extractRules,
  isStoryFile,
  isTestFile,
  parseCustomProperties,
  stringLiterals,
  stripComments,
} from '../scripts/lib/source.mjs'

const specs = (imports) => imports.map((i) => `${i.kind}:${i.spec}${i.typeOnly ? ':type' : ''}`)

test('extractImports finds every import form and ignores comments', () => {
  const source = `
import a, { b } from "./a"
import * as ns from '../ns'
import './side.css'
import type { T } from './types'
import { type A, type B } from './ab'
export { x as y } from './z'
export * from './all'
const lazy = import('./lazy')
const r = require("./req")
// import Commented from './nope'
/* import Block from './nope2' */
const s = \`import fake from './fake'\`
`
  assert.deepEqual(specs(extractImports(source, 'a.tsx')), [
    'static:./a',
    'static:../ns',
    'side-effect:./side.css',
    'static:./types:type',
    'static:./ab:type',
    'export-from:./z',
    'export-from:./all',
    'dynamic:./lazy',
    'require:./req',
  ])
})

test('extractImports records imported names and re-export shapes', () => {
  const imports = extractImports(`import Def, { b as c, d } from './m'\nimport * as all from './n'\nexport { default as X, y } from './x'\nexport * from './s'\nexport * as ns from './t'`, 'a.ts')
  assert.deepEqual(imports[0].names, ['default', 'b', 'd'])
  assert.deepEqual(imports[1].names, ['*'])
  assert.deepEqual(imports[2].reexport, { star: false, ns: null, pairs: [{ orig: 'default', name: 'X' }, { orig: 'y', name: 'y' }] })
  assert.equal(imports[3].reexport.star, true)
  assert.equal(imports[4].reexport.ns, 'ns')
})

test('extractImports scans whole SFC files, Astro frontmatter included', () => {
  const astro = `---\nimport Layout from '../layouts/Layout.astro'\n---\n<Layout><p>don't</p></Layout>\n`
  assert.deepEqual(specs(extractImports(astro, 'a.astro')), ['static:../layouts/Layout.astro'])
  const vue = `<template><i/></template>\n<script setup lang="ts">\nimport Icon from './Icon.vue'\n</script>`
  assert.deepEqual(specs(extractImports(vue, 'a.vue')), ['static:./Icon.vue'])
  const svelte = `<script>\n  import Badge from './Badge.svelte'\n</script>\n<Badge />`
  assert.deepEqual(specs(extractImports(svelte, 'a.svelte')), ['static:./Badge.svelte'])
})

test('extractExports covers declarations, lists, defaults and SFCs', () => {
  const ts = `
export function A() {}
export const b = 1, c = 2
export class D {}
export type T = string
export interface Props {}
export enum E { X }
export default function Foo() {}
export { x as y, type Z } from './z'
export * as helpers from './h'
`
  assert.deepEqual(extractExports(ts, 'a.tsx'), ['A', 'D', 'E', 'Foo', 'Props', 'T', 'Z', 'b', 'helpers', 'y'])
  assert.deepEqual(extractExports('export default () => 1', 'a.ts'), ['default'])
  assert.deepEqual(extractExports('<script>export let prop = 1</script>', 'src/Chip.svelte'), ['Chip'])
  assert.deepEqual(extractExports('---\nexport interface Props {}\n---', 'src/ui/index.astro'), ['Props', 'ui'])
})

test('componentName: basename, or the directory for index files', () => {
  assert.equal(componentName('src/components/Button.tsx'), 'Button')
  assert.equal(componentName('src/components/Panel/index.tsx'), 'Panel')
  assert.equal(componentName('index.ts'), 'index')
})

test('extractRules: any comment syntax, wrapping, accumulation, unknown keys', () => {
  const { rules, unknown } = extractRules(`// ds:group Primitives / Actions
// ds:use-when you press something that
//   runs an action
//
// not part of the value
// ds:never nested
// ds:never in a Card
const x = 1
// ds:nope foo
/* ds:no-story */
/*
 * ds:children Foo,
 * Bar
 */
{/* ds:parents Page */}
<!-- ds:parents Section -->
`)
  assert.deepEqual(rules, {
    parents: 'Page Section',
    children: 'Foo, Bar',
    never: 'nested in a Card',
    'use-when': 'you press something that runs an action',
    group: 'Primitives / Actions',
    'no-story': '',
  })
  assert.deepEqual(unknown, ['nope'])
})

test('stripComments keeps offsets and leaves strings alone', () => {
  const src = `const a = "// not a comment" // real\n/* block */ const b = 'x'`
  const out = stripComments(src, 'a.ts')
  assert.equal(out.length, src.length)
  assert.ok(out.includes('"// not a comment"'))
  assert.ok(!out.includes('real'))
  assert.ok(!out.includes('block'))
  assert.deepEqual(stringLiterals(src, 'a.ts').map((s) => s.text), ['// not a comment', 'x'])
  assert.equal(stripComments('a { color: red } /* c */', 'a.css').includes('c */'), false)
  assert.equal(stripComments('url(//cdn.example.com/x.css) // not a css comment', 'a.css').includes('not a css comment'), true)
})

test('isStoryFile and isTestFile', () => {
  assert.ok(isStoryFile('a/Button.stories.tsx') && isStoryFile('Button.story.vue') && !isStoryFile('Button.tsx'))
  assert.ok(isTestFile('a/Button.test.tsx') && isTestFile('x.spec.ts') && isTestFile('src/__tests__/a.ts') && !isTestFile('Button.tsx'))
})

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-resolve-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

test('createResolver: relative paths, extension order, index files', () => {
  const root = repo({ 'src/a.ts': '', 'src/a.tsx': '', 'src/b/index.tsx': '', 'src/c.vue': '', 'src/d.svelte': '', 'src/e.astro': '', 'src/style.css': '', 'src/f.ts': '' })
  try {
    const resolve = createResolver(root, {})
    assert.deepEqual(resolve('src/x.ts', './a'), { file: 'src/a.ts' })
    assert.deepEqual(resolve('src/x.ts', './b'), { file: 'src/b/index.tsx' })
    assert.deepEqual(resolve('src/x.ts', './c.vue'), { file: 'src/c.vue' })
    assert.deepEqual(resolve('src/x.ts', './d'), { file: 'src/d.svelte' })
    assert.deepEqual(resolve('src/x.ts', './e'), { file: 'src/e.astro' })
    assert.deepEqual(resolve('src/x.ts', './style.css?inline'), { file: 'src/style.css' })
    assert.deepEqual(resolve('src/x.ts', './f.js'), { file: 'src/f.ts' }) // TS-style .js import
    assert.deepEqual(resolve('src/x.ts', './missing'), { unresolved: './missing' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createResolver: config aliases, tsconfig paths, extends, references, baseUrl', () => {
  const root = repo({
    'src/lib/util.ts': '',
    'src/components/Card.tsx': '',
    'ui/Button.tsx': '',
    'tools/helper.ts': '',
    'tsconfig.json': '{ // c\n "extends": "./tsconfig.base.json", "references": [{ "path": "./tsconfig.app.json" }] }',
    'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } } }',
    'tsconfig.app.json': '{ "compilerOptions": { "paths": { "@ui/*": ["./ui/*"] } } }',
    'package.json': '{ "dependencies": { "react": "1", "@scope/pkg": "1" } }',
  })
  try {
    const resolve = createResolver(root, { aliases: { '@/': 'src/', '~tools': 'tools' } })
    assert.deepEqual(resolve('src/x.ts', '@/components/Card'), { file: 'src/components/Card.tsx' })
    assert.deepEqual(resolve('src/x.ts', '~tools/helper'), { file: 'tools/helper.ts' })
    assert.deepEqual(resolve('src/x.ts', '@lib/util'), { file: 'src/lib/util.ts' })
    assert.deepEqual(resolve('src/x.ts', '@ui/Button'), { file: 'ui/Button.tsx' })
    assert.deepEqual(resolve('src/x.ts', 'src/lib/util'), { file: 'src/lib/util.ts' }) // via baseUrl
    assert.deepEqual(resolve('src/x.ts', '@/missing'), { unresolved: '@/missing' })
    assert.deepEqual(resolve('src/x.ts', 'react'), { pkg: 'react' })
    assert.deepEqual(resolve('src/x.ts', 'react/jsx-runtime'), { pkg: 'react' })
    assert.deepEqual(resolve('src/x.ts', '@scope/pkg/deep/path'), { pkg: '@scope/pkg' })
    assert.deepEqual(resolve('src/x.ts', 'node:fs'), { external: 'node:fs' })
    assert.deepEqual(resolve('src/x.ts', 'astro:content'), { external: 'astro:content' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createResolver: a catch-all paths pattern still returns real packages', () => {
  const root = repo({ 'src/Thing.tsx': '', 'tsconfig.json': '{ "compilerOptions": { "paths": { "@*": ["./src/*"] } } }', 'package.json': '{ "dependencies": { "@radix-ui/react-slot": "1" } }' })
  try {
    const resolve = createResolver(root, {})
    assert.deepEqual(resolve('src/x.ts', '@Thing'), { file: 'src/Thing.tsx' })
    assert.deepEqual(resolve('src/x.ts', '@radix-ui/react-slot'), { pkg: '@radix-ui/react-slot' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseCustomProperties: modes and scopes', () => {
  const css = `
@plugin "daisyui" { themes: light --default, dark --prefersdark; }
@plugin "daisyui/theme" { name: "light"; default: true; --color-primary: #14b8a6; }
@plugin "daisyui/theme" { name: "dark"; prefersdark: true; --color-primary: #2dd4bf; }
@theme inline { --font-sans: "Geist", sans-serif; }
:root { --a: 1px; --b: var(--a); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --a: 2px } }
[data-theme="corp"] { --a: 3px; background: url(data:image/svg+xml;base64,AAA=); }
.dark { --a: 4px }
.card { --local: 1px; }
`
  const rows = parseCustomProperties(css).map((p) => `${p.name}=${p.value} ${p.mode}/${p.scope}`)
  assert.deepEqual(rows, [
    '--color-primary=#14b8a6 default/daisy',
    '--color-primary=#2dd4bf dark/daisy',
    '--font-sans="Geist", sans-serif default/theme',
    '--a=1px default/root',
    '--b=var(--a) default/root',
    '--a=2px dark/root',
    '--a=3px corp/selector',
    '--a=4px dark/selector',
    '--local=1px default/local',
  ])
})

test('parseCustomProperties: each member of a selector list, scopes that reach into the page, and conditions', () => {
  const css = `
:root,
.tone-paper { --a: 1; }
html.dark,
.tone-ink { --a: 2; }
html.dark .tone-block { --a: 3; }
:root, .tone-paper, .tone-ink, .tone-block, .tone-quote { --lift: 4; }
@media (max-width: 60rem) { :root { --gap: 5; } }
@supports (color: oklch(0 0 0)) { :root { --a: 6; } }
@layer base { .dark { --a: 7; } }
.dark .card { --a: 8; }
:is(.a, .b) { --a: 9; }
[data-theme = "dark"] { --a: 10; }
@media screen and (prefers-color-scheme: dark) { :root { --a: 11; } }
`
  const rows = parseCustomProperties(css).map((p) => `${p.value} ${p.mode}/${p.scope}${p.condition ? ` ${p.condition}` : ''}`)
  assert.deepEqual(rows, [
    '1 default/root',
    '2 dark/selector',
    '3 default/local',
    '4 default/root',
    '5 default/conditional @media (max-width: 60rem)',
    '6 default/conditional @supports (color: oklch(0 0 0))',
    '7 dark/selector',
    '8 default/local',
    '9 default/local',
    '10 dark/selector',
    '11 dark/root',
  ])
})
