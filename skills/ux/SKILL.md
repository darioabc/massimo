---
name: ux
description: Iterative design loop for this repo's product. Review an existing screen, flow or component (usability, content, accessibility and visual craft against the products users already trust), or explore a new one, then generate rounds of real rendered mockups in the product's own tokens that the user compares side by side, picks from or sends back for another round, and translate the pick into a story built from the real components with a fidelity check and a build-ready spec. Use when the user wants design feedback, redesign options, mockups, to explore a new UI idea, or to continue an earlier design exploration.
argument-hint: "[topic or surface]"
---

# massimo: ux

Design by looking at real renders, in rounds, until the user picks. Fresh agents do the heavy work (baseline, reviews, ideation, translation); this skill orchestrates in the user's session, shows every round, and keeps the whole loop on disk so it can stop and resume at any point.

```text
review+build:  target → baseline gate → reviewer + visual-reviewer → synthesis → ideator rounds ⇄ user → pick → translator → fidelity gate → handoff
ideate:        problem → discovery + market scan → ideator rounds ⇄ user → pick → translator → fidelity gate → handoff
```

Plugin root: two directories above this skill's base directory (`<plugin>`). Read `<plugin>/reference/method.md` (the method) and `<plugin>/reference/mockups.md` (files, canvas, showing rounds) before the first dispatch. Follow `<plugin>/reference/project.md` → Session protocol. `<project>` is the project folder: `projectDir` in `massimo.config.json`, `design-system` by default.

## Startup

1. **Project.** If there is no `massimo.config.json`, the loop has nowhere to keep its state: offer `/massimo:start` (a quick setup that can skip every other phase). Read `<project>/product.md`; if it is mostly placeholders, ask the three questions that matter most for this topic (users, the bar, scope) and write the answers in.
2. **Topic.** Slug the topic from the argument or the user's words (`checkout-summary`). If `<project>/explorations/<topic>/brief.md` exists, this is a resume: read the brief, the latest `round-N/round.json`, and its verdict, tell the user where the loop stands in two lines, and continue from that step. Otherwise create the folder and `brief.md` (shape below) and run `state.mjs explore <topic> --arc <arc> --target "<surface>" --status framing`.
3. **Arc.** An existing surface (route, screen, component, flow) → review+build. Nothing exists yet → ideate. Two surfaces share a name → ask one short question.
4. **Kit.** Make sure `<project>/kit/kit.css` exists (`node <project>/scripts/tokens.mjs kit`), so mockups render in the product's real tokens.
5. **Capsule.** Distil `product.md` into a capsule of eight lines at most (users, the bar, brand feel, scope, accessibility bar, viewports, real-content source) and write it into the brief. Every dispatch carries it.

## Dispatch

Workers are this plugin's agents: `massimo:baseline`, `massimo:reviewer`, `massimo:visual-reviewer`, `massimo:ideator`, `massimo:translator`. Each dispatch prompt includes:

- plugin root, repo root, project folder, and the topic folder (absolute paths);
- the target (files, route, story URL) and viewports;
- the capsule, verbatim from the brief;
- the real content (or its source) and the market notes, when the step uses them;
- the step's specific inputs (below), and the return shape the agent's instructions define;
- the no-delegation rule: the agent does its step itself and dispatches nothing further.

Reviewers can run in parallel. Everything else is sequential. If the host has no way to start fresh agents, tell the user and, with their OK, run a worker's instructions inline from `<plugin>/agents/<name>.md` (degraded mode).

## Review+build arc

1. **Baseline gate.** The surface needs a current story with real content.
   - Find its story (graph `stories`, or the lane's manifest). Fail the gate when there is none, or when it predates material changes to the surface's source (`git log -1 --format=%cI` on the source files vs the story).
   - Pass → note the story URL and its real content.
   - Fail → dispatch `massimo:baseline` with the surface's source files and the real-content source. It returns a story path, screenshots and the real content, or says plainly it could not reach real content. If it could not, tell the user before round 1.
   - No story lane at all → screenshot the live page from the dev server instead, and say the baseline is a page screenshot.
   Record the baseline in the brief.
2. **Reviews.** `state.mjs explore <topic> --status reviewing`. The reviewers have no browser, so capture what they review first: a screenshot of each viewport and state the baseline shows (`shoot.mjs --url <story url> --out <project>/shots/kept/<topic>/baseline/<viewport>-<state>.png --width <w> --dom <same name>.txt`, or the host's browser tool, saving the page's accessibility tree or HTML as the text file). Dispatch `massimo:reviewer` and `massimo:visual-reviewer` together with those files, the story URL and the source files.
3. **Synthesis.** Pool, sort, merge and write one judgement in the shape from method.md. Put it in the brief. Show the user only the synthesis, never raw reports.
4. **Round 1.** Dispatch `massimo:ideator` in review mode with the synthesis, the market notes from the reviewer, the baseline screenshot and story path, the real content, and `round: 1`, writing to `<topic>/round-1/`.
5. **Loop.** See below.
6. **Translate, gate, hand off.** See below.

## Ideate arc

1. **Discover**, briefly: who feels the problem, adjacent surfaces in the repo (graph), hard constraints, what is out of scope. Write it in the brief.
2. **Market scan.** Look at how two or three comparable products handle this today (web search when available; the user's named references first). Note the pattern and source URLs in the brief.
3. **Framing.** One paragraph: the problem, for whom, the constraint that matters. Confirm it with the user in one line.
4. **Real content.** Find the closest real data for the new surface (from the product.md source, or an adjacent screen's real records). No invented data; if none exists, say so.
5. **Round 1.** Dispatch `massimo:ideator` in ideate mode with the framing, market notes, real content and `round: 1`.
6. **Loop**, then translate, gate, hand off.

## The loop

After every ideator return:

1. **Render and drift check.** The ideator has no browser, so open each returned direction yourself (served by `serve.mjs`, or `shoot.mjs`) and send back one that renders broken: overflow, the kit missing, unreadable contrast. From round 2, also compare each direction with the baseline file named in `round.json`. If anything outside the briefed axis changed (chrome dropped, columns or data altered, invented statuses), send that direction back to a fresh ideator with the drift named. Never show broken or drifted mockups.
2. **Show it.** `node <project>/scripts/canvas.mjs <project>/explorations/<topic>` and present it as mockups.md → Showing a round says (browser pane on `serve.mjs`, or a published single page with `--inline`, or inline HTML). One canvas URL for the whole loop.
3. **Synthesis**, short: verdict, recommended direction, why each direction matters, the trade-off.
4. **Ask for a decision** in plain words: lock one, use one as a seed for another round, none of these (another round), or stop for now. Use the host's question tool when available, recommendation first.
5. **Record.** Write the verdict into `round-N/round.json` (`decision`, `pick`, `feedback`), a line in the brief's Rounds log, `state.mjs explore <topic> --round N --status <awaiting-pick|ideating|translating|parked>` (on a lock, also `--pick round-N/<File>.html`), and `state.mjs decide` for a lock. Re-run canvas.mjs so the page shows the verdict.
6. **Next round** on seed or none: dispatch a fresh ideator with round N+1, the user's feedback, rejected directions, the seed if any, and the **canonical baseline's file path** (the seed's file when the user seeded; otherwise the round-1 most faithful direction). Three fresh directions by default. Do not repeat discovery or reviews unless the problem changed.
7. **Stop** → mark the exploration `parked` with a note on where to pick up; the brief already holds everything.

## Translate, fidelity gate, handoff

1. **Translate.** Dispatch `massimo:translator` with the picked direction's file path (it reads the file itself), its rationale and scope, the round history in brief, the target surface, and the story lane details. It renders the full picked surface as a story from real components and tokens, screenshots it, and writes `<project>/handoffs/<topic>.md` (element map: map / edit / new, files to touch, build route).
2. **Fidelity gate.** `state.mjs explore <topic> --status fidelity`, then dispatch `massimo:visual-reviewer` in fidelity mode with the picked mockup file and the translator's screenshots. Severity 3 or above → re-dispatch the translator once to amend, then review again. Still drifting → the user decides (accept, translate again, or reopen ideation). Severity 2 or below → build notes in the handoff. A copy-only pick with nothing to render skips the gate; say so.
3. **Handoff.** Show the user the story render beside the approved mockup, and the handoff summary: what maps to existing components, what edits a shared primitive (with its blast radius from the graph), what is new. `state.mjs explore <topic> --status handed-off`.
4. **Build, if asked.** The handoff is the plan. Offer to implement it now in this session (wire the story-proven components into the real route, on a branch, with the repo's checks), or leave it for a developer. A new reusable component or token goes back through the graph and tokens skills' rules. After a build, `state.mjs explore <topic> --status built`.

## brief.md

```markdown
# <Topic title>

- Arc: review | ideate
- Target: <surface; files; route or story URL>
- Viewports: <e.g. desktop 1280, mobile 375>
- Started: <date>

## Capsule
## Framing
## Market notes
## Baseline
## Review synthesis
## Rounds
- Round 1 (<date>): <directions>. Verdict: <decision> — "<feedback>"
## Pick
## Handoff
```

## Rules

- No code before the user locks a direction. After the lock, the translator builds a story; the live app is only touched in the optional build step, on the user's say-so.
- The user reviews renders, never ASCII. ASCII is allowed only for a pure flow or information-architecture question.
- "Closest", "nearly", "none" are loop signals, not picks.
- Show one synthesised judgement, never raw agent output.
- Keep the brief current after every step; it is how the next session resumes.
