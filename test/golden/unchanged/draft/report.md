# Draft tokens

13 tokens, read from src/styles/theme.css and the code itself (16 files audited). Nothing here is in use yet: review it family by family with the tokens skill.

## Colour

| Token | Value | From | Note |
|---|---|---|---|
| `color.brand-teal` | #00d3bb | src/styles/theme.css |  |
| `color.base-100` | oklch(100% 0 0) | src/styles/theme.css | covers #ffffff, used 2× in code; description drafted from its name: "Background"; check it |
| `color.base-content` | oklch(21% 0.006 285.885) | src/styles/theme.css | description drafted from its name: "Text and icons on base backgrounds"; check it; contrast checked as text on color.base-100 |
| `color.brand` | {color.brand-teal} | src/styles/theme.css | description drafted from its name: "Brand colour for primary actions and emphasis"; check it |
| `color.primary` | #14b8a6 | src/styles/theme.css | description drafted from its name: "Brand colour for primary actions and emphasis"; check it |

## Typography

| Token | Value | From | Note |
|---|---|---|---|
| `font.sans` | "Geist Sans", system-ui, sans-serif | src/styles/theme.css |  |
| `font.size.13` | 0.8125rem | 13px used 3× in code | off Tailwind's scale, named by its size |
| `typography.13` | 0.8125rem / 1.5, weight 400 | the size scale | assumed line height 1.5, as the code sets none for body text, weight 400, the default, no letter spacing |

## Spacing

| Token | Value | From | Note |
|---|---|---|---|
| `spacing.base` | 0.25rem | src/styles/theme.css |  |
| `spacing.1_5` | 0.375rem | 6px used 3× in code | on the 2px grid |

## Radius

| Token | Value | From | Note |
|---|---|---|---|
| `radius.field` | 0.25rem | src/styles/theme.css |  |

## Shadow

| Token | Value | From | Note |
|---|---|---|---|
| `shadow.card` | 0 1px 2px rgb(0 0 0 / 0.1) | src/styles/theme.css |  |

## Other

| Token | Value | From | Note |
|---|---|---|---|
| `other.page-max` | 80rem | src/styles/theme.css |  |

## Not proposed

Values the code uses that did not become tokens: used once, off the grid, off a scale the sources already define, or only ever data. Replace each with a token in the tidy phase, or keep it with a reason.

| Family | Value | Uses | Note |
|---|---|---|---|
| Colour | #000000 | 1 | used once; use a token instead, or keep it with a reason |
| Colour | #00000080 | 1 | used once; use a token instead, or keep it with a reason |
| Colour | #00ff00 | 1 | used once; use a token instead, or keep it with a reason |
| Colour | #333333 | 1 | used once; use a token instead, or keep it with a reason |
| Colour | #ff0000 | 1 | used once; use a token instead, or keep it with a reason |
| Typography | 14px | 1 | a font size used once |
| Spacing | 8px | 1 | used once |
| Spacing | 12px | 1 | used once |
| Border | 1px solid #000 | 1 | used once |
| Border | 1px solid #333 | 1 | used once |
| Layers | 3 | 1 | used once |
