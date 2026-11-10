// scripts/lib/redirects.mjs: the story ids a repo mentions, whether each one
// resolves in the lane, and every edit the repo must make before the story
// tool can go, found on a copy of the csf-lane fixture with a tool's files,
// specs, docs and skills added to it.

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { retirePlan } from '../scripts/lib/adopt.mjs'
import { compileGlobs } from '../scripts/lib/glob.mjs'
import { readText, repoFiles } from '../scripts/lib/inventory.mjs'
import { recipeFiles } from '../scripts/lib/lane-css.mjs'
import { laneRegistry } from '../scripts/lib/lane.mjs'
import { loadConfig } from '../scripts/lib/project.mjs'
import { editsMarkdown, editsSummary, idMentions, mentionCoverage, openEdits, toolEdits, toolPackages, writeEditsFile } from '../scripts/lib/redirects.mjs'
import { scratch } from './helpers.mjs'

const ctx = scratch('csf-lane')
after(() => ctx.cleanup())
const put = (file, text) => {
  mkdirSync(dirname(join(ctx.root, file)), { recursive: true })
  writeFileSync(join(ctx.root, file), text)
}

put('package.json', JSON.stringify({
  name: 'fixture',
  scripts: { ladle: 'ladle serve --port 61300', 'ladle:build': 'ladle build', 'check:ladle-coverage': 'npm run ladle:build && node scripts/coverage.mjs', test: 'node --test' },
  devDependencies: { '@ladle/react': '^5.1.1' },
}, null, 2))
put('.ladle/config.mjs', "export default { stories: 'src/**/*.stories.tsx' }\n")
put('.ladle/ladle.css', '.x { color: red }\n')
put('e2e/button.spec.ts', [
  "const fixed = '/?story=primitives--actions--button--primary&mode=preview'",
  'const open = (name) => `/?story=patterns--gauge--editor--${name}&mode=preview`',
  "const gone = 'explorations--removed-page--default'",
  "const root = 'explorations--'",
  '',
].join('\n'))
put('docs/handoffs/old.md', 'The render lives at `explorations--retired-page--default`, a Ladle story.\n')
put('docs/guide.md', 'Run the stories with `npm run ladle`. They open at http://localhost:61300.\n')
put('src/Thing.tsx', ['// Mirrors the rules in .ladle/ladle.css so the story looks the same.', 'export const Thing = () => null', ''].join('\n'))
put('src/styles.test.ts', ["import { readFileSync } from 'node:fs'", "export const css = readFileSync('.ladle/ladle.css', 'utf8')", ''].join('\n'))
put('README.md', 'Ladle shows our components, and it stays out of the way.\n')
put('.github/workflows/ci.yml', 'jobs:\n  stories:\n    steps:\n      - run: npm run ladle:build\n')
put('.claude/skills/ship/SKILL.md', 'After a change run `npm run check:ladle-coverage` before you push.\n')

const { config } = loadConfig({ root: ctx.root })
const files = repoFiles(ctx.root, { ignore: config.ignore })
const registry = laneRegistry({ root: ctx.root, config, files: files.filter(compileGlobs(config.stories.include)), read: (f) => readText(ctx.root, f) })
const read = (f) => readText(ctx.root, f)
const tool = { tool: 'ladle', config: ['.ladle/config.mjs', '.ladle/ladle.css'], scripts: ['ladle', 'ladle:build'], port: 61300 }
const edits = toolEdits({ consumers: [], packages: ['@ladle/react'], registry, tool, historical: ['docs/handoffs/'], read, files })
const at = (file, line) => edits.find((e) => e.file === file && e.line === line)

test('an id is a run of kebab words joined by double hyphens, and a prefix ends in one or continues into a template', () => {
  const text = [
    "page.goto('/?story=primitives--actions--button--primary&mode=preview')",
    'const open = (n) => `patterns--gauge--editor--${n}`',
    'const some = `patterns--gauge--editor-${n}`',
    "const root = 'explorations--'",
    'prose: pages--review--summary--, then a lone stray--word',
    '',
  ].join('\n')
  assert.deepEqual(idMentions(text, registry), [
    { mention: 'primitives--actions--button--primary', line: 1, prefix: false },
    { mention: 'patterns--gauge--editor--', line: 2, prefix: true },
    { mention: 'patterns--gauge--editor-', line: 3, prefix: true },
    { mention: 'explorations--', line: 4, prefix: true },
    { mention: 'pages--review--summary--', line: 5, prefix: true },
  ])
  assert.deepEqual(idMentions('no double hyphen here', registry), [])
  assert.deepEqual(idMentions('', registry), [])
})

test('anchors, paths, file names, flags and a lone double hyphen are not ids', () => {
  const text = [
    '[a](#billing--where-to-look-when-money-stops-moving)',
    'see /id-preview--baca18d8-838e-439e-a84f-41bb4014b7e8',
    'open shots/state--dark-wide.png',
    'node run.mjs --max-diff 0 --sweep-baseline x.json',
    'a class card--compact and a word well--known',
    '',
  ].join('\n')
  assert.deepEqual(idMentions(text, registry), [])
  // a lone pair counts when the line talks about stories, or the registry has it
  assert.equal(idMentions('the story id sign--in-flow', registry).length, 1)
  assert.equal(idMentions('read welcome--x here', registry).length, 0)
  assert.equal(idMentions('foundations--welcome--start-here', registry).length, 1)
})

test('a mention resolves when an id has it or, for a prefix, one id starts with it', () => {
  const files2 = [
    { file: 'e2e/button.spec.ts', text: read('e2e/button.spec.ts') },
    { file: 'docs/handoffs/old.md', text: read('docs/handoffs/old.md') },
  ]
  const oracle = ['primitives--actions--button--primary', 'patterns--gauge--editor--empty', 'explorations--removed-page--default', 'explorations--lost--default']
  const cover = mentionCoverage(files2, registry, oracle)
  // resolved: the fixed id, the template prefix, and `explorations--`
  assert.equal(cover.resolved, 3)
  assert.equal(cover.files, 2)
  // the tool had the removed page, the lane does not
  assert.deepEqual(cover.missing.map((m) => [m.file, m.line, m.mention]), [['e2e/button.spec.ts', 3, 'explorations--removed-page--default']])
  // neither had the retired page
  assert.deepEqual(cover.dead.map((m) => m.mention), ['explorations--retired-page--default'])
  // without the tool's list nothing can be told dead
  const noOracle = mentionCoverage(files2, registry)
  assert.equal(noOracle.dead.length, 0)
  assert.deepEqual(noOracle.missing.map((m) => m.mention), ['explorations--retired-page--default', 'explorations--removed-page--default'])
  // a mention counts once per file, at its first line
  const twice = mentionCoverage([{ file: 'a.md', text: 'story primitives--actions--button--primary\nagain primitives--actions--button--primary' }], registry)
  assert.equal(twice.mentions, 1)
})

test('toolEdits lists the folder, scripts, package and port a file uses, line by line', () => {
  assert.deepEqual(at('package.json', 5), { file: 'package.json', line: 5, class: 'code', uses: 'script ladle:build, command ladle build', replacement: "remove it, or point it at the lane; run the lane's dev and build scripts instead", status: 'open' })
  assert.match(at('package.json', 4).uses, /^script ladle, command ladle serve/)
  // a script that runs one of the tool's scripts is the tool's too
  assert.equal(at('package.json', 6).uses, 'script ladle:build, script check:ladle-coverage')
  assert.equal(at('package.json', 10).uses, 'package @ladle/react')
  assert.equal(at('package.json', 10).status, 'open')
  assert.equal(at('.github/workflows/ci.yml', 4).class, 'ci')
  assert.equal(at('.github/workflows/ci.yml', 4).uses, 'script ladle:build')
  assert.equal(at('.claude/skills/ship/SKILL.md', 1).class, 'skill')
  assert.equal(at('.claude/skills/ship/SKILL.md', 1).uses, 'script check:ladle-coverage')
  // the folders go with the tool, so their own files are not edits
  assert.ok(!edits.some((e) => e.file.startsWith('.ladle/')))
})

test('a mention in a comment is class comment, one in a test is a test, and each blocks', () => {
  const comment = at('src/Thing.tsx', 1)
  assert.equal(comment.class, 'comment')
  assert.equal(comment.status, 'open')
  assert.equal(comment.uses, '.ladle/ladle.css')
  assert.match(comment.replacement, /read the app's base CSS \(stories\.appCss\.base\)/)
  const test2 = at('src/styles.test.ts', 2)
  assert.equal(test2.class, 'test')
  assert.equal(test2.status, 'open')
  assert.equal(at('docs/guide.md', 1).class, 'docs')
  assert.equal(at('docs/guide.md', 1).uses, 'script ladle')
})

test('the tool\'s name as a word only is prose, and never blocks', () => {
  assert.deepEqual(at('README.md', 1), { file: 'README.md', line: 1, class: 'prose', uses: 'the word Ladle', replacement: 'reword it or leave it', status: 'prose' })
  assert.ok(!openEdits(edits).some((e) => e.file === 'README.md'))
})

test('an id that resolves still works, a missing one blocks, a dead one is reported, and a historical doc never blocks', () => {
  const oracle = ['primitives--actions--button--primary', 'explorations--removed-page--default']
  const withOracle = toolEdits({ consumers: [], packages: ['@ladle/react'], registry, tool, historical: ['docs/handoffs/'], read, files, oracleIds: oracle })
  const line = (n) => withOracle.find((e) => e.file === 'e2e/button.spec.ts' && e.line === n)
  assert.equal(line(1).status, 'valid')
  assert.equal(line(1).uses, 'id primitives--actions--button--primary')
  assert.equal(line(2).status, 'valid')
  assert.match(line(2).uses, /^id prefix patterns--gauge--editor--/)
  // the tool had it and the lane has not
  assert.equal(line(3).status, 'open')
  assert.equal(line(3).class, 'test')
  // without the tool's list, an unknown id is open too
  assert.equal(at('e2e/button.spec.ts', 3).status, 'open')
  // the retired page in a historical doc is reported, not blocking
  assert.equal(withOracle.find((e) => e.file === 'docs/handoffs/old.md').status, 'historical')
  const dead = toolEdits({ consumers: [], packages: [], registry, tool, historical: [], read, files, oracleIds: oracle })
  assert.equal(dead.find((e) => e.file === 'docs/handoffs/old.md').status, 'dead')
  assert.ok(!openEdits(dead).some((e) => e.file === 'docs/handoffs/old.md'))
})

test('a port is still valid on the lane, and a story file\'s type import is the removal patch\'s', () => {
  put('src/Other.stories.tsx', ["import type { Story } from '@ladle/react'", "// uses the @ladle/react decorators too", "export default { title: 'Primitives / Other' }", 'export const Plain: Story = () => null', ''].join('\n'))
  const withOther = [...files, 'src/Other.stories.tsx']
  const fresh = laneRegistry({ root: ctx.root, config, files: withOther.filter(compileGlobs(config.stories.include)), read })
  const more = toolEdits({ consumers: [], packages: ['@ladle/react'], registry: fresh, tool, historical: [], read, files: withOther })
  assert.ok(!more.some((e) => e.file === 'src/Other.stories.tsx' && e.line === 1))
  assert.equal(more.find((e) => e.file === 'src/Other.stories.tsx' && e.line === 2).status, 'open')
  put('docs/ports.md', 'Dev server on http://localhost:61300/stories.\n')
  const ported = toolEdits({ consumers: [], packages: [], registry, tool, historical: [], read, files: [...files, 'docs/ports.md'] })
  assert.deepEqual(ported.find((e) => e.file === 'docs/ports.md'), { file: 'docs/ports.md', line: 1, class: 'docs', uses: 'port 61300', replacement: 'nothing, while stories.port is this port; set it when the tool goes', status: 'valid' })
})

test('only the type import the removal patch rewrites is skipped: a value import and a second type import are open, and a frozen file keeps its type import', () => {
  const text = [
    "import type { Story } from '@ladle/react'",
    "import { action } from '@ladle/react'",
    'import type {',
    '  StoryDefault,',
    "} from '@ladle/react'",
    "export default { title: 'Primitives / Mixed' } satisfies StoryDefault",
    'export const Plain: Story = () => null',
    '',
  ].join('\n')
  put('src/Mixed.stories.tsx', text)
  const withMixed = [...files, 'src/Mixed.stories.tsx']
  const live = laneRegistry({ root: ctx.root, config, files: withMixed.filter(compileGlobs(config.stories.include)), read })
  const found = (frozen = []) => toolEdits({ consumers: [], packages: ['@ladle/react'], registry: live, tool, historical: [], read, files: withMixed, frozen }).filter((e) => e.file === 'src/Mixed.stories.tsx')
  // the registry names the first type import of Story or StoryDefault: line 1
  assert.deepEqual(found().map((e) => [e.line, e.status, e.uses]), [[2, 'open', 'package @ladle/react'], [5, 'open', 'package @ladle/react']])
  // a frozen file keeps its import for the legacy types file; every other line is still checked
  assert.deepEqual(found([{ file: 'src/Mixed.stories.tsx' }]).map((e) => [e.line, e.status]), [[1, 'valid'], [2, 'open'], [5, 'open']])
  assert.match(found([{ file: 'src/Mixed.stories.tsx' }])[0].replacement, /legacy types file keeps/)
})

test('a frozen file\'s type import is valid only when the legacy types file declares every name it imports', () => {
  const frozenAt = (imports) => {
    put('src/Pinned.stories.tsx', `import type { ${imports} } from '@ladle/react'\nexport default { title: 'Primitives / Pinned' } satisfies StoryDefault\nexport const Plain: Story = () => null\n`)
    const withPinned = [...files, 'src/Pinned.stories.tsx']
    const live = laneRegistry({ root: ctx.root, config, files: withPinned.filter(compileGlobs(config.stories.include)), read })
    return toolEdits({ consumers: [], packages: ['@ladle/react'], registry: live, tool, historical: [], read, files: withPinned, frozen: [{ file: 'src/Pinned.stories.tsx' }] }).find((e) => e.file === 'src/Pinned.stories.tsx' && e.line === 1)
  }
  assert.equal(frozenAt('Story').status, 'valid')
  const open = frozenAt('Story, StoryDecorator')
  assert.equal(open.status, 'open')
  assert.match(open.replacement, /export StoryDecorator from the types file/)
  // once the patch has written the legacy file, its own exports are the names
  put('src/stories/legacy-story-types.d.ts', "declare module '@ladle/react' {\n  export type Story = () => null\n  export type StoryDecorator = () => null\n}\n")
  assert.equal(frozenAt('Story, StoryDecorator').status, 'valid')
  assert.equal(frozenAt('Story, Args').status, 'open')
})

test('the legacy types file the removal patch adds is not an edit, and a path into the tool\'s package is', () => {
  const legacy = "// The story types that files still importing @ladle/react use. Written by massimo\ndeclare module '@ladle/react' {\n  export type Story = () => null\n}\n"
  put('src/stories/legacy-story-types.d.ts', legacy)
  put('src/loader.test.ts', "import { readFileSync } from 'node:fs'\nexport const src = readFileSync('node_modules/@ladle/react/lib/cli/index.js', 'utf8')\n")
  const more = [...files, 'src/stories/legacy-story-types.d.ts', 'src/loader.test.ts']
  const found = toolEdits({ consumers: [], packages: ['@ladle/react'], registry, tool, historical: [], read, files: more })
  assert.ok(!found.some((e) => e.file === 'src/stories/legacy-story-types.d.ts'))
  assert.deepEqual(found.filter((e) => e.file === 'src/loader.test.ts').map((e) => [e.line, e.class, e.status, e.uses]), [[2, 'test', 'open', 'package @ladle/react']])
})

test('a package script is the tool\'s only when it runs one of the tool\'s scripts, directly or through another', () => {
  const pkg = JSON.stringify({
    scripts: {
      ladle: 'ladle serve',
      'ladle:build': 'ladle build',
      'ladle:pages': 'npm run ladle:build && cp -r build pages',
      'ladle:all': 'yarn ladle:pages',
      'e2e:ladle': 'playwright test --config=playwright.ladle.config.ts',
      test: 'node --test',
    },
  }, null, 2)
  const readWith = (f) => (f === 'package.json' ? pkg : f === 'ci.md' ? 'Run npm run e2e:ladle, then npm run ladle:all in CI\n' : read(f))
  const found = toolEdits({ consumers: [], packages: [], registry, tool, historical: [], read: readWith, files: [...files, 'ci.md'] })
  const line = (key) => pkg.split('\n').findIndex((l) => l.includes(`"${key}"`)) + 1
  assert.equal(found.find((e) => e.file === 'package.json' && e.line === line('ladle:pages')).uses, 'script ladle:build, script ladle:pages')
  assert.match(found.find((e) => e.file === 'package.json' && e.line === line('ladle:all')).uses, /script ladle:all/)
  // a browser test named for the tool does not block, in package.json or where it is run
  assert.deepEqual(found.find((e) => e.file === 'package.json' && e.line === line('e2e:ladle')), { file: 'package.json', line: line('e2e:ladle'), class: 'prose', uses: 'the word Ladle', replacement: 'reword it or leave it', status: 'prose' })
  const doc = found.find((e) => e.file === 'ci.md')
  assert.equal(doc.uses, 'script ladle:all')
  assert.ok(!openEdits(found).some((e) => /e2e:ladle/.test(e.uses)))
})

test('a vite.config mention of the tool\'s folder points at the lane\'s Vite config', () => {
  const viteTool = { ...tool, config: [...tool.config, '.ladle/vite.config.ts'] }
  put('docs/vite.md', 'Edit .ladle/vite.config.ts to change the build.\n')
  const found = toolEdits({ consumers: [], packages: [], registry, tool: viteTool, historical: [], read, files: [...files, 'docs/vite.md'] })
  assert.equal(found.find((e) => e.file === 'docs/vite.md').replacement, "use the lane's Vite config")
})

test('an id that a template continues through a variable is a prefix, in the lane and in the tool\'s list', () => {
  const ids = ['primitives--actions--button--primary', 'primitives--actions--button--ghost']
  const reg = { stories: Object.fromEntries(ids.map((id) => [id, {}])) }
  const text = 'const open = (state) => `/?story=${card.story}--${state}`\nconst card = { story: \'primitives--actions--button\' }\n'
  assert.deepEqual(idMentions(text, reg).map((m) => [m.mention, m.prefix]), [['primitives--actions--button', false]])
  const cover = mentionCoverage([{ file: 'e2e/a.spec.ts', text }], reg, ids)
  assert.deepEqual([cover.resolved, cover.missing.length, cover.dead.length], [1, 0, 0])
  // a name no id heads is still dead (when the tool's list lacks it) or missing (when it has it)
  const gone = [{ file: 'e2e/a.spec.ts', text: "const card = { story: 'primitives--actions--chip' }\nconst story = 'primitives--actions--chip'\n" }]
  assert.equal(mentionCoverage(gone, reg, ids).dead.length, 1)
  assert.equal(mentionCoverage(gone, reg, [...ids, 'primitives--actions--chip--default']).missing.length, 1)
  // toolEdits calls it a prefix that still works
  const found = toolEdits({ consumers: [], packages: [], registry: reg, tool, historical: [], read: () => text, files: ['e2e/a.spec.ts'], oracleIds: ids })
  assert.equal(found.find((e) => e.file === 'e2e/a.spec.ts' && e.line === 2).status, 'valid')
  assert.equal(found.find((e) => e.file === 'e2e/a.spec.ts' && e.line === 2).uses, 'id primitives--actions--button')
})

test('a consumer the index found that no line explains stays listed', () => {
  put('tools/odd.mjs', 'export const x = 1\n')
  const listed = toolEdits({ consumers: [{ file: 'tools/odd.mjs', line: 1, class: 'deploy', how: 'imports' }], packages: [], registry, tool, historical: [], read, files: [...files, 'tools/odd.mjs'] })
  assert.deepEqual(listed.find((e) => e.file === 'tools/odd.mjs'), { file: 'tools/odd.mjs', line: 1, class: 'code', uses: 'ladle (imports)', replacement: 'repoint it at the lane', status: 'open' })
})

test('the edits are sorted, and the package names come from the dependencies', () => {
  const keys = edits.map((e) => `${e.file}:${String(e.line).padStart(6, '0')}`)
  assert.deepEqual(keys, [...keys].sort())
  assert.deepEqual(toolPackages('ladle', { devDependencies: { '@ladle/react': '1', vite: '1' } }), ['@ladle/react'])
  assert.deepEqual(toolPackages('ladle', {}), ['@ladle/react'])
  assert.deepEqual(toolPackages('storybook', { dependencies: { '@storybook/react': '1', storybook: '1' } }), ['@storybook/react', 'storybook'])
  assert.deepEqual(toolPackages('nothing', {}), [])
  assert.deepEqual(toolEdits({ registry, tool: null, read }), [])
})

test('edits.md groups the open edits by class and lists what still works, what is dead and what is prose', () => {
  const md = editsMarkdown(edits, { tool: 'Ladle', command: 'node scripts/adopt.mjs retire stories --dry-run' })
  assert.match(md, /^# Edits before Ladle can go/)
  assert.match(md, /## Open \(\d+\)/)
  for (const cls of ['code', 'test', 'ci', 'skill', 'docs', 'comment']) assert.match(md, new RegExp(`### ${cls} \\(\\d+\\)`))
  assert.match(md, /- `src\/Thing\.tsx:1` uses \.ladle\/ladle\.css\. Change: read the app's base CSS/)
  assert.match(md, /## Prose \(3\)\n\n.*\n\n- `README\.md:1`\n/)
  assert.match(md, /Run `node scripts\/adopt\.mjs retire stories --dry-run` for what is still open\./)
  assert.ok(!md.includes('\u2014'))
  assert.match(editsSummary(edits), /^\d+ open edits?, \d+ mentions? that still work/)
})

test('writeEditsFile writes adopt/stories/edits.md under the project folder', () => {
  const path = writeEditsFile(ctx.project, edits, { tool: 'Ladle' })
  assert.equal(path, join(ctx.project, 'adopt', 'stories', 'edits.md'))
  assert.match(readFileSync(path, 'utf8'), /^# Edits before Ladle can go/)
})

test('retire counts the open edits in place of the tool\'s own consumers, and a clean list lets it through', () => {
  const ledger = { historical: [], classes: { stories: { state: 'cut-over', assets: [{ id: 'tool:ladle', kind: 'tool', decision: 'convert', paths: [], missing: false, state: 'cut-over' }] } } }
  const inv = {
    assets: [{ id: 'tool:ladle', paths: [], dirs: ['.ladle'], scripts: ['ladle'], consumers: [{ file: 'docs/guide.md', line: 1, class: 'docs', how: 'mentions' }] }],
    own: { generators: [], ratchets: [], docs: [], tokenFiles: [] },
  }
  const plain = retirePlan(ledger, 'stories', inv)
  assert.equal(plain.consumers.length, 1)
  assert.equal(plain.edits, undefined)
  const withEdits = retirePlan(ledger, 'stories', inv, { edits })
  assert.equal(withEdits.consumers.length, 0)
  assert.equal(withEdits.edits.length, openEdits(edits).length)
  assert.ok(withEdits.edits.length > 0)
  assert.equal(withEdits.editsValid, edits.filter((e) => e.status === 'valid').length)
  const clean = retirePlan(ledger, 'stories', inv, { edits: edits.filter((e) => e.status !== 'open') })
  assert.deepEqual(clean.edits, [])
  // the workflow jobs that run the tool's scripts are still collected
  const ci = { ...inv, assets: [{ ...inv.assets[0], consumers: [{ file: '.github/workflows/ci.yml', line: 4, class: 'ci', how: 'runs', via: 'ladle' }] }] }
  const jobs = retirePlan(ledger, 'stories', ci, { edits, jobAt: () => ({ id: 'stories', name: 'Stories' }) })
  assert.deepEqual(jobs.jobs, [{ file: '.github/workflows/ci.yml', line: 4, job: 'stories', name: 'Stories', via: ['ladle'] }])
  assert.equal(jobs.consumers.length, 0)
})

test('a frozen file and the files the lane\'s recipe writes are not listed for the tool\'s name as a word', () => {
  put('src/Kept.stories.tsx', "// Built for Ladle, kept as it was.\nexport default { title: 'Primitives / Kept' }\n")
  put('stories.html', '<div id="ladle-root"></div>\n<script type="module" src="/src/stories/main.tsx"></script>\n')
  put('src/stories/main.tsx', "// Ladle's own links render here.\n")
  put('src/stories/frame.tsx', "// What the Ladle provider did, done here.\n")
  const added = ['src/Kept.stories.tsx', 'src/stories/frame.tsx', 'src/stories/main.tsx', 'stories.html']
  const prose = (opts = {}) =>
    toolEdits({ consumers: [], packages: ['@ladle/react'], registry, tool, historical: [], read, files: [...files, ...added], ...opts })
      .filter((e) => e.status === 'prose' && added.includes(e.file))
      .map((e) => e.file)
  assert.deepEqual(prose(), added)
  assert.deepEqual(recipeFiles(ctx.root), ['src/stories/main.tsx', 'stories.html'])
  // the project's own frame keeps its line
  assert.deepEqual(prose({ frozen: [{ file: 'src/Kept.stories.tsx', sha256: 'x' }], lane: recipeFiles(ctx.root) }), ['src/stories/frame.tsx'])
})

test('a test or code file that reads a tool script by its exact name holds the retirement; a bare quoted tool name counts only as a key', () => {
  put('scripts/deploy-config.test.ts', [
    'it.each([',
    "  ['deploy.app.jsonc', 'build:app'],",
    "  ['deploy.preview.jsonc', 'ladle:build'],",
    "])('%s drops _redirects', (file, script) => expect(PACKAGE.scripts[script]).toBeDefined())",
    "expect(PACKAGE.scripts['ladle']).toBeDefined()",
    "const mode = 'ladle'",
    '',
  ].join('\n'))
  const found = toolEdits({ consumers: [], packages: [], registry, tool, historical: [], read, files: [...files, 'scripts/deploy-config.test.ts'] })
  const line = (n) => found.find((e) => e.file === 'scripts/deploy-config.test.ts' && e.line === n)
  assert.deepEqual(line(3), { file: 'scripts/deploy-config.test.ts', line: 3, class: 'test', uses: 'script ladle:build by its name', replacement: "it reads the script by its name: point it at the lane's script", status: 'open' })
  assert.equal(line(5).uses, 'script ladle by its name')
  assert.equal(line(5).status, 'open')
  assert.equal(line(6).status, 'prose')
  assert.equal(line(2), undefined)
})

test("the tool's output folder in code and config is an edit to point at the lane's; a comment, Vite's command and a job's name are not", () => {
  put('deploy.preview.jsonc', [
    '{',
    '  // `npm run ladle:build` deletes _redirects from build/ before this deploys.',
    '  "assets": {',
    '    "directory": "build"',
    '  }',
    '}',
    '',
  ].join('\n'))
  put('eslint.config.js', "export default [\n  { ignores: ['dist/**', 'build/**'] }, // the tool's output (npm run ladle:build)\n]\n")
  put('vite.config.ts', "export default ({ command }) => ({ base: command === 'build' ? '/app/' : '/' })\n")
  put('.github/workflows/pages.yml', 'jobs:\n  deploy:\n    needs: build\n    steps:\n      - uses: actions/upload-pages-artifact@v3\n        with:\n          path: build\n')
  put('docs/deploy.md', 'The stories build into `build/`.\n')
  put('tools/notes.ts', '// Carried from .ladle/vite.config.ts: revalidate the optimized deps.\nexport const notes = 1\n')
  const added = ['deploy.preview.jsonc', 'eslint.config.js', 'vite.config.ts', '.github/workflows/pages.yml', 'docs/deploy.md', 'tools/notes.ts']
  const found = toolEdits({ consumers: [], packages: [], registry, tool, historical: [], read, files: [...files, ...added], laneOutDir: 'dist-stories' })
  const at = (file, n) => found.find((e) => e.file === file && e.line === n)
  const change = "point it at the lane's output folder, stories.outDir (dist-stories)"
  assert.deepEqual(at('deploy.preview.jsonc', 4), { file: 'deploy.preview.jsonc', line: 4, class: 'code', uses: 'output folder build', replacement: change, status: 'open' })
  // A comment line in JSONC is a comment, and names the script, not the folder.
  assert.deepEqual([at('deploy.preview.jsonc', 2).class, at('deploy.preview.jsonc', 2).uses], ['comment', 'script ladle:build'])
  // The use in the line's code is the edit; its trailing comment's script goes.
  assert.deepEqual(at('eslint.config.js', 2), { file: 'eslint.config.js', line: 2, class: 'code', uses: 'output folder build', replacement: change, status: 'open' })
  assert.equal(at('vite.config.ts', 1), undefined)
  assert.equal(at('.github/workflows/pages.yml', 3), undefined)
  assert.deepEqual([at('.github/workflows/pages.yml', 7).class, at('.github/workflows/pages.yml', 7).uses], ['ci', 'output folder build'])
  assert.ok(!found.some((e) => e.file === 'docs/deploy.md'))
  assert.deepEqual([at('tools/notes.ts', 1).class, at('tools/notes.ts', 1).uses], ['comment', '.ladle/vite.config.ts'])
  // A folder the config names, or one a tool script passes with -o, is the folder instead.
  const named = toolEdits({ consumers: [], packages: [], registry, tool: { ...tool, settings: { outDir: 'ladle-static' } }, historical: [], read, files: [...files, ...added] })
  assert.ok(!named.some((e) => /output folder build/.test(e.uses)))
  const pkg = JSON.stringify({ scripts: { ladle: 'ladle serve', 'ladle:build': 'ladle build -o .stories-out' } }, null, 2)
  put('tests/visual.spec.ts', "const dir = join(here, '.stories-out')\n")
  const flagged = toolEdits({ consumers: [], packages: [], registry, tool: { ...tool, settings: { outDir: null, notLiteral: ['outDir'] } }, historical: [], read: (f) => (f === 'package.json' ? pkg : read(f)), files: [...files, ...added, 'tests/visual.spec.ts'] })
  assert.equal(flagged.find((e) => e.file === 'tests/visual.spec.ts').uses, 'output folder .stories-out')
  // An outDir set with code gives no default folder.
  assert.ok(!flagged.some((e) => /output folder build/.test(e.uses)))
})

// toolEdits on a repo held in memory, for the tool's scripts as `scripts`.
const inMemory = (repo, scripts, extra = {}) =>
  toolEdits({ consumers: [], packages: [], registry: { files: {}, stories: {} }, tool: { tool: 'ladle', config: ['.ladle/config.mjs'], scripts, port: null, settings: { outDir: null } }, read: (f) => repo[f] ?? null, files: Object.keys(repo), ...extra })
const openAt = (found) => found.filter((e) => e.status === 'open' && e.class !== 'comment' && e.file !== 'package.json').map((e) => `${e.file}:${e.line} ${e.uses}`)

test('a plain-word tool script is read by its name only as a key in brackets, never as a mode or a command code compares', () => {
  const repo = {
    'package.json': JSON.stringify({ scripts: { dev: 'ladle serve', 'ladle:build': 'ladle build -o .stories-out', build: 'tsc -p tsconfig.build.json && pnpm ladle:build' } }, null, 2),
    '.ladle/config.mjs': 'export default {}\n',
    'src/env.ts': "export const isDev = import.meta.env.MODE === 'dev'\n",
    'vite.config.ts': "export default ({ command }) => ({ base: command === 'build' ? '/app/' : '/' })\n",
    'tsconfig.build.json': '{\n  "exclude": ["build"]\n}\n',
    'tests/scripts.test.ts': "expect(mode).toBe('dev')\nexpect(PACKAGE.scripts['dev']).toBeDefined()\nexpect(PACKAGE.scripts.build).toContain('ladle:build')\n",
  }
  assert.deepEqual(openAt(inMemory(repo, ['dev', 'ladle:build'])), ['tests/scripts.test.ts:2 script dev by its name', 'tests/scripts.test.ts:3 script ladle:build by its name'])
})

test("Ladle's default build folder is its output only when a command builds there, and tracked files in it are still read", () => {
  const repo = {
    'package.json': JSON.stringify({ scripts: { ladle: 'ladle serve' } }, null, 2),
    '.ladle/config.mjs': 'export default {}\n',
    'tsconfig.json': '{\n  "compilerOptions": { "outDir": "build" }\n}\n',
    'build/check.mjs': "execSync('npm run ladle')\n",
  }
  // Only `ladle serve`: build/ is the app's folder, not Ladle's.
  assert.deepEqual(openAt(inMemory(repo, ['ladle'])), ['build/check.mjs:1 script ladle'])
  // A workflow that runs `ladle build` with no -o builds there; a file git tracks under it is still read.
  repo['.github/workflows/stories.yml'] = 'jobs:\n  stories:\n    steps:\n      # ladle build -o elsewhere is not run\n      - run: npx ladle build\n'
  const built = inMemory(repo, ['ladle'])
  assert.deepEqual(openAt(built), ['.github/workflows/stories.yml:5 command ladle build', 'build/check.mjs:1 script ladle', 'tsconfig.json:2 output folder build'])
  assert.ok(!built.some((e) => /output folder elsewhere/.test(e.uses)))
  // So does a hosting config's build command, or a shell script, with the default folder or one it names.
  delete repo['.github/workflows/stories.yml']
  repo['scripts/stories.sh'] = '#!/bin/sh\nladle build \\\n  -o .stories-out\n'
  const named = inMemory(repo, ['ladle'])
  assert.ok(!named.some((e) => /output folder build/.test(e.uses)))
  repo['netlify.toml'] = '[build]\n  command = "npx ladle build"\n'
  assert.ok(inMemory(repo, ['ladle']).some((e) => e.file === 'tsconfig.json' && e.uses === 'output folder build'))
})

test("an ignore file's entry for the tool's output folder still works and holds nothing up", () => {
  const repo = {
    'package.json': JSON.stringify({ scripts: { 'ladle:build': 'ladle build' } }, null, 2),
    '.ladle/config.mjs': 'export default {}\n',
    '.gitignore': 'node_modules\nbuild/\n/build\n# build/\nbuild-cache/\n',
  }
  const found = inMemory(repo, ['ladle:build'], { laneOutDir: 'dist-stories' }).filter((e) => e.file === '.gitignore')
  assert.deepEqual(found, [2, 3].map((line) => ({ file: '.gitignore', line, class: 'code', uses: 'output folder build', replacement: "nothing before the tool goes: add an entry for the lane's output folder, stories.outDir (dist-stories), and this one can go with the tool", status: 'valid' })))
})
