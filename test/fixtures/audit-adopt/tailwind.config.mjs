const role = (v) => ({ opacityValue }) => (opacityValue === undefined ? v : `color-mix(in srgb, ${v} calc(${opacityValue} * 100%), transparent)`)

export default {
  content: ['./src/**/*.{astro,ts}'],
  theme: {
    extend: {
      colors: {
        c: { text: role('var(--c-text)'), line: role('var(--c-line)') },
      },
      screens: { tablet: '900px' },
    },
  },
}
