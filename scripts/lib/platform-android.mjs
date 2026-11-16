// The Android platform adapter: how massimo recognises a Gradle project, the
// config block it proposes, where the app keeps colours and dimensions, where
// token outputs go, and the Kotlin reader's colour count. Gradle files are
// read as text and never edited.

import { kotlinColorLiterals } from './lang-kotlin.mjs'
import { compare } from './glob.mjs'

const dirOf = (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.')
const depth = (d) => (d === '.' ? 0 : d.split('/').length)
const under = (root, f) => (root === '.' ? f : f.startsWith(`${root}/`) ? f.slice(root.length + 1) : null)
const join = (root, rel) => (root === '.' ? rel : `${root}/${rel}`)

// Folders that hold builds, caches or editor state.
export const ANDROID_IGNORE = ['build', '.gradle', '.idea', '.cxx', '.kotlin', '.externalNativeBuild', 'captures']

// The modules a settings file includes, as folder paths relative to it:
// include(":a:b") and include ':a:b' give a/b; projectDir overrides are read
// when they name a plain file("...") path.
export function settingsModules(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const names = new Set()
  for (const m of code.matchAll(/\binclude\b\s*(\()?/g)) {
    const start = m.index + m[0].length
    const end = m[1] ? code.indexOf(')', start) : code.indexOf('\n', start)
    for (const s of code.slice(start, end === -1 ? code.length : end).matchAll(/["']:?([^"']+)["']/g)) names.add(s[1].replace(/^:/, ''))
  }
  const dirs = new Map([...names].map((n) => [n, n.split(':').join('/')]))
  for (const m of code.matchAll(/project\s*\(\s*["']:?([^"']+)["']\s*\)\s*\.projectDir\s*=\s*(?:new\s+)?(?:File|file)\s*\(\s*(?:rootDir\s*,\s*)?["']([^"']+)["']\s*\)/g)) {
    if (dirs.has(m[1])) dirs.set(m[1], m[2].replace(/^\.\//, '').replace(/\/+$/, ''))
  }
  return [...dirs].map(([name, dir]) => ({ name: `:${name}`, dir })).sort((a, b) => compare(a.dir, b.dir))
}

const DS_SEGMENT = /^(?:design[-_]?system|designsystem|ui|components|.*designsystem)$/i

// What detect reports for an Android project, or null when there is none.
export function detectAndroid(files, read) {
  const own = files.filter((f) => !f.split('/').some((seg) => ANDROID_IGNORE.includes(seg)))
  const settings = own.filter((f) => /(?:^|\/)settings\.gradle(?:\.kts)?$/.test(f))
  const manifests = own.filter((f) => /(?:^|\/)src\/[^/]+\/AndroidManifest\.xml$/.test(f))
  if (settings.length === 0 && manifests.length === 0) return null
  const candidates = settings.length > 0 ? settings.map(dirOf) : manifests.map((f) => dirOf(f.slice(0, f.indexOf('/src/') === -1 ? 0 : f.indexOf('/src/'))))
  const root = [...new Set(candidates)].sort((a, b) => depth(a) - depth(b) || compare(a, b))[0]
  const settingsFile = settings.find((f) => dirOf(f) === root) ?? null
  const reasons = settingsFile ? [`${settingsFile}`] : []
  const inRoot = own.filter((f) => under(root, f) !== null)
  const gradleText = inRoot.filter((f) => /\.gradle(?:\.kts)?$|(?:^|\/)libs\.versions\.toml$/.test(f)).map((f) => read(f) ?? '').join('\n')
  const isAndroid = /com\.android\.(?:application|library)|android-application|android-library|androidApplication|androidLibrary/.test(gradleText) || manifests.length > 0
  if (!isAndroid) return null
  const catalog = inRoot.find((f) => /(?:^|\/)gradle\/libs\.versions\.toml$/.test(f))
  if (catalog) reasons.push(catalog)
  const compose = /compose-bom|androidx\.compose|org\.jetbrains\.kotlin\.plugin\.compose|kotlin-compose|\bcompose\s*=\s*true|composeOptions/.test(gradleText)
  const conventions = inRoot.some((f) => /^(?:build-logic|buildSrc)\//.test(under(root, f)))
  if (compose) reasons.push(conventions && !/compose-bom|androidx\.compose|plugin\.compose/.test(gradleText) ? 'Compose, from convention plugins (lower confidence)' : 'Compose')
  const layouts = inRoot.filter((f) => /\/res\/layout[^/]*\/[^/]+\.xml$/.test(f)).length
  const ui = [...(compose ? ['compose'] : []), ...(layouts > 0 ? ['views'] : [])]
  if (ui.length === 0) ui.push('views')
  const modules = settingsFile ? settingsModules(read(settingsFile) ?? '').map((m) => ({ ...m, path: join(root, m.dir) })) : []
  const dsModules = modules.filter((m) => m.dir.split('/').some((seg) => DS_SEGMENT.test(seg)))
  // Each design-system module on its own (never the folder they share, which
  // would hold every other core module too), the one named for a design
  // system first.
  let designSystem = null
  if (dsModules.length > 0) {
    const named = dsModules.find((m) => /design[-_]?system/i.test(m.dir.split('/').pop())) ?? dsModules[0]
    designSystem = { path: named.path, paths: dsModules.map((m) => m.path), modules: dsModules.map((m) => m.name) }
  }
  const values = inRoot.filter((f) => /\/src\/main\/res\/values(?:-night)?\/[^/]+\.xml$/.test(f) && /<(?:color|dimen)\b/.test(read(f) ?? ''))
  const kotlin = inRoot.filter((f) => f.endsWith('.kt') && !f.endsWith('.gradle.kts'))
  const previews = kotlin.filter((f) => /@Preview\b|@\w*Previews?\b/.test(read(f) ?? '')).length
  const snapshotTools = [
    ['Roborazzi', /roborazzi/i],
    ['Paparazzi', /paparazzi/i],
    ['Compose Preview Screenshot Testing', /com\.android\.compose\.screenshot/],
    ['Showkase', /showkase/i],
    ['Shot', /com\.karumi.*shot|karumi-shot/i],
  ].filter(([, re]) => re.test(gradleText)).map(([name]) => name)
  const confidence = kotlin.length === 0 && !/\.java\b/.test(inRoot.join('\n')) ? 'medium' : 'high'
  return { id: 'android', root, confidence, reasons, ui, modules: modules.map((m) => ({ name: m.name, path: m.path })), designSystem, values, previews, snapshotTools, kotlinFiles: kotlin.length }
}

// The config block detect proposes, globs relative to the block's root.
export function androidDefaults(e) {
  const rel = (p) => (e.root === '.' ? p : p.slice(e.root.length + 1))
  const ds = e.designSystem ? (e.designSystem.paths ?? [e.designSystem.path]).map(rel) : []
  return {
    root: e.root,
    ui: e.ui,
    components: { include: ds.map((d) => `${d}/**/src/main/**/*.kt`), exclude: ['**/src/test/**', '**/src/androidTest/**', '**/src/testFixtures/**'] },
    consumers: ['**/src/main/**/*.kt', ...(e.ui.includes('views') ? ['**/src/main/res/layout/**/*.xml'] : [])],
  }
}

// The module a token output goes in: the design-system module that holds the
// most colours and dimensions, else the one holding the most, else the app.
function outputModule(e) {
  const counts = new Map()
  for (const f of e.values) {
    const module = f.slice(0, f.indexOf('/src/main/res/'))
    counts.set(module, (counts.get(module) ?? 0) + 1)
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || compare(a[0], b[0])).map(([m]) => m)
  const paths = e.designSystem ? e.designSystem.paths ?? [e.designSystem.path] : []
  const ds = ranked.find((m) => paths.some((p) => m === p || m.startsWith(`${p}/`)))
  return ds ?? (e.designSystem?.modules?.length === 1 ? e.designSystem.path : null) ?? ranked[0] ?? (e.root === '.' ? 'app' : `${e.root}/app`)
}

// The module's namespace from its build file, which is the package its code uses.
function namespaceOf(module, read) {
  const text = read(`${module}/build.gradle.kts`) ?? read(`${module}/build.gradle`) ?? ''
  return /\bnamespace\s*=?\s*["']([\w.]+)["']/.exec(text)?.[1] ?? null
}

// The token sources and outputs detect suggests: the values files of the
// design-system modules (or of every module, with none), and a Kotlin file
// and a res folder in the module that holds the most of them.
export function androidTokens(e, files, read) {
  const dsPaths = e.designSystem ? e.designSystem.paths ?? [e.designSystem.path] : []
  const dsValues = e.values.filter((f) => dsPaths.some((p) => f.startsWith(`${p}/`)))
  const chosen = dsValues.length > 0 ? dsValues : e.values
  const modules = [...new Set(chosen.map((f) => f.slice(0, f.indexOf('/src/main/res/'))))].sort(compare)
  const sources = modules.length > 0 ? [{ kind: 'android-values', include: modules.map((m) => `${m}/src/main/res/values*/*.xml`) }] : []
  const module = outputModule({ ...e, values: chosen })
  const pkg = namespaceOf(module, read)
  const lang = files.some((f) => f.startsWith(`${module}/src/main/kotlin/`)) ? 'kotlin' : 'java'
  const outputs = [
    { format: 'compose', path: `${module}/src/main/${lang}/${(pkg ?? 'designtokens').split('.').join('/')}/DesignTokens.kt`, platform: 'android' },
    { format: 'android-xml', path: `${module}/src/main/res`, platform: 'android' },
  ]
  if (!e.ui.includes('compose')) outputs.shift()
  return { sources, outputs, package: pkg }
}

// Gradle compiles every file under a module's src/main, so nothing to add.
export function androidWire(path, libraries = []) {
  const module = path.includes('/src/') ? path.slice(0, path.indexOf('/src/')) : path
  const libs = libraries.length > 0 ? ` The file imports from ${libraries.join(', ')}; the module's build file must depend on them (a Compose module usually does).` : ''
  return { needed: false, step: `${path}: Gradle compiles everything under ${module}/src/main, so nothing to add.${libs}` }
}

export const androidColorLiterals = kotlinColorLiterals
