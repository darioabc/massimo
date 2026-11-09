import type { Story, StoryDefault } from '@ladle/react'

export default {
  title: 'Explorations / New header',
  meta: { exploration: 'A taller header with the search field inline, kept for the next review.' },
} satisfies StoryDefault

export const Wide: Story = () => (
  <header className="new-header">
    <strong>Library</strong>
    <input placeholder="Search" />
  </header>
)

export const Narrow: Story = () => (
  <header className="new-header new-header-narrow">
    <strong>Library</strong>
  </header>
)
Narrow.meta = { width: 375 }
