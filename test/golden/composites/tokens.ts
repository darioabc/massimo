// Each leaf is the token as a CSS var() reference, so it follows the active theme.
export const tokens = {
  color: {
    ink: 'var(--color-ink)',
    teal: 'var(--color-teal)',
    vivid: 'var(--color-vivid)',
    white: 'var(--color-white)',
    film: 'var(--color-film)',
    bg: 'var(--color-bg)',
    text: 'var(--color-text)',
  },
  font: {
    family: {
      sans: 'var(--font-family-sans)',
      mono: 'var(--font-family-mono)',
    },
    weight: {
      regular: 'var(--font-weight-regular)',
      strong: 'var(--font-weight-strong)',
    },
  },
  size: {
    lg: 'var(--size-lg)',
    hairline: 'var(--size-hairline)',
  },
  space: {
    '1': 'var(--space-1)',
    '2': 'var(--space-2)',
  },
  radius: {
    md: 'var(--radius-md)',
    full: 'var(--radius-full)',
  },
  text: {
    body: 'var(--text-body)',
    label: 'var(--text-label)',
  },
  border: {
    thin: 'var(--border-thin)',
  },
  motion: {
    fast: 'var(--motion-fast)',
    ease: 'var(--motion-ease)',
    emphasis: 'var(--motion-emphasis)',
  },
  gradient: {
    sky: 'var(--gradient-sky)',
  },
  shadow: {
    card: 'var(--shadow-card)',
    ring: 'var(--shadow-ring)',
  },
  stroke: {
    focus: 'var(--stroke-focus)',
  },
  layer: {
    modal: 'var(--layer-modal)',
  },
  opacity: {
    scrim: 'var(--opacity-scrim)',
  },
} as const
