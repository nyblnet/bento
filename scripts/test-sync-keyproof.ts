#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Presence key proof: SyncSession.keyProven(actor, pub).
//
//   node scripts/test-sync-keyproof.ts
//
// Real SyncSessions over a real BroadcastChannel (three tabs of one document:
// the owner, a member, a reader), plus a raw channel the rig writes frames to
// directly. Every refusal row has a control row next to it that the same path
// accepts, so a refusal can't pass because nothing was ever proven.
// scripts/test-sync-keyproof-mutants.ts re-runs this against weakened copies.

const listeners: Record<string, Array<() => void>> = {};
(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: number) => clearTimeout(h),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (h: number) => clearInterval(h),
  addEventListener: (ev: string, fn: () => void) => { (listeners[ev] ??= []).push(fn); },
};
(globalThis as unknown as { document: unknown }).document = { hidden: false, addEventListener: () => {} };
// no network: a socket that never opens
(globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
  readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null
  addEventListener() {} send() {} close() {}
};

const { register } = await import('node:module');
register('./lib/ts-resolve-hooks.mjs', import.meta.url);

const { Store } = await import('../slides/src/store.ts');
const { SyncSession } = await import('../slides/src/sync/session.ts');
const { newDoc } = await import('../slides/src/model.ts');
const { SYNC_V } = await import('../kernel/src/sync/crdt.ts');
const { mintCollab, mintInvite, deviceIdentity, OnlineTransport, joinFromDoc, disconnectOnline } = await import('../kernel/src/sync/online.ts');
const { signProof, roomIdOf, PROOF_SKEW_MS, KeyProofs } = await import('../kernel/src/sync/keyproof.ts');

let failures = 0, checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`); } else console.log(`  ok    ${msg}`);
}
const H = (s: string) => console.log(`\n=== ${s} ===`);
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
async function keypair() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return { key: kp.privateKey, pub: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))) };
}

// ---- one document, three tabs -------------------------------------------------
const base = newDoc();
base.docId = `rig-kp-${Math.random().toString(36).slice(2, 10)}`;
const collab = await mintCollab();
const room = roomIdOf(collab.room)!;
ok(!!room && room.startsWith('w'), `the room id is the room's last path segment (${room.slice(0, 8)}…)`);
const invite = await mintInvite(collab.ownerPriv, 'writer');
const member = await deviceIdentity(base.docId); // resolved in this page, as the transport does on connect

const ownerDoc = { ...JSON.parse(JSON.stringify(base)), collab: { ...collab } };
const memberDoc = { ...JSON.parse(JSON.stringify(base)), collab: { room: collab.room, key: collab.key, on: true, v: 2, owner: collab.owner, invite, role: 'writer' } };
const readerDoc = { ...JSON.parse(JSON.stringify(base)), collab: { room: collab.room, key: collab.key, on: true, v: 2, owner: collab.owner, role: 'reader' } };

// a sniffer on the same channel records every frame the tabs send
const seen: Array<Record<string, unknown>> = [];
const sniff = new BroadcastChannel(`bento-sync-${base.docId}`);
sniff.onmessage = (ev) => { seen.push(ev.data); };
const raw = new BroadcastChannel(`bento-sync-${base.docId}`);
const post = (f: Record<string, unknown>) => raw.postMessage({ pv: SYNC_V, ...f });
const pres = (pub?: string, extra: Record<string, unknown> = {}) => ({ name: 'X', color: '#8FA3BF', slide: 's1', sel: [], ...(pub ? { pub } : {}), ...extra });

const so = new Store(ownerDoc), sm = new Store(memberDoc), sr = new Store(readerDoc);
const O = new SyncSession(so); await settle(60);
const M = new SyncSession(sm); await settle(60);
const R = new SyncSession(sr); await settle(200);

H('owner, member and reader tabs over BroadcastChannel');
ok(O.keyProven(M.actor, member.pub), "control: the owner's tab sees the member's key proven");
ok(M.keyProven(O.actor, collab.owner), "control: the member's tab sees the owner's key proven");
ok(R.keyProven(O.actor, collab.owner) && R.keyProven(M.actor, member.pub), 'control: a reader tab verifies both');
ok(O.peers().some((p) => p.actor === R.actor), 'the reader is present');
const rFrames = seen.filter((f) => f.a === R.actor && (f.t === 'p' || f.t === 'hello'));
ok(rFrames.length > 0 && rFrames.every((f) => !f.kp && !(f.p as { pub?: string }).pub), 'a reader sends presence with no pub and no proof');
const mFrames = seen.filter((f) => f.a === M.actor && (f.t === 'p' || f.t === 'hello'));
ok(mFrames.length > 0 && mFrames.every((f) => !!f.kp), `every member beat carries a proof (${mFrames.length})`);
ok(mFrames.some((f) => f.t === 'hello' && !!f.kp), 'the hello carries one too');
const ts = mFrames.map((f) => (f.kp as { t: number }).t);
ok(ts.every((t, i) => i === 0 || t > ts[i - 1]), 'proof timestamps strictly increase');
ok(!O.keyProven(M.actor, collab.owner), "the member's actor is not proven for another key");
ok(!O.keyProven(R.actor, collab.owner), "the reader's actor is not proven for the owner's key");

H('a beat naming a key without proving it');
post({ t: 'p', a: 'x-claim', p: pres(member.pub) });
await settle();
ok(O.peers().some((p) => p.actor === 'x-claim' && p.pub === member.pub), 'the beat is still presence (older shells keep working)');
ok(!O.keyProven('x-claim', member.pub), 'unsigned: not proven');
const mBeat = mFrames.at(-1)!;
post({ t: 'p', a: 'x-replay', p: pres(member.pub), kp: mBeat.kp });
await settle();
ok(!O.keyProven('x-replay', member.pub), "the member's own proof under another actor: not proven");
const X = await keypair();
post({ t: 'p', a: 'x-own', p: pres(X.pub), kp: await signProof(X.key, room, 'x-own', X.pub, Date.now()) });
post({ t: 'p', a: 'x-other', p: pres(member.pub), kp: await signProof(X.key, room, 'x-other', member.pub, Date.now()) });
await settle();
ok(O.keyProven('x-own', X.pub), 'control: a raw sender proving its OWN key is proven');
ok(!O.keyProven('x-other', member.pub), "a proof by one key naming another's: not proven");
post({ t: 'p', a: 'x-room', p: pres(X.pub), kp: await signProof(X.key, 'w-another-room', 'x-room', X.pub, Date.now()) });
await settle();
ok(!O.keyProven('x-room', X.pub), 'a proof for another room: not proven');
post({ t: 'hello', a: 'x-hello', vv: {}, p: pres(X.pub), kp: await signProof(X.key, room, 'x-hello', X.pub, Date.now()) });
post({ t: 'hello', a: 'x-hello-bad', vv: {}, p: pres(X.pub), kp: { t: Date.now(), g: 'A'.repeat(86) } });
await settle();
ok(O.keyProven('x-hello', X.pub), 'control: a proof on hello is verified');
ok(!O.keyProven('x-hello-bad', X.pub), 'a bad signature on hello: not proven');

H('continuity');
const Y = await keypair();
let yT = Date.now();
const yBeat = async (actor = 'y', extra: Record<string, unknown> = {}) => {
  yT = Math.max(Date.now(), yT + 1);
  post({ t: 'p', a: actor, p: pres(Y.pub, extra), kp: await signProof(Y.key, room, actor, Y.pub, yT) });
  await settle();
};
await yBeat();
ok(O.keyProven('y', Y.pub), 'control: proven');
post({ t: 'p', a: 'y', p: pres(Y.pub) }); await settle();
ok(!O.keyProven('y', Y.pub), 'one unsigned beat: no longer proven');
await yBeat();
ok(O.keyProven('y', Y.pub), 'a fresh proof: proven again');
post({ t: 'p', a: 'y', p: pres(Y.pub), kp: { t: Date.now() + 5, g: 'A'.repeat(86) } }); await settle();
ok(!O.keyProven('y', Y.pub), 'one bad signature: no longer proven');
await yBeat();
ok(O.keyProven('y', Y.pub), 'and back with the next fresh proof');
post({ t: 'p', a: 'y', p: pres() }); await settle();
ok(!O.keyProven('y', Y.pub), 'a beat that drops the pub: not proven');
await yBeat();
const Z = await keypair();
post({ t: 'p', a: 'y', p: pres(Z.pub), kp: await signProof(Z.key, room, 'y', Z.pub, Date.now() + 10) }); await settle();
ok(O.keyProven('y', Z.pub) && !O.keyProven('y', Y.pub), 'a proven switch of key: only the new key is proven');

H('freshness');
await yBeat('f');
ok(O.keyProven('f', Y.pub), 'control: proven');
const fLast = yT;
post({ t: 'p', a: 'f', p: pres(Y.pub), kp: await signProof(Y.key, room, 'f', Y.pub, fLast) }); await settle();
ok(!O.keyProven('f', Y.pub), 'the same timestamp again: not proven');
await yBeat('f');
post({ t: 'p', a: 'f', p: pres(Y.pub), kp: await signProof(Y.key, room, 'f', Y.pub, yT - 1) }); await settle();
ok(!O.keyProven('f', Y.pub), 'an earlier timestamp: not proven');
await yBeat('f');
ok(O.keyProven('f', Y.pub), 'control: the next increasing one is');
post({ t: 'p', a: 'old', p: pres(Y.pub), kp: await signProof(Y.key, room, 'old', Y.pub, Date.now() - PROOF_SKEW_MS - 5_000) });
post({ t: 'p', a: 'future', p: pres(Y.pub), kp: await signProof(Y.key, room, 'future', Y.pub, Date.now() + PROOF_SKEW_MS + 5_000) });
post({ t: 'p', a: 'edge', p: pres(Y.pub), kp: await signProof(Y.key, room, 'edge', Y.pub, Date.now() - PROOF_SKEW_MS + 5_000) });
await settle();
ok(!O.keyProven('old', Y.pub), 'a timestamp older than the skew: not proven');
ok(!O.keyProven('future', Y.pub), 'a timestamp ahead of the skew: not proven');
ok(O.keyProven('edge', Y.pub), 'control: a timestamp just inside the skew is proven');

H('leaving');
await yBeat('gone');
ok(O.keyProven('gone', Y.pub), 'control: proven');
post({ t: 'bye', a: 'gone' }); await settle();
ok(!O.keyProven('gone', Y.pub) && !O.peers().some((p) => p.actor === 'gone'), 'after bye: gone and not proven');

H('revocation');
const V = await keypair();
let vT = Date.now();
const vBeat = async () => { vT = Math.max(Date.now(), vT + 1); post({ t: 'p', a: 'v', p: pres(V.pub), kp: await signProof(V.key, room, 'v', V.pub, vT) }); await settle(); };
await vBeat();
ok(O.keyProven('v', V.pub), 'control: proven');
O.noteRevoked(V.pub);
ok(!O.keyProven('v', V.pub), 'a revocation seen: not proven');
await vBeat();
ok(!O.keyProven('v', V.pub), 'and a fresh proof after it changes nothing this session');
ok(M.keyProven('v', V.pub), 'control: a tab that saw no revocation still proves it');
// the relay's note reaches the session through the transport hook
{
  let got = '';
  const tr = new OnlineTransport(collab.room, collab.key, base.docId, () => {}, {
    onSnap: () => {}, getSnapshot: () => M.snapshot(), onOpen: () => {}, onReady: () => false,
    onRevoked: (p: string) => { got = p; M.noteRevoked(p); },
  });
  await (tr as unknown as { onEnvelope(t: string): Promise<void> }).onEnvelope(JSON.stringify({ ctl: 'revoked', p: V.pub }));
  ok(got === V.pub && !M.keyProven('v', V.pub), "the relay's revoked note reaches the session");
  tr.close();
}

// and through the transport joinFromDoc builds for a live session
{
  const U = await keypair();
  const uBeat = async () => { post({ t: 'p', a: 'u', p: pres(U.pub), kp: await signProof(U.key, room, 'u', U.pub, Date.now()) }); await settle(); };
  await uBeat();
  ok(O.keyProven('u', U.pub), 'control: proven');
  const tr = joinFromDoc(O, so);
  ok(!!tr, 'the owner tab has an online transport');
  await (tr as unknown as { onEnvelope(t: string): Promise<void> }).onEnvelope(JSON.stringify({ ctl: 'revoked', p: U.pub }));
  ok(!O.keyProven('u', U.pub), "the joined transport's revoked note reaches the session");
  disconnectOnline(O);
}

// a revocation that lands WHILE a beat's proof is being verified: the beat
// passed the revocation check before the await, so only the re-check after
// verification can refuse it. The clock is read just before the verify starts;
// it queues the revocation to run as soon as the verify yields.
{
  const T = await keypair();
  const judge = async (revokeMidVerify: boolean) => {
    const t = Date.now();
    const proof = await signProof(T.key, room, 'tv', T.pub, t);
    let revokedAt = '';
    const kps = new KeyProofs(() => {
      if (revokeMidVerify) queueMicrotask(() => { revokedAt = kps.proven('tv', T.pub) ? 'after' : 'during'; kps.revoke(T.pub); });
      return t;
    });
    await kps.accept('tv', room, T.pub, proof);
    return { proven: kps.proven('tv', T.pub), revokedAt };
  };
  const control = await judge(false);
  ok(control.proven, 'control: the same beat, nothing revoked, is proven');
  const mid = await judge(true);
  ok(mid.revokedAt === 'during', 'the revocation landed while the verify was pending');
  ok(!mid.proven, 'a key revoked while its proof was being verified: not proven');
}

H('a legacy shared-writer copy proves its writer key');
{
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const writerPub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  const writerPriv = b64u(new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)));
  const legacyDoc = { ...JSON.parse(JSON.stringify(base)), collab: { room: collab.room, key: collab.key, on: true, writerPub, writerPriv } };
  const L = new SyncSession(new Store(legacyDoc));
  await settle(200);
  ok(O.keyProven(L.actor, writerPub), 'control: the writer key is proven');
}

H('role is a claim');
post({ t: 'p', a: 'r-claim', p: pres(collab.owner, { role: 'owner' }) });
await settle();
ok(!O.keyProven('r-claim', collab.owner), "role 'owner' with the owner's pub, unsigned: not proven");
const W = await keypair();
post({ t: 'p', a: 'r-own', p: pres(W.pub, { role: 'owner' }), kp: await signProof(W.key, room, 'r-own', W.pub, Date.now()) });
await settle();
ok(O.keyProven('r-own', W.pub) && !O.keyProven('r-own', collab.owner), "role 'owner' proves nothing beyond the key it signed with");

H('a proof nested inside presence is ignored');
post({ t: 'p', a: 'nested', p: pres(X.pub, { kp: await signProof(X.key, room, 'nested', X.pub, Date.now()) }) });
await settle();
ok(!O.keyProven('nested', X.pub), 'a valid proof inside p, none on the frame: not proven');
ok(!O.peers().some((p) => p.actor === 'nested' && 'kp' in p), 'and the peer record carries no proof field');

console.log(`\n${checks - failures}/${checks} checks passed`);
sniff.close(); raw.close();
process.exit(failures ? 1 : 0);
