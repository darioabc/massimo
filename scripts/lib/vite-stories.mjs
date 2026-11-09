// The Vite plugin that serves and builds the csf lane from a registry worked
// out at dev and build time, so no route table is ever checked in. A Vite
// plugin is a plain object, so this file needs no Vite of its own: the
// project's `vite.stories.config.ts` imports it from the vendored scripts.
//
// What it adds to the lane's config: aliases from tsconfig `paths`, React
// pinned to the install root (the first folder up with node_modules/react,
// which a worktree borrows from its parent), the files the dev server may
// serve, the dependency scan's entries, its own cache folder, its port and
// its build output. What it serves: the lane's HTML for `/`, `/stories` and
// the pages under `/stories/` (a repo file there, such as a story module in a
// top-level stories/ folder, stays Vite's), Ladle-shaped `/meta.json`, and
// `virtual:massimo-stories`, which holds the registry, one loader per story
// file, the route helpers of lane-route.mjs as text, and the helpers below,
// so the scaffold in `src/stories/` imports one declared module and never a
// `.mjs` file.

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compare, compileGlobs, walk } from './glob.mjs'
import { ladleMeta, laneRegistry } from './lane.mjs'
import { CONFIG_FILE, DEFAULTS, deepMerge, loadConfig } from './project.mjs'
import { extractExports, isTestFile, loadTsconfigs } from './source.mjs'

export const VIRTUAL_ID = 'virtual:massimo-stories'
const RESOLVED_ID = `\0${VIRTUAL_ID}`

// The registry format this plugin writes, which the scaffold's massimo.d.ts
// names on its first line.
export const LANE_FORMAT = 1
export const typesLine = (format = LANE_FORMAT) => `// massimo lane types, format ${format}`

export const DEFAULT_VIEWPORTS = [
  { label: 'Phone', width: 390, height: 844 },
  { label: 'Desktop', width: 1440, height: 900 },
  { label: 'Full', width: 0, height: 0 },
]
export const DEFAULT_OUT_DIR = 'dist-stories'
const DEFAULT_HTML = 'stories.html'
const DEFAULT_CACHE_DIR = 'node_modules/.vite-stories'

// The host rewrite the lane's build writes when `stories.hostFiles` asks: only
// `/stories/*`, since a host such as Cloudflare Pages rewrites even when an
// asset matches, and a catch-all would serve `/meta.json` and the chunks as HTML.
export const REDIRECTS_TEXT = '/stories/* /index.html 200\n'
// Host files an app keeps in `public/`, which the lane's build would copy.
const HOST_FILES = ['_redirects', '_headers']

const toPosix = (p) => p.split(sep).join('/')
const relPath = (root, abs) => toPosix(relative(root, abs))

// Whether a request path is one the lane answers with its HTML entry.
export const isLanePath = (pathname) => pathname === '/' || pathname === '/index.html' || pathname === '/stories' || pathname.startsWith('/stories/')

// What a browser loads a page or a frame as. A request under /stories/ that
// says it loads anything else, a script, a style or a fetch, is no navigation.
const NAVIGATIONS = ['document', 'iframe', 'frame']

// Whether a request under /stories/ is one Vite answers in dev: it names a
// file in the repo, such as a story module in a top-level stories/ folder,
// or the browser loads it as something other than a page.
export function isFileRequest(root, pathname, headers = {}) {
  if (!pathname.startsWith('/stories/')) return false
  const dest = headers['sec-fetch-dest']
  if (typeof dest === 'string' && dest !== '' && !NAVIGATIONS.includes(dest)) return true
  try {
    return statSync(join(root, decodeURIComponent(pathname))).isFile()
  } catch {
    return false
  }
}

// ── Helpers inlined into the virtual module ─────────────────────────────────
// Each is copied into the virtual module as its own source text, so it uses
// nothing outside its arguments and its own body.

// The banner for a state's merged meta: the first key of `banners` whose
// value in the meta is a non-empty string, as { key, tone, lead, text }.
export function laneBanner(meta, banners) {
  for (const [key, banner] of Object.entries(banners ?? {})) {
    const text = meta ? meta[key] : undefined
    if (typeof text === 'string' && text.trim() !== '') return { key, tone: banner?.tone ?? 'info', lead: banner?.lead ?? '', text }
  }
  return null
}

// Each switch's value for a state: the query's when it is one of the
// switch's values, else the switch's own default, else what the frame's
// `switchDefaults(id, meta)` says, else the switch's unset value.
export function laneSwitches(story, query, switchers, defaults) {
  const out = {}
  let fromFrame = null
  for (const s of switchers ?? []) {
    const values = s.values ?? []
    const allowed = (v) => typeof v === 'string' && values.includes(v)
    let value = allowed(query?.[s.name]) ? query[s.name] : allowed(s.default) ? s.default : null
    if (value === null && typeof defaults === 'function' && story) {
      fromFrame ??= defaults(story.id, story.meta ?? {}) ?? {}
      if (allowed(fromFrame[s.name])) value = fromFrame[s.name]
    }
    out[s.name] = value ?? s.unset ?? values[0] ?? null
  }
  return out
}

// The `<html>` attribute each switch value sets, as { attribute: value },
// with null for a switch at its unset value, whose attribute is removed.
export function laneAttributes(values, switchers) {
  const out = {}
  for (const s of switchers ?? []) {
    if (!s.attribute) continue
    const value = values?.[s.name] ?? null
    out[s.attribute] = value === null || value === s.unset ? null : value
  }
  return out
}

// The props a story renders with, as Ladle gives them: the file's args
// under the story's, argTypes defaults for the names args leave out, each
// `arg-<name>` from the URL read by its control type, then argTypes
// mappings. An argType that names an action gets a function that logs.
export function laneProps(module, name, urlArgs) {
  const story = module ? module[name] : undefined
  const file = (module && module.default) || {}
  const args = { ...(file.args || {}), ...((story && story.args) || {}) }
  const argTypes = { ...(file.argTypes || {}), ...((story && story.argTypes) || {}) }
  const controls = {}
  for (const [key, value] of Object.entries(args)) {
    const kind = typeof value
    const type = kind === 'function' || kind === 'boolean' || kind === 'number' || kind === 'string' ? kind : 'complex'
    controls[key] = { type, value }
  }
  for (const [key, argType] of Object.entries(argTypes)) {
    if (argType && argType.action) {
      controls[key] = { type: 'action', value: (...event) => console.info(`action: ${key}`, ...event) }
      continue
    }
    if (!argType || !argType.control || !argType.control.type) throw new Error('argTypes should have control type specified')
    controls[key] = { type: argType.control.type, options: argType.options, value: args[key] === undefined ? argType.defaultValue : args[key] }
  }
  const fromOptions = (value, options) => {
    if (options && options.some((option) => option === Number(value))) return Number(value)
    return value === 'true' ? true : value === 'false' ? false : value
  }
  const json = (value) => {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  for (const [param, raw] of Object.entries(urlArgs || {})) {
    // Ladle reads the name up to the first hyphen.
    const control = controls[param.split('-')[0]]
    if (!control || control.type === 'action') continue
    const type = control.type
    if (type === 'boolean') control.value = raw === 'true'
    else if (type === 'range') control.value = Number.parseFloat(raw)
    else if (type === 'number') control.value = Number.parseInt(raw, 10)
    else if (type === 'complex') control.value = json(raw)
    else if (type === 'radio' || type === 'inline-radio' || type === 'select' || type === 'background') control.value = fromOptions(raw, control.options)
    else if (type === 'check' || type === 'inline-check' || type === 'multi-select') control.value = fromOptions(json(raw), control.options)
    else control.value = raw
  }
  const props = {}
  for (const [key, control] of Object.entries(controls)) {
    const mapping = argTypes[key] && argTypes[key].mapping
    const mapped = (v) => (mapping && Object.prototype.hasOwnProperty.call(mapping, v) ? mapping[v] : v)
    props[key] = Array.isArray(control.value) ? control.value.map(mapped) : mapped(control.value)
  }
  return props
}

const INLINED = [laneBanner, laneSwitches, laneAttributes, laneProps]

// ── The registry and the virtual module ─────────────────────────────────────

// The repo's story files, as sorted repo-relative paths: what the include
// globs match under `root`, test files left out.
export function laneFiles(root, config, { ignore = [] } = {}) {
  const include = compileGlobs(config.stories?.include ?? [])
  return walk(root, { ignore: [...(config.ignore ?? []), ...ignore] }).filter((f) => include(f) && !isTestFile(f))
}

const viewport = (v) => ({ label: String(v?.label ?? ''), width: Number(v?.width) || 0, height: Number(v?.height) || 0 })
const switcher = (s) => ({
  name: String(s?.name ?? ''),
  label: String(s?.label ?? s?.name ?? ''),
  attribute: s?.attribute ?? null,
  values: Array.isArray(s?.values) ? s.values.map(String) : [],
  unset: s?.unset ?? null,
  default: s?.default ?? null,
})

// The settings the shell and canvas read beside the registry.
export function laneSettings(registry, config) {
  const stories = config.stories ?? {}
  const together = compileGlobs(stories.sideBySide ?? [])
  return {
    home: registry.home,
    viewports: (Array.isArray(stories.viewports) && stories.viewports.length > 0 ? stories.viewports : DEFAULT_VIEWPORTS).map(viewport),
    switchers: (stories.switchers ?? []).map(switcher),
    banners: stories.banners ?? {},
    sideBySide: Object.keys(registry.files).filter(together).sort(compare),
  }
}

// The text of `virtual:massimo-stories`. `frame` is the frame module as
// { file, switchDefaults }, with switchDefaults true when it exports one,
// or null for no frame.
export function virtualModule({ registry, settings, frame = null, routeText }) {
  const loaders = Object.keys(registry.files)
    .sort(compare)
    .map((file) => `  ${JSON.stringify(file)}: () => import(${JSON.stringify(`/${file}`)}),`)
  const head = frame
    ? [`import FrameModule${frame.switchDefaults ? ', { switchDefaults as frameSwitchDefaults }' : ''} from ${JSON.stringify(`/${frame.file}`)}`]
    : []
  return [
    ...head,
    '// virtual:massimo-stories, written by massimo\'s Vite plugin: the lane\'s registry,',
    '// its settings, one loader per story file, the route helpers and the view helpers.',
    '',
    routeText.trimEnd(),
    '',
    ...INLINED.map((fn) => `export ${fn.toString()}\n`),
    `export const format = ${JSON.stringify(registry.format)}`,
    '',
    `export const registry = ${JSON.stringify(registry, null, 2)}`,
    '',
    `export const lane = ${JSON.stringify(settings, null, 2)}`,
    '',
    'export const modules = {',
    ...loaders,
    '}',
    '',
    `export const Frame = ${frame ? 'FrameModule' : 'null'}`,
    `export const switchDefaults = ${frame?.switchDefaults ? 'frameSwitchDefaults' : 'null'}`,
    '',
  ].join('\n')
}

// ── Install root and aliases ────────────────────────────────────────────────

// The first folder from `from` up that holds node_modules/react, or null.
export function installRootOf(from) {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, 'node_modules', 'react', 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Vite aliases from the tsconfig `paths` the repo's tsconfig files declare,
// longest prefix first; a bare `*` pattern is left to the resolver.
export function tsconfigAliases(root) {
  const out = []
  const seen = new Set()
  const entries = []
  for (const cfg of loadTsconfigs(root)) {
    if (!cfg.paths) continue
    for (const [pattern, targets] of Object.entries(cfg.paths.map)) {
      const target = [].concat(targets)[0]
      if (typeof target !== 'string' || pattern === '*' || seen.has(pattern)) continue
      seen.add(pattern)
      entries.push({ pattern, target, base: cfg.paths.base })
    }
  }
  entries.sort((a, b) => b.pattern.length - a.pattern.length || compare(a.pattern, b.pattern))
  for (const { pattern, target, base } of entries) {
    const star = pattern.indexOf('*')
    if (star === -1) {
      out.push({ find: new RegExp(`^${escapeRe(pattern)}$`), replacement: resolve(base, target) })
      continue
    }
    const find = new RegExp(`^${escapeRe(pattern.slice(0, star))}(.*)${escapeRe(pattern.slice(star + 1))}$`)
    const at = target.indexOf('*')
    const replacement = at === -1 ? resolve(base, target) : resolve(base, target.slice(0, at)) + (target.slice(0, at).endsWith('/') ? '/' : '') + '$1' + target.slice(at + 1)
    out.push({ find, replacement })
  }
  return out
}

// React's entry points pinned to the install root, so a story and the lane
// never load two copies ("Invalid hook call").
export function reactAliases(installRoot) {
  if (!installRoot) return []
  const react = join(installRoot, 'node_modules', 'react')
  const reactDom = join(installRoot, 'node_modules', 'react-dom')
  return [
    { find: /^react\/jsx-runtime$/, replacement: join(react, 'jsx-runtime.js') },
    { find: /^react\/jsx-dev-runtime$/, replacement: join(react, 'jsx-dev-runtime.js') },
    { find: /^react(\/.*)?$/, replacement: `${react}$1` },
    { find: /^react-dom(\/.*)?$/, replacement: `${reactDom}$1` },
  ]
}

// ── The plugin ──────────────────────────────────────────────────────────────

// The project's config: the one passed in, merged over the defaults, else
// massimo.config.json at `root`. A config these scripts cannot read, or one
// whose lane is not csf, stops the server with the reason.
function laneConfig(root, options) {
  let config
  if (options.config) config = deepMerge(structuredClone(DEFAULTS), options.config)
  else {
    const loaded = loadConfig({ root }, { gate: false })
    if (loaded.refusal) throw new Error(`massimo: ${loaded.refusal}`)
    config = loaded.config
  }
  if (config.stories?.lane !== 'csf') throw new Error(`massimo: the stories plugin serves a csf lane, and massimo.config.json sets stories.lane to ${JSON.stringify(config.stories?.lane)}`)
  return config
}

// Options: `root` (the repo, by default Vite's root), `config` (a config
// object to use instead of massimo.config.json) and `html` (the lane's HTML
// entry, `stories.html` at the root by default).
export function massimoStories(options = {}) {
  const html = options.html ?? DEFAULT_HTML
  const routeText = () => readFileSync(fileURLToPath(new URL('./lane-route.mjs', import.meta.url)), 'utf8')
  const lane = { root: null, config: null, command: null, outDir: null, publicDir: null, files: null, texts: new Map(), registry: null, source: null, emitted: new Set() }

  const isStoryFile = (file) => compileGlobs(lane.config.stories.include ?? [])(file) && !isTestFile(file)
  const frameFile = () => (lane.config.stories.frame ? toPosix(lane.config.stories.frame).replace(/^\.?\//, '') : null)
  const read = (file) => {
    if (!lane.texts.has(file)) lane.texts.set(file, readFileSync(join(lane.root, file), 'utf8'))
    return lane.texts.get(file)
  }
  const registry = () => {
    if (!lane.registry) {
      lane.files ??= new Set(laneFiles(lane.root, lane.config, { ignore: [lane.outDir ? relPath(lane.root, lane.outDir).split('/')[0] : DEFAULT_OUT_DIR] }))
      lane.registry = laneRegistry({ root: lane.root, config: lane.config, files: [...lane.files], read })
    }
    return lane.registry
  }
  const frame = () => {
    const file = frameFile()
    if (!file) return null
    const abs = join(lane.root, file)
    if (!existsSync(abs)) throw new Error(`massimo: stories.frame names ${file}, which does not exist`)
    return { file, switchDefaults: extractExports(readFileSync(abs, 'utf8'), file).includes('switchDefaults') }
  }
  const source = () => (lane.source ??= virtualModule({ registry: registry(), settings: laneSettings(registry(), lane.config), frame: frame(), routeText: routeText() }))
  const metaText = () => `${JSON.stringify(ladleMeta(registry()), null, 2)}\n`
  const problemLines = () => registry().problems.map((p) => `${p.file ?? 'config'}: ${p.detail}`)

  return {
    name: 'massimo-stories',

    config(user = {}) {
      lane.root = resolve(options.root ?? user.root ?? process.cwd())
      lane.config = laneConfig(lane.root, options)
      const stories = lane.config.stories
      const installRoot = installRootOf(lane.root)
      const outDir = user.build?.outDir ?? stories.outDir ?? DEFAULT_OUT_DIR
      lane.outDir = isAbsolute(outDir) ? outDir : join(lane.root, outDir)
      const add = {
        // The lane answers its own routes; nothing else falls back to an HTML page.
        appType: user.appType ?? 'custom',
        resolve: {
          alias: [...reactAliases(installRoot), ...tsconfigAliases(lane.root)],
          dedupe: ['react', 'react-dom'],
        },
        server: { fs: { allow: [...new Set([installRoot ?? lane.root, lane.root])] } },
        optimizeDeps: { entries: [...(stories.include ?? []), html] },
        build: { outDir },
      }
      if (user.cacheDir === undefined) add.cacheDir = DEFAULT_CACHE_DIR
      if (user.build?.rollupOptions?.input === undefined) add.build.rollupOptions = { input: join(lane.root, html) }
      if (typeof stories.port === 'number') {
        if (user.server?.port === undefined) Object.assign(add.server, { port: stories.port, strictPort: true })
        if (user.preview?.port === undefined) add.preview = { port: stories.port, strictPort: true }
      }
      return add
    },

    configResolved(resolved) {
      lane.root ??= resolve(resolved.root)
      lane.config ??= laneConfig(lane.root, options)
      lane.command = resolved.command
      lane.outDir = resolve(resolved.root, resolved.build.outDir)
      lane.publicDir = resolved.publicDir || null
      for (const name of lane.config.stories.hostFiles ?? []) {
        if (name !== '_redirects') resolved.logger.warn(`massimo: stories.hostFiles names ${name}, and the lane writes only _redirects`)
      }
    },

    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null
    },

    load(id) {
      return id === RESOLVED_ID ? source() : null
    },

    configureServer(server) {
      const logger = server.config.logger
      const problems = problemLines()
      const { files, order } = registry()
      logger.info(`massimo: ${Object.keys(files).length} story files, ${order.length} states${problems.length ? `, ${problems.length} problems` : ''}`)
      for (const line of problems) logger.warn(`massimo: ${line}`)

      // A story file added, removed or changed, or the frame, rebuilds the
      // registry; the virtual module is dropped when its text changes, and a
      // story file reloads the page, since a canvas holds one loaded state.
      // A changed massimo.config.json restarts the server, which reads it again.
      const onFile = (event) => (abs) => {
        const file = relPath(lane.root, abs)
        if (file.startsWith('..')) return
        if (file === CONFIG_FILE && !options.config) {
          server.restart()
          return
        }
        const story = isStoryFile(file)
        if (!story && file !== frameFile()) return
        lane.texts.delete(file)
        if (story && lane.files) {
          if (event === 'unlink') lane.files.delete(file)
          else lane.files.add(file)
        }
        const before = lane.source
        lane.registry = null
        lane.source = null
        let after
        try {
          after = source()
        } catch (e) {
          logger.error(e.message)
          after = null
        }
        if (after !== before) {
          const mod = server.moduleGraph.getModuleById(RESOLVED_ID)
          if (mod) server.moduleGraph.invalidateModule(mod)
        }
        if (story || after !== before) server.ws.send({ type: 'full-reload' })
      }
      for (const event of ['add', 'unlink', 'change']) server.watcher.on(event, onFile(event))

      server.middlewares.use(async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        const { pathname } = new URL(req.url ?? '/', 'http://lane')
        try {
          if (pathname === '/meta.json') {
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(metaText())
            return
          }
          if (!isLanePath(pathname) || isFileRequest(lane.root, pathname, req.headers)) return next()
          const page = await server.transformIndexHtml(`/${html}`, readFileSync(join(lane.root, html), 'utf8'), req.originalUrl ?? req.url)
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(page)
        } catch (e) {
          next(e)
        }
      })
    },

    // A story file reloads the page (above), so Vite has no module to update.
    handleHotUpdate({ file }) {
      if (lane.config && isStoryFile(relPath(lane.root, file))) return []
    },

    // `vite preview` answers the lane's routes with the built entry, as the
    // host's `_redirects` does.
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        const { pathname } = new URL(req.url ?? '/', 'http://lane')
        const page = join(lane.outDir, 'index.html')
        if (!isLanePath(pathname) || !existsSync(page)) return next()
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(readFileSync(page))
      })
    },

    // The dev server says the same when it starts.
    buildStart() {
      lane.emitted = new Set()
      if (lane.command === 'build') for (const line of problemLines()) this.warn(line)
    },

    // After Vite has written the HTML: the entry becomes index.html, beside
    // meta.json and, when asked, the host rewrite.
    generateBundle: {
      order: 'post',
      handler(_output, bundle) {
        const entry = toPosix(html)
        const asset = bundle[entry]
        if (asset && entry !== 'index.html') {
          delete bundle[entry]
          this.emitFile({ type: 'asset', fileName: 'index.html', source: asset.source })
        }
        this.emitFile({ type: 'asset', fileName: 'meta.json', source: metaText() })
        lane.emitted.add('meta.json')
        if ((lane.config.stories.hostFiles ?? []).includes('_redirects')) {
          this.emitFile({ type: 'asset', fileName: '_redirects', source: REDIRECTS_TEXT })
          lane.emitted.add('_redirects')
        }
      },
    },

    // Vite copies the app's public folder into the lane's output; a host file
    // from there would apply the app's rules to the lane, so it goes.
    writeBundle(output) {
      if (!lane.publicDir) return
      const outDir = output?.dir ?? lane.outDir
      for (const name of HOST_FILES) {
        if (!existsSync(join(lane.publicDir, name))) continue
        if (lane.emitted.has(name)) {
          this.warn(`the app's ${relPath(lane.root, join(lane.publicDir, name))} was left out of the lane's build, which writes its own ${name}`)
          continue
        }
        rmSync(join(outDir, name), { force: true })
        this.warn(`the app's ${relPath(lane.root, join(lane.publicDir, name))} was left out of the lane's build`)
      }
    },
  }
}
