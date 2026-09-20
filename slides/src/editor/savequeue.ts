// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import type { Store } from '../store'
import type { BentoDoc } from '../model'
import { SaveQueue as KernelSaveQueue } from '../../../kernel/src/savequeue.ts'

/** Slides supplies revision tracking; kernel owns capture and write ordering. */
export class SaveQueue extends KernelSaveQueue<BentoDoc> {
  constructor(store: Store) {
    super({ getDocument: () => store.doc, getRevision: () => store.revision })
  }
}
