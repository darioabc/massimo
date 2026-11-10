// What the scripts read as the repo's source, and what detect suggests from
// it: Tailwind that comes through Nuxt's module, the dark selector the app
// sets, a top-level components folder, files git ignores, folders that hold
// no UI styling, the token sources and the outputs massimo builds, and Sass
// partials loaded with @use and @forward.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { walk } from '../scripts/lib/glob.mjs'
import { SCRIPTS } from './helpers.mjs'

const hasGit = () => spawnSync('git', ['--version']).status === 0
const run = (name, root, args = []) => spawnSync(process.execPath, [join(SCRIPTS, `${name}.mjs`), ...args, '--root', root], { encoding: 'utf8', env: { ...process.env, MASSIMO_TODAY: '2026-01-01' } })
const detect = (root) => {
  const r = run('detect', root)
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
const readJsonAt = (root, ...parts) => JSON.parse(readFileSync(join(root, ...parts), 'utf8'))

// A throwaway repo with these files (an object is written as JSON), removed
// after `fn` runs; with `git`, a git checkout with nothing committed.
function repo(files, fn, { git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-sources-'))
  try {
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(root, f, '..'), { recursive: true })
      writeFileSync(join(root, f), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
    }
    if (git) assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0)
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// A Nuxt 3 app whose Tailwind comes only through Nuxt's Tailwind module: no
// tailwindcss dependency, and no @tailwind lines, which the module injects.
const NUXT = {
  'package.json': { dependencies: { nuxt: '^3.16.0', vue: '^3.5.0', '@nuxtjs/tailwindcss': '^6.14.0' } },
  'nuxt.config.ts': "export default defineNuxtConfig({ modules: ['@nuxtjs/tailwindcss'] })\n",
  'tailwind.config.ts': "export default { content: ['./components/**/*.vue'] }\n",
  'assets/css/main.css': 'body { margin: 0; }\n',
  'components/AppButton.vue': '<template><button class="px-4"><slot /></button></template>\n',
  'components/AppCard.vue': '<template><div class="rounded"><slot /></div></template>\n',
  'pages/index.vue': '<template><AppCard><AppButton>Go</AppButton></AppCard></template>\n',
}
const deps = (more) => ({ 'package.json': { dependencies: { nuxt: '^3.16.0', vue: '^3.5.0', ...more } } })

test("Tailwind that comes only through Nuxt's Tailwind module is detected with its version, and its config is a token source", () => {
  repo(NUXT, (root) => {
    const out = detect(root)
    assert.deepEqual(out.styling, ['tailwind3'])
    assert.equal(out.suggestedConfig.tokens.tailwindConfig, 'tailwind.config.ts')
  })
  // Version 7 of the module is Tailwind 4.
  repo({ ...NUXT, ...deps({ '@nuxtjs/tailwindcss': '^7.0.0' }) }, (root) => assert.deepEqual(detect(root).styling, ['tailwind4']))
  // The module of no readable version, or a Tailwind config with no other sign, is Tailwind 3.
  repo({ ...NUXT, ...deps({ '@nuxtjs/tailwindcss': 'latest' }) }, (root) => assert.deepEqual(detect(root).styling, ['tailwind3']))
  repo({ ...NUXT, ...deps({}) }, (root) => assert.deepEqual(detect(root).styling, ['tailwind3']))
  // Neither: plain CSS, as before.
  const plain = Object.fromEntries(Object.entries({ ...NUXT, ...deps({}) }).filter(([f]) => f !== 'tailwind.config.ts'))
  repo(plain, (root) => assert.deepEqual(detect(root).styling, ['css']))
})

test('the dark selector detect suggests is the one the app sets: the class of the color-mode module, else a Tailwind 3 darkMode', () => {
  const dark = (files) =>
    repo({ ...NUXT, ...files }, (root) => {
      const out = detect(root)
      return [out.suggestedConfig.tokens.darkSelector, out.suggestedConfig.tokens.darkMedia, out.darkMode?.from ?? null]
    })
  assert.deepEqual(dark({ 'tailwind.config.ts': "export default {\n  // darkMode: 'media',\n  darkMode: 'class',\n  content: [],\n}\n" }), ['.dark', false, 'tailwind.config.ts darkMode'])
  assert.deepEqual(dark({ 'tailwind.config.ts': "export default { darkMode: ['selector', '[data-mode=\"dark\"]'] }\n" }), ['[data-mode="dark"]', false, 'tailwind.config.ts darkMode'])
  // The media query, Tailwind's default, keeps massimo's defaults, and the report adds nothing.
  assert.deepEqual(dark({ 'tailwind.config.ts': "export default { darkMode: 'media' }\n" }), ['[data-theme="dark"]', true, null])
  repo(NUXT, (root) => assert.equal('darkMode' in detect(root), false))
  // The color-mode module sets its class on <html>: '-mode' is its suffix by default before version 4, none since.
  const modules = "modules: ['@nuxtjs/tailwindcss', '@nuxtjs/color-mode']"
  const colorMode = (version, options = '') => ({ ...deps({ '@nuxtjs/tailwindcss': '^6.14.0', '@nuxtjs/color-mode': version }), 'nuxt.config.ts': `export default defineNuxtConfig({ ${modules}${options} })\n` })
  assert.deepEqual(dark(colorMode('^3.5.2')), ['.dark-mode', false, '@nuxtjs/color-mode'])
  assert.deepEqual(dark(colorMode('^4.1.0')), ['.dark', false, '@nuxtjs/color-mode'])
  // Its options as the config sets them win over Tailwind's darkMode.
  assert.deepEqual(dark({ ...colorMode('^3.5.2', ", colorMode: { classSuffix: '', preference: 'dark' }"), 'tailwind.config.ts': "export default { darkMode: ['class', '.night'] }\n" }), ['.dark', false, '@nuxtjs/color-mode'])
  // The options given with the module win over its config key.
  const inline = { ...deps({ '@nuxtjs/color-mode': '^3.5.2' }), 'nuxt.config.ts': "export default defineNuxtConfig({ modules: [['@nuxtjs/color-mode', { classPrefix: 'theme-' }]], colorMode: { classPrefix: 'x-', classSuffix: '' } })\n" }
  assert.deepEqual(dark(inline), ['.theme-dark', false, '@nuxtjs/color-mode'])
  // A computed option cannot be read without running the config, so Tailwind's darkMode stands.
  assert.deepEqual(dark({ ...colorMode('^3.5.2', ', colorMode: { classSuffix: process.env.SUFFIX }'), 'tailwind.config.ts': "export default { darkMode: 'class' }\n" }), ['.dark', false, 'tailwind.config.ts darkMode'])
})

test('a top-level components folder is a component folder, beside one deeper in the tree', () => {
  const component = (name) => `export const ${name} = () => null\n`
  repo(
    {
      'package.json': { dependencies: { react: '18', vite: '5' } },
      'components/Button.tsx': component('Button'),
      'components/Card.tsx': component('Card'),
      'components/Input.tsx': component('Input'),
      'components/ui/Modal.tsx': component('Modal'),
      'features/cart/components/CartLine.tsx': component('CartLine'),
    },
    (root) => {
      const out = detect(root)
      assert.deepEqual(out.componentDirs, [
        { dir: 'components', count: 4 },
        { dir: 'features/cart/components', count: 1 },
      ])
      assert.deepEqual(out.suggestedConfig.components.include, ['components/**/*.{tsx,jsx}', 'features/cart/components/**/*.{tsx,jsx}'])
    },
  )
  // Nuxt 3's layout, with its components at the top.
  repo(NUXT, (root) => assert.deepEqual(detect(root).componentDirs, [{ dir: 'components', count: 2 }]))
})

test('a file git ignores is never read as source: the file list leaves it out, as git ls-files does', (t) => {
  if (!hasGit()) return t.skip('git is not installed')
  const files = {
    'package.json': { dependencies: { vue: '3', vite: '5' } },
    // The audit and the graph are pointed at the native project on purpose: git alone keeps its copy out.
    'massimo.config.json': {
      version: 1,
      framework: 'vite-vue',
      components: { include: ['src/components/**/*.vue'] },
      consumers: ['src/**/*.vue'],
      audit: { include: ['src/**/*.{css,vue,html}', 'android/**/*.{css,html}'] },
    },
    'src/components/Badge.vue': '<template><span class="badge"><slot /></span></template>\n<style>.badge { color: #1f2937; }</style>\n',
    'src/App.vue': "<script setup>\nimport Badge from './components/Badge.vue'\n</script>\n<template><Badge>New</Badge></template>\n",
    // A generated file git ignores by its name, beside the source it was made from.
    '.gitignore': '*.gen.vue\n',
    'src/Copy.gen.vue': "<script setup>\nimport Badge from './components/Badge.vue'\n</script>\n<template><Badge>Old</Badge></template>\n<style>.x { color: #0a0a0a; }</style>\n",
    // Capacitor's copy of the web build inside the Android project, which its own .gitignore leaves out.
    'android/.gitignore': 'app/src/main/assets/public\n',
    'android/app/src/main/assets/public/index.html': '<style>body { background: #2a1f5c; color: #123456; }</style>\n',
    'android/app/src/main/assets/public/assets/app.css': '.btn { color: #123456; padding: 13px; }\n',
  }
  repo(
    files,
    (root) => {
      assert.deepEqual(
        walk(root).filter((f) => f.startsWith('android/') || f.startsWith('src/')),
        ['android/.gitignore', 'src/App.vue', 'src/components/Badge.vue'],
      )
      // A folder read by design, such as a build, is walked whole when asked.
      assert.ok(walk(root, { gitignore: false }).includes('android/app/src/main/assets/public/index.html'))
      const audit = run('audit', root)
      assert.equal(audit.status, 0, audit.stderr)
      const latest = readJsonAt(root, 'design-system', 'audits', 'latest.json')
      assert.deepEqual([...new Set(latest.findings.map((f) => f.file))], ['src/components/Badge.vue'])
      const graph = run('graph', root)
      assert.equal(graph.status, 0, graph.stderr)
      assert.equal(readJsonAt(root, 'design-system', 'graph.json').nodes.find((n) => n.name === 'Badge').usage, 1)
    },
    { git: true },
  )
})

test('a stylesheet git ignores is not audited, yet still defines the variables a component reads', (t) => {
  if (!hasGit()) return t.skip('git is not installed')
  repo(
    {
      'package.json': { dependencies: { vue: '3', vite: '5' } },
      'massimo.config.json': { version: 1, framework: 'vite-vue', components: { include: ['src/components/**/*.vue'] }, audit: { include: ['src/**/*.{css,vue}'] } },
      // A token stylesheet a build generates, which git ignores.
      '.gitignore': 'src/generated/\n',
      'src/generated/tokens.css': ':root { --brand: #112233; --space-2: 8px; }\n',
      'src/components/Card.vue': '<template><div class="card" /></template>\n<style>.card { color: var(--brand); padding: var(--space-2); }</style>\n',
    },
    (root) => {
      const audit = run('audit', root)
      assert.equal(audit.status, 0, audit.stderr)
      assert.deepEqual(readJsonAt(root, 'design-system', 'audits', 'latest.json').findings, [])
    },
    { git: true },
  )
})

test("detect leaves a Nuxt app's server folder and Capacitor's folders out of the audit, and suggests no token source there", () => {
  const vars = ':root { --a: 1px; --b: 2px; --c: 3px; --d: 4px; --e: 5px; }\n'
  repo(
    {
      ...NUXT,
      'server/api/categories.ts': "export default defineEventHandler(() => [{ name: 'Food', color: '#06b6d4' }])\n",
      'server/utils/email.css': vars,
      // The email templates' theme and the seed data's tokens are not the app's.
      'server/email/theme.ts': "export const theme = { brand: '#4338ca', text: '#374151' }\n",
      'server/data/tokens.json': { color: { brand: { $type: 'color', $value: '#4338ca' } } },
      'capacitor.config.ts': "// webDir: 'www',\nconst config = { appId: 'app.example', webDir: 'native-web' }\nexport default config\n",
      'native-web/offline.html': '<style>body { color: #2a1f5c; }</style>\n',
      'native-web/shell.css': vars,
      'native-web/theme.js': "export const theme = { surface: '#2a1f5c' }\n",
      'android/app/build.gradle': "apply plugin: 'com.android.application'\n",
    },
    (root) => {
      const out = detect(root)
      assert.deepEqual(out.suggestedConfig.audit.exclude, ['**/*.test.*', '**/*.spec.*', '**/*.d.ts', '**/*.stories.*', '**/*.story.*', 'stories/**', 'server/**', 'android/**', 'native-web/**'])
      assert.deepEqual(out.suggestedConfig.tokens.styleFiles, [])
      assert.deepEqual(out.suggestedConfig.tokens.themeFiles, [])
      assert.deepEqual(out.suggestedConfig.tokens.importFiles, [])
    },
  )
  // A webDir in a build folder every script skips, and no native project yet: nothing more.
  repo({ ...NUXT, 'capacitor.config.json': { appId: 'app.example', webDir: '.output/public' } }, (root) =>
    assert.deepEqual(detect(root).suggestedConfig.audit.exclude, ['**/*.test.*', '**/*.spec.*', '**/*.d.ts', '**/*.stories.*', '**/*.story.*', 'stories/**']),
  )
})

test('the Tailwind config is a token source, never audited as raw values', () => {
  repo(
    {
      'package.json': { dependencies: { react: '18', vite: '5', tailwindcss: '3' } },
      'massimo.config.json': {
        version: 1,
        framework: 'vite-react',
        styling: ['tailwind3'],
        tokens: { tailwindConfig: './tailwind.config.js', themeFiles: ['src/theme.ts'] },
        audit: { include: ['**/*.{css,ts,tsx,js,cjs}'] },
      },
      'tailwind.config.js': "module.exports = { theme: { extend: { colors: { brand: { 500: '#6366f1', 700: '#4338ca' } } } } }\n",
      'admin/tailwind.config.cjs': "module.exports = { theme: { colors: { ink: '#1e1b4b' } } }\n",
      'src/theme.ts': "export const theme = { colors: { surface: '#2d2d5e' } }\n",
      'src/Card.tsx': "export const Card = () => <div style={{ color: '#4f46e5' }} />\n",
    },
    (root) => {
      const audit = run('audit', root)
      assert.equal(audit.status, 0, audit.stderr)
      const latest = readJsonAt(root, 'design-system', 'audits', 'latest.json')
      // A theme file is audited as before.
      assert.deepEqual([...new Set(latest.findings.map((f) => f.file))], ['src/Card.tsx', 'src/theme.ts'])
    },
  )
})

// Each style asset's consumers in what scan prints before init, as [file, line, how].
function consumersOf(root) {
  const r = run('adopt', root, ['--json'])
  assert.equal(r.status, 0, r.stderr)
  const inv = JSON.parse(r.stdout)
  return (id) => inv.assets.find((a) => a.id === id).consumers.map((c) => [c.file, c.line, c.how])
}

test('scan sees a Sass @use and @forward of a partial as a consumer', () => {
  const vars = (p) => `:root { ${['a', 'b', 'c', 'd', 'e'].map((n, i) => `--${p}-${n}: ${i + 1}px;`).join(' ')} }\n`
  repo(
    {
      'package.json': { dependencies: { vue: '3', vite: '5', sass: '1' } },
      'src/styles/variables/_colors.scss': vars('color'),
      'src/styles/variables/_radius.scss': vars('radius'),
      'src/styles/variables/index.scss': "@use 'sass:math';\n@use 'colors';\n@forward 'radius';\n",
      'src/styles/main.scss': "@use 'variables';\n",
      'src/main.ts': "import './styles/main.scss'\n",
    },
    (root) => {
      const by = consumersOf(root)
      assert.deepEqual(by('styles:src/styles/variables/_colors.scss'), [['src/styles/variables/index.scss', 2, 'imports']])
      assert.deepEqual(by('styles:src/styles/variables/_radius.scss'), [['src/styles/variables/index.scss', 3, 'imports']])
    },
  )
  // A partial named with its extension, and an @import in a component's Sass style block.
  repo(
    {
      'package.json': { dependencies: { vue: '3', vite: '5', sass: '1' } },
      'src/styles/_colors.scss': vars('color'),
      'src/styles/_radius.scss': vars('radius'),
      'src/styles/_type.scss': vars('type'),
      'src/styles/main.scss': "@import 'colors.scss';\n@use './radius.scss' as r;\n",
      'src/main.ts': "import './styles/main.scss'\n",
      'src/App.vue': '<template><main /></template>\n<style lang="scss">\n@import \'./styles/type\';\n</style>\n',
    },
    (root) => {
      const by = consumersOf(root)
      assert.deepEqual(by('styles:src/styles/_colors.scss'), [['src/styles/main.scss', 1, 'imports']])
      assert.deepEqual(by('styles:src/styles/_radius.scss'), [['src/styles/main.scss', 2, 'imports']])
      assert.deepEqual(by('styles:src/styles/_type.scss'), [['src/App.vue', 3, 'imports']])
    },
  )
})

test("massimo's own token output is neither detect's token source nor a style file scan adopts", () => {
  const props = ':root { --color-a: #111; --color-b: #222; --color-c: #333; --color-d: #444; --color-e: #555; --color-f: #666; }\n'
  const header = '/* Generated by massimo tokens from the token set. Do not edit by hand. */\n\n'
  repo(
    {
      'package.json': { dependencies: { vue: '3', vite: '5', sass: '1' } },
      'massimo.config.json': {
        version: 1,
        framework: 'vite-vue',
        tokens: { styleFiles: ['src/styles/_colors.scss', 'src/styles/tokens.css'], outputs: [{ format: 'css', path: './src/styles/tokens.css' }] },
      },
      'src/styles/tokens.css': `${header}${props}`,
      // An output from before, left under another name, still opens with the header.
      'src/styles/old-tokens.css': `${header}${props}`,
      'src/styles/_colors.scss': ':root { --brand-a: #123; --brand-b: #234; --brand-c: #345; --brand-d: #456; --brand-e: #567; }\n',
      'src/styles/main.scss': "@use 'tokens';\n@use 'colors';\n",
      'src/main.ts': "import './styles/main.scss'\n",
    },
    (root) => {
      assert.deepEqual(detect(root).suggestedConfig.tokens.styleFiles, ['src/styles/_colors.scss'])
      const scan = run('adopt', root)
      assert.equal(scan.status, 0, scan.stderr)
      const inv = readJsonAt(root, 'design-system', 'adopt', 'inventory.json')
      assert.deepEqual(inv.own.styleFiles, ['src/styles/_colors.scss'])
      assert.deepEqual(inv.assets.map((a) => a.id), ['styles:src/styles/_colors.scss'])
      assert.deepEqual(inv.notes, ['tokens.styleFiles names src/styles/tokens.css, which scan leaves out: massimo builds it from the token set.'])
    },
  )
})

test('the start skill says that before init only --root reaches the chosen package', () => {
  const skill = readFileSync(join(SCRIPTS, '..', 'skills', 'start', 'SKILL.md'), 'utf8')
  const kickoff = skill.slice(skill.indexOf('## Kickoff'), skill.indexOf('## Resume'))
  assert.match(kickoff, /Until init has written `massimo\.config\.json` there, only `--root <package>` reaches the package: a script run from inside it before then still reads the repo top\./)
  assert.match(kickoff, /pass the same `--root <package>` to detect and to `adopt\.mjs scan` in step 3 too/)
  assert.match(kickoff, /`node <plugin>\/scripts\/adopt\.mjs scan`, with `--root <package>` when step 1 chose a package,/)
})
