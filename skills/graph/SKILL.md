---
name: graph
description: Generate and keep current the design-system graph for this repo — every component, what it composes and what uses it, its story, the tokens and CSS variables it leans on, and the ds rules a primitive declares — as design-system/graph.md and graph.json. Use for the graph phase of a massimo project, after component changes, or when someone asks what components exist, where one is used, or which ones to story first.
---

# massimo: graph

The graph is the map every other phase reads: stories are written most-used-first from it, tidy batches use it to find what a change touches, the translator maps mockups onto it, and CI checks it stays current. It is generated from source, never edited by hand.

Plugin root: two directories above this skill's base directory. Follow `<plugin>/reference/project.md` → Session protocol.

## Run

1. **Begin** per the session protocol. `state.mjs set graph in_progress`.
2. **Check the globs.** Read `components`, `consumers`, `aliases` and `tokens.styleFiles` in `massimo.config.json`. If the user has not confirmed them, show the component folders and counts and ask. Components are reusable UI pieces; pages, routes and layouts are consumers unless the team treats layouts as components.
3. **Generate.** `node design-system/scripts/graph.mjs`. It prints a one-line summary.
4. **Fix resolution.** Open `graph.md` → Unresolved imports. Each unresolved relative or alias import is a missing edge. Fix the cause in config (an alias missing from `aliases`, a tsconfig path detect did not see, a component folder outside the globs) and re-run until the list is empty or each remaining entry is explained (generated files, virtual modules). Record config changes as decisions.
5. **Sanity-read three nodes** you can verify quickly against the code: one heavily used primitive, one leaf, one composite. If an edge is wrong, find out why before going on.
6. **Report** to the user in plain terms:
   - how many components, how many with a story;
   - the five most-used components (they are the system's real primitives, whatever the folders say);
   - the story queue's top five (most-used without a story);
   - anything surprising: duplicate names, near-duplicate components (`Button`, `Btn`, `PrimaryButton`), components nothing imports.
   Near-duplicates and dead components go into `STATUS.md` → Open questions for the tidy phase; do not fix them here.
7. **Wire the script.** `package.json` should have `ds:graph` (init adds it). The `--check` mode joins CI in the guard phase.
8. **End.** `state.mjs set graph done --note "<N> components, <S> with stories"`. Next step: stories.

## Re-running later

Any phase that adds, renames or deletes components re-runs `graph.mjs` before it ends. Run `node design-system/scripts/graph.mjs --check` to see whether the committed graph is stale without writing.

## ds headers

Components declare their place in the system in comment lines at the top of their file, which the graph harvests:

```tsx
// ds:group Primitives / Actions
// ds:use-when one primary action per view; secondary actions use variant="secondary"
// ds:parents Card, Dialog, Toolbar
// ds:children Icon, text
// ds:never nest a Button inside a Button; use variant="ghost" for icon-only actions in toolbars
// ds:no-story <reason>   (only on a component that deliberately has no story)
```

`ds:group` places the node in the graph's index by tier (Foundations, Primitives, Patterns, Shells, Pages, Explorations) and group. A value may wrap onto the next comment lines until a blank comment line, code, or another `ds:` key. Use whatever comment syntax the file allows (`<!-- ds:… -->` in Vue/Svelte templates, `//` inside an Astro frontmatter fence). Writing them is the guard phase's job, with the user; do not add them unasked here. An unknown `ds:` key shows up in graph.md as a header fault; a repo that already uses its own keys (say `ds:sheet` or `ds:inputs`) lists them in `massimo.config.json` → `graph.extraKeys` so they are read instead.
