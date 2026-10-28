# Recipe: other stacks

No ready-made recipe. Build the lane from the contract in `stories/SKILL.md`, choosing the first mechanism the stack supports, and confirm the choice with the user before writing files:

1. **Additive route registration behind a build-time flag.** The framework lets config add routes (Astro `injectRoute`, Nuxt `pages:extend`, React Router config routes, a Remix `routes()` function, Angular `fileReplacements` swapping an `environment.stories.ts` that exports extra routes). Add `/stories` and `/stories/:slug` only when `STORIES=1`. Best option: the app's layouts and providers apply unchanged.
2. **A switched page set.** The framework lets config choose which files are pages (Next `pageExtensions`, SvelteKit `kit.files.routes`). Story pages exist only under the flag.
3. **A second entry on the same bundler.** A lane-only config that extends the app's bundler config and adds its own HTML entry (the Vite recipe). Use when routes cannot be extended and the components do not depend on the app's router context.
4. **Server-rendered apps (Rails, Django, Laravel, Phoenix).** A development-only controller or view at `/stories/<slug>` that renders component partials with fixture data, mounted only in the development environment's routes. The asset pipeline is the app's own.

Whatever you choose:

- Put the flag check in config or routing, never inside the story pages alone (a page that 404s at runtime still ships).
- Add `ds:stories` and `ds:stories:build` scripts, and fill `massimo.config.json` → `stories` (`include`, `devCommand`, `url`, `storyUrl` with `{slug}`, `port`).
- Write the leak check for the stack: build production, then prove no story route or `data-story-state` marker is in the output.
- Record the mechanism and why in `decisions.md`, and add a short "how the lane works" note to `design-system/README.md` in the guard phase.
