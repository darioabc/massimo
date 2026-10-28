---
name: status
description: Show where this repo's massimo design-system project stands — phases, progress, open explorations, open questions and the next step — without changing anything. Use when the user asks "where are we", "what's left", or "show the design-system status".
---

# massimo: status

Read-only. Two directories above this skill's base directory is the plugin root (`<plugin>`).

1. If `massimo.config.json` is missing at the repo root, say there is no project yet and offer `/massimo:start`.
2. Run `node design-system/scripts/state.mjs show` (use the `projectDir` from `massimo.config.json` if it is not `design-system`).
3. Read `design-system/STATUS.md` → Where we are, Next step, Open questions.
4. Reply in at most eight lines: done, in progress (with its note), next step and the command for it, open explorations, open questions. Link the files you mention.

Change nothing. If the state and STATUS.md disagree, say so and offer to reconcile with `/massimo:start`.
