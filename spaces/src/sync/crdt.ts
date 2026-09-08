// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento-sync for bento/spaces — the kernel engine, bound to this app's shape.
//
// A FACADE, exactly as slides/src/sync/crdt.ts is. The engine lives in
// kernel/src/sync/crdt.ts and takes its document shape as two property names,
// so the same algebra serves both apps without either one's vocabulary living
// in the kernel. The kernel's own DocShape comment already names this binding
// (`'slides' | 'pages'`, `'elements' | 'blocks'`) — the seam was designed for
// it before there was anything to bind.

export * from '../../../kernel/src/sync/crdt.ts'

import { SyncEngine, shape } from '../../../kernel/src/sync/crdt.ts'
import type { DocShape } from '../../../kernel/src/sync/crdt.ts'

/**
 * bento/spaces: the document holds `pages`, a page holds `blocks`.
 *
 * These two strings are the whole difference between this app's engine and
 * slides'. Treat them as frozen from the first shared file: every persisted
 * SyncStateJSON and every relay frame is minted under them, so changing either
 * would fork a space from its own copies.
 *
 * Note what is NOT synced structurally here. A page's `parent` is an ordinary
 * property — the page TREE is derived at read time from that field
 * (`model.ts effectiveParents`), so the CRDT only has to agree on the flat
 * pre-order array and the parent value, and cycle repair stays a pure function
 * of the document. Trying to sync the tree as a hierarchy would put two sources
 * of truth in the file.
 */
export const SPACES_SHAPE: DocShape = shape('pages', 'blocks')

/** The engine bound to bento/spaces. */
export class SyncState extends SyncEngine {
  constructor(actor: string) {
    super(actor, SPACES_SHAPE)
  }
}
