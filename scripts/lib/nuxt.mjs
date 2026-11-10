// Nuxt's own reading of an app, for the graph and for detect. Nuxt resolves
// "~", "@", "~~", "@@", "#shared", "#layers/<name>" and the entries of its
// config's alias option itself, through a tsconfig it writes into .nuxt/,
// which git ignores, so a reader of the source never sees them. It also
// registers every component under its components folders, so a template
// uses <BaseButton>, <base-button> or <LazyBaseButton> with no import.
//
// nuxtApp reads the same from source without running anything: the app's
// nuxt.config and its layers' (literal values only), each one's source
// folder, the aliases, and the name Nuxt gives each component file.
// withNuxt resolves an import through Nuxt's aliases when neither the
// config's aliases nor a tsconfig paths pattern matches it, and nuxtEdges
// lists the components a file uses through a template tag, an import from
// "#components", or a resolveComponent() or h() call.
//
// The naming rule, the order of the layers and of the folders scanned, the
// lookup of a tag and the aliases inside a layer follow Nuxt 4.6.4
// (packages/nuxt/src/components/scan.ts and module.ts,
// packages/kit/src/loader/config.ts, packages/nuxt/src/core/utils/names.ts,
// packages/nuxt/src/components/plugins/loader.ts and
// packages/nuxt/src/core/plugins/layer-aliasing.ts), with splitByCase,
// pascalCase and kebabCase from scule 1.3.0 (src/index.ts), which Nuxt names
// components with, and the components shadcn-nuxt 2.9.0 registers
// (packages/module/src/module.ts). The logic is kept; the code follows
// massimo's style and reads files instead of a running Nuxt. Their licences
// follow.
//
// The MIT License (MIT)
//
// Copyright (c) 2016-present - Nuxt Team
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// MIT License
//
// Copyright (c) Pooya Parsa <pooya@pi0.io>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// MIT License
//
// Copyright (c) 2023 unovue
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, posix, relative, sep } from 'node:path'
import { compare, compileGlobs } from './glob.mjs'
import { findObject } from './jsobject.mjs'
import { extractImports, stripComments } from './source.mjs'

// The values of graph.edges this module reads: "nuxt" states the default in
// a Nuxt app, "!nuxt" turns the auto-imported components' edges off.
export const NUXT_EDGE_KINDS = ['nuxt', '!nuxt']

const CONFIG_NAMES = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.mts', 'nuxt.config.cjs', 'nuxt.config.cts']
// The extensions Nuxt scans a components folder for, without their dots.
const DEFAULT_EXTENSIONS = ['mjs', 'js', 'cjs', 'mts', 'ts', 'cts', 'tsx', 'jsx', 'vue']
// What every components folder leaves out: mixins and type declarations.
const DIR_IGNORE = ['**/*{M,.m,-m}ixin.{js,ts,jsx,tsx}', '**/*.{d.ts,d.mts,d.cts,d.vue.ts,d.vue.mts,d.vue.cts}']
// What Nuxt ignores everywhere: story and test modules, type declarations,
// and a file whose name starts with its ignore prefix, "-".
const NUXT_IGNORE = compileGlobs(['**/*.stories.{js,cts,mts,ts,jsx,tsx}', '**/*.{spec,test}.{js,cts,mts,ts,jsx,tsx}', '**/*.d.{cts,mts,ts}', '**/*.d.vue.{cts,mts,ts}', '**/-*.*'])
// The tags Vue renders itself, never through a registered component.
const VUE_BUILT_INS = new Set(['Component', 'Slot', 'Template', 'Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense'])

const isExpr = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && ('expr' in v || 'spread' in v)
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !isExpr(v)
const isDir = (abs) => {
  try {
    return statSync(abs).isDirectory()
  } catch {
    return false
  }
}
const isFile = (abs) => {
  try {
    return statSync(abs).isFile()
  } catch {
    return false
  }
}

// A root-relative POSIX path, '' for the root itself; null when it leaves
// the root.
function inRoot(path) {
  const p = posix.normalize(path.replace(/\\/g, '/')).replace(/\/+$/, '')
  if (p === '.' || p === '') return ''
  if (p === '..' || p.startsWith('../')) return null
  return p.replace(/^\.\//, '')
}

const under = (dir, path) => posix.join(dir || '.', path)

// ── Names, as scule splits and joins them ──────────────────────────────────

const NUMBER_CHAR_RE = /\d/
const STR_SPLITTERS = ['-', '_', '/', '.']

function isUppercase(char = '') {
  if (NUMBER_CHAR_RE.test(char)) return undefined
  return char !== char.toLowerCase()
}

// A string's words: split at -, _, / and ., and where the case rises or
// falls ("BaseButton" -> Base, Button; "UIButton" -> UI, Button).
export function splitByCase(str) {
  const parts = []
  if (!str || typeof str !== 'string') return parts
  let buff = ''
  let previousUpper
  let previousSplitter
  for (const char of str) {
    const isSplitter = STR_SPLITTERS.includes(char)
    if (isSplitter === true) {
      parts.push(buff)
      buff = ''
      previousUpper = undefined
      continue
    }
    const isUpper = isUppercase(char)
    if (previousSplitter === false) {
      // The case rises
      if (previousUpper === false && isUpper === true) {
        parts.push(buff)
        buff = char
        previousUpper = isUpper
        continue
      }
      // The case falls
      if (previousUpper === true && isUpper === false && buff.length > 1) {
        const lastChar = buff.at(-1)
        parts.push(buff.slice(0, Math.max(0, buff.length - 1)))
        buff = lastChar + char
        previousUpper = isUpper
        continue
      }
    }
    buff += char
    previousUpper = isUpper
    previousSplitter = isSplitter
  }
  parts.push(buff)
  return parts
}

const upperFirst = (str) => (str ? str[0].toUpperCase() + str.slice(1) : '')

// Words, or a string split into them, joined as PascalCase.
export function pascalCase(str) {
  return str ? (Array.isArray(str) ? str : splitByCase(str)).map((p) => upperFirst(p)).join('') : ''
}

export function kebabCase(str) {
  return str ? (Array.isArray(str) ? str : splitByCase(str)).map((p) => p.toLowerCase()).join('-') : ''
}

// ── Component names, as Nuxt gives them ────────────────────────────────────

const QUOTE_RE = /["']/g
const GROUPING_FOLDER_RE = /^\(.*\)$/
const ISLAND_RE = /\.island(?:\.global)?$/
const COMPONENT_MODE_RE = /(?<=\.)(client|server)(?:\.global|\.island)*$/
const MODE_REPLACEMENT_RE = /(?:\.(?:client|server))?(?:\.global|\.island)*$/

// The words of a component's name: its folder words, less the ones its file
// name repeats at their end (base/BaseButton -> Base, Button), with grouping
// folders such as "(forms)" left out.
function componentNameSegments(fileName, prefixParts) {
  const fileNameParts = splitByCase(fileName)
  const fileNamePartsContent = fileNameParts.join('/').toLowerCase()
  const componentPrefixParts = prefixParts.filter((part) => !GROUPING_FOLDER_RE.test(part.trim()))
  const componentNameParts = componentPrefixParts.flatMap((p) => splitByCase(p))
  let index = componentPrefixParts.length - 1
  const matchedSuffix = []
  while (index >= 0) {
    const prefixPart = componentPrefixParts[index]
    matchedSuffix.unshift(...splitByCase(prefixPart).map((p) => p.toLowerCase()))
    const matchedSuffixContent = matchedSuffix.join('/')
    if (
      fileNamePartsContent === matchedSuffixContent ||
      fileNamePartsContent.startsWith(`${matchedSuffixContent}/`) ||
      // Item/Item/Item.vue -> Item
      (prefixPart.toLowerCase() === fileNamePartsContent && componentPrefixParts[index + 1] === prefixPart)
    ) {
      componentNameParts.length = index
    }
    index--
  }
  return [...componentNameParts, ...fileNameParts]
}

// The name and mode Nuxt registers for `rel`, a file's path inside the
// components folder `dir` ({ path, prefix, pathPrefix, island }): the
// folder's prefix and, unless pathPrefix is false, the folders between, then
// the file name less a .client, .server, .global or .island suffix; an index
// file takes its folder's place.
export function componentNameIn(dir, rel) {
  const relDir = posix.dirname(rel)
  const prefixParts = [].concat(
    typeof dir.prefix === 'string' && dir.prefix ? splitByCase(dir.prefix) : [],
    dir.pathPrefix !== false ? splitByCase(relDir === '.' ? '' : relDir) : [],
  )
  const base = posix.basename(rel)
  let fileName = base.slice(0, base.length - posix.extname(base).length)
  const island = ISLAND_RE.test(fileName) || Boolean(dir.island)
  const mode = island ? 'server' : fileName.match(COMPONENT_MODE_RE)?.[1] || 'all'
  fileName = fileName.replace(MODE_REPLACEMENT_RE, '')
  if (fileName.toLowerCase() === 'index') fileName = dir.pathPrefix === false ? posix.basename(posix.dirname(under(dir.path, rel))) : ''
  const segments = componentNameSegments(fileName.replace(QUOTE_RE, ''), prefixParts)
  return { pascalName: pascalCase(segments), kebabName: kebabCase(segments), mode }
}

// ── nuxt.config, read as literals ──────────────────────────────────────────

// A folder's nuxt.config as { file, config }: the object it exports, with
// anything that is not a literal left as { expr }; null when it has none.
function readConfig(root, dir, warnings) {
  for (const name of CONFIG_NAMES) {
    const file = dir ? `${dir}/${name}` : name
    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    const config = findObject(stripComments(text, file), [/\bdefineNuxtConfig\s*\(/, /\bexport\s+default\s*/])
    if (!config) warnings.push(`${file} does not export an object the graph can read without running it, so its options are not read`)
    return { file, config: config ?? {} }
  }
  return null
}

// The major version of Nuxt the app depends on, or null when its package.json
// does not say and node_modules does not hold it.
function nuxtMajor(root) {
  let pkg = null
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    // no readable package.json
  }
  const spec = ['dependencies', 'devDependencies', 'peerDependencies'].map((k) => pkg?.[k]?.nuxt).find((v) => typeof v === 'string')
  const m = /^[\^~>=<\s]*v?(\d+)/.exec(spec ?? '')
  if (m) return Number(m[1])
  try {
    const installed = JSON.parse(readFileSync(join(root, 'node_modules', 'nuxt', 'package.json'), 'utf8')).version
    const n = /^(\d+)/.exec(String(installed))
    return n ? Number(n[1]) : null
  } catch {
    return null
  }
}

// The source folder of a layer whose root is `dir`: its literal srcDir; else
// app/ in Nuxt 4's layout (Nuxt 3 takes it only with compatibilityVersion
// 4), unless app/ holds nothing but a SPA loading template or router options
// while the root has an app.vue or the usual folders; else the root.
function srcDirOf(root, dir, config, major) {
  if (typeof config.srcDir === 'string' && config.srcDir) return inRoot(under(dir, config.srcDir)) ?? dir
  const compat4 = isObject(config.future) && config.future.compatibilityVersion === 4
  if (major !== null && major < 4 && !compat4) return dir
  const app = dir ? `${dir}/app` : 'app'
  if (!isDir(join(root, app))) return dir
  let entries = []
  try {
    entries = readdirSync(join(root, app))
  } catch {
    // unreadable: as empty
  }
  if (entries.some((f) => f !== 'spa-loading-template.html' && !f.startsWith('router.options'))) return app
  if (['app.vue', 'App.vue'].some((f) => isFile(join(root, dir, f)))) return dir
  if (['assets', 'layouts', 'middleware', 'pages', 'plugins'].some((d) => isDir(join(root, dir, d)))) return dir
  return app
}

// The sources a config extends, as written: a string, or the first item of
// a [source, options] pair. One the graph cannot read is a warning.
function extendsOf(read, warnings) {
  const value = read.config.extends
  if (value === undefined || value === null) return []
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null
  if (!list) {
    warnings.push(`${read.file} sets extends to something the graph cannot read without running it, so its layers are not read`)
    return []
  }
  const out = []
  for (const item of list) {
    const source = typeof item === 'string' ? item : Array.isArray(item) && typeof item[0] === 'string' ? item[0] : null
    if (source) out.push(source)
    else if (item !== null && item !== undefined && item !== false) warnings.push(`${read.file} extends a layer the graph cannot read without running the config, so that layer is not read`)
  }
  return out
}

// Where a layer named in extends sits, as a root-relative folder: a path from
// the extending layer, or from the root through ~, @, ~~ or @@; null for a
// remote layer, a package, or a folder outside the repo.
function layerPath(root, from, source) {
  const s = source.replace(/\/+$/, '')
  if (/^[a-z][\w+.-]*:/i.test(s)) return null
  if (s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../')) return inRoot(under(from, s))
  const alias = /^(?:~~|@@|~|@)(?:\/|$)/.exec(s)
  if (alias) return inRoot(s.slice(alias[0].length) || '.')
  if (isAbsolute(source)) return inRoot(relative(root, source).split(sep).join('/'))
  return null
}

// The app's layers in Nuxt's order, the first ranking highest: the root,
// then the folders under layers/ that hold a nuxt.config (the last in
// alphabetical order first), then the layers the root's extends lists, each
// layer followed by the ones it extends. A folder reached again keeps its
// first place. That order merges their options (`merged`). Then, for the
// rank of their components (`layers`), the layers/ folders the root's
// extends names move ahead of the other layers/ folders, in the order
// extends lists them, taking the places those folders held. A layer directly
// under layers/ is named for its folder unless its $meta names it.
function readLayers(root, rootRead, warnings) {
  let auto = []
  try {
    auto = readdirSync(join(root, 'layers'), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => `layers/${e.name}`)
  } catch {
    // no layers folder
  }
  auto.sort((a, b) => compare(b, a))
  const local = new Set(auto)
  // The layers/ folders the root's extends lists, in its order.
  const listed = []
  const layers = []
  const seen = new Set()
  const visit = (dir, read, depth) => {
    seen.add(dir)
    const config = read?.config ?? {}
    const named = isObject(config.$meta) && typeof config.$meta.name === 'string' ? config.$meta.name : local.has(dir) ? dir.slice('layers/'.length) : null
    layers.push({ dir, file: read?.file ?? null, config, name: named })
    if (!read || depth > 8) return
    const sources = extendsOf(read, warnings).map((source) => ({ source, path: layerPath(root, dir, source) }))
    for (const { source, path } of depth === 0 ? [...auto.map((p) => ({ source: null, path: p })), ...sources] : sources) {
      if (path === null) {
        warnings.push(`${read.file} extends "${source}", a layer outside the repo, so the graph does not read its components or aliases`)
        continue
      }
      if (depth === 0 && source !== null && local.has(path) && !listed.includes(path)) listed.push(path)
      if (seen.has(path)) continue
      const child = readConfig(root, path, warnings)
      if (!child) {
        if (source !== null) warnings.push(`${read.file} extends "${source}", but ${path || '.'} holds no nuxt.config, so Nuxt reads no layer there`)
        continue
      }
      visit(path, child, depth + 1)
    }
  }
  visit('', rootRead, 0)
  const merged = [...layers]
  const slots = layers.flatMap((layer, i) => (local.has(layer.dir) ? [i] : []))
  const rank = (layer) => (listed.includes(layer.dir) ? listed.indexOf(layer.dir) : listed.length)
  const ordered = slots.map((slot) => layers[slot]).map((layer, i) => ({ layer, i })).sort((a, b) => rank(a.layer) - rank(b.layer) || a.i - b.i)
  slots.forEach((slot, i) => {
    layers[slot] = ordered[i].layer
  })
  return { layers, merged }
}

// ── Aliases ─────────────────────────────────────────────────────────────────

// Whether `spec` goes through the alias `key`: the key itself, or the key
// and a path below it.
const matchesKey = (spec, key) => spec === key || spec.startsWith(key.endsWith('/') ? key : `${key}/`)

// An alias table, longest key first.
const table = (entries) => Object.entries(entries).map(([key, target]) => ({ key, target })).sort((a, b) => b.key.length - a.key.length || compare(a.key, b.key))

// Where `spec` points through `aliases`, as a root-relative path; null when
// no key matches or the path leaves the root.
function throughAliases(aliases, spec) {
  for (const { key, target } of aliases) {
    if (matchesKey(spec, key)) return inRoot(under(target, spec.slice(key.length).replace(/^\/+/, '')))
  }
  return null
}

// A literal alias value as a root-relative path: a path from the layer, a
// path through one of the built-in aliases, an absolute path inside the
// repo, or `new URL('<path>', import.meta.url)`; null for anything else.
function aliasValue(root, dir, value, builtIn) {
  let v = value
  if (isExpr(v)) {
    const url = /new\s+URL\s*\(\s*(['"`])([^'"`$]+)\1\s*,\s*import\.meta\.url\s*\)/.exec(v.expr)
    if (!url) return null
    v = url[2]
  }
  if (typeof v !== 'string' || !v) return null
  if (v === '.' || v === '..' || v.startsWith('./') || v.startsWith('../')) return inRoot(under(dir, v))
  if (isAbsolute(v)) return inRoot(relative(root, v).split(sep).join('/'))
  return throughAliases(builtIn, v)
}

// ── The components Nuxt registers ──────────────────────────────────────────

// The folders a layer's components option names, as Nuxt normalises them:
// the default three under its source folder when the option is unset or
// true, none when it is false, else each path with its options, the deepest
// first. A value the graph cannot read is a warning.
function normalizeDirs(value, cwd, priority, ctx) {
  if (Array.isArray(value)) return value.flatMap((v) => normalizeDirs(v, cwd, priority, ctx)).sort(byDepth)
  if (value === true || value === undefined) {
    return [
      { priority, path: under(cwd, 'components/islands'), island: true },
      { priority, path: under(cwd, 'components/global'), global: true },
      { priority, path: under(cwd, 'components') },
    ]
  }
  if (typeof value === 'string') {
    const path = ctx.dirPath(cwd, value)
    return path === null ? [] : [{ priority, path }]
  }
  if (isExpr(value)) {
    ctx.unread('components')
    return []
  }
  if (!value || typeof value !== 'object') return []
  const list = 'dirs' in value ? value.dirs : [value]
  if (!Array.isArray(list)) {
    if (list) ctx.unread('components.dirs')
    return []
  }
  const out = []
  for (const d of list) {
    const dir = typeof d === 'string' ? { path: d } : d
    if (isExpr(dir) || (isObject(dir) && isExpr(dir.path))) {
      ctx.unread('components')
      continue
    }
    if (!isObject(dir) || typeof dir.path !== 'string' || !dir.path) continue
    const path = ctx.dirPath(cwd, dir.path)
    if (path !== null) out.push({ priority, ...dir, path })
  }
  return out.sort(byDepth)
}

const depthOf = (path) => path.split('/').filter(Boolean).length
const byDepth = (a, b) => depthOf(b.path) - depthOf(a.path)

const modulesOf = (config) => (Array.isArray(config.modules) ? config.modules : []).map((m) => (Array.isArray(m) ? m[0] : m)).filter((m) => typeof m === 'string')

// The names a module's index file exports in `export { ... }` lists, as
// shadcn-nuxt reads them, keeping those that start with a capital.
function exportedNames(text, file) {
  const out = []
  for (const m of stripComments(text, file).matchAll(/(?<![\w$.])export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const item of m[1].split(',')) {
      const name = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim()
      if (/^[A-Z]/.test(name)) out.push(name)
    }
  }
  return out
}

// shadcn-nuxt, when a layer lists it: each componentDir (default
// "@/components/ui", prefix "Ui") is kept from Nuxt's own scan, and each
// folder in it with an index.ts or index.js registers every capitalised name
// that index exports, under the prefix, at priority 1.
function shadcnComponents(root, layers, fileSet, ctx) {
  if (!layers.some((l) => modulesOf(l.config).includes('shadcn-nuxt'))) return { blocks: [], components: [] }
  const options = {}
  for (const l of layers) {
    const own = l.config.shadcn
    if (isExpr(own)) ctx.unread('shadcn')
    if (!isObject(own)) continue
    for (const key of ['prefix', 'componentDir']) if (!(key in options) && key in own) options[key] = own[key]
  }
  const fallbackPrefix = typeof options.prefix === 'string' ? options.prefix : 'Ui'
  const raw = options.componentDir ?? '@/components/ui'
  const blocks = []
  const components = []
  for (const entry of (Array.isArray(raw) ? raw : [raw]).filter(Boolean)) {
    const dir = typeof entry === 'string' ? { path: entry, prefix: fallbackPrefix } : isObject(entry) && typeof entry.path === 'string' ? { path: entry.path, prefix: typeof entry.prefix === 'string' ? entry.prefix : fallbackPrefix } : null
    if (!dir) {
      ctx.unread('shadcn.componentDir')
      continue
    }
    const path = ctx.dirPath('', dir.path)
    if (path === null || !isDir(join(root, path))) continue
    blocks.push(path)
    const subs = new Set()
    for (const f of fileSet) {
      if (!f.startsWith(`${path}/`)) continue
      const rest = f.slice(path.length + 1)
      if (rest.includes('/')) subs.add(rest.slice(0, rest.indexOf('/')))
    }
    for (const sub of [...subs].sort(compare)) {
      const index = ['ts', 'js'].map((e) => `${path}/${sub}/index.${e}`).find((f) => fileSet.has(f))
      if (!index) continue
      let text = ''
      try {
        text = readFileSync(join(root, index), 'utf8')
      } catch {
        continue
      }
      for (const key of exportedNames(text, index)) {
        const name = `${dir.prefix}${key}`
        components.push({ pascalName: pascalCase(name), kebabName: kebabCase(name), mode: 'all', file: index, export: key, priority: 1 })
      }
    }
  }
  return { blocks, components }
}

// Every component the folders register, in Nuxt's order: a file in a folder
// scanned before is skipped, a second file with a name its folder already
// has is skipped, and a name another folder registered keeps its first file
// unless this folder's priority is higher.
function scanDirs(dirs, files) {
  const components = []
  const byName = new Map()
  const filePaths = new Set()
  const scanned = []
  for (const dir of dirs) {
    const resolvedNames = new Map()
    const base = dir.path ? `${dir.path}/` : ''
    const pattern = compileGlobs(dir.pattern)
    const ignore = compileGlobs(dir.ignore)
    const own = files
      .filter((f) => f.startsWith(base))
      .map((f) => f.slice(base.length))
      .filter((rel) => !rel.split('/').some((s) => s.startsWith('.')) && pattern(rel) && !ignore(rel))
      .sort(compare)
    for (const rel of own) {
      const file = base + rel
      if (scanned.some((d) => file.startsWith(d)) || NUXT_IGNORE(file)) continue
      if (filePaths.has(file)) continue
      filePaths.add(file)
      const { pascalName, kebabName, mode } = componentNameIn(dir, rel)
      const suffix = mode !== 'all' ? `-${mode}` : ''
      if (resolvedNames.has(pascalName + suffix) || resolvedNames.has(pascalName)) continue
      resolvedNames.set(pascalName + suffix, file)
      if (!pascalName) continue
      const component = { pascalName, kebabName, mode, file, export: 'default', priority: dir.priority ?? 1 }
      const entries = byName.get(pascalName)
      const existing = entries?.find((e) => e.component.mode === 'all' || e.component.mode === component.mode)
      if (existing) {
        if ((component.priority ?? 0) > (existing.component.priority ?? 0)) {
          components[existing.index] = component
          existing.component = component
        }
        continue
      }
      const entry = { component, index: components.length }
      if (entries) entries.push(entry)
      else byName.set(pascalName, [entry])
      components.push(component)
    }
    scanned.push(base)
  }
  return components
}

// ── The app ─────────────────────────────────────────────────────────────────

const hasRootConfig = (root, files) => (files ? CONFIG_NAMES.some((n) => files.includes(n)) : CONFIG_NAMES.some((n) => isFile(join(root, n))))

// Whether the project is a Nuxt app: its config's framework is "nuxt", or a
// nuxt.config sits at its root.
export function isNuxtApp(root, framework, files = null) {
  return framework === 'nuxt' || hasRootConfig(root, files)
}

// What the graph needs from a Nuxt app, or null for any other project:
// { autoImports, aliases, local, components, dirs }. `files` is
// the root-relative list the graph walks. Anything the configs hold that
// cannot be read without running them is a warning.
export function nuxtApp(root, config, files, warnings = []) {
  const edges = [].concat(config.graph?.edges ?? [])
  if (!isNuxtApp(root, config.framework, files)) {
    for (const kind of NUXT_EDGE_KINDS) {
      if (edges.includes(kind)) warnings.push(`graph.edges lists "${kind}", but this is not a Nuxt app (the config's framework is not "nuxt" and the root has no nuxt.config), so it ${kind === 'nuxt' ? 'adds no edges' : 'turns nothing off'}`)
    }
    return null
  }
  const app = readApp(root, files, warnings)
  return { ...app, autoImports: !edges.includes('!nuxt') }
}

function readApp(root, files, warnings) {
  const rootRead = readConfig(root, '', warnings)
  const { layers, merged } = readLayers(root, rootRead, warnings)
  const major = nuxtMajor(root)
  for (const layer of layers) layer.srcDir = srcDirOf(root, layer.dir, layer.config, major)
  const app = layers[0]
  const unreadWarned = new Set()
  const ctxFor = (layer) => ({
    dirPath: (cwd, p) => {
      const via = throughAliases(aliases, p)
      if (via !== null) return via
      if (isAbsolute(p)) return inRoot(relative(root, p).split(sep).join('/'))
      return inRoot(under(cwd, p))
    },
    unread: (key) => {
      const where = `${layer.file ?? 'nuxt.config'}: ${key}`
      if (unreadWarned.has(where)) return
      unreadWarned.add(where)
      warnings.push(`${layer.file ?? 'nuxt.config'} sets ${key} to something the graph cannot read without running it, so the components it names are not read`)
    },
  })

  // The built-in aliases, then the layers' alias option (the root's first)
  // and each named layer, as Nuxt merges them.
  const builtIn = table({ '~': app.srcDir, '@': app.srcDir, '~~': '', '@@': '' })
  const own = {}
  for (const layer of merged) {
    const option = layer.config.alias
    if (option === undefined) continue
    if (!isObject(option)) {
      warnings.push(`${layer.file} sets alias to something the graph cannot read without running it, so imports through it are not resolved`)
      continue
    }
    for (const [key, value] of Object.entries(option)) {
      if (key in own) continue
      const target = aliasValue(root, layer.dir, value, builtIn)
      if (target === null) {
        if (isExpr(value)) warnings.push(`${layer.file} sets alias "${key}" to something the graph cannot read without running it, so imports through it are not resolved`)
        continue
      }
      own[key] = target
    }
  }
  for (const layer of merged) if (layer.name && !(`#layers/${layer.name}` in own)) own[`#layers/${layer.name}`] = layer.dir
  const entries = { '~': app.srcDir, '@': app.srcDir, '~~': '', '@@': '' }
  if (isDir(join(root, 'shared'))) entries['#shared'] = 'shared'
  const aliases = table({ ...entries, ...own })

  // Inside a layer's source folder, ~ and @ name that folder and ~~ and @@
  // its root, unless experimental.localLayerAliases is false.
  const experimental = app.config.experimental
  const local =
    isObject(experimental) && experimental.localLayerAliases === false
      ? []
      : layers
          .map((layer) => {
            const set = isObject(layer.config.alias) ? layer.config.alias : {}
            const pick = (key, fallback) => (typeof set[key] === 'string' ? aliasValue(root, layer.dir, set[key], builtIn) ?? fallback : fallback)
            return { srcDir: layer.srcDir, aliases: table({ '~': pick('~', layer.srcDir), '@': pick('@', layer.srcDir), '~~': pick('~~', layer.dir), '@@': pick('@@', layer.dir) }) }
          })
          .filter((l, i, list) => list.findIndex((x) => x.srcDir === l.srcDir) === i)
          .sort((a, b) => b.srcDir.length - a.srcDir.length || compare(a.srcDir, b.srcDir))

  // The folders each layer registers, then the ones a module adds in front.
  const extensions = [...DEFAULT_EXTENSIONS, ...(Array.isArray(app.config.extensions) ? app.config.extensions.filter((e) => typeof e === 'string').map((e) => e.replace(/^\./, '')) : [])]
  const layerDirs = []
  layers.forEach((layer, i) => layerDirs.push(...normalizeDirs(layer.config.components, layer.srcDir, layers.length - i, ctxFor(layer))))
  const fileSet = new Set(files)
  const shadcn = shadcnComponents(root, merged, fileSet, ctxFor(app))
  const dirs = [...shadcn.blocks.map((path) => ({ path, priority: 0, ignore: ['**/*'] })), ...layerDirs].map((d) => {
    const exts = Array.isArray(d.extensions) ? d.extensions.filter((e) => typeof e === 'string').map((e) => e.replace(/^\./, '')) : extensions
    const pattern = typeof d.pattern === 'string' || Array.isArray(d.pattern) ? [].concat(d.pattern).filter((p) => typeof p === 'string') : [exts.length > 1 ? `**/*.{${exts.join(',')}}` : `**/*.${exts[0] || '*'}`]
    return { ...d, pattern, ignore: [...DIR_IGNORE, ...(Array.isArray(d.ignore) ? d.ignore.filter((g) => typeof g === 'string') : [])] }
  })
  const components = scanDirs(dirs, files)
  // A module's component takes the place of a scanned one of the same name
  // and mode unless that one's priority is higher.
  for (const c of shadcn.components) {
    const i = components.findIndex((x) => (x.pascalName === c.pascalName || x.kebabName === c.kebabName) && x.mode === c.mode)
    if (i === -1) components.push(c)
    else if (c.priority >= (components[i].priority ?? 0)) components.splice(i, 1, c)
  }
  const byName = new Map()
  for (const c of components) {
    if (!byName.has(c.pascalName)) byName.set(c.pascalName, [])
    byName.get(c.pascalName).push(c)
  }
  return { aliases, local, components: byName, dirs: dirs.map((d) => ({ path: d.path, blocks: d.ignore.includes('**/*') })) }
}

// Where `spec` points through Nuxt's aliases from `fromFile`, as a
// root-relative path, or null: the aliases of the layer whose source folder
// holds the file first, then the app's.
function nuxtPath(app, fromFile, spec) {
  const layer = app.local.find((l) => l.srcDir === '' || fromFile.startsWith(`${l.srcDir}/`))
  return (layer ? throughAliases(layer.aliases, spec) : null) ?? throughAliases(app.aliases, spec)
}

// A resolver that tries Nuxt's aliases for an import `resolve` leaves
// without a file, unless one of the config's aliases or a tsconfig paths
// pattern took it: a hit through them is the file, and an alias that points
// at nothing is unresolved. Virtual modules (#imports, #components, #app...)
// stay framework imports. pathOf, for import.meta.glob, goes the same way:
// the config's aliases and the tsconfig paths first, else Nuxt's aliases.
export function withNuxt(resolve, app) {
  if (!app) return resolve
  const wrapped = (fromFile, rawSpec) => {
    const hit = resolve(fromFile, rawSpec)
    if (hit.file || (!hit.external && resolve.aliased?.(rawSpec))) return hit
    const target = nuxtPath(app, fromFile, rawSpec.replace(/(?!^)[?#].*$/, ''))
    if (target === null) return hit
    const back = posix.relative(posix.dirname(fromFile), target) || '.'
    const found = resolve(fromFile, back.startsWith('.') ? back : `./${back}`)
    return found.file ? found : { unresolved: rawSpec }
  }
  wrapped.pathOf = (fromFile, spec) => (resolve.aliased?.(spec) ? null : nuxtPath(app, fromFile, spec)) ?? resolve.pathOf(fromFile, spec)
  return wrapped
}

// ── What a file uses ────────────────────────────────────────────────────────

// A template's {{ }} interpolation, or an opening tag with its attributes,
// whose quoted values may hold < and >.
const TEMPLATE_TOKEN_RE = /\{\{[\s\S]*?\}\}|<([A-Za-z][\w-]*)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^"'>])*>?/g

// The tags a Vue file's template opens that can name a component: one with a
// capital or a hyphen, not one of Vue's own, not a dotted member. Text in an
// interpolation or a quoted attribute value is not a tag.
function templateTags(source) {
  const body = source.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  const open = /<template\b([^>]*)>/i.exec(body)
  if (!open || /\blang\s*=\s*["']?(?!html\b)\w/i.test(open[1])) return []
  const end = body.lastIndexOf('</template')
  const inner = body.slice(open.index + open[0].length, end > open.index ? end : body.length).replace(/<!--[\s\S]*?-->/g, '')
  const out = []
  for (const m of inner.matchAll(TEMPLATE_TOKEN_RE)) {
    const tag = m[1]
    if (tag && (/[A-Z]/.test(tag) || tag.includes('-')) && !VUE_BUILT_INS.has(pascalCase(tag))) out.push(tag)
  }
  return out
}

const camelize = (s) => s.replace(/-(\w)/g, (_, c) => (c ? c.toUpperCase() : ''))

// The names a Vue file's scripts bind, which a template tag reaches before a
// registered component: what they import, and what <script setup> declares.
function scriptBindings(source) {
  const out = new Set()
  for (const m of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const code = stripComments(m[2], 'x.ts')
    for (const imp of code.matchAll(/(?<![\w$.])import\s+(?!type\s)([\w$*\s{},]+?)\s*\bfrom\s*['"]/g)) {
      const clause = imp[1]
      const head = clause.replace(/\{[\s\S]*\}/, '')
      for (const part of head.split(',')) {
        const name = part.trim().replace(/^\*\s*as\s+/, '')
        if (/^[\w$]+$/.test(name)) out.add(name)
      }
      const braced = /\{([\s\S]*)\}/.exec(clause)
      for (const item of braced ? braced[1].split(',') : []) {
        const s = item.trim()
        if (!s || /^type\s/.test(s)) continue
        out.add(s.split(/\s+as\s+/).pop().trim())
      }
    }
    if (/\bsetup\b/.test(m[1])) for (const d of code.matchAll(/(?<![\w$.])(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(d[1])
  }
  return out
}

const LAZY_RE = /^(?:lazy-|Lazy(?=[A-Z]))/
const HYDRATION_STRATEGY_RE = /^(?<strategy>Idle|Visible|Interaction|MediaQuery|If|Never|Time)_(?<name>.+)$/
const LEGACY_HYDRATION_STRATEGY_RE = /^(?<strategy>Idle|Visible|idle-|visible-|Interaction|interaction-|MediaQuery|media-query-|If|if-|Never|never-|Time|time-)(?<name>.+)$/

// The files a name used in a template or a call reaches, as Nuxt's loader
// finds them: a Lazy prefix and a hydration strategy taken off, then the
// component of that PascalCase name, the one for every mode or else the
// client's and the server's.
function targetsOf(app, raw) {
  const find = (name) => {
    const entries = app.components.get(pascalCase(name).replace(QUOTE_RE, '')) ?? []
    const pick = (mode) => entries.find((e) => e.mode === 'all' || e.mode === mode)
    return [...new Set([pick('client') ?? entries[0], pick('server')].filter(Boolean))]
  }
  const lazy = LAZY_RE.exec(raw)
  if (!lazy) return find(raw)
  const name = raw.slice(lazy[0].length)
  const hydrated = HYDRATION_STRATEGY_RE.exec(name)
  if (hydrated) return find(hydrated.groups.name)
  const direct = find(name)
  if (direct.length > 0) return direct
  const legacy = LEGACY_HYDRATION_STRATEGY_RE.exec(name)
  return legacy ? find(legacy.groups.name) : []
}

// The edges a file has to the components Nuxt registers, as { file, names }:
// each template tag the scripts do not bind, each resolveComponent('Name')
// and h(Name) call in a Vue, JSX or TSX file, and each name imported from
// "#components". Empty when the app's auto-import edges are off.
export function nuxtEdges(app, file, source) {
  if (!app?.autoImports) return []
  const names = []
  const vue = /\.vue$/i.test(file)
  if (vue) {
    const bound = scriptBindings(source)
    for (const tag of templateTags(source)) {
      const camel = camelize(tag)
      if (!bound.has(tag) && !bound.has(camel) && !bound.has(upperFirst(camel))) names.push(tag)
    }
  }
  if (vue || /\.[jt]sx$/i.test(file)) {
    const code = stripComments(source, file)
    for (const m of code.matchAll(/(?<![\w$.])_?resolveComponent\d*\s*\(\s*(['"`])([^'"`]*)\1/g)) names.push(m[2])
    for (const m of code.matchAll(/(?<=\bh\s*\(\s*)([A-Z][\w$]*)\b/g)) names.push(m[1])
  }
  if (source.includes('#components')) {
    for (const imp of extractImports(source, file)) {
      if (imp.spec === '#components' && !imp.typeOnly) names.push(...imp.names.filter((n) => n !== '*' && n !== 'default'))
    }
  }
  const out = []
  const seen = new Set()
  for (const name of names) {
    for (const target of targetsOf(app, name)) {
      const key = `${target.file}\n${target.export}`
      if (target.file === file || seen.has(key)) continue
      seen.add(key)
      out.push({ file: target.file, names: [target.export] })
    }
  }
  return out
}

// The outermost of `dirs`, sorted: a folder inside another is left out.
const outermost = (dirs) =>
  [...new Set(dirs)]
    .sort((a, b) => a.length - b.length || compare(a, b))
    .filter((dir, i, list) => !list.slice(0, i).some((o) => o === '' || dir.startsWith(`${o}/`)))
    .sort(compare)

// The folders whose files a Nuxt app registers as components and that hold
// a .vue file, outermost only, sorted; null for a project that is not a Nuxt
// app or registers none. detect suggests them as components.include.
export function nuxtComponentFolders(root, files, framework) {
  if (!isNuxtApp(root, framework, files)) return null
  const { dirs } = readApp(root, files, [])
  const outer = outermost(dirs.map((d) => d.path).filter((dir) => files.some((f) => f.startsWith(`${dir}/`) && f.endsWith('.vue'))))
  return outer.length > 0 ? outer : null
}

// The source folder of a Nuxt app, root-relative: app/ in Nuxt 4's layout,
// the literal srcDir its config sets, '' for the root; null for a project
// that is not a Nuxt app.
export function nuxtSrcDir(root, files, framework) {
  if (!isNuxtApp(root, framework, files)) return null
  return srcDirOf(root, '', readConfig(root, '', [])?.config ?? {}, nuxtMajor(root))
}

// The root's own nuxt.config as literals, anything computed left as
// { expr }; null when the root has none.
export function nuxtRootConfig(root) {
  return readConfig(root, '', [])?.config ?? null
}

// detect's component folders, `dirs`, with the ones a Nuxt app registers,
// `nuxt`, added: the outermost of both, sorted. Without `nuxt`, `dirs` as
// they are.
export function withNuxtFolders(dirs, nuxt) {
  return nuxt ? outermost([...dirs, ...nuxt]) : dirs
}

