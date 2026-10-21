// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The directory's side of the bento/id signed statements. Every layout and
// every verifier is the KERNEL's (kernel/src/statements.ts, bento/id K2), so
// the directory, every agent and every client check with one implementation,
// and kernel/fixtures/identity-v1.json is the contract native hosts pass. This
// module only adds what is the directory's alone: its online signing key, and
// signing the attestations and tombstones it serves.

import { buildAtt, buildTomb, signStatement } from '../../../kernel/src/statements.ts'

export {
  b64uEnc, buildBind, buildCmp, buildDel, sha256b64u as hashOf,
  verifyBind, verifyCmp, verifyDel,
} from '../../../kernel/src/statements.ts'

/**
 * `att.<hash(bind)>.<verifiedAt>.<issuedAt>.<kid>.<state>`, signed with the
 * directory's ONLINE key (a Worker secret, never the release key). issuedAt is
 * fresh on every answer, so a client can age-check a replayed one; the state is
 * inside the signature, so an answer can't be replayed as "active" during a
 * freeze.
 */
export async function attest(dirKey, kid, bindHash, verifiedAt, issuedAt, state = 'active') {
  const text = buildAtt({ bindHash, verifiedAt, issuedAt, kid, state })
  return { text, sig: await signStatement(dirKey, text) }
}

/** `tomb.<hash(last bind)|empty>.<seq>.<deletedAt>.<by>.<kid>`, directory-signed. */
export async function tombstone(dirKey, kid, lastBindHash, seq, deletedAt, by) {
  const text = buildTomb({ lastBindHash, seq, deletedAt, by, kid })
  return { text, sig: await signStatement(dirKey, text) }
}

/** Import the directory's private signing key from its JWK (a Worker secret). */
export async function importDirKey(jwkText) {
  return crypto.subtle.importKey('jwk', JSON.parse(jwkText), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}
