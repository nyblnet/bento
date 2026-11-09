// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Stage-0 probe P5: the log canary (sitting C3, row 9). What does Cloudflare
// keep about a request to a Worker, by default and with logging off?
//
// WHAT IS SENT WHERE. Only when the person runs the curl line or presses the
// page's Send button: one POST from their machine to THIS Worker, carrying
//   URL     ?canary=CANARY-URL-<run>
//   header  X-Canary: CANARY-HDR-<run>
//   body    CANARY-BODY-<run>
// and nothing else of theirs. <run> is random per page load, so runs under
// different configs don't mix. The Worker answers with sizes only, stores
// nothing, and writes exactly ONE log line itself: `probe-logline
// CANARY-LOGLINE-<run>`, the positive control that tells "logs are off" from
// "logs are on but this kind of data isn't captured". It never logs the URL,
// headers or body itself: whatever of those shows up in the dashboard, the
// platform kept on its own. That is the measurement.
//
// GET / is the instructions page with the copy-results form; it sends nothing.

import { page } from './page.js'

const CANARY = /^[A-Za-z0-9-]{1,64}$/

export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      return new Response(page(url.origin), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        },
      })
    }
    if (request.method === 'POST' && url.pathname === '/canary') {
      const body = await request.text()
      const run = (/^CANARY-BODY-(.+)$/.exec(body.trim()) || [])[1]
      const tag = run && CANARY.test(run) ? run : 'unknown'
      // the ONLY thing this Worker logs (positive control)
      console.log('probe-logline CANARY-LOGLINE-' + tag)
      return Response.json({
        received: true,
        run: tag,
        bodyBytes: body.length,
        urlCanary: url.searchParams.has('canary'),
        headerCanary: request.headers.has('x-canary'),
        loggedByWorker: 'probe-logline CANARY-LOGLINE-' + tag,
      }, { headers: { 'cache-control': 'no-store' } })
    }
    return new Response('not found', { status: 404 })
  },
}
