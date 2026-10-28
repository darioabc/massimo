import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compileGlobs, expandGlobs, globToRegExp, walk } from '../scripts/lib/glob.mjs'

const match = (glob, path) => globToRegExp(glob).test(path)

test('globToRegExp: ** crosses directories, * does not', () => {
  assert.ok(match('src/**/*.tsx', 'src/a/b/c.tsx'))
  assert.ok(match('src/**/*.tsx', 'src/c.tsx'))
  assert.ok(!match('src/*.tsx', 'src/a/c.tsx'))
  assert.ok(match('**/*.test.*', 'a.test.ts'))
  assert.ok(match('**/*.test.*', 'x/y/a.test.tsx'))
  assert.ok(match('src/**', 'src/a/b'))
  assert.ok(!match('src/*.css', 'src/a/b.css'))
})

test('globToRegExp: ?, braces and classes', () => {
  assert.ok(match('a?c', 'abc'))
  assert.ok(!match('a?c', 'a/c'))
  assert.ok(match('src/**/*.{ts,tsx}', 'src/a/b.tsx'))
  assert.ok(!match('src/**/*.{ts,tsx}', 'src/a/b.js'))
  assert.ok(match('{a,b/**}/x.css', 'b/c/d/x.css'))
  assert.ok(match('[abc].js', 'b.js'))
  assert.ok(!match('[!abc].js', 'b.js'))
  assert.ok(match('[!abc].js', 'z.js'))
})

test('globToRegExp: regex characters in a glob are literal', () => {
  assert.ok(match('src/a.b/(x).css', 'src/a.b/(x).css'))
  assert.ok(!match('src/a.b.css', 'src/axb.css'))
  assert.ok(match('./src/*.css', 'src/a.css'))
})

test('walk skips ignored directories, node_modules and nested git checkouts', () => {
  const root = mkdtempSync(join(tmpdir(), 'massimo-glob-'))
  try {
    for (const f of ['src/a.ts', 'src/deep/b.ts', 'dist/out.js', 'node_modules/p/i.js', 'wt/.git', 'wt/src/c.ts', 'top.css']) {
      mkdirSync(join(root, f, '..'), { recursive: true })
      writeFileSync(join(root, f), '')
    }
    assert.deepEqual(walk(root, { ignore: ['dist'] }), ['src/a.ts', 'src/deep/b.ts', 'top.css'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('expandGlobs returns sorted paths with excludes applied', () => {
  const root = mkdtempSync(join(tmpdir(), 'massimo-glob-'))
  try {
    for (const f of ['src/b.tsx', 'src/a.tsx', 'src/a.test.tsx', 'src/z.css']) {
      mkdirSync(join(root, f, '..'), { recursive: true })
      writeFileSync(join(root, f), '')
    }
    assert.deepEqual(expandGlobs(root, ['src/**/*.tsx'], ['**/*.test.*']), ['src/a.tsx', 'src/b.tsx'])
    assert.equal(compileGlobs([])('x'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
