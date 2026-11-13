---
name: guard
description: Lock in the design system so it does not drift back: ds rules on the primitives (where each belongs, what it may contain, what never to do), a single ds:check script for CI (graph current, no new raw values, tokens built, README current; contrast failures are shown as warnings), and a short design-system README for the team. Use for the guard phase of a massimo project, or when the user wants design-system checks in CI or usage rules documented.
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
   "ds:check": "node <project>/scripts/check.mjs"
   ```
   `check.mjs` runs every massimo check that applies, one line each: `graph.mjs --check` always, `stories.mjs --check` on a csf lane, `audit.mjs --check` once there is an audit baseline, `tokens.mjs check` once there is a token set, and `docs.mjs --check` once the README has its generated part. A phase that was skipped drops out by itself. It fails on a stale graph, a raw value beyond the audit baseline, token outputs behind the token set (or, where they are on, the token mirror or `resolved.json` behind the style files), a README whose generated part is behind, a csf lane that fails `stories.mjs --check`, or a failing `guard.extraChecks` command. A contrast pair below its bar does not fail it: the tokens line passes and shows the pair as a warning under it, since the tokens phase settles each pair with the user (fix the token, or accept it with a recorded reason). A check the repo already has that massimo does not cover (a script of its own that guards a shipped asset, say) goes in `guard.extraChecks` in `massimo.config.json` as `{ "name": "...", "run": "..." }`; `check.mjs` runs each through a shell from the repo root after its own. Run it locally until it passes.
5. **CI.** Detect the CI system (`.github/workflows`, `.gitlab-ci.yml`, `.circleci`, others). For GitHub Actions, copy `<plugin>/templates/design-system-check.yml` to `.github/workflows/design-system.yml` and adjust the Node version and install command to match the repo's other workflows. A project kept in a package (made with `init.mjs --root <package>`) has its `ds:check` script in that package's `package.json`, and the scripts find the project from the folder they run in, so the job runs in that package: uncomment the template's `defaults: run: working-directory:` lines and set them to the package's path from the repo root (`apps/web`, say). For anything else, add an equivalent job and show the user. Do not push; tell the user the workflow runs on their next PR. A repo that went through adopt already has the shadow job (`design-system-shadow.yml`); see the next section.
6. **README.** `node <project>/scripts/docs.mjs` writes `<project>/README.md`: the token set with each semantic token's meaning and the contrast pairs, how to change tokens, each component by tier with its `ds:use-when` and props, what `ds:check` enforces, the Figma mirror's state, and how to start a design. That part sits between `massimo:docs` markers and is regenerated; write the rest around it with the user as a brand book, in rules that name tokens and components: content fundamentals (how the product writes, with real copy quoted), visual foundations (how colour, type, spacing, shape and motion are used) and iconography, then how to run and add stories, how to update the audit baseline when a raw value is deliberate, and who decides what (from `product.md` → Team). `docs.mjs --check` joins `ds:check`, so the README cannot fall behind. Link it from the repo's main README with one line if the user agrees.
7. **End.** `state.mjs set guard done --note "rules on <n> primitives, ds:check in <CI>"`. Next step: Figma mirror if planned, otherwise the project is complete and `/massimo:ux` takes over for new design work.

## From the shadow job to the required check

During adopt, `ds:check` runs in `.github/workflows/design-system-shadow.yml`: pull requests only, allowed to fail, and not required, so it can never block a merge while massimo and the repo's own tools still disagree. Once every class it checks is proven in the adopt ledger (`adopt.mjs status`) and the shadow job has passed for as long as the user chose to soak it:

1. Install `design-system-check.yml` as step 5 says, and remove the shadow workflow in the same commit, so the checks do not run twice.
2. Tell the user that a workflow alone blocks nothing: making it required is a branch protection setting they change in the repository's settings on GitHub (Settings, then Branches or Rulesets, then require status checks to pass, and pick the job `ds-check`). The job's name shows there only after it has run once on a pull request. Never change repository settings yourself.
3. Until the old setup is retired, the repo's own check may run beside it as a `guard.extraChecks` entry, so nothing is unguarded in between.

## When a check fails later

Explain the fix in the failure's terms: stale graph → run `npm run ds:graph` and commit; new raw value → use a token; if it is deliberate, add the offender to `<project>/audits/baseline.json` by hand and say why in the commit (`--lower` never records a rise, on purpose); a baseline behind the code (with `audit.failWhenBehind` set) → run `audit.mjs --lower` and commit the lower counts with the fix; stale tokens → `npm run ds:tokens`; a project check from `guard.extraChecks` → its own output, printed under its line, says what it wants.

## A repo with a ratchet of its own

When the repo already keeps per-offender counts in another shape (`{ note, rules: { <rule>: { count, offenders } } }`), seed the baseline from them rather than from scratch, so the ratchet carries over instead of starting loose. Map each rule to the kinds that measure it and compare, file by file:

```bash
node <project>/scripts/audit.mjs --import <their ratchet>.json --map <rule>=<kind>,<rule>=<kind>+<kind>
```

The table shows each rule against massimo's count and every file that differs. Adjust `audit.include`, `audit.exclude`, `audit.exempt` and `audit.kinds` with the user until every mapped rule matches, then run it again with `--write`. No baseline is recorded while any mapped rule differs. Rules with no massimo kind stay with the repo's own script, or move to `guard.extraChecks`.
