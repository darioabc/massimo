// Ladle's story ids, ported so a lane can keep every id a Ladle repo already
// links to. The functions below are copied from @ladle/react 5.1.1,
// lib/cli/vite-plugin/naming-utils.js, with their logic kept line for line.
// The quotes and semicolons follow massimo's style, and the JSDoc type
// comments, getEncodedStoryName and its delimiter, which no id uses, are
// left out. The id of a story is
// `${ladleTitleId(title)}--${ladleStoryId(storyName or export)}`, as Ladle's
// parse/get-named-exports.js builds it, and ladleIdMeta gives the name and
// levels Ladle's meta.json shows for an id.
//
// MIT License
//
// Copyright (c) Vojtech Miksu
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
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

export const storyDelimiter = '-'

// BUT preserving delimiters --
const wordSeparators = /[\s\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,.\/:;<=>?@\[\]^_`{|}~]+/

export const capitalize = (str) => {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

export const storyIdToMeta = (str) => {
  const parts = str
    .split(`${storyDelimiter}${storyDelimiter}`)
    .map((level) => capitalize(level.replace(/-/g, ' ')))
  return {
    name: parts.pop(),
    levels: parts,
  }
}

export const kebabCase = (str) => {
  return str
    .replace(
      /[A-Z\u00C0-\u00D6\u00D9-\u00DD]+(?![a-z])|[A-Z\u00C0-\u00D6\u00D9-\u00DD]/g,
      ($, ofs) => (ofs ? '-' : '') + $.toLowerCase(),
    )
    .replace(/\s-/g, '-')
    .trim()
    .split(wordSeparators)
    .join('-')
}

export const titleToFileId = (title) =>
  title
    .toLocaleLowerCase()
    .replace(/\s*\/\s*/g, `${storyDelimiter}${storyDelimiter}`)
    .replace(/\s+/g, storyDelimiter)

export const getFileId = (filename) => {
  const pathParts = filename.split('/')
  return pathParts[pathParts.length - 1].split('.')[0]
}

// ── massimo's names for the id path ─────────────────────────────────────────

// The title side of an id: `Patterns / Account / Log-In panel` gives
// `patterns--account--log-in-panel`.
export const ladleTitleId = (title) => kebabCase(titleToFileId(title))

// The story side: the storyName when there is one, else the export name.
// `Log-In form` gives `log--in-form`, since kebabCase reads `-I` as a break.
export const ladleStoryId = (name) => kebabCase(name)

// The title side of a file that declares no title: its name up to the first dot.
export const ladleFileId = (file) => kebabCase(getFileId(file))

// The name and levels Ladle's meta.json shows for an id, split on every `--`.
export const ladleIdMeta = (id) => storyIdToMeta(id)
