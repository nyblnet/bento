// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Facade: self-save + bento/enc encryption live in the shared kernel now
// (kernel/src/save.ts). This path stays alive so slides code keeps importing
// './save' unchanged — see docs/PLATFORM.md §9.
//
// It is also where slides shapes what it hands the kernel. The two
// serializers below are shadowed — a local export wins over `export *` — so
// every path that writes a .bento.html from this app (⌘S write-back, the
// download fallback, the four export copies, and window.bento.serialize())
// first drops the assets nothing refers to. The kernel never learns the slides
// document shape; it is handed a document with fewer bytes in it. See
// pruneUnusedAssets for why, and for the live document being untouched.
export * from '../../kernel/src/save.ts'

import { serializeAuto as kernelSerializeAuto, serializeFile as kernelSerializeFile } from '../../kernel/src/save.ts'
import type { BentoDoc } from './model'
import { pruneUnusedAssets } from './assets'

/** Encryption-aware serializer, with unreferenced assets pruned from the copy it writes. */
export function serializeAuto(doc: BentoDoc): Promise<string> {
  return kernelSerializeAuto(pruneUnusedAssets(doc))
}

/** Plain serializer (tooling, window.bento.serialize), pruned the same way so
 *  a script sees the file a save would produce rather than a larger one. */
export function serializeFile(doc: BentoDoc): string {
  return kernelSerializeFile(pruneUnusedAssets(doc))
}
