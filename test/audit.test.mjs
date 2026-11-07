import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { read, readJson, run, scratch } from './helpers.mjs'

const ctx = scratch()
after(() => ctx.cleanup())
const env = { MASSIMO_TODAY: '2026-01-02' }

test('audit finds raw values by kind and writes latest.json and latest.md', () => {
  process.env.MASSIMO_TODAY = env.MASSIMO_TODAY
  const r = run('audit', ctx)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^massimo audit: 24 findings in \d+ files; 6 colours in 6 clusters, 2 font sizes, 2 families, 1 off-grid spacing values; wrote .*latest\.md\n$/)
  const latest = readJson(ctx.project, 'audits', 'latest.json')
  assert.equal(latest.date, '2026-01-02')
  assert.deepEqual(latest.totals, { color: 6, arbitrary: 4, length: 7, 'font-family': 2, 'primitive-read': 1, 'undefined-var': 2, 'tailwind-palette': 2 })
  assert.ok(existsSync(join(ctx.project, 'audits', 'latest.md')))
  assert.ok(!existsSync(join(ctx.project, 'audits', 'baseline.json')))
})

const latest = () => readJson(ctx.project, 'audits', 'latest.json')
const values = (kind) => latest().findings.filter((f) => f.kind === kind).map((f) => f.value)

test('colours: hex and functional; not comments, fragments or var() reads', () => {
  assert.deepEqual(values('color'), ['#fff', '#ffffff', '#000', '#333', '#FF0000', 'rgba(0, 0, 0, 0.5)'])
})

test('arbitrary values carry a sub-kind; var() values are skipped', () => {
  const arb = latest().findings.filter((f) => f.kind === 'arbitrary').map((f) => `${f.value}:${f.sub}`)
  assert.deepEqual(arb, ['bg-[#0f0]:color', 'grid-cols-[1fr_2fr]:other', 'p-[6px]:length', 'text-[13px]:length'])
})

test('lengths: CSS declarations and style objects; not 0, 1px, % or media queries', () => {
  const lengths = latest().findings.filter((f) => f.kind === 'length').map((f) => `${f.file.split('/').pop()}:${f.value}:${f.sub}`)
  assert.deepEqual(lengths, [
    'legacy.css:12px:spacing',
    'legacy.css:6px:spacing',
    'legacy.css:13px:type',
    'raw.tsx:13px:type',
    'raw.tsx:4px:radius',
    'raw.tsx:6px:spacing',
    'raw.tsx:8px:spacing',
  ])
})

test('font families: CSS and style objects; not @font-face definitions or var()', () => {
  assert.deepEqual(values('font-family'), ['"Helvetica Neue", Arial, sans-serif', 'Inter, sans-serif'])
  assert.deepEqual(latest().fontFamilies.map((f) => f.family), ['Helvetica Neue', 'Inter'])
})

test('primitive-read, undefined-var and tailwind-palette', () => {
  assert.deepEqual(values('primitive-read'), ['--color-neutral-0']) // a literal DTCG token read outside the token files
  assert.deepEqual(values('undefined-var'), ['--missing-var', '--space']) // --with-fallback has a fallback
  assert.deepEqual(values('tailwind-palette'), ['bg-slate-50', 'text-red-600']) // bg-brand is the repo's own token
  assert.deepEqual(latest().skipped, {})
})

test('aggregates: canon, clusters with the nearest token, spacing and type histograms', () => {
  const a = latest()
  assert.deepEqual(a.canon, { distinctColors: 6, colorClusters: 6, distinctFontSizes: 2, distinctFontFamilies: 2, offGridSpacingValues: 1, arbitraryValues: 4 })
  const white = a.colorClusters.find((c) => c.representative === '#ffffff')
  assert.equal(white.count, 2)
  assert.deepEqual(white.nearestToken, { name: '--color-base-100', value: '#ffffff', distance: 0 })
  assert.deepEqual(a.spacing.histogram, [
    { px: 6, count: 3, offGrid: true },
    { px: 8, count: 1, offGrid: false },
    { px: 12, count: 1, offGrid: false },
  ])
  assert.deepEqual(a.typeSizes, [
    { px: 13, count: 3, sources: { css: 2, arbitrary: 1, tailwind: 0 } },
    { px: 14, count: 1, sources: { css: 0, arbitrary: 0, tailwind: 1 } },
  ])
  assert.equal(a.topFiles[0].file, 'src/raw.tsx')
})

test('--cluster merges near colours', () => {
  const r = run('audit', ctx, ['--cluster', '2'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(latest().colorClusters.length < 6, true)
  run('audit', ctx) // restore the default report
})

test('latest.md leads with the canon and is capped', () => {
  const md = readFileSync(join(ctx.project, 'audits', 'latest.md'), 'utf8')
  assert.ok(md.startsWith('# Design-system audit\n'))
  assert.ok(md.indexOf('## Canon') < md.indexOf('## Top files') && md.indexOf('## Top files') < md.indexOf('## Findings\n'))
  assert.match(md, /Distinct colours: 6/)
  assert.ok(md.split('\n').length < 260)
})

test('ratchet: --check needs a baseline (exit 2) and writes nothing', () => {
  const fresh = scratch()
  try {
    const r = run('audit', fresh, ['--check'])
    assert.equal(r.status, 2)
    assert.ok(!existsSync(join(fresh.project, 'audits')))
  } finally {
    fresh.cleanup()
  }
})

test('ratchet: per-offender --check, --lower never records a rise', () => {
  const t = scratch()
  try {
    assert.equal(run('audit', t, ['--baseline']).status, 0)
    const baseline = readJson(t.project, 'audits', 'baseline.json')
    assert.equal(baseline.kinds.color.count, 6)
    assert.equal(baseline.kinds.color.offenders['src/legacy.css: #fff'], 1)
    assert.equal(baseline.kinds.length.offenders['src/legacy.css: 6px'], 1)
    assert.equal(run('audit', t, ['--check']).status, 0)

    // One colour goes away, a different one appears: the total holds, the offender is new.
    const legacy = join(t.root, 'src', 'legacy.css')
    writeFileSync(legacy, readFileSync(legacy, 'utf8').replace('  color: #fff;\n', ''))
    const raw = join(t.root, 'src', 'raw.tsx')
    writeFileSync(raw, readFileSync(raw, 'utf8').replace("color: '#FF0000'", "color: '#abc'"))
    const bad = run('audit', t, ['--check'])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /color {2}src\/raw\.tsx: #abc {2}new/)
    assert.match(bad.stdout, /1 offender rose or is new/)

    // --lower records the drops and refuses the new offender.
    const lowered = run('audit', t, ['--lower'])
    assert.equal(lowered.status, 0, lowered.stderr)
    assert.match(lowered.stderr, /not recorded: color {2}src\/raw\.tsx: #abc/)
    const after = readJson(t.project, 'audits', 'baseline.json')
    assert.equal(after.kinds.color.offenders['src/legacy.css: #fff'], undefined)
    assert.equal(after.kinds.color.offenders['src/raw.tsx: #abc'], undefined)
    assert.equal(after.kinds.color.offenders['src/raw.tsx: #FF0000'], undefined) // it also fell to zero
    assert.equal(run('audit', t, ['--check']).status, 1)

    // A rising count on a known offender also fails.
    writeFileSync(raw, readFileSync(raw, 'utf8').replace("color: '#abc'", "color: '#333'"))
    const rising = run('audit', t, ['--check'])
    assert.equal(rising.status, 1)
    assert.match(rising.stderr, /src\/raw\.tsx: #333 {2}1 -> 2/)

    // Back within the baseline, and --check hints that counts fell.
    writeFileSync(raw, readFileSync(raw, 'utf8').replace("color: '#333'", "color: 'inherit'"))
    const ok = run('audit', t, ['--check'])
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /within baseline/)
  } finally {
    t.cleanup()
  }
})

test('--check cannot be combined with --baseline or --lower', () => {
  assert.equal(run('audit', ctx, ['--check', '--baseline']).status, 2)
  assert.equal(run('audit', ctx, ['--baseline', '--lower']).status, 2)
})

test('style files: token declarations are exempt, other rules are audited', async () => {
  const { maskTokenDeclarations } = await import('../scripts/audit.mjs')
  const css = ':root { --a: #fff; --b: 12px; }\n.x { color: #000; width: var(--b); }\n'
  const masked = maskTokenDeclarations(css)
  assert.equal(masked.split('\n').length, css.split('\n').length)
  assert.ok(!masked.includes('#fff'))
  assert.ok(!masked.includes('12px'))
  assert.ok(masked.includes('#000'))
  assert.ok(masked.includes('var(--b)'))
})

test('inventory and colour roles: counted for the token proposals, never baselined', () => {
  const t = scratch()
  try {
    writeFileSync(join(t.root, 'src', 'inventory.css'), [
      '.a { line-height: 1.5; letter-spacing: -0.01em; font-weight: 600; box-shadow: 0 1px 2px #0003; }',
      '.b { transition: opacity 150ms cubic-bezier(0.4, 0, 0.2, 1); z-index: 40; opacity: 0.6; border: 1px solid #e5e5e5; }',
      '.c { background: #c8e6c9; color: #7b2d26; border-color: #26567b; }',
    ].join('\n'))
    writeFileSync(join(t.root, 'src', 'inventory.tsx'), "export const X = () => <div className=\"leading-6 font-semibold shadow-md z-50 duration-200 ease-in-out bg-[#c8e6c9]\" style={{ lineHeight: 1.5, zIndex: 40 }} />\n")
    const r = run('audit', t)
    assert.equal(r.status, 0, r.stderr)
    const { inventory, colorClusters } = readJson(t.project, 'audits', 'latest.json')
    const values = (family) => Object.fromEntries((inventory[family] ?? []).map((v) => [v.value, v.count]))
    assert.equal(values('lineHeight')['1.5'], 2) // CSS and a JS style object
    assert.equal(values('lineHeight')['class leading-6'], 1)
    assert.equal(values('fontWeight')['600'], 1)
    assert.equal(values('shadow')['0 1px 2px #0003'], 1)
    assert.equal(values('duration')['150ms'], 1)
    assert.equal(values('easing')['cubic-bezier(0.4, 0, 0.2, 1)'], 1)
    assert.equal(values('easing')['class ease-in-out'], 1)
    assert.equal(values('zIndex')['40'], 2)
    assert.equal(values('opacity')['0.6'], 1)
    assert.equal(values('border')['1px solid #e5e5e5'], 1)
    const roles = (hex) => colorClusters.find((c) => c.representative === hex)?.roles
    assert.deepEqual(roles('#c8e6c9'), { bg: 2 }) // a CSS background and a Tailwind bg-[…]
    assert.deepEqual(roles('#7b2d26'), { text: 1 })
    assert.deepEqual(roles('#26567b'), { border: 1 })
    assert.match(read(t.project, 'audits', 'latest.md'), /## Inventory\n\n.*never join the baseline\.\n\n- Borders:/)
    // The baseline keys only findings, so it is the same with or without the inventory.
    assert.equal(run('audit', t, ['--baseline']).status, 0)
    const baseline = readJson(t.project, 'audits', 'baseline.json')
    assert.ok(!JSON.stringify(baseline).includes('class leading-6'))
  } finally {
    t.cleanup()
  }
})
