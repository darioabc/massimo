// #123456 in a comment must not count
export function Raw() {
  return (
    <div
      className="p-[6px] bg-[#0f0] text-[13px] text-red-600 hover:bg-slate-50 text-sm bg-brand grid-cols-[1fr_2fr]"
      style={{ fontSize: 13, padding: '6px 8px', borderRadius: 4, fontFamily: 'Inter, sans-serif', width: 800, zIndex: 3 }}
    >
      <a href="#features">jump</a>
      <span style={{ color: '#FF0000', background: 'rgba(0, 0, 0, 0.5)', border: '1px solid #333' }} />
      <i style={{ color: 'var(--color-neutral-0)', margin: 'var(--space)', fill: 'var(--missing-var)', stroke: 'var(--with-fallback, red)' }} />
    </div>
  )
}
