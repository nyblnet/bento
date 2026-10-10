// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Release-channel trust: is this really a Bento build?
//
// WHY THIS EXISTS. Creating a new document means downloading an app shell and
// writing it to the user's own disk, where they will subsequently double-click
// it. That file is executable HTML with a runtime inside it. A plain https GET
// of a URL a JSON file told us about is NOT enough to earn that: whoever can
// answer for the release origin — a compromised host, a bad CDN edge, a proxy
// on a hostile network — chooses what code the user creates and then trusts.
//
// The release channel was built for exactly this and we were ignoring it. The
// manifest is a SIGNED ENVELOPE, `{payload: "<json string>", sig: "<base64>"}`,
// signed offline (scripts/sign-release.mjs) with a key that lives on the
// maintainer's machine and never enters CI. The payload pins the shell's
// sha256. So there is a chain — signature over the pin, pin over the bytes —
// and it terminates in a public key compiled into this file. Neither half is
// optional: a signature with no pin verifies a description of a build rather
// than a build, and a pin with no signature is a digest chosen by the same
// party that serves the bytes.
//
// MIRRORED, NOT IMPORTED. `kernel/src/update.ts` is the reference implementation
// (`verifySigned`, `fetchPinned`, `verifyManifest`) and this is a deliberate
// line-by-line mirror of it: same envelope, same key, same ECDSA P-256 /
// SHA-256 over the payload's exact UTF-8 bytes with NO canonicalisation, same
// hex-digest comparison. It is copied because it cannot be imported — the
// kernel is TypeScript compiled by Vite into an app shell, and this extension
// ships as plain unbundled ES modules that Chrome loads from disk with no build
// step. Adding a bundler to the extension to share ~40 lines would cost more
// trust than it buys (the shipped package would stop being the reviewed source).
//
// The consequence of mirroring is a maintenance obligation, so state it plainly:
// **if the release key or the envelope format changes in kernel/src/update.ts,
// it must change here too.** `scripts/test-webext-release.ts` pins both ends —
// it asserts this key is byte-identical to the kernel's, and verifies a REAL
// captured manifest, so a format drift fails a test rather than a user.

/**
 * Release signing PUBLIC key — the same one embedded in every shipped shell
 * (kernel/src/update.ts PUBLIC_KEY_JWK). The private half is offline
 * (`scripts/keygen.mjs` → `~/.bento/release-key.json`). Rotating it orphans
 * every already-shipped file, so the key is guarded rather than rotated.
 */
export const RELEASE_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'GMHSKwWcAoJVq-Dz1ZxWZM6TXATWIKbaQBpjoTystH8',
  y: 'flFNzbdXCmJN8RQYCeG71rBZnnbN-MCEnp1EbCLFrj0',
}

// Ask for BYTES, not for a page — explicitly, rather than inheriting whatever
// the platform's default happens to be.
//
// Not hypothetical. Measured against the live release URL on 2026-08-17: the
// SAME url answers differently depending on this one header. Asking with the
// wildcard returns 689,316 bytes, which match the signed pin. Asking with a
// browser's own header (text/html, application/xhtml+xml, …) returns 689,675,
// which do not.
//
// The 359-byte difference is a Cloudflare Web Analytics beacon the edge injects
// before the closing body tag, for anything it reads as a page being browsed.
// The URL and its `.bento.html` extension are identical either way, so the
// trigger is the header — the good outcome, since a path-keyed injection could
// not be avoided by any host.
//
// An extension's `fetch` already defaults to the wildcard, so this changes
// nothing today. Set anyway: the default belongs to the browser, not to this
// code, and if it ever moves the symptom is a `+` button that refuses every
// download. The digest check catching that IS the system working, but it is
// better not to depend on the catch.
//
// Found by home/android, measured by home/ios, reproduced here.
export const ACCEPT_BYTES = { Accept: '*/*' }

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Lowercase hex sha256 of some bytes — the digest form every pin uses. */
const sha256Hex = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes))

/**
 * Verify a SIGNED ENVELOPE and return its parsed payload.
 *
 * The signature covers the payload's exact UTF-8 bytes, which is why the
 * payload travels as a STRING rather than as an object: re-serialising an
 * object to check a signature makes the check depend on key order and spacing,
 * and a signature check that is subtly wrong looks exactly like one that is
 * right.
 *
 * Throws on anything short of a good signature — never returns a "probably
 * fine". `what` only names the thing in those messages.
 *
 * `jwk` is a TEST SEAM and nothing else: no caller in the extension passes it,
 * and passing one is exactly as much of a trust decision as passing the `fetch`
 * these functions take. Production reads the key above.
 */
export async function verifySigned(raw, what = 'signed file', jwk = RELEASE_KEY) {
  let payload, sig
  try {
    ;({ payload, sig } = JSON.parse(raw))
  } catch {
    throw new Error(`the ${what} is not valid JSON`)
  }
  if (typeof payload !== 'string' || typeof sig !== 'string')
    throw new Error(`the ${what} is not signed — refusing it`)

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  )
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    b64ToBytes(sig), new TextEncoder().encode(payload),
  )
  if (!ok) throw new Error(`the ${what} signature is INVALID — refusing it`)

  try {
    return JSON.parse(payload)
  } catch {
    throw new Error(`the ${what} payload is not valid JSON`)
  }
}

/**
 * The signature check, plus the shape checks that make a payload a release.
 *
 * `appId` is checked because the channels are siblings on one origin and a
 * signed manifest is a valid signed manifest wherever it is served from:
 * without this, anyone who can move bytes around that origin could answer the
 * Spaces channel with the (genuine, correctly signed) Slides manifest and hand
 * somebody the wrong application. The shipped shells make the same check for
 * the same reason (`kernel/src/update.ts verifyManifest`).
 */
export async function verifyManifest(raw, appId, jwk) {
  const info = await verifySigned(raw, 'release manifest', jwk)
  if (
    info?.app !== appId ||
    typeof info.version !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(info.sha256 ?? '') ||
    typeof info.url !== 'string'
  )
    throw new Error('the release manifest payload is malformed')
  return info
}

/**
 * Fetch an artifact and hand back its BYTES only if they hash to `sha256`.
 *
 * Fails CLOSED, and throws rather than returning null (the kernel's variant
 * returns null because its callers have a "keep what we have" option; there is
 * no previous document to keep here, and the one thing that must not happen is
 * unverified bytes reaching a file handle).
 *
 * Bytes, deliberately — not text. The digest is over the bytes that were
 * served, so decoding to a string first and hashing that would be verifying
 * something adjacent to what we are about to write.
 */
export async function fetchPinned(net, url, sha256) {
  if (!/^[0-9a-f]{64}$/i.test(sha256 ?? '')) throw new Error('the release is not pinned to a digest')
  const res = await net(url, { cache: 'no-store', headers: ACCEPT_BYTES })
  if (!res.ok) throw new Error(`could not download the app (${res.status})`)
  const bytes = await res.arrayBuffer()
  if ((await sha256Hex(bytes)) !== sha256.toLowerCase())
    throw new Error('the downloaded app does not match the signed release — refusing it')
  return bytes
}
