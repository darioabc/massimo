// Small text helpers the scripts share: numeric-aware sorting, HTML escaping
// and reading a boolean flag. Locale-free on purpose, so output is the same
// on every machine.

import { compare } from './glob.mjs'

// Numeric-aware order, so `spacing-2` sorts before `spacing-10` and PROJ-9 before PROJ-10.
export function natural(a, b) {
  const pa = a.split(/(\d+)/)
  const pb = b.split(/(\d+)/)
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue
    if (i % 2 === 1) return Number(pa[i]) - Number(pb[i])
    return compare(pa[i], pb[i])
  }
  return pa.length - pb.length
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

// Text safe inside HTML content and double-quoted attributes.
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ESC[c])

// A flag given bare (`--strict`) or as `--strict=true`.
export const truthy = (v) => v === true || v === 'true'
