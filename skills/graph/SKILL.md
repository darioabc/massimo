---
name: graph
description: Generate and keep current the design-system graph for this repo (every component, what it composes and what uses it, its props and states, its story, the tokens and CSS variables it leans on, and the ds rules a primitive declares) as <project>/graph.md and graph.json. Use for the graph phase of a massimo project, after component changes, or when someone asks what components exist, where one is used, or which ones to story first.
---

# massimo: graph

The graph is the map every other phase reads: stories are written most-used-first from it, tidy batches use it to find what a change touches, the translator maps mockups onto it, and CI checks it stays current. It is generated from source, never edited by hand.

Plugin root: two directories above this skill's base directory. Follow `<plugin>/reference/project.md` → Session protocol. `<project>` is the project folder: `projectDir` in `massimo.config.json`, `design-system` by default.

## Run

1. **Begin** per the session protocol. `state.mjs set graph in_progress`.
2. **Check the globs.** Read `components`, `consumers`, `aliases` and `tokens.styleFiles` in `massimo.config.json`. If the user has not confirmed them, show the component folders and counts and ask. Components are reusable UI pieces; pages, routes and layouts are consumers unless the team treats layouts as components.
3. **Generate.** `node <project>/scripts/graph.mjs`. It prints a one-line summary.
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

Any phase that adds, renames or deletes components re-runs `graph.mjs` before it ends. Run `node <project>/scripts/graph.mjs --check` to see whether the committed graph is stale without writing.

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

`ds:group` places the node in the graph's index by tier (Foundations, Primitives, Patterns, Shells, Pages, Explorations) and group. A value may wrap onto the next comment lines until a blank comment line, code, or another `ds:` key. Use whatever comment syntax the file allows (`<!-- ds:… -->` in Vue/Svelte templates, `//` inside an Astro frontmatter fence). Writing them is the guard phase's job, with the user; do not add them unasked here. An unknown `ds:` key shows up in graph.md as a header fault; a repo that already uses its own keys (say `ds:owner` or `ds:inputs`) lists them in `massimo.config.json` → `graph.extraKeys` so they are read instead.

## A repo with its own header rules

When a repo already has a taxonomy and header keys of its own, the config carries them and the graph checks them, so nothing in the source has to change:

- `graph.keys` gives each of the repo's own keys a role (`list`, `definitions`, `scope`, `breakpoint`). A key with a role is never unknown, and a value its role cannot take (a scope outside its set, a list item that is not a file in its folder) is a header fault.
- `graph.taxonomy` holds the tiers in order, the groups with a line each, the placement test, path rules that give a file its group, the parked marker and its group, and the keys a tier requires. With it, an unknown group, a node with no group, a missing required key and a parked node in the wrong place are faults. graph.md then opens with the placement test (one `- <Tier>: <test>` line per question) and the groups, and the index and the README follow the taxonomy's tier order.
- `graph.header: "top"` reads only the first comment block of a file (inside the frontmatter in an .astro file). A `ds:` line anywhere else, a key written with a colon, a second `ds:group` and a line that opens with `ds:` but is not `ds:key value` are faults. `"anywhere"`, the default, reads every comment.
- `graph.strictFaults: true` makes header faults fail the run and `--check`, after the files are written, so CI stops on them. Off, they are listed in graph.md and the run passes.
- `graph.kinds` makes layouts, pages or any other files nodes of their own kind (`{ "page": ["src/pages/**/*.astro"] }`): they get a group, a story and faults like a component, go by their path (`pages/work/index`), and stop counting as consumers.
- `graph.edges` reads imports that are not import statements: `"mdx"` for the import lines of MDX files in `consumers`, `"glob"` for `import.meta.glob` calls, each an edge to every file its patterns match.
