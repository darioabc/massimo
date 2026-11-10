// The story lane: routes under /stories, only when STORIES=1.
import { stories } from './src/stories/manifest.ts'

export default function lab() {
  return {
    name: 'lab',
    hooks: {
      'astro:config:setup': ({ injectRoute }) => {
        if (process.env.STORIES !== '1') return
        injectRoute({ pattern: '/stories', entrypoint: './src/stories/index.astro' })
        for (const s of stories) injectRoute({ pattern: `/stories/${s.slug}`, entrypoint: `./src/stories/pages/${s.slug}/index.astro` })
      },
    },
  }
}
