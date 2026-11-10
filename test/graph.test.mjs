import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { read, readJson, run, scratch } from './helpers.mjs'

const ctx = scratch()
after(() => ctx.cleanup())

test('graph writes graph.md and graph.json and prints one summary line', () => {
  const r = run('graph', ctx)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^massimo graph: wrote .*graph\.md and graph\.json \(11 components, 3 with a story, 1 unresolved imports\)\n$/)
  assert.ok(existsSync(join(ctx.project, 'graph.md')) && existsSync(join(ctx.project, 'graph.json')))
})

const graph = () => readJson(ctx.project, 'graph.json')
const node = (name) => graph().nodes.find((n) => n.name === name)

test('nodes: names, duplicates disambiguated, index files named for their directory', () => {
  const names = graph().nodes.map((n) => n.name)
  assert.deepEqual(names, ['Badge', 'Card', 'Chip', 'components/Button', 'forms/Button', 'Hero', 'Icon', 'Other', 'Panel', 'Toolbar', 'Tooltip'])
  assert.ok(!names.includes('Card.test') && !names.includes('Dashboard'))
})

test('edges: aliases, relative paths, SFCs, barrels; type-only imports, stories and tests do not count', () => {
  assert.deepEqual(node('Card').composes, ['components/Button', 'Panel'])
  assert.deepEqual(node('Card').composedBy, { app: ['src/app/page.tsx'], routes: ['src/routes/home.tsx'] })
  assert.equal(node('Card').usage, 2) // Button.tsx only imports Card's type; Card.test.tsx is a test
  assert.deepEqual(node('components/Button').composedBy, { components: ['src/components/Card.tsx', 'src/components/Hero.astro'] })
  assert.deepEqual(node('Icon').composedBy, { components: ['src/components/Badge.vue', 'src/components/Button.tsx'] })
  assert.equal(node('Icon').usage, 2) // routes/home.tsx imports only a type from Icon
  assert.deepEqual(node('Hero').composes, ['Chip', 'components/Button'])
  assert.deepEqual(node('Chip').composes, ['Badge'])
  assert.deepEqual(node('forms/Button').composedBy, { routes: ['src/routes/home.tsx'] })
})

test('barrel files credit only the names an importer asks for', () => {
  assert.equal(node('Tooltip').usage, 1)
  assert.deepEqual(node('Tooltip').composedBy, { components: ['src/components/Toolbar.tsx'] })
  assert.equal(node('Other').usage, 0)
})

test('packages are deduped bare names; nodes also list exports', () => {
  assert.deepEqual(node('components/Button').packages, ['@radix-ui/react-slot'])
  assert.deepEqual(node('Card').exports, ['Card', 'Theme'])
  assert.deepEqual(node('Badge').exports, ['Badge'])
})

test('stories: shared stem, a story file importing the node, and the stories glob', () => {
  assert.deepEqual(node('components/Button').stories, ['src/components/Button.stories.tsx'])
  assert.deepEqual(node('Card').stories, ['src/components/Card.stories.tsx']) // stem only: the story imports nothing
  assert.deepEqual(node('Toolbar').stories, ['src/stories/Dashboard.tsx']) // matched by config.stories.include
  assert.deepEqual(node('Icon').stories, [])
})

test('style usage: class-library roots, theme colour tokens, var() reads', () => {
  assert.deepEqual(node('components/Button').style, { classes: { daisyui: ['btn'] }, tokens: ['base-content', 'primary'], cssVars: ['--radius-field'] })
  assert.deepEqual(node('Card').style, { classes: { daisyui: ['card'] }, tokens: ['base-100', 'base-300'], cssVars: ['--shadow-card'] })
  assert.deepEqual(node('Badge').style.classes.daisyui, ['badge'])
  assert.deepEqual(node('Toolbar').style.classes.daisyui, ['menu'])
})

test('ds: rules, wrapped values, group, no-story and ticket ids', () => {
  const button = node('components/Button')
  assert.deepEqual(button.rules, {
    never: 'nested inside another Button',
    'use-when': 'a user presses something to run an action; wrap it for links via asChild',
  })
  assert.equal(button.group, 'Primitives / Actions')
  assert.equal(button.tier, 'Primitives')
  assert.deepEqual(button.decisions, ['PROJ-3', 'PROJ-12']) // natural order, not PROJ-12 first
  assert.deepEqual(node('Card').decisions, ['PROJ-2', 'PROJ-10'])
  const hero = node('Hero')
  assert.equal(hero.noStory, 'Only rendered inside the marketing page')
  assert.deepEqual(hero.rules, { never: 'inside a Card' })
  assert.deepEqual(graph().faults, [{ file: 'src/components/Hero.astro', key: 'ds:bogus' }])
})

test('story queue skips stories and ds:no-story; most used first', () => {
  assert.deepEqual(
    graph().storyQueue.map((q) => q.name),
    ['Icon', 'Badge', 'Chip', 'forms/Button', 'Panel', 'Tooltip', 'Other'],
  )
  assert.deepEqual(graph().summary, { components: 11, withStory: 3, withoutStory: 7, noStory: 1, tokens: 11, nodesWithRules: 2, unresolvedImports: 1, headerFaults: 1 })
})

test('tokens section and unresolved imports', () => {
  const g = graph()
  assert.deepEqual(g.tokens.groups.color, ['--color-base-100', '--color-base-content', '--color-brand', '--color-primary'])
  assert.deepEqual(g.tokens.dtcg, { path: 'design-system/tokens/tokens.json', count: 11 })
  assert.deepEqual(g.unresolved, { '@/components/Missing': ['src/routes/home.tsx'] })
})

test('graph.md: generated note, Index by tier, header faults, node shape', () => {
  const md = read(ctx.project, 'graph.md')
  // The command names the project folder as configured (here the test's --project-dir, beside the repo).
  assert.ok(md.startsWith('# Design-system graph\n\n<!-- Generated by massimo graph. Do not edit by hand. Regenerate: node ../project/scripts/graph.mjs -->\n'))
  const order = ['**Primitives / Actions**', '**Pages / Marketing**', '**Ungrouped**'].map((s) => md.indexOf(s))
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2])
  assert.match(md, /^- components\/Button: story ✓ · used by 2$/m)
  assert.match(md, /^- Hero: no-story · used by 0$/m)
  assert.match(md, /^- Icon: story ✗ · used by 2$/m)
  assert.match(md, /^## Header faults\n[\s\S]*`src\/components\/Hero.astro` · `ds:bogus`/m)
  assert.match(md, /^- file `src\/components\/Hero.astro` · no story on purpose: Only rendered inside the marketing page · exports Hero$/m)
  assert.match(md, /^- used by 2 files · composes: components\/Button, Panel$/m)
  assert.match(md, /^- composed by: app \(1\): src\/app\/page.tsx · routes \(1\): src\/routes\/home.tsx$/m)
  assert.match(md, /^- composed by: none$/m)
  assert.match(md, /^- decisions: PROJ-3, PROJ-12$/m)
  assert.ok(md.indexOf('### Badge') < md.indexOf('### Card') && md.indexOf('### Card') < md.indexOf('### Chip'))
  assert.ok(!md.includes('Components without a story and not marked `ds:no-story`, most used first (8'))
})

test('--check: byte comparison, never writes', () => {
  assert.equal(run('graph', ctx, ['--check']).status, 0)
  const before = readFileSync(join(ctx.project, 'graph.md'), 'utf8')
  writeFileSync(join(ctx.project, 'graph.md'), `${before}\nedited`)
  const stale = run('graph', ctx, ['--check'])
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /graph\.md \(stale\)/)
  assert.equal(readFileSync(join(ctx.project, 'graph.md'), 'utf8'), `${before}\nedited`)
  writeFileSync(join(ctx.project, 'graph.md'), before)
  // a change in the source makes it stale too
  const file = join(ctx.root, 'src', 'components', 'Icon.tsx')
  writeFileSync(file, `${readFileSync(file, 'utf8')}export const extra = 1\n`)
  assert.equal(run('graph', ctx, ['--check']).status, 1)
  assert.equal(run('graph', ctx).status, 0)
  assert.equal(run('graph', ctx, ['--check']).status, 0)
})

test('a component an Astro config wires in by a quoted relative path is used by that config', () => {
  const t = scratch()
  try {
    writeFileSync(join(t.root, 'astro.config.mjs'), [
      "import docs from '@acme/docs'",
      'export default {',
      '  integrations: [docs({',
      "    customCss: ['./src/styles/theme.css'],",
      '    components: {',
      "      // Icon: './src/components/Icon.tsx',",
      "      Hero: './src/components/Hero.astro',",
      '    },',
      '  })],',
      "  vite: { alias: { other: 'src/components/ui/Other.tsx' } },",
      '}',
      '',
    ].join('\n'))
    assert.equal(run('graph', t).status, 0)
    const nodes = readJson(t.project, 'graph.json').nodes
    const hero = nodes.find((n) => n.name === 'Hero')
    assert.equal(hero.usage, 1)
    assert.deepEqual(hero.composedBy, { root: ['astro.config.mjs'] })
    // A commented-out path and a path that is not relative wire nothing in.
    assert.equal(nodes.find((n) => n.name === 'Icon').usage, 2)
    assert.equal(nodes.find((n) => n.name === 'Other').usage, 0)
    assert.match(read(t.project, 'graph.md'), /^- Hero: no-story · used by 1$/m)
    // A config in a nested app wires in a path relative to its own folder.
    mkdirSync(join(t.root, 'src', 'site'))
    writeFileSync(join(t.root, 'src', 'site', 'astro.config.ts'), "export default { components: { Other: '../components/ui/Other.tsx' } }\n")
    assert.equal(run('graph', t).status, 0)
    const other = readJson(t.project, 'graph.json').nodes.find((n) => n.name === 'Other')
    assert.equal(other.usage, 1)
    assert.deepEqual(Object.values(other.composedBy).flat(), ['src/site/astro.config.ts'])
  } finally {
    t.cleanup()
  }
})

test('--check names missing files', () => {
  const other = scratch()
  try {
    const r = run('graph', other, ['--check'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /graph\.md \(missing\), .*graph\.json \(missing\)/)
  } finally {
    other.cleanup()
  }
})

test('output is deterministic across checkouts in different directories', () => {
  const one = scratch()
  const two = scratch()
  try {
    run('graph', one)
    run('graph', two)
    assert.equal(read(one.project, 'graph.md'), read(two.project, 'graph.md'))
    assert.equal(read(one.project, 'graph.json'), read(two.project, 'graph.json'))
  } finally {
    one.cleanup()
    two.cleanup()
  }
})
