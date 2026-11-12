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
// The VOID link is the one exception to "the sign-in host": it opens the void
// page on the directory's own origin (DIRECTORY_ORIGIN/void), which runs no
// ceremony and asks for nothing but a button press (voidpage.js). Its rules
// are the same: everything in the fragment, opening it changes nothing, and
// only a POST the button sends acts on the token.
//
// Format, version 1:
//
//   <SIGNIN_ORIGIN>/setup#v=1&e=<address>&t=<token>
//   <SIGNIN_ORIGIN>/reset#v=1&e=<address>&t=<token>
//   <DIRECTORY_ORIGIN>/void#v=1&e=<address>&t=<token>&k=<kind>
//
//   (SIGNIN_ORIGIN is the sign-in host, from passkey.js, the one place an origin is written)
//
//   v  the format version, "1"
//   e  the address the link was mailed to, percent-encoded
//      (encodeURIComponent); the normalised form the directory stores
//   t  the token: 32 bytes, base64url without padding (43 characters)
//   k  (void links only) which buttons the page shows, one letter:
//        c  a member's change: "Cancel this change" and "Cancel, and remove
//           the passkey that asked for it"
//        o  a member's change whose requester is the only live member:
//           Cancel only (that Remove could only lock the person out, G4c)
//        r  a reset: Cancel only (a reset has no requesting member)
//        u  the queued removal of a suspended passkey: undo only (G4a)
//      The page draws from it and nothing else; the directory decides from
//      its own record what the token may do, so an edited `k` shows a button
//      that is then refused, never one that works.
//
// The sign-in host reads `location.hash` with URLSearchParams, refuses any
// other key, a missing one or a repeated one, removes the fragment from the
// address bar (history.replaceState) before anything else runs, and then
// POSTs /v1/roster/setup { email: e, token: t, dirNonce, reg } after a
// passkey registration over a fresh /v1/roster/challenge for that address
// (a reset link: /v1/roster/reset, with the same body). The void page does the
// same with its four keys and POSTs /v1/void { email: e, token: t, choice }.

import { DIRECTORY_ORIGIN, SIGNIN_ORIGIN } from './passkey.js'

export const LINK_VERSION = '1'

/** The paths on the sign-in host that a mailed link opens. */
export const SIGNIN_PATHS = Object.freeze({ setup: '/setup', reset: '/reset' })

/** The void page's path on the directory's own origin. */
export const VOID_PATH = '/void'

/** The void link kinds (the `k` key) and the one choice each offers first. */
export const VOID_KINDS = Object.freeze(['c', 'o', 'r', 'u'])

/** The setup link for `address` (normalised) and its `token`. */
export function setupLink(address, token) {
  const f = new URLSearchParams()
  f.set('v', LINK_VERSION)
  f.set('e', address)
  f.set('t', token)
  return `${SIGNIN_ORIGIN}${SIGNIN_PATHS.setup}#${f.toString()}`
}

/** The reset link for `address` (normalised) and its `token`: the setup link's format, at /reset. */
export function resetLink(address, token) {
  const f = new URLSearchParams()
  f.set('v', LINK_VERSION)
  f.set('e', address)
  f.set('t', token)
  return `${SIGNIN_ORIGIN}${SIGNIN_PATHS.reset}#${f.toString()}`
}

/** The void link for `address`, its `token` and the page's `kind` (VOID_KINDS). */
export function voidLink(address, token, kind) {
  if (!VOID_KINDS.includes(kind)) throw new Error(`unknown void link kind: ${kind}`)
  const f = new URLSearchParams()
  f.set('v', LINK_VERSION)
  f.set('e', address)
  f.set('t', token)
  f.set('k', kind)
  return `${DIRECTORY_ORIGIN}${VOID_PATH}#${f.toString()}`
}

/**
 * Read a link the way the page that opens it must: exact origin and path, no
 * query, and a fragment of exactly v, e, t (and k, for a void link). Returns
 * { address, token } (and kind) or null. The rig uses it on every mailed link;
 * the sign-in host and the void page mirror it.
 */
function parseAt(link, origin, path, names) {
  let u
  try { u = new URL(link) } catch { return null }
  if (u.origin !== origin || u.pathname !== path || u.search !== '' || u.username || u.password) return null
  const f = new URLSearchParams(u.hash.slice(1))
  const keys = [...f.keys()]
  if (keys.length !== names.length || new Set(keys).size !== names.length || !names.every((k) => f.has(k))) return null
  if (f.get('v') !== LINK_VERSION) return null
  const token = f.get('t')
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  return { f, address: f.get('e'), token }
}

/** A setup link: { address, token } or null. */
export function parseSetupLink(link) {
  const p = parseAt(link, SIGNIN_ORIGIN, SIGNIN_PATHS.setup, ['v', 'e', 't'])
  return p && { address: p.address, token: p.token }
}

/** A reset link: { address, token } or null. */
export function parseResetLink(link) {
  const p = parseAt(link, SIGNIN_ORIGIN, SIGNIN_PATHS.reset, ['v', 'e', 't'])
  return p && { address: p.address, token: p.token }
}

/** A void link: { address, token, kind } or null. */
export function parseVoidLink(link) {
  const p = parseAt(link, DIRECTORY_ORIGIN, VOID_PATH, ['v', 'e', 't', 'k'])
  if (!p || !VOID_KINDS.includes(p.f.get('k'))) return null
  return { address: p.address, token: p.token, kind: p.f.get('k') }
}
