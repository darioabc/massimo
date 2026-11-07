// Setting a project up in repos that do not look like the default: no src/
// folder, no package.json, a project folder other than design-system, an
// older project's .gitignore, and no tokens at all.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig, scriptCommand } from '../scripts/lib/project.mjs'
import { SCRIPTS, read } from './helpers.mjs'

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-setup-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const script = (name, root, args = []) => spawnSync(process.execPath, [join(SCRIPTS, `${name}.mjs`), ...args, '--root', root], { encoding: 'utf8' })

test('detect: a repo with no src/ gets an audit that reads its own tree', () => {
  const r = repo({ 'package.json': '{"dependencies":{"react":"18","vite":"5"}}', 'components/Button.tsx': 'export default 1' })
  try {
    const out = JSON.parse(script('detect', r.root).stdout)
    assert.equal(out.suggestedConfig.audit.include[0], '**/*.{css,scss,sass,less,tsx,jsx,ts,js,vue,svelte,astro,html}')
    assert.ok(out.suggestedConfig.audit.exclude.includes('stories/**'))
    assert.ok(!out.suggestedConfig.audit.exclude.some((g) => g.startsWith('src/')))
  } finally {
    r.cleanup()
  }
})

test('detect: nested apps, the Tailwind version, token files and a story tool stylesheet', () => {
  const theme = ':root { --a: 1px; --b: 2px; --c: 3px; --d: 4px; --e: 5px; }\n'
  const r = repo({
    'package.json': '{"dependencies":{"react":"18","vite":"5","tailwindcss":"^3.4.0"}}',
    // Tailwind 4 syntax in a nested app's CSS does not make this repo Tailwind 4.
    'sae/package.json': '{"dependencies":{"nuxt":"3"}}',
    'sae/assets/main.css': '@import "tailwindcss";\n' + theme,
    'src/styles/app.css': '@tailwind base;\n' + theme,
    '.ladle/ladle.css': '@import "tailwindcss";\n' + theme,
    // A token file has DTCG or Tokens Studio markers; a plain value/type pair in config does not count.
    'tokens/brand.json': '{ "color": { "brand": { "$value": "#0f766e", "$type": "color" } } }',
    'src/data/settings.json': '{ "value": 3, "label": "x" }',
  })
  try {
    const out = JSON.parse(script('detect', r.root).stdout)
    assert.deepEqual(out.nestedPackages, ['sae/'])
    assert.ok(out.styling.includes('tailwind3') && !out.styling.includes('tailwind4'), out.styling.join())
    assert.deepEqual(out.suggestedConfig.tokens.styleFiles, ['src/styles/app.css'])
    assert.deepEqual(out.suggestedConfig.tokens.importFiles, ['tokens/brand.json'])
    assert.deepEqual(out.storyTools.tools, ['ladle'])
  } finally {
    r.cleanup()
  }
})

test('detect: a gated story lane the repo already built is the lane, configured, never scaffolded over', () => {
  const r = repo({
    'package.json': JSON.stringify({ dependencies: { astro: '5' }, scripts: { 'stories:dev': 'STORIES=1 astro dev --port 4330', 'stories:build': 'STORIES=1 astro build --outDir dist-stories' } }),
    'astro.config.mjs': "import stories from './stories-integration.mjs'\nexport default { integrations: [stories()] }\n",
    'stories-integration.mjs': "export default () => ({ name: 'lane', hooks: { 'astro:config:setup': () => { if (process.env.STORIES !== '1') return } } })\n",
    'src/stories/manifest.ts': 'export const stories = []\n',
    'src/stories/index.astro': '---\n---\n',
    'src/stories/StoryFrame.astro': '---\n---\n',
    'src/stories/pages/button.astro': '---\n---\n',
    'src/stories/pages/card.astro': '---\n---\n',
    'src/components/Button.astro': '---\n---\n',
  })
  try {
    const out = JSON.parse(script('detect', r.root).stdout)
    assert.deepEqual(out.storyTools.lane, { dir: 'src/stories', manifest: 'src/stories/manifest.ts', index: 'src/stories/index.astro', gate: 'astro.config.mjs', devScript: 'stories:dev', port: 4330, pages: 2, files: 5 })
    assert.deepEqual(out.suggestedConfig.stories.include, ['src/stories/pages/**/*.{astro,tsx,jsx,vue,svelte,ts}'])
    assert.equal(out.suggestedConfig.stories.devCommand, 'npm run stories:dev')
    assert.equal(out.suggestedConfig.stories.url, 'http://localhost:4330/stories')
  } finally {
    r.cleanup()
  }
  // No gate, no lane: a stories folder alone is not one.
  const plain = repo({ 'package.json': '{"dependencies":{"astro":"5"}}', 'src/stories/index.astro': '---\n---\n' })
  try {
    assert.equal(JSON.parse(script('detect', plain.root).stdout).storyTools.lane, null)
  } finally {
    plain.cleanup()
  }
})

test('the skills never scaffold a lane over files that exist, and edit the framework config rather than stop at it', () => {
  const skill = read(SCRIPTS, '..', 'skills', 'stories', 'SKILL.md')
  assert.match(skill, /check every file the recipe creates/)
  assert.match(skill, /The framework's own config .* always exists: edit it to register the lane, never replace it/)
  assert.match(skill, /If detect reports `storyTools.lane`/)
})

test('detect: the lane folder is the one the gate names, ports and dev scripts read the way frameworks write them', () => {
  const lane = (files) => {
    const r = repo(files)
    try {
      return JSON.parse(script('detect', r.root).stdout)
    } finally {
      r.cleanup()
    }
  }
  // A barrel named stories/index elsewhere is not the lane; the gate names src/lab/stories.
  const named = lane({
    'package.json': JSON.stringify({ dependencies: { astro: '5' }, scripts: { 'lab:build': 'STORIES=1 astro build', 'lab:dev': 'STORIES=1 astro dev -p 4400' } }),
    'astro.config.mjs': "import lane from './lane.mjs'\nexport default { integrations: [lane()] }\n",
    'lane.mjs': "export default () => ({ hooks: { 'astro:config:setup': ({ injectRoute }) => { if (process.env.STORIES !== '1') return; injectRoute({ pattern: '/stories', entrypoint: './src/lab/stories/index.astro' }) } } })\n",
    'src/lab/stories/index.astro': '---\n---\n',
    'src/lab/stories/StoryFrame.astro': '---\n---\n',
    'src/components/stories/index.ts': 'export {}\n',
    'src/components/Button.astro': '---\n---\n',
  })
  assert.equal(named.storyTools.lane.dir, 'src/lab/stories')
  assert.equal(named.storyTools.lane.devScript, 'lab:dev') // never the build
  assert.equal(named.storyTools.lane.port, 4400) // -p
  // No pages folder: the stories are *.story.* files, never the lane's frames.
  assert.deepEqual(named.suggestedConfig.stories.include, ['src/**/*.story.{astro,tsx,jsx,vue,svelte}'])
  assert.ok(named.suggestedConfig.audit.exclude.includes('src/lab/stories/**'))
  // Two folders and the gate names neither: no lane is guessed.
  const unsure = lane({
    'package.json': JSON.stringify({ dependencies: { astro: '5' }, scripts: { stories: 'STORIES=1 astro dev' } }),
    'src/stories/index.astro': '---\n---\n',
    'src/lab/stories/manifest.ts': 'export {}\n',
  })
  assert.deepEqual(unsure.storyTools.lane, { dir: null, candidates: ['src/lab/stories', 'src/stories'] })
  assert.ok(!unsure.suggestedConfig.stories.devCommand)
  // No port given: the framework's default, and a URL built from it; one npm run hop is followed.
  const plain = lane({
    'package.json': JSON.stringify({ dependencies: { astro: '5' }, scripts: { 'stories:dev': 'STORIES=1 astro dev', 'ds:stories': 'npm run stories:dev' } }),
    'src/stories/index.astro': '---\n---\n',
  })
  assert.equal(plain.storyTools.lane.port, 4321)
  assert.equal(plain.suggestedConfig.stories.url, 'http://localhost:4321/stories')
  // massimo's Nuxt recipe: its index is stories/StoriesIndex.vue.
  const nuxt = lane({
    'package.json': JSON.stringify({ dependencies: { nuxt: '3' }, scripts: { 'ds:stories': 'STORIES=1 nuxt dev --port 4650' } }),
    'nuxt.config.ts': "export default { hooks: { 'pages:extend'(p) { if (process.env.STORIES !== '1') return } } }\n",
    'stories/StoriesIndex.vue': '<template />\n',
    'components/Button.story.vue': '<template />\n',
  })
  assert.equal(nuxt.storyTools.lane.dir, 'stories')
  assert.equal(nuxt.storyTools.lane.port, 4650)
})

test('init: no package.json gives a warning with the node command, and STATUS.md names no phase yet', () => {
  const r = repo({ 'components/Button.tsx': 'export default 1' })
  try {
    const out = JSON.parse(script('init', r.root).stdout)
    assert.ok(out.warnings.some((w) => /no package\.json, so no npm scripts were added; run the scripts with node, for example node design-system\/scripts\/serve\.mjs/.test(w)))
    assert.match(read(r.root, 'design-system', 'STATUS.md'), /Choose the phases with `\/massimo:start`/)
    assert.match(read(r.root, 'design-system', '.gitignore'), /^shots\/\*\n!shots\/kept\/$/m)
  } finally {
    r.cleanup()
  }
})

test('init: an older project that ignores all of shots/ is told how to keep linked screenshots', () => {
  const r = repo({ 'package.json': '{}', 'design-system/.gitignore': 'shots/\n', 'design-system/state.json': '{"phases":[]}' })
  try {
    const out = JSON.parse(script('init', r.root, ['--no-npm-scripts']).stdout)
    assert.ok(out.warnings.some((w) => /ignores all of shots\/; replace that line with "shots\/\*" and "!shots\/kept\/"/.test(w)))
  } finally {
    r.cleanup()
  }
})

test('a project folder other than design-system: token source and commands follow it', () => {
  const r = repo({ 'massimo.config.json': '{"projectDir":".massimo"}' })
  try {
    const { config, projectDir } = loadConfig({ root: r.root })
    assert.equal(config.tokens.source, '.massimo/tokens/tokens.resolver.json') // a new project starts in 2025.10
    mkdirSync(join(r.root, '.massimo', 'tokens'), { recursive: true })
    writeFileSync(join(r.root, '.massimo', 'tokens', 'tokens.json'), '{}')
    assert.equal(loadConfig({ root: r.root }).config.tokens.source, '.massimo/tokens/tokens.json') // an older project keeps its file
    assert.equal(scriptCommand(r.root, projectDir, 'tokens', 'build'), 'node .massimo/scripts/tokens.mjs build')
  } finally {
    r.cleanup()
  }
})

test('kit: a blank project gets one, so the design loop can start before there are tokens', () => {
  const r = repo({ 'massimo.config.json': '{}' })
  try {
    const out = script('tokens', r.root, ['kit'])
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /no tokens yet, so system defaults/)
    const kit = read(r.root, 'design-system', 'kit', 'kit.css')
    assert.match(kit, /No tokens yet: mockups use system defaults until the tokens phase\./)
    assert.match(kit, /font-family: system-ui, sans-serif;/)
    assert.equal(script('tokens', r.root, ['preview']).status, 1) // nothing to preview yet
  } finally {
    r.cleanup()
  }
})
