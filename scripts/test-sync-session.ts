#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento-sync SESSION layer — the bridge between the CRDT engine and a
// running editor.
//
//   node scripts/test-sync-session.ts
//
// WHY THIS EXISTS, AND WHY NOW. crdt.ts has 45,000 checks behind it. The
// session layer — the differ hook, the shadow, presence, catch-up, the empty
// document repair — had NONE, and it is about to be moved into the kernel and
// parameterized for a second and third app. Moving untested code across a seam
// is how behaviour changes without anyone noticing, so this pins the behaviour
// FIRST, against the implementation as it shipped, and the same rig is then run
// against the kernelized one.
//
// Nothing here is a mock of the session. It drives the REAL SyncSession over
// the REAL Store through a REAL BroadcastChannel — two sessions in one process
// are exactly two tabs of one document, which is the transport that ships and
// is always on. Only `window` is shimmed, because the session reaches for
// `window.setTimeout` and a `beforeunload` listener; every other API it uses
// (localStorage through kernel/src/storage.ts) already degrades safely when
// absent, which is why this runs in node at all.

// ---- the browser surface the session expects -------------------------------
// Deliberately thin: three timer functions and an event listener. If this shim
// ever has to grow, that is a signal the session picked up a dependency the
// kernel should not have.
const listeners: Record<string, Array<() => void>> = {};
(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: number) => clearTimeout(h),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (h: number) => clearInterval(h),
  addEventListener: (ev: string, fn: () => void) => { (listeners[ev] ??= []).push(fn); },
};

// App source is written for Vite and imports without file extensions; Node
// needs help resolving those. Registered BEFORE the dynamic imports below —
// which is why they are dynamic.
const { register } = await import('node:module');
register('./lib/ts-resolve-hooks.mjs', import.meta.url);

const { Store } = await import('../slides/src/store.ts');
const { SyncSession } = await import('../slides/src/sync/session.ts');
const { newDoc, emptySlide } = await import('../slides/src/model.ts');

let failures = 0, checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`); } else console.log(`  ok    ${msg}`);
}
const H = (s: string) => console.log(`\n=== ${s} ===`);

/** the session debounces its differ by 90ms; settle generously past that */
const settle = (ms = 260) => new Promise(r => setTimeout(r, ms));

type AnyStore = InstanceType<typeof Store>;
type AnySession = InstanceType<typeof SyncSession>;

/** Two tabs of ONE document — the same docId, so they share a channel. */
function tabs(): { a: AnyStore; b: AnyStore; sa: AnySession; sb: AnySession; close: () => void } {
  const doc = newDoc();
  doc.docId = `rig-${Math.random().toString(36).slice(2, 10)}`;
  // newDoc() gives a bare deck; the session's interesting paths are about
  // ELEMENTS (text merging, stale selection), so put some there.
  doc.slides = [
    { ...emptySlide(), id: 's1', elements: [
      { id: 'e1', type: 'text', x: 100, y: 100, w: 600, h: 120, html: 'Title here' },
      { id: 'e2', type: 'shape', shape: 'rect', x: 100, y: 300, w: 200, h: 200, fill: '#8FA3BF' },
    ] },
    { ...emptySlide(), id: 's2', elements: [
      { id: 'e3', type: 'text', x: 100, y: 100, w: 600, h: 120, html: 'Second slide' },
    ] },
  ] as never;
  const a = new Store(JSON.parse(JSON.stringify(doc)));
  const b = new Store(JSON.parse(JSON.stringify(doc)));
  const sa = new SyncSession(a);
  const sb = new SyncSession(b);
  return { a, b, sa, sb, close: () => { sa.stop?.(); sb.stop?.(); } };
}

console.log('bento-sync — the session layer\n');

H('a local edit reaches the other tab');
{
  const { a, b, close } = tabs();
  a.commit(() => { a.doc.title = 'Renamed in tab A'; });
  await settle();
  ok(b.doc.title === 'Renamed in tab A',
    `the title crossed the channel (got ${JSON.stringify(b.doc.title)})`);
  close();
}

H('edits flow both ways, and each tab keeps its own view state');
{
  const { a, b, close } = tabs();
  a.commit(() => { a.doc.slides[0].notes = 'from A'; });
  await settle();
  b.commit(() => { b.doc.title = 'from B'; });
  await settle();
  ok(b.doc.slides[0].notes === 'from A' && a.doc.title === 'from B',
    'both edits landed on both replicas');
  // view state is per-tab and must never be synced
  b.currentIndex = 0;
  b.selection = ['x'];
  await settle(120);
  ok(a.selection.length === 0, "one tab's selection does not become the other's");
  close();
}

H('the document event fires on the receiving tab');
{
  // The whole integration claim is "remote ops re-emit the store events the
  // editor already listens to, so no editor rewrites". If that stops being
  // true the canvas silently stops repainting on remote edits.
  const { a, b, close } = tabs();
  let docEvents = 0;
  b.on('doc', () => { docEvents++; });
  a.commit(() => { a.doc.title = 'repaint me'; });
  await settle();
  ok(docEvents > 0, `the receiving store emitted 'doc' (${docEvents} time(s))`);
  ok(b.dirty, 'and the receiving tab is marked dirty, so the change can be saved');
  close();
}

H('concurrent edits to one text element merge');
{
  const { a, b, close } = tabs();
  const el = a.doc.slides[0].elements.find(e => e.type === 'text');
  if (!el) { ok(false, 'fixture has a text element'); }
  else {
    const id = el.id;
    a.commit(() => { const e = a.doc.slides[0].elements.find(x => x.id === id)!; e.html = 'Hello'; });
    await settle();
    // now both edit the SAME element without seeing each other first
    a.commit(() => { const e = a.doc.slides[0].elements.find(x => x.id === id)!; e.html = 'Hello world'; });
    b.commit(() => { const e = b.doc.slides[0].elements.find(x => x.id === id)!; e.html = 'Well, Hello'; });
    await settle(400);
    const ha = a.doc.slides[0].elements.find(x => x.id === id)!.html;
    const hb = b.doc.slides[0].elements.find(x => x.id === id)!.html;
    ok(ha === hb, `the two tabs agree on the text (${JSON.stringify(ha)} vs ${JSON.stringify(hb)})`);
  }
  close();
}

H('presence');
{
  const { a, b, sa, sb, close } = tabs();
  await settle(150);
  const seen = () => sa.peers().map(p => p.actor);
  ok(seen().includes(sb.actor), `tab A sees tab B as a peer (${seen().length} peer(s))`);
  b.currentIndex = 0;
  b.emit('current');
  await settle(150);
  const peer = sa.peers().find(p => p.actor === sb.actor);
  ok(!!peer && typeof peer.slide === 'string', 'and knows which slide that peer is on');
  ok(!!peer?.color, 'a peer carries a colour, so the UI can label them');
  close();
}

H('an emptied deck heals');
{
  // The race this repairs: two tabs each delete the last slides. The merge can
  // land on a deck with NO slides, which the editor cannot render.
  const { a, b, close } = tabs();
  a.commit(() => { a.doc.slides.splice(0, a.doc.slides.length); });
  await settle(400);
  ok(a.doc.slides.length >= 1, `tab A is not left with an empty deck (${a.doc.slides.length} slide(s))`);
  ok(b.doc.slides.length >= 1, `nor is tab B (${b.doc.slides.length} slide(s))`);
  ok(a.currentIndex < a.doc.slides.length, 'and the current index is in range');
  close();
}

H('a stale selection is dropped on the receiving tab');
{
  const { a, b, close } = tabs();
  const el = a.doc.slides[0].elements[0];
  b.selection = [el.id];
  a.commit(() => { a.doc.slides[0].elements = a.doc.slides[0].elements.filter(e => e.id !== el.id); });
  await settle(400);
  ok(!b.selection.includes(el.id),
    'an element deleted elsewhere leaves no dangling id selected');
  close();
}

// ---------------------------------------------------------------------------
// THE SEAM. The same kernel session, bound to a completely different app.
//
// This is what the move was for, and it is the only part that could not have
// been written before it. bento/type is flat where slides is nested, its text
// is on the parent, its store has one listener list instead of five events,
// and it has no dirty flag — so if the session had kept ANY slides assumption,
// it would surface here rather than in the seven sections above.
// ---------------------------------------------------------------------------
const { Store: TypeStore } = await import('../type/src/store.ts');
const { SyncSession: TypeSession } = await import('../type/src/sync/session.ts');
const { emptyDoc } = await import('../type/src/model.ts');

function typeTabs() {
  const doc = emptyDoc();
  doc.docId = `rig-type-${Math.random().toString(36).slice(2, 10)}`;
  doc.body = [
    { id: 'p1', kind: 'para', text: 'The parties agree as follows.' },
    { id: 'p2', kind: 'para', text: 'Payment is due within 30 days.' },
  ];
  const a = new TypeStore(JSON.parse(JSON.stringify(doc)));
  const b = new TypeStore(JSON.parse(JSON.stringify(doc)));
  const sa = new TypeSession(a, () => ({ block: 'p1' }));
  const sb = new TypeSession(b, () => ({ block: 'p2' }));
  return { a, b, sa, sb };
}

H('the same session drives bento/type');
{
  const { a, b } = typeTabs();
  a.commit(d => { d.body[0].text = 'The parties hereby agree as follows.'; });
  await settle();
  ok(b.doc.body[0].text === 'The parties hereby agree as follows.',
    `an edit in one document reaches the other (got ${JSON.stringify(b.doc.body[0].text)})`);
}

H('two people typing in one paragraph, over the live session');
{
  // The kernel change this whole line of work rests on, exercised end to end:
  // through the store, the differ, the debounce, a real channel, and back.
  const { a, b } = typeTabs();
  a.commit(d => { d.body[1].text = 'Payment is due within sixty (60) days.'; });
  b.commit(d => { d.body[1].text = 'Payment is due within 30 days of invoice.'; });
  await settle(500);
  const ta = a.doc.body[1].text, tb = b.doc.body[1].text;
  ok(ta === tb, `the two agree (${JSON.stringify(ta)})`);
  ok(ta.includes('sixty (60)') && ta.includes('of invoice'),
    'and BOTH edits survived — the token RGA is reachable through the session');
}

H('a remote edit does not land on the local undo stack');
{
  // Word-processor specific and easy to get wrong: ⌘Z means "undo what I
  // did". If a remote paragraph arrived as a commit, undo would revert a
  // colleague's work and redo would bring it back as if it were yours.
  const { a, b } = typeTabs();
  // CONTROL FIRST. `0 → 0` proves nothing if undoDepth never moves, so show
  // that a LOCAL edit does push a step before claiming a remote one does not.
  const start = b.undoDepth;
  b.commit(d => { d.body[0].text = 'Edited by me.'; });
  const afterLocal = b.undoDepth;
  ok(afterLocal > start, `a local edit pushes an undo step (${start} → ${afterLocal})`);
  await settle();

  a.commit(d => { d.body[1].text = 'Edited by the other person.'; });
  await settle();
  ok(b.doc.body[1].text === 'Edited by the other person.', 'the remote edit arrived');
  ok(b.undoDepth === afterLocal,
    `and added nothing to this person's undo stack (${afterLocal} → ${b.undoDepth})`);
}

H('an emptied document heals with a paragraph, not a slide');
{
  const { a } = typeTabs();
  a.commit(d => { d.body.splice(0, d.body.length); });
  await settle(400);
  ok(a.doc.body.length >= 1, `the document still has a block (${a.doc.body.length})`);
  ok(a.doc.body[0]?.kind === 'para' && a.doc.body[0]?.text === '',
    'and it is an empty paragraph — somewhere to put the caret');
}

H('a photo-heavy deck snapshot fits under the relay frame ceiling (assets travel as blobs)');
{
  // A snapshot that inlined the whole asset table blew past the relay ceiling
  // and was refused 'too-large' — on a deck where no single photo is over the
  // per-image limit. snapshot() must apply diffDoc's rule: drop inline assets
  // over BLOB_INLINE_MAX (they go as blobs), keep the blob refs.
  const MAX_FRAME = 1_900_000;       // server/sync-worker/src/worker.js
  const BLOB_INLINE_MAX = 64 * 1024; // kernel/src/sync/crdt.ts
  // The relay measures the WIRE frame, not the doc JSON: online.ts seals the
  // payload as base64(iv ‖ AES-GCM(JSON)), which is ~4/3 the JSON size — the
  // reason a 1.57 MB deck (under MAX_FRAME as JSON) produced a ~2.1 MB frame
  // and was refused. Model that expansion so the ceiling comparison is real.
  const frameBytes = (jsonLen: number) => Math.ceil((jsonLen + 12 + 16) / 3) * 4; // 12B iv + 16B GCM tag
  const doc = newDoc();
  doc.docId = `rig-photo-${Math.random().toString(36).slice(2, 8)}`;
  const hero = 'data:image/jpeg;base64,' + 'A'.repeat(1_500_000); // one photo, over MAX_FRAME on its own
  const small = 'data:image/png;base64,' + 'B'.repeat(1000);      // under BLOB_INLINE_MAX, stays inline
  (doc as unknown as { assets: Record<string, string> }).assets = { hero, small };
  // offload has already run: the big asset carries a blob reference — what makes
  // dropping its inline bytes safe (the receiver rebuilds it from the blob).
  (doc as unknown as { blobs: Record<string, unknown> }).blobs =
    { hero: { key: 'k-hero', mime: 'image/jpeg', size: 1_100_000 } };
  const store = new Store(doc);
  const s = new SyncSession(store);
  const rawFrame = frameBytes(JSON.stringify(store.doc).length);
  const snap = s.snapshot();
  const leanFrame = frameBytes(JSON.stringify(snap.doc).length);
  ok(rawFrame > MAX_FRAME, `negative control: the FULL doc's frame is over the ceiling (${rawFrame} B > ${MAX_FRAME})`);
  ok(leanFrame < MAX_FRAME, `the stripped snapshot's frame fits under MAX_FRAME (${leanFrame} B)`);
  const snapAssets = (snap.doc as unknown as { assets?: Record<string, string> }).assets ?? {};
  ok(!('hero' in snapAssets), 'the large inline asset is dropped from the snapshot (it travels as a blob)');
  ok(snapAssets.small === small, 'a small inline asset is kept inline');
  const snapBlobs = (snap.doc as unknown as { blobs?: Record<string, { key: string }> }).blobs ?? {};
  ok(snapBlobs.hero?.key === 'k-hero', 'the blob reference is kept, so the receiver materialises it via resolveBlobs');
  ok((store.doc as unknown as { assets: Record<string, string> }).assets.hero === hero,
    'the local store keeps the full asset — only the snapshot copy is stripped');

  // pending-upload count: what the editor shows as "N pictures still uploading"
  ok(s.pendingBlobUploads() === 0, 'no pending uploads when every large asset already has a blob ref');
  (store.doc as unknown as { assets: Record<string, string> }).assets.hero2 =
    'data:image/jpeg;base64,' + 'C'.repeat(200_000); // large, no ref yet
  ok(s.pendingBlobUploads() === 1, 'a large asset without a blob ref counts as pending');

  // the snapshot discriminator: a refused snapshot carries snapshot:true, ops:0,
  // so the editor words it "the deck is too large" not "that change is too large"
  let last: { code: string; ops: number; permanent: boolean; snapshot?: boolean } | null = null;
  const un = s.onNotice((n) => { last = n as never; });
  s.refused('too-large', null, { snapshot: true });
  ok(last?.snapshot === true && last?.ops === 0 && last?.permanent === true,
    'a snapshot refusal emits { snapshot:true, ops:0, permanent:true }');
  un();
  s.stop?.();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
// BroadcastChannel and the heartbeat keep node's event loop alive
process.exit(failures ? 1 : 0);
