# Recipe: Astro

An Astro integration injects the story routes only when `STORIES=1`. Story pages live outside `src/pages/`, so Astro's file routing never sees them; under a normal `astro build` the routes simply do not exist.

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

## Structured variant

Use this shape when the system has tiers and groups (a `graph.taxonomy` in the config), when components change layout by breakpoint, or when the lane will hold more than a few dozen stories. It is the same gated lane with four additions: a folder per story, a place for each story in the taxonomy, frame routes, and a theme switch. The graph reads the manifest as text and checks it.

### Files

```text
src/stories/manifest.ts                  the list, with each story's place and what it covers
src/stories/pages/<slug>/index.astro     the story page
src/stories/pages/<slug>/frame.astro     optional: the component alone, for viewport iframes
src/stories/StoryFrame.astro             page chrome, with the theme switch
src/stories/StoryState.astro             a labelled state: label, note, ground, flush
```

A folder per story, not a flat `pages/<slug>.astro`: `astro check` declares an identifier named after each page's file name, so a flat `button.astro` cannot import `Button` without an alias. `index.astro` collides with nothing.

### manifest.ts

```ts
export interface StoryEntry {
  slug: string // the route, /stories/<slug>, and the page's folder
  title: string // Root / Group / Name: the root and group below, then the story's own name
  description: string
  root: string // the tier of the component's ds:group
  group: string // the group inside that tier
  component?: string | string[] // the file it covers, as a repo path; left out only by a token page or a decision record
  states?: string[] // the page's StoryState labels, in order; the graph checks them
  theme?: 'light' | 'own' // left out, the page gets the theme switch
  frame?: boolean // also route /stories/<slug>/frame from frame.astro
  reference?: string | string[] // a design image to compare against
}

export const stories: StoryEntry[] = [
  {
    slug: 'button',
    title: 'Primitives / Actions / Button',
    root: 'Primitives',
    group: 'Actions',
    component: 'src/components/Button.astro',
    states: ['Primary', 'Disabled'],
    description: 'Actions. One primary per view.',
  },
]
```

Keep every value a literal. The graph reads this file without running it, and lists any field it cannot read (a call, a variable, a spread) as not checked. Keep the list itself one array literal too: a list wrapped in a call, extended with `.concat()` or `.map()`, or changed later with `push()` cannot be read at all, which is a `story-files` problem.

### The integration

The same gate, with a route per folder and a frame route where the entry asks for one:

```js
for (const story of stories) {
  injectRoute({ pattern: `/stories/${story.slug}`, entrypoint: `./src/stories/pages/${story.slug}/index.astro`, prerender: true })
  if (story.frame) {
    injectRoute({ pattern: `/stories/${story.slug}/frame`, entrypoint: `./src/stories/pages/${story.slug}/frame.astro`, prerender: true })
  }
}
```

### Frames

A state that depends on a media query cannot be shown by narrowing a box. Give the entry `frame: true`, render the component alone in `frame.astro` (inside `StoryFrame` with `bare`), and show it on the story page in iframes at the widths that matter:

```astro
<StoryState label="Phone"><iframe src={`/stories/${slug}/frame`} width="390" height="640" loading="lazy" /></StoryState>
<StoryState label="Desktop"><iframe src={`/stories/${slug}/frame`} width="1440" height="640" loading="lazy" /></StoryState>
```

### StoryState.astro

```astro
---
interface Props { label: string; note?: string; ground?: 'ground' | 'tile'; flush?: boolean }
const { label, note, ground = 'ground', flush = false } = Astro.props
---
<section data-story-state={label} class:list={['story-state', ground === 'tile' && 'is-tile', flush && 'is-flush']}>
  <p class="story-state__label">{label}{note && <span> · {note}</span>}</p>
  <div class="story-state__stage"><slot /></div>
</section>
```

Write each `label` as a plain string, so the graph can compare it with the entry's `states`. `note` says what to look at, `ground` sets the stage on the surface the component ships on, and `flush` drops the stage's padding for a component that brings its own.

### The theme switch

`StoryFrame` shows a light, dark and auto switch that sets the theme the way the app does (the same class or attribute on `<html>`, the same storage key), so every story can be checked in both. An entry with `theme: 'light'` has no dark variant (a printed document), and `theme: 'own'` carries its own switch; either way the frame says so in place of the switch.

### Keep story classes out of the product's CSS

Tailwind generates a class for every file it scans, so a class only a story uses ends up in the shipped stylesheet. Exclude the stories folder:

- Tailwind 3: add `'!./src/stories/**'` to `content` in `tailwind.config.*`.
- Tailwind 4: add `@source not "../stories";` beside the `@import "tailwindcss"` that scans the app (the path is relative to that CSS file).

Mark the frame with a class only the lane uses, so the leak check can look for it in the built CSS: `<body data-massimo-stories class="[--massimo-stories:1]">`.

### Config

```json
"stories": {
  "lane": "manifest",
  "include": ["src/stories/**/*.{astro,ts,tsx}"],
  "manifest": "src/stories/manifest.ts",
  "pages": "src/stories/pages/{slug}/index.astro",
  "frames": "src/stories/pages/{slug}/frame.astro",
  "componentless": ["Foundations / Colour", "Foundations / Type"],
  "devCommand": "npm run ds:stories",
  "url": "http://localhost:4650/stories",
  "storyUrl": "http://localhost:4650/stories/{slug}",
  "port": 4650
}
```

`include` covers the pages, the frames and the lane's own helpers, so a component a stage helper imports counts as covered and none of them counts as a consumer. `componentless` lists the places where a story may name no component.

### What the graph checks

With `stories.lane` set to `manifest`, `graph.mjs` reads the manifest and every page, and reports in `graph.json` → `storyLane.problems`:

- `story-title`: the title is not Root / Group / Name under the entry's root and group, they are not its component's group, or it names no component outside `componentless`;
- `story-files`: a manifest it cannot read as text, an entry without its page, a page or frame without an entry, or a frame flag and frame file that disagree;
- `story-states`: a `states` list that is not the page's labels, in order, or a state on that page with no label;
- `no-story`: a live node with no direct story and no `ds:no-story` line.

A node is covered directly when its story's page or frame imports it, or a lane helper the page imports does, or the entry names it; a node it only composes is covered incidentally, which does not count. With `graph.strictFaults`, the first three fail the graph run; the audit ratchets `no-story`.

### Leak check

The pages, the marker, and the stylesheet:

```bash
npm run build \
  && test -z "$(find dist -path '*stories*' -print -quit)" \
  && ! grep -rl "data-massimo-stories" dist \
  && ! grep -rl --include='*.css' -e "--massimo-stories" dist
```
