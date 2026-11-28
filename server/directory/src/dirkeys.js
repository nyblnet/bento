// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// What the directory hands a kernel verifier that it cannot read off the
// statement itself: a passkey assertion's signature counter. (Its own
// countersign keys, under which a stored chain verifies, are consent.js
// chainOpts: one key set, with the consent rp, for every chain check.) A
// kernel member proof never compares counters (a peer sees links out of
// order), so wherever the directory accepts a member's assertion through a
// kernel verifier it reads the counter here and keeps the stored one moving
// forward itself (security's D6 on #953).

import { b64uDec } from '../../../kernel/src/statements.ts'

/** An assertion's signature counter (authenticator data bytes 33-36), or null when it does not read. */
export function signCountOf(assertion) {
  const ad = assertion && typeof assertion.authenticatorData === 'string' ? b64uDec(assertion.authenticatorData) : null
  return ad && ad.length >= 37 ? ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36] : null
}
