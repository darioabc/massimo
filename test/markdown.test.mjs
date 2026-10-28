import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderInline, renderMarkdown } from '../scripts/lib/markdown.mjs'

test('inline: code, bold, italic and links, with HTML escaped', () => {
  assert.equal(renderInline('use `a < b` and **bold** and *it*'), 'use <code>a &lt; b</code> and <strong>bold</strong> and <em>it</em>')
  assert.equal(renderInline('[graph](graph.md)'), '<a href="graph.md">graph</a>')
  assert.equal(renderInline('[x](javascript:alert(1))'), '<a href="#">x</a>)')
  assert.equal(renderInline('<script>'), '&lt;script&gt;')
  assert.equal(renderInline('snake_case_name stays'), 'snake_case_name stays')
})

test('blocks: headings, tables, nested lists, fences, comments', () => {
  const html = renderMarkdown(
    [
      '# Title',
      '<!-- massimo:progress:start -->',
      '| Phase | Status |',
      '|---|---|',
      '| Graph | ✓ done |',
      '| Pipe \\| inside | x |',
      '',
      '1. first',
      '   continued',
      '2. second',
      '   - nested `code`',
      '- after',
      '',
      '```json',
      '{ "a": "<b>" }',
      '```',
      '',
      'A paragraph',
      'over two lines.',
    ].join('\n'),
  )
  assert.match(html, /<h1 id="title">Title<\/h1>/)
  assert.doesNotMatch(html, /massimo:progress/)
  assert.match(html, /<th>Phase<\/th><th>Status<\/th>/)
  assert.match(html, /<td>Pipe \| inside<\/td>/)
  assert.match(html, /<ol><li>first continued<\/li><li>second<ul><li>nested <code>code<\/code><\/li><\/ul><\/li><\/ol>/)
  assert.match(html, /<ul><li>after<\/li><\/ul>/)
  assert.match(html, /<pre data-lang="json"><code>\{ &quot;a&quot;: &quot;&lt;b&gt;&quot; \}<\/code><\/pre>/)
  assert.match(html, /<p>A paragraph over two lines\.<\/p>/)
})
