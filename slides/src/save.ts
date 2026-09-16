// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Facade: self-save + bento/enc encryption live in the shared kernel now
// (kernel/src/save.ts). This path stays alive so slides code keeps importing
// './save' unchanged — see docs/PLATFORM.md §9.
//
// It is also where slides shapes what it hands the kernel. The save entry
// point and serializers below are shadowed — a local export wins over
// `export *` — so every path that writes a .bento.html from this app (⌘S
// write-back, the download fallback, the four export copies, and
// window.bento.serialize())
// first drops the assets nothing refers to. The kernel never learns the slides
// document shape; it is handed a document with fewer bytes in it. See
// pruneUnusedAssets for why, and for the live document being untouched.
export * from '../../kernel/src/save.ts'

import {
  saveFile as kernelSaveFile,
  serializeAuto as kernelSerializeAuto,
  serializeFile as kernelSerializeFile,
  isEncryptionActive,
} from '../../kernel/src/save.ts'
import { withStillCopy } from './still'
import type { BentoDoc } from './model'
import { pruneUnusedAssets } from './assets'
import { adoptBuiltinFonts } from './fonts'
import { stampSchema } from './schema'

function prepareForSave(doc: BentoDoc): BentoDoc {
  // …and the written JSON opens with its `$schema` pointer (schema.ts).
  return stampSchema(pruneUnusedAssets(adoptBuiltinFonts(doc)))
}

/** Encryption-aware serializer, with unreferenced assets pruned from the copy it writes. */
export async function serializeAuto(doc: BentoDoc): Promise<string> {
  // SPIKE (still-splash, option A): page one written into the splash, on the
  // serialized string. saveFile below still writes through the kernel's own
  // serializer, so ⌘S does NOT carry the still until a kernel hook exists —
  // stated in the spike handoff; the kernel is untouched here by design.
  const prepared = prepareForSave(doc)
  return withStillCopy(await kernelSerializeAuto(prepared), prepared, isEncryptionActive())
}

/** Plain serializer (tooling, window.bento.serialize), pruned the same way so
 *  a script sees the file a save would produce rather than a larger one. */
export function serializeFile(doc: BentoDoc): string {
  const prepared = prepareForSave(doc)
  return withStillCopy(kernelSerializeFile(prepared), prepared, false)
}

/** Save through the kernel after applying the same document-only transforms. */
export function saveFile(doc: BentoDoc, forcePicker = false) {
  return kernelSaveFile(prepareForSave(doc), forcePicker)
}
