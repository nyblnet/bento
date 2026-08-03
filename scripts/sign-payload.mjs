// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The ONE signing primitive for Bento's release channel.
//
// Two artifacts are signed, both with the same offline key:
//
//   releases/slides/manifest.json   the app update manifest (sign-release.mjs)
//   releases/slides/packs.json      the language-pack index (sign-packs.mjs)
//
// Both are `{ payload: "<json string>", sig: "<base64>" }`, where sig is
// ECDSA P-256 / SHA-256 over the payload STRING's UTF-8 bytes in IEEE P1363
// (raw r||s) form — the shape `crypto.subtle.verify` takes directly, so the
// shipped shell verifies either artifact with the same few lines and the same
// PUBLIC_KEY_JWK (kernel/src/update.ts).
//
// This module exists so those two are literally the same code rather than two
// copies of it. A signature scheme that drifts between artifacts is a class of
// bug nobody notices until shipped files start refusing valid releases — and
// shipped files are frozen code, so the fix would arrive too late.
//
// NOTHING here reads, writes, prints or copies the private key beyond handing
// it to node:crypto. Releases are signed locally by the maintainer; the key
// never enters the repo or CI (docs/RELEASING.md).

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Where the maintainer's offline signing key lives. Never in the repo. */
export const defaultKeyPath = () => join(homedir(), '.bento', 'release-key.json')

/** Is a signing key available on this machine? (For dry runs — never reads it.) */
export const haveKey = (keyPath = defaultKeyPath()) => existsSync(keyPath)

/**
 * Sign a payload string, returning the envelope to write.
 *
 * Self-verifies against the key file's own public half before returning, so a
 * corrupt key or a node/WebCrypto encoding mismatch fails HERE, on the
 * maintainer's machine, instead of at every shipped file in the world.
 */
export function signPayload(payload, keyPath = defaultKeyPath()) {
  if (typeof payload !== 'string') throw new Error('signPayload: payload must be the exact string to sign')
  const keyFile = JSON.parse(readFileSync(keyPath, 'utf8'))
  const bytes = Buffer.from(payload, 'utf8')
  const sig = sign('sha256', bytes, {
    key: createPrivateKey({ key: keyFile.private, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363', // WebCrypto's raw r||s format
  })
  const ok = verify('sha256', bytes, {
    key: createPublicKey({ key: keyFile.public, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  }, sig)
  if (!ok) throw new Error('self-verification failed — refusing to emit a signature this machine cannot verify')
  return { payload, sig: sig.toString('base64') }
}

/** How every signed artifact is serialised. Same bytes, both artifacts. */
export const envelopeJson = (envelope) => JSON.stringify(envelope, null, 2) + '\n'

/**
 * The public key EVERY shipped shell verifies against — read out of
 * kernel/src/update.ts rather than copied here, so a gate that says "this
 * verifies" is talking about the key the files in the wild actually hold.
 */
export function releasePublicKey() {
  const src = readFileSync(join(root, 'kernel/src/update.ts'), 'utf8')
  const m = src.match(/const PUBLIC_KEY_JWK = \{([\s\S]*?)\} as const/)
  if (!m) throw new Error('could not find PUBLIC_KEY_JWK in kernel/src/update.ts')
  const jwk = {}
  for (const [, k, v] of m[1].matchAll(/(\w+):\s*'([^']*)'/g)) jwk[k] = v
  if (jwk.kty !== 'EC' || !jwk.x || !jwk.y) throw new Error('PUBLIC_KEY_JWK in kernel/src/update.ts is not a P-256 public key')
  return jwk
}

/**
 * Verify an envelope against a public JWK — the same check the shell performs,
 * available to the publish gate so a broken artifact is caught before it is
 * served rather than by a user's failed update.
 */
export function verifyEnvelope(raw, publicJwk) {
  const { payload, sig } = JSON.parse(raw)
  if (typeof payload !== 'string' || typeof sig !== 'string') throw new Error('envelope is malformed')
  const ok = verify('sha256', Buffer.from(payload, 'utf8'), {
    key: createPublicKey({ key: publicJwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  }, Buffer.from(sig, 'base64'))
  if (!ok) throw new Error('signature is INVALID')
  return JSON.parse(payload)
}
