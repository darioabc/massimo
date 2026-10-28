# Changelog

## 0.1.1

- `serve.mjs` renders Markdown as pages: STATUS.md, graph.md, audits, handoffs and briefs open readable in a browser, with a path trail and a Raw link (`?raw` for the file itself).
- A folder with no `index.html` lists its files, with its STATUS.md or README.md rendered under the list, so `npm run ds:serve` opens on the project's status.
- New zero-dependency Markdown renderer (`scripts/lib/markdown.mjs`), vendored with the other scripts. Run `init.mjs --update-scripts` to pick it up in a repo.

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
