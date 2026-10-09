// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// COMPARING TWO DOCUMENTS — the reading and the direction. No DOM, no i18n.
//
// This is to compare.ts what redline.ts is to redlineview.ts: the part with the
// correctness in it, kept free of the chrome so scripts/test-type-compare.ts
// can drive it in node against a file this app actually wrote. The rig cannot
// import the surface — the surface imports a stylesheet — and more to the
// point, the two questions that can be silently WRONG here (did we read the
// right document, and which way round is the diff) are both answerable without
// a browser.
//
// redline.ts has been able to diff two documents since it was written; what it
// never had was a second document to diff against. `startReview` hands it a
// revision of THIS document out of `doc.revisions`, so the whole feature could
// only ever answer "what have I changed since I pressed Snapshot". The question
// people actually have about a contract is the other one: THEY sent it back —
// what did they change? That needs a second FILE and nothing more:
//
//   file → parseDoc → redline(THAT file, THIS document) → redlineview
//
// THE DIRECTION IS THE WHOLE THING. `redline(before, after)` reports what turns
// `before` into `after`; the OTHER file is `before` and the live document is
// `after`, so a <del> is their text and an <ins> is yours. Read backwards that
// is exactly wrong and entirely plausible — an insertion and a deletion look
// identical if you have the ends swapped — and no card on screen carries the
// information to tell the difference. Which is why compare.ts names both ends
// in the heading every time, and why the rig pins the orientation rather than
// only the change COUNT (a count is symmetric and would pass either way).
//
// AN EMPTY RESULT IS NOT A RESULT, either. Two identical documents and a
// comparison that silently failed both come out as zero changes, so `identical`
// is reported as its own fact rather than left for a caller to infer from an
// empty list.

import { parseDoc, type TypeDoc } from './model.ts';
import { redline, type ChangeSet } from './redline.ts';
import { DOC_BLOCK } from './embed.ts';

/**
 * What the user handed us, reduced to the document JSON.
 *
 * Two shapes are accepted because the DOCUMENT is this suite's interchange
 * unit: a saved `.bento.html` shell is what sits on disk, and the bare JSON is
 * what a chat AI can actually hand back (About → "Copy document JSON" is the
 * other end of that round trip).
 *
 * `from` matters for the error message and nothing else: a `.html` file with no
 * `#bento-doc` block is not corrupt JSON — it is not a Bento file — and telling
 * someone their web page has a syntax error at position 1 helps nobody.
 */
export function extractDocJson(text: string): { json: string; from: 'shell' | 'raw' } {
  const m = DOC_BLOCK.exec(text);
  return m ? { json: m[1], from: 'shell' } : { json: text, from: 'raw' };
}

export type CompareRead =
  | { ok: true; doc: TypeDoc; repaired: string[] }
  | { ok: false; kind: 'empty' | 'json' | 'shape' | 'other-app' | 'not-bento'; detail: string; found?: string };

/**
 * Read a bento/type document out of a saved shell or a bare `.json`.
 *
 * `parseDoc` does the validating — including refusing another app's format
 * outright, which is the check that makes "compare with a file" safe to point
 * at a folder of mixed Bento files. Its repairs are SURFACED rather than
 * swallowed: a repair can invent a block id, the redline aligns blocks by id,
 * and an invented id shows up as a change nobody made.
 */
export function readTypeDoc(text: string): CompareRead {
  const { json, from } = extractDocJson(text);
  // Markup with no document in it — named for what it is, before parseDoc gets
  // a chance to report the whole web page as a JSON syntax error.
  if (from === 'raw' && json.trimStart().startsWith('<')) {
    return { ok: false, kind: 'not-bento', detail: 'no #bento-doc block' };
  }
  const r = parseDoc(json);
  if (r.ok) return { ok: true, doc: r.doc, repaired: r.repaired };
  if (r.err === 'empty') return { ok: false, kind: 'empty', detail: '' };
  if (r.err === 'format') {
    // A sibling app's file is a different sentence from a stranger's: one tells
    // you which app to open it in, the other that it is not ours at all.
    return { ok: false, found: r.found, detail: r.detail,
             kind: r.found?.startsWith('bento/') ? 'other-app' : 'not-bento' };
  }
  return { ok: false, kind: r.err, detail: r.detail };
}

export interface Comparison {
  set: ChangeSet;
  /** the two documents claim the same identity — that file is a copy of THIS one */
  sameDocId: boolean;
  /** no differences at all: say so, never paint an empty list as a result */
  identical: boolean;
}

/**
 * Diff another document against this one.
 *
 * `other` is `before` and `live` is `after` — see the header. The author on the
 * change set is the LIVE document's, because the changes being described are
 * the ones this copy carries relative to theirs.
 *
 * PURE. Comparing is a view: nothing here writes to either document, and
 * nothing here may start to.
 */
export function compareDocs(other: TypeDoc, live: TypeDoc, author = 'you'): Comparison {
  const set = redline({ docId: other.docId, body: other.body },
                      { docId: live.docId, body: live.body },
                      { author });
  return { set, sameDocId: other.docId === live.docId, identical: set.changes.length === 0 };
}
