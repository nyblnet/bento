// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Random bento/type documents and edits, for the sync rigs.
//
// A SEPARATE MODULE per shape, for the reason sync-fixtures-spaces.ts states:
// the slides generator picks its mutation with `Math.floor(rnd() * N)`, so
// adding a case to a shared file re-rolls the kind mapping for every seed in
// every rig that uses it — silently changing what years of coverage mean while
// the diff looks purely additive.
//
// WHAT A type DOCUMENT HAS THAT NEITHER OTHER APP DOES:
//
//  · IT IS FLAT. `body` is the parent array and a block has no children. The
//    engine's element layer is simply absent, so every op is parent-scoped.
//  · THE TEXT IS ON THE PARENT, and it is PLAIN text with `marks` over
//    character ranges — not an HTML string. The text merges token by token
//    (RGA); the marks do not.
//  · MARKS AND NOTES ARE OFFSETS INTO THAT TEXT. This is the interesting part
//    and the reason this generator exists: an edit that changes text length
//    must shift them, and the app does that with `spliceText`. Using the app's
//    own function here is deliberate — it makes each replica's LOCAL state
//    exactly what the editor would produce, so anything the rig finds after a
//    merge is a property of the MERGE, not of arithmetic invented for a test.
//  · FOOTNOTE BODIES LIVE IN A DOC-LEVEL MAP keyed by note id, so a note
//    outlives a re-flow of the paragraph that references it. Two authors
//    adding notes touch the same map.

import { spliceText, type Block, type BlockKind } from '../../type/src/model.ts';

export type Doc = Record<string, unknown> & {
  body: Block[];
  footnotes: Record<string, string>;
};

/** deterministic PRNG — the same one every other sync fixture uses */
export function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const stable = (v: unknown): string => JSON.stringify(v);

const KINDS: BlockKind[] = ['para', 'h1', 'h2', 'h3', 'quote'];
const MARKS = ['b', 'i', 'code', 'strike'] as const;
const WORDS = [
  'payment', 'shall', 'be', 'due', 'within', 'thirty', 'days', 'of', 'invoice',
  'the', 'parties', 'agree', 'that', 'notice', 'may', 'terminate', 'liability',
  'is', 'limited', 'to', 'fees', 'paid', 'under', 'this', 'agreement',
];

const words = (rnd: () => number, n: number) =>
  Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');

export function baseDoc(rnd: () => number): Doc {
  const n = 3 + Math.floor(rnd() * 4);
  const body: Block[] = Array.from({ length: n }, (_, i) => {
    const b: Block = {
      id: `p${i + 1}`,
      kind: KINDS[Math.floor(rnd() * KINDS.length)],
      text: words(rnd, 4 + Math.floor(rnd() * 8)),
    };
    if (rnd() < 0.4 && b.text.length > 4) {
      const from = Math.floor(rnd() * (b.text.length - 3));
      b.marks = [{ t: MARKS[Math.floor(rnd() * MARKS.length)], from, to: from + 1 + Math.floor(rnd() * 3) }];
    }
    return b;
  });
  return {
    format: 'bento/type', version: 1, docId: 'doc-fixture',
    title: 'Agreement', page: { width: 816, height: 1056, marginX: 104, marginTop: 104, marginBottom: 104 },
    body, footnotes: {}, revisions: [], signatures: [],
  };
}

/** how many distinct mutation kinds `randomMutation` can pick */
export const MUTATION_KINDS = 15;

/**
 * Apply one random edit, as the editor would.
 *
 * `tag` distinguishes ids minted by different replicas, so a concurrent insert
 * from two actors is genuinely two blocks rather than an id collision the
 * engine would be entitled to merge.
 */
export function randomMutation(doc: Doc, rnd: () => number, tag: string): void {
  const pick = <T,>(a: T[]): T | undefined => (a.length ? a[Math.floor(rnd() * a.length)] : undefined);
  const kind = Math.floor(rnd() * MUTATION_KINDS);
  const b = pick(doc.body);
  const at = (t: string) => Math.floor(rnd() * (t.length + 1));

  switch (kind) {
    case 0: { // insert a block
      const i = Math.floor(rnd() * (doc.body.length + 1));
      doc.body.splice(i, 0, {
        id: `${tag}${Math.floor(rnd() * 1e6).toString(36)}`,
        kind: KINDS[Math.floor(rnd() * KINDS.length)],
        text: words(rnd, 3 + Math.floor(rnd() * 6)),
      });
      break;
    }
    case 1: { // delete a block (never the last one — an empty body is not a document)
      if (doc.body.length > 1) doc.body.splice(Math.floor(rnd() * doc.body.length), 1);
      break;
    }
    case 2: { // move a block
      if (doc.body.length > 1) {
        const from = Math.floor(rnd() * doc.body.length);
        const [m] = doc.body.splice(from, 1);
        doc.body.splice(Math.floor(rnd() * (doc.body.length + 1)), 0, m);
      }
      break;
    }
    case 3: case 4: case 5: { // TYPE — the common case, weighted accordingly
      if (!b) break;
      const i = doc.body.indexOf(b);
      doc.body[i] = spliceText(b, at(b.text), 0, ' ' + words(rnd, 1 + Math.floor(rnd() * 3)));
      break;
    }
    case 6: { // delete a span
      if (!b || b.text.length < 3) break;
      const i = doc.body.indexOf(b);
      const from = Math.floor(rnd() * (b.text.length - 2));
      doc.body[i] = spliceText(b, from, 1 + Math.floor(rnd() * Math.min(8, b.text.length - from)), '');
      break;
    }
    case 7: { // replace a span (type over a selection)
      if (!b || b.text.length < 3) break;
      const i = doc.body.indexOf(b);
      const from = Math.floor(rnd() * (b.text.length - 2));
      doc.body[i] = spliceText(b, from, 1 + Math.floor(rnd() * 4), words(rnd, 1));
      break;
    }
    case 8: { // change block kind
      if (b) b.kind = KINDS[Math.floor(rnd() * KINDS.length)];
      break;
    }
    case 9: { // add a mark
      if (!b || b.text.length < 2) break;
      const from = Math.floor(rnd() * (b.text.length - 1));
      const m = { t: MARKS[Math.floor(rnd() * MARKS.length)], from, to: from + 1 + Math.floor(rnd() * 4) };
      b.marks = [...(b.marks ?? []), { ...m, to: Math.min(m.to, b.text.length) }];
      break;
    }
    case 10: { // remove marks — property REMOVAL, the class that hid two crashes
      if (b && b.marks) delete b.marks;
      break;
    }
    case 11: { // add a footnote: a ref in the block AND a body in the doc-level map
      if (!b) break;
      const id = `n${tag}${Math.floor(rnd() * 1e5).toString(36)}`;
      b.notes = [...(b.notes ?? []), { id, at: at(b.text) }];
      doc.footnotes[id] = words(rnd, 3 + Math.floor(rnd() * 5));
      break;
    }
    case 12: { // remove a footnote, ref and body together
      if (!b || !b.notes?.length) break;
      const gone = b.notes[Math.floor(rnd() * b.notes.length)];
      b.notes = b.notes.filter(x => x.id !== gone.id);
      if (!b.notes.length) delete b.notes;
      delete doc.footnotes[gone.id];
      break;
    }
    case 13: { // set or clear a role
      if (!b) break;
      if (rnd() < 0.5) b.role = pick(['title', 'clause', 'recital'])!;
      else delete b.role;
      break;
    }
    case 14: { // doc-level props
      if (rnd() < 0.5) doc.title = `Agreement ${Math.floor(rnd() * 100)}`;
      else (doc.page as Record<string, number>).marginX = 80 + Math.floor(rnd() * 40);
      break;
    }
  }
}
