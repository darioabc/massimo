import { render } from '@testing-library/react'
import * as stories from './Button.stories'

// Every named export mounts without throwing.
for (const [name, Story] of Object.entries(stories)) {
  if (name === 'default') continue
  test(`${name} mounts`, () => {
    render(<Story size="md" />)
  })
}
