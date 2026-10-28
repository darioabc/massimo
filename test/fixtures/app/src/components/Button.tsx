// ds:group Primitives / Actions
// ds:use-when a user presses something to run an action; wrap
//   it for links via asChild
//
// ds:never nested inside another Button
//
// FIU-12 added the loading state, FIU-3 the icon slot
import { Slot } from '@radix-ui/react-slot'
import { Icon } from './Icon'
import type { Theme } from '@/components/Card'

export interface ButtonProps {
  loading?: boolean
}

export function Button({ loading }: ButtonProps) {
  return (
    <button className="btn btn-primary bg-primary text-base-content rounded-[var(--radius-field)]">
      <Slot />
      <Icon />
    </button>
  )
}
