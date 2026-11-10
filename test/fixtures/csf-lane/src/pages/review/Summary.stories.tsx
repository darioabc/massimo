import type { Story } from '@ladle/react'
import { ReviewTable } from './tableHarness'

// Compare.stories.tsx shares this title, so both files sit under one slug.
export default { title: 'Pages / Review / Summary' }

export const Overview: Story = () => <ReviewTable />
Overview.parameters = { width: 1440 }

// The underscore reads as a break, so Ladle's id gains a level here.
export const StateB_Admin: Story = () => <ReviewTable rows={[]} />
