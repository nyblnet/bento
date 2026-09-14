// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento-sync session for bento/type — the kernel session, bound to this app.
//
// The session moved into the kernel with a small host adapter for the five
// things it could not know: what an EMPTY document is, how to clamp a view
// onto a document that changed underneath it, where a person is for presence,
// which store events an editor listens to, and what embedded media looks like.
// This file answers those five for a word processor. Everything else — the
// differ, the shadow, catch-up, gap recovery, blobs, the fork snapshot
// exchange — is shared with bento/slides and got no type-specific code at all.
//
// The differences from slides are the interesting part, and none of them are
// cosmetic:
//
//   · EMPTY means no BLOCKS, and the repair is an empty paragraph — a document
//     always has somewhere to put the caret.
//   · WHERE YOU ARE is a block id, not a slide id. It rides the wire field
//     named `slide`, which is frozen (deployed clients and the relay read it)
//     and means "where this person is".
//   · type's Store has no per-event listeners and no dirty flag; it has one
//     listener list and scoped undo. The adapter bridges that rather than
//     asking the app to grow a slides-shaped store.

export * from '../../../kernel/src/sync/session.ts';

import {
  SyncSession as KernelSession,
  type HostStore,
  type SyncHost,
} from '../../../kernel/src/sync/session.ts';
import type { Op } from '../../../kernel/src/sync/crdt.ts';
import { SyncState } from './crdt.ts';
import type { Store } from '../store.ts';

/**
 * type's Store, presented as the store the kernel session expects.
 *
 * `on` takes an EVENT in the kernel's interface and none in type's, because
 * type's editor re-renders from one signal rather than five. Only 'doc' has a
 * meaning here; the rest are accepted and dropped, which is the honest mapping
 * — an app is not obliged to have a 'slides' event.
 *
 * `onRemoteApplied` is separate from `store.on('doc', …)` on purpose: type's
 * Editor owns its contentEditable DOM directly (model.ts's caret-is-a-model-
 * position design) and never re-renders from a generic store listener — doing
 * so on every keystroke would fight the browser's own caret. `emit('doc')` is
 * called ONLY by the kernel session's `afterRemoteChange`, for a change that
 * did NOT originate from a local commit, so this is the one safe place to
 * tell the editor "the model moved under you, redraw". Exported so collab.ts
 * — the only other caller — can build the same wrapper for `startSharing` and
 * friends without duplicating it, though those never call `.emit()`.
 */
export function hostStore(store: Store, onRemoteApplied?: () => void): HostStore {
  return {
    get doc() { return store.doc; },
    on(event: string, fn: () => void) {
      return event === 'doc' ? store.on(() => fn()) : () => {};
    },
    // A remote edit repaints but must NEVER push an undo entry — see
    // Store.touch. 'doc' is the only event type has.
    emit(event: string) {
      if (event !== 'doc') return;
      store.touch();
      onRemoteApplied?.();
    },
    commit(fn: () => void) { store.commit(() => fn()); },
    // type has no dirty flag: the document is saved from the editor's own
    // state, and a remote edit does not change whether THIS person has
    // unsaved work. Accepting and ignoring beats inventing a flag nothing reads.
    setDirty() {},
  };
}

/** What a word-processing document knows that the session cannot work out. */
function typeHost(store: Store, caret: () => { block: string }, onRemoteApplied?: () => void): SyncHost {
  return {
    store: hostStore(store, onRemoteApplied),
    engine: SyncState,

    heal(): boolean {
      // A delete-everything race can leave a document with no blocks, which
      // gives the caret nowhere to live. One empty paragraph is the repair.
      if (store.doc.body.length > 0) return false;
      // DETERMINISTIC id, derived from docId. The repair is minted as an
      // ordinary local op and nothing deduplicates it, so a random id means
      // two replicas healing at once produce TWO empty paragraphs and the
      // CRDT keeps both. bento/slides tolerates that (a spare blank slide is
      // obvious and harmless); a spare empty paragraph in a contract is not —
      // it is invisible in the flow and changes the pagination.
      store.doc.body.push({ id: `heal-${store.doc.docId}`, kind: 'para', text: '' });
      return true;
    },

    clampView(): boolean {
      // Nothing to clamp: the caret is a MODEL position (block id + offset),
      // so a block that disappears is handled where the caret lives rather
      // than by an index that can point past the end. This is the payoff for
      // that decision showing up somewhere unrelated to editing.
      return false;
    },

    presence() {
      return { at: caret().block, sel: [] };
    },

    // type's editor re-renders from one signal, so a structural change needs
    // no extra events beyond the 'doc' the session already emits.
    changeEvents: ['doc'],
    structureEvents: [],
    presenceEvents: [],

    carriesMedia(ops: Op[]): boolean {
      // A type document embeds fonts and images as doc-level assets rather
      // than as element properties, so the probe is simpler than slides': any
      // data: URI in a set op is the payload that made the batch too big.
      return ops.some(o => o.op === 'set' && typeof o.v === 'string' && o.v.startsWith('data:'));
    },
  };
}

/**
 * The session bound to bento/type.
 *
 * `caret` is a callback rather than a value because presence is pushed
 * whenever the session likes; the editor owns where the caret is and should
 * not have to mirror it into the session on every keystroke.
 *
 * `onRemoteApplied`, likewise, is a callback rather than an event because
 * type's editor has no event to subscribe to for "the model changed
 * remotely" — see `hostStore` above. collab.ts passes `() => editor.render()`.
 */
export class SyncSession extends KernelSession {
  constructor(
    store: Store,
    caret: () => { block: string } = () => ({ block: '' }),
    onRemoteApplied?: () => void,
  ) {
    super(typeHost(store, caret, onRemoteApplied));
  }
}
