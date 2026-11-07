# The in-repo project

Massimo keeps its working state inside the repo it is improving, so a designer or developer can stop at any point and pick up in a new session, on another machine, or hand over to a teammate, without losing context. Every skill and agent reads this contract.

## Files

`<project>` in every skill and agent is the project folder: `projectDir` in `massimo.config.json`, `design-system` unless the repo already uses a folder of that name for something else (then `.massimo`). Read each path written as `<project>/…` from there.

```text
massimo.config.json            where things are: framework, component globs, style files, story lane, token outputs
<project>/                     the project folder (config.projectDir)
├── STATUS.md                  the hand-off between sessions: where we are, next step, open questions
├── state.json                 machine-readable phase and exploration state (edit only through state.mjs)
├── product.md                 product grounding: users, reference products, brand feel, a11y bar, scope, real-content sources
├── decisions.md               append-only decision log
├── README.md                  how the team uses the system (docs.mjs writes its generated part)
├── graph.md / graph.json      generated component graph (graph.mjs)
├── audits/                    latest.md, latest.json, baseline.json (audit.mjs)
├── tokens/                    the token set in W3C Design Tokens 2025.10: tokens.resolver.json (the entry point), base.tokens.json,
│                              theme/<context>.tokens.json; draft/ from extract; preview.html, figma-variables.json
├── kit/kit.css                generated token stylesheet that mockups link to
├── explorations/<topic>/      one folder per design topic in the ux loop (brief.md, round-N/, index.html)
├── handoffs/<topic>.md        translate specs ready to build
├── tidy/backlog.md            the tidy batches, their status and results
├── figma/                     export.json (what the file holds, read by read-library.js), mirror.json (what was mirrored, with ids), drift.md
├── shots/                     screenshots (gitignored; regenerate any time), except shots/kept/
│   └── kept/<topic>/          screenshots a handoff, brief or baseline links to (committed)
└── scripts/                   vendored massimo scripts, so CI and teammates without the plugin can run them
```

Paths in `massimo.config.json` are repo-relative. `<project>/` is committed. `shots/` is gitignored by `<project>/.gitignore`, apart from `shots/kept/`: a screenshot that a committed file links to is copied there, so a teammate who opens the handoff sees it.

Config keys beyond the paths: `tokens.darkSelector`, `tokens.darkMedia`, `tokens.defaultMode` and `tokens.selectors` (how the app switches theme), `graph.extraKeys` (a repo's own `ds:` header keys), `graph.classLibraries` (extra class-based component libraries, see the graph skill), and `ticketPattern`: a regular expression for the repo's ticket ids (`"PROJ-\\d+"`). When it is set, the graph lists the ticket ids each component file mentions, so a reader can find the why behind a component.

Keys for a repo that already has its own design-system setup, all inert until set:

- `graph.keys` gives a repo's own `ds:` keys a role: `list`, `definitions` (custom properties a parent or a script sets), `scope` (one value, which audit exemptions can name) or `breakpoint` (`<width> <reason>`). A role is a name, or `{ role, values, under }` to limit a scope to a set or a list to files in a folder.
- `graph.taxonomy` holds the tiers in order, each group with a line on what belongs in it, the placement test, path rules that give a file its group, the parked marker and its group, and the keys each tier needs.
- `graph.kinds` adds node kinds beyond components, such as layouts and pages, each a list of globs. `graph.header` is `anywhere` or `top` (only the first comment block counts), and `graph.strictFaults` makes header faults fail the write and `--check`.
- `stories.manifest`, `stories.pages` and `stories.frames` point at a lane's own list of stories and where each slug's page and frame live.
- `audit.kinds` turns kinds off, `audit.exempt` skips a kind by role, tier, group or file, `audit.arbitrary` limits arbitrary values to colours, and `audit.failWhenBehind` fails `--check` while the baseline is behind the code.
- `guard.extraChecks` lists project commands `ds:check` runs as well, and `tokens.breakpoints` is the width scale the breakpoint audit holds the code to.

## Phases

`state.json` tracks seven phases in this order. Each has one skill.

| id | skill | done when |
|---|---|---|
| `setup` | `start` | config, product.md and the project folder exist |
| `graph` | `graph` | graph.md is generated and its unresolved-import list is empty or explained |
| `stories` | `stories` | the native story lane runs and the agreed set of components has baseline stories |
| `tokens` | `tokens` | tokens.json exists, builds into the repo's styling, and the user approved each group |
| `tidy` | `tidy` | the tidy backlog is cleared, or the user parked what is left |
| `guard` | `guard` | `ds:` rules on the primitives, `ds:check` in CI, <project>/README.md written |
| `figma` | `figma` | optional; tokens and primitives mirrored, mirror.json recorded |

Status values: `todo`, `in_progress`, `done`, `skipped`. A user can skip any phase at setup or later. The `ux` loop is not a phase: it runs whenever there is a surface to design, and its topics live in `state.json` → `explorations`.

## Scripts

Before setup, run scripts from the plugin: `node <plugin-root>/scripts/<name>.mjs`. After setup, run the vendored copy: `node <project>/scripts/<name>.mjs`. They are the same files; `init.mjs --update-scripts` refreshes the vendored copy when the plugin is newer.

The plugin root is two directories above a skill's base directory (`<plugin-root>/skills/<skill>/`). Agents receive it in their dispatch prompt.

| script | does |
|---|---|
| `detect.mjs` | reads the repo and prints the stack as JSON, with a suggested config |
| `init.mjs` | writes config, project folder, templates, vendored scripts, npm scripts; never overwrites |
| `state.mjs` | `show`, `next`, `set`, `decide`, `explore`, `render` |
| `graph.mjs` | writes graph.md/json; `--check` for CI |
| `audit.mjs` | raw-value audit; `--baseline` (first time), `--lower` (after a fix) and `--check` (CI) ratchet per offender |
| `tokens.mjs` | `extract` (a full draft from the repo's sources and its code), `build`, `kit`, `check`, `preview`, `hash`, `migrate`, `figma` |
| `docs.mjs` | the generated part of `<project>/README.md`; `--check` for CI |
| `canvas.mjs` | builds an exploration's side-by-side canvas page |
| `serve.mjs` | zero-dependency static server for the project folder |
| `shoot.mjs` | screenshots, page snapshots (`--dom`) and pixel diffs through Playwright, when the repo has it |
| `agent-guard.mjs` | the plugin's PreToolUse hook: massimo's reviewers write nothing, and its ideator writes only inside `<project>/explorations/` |

## Session protocol

Every skill follows this, so any session can be the next one.

**Begin.**

1. Run `node <project>/scripts/state.mjs show`. Read `<project>/STATUS.md`. Read `product.md` when the work touches design judgement.
2. Read the last ten lines of `decisions.md` when the phase builds on earlier choices.
3. If `STATUS.md` → Open questions holds something this phase needs, ask it before working.

**During.**

- Record each decision the user makes: `node <project>/scripts/state.mjs decide "<decision>" --why "<reason>" --phase <id>`. A decision is a choice someone could later ask "why?" about: a token value, a merge, a skipped component, a picked direction.
- Mark phase progress as it moves: `state.mjs set <phase> in_progress --note "<short progress, e.g. 18/40 primitives storied>"`.

**End** (including when the user stops mid-phase).

1. `state.mjs set <phase> <status> --note "<progress>"`. This also refreshes the progress block in STATUS.md.
2. Rewrite the hand-written sections of `STATUS.md`: Where we are (one short paragraph), Next step (one action and the skill that does it), Open questions, Last session (date, three bullets at most). Leave the generated block between the `massimo:progress` markers alone.
3. Offer to commit the project folder and the phase's code changes with a conventional message (`chore(design-system): …`, `feat(design-system): …`). Never push, open a PR, or merge unless the user asks.

## Writing for the reader

`STATUS.md`, `decisions.md` and handoffs are read by designers and developers who were not in the session. Write plain sentences, name files with repo-relative paths, and say what is not done. No session jargon.
