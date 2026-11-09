// stories.mjs: index (text and --json), --check, and leak.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { checkLane, gitIgnored, layoutEdit, leakReport, typesLine } from '../scripts/stories.mjs'
import { walk } from '../scripts/lib/glob.mjs'
import { DEFAULTS, deepMerge } from '../scripts/lib/project.mjs'
import { run, scratch } from './helpers.mjs'

const contexts = []
after(() => contexts.forEach((c) => c.cleanup()))

// A scratch copy of the csf-lane fixture, `extra` files written over it and
// `edit` applied to its config.
function lane(extra = {}, edit = () => {}) {
  const ctx = scratch('csf-lane')
  contexts.push(ctx)
  for (const [file, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(ctx.root, file)), { recursive: true })
    writeFileSync(join(ctx.root, file), text)
  }
  const path = join(ctx.root, 'massimo.config.json')
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  edit(raw)
  writeFileSync(path, JSON.stringify(raw))
  const config = deepMerge(structuredClone(DEFAULTS), raw)
  return { ctx, root: ctx.root, config, files: walk(ctx.root, { ignore: config.ignore }) }
}

const stories = (t, args) => run('stories', t.ctx, args)
const layout = (c) => (c.stories.appCss = { base: 'src/styles/base.css', entry: 'src/styles/app.css' })
const EXCLUDE = '@source not "../components";\n@source not "../pages/review/tableHarness.tsx";\n'

test('index prints the files, slugs and states per root', () => {
  const r = stories(lane(), ['index'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(
    r.stdout,
    [
      'massimo stories: 7 files, 6 slugs, 13 states in 5 roots (ids: ladle)',
      '  Foundations   1 file, 1 slug, 1 state',
      '  Primitives    1 file, 1 slug, 3 states',
      '  Patterns      2 files, 2 slugs, 4 states',
      '  Pages         2 files, 1 slug, 3 states',
      '  Explorations  1 file, 1 slug, 2 states',
      'home: foundations--welcome--start-here',
      '',
    ].join('\n'),
  )
})

test('index --json prints the format 1 registry, and a problem shows in the text', () => {
  const t = lane()
  const registry = JSON.parse(stories(t, ['index', '--json']).stdout)
  assert.equal(registry.format, 1)
  assert.equal(registry.ids, 'ladle')
  assert.equal(registry.order.length, 13)
  assert.deepEqual(Object.keys(registry.slugs).sort(), ['explorations--new-header', 'foundations--welcome', 'pages--review--summary', 'patterns--cards--card', 'patterns--gauge--editor', 'primitives--actions--button'])
  assert.equal(registry.home, 'foundations--welcome--start-here')
  assert.deepEqual(registry.problems, [])

  const bad = lane({ 'src/Again.stories.tsx': `export default { title: 'Foundations / Welcome' }\nexport const StartHere = () => null\n` })
  assert.match(stories(bad, ['index']).stdout, /\n1 problem: run stories\.mjs --check\n$/)
})

test('--check passes on the fixture, prints the files per root and the nodes no story reaches, and writes nothing', () => {
  const t = lane()
  const before = readdirSync(t.root).sort()
  const r = stories(t, ['--check'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^note: files per root: Foundations 1, Primitives 1, Patterns 2, Pages 2, Explorations 1\nnote: 1 live node no story reaches: src\/components\/Field\.tsx\nmassimo stories: ok \(7 files, 13 states\)\n$/)
  assert.deepEqual(readdirSync(t.root).sort(), before)
})

test('--check fails on a duplicate id, naming both exports', () => {
  const t = lane({ 'src/Again.stories.tsx': `export default { title: 'Foundations / Welcome' }\nexport const StartHere = () => null\n` })
  const r = stories(t, ['--check'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /massimo stories: 1 problem /)
  assert.match(r.stderr, /\[story-files\] src\/Welcome\.stories\.tsx: StartHere has the id foundations--welcome--start-here, which src\/Again\.stories\.tsx's StartHere has too/)
})

test('--check refuses an unknown lane, and has nothing to check on a lane that is not csf', () => {
  const odd = stories(lane({}, (c) => (c.stories.lane = 'gallery')), ['--check'])
  assert.equal(odd.status, 1)
  assert.match(odd.stderr, /stories\.lane is "gallery", which stories\.mjs does not know/)
  assert.equal(odd.stdout, '')

  const native = lane({}, (c) => (c.stories.lane = 'native'))
  const r = stories(native, ['--check'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /nothing to check, stories\.lane is "native"/)
  assert.equal(stories(native, ['index']).status, 1)
})

test('a node with no story never fails --check, and other graph rules do', () => {
  const t = lane()
  const csf = (problems) => () => ({ json: { storyLane: { lane: 'csf', files: 7, states: 13, problems } } })
  const none = { rule: 'no-story', file: 'src/components/Field.tsx', detail: 'no direct story' }
  const title = { rule: 'story-title', file: 'src/components/Card.stories.tsx', detail: 'the title has 3 parts' }
  const only = checkLane({ ...t, graph: csf([none]) })
  assert.deepEqual(only.problems, [])
  assert.ok(only.notes.includes('1 live node no story reaches: src/components/Field.tsx'))
  assert.deepEqual(checkLane({ ...t, graph: csf([none, title]) }).problems, [title])
  // A graph that does not read a csf lane (yet) adds nothing, and one that throws is a fault.
  assert.deepEqual(checkLane({ ...t, graph: () => ({ json: { storyLane: { problems: [title] } } }) }).problems, [])
  assert.deepEqual(checkLane({ ...t, graph: () => ({ json: {} }) }).problems, [])
  assert.deepEqual(checkLane({ ...t, graph: () => { throw new Error('stories.manifest is missing') } }).problems, [{ rule: 'graph', file: null, detail: 'stories.manifest is missing' }])
})

test('a registry problem is counted once, whether the graph carries it or not', () => {
  const t = lane({}, (c) => (c.stories.home = 'nowhere--at-all'))
  const home = (found) => found.problems.filter((p) => /stories\.home is nowhere--at-all/.test(p.detail))
  assert.equal(home(checkLane(t)).length, 1)
  assert.equal(home(checkLane({ ...t, graph: () => ({ json: {} }) })).length, 1)
  assert.equal(home(checkLane({ ...t, graph: () => { throw new Error('no graph') } })).length, 1)
})

test('--check carries the frozen design targets that changed', () => {
  const t = lane()
  const found = checkLane({ ...t, frozen: () => [{ file: 'src/explorations/NewHeader.stories.tsx', detail: 'it changed since it was pinned' }, 'another one'] })
  assert.deepEqual(found.problems.map((p) => [p.rule, p.file, p.detail]), [
    ['frozen', null, 'another one'],
    ['frozen', 'src/explorations/NewHeader.stories.tsx', 'it changed since it was pinned'],
  ])
})

test('--check reads the CSS layout: a base with @source not fails, an uncovered harness only warns', () => {
  const base = lane({ 'src/styles/base.css': '@import "tailwindcss";\n@source not "../x";\n', 'src/styles/app.css': `@import "./base.css";\n${EXCLUDE}` }, layout)
  const bad = stories(base, ['--check'])
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /\[css-base\] src\/styles\/base\.css: line 2 has @source not "\.\.\/x"/)

  const warn = lane({ 'src/styles/base.css': '@import "tailwindcss";\n', 'src/styles/app.css': '@import "./base.css";\n@source not "../components";\n' }, layout)
  const r = stories(warn, ['--check'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^warn {2}\[css-uncovered\] src\/pages\/review\/tableHarness\.tsx: only stories use it, but src\/styles\/app\.css does not exclude it/m)
  assert.match(r.stdout, /massimo stories: ok/)

  const app = lane({ 'src/styles/base.css': '@import "tailwindcss";\n', 'src/styles/app.css': `@import "./base.css";\n${EXCLUDE}`, 'src/fixtures/rows.ts': 'export const rows = []\n', 'src/App.tsx': `import { rows } from './fixtures/rows'\nexport const App = () => rows\n` }, (c) => {
    layout(c)
    c.stories.storyOnly = ['src/fixtures/**']
  })
  const refused = stories(app, ['--check'])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /\[css-app-import\] src\/App\.tsx: it imports src\/fixtures\/rows\.ts, which only stories use/)
})

test('--check compares the scaffold\'s type file with the registry\'s format, and skips it when there is none', () => {
  assert.equal(typesLine(1), '// massimo lane types, format 1')
  const same = lane({ 'src/stories/massimo.d.ts': `${typesLine(1)}\ndeclare module 'virtual:massimo-stories' {}\n` })
  assert.equal(stories(same, ['--check']).status, 0)
  const older = lane({ 'src/stories/massimo.d.ts': `// massimo lane types, format 0\ndeclare module 'virtual:massimo-stories' {}\n` })
  const r = stories(older, ['--check'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /\[scaffold\] src\/stories\/massimo\.d\.ts: its first line is "\/\/ massimo lane types, format 0", but this plugin writes "\/\/ massimo lane types, format 1"; update the lane scaffold/)
  assert.equal(stories(lane(), ['--check']).status, 0)
})

// ── leak ─────────────────────────────────────────────────────────────────────

const write = (root, files) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
}
const STORY_CLASS = `.w-\\[13\\.37rem\\] { width: 13.37rem }`
const APP_CSS = `.p-4 { padding: 1rem }\n.flex { display: flex }\n`

// A fixture with a story that uses w-[13.37rem] and an app file that uses p-4 and flex,
// with an app build and a lane build as folders.
function builds({ appCss = APP_CSS, laneCss = `${APP_CSS}${STORY_CLASS}\n` } = {}) {
  const t = lane({
    'src/Extra.stories.tsx': `export default { title: 'Foundations / Extra' }\nexport const Wide = () => <div className="w-[13.37rem] p-4" />\n`,
    'src/App.tsx': `export const App = () => <main className="p-4 flex" />\n`,
    'build/app/assets/app.css': appCss,
    'build/lane/assets/lane.css': laneCss,
  })
  return { ...t, app: join(t.root, 'build/app'), laneDir: join(t.root, 'build/lane') }
}
const ignored = () => true
const leak = (b, extra = {}) => leakReport({ root: b.root, config: b.config, files: b.files, app: b.app, lane: b.laneDir, isIgnored: ignored, ...extra })

test('leak with a probe wants the class in the lane\'s CSS and not the app\'s', () => {
  const clean = leak(builds(), { probe: 'w-[13.37rem]' })
  assert.deepEqual(clean, { ok: true, lines: ['ok: w-[13.37rem] is in the lane\'s CSS and not the app\'s'] })
  const leaked = leak(builds({ appCss: `${APP_CSS}${STORY_CLASS}\n` }), { probe: 'w-[13.37rem]' })
  assert.equal(leaked.ok, false)
  assert.equal(leaked.lines[0], "leak: w-[13.37rem] is in the app's CSS")
  const missing = leak(builds(), { probe: 'h-99' })
  assert.deepEqual(missing, { ok: false, lines: ["the class h-99 is not in the lane's CSS, so this probe proves nothing"] })
})

test('leak without a probe checks every class only stories use, escaped selectors included', () => {
  assert.equal(leak(builds()).ok, true)
  const b = builds({ appCss: `${APP_CSS}${STORY_CLASS}\n` })
  const r = leak(b)
  assert.equal(r.ok, false)
  assert.equal(r.lines[0], "leak: 1 class only stories use is in the app's CSS: w-[13.37rem]")
  // p-4 is in the story too, but an app file uses it, so it is not a leak.
  assert.ok(!r.lines[0].includes('p-4'))
})

test('a leak prints the edit that keeps the exclusions out of the base CSS', () => {
  const b = builds({ appCss: `${APP_CSS}${STORY_CLASS}\n` })
  b.config.stories.appCss = { base: 'src/styles/index.css', entry: 'src/styles/app.css' }
  const r = leak(b)
  const edit = r.lines.slice(r.lines.indexOf('') + 1)
  assert.equal(edit[0], 'The lane imports src/styles/index.css, so the app keeps story-only files out of its CSS in an entry of its own (layout A):')
  assert.equal(edit[1], '  1. Make src/styles/app.css start with @import "./index.css"; then the exclusions:')
  assert.ok(edit.includes('    @source not "../pages/review/tableHarness.tsx";'))
  assert.ok(edit.includes('    @source not "../**/*.stories.{tsx,ts}";'))
  assert.equal(edit.at(-1), "  3. Keep @source not out of src/styles/index.css and the sheets it imports: there it would drop the lane's own classes too.")
})

test('with no entry CSS set, the edit proposes app.css beside the base, with paths written from there', () => {
  const config = deepMerge(structuredClone(DEFAULTS), { stories: { include: ['src/**/*.stories.tsx'], appCss: { base: 'src/styles/index.css', entry: null } } })
  assert.deepEqual(layoutEdit(config, ['src/pages/review/tableHarness.tsx', 'tools/mail/preview.ts']), [
    'The lane imports src/styles/index.css, so the app keeps story-only files out of its CSS in an entry of its own (layout A):',
    '  1. Create src/styles/app.css with @import "./index.css"; then the exclusions:',
    '    @source not "../pages/review/tableHarness.tsx";',
    '    @source not "../../tools/mail/preview.ts";',
    '    @source not "../**/*.stories.tsx";',
    "  2. Point the app's main module at src/styles/app.css instead of src/styles/index.css.",
    "  3. Keep @source not out of src/styles/index.css and the sheets it imports: there it would drop the lane's own classes too.",
    '  4. Set stories.appCss.entry to "src/styles/app.css", so stories.mjs --check reads the layout.',
  ])
  // With no base CSS named, it cannot write paths from an entry, so it asks for the base first.
  const none = layoutEdit(deepMerge(structuredClone(DEFAULTS), {}), ['src/x.ts'])
  assert.equal(none[1], "  1. Set stories.appCss.base to the CSS file the app's main module imports, and run leak again for the exact edit.")
  assert.equal(none[3], '    src/x.ts')
})

test('a class the app\'s own CSS, docs or tests hold is no leak, and neither is one in a file git ignores', () => {
  const both = `${APP_CSS}${STORY_CLASS}\n.btn-x { color: red }\n.h-77 { height: 1px }\n.gap-9 { gap: 1px }\n`
  const b = builds({ appCss: both, laneCss: both })
  write(b.root, {
    'src/Tall.stories.tsx': `export default { title: 'Foundations / Tall' }\nexport const Tall = () => <div className="btn-x h-77 gap-9" />\n`,
    'src/styles/base.css': '@import "tailwindcss";\n.btn-x { color: red }\n',
    'docs/sizes.md': 'Use `h-77` for the tall card.\n',
    'src/App.test.tsx': `expect(el).toHaveClass('gap-9')\n`,
  })
  b.files.push('src/Tall.stories.tsx', 'src/styles/base.css', 'docs/sizes.md', 'src/App.test.tsx')
  assert.equal(leak(b).lines[0], "leak: 1 class only stories use is in the app's CSS: w-[13.37rem]")
  // The story's own class sits in a doc too, but git ignores that doc.
  write(b.root, { 'notes/draft.md': 'w-[13.37rem]\n' })
  b.files.push('notes/draft.md')
  assert.equal(leak(b, { ignoredFiles: () => new Set(['notes/draft.md']) }).lines[0], "leak: 1 class only stories use is in the app's CSS: w-[13.37rem]")
  assert.equal(leak(b).lines[0], "ok: no class only stories use is in the app's CSS")
})

// The lane's scaffold as the recipe writes it, in the folder of the HTML entry's module script.
const SCAFFOLD = {
  'stories.html': '<!doctype html>\n<html><body><div id="root"></div><script type="module" src="/src/stories/main.tsx"></script></body></html>\n',
  'src/stories/main.tsx': `import Shell from './Shell'\nimport Canvas from './Canvas'\nexport { Shell, Canvas }\n`,
  'src/stories/Shell.tsx': 'export default function Shell() { return <nav className="lane-nav" /> }\n',
  'src/stories/Canvas.tsx': 'export default function Canvas() { return null }\n',
  'src/stories/story.ts': 'export type Story = () => null\n',
  'src/stories/frame.tsx': 'export default function Frame({ children }) { return <div className="story-surface">{children}</div> }\n',
  'src/stories/stories.extra.css': '.story-page { background: white }\n',
}

test('the lane\'s scaffold folder is the lane\'s: a class only the frame or its CSS uses is a leak, and the edit excludes the folder', () => {
  const both = `${APP_CSS}.story-surface { padding: 0 }\n.story-page { background: white }\n`
  const b = builds({ appCss: both, laneCss: both })
  write(b.root, SCAFFOLD)
  b.files.push(...Object.keys(SCAFFOLD))
  b.config.stories.frame = 'src/stories/frame.tsx'
  b.config.stories.appCss = { base: 'src/styles/index.css', entry: 'src/styles/app.css' }
  const r = leak(b)
  assert.equal(r.ok, false)
  assert.equal(r.lines[0], "leak: 2 classes only stories use are in the app's CSS: story-page, story-surface")
  const edit = r.lines.slice(r.lines.indexOf('') + 1)
  assert.ok(edit.includes('    @source not "../stories";'), edit.join('\n'))
  assert.ok(!edit.some((l) => /"\.\.\/stories\/[^*]/.test(l)), 'no scaffold file on a line of its own')
  assert.ok(edit.indexOf('    @source not "../pages/review/tableHarness.tsx";') < edit.indexOf('    @source not "../stories";'))
})

test('a leak of several classes counts them in words', () => {
  const both = `${APP_CSS}${STORY_CLASS}\n.h-77 { height: 1px }\n`
  const b = builds({ appCss: both, laneCss: both })
  write(b.root, { 'src/Tall.stories.tsx': `export default { title: 'Foundations / Tall' }\nexport const Tall = () => <div className="h-77" />\n` })
  b.files.push('src/Tall.stories.tsx')
  assert.equal(leak(b).lines[0], "leak: 2 classes only stories use are in the app's CSS: h-77, w-[13.37rem]")
})

// A package's prebuilt sheet with every utility under the package's own
// class, and a component library's compound, as an app build carries them.
const PACKAGE = '.widget .mt-10{margin-top:2.5rem}.widget .w-24{width:6rem}.widget{display:block}\n'
const COMPOUND = ':is(.tooltip.tooltip-open,.tooltip:hover)>.tooltip-content{opacity:1}.tooltip{position:relative}\n'

test('a class the app\'s CSS names only under a package\'s class or in a component\'s compound is no leak', () => {
  const b = builds({ appCss: `${APP_CSS}${PACKAGE}${COMPOUND}`, laneCss: `${APP_CSS}.mt-10{margin-top:2.5rem}.w-24{width:6rem}\n${PACKAGE}${COMPOUND}` })
  write(b.root, {
    'src/Tip.stories.tsx': `export default { title: 'Foundations / Tip' }\nexport const Open = () => <div className="tooltip tooltip-open mt-10 w-24" />\n`,
    'src/Hint.tsx': `export const Hint = () => <span className="tooltip" />\n`,
  })
  b.files.push('src/Tip.stories.tsx', 'src/Hint.tsx')
  assert.deepEqual(leak(b), { ok: true, lines: ["ok: no class only stories use is in the app's CSS"] })
  assert.deepEqual(leak(b, { probe: 'w-24' }), { ok: true, lines: ["ok: w-24 is in the lane's CSS and not the app's"] })
  // A rule of the app's own still leaks, inside @layer and @media too.
  write(b.root, { 'build/app/assets/more.css': '@layer utilities{@media (min-width:40rem){.w-24{width:6rem}}}\n' })
  assert.equal(leak(b).lines[0], "leak: 1 class only stories use is in the app's CSS: w-24")
  assert.equal(leak(b, { probe: 'w-24' }).lines[0], "leak: w-24 is in the app's CSS")
})

test('a class with a variant the app\'s CSS names only under a package\'s class is no leak, and --before lists it as dropped', () => {
  const HOVER = String.raw`.hover\:opacity-90:hover{opacity:.9}`
  const b = builds({ appCss: `${APP_CSS}.widget ${HOVER}.widget{display:block}\n`, laneCss: `${APP_CSS}${HOVER}\n` })
  write(b.root, { 'src/Fade.stories.tsx': `export default { title: 'Foundations / Fade' }\nexport const Hover = () => <div className="hover:opacity-90" />\n` })
  b.files.push('src/Fade.stories.tsx')
  assert.deepEqual(leak(b), { ok: true, lines: ["ok: no class only stories use is in the app's CSS"] })
  assert.deepEqual(leak(b, { probe: 'hover:opacity-90' }), { ok: true, lines: ["ok: hover:opacity-90 is in the lane's CSS and not the app's"] })
  write(b.root, { 'build/before/assets/app.css': `${APP_CSS}${HOVER}\n`, 'src/Fade.tsx': `export const Fade = () => <a className="hover:opacity-90" />\n` })
  b.files.push('src/Fade.tsx')
  assert.deepEqual(leak(b, { before: join(b.root, 'build/before') }), {
    ok: false,
    lines: ["dropped: 1 class the build before had is not in the app's CSS", '  app code uses 1: hover:opacity-90', "lost: the app's CSS no longer has 1 class an app file uses: hover:opacity-90 (src/Fade.tsx)"],
  })
})

const REVIEW = '  review the list: a class name app code builds at run time is no word in its file, so this check cannot see that the app needs it'

test('leak --before fails when the app\'s CSS lost a class an app file uses', () => {
  const b = builds({ appCss: '.flex { display: flex }\n' })
  write(b.root, { 'build/before/assets/app.css': APP_CSS })
  const r = leak(b, { before: join(b.root, 'build/before') })
  assert.equal(r.ok, false)
  assert.deepEqual(r.lines, [
    "dropped: 1 class the build before had is not in the app's CSS",
    '  app code uses 1: p-4',
    "lost: the app's CSS no longer has 1 class an app file uses: p-4 (src/App.tsx)",
  ])
  // A class that no app file uses passes, and is still listed for review.
  write(b.root, { 'build/before/assets/app.css': `${APP_CSS}.unused { color: red }\n`, 'build/app/assets/app.css': APP_CSS })
  assert.deepEqual(leak(b, { before: join(b.root, 'build/before') }), {
    ok: true,
    lines: [
      "dropped: 1 class the build before had is not in the app's CSS",
      '  no file git keeps names 1: unused',
      REVIEW,
      "ok: the app's CSS lost no class an app file uses",
    ],
  })
  // --before is a check of its own: the scan by words runs without it, or --probe with it.
  write(b.root, { 'build/app/assets/app.css': `${APP_CSS}${STORY_CLASS}\n`, 'build/before/assets/app.css': APP_CSS })
  assert.deepEqual(leak(b, { before: join(b.root, 'build/before') }), {
    ok: true,
    lines: ["dropped: the app's CSS has every class the build before had", "ok: the app's CSS lost no class an app file uses"],
  })
  assert.equal(leak(b, { before: join(b.root, 'build/before'), probe: 'w-[13.37rem]' }).lines[0], "leak: w-[13.37rem] is in the app's CSS")
})

test('leak --before lists every class the app\'s CSS dropped, by where its name occurs', () => {
  const b = builds({ appCss: '.flex { display: flex }\n' })
  write(b.root, {
    'build/before/assets/app.css': `${APP_CSS}${STORY_CLASS}\n.h-77 { height: 1px }\n.gap-9 { gap: 1px }\n.btn-x { color: red }\n.gap-3 { gap: 1px }\n`,
    'src/Tall.stories.tsx': `export default { title: 'Foundations / Tall' }\nexport const Tall = () => <div className="h-77" />\n`,
    'docs/sizes.md': 'Use `btn-x` for the tall card.\n',
    // A class name app code builds at run time is a word in no file.
    'src/Grid.tsx': 'export const Grid = ({ n }: { n: number }) => <div className={`gap-${n}`} />\n',
  })
  b.files.push('src/Tall.stories.tsx', 'docs/sizes.md', 'src/Grid.tsx')
  const r = leak(b, { before: join(b.root, 'build/before') })
  assert.equal(r.ok, false)
  assert.deepEqual(r.lines, [
    "dropped: 6 classes the build before had are not in the app's CSS",
    '  app code uses 1: p-4',
    '  no file git keeps names 2: gap-3, gap-9',
    '  only files that are not app code, such as docs, tests and stylesheets, name 1: btn-x',
    '  only story files and story-only modules name 2: h-77, w-[13.37rem]',
    REVIEW,
    "lost: the app's CSS no longer has 1 class an app file uses: p-4 (src/App.tsx)",
  ])
})

test('leak --before finds a class whose square brackets hold a quote, an = or a > in the file that names it', () => {
  const b = builds()
  write(b.root, {
    'build/before/assets/app.css': [
      APP_CSS,
      String.raw`.\[\&\>div\]\:static>div{position:static}.data-\[state\=open\]\:block[data-state=open]{display:block}`,
      String.raw`.has-\[\[data-open\=true\]\]\:flex:has([data-open=true]){display:flex}.before\:content-\[\'\'\]:before{content:var(--tw-content);--tw-content:""}`,
    ].join('\n'),
    'src/Sticky.stories.tsx': `export default { title: 'Foundations / Sticky' }\nexport const Bar = () => <div className="[&>div]:static data-[state=open]:block" />\n`,
    'src/Panel.tsx': `export const Panel = () => <div className={\`has-[[data-open=true]]:flex before:content-['']\`} />\n`,
  })
  b.files.push('src/Sticky.stories.tsx', 'src/Panel.tsx')
  const r = leak(b, { before: join(b.root, 'build/before') })
  assert.equal(r.ok, false)
  assert.deepEqual(r.lines, [
    "dropped: 4 classes the build before had are not in the app's CSS",
    "  app code uses 2: before:content-[''], has-[[data-open=true]]:flex",
    '  only story files and story-only modules name 2: [&>div]:static, data-[state=open]:block',
    REVIEW,
    "lost: the app's CSS no longer has 2 classes an app file uses: before:content-[''] (src/Panel.tsx), has-[[data-open=true]]:flex (src/Panel.tsx)",
  ])
})

test('leak --before lists a class whose own rule the app\'s CSS lost, though another sheet still names it', () => {
  const b = builds({ appCss: `${APP_CSS}${PACKAGE}${COMPOUND}` })
  write(b.root, {
    'build/before/assets/app.css': `${APP_CSS}.mt-10{margin-top:2.5rem}\n`,
    'build/before/assets/widget.css': `${PACKAGE}${COMPOUND}`,
    'src/Spaced.tsx': `export const Spaced = () => <section className="mt-10 tooltip tooltip-open" />\n`,
  })
  b.files.push('src/Spaced.tsx')
  assert.deepEqual(leak(b, { before: join(b.root, 'build/before') }), {
    ok: false,
    lines: ["dropped: 1 class the build before had is not in the app's CSS", '  app code uses 1: mt-10', "lost: the app's CSS no longer has 1 class an app file uses: mt-10 (src/Spaced.tsx)"],
  })
})

test('leak refuses a folder git does not ignore, and a path that is not a folder', () => {
  const b = builds()
  const seen = []
  const r = leak(b, { isIgnored: (root, dir) => (seen.push(dir), dir !== b.laneDir) })
  assert.equal(r.ok, false)
  assert.deepEqual(r.lines, ['--lane build/lane is not ignored by git, so a build could reach a commit; add it to .gitignore and run the check again'])
  assert.deepEqual(seen, [b.app, b.laneDir])
  assert.equal(leak(b, { isIgnored: () => null }).lines[0].includes('not a folder git can check'), true)
  assert.deepEqual(leak(b, { app: join(b.root, 'nope') }).lines, [`--app ${join(b.root, 'nope')} is not a folder`])
})

test('gitIgnored asks git, and the leak command refuses an unignored folder end to end', () => {
  const b = builds()
  const git = (...args) => spawnSync('git', args, { cwd: b.root, encoding: 'utf8' })
  assert.equal(git('init', '-q').status, 0)
  writeFileSync(join(b.root, '.gitignore'), 'build/app/\n')
  assert.equal(gitIgnored(b.root, b.app), true)
  assert.equal(gitIgnored(b.root, b.laneDir), false)
  assert.equal(gitIgnored(b.root, join(b.root, '..')), true, 'a folder outside the repo cannot reach a commit')

  const args = ['leak', '--app', b.app, '--lane', b.laneDir, '--probe', 'w-[13.37rem]']
  const refused = stories(b, args)
  assert.equal(refused.status, 1)
  assert.match(refused.stdout, /--lane build\/lane is not ignored by git/)
  writeFileSync(join(b.root, '.gitignore'), 'build/\n')
  const ok = stories(b, args)
  assert.equal(ok.status, 0, ok.stdout)
  assert.match(ok.stdout, /^ok: w-\[13\.37rem\] is in the lane's CSS and not the app's\n$/)
  assert.equal(stories(b, ['leak', '--app', b.app]).status, 1)
})

test('gitIgnored reads a folder the same through a symlink and from a root below the repo\'s top', () => {
  const b = builds()
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: b.root }).status, 0)
  writeFileSync(join(b.root, '.gitignore'), 'build/lane/\n')
  const link = join(dirname(b.root), 'link')
  symlinkSync(b.root, link)
  for (const [root, dir] of [
    [link, b.app],
    [b.root, join(link, 'build/app')],
    [link, join(link, 'build/app')],
    [join(b.root, 'src'), b.app],
  ]) {
    assert.equal(gitIgnored(root, dir), false, `${root} ${dir}`)
  }
  assert.equal(gitIgnored(link, join(link, 'build/lane')), true)
  assert.equal(gitIgnored(join(b.root, 'src'), join(link, 'build/lane')), true)

  // End to end, with the root and the folders named through the symlink.
  const refused = run('stories', { root: link, project: b.ctx.project }, ['leak', '--app', join(link, 'build/app'), '--lane', join(link, 'build/lane'), '--probe', 'w-[13.37rem]'])
  assert.equal(refused.status, 1)
  assert.match(refused.stdout, /^--app build\/app is not ignored by git/)
})
