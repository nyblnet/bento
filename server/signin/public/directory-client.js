// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The ONE seam between the sign-in host and the bento/id directory.
//
// Everything the sign-in host knows about the directory's API is in this file:
// the origin, the two routes it calls, the request and answer shapes, the
// text a passkey signs to certify a browser key, and the challenge over it. The directory's roster API is
// being built separately; when it lands, this file is the only one that
// changes. The shapes below are PROVISIONAL and say so: the statement layout in
// particular belongs to the kernel (`wdev.` is reserved in
// kernel/src/statements.ts) and replaces wdevText when it is defined there.
//
// The page's CSP allows connections to DIRECTORY and nowhere else, so a new
// origin here also needs the worker's CSP changed (server/signin/src/worker.js).

export const DIRECTORY = 'https://id.bento.page'

/** Provisional routes. */
export const ROUTES = Object.freeze({
  /** POST, empty body → 200 `{ nonce }`: a single-use directory challenge. */
  challenge: '/v1/web/challenge',
  /**
   * POST `{ text, rq, assertion }` → 200 `{ ok: true, wdev, watt }`, or an
   * error status. `rq` is the origin of the page that asked (taken from the
   * message event, never from a request body); the directory logs it beside
   * the browser-set Origin of this request. `assertion` is
   * `{ id, userHandle, authenticatorData, clientDataJSON, signature }`, all
   * base64url without padding.
   */
  enrol: '/v1/web/enrol',
})

export const b64u = (bytes) => {
  let s = ''
  for (const x of new Uint8Array(bytes)) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const post = async (route, body) => {
  const r = await fetch(DIRECTORY + route, {
    method: 'POST',
    // JSON sent as text/plain: a simple request, so no preflight. The
    // directory parses the body as JSON whatever the type says.
    body: JSON.stringify(body),
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  })
  if (!r.ok) throw new Error('directory ' + r.status)
  return r.json()
}

/** A fresh single-use challenge from the directory. */
export async function enrolChallenge() {
  const a = await post(ROUTES.challenge, {})
  if (!a || typeof a.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(a.nonce)) throw new Error('directory answer')
  return a.nonce
}

/**
 * The text the passkey signs to certify browser key W (with its key-agreement
 * key kx and the label bento/home chose). PROVISIONAL layout, to be replaced by
 * the kernel's `wdev.` definition.
 */
export function wdevText({ W, kx, label, nonce }) {
  return 'wdev.' + W + '.' + kx + '.' + b64u(new TextEncoder().encode(label)) + '.' + nonce
}

/** The WebAuthn challenge a statement is signed under: SHA-256 of its exact UTF-8 text. */
export async function challengeFor(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

/** Hands the assertion to the directory; answers the two statements to return. */
export async function submitEnrol({ text, rq, assertion }) {
  const a = await post(ROUTES.enrol, { text, rq, assertion })
  if (!a || a.ok !== true || typeof a.wdev !== 'string' || typeof a.watt !== 'string') throw new Error('directory answer')
  return { wdev: a.wdev, watt: a.watt }
}
