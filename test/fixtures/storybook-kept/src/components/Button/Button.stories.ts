import type { Meta, StoryObj } from '@storybook/vue3'
import Button from './Button.vue'

const meta = { component: Button } satisfies Meta<typeof Button>
export default meta
type Story = StoryObj<typeof meta>

export const Primary: Story = { args: { label: 'Save changes' } }
export const WithIcon: Story = { name: 'With an icon', args: { label: 'Download report', icon: 'download' } }
export const XLarge: Story = { args: { label: 'Continue to payment' } }
