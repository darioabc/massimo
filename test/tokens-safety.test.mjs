// A token set reaches stylesheets, <style> blocks, HTML attributes and JS, so
// names and values are checked before anything is written, every problem is
// reported in one run, and what is written is escaped for where it lands.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { read, run, withTokens } from './helpers.mjs'

function built(doc, check) {
  const t = withTokens(doc)
  try {
    check(run('tokens', t, ['build']), t)
  } finally {
    t.cleanup()
  }
}

test('every problem is reported in one run, each with its token path', () => {
  built(
    {
      color: {
        $type: 'color',
        a: { $value: '{color.nope}' },
        b: { $value: 'red; } body { display: none' },
        c: { $value: '#fff', $extensions: { massimo: { cssVar: 'not a var', on: 'color.zzz' } } },
      },
    },
    (r, t) => {
      assert.equal(r.status, 1)
      assert.match(r.stderr, /4 problems in the tokens/)
      assert.match(r.stderr, /error: color\.a: alias \{color\.nope\} points at a token that does not exist/)
      assert.match(r.stderr, /error: color\.b: "red; \} body \{ display: none" has a character a CSS value cannot hold here/)
      assert.match(r.stderr, /error: color\.c: \$extensions\.massimo\.cssVar "not a var" is not a CSS custom property name/)
      assert.match(r.stderr, /error: color\.c: "on" points at color\.zzz/)
      assert.ok(!existsSync(join(t.root, 'src', 'styles', 'tokens.generated.css')))
    },
  )
})

test('names: no {, } or . in a name, and no token that is also a group', () => {
  built({ color: { $type: 'color', 'a.b': { $value: '#111111' }, c: { $value: '#222222', d: { $value: '#333333' } } } }, (r) => {
    assert.equal(r.status, 1)
    assert.match(r.stderr, /error: color\.a\.b: a token or group name cannot contain \{, \} or \./)
    assert.match(r.stderr, /error: color\.c: has a \$value and child tokens \(d\)/)
  })
})

test('unsafe strings are caught inside composites and font lists too', () => {
  built(
    {
      font: { body: { $type: 'fontFamily', $value: ['Inter', 'x</style><script>'] } },
      shadow: { $type: 'shadow', a: { $value: { color: 'rgb(0 0 0 / 0.1', offsetX: '0px', offsetY: '1px', blur: '2px', spread: '0px' } } },
      text: { $type: 'dimension', q: { $value: "1rem 'open" } },
    },
    (r) => {
      assert.equal(r.status, 1)
      assert.match(r.stderr, /font\.body: \[1\] "x<\/style><script>" has a character/)
      assert.match(r.stderr, /shadow\.a: color "rgb\(0 0 0 \/ 0\.1" has a \( that is never closed/)
      assert.match(r.stderr, /text\.q: "1rem 'open" has a quote that is never closed/)
    },
  )
})

test('odd names become safe CSS variables, and group comments cannot close early', () => {
  built({ 'a*/b': { $type: 'color', 'Button background': { $value: '#123456' } } }, (r, t) => {
    assert.equal(r.status, 0, r.stderr)
    const css = read(t.root, 'src', 'styles', 'tokens.generated.css')
    assert.match(css, /\/\* a\* \/b \*\//)
    assert.match(css, /--a-b-Button-background: #123456;/)
  })
})

test('JS outputs escape keys and values; family names are quoted and escaped', () => {
  built({ color: { $type: 'color', "it's": { $value: '#123456' } }, font: { odd: { $type: 'fontFamily', $value: ['Font "X"', 'system-ui'] } } }, (r, t) => {
    assert.equal(r.status, 0, r.stderr)
    const tw3 = read(t.root, 'src', 'styles', 'tokens.tailwind.cjs')
    const exported = new Function('module', `${tw3}; return module.exports`)({ exports: {} })
    assert.equal(exported.colors["it's"], 'var(--color-it-s)')
    assert.match(read(t.root, 'src', 'styles', 'tokens.ts'), /'it\\'s': 'var\(--color-it-s\)'/)
    assert.match(read(t.root, 'src', 'styles', 'tokens.generated.css'), /--font-odd: "Font \\"X\\"", system-ui;/)
  })
})

test('a dash pattern warns that CSS uses dashed, and still builds', () => {
  built({ stroke: { a: { $type: 'strokeStyle', $value: { dashArray: [{ value: 2, unit: 'px' }], lineCap: 'round' } } } }, (r) => {
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /warn: stroke\.a: CSS has no dash pattern for borders, so the CSS outputs use dashed/)
  })
})

test('invalid JSON names the file', () => {
  const t = withTokens({})
  try {
    writeFileSync(join(t.root, 'design-system', 'tokens', 'tokens.json'), '{ "color": ')
    const r = run('tokens', t, ['build'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /design-system\/tokens\/tokens\.json is not valid JSON/)
  } finally {
    t.cleanup()
  }
})

test('hash is canonical, and check reports a Figma mirror recorded from other tokens', () => {
  const doc = { color: { $type: 'color', a: { $value: '#111111' } } }
  const t = withTokens(doc)
  try {
    const hash = run('tokens', t, ['hash']).stdout.trim()
    assert.match(hash, /^[0-9a-f]{64}$/)
    // Reformatting the file is not drift.
    writeFileSync(join(t.root, 'design-system', 'tokens', 'tokens.json'), JSON.stringify(doc, null, 4))
    assert.equal(run('tokens', t, ['hash']).stdout.trim(), hash)
    assert.equal(run('tokens', t, ['build']).status, 0)
    mkdirSync(join(t.project, 'figma'), { recursive: true })
    writeFileSync(join(t.project, 'figma', 'mirror.json'), JSON.stringify({ syncedAt: '2026-10-28', tokensHash: hash }))
    assert.match(run('tokens', t, ['check']).stdout, /figma mirror current/)
    writeFileSync(join(t.root, 'design-system', 'tokens', 'tokens.json'), JSON.stringify({ color: { $type: 'color', a: { $value: '#222222' } } }))
    assert.equal(run('tokens', t, ['build']).status, 0)
    const r = run('tokens', t, ['check'])
    assert.equal(r.status, 0) // drift is reported, not failed on
    assert.match(r.stdout, /figma mirror behind/)
    assert.match(r.stderr, /figma: the mirror was synced on 2026-10-28 from other tokens/)
  } finally {
    t.cleanup()
  }
})

test('the preview never lets a kit close its <style> block', () => {
  built({ color: { $type: 'color', a: { $value: '#111111' } } }, (r, t) => {
    assert.equal(r.status, 0)
    assert.equal(run('tokens', t, ['preview']).status, 0)
    const html = read(t.project, 'tokens', 'preview.html')
    assert.equal(html.match(/<\/style>/g).length, 1)
  })
})
