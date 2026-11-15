// The platform registry: web, iOS and Android, each a plain object of what
// massimo does on it. A project declares its platforms in massimo.config.json
// (`platforms`, a map from id to block); a config without that key is web
// only and reads its top-level keys, exactly as before platforms existed.
//
// Language readers (lang-swift.mjs, lang-kotlin.mjs, readers-mobile.mjs) stay
// separate from the adapters, so SwiftUI and UIKit share the Swift reader and
// Compose and Android views share the Kotlin one.
//
// In 0.6.0 the iOS and Android adapters fill detect, defaults, tokens and a
// read-only colour count. The graph, the audit's ratchet, previews and
// renders come in later releases, and their slots are null until then.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compare, expandGlobs } from './glob.mjs'
import { IOS_IGNORE, detectIos, iosColorLiterals, iosDefaults, iosTokens, iosWire } from './platform-ios.mjs'
import { ANDROID_IGNORE, androidColorLiterals, androidDefaults, androidTokens, androidWire, detectAndroid } from './platform-android.mjs'
import { web } from './platform-web.mjs'
import { hasMassimoHeader } from './mobile-tokens.mjs'

const ios = {
  id: 'ios',
  detect: detectIos,
  defaults: iosDefaults,
  ignore: IOS_IGNORE,
  isTest: (f) => /(?:^|\/)[^/]*Tests?\/|Tests?\.swift$/.test(f),
  isStory: (f) => /Previews?\.swift$/.test(f),
  graph: null,
  audit: { extensions: ['.swift'], colorLiterals: iosColorLiterals },
  tokens: { formats: ['swift', 'xcassets'], suggest: iosTokens, wire: iosWire },
  renderer: null,
}

const android = {
  id: 'android',
  detect: detectAndroid,
  defaults: androidDefaults,
  ignore: ANDROID_IGNORE,
  isTest: (f) => /\/src\/(?:test|androidTest|testFixtures)\//.test(f),
  isStory: (f) => /Previews?\.kt$/.test(f),
  graph: null,
  audit: { extensions: ['.kt'], colorLiterals: androidColorLiterals },
  tokens: { formats: ['compose', 'android-xml'], suggest: androidTokens, wire: androidWire },
  renderer: null,
}

const ADAPTERS = { web, ios, android }

export const PLATFORM_IDS = Object.keys(ADAPTERS)

export function adapterFor(id) {
  return ADAPTERS[id] ?? null
}

// The platforms a loaded config declares, as [{ id, ...block }] in the order
// web, ios, android; [{ id: 'web' }] for a config with no `platforms` key.
export function platformsOf(config) {
  if (!config?.platforms || typeof config.platforms !== 'object') return [{ id: 'web' }]
  return Object.entries(config.platforms)
    .map(([id, block]) => ({ ...(block && typeof block === 'object' ? block : {}), id }))
    .sort((a, b) => (PLATFORM_IDS.indexOf(a.id) === -1 ? 99 : PLATFORM_IDS.indexOf(a.id)) - (PLATFORM_IDS.indexOf(b.id) === -1 ? 99 : PLATFORM_IDS.indexOf(b.id)) || compare(a.id, b.id))
}

// Whether the web subsystems run: a config with no platforms, or one that lists web.
export const hasWeb = (config) => platformsOf(config).some((p) => p.id === 'web')

// A platform block's globs, relative to its root, as repo-relative globs.
export const rooted = (block, globs) => [].concat(globs ?? []).map((g) => (!block.root || block.root === '.' ? g : `${block.root.replace(/\/+$/, '')}/${g}`))

// The colour literals hard-coded in each mobile platform's Swift or Kotlin
// files: [{ id, language, files, count, top: [{ file, count, lines }] }].
// Read only: no baseline, no ratchet. The platform's components and
// consumers are read, its tests and the files massimo generates are not.
export function colorLiteralCounts(root, config, { list = null } = {}) {
  const out = []
  for (const p of platformsOf(config)) {
    const adapter = adapterFor(p.id)
    if (!adapter?.audit?.colorLiterals) continue
    const include = rooted(p, [...(p.components?.include ?? []), ...(p.consumers ?? [])])
    const exclude = rooted(p, p.components?.exclude ?? [])
    const ext = adapter.audit.extensions
    const files = expandGlobs(root, include, exclude, [...(config.ignore ?? []), ...(p.ignore ?? [])], list).filter((f) => ext.some((x) => f.endsWith(x)) && !adapter.isTest(f))
    const per = []
    let count = 0
    for (const file of [...new Set(files)]) {
      let text = ''
      try {
        text = readFileSync(join(root, file), 'utf8')
      } catch {
        continue
      }
      if (hasMassimoHeader(text)) continue
      const found = adapter.audit.colorLiterals(text)
      if (found.length === 0) continue
      count += found.length
      per.push({ file, count: found.length, lines: found.map((f) => f.line) })
    }
    per.sort((a, b) => b.count - a.count || compare(a.file, b.file))
    out.push({ id: p.id, language: p.id === 'ios' ? 'Swift' : 'Kotlin', files: per.length, scanned: files.length, count, top: per })
  }
  return out
}
