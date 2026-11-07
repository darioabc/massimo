---
name: tokens
description: Audit the repo's styling for raw colours, sizes, spacing and fonts, then define design tokens with the user — primitives, semantic tokens, light and dark — in one W3C DTCG source that builds into the repo's own styling (CSS variables, Tailwind 4 or 3, SCSS, TS) and into Figma variables. Use for the tokens phase of a massimo project, or when the user asks about design tokens, the colour palette, the type scale or the spacing scale.
---

# massimo: tokens

One source of truth for every design value, written in the W3C Design Tokens format 2025.10 in `<project>/tokens/`, built into whatever the repo's styling consumes. The audit shows how far the code has drifted; the proposal shows how far the tokens will bring it back. The user approves each group before anything is wired in.

Plugin root: two directories above this skill's base directory. Follow `<plugin>/reference/project.md` → Session protocol, and judge proposals with `<plugin>/reference/canon.md`. `<project>` is the project folder: `projectDir` in `massimo.config.json`, `design-system` by default.

## Run

1. **Begin.** `state.mjs set tokens in_progress`.
2. **Audit.** `node <project>/scripts/audit.mjs`, then read `<project>/audits/latest.md`. Tell the user the canon numbers in one short block (distinct colours and clusters, font sizes, families, off-grid spacing, arbitrary values), plus the three files that leak the most. That is the "before".
3. **Start from what exists.** If the project still has a `tokens.json` from before 0.2.0 (`tokens.mjs check` reads it fine), offer `node <project>/scripts/tokens.mjs migrate` first: it writes the 2025.10 files beside it, lists in `tokens/migration-report.md` anything that did not carry over exactly, checks every output still builds the same, and points the config at the new files. Show the user the report. Otherwise, if the style files already define custom properties (`tokens.styleFiles` in config), run `node <project>/scripts/tokens.mjs extract`. It writes a 2025.10 draft in `tokens/draft/` with dark and other themes, and `tokens/draft/report.md` for any value it had to type or could not convert exactly. Existing names are a starting point, not a constraint.
4. **Propose, group by group.** Work through the groups in this order, one decision each, so a designer can approve in a sitting:
   1. **Colour primitives**: neutral ramp, brand ramp, status hues. Use the audit's clusters to pick values the product already uses (the cluster representative), not new ones.
   2. **Colour semantics**: surface, text, border, accent, focus, status, for light and dark. Every semantic token aliases a primitive (`"{color.neutral.900}"`). Mark each pair that must be legible with `$extensions.massimo.contrast: { "on": "<the token it sits on>", "use": "text" }` so contrast is checked in every theme. `use` sets the WCAG 2.2 minimum: `text` 4.5:1, `large-text` 3:1, `ui` and `focus` 3:1.
   3. **Type**: families (at most two, per the canon), a size scale of six to eight steps, weights, line heights.
   4. **Spacing**: the base unit (usually 4px) and the steps the product actually uses.
   5. **Radius, shadow, motion**: three or four steps each.
   For each group show a compact table (name → value → what it replaces from the audit) and how it moves the canon numbers ("38 greys → 9 neutrals"). Build the preview so the user sees it, not just reads it: `node <project>/scripts/tokens.mjs preview`, serve the project folder (`serve.mjs`), open `/tokens/preview.html`. Record each approved group with `state.mjs decide`.
5. **Write the token set** in 2025.10, starting from the approved draft: `tokens/base.tokens.json` holds every token's default value, `tokens/theme/<context>.tokens.json` what changes in dark (or another theme), and `tokens/tokens.resolver.json` ties them together; set `tokens.source` to the resolver. The spec is strict: every token has a `$type` (its own or its group's; never guessed), colours are objects (`{ "colorSpace": "oklch", "components": [0.7, 0.1, 200] }`), sizes are `{ "value": 4, "unit": "px" }` in px or rem, durations in ms or s, typography is one object with fontFamily, fontSize, fontWeight, letterSpacing and lineHeight. Aliases are in braces, `$description` goes on every semantic token. A value the spec cannot hold (`clamp()`, a length in em) keeps its exact CSS in `$extensions.massimo.css` beside the nearest valid `$value`. `tokens.mjs check` names every problem with its token path. Keep names semantic for anything components consume (canon → Meaning before value); once tokens exist, the audit counts components that read a primitive directly (`primitive-read`), and tidy moves them onto semantic tokens.
6. **Choose outputs with the user's stack** in `massimo.config.json` → `tokens.outputs`. Match how the app switches theme today: `darkSelector` (`.dark`, `[data-theme="dark"]`), `darkMedia` (whether dark also follows the system setting), `defaultMode` (the default theme's name, `light` unless the app calls it something else), and `selectors` for any mode whose selector is not the dark one with the name swapped in (`{ "brand": "[data-brand=\"acme\"]" }`):
   - plain CSS / CSS modules / any framework → `{ "format": "css", "path": "src/styles/tokens.css" }`
   - Tailwind 4 → `css` plus `{ "format": "tailwind4", "path": "src/styles/tokens.theme.css" }`, imported after `@import "tailwindcss"`
   - Tailwind 3 → `css` plus `{ "format": "tailwind3", "path": "tokens.tailwind.cjs" }`, spread into `theme.extend`
   - DaisyUI → `css` plus the theme block mapping DaisyUI's `--color-*` names to the semantic tokens (write it by hand in the theme file; aliases keep it in sync)
   - Sass → `scss`; CSS-in-JS → `ts`
   - For coding agents, add `{ "format": "designmd", "path": "DESIGN.md" }`: Google Labs' DESIGN.md (format version alpha, pinned to release 0.4.0), with the default theme's colours, typography, radii and spacing in its front matter and the components' rules from the graph in its prose. The format has no themes, so the file names the others and says they live in code. Set `name` in `massimo.config.json` for its title (the package name otherwise).
7. **Build and wire.** `node <project>/scripts/tokens.mjs build`. Import the outputs where the app loads its global CSS or theme config. Add `"ds:tokens": "node <project>/scripts/tokens.mjs build"` to package.json. Do not yet rewrite components to use the tokens: that is the tidy phase.
8. **Prove nothing broke.** Run the app's build. If the story lane exists, screenshot five of the most-used components' stories before step 7 and after (`shoot.mjs`, then `shoot.mjs --diff`). Wiring tokens should change nothing visible yet; any diff is a wiring mistake (an overridden variable, a changed default) to fix now.
9. **Contrast.** `node <project>/scripts/tokens.mjs check`. List failing pairs against the accessibility bar in `product.md`, and resolve each with the user (adjust the token or accept it with a recorded reason).
10. **Kit.** The build also refreshed `<project>/kit/kit.css`, so ux mockups now use the real tokens.
11. **End.** `state.mjs set tokens done --note "<n> tokens, <outputs>"`. Next step: tidy.

## Rules

- Values come from the product (audit clusters, extracted variables) before they come from taste.
- Never delete or rename an existing CSS variable in this phase. Keep old names working (alias them to the new tokens) until tidy migrates their consumers.
- The token files are edited by hand or by you; generated files never are. Every generated file says so in its header.
- A designer can veto any value. A developer can veto any wiring. Record both.
