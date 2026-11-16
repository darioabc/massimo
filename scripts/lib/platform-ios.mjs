// The iOS platform adapter: how massimo recognises an Xcode, SwiftPM, Tuist
// or XcodeGen project, the config block it proposes, where the app keeps its
// colours, where token outputs go and how they are wired in, and the Swift
// reader's colour count. Everything is read as text; massimo never edits a
// .xcodeproj, Package.swift, Project.swift or project.yml.

import { posix } from 'node:path'
import { swiftColorLiterals } from './lang-swift.mjs'
import { compare } from './glob.mjs'

const dirOf = (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.')
const depth = (d) => (d === '.' ? 0 : d.split('/').length)
const under = (root, f) => (root === '.' ? f : f.startsWith(`${root}/`) ? f.slice(root.length + 1) : null)
const join = (root, rel) => (root === '.' ? rel : `${root}/${rel}`)

// Folders that hold builds, dependencies or editor state, never the app's own source.
export const IOS_IGNORE = ['Pods', '.build', 'DerivedData', 'Carthage', 'xcuserdata', '.swiftpm', 'SourcePackages']

// A folder of examples, demos, previews or tests: its catalogs are not the app's colours.
const NOT_THE_APP = /(?:^|\/)(?:\.?demo|demos|example|examples|sample|samples|preview content|tests?|uitests|snapshots?|fixtures?)(?:\/|$)/i

// The project files, by kind, in the order that decides the kind: a
// generator first, since the .xcodeproj it makes is often not committed.
const KINDS = [
  ['tuist', (f) => /(?:^|\/)(?:Project\.swift|Workspace\.swift|Tuist\.swift|tuist\.toml|Tuist\/Config\.swift)$/.test(f)],
  ['xcodegen', (f) => /(?:^|\/)project\.ya?ml$/.test(f)],
  ['swiftpm', (f) => /(?:^|\/)Package\.swift$/.test(f) && !/(?:^|\/)Tuist\/Package\.swift$/.test(f)],
  ['xcworkspace', (f) => /\.xcworkspace\/contents\.xcworkspacedata$/.test(f) && !/\.xcodeproj\/project\.xcworkspace\//.test(f)],
  ['xcodeproj', (f) => /\.xcodeproj\/project\.pbxproj$/.test(f)],
]
const projectPath = (kind, f) => (kind === 'xcworkspace' || kind === 'xcodeproj' ? f.replace(/\/[^/]+$/, '') : f)
// Tuist's helper folder belongs to the project above it: Tuist/Config.swift marks the folder that holds Tuist/.
const isTuistHelper = (f) => /(?:^|\/)Tuist\/[^/]+\.swift$/.test(f)
const markerDir = (kind, f) => (kind === 'tuist' && isTuistHelper(f) ? dirOf(dirOf(f)) : dirOf(projectPath(kind, f)))

// Targets a Package.swift declares, read as text: [{ name, path, test }].
// A name may be a string, or a constant the file declares (`let ds = "DesignSystem"`).
export function packageTargets(text) {
  const out = []
  const constant = (id) => new RegExp(String.raw`\b(?:let|var)\s+${id}\s*(?::\s*String\s*)?=\s*"([^"]+)"`).exec(text)?.[1] ?? null
  for (const m of text.matchAll(/\.(target|testTarget|executableTarget|macro|plugin)\s*\(\s*name\s*:\s*(?:"([^"]+)"|([A-Za-z_]\w*)\b)/g)) {
    const name = m[2] ?? constant(m[3])
    if (!name) continue
    const rest = text.slice(m.index, m.index + 4000)
    // The path belongs to this target when it comes before the next one starts.
    const nextTarget = rest.slice(1).search(/\.(?:target|testTarget|executableTarget|macro|plugin|binaryTarget)\s*\(/)
    const own = nextTarget === -1 ? rest : rest.slice(0, nextTarget + 1)
    const path = /\bpath\s*:\s*"([^"]+)"/.exec(own)?.[1] ?? null
    out.push({ name, path, test: m[1] === 'testTarget' })
  }
  return out
}

// The Swift package target a repo-relative path sits in: { package (the
// folder that holds Package.swift), dir (the target's folder), name }, or
// null. `read` gives a file's text and `files` the repo's file list.
export function packageTargetOf(path, files, read) {
  const packages = files.filter((f) => /(?:^|\/)Package\.swift$/.test(f)).map(dirOf).sort((a, b) => depth(b) - depth(a))
  for (const pkg of packages) {
    const inside = under(pkg, path)
    if (inside === null) continue
    const targets = packageTargets(read(join(pkg, 'Package.swift')) ?? '').filter((t) => !t.test)
    for (const t of targets) {
      const dir = (t.path ?? `Sources/${t.name}`).replace(/\/+$/, '')
      if (inside === dir || inside.startsWith(`${dir}/`)) return { package: pkg, dir: join(pkg, dir), name: t.name }
    }
  }
  return null
}

// Targets an XcodeGen project.yml declares, the keys one step under
// `targets:` (at whatever indent the file uses), each with the folders its
// sources name (`sources: [A, B]`, `sources: A`, a list of paths, of
// `- path: A` or of `- {path: A}`), relative to the spec and kept inside
// the repo. Comments are left out.
function xcodegenTargets(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, '').replace(/\s+$/, ''))
  const at = lines.findIndex((l) => /^targets\s*:$/.test(l))
  if (at === -1) return []
  const body = []
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line)) break
    body.push(line)
  }
  const indent = (l) => /^ */.exec(l)[0].length
  const first = body.find((l) => l.trim())
  if (!first) return []
  const step = indent(first)
  const clean = (v) => {
    const p = posix.normalize(v.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, ''))
    return p && p !== '..' && !p.startsWith('../') && !p.startsWith('/') ? p : null
  }
  const out = []
  let sources = -1
  for (const line of body) {
    if (!line.trim()) continue
    const m = indent(line) === step ? /^\s*([A-Za-z0-9_.-]+)\s*:/.exec(line) : null
    if (m) {
      out.push({ name: m[1], paths: [] })
      sources = -1
      continue
    }
    const target = out[out.length - 1]
    if (!target) continue
    const add = (v) => {
      const p = clean(v)
      if (p && !target.paths.includes(p)) target.paths.push(p)
    }
    const key = /^(\s*)sources\s*:\s*(.*)$/.exec(line)
    if (key && indent(line) > step) {
      const rest = key[2].trim()
      if (rest.startsWith('[')) for (const item of rest.slice(1, rest.lastIndexOf(']')).split(',')) (/path\s*:\s*([^,}]+)/.exec(item) ? add(/path\s*:\s*([^,}]+)/.exec(item)[1]) : !item.includes(':') && add(item))
      else if (rest) add(rest)
      sources = rest ? -1 : indent(line)
      continue
    }
    if (sources === -1) continue
    if (indent(line) <= sources && !/^\s*-/.test(line)) {
      sources = -1
      continue
    }
    const flow = /^\s*-\s*\{(.*)\}\s*$/.exec(line)
    const path = /^\s*(?:-\s*)?path\s*:\s*(.+)$/.exec(line)
    const plain = /^\s*-\s*([^:{}]+)$/.exec(line)
    if (flow) {
      const p = /path\s*:\s*([^,}]+)/.exec(flow[1])
      if (p) add(p[1])
    } else if (path) add(path[1])
    else if (plain) add(plain[1])
  }
  return out.map((t) => ({ ...t, path: t.paths[0] ?? null }))
}

// The targets a project.pbxproj declares, and its folders Xcode keeps
// in sync with the disk (Xcode 16), which pick up new files by themselves.
// `folders` maps a target to the folders that are its own: the synced
// folders it lists, else a top group named after it (an older project).
export function pbxprojInfo(text) {
  const objects = (isa) => [...text.matchAll(new RegExp(String.raw`(\w+) \/\* ([^*]+?) \*\/ = \{\s*isa = ${isa};([^{}]*?)\n\s*\};`, 'g'))].map((m) => ({ id: m[1], name: m[2], body: m[3] }))
  const pathOf = (body) => /\bpath = ("?)([^";\n]+)\1;/.exec(body)?.[2] ?? null
  const syncedGroups = objects('PBXFileSystemSynchronizedRootGroup').map((g) => ({ id: g.id, path: pathOf(g.body) })).filter((g) => g.path)
  const groups = objects('PBXGroup').map((g) => ({ name: g.name, path: pathOf(g.body) })).filter((g) => g.path)
  const native = objects('PBXNativeTarget')
  const targets = native.length > 0 ? native.map((t) => t.name) : [...text.matchAll(/\/\* ([^*]+?) \*\/ = \{\s*isa = PBXNativeTarget;/g)].map((m) => m[1])
  const folders = new Map()
  for (const t of native) {
    const list = /fileSystemSynchronizedGroups = \(([^)]*)\)/.exec(t.body)?.[1] ?? ''
    const own = syncedGroups.filter((g) => new RegExp(String.raw`\b${g.id}\b`).test(list)).map((g) => g.path)
    const named = own.length > 0 ? own : [...syncedGroups.filter((g) => g.path === t.name).map((g) => g.path), ...groups.filter((g) => g.name === t.name || g.path === t.name).map((g) => g.path)]
    if (named.length > 0) folders.set(t.name, [...new Set(named)])
  }
  return { targets: [...new Set(targets)], synced: [...new Set(syncedGroups.map((g) => g.path))], folders }
}

// Targets a Tuist Project.swift declares, read as text: [{ name, dirs }],
// the folders its sources and resources globs start from.
export function tuistTargets(text) {
  const starts = [...text.matchAll(/(?:\.target|\bTarget(?:\.target)?)\s*\(\s*name\s*:\s*"([^"]+)"/g)]
  return starts.map((m, i) => {
    const own = text.slice(m.index, starts[i + 1]?.index ?? text.length)
    const lists = [...own.matchAll(/\b(?:sources|resources)\s*:\s*(\[[^\]]*\]|"[^"]*")/g)].map((x) => x[1])
    const dirs = lists.flatMap((l) => [...l.matchAll(/"([^"]+)"/g)].map((x) => x[1].split(/[*{]/)[0].replace(/\/+$/, ''))).filter(Boolean)
    return { name: m[1], dirs: [...new Set(dirs)] }
  })
}

// The folders whose code and resources one target compiles into a bundle
// of its own: [{ dir, id, label, package }], from Swift package targets,
// Xcode targets, XcodeGen targets' sources and Tuist projects. Two paths
// compile into one bundle when the deepest folder each sits in is one target's.
export function bundleHomes(files, read) {
  const homes = []
  const add = (dir, id, label, pkg = false) => homes.push({ dir: dir.replace(/\/+$/, '') || '.', id, label, package: pkg })
  for (const f of files.filter((x) => /(?:^|\/)Package\.swift$/.test(x) && !/(?:^|\/)Tuist\/Package\.swift$/.test(x))) {
    for (const t of packageTargets(read(f) ?? '').filter((x) => !x.test)) add(join(dirOf(f), t.path ?? `Sources/${t.name}`), `package:${f}:${t.name}`, `the Swift package target ${t.name}`, true)
  }
  for (const f of files.filter((x) => x.endsWith('.xcodeproj/project.pbxproj'))) {
    const info = pbxprojInfo(read(f) ?? '')
    for (const [name, dirs] of info.folders) for (const d of dirs) add(join(dirOf(dirOf(f)), d), `xcode:${f}:${name}`, `the Xcode target ${name}`)
  }
  for (const f of files.filter((x) => /(?:^|\/)project\.ya?ml$/.test(x))) {
    const text = read(f) ?? ''
    if (!isXcodegenSpec(text)) continue
    for (const t of xcodegenTargets(text)) for (const d of t.paths ?? (t.path ? [t.path] : [])) add(join(dirOf(f), d), `xcodegen:${f}:${t.name}`, `the XcodeGen target ${t.name}`)
  }
  for (const f of files.filter((x) => /(?:^|\/)Project\.swift$/.test(x) && !isTuistHelper(x))) {
    const targets = tuistTargets(read(f) ?? '')
    // One target owns the whole project folder; several, the folders their globs name.
    if (targets.length === 1 && targets[0].dirs.length === 0) add(dirOf(f), `tuist:${f}:${targets[0].name}`, `the Tuist target ${targets[0].name}`)
    for (const t of targets) for (const d of t.dirs) add(join(dirOf(f), d), `tuist:${f}:${t.name}`, `the Tuist target ${t.name}`)
  }
  return homes
}

// The bundle home a repo-relative path sits in, the deepest one, or null.
export function bundleOf(path, homes) {
  const inside = homes.filter((h) => h.dir === '.' || path === h.dir || path.startsWith(`${h.dir}/`))
  return inside.sort((a, b) => depth(b.dir) - depth(a.dir) || Number(b.package) - Number(a.package))[0] ?? null
}

// Whether two paths compile into one bundle: the same target's, or neither
// in a target massimo can see. `strict` (for removing a duplicate) asks for
// that; else a path in no target massimo can see may share the bundle of
// one outside a Swift package, as an Xcode project it cannot read would.
export function sameBundle(a, b, homes, { strict = false } = {}) {
  const x = bundleOf(a, homes)
  const y = bundleOf(b, homes)
  if (x && y) return x.id === y.id
  if (!x && !y) return true
  return !strict && !(x?.package || y?.package)
}

const DS_NAME = /^(?:design[-_ ]?system|ui|components|.*designsystem)$/i

// A project.yml is an XcodeGen spec when it declares targets for an Apple
// platform; the name alone is common (a deploy or CI file).
// Its targets may sit in an included file, and a platform may be a list or
// supportedDestinations.
const isXcodegenSpec = (text) => /^(?:targets|include)\s*:/m.test(text) && (/^include\s*:/m.test(text) || /^\s*deploymentTarget\s*:/m.test(text) || /^\s*(?:platform|supportedDestinations)\s*:[^\n]*(?:\n\s+-[^\n]*)*/m.test(text) && /\b(?:iOS|macOS|tvOS|watchOS|visionOS|auto)\b/.test(text))

// An import of a UI framework in Swift, in every form Swift 6 writes one:
// an access level (public import), attributes (@preconcurrency,
// @_exported), or one declaration (import struct SwiftUI.Color).
const swiftImport = (mod) => new RegExp(String.raw`^[ \t]*(?:@\w+(?:\([^)\n]*\))?[ \t]+)*(?:(?:public|package|internal|fileprivate|private)[ \t]+)?import[ \t]+(?:(?:struct|class|enum|protocol|func|var|let|typealias)[ \t]+)?${mod}\b`, 'm')
const IMPORTS = { swiftui: swiftImport('SwiftUI'), uikit: swiftImport('UIKit'), appkit: swiftImport('AppKit') }
const OBJC_UI = /^[ \t]*(?:#import[ \t]*<(?:UIKit|AppKit|Cocoa)\/|@import[ \t]+(?:UIKit|AppKit|Cocoa)\b)/m
// Swift files read for the counts; the gate goes on past them until it finds a UI import.
const SAMPLE = 600

// A Tuist manifest imports ProjectDescription; a file of that name in the app's own code does not.
const isManifest = (kind, f, read) => kind !== 'tuist' || !f.endsWith('.swift') || /^\s*import\s+ProjectDescription\b/m.test(read(f) ?? '')

// What detect reports for an iOS project, or null when there is none.
// `files` are repo-relative paths with ignored folders already left out.
export function detectIos(files, read) {
  const own = files.filter((f) => !f.split('/').some((seg) => IOS_IGNORE.includes(seg)))
  const markers = []
  for (const f of own) {
    const kind = KINDS.find(([, test]) => test(f))?.[0]
    if (kind === 'xcodegen' && !isXcodegenSpec(read(f) ?? '')) continue
    if (kind && !isManifest(kind, f, read)) continue
    if (kind) markers.push({ kind, path: projectPath(kind, f), dir: markerDir(kind, f), file: f })
  }
  if (markers.length === 0) return null
  // Manifests and Tuist's own folder are not the app's code.
  const manifestFiles = new Set(markers.map((m) => m.file))
  const swift = own.filter((f) => f.endsWith('.swift') && !manifestFiles.has(f) && !/(?:^|\/)Package\.swift$/.test(f) && !/(?:^|\/)Tuist\//.test(f))
  // The shallowest project folder with a UI, in name order: a server package
  // or a command-line tool beside the app never hides it.
  const look = (root) => {
    const inRoot = swift.filter((f) => under(root, f) !== null)
    const imports = { swiftui: 0, uikit: 0, appkit: 0 }
    inRoot.forEach((f, i) => {
      if (i >= SAMPLE && (imports.swiftui || imports.uikit || imports.appkit)) return
      const text = read(f) ?? ''
      for (const k of Object.keys(imports)) if (IMPORTS[k].test(text)) imports[k]++
    })
    const objc = own.some((f) => /\.(?:m|mm|h)$/.test(f) && under(root, f) !== null && OBJC_UI.test(read(f) ?? ''))
    const interfaceFiles = own.filter((f) => /\.(?:storyboard|xib)$/.test(f) && under(root, f) !== null).length
    const colorSets = own.some((f) => under(root, f) !== null && /\.xcassets\/.*\.colorset\/Contents\.json$/.test(f))
    const ui = [...(imports.swiftui > 0 ? ['swiftui'] : []), ...(imports.uikit > 0 || interfaceFiles > 0 || objc ? ['uikit'] : [])]
    // Code with no UI at all (a server, a command-line tool) is not an app massimo designs for.
    if (ui.length === 0 && imports.appkit === 0 && !colorSets) return null
    if (ui.length === 0) ui.push('swiftui')
    return { inRoot, ui }
  }
  const roots = [...new Set(markers.map((m) => m.dir))].sort((a, b) => depth(a) - depth(b) || compare(a, b))
  let root = null
  let found = null
  for (const r of roots) {
    found = look(r)
    if (found) {
      root = r
      break
    }
  }
  if (!found) return null
  const { inRoot, ui } = found
  const rank = (k) => KINDS.findIndex(([kind]) => kind === k)
  const here = markers.filter((m) => m.dir === root).sort((a, b) => rank(a.kind) - rank(b.kind) || Number(isTuistHelper(a.path)) - Number(isTuistHelper(b.path)) || compare(a.path, b.path))
  // Catalogs that hold colours, the app's own first.
  const catalogs = new Map()
  for (const f of own) {
    const at = f.indexOf('.xcassets/')
    if (at === -1 || !/\.colorset\/Contents\.json$/.test(f)) continue
    const cat = f.slice(0, at + '.xcassets'.length)
    catalogs.set(cat, (catalogs.get(cat) ?? 0) + 1)
  }
  const colorCatalogs = [...catalogs].map(([path, colors]) => ({ path, colors, app: !NOT_THE_APP.test(path) })).sort((a, b) => Number(b.app) - Number(a.app) || b.colors - a.colors || compare(a.path, b.path))
  // Of several Xcode projects in one folder, the one whose folders hold the app's catalog.
  const holder = (pbxPath, target) => {
    const info = pbxprojInfo(read(pbxPath) ?? '')
    const dir = dirOf(dirOf(pbxPath))
    return [...info.synced, ...[...info.folders.values()].flat()].some((d) => target.startsWith(`${join(dir, d)}/`))
  }
  const appCatalog = colorCatalogs.find((c) => c.app)?.path
  if (appCatalog && here[0].kind === 'xcodeproj') {
    const holding = here.find((m) => m.kind === 'xcodeproj' && holder(`${m.path}/project.pbxproj`, appCatalog))
    if (holding) here.splice(here.indexOf(holding), 1), here.unshift(holding)
  }
  const project = { kind: here[0].kind, path: here[0].path }
  const reasons = here.map((m) => `${m.path} (${m.kind})`)
  // Modules: the Swift package targets, the XcodeGen targets, the Xcode targets.
  const modules = []
  for (const pkg of own.filter((f) => /(?:^|\/)Package\.swift$/.test(f) && under(root, f) !== null)) {
    for (const t of packageTargets(read(pkg) ?? '').filter((x) => !x.test)) modules.push({ name: t.name, path: join(dirOf(pkg), t.path ?? `Sources/${t.name}`), from: 'Package.swift' })
  }
  const yml = here.find((m) => m.kind === 'xcodegen')
  if (yml) for (const t of xcodegenTargets(read(yml.path) ?? '')) modules.push({ name: t.name, path: t.path ? join(dirOf(yml.path), t.path) : null, from: 'project.yml' })
  // The project detect names, else the first under the root.
  const named = here.find((m) => m.kind === 'xcodeproj')
  const pbx = named ? `${named.path}/project.pbxproj` : own.find((f) => f.endsWith('.xcodeproj/project.pbxproj') && under(root, f) !== null)
  const pbxInfo = pbx ? pbxprojInfo(read(pbx) ?? '') : { targets: [], synced: [], folders: new Map() }
  // A target's own folder: a synced folder it lists or is named for, or a group named for it.
  for (const name of pbxInfo.targets) modules.push({ name, path: pbxInfo.folders.get(name)?.[0] ? join(dirOf(dirOf(pbx)), pbxInfo.folders.get(name)[0]) : null, from: pbx })
  const designSystem = modules.find((m) => m.path && DS_NAME.test(m.name)) ?? null
  const previews = inRoot.filter((f) => /#Preview\b|:\s*PreviewProvider\b/.test(read(f) ?? '')).length
  const manifests = [...here.map((m) => m.path), ...own.filter((f) => /(?:^|\/)(?:Package\.resolved|Podfile|Cartfile)$/.test(f) && under(root, f) !== null)]
  const text = manifests.map((f) => (f.endsWith('.xcodeproj') ? read(`${f}/project.pbxproj`) : read(f)) ?? '').join('\n')
  const snapshotTools = [
    ['swift-snapshot-testing', /swift-snapshot-testing|\bSnapshotTesting\b/],
    ['SnapshotPreviews', /SnapshotPreviews/],
    ['Prefire', /\bPrefire\b/],
    ['iOSSnapshotTestCase', /iOSSnapshotTestCase|FBSnapshotTestCase/],
  ].filter(([, re]) => re.test(text)).map(([name]) => name)
  const confidence = project.kind === 'xcworkspace' && !here.some((m) => m.kind === 'xcodeproj') ? 'medium' : 'high'
  return { id: 'ios', root, project, confidence, reasons, ui, modules, designSystem, catalogs: colorCatalogs, synced: pbxInfo.synced, previews, snapshotTools, swiftFiles: inRoot.length }
}

// The config block detect proposes for an iOS project. Globs are relative to
// the block's root. The design-system module is the components; with none
// found, components stay empty until the user names them or picks the whole
// app, and every Swift file is a consumer.
export function iosDefaults(e) {
  const rel = (p) => (e.root === '.' ? p : p.slice(e.root.length + 1))
  const ds = e.designSystem?.path ? rel(e.designSystem.path) : null
  return {
    root: e.root,
    ui: e.ui,
    project: { kind: e.project.kind, path: rel(e.project.path) },
    components: { include: ds ? [`${ds}/**/*.swift`] : [], exclude: ['**/Tests/**', '**/*Tests/**', '**/*Tests.swift'] },
    consumers: ['**/*.swift'],
  }
}

// The token sources and outputs detect suggests: the app's catalogs as
// sources, and a Swift file beside the first one (in its package target when
// it has one). With no catalog, tokens mode: an owned catalog beside the Swift file.
export function iosTokens(e, files, read) {
  const appCatalogs = e.catalogs.filter((c) => c.app)
  const sources = appCatalogs.map((c) => ({ kind: 'xcassets', path: c.path }))
  // With no catalog, the package target that looks like the tokens' home (Tokens, Theme, DesignSystem, Style, UI), else the first.
  const libraries = e.modules.filter((m) => m.path && m.from === 'Package.swift')
  const home = libraries.find((m) => /token|theme|design|style/i.test(m.name)) ?? libraries.find((m) => /ui$/i.test(m.name)) ?? libraries[0]
  const anchor = appCatalogs[0]?.path ?? e.designSystem?.path ?? home?.path ?? null
  let dir
  if (anchor) {
    const target = packageTargetOf(anchor, files, read)
    dir = target ? target.dir : anchor.endsWith('.xcassets') ? dirOf(anchor) : anchor
    // A catalog anywhere in a Resources folder sits beside the code: Tuist and XcodeGen copy Resources/ as resources, never compile it.
    const steps = dir.split('/')
    const at = steps.lastIndexOf('Resources')
    if (!target && at !== -1) {
      const parent = steps.slice(0, at).join('/') || '.'
      const sources = join(parent, 'Sources')
      dir = files.some((f) => f.startsWith(`${sources}/`) && f.endsWith('.swift')) ? sources : parent
    }
  } else {
    dir = e.root === '.' ? 'DesignTokens' : `${e.root}/DesignTokens`
  }
  const outputs = [{ format: 'swift', path: join(dir, 'DesignTokens.swift'), platform: 'ios' }]
  if (sources.length === 0) outputs.push({ format: 'xcassets', path: join(dir, 'MassimoTokens.xcassets'), platform: 'ios' })
  return { sources, outputs, colors: sources.length > 0 ? 'catalog' : 'tokens' }
}

// How a file massimo writes reaches the build: { needed, step }. A Swift
// package target, a Tuist or XcodeGen project and a folder Xcode keeps in sync
// pick up new files by themselves; a plain .xcodeproj needs the file added
// to its target once, in Xcode, since massimo never edits project.pbxproj.
export function iosWire(path, files, read, platform) {
  const target = packageTargetOf(path, files, read)
  if (target) return { needed: false, step: `${path} sits in the Swift package target ${target.name}, which picks it up by itself` }
  const kind = platform?.project?.kind
  if (kind === 'tuist' || kind === 'xcodegen') return { needed: false, step: `${path}: ${kind === 'tuist' ? 'Tuist' : 'XcodeGen'} picks up new files under a target's sources; regenerate the project (${kind === 'tuist' ? 'tuist generate' : 'xcodegen generate'})` }
  // The project that holds the output: of the projects whose folder contains
  // it, the one with a target folder around it, then the deepest, then the
  // one the platform block names; with none, the named one, else the first.
  const projects = files.filter((f) => f.endsWith('.xcodeproj/project.pbxproj'))
  const clean = (p) => p.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '') || '.'
  const named = kind === 'xcodeproj' && typeof platform?.project?.path === 'string' ? `${join(clean(platform.root ?? '.'), clean(platform.project.path))}/project.pbxproj` : null
  const around = (f) => {
    const info = pbxprojInfo(read(f) ?? '')
    const dir = dirOf(dirOf(f))
    return [...info.synced, ...[...info.folders.values()].flat()].some((d) => path.startsWith(`${join(dir, d)}/`))
  }
  const holding = projects.filter((f) => {
    const folder = dirOf(dirOf(f))
    return folder === '.' || path.startsWith(`${folder}/`)
  }).sort((a, b) => Number(around(b)) - Number(around(a)) || depth(dirOf(dirOf(b))) - depth(dirOf(dirOf(a))) || Number(b === named) - Number(a === named) || compare(a, b))
  const pbx = holding[0] ?? (named && projects.includes(named) ? named : null) ?? projects[0]
  const info = pbx ? pbxprojInfo(read(pbx) ?? '') : { targets: [], synced: [] }
  const projectDir = pbx ? dirOf(dirOf(pbx)) : '.'
  const synced = info.synced.find((dir) => {
    const full = projectDir === '.' ? dir : `${projectDir}/${dir}`
    return path.startsWith(`${full}/`)
  })
  if (synced) return { needed: false, step: `${path} sits in ${synced}, a folder Xcode keeps in sync, so it is picked up by itself` }
  // Test targets are never where a design system's code goes.
  const apps = info.targets.filter((name) => !/Tests$/.test(name))
  const targets = apps.length > 0 ? ` (${apps.join(', ')})` : ''
  return { needed: true, step: `In Xcode, add ${path} to the app's target${targets}: drag it into the project navigator, or File > Add Files, and tick the target. Once; massimo rewrites it in place from then on` }
}

export const iosColorLiterals = swiftColorLiterals
