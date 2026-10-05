// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// SHARE COPIES — the documents bento/slides writes for someone ELSE to open: a
// view-only reader ("Read-only copy…") and an editor invite ("Editor copy…").
// Extracted from the Editor so they are DOM-free and the copy that ships is the
// copy the rig inspects (scripts/test-slides-share.ts runs these with real keys).
//
// Both go through the kernel ALLOWLIST (kernel/src/docfields.ts): a copy keeps
// only what is on the list, so a new field in `collab` — private or not — fails
// CLOSED. The reader forces role:'reader' and drops every private half AND the
// sync stamp; the invite keeps the stamp, carries a FRESH owner-signed invite and
// takes its top-level role FROM that invite. Neither rebuilds collab by spreading
// the source. The audience projection (audience.ts) is a separate tier and is NOT
// built here; the drop-the-whole-block exports (template, package, Copy JSON) drop
// the collab block entirely in editor.ts.

import { mintInvite } from './sync/online'
import { stripEmbeddedEnvelopes } from './envelope'
import { collabForReader, collabForInvite } from '../../kernel/src/docfields.ts'
import type { BentoDoc } from './model'

/** A deep clone with the EMBEDDED-document strip applied, so neither a copy's own
 *  collab (handled below by the allowlist) nor any document embedded inside it can
 *  carry a capability or secret out. A deep clone first, so nothing done to the
 *  copy reaches the open document. */
const cloneForShare = (doc: BentoDoc): BentoDoc => {
  const out = JSON.parse(JSON.stringify(doc)) as BentoDoc
  stripEmbeddedEnvelopes(out)
  return out
}

/**
 * A VIEW-ONLY copy: follows the live session and never writes. Keeps the room,
 * the read key and the public keys; forced to role:'reader'; loses every private
 * half, the sync stamp and anything unknown — the relay drops whatever it sends.
 */
export function readerCopy(doc: BentoDoc): BentoDoc {
  const out = cloneForShare(doc)
  out.collab = { ...collabForReader(out.collab!), on: true } as BentoDoc['collab']
  return out
}

/**
 * An EDITOR copy: joins live with edit access through its own owner-signed invite,
 * which the owner can revoke. The allowlist keeps room/read-key/public keys + the
 * sync stamp and drops every private half; the fresh invite and the top-level role
 * come from mintInvite, never from the source — so a legacy writer key or a source
 * invite can never ride along.
 */
export async function inviteCopy(doc: BentoDoc, ownerPriv: string): Promise<BentoDoc> {
  const out = cloneForShare(doc)
  const invite = await mintInvite(ownerPriv, 'writer')
  out.collab = { ...collabForInvite(out.collab!, invite), on: true } as BentoDoc['collab']
  return out
}
