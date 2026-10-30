// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Email addresses in the directory. The normal form is the KERNEL's
// (kernel/src/address.ts, every row in kernel/fixtures/identity-v1.json), so
// a lookup can only ever mean ONE mailbox on every host. Phase 1 is ASCII-only
// (recommended, pending the maintainer's decision on international
// addresses), with no provider folding.

import { normalizeAddress } from '../../../kernel/src/address.ts'

/** The normalised address, or null if it is refused. */
export function normalize(input) {
  if (typeof input !== 'string') return null
  const r = normalizeAddress(input)
  return r.ok ? r.address : null
}

/** The per-address storage name: never the address itself. */
export async function addressKey(normalized) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bento-dir/1/addr\n${normalized}`))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
