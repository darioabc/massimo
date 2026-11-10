// detect in repos made of packages: a root that holds only apps, a workspace
// root whose packages name the framework and the styling, a package that uses
// what its workspace root installs, one package per component, component
// globs that always match a file, and style files read without their
// comments. Then the start skill's guidance on where the project lives.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SCRIPTS } from './helpers.mjs'

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-packages-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const detect = (root, args = []) => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'detect.mjs'), '--root', root, ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const hasGit = () => spawnSync('git', ['--version']).status === 0

const THEME = ':root { --a: 1px; --b: 2px; --c: 3px; --d: 4px; --e: 5px; }\n'
const COMPONENT = 'export const C = () => null\n'

test('a root that holds apps and no framework of its own is a monorepo, and a root with a framework of its own is not', () => {
  const apps = repo({
    'package.json': { name: 'acme', private: true, scripts: { lint: 'eslint .' } },
    'apps/web/package.json': { name: 'web', dependencies: { react: '18', vite: '5' } },
    'apps/web/src/components/Button.tsx': COMPONENT,
    'apps/site/package.json': { name: 'site', dependencies: { astro: '5' } },
  })
  try {
    const out = detect(apps.root)
    assert.equal(out.framework, 'unknown')
    assert.deepEqual([...out.nestedPackages].sort(), ['apps/site/', 'apps/web/'])
    assert.equal(out.monorepo, true)
    // Nothing at the root: no component glob that would match nothing.
    assert.deepEqual(out.suggestedConfig.components.include, [])
  } finally {
    apps.cleanup()
  }
  const site = repo({
    'package.json': { name: 'acme', dependencies: { react: '18', vite: '5' } },
    'src/components/Button.tsx': COMPONENT,
    'docs/package.json': { name: 'docs', dependencies: { astro: '5' } },
  })
  try {
    const out = detect(site.root)
    assert.deepEqual(out.nestedPackages, ['docs/'])
    assert.equal(out.monorepo, false)
  } finally {
    site.cleanup()
  }
})

// One package per component: the components live in packages/<name>/src/,
// the story tool and the bundler plugins at the root, React and the styling
// runtime in the packages.
const PER_COMPONENT = {
  'package.json': { name: 'acme', private: true, devDependencies: { vite: '5', storybook: '8', '@vanilla-extract/vite-plugin': '4' } },
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  '.storybook/main.ts': 'export default {}\n',
  'packages/button/package.json': { name: '@acme/button', devDependencies: { react: '18' } },
  'packages/button/src/Button.tsx': COMPONENT,
  'packages/button/src/Button.stories.tsx': "export default { title: 'Button' }\n",
  'packages/button/src/button.css.ts': 'export const root = {}\n',
  'packages/card/package.json': { name: '@acme/card', devDependencies: { react: '18' } },
  'packages/card/src/Card.tsx': COMPONENT,
  'packages/card/src/CardHeader.tsx': COMPONENT,
  'packages/badge/package.json': { name: '@acme/badge', devDependencies: { react: '18' } },
  'packages/badge/src/Badge.tsx': COMPONENT,
  'packages/icon/package.json': { name: '@acme/icon', devDependencies: { react: '18' } },
  ...Object.fromEntries(['Arrow', 'Check', 'Close', 'Plus', 'Minus'].map((n) => [`packages/icon/src/components/${n}.tsx`, COMPONENT])),
  'packages/tokens/package.json': { name: '@acme/tokens' },
  'packages/tokens/src/index.ts': 'export const tokens = {}\n',
}

test('one package per component: the packages are one folder, and their glob matches every component', () => {
  const r = repo(PER_COMPONENT)
  try {
    const out = detect(r.root)
    assert.equal(out.monorepo, true)
    assert.deepEqual(out.componentDirs, [{ dir: 'packages/*/src', count: 9 }])
    assert.deepEqual(out.suggestedConfig.components.include, ['packages/*/src/**/*.{tsx,jsx}'])
  } finally {
    r.cleanup()
  }
  // A workspace whose library package holds most components keeps its named folder.
  const lib = repo({
    'package.json': { name: 'acme', private: true, devDependencies: { react: '18', vite: '5' } },
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'packages/core/package.json': { name: '@acme/core' },
    ...Object.fromEntries(['Button', 'Card', 'Badge', 'Dialog', 'Menu'].map((n) => [`packages/core/src/components/${n}.tsx`, COMPONENT])),
    'packages/docs/package.json': { name: '@acme/docs' },
    ...Object.fromEntries(['Page', 'Nav', 'Footer', 'Search', 'Toc'].map((n) => [`packages/docs/src/${n}.tsx`, COMPONENT])),
    'packages/play/package.json': { name: '@acme/play' },
    'packages/play/src/Play.tsx': COMPONENT,
  })
  try {
    assert.deepEqual(detect(lib.root).suggestedConfig.components.include, ['packages/core/src/components/**/*.{tsx,jsx}'])
  } finally {
    lib.cleanup()
  }
})

test('a component glob always matches a file: the package src/, or the extensions the folder holds', () => {
  const pkg = repo({ 'package.json': { name: '@acme/button', dependencies: { react: '18', vite: '5' } }, 'src/Button.tsx': COMPONENT, 'src/index.ts': 'export * from "./Button"\n' })
  try {
    assert.deepEqual(detect(pkg.root).suggestedConfig.components.include, ['src/**/*.{tsx,jsx}'])
  } finally {
    pkg.cleanup()
  }
  const astro = repo({ 'package.json': { name: 'acme' }, 'src/components/Card.astro': '---\n---\n', 'src/components/Hero.astro': '---\n---\n' })
  try {
    assert.deepEqual(detect(astro.root).suggestedConfig.components.include, ['src/components/**/*.astro'])
  } finally {
    astro.cleanup()
  }
  const none = repo({ 'package.json': { name: 'acme' }, 'src/styles/theme.css': THEME })
  try {
    assert.deepEqual(detect(none.root).suggestedConfig.components.include, [])
  } finally {
    none.cleanup()
  }
})

test('a workspace root names the framework and styling its packages use when it names none of its own', () => {
  const r = repo(PER_COMPONENT)
  try {
    const out = detect(r.root)
    assert.equal(out.framework, 'vite-react')
    assert.deepEqual(out.styling, ['vanilla-extract'])
  } finally {
    r.cleanup()
  }
  // The runtime in a package is enough, and so are *.css.ts files alone.
  const runtime = repo({
    'package.json': { name: 'acme', private: true, workspaces: ['packages/*'] },
    'packages/ui/package.json': { name: '@acme/ui', dependencies: { react: '18', vite: '5', '@vanilla-extract/css': '1' } },
    'packages/ui/src/components/Button.tsx': COMPONENT,
  })
  try {
    const out = detect(runtime.root)
    assert.equal(out.framework, 'vite-react')
    assert.deepEqual(out.styling, ['vanilla-extract'])
  } finally {
    runtime.cleanup()
  }
  const files = repo({ 'package.json': { name: 'acme', dependencies: { react: '18', vite: '5' } }, 'src/components/Button.tsx': COMPONENT, 'src/components/button.css.ts': 'export const root = {}\n' })
  try {
    assert.deepEqual(detect(files.root).styling, ['vanilla-extract'])
  } finally {
    files.cleanup()
  }
})

test('a package inside a workspace reads what the workspace root installs and its story tool config', (t) => {
  if (!hasGit()) return t.skip('git is not installed')
  const r = repo({
    'package.json': { name: 'acme', private: true, devDependencies: { react: '18', vite: '5', '@ladle/react': '4' } },
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    '.ladle/config.mjs': 'export default {}\n',
    'packages/ui/package.json': { name: '@acme/ui', peerDependencies: { react: '18' } },
    'packages/ui/src/components/Button.tsx': COMPONENT,
    'packages/ui/src/components/Button.stories.tsx': "export default { title: 'Button' }\n",
    'packages/tokens/package.json': { name: '@acme/tokens' },
    'packages/tokens/src/tokens.css': THEME,
  })
  try {
    assert.equal(git(r.root, 'init', '-q').status, 0)
    const ui = detect(join(r.root, 'packages/ui'))
    assert.equal(ui.framework, 'vite-react')
    assert.deepEqual(ui.storyTools.tools, ['ladle'])
    assert.equal(ui.devPort, 5173)
    // A package that holds no stories gets no story tool from the root.
    const tokens = detect(join(r.root, 'packages/tokens'))
    assert.deepEqual(tokens.storyTools.tools, [])
    assert.equal(tokens.adoptable, undefined)
    // A folder the workspace does not name reads only its own.
    mkdirSync(join(r.root, 'tools/lint'), { recursive: true })
    writeFileSync(join(r.root, 'tools/lint/package.json'), '{ "name": "lint" }\n')
    assert.equal(detect(join(r.root, 'tools/lint')).framework, 'unknown')
  } finally {
    r.cleanup()
  }
})

test('style files: a comment that mentions Tailwind is not Tailwind, and a file with no custom property does not lead the token sources', () => {
  const r = repo({
    'package.json': { name: 'acme', dependencies: { react: '18', vite: '5' } },
    'src/components/Button.tsx': COMPONENT,
    'src/styles/bridge.css': "/**\n * For a Tailwind app, import this file first:\n *   @import 'tailwindcss';\n */\n@import './tokens.css';\n",
    'src/styles/tokens.css': THEME,
    // A real Tailwind entry: its @source glob holds a "/*" that is no comment.
    'src/app.css': '@source "../src/**/*.tsx";\n@import "tailwindcss";\n/* the app\'s entry */\n',
  })
  try {
    const out = detect(r.root)
    assert.deepEqual(out.styling, ['tailwind4'])
    assert.deepEqual(out.styleFiles, [
      { file: 'src/styles/tokens.css', customProps: 5, theme: false },
      { file: 'src/app.css', customProps: 0, theme: true },
    ])
  } finally {
    r.cleanup()
  }
  const commented = repo({ 'package.json': { name: 'acme' }, 'src/styles/bridge.css': "/* @import 'tailwindcss'; and @tailwind base; */\n:root { --x: 1px; }\n" })
  try {
    const out = detect(commented.root)
    assert.deepEqual(out.styling, ['css'])
    assert.deepEqual(out.styleFiles, [])
  } finally {
    commented.cleanup()
  }
})

test('the start skill says when to keep the root, when to pick a package, and how the package reaches init', () => {
  const skill = readFileSync(join(SCRIPTS, '..', 'skills', 'start', 'SKILL.md'), 'utf8')
  const kickoff = skill.slice(skill.indexOf('## Kickoff'), skill.indexOf('## Resume'))
  assert.match(kickoff, /the `monorepo` flag alone does not tell which/)
  assert.match(kickoff, /\*\*The root, with globs into the packages\*\*, when the design system spans packages/)
  assert.match(kickoff, /one package per component/)
  assert.match(kickoff, /`packages\/\*\/src\/\*\*\/\*\.\{tsx,jsx\}`/)
  assert.match(kickoff, /\*\*One package\*\*, when the root holds packages and nothing of its own: detect lists `nestedPackages`/)
  assert.match(kickoff, /A chosen package reaches init through `--root <package>` \(step 4\)/)
  assert.match(kickoff, /init\.mjs --config-json '<json>'`[^\n]*with `--root <package>` when step 1 chose a package/)
  assert.doesNotMatch(kickoff, /If the repo is a monorepo, ask which package/)
})
