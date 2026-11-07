// Shared test plumbing: copy a fixture repo into a scratch directory (so builds
// never dirty the committed fixtures) and run a massimo script as a child process.

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const SCRIPTS = join(here, '..', 'scripts')
export const FIXTURES = join(here, 'fixtures')

function copyDir(from, to) {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    const src = join(from, name)
    if (statSync(src).isDirectory()) copyDir(src, join(to, name))
    else copyFileSync(src, join(to, name))
  }
}

// A scratch copy of a fixture; returns { root, project, cleanup }.
export function scratch(fixture = 'app') {
  const base = mkdtempSync(join(tmpdir(), 'massimo-test-'))
  const root = join(base, 'repo')
  copyDir(join(FIXTURES, fixture), root)
  return { root, project: join(base, 'project'), cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

// Run `scripts/<name>.mjs` against a scratch repo.
export function run(name, ctx, args = []) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, `${name}.mjs`), ...args, '--root', ctx.root, '--project-dir', ctx.project], {
    encoding: 'utf8',
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

export const read = (...parts) => readFileSync(join(...parts), 'utf8')
export const readJson = (...parts) => JSON.parse(read(...parts))

// Compare `text` with the golden file test/golden/<name>. Run the tests with
// UPDATE_GOLDEN=1 to write the golden files from what the code produces now;
// review the diff before committing it.
export function golden(name, text) {
  const path = join(here, 'golden', name)
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    return
  }
  return readFileSync(path, 'utf8')
}

// A scratch copy of the app fixture with its tokens.json replaced, and its
// config's `tokens` block patched when `tokensConfig` is given.
export function withTokens(doc, tokensConfig = null) {
  const t = scratch()
  writeFileSync(join(t.root, 'design-system', 'tokens', 'tokens.json'), JSON.stringify(doc))
  if (tokensConfig) {
    const path = join(t.root, 'massimo.config.json')
    const config = JSON.parse(readFileSync(path, 'utf8'))
    config.tokens = { ...config.tokens, ...tokensConfig }
    writeFileSync(path, JSON.stringify(config))
  }
  return t
}
