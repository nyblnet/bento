// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The ONE seam between the sign-in host and the bento/id directory.
//
// Everything the sign-in host knows about the directory's API is in this file:
// the origin, the two routes it calls, the request and answer shapes, the
// text a passkey signs to certify a browser key, and the challenge over it. The directory's roster API is
// being built separately; when it lands, this file is the only one that
// changes. The statement layout belongs to the kernel: wdevText writes
// kernel/src/devices.ts's `wdev.` exactly (scripts/test-signin-host.mjs checks
// it against the kernel's own builder), and the directory refuses any other.
//
// The page's CSP allows connections to DIRECTORY and nowhere else, so a new
// origin here also needs the worker's CSP changed (server/signin/src/worker.js).

export const DIRECTORY = 'https://id.bento.page'

/** The routes. */
export const ROUTES = Object.freeze({
  /**
   * POST `{ address }` → 200 `{ nonce, at, rosHash }`: a single-use directory
   * challenge bound to that account, the directory's time for it (the
   * ceremony time a `wdev.` names, from which its 7-day cap counts), and the
   * hash of the account's current roster head (the head the passkey signs as
   * a member of).
   */
  challenge: '/v1/web/challenge',
  /**
   * POST `{ text, rq, assertion }` → 200 `{ ok: true, wdev, watt }`, or an
   * error status. `wdev` is `text` as the directory logged it; `watt` is its
   * countersign. bento/home fetches the signed countersign, the passkey's
   * assertion and the roster itself, and verifies all of it. `rq` is the
   * origin of the page that asked (taken from the
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

/** A fresh single-use challenge from the directory, for the account `address`. */
export async function enrolChallenge(address) {
  const a = await post(ROUTES.challenge, { address })
  if (!a || typeof a.nonce !== 'string' || !/^[A-Za-z0-9_-]{22,86}$/.test(a.nonce) ||
    !Number.isSafeInteger(a.at) || a.at <= 0 ||
    typeof a.rosHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(a.rosHash)) throw new Error('directory answer')
  return { nonce: a.nonce, at: a.at, rosHash: a.rosHash }
}

/**
 * The text the passkey signs to certify browser key W (with its key-agreement
 * key kx and the label bento/home chose): the kernel's `wdev.`
 * (kernel/src/devices.ts buildDeviceCert), via `passkey`.
 */
export function wdevText({ W, kx, address, rosHash, label, at, nonce }) {
  const utf8 = (s) => b64u(new TextEncoder().encode(s))
  return ['wdev', W, kx, utf8(address), rosHash, label ? utf8(label) : '', 'passkey', String(at), nonce].join('.')
}

/** The WebAuthn challenge a statement is signed under: SHA-256 of its exact UTF-8 text. */
export async function challengeFor(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

/** Hands the assertion to the directory; answers the two statements to return. */
export async function submitEnrol({ text, rq, assertion }) {
  const a = await post(ROUTES.enrol, { text, rq, assertion })
  if (!a || a.ok !== true || a.wdev !== text || typeof a.watt !== 'string') throw new Error('directory answer')
  return { wdev: a.wdev, watt: a.watt }
}
