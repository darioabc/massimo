#!/usr/bin/env node
// Zero-dependency static server for the project folder, so canvases, token
// previews and mockups open in a browser pane at a stable localhost URL.
//
//   serve.mjs [--dir <folder>] [--port 4700] [--host 127.0.0.1]
//
// --dir defaults to the project folder. Tries the next ten ports if busy.

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { loadConfig, parseArgs } from './lib/project.mjs'

const { flags } = parseArgs()
const dir = flags.dir ? resolve(flags.dir) : loadConfig(flags).projectDir
const host = flags.host ?? '127.0.0.1'
const firstPort = Number(flags.port ?? 4700)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
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

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = normalize(join(dir, decodeURIComponent(url.pathname)))
  if (path !== dir && !path.startsWith(dir + sep)) {
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
      const items = readdirSync(target, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => `<li><a href="${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}">${esc(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`)
        .join('')
      res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' })
      res.end(`<!doctype html><meta charset="utf-8"><title>${esc(url.pathname)}</title><body style="font:14px system-ui;padding:24px"><h1 style="font-size:16px">${esc(url.pathname)}</h1><ul>${items}</ul>`)
      return
    }
  }
  if (!existsSync(target)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  createReadStream(target).pipe(res)
})

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
  process.stdout.write(`massimo: serving ${dir} at http://localhost:${port}/\n`)
})
server.listen(port, host)
