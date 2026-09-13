#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The SESSION's broadcast surface — startShow/endShow, the verb channel, the
// projection onto the aud stream, and the audience's reception.
//
//   node scripts/test-sync-show.ts
//
// Drives the REAL SyncSession over a REAL slides Store, with a recording fake
// online transport in place of the relay, so the assertions are about the
// session's actual control flow. What it proves:
//
//   1. startShow installs the show key, waits until the socket may write, and
//      sends `live` then a first audsnap — in that order.
//   2. THE AUDSNAP STATE IS FRESH-ADOPT, not the live state. Security's finding:
//      the live/stampInto state carries `stash` (dead-window values — deleted
//      slides' notes) and per-character `txt` history, neither of which the
//      projection removed. The audsnap state must be rebuilt from the projected
//      doc alone. Asserted three ways: byte-identical to an independent adopt,
//      empty stash, empty txt — while the LIVE state has both populated.
//   3. THE PROJECTION IS APPLIED. An op the app maps to null never reaches the
//      aud stream; a batch that projects to nothing sends no frame.
//   4. The verb surface (nav/black/laser) is null until a show is on, then
//      sends signed control frames; endShow sends `end` and drops the key.
//   5. checkpoint (soft cap or show-full) re-bases the audience with a fresh
//      audsnap the session builds itself, and surfaces a `checkpoint` event.
//   6. THE AUDIENCE applies aud ops through the reader path (no re-broadcast),
//      applies an audsnap, and surfaces verbs / count / close as show events.

const listeners: Record<string, Array<() => void>> = {};
(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: number) => clearTimeout(h),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (h: number) => clearInterval(h),
  addEventListener: (ev: string, fn: () => void) => { (listeners[ev] ??= []).push(fn); },
};

const { register } = await import('node:module');
register('./lib/ts-resolve-hooks.mjs', import.meta.url);

const { Store } = await import('../slides/src/store.ts');
const { SyncSession } = await import('../slides/src/sync/session.ts');
const { newDoc, emptySlide } = await import('../slides/src/model.ts');
// slides' engine is bound to its doc shape; the independent adopt below must
// use the SAME bound engine the session uses, not the bare kernel one.
const { SyncState } = await import('../slides/src/sync/crdt.ts');

let failures = 0, checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`); } else console.log(`  ok    ${msg}`);
}
const H = (s: string) => console.log(`\n=== ${s} ===`);
const settle = (ms = 260) => new Promise(r => setTimeout(r, ms));
type Op = { a: string; l: number; op: string; sl?: string; el?: string; k?: string; v?: unknown };

/** A recording stand-in for the online transport. The session finds it by its
 *  setShowKey method, exactly as it finds the real one. */
function recorder() {
  const rec = {
    kind: 'online',
    showKey: null as string | null,
    aud: [] as Op[][],
    snaps: [] as Array<{ doc: unknown; state: Record<string, unknown> }>,
    verbs: [] as Array<{ kind: string; payload?: unknown }>,
    send() {},
    close() {},
    writeReady: () => Promise.resolve(),
    setShowKey(k: string | null) { rec.showKey = k; return Promise.resolve(); },
    sendAud(ops: Op[]) { rec.aud.push(ops); },
    sendAudSnap(doc: unknown, state: Record<string, unknown>) { rec.snaps.push({ doc, state }); },
    sendVerb(kind: string, payload?: unknown) { rec.verbs.push({ kind, payload }); return Promise.resolve(); },
  };
  return rec;
}

function deckWithSecret() {
  const doc = newDoc();
  doc.docId = `show-${Math.random().toString(36).slice(2, 10)}`;
  doc.slides = [
    { ...emptySlide(), id: 's1', notes: 'public notes', elements: [
      { id: 'e1', type: 'text', x: 100, y: 100, w: 600, h: 120, html: 'Title' },
      { id: 'e2', type: 'text', x: 100, y: 300, w: 600, h: 120, html: 'Body' },
    ] },
    { ...emptySlide(), id: 'secret', notes: 'CONFIDENTIAL speaker notes', elements: [
      { id: 'se1', type: 'text', x: 100, y: 100, w: 600, h: 120, html: 'Rehearsal only' },
    ] },
  ] as never;
  return doc;
}

/** The projection slides would inject: drop the secret slide and its elements. */
const projectDoc = (doc: { slides: Array<{ id: string }> }) => {
  const c = JSON.parse(JSON.stringify(doc));
  c.slides = c.slides.filter((s: { id: string }) => s.id !== 'secret');
  return c;
};
const projectOp = (op: Op): Op | null => (op.sl === 'secret' || (op.el ?? '').includes('se1') ? null : op);

console.log('bento-sync — the session broadcast surface\n');

H('startShow: key, then live, then a fresh-adopt audsnap');
{
  const store = new Store(deckWithSecret());
  const s = new SyncSession(store);
  const tr = recorder();
  s.addTransport(() => tr as never);
  // give the LIVE session real text history + a dead-window value, so "the
  // audsnap is not the live state" is a real contrast and not vacuous
  store.commit(() => { store.doc.slides[0].elements[0].html = 'Title v2'; });
  await settle();
  store.commit(() => { store.doc.slides[0].elements[0].html = 'Title v3 typed'; });
  await settle();
  const liveState = s.snapshot().state as Record<string, unknown>;

  await s.startShow({ showKey: 'c2hvd2tleTMyYnl0ZXNj2hvd2tleTMyYnl0ZQ', projectOp, snapshot: () => ({ doc: projectDoc(store.doc) }) });

  ok(tr.showKey === 'c2hvd2tleTMyYnl0ZXNj2hvd2tleTMyYnl0ZQ', 'the show key was installed on the transport');
  ok(tr.verbs.length === 1 && tr.verbs[0].kind === 'live', 'a `live` verb was sent');
  ok(tr.snaps.length === 1, 'a first audsnap was sent');

  const audState = tr.snaps[0].state;
  // (2a) byte-identical to an independent adopt of the projected doc
  const eng = new SyncState((s as unknown as { actor: string }).actor);
  (eng as unknown as { adopt(d: unknown): void }).adopt(projectDoc(store.doc));
  const independent = JSON.parse(JSON.stringify(eng.toJSON()));
  ok(JSON.stringify(audState) === JSON.stringify(independent), 'the audsnap state is byte-identical to a fresh adopt of the projected doc');
  // (2b) explicitly: no stash, no txt history — the two leak channels
  ok(JSON.stringify(audState.stash ?? {}) === '{}', 'the audsnap state carries NO stash (no dead-window values)');
  ok(JSON.stringify(audState.txt ?? {}) === '{}', 'the audsnap state carries NO per-character text history');
  // and the LIVE state HAS them, so the contrast is real
  ok(JSON.stringify(liveState.txt ?? {}) !== '{}', 'the LIVE state does carry text history (the thing not leaked)');
  // (2c) the secret slide is not in the projected state
  ok(!Object.keys(audState.pos as object).some(k => k.includes('secret')), 'the secret slide is absent from the audsnap state');
  ok(!(tr.snaps[0].doc as { slides: Array<{id:string}> }).slides.some(sl => sl.id === 'secret'), 'and absent from the audsnap doc');

  s.stop?.();
}

H('the projection filters the aud op stream');
{
  const store = new Store(deckWithSecret());
  const s = new SyncSession(store);
  const tr = recorder();
  s.addTransport(() => tr as never);
  await s.startShow({ showKey: 'c2hvd2tleTMyYnl0ZXNj2hvd2tleTMyYnl0ZQ', projectOp, snapshot: () => ({ doc: projectDoc(store.doc) }) });
  tr.aud.length = 0;

  // one commit touching a PUBLIC element and a SECRET one
  store.commit(() => {
    store.doc.slides[0].elements[1].html = 'Body edited';
    store.doc.slides[1].elements[0].html = 'secret edited';
  });
  await settle();
  ok(tr.aud.length >= 1, 'the public edit reached the aud stream');
  const all = tr.aud.flat();
  ok(all.length > 0 && all.every(op => op.el !== 'se1' && op.sl !== 'secret'), 'no secret op is on the aud stream');
  ok(all.some(op => (op.el ?? '').includes('e2')), 'the public op is (composite elKey)');

  // a commit touching ONLY the secret sends nothing
  tr.aud.length = 0;
  store.commit(() => { store.doc.slides[1].elements[0].html = 'secret again'; });
  await settle();
  ok(tr.aud.length === 0, 'a batch that projects to nothing sends no aud frame');
  s.stop?.();
}

H('the verb surface, and endShow');
{
  const store = new Store(deckWithSecret());
  const s = new SyncSession(store);
  const tr = recorder();
  s.addTransport(() => tr as never);
  ok(s.show === null, 'no verb surface before a show');
  await s.startShow({ showKey: 'c2hvd2tleTMyYnl0ZXNj2hvd2tleTMyYnl0ZQ', projectOp, snapshot: () => ({ doc: projectDoc(store.doc) }) });
  ok(s.show !== null, 'the verb surface exists during a show');
  tr.verbs.length = 0;
  s.show!.nav({ id: 's1' });
  s.show!.black({ on: true });
  s.show!.laser({ x: 1, y: 2 });
  await settle(20);
  ok(tr.verbs.filter(v => v.kind === 'nav')[0]?.payload && (tr.verbs.find(v=>v.kind==='nav')!.payload as {id:string}).id === 's1', 'nav carries its payload');
  ok(tr.verbs.some(v => v.kind === 'black') && tr.verbs.some(v => v.kind === 'laser'), 'black and laser are sent');
  await s.endShow();
  ok(s.show === null, 'endShow closes the verb surface');
  ok(tr.verbs.some(v => v.kind === 'end'), 'endShow sends `end`');
  ok(tr.showKey === null, 'and drops the show key');
  s.stop?.();
}

H('checkpoint re-bases the audience with a fresh audsnap');
{
  const store = new Store(deckWithSecret());
  const s = new SyncSession(store);
  const tr = recorder();
  s.addTransport(() => tr as never);
  const events: Array<{ t: string }> = [];
  s.onShow(e => events.push(e));
  await s.startShow({ showKey: 'c2hvd2tleTMyYnl0ZXNj2hvd2tleTMyYnl0ZQ', projectOp, snapshot: () => ({ doc: projectDoc(store.doc) }) });
  tr.snaps.length = 0;
  s.showCheckpoint();
  ok(tr.snaps.length === 1, 'checkpoint sends a fresh audsnap');
  ok(JSON.stringify(tr.snaps[0].state.stash ?? {}) === '{}', 'and it too is stash-free');
  ok(events.some(e => e.t === 'checkpoint'), 'checkpoint surfaces an event to the app');
  s.stop?.();
}

H('the audience: reader-path apply, snapshot, and show events');
{
  const store = new Store(deckWithSecret());
  const s = new SyncSession(store);
  // an audience session never startShow's; it only receives.
  const events: Array<Record<string, unknown>> = [];
  s.onShow(e => events.push(e as never));

  // an aud op applies through the reader path (state.apply + emit, not commit)
  s.applyShowOps([{ a: 'pres', s: 1, l: 9, op: 'set', sl: 's1', el: 's1\u001fe1', k: 'x', v: 777 } as never]);
  ok(store.doc.slides[0].elements[0].x === 777, 'an aud op applies to the document (reader path)');

  // a verb surfaces
  s.showVerb('nav', { id: 's2' });
  s.showVerb('black', { on: true });
  ok(events.some(e => e.t === 'verb' && e.kind === 'nav' && (e.payload as {id:string}).id === 's2'), 'a nav verb surfaces with its payload');
  ok(events.some(e => e.t === 'verb' && e.kind === 'black'), 'a black verb surfaces');

  // count and close surface
  s.showCount(4);
  s.showClosed(4001);
  ok(events.some(e => e.t === 'count' && e.n === 4), 'the audience count surfaces');
  ok(events.some(e => e.t === 'closed' && e.code === 4001), 'a close code surfaces');
  s.stop?.();
}

console.log(failures ? `\n${failures} FAILED of ${checks}` : `\nALL PASS (${checks} checks)`);
process.exit(failures ? 1 : 0);
