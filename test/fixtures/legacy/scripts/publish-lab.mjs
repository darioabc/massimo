// Publishes the built lane from dist-lab. Run it through npm run stories:publish.
import { existsSync } from 'node:fs'

if (!existsSync('dist-lab/stories/index.html')) process.exit(1)
