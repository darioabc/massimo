---
name: start
description: Start or resume massimo's design-system project in this repo. Use when the user wants to set up a design system, build or clean up tokens, components or stories, "kick off design automation", or continue design-system work from an earlier session ("where are we", "carry on", "next step"). On first run it detects the stack, asks a few short questions, and creates the in-repo project; on later runs it reads the project's status and routes to the next phase.
---

# massimo: start

Front door for everything massimo does in a repo. It sets the project up once, then on every later run reads where things stand and hands over to the right phase skill. A designer or developer should never need to remember which command comes next.

**Plugin root.** Two directories above this skill's base directory. Call it `<plugin>`; scripts are at `<plugin>/scripts/`. Read `<plugin>/reference/project.md` now: it is the contract for the project folder, phases and session protocol. `<project>` is the project folder: `projectDir` in `massimo.config.json`, `design-system` by default.

## Which path

Look for `massimo.config.json` at the repo root (git toplevel).

- **Absent** → Kickoff.
- **Present** → Resume.

## Kickoff

1. **Detect.** Run `node <plugin>/scripts/detect.mjs`. Summarise it in four or five plain lines: framework, styling, where components seem to live (with counts), the style files that hold tokens, existing story tools, and Playwright yes/no. If the repo is a monorepo, ask which package to work on and re-run with `--root <package>`.
2. **Ask.** One round of questions, two at most. Use the host's question tool when there is one; otherwise ask in plain text with a recommended answer for each. Ask only what detection could not settle:
   - Who is driving: a designer, a developer, or both? (It sets how much code you show versus visuals.)
   - Confirm or correct the component folders and token files detect found.
   - The product, its users, and two or three products whose quality bar they want to match.
   - Brand feel in a few words, and the accessibility bar (WCAG A or AA; recommend AA for public products).
   - Which phases they want. Default: all of graph → stories → tokens → tidy → guard; Figma mirror only if they use Figma. Recommend the full path for a repo with no system yet; "graph + stories + ux" for a team that only wants the design loop. When detect found styling (style files with custom properties, a Tailwind config, theme files) but no token set, recommend starting with `/massimo:extract`: it proposes the whole system from what the code already uses (tokens for every family, a usage rule per primitive, a README) and does the graph, tokens and docs work in one sitting.
   - Where real content lives (staging API, seed data, fixtures), so mockups never invent data.
3. **If Storybook, Ladle or Histoire exists**, say so and recommend massimo's native lane anyway: it renders through the repo's own build, so what you see is what ships. Existing stories still count in the graph. Record the choice.
4. **Create.** Run `node <plugin>/scripts/init.mjs --config-json '<json>'` with any corrections from step 2 (component globs, style files, projectDir). Show the user what it created and skipped, including the package.json scripts it added.
5. **Ground.** Write `<project>/product.md` from the answers (replace the template's placeholders; leave a section as "unknown" rather than inventing). Record each answer that is a choice with `state.mjs decide`.
6. **Plan.** For each phase the user does not want: `node <project>/scripts/state.mjs set <phase> skipped --note "<why>"`. Then `state.mjs set setup done --note "<framework>, <styling>"`.
7. **Hand over.** Show the roadmap (`state.mjs show`), write STATUS.md's hand-written sections, and offer to start the next phase now by invoking its skill (`/massimo:<skill>`).

## Resume

1. Run `node <project>/scripts/state.mjs show` and read `<project>/STATUS.md`.
2. **Scripts current?** Compare the vendored `<project>/scripts/lib/project.mjs` `SCRIPTS_VERSION` with `<plugin>/scripts/lib/project.mjs`. If the plugin is newer, offer `node <plugin>/scripts/init.mjs --update-scripts` and say what changed if the plugin's CHANGELOG says. After an update, rebuild the tokens once (`tokens.mjs build`) so the generated files carry the new header, and run `init.mjs` again only to see its warnings. A project whose tokens are still the `tokens.json` from before 0.2.0 can move to the 2025.10 format with `tokens.mjs migrate`; offer it, never run it unasked.
3. **Tell the user where things stand** in three lines: what is done, what is in progress (with its progress note), and the single next step. Mention open explorations from the ux loop and any open question in STATUS.md.
4. **Route.** If the user said what they want ("let's do tokens", "keep going on the checkout redesign", "extract the system"), go there. Otherwise propose the next phase. On a yes, invoke the phase skill: `graph`, `stories`, `tokens`, `tidy`, `guard`, `figma`, `extract` (graph, tokens and docs in one flow, for a repo that has styling but no system yet), or `ux <topic>` for an exploration.

## Rules

- Never overwrite an existing file during kickoff; init.mjs refuses, and so do you.
- Keep questions few and concrete. Defaults are fine; record them as decisions so they can be revisited.
- Talk to designers in outcomes (what they will see, what they decide); show code to developers on request.
- End every run with the session protocol's End steps (project.md).
