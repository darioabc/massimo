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
import { planLedger } from '../scripts/lib/adopt.mjs'
import { walk } from '../scripts/lib/glob.mjs'
import { headerCensus, headerEntries, headerReaders, inventoryMarkdown, laneRecord, markupBlanked, proposeRole, workflowText } from '../scripts/lib/inventory.mjs'
import { laneRegistry } from '../scripts/lib/lane.mjs'
import { DEFAULTS, deepMerge } from '../scripts/lib/project.mjs'
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
  assert.deepEqual(lane.manifest, { path: 'src/stories/manifest.ts', list: 'stories', entries: 2, notReadable: [], entriesNotReadable: [] })
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
  // Its code holds a header parser, so it reads the headers.
  assert.deepEqual(inv.headers.readers, ['scripts/build-system.mjs'])
})

test('groups give the proposed taxonomy, tiers in the order the repo index lists them; pages and layouts give node kinds', () => {
  assert.deepEqual(inv.headers.taxonomy.tiers, ['Foundations', 'Primitives', 'Components', 'Shells', 'Pages'])
  assert.equal(inv.headers.tiersFrom, 'docs/system/index.md')
  assert.deepEqual(inv.headers.taxonomy.groups, ['Foundations / Icons', 'Primitives / Status', 'Primitives / Actions', 'Components / Cards', 'Shells / Site', 'Pages / Home'])
  assert.deepEqual(inv.headers.kinds, { layout: ['src/layouts/**/*.astro'], page: ['src/pages/**/*.astro'] })
  assert.match(printed.stdout, /Proposed tiers, in order \(as the headings of docs\/system\/index\.md list them\): Foundations, Primitives, Components, Shells, Pages\.\n\nScan proposes no path rules/)
})

test('without an index that lists them, tiers go in massimo order, then as they first appear', () => {
  const files = { 'a/One.astro': '// ds:group Components / Cards\n', 'a/Two.astro': '// ds:group Labs / Odd\n', 'a/Three.astro': '// ds:group Primitives / Actions\n', 'a/Four.astro': '// ds:group Foundations / Icons\n' }
  const census = (options) => headerCensus('/nowhere', Object.keys(files), {}, (f) => files[f], options)
  assert.deepEqual(census().taxonomy.tiers, ['Foundations', 'Primitives', 'Components', 'Labs'])
  assert.equal(census().tiersFrom, undefined)
  // Tiers the index lists come first, in its order; the rest follow as before.
  const listed = census({ tierOrder: ['Placement test', 'Labs', 'Components'], tierSource: 'docs/index.md' })
  assert.deepEqual(listed.taxonomy.tiers, ['Labs', 'Components', 'Foundations', 'Primitives'])
  assert.equal(listed.tiersFrom, 'docs/index.md')
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
  const outputs = ['docs/system/graph.md', 'docs/system/index.md', 'docs/system/ratchet.json', 'docs/system/tokens.json', 'docs/system/tokens.md']
  assert.deepEqual(inv.own.generators, [{ path: 'scripts/build-system.mjs', scripts: ['system', 'system:check'], writes: outputs, named: outputs }])
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

test('a component file reads in its code and only mentions in its markup', () => {
  // The frontmatter reads index.md at build time; the page text names a command.
  assert.deepEqual(consumer('doc:docs/system/index.md', 'src/stories/index.astro'), { file: 'src/stories/index.astro', line: 7, class: 'deploy', how: 'names' })
  assert.deepEqual(consumer('generator:scripts/build-system.mjs', 'src/stories/index.astro'), { file: 'src/stories/index.astro', line: 10, class: 'docs', how: 'mentions' })
  const astro = "---\nconst a = readFileSync('x/a.md')\n---\n<p>See x/b.md</p>\n<div>{import('x/c.md')}</div>\n<script>load('x/d.md')</script>\n"
  const kept = markupBlanked(astro, 'P.astro')
  assert.equal(kept.length, astro.length)
  assert.deepEqual(['x/a.md', 'x/b.md', 'x/c.md', 'x/d.md'].map((p) => kept.includes(p)), [true, false, true, true])
  const vue = '<template><a href="/docs/e.md">e</a></template>\n<script setup>\nimport f from "./f.md"\n</script>\n'
  assert.deepEqual(['e.md', 'f.md'].map((p) => markupBlanked(vue, 'V.vue').includes(p)), [false, true])
  assert.equal(markupBlanked(astro, 'p.ts'), astro)
})

test('a doc that names its writer is marked, so the ledger says to regenerate it', () => {
  assert.deepEqual(consumer('doc:docs/system/graph.md', 'docs/map.md'), { file: 'docs/map.md', line: 5, class: 'docs', how: 'mentions', writtenBy: 'scripts/make-map.mjs' })
  assert.equal(consumer('lane:src/stories', 'docs/guide.md').writtenBy, undefined)
  assert.match(printed.stdout, /\| docs\/map\.md:5 \| docs \| mentions \(written by scripts\/make-map\.mjs\) \|/)
})

test('what a consumer is not: the lane inside itself, the writer of its own output, a nested app and a comment in a workflow', () => {
  assert.equal(consumer('manifest:src/stories/manifest.ts', 'src/stories/index.astro'), undefined)
  assert.equal(consumer('doc:docs/system/graph.md', 'scripts/build-system.mjs'), undefined)
  assert.equal(consumer('ratchet:docs/system/ratchet.json', '.github/workflows/check.yml'), undefined)
  // A nested app's workflow: by a job's defaults, the workflow's defaults, or a cd.
  for (const w of ['other.yml', 'nested-defaults.yml', 'nested-cd.yml']) {
    for (const a of inv.assets) assert.equal(a.consumers.find((c) => c.file === `.github/workflows/${w}`), undefined, `${w} ${a.id}`)
  }
})

test('a config naming other style files keeps the ones scan found before it', () => {
  const t = scratch('legacy')
  try {
    writeFileSync(join(t.root, 'src', 'styles', 'card.css'), '.card { --card-gap: 8px; gap: var(--card-gap); }\n')
    writeFileSync(join(t.root, 'massimo.config.json'), JSON.stringify({ projectDir: 'ds', tokens: { styleFiles: ['src/styles/card.css'] } }))
    const r = adopt(t.root, ['scan'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(readJson(t.root, 'ds', 'adopt', 'inventory.json').own.styleFiles, ['src/styles/card.css', 'src/styles/theme.css'])
  } finally {
    t.cleanup()
  }
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

test("a workflow's own defaults and a cd into another folder count as that folder", () => {
  const runs = (lines) => [...workflowText(lines.join('\n')).matchAll(/npm run (\w+)/g)].map((m) => m[1])
  const defaults = ['on: push', 'defaults:', '  run:', '    working-directory: app', 'jobs:', '  a:', '    steps:', '      - run: npm run one', '  b:', '    defaults:', '      run:', '        working-directory: ./', '    steps:', '      - run: npm run two']
  assert.deepEqual(runs(defaults), ['two'])
  const cd = [
    'jobs:', '  a:', '    steps:',
    '      - run: npm run one && cd app && npm run two',
    '      - name: cd into nothing',
    '        run: npm run three',
    '      - run: |', '          npm run four', '          cd "app"', '          npm run five',
    '      - run: cd ./ && npm run six',
    '      - run: cd $GITHUB_WORKSPACE; npm run seven',
  ]
  assert.deepEqual(runs(cd), ['one', 'three', 'four', 'six', 'seven'])
})

test('a run script is followed through its cds: back at the root, what runs is the root again', () => {
  const runs = (lines) => [...workflowText(lines.join('\n')).matchAll(/npm run ([\w:]+)/g)].map((m) => m[1])
  const lines = [
    'jobs:', '  a:', '    steps:',
    '      - run: cd site && npm ci && npm run one && cd .. && npm run graph:check',
    '      - run: |', '          cd site', '          npm run two', '          cd -', '          npm run three',
    '      - run: cd app/sub && npm run four && cd ../.. && npm run five',
    '      - run: cd app; npm run six; cd "$GITHUB_WORKSPACE"; npm run seven',
    '      - run: cd app && npm run eight && cd ${{ github.workspace }} && npm run nine',
    '      - run: cd app && cd "${{ github.workspace }}/site" && npm run ten && cd .. && npm run eleven',
    '      - run: cd .. && npm run twelve',
    '      - run: cd /tmp/x && npm run thirteen && cd .. && npm run fourteen',
    '      - run: cd && npm run fifteen',
    '      - run: npm run sixteen',
  ]
  const out = workflowText(lines.join('\n'))
  assert.equal(out.split('\n').length, lines.length)
  assert.deepEqual(runs(lines), ['graph:check', 'three', 'five', 'seven', 'nine', 'eleven', 'sixteen'])
  // The root-level script keeps its column, so its line and place are where they were.
  assert.equal(out.split('\n')[3].indexOf('npm run graph:check'), lines[3].indexOf('npm run graph:check'))
})

test('a cd whose folder cannot be read keeps what follows; a subshell keeps its cd; pushd and popd move like cd and cd -', () => {
  const runs = (lines) => [...workflowText(['jobs:', '  a:', '    steps:', ...lines].join('\n')).matchAll(/npm run ([\w:]+)/g)].map((m) => m[1])
  // The folder cannot be read, so the step may run at the root.
  assert.deepEqual(runs(['      - run: cd "$(git rev-parse --show-toplevel)" && npm run graph:check']), ['graph:check'])
  assert.deepEqual(runs(['      - run: cd $(git rev-parse --show-toplevel) && npm run one']), ['one'])
  assert.deepEqual(runs(['      - run: cd `git rev-parse --show-toplevel` && npm run two']), ['two'])
  assert.deepEqual(runs(['      - run: cd "app && npm run three']), ['three'])
  // A package script named cd is not a cd.
  assert.deepEqual(runs(['      - run: npm run cd && npm run graph:check']), ['cd', 'graph:check'])
  // A bare cd, at the end of a line or before a separator, still leaves the root.
  assert.deepEqual(runs(['      - run: |', '          cd', '          npm run four', '      - run: cd; npm run five', '      - run: cd && npm run six']), [])
  // A subshell's cd ends with it.
  assert.deepEqual(runs(['      - run: (cd app && npm run seven) && npm run eight', '      - run: echo "$(pwd)" $(cd app && pwd) && npm run nine', '      - run: (cd) && npm run ten']), ['eight', 'nine', 'ten'])
  // pushd moves like cd, and popd goes back where the pushd left.
  assert.deepEqual(runs(['      - run: pushd app && npm run eleven && popd && npm run twelve', '      - run: |', '          pushd app', '          pushd sub', '          npm run thirteen', '          popd', '          npm run fourteen', '          popd', '          npm run fifteen']), ['twelve', 'fifteen'])
})

test('a header reader holds a header pattern in its code; a package script, a message or a comment is not one', () => {
  const files = {
    'lint-staged.config.mjs': "export default { '*.astro': () => 'npm run ds:check' }\n",
    'scripts/ci.mjs': "import { execSync } from 'node:child_process'\nexecSync('npm run ds:graph -- --check')\n",
    'scripts/map.mjs': "// Reads every ds:group line.\nthrow new Error(\"a component's ds: header is missing or malformed\")\n",
    'scripts/usage.mjs': 'console.log(`write a // ds:group <Tier> / <Group> line at the top`)\n',
    'scripts/parse.mjs': 'export const key = (line) => /ds:([a-z-]+)/.exec(line)\n',
    'scripts/grouped.mjs': "export const grouped = (text) => text.includes('ds:group')\n",
    'scripts/prefix.mjs': "export const isHeader = (line) => line.trimStart().startsWith('// ds:')\n",
    'scripts/owner.ts': "export const owned = (text) => text.includes('// ds:owner ')\n",
  }
  const readers = (config, keys) => headerReaders(Object.keys(files), (f) => files[f], config, keys)
  assert.deepEqual(readers(), ['scripts/grouped.mjs', 'scripts/parse.mjs', 'scripts/prefix.mjs'])
  // A key of the repo's own counts once its headers or its config use it.
  assert.deepEqual(readers({}, ['owner']), ['scripts/grouped.mjs', 'scripts/owner.ts', 'scripts/parse.mjs', 'scripts/prefix.mjs'])
  assert.deepEqual(readers({ graph: { extraKeys: ['owner'] } }), ['scripts/grouped.mjs', 'scripts/owner.ts', 'scripts/parse.mjs', 'scripts/prefix.mjs'])
})

test("the repo's own scripts that read ds: headers are found, and a key or a reader of its own makes the headers an asset", () => {
  const root = mkdtempSync(join(tmpdir(), 'massimo-adopt-headers-'))
  try {
    const files = {
      'package.json': JSON.stringify({ dependencies: { astro: '5' }, scripts: { 'check:headers': 'node tools/check-headers.mjs' } }),
      'src/components/Button.astro': '---\n// ds:group Primitives / Actions\n---\n<button />\n',
      'src/components/Card.astro': '---\n// ds:group Components / Cards\n// ds:use-when a reader scans a list\n---\n<div />\n',
      'src/lib/ids.ts': 'export const ids = { a: 1 }\n',
      'src/lib/note.ts': '// The ds: headers are read by the graph, not here.\nexport const x = 1\n',
    }
    const write = () => {
      for (const [f, body] of Object.entries(files)) {
        mkdirSync(join(root, f, '..'), { recursive: true })
        writeFileSync(join(root, f), body)
      }
    }
    write()
    const builtIn = JSON.parse(adopt(root, ['--json']).stdout)
    assert.deepEqual(builtIn.headers.readers, [])
    assert.equal(planLedger(builtIn).classes.graph, undefined)
    // A script that reads the headers is the repo's own setup.
    files['tools/check-headers.mjs'] = "import { readFileSync } from 'node:fs'\nconst KEY = /\\/\\/\\s*ds:([a-z-]+)\\s+(.*)/\nexport const read = (f) => KEY.exec(readFileSync(f, 'utf8'))\n"
    write()
    const withReader = JSON.parse(adopt(root, ['--json']).stdout)
    assert.deepEqual(withReader.headers.readers, ['tools/check-headers.mjs'])
    const headers = planLedger(withReader).classes.graph.assets.find((a) => a.id === 'headers')
    assert.deepEqual([headers.decision, headers.loss], ['keep', 'clean'])
    assert.equal(headers.lines[0], 'tools/check-headers.mjs reads the ds: headers as well. The headers stay in the source unchanged, so it keeps working.')
    assert.match(inventoryMarkdown(withReader, { command: 'x' }), /\nThe repo's own scripts that read the headers: tools\/check-headers\.mjs\.\n/)
    // A key of the repo's own, with no reader, is one too.
    delete files['tools/check-headers.mjs']
    rmSync(join(root, 'tools'), { recursive: true })
    files['src/components/Card.astro'] = '---\n// ds:group Components / Cards\n// ds:owner the cards team\n---\n<div />\n'
    write()
    const ownKey = JSON.parse(adopt(root, ['--json']).stdout)
    assert.deepEqual(ownKey.headers.readers, [])
    assert.ok(planLedger(ownKey).classes.graph.assets.some((a) => a.id === 'headers'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
    assert.deepEqual(out.stories.tools, [{ tool: 'ladle', config: ['.ladle/config.mjs'], scripts: ['ladle', 'ladle:build'], port: 61000, files: 3, stories: 2, withArgs: 1, notReadable: 2, settings: { stories: null, storyOrder: null, defaultStory: null, port: null, widths: null, outDir: null } }])
    const button = out.stories.files.find((f) => f.file === 'src/Button.stories.tsx')
    assert.deepEqual([button.title, button.stories, button.args], ['Primitives / Button', ['Solid fill', 'Sized'], true])
    assert.match(out.stories.files.find((f) => f.file === 'src/Old.stories.tsx').unreadable[0], /storiesOf/)
    assert.deepEqual(out.stories.files.find((f) => f.file === 'src/Notes.stories.mdx').unreadable, ['this kind of story file is not statically readable'])
    assert.deepEqual(out.assets.find((a) => a.id === 'tool:ladle').paths, ['.ladle/'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a csf lane counts its files and states through the registry', () => {
  const lane = { dir: 'src/stories', gate: 'package.json scripts', index: null, manifest: null, devScript: null, port: null }
  const sources = {
    'src/A.stories.tsx': "export default { title: 'Pages / A' }\nexport const One = () => null\nexport const Two = () => null\n",
    'src/B.stories.tsx': "export default { title: 'Pages / B' }\nexport const One = () => null\nOne.storyName = name\n",
  }
  const config = deepMerge(DEFAULTS, { stories: { lane: 'csf', ids: 'ladle' } })
  const registry = laneRegistry({ root: '.', config, files: Object.keys(sources), read: (f) => sources[f] })
  assert.equal(laneRecord('.', ['src/stories/index.ts'], {}, lane, () => '').states, 0)
  const record = laneRecord('.', ['src/stories/index.ts'], {}, lane, () => '', registry)
  assert.deepEqual([record.states, record.statesNotReadable, record.csf], [3, 1, { files: 2, states: 3 }])
})
