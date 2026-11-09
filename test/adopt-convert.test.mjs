// adopt.mjs convert stories on the csf-lane fixture: one record per story
// file keyed by its path, the frozen design targets, the redirect map and the
// removal patch, and the check that proves a converted repo changed only in
// the specifier of its type imports. Each test works on its own scratch copy.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { LEGACY_TYPES_FILE, checkTypesFile, conversionRecords, frozenCandidates, frozenProblems, refreeze, removalEdits, removalPatch } from '../scripts/lib/convert.mjs'
import { compileGlobs, walk } from '../scripts/lib/glob.mjs'
import { laneRegistry, normalHash } from '../scripts/lib/lane.mjs'
import { DEFAULTS, deepMerge } from '../scripts/lib/project.mjs'
import { readCsf } from '../scripts/lib/stories-read.mjs'
import { SCRIPTS, scratch } from './helpers.mjs'

const contexts = []
after(() => contexts.forEach((c) => c.cleanup()))
const fresh = () => {
  const ctx = scratch('csf-lane')
  contexts.push(ctx)
  return ctx
}
const env = { ...process.env, MASSIMO_TODAY: '2026-11-09' }
const adopt = (ctx, args) => spawnSync(process.execPath, [join(SCRIPTS, 'adopt.mjs'), ...args, '--root', ctx.root, '--project-dir', ctx.project], { encoding: 'utf8', env })
const convert = (ctx, ...args) => adopt(ctx, ['convert', 'stories', ...args])
const work = (ctx, ...parts) => join(ctx.project, 'adopt', 'stories', 'work', ...parts)
const text = (ctx, file) => readFileSync(join(ctx.root, file), 'utf8')
const put = (ctx, file, body) => {
  mkdirSync(dirname(join(ctx.root, file)), { recursive: true })
  writeFileSync(join(ctx.root, file), body)
}
const record = (ctx, file) => JSON.parse(readFileSync(work(ctx, 'records', `${file}.json`), 'utf8'))
const setConfig = (ctx, patch) => {
  const path = join(ctx.root, 'massimo.config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...config, ...patch, stories: { ...config.stories, ...patch.stories } }, null, 2))
}
const EXPLORATION = 'src/explorations/NewHeader.stories.tsx'

// What `git apply` does with removal.patch, done from removal.json: each
// specifier replaced at its offsets, and each created file written.
function applyRemoval(ctx) {
  const removal = JSON.parse(readFileSync(work(ctx, 'removal.json'), 'utf8'))
  for (const e of removal.edits.filter((x) => !x.create).sort((a, b) => b.start - a.start)) {
    const body = text(ctx, e.file)
    assert.equal(body.slice(e.start, e.end), e.before, e.file)
    put(ctx, e.file, body.slice(0, e.start) + e.after + body.slice(e.end))
  }
  for (const e of removal.edits.filter((x) => x.create)) put(ctx, e.file, e.text)
  return removal
}

test('one record per story file, keyed by its path, with the files that share a title kept apart', () => {
  const ctx = fresh()
  const r = convert(ctx)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^massimo adopt convert stories: 7 records \(13 states\)/)
  const files = walk(join(work(ctx, 'records'))).sort()
  assert.deepEqual(files, [
    'src/Welcome.stories.tsx.json',
    'src/components/Button.stories.tsx.json',
    'src/components/Card.stories.tsx.json',
    'src/components/gauge/Editor.stories.tsx.json',
    'src/explorations/NewHeader.stories.tsx.json',
    'src/pages/review/Compare.stories.tsx.json',
    'src/pages/review/Summary.stories.tsx.json',
  ])
  const [compare, summary] = ['Compare', 'Summary'].map((n) => record(ctx, `src/pages/review/${n}.stories.tsx`))
  assert.equal(compare.slug, summary.slug)
  assert.deepEqual(compare.states.map((s) => s.id), ['pages--review--summary--side-by-side'])
  assert.deepEqual(summary.states.map((s) => s.id), ['pages--review--summary--overview', 'pages--review--summary--state-b--admin'])
  const button = record(ctx, 'src/components/Button.stories.tsx')
  assert.equal(button.format, 1)
  assert.deepEqual(button.typeImport, { spec: '@ladle/react', names: ['Story'] })
  assert.equal(button.states.find((s) => s.export === 'LogIn').storyName, 'Log-In button')
  assert.deepEqual(button.states.find((s) => s.export === 'LogIn').meta, { width: 375 })
  // The normal hash is the file's with its type import's specifier blanked.
  const body = text(ctx, 'src/components/Button.stories.tsx')
  assert.equal(button.normalHash, normalHash(body, readCsf(body, 'x.stories.tsx').typeImports[0]))
  assert.match(button.states[0].spanHash, /^[0-9a-f]{64}$/)
  // The hand-pass lines: args kept at run time, and parameters the canvas does not read.
  assert.deepEqual(button.handPass.map((h) => [h.kind, h.story]), [['args', 'Sized']])
  assert.deepEqual(summary.handPass.map((h) => [h.kind, h.story]), [['parameters', 'Overview']])
  assert.match(r.stdout, /Files that keep args or argTypes at run time, for a hand pass:\n {2}src\/components\/Button\.stories\.tsx\n/)
  assert.match(r.stdout, /Stories that set parameters[^\n]*\n {2}src\/pages\/review\/Summary\.stories\.tsx {2}Overview\n/)
})

test('the work folder ignores itself, and the ledger and the redirects are written', () => {
  const ctx = fresh()
  assert.equal(convert(ctx).status, 0)
  assert.equal(readFileSync(work(ctx, '.gitignore'), 'utf8'), '*\n')
  const redirects = JSON.parse(readFileSync(join(ctx.project, 'adopt', 'stories', 'redirects.json'), 'utf8'))
  assert.equal(redirects.format, 1)
  assert.equal(redirects.ids, 'ladle')
  assert.equal(redirects.redirects['primitives--actions--button--log--in-button'], '/stories/primitives--actions--button/log--in-button')
  assert.equal(Object.keys(redirects.redirects).length, 13)
})

test('under export ids, the redirects map the ids Ladle gave, and --ids-from reads them from a meta.json', () => {
  const ctx = fresh()
  setConfig(ctx, { stories: { ids: 'export' } })
  assert.equal(convert(ctx).status, 0)
  const redirects = JSON.parse(readFileSync(join(ctx.project, 'adopt', 'stories', 'redirects.json'), 'utf8'))
  assert.equal(redirects.ids, 'export')
  assert.equal(redirects.redirects['primitives--actions--button--log--in-button'], '/stories/primitives--actions--button/log-in')
  // An id from a Ladle build that no story takes now maps to nothing.
  writeFileSync(join(ctx.root, 'meta.json'), JSON.stringify({ stories: { 'primitives--actions--button--primary': { filePath: 'src/components/Button.stories.tsx', namedExport: 'Primary' }, 'gone--story': { filePath: 'src/Gone.stories.tsx', namedExport: 'Gone' } } }))
  assert.equal(convert(ctx, '--ids-from', 'meta.json').status, 0)
  const again = JSON.parse(readFileSync(join(ctx.project, 'adopt', 'stories', 'redirects.json'), 'utf8'))
  assert.deepEqual(again.redirects, { 'gone--story': null, 'primitives--actions--button--primary': '/stories/primitives--actions--button/primary' })
})

test('a design target is proposed, confirmed by config --write, and left out of the patch', () => {
  const ctx = fresh()
  const first = convert(ctx)
  assert.match(first.stdout, /1 frozen file \(0 pinned, 1 to confirm\)/)
  assert.match(first.stdout, /Frozen candidates[^\n]*\n {2}src\/explorations\/NewHeader\.stories\.tsx {2}\(exploration\)\n/)
  assert.equal(JSON.parse(readFileSync(work(ctx, 'removal.json'), 'utf8')).edits.filter((e) => e.file === EXPLORATION).length, 1)
  const proposed = JSON.parse(readFileSync(join(ctx.project, 'adopt', 'config.proposed.json'), 'utf8'))
  assert.deepEqual(proposed.stories.frozen, [{ file: EXPLORATION, sha256: proposed.stories.frozen[0].sha256, since: '2026-11-09' }])
  const written = adopt(ctx, ['config', '--write'])
  assert.equal(written.status, 0, written.stderr)
  assert.equal(JSON.parse(readFileSync(join(ctx.root, 'massimo.config.json'), 'utf8')).stories.frozen[0].file, EXPLORATION)
  const second = convert(ctx)
  assert.match(second.stdout, /1 frozen file \(1 pinned, 0 to confirm\)/)
  const removal = JSON.parse(readFileSync(work(ctx, 'removal.json'), 'utf8'))
  assert.equal(removal.edits.filter((e) => !e.create).length, 6)
  assert.ok(!removal.edits.some((e) => e.file === EXPLORATION))
  // The frozen file still imports the tool, so the patch declares its module.
  assert.deepEqual(removal.edits.filter((e) => e.create).map((e) => e.file), [LEGACY_TYPES_FILE])
  assert.match(readFileSync(work(ctx, 'removal.patch'), 'utf8'), /\+declare module '@ladle\/react' \{/)
  assert.equal(record(ctx, EXPLORATION).frozen.since, '2026-11-09')
})

test('after the patch is applied, --check passes, and the frozen file is byte for byte as it was', () => {
  const ctx = fresh()
  convert(ctx)
  assert.equal(adopt(ctx, ['config', '--write']).status, 0)
  convert(ctx)
  const frozenBefore = text(ctx, EXPLORATION)
  const before = convert(ctx, '--check')
  assert.equal(before.status, 0, before.stdout)
  const removal = applyRemoval(ctx)
  assert.equal(removal.tool, '@ladle/react')
  assert.match(text(ctx, 'src/components/Button.stories.tsx'), /^import type \{ Story \} from '\.\.\/stories\/story'\nimport \{ Button \}/)
  assert.equal(text(ctx, EXPLORATION), frozenBefore)
  assert.match(text(ctx, LEGACY_TYPES_FILE), /^\/\/ The story types that files still importing @ladle\/react use\./)
  const r = convert(ctx, '--check')
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /^massimo adopt convert stories --check: 7 records against the files now; 1 frozen file against 1 pinned sha256\./)
  assert.match(r.stdout, /Passes: every file is unchanged outside its type import/)
})

test('removal.patch applies with git apply and leaves the same files as the edits', (t) => {
  const ctx = fresh()
  convert(ctx)
  assert.equal(adopt(ctx, ['config', '--write']).status, 0)
  convert(ctx)
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git is not installed')
  const r = spawnSync('git', ['apply', work(ctx, 'removal.patch')], { cwd: ctx.root, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(ctx.root, LEGACY_TYPES_FILE)))
  assert.equal(convert(ctx, '--check').status, 0)
  assert.match(text(ctx, 'src/Welcome.stories.tsx'), /^import type \{ Story \} from '\.\/stories\/story'\n/)
})

test('an edit outside the type import fails --check and names the export that moved', () => {
  const ctx = fresh()
  convert(ctx)
  applyRemoval(ctx)
  // A helper above every export.
  const file = 'src/components/Button.stories.tsx'
  const body = text(ctx, file)
  put(ctx, file, body.replace("import { Button } from './Button'\n", "import { Button } from './Button'\nconst helper = 1\n"))
  const helper = convert(ctx, '--check')
  assert.equal(helper.status, 1)
  assert.match(helper.stdout, new RegExp(`${file}: it changed outside its type import, outside every export`))
  assert.match(helper.stdout, /Fails: 1 file changed/)
  // An export body.
  put(ctx, file, body.replace('<Button>Save</Button>', '<Button>Store</Button>'))
  const moved = convert(ctx, '--check')
  assert.equal(moved.status, 1)
  assert.match(moved.stdout, new RegExp(`${file}: it changed outside its type import: Primary changed\\n`))
  // The file as it was passes again.
  put(ctx, file, body)
  assert.equal(convert(ctx, '--check').status, 0)
  // A file that is gone is a change too.
  rmSync(join(ctx.root, 'src/Welcome.stories.tsx'))
  const gone = convert(ctx, '--check')
  assert.equal(gone.status, 1)
  assert.match(gone.stdout, /src\/Welcome\.stories\.tsx: it is gone/)
  // An emptied one is a change as well.
  put(ctx, 'src/Welcome.stories.tsx', '')
  assert.equal(convert(ctx, '--check').status, 1)
})

test('a frozen file passes while it matches, fails when it changes, passes when it is gone, and --refreeze pins it again', () => {
  const ctx = fresh()
  convert(ctx)
  assert.equal(adopt(ctx, ['config', '--write']).status, 0)
  convert(ctx)
  const pinned = () => JSON.parse(readFileSync(join(ctx.root, 'massimo.config.json'), 'utf8')).stories.frozen[0]
  const first = pinned().sha256
  const body = text(ctx, EXPLORATION)
  assert.equal(convert(ctx, '--check').status, 0)
  put(ctx, EXPLORATION, `${body}// a note\n`)
  const changed = convert(ctx, '--check')
  assert.equal(changed.status, 1)
  assert.match(changed.stdout, new RegExp(`${EXPLORATION}: it is a design target pinned since 2026-11-09 and it has changed`))
  // Pinned again, it passes, and the config holds the new sha256.
  const pin = convert(ctx, '--refreeze', EXPLORATION)
  assert.equal(pin.status, 0, pin.stderr)
  assert.match(pin.stdout, new RegExp(`^${EXPLORATION}: pinned ${first} -> [0-9a-f]{64}, since 2026-11-09\\n`))
  assert.notEqual(pinned().sha256, first)
  assert.equal(convert(ctx, '--check').status, 0)
  // A retired design target is no problem.
  rmSync(join(ctx.root, EXPLORATION))
  assert.equal(convert(ctx, '--check').status, 0)
  // A file outside the list cannot be pinned.
  const other = convert(ctx, '--refreeze', 'src/Welcome.stories.tsx')
  assert.equal(other.status, 1)
  assert.match(other.stderr, /src\/Welcome\.stories\.tsx is not in stories\.frozen/)
})

test('a record in a newer format is refused: update massimo', () => {
  const ctx = fresh()
  convert(ctx)
  const path = work(ctx, 'records', 'src', 'Welcome.stories.tsx.json')
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), format: 2 }))
  for (const args of [[], ['--check']]) {
    const r = convert(ctx, ...args)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /format 2.*update massimo/)
  }
})

test('--check without records, and convert without the csf lane, say what to run first', () => {
  const ctx = fresh()
  const none = convert(ctx, '--check')
  assert.equal(none.status, 1)
  assert.match(none.stderr, /no records under .*run .*convert stories first/)
  setConfig(ctx, { stories: { lane: 'native' } })
  const native = convert(ctx)
  assert.equal(native.status, 1)
  assert.match(native.stderr, /convert stories is for the csf lane: stories\.lane is "native"/)
  assert.equal(adopt(ctx, ['convert', 'tokens']).status, 1)
})

test('--types names the types file; one with a relative import, or a value, is refused', () => {
  const ctx = fresh()
  put(ctx, 'src/lane/types.ts', "import type { ReactNode } from 'react'\nexport type Story = () => ReactNode\nexport type StoryDefault = { title: string }\n")
  const ok = convert(ctx, '--types', 'src/lane/types.ts')
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(readFileSync(work(ctx, 'removal.patch'), 'utf8'), /\+import type \{ Story \} from '\.\/lane\/types'/)
  assert.match(readFileSync(work(ctx, 'removal.patch'), 'utf8'), /\+import type \{ Story \} from '\.\.\/lane\/types'/)
  put(ctx, 'src/lane/types.ts', "import type { Base } from './base'\nexport type Story = Base\n")
  const relative = convert(ctx, '--types', 'src/lane/types.ts')
  assert.equal(relative.status, 1)
  assert.match(relative.stderr, /import type \{ Base \} from '\.\/base' is a relative import/)
  put(ctx, 'src/lane/types.ts', "export const mode = 1\nexport type Story = () => null\n")
  const value = convert(ctx, '--types', 'src/lane/types.ts')
  assert.equal(value.status, 1)
  assert.match(value.stderr, /export const mode = 1 is neither an import type line nor an export type declaration/)
  const missing = convert(ctx, '--types', 'src/lane/none.ts')
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /--types src\/lane\/none\.ts is not there/)
})

test('a file that imports the story types twice, or not at all, is compared whole and left out of the patch', () => {
  const ctx = fresh()
  put(ctx, 'src/Twice.stories.tsx', "import type { Story } from '@ladle/react'\nimport type { StoryDefault } from '@ladle/react'\nexport default { title: 'Pages / Twice' } satisfies StoryDefault\nexport const One: Story = () => null\n")
  put(ctx, 'src/Plain.stories.tsx', "export default { title: 'Pages / Plain' }\nexport const One = () => null\n")
  const r = convert(ctx)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Files without a single type import from the tool, compared as a whole, for a hand pass:\n {2}src\/Plain\.stories\.tsx {2}it has no type import[^\n]*\n {2}src\/Twice\.stories\.tsx {2}it imports the story types in more than one statement/)
  const removal = JSON.parse(readFileSync(work(ctx, 'removal.json'), 'utf8'))
  assert.ok(!removal.edits.some((e) => e.file === 'src/Twice.stories.tsx' || e.file === 'src/Plain.stories.tsx'))
  assert.equal(record(ctx, 'src/Twice.stories.tsx').typeImport, null)
  // Compared raw, an edit to either one fails, and so does no edit at all being needed.
  assert.equal(convert(ctx, '--check').status, 0)
  put(ctx, 'src/Plain.stories.tsx', "export default { title: 'Pages / Plain' }\nexport const One = () => 1\n")
  const edit = convert(ctx, '--check')
  assert.equal(edit.status, 1)
  assert.match(edit.stdout, /src\/Plain\.stories\.tsx: it changed outside its type import: One changed/)
})

test('a registry with a problem is not converted: its ids would be a guess', () => {
  const ctx = fresh()
  put(ctx, 'src/Dup.stories.tsx', "export default { title: 'Foundations / Welcome' }\nexport const StartHere = () => null\n")
  const r = convert(ctx)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /the registry has 1 problem/)
  assert.ok(!existsSync(work(ctx, 'records')))
})

// ── The library ──────────────────────────────────────────────────────────────

const config = (stories = {}) => deepMerge(DEFAULTS, { stories: { lane: 'csf', ids: 'ladle', ...stories } })
const registryOf = (sources, stories) => {
  const files = Object.keys(sources)
  return laneRegistry({ root: '.', config: config(stories), files, read: (f) => sources[f] })
}

test('frozen candidates are the files whose states all carry a banner key, by the policy or exploration', () => {
  const sources = {
    'src/A.stories.tsx': "export default { title: 'Explorations / A', meta: { exploration: 'Kept for review.' } }\nexport const One = () => null\nexport const Two = () => null\n",
    'src/B.stories.tsx': "export default { title: 'Pages / B', meta: { drift: 'Behind the page.' } }\nexport const One = () => null\n",
    'src/C.stories.tsx': "export default { title: 'Pages / C' }\nexport const One = () => null\nOne.meta = { exploration: 'Only one state.' }\nexport const Two = () => null\n",
    'src/D.stories.tsx': "export default { title: 'Pages / D', meta: { exploration: '' } }\nexport const One = () => null\n",
  }
  const registry = registryOf(sources)
  const read = (f) => sources[f]
  assert.deepEqual(frozenCandidates(registry, null, { read }), [{ file: 'src/A.stories.tsx', key: 'exploration' }])
  assert.deepEqual(frozenCandidates(registry, { bannerByRoot: { Explorations: 'exploration', Pages: 'drift' } }, { read }), [
    { file: 'src/A.stories.tsx', key: 'exploration' },
    { file: 'src/B.stories.tsx', key: 'drift' },
  ])
})

test('frozen candidates read the default export, not the states', () => {
  const sources = {
    'src/StoryLevel.stories.tsx': "export default { title: 'Pages / Story level' }\nexport const One = () => null\nOne.meta = { exploration: 'One.' }\nexport const Two = () => null\nTwo.meta = { exploration: 'Two.' }\n",
    'src/FileLevel.stories.tsx': "export default { title: 'Pages / File level', meta: { exploration: 'Kept.' } }\nexport const One = () => null\nexport const Two = () => null\nTwo.meta = { exploration: '' }\n",
  }
  const found = frozenCandidates(registryOf(sources), null, { read: (f) => sources[f] })
  assert.deepEqual(found, [{ file: 'src/FileLevel.stories.tsx', key: 'exploration' }])
})

test('frozenProblems reads the pins: a changed file, a bad entry, a file that is gone', () => {
  const ctx = fresh()
  const sha = spawnSync(process.execPath, ['-e', "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))", join(ctx.root, 'src/Welcome.stories.tsx')], { encoding: 'utf8' }).stdout
  const frozen = [
    { file: 'src/Welcome.stories.tsx', sha256: sha, since: 'then' },
    { file: 'src/components/Card.stories.tsx', sha256: 'f'.repeat(64), since: 'then' },
    { file: 'src/Gone.stories.tsx', sha256: 'f'.repeat(64), since: 'then' },
    { file: 'src/components/Button.stories.tsx' },
  ]
  const problems = frozenProblems(ctx.root, { stories: { frozen } })
  assert.deepEqual(problems.map((p) => [p.rule, p.file]), [['story-frozen', 'src/components/Card.stories.tsx'], ['story-frozen', 'src/components/Button.stories.tsx']])
  assert.match(problems[0].detail, /pinned since then and it has changed/)
  assert.deepEqual(frozenProblems(ctx.root, null), [])
  assert.throws(() => refreeze(ctx.root, { stories: { frozen } }, 'src/Gone.stories.tsx'), /is not there/)
  assert.throws(() => refreeze(ctx.root, { stories: { frozen } }, 'src/Other.stories.tsx'), /is not in stories\.frozen/)
  const again = refreeze(ctx.root, { stories: { frozen } }, 'src/components/Card.stories.tsx', { since: 'now' })
  assert.deepEqual([again.old, again.since, again.frozen[1].since, again.frozen[0].since], ['f'.repeat(64), 'now', 'now', 'then'])
})

test('the types file holds only non-relative import type lines and export type declarations', () => {
  const ok = checkTypesFile("import type { ReactNode } from 'react'\n// a note\nexport type A<P = {}> = ((props: P) => ReactNode) & {\n  x?: '(' | ')'\n  y?: string\n}\nexport interface B {\n  z: number\n}\nexport type C = A\n")
  assert.deepEqual(ok, { problems: [], names: ['A', 'B', 'C'] })
  const bad = checkTypesFile("import type { X } from './x'\nimport { y } from 'y'\nexport default {}\nexport type Fine = string\n")
  assert.deepEqual(bad.problems.map((p) => p.split(' ')[0]), ['import', 'import', 'export'])
  assert.deepEqual(bad.names, ['Fine'])
  // Indented, comment-prefixed and value statements at the top level are statements too.
  assert.equal(checkTypesFile("  import type { X } from './rel'\n").problems.length, 1)
  assert.equal(checkTypesFile("/* c */ import type { X } from './rel'\n").problems.length, 1)
  assert.match(checkTypesFile("export type A = string\n  export const leaked = 1\n").problems.join(), /export const leaked = 1 is neither/)
  assert.match(checkTypesFile("import type { X } from \"../rel\"\n").problems.join(), /relative import/)
  assert.deepEqual(checkTypesFile("export type A =\n  | 'a'\n  | 'b'\n"), { problems: [], names: ['A'] })
})

test('--types refuses a types file with an indented or comment-prefixed relative import', () => {
  for (const line of ["  import type { Base } from './base'", "/* c */ import type { Base } from './base'"]) {
    const ctx = fresh()
    put(ctx, 'src/lane/types.ts', `${line}\nexport type Story = Base\n`)
    const r = convert(ctx, '--types', 'src/lane/types.ts')
    assert.equal(r.status, 1, line)
    assert.match(r.stderr, /relative import/)
    assert.ok(!existsSync(work(ctx, 'removal.patch')))
  }
})

test('the patch is exact for a file with no final newline and for CRLF lines', (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git is not installed')
  const ctx = fresh()
  const sources = {
    'src/NoEol.stories.tsx': "import type { Story } from '@ladle/react'\nexport default { title: 'Pages / No eol' }\nexport const One: Story = () => null",
    'src/Crlf.stories.tsx': "import type { Story } from \"@ladle/react\"\r\nexport default { title: 'Pages / Crlf' }\r\nexport const One: Story = () => null\r\n",
    'src/deep/dir/Tight.stories.tsx': "import type { Story } from '@ladle/react'\nexport default { title: 'Pages / Tight' }\nexport const One: Story = () => null\n",
  }
  for (const [f, body] of Object.entries(sources)) put(ctx, f, body)
  const registry = registryOf(sources)
  const edits = removalEdits(registry, { root: ctx.root, read: (f) => sources[f] })
  assert.deepEqual(edits.map((e) => e.after), ['"./stories/story"', "'./stories/story'", "'../../stories/story'"])
  const patch = removalPatch(edits, (f) => sources[f])
  writeFileSync(join(ctx.root, 'p.patch'), patch)
  const r = spawnSync('git', ['apply', 'p.patch'], { cwd: ctx.root, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(text(ctx, 'src/NoEol.stories.tsx'), sources['src/NoEol.stories.tsx'].replace("'@ladle/react'", "'./stories/story'"))
  assert.equal(text(ctx, 'src/Crlf.stories.tsx'), sources['src/Crlf.stories.tsx'].replace('"@ladle/react"', '"./stories/story"'))
})

test('records of a file read from memory give the same hashes as the files on disk', () => {
  const ctx = fresh()
  const config1 = deepMerge(DEFAULTS, JSON.parse(readFileSync(join(ctx.root, 'massimo.config.json'), 'utf8')))
  const files = walk(ctx.root).filter(compileGlobs(config1.stories.include))
  const registry = laneRegistry({ root: ctx.root, config: config1, files, read: (f) => text(ctx, f) })
  const records = conversionRecords(registry, { root: ctx.root, frozen: [] })
  const onDisk = convert(ctx)
  assert.equal(onDisk.status, 0, onDisk.stderr)
  for (const r of records) {
    const saved = record(ctx, r.file)
    assert.equal(r.normalHash, saved.normalHash, r.file)
    assert.equal(r.sha256, saved.sha256, r.file)
    assert.deepEqual(r.states.map((x) => x.spanHash), saved.states.map((x) => x.spanHash), r.file)
  }
  assert.equal(records.length, 7)
  assert.deepEqual(records.map((r) => r.file), [...records.map((r) => r.file)].sort())
  assert.ok(records.every((r) => r.frozen === null && r.typeImport?.spec === '@ladle/react'))
})

// ── The opt-in and the ledger ────────────────────────────────────────────────

const LADLE_CONFIG = `export default {
  stories: 'src/**/*.stories.{tsx,ts}',
  storyOrder: ['foundations--*', 'primitives--*', '*'],
  defaultStory: 'foundations--welcome--start-here',
  addons: { width: { enabled: true, options: { 375: 'Mobile', 768: 'Tablet', 0: 'Full' } } },
  port: 6100,
}
`

// The fixture as a repo that still runs Ladle and has not opted in.
function ladleRepo() {
  const ctx = fresh()
  writeFileSync(join(ctx.root, 'massimo.config.json'), JSON.stringify({ framework: 'react', styling: ['css'] }))
  put(ctx, '.ladle/config.mjs', LADLE_CONFIG)
  writeFileSync(join(ctx.root, 'package.json'), JSON.stringify({ devDependencies: { '@ladle/react': '5', react: '18' }, scripts: { ladle: 'ladle serve --port 6100' } }))
  return ctx
}

test("config --lane csf proposes the csf lane from Ladle's own settings and the frozen design targets", () => {
  const ctx = ladleRepo()
  assert.equal(adopt(ctx, ['scan']).status, 0)
  const inventory = JSON.parse(readFileSync(join(ctx.project, 'adopt', 'inventory.json'), 'utf8'))
  assert.deepEqual(inventory.stories.tools[0].settings, {
    stories: 'src/**/*.stories.{tsx,ts}',
    storyOrder: ['foundations--*', 'primitives--*', '*'],
    defaultStory: 'foundations--welcome--start-here',
    port: 6100,
    widths: [{ label: 'Mobile', width: 375 }, { label: 'Tablet', width: 768 }, { label: 'Full', width: 0 }],
    outDir: null,
  })
  // Without the flag, the proposal leaves the lane as it is.
  assert.equal(adopt(ctx, ['plan']).status, 0)
  const before = adopt(ctx, ['config'])
  assert.ok(!/stories\.lane/.test(before.stdout), before.stdout)
  const r = adopt(ctx, ['config', '--write', '--lane', 'csf'])
  assert.equal(r.status, 0, r.stderr)
  const written = JSON.parse(readFileSync(join(ctx.root, 'massimo.config.json'), 'utf8'))
  assert.equal(written.minScripts, '0.4.0')
  assert.deepEqual(
    { ...written.stories, include: undefined, frozen: written.stories.frozen.map((f) => f.file) },
    {
      lane: 'csf',
      ids: 'ladle',
      include: undefined,
      order: ['foundations--*', 'primitives--*', '*'],
      home: 'foundations--welcome--start-here',
      viewports: [{ label: 'Mobile', width: 375, height: 0 }, { label: 'Tablet', width: 768, height: 0 }, { label: 'Full', width: 0, height: 0 }],
      port: 6101,
      url: 'http://localhost:6101/stories',
      storyUrl: 'http://localhost:6101/stories/{slug}/{state}',
      frozen: [EXPLORATION],
    },
  )
  assert.ok(written.stories.include.includes('src/**/*.stories.{tsx,ts}'))
})

test('config --lane csf needs the inventory, a Ladle repo and the lane csf', () => {
  const ctx = ladleRepo()
  const early = adopt(ctx, ['config', '--lane', 'csf'])
  assert.equal(early.status, 1)
  assert.match(early.stderr, /no .*inventory\.json yet/)
  assert.equal(adopt(ctx, ['scan']).status, 0)
  const other = adopt(ctx, ['config', '--lane', 'manifest'])
  assert.equal(other.status, 1)
  assert.match(other.stderr, /csf is the only lane --lane takes/)
  // A repo without Ladle.
  writeFileSync(join(ctx.root, 'package.json'), JSON.stringify({ devDependencies: { react: '18' } }))
  rmSync(join(ctx.root, '.ladle'), { recursive: true })
  assert.equal(adopt(ctx, ['scan']).status, 0)
  const none = adopt(ctx, ['config', '--lane', 'csf'])
  assert.equal(none.status, 1)
  assert.match(none.stderr, /scan finds no Ladle here/)
})

test('plan converts the Ladle tool once the lane is csf, and keeps it before; convert records its counts in the ledger', () => {
  const ctx = ladleRepo()
  const stories = () => JSON.parse(readFileSync(join(ctx.project, 'adopt', 'ledger.json'), 'utf8')).classes.stories
  assert.equal(adopt(ctx, ['scan']).status, 0)
  assert.equal(adopt(ctx, ['plan']).status, 0)
  assert.deepEqual([stories().assets[0].id, stories().assets[0].decision, stories().assets[0].loss], ['tool:ladle', 'keep', 'carried'])
  assert.equal(adopt(ctx, ['config', '--write', '--lane', 'csf']).status, 0)
  assert.equal(adopt(ctx, ['plan']).status, 0)
  assert.deepEqual([stories().assets[0].decision, stories().assets[0].loss], ['convert', 'carried'])
  assert.match(stories().assets[0].lines.join('\n'), /stay where they are, read in place by the csf lane/)
  assert.equal(stories().converted, undefined)
  const edits = join(ctx.project, 'adopt', 'stories', 'edits.md')
  const r = convert(ctx)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(stories().converted, { at: '2026-11-09', files: 7, states: 13, frozen: 1 })
  // The tool goes, so convert also writes the edits it needs first.
  assert.match(readFileSync(edits, 'utf8'), /^# Edits before Ladle can go\n/)
  assert.match(r.stdout, /edits\.md \(\d+ open edits?, \d+ mentions? that still work/)
  // Planned again, the ledger keeps the counts.
  assert.equal(adopt(ctx, ['plan']).status, 0)
  assert.deepEqual(stories().converted, { at: '2026-11-09', files: 7, states: 13, frozen: 1 })
  // The retire dry run lists the tool as going.
  assert.match(adopt(ctx, ['retire', 'stories', '--dry-run']).stdout, /tool:ladle {2}convert/)
})

test('config --write raises a minScripts older than the keys it writes, and says so', () => {
  const ctx = ladleRepo()
  const path = join(ctx.root, 'massimo.config.json')
  writeFileSync(path, JSON.stringify({ framework: 'react', styling: ['css'], minScripts: '0.3.0' }))
  assert.equal(adopt(ctx, ['scan']).status, 0)
  const r = adopt(ctx, ['config', '--write', '--lane', 'csf'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /~ minScripts: "0\.3\.0" -> "0\.4\.0"/)
  assert.ok(!/= minScripts/.test(r.stdout), r.stdout)
  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(written.minScripts, '0.4.0')
  assert.equal(written.stories.lane, 'csf')
})

test('config --write adds a missing minScripts when the stories keys need 0.4.0', () => {
  const ctx = ladleRepo()
  const path = join(ctx.root, 'massimo.config.json')
  writeFileSync(path, JSON.stringify({ framework: 'react', styling: ['css'] }))
  assert.equal(adopt(ctx, ['scan']).status, 0)
  assert.equal(adopt(ctx, ['config', '--write', '--lane', 'csf']).status, 0)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).minScripts, '0.4.0')
})

test('--refreeze raises a minScripts older than the csf lane', () => {
  const ctx = fresh()
  convert(ctx)
  assert.equal(adopt(ctx, ['config', '--write']).status, 0)
  const path = join(ctx.root, 'massimo.config.json')
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...raw, minScripts: '0.3.0' }, null, 2))
  const r = convert(ctx, '--refreeze', EXPLORATION)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).minScripts, '0.4.0')
})

test("config --lane csf proposes Ladle's default glob and port when its config leaves them out", () => {
  const ctx = ladleRepo()
  put(ctx, '.ladle/config.mjs', 'export default { addons: {} }\n')
  writeFileSync(join(ctx.root, 'package.json'), JSON.stringify({ devDependencies: { '@ladle/react': '5', react: '18' } }))
  assert.equal(adopt(ctx, ['scan']).status, 0)
  const r = adopt(ctx, ['config', '--write', '--lane', 'csf'])
  assert.equal(r.status, 0, r.stderr)
  const written = JSON.parse(readFileSync(join(ctx.root, 'massimo.config.json'), 'utf8'))
  assert.ok(written.stories.include.includes('src/**/*.stories.{js,jsx,ts,tsx}'), JSON.stringify(written.stories.include))
  assert.equal(written.stories.port, 61001)
  const c = convert(ctx)
  assert.equal(c.status, 0, c.stderr)
  assert.match(c.stdout, /^massimo adopt convert stories: 7 records/)
})

test('convert fails when stories.include matches no story file', () => {
  const ctx = fresh()
  setConfig(ctx, { stories: { include: ['nowhere/**/*.stories.tsx'] } })
  const r = convert(ctx)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /stories\.include matches no story file/)
  assert.ok(!existsSync(work(ctx, 'records')))
})

test('a newer ledger or removal file is refused before anything is written', () => {
  for (const [dir, name] of [['adopt', 'ledger.json'], ['adopt/stories/work', 'removal.json']]) {
    const ctx = fresh()
    mkdirSync(join(ctx.project, dir), { recursive: true })
    writeFileSync(join(ctx.project, dir, name), JSON.stringify({ format: 2 }))
    const r = convert(ctx)
    assert.equal(r.status, 1, name)
    assert.match(r.stderr, /format 2.*update massimo/, name)
    assert.ok(!existsSync(work(ctx, 'records')), name)
    assert.ok(!existsSync(work(ctx, 'removal.patch')), name)
    assert.ok(!existsSync(join(ctx.project, 'adopt', 'stories', 'redirects.json')), name)
  }
})

test('config --write adds new frozen candidates to the files already pinned', () => {
  const ctx = fresh()
  convert(ctx)
  assert.equal(adopt(ctx, ['config', '--write']).status, 0)
  const second = 'src/explorations/Second.stories.tsx'
  put(ctx, second, "export default { title: 'Explorations / Second', meta: { exploration: 'Kept.' } }\nexport const One = () => null\n")
  const c = convert(ctx)
  assert.match(c.stdout, /1 to confirm/)
  const r = adopt(ctx, ['config', '--write'])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(ctx.root, 'massimo.config.json'), 'utf8')).stories.frozen.map((f) => f.file), [EXPLORATION, second])
})

test('convert runs again after the patch is applied: no hand pass, no second ambient file', () => {
  const ctx = fresh()
  convert(ctx)
  assert.equal(adopt(ctx, ['config', '--write']).status, 0)
  convert(ctx)
  applyRemoval(ctx)
  const r = convert(ctx)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!/compared as a whole/.test(r.stdout), r.stdout)
  assert.ok(!/keeps? the tool's import/.test(r.stdout), r.stdout)
  assert.equal(readFileSync(work(ctx, 'removal.patch'), 'utf8'), '')
  assert.equal(convert(ctx, '--check').status, 0)
})

test('a bare --refreeze or --types is a usage error and writes nothing', () => {
  const ctx = fresh()
  for (const flag of ['--refreeze', '--types']) {
    const r = adopt(ctx, ['convert', 'stories', flag])
    assert.equal(r.status, 1, flag)
    assert.match(r.stderr, /usage: adopt\.mjs convert stories/, flag)
  }
  assert.ok(!existsSync(work(ctx, 'records')))
})
