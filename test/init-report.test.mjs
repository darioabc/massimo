// What init reports: a dry run says the framework and project folder the real
// run writes, and init warns, writing nothing about it, when the repo checks
// its formatting (with prettier, or in CI with another tool) and its ignore
// patterns leave the project folder or the config in.

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
    assert.ok(dry.created.every((f) => f === 'massimo.config.json' || f === 'AGENTS.md' || f.startsWith('ds/')), dry.created.join())
    assert.ok(dry.created.includes('AGENTS.md') && dry.created.includes('ds/playbooks/skills/ux/SKILL.md'), dry.created.join())
    assert.ok(!existsSync(join(r.root, 'AGENTS.md')))
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

// What the prettier warning says, by what the ignore file leaves in.
const SAYS = {
  both: 'this repo checks its formatting with prettier and .prettierignore does not cover ds/ or massimo.config.json, so a format check would flag the vendored scripts and the files massimo writes in its own format; add the lines "/ds/" and "/massimo.config.json" to .prettierignore',
  folder: 'this repo checks its formatting with prettier and .prettierignore does not cover ds/, so a format check would flag the vendored scripts and the files massimo writes in its own format; add the line "/ds/" to .prettierignore',
  config: 'this repo checks its formatting with prettier and .prettierignore does not cover massimo.config.json, so a format check would flag the vendored scripts and the files massimo writes in its own format; add the line "/massimo.config.json" to .prettierignore',
}

test('init names the ignore lines when the repo checks its formatting with prettier, and writes nothing about it', () => {
  const cases = [
    // [extra files, what the warning says]
    [{ '.prettierrc': '{ "semi": true }\n' }, 'both'],
    [{ 'package.json': { name: 'acme', dependencies: { astro: '5' }, devDependencies: { prettier: '3' } } }, 'both'],
    [{ 'package.json': { name: 'acme', dependencies: { astro: '5' }, scripts: { 'format:check': 'prettier --check .' } } }, 'both'],
    [{ '.github/workflows/ci.yml': 'jobs:\n  format:\n    steps:\n      - run: npx prettier --check .\n' }, 'both'],
    [{ '.prettierrc': '{}\n', '.prettierignore': 'dist/\n/ds/\n/massimo.config.json\n' }, null],
    [{ '.prettierrc': '{}\n', '.prettierignore': '# generated\nds\nmassimo.config.json\n' }, null],
    [{ '.prettierrc': '{}\n', '.prettierignore': '*.json\nds/**\n' }, null],
    // The folder covered and the config left in, or the other way round.
    [{ '.prettierrc': '{}\n', '.prettierignore': 'ds/**\n' }, 'config'],
    [{ '.prettierrc': '{}\n', '.prettierignore': '/massimo.config.json\n' }, 'folder'],
    // Only the scripts, or the folder taken back in: the folder is not covered.
    [{ '.prettierrc': '{}\n', '.prettierignore': 'ds/scripts/\n/massimo.config.json\n' }, 'folder'],
    [{ '.prettierrc': '{}\n', '.prettierignore': 'ds/\n!ds/\n/massimo.config.json\n' }, 'folder'],
    // No prettier anywhere: nothing to say.
    [{ '.github/workflows/ci.yml': 'jobs:\n  lint:\n    steps:\n      - run: npm run lint\n' }, null],
  ]
  for (const [extra, says] of cases) {
    const r = repo({ ...APP, ...extra })
    try {
      const before = existsSync(join(r.root, '.prettierignore')) ? readFileSync(join(r.root, '.prettierignore'), 'utf8') : null
      for (const args of [['--dry-run', ...DS], DS]) {
        const out = init(r.root, args)
        assert.deepEqual(prettierWarnings(out), says ? [SAYS[says]] : [], JSON.stringify(extra))
      }
      const after = existsSync(join(r.root, '.prettierignore')) ? readFileSync(join(r.root, '.prettierignore'), 'utf8') : null
      assert.equal(after, before, 'init writes nothing to the ignore file')
    } finally {
      r.cleanup()
    }
  }
})

test('the lines the prettier warning names are anchored to the ignore file, and adding them ends the warning', () => {
  const r = repo({ ...APP, '.prettierrc': '{}\n', '.prettierignore': 'dist/\n' })
  try {
    const [said] = prettierWarnings(init(r.root, ['--dry-run', ...DS]))
    const lines = [...said.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    // A line with a leading slash leaves out that folder only, not a folder
    // of the same name deeper in the repo.
    assert.deepEqual(lines, ['/ds/', '/massimo.config.json'])
    writeFileSync(join(r.root, '.prettierignore'), `dist/\n${lines.join('\n')}\n`)
    assert.deepEqual(prettierWarnings(init(r.root, ['--dry-run', ...DS])), [])
  } finally {
    r.cleanup()
  }
})

test('a format check in CI by another tool: the warning names the tool and where its ignore patterns live', () => {
  const formatWarnings = (out) => out.warnings.filter((w) => /formatting/.test(w))
  const withScripts = (scripts) => ({ 'package.json': { name: 'acme', dependencies: { astro: '5' }, scripts } })
  const ci = (run) => ({ '.github/workflows/ci.yml': `jobs:\n  check:\n    steps:\n      - run: ${run}\n` })
  const cases = [
    // A package script CI runs, and the tool's config with its ignore patterns.
    [
      { ...withScripts({ 'format:check': 'oxfmt --check' }), ...ci('pnpm format:check'), '.oxfmtrc.json': '{ "ignorePatterns": ["dist/**"] }\n' },
      ['this repo checks its formatting with oxfmt in CI and .oxfmtrc.json does not leave out ds/ or massimo.config.json, so the check would flag the vendored scripts and the files massimo writes in its own format; leave ds/ and massimo.config.json out with the ignorePatterns setting in .oxfmtrc.json'],
    ],
    [{ ...withScripts({ 'format:check': 'oxfmt --check' }), ...ci('pnpm format:check'), '.oxfmtrc.json': '{ "ignorePatterns": ["dist/**", "ds/**", "massimo.config.json"] }\n' }, []],
    // A tool CI runs itself, with the folder already left out.
    [
      { ...ci('npx @biomejs/biome ci .'), 'biome.json': '{ "files": { "includes": ["**", "!ds/**"] } }\n' },
      ['this repo checks its formatting with biome in CI and biome.json does not leave out massimo.config.json, so the check would flag the vendored scripts and the files massimo writes in its own format; leave massimo.config.json out with the files setting in biome.json'],
    ],
    // A script that runs the check through another script, and no config.
    [
      { ...withScripts({ check: 'npm run fmt:check && npm test', 'fmt:check': 'dprint check' }), ...ci('npm run check') },
      ['this repo checks its formatting with dprint in CI, so the check would flag the vendored scripts and the files massimo writes in its own format; leave ds/ and massimo.config.json out of what it checks'],
    ],
    // A format check by a tool not known here.
    [
      { ...withScripts({ 'format:check': 'turbo run format:check' }), ...ci('yarn format:check') },
      ['this repo checks its formatting in CI with the script format:check, which may flag the vendored scripts and the files massimo writes in its own format; leave ds/ and massimo.config.json out of what it checks'],
    ],
    // A run that writes, a lint, or a check CI never runs: nothing to say.
    [{ ...ci('npx biome check --write .'), 'biome.json': '{}\n' }, []],
    [{ ...withScripts({ lint: 'biome lint' }), ...ci('npm run lint'), 'biome.json': '{}\n' }, []],
    [{ ...withScripts({ 'format:check': 'oxfmt --check' }), ...ci('npm test') }, []],
  ]
  for (const [extra, says] of cases) {
    const r = repo({ ...APP, ...extra })
    try {
      assert.deepEqual(formatWarnings(init(r.root, ['--dry-run', ...DS])), says, JSON.stringify(extra))
    } finally {
      r.cleanup()
    }
  }
})

test('a project in a package: the warning names the lines for the ignore file at the top of the repo', (t) => {
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
      'this repo checks its formatting with prettier and ../../.prettierignore does not cover packages/ui/ds/ or packages/ui/massimo.config.json, so a format check would flag the vendored scripts and the files massimo writes in its own format; add the lines "/packages/ui/ds/" and "/packages/ui/massimo.config.json" to ../../.prettierignore',
    ])
    writeFileSync(join(r.root, '.prettierignore'), 'dist\n**/ds/\n**/massimo.config.json\n')
    assert.deepEqual(prettierWarnings(init(join(r.root, 'packages/ui'), ['--dry-run', ...DS])), [])
  } finally {
    r.cleanup()
  }
})

test('a project in a package whose own script CI runs: the warning names the tool config in the package', (t) => {
  if (!hasGit()) return t.skip('git is not installed')
  const r = repo({
    'package.json': { name: 'acme', private: true },
    '.github/workflows/checks.yml': 'jobs:\n  app:\n    defaults:\n      run:\n        working-directory: apps/web\n    steps:\n      - run: pnpm install\n      - run: pnpm format:check\n',
    'apps/web/package.json': { name: 'web', dependencies: { react: '18', vite: '5' }, scripts: { 'format:check': 'oxfmt --check' } },
    'apps/web/.oxfmtrc.json': '{ "ignorePatterns": ["dist/**"] }\n',
    'apps/web/src/components/Button.tsx': 'export const Button = () => null\n',
  })
  try {
    assert.equal(git(r.root, 'init', '-q').status, 0)
    const out = init(join(r.root, 'apps/web'), ['--dry-run', ...DS])
    assert.deepEqual(
      out.warnings.filter((w) => /formatting/.test(w)),
      ['this repo checks its formatting with oxfmt in CI and .oxfmtrc.json does not leave out ds/ or massimo.config.json, so the check would flag the vendored scripts and the files massimo writes in its own format; leave ds/ and massimo.config.json out with the ignorePatterns setting in .oxfmtrc.json'],
    )
  } finally {
    r.cleanup()
  }
})

// What the ESLint warning says, by the reason, the config file and the folder.
const eslintSays = (why, config = 'eslint.config.mjs', folder = 'ds') =>
  `this repo lints with ESLint (${why}) and ${config} does not ignore ${folder}/, so a lint would flag the vendored scripts, which keep massimo's own style; add { ignores: ["${folder}/**"] } as its own entry in ${config}`
const eslintWarnings = (out) => out.warnings.filter((w) => /ESLint/.test(w))

test('init names the ignore to add when the repo lints with ESLint and its flat config leaves the project folder in, and writes nothing about it', () => {
  const pkg = (extra) => ({ 'package.json': { name: 'acme', dependencies: { astro: '5' }, ...extra } })
  const DEP = pkg({ devDependencies: { eslint: '9' } })
  const cases = [
    // [extra files, what the warning says]
    [{ ...DEP, 'eslint.config.mjs': 'export default [\n  { ignores: ["dist/**"] },\n]\n' }, [eslintSays('eslint is a dependency')]],
    [{ ...pkg({ scripts: { lint: 'eslint .', 'lint:fix': 'eslint . --fix', test: 'vitest' } }), 'eslint.config.js': 'export default []\n' }, [eslintSays('the scripts lint, lint:fix run it', 'eslint.config.js')]],
    [{ ...pkg({ devDependencies: { eslint: '9' }, scripts: { lint: 'pnpm exec eslint .' } }), 'eslint.config.ts': "import x from './x'\nexport default x({ ignores: ['**/.cache/**'] })\n" }, [eslintSays('eslint is a dependency and the script lint runs it', 'eslint.config.ts')]],
    // An ignore that covers the folder, however it is written: nothing to say.
    [{ ...DEP, 'eslint.config.mjs': 'export default [{ ignores: ["ds/**"] }]\n' }, []],
    [{ ...DEP, 'eslint.config.mjs': "export default [{ ignores: ['./ds/'] }]\n" }, []],
    [{ ...DEP, 'eslint.config.mjs': "import { defineConfig, globalIgnores } from 'eslint/config'\nexport default defineConfig([globalIgnores(['**/ds'])])\n" }, []],
    [{ ...DEP, 'eslint.config.mjs': 'export default withConfig({ "ignores": ["dist", "ds"] })\n' }, []],
    // The scripts taken back in, or the ignore commented out: the folder is left in.
    [{ ...DEP, 'eslint.config.mjs': 'export default [{ ignores: ["ds/**", "!ds/scripts/**"] }]\n' }, [eslintSays('eslint is a dependency')]],
    [{ ...DEP, 'eslint.config.mjs': 'export default [\n  // { ignores: ["ds/**"] },\n]\n' }, [eslintSays('eslint is a dependency')]],
    // No flat config, or no ESLint: nothing to say.
    [{ ...DEP, '.eslintrc': '{ "extends": "x" }\n' }, []],
    [{ ...pkg({ scripts: { lint: 'biome lint', note: 'echo eslint-free' } }), 'eslint.config.mjs': 'export default []\n' }, []],
  ]
  for (const [extra, says] of cases) {
    const r = repo({ ...APP, ...extra })
    try {
      const config = Object.keys(extra).find((f) => f.startsWith('eslint.config.'))
      const before = config ? readFileSync(join(r.root, config), 'utf8') : null
      for (const args of [['--dry-run', ...DS], DS]) assert.deepEqual(eslintWarnings(init(r.root, args)), says, JSON.stringify(extra))
      if (config) assert.equal(readFileSync(join(r.root, config), 'utf8'), before, 'init writes nothing to the ESLint config')
    } finally {
      r.cleanup()
    }
  }
})

test('a project in a package: the ESLint warning names the flat config ESLint finds from there, and the ignore it names ends the warning', (t) => {
  if (!hasGit()) return t.skip('git is not installed')
  const r = repo({
    'package.json': { name: 'acme', private: true },
    'apps/web/package.json': { name: 'web', dependencies: { nuxt: '^4.1.0' }, devDependencies: { eslint: '9', '@nuxt/eslint': '1' }, scripts: { lint: 'eslint .' } },
    'apps/web/nuxt.config.ts': 'export default defineNuxtConfig({})\n',
    'apps/web/eslint.config.mjs': '// @ts-check\nimport withNuxt from "./.nuxt/eslint.config.mjs";\n\nexport default withNuxt(\n  { ignores: ["**/.temp/**"] },\n);\n',
    'apps/web/app/components/AppButton.vue': '<template><button /></template>\n',
  })
  try {
    assert.equal(git(r.root, 'init', '-q').status, 0)
    const web = join(r.root, 'apps/web')
    assert.deepEqual(eslintWarnings(init(web, ['--dry-run', ...DS])), [eslintSays('eslint is a dependency and the script lint runs it')])
    writeFileSync(join(web, 'eslint.config.mjs'), 'import withNuxt from "./.nuxt/eslint.config.mjs";\n\nexport default withNuxt(\n  { ignores: ["**/.temp/**"] },\n  { ignores: ["ds/**"] },\n);\n')
    assert.deepEqual(eslintWarnings(init(web, ['--dry-run', ...DS])), [])
    // The top of the repo runs ESLint too, with a config of its own: the folder is read from there.
    writeFileSync(join(r.root, 'package.json'), JSON.stringify({ name: 'acme', private: true, devDependencies: { eslint: '9' } }))
    writeFileSync(join(r.root, 'eslint.config.js'), 'export default [{ ignores: ["dist/**"] }]\n')
    assert.deepEqual(eslintWarnings(init(web, ['--dry-run', ...DS])), [eslintSays('eslint is a dependency', '../../eslint.config.js', 'apps/web/ds')])
  } finally {
    r.cleanup()
  }
})
