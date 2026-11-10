// A Nuxt app's story lane: detect leaves the lane folder out of the audit in
// the app's source folder (app/ in Nuxt 4's layout), and the Nuxt recipe
// places the lane, its stories and its build by that folder.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { SCRIPTS, read } from './helpers.mjs'

// A scratch repo holding `files`, as { root, cleanup }.
function repoOf(files) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-nuxt-lane-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const auditExclude = (files) => {
  const t = repoOf(files)
  try {
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'detect.mjs'), '--root', t.root], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout).suggestedConfig.audit.exclude
  } finally {
    t.cleanup()
  }
}

const NUXT4 = {
  'package.json': '{ "dependencies": { "nuxt": "^4.1.0" } }',
  'nuxt.config.ts': 'export default defineNuxtConfig({})\n',
  'app/app.vue': '<template><NuxtPage /></template>\n',
  'app/components/TheHeader.vue': '<template><header /></template>\n',
  'app/pages/index.vue': '<template><TheHeader /></template>\n',
}
const DEFAULT_EXCLUDE = ['**/*.test.*', '**/*.spec.*', '**/*.d.ts', '**/*.stories.*', '**/*.story.*']

test('detect leaves a Nuxt 4 app\'s lane folder out of the audit, in app/', () => {
  assert.deepEqual(auditExclude(NUXT4), [...DEFAULT_EXCLUDE, 'app/stories/**'])
  // A srcDir the config sets is the folder.
  assert.deepEqual(auditExclude({ ...NUXT4, 'nuxt.config.ts': "export default defineNuxtConfig({ srcDir: 'client/' })\n", 'client/components/A.vue': '<template><a /></template>\n' }), [...DEFAULT_EXCLUDE, 'client/stories/**'])
})

test('detect names the lane folder once when a Nuxt 4 app already has the lane', () => {
  const lane = {
    ...NUXT4,
    'package.json': '{ "dependencies": { "nuxt": "^4.1.0" }, "scripts": { "ds:stories": "STORIES=1 nuxt dev --port 4650" } }',
    'nuxt.config.ts': "const stories = process.env.STORIES === '1'\nexport default defineNuxtConfig({ hooks: { 'pages:extend'(pages) { if (!stories) return; pages.push({ path: '/stories', file: '~/stories/StoriesIndex.vue' }) } } })\n",
    'app/stories/StoriesIndex.vue': '<template><main /></template>\n',
  }
  assert.deepEqual(auditExclude(lane), [...DEFAULT_EXCLUDE, 'app/stories/**'])
})

test('a Nuxt 3 app, and an app that is not Nuxt, get the stories exclude they got before', () => {
  assert.deepEqual(
    auditExclude({
      'package.json': '{ "dependencies": { "nuxt": "^3.12.0" } }',
      'nuxt.config.ts': 'export default defineNuxtConfig({})\n',
      'components/TheHeader.vue': '<template><header /></template>\n',
      'pages/index.vue': '<template><TheHeader /></template>\n',
      'app/router.options.ts': 'export default {}\n',
    }),
    [...DEFAULT_EXCLUDE, 'stories/**'],
  )
  assert.deepEqual(auditExclude({ 'package.json': '{ "dependencies": { "vue": "^3.5.0", "vite": "^5.0.0" } }', 'src/components/A.vue': '<template><a /></template>\n' }), [...DEFAULT_EXCLUDE, 'src/stories/**'])
  assert.deepEqual(auditExclude({ 'package.json': '{ "dependencies": { "vue": "^3.5.0", "vite": "^5.0.0" } }', 'components/A.vue': '<template><a /></template>\n' }), [...DEFAULT_EXCLUDE, 'stories/**'])
})

const recipe = () => read(SCRIPTS, '..', 'skills', 'stories', 'recipes', 'nuxt.md')
const section = (name) => recipe().split(/^## /m).find((part) => part.startsWith(name)) ?? ''

test('the Nuxt recipe places the lane and its stories by Nuxt\'s srcDir, app/ in Nuxt 4, and covers local layers', () => {
  assert.match(section('Where the files go'), /`srcDir`/)
  assert.match(section('Where the files go'), /Nuxt 4: `app\/`/)
  assert.match(section('Where the files go'), /Nuxt 3: the root/)
  assert.match(section('Files'), /^<srcDir>\/stories\/StoriesIndex\.vue/m)
  assert.match(section('Files'), /^<srcDir>\/components\/\*\*\/<Name>\.story\.vue/m)
  assert.match(section('Files'), /^<layer srcDir>\/components\/\*\*\/<Name>\.story\.vue/m)
  // The story pages and the config read the app's and each local layer's components.
  assert.match(section('Story pages'), /'~\/components\/\*\*\/\*\.story\.vue'/)
  assert.match(section('Story pages'), /'~~\/layers\/\*\/app\/components\/\*\*\/\*\.story\.vue'/)
  const config = JSON.parse(`{${/```json\n([\s\S]*?)\n```/.exec(section('Config'))[1]}}`)
  assert.deepEqual(config.stories.include, ['app/components/**/*.story.vue', 'layers/*/app/components/**/*.story.vue'])
  assert.match(section('Config'), /`components\/\*\*\/\*\.story\.vue` and `layers\/\*\/components\/\*\*\/\*\.story\.vue`/)
  assert.match(section('Config'), /`audit\.exclude` holds `<srcDir>\/stories\/\*\*` \(`app\/stories\/\*\*` in Nuxt 4's layout/)
})

test('the Nuxt recipe\'s story build writes its own build and output folders, never the deployable .output', () => {
  const config = section('nuxt.config.ts')
  assert.match(config, /\.\.\.\(stories \? \{ buildDir: '\.nuxt-stories' \} : \{\}\)/)
  assert.match(config, /nitro: \{\n {4}\/\/ …existing nitro options…\n {4}\.\.\.\(stories \? \{ output: \{ dir: '\.output-stories' \} \} : \{\}\),\n {2}\}/)
  assert.match(config, /Merge with any existing `nitro` and `hooks`/)
  assert.match(section('Config'), /Add `\.nuxt-stories` and `\.output-stories` to `\.gitignore`/)
  // The story build's folders hold bundled CSS the audit would read.
  assert.match(section('Config'), /add `\.nuxt-stories\/\*\*` and `\.output-stories\/\*\*` to `audit\.exclude`/)
  // Nuxt links dist only when it is missing, so a story build's link stays until it is deleted.
  assert.match(config, /links `dist` to the public folder it wrote, but only when `dist` is missing/)
  assert.match(config, /Delete it \(`rm dist`, it is a symlink\) before the app's own build or deploy/)
  assert.doesNotMatch(config, /build again/)
})

test('the Nuxt recipe says what global route middleware and i18n do to the story routes, and how Tailwind 4 reads them', () => {
  const routes = section('Routes the app changes')
  assert.match(routes, /Global route middleware/)
  assert.match(routes, /if \(to\.meta\.stories\) return/)
  assert.match(section('Story pages'), /definePageMeta\(\{ stories: true \}\)/)
  assert.match(routes, /`@nuxtjs\/i18n`/)
  assert.match(routes, /`prefix` strategy/)
  // Route meta wins over the default customRoutes mode only from version 10.5.
  assert.match(routes, /From version 10\.5 \(or in earlier 10\.x with `customRoutes: 'meta'`\), `meta: \{ i18n: false \}`/)
  assert.match(routes, /`stories\.url` and `stories\.storyUrl`/)
  const tailwind = section('Tailwind')
  assert.match(tailwind, /Tailwind 4 through `@tailwindcss\/vite`/)
  // Tailwind scans from Vite's root, which Nuxt sets to srcDir, so a local layer needs an @source.
  assert.match(tailwind, /from Vite's root, which Nuxt sets to `srcDir`/)
  assert.match(tailwind, /A local layer's story files sit outside `srcDir`, so it reads them only through an `@source` that covers the layer/)
  assert.match(tailwind, /Tailwind 4 through `@nuxtjs\/tailwindcss` 7/)
})

test('the stories skill leaves the lane folder out of the audit when no exclude covers it', () => {
  const skill = read(SCRIPTS, '..', 'skills', 'stories', 'SKILL.md')
  assert.match(skill, /when no glob in `audit\.exclude` covers the lane's folder yet/)
  assert.match(skill, /Do the same for each folder the story build writes that the config's `ignore` does not skip \(Nuxt's `\.nuxt-stories\/` and `\.output-stories\/`\)/)
})
