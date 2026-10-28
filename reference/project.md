# The in-repo project

Massimo keeps its working state inside the repo it is improving, so a designer or developer can stop at any point and pick up in a new session, on another machine, or hand over to a teammate, without losing context. Every skill and agent reads this contract.

## Files

```text
massimo.config.json            where things are: framework, component globs, style files, story lane, token outputs
design-system/                 (config.projectDir; the default)
├── STATUS.md                  the hand-off between sessions: where we are, next step, open questions
├── state.json                 machine-readable phase and exploration state (edit only through state.mjs)
├── product.md                 product grounding: users, reference products, brand feel, a11y bar, scope, real-content sources
├── decisions.md               append-only decision log
├── README.md                  how the team uses the system (written in the guard phase)
├── graph.md / graph.json      generated component graph (graph.mjs)
├── audits/                    latest.md, latest.json, baseline.json (audit.mjs)
├── tokens/                    tokens.json (DTCG source of truth), tokens.draft.json, preview.html, figma-variables.json
├── kit/kit.css                generated token stylesheet that mockups link to
├── explorations/<topic>/      one folder per design topic in the ux loop (brief.md, round-N/, index.html)
├── handoffs/<topic>.md        translate specs ready to build
├── tidy/backlog.md            the tidy batches, their status and results
├── figma/                     mirror.json (Figma ids ↔ tokens/components), drift.md
├── shots/                     screenshots (gitignored; regenerate any time)
└── scripts/                   vendored massimo scripts, so CI and teammates without the plugin can run them
```

Paths in `massimo.config.json` are repo-relative. `design-system/` is committed; `shots/` is gitignored by `design-system/.gitignore`.

## Phases

`state.json` tracks seven phases in this order. Each has one skill.

| id | skill | done when |
|---|---|---|
| `setup` | `start` | config, product.md and the project folder exist |
| `graph` | `graph` | graph.md is generated and its unresolved-import list is empty or explained |
| `stories` | `stories` | the native story lane runs and the agreed set of components has baseline stories |
| `tokens` | `tokens` | tokens.json exists, builds into the repo's styling, and the user approved each group |
| `tidy` | `tidy` | the tidy backlog is cleared, or the user parked what is left |
| `guard` | `guard` | `ds:` rules on the primitives, `ds:check` in CI, design-system/README.md written |
| `figma` | `figma` | optional; tokens and primitives mirrored, mirror.json recorded |

Status values: `todo`, `in_progress`, `done`, `skipped`. A user can skip any phase at setup or later. The `ux` loop is not a phase: it runs whenever there is a surface to design, and its topics live in `state.json` → `explorations`.

## Scripts

Before setup, run scripts from the plugin: `node <plugin-root>/scripts/<name>.mjs`. After setup, run the vendored copy: `node design-system/scripts/<name>.mjs`. They are the same files; `init.mjs --update-scripts` refreshes the vendored copy when the plugin is newer.

The plugin root is two directories above a skill's base directory (`<plugin-root>/skills/<skill>/`). Agents receive it in their dispatch prompt.

| script | does |
|---|---|
| `detect.mjs` | reads the repo and prints the stack as JSON, with a suggested config |
| `init.mjs` | writes config, project folder, templates, vendored scripts, npm scripts; never overwrites |
| `state.mjs` | `show`, `next`, `set`, `decide`, `explore`, `render` |
| `graph.mjs` | writes graph.md/json; `--check` for CI |
| `audit.mjs` | raw-value audit; `--baseline` (first time), `--lower` (after a fix) and `--check` (CI) ratchet per offender |
| `tokens.mjs` | `extract`, `build`, `kit`, `check`, `preview` |
| `canvas.mjs` | builds an exploration's side-by-side canvas page |
| `serve.mjs` | zero-dependency static server for the project folder |
| `shoot.mjs` | screenshots and pixel diffs through Playwright, when the repo has it |

## Session protocol

Every skill follows this, so any session can be the next one.

**Begin.**

1. Run `node design-system/scripts/state.mjs show`. Read `design-system/STATUS.md`. Read `product.md` when the work touches design judgement.
2. Read the last ten lines of `decisions.md` when the phase builds on earlier choices.
3. If `STATUS.md` → Open questions holds something this phase needs, ask it before working.

**During.**

- Record each decision the user makes: `node design-system/scripts/state.mjs decide "<decision>" --why "<reason>" --phase <id>`. A decision is a choice someone could later ask "why?" about: a token value, a merge, a skipped component, a picked direction.
- Mark phase progress as it moves: `state.mjs set <phase> in_progress --note "<short progress, e.g. 18/40 primitives storied>"`.

**End** (including when the user stops mid-phase).

1. `state.mjs set <phase> <status> --note "<progress>"`. This also refreshes the progress block in STATUS.md.
2. Rewrite the hand-written sections of `STATUS.md`: Where we are (one short paragraph), Next step (one action and the skill that does it), Open questions, Last session (date, three bullets at most). Leave the generated block between the `massimo:progress` markers alone.
3. Offer to commit the project folder and the phase's code changes with a conventional message (`chore(design-system): …`, `feat(design-system): …`). Never push, open a PR, or merge unless the user asks.

## Writing for the reader

`STATUS.md`, `decisions.md` and handoffs are read by designers and developers who were not in the session. Write plain sentences, name files with repo-relative paths, and say what is not done. No session jargon.
