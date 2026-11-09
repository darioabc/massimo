// The browser-free half of shoot.mjs (scripts/lib/shoot.mjs), and the script's
// own flow against a stand-in for Playwright, so none of it needs a browser.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { FORMATS_READ, parseArgs } from '../scripts/lib/project.mjs'
import {
  DETERMINISTIC,
  FREEZE_CSS,
  SWEEP_FILLED,
  SWEEP_FLOOR,
  SWEEP_READY,
  compareText,
  determinism,
  diffArgs,
  editScript,
  flagNumber,
  idsOfMeta,
  isOn,
  isUrl,
  loadChromium,
  pairFiles,
  pairsDocument,
  parsePairs,
  percent,
  playwrightEntries,
  pngSize,
  summarise,
  sweepOptions,
  sweepResult,
  sweepUrl,
  textLines,
  verdict,
} from '../scripts/lib/shoot.mjs'
import { FIXTURES, SCRIPTS } from './helpers.mjs'
import { startServer } from './sweep-server.mjs'

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

test('a bare determinism flag does not swallow the word after it', () => {
  const bare = parseArgs(['--freeze', 'x.png', '--settle', '--reduced-motion', '--out', 'd'])
  assert.deepEqual(bare._, ['x.png'])
  assert.deepEqual(bare.flags, { freeze: true, settle: true, 'reduced-motion': true, out: 'd' })
  assert.equal(parseArgs(['--freeze=false']).flags.freeze, 'false')
  assert.ok(!isOn('false'))
})

test('a numeric flag is read whole, and a bare, empty or repeated one is not a number', () => {
  assert.equal(flagNumber(undefined, 0.05), 0.05)
  assert.equal(flagNumber('0', 5), 0)
  assert.equal(flagNumber('2.5', 0), 2.5)
  for (const bad of [true, '', '  ', 'abc', ['1', '2']]) assert.ok(Number.isNaN(flagNumber(bad, 0)), String(bad))
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

test('a pairs file can switch one determinism control off for a pair, and says when it is not a boolean', () => {
  const { pairs, problems } = parsePairs([{ name: 'a', a: 'x', b: 'y', freeze: false, settle: true }, { name: 'b', a: 'x', b: 'y' }])
  assert.deepEqual(problems, [])
  assert.deepEqual([pairs[0].freeze, pairs[0].settle, 'reducedMotion' in pairs[0]], [false, true, false])
  assert.ok(!('freeze' in pairs[1]))
  const bad = parsePairs([{ name: 'a', a: 'x', b: 'y', freeze: 'no', reducedMotion: 1 }])
  assert.equal(bad.problems.length, 2)
  assert.ok(bad.problems.some((p) => p.includes('freeze must be true or false')))
  assert.ok(bad.problems.some((p) => p.includes('reducedMotion must be true or false')))
})

test('pair names are compared without case, because the files they write may share a name on disk', () => {
  const { problems } = parsePairs([{ name: 'Hero', a: 'x', b: 'y' }, { name: 'hero', a: 'x', b: 'y' }, { name: 'cards/Dark', a: 'x', b: 'y' }, { name: 'CARDS/dark', a: 'x', b: 'y' }])
  assert.deepEqual(problems, ['pair 2 (hero): name is used twice (names are compared without case)', 'pair 4 (CARDS/dark): name is used twice (names are compared without case)'])
})

test('a pairs file is a bare array or an object that states its format', () => {
  const list = [{ name: 'a', a: 'x', b: 'y' }]
  assert.deepEqual(pairsDocument(list), { list, problems: [] })
  assert.deepEqual(pairsDocument({ format: 1, pairs: list }), { list, format: 1, problems: [] })
  assert.equal(FORMATS_READ.pairs, 1)
  // a newer format is handed back as it is, for the caller to refuse by name
  assert.equal(pairsDocument({ format: 2, pairs: list }).format, 2)
  assert.deepEqual(pairsDocument({ pairs: list }).problems, ['"format" must be a whole number, 1 or more'])
  assert.deepEqual(pairsDocument({ format: 1 }).problems, ['"pairs" must be an array of pairs'])
  assert.deepEqual(pairsDocument({ format: 1, pairs: list, pair: [] }).problems, ['unknown field "pair"'])
  assert.equal(pairsDocument('text').list, null)
  assert.equal(pairsDocument(null).problems.length, 1)
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

test('the freeze style stops animations but leaves transitions to finish, so transitionend still fires', () => {
  assert.ok(FREEZE_CSS.includes('animation-duration:0s'))
  assert.ok(!FREEZE_CSS.includes('transition'))
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

test('a text comparison is deterministic', () => {
  assert.equal(JSON.stringify(compareText('a\nb\nc', 'a\nx\nc')), JSON.stringify(compareText('a\nb\nc', 'a\nx\nc')))
})

test('two long texts that differ in a few lines are aligned, however long they are', () => {
  const lines = Array.from({ length: 2100 }, (_, i) => `line ${i}`)
  const edited = lines.slice()
  edited[0] = 'first line changed'
  edited[2099] = 'last line changed'
  const near = compareText(lines.join('\n'), edited.join('\n'))
  assert.deepEqual([near.removed, near.added, near.changed, near.aligned], [2, 2, 2, true])
  assert.ok(near.percent < 0.1)
  // long texts with an insertion and a change far apart
  const long = Array.from({ length: 20000 }, (_, i) => `row ${i}`)
  const more = long.slice()
  more.splice(9000, 0, 'inserted')
  more[15000] = 'changed'
  const far = compareText(long.join('\n'), more.join('\n'))
  assert.deepEqual([far.removed, far.added, far.aligned], [1, 2, true])
})

test('texts that differ in nearly every line are reported as removed then added, and say they were not aligned', () => {
  const lines = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n')
  const x = compareText(lines('a', 2100), lines('b', 2100))
  assert.deepEqual([x.removed, x.added, x.percent, x.aligned], [2100, 2100, 100, false])
  // pure additions need no alignment, however many
  const grown = compareText('', lines('c', 5000))
  assert.deepEqual([grown.removed, grown.added, grown.aligned], [0, 5000, true])
})

test('the edit script is a shortest one: it rebuilds both texts and changes as few lines as the longest common subsequence allows', () => {
  let seed = 11
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const common = (a, b) => {
    const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    return table[0][0]
  }
  for (let round = 0; round < 400; round++) {
    const alphabet = 1 + Math.floor(next() * 5)
    const make = () => Array.from({ length: Math.floor(next() * 25) }, () => `l${Math.floor(next() * alphabet)}`)
    const a = make()
    const b = make()
    const { ops, aligned } = editScript(a, b)
    assert.deepEqual(ops.filter((o) => o.t !== '+').map((o) => o.s), a)
    assert.deepEqual(ops.filter((o) => o.t !== '-').map((o) => o.s), b)
    const shared = common(a, b)
    assert.equal(ops.filter((o) => o.t === '-').length, a.length - shared)
    assert.equal(ops.filter((o) => o.t === '+').length, b.length - shared)
    assert.ok(aligned)
  }
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
  assert.deepEqual(r.calls[3].arg, { fullPage: false })
  assert.ok(existsSync(join(work, 'plain.png')))
})

test('the determinism flags switch on motion emulation, the freeze style and the settle step', () => {
  const r = shoot(['--url', 'http://x.test/', '--out', join(work, 'still.png'), '--reduced-motion', '--freeze', '--settle', '--playwright', standIn])
  assert.equal(r.status, 0)
  assert.equal(r.calls.find((c) => c.name === 'newContext').arg.reducedMotion, 'reduce')
  assert.ok(r.calls.some((c) => c.name === 'addInitScript'))
  assert.ok(r.calls.some((c) => c.name === 'wake'))
  const names = r.calls.map((c) => c.name)
  assert.ok(names.indexOf('wake') > names.indexOf('goto') && names.indexOf('wake') < names.indexOf('screenshot'))
  // each flag on its own switches on only itself
  const one = shoot(['--url', 'http://x.test/', '--out', join(work, 'one.png'), '--freeze', '--playwright', standIn])
  assert.ok(one.calls.some((c) => c.name === 'addInitScript'))
  assert.ok(!one.calls.some((c) => c.name === 'wake'))
  assert.equal(one.calls.find((c) => c.name === 'newContext').arg.reducedMotion, undefined)
  // a bare flag leaves the next word alone
  const bare = shoot(['--freeze', '--url', 'http://x.test/', '--out', join(work, 'bare.png'), '--playwright', standIn])
  assert.equal(bare.status, 0)
  assert.ok(bare.calls.some((c) => c.name === 'addInitScript'))
})

test('freeze also bypasses the page\'s Content-Security-Policy and has the screenshot finish its animations', () => {
  const frozen = shoot(['--url', 'http://x.test/', '--out', join(work, 'csp.png'), '--freeze', '--playwright', standIn])
  assert.equal(frozen.calls.find((c) => c.name === 'newContext').arg.bypassCSP, true)
  assert.deepEqual(frozen.calls.find((c) => c.name === 'screenshot').arg, { fullPage: false, animations: 'disabled' })
  const element = shoot(['--url', 'http://x.test/', '--out', join(work, 'csp-el.png'), '--freeze', '--selector', '.stage', '--playwright', standIn])
  assert.deepEqual(element.calls.find((c) => c.name === 'screenshot').arg, { animations: 'disabled' })
  // without freeze the context and the screenshot ask for exactly what they did before
  const loose = shoot(['--url', 'http://x.test/', '--out', join(work, 'loose.png'), '--reduced-motion', '--settle', '--playwright', standIn])
  assert.equal('bypassCSP' in loose.calls.find((c) => c.name === 'newContext').arg, false)
  assert.deepEqual(loose.calls.find((c) => c.name === 'screenshot').arg, { fullPage: false })
})

test('settle wakes the frames inside a woken frame too, and waits for every one with a time limit', () => {
  const r = shoot(['--url', 'http://x.test/', '--out', join(work, 'nested.png'), '--settle', '--playwright', standIn], { FAKE_LAZY: '3' })
  assert.equal(r.status, 0, r.stderr)
  const levels = (name) => [...new Set(r.calls.filter((c) => c.name === name).map((c) => c.arg.level))]
  assert.deepEqual(levels('wake'), [0, 1, 2, 3])
  assert.deepEqual(levels('loaded'), [0, 1, 2, 3])
  assert.deepEqual(levels('fonts'), [0, 1, 2, 3])
  assert.ok(r.calls.filter((c) => c.name === 'loaded').every((c) => c.arg.timeout > 0))
  // a page with nothing lazy takes one round, and a frame that did not load in time is named
  const flat = shoot(['--url', 'http://x.test/', '--out', join(work, 'flat.png'), '--settle', '--playwright', standIn])
  assert.equal(flat.calls.filter((c) => c.name === 'wake').length, 1)
  const slow = pairsRun([{ name: 'slow', a: 'http://one.test/', b: 'http://two.test/' }], [], { FAKE_LAZY: '1', FAKE_UNLOADED: '1' })
  assert.equal(slow.status, 1)
  assert.equal(slow.lines[0].ok, false)
  assert.match(slow.lines[0].error, /1 lazy iframe or image did not load within 15 seconds/)
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

test('--pairs --workers runs pairs side by side and prints them in the order given', () => {
  const pairs = [
    { name: 'slow-one', a: 'http://x.test/slow/a', b: 'http://x.test/slow/b', mode: 'dom' },
    { name: 'fast-two', a: 'http://x.test/fast/a', b: 'http://x.test/fast/b', mode: 'dom' },
  ]
  const run = (workers) => pairsRun(pairs, ['--workers', workers], { FAKE_SLOW: '/slow/' })
  const many = run('2')
  assert.equal(many.status, 0, many.stderr)
  assert.deepEqual(many.lines.slice(0, 2).map((l) => l.name), ['slow-one', 'fast-two'])
  assert.equal(many.lines[2].pairs, 2)
  const names = (r) => r.calls.map((c) => (c.name === 'goto' ? `goto ${c.arg.split('/')[3]}` : c.name)).filter((n) => n.startsWith('goto') || n === 'gotoEnd')
  // with two workers the second pair starts its page before the first has finished loading
  assert.ok(names(many).indexOf('goto fast') < names(many).indexOf('gotoEnd'), names(many).join())
  const one = run('1')
  assert.deepEqual(one.lines.slice(0, 2).map((l) => l.name), ['slow-one', 'fast-two'])
  assert.ok(names(one).indexOf('goto fast') > names(one).indexOf('gotoEnd'), names(one).join())
  assert.equal(run('0').status, 2)
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
  for (const c of contexts) assert.deepEqual(c.arg, { viewport: { width: 390, height: 844 }, colorScheme: 'dark', deviceScaleFactor: 1, reducedMotion: 'reduce', bypassCSP: true })
  assert.equal(r.calls.filter((c) => c.name === 'addInitScript').length, 2)
  assert.equal(r.calls.filter((c) => c.name === 'wake').length, 2)
  assert.deepEqual(r.calls.filter((c) => c.name === 'screenshot').map((c) => c.arg), [{ fullPage: true, animations: 'disabled' }, { fullPage: true, animations: 'disabled' }])
  assert.deepEqual(r.calls.filter((c) => c.name === 'goto').map((c) => c.arg), ['http://one.test/pill', 'http://two.test/pill'])
})

test('--pairs lets the flags or a pair switch a control off', () => {
  const pair = { name: 'free', a: 'http://one.test/', b: 'http://two.test/' }
  const byFlag = pairsRun([pair], ['--freeze=false'])
  assert.equal(byFlag.calls.filter((c) => c.name === 'addInitScript').length, 0)
  assert.equal(byFlag.calls.filter((c) => c.name === 'wake').length, 2)
  assert.deepEqual(byFlag.calls.filter((c) => c.name === 'screenshot').map((c) => c.arg), [{ fullPage: false }, { fullPage: false }])
  const byPair = pairsRun([{ ...pair, settle: false, reducedMotion: false }])
  assert.equal(byPair.calls.filter((c) => c.name === 'wake').length, 0)
  assert.equal(byPair.calls.filter((c) => c.name === 'addInitScript').length, 2)
  assert.equal(byPair.calls.find((c) => c.name === 'newContext').arg.reducedMotion, undefined)
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

test('--pairs in dom mode: a selector that matches nothing fails the pair instead of comparing the whole page', () => {
  const pair = [{ name: 'typo', mode: 'dom', a: 'http://one.test/', b: 'http://two.test/', selector: '.no-such-thing' }]
  const r = pairsRun(pair, [], { FAKE_NO_MATCH: '1' })
  assert.equal(r.status, 1)
  assert.equal(r.lines[0].ok, false)
  assert.equal(r.lines[0].error, 'selector matched nothing: .no-such-thing')
  assert.ok(!r.calls.some((c) => c.name === 'ariaSnapshot') && !existsSync(join(r.out, 'typo.a.txt')))
  // the wait for the selector is short, never Playwright's thirty seconds
  assert.ok(r.calls.find((c) => c.name === 'waitFor').arg.timeout <= 10000)
  assert.equal(r.lines[1].failed, 1)
})

test('--pairs in dom mode: a snapshot that fails is an error, not the whole page\'s HTML', () => {
  const r = pairsRun([{ name: 'broken', mode: 'dom', a: 'http://one.test/', b: 'http://two.test/' }], [], { FAKE_ARIA_FAIL: '1' })
  assert.equal(r.status, 1)
  assert.match(r.lines[0].error, /ariaSnapshot/)
  assert.ok(!existsSync(join(r.out, 'broken.a.txt')))
  // the --dom flag keeps its fallback to the page's HTML
  const flag = shoot(['--url', 'http://x.test/', '--out', join(work, 'flag.png'), '--dom', join(work, 'flag.txt'), '--playwright', standIn], { FAKE_ARIA_FAIL: '1' })
  assert.equal(flag.status, 0)
  assert.equal(readFileSync(join(work, 'flag.txt'), 'utf8'), '<html></html>')
})

test('--pairs in dom mode on a Playwright without accessibility snapshots reads the selector\'s own HTML', () => {
  const pair = (selector) => [{ name: 'old', mode: 'dom', a: 'http://one.test/', b: 'http://two.test/', ...(selector ? { selector } : {}) }]
  const scoped = pairsRun(pair('main'), [], { FAKE_NO_ARIA: '1' })
  assert.equal(scoped.status, 0)
  assert.equal(readFileSync(join(scoped.out, 'old.a.txt'), 'utf8'), '<main data-from="main"></main>')
  const whole = pairsRun(pair(), [], { FAKE_NO_ARIA: '1' })
  assert.equal(readFileSync(join(whole.out, 'old.a.txt'), 'utf8'), '<html></html>')
})

test('--pairs in dom mode says when the texts were too different to line up', () => {
  const lines = (tag) => Array.from({ length: 2100 }, (_, i) => `${tag} ${i}`).join('\n')
  writeFileSync(join(work, 'wide-a.txt'), lines('a'))
  writeFileSync(join(work, 'wide-b.txt'), lines('b'))
  const wide = pairsRun([{ name: 'wide', mode: 'dom', a: join(work, 'wide-a.txt'), b: join(work, 'wide-b.txt') }])
  assert.equal(wide.lines[0].aligned, false)
  assert.equal(wide.lines[0].percent, 100)
  const same = pairsRun([{ name: 'same', mode: 'dom', a: join(work, 'wide-a.txt'), b: join(work, 'wide-a.txt') }])
  assert.ok(!('aligned' in same.lines[0]))
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

test('--pairs refuses a bad file before any browser starts, with exit 2', () => {
  const r = pairsRun([{ name: 'a', a: 'x.png' }, { name: 'a', a: 'x', b: 'y', mode: 'both' }])
  assert.equal(r.status, 2)
  assert.deepEqual(r.calls, [])
  assert.ok(r.stderr.includes('b must be a URL or a file path'))
  assert.ok(r.stderr.includes('name is used twice'))
  assert.ok(r.stderr.includes('mode must be'))
  const noOut = spawnSync(process.execPath, [join(SCRIPTS, 'shoot.mjs'), '--pairs', join(work, 'x.json'), '--root', work], { encoding: 'utf8' })
  assert.equal(noOut.status, 2)
  assert.ok(noOut.stderr.includes('usage: shoot.mjs --pairs'))
  const missing = shoot(['--pairs', join(work, 'not-there.json'), '--out', join(work, 'o'), '--playwright', standIn])
  assert.equal(missing.status, 2)
  assert.ok(missing.stderr.includes('no such pairs file'))
  const broken = join(work, 'broken.json')
  writeFileSync(broken, '[{')
  const bad = shoot(['--pairs', broken, '--out', join(work, 'o'), '--playwright', standIn])
  assert.equal(bad.status, 2)
  assert.ok(bad.stderr.includes('is not valid JSON'))
  assert.equal(pairsRun([{ name: 'n', a: 'a.png', b: 'b.png' }], ['--max-diff', '-1']).status, 2)
})

test('--pairs tells a broken file (2) from a pair over the limit (1) and from no Playwright (3)', () => {
  writeFileSync(join(work, 'e1.png'), png(2, 2))
  writeFileSync(join(work, 'e2.png'), png(2, 2))
  const pairs = [{ name: 'e', a: join(work, 'e1.png'), b: join(work, 'e2.png') }]
  assert.equal(pairsRun(pairs).status, 0)
  assert.equal(pairsRun(pairs, [], { FAKE_CHANGED: '1' }).status, 1)
  assert.equal(pairsRun([{ name: 'e', a: join(work, 'e1.png'), b: join(work, 'e2.png'), colour: 'dark' }]).status, 2)
  assert.equal(shoot(['--pairs', join(work, 'x.json'), '--out', join(work, 'o'), '--playwright', join(base, 'nowhere')]).status, 2)
  const file = join(work, 'e-pairs.json')
  writeFileSync(file, JSON.stringify(pairs))
  assert.equal(shoot(['--pairs', file, '--out', join(work, 'o'), '--playwright', join(base, 'nowhere')]).status, 3)
})

test('--max-diff and --threshold must be numbers in range, so a typo cannot let every pair pass', () => {
  writeFileSync(join(work, 'th1.png'), png(2, 2))
  writeFileSync(join(work, 'th2.png'), png(2, 2))
  const pairs = [{ name: 'th', a: join(work, 'th1.png'), b: join(work, 'th2.png') }]
  const refused = (flag, message) => {
    const r = pairsRun(pairs, flag, { FAKE_CHANGED: '4' })
    assert.equal(r.status, 2, flag.join(' '))
    assert.match(r.stderr, message, flag.join(' '))
    assert.deepEqual(r.calls, [], flag.join(' '))
  }
  // a threshold of 1 or more would count no pixel as changed
  for (const bad of [['--threshold'], ['--threshold', '1'], ['--threshold', '5'], ['--threshold', '-0.1'], ['--threshold', 'abc'], ['--threshold='], ['--threshold', '0.1', '--threshold', '0.2']]) {
    refused(bad, /--threshold is a fraction from 0 up to, but not including, 1/)
  }
  for (const bad of [['--max-diff'], ['--max-diff', '101'], ['--max-diff', 'abc'], ['--max-diff=']]) refused(bad, /--max-diff is a percentage from 0 to 100/)
  assert.equal(pairsRun(pairs, ['--threshold', '0.2'], { FAKE_CHANGED: '4' }).status, 1)
  assert.equal(pairsRun(pairs, ['--threshold=0', '--max-diff', '100'], { FAKE_CHANGED: '4' }).status, 0)
  assert.equal(pairsRun(pairs, ['--max-diff', '0.5'], { FAKE_CHANGED: '0' }).status, 0)
})

test('the threshold given to --pairs reaches the diff, and --diff keeps reading its own', () => {
  writeFileSync(join(work, 'tt1.png'), png(2, 2))
  writeFileSync(join(work, 'tt2.png'), png(2, 2))
  const r = pairsRun([{ name: 'tt', a: join(work, 'tt1.png'), b: join(work, 'tt2.png') }], ['--threshold', '0.2'])
  assert.equal(r.calls.find((c) => c.name === 'diff').arg.threshold, 0.2)
  const diff = shoot(['--diff', join(work, 'tt1.png'), join(work, 'tt2.png'), '--out', join(work, 'tt.png'), '--threshold', '2', '--playwright', standIn])
  assert.equal(diff.status, 0)
  assert.equal(diff.calls.find((c) => c.name === 'diff').arg.threshold, 2)
})

test('a pairs file may be an object that states its format, and a newer format is refused by name with exit 2', () => {
  writeFileSync(join(work, 'f1.png'), png(2, 2))
  const pairs = [{ name: 'f', a: join(work, 'f1.png'), b: join(work, 'f1.png') }]
  const wrapped = (doc) => {
    const file = join(work, `wrapped-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(file, JSON.stringify(doc))
    return shoot(['--pairs', file, '--out', join(work, 'o-wrapped'), '--playwright', standIn])
  }
  const ok = wrapped({ format: 1, pairs })
  assert.equal(ok.status, 0)
  assert.equal(ok.lines[0].name, 'f')
  const newer = wrapped({ format: 2, pairs, extra: true })
  assert.equal(newer.status, 2)
  assert.match(newer.stderr, /wrapped-\S+\.json is format 2, and these scripts \(\S+\) read up to 1: update massimo/)
  assert.deepEqual(newer.calls, [])
  const unmarked = wrapped({ pairs })
  assert.equal(unmarked.status, 2)
  assert.match(unmarked.stderr, /"format" must be a whole number/)
  const typo = wrapped({ format: 1, pair: pairs })
  assert.equal(typo.status, 2)
  assert.match(typo.stderr, /unknown field "pair"/)
})

test('--playwright needs exactly one path', () => {
  for (const args of [['--playwright'], ['--playwright='], ['--playwright', standIn, '--playwright', standIn]]) {
    const r = shoot(['--url', 'http://x.test/', '--out', join(work, 'pw.png'), ...args])
    assert.equal(r.status, 2, args.join(' '))
    assert.match(r.stderr, /--playwright takes one path/)
    assert.deepEqual(r.calls, [])
  }
})

// ── The render sweep ────────────────────────────────────────────────────────

const META = { about: { generator: 'ladle' }, stories: { 'a--one': {}, 'b--two': {}, 'c--three': {}, 'd--four': {} } }
const metaFile = join(work, 'ids.json')
writeFileSync(metaFile, JSON.stringify(META))
let server
let site
before(async () => {
  server = await startServer()
  site = server.url
})
after(() => server?.stop())
const sweep = (args, env = {}) => shoot(['--sweep', `${site}/`, ...args, '--playwright', standIn], env)

test('the sweep reads its flags whole, and the pairs format is still 1', () => {
  assert.equal(FORMATS_READ.pairs, 1)
  const ok = sweepOptions({ sweep: 'http://localhost:4650/', legacy: true })
  assert.deepEqual(ok.problems, [])
  assert.deepEqual(ok.options, { base: 'http://localhost:4650', workers: 4, timeout: 15, ready: SWEEP_READY, settleMs: 500, legacy: true })
  assert.equal(SWEEP_READY, 'html[data-story-ready]')
  const flags = { sweep: 'http://x.test', workers: '2', timeout: '3.5', ready: '#root > div', 'settle-ms': '0' }
  assert.deepEqual(sweepOptions(flags).options, { base: 'http://x.test', workers: 2, timeout: 3.5, ready: '#root > div', settleMs: 0, legacy: false })
  for (const bad of [{ sweep: true }, { sweep: 'x.test' }, { sweep: 'http://x.test', workers: '0' }, { sweep: 'http://x.test', workers: 'many' }, { sweep: 'http://x.test', timeout: '-1' }, { sweep: 'http://x.test', ready: true }, { sweep: 'http://x.test', 'settle-ms': '-1' }, { sweep: 'http://x.test', 'settle-ms': '1.5' }]) {
    assert.ok(sweepOptions(bad).problems.length > 0, JSON.stringify(bad))
  }
})

test('a state fails when html[data-story-error] is set after it was ready, and the settle wait is --settle-ms', () => {
  const r = sweep(['--legacy', '--ids-from', metaFile, '--settle-ms', '40'], { FAKE_SWEEP_FAILED: 'b--two' })
  assert.equal(r.status, 1)
  assert.equal(r.lines[0].ready, 3)
  assert.deepEqual(r.lines[0].failed, [{ id: 'b--two', why: 'html[data-story-error] is set: the state failed after it was ready' }])
  const waits = r.calls.filter((c) => c.name === 'sweepSettle').map((c) => c.arg)
  assert.deepEqual(waits, [40, 40, 40, 40])
  // the default, and a page that never sets the attribute (a Ladle page)
  const plain = sweep(['--legacy', '--ids-from', metaFile])
  assert.equal(plain.status, 0)
  assert.deepEqual([...new Set(plain.calls.filter((c) => c.name === 'sweepSettle').map((c) => c.arg))], [500])
  assert.equal(sweep(['--legacy', '--ids-from', metaFile, '--settle-ms', 'x']).status, 2)
})

test('the csf recipe never marks a state ready and failed at once, and keeps its shell code within 100 columns', () => {
  const recipe = readFileSync(join(SCRIPTS, '..', 'skills', 'stories', 'recipes', 'vite-csf.md'), 'utf8')
  const section = (name) => recipe.split(/^## /m).find((part) => part.startsWith(name))
  const canvas = section('src/stories/Canvas.tsx')
  assert.match(canvas, /function Failed[\s\S]*?removeAttribute\('data-story-ready'\)[\s\S]*?setAttribute\('data-story-error'/)
  assert.match(canvas, /function Ready[\s\S]*?hasAttribute\('data-story-error'\)/)
  const long = section('src/stories/Shell.tsx').split('\n').filter((l) => l.length > 100)
  assert.deepEqual(long, [])
  assert.match(recipe, /only one frame of a page holds focus/)
})

test('ids come from the stories keys of a Ladle-shaped meta.json, and a state loads where the flags say', () => {
  assert.deepEqual(idsOfMeta(META), ['a--one', 'b--two', 'c--three', 'd--four'])
  assert.deepEqual(idsOfMeta({}), [])
  assert.deepEqual(idsOfMeta(null), [])
  assert.equal(sweepUrl('http://x.test', 'a b--c', { legacy: true }), 'http://x.test/?story=a%20b--c&mode=preview')
  assert.equal(sweepUrl('http://x.test', 'a--one', { routes: { 'a--one': '/stories/a/one?mode=preview' } }), 'http://x.test/stories/a/one?mode=preview')
  assert.equal(sweepUrl('http://x.test', 'a--one', { routes: {} }), null)
})

test('a baseline excuses only what it also failed, and only when it reached 98% ready', () => {
  const verdicts = [{ id: 'a', ok: true }, { id: 'b', ok: false, why: 'x' }, { id: 'c', ok: false, why: 'y' }]
  const plain = sweepResult('http://x.test', verdicts)
  assert.deepEqual(plain, { base: 'http://x.test', total: 3, ready: 1, failed: [{ id: 'b', why: 'x' }, { id: 'c', why: 'y' }], excused: [] })
  const good = { total: 200, ready: 199, failed: [{ id: 'b', why: 'old' }] }
  const excused = sweepResult('http://x.test', verdicts, good)
  assert.deepEqual(excused.failed, [{ id: 'c', why: 'y' }])
  assert.deepEqual(excused.excused, [{ id: 'b', why: 'x' }])
  assert.equal(excused.ready, 1)
  assert.equal(excused.baseline.excusing, true)
  // the floor itself counts; one state below it does not
  assert.equal(sweepResult('u', verdicts, { total: 100, ready: 98, failed: [{ id: 'b' }] }).excused.length, 1)
  const low = sweepResult('u', verdicts, { total: 100, ready: 97, failed: [{ id: 'b' }] })
  assert.equal(low.excused.length, 0)
  assert.equal(low.failed.length, 2)
  assert.match(low.baseline.note, /97% ready, below 98%, so nothing is excused/)
  assert.equal(SWEEP_FLOOR, 0.98)
  // a baseline that holds nothing excuses nothing
  assert.equal(sweepResult('u', verdicts, { total: 0, ready: 0, failed: [] }).failed.length, 2)
  // what an earlier sweep excused had failed there too
  assert.equal(sweepResult('u', verdicts, { total: 100, ready: 99, failed: [], excused: [{ id: 'b' }] }).excused.length, 1)
})

test('--sweep --legacy opens every id from --ids-from in a fresh context, as Ladle serves it', () => {
  const r = sweep(['--legacy', '--ids-from', metaFile])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.lines, [{ base: site, total: 4, ready: 4, failed: [], excused: [] }])
  assert.deepEqual(r.calls.filter((c) => c.name === 'goto').map((c) => c.arg).sort(), ['a--one', 'b--two', 'c--three', 'd--four'].map((id) => `${site}/?story=${id}&mode=preview`))
  assert.equal(r.calls.filter((c) => c.name === 'newContext').length, 4)
  assert.equal(r.calls.filter((c) => c.name === 'contextClose').length, 4)
  assert.ok(r.calls.filter((c) => c.name === 'waitForSelector').every((c) => c.arg.selector === SWEEP_READY && c.arg.state === 'attached'))
})

test('--ready replaces the selector, and --routes names the ids and where each loads', () => {
  const routes = join(work, 'routes.json')
  writeFileSync(routes, JSON.stringify({ 'a--one': '/stories/a/one?mode=preview', 'b--two': '/stories/b/two?mode=preview' }))
  const r = sweep(['--routes', routes, '--ready', '#root > .done', '--workers', '1'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.lines[0].total, 2)
  assert.deepEqual(r.calls.filter((c) => c.name === 'goto').map((c) => c.arg), [`${site}/stories/a/one?mode=preview`, `${site}/stories/b/two?mode=preview`])
  assert.ok(r.calls.filter((c) => c.name === 'waitForSelector').every((c) => c.arg.selector === '#root > .done'))
  // an id with no route fails and says so
  const some = sweep(['--routes', routes, '--ids-from', metaFile])
  assert.equal(some.status, 1)
  assert.deepEqual(some.lines[0].failed.map((f) => f.id), ['c--three', 'd--four'])
  assert.equal(some.lines[0].failed[0].why, 'no route for this id')
})

test('a state fails when nothing matches, the match is empty, or a page error fires; the rest still run', () => {
  const r = sweep(['--legacy', '--ids-from', metaFile, '--timeout', '2'], { FAKE_SWEEP_NOMATCH: 'b--two', FAKE_SWEEP_EMPTY: 'c--three', FAKE_SWEEP_ERROR: 'd--four' })
  assert.equal(r.status, 1)
  const out = r.lines[0]
  assert.equal(out.total, 4)
  assert.equal(out.ready, 1)
  const why = Object.fromEntries(out.failed.map((f) => [f.id, f.why]))
  assert.match(why['b--two'], /html\[data-story-ready\] did not match within 2 seconds/)
  assert.match(why['c--three'], /matched but holds no element/)
  assert.match(why['d--four'], /^page error: boom/)
})

test('--sweep-baseline excuses what the baseline failed too, prints it, and excuses nothing below the floor', () => {
  const env = { FAKE_SWEEP_NOMATCH: 'b--two,c--three' }
  const baseline = (ready, failed) => {
    const file = join(work, `baseline-${ready}.json`)
    writeFileSync(file, JSON.stringify({ base: 'http://old.test', total: 100, ready, failed: failed.map((id) => ({ id, why: 'old' })) }))
    return file
  }
  const good = sweep(['--legacy', '--ids-from', metaFile, '--sweep-baseline', baseline(99, ['b--two'])], env)
  assert.equal(good.status, 1)
  assert.deepEqual(good.lines[0].failed.map((f) => f.id), ['c--three'])
  assert.deepEqual(good.lines[0].excused.map((f) => f.id), ['b--two'])
  assert.equal(good.lines[0].ready, 2)
  const all = sweep(['--legacy', '--ids-from', metaFile, '--sweep-baseline', baseline(99, ['b--two', 'c--three'])], env)
  assert.equal(all.status, 0)
  assert.deepEqual(all.lines[0].excused.map((f) => f.id), ['b--two', 'c--three'])
  const low = sweep(['--legacy', '--ids-from', metaFile, '--sweep-baseline', baseline(90, ['b--two', 'c--three'])], env)
  assert.equal(low.status, 1)
  assert.equal(low.lines[0].failed.length, 2)
  assert.deepEqual(low.lines[0].excused, [])
  assert.match(low.lines[0].baseline.note, /nothing is excused/)
})

// A document as the browser would hold it, for the check that runs in the page.
const dom = (mountChildren, { marker = 'html' } = {}) => {
  const node = (tagName, children = []) => ({ tagName, children, childElementCount: children.length })
  const mount = node('DIV', mountChildren.map((t) => node(t)))
  const body = node('BODY', [node('SCRIPT'), mount])
  const html = node('HTML', [node('HEAD'), body])
  return { documentElement: html, body, querySelector: (sel) => (sel === 'none' ? null : marker === 'html' ? html : mount) }
}

test('a root marker counts as ready only when the story\'s mount holds an element', () => {
  const had = globalThis.document
  try {
    globalThis.document = dom([])
    assert.equal(SWEEP_FILLED('html[data-story-ready]'), false, 'an empty mount under <html>')
    assert.equal(SWEEP_FILLED('none'), false)
    globalThis.document = dom(['MAIN'])
    assert.equal(SWEEP_FILLED('html[data-story-ready]'), true)
    // a wrapper selector asks of the wrapper itself
    globalThis.document = dom([], { marker: 'mount' })
    assert.equal(SWEEP_FILLED('#root'), false)
    globalThis.document = dom(['MAIN'], { marker: 'mount' })
    assert.equal(SWEEP_FILLED('#root'), true)
  } finally {
    globalThis.document = had
  }
})

test('--sweep refuses a lane list in a newer format, and a server that answers nothing, before a browser starts', () => {
  const newer = join(work, 'newer-meta.json')
  writeFileSync(newer, JSON.stringify({ about: { generator: 'massimo', format: 2 }, stories: { 'a--one': {} } }))
  const r = sweep(['--legacy', '--ids-from', newer])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /newer-meta\.json is format 2/)
  assert.match(r.stderr, /update massimo/i)
  assert.deepEqual(r.calls, [])
  // Ladle's own list has no format to refuse
  writeFileSync(newer, JSON.stringify({ about: { generator: 'ladle', format: 9 }, stories: { 'a--one': {} } }))
  assert.equal(sweep(['--legacy', '--ids-from', newer]).status, 0)
  const down = shoot(['--sweep', 'http://127.0.0.1:1', '--legacy', '--ids-from', metaFile, '--playwright', standIn])
  assert.equal(down.status, 2)
  assert.match(down.stderr, /no server answers at http:\/\/127\.0\.0\.1:1/)
  assert.deepEqual(down.calls, [])
})

test('--sweep refuses a bad call with exit 2 before a browser starts', () => {
  const cases = [
    [['--ids-from', metaFile], /needs --legacy .* or --routes/],
    [['--legacy', '--ids-from', join(work, 'missing.json')], /no such file/],
    [['--legacy', '--ids-from', metaFile, '--workers', '0'], /--workers is a whole number/],
    [['--legacy', '--ids-from', metaFile, '--timeout', 'soon'], /--timeout is a number of seconds/],
    [['--legacy', '--ids-from', metaFile, '--sweep-baseline', join(work, 'nope.json')], /no such file/],
  ]
  for (const [args, message] of cases) {
    const r = sweep(args)
    assert.equal(r.status, 2, args.join(' '))
    assert.match(r.stderr, message)
    assert.deepEqual(r.calls, [])
  }
  const bare = shoot(['--sweep', '--legacy', '--playwright', standIn])
  assert.equal(bare.status, 2)
  assert.match(bare.stderr, /--sweep takes the base URL/)
})
