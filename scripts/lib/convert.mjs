// Converting a Ladle repo to the csf lane: working records per story file,
// the frozen design targets, and the removal patch for the tool's type import.
// Returns empty results for now.

// One record per story file, keyed by repo path.
export function conversionRecords(registry, { root, frozen } = {}) {
  return []
}

// Files that look like design targets to freeze, under `policy`.
export function frozenCandidates(registry, policy) {
  return []
}

// Frozen files that changed since they were pinned.
export function frozenProblems(root, config) {
  return []
}

// The edits that take the tool's type import out of every story file that is not frozen.
export function removalEdits(registry, { tool, typesFile, frozen } = {}) {
  return []
}

// Recompute a frozen file's sha256 and write it into the config.
export function refreeze(root, config, file) {
  return null
}
