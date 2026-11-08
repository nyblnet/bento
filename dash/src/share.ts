// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// What a copy of this workbook is allowed to carry, when it is for someone else.
//
// Sharing a workbook IS sending a file: there is no server holding the
// document and no link granting access to it. So every permission question is
// a question about which fields survive the copy, and this module answers it —
// for the three copies the Share popover makes:
//
//   reading    a SEALED copy: the workbook, read-only, with no collaboration
//              block at all. It never joins anything. (The kernel's `package`
//              tier.) This is what "Save read-only copy…" always made.
//   invite     a copy that edits this workbook live WITHOUT becoming its owner:
//              an owner-signed INVITE keypair travels in place of the owner's
//              private key, and every device that opens it mints its own member
//              key. The owner can remove one device from People, or Reset
//              access to cut every copy off.
//   viewonly   a live FOLLOWER: the room and the read key, no private half. The
//              relay drops any op it sends, so the boundary is real rather than
//              a hidden button. It opens read-only.
//
// Every builder goes through the kernel's copy table (projectForCopy) with
// dash's field map, so a field this build has never heard of is DROPPED from
// all three — fail closed — and the collab block is projected through the
// kernel's allowlists. Same shapes as spaces' and slides' share.ts on purpose:
// the relay verifies one wire format.

import { projectForCopy } from '../../kernel/src/docfields.ts'
import { mintInvite } from './sync/online.ts'
import { DASH_FIELDS } from './docclass.ts'
import type { DashDoc } from './model.ts'

export type ShareKind = 'reading' | 'invite' | 'viewonly'

/** A deep clone, so nothing done to a copy can reach the open workbook. */
const clone = (doc: DashDoc): DashDoc => JSON.parse(JSON.stringify(doc)) as DashDoc

interface CollabLike { room?: string; key?: string; v?: number; owner?: string; ownerPriv?: string; role?: string; on?: boolean }
const collabOf = (doc: DashDoc): CollabLike | undefined =>
  doc.collab && typeof doc.collab === 'object' ? doc.collab as CollabLike : undefined

/** Is this copy the room's owner — the only role that can invite or revoke? */
export function isOwner(doc: DashDoc): boolean {
  const c = collabOf(doc)
  return !!(c && c.v === 2 && c.owner && c.ownerPriv)
}

/**
 * May THIS copy write to its room? An ALLOWLIST that fails closed — the same
 * answer `copyCanWrite` gives in sync/online.ts, asked of the whole document.
 */
export function canWrite(doc: DashDoc): boolean {
  const c = collabOf(doc)
  if (!c) return true
  if (!Object.prototype.hasOwnProperty.call(c, 'role')) return true
  return c.role === undefined || c.role === 'writer'
}

/** A collab copy that is not an allowlisted writer: it follows, it never sends. */
export function isReaderCopy(doc: DashDoc): boolean {
  return !!collabOf(doc) && !canWrite(doc)
}

/** The sealed reading copy: read-only, no collab, nothing unknown. */
export function readingCopy(doc: DashDoc): DashDoc {
  return projectForCopy(clone(doc), DASH_FIELDS, 'package')
}

/**
 * The editor copy. Null when this copy is not the owner — a member holds no
 * key to root the invite chain in, and handing back anything else would leak.
 */
export async function inviteCopy(doc: DashDoc): Promise<DashDoc | null> {
  const c = collabOf(doc)
  if (!c?.room || !c.key || !isOwner(doc)) return null
  const invite = await mintInvite(c.ownerPriv!, 'writer')
  const out = projectForCopy(clone(doc), DASH_FIELDS, 'invite', { invite })
  // the copy is live from the moment it opens
  if (out.collab) (out.collab as CollabLike).on = true
  return out
}

/** The view-only follower. Null when there is no room to follow. */
export function readerCopy(doc: DashDoc): DashDoc | null {
  const c = collabOf(doc)
  if (!c?.room || !c.key) return null
  const out = projectForCopy(clone(doc), DASH_FIELDS, 'reader')
  if (out.collab) (out.collab as CollabLike).on = true
  return out
}

/** A short, readable fingerprint of a public key — grouped exactly as spaces
 *  and slides group it, so two people can compare codes over a call. */
export const fingerprint = (pub?: string): string =>
  pub ? `${pub.slice(0, 4)}·${pub.slice(4, 8)}·${pub.slice(8, 12)}` : ''
