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
  scripts: { ladle: 'ladle serve --port 61300', 'ladle:build': 'ladle build', 'check:ladle-coverage': 'node scripts/coverage.mjs', test: 'node --test' },
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
  assert.equal(at('package.json', 6).uses, 'script check:ladle-coverage')
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
  put('src/Other.stories.tsx', ["import type { Story } from '@ladle/react'", "// uses the @ladle/react decorators too", "export default { title: 'Primitives / Other' }", ''].join('\n'))
  const more = toolEdits({ consumers: [], packages: ['@ladle/react'], registry, tool, historical: [], read, files: [...files, 'src/Other.stories.tsx'] })
  assert.ok(!more.some((e) => e.file === 'src/Other.stories.tsx' && e.line === 1))
  assert.equal(more.find((e) => e.file === 'src/Other.stories.tsx' && e.line === 2).status, 'open')
  put('docs/ports.md', 'Dev server on http://localhost:61300/stories.\n')
  const ported = toolEdits({ consumers: [], packages: [], registry, tool, historical: [], read, files: [...files, 'docs/ports.md'] })
  assert.deepEqual(ported.find((e) => e.file === 'docs/ports.md'), { file: 'docs/ports.md', line: 1, class: 'docs', uses: 'port 61300', replacement: 'nothing, while stories.port is this port; set it when the tool goes', status: 'valid' })
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
  assert.ok(!md.includes('—'))
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
})
