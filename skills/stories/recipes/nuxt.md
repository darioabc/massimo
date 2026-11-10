# Recipe: Nuxt

Nuxt's `pages:extend` hook adds the story routes only when `STORIES=1`. The story page components live outside `pages/`, so a normal build never registers them. Under `STORIES=1` the build also writes to folders of its own, so a story build never lands where the app's build and deploy look. The app's layouts, plugins, middleware and CSS apply as in production.

## Where the files go

The paths below sit in the app's source folder, Nuxt's `srcDir`, which `~` points at:

- Nuxt 4: `app/`, when the app keeps its code there. An app still laid out the Nuxt 3 way keeps the root.
- Nuxt 3: the root, or `app/` with `future.compatibilityVersion: 4`.
- Any version: the folder `srcDir` names, when `nuxt.config` sets it.

So in Nuxt 4's layout the lane is `app/stories/` and a story sits in `app/components/`. A local layer (a folder under `layers/`, or one `extends` names by a relative path) has a source folder of its own by the same rule, such as `layers/<name>/app/` in Nuxt 4, and its stories sit beside its components. `nuxt.config.ts` stays at the root.

## Files

```text
nuxt.config.ts                            the pages:extend hook + build and output folder switch
<srcDir>/stories/StoriesIndex.vue         index page (outside pages/)
<srcDir>/stories/StoryPage.vue            one story by slug
<srcDir>/stories/StoryState.vue           labelled frame for one state
<srcDir>/components/**/<Name>.story.vue   one story per component, next to the component
<layer>/components/**/<Name>.story.vue    the same for a local layer, in its source folder
```

## nuxt.config.ts

```ts
const stories = process.env.STORIES === '1'

export default defineNuxtConfig({
  // …existing config…
  ...(stories ? { buildDir: '.nuxt-stories' } : {}),
  nitro: {
    // …existing nitro options…
    ...(stories ? { output: { dir: '.output-stories' } } : {}),
  },
  hooks: {
    'pages:extend'(pages) {
      if (!stories) return
      pages.push(
        { name: 'massimo-stories', path: '/stories', file: '~/stories/StoriesIndex.vue' },
        { name: 'massimo-story', path: '/stories/:slug', file: '~/stories/StoryPage.vue' },
      )
    },
  },
})
```

Merge with any existing `nitro` and `hooks`: a second key of the same name replaces the first, with all its options. `buildDir` moves `.nuxt` and Nitro's `output.dir` moves `.output`, so a story build leaves alone the folder the app's deploy ships. `nuxt generate` may also point a `dist` link at the public folder it wrote, so run the app's own build again before anything ships `dist`.

## Story pages

`StoriesIndex.vue` and `StoryPage.vue` find stories with `import.meta.glob`, one pattern per source folder: `'~/components/**/*.story.vue'` for the app (Nuxt resolves `~`), and one through `~~`, the root, for each local layer's components (`'~~/layers/*/app/components/**/*.story.vue'` for layers in Nuxt 4's layout). Pass them as one array with `{ eager: true }`. Slug = kebab-case file stem. Render the default export with `<component :is>` inside the header/flex chrome from the Vite recipe. Give both pages `definePageMeta({ stories: true })`, plus `layout: false` when the default layout adds site chrome, and set `useHead({ meta: [{ name: 'robots', content: 'noindex' }] })`. Story files follow the Vite recipe's Vue section.

## Routes the app changes

- **Global route middleware** (a `.global` file in `middleware/`, the app's or a layer's) runs on the story routes too. One that redirects, a sign-in check say, sends `/stories` elsewhere, and the lane's shots show that page instead. With the user's OK, have it return first on a story route: `if (to.meta.stories) return`. No other route sets that key, so the app is unchanged.
- **`@nuxtjs/i18n`** localizes the routes the hook adds as it does the app's. With the `prefix` strategy every route gets a locale prefix, so the lane opens at `/en/stories`, one per locale. In version 10, `meta: { i18n: false }` on each route the hook pushes leaves it as written. Otherwise set `stories.url` and `stories.storyUrl` to the prefixed URLs, and link from the index to a story with the module's `useLocalePath()`.

## Tailwind

The lane runs the app's own Vite and CSS setup. The app's CSS reaches the story pages as it reaches every page, through `css` in `nuxt.config` or the file a module adds, so the story pages import no CSS and the Tailwind setup stays as it is:

- Tailwind 4 through `@tailwindcss/vite` in `vite.plugins`: Tailwind scans the project for classes and skips what `.gitignore` lists, so it reads the lane folder and the story files, and not `.nuxt-stories` or `.output-stories` once they are ignored. If the app's CSS narrows the scan (`@import "tailwindcss" source(...)` or `@source not`) so that it leaves either out, add an `@source` line for it.
- Tailwind 4 through `@nuxtjs/tailwindcss` 7: the module adds the same `@tailwindcss/vite` plugin, so the same holds. Keep the module's settings as they are.
- Tailwind 3 through `@nuxtjs/tailwindcss` 6: the module's `content` globs cover Nuxt's own folders (components, layouts, pages and a few more) but not `stories/`, so add `<srcDir>/stories/**/*.vue` to `content` in the Tailwind config.

## package.json

```json
"ds:stories": "STORIES=1 nuxt dev --port 4650",
"ds:stories:build": "STORIES=1 nuxt generate"
```

## Config

```json
"stories": {
  "lane": "native",
  "include": ["app/components/**/*.story.vue", "layers/*/app/components/**/*.story.vue"],
  "devCommand": "npm run ds:stories",
  "url": "http://localhost:4650/stories",
  "storyUrl": "http://localhost:4650/stories/{slug}",
  "port": 4650
}
```

`include` holds one glob per source folder's `components/`, from the folder that holds `massimo.config.json`: the app's, then the local layers'. The globs above are Nuxt 4's layout. In Nuxt 3's they are `components/**/*.story.vue` and `layers/*/components/**/*.story.vue`. Leave out the layer glob in an app with no local layers.

The lane's own pages are not drift: `audit.exclude` holds `<srcDir>/stories/**` (`app/stories/**` in Nuxt 4's layout, `stories/**` in Nuxt 3's). detect suggests it for a new project; add it to a config written before the lane.

Add `.nuxt-stories` and `.output-stories` to `.gitignore`.

## Leak check

```bash
npm run build && ! grep -rl "data-story-state" .output 2>/dev/null
```
