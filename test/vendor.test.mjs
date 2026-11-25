// The vendored copy works on its own: init copies scripts/*.mjs and
// scripts/lib/*.mjs only (no folders), so every module 0.6.0 added must be a
// flat file there. A scratch project's vendored scripts import every lib, and
// its vendored tokens.mjs and check.mjs build and check mobile outputs with
// no plugin in reach.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { writeTokenSet } from '../scripts/lib/dtcg.mjs'
import { FIXTURES, SCRIPTS } from './helpers.mjs'

const made = []
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })))

test('every module is a flat file in scripts/ or scripts/lib/, which is all init copies', () => {
  for (const dir of [SCRIPTS, join(SCRIPTS, 'lib')]) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) assert.equal(join(dir, e.name), join(SCRIPTS, 'lib'), `${e.name} is a folder init would not copy`)
    }
  }
})

test('a vendored copy imports every lib, and its tokens.mjs and check.mjs build and check mobile outputs on their own', () => {
  const base = mkdtempSync(join(tmpdir(), 'massimo-vendor-'))
  made.push(base)
  const root = join(base, 'repo')
  cpSync(join(FIXTURES, 'android-compose'), root, { recursive: true })
  const init = spawnSync(process.execPath, [join(SCRIPTS, 'init.mjs'), '--root', root, '--no-agents-file'], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const vendored = join(root, 'design-system', 'scripts')
  // Import each lib from the vendored folder, in a process that cannot see the plugin.
  const libs = readdirSync(join(vendored, 'lib')).filter((n) => n.endsWith('.mjs')).sort()
  assert.ok(['platforms.mjs', 'platform-web.mjs', 'platform-ios.mjs', 'platform-android.mjs', 'readers-mobile.mjs', 'mobile-names.mjs', 'mobile-units.mjs', 'build-swift.mjs', 'build-xcassets.mjs', 'build-compose.mjs', 'build-android-xml.mjs'].every((n) => libs.includes(n)))
  const code = libs.map((n) => `await import(${JSON.stringify(join(vendored, 'lib', n))})`).join('\n')
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: base, encoding: 'utf8' })
  assert.equal(imported.status, 0, imported.stderr)
  // A token set and every mobile output, built and checked by the vendored copy.
  const tokens = [
    { path: ['color', 'brand'], name: 'color.brand', type: 'color', value: { colorSpace: 'srgb', components: [0.3843, 0, 0.9333], hex: '#6200ee' }, modes: { dark: { colorSpace: 'srgb', components: [0.7333, 0.5255, 0.9882], hex: '#bb86fc' } }, description: '', cssVar: '--color-brand', on: null, use: null, contrast: 4.5, collection: null, extensions: {}, deprecated: null, css: null, cssModes: {}, strict: true },
    { path: ['spacing', 'md'], name: 'spacing.md', type: 'dimension', value: { value: 16, unit: 'px' }, modes: {}, description: '', cssVar: '--spacing-md', on: null, use: null, contrast: 4.5, collection: null, extensions: {}, deprecated: null, css: null, cssModes: {}, strict: true },
  ]
  for (const [name, text] of Object.entries(writeTokenSet({ tokens }))) {
    mkdirSync(join(root, 'design-system', 'tokens', name, '..'), { recursive: true })
    writeFileSync(join(root, 'design-system', 'tokens', name), text)
  }
  const config = { version: 1, minScripts: '0.6.0', projectDir: 'design-system', platforms: { android: {}, ios: {} }, tokens: { outputs: [
    { format: 'compose', path: 'core/designsystem/src/main/kotlin/com/example/designsystem/DesignTokens.kt' },
    { format: 'android-xml', path: 'core/designsystem/src/main/res' },
    { format: 'swift', path: 'ios/DesignTokens.swift' },
    { format: 'xcassets', path: 'ios/MassimoTokens.xcassets' },
  ], mobile: { colors: 'tokens' } } }
  writeFileSync(join(root, 'massimo.config.json'), JSON.stringify(config))
  const build = spawnSync(process.execPath, [join(vendored, 'tokens.mjs'), 'build'], { cwd: root, encoding: 'utf8' })
  assert.equal(build.status, 0, build.stderr)
  const check = spawnSync(process.execPath, [join(vendored, 'check.mjs')], { cwd: root, encoding: 'utf8' })
  assert.equal(check.status, 0, check.stdout + check.stderr)
  assert.match(check.stdout, /pass {2}tokens {2}node design-system\/scripts\/tokens\.mjs check/)
})
