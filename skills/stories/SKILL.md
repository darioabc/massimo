---
name: stories
description: Set up a native story lane in this repo: component stories rendered through the repo's own build and styling pipeline, with no Storybook, Ladle or other third-party tool, gated so stories never ship to production. Then write baseline stories for the most-used components first. Use for the stories phase of a massimo project, or when the user wants to see components in isolation, add a story, or screenshot a component's states.
---

# massimo: stories

A story is a page that renders one component's real states with real content, through the same build and CSS pipeline that ships the product. What renders in the lane is what renders in production. Stories ground everything visual that follows: baselines for the ux loop, before/after screenshots for tidy batches, the translator's render, the Figma mirror's source.

Plugin root: two directories above this skill's base directory. Follow `<plugin>/reference/project.md` → Session protocol. `<project>` is the project folder: `projectDir` in `massimo.config.json`, `design-system` by default.

## The lane contract

Whatever the framework, the lane has the same five properties:

1. **Native.** Stories render through the app's own bundler, CSS, fonts and providers. No second build pipeline, no third-party story tool.
2. **Gated.** The story routes or entry exist only when `STORIES=1` (or the framework's equivalent). A production build cannot include them, by structure rather than by remembering to delete something.
3. **Discoverable.** One index page lists every story: `/stories`. Each story has a stable URL: `/stories/<slug>`.
4. **States side by side.** One story page shows a component's meaningful states at once (default, hover/focus forced via a class, disabled, loading, empty, error, long content), labelled. Theme: follow the app's own theme mechanism; do not pin a theme unless the app is single-theme.
5. **Real content.** Props use real-looking content from the sources in `product.md` → Real content, never lorem ipsum.

## Run

1. **Begin** per the session protocol. `state.mjs set stories in_progress`.
2. **Pick the recipe.** Read `massimo.config.json` → `framework`, then `<plugin>/skills/stories/recipes/<recipe>.md`:
   - `vite-react`, `vite-preact`, `vite-vue`, `vite-svelte`, `vite-solid`, `vite`, `webpack-react` → `vite.md` (webpack-react: adapt the same idea to its dev server, or ask the user before adding Vite as a dev-only lane).
   - `next-app`, `next-pages` → `next.md`
   - `astro` → `astro.md`
   - `sveltekit` → `sveltekit.md`
   - `nuxt` → `nuxt.md`
   - anything else → `other.md`
3. **Existing lane or story tool?** If detect reports `storyTools.lane`, the repo already built a gated lane (routes behind an env flag, a stories folder with a manifest or an index): it is the lane. Check that `massimo.config.json` → `stories` has its include, dev command, port and URL (detect suggests them), tell the user, and skip to step 6; never scaffold over it. If the repo has Storybook/Ladle/Histoire and the user chose to keep it (recorded at setup), skip to step 6 and treat its stories as the lane: URLs come from that tool. Otherwise continue.
4. **Scaffold the lane** per the recipe: the gate, the index, the story wrapper, one example story for the most-used primitive, and package.json scripts `ds:stories` (dev) and `ds:stories:build`. Write the lane's URL, port and dev command into `massimo.config.json` → `stories`. Never overwrite: before writing, check every file the recipe creates (the lane's folder and files, its integration or entry file, its story routes, the `ds:stories` scripts), and if any already exists, stop and tell the user which: the repo has a lane or files of its own to keep. The framework's own config (`astro.config.*`, `next.config.*`, `nuxt.config.*`, `svelte.config.js`, `vite.config.*`) always exists: edit it to register the lane, never replace it.
5. **Prove it.**
   - Start the lane in the background. Prefer the host's dev-server/preview tool if it has one (create its launch config entry named `stories`); otherwise run `npm run ds:stories` in the background.
   - Load `/stories` and the example story; check the console for errors.
   - Screenshot it: `node <project>/scripts/shoot.mjs --url <url> --out <project>/shots/stories/<slug>.png` (exit 3 means no Playwright: use the host's browser screenshot tool).
   - **Leak check:** run the production build and confirm no story route, chunk or marker made it into the output (the recipe names the exact check). This is required, not optional.
   - Show the user the screenshot and the index.
6. **Agree the coverage target.** Read the graph's story queue. Recommend: every component used by three or more files, plus all primitives (buttons, inputs, typography, layout). Record the target as a decision, e.g. "story the top 30 by usage".
7. **Write baseline stories in batches.** Take five to eight components from the queue at a time. Dispatch the `story-writer` agent (one agent per two or three related components, several in parallel when they touch different files). Each dispatch includes:
   - plugin root path, repo root, the recipe path, the lane's URL;
   - the components' files, their graph nodes (composes, used by), and two real call sites to copy realistic props from;
   - the real-content sources from `product.md`;
   - the screenshot folder `<project>/shots/stories/`.
   The agent writes stories only (never edits components), renders and screenshots them, and returns story paths, screenshot paths and fidelity gaps.
8. **Review each batch.** Look at every screenshot. Bounce stories that invent props a component lacks, show lorem ipsum, or omit states the component clearly has. Show the user a compact batch summary with the screenshots; designers will spot what is wrong fastest.
9. **Re-run the graph** (`graph.mjs`) so story coverage updates. `state.mjs set stories in_progress --note "<n>/<target> storied"` after each batch, so a stop at any point resumes cleanly.
10. **End** when the target is met: `state.mjs set stories done --note "<n> stories, lane at <url>"`. Next step: tokens.

## A lane with a manifest

A lane that lists its stories in a manifest (the Astro recipe's structured variant, or a repo's own lane of that shape) tells the graph where the list is, and the graph then reads it as text and checks it:

- `stories.lane: "manifest"` with `stories.manifest` naming the file. The graph refuses the first without the second, and leaves a manifest unread while the lane is `native`.
- `stories.pages` and `stories.frames` name each story's page and frame as paths with `{slug}`, such as `src/stories/pages/{slug}/index.astro`.
- `stories.componentless` lists the places (`Root / Group`) where a story may name no component, such as token pages and decision records.

Coverage then counts direct stories only: a node is covered when its story's page or frame imports it, through the lane's helpers too, or the entry names it. A node seen only inside a parent's story is listed as incidental and stays in the story queue. `graph.json` → `storyLane.problems` lists `story-title`, `story-files`, `story-states` and `no-story` findings; `graph.taxonomy.notLive` names the tiers that need no story. When writing stories in such a lane, add the entry with its root, group, component and states, and keep every value a literal.

## Rules

- Stories never change component code. If a component cannot be rendered in isolation without a refactor, write the closest faithful story and list the gap; the user decides whether the refactor becomes work of its own.
- Mock data and handlers, never the component's own markup.
- Keep each story file next to its component or in the lane's stories folder, as the recipe says; be consistent.
- Story screenshots are not committed: they live in the gitignored `shots/stories/`. Only a screenshot that a committed file links to goes in `shots/kept/`.
