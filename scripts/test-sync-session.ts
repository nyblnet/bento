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
// A document with a mutable `hidden` and captured visibilitychange handlers, so
// the rig can background/foreground a tab and fire the event the session listens
// for. The session uses document only for these two things (presence away + the
// visibility beat).
const visHandlers: Array<() => void> = [];
const fakeDoc = {
  hidden: false,
  addEventListener: (ev: string, fn: () => void) => { if (ev === 'visibilitychange') visHandlers.push(fn); },
};
(globalThis as unknown as { document: unknown }).document = fakeDoc;
/** background/foreground every tab and fire visibilitychange, as a browser does */
const setHidden = (h: boolean) => { fakeDoc.hidden = h; for (const fn of visHandlers) fn(); };

// App source is written for Vite and imports without file extensions; Node
// needs help resolving those. Registered BEFORE the dynamic imports below —
// which is why they are dynamic.
const { register } = await import('node:module');
register('./lib/ts-resolve-hooks.mjs', import.meta.url);

const { Store } = await import('../slides/src/store.ts');
const { SyncSession, assetsToOffload } = await import('../slides/src/sync/session.ts');
const { newDoc, emptySlide } = await import('../slides/src/model.ts');
const { SYNC_V } = await import('../kernel/src/sync/crdt.ts');
const { FROM_LIVE, keepLiveIdentity, CAP_FIELDS, withoutCaps, COLLAB_READER_KEEP, collabForReader, COLLAB_INVITE_KEEP, collabForInvite } = await import('../kernel/src/docfields.ts');

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

// ---- a backgrounded tab is `away`, not gone, and beats on return -----------
H('presence: a hidden tab is away, and a return beats at once');
{
  const { sa, sb, close } = tabs();
  await settle(150);
  const aFromB = () => sb.peers().find(p => p.actor === sa.actor);
  setHidden(true); // browsers fire visibilitychange → the session beats
  await settle(150);
  ok(aFromB()?.away === true, 'a hidden tab is seen as away by its peer, not dropped');
  setHidden(false);
  await settle(150);
  ok(!aFromB()?.away, 'returning to the foreground clears away immediately (beat on visibilitychange)');
  close();
  setHidden(false);
}

// ---- a slow (throttled) beat is not swept before the TTL; a real leave is ---
// A backgrounded tab's timers throttle to ~once a minute; the sweep must not
// drop such a peer between beats. The clock is mocked so the peer's AGE is
// controlled, and the heartbeat is sped up so the sweep runs without a 75 s wait.
H('presence: a peer last seen 60s ago survives; 80s is swept');
{
  const win = (globalThis as unknown as { window: { setInterval: (fn: () => void, ms: number) => unknown } }).window;
  const realSI = win.setInterval;
  win.setInterval = (fn: () => void, ms: number) => realSI(fn, ms >= 1000 ? 30 : ms); // 5s heartbeat → 30ms
  const realNow = Date.now; let clock = 5_000_000; (Date as unknown as { now: () => number }).now = () => clock;
  try {
    const doc = newDoc(); doc.docId = `rig-ttl-${Math.random().toString(36).slice(2, 8)}`;
    const s = new Store(JSON.parse(JSON.stringify(doc)));
    const sess = new SyncSession(s);
    await settle(80); // sess attaches; sweep now runs every ~30ms
    const ch = new BroadcastChannel(`bento-sync-${doc.docId}`);
    // one peer beats ONCE and never again (throttled to silence), at clock=t0
    ch.postMessage({ t: 'p', a: 'ghost', pv: SYNC_V, p: { name: 'Ghost', color: '#8FA3BF', slide: 's1', sel: [] } });
    await settle(80);
    const hasGhost = () => sess.peers().some(p => p.actor === 'ghost');
    ok(hasGhost(), 'the peer is present after its single beat');
    clock += 60_000; // 60s later, no further beat
    await settle(120);
    ok(hasGhost(), 'a peer last seen 60s ago is NOT swept — the TTL clears the 60s hidden-tab throttle');
    clock += 20_000; // 80s total
    await settle(120);
    ok(!hasGhost(), 'a peer gone 80s IS swept — a real departure still clears');
    ch.close(); sess.stop?.();
  } finally {
    (Date as unknown as { now: () => number }).now = realNow;
    win.setInterval = realSI;
  }
}

// ---- cumulative offload: the inline total, not just per-asset size ---------
H('cumulative offload picks the largest inline assets when the total overflows');
{
  const K = 1024;
  // fifty 50 KB icons — none over 64 KB, but 2.5 MB inline together
  const icons = Array.from({ length: 50 }, (_, i) => ({ key: `i${i}`, len: 50 * K, offloadable: true }));
  const picks = assetsToOffload(icons, 64 * K, 256 * K);
  const left = icons.filter(e => !picks.has(e.key)).reduce((n, e) => n + e.len, 0);
  ok(picks.size > 0 && left <= 256 * K,
    `fifty 50 KB icons: enough offloaded to get inline under 256 KB (${picks.size} offloaded, ${(left / K) | 0} KB left)`);
  // per-asset rule still applies; small assets under the total stay inline
  const mixed = [{ key: 'big', len: 100 * K, offloadable: true }, { key: 's1', len: 10 * K, offloadable: true }, { key: 's2', len: 10 * K, offloadable: true }];
  const p2 = assetsToOffload(mixed, 64 * K, 256 * K);
  ok(p2.has('big') && !p2.has('s1') && !p2.has('s2'), 'one over-64 KB asset offloads; small ones under the total stay inline');
  // a deck under the total keeps everything inline — no needless offload
  const small = Array.from({ length: 4 }, (_, i) => ({ key: `s${i}`, len: 40 * K, offloadable: true }));
  ok(assetsToOffload(small, 64 * K, 256 * K).size === 0, 'a deck under the total keeps its assets inline');
  // a raw-SVG asset (not offloadable) is never picked, even when it pushes the total over
  const withSvg = [{ key: 'svg', len: 300 * K, offloadable: false }, { key: 'png', len: 200 * K, offloadable: true }];
  const p4 = assetsToOffload(withSvg, 64 * K, 256 * K);
  ok(!p4.has('svg') && p4.has('png'), 'a raw-SVG asset stays inline (nothing to blob); the offloadable one goes');
}

// A fork's offline contributions live only in its doc values + restored
// registers, never as replayable log ops. It snapshots them once at its own
// hello; a peer that joins LATER (a same-machine tab, over replay-less
// BroadcastChannel) misses that and never converges. The fork must re-send its
// snapshot to each genuinely new peer.
H('a fork re-sends its snapshot to a peer that joins later');
{
  // Build a saved FORK file: a shared doc, edited, with the CRDT state stamped
  // in (what an offline-edited copy carries on disk).
  const base = newDoc(); base.docId = `fork-${Math.random().toString(36).slice(2, 8)}`;
  (base as unknown as { collab: { room: string; key: string; on: boolean } }).collab = { room: 'r', key: 'k', on: true };
  const seed = new Store(JSON.parse(JSON.stringify(base)));
  const sseed = new SyncSession(seed);
  seed.commit(() => { seed.doc.title = 'forked offline'; });
  await settle();
  (sseed as unknown as { stampInto: (d: unknown) => void }).stampInto(seed.doc);
  sseed.stop?.();
  const forkFile = JSON.parse(JSON.stringify(seed.doc));
  ok(!!forkFile.collab?.sync, 'the saved fork carries a stamped CRDT state');

  // Open the fork; capture what it sends.
  const A = new Store(JSON.parse(JSON.stringify(forkFile)));
  const sA = new SyncSession(A);
  const sent: Array<{ t: string }> = [];
  sA.addTransport(() => ({ send: (f: { t: string }) => sent.push(f), close() {} }) as never);
  ok((sA as unknown as { carriesForkState: boolean }).carriesForkState === true,
    'a restored fork knows it carries un-logged state');

  const hello = (a: string) => (sA as unknown as { onFrame: (f: unknown) => void })
    .onFrame({ t: 'hello', a, vv: {}, p: {}, pv: SYNC_V });

  // a brand-new peer announces itself → the fork answers with a snapshot
  sent.length = 0;
  hello('late-tab');
  const snap = sent.find((f) => f.t === 'snap') as undefined | { doc: { title?: string } };
  ok(!!snap, 'the fork answers a new peer’s hello with a snapshot');
  ok(snap?.doc?.title === 'forked offline', 'the snapshot carries the fork’s content');

  // a repeat hello from a peer we already know must NOT re-snap
  sent.length = 0;
  hello('late-tab');
  ok(!sent.some((f) => f.t === 'snap'), 'a repeat hello from a known peer is not re-snapped');

  sA.stop?.();
}

H('a non-fork session does not snap new peers (log catch-up suffices)');
{
  const plain = newDoc(); plain.docId = `plain-${Math.random().toString(36).slice(2, 8)}`;
  const A = new Store(JSON.parse(JSON.stringify(plain)));
  const sA = new SyncSession(A);
  const sent: Array<{ t: string }> = [];
  sA.addTransport(() => ({ send: (f: { t: string }) => sent.push(f), close() {} }) as never);
  ok((sA as unknown as { carriesForkState: boolean }).carriesForkState === false,
    'a fresh adopt carries no fork state');
  sent.length = 0;
  (sA as unknown as { onFrame: (f: unknown) => void })
    .onFrame({ t: 'hello', a: 'peer2', vv: {}, p: {}, pv: SYNC_V });
  ok(!sent.some((f) => f.t === 'snap'), 'a non-fork does not snap; the op log catches peers up');
  sA.stop?.();
}

// Offline chain: A forks, B merges A's snapshot (so B holds that state only in
// registers), then C joins asking B. B must carry the fork onward — otherwise C,
// a third same-machine tab with no relay replay, never converges.
H('a merged-in fork is carried onward to a third tab (offline chain)');
{
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const docId = `chain-${Math.random().toString(36).slice(2, 8)}`;
  // A: build + open the fork
  const base = newDoc(); base.docId = docId;
  (base as unknown as { collab: { room: string; key: string; on: boolean } }).collab = { room: 'r', key: 'k', on: true };
  const seed = new Store(clone(base)); const sseed = new SyncSession(seed);
  seed.commit(() => { seed.doc.title = 'forked offline'; });
  await settle();
  (sseed as unknown as { stampInto: (d: unknown) => void }).stampInto(seed.doc);
  sseed.stop?.();
  const A = new Store(clone(seed.doc)); const sA = new SyncSession(A);
  const aSent: Array<{ t: string; doc?: unknown; state?: unknown }> = [];
  sA.addTransport(() => ({ send: (f: { t: string }) => aSent.push(f), close() {} }) as never);
  (sA as unknown as { onFrame: (f: unknown) => void }).onFrame({ t: 'hello', a: 'B', vv: {}, p: {}, pv: SYNC_V });
  const aSnap = aSent.find((f) => f.t === 'snap') as undefined | { doc: unknown; state: unknown };
  ok(!!aSnap, 'A offered its fork snapshot');
  sA.stop?.();

  // B: a pristine replica that MERGES A's snapshot (holds the state in registers)
  const pristine = newDoc(); pristine.docId = docId; pristine.title = 'original';
  const B = new Store(clone(pristine)); const sB = new SyncSession(B);
  const bSent: Array<{ t: string; doc?: { title?: string } }> = [];
  sB.addTransport(() => ({ send: (f: { t: string }) => bSent.push(f), close() {} }) as never);
  (sB as unknown as { applySnapshot: (d: unknown, s: unknown) => void }).applySnapshot(aSnap!.doc, aSnap!.state);
  ok(B.doc.title === 'forked offline', 'B merged the fork content');
  ok((sB as unknown as { carriesForkState: boolean }).carriesForkState === true,
    'B now carries the fork state onward');

  // C: a third tab joins later, asking B — B must re-snap it
  bSent.length = 0;
  (sB as unknown as { onFrame: (f: unknown) => void }).onFrame({ t: 'hello', a: 'C', vv: {}, p: {}, pv: SYNC_V });
  const bSnap = bSent.find((f) => f.t === 'snap') as undefined | { doc?: { title?: string } };
  ok(!!bSnap && bSnap.doc?.title === 'forked offline', 'B re-sends the fork to the third tab');
  sB.stop?.();
}

// A read-only live-viewer copy (store.commit is inert) must still show a
// relay-offloaded image. resolveBlobs used to materialise through store.commit,
// so the bytes never landed and the picture stayed blank; it now applies them
// the way a remote op does (mutate + emit), bypassing the app's read-only gate.
H('a read-only live viewer still materialises a relay-offloaded image (not via commit)');
{
  // the same-origin blob cache (so getBlob is cache-first and never needs the
  // network). Resolved from whichever app workspace has fake-indexeddb — the same
  // relative strategy the esbuild hook uses, because this rig runs DIRECT (no root
  // node_modules in CI, and the hook does not resolve bare package names). Set
  // BEFORE the first cache call, since blobs.ts memoises the DB handle on first use.
  {
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    let idbMod: { indexedDB: unknown } | undefined;
    for (const app of ['slides', 'type', 'spaces', 'dash']) {
      try {
        const req = createRequire(new URL(`../${app}/package.json`, import.meta.url));
        idbMod = await import(pathToFileURL(req.resolve('fake-indexeddb')).href);
        break;
      } catch { /* try the next app workspace */ }
    }
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = idbMod?.indexedDB;
  }
  const { blobKey, cachePut, bytesToDataUri } = await import('../kernel/src/sync/blobs.ts');
  const rawKey = new Uint8Array(32).fill(7);
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  const key = await blobKey(rawKey, bytes);
  await cachePut(key, bytes); await settle(30); // prime the cache (let the IDB write commit) a same-machine peer would have written
  const doc = newDoc();
  doc.docId = `ro-${Math.random().toString(36).slice(2, 10)}`;
  (doc as unknown as { blobs: Record<string, { key: string; mime: string }> }).blobs = { hero: { key, mime: 'image/png' } };
  const store = new Store(JSON.parse(JSON.stringify(doc)));
  store.readOnly = true; // the whole point: user/app commits are no-ops here
  const sess = new SyncSession(store);
  // a transport that can reach a (fake) relay — supplies blobCreds; getBlob is
  // cache-first, so it returns the primed bytes without touching the network
  sess.addTransport(() => ({ kind: 'fake', send() {}, close() {}, blobCreds: () => ({ base: 'http://relay.test', room: 'r', tok: 't', rawKey }) } as never));
  // spy on emit to see the viewer was told to re-render, without knowing the app's event names
  const emitted: string[] = [];
  const origEmit = store.emit.bind(store);
  (store as unknown as { emit: (ev: string) => void }).emit = (ev: string) => { emitted.push(ev); return origEmit(ev); };
  emitted.length = 0;
  await (sess as unknown as { resolveBlobs: () => Promise<void> }).resolveBlobs();
  await settle(80);
  const got = (store.doc as unknown as { assets?: Record<string, string> }).assets?.hero;
  ok(got === bytesToDataUri(bytes, 'image/png'), 'the offloaded image lands in assets despite the read-only commit gate');
  ok(emitted.length > 0, 'a change event fired so the read-only viewer re-renders');
  sess.stop?.();
}

// The shared doc-fields lists (kernel/src/docfields.ts) that every app imports:
// identity kept live on restore, and the capability/secret projections — proven
// here so the one module the apps depend on has the behaviour pinned centrally.
H('docfields: identity is taken from the live doc on restore, never the snapshot');
{
  const live = { docId: 'new', collab: { on: false }, readonly: true, title: 'live' } as Record<string, unknown>;
  const restored = { docId: 'old', collab: { on: true }, template: true, title: 'snap' } as Record<string, unknown>;
  keepLiveIdentity(restored, live);
  ok(restored.docId === 'new', 'docId comes from live');
  ok((restored.collab as { on: boolean }).on === false, 'collab comes from live (sharing stays off)');
  ok(restored.readonly === true, 'readonly comes from live');
  ok(!('template' in restored), 'a field live lacks is DELETED from the restored doc (no snapshot leak)');
  ok(restored.title === 'snap', 'non-identity content is left as the snapshot had it');
  ok([...FROM_LIVE].join() === 'docId,collab,readonly,template', 'FROM_LIVE is the agreed superset');
}

H('docfields: withoutCaps drops top-level capabilities, keeps content');
{
  const doc = { docId: 'x', slides: [], title: 't', collab: { ownerPriv: 'SECRET' } } as Record<string, unknown>;
  const stripped = withoutCaps(doc) as Record<string, unknown>;
  ok(!('collab' in stripped), 'withoutCaps removes collab');
  ok(stripped.docId === 'x' && 'slides' in stripped && stripped.title === 't', 'content is kept');
  ok((doc as { collab?: unknown }).collab !== undefined, 'the source doc is untouched (shallow copy)');
  ok([...CAP_FIELDS].join() === 'collab', 'CAP_FIELDS is the top-level capability denylist');
}

H('docfields: collabForReader is an allowlist — unknown + known secrets fail closed');
{
  const dirty = {
    room: 'r', key: 'k', owner: 'o', writerPub: 'wp', on: true, v: 2, role: 'writer',
    ownerPriv: 'X', writerPriv: 'Y', invite: { priv: 'Z' }, audience: {}, sync: { v: SYNC_V },
    links: [{ url: 'https://leak' }], futureSecret: 'LEAK',
  } as Record<string, unknown>;
  const clean = collabForReader(dirty);
  ok(!('ownerPriv' in clean) && !('writerPriv' in clean) && !('invite' in clean) && !('audience' in clean),
    'the write/owner secrets are dropped');
  ok(!('sync' in clean), 'the CRDT sync stamp is dropped (readers carry no stamp)');
  ok(!('links' in clean) && !('futureSecret' in clean), 'link records and any UNKNOWN field are dropped — the allowlist fails closed');
  ok(clean.role === 'reader', 'role is FORCED to reader — a writer source never projects as a writer (#588 class)');
  ok(Object.keys(clean).sort().join() === 'key,on,owner,role,room,v,writerPub', 'exactly the allowlisted fields + the forced role survive');
  ok(clean.room === 'r' && clean.key === 'k', 'room + the symmetric read key are kept (a reader must decrypt + join)');
  ok([...COLLAB_READER_KEEP].length === 6, 'COLLAB_READER_KEEP is the 6-field public allowlist (role is forced, not copied)');
}

H('docfields: collabForInvite keeps sync + invite, still drops secrets and unknowns');
{
  const dirty = {
    room: 'r', key: 'k', owner: 'o', writerPub: 'wp', on: true, v: 2, role: 'writer',
    sync: { v: SYNC_V }, invite: { pub: 'ip', priv: 'isecret', role: 'writer', sig: 's' },
    ownerPriv: 'X', writerPriv: 'Y', audience: {},
    links: [{ url: 'https://leak' }], ownerSecret: 'LEAK',
  } as Record<string, unknown>;
  const inv = collabForInvite(dirty);
  ok('sync' in inv && 'invite' in inv, 'an invite copy keeps sync (it contributes) and its invite delegation');
  ok(!('ownerPriv' in inv) && !('writerPriv' in inv) && !('audience' in inv), 'owner/writer secrets are still dropped');
  ok(!('links' in inv) && !('ownerSecret' in inv), 'an invite copy carries NO unknown field (links / ownerSecret dropped)');
  ok(!('role' in inv), 'no top-level role on an invite copy — the role rides in invite.role');
  ok([...COLLAB_INVITE_KEEP].slice(-2).join() === 'sync,invite', 'COLLAB_INVITE_KEEP is the reader list plus sync + invite');
}

H('docfields: a reader copy with NO sync stamp joins a live room and converges');
{
  const docId = `ro-conv-${Math.random().toString(36).slice(2, 10)}`;
  // W: the live room — a writer with secrets + (conceptually) a sync stamp.
  const wdoc = newDoc(); wdoc.docId = docId;
  (wdoc as unknown as { collab: Record<string, unknown> }).collab = {
    room: 'r', key: 'k', on: true, v: 2, owner: 'o', ownerPriv: 'SECRET',
    writerPub: 'wp', writerPriv: 'WSECRET', role: 'writer', invite: { priv: 'INV' }, sync: { v: SYNC_V },
  };
  const W = new Store(JSON.parse(JSON.stringify(wdoc)));
  const sW = new SyncSession(W);
  W.commit(() => { W.doc.title = 'room content'; });
  await settle();
  // The reader copy carries only collabForReader(W.collab): no sync, no secrets.
  const rcollab = collabForReader((W.doc as unknown as { collab: Record<string, unknown> }).collab);
  ok(!('sync' in rcollab) && !('writerPriv' in rcollab) && !('ownerPriv' in rcollab),
    'the reader copy is built with no sync stamp and no write/owner secrets');
  const rdoc = newDoc(); rdoc.docId = docId; rdoc.title = 'stale';
  (rdoc as unknown as { collab: Record<string, unknown> }).collab = rcollab;
  const R = new Store(JSON.parse(JSON.stringify(rdoc)));
  const sR = new SyncSession(R);
  await settle();
  ok(R.doc.title === 'room content',
    `the no-stamp reader converged to the room content (got ${JSON.stringify(R.doc.title)})`);
  sW.stop?.(); sR.stop?.();
}

// Undo/redo move CONTENT, never identity. Two halves: stopSharing is no longer
// its own undo step (kernel markShared), AND the Store keeps the live identity
// set (docId, collab, readonly — restoregate's FROM_LIVE) across a restore, so a
// prior edit's snapshot can't resurrect an old docId, a stale sharing flag or a
// dropped read-only mode.
H('undo/redo keep the live identity (docId, collab, readonly), never the snapshot');
type Id = { collab: { on: boolean }; docId: string; readonly?: boolean; title: string };
const freshShared = () => {
  const doc = newDoc(); doc.docId = 'live-id';
  (doc as unknown as { collab: { room: string; key: string; on: boolean } }).collab = { room: 'r', key: 'k', on: true };
  const store = new Store(JSON.parse(JSON.stringify(doc)));
  return { store, sess: new SyncSession(store) };
};
// Both halves must prove the fix — i.e. the restored snapshot must carry STALE
// identity, so the row goes RED on main's unfixed store. The identity-changing
// actions (Stop sharing via markShared, "Duplicate as new deck", a present-only
// save) therefore run AFTER the step whose snapshot the undo/redo pops.
{
  // UNDO: edit, THEN change identity, THEN undo — the content-edit snapshot it
  // pops was taken while sharing was on / docId was live-id / no readonly.
  const { stopSharing } = await import('../kernel/src/sync/online.ts');
  const { store, sess } = freshShared();
  store.commit(() => { store.doc.title = 'a real edit'; });
  stopSharing(sess as never, store as never);
  const d0 = store.doc as unknown as { docId: string; readonly?: boolean };
  d0.docId = 'new-id'; d0.readonly = true; store.setDirty(true);
  store.undo(); // pops the content-edit snapshot (stale identity on main)
  const d = store.doc as unknown as Id;
  ok(d.collab.on === false, 'undo keeps the live collab (sharing stays off)');
  ok(d.docId === 'new-id', 'undo keeps the live docId, not the snapshot’s old one');
  ok(d.readonly === true, 'undo keeps the live read-only mode');
  ok(d.title !== 'a real edit', 'undo still reverted the genuine content edit');
  sess.stop?.();
}
{
  // REDO: edit, undo, THEN change identity, THEN redo. The redo entry was
  // captured at undo time — before the identity changes — so it carries the
  // OLD identity, and main resurrects all three on redo (slides' sequence).
  const { stopSharing } = await import('../kernel/src/sync/online.ts');
  const { store, sess } = freshShared();
  store.commit(() => { store.doc.title = 'a real edit'; });
  store.undo(); // redo entry captured here still has the OLD identity
  stopSharing(sess as never, store as never);
  const d0 = store.doc as unknown as { docId: string; readonly?: boolean };
  d0.docId = 'new-id'; d0.readonly = true; store.setDirty(true);
  store.redo(); // pops the stale-identity redo entry
  const r = store.doc as unknown as Id;
  ok(r.collab.on === false, 'redo keeps the live collab (sharing stays off)');
  ok(r.docId === 'new-id', 'redo keeps the live docId, not the snapshot’s old one');
  ok(r.readonly === true, 'redo keeps the live read-only mode');
  ok(r.title === 'a real edit', 'redo re-applied the content edit');
  sess.stop?.();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
// BroadcastChannel and the heartbeat keep node's event loop alive
process.exit(failures ? 1 : 0);
