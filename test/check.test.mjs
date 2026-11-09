// check.mjs, the script ds:check runs: every massimo check that applies to
// the project, then the project's own from guard.extraChecks, one line each,
// failing when any fails.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { read, run, scratch } from './helpers.mjs'

const contexts = []
after(() => contexts.forEach((c) => c.cleanup()))
const fresh = (fixture) => {
  const ctx = scratch(fixture)
  contexts.push(ctx)
  return ctx
}
const patch = (ctx, edit) => {
  const path = join(ctx.root, 'massimo.config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  edit(config)
  writeFileSync(path, JSON.stringify(config))
}
const lines = (r) => r.stdout.trimEnd().split('\n')

test('a project with every phase done runs all four checks, and each one can fail it', () => {
  const ctx = fresh('app')
  for (const [name, args] of [['graph', []], ['tokens', ['build']], ['audit', ['--baseline']], ['docs', []]]) {
    const r = run(name, ctx, args)
    assert.equal(r.status, 0, `${name}: ${r.stderr}`)
  }
  const ok = run('check', ctx)
  assert.equal(ok.status, 0, ok.stdout)
  assert.deepEqual(lines(ok).map((l) => l.split(/\s+/).slice(0, 2).join(' ')), ['pass graph', 'pass audit', 'pass tokens', 'pass docs', 'massimo check:'])
  assert.match(ok.stdout, /^pass {2}graph {3}node \.\.\/project\/scripts\/graph\.mjs --check$/m)
  assert.match(ok.stdout, /massimo check: 4 checks passed/)

  // Each check fails the run on its own: an edit only it sees fails its
  // line alone, and the edit is undone before the next.
  const failsAlone = (name, file, edit) => {
    const before = readFileSync(file, 'utf8')
    writeFileSync(file, edit(before))
    const r = run('check', ctx)
    writeFileSync(file, before)
    assert.equal(r.status, 1, `${name}: ${r.stdout}`)
    assert.deepEqual(lines(r).filter((l) => /^(pass|fail) /.test(l)).map((l) => l.split(/\s+/).slice(0, 2).join(' ')), ['graph', 'audit', 'tokens', 'docs'].map((c) => `${c === name ? 'fail' : 'pass'} ${c}`))
    assert.match(r.stdout, /massimo check: 1 of 4 checks failed/)
    return r
  }
  // A new raw colour fails the audit line, and its output shows under it.
  const bad = failsAlone('audit', join(ctx.root, 'src', 'raw.tsx'), (s) => s.replace("color: '#FF0000'", "color: '#abcdef'"))
  assert.match(bad.stdout, /^fail {2}audit {3}node \S+audit\.mjs --check\n {6}massimo audit: 1 offender rose or is new.*\n {6} {2}color {2}src\/raw\.tsx: #abcdef {2}new\n/m)
  // A component that now uses another is a graph the code has moved past.
  failsAlone('graph', join(ctx.root, 'src', 'components', 'Toolbar.tsx'), (s) => `import { Chip } from './Chip.svelte'\n${s}`)
  // A generated output edited by hand is behind the token set.
  failsAlone('tokens', join(ctx.root, 'src', 'styles', 'tokens.generated.css'), (s) => s.replace(/#777777/i, '#787878'))
  // A README block edited by hand is not what docs writes.
  failsAlone('docs', join(ctx.project, 'README.md'), (s) => s.replace('<!-- massimo:docs:start -->\n', '<!-- massimo:docs:start -->\nEdited by hand.\n'))
  assert.equal(run('check', ctx).status, 0)
})

test('a check that does not apply yet is skipped, and the project\'s own checks run after', () => {
  const ctx = fresh('audit-adopt')
  assert.equal(run('graph', ctx).status, 0)
  patch(ctx, (c) => {
    c.guard = {
      extraChecks: [
        { name: 'shipped images', run: 'node -e "process.exit(0)"' },
        { name: 'licence headers', run: 'node -e "console.log(\'missing in src/x.ts\'); process.exit(3)"' },
        { run: 'true' },
      ],
    }
  })
  const r = run('check', ctx)
  assert.equal(r.status, 1)
  assert.deepEqual(lines(r).map((l) => l.replace(/\s{2,}/g, ' | ')), [
    'pass | graph | node ../project/scripts/graph.mjs --check',
    'skip | audit | no audit baseline yet',
    'skip | tokens | no token set yet',
    'skip | docs | no generated README yet',
    'pass | shipped images | node -e "process.exit(0)"',
    'fail | licence headers | node -e "console.log(\'missing in src/x.ts\'); process.exit(3)"',
    ' | missing in src/x.ts',
    'fail | guard.extraChecks[2] | needs a name and a run command, as { "name": "...", "run": "..." }',
    'massimo check: 2 of 4 checks failed (../project)',
  ])
})

test('the README says what ds:check runs once it is check.mjs, and names the project\'s own checks', () => {
  const ctx = fresh('app')
  const pkg = join(ctx.root, 'package.json')
  writeFileSync(pkg, JSON.stringify({ ...JSON.parse(readFileSync(pkg, 'utf8')), scripts: { 'ds:check': 'node design/scripts/check.mjs' } }))
  patch(ctx, (c) => (c.guard = { extraChecks: [{ name: 'shipped images', run: 'npm run check:images' }] }))
  assert.equal(run('docs', ctx).status, 0)
  const readme = read(ctx.project, 'README.md')
  assert.match(readme, /`npm run ds:check` runs in CI: `node design\/scripts\/check\.mjs`\. It runs every massimo check that applies to the project/)
  assert.match(readme, /It also runs the project's own checks \(`guard\.extraChecks`\): shipped images\./)
})

test('a csf lane adds a stories check after graph, and no other lane does', () => {
  const ctx = fresh('csf-lane')
  assert.equal(run('graph', ctx).status, 0)
  const ok = run('check', ctx)
  assert.equal(ok.status, 0, ok.stdout)
  assert.deepEqual(lines(ok).map((l) => l.split(/\s+/).slice(0, 2).join(' ')), ['pass graph', 'pass stories', 'skip audit', 'skip tokens', 'skip docs', 'massimo check:'])
  assert.match(ok.stdout, /^pass {2}stories {2}node \.\.\/project\/scripts\/stories\.mjs --check$/m)

  // A second story with an id that is taken fails the stories line, and its output shows under it.
  // The new file also leaves graph.json behind, so the graph line fails too.
  writeFileSync(join(ctx.root, 'src', 'Again.stories.tsx'), "export default { title: 'Foundations / Welcome' }\nexport const StartHere = () => null\n")
  const bad = run('check', ctx)
  assert.equal(bad.status, 1)
  assert.deepEqual(lines(bad).filter((l) => /^(pass|fail) /.test(l)).map((l) => l.split(/\s+/).slice(0, 2).join(' ')), ['fail graph', 'fail stories'])
  assert.match(bad.stdout, /^ {6} {2}\[story-files\] src\/Welcome\.stories\.tsx: StartHere has the id /m)

  // A native lane runs the four checks and no stories line.
  patch(ctx, (c) => (c.stories.lane = 'native'))
  assert.doesNotMatch(run('check', ctx).stdout, /stories/)
})
