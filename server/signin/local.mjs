// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Runs the sign-in host's worker in node, with the assets binding read from
// public/ on disk. Used by the rigs, and for a local look at the headers:
//
//   node server/signin/local.mjs [port]      # http://127.0.0.1:8789/
//   node server/signin/check-hosting.mjs --origin http://127.0.0.1:8789 --local
//
// A browser cannot run the passkey ceremony here: the rp is id.bento.page, and
// only a page on that name or under it may use it. The browser rig routes the
// real host name to this handler instead.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** The worker's env, with ASSETS backed by `<root>/public`. */
export function assetsEnv(root = HERE) {
  return {
    ASSETS: {
      async fetch(req) {
        const p = new URL(req.url).pathname
        if (p.includes('..') || p.includes('\\')) return new Response('', { status: 404 })
        try {
          return new Response(await readFile(join(root, 'public', p)), { status: 200 })
        } catch {
          return new Response('', { status: 404 })
        }
      },
    },
  }
}

/** A fetch(Request) → Response for the site rooted at `root` (default: this directory). */
export async function siteHandler(root = HERE, tag = '') {
  const worker = (await import(pathToFileURL(join(root, 'src', 'worker.js')).href + (tag ? '?' + tag : ''))).default
  const env = assetsEnv(root)
  return (request) => worker.fetch(request, env)
}

/** Serves `handler` over plain HTTP on 127.0.0.1. Resolves to { url, close }. */
export function serve(handler, port = 0) {
  const server = createServer(async (req, res) => {
    const body = []
    for await (const c of req) body.push(c)
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(body),
    })
    const r = await handler(request)
    res.writeHead(r.status, Object.fromEntries(r.headers))
    res.end(Buffer.from(await r.arrayBuffer()))
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })
  }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await serve(await siteHandler(), Number(process.argv[2] || 8789))
  console.log(`sign-in host (local, headers only): ${s.url}/`)
}
