// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE CONTRACT for the directory routes the sign-in host's own pages call
// (server/signin/public/account-client.js) and the directory does not have
// yet. The rigs run the pages against this stub; the directory's PR must
// answer exactly this, check in this order, and carry a rig row with a mutant
// for each numbered rule.
//
// Every route: POST, JSON body (sent as text/plain, no preflight), answers
// CORS for https://signin.id.bento.page alone (the /v1/web/* rule), and
// refuses a request whose browser-set Origin is anything else (403 origin).
// The Origin is hygiene; the passkey assertion is the gate.
//
// Challenges are the directory's sealed format (server/directory/src/
// challenge.js): 40 bytes, base64url, single use, 5 minutes. 40 bytes on
// purpose: a statement's WebAuthn challenge is its 32-byte SHA-256, so an
// assertion over a raw sealed challenge can never pass as one over a statement,
// nor the reverse. Each challenge carries an AUDIENCE ('signin', 'signout') and,
// for signout, the account's storage name; a challenge of another audience or
// account is refused, and it is spent first, so a refused request burns it.
//
// The account a discoverable passkey belongs to comes from its USER HANDLE: the
// sign-in host makes every passkey with user.id = SHA-256("bento-dir/1/addr\n"
// + address) (the account's storage name, server/directory/src/address.js) then
// 16 random bytes, 48 bytes in all. Native hosts that make passkeys for rp
// id.bento.page must use the same layout, or those passkeys cannot sign in on
// the sign-in host. The handle only ROUTES the request: membership is decided
// by the credential id and public key the account itself stores.
//
//   POST /v1/web/signin/challenge  {}                    → 200 {nonce}
//   POST /v1/web/signin            {nonce, assertion}    → 200 {address}
//     1. spend the nonce (unknown, expired, another audience → 400 nonce)
//     2. assertion shape; userHandle 48 bytes → else 400 assertion
//     3. the account named by the handle's first 32 bytes, the credential in
//        it, a live, unsuspended passkey member of the latest RIPENED head
//        → else 403 not-member (403 quarantined for a suspended one)
//     4. the kernel verifier: challenge = the nonce's 40 bytes, rp
//        id.bento.page, origin exactly the sign-in host, UP+UV, the stored
//        signature counter → else 400 assertion-<reason>; store the counter
//     5. answer the head's address. Nothing is logged, mailed or changed:
//        a sign-in on the host changes nothing at the directory.
//
//   POST /v1/web/signout/challenge {address}             → 200 {nonce, at}
//     no account → 404 (the roster lookup already says this; same per-IP limit)
//   POST /v1/web/signout           {text, assertion}     → 200 {ok: true, at}
//     text = wout.<b64u(address)>.<at>.<nonce>   (PROVISIONAL: the kernel's layout replaces it;
//                                                  until then the directory answers 501)
//     1. parse the text (exactly four fields) → else 400 text
//     2. spend the nonce: audience 'signout', the text's account, at equal to
//        the challenge's → else 400 nonce
//     3. the signer: the credential id names a live, unsuspended passkey
//        member of the account's latest ripened head → else 403 not-member / quarantined
//     4. the kernel verifier over SHA-256(text), as above → else 400 assertion-<reason>
//     5. revoke: every browser certificate (wdev.) of the account whose
//        ceremony time is at or before `at` is refused from now on (renewal
//        and check-in answer 403 revoked, so bento/home drops its keys), and
//        an enrolment whose challenge was issued at or before `at` is refused.
//        Apps' certificates (dev2.) are untouched.
//     6. log {k: 'signout-all', at, by: signer pub, os, co} and mail the address
//        (kind 'roster', never budgeted): every browser was signed out, when,
//        and by which passkey.
//     7. answer {ok: true, at}.
//   A member can sign everyone out at once, with no wait: it only takes power
//   away, and each browser signs in again with a passkey.

import { statementChallenge, verifyAssertion } from '../../kernel/src/webauthn.ts'
import { b64uDec, b64uEnc } from '../../kernel/src/statements.ts'

export const SIGNIN_ORIGIN = 'https://signin.id.bento.page'
export const RP_ID = 'id.bento.page'
export const CHALLENGE_TTL_MS = 5 * 60_000

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const keyOf = async (address) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bento-dir/1/addr\n' + address))))
const ASSERTION_KEYS = ['authenticatorData', 'clientDataJSON', 'id', 'signature', 'userHandle']
const B64U = /^[A-Za-z0-9_-]+$/

/**
 * `accounts(storageName)` → null | { address, members: [{kind, pub, quarantined}],
 *   credential(credIdB64u) → null | { pub, signCount }, setCount(pub, n) }
 * reads the directory's own record for an account (the rig backs it with the
 * real Roster object's storage).
 */
export function signinDirectory({ accounts, now = () => Date.now(), mail = () => {} }) {
  const nonces = new Map()
  const log = []
  const revoked = new Map() // address → at
  const mint = (aud, key) => {
    const n = b64uEnc(crypto.getRandomValues(new Uint8Array(40)))
    const at = now()
    nonces.set(n, { aud, key, at, exp: at + CHALLENGE_TTL_MS })
    return { n, at }
  }
  /** Spends `n` FIRST, whatever follows. */
  const spend = (n, aud, key) => {
    const c = typeof n === 'string' ? nonces.get(n) : undefined
    if (c) nonces.delete(n)
    return !!c && c.aud === aud && c.exp > now() && (key === undefined || c.key === key) ? c : null
  }
  const shapeOk = (a) => a && typeof a === 'object' && !Array.isArray(a) &&
    Object.keys(a).every((k) => ASSERTION_KEYS.includes(k)) &&
    ['id', 'authenticatorData', 'clientDataJSON', 'signature'].every((k) => typeof a[k] === 'string' && a[k].length > 0 && a[k].length <= 4096 && B64U.test(a[k]))
  async function member(acct, credId) {
    const c = acct && typeof credId === 'string' ? acct.credential(credId) : null
    const m = c && acct.members.find((x) => x.pub === c.pub)
    if (!m || m.kind !== 'pk') return { error: [403, 'not-member'] }
    if (m.quarantined) return { error: [403, 'quarantined'] }
    return { pub: c.pub, signCount: c.signCount }
  }
  async function verify(acct, signer, assertion, challenge) {
    const v = await verifyAssertion(assertion, { publicKey: signer.pub, challenge, rpId: RP_ID, origins: [SIGNIN_ORIGIN], storedSignCount: signer.signCount })
    if (!v.ok) return [400, `assertion-${v.reason}`]
    acct.setCount(signer.pub, v.value.signCount)
    return null
  }

  async function handle(path, { origin, body }) {
    if (!path.startsWith('/v1/web/signin') && !path.startsWith('/v1/web/signout')) return null
    if (origin !== SIGNIN_ORIGIN) return [403, { error: 'origin' }]
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null
    if (!b) return [400, { error: 'bad-request' }]

    if (path === '/v1/web/signin/challenge') return [200, { nonce: mint('signin').n }]

    if (path === '/v1/web/signin') {
      if (!spend(b.nonce, 'signin')) return [400, { error: 'nonce' }]
      const a = b.assertion
      if (!shapeOk(a)) return [400, { error: 'assertion' }]
      const handle = typeof a.userHandle === 'string' && B64U.test(a.userHandle) ? b64uDec(a.userHandle) : null
      if (!handle || handle.length !== 48) return [400, { error: 'assertion' }]
      const acct = await accounts(hex(handle.subarray(0, 32)))
      const s = await member(acct, a.id)
      if (s.error) return [s.error[0], { error: s.error[1] }]
      const bad = await verify(acct, s, a, b64uDec(b.nonce))
      if (bad) return [bad[0], { error: bad[1] }]
      return [200, { address: acct.address }]
    }

    if (path === '/v1/web/signout/challenge') {
      if (typeof b.address !== 'string') return [400, { error: 'bad-address' }]
      const key = await keyOf(b.address)
      if (!(await accounts(key))) return [404, { error: 'not-found' }]
      const { n, at } = mint('signout', key)
      return [200, { nonce: n, at }]
    }

    if (path === '/v1/web/signout') {
      const parts = typeof b.text === 'string' ? b.text.split('.') : []
      if (parts.length !== 4 || parts[0] !== 'wout' || !/^[1-9][0-9]{0,15}$/.test(parts[2])) return [400, { error: 'text' }]
      let address
      try { address = new TextDecoder('utf-8', { fatal: true }).decode(b64uDec(parts[1])) } catch { return [400, { error: 'text' }] }
      const key = await keyOf(address)
      const c = spend(parts[3], 'signout', key)
      if (!c || String(c.at) !== parts[2]) return [400, { error: 'nonce' }]
      const acct = await accounts(key)
      if (!acct || acct.address !== address) return [404, { error: 'not-found' }]
      const a = b.assertion
      if (!shapeOk(a)) return [400, { error: 'assertion' }]
      const s = await member(acct, a.id)
      if (s.error) return [s.error[0], { error: s.error[1] }]
      const bad = await verify(acct, s, a, await statementChallenge(b.text))
      if (bad) return [bad[0], { error: bad[1] }]
      const at = now()
      revoked.set(address, at)
      log.push({ k: 'signout-all', at, address, by: s.pub, os: origin })
      mail({ to: address, kind: 'roster', subject: 'Every browser was signed out of your bento/id account', at, by: s.pub })
      return [200, { ok: true, at }]
    }
    return [404, { error: 'not-found' }]
  }

  return { handle, log, revoked, nonces }
}
