// The browser-free half of shoot.mjs (scripts/lib/shoot.mjs), and the script's
// own flow against a stand-in for Playwright, so none of it needs a browser.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  DETERMINISTIC,
  booleanize,
  compareText,
  determinism,
  diffArgs,
  isOn,
  isUrl,
  loadChromium,
  pairFiles,
  parsePairs,
  percent,
  playwrightEntries,
  pngSize,
  summarise,
  textLines,
  verdict,
} from '../scripts/lib/shoot.mjs'
import { FIXTURES, SCRIPTS } from './helpers.mjs'

const base = mkdtempSync(join(tmpdir(), 'massimo-shoot-'))
after(() => rmSync(base, { recursive: true, force: true }))

// A Playwright install that is only a package.json and the recording stand-in.
function fakePlaywright(folder, { name = 'playwright', main } = {}) {
  const pkg = join(folder, 'node_modules', name)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, ...(main ? { main } : {}) }))
  copyFileSync(join(FIXTURES, 'fake-playwright.cjs'), join(pkg, main ?? 'index.js'))
  return pkg
}

function png(width, height) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12)
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

test('urls and flags are told apart', () => {
  assert.ok(isUrl('http://localhost:4330/a'))
  assert.ok(isUrl('HTTPS://example.test/'))
  assert.ok(isUrl('file:///tmp/a.html'))
  assert.ok(!isUrl('shots/a.png'))
  assert.ok(!isUrl('/abs/a.png'))
  assert.ok(isOn(true) && isOn('true') && isOn('1') && isOn(1))
  assert.ok(!isOn(undefined) && !isOn('false') && !isOn('0'))
})

test('a bare boolean flag no longer swallows the word after it', () => {
  assert.deepEqual(booleanize(['--freeze', 'x.png', '--settle', '--out', 'd'], ['freeze', 'settle']), ['--freeze=true', 'x.png', '--settle=true', '--out', 'd'])
  assert.deepEqual(booleanize(['--freeze=false'], ['freeze']), ['--freeze=false'])
})

test('determinism reads flags and batch entries, and a batch entry overrides the flags', () => {
  const off = { reducedMotion: false, freeze: false, settle: false }
  assert.deepEqual(determinism({}), off)
  assert.deepEqual(determinism({ 'reduced-motion': 'true', freeze: 'true' }), { reducedMotion: true, freeze: true, settle: false })
  assert.deepEqual(determinism({ reducedMotion: true, settle: true }), { reducedMotion: true, freeze: false, settle: true })
  const fixed = determinism({ freeze: 'true' })
  assert.equal(determinism({}, fixed).freeze, true)
  assert.equal(determinism({ freeze: false }, fixed).freeze, false)
  assert.deepEqual(DETERMINISTIC, { reducedMotion: true, freeze: true, settle: true })
})

test('--diff names its pair either way round', () => {
  assert.deepEqual(diffArgs(['b.png'], { diff: 'a.png' }), { a: 'a.png', b: 'b.png' })
  assert.deepEqual(diffArgs(['a.png', 'b.png'], { diff: true }), { a: 'a.png', b: 'b.png' })
  assert.deepEqual(diffArgs([], {}), { a: undefined, b: undefined })
})

test('the verdict: over the limit or a size mismatch fails, the limit itself passes', () => {
  assert.deepEqual(verdict({ changed: 0, total: 100 }, 0), { ok: true, reasons: [] })
  assert.equal(verdict({ changed: 1, total: 100 }, 1).ok, true)
  assert.equal(verdict({ changed: 2, total: 100 }, 1).ok, false)
  assert.equal(verdict({ changed: 7, total: 100 }, 7).ok, true)
  assert.equal(verdict({ changed: 1, total: 1000 }, 0.1).ok, true)
  const sized = verdict({ changed: 0, total: 100, sizeMismatch: true, sizes: ['10x10', '10x12'] })
  assert.equal(sized.ok, false)
  assert.deepEqual(sized.reasons, ['sizes differ (10x10 and 10x12)'])
  assert.deepEqual(verdict({ changed: 0, total: 100, sizeMismatch: true }).reasons, ['sizes differ'])
})

test('one changed pixel on a large page prints 0 but still fails at the default limit', () => {
  const total = 1280 * 20000
  assert.equal(percent(1, total), 0)
  assert.equal(verdict({ changed: 1, total }).ok, false)
  assert.equal(verdict({ changed: 1, total }, 0.001).ok, true)
})

test('the summary counts passes and failures', () => {
  assert.deepEqual(summarise([{ ok: true }, { ok: false }, { ok: true }], 0.5), { summary: true, pairs: 3, passed: 2, failed: 1, maxDiff: 0.5, ok: false })
  assert.equal(summarise([], 0).ok, true)
})

test('a PNG size is read from its header, and anything else is null', () => {
  assert.deepEqual(pngSize(png(1280, 3400)), { width: 1280, height: 3400 })
  assert.equal(pngSize(Buffer.from('not a png at all, just text')), null)
  assert.equal(pngSize(Buffer.alloc(4)), null)
})

test('a pairs file fills in defaults and keeps the fields it was given', () => {
  const { pairs, problems } = parsePairs(
    [
      { name: 'pill-light', a: 'http://x/a', b: 'http://y/a' },
      { name: 'cards/dark', a: 'a.png', b: 'b.png', width: 390, height: 844, scheme: 'dark', selector: '.stage', full: true, mode: 'dom' },
    ],
    { width: '1440' },
  )
  assert.deepEqual(problems, [])
  assert.deepEqual(pairs[0], { name: 'pill-light', a: 'http://x/a', b: 'http://y/a', mode: 'pixel', width: 1440, height: 800, scheme: 'light', full: false })
  assert.deepEqual(pairs[1], { name: 'cards/dark', a: 'a.png', b: 'b.png', mode: 'dom', width: 390, height: 844, scheme: 'dark', full: true, selector: '.stage' })
  assert.equal(parsePairs([{ name: 'x', a: 'a', b: 'b' }], { full: true }).pairs[0].full, true)
})

test('a pairs file reports every mistake at once and returns no pairs', () => {
  const { pairs, problems } = parsePairs([
    { name: 'ok', a: 'a', b: 'b' },
    { name: 'ok', a: 'a', b: 'b' },
    { name: '../up', a: 'a', b: 'b' },
    { name: 'no-b', a: 'a' },
    { name: 'mode', a: 'a', b: 'b', mode: 'both' },
    { name: 'scheme', a: 'a', b: 'b', scheme: 'sepia' },
    { name: 'size', a: 'a', b: 'b', width: 0, height: 'tall' },
    { name: 'typo', a: 'a', b: 'b', colour: 'dark' },
    'a string',
  ])
  assert.deepEqual(pairs, [])
  assert.equal(problems.length, 9)
  assert.ok(problems.some((p) => p.startsWith('pair 2 (ok): name is used twice')))
  assert.ok(problems.some((p) => p.includes('pair 3 (../up): name must be')))
  assert.ok(problems.some((p) => p.includes('pair 4 (no-b): b must be a URL or a file path')))
  assert.ok(problems.some((p) => p.includes('mode must be')))
  assert.ok(problems.some((p) => p.includes('scheme must be')))
  assert.ok(problems.some((p) => p.includes('width must be')) && problems.some((p) => p.includes('height must be')))
  assert.ok(problems.some((p) => p.includes('unknown field "colour"')))
  assert.ok(problems.some((p) => p.includes('pair 9: expected an object')))
  assert.deepEqual(parsePairs({ name: 'x' }).problems, ['the pairs file must hold an array'])
})

test('a pair writes its files under the output folder by name', () => {
  assert.deepEqual(pairFiles('/out', 'pill/dark', 'pixel'), { a: '/out/pill/dark.a.png', b: '/out/pill/dark.b.png', diff: '/out/pill/dark.diff.png' })
  assert.deepEqual(pairFiles('/out', 'hero', 'dom'), { a: '/out/hero.a.txt', b: '/out/hero.b.txt', diff: '/out/hero.diff.txt' })
})

test('text snapshots ignore line endings, trailing spaces and trailing blank lines', () => {
  assert.deepEqual(textLines('a  \r\nb\r\n\r\n'), ['a', 'b'])
  assert.deepEqual(textLines(''), [])
  const same = compareText('- heading "A"\n  - text: hi  \n\n', '- heading "A"\r\n  - text: hi')
  assert.equal(same.changed, 0)
  assert.equal(same.percent, 0)
  assert.equal(same.diff, '')
})

test('a changed line is counted once, and the diff shows it in context', () => {
  const a = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].join('\n')
  const b = ['one', 'two', 'three', 'four', 'FIVE', 'six', 'seven', 'eight', 'nine', 'ten'].join('\n')
  const r = compareText(a, b)
  assert.deepEqual([r.removed, r.added, r.changed, r.total, r.percent], [1, 1, 1, 10, 10])
  assert.equal(r.diff, ['@@ -3 +3 @@', '  three', '  four', '- five', '+ FIVE', '  six', '  seven'].join('\n'))
})

test('added and removed lines are aligned, not shifted', () => {
  const r = compareText('a\nb\nc\nd\ne', 'a\nb\nNEW\nc\nd\ne')
  assert.deepEqual([r.removed, r.added, r.linesA, r.linesB], [0, 1, 5, 6])
  assert.ok(r.diff.includes('+ NEW'))
  assert.ok(!r.diff.includes('- '))
  const moved = compareText('a\nb\nc', 'c\na\nb')
  assert.deepEqual([moved.removed, moved.added], [1, 1])
})

test('a text comparison is deterministic and two very different texts still compare', () => {
  const lines = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n')
  const x = compareText(lines('a', 2100), lines('b', 2100))
  assert.deepEqual([x.removed, x.added, x.percent], [2100, 2100, 100])
  assert.equal(JSON.stringify(compareText('a\nb\nc', 'a\nx\nc')), JSON.stringify(compareText('a\nb\nc', 'a\nx\nc')))
})

test('--playwright takes a package folder, a node_modules folder or a repo root', () => {
  const repo = join(base, 'checkout')
  const pkg = fakePlaywright(repo)
  const entry = join(pkg, 'index.js')
  assert.deepEqual(playwrightEntries(pkg), [entry])
  assert.deepEqual(playwrightEntries(join(repo, 'node_modules')), [entry])
  assert.deepEqual(playwrightEntries(repo), [entry])
  assert.deepEqual(playwrightEntries(entry), [entry])
  assert.deepEqual(playwrightEntries(`${repo}/`), [entry])
})

test('--playwright finds the other package names and a main file that is not index.js', () => {
  const scoped = fakePlaywright(join(base, 'scoped'), { name: '@playwright/test' })
  assert.deepEqual(playwrightEntries(join(base, 'scoped')), [join(scoped, 'index.js')])
  const core = fakePlaywright(join(base, 'core'), { name: 'playwright-core', main: 'entry.js' })
  assert.deepEqual(playwrightEntries(join(base, 'core', 'node_modules')), [join(core, 'entry.js')])
})

test('--playwright finds nothing in a folder that has no Playwright', () => {
  const empty = join(base, 'empty')
  mkdirSync(join(empty, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(empty, 'node_modules', 'left-pad', 'package.json'), JSON.stringify({ name: 'left-pad' }))
  assert.deepEqual(playwrightEntries(empty), [])
  assert.deepEqual(playwrightEntries(join(base, 'does-not-exist')), [])
})

test('chromium loads from another checkout by absolute path, and from the repo itself', async () => {
  const other = join(base, 'other')
  fakePlaywright(other)
  const viaPath = await loadChromium({ root: join(base, 'unrelated'), playwright: other })
  assert.equal(typeof viaPath.launch, 'function')
  const own = join(base, 'own')
  fakePlaywright(own)
  const viaRoot = await loadChromium({ root: own })
  assert.equal(typeof viaRoot.launch, 'function')
})

test('chromium is null when the path holds no Playwright or a package without chromium', async () => {
  assert.equal(await loadChromium({ root: base, playwright: join(base, 'does-not-exist') }), null)
  const hollow = join(base, 'hollow')
  const pkg = join(hollow, 'node_modules', 'playwright')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'playwright' }))
  writeFileSync(join(pkg, 'index.js'), 'module.exports = {}')
  assert.equal(await loadChromium({ root: base, playwright: hollow }), null)
  // an explicit path is never replaced by the repo's own install
  const own = join(base, 'own-two')
  fakePlaywright(own)
  assert.equal(await loadChromium({ root: own, playwright: hollow }), null)
})

// The script itself, with the stand-in as its Playwright.
const stand = join(base, 'stand-in')
const standIn = fakePlaywright(stand)
const work = join(base, 'work')
mkdirSync(work)

function shoot(args, env = {}) {
  const logFile = join(work, `log-${Math.random().toString(36).slice(2)}.jsonl`)
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'shoot.mjs'), ...args, '--root', work], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_LOG: logFile, ...env },
  })
  const calls = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const lines = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { status: r.status, stderr: r.stderr, lines, calls }
}

test('a plain shot asks Playwright for exactly what it did before the determinism flags', () => {
  const r = shoot(['--url', 'http://x.test/', '--out', join(work, 'plain.png'), '--playwright', standIn])
  assert.equal(r.status, 0)
  assert.deepEqual(Object.keys(r.lines[0]), ['url', 'out', 'width', 'height'])
  assert.deepEqual(r.calls.map((c) => c.name), ['launch', 'newContext', 'goto', 'screenshot', 'contextClose', 'close'])
  assert.deepEqual(r.calls[1].arg, { viewport: { width: 1280, height: 800 }, colorScheme: 'light', deviceScaleFactor: 1 })
  assert.ok(existsSync(join(work, 'plain.png')))
})

test('the determinism flags switch on motion emulation, the freeze style and the settle step', () => {
  const r = shoot(['--url', 'http://x.test/', '--out', join(work, 'still.png'), '--reduced-motion', '--freeze', '--settle', '--playwright', standIn])
  assert.equal(r.status, 0)
  assert.equal(r.calls.find((c) => c.name === 'newContext').arg.reducedMotion, 'reduce')
  assert.ok(r.calls.some((c) => c.name === 'addInitScript'))
  assert.ok(r.calls.some((c) => c.name === 'settle'))
  const names = r.calls.map((c) => c.name)
  assert.ok(names.indexOf('settle') > names.indexOf('goto') && names.indexOf('settle') < names.indexOf('screenshot'))
  // each flag on its own switches on only itself
  const one = shoot(['--url', 'http://x.test/', '--out', join(work, 'one.png'), '--freeze', '--playwright', standIn])
  assert.ok(one.calls.some((c) => c.name === 'addInitScript'))
  assert.ok(!one.calls.some((c) => c.name === 'settle'))
  assert.equal(one.calls.find((c) => c.name === 'newContext').arg.reducedMotion, undefined)
})

test('a batch entry can turn a control on for its own shot', () => {
  const file = join(work, 'batch.json')
  writeFileSync(file, JSON.stringify([{ url: 'http://x.test/a', out: join(work, 'b1.png') }, { url: 'http://x.test/b', out: join(work, 'b2.png'), freeze: true }]))
  const r = shoot(['--batch', file, '--playwright', standIn])
  assert.equal(r.lines.length, 2)
  assert.equal(r.calls.filter((c) => c.name === 'addInitScript').length, 1)
})

test('--diff prints the same line as before and exits 0 whatever the difference', () => {
  writeFileSync(join(work, 'a.png'), png(2, 2))
  writeFileSync(join(work, 'b.png'), png(2, 2))
  const r = shoot(['--diff', join(work, 'a.png'), join(work, 'b.png'), '--out', join(work, 'd.png'), '--playwright', standIn], { FAKE_CHANGED: '3' })
  assert.equal(r.status, 0)
  assert.deepEqual(Object.keys(r.lines[0]), ['a', 'b', 'out', 'width', 'height', 'changed', 'total', 'sizeMismatch', 'percent'])
  assert.equal(r.lines[0].percent, 75)
  assert.ok(existsSync(join(work, 'd.png')))
})

test('no Playwright at the given path is exit 3 and names the path', () => {
  const r = shoot(['--url', 'http://x.test/', '--out', join(work, 'none.png'), '--playwright', join(base, 'nowhere')])
  assert.equal(r.status, 3)
  assert.ok(r.stderr.includes(join(base, 'nowhere')))
  assert.deepEqual(r.calls, [])
})

function pairsRun(pairs, args = [], env = {}) {
  const file = join(work, `pairs-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(file, JSON.stringify(pairs))
  const out = join(work, `out-${Math.random().toString(36).slice(2)}`)
  const r = shoot(['--pairs', file, '--out', out, '--playwright', standIn, ...args], env)
  return { ...r, out }
}

test('--pairs on two images prints a line per pair and a summary, and exits 0 when they match', () => {
  writeFileSync(join(work, 'p1.png'), png(2, 2))
  writeFileSync(join(work, 'p2.png'), png(2, 2))
  const r = pairsRun([{ name: 'same', a: join(work, 'p1.png'), b: join(work, 'p2.png') }])
  assert.equal(r.status, 0)
  assert.equal(r.lines.length, 2)
  assert.equal(r.lines[0].name, 'same')
  assert.equal(r.lines[0].mode, 'pixel')
  assert.equal(r.lines[0].ok, true)
  assert.equal(r.lines[0].diff, join(r.out, 'same.diff.png'))
  assert.ok(existsSync(join(r.out, 'same.diff.png')))
  assert.deepEqual(r.lines[1], { summary: true, pairs: 1, passed: 1, failed: 0, maxDiff: 0, ok: true })
})

test('--pairs exits 1 when a pair is over --max-diff, and the limit itself passes', () => {
  writeFileSync(join(work, 'q1.png'), png(2, 2))
  writeFileSync(join(work, 'q2.png'), png(2, 2))
  const pairs = [{ name: 'one-pixel', a: join(work, 'q1.png'), b: join(work, 'q2.png') }]
  const over = pairsRun(pairs, [], { FAKE_CHANGED: '1' })
  assert.equal(over.status, 1)
  assert.equal(over.lines[0].ok, false)
  assert.deepEqual(over.lines[0].reasons, ['25% changed, over 0%'])
  assert.deepEqual(over.lines[1], { summary: true, pairs: 1, passed: 0, failed: 1, maxDiff: 0, ok: false })
  assert.equal(pairsRun(pairs, ['--max-diff', '25'], { FAKE_CHANGED: '1' }).status, 0)
  assert.equal(pairsRun(pairs, ['--max-diff=24.9'], { FAKE_CHANGED: '1' }).status, 1)
})

test('--pairs fails images of different sizes even when no pixel differs, and says both sizes', () => {
  writeFileSync(join(work, 's1.png'), png(1280, 800))
  writeFileSync(join(work, 's2.png'), png(1280, 1500))
  const r = pairsRun([{ name: 'sized', a: join(work, 's1.png'), b: join(work, 's2.png') }], ['--max-diff', '100'], { FAKE_MISMATCH: '1' })
  assert.equal(r.status, 1)
  assert.deepEqual(r.lines[0].reasons, ['sizes differ (1280x800 and 1280x1500)'])
})

test('--pairs shoots URLs with every determinism control on, into <name>.a.png and <name>.b.png', () => {
  const r = pairsRun([{ name: 'story/pill', a: 'http://one.test/pill', b: 'http://two.test/pill', width: 390, height: 844, scheme: 'dark', full: true }])
  assert.equal(r.status, 0)
  assert.ok(existsSync(join(r.out, 'story', 'pill.a.png')) && existsSync(join(r.out, 'story', 'pill.b.png')) && existsSync(join(r.out, 'story', 'pill.diff.png')))
  const contexts = r.calls.filter((c) => c.name === 'newContext')
  assert.equal(contexts.length, 2)
  for (const c of contexts) assert.deepEqual(c.arg, { viewport: { width: 390, height: 844 }, colorScheme: 'dark', deviceScaleFactor: 1, reducedMotion: 'reduce' })
  assert.equal(r.calls.filter((c) => c.name === 'addInitScript').length, 2)
  assert.equal(r.calls.filter((c) => c.name === 'settle').length, 2)
  assert.deepEqual(r.calls.filter((c) => c.name === 'screenshot').map((c) => c.arg), [{ fullPage: true }, { fullPage: true }])
  assert.deepEqual(r.calls.filter((c) => c.name === 'goto').map((c) => c.arg), ['http://one.test/pill', 'http://two.test/pill'])
})

test('--pairs in dom mode compares text snapshots, from files or from pages', () => {
  writeFileSync(join(work, 't1.txt'), '- heading "Title"\n- paragraph: one\n- paragraph: two\n- link "Home"')
  writeFileSync(join(work, 't2.txt'), '- heading "Title"\n- paragraph: one\n- paragraph: TWO\n- link "Home"')
  const files = [{ name: 'same', mode: 'dom', a: join(work, 't1.txt'), b: join(work, 't1.txt') }]
  const same = pairsRun(files)
  assert.equal(same.status, 0)
  assert.equal(same.lines[0].mode, 'dom')
  assert.equal(same.lines[0].changed, 0)
  assert.equal(readFileSync(join(same.out, 'same.diff.txt'), 'utf8'), '')

  const differ = [{ name: 'differ', mode: 'dom', a: join(work, 't1.txt'), b: join(work, 't2.txt') }]
  const fail = pairsRun(differ)
  assert.equal(fail.status, 1)
  assert.deepEqual([fail.lines[0].changed, fail.lines[0].total, fail.lines[0].percent], [1, 4, 25])
  assert.ok(readFileSync(join(fail.out, 'differ.diff.txt'), 'utf8').includes('+ - paragraph: TWO'))
  assert.equal(pairsRun(differ, ['--max-diff', '25']).status, 0)

  const pages = pairsRun([{ name: 'live', mode: 'dom', a: 'http://one.test/', b: 'http://two.test/', selector: 'main' }])
  assert.equal(pages.status, 0)
  assert.equal(readFileSync(join(pages.out, 'live.a.txt'), 'utf8'), 'tree of main')
  assert.ok(!pages.calls.some((c) => c.name === 'screenshot' || c.name === 'diff'))
})

test('--pairs: a pair that cannot run is reported and the rest still run', () => {
  writeFileSync(join(work, 'r1.png'), png(2, 2))
  const r = pairsRun([
    { name: 'missing', a: join(work, 'gone.png'), b: join(work, 'r1.png') },
    { name: 'fine', a: join(work, 'r1.png'), b: join(work, 'r1.png') },
  ])
  assert.equal(r.status, 1)
  assert.equal(r.lines[0].ok, false)
  assert.ok(r.lines[0].error.startsWith('no such file'))
  assert.equal(r.lines[1].ok, true)
  assert.deepEqual(r.lines[2], { summary: true, pairs: 2, passed: 1, failed: 1, maxDiff: 0, ok: false })
})

test('--pairs refuses a bad file before any browser starts', () => {
  const r = pairsRun([{ name: 'a', a: 'x.png' }, { name: 'a', a: 'x', b: 'y', mode: 'both' }])
  assert.equal(r.status, 1)
  assert.deepEqual(r.calls, [])
  assert.ok(r.stderr.includes('b must be a URL or a file path'))
  assert.ok(r.stderr.includes('name is used twice'))
  assert.ok(r.stderr.includes('mode must be'))
  const noOut = spawnSync(process.execPath, [join(SCRIPTS, 'shoot.mjs'), '--pairs', join(work, 'x.json'), '--root', work], { encoding: 'utf8' })
  assert.equal(noOut.status, 1)
  assert.ok(noOut.stderr.includes('usage: shoot.mjs --pairs'))
  const negative = pairsRun([{ name: 'n', a: 'a.png', b: 'b.png' }], ['--max-diff', '-1'])
  assert.equal(negative.status, 1)
  assert.ok(negative.stderr.includes('--max-diff'))
})
