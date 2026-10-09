// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// SHARE COPIES — the documents bento/type writes for someone ELSE to open: an
// editor invite ("Invite to edit…") and a view-only reader ("View-only
// copy…"). Minted in one place, DOM-free, so the copy that ships is the copy
// the rigs inspect.
//
// It used to be built inline in collab.ts with a hand list of fields to delete
// that dropped ownerPriv and the invite but NOT a legacy writer key. bento/type
// never mints a writer key — its rooms are v2, owner-keyed — but `parseDoc`
// carries `collab` through verbatim, so a document that ARRIVED holding a legacy
// writer key (an older file, a pasted JSON) handed that key to every view-only
// copy made from it: a "reader" holding a private key that writes, which defeats
// the read-only tier at the relay. The kernel ALLOWLIST closes that whole class —
// a copy keeps only what is on the list, so an arrived-with field it does not
// know is dropped, not carried.
//
// The private fields a copy must not carry are now the kernel's shared ALLOWLIST
// (kernel/src/docfields.ts): a reader/invite copy keeps only what is on the list,
// so a new field in `collab` — private or not — fails CLOSED instead of riding
// along. The whole-block default drop lives in docForExport.

import { mintInvite } from './sync/online.ts';
import { collabForReader, collabForInvite } from '../../kernel/src/docfields.ts';
import { withoutEmbeddedCaps, type TypeDoc } from './model.ts';

// Every share copy starts here, so every one is embed-safe: an embedded
// document never carries its own sharing keys out of this file, however it got
// in (an older file, a pasted JSON — not only through embed.ts's intake).
const clone = (doc: TypeDoc): TypeDoc => withoutEmbeddedCaps(JSON.parse(JSON.stringify(doc)) as TypeDoc);

/**
 * An EDITOR copy: joins live with edit access through its own owner-signed
 * invite, which the owner can revoke. The allowlist keeps room/read-key/public
 * keys + sync and drops every private half; the fresh invite and the top-level
 * role come from mintInvite, never from the source — so a legacy writer key or a
 * source invite can never ride along.
 */
export async function inviteCopy(doc: TypeDoc, ownerPriv: string): Promise<TypeDoc> {
  const out = clone(doc);
  const invite = await mintInvite(ownerPriv, 'writer');
  out.collab = { ...collabForInvite(out.collab!, invite), on: true } as TypeDoc['collab'];
  return out;
}

/**
 * A VIEW-ONLY copy: follows the live session and never writes. The allowlist
 * keeps the room and the public keys, forces role:'reader', and drops every
 * private key, the sync stamp AND anything unknown; the relay drops anything it
 * tries to send.
 */
export function readerCopy(doc: TypeDoc): TypeDoc {
  const out = clone(doc);
  out.collab = { ...collabForReader(out.collab!), on: true } as TypeDoc['collab'];
  return out;
}
