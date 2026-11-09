// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// The routes the sign-in host (server/signin) calls from a browser page, kept
// apart from worker.js because the Workers runtime refuses any export of the
// main module that is not a handler, a class or an object.
// server/signin/public/directory-client.js names the same routes.

export const WEB_ROUTES = Object.freeze({
  /** every /v1/web/* answer carries CORS for the sign-in host alone */
  prefix: '/v1/web/',
  /** POST, any body → 200 { nonce } */
  challenge: '/v1/web/challenge',
  /** POST { text, rq, assertion } → 200 { ok, wdev, watt } (501 until the kernel defines wdev.) */
  enrol: '/v1/web/enrol',
})
