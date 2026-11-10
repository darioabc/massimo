// The selector an app's dark theme hangs on, read from its own config
// without running anything, for the tokens.darkSelector detect suggests.
//
// colorModeSelector follows the class Nuxt's color-mode module puts on
// <html> (src/script.js: classPrefix, then the mode, then classSuffix) and
// its defaults (src/module.ts: classPrefix '' always, classSuffix '-mode'
// up to 3.5.2 and '' from 4.0.0). tailwindDarkSelector follows the dark
// variant of Tailwind CSS 3.4.17 (src/corePlugins.js, darkVariants):
// darkMode is a mode or [mode, selector], the selector '.dark' unless given,
// and the `class` and `selector` modes key dark: on that selector. Their
// licences follow.
//
// MIT License
//
// Copyright (c) Nuxt Team
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// MIT License
//
// Copyright (c) Tailwind Labs, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// A literal object as jsobject.mjs reads it: not an array, nor a value it
// could not read without running it.
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !('expr' in v) && !('spread' in v)

// The class selector the color-mode module sets on <html> in dark mode, from
// its options (the colorMode key and the options given with the module in
// `modules`, which win) and its major version; null when an option is not a
// literal string, or the version is unknown and no suffix is set.
export function colorModeSelector(keyed, inline, version) {
  if ((keyed !== undefined && !plain(keyed)) || (inline !== undefined && !plain(inline))) return null
  const options = { ...(keyed ?? {}), ...(inline ?? {}) }
  if (['classPrefix', 'classSuffix'].some((k) => options[k] !== undefined && typeof options[k] !== 'string')) return null
  const suffix = options.classSuffix ?? (version === null ? null : version >= 4 ? '' : '-mode')
  if (suffix === null) return null
  const name = `${options.classPrefix ?? ''}dark${suffix}`
  return /^-?[A-Za-z_][\w-]*$/.test(name) ? `.${name}` : null
}

// The selector a Tailwind 3 config's darkMode keys dark: on, or null for the
// media query (the default), a variant or a value that is not a literal.
export function tailwindDarkSelector(darkMode) {
  const [mode, selector = '.dark'] = [].concat(darkMode ?? 'media')
  if (mode !== 'class' && mode !== 'selector') return null
  return typeof selector === 'string' && selector.trim() ? selector.trim() : null
}
