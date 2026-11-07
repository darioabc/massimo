---
version: "alpha"
name: "fixture-app"
colors:
  ink: "#00000033"
  teal: "oklch(0.7 0.1 200)"
  vivid: "#ff000080"
  white: "#ffffff"
  film: "#983eff"
  bg: "#ffffff"
  text: "{colors.ink}"
typography:
  body:
    fontFamily: "Inter"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0px"
  label:
    fontFamily: "Inter"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.02rem"
rounded:
  md: "6px"
  full: "9999px"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
---


# fixture-app

## Overview

fixture-app's design system, for people and coding agents. The tokens come from design-system/tokens/tokens.json, the single source of truth; use them by name, never their raw values.

## Colors

- `colors.ink`: Hairlines and shadows

These colours are written in code in a form DESIGN.md does not read, so this file holds their nearest sRGB hex:
- `colors.vivid`: color(display-p3 1 0 0 / 0.5) in code
- `colors.white`: hsl(none 0% 100%) in code
- `colors.film`: color(rec2020 0.5 0.25 1) in code

Pairs checked for contrast at WCAG 2.2 AA:
- `color.text` on `color.bg`: at least 4.5:1 (text)

## Layout

The spacing scale: `1` 0.25rem, `2` 0.5rem. Space between and inside elements comes from this scale.

## Elevation & Depth

- `shadow.card`: 0px 1px 2px 0px #00000033
- `shadow.ring`: 0px 4px 12px 0px #0000001a, inset 0px 0px 0px 1px #00000033

## Shapes

Corner radii: `md` 6px, `full` 9999px.
