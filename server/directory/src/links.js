// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// The links the directory mails. This file is the contract with the sign-in
// host (server/signin), which opens them: the host's pages must accept exactly
// this format, and nothing else in the directory builds a link.
//
// A link is a confirmation that completes ONLY on the sign-in host, in the
// browser that opens it, by making a passkey there (G13). So:
//
// - It points at the sign-in host (`SIGNIN_ORIGIN`), never at id.bento.page,
//   which never runs a ceremony and serves no page that reads a link.
// - Everything secret is in the FRAGMENT. A browser never sends the fragment
//   to any server, and a mail provider's link scanner that fetches the URL
//   gets the bare page: it cannot make a passkey, so it cannot complete
//   anything, and it never sees the token.
// - Opening the link does nothing by itself. The page asks the person to
//   make a passkey; only the registration it then sends, with the token,
//   completes the setup. No route anywhere completes on a GET.
// - The token is 256 bits, single use, and lives ROSTER_LIMITS.setupTtlMs.
//
// Format, version 1:
//
//   <SIGNIN_ORIGIN>/setup#v=1&e=<address>&t=<token>
//
//   (SIGNIN_ORIGIN is the sign-in host, from passkey.js, the one place an origin is written)
//
//   v  the format version, "1"
//   e  the address the link was mailed to, percent-encoded
//      (encodeURIComponent); the normalised form the directory stores
//   t  the setup token: 32 bytes, base64url without padding (43 characters)
//
// The sign-in host reads `location.hash` with URLSearchParams, refuses any
// other key, a missing one or a repeated one, removes the fragment from the
// address bar (history.replaceState) before anything else runs, and then
// POSTs /v1/roster/setup { email: e, token: t, dirNonce, reg } after a
// passkey registration over a fresh /v1/roster/challenge for that address.

import { SIGNIN_ORIGIN } from './passkey.js'

export const LINK_VERSION = '1'

/** The paths on the sign-in host that a mailed link opens. */
export const SIGNIN_PATHS = Object.freeze({ setup: '/setup' })

/** The setup link for `address` (normalised) and its `token`. */
export function setupLink(address, token) {
  const f = new URLSearchParams()
  f.set('v', LINK_VERSION)
  f.set('e', address)
  f.set('t', token)
  return `${SIGNIN_ORIGIN}${SIGNIN_PATHS.setup}#${f.toString()}`
}

/**
 * Read a setup link the way the sign-in host must: exact origin and path, no
 * query, and a fragment of exactly v, e and t. Returns { address, token } or
 * null. The rig uses it on every mailed link; the host mirrors it.
 */
export function parseSetupLink(link) {
  let u
  try { u = new URL(link) } catch { return null }
  if (u.origin !== SIGNIN_ORIGIN || u.pathname !== SIGNIN_PATHS.setup || u.search !== '' || u.username || u.password) return null
  const f = new URLSearchParams(u.hash.slice(1))
  const keys = [...f.keys()]
  if (keys.length !== 3 || new Set(keys).size !== 3 || !['v', 'e', 't'].every((k) => f.has(k))) return null
  if (f.get('v') !== LINK_VERSION) return null
  const token = f.get('t')
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  return { address: f.get('e'), token }
}
