# fixture-app design system

How this repo's design system works. The part between the massimo markers is generated (`docs.mjs`); write anything else around it.

<!-- massimo:docs:start -->
## Tokens

11 tokens in `design-system/tokens/tokens.json` (the format massimo wrote before 0.2.0), in 2 themes: light, dark. Colour 5, Size and space 5, Type 1.

Change a value in the token files, then run `node ../project/scripts/tokens.mjs build`. Never edit a generated file; each says where it comes from. Components read the semantic tokens below, not the raw values or the ramps.

Built into: `src/styles/tokens.generated.css` (css), `src/styles/tokens.tailwind.css` (tailwind4), `src/styles/tokens.tailwind.cjs` (tailwind3), `src/styles/_tokens.scss` (scss), `src/styles/tokens.flat.json` (json), `src/styles/tokens.ts` (ts).

| Token | Means |
|---|---|
| `color.bg.default` | Page background |
| `color.fg.muted` | Secondary text |

Contrast is checked in every theme for 1 pair (WCAG 2.2: text 4.5:1, large text, UI and focus 3:1): `color.fg.muted` on `color.bg.default`.

## Components

11 components, 3 with a story, 1 with a usage rule. The full map, with who uses what, is `../project/graph.md`.

### Primitives

| Component | Use it when | Props |
|---|---|---|
| components/Button | a user presses something to run an action; wrap it for links via asChild | loading: true, false |

### Pages

| Component | Use it when | Props |
|---|---|---|
| Hero | no rule yet |  |

9 components have no `ds:group` yet: Badge, Card, Chip, forms/Button, Icon, Other, Panel, Toolbar, Tooltip.

## Checks

No `ds:check` script yet; the guard phase adds one for CI.

## Designing

Start a design with `/massimo:ux <topic>`: it reviews the surface or frames the idea, generates mockups in these tokens, and turns the pick into a story and a handoff.
<!-- massimo:docs:end -->

## Who decides what

Name who approves token values, who approves component APIs, and who signs off a design.
