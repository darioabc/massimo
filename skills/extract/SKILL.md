---
name: extract
description: Extract a full design system from an existing front-end repo in one guided flow. Tokens for every family come from what the code already uses (its CSS variables, Tailwind config, theme objects and token files first, then the raw values the audit finds), in the W3C Design Tokens format. Each primitive gets its props, variants, states and a usage rule, and the system gets a README. Everything is proposed family by family for the user's approval; nothing in the codebase changes without it. Use when a repo has components and styling but no formal design system, or when the user wants to extract, reverse-engineer or document the system a codebase already has.
argument-hint: "[family or step to resume]"
---

# massimo: extract

A repo with components and styling already has a design system: it is spread through the code, unnamed. This skill names it. It reads the values the repo keeps, counts the ones the code uses without a token, proposes a complete token set and a usage rule per primitive, and writes the README a newcomer reads first. The user approves each family; the codebase changes only on their OK.

Plugin root: two directories above this skill's base directory. `<project>` is the project folder: `projectDir` in `massimo.config.json`, `design-system` by default. Follow `<plugin>/reference/project.md` → Session protocol, and judge proposals with `<plugin>/reference/canon.md`.

This flow does the graph, tokens and documentation work of three phases in one sitting. It records progress against those phases (`graph`, `tokens`, `guard`), so `/massimo:start` and STATUS.md show it, and an existing project's state does not change shape.

## Before starting

- No `massimo.config.json` → run the start skill's Kickoff first (detect, a few questions, `init.mjs`), then come back. Say that extract covers graph, tokens and docs.
- An existing token set (`tokens.mjs check` reads it): extract still helps (it proposes what the set lacks), but say so and agree whether to extend the set or start a draft beside it.
- A resume: read `<project>/tokens/draft/report.md` and the decisions log, tell the user which families are approved, and continue from the next one.
- CSS that has to stay the source (its file also holds component classes, or scripts read it as it is): the token set is a mirror of it, not a draft beside it. Say so, and follow the tokens skill's step 3 for `tokens.mirror` instead of steps 4 to 6 here: it sets `minScripts` to `0.3.0`, and runs `tokens.mjs resolved` after mirror and build.

## Run

1. **Begin.** `state.mjs set tokens in_progress --note "extract: reading the repo"`.
2. **Sources.** Show what `massimo.config.json` → `tokens` will read, from detect: `styleFiles` (CSS custom properties, `@theme`, DaisyUI themes), `tailwindConfig`, `themeFiles` (CSS-in-JS or JS themes), `importFiles` (DTCG or Tokens Studio JSON), and `figmaExport` (Figma variables exported as JSON, if the user has one). Ask the user to confirm or correct them in one question. JavaScript is read as text, never run, so a config's spreads and computed values are skipped and named.
3. **Audit and graph.** `node <project>/scripts/audit.mjs` (the "before": canon numbers, colour clusters with what each is used for, and the inventory of line heights, weights, shadows, borders, motion, layers and opacity). `node <project>/scripts/graph.mjs` (components, props, variants, states, usage). Fix the graph's unresolved imports as the graph skill says, then `state.mjs set graph done --note "<N> components"` (or `in_progress` with what is left).
4. **Propose.** `node <project>/scripts/tokens.mjs extract`. It writes a 2025.10 draft in `<project>/tokens/draft/` and `report.md`: every token with its value and where it came from (a source file, or "used N× in code"), family by family, the assumptions it made, and the values the code uses that were not proposed (used once, off the grid, off a scale the sources define, or only ever data). Build the preview of the draft: `tokens.mjs preview --source <project>/tokens/draft/tokens.resolver.json`, serve the project folder (`serve.mjs`) and open `/tokens/preview.html`. Check its contrast: `tokens.mjs check --source <project>/tokens/draft/tokens.resolver.json`.
5. **Review, family by family.** In this order, one decision each: colour primitives (ramps and overlays), colour semantics (with the contrast results per theme), typography (families, weights, sizes, composites), spacing, radius, shadow and border, motion, layers and opacity. For each, show the report's table for that family, point out every assumption and every value that came from the code rather than a source, and the rare values left out. Ask: approve, change, or drop. Edit the draft files to match (the format rules are in the tokens skill, step 5); keep every existing CSS variable's name through `$extensions.massimo.cssVar`. Record each family with `state.mjs decide "tokens: <family> approved, <what changed>" --phase tokens`, and note progress (`state.mjs set tokens in_progress --note "<n>/9 families approved"`) so a stop at any point resumes cleanly.
6. **Adopt the tokens.** With every family approved, move the draft's files into `<project>/tokens/` and set `tokens.source` to `<project>/tokens/tokens.resolver.json`. Then the tokens skill's steps 6 to 9 (outputs, build, wiring, proving nothing moved, contrast), each one asked first, since they write into the codebase. `state.mjs set tokens done --note "<n> tokens, <outputs>"`.
7. **Components.** From `graph.md`, take the primitives (tier Primitives, or the most used where there is no tier yet), in batches of five to eight. For each, show its props with their values and defaults, how call sites use them, its states, and the tokens and variables it reads. Draft its `ds:group` and one `ds:use-when` sentence (when to reach for it instead of its neighbours, from how it is actually used), and a `ds:never` only where the code shows a real misuse. Show the batch in one list; the user approves or rewrites each line. Write the accepted lines as comments at the top of each component file (the graph skill's ds headers section) only after that OK, re-run `graph.mjs`, and check they show under rules with no header faults. Record the batch with `state.mjs decide`. `state.mjs set guard in_progress --note "rules on <n> primitives"`.
8. **Docs.** `node <project>/scripts/docs.mjs` writes `<project>/README.md`: the token set with every semantic token's meaning, the contrast pairs, how to change tokens, each component with its rule and props, and how to start a design. Show it. Write the hand-written part around the generated block with the user: who decides what (from `product.md` → Team), and anything the team wants a newcomer to know.
9. **End.** Tell the user, in a few lines: how many tokens per family and how many came from the code, how many primitives have rules, what changed in the codebase (token outputs, their imports, ds headers) and what stayed in `<project>/`. The next steps are the tidy phase (move raw values onto the new tokens, in batches) and the guard phase (`ds:check` in CI, which also keeps the README current). Follow the session protocol's End steps.

## Rules

- Values come from the repo, never from taste: its sources first, then what the code uses at least twice. Where a composite needs a part the code never states, say what was assumed and let the user decide.
- Nothing outside `<project>/` changes without the user's OK: not the token outputs, not the imports, not a ds header.
- Never rename or delete an existing CSS variable. Keep old names working through `cssVar` until tidy moves their consumers.
- A drafted description or usage rule is a proposal. Mark it as one until the user approves it.
