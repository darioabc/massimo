import type { Story } from '@ladle/react'
import { Editor } from './Editor'

export default { title: 'Patterns / Gauge / Editor' }

export const Empty: Story = () => <Editor steps={0} />

export const FiveSteps: Story = () => <Editor steps={5} />
