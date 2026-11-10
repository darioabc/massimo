---
name: stories
description: Set up a native story lane in this repo: component stories rendered through the repo's own build and styling pipeline, with no Storybook, Ladle or other third-party tool, gated so stories never ship to production. In a repo that keeps its Storybook, its stories are the lane instead. Then write baseline stories for the most-used components first. Use for the stories phase of a massimo project, or when the user wants to see components in isolation, add a story, or screenshot a component's states.
---

# massimo: stories

A story is a page that renders one component's real states with real content, through the same build and CSS pipeline that ships the product. What renders in the lane is what renders in production. Stories ground everything visual that follows: baselines for the ux loop, before/after screenshots for tidy batches, the translator's render, the Figma mirror's source.

Plugin root: two directories above this skill's base directory. Follow `<plugin>/reference/project.md` → Session protocol. `<project>` is the project folder: `projectDir` in `massimo.config.json`, `design-system` by default.

## The lane contract

Whatever the framework, the lane has the same five properties:

1. **Native.** Stories render through the app's own bundler, CSS, fonts and providers. No second build pipeline, no third-party story tool.
2. **Gated.** The story routes or entry exist only when `STORIES=1` (or the framework's equivalent). A production build cannot include them, by structure rather than by remembering to delete something.
3. **Discoverable.** One index page lists every story: `/stories`. Each story has a stable URL: `/stories/<slug>`.
4. **States side by side.** One story page shows a component's meaningful states at once (default, hover/focus forced via a class, disabled, loading, empty, error, long content), labelled. Theme: follow the app's own theme mechanism; do not pin a theme unless the app is single-theme. In a csf lane (`stories.lane: "csf"`) this reads: one state at a time, with every state one click away, and side by side only for the files listed in `stories.sideBySide`, because states that share a document or an origin's storage can disturb each other.
5. **Real content.** Props use real-looking content from the sources in `product.md` → Real content, never lorem ipsum.

## Run

1. **Begin** per the session protocol. `state.mjs set stories in_progress`.
2. **Pick the recipe.** Read `massimo.config.json` → `stories.lane` and `framework`, then `<plugin>/skills/stories/recipes/<recipe>.md`. A repo that keeps its own story tool (Storybook, Histoire, or Ladle without the csf opt-in), as recorded at setup, takes no recipe: step 3 says how its stories serve as the lane.
   - `stories.lane` is `"csf"` → `vite-csf.md`. Only an adopted Ladle repo gets there, through `adopt.mjs config --write --lane csf`: its CSF story files stay in place and massimo's Vite plugin serves them. Never scaffold it for another repo; a Storybook repo keeps the path below. A csf lane that a host will serve to a team also follows `hosted.md`: the build's output, the rewrite, the headers and the checks before it goes up.
   - `vite-react`, `vite-preact`, `vite-vue`, `vite-svelte`, `vite-solid`, `vite`, `webpack-react` → `vite.md` (webpack-react: adapt the same idea to its dev server, or ask the user before adding Vite as a dev-only lane).
   - `next-app`, `next-pages` → `next.md`
   - `astro` → `astro.md`
   - `sveltekit` → `sveltekit.md`
   - `nuxt` → `nuxt.md`
   - anything else → `other.md`
3. **Existing lane or story tool?** If detect reports `storyTools.lane` marked `csf: true`, it is massimo's own csf lane, already scaffolded from `vite-csf.md`: keep it, scaffold nothing, leave its `stories` keys as the csf config sets them (detect suggests none from it), tell the user, and skip to step 6. Any other `storyTools.lane` means the repo already built a gated lane (routes behind an env flag, a stories folder with a manifest or an index): it is the lane. Check that `massimo.config.json` → `stories` has its include, dev command, port and URL (detect suggests them), tell the user, and skip to step 6; never scaffold over it. If the repo has Storybook, Ladle or Histoire and the user chose to keep it (recorded at setup), its stories are the lane: scaffold nothing, tell the user, and skip to step 6. URLs come from that tool. For Storybook:
   - **Config.** `massimo.config.json` → `stories` holds `include` (the globs of the stories list in `.storybook/main`), `devCommand` (the script that runs `storybook dev`), `port`, `url`, and `storyUrl`, Storybook's story address `<url>/iframe.html?id={id}&viewMode=story`. Detect suggests them at setup (`storyTools.storybook` names the main config, and its notes say what it did not read, such as a stories list written as code), and `adopt.mjs plan` proposes them. Set by hand what a note names.
   - **Ids.** `node <project>/scripts/stories.mjs storybook <component or story file>` prints each story's Storybook id and URL without running Storybook, by Storybook's own rule: the file's title, or the title Storybook builds from its path and the stories entry it matches, then the export's name. For a component it lists the story files the graph credits it with, its own story first. When Storybook runs, `--against <url>` checks the ids against its `/index.json`.
   - **Running it.** Start `stories.devCommand` in the background only with the user's OK, since it runs the repo's own code, and stop it after.
   - **Shots.** `shoot.mjs --url '<story url>' --selector '#storybook-root' --out <file>`, with the URL quoted for its `&`. For many stories, `stories.mjs storybook <files> --routes > <routes file>`, then `shoot.mjs --sweep <url> --routes <routes file> --ready '#storybook-root'`.
   - **New stories** are CSF files in the repo's existing format, beside its `*.stories.*` files: the same title style, imports, `Meta` and `StoryObj` types and one named export per state. Never a native-lane file or a `StoryState` wrapper; the lane that would serve those does not exist here.

   A kept Ladle or Histoire is the lane the same way, at the URLs each tool serves; `stories.mjs storybook` names Storybook's ids only. A Ladle repo that opted into the csf lane and has no lane yet continues: its story files become the lane's, and the old tool runs beside it until its removal. Otherwise continue.
4. **Scaffold the lane** per the recipe: the gate, the index, the story wrapper, one example story for the most-used primitive, and package.json scripts `ds:stories` (dev) and `ds:stories:build`. Write the lane's URL, port and dev command into `massimo.config.json` → `stories`, and its include and `storyUrl` (the recipe's, or null) where they still name another tool's stories, as detect's suggestion for a Storybook does. The lane's own pages and wrappers stage components on purpose, so when no glob in `audit.exclude` covers the lane's folder yet (Nuxt's `<srcDir>/stories/`, say), add one, or the audit counts the lane as drift. Do the same for each folder the story build writes that the config's `ignore` does not skip (Nuxt's `.nuxt-stories/` and `.output-stories/`), or the audit reads the bundled CSS. A csf lane already has its stories, so it gets no example story; its scaffold is the recipe's files, the tsconfig include and the output folder's ignore line, and it reports whether that folder was already ignored. Never overwrite: before writing, check every file the recipe creates (the lane's folder and files, its integration or entry file, its story routes, the `ds:stories` scripts), and if any already exists, stop and tell the user which: the repo has a lane or files of its own to keep. The framework's own config (`astro.config.*`, `next.config.*`, `nuxt.config.*`, `svelte.config.js`, `vite.config.*`) always exists: edit it to register the lane, never replace it.
5. **Prove it.**
   - Start the lane in the background. Prefer the host's dev-server/preview tool if it has one (create its launch config entry named `stories`); otherwise run `npm run ds:stories` in the background.
   - Load `/stories` and the example story; check the console for errors.
   - Screenshot it: `node <project>/scripts/shoot.mjs --url <url> --out <project>/shots/stories/<slug>.png` (exit 3 means no Playwright: use the host's browser screenshot tool).
   - **Leak check:** run the production build and confirm no story route, chunk or marker made it into the output (the recipe names the exact check). This is required, not optional.
   - A csf lane also passes `node <project>/scripts/stories.mjs --check`, and loads one old link (`/?story=<id>&mode=preview`) in place.
   - Show the user the screenshot and the index.
6. **Agree the coverage target.** Read the graph's story queue. Recommend: every component used by three or more files, plus all primitives (buttons, inputs, typography, layout). Record the target as a decision, e.g. "story the top 30 by usage".
7. **Write baseline stories in batches.** Take five to eight components from the queue at a time. Dispatch the `story-writer` agent (one agent per two or three related components, several in parallel when they touch different files). Each dispatch includes:
   - plugin root path, repo root, the recipe path, the lane's URL; beside a kept story tool, no recipe: the tool, one of its story files as the format, and its story URL pattern (for Storybook, `stories.storyUrl` and the `stories.mjs storybook` command that fills in each id);
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
