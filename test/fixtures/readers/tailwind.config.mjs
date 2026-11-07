import defaultTheme from 'tailwindcss/defaultTheme'

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./src/**/*.{astro,tsx}'],
  theme: {
    borderRadius: { none: '0', sm: '0.125rem', DEFAULT: '0.25rem', lg: '0.5rem' },
    extend: {
      fontFamily: {
        sans: ['Geist Sans', ...defaultTheme.fontFamily.sans],
      },
      colors: {
        base: { 100: 'rgb(var(--rgb-base-100) / <alpha-value>)', content: 'rgb(var(--rgb-base-content) / <alpha-value>)' },
        primary: { DEFAULT: '#0f766e', foreground: '#ffffff' },
        brand: 'var(--brand)',
        current: 'currentColor',
      },
      fontSize: {
        body: ['1rem', { lineHeight: '1.5rem', letterSpacing: '-0.01em', fontWeight: '400' }],
        hero: ['3rem', '1.1'],
        tiny: '0.75rem',
      },
      spacing: { gutter: computeGutter() },
      zIndex: { modal: '50' },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
