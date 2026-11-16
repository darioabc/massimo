// detect on mobile repos: SwiftPM, a plain .xcodeproj, Tuist, XcodeGen and
// Gradle (Kotlin DSL) are each recognised with no package.json, and suggest a
// platforms block with minScripts 0.6.0; a web app's mobile shell (Capacitor,
// React Native) stays web; init on a mobile fixture writes the config with
// minScripts and an AGENTS.md platforms line; and the audit counts the
// colours the Swift and Kotlin files hard-code, read only.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { FIXTURES, SCRIPTS } from './helpers.mjs'

const made = []
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })))

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-detect-mobile-'))
  made.push(root)
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  return root
}
function fixture(name) {
  const root = join(mkdtempSync(join(tmpdir(), 'massimo-detect-mobile-')), 'repo')
  made.push(join(root, '..'))
  cpSync(join(FIXTURES, name), root, { recursive: true })
  return root
}
const script = (name, root, args = []) => spawnSync(process.execPath, [join(SCRIPTS, `${name}.mjs`), '--root', root, ...args], { encoding: 'utf8' })
const detect = (root) => {
  const r = script('detect', root)
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

const SWIFT_VIEW = 'import SwiftUI\n\nstruct Card: View {\n    var body: some View { Text("Hi") }\n}\n'
const PBXPROJ = `// !$*UTF8*$!
{
	objects = {
		A1B2 /* Acme */ = {
			isa = PBXNativeTarget;
			name = Acme;
		};
	};
}
`

test('a Swift package with no package.json is an iOS project, with its catalog as the colour source', () => {
  const d = detect(fixture('ios-spm'))
  assert.equal(d.platforms.length, 1)
  const ios = d.platforms[0]
  assert.equal(ios.id, 'ios')
  assert.deepEqual(ios.project, { kind: 'swiftpm', path: 'Package.swift' })
  assert.equal(ios.confidence, 'high')
  assert.deepEqual(ios.ui, ['swiftui'])
  assert.equal(ios.designSystem.name, 'DesignSystem')
  assert.equal(ios.previews, 1)
  assert.deepEqual(ios.colorLiterals.count, 2)
  const c = d.suggestedConfig
  assert.equal(c.minScripts, '0.6.0')
  assert.deepEqual(Object.keys(c.platforms), ['ios'])
  assert.deepEqual(c.platforms.ios.components.include, ['Sources/DesignSystem/**/*.swift'])
  assert.equal(c.tokens.mobile.colors, 'catalog')
  assert.deepEqual(c.tokens.mobileSources.map((s) => s.path), ['Sources/DesignSystem/Resources/Colors.xcassets', 'Sources/DesignSystem/Resources/Extra.xcassets'])
  assert.deepEqual(ios.suggestedOutputs, [{ format: 'swift', path: 'Sources/DesignSystem/DesignTokens.swift', platform: 'ios' }])
  // A mobile repo's config holds no web keys.
  for (const key of ['framework', 'styling', 'components', 'consumers', 'stories', 'audit']) assert.ok(!(key in c), key)
})

test('a Gradle project with Compose is an Android project, its design-system module the components and the token home', () => {
  const d = detect(fixture('android-compose'))
  const android = d.platforms[0]
  assert.equal(android.id, 'android')
  assert.deepEqual(android.ui, ['compose'])
  assert.equal(android.designSystem.path, 'core/designsystem')
  assert.deepEqual(android.snapshotTools, ['Roborazzi'])
  assert.equal(android.previews, 1)
  assert.equal(android.colorLiterals.count, 3)
  const c = d.suggestedConfig
  assert.equal(c.minScripts, '0.6.0')
  assert.deepEqual(c.platforms.android.components.include, ['core/designsystem/**/src/main/**/*.kt'])
  assert.equal(c.tokens.mobile.package, 'com.example.designsystem')
  assert.deepEqual(c.tokens.mobileSources, [{ kind: 'android-values', include: ['core/designsystem/src/main/res/values*/*.xml'] }])
  assert.deepEqual(android.suggestedOutputs.map((o) => o.path), ['core/designsystem/src/main/kotlin/com/example/designsystem/DesignTokens.kt', 'core/designsystem/src/main/res'])
})

test('Tuist, XcodeGen and a plain .xcodeproj each name their kind, a generator before the project it makes', () => {
  const tuist = detect(repo({ 'Project.swift': 'import ProjectDescription\nlet project = Project(name: "Acme", targets: [])\n', 'Acme/Card.swift': SWIFT_VIEW }))
  assert.deepEqual(tuist.platforms[0].project, { kind: 'tuist', path: 'Project.swift' })
  const xcodegen = detect(repo({ 'project.yml': 'name: Acme\ntargets:\n  Acme:\n    type: application\n    platform: iOS\n', 'Acme.xcodeproj/project.pbxproj': PBXPROJ, 'Acme/Card.swift': SWIFT_VIEW }))
  assert.deepEqual(xcodegen.platforms[0].project, { kind: 'xcodegen', path: 'project.yml' })
  assert.deepEqual(xcodegen.platforms[0].modules.map((m) => m.name), ['Acme', 'Acme'])
  const plain = detect(repo({ 'ios/Acme.xcodeproj/project.pbxproj': PBXPROJ, 'ios/Acme/Card.swift': SWIFT_VIEW }))
  assert.equal(plain.platforms[0].root, 'ios')
  assert.deepEqual(plain.platforms[0].project, { kind: 'xcodeproj', path: 'ios/Acme.xcodeproj' })
  assert.deepEqual(plain.suggestedConfig.platforms.ios.project, { kind: 'xcodeproj', path: 'Acme.xcodeproj' })
})

test('a Gradle Kotlin DSL project names its modules from the settings file', () => {
  const d = detect(repo({
    'settings.gradle.kts': 'rootProject.name = "acme"\ninclude(":app")\ninclude(":feature:home", ":core:ui")\n',
    'app/build.gradle.kts': 'plugins { id("com.android.application") }\nandroid { namespace = "com.acme" }\n',
    'core/ui/build.gradle.kts': 'plugins { id("com.android.library") }\nandroid { namespace = "com.acme.ui"\n buildFeatures { compose = true } }\n',
    'app/src/main/AndroidManifest.xml': '<manifest/>\n',
  }))
  assert.deepEqual(d.platforms[0].modules.map((m) => m.name), [':app', ':core:ui', ':feature:home'])
  assert.equal(d.platforms[0].designSystem.path, 'core/ui')
  assert.deepEqual(d.platforms[0].ui, ['compose'])
})

test('a web app\'s mobile shell stays web: Capacitor and React Native suggest no platforms', () => {
  const capacitor = detect(repo({
    'package.json': { name: 'shell', dependencies: { '@capacitor/core': '7', react: '19', vite: '7' } },
    'capacitor.config.json': { appId: 'com.acme', webDir: 'dist' },
    'src/components/Button.tsx': 'export const Button = () => null\n',
    'ios/App/App.xcodeproj/project.pbxproj': PBXPROJ,
    'ios/App/App/AppDelegate.swift': 'import UIKit\n',
    'android/settings.gradle': "include ':app'\n",
    'android/app/build.gradle': "apply plugin: 'com.android.application'\n",
  }))
  assert.equal(capacitor.framework, 'vite-react')
  assert.ok(!('platforms' in capacitor))
  assert.ok(!('platforms' in capacitor.suggestedConfig))
  assert.ok(!('minScripts' in capacitor.suggestedConfig))
  const reactNative = detect(repo({
    'package.json': { name: 'app', dependencies: { 'react-native': '0.80', react: '19' } },
    'ios/App.xcodeproj/project.pbxproj': PBXPROJ,
    'android/settings.gradle': "include ':app'\n",
    'android/app/build.gradle': "apply plugin: 'com.android.application'\n",
  }))
  assert.ok(!('platforms' in reactNative))
  const tauri = detect(repo({
    'package.json': { name: 'app', dependencies: { '@tauri-apps/api': '2', react: '19', vite: '7' }, devDependencies: { '@tauri-apps/cli': '2' } },
    'src-tauri/gen/apple/app.xcodeproj/project.pbxproj': PBXPROJ,
    'src-tauri/gen/android/settings.gradle.kts': 'include(":app")\n',
    'src-tauri/gen/android/app/build.gradle.kts': 'plugins { id("com.android.application") }\n',
  }))
  assert.ok(!('platforms' in tauri))
})

test('a web repo that also holds an iOS app lists web beside it, and keeps every web key', () => {
  const d = detect(repo({
    'package.json': { name: 'site', dependencies: { react: '19', vite: '7' } },
    'src/components/Button.tsx': 'export const Button = () => null\n',
    'apple/Package.swift': '// swift-tools-version: 5.9\nimport PackageDescription\nlet package = Package(name: "Acme", targets: [.target(name: "Acme")])\n',
    'apple/Sources/Acme/Card.swift': SWIFT_VIEW,
  }))
  assert.deepEqual(Object.keys(d.suggestedConfig.platforms), ['web', 'ios'])
  assert.equal(d.suggestedConfig.framework, 'vite-react')
  assert.ok(Array.isArray(d.suggestedConfig.components.include))
  assert.equal(d.suggestedConfig.minScripts, '0.6.0')
})

test('init on a mobile repo writes minScripts 0.6.0 and an AGENTS.md platforms line, and needs no package.json', () => {
  const root = fixture('android-compose')
  const r = script('init', root)
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout)
  const config = JSON.parse(readFileSync(join(root, 'massimo.config.json'), 'utf8'))
  assert.deepEqual(Object.keys(config).slice(0, 2), ['version', 'minScripts'])
  assert.equal(config.minScripts, '0.6.0')
  assert.ok(report.warnings.some((w) => /no package\.json, so no npm scripts were added/.test(w)))
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  assert.match(agents, /- Platforms: Android \(Jetpack Compose\)\. `node design-system\/scripts\/tokens\.mjs build` writes each platform's token outputs/)
  // The vendored check runs, and skips the web graph.
  const check = spawnSync(process.execPath, [join(root, 'design-system', 'scripts', 'check.mjs')], { cwd: root, encoding: 'utf8' })
  assert.equal(check.status, 0, check.stdout + check.stderr)
  assert.match(check.stdout, /skip {2}graph {3}the graph reads web code, and this project declares no web platform/)
})

test('the audit counts the colours Swift and Kotlin files hard-code, read only, outside tests', () => {
  const root = fixture('android-compose')
  assert.equal(script('init', root, ['--no-agents-file']).status, 0)
  const r = script('audit', root)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /3 hard-coded colours in Kotlin \(read only\)/)
  const md = readFileSync(join(root, 'design-system', 'audits', 'latest.md'), 'utf8')
  assert.match(md, /## Hard-coded colours in Swift and Kotlin\n\n3 colour literals written into the code, outside the tests and the files massimo generates\. Read only/)
  assert.match(md, /- android: 3 in 2 of 2 Kotlin files/)
  const json = JSON.parse(readFileSync(join(root, 'design-system', 'audits', 'latest.json'), 'utf8'))
  assert.equal(json.mobileColors[0].count, 3)
  // Never a baseline entry.
  assert.equal(script('audit', root, ['--baseline']).status, 0)
  const baseline = readFileSync(join(root, 'design-system', 'audits', 'baseline.json'), 'utf8')
  assert.doesNotMatch(baseline, /Home\.kt|PrimaryButton\.kt/)
})
