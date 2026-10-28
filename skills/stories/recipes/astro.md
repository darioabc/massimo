# Recipe: Astro

An Astro integration injects the story routes only when `STORIES=1`. Story pages live outside `src/pages/`, so Astro's file routing never sees them; under a normal `astro build` the routes simply do not exist. This is the lane fiuto-marketing runs in production use.

## Files

```text
stories-integration.mjs              the gated integration (repo root)
astro.config.mjs                     registers the integration
src/stories/manifest.ts              the list of stories
src/stories/index.astro              the index page
src/stories/StoryFrame.astro         page chrome: imports the global CSS the real layout imports
src/stories/StoryState.astro         labelled frame for one state
src/stories/pages/<slug>.astro       one story page per component or section
```

## stories-integration.mjs

```js
// Story lane (massimo). A no-op unless STORIES=1, so the production build
// never gets a story route: there is nothing to remember to delete.
import { stories } from './src/stories/manifest.ts'

export default function storiesIntegration() {
  return {
    name: 'massimo-stories',
    hooks: {
      'astro:config:setup': ({ injectRoute, logger }) => {
        if (process.env.STORIES !== '1') return
        injectRoute({ pattern: '/stories', entrypoint: './src/stories/index.astro', prerender: true })
        for (const story of stories) {
          injectRoute({ pattern: `/stories/${story.slug}`, entrypoint: `./src/stories/pages/${story.slug}.astro`, prerender: true })
        }
        logger.info(`injected ${stories.length} story route(s)`)
      },
    },
  }
}
```

Register it in `astro.config.mjs`: `integrations: [...existing, storiesIntegration()]`.

If the site deploys the story build anywhere public, also write a `Disallow: /` robots.txt and an `X-Robots-Tag: noindex` header in `astro:build:done` when `STORIES=1`.

## manifest.ts

```ts
// Every story the lane renders. `slug` is both the route and the page file name.
export interface StoryEntry { slug: string; title: string; description: string }

export const stories: StoryEntry[] = [
  { slug: 'button', title: 'Button', description: 'Actions. One primary per view.' },
]
```

## StoryFrame.astro

```astro
---
// Imports the same global CSS the real layout imports, so a story renders
// through the exact pipeline that ships.
import '../styles/global.css'
interface Props { title: string; description?: string; bare?: boolean }
const { title, description, bare = false } = Astro.props
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>{title} · Stories</title>
  </head>
  <body data-massimo-stories>
    {bare ? <slot /> : (
      <main style="padding:32px;display:grid;gap:24px">
        <header>
          <a href="/stories">← Stories</a>
          <h1 style="margin:8px 0 4px">{title}</h1>
          {description && <p style="margin:0;opacity:.7">{description}</p>}
        </header>
        <div style="display:flex;flex-wrap:wrap;gap:32px;align-items:flex-start"><slot /></div>
      </main>
    )}
  </body>
</html>
```

Copy whatever the real layout puts in `<head>` that affects rendering (font preloads, theme attribute or script). If the site is single-theme, pin it here the same way the layout does.

## StoryState.astro

```astro
---
interface Props { name: string; width?: number }
const { name, width } = Astro.props
---
<section data-story-state={name} style={`display:grid;gap:8px;${width ? `width:${width}px` : ''}`}>
  <h2 style="margin:0;font:500 12px/1.4 ui-monospace,monospace;opacity:.6">{name}</h2>
  <div><slot /></div>
</section>
```

## A story page, src/stories/pages/button.astro

```astro
---
import StoryFrame from '../StoryFrame.astro'
import StoryState from '../StoryState.astro'
import Button from '../../components/Button.astro'
---
<StoryFrame title="Button" description="Actions. One primary per view.">
  <StoryState name="Primary"><Button>Save changes</Button></StoryState>
  <StoryState name="Disabled"><Button disabled>Save changes</Button></StoryState>
</StoryFrame>
```

React, Vue or Svelte islands render with the same `client:` directive the real page uses.

## index.astro

Lists `stories` from the manifest as links to `/stories/<slug>`, inside `StoryFrame`.

## package.json

```json
"ds:stories": "STORIES=1 astro dev --port 4650",
"ds:stories:build": "STORIES=1 astro build --outDir dist-stories"
```

## Config

```json
"stories": {
  "lane": "native",
  "include": ["src/stories/pages/*.astro"],
  "devCommand": "npm run ds:stories",
  "url": "http://localhost:4650/stories",
  "storyUrl": "http://localhost:4650/stories/{slug}",
  "port": 4650
}
```

Add `dist-stories` to `.gitignore`. The graph credits a component with a story when a story page imports it.

## Leak check

```bash
npm run build && test -z "$(find dist -path '*stories*' -print -quit)" && ! grep -rl "data-massimo-stories" dist
```
