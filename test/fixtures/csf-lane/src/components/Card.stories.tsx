import type { Story } from '@ladle/react'
import { Card } from './Card'

export default { title: 'Patterns / Cards / Card' }

export const Plain: Story = () => <Card title="Plain" />

export const WithFooter: Story = () => (
  <Card title="With a footer" footer={<a href="#more">Read more</a>} />
)
WithFooter.meta = {
  drift: 'The footer gap is 12px here and 16px in the design.',
}
