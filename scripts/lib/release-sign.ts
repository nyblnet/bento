// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A throwaway release channel, for rigs that have to exercise verification.
//
// The real signing key is offline by design (docs/RELEASING.md) and never
// reaches CI, so a rig cannot produce a manifest the shipped public key will
// accept. It can produce a whole channel of its own instead: generate a
// keypair, sign payloads with the private half, and hand the public half to the
// verifier through the same test seam that already substitutes `fetch`.
//
// That covers everything EXCEPT "is the embedded key the real one, and is the
// envelope still shaped the way the server shapes it" — which is precisely the
// half a self-consistent fixture cannot prove, and precisely the half that was
// wrong. `scripts/fixtures/release-manifest-slides.json` is a real manifest
// captured from https://bento.page/releases/slides/manifest.json for that, and
// it verifies against the SHIPPED key with no seam involved.

import { readFileSync } from 'node:fs'

export type Signer = {
  /** Public half, in the JWK shape the verifiers embed. */
  jwk: { kty: string; crv: string; x: string; y: string }
  /** Sign a payload object → the `{payload, sig}` envelope, as served text. */
  envelope(payload: unknown): Promise<string>
}

export async function releaseSigner(): Promise<Signer> {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  ) as CryptoKeyPair
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return {
    jwk: { kty: pub.kty!, crv: pub.crv!, x: pub.x!, y: pub.y! },
    async envelope(payload: unknown) {
      // Signed over the payload's exact bytes AS A STRING — the same reason the
      // envelope carries a string rather than an object. A rig that re-encoded
      // here would pass while the real thing failed.
      const text = JSON.stringify(payload)
      const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey,
        new TextEncoder().encode(text),
      )
      return JSON.stringify({ payload: text, sig: Buffer.from(sig).toString('base64') })
    },
  }
}

/** Lowercase hex sha256 — what every pin in this project is written as. */
export const sha256Hex = async (bytes: BufferSource): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0')).join('')

/** A real manifest, as the release origin actually served it. */
export const realManifest = (): string =>
  readFileSync(new URL('../fixtures/release-manifest-slides.json', import.meta.url), 'utf8')
