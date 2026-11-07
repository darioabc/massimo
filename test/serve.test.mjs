// serve.mjs answers a bad URL with 400 and keeps running, and never serves a
// file outside its folder, whether reached by `..` or by a symlink.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { SCRIPTS } from './helpers.mjs'

const base = mkdtempSync(join(tmpdir(), 'massimo-serve-'))
const dir = join(base, 'project')
mkdirSync(dir)
writeFileSync(join(dir, 'ok.txt'), 'inside')
writeFileSync(join(base, 'secret.txt'), 'outside')
symlinkSync(join(base, 'secret.txt'), join(dir, 'link.txt'))
symlinkSync(base, join(dir, 'up'))

let server
let port
before(async () => {
  server = spawn(process.execPath, [join(SCRIPTS, 'serve.mjs'), '--dir', dir, '--port', '0'])
  port = await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => {
      const m = /localhost:(\d+)/.exec(String(d))
      if (m) resolve(Number(m[1]))
    })
    server.on('exit', (code) => reject(new Error(`serve exited ${code}`)))
  })
})
after(() => {
  server.kill()
  rmSync(base, { recursive: true, force: true })
})

// A raw request, so the malformed path reaches the server as typed.
const get = (path) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })

test('a malformed URL is a 400, and the server keeps serving', async () => {
  assert.equal((await get('/%E0%A4%A')).status, 400)
  const ok = await get('/ok.txt')
  assert.equal(ok.status, 200)
  assert.equal(ok.body, 'inside')
})

test('nothing outside the folder is served, through .. or a symlink', async () => {
  // The URL parser folds `..` away, so these land inside the folder and miss.
  for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt']) {
    const r = await get(path)
    assert.notEqual(r.body, 'outside', path)
    assert.ok([403, 404].includes(r.status), `${path}: ${r.status}`)
  }
  // A symlink inside the folder that leads out of it is refused.
  assert.equal((await get('/link.txt')).status, 403)
  assert.equal((await get('/up/secret.txt')).status, 403)
})
