# The design method

Shared by the `ux` skill and its workers (`reviewer`, `visual-reviewer`, `ideator`, `translator`, `baseline`). Skills hold the workflow; this holds the method.

## Pipeline

```text
review+build:  target → baseline gate → reviewer + visual-reviewer → synthesis → ideator rounds ⇄ user → pick → translator → fidelity review ⇄ amend → handoff
ideate:        problem → discovery + market scan → ideator rounds ⇄ user → pick → translator → fidelity review ⇄ amend → handoff
```

The `ux` skill orchestrates in the user's session. Reviews, ideation, translation and baselines run in fresh agents, so each starts clean and returns one artefact.

## Product grounding

`<project>/product.md` is the grounding every dispatch carries, distilled to a short capsule:

- **Users.** Who they are, what they are trying to get done, which products they use daily.
- **The bar.** Two or three reference products the surface should look credible beside.
- **Brand feel.** A few words, and what to avoid.
- **Scope.** What is in scope to design, and what the product deliberately does not do.
- **Accessibility bar.** WCAG A or AA, as the team chose.
- **Real content.** Where real data lives (staging API, fixtures, CMS, seed files).

When a market pattern and the scope disagree, scope wins. A product is not behind the market for lacking a feature it chose not to ship.

## The market lens

Judge against what comparable products do today, not against UX theory. A finding cites a real product pattern or a concrete failure, never a heuristic's name. Name two or three comparable products per surface: direct competitors first, cross-sector analogues only when no competitor shows the pattern.

## Severity

One scale everywhere:

- `4` blocks the goal or breaks trust.
- `3` major friction; the surface feels unready or clearly behind the bar.
- `2` noticeable; credibility or flow drops.
- `1` small refinement.
- `0` probe passed.

## Finding record

Reviewers return records, not essays.

```markdown
### Finding N: severity <0-4>
- lens: market | content | interaction | accessibility | visual-craft
- problem: <specific issue, for whom>
- evidence: <the pattern missed, the concrete failure, or the named product it falls short of>
- user_angle: <why it matters to these users>
- fix: <copy pair, one-line direction, or none>
```

## Synthesis

The orchestrator pools both reviewers' records, sorts by severity, merges duplicates, and writes one judgement in one voice:

```markdown
Verdict: <one sentence>
Recommended direction: <name, or "keep ideating">
Round: <N>

Findings:
1. [sev N] <problem>: <evidence>; <user angle>

Fit for users: <one honest line>
```

## Real content, always

Mockups and baseline stories use real content: a real record from the source named in `product.md`, or for a new surface the closest real analogue found in discovery. Invented placeholder data produces confidently wrong findings, because the real data is often where the design problem lives (long names, empty states, odd counts). When real content cannot be reached, say so and tell the user before the round, instead of filling the gap with something plausible.

Invent freely on craft (components, layouts, token values). Never invent the data.

## Iteration

1. A confirmed pick is the only way into translation. "None", "not yet", "closest but…" mean another round.
2. Round 1: one direction when the move is obvious, two or three when the trade-off is real, never more than three.
3. Follow-up rounds: three fresh directions by default. A seed narrows the axis, not the count.
4. Do not repeat discovery, market scan or reviews unless the problem, users or constraints change.

## Fidelity across rounds

Mockups decay when each round is regenerated from a description: the description narrows to the new requirement, and the fresh agent fills the gaps by inventing chrome, columns and data. So:

1. Round 1's most faithful direction becomes the **canonical baseline** (in review+build, the real surface reproduced faithfully).
2. Every follow-up round gets the baseline's **file path**, reads it byte for byte, and changes only the briefed axis. Everything else stays identical.
3. When the user locks a new seed, its file becomes the baseline.
4. Before showing a round, the orchestrator compares each direction with the baseline and sends back any that changed what was not briefed.

## Translation

The picked mockup was free to invent. The build is not. Every element resolves to exactly one of:

- **Map** to an existing component or token.
- **Edit** an existing primitive, when the change is meant to reach every consumer (flag the blast radius).
- **New**: formalise a real reusable component or token.

Never transcribe a mockup's literal hex or px into the build: resolve it to a token or the spacing scale. The translator renders the full picked surface as a story in the repo's native lane, screenshots it, and returns an element map.

## Fidelity gate

After translation, the visual reviewer runs in fidelity mode: approved mockup vs story screenshot. Severity 3 or above bounces back to the translator once. If it still drifts, the user decides (accept, translate again, or reopen ideation). Severity 2 or below rides into the handoff as build notes.

## Verbosity

The skills model the brevity they ask for. Records are terse, the synthesis is short, directions carry a few lines of rationale and let the mockup speak.
