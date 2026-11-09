import type { Story } from '@ladle/react'
import { Button } from './Button'

export default { title: 'Primitives / Actions / Button' }

export const Primary: Story = () => <Button>Save</Button>

// The storyName gives the id, so `Log-In` keeps Ladle's double hyphen.
export const LogIn: Story = () => <Button>Log in</Button>
LogIn.storyName = 'Log-In button'
LogIn.meta = { width: 375 }

export const Sized: Story<{ size: 'sm' | 'md' | 'lg' }> = ({ size }) => (
  <Button size={size}>Sized</Button>
)
Sized.args = { size: 'md' }
Sized.argTypes = {
  size: { options: ['sm', 'md', 'lg'], control: { type: 'select' } },
}
