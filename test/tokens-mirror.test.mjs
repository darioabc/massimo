// tokens.mjs mirror: with tokens.mirror on, the style files stay the source
// and the token set is their checked mirror. Every selector's declarations
// rebuild from it as the CSS has them: themes from the config's selectors,
// everything under another selector in its scopes, nothing misread.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { readTokenSource } from '../scripts/lib/dtcg.mjs'
import { cssRules, ruleSelectors, selectorKey } from '../scripts/lib/sheets.mjs'
import { golden, read, readJson, run, scratch } from './helpers.mjs'

const contexts = []
after(() => contexts.forEach((c) => c.cleanup()))
const fresh = () => {
  const ctx = scratch('sheets')
  contexts.push(ctx)
  return ctx
}
const tokensDir = (ctx) => join(ctx.root, 'design-system', 'tokens')
const configOf = (ctx) => readJson(ctx.root, 'massimo.config.json')
const setConfig = (ctx, tokens) => {
  const config = configOf(ctx)
  writeFileSync(join(ctx.root, 'massimo.config.json'), JSON.stringify({ ...config, tokens: { ...config.tokens, ...tokens } }))
}

// Every custom property a stylesheet declares, by selector (each member of a
// list on its own, after its at-rules), the last one winning as in the cascade.
function bySelector(css) {
  const out = new Map()
  for (const rule of cssRules(css)) {
    const { members, conditions } = ruleSelectors(rule.headers)
    for (const member of members) {
      for (const d of rule.decls) {
        if (!d.prop.startsWith('--')) continue
        const key = selectorKey(member, conditions)
        if (!out.has(key)) out.set(key, new Map())
        out.get(key).set(d.prop, d.value.replace(/\s*!important$/, ''))
      }
    }
  }
  return out
}
const sorted = (map) => Object.fromEntries([...(map ?? new Map())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

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

  const source = bySelector(read(ctx.root, 'src', 'styles', 'theme.css'))
  const built = bySelector(read(ctx.root, 'src', 'styles', 'built.css'))
  // The scopes come from the mirror itself: each token's, and those set only in scopes.
  const mirror = new Map()
  const put = (key, name, value) => {
    if (!mirror.has(key)) mirror.set(key, new Map())
    mirror.get(key).set(name, value)
  }
  const set = readTokenSource(ctx.root, { tokens: { source: 'design-system/tokens/tokens.resolver.json' } })
  for (const t of set.tokens) for (const [key, value] of Object.entries(t.scopes ?? {})) put(key, t.cssVar, value)
  const scoped = readJson(tokensDir(ctx), 'base.tokens.json').$extensions.massimo.mirror.scoped
  for (const [name, entry] of Object.entries(scoped)) for (const [key, value] of Object.entries(entry.scopes)) put(key, name, value)

  // A theme's value is its own declaration or the root's, which it inherits:
  // a dark line that repeats the light one adds nothing.
  const themes = [':root', 'html.dark']
  for (const theme of themes) {
    const effective = (m) => new Map([...(m.get(':root') ?? []), ...(m.get(theme) ?? [])])
    assert.deepEqual(sorted(effective(built)), sorted(effective(source)), theme)
  }
  const scopes = [...source.keys()].filter((k) => !themes.includes(k))
  assert.deepEqual([...mirror.keys()].sort(), [...scopes].sort())
  for (const key of scopes) assert.deepEqual(sorted(mirror.get(key)), sorted(source.get(key)), key)
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

test('a comment before a declaration, or after it on its line, becomes its description; names stay the CSS names', () => {
  const ctx = fresh()
  assert.equal(run('tokens', ctx, ['mirror']).status, 0)
  const base = readJson(tokensDir(ctx), 'base.tokens.json')
  assert.equal(base.color['sand-200'].$description, 'Palette. Channels, so a role can add an alpha.')
  assert.equal(base.color['sand-50'].$description, '#fffdf8 a sheet')
  assert.equal(base.color.scrim.$description, 'The page dimmed under a dialog, the same in both themes.')
  assert.equal(base.color['ink-950'].$description, undefined)
  assert.equal(base.color.ground.$extensions.massimo.cssVar, '--c-ground')
  assert.equal(base.font.body.$extensions.massimo.css, '"Geist", system-ui, sans-serif')
})

test('mirror --check and tokens check fail while the mirror is behind the CSS', () => {
  const ctx = fresh()
  for (const mode of ['mirror', 'build', 'resolved']) assert.equal(run('tokens', ctx, [mode]).status, 0, mode)
  const ok = run('tokens', ctx, ['mirror', '--check'])
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /up to date with src\/styles\/theme\.css \(32 tokens\)/)
  assert.match(run('tokens', ctx, ['check']).stdout, /up to date \(32 tokens, 0 stale, 0 contrast failures, mirror current, resolved\.json current\)/)

  const css = join(ctx.root, 'src', 'styles', 'theme.css')
  writeFileSync(css, readFileSync(css, 'utf8').replace('--radius-2: 0.5rem;', '--radius-2: 0.75rem;'))
  const behind = run('tokens', ctx, ['mirror', '--check'])
  assert.equal(behind.status, 1)
  assert.match(behind.stderr, /stale: design-system\/tokens\/base\.tokens\.json/)
  const check = run('tokens', ctx, ['check'])
  assert.equal(check.status, 1)
  assert.match(check.stderr, /behind the style files: design-system\/tokens\/base\.tokens\.json/)
  assert.match(check.stdout, /mirror behind the style files, resolved\.json behind\)\. Run: node \.\.\/project\/scripts\/tokens\.mjs mirror, then node \.\.\/project\/scripts\/tokens\.mjs build, then node \.\.\/project\/scripts\/tokens\.mjs resolved/)
  assert.match(run('tokens', ctx, ['build']).stderr, /warn: the mirror is behind the style files/)
  for (const mode of ['mirror', 'build', 'resolved']) assert.equal(run('tokens', ctx, [mode]).status, 0, mode)
  assert.equal(run('tokens', ctx, ['check']).status, 0)
})

test('build never writes over a file it mirrors', () => {
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
