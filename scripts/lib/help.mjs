// --help and -h for a script: print the comment block at the top of the file
// (its usage) and exit 0, before the script reads or writes anything. A script
// that another one imports stays quiet, so only the one that was run answers.

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function helpAndExit(metaUrl, argv = process.argv.slice(2)) {
  if (!argv.includes('--help') && !argv.includes('-h')) return
  const file = fileURLToPath(metaUrl)
  if (realpathSync(file) !== realpathSync(process.argv[1])) return
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('#!')) continue
    if (!line.startsWith('//')) break
    out.push(line.replace(/^\/\/ ?/, ''))
  }
  process.stdout.write(`${out.join('\n')}\n`)
  process.exit(0)
}
