// The iOS platform adapter: how massimo recognises an Xcode, SwiftPM, Tuist
// or XcodeGen project, the config block it proposes, where the app keeps its
// colours, where token outputs go and how they are wired in, and the Swift
// reader's colour count. Everything is read as text; massimo never edits a
// .xcodeproj, Package.swift, Project.swift or project.yml.

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
  ['tuist', (f) => /(?:^|\/)(?:Project\.swift|Tuist\.swift|tuist\.toml|Tuist\/Config\.swift)$/.test(f)],
  ['xcodegen', (f) => /(?:^|\/)project\.ya?ml$/.test(f)],
  ['swiftpm', (f) => /(?:^|\/)Package\.swift$/.test(f) && !/(?:^|\/)Tuist\/Package\.swift$/.test(f)],
  ['xcworkspace', (f) => /\.xcworkspace\/contents\.xcworkspacedata$/.test(f) && !/\.xcodeproj\/project\.xcworkspace\//.test(f)],
  ['xcodeproj', (f) => /\.xcodeproj\/project\.pbxproj$/.test(f)],
]
const projectPath = (kind, f) => (kind === 'xcworkspace' || kind === 'xcodeproj' ? f.replace(/\/[^/]+$/, '') : f)

// Targets a Package.swift declares, read as text: [{ name, path, test }].
export function packageTargets(text) {
  const out = []
  for (const m of text.matchAll(/\.(target|testTarget|executableTarget|macro|plugin)\s*\(\s*name\s*:\s*"([^"]+)"/g)) {
    const rest = text.slice(m.index, m.index + 4000)
    // The path belongs to this target when it comes before the next one starts.
    const nextTarget = rest.slice(1).search(/\.(?:target|testTarget|executableTarget|macro|plugin|binaryTarget)\s*\(/)
    const own = nextTarget === -1 ? rest : rest.slice(0, nextTarget + 1)
    const path = /\bpath\s*:\s*"([^"]+)"/.exec(own)?.[1] ?? null
    out.push({ name: m[2], path, test: m[1] === 'testTarget' })
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

// Targets an XcodeGen project.yml declares: the keys indented one step under `targets:`.
function xcodegenTargets(text) {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((l) => /^targets\s*:/.test(l))
  if (at === -1) return []
  const out = []
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line)) break
    const m = /^ {2}([A-Za-z0-9_.-]+)\s*:/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

// The targets a project.pbxproj declares, and its folders Xcode keeps
// in sync with the disk (Xcode 16), which pick up new files by themselves.
export function pbxprojInfo(text) {
  const targets = [...text.matchAll(/\/\* ([^*]+?) \*\/ = \{\s*isa = PBXNativeTarget;/g)].map((m) => m[1])
  const synced = [...text.matchAll(/isa = PBXFileSystemSynchronizedRootGroup;[\s\S]*?path = ("?)([^";\n]+)\1;/g)].map((m) => m[2])
  return { targets: [...new Set(targets)], synced: [...new Set(synced)] }
}

const DS_NAME = /^(?:design[-_ ]?system|ui|components|.*designsystem)$/i

// A project.yml is an XcodeGen spec when it declares targets for an Apple
// platform; the name alone is common (a deploy or CI file).
const isXcodegenSpec = (text) => /^targets\s*:/m.test(text) && /^\s*(?:platform\s*:\s*\[?\s*["']?(?:iOS|macOS|tvOS|watchOS|visionOS|auto)\b|deploymentTarget\s*:)/m.test(text)

// What detect reports for an iOS project, or null when there is none.
// `files` are repo-relative paths with ignored folders already left out.
export function detectIos(files, read) {
  const own = files.filter((f) => !f.split('/').some((seg) => IOS_IGNORE.includes(seg)))
  const markers = []
  for (const f of own) {
    const kind = KINDS.find(([, test]) => test(f))?.[0]
    if (kind === 'xcodegen' && !isXcodegenSpec(read(f) ?? '')) continue
    if (kind) markers.push({ kind, path: projectPath(kind, f), dir: dirOf(projectPath(kind, f)) })
  }
  const swift = own.filter((f) => f.endsWith('.swift') && !/(?:^|\/)(?:Package|Project)\.swift$/.test(f))
  if (markers.length === 0) return null
  const shallowest = Math.min(...markers.map((m) => depth(m.dir)))
  const top = markers.filter((m) => depth(m.dir) === shallowest)
  const root = [...new Set(top.map((m) => m.dir))].sort(compare)[0]
  const rank = (k) => KINDS.findIndex(([kind]) => kind === k)
  const here = markers.filter((m) => m.dir === root).sort((a, b) => rank(a.kind) - rank(b.kind) || compare(a.path, b.path))
  const project = { kind: here[0].kind, path: here[0].path }
  const reasons = here.map((m) => `${m.path} (${m.kind})`)
  const inRoot = swift.filter((f) => under(root, f) !== null)
  const imports = { swiftui: 0, uikit: 0 }
  for (const f of inRoot.slice(0, 600)) {
    const text = read(f) ?? ''
    if (/^\s*import\s+SwiftUI\b/m.test(text)) imports.swiftui++
    if (/^\s*import\s+UIKit\b/m.test(text)) imports.uikit++
  }
  const interfaceFiles = own.filter((f) => /\.(?:storyboard|xib)$/.test(f) && under(root, f) !== null).length
  const ui = [...(imports.swiftui > 0 ? ['swiftui'] : []), ...(imports.uikit > 0 || interfaceFiles > 0 ? ['uikit'] : [])]
  // Swift with no UI at all (a server, a command-line tool) is not an app massimo designs for.
  const colorSets = own.some((f) => under(root, f) !== null && /\.xcassets\/.*\.colorset\/Contents\.json$/.test(f))
  if (inRoot.length === 0 || (ui.length === 0 && !colorSets)) return null
  if (ui.length === 0) ui.push('swiftui')
  // Modules: the Swift package targets, the XcodeGen targets, the Xcode targets.
  const modules = []
  for (const pkg of own.filter((f) => /(?:^|\/)Package\.swift$/.test(f) && under(root, f) !== null)) {
    for (const t of packageTargets(read(pkg) ?? '').filter((x) => !x.test)) modules.push({ name: t.name, path: join(dirOf(pkg), t.path ?? `Sources/${t.name}`), from: 'Package.swift' })
  }
  const yml = here.find((m) => m.kind === 'xcodegen')
  if (yml) for (const name of xcodegenTargets(read(yml.path) ?? '')) modules.push({ name, path: null, from: 'project.yml' })
  const pbx = own.find((f) => f.endsWith('.xcodeproj/project.pbxproj') && under(root, f) !== null)
  const pbxInfo = pbx ? pbxprojInfo(read(pbx) ?? '') : { targets: [], synced: [] }
  for (const name of pbxInfo.targets) modules.push({ name, path: null, from: pbx })
  const designSystem = modules.find((m) => m.path && DS_NAME.test(m.name)) ?? null
  // Catalogs that hold colours, the app's own first.
  const catalogs = new Map()
  for (const f of own) {
    const at = f.indexOf('.xcassets/')
    if (at === -1 || !/\.colorset\/Contents\.json$/.test(f)) continue
    const cat = f.slice(0, at + '.xcassets'.length)
    catalogs.set(cat, (catalogs.get(cat) ?? 0) + 1)
  }
  const colorCatalogs = [...catalogs].map(([path, colors]) => ({ path, colors, app: !NOT_THE_APP.test(path) })).sort((a, b) => Number(b.app) - Number(a.app) || b.colors - a.colors || compare(a.path, b.path))
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
  } else {
    dir = e.root === '.' ? 'DesignTokens' : `${e.root}/DesignTokens`
  }
  const outputs = [{ format: 'swift', path: `${dir}/DesignTokens.swift`, platform: 'ios' }]
  if (sources.length === 0) outputs.push({ format: 'xcassets', path: `${dir}/MassimoTokens.xcassets`, platform: 'ios' })
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
  // The project that holds the output: the one the platform block names,
  // else the deepest whose folder contains it, else the first there is.
  const projects = files.filter((f) => f.endsWith('.xcodeproj/project.pbxproj'))
  const named = kind === 'xcodeproj' && typeof platform?.project?.path === 'string' ? `${join(platform.root ?? '.', platform.project.path.replace(/\/+$/, ''))}/project.pbxproj` : null
  const holding = projects.filter((f) => {
    const folder = dirOf(dirOf(f))
    return folder === '.' || path.startsWith(`${folder}/`)
  }).sort((a, b) => depth(dirOf(dirOf(b))) - depth(dirOf(dirOf(a))))
  const pbx = (named && projects.includes(named) ? named : null) ?? holding[0] ?? projects[0]
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
