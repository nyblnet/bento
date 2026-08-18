// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento-sync for bento/slides — the kernel engine, bound to this app's shape.
//
// The engine itself now lives in kernel/src/sync/crdt.ts. It moved once it had
// stopped knowing what a slide is: a document shape is two property names
// (DocShape), injected at construction, so the same algebra serves
// bento/slides and bento/spaces without either app's vocabulary living in the
// kernel. Moving it BEFORE that would have parked `doc.slides` and
// `sl.elements` inside kernel/src, against kernel/README.md's own rule that
// the kernel never sees an app's content shape.
//
// THIS FILE IS A FACADE, and it stays one. Everything that imported the engine
// from this path still can — session.ts, online.ts, slides/src/model.ts's type
// reach, scripts/test-sync.ts, scripts/test-crdt-delprop.ts,
// scripts/guestbook-archivist.ts, and server/guestbook-daemon, which bundles
// `SyncState` from here through wrangler. A missing re-export does not fail
// loudly in that last one; the guestbook simply stops archiving.
//
// The pattern is slides/src/anim.ts's: app facade over kernel machinery,
// pinning this app's configuration in one place.

export * from '../../../kernel/src/sync/crdt.ts'

import { SyncEngine, shape } from '../../../kernel/src/sync/crdt.ts'
import type { DocShape } from '../../../kernel/src/sync/crdt.ts'

/**
 * bento/slides: the document holds `slides`, a slide holds `elements`.
 *
 * These two strings are the entire difference between this app's engine and
 * bento/spaces'. They are also frozen: every shipped file's persisted
 * SyncStateJSON and every frame on the deployed relay were minted under them,
 * so changing either would fork every deck in the field from its own copies.
 * scripts/test-sync-equiv.ts exists to make that impossible to do by accident.
 */
export const SLIDES_SHAPE: DocShape = shape('slides', 'elements')

/**
 * The engine bound to bento/slides.
 *
 * Constructed as `new SyncState(actor)`, exactly as before the shape existed —
 * which is what keeps the injection invisible to every consumer above.
 * bento/spaces gets its own binding the same way, and neither can be built
 * without saying which document shape it is for.
 */
export class SyncState extends SyncEngine {
  constructor(actor: string) {
    super(actor, SLIDES_SHAPE)
  }
}
