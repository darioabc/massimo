---
name: tidy
description: Tidy the codebase onto the design system in small, user-approved batches (replace raw colours, sizes and Tailwind arbitrary values with tokens, merge duplicate components, remove dead ones), each batch checked with before/after story screenshots and committed on its own. Use for the tidy phase of a massimo project, or when the user wants to clean up hard-coded styles, consolidate components, or migrate to tokens.
---

# massimo: tidy

Drift comes back unless the clean-up is visible and reversible. So tidy works in batches the user can see: what changes, where, and what it looks like before and after. Each accepted batch is its own commit; a rejected one is discarded with nothing else touched.

Plugin root: two directories above this skill's base directory. Follow `<plugin>/reference/project.md` → Session protocol and `<plugin>/reference/canon.md`. `<project>` is the project folder: `projectDir` in `massimo.config.json`, `design-system` by default.

## Before starting

- Tokens should exist (`tokens.json` built). Without them, only duplicate and dead component batches make sense; say so.
- The story lane should exist, for visual checks. Without it, offer to continue with build-only checks, and say what that cannot catch.
- The working tree should be clean, so each batch's diff is only that batch. If it is not, ask the user to commit or stash their own changes first.

## Run

1. **Begin.** `state.mjs set tidy in_progress`.
2. **Audit and baseline.** `node <project>/scripts/audit.mjs --baseline` (only if `audits/baseline.json` does not exist yet). The baseline is the ratchet, per offender (a file and the value it uses): from here no offender may rise and no new one may appear (the guard phase puts this in CI).
   Tailwind palette classes (`text-slate-400`) follow one rule. A palette class whose colour a token holds in the default theme is a finding, and the finding names that token as its fix (a semantic token ahead of the primitive it aliases). One that no token holds is counted under Tailwind palette classes in `latest.md`, not ratcheted, since there is no token to move it onto yet. To tidy those, add a colour token for the shade in the tokens phase and move its classes onto the token in the same batch: the token turns them into findings, which `--check` reports as new until they are moved. Every palette class is a finding from the start with the palette kind turned on in `audit.kinds`, or in a Tailwind 4 app whose style files declare `--color-*` colours of their own. A Tailwind config that sets `theme.colors` of its own (not from `tailwindcss/colors`), or a `@theme` that resets `--color-*`, replaces Tailwind's palette, so the kind is skipped: those classes are the repo's own colours.
3. **Build the backlog** in `<project>/tidy/backlog.md`, one batch per line, ordered safest first:
   1. **Exact matches**: raw values identical to a token's value → the token, and palette classes whose finding names a token → that token's class. No visual change expected. A palette class keeps its colour in every theme, so where the named token takes another colour in a dark theme, check the class's `dark:` variant before moving it.
   2. **Arbitrary values**: Tailwind `p-[6px]`-style values on the scale → the scale class.
   3. **Near matches**: values in a colour or size cluster whose representative is a token → the token. Small visible change; needs the user's eye.
   4. **Duplicate components**: near-duplicates the graph surfaced (`Button`/`Btn`/`PrimaryButton`) → one component with variants. Needs a decision on the API.
   5. **Dead components**: nothing imports them (graph `usage` 0, and not an entry point) → delete. Needs a yes per component.
   6. **Off-scale outliers**: values with no nearby token → ask: new token, nearest step, or leave with a reason.
   Each line: id, kind, scope (files, count), expected visual change (none / small / visible), status (todo, applied, accepted, rejected, parked). Batch size: about 20 files or one component family, so the diff stays reviewable.
4. **Per batch:**
   1. Show the user the batch: what, where, how many, expected visual change, and two sample before/after lines. Ask to go ahead (designers decide near matches and merges; developers decide APIs and deletions).
   2. Find the affected stories: components in the batch plus everything that composes them (graph `composedBy`), capped at the ten most-used. Screenshot them: `shoot.mjs` into `<project>/shots/tidy/<batch>/before/`.
   3. Apply. For mechanical batches (1, 2, 3), dispatch the `tidy-worker` agent with the batch line, the exact value→token map, the file list, and the rules below; several workers in parallel only when their file lists do not overlap. Do merges (4) yourself or with one worker, since they need judgement.
   4. Build the app (and typecheck/lint if the repo has them). Fix what the batch broke.
   5. Screenshot the same stories into `after/` and diff each pair (`shoot.mjs --diff`). Show the user the changed-pixel percentages and the diff images for anything above 0.1%.
   6. Accepted → `audit.mjs --lower` (records what fell, never a rise) and `graph.mjs`, commit the batch alone (`refactor(design-system): <batch summary>`), mark it accepted with the before→after counts. Rejected → discard only this batch's file changes, mark it rejected with the reason, record a decision.
   7. `state.mjs set tidy in_progress --note "<accepted>/<total> batches"`.
5. **End** when the backlog is cleared or the user parks the rest: `state.mjs set tidy done --note "<canon numbers before → after>"`. Report the canon numbers before and after; that is the clearest outcome for the team.

## Rules for every batch

- Replace values with tokens through the repo's own idiom: the Tailwind class for the token, `var(--token)` in CSS, the theme object in CSS-in-JS. Never introduce a new styling approach.
- No behaviour changes, no renames beyond the batch's scope, no formatting churn outside touched lines.
- A value that only looks like a token but means something else (a brand illustration's colour, a chart palette, a third-party embed) stays; list it as a reasoned exception in the backlog.
- Never push. Commits stay local until the user decides.
