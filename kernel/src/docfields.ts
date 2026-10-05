// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Fields a COPY of a document treats specially — the two sides of "not ordinary
// content." Every Bento app shares these lists, so a field added in one place is
// handled everywhere and a new secret fails CLOSED instead of leaking.
//
//   1. Identity/capability kept LIVE across undo/redo and every whole-document
//      restore (FROM_LIVE) — never resurrected from a snapshot.
//   2. Capabilities/secrets STRIPPED when a copy is exported or shared
//      (CAP_FIELDS at the top level; COLLAB_READER_KEEP — an ALLOWLIST — within
//      a kept collab block).
//
// The helpers operate on plain objects: each app's doc/collab shape is a
// superset of the kernel's, so this module stays app-agnostic and imports
// nothing.

type Obj = Record<string, unknown>

// --- identity (kept live on undo/redo + whole-doc restore) ------------------

/** Top-level fields that are identity or capability, never undoable content.
 *  undo/redo and every whole-document restore keep the LIVE value, not the
 *  snapshot's — so nothing can resurrect an old docId, a stale sharing flag, a
 *  dropped read-only mode or a cleared template flag. SUPERSET across apps: a
 *  field absent from a given app's doc makes keeping it live a no-op. */
export const FROM_LIVE = ['docId', 'collab', 'readonly', 'template'] as const

/** After a restore has replaced `doc` with a snapshot, put identity back from
 *  the LIVE doc — or delete it where live lacks it, so the snapshot's value can
 *  never leak through. Mutates `restored` in place. */
export function keepLiveIdentity(restored: Obj, live: Obj): void {
  for (const k of FROM_LIVE) {
    if (Object.hasOwn(live, k) && live[k] !== undefined) restored[k] = live[k]
    else delete restored[k]
  }
}

// --- capabilities / secrets (stripped on export) ----------------------------

/** Top-level fields that carry a write/owner capability or secret. A copy that
 *  does NOT keep the live room drops these entirely. A new top-level secret is
 *  closed by adding it here, beside where capabilities are minted. (Top level is
 *  a denylist: most top-level fields are content and cannot be allowlisted.) */
export const CAP_FIELDS = ['collab'] as const

/** A shallow copy of `doc` with every capability field removed. */
export function withoutCaps<T extends object>(doc: T): T {
  const out = { ...(doc as Obj) }
  for (const k of CAP_FIELDS) delete out[k]
  return out as T
}

/** Within a KEPT collab block, the fields a reader/viewer copy may carry. This
 *  is an ALLOWLIST: anything not listed — writerPriv, ownerPriv, invite,
 *  audience, the CRDT `sync` stamp, any link records, and any field added later —
 *  is dropped, so a new secret fails CLOSED. `sync` is deliberately excluded: a
 *  reader does not contribute, so it adopts fresh and converges from the room,
 *  and carrying no stamp removes stale-stamp risk (writer/invite copies keep sync
 *  through their own builders). `key` (the symmetric READ cap) and `room` stay —
 *  a reader needs them to decrypt and join. `role` is NOT copied from the source
 *  (a writer's collab must never project as a writer — the #588 class);
 *  collabForReader sets it to 'reader' itself. */
export const COLLAB_READER_KEEP =
  ['room', 'key', 'owner', 'writerPub', 'on', 'v'] as const

/** Project a collab block down to what a reader/viewer copy may hold: a new
 *  object with only the allowlisted fields that are present, and role forced to
 *  'reader' — never the source's role. */
export function collabForReader(collab: object): Obj {
  const src = collab as Obj
  const out: Obj = {}
  for (const k of COLLAB_READER_KEEP) if (Object.hasOwn(src, k) && src[k] !== undefined) out[k] = src[k]
  out.role = 'reader'
  return out
}

/** Within a kept collab, the fields an INVITE (edit/comment) copy may carry: the
 *  reader allowlist PLUS the CRDT `sync` stamp (an invite copy contributes, so it
 *  forks from the stamp) and the owner-signed `invite` delegation. Still an
 *  ALLOWLIST — ownerPriv, writerPriv, audience, any link records, and any field
 *  added later are dropped. The role rides inside `invite` (invite.role), not the
 *  top level, so collabForInvite sets no top-level role. */
export const COLLAB_INVITE_KEEP = [...COLLAB_READER_KEEP, 'sync'] as const

/** Project a collab block to what an invite copy may hold, then attach the
 *  FRESHLY-MINTED `invite` and set the top-level role FROM it. The source's own
 *  invite, links and role are never carried (they are not in the allowlist, and
 *  invite + role come only from the parameter), so a commenter invite opens
 *  locked (role:'commenter') and a writer invite editable — never the source's
 *  chrome. */
export function collabForInvite(collab: object, invite: { role: string }): Obj {
  const src = collab as Obj
  const out: Obj = {}
  for (const k of COLLAB_INVITE_KEEP) if (Object.hasOwn(src, k) && src[k] !== undefined) out[k] = src[k]
  out.invite = invite
  out.role = invite.role
  return out
}

/** On a key rotation ("Reset access…") the collab is rebuilt with FRESH keys —
 *  that is the revocation. These sub-fields are carried from the old block onto
 *  the fresh one: the CRDT `sync` stamp (so the document's collab history
 *  survives the reset) and `links` (published-link records survive a reset — the
 *  maintainer's ruling). To make Reset REVOKE links instead, drop 'links' here —
 *  a one-line change. */
export const COLLAB_ROTATE_KEEP = ['sync', 'links'] as const

/** Build the rotated collab: the freshly-minted block with the rotate-survivor
 *  sub-fields carried over from `old`. Returns a new object; `fresh`'s type is
 *  preserved. */
export function carryThroughRotation<T extends object>(fresh: T, old: object | undefined): T {
  if (!old) return fresh
  const out = { ...(fresh as Obj) }
  const src = old as Obj
  for (const k of COLLAB_ROTATE_KEEP) if (Object.hasOwn(src, k) && src[k] !== undefined) out[k] = src[k]
  return out as T
}
