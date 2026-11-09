#!/usr/bin/env node
// Zero-dependency static server for the project folder, so canvases, token
// previews and mockups open in a browser pane at a stable localhost URL.
// Markdown (STATUS.md, graph.md, audits, handoffs) renders as a page; add
// `?raw` for the file itself. A folder with no index.html lists its files,
// with its STATUS.md or README.md rendered under the list.
//
//   serve.mjs [--dir <folder>] [--port 4700] [--host 127.0.0.1]
//
// --dir defaults to the project folder. Tries the next ten ports if busy.

import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { escapeHtml, markdownPage, renderMarkdown } from './lib/markdown.mjs'
import { loadConfig, parseArgs } from './lib/project.mjs'
import { helpAndExit } from './lib/help.mjs'

helpAndExit(import.meta.url)

const { flags } = parseArgs()
const dir = realpathSync(flags.dir ? resolve(flags.dir) : loadConfig(flags).projectDir)
const host = flags.host ?? '127.0.0.1'
const firstPort = Number(flags.port ?? 4700)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

const root = dir.split(sep).pop() || dir

// The path trail from the served folder down to this URL, for the page bar.
function trail(pathname) {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const out = [{ name: root, href: '/' }]
  parts.forEach((p, i) => out.push({ name: p, href: `/${parts.slice(0, i + 1).map(encodeURIComponent).join('/')}${i < parts.length - 1 ? '/' : ''}` }))
  return out
}

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' })
  res.end(html)
}

function listing(target, pathname) {
  const entries = readdirSync(target, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const items = entries
    .map((e) => {
      const isDir = e.isDirectory()
      const note = isDir ? `${readdirSync(join(target, e.name)).filter((n) => !n.startsWith('.')).length} items` : ''
      return `<li class="${isDir ? 'dir' : 'file'}"><a href="${encodeURIComponent(e.name)}${isDir ? '/' : ''}">${escapeHtml(e.name)}${isDir ? '/' : ''}</a>${note ? `<small>${note}</small>` : ''}</li>`
    })
    .join('')
  const readme = ['STATUS.md', 'README.md'].map((n) => join(target, n)).find((p) => existsSync(p))
  const body = `<h1>${escapeHtml(trail(pathname).at(-1).name)}</h1><ul class="files">${items || '<li>Empty folder.</li>'}</ul>${readme ? `<hr>${renderMarkdown(readFileSync(readme, 'utf8'))}` : ''}`
  return markdownPage({ title: pathname, body, trail: trail(pathname) })
}

const inside = (p) => p === dir || p.startsWith(dir + sep)

// A request that cannot be served gets an error page, never a crash: a bad
// URL is a 400, and any other failure a 500 that leaves the server running.
const server = createServer((req, res) => {
  try {
    handle(req, res)
  } catch (err) {
    if (res.headersSent) res.end()
    else res.writeHead(500, { 'content-type': 'text/plain' }).end(`error: ${err.message}`)
  }
})

function handle(req, res) {
  let url
  let path
  try {
    url = new URL(req.url, 'http://x')
    path = normalize(join(dir, decodeURIComponent(url.pathname)))
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request')
    return
  }
  // Checked twice: the path as asked for, and where it really leads once
  // symlinks are followed, so a link inside the folder cannot serve a file outside it.
  if (!inside(path) || (existsSync(path) && !inside(realpathSync(path)))) {
    res.writeHead(403).end('forbidden')
    return
  }
  let target = path
  if (existsSync(target) && statSync(target).isDirectory()) {
    if (!url.pathname.endsWith('/')) {
      res.writeHead(301, { location: `${url.pathname}/` }).end()
      return
    }
    const index = join(target, 'index.html')
    if (existsSync(index)) target = index
    else {
      sendHtml(res, listing(target, url.pathname))
      return
    }
  }
  if (!existsSync(target)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    return
  }
  if (extname(target).toLowerCase() === '.md' && !url.searchParams.has('raw')) {
    const text = readFileSync(target, 'utf8')
    const title = text.match(/^#\s+(.+)$/m)?.[1] ?? url.pathname
    sendHtml(res, markdownPage({ title, body: renderMarkdown(text), trail: trail(url.pathname), raw: `${url.pathname}?raw` }))
    return
  }
  if (!inside(realpathSync(target))) {
    res.writeHead(403).end('forbidden')
    return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  createReadStream(target).pipe(res)
}

let port = firstPort
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < firstPort + 10) {
    port++
    server.listen(port, host)
  } else {
    process.stderr.write(`massimo: ${e.message}\n`)
    process.exit(1)
  }
})
server.on('listening', () => {
  process.stdout.write(`massimo: serving ${dir} at http://localhost:${server.address().port}/\n`)
})
server.listen(port, host)
