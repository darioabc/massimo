// ds:group Primitives / Inputs
export function Field({ label }: { label: string }) {
  return (
    <label className="field">
      {label}
      <input />
    </label>
  )
}
