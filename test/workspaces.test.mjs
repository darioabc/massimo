// Monorepos: the workspace globs a root declares (package.json or
// pnpm-workspace.yaml), detect and scan keeping the packages they name, the
// style files scan leaves out said rather than dropped, a project made in a
// package found from inside it, tsconfig.base.json paths, and imports of a
// workspace package read as edges to its source.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { findRoot } from '../scripts/lib/project.mjs'
import { createResolver } from '../scripts/lib/source.mjs'
import { SCRIPTS } from './helpers.mjs'

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-workspaces-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const node = (name, args, opts = {}) => spawnSync(process.execPath, [join(SCRIPTS, `${name}.mjs`), ...args], { encoding: 'utf8', ...opts })
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const hasGit = () => spawnSync('git', ['--version']).status === 0

const THEME = ':root { --a: 1px; --b: 2px; --c: 3px; --d: 4px; --e: 5px; }\n'

// A pnpm workspace whose root package.json declares no workspaces.
const PNPM = {
  'package.json': { name: 'acme', private: true, devDependencies: { react: '18', vite: '5', '@ladle/react': '4' } },
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - \"apps/site\" # the docs site\n  - '!**/test/**'\n\nonlyBuiltDependencies:\n  - esbuild\n",
  'packages/ui/package.json': { name: '@acme/ui' },
  'packages/ui/src/components/Button.tsx': 'export const Button = () => null\n',
  'packages/ui/src/components/Card.tsx': 'export const Card = () => null\n',
  'packages/ui/src/components/Button.stories.tsx': "import { Button } from './Button'\nexport default { title: 'Button' }\nexport const Primary = () => <Button />\n",
  'packages/tokens/package.json': { name: '@acme/tokens' },
  'packages/tokens/src/tokens.css': THEME,
}

test('workspaceGlobs: package.json lists, a packages object, and pnpm-workspace.yaml read as text', async () => {
  const { workspaceGlobs } = await import('../scripts/lib/project.mjs')
  const cases = [
    [{ 'package.json': { workspaces: ['packages/*', 'apps/site/'] } }, ['packages/*', 'apps/site']],
    [{ 'package.json': { workspaces: { packages: ['libs/**'], nohoist: ['**/x'] } } }, ['libs/**']],
    [{ 'package.json': {}, 'pnpm-workspace.yaml': PNPM['pnpm-workspace.yaml'] }, ['packages/*', 'apps/site']],
    [{ 'package.json': {}, 'pnpm-workspace.yaml': "# the workspace\npackages:\n- packages/*\n- 'tools/*'\ncatalog:\n  react: ^18\n" }, ['packages/*', 'tools/*']],
    [{ 'package.json': {}, 'pnpm-workspace.yaml': "packages: ['packages/*', \"www\"]\n" }, ['packages/*', 'www']],
    // Settings alone, or the root itself, name no packages.
    [{ 'package.json': {}, 'pnpm-workspace.yaml': 'allowBuilds:\n  esbuild: true\n' }, []],
    [{ 'package.json': {}, 'pnpm-workspace.yaml': 'packages:\n  - "."\n\nallowBuilds:\n  esbuild: true\n' }, []],
    [{ 'package.json': { workspaces: [] } }, []],
    [{}, []],
  ]
  for (const [files, want] of cases) {
    const r = repo(files)
    try {
      assert.deepEqual(workspaceGlobs(r.root), want, JSON.stringify(files))
    } finally {
      r.cleanup()
    }
  }
})

test('detect: a pnpm workspace keeps its packages, and a pnpm-workspace.yaml that holds settings alone is no monorepo', () => {
  const r = repo(PNPM)
  try {
    const out = JSON.parse(node('detect', ['--root', r.root]).stdout)
    assert.equal(out.monorepo, true)
    assert.deepEqual(out.nestedPackages, [])
    assert.deepEqual(out.componentDirs, [{ dir: 'packages/ui', count: 2 }])
    assert.equal(out.storyTools.storyFiles, 1)
    assert.deepEqual(out.styleFiles.map((s) => s.file), ['packages/tokens/src/tokens.css'])
  } finally {
    r.cleanup()
  }
  for (const yaml of ['allowBuilds:\n  esbuild: true\n', 'packages:\n  - "."\nallowBuilds:\n  esbuild: true\n']) {
    const single = repo({ 'package.json': { dependencies: { astro: '5' } }, 'pnpm-workspace.yaml': yaml, 'src/components/Hero.astro': '---\n---\n' })
    try {
      const out = JSON.parse(node('detect', ['--root', single.root]).stdout)
      assert.equal(out.monorepo, false, yaml)
      assert.deepEqual(out.nestedPackages, [])
    } finally {
      single.cleanup()
    }
  }
})

test('adopt scan: a pnpm workspace\'s story files and style files are read', () => {
  const r = repo(PNPM)
  try {
    const res = node('adopt', ['scan', '--json', '--root', r.root])
    assert.equal(res.status, 0, res.stderr)
    const inv = JSON.parse(res.stdout)
    assert.deepEqual(inv.stories.tools.map((t) => [t.tool, t.files]), [['ladle', 1]])
    assert.deepEqual(inv.own.styleFiles, ['packages/tokens/src/tokens.css'])
    assert.equal(inv.notes, undefined)
  } finally {
    r.cleanup()
  }
})

test('adopt scan: a style file the config names and scan leaves out is a note, in the summary and the inventory', () => {
  const r = repo({
    'package.json': { name: 'acme' },
    'site/package.json': { name: 'site' },
    'site/styles/tokens.css': THEME,
    'src/styles/plain.css': 'body { margin: 0 }\n',
    'src/styles/theme.css': THEME,
    'massimo.config.json': { version: 1, tokens: { styleFiles: ['src/styles/theme.css', 'site/styles/tokens.css', 'src/styles/plain.css', 'src/styles/gone.css'] } },
  })
  const project = join(r.root, 'ds')
  try {
    const res = node('adopt', ['scan', '--root', r.root, '--project-dir', project])
    assert.equal(res.status, 0, res.stderr)
    const notes = [
      'tokens.styleFiles names site/styles/tokens.css, which scan leaves out: it is in a folder scan does not read (another package, or an ignored folder).',
      'tokens.styleFiles names src/styles/gone.css, which scan leaves out: there is no such file.',
      'tokens.styleFiles names src/styles/plain.css, which scan leaves out: it declares no custom property.',
    ]
    assert.deepEqual(res.stdout.split('\n').filter((l) => l.startsWith('note: ')), notes.map((n) => `note: ${n}`))
    const inv = JSON.parse(readFileSync(join(project, 'adopt', 'inventory.json'), 'utf8'))
    assert.deepEqual(inv.own.styleFiles, ['src/styles/theme.css'])
    assert.deepEqual(inv.notes, notes)
    const md = readFileSync(join(project, 'adopt', 'inventory.md'), 'utf8')
    for (const n of notes) assert.ok(md.includes(`Note: ${n}`), n)
  } finally {
    r.cleanup()
  }
})

test('findRoot: the nearest folder up to the top of the checkout that holds a config, else that top', (t) => {
  if (!hasGit()) return t.skip('git is not installed')
  const r = repo({ 'package.json': { name: 'acme' }, 'apps/web/package.json': { name: 'web' }, 'apps/web/src/main.ts': '', 'apps/docs/package.json': { name: 'docs' } })
  try {
    assert.equal(git(r.root, 'init', '-q').status, 0)
    const top = realpathSync(r.root)
    // No config anywhere: the top, as before, so init and detect start there.
    assert.equal(findRoot(join(r.root, 'apps/web/src')), top)
    writeFileSync(join(r.root, 'apps/web/massimo.config.json'), '{ "version": 1 }\n')
    assert.equal(findRoot(join(r.root, 'apps/web/src')), join(top, 'apps/web'))
    assert.equal(findRoot(join(r.root, 'apps/web')), join(top, 'apps/web'))
    assert.equal(findRoot(join(r.root, 'apps/docs')), top)
    assert.equal(findRoot(r.root), top)
  } finally {
    r.cleanup()
  }
  // Outside a checkout: the nearest folder with a config, else the nearest with a package.json.
  const plain = repo({ 'a/massimo.config.json': '{}', 'a/b/package.json': '{}', 'a/b/c/x.txt': '' })
  try {
    assert.equal(findRoot(join(plain.root, 'a/b/c')), join(plain.root, 'a'))
    rmSync(join(plain.root, 'a/massimo.config.json'))
    assert.equal(findRoot(join(plain.root, 'a/b/c')), join(plain.root, 'a/b'))
  } finally {
    plain.cleanup()
  }
})

test('a project made with init --root <package> works from inside that package: its npm scripts, the hook and the vendored scripts', (t) => {
  if (!hasGit()) return t.skip('git is not installed')
  const r = repo({
    'package.json': { name: 'acme', private: true },
    'apps/web/package.json': { name: 'web', dependencies: { react: '18', vite: '5' } },
    'apps/web/src/components/Button.tsx': 'export const Button = () => null\n',
    'apps/web/src/App.tsx': "import { Button } from './components/Button'\nexport const App = () => <Button />\n",
  })
  try {
    assert.equal(git(r.root, 'init', '-q').status, 0)
    const web = join(r.root, 'apps/web')
    const made = node('init', ['--root', web])
    assert.equal(made.status, 0, made.stderr)
    const project = JSON.parse(made.stdout).projectDir
    const pkg = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8'))
    assert.equal(pkg.scripts['ds:graph'], `node ${project}/scripts/graph.mjs`)

    // The npm script, as npm runs it: from the package, with no --root.
    const vendored = (name, args, cwd) => spawnSync(process.execPath, [join(web, project, 'scripts', `${name}.mjs`), ...args], { cwd, encoding: 'utf8' })
    const graph = vendored('graph', [], web)
    assert.equal(graph.status, 0, graph.stderr)
    assert.match(graph.stdout, /\(1 components?, /)
    assert.ok(existsSync(join(web, project, 'graph.md')))
    assert.ok(!existsSync(join(r.root, project)), 'nothing is written at the top of the checkout')
    const show = vendored('state', ['show'], join(web, 'src'))
    assert.equal(show.status, 0, show.stderr)
    assert.match(show.stdout, /^Project: /)
    assert.equal(vendored('graph', ['--check'], web).status, 0)

    // The hook, when Claude starts in the package, and silence at the top.
    const hook = (dir) => node('session-start', [], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir } })
    assert.match(JSON.parse(hook(web).stdout).hookSpecificOutput.additionalContext, /massimo design-system project/)
    assert.equal(hook(r.root).stdout, '')
  } finally {
    r.cleanup()
  }
})

test('tsconfig.base.json paths: exact keys resolve in the graph and detect suggests them', () => {
  const r = repo({
    'package.json': { name: 'acme', devDependencies: { react: '18', vite: '5' } },
    'tsconfig.base.json': '{ "compilerOptions": { "paths": { "@acme/ui": ["./packages/ui/src/index.ts"], "@acme/ui/*": ["./packages/ui/src/*"] } } }',
    'packages/ui/src/index.ts': "export { Button } from './Button'\n",
    'packages/ui/src/Button.tsx': 'export const Button = () => null\n',
    'apps/site/src/Page.tsx': "import { Button } from '@acme/ui'\nexport const Page = () => <Button />\n",
    'massimo.config.json': { version: 1, components: { include: ['packages/ui/src/**/*.tsx'] }, consumers: ['apps/site/src/**/*.tsx'] },
  })
  try {
    const resolve = createResolver(r.root, {})
    assert.deepEqual(resolve('apps/site/src/Page.tsx', '@acme/ui'), { file: 'packages/ui/src/index.ts' })
    assert.deepEqual(resolve('apps/site/src/Page.tsx', '@acme/ui/Button'), { file: 'packages/ui/src/Button.tsx' })
    const project = join(r.root, 'ds')
    const res = node('graph', ['--root', r.root, '--project-dir', project])
    assert.equal(res.status, 0, res.stderr)
    const button = JSON.parse(readFileSync(join(project, 'graph.json'), 'utf8')).nodes.find((n) => n.name === 'Button')
    assert.equal(button.usage, 1)
    const out = JSON.parse(node('detect', ['--root', r.root]).stdout)
    assert.deepEqual(out.aliases, { '@acme/ui': 'packages/ui/src/index.ts', '@acme/ui/': 'packages/ui/src/' })
  } finally {
    r.cleanup()
  }
})

test('createResolver: a workspace package resolves to its source by exports, fields and index files', () => {
  const r = repo({
    'package.json': { name: 'acme', workspaces: ['packages/*', 'tools/**'] },
    // exports as a string
    'packages/text/package.json': { name: '@acme/text', exports: './src/index.ts' },
    'packages/text/src/index.ts': '',
    // a conditions object: import names a build that is not there, source the code
    'packages/ui/package.json': { name: '@acme/ui', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js', source: './src/main.tsx' }, './icons': { import: './src/icons/index.ts' } } },
    'packages/ui/src/main.tsx': '',
    'packages/ui/src/icons/index.ts': '',
    'packages/ui/src/Card.tsx': '',
    // a build in an ignored folder, and a declaration file, are passed over for src/index
    'packages/tokens/package.json': { name: '@acme/tokens', main: './dist/index.js', module: './types/index.d.ts' },
    'packages/tokens/dist/index.js': '',
    'packages/tokens/types/index.d.ts': '',
    'packages/tokens/src/index.mjs': '',
    // index at the package root, under a ** glob
    'tools/deep/lint/package.json': { name: 'lint-kit' },
    'tools/deep/lint/index.js': '',
    // a package with nothing to resolve to, and a folder without a name
    'packages/empty/package.json': { name: '@acme/empty', main: './dist/index.js' },
    'packages/nameless/package.json': {},
  })
  try {
    const resolve = createResolver(r.root, { ignore: ['dist'] })
    const from = 'packages/ui/src/Card.tsx'
    assert.deepEqual(resolve(from, '@acme/text'), { file: 'packages/text/src/index.ts' })
    assert.deepEqual(resolve(from, '@acme/ui'), { file: 'packages/ui/src/main.tsx' })
    assert.deepEqual(resolve(from, '@acme/ui/icons'), { file: 'packages/ui/src/icons/index.ts' })
    assert.deepEqual(resolve(from, '@acme/ui/src/Card'), { file: 'packages/ui/src/Card.tsx' })
    assert.deepEqual(resolve(from, '@acme/tokens'), { file: 'packages/tokens/src/index.mjs' })
    assert.deepEqual(resolve(from, 'lint-kit'), { file: 'tools/deep/lint/index.js' })
    assert.deepEqual(resolve(from, '@acme/empty'), { pkg: '@acme/empty' })
    assert.deepEqual(resolve(from, 'react'), { pkg: 'react' })
  } finally {
    r.cleanup()
  }
})

test('graph: an import of a workspace package is an edge to the component, not a package', () => {
  const r = repo({
    'package.json': { name: 'acme', private: true },
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'packages/text/package.json': { name: '@acme/text', exports: './src/index.ts' },
    'packages/text/src/index.ts': "export { Text } from './Text'\n",
    'packages/text/src/Text.tsx': 'export const Text = () => null\n',
    'packages/ui/package.json': { name: '@acme/ui', exports: './src/index.ts', dependencies: { '@acme/text': 'workspace:*', clsx: '2' } },
    'packages/ui/src/index.ts': "export { Card } from './Card'\n",
    'packages/ui/src/Card.tsx': "import clsx from 'clsx'\nimport { Text } from '@acme/text'\nexport const Card = () => <Text className={clsx('a')} />\n",
    'massimo.config.json': { version: 1, components: { include: ['packages/*/src/**/*.tsx'] }, consumers: ['packages/*/src/**/*.{ts,tsx}'] },
  })
  try {
    const project = join(r.root, 'ds')
    const res = node('graph', ['--root', r.root, '--project-dir', project])
    assert.equal(res.status, 0, res.stderr)
    const nodes = Object.fromEntries(JSON.parse(readFileSync(join(project, 'graph.json'), 'utf8')).nodes.map((n) => [n.name, n]))
    assert.deepEqual(nodes.Text.composedBy, { components: ['packages/ui/src/Card.tsx'] })
    assert.deepEqual(nodes.Card.packages, ['clsx'])
  } finally {
    r.cleanup()
  }
})
