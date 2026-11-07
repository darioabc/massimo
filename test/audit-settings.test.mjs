// The audit settings a repo with its own design-system rules needs: kinds
// turned off or on, exemptions by header role, tier, group and file, header
// definitions, arbitrary values and primitives limited to colour, and the
// breakpoint kind held to the repo's scale. The baseline that tracks a kind
// older scripts do not know is format 2, which they refuse by name.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { mediaWidths, variantWidths } from '../scripts/audit.mjs'
import { SCRIPTS, readJson, run, scratch } from './helpers.mjs'

const contexts = []
after(() => contexts.forEach((c) => c.cleanup()))
const fresh = (fixture = 'audit-adopt') => {
  const ctx = scratch(fixture)
  contexts.push(ctx)
  return ctx
}
const patch = (ctx, edit) => {
  const path = join(ctx.root, 'massimo.config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  edit(config)
  writeFileSync(path, JSON.stringify(config))
}
const audit = (ctx, args = []) => {
  const r = run('audit', ctx, args)
  assert.equal(r.status, 0, r.stderr)
  return readJson(ctx.project, 'audits', 'latest.json')
}
const keys = (latest, kind) => latest.findings.filter((f) => f.kind === kind).map((f) => `${f.file}: ${f.value}`)

test('media widths and Tailwind variants, as written or in rem', () => {
  assert.deepEqual(mediaWidths('(min-width: 40.0rem) and (max-width: 719px)'), ['40rem', '719px'])
  assert.deepEqual(mediaWidths('(400px <= width < 60rem)'), ['60rem', '400px'])
  const screens = { sm: '640px', lg: '1024px' }
  assert.deepEqual(variantWidths('max-sm:hover:hidden', screens), [{ variant: 'max-sm', width: '40rem' }])
  assert.deepEqual(variantWidths('min-[22.5rem]:flex', screens), [{ variant: 'min-[22.5rem]', width: '22.5rem' }])
  assert.deepEqual(variantWidths('[@media(min-width:30rem)]:grid', screens), [{ variant: '[@media(min-width:30rem)]', width: '30rem' }])
  assert.deepEqual(variantWidths('group-hover:dark:flex', screens), [])
})

test('every setting at once: what counts, what is exempt, what is off', () => {
  const ctx = fresh()
  const latest = audit(ctx)
  assert.deepEqual(latest.totals, { color: 0, arbitrary: 2, length: 0, 'font-family': 0, 'primitive-read': 1, 'undefined-var': 0, 'tailwind-palette': 1, breakpoint: 5 })
  assert.deepEqual(latest.skipped, { 'font-family': 'turned off in audit.kinds', length: 'turned off in audit.kinds' })
  // The scope role, the group and the file glob each exempt a colour; the
  // parked marker puts Old.astro in Explorations, which reads an undefined var.
  assert.deepEqual(latest.exempted, { breakpoint: 1, color: 3, 'primitive-read': 1, 'undefined-var': 1 })
  // Arbitrary values limited to colour: role reads count, p-[6px] does not.
  assert.deepEqual(keys(latest, 'arbitrary'), ['src/components/Card.astro: bg-[var(--c-line)]', 'src/components/Card.astro: text-[color:var(--c-text)]'])
  // A colour primitive read outside the token files; --space-4 is no colour,
  // and the token file's own rule reads --sand-200 where it belongs.
  assert.deepEqual(keys(latest, 'primitive-read'), ['src/components/Card.astro: --sand-200'])
  // The Tailwind config's colours make the palette kind run.
  assert.deepEqual(keys(latest, 'tailwind-palette'), ['src/components/Card.astro: bg-black/50'])
  // Off the scale: an arbitrary width, a screen from the config, a default
  // screen, a media query, and a variant in a helper. md: and the twin are on
  // it, and Poster's 500px is allowed by its header.
  assert.deepEqual(keys(latest, 'breakpoint').sort(), [
    'src/components/Card.astro: @media 30rem',
    'src/components/Card.astro: @media 400px (min-[400px]:)',
    'src/components/Card.astro: @media 56.25rem (tablet:)',
    'src/components/Card.astro: @media 64rem (lg:)',
    'src/lib/classes.ts: @media 80rem (xl:)',
  ])
  // ds:inputs defines --card-gap in Card.astro.
  assert.deepEqual(keys(latest, 'undefined-var'), [])
  const md = readFileSync(join(ctx.project, 'audits', 'latest.md'), 'utf8')
  assert.match(md, /- color: 0 \(3 exempt by audit\.exempt\)\n/)
  assert.match(md, /- length: skipped \(turned off in audit\.kinds\)\n/)
  assert.match(md, /- breakpoint: 5 \(1 exempt by audit\.exempt\)\n/)
})

test('a header definition is local to its file, and the scale replaces Tailwind screens in config order', () => {
  const ctx = fresh()
  writeFileSync(join(ctx.root, 'src', 'components', 'Other.astro'), '---\n// ds:group Primitives / Actions\n---\n<div style="gap: var(--card-gap)" class="sm:flex" />\n')
  writeFileSync(join(ctx.root, 'tailwind.config.mjs'), "export default { theme: { screens: { sm: '30rem' } } }\n")
  const latest = audit(ctx)
  assert.deepEqual(keys(latest, 'undefined-var'), ['src/components/Other.astro: --card-gap'])
  // theme.screens replaces the defaults: sm: is 30rem here, and lg: no longer exists.
  assert.ok(keys(latest, 'breakpoint').includes('src/components/Other.astro: @media 30rem (sm:)'))
  assert.ok(!keys(latest, 'breakpoint').some((k) => k.includes('(lg:)')))
})

test('the breakpoint kind needs its scale, and a setting that names no kind is a warning', () => {
  const ctx = fresh()
  patch(ctx, (c) => {
    delete c.tokens.breakpoints
    c.audit.kinds.colour = false
  })
  const r = run('audit', ctx)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /warn: audit\.kinds names "colour", which is not a kind/)
  const latest = readJson(ctx.project, 'audits', 'latest.json')
  assert.ok(!('breakpoint' in latest.totals))
  assert.ok(!('breakpoint' in latest.skipped))
})

test('a baseline that tracks the breakpoint kind is format 2, and one without it stays 1', () => {
  const ctx = fresh()
  assert.equal(run('audit', ctx, ['--baseline']).status, 0)
  const path = join(ctx.project, 'audits', 'baseline.json')
  const v2 = readJson(path)
  assert.equal(v2.version, 2)
  assert.equal(v2.kinds.breakpoint.count, 5)
  assert.ok(!('length' in v2.kinds)) // turned off: neither computed nor recorded
  assert.equal(run('audit', ctx, ['--check']).status, 0)

  // Without the scale the kind is not measured: --lower keeps its entries and
  // --check neither compares it nor calls it unknown.
  patch(ctx, (c) => delete c.tokens.breakpoints)
  const lowered = run('audit', ctx, ['--lower'])
  assert.equal(lowered.status, 0, lowered.stderr)
  assert.deepEqual(readJson(path).kinds.breakpoint, v2.kinds.breakpoint)
  assert.equal(readJson(path).version, 2)
  const check = run('audit', ctx, ['--check'])
  assert.equal(check.status, 0, check.stderr)
  assert.doesNotMatch(check.stdout, /breakpoint/)

  // A kind turned off keeps its entries too.
  patch(ctx, (c) => (c.audit.kinds.arbitrary = false))
  assert.equal(run('audit', ctx, ['--lower']).status, 0)
  assert.equal(readJson(path).kinds.arbitrary.count, 2)

  const plain = fresh()
  patch(plain, (c) => delete c.tokens.breakpoints)
  assert.equal(run('audit', plain, ['--baseline']).status, 0)
  assert.equal(readJson(plain.project, 'audits', 'baseline.json').version, 1)
})

test('scripts that read baseline format 1 refuse a format 2 baseline by name', () => {
  const ctx = fresh()
  assert.equal(run('audit', ctx, ['--baseline']).status, 0)
  // An older copy of the scripts: the same code with the format gate it had.
  const older = join(ctx.root, '..', 'older')
  for (const sub of ['', 'lib']) {
    mkdirSync(join(older, sub), { recursive: true })
    for (const name of readdirSync(join(SCRIPTS, sub))) if (name.endsWith('.mjs')) copyFileSync(join(SCRIPTS, sub, name), join(older, sub, name))
  }
  const lib = join(older, 'lib', 'project.mjs')
  writeFileSync(lib, readFileSync(lib, 'utf8').replace(/baseline: 2\b/, 'baseline: 1'))
  for (const flag of ['--check', '--lower', '--baseline']) {
    const r = spawnSync(process.execPath, [join(older, 'audit.mjs'), flag, '--root', ctx.root, '--project-dir', ctx.project], { encoding: 'utf8' })
    assert.equal(r.status, 1, flag)
    assert.match(r.stderr, /audits\/baseline\.json is format 2, and these scripts \(\S+\) read up to 1: update massimo/, flag)
  }
  assert.equal(readJson(ctx.project, 'audits', 'baseline.json').version, 2)
})

test('primitives limited to colour: a DTCG set counts its colours only', () => {
  const ctx = fresh('app')
  writeFileSync(join(ctx.root, 'src', 'reads.tsx'), "export const R = () => <i style={{ padding: 'var(--spacing-1)', color: 'var(--color-neutral-500)', margin: 'var(--radius-md)' }} />\n")
  const all = audit(ctx)
  assert.deepEqual(keys(all, 'primitive-read').filter((k) => k.startsWith('src/reads')), ['src/reads.tsx: --color-neutral-500', 'src/reads.tsx: --radius-md', 'src/reads.tsx: --spacing-1'])
  patch(ctx, (c) => (c.audit = { ...c.audit, primitives: 'color', arbitrary: 'color' }))
  const colour = audit(ctx)
  assert.deepEqual(keys(colour, 'primitive-read').filter((k) => k.startsWith('src/reads')), ['src/reads.tsx: --color-neutral-500'])
  // Arbitrary values limited to colour keep bg-[#0f0] and drop the rest.
  assert.deepEqual(keys(colour, 'arbitrary'), ['src/raw.tsx: bg-[#0f0]'])
})
