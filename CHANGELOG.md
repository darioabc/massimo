# Changelog

## 0.1.0

First release.

- Skills: start, status, graph, stories, tokens, tidy, guard, ux, figma.
- Agents: baseline, reviewer, visual-reviewer, ideator, translator, story-writer, tidy-worker.
- Scripts (zero-dependency, vendored into the repo): detect, init, state, graph, audit, tokens, canvas, serve, shoot, session-start.
- Story-lane recipes: Vite (React, Preact, Vue, Svelte, Solid), Next.js, Astro, SvelteKit, Nuxt, other.
- SessionStart hook that tells a new session where the project stands.
- Graph: tiers and groups from `ds:group`, `ds:no-story`, header faults, a story queue by usage, and `graph.extraKeys` for a repo's own `ds:` keys.
- Audit: colours, arbitrary values, lengths, font families, primitive reads, undefined `var()` reads and Tailwind palette keys, with a per-offender ratchet (`--baseline`, `--lower`, `--check`). Style files are audited too, except their token declarations.
- Tokens: W3C DTCG source with modes and contrast pairs, built into CSS, Tailwind 4, Tailwind 3, SCSS, JSON, TS, Figma variables and the mockup kit; a visual preview page.
