// What init reports: a dry run says the framework and project folder the real
// run writes, and init warns, writing nothing about it, when the repo checks
// its formatting with prettier and its ignore file leaves the project folder
// in.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SCRIPTS } from './helpers.mjs'

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-init-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const init = (root, args = []) => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'init.mjs'), '--root', root, '--no-npm-scripts', ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const hasGit = () => spawnSync('git', ['--version']).status === 0

const APP = { 'package.json': { name: 'acme', dependencies: { astro: '5' } }, 'src/components/Hero.astro': '---\n---\n' }
const DS = ['--config-json', '{"projectDir":"ds"}']
const prettierWarnings = (out) => out.warnings.filter((w) => /prettier/.test(w))

test('a dry run reports the framework and the project folder the real run writes, and writes nothing', () => {
  const r = repo(APP)
  try {
    const dry = init(r.root, ['--dry-run', ...DS])
    assert.equal(dry.framework, 'astro')
    assert.equal(dry.projectDir, 'ds')
    assert.ok(dry.created.includes('ds/STATUS.md'), dry.created.join())
    assert.ok(dry.created.every((f) => f === 'massimo.config.json' || f.startsWith('ds/')), dry.created.join())
    assert.ok(!existsSync(join(r.root, 'massimo.config.json')))
    assert.ok(!existsSync(join(r.root, 'ds')))
    const real = init(r.root, DS)
    assert.equal(real.framework, dry.framework)
    assert.equal(real.projectDir, dry.projectDir)
    assert.deepEqual(real.created, dry.created)
  } finally {
    r.cleanup()
  }
})

test('init names the ignore line when the repo checks its formatting with prettier, and writes nothing about it', () => {
  const cases = [
    // [extra files, warns]
    [{ '.prettierrc': '{ "semi": true }\n' }, true],
    [{ 'package.json': { name: 'acme', dependencies: { astro: '5' }, devDependencies: { prettier: '3' } } }, true],
    [{ 'package.json': { name: 'acme', dependencies: { astro: '5' }, scripts: { 'format:check': 'prettier --check .' } } }, true],
    [{ '.github/workflows/ci.yml': 'jobs:\n  format:\n    steps:\n      - run: npx prettier --check .\n' }, true],
    [{ '.prettierrc': '{}\n', '.prettierignore': 'dist/\n/ds/\n' }, false],
    [{ '.prettierrc': '{}\n', '.prettierignore': '# generated\nds\n' }, false],
    [{ '.prettierrc': '{}\n', '.prettierignore': 'ds/**\n' }, false],
    // Only the scripts, or the folder taken back in: the folder is not covered.
    [{ '.prettierrc': '{}\n', '.prettierignore': 'ds/scripts/\n' }, true],
    [{ '.prettierrc': '{}\n', '.prettierignore': 'ds/\n!ds/\n' }, true],
    // No prettier anywhere: nothing to say.
    [{ '.github/workflows/ci.yml': 'jobs:\n  lint:\n    steps:\n      - run: npm run lint\n' }, false],
  ]
  for (const [extra, warns] of cases) {
    const r = repo({ ...APP, ...extra })
    try {
      const before = existsSync(join(r.root, '.prettierignore')) ? readFileSync(join(r.root, '.prettierignore'), 'utf8') : null
      for (const args of [['--dry-run', ...DS], DS]) {
        const out = init(r.root, args)
        const said = prettierWarnings(out)
        if (warns) {
          assert.deepEqual(said, ['this repo checks its formatting with prettier and .prettierignore does not cover ds/, so a format check would flag the vendored scripts and the files massimo writes there; add the line "ds/" to .prettierignore'], JSON.stringify(extra))
        } else {
          assert.deepEqual(said, [], JSON.stringify(extra))
        }
      }
      const after = existsSync(join(r.root, '.prettierignore')) ? readFileSync(join(r.root, '.prettierignore'), 'utf8') : null
      assert.equal(after, before, 'init writes nothing to the ignore file')
    } finally {
      r.cleanup()
    }
  }
})

test('a project in a package: the warning names the line for the ignore file at the top of the repo', (t) => {
  if (!hasGit()) return t.skip('git is not installed')
  const r = repo({
    'package.json': { name: 'acme', private: true, devDependencies: { prettier: '3' } },
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    '.prettierignore': 'dist\n',
    'packages/ui/package.json': { name: '@acme/ui', dependencies: { react: '18', vite: '5' } },
    'packages/ui/src/components/Button.tsx': 'export const Button = () => null\n',
  })
  try {
    assert.equal(git(r.root, 'init', '-q').status, 0)
    const out = init(join(r.root, 'packages/ui'), ['--dry-run', ...DS])
    assert.deepEqual(prettierWarnings(out), [
      'this repo checks its formatting with prettier and ../../.prettierignore does not cover packages/ui/ds/, so a format check would flag the vendored scripts and the files massimo writes there; add the line "packages/ui/ds/" to ../../.prettierignore',
    ])
    writeFileSync(join(r.root, '.prettierignore'), 'dist\n**/ds/\n')
    assert.deepEqual(prettierWarnings(init(join(r.root, 'packages/ui'), ['--dry-run', ...DS])), [])
  } finally {
    r.cleanup()
  }
})
