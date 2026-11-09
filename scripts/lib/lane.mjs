// The csf lane's registry: every story file read in place, every state with
// its id, route, merged meta and source span. Read by the Vite plugin, by
// stories.mjs, the graph, convert and verify. A stub until the reader lands;
// each function already returns the shape it will fill.

// The registry of `files` (repo-relative story paths), read through `read(file)`.
export function laneRegistry({ root, config, files, read } = {}) {
  return {
    format: 1,
    ids: config?.stories?.ids ?? 'export',
    stories: {},
    order: [],
    home: null,
    slugs: {},
    files: {},
    problems: [],
  }
}

// The registry in the shape of Ladle's own meta.json.
export function ladleMeta(registry) {
  return { about: { generator: 'massimo', format: 1 }, stories: {} }
}

// Old id to new route, for the ids a repo used before the lane.
export function redirectTable(registry, oldIds) {
  return {}
}

// sha256 of the file with the one type import's specifier replaced by a placeholder.
export function normalHash(text, typeImport) {
  return ''
}

// sha256 of one export's source, to name the export that moved.
export function spanHash(text, span) {
  return ''
}
