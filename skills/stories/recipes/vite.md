# Recipe: Vite (React, Preact, Vue, Svelte, Solid)

A second Vite config that extends the app's own config, with its own HTML entry. The app's production build never sees it: `vite build` builds `index.html` only, and the lane builds with its own config into its own folder.

## Files

```text
vite.stories.config.ts       extends vite.config.*, adds the stories entry and /stories URLs
stories.html                 the lane's HTML entry (repo root, next to index.html)
src/stories/main.<ext>       mounts the gallery with the app's global CSS and providers
src/stories/Gallery.<ext>    index page + story page, found by import.meta.glob
src/stories/StoryState.<ext> labelled frame for one state
src/**/<Name>.story.<ext>    one story per component, next to the component
```

## vite.stories.config.ts

```ts
// Story lane (massimo). Extends the app's Vite config so stories render
// through the same plugins, aliases and CSS. Never used by `vite build`.
import { defineConfig, mergeConfig, type UserConfig } from 'vite'
import base from './vite.config'

export default defineConfig(async (env) => {
  const app = (typeof base === 'function' ? await base(env) : base) as UserConfig
  return mergeConfig(app, {
    server: { port: 4650, strictPort: true, open: '/stories' },
    build: { outDir: 'dist-stories', rollupOptions: { input: { stories: 'stories.html' } } },
    plugins: [
      {
        name: 'massimo-stories-urls',
        // /stories and /stories/<slug> serve stories.html; the gallery reads the path.
        configureServer(server) {
          server.middlewares.use((req, _res, next) => {
            if (req.url && /^\/stories(\/[^?]*)?(\?.*)?$/.test(req.url)) req.url = '/stories.html'
            next()
          })
        },
      },
    ],
  })
})
```

If the app config is `vite.config.js`/`.mjs`, import that file instead. If the app config sets `build.rollupOptions.input` or `server.port`, the merge above overrides them for the lane only.

## stories.html

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Stories</title>
  </head>
  <body data-massimo-stories>
    <div id="root"></div>
    <script type="module" src="/src/stories/main.tsx"></script>
  </body>
</html>
```

Copy anything the app's `index.html` puts in `<head>` that affects rendering (font links, `data-theme`, class on `<html>`).

## React (and Preact, Solid)

`src/stories/main.tsx`: mirror the app entry's side-effect imports and providers (global CSS, fonts, theme, i18n, router if components need one).

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css' // the same global CSS the app's entry imports
import { Gallery } from './Gallery'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
)
```

`src/stories/StoryState.tsx`:

```tsx
import type { ReactNode } from 'react'

export function StoryState({ name, children, width }: { name: string; children: ReactNode; width?: number }) {
  return (
    <section data-story-state={name} style={{ display: 'grid', gap: 8, width }}>
      <h2 style={{ margin: 0, font: '500 12px/1.4 ui-monospace, monospace', opacity: 0.6 }}>{name}</h2>
      <div>{children}</div>
    </section>
  )
}
```

`src/stories/Gallery.tsx`:

```tsx
import type { ComponentType } from 'react'

export type StoryMeta = { title: string; description?: string; bare?: boolean }
type StoryModule = { default: ComponentType; meta?: StoryMeta }

const modules = import.meta.glob<StoryModule>('/src/**/*.story.{tsx,jsx}', { eager: true })

const stories = Object.entries(modules)
  .map(([path, mod]) => {
    const stem = path.split('/').pop()!.replace(/\.story\.\w+$/, '')
    const slug = stem.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
    return { slug, path, title: mod.meta?.title ?? stem, description: mod.meta?.description ?? '', bare: mod.meta?.bare, Story: mod.default }
  })
  .sort((a, b) => a.title.localeCompare(b.title))

function currentSlug() {
  return location.pathname.match(/^\/stories\/([^/]+)/)?.[1] ?? new URLSearchParams(location.search).get('story')
}

const href = (slug: string) => (import.meta.env.DEV ? `/stories/${slug}` : `?story=${slug}`)

export function Gallery() {
  const slug = currentSlug()
  const story = stories.find((s) => s.slug === slug)
  if (story) {
    const { Story } = story
    if (story.bare) return <Story />
    return (
      <main style={{ padding: 32, display: 'grid', gap: 24 }}>
        <header>
          <a href={import.meta.env.DEV ? '/stories' : '?'}>← Stories</a>
          <h1 style={{ margin: '8px 0 4px' }}>{story.title}</h1>
          {story.description && <p style={{ margin: 0, opacity: 0.7 }}>{story.description}</p>}
        </header>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 32, alignItems: 'flex-start' }}>
          <Story />
        </div>
      </main>
    )
  }
  return (
    <main style={{ padding: 32 }}>
      <h1>Stories</h1>
      <ul>
        {stories.map((s) => (
          <li key={s.slug}>
            <a href={href(s.slug)}>{s.title}</a> {s.description && <span style={{ opacity: 0.6 }}>· {s.description}</span>}
          </li>
        ))}
      </ul>
    </main>
  )
}
```

A story, `src/components/Button.story.tsx`:

```tsx
import { StoryState } from '@/stories/StoryState' // or a relative path if there is no alias
import { Button } from './Button'

export const meta = { title: 'Button', description: 'Actions. One primary per view.' }

export default function ButtonStory() {
  return (
    <>
      <StoryState name="Primary"><Button>Save changes</Button></StoryState>
      <StoryState name="Secondary"><Button variant="secondary">Cancel</Button></StoryState>
      <StoryState name="Disabled"><Button disabled>Save changes</Button></StoryState>
      <StoryState name="Loading"><Button loading>Saving…</Button></StoryState>
    </>
  )
}
```

**Preact:** same files; `main.tsx` uses `import { render } from 'preact'` and `render(<Gallery />, document.getElementById('root')!)`; types from `preact`.
**Solid:** `import { render } from 'solid-js/web'`, `render(() => <Gallery />, document.getElementById('root')!)`; replace `ComponentType` with `Component` from `solid-js` and inline styles with `style={{ gap: '8px' }}` strings.

## Vue

- `src/stories/main.ts`: `createApp(Gallery)`, plus the app's plugins (`app.use(router)`, i18n, pinia) and global CSS import; `.mount('#root')`.
- Stories are SFCs, `Button.story.vue`, with meta in a plain `<script>` block:

```vue
<script lang="ts">
export const meta = { title: 'Button', description: 'Actions. One primary per view.' }
</script>
<script setup lang="ts">
import StoryState from '@/stories/StoryState.vue'
import Button from './Button.vue'
</script>
<template>
  <StoryState name="Primary"><Button>Save changes</Button></StoryState>
  <StoryState name="Disabled"><Button disabled>Save changes</Button></StoryState>
</template>
```

- `Gallery.vue`: `import.meta.glob('/src/**/*.story.vue', { eager: true })`; each module's `default` is the component, `meta` the named export; render with `<component :is="story.Story" />`. Same slug and href logic as React.

## Svelte

- Svelte 5: `mount(Gallery, { target: document.getElementById('root')! })`. Svelte 4: `new Gallery({ target })`.
- Stories `Button.story.svelte` with `<script module> export const meta = { … } </script>` (Svelte 4: `<script context="module">`), states wrapped in `StoryState.svelte` (a `<section>` with a name prop and a slot/snippet).
- `Gallery.svelte`: `import.meta.glob('/src/**/*.story.svelte', { eager: true })`, render with `<svelte:component this={story.Story} />` (Svelte 5: `{@const S = story.Story}<S />`).

## package.json

```json
"ds:stories": "vite --config vite.stories.config.ts",
"ds:stories:build": "vite build --config vite.stories.config.ts"
```

## Config

```json
"stories": {
  "lane": "native",
  "include": ["src/**/*.story.{tsx,jsx}"],
  "devCommand": "npm run ds:stories",
  "url": "http://localhost:4650/stories",
  "storyUrl": "http://localhost:4650/stories/{slug}",
  "port": 4650
}
```

Use the right extension for Vue (`*.story.vue`) and Svelte (`*.story.svelte`). Add `dist-stories` to `.gitignore`.

## Leak check

```bash
npm run build && ! grep -rl "data-massimo-stories\|StoryState" dist
```

Use the app's real build output folder if it is not `dist`. Nothing should match.

## Gotchas

- If components need a router context (links, `useNavigate`), wrap the gallery in a memory router in `main.tsx`; do not change the components.
- If the app's Tailwind setup scans specific folders (`@source`, `content`), make sure story files are inside a scanned folder, or add `src/**/*.story.*` to it for the lane.
- Path aliases come from the app config through `mergeConfig`; if the app config sets them via a plugin like `vite-tsconfig-paths`, they carry over the same way.
