// The design system folder: tokens as lists with nothing dropped silently,
// a page per component from its graph node, a still preview from a built
// story page, and a record of what was published.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { PAGE_MARK, SECTION_MARK, builtPagePaths, colorValueOk, componentId, componentReadme, contentTypeOf, fontFaces, isMedia, listTokens, previewFromPage, rewriteCssUrls, sectionsFor, selectElement, themeScript } from '../scripts/lib/artifact.mjs'
import { read, readJson, run, scratch } from './helpers.mjs'

const entry = (cssVar, type, values, more = {}) => ({ name: cssVar.replace(/^--/, '').replace(/-/g, '.'), cssVar, type, description: '', values, aliases: {}, ...more })

test('a colour the views can show is a hex or a function with plain arguments', () => {
  for (const ok of ['#fff', '#0A0B0C', '#11223344', 'rgb(0 0 0 / 0.5)', 'oklch(0.5 0.1 200)', 'color(display-p3 1 0 0)']) assert.ok(colorValueOk(ok), ok)
  for (const bad of ['red', 'var(--x)', 'color-mix(in oklab, red 50%, blue)', 'rgb(var(--ink))', 'currentColor', 12]) assert.ok(!colorValueOk(bad), String(bad))
})

test('tokens become lists: a value per theme, references kept, families by what a token is', () => {
  const set = {
    modes: ['light', 'dark'],
    entries: [
      entry('--ink-900', 'color', { light: '#111111', dark: '#111111' }),
      entry('--paper', 'color', { light: '#ffffff', dark: '#000000' }, { description: 'The page.' }),
      entry('--text', 'color', { light: '#111111', dark: '#eeeeee' }, { aliases: { light: '--ink-900', dark: null } }),
      entry('--space-4', 'dimension', { light: '1rem', dark: '1rem' }),
      entry('--radius-card', 'dimension', { light: '8px', dark: '8px' }),
      entry('--nav-height', 'dimension', { light: '3.5rem', dark: '3.5rem' }),
      entry('--shadow-card', 'shadow', { light: '0 1px 2px #0000001a', dark: '0 1px 2px #00000080' }),
      entry('--font-body', 'fontFamily', { light: '"Acme Sans", system-ui, sans-serif', dark: '"Acme Sans", system-ui, sans-serif' }),
      entry('--text-body', 'typography', { light: '400 1rem/1.5 "Acme Sans", system-ui, sans-serif' }, { parts: { fontFamily: '"Acme Sans", system-ui, sans-serif', fontSize: '1rem', fontWeight: '400', lineHeight: '1.5' } }),
    ],
  }
  const { doc, left } = listTokens(set, { name: 'Acme' })
  assert.deepEqual(left, [])
  assert.deepEqual(doc.color.themes, [{ id: 'light', name: 'Light' }, { id: 'dark', name: 'Dark' }])
  assert.deepEqual(doc.color.tokens, [
    { name: 'ink-900', value: '#111111', usage: '' },
    { name: 'paper', value: { light: '#ffffff', dark: '#000000' }, usage: 'The page.' },
    { name: 'text', value: { light: '{ink-900}', dark: '#eeeeee' }, usage: '' },
  ])
  assert.deepEqual(doc.spacing.tokens.map((t) => t.name), ['space-4'])
  assert.deepEqual(doc.radius.tokens.map((t) => t.name), ['radius-card'])
  assert.deepEqual(doc.size.tokens, [{ name: 'nav-height', value: '3.5rem', usage: '' }])
  assert.deepEqual(doc.shadow.tokens[0].value, { light: '0 1px 2px #0000001a', dark: '0 1px 2px #00000080' })
  assert.deepEqual(doc.type.families, { body: '"Acme Sans", system-ui, sans-serif' })
  assert.deepEqual(doc.type.groups, [{ name: 'Text', family: 'body', styles: [{ name: 'text-body', fontSize: '1rem', lineHeight: '1.5', fontWeight: 400 }] }])
})

test('what the lists cannot hold is left with a reason and written as a section', () => {
  const set = {
    modes: ['light', 'dark'],
    entries: [
      entry('--mix', 'color', { light: 'color-mix(in oklab, red 50%, blue)', dark: '#000' }),
      entry('--dur-1', 'duration', { light: '120ms', dark: '120ms' }, { description: 'A press.' }),
      entry('--ease-out', 'cubicBezier', { light: 'cubic-bezier(0.2, 0, 0, 1)', dark: 'cubic-bezier(0.2, 0, 0, 1)' }),
      entry('--rule', 'border', { light: '1px solid #000', dark: '1px solid #fff' }),
      entry('--lift', 'css', { light: 'drop-shadow(0 1px 0 #000)', dark: 'drop-shadow(0 1px 0 #000)' }, { cssOnly: true }),
      entry(`--${'x'.repeat(70)}`, 'dimension', { light: '1px', dark: '1px' }),
    ],
  }
  const { doc, left } = listTokens(set)
  assert.equal(doc.color, undefined)
  assert.deepEqual(left.map((t) => [t.name.slice(0, 8), t.section]), [['lift', 'more-tokens'], ['xxxxxxxx', 'more-tokens'], ['mix', 'more-tokens'], ['dur-1', 'motion'], ['ease-out', 'motion'], ['rule', 'borders']])
  assert.match(left.find((t) => t.name === 'mix').reason, /not a plain colour/)
  const sections = sectionsFor(left, set.modes)
  assert.deepEqual(Object.keys(sections), ['motion.md', 'borders.md', 'more-tokens.md'])
  assert.ok(sections['motion.md'].startsWith(`${SECTION_MARK}\n# Motion\n`))
  assert.match(sections['motion.md'], /\| `--dur-1` \| `120ms` \| A press\. \|/)
  // A value that differs by theme gets a column per theme.
  assert.match(sections['borders.md'], /\| Token \| Light \| Dark \| Use \|/)
  assert.match(sections['more-tokens.md'], /\| `--lift` \| .* \| a CSS-only value \|/)
})

test('a family past its cap leaves the rest for a section', () => {
  const entries = Array.from({ length: 62 }, (_, i) => entry(`--space-${i}`, 'dimension', { light: `${i}px` }))
  const { doc, left } = listTokens({ modes: ['light'], entries })
  assert.equal(doc.spacing.tokens.length, 60)
  assert.equal(left.length, 2)
  assert.match(left[0].reason, /past the 60 tokens/)
})

test("a component's page: the rule as its first sentence, then what the graph knows", () => {
  const node = {
    name: 'Button',
    file: 'src/components/Button.tsx',
    group: 'Primitives / Actions',
    stories: ['src/stories/pages/button/index.astro'],
    exports: ['Button'],
    composes: ['Icon'],
    composedBy: { components: ['src/components/Card.tsx'], routes: ['src/pages/index.astro'] },
    props: [{ name: 'variant', values: ['primary', 'ghost'] }, { name: 'label' }],
    states: ['disabled'],
    style: { classes: { daisyui: ['btn'] }, tokens: ['color.accent'], cssVars: ['--space-2'] },
    rules: { 'use-when': 'a reader presses or follows something.', never: 'two primaries in one view.', theme: 'print' },
  }
  const md = componentReadme(node)
  assert.ok(md.endsWith(`\n\n${PAGE_MARK}\n`))
  assert.match(md, /^# Button\n\nUse when: a reader presses or follows something\.\n/)
  assert.match(md, /- Group: Primitives \/ Actions\n- Source: `src\/components\/Button\.tsx`\n- Story: `src\/stories\/pages\/button\/index\.astro`/)
  assert.match(md, /## Rules\n\n- Never: two primaries in one view\.\n- theme: print\n/)
  assert.match(md, /\| `variant` \| `primary`, `ghost` \|/)
  assert.match(md, /- daisyui classes: `btn`\n- Tokens: `color\.accent`\n- CSS variables: `--space-2`/)
  assert.match(md, /2 files import it: `src\/components\/Card\.tsx`, `src\/pages\/index\.astro`\./)
  // No rule yet: the name and group stand in, and nothing is invented.
  assert.match(componentReadme({ name: 'Card', file: 'src/Card.astro', group: 'Components / Cards' }), /^# Card\n\nCard, in Components \/ Cards\.\n/)
  assert.equal(componentId('editor-cards/Step card'), 'editor_cards_Step_card')
})

const PAGE = `<!doctype html><html lang="en" class="no-js"><head><meta charset="utf-8"><title>Button</title>
<link rel="modulepreload" href="/_app/a.js"><link rel="stylesheet" href="/_app/site.css?v=2"><link rel="stylesheet" href="https://fonts.example/x.css">
<style>.hero{background:url(/img/hero.png)}</style><script src="/_app/a.js"></script></head>
<body class="story"><nav><a href="/stories">All stories</a></nav>
<div id="states"><button class="btn">Send</button><img src="/img/icon.svg" srcset="/img/icon.svg 1x, /img/icon@2x.png 2x"><a href="https://example.com">Out</a></div>
<script>window.x=1</script></body></html>`

test('a built story page becomes a still: styles kept, scripts dropped, its files pointed at the copy', () => {
  const made = previewFromPage(PAGE, { group: 'Actions', height: 200, fromDir: 'components/Button', script: 'S()', title: 'Button' })
  assert.match(made.html, /^<!-- @dsCard group="Actions" height=200 -->\n<!doctype html>\n<html lang="en" class="no-js">/)
  assert.ok(!made.html.includes('window.x'))
  assert.ok(!made.html.includes('/_app/a.js'))
  assert.match(made.html, /<link rel="stylesheet" href="\.\.\/\.\.\/site\/_app\/site\.css">/)
  assert.match(made.html, /<link rel="stylesheet" href="https:\/\/fonts\.example\/x\.css">/)
  assert.match(made.html, /<style>\.hero\{background:url\(\.\.\/\.\.\/site\/img\/hero\.png\)\}<\/style>/)
  assert.match(made.html, /<a href="#">All stories<\/a>/)
  assert.match(made.html, /<a href="https:\/\/example\.com">Out<\/a>/)
  assert.match(made.html, /src="\.\.\/\.\.\/site\/img\/icon\.svg" srcset="\.\.\/\.\.\/site\/img\/icon\.svg 1x, \.\.\/\.\.\/site\/img\/icon@2x\.png 2x"/)
  assert.match(made.html, /<body class="story">/)
  assert.match(made.html, /<script>S\(\)<\/script>\n<\/body>/)
  assert.deepEqual(made.stylesheets, ['/_app/site.css'])
  assert.deepEqual(made.assets, ['/img/hero.png', '/img/icon.svg', '/img/icon@2x.png'])
})

test('one element of the page can be the preview, and a page drawn in the browser is not one', () => {
  const made = previewFromPage(PAGE, { fromDir: 'components/Button', select: '#states' })
  assert.ok(!made.html.includes('All stories'))
  assert.match(made.html, /<div id="states"><button class="btn">Send<\/button>/)
  assert.match(previewFromPage(PAGE, { fromDir: 'components/Button', select: '.absent' }).empty, /nothing on the page matches \.absent/)
  const spa = '<html><head></head><body><div id="root"></div><script type="module" src="/a.js"></script></body></html>'
  assert.match(previewFromPage(spa, { fromDir: 'components/Button' }).empty, /drawn in the browser/)
  assert.equal(selectElement('<div class="a b"><div>x</div><p>y</p></div><div>z</div>', '.b'), '<div class="a b"><div>x</div><p>y</p></div>')
  assert.equal(selectElement('<main data-states="1"><i>x</i></main>', '[data-states]'), '<main data-states="1"><i>x</i></main>')
  assert.equal(selectElement('<p>x</p>', 'p > i'), null)
})

test('the theme script follows how the repo switches theme', () => {
  assert.equal(themeScript({ tokens: { darkSelector: '[data-theme="dark"]' } }), '')
  assert.match(themeScript({ tokens: { darkSelector: 'html.dark' } }), /r\.classList\.toggle\("dark",d\)/)
  assert.match(themeScript({ tokens: { darkSelector: '[data-mode=night]' } }), /r\.setAttribute\("data-mode","night"\)/)
  assert.equal(themeScript({ tokens: { darkSelector: '.app .dark > *' } }), '')
})

test('CSS urls, fonts, built page paths and media types', () => {
  const seen = new Set()
  assert.equal(rewriteCssUrls('a{background:url("/img/a.png?x#y")}b{background:url(data:image/png;base64,AA)}c{src:url(//cdn/x.woff2)}', 'site/_app', seen), 'a{background:url("../../site/img/a.png?x#y")}b{background:url(data:image/png;base64,AA)}c{src:url(//cdn/x.woff2)}')
  assert.deepEqual([...seen], ['/img/a.png'])
  const css = '@font-face{font-family:"Acme Sans";src:url(/fonts/acme.woff2) format("woff2");font-weight:100 900;font-style:normal}@font-face{font-family:Remote;src:url(https://x/y.woff2)}@font-face{font-family:Acme Serif;font-weight:bold;src:url("/fonts/serif.woff?v=1")}'
  assert.deepEqual(fontFaces(css), [
    { family: 'Acme Sans', weight: '100 900', style: 'normal', path: '/fonts/acme.woff2' },
    { family: 'Acme Serif', weight: '700', style: 'normal', path: '/fonts/serif.woff' },
  ])
  assert.deepEqual(builtPagePaths('http://localhost:4330/stories/{slug}', 'button'), ['/stories/button/index.html', '/stories/button.html'])
  assert.deepEqual(builtPagePaths('http://localhost:6006/iframe.html?id={id}', 'button'), [])
  assert.equal(contentTypeOf('components/index.d.ts'), 'text/plain')
  assert.equal(contentTypeOf('site/_app/a.CSS'), 'text/css')
  assert.equal(contentTypeOf('fonts/a.woff2'), 'font/woff2')
  assert.ok(isMedia('assets/Logos/mark.svg') && isMedia('assets/Films/a.mp4') && isMedia('assets/a.pdf'))
  assert.ok(!isMedia('assets/Logos/README.md') && !isMedia('assets/Anim/a.json'))
})

// ── The command, on a repo with tokens and on one with a story lane ─────────

const app = scratch('app')
const lane = scratch('adopt')
after(() => {
  app.cleanup()
  lane.cleanup()
})

test('build writes tokens as lists, a page per storied component, the manifest and the report; plan writes nothing', () => {
  assert.equal(run('graph', app).status, 0)
  const plan = run('artifact', app, ['plan'])
  assert.equal(plan.status, 0, plan.stderr)
  assert.match(plan.stdout, /^massimo artifact plan: 11 of 11 tokens in the lists, 3 components \(0 with a preview\), \d+ files, [\d.]+ MB; nothing written\n$/)
  assert.ok(!existsSync(join(app.project, 'artifact')))
  const r = run('artifact', app, ['build'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /note: No build of the story lane, so components have a page and no preview\./)
  const tokens = readJson(app.project, 'artifact', 'project', 'tokens.json')
  assert.deepEqual(tokens.color.themes.map((t) => t.id), ['light', 'dark'])
  assert.ok(tokens.color.tokens.length > 0)
  assert.equal(tokens.meta.source, 'massimo')
  for (const t of tokens.color.tokens) assert.equal(typeof t.usage, 'string')
  const files = readJson(app.project, 'artifact', 'files.json').files
  assert.ok(files.every((f) => f.path.startsWith('project/') && f.bytes > 0 && f.type))
  assert.ok(files.some((f) => f.path === 'project/README.md'))
  const pages = files.filter((f) => /^project\/components\/[^/]+\/README\.md$/.test(f.path))
  assert.equal(pages.length, 3)
  assert.match(read(app.project, 'artifact', 'report.md'), /- Components: 3 with a page, 0 with a preview/)
  assert.equal(read(app.project, 'artifact', '.gitignore'), 'project/\nfiles.json\nreport.md\n')
  // The same inputs give the same bytes.
  const before = read(app.project, 'artifact', 'project', 'tokens.json')
  assert.equal(run('artifact', app, ['build']).status, 0)
  assert.equal(read(app.project, 'artifact', 'project', 'tokens.json'), before)
})

test('a kept file goes over the build, and record then status say when the published copy is behind', () => {
  mkdirSync(join(app.project, 'artifact', 'kept', 'components', 'Cover'), { recursive: true })
  writeFileSync(join(app.project, 'artifact', 'kept', 'components', 'Cover', 'preview.html'), '<!-- @dsCard height=288 -->\n<p>Acme</p>\n')
  writeFileSync(join(app.project, 'artifact', 'kept', 'README.md'), 'Set body copy in `text-body`.\n')
  assert.equal(run('artifact', app, ['build']).status, 0)
  assert.equal(read(app.project, 'artifact', 'project', 'README.md'), 'Set body copy in `text-body`.\n')
  assert.match(read(app.project, 'artifact', 'project', 'components', 'Cover', 'preview.html'), /<p>Acme<\/p>/)

  assert.match(run('artifact', app, ['status']).stdout, /nothing published yet/)
  assert.equal(run('artifact', app, ['record']).status, 2)
  const rec = run('artifact', app, ['record', '--url', 'https://example.com/a/1', '--target', 'static'])
  assert.equal(rec.status, 0, rec.stderr)
  const mirror = readJson(app.project, 'artifact', 'mirror.json')
  assert.equal(mirror.url, 'https://example.com/a/1')
  assert.equal(mirror.target, 'static')
  assert.match(mirror.tokensHash, /^[0-9a-f]{64}$/)
  assert.match(run('artifact', app, ['status']).stdout, /^massimo artifact: current as published on \d{4}-\d\d-\d\d \(https:\/\/example\.com\/a\/1\)\n$/)
  const source = join(app.root, 'design-system', 'tokens', 'tokens.json')
  writeFileSync(source, readFileSync(source, 'utf8').replace(/"\$description": "[^"]*"/, '"$description": "Changed."').replace(/\}\s*$/, ', "space": { "$type": "dimension", "added": { "$value": { "value": 3, "unit": "px" } } } }'))
  assert.match(run('artifact', app, ['status']).stdout, /^massimo artifact: behind the tokens since /)
})

test('previews come from a static build of the story lane, with the files they load', () => {
  const config = join(lane.root, 'massimo.config.json')
  const c = JSON.parse(readFileSync(config, 'utf8'))
  c.stories.storyUrl = 'http://localhost:4330/stories/{slug}'
  c.tokens = { ...c.tokens, darkSelector: 'html.dark' }
  c.artifact = { previewSelect: '#states', title: 'Acme' }
  writeFileSync(config, JSON.stringify(c))
  assert.equal(run('graph', lane).status, 0)
  const built = join(lane.root, 'dist-stories')
  for (const slug of ['button', 'card']) {
    mkdirSync(join(built, 'stories', slug), { recursive: true })
    writeFileSync(join(built, 'stories', slug, 'index.html'), `<html lang="en"><head><link rel="stylesheet" href="/_app/site.css"></head><body><a href="/stories">All</a><div id="states"><button>${slug}</button><img src="/img/${slug}.svg"></div><script src="/_app/a.js"></script></body></html>`)
  }
  mkdirSync(join(built, '_app'), { recursive: true })
  mkdirSync(join(built, 'img'), { recursive: true })
  mkdirSync(join(built, 'fonts'), { recursive: true })
  writeFileSync(join(built, '_app', 'site.css'), '@font-face{font-family:"Acme Sans";src:url(/fonts/acme.woff2);font-weight:400}button{background:url(/img/tile.png)}')
  writeFileSync(join(built, 'img', 'button.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(built, 'img', 'tile.png'), 'png')
  writeFileSync(join(built, 'fonts', 'acme.woff2'), 'font')

  const r = run('artifact', lane, ['build', '--built', 'dist-stories'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /no tokens, 4 components \(3 with a preview\)/)
  const out = join(lane.project, 'artifact', 'project')
  const preview = read(out, 'components', 'Button', 'preview.html')
  assert.match(preview, /^<!-- @dsCard group="Actions" height=320 -->/)
  assert.match(preview, /<div id="states"><button>button<\/button><img src="\.\.\/\.\.\/site\/img\/button\.svg"><\/div>/)
  assert.ok(!preview.includes('All</a>'))
  assert.match(preview, /classList\.toggle\("dark",d\)/)
  // The stylesheet is copied with its own urls pointed at the copies beside it.
  assert.equal(read(out, 'site', '_app', 'site.css'), '@font-face{font-family:"Acme Sans";src:url(../../site/fonts/acme.woff2);font-weight:400}button{background:url(../../site/img/tile.png)}')
  assert.equal(read(out, 'site', 'img', 'tile.png'), 'png')
  assert.equal(read(out, 'site', 'fonts', 'acme.woff2'), 'font')
  // No token set here, so the font is copied for the previews and listed nowhere.
  assert.ok(!existsSync(join(out, 'tokens.json')))
  const report = read(lane.project, 'artifact', 'report.md')
  assert.match(report, /\| pages\/index \| no built page for the story home \|/)
  assert.match(report, /- `\/img\/card\.svg`/)
  assert.match(report, /2\. A Claude design system artifact: /)
})

test('pages keeps a page per component and a section per left-out kind in the project folder, and --check holds them', () => {
  const t = scratch('app')
  try {
    assert.equal(run('graph', t).status, 0)
    const source = join(t.root, 'design-system', 'tokens', 'tokens.json')
    const doc = JSON.parse(readFileSync(source, 'utf8'))
    doc.motion = { $type: 'duration', press: { $value: { value: 120, unit: 'ms' }, $description: 'A press.' } }
    writeFileSync(source, JSON.stringify(doc))
    assert.equal(run('artifact', t, ['pages', '--check']).status, 1)
    const r = run('artifact', t, ['pages'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^massimo artifact pages: 3 component pages, 1 token section in .*; wrote 4, removed 0\n$/)
    assert.ok(read(t.project, 'sections', 'motion.md').startsWith(`${SECTION_MARK}\n# Motion\n`))
    const graph = readJson(t.project, 'graph.json')
    const first = graph.nodes.find((n) => n.stories.length > 0)
    assert.match(read(t.project, 'components', first.name, 'README.md'), new RegExp(`^# ${first.name}\\n`))
    assert.match(run('artifact', t, ['pages', '--check']).stdout, /up to date \(3 component pages, 1 token section\)/)
    // ds:check runs it once the pages exist.
    assert.match(run('check', t).stdout, /pass {2}pages/)

    // A component that leaves the graph takes its generated page with it; a page or section the team wrote stays.
    mkdirSync(join(t.project, 'components', 'Handmade'), { recursive: true })
    writeFileSync(join(t.project, 'components', 'Handmade', 'README.md'), '# Handmade\n\nOurs.\n')
    writeFileSync(join(t.project, 'sections', 'voice.md'), '# Voice\n\nPlain words.\n')
    graph.nodes = graph.nodes.filter((n) => n.name !== first.name)
    writeFileSync(join(t.project, 'graph.json'), JSON.stringify(graph))
    const stale = run('artifact', t, ['pages', '--check'])
    assert.equal(stale.status, 1)
    assert.match(stale.stderr, new RegExp(`no longer written: .*components/${first.name}/README\\.md`))
    assert.match(run('artifact', t, ['pages']).stdout, /wrote 0, removed 1\n$/)
    assert.ok(!existsSync(join(t.project, 'components', first.name)))
    assert.ok(existsSync(join(t.project, 'components', 'Handmade', 'README.md')))

    // The build publishes the team's section beside the generated one, with assets from the folder and from the config.
    mkdirSync(join(t.project, 'assets', 'Logos'), { recursive: true })
    writeFileSync(join(t.project, 'assets', 'Logos', 'README.md'), '# Logos\n')
    writeFileSync(join(t.project, 'assets', 'Logos', 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    mkdirSync(join(t.root, 'public'), { recursive: true })
    writeFileSync(join(t.root, 'public', 'icon-a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const config = join(t.root, 'massimo.config.json')
    const c = JSON.parse(readFileSync(config, 'utf8'))
    c.artifact = { assets: [{ group: 'Icons', include: ['public/icon-*.svg'] }, { group: 'Nothing', include: ['public/none-*'] }] }
    writeFileSync(config, JSON.stringify(c))
    const b = run('artifact', t, ['build'])
    assert.equal(b.status, 0, b.stderr)
    assert.match(b.stderr, /artifact\.assets: nothing matches \["public\/none-\*"\] for the group Nothing/)
    const out = join(t.project, 'artifact', 'project')
    assert.equal(read(out, 'voice.md'), '# Voice\n\nPlain words.\n')
    assert.ok(read(out, 'motion.md').includes('`--motion-press`'))
    const files = readJson(t.project, 'artifact', 'files.json').files
    assert.deepEqual(files.filter((f) => f.upload).map((f) => f.path), ['project/assets/Icons/icon-a.svg', 'project/assets/Logos/mark.svg'])
    assert.ok(files.some((f) => f.path === 'project/assets/Logos/README.md' && !f.upload))
  } finally {
    t.cleanup()
  }
})

test('two components whose names differ only by case get folders a file system keeps apart', () => {
  const t = scratch('app')
  try {
    assert.equal(run('graph', t).status, 0)
    const path = join(t.project, 'graph.json')
    const graph = readJson(path)
    const first = graph.nodes.find((n) => n.stories.length > 0)
    graph.nodes.push({ ...first, name: first.name.toLowerCase(), file: 'src/components/ui/lower.tsx' }, { ...first, name: first.name.toUpperCase(), file: 'src/components/ui/upper.tsx' })
    writeFileSync(path, JSON.stringify(graph))
    assert.equal(run('artifact', t, ['build']).status, 0)
    const pages = readJson(t.project, 'artifact', 'files.json').files.map((f) => f.path).filter((f) => f.endsWith('/README.md') && f.startsWith('project/components/'))
    assert.equal(new Set(pages.map((f) => f.toLowerCase())).size, pages.length)
    assert.ok(pages.includes(`project/components/${first.name.toLowerCase()}_ui/README.md`))
    for (const f of pages) assert.ok(existsSync(join(t.project, 'artifact', f)), f)
  } finally {
    t.cleanup()
  }
})
