// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/id directory — id.bento.page. Layer 1 of bento/id: it holds
// holder-published bindings "account key K belongs to the mailbox
// alice@example.com", each made with TWO proofs (a signature by K, and a code
// mailed to the address and entered in the holder's own agent), and answers
// exact-address lookups with a directory-signed attestation.
//
// It never holds a private key, a document, an access list, a share, or a
// "who looked up whom" log. No listing exists anywhere: storage is one Durable
// Object per address, named by a hash of the address, and nothing iterates
// them.
//
// Why a CODE and not a link: an attacker can start a binding of THEIR key to
// a victim's address. If clicking a mailed link completed it, the victim's
// click — or their mail provider's link scanner — would bind the attacker's
// key. Completion here needs the code AND a signature by the binding's own key
// over it, so neither half works alone.

import { addressKey, normalize } from './address.js'
import { issueChallenge, openChallenge, CHALLENGE_TTL_MS } from './challenge.js'
import { AUDIENCE, verifyDirConsent } from './consent.js'
import {
  attest, b64uDec, b64uEnc, buildCmp, buildDel, hashOf, importDirKey, tombstone as tombText, verifyBind, verifyCmp, verifyDel,
  dreqNeedsConsent, verifyDreq, verifyLinkRelease, verifyRotation,
} from './statements.js'
import { verifyAssertion } from './webauthn.js'
import { Link, linkRoute } from './link.js'
import { Account, keysRoute } from './account.js'

export { Account, Link }

/** A bind. statement's fields, or null. `at` is the time it is judged at: now
 *  for a new submission; for one the directory already accepted, the time it
 *  accepted it (that re-check is integrity, not freshness; expiry is checked
 *  separately, so an expired binding can still be read in order to delete it). */
async function readBind(text, sig, at) {
  const v = await verifyBind(text, sig, { now: at })
  return v.ok ? v.value : null
}

const sha256hex = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('')

export const LIMITS = {
  codeTtlMs: 20 * 60_000,
  codeAttempts: 5,
  mailCooldownMs: 60_000,
  mailPerDay: 3, // per ADDRESS: the mail-bombing control
  mailPerMonth: 10,
  ip: { start: 20, complete: 60, lookup: 300, delete: 20, challenge: 120, rotate: 20, linkOpen: 30, link: 600, keys: 60, recovery: 20 }, // per IP per hour
  rotationWindowMs: 72 * 3_600_000, // a pending rotation is contestable for 72 hours (security §25)
  setupMs: 15 * 60_000, // how long a two-proof bind may stand in for consent on the first passkey and code (§39.3)
  graceMs: 30 * 86_400_000, // how long after a vouched rotation settles the previous key's passkeys may still consent
  rekeyRetryMs: 3_600_000, // how soon the alarm retries a rekey that failed
  steps: 8, // earlier bindings served with a lookup, so a pinner a few steps behind can follow the chain
  freezeTokenTtlMs: 24 * 3_600_000, // an emailed freeze link stays usable for a day
  credFailures: 5, // consecutive WebAuthn failures before a credential locks
  credLockMs: 15 * 60_000,
  events: 20, // the short event list a status read returns (§9.7)
  // notice MAIL per address (the event list still records every event): one per
  // kind per hour, and a daily ceiling across kinds, so a notice can't be used
  // to mail-bomb an address from many IPs
  noticeKindMs: 3_600_000,
  unauthNoticesPerDay: 4, // the daily ceiling, for the kinds anyone can trigger (below)
}
const DAY = 86_400_000
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' // no 0/O, 1/I/L
/** the only ops a previous key's passkey may consent to, and only during the grace */
const GRACE_OPS = Object.freeze(['cred-add'])

const BASE = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  // Callers are the bento/home agents (extension, apps) and the deletion page.
  // Nothing here is authorised by origin or cookies: every write is a
  // signature or a mailed code, so any origin may call.
  'access-control-allow-origin': '*',
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: BASE })
/** A DO answer passed through; a deletion becomes 204 with no body (a 204 may not carry one). */
const relay = (r) => (r.status === 200 && r.body.deleted === true ? new Response(null, { status: 204, headers: BASE }) : json(r.status, r.body))

export function mintCode() {
  const r = crypto.getRandomValues(new Uint8Array(8))
  let s = ''
  for (const b of r) s += CODE_ALPHABET[b % 31] // 256 % 31 = 8: a bias under 0.4%, acceptable for a 20-minute, 5-try code
  return s
}
const codeOk = (c) => typeof c === 'string' && c.length === 8 && [...c].every((ch) => CODE_ALPHABET.includes(ch))

/** A freeze token: 32 random bytes, base64url. It travels only in a URL fragment. */
export const mintToken = () => b64uEnc(crypto.getRandomValues(new Uint8Array(32)))
const tokenOk = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t)

// The freeze confirmation page. Fixed text, no user content; the script reads
// the fragment and POSTs only when the button is pressed.
const FREEZE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Freeze bento/id keys</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1e2a3a;background:#fff}
button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:0;background:#b3261e;color:#fff;cursor:pointer}
button:disabled{opacity:.5}</style></head><body>
<h1>Freeze your bento/id keys?</h1>
<p>Do this if your devices were lost or stolen. Freezing stops every key linked to this address from working, so nobody can use them or change them.</p>
<p><strong>Only your recovery code can unfreeze it.</strong> Without one, the address stays frozen until it expires.</p>
<p><button id="go" type="button">Freeze my keys</button></p>
<p id="msg" role="status"></p>
<script src="/freeze.js"></script></body></html>`
const FREEZE_JS = `(() => {
  const q = new URLSearchParams(location.hash.slice(1)), go = document.getElementById('go'), msg = document.getElementById('msg')
  let email = ''
  try { email = new TextDecoder().decode(Uint8Array.from(atob((q.get('e') || '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))) } catch {}
  const token = q.get('t') || ''
  if (!email || !token) { go.disabled = true; msg.textContent = 'This link is incomplete. Open it again from the email.'; return }
  go.addEventListener('click', async () => {
    go.disabled = true
    const r = await fetch('/v1/freeze/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, token }) }).catch(() => null)
    msg.textContent = r && r.ok ? 'Frozen. Use your recovery code in bento/home to set up new keys.' : 'This link has expired or was already used.'
  })
})()`
const page = (text, type = 'text/html; charset=utf-8') => new Response(text, {
  status: 200,
  headers: {
    'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  },
})

/** Constant-time compare of two equal-length hex strings. */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// --- mail ----------------------------------------------------------------------
// The mail carries the code, the first 8 characters of the key's fingerprint
// and fixed wording — never user-supplied text (not even the display name), so
// the directory can never be used to deliver someone else's words.
export const freezeLink = (to, token) => `https://id.bento.page/freeze#e=${b64uEnc(new TextEncoder().encode(to))}&t=${token}`

// Every link, passkey change or fetch, recovery-code change and recovery attempt
// notifies the address (§9.3, §9.4, §39.1). Placeholder wording. The advice line
// is the one action that helps: freezing for a device or passkey, but for a
// recovery attempt a NEW recovery code, since a freeze neither stops a release
// nor allows the new code that does (rc-enrol is refused while frozen).
const FREEZE_ADVICE = 'If this was not you, open bento/home on one of your devices and freeze your keys.'
const RC_ADVICE = 'If this was not you, open bento/home on one of your devices and set a new recovery code. That cancels it. Do not freeze your keys: a freeze does not stop it, and blocks setting a new code.'
/** what the event list tells a device to offer for each kind (the notice's own advice) */
export const NOTICE_ACTION = Object.freeze({ 'rc-attempt': 'rc-enrol', 'rc-release': 'rc-enrol' })
/** Event kinds that need NO signature to trigger (anyone can try a recovery code).
 *  They are kept apart from the signed kinds, so they can neither push a link or
 *  a passkey fetch out of the event list nor spend its mail budget. */
export const UNAUTH_KINDS = Object.freeze(new Set(['rc-attempt', 'rc-release']))
export const NOTICES = Object.freeze({
  link: ['A device was linked to your bento/id', 'A new device was linked to the bento/id keys for this address (device key {fp}).'],
  'cred-add': ['A passkey was added to your bento/id', 'A passkey ({fp}) was added for getting the bento/id keys for this address onto a new device.'],
  'cred-del': ['A passkey was removed from your bento/id', 'A passkey ({fp}) was removed from the bento/id keys for this address.'],
  'cred-old-del': ['Your old bento/id passkeys were removed', 'The passkeys from before this address moved to a new key were removed, and no longer work. If you have no other passkey, verify this address again in bento/home to add one.'],
  'cred-fetch': ['Your bento/id passkey was used', 'A passkey ({fp}) was used to put the bento/id keys for this address on a device.'],
  'rc-enrol': ['Your bento/id recovery code changed', 'A new recovery code was set up for the bento/id keys for this address. Any earlier code no longer works.'],
  'cred-add-setup': ['A passkey was added to your bento/id', 'A first passkey ({fp}) was added while the bento/id keys for this address were being set up.'],
  'rc-enrol-setup': ['A recovery code was set up for your bento/id', 'A first recovery code was set up while the bento/id keys for this address were being set up.'],
  'rc-attempt': ['Your bento/id recovery code was tried', 'Someone entered a recovery code for this address. If it was right, the keys are released to them 72 hours later.'],
  'rc-release': ['Your bento/id recovery code was used', 'The recovery code for this address was used to collect its keys after the 72-hour wait, or someone tried to.'],
  contest: ['A key change for your bento/id was stopped', 'A device holding the previous key said a key change for this address was not theirs. The address is frozen until its recovery code is used.'],
  'freeze-owner': ['Your bento/id keys were frozen', 'A device holding the key for this address froze it. Only the recovery code can unfreeze it.'],
  resolve: ['Your bento/id address was unfrozen', 'The recovery code for this address was used to unfreeze it and move it to a new key ({fp}).'],
  'resolve-pending': ['Your bento/id address will move to a new key in 72 hours', 'The recovery code for this address was used to unfreeze it and move it to a new key ({fp}). The move happens in 72 hours. If this was not you, open bento/home on a device that still holds the frozen key and freeze it: that stops the move.'],
})

export async function sendCode(env, to, code, fp, kind, freezeToken = null) {
  let subject, body
  if (kind === 'freeze') {
    subject = 'Freeze your bento/id address'
    body = [
      'Someone asked to freeze the bento/id keys linked to this address.',
      '',
      'If your devices were lost or stolen, open this link and press the button to freeze them:',
      freezeLink(to, freezeToken),
      '',
      'Opening the link does nothing on its own. Once frozen, only your recovery code can unfreeze it.',
      'If you did not ask for this, ignore this email. The link expires in 24 hours.',
    ].join('\n')
  } else if (kind === 'rotate') {
    subject = 'Your bento/id key change code'
    body = [
      `Your code: ${code}`,
      '',
      `Enter it in bento/home on your own device to move this address to the new key ${fp}.`,
      'The change takes effect 72 hours after you enter the code. Until then, any of your devices can stop it.',
      'Bento will never ask for this code anywhere else. The code expires in 20 minutes.',
      '',
      'If you did not ask for this, someone may have your device. Freeze your keys here:',
      freezeLink(to, freezeToken),
      'Opening the link does nothing on its own. Once frozen, only your recovery code can unfreeze it.',
    ].join('\n')
  } else if (Object.hasOwn(NOTICES, kind)) {
    // a NOTICE: no code, fixed text, and at most a key fingerprint
    const [subj, line] = NOTICES[kind]
    subject = subj
    body = [
      line.replace('{fp}', fp),
      '',
      NOTICE_ACTION[kind] === 'rc-enrol' ? RC_ADVICE : FREEZE_ADVICE,
    ].join('\n')
  } else {
    subject = kind === 'delete' ? 'Your bento/id removal code' : 'Your bento/id code'
    body = [
      `Your code: ${code}`,
      '',
      kind === 'delete'
        ? 'Enter it on the bento/id account-deletion page to remove this address from the directory.'
        : `Enter it in bento/home on your own device to link this address to the key ${fp}.`,
      'Bento will never ask for this code anywhere else. If you did not ask for it, ignore this email.',
      'The code expires in 20 minutes.',
    ].join('\n')
  }
  if (env.MAILER && typeof env.MAILER.send === 'function') return env.MAILER.send({ to, subject, body, code, kind, freezeToken }) // the rig's seam
  if (env.MAILER === 'log' && env.DEV === '1') {
    console.log(JSON.stringify({ devmail: { to, subject, body } })) // local development only
    return
  }
  if (env.MAILER === 'ses') throw new Error('SES sending is not wired yet (needs the maintainer\'s SES account, M4)')
  throw new Error('no mailer configured')
}

// --- routes ----------------------------------------------------------------------

async function ledger(env, ip, kind) {
  const stub = env.LEDGER.get(env.LEDGER.idFromName('ledger'))
  const r = await (await stub.fetch('https://ledger/check', { method: 'POST', body: JSON.stringify({ ip, kind }) })).json()
  return r.ok
}

async function addressStub(env, email) {
  const key = await addressKey(email)
  return env.ADDRESS.get(env.ADDRESS.idFromName(key))
}
const call = async (stub, op, args) => {
  const r = await stub.fetch('https://address/op', { method: 'POST', body: JSON.stringify({ op, ...args }) })
  return { status: r.status, body: await r.json() }
}

/** Append to the address's event list (§9.7) and mail it, within the per-address
 *  notice cap; `mail: false` records the event only. Never fails the request. */
async function notify(env, scope, kind, fp, o = {}) {
  try {
    const setup = o.setup === true // done under the setup allowance: the event and the mail say so
    const r = await call(env.ADDRESS.get(env.ADDRESS.idFromName(scope)), 'event', { kind, fp, mail: o.mail !== false, setup })
    if (r.body.to) await sendCode(env, r.body.to, '', fp, setup ? `${kind}-setup` : kind)
  } catch (e) { console.log(`notice failed: ${e.message}`) }
}

/** Deleting an address takes its account material with it (§9.1): the passkeys
 *  and the ledger always; the recovery verifier only with a MAILBOX deletion,
 *  since a holder deletion keeps it for the deleted binding's window (§39.6). */
async function cascade(env, email, by, keepUntil) {
  if (!env.ACCOUNT) return
  const scope = await addressKey(email)
  const r = await call(env.ACCOUNT.get(env.ACCOUNT.idFromName(scope)), 'wipe', { keepRc: by === 'holder', keepUntil })
  for (const k of r.body.creds || []) await call(env.CRED.get(env.CRED.idFromName(k)), 'delete', { scope })
}

async function body(req) {
  try { const j = await req.json(); return j && typeof j === 'object' ? j : null } catch { return null }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...BASE, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' },
      })
    }
    const ip = req.headers.get('cf-connecting-ip') || '0.0.0.0'
    const p = url.pathname

    if (p === '/v1/keys' && req.method === 'GET') {
      return json(200, { keys: JSON.parse(env.DIR_PUBKEYS || '[]') })
    }

    if (p === '/v1/lookup' && req.method === 'GET') {
      const email = normalize(url.searchParams.get('e') ?? '')
      if (!email) return json(400, { error: 'bad-address' })
      if (!(await ledger(env, ip, 'lookup'))) return json(429, { error: 'rate-limited' })
      const r = await call(await addressStub(env, email), 'lookup', {})
      return json(r.status, r.body)
    }

    // The emailed freeze link opens this page. A GET never changes anything
    // (mail scanners pre-fetch links); the page's button makes the POST, and the
    // token rides in the URL fragment, which no server or log ever sees.
    if (p === '/freeze' && req.method === 'GET') return page(FREEZE_HTML)
    if (p === '/freeze.js' && req.method === 'GET') return page(FREEZE_JS, 'text/javascript')

    if (req.method !== 'POST') return json(404, { error: 'not-found' })
    const b = await body(req)
    if (!b) return json(400, { error: 'bad-request' })

    const deps = { json, ledger, addressCall: call, notify: (scope, kind, fp, o) => notify(env, scope, kind, fp, o) }
    const routed = (await linkRoute(p, b, env, ip, deps)) ?? (await keysRoute(p, b, env, ip, deps))
    if (routed) return routed

    if (p === '/v1/bind/start') {
      // ALWAYS 202 from here on, whatever happens: the answer must not reveal
      // whether the address exists, is rate-limited, or was mailed.
      const binding = await readBind(b.stmt, b.sig, Date.now())
      if (!binding) return json(400, { error: 'bad-statement' }) // reveals nothing about the address
      const email = normalize(binding.address)
      if (!email || email !== binding.address) return json(400, { error: 'bad-address' })
      if (!(await ledger(env, ip, 'start'))) return json(202, { ok: true })
      const r = await call(await addressStub(env, email), 'start', { stmt: b.stmt, sig: b.sig })
      if (r.body.mail) {
        try { await sendCode(env, email, r.body.mail.code, r.body.mail.fp, 'bind') } catch (e) { console.log(`mail failed: ${e.message}`) }
      }
      return json(202, { ok: true })
    }

    if (p === '/v1/bind/complete') {
      const email = normalize(b.email ?? '')
      if (!email || !codeOk(b.code) || typeof b.sig !== 'string') return json(400, { error: 'invalid' })
      if (!(await ledger(env, ip, 'complete'))) return json(429, { error: 'rate-limited' })
      const r = await call(await addressStub(env, email), 'complete', { code: b.code, sig: b.sig })
      return json(r.status, r.body)
    }

    // a host whose check of the bind answer failed (an attestation it could not
    // verify, a lost reply) asks again: the same answer, for EXACTLY the statement
    // it bound, so setup can resume without a second email. It reveals nothing a
    // lookup does not, and changes nothing.
    if (p === '/v1/bind/check') {
      const binding = await readBind(b.stmt, b.sig, Date.now())
      if (!binding) return json(400, { error: 'bad-statement' })
      const email = normalize(binding.address)
      if (!email || email !== binding.address) return json(400, { error: 'bad-address' })
      if (!(await ledger(env, ip, 'lookup'))) return json(429, { error: 'rate-limited' })
      const r = await call(await addressStub(env, email), 'recheck', { stmt: b.stmt, sig: b.sig })
      return json(r.status, r.body)
    }

    if (p === '/v1/delete') {
      const email = normalize(b.email ?? '')
      if (!email || typeof b.sig !== 'string') return json(400, { error: 'invalid' })
      if (!(await ledger(env, ip, 'delete'))) return json(429, { error: 'rate-limited' })
      const r = await call(await addressStub(env, email), 'delete', { ts: b.ts, sig: b.sig, scope: await addressKey(email) })
      if (r.status === 200 && r.body.deleted) await cascade(env, email, 'holder', r.body.keepUntil)
      return relay(r)
    }

    if (p === '/v1/delete/start') {
      const email = normalize(b.email ?? '')
      if (!email) return json(400, { error: 'bad-address' })
      if (!(await ledger(env, ip, 'start'))) return json(202, { ok: true })
      const r = await call(await addressStub(env, email), 'deleteStart', {})
      if (r.body.mail) {
        try { await sendCode(env, email, r.body.mail.code, '', 'delete') } catch (e) { console.log(`mail failed: ${e.message}`) }
      }
      return json(202, { ok: true })
    }

    if (p === '/v1/delete/complete') {
      const email = normalize(b.email ?? '')
      if (!email || !codeOk(b.code)) return json(400, { error: 'invalid' })
      if (!(await ledger(env, ip, 'complete'))) return json(429, { error: 'rate-limited' })
      const r = await call(await addressStub(env, email), 'deleteComplete', { code: b.code })
      if (r.status === 200 && r.body.deleted) await cascade(env, email, 'mailbox', 0)
      return relay(r)
    }

    // --- consent challenges (audience `dir`, §9.6c) --------------------------------
    // Issued to anyone for any well-formed address: a challenge reveals nothing,
    // is stored nowhere, and is good only at that address for 60 seconds.
    if (p === '/v1/challenge') {
      const email = normalize(b.email ?? '')
      if (!email) return json(400, { error: 'bad-address' })
      if (!(await ledger(env, ip, 'challenge'))) return json(429, { error: 'rate-limited' })
      const challenge = await issueChallenge(env.CHALLENGE_KEY, AUDIENCE, await addressKey(email), Date.now())
      return json(200, { challenge, audience: AUDIENCE, ttlMs: CHALLENGE_TTL_MS })
    }

    // --- rotation (security §25: active → pending 72 h → active) -----------------
    // OFF unless ROTATION=1, which waits on a security run of the contest below:
    // a pending window is only safe when a device holding the old key can stop it.
    if (p === '/v1/rotate/start' || p === '/v1/rotate/complete') {
      if (env.ROTATION !== '1') return json(404, { error: 'not-found' })
      if (p === '/v1/rotate/start') {
        const binding = await readBind(b.stmt, b.sig, Date.now())
        if (!binding) return json(400, { error: 'bad-statement' })
        const email = normalize(binding.address)
        if (!email || email !== binding.address) return json(400, { error: 'bad-address' })
        const scope = await addressKey(email)
        const ch = await openChallenge(env.CHALLENGE_KEY, AUDIENCE, scope, b.challenge, Date.now())
        if (!ch) return json(400, { error: 'invalid', reason: 'challenge' })
        if (!(await ledger(env, ip, 'rotate'))) return json(429, { error: 'rate-limited' })
        const r = await call(env.ADDRESS.get(env.ADDRESS.idFromName(scope)), 'rotateStart', {
          stmt: b.stmt, sig: b.sig, rot: b.rot, rotSig: b.rotSig, challenge: b.challenge, nonce: ch.nonce, scope, consent: b.consent,
        })
        if (r.body.mail) {
          try { await sendCode(env, email, r.body.mail.code, r.body.mail.fp, 'rotate', r.body.mail.freezeToken) } catch (e) { console.log(`mail failed: ${e.message}`) }
          return json(202, { ok: true })
        }
        return json(r.status, r.body)
      }
      const email = normalize(b.email ?? '')
      if (!email || !codeOk(b.code) || typeof b.sig !== 'string') return json(400, { error: 'invalid' })
      if (!(await ledger(env, ip, 'complete'))) return json(429, { error: 'rate-limited' })
      const r = await call(await addressStub(env, email), 'rotateComplete', { code: b.code, sig: b.sig })
      return json(r.status, r.body)
    }

    // --- requests signed by the account key (dreq., security §39.3) ---------------
    // contest: "this wasn't me", only while a rotation is pending, signed by the key
    // the directory still serves (the OLD one), or during the §39.6 window by the
    // key of a binding its holder deleted. freeze: the owner's lost-or-stolen
    // report, active or pending. Neither needs consent: both only remove power.
    if (p === '/v1/contest' || p === '/v1/freeze') {
      const email = normalize(b.email ?? '')
      if (!email || typeof b.req !== 'string' || typeof b.sig !== 'string') return json(400, { error: 'invalid' })
      if (!(await ledger(env, ip, 'rotate'))) return json(429, { error: 'rate-limited' })
      const scope = await addressKey(email)
      const ch = await openChallenge(env.CHALLENGE_KEY, AUDIENCE, scope, b.challenge, Date.now())
      if (!ch) return json(400, { error: 'invalid', reason: 'challenge' })
      const op = p === '/v1/contest' ? 'contest' : 'freeze'
      const r = await call(env.ADDRESS.get(env.ADDRESS.idFromName(scope)), 'authorize', {
        nonce: ch.nonce, challenge: b.challenge, req: b.req, sig: b.sig, subject: { op }, consent: null, scope,
        bind: typeof b.bind === 'string' ? b.bind : null,
      })
      if (r.status !== 200) return json(r.status, r.body)
      await notify(env, scope, op === 'contest' ? 'contest' : 'freeze-owner', '')
      return json(200, { state: r.body.state })
    }

    // --- resolving a freeze with the recovery code (security §39.3) ---------------
    // The recovering device brings a NEW binding (self-signed, chained to the frozen
    // one) and the recovery verifier. No old-key signature exists in this case, so
    // pinners warn, as intended; no consent either: the typed code is the presence.
    if (p === '/v1/resolve') {
      const binding = await readBind(b.stmt, b.sig, Date.now())
      if (!binding) return json(400, { error: 'bad-statement' })
      const email = normalize(binding.address)
      if (!email || email !== binding.address) return json(400, { error: 'bad-address' })
      const v = typeof b.verifier === 'string' ? b64uDec(b.verifier) : null
      if (!v || v.length !== 32 || b64uEnc(v) !== b.verifier) return json(400, { error: 'invalid' })
      if (!env.ACCOUNT) return json(404, { error: 'not-found' })
      if (!(await ledger(env, ip, 'recovery'))) return json(429, { error: 'rate-limited' })
      const scope = await addressKey(email)
      const addr = env.ADDRESS.get(env.ADDRESS.idFromName(scope))
      const prep = await call(addr, 'resolvePrep', { stmt: b.stmt, sig: b.sig })
      if (prep.status !== 200) return json(prep.status, prep.body)
      const rc = await call(env.ACCOUNT.get(env.ACCOUNT.idFromName(scope)), 'rcResolve', { accountPub: prep.body.key, verifier: b.verifier })
      if (rc.body.notify) await notify(env, scope, rc.body.notify, '')
      if (rc.status !== 200) return json(rc.status, { error: 'invalid', reason: rc.body.reason })
      // re-checked: the address may have moved while the code was checked
      const r = await call(addr, 'resolve', { stmt: b.stmt, sig: b.sig, key: prep.body.key, young: rc.body.young === true })
      // a key-holder freeze resolves at once; an EMAIL-ONLY or CONTESTED one, or any
      // resolved by a code younger than 72 h, waits 72 h (202), so a device still
      // holding the frozen key can stop it (code + mailbox alone is no takeover, and
      // neither is a code enrolled just now). The code is spent only when it commits.
      if (r.status === 200 || r.status === 202) await notify(env, scope, r.status === 200 ? 'resolve' : 'resolve-pending', (await hashOf(binding.accountPub)).slice(0, 8))
      return json(r.status, r.body)
    }

    // --- the email-only freeze (security §25) -----------------------------------
    if (p === '/v1/freeze/start') {
      const email = normalize(b.email ?? '')
      if (!email) return json(400, { error: 'bad-address' })
      if (!(await ledger(env, ip, 'start'))) return json(202, { ok: true })
      const r = await call(await addressStub(env, email), 'freezeStart', {})
      if (r.body.mail) {
        try { await sendCode(env, email, '', '', 'freeze', r.body.mail.freezeToken) } catch (e) { console.log(`mail failed: ${e.message}`) }
      }
      return json(202, { ok: true }) // whether or not anything was mailed
    }

    if (p === '/v1/freeze/complete') {
      const email = normalize(b.email ?? '')
      if (!email || !tokenOk(b.token)) return json(400, { error: 'invalid' })
      if (!(await ledger(env, ip, 'complete'))) return json(429, { error: 'rate-limited' })
      const r = await call(await addressStub(env, email), 'freezeComplete', { token: b.token })
      return json(r.status, r.body)
    }

    return json(404, { error: 'not-found' })
  },
}

// --- one Durable Object per ADDRESS ------------------------------------------------
// Storage: `cur` (the live binding: exact statement text, holder signature,
// attestation inputs; after a rotation also `rot`/`rotSig`, the PREVIOUS key's
// vouch `rot.<sha256(this)>.<sha256(previous)>`), `steps` (the last few earlier
// bindings with their vouches, served so a pinner a few steps behind can follow),
// `chain` (hashes of every earlier binding for this address), `pend` (a pending
// code), `mail` (send times, for the per-address limits), `tomb` (a signed
// deletion), `htomb` (what a HOLDER deletion keeps for the deleted binding's
// window, §39.6: its hash, key, seq, expiry and the Account object's name, never
// the address), and the binding STATE (security §25): `rot` (a pending rotation:
// the next binding, contestable until `until`), `frz` (a freeze, naming the
// binding it froze), `fpend` (an emailed freeze token), `spent` (consent
// challenges already used here), `setup` (the first-credential allowance: the
// bind that armed it, when it ends, the ops left), `grace` (after a settled vouched
// rotation: the previous key, the key it moved to, when the previous key's passkeys
// stop consenting, the Account object's name), `rekey` (a deletion of old passkeys
// not yet finished: what stays, and the Cred objects still to delete). Strongly consistent per address, so a re-bind,
// a rotation and a lookup can never race into a mixed answer.
//
// States: active (no `rot`, no `frz`) · pending (`rot`) · frozen (`frz`).
// A pending rotation becomes active LAZILY, on the first request after its 72
// hours, so no timer is needed to be right; the answer is the same either way.
//
// The §39.6 window: a holder delete must not shorten the protection the binding
// had. Until the deleted binding's own expiry, a DIFFERENT key re-binding the
// address enters `pending` for the full 72 hours (lookups keep answering the
// tomb), and the tombstoned key may contest it. The same key re-binds at once.

export class Address {
  constructor(state, env) { this.state = state; this.env = env }

  async fetch(req) {
    const a = await req.json()
    const now = Date.now()
    const s = this.state.storage
    const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const refuse = (reason) => out(400, { error: 'invalid', reason })

    // may we mail this address now? (per-address limits; recorded only when a mail is actually sent)
    const mayMail = async () => {
      const times = ((await s.get('mail')) || []).filter((t) => now - t < 31 * DAY)
      if (times.length && now - times[times.length - 1] < LIMITS.mailCooldownMs) return false
      if (times.filter((t) => now - t < DAY).length >= LIMITS.mailPerDay) return false
      if (times.length >= LIMITS.mailPerMonth) return false
      await s.put('mail', [...times, now])
      return true
    }
    const pending = async (kind) => {
      const p = await s.get('pend')
      if (!p || p.kind !== kind || p.expires <= now || p.attempts >= LIMITS.codeAttempts) return null
      return p
    }
    const codeHash = (code) => sha256hex(`bento-dir/1/code\n${code}`)
    const tokenHash = (t) => sha256hex(`bento-dir/1/freeze\n${t}`)
    const fail = async (p) => { p.attempts++; await s.put('pend', p); return out(400, { error: 'invalid' }) }
    /** the retained recovery verifier of a deleted binding goes once its window has
     *  closed (dropOld), or is the live one again when the same key re-binds (rcKeep) */
    const rcCall = async (ht, op) => {
      if (!ht || !ht.scope || !this.env.ACCOUNT) return
      try {
        await this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(ht.scope)).fetch('https://account/op', { method: 'POST', body: JSON.stringify({ op, accountPub: ht.key }) })
      } catch (e) { console.log(`${op} failed: ${e.message}`) }
    }
    /** record what must go BEFORE trying, so a failure or a crash leaves a task, not a
     *  stranded key: a passkey left behind would fill the new key's empty slot. The newest
     *  `keep` is the truth; the Cred objects an earlier try still owes stay owed. */
    const queueRekey = async (scope, keep, o = {}) => {
      const t = await s.get('rekey')
      await s.put('rekey', { scope, keep, rc: o.rc === true || t?.rc === true, notice: o.notice === true || t?.notice === true, creds: t?.creds ?? [] })
    }
    /** one try, from the record: at once, at the next authorize, and from the alarm */
    const runRekey = async () => {
      const t = await s.get('rekey')
      if (!t) return
      try {
        const r = await call(this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(t.scope)), 'rekey', { keep: t.keep, rc: t.rc })
        // the Account's list is gone now: this record is the only memory of these
        const creds = [...new Set([...t.creds, ...r.body.creds])]
        await s.put('rekey', { ...t, creds })
        // a call that fails throws; `unknown` only means an earlier try got this one
        for (const k of creds) await call(this.env.CRED.get(this.env.CRED.idFromName(k)), 'delete', { scope: t.scope })
        await s.delete('rekey')
        if (t.notice && creds.length) await oldCredsGone()
      } catch (e) {
        console.log(`rekey failed: ${e.message}`)
        await s.setAlarm(now + LIMITS.rekeyRetryMs)
      }
    }
    /** the notice for a grace's end. Called from here, not the worker, since the alarm
     *  can get here with no request. One per settled rotation, so it needs no mail cap. */
    const oldCredsGone = async () => {
      await s.put('events', [...((await s.get('events')) || []), { k: 'cred-old-del', at: now, fp: '' }].slice(-LIMITS.events))
      const c = await s.get('cur')
      const b = c && (await readBind(c.stmt, c.sig, c.verifiedAt))
      if (b) { try { await sendCode(this.env, b.address, '', '', 'cred-old-del') } catch (e) { console.log(`notice failed: ${e.message}`) } }
    }
    /** the rotation grace is over: the previous key's passkeys go, with a notice. Its
     *  code slot stays as it is: the setup allowance never replaces a code (rule 5). */
    const endGrace = async (g) => {
      await s.delete('grace')
      await queueRekey(g.scope, [g.next], { notice: true })
      await runRekey()
    }
    /** a REBOUND: the address moved to a key with no vouch from the old one, so
     *  nothing of the old key's may stay, its recovery record and its passkeys
     *  together, and it gets no grace. */
    const dropOld = async (address, accountPub) => {
      if (!this.env.ACCOUNT) return
      await s.delete('grace')
      await queueRekey(await addressKey(address), [accountPub], { rc: true })
      await runRekey()
    }
    /** arm the setup allowance (§39.3), after a bind landed `active`: only for a key
     *  that has NEVER had a credential or a code. Any doubt leaves it unarmed. */
    const armSetup = async (address, accountPub, h) => {
      if (!this.env.ACCOUNT) return
      try {
        const r = await call(this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(await addressKey(address))), 'everHad', { accountPub })
        if (r.status === 200 && r.body.ever === false) await s.put('setup', { h, until: now + LIMITS.setupMs, ops: ['cred-add', 'rc-enrol'] })
      } catch (e) { console.log(`setup not armed: ${e.message}`) }
    }
    /** use the allowance for one op: armed, unexpired, naming the binding served, and
     *  that op unused (`active` is verifyDreq's, already run: these ops are refused
     *  in any other state). Consumed here, before anything else can run. */
    const useSetup = async (op, cur) => {
      const su = await s.get('setup')
      if (!su || su.until <= now || su.h !== cur?.h || !su.ops.includes(op)) return false
      const ops = su.ops.filter((x) => x !== op)
      if (ops.length) await s.put('setup', { ...su, ops }); else await s.delete('setup')
      return true
    }
    /** a binding that is replaced keeps serving as a step, while the chain is unbroken */
    const stepOf = (c) => ({ binding: c.stmt, sig: c.sig, ...(c.rot ? { rot: c.rot, rotSig: c.rotSig } : {}) })
    const keepStep = async (c) => s.put('steps', [...((await s.get('steps')) || []), stepOf(c)].slice(-LIMITS.steps))

    // a pending rotation whose 72 hours passed uncontested becomes the binding
    const settle = async () => {
      const rot = await s.get('rot')
      if (!rot || now < rot.until || (await s.get('frz'))) return
      const cur = await s.get('cur')
      if (rot.overTomb) {
        // a new key over a holder tomb (§39.6): no vouch exists, so pinners warn
        const ht = await s.get('htomb')
        if (ht) await s.put('chain', [...((await s.get('chain')) || []), ht.h])
        await s.put('cur', { stmt: rot.stmt, sig: rot.sig, h: rot.h, b: rot.b, verifiedAt: rot.at, rebound: true })
        await s.delete(['rot', 'fpend', 'htomb', 'tomb', 'steps'])
        const nb = await readBind(rot.stmt, rot.sig, rot.at)
        if (nb) await dropOld(nb.address, rot.b.key)
        return
      }
      if (cur) { await s.put('chain', [...((await s.get('chain')) || []), cur.h]); await keepStep(cur) }
      await s.put('cur', { stmt: rot.stmt, sig: rot.sig, rot: rot.rotText, rotSig: rot.rotSig, h: rot.h, b: rot.b, verifiedAt: rot.at, rebound: false })
      await s.delete(['rot', 'fpend'])
      const nb = await readBind(rot.stmt, rot.sig, rot.at)
      if (!this.env.ACCOUNT || !cur || !nb) return
      // the grace counts from the settle time, not from whichever request found it
      const scope = await addressKey(nb.address), was = await s.get('grace'), until = rot.until + LIMITS.graceMs
      await s.put('grace', { key: cur.b.key, next: rot.b.key, until, scope })
      await s.setAlarm(until)
      // only the IMMEDIATELY previous key's passkeys: anything older goes now
      if (was || (await s.get('rekey'))) {
        await queueRekey(scope, [cur.b.key, rot.b.key], { notice: !!was })
        await runRekey()
      }
    }
    await settle()
    const live = async () => { const c = await s.get('cur'); return c && c.b.expires > now ? c : null }
    /** the frozen binding is still the one protecting the address */
    const frozenHolds = async (base) => {
      const cur = await live()
      const ht = base.tomb ? await s.get('htomb') : null
      return base.tomb ? !cur && !!ht && ht.h === base.h && ht.expires > now : !!cur && cur.h === base.h
    }
    /** a resolution commits: the new binding, self-signed, no vouch (pinners warn, §39.3).
     *  This, and only this, spends the recovery code that resolved it (§28a): a
     *  resolution that waits and is voided leaves the code usable. It arms nothing:
     *  a new key's first passkey takes a fresh email proof. */
    const commitResolve = async (stmt, sig, h, b, base) => {
      await s.put('chain', [...((await s.get('chain')) || []), base.h])
      await s.put('cur', { stmt, sig, h, b: { key: b.accountPub, seq: b.seq, expires: b.expires }, verifiedAt: now, rebound: true })
      await s.delete(['frz', 'rot', 'pend', 'fpend', 'htomb', 'tomb', 'steps', 'rsv'])
      await dropOld(b.address, b.accountPub)
    }
    // an email-only freeze's resolution whose 72 hours passed without the frozen
    // key stopping it (ruling b). Lazily, like a rotation; the event is recorded
    // here, with no mail (nothing calls out from this point; the start was mailed).
    {
      const rsv = await s.get('rsv'), frz = await s.get('frz')
      // (a freeze or contest by the frozen key deletes `rsv`: see freeze())
      if (rsv && now >= rsv.until) {
        const b = await readBind(rsv.stmt, rsv.sig, now)
        if (b && frz && frz.base && (await frozenHolds(frz.base))) {
          await commitResolve(rsv.stmt, rsv.sig, rsv.h, b, frz.base)
          await s.put('events', [...((await s.get('events')) || []), { k: 'resolve', at: now, fp: (await hashOf(b.accountPub)).slice(0, 8) }].slice(-LIMITS.events))
        } else await s.delete('rsv') // the frozen binding expired, or the new one did: nothing to move
      }
    }
    // the grace lapses here and nowhere else, so nothing below needs to read its time
    {
      const g = await s.get('grace')
      if (g && now >= g.until) await endGrace(g)
    }
    const stateOf = async () => ((await s.get('frz')) ? 'frozen' : (await s.get('rot')) ? 'pending' : 'active')
    /** the holder tomb, while it still protects the address: before the deleted
     *  binding's own expiry, or while a re-bind over it is pending or frozen */
    const guardTomb = async () => {
      const ht = await s.get('htomb')
      if (!ht) return null
      if (ht.expires > now) return ht
      const rot = await s.get('rot'), frz = await s.get('frz')
      if ((rot && rot.overTomb) || (frz && frz.base && frz.base.h === ht.h && frz.base.tomb && ht.expires > now)) return ht
      return null
    }
    const freeze = async (by) => {
      const cur = await live()
      const rot = await s.get('rot')
      const ht = !cur && rot && rot.overTomb ? await s.get('htomb') : null
      const base = cur ? { h: cur.h, key: cur.b.key, seq: cur.b.seq } : ht ? { h: ht.h, key: ht.key, seq: ht.seq, tomb: true } : null
      // a freeze that VOIDS a waiting resolution marks the freeze CONTESTED: the code
      // has been in two hands, so no later resolution of it is instant, even though
      // the frozen key froze it (the owner-wins sequence, security §39.3). A frozen
      // address takes a freeze only while `rsv` waits, so every re-freeze is a void.
      const contested = !!(await s.get('rsv'))
      await s.put('frz', { at: now, by, base, ...(contested ? { contested: true } : {}) })
      await s.delete(['rot', 'pend', 'fpend', 'rsv', 'setup']) // a freeze ends any rotation, resolution or setup in flight
      const g = await s.get('grace')
      if (g) await endGrace(g) // and any grace: a key reported lost keeps nothing a renewal could pick up later
    }
    /** spend a consent challenge HERE, before anything else is checked (§24b: spend-first) */
    const spend = async (nonce) => {
      const spent = Object.fromEntries(Object.entries((await s.get('spent')) || {}).filter(([, t]) => t > now))
      if (typeof nonce !== 'string' || Object.hasOwn(spent, nonce)) return false
      spent[nonce] = now + 2 * CHALLENGE_TTL_MS
      await s.put('spent', spent)
      return true
    }

    if (a.op === 'start') {
      if (!(await mayMail())) return out(202, { mail: null })
      const b = await readBind(a.stmt, a.sig, now)
      if (!b) return out(202, { mail: null })
      const cur = await live()
      // a LIVE binding never moves to another key by email alone (security §25):
      // that is the 72-hour contestable rotation. And while it is pending or
      // frozen, nothing renews it either: neither key is honoured in a freeze.
      if (cur && (cur.b.key !== b.accountPub || (await stateOf()) !== 'active')) return out(202, { mail: null })
      // over a protecting holder tomb, one re-bind at a time, and none out of a freeze
      if (!cur && (await guardTomb()) && (await stateOf()) !== 'active') return out(202, { mail: null })
      const code = mintCode()
      await s.put('pend', { kind: 'bind', stmt: a.stmt, sig: a.sig, codeHash: await codeHash(code), expires: now + LIMITS.codeTtlMs, attempts: 0 })
      return out(202, { mail: { code, fp: (await hashOf(b.accountPub)).slice(0, 8) } })
    }

    if (a.op === 'complete') {
      const p = await pending('bind')
      if (!p) return out(400, { error: 'invalid' })
      const b = await readBind(p.stmt, p.sig, now) // re-verified, and still within its lifetime
      const h = await hashOf(p.stmt)
      if (!b || !same(await codeHash(a.code), p.codeHash)) return fail(p)
      if (!(await verifyCmp(buildCmp(h, a.code), a.sig, { accountPub: b.accountPub, bindText: p.stmt })).ok) return fail(p)
      // sequence rules against what is live now
      const cur = await s.get('cur')
      const lv = cur && cur.b.expires > now ? cur : null
      const ht = await s.get('htomb')
      const guard = lv ? null : await guardTomb()
      const continues = (x) => !!x && b.seq === x.seq + 1 && b.prev === x.h
      if (lv) {
        if (b.accountPub !== lv.b.key) return fail(p) // re-checked: it may have gone live since start
        if ((await stateOf()) !== 'active') return fail(p) // pending or frozen since start
        if (b.seq !== lv.b.seq + 1 || b.prev !== lv.h) return fail(p)
      } else if (guard) {
        if ((await stateOf()) !== 'active') return fail(p) // a re-bind over the tomb is already pending, or frozen
        if (b.seq !== 1 && !continues(guard)) return fail(p)
        if (b.accountPub !== guard.key) {
          // a DIFFERENT key inside the deleted binding's window: a rotation in all
          // but the old-key vouch (§39.6), so it waits out the full contest window
          await s.put('rot', { stmt: p.stmt, sig: p.sig, h, b: { key: b.accountPub, seq: b.seq, expires: b.expires }, at: now, until: now + LIMITS.rotationWindowMs, overTomb: true })
          await s.delete('pend') // it ended `pending`: nothing arms
          return out(200, { state: 'pending', activeAt: now + LIMITS.rotationWindowMs, rebound: true })
        }
      } else if (b.seq !== 1 && !continues(cur && { seq: cur.b.seq, h: cur.h }) && !continues(ht)) {
        return fail(p) // a fresh start is seq 1; an expired or deleted binding may also be continued
      }
      // a new key over an EXPIRED or deleted binding, proven by email alone: pinners warn
      const prevKey = cur ? cur.b.key : ht ? ht.key : null
      const rebound = !!prevKey && prevKey !== b.accountPub
      const dirKey = await importDirKey(this.env.DIR_KEY_JWK)
      const att = await attest(dirKey, this.env.DIR_KID, h, now, now)
      if (cur || ht) await s.put('chain', [...((await s.get('chain')) || []), cur ? cur.h : ht.h])
      if (rebound) await s.delete('steps')
      else if (cur && b.prev === cur.h) await keepStep(cur)
      // `b` keeps only what the service needs between requests — NOT the address
      // or the name, which live once, inside the signed statement it serves
      await s.put('cur', { stmt: p.stmt, sig: p.sig, h, b: { key: b.accountPub, seq: b.seq, expires: b.expires }, verifiedAt: now, rebound })
      // over an expired binding, whatever state it was in goes with it
      await s.delete(['pend', 'tomb', 'htomb', 'rot', 'frz', 'fpend', 'rsv', 'setup'])
      if (rebound) await dropOld(b.address, b.accountPub)
      else if (guard && ht) await rcCall(ht, 'rcKeep') // the same key, inside the window: its code is current again
      await armSetup(b.address, b.accountPub, h) // both proofs just landed: the only thing that arms it
      return out(200, { binding: p.stmt, sig: p.sig, attestation: att.text, attestationSig: att.sig, rebound })
    }

    if (a.op === 'lookup') {
      const cur = await live()
      if (cur) {
        // a FRESH issuedAt on every answer, so a client can tell a replayed old
        // answer by age; the STATE is inside the signature. While pending, this is
        // the OLD binding and pins do not move; while frozen, no ✓ and nothing is
        // wrapped to either key.
        const state = await stateOf()
        const dirKey = await importDirKey(this.env.DIR_KEY_JWK)
        const att = await attest(dirKey, this.env.DIR_KID, cur.h, cur.verifiedAt, now, state)
        const body = { binding: cur.stmt, sig: cur.sig, attestation: att.text, attestationSig: att.sig, state, chain: (await s.get('chain')) || [], rebound: !!cur.rebound }
        // the previous key's vouch (kernel verifyRotation): pinners follow silently
        if (cur.rot) { body.rot = cur.rot; body.rotSig = cur.rotSig }
        const steps = (await s.get('steps')) || []
        if (steps.length) body.steps = steps
        const rsv = await s.get('rsv')
        if (rsv) { body.pending = rsv.h; body.activeAt = rsv.until } // a resolution waiting out its 72 h
        return out(200, body)
      }
      const tomb = await s.get('tomb')
      if (tomb) {
        // inside the §39.6 window the tomb keeps answering: no ✓, pins do not move
        const body = { error: 'deleted', tombstone: tomb }
        const state = await stateOf()
        if (await guardTomb()) {
          body.state = state
          const rot = await s.get('rot')
          if (rot && rot.overTomb) body.pending = rot.h // what the tombstoned key's contest names
        }
        return out(410, body)
      }
      return out(404, { error: 'not-found' }) // never existed, or expired: the same answer
    }

    // the bind answer again, for the statement that is bound (see /v1/bind/check)
    if (a.op === 'recheck') {
      const cur = await live()
      if (cur && cur.stmt === a.stmt) { // any valid signature over it: the worker checked it
        // the state rides in the attestation: a host must not finish setup on a frozen
        // or pending address any more than it would on a lookup that says so
        const dirKey = await importDirKey(this.env.DIR_KEY_JWK)
        const att = await attest(dirKey, this.env.DIR_KID, cur.h, cur.verifiedAt, now, await stateOf())
        return out(200, { binding: cur.stmt, sig: cur.sig, attestation: att.text, attestationSig: att.sig, rebound: !!cur.rebound })
      }
      const rot = await s.get('rot')
      if (rot && rot.overTomb && rot.stmt === a.stmt) { // a freeze deletes `rot`, so this is pending
        return out(200, { state: 'pending', activeAt: rot.until, rebound: true }) // what bind/complete answered
      }
      return out(404, { error: 'not-bound' })
    }

    const tombstone = async (by, scope) => {
      const cur = await s.get('cur')
      await s.delete(['cur', 'pend', 'rot', 'frz', 'fpend', 'steps', 'rsv', 'setup', 'grace'])
      if (!cur) return // nothing was bound: nothing to record
      const dirKey = await importDirKey(this.env.DIR_KEY_JWK)
      await s.put('tomb', await tombText(dirKey, this.env.DIR_KID, cur.h, cur.b.seq, now, by))
      // a holder deletion keeps the binding's protection for its own lifetime (§39.6)
      if (by === 'holder') await s.put('htomb', { h: cur.h, key: cur.b.key, seq: cur.b.seq, expires: cur.b.expires, scope: typeof scope === 'string' ? scope : null })
      else await s.delete('htomb')
    }

    if (a.op === 'delete') {
      const cur = await s.get('cur')
      const b = cur && (await readBind(cur.stmt, cur.sig, cur.verifiedAt)) // the address, read from the statement itself
      if (!b || !Number.isSafeInteger(a.ts)) return out(400, { error: 'invalid' })
      // frozen: neither key is honoured (security §23.1b), and a holder delete
      // would clear the way for an email-only re-bind, undoing the freeze;
      // pending: a delete must not race the contest window (§39.6)
      if ((await stateOf()) !== 'active') return out(400, { error: 'invalid' })
      if (!(await verifyDel(buildDel(b.address, a.ts), a.sig, { accountPub: b.accountPub, now })).ok) return out(400, { error: 'invalid' })
      await tombstone('holder', a.scope)
      return out(200, { deleted: true, keepUntil: cur.b.expires })
    }

    if (a.op === 'deleteStart') {
      // only an address with something to delete is mailed; the HTTP answer is 202 either way.
      // Only an EXPIRED binding can be removed by mailbox alone: a live one is
      // removed by its holder (del.), or frozen by email. Email never decides alone (security §25).
      const cur = await s.get('cur')
      if (!cur || cur.b.expires > now || !(await mayMail())) return out(202, { mail: null })
      const code = mintCode()
      await s.put('pend', { kind: 'delete', codeHash: await codeHash(code), expires: now + LIMITS.codeTtlMs, attempts: 0 })
      return out(202, { mail: { code } })
    }

    if (a.op === 'deleteComplete') {
      const p = await pending('delete')
      if (!p) return out(400, { error: 'invalid' })
      if (!same(await codeHash(a.code), p.codeHash)) return fail(p)
      const cur = await s.get('cur')
      if (cur && cur.b.expires > now) return fail(p) // renewed since the code was mailed
      await tombstone('mailbox')
      return out(200, { deleted: true })
    }

    // --- rotation: a new key, vouched for by the old one (rot.), consented, and proven by email
    if (a.op === 'rotateStart') {
      if (!(await spend(a.nonce))) return refuse('replay') // FIRST: every attempt consumes the challenge
      const cur = await live()
      if (!cur) return refuse('state')
      if ((await stateOf()) !== 'active') return refuse('state') // one rotation at a time; never out of a freeze
      const b = await readBind(a.stmt, a.sig, now) // signed by the NEW key
      const was = await readBind(cur.stmt, cur.sig, cur.verifiedAt)
      if (!b || !was || b.address !== was.address) return refuse('statement')
      if (b.accountPub === cur.b.key) return refuse('same-key') // a renewal, not a rotation
      if (b.seq !== cur.b.seq + 1 || b.prev !== cur.h) return refuse('sequence')
      // the OLD key's vouch, checked exactly as a pinning client will check it
      if (typeof a.rot !== 'string' || typeof a.rotSig !== 'string') return refuse('rot:missing')
      const v = await verifyRotation(cur.stmt, a.stmt, a.sig, a.rot, a.rotSig, { now })
      if (!v.ok) return refuse(`rot:${v.reason}`)
      const c = await verifyDirConsent(this.env, {
        scope: a.scope, accountPub: cur.b.key, purpose: 'rotate', challenge: a.challenge, payloadText: a.stmt, consent: a.consent, now,
      })
      if (!c.ok) return refuse(`consent:${c.reason}`)
      if (!(await mayMail())) return out(429, { error: 'mail-limit' })
      const code = mintCode(), freezeToken = mintToken()
      await s.put('pend', { kind: 'rotate', stmt: a.stmt, sig: a.sig, rotText: a.rot, rotSig: a.rotSig, codeHash: await codeHash(code), expires: now + LIMITS.codeTtlMs, attempts: 0 })
      await s.put('fpend', { hash: await tokenHash(freezeToken), expires: now + LIMITS.freezeTokenTtlMs, attempts: 0 })
      await s.delete('setup') // a key change under way ends the setup window
      return out(202, { mail: { code, fp: (await hashOf(b.accountPub)).slice(0, 8), freezeToken } })
    }

    if (a.op === 'rotateComplete') {
      const p = await pending('rotate')
      if (!p) return out(400, { error: 'invalid' })
      const b = await readBind(p.stmt, p.sig, now)
      const h = await hashOf(p.stmt)
      if (!b || !same(await codeHash(a.code), p.codeHash)) return fail(p)
      if (!(await verifyCmp(buildCmp(h, a.code), a.sig, { accountPub: b.accountPub, bindText: p.stmt })).ok) return fail(p)
      const cur = await live()
      if (!cur || (await stateOf()) !== 'active' || b.prev !== cur.h || b.seq !== cur.b.seq + 1) return fail(p) // moved since start
      await s.put('rot', { stmt: p.stmt, sig: p.sig, rotText: p.rotText, rotSig: p.rotSig, h, b: { key: b.accountPub, seq: b.seq, expires: b.expires }, at: now, until: now + LIMITS.rotationWindowMs })
      await s.delete('pend')
      return out(200, { state: 'pending', activeAt: now + LIMITS.rotationWindowMs })
    }

    // --- the email-only freeze: a mailed single-use token, used only by a deliberate POST
    if (a.op === 'freezeStart') {
      const cur = await live()
      if (!cur || (await s.get('frz')) || !(await mayMail())) return out(202, { mail: null })
      const freezeToken = mintToken()
      await s.put('fpend', { hash: await tokenHash(freezeToken), expires: now + LIMITS.freezeTokenTtlMs, attempts: 0 })
      return out(202, { mail: { freezeToken } })
    }

    if (a.op === 'freezeComplete') {
      const f = await s.get('fpend')
      if (!f || f.expires <= now || f.attempts >= LIMITS.codeAttempts) return out(400, { error: 'invalid' })
      if (!same(await tokenHash(a.token), f.hash)) { f.attempts++; await s.put('fpend', f); return out(400, { error: 'invalid' }) }
      // (`frz` here is belt and braces: a freeze deletes `fpend`, so a used token is already gone)
      if (!(await live()) || (await s.get('frz'))) return out(400, { error: 'invalid' })
      // resolvable ONLY by the recovery code (or the org), never by a device's
      // old key: the case this exists for is a thief holding the devices
      await freeze('email')
      return out(200, { state: 'frozen' })
    }

    // --- resolving a freeze by the recovery code (§39.3) ---------------------------
    // The frozen binding's key is reported lost or contested, so it signs nothing
    // here. The recovering device brings a new binding chained to the frozen one;
    // the worker checks the recovery verifier (Account object) between `resolvePrep`
    // and `resolve`, and `resolve` re-checks everything before it commits.
    if (a.op === 'resolvePrep' || a.op === 'resolve') {
      const frz = await s.get('frz')
      const base = frz && frz.base
      if (!base) return refuse('state')
      const cur = await live()
      // the frozen binding must still be the one protecting the address
      if (!(await frozenHolds(base))) return refuse('state')
      if (await s.get('rsv')) return refuse('resolving') // one resolution at a time: it waits out its 72 h
      const b = await readBind(a.stmt, a.sig, now) // self-signed by the NEW key
      if (!b) return refuse('statement')
      if (cur) { const was = await readBind(cur.stmt, cur.sig, cur.verifiedAt); if (!was || was.address !== b.address) return refuse('statement') }
      if (b.accountPub === base.key) return refuse('same-key') // the frozen key is the one reported lost
      if (b.seq !== base.seq + 1 || b.prev !== base.h) return refuse('sequence')
      if (a.op === 'resolvePrep') return out(200, { key: base.key })
      if (a.key !== base.key) return refuse('state') // the code was checked against another binding
      const h = await hashOf(a.stmt)
      if (frz.by === 'email' || frz.contested || a.young === true) {
        // EMAIL-ONLY freeze (ruling b): the code + the mailbox alone were an instant
        // takeover. It waits 72 h, still frozen; meanwhile a freeze or contest signed
        // by the frozen key voids it and marks the freeze CONTESTED, and every later
        // resolution of a contested freeze waits the same way. The code stays live
        // until one commits. A YOUNG code waits too, on any freeze: key + passkey could
        // otherwise enrol one, freeze and resolve, a rotation with no 72 h contest.
        await s.put('rsv', { stmt: a.stmt, sig: a.sig, h, at: now, until: now + LIMITS.rotationWindowMs })
        return out(202, { state: 'frozen', resolving: true, activeAt: now + LIMITS.rotationWindowMs })
      }
      // a key-holder freeze (owner, contest) by a code older than the window: at once
      const dirKey = await importDirKey(this.env.DIR_KEY_JWK)
      const att = await attest(dirKey, this.env.DIR_KID, h, now, now)
      // no vouch: pinners warn (intended, §39.3), and nothing here softens that
      await commitResolve(a.stmt, a.sig, h, b, base)
      return out(200, { binding: a.stmt, sig: a.sig, attestation: att.text, attestationSig: att.sig, rebound: true })
    }

    // --- what the other classes ask an address -------------------------------------
    // the new key's first credential landed: the grace is over at once
    if (a.op === 'credLanded') {
      const g = await s.get('grace')
      if (g) await endGrace(g)
      return out(200, { ok: true })
    }

    // the alarm: the grace's lapse ran above; this retries a failed rekey
    if (a.op === 'tick') {
      await runRekey()
      const g = await s.get('grace')
      if (g && !(await s.get('rekey'))) await s.setAlarm(g.until) // a retry's alarm replaced this one
      return out(200, { ok: true })
    }

    if (a.op === 'peek') {
      const cur = await live()
      return out(200, cur ? { live: true, accountPub: cur.b.key, state: await stateOf() } : { live: false, state: 'none' })
    }

    if (a.op === 'event') {
      // the short event list devices read with a signed status request (§9.7);
      // `to` is read from a stored statement, so the address is never stored twice
      const stored = (await s.get('cur')) || (await s.get('rot'))
      const b = stored && (await readBind(stored.stmt, stored.sig, stored.verifiedAt ?? stored.at))
      if (!b) return out(200, { to: null })
      const unauth = UNAUTH_KINDS.has(a.kind)
      if (unauth) {
        // ONE entry per kind, with a count and the first and last time: however many
        // attempts arrive, they can't evict the signed events below
        const u = (await s.get('uevents')) || {}
        const prev = u[a.kind] && now - u[a.kind].at < 7 * DAY ? u[a.kind] : null
        u[a.kind] = { k: a.kind, at: now, first: prev ? prev.first : now, n: (prev ? prev.n : 0) + 1, fp: '', act: NOTICE_ACTION[a.kind] }
        await s.put('uevents', u)
      } else {
        const ev = { k: a.kind, at: now, fp: a.fp || '', ...(a.setup === true ? { setup: true } : {}) }
        if (Object.hasOwn(NOTICE_ACTION, a.kind)) ev.act = NOTICE_ACTION[a.kind]
        await s.put('events', [...((await s.get('events')) || []), ev].slice(-LIMITS.events))
      }
      // MAIL is capped per address: one per kind per hour, and for the kinds anyone
      // can trigger, a daily ceiling of their own (signed kinds are bounded by their signatures)
      const sent = ((await s.get('nmail')) || []).filter((x) => now - x.at < DAY)
      const mail = a.mail !== false && !sent.some((x) => x.k === a.kind && now - x.at < LIMITS.noticeKindMs) &&
        (!unauth || sent.filter((x) => UNAUTH_KINDS.has(x.k)).length < LIMITS.unauthNoticesPerDay)
      if (!mail) return out(200, { to: null })
      await s.put('nmail', [...sent, { k: a.kind, at: now }])
      return out(200, { to: b.address })
    }

    // an account-signed request (dreq.): spend FIRST, then verify it against the
    // binding served as authoritative (the OLD one while pending), and the consent
    // the op needs (cred-add, cred-del, rc-enrol; security §39.3). contest and
    // freeze are applied here, once verified.
    if (a.op === 'authorize') {
      if (!(await spend(a.nonce))) return refuse('replay')
      if (typeof a.req !== 'string' || typeof a.sig !== 'string') return refuse('state')
      const subject = dreqSubject(a.subject)
      if (!subject) return refuse('grammar')
      let state = await stateOf()
      const rot = await s.get('rot')
      const rsv = await s.get('rsv')
      // the one exception to "frozen: status only" (ruling b): while a freeze's
      // resolution waits, the address IS pending a key change, from the
      // frozen binding (still the one served) to the resolution's. Its key may then
      // freeze or contest, exactly as in a pending rotation; nothing else.
      if (rsv && state === 'frozen' && (subject.op === 'freeze' || subject.op === 'contest')) state = 'pending'
      let bindText = null, accountPub = null, overTomb = false
      const cur = await live()
      if (cur) { bindText = cur.stmt; accountPub = cur.b.key } else if (subject.op === 'contest' && rot && rot.overTomb) {
        // the one exception to "the binding the directory serves" (§39.6): the
        // holder of a binding deleted by key may contest a new key's re-bind,
        // naming that deleted binding. Only its hash was kept, so the request
        // brings the text and it must hash to what the tomb names.
        const ht = await s.get('htomb')
        if (ht && typeof a.bind === 'string' && (await hashOf(a.bind)) === ht.h) { bindText = a.bind; accountPub = ht.key; overTomb = true }
      }
      if (!bindText) return refuse('state')
      if (subject.op === 'contest') subject.pendingBindText = rsv ? rsv.stmt : rot ? rot.stmt : ''
      const v = await verifyDreq(a.req, a.sig, { bindText, state, challenge: a.challenge, subject, spend: () => true })
      if (!v.ok) return refuse(`dreq:${v.reason}`)
      await runRekey()
      // old passkeys still here would fill the new key's slot: ask again, with nothing used up
      if (dreqNeedsConsent(subject.op) && (await s.get('rekey'))) return refuse('rekey')
      // the setup allowance stands in only for ABSENT consent: a request that
      // presents consent is judged on it, and a bad one never falls through
      const setup = dreqNeedsConsent(subject.op) && a.consent === null && (await useSetup(subject.op, cur))
      let grace = false
      if (dreqNeedsConsent(subject.op) && !setup) {
        const g = GRACE_OPS.includes(subject.op) ? await s.get('grace') : null
        const c = await verifyDirConsent(this.env, {
          scope: a.scope, accountPub, graceKey: g ? g.key : null, purpose: subject.op, challenge: a.challenge, payloadText: a.req, consent: a.consent, now,
        })
        if (!c.ok) return refuse(`consent:${c.reason}`)
        grace = c.grace === true
      }
      if (subject.op === 'contest' || subject.op === 'freeze') {
        await freeze(subject.op === 'contest' ? (overTomb ? 'contest-tomb' : 'contest') : 'owner')
        return out(200, { accountPub, state: 'frozen' })
      }
      const body = { accountPub, state, ...(setup ? { setup: true } : {}), ...(grace ? { grace: true } : {}) }
      if (subject.op === 'status') {
        body.events = [...((await s.get('events')) || []), ...Object.values((await s.get('uevents')) || {})].sort((x, y) => x.at - y.at)
        // what a device holding the old key needs in order to contest, and to show
        if (rot && !rot.overTomb) body.pending = { binding: rot.stmt, sig: rot.sig, rot: rot.rotText, rotSig: rot.rotSig, activeAt: rot.until }
        // a resolution of an email-only freeze: what the frozen key's contest names (no vouch exists)
        if (rsv) body.pending = { binding: rsv.stmt, sig: rsv.sig, activeAt: rsv.until, resolve: true }
        // a freeze that voided a waiting resolution (security's ruling): told to
        // the account-signed status read ONLY, never to the public lookup, so the
        // key holder learns its resolution was voided and will wait 72 hours
        if ((await s.get('frz'))?.contested) body.contested = true // frz exists only while frozen
      }
      return out(200, body)
    }

    // device linking (§39.1): H's message 3, checked before the slot releases
    // anything. Spend FIRST (every attempt burns its challenge, a malformed one
    // too), then ONE verifier: kernel's verifyLinkRelease over the whole text,
    // against the LIVE binding and its state. Kernel refuses everything but
    // `active`, an N naming H's own device, and an H with no consent key (the
    // light tier's WebAuthn link consent stays off).
    if (a.op === 'link') {
      if (!(await spend(a.nonce))) return refuse('replay')
      const cur = await live()
      if (!cur) return refuse('state')
      const v = await verifyLinkRelease(a.msg3, {
        bindText: cur.stmt, state: await stateOf(), challenge: a.challenge, now,
        spend: () => true, // spent above, first
      })
      if (!v.ok) return refuse(v.reason)
      return out(200, { accountPub: cur.b.key, fp: (await hashOf(v.value.device.devicePub)).slice(0, 8) })
    }

    return out(400, { error: 'bad-op' })
  }

  /** Housekeeping with no request behind it: a grace's end, a rekey's retry. */
  async alarm() {
    await this.fetch(new Request('https://address/op', { method: 'POST', body: JSON.stringify({ op: 'tick' }) }))
  }
}

/** The subject of a directory request, from the request's own bytes (base64url).
 *  A contest's subject (the pending bind. text) is the Address object's to fill. */
function dreqSubject(x) {
  if (!x || typeof x !== 'object') return null
  const bytes = (v) => { const d = typeof v === 'string' ? b64uDec(v) : null; return d && b64uEnc(d) === v ? d : null }
  switch (x.op) {
    case 'status': case 'freeze': case 'contest': return { op: x.op }
    case 'cred-add': { const a = bytes(x.attestationObject), c = bytes(x.clientDataJSON); return a && c ? { op: x.op, attestationObject: a, clientDataJSON: c } : null }
    case 'cred-del': { const c = bytes(x.credentialId); return c ? { op: x.op, credentialId: c } : null }
    case 'rc-enrol': { const b = bytes(x.body); return b ? { op: x.op, body: b } : null }
    default: return null
  }
}

// --- one Durable Object per passkey CREDENTIAL (§9.1, §9.3) ---------------------------
// Named by b64u sha256(credentialId). Holds `cred`: { scope (the storage name of
// the address it belongs to), pub (raw P-256), signCount, be, attachment,
// devicePub, created }, plus `fails` and `lockedUntil`. Registration and the
// PRF-wrapped blob arrive with the key-blob store; this class only verifies
// assertions.

export class Cred {
  constructor(state, env) { this.state = state; this.env = env }

  async fetch(req) {
    const a = await req.json()
    const now = Date.now()
    const s = this.state.storage
    const res = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

    if (a.op === 'assert') {
      const cred = await s.get('cred')
      // consent is for one key: this passkey must be that key's, or the previous key's
      // when the Address object says so. Consent never rests on a rekey having succeeded.
      const grace = !!cred && !!a.graceKey && cred.accountPub === a.graceKey
      if (!cred || cred.scope !== a.scope || (cred.accountPub !== a.accountPub && !grace)) return res({ ok: false, reason: 'unknown' }) // one answer for all
      if (((await s.get('lockedUntil')) || 0) > now) return res({ ok: false, reason: 'locked' })
      const v = await verifyAssertion(cred, a.assertion, { challenge: a.challenge, origins: new Set(a.origins) })
      if (!v.ok) {
        const fails = ((await s.get('fails')) || 0) + 1
        if (fails >= LIMITS.credFailures) { await s.put('lockedUntil', now + LIMITS.credLockMs); await s.put('fails', 0) } else await s.put('fails', fails)
        return res(v)
      }
      await s.put('cred', { ...cred, signCount: v.signCount })
      await s.put('fails', 0)
      return res({ ok: true, ...(grace ? { grace: true } : {}) })
    }

    // --- the key-blob store (§9.3) ---
    const st = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (a.op === 'register') {
      if (await s.get('cred')) return st(400, { error: 'invalid', reason: 'exists' })
      await s.put('cred', a.rec)
      return st(200, { ok: true })
    }

    if (a.op === 'get') {
      // the challenge's nonce is recorded HERE, first: one fetch per challenge
      const spent = Object.fromEntries(Object.entries((await s.get('spent')) || {}).filter(([, t]) => t > now))
      if (typeof a.nonce !== 'string' || Object.hasOwn(spent, a.nonce)) return st(400, { reason: 'replay' })
      spent[a.nonce] = now + 2 * CHALLENGE_TTL_MS
      await s.put('spent', spent)
      const cred = await s.get('cred')
      if (!cred || !cred.blob) return st(400, { reason: 'unknown' })
      if (((await s.get('lockedUntil')) || 0) > now) return st(400, { reason: 'locked' })
      const v = await verifyAssertion(cred, a.assertion, { challenge: a.challenge, origins: new Set(a.origins) })
      if (!v.ok) {
        const fails = ((await s.get('fails')) || 0) + 1
        if (fails >= LIMITS.credFailures) { await s.put('lockedUntil', now + LIMITS.credLockMs); await s.put('fails', 0) } else await s.put('fails', fails)
        return st(400, { reason: v.reason })
      }
      await s.put('cred', { ...cred, signCount: v.signCount })
      await s.put('fails', 0)
      return st(200, { scope: cred.scope, accountPub: cred.accountPub, blob: cred.blob })
    }

    if (a.op === 'delete') {
      const cred = await s.get('cred')
      if (!cred || cred.scope !== a.scope) return st(400, { reason: 'unknown' })
      await s.delete(['cred', 'fails', 'lockedUntil', 'spent'])
      return st(200, { ok: true })
    }

    return res({ ok: false, reason: 'bad-op' })
  }
}

// --- the per-IP ledger ----------------------------------------------------------------
// Keys on HMAC(daySalt, ip); the salt is minted in storage per UTC day and
// yesterday's is deleted with its counters, so no raw IP is ever stored and
// one day's hashes cannot be linked to the next.

const dayOf = (t) => new Date(t).toISOString().slice(0, 10)
const hourOf = (t) => new Date(t).toISOString().slice(0, 13)

export class Ledger {
  constructor(state) { this.state = state }

  async fetch(req) {
    const { ip, kind } = await req.json()
    const now = Date.now()
    const day = dayOf(now), hour = hourOf(now)
    const s = this.state.storage
    let salt = await s.get(`salt:${day}`)
    if (!salt) {
      salt = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')
      await s.put(`salt:${day}`, salt)
      await s.setAlarm(Date.parse(day) + DAY + 60_000)
    }
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const h = [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(String(ip))))].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')
    const cap = LIMITS.ip[kind] ?? 0
    const key = `${kind}:${hour}:${h}`
    const n = ((await s.get(key)) || 0) + 1
    if (n > cap) return Response.json({ ok: false })
    await s.put(key, n)
    return Response.json({ ok: true })
  }

  async alarm() {
    const today = dayOf(Date.now())
    const dead = []
    for (const k of (await this.state.storage.list()).keys()) {
      const stamp = k.startsWith('salt:') ? k.slice(5) : k.split(':')[1]?.slice(0, 10)
      if (stamp && stamp < today) dead.push(k)
    }
    for (let i = 0; i < dead.length; i += 128) await this.state.storage.delete(dead.slice(i, i + 128))
  }
}
