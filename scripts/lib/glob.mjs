// File discovery for massimo scripts: a directory walk that skips ignored
// folders early, and a small glob-to-RegExp compiler (`**`, `*`, `?`, `{a,b}`,
// `[...]`).
//
// Hand-rolled because `fs.glob` needs Node 22 and these scripts must run on
// Node 18 in CI without installing anything. Paths are always repo-relative
// and POSIX-separated so output is identical across platforms.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Locale-independent string order, so sorted output is byte-stable.
export function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

const ALWAYS_IGNORED = ['node_modules', '.git']

// Every file under `root`, as sorted repo-relative POSIX paths. Directories
// named in `ignore` are never entered. A nested directory that holds its own
// `.git` (a git worktree or a vendored checkout) is skipped too: it is another
// project, and scanning it would double-count everything.
export function walk(root, { ignore = [] } = {}) {
  const skip = new Set([...ALWAYS_IGNORED, ...ignore])
  const out = []
  const visit = (abs, relDir, isRoot) => {
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    if (!isRoot && entries.some((e) => e.name === '.git')) return
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) visit(join(abs, entry.name), relPath, false)
      } else if (entry.isFile()) {
        out.push(relPath)
      } else if (entry.isSymbolicLink()) {
        try {
          if (statSync(join(abs, entry.name)).isFile()) out.push(relPath)
        } catch {
          // dangling link
        }
      }
    }
  }
  visit(root, '', true)
  return out.sort(compare)
}

// Index of the `}` that closes the `{` at `open`, or -1 when unbalanced.
function closingBrace(glob, open) {
  let depth = 0
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === '\\') i++
    else if (glob[i] === '{') depth++
    else if (glob[i] === '}' && --depth === 0) return i
  }
  return -1
}

const escapeRe = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

function convert(glob) {
  let re = ''
  let braceDepth = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '\\') {
      re += escapeRe(glob[++i] ?? '\\')
    } else if (c === '*') {
      let j = i + 1
      while (glob[j] === '*') j++
      const segmentStart = i === 0 || glob[i - 1] === '/' || glob[i - 1] === '{' || glob[i - 1] === ','
      if (j - i > 1 && segmentStart && glob[j] === '/') {
        re += '(?:[^/]+/)*' // `**/`: zero or more directories
        i = j
      } else if (j - i > 1 && segmentStart && (j === glob.length || glob[j] === '}' || glob[j] === ',')) {
        re += '.*' // trailing `**`
        i = j - 1
      } else {
        re += '[^/]*'
        i = j - 1
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '{') {
      if (closingBrace(glob, i) === -1) {
        re += '\\{'
      } else {
        re += '(?:'
        braceDepth++
      }
    } else if (c === '}') {
      if (braceDepth > 0) {
        re += ')'
        braceDepth--
      } else {
        re += '\\}'
      }
    } else if (c === ',' && braceDepth > 0) {
      re += '|'
    } else if (c === '[') {
      const close = glob.indexOf(']', i + 2)
      if (close === -1) {
        re += '\\['
      } else {
        let body = glob.slice(i + 1, close)
        if (body[0] === '!') body = `^${body.slice(1)}`
        re += `[${body.replace(/\\/g, '\\\\')}]`
        i = close
      }
    } else {
      re += escapeRe(c)
    }
  }
  return re
}

// Compile one glob into an anchored RegExp matching a repo-relative path.
export function globToRegExp(glob) {
  return new RegExp(`^${convert(glob.replace(/^\.\//, ''))}$`)
}

// One predicate for a list of globs; an empty list matches nothing.
export function compileGlobs(globs = []) {
  const res = [].concat(globs).map(globToRegExp)
  return (path) => res.some((re) => re.test(path))
}

// Sorted repo-relative paths matching `include` and not `exclude`. Pass an
// already-walked `files` list to skip the directory walk when expanding
// several glob sets against the same tree.
export function expandGlobs(root, include, exclude = [], ignore = [], files = null) {
  const all = files ?? walk(root, { ignore })
  const inc = compileGlobs(include)
  const exc = compileGlobs(exclude)
  return all.filter((f) => inc(f) && !exc(f))
}
