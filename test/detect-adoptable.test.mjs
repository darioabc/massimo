// detect.mjs says when a repo has something to adopt, in a short list the
// start skill reads, and says nothing new for a repo with nothing to adopt.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { SCRIPTS, scratch } from './helpers.mjs'

const detect = (root) => JSON.parse(spawnSync(process.execPath, [join(SCRIPTS, 'detect.mjs'), '--root', root], { encoding: 'utf8' }).stdout)
const legacy = scratch('legacy')
after(() => legacy.cleanup())

// The fields detect reported before adopt existed, in order.
const FIELDS = ['root', 'name', 'existingProject', 'framework', 'packageManager', 'typescript', 'styling', 'storyTools', 'playwright', 'monorepo', 'scripts', 'devPort', 'componentDirs', 'nestedPackages', 'styleFiles', 'aliases', 'suggestedConfig']

test('a repo with its own setup: the lane, the extra header keys, its graph, ratchet, token list and DESIGN.md', () => {
  const out = detect(legacy.root)
  assert.deepEqual(Object.keys(out), [...FIELDS, 'adoptable'])
  assert.deepEqual(out.adoptable, [
    { kind: 'lane', paths: ['src/stories'], note: 'a gated story lane with a manifest' },
    { kind: 'headers', paths: [], note: 'ds: keys beyond the built-in ones: theme (3), inputs (2), styles (2), breakpoint (1), owner (1)' },
    { kind: 'graph', paths: ['docs/system/graph.md'], note: 'a generated graph, 4 node headings' },
    { kind: 'ratchet', paths: ['docs/system/ratchet.json'], note: 'a ratchet, 3 rules' },
    { kind: 'tokens', paths: ['docs/system/tokens.json'], note: "the repo's own token file, 3 tokens" },
    { kind: 'design-md', paths: ['DESIGN.md'], note: 'a DESIGN.md' },
  ])
})

test('a repo with nothing to adopt gets the report it always got', () => {
  const root = mkdtempSync(join(tmpdir(), 'massimo-detect-'))
  try {
    const files = {
      'package.json': '{"dependencies":{"react":"18","vite":"5"}}',
      'src/components/Button.tsx': '// ds:group Primitives / Actions\n// ds:use-when a reader acts\nexport const Button = () => null\n',
      'src/styles/app.css': ':root { --a: 1px; --b: 2px; --c: 3px; --d: 4px; --e: 5px; }\n',
      'docs/notes.md': '# Notes\n\n### One\n### Two\n### Three\n',
    }
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(root, f, '..'), { recursive: true })
      writeFileSync(join(root, f), body)
    }
    assert.deepEqual(Object.keys(detect(root)), FIELDS)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
