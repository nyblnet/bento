// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The sign-in host's worker: serves four static files from the assets binding,
// each with the same fixed header set, and nothing else. It runs first for
// every request (wrangler.toml: run_worker_first), so no file reaches a
// browser without these headers, including the 404.
//
// What the headers must and must not be is checked by check-hosting.mjs, which
// the deploy runs against the live host:
//   - a strict CSP on EVERY response: default-src 'none', scripts from 'self'
//     only (no inline, no eval), connections only to the directory, and
//     frame-ancestors 'none' (with X-Frame-Options DENY for older engines);
//   - NO Cross-Origin-Opener-Policy. This page is a popup that answers its
//     opener, bento/home; `same-origin` here (or on bento/home; it may send at
//     most `same-origin-allow-popups`) severs the opener and kills the protocol.
//   - no /.well-known/webauthn (or any other path): unknown paths are 404.

export const DIRECTORY_ORIGIN = 'https://id.bento.page'

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  `connect-src ${DIRECTORY_ORIGIN}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

export const HEADERS = Object.freeze({
  'content-security-policy': CSP,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'strict-transport-security': 'max-age=31536000',
  'cache-control': 'no-cache',
})

/** Path → [asset file, content type]. The whole site. */
export const FILES = Object.freeze({
  '/': ['/index.html', 'text/html; charset=utf-8'],
  '/signin.js': ['/signin.js', 'text/javascript; charset=utf-8'],
  '/directory-client.js': ['/directory-client.js', 'text/javascript; charset=utf-8'],
  '/signin.css': ['/signin.css', 'text/css; charset=utf-8'],
})

const answer = (status, body, type, head) =>
  new Response(head ? null : body, { status, headers: { ...HEADERS, 'content-type': type } })

export default {
  async fetch(request, env) {
    const method = request.method
    const head = method === 'HEAD'
    if (method !== 'GET' && !head) return answer(405, 'Method not allowed\n', 'text/plain; charset=utf-8', false)
    const path = new URL(request.url).pathname
    const file = Object.hasOwn(FILES, path) ? FILES[path] : null
    if (!file) return answer(404, 'Not found\n', 'text/plain; charset=utf-8', head)
    // A failing binding still answers with the header set, never the
    // platform's own error page.
    try {
      const asset = await env.ASSETS.fetch(new Request(new URL(file[0], request.url), { method: 'GET' }))
      if (!asset.ok) return answer(404, 'Not found\n', 'text/plain; charset=utf-8', head)
      return answer(200, await asset.arrayBuffer(), file[1], head)
    } catch {
      return answer(500, 'Server error\n', 'text/plain; charset=utf-8', head)
    }
  },
}
