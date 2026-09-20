// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import { SaveQueue } from '../../kernel/src/savequeue.ts'
import type { DashDoc } from './model.ts'
import type { Store } from './store.ts'

// Toolbar, Save menu and automatic write-back share the same file handle.
const queues = new WeakMap<Store, SaveQueue<DashDoc>>()
export function saveQueue(store: Store): SaveQueue<DashDoc> {
  let queue = queues.get(store)
  if (!queue) {
    queue = new SaveQueue({ getDocument: () => store.doc, getRevision: () => store.revision })
    queues.set(store, queue)
  }
  return queue
}
