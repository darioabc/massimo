// ds:group Patterns / Cards
import type { ReactNode } from 'react'

export function Card({ title, footer }: { title: string; footer?: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {footer ? <footer className="card-footer">{footer}</footer> : null}
    </section>
  )
}
