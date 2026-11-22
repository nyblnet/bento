// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The sign-in host: the only web page that runs passkey ceremonies for the
// bento/id rp `id.bento.page`. bento/home (https://home.bento.page) cannot use
// those passkeys, so it opens this page in a popup and asks it, in ONE message,
// to certify a browser key it generated. This page draws its own consent
// screen, runs one passkey assertion when the person approves, hands it to the
// directory, and sends the directory's answer back to bento/home.
//
// The rules, each pinned by a rig row with a mutant that breaks it
// (scripts/test-signin-host-browser.mjs):
//
//   - A request is accepted only from event.origin === HOME AND
//     event.source === window.opener; one request per window; and it is exactly
//     { t: 'enrol', W, kx, label }. Anything else is refused. That allowlist is
//     the whole defence against an opener asking for an account change: this
//     page never adds or removes a passkey, deletes an account or calls the
//     WebAuthn Signal API because its opener asked. Account changes start only
//     from this host's own pages, by the person.
//   - Every reply goes to the literal origin HOME. Never '*', never a value
//     taken from a message or the URL.
//   - Nothing is read from this page's own URL: no action, key, label or account.
//   - Opened without an opener (noopener), the page refuses and does nothing.
//   - The opener's origin shown to the person, and reported to the directory as
//     `rq`, is event.origin, never a field of the request.
//   - The consent screen never says the key belongs to this browser: this page
//     cannot know that, only that bento/home sent it.

import { b64u, challengeFor, enrolChallenge, submitEnrol, wdevText } from './directory-client.js'

const HOME = 'https://home.bento.page'
const RP_ID = 'id.bento.page'
const MAX_LABEL = 40
// Control and format characters (bidi controls included), private-use,
// unassigned and lone-surrogate code points, line and paragraph separators,
// everything Unicode marks default-ignorable, and the braille blank: a label
// the person cannot read as written is refused, not cleaned.
const BAD_LABEL = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/u
const POINT = /^[A-Za-z0-9_-]{87}$/ // 65 bytes, base64url, no padding
const ACCOUNT_KEY = 'bento-id-account'

const $ = (id) => document.getElementById(id)

/** The page's visible state; rigs read data-state and data-reason. */
function show(state, reason) {
  document.body.dataset.state = state
  if (reason) document.body.dataset.reason = reason
  else delete document.body.dataset.reason
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = el.dataset.for !== state
}

/** The ONLY place this page posts a message, and its target is a literal. */
function reply(msg) {
  const to = window.opener
  if (to) to.postMessage(msg, HOME)
}

const unb64u = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function isPoint(s, alg) {
  if (typeof s !== 'string' || !POINT.test(s)) return false
  const raw = unb64u(s)
  if (raw.length !== 65 || raw[0] !== 0x04) return false
  try {
    await crypto.subtle.importKey('raw', raw, alg, true, alg.name === 'ECDSA' ? ['verify'] : [])
    return true
  } catch {
    return false
  }
}

/** The one request shape. Returns the request, or a refusal reason. */
async function checkRequest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m) || Object.getPrototypeOf(m) !== Object.prototype) return 'not-a-request'
  if (Object.keys(m).sort().join(',') !== 'W,kx,label,t') return 'not-a-request'
  if (m.t !== 'enrol') return 'not-a-request'
  if (!(await isPoint(m.W, { name: 'ECDSA', namedCurve: 'P-256' }))) return 'bad-key'
  if (!(await isPoint(m.kx, { name: 'ECDH', namedCurve: 'P-256' }))) return 'bad-key'
  const label = m.label
  if (typeof label !== 'string' || label.length === 0 || [...label].length > MAX_LABEL || BAD_LABEL.test(label)) return 'bad-label'
  return { W: m.W, kx: m.kx, label }
}

const savedAccount = () => {
  try { return localStorage.getItem(ACCOUNT_KEY) } catch { return null }
}

async function fingerprint(W) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', unb64u(W)))
  const hex = [...h.slice(0, 4)].map((x) => x.toString(16).padStart(2, '0')).join('')
  return hex.slice(0, 4) + ' ' + hex.slice(4)
}

let taken = false
let voided = false
let request = null
let busy = false

async function onMessage(e) {
  // Not from the window that opened this one: not ours to answer.
  if (e.source !== window.opener || e.source === null) return
  if (taken) {
    // A second message voids the first request too: the person must never
    // approve one request while the opener is busy sending another. The
    // first may still be inside an await below (WebKit delivers the second
    // message there), so it checks `voided` after every await.
    if (!busy) { voided = true; request = null; show('refused', 'one-request-per-window') }
    return
  }
  taken = true
  if (e.origin !== HOME) return show('refused', 'wrong-origin')
  const r = await checkRequest(e.data)
  if (voided) return
  if (typeof r === 'string') return show('refused', r)
  // The certificate names the account, so it must be known before the
  // passkey is asked: it comes from this site's own storage, never the request.
  const account = savedAccount()
  if (!account) return show('no-account')
  const fp = await fingerprint(r.W)
  if (voided) return
  request = { ...r, rq: e.origin, account }
  $('who').textContent = e.origin
  $('account').textContent = account
  $('label').textContent = r.label
  $('fp').textContent = fp
  show('consent')
}

async function approve() {
  if (!request || busy || voided) return
  busy = true
  show('working')
  try {
    const ch = await enrolChallenge(request.account)
    const text = wdevText({ W: request.W, kx: request.kx, address: request.account, rosHash: ch.rosHash, label: request.label, at: ch.at, nonce: ch.nonce })
    const challenge = await challengeFor(text)
    const cred = await navigator.credentials.get({
      publicKey: { rpId: RP_ID, challenge, userVerification: 'required', allowCredentials: [], timeout: 120000 },
    })
    const res = cred.response
    const assertion = {
      id: b64u(cred.rawId),
      userHandle: res.userHandle ? b64u(res.userHandle) : '',
      authenticatorData: b64u(res.authenticatorData),
      clientDataJSON: b64u(res.clientDataJSON),
      signature: b64u(res.signature),
    }
    const out = await submitEnrol({ text, rq: request.rq, assertion })
    reply({ t: 'enrolled', wdev: out.wdev, watt: out.watt })
    request = null
    show('done')
    setTimeout(() => window.close(), 1500)
  } catch (err) {
    request = null
    reply({ t: 'failed' })
    show('failed', err && err.name === 'NotAllowedError' ? 'cancelled-by-browser' : 'error')
  }
}

function cancel() {
  if (busy) return
  busy = true
  request = null
  reply({ t: 'cancelled' })
  show('cancelled')
  window.close()
}

function start() {
  $('approve').addEventListener('click', approve)
  $('cancel').addEventListener('click', cancel)
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => window.close())
  if (!window.opener) return show('refused', 'no-opener')
  addEventListener('message', onMessage)
  show('waiting')
  reply({ t: 'ready' })
}

start()
