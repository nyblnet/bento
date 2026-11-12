// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// The routes browser pages call (browsers.js), kept apart from worker.js
// because the Workers runtime refuses any export of the main module that is
// not a handler, a class or an object.
// server/signin/public/directory-client.js names the same web routes.

export const WEB_ROUTES = Object.freeze({
  /** every /v1/web/* answer carries CORS for the sign-in host alone, and its Origin is required */
  prefix: '/v1/web/',
  /** POST {address} → 200 {nonce, at, rosHash}; 404 for an address with no account */
  challenge: '/v1/web/challenge',
  /** POST {text, rq, assertion} → 200 {ok, wdev, watt} */
  enrol: '/v1/web/enrol',
})

export const HOME_ROUTES = Object.freeze({
  /** every /v1/home/* answer carries CORS for bento/home alone, and its Origin is required */
  prefix: '/v1/home/',
  /** POST {address} → 200 {nonce}; 404 for an address with no account */
  challenge: '/v1/home/challenge',
  /** POST {wren, sig, pin?} → 200 {watt, wattSig, signer, assertion, roster, incidents}; 403 {error: unknown | revoked | cap, incidents} */
  checkin: '/v1/home/checkin',
})

/** GET ?e=<address>&c=<sha256 of the certificate text> → 200 {state, incidents}: CORS *, for any peer */
export const STATUS_ROUTE = '/v1/device/status'
