// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// SHARE COPIES — the documents bento/type writes for someone ELSE to open: an
// editor invite ("Invite to edit…") and a view-only reader ("View-only
// copy…"). Minted in one place, DOM-free, so the copy that ships is the copy
// the rigs inspect.
//
// It used to be built inline in collab.ts, and its stripper dropped ownerPriv
// and the invite but NOT writerPriv. bento/type never mints a writer key — its
// rooms are v2, owner-keyed — but `parseDoc` carries `collab` through verbatim,
// so a document that ARRIVED holding a legacy writer key (an older file, a
// pasted JSON) handed that key to every view-only copy made from it: a "reader"
// holding a private key that writes, which defeats the read-only tier at the
// relay. Nothing caught it because scripts/test-export-secrets.ts's share-copy
// checks ran against spaces alone; this file is shaped to that same contract
// (stripCollabSecrets / inviteCopy / readerCopy) so they now cover type too.
//
// Still a HAND LIST of private fields. The kernel's shared allowlist of what a
// copy may keep will replace it; until then, a new private field in `collab`
// must be added to stripCollabSecrets.

import { mintInvite } from './sync/online.ts';
import type { TypeDoc } from './model.ts';

const clone = (doc: TypeDoc): TypeDoc => JSON.parse(JSON.stringify(doc)) as TypeDoc;

/**
 * Remove every private key a copy for someone else must not carry.
 *
 * By default the WHOLE block goes — the room key is a capability too. With
 * `keepRoom`, the room and its public keys stay (so the copy can follow the
 * live session) and every private key goes: the owner's, any legacy writer
 * key, and any invite keypair this document holds.
 */
export function stripCollabSecrets(doc: TypeDoc, opts: { keepRoom?: boolean } = {}): void {
  if (!doc.collab) return;
  if (!opts.keepRoom) { delete doc.collab; return; }
  delete doc.collab.ownerPriv;
  delete doc.collab.writerPriv;
  delete doc.collab.invite;
}

/**
 * An EDITOR copy: joins live with edit access through its own owner-signed
 * invite, which the owner can revoke. It strips FIRST — a writer key left
 * beside the invite would be a second way in that no revocation reaches.
 */
export async function inviteCopy(doc: TypeDoc, ownerPriv: string): Promise<TypeDoc> {
  const out = clone(doc);
  stripCollabSecrets(out, { keepRoom: true });
  out.collab!.invite = await mintInvite(ownerPriv, 'writer');
  out.collab!.on = true;
  return out;
}

/**
 * A VIEW-ONLY copy: follows the live session and never writes. It carries the
 * room and the public keys, and no private key of any kind; the relay drops
 * anything it tries to send.
 */
export function readerCopy(doc: TypeDoc): TypeDoc {
  const out = clone(doc);
  out.collab = { ...out.collab!, role: 'reader', on: true, sync: undefined };
  stripCollabSecrets(out, { keepRoom: true });
  return out;
}
