---
name: figma
description: Mirror this repo's design system into a Figma library: tokens as Figma variables with their themes as modes, text styles from typography tokens, effect styles from shadow tokens, and the primitives as Figma components with variants matching their stories. Then report where Figma has drifted from code. Code stays the source of truth. Use for the figma phase of a massimo project, or when the user wants the design system in Figma, a Figma library from code, or a code-vs-Figma drift check.
---

# massimo: figma

Designers work in Figma; the system lives in code. This skill keeps a Figma library that mirrors the code: variables and styles from the token set, components from the stories. It never writes Figma changes back into code on its own: drift is reported, and the user decides per item whether code changes (then re-mirror) or Figma is corrected.

Plugin root: two directories above this skill's base directory. Follow `<plugin>/reference/project.md` → Session protocol. `<project>` is the project folder: `projectDir` in `massimo.config.json`, `design-system` by default.

## Requirements

- **Figma's official Claude Code plugin** (`figma@claude-plugins-official`): its MCP tools (`create_session`, `use_figma`, `create_new_file`, `get_screenshot`, `search_design_system`) and its skills `figma-use`, `figma-generate-library` and `figma-create-new-file`. Load deferred tools through tool search if needed. Missing → tell the user to install it (`/plugin install figma@claude-plugins-official`) and authorise it via `/mcp`, then stop. Present but erroring on connection → ask the user to restart Claude Code or re-authorise; do not work around it.
- **Load `figma-use` before every `use_figma` call, and `figma-generate-library` for the mirror.** They own how to call the Plugin API and in what order to build a library. This skill owns what to build and how it maps to code. Follow their instructions where they are more specific.
- A token set should exist (tokens phase). Without one, offer to extract a draft first (`tokens.mjs extract`) or mirror components only.
- The story lane should exist; components are mirrored from their stories' states and screenshots. A story tool the team keeps (Storybook, Ladle, Histoire) counts as the lane.

## Run

1. **Begin.** `state.mjs set figma in_progress`.
2. **Target file.** Ask for the Figma library file URL. No file yet → load the `figma-create-new-file` skill, then create one with `create_new_file`, named "<product> design system". Open a Figma session for it (`create_session` with the file key). Save the key in `massimo.config.json` → `figma.fileKey`.
3. **Scope.** Agree one scope with the user, in this order of value: tokens only → tokens + the top primitives (from the graph's most-used list, usually 8–15) → everything storied. Record it.
4. **Variables and styles.** `node <project>/scripts/tokens.mjs build` refreshes `<project>/tokens/figma-variables.json`. First read what the file already holds with `read-library.js` (step 5's read), save it as `<project>/figma/export.json`, and run `node <project>/scripts/tokens.mjs figma --pairs <project>/figma/export.json`. It writes nothing: it lists which Figma variables pair with which tokens and what differs. A variable someone made by hand whose code syntax names a token's CSS variable is that token's variable, and the notes list each one. Update a paired variable's value, scopes and description where it is; keep its name and collection unless the user asks to move it, and never create a second variable beside it. Then create or update exactly what the list holds:
   - **Collections and modes.** Each collection lists only the modes its own variables change in (a collection of ramps often has one). The first mode is the default theme (`defaultMode`).
   - **Variables**, with `/`-separated names, their `type`, their `scopes` exactly as given (never `ALL_SCOPES`), a value per mode, `codeSyntax.WEB` set to the CSS variable, and the description. An alias names the variable and the collection it points into; create it with `createVariableAlias`. Lengths are in px (a rem is 16px), durations in ms.
   - **Text styles** from `textStyles`: font family, size, weight, line height and letter spacing, with every field in `boundVariables` bound to its variable (`setBoundVariable`). `fontStyle` is the usual name for the weight; check it against the font's own styles (`listAvailableFontsAsync`) and use the font's name for that weight.
   - **Effect styles** from `effectStyles`: one effect per shadow layer (`INNER_SHADOW` for an inset one), each field in its `boundVariables` bound with `setBoundVariableForEffect`.
   - `notMirrored` lists tokens Figma has no variable for (easings, transitions, gradients, borders, CSS-only values). Tell the user they stay in code; do not invent a stand-in.
   - **When the file allows fewer modes.** Figma's Starter plan allows one mode per collection (Professional four). If `addMode` fails with "Limited to N modes", keep each collection on its default mode, fill the default values only, tell the user that the other themes stay in code until the file is on a plan with more modes, and carry on. Do not split a theme into a second collection.
5. **Record the mirror.** Read back what the file now holds: run `<plugin>/skills/figma/read-library.js` as the code of one `use_figma` call. It is read-only and returns every variable in every mode, aliases resolved to names, and the text and effect styles. Save the JSON it returns as `<project>/figma/export.json`, then run `node <project>/scripts/tokens.mjs figma --record <project>/figma/export.json --file-key <key>`. It compares the file with code, prints each mismatch, and writes `<project>/figma/mirror.json`: the tokens' hash, the date, whether every mode or only the default was mirrored, and each variable's id and values as mirrored. Fix the mismatches in Figma and record again until there are none.
6. **Components.** For each in-scope component, read its source, its story file (the states), its story screenshot (`<project>/shots/stories/`, or take one; beside a kept Storybook, shoot the iframe URL that `node <project>/scripts/stories.mjs storybook <component file>` prints, with `--selector '#storybook-root'`, starting Storybook only with the user's OK), and its graph node. Build a Figma component set whose variant properties match the component's real props (variant, size, state), every fill, stroke, radius, gap and text bound to the variables and styles from step 4, never raw values. Show each component's states as instances in one review frame and compare with the story screenshot; fix what does not match before moving on. Work in batches of three to five components, with a screenshot check per batch shown to the user. Add each to `mirror.json` → `components`: `{ "src/components/Button.tsx": { "nodeId": "…", "name": "Button", "variants": ["variant", "size", "state"] } }` (recording again keeps them).
7. **Code Connect (optional).** If the user's Figma plan supports it and they want it, link each mirrored component to its code file with the `figma-code-connect` skill, so Dev Mode shows the real import.
8. **End.** `state.mjs set figma done --note "<n> variables, <m> components mirrored"`. Commit `mirror.json` and `export.json` with the phase.

## Drift check (any time later)

Run when the user asks, or when `tokens.mjs check` reports `figma mirror behind` (the tokens changed since `mirror.json` was recorded).

1. Read the file again with `read-library.js` (one read-only `use_figma` call) and save the result over `<project>/figma/export.json`. Do not use `get_variable_defs` for this: it reads the variables one node uses, not the library, and shows neither modes nor aliases.
2. `node <project>/scripts/tokens.mjs figma --drift <project>/figma/export.json` compares code now, the mirror as recorded, and Figma now, and writes `<project>/figma/drift.md` grouped as **code changed** (Figma is behind: mirror again), **Figma changed** (a designer edited the library: decide), **changed on both sides**, **only in Figma** and **only in code**.
3. For the mirrored components, compare their properties with the components' current props and stories by hand, and add what differs to `drift.md`.
4. For each "Figma changed" or "changed on both sides" item, ask the user: adopt it in code (edit the token files or the component, then rebuild and mirror again) or revert Figma. Record each choice with `state.mjs decide`. Never edit code from Figma values without that yes.

## Rules

- Code is the source of truth. Figma mirrors it; designers' Figma edits are proposals until accepted.
- Bind everything to variables and styles. A raw hex in a mirrored component is a defect.
- Names in Figma follow the token paths and component names in code, so a designer and a developer say the same word for the same thing.
