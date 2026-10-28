# The canon

Massimo is named in homage to Massimo Vignelli, who treated design as a discipline of systems: few typefaces, a strict grid, a constrained palette, every element there for a reason. These are working principles in that spirit, written for design systems in code. They are how massimo judges an audit, a token proposal, a tidy batch, or a mockup. They are not a quotation of his writing.

## Economy

A system earns its keep by having less in it.

- **Type families:** one, two at most (text plus display or mono). A third needs a reason the user agrees to.
- **Type sizes:** a scale of six to eight steps covers almost every product. Twenty distinct sizes in an audit means there is no scale.
- **Colour:** neutrals, one brand hue, and status colours (info, success, warning, error). Every extra hue must carry a meaning no existing one carries.
- **Spacing:** one base unit (usually 4px) and its multiples. Off-grid values are drift, not nuance.
- **Radii, shadows, motion:** three or four steps each.

When an audit finds forty greys, the job is not to name forty tokens. It is to find the five the design actually needs.

## Meaning before value

Name tokens for what they do (`color.text.muted`, `color.surface.raised`), not what they look like (`gray-500`). Primitive ramps can carry look-names; components consume semantic tokens only. A semantic token means one thing everywhere it appears.

## Consistency of relationships

Elements relate through the system, not through one-off adjustments: the same gap between label and field everywhere, the same step between heading levels, the same radius family. A local fix that breaks a relationship is a bug, even if the screen looks fine.

## Appropriateness

The right solution comes from the problem, the users and the medium, not from a trend. Match the reference products the users already trust; do not decorate past them.

## Discipline in change

Change the system, not the instance. A value that needs to differ becomes a token or a variant, with a recorded decision. Nothing is hand-rolled in place.

## Timelessness

Prefer forms that will still read well in five years: clear hierarchy, honest type, generous space. Novelty is fine in ideation; the build keeps only what the system can absorb.

## Using the canon

- The audit reports its "canon numbers": distinct colours, colour clusters, font sizes, families, off-grid spacing, arbitrary values. Quote them; they are the clearest way to show a team where the system leaks.
- A token proposal states how far it moves each number (e.g. "41 colours → 14 tokens").
- A review cites the canon only when a finding is about consistency or economy, and still names the product or the failure. The canon is not a substitute for evidence.
