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
│                              theme/<context>.tokens.json; draft/ from extract; preview.html, figma-variables.json;
│                              resolved.json, the inventory of every custom property per selector (tokens.mjs resolved)
├── kit/kit.css                generated token stylesheet that mockups link to
├── explorations/<topic>/      one folder per design topic in the ux loop (brief.md, round-N/, index.html)
├── handoffs/<topic>.md        translate specs ready to build
├── tidy/backlog.md            the tidy batches, their status and results
├── figma/                     export.json (what the file holds, read by read-library.js), mirror.json (what was mirrored, with ids), drift.md
├── adopt/                     inventory.json and inventory.md (adopt.mjs scan); ledger.json (adopt.mjs plan): what becomes of each
│                              part of the repo's own setup, where each class stands, the differences accepted with their
│                              reasons, the audit's map onto the repo's ratchet, and the docs marked historical;
│                              config.proposed.json (adopt.mjs plan)
├── shots/                     screenshots (gitignored; regenerate any time), except shots/kept/
│   └── kept/<topic>/          screenshots a handoff, brief or baseline links to (committed)
└── scripts/                   vendored massimo scripts, so CI and teammates without the plugin can run them
```

Paths in `massimo.config.json` are repo-relative. `<project>/` is committed. `shots/` is gitignored by `<project>/.gitignore`, apart from `shots/kept/`: a screenshot that a committed file links to is copied there, so a teammate who opens the handoff sees it.

Config keys beyond the paths: `tokens.darkSelector`, `tokens.darkMedia`, `tokens.defaultMode` and `tokens.selectors` (how the app switches theme), `graph.extraKeys` (a repo's own `ds:` header keys), `graph.classLibraries` (extra class-based component libraries, see the graph skill), and `ticketPattern`: a regular expression for the repo's ticket ids (`"PROJ-\\d+"`). When it is set, the graph lists the ticket ids each component file mentions, so a reader can find the why behind a component.

Keys for a repo that already has its own design-system setup, all inert until set:

- `graph.keys` gives a repo's own `ds:` keys a role: `list`, `definitions` (custom properties a parent or a script sets), `scope` (one value, which audit exemptions can name) or `breakpoint` (`<width> <reason>`). A role is a name, or `{ role, values, under }` to limit a scope to a set or a list to files in a folder.
- `graph.taxonomy` holds the tiers in order, each group with a line on what belongs in it, the placement test, path rules that give a file its group, the parked marker and its group, the keys each tier needs, and `notLive`: the tiers that are not live code (internal modules, parked work), which need no story.
- `graph.kinds` adds node kinds beyond components, such as layouts and pages, each a list of globs. `graph.edges` reads imports beyond import statements: `mdx` (the import lines of MDX files in the consumers) and `glob` (`import.meta.glob` calls). `graph.header` is `anywhere` or `top` (only the first comment block counts), and `graph.strictFaults` makes header faults fail the write and `--check`.
- `stories.manifest`, `stories.pages` and `stories.frames` point at a lane's own list of stories and where each slug's page and frame live; `stories.lane` is then `manifest`. `stories.componentless` lists the places (`Root / Group`) where a story may name no component, such as token pages. A story's root is one of `graph.taxonomy.tiers` (any root when there are none); there is no separate list of story roots.
- `audit.kinds` turns kinds off (`false`), or the Tailwind palette kind on (`true`, with the Tailwind config's colours as the repo's own). `audit.exempt` skips a kind in a file by a scope role's value, its tier or group, or a glob. `audit.arbitrary` limits arbitrary values to colours, a role read such as `text-[color:var(--x)]` included. `audit.primitives` limits primitive reads to colours; with no token set yet, a primitive is then a literal colour the style files define, read outside them. `tokens.mjs extract` proposes from the audit without these four settings. `audit.failWhenBehind` fails `--check` while the baseline is behind the code. With `stories.manifest` set, the audit also counts the story lane's policy problems that the graph writes to `graph.json` (`story-title`, `story-files`, `story-states`, `no-story`); a manifest the graph could not read leaves all four unmeasured, and a check the graph could not make (`storyLane.notChecked`) leaves its kind unmeasured, so `--lower` never records their drop. A baseline that tracks a kind added in 0.3.0, such as `breakpoint` or the story kinds, is format 2, which older scripts refuse.
- `guard.extraChecks` lists project commands `ds:check` runs as well, and `tokens.breakpoints` (`{ scale, twins }`, widths in rem, px or em) is the width scale the breakpoint audit holds the code to: an `@media` width, or a Tailwind screen or `min-[...]:` or `max-[...]:` variant, off the scale and its twins is a finding unless the file's header allows that width through the breakpoint role. Screen names come from `tokens.tailwindConfig` when it sets screens, else Tailwind's defaults; Tailwind 4 screens (`--breakpoint-*` in `@theme`) are not read yet.
- `tokens.mirror` keeps the style files as the source: `tokens.mjs mirror` writes the token set at `tokens.source` from them, and every other command reads that set. Each token keeps its CSS name, its themes follow the config's theme selectors, a value under any other selector (a band, a tone, a phone-width override) goes in its `$extensions.massimo.scopes`, and the comment on its root declaration (just before it, or after it on its line) is its description, unless it opens a section. Where two selectors the config places in one theme set different values (the dark class and the dark colour-scheme query), the theme takes the first and the other keeps its value as a scope, with a note. A `light-dark()` on the root stays one declaration. `tokens.mjs check` then fails while the mirror is behind the CSS, and `build` refuses an output that would write over a file it mirrors, or one the style files' globs would read once written.
- `tokens.inventory` sets what `tokens.mjs resolved` lists in `tokens/resolved.json`: every custom property the sheets declare, with its file, layer, family and a value per selector (each member of a selector list on its own), each colour resolved in its theme through its own sheet and the sheets `tokens.styleFiles` names, never another listed sheet, plus the type classes, the `@font-face` rules and `tokens.breakpoints`. `files` are the sheets (globs). `layers` names each layer in order with its file globs, or `{ files, names, selectors }` to place by property name or by the selector a property is first declared under. `families` names families by property-name globs, ahead of massimo's own. `typeClasses` are class-name globs; without them, a type class is any class that is a selector on its own in a rule setting a size, line height, weight or family. Without the key, the inventory lists `tokens.styleFiles` as one layer. `tokens.mjs check` keeps the file current when this key or `tokens.mirror` is set. Scripts older than 0.3.0 ignore both keys, so a config that sets either also sets `minScripts` to `0.3.0`.

## Phases

`state.json` tracks eight phases in this order. Each has one skill.

| id | skill | done when |
|---|---|---|
| `setup` | `start` | config, product.md and the project folder exist |
| `adopt` | `adopt` | optional, to do only when the repo has a setup of its own; every class in `adopt/ledger.json` (graph, stories, audit, tokens, docs) is cut over or retired, each having moved through found, mapped, shadowed and proven. The ledger is where adopt stands; the phase note is a view of it, rebuilt on each `adopt.mjs plan` and `mark` |
| `graph` | `graph` | graph.md is generated and its unresolved-import list is empty or explained |
| `stories` | `stories` | the native story lane runs and the agreed set of components has baseline stories |
| `tokens` | `tokens` | tokens.json exists, builds into the repo's styling, and the user approved each group |
| `tidy` | `tidy` | the tidy backlog is cleared, or the user parked what is left |
| `guard` | `guard` | `ds:` rules on the primitives, `ds:check` in CI, <project>/README.md written |
| `figma` | `figma` | optional; tokens and primitives mirrored, mirror.json recorded |

Status values: `todo`, `in_progress`, `done`, `skipped`. A user can skip any phase at setup or later. A project without an `adopt` entry (made before 0.3.0) has it as skipped, and STATUS.md and the session hook leave out an optional phase skipped that way. The `ux` loop is not a phase: it runs whenever there is a surface to design, and its topics live in `state.json` → `explorations`.

## Scripts

Before setup, run scripts from the plugin: `node <plugin-root>/scripts/<name>.mjs`. After setup, run the vendored copy: `node <project>/scripts/<name>.mjs`. They are the same files; `init.mjs --update-scripts` refreshes the vendored copy when the plugin is newer.

The plugin root is two directories above a skill's base directory (`<plugin-root>/skills/<skill>/`). Agents receive it in their dispatch prompt.

| script | does |
|---|---|
| `detect.mjs` | reads the repo and prints the stack as JSON, with a suggested config, and `adoptable` when the repo has a setup of its own to adopt |
| `adopt.mjs` | `scan`: what the repo already has (story tools and lanes, a census of its `ds:` keys, its own graph, ratchet, token files, DESIGN.md and the script that writes them) and who depends on each; read-only, printed before init and written to `<project>/adopt/inventory.json` and `inventory.md` after. `plan`: the ledger and the proposed config. `config`: the proposal as a diff against the config, merged in with `--write` (it adds keys and never overwrites a value the user set; a config with comments is left for a hand edit). `status`: the ledger as a table. `mark <class> <state>`: moves a class (graph, stories, audit, tokens, docs) one state on through found, mapped, shadowed, proven, cut-over (with `--batch <id>`, the id its commit's `Adopt-Batch` trailer carries) and retired; never past a blocker; `--force` goes back or skips states, to repair the ledger. A new asset in a class past found takes its class back to found until it is agreed. `verify [<class>]`: massimo's graph, story lane, audit and token inventory set beside the repo's own (its generated graph or index, its ratchet by the ledger's map, its token inventory), as a table per class, exiting 1 on any difference the ledger has not accepted; `--against <file>` names the repo's file; `verify stories --pairs <file> --a <url> --b <url>` writes a `shoot.mjs` pairs file from the manifest, and `--shoot` runs it. It records nothing. `accept <class> '<key>' --why <text>`: accepts a difference verify printed, with the reason. `historical [<path>]`: marks a doc as a record of how things were, which retire leaves as it is, or lists them. `retire <class> --dry-run`: what retiring a class takes out (its assets marked retire or convert, and the package scripts and workflow jobs that run them) and every consumer still outside the historical docs, exiting 1 while one remains; without `--dry-run` it refuses, since deleting is the adopt skill's job |
| `init.mjs` | writes config, project folder, templates, vendored scripts, npm scripts; never overwrites |
| `state.mjs` | `show`, `next`, `set`, `decide`, `explore`, `render` |
| `graph.mjs` | writes graph.md/json; `--check` for CI |
| `audit.mjs` | raw-value audit; `--baseline` (first time), `--lower` (after a fix) and `--check` (CI) ratchet per offender; `--import <file> --map <rule>=<kind>` seeds the baseline from a ratchet kept in another shape, once every mapped rule matches file by file |
| `tokens.mjs` | `extract` (a full draft from the repo's sources and its code), `build`, `kit`, `check`, `preview`, `hash`, `migrate`, `figma`, `mirror` (the token set as a checked mirror of the style files; `--check` for CI), `resolved` (the inventory in `tokens/resolved.json`; `--check` for CI) |
| `docs.mjs` | the generated part of `<project>/README.md`; `--check` for CI |
| `check.mjs` | `ds:check`: every check above that applies to the project, then `guard.extraChecks`, one line each |
| `canvas.mjs` | builds an exploration's side-by-side canvas page |
| `serve.mjs` | zero-dependency static server for the project folder |
| `shoot.mjs` | screenshots, page snapshots (`--dom`), pixel diffs and a pairs runner (`--pairs`, with a pass or fail exit against `--max-diff`, and exit 2 for a broken pairs file) through Playwright, from the repo or from another checkout (`--playwright <path>`); `--reduced-motion`, `--settle` and `--freeze` make shots repeatable |
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
