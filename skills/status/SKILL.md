---
name: status
description: Show where this repo's massimo design-system project stands (phases, progress, open explorations, open questions and the next step) without changing anything. Use when the user asks "where are we", "what's left", or "show the design-system status".
---

# massimo: status

Read-only. Two directories above this skill's base directory is the plugin root (`<plugin>`). `<project>` is the project folder: `projectDir` in `massimo.config.json`, `design-system` by default.

1. If there is no `massimo.config.json` in the folder Claude started in or any folder above it up to the repo root (git toplevel), say there is no project yet and offer `/massimo:start`. The nearest one is the project.
2. Run `node <project>/scripts/state.mjs show`.
3. Read `<project>/STATUS.md` → Where we are, Next step, Open questions.
4. Reply in at most eight lines: done, in progress (with its note), next step and the command for it, open explorations, open questions. Link the files you mention.

Change nothing. If the state and STATUS.md disagree, say so and offer to reconcile with `/massimo:start`.
