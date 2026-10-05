// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// What a copy of this space is allowed to carry.
//
// Sharing a space IS sending a file — there is no server that holds the
// document and no link that grants access to it. So every question about
// permission is really a question about which fields survive the copy, and
// this module is the one place that answers it.
//
// THE FIELD THAT MATTERS. `doc.collab` is minted at CREATION for every space,
// and every field under it is a bearer capability:
//
//   room + key   the READ capability — decrypts every frame and every blob the
//                relay has ever held for this room
//   ownerPriv    the OWNER key — writes, and REVOKES anyone else, including
//                the person who sent the file
//   writerPriv   the pre-v2 room-wide write key
//   invite.priv  a delegation key: every device that opens a copy carrying it
//                mints its own member key and joins through it
//
// "Invite someone…" used to be `saveAs('copy')`, which serializes
// `store.doc` — the WHOLE document, `collab` included. Everyone invited to a
// space therefore received `ownerPriv`: they could write (intended) and they
// could revoke the person who had invited them (not intended, and not
// recoverable — the owner key is the root of trust for the room and the file
// is already on someone else's disk). The button's hint said "Saves a copy
// that joins this session", which is true and is not the whole truth.
//
// bento/slides mints a SCOPED invite instead, and this module is that same
// answer bound to a space. The two apps deliberately produce the same shapes:
// the relay verifies one wire format (docs/collab-design.md, "Phase 1 wire
// format"), and a second local description of what an invite is would be how a
// client and the deployed worker drift apart.

import { mintInvite } from '../../kernel/src/sync/online.ts'
import { collabForReader, collabForInvite } from '../../kernel/src/docfields.ts'
import type { SpacesDoc } from './model.ts'

/** A share export's filename suffix — also what the UI calls the copy. */
export type ShareKind = 'invite' | 'viewonly'

/** A deep clone, so nothing done to a copy can reach the open document. */
const clone = (doc: SpacesDoc): SpacesDoc => JSON.parse(JSON.stringify(doc)) as SpacesDoc

/** Is this copy the room's owner — the only role that can mint or revoke? */
export function isOwner(doc: SpacesDoc): boolean {
  const c = doc.collab
  return !!(c && c.v === 2 && c.owner && c.ownerPriv)
}

/**
 * May THIS COPY write to its room? The one answer every gate in spaces asks.
 *
 * An ALLOWLIST, and the shape is the point. This used to be
 * `role !== 'reader'`, which answers "yes" for every role invented after it —
 * so when the kernel added 'audience' (a live-show member whose transport is
 * receive-only), an audience copy opened in spaces got writer chrome and made
 * local commits the relay then refused. Failing CLOSED is the safe direction:
 * a future role that can write shows view-only until it is taught here, a
 * visible and harmless bug; the old shape's failure was invisible.
 *
 * Absent means writer because every file older than the role field is one —
 * the owner copy included, which is marked by `ownerPriv`, not by a role.
 * Read as an OWN property, so nothing inherited can answer for the file.
 * Same shape and name as type's (type/src/model.ts).
 */
export function copyCanWrite(collab: SpacesDoc['collab'] | undefined): boolean {
  if (!collab || typeof collab !== 'object') return false
  if (!Object.prototype.hasOwnProperty.call(collab, 'role')) return true
  return collab.role === undefined || collab.role === 'writer'
}

/** Can this copy write at all? A reader copy holds no signing key. */
export function canWrite(doc: SpacesDoc): boolean {
  return copyCanWrite(doc.collab)
}

/**
 * A copy that edits this space live — WITHOUT becoming its owner.
 *
 * The copy carries an owner-signed INVITE (a delegation keypair) in place of
 * the owner's private key. Every device that opens it mints its own member
 * key and joins through the owner → invite → member signature chain, which the
 * relay verifies while the owner is offline. Two consequences the owner keeps:
 * one device can be removed from the People list without disturbing anyone
 * else, and revoking the invite cuts off every copy descended from it.
 *
 * Strip FIRST, then delegate. The invite is the only private material an
 * editor copy may carry, and a stray `writerPriv` left over from a pre-v2 mint
 * would be a second, UNREVOKABLE way into the room.
 *
 * Returns null when this copy is not the owner: a member copy cannot mint an
 * invite, because it does not hold the key the chain is rooted in.
 */
export async function inviteCopy(doc: SpacesDoc): Promise<SpacesDoc | null> {
  const c = doc.collab
  if (!c?.room || !c.key || !isOwner(doc)) return null
  const out = clone(doc)
  // allowlist (kernel docfields): keeps room/read-key/public keys + sync, drops
  // every private half AND anything unknown; the fresh invite and the top-level
  // role come from mintInvite, never from the source.
  const invite = await mintInvite(c.ownerPriv!, 'writer')
  out.collab = { ...collabForInvite(c, invite), on: true } as SpacesDoc['collab']
  return out
}

/**
 * A copy that FOLLOWS this space and can never change it.
 *
 * It keeps the room, the read key and the public keys, and drops every private
 * half — so it decrypts everything the room holds and can sign nothing. That
 * is what makes this a real boundary rather than a hidden button: the relay
 * pins a verified key per socket, a socket that presents no key is read-only,
 * and any op batch it sends is dropped before it is stored or fanned out
 * (docs/collab-design.md, "Signed writes"). The editor lock this copy opens
 * with is a courtesy to the reader, not the enforcement.
 *
 * `sync` goes too: the stamped CRDT state is this replica's, and a viewer
 * rejoining as a fork of it would be a fork nobody can merge back.
 */
export function readerCopy(doc: SpacesDoc): SpacesDoc | null {
  const c = doc.collab
  if (!c?.room || !c.key) return null
  const out = clone(doc)
  // allowlist (kernel docfields): keeps room/read-key/public keys, forces
  // role:'reader', drops every private half, the sync stamp AND anything unknown.
  out.collab = { ...collabForReader(c), on: true } as SpacesDoc['collab']
  return out
}

/**
 * Write this replica's CRDT state into `doc.collab.sync`, immediately before
 * the document is taken for a write of THIS space — ⌘S, Save a copy, the
 * invite, and both self-update writes.
 *
 * Why it matters: a saved file that carries the state rejoins its live session
 * as a true FORK. Its registers defend the edits made while it was offline,
 * relay replay is deduplicated by version vector instead of re-applied over
 * them, and the kernel session sends a `snap` frame on rejoin that merges the
 * fork into every peer, both ways. A file saved WITHOUT it reopens as a fresh
 * adopt: its offline edits are already in the shadow, so no op is ever minted
 * for them and no peer ever sees them (scripts/test-sync-spaces-session.ts,
 * "a saved file rejoins as a fork", measures exactly that under sabotage).
 *
 * The kernel's `stampInto` already refuses a document with no session
 * (`collab` absent or `on: false`). This adds the one rule a space needs on
 * top: a store opened READ-ONLY never stamps. All three ways to get there
 * mean the file's `sync` is not ours to rewrite —
 *
 *   · frozen      written by a newer build: whatever `sync` it carries may be
 *                 a SYNC_V this build cannot read, and the format promise is
 *                 that an unknown field survives a round trip untouched
 *   · reader copy `readerCopy()` removed `sync` on purpose; a viewer that
 *                 rejoined as a fork of itself would be a fork nobody can merge
 *   · `readonly`  a sealed reading copy has no session to rejoin
 *
 * and a read-only store has made no edits of its own to defend.
 *
 * Copies that are NOT this replica never reach here and carry no state: the
 * page extract and "Copy document JSON" drop `collab` whole, "Duplicate as a
 * new space…" is a new identity (`duplicateAsNew`), and the view-only copy
 * clears `sync` in `readerCopy()`.
 */
export function stampSync(
  store: { readonly readOnly: boolean; readonly doc: SpacesDoc },
  session: { stampInto(doc: SpacesDoc): void } | null | undefined,
): void {
  if (!session || store.readOnly) return
  session.stampInto(store.doc)
}

/**
 * "Duplicate as a new space…": the same pages under a NEW identity.
 *
 * A fresh `docId` and no `collab` at all — not even the stamped `sync`. The
 * duplicate must never meet the space it came from: the docId keys the
 * same-machine channel, the room keys the relay, and the stamped state would
 * make it rejoin the ancestor's room as a fork of it. It mints credentials of
 * its own when it is first opened, exactly as a new space does.
 */
export function duplicateAsNew(doc: SpacesDoc, docId: string, now = new Date().toISOString()): SpacesDoc {
  const out = clone(doc)
  out.docId = docId
  delete out.collab
  out.modified = now
  return out
}

/**
 * Is this copy a live viewer — one that follows the session read-only?
 *
 * Distinct from `doc.readonly`, which is a SEALED reading copy with no session
 * at all. Both lock the editor; only this one keeps receiving.
 */
export function isReaderCopy(doc: SpacesDoc): boolean {
  // Every collab copy that is not an allowlisted writer — 'reader', 'audience',
  // and any role not yet invented. No collab at all is a plain file: editable.
  return !!doc.collab && !copyCanWrite(doc.collab)
}

/**
 * A short, readable fingerprint of a public key.
 *
 * Rendered identically in both apps on purpose: two people comparing codes
 * over a call are verifying an identity out-of-band, and a code that is
 * grouped differently in each app is a code they cannot compare.
 */
export const fingerprint = (pub?: string): string =>
  pub ? `${pub.slice(0, 4)}·${pub.slice(4, 8)}·${pub.slice(8, 12)}` : ''
