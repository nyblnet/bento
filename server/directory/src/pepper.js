// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The directory's pepper layer over the recovery verifier and the code-wrapped
// blob. Every derivation is the KERNEL's (kernel/src/recovery.ts, with vectors
// in kernel/fixtures/recovery-v1.json); this module only re-exports it.

export { pepperKeys, pepperOpen, pepperSeal, pepperVerifierTag } from '../../../kernel/src/recovery.ts'
