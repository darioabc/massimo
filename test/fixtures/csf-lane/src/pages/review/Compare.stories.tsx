import type { Story } from '@ladle/react'
import { ReviewTable, ROWS } from './tableHarness'

export default { title: 'Pages / Review / Summary' }

export const SideBySide: Story = () => (
  <div className="review-compare">
    <ReviewTable />
    <ReviewTable rows={ROWS.slice(1)} />
  </div>
)
