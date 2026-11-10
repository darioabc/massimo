// A repo that keeps its Storybook: the stories keys massimo proposes from its
// main config and the script that serves it, Storybook's id rule ported so a
// story's id and URL are known without running it, the plan's lines for a
// kept tool, a kept class that ends at cut-over, and the skills' path beside
// a kept Storybook.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { markClass } from '../scripts/lib/adopt.mjs'
import { SCRIPTS, read, readJson, run, scratch } from './helpers.mjs'

const contexts = []
after(() => contexts.forEach((c) => c.cleanup()))
const fresh = () => {
  const ctx = scratch('storybook-kept')
  contexts.push(ctx)
  return ctx
}
const detect = (root) => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'detect.mjs'), '--root', root], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
const lib = () => import('../scripts/lib/storybook.mjs')

// Every id the fixture's story files have, by Storybook's rule, worked out by hand.
const IDS = {
  'src/components/Alert/alert.stories.ts': ['alert', ['alert--warning']],
  'src/components/Badge.stories.ts': ['Feedback/Badge', ['custom-badge--default']],
  'src/components/Button/Button.stories.ts': ['Button', ['button--primary', 'button--with-icon', 'button--x-large']],
  'src/components/Dialog/Dialog.stories.ts': ['Overlays / Dialog', ['overlays-dialog--open']],
  'src/components/card/index.stories.ts': ['card', ['card--default']],
  'src/patterns/Login/Login.stories.ts': ['Patterns/Login', ['patterns-login--filled-in']],
}

test("Storybook's id rule: sanitize, the story name from the export, and toId", async () => {
  const { sanitize, storyNameFromExport, toId } = await lib()
  assert.equal(sanitize('Components / Button'), 'components-button')
  // Typographic quotes and dashes are separators too, and letters beyond ASCII stay.
  assert.equal(sanitize('Über \u2019quoted\u2019 \u2014 dash'), 'über-quoted-dash')
  for (const [key, name] of [['WithIcon', 'With Icon'], ['XLarge', 'X Large'], ['CustomURL', 'Custom URL'], ['HTMLElement', 'HTML Element'], ['story1', 'Story 1'], ['with_underscore', 'With Underscore'], ['Default', 'Default']]) {
    assert.equal(storyNameFromExport(key), name, key)
  }
  assert.equal(toId('Feedback/Badge', storyNameFromExport('WithIcon')), 'feedback-badge--with-icon')
  assert.equal(toId('Feedback/Badge'), 'feedback-badge')
  assert.throws(() => toId('!!!', 'Default'), /Invalid kind '!!!', must include alphanumeric characters/)
})

test("Storybook's auto title: the path after the entry's folder, a repeated or index file name dropped, and the entry's prefix", async () => {
  const { normalizeStoriesEntry, storyGlob, userOrAutoTitle } = await lib()
  const opts = { configDir: '/repo/.storybook', workingDir: '/repo' }
  const all = normalizeStoriesEntry('../src/**/*.stories.@(js|jsx|mjs|ts|tsx)', opts)
  assert.equal(all.directory, './src')
  assert.equal(all.files, '**/*.stories.@(js|jsx|mjs|ts|tsx)')
  const title = (file, user) => userOrAutoTitle(file, [all], user)
  assert.equal(title('./src/components/ui/button/button.stories.ts'), 'components/ui/button')
  assert.equal(title('./src/components/Button/Button.stories.tsx'), 'components/Button')
  // The folder and the file compare in any case; the file's own case is kept.
  assert.equal(title('./src/components/Alert/alert.stories.ts'), 'components/alert')
  assert.equal(title('./src/components/card/index.stories.ts'), 'components/card')
  // Only `.stories.<ext>` is cut, so a name with more dots keeps them.
  assert.equal(title('./src/forms/date.picker.stories.ts'), 'forms/date.picker')
  assert.equal(title('./src/components/Badge.stories.ts', 'Feedback/Badge'), 'Feedback/Badge')
  assert.equal(title('./lib/Badge.stories.ts'), undefined)
  const prefixed = normalizeStoriesEntry({ directory: '../src/patterns', files: '**/*.stories.ts', titlePrefix: 'Patterns' }, opts)
  assert.equal(userOrAutoTitle('./src/patterns/Login/Login.stories.ts', [prefixed]), 'Patterns/Login')
  assert.equal(userOrAutoTitle('./src/patterns/Login/Login.stories.ts', [prefixed], 'Forms/Login'), 'Patterns/Forms/Login')
  // The first entry that matches gives the title.
  assert.equal(userOrAutoTitle('./src/patterns/Login/Login.stories.ts', [all, prefixed]), 'patterns/Login')
  // Storybook's default pattern for a folder entry, and a group massimo's globs cannot say.
  assert.equal(storyGlob('**/*.@(mdx|stories.@(js|jsx|mjs|ts|tsx))'), '**/*.{mdx,stories.{js,jsx,mjs,ts,tsx}}')
  assert.equal(storyGlob('**/*.!(test).ts'), null)
  assert.equal(normalizeStoriesEntry('../src/**/*.+(ts|tsx)', opts).importPathMatcher, null)
})

test('detect suggests the stories keys of a kept Storybook: its globs, its dev script, port, url and iframe story URL', () => {
  const ctx = fresh()
  const out = detect(ctx.root)
  assert.deepEqual(out.storyTools.tools, ['storybook'])
  assert.equal(out.storyTools.lane, null)
  const stories = out.suggestedConfig.stories
  assert.deepEqual(stories.include, ['src/components/**/*.stories.{js,ts}', 'src/patterns/**/*.stories.ts'])
  assert.equal(stories.devCommand, 'pnpm run storybook')
  assert.equal(stories.port, 6007)
  assert.equal(stories.url, 'http://localhost:6007')
  assert.equal(stories.storyUrl, 'http://localhost:6007/iframe.html?id={id}&viewMode=story')
  assert.equal(stories.lane, 'native')
  assert.deepEqual(out.storyTools.storybook, {
    main: '.storybook/main.ts',
    notes: ['the stories entry ../src/**/*.mdx lists MDX docs pages, which have no story ids, so it is not in stories.include'],
  })
  // A stories list written as code is not guessed, and with no script that
  // serves Storybook, no command, port or URL is proposed.
  writeFileSync(join(ctx.root, '.storybook', 'main.ts'), "import { globs } from './globs'\n\nexport default { stories: globs(), framework: '@storybook/vue3-vite' }\n")
  writeFileSync(join(ctx.root, 'package.json'), JSON.stringify({ name: 'fixture', devDependencies: { vite: '6', vue: '3', storybook: '8' } }))
  const plain = detect(ctx.root)
  assert.deepEqual(plain.suggestedConfig.stories.include, ['src/**/*.story.vue'])
  assert.deepEqual([plain.suggestedConfig.stories.devCommand, plain.suggestedConfig.stories.url, plain.suggestedConfig.stories.storyUrl, plain.suggestedConfig.stories.port], [null, null, null, 4650])
  assert.deepEqual(plain.storyTools.storybook.notes, [
    '.storybook/main.ts sets its stories list with code, or names none, so massimo reads no story globs from it: set stories.include by hand to the globs of its story files',
    'no package script runs storybook dev, so stories.devCommand, port, url and storyUrl are not proposed',
  ])
})

test('adopt plan proposes the kept Storybook\'s stories keys, and its lines say the stories stay in Storybook', () => {
  const ctx = fresh()
  assert.equal(run('adopt', ctx, ['scan']).status, 0)
  const plan = run('adopt', ctx, ['plan'])
  assert.equal(plan.status, 0, plan.stderr)
  assert.match(plan.stdout, /tool:storybook {2}keep, /)
  assert.match(plan.stdout, /Its 9 stories in 7 files stay in storybook, which keeps serving them; the graph credits them by file name, and stories\.mjs storybook gives each story's id and URL by Storybook's own rule\./)
  assert.doesNotMatch(plan.stdout, /native lane/)
  assert.match(plan.stdout, /^note: the stories entry \.\.\/src\/\*\*\/\*\.mdx lists MDX docs pages/m)
  assert.deepEqual(readJson(ctx.project, 'adopt', 'config.proposed.json'), {
    version: 1,
    stories: {
      include: ['src/components/**/*.stories.{js,ts}', 'src/patterns/**/*.stories.ts'],
      devCommand: 'pnpm run storybook',
      port: 6007,
      url: 'http://localhost:6007',
      storyUrl: 'http://localhost:6007/iframe.html?id={id}&viewMode=story',
    },
  })
  const config = run('adopt', ctx, ['config'])
  assert.equal(config.status, 0, config.stderr)
  assert.match(config.stdout, /^\+ stories\.devCommand: "pnpm run storybook"$/m)
  assert.match(config.stdout, /^\+ stories\.port: 6007$/m)
  assert.match(config.stdout, /^\+ stories\.storyUrl: "http:\/\/localhost:6007\/iframe\.html\?id=\{id\}&viewMode=story"$/m)
})

test('stories.mjs storybook names each story by Storybook\'s rule, with its URL, by file or by component', () => {
  const ctx = fresh()
  assert.equal(run('graph', ctx).status, 0)
  const all = run('stories', ctx, ['storybook', '--json'])
  // The file whose title is written as code holds the run to exit 1, and gets no id.
  assert.equal(all.status, 1)
  const listed = JSON.parse(all.stdout)
  assert.equal(listed.main, '.storybook/main.ts')
  const broken = listed.files.find((f) => f.file === 'src/components/Broken.stories.ts')
  assert.deepEqual([broken.title, broken.stories, broken.problems], [null, [], ['title is not statically readable']])
  const named = Object.fromEntries(listed.files.filter((f) => f !== broken).map((f) => [f.file, [f.title, f.stories.map((s) => s.id)]]))
  assert.deepEqual(named, IDS)
  const button = listed.files.find((f) => f.file === 'src/components/Button/Button.stories.ts')
  // The id follows the export; the name shown is the story's own.
  assert.deepEqual(button.stories[1], { export: 'WithIcon', name: 'With an icon', id: 'button--with-icon', url: 'http://localhost:6007/iframe.html?id=button--with-icon&viewMode=story' })
  // A component's stories come from graph.json, its own first.
  const byComponent = run('stories', ctx, ['storybook', 'src/components/Button/Button.vue'])
  assert.equal(byComponent.status, 0, byComponent.stderr)
  assert.deepEqual(byComponent.stdout.split('\n').filter((l) => l && !l.startsWith(' ')), [
    "src/components/Button/Button.stories.ts  Button  (the component's own story)",
    'src/components/Dialog/Dialog.stories.ts  Overlays / Dialog',
    "massimo stories: 2 story files, 4 stories, by Storybook's id rule from .storybook/main.ts",
  ])
  // stories.storyUrl with {id} sets the address; --routes gives shoot.mjs --sweep its file.
  const config = readJson(ctx.root, 'massimo.config.json')
  writeFileSync(join(ctx.root, 'massimo.config.json'), JSON.stringify({ ...config, stories: { storyUrl: 'https://stories.example.test/iframe.html?id={id}&viewMode=story' } }))
  const routes = run('stories', ctx, ['storybook', 'src/components/card/index.stories.ts', '--routes'])
  assert.equal(routes.status, 0, routes.stderr)
  assert.deepEqual(JSON.parse(routes.stdout), { 'card--default': '/iframe.html?id=card--default&viewMode=story' })
  assert.match(run('stories', ctx, ['storybook', 'src/components/card/index.stories.ts']).stdout, /^ {2}card--default {2}https:\/\/stories\.example\.test\/iframe\.html\?id=card--default&viewMode=story$/m)
  const unknown = run('stories', ctx, ['storybook', 'src/Nope.vue'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /src\/Nope\.vue: neither a story file Storybook serves nor a component in graph\.json/)
})

test('stories.mjs storybook --against checks the ids with Storybook\'s own index', () => {
  const ctx = fresh()
  const file = 'src/components/Button/Button.stories.ts'
  const entry = (id, type = 'story') => [id, { id, type, title: 'Button', name: id, importPath: `./${file}` }]
  const index = { v: 5, entries: Object.fromEntries([entry('button--primary'), entry('button--with-icon'), entry('button--x-large'), entry('button--docs', 'docs')]) }
  writeFileSync(join(ctx.root, 'index.json'), JSON.stringify(index))
  const ok = run('stories', ctx, ['storybook', file, '--against', join(ctx.root, 'index.json')])
  assert.equal(ok.status, 0, ok.stdout)
  assert.match(ok.stdout, /^ok: every id matches Storybook's index$/m)
  delete index.entries['button--x-large']
  index.entries['button--large'] = entry('button--large')[1]
  writeFileSync(join(ctx.root, 'index.json'), JSON.stringify(index))
  const off = run('stories', ctx, ['storybook', file, '--against', join(ctx.root, 'index.json')])
  assert.equal(off.status, 1)
  assert.match(off.stdout, /^missing in Storybook: button--x-large \(src\/components\/Button\/Button\.stories\.ts\)$/m)
  assert.match(off.stdout, /^not named by massimo: button--large \(src\/components\/Button\/Button\.stories\.ts\)$/m)
})

test('a stories entry decides which script files are story files, whatever their names', () => {
  const ctx = fresh()
  writeFileSync(join(ctx.root, '.storybook', 'main.ts'), "export default { stories: ['../src/**/*.story.@(ts|tsx)'], framework: '@storybook/vue3-vite' }\n")
  mkdirSync(join(ctx.root, 'src', 'widgets', 'Chip'), { recursive: true })
  writeFileSync(join(ctx.root, 'src', 'widgets', 'Chip', 'Chip.story.ts'), 'export default {}\n\nexport const Default = {}\nexport const Removable = {}\n')
  writeFileSync(join(ctx.root, 'src', 'widgets', 'Chip', 'chip.ts'), 'export const size = 2\n')
  assert.deepEqual(detect(ctx.root).suggestedConfig.stories.include, ['src/**/*.story.{ts,tsx}'])
  const listed = run('stories', ctx, ['storybook', '--json'])
  assert.equal(listed.status, 0, listed.stderr)
  assert.deepEqual(
    JSON.parse(listed.stdout).files.map((f) => [f.file, f.title, f.stories.map((s) => s.id)]),
    [['src/widgets/Chip/Chip.story.ts', 'widgets/Chip', ['widgets-chip--default', 'widgets-chip--removable']]],
  )
})

test('stories.mjs storybook --against with no file names shows a story file massimo did not list, and skips a story\'s test entries', () => {
  const ctx = fresh()
  rmSync(join(ctx.root, 'src', 'components', 'Broken.stories.ts'))
  const listed = JSON.parse(run('stories', ctx, ['storybook', '--json']).stdout).files
  const entries = {}
  for (const f of listed) for (const s of f.stories) entries[s.id] = { id: s.id, type: 'story', subtype: 'story', title: f.title, name: s.name, importPath: `./${f.file}` }
  // A story's test has an entry of its own, of the story type.
  entries['button--primary:shows-the-label'] = { id: 'button--primary:shows-the-label', type: 'story', subtype: 'test', title: 'Button', name: 'shows the label', importPath: './src/components/Button/Button.stories.ts' }
  const index = join(ctx.root, 'index.json')
  writeFileSync(index, JSON.stringify({ v: 5, entries }))
  const ok = run('stories', ctx, ['storybook', '--against', index])
  assert.equal(ok.status, 0, ok.stdout)
  assert.match(ok.stdout, /^ok: every id matches Storybook's index$/m)
  assert.equal(run('stories', ctx, ['storybook', 'src/components/Button/Button.stories.ts', '--against', index]).status, 0)
  entries['legacy-panel--default'] = { id: 'legacy-panel--default', type: 'story', title: 'Legacy/Panel', name: 'Default', importPath: './src/legacy/Panel.stories.js' }
  writeFileSync(index, JSON.stringify({ v: 5, entries }))
  const off = run('stories', ctx, ['storybook', '--against', index])
  assert.equal(off.status, 1)
  assert.match(off.stdout, /^not named by massimo: legacy-panel--default \(src\/legacy\/Panel\.stories\.js\)$/m)
  // Asked for one file, the comparison stays with that file.
  assert.equal(run('stories', ctx, ['storybook', 'src/components/Button/Button.stories.ts', '--against', index]).status, 0)
})

test("a story file's meta id, an __esModule export and a file with no default export, as Storybook reads them", async () => {
  const { storybookIndex } = await lib()
  const ctx = fresh()
  const files = {
    'src/components/Empty/Empty.stories.ts': "export default { title: 'Kit/Empty', id: '' }\n\nexport const Default = {}\n",
    'src/components/Interop/Interop.stories.ts': "export default { title: 'Interop' }\n\nexport const __esModule = true\nexport const Default = {}\n",
    'src/components/Factory/Factory.stories.ts': "import preview from '../../../.storybook/preview'\n\nconst meta = preview.meta({ title: 'Factory' })\n\nexport const Default = meta.story({})\n",
    'src/components/Numbered/Numbered.stories.ts': "export default { title: 'Numbered', id: 5 }\n\nexport const Default = {}\n",
  }
  const index = storybookIndex(ctx.root, Object.keys(files), { read: (f) => files[f] })
  const got = Object.fromEntries(index.files.map((f) => [f.file, [f.stories.map((s) => s.id), f.problems]]))
  assert.deepEqual(got, {
    // An empty id falls back to the title.
    'src/components/Empty/Empty.stories.ts': [['kit-empty--default'], []],
    'src/components/Factory/Factory.stories.ts': [[], ['it has no default export, so massimo reads no meta from it']],
    'src/components/Interop/Interop.stories.ts': [['interop--default'], []],
    'src/components/Numbered/Numbered.stories.ts': [[], ['id is not a string, which Storybook refuses']],
  })
})

test('a class whose every asset is kept ends at cut-over: mark refuses retired, unless forced', () => {
  const ledger = () => ({ classes: { stories: { state: 'cut-over', date: 'd0', batch: 'stories-1', assets: [{ id: 'tool:storybook', decision: 'keep', loss: 'carried', state: 'cut-over', date: 'd0', batch: 'stories-1' }] } } })
  const kept = ledger()
  assert.throws(() => markClass(kept, 'stories', 'retired'), /nothing in stories is marked retire or convert, so it ends at cut-over: a kept asset is never retired/)
  assert.equal(kept.classes.stories.state, 'cut-over')
  assert.equal(markClass(ledger(), 'stories', 'retired', { force: true, date: 'd1' }), 'stories: cut-over -> retired')
  // A class with something to retire still moves on.
  const mixed = ledger()
  mixed.classes.stories.assets.push({ id: 'lane:src/stories', decision: 'retire', loss: 'clean', state: 'cut-over', date: 'd0', batch: 'stories-1' })
  assert.equal(markClass(mixed, 'stories', 'retired', { date: 'd1' }), 'stories: cut-over -> retired')
  // So does one whose retire asset the scan no longer finds, once its files are gone.
  const gone = { classes: { stories: { state: 'cut-over', date: 'd0', batch: 'stories-1', assets: [{ id: 'tool:ladle', decision: 'retire', loss: 'clean', state: 'cut-over', date: 'd0', batch: 'stories-1', missing: true }] } } }
  assert.equal(markClass(gone, 'stories', 'retired', { date: 'd1' }), 'stories: cut-over -> retired')
  assert.equal(gone.classes.stories.state, 'retired')
})

test('the skills write down the path beside a kept Storybook, end to end', () => {
  const doc = (...p) => read(SCRIPTS, '..', ...p)
  const stories = doc('skills', 'stories', 'SKILL.md')
  assert.match(stories, /A repo that keeps its own story tool \(Storybook, Histoire, or Ladle without the csf opt-in\), as recorded at setup, takes no recipe/)
  assert.match(stories, /`storyUrl`, Storybook's story address `<url>\/iframe\.html\?id=\{id\}&viewMode=story`/)
  assert.match(stories, /node <project>\/scripts\/stories\.mjs storybook <component or story file>/)
  assert.match(stories, /--selector '#storybook-root'/)
  assert.match(stories, /--ready '#storybook-root'/)
  assert.match(stories, /\*\*New stories\*\* are CSF files in the repo's existing format, beside its `\*\.stories\.\*` files/)
  assert.match(stories, /beside a kept story tool, no recipe: the tool, one of its story files as the format, and its story URL pattern/)
  const writer = doc('agents', 'story-writer.md')
  assert.match(writer, /In a csf lane \(`stories\.lane: "csf"`\), or beside a kept story tool \(Storybook, Ladle, Histoire\), that is a CSF file beside the repo's other `\*\.stories\.\*` files/)
  // A title only where the repo's files set one, so a new story sits with its neighbours.
  assert.match(writer, /a default export \(with a title only where the repo's other story files set one; the tool builds it from the file's path otherwise\)/)
  assert.match(doc('agents', 'translator.md'), /in the story lane \(beside a kept story tool, a story file in that tool's format beside the repo's other stories: CSF for Storybook or Ladle\)/)
  assert.match(doc('agents', 'baseline.md'), /the story is then a story file in that tool's format beside the repo's other stories \(CSF for Storybook or Ladle\)/)
  const ux = doc('skills', 'ux', 'SKILL.md')
  assert.match(ux, /Beside a Storybook the team keeps, the kept stories are the lane: `node <project>\/scripts\/stories\.mjs storybook <component file>`/)
  assert.match(ux, /with `--selector '#storybook-root'` for a Storybook URL/)
  assert.match(ux, /beside a kept story tool, the tool, one of its story files as the format and its story URL pattern, so the render is a story in that tool/)
  assert.match(ux, /so the new story is a story file in that tool's format beside the others \(CSF for Storybook or Ladle\)/)
  const tidy = doc('skills', 'tidy', 'SKILL.md')
  assert.match(tidy, /A story tool the team keeps \(Storybook, Ladle, Histoire\) counts as the lane/)
  assert.match(tidy, /shoot each URL with `--selector '#storybook-root'`, and keep the server up for the after shots/)
  const figma = doc('skills', 'figma', 'SKILL.md')
  assert.match(figma, /A story tool the team keeps \(Storybook, Ladle, Histoire\) counts as the lane/)
  assert.match(figma, /beside a kept Storybook, shoot the iframe URL that `node <project>\/scripts\/stories\.mjs storybook <component file>` prints/)
  const start = doc('skills', 'start', 'SKILL.md')
  assert.match(start, /When the only thing to adopt is a story tool the team keeps \(Storybook, Histoire, or Ladle kept as it is/)
  // Ladle can still opt into the csf lane, which happens in adopt, so it is offered first.
  assert.match(start, /For Ladle, offer the csf lane first: adopt opts into it with `adopt\.mjs config --write --lane csf`[^\n]*Recommend the skip for Ladle only when the team turns that down/)
  assert.match(start, /recommend skipping adopt instead/)
  assert.match(start, /or keep a story tool with nothing else to adopt \(`--note "keeps <tool>"`\)/)
  const adopt = doc('skills', 'adopt', 'SKILL.md')
  assert.match(adopt, /4\. \*\*Shadow\.\*\*[^\n]*A project kept in a package \(made with `init\.mjs --root <package>`\)[^\n]*`defaults: run: working-directory:`/)
  assert.match(adopt, /`config --write` adds to `stories\.include` and never removes from it, so when the config already holds the native lane's glob that setup wrote/)
  assert.match(adopt, /A class whose every asset is kept[^\n]*has nothing to retire: it ends at cut-over, and `mark` refuses `retired` for it/)
  assert.match(doc('README.md'), /^#### Keeping Storybook$/m)
  assert.match(doc('reference', 'project.md'), /Beside a Storybook the repo keeps, it is Storybook's story address with `\{id\}`/)
})
