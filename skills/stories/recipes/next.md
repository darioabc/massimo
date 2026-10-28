# Recipe: Next.js (App Router; Pages Router notes at the end)

Story routes are files with a `.story.tsx` page extension that Next only recognises when `STORIES=1`. Without it, `page.story.tsx` is not a page, so the production build has no story routes at all. It is the same structural gate as a dev-only page.

## Files

```text
next.config.*                        pageExtensions + distDir switch under STORIES=1
app/stories/page.story.tsx           index (or src/app/… when the app uses src/)
app/stories/[slug]/page.story.tsx    one story by slug
src/stories/StoryState.tsx           labelled frame for one state
src/stories/manifest.ts              the list of stories (Next has no import.meta.glob)
src/**/<Name>.story.tsx              one story per component, next to the component
```

## next.config

Keep every extension the app already uses (mdx, etc.) and add the story one only under the flag. Separate `distDir` so a story build never overwrites the app's.

```js
const stories = process.env.STORIES === '1'
const nextConfig = {
  // …the app's existing config…
  pageExtensions: ['tsx', 'ts', 'jsx', 'js', ...(stories ? ['story.tsx'] : [])],
  ...(stories ? { distDir: '.next-stories' } : {}),
}
```

If `pageExtensions` already exists, append to it instead of replacing it.

## manifest

```ts
// Every story the lane renders. Add one line per story.
import type { ComponentType } from 'react'
import ButtonStory, { meta as buttonMeta } from '@/components/Button.story'

export type StoryMeta = { title: string; description?: string; bare?: boolean }
export type StoryEntry = { slug: string; meta: StoryMeta; Story: ComponentType }

export const stories: StoryEntry[] = [
  { slug: 'button', meta: buttonMeta, Story: ButtonStory },
]
```

## Routes

`app/stories/page.story.tsx`:

```tsx
import Link from 'next/link'
import { stories } from '@/stories/manifest'

export const metadata = { title: 'Stories', robots: { index: false, follow: false } }

export default function StoriesIndex() {
  return (
    <main style={{ padding: 32 }}>
      <h1>Stories</h1>
      <ul>
        {stories.map((s) => (
          <li key={s.slug}>
            <Link href={`/stories/${s.slug}`}>{s.meta.title}</Link>
            {s.meta.description && <span style={{ opacity: 0.6 }}> — {s.meta.description}</span>}
          </li>
        ))}
      </ul>
    </main>
  )
}
```

`app/stories/[slug]/page.story.tsx`:

```tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { stories } from '@/stories/manifest'

export const metadata = { robots: { index: false, follow: false } }
export function generateStaticParams() {
  return stories.map((s) => ({ slug: s.slug }))
}

export default async function StoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const story = stories.find((s) => s.slug === slug)
  if (!story) notFound()
  const { Story, meta } = story
  if (meta.bare) return <Story />
  return (
    <main style={{ padding: 32, display: 'grid', gap: 24 }}>
      <header>
        <Link href="/stories">← Stories</Link>
        <h1 style={{ margin: '8px 0 4px' }}>{meta.title}</h1>
        {meta.description && <p style={{ margin: 0, opacity: 0.7 }}>{meta.description}</p>}
      </header>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 32, alignItems: 'flex-start' }}>
        <Story />
      </div>
    </main>
  )
}
```

On Next 14 and earlier, `params` is a plain object, not a Promise.

The routes sit under the app's root layout, so global CSS, fonts and providers apply exactly as in production. If the root layout renders site chrome (nav, footer) that should not frame a story, add `app/stories/layout.story.tsx` that renders only `children`; it cannot remove the root layout itself, so prefer `meta.bare` for full-page stories.

## StoryState and stories

Same `StoryState` and story file shape as the Vite recipe's React section. Story files that render client components need no `'use client'` themselves unless they use hooks or handlers; add it when they do.

## package.json

```json
"ds:stories": "STORIES=1 next dev -p 4650",
"ds:stories:build": "STORIES=1 next build"
```

On Windows teams, use `cross-env STORIES=1 …` if `cross-env` is already a dependency; otherwise note it in design-system/README.md.

## Config

```json
"stories": {
  "lane": "native",
  "include": ["src/**/*.story.tsx", "app/**/*.story.tsx"],
  "devCommand": "npm run ds:stories",
  "url": "http://localhost:4650/stories",
  "storyUrl": "http://localhost:4650/stories/{slug}",
  "port": 4650
}
```

Add `.next-stories` to `.gitignore`.

## Leak check

```bash
npm run build && test ! -e .next/server/app/stories && ! grep -rl "StoryState" .next/server/app 2>/dev/null
```

## Pages Router

Same idea: `pages/stories/index.story.tsx` and `pages/stories/[slug].story.tsx`, with `getStaticPaths` from the manifest. The `pageExtensions` switch is identical.
