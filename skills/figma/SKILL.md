---
name: figma
description: Mirror this repo's design system into a Figma library — tokens as Figma variables with light and dark modes, text and effect styles, and the primitives as Figma components with variants matching their stories — then report where Figma has drifted from code. Code stays the source of truth. Use for the figma phase of a massimo project, or when the user wants the design system in Figma, a Figma library from code, or a code-vs-Figma drift check.
---

# massimo: figma

Designers work in Figma; the system lives in code. This skill keeps a Figma library that mirrors the code: variables from `tokens.json`, components from the stories. It never writes Figma changes back into code on its own: drift is reported, and the user decides per item whether code changes (then re-mirror) or Figma is corrected.

Plugin root: two directories above this skill's base directory. Follow `<plugin>/reference/project.md` → Session protocol.

## Requirements

- **Figma's official MCP server and skills.** Look for the Figma tools (`use_figma`, `create_session`, `get_variable_defs`, `get_screenshot`, `search_design_system`) and the skills `figma-use` and `figma-generate-library`, loading deferred tools through tool search if needed. Missing → tell the user to install Figma's official Claude Code plugin (`/plugin install figma@claude-plugins-official`) and authorise it via `/mcp`, then stop. Present but erroring on connection → ask the user to restart Claude Code or re-authorise; do not work around it.
- **Load `figma-use` before every `use_figma` call, and `figma-generate-library` for the mirror.** They own how to call the Figma Plugin API and in what order to build a library. This skill owns what to build and how it maps to code. Follow their instructions where they are more specific.
- `tokens.json` should exist (tokens phase). Without it, offer to extract a draft first (`tokens.mjs extract`) or mirror components only.
- The story lane should exist; components are mirrored from their stories' states and screenshots.

## Run

1. **Begin.** `state.mjs set figma in_progress`.
2. **Target file.** Ask for the Figma library file URL. No file yet → create one (the `figma-create-new-file` skill), named "<product> design system". Open a Figma session for it (`create_session` with the file key) per the Figma server's instructions. Save the key in `massimo.config.json` → `figma.fileKey`.
3. **Scope.** Agree one scope with the user, in this order of value: tokens only → tokens + the top primitives (from the graph's most-used list, usually 8–15) → everything storied. Record it.
4. **Variables.** `node design-system/scripts/tokens.mjs build` refreshes `design-system/tokens/figma-variables.json`: collections (Primitives, Semantic), modes (Light, Dark, …), variables with `/`-separated names, aliases, and `codeSyntax.WEB` set to the CSS variable. Create or update exactly that in Figma, aliases preserved. Set variable scopes by type (colours on fills/strokes as their semantics say, spacing on gap/padding, radius on corner radius). Create text styles from the type tokens and effect styles from the shadow tokens.
5. **Components.** For each in-scope component, read its source, its story file (the states), its story screenshot (`design-system/shots/stories/`, or take one), and its graph node. Build a Figma component set whose variant properties match the component's real props (variant, size, state), every fill, stroke, radius, gap and text bound to the variables and styles from step 4, never raw values. Show each component's states as instances in one review frame and compare with the story screenshot; fix what does not match before moving on. Work in batches of three to five components, with a screenshot check per batch shown to the user.
6. **Record the mirror** in `design-system/figma/mirror.json`:
   ```json
   {
     "fileKey": "…",
     "syncedAt": "2026-10-28",
     "tokensHash": "<sha256 of tokens.json>",
     "variables": { "color.bg.default": "VariableID:…" },
     "components": { "src/components/Button.tsx": { "nodeId": "…", "name": "Button", "variants": ["variant", "size", "state"] } }
   }
   ```
   Compute the hash with `node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('design-system/tokens/tokens.json')).digest('hex'))"`.
7. **Code Connect (optional).** If the user's Figma plan supports it and they want it, link each mirrored component to its code file with the `figma-code-connect` skill, so Dev Mode shows the real import.
8. **End.** `state.mjs set figma done --note "<n> variables, <m> components mirrored"`.

## Drift check (any time later)

Run when the user asks, or when `tokens.json` no longer matches `mirror.json`'s `tokensHash`.

1. Read the Figma variables (`get_variable_defs`, or a read-only `use_figma` script) and the mirrored components' properties.
2. Compare with `tokens.json` (values per mode, names, aliases) and the components' current props and stories.
3. Write `design-system/figma/drift.md`: one line per difference, grouped as **code changed** (Figma is stale: re-mirror), **Figma changed** (a designer edited the library: decide), **only in Figma**, **only in code**.
4. For each "Figma changed" item, ask the user: adopt it in code (edit `tokens.json` or the component, then rebuild and re-mirror) or revert Figma. Record each choice with `state.mjs decide`. Never edit code from Figma values without that yes.

## Rules

- Code is the source of truth. Figma mirrors it; designers' Figma edits are proposals until accepted.
- Bind everything to variables and styles. A raw hex in a mirrored component is a defect.
- Names in Figma follow the token paths and component names in code, so a designer and a developer say the same word for the same thing.
