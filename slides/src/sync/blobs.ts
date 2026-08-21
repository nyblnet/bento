// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Blob storage for bento-sync — A FACADE. The implementation is the kernel's.
//
// It moved unchanged: this file never imported anything from the app. Large
// media travels out-of-band (the relay stores ciphertext by content key) and
// nothing in that mechanism knows what a slide is, so there was nothing to
// parameterize — unlike session.ts, which needed a host adapter first.
//
// The path stays valid because scripts/test-blobs.ts and session.ts import it
// from here.

export * from '../../../kernel/src/sync/blobs.ts';
