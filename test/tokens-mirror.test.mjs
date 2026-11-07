// tokens.mjs mirror: with tokens.mirror on, the style files stay the source
// and the token set is their checked mirror. Every selector's declarations
// rebuild from it as the CSS has them: themes from the config's selectors,
// everything under another selector in its scopes, nothing misread.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { readTokenSource } from '../scripts/lib/dtcg.mjs'
import { golden, read, readJson, run, scratch } from './helpers.mjs'

const contexts = []
after(() => contexts.forEach((c) => c.cleanup()))
const fresh = (fixture = 'sheets') => {
  const ctx = scratch(fixture)
  contexts.push(ctx)
  return ctx
}
const tokensDir = (ctx) => join(ctx.root, 'design-system', 'tokens')
const configOf = (ctx) => readJson(ctx.root, 'massimo.config.json')
const setConfig = (ctx, tokens) => {
  const config = configOf(ctx)
  writeFileSync(join(ctx.root, 'massimo.config.json'), JSON.stringify({ ...config, tokens: { ...config.tokens, ...tokens } }))
}
const sorted = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

// What each fixture's theme.css declares, by selector (each member of a list
// on its own, after its at-rules), written out by hand so the test does not
// lean on the parser the mirror uses. Values are as the mirror keeps them:
// `!important` dropped.
const LIGHT = { '--c-ground': 'rgb(var(--sand-200))', '--c-surface': 'rgb(var(--sand-50))', '--c-text': 'rgb(var(--ink-900))', '--c-text-muted': 'rgb(var(--ink-900) / 0.62)', '--c-line': 'rgb(var(--ink-900) / 0.14)', '--c-accent': 'rgb(var(--accent-600))', '--c-scrim': 'rgb(var(--ink-950) / 0.5)' }
const DARK = { '--c-ground': 'rgb(var(--ink-950))', '--c-surface': 'rgb(var(--ink-900))', '--c-text': 'rgb(var(--cream-50))', '--c-text-muted': 'rgb(var(--cream-50) / 0.62)', '--c-line': 'rgb(var(--cream-50) / 0.16)', '--c-accent': 'rgb(var(--accent-300))', '--c-scrim': 'rgb(var(--ink-950) / 0.5)' }
const COMPOSITES = { '--lift': '0 4px 0 var(--c-text)', '--focus-ring': '2px solid var(--c-focus)', '--c-hairline': 'color-mix(in srgb, var(--c-text) 24%, transparent)' }
const SHEETS = {
  ':root': {
    '--sand-200': '236 229 209', '--sand-50': '255 253 248', '--ink-900': '29 31 32', '--ink-950': '22 23 24', '--cream-50': '242 240 235', '--accent-600': '200 78 34', '--accent-300': '236 143 98',
    '--font-body': '"Geist", system-ui, sans-serif', '--weight-semibold': '600', '--h2-size': 'clamp(2rem, 1.5rem + 2vw, 2.5rem)', '--h2-leading': '1.2', '--h2-weight': 'var(--weight-semibold)', '--h2-tracking': '-0.02em',
    '--space-4': '1rem', '--space-10': '2.5rem', '--space-16': '4rem', '--radius-2': '0.5rem', '--dur-2': '240ms', '--ease-out': 'cubic-bezier(0.22, 0.61, 0.36, 1)', '--z-bar': '50',
    '--section-gap': 'calc(var(--space-16) + var(--space-4))', ...LIGHT, '--c-focus': 'rgb(var(--accent-600))', ...COMPOSITES,
  },
  '@media (max-width: 60rem) :root': { '--section-gap': 'calc(var(--space-10) + var(--space-4))' },
  '.band-light': { ...LIGHT, ...COMPOSITES },
  'html.dark': { ...DARK, '--c-focus': 'rgb(var(--accent-300))' },
  '.band-dark': { ...DARK, '--c-mark': 'var(--c-focus)', ...COMPOSITES },
  '.band-block': { '--c-ground': 'var(--c-accent)', '--c-text': 'rgb(var(--sand-200))', '--c-art': 'rgb(var(--ink-900))', ...COMPOSITES },
  'html.dark .band-block': { '--c-ground': 'var(--c-accent)', '--c-text': 'rgb(var(--ink-950))', '--c-art': 'rgb(var(--cream-50))' },
  '.dark': { '--c-text': '#ffffff' },
}
const MODES = {
  ':root': { '--ink': '29 31 32', '--paper': '#fffdf8', '--text': 'rgb(var(--ink))', '--mark': 'light-dark(#c84e22, #ec8f62)', '--edge': '#d8ccac' },
  '.dark': { '--ink': '242 240 235', '--paper': '#161718', '--edge': '#3a3b3c' },
  '@media (prefers-color-scheme: dark) :root': { '--ink': '242 240 235', '--paper': '#101112', '--edge': '#3a3b3c' },
  "[data-theme='brand']": { '--paper': '#fff4e8' },
  '.band': { '--band-text': 'rgb(var(--ink) / 0.8)' },
  '@media (prefers-color-scheme: dark) .band': { '--band-text': 'rgb(var(--ink) / 0.9)' },
  '@media (max-width: 40rem) .dark': { '--text': 'rgb(var(--ink) / 0.5)' },
}

const uncommented = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

// Every selector and property pair a flat stylesheet declares, counted with
// regular expressions, and every property name: the hand-written maps above
// must hold exactly these.
function census(css) {
  let pairs = 0
  for (const [, selectors, body] of uncommented(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) pairs += selectors.split(',').length * (body.match(/--[\w-]+\s*:/g) ?? []).length
  return { pairs, names: [...new Set([...uncommented(css).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))].sort() }
}
const pairsOf = (map) => Object.values(map).reduce((n, decls) => n + Object.keys(decls).length, 0)
const namesOf = (map) => [...new Set(Object.values(map).flatMap((decls) => Object.keys(decls)))].sort()

// A plain reader for the flat CSS the build writes: rules one level deep or
// inside one @media, each member of a selector list on its own.
function declared(css) {
  const out = new Map()
  const take = (text, prefix) => {
    for (const [, selectors, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const member of selectors.split(',').map((s) => s.trim().replace(/\s+/g, ' '))) {
        const key = prefix ? `${prefix} ${member}` : member
        for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(key, { ...out.get(key), [name]: value.trim() })
      }
    }
  }
  const rest = uncommented(css).replace(/@media([^{]+)\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g, (_, query, body) => {
    take(body, `@media ${query.trim()}`)
    return ''
  })
  take(rest, '')
  return out
}

// Rebuild every selector of the source from the mirror and compare it with
// `expected`. A theme (`themes` maps its source selector to the one the build
// writes) is the build's root block, then its own block, then the mirror's
// scopes for that selector; any other selector is the mirror's scopes alone.
// The build writes nothing but the themes.
function assertRebuilds(ctx, expected, themes) {
  const built = declared(read(ctx.root, 'src', 'styles', 'built.css'))
  const scopes = new Map()
  const put = (key, name, value) => scopes.set(key, { ...scopes.get(key), [name]: value })
  const set = readTokenSource(ctx.root, { tokens: { source: 'design-system/tokens/tokens.resolver.json' } })
  for (const t of set.tokens) for (const [key, value] of Object.entries(t.scopes ?? {})) put(key, t.cssVar, value)
  const scoped = readJson(tokensDir(ctx), 'base.tokens.json').$extensions.massimo.mirror.scoped ?? {}
  for (const [name, entry] of Object.entries(scoped)) for (const [key, value] of Object.entries(entry.scopes)) put(key, name, value)

  assert.deepEqual([...built.keys()].sort(), Object.values(themes).sort())
  for (const [key, writtenAs] of Object.entries(themes)) {
    const got = { ...built.get(':root'), ...built.get(writtenAs), ...scopes.get(key) }
    assert.deepEqual(sorted(got), sorted({ ...expected[':root'], ...expected[key] }), key)
  }
  const others = Object.keys(expected).filter((k) => !(k in themes)).sort()
  assert.deepEqual([...scopes.keys()].filter((k) => !(k in themes)).sort(), others)
  for (const key of others) assert.deepEqual(sorted(scopes.get(key)), sorted(expected[key]), key)
}

test('the hand-written maps hold every declaration of their fixture', () => {
  for (const [fixture, map] of [['sheets', SHEETS], ['sheets-modes', MODES]]) {
    const { pairs, names } = census(readFileSync(join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'fixtures', fixture, 'src', 'styles', 'theme.css'), 'utf8'))
    assert.equal(pairsOf(map), pairs, fixture)
    assert.deepEqual(namesOf(map), names, fixture)
  }
})

test('golden: every selector rebuilds from the mirror as the CSS declares it', () => {
  const ctx = fresh()
  const r = run('tokens', ctx, ['mirror'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^massimo tokens mirror: 32 tokens from src\/styles\/theme\.css, 11 with values in scopes, 2 set only in themes or scopes; wrote /)
  for (const f of ['tokens.resolver.json', 'base.tokens.json', 'theme/dark.tokens.json']) {
    assert.equal(read(tokensDir(ctx), f), golden(`mirror/${f}`, read(tokensDir(ctx), f)) ?? read(tokensDir(ctx), f), f)
  }
  const build = run('tokens', ctx, ['build'])
  assert.equal(build.status, 0, build.stderr)
  assertRebuilds(ctx, SHEETS, { ':root': ':root', 'html.dark': 'html.dark' })
  // A mirror project's outputs say to change the style files, not the tokens.
  assert.ok(read(ctx.root, 'src', 'styles', 'built.css').startsWith('/* Generated by massimo tokens from design-system/tokens/tokens.resolver.json, the mirror of the style files. Do not edit by hand: change the style files, then run node ../project/scripts/tokens.mjs mirror, then node ../project/scripts/tokens.mjs build */\n'))
})

test('golden, with dark from a class and the system setting and a named theme: every selector rebuilds', () => {
  const ctx = fresh('sheets-modes')
  const r = run('tokens', ctx, ['mirror'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^massimo tokens mirror: 5 tokens from src\/styles\/theme\.css, 2 with values in scopes, 1 set only in themes or scopes; wrote /)
  for (const f of ['tokens.resolver.json', 'base.tokens.json', 'theme/dark.tokens.json', 'theme/brand.tokens.json']) {
    assert.equal(read(tokensDir(ctx), f), golden(`mirror-modes/${f}`, read(tokensDir(ctx), f)) ?? read(tokensDir(ctx), f), f)
  }
  assert.equal(run('tokens', ctx, ['build']).status, 0)
  // The dark class and the system's dark setting are one theme, which the
  // build writes under both; the brand theme is written with the config's quotes.
  assertRebuilds(ctx, MODES, {
    ':root': ':root',
    '.dark': '.dark',
    '@media (prefers-color-scheme: dark) :root': '@media (prefers-color-scheme: dark) :root:not(.light)',
    "[data-theme='brand']": '[data-theme="brand"]',
  })
})

test('two selectors in one theme with different values: the first is the theme, the other a scope, with a note', () => {
  const ctx = fresh('sheets-modes')
  const r = run('tokens', ctx, ['mirror'])
  assert.match(r.stderr, /note: --paper is #161718 under \.dark and #101112 under @media \(prefers-color-scheme: dark\) :root, which the config places in the same dark theme; the theme keeps the first, and @media \(prefers-color-scheme: dark\) :root keeps its own as a scope/)
  // Equal values under both say nothing.
  assert.doesNotMatch(r.stderr, /--ink is|--edge is/)
  const base = readJson(tokensDir(ctx), 'base.tokens.json')
  const dark = readJson(tokensDir(ctx), 'theme', 'dark.tokens.json')
  assert.equal(dark.color.paper.$value.hex, '#161718')
  assert.deepEqual(base.color.paper.$extensions.massimo.scopes, { '@media (prefers-color-scheme: dark) :root': '#101112' })
})

test('a theme is matched whatever its quotes, and light-dark() stays one declaration', () => {
  const ctx = fresh('sheets-modes')
  const r = run('tokens', ctx, ['mirror'])
  assert.doesNotMatch(r.stderr, /looks like the brand theme/)
  assert.equal(readJson(tokensDir(ctx), 'theme', 'brand.tokens.json').color.paper.$value.hex, '#fff4e8')
  const base = readJson(tokensDir(ctx), 'base.tokens.json')
  assert.equal(base.color.mark.$extensions.massimo.css, 'light-dark(#c84e22, #ec8f62)')
  assert.equal(readJson(tokensDir(ctx), 'theme', 'dark.tokens.json').color.mark, undefined)
  assert.equal(run('tokens', ctx, ['build']).status, 0)
  const built = declared(read(ctx.root, 'src', 'styles', 'built.css'))
  assert.equal(built.get(':root')['--mark'], 'light-dark(#c84e22, #ec8f62)')
  assert.equal(built.get('.dark')['--mark'], undefined)
})

test('no theme is misread: a scope inside dark, a phone-width override and a stray .dark stay scopes', () => {
  const ctx = fresh()
  const r = run('tokens', ctx, ['mirror'])
  assert.equal(r.status, 0, r.stderr)
  const base = readJson(tokensDir(ctx), 'base.tokens.json')
  const dark = readJson(tokensDir(ctx), 'theme', 'dark.tokens.json')
  assert.equal(dark.color.text.$extensions.massimo.css, 'rgb(var(--cream-50))')
  assert.equal(base.color.text.$extensions.massimo.scopes['html.dark .band-block'], 'rgb(var(--ink-950))')
  assert.equal(base.color.text.$extensions.massimo.scopes['.dark'], '#ffffff')
  const gap = base.$extensions.massimo.cssOnly['other.section-gap']
  assert.equal(gap.css, 'calc(var(--space-16) + var(--space-4))')
  assert.deepEqual(gap.scopes, { '@media (max-width: 60rem) :root': 'calc(var(--space-10) + var(--space-4))' })
  assert.deepEqual(base.$extensions.massimo.mirror, {
    from: ['src/styles/theme.css'],
    scoped: {
      '--c-art': { scopes: { '.band-block': 'rgb(var(--ink-900))', 'html.dark .band-block': 'rgb(var(--cream-50))' } },
      // The comment above `.band-dark {` is the rule's, not the declaration's.
      '--c-mark': { scopes: { '.band-dark': 'var(--c-focus)' } },
    },
  })
  assert.match(r.stderr, /note: \.dark looks like the dark theme, but tokens\.darkSelector and tokens\.selectors do not name it, so its values are kept as a scope/)
  assert.match(r.stderr, /note: --c-focus under html\.dark is !important, which a token cannot hold/)
})

test('a comment on the root declaration is its description; a section heading or a theme comment is not; names stay the CSS names', () => {
  const ctx = fresh()
  assert.equal(run('tokens', ctx, ['mirror']).status, 0)
  const base = readJson(tokensDir(ctx), 'base.tokens.json')
  // The palette's heading opens the block; the declaration's own comment wins.
  assert.equal(base.color['sand-200'].$description, '#ece5d1 the ground')
  assert.equal(base.color['sand-50'].$description, '#fffdf8 a sheet')
  assert.equal(base.color.scrim.$description, 'The page dimmed under a dialog, the same in both themes.')
  assert.equal(base.color['ink-950'].$description, undefined)
  assert.equal(base.color.ground.$extensions.massimo.cssVar, '--c-ground')
  assert.equal(base.font.body.$extensions.massimo.css, '"Geist", system-ui, sans-serif')

  const modes = fresh('sheets-modes')
  assert.equal(run('tokens', modes, ['mirror']).status, 0)
  const color = readJson(tokensDir(modes), 'base.tokens.json').color
  // A heading drawn with a rule, over a declaration with no comment of its own.
  assert.equal(color.ink.$description, undefined)
  // A comment on the dark value only describes that value.
  assert.equal(color.edge.$description, undefined)
  assert.equal(color.paper.$description, 'a sheet')
  assert.equal(color.mark.$description, 'the accent, by colour scheme')
})

test('mirror --check and tokens check fail while the mirror is behind the CSS', () => {
  const ctx = fresh()
  for (const mode of ['mirror', 'build', 'resolved']) assert.equal(run('tokens', ctx, [mode]).status, 0, mode)
  const ok = run('tokens', ctx, ['mirror', '--check'])
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /up to date with src\/styles\/theme\.css \(32 tokens\)/)
  assert.match(run('tokens', ctx, ['check']).stdout, /up to date \(32 tokens, 0 stale, 0 contrast failures, token mirror current, resolved\.json current\)/)

  const css = join(ctx.root, 'src', 'styles', 'theme.css')
  writeFileSync(css, readFileSync(css, 'utf8').replace('--radius-2: 0.5rem;', '--radius-2: 0.75rem;'))
  const behind = run('tokens', ctx, ['mirror', '--check'])
  assert.equal(behind.status, 1)
  assert.match(behind.stderr, /stale: design-system\/tokens\/base\.tokens\.json/)
  const check = run('tokens', ctx, ['check'])
  assert.equal(check.status, 1)
  assert.match(check.stderr, /behind the style files: design-system\/tokens\/base\.tokens\.json/)
  assert.match(check.stdout, /token mirror behind the style files, resolved\.json behind\)\. Run: node \.\.\/project\/scripts\/tokens\.mjs mirror, then node \.\.\/project\/scripts\/tokens\.mjs build, then node \.\.\/project\/scripts\/tokens\.mjs resolved/)
  assert.match(run('tokens', ctx, ['build']).stderr, /warn: the mirror is behind the style files/)
  for (const mode of ['mirror', 'build', 'resolved']) assert.equal(run('tokens', ctx, [mode]).status, 0, mode)
  assert.equal(run('tokens', ctx, ['check']).status, 0)
})

test('build never writes over a file it mirrors, or one it would read once written', () => {
  const ctx = fresh()
  assert.equal(run('tokens', ctx, ['mirror']).status, 0)
  setConfig(ctx, { outputs: [{ format: 'css', path: 'src/styles/theme.css' }] })
  const before = read(ctx.root, 'src', 'styles', 'theme.css')
  for (const mode of ['build', 'check']) {
    const r = run('tokens', ctx, [mode])
    assert.equal(r.status, 1, mode)
    assert.match(r.stderr, /tokens\.outputs writes src\/styles\/theme\.css, which tokens\.mirror reads as the source/)
  }
  assert.equal(read(ctx.root, 'src', 'styles', 'theme.css'), before)

  // An output the style files' glob matches is a source from its first build on.
  setConfig(ctx, { styleFiles: ['src/styles/*.css'], outputs: [{ format: 'css', path: 'src/styles/built.css' }] })
  assert.equal(run('tokens', ctx, ['mirror']).status, 0)
  for (const mode of ['build', 'check']) {
    const r = run('tokens', ctx, [mode])
    assert.equal(r.status, 1, mode)
    assert.match(r.stderr, /tokens\.outputs writes src\/styles\/built\.css, which tokens\.mirror reads as the source/)
  }
  assert.equal(existsSync(join(ctx.root, 'src', 'styles', 'built.css')), false)
  // A folder the walk ignores is never read, so an output may go there.
  setConfig(ctx, { styleFiles: ['src/styles/theme.css', 'dist/**/*.css'], outputs: [{ format: 'css', path: 'dist/tokens.css' }] })
  assert.equal(run('tokens', ctx, ['mirror']).status, 0)
  assert.equal(run('tokens', ctx, ['build']).status, 0)
})

test('the mirror waits for tokens.mirror, and never writes over a token set it did not write', () => {
  const ctx = fresh()
  assert.match(run('tokens', ctx, ['build']).stderr, /no mirror of the style files at design-system\/tokens\/tokens\.resolver\.json yet\. Run: node \.\.\/project\/scripts\/tokens\.mjs mirror/)
  setConfig(ctx, { mirror: false })
  const off = run('tokens', ctx, ['mirror'])
  assert.equal(off.status, 1)
  assert.match(off.stderr, /tokens\.mirror is off/)
  setConfig(ctx, { mirror: true })
  const own = '{ "$description": "Hand-kept.", "color": { "$type": "color", "x": { "$value": "#ffffff" } }, "$extensions": { "massimo": { "format": 2 } } }\n'
  assert.equal(run('tokens', ctx, ['mirror']).status, 0)
  writeFileSync(join(tokensDir(ctx), 'base.tokens.json'), own)
  const r = run('tokens', ctx, ['mirror'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /base\.tokens\.json holds a token set that is not a mirror of the style files/)
  assert.equal(read(tokensDir(ctx), 'base.tokens.json'), own)
  writeFileSync(join(tokensDir(ctx), 'base.tokens.json'), '{ "$extensions": { "massimo": { "format": 9, "mirror": { "from": [] } } } }\n')
  assert.match(run('tokens', ctx, ['mirror']).stderr, /written by a newer massimo \(format 9/)
})
