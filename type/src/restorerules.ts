// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// How a whole-document restore treats each field — bento/type's row in the
// kernel's restore table (kernel/src/docfields.ts applyRestore).
//
// Every whole-document restore goes through this, in one of two directions:
//
//   'back'     undo / redo of a document-level step, and restoring a version
//              from About's version history — going BACK in time. Content
//              follows the older copy; history stays LIVE, so going back can
//              never discard revisions made since.
//   'recover'  the crash-recovery banner — the snapshot is a NEWER copy of this
//              same document, and the person chose it over the file. Content
//              AND history follow it, so revisions and the signatures over them
//              come back as one self-consistent unit, never split.
//
// Identity, mode and capability always stay live, in both directions — the
// kernel's floor, which no override here can move.
//
// Overrides, per direction:
//
//   `comments` is history-class (for COPYING — a view-only copy drops it) but
//   FOLLOWS a restore in both directions, so adding, resolving or deleting a
//   comment stays undoable like any edit. The class answers "how is it
//   copied"; this answers "does a restore move it" — two questions, kept apart.
//
//   `signatures` is content-class (a view-only copy carries them, canon.ts v2)
//   but stays LIVE going 'back': ⌘Z past the moment of signing, or restoring a
//   version from before it, must not delete a signature. A signature leaves
//   only by its signer's or the owner's removal (ruling 7), and going back
//   leaves it honestly reading "changed". On 'recover' it FOLLOWS the snapshot,
//   so a signature made just before a crash comes back, together with the
//   revisions it commits to — never split.
//
// A paste (Replace from JSON, bento.loadDoc) is not a restore and does not come
// through here: it never installs history at all (docclass.ts keepLiveHistory).

import { restoreOverrides, validateRestoreRules, type RestoreDirection, type RestoreRules } from '../../kernel/src/docfields.ts';
import { TYPE_FIELDS } from './docclass.ts';

export const RESTORE_RULES: Readonly<Record<RestoreDirection, RestoreRules>> = {
  back: {
    classes: TYPE_FIELDS,
    // restoreOverrides makes naming an identity, mode or capability field a
    // COMPILE error; validateRestoreRules below is the runtime backstop.
    keepLive: restoreOverrides(TYPE_FIELDS, { comments: 'follows', signatures: 'live' }),
  },
  recover: {
    classes: TYPE_FIELDS,
    keepLive: restoreOverrides(TYPE_FIELDS, { comments: 'follows' }),
    // A recovery snapshot is the WHOLE document (autosave writes the entire doc),
    // so on 'recover' a field it does not carry was DELETED before the crash and
    // stays deleted — a removed comment, paragraph, footnote or style does not
    // come back. Keyed on each field's EFFECTIVE keepLive (kernel #722), which is
    // what makes it cover `comments`: history-class, but overridden to follow.
    // The kernel's default; stated here because the guarantee is load-bearing
    // (a resurrected redaction rides the next copy shared).
    //
    // NOT covered by it: a history field left 'live' (revisions) keeps live when
    // ABSENT. Type is safe today only because parseDoc defaults a missing
    // `revisions` to [] before the restore sees it — pinned in
    // test-type-autosave.ts, which goes red if that default is removed.
    wholeSnapshot: true,
  },
};

validateRestoreRules(RESTORE_RULES.back);
validateRestoreRules(RESTORE_RULES.recover);
