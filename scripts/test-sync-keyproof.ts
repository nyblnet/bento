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

// ======================================================================================
// [K-ID3b] a person's bento/id identity in presence (kernel/src/sync/idproof.ts).
// Real proofs from the deterministic test keys (scripts/lib/roster-build.ts),
// resolved by the real peer resolver (identityport.ts), one per open.
const RB = await import('./lib/roster-build.ts');
const { sha256b64u, signStatement, payloadMatchesPurpose } = await import('../kernel/src/statements.ts');
const { buildDeviceCert, buildWatt } = await import('../kernel/src/devices.ts');
const { createProofResolver } = await import('../kernel/src/identityport.ts');
const { proofHash, idNonce, idProveText } = await import('../kernel/src/sync/idproof.ts');
const { PROOF_MAX_BYTES } = await import('../kernel/src/identity.ts');

const chainA = await RB.chainOf([{ members: [['pk', 'pk1']], req: RB.T, rip: RB.T }]);
const chainB = await RB.chainOf([{ members: [['pk', 'pk3']], req: RB.T, rip: RB.T, address: 'bob@example.com' }]);
async function proofFor(chain: unknown[], dev: { pub: string }, signer: string, address: string) {
  const ceremonyAt = RB.NOW - 2 * RB.H;
  const cert = buildDeviceCert({ kind: 'wdev', devicePub: dev.pub, consentPub: null, kx: (await RB.ecdsa('device/kx1')).pub,
    address, rosHash: await sha256b64u((chain as Array<{ ros: string }>).at(-1)!.ros), label: 'a browser', via: 'passkey', ceremonyAt, dirNonce: RB.nonce(90) });
  const watt = buildWatt({ certHash: await sha256b64u(cert), ob: 1, mb: 0, loggedAt: ceremonyAt, expires: ceremonyAt + 24 * RB.H, kid: 'dir-1' });
  return { device: { cert, signer: RB.pubOf(signer), watt, wattSig: await signStatement(RB.K.dir1.key, watt), assertion: await RB.assertion(signer, cert) }, chain: structuredClone(chain) };
}
const WA = await RB.ecdsa('device/w1'), WB = await RB.ecdsa('device/w2');
const proofA = await proofFor(chainA, WA, 'pk1', RB.ADDRESS);
const proofB = await proofFor(chainB, WB, 'pk3', 'bob@example.com');
const hashA = (await proofHash(proofA))!, hashB = (await proofHash(proofB))!;

type Agent = { contract: 1; whoami(): Promise<unknown>; sign(p: string, x: string): Promise<unknown>; resolve(q: unknown): Promise<unknown> };
function mkAgent(dev: { pub: string; key: CryptoKey } | null, proof: unknown, name = 'alice') {
  const resolver = createProofResolver({ directoryKeys: RB.DIRECTORY_KEYS, rpId: RB.RP, origins: [RB.ORIGIN], consentRp: RB.CONSENT_RP, now: () => RB.NOW });
  const st = { whoami: 0, sign: 0, resolve: 0, mode: 'ok' as 'ok' | 'reauth' | 'hang' | 'wrong-key' | 'throw', resolver };
  const agent: Agent = Object.freeze({
    contract: 1 as const,
    whoami: async () => { st.whoami++; return dev ? { name, email: `${name}@example.com`, vouchedBy: 'id.bento.page', accountPub: 'g:' + 'A'.repeat(43), devicePub: dev.pub, ...(proof ? { proof } : {}) } : null; },
    sign: async (purpose: string, payload: string) => {
      st.sign++;
      if (st.mode === 'hang') return new Promise(() => {});
      if (st.mode === 'throw') throw new Error('agent gone');
      if (st.mode === 'reauth') return { ok: false, reason: 'reauth' };
      if (purpose !== 'prove' || !payloadMatchesPurpose('prove', payload)) return { ok: false, reason: 'purpose' };
      const k = st.mode === 'wrong-key' ? WB : dev!;
      const g = b64u(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.key, new TextEncoder().encode(payload))));
      return { ok: true, sig: g, pub: k.pub };
    },
    resolve: async (q: unknown) => { st.resolve++; return resolver.resolve(q); },
  });
  return { agent, st };
}
const ikFor = async (k: { key: CryptoKey }, actor: string, idk: string, idh: string, t = Date.now()) => {
  const text = idProveText(await idNonce(room, actor, idk, idh, t), room);
  return { t, g: b64u(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.key, new TextEncoder().encode(text)))) };
};
const idFrames = (actor: string) => seen.filter((f) => f.a === actor && (f.t === 'p' || f.t === 'hello'));
const hasId = (f: Record<string, unknown>) => 'idp' in f || 'idh' in f || 'idk' in f || 'ik' in f;

H('[K-ID3b consent] nothing in presence before whoami answers an identity');
{
  ok(idFrames(O.actor).length > 0 && idFrames(O.actor).every((f) => !hasId(f)), 'no frame so far carries an identity field');
  const nobody = mkAgent(null, null);
  const r = await O.useIdentity(nobody.agent); await settle(40);
  ok(r === null && nobody.st.whoami === 1 && nobody.st.sign === 0, 'whoami answered null: no identity, nothing signed');
  const nb = seen.length; O.hello(); await settle(40);
  ok(seen.slice(nb).filter((f) => f.a === O.actor).every((f) => !hasId(f)), 'after a null whoami, the hello still carries nothing');
  const noProof = mkAgent(WA, null);
  await O.useIdentity(noProof.agent); await settle(40);
  const nb2 = seen.length; O.hello(); await settle(40);
  ok(noProof.st.sign === 0 && seen.slice(nb2).filter((f) => f.a === O.actor).every((f) => !hasId(f)), 'an identity without a proof: nothing carried, nothing signed');
  // the member tab: on, then off again
  const bob = mkAgent(WB, proofB, 'bob');
  const nb3 = seen.length;
  await M.useIdentity(bob.agent); await settle(80);
  ok(seen.slice(nb3).some((f) => f.a === M.actor && f.idh === hashB), 'control: an identity with a proof is carried');
  await M.useIdentity(null); await settle(40);
  const nb4 = seen.length; M.setEditing('m1'); M.setEditing(undefined); await settle(60);
  const off = seen.slice(nb4).filter((f) => f.a === M.actor && f.t === 'p');
  ok(off.length >= 1 && off.every((f) => !hasId(f)), 'useIdentity(null): the next beats carry nothing');
  ok(!R.identityProven(M.actor, WB.pub), '…and the reader no longer holds it proven');
}

const alice = mkAgent(WA, proofA);
const watcher = mkAgent(WB, proofB, 'reader'); // the reader tab's own agent: its resolver is its open's
H('[K-ID3b wire] the proof on change and on hello, the hash on every beat');
{
  const n0 = seen.length;
  const me = await O.useIdentity(alice.agent); await settle(80);
  ok(!!me && alice.st.whoami === 1, 'useIdentity asks whoami once');
  const first = seen.slice(n0).filter((f) => f.a === O.actor && f.t === 'p');
  ok(first.length >= 1 && !!first[0].idp && first[0].idh === hashA && first[0].idk === WA.pub && !!first[0].ik, 'the first beat after it carries the proof, its hash, the key and a possession proof');
  ok(first[0].idh === await sha256b64u(JSON.stringify(proofA)), 'idh = base64url(sha256(the proof JSON))');
  ok(!('idp' in (first[0].p as object)) && !('ik' in (first[0].p as object)), 'identity rides beside p, never inside it');
  const n1 = seen.length;
  O.setEditing('e1'); O.setEditing(undefined); await settle(80);
  const later = seen.slice(n1).filter((f) => f.a === O.actor && f.t === 'p');
  ok(later.length >= 2 && later.every((f) => f.idh === hashA && !!f.ik && !('idp' in f)), `ordinary beats carry the hash and ik only (${later.length})`);
  ok(alice.st.sign === 1, `one signature covers beats inside the refresh window (${alice.st.sign})`);
  const n2 = seen.length; O.hello(); await settle(80);
  const h = seen.slice(n2).find((f) => f.a === O.actor && f.t === 'hello');
  ok(!!h && !!h.idp && h.idh === hashA, 'a hello carries the proof');
  ok(R.identityProven(O.actor, WA.pub), "the reader tab sees Alice's identity key proven");
  const pid = R.peerIdentity(O.actor);
  ok(!!pid && pid.pub === WA.pub && JSON.stringify(pid.proof) === JSON.stringify(proofA), 'peerIdentity gives the key and the proof');
  const ans = await R.resolvePeer(O.actor, watcher.agent);
  ok(!!ans && typeof ans === 'object' && ans.fields === 'g1' && ans.email === RB.ADDRESS && ans.tier === 'passkey', "control: resolved through the reader's own resolver, with fields:'g1'");
  ok(!O.peers().some((p) => 'idp' in p || 'idk' in p) && !R.peers().some((p) => 'idp' in p || 'ik' in p), 'no peer record carries an identity field');
}

H('[K-ID3b ask] a newcomer asks once per hash, and is answered');
{
  const sn = new Store({ ...JSON.parse(JSON.stringify(readerDoc)) });
  const n0 = seen.length;
  const N = new SyncSession(sn); await settle(150);
  O.setEditing('e2'); await settle(60); O.setEditing(undefined); await settle(100);
  const asks = seen.slice(n0).filter((f) => f.t === 'idq' && f.a === N.actor && f.to === O.actor);
  ok(asks.length === 1 && asks[0].h === hashA, `the newcomer asked Alice once for her proof (${asks.length})`);
  const answers = seen.slice(n0).filter((f) => f.a === O.actor && f.t === 'p' && 'idp' in f);
  ok(answers.length === 1, `Alice answered once (${answers.length})`);
  ok(N.identityProven(O.actor, WA.pub) && !!N.peerIdentity(O.actor), 'the newcomer holds her proven identity');
  // asks inside the cooldown share one answer, which still comes
  const KS = (await import('../kernel/src/sync/session.ts')).SyncSession as unknown as { ID_ANSWER_COOLDOWN_MS: number };
  KS.ID_ANSWER_COOLDOWN_MS = 500;
  await settle(550);
  const n1 = seen.length;
  const answersSince = (n: number, who = O.actor) => seen.slice(n).filter((f) => f.a === who && 'idp' in f).length;
  post({ t: 'idq', a: 'asker1', to: O.actor, h: hashA }); await settle(60);
  post({ t: 'idq', a: 'asker2', to: O.actor, h: hashA }); await settle(60);
  post({ t: 'idq', a: 'asker3', to: O.actor, h: hashA }); await settle(60);
  const quick = answersSince(n1);
  ok(quick === 1, `three asks 60 ms apart: one answer at once (${quick})`);
  await settle(550);
  ok(answersSince(n1) === 2, `…and one more when the cooldown ends (${answersSince(n1)})`);
  await settle(550);
  const n2 = seen.length;
  post({ t: 'idq', a: 'asker-x', to: O.actor, h: hashB }); post({ t: 'idq', a: 'asker-y', to: R.actor, h: hashA });
  await settle(100);
  ok(answersSince(n2) === 0 && answersSince(n2, R.actor) === 0, 'an ask for a hash Alice does not hold, or to someone with none, is not answered');
  KS.ID_ANSWER_COOLDOWN_MS = 5_000;
  // a peer that never answers is asked once per hash, however many beats name it
  const n3 = seen.length;
  for (let i = 0; i < 3; i++) { post({ t: 'p', a: 'mute', p: pres(), idk: WB.pub, idh: hashB, ik: await ikFor(WB, 'mute', WB.pub, hashB, Date.now() + i) }); await settle(40); }
  const muteAsks = seen.slice(n3).filter((f) => f.t === 'idq' && f.a === R.actor && f.to === 'mute').length;
  ok(R.identityProven('mute', WB.pub) && R.peerIdentity('mute') === null, 'control: proven, but its proof is not held');
  ok(muteAsks === 1, `three beats naming one unheld proof: one ask (${muteAsks})`);
  N.useIdentity(null);
}

H('[K-ID3b A4] a copied proof is never resolved for someone else');
{
  const before = watcher.st.resolve;
  // B names Alice's key and carries Alice's proof, but cannot prove the key
  post({ t: 'p', a: 'b-claim', p: pres(), idk: WA.pub, idh: hashA, idp: proofA });
  await settle(40);
  ok(R.peers().some((p) => p.actor === 'b-claim'), 'control: the beat is presence');
  ok(!R.identityProven('b-claim', WA.pub) && R.peerIdentity('b-claim') === null, "Alice's proof and pub without the prove: not proven");
  ok(await R.resolvePeer('b-claim', watcher.agent) === 'unproven' && watcher.st.resolve === before, "…never resolved ('unproven'; the agent was not asked)");
  // B replays Alice's real ik under its own actor
  const aliceIk = idFrames(O.actor).filter((f) => f.ik).at(-1)!.ik;
  post({ t: 'p', a: 'b-replay', p: pres(), idk: WA.pub, idh: hashA, idp: proofA, ik: aliceIk });
  await settle(40);
  ok(R.peerIdentity('b-replay') === null && await R.resolvePeer('b-replay', watcher.agent) === 'unproven', "Alice's own possession proof under another actor: unproven");
  // B signs with its own key but names Alice's
  post({ t: 'p', a: 'b-forge', p: pres(), idk: WA.pub, idh: hashA, idp: proofA, ik: await ikFor(WB, 'b-forge', WA.pub, hashA) });
  await settle(40);
  ok(R.peerIdentity('b-forge') === null, "a possession proof by B's key naming Alice's key: unproven");
  ok(watcher.st.resolve === before, 'none of the three reached the agent');
  // B presents Alice's proof with B's own (proven) key
  post({ t: 'p', a: 'b-swap', p: pres(), idk: WB.pub, idh: hashA, idp: proofA, ik: await ikFor(WB, 'b-swap', WB.pub, hashA) });
  await settle(40);
  ok(R.identityProven('b-swap', WB.pub) && !!R.peerIdentity('b-swap'), "control: B's own key is proven, with Alice's proof held");
  const swapped = await R.resolvePeer('b-swap', watcher.agent);
  ok(swapped === null && (watcher.st.resolver.stats.nulls.pub ?? 0) >= 1, "B presents Alice's proof with B's key: null (the resolver's 'pub' check)");
  // B with its own proof: the raw path resolves (positive control)
  post({ t: 'p', a: 'b-own', p: pres(), idk: WB.pub, idh: hashB, idp: proofB, ik: await ikFor(WB, 'b-own', WB.pub, hashB) });
  await settle(40);
  const own = await R.resolvePeer('b-own', watcher.agent);
  ok(!!own && typeof own === 'object' && own.email === 'bob@example.com', 'control: B with its own proof resolves as B');
}

H('[K-ID3b rules] what a possession proof binds');
{
  const beat = async (a: string, extra: Record<string, unknown>) => { post({ t: 'p', a, p: pres(), ...extra }); await settle(40); };
  await beat('h-mismatch', { idk: WB.pub, idh: hashB, idp: proofA, ik: await ikFor(WB, 'h-mismatch', WB.pub, hashB) });
  ok(R.identityProven('h-mismatch', WB.pub) && R.peerIdentity('h-mismatch') === null, 'a proof whose own hash is not the idh is not kept');
  ok(seen.some((f) => f.t === 'idq' && f.a === R.actor && f.to === 'h-mismatch' && f.h === hashB), '…and the receiver asks for the one named');
  await beat('h-bound', { idk: WB.pub, idh: hashA, idp: proofA, ik: await ikFor(WB, 'h-bound', WB.pub, hashB) });
  ok(!R.identityProven('h-bound', WB.pub), 'an ik made for another proof hash: unproven');
  await beat('h-old', { idk: WB.pub, idh: hashB, idp: proofB, ik: await ikFor(WB, 'h-old', WB.pub, hashB, Date.now() - PROOF_SKEW_MS - 5_000) });
  await beat('h-future', { idk: WB.pub, idh: hashB, idp: proofB, ik: await ikFor(WB, 'h-future', WB.pub, hashB, Date.now() + PROOF_SKEW_MS + 5_000) });
  ok(!R.identityProven('h-old', WB.pub) && !R.identityProven('h-future', WB.pub), 'an ik outside the skew either way: unproven');
  const t0 = Date.now();
  const ik0 = await ikFor(WB, 'h-cont', WB.pub, hashB, t0);
  await beat('h-cont', { idk: WB.pub, idh: hashB, idp: proofB, ik: ik0 });
  ok(R.identityProven('h-cont', WB.pub), 'control: proven');
  await beat('h-cont', { idk: WB.pub, idh: hashB, ik: ik0 });
  ok(R.identityProven('h-cont', WB.pub) && !!R.peerIdentity('h-cont'), 'the same ik re-sent on the next beat (hash only): still proven');
  await beat('h-cont', { idk: WB.pub, idh: hashB, ik: await ikFor(WB, 'h-cont', WB.pub, hashB, t0) });
  ok(!R.identityProven('h-cont', WB.pub), 'another signature with the same t: unproven');
  await beat('h-cont', { idk: WB.pub, idh: hashB, ik: await ikFor(WB, 'h-cont', WB.pub, hashB, t0 - 1000) });
  ok(!R.identityProven('h-cont', WB.pub), 'an older ik: unproven');
  await beat('h-cont', { idk: WB.pub, idh: hashB, ik: await ikFor(WB, 'h-cont', WB.pub, hashB, t0 + 10) });
  ok(R.identityProven('h-cont', WB.pub), 'control: a newer one proves it again');
  await beat('h-cont', { idk: WB.pub, idh: hashB });
  ok(!R.identityProven('h-cont', WB.pub) && R.peerIdentity('h-cont') === null, 'a beat without ik: unproven');
  await beat('h-cont', { idk: WB.pub, idh: hashB, ik: await ikFor(WB, 'h-cont', WB.pub, hashB, t0 + 20) });
  ok(R.identityProven('h-cont', WB.pub), 'control: proven again');
  await beat('h-cont', {});
  ok(!R.identityProven('h-cont', WB.pub), 'a beat with no identity fields: unproven');
  // leaving
  const t1 = Date.now();
  const ikLeave = await ikFor(WB, 'h-gone', WB.pub, hashB, t1);
  await beat('h-gone', { idk: WB.pub, idh: hashB, idp: proofB, ik: ikLeave });
  ok(R.peerIdentity('h-gone') !== null, 'control: proven');
  post({ t: 'bye', a: 'h-gone' }); await settle(40);
  ok(R.peerIdentity('h-gone') === null && await R.resolvePeer('h-gone', watcher.agent) === 'unproven', 'after bye: no identity');
  await beat('h-gone', { idk: WB.pub, idh: hashB, ik: ikLeave });
  ok(!R.identityProven('h-gone', WB.pub), 'the last ik replayed after the actor left: unproven');
  // nested in p
  post({ t: 'p', a: 'h-nested', p: pres(undefined, { idk: WB.pub, idh: hashB, idp: proofB, ik: await ikFor(WB, 'h-nested', WB.pub, hashB) }) });
  await settle(40);
  ok(R.peerIdentity('h-nested') === null, 'identity fields nested inside p: ignored');
  ok(!R.peers().some((p) => p.actor === 'h-nested' && ('idp' in p || 'ik' in p || 'idk' in p || 'idh' in p)), '…and stripped from the peer record');
  // over the cap
  const big = structuredClone(proofB) as { device: Record<string, unknown> };
  big.device.cert = (big.device.cert as string) + 'x'.repeat(PROOF_MAX_BYTES);
  ok((await proofHash(big)) === null, 'a proof over PROOF_MAX_BYTES has no hash');
}

H('[K-ID3b review] departed actors, races and consent latches (security-review-1007)');
{
  const { IdProofs, ID_RESEND_WINDOW_MS, ID_MAX_PROOFS } = await import('../kernel/src/sync/idproof.ts');
  // F1: a flood of new actor ids cannot evict a departed actor's state
  const tv = Date.now();
  const vBeat = { t: 'p', a: 'f1-victim', p: pres(), idk: WB.pub, idh: hashB, idp: proofB, ik: await ikFor(WB, 'f1-victim', WB.pub, hashB, tv) };
  post(vBeat); await settle(40);
  ok(R.peerIdentity('f1-victim') !== null, 'F1 control: the victim is proven');
  post({ t: 'bye', a: 'f1-victim' }); await settle(40);
  post({ ...vBeat, p: pres(undefined, { name: 'Mallory' }) }); await settle(40);
  ok(!R.identityProven('f1-victim', WB.pub), 'F1 control: its last beat replayed after bye is unproven');
  for (let i = 0; i < 300; i++) post({ t: 'p', a: `f1-junk${i}`, p: pres(), idk: i % 2 ? 'x' : WA.pub, idh: hashA });
  await settle(150);
  post({ ...vBeat, p: pres(undefined, { name: 'Mallory' }) }); await settle(40);
  ok(R.peers().some((p) => p.actor === 'f1-victim') && !R.identityProven('f1-victim', WB.pub) && R.peerIdentity('f1-victim') === null,
    'F1: after 300 junk actors, the replayed beat still does not re-prove the departed actor (it is present, not proven)');
  // F2: a bye in the same tick as the beat, while its ik is still being verified
  const t2 = Date.now();
  const b2 = { t: 'p', a: 'f2-victim', p: pres(), idk: WB.pub, idh: hashB, idp: proofB, ik: await ikFor(WB, 'f2-victim', WB.pub, hashB, t2) };
  post(b2); post({ t: 'bye', a: 'f2-victim' }); await settle(60);
  ok(!R.peers().some((p) => p.actor === 'f2-victim'), 'F2: beat and bye in one tick: gone');
  post(b2); await settle(60);
  ok(R.peers().some((p) => p.actor === 'f2-victim'), 'F2: the replay makes it present again (so presence hides nothing below)');
  ok(!R.identityProven('f2-victim', WB.pub) && R.peerIdentity('f2-victim') === null, 'F2: the captured beat replayed after a same-tick bye: unproven');
  post({ ...b2, ik: await ikFor(WB, 'f2-victim', WB.pub, hashB, t2 + 5) }); await settle(60);
  ok(R.identityProven('f2-victim', WB.pub), 'F2 control: a strictly newer ik proves it again');
  // the moment a bye is announced, an app listening for peers sees no identity for that actor
  {
    const t3 = Date.now();
    post({ t: 'p', a: 'f2-listen', p: pres(), idk: WB.pub, idh: hashB, idp: proofB, ik: await ikFor(WB, 'f2-listen', WB.pub, hashB, t3) });
    await settle(60);
    ok(R.peerIdentity('f2-listen') !== null, 'control: proven before the bye');
    let atLeave: unknown = 'not seen';
    const off = R.onPeers(() => { if (atLeave === 'not seen' && !R.peers().some((p) => p.actor === 'f2-listen')) atLeave = R.peerIdentity('f2-listen'); });
    post({ t: 'bye', a: 'f2-listen' }); await settle(60);
    off();
    ok(atLeave === null, 'inside the peers event that announces the bye, peerIdentity is already null');
  }
  // F4: only a proven beat makes the receiver ask
  const n4 = seen.length;
  post({ t: 'p', a: 'f4-unproven', p: pres(), idk: WB.pub, idh: hashA });
  post({ t: 'p', a: 'f4-badsig', p: pres(), idk: WB.pub, idh: hashA, ik: { t: Date.now(), g: 'A'.repeat(86) } });
  await settle(60);
  ok(seen.slice(n4).filter((f) => f.t === 'idq' && (f.to === 'f4-unproven' || f.to === 'f4-badsig')).length === 0, 'F4: an unproven beat naming an unheld proof makes no ask');
  // n2: a proof that arrives on an unproven beat is not kept
  post({ t: 'p', a: 'n2', p: pres(), idk: WB.pub, idh: hashB, idp: proofB }); await settle(40);
  post({ t: 'p', a: 'n2', p: pres(), idk: WB.pub, idh: hashB, ik: await ikFor(WB, 'n2', WB.pub, hashB) }); await settle(40);
  ok(R.identityProven('n2', WB.pub) && R.peerIdentity('n2') === null, 'n2: a proof sent with no possession proof was not kept');
  // the re-sent identical ik is taken only within ID_RESEND_WINDOW_MS of first accepting it
  {
    let clock = Date.now();
    const ids = new IdProofs(() => clock);
    const ik = await ikFor(WB, 'rs', WB.pub, hashB, clock);
    const f = { idk: WB.pub, idh: hashB, ik, idp: proofB };
    await ids.accept('rs', room, f);
    ok(ids.proven('rs', WB.pub), 'resend control: proven');
    clock += ID_RESEND_WINDOW_MS - 1000; await ids.accept('rs', room, { idk: WB.pub, idh: hashB, ik });
    ok(ids.proven('rs', WB.pub), 'the same ik re-sent inside the resend window: proven');
    clock += 2000; await ids.accept('rs', room, { idk: WB.pub, idh: hashB, ik });
    ok(!ids.proven('rs', WB.pub), 'the same ik re-sent past the resend window (still inside the skew): unproven');
  }
  // n1: a verdict in flight when the open changes lands nowhere
  {
    const judge = async (resetMid: boolean) => {
      const t = Date.now();
      const ik = await ikFor(WB, 'n1', WB.pub, hashB, t);
      let ids: InstanceType<typeof IdProofs>;
      ids = new IdProofs(() => { if (resetMid) queueMicrotask(() => ids.reset()); return t; });
      await ids.accept('n1', room, { idk: WB.pub, idh: hashB, ik, idp: proofB });
      return ids.proven('n1', WB.pub);
    };
    ok(await judge(false), 'n1 control: proven');
    ok(!(await judge(true)), 'n1: reset while the ik was verifying: not proven in the new open');
  }
  // n2: proofs held are capped across actors
  {
    const ids = new IdProofs();
    for (let i = 0; i < ID_MAX_PROOFS + 6; i++) await ids.accept(`cap${i}`, room, { idk: WB.pub, idh: hashB, idp: proofB, ik: await ikFor(WB, `cap${i}`, WB.pub, hashB) });
    ok(ids.peer('cap0') === null && ids.proven('cap0', WB.pub), `the oldest proofs are dropped past ${ID_MAX_PROOFS} (the actor stays proven)`);
    ok(ids.peer(`cap${ID_MAX_PROOFS + 5}`) !== null, 'control: the newest proof is held');
  }
  // F3: withdrawing while whoami or a signature is still pending
  const slowAgent = (slow: 'whoami' | 'sign') => Object.freeze({
    contract: 1 as const,
    whoami: async () => { if (slow === 'whoami') await settle(120); return { name: 'bob', email: 'bob@example.com', vouchedBy: 'id.bento.page', accountPub: 'g:' + 'A'.repeat(43), devicePub: WB.pub, proof: proofB }; },
    sign: async (_p: string, payload: string) => {
      if (slow === 'sign') await settle(120);
      return { ok: true, sig: b64u(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, WB.key, new TextEncoder().encode(payload)))), pub: WB.pub };
    },
    resolve: async () => null,
  });
  const carried = (n: number) => seen.slice(n).filter((f) => f.a === M.actor && hasId(f)).length;
  for (const slow of ['whoami', 'sign'] as const) {
    let n = seen.length;
    await M.useIdentity(slowAgent(slow)); await settle(200);
    ok(carried(n) >= 1, `F3 control (${slow}): without withdrawal the identity is carried`);
    await M.useIdentity(null); await settle(60);
    n = seen.length;
    const pending = M.useIdentity(slowAgent(slow));
    if (slow === 'whoami') { await settle(20); await M.useIdentity(null); }
    else { await pending; await settle(20); await M.useIdentity(null); }
    await settle(250);
    M.setEditing('f3'); M.setEditing(undefined); await settle(60);
    ok(carried(n) === 0, `F3 (${slow}): withdrawn while ${slow} was pending: no frame carries the identity`);
  }
}

H('[K-ID3b signing] the agent refusing, hanging or signing with another key');
{
  const { SyncSession: SS } = await import('../kernel/src/sync/session.ts');
  (SS as unknown as { ID_SIGN_TIMEOUT_MS: number }).ID_SIGN_TIMEOUT_MS = 250;
  // all four at once: each is its own tab
  const runs = await Promise.all((['reauth', 'wrong-key', 'throw', 'hang'] as const).map(async (mode) => {
    const ag = mkAgent(WA, proofA);
    ag.st.mode = mode;
    const X2 = new SyncSession(new Store(JSON.parse(JSON.stringify(memberDoc))));
    await settle(60);
    await X2.useIdentity(ag.agent); await settle(mode === 'hang' ? 400 : 80);
    const n0 = seen.length;
    X2.setEditing('q'); await settle(60);
    const fr = seen.filter((f) => f.a === X2.actor && f.t === 'p');
    const later = seen.slice(n0).filter((f) => f.a === X2.actor && f.t === 'p');
    return { mode, ag, X2, fr, later };
  }));
  for (const { mode, ag, X2, fr, later } of runs) {
    ok(ag.st.sign >= 1 && fr.length >= 2 && later.length >= 1 && fr.every((f) => !hasId(f)), `${mode}: beats still flow (${fr.length}), with no identity fields`);
    ok(!R.identityProven(X2.actor, WA.pub), `${mode}: never proven`);
    X2.useIdentity(null);
  }
  (SS as unknown as { ID_SIGN_TIMEOUT_MS: number }).ID_SIGN_TIMEOUT_MS = 3_000;
}

H('[K-ID3b per open] another document forgets every identity');
{
  ok(R.peerIdentity(O.actor) !== null, 'control: the reader holds Alice before the switch');
  const nextId = `${base.docId}-next`;
  const seen2: Array<Record<string, unknown>> = [];
  const sniff2 = new BroadcastChannel(`bento-sync-${nextId}`);
  sniff2.onmessage = (ev) => { seen2.push(ev.data); };
  const raw2 = new BroadcastChannel(`bento-sync-${nextId}`);
  so.replaceDoc({ ...JSON.parse(JSON.stringify(ownerDoc)), docId: nextId }); await settle(100);
  O.setEditing('z'); await settle(80);
  const o2 = seen2.filter((f) => f.a === O.actor && (f.t === 'p' || f.t === 'hello'));
  ok(o2.length >= 1 && o2.every((f) => !hasId(f)), `the owner tab's new open carries no identity until whoami is asked again (${o2.length} frames)`);
  sr.replaceDoc({ ...JSON.parse(JSON.stringify(readerDoc)), docId: nextId }); await settle(100);
  // b-own, proven in the first document with its proof held, shows up here naming the same proof by hash only
  raw2.postMessage({ pv: SYNC_V, t: 'p', a: 'b-own', p: pres(), idk: WB.pub, idh: hashB, ik: await ikFor(WB, 'b-own', WB.pub, hashB) });
  await settle(80);
  ok(R.identityProven('b-own', WB.pub), 'control: in the new document, b-own proves its key');
  ok(R.peerIdentity('b-own') === null, "…but the first document's copy of its proof is gone: nothing to resolve until it is sent again");
  ok(seen2.some((f) => f.t === 'idq' && f.a === R.actor && f.to === 'b-own'), '…and the reader asks for it');
  sniff2.close(); raw2.close();
  // a resolver is one open's: a fork poisoned in one does not reach another
  const forked = await RB.chainOf([{ members: [['pk', 'pk1']], req: RB.T, rip: RB.T }, { members: [['pk', 'pk1'], ['pk', 'pk2']], req: RB.T + RB.H, rip: RB.T + 73 * RB.H, signer: 'pk1', dirNonce: RB.nonce(40) }]);
  const forked2 = await RB.chainOf([{ members: [['pk', 'pk1']], req: RB.T, rip: RB.T }, { members: [['pk', 'pk1'], ['pk', 'pk2']], req: RB.T + RB.H, rip: RB.T + 73 * RB.H, signer: 'pk1', dirNonce: RB.nonce(41) }]);
  const open1 = mkAgent(WB, proofB), open2 = mkAgent(WB, proofB);
  await open1.agent.resolve({ pub: WA.pub, proof: await proofFor(forked, WA, 'pk1', RB.ADDRESS) });
  const f1 = await open1.agent.resolve({ pub: WA.pub, proof: await proofFor(forked2, WA, 'pk1', RB.ADDRESS) });
  const f2 = await open2.agent.resolve({ pub: WA.pub, proof: await proofFor(forked2, WA, 'pk1', RB.ADDRESS) });
  ok(f1 === null && open1.st.resolver.stats.forks === 1, 'one open sees a fork: null');
  ok(!!f2, "another open's resolver is untouched by it");
}

console.log(`\n${checks - failures}/${checks} checks passed`);
sniff.close(); raw.close();
process.exit(failures ? 1 : 0);
