// Proving the lane against the tool it replaces: which story ids a repo
// mentions, whether each resolves, and every edit the repo must make before
// the tool can go. Returns empty results for now.

// Story ids and id prefixes mentioned in `text`.
export function idMentions(text, registry) {
  return []
}

// Which mentions in `consumerFiles` resolve in the registry, and which `oracleIds` do not.
export function mentionCoverage(consumerFiles, registry, oracleIds) {
  return { missing: [], dead: [] }
}

// Every open edit, as `{ file, line, class, uses, replacement }`.
export function toolEdits({ consumers, packages, registry, tool, historical, read } = {}) {
  return []
}
