// How the lane's CSS and the app's CSS stay apart: which modules only stories
// use, which `@source not` lines the app's entry holds, and the layout faults
// that would leak story-only classes into the app. Returns empty results for now.

// Source files that are not stories or tests and are imported only by stories,
// tests or other such files (a fixpoint over the import graph).
export function storyOnlyModules({ root, config, files, resolver } = {}) {
  return []
}

// The `@source not` lines of a stylesheet, with globs resolved from the file that declares them.
export function sourceNotLines(cssText, cssFile) {
  return []
}

// What is wrong with the CSS layout, as `{ rule, file, detail }`.
export function cssLayoutProblems({ root, config, files, resolver } = {}) {
  return []
}
