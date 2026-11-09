// The lane's URLs, shared by the Vite plugin, the shell and the canvas. This
// module imports nothing, because the plugin inlines its text into the
// virtual module the browser loads.
//
//   index            /  or  /stories
//   slug             /stories/<slug>
//   state            /stories/<slug>/<state>
//   legacy           /?story=<id>
//   legacy-preview   /?story=<id>&mode=preview
//
// A stub until the routes land; each function already returns its shape.

// What a URL asks for. `selected` is the shell's `?s=<id>`.
export function parseLaneUrl(pathname, search) {
  return { kind: 'missing', slug: null, state: null, selected: null, preview: false, switches: {}, args: {}, oldId: null }
}

// The canvas URL of a registry entry.
export function stateUrl(entry, { preview, switches, args } = {}) {
  return ''
}

// The shell URL that selects one state.
export function shellUrl(id) {
  return ''
}

// `ids` in the order the `order` globs give, then the rest as they came.
export function orderIds(ids, order) {
  return []
}

// Ladle's `arg-<name>=` pairs from a query string.
export function argsFromSearch(search) {
  return {}
}
