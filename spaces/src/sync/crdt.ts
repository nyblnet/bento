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
import { DOC_MAPS } from '../trail.ts'

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
/**
 * `DOC_MAPS` are the doc-level keys merged PER KEY rather than as one value.
 *
 * `doc.trail` is the reason: an array — or a whole-map register — would make
 * two people working on the same day into one last-writer-wins register, and
 * one of them would silently lose their row. Per key, Monday's row and
 * Tuesday's row are separate registers and both survive any interleaving. The
 * SAME day still resolves last-writer-wins and that is acceptable here and only
 * here, because a row is not authored content: both replicas counted over
 * nearly the same document, so LWW picks one truthful sample rather than losing
 * an edit. `doc.periods` rides along for the same reason — two people defining
 * different periods in one week must both keep theirs.
 *
 * The list is trail.ts's, not a second copy: `model.ts parseDoc` folds dotted
 * keys back using the same names, and two copies of that list is exactly how
 * the hazard and its mitigation drift apart.
 */
export const SPACES_SHAPE: DocShape = shape('pages', 'blocks', 'html', DOC_MAPS)

/** The engine bound to bento/spaces. */
export class SyncState extends SyncEngine {
  constructor(actor: string) {
    super(actor, SPACES_SHAPE)
  }
}
