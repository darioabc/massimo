// A harness only the review stories use: it fills a table with fixed rows.
export const ROWS = [
  { name: 'First', score: 4 },
  { name: 'Second', score: 2 },
]

export function ReviewTable({ rows = ROWS }: { rows?: { name: string; score: number }[] }) {
  return (
    <table className="review-table">
      <tbody>
        {rows.map((row) => (
          <tr key={row.name}>
            <td>{row.name}</td>
            <td>{row.score}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
