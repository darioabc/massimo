#!/usr/bin/env node
// Adopt a repo's own design-system setup instead of generating one: find
// what is there and who depends on it, read without running any of it.
//
//   adopt.mjs scan [--json]   before init, print the inventory (Markdown, or
//                             JSON with --json); after init, write it to
//                             <project>/adopt/inventory.json and inventory.md
//
// Shared flags: --root, --config, --project-dir.

import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_KINDS } from './audit.mjs'
import { buildInventory, inventoryMarkdown, repoFiles } from './lib/inventory.mjs'
import { DEFAULTS, deepMerge, fail, loadConfig, parseArgs, readJson, rel, scriptCommand, writeFileAtomic } from './lib/project.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { _: args, flags } = parseArgs()
const [command = 'scan'] = args
const { root, exists, config, projectDir } = loadConfig(flags)
const projectRel = rel(root, projectDir) || '.'

// detect.mjs's report: the framework, the story tools and lane, style files.
function detect() {
  try {
    const out = execFileSync(process.execPath, [join(here, 'detect.mjs'), '--root', root], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    return JSON.parse(out.toString())
  } catch (e) {
    fail(`detect.mjs failed: ${e.message.split('\n')[0]}`)
  }
}

// The inventory of the repo as it is now. Before init, the config detect
// suggests stands in for the one init would write.
function scan() {
  const detected = detect()
  const pkg = readJson(join(root, 'package.json'), {}) ?? {}
  const effective = exists ? config : deepMerge(structuredClone(DEFAULTS), detected.suggestedConfig ?? {})
  const files = repoFiles(root, { ignore: effective.ignore, projectRel: exists ? projectRel : effective.projectDir, workspaces: Boolean(pkg.workspaces) })
  return buildInventory(root, { detected, config: effective, pkg, files, auditKinds: ALL_KINDS })
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

switch (command) {
  case 'scan': {
    const inv = scan()
    const md = inventoryMarkdown(inv, { command: scriptCommand(root, projectDir, 'adopt', 'scan') })
    if (!exists) {
      process.stdout.write(flags.json ? `${JSON.stringify(inv, null, 2)}\n` : md)
      break
    }
    writeFileAtomic(join(projectDir, 'adopt', 'inventory.json'), `${JSON.stringify(inv, null, 2)}\n`)
    writeFileAtomic(join(projectDir, 'adopt', 'inventory.md'), md)
    const consumers = inv.assets.reduce((n, a) => n + a.consumers.length, 0)
    process.stdout.write(`massimo adopt: ${plural(inv.assets.length, 'asset')}, ${plural(consumers, 'consumer')}, ${plural(inv.headers.keys.length, 'header key')}; wrote ${projectRel}/adopt/inventory.json and inventory.md\n`)
    break
  }
  default:
    fail(`unknown command "${command}". Commands: scan.`)
}
