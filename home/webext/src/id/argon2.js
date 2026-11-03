// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/connect — Argon2id for the recovery code, with the parameters signed by
// security §28 (kernel/src/recovery.ts ARGON2: v0x13, p = 1, 64 MiB, t = 3,
// 32-byte tag) and nothing else.
//
// The implementation is @noble/hashes 2.4.0, vendored unmodified in
// ./vendor/noble-hashes/ and pinned file by file (VENDOR.json; the rig
// recomputes every hash). It is pure JavaScript: no WASM, so the extension
// needs no 'wasm-unsafe-eval' anywhere. (hash-wasm was the first choice; its
// Argon2id has no associated-data input, so it could not run the RFC 9106
// vector security requires.)
//
// MEMORY. Noble allocates the 64 MiB block array per derivation and zeroes it
// when the derivation ends, or aborts (its argon2Output / abort `clean`); the
// rig proves it by probe. Residual, stated: a JavaScript engine may have
// copied or moved that memory before it was zeroed (GC compaction), and that
// copy is not reachable from here.
//
// ALLOCATION FAILURE. A device that cannot spare 64 MiB gets "recovery
// unavailable on this device" (RecoveryUnavailable), never a crash and never a
// retry with weaker parameters.
//
// `argon2id` has kernel's Argon2id shape (password, salt) → 32 bytes, so it is
// what gen/recovery.js's recoveryWrapKey and recoveryVerifier take.

import { argon2idAsync } from './vendor/noble-hashes/argon2.js'
import { ARGON2 } from './gen/recovery.js'

export class RecoveryUnavailable extends Error {
  constructor() { super('recovery is unavailable on this device: it cannot allocate the memory the recovery code needs') }
  get name() { return 'RecoveryUnavailable' }
}

/** The exact options the signed parameters map to. Frozen: nothing may soften them. */
export const NOBLE_OPTS = Object.freeze({
  t: ARGON2.passes, m: ARGON2.memoryKiB, p: ARGON2.parallelism, dkLen: ARGON2.tagLength, version: ARGON2.version,
})

/** Argon2id(password, salt) with the signed parameters; `onProgress(0..1)` for the page's progress line. */
export async function argon2id(password, salt, { onProgress } = {}) {
  try {
    return await argon2idAsync(password, salt, { ...NOBLE_OPTS, asyncTick: 10, ...(onProgress ? { onProgress } : {}) })
  } catch (e) {
    if (e instanceof RangeError) throw new RecoveryUnavailable()
    throw e
  }
}
