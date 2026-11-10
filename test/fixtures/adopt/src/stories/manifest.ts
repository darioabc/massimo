/** The stories the lane renders, one entry per page at
 *  `src/stories/pages/<slug>/index.astro`. */
export interface StoryEntry {
  slug: string
  title: string
  description: string
  root: string
  group: string
  component?: string | string[]
  states?: string[]
  frame?: boolean
}

/** The roots, in the order the index walks them. */
export const ROOTS = [{ name: 'Foundations' }, { name: 'Primitives' }, { name: 'Components' }, { name: 'Pages' }]

export const stories: StoryEntry[] = [
  /* ── Foundations ── */
  {
    slug: 'colours',
    title: 'Foundations / Colour / Palette',
    root: 'Foundations',
    group: 'Colour',
    description: 'Every colour token as a swatch.',
  },
  {
    slug: 'button',
    title: 'Primitives / Actions / Button',
    root: 'Primitives',
    group: 'Actions',
    component: 'src/components/Button.astro',
    states: ['Solid', 'Quiet'],
    description: 'The one button, solid and quiet.',
  },
  {
    slug: 'card',
    title: 'Components / Cards / Card',
    root: 'Components',
    group: 'Cards',
    component: ['src/components/Card.astro'],
    frame: true,
    description: 'A card at phone and desktop widths.',
  },
  {
    slug: 'home',
    title: 'Pages / Home / Home',
    root: 'Pages',
    group: 'Home',
    component: 'src/pages/index.astro',
    description: 'The home route, in a frame.',
  },
]

export const ordered = [...stories].sort((a, b) => (a.title < b.title ? -1 : 1))
