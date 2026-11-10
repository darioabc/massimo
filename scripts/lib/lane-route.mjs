// The lane's URLs, shared by the Vite plugin, the shell and the canvas. This
// module imports nothing, because the plugin inlines its text into the
// virtual module the browser loads.
//
//   index            /  or  /stories       (`?s=<id>` selects a state in the shell)
//   slug             /stories/<slug>
//   state            /stories/<slug>/<state>
//   legacy           /?story=<id>
//   legacy-preview   /?story=<id>&mode=preview
//
// Every URL may carry `mode=preview`, switches as `<name>=<value>`, and
// Ladle's args as `arg-<name>=<value>`.

// Query keys that are never a switch.
const RESERVED = new Set(['story', 'mode', 's'])

const decodeSegment = (s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

// What a URL asks for, as { kind, slug, state, selected, preview, switches,
// args, oldId }. `selected` is the shell's `?s=<id>`, `oldId` the id a
// legacy URL names, `switches` every query key that is not reserved or an
// arg, and `args` Ladle's `arg-<name>` values as strings. A path the lane
// does not serve is `missing`.
export function parseLaneUrl(pathname, search) {
  const params = new URLSearchParams(search ?? '')
  const out = { kind: 'missing', slug: null, state: null, selected: params.get('s'), preview: params.get('mode') === 'preview', switches: {}, args: argsFromSearch(search), oldId: null }
  for (const [key, value] of params) if (!RESERVED.has(key) && !key.startsWith('arg-')) out.switches[key] = value
  const path = (pathname || '/').replace(/\/+$/, '') || '/'
  if (path === '/' || path === '/index.html') {
    const story = params.get('story')
    if (story) {
      out.kind = out.preview ? 'legacy-preview' : 'legacy'
      out.oldId = story
    } else out.kind = 'index'
    return out
  }
  if (path === '/stories') {
    out.kind = 'index'
    return out
  }
  const m = /^\/stories\/([^/]+)(?:\/([^/]+))?$/.exec(path)
  if (!m) return out
  const slug = decodeSegment(m[1])
  const state = m[2] === undefined ? null : decodeSegment(m[2])
  if (slug === null || (m[2] !== undefined && state === null)) return out
  out.kind = state === null ? 'slug' : 'state'
  out.slug = slug
  out.state = state
  return out
}

// The canvas URL of a registry entry, or '' for an entry with no slug or
// state. Arg values are written as Ladle writes them: a string as it is, any
// other value as JSON, each through encodeURI.
export function stateUrl(entry, { preview = false, switches = {}, args = {} } = {}) {
  if (!entry?.slug || !entry?.state) return ''
  const path = `/stories/${encodeURIComponent(entry.slug)}/${encodeURIComponent(entry.state)}`
  const params = new URLSearchParams()
  if (preview) params.set('mode', 'preview')
  for (const [name, value] of Object.entries(switches ?? {})) if (value !== null && value !== undefined) params.set(name, String(value))
  for (const [name, value] of Object.entries(args ?? {})) params.set(`arg-${name}`, encodeURI(typeof value === 'string' ? value : JSON.stringify(value)))
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

// The shell URL that selects one state.
export function shellUrl(id) {
  return `/stories?s=${encodeURIComponent(id)}`
}

// `ids` in the order `order` gives, in Ladle's storyOrder form: an entry
// with `*` takes every id that starts with the text before its first `*`,
// any other entry the one id it names, and an id already placed stays where
// it is. The ids no entry takes follow, as they came (Ladle drops them).
export function orderIds(ids, order) {
  if (!order || order.length === 0) return [...ids]
  const placed = new Set()
  for (const entry of order) {
    const pattern = String(entry).toLowerCase()
    const star = pattern.indexOf('*')
    for (const id of ids) {
      if (!placed.has(id) && (star === -1 ? id === pattern : id.startsWith(pattern.slice(0, star)))) placed.add(id)
    }
  }
  return [...placed, ...ids.filter((id) => !placed.has(id))]
}

// Ladle's `arg-<name>=<value>` pairs from a query string, as { name: value }
// with each value a string, decoded as Ladle decodes it. The name is all of
// the key after `arg-`.
export function argsFromSearch(search) {
  const out = {}
  for (const [key, value] of new URLSearchParams(search ?? '')) {
    if (!key.startsWith('arg-') || key.length === 4) continue
    let decoded = value
    try {
      decoded = decodeURI(value)
    } catch {
      // a lone `%` stays as it is
    }
    out[key.slice(4)] = decoded
  }
  return out
}
