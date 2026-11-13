# Massimo

Design-system automation for any front-end repo, run from [Claude Code](https://claude.com/claude-code).

Massimo maps your components, sets up stories that render through your own build (no Storybook, no Ladle), turns the colours and sizes scattered through your code into W3C design tokens, tidies the codebase onto them in small batches you approve, and runs an iterative design loop: real rendered mockups in your product's tokens, rounds until you pick, then a story built from your real components. For a repo that already has components and styling but no formal system, it extracts the whole system in one guided flow. For a repo that already keeps its own design-system setup, it adopts that setup instead of building a second one. It can mirror the result into Figma.

It keeps a project inside your repo, so a designer or developer can stop at any point and pick up in a new session, on another machine, or hand over to a teammate.

## Install

In Claude Code, inside your front-end repo:

```
/plugin marketplace add darioabc/massimo
/plugin install massimo@massimo
/massimo:start
```

Or from a terminal, then open Claude Code in the repo and run `/massimo:start`:

```bash
claude plugin marketplace add darioabc/massimo
claude plugin install massimo@massimo
```

To give the whole team Massimo, install it at project scope. It writes the plugin into the repo's `.claude/settings.json`; commit that file and everyone who clones the repo gets it:

```bash
claude plugin marketplace add darioabc/massimo --scope project
claude plugin install massimo@massimo --scope project
```

The resulting settings look like this, if you prefer to write them by hand:

```json
{
  "extraKnownMarketplaces": {
    "massimo": { "source": { "source": "github", "repo": "darioabc/massimo" } }
  },
  "enabledPlugins": { "massimo@massimo": true }
}
```

Requires Node 18 or newer. Optional: Playwright in the repo (for screenshots and pixel diffs; otherwise Massimo uses Claude's browser tools) and Figma's official MCP server (for the Figma mirror).

## How it works

`/massimo:start` detects your stack, asks a few short questions (who your users are, which products set the bar, brand feel, accessibility bar, where real data lives), and creates the project. Then it walks you through the phases, one at a time. Every run of `/massimo:start` after that picks up where the last session stopped.

In a monorepo, the project lives at the root or in one package. Keep it at the root, with component globs into the packages, when components, stories or tokens sit in different packages, or the story tool or the tokens sit at the root. Keep it in a package (`init.mjs --root <package>`) when that package holds the whole system: the scripts, the package's npm scripts and the session hook then find it from inside that package, and a script run from the repo top needs `--root <package>`.

| Phase | Command | What you get |
|---|---|---|
| Set up | `/massimo:start` | `massimo.config.json`, the `design-system/` project folder, product grounding |
| Adopt | `/massimo:adopt` | only for a repo with a setup of its own: massimo reads its story lane, header keys, graph, ratchet and token list, proves it agrees with them, then takes over one class at a time; a Ladle repo can also move its story files onto massimo's csf lane |
| Graph | `/massimo:graph` | `design-system/graph.md`: every component, what it composes, what uses it, its story, its tokens, its usage rules |
| Stories | `/massimo:stories` | a native story lane at `/stories`, gated so it never ships, and baseline stories for your most-used components |
| Tokens | `/massimo:tokens` | an audit of raw values, then tokens in the W3C Design Tokens format 2025.10, approved group by group, built into CSS, Tailwind 4 or 3, SCSS, TS, JSON or DESIGN.md |
| Tidy | `/massimo:tidy` | raw values and duplicate components moved onto the system in batches, each with before/after screenshots and its own commit |
| Guard | `/massimo:guard` | usage rules on primitives, `npm run ds:check` in CI, a design-system README that stays current |
| Figma | `/massimo:figma` | tokens as Figma variables with their themes as modes, text and effect styles, primitives as components bound to them, and a drift report that says whether code or Figma moved |
| Artifact | `/massimo:artifact` | the design system as one folder a reader can open: a brand book, tokens as lists, a page and a still preview per component, fonts and assets, in the layout of a Claude design system artifact, ready for one, for a static host or for another agent |

Skip any phase you do not need. `/massimo:status` shows where things stand.

### Extracting a system from an existing repo

`/massimo:extract` is for a repo with components and styling but no formal system. In one guided flow it reads the values the repo already keeps (CSS custom properties, a Tailwind config, a CSS-in-JS theme, Tokens Studio or DTCG files, Figma variables exported as JSON), counts the ones the code uses without a token, and proposes a complete set: colour ramps and semantic colours with contrast pairs, typography composites and their scale, spacing, radius, shadow, border, motion, layers and opacity. Every value says where it came from; nothing is invented from taste. Then it gives each primitive its props, variants, states and a usage rule, and writes the design-system README. You approve family by family, and nothing in your codebase changes without your OK.

### Adopting a setup the repo already has

Some repos already keep their own design-system data: a story lane with its own manifest, `ds:` header keys, a generated component graph, a ratchet of raw values, a token list, and the scripts that write them. `/massimo:adopt` takes these over instead of generating a second system beside them. It first lists what is there and everything that depends on it, without running any of it. Then it configures massimo to read the repo's own conventions, runs both side by side on pull requests without blocking, and proves they agree, class by class. Only then does it switch each class over, consumers first, one commit you can revert at a time. The old scripts are retired last, only when nothing depends on them and you say yes. `/massimo:start` offers adopt when it finds such a setup.

#### A Ladle repo

A repo whose stories are CSF files for Ladle can go one step further, if you opt in with `adopt.mjs config --write --lane csf`. The story files stay where they are and are never copied. A Vite plugin from massimo builds a lane from them at `/stories`: one state at a time in a fixed-size iframe, a canvas per state at `/stories/<slug>/<state>`, and `/meta.json` in Ladle's own shape. Ladle ids can be kept, so old links, specs and `/?story=<id>` URLs still work. `adopt.mjs convert stories` writes a record per file, the redirect map, the list of edits the repo makes before Ladle can go, and a patch that changes only the type import of each file, plus `src/stories/legacy-story-types.d.ts` when a frozen file keeps the tool's import. Design targets you freeze are pinned by hash and checked in CI. The lane is proved against Ladle's own `meta.json`, a sweep of every state, and shots in both, and the static build can be hosted for a team. Title, coverage and banner rules are options in `stories.policy`, off until you set them. A Ladle repo that does not opt in is planned exactly as in 0.3.0.

#### Keeping Storybook

A team that keeps its Storybook keeps it as the story lane. `/massimo:start` sets the stories keys from it: the globs of the stories list in `.storybook/main`, the script that runs `storybook dev` and its port, and each story's address, `iframe.html?id={id}&viewMode=story`. When Storybook is all there is to adopt, start recommends skipping adopt. `node <project>/scripts/stories.mjs storybook <component>` names each of a component's stories by Storybook's own id rule, with its URL, without running Storybook; with Storybook running, `--against <url>` checks the ids against its index. New stories are CSF files beside the existing ones, and the design loop, tidy's before and after shots and the Figma mirror open stories at those URLs.

### The design system as a folder to publish

`/massimo:artifact` gives the system a reader's side. The project folder keeps it in the shape it is published in: `README.md` as the brand book, `sections/` for further sections, a `components/<Name>/README.md` per component written from the graph, `assets/` and `fonts/`. `artifact.mjs build` then adds what differs in form: the tokens as lists (the W3C token set stays the source), a still preview per component taken from a static build of your story lane, and the stylesheets, fonts and pictures those previews load. A token the lists cannot hold, such as a duration or an easing, is written as a section instead of being dropped.

The folder follows the layout of a Claude design system artifact, so it publishes to one as it is, and it is plain Markdown, JSON, HTML and CSS with relative paths, so it also opens from a static host or from disk. The script never publishes: it builds, and `artifact.mjs status` says when a published copy has fallen behind the tokens or the graph.

### The design loop

`/massimo:ux <topic>` is for designing, any time:

- **Existing screen or component:** Massimo makes sure its story is current and uses real data, reviews it (usability, content, accessibility, and visual craft against the products your users already trust), then generates directions.
- **New idea:** it scans how comparable products handle it today, frames the problem with you, then generates directions.

Directions are real HTML mockups in your tokens, shown side by side on one canvas page. You lock one, seed another round from one, or reject them all; follow-up rounds change only what you asked about. Once you pick, Massimo builds the surface as a story from your real components, checks it against the mockup you approved, and writes a build-ready handoff. It can build it for you too.

## The project folder

```text
massimo.config.json      where things are in your repo
design-system/
  STATUS.md              where the project stands and the next step (read this first)
  product.md             users, the bar, brand feel, scope, accessibility, real-content sources
  decisions.md           what was decided, why, and by whom
  graph.md               the component graph (generated)
  audits/                raw-value audits and the CI baseline
  tokens/                the token set (W3C Design Tokens 2025.10, the source of truth), a visual preview, Figma variables
  explorations/<topic>/  design rounds: brief, mockups, canvas
  handoffs/              build-ready specs from the design loop
  adopt/                 what the repo already had, and the ledger of what becomes of it (adopt only)
  README.md              the brand book: how the system is used, as rules that name tokens and components
  sections/              further sections of the brand book (motion, and any you write)
  components/<Name>/     a page per component, written from the graph
  assets/, fonts/        logos, icons, illustrations and font files
  artifact/              the folder to publish (built, not committed) and the record of where it went
  playbooks/             every phase's steps, copied from the plugin so any coding agent can follow them
  scripts/               zero-dependency Node scripts, vendored so CI and teammates without the plugin can run them
```

Everything is plain Markdown, JSON and HTML, committed with your code. `npm run ds:serve` (or `node design-system/scripts/serve.mjs` in a repo with no `package.json`) opens the folder in a browser: the project's status first, with the graph, audits, handoffs and token preview one click away.

## Using massimo with another coding agent

Massimo is a Claude Code plugin, and a repo set up with it needs no plugin to keep going. `init.mjs` copies two things into the project folder: the scripts, which are plain Node with no dependencies, and the playbooks, which are each phase's steps as Markdown. It also keeps a short block in `AGENTS.md` at the repo root that tells an agent where to start: read `STATUS.md`, then follow the playbook for the work in hand.

So Codex, Cursor or any agent that reads `AGENTS.md` can run a phase or the design loop from the repo alone. Three things are Claude Code's own and are replaced by plain steps elsewhere: the `/massimo:<name>` commands (read the playbook of that name), the fresh workers the design loop dispatches (an agent that cannot start one follows the worker's instructions itself, one at a time), and the hook that keeps reviewers from writing (the playbook states the rule instead).

To set a repo up without Claude Code, clone massimo anywhere and run `node <massimo>/scripts/init.mjs --root <your repo>`. `--no-agents-file` leaves `AGENTS.md` alone.

## Supported stacks

Native story lanes for Vite (React, Preact, Vue, Svelte, Solid), Next.js (App and Pages Router), Astro, SvelteKit and Nuxt, plus guidance for anything else. Extraction reads CSS (including `@theme`, DaisyUI themes, `light-dark()` and channel triplets) and Sass custom properties, Tailwind 3 configs, CSS-in-JS and JS theme objects, Tokens Studio and DTCG files, and Figma variable exports. The graph understands TS/JS, JSX, Vue, Svelte and Astro, with tsconfig path aliases (`tsconfig.base.json` included) and imports of the repo's own workspace packages (npm, Yarn or pnpm workspaces). In a Nuxt app it also reads Nuxt's aliases, its layers and the components it auto-imports. Tokens build into plain CSS custom properties, Tailwind 4 `@theme`, Tailwind 3 config, SCSS, TypeScript, JSON and [DESIGN.md](https://github.com/google-labs-code/design.md) for coding agents. In a DaisyUI app, the theme block maps DaisyUI's colour names onto the tokens by hand, once.

## Updating from 0.4

Update the plugin, then bring the vendored scripts forward:

```bash
node <plugin-root>/scripts/init.mjs --update-scripts
```

Nothing in a project's files changes shape. The update also copies the playbooks to `<project>/playbooks/` and adds a massimo block to `AGENTS.md`, creating the file if the repo has none; pass `--no-agents-file` to leave it alone. `state.json` gains an `artifact` phase, skipped until you want it. Nothing is written under `components/` or `sections/` until `artifact.mjs pages` runs, and `ds:check` checks those pages only once they exist.

## Updating from 0.4.0

Update the plugin, then bring the vendored scripts forward, scan again before the next adopt plan, and rebuild the token outputs:

```bash
node <plugin-root>/scripts/init.mjs --update-scripts
```

```bash
npm run ds:tokens
```

Nothing in a project's files changes shape. The rebuild matters in a Tailwind 3 project, where the tailwind3 output now writes colours so that opacity modifiers keep working. Scripts now leave out files git ignores, so a build or a native app's copy of the web build is no longer read as source.

## Updating from 0.3

Update the plugin, then bring the vendored scripts forward in your repo:

```bash
node <plugin-root>/scripts/init.mjs --update-scripts
```

A project that sets no 0.4.0 key behaves as on 0.3.0, and a Ladle repo is planned as before until it opts in. A config that turns on a 0.4.0 key sets `"minScripts": "0.4.0"`, so scripts older than that refuse it by name instead of ignoring the key. The new files (the redirect map and the conversion records) have their own format numbers, and older scripts refuse a newer one with "update massimo".

## Updating from 0.2

Update the plugin, then bring the vendored scripts forward in your repo:

```bash
node <plugin-root>/scripts/init.mjs --update-scripts
```

Nothing changes until you set one of the new keys: the graph, audit and tokens write what they wrote before. A project made before 0.3.0 skips the adopt phase; run `/massimo:adopt` to take it up.

## Updating from 0.1

Update the plugin, then in your repo bring the vendored scripts forward and rebuild once, since every generated file has a new header:

```bash
node <plugin-root>/scripts/init.mjs --update-scripts
```

```bash
npm run ds:tokens
```

Your `tokens.json` keeps building exactly as before. To move it to the W3C Design Tokens format 2025.10, run `node design-system/scripts/tokens.mjs migrate`: it writes the new files beside the old one, lists anything that did not carry over exactly in `migration-report.md`, checks every output still builds the same, and points `massimo.config.json` at the new files. `/massimo:start` offers both.

## Principles

The name is an homage to Massimo Vignelli, whose work treated design as a discipline of systems: few typefaces, a strict grid, a constrained palette, every element there for a reason. The tool judges audits and proposals by the same economy. It is not affiliated with Vignelli or his estate.

- Code is the source of truth; Figma mirrors it.
- Nothing changes in your codebase without your OK, and every batch is reversible.
- Mockups and stories use real data, never placeholders.
- Commits stay local; Massimo never pushes.

## Made by

[Dario Codipietro](https://dariocodipietro.co.uk). I also make [Fiuto](https://fiuto.ai/?utm_source=massimo&utm_medium=readme&utm_campaign=massimo): once massimo has helped you pick a direction, Fiuto tests it with real people, writing the study, running it, and turning what happened into findings.

## License

MIT
