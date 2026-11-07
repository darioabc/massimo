/**
 * Writes the design-system docs in docs/system/ from the code's headers.
 * A header is `//` lines at the top of a component:
 *
 *   // ds:group <Tier> / <Group>     required
 *   // ds:styles <file>              a shared sheet it reads
 *
 * npm run system writes; npm run system:check fails when they are stale.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const DIR = 'docs/system'
const MANIFEST = 'src/stories/manifest.ts'
const TOKENS = 'src/styles/theme.css'
const say = (s) => `${s} (write a \`// ds:group <Tier> / <Group>\` line)`

const manifest = readFileSync(MANIFEST, 'utf8')
const theme = readFileSync(TOKENS, 'utf8')
if (!process.argv.includes('--check')) {
  writeFileSync(`${DIR}/graph.md`, say(manifest.length))
  writeFileSync(`${DIR}/index.md`, '')
  writeFileSync(`${DIR}/tokens.md`, theme)
  writeFileSync(`${DIR}/tokens.json`, '{}')
  writeFileSync(`${DIR}/ratchet.json`, '{}')
}
