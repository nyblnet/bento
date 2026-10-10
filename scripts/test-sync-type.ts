#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type under the shared CRDT engine — convergence, and the format's own
// invariants after convergence.
//
//   node scripts/test-sync-type.ts
//   SEEDS=300 STEPS=80 ACTORS=4 node scripts/test-sync-type.ts
//
// TWO DIFFERENT QUESTIONS, following scripts/test-sync-spaces.ts:
//
//  1. DO REPLICAS CONVERGE? The engine's own property, and the standard ask.
//
//  2. IS WHAT THEY CONVERGE ON A LEGAL bento/type DOCUMENT? This is the one
//     with teeth here. A block's `text` merges TOKEN BY TOKEN through the RGA,
//     while its `marks` and `notes` — which are CHARACTER OFFSETS INTO THAT
//     TEXT — merge as ordinary last-writer-wins registers. Two independent
//     merge domains describing one paragraph. Two perfectly legal concurrent
//     edits (you bold a phrase, I type a sentence before it) can therefore
//     converge on a state every replica agrees about, in which the bold covers
//     the wrong words or runs past the end of the text.
//
//     That is the exact shape of the `parent`-versus-position problem spaces
//     has, and like that one it is a FORMAT-LEVEL decision, not a bug to patch
//     inside a rig. So it is MEASURED and REPORTED as data rather than
//     asserted — with STRICT=1 to turn it into a gate the day the decision is
//     taken.
//
// The engine is the kernel's, bound to ('body', null, 'text'). Nothing here is
// type app code beyond the binding and the model's own helpers.

import { SyncEngine } from '../kernel/src/sync/crdt.ts';
import { mulberry32, baseDoc, randomMutation, type Doc } from './lib/sync-fixtures-type.ts';
import { parseDoc, spliceText, type Block } from '../type/src/model.ts';

// The binding lives with the APP, never in the rig: two definitions of a
// frozen format constant is how a fork starts. (`export … from` does not bind
// the name locally and this rig uses it, so it is imported and re-exported.)
import { TYPE_SHAPE } from '../type/src/sync/crdt.ts';
export { TYPE_SHAPE };
class TypeSync extends SyncEngine {
  constructor(actor: string) { super(actor, TYPE_SHAPE); }
}

const SEEDS = parseInt(process.env.SEEDS ?? '120', 10);
const STEPS = parseInt(process.env.STEPS ?? '60', 10);
const ACTORS = parseInt(process.env.ACTORS ?? '3', 10);
const STRICT = process.env.STRICT === '1';

let failures = 0;
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`); } else console.log(`  ok    ${msg}`);
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * Value equality, independent of JSON key order.
 *
 * What a CRDT promises is that replicas agree on the VALUE. Key order is not
 * part of that: a property deleted and re-added moves to the end of its
 * object, so two replicas that applied the same removals in a different order
 * hold equal documents whose `JSON.stringify` differs. Comparing raw strings
 * reports those as divergence — 28 of 120 seeds here, all of them spurious.
 *
 * Measured, not assumed, before relying on it: bento/type signs a canonical
 * digest (canon.ts sorts keys per RFC 8785 §3.2.3), and two blocks differing
 * only in key order produce the SAME digest. So key order reaches neither the
 * signature chain nor the redline, which aligns on block id.
 */
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon)
  : (v && typeof v === 'object')
    ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canon((v as Record<string, unknown>)[k])]))
    : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

class Replica {
  doc: Doc;
  state: TypeSync;
  shadow: string;
  constructor(actor: string, doc: Doc) {
    this.doc = doc;
    this.state = new TypeSync(actor);
    this.state.adopt(this.doc as never);
    this.shadow = JSON.stringify(this.doc);
  }
  mutate(fn: () => void) {
    fn();
    return this.flush();
  }
  flush() {
    const ops = this.state.diff(JSON.parse(this.shadow), this.doc as never, { text: true });
    this.shadow = JSON.stringify(this.doc);
    return ops;
  }
  receive(ops: unknown[]) {
    this.state.apply(this.doc as never, ops as never);
    this.shadow = JSON.stringify(this.doc);
  }
}

// ---------------------------------------------------------------------------
// the format's invariants, checked on a MERGED document
// ---------------------------------------------------------------------------

interface Violations {
  markOutOfRange: number;  // a mark reaching past the end of the text it indexes
  markInverted: number;    // from > to
  noteOutOfRange: number;  // a footnote anchored past the end of its paragraph
  danglingNote: number;    // a reference whose footnote body is not in the map
  dupBlockId: number;      // the redline aligns on block id — duplicates break it
  emptyBody: number;       // a document with no blocks at all
}
const ZERO = (): Violations => ({
  markOutOfRange: 0, markInverted: 0, noteOutOfRange: 0,
  danglingNote: 0, dupBlockId: 0, emptyBody: 0,
});

function inspect(doc: Doc): Violations {
  const v = ZERO();
  if (!Array.isArray(doc.body) || doc.body.length === 0) v.emptyBody++;
  const seen = new Set<string>();
  for (const b of doc.body ?? []) {
    if (seen.has(b.id)) v.dupBlockId++;
    seen.add(b.id);
    const len = (b.text ?? '').length;
    for (const m of b.marks ?? []) {
      if (m.from > m.to) v.markInverted++;
      else if (m.to > len || m.from < 0) v.markOutOfRange++;
    }
    for (const n of b.notes ?? []) {
      if (n.at > len || n.at < 0) v.noteOutOfRange++;
      if (doc.footnotes?.[n.id] === undefined) v.danglingNote++;
    }
  }
  return v;
}
const total = (v: Violations) => Object.values(v).reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

console.log('bento/type under the shared CRDT engine\n');

const worst = ZERO();
const seedsWith = ZERO();
let seedsWithViolations = 0;
let diverged = 0;
let keyOrderOnly = 0;
let opsTotal = 0;
let soloBroken = 0;
let measured = 0;
let unparseable = 0;

for (let seed = 1; seed <= SEEDS; seed++) {
  const rnd = mulberry32(seed * 7919);
  const base = baseDoc(mulberry32(seed * 104729));
  const reps = Array.from({ length: ACTORS }, (_, i) => new Replica(`a${i}`, clone(base)));
  // a lone replica running actor 0's edits and receiving nothing — the control
  const solo = new Replica('solo', clone(base));
  const queues = new Map<string, unknown[][]>();
  for (let f = 0; f < ACTORS; f++) for (let t = 0; t < ACTORS; t++) if (f !== t) queues.set(`${f}>${t}`, []);

  for (let s = 0; s < STEPS; s++) {
    if (rnd() < 0.6) {
      const a = Math.floor(rnd() * ACTORS);
      const mseed = (seed * 1_000_003 + s * 7919) >>> 0;
      if (a === 0) solo.mutate(() => randomMutation(solo.doc, mulberry32(mseed), 's'));
      const ops = reps[a].mutate(() => randomMutation(reps[a].doc, mulberry32(mseed), `a${a}`));
      opsTotal += ops.length;
      if (ops.length) for (let t = 0; t < ACTORS; t++) if (t !== a) queues.get(`${a}>${t}`)!.push(ops);
    } else {
      const keys = [...queues.keys()].filter(k => queues.get(k)!.length);
      if (!keys.length) continue;
      const k = keys[Math.floor(rnd() * keys.length)];
      reps[parseInt(k.split('>')[1], 10)].receive(queues.get(k)!.shift()!);
    }
  }
  // drain everything
  let guard = 0;
  for (;;) {
    const k = [...queues.keys()].find(x => queues.get(x)!.length);
    if (!k || guard++ > 10000) break;
    reps[parseInt(k.split('>')[1], 10)].receive(queues.get(k)!.shift()!);
  }

  const first = JSON.stringify(reps[0].doc);
  let orderOnly = false;
  for (let i = 1; i < ACTORS; i++) {
    if (JSON.stringify(reps[i].doc) === first) continue;
    if (same(reps[0].doc, reps[i].doc)) { orderOnly = true; continue; }
    diverged++;
    if (diverged === 1) console.log(`  FAIL  seed ${seed}: replicas a0 and a${i} disagree in VALUE`);
    break;
  }
  if (orderOnly) keyOrderOnly++;

  // THE CONTROL, and the measurement below is worthless without it. If the
  // GENERATOR produced illegal documents, every violation would be its fault
  // rather than the merge's — so the solo replica, driven by the same edits
  // and receiving nothing, must be spotless. Seeds where it is not are
  // excluded rather than counted, which is a stronger basis than "every
  // generator bug we happened to notice has been fixed".
  if (total(inspect(solo.doc)) > 0) { soloBroken++; continue; }
  measured++;

  // Does the merged document still PARSE as bento/type? Convergence on
  // something the app would reject is a different and worse failure than
  // convergence on something it merely renders oddly.
  const parsed = parseDoc(JSON.stringify(reps[0].doc));
  if (!parsed.ok) unparseable++;

  const v = inspect(reps[0].doc);
  if (total(v) > 0) {
    seedsWithViolations++;
    for (const k of Object.keys(worst) as Array<keyof Violations>) {
      worst[k] = Math.max(worst[k], v[k]);
      if (v[k] > 0) seedsWith[k]++;
    }
  }
}

console.log(`${SEEDS} seeds × ${STEPS} steps × ${ACTORS} actors — ${opsTotal} ops\n`);

ok(diverged === 0, `all replicas converge in value (${diverged} seed(s) diverged)`);
console.log(`  note  ${keyOrderOnly} seed(s) converged on equal documents whose JSON KEY ORDER differs` +
  ' — a property deleted and re-added moves to the end of its object.');
console.log('        Benign here and checked rather than assumed: canon.ts sorts keys, so the');
console.log('        signing digest is identical, and the redline aligns on block id.');
ok(unparseable === 0, `every merged document still parses as bento/type (${unparseable} rejected)`);
ok(soloBroken === 0,
  `the generator itself produces legal documents (${soloBroken} seed(s) excluded as unsound)`);

// ---- the offset-domain report ----------------------------------------------
console.log('\n  --- marks and notes are offsets into RGA-merged text ---');
console.log(`  measured on ${measured} seed(s) with a provably clean control`);
console.log(`  seeds converging on a document with at least one violation: ${seedsWithViolations}` +
  ` (${((seedsWithViolations / Math.max(1, measured)) * 100).toFixed(1)}%)`);
for (const k of Object.keys(worst) as Array<keyof Violations>) {
  console.log(`    ${k.padEnd(16)} seeds: ${String(seedsWith[k]).padStart(4)}   worst in one document: ${worst[k]}`);
}

if (STRICT) {
  ok(seedsWithViolations === 0,
    `STRICT: no merged document violates the format (${seedsWithViolations} seed(s) did)`);
} else {
  console.log('\n  Reported, not asserted: whether an offset that no longer describes its');
  console.log('  text is a defect to fix in the model or a cost to accept is a FORMAT');
  console.log('  decision nobody has taken. STRICT=1 turns this into a gate the day it is.');
}

// ---------------------------------------------------------------------------
// a legible example of the same thing, so the statistic is not the only account
// ---------------------------------------------------------------------------
console.log('\n=== what that looks like on one paragraph ===');
{
  // Constructed so the outcome does NOT depend on who wins the register race.
  // BOTH authors insert text BEFORE the bold and both correctly shift their own
  // marks with the app's own spliceText. The merged TEXT contains both
  // insertions, so the correct offset is shifted by both — a number neither
  // replica ever held. Whichever mark set wins, it is wrong.
  //
  // (An earlier version of this example had one author type at the start and
  // the other only re-bold. It converged on the RIGHT answer and demonstrated
  // nothing, while reading as though it had.)
  const TEXT = 'Payment is due within 30 days.';
  const TERM = '30 days';
  const mk = (): Doc => ({
    format: 'bento/type', version: 1, docId: 'd', title: 'T',
    page: { width: 816, height: 1056, marginX: 104, marginTop: 104, marginBottom: 104 },
    body: [{ id: 'p1', kind: 'para', text: TEXT,
             marks: [{ t: 'b', from: TEXT.indexOf(TERM), to: TEXT.indexOf(TERM) + TERM.length }] } as Block],
    footnotes: {}, revisions: [], signatures: [],
  } as unknown as Doc);

  const A = new Replica('alice', mk());
  const B = new Replica('bob', mk());
  const covered = (d: Doc) => {
    const b = d.body[0];
    const m = b.marks?.[0];
    return m ? b.text.slice(m.from, m.to) : '(none)';
  };
  console.log(`      before:      ${JSON.stringify(A.doc.body[0].text)}`);
  console.log(`                   bold covers ${JSON.stringify(covered(A.doc))}`);

  const opsA = A.mutate(() => { A.doc.body[0] = spliceText(A.doc.body[0], 0, 0, 'Under clause 4, '); });
  const opsB = B.mutate(() => { B.doc.body[0] = spliceText(B.doc.body[0], 0, 0, 'Notwithstanding the above, '); });
  console.log(`      alice types a prefix, and her bold correctly follows it to ${JSON.stringify(covered(A.doc))}`);
  console.log(`      bob types a different prefix, and his follows to ${JSON.stringify(covered(B.doc))}`);

  A.receive(opsB);
  B.receive(opsA);
  ok(same(A.doc, B.doc), 'the two replicas converge');
  const merged = A.doc.body[0].text;
  console.log(`      merged text: ${JSON.stringify(merged)}`);
  console.log(`      bold covers: ${JSON.stringify(covered(A.doc))}   (it should cover ${JSON.stringify(TERM)})`);
  ok(merged.includes('Under clause 4') && merged.includes('Notwithstanding the above'),
     'both insertions survive — the TEXT merged correctly, token by token');
  console.log(`      The text merged; the offsets describing it did not. Neither replica ever`);
  console.log(`      held the correct offset, so no register winner could have been right.`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
