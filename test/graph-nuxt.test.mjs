// A Nuxt app: the aliases Nuxt resolves itself and the components it
// registers for templates to use without an import are edges of the graph,
// as an import is. A project that is not a Nuxt app reads as before.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { walk } from '../scripts/lib/glob.mjs'
import { createResolver } from '../scripts/lib/source.mjs'
import { FIXTURES, SCRIPTS, read, readJson, run, scratch } from './helpers.mjs'

const GOLDEN = join(FIXTURES, '..', 'golden')
// Loaded in the tests that read it, so each test stands on its own.
const nuxtLib = () => import('../scripts/lib/nuxt.mjs')

// The graph of a scratch copy of `fixture`, its config patched by `patch`.
function graphOf(fixture, patch = null) {
  const t = scratch(fixture)
  try {
    if (patch) {
      const path = join(t.root, 'massimo.config.json')
      writeFileSync(path, JSON.stringify(patch(JSON.parse(readFileSync(path, 'utf8')))))
    }
    const r = run('graph', t)
    assert.equal(r.status, 0, r.stderr)
    const json = readJson(t.project, 'graph.json')
    return { json, stderr: r.stderr, md: read(t.project, 'graph.md'), node: (name) => json.nodes.find((n) => n.name === name) }
  } finally {
    t.cleanup()
  }
}

const usedBy = (n) => Object.values(n.composedBy).flat().sort()

test('a Nuxt app: a template tag naming a registered component is a use of it, in PascalCase, kebab case or Lazy', () => {
  const g = graphOf('nuxt-layers')
  // <base-card> in a component, <BaseCard> in a layer's component, resolveComponent('BaseCard') on a page.
  assert.deepEqual(usedBy(g.node('Card')), ['app/components/AppHeader.vue', 'app/pages/about.vue', 'layers/base/app/components/Note.vue'])
  assert.equal(g.node('Card').usage, 3)
  assert.deepEqual(g.node('AppHeader').composes, ['BaseBadge', 'Button', 'Card'])
  // <LazyWidgetChart>: a folder with a prefix and no path prefix.
  assert.deepEqual(usedBy(g.node('Chart')), ['app/pages/index.vue'])
  // <Panel> renders Panel.client.vue.
  assert.deepEqual(usedBy(g.node('Panel.client')), ['app/pages/index.vue'])
  assert.equal(g.node('Unused').usage, 0)
})

test('a file that imports a component and uses its tag counts once; a tag its script binds to another module is no use', () => {
  const g = graphOf('nuxt-layers')
  assert.deepEqual(usedBy(g.node('BaseBadge')), ['app/components/AppHeader.vue'])
  assert.equal(g.node('BaseBadge').usage, 1)
  // Toolbar imports Button and renders <Button>; Wrapper's <Button> is some-lib's.
  assert.deepEqual(usedBy(g.node('Button')), ['app/components/AppHeader.vue', 'app/components/Toolbar.vue'])
  assert.equal(g.node('Button').usage, 2)
  assert.deepEqual(g.node('Wrapper').composes, [])
  assert.deepEqual(g.node('Wrapper').packages, ['some-lib'])
})

test('a module\'s components: shadcn-nuxt\'s componentDir registers each name its folders\' index files export', async () => {
  const { nuxtApp } = await nuxtLib()
  const root = join(FIXTURES, 'nuxt-layers')
  const config = JSON.parse(read(root, 'massimo.config.json'))
  const app = nuxtApp(root, config, walk(root, { ignore: ['node_modules', '.nuxt'] }), [])
  // shadcn.prefix is "", so <Button> is the Button its index exports; Nuxt's own scan leaves the folder alone.
  assert.deepEqual(app.components.get('Button').map((c) => [c.file, c.export]), [['app/components/ui/button/index.ts', 'Button']])
  assert.equal(app.components.get('UiButton'), undefined)
  assert.equal(app.components.get('ButtonVariants'), undefined)
  // <Button> reaches Button.vue through that index.
  assert.ok(usedBy(graphOf('nuxt-layers').node('Button')).includes('app/components/AppHeader.vue'))
})

test('Nuxt\'s aliases resolve: ~ and @ to the source folder, #shared, the alias option, #layers, and ~ inside a layer to that layer', () => {
  const g = graphOf('nuxt-layers')
  assert.deepEqual(g.node('Toolbar').composes, ['Button'])
  assert.deepEqual(usedBy(g.node('Note')), ['app/pages/about.vue'])
  // Only the alias that points at nothing is unresolved; #imports is Nuxt's own.
  assert.deepEqual(g.json.unresolved, { '@/missing/thing': ['app/components/Toolbar.vue'] })
  for (const n of g.json.nodes) assert.ok(!n.packages.some((p) => p === '~' || p.startsWith('@/') || p.startsWith('#')), `${n.name}: ${n.packages}`)
  assert.deepEqual(g.node('Toolbar').packages, [])
})

test('layers: the theme extends names and layers/ folders with a nuxt.config register; a remote layer is a warning', () => {
  const g = graphOf('nuxt-layers')
  assert.deepEqual(usedBy(g.node('ThemeCard')), ['app/pages/index.vue'])
  assert.deepEqual(usedBy(g.node('Card')).filter((f) => f.startsWith('layers/')), ['layers/base/app/components/Note.vue'])
  // layers/notes holds no nuxt.config, so its Ghost is not registered.
  assert.equal(g.node('Ghost').usage, 0)
  assert.match(g.stderr, /nuxt\.config\.ts extends "github:acme\/remote-layer", a layer outside the repo, so the graph does not read its components or aliases/)
})

test('graph.edges "!nuxt" turns the auto-import edges off and keeps the aliases; a config that lists the other kinds keeps them on', () => {
  const off = graphOf('nuxt-layers', (c) => ({ ...c, graph: { edges: ['!nuxt'] } }))
  assert.deepEqual(usedBy(off.node('Button')), ['app/components/Toolbar.vue'])
  assert.equal(off.node('Card').usage, 0)
  assert.deepEqual(off.json.unresolved, { '@/missing/thing': ['app/components/Toolbar.vue'] })
  assert.doesNotMatch(off.stderr, /graph\.edges lists/)
  const on = graphOf('nuxt-layers', (c) => ({ ...c, graph: { edges: ['mdx', 'glob', 'nuxt'] } }))
  assert.equal(on.node('Card').usage, 3)
  assert.doesNotMatch(on.stderr, /graph\.edges lists/)
})

test('a Nuxt 3 layout: the source folder is the root, components/ sits there, and components/global adds no prefix', () => {
  const g = graphOf('nuxt3-app')
  assert.deepEqual(usedBy(g.node('TheHeader')), ['pages/index.vue'])
  // <form-input> on the page, and ~/components/... imported in TheHeader.
  assert.deepEqual(usedBy(g.node('FormInput')), ['components/TheHeader.vue', 'pages/index.vue'])
  assert.deepEqual(usedBy(g.node('SiteIcon')), ['pages/index.vue'])
  assert.deepEqual(g.json.unresolved, {})
})

test('a project that is not a Nuxt app gets the graph it got before; "nuxt" in its graph.edges is a warning', () => {
  const g = graphOf('app', (c) => ({ ...c, graph: { edges: ['nuxt'] } }))
  assert.equal(`${JSON.stringify(g.json, null, 2)}\n`, read(GOLDEN, 'graph-app', 'graph.json'))
  assert.match(g.stderr, /graph\.edges lists "nuxt", but this is not a Nuxt app/)
})

test('an import that starts with @/ or ~/ and resolves to nothing is unresolved, never a package', () => {
  const root = mkdtempSync(join(tmpdir(), 'massimo-nuxt-'))
  try {
    writeFileSync(join(root, 'package.json'), '{ "dependencies": { "@scope/pkg": "1" } }')
    const resolve = createResolver(root, {})
    assert.deepEqual(resolve('src/x.ts', '@/lib/utils'), { unresolved: '@/lib/utils' })
    assert.deepEqual(resolve('src/x.ts', '~/components/Card.vue'), { unresolved: '~/components/Card.vue' })
    assert.deepEqual(resolve('src/x.ts', '@scope/pkg/deep'), { pkg: '@scope/pkg' })
    assert.deepEqual(resolve('src/x.ts', '#imports'), { external: '#imports' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('component names follow Nuxt: folder prefixes, a file name repeating its folders, index files, modes and pathPrefix', async () => {
  const { componentNameIn } = await nuxtLib()
  const dir = { path: 'components' }
  const name = (rel, d = dir) => componentNameIn(d, rel).pascalName
  assert.equal(name('base/foo/Button.vue'), 'BaseFooButton')
  assert.equal(name('base/BaseButton.vue'), 'BaseButton')
  assert.equal(name('form/input/FormInput.vue'), 'FormInput')
  assert.equal(name('Item/Item/Item.vue'), 'Item')
  assert.equal(name('ui/button/index.vue'), 'UiButton')
  assert.equal(name('(group)/Card.vue'), 'Card')
  assert.equal(name('my-widget.vue'), 'MyWidget')
  assert.equal(name('index.vue'), '')
  assert.deepEqual(componentNameIn(dir, 'Panel.client.vue'), { pascalName: 'Panel', kebabName: 'panel', mode: 'client' })
  assert.equal(componentNameIn(dir, 'Map.server.vue').mode, 'server')
  assert.equal(componentNameIn({ path: 'components/islands', island: true }, 'Feed.vue').mode, 'server')
  assert.equal(name('base/Button.vue', { path: 'components', pathPrefix: false }), 'Button')
  assert.equal(name('base/index.vue', { path: 'components', pathPrefix: false }), 'Base')
  assert.equal(name('stats/Chart.vue', { path: 'widgets', prefix: 'Widget', pathPrefix: false }), 'WidgetChart')
})

test('detect suggests every components folder a Nuxt app registers, each layer\'s included', () => {
  const t = scratch('nuxt-layers')
  try {
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'detect.mjs'), '--root', t.root], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout).suggestedConfig.components.include, [
      'app/components/**/*.vue',
      'app/widgets/**/*.vue',
      'layers/base/app/components/**/*.vue',
      'vendor/theme/components/**/*.vue',
    ])
  } finally {
    t.cleanup()
  }
})

test('detect suggests the folder a Nuxt 3 layout registers, not one Nuxt leaves alone', () => {
  const base = mkdtempSync(join(tmpdir(), 'massimo-nuxt-'))
  try {
    const files = {
      'package.json': '{ "dependencies": { "nuxt": "^3.12.0" } }',
      'nuxt.config.ts': 'export default defineNuxtConfig({})\n',
      'components/TheHeader.vue': '<template><header /></template>\n',
      'components/global/SiteIcon.vue': '<template><i /></template>\n',
      'docs/elements/Callout.vue': '<template><aside /></template>\n',
      'docs/elements/Note.vue': '<template><aside /></template>\n',
      'docs/elements/Tip.vue': '<template><aside /></template>\n',
      'pages/index.vue': '<template><TheHeader /></template>\n',
      'app/router.options.ts': 'export default {}\n',
    }
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(base, path)), { recursive: true })
      writeFileSync(join(base, path), text)
    }
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'detect.mjs'), '--root', base], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout).suggestedConfig.components.include, ['components/**/*.vue'])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
