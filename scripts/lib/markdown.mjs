// A small Markdown renderer for the project's own files (STATUS.md,
// graph.md, audits, handoffs, briefs), so serve.mjs can show them as pages.
// It covers what massimo writes: headings, paragraphs, nested lists, tables,
// fenced code, blockquotes, rules, links, code spans, bold and italic. HTML in
// the source is escaped, never passed through, and comments are dropped.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c])

// Only links a reader can follow safely: web, mail, anchors and relative paths.
const safeHref = (href) => (/^(https?:|mailto:|#|\.{0,2}\/|[\w-][\w./-]*(?:[#?].*)?$)/i.test(href) ? href : '#')

export function slug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&\w+;/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

export function renderInline(text) {
  const codes = []
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = escapeHtml(s)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${safeHref(href)}">${label}</a>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?![\w*])/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`)
}

const LIST = /^(\s*)([-*+]|(\d+)\.)\s+(.*)$/
const FENCE = /^\s*```/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))

function renderList(items) {
  let html = ''
  const stack = []
  const open = (it) => {
    const tag = it.ordered ? 'ol' : 'ul'
    html += `<${tag}${it.ordered && it.start !== 1 ? ` start="${it.start}"` : ''}>`
    stack.push({ indent: it.indent, tag })
  }
  for (const it of items) {
    if (!stack.length || it.indent > stack.at(-1).indent) open(it)
    else {
      while (stack.length > 1 && it.indent < stack.at(-1).indent) html += `</li></${stack.pop().tag}>`
      // A bullet straight after a numbered item (or the reverse) starts a new list.
      if (stack.at(-1).tag !== (it.ordered ? 'ol' : 'ul')) {
        html += `</li></${stack.pop().tag}>`
        open(it)
      } else {
        html += '</li>'
      }
    }
    html += `<li>${renderInline(it.text)}`
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`
  return html
}

const isBlockStart = (line) => HEADING.test(line) || FENCE.test(line) || LIST.test(line) || RULE.test(line) || /^\s*>/.test(line) || /^\s*\|/.test(line)

export function renderMarkdown(source) {
  const lines = source.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    if (FENCE.test(line)) {
      const lang = line.trim().slice(3).trim()
      const body = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++])
      i++
      out.push(`<pre${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      const inner = renderInline(h[2])
      out.push(`<h${h[1].length} id="${slug(inner)}">${inner}</h${h[1].length}>`)
      i++
      continue
    }
    if (RULE.test(line)) {
      out.push('<hr>')
      i++
      continue
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push(
        `<div class="table"><table><thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => `<td>${renderInline(r[k] ?? '')}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      )
      continue
    }
    if (/^\s*>/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`)
      continue
    }
    if (LIST.test(line)) {
      const items = []
      while (i < lines.length) {
        const m = LIST.exec(lines[i])
        if (m) {
          items.push({ indent: m[1].length, ordered: Boolean(m[3]), start: m[3] ? Number(m[3]) : 1, text: m[4] })
          i++
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          items.at(-1).text += ` ${lines[i].trim()}`
          i++
        } else break
      }
      out.push(renderList(items))
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i]))) para.push(lines[i++].trim())
    out.push(`<p>${renderInline(para.join(' '))}</p>`)
  }
  return out.join('\n')
}

// The page a rendered file sits in: readable in light and dark, with a path
// trail back up the project folder and a link to the raw file.
export function markdownPage({ title, body, trail = [], raw }) {
  const crumbs = trail.map((c, i) => (i === trail.length - 1 ? `<span>${escapeHtml(c.name)}</span>` : `<a href="${escapeHtml(c.href)}">${escapeHtml(c.name)}</a>`)).join('<i>/</i>')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg: #fbfbf9; --fg: #1b1b1a; --muted: #6b6b66; --line: #e4e4df; --code: #f1f1ec; --link: #a3260f; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141413; --fg: #ececea; --muted: #9a9a94; --line: #2c2c2a; --code: #1f1f1d; --link: #f08a6f; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  .bar { position: sticky; top: 0; display: flex; justify-content: space-between; gap: 16px; padding: 12px 24px; background: var(--bg); border-bottom: 1px solid var(--line); font-size: 13px; z-index: 1; }
  .bar nav { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; } .bar i { color: var(--muted); font-style: normal; }
  .bar a { color: var(--muted); text-decoration: none; } .bar a:hover { color: var(--fg); }
  main { max-width: 880px; margin: 0 auto; padding: 32px 24px 96px; }
  h1 { font-size: 28px; line-height: 1.2; letter-spacing: -0.01em; margin: 8px 0 24px; }
  h2 { font-size: 20px; margin: 40px 0 12px; padding-top: 16px; border-top: 1px solid var(--line); }
  h3 { font-size: 16px; margin: 28px 0 8px; }
  h4, h5, h6 { font-size: 14px; margin: 20px 0 6px; }
  p, ul, ol, blockquote, pre, .table { margin: 0 0 14px; }
  ul, ol { padding-left: 22px; } li { margin: 3px 0; } li > ul, li > ol { margin: 4px 0; }
  a { color: var(--link); text-underline-offset: 3px; }
  code { font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace; background: var(--code); padding: 1px 5px; border-radius: 4px; }
  pre { background: var(--code); padding: 14px 16px; border-radius: 8px; overflow-x: auto; } pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid var(--line); padding-left: 14px; color: var(--muted); }
  hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
  .table { overflow-x: auto; } table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; } th { color: var(--muted); font-weight: 600; }
  .files { list-style: none; padding: 0; }
  .files a { text-decoration: none; } .files .dir a { font-weight: 600; } .files small { color: var(--muted); margin-left: 6px; }
</style>
</head>
<body>
<div class="bar"><nav>${crumbs}</nav>${raw ? `<a href="${escapeHtml(raw)}">Raw</a>` : ''}</div>
<main>
${body}
</main>
</body>
</html>
`
}
