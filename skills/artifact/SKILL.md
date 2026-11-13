---
name: artifact
description: Publish this repo's design system as one folder a reader can open: a brand book, tokens as lists, a page and a still preview per component, fonts and assets. The folder follows the layout of a Claude design system artifact and is plain Markdown, JSON, HTML and CSS, so it can go to a Claude design system, a static host, or another agent. Keeps the reader's pages in the project folder, and says when a published copy has fallen behind the code. Use for the artifact phase of a massimo project, or when the user wants the design system as a Claude design system artifact, a shareable design system page, or a folder to hand to another tool.
---

# massimo: artifact

The design system lives in code. This skill gives it a reader's side: pages people and agents read, kept in the project folder, and one folder built from them to publish. Code stays the source of truth. Nothing here edits a token or a component.

Plugin root: two directories above this skill's base directory. Follow `<plugin>/reference/project.md` → Session protocol. `<project>` is the project folder: `projectDir` in `massimo.config.json`, `design-system` by default.

Every step but the last is a script, so any agent can run it. Only the upload differs by tool.

## What the project folder keeps

The reader's side sits in the project folder in the same shape it is published in:

| In `<project>/` | What | Written by |
|---|---|---|
| `README.md` | the brand book: how the product writes, how colour, type, spacing and motion are used, as rules that name tokens | the team and the guard phase; `docs.mjs` keeps its generated block |
| `sections/<name>.md` | further sections of the brand book | `artifact.mjs pages` for the tokens the lists cannot hold (motion, borders, gradients, CSS-only values); the team for any other |
| `components/<Name>/README.md` | one page per component: when to use it, its rules, props, what it is built from, who uses it | `artifact.mjs pages`, from the graph |
| `assets/<Group>/` | logos, icons, illustrations, each group with a `README.md` saying what is in it | the team; `artifact.assets` in the config copies repo files in at build time |
| `fonts/` | font files the team wants listed beyond the ones the story build declares | the team |

The build adds what differs in form: `tokens.json` as lists (the token set stays in the W3C format, which is the source), a `preview.html` per component, and under `site/` the stylesheets, fonts and pictures those previews load.

## Requirements

- A graph (graph phase). Without one the folder has no components.
- A token set (tokens phase) for `tokens.json`. Without one the folder still builds, with the brand book and the component pages.
- For previews, a static build of the story lane: the lane's own build command into `stories.outDir`, or any folder passed as `--built`. A preview is the story's built page without its scripts, a still of what the page renders. A lane that draws its states in the browser gets pages and no previews, and the report says so.

## Run

1. **Begin.** `state.mjs set artifact in_progress`.
2. **Pages.** `node <project>/scripts/artifact.mjs pages` writes `components/<Name>/README.md` and the generated sections. Read three of the pages. A page with no rule opens with the component's name and group only: that is the graph saying the component has no `ds:use-when` line yet. Offer to add the rules through the guard skill instead of writing them into the page, which is generated.
3. **Brand book.** Read `<project>/README.md`. If it is the scaffold or thin, write it with the user from `<project>/product.md`, the token set and real copy in the product: content fundamentals (tone, casing, the words the product uses for its own things, quoted from real screens), visual foundations (rules that name tokens), iconography. Imperative sentences. No value that is not in the code.
4. **Scope.** Agree which components the folder holds. Every storied node by default; `artifact.components` in the config narrows it to tiers or groups (`["Primitives", "Foundations / Brand"]`). A first folder with the primitives only is a fine start: say what is left out.
5. **Assets.** Ask where the logos and icons live. Put them under `<project>/assets/<Group>/` with a one-line `README.md` per group, or name them in `artifact.assets` as `[{ "group": "Logos", "include": ["public/logo*.svg"] }]`. Copy files as they are. Never redraw a mark.
6. **Build the story lane**, with the user's OK since it runs the repo's code: the lane's build script (`stories:build`, `ds:stories:build` or the command in the stories recipe).
7. **Plan, then build.** `node <project>/scripts/artifact.mjs plan --built <dir>` prints what a build would hold. Then `artifact.mjs build --built <dir>` writes `<project>/artifact/project/`, `files.json` and `report.md`. Read `report.md` to the user in a few lines: tokens in the lists and outside them, components with and without a preview and why, files the previews name that the build lacks.
8. **Trim the previews**, if the story pages carry chrome around their states (a header, links to other stories): set `artifact.previewSelect` to the one element that holds the states (`#id`, `.class` or `[attr]`) and build again.
9. **Look.** Open two previews from `<project>/artifact/project/components/` in a browser, in each theme, before publishing. Every path in the folder is relative, so `serve.mjs` or a file URL shows what a reader will see.
10. **Publish** to the target the user wants (below), then `node <project>/scripts/artifact.mjs record --url <url> --target <name>`.
11. **End.** `state.mjs set artifact done --note "<n> components, <m> previews, published to <target>"`. Commit the pages, the sections, `artifact/kept/` and `artifact/mirror.json`. The build itself is not committed.

## Publishing to a Claude design system artifact

For a host with the Artifact tool. The Design System type carries its own instructions and they win where they are more specific: read them from the artifact once it exists.

1. **Target.** Ask for the design system's link, or make one from the Design System artifact type with the system's name as its title.
2. **Uploads.** Each file `files.json` marks `"upload": true` (a picture, video or PDF under `assets/`) is uploaded as an asset, not sent as a file. Keep the id each upload returns.
3. **Index.** Write `<project>/artifact/kept/design-system.json`: `v` 3, `layout` `files`, `createdOnFiles` with the time, the `title`, `namespace`, `libraries` as `[]` (the previews are stills and load no library), `groups` and `assetGroups` with a record per upload, and `lastChange`. On a later publish read the live index first and keep its keys.
4. **Cover.** Write `<project>/artifact/kept/components/Cover/preview.html` last, from what the system turned out to be, following the type's cover brief: the palette as large blocks, one pattern, the name. Every fill bound to a token.
5. **Build again**, so the kept files are in the folder, then send the files: at most 255 in one call, the index in the last call.
6. **Check the live page.** The cover, the brand book, the token views and three previews, in both themes.

Two things the type's token views do, so the user is not surprised: a token edited on the page changes the token view and not the previews, since the previews load the built stylesheet; and the component previews are labelled as static.

## Publishing anywhere else

The folder needs nothing from massimo to be read.

- **A static host, or a zip for a person:** send `<project>/artifact/project/` as it is. Start from `README.md`; each preview opens on its own.
- **Another agent or tool:** give it `<project>/artifact/` and say that `files.json` lists every file with its size and media type, and `report.md` says what is in the folder and what is left out.

## Keeping it current

`node <project>/scripts/artifact.mjs status` says whether the published copy is behind the tokens or the graph since it was recorded. `ds:check` runs `artifact.mjs pages --check`, so a component or token change that leaves a page stale fails CI until `artifact.mjs pages` runs. To publish again: build the lane, build the folder, send only the files that changed, record.

## Rules

- Code is the source of truth. A generated page is never edited by hand: change the component's `ds:` lines or the tokens, then run `artifact.mjs pages`.
- Nothing is dropped silently. A token the lists cannot hold goes into a section, and a component without a preview is named in the report with the reason.
- Values are the code's. Never round, rename or invent one to make it fit a view.
- Assets are copied. Never redraw a logo or an icon.
- Ask before running the repo's build, and before publishing anywhere a person outside the team can see.
