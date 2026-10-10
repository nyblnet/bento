// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento-sync session for bento/spaces — the kernel session, bound to this app.
//
// A FACADE, like crdt.ts beside it. The engine, the transport, the differ, the
// shadow, catch-up, gap recovery, blobs and the fork snapshot exchange all live
// in kernel/src/sync/. What is left here is the five things the kernel cannot
// know: what "empty" means for a space, where the reader is when the document
// changes underneath them, what presence reports, which store events a remote
// change should raise, and what embedded media looks like in an op batch.
//
// The kernel's SyncHost comment says a word processor answers all five
// differently. So does a notes app, and three of the five below are NOT what
// the slides binding does.

export * from '../../../kernel/src/sync/session.ts'

import { SyncSession as KernelSession, type SyncHost } from '../../../kernel/src/sync/session.ts'
import type { Op } from '../../../kernel/src/sync/crdt.ts'
import { SyncState } from './crdt.ts'
import { homePage, type Block, type Page } from '../model.ts'
import type { Store } from '../store.ts'

/** Where this tab was looking, recorded BEFORE a remote change lands. */
interface ViewSnapshot {
  /** the page being read, by identity */
  pageId: string
  /** its ancestors, nearest first — the fallback when the page itself dies */
  ancestors: string[]
  /** selected block ids, by identity */
  sel: string[]
}

/**
 * The id of the page `heal()` mints.
 *
 * DERIVED, never generated. The kernel's heal() contract is explicit that the
 * repair is minted as an ordinary local op and nothing deduplicates it: two
 * replicas that heal at the same moment mint two nodes and the CRDT keeps
 * both. In a deck a spare blank slide is visible in the sidebar and deleted in
 * one click, which is why slides tolerates a random id. A spare page in a
 * space is a phantom — it sits in the tree with no content and nothing says
 * where it came from.
 *
 * The contract suggests `docId`. THIS APP MUST NOT USE IT, and the reason is
 * already written down beside `repairId` in model.ts: `template: true` re-mints
 * `docId` on every open, so a docId-derived id gives two readers of one file
 * DIFFERENT ids — the exact failure that derivation exists to prevent.
 *
 * The room is the right seed instead. Every replica that can race to heal is
 * by definition in the same room, the value is identical for all of them by
 * construction, and it does not move when a template is opened. Falling back
 * to docId is safe precisely because a document with no room has no second
 * replica to disagree with.
 */
function healId(store: Store): string {
  const collab = store.doc.collab as { room?: string } | undefined
  return `heal-${collab?.room || store.doc.docId || 'space'}`
}

/** The ancestor chain of a page, nearest first, cycle-safe. */
function ancestorsOf(store: Store, id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  let cur = store.doc.pages.find((p) => p.id === id)?.parent ?? ''
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    out.push(cur)
    cur = store.doc.pages.find((p) => p.id === cur)?.parent ?? ''
  }
  return out
}

/** What a space knows about itself that the session cannot work out. */
function spacesHost(store: Store): SyncHost {
  return {
    store,
    engine: SyncState,

    heal(): boolean {
      // "Empty" for a space is ZERO PAGES — not an empty page, and NOT a
      // dangling `doc.home`: model.ts homePage() already falls back to
      // pages[0], so a home pointing at a deleted page degrades correctly on
      // its own and needs no repair op.
      if (store.doc.pages.length > 0) return false
      const page: Page = { id: healId(store), title: '', blocks: [] }
      store.doc.pages.push(page)
      store.doc.home = page.id
      return true
    },

    // Spaces navigates by page IDENTITY (`#p/<id>`), so there is no index to
    // clamp — the question is only whether the page you are reading still
    // exists. Captured BEFORE the apply because afterwards the answer is gone.
    captureView(): unknown {
      const snap: ViewSnapshot = {
        pageId: store.pageId,
        ancestors: ancestorsOf(store, store.pageId),
        sel: store.selection.slice(),
      }
      return snap
    },

    clampView(view?: unknown): boolean {
      // FIRST, and before anything reads the index. A remote apply writes
      // straight to `doc` — deliberately, so it never joins this person's undo
      // stack — which leaves `store.index` describing the document as it was.
      // Every `block(id)` and `page` read after that answers from the stale
      // copy: measured, a block that HAD arrived in `doc.pages[0].blocks` was
      // invisible to `store.block(id)` until this call. It is why store.ts
      // makes reindex() public.
      store.reindex()

      const snap = view as ViewSnapshot | undefined
      const live = (id: string): boolean => store.index.page.has(id)
      const before = store.selection

      // PARENT-FIRST, and this is the whole reason clampView is not just
      // reindex(). When somebody else deletes the subtree you are reading,
      // reindex()'s fallback sends you to the home page — out of the part of
      // the space you were working in. The nearest surviving ANCESTOR is where
      // a reader expects to surface, and only when the whole chain is gone is
      // home the honest answer.
      if (snap && !live(snap.pageId)) {
        const near = snap.ancestors.find(live) ?? homePage(store.doc)?.id ?? ''
        if (near && near !== store.pageId) {
          store.pageId = near
          store.emit('page')
          store.emit('tree')
        }
      }

      // Blocks someone else deleted must leave the selection, or the next
      // action operates on ids that are not in the document.
      const kept = before.filter((id) => !!store.block(id))
      if (kept.length !== before.length) {
        store.selection = kept
        return true
      }
      return false
    },

    presence() {
      // The PAGE, never the block. A block-level cursor would republish
      // presence at typing speed — store.ts's typing run exists precisely
      // because a notes app may never blur — while a page changes only when
      // somebody navigates, which is the rate presence is worth.
      return { at: store.pageId, sel: store.selection.slice() }
    },

    // 'doc' is NOT a repaint signal in this app: editor.ts binds it to
    // status('Edited') + the unsaved dot + the undo buttons, so raising it for
    // a remote op would credit a colleague's typing to this user. The dot is
    // handled separately by the kernel's own setDirty(), which store.ts routes
    // to a 'dirty' event.
    //
    // But EVERY remote change still has to repaint, not just structural ones.
    // changeEvents was empty at first and a remote text edit then landed in the
    // model while the screen kept the old words — measured in two browser tabs:
    // `block.html` was the new sentence and the DOM was still the old one. Only
    // page-level structure (a new page, a delete) was repainting, because those
    // are the changes that happen to be flagged structural.
    //
    // 'page' is the repaint: editor.ts binds it to paintPage + paintTree, and
    // it carries no status text. 'tree' on top of it is what a structural
    // change needs when the current page is not the one that moved.
    changeEvents: ['page'],
    structureEvents: ['tree'],
    presenceEvents: ['page', 'selection'],

    carriesMedia,
  }
}

/**
 * Does a refused op batch carry embedded media?
 *
 * Structural probe only — a refused batch can be megabytes, so nothing here
 * re-serializes it or walks deep. App-shaped: in a SPACE an embedded blob is a
 * block with `type: 'image'` and a data: `src`, or a doc-level `assets.<key>`
 * (model.ts: `assets?: Record<string, string>`, content-addressed).
 *
 * The point is a message somebody can act on: "that image is too big to send"
 * rather than "the update was refused". Large assets travel out-of-band and
 * the relay stays blind (docs/DECISIONS.md, 2026-07-25) — this only names what
 * failed when one slips into a frame.
 */
function carriesMedia(ops: Op[]): boolean {
  const isData = (v: unknown): boolean => typeof v === 'string' && v.startsWith('data:')
  const inBlock = (n: unknown): boolean => {
    const b = n as Block | null
    return !!b && b.type === 'image' && isData(b.src)
  }
  return ops.some((o) => {
    if (o.op === 'set') return isData(o.v) // block src, or a doc-level assets.<k>
    if (o.op === 'ins') {
      const node = o.node as { blocks?: unknown[] }
      return inBlock(o.node) || !!node.blocks?.some(inBlock)
    }
    return false
  })
}

/**
 * The session bound to bento/spaces.
 *
 * Constructed as `new SyncSession(store)`, the same shape slides uses, so the
 * editor never sees the host.
 */
export class SyncSession extends KernelSession {
  constructor(store: Store) {
    super(spacesHost(store))
  }
}
