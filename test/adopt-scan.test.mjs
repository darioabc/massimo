// adopt.mjs scan on a repo with its own design-system setup: a gated story
// lane with a manifest, header keys massimo does not know, a generator and
// the docs, ratchet and token list it writes, a DESIGN.md, and the files
// that depend on each. Read-only: before init it prints, after init it
// writes only its own inventory.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { walk } from '../scripts/lib/glob.mjs'
import { headerEntries, proposeRole, workflowText } from '../scripts/lib/inventory.mjs'
import { SCRIPTS, read, readJson, scratch } from './helpers.mjs'

const ctx = scratch('legacy')
after(() => ctx.cleanup())
const adopt = (root, args = []) => spawnSync(process.execPath, [join(SCRIPTS, 'adopt.mjs'), ...args, '--root', root], { encoding: 'utf8' })
const fingerprint = (root) => walk(root).map((f) => `${f} ${createHash('sha1').update(readFileSync(join(root, f))).digest('hex')}`).join('\n')

const before = fingerprint(ctx.root)
const printed = adopt(ctx.root)
const json = adopt(ctx.root, ['--json'])
const inv = JSON.parse(json.stdout)
const asset = (id) => inv.assets.find((a) => a.id === id)
const consumer = (id, file, script) => asset(id).consumers.find((c) => c.file === file && (script === undefined || c.script === script))

test('before init it prints the inventory and writes nothing', () => {
  assert.equal(printed.status, 0, printed.stderr)
  assert.match(printed.stdout, /^# Adopt inventory\n/)
  assert.match(printed.stdout, /- Story lane: src\/stories, manifest src\/stories\/manifest\.ts with 2 entries, 2 pages, 1 frame, 3 states\./)
  assert.equal(json.status, 0, json.stderr)
  assert.equal(inv.format, 1)
  assert.equal(fingerprint(ctx.root), before)
  assert.ok(!existsSync(join(ctx.root, 'design-system')))
  assert.ok(!printed.stdout.includes(String.fromCharCode(0x2014)))
})

test('the lane: its gate, manifest, pages, frames, states, scripts, port and build folder', () => {
  const lane = inv.stories.lane
  assert.equal(lane.dir, 'src/stories')
  assert.equal(lane.integration, 'lab-integration.mjs')
  assert.deepEqual(lane.manifest, { path: 'src/stories/manifest.ts', list: 'stories', entries: 2, notReadable: [] })
  assert.equal(lane.pages, 'src/stories/pages/{slug}/index.astro')
  assert.equal(lane.frames, 'src/stories/pages/{slug}/frame.astro')
  assert.deepEqual([lane.states, lane.statesNotReadable], [3, 1])
  assert.deepEqual(lane.scripts, ['stories:build', 'stories:dev'])
  assert.deepEqual([lane.port, lane.route, lane.outDir], [4400, '/stories', 'dist-lab'])
})

test('the header census counts files per key, knows the built-in ones and proposes a role for the rest', () => {
  const key = (k) => inv.headers.keys.find((x) => x.key === k)
  assert.deepEqual(inv.headers.keys.map((k) => [k.key, k.files]), [
    ['group', 7], ['theme', 3], ['inputs', 2], ['styles', 2], ['breakpoint', 1], ['owner', 1], ['use-when', 1],
    ['parents', 0], ['children', 0], ['never', 0], ['no-story', 0],
  ])
  assert.equal(inv.headers.files, 7)
  assert.equal(key('group').builtin, true)
  assert.deepEqual(key('theme').proposed, { role: 'scope', values: ['kiosk', 'print'] })
  assert.equal(key('inputs').proposed, 'definitions')
  assert.deepEqual(key('styles').proposed, { role: 'list', under: 'src/styles' })
  assert.equal(key('breakpoint').proposed, 'breakpoint')
  assert.equal(key('owner').proposed, null)
  // The generator documents the grammar in a comment and a string; neither is a header.
  assert.ok(!key('group').examples.includes('scripts/build-system.mjs'))
})

test('groups give the proposed taxonomy, tiers in massimo order then as they appear; pages and layouts give node kinds', () => {
  assert.deepEqual(inv.headers.taxonomy.tiers, ['Foundations', 'Primitives', 'Shells', 'Pages', 'Components'])
  assert.deepEqual(inv.headers.taxonomy.groups, ['Foundations / Icons', 'Primitives / Status', 'Primitives / Actions', 'Shells / Site', 'Pages / Home', 'Components / Cards'])
  assert.deepEqual(inv.headers.kinds, { layout: ['src/layouts/**/*.astro'], page: ['src/pages/**/*.astro'] })
})

test("the repo's own files: generated docs, ratchet, token list, notes, DESIGN.md and the script that writes them", () => {
  assert.deepEqual(inv.own.docs.map((d) => [d.path, d.kind, d.generated, d.writer]), [
    ['docs/system/graph.md', 'graph', true, 'scripts/build-system.mjs'],
    ['docs/system/index.md', 'index', true, 'scripts/build-system.mjs'],
    ['docs/system/notes.md', 'notes', false, null],
    ['docs/system/tokens.md', 'tokens', true, 'scripts/build-system.mjs'],
  ])
  assert.equal(inv.own.docs[0].nodes, 4)
  const [ratchet] = inv.own.ratchets
  assert.equal(ratchet.path, 'docs/system/ratchet.json')
  assert.equal(ratchet.map, 'raw-colour=color,undefined-var=undefined-var')
  assert.deepEqual(ratchet.unmapped, ['logo-colour'])
  assert.deepEqual(inv.own.tokenFiles.map((t) => [t.path, t.tokens]), [['docs/system/tokens.json', 3]])
  assert.deepEqual(inv.own.generators, [{ path: 'scripts/build-system.mjs', scripts: ['system', 'system:check'], writes: ['docs/system/graph.md', 'docs/system/index.md', 'docs/system/ratchet.json', 'docs/system/tokens.json', 'docs/system/tokens.md'] }])
  assert.deepEqual(inv.own.designMd, [{ path: 'DESIGN.md', version: 'alpha', name: 'Weekly box', tokens: { colors: 2, rounded: 1, spacing: 2 }, components: 2, rules: 2, problems: [] }])
  assert.deepEqual(inv.own.styleFiles, ['src/styles/theme.css'])
})

test('consumers: imports, reads by path, type checks, workflows, tooling and docs, each with its class', () => {
  assert.deepEqual(consumer('gate:lab-integration.mjs', 'astro.config.mjs'), { file: 'astro.config.mjs', line: 1, class: 'deploy', how: 'imports' })
  assert.equal(consumer('manifest:src/stories/manifest.ts', 'lab-integration.mjs').how, 'imports')
  assert.deepEqual(consumer('lane:src/stories', 'package.json', 'build'), { file: 'package.json', script: 'build', line: null, class: 'deploy', how: 'type-checks' })
  assert.deepEqual(consumer('lane:src/stories', '.github/workflows/deploy.yml'), { file: '.github/workflows/deploy.yml', line: 13, class: 'ci', how: 'runs', via: 'build' })
  assert.equal(consumer('lane:src/stories', 'tailwind.config.mjs').class, 'deploy')
  assert.equal(consumer('lane:src/stories', 'src/content/config.ts').line, 5)
  assert.equal(consumer('lane:src/stories', 'tsconfig.json').class, 'deploy')
  assert.deepEqual(consumer('lane:src/stories', 'scripts/shoot-lab.mjs'), { file: 'scripts/shoot-lab.mjs', line: 2, class: 'hand-run', how: 'names', runBy: ['lab:shots'] })
  assert.equal(consumer('lane:src/stories', 'scripts/publish-lab.mjs').class, 'hand-run')
  assert.equal(consumer('lane:src/stories', 'package.json', 'stories:publish').class, 'hand-run')
  assert.equal(consumer('lane:src/stories', '.claude/launch.json').class, 'hand-run')
  assert.equal(consumer('lane:src/stories', 'docs/guide.md').class, 'docs')
  assert.equal(consumer('doc:docs/system/index.md', 'src/stories/index.astro').class, 'deploy')
  assert.equal(consumer('tokens:docs/system/tokens.json', 'src/stories/foundations.ts').how, 'imports')
  assert.deepEqual(consumer('styles:src/styles/theme.css', 'scripts/make-cards.mjs'), { file: 'scripts/make-cards.mjs', line: 6, class: 'hand-run', how: 'names', runBy: ['cards'] })
  assert.equal(consumer('styles:src/styles/theme.css', 'src/styles/global.css').how, 'imports')
  assert.deepEqual(consumer('generator:scripts/build-system.mjs', '.github/workflows/check.yml'), { file: '.github/workflows/check.yml', line: 12, class: 'ci', how: 'runs', via: 'system:check' })
  // A script a workflow runs is ci, not hand-run.
  assert.equal(consumer('manifest:src/stories/manifest.ts', 'scripts/build-system.mjs').class, 'ci')
  assert.equal(consumer('notes:docs/system/notes.md', 'docs/guide.md').how, 'links')
  assert.deepEqual(consumer('notes:docs/system/notes.md', 'tailwind.config.mjs'), { file: 'tailwind.config.mjs', line: 1, class: 'docs', how: 'comment' })
})

test('what a consumer is not: the lane inside itself, the writer of its own output, a nested app and a comment in a workflow', () => {
  assert.equal(consumer('manifest:src/stories/manifest.ts', 'src/stories/index.astro'), undefined)
  assert.equal(consumer('doc:docs/system/graph.md', 'scripts/build-system.mjs'), undefined)
  assert.equal(consumer('ratchet:docs/system/ratchet.json', '.github/workflows/check.yml'), undefined)
  for (const a of inv.assets) assert.equal(a.consumers.find((c) => c.file === '.github/workflows/other.yml'), undefined, a.id)
})

test('after init it writes its inventory, the same bytes every run, and nothing else', () => {
  const project = join(ctx.root, 'ds')
  writeFileSync(join(ctx.root, 'massimo.config.json'), JSON.stringify({ projectDir: 'ds', components: { include: ['src/components/**/*.{astro,tsx}'] }, tokens: { styleFiles: ['src/styles/theme.css'] } }))
  const repoBefore = fingerprint(ctx.root)
  const r = adopt(ctx.root, ['scan'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /wrote ds\/adopt\/inventory\.json and inventory\.md/)
  const first = read(project, 'adopt', 'inventory.json')
  const md = read(project, 'adopt', 'inventory.md')
  assert.match(md, /Regenerate: node ds\/scripts\/adopt\.mjs scan/)
  assert.equal(adopt(ctx.root, ['scan']).status, 0)
  assert.equal(read(project, 'adopt', 'inventory.json'), first)
  assert.equal(readJson(project, 'adopt', 'inventory.json').format, 1)
  rmSync(project, { recursive: true })
  assert.equal(fingerprint(ctx.root), repoBefore)
  rmSync(join(ctx.root, 'massimo.config.json'))
})

test('a role from the shape of the values, or none', () => {
  assert.equal(proposeRole(['--a, --b', '--c']), 'definitions')
  assert.equal(proposeRole(['20rem the bar folds', '40em two columns']), 'breakpoint')
  assert.deepEqual(proposeRole(['a.css', 'b.css'], { files: ['x/a.css', 'x/b.css', 'y/a.css'] }), { role: 'list', under: 'x' })
  assert.equal(proposeRole(['a.css'], { files: ['x/a.css', 'y/a.css'] }), 'list')
  assert.deepEqual(proposeRole(['one', 'two', 'one']), { role: 'scope', values: ['one', 'two'] })
  assert.equal(proposeRole(['one', 'two']), null)
  assert.equal(proposeRole(['one', 'one'], { oncePerFile: false }), null)
  assert.equal(proposeRole(['a team', 'another team']), null)
})

test('a header line opens its comment; an example inside another comment or a string is not one', () => {
  const source = ['/**', ' * ds:group Primitives / Actions', ' *   // ds:group <Tier> / <Group>', ' */', "const s = '// ds:theme print'", '// ds:theme kiosk', '<!-- ds:use-when a reader acts -->'].join('\n')
  assert.deepEqual(headerEntries(source).map((e) => [e.key, e.value]), [['group', 'Primitives / Actions'], ['theme', 'kiosk'], ['use-when', 'a reader acts']])
})

test('a workflow step or job run in another folder is blanked, and so are comments, lines kept', () => {
  const text = ['# npm run comment', 'jobs:', '  a:', '    defaults:', '      run:', '        working-directory: app', '    steps:', '      - run: npm run one', '  b:', '    steps:', '      - run: npm run two', '      - working-directory: ./', '        run: npm run three', '      - name: elsewhere', '        working-directory: app', '        run: npm run four'].join('\n')
  const out = workflowText(text)
  assert.equal(out.split('\n').length, text.split('\n').length)
  assert.deepEqual([...out.matchAll(/npm run (\w+)/g)].map((m) => m[1]), ['two', 'three'])
})

test('story tools: CSF files read statically, and what is not readable is listed', () => {
  const root = mkdtempSync(join(tmpdir(), 'massimo-adopt-'))
  try {
    const files = {
      'package.json': JSON.stringify({ devDependencies: { '@ladle/react': '4', react: '18', vite: '5' }, scripts: { ladle: 'ladle serve --port 61000', 'ladle:build': 'ladle build' } }),
      '.ladle/config.mjs': 'export default {}\n',
      'src/Button.tsx': 'export const Button = () => null\n',
      'src/Button.stories.tsx': "import { Button } from './Button'\nexport default { title: 'Primitives / Button' }\nexport const Solid = () => <Button />\nSolid.storyName = 'Solid fill'\nexport const Sized = () => <Button />\nSized.args = { size: 2 }\n",
      'src/Old.stories.tsx': "storiesOf('Old', module).add('a', () => null)\n",
      'src/Notes.stories.mdx': '# Notes\n',
    }
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(root, f, '..'), { recursive: true })
      writeFileSync(join(root, f), body)
    }
    const r = adopt(root, ['--json'])
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.deepEqual(out.stories.tools, [{ tool: 'ladle', config: ['.ladle/config.mjs'], scripts: ['ladle', 'ladle:build'], port: 61000, files: 3, stories: 2, withArgs: 1, notReadable: 2 }])
    const button = out.stories.files.find((f) => f.file === 'src/Button.stories.tsx')
    assert.deepEqual([button.title, button.stories, button.args], ['Primitives / Button', ['Solid fill', 'Sized'], true])
    assert.match(out.stories.files.find((f) => f.file === 'src/Old.stories.tsx').unreadable[0], /storiesOf/)
    assert.deepEqual(out.stories.files.find((f) => f.file === 'src/Notes.stories.mdx').unreadable, ['this kind of story file is not statically readable'])
    assert.deepEqual(out.assets.find((a) => a.id === 'tool:ladle').paths, ['.ladle/'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
