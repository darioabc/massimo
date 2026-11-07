# Massimo

Design-system automation for any front-end repo, run from [Claude Code](https://claude.com/claude-code).

Massimo maps your components, sets up stories that render through your own build (no Storybook, no Ladle), turns the colours and sizes scattered through your code into design tokens, tidies the codebase onto them in small batches you approve, and runs an iterative design loop: real rendered mockups in your product's tokens, rounds until you pick, then a story built from your real components. It can mirror the result into Figma.

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

| Phase | Command | What you get |
|---|---|---|
| Set up | `/massimo:start` | `massimo.config.json`, the `design-system/` project folder, product grounding |
| Graph | `/massimo:graph` | `design-system/graph.md`: every component, what it composes, what uses it, its story, its tokens, its usage rules |
| Stories | `/massimo:stories` | a native story lane at `/stories`, gated so it never ships, and baseline stories for your most-used components |
| Tokens | `/massimo:tokens` | an audit of raw values, then W3C DTCG tokens approved group by group, built into CSS, Tailwind 4 or 3, SCSS or TS |
| Tidy | `/massimo:tidy` | raw values and duplicate components moved onto the system in batches, each with before/after screenshots and its own commit |
| Guard | `/massimo:guard` | usage rules on primitives, `npm run ds:check` in CI, a one-page design-system README |
| Figma | `/massimo:figma` | tokens as Figma variables (light and dark), primitives as components bound to them, and a drift report |

Skip any phase you do not need. `/massimo:status` shows where things stand.

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
  tokens/                tokens.json (the source of truth), a visual preview, Figma variables
  explorations/<topic>/  design rounds: brief, mockups, canvas
  handoffs/              build-ready specs from the design loop
  scripts/               zero-dependency Node scripts, vendored so CI and teammates without the plugin can run them
```

Everything is plain Markdown, JSON and HTML, committed with your code. `npm run ds:serve` (or `node design-system/scripts/serve.mjs` in a repo with no `package.json`) opens the folder in a browser: the project's status first, with the graph, audits, handoffs and token preview one click away.

## Supported stacks

Native story lanes for Vite (React, Preact, Vue, Svelte, Solid), Next.js (App and Pages Router), Astro, SvelteKit and Nuxt, plus guidance for anything else. The graph understands TS/JS, JSX, Vue, Svelte and Astro, with tsconfig path aliases. Tokens build into plain CSS custom properties, Tailwind 4 `@theme`, Tailwind 3 config, SCSS, TypeScript and JSON. In a DaisyUI app, the theme block maps DaisyUI's colour names onto the tokens by hand, once.

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
