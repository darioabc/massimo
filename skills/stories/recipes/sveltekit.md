# Recipe: SvelteKit

SvelteKit has no route-injection hook and no page-extension switch, so the lane swaps the routes folder: under `STORIES=1`, `kit.files.routes` points at `src/stories-routes/`, a small routes tree that holds only the story pages. The app's `src/lib`, hooks, `app.html` and global CSS are shared; the production build uses `src/routes/` and never sees a story.

## Files

```text
svelte.config.js                         routes folder + outDir switch under STORIES=1
src/stories-routes/+layout.svelte        imports the same global CSS as src/routes/+layout.svelte
src/stories-routes/+page.svelte          redirect or link to /stories
src/stories-routes/stories/+page.svelte  index (import.meta.glob of *.story.svelte)
src/stories-routes/stories/[slug]/+page.svelte
src/lib/stories/StoryState.svelte
src/lib/**/<Name>.story.svelte           one story per component, next to the component
```

## svelte.config.js

```js
const stories = process.env.STORIES === '1'
const config = {
  // …existing config…
  kit: {
    // …existing kit options…
    files: { ...(stories ? { routes: 'src/stories-routes' } : {}) },
    ...(stories ? { outDir: '.svelte-kit-stories' } : {}),
  },
}
```

Merge into existing `kit.files` rather than replacing it.

## Layout

`src/stories-routes/+layout.svelte` imports exactly what the app's root layout imports for styling (global CSS, fonts, theme handling) and renders the children, without the app's site chrome.

## Story pages

`stories/+page.svelte` and `stories/[slug]/+page.svelte` find stories with `import.meta.glob('/src/lib/**/*.story.svelte', { eager: true })`, slug = kebab-case file stem, and render the module's default component inside the same header/flex chrome as the Vite recipe. Story files follow the Vite recipe's Svelte section (`<script module> export const meta = {…}</script>`, `StoryState` wrappers).

## package.json

```json
"ds:stories": "STORIES=1 vite dev --port 4650",
"ds:stories:build": "STORIES=1 vite build"
```

## Config

```json
"stories": {
  "lane": "native",
  "include": ["src/**/*.story.svelte"],
  "devCommand": "npm run ds:stories",
  "url": "http://localhost:4650/stories",
  "storyUrl": "http://localhost:4650/stories/{slug}",
  "port": 4650
}
```

Add `.svelte-kit-stories` to `.gitignore`.

## Leak check

```bash
npm run build && ! grep -rl "data-story-state" .svelte-kit/output build 2>/dev/null
```

## Gotchas

- Components that use `$app/stores` or `$app/navigation` work, since the lane is a real SvelteKit app.
- If `hooks.server.ts` redirects unknown paths or requires auth, gate that logic on `!process.env.STORIES` for the lane only, and tell the user.
