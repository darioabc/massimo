---
name: tokens
description: Audit the repo's styling for raw colours, sizes, spacing and fonts, then define design tokens with the user — primitives, semantic tokens, light and dark — in one W3C DTCG source that builds into the repo's own styling (CSS variables, Tailwind 4 or 3, SCSS, TS) and into Figma variables. Use for the tokens phase of a massimo project, or when the user asks about design tokens, the colour palette, the type scale or the spacing scale.
---

# massimo: tokens

One source of truth for every design value, written as W3C DTCG JSON in `design-system/tokens/tokens.json`, built into whatever the repo's styling consumes. The audit shows how far the code has drifted; the proposal shows how far the tokens will bring it back. The user approves each group before anything is wired in.

Plugin root: two directories above this skill's base directory. Follow `<plugin>/reference/project.md` → Session protocol, and judge proposals with `<plugin>/reference/canon.md`.

## Run

1. **Begin.** `state.mjs set tokens in_progress`.
2. **Audit.** `node design-system/scripts/audit.mjs`, then read `design-system/audits/latest.md`. Tell the user the canon numbers in one short block (distinct colours and clusters, font sizes, families, off-grid spacing, arbitrary values), plus the three files that leak the most. That is the "before".
3. **Start from what exists.** If the style files already define custom properties (`tokens.styleFiles` in config), run `node design-system/scripts/tokens.mjs extract`. It writes `tokens/tokens.draft.json` from them, with dark and other modes. Existing names are a starting point, not a constraint.
4. **Propose, group by group.** Work through the groups in this order, one decision each, so a designer can approve in a sitting:
   1. **Colour primitives**: neutral ramp, brand ramp, status hues. Use the audit's clusters to pick values the product already uses (the cluster representative), not new ones.
   2. **Colour semantics**: surface, text, border, accent, focus, status, for light and dark. Every semantic token aliases a primitive (`"{color.neutral.900}"`). Mark text-on-surface pairs with `$extensions.massimo.on` so contrast is checked.
   3. **Type**: families (at most two, per the canon), a size scale of six to eight steps, weights, line heights.
   4. **Spacing**: the base unit (usually 4px) and the steps the product actually uses.
   5. **Radius, shadow, motion**: three or four steps each.
   For each group show a compact table (name → value → what it replaces from the audit) and how it moves the canon numbers ("38 greys → 9 neutrals"). Build the preview so the user sees it, not just reads it: `node design-system/scripts/tokens.mjs preview`, serve the project folder (`serve.mjs`), open `/tokens/preview.html`. Record each approved group with `state.mjs decide`.
5. **Write tokens.json.** DTCG format: groups, `$type`, `$value`, `$description` on semantic tokens, aliases in braces, other modes in `$extensions.massimo.modes`. Keep names semantic for anything components consume (canon → Meaning before value); once tokens exist, the audit counts components that read a primitive directly (`primitive-read`), and tidy moves them onto semantic tokens.
6. **Choose outputs with the user's stack** in `massimo.config.json` → `tokens.outputs` (and `darkSelector` / `darkMedia` to match how the app switches theme today):
   - plain CSS / CSS modules / any framework → `{ "format": "css", "path": "src/styles/tokens.css" }`
   - Tailwind 4 → `css` plus `{ "format": "tailwind4", "path": "src/styles/tokens.theme.css" }`, imported after `@import "tailwindcss"`
   - Tailwind 3 → `css` plus `{ "format": "tailwind3", "path": "tokens.tailwind.cjs" }`, spread into `theme.extend`
   - DaisyUI → `css` plus the theme block mapping DaisyUI's `--color-*` names to the semantic tokens (write it by hand in the theme file; aliases keep it in sync)
   - Sass → `scss`; CSS-in-JS → `ts`
7. **Build and wire.** `node design-system/scripts/tokens.mjs build`. Import the outputs where the app loads its global CSS or theme config. Add `"ds:tokens": "node design-system/scripts/tokens.mjs build"` to package.json. Do not yet rewrite components to use the tokens: that is the tidy phase.
8. **Prove nothing broke.** Run the app's build. If the story lane exists, screenshot five of the most-used components' stories before step 7 and after (`shoot.mjs`, then `shoot.mjs --diff`). Wiring tokens should change nothing visible yet; any diff is a wiring mistake (an overridden variable, a changed default) to fix now.
9. **Contrast.** `node design-system/scripts/tokens.mjs check`. List failing pairs against the accessibility bar in `product.md`, and resolve each with the user (adjust the token or accept it with a recorded reason).
10. **Kit.** The build also refreshed `design-system/kit/kit.css`, so ux mockups now use the real tokens.
11. **End.** `state.mjs set tokens done --note "<n> tokens, <outputs>"`. Next step: tidy.

## Rules

- Values come from the product (audit clusters, extracted variables) before they come from taste.
- Never delete or rename an existing CSS variable in this phase. Keep old names working (alias them to the new tokens) until tidy migrates their consumers.
- `tokens.json` is edited by hand or by you; generated files never are. Every generated file says so in its header.
- A designer can veto any value. A developer can veto any wiring. Record both.
