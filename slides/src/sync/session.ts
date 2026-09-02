// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento-sync session for bento/slides — the kernel session, bound to this app.
//
// A FACADE, like crdt.ts beside it. The session moved to
// kernel/src/sync/session.ts once it had stopped knowing what a slide is:
// of its 727 lines, FIVE places did, and they are the five implemented below.
// Everything else — the differ hook, the shadow, presence, catch-up, gap
// recovery, blobs, the fork snapshot exchange — was already generic.
//
// Behaviour is pinned by scripts/test-sync-session.ts, which was written
// against this file BEFORE the move and run unchanged after it.

export * from '../../../kernel/src/sync/session.ts';

import { SyncSession as KernelSession, type SyncHost } from '../../../kernel/src/sync/session.ts';
import type { Op } from './crdt';
import { SyncState } from './crdt';
import { uid } from '../model';
import type { Slide } from '../model';
import type { Store, ViewSnapshot } from '../store';

/** What a deck knows about itself that the session cannot work out. */
function slidesHost(store: Store): SyncHost {
  return {
    store,
    engine: SyncState,

    heal(): boolean {
      // an all-slides-deleted race leaves an empty deck — heal with a blank
      //
      // The id is RANDOM here, deliberately and unlike the other apps: the
      // repair is minted as a local op and nothing deduplicates it, so two
      // concurrent healers make two blank slides. That was the shipped
      // behaviour before this moved to the kernel and it stays — a spare blank
      // slide is visible in the sidebar and deleted in one click. An app where
      // the duplicate is INVISIBLE (a paragraph, a page) must derive the id
      // from docId instead; see the heal() contract in the kernel.
      if (store.doc.slides.length > 0) return false;
      const blank: Slide = {
        id: uid('s'),
        background: store.doc.theme.background,
        transition: 'fade',
        elements: [],
        notes: '',
      };
      store.doc.slides.push(blank);
      return true;
    },

    // The store owns this pair; the shape only forwards. Clamping after the
    // fact used to live here and was wrong in one specific way: when someone
    // else deleted a DIFFERENT slide, min()-ing the index moved this tab to
    // whatever slid into the slot. captureView records the slide IDS first, so
    // reconcileView can keep the same slide when it survives and choose the
    // nearest surviving neighbour when it does not (#262).
    captureView(): unknown {
      return store.captureView();
    },

    clampView(view?: unknown): boolean {
      const { currentChanged, selectionChanged } = store.reconcileView(view as ViewSnapshot);
      if (currentChanged) store.emit('current');
      return selectionChanged;
    },

    presence() {
      return { at: store.slide?.id ?? '', sel: store.selection.slice() };
    },

    changeEvents: ['doc'],
    structureEvents: ['slides', 'current'],
    presenceEvents: ['current', 'selection'],

    carriesMedia,
  };
}

/**
 * Does a refused op batch carry embedded media? A frame big enough to be
 * refused is nearly always a pasted photo or clip, and naming it is the
 * difference between a message the user can act on and one they can't.
 * Structural probe only — a refused batch can be megabytes, so nothing here
 * re-serializes or walks deep into it.
 *
 * App-shaped: `type: 'image' | 'media'` with a `src` is what an embedded blob
 * looks like in a DECK. A word processor's would look nothing like it.
 */
function carriesMedia(ops: Op[]): boolean {
  const isData = (v: unknown): boolean => typeof v === 'string' && v.startsWith('data:');
  const inEl = (n: unknown): boolean => {
    const el = n as { type?: string; src?: unknown } | null;
    return !!el && (el.type === 'image' || el.type === 'media') && isData(el.src);
  };
  return ops.some((o) => {
    if (o.op === 'set') return isData(o.v); // element src, or a doc-level assets.<k>
    if (o.op === 'ins') {
      const node = o.node as { elements?: unknown[] };
      return inEl(o.node) || !!node.elements?.some(inEl);
    }
    return false;
  });
}

/**
 * The session bound to bento/slides.
 *
 * Constructed as `new SyncSession(store)`, exactly as before the host existed
 * — which is what keeps the seam invisible to editor.ts and everything else
 * that already builds one.
 */
export class SyncSession extends KernelSession {
  constructor(store: Store) {
    super(slidesHost(store));
  }
}
