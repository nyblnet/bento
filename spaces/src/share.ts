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
import type { SpacesDoc } from './model.ts'

/** A share export's filename suffix — also what the UI calls the copy. */
export type ShareKind = 'invite' | 'viewonly'

/**
 * Take the live session out of a copy that is about to leave this machine.
 *
 * ONE list, in one place, and DERIVED BY DELETING rather than by rebuilding
 * the block from an allow-list: a private field added to `CollabCreds` later
 * is covered here without anyone remembering to act. Divergent per-export
 * copies of this list are how one export path ends up leaking what the other
 * three strip — slides wrote that sentence after it happened.
 *
 * The default is to drop `collab` outright: a template, a page extract or the
 * JSON on the clipboard must not join anything, and `room` + `key` together
 * ARE the read capability. `keepRoom` is for the copies that are MEANT to
 * follow the session — they keep the room, the symmetric read key and the
 * PUBLIC keys, and lose only the private halves.
 *
 * Note what `keepRoom` does NOT do: it never adds a capability. An invite is
 * added afterwards, deliberately and visibly, by `inviteCopy()`.
 */
export function stripCollabSecrets(doc: SpacesDoc, opts: { keepRoom?: boolean } = {}): void {
  if (!doc.collab) return
  if (!opts.keepRoom) {
    delete doc.collab
    return
  }
  delete doc.collab.writerPriv // the muzzle — no room-wide write capability travels
  delete doc.collab.ownerPriv // …nor the owner key, which can also revoke…
  delete doc.collab.invite //    …nor any invite (delegation) material we hold
}

/** A deep clone, so nothing done to a copy can reach the open document. */
const clone = (doc: SpacesDoc): SpacesDoc => JSON.parse(JSON.stringify(doc)) as SpacesDoc

/** Is this copy the room's owner — the only role that can mint or revoke? */
export function isOwner(doc: SpacesDoc): boolean {
  const c = doc.collab
  return !!(c && c.v === 2 && c.owner && c.ownerPriv)
}

/** Can this copy write at all? A reader copy holds no signing key. */
export function canWrite(doc: SpacesDoc): boolean {
  return !!doc.collab && doc.collab.role !== 'reader'
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
  stripCollabSecrets(out, { keepRoom: true })
  out.collab!.invite = await mintInvite(c.ownerPriv!, 'writer')
  out.collab!.on = true
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
  out.collab = { ...c, role: 'reader', on: true, sync: undefined }
  stripCollabSecrets(out, { keepRoom: true })
  return out
}

/**
 * Is this copy a live viewer — one that follows the session read-only?
 *
 * Distinct from `doc.readonly`, which is a SEALED reading copy with no session
 * at all. Both lock the editor; only this one keeps receiving.
 */
export function isReaderCopy(doc: SpacesDoc): boolean {
  return doc.collab?.role === 'reader'
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
