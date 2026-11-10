// Storybook's story ids, ported so massimo can name a story's id, and so its
// URL, without running Storybook. The functions in the first part are copied
// from Storybook 10.6.7: sanitize and toId from code/core/src/csf/csf-utils.ts,
// storyNameFromExport from code/core/src/csf/export-story.ts, toStartCaseStr
// from code/core/src/csf/toStartCaseStr.ts, the auto title from
// code/core/src/shared/story-index/autoTitle.ts (the same rule as in
// Storybook 8.6), and a stories entry read as in
// code/core/src/common/utils/normalize-stories.ts and paths.ts. Their logic is
// kept; the code follows massimo's style. Two parts are massimo's own, in
// place of picomatch: scanGlob, which splits an entry into its folder and its
// glob, and the matcher, massimo's glob with Storybook's `@(a|b)` read as
// `{a,b}`, so an entry with any other extglob or group matches nothing. The
// id of a story is toId(meta.id or the title, storyNameFromExport(its export
// name)), as Storybook's code/core/src/csf-tools/CsfFile.ts builds it, for
// each export but `__esModule`, as isExportStory in export-story.ts skips
// it, and the title is the meta's own, or the auto title from the file's
// path and the first stories entry that matches it.
//
// The MIT License (MIT)
//
// Copyright (c) 2024 Storybook
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'
import { compare, globToRegExp } from './glob.mjs'
import { parseArrayAt } from './jsobject.mjs'
import { stripComments } from './source.mjs'
import { listFaults, readCsf } from './stories-read.mjs'

// Remove punctuation and illegal characters from a story ID, so it is safe
// to use in URLs and CSS selectors. The class holds a space, U+2019, U+2013,
// U+2014, U+2015, U+2032, U+00BF and ASCII punctuation.
export const sanitize = (string) => {
  return string
    .toLowerCase()
    .replace(/[ \u2019\u2013\u2014\u2015\u2032\u00bf'`~!@#$%^&*()_|+\-=?;:'",.<>\{\}\[\]\\\/]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
}

const sanitizeSafe = (string, part) => {
  const sanitized = sanitize(string)
  if (sanitized === '') {
    throw new Error(`Invalid ${part} '${string}', must include alphanumeric characters`)
  }
  return sanitized
}

// Generate a storybook ID from a component/kind and story name.
export const toId = (kind, name) => `${sanitizeSafe(kind, 'kind')}${name ? `--${sanitizeSafe(name, 'name')}` : ''}`

export function toStartCaseStr(str) {
  return str
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\./g, ' ')
    .replace(/([^\n])([A-Z])([a-z])/g, (str2, $1, $2, $3) => `${$1} ${$2}${$3}`)
    .replace(/([a-z])([A-Z])/g, (str2, $1, $2) => `${$1} ${$2}`)
    .replace(/([a-z])([0-9])/gi, (str2, $1, $2) => `${$1} ${$2}`)
    .replace(/([0-9])([a-z])/gi, (str2, $1, $2) => `${$1} ${$2}`)
    .replace(/(\s|^)(\w)/g, (str2, $1, $2) => `${$1}${$2.toUpperCase()}`)
    .replace(/ +/g, ' ')
    .trim()
}

// Transform a CSF named export into a readable story name.
export const storyNameFromExport = (key) => toStartCaseStr(key)

// The auto title's parts: deal with files like "atoms/button/{button,index}.stories.js".
// (Storybook names this one sanitize too.)
const titleParts = (parts) => {
  if (parts.length === 0) {
    return parts
  }

  const last = parts[parts.length - 1]
  const lastStripped = last?.replace(/(?:[.](?:story|stories))?([.][^.]+)$/i, '')

  if (parts.length === 1) {
    return [lastStripped]
  }

  const nextToLast = parts[parts.length - 2]
  if (lastStripped && nextToLast && lastStripped.toLowerCase() === nextToLast.toLowerCase()) {
    return [...parts.slice(0, -2), lastStripped]
  }

  return lastStripped && (/^(story|stories)([.][^.]+)$/i.test(last) || /^index$/i.test(lastStripped)) ? parts.slice(0, -1) : [...parts.slice(0, -1), lastStripped]
}

// Combines path parts together, without duplicating separators (slashes).
function pathJoin(paths) {
  return paths
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/')
}

// Forward slashes, as the slash package gives a path.
const slash = (p) => String(p).replace(/\\/g, '/')

export const userOrAutoTitleFromSpecifier = (fileName, entry, userTitle) => {
  const { directory, importPathMatcher, titlePrefix = '' } = entry || {}
  const normalizedFileName = slash(String(fileName))

  if (importPathMatcher?.exec(normalizedFileName)) {
    if (!userTitle) {
      const suffix = normalizedFileName.replace(directory, '')
      let parts = pathJoin([titlePrefix, suffix]).split('/')
      parts = titleParts(parts)
      return parts.join('/')
    }

    if (!titlePrefix) {
      return userTitle
    }

    return pathJoin([titlePrefix, userTitle])
  }

  return undefined
}

export const userOrAutoTitle = (fileName, storiesEntries, userTitle) => {
  for (let i = 0; i < storiesEntries.length; i += 1) {
    const title = userOrAutoTitleFromSpecifier(fileName, storiesEntries[i], userTitle)

    if (title) {
      return title
    }
  }

  return userTitle || undefined
}

export const DEFAULT_FILES_PATTERN = '**/*.@(mdx|stories.@(js|jsx|mjs|ts|tsx))'

const relativePattern = /^\.{1,2}([/\\]|$)/

export function normalizeStoryPath(filename) {
  if (relativePattern.test(filename)) {
    return filename
  }

  return `.${sep}${filename}`
}

const isDirectory = (configDir, entry) => {
  try {
    return lstatSync(resolve(configDir, entry)).isDirectory()
  } catch {
    return false
  }
}

export const getDirectoryFromWorkingDir = ({ configDir, workingDir, directory }) => {
  const directoryFromConfig = resolve(configDir, directory)
  const directoryFromWorking = relative(workingDir, directoryFromConfig)

  // relative('/foo', '/foo/src') => 'src'
  // but we want `./src` to match importPaths
  return normalizeStoryPath(directoryFromWorking)
}

export const normalizeStoriesEntry = (entry, { configDir, workingDir, defaultFilesPattern = DEFAULT_FILES_PATTERN }) => {
  let specifierWithoutMatcher

  if (typeof entry === 'string') {
    const globResult = scanGlob(entry)
    if (globResult.isGlob) {
      const directory = globResult.prefix + globResult.base
      const files = globResult.glob

      specifierWithoutMatcher = { titlePrefix: '', directory, files }
    } else if (isDirectory(configDir, entry)) {
      specifierWithoutMatcher = { titlePrefix: '', directory: entry, files: defaultFilesPattern }
    } else {
      specifierWithoutMatcher = { titlePrefix: '', directory: posix.dirname(entry), files: posix.basename(entry) }
    }
  } else {
    specifierWithoutMatcher = { titlePrefix: '', files: defaultFilesPattern, ...entry }
  }

  // Import paths use `/` as a separator.
  const files = slash(specifierWithoutMatcher.files)

  // At this stage `directory` is relative to the config dir; from here on it
  // is relative to the working dir.
  const { directory: directoryRelativeToConfig } = specifierWithoutMatcher

  const directory = slash(getDirectoryFromWorkingDir({ configDir, workingDir, directory: directoryRelativeToConfig })).replace(/\/$/, '')

  // Now make the importFn matcher.
  const importPathMatcher = storyGlobToRegExp(`${directory}/${files}`)

  return { ...specifierWithoutMatcher, files, directory, importPathMatcher }
}

// ── massimo's own, in place of picomatch ────────────────────────────────────

// An entry split as picomatch's scan splits it: a leading `./` as `prefix`,
// the folders before the first segment with a glob character as `base`, and
// the rest as `glob`. An entry with no glob character is no glob.
export function scanGlob(entry) {
  const prefix = entry.startsWith('./') ? './' : ''
  const parts = entry.slice(prefix.length).split('/')
  const first = parts.findIndex((p) => /[*?[{(]/.test(p) || p.startsWith('!'))
  if (first === -1) return { prefix, base: entry.slice(prefix.length), glob: '', isGlob: false }
  return { prefix, base: parts.slice(0, first).join('/'), glob: parts.slice(first).join('/'), isGlob: true }
}

// A Storybook glob as a massimo glob: each `@(a|b)` becomes `{a,b}`, at any
// depth. Null for any other group (`!(`, `+(`, `*(`, `?(`, a bare `(`), which
// massimo's glob cannot say.
export function storyGlob(glob) {
  let out = ''
  let open = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '\\') {
      out += c + (glob[i + 1] ?? '')
      i++
    } else if (c === '(') {
      if (glob[i - 1] !== '@') return null
      out = `${out.slice(0, -1)}{`
      open++
    } else if (c === ')' && open > 0) {
      out += '}'
      open--
    } else if (c === '|' && open > 0) out += ','
    else out += c
  }
  return open === 0 ? out : null
}

// The matcher of an import path (`./src/x.stories.ts`) for a glob that
// starts at the working dir (`./src/**/*.stories.@(ts|tsx)`), or null.
function storyGlobToRegExp(glob) {
  const plain = storyGlob(glob)
  if (plain === null) return null
  const re = globToRegExp(plain)
  return plain.startsWith('./') ? new RegExp(`^\\./${re.source.slice(1)}`) : re
}

// ── A kept Storybook, read without running it ───────────────────────────────

const MAIN_FILES = ['main.ts', 'main.js', 'main.mjs', 'main.cjs', 'main.mts', 'main.cts']
const DEV = /\bstorybook\s+dev\b|\bstart-storybook\b/
const STORYBOOK_PORT = 6006
const RUN = { npm: 'npm run', pnpm: 'pnpm run', yarn: 'yarn', bun: 'bun run' }
// A script file: the stories entries decide which of them are story files.
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/

const portIn = (cmd) => Number((/--port[ =](\d+)/.exec(cmd) ?? /(?:^|\s)-p[ =]?(\d+)/.exec(cmd) ?? /\bPORT=(\d+)/.exec(cmd))?.[1]) || null

// The package script that serves Storybook (`storybook dev`, or the older
// `start-storybook`), as { name, command, port, configDir }: the script named
// `storybook` first, then by name. The port is the one it passes, else
// Storybook's 6006, and the config folder the one its -c or --config-dir
// names, else .storybook. Null when no script serves it.
export function storybookDev(scripts = {}) {
  const found = Object.entries(scripts ?? {})
    .filter(([, cmd]) => DEV.test(String(cmd)))
    .sort((a, b) => (a[0] !== 'storybook') - (b[0] !== 'storybook') || compare(a[0], b[0]))[0]
  if (!found) return null
  const [name, command] = [found[0], String(found[1])]
  const dir = /(?:^|\s)(?:-c|--config-dir)[ =](['"]?)([^\s'"]+)\1/.exec(command)?.[2]
  return { name, command, port: portIn(command) ?? STORYBOOK_PORT, configDir: dir ? posix.normalize(dir).replace(/\/$/, '') : '.storybook' }
}

// Storybook's main config in `configDir` under `root`, as { file, configDir,
// entries, notes }: `entries` are the literal items of its `stories` list
// (globs, and { directory, files, titlePrefix } objects), and `notes` say
// what was not read, never guessed. Null when there is no main config.
export function storybookMain(root, configDir = '.storybook') {
  const name = MAIN_FILES.find((f) => existsSync(join(root, configDir, f)))
  if (!name) return null
  const file = posix.join(configDir, name)
  const notes = []
  let text = ''
  try {
    text = stripComments(readFileSync(join(root, configDir, name), 'utf8'), name)
  } catch {
    return { file, configDir, entries: [], notes: [`massimo could not read ${file}`] }
  }
  const key = /(?<![\w$.])stories\s*:\s*/.exec(text)
  const at = key ? key.index + key[0].length : -1
  const list = at !== -1 && text[at] === '[' ? parseArrayAt(text, at) : null
  if (!Array.isArray(list)) {
    notes.push(`${file} sets its stories list with code, or names none, so massimo reads no story globs from it: set stories.include by hand to the globs of its story files`)
    return { file, configDir, entries: [], notes }
  }
  const entries = []
  const literal = (v) => v === undefined || typeof v === 'string'
  for (const item of list) {
    if (typeof item === 'string') entries.push(item)
    else if (item && typeof item === 'object' && !Array.isArray(item) && !('expr' in item) && !('spread' in item) && !item.__spreads && typeof item.directory === 'string' && literal(item.files) && literal(item.titlePrefix)) {
      entries.push({ directory: item.directory, ...(item.files !== undefined ? { files: item.files } : {}), ...(item.titlePrefix !== undefined ? { titlePrefix: item.titlePrefix } : {}) })
    } else notes.push(`${file} has a stories entry set with code (${item?.expr ?? item?.spread ?? 'an object massimo cannot read'}), so massimo reads no glob from it: add its glob to stories.include by hand`)
  }
  return { file, configDir, entries, notes }
}

// The main config's entries, normalized as Storybook does with the folder
// that holds the package.json as its working dir.
export function storybookEntries(root, main) {
  return main.entries.map((entry) => ({ entry, ...normalizeStoriesEntry(entry, { configDir: join(root, main.configDir), workingDir: root }) }))
}

// The stories keys of a repo that keeps Storybook, as { main, keys, notes }:
// `include` from the main config's stories entries (each a glob from the
// folder that holds massimo.config.json, with `@(a|b)` as `{a,b}`), and, when
// a package script serves Storybook, `devCommand`, `port`, `url` and
// `storyUrl`, Storybook's iframe URL with `{id}` for the story's id. An entry
// that names only MDX files lists docs pages, which have no story to open, so
// it is left out. Null when the repo has no Storybook main config.
export function storybookKeys(root, { scripts = {}, packageManager = 'npm' } = {}) {
  const dev = storybookDev(scripts)
  const main = storybookMain(root, dev?.configDir ?? '.storybook')
  if (!main) return null
  const notes = [...main.notes]
  const include = []
  for (const { entry, directory, files } of storybookEntries(root, main)) {
    const shown = typeof entry === 'string' ? entry : JSON.stringify(entry)
    const glob = storyGlob(files)
    if (directory === '..' || directory.startsWith('../')) notes.push(`the stories entry ${shown} reaches outside this folder, so it is not in stories.include`)
    else if (glob === null) notes.push(`the stories entry ${shown} uses a pattern massimo's globs cannot say: add its glob to stories.include by hand`)
    else if (/\.mdx$/.test(glob) && !glob.includes('{')) notes.push(`the stories entry ${shown} lists MDX docs pages, which have no story ids, so it is not in stories.include`)
    else include.push(`${directory === '.' ? '' : `${directory.replace(/^\.\//, '')}/`}${glob}`)
  }
  const keys = include.length > 0 ? { include } : {}
  if (dev) {
    const url = `http://localhost:${dev.port}`
    Object.assign(keys, { devCommand: `${RUN[packageManager] ?? RUN.npm} ${dev.name}`, port: dev.port, url, storyUrl: `${url}/iframe.html?id={id}&viewMode=story` })
  } else notes.push('no package script runs storybook dev, so stories.devCommand, port, url and storyUrl are not proposed')
  return { main: main.file, keys, notes }
}

// Each CSF file Storybook serves among `files` (paths from `root`), with its
// title and each story's id: { files: [{ file, title, stories: [{ export,
// name, id }], problems }], main }. A script file is a story file when a
// stories entry matches it, whatever its name. A file whose title, meta id
// or list of stories massimo cannot read has its problems, and no id is
// guessed for it.
export function storybookIndex(root, files, { configDir = '.storybook', read = (f) => readFileSync(join(root, f), 'utf8') } = {}) {
  const main = storybookMain(root, configDir)
  if (!main) return null
  const entries = storybookEntries(root, main)
  const out = []
  for (const file of [...files].sort(compare)) {
    if (!SCRIPT_FILE.test(file)) continue
    const importPath = `./${file}`
    if (!entries.some((e) => e.importPathMatcher?.exec(importPath))) continue
    const csf = readCsf(read(file), file)
    const problems = listFaults(csf).map((u) => (u.story ? `${u.story}: ${u.detail}` : u.detail))
    if (csf.metaSpan === null && csf.stories.length > 0) problems.unshift('it has no default export, so massimo reads no meta from it')
    // Storybook takes the meta's id only as a string written out.
    if (csf.unreadable.some((u) => u.story === null && u.field === 'id')) problems.push('id is not statically readable')
    else if (csf.meta.id !== undefined && typeof csf.meta.id !== 'string') problems.push('id is not a string, which Storybook refuses')
    const title = problems.length > 0 ? null : (userOrAutoTitle(importPath, entries, csf.title ?? undefined) ?? null)
    // The kind is the meta's id, or the title when the id is left out or empty.
    const kind = problems.length > 0 ? null : csf.meta.id || title
    const stories = []
    if (kind) {
      try {
        for (const s of csf.stories) {
          // Babel's CommonJS interop adds __esModule, which is no story.
          if (s.export === '__esModule') continue
          const name = storyNameFromExport(s.export)
          stories.push({ export: s.export, name: s.storyName ?? name, id: toId(kind, name) })
        }
      } catch (e) {
        problems.push(e.message)
        stories.length = 0
      }
    }
    out.push({ file, title, stories, problems })
  }
  return { main: main.file, files: out }
}
