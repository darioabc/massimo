---
name: guard
description: Lock in the design system so it does not drift back — ds rules on the primitives (where each belongs, what it may contain, what never to do), a single ds:check script for CI (graph current, no new raw values, tokens built, contrast), and a short design-system README for the team. Use for the guard phase of a massimo project, or when the user wants design-system checks in CI or usage rules documented.
---

# massimo: guard

The earlier phases made the system; this phase keeps it. Rules live in the component files they describe, checks run in CI, and the README tells a newcomer how the pieces fit, in one page.

Plugin root: two directories above this skill's base directory. Follow `<plugin>/reference/project.md` → Session protocol. `<project>` is the project folder: `projectDir` in `massimo.config.json`, `design-system` by default.

## Run

1. **Begin.** `state.mjs set guard in_progress`.
2. **Tiers.** Propose a tier and group for every component (`ds:group <Tier> / <Group>`): Foundations (tokens made visible), Primitives (buttons, inputs, text), Patterns (composed pieces: cards, forms, lists), Shells (layouts, navigation), Pages, Explorations (parked or experimental). Base it on the graph: what a component composes and who composes it. Show the user the proposed index in one list, grouped; agree it; write the headers; re-run `graph.mjs` and check the index reads well.
3. **Rules on primitives.** Take the ten most-used components from `graph.md`. For each, propose `ds:` lines from how the code actually uses it (graph `composedBy`, real call sites):
   - `ds:use-when` when to reach for it instead of its neighbours (every Primitives node gets one);
   - `ds:parents` where it may sit;
   - `ds:children` what it may contain;
   - `ds:never` the misuse that would break the system (one or two, concrete);
   - `ds:no-story <reason>` on anything that deliberately has no story.
   Show them to the user in one list; designers usually have the strongest views on `use-when` and `never`. Write the accepted lines as comments at the top of each component file, re-run `graph.mjs`, and check they appear under rules with no header faults.
4. **One check script.** Add to package.json:
   ```json
   "ds:check": "node <project>/scripts/graph.mjs --check && node <project>/scripts/audit.mjs --check && node <project>/scripts/tokens.mjs check"
   ```
   Drop the parts whose phase was skipped (no tokens → no `tokens.mjs check`; no audit baseline → no `audit.mjs --check`). Run it locally until it passes.
5. **CI.** Detect the CI system (`.github/workflows`, `.gitlab-ci.yml`, `.circleci`, others). For GitHub Actions, copy `<plugin>/templates/design-system-check.yml` to `.github/workflows/design-system.yml` and adjust the Node version and install command to match the repo's other workflows. For anything else, add an equivalent job and show the user. Do not push; tell the user the workflow runs on their next PR.
6. **README.** Write `<project>/README.md` (one page): what the system is, where tokens live and how to change them (`tokens.json` → `npm run ds:tokens`), how to run and add stories, where the graph is and how to regenerate it, what `ds:check` enforces and how to update the audit baseline when a raw value is deliberate, how to start a design exploration (`/massimo:ux`), and who decides what (from `product.md` → Team). Link it from the repo's main README with one line if the user agrees.
7. **End.** `state.mjs set guard done --note "rules on <n> primitives, ds:check in <CI>"`. Next step: Figma mirror if planned, otherwise the project is complete and `/massimo:ux` takes over for new design work.

## When a check fails later

Explain the fix in the failure's terms: stale graph → run `npm run ds:graph` and commit; new raw value → use a token; if it is deliberate, add the offender to `<project>/audits/baseline.json` by hand and say why in the commit (`--lower` never records a rise, on purpose); stale tokens → `npm run ds:tokens`.
