// ds:group Patterns / Gauge
export function Editor({ steps }: { steps: number }) {
  return (
    <div className="gauge-editor">
      {Array.from({ length: steps }, (_, i) => (
        <span key={i} className="gauge-step" />
      ))}
    </div>
  )
}
