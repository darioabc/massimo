# Recipe: Nuxt

Nuxt's `pages:extend` hook adds the story routes only when `STORIES=1`. The story page components live outside `pages/`, so a normal build never registers them. The app's layouts, plugins and CSS apply as in production.

## Files

```text
nuxt.config.ts                     the pages:extend hook + buildDir switch
stories/StoriesIndex.vue           index page (outside pages/)
stories/StoryPage.vue              one story by slug
stories/StoryState.vue             labelled frame for one state
components/**/<Name>.story.vue     one story per component, next to the component
```

## nuxt.config.ts

```ts
const stories = process.env.STORIES === '1'

export default defineNuxtConfig({
  // …existing config…
  ...(stories ? { buildDir: '.nuxt-stories' } : {}),
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

Merge with any existing `hooks`.

## Story pages

`StoriesIndex.vue` and `StoryPage.vue` find stories with `import.meta.glob('~/components/**/*.story.vue', { eager: true })` (Nuxt resolves `~`), slug = kebab-case file stem, and render the default export with `<component :is>` inside the header/flex chrome from the Vite recipe. Use `definePageMeta({ layout: false })` in both when the default layout adds site chrome; set `useHead({ meta: [{ name: 'robots', content: 'noindex' }] })`. Story files follow the Vite recipe's Vue section.

## package.json

```json
"ds:stories": "STORIES=1 nuxt dev --port 4650",
"ds:stories:build": "STORIES=1 nuxt generate"
```

## Config

```json
"stories": {
  "lane": "native",
  "include": ["components/**/*.story.vue"],
  "devCommand": "npm run ds:stories",
  "url": "http://localhost:4650/stories",
  "storyUrl": "http://localhost:4650/stories/{slug}",
  "port": 4650
}
```

Add `.nuxt-stories` to `.gitignore`.

## Leak check

```bash
npm run build && ! grep -rl "data-story-state" .output 2>/dev/null
```
