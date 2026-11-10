// ds:group Primitives / Actions
import type { ReactNode } from 'react'

export function Button({ size = 'md', children }: { size?: 'sm' | 'md' | 'lg'; children: ReactNode }) {
  return <button className={`btn btn-${size}`}>{children}</button>
}
