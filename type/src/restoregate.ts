// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The gate a document kept in THIS BROWSER passes before it replaces the one
// that is open: the "Unsaved changes … were found — Restore" snapshot, and
// every entry in Version history. The type counterpart of bento/slides'
// restoregate.ts.
//
// WHY IT IS A GATE AT ALL. Those snapshots are not the file. They live in
// IndexedDB under the document's docId, and on file:// every local
// .bento.html shares one origin (docs/DECISIONS.md, 2026-09-19) — so the
// store is shared too, readable and writable by any other local page. A
// snapshot is therefore FOREIGN INPUT, arriving behind the most trusting
// prompt in the app ("restore YOUR unsaved changes"). It used to reach
// store.replace as raw JSON.parse output, with no format check at all, and
// carrying its own identity: a planted snapshot could swap in a different
// docId, a different room and keys (`collab`), or drop the file's mode.
//
// So a snapshot is (1) put through parseDoc, the same format check a file
// gets, and anything parseDoc refuses is not offered; and (2) never allowed
// to bring its own IDENTITY or CAPABILITY. docId, collab and readonly are the
// OPEN FILE's, whatever the snapshot says — the same list undo uses
// (store.ts FROM_LIVE), and the same as slides'. Content is restored; who
// the document is, which room it syncs with and whether it can be edited are
// not.
//
// RESTORE IS NOT OPEN. Opening a file and "Replace from JSON…" keep the
// incoming document's own identity — the person chose that document, and it
// is the thing they want to be holding. Only a restore of something this
// browser kept is gated. That is why version history has its own hook
// (about.ts onRestoreDoc) instead of reusing Replace from JSON's.
//
// What this does NOT do, deliberately and stated: slides' gate also rebuilds
// content key by key through its untrusted.ts. bento/type has no such layer;
// its renderer already has to treat any opened file's content as untrusted,
// so the risk SPECIFIC to a browser-held snapshot is the identity and
// capability it could smuggle under that prompt, which is what this closes.
//
// DOM-free, so scripts/test-type-restore-gate.ts runs it in node.

import { parseDoc, type TypeDoc } from './model.ts';
import { keepLiveIdentity } from './store.ts';

/**
 * A browser-kept snapshot, made safe to restore over `live` — or null when it
 * is not a bento/type document at all, in which case nothing is offered.
 *
 * Call it at the moment of restoring, with the document that is open THEN:
 * identity is taken from the live document, and the live document can change
 * between showing a prompt and the click that accepts it.
 */
export function gateRestored(json: string, live: TypeDoc): TypeDoc | null {
  const parsed = parseDoc(json);
  if (!parsed.ok) return null;
  const doc = parsed.doc;
  keepLiveIdentity(doc, live);
  return doc;
}
