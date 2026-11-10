---
name: start
description: Start or resume massimo's design-system project in this repo. Use when the user wants to set up a design system, build or clean up tokens, components or stories, "kick off design automation", or continue design-system work from an earlier session ("where are we", "carry on", "next step"). On first run it detects the stack, asks a few short questions, and creates the in-repo project; on later runs it reads the project's status and routes to the next phase.
---

# massimo: start

Front door for everything massimo does in a repo. It sets the project up once, then on every later run reads where things stand and hands over to the right phase skill. A designer or developer should never need to remember which command comes next.

**Plugin root.** Two directories above this skill's base directory. Call it `<plugin>`; scripts are at `<plugin>/scripts/`. Read `<plugin>/reference/project.md` now: it is the contract for the project folder, phases and session protocol. `<project>` is the project folder: `projectDir` in `massimo.config.json`, `design-system` by default.

## Which path

Look for `massimo.config.json` in the folder Claude started in and each folder above it, up to the repo root (git toplevel). The nearest one is the project, and its folder is the project root: a monorepo can keep the project in one package.

A session started at the repo top does not see a project kept in a package, and neither does the session hook. In a monorepo with no config at the top, look for `massimo.config.json` in its packages before taking Kickoff; when one has it, take Resume and run the scripts from inside that package.

- **Absent** → Kickoff.
- **Present** → Resume.

## Kickoff

1. **Detect.** Run `node <plugin>/scripts/detect.mjs`. Summarise it in four or five plain lines: framework, styling, where components seem to live (with counts), the style files that hold tokens, existing story tools, Playwright yes/no, and, when it reports `adoptable`, what the repo already has for its design system. Then settle where the project lives. In a monorepo it is one of two places, and the `monorepo` flag alone does not tell which:
   - **The root, with globs into the packages**, when the design system spans packages: components, stories or tokens sit in more than one package, or the story tool's config (`.storybook/`, `.ladle/`) or the tokens sit at the root while the components live in packages, as in a repo with one package per component. Keep the root and point the config's globs into the packages, for example `packages/*/src/**/*.{tsx,jsx}` for components; detect suggests such a glob when it finds one package per component. Every script then runs from the root, as in any repo.
   - **One package**, when the root holds packages and nothing of its own: detect lists `nestedPackages` and finds no framework, no component folders and no style files at the root. At a workspace root the packages are its workspace members, not `nestedPackages`, and detect may take the framework from them, so take this branch too when the members are separate apps, or when the user works on one app of several. Ask which package, and re-run detect with `--root <package>`; inside a workspace it also reads what the workspace root installs and the story tool config kept there.

   When it is not clear, show the user both and recommend the root when the story tool or the tokens live there. A chosen package reaches init through `--root <package>` (step 4). From then on, run every script from inside that package (`cd <package>` first), or pass the same `--root <package>` to every script: a script finds the project from the folder it runs in, not from where the script lives, so a run from the repo top does not see a project kept in a package.
2. **Ask.** One round of questions, two at most. Use the host's question tool when there is one; otherwise ask in plain text with a recommended answer for each. Ask only what detection could not settle:
   - Who is driving: a designer, a developer, or both? (It sets how much code you show versus visuals.)
   - Confirm or correct the component folders and token files detect found.
   - The product, its users, and two or three products whose quality bar they want to match.
   - Brand feel in a few words, and the accessibility bar (WCAG A or AA; recommend AA for public products).
   - Which phases they want. Default: all of graph → stories → tokens → tidy → guard; Figma mirror only if they use Figma. Recommend the full path for a repo with no system yet; "graph + stories + ux" for a team that only wants the design loop. When detect found styling (style files with custom properties, a Tailwind config, theme files) but no token set, recommend starting with `/massimo:extract`: it proposes the whole system from what the code already uses (tokens for every family, a usage rule per primitive, a README) and does the graph, tokens and docs work in one sitting.
   - Where real content lives (staging API, seed data, fixtures), so mockups never invent data.
3. **Adopt, or the native lane.** If detect reports `adoptable` (a story lane or story tool, `ds:` keys of the repo's own, its own graph, ratchet or token list, a DESIGN.md), say what it found and recommend adopt: massimo keeps and drives the repo's own setup through its config, and runs beside the repo's own tools until the two agree, instead of generating a new one. Show the user what adopt would work from with `node <plugin>/scripts/adopt.mjs scan`, which writes nothing: each part it found and who depends on it. Once the project exists, `/massimo:adopt` takes it from there. Recommend massimo's native story lane only when there is nothing to adopt; it renders through the repo's own build, so what you see is what ships. If detect reports `storyTools.lane`, the repo already has a gated lane of massimo's kind: say so, keep it, and nothing is scaffolded. Record the choice.
4. **Create.** Run `node <plugin>/scripts/init.mjs --config-json '<json>'` with any corrections from step 2 (component globs, style files, projectDir), and with `--root <package>` when step 1 chose a package. Show the user what it created and skipped, including the package.json scripts it added, and its warnings. When a warning says a format check would flag the project folder or the config, offer to add what it names to the ignore file or the tool's config it names; init writes nothing there. When the repo has something to adopt, init sets the adopt phase to do.
5. **Ground.** Write `<project>/product.md` from the answers (replace the template's placeholders; leave a section as "unknown" rather than inventing). Record each answer that is a choice with `state.mjs decide`.
6. **Plan.** For each phase the user does not want: `node <project>/scripts/state.mjs set <phase> skipped --note "<why>"`, adopt included when they chose the native setup over the repo's own. Then `state.mjs set setup done --note "<framework>, <styling>"`.
7. **Hand over.** Show the roadmap (`state.mjs show`), write STATUS.md's hand-written sections, and offer to start the next phase now by invoking its skill (`/massimo:<skill>`). When the user chose adopt, the next phase is adopt: invoke `/massimo:adopt`, which scans, plans, configures, shadows, proves, cuts over and retires, one class at a time. Scan proposes no path rules, so its configure step helps the user add rules to `graph.taxonomy.rules` for the files with no `ds:group` line.

## Resume

1. Run `node <project>/scripts/state.mjs show` and read `<project>/STATUS.md`.
2. **Scripts current?** Compare the vendored `<project>/scripts/lib/project.mjs` `SCRIPTS_VERSION` with `<plugin>/scripts/lib/project.mjs`. If the plugin is newer, offer `node <plugin>/scripts/init.mjs --update-scripts` and say what changed if the plugin's CHANGELOG says. After an update, rebuild the tokens once (`tokens.mjs build`) so the generated files carry the new header, and run `init.mjs` again only to see its warnings. A project whose tokens are still the `tokens.json` from before 0.2.0 can move to the 2025.10 format with `tokens.mjs migrate`; offer it, never run it unasked.
3. **Tell the user where things stand** in three lines: what is done, what is in progress (with its progress note), and the single next step. Mention open explorations from the ux loop and any open question in STATUS.md.
4. **Route.** If the user said what they want ("let's do tokens", "keep going on the checkout redesign", "extract the system"), go there. Otherwise propose the next phase. On a yes, invoke the phase skill: `adopt` (when the adopt phase is to do or in progress, or the user wants to bring an existing setup in; its ledger, shown by `node <project>/scripts/adopt.mjs status`, is where it stands), `graph`, `stories`, `tokens`, `tidy`, `guard`, `figma`, `extract` (graph, tokens and docs in one flow, for a repo that has styling but no system yet), or `ux <topic>` for an exploration.

## Rules

- Never overwrite an existing file during kickoff; init.mjs refuses, and so do you.
- Keep questions few and concrete. Defaults are fine; record them as decisions so they can be revisited.
- Talk to designers in outcomes (what they will see, what they decide); show code to developers on request.
- End every run with the session protocol's End steps (project.md).
