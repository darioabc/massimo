// The design system as a folder a reader can open without massimo: a brand
// book (README.md and further sections), tokens as lists per family, a page
// and a preview per component, fonts and the files the previews load. The
// layout is the one a Claude design system artifact keeps under `project/`,
// and every file is plain Markdown, JSON, HTML or CSS, so another agent, a
// person or a static host reads the same folder. artifact.mjs is the CLI over
// this; nothing here touches the network or runs the repo's code.
//
// What the list-shaped tokens cannot hold (motion, borders, gradients, a
// CSS-only value) is never dropped silently: it is returned as `left`, and
// written as sections of the brand book.

import { compare } from './glob.mjs'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1)

// ── Tokens as lists ─────────────────────────────────────────────────────────

// A name the token views accept: it becomes `--name` as it is.
export const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const COLOR_FN = /^(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(\s*[^()]+\)$/i
const LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%)?$/
const PLAIN = /^[A-Za-z0-9 #%(),./+_-]{1,200}$/
const STACK_UNSAFE = /[;{}<>\\()]/

// A colour the token views can show: a hex, or a colour function with plain
// arguments. A var(), a color-mix() or a keyword is not one.
export const colorValueOk = (text) => typeof text === 'string' && (HEX.test(text.trim()) || COLOR_FN.test(text.trim()))

const balanced = (s) => {
  let depth = 0
  for (const c of s) {
    if (c === '(') depth++
    else if (c === ')' && --depth < 0) return false
  }
  return depth === 0
}
const plainValueOk = (text) => typeof text === 'string' && PLAIN.test(text) && balanced(text) && !/\b(?:var|url)\(/i.test(text)

const SPACING_NAME = /(?:^|[-_.])(?:space|spacing|gap|pad|padding|inset|gutter)(?:[-_.]|$)/i
const RADIUS_NAME = /(?:^|[-_.])(?:radius|radii|rounded|corner)(?:[-_.]|$)/i
const MOTION_TYPES = new Set(['duration', 'cubicBezier', 'transition'])
const SECTION_OF = { duration: 'motion', cubicBezier: 'motion', transition: 'motion', border: 'borders', strokeStyle: 'borders', gradient: 'gradients' }

// Caps of the token views: past them a family shows nothing at all, so the
// rest is left for a section instead.
const CAPS = { colors: 600, family: 60, styles: 80, extraFamilies: 8, usage: 1000 }

// The family a token that is neither a colour nor type goes in, or null when
// the views have no place for its type.
function familyOf(entry) {
  if (entry.type === 'shadow') return 'shadow'
  if (entry.type === 'dimension') {
    if (RADIUS_NAME.test(entry.name)) return 'radius'
    if (SPACING_NAME.test(entry.name)) return 'spacing'
    return 'size'
  }
  if (entry.type === 'number') return 'number'
  if (entry.type === 'fontWeight') return 'weight'
  return null
}

const usageOf = (entry) => (entry.description ?? '').slice(0, CAPS.usage)
const allSame = (values, modes) => modes.every((m) => values[m] === values[modes[0]])

// The token set as the lists the views read. `set` is what tokens.mjs gives:
// `modes` (the default first) and an entry per token with its CSS name, type,
// description, a value per mode as CSS text, and per mode the CSS name of the
// token it points at. Returns the document and `left`: every token with no
// place in it, as { name, type, values, description, reason, section }.
export function listTokens(set, { name = 'Design system' } = {}) {
  const modes = set.modes
  const first = modes[0]
  const left = []
  const leave = (entry, reason) => left.push({ name: entry.cssName, type: entry.type, values: entry.values, description: entry.description ?? '', reason, section: SECTION_OF[entry.type] ?? 'more-tokens' })

  const usable = []
  for (const entry of set.entries) {
    const cssName = entry.cssVar.replace(/^--/, '')
    const e = { ...entry, cssName }
    if (!TOKEN_NAME.test(cssName)) leave(e, 'its CSS name is longer than 64 characters or has a character the views do not take')
    else if (entry.cssOnly) leave(e, 'a CSS-only value')
    else usable.push(e)
  }

  // Colours: a value per theme, kept as a reference where it points at
  // another colour that is itself listed.
  const colorEntries = usable.filter((e) => e.type === 'color')
  const listed = new Set()
  const colors = []
  for (const e of colorEntries) {
    if (!colorValueOk(e.values[first])) leave(e, `${JSON.stringify(e.values[first])} is not a plain colour (a hex or a colour function with plain arguments)`)
    else if (colors.length >= CAPS.colors) leave(e, `past the ${CAPS.colors} colours the views show`)
    else {
      colors.push(e)
      listed.add(e.cssVar)
    }
  }
  const colorTokens = colors.map((e) => {
    const per = {}
    for (const mode of modes) {
      const target = e.aliases?.[mode]
      if (target && listed.has(target) && target !== e.cssVar) per[mode] = `{${target.replace(/^--/, '')}}`
      else if (colorValueOk(e.values[mode])) per[mode] = e.values[mode].trim()
    }
    const value = allSame(per, modes) ? per[first] : per
    return { name: e.cssName, value, usage: usageOf(e) }
  })

  // Type: font families by key, then the composites as styles.
  const families = {}
  const familyKey = new Map()
  for (const e of usable.filter((x) => x.type === 'fontFamily')) {
    const stack = e.values[first] ?? ''
    const key = e.cssName.replace(/^font-?/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || e.cssName.toLowerCase()
    if (stack.length > 200 || STACK_UNSAFE.test(stack)) leave(e, 'a font stack over 200 characters, or one that holds a function')
    else if (key in families) leave(e, `a second font family that would take the key "${key}"`)
    else {
      families[key] = stack
      familyKey.set(stack, key)
    }
  }
  const groups = new Map()
  let styleCount = 0
  for (const e of usable.filter((x) => x.type === 'typography')) {
    const parts = e.parts ?? {}
    if (!parts.fontSize || !LENGTH.test(parts.fontSize)) {
      leave(e, 'a type style with no font size the views can read')
      continue
    }
    if (styleCount >= CAPS.styles) {
      leave(e, `past the ${CAPS.styles} type styles the views show`)
      continue
    }
    let key = parts.fontFamily ? familyKey.get(parts.fontFamily) : undefined
    if (!key && parts.fontFamily && parts.fontFamily.length <= 200 && !STACK_UNSAFE.test(parts.fontFamily)) {
      key = `family-${Object.keys(families).length + 1}`
      families[key] = parts.fontFamily
      familyKey.set(parts.fontFamily, key)
    }
    const style = { name: e.cssName, fontSize: parts.fontSize }
    if (parts.lineHeight) style.lineHeight = parts.lineHeight
    if (parts.fontWeight && /^\d{1,4}$/.test(parts.fontWeight)) style.fontWeight = Number(parts.fontWeight)
    if (parts.letterSpacing && LENGTH.test(parts.letterSpacing)) style.letterSpacing = parts.letterSpacing
    if (usageOf(e)) style.usage = usageOf(e)
    const groupName = titleCase(e.name.split('.')[0])
    const groupKey = `${groupName}\u0000${key ?? ''}`
    if (!groups.has(groupKey)) groups.set(groupKey, { name: groupName, ...(key ? { family: key } : {}), styles: [] })
    groups.get(groupKey).styles.push(style)
    styleCount++
  }

  // Every other family: one flat list each.
  const lists = new Map()
  for (const e of usable.filter((x) => !['color', 'fontFamily', 'typography'].includes(x.type))) {
    const family = familyOf(e)
    if (!family) {
      leave(e, MOTION_TYPES.has(e.type) ? 'the token views have no motion family' : `the token views have no place for a ${e.type ?? 'value of no type'}`)
      continue
    }
    const text = e.values[first]
    const ok = family === 'shadow' ? typeof text === 'string' && text.length <= 400 && !/\b(?:var|url)\(/i.test(text) : family === 'spacing' || family === 'radius' ? LENGTH.test(text ?? '') || plainValueOk(text) : plainValueOk(text)
    if (!ok) {
      leave(e, `${JSON.stringify(text)} is not a single plain value`)
      continue
    }
    if (!lists.has(family)) lists.set(family, [])
    if (lists.get(family).length >= CAPS.family) {
      leave(e, `past the ${CAPS.family} tokens a family shows`)
      continue
    }
    // Only a shadow keeps a value per theme; a length is the same in each.
    const value = family === 'shadow' && !allSame(e.values, modes) ? Object.fromEntries(modes.filter((m) => typeof e.values[m] === 'string').map((m) => [m, e.values[m]])) : text
    lists.get(family).push({ name: e.cssName, value, usage: usageOf(e) })
  }
  const core = ['spacing', 'radius', 'shadow']
  const extra = [...lists.keys()].filter((k) => !core.includes(k)).sort(compare)
  for (const k of extra.slice(CAPS.extraFamilies)) {
    for (const t of lists.get(k)) left.push({ name: t.name, type: k, values: { [first]: t.value }, description: t.usage, reason: `past the ${CAPS.extraFamilies} further families the views show`, section: 'more-tokens' })
    lists.delete(k)
  }

  const doc = { name, version: 1 }
  if (colorTokens.length > 0) doc.color = { themes: modes.map((m) => ({ id: m.toLowerCase(), name: titleCase(m) })), tokens: colorTokens.map((t) => ({ ...t, value: isObject(t.value) ? Object.fromEntries(Object.entries(t.value).map(([m, v]) => [m.toLowerCase(), v])) : t.value })) }
  if (Object.keys(families).length > 0 || groups.size > 0) doc.type = { fonts: [], families, groups: [...groups.values()] }
  for (const k of [...core, ...extra.slice(0, CAPS.extraFamilies)]) if (lists.has(k)) doc[k] = { tokens: lists.get(k) }
  return { doc, left }
}

// ── Sections for what the lists cannot hold ────────────────────────────────

const SECTION_TITLES = { motion: 'Motion', borders: 'Borders', gradients: 'Gradients', 'more-tokens': 'More tokens' }
const SECTION_LEADS = {
  motion: 'Durations, easings and transitions. The token views have no motion family, so they are listed here.',
  borders: 'Border and stroke tokens. The token views have no place for a composite border, so they are listed here.',
  gradients: 'Gradient tokens, listed here because the token views hold single colours only.',
  'more-tokens': 'Tokens the code defines that the token views cannot show, each with the reason.',
}
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

// The line a generated section opens with, so a rebuild knows which files
// under sections/ are its own and which the team wrote.
export const SECTION_MARK = '<!-- Generated by massimo from the token set. Do not edit by hand: change the tokens. -->'
// The line a generated component page ends with.
export const PAGE_MARK = '<!-- Generated by massimo from graph.json. Do not edit by hand: change the component or its ds: lines. -->'

// The left-out tokens as brand book sections: { '<file>.md': text }.
export function sectionsFor(left, modes) {
  const out = {}
  for (const section of Object.keys(SECTION_TITLES)) {
    const rows = left.filter((t) => t.section === section).sort((a, b) => compare(a.name, b.name))
    if (rows.length === 0) continue
    const many = modes.length > 1 && rows.some((t) => modes.some((m) => t.values?.[m] !== undefined && t.values[m] !== t.values[modes[0]]))
    const shown = many ? modes : [modes[0]]
    const lines = [SECTION_MARK, `# ${SECTION_TITLES[section]}`, '', SECTION_LEADS[section], '']
    lines.push(`| Token | ${many ? shown.map(titleCase).join(' | ') : 'Value'} | Use |${section === 'more-tokens' ? ' Why it is here |' : ''}`)
    lines.push(`|---|${shown.map(() => '---|').join('')}---|${section === 'more-tokens' ? '---|' : ''}`)
    for (const t of rows) {
      const values = shown.map((m) => `\`${cell(t.values?.[m] ?? t.values?.[modes[0]] ?? '')}\``).join(' | ')
      lines.push(`| \`--${cell(t.name)}\` | ${values} | ${cell(t.description)} |${section === 'more-tokens' ? ` ${cell(t.reason)} |` : ''}`)
    }
    out[`${section}.md`] = `${lines.join('\n')}\n`
  }
  return out
}

// ── A page per component ───────────────────────────────────────────────────

// A component's folder name: an identifier, as the component views need.
export const componentId = (name) => name.replace(/[^A-Za-z0-9_$]+/g, '_').replace(/^(\d)/, '_$1')

const RULE_LABELS = [['parents', 'Where it goes'], ['children', 'What goes inside'], ['never', 'Never']]

// A graph node as the component's guidelines. The first sentence is its summary.
export function componentReadme(node) {
  const rules = node.rules ?? {}
  const useWhen = typeof rules['use-when'] === 'string' ? rules['use-when'].trim() : ''
  // The rule as the repo wrote it: its wording is the repo's, so it follows a label, not a sentence stem.
  const summary = useWhen ? `Use when: ${useWhen.replace(/\.$/, '')}.` : `${node.name}${node.group ? `, in ${node.group}` : ''}.`
  const lines = [`# ${node.name}`, '', summary, '']
  if (node.group) lines.push(`- Group: ${node.group}`)
  lines.push(`- Source: \`${node.file}\``)
  if (node.stories?.length) lines.push(`- ${node.stories.length === 1 ? 'Story' : 'Stories'}: ${node.stories.map((s) => `\`${s}\``).join(', ')}`)
  if (node.exports?.length) lines.push(`- Exports: ${node.exports.map((e) => `\`${e}\``).join(', ')}`)
  lines.push('')
  const shown = RULE_LABELS.filter(([key]) => typeof rules[key] === 'string' && rules[key].trim())
  const others = Object.keys(rules).filter((k) => k !== 'use-when' && !RULE_LABELS.some(([key]) => key === k) && typeof rules[k] === 'string' && rules[k].trim()).sort(compare)
  if (shown.length + others.length > 0) {
    lines.push('## Rules', '')
    for (const [key, label] of shown) lines.push(`- ${label}: ${rules[key].trim()}`)
    for (const key of others) lines.push(`- ${key}: ${rules[key].trim()}`)
    lines.push('')
  }
  const props = (node.props ?? []).filter((p) => p?.name)
  if (props.length > 0) {
    lines.push('## What you provide', '', '| Prop | Values |', '|---|---|')
    for (const p of props) lines.push(`| \`${cell(p.name)}\` | ${p.values?.length ? p.values.map((v) => `\`${cell(v)}\``).join(', ') : ''} |`)
    lines.push('')
  }
  if (node.states?.length) lines.push('## States', '', node.states.map((s) => `\`${s}\``).join(', '), '')
  const style = node.style ?? {}
  const classes = Object.entries(style.classes ?? {}).filter(([, list]) => list.length > 0)
  const built = []
  if (node.composes?.length) built.push(`- Composes: ${node.composes.map((c) => `\`${c}\``).join(', ')}`)
  for (const [library, list] of classes) built.push(`- ${library} classes: ${list.map((c) => `\`${c}\``).join(', ')}`)
  if (style.tokens?.length) built.push(`- Tokens: ${style.tokens.map((t) => `\`${t}\``).join(', ')}`)
  if (style.cssVars?.length) built.push(`- CSS variables: ${style.cssVars.map((v) => `\`${v}\``).join(', ')}`)
  if (built.length > 0) lines.push('## Built from', '', ...built, '')
  const users = Object.entries(node.composedBy ?? {}).flatMap(([, list]) => list)
  if (users.length > 0) {
    const names = users.slice(0, 10).map((u) => `\`${u}\``).join(', ')
    lines.push('## Used by', '', `${users.length} ${users.length === 1 ? 'file imports' : 'files import'} it: ${names}${users.length > 10 ? ', and more' : ''}.`, '')
  }
  return `${lines.join('\n').trimEnd()}\n\n${PAGE_MARK}\n`
}

// ── A preview from a built story page ──────────────────────────────────────

const attrsOf = (tag) => {
  const out = {}
  for (const m of tag.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  return out
}
const innerOf = (html, tag) => {
  const open = new RegExp(`<${tag}\\b([^>]*)>`, 'i').exec(html)
  if (!open) return null
  const close = html.toLowerCase().lastIndexOf(`</${tag}>`)
  return { attrs: attrsOf(open[1]), inner: html.slice(open.index + open[0].length, close === -1 ? html.length : close) }
}

// A root-absolute path the page loads from its own site: `/x/y.css`, never
// `//host/x` or a full URL.
const isLocal = (url) => /^\/(?!\/)/.test(url)
const SITE = 'site'

// The path from `fromDir` (a folder under the project folder) to a file of the
// built site copied under `site/`.
const toSite = (fromDir, sitePath) => `${fromDir.split('/').filter(Boolean).map(() => '..').join('/') || '.'}/${SITE}${sitePath}`

const stripQuery = (url) => url.replace(/[?#].*$/, '')

// url(...) references to the built site, rewritten for a file in `fromDir`.
// `seen` collects each site path so the caller copies the files.
export function rewriteCssUrls(css, fromDir, seen) {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (whole, quote, url) => {
    if (!isLocal(url)) return whole
    seen.add(stripQuery(url))
    return `url(${quote}${toSite(fromDir, url)}${quote})`
  })
}

// The theme switch a preview needs: the frame sets data-theme on <html>, and
// a repo may switch on a class or another attribute instead. Returns the
// script text, or '' when the repo's own selector already reads data-theme.
export function themeScript(config) {
  const tokens = config?.tokens ?? {}
  const selector = String(tokens.darkSelector ?? '').trim()
  const cls = /^(?:html|:root)?\.([\w-]+)$/.exec(selector)
  const attr = /^(?:html|:root)?\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(selector)
  if (attr && attr[1] === 'data-theme') return ''
  const apply = cls
    ? `r.classList.toggle(${JSON.stringify(cls[1])},d)`
    : attr
    ? `d?r.setAttribute(${JSON.stringify(attr[1])},${JSON.stringify(attr[2] ?? '')}):r.removeAttribute(${JSON.stringify(attr[1])})`
    : null
  if (!apply) return ''
  return `(function(){var r=document.documentElement;function s(){var d=r.getAttribute('data-theme')==='dark';${apply}}s();new MutationObserver(s).observe(r,{attributes:true,attributeFilter:['data-theme']})})()`
}

// An element picked out of a page by a simple selector (`#id`, `.class` or
// `[attr]`, `[attr=value]`): its outer HTML, or null. Tags are balanced by
// counting, which is enough for the markup a static build writes.
export function selectElement(html, selector) {
  const sel = selector.trim()
  const id = /^#([\w-]+)$/.exec(sel)
  const cls = /^\.([\w-]+)$/.exec(sel)
  const attr = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(sel)
  if (!id && !cls && !attr) return null
  const open = /<([a-z][\w-]*)\b([^>]*)>/gi
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const attrs = attrsOf(m[2])
    const hit = id ? attrs.id === id[1] : cls ? (attrs.class ?? '').split(/\s+/).includes(cls[1]) : attr[1] in attrs && (attr[2] === undefined || attrs[attr[1]] === attr[2])
    if (!hit) continue
    if (/\/\s*$/.test(m[2])) return m[0]
    const tag = m[1].toLowerCase()
    const walk = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi')
    walk.lastIndex = m.index + m[0].length
    let depth = 1
    for (let t = walk.exec(html); t; t = walk.exec(html)) {
      depth += t[1] ? -1 : /\/\s*>$/.test(t[0]) ? 0 : 1
      if (depth === 0) return html.slice(m.index, t.index + t[0].length)
    }
    return null
  }
  return null
}

const visibleText = (html) => html.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '').replace(/\s+/g, '')

// A built story page as a component preview: its stylesheets and markup kept,
// its scripts dropped (so the preview is a still of what the page renders),
// and every file it loads from its own site pointed at the copy under
// `site/`. `fromDir` is the preview's folder under the project folder.
// Returns { html, assets (site paths to copy), stylesheets (site paths of the
// CSS files, to rewrite as they are copied), note }, or { empty: reason }
// when the page draws itself in the browser and holds nothing to keep.
export function previewFromPage(page, { group = null, height = 320, fromDir, select = null, script = '', title = '' }) {
  const head = innerOf(page, 'head')
  const body = innerOf(page, 'body')
  if (!body) return { empty: 'the page has no body' }
  const htmlTag = /<html\b([^>]*)>/i.exec(page)
  const assets = new Set()
  const stylesheets = new Set()

  let markup = body.inner
  if (select) {
    const picked = selectElement(markup, select)
    if (picked === null) return { empty: `nothing on the page matches ${select}` }
    markup = picked
  }
  markup = markup.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
  if (/<(?:iframe|frame|object|embed|portal)\b/i.test(markup)) markup = markup.replace(/<(iframe|frame|object|embed|portal)\b[\s\S]*?(?:<\/\1>|\/>)/gi, '')
  if (visibleText(markup).length === 0 && !/<(?:img|svg|canvas|video|picture)\b/i.test(markup)) {
    return { empty: 'the built page holds no markup: its states are drawn in the browser, so a still needs a snapshot of the running page' }
  }

  const styles = []
  for (const m of (head?.inner ?? '').matchAll(/<link\b([^>]*)>|<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (m[2] !== undefined) {
      styles.push(`<style>${rewriteCssUrls(m[2], fromDir, assets).replace(/<\/style/gi, '<\\/style')}</style>`)
      continue
    }
    const attrs = attrsOf(m[1])
    if (!/\bstylesheet\b/i.test(attrs.rel ?? '') || !attrs.href) continue
    if (!isLocal(attrs.href)) {
      styles.push(`<link rel="stylesheet" href="${attrs.href}">`)
      continue
    }
    const path = stripQuery(attrs.href)
    stylesheets.add(path)
    styles.push(`<link rel="stylesheet" href="${toSite(fromDir, path)}">`)
  }

  // Files the markup loads; a link to another page of the site leads nowhere here.
  markup = markup.replace(/<a\b([^>]*?)\shref=(["'])\/(?!\/)[^"']*\2/gi, '<a$1 href=$2#$2')
  markup = markup.replace(/\s(src|poster|href|data)=(["'])(\/(?!\/)[^"']*)\2/gi, (whole, name, quote, url) => {
    assets.add(stripQuery(url))
    return ` ${name}=${quote}${toSite(fromDir, url)}${quote}`
  })
  markup = markup.replace(/\ssrcset=(["'])([^"']*)\1/gi, (whole, quote, list) => {
    const parts = list.split(',').map((part) => {
      const [url, ...rest] = part.trim().split(/\s+/)
      if (!isLocal(url ?? '')) return part.trim()
      assets.add(stripQuery(url))
      return [toSite(fromDir, url), ...rest].join(' ')
    })
    return ` srcset=${quote}${parts.join(', ')}${quote}`
  })
  markup = markup.replace(/(\sstyle=(["']))([^"']*)\2/gi, (whole, lead, quote, css) => `${lead}${rewriteCssUrls(css, fromDir, assets)}${quote}`)

  const keep = (attrs, names) => names.filter((n) => attrs[n]).map((n) => ` ${n}="${attrs[n].replace(/"/g, '&quot;')}"`).join('')
  const htmlAttrs = htmlTag ? attrsOf(htmlTag[1]) : {}
  const marker = `<!-- @dsCard${group ? ` group="${group.replace(/"/g, '')}"` : ''} height=${height} -->`
  const html = [
    marker,
    '<!doctype html>',
    `<html${keep(htmlAttrs, ['lang', 'dir', 'class'])}>`,
    '<head>',
    '<meta charset="utf-8">',
    `<title>${title.replace(/[<&]/g, '')}</title>`,
    ...styles,
    '</head>',
    `<body${keep(body.attrs, ['class', 'style'])}>`,
    markup.trim(),
    ...(script ? [`<script>${script}</script>`] : []),
    '</body>',
    '</html>',
    '',
  ].join('\n')
  return { html, assets: [...assets].sort(compare), stylesheets: [...stylesheets].sort(compare), note: 'a still of the story page, built without its scripts' }
}

// Where a story's built page is, from the lane's URL for it: the path of
// `stories.storyUrl` with the slug put in, as a static build writes it.
export function builtPagePaths(storyUrl, slug) {
  if (typeof storyUrl !== 'string' || !storyUrl.includes('{slug}')) return []
  let path
  try {
    path = new URL(storyUrl.replace('{slug}', slug), 'http://localhost').pathname
  } catch {
    return []
  }
  const clean = path.replace(/\/+$/, '')
  return [`${clean}/index.html`, `${clean}.html`]
}

// ── Fonts the built CSS declares ───────────────────────────────────────────

// Each @font-face of a stylesheet that loads a file from the site, as
// { family, weight, style, path }.
export function fontFaces(css) {
  const out = []
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = m[1]
    const get = (prop) => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1].trim() ?? null
    const family = (get('font-family') ?? '').replace(/^["']|["']$/g, '')
    const src = /url\(\s*["']?([^"')]+\.(?:woff2|woff|ttf|otf))(?:[?#][^"')]*)?["']?\s*\)/i.exec(get('src') ?? '')
    if (!family || !src || !isLocal(src[1])) continue
    out.push({ family, weight: (get('font-weight') ?? '400').replace(/\bnormal\b/, '400').replace(/\bbold\b/, '700'), style: get('font-style') ?? 'normal', path: src[1] })
  }
  return out
}

// ── What a publisher needs to know about each file ─────────────────────────

const TYPES = {
  html: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', md: 'text/markdown', txt: 'text/plain',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
}

// A file's media type by its extension; a type nothing serves by name (a
// `.d.ts`, a `.map`) goes as plain text.
export const contentTypeOf = (path) => TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'text/plain'

// A picture, a video or a PDF under assets/: a tool that keeps such files in
// a store of their own uploads these, and names each in its index.
export const isMedia = (path) => /^(?:image|video)\/|^application\/pdf$/.test(contentTypeOf(path))
