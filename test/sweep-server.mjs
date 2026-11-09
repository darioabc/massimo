// A tiny HTTP server in a child process, so a test that runs a script
// synchronously still has a server that answers. Resolves to its base URL
// and a stop function.

import { spawn } from 'node:child_process'

const SOURCE = "const s = require('node:http').createServer((q, r) => r.end('ok')); s.listen(0, '127.0.0.1', () => console.log(s.address().port))"

export async function startServer() {
  const child = spawn(process.execPath, ['-e', SOURCE], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.stdout.once('data', (d) => resolve(Number(String(d).trim())))
  })
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() }
}
