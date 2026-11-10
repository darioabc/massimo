// Share cards in the brand colour, read from the theme at run time.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const theme = readFileSync(join(ROOT, 'src/styles/theme.css'), 'utf8')
export const brand = /--brand:\s*([^;]+);/.exec(theme)?.[1]
