// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The reading copy: a space handed to somebody who is only going to read it.
//
// THE PRODUCT DECISION. A space is already the whole artifact — the pages, the
// reader and the editor in one file — so "publishing" one has never needed a
// server. What it needed was a file you can hand over without also handing over
// the workspace: the editing tools, the half-finished conversations in the
// margins, and the keys to the live room.
//
// HOW MANY TIERS. bento/slides has three (docs/DECISIONS.md, "Signed writes /
// read-only tiers"): a presentation package, a live read-only viewer, and a
// writer. Spaces already carries all three shapes, and they were settled before
// this file existed:
//
//   `doc.readonly`            a SEALED file — no session, opens locked
//   `collab.role: 'reader'`   a LIVE viewer — follows the room, can never write
//   (neither)                 a writer
//
// So this module adds NO tier. It builds the sealed one, which was declared in
// the format, honoured by `main.ts`, and reachable from no button in the app —
// the one property a sender could choose was the one they had to hand-edit the
// JSON to set. Adding a fourth ("published", say) would mean two fields meaning
// the same thing, and old files would answer only one of them.
//
// WHAT IS ACTUALLY GUARANTEED, in three honest categories. This app's history
// says the failure worth naming is presenting a cosmetic guarantee as
// protection, so:
//
//   CRYPTOGRAPHIC. `doc.collab` is deleted outright, so the copy carries no
//     `key` (the read capability for every frame and blob the relay holds for
//     the room), no `ownerPriv`, no `writerPriv` and no `invite.priv`. The
//     recipient cannot read the room, cannot write to it, and cannot join it —
//     not because the UI declines, but because the material a socket must
//     present to the relay is not in the file. This is the same boundary
//     `share.ts` draws for an invite, drawn further: an invite keeps `room` +
//     `key` because it is MEANT to follow; a reading copy is sealed, so it
//     keeps nothing.
//
//   FORMAT-LEVEL. Comments are gone from the bytes. A reading copy that merely
//     hid them would still be a file whose JSON block contains every remark
//     anyone made about the draft, and the app invites people to read that
//     block. Deleting them is not enforcement of anything — it is the copy
//     genuinely not containing them, which is the only version of "comments are
//     workspace, not publication" that survives someone opening the file in a
//     text editor.
//
//   COSMETIC. `doc.readonly` itself, and every piece of chrome the reading view
//     hides. Anyone can open the HTML, change `"readonly":true` to `false`, and
//     have the editor back — the document block is deliberately plaintext and
//     that is the point of the whole format. `readonly` states the sender's
//     intent and makes the app honour it; it is NOT a lock, it protects
//     nothing, and it must never be described as though it did. What stops a
//     recipient reaching the live space is the previous paragraph, not this one.
//
// AN OLDER BUILD OPENING A READING COPY does not fail: `readonly` is an
// optional boolean it either ignores (builds before main.ts read it) or
// honours. It opens the space, editable in the oldest builds. That is the
// correct degradation, and it is exactly why the guarantee that matters is
// removal rather than a flag — bytes that are not in the file are not in the
// file whatever opens it.
//
// ENCRYPTED SPACES. Nothing here touches encryption, deliberately. A reading
// copy is written through `serializeAuto` like every other export, so a copy
// taken out of a password-protected space is written encrypted with the same
// password and its reader meets the password gate before the reading view —
// and, because `previewAllowed` (kernel/src/save.ts) refuses a preview for an
// encrypted body, it carries no still render either. A plaintext home page
// sitting beside the ciphertext is the leak the password exists to prevent, and
// a reading copy — the one file most likely to be sent to a stranger — is the
// last place to make that exception.

import type { SpacesDoc, Page } from './model'
import { stripCollabSecrets } from './share'
import { stripRecord } from './trail.ts'
import { t } from './i18n'

/** Is this file one that was saved for reading? */
export function isReadingCopy(doc: SpacesDoc): boolean {
  return doc.readonly === true
}

/** A deep clone, so nothing done to a copy can reach the open document. */
const clone = (doc: SpacesDoc): SpacesDoc => JSON.parse(JSON.stringify(doc)) as SpacesDoc

/**
 * Seal a copy of this space for reading.
 *
 * Order matters only in that it is all removal: set the one flag, then take
 * away everything a publication has no business carrying. `stripCollabSecrets`
 * with no `keepRoom` deletes `doc.collab` entirely — it is share.ts's list, not
 * a second copy of it, because a private field added to `CollabCreds` later
 * must be covered here without anyone remembering to act.
 *
 * `stripRecord` is here for the same reason and was MISSING until 2026-09-11.
 * trail.ts has said since it landed that "a reading copy carries none of it
 * (`stripRecord`)" — and `stripRecord` had exactly one call site, in
 * portable.ts's page extract. So every reading copy ever written carried
 * `doc.trail` and `doc.periods`: not the pages, not the comments, not the keys,
 * but the cadence — which days the file was touched, which weeks nothing moved,
 * work on a Sunday — under a field name nobody would think to look at, in the
 * one file most likely to be sent to a stranger.
 *
 * Found by writing a starter page that invited the reader to CHECK the claim,
 * which is the whole argument for falsifiable documentation: the sentence
 * "comments and the record are gone, go and look" cannot be written without
 * somebody going and looking.
 */
export function readingCopy(doc: SpacesDoc): SpacesDoc {
  const out = clone(doc)
  out.readonly = true
  // no keepRoom: room + key together ARE the read capability, and a sealed copy
  // follows nothing, so there is nothing for them to be for.
  stripCollabSecrets(out)
  stripComments(out)
  stripRecord(out)
  return out
}

/**
 * Every comment thread, gone from the document.
 *
 * There are exactly two anchors in the format (model.ts): `Page.comments` is a
 * thread about the page, `Block.comments` a thread about that block. Both go.
 * The starter space says out loud that a comment is saved in the file and that
 * anyone you send it to can read it — this is the export where that stops being
 * the reader's problem.
 */
export function stripComments(doc: SpacesDoc): void {
  for (const page of doc.pages ?? []) {
    delete page.comments
    for (const b of page.blocks ?? []) delete b.comments
  }
}

/**
 * The page before this one and the page after it, in the tree's reading order.
 *
 * `doc.pages` is flat and PRE-ORDER (model.ts), so the reading order is simply
 * the array: a child always follows its parent, and a sibling follows the whole
 * of the previous sibling's subtree. Walking it as a tree here would rebuild
 * that ordering and could only ever disagree with the sidebar.
 */
export function readingNeighbours(
  doc: SpacesDoc, pageId: string,
): { prev?: Page; next?: Page } {
  const pages = doc.pages ?? []
  const i = pages.findIndex((p) => p.id === pageId)
  if (i < 0) return {}
  return { prev: pages[i - 1], next: pages[i + 1] }
}

/**
 * The reader's footer: what came before, what comes next.
 *
 * A reading copy has no sidebar affordances to add a page and no gutters to
 * hover, so without this the only way through a space of forty pages is the
 * tree — which is a table of contents, not a way of reading. Slides gives a
 * presented deck arrow keys for the same reason.
 *
 * Returns null for a one-page space, where a nav with both ends empty is just
 * a rule across the bottom of the page.
 */
export function readerNav(
  doc: SpacesDoc, pageId: string, go: (id: string) => void,
): HTMLElement | null {
  const { prev, next } = readingNeighbours(doc, pageId)
  if (!prev && !next) return null

  const nav = document.createElement('nav')
  nav.className = 'sp-rnav'
  nav.setAttribute('aria-label', t('Pages'))

  const end = (page: Page | undefined, dir: 'prev' | 'next') => {
    if (!page) {
      // A spacer, so "next" stays on the end edge when there is no "previous".
      nav.append(Object.assign(document.createElement('span'), { className: 'sp-rnav-gap' }))
      return
    }
    const a = document.createElement('a')
    a.className = `sp-rnav-link sp-rnav-${dir}`
    a.href = `#p/${page.id}`
    const kicker = document.createElement('span')
    kicker.className = 'sp-rnav-kicker'
    // LITERALS, both of them: `t(MAP[dir])` would reach no catalog while the
    // packer happily reported a full sweep.
    kicker.textContent = dir === 'prev' ? t('Previous') : t('Next')
    const label = document.createElement('span')
    label.className = 'sp-rnav-title'
    label.textContent = page.title || t('Untitled')
    a.append(kicker, label)
    a.addEventListener('click', (e) => { e.preventDefault(); go(page.id) })
    nav.append(a)
  }

  end(prev, 'prev')
  end(next, 'next')
  return nav
}
