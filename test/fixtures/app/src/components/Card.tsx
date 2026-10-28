// FIU-10 stacked layout, FIU-2 first version
import { Button } from '@/components/Button'
import Panel from './Panel'

export type Theme = 'light' | 'dark'

export function Card() {
  return (
    <div className="card card-body bg-base-100 border-base-300/50" style={{ boxShadow: 'var(--shadow-card)' }}>
      <Panel />
      <Button />
    </div>
  )
}
