// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The pages a mailed link opens on the sign-in host (G13): /setup and /reset.
// Which one this is comes from the page itself (body data-link), never the URL.
//
// The link carries everything in its fragment, version 1 of the directory's
// format (server/directory/src/links.js):  #v=1&e=<address>&t=<token>
//
// - The fragment is the ONLY thing read from the URL. It is read once, taken
//   out of the address bar and the history entry before anything else, and
//   refused unless it is exactly v, e and t, once each, v=1, a 43-character
//   token and a plausible address, with no query string beside it.
// - Opening the link sends nothing. Only the person's button press asks the
//   directory for a challenge and makes the passkey.
// - A setup writes the account only through signInHere(), after a sign-in
//   with the passkey it just made, and only if the directory names the same
//   address. A reset writes nothing.

import { Refused, completeLink, isAddress, signInHere, when } from './account-client.js'

const KIND = document.body.dataset.link === 'reset' ? 'reset' : 'setup'
const $ = (id) => document.getElementById(id)

function show(state, reason) {
  document.body.dataset.state = state
  if (reason) document.body.dataset.reason = reason
  else delete document.body.dataset.reason
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = el.dataset.for !== state
}

/** The link's fragment, read once and removed. Returns { address, token } or null. */
function readLink() {
  const hash = location.hash
  const query = location.search
  history.replaceState(null, '', location.pathname)
  if (query) return null
  const f = new URLSearchParams(hash.slice(1))
  const keys = [...f.keys()]
  if (keys.length !== 3 || new Set(keys).size !== 3 || !['v', 'e', 't'].every((k) => f.has(k))) return null
  if (f.get('v') !== '1') return null
  const token = f.get('t'), address = f.get('e')
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !isAddress(address)) return null
  return { address, token }
}

const link = readLink()
let busy = false
let made = null

const SETUP_FAIL = { 400: 'link-used', 409: 'exists', 429: 'busy', 503: 'directory' }
const RESET_FAIL = { 400: 'link-used', 404: 'no-account', 409: 'pending', 429: 'busy', 503: 'mail' }

async function makePasskey() {
  if (busy || !link) return
  busy = true
  show('working')
  try {
    const r = await completeLink(KIND, link.address, link.token)
    if (KIND === 'setup') {
      if (r.status !== 200) throw new Refused(r.body.error === 'nonce' ? 'directory' : SETUP_FAIL[r.status] || 'directory')
      made = r.credId
      show('confirm')
    } else {
      if (r.status !== 202 || !Number.isSafeInteger(r.body.ripensAt)) {
        throw new Refused(r.body.error === 'superseded' ? 'pending' : r.body.error === 'nonce' ? 'directory' : RESET_FAIL[r.status] || 'directory')
      }
      $('ripens').textContent = when(r.body.ripensAt)
      show('waiting')
    }
  } catch (e) {
    show('failed', reasonOf(e))
  } finally {
    busy = false
  }
}

async function confirm() {
  if (busy || !made) return
  busy = true
  show('working')
  try {
    const address = await signInHere({ allow: made, expect: link.address })
    $('done-account').textContent = address
    show('done')
  } catch (e) {
    show('unconfirmed', reasonOf(e))
  } finally {
    busy = false
  }
}

function reasonOf(e) {
  if (e instanceof Refused) return e.reason
  if (e && e.name === 'NotAllowedError') return 'cancelled'
  if (e && e.name === 'InvalidStateError') return 'exists-here'
  return 'error'
}

function start() {
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => window.close())
  if (!link) return show('refused', 'bad-link')
  for (const el of document.querySelectorAll('[data-address]')) el.textContent = link.address
  $('make').addEventListener('click', makePasskey)
  $('retry').addEventListener('click', () => { if (!busy) show('ready') })
  for (const b of document.querySelectorAll('[data-confirm]')) b.addEventListener('click', confirm)
  show('ready')
}

start()
