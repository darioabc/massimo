// Shared plumbing for the mobile edge tests: scratch repos built from a
// fixture, a config and a token set, the scripts run as child processes, and
// small builders for tokens and Xcode colour sets.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { writeTokenSet } from '../scripts/lib/dtcg.mjs'
import { FIXTURES, SCRIPTS } from './helpers.mjs'

const made = []
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })))

export function scratch() {
  const base = mkdtempSync(join(tmpdir(), 'massimo-edges-'))
  made.push(base)
  return base
}
export function put(root, files) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  return root
}
// A scratch repo: a fixture's files (or none), a config, a token set and more files.
export function repo({ fixture = null, config = {}, tokens = null, files = {}, defaultMode = 'light' } = {}) {
  const root = join(scratch(), 'repo')
  mkdirSync(root, { recursive: true })
  if (fixture) cpSync(join(FIXTURES, fixture), root, { recursive: true })
  put(root, files)
  writeConfig(root, { version: 1, minScripts: '0.6.0', projectDir: 'ds', ...config })
  if (tokens) for (const [name, text] of Object.entries(writeTokenSet({ tokens, defaultMode }))) put(root, { [join('ds', 'tokens', name)]: text })
  return root
}
export const writeConfig = (root, config) => writeFileSync(join(root, 'massimo.config.json'), JSON.stringify(config, null, 2))
export const readConfig = (root) => JSON.parse(readFileSync(join(root, 'massimo.config.json'), 'utf8'))
export const run = (name, root, args = []) => spawnSync(process.execPath, [join(SCRIPTS, `${name}.mjs`), ...args, '--root', root], { encoding: 'utf8' })
export const tokensRun = (root, args) => run('tokens', root, args)
export const read = (root, path) => readFileSync(join(root, path), 'utf8')
export const detect = (root) => {
  const r = run('detect', root)
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

export const srgb = (hex) => ({ colorSpace: 'srgb', components: [1, 3, 5].map((i) => Number((Number.parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4))), hex: hex.slice(0, 7), ...(hex.length > 7 ? { alpha: Number((Number.parseInt(hex.slice(7, 9), 16) / 255).toFixed(4)) } : {}) })
export const px = (value, unit = 'px') => ({ value, unit })
export const tok = (path, type, value, extra = {}) => ({ path, name: path.join('.'), type, value, modes: {}, description: '', cssVar: `--${path.join('-')}`, on: null, use: null, contrast: 4.5, collection: null, extensions: {}, deprecated: null, css: null, cssModes: {}, strict: true, ...extra })
export const tokensMode = (outputs, extra = {}) => ({ platforms: { ios: {}, android: {} }, tokens: { source: 'ds/tokens/tokens.resolver.json', outputs, mobile: { colors: 'tokens', ...extra } } })
export const SWIFT_OUT = { format: 'swift', path: 'ios/App/DesignTokens.swift' }
export const XCASSETS_OUT = { format: 'xcassets', path: 'ios/App/MassimoTokens.xcassets' }
export const COMPOSE_OUT = { format: 'compose', path: 'android/core/src/main/kotlin/com/example/tokens/DesignTokens.kt' }
export const XML_OUT = { format: 'android-xml', path: 'android/core/src/main/res' }

// ── The ios-spm fixture, extracted and taken as the token set ─────────────

export const CATALOG = 'Sources/DesignSystem/Resources/Colors.xcassets'
export const EXTRA = 'Sources/DesignSystem/Resources/Extra.xcassets'
export const OWNED = 'Sources/DesignSystem/Resources/MassimoTokens.xcassets'
export const entry = (hex, { appearance = null, gamut = null, idiom = 'universal' } = {}) => ({
  ...(appearance ? { appearances: [{ appearance: 'luminosity', value: appearance }] } : {}),
  color: { 'color-space': gamut === 'display-P3' ? 'display-p3' : 'srgb', components: { alpha: '1.000', blue: `0x${hex.slice(5, 7)}`, green: `0x${hex.slice(3, 5)}`, red: `0x${hex.slice(1, 3)}` } },
  ...(gamut ? { 'display-gamut': gamut } : {}),
  idiom,
})
export const colorset = (colors) => ({ colors, info: { author: 'xcode', version: 1 } })

export function extracted({ outputs, colors, files = {}, sources = [{ kind: 'xcassets', path: 'Sources/DesignSystem/Resources/*.xcassets' }] }) {
  const root = repo({ fixture: 'ios-spm', files, config: { platforms: { ios: {} }, tokens: { source: 'ds/tokens/tokens.resolver.json', outputs: [], mobile: { colors }, mobileSources: sources } } })
  const r = tokensRun(root, ['extract'])
  assert.equal(r.status, 0, r.stderr)
  cpSync(join(root, 'ds/tokens/draft'), join(root, 'ds/tokens'), { recursive: true })
  const config = readConfig(root)
  config.tokens.outputs = outputs
  writeConfig(root, config)
  return { root, extract: r }
}
