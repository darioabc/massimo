// Use it as: module.exports = { theme: { extend: require('./tokens.tailwind.cjs') } }
// Colours are var() references, so opacity modifiers (bg-primary/50) need channel-form variables.
module.exports = {
  colors: {
    ink: 'var(--color-ink)',
    teal: 'var(--color-teal)',
    vivid: 'var(--color-vivid)',
    white: 'var(--color-white)',
    film: 'var(--color-film)',
    bg: 'var(--color-bg)',
    text: 'var(--color-text)',
  },
  spacing: {
    '1': 'var(--space-1)',
    '2': 'var(--space-2)',
  },
  borderRadius: {
    md: 'var(--radius-md)',
    full: 'var(--radius-full)',
  },
  fontFamily: {
    sans: 'var(--font-family-sans)',
    mono: 'var(--font-family-mono)',
  },
  fontWeight: {
    regular: 'var(--font-weight-regular)',
    strong: 'var(--font-weight-strong)',
  },
  fontSize: {
    body: ['var(--text-body-font-size)', {
      fontWeight: 'var(--text-body-font-weight)',
      lineHeight: 'var(--text-body-line-height)',
      letterSpacing: 'var(--text-body-letter-spacing)',
    }],
    label: ['var(--text-label-font-size)', {
      fontWeight: 'var(--text-label-font-weight)',
      lineHeight: 'var(--text-label-line-height)',
      letterSpacing: 'var(--text-label-letter-spacing)',
    }],
  },
  boxShadow: {
    card: 'var(--shadow-card)',
    ring: 'var(--shadow-ring)',
  },
  transitionTimingFunction: {
    ease: 'var(--motion-ease)',
  },
  transitionDuration: {
    fast: 'var(--motion-fast)',
  },
  zIndex: {
    modal: 'var(--layer-modal)',
  },
  opacity: {
    scrim: 'var(--opacity-scrim)',
  },
}
