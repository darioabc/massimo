// The csf lane's Vite plugin, driven with fake Vite contexts, since massimo
// has no Vite of its own: the config it adds (aliases from tsconfig paths,
// React pinned to the install root, the files the server may read, the scan
// entries, cache, port and build output), the routes it answers in dev and
// in preview, Ladle's links rendered in place, the virtual module, the
// watcher, and what the build writes.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { ladleMeta, laneRegistry } from '../scripts/lib/lane.mjs'
import { DEFAULTS, deepMerge } from '../scripts/lib/project.mjs'
import {
  DEFAULT_VIEWPORTS,
  LANE_FORMAT,
  REDIRECTS_TEXT,
  VIRTUAL_ID,
  installRootOf,
  isLanePath,
  laneAttributes,
  laneBanner,
  laneFiles,
  laneProps,
  laneSwitches,
  massimoStories,
  tsconfigAliases,
  typesLine,
} from '../scripts/lib/vite-stories.mjs'
import { SCRIPTS, golden, scratch } from './helpers.mjs'

const HTML = '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/stories/main.tsx"></script></body></html>\n'

const write = (root, file, text) => {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), text)
}
const setStories = (root, stories) => {
  const path = join(root, 'massimo.config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  config.stories = { ...config.stories, ...stories }
  writeFileSync(path, JSON.stringify(config, null, 2))
}

// A scratch copy of the csf-lane fixture with the lane's HTML entry, and the
// stories settings given merged into its config.
function lane(stories = {}) {
  const t = scratch('csf-lane')
  write(t.root, 'stories.html', HTML)
  setStories(t.root, stories)
  return t
}

const logger = () => {
  const lines = { info: [], warn: [], error: [] }
  return { lines, info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m), error: (m) => lines.error.push(m) }
}

// The plugin through Vite's config hooks, as `vite` or `vite build` runs them.
function started(root, { command = 'serve', user = {}, publicDir = '', options = {} } = {}) {
  const plugin = massimoStories({ root, ...options })
  const added = plugin.config(user, { command, mode: command === 'build' ? 'production' : 'development' })
  const log = logger()
  plugin.configResolved({ root, command, publicDir, logger: log, build: { outDir: user.build?.outDir ?? added.build.outDir } })
  return { plugin, added, log }
}

// A fake dev server: middlewares, a watcher, the HMR socket, the module graph.
function devServer(log = logger()) {
  const sent = []
  const invalidated = []
  const stack = []
  const server = {
    config: { logger: log },
    middlewares: { use: (fn) => stack.push(fn) },
    watcher: new EventEmitter(),
    ws: { send: (payload) => sent.push(payload) },
    moduleGraph: { getModuleById: (id) => ({ id }), invalidateModule: (mod) => invalidated.push(mod.id) },
    transformIndexHtml: async (url, html, originalUrl) => `<!-- ${url} ${originalUrl} -->\n${html}`,
    restarted: 0,
    restart() {
      this.restarted++
    },
  }
  return { server, sent, invalidated, stack, log }
}

// One request through a middleware stack, as { status, headers, body, next }.
async function request(stack, url, method = 'GET', headers = {}) {
  const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v }, end(b) { this.body = String(b ?? '') } }
  let nextCalled = false
  for (const fn of stack) {
    nextCalled = false
    await fn({ url, originalUrl: url, method, headers }, res, (err) => {
      if (err) throw err
      nextCalled = true
    })
    if (!nextCalled) break
  }
  return { status: res.statusCode, headers: res.headers, body: res.body, next: nextCalled }
}

const fixtureRegistry = (root) => {
  const config = deepMerge(DEFAULTS, JSON.parse(readFileSync(join(root, 'massimo.config.json'), 'utf8')))
  return laneRegistry({ root, config, files: laneFiles(root, config), read: (f) => readFileSync(join(root, f), 'utf8') })
}

test('the plugin is a plain named object that reads nothing until Vite calls it', () => {
  const plugin = massimoStories()
  assert.equal(plugin.name, 'massimo-stories')
  for (const hook of ['config', 'configResolved', 'resolveId', 'load', 'configureServer', 'configurePreviewServer', 'writeBundle']) {
    assert.equal(typeof plugin[hook], 'function', hook)
  }
  assert.equal(plugin.generateBundle.order, 'post')
  assert.equal(LANE_FORMAT, laneRegistry({ root: '.', config: DEFAULTS, files: [], read: () => '' }).format)
  assert.equal(typesLine(), '// massimo lane types, format 1')
})

test('the lane paths it answers with its HTML entry', () => {
  for (const path of ['/', '/index.html', '/stories', '/stories/', '/stories/a--b', '/stories/a--b/plain']) assert.ok(isLanePath(path), path)
  for (const path of ['/storiesx', '/stories.html', '/meta.json', '/src/stories/main.tsx', '/assets/a.js']) assert.ok(!isLanePath(path), path)
})

test('the config it adds: scan entries, cache, port, output, and an HTML entry it owns', () => {
  const t = lane({ port: 4700 })
  try {
    const { added } = started(t.root)
    assert.equal(added.appType, 'custom')
    assert.deepEqual(added.optimizeDeps.entries, ['src/**/*.stories.{tsx,ts}', 'stories.html'])
    assert.equal(added.cacheDir, 'node_modules/.vite-stories')
    assert.deepEqual([added.server.port, added.server.strictPort, added.preview.port, added.preview.strictPort], [4700, true, 4700, true])
    assert.equal(added.build.outDir, 'dist-stories')
    assert.equal(added.build.rollupOptions.input, join(t.root, 'stories.html'))
    assert.deepEqual(added.resolve.dedupe, ['react', 'react-dom'])

    // What the project's own config sets stays, and stories.outDir names the output.
    setStories(t.root, { outDir: 'lane-out' })
    const own = started(t.root, { user: { cacheDir: '.cache-x', appType: 'spa', server: { port: 1 }, preview: { port: 2 }, build: { rollupOptions: { input: 'x.html' } } } }).added
    assert.equal(own.cacheDir, undefined)
    assert.equal(own.appType, 'spa')
    assert.equal(own.server.port, undefined)
    assert.equal(own.preview, undefined)
    assert.equal(own.build.rollupOptions, undefined)
    assert.equal(own.build.outDir, 'lane-out')
  } finally {
    t.cleanup()
  }
})

test('a config it cannot use stops Vite with the reason', () => {
  const t = lane()
  try {
    setStories(t.root, { lane: 'native' })
    assert.throws(() => massimoStories({ root: t.root }).config({}), /serves a csf lane, and massimo.config.json sets stories.lane to "native"/)
    const path = join(t.root, 'massimo.config.json')
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), minScripts: '99.0.0' }))
    assert.throws(() => massimoStories({ root: t.root }).config({}), /needs massimo scripts 99\.0\.0/)
    // A config passed in is used instead of the file.
    const added = massimoStories({ root: t.root, config: { stories: { lane: 'csf', include: ['src/**/*.stories.tsx'] } } }).config({})
    assert.deepEqual(added.optimizeDeps.entries, ['src/**/*.stories.tsx', 'stories.html'])
  } finally {
    t.cleanup()
  }
})

test('the install root: the first folder up with node_modules/react, which React is pinned to', () => {
  const t = lane()
  try {
    const base = dirname(t.root)
    write(base, 'node_modules/react/package.json', '{"name":"react"}')
    assert.equal(installRootOf(join(t.root, 'src', 'components')), base)
    assert.equal(installRootOf(parse(t.root).root), null)
    const { added } = started(t.root)
    assert.deepEqual(added.server.fs.allow, [base, t.root])
    const react = join(base, 'node_modules', 'react')
    const reactDom = join(base, 'node_modules', 'react-dom')
    const aliases = added.resolve.alias
    const target = (spec) => {
      const a = aliases.find((x) => x.find.test(spec))
      return a ? spec.replace(a.find, a.replacement) : null
    }
    assert.equal(target('react'), react)
    assert.equal(target('react/jsx-runtime'), join(react, 'jsx-runtime.js'))
    assert.equal(target('react/jsx-dev-runtime'), join(react, 'jsx-dev-runtime.js'))
    assert.equal(target('react-dom'), reactDom)
    assert.equal(target('react-dom/client'), `${reactDom}/client`)
    assert.equal(target('react-router'), null)

    // A repo with its own install allows only itself.
    write(t.root, 'node_modules/react/package.json', '{"name":"react"}')
    assert.deepEqual(started(t.root).added.server.fs.allow, [t.root])
  } finally {
    t.cleanup()
  }
})

test('aliases from tsconfig paths, through the files tsconfig.json extends and references', () => {
  const t = lane()
  try {
    write(t.root, 'tsconfig.json', JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }))
    write(t.root, 'tsconfig.base.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'], '@app': ['src/app.ts'], '*': ['types/*'] } } }))
    write(t.root, 'tsconfig.app.json', JSON.stringify({ compilerOptions: { paths: { '@lib/*': ['src/lib/*'], '@shared/*': ['../shared/src/*'], '@app': ['src/app.ts'] } } }))
    const aliases = tsconfigAliases(t.root)
    assert.deepEqual(aliases.map((a) => a.find.source), ['^@shared\\/(.*)$', '^@lib\\/(.*)$', '^@app$'])
    const target = (spec) => {
      const a = aliases.find((x) => x.find.test(spec))
      return a ? spec.replace(a.find, a.replacement) : null
    }
    assert.equal(target('@lib/format/date'), join(t.root, 'src/lib') + '/format/date')
    assert.equal(target('@shared/x'), join(dirname(t.root), 'shared/src') + '/x')
    assert.equal(target('@app'), join(t.root, 'src/app.ts'))
    assert.equal(target('@application'), null)
    // They reach the config Vite gets.
    assert.ok(started(t.root).added.resolve.alias.some((a) => a.find.source === '^@lib\\/(.*)$'))
  } finally {
    t.cleanup()
  }
})

const laneSettings = {
  viewports: [
    { label: 'Phone', width: 375, height: 812 },
    { label: 'Full', width: 0, height: 0 },
  ],
  sideBySide: ['src/components/Button.stories.tsx'],
  switchers: [
    { name: 'scheme', label: 'Mode', attribute: 'data-theme', values: ['auto', 'light', 'dark'], unset: 'auto', default: 'auto' },
    { name: 'density', label: 'Density', attribute: 'data-density', values: ['roomy', 'compact'], unset: 'roomy', default: null },
  ],
  banners: { exploration: { tone: 'warning', lead: 'Exploration.' }, drift: { tone: 'info', lead: 'Out of step.' } },
  frame: 'src/stories/frame.tsx',
}
const FRAME = "import type { FrameProps } from 'virtual:massimo-stories'\nexport default function Frame({ children }: FrameProps) {\n  return <div>{children}</div>\n}\nexport function switchDefaults(id: string) {\n  return { density: id.startsWith('pages--') ? 'compact' : 'roomy' }\n}\n"

test('the virtual module: the route helpers inlined, the format, the registry, the settings, a loader per file, the frame', () => {
  const t = lane(laneSettings)
  try {
    write(t.root, 'src/stories/frame.tsx', FRAME)
    const { plugin } = started(t.root)
    const id = plugin.resolveId(VIRTUAL_ID)
    assert.equal(id, `\0${VIRTUAL_ID}`)
    assert.equal(plugin.resolveId('virtual:other'), null)
    assert.equal(plugin.load('/src/x.tsx'), null)
    const text = plugin.load(id)
    assert.ok(text.startsWith('import FrameModule, { switchDefaults as frameSwitchDefaults } from "/src/stories/frame.tsx"\n'))
    assert.ok(text.includes(readFileSync(join(SCRIPTS, 'lib', 'lane-route.mjs'), 'utf8').trimEnd()))
    assert.ok(!text.includes(t.root), 'no absolute path')
    const expected = golden('vite-stories/virtual-module.js', text)
    if (expected !== undefined) assert.equal(text, expected)

    // Without a switchDefaults export, the frame's default alone.
    write(t.root, 'src/stories/frame.tsx', "export default function Frame({ children }) {\n  return children\n}\n")
    const plain = started(t.root).plugin.load(id)
    assert.ok(plain.startsWith('import FrameModule from "/src/stories/frame.tsx"\n'))
    assert.match(plain, /^export const switchDefaults = null$/m)

    // A frame that is not there stops the load with its name.
    rmSync(join(t.root, 'src/stories/frame.tsx'))
    assert.throws(() => started(t.root).plugin.load(id), /stories\.frame names src\/stories\/frame\.tsx, which does not exist/)
  } finally {
    t.cleanup()
  }
})

test('the virtual module runs: its exports, settings and loaders', async () => {
  const t = lane({ ...laneSettings, frame: null })
  try {
    const { plugin } = started(t.root)
    const file = join(t.root, 'virtual-module.mjs')
    writeFileSync(file, plugin.load(plugin.resolveId(VIRTUAL_ID)))
    const mod = await import(pathToFileURL(file).href)
    const registry = fixtureRegistry(t.root)
    assert.equal(mod.format, 1)
    assert.deepEqual(mod.registry, registry)
    assert.deepEqual(Object.keys(mod.modules).sort(), Object.keys(registry.files).sort())
    assert.ok(Object.values(mod.modules).every((load) => typeof load === 'function'))
    assert.equal(mod.Frame, null)
    assert.equal(mod.switchDefaults, null)
    assert.deepEqual(mod.lane, {
      home: 'foundations--welcome--start-here',
      viewports: laneSettings.viewports,
      switchers: laneSettings.switchers,
      banners: laneSettings.banners,
      sideBySide: ['src/components/Button.stories.tsx'],
    })
    assert.equal(mod.parseLaneUrl('/', '?story=a--b&mode=preview').kind, 'legacy-preview')
    assert.equal(mod.stateUrl(registry.stories['patterns--cards--card--plain'], { preview: true }), '/stories/patterns--cards--card/plain?mode=preview')
    assert.equal(mod.laneBanner({ drift: 'Old copy.' }, mod.lane.banners).lead, 'Out of step.')

    // With no viewports set, the three defaults.
    setStories(t.root, { viewports: null })
    const again = started(t.root).plugin
    writeFileSync(file, again.load(again.resolveId(VIRTUAL_ID)))
    const { lane: settings } = await import(`${pathToFileURL(file).href}?defaults`)
    assert.deepEqual(settings.viewports, DEFAULT_VIEWPORTS)
  } finally {
    t.cleanup()
  }
})

test('dev: the HTML entry for the lane paths, Ladle links rendered in place, and /meta.json', async () => {
  const t = lane()
  try {
    const { plugin } = started(t.root)
    const { server, stack, log } = devServer()
    plugin.configureServer(server)
    assert.deepEqual(log.lines.info, ['massimo: 7 story files, 13 states'])
    for (const url of ['/', '/stories', '/stories?s=patterns--cards--card--plain', '/stories/patterns--cards--card/plain?mode=preview', '/?story=patterns--cards--card--plain', '/?story=patterns--cards--card--plain&mode=preview&arg-size=lg']) {
      const res = await request(stack, url)
      assert.equal(res.status, 200, url)
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8', url)
      assert.equal(res.headers.location, undefined, url)
      assert.equal(res.body, `<!-- /stories.html ${url} -->\n${HTML}`, url)
    }
    const meta = await request(stack, '/meta.json')
    assert.equal(meta.headers['content-type'], 'application/json; charset=utf-8')
    assert.deepEqual(JSON.parse(meta.body), ladleMeta(fixtureRegistry(t.root)))
    assert.equal(JSON.parse(meta.body).about.format, 1)
    for (const url of ['/src/stories/main.tsx', '/storiesx', '/@vite/client']) assert.equal((await request(stack, url)).next, true, url)
    assert.equal((await request(stack, '/stories', 'POST')).next, true)
  } finally {
    t.cleanup()
  }
})

test('dev: a story module in a top-level stories/ folder is Vite\'s, and only a page load under /stories/ gets the HTML', async () => {
  const t = lane({ include: ['stories/**/*.stories.tsx'] })
  try {
    write(t.root, 'stories/Button.stories.tsx', "export default { title: 'Primitives / Button' }\nexport const Plain = () => null\n")
    const { plugin } = started(t.root)
    const { server, stack } = devServer()
    plugin.configureServer(server)
    assert.match(plugin.load(plugin.resolveId(VIRTUAL_ID)), /"stories\/Button\.stories\.tsx": \(\) => import\("\/stories\/Button\.stories\.tsx"\)/)
    for (const url of ['/stories/Button.stories.tsx', '/stories/Button.stories.tsx?t=123', '/stories/Button.stories.tsx?import']) {
      assert.equal((await request(stack, url)).next, true, url)
      assert.equal((await request(stack, url, 'GET', { 'sec-fetch-dest': 'script' })).next, true, url)
    }
    // A script or a fetch for a path no file holds is Vite's too, to answer as it will.
    for (const dest of ['script', 'style', 'empty']) assert.equal((await request(stack, '/stories/gone.tsx', 'GET', { 'sec-fetch-dest': dest })).next, true, dest)
    // A page, a frame, or a request that does not say, gets the lane's HTML.
    for (const headers of [{}, { 'sec-fetch-dest': 'document' }, { 'sec-fetch-dest': 'iframe' }]) {
      for (const url of ['/stories', '/stories/primitives--button', '/stories/primitives--button/plain?mode=preview']) {
        const res = await request(stack, url, 'GET', headers)
        assert.equal(res.next, false, `${url} ${JSON.stringify(headers)}`)
        assert.equal(res.headers['content-type'], 'text/html; charset=utf-8', url)
      }
    }
  } finally {
    t.cleanup()
  }
})

test('dev: a registry problem is said when the server starts', () => {
  const t = lane()
  try {
    write(t.root, 'src/components/Twin.stories.tsx', "export default { title: 'Primitives / Actions / Button' }\nexport const Primary = () => null\n")
    const { plugin } = started(t.root)
    const { server, log } = devServer()
    plugin.configureServer(server)
    assert.match(log.lines.info[0], /, 1 problems$/)
    assert.match(log.lines.warn[0], /^massimo: src\/components\/Twin\.stories\.tsx: Primary has the id primitives--actions--button--primary/)
  } finally {
    t.cleanup()
  }
})

test('dev: the watcher rebuilds the registry for a story file added, changed or removed, and reloads', async () => {
  const t = lane()
  try {
    const { plugin } = started(t.root)
    const { server, stack, sent, invalidated } = devServer()
    plugin.configureServer(server)
    const ids = async () => Object.keys(JSON.parse((await request(stack, '/meta.json')).body).stories)
    const before = plugin.load(plugin.resolveId(VIRTUAL_ID))

    write(t.root, 'src/components/Badge.stories.tsx', "export default { title: 'Primitives / Status / Badge' }\nexport const Plain = () => null\n")
    server.watcher.emit('add', join(t.root, 'src/components/Badge.stories.tsx'))
    assert.ok((await ids()).includes('primitives--status--badge--plain'))
    assert.deepEqual(sent, [{ type: 'full-reload' }])
    assert.deepEqual(invalidated, [`\0${VIRTUAL_ID}`])
    assert.notEqual(plugin.load(plugin.resolveId(VIRTUAL_ID)), before)

    write(t.root, 'src/components/Badge.stories.tsx', "export default { title: 'Primitives / Status / Badge' }\nexport const Loud = () => null\n")
    server.watcher.emit('change', join(t.root, 'src/components/Badge.stories.tsx'))
    assert.ok((await ids()).includes('primitives--status--badge--loud'))
    assert.equal(sent.length, 2)

    rmSync(join(t.root, 'src/components/Badge.stories.tsx'))
    server.watcher.emit('unlink', join(t.root, 'src/components/Badge.stories.tsx'))
    assert.ok(!(await ids()).some((id) => id.startsWith('primitives--status--badge')))
    assert.equal(plugin.load(plugin.resolveId(VIRTUAL_ID)), before)

    // Other files, test files and files outside the repo leave it alone.
    for (const file of ['src/components/Button.tsx', 'src/components/Button.stories.test.tsx', '../elsewhere/X.stories.tsx']) server.watcher.emit('change', join(t.root, file))
    assert.equal(sent.length, 3)
    assert.equal(invalidated.length, 3)
    // Vite has no module to update for a story file: the page reloads instead.
    assert.deepEqual(plugin.handleHotUpdate({ file: join(t.root, 'src/components/Card.stories.tsx') }), [])
    assert.equal(plugin.handleHotUpdate({ file: join(t.root, 'src/components/Card.tsx') }), undefined)

    // A changed config restarts the server.
    server.watcher.emit('change', join(t.root, 'massimo.config.json'))
    assert.equal(server.restarted, 1)
  } finally {
    t.cleanup()
  }
})

test('dev: an edit to the frame that adds switchDefaults rewrites the virtual module', () => {
  const t = lane({ frame: 'src/stories/frame.tsx' })
  try {
    write(t.root, 'src/stories/frame.tsx', 'export default function Frame({ children }) {\n  return children\n}\n')
    const { plugin } = started(t.root)
    const { server, sent, invalidated } = devServer()
    plugin.configureServer(server)
    const id = plugin.resolveId(VIRTUAL_ID)
    assert.match(plugin.load(id), /^export const switchDefaults = null$/m)
    // A change that keeps its exports is Vite's to hot-update.
    write(t.root, 'src/stories/frame.tsx', 'export default function Frame({ children }) {\n  return <main>{children}</main>\n}\n')
    server.watcher.emit('change', join(t.root, 'src/stories/frame.tsx'))
    assert.deepEqual([sent.length, invalidated.length], [0, 0])
    write(t.root, 'src/stories/frame.tsx', FRAME)
    server.watcher.emit('change', join(t.root, 'src/stories/frame.tsx'))
    assert.match(plugin.load(id), /^export const switchDefaults = frameSwitchDefaults$/m)
    assert.deepEqual([sent.length, invalidated.length], [1, 1])
  } finally {
    t.cleanup()
  }
})

test('preview: the lane paths answer with the built index.html, everything else is the static files', async () => {
  const t = lane()
  try {
    const { plugin } = started(t.root)
    const stack = []
    plugin.configurePreviewServer({ middlewares: { use: (fn) => stack.push(fn) } })
    assert.equal((await request(stack, '/stories')).next, true, 'nothing built yet')
    write(t.root, 'dist-stories/index.html', '<!doctype html><title>lane</title>\n')
    for (const url of ['/', '/stories', '/stories/patterns--cards--card/plain?mode=preview', '/?story=patterns--cards--card--plain&mode=preview']) {
      const res = await request(stack, url)
      assert.equal(res.body, '<!doctype html><title>lane</title>\n', url)
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8', url)
    }
    for (const url of ['/meta.json', '/assets/index-abc.js', '/fonts/a.woff2']) assert.equal((await request(stack, url)).next, true, url)
  } finally {
    t.cleanup()
  }
})

// A fake build context that keeps what the plugin emits and warns.
const buildContext = () => {
  const emitted = {}
  const warnings = []
  return { emitted, warnings, emitFile: (f) => (emitted[f.fileName] = f.source), warn: (m) => warnings.push(m) }
}

test('build: the entry becomes index.html beside meta.json and the /stories/* rewrite, and the app\'s host files stay out', () => {
  const t = lane({ hostFiles: ['_redirects'] })
  try {
    write(t.root, 'public/_redirects', '/* /index.html 200\n')
    write(t.root, 'public/_headers', '/*\n  X-Frame-Options: DENY\n')
    const { plugin } = started(t.root, { command: 'build', publicDir: join(t.root, 'public') })
    const ctx = buildContext()
    plugin.buildStart.call(ctx)
    assert.deepEqual(ctx.warnings, [])
    const bundle = { 'stories.html': { type: 'asset', fileName: 'stories.html', source: '<html>lane</html>' }, 'assets/a.js': { type: 'chunk', fileName: 'assets/a.js' } }
    plugin.generateBundle.handler.call(ctx, {}, bundle)
    assert.deepEqual(Object.keys(bundle), ['assets/a.js'])
    assert.deepEqual(Object.keys(ctx.emitted).sort(), ['_redirects', 'index.html', 'meta.json'])
    assert.equal(ctx.emitted['index.html'], '<html>lane</html>')
    assert.equal(ctx.emitted._redirects, '/stories/* /index.html 200\n')
    assert.equal(REDIRECTS_TEXT, '/stories/* /index.html 200\n')
    assert.deepEqual(JSON.parse(ctx.emitted['meta.json']), ladleMeta(fixtureRegistry(t.root)))

    // Vite copies public/ into the output before writing the bundle over it.
    const out = join(t.root, 'dist-stories')
    write(out, '_redirects', REDIRECTS_TEXT)
    write(out, '_headers', '/*\n  X-Frame-Options: DENY\n')
    plugin.writeBundle.call(ctx, { dir: out })
    assert.equal(readFileSync(join(out, '_redirects'), 'utf8'), REDIRECTS_TEXT)
    assert.ok(!existsSync(join(out, '_headers')))
    assert.deepEqual(ctx.warnings, [
      "the app's public/_redirects was left out of the lane's build, which writes its own _redirects",
      "the app's public/_headers was left out of the lane's build",
    ])
  } finally {
    t.cleanup()
  }
})

test('build: with no host files asked for, no rewrite is written and the app\'s is removed', () => {
  const t = lane()
  try {
    write(t.root, 'public/_redirects', '/* /index.html 200\n')
    write(t.root, 'src/components/Twin.stories.tsx', "export default { title: 'Primitives / Actions / Button' }\nexport const Primary = () => null\n")
    const { plugin } = started(t.root, { command: 'build', publicDir: join(t.root, 'public') })
    const ctx = buildContext()
    plugin.buildStart.call(ctx)
    assert.equal(ctx.warnings.length, 1, 'the registry problem')
    plugin.generateBundle.handler.call(ctx, {}, { 'stories.html': { type: 'asset', source: 'x' } })
    assert.deepEqual(Object.keys(ctx.emitted).sort(), ['index.html', 'meta.json'])
    const out = join(t.root, 'dist-stories')
    write(out, '_redirects', '/* /index.html 200\n')
    plugin.writeBundle.call(ctx, { dir: out })
    assert.ok(!existsSync(join(out, '_redirects')))
    assert.equal(ctx.warnings[1], "the app's public/_redirects was left out of the lane's build")
  } finally {
    t.cleanup()
  }
})

test('the story files: the include globs under the root, minus tests and ignored folders', () => {
  const t = lane()
  try {
    write(t.root, 'dist-stories/src/Old.stories.tsx', 'export default { title: "X" }\n')
    write(t.root, 'node_modules/pkg/src/A.stories.tsx', 'export default { title: "X" }\n')
    const config = deepMerge(DEFAULTS, JSON.parse(readFileSync(join(t.root, 'massimo.config.json'), 'utf8')))
    const files = laneFiles(t.root, config, { ignore: ['dist-stories'] })
    assert.equal(files.length, 7)
    assert.ok(!files.some((f) => f.includes('.test.') || f.startsWith('dist-stories') || f.startsWith('node_modules')))
  } finally {
    t.cleanup()
  }
})

test('the banner: the first banner key whose meta value is a non-empty string', () => {
  const banners = { exploration: { tone: 'warning', lead: 'Exploration.' }, drift: { tone: 'info', lead: 'Out of step.' } }
  assert.deepEqual(laneBanner({ drift: 'Old.', exploration: 'A record.' }, banners), { key: 'exploration', tone: 'warning', lead: 'Exploration.', text: 'A record.' })
  assert.deepEqual(laneBanner({ exploration: '  ', drift: 'Old.' }, banners), { key: 'drift', tone: 'info', lead: 'Out of step.', text: 'Old.' })
  assert.equal(laneBanner({ exploration: true }, banners), null)
  assert.equal(laneBanner(null, banners), null)
  assert.equal(laneBanner({ drift: 'x' }, null), null)
})

test('switch values: the query, the default, the frame, the unset value; and the attributes they set', () => {
  const switchers = laneSettings.switchers
  const story = { id: 'pages--review--summary--overview', meta: {} }
  const calls = []
  const defaults = (id, meta) => {
    calls.push([id, meta])
    return { density: id.startsWith('pages--') ? 'compact' : 'roomy', scheme: 'dark' }
  }
  assert.deepEqual(laneSwitches(story, {}, switchers, defaults), { scheme: 'auto', density: 'compact' })
  assert.deepEqual(calls, [['pages--review--summary--overview', {}]])
  assert.deepEqual(laneSwitches(story, { scheme: 'dark', density: 'roomy' }, switchers, defaults), { scheme: 'dark', density: 'roomy' })
  // A value the switch does not have is ignored, and so is a frame that gives none.
  assert.deepEqual(laneSwitches(story, { scheme: 'sepia' }, switchers, () => ({ density: 'huge' })), { scheme: 'auto', density: 'roomy' })
  assert.deepEqual(laneSwitches(story, {}, switchers, null), { scheme: 'auto', density: 'roomy' })
  assert.deepEqual(laneAttributes({ scheme: 'auto', density: 'compact' }, switchers), { 'data-theme': null, 'data-density': 'compact' })
  assert.deepEqual(laneAttributes({ scheme: 'dark', density: 'roomy' }, switchers), { 'data-theme': 'dark', 'data-density': null })
})

test("props as Ladle gives them: the file's args under the story's, argTypes defaults, URL values by control type, mappings", () => {
  const Sized = () => null
  Sized.args = { size: 'md', count: 2, open: false, item: { a: 1 } }
  Sized.argTypes = {
    size: { options: ['sm', 'md', 'lg'], control: { type: 'select' } },
    level: { options: [1, 2, 3], control: { type: 'radio' }, defaultValue: 1 },
    tone: { options: ['a', 'b'], control: { type: 'select' }, mapping: { a: 'Alpha', b: 'Beta' }, defaultValue: 'a' },
    tags: { options: ['x', 'y'], control: { type: 'multi-select' } },
    onPick: { action: 'picked' },
  }
  const module = { default: { title: 'X', args: { size: 'sm', label: 'File' } }, Sized }
  const plain = laneProps(module, 'Sized', {})
  assert.deepEqual({ ...plain, onPick: typeof plain.onPick }, { size: 'md', label: 'File', count: 2, open: false, item: { a: 1 }, level: 1, tone: 'Alpha', tags: undefined, onPick: 'function' })
  const fromUrl = laneProps(module, 'Sized', { size: 'lg', count: '7', open: 'true', item: '{"a":2}', level: '3', tone: 'b', tags: '["x","y"]', label: 'Url', 'size-extra': 'sm', unknown: 'x' })
  assert.deepEqual({ ...fromUrl, onPick: undefined }, { size: 'sm', label: 'Url', count: 7, open: true, item: { a: 2 }, level: 3, tone: 'Beta', tags: ['x', 'y'], onPick: undefined })
  assert.deepEqual(laneProps({ Plain: () => null }, 'Plain', { size: 'lg' }), {})
  assert.throws(() => laneProps({ X: Object.assign(() => null, { argTypes: { size: { options: [] } } }) }, 'X', {}), /argTypes should have control type specified/)
})
