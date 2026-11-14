// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The account pages' seam with the bento/id directory: everything the sign-in
// host's OWN pages (/setup, /reset, /account) know about the directory's API,
// and the one place this host writes which account it is signed in to.
// (directory-client.js is the popup's seam: the enrolment bento/home asks for.)
//
// The pages' rules, each pinned by a rig row with a mutant that breaks it
// (scripts/test-signin-host.mjs, scripts/test-signin-host-pages.mjs):
//
// - `bento-id-account` is written in ONE place, signInHere(), and only with the
//   address the directory answered after verifying a passkey assertion made on
//   this page. Never from a URL, a message, a typed address or a link. A setup
//   is confirmed by such a sign-in with the passkey it just made, and the
//   directory's answer must be the address the link was for.
// - A reset writes nothing: its new passkey is not on the account until the
//   reset takes effect, 72 hours later.
// - These pages answer no message and post none. Account changes start here,
//   by the person, never because another page asked.
// - No WebAuthn Signal API call, and no recovery code: the web never makes one.
//
// The routes the directory has today (`/v1/roster/*`, server/directory) are
// used as they are. The `/v1/web/signin*` and `/v1/web/signout*` routes do not
// exist in the directory yet; their contract is in
// scripts/lib/id-signin-directory-stub.mjs, which the rigs run against, and the
// `wout.` text below is PROVISIONAL until the kernel defines it.

import { DIRECTORY, b64u, challengeFor } from './directory-client.js'

export const RP_ID = 'id.bento.page'
export const ACCOUNT_KEY = 'bento-id-account'
const TIMEOUT = 120000

export const ROUTES = Object.freeze({
  /** POST {email} → 202, always the same answer: mails a setup link if the address can have one. */
  setupStart: '/v1/roster/setup/start',
  /** POST {email} → 202, always the same answer: mails a reset link if the address has an account. */
  resetStart: '/v1/roster/reset/start',
  /** POST {email} → 200 {challenge}: a sealed single-use 40-byte challenge for that address. */
  rosterChallenge: '/v1/roster/challenge',
  /** POST {email, token, dirNonce, reg} → 200 {ros}. */
  setup: '/v1/roster/setup',
  /** POST {email, token, dirNonce, reg} → 202 {ros, requestedAt, ripensAt}. */
  reset: '/v1/roster/reset',
  /** POST {} → 200 {nonce}: a sealed single-use 40-byte challenge for a sign-in. */
  signinChallenge: '/v1/web/signin/challenge',
  /** POST {nonce, assertion} → 200 {address}: the account whose live passkey made the assertion. */
  signin: '/v1/web/signin',
  /** POST {address} → 200 {nonce, at}: a challenge bound to that account; 501 until the directory can sign browsers out. */
  signoutChallenge: '/v1/web/signout/challenge',
  /** POST {text, assertion} → 200 {ok: true, at}: every browser key of the account is revoked. */
  signout: '/v1/web/signout',
})

/** A sealed directory challenge: 40 bytes, base64url. Never 32: a statement's challenge is a 32-byte hash. */
const SEALED = /^[A-Za-z0-9_-]{54}$/

/** A refusal the page can name. `reason` is shown to the rigs as data-reason. */
export class Refused extends Error {
  constructor(reason) { super(reason); this.reason = reason }
}

export const unb64u = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** An address as the directory stores it, as far as this page can tell: printable ASCII, one @. */
export function isAddress(s) {
  return typeof s === 'string' && s.length >= 3 && s.length <= 254 && /^[!-~]+$/.test(s) && s.indexOf('@') > 0 && s.indexOf('@') === s.lastIndexOf('@') && !s.endsWith('@')
}

/** POST JSON as text/plain (a simple request, no preflight). Answers {status, body}; never throws for a status. */
async function post(route, body) {
  let r
  try {
    r = await fetch(DIRECTORY + route, {
      method: 'POST', body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
    })
  } catch {
    throw new Refused('network')
  }
  let j = null
  try { j = await r.json() } catch { j = null }
  return { status: r.status, body: j && typeof j === 'object' && !Array.isArray(j) ? j : {} }
}

/** The account this host is signed in to, from its own storage, or null. */
export function savedAccount() {
  try {
    const a = localStorage.getItem(ACCOUNT_KEY)
    return isAddress(a) ? a : null
  } catch {
    return null
  }
}

/**
 * The passkey's user handle: SHA-256("bento-dir/1/addr\n" + address), the name
 * of the account's storage in the directory, then 16 random bytes. A
 * discoverable sign-in returns it, which is how the directory finds the
 * account; the random tail makes every passkey's handle distinct, so making a
 * new one (a reset) never overwrites an older one on the same authenticator.
 */
async function userHandle(address) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bento-dir/1/addr\n' + address)))
  const out = new Uint8Array(48)
  out.set(h, 0)
  out.set(crypto.getRandomValues(new Uint8Array(16)), 32)
  return out
}

const assertionOf = (cred) => {
  const res = cred.response
  return {
    id: b64u(cred.rawId),
    userHandle: res.userHandle ? b64u(res.userHandle) : '',
    authenticatorData: b64u(res.authenticatorData),
    clientDataJSON: b64u(res.clientDataJSON),
    signature: b64u(res.signature),
  }
}

/** Mails a setup link (kind 'setup') or a reset link (kind 'reset'). The directory answers 202 whatever happened. */
export async function startLink(kind, address) {
  const r = await post(kind === 'reset' ? ROUTES.resetStart : ROUTES.setupStart, { email: address })
  if (r.status !== 202) throw new Refused(r.status === 400 ? 'bad-address' : 'directory')
}

/**
 * A mailed link completed with a new passkey (G13): a fresh challenge for the
 * address, `create` for rp id.bento.page over it, then the link's route.
 * Answers {status, body, credId}; the page decides what a status means.
 */
export async function completeLink(kind, address, token) {
  const c = await post(ROUTES.rosterChallenge, { email: address })
  const dirNonce = c.body.challenge
  if (c.status !== 200 || typeof dirNonce !== 'string' || !SEALED.test(dirNonce)) throw new Refused('directory')
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { id: RP_ID, name: 'bento/id' },
      user: { id: await userHandle(address), name: address, displayName: address },
      challenge: unb64u(dirNonce),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none',
      timeout: TIMEOUT,
    },
  })
  const reg = { clientDataJSON: b64u(cred.response.clientDataJSON), authenticatorData: b64u(cred.response.getAuthenticatorData()) }
  const r = await post(kind === 'reset' ? ROUTES.reset : ROUTES.setup, { email: address, token, dirNonce, reg })
  return { ...r, credId: new Uint8Array(cred.rawId) }
}

/**
 * Proves an account on this host and remembers it. One `get` (discoverable,
 * or limited to `allow`, the credential a setup just made) over a fresh
 * directory challenge; the directory verifies the assertion against the
 * account's live passkeys and answers the account's address. Only that answer
 * is written, and only when it is `expect` (when given). THE ONLY WRITE of
 * ACCOUNT_KEY on this host.
 */
export async function signInHere({ allow, expect } = {}) {
  const c = await post(ROUTES.signinChallenge, {})
  const nonce = c.body.nonce
  if (c.status !== 200 || typeof nonce !== 'string' || !SEALED.test(nonce)) throw new Refused('directory')
  const cred = await navigator.credentials.get({
    publicKey: {
      rpId: RP_ID,
      challenge: unb64u(nonce),
      userVerification: 'required',
      allowCredentials: allow ? [{ type: 'public-key', id: allow }] : [],
      timeout: TIMEOUT,
    },
  })
  const r = await post(ROUTES.signin, { nonce, assertion: assertionOf(cred) })
  if (r.status !== 200) throw new Refused(typeof r.body.error === 'string' && /^[a-z-]{1,40}$/.test(r.body.error) ? r.body.error : 'refused')
  const a = r.body
  if (!isAddress(a.address)) throw new Refused('directory')
  if (expect !== undefined && a.address !== expect) throw new Refused('other-account')
  try { localStorage.setItem(ACCOUNT_KEY, a.address) } catch { throw new Refused('storage') }
  return a.address
}

/**
 * The text a member's passkey signs to sign every browser out of the account.
 * PROVISIONAL layout, to be replaced by the kernel's: `wout.` is not reserved
 * in kernel/src/statements.ts yet, and the directory answers 501 until it is.
 */
export function woutText({ address, at, nonce }) {
  return ['wout', b64u(new TextEncoder().encode(address)), String(at), nonce].join('.')
}

/** Sign out everywhere: a member's assertion over `wout.` for the account this host is signed in to. */
export async function signOutEverywhere(address) {
  const c = await post(ROUTES.signoutChallenge, { address })
  // the directory answers 501 here, before any passkey prompt, until it can sign browsers out
  if (c.status === 501) throw new Refused('not-implemented')
  const { nonce, at } = c.body
  if (c.status !== 200 || typeof nonce !== 'string' || !SEALED.test(nonce) || !Number.isSafeInteger(at) || at <= 0) {
    throw new Refused(c.status === 404 ? 'no-account' : 'directory')
  }
  const text = woutText({ address, at, nonce })
  const cred = await navigator.credentials.get({
    publicKey: { rpId: RP_ID, challenge: await challengeFor(text), userVerification: 'required', allowCredentials: [], timeout: TIMEOUT },
  })
  const r = await post(ROUTES.signout, { text, assertion: assertionOf(cred) })
  if (r.status !== 200 || r.body.ok !== true || !Number.isSafeInteger(r.body.at)) {
    throw new Refused(typeof r.body.error === 'string' && /^[a-z-]{1,40}$/.test(r.body.error) ? r.body.error : 'refused')
  }
  return r.body.at
}

/** A directory time as the mails write it: "2026-11-12 14:03 UTC". */
export const when = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
