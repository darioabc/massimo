# Changelog

## 0.2.0 (unreleased)

### Fixed

- The kit and the token preview show an alias's value in every mode. Before, a token that pointed at another kept its default value in dark mode when only its target changed.
- Colour objects in any DTCG colour space become CSS (`oklch()`, `hsl()`, `color(display-p3 …)` and the rest), and every composite type becomes real CSS: typography (the `font` shorthand plus a variable per part), shadow (one or several, with `inset`), border, transition, gradient and stroke style. References inside a composite stay linked as `var()`. Before, composites came out as `[object Object]` and most colour objects as raw JSON.
- Mode blocks follow `tokens.darkSelector`: with `.dark`, a `brand` mode uses `.brand` and the media query opts out of `.light`. New `tokens.defaultMode` names the default mode (Figma's first mode) and `tokens.selectors` sets any mode's selector. The kit follows the same selectors and `darkMedia`, and still answers to `data-theme` for the canvas. A mode named `default`, or named like the default mode, is an error.
- Two tokens that map to the same CSS variable are an error naming both.
- Figma variables: `em` lengths stay strings instead of becoming rem times 16, an alias names the collection it points into, and each collection carries only the modes its own variables change in.

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
