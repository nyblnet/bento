// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// RETIRING A BROWSER KEY (option G; security's R2 on #949, D-W1 on #962).
//
// A browser's device key W renews its certificate by a `wren.` (browsers.js).
// When bento/home stops keeping or trusting W (a local sign-out, a key that
// turns out extractable, a new ceremony that replaced it) it signs the
// kernel's `wret.` with W itself, WITHOUT a successor, over a challenge of its
// own, and this directory refuses every later renewal of W. A copy of W taken
// earlier then dies when its last countersign expires (24 hours at most),
// instead of living to the 7-day cap.
//
// The routes (bento/home's, CORS to it alone, its Origin required):
//   POST /v1/home/retire/challenge {address} → 200 {nonce}; 404 no account
//   POST /v1/home/retire {wret, sig}
//     wret = wret.<oldDevicePub>..<b64u(address)>.<challenge>, signed by W
//     → 200 {ok: true, retiredAt}; 403 {error: unknown}; 400 {error: wret |
//       successor | nonce}
//
// The rules:
// - The challenge is sealed for its OWN audience, `retire`, so it is never a
//   renewal's or an enrolment's: used at the wrong door it is spent and
//   refused (browsers.js openBrowser), both ways. Asking for one costs a
//   per-IP lookup and one of that IP's retire challenges for that address,
//   as a renewal's does.
// - The kernel's verifyWret checks the text and W's signature BEFORE the
//   challenge is spent: only the browser that asked knows it, so a refused
//   signature leaves it for that browser.
// - Only the form WITHOUT a successor is accepted. A wret. naming a new key
//   is refused here (400 successor): no ceremony carries one, and bento/home
//   retires the old key by this form after a new ceremony instead.
// - W must be a browser key this address enrolled (its `wd:` record, or one
//   already retired). Anything else, a passkey's key or another account's
//   browser, is 403 unknown and nothing is written.
// - A retirement is stored as `rt:<W>` {retiredAt}, which the certificates'
//   sweep never deletes: a retired key stays retired for the life of the
//   account, so it can never enrol again, even after its certificate is gone.
//   Retiring a retired key answers 200 with the first time and writes nothing.
// - It is logged ({k: 'wret'}) and NOT mailed: it happens at every routine
//   sign-out and new sign-in. It revokes nothing else: no other certificate,
//   no sign-out cut-off, and a retired key's certificate reads `retired` on
//   the status route, never `revoked`, so peers never show a routine renewal
//   as a revocation. A REVOKED certificate still reads `revoked`.
// - A retirement is never a gate at a ceremony: an enrolment looks only at
//   its own new key, so a browser whose previous key is retired still signs in.
// - Nothing un-retires a key: not a suspension undone, not the lever.

import { verifyWret } from '../../../kernel/src/devices.ts'
import { addressKey, normalize } from './address.js'
import { issueChallenge } from './challenge.js'
import { HOME_ROUTES } from './seam.js'
import { HOME_ORIGIN } from './passkey.js'

const TEXT_MAX = 2048
const SIG_MAX = 256

/** When `pub` was retired at this address, or null. */
export async function retiredAt(s, pub) {
  const r = typeof pub === 'string' ? await s.get(`rt:${pub}`) : undefined
  return r && Number.isSafeInteger(r.retiredAt) ? r.retiredAt : null
}

/**
 * The two routes, from browsers.js browserRoute once Origin and body are
 * checked. `openBrowser(scope, challenge)` opens a browser challenge of any
 * audience (the object compares it after spending).
 */
export async function retireRoute(p, b, ip, env, k, openBrowser) {
  const { json, ledger, roster } = k
  if (p === HOME_ROUTES.retireChallenge) {
    const email = normalize(b.address)
    if (!email) return json(400, { error: 'bad-address' })
    if (!(await ledger(ip, 'lookup'))) return json(429, { error: 'rate-limited' })
    const scope = await addressKey(email)
    if (!(await ledger(`${ip}\n${scope}`, 'challengeAddrRetire'))) return json(429, { error: 'rate-limited' })
    const r = await roster(email, 'browserHead', {})
    if (r.status !== 200) return json(r.status, r.body)
    return json(200, { nonce: await issueChallenge(env.CHALLENGE_KEY, 'retire', scope, Date.now()) })
  }
  // HOME_ROUTES.retire
  if (typeof b.wret !== 'string' || typeof b.sig !== 'string' || b.wret.length > TEXT_MAX || b.sig.length > SIG_MAX) return json(400, { error: 'bad-request' })
  const v = await verifyWret(b.wret, b.sig)
  if (!v.ok) return json(400, { error: 'wret' })
  if (v.value.newPub !== null) return json(400, { error: 'successor' })
  const scope = await addressKey(v.value.address)
  const ch = await openBrowser(scope, v.value.dirNonce)
  if (!ch) return json(400, { error: 'nonce' })
  // counted once the signature verifies and the challenge is ours, per IP per address (as a check-in is)
  if (!(await ledger(`${ip}\n${scope}`, 'retire'))) return json(429, { error: 'rate-limited' })
  const r = await roster(v.value.address, 'browserRetire', { oldPub: v.value.oldPub, nonce: ch.nonce, issued: ch.issued, aud: ch.aud, os: HOME_ORIGIN })
  return json(r.status, r.body)
}

/** The op, in the address's object. */
export async function retireOp(obj, a, now, h) {
  const s = obj.state.storage
  const { spend, out } = h
  if (!(await spend())) return out(400, { error: 'nonce' })
  if (a.aud !== 'retire') return out(400, { error: 'nonce' }) // a renewal's or an enrolment's challenge, used up here
  const was = await retiredAt(s, a.oldPub)
  if (was !== null) return out(200, { ok: true, retiredAt: was })
  // a browser key this address enrolled, and nothing else
  if (typeof a.oldPub !== 'string' || !(await s.get(`wd:${a.oldPub}`))) return out(403, { error: 'unknown' })
  await s.put(`rt:${a.oldPub}`, { retiredAt: now })
  await obj.log({ k: 'wret', at: now, pub: a.oldPub, successor: '', os: h.origin, rq: '' })
  return out(200, { ok: true, retiredAt: now })
}
