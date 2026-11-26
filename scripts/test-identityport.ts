#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id over a MessagePort and the peer resolver (kernel/src/identityport.ts),
// with the answer rules it relies on (identity.ts composeResolved/checkResolved,
// roster.ts accountAnchor/rosterChangedAt, devices.ts leverCovers).
//
//   node scripts/test-identityport.ts
//
// Real MessageChannels (structured clone), real signatures: the chains and
// device certificates are built here with the deterministic test keys of
// scripts/lib/roster-build.ts, so nothing in a row is a stub of a verifier.
// Rows carry a tag the mutant rig (test-identityport-mutants.ts) aims at:
//   [K1 wire]       closed ops, exact keys, symbol keys and non-plain protos
//                   refused, ids only go up, drops counted, close at maxDrops,
//                   rate and in-flight caps, no origin read, no window posted
//   [K2 binding]    the agent's context is the host's entry and docId, never
//                   the request's
//   [R3 consent]    sign and resolve only after whoami consent in this session;
//                   a null whoami is final; invite/revoke unavailable; a payload
//                   that does not match its purpose never reaches the agent
//   [K4 filter]     every answer type-checked on the way out (checkResolved,
//                   checkPublic, the sign shape); a whoami proof over the cap
//                   is dropped and counted
//   [K5 anchor]     accountAnchor = 'g:'+sha256(ros.0), null from a pin; same
//                   across a reset (and resetAt set); a re-setup with the same
//                   passkey is a new anchor
//   [K6 compose]         composeResolved is the only setter of fields:'g1'; the
//                   marker needs every present G field typed and the anchor shape
//   [R1b resolve]    the verify order: chain from seq 0 under pinned keys, the
//                   device for exactly the queried pub, a current watt.; every
//                   failure null, never a throw; the 64 KiB cap
//   [A3 longest]    a device is judged against the longest chain in the open
//   [A3 fork]       two chains for one anchor, neither a prefix: null, counted
//   [A5 name]       name = email = the address; never the certificate's label
//   [A6 incident]   revoked:'incident' only on the lever's predicate
//   [A7 own]        own-account status for the own anchor only; the peer path
//                   makes no network request and lapses with the watt.
//   [tofu]          firstSeen and changed are per open

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256b64u, signStatement } from '../kernel/src/statements.ts'
import { buildDeviceCert, buildWatt, buildInc, type CertKind } from '../kernel/src/devices.ts'
import { ADDRESS, CONSENT_RP, DIRECTORY_KEYS, H, K, NOW, RP, ORIGIN, T, assertion, chainOf, cosign, ecdsa, nonce, pubOf, type Spec, type Link } from './lib/roster-build.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KS = process.env.BENTO_KERNEL_SRC || join(ROOT, 'kernel/src')
const P = await import(join(KS, 'identityport.ts'))
const I = await import(join(KS, 'identity.ts'))
const R = await import(join(KS, 'roster.ts'))
const D = await import(join(KS, 'devices.ts'))

let checks = 0, failures = 0
let current = '[start]'
const ok = (c: boolean, m: string) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${current} ${m}`) }
const crash = (e: unknown) => { ok(false, `threw: ${String((e as Error)?.stack ?? e).slice(0, 200)}`); console.log(`\n${checks - failures}/${checks} checks passed`); process.exit(1) }
process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)
const section = (tag: string, m: string) => { current = tag; console.log(`\n=== ${tag} ${m}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// every network call anywhere in this process is counted: the peer path makes none (A7)
let fetches = 0
const realFetch = globalThis.fetch
globalThis.fetch = ((...a: Parameters<typeof fetch>) => { fetches++; return realFetch(...a) }) as typeof fetch
class CountingWS { constructor() { fetches++; throw new Error('no sockets here') } }
;(globalThis as Record<string, unknown>).WebSocket = CountingWS

// --- chains -------------------------------------------------------------------------

const S0: Spec = { members: [['pk', 'pk1']], req: T, rip: T }
const S1: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2']], req: T + 1 * H, rip: T + 73 * H, signer: 'pk1' }
const REMOVE_PK1: Spec = { members: [['pk', 'pk2']], req: T + 100 * H, rip: T + 172 * H, signer: 'pk2' }
const RESET: Spec = { members: [['pk', 'pk1']], req: T + 100 * H, rip: T + 172 * H, reset: true }
const ADD_CK: Spec = { members: [['pk', 'pk1'], ['ck', 'ck1']], req: T + 1 * H, rip: T + 73 * H, signer: 'pk1' }

const base = await chainOf([S0, S1])
const removed = await chainOf([S0, S1, REMOVE_PK1])
const reset = await chainOf([S0, S1, RESET])
const forked = await chainOf([S0, { ...S1, dirNonce: nonce(40) }])
const resetup = await chainOf([{ ...S0, dirNonce: nonce(77) }])   // same passkey, same address, a new setup
const setupOnly = await chainOf([S0])
const withCk = await chainOf([S0, ADD_CK])
const badRip = await chainOf([S0, { ...S1, ripBy: 'dirOther' }])
const otherAccount = await chainOf([{ ...S0, members: [['pk', 'pk3']], address: 'bob@example.com' } as Spec])

const W = await ecdsa('device/w1'), W2 = await ecdsa('device/w2'), W3 = await ecdsa('device/w3'), KX = await ecdsa('device/kx1')
const C = NOW - 2 * H

type CertOpts = { chain: Link[]; head: number; signer?: string; dev?: { pub: string }; kind?: CertKind; via?: string; label?: string | null
  ceremonyAt?: number; loggedAt?: number; expires?: number; ob?: 0 | 1; mb?: number; kid?: string; wattBy?: string; address?: string }
async function device(o: CertOpts) {
  const kind = o.kind ?? 'wdev', via = o.via ?? 'passkey', ceremonyAt = o.ceremonyAt ?? C
  const cert = buildDeviceCert({ kind, devicePub: (o.dev ?? W).pub, consentPub: kind === 'dev2' ? pubOf('ck1') : null, kx: KX.pub,
    address: o.address ?? ADDRESS, rosHash: await sha256b64u(o.chain[o.head].ros), label: o.label === undefined ? 'Firefox on this Mac' : o.label,
    via, ceremonyAt, dirNonce: nonce(90) })
  const loggedAt = o.loggedAt ?? ceremonyAt
  const watt = buildWatt({ certHash: await sha256b64u(cert), ob: o.ob ?? 1, mb: o.mb ?? 0, loggedAt, expires: o.expires ?? loggedAt + 24 * H, kid: o.kid ?? 'dir-1' })
  const wattSig = await signStatement(K[o.wattBy ?? 'dir1'].key, watt)
  const signer = o.signer ?? (via === 'ck' ? 'ck1' : 'pk1')
  const d: Record<string, unknown> = { cert, signer: pubOf(signer), watt, wattSig }
  if (via === 'passkey') d.assertion = await assertion(signer, cert)
  else d.consent = await cosign(signer, cert, nonce(90), ceremonyAt, { purpose: kind === 'wdev' ? 'web-add' : 'roster' })
  return d
}
const proofOf = async (chain: Link[], o: Partial<CertOpts> & { head?: number } = {}) =>
  ({ device: await device({ chain, head: o.head ?? chain.length - 1, ...o }), chain: structuredClone(chain) })
const clone = <X>(x: X): X => structuredClone(x)
const anchorOf = async (chain: Link[]) => 'g:' + await sha256b64u(chain[0].ros)

let clock = NOW
const resolver = (o: Record<string, unknown> = {}) => P.createProofResolver({
  directoryKeys: DIRECTORY_KEYS, rpId: RP, origins: [ORIGIN], consentRp: CONSENT_RP, now: () => clock, ...o })

// ======================================================================================
section('[K5 anchor]', 'accountAnchor: the hash of the exact ros. text at seq 0, null from a pin')
{
  const s = await R.verifyRosterChain(base, { directoryKeys: DIRECTORY_KEYS, rpId: RP, origins: [ORIGIN], now: NOW })
  ok(s.ok, 'the base chain verifies (positive control)')
  const a = R.accountAnchor(s.value)
  ok(a === await anchorOf(base), `anchor = 'g:' + sha256(ros.0) (${a?.slice(0, 12)}…)`)
  ok(I.ACCOUNT_ANCHOR_RE.test(a), 'the anchor has the anchor shape')
  const pinned = await R.verifyRosterChain(base.slice(1), { directoryKeys: DIRECTORY_KEYS, rpId: RP, origins: [ORIGIN], now: NOW, pinned: await sha256b64u(base[1].ros) })
  ok(pinned.ok && R.accountAnchor(pinned.value) === null, 'a chain verified from a pin past seq 0 has no anchor')
  const sr = await R.verifyRosterChain(reset, { directoryKeys: DIRECTORY_KEYS, rpId: RP, origins: [ORIGIN], now: NOW })
  ok(sr.ok && R.accountAnchor(sr.value) === a, 'a reset continues the chain: the SAME anchor (it is not continuity of the person)')
  const su = await R.verifyRosterChain(resetup, { directoryKeys: DIRECTORY_KEYS, rpId: RP, origins: [ORIGIN], now: NOW })
  ok(su.ok && R.accountAnchor(su.value) !== a && I.ACCOUNT_ANCHOR_RE.test(R.accountAnchor(su.value)),
    'a re-setup at the same address with the SAME passkey bytes is a DIFFERENT anchor')
  ok(R.accountAnchor({ heads: [], createdAt: null } as never) === null && R.accountAnchor(null as never) === null, 'no heads, no state: null')
  // through the resolver: the reset chain resolves to the same accountPub AND carries resetAt
  clock = NOW
  const r1 = await resolver().resolve({ pub: W.pub, proof: await proofOf(base) })
  const r2 = await resolver().resolve({ pub: W.pub, proof: await proofOf(reset) })
  ok(r1 && r2 && r1.accountPub === r2.accountPub, 'a mailbox-thief reset resolves to the same accountPub…')
  ok(r1 && r1.resetAt === undefined && r2 && r2.resetAt === T + 172 * H, '…and only the reset answer carries resetAt (the anchor alone is not continuity)')
  ok(r2?.rosterChangedAt === T + 73 * H, 'a reset is not a roster change: rosterChangedAt stays the member change\'s time')
  const src = readFileSync(join(KS, 'identity.ts'), 'utf8')
  ok(/THE ANCHOR IS NOT CONTINUITY OF THE PERSON/.test(src), 'identity.ts says the anchor is not continuity')
}

// ======================================================================================
section('[R1b resolve]', 'the verify order: chain from seq 0, pinned keys, the device for exactly this pub')
{
  clock = NOW
  const good = await proofOf(base)
  const r = await resolver().resolve({ pub: W.pub, proof: clone(good) })
  ok(r !== null && r.fields === 'g1', 'positive control: a valid proof resolves with fields g1')
  ok(r?.accountPub === await anchorOf(base) && r?.tier === 'passkey' && r?.accountSince === T, 'accountPub is the anchor, tier passkey, accountSince = setup ripenedAt')
  ok(r?.rosterChangedAt === T + 73 * H, 'rosterChangedAt = the member change\'s ripenedAt')
  const z = resolver()
  ok(await z.resolve({ pub: W2.pub, proof: clone(good) }) === null && z.stats.nulls.pub === 1, 'a proof for another pub: null (cert.devicePub must be the queried pub)')
  const midChain = { device: good.device, chain: clone(base.slice(1)) }
  ok(await resolver().resolve({ pub: W.pub, proof: midChain }) === null, 'a chain that starts past seq 0: null')
  ok(await resolver().resolve({ pub: W.pub, proof: await proofOf(badRip) }) === null, 'a rip. signed by a key that is not pinned: null')
  ok(await resolver().resolve({ pub: W.pub, proof: await proofOf(base, { kid: 'dir-9', wattBy: 'dirOther' }) }) === null, 'a watt. by an unpinned kid: null')
  ok(await resolver().resolve({ pub: W.pub, proof: await proofOf(base, { wattBy: 'dirOther' }) }) === null, 'a watt. under a pinned kid but another key: null')
  ok(await resolver({ directoryKeys: { 'dir-2': DIRECTORY_KEYS['dir-2'] } }).resolve({ pub: W.pub, proof: clone(good) }) === null,
    'only the resolver\'s pinned keys count: without dir-1 pinned the same proof is null')
  clock = C + 24 * H
  ok(await resolver().resolve({ pub: W.pub, proof: clone(good) }) === null, 'at the watt.\'s expiry: null')
  clock = NOW
  const tampered = clone(good); (tampered.device as Record<string, string>).cert = (tampered.device as Record<string, string>).cert.replace('wdev.', 'wdev.x')
  ok(await resolver().resolve({ pub: W.pub, proof: tampered }) === null, 'a tampered certificate: null')
  // every failure is null, never a throw
  let threw = false
  const hostile = { get pub() { throw new Error('boom') } }
  try {
    for (const q of [null, undefined, 42, 'x', [], {}, { pub: W.pub }, { pub: W.pub, proof: null }, { pub: W.pub, proof: { device: {}, chain: [] } }, hostile,
      { pub: W.pub, proof: new Proxy({}, { get() { throw new Error('trap') }, ownKeys() { throw new Error('trap') } }) }])
      ok(await resolver().resolve(q) === null, `a malformed query is null: ${typeof q === 'object' && q ? Object.keys(q).join(',') || '{}' : String(q)}`)
  } catch { threw = true }
  ok(!threw, 'no query throws')
  // the 64 KiB cap
  const big = clone(good); (big.chain[0] as Record<string, unknown>).ros = 'x'.repeat(I.PROOF_MAX_BYTES)
  const zr = resolver()
  ok(await zr.resolve({ pub: W.pub, proof: big }) === null && zr.stats.nulls.cap === 1, 'a proof over PROOF_MAX_BYTES: null, counted as cap')
  ok(P.parseProof(big) === 'cap' && P.parseProof(good) !== 'cap' && P.parseProof(good) !== null, 'parseProof: cap over the limit, the proof under it')
  const size = new TextEncoder().encode(JSON.stringify(good)).length
  ok(size < I.PROOF_MAX_BYTES, `a two-link proof is ${size} bytes`)
  const edge = clone(good)
  ;(edge.device as Record<string, string>).cert += ''
  const pad = I.PROOF_MAX_BYTES - new TextEncoder().encode(JSON.stringify(edge)).length
  const at = clone(edge); (at.chain[0] as Record<string, string>).cns = 'y'.repeat(pad - ',"cns":""'.length)
  ok(new TextEncoder().encode(JSON.stringify(at)).length === I.PROOF_MAX_BYTES && P.parseProof(at) !== 'cap', 'exactly PROOF_MAX_BYTES: not over the cap')
  const over = clone(at); (over.chain[0] as Record<string, string>).cns += 'y'
  ok(P.parseProof(over) === 'cap', 'one byte over: cap')
  const uni = clone(good); (uni.chain[0] as Record<string, string>).cns = 'é'.repeat(Math.ceil(I.PROOF_MAX_BYTES / 2) + 10)
  ok(P.parseProof(uni) === 'cap', 'the cap counts UTF-8 bytes, not characters')
  // ONE named constant
  const all = ['identity.ts', 'identityport.ts'].map((f) => readFileSync(join(KS, f), 'utf8')).join('\n')
  ok((all.match(/64 \* 1024/g) ?? []).length === 1 && /export const PROOF_MAX_BYTES = 64 \* 1024/.test(all), 'the cap is one named constant (PROOF_MAX_BYTES)')
}

// ======================================================================================
section('[A3 longest]', 'a device is judged against the longest chain this open holds for its anchor')
{
  clock = NOW
  const a = await proofOf(base, { head: 1, signer: 'pk1' })                         // W, certified by pk1
  const b = await proofOf(removed, { head: 2, signer: 'pk2', dev: W2 })             // W2, from a chain where pk1 is removed
  const rv = resolver()
  ok(await rv.resolve({ pub: W.pub, proof: clone(a) }) !== null, 'positive control: W alone resolves (its proof hides the removal)')
  ok(await rv.resolve({ pub: W2.pub, proof: clone(b) }) !== null, 'W2, with the longer chain, resolves')
  ok(await rv.resolve({ pub: W.pub, proof: clone(a) }) === null, 'W again: null, its certifier is removed in the longer chain')
  const rv2 = resolver()
  await rv2.resolve({ pub: W2.pub, proof: clone(b) })
  ok(await rv2.resolve({ pub: W.pub, proof: clone(a) }) === null, 'the other order: the longer chain first, then W: null')
  ok(await resolver().resolve({ pub: W.pub, proof: clone(a) }) !== null, 'a fresh open (no longer chain held): W resolves again; state is per open')
}

section('[A3 fork]', 'two verified chains for one anchor, neither a prefix of the other: null for both, counted')
{
  clock = NOW
  const a = await proofOf(base)
  const f = await proofOf(forked, { dev: W3 })
  const rv = resolver()
  ok(await rv.resolve({ pub: W.pub, proof: clone(a) }) !== null, 'positive control: the first chain resolves')
  ok(await rv.resolve({ pub: W3.pub, proof: clone(f) }) === null, 'the forked chain: null')
  ok(await rv.resolve({ pub: W.pub, proof: clone(a) }) === null, 'and after the fork, the first chain\'s device too: null')
  ok(rv.stats.forks === 1 && (rv.stats.nulls.fork ?? 0) >= 2, `the fork is counted (forks ${rv.stats.forks}, nulls ${rv.stats.nulls.fork})`)
  const sameRv = resolver()
  ok(await sameRv.resolve({ pub: W.pub, proof: clone(a) }) !== null && await sameRv.resolve({ pub: W.pub, proof: clone(a) }) !== null && sameRv.stats.forks === 0,
    'the same chain twice is no fork')
  const shorter = resolver()
  await shorter.resolve({ pub: W.pub, proof: await proofOf(removed, { head: 1 }) })
  ok(shorter.stats.forks === 0, 'a chain and its extension are no fork')
}

// ======================================================================================
section('[A5 name]', 'name and email are the address; the certificate\'s label never is')
{
  clock = NOW
  const r = await resolver().resolve({ pub: W.pub, proof: await proofOf(base, { label: 'Mallory' }) })
  ok(r !== null && r.name === ADDRESS && r.email === ADDRESS, `a wdev. labelled "Mallory" resolves with name = the address (${r?.name})`)
  ok(r?.vouchedBy === 'id.bento.page' && I.G_VOUCHER === 'id.bento.page', 'vouchedBy is the constant id.bento.page')
  const n = await resolver().resolve({ pub: W.pub, proof: await proofOf(base, { label: null }) })
  ok(n?.name === ADDRESS, '[K7 absent] no label: name is still the address')
}

// ======================================================================================
section('[A6 incident]', 'revoked:\'incident\' only on the lever\'s predicate')
{
  clock = NOW
  const inc = async (from: number, to: number | null, kid = 'dir-1', by = 'dir1') => {
    const text = buildInc({ id: 'inc-1', from, to, issuedAt: to ?? from, kid })
    return { text, sig: await signStatement(K[by].key, text) }
  }
  const around = (t: number) => inc(t - H, t + H)
  const res = async (proof: unknown, recs: unknown[], pub = W.pub) => resolver({ incidents: () => recs }).resolve({ pub, proof })
  const hit = await res(await proofOf(base), [await around(C)])
  ok(hit?.revoked === 'incident' && hit?.fields === 'g1', 'a wdev., ob 1, ceremony inside the window: incident')
  ok((await res(await proofOf(base, { ob: 0 }), [await around(C)]))?.revoked === undefined, 'a wdev. with ob 0 inside the window: NOT incident')
  const ckOb0 = await res(await proofOf(withCk, { kind: 'dev2', via: 'ck', ob: 0 }), [await around(C)])
  ok(ckOb0 !== null && ckOb0.tier === 'native' && ckOb0.revoked === undefined, 'a ck-signed dev2. (native) with ob 0 inside the window: NOT incident')
  ok((await res(await proofOf(withCk, { kind: 'dev2', via: 'ck', ob: 1 }), [await around(C)]))?.revoked === undefined, 'a ck-signed dev2. even with ob 1: NOT incident (the lever never takes native keys)')
  ok((await res(await proofOf(base, { kind: 'dev2' }), [await around(C)]))?.revoked === 'incident', 'a dev2. via passkey, ob 1, inside: incident')
  const C0 = NOW - 72 * H
  const renewedAfter = await proofOf(base, { ceremonyAt: C0, loggedAt: NOW - 2 * H, expires: NOW + 22 * H })
  ok((await res(renewedAfter, [await inc(C0 - H, C0 + H)]))?.revoked === 'incident', 'ceremony inside, renewed (loggedAt) after the window closed: incident')
  const renewedInside = await proofOf(base, { ceremonyAt: C0, loggedAt: NOW - 2 * H, expires: NOW + 22 * H })
  ok((await res(renewedInside, [await inc(NOW - 3 * H, NOW - H)]))?.revoked === 'incident', 'ceremony before the window, a renewal logged inside it: incident')
  ok((await res(await proofOf(base), [await inc(C - 5 * H, C - H)]))?.revoked === undefined, 'a window that ended before the ceremony: NOT incident')
  ok((await res(await proofOf(base), [await inc(C - 5 * H, C)]))?.revoked === 'incident', 'ceremonyAt exactly at the window\'s end: incident (both ends inclusive)')
  ok((await res(await proofOf(base), [await inc(C, C + H)]))?.revoked === 'incident', 'ceremonyAt exactly at the window\'s start: incident')
  ok((await res(await proofOf(base), [await inc(C - H, null)]))?.revoked === 'incident', 'an open window: incident')
  ok((await res(await proofOf(base), [await inc(C - H, C + H, 'dir-1', 'dirOther')]))?.revoked === undefined, 'a record not signed by a pinned key: ignored')
  ok((await res(await proofOf(base), [await inc(C - H, C + H, 'dir-7', 'dirOther')]))?.revoked === undefined, 'a record under an unpinned kid: ignored')
  ok((await res(await proofOf(base), [{ text: 'inc.x', sig: 'y' }, null, 7]))?.revoked === undefined, 'malformed records: ignored, no throw')
  // the predicate itself
  const I0 = { id: 'i', from: 100, to: 200, issuedAt: 200, kid: 'dir-1' }
  const lc = (kind: string, via: string, ob: number, ceremonyAt: number, loggedAt: number, i = I0) => D.leverCovers({ kind, via, ceremonyAt }, { ob, loggedAt }, i)
  ok(lc('wdev', 'passkey', 1, 150, 150) && lc('wdev', 'cns', 1, 150, 150) && lc('dev2', 'passkey', 1, 150, 150), 'leverCovers: wdev. (either via) and dev2. via passkey')
  ok(!lc('dev2', 'ck', 1, 150, 150) && !lc('wdev', 'passkey', 0, 150, 150), 'leverCovers: not a ck dev2., not ob 0')
  ok(lc('wdev', 'passkey', 1, 200, 300) && lc('wdev', 'passkey', 1, 100, 100) && !lc('wdev', 'passkey', 1, 99, 201) && lc('wdev', 'passkey', 1, 50, 200),
    'leverCovers: [from, to] inclusive, ceremonyAt or loggedAt')
  ok(lc('wdev', 'passkey', 1, 5000, 5000, { ...I0, to: null }), 'leverCovers: an open window has no end')
  const devSrc = readFileSync(join(KS, 'devices.ts'), 'utf8')
  ok((devSrc.match(/export function leverCovers/g) ?? []).length === 1 && /leverCovers\(dv\.value\.cert, dv\.value\.watt/.test(readFileSync(join(KS, 'identityport.ts'), 'utf8')),
    'one predicate: devices.ts leverCovers, the one the resolver calls')
  ok((await res(await proofOf(base), []))?.revoked === undefined, '[K7 absent] no records: not revoked')
  ok((await resolver().resolve({ pub: W.pub, proof: await proofOf(base) }))?.revoked === undefined, '[K7 absent] no incidents option at all: not revoked')
}

// ======================================================================================
section('[A7 own]', 'own-account status for the own anchor only; the peer path never polls')
{
  clock = NOW
  fetches = 0
  const proof = await proofOf(base)
  const anchor = await anchorOf(base)
  const own = await resolver({ own: () => ({ anchor, revoked: 'signout' }) }).resolve({ pub: W.pub, proof: clone(proof) })
  ok(own?.revoked === 'signout', 'own account signed out everywhere (wout.): revoked signout')
  ok((await resolver({ own: () => ({ anchor, revoked: 'deleted' }) }).resolve({ pub: W.pub, proof: clone(proof) }))?.revoked === 'deleted', 'own account deleted (rdel.): revoked deleted')
  const otherAnchor = await anchorOf(otherAccount)
  const other = await resolver({ own: () => ({ anchor: otherAnchor, revoked: 'signout' }) }).resolve({ pub: W.pub, proof: clone(proof) })
  ok(other !== null && other.revoked === undefined, 'another agent whose OWN account is signed out: this peer\'s answer is not revoked')
  const peer = resolver({ own: () => null })
  ok((await peer.resolve({ pub: W.pub, proof: clone(proof) }))?.fields === 'g1', 'the same proof as a peer: ✓ while its watt. is current')
  clock = C + 24 * H - 1
  ok((await peer.resolve({ pub: W.pub, proof: clone(proof) })) !== null, 'one ms before the watt. expires: still ✓')
  clock = C + 24 * H
  ok((await peer.resolve({ pub: W.pub, proof: clone(proof) })) === null, 'at its expiry: null')
  ok(fetches === 0, `the resolver made no network request (counted ${fetches})`)
  clock = NOW
  ok((await resolver({ own: () => ({ anchor, revoked: false }) }).resolve({ pub: W.pub, proof: clone(proof) }))?.revoked === undefined, '[K7 absent] own account standing: not revoked')
}

// ======================================================================================
section('[tofu]', 'firstSeen and changed are per open')
{
  clock = NOW
  const rv = resolver()
  const p = await proofOf(base)
  const a = await rv.resolve({ pub: W.pub, proof: clone(p) })
  clock = NOW + 60_000
  const b = await rv.resolve({ pub: W.pub, proof: clone(p) })
  ok(a?.firstSeen === NOW && b?.firstSeen === NOW && b?.changed === false, 'firstSeen is the first resolve of this pub in this open; changed false')
  // the same pub, later certified under a different anchor (a re-setup at the same address)
  const other = await proofOf(resetup, { head: 0 })
  const c = await rv.resolve({ pub: W.pub, proof: other })
  ok(c !== null && c.changed === true && c.accountPub !== a?.accountPub, 'the same pub under a new anchor: changed')
  const rv3 = resolver()
  await rv3.resolve({ pub: W.pub, proof: clone(p) })
  const e = await rv3.resolve({ pub: W.pub, proof: await proofOf(otherAccount, { head: 0, signer: 'pk3', address: 'bob@example.com' }) })
  ok(e !== null && e.changed === true && e.email === 'bob@example.com', 'the same pub under another account (another address): changed')
  const rv2 = resolver()
  await rv2.resolve({ pub: W.pub, proof: clone(p) })
  const d = await rv2.resolve({ pub: W2.pub, proof: await proofOf(resetup, { head: 0, dev: W2 }) })
  ok(d !== null && d.changed === true, 'the same address under a new anchor, another pub: changed')
  clock = NOW + 120_000
  const fresh = await resolver().resolve({ pub: W.pub, proof: clone(p) })
  ok(fresh?.firstSeen === NOW + 120_000 && fresh?.changed === false, 'a new open starts fresh: nothing crosses opens')
}

// ======================================================================================
section('[K6 compose]', 'composeResolved is the only setter of the marker; checkResolved keeps it only when every present G field is typed')
{
  const facts = { address: ADDRESS, anchor: await anchorOf(base), tier: 'passkey', accountSince: T, rosterChangedAt: T + 73 * H, resetAt: null,
    revoked: false, mb: 0, firstSeen: NOW, changed: false }
  const c = I.composeResolved(facts)
  ok(c?.fields === 'g1' && c.name === ADDRESS && c.email === ADDRESS && c.vouchedBy === 'id.bento.page', 'composeResolved marks a complete answer')
  ok(c && !('resetAt' in c) && !('revoked' in c) && !('unconfirmedSince' in c) && !('managedBy' in c), '[K7 absent] fields that do not apply are absent, not null')
  ok(I.composeResolved({ ...facts, mb: T + 5 })?.unconfirmedSince === T + 5, 'mb ≠ 0 becomes unconfirmedSince')
  ok(I.composeResolved({ ...facts, accountSince: null }) === null, '[K7 absent] an unknown account age (no seq 0): no answer, never a marker without accountSince')
  clock = NOW
  const mbr = await resolver().resolve({ pub: W.pub, proof: await proofOf(base, { mb: C - 5 * H }) })
  ok(mbr?.unconfirmedSince === C - 5 * H && mbr?.fields === 'g1', 'a watt. with mb ≠ 0 resolves with unconfirmedSince = mb (962 P2)')
  ok(I.composeResolved({ ...facts, anchor: pubOf('pk1') }) === null, 'a K2-era point is no anchor: composeResolved refuses')
  ok(I.composeResolved({ ...facts, accountSince: 0 }) === null, 'a fact that fails its type: no answer at all')
  // the marker's only setter
  // code only: comment lines (// and the * of doc comments) are blanked, keeping line numbers
  const code = (s: string) => s.split('\n').map((l) => (/^\s*(\/\/|\/?\*)/.test(l) ? '' : l)).join('\n')
  const srcs = ['identity.ts', 'identityport.ts', 'roster.ts', 'devices.ts'].map((f) => [f, code(readFileSync(join(KS, f), 'utf8'))] as const)
  const setters = srcs.flatMap(([f, s]) => [...s.matchAll(/fields\s*(?::|=)\s*(RESOLVED_FIELDS|'g1'|"g1")/g)].map((m) => `${f}@${s.slice(0, m.index).split('\n').length}`))
  const id = srcs[0][1]
  const composeAt = id.indexOf('export function composeResolved')
  const line = setters[0] ? Number(setters[0].split('@')[1]) : -1
  ok(setters.length === 1 && setters[0].startsWith('identity.ts') && line > id.slice(0, composeAt).split('\n').length, `one setter of the marker, inside composeResolved (${setters.join(' ')})`)

  const anchor = await anchorOf(base)
  const g = (x: Record<string, unknown> = {}) => ({ name: ADDRESS, email: ADDRESS, vouchedBy: 'id.bento.page', accountPub: anchor, firstSeen: NOW, changed: false, fields: 'g1', ...x })
  ok(I.checkResolved(g())?.fields === 'g1', '[K7 absent] the six fields and the marker, no G field: the marker stays (absent = does not apply)')
  ok(I.checkResolved(g({ fields: undefined }))?.fields === undefined, '[K7 absent] an answer without the marker never gains it')
  const { fields: _f, ...noMarker } = g()
  ok(!('fields' in I.checkResolved(noMarker)!), '[K7 absent] marker key missing: none added')
  for (const [f, bad] of [['tier', 'gold'], ['accountSince', 0], ['rosterChangedAt', -5], ['resetAt', 1.5], ['revoked', null], ['revoked', true], ['revoked', 'bogus'],
    ['managedBy', 'Example Corp'], ['unconfirmedSince', '1800000000000'], ['resetAt', 8.64e15 + 1]] as const) {
    const out = I.checkResolved(g({ [f]: bad }))
    ok(out !== null && out.fields === undefined && !(f in out), `${f}: ${JSON.stringify(bad)} drops the field and the marker`)
  }
  for (const [f, good] of [['tier', 'native'], ['accountSince', T], ['rosterChangedAt', T], ['resetAt', T], ['revoked', false], ['revoked', 'signout'],
    ['revoked', 'incident'], ['revoked', 'deleted'], ['managedBy', 'example.com'], ['unconfirmedSince', T]] as const)
    ok(I.checkResolved(g({ [f]: good }))?.fields === 'g1' && (I.checkResolved(g({ [f]: good })) as Record<string, unknown>)[f] === good, `${f}: ${JSON.stringify(good)} kept with the marker`)
  ok(I.checkResolved(g({ extra: 1, devicePub: 'x' })) && !('extra' in I.checkResolved(g({ extra: 1 }))!), 'unknown keys are dropped')
  const k2 = I.checkResolved(g({ accountPub: pubOf('pk1') }))
  ok(k2 !== null && k2.accountPub === pubOf('pk1') && k2.fields === undefined, 'a K2-era 87-char point passes as a plain field, never with g1')
  for (const ap of ['g:' + 'A'.repeat(42), 'g:' + 'A'.repeat(44), 'G:' + 'A'.repeat(43), 'g:' + 'A'.repeat(42) + '=', ' g:' + 'A'.repeat(43)])
    ok(I.checkResolved(g({ accountPub: ap }))?.fields === undefined, `not the anchor shape (${ap.slice(0, 6)}…${ap.length}): no marker`)
  ok(I.checkResolved(g({ name: '' })) === null && I.checkResolved(g({ vouchedBy: 'id.bento.page ✓' })) === null && I.checkResolved(g({ changed: 'no' })) === null &&
    I.checkResolved(g({ firstSeen: 0 })) === null, 'a broken required field: null')
  const getter = g(); Object.defineProperty(getter, 'fields', { get: () => 'g1', enumerable: true })
  ok(I.checkResolved(getter)?.fields === undefined, 'a marker behind a getter is not kept')
  const inherited = Object.assign(Object.create({ fields: 'g1' }), g({ fields: undefined }))
  ok(I.checkResolved(inherited)?.fields === undefined, 'an inherited marker is not kept')
  ok(I.checkResolved(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap') } })) === null && I.checkResolved([g()]) === null && I.checkResolved('x') === null,
    'a hostile proxy, an array, a string: null, no throw')
}

// ======================================================================================
// the port
type Port = MessagePort
function open(o: Record<string, unknown> = {}) {
  const calls: Array<{ op: string; ctx: unknown; args: unknown[] }> = []
  const agent = (o.agent as Record<string, unknown>) ?? {}
  const host = {
    whoami: async (ctx: unknown) => { calls.push({ op: 'whoami', ctx, args: [] }); return 'whoami' in agent ? (agent.whoami as () => unknown)() : identity },
    sign: async (ctx: unknown, ...args: unknown[]) => { calls.push({ op: 'sign', ctx, args }); return 'sign' in agent ? (agent.sign as () => unknown)() : { ok: true, sig: 'S'.repeat(86), pub: W.pub } },
    resolve: async (ctx: unknown, ...args: unknown[]) => { calls.push({ op: 'resolve', ctx, args }); return 'resolve' in agent ? (agent.resolve as (q: unknown) => unknown)(args[0]) : resolved },
  }
  const ch = new MessageChannel()
  const s = P.serveIdentity(ch.port1, { entry: (o.entry as string) ?? 'entry-1', docId: o.docId === undefined ? 'doc-1' : o.docId as string | null, agent: host, limits: o.limits as never, now: o.now as never })
  return { s, port: ch.port2 as Port, calls, close: () => { s.close(); ch.port2.close() } }
}
async function raw(port: Port, msgs: unknown[], ms = 40): Promise<Array<Record<string, unknown>>> {
  const got: Array<Record<string, unknown>> = []
  const fn = (e: MessageEvent) => got.push(e.data)
  port.addEventListener('message', fn); port.start()
  for (const m of msgs) port.postMessage(m)
  await sleep(ms)
  port.removeEventListener('message', fn)
  return got
}
const M = (id: number, op: string, x: Record<string, unknown> = {}) => ({ t: 'bento-id', v: 1, id, op, ...x })
const identity = { name: ADDRESS, email: ADDRESS, vouchedBy: 'id.bento.page', accountPub: await anchorOf(base), devicePub: W.pub, proof: await proofOf(base) }
const resolved = { name: ADDRESS, email: ADDRESS, vouchedBy: 'id.bento.page', accountPub: await anchorOf(base), firstSeen: NOW, changed: false, tier: 'passkey', accountSince: T, fields: 'g1' }
const goodPayload = 'prove.' + 'A'.repeat(22) + '.w' + 'a'.repeat(20)

section('[K1 wire]', 'the schema: closed ops, exact keys, plain objects, ids that only go up')
{
  const h = open()
  const r = await raw(h.port, [M(1, 'whoami'), M(2, 'resolve', { pub: W.pub, proof: identity.proof }), M(3, 'sign', { purpose: 'prove', payload: goodPayload })])
  ok(r.length === 3 && r[0].identity !== null && (r[1].identity as Record<string, unknown>)?.fields === 'g1' && (r[2].result as Record<string, unknown>)?.ok === true,
    'positive control: whoami, resolve and sign answered')
  ok(r.every((m) => m.t === 'bento-id' && m.v === 1) && r.map((m) => m.id).join() === '1,2,3', 'answers carry t, v and the request id, in order')
  const before = h.s.stats.dropped
  const bad: Array<[unknown, string]> = [
    [{ ...M(10, 'whoami'), docId: 'other' }, 'keys'], [{ ...M(11, 'whoami'), entry: 'other' }, 'keys'], [M(12, 'unwrap'), 'op'], [M(13, 'share'), 'op'],
    [{ ...M(14, 'sign', { purpose: 'prove', payload: goodPayload }), extra: 1 }, 'keys'], [M(15, 'sign', { purpose: 'prove' }), 'keys'],
    [M(16, 'sign', { purpose: 'admin', payload: 'x' }), 'purpose'], [M(17, 'sign', { purpose: 'prove', payload: 7 }), 'payload'],
    [M(18, 'sign', { purpose: 'frame', payload: 'x'.repeat(P.SIGN_PAYLOAD_MAX + 1) }), 'payload'],
    [M(19, 'resolve', { pub: 'short' }), 'pub'], [M(20, 'resolve', { email: ADDRESS }), 'keys'], [M(21, 'resolve', { pub: W.pub, proof: { device: identity.proof.device } }), 'proof'],
    [M(22, 'resolve', { pub: W.pub, proof: { ...identity.proof, directoryKeys: { 'dir-1': K.dirOther.pub } } }), 'proof'],
    [M(23, 'resolve', { pub: W.pub, proof: { device: { ...identity.proof.device, kid: 'x' }, chain: identity.proof.chain } }), 'proof'],
    [M(24, 'resolve', { pub: W.pub, proof: { device: identity.proof.device, chain: [] } }), 'proof'],
    [M(25, 'resolve', { pub: W.pub, proof: { device: identity.proof.device, chain: [{ ...identity.proof.chain[0], ros: 5 }] } }), 'proof'],
    [M(26, 'resolve', { pub: W.pub, proof: { device: identity.proof.device, chain: [new Map()] } }), 'proof'],
    [{ ...M(27, 'whoami'), v: 2 }, 'version'], [{ ...M(28, 'whoami'), t: 'bento-store' }, 'shape'], ['whoami', 'shape'], [[M(29, 'whoami')], 'shape'],
    [new Date(), 'shape'], [M(1, 'whoami'), 'id'], [M(3, 'whoami'), 'id'], [M(1.5, 'whoami'), 'id'], [M(-1, 'whoami'), 'id'], [{ ...M(30, 'whoami'), id: '30' }, 'id'],
  ]
  const r2 = await raw(h.port, bad.map(([m]) => m))
  ok(r2.length === 0, `every malformed message is dropped, not answered (${r2.length} answered)`)
  ok(h.s.stats.dropped - before === bad.length, `each drop counted (${h.s.stats.dropped - before}/${bad.length})`)
  const want: Record<string, number> = {}
  for (const [, why] of bad) want[why] = (want[why] ?? 0) + 1
  ok(Object.entries(want).every(([k, n]) => h.s.stats.byReason[k] === n), `by reason: ${JSON.stringify(h.s.stats.byReason)}`)
  const r3 = await raw(h.port, [M(31, 'whoami')])
  ok(r3.length === 1 && r3[0].id === 31, 'the session still serves after the drops')
  // parse-level checks a port cannot carry (structured clone strips symbols and prototypes)
  const sym = M(40, 'whoami') as Record<PropertyKey, unknown>; sym[Symbol('x')] = 1
  ok(P.parseIdentityRequest(sym, 0) === 'keys', 'a symbol key: keys')
  ok(P.parseIdentityRequest(Object.assign(Object.create({ evil: 1 }), M(41, 'whoami')), 0) === 'shape', 'a non-plain prototype: shape')
  ok(P.parseIdentityRequest(Object.assign(Object.create(null), M(42, 'whoami')), 0) !== 'shape', 'a null prototype is plain')
  const symProof = structuredClone(identity.proof) as Record<PropertyKey, unknown>; symProof[Symbol('k')] = 1
  ok(P.parseProof(symProof) === null, 'a proof with a symbol key: not a proof')
  const protoLink = structuredClone(identity.proof); protoLink.chain[0] = Object.assign(Object.create({ x: 1 }), protoLink.chain[0])
  ok(P.parseProof(protoLink) === null, 'a link with a non-plain prototype: not a proof')
  const getterDev = structuredClone(identity.proof); Object.defineProperty(getterDev.device, 'cert', { get: () => 'wdev.x', enumerable: true })
  ok(P.parseProof(getterDev) === null, 'a getter inside the proof: not a proof')
  const sparse = structuredClone(identity.proof); (sparse.chain as unknown[]).length = 3
  ok(P.parseProof(sparse) === null, 'a sparse chain array: not a proof')
  ok(P.parseIdentityRequest(M(43, 'resolve', { pub: W.pub }), 0) !== 'keys', '[K7 absent] resolve without a proof is well-formed')
  h.close()
}

section('[K3 limits]', 'flow: in-flight and rate caps, close at maxDrops, teardown')
{
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const h = open({ agent: { whoami: async () => { await gate; return identity } }, limits: { maxInFlight: 2 } })
  const r = await raw(h.port, [M(1, 'whoami'), M(2, 'whoami'), M(3, 'whoami')], 30)
  ok(r.length === 0 && h.s.stats.byReason['in-flight'] === 1, 'a third request while two are in flight is dropped (in-flight)')
  release(); await sleep(20)
  h.close()
  let t = 0
  const hr = open({ limits: { rateMax: 3, rateWindowMs: 1000 }, now: () => t })
  const rr = await raw(hr.port, [M(1, 'whoami'), M(2, 'whoami'), M(3, 'whoami'), M(4, 'whoami')])
  ok(rr.length === 3 && hr.s.stats.byReason.rate === 1, 'over the rate: dropped (rate)')
  t = 1000
  ok((await raw(hr.port, [M(5, 'whoami')])).length === 1, 'a new window serves again')
  hr.close()
  const hd = open({ limits: { maxDrops: 4 } })
  await raw(hd.port, [M(0, 'whoami'), 'x', 'y', 'z'])
  ok(hd.s.closed, 'maxDrops drops close the session')
  ok((await raw(hd.port, [M(9, 'whoami')])).length === 0, 'a closed session answers nothing on its old port')
  const hc = open()
  hc.s.close()
  ok((await raw(hc.port, [M(1, 'whoami')])).length === 0 && hc.calls.length === 0, 'close(): nothing answered, the agent never asked')
  // the protocol source never reads an origin or posts to a window (a wire rule, tagged as one)
  current = '[K1 wire]'
  const src = readFileSync(join(KS, 'identityport.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  ok(!/\.origin\b/.test(src) && !/\bsource\b\s*[.(]/.test(src) && !/window\.|parent\.|top\./.test(src), 'no origin read, no window posted to')
}

section('[K2 binding]', 'the agent\'s context is the host\'s entry and docId, never the request\'s')
{
  const h = open({ entry: 'host-entry', docId: 'host-doc' })
  await raw(h.port, [M(1, 'whoami'), { ...M(2, 'whoami'), docId: 'page-doc' }, M(3, 'resolve', { pub: W.pub, proof: identity.proof }), M(4, 'sign', { purpose: 'prove', payload: goodPayload })])
  ok(h.calls.length === 3 && h.calls.every((c) => JSON.stringify(c.ctx) === JSON.stringify({ entry: 'host-entry', docId: 'host-doc' })),
    `every call carries the host's entry and docId (${JSON.stringify(h.calls.map((c) => c.ctx))})`)
  ok(h.calls.every((c) => Object.isFrozen(c.ctx)), 'the context is frozen')
  h.close()
  const hn = open({ docId: null })
  await raw(hn.port, [M(1, 'whoami')])
  ok(JSON.stringify(hn.calls[0]?.ctx) === JSON.stringify({ entry: 'entry-1', docId: null }), '[K7 absent] no verified docId: the agent is told null')
  hn.close()
  let threw = 0
  for (const e of ['', undefined, 7]) { try { P.serveIdentity(new MessageChannel().port1, { entry: e as never, docId: 'd', agent: open().s as never }) } catch { threw++ } }
  ok(threw === 3, 'serveIdentity refuses to start without a host-minted entry')
}

section('[R3 consent]', 'sign and resolve only after whoami consent in this session')
{
  const h = open()
  const r = await raw(h.port, [M(1, 'sign', { purpose: 'prove', payload: goodPayload }), M(2, 'resolve', { pub: W.pub, proof: identity.proof })])
  ok((r[0]?.result as Record<string, unknown>)?.reason === 'declined' && r[1]?.identity === null, 'before whoami: sign declined, resolve null')
  ok(h.calls.length === 0, 'and the agent was never asked')
  await raw(h.port, [M(3, 'whoami')])
  const r2 = await raw(h.port, [M(4, 'sign', { purpose: 'prove', payload: goodPayload }), M(5, 'resolve', { pub: W.pub, proof: identity.proof })])
  ok((r2[0]?.result as Record<string, unknown>)?.ok === true && (r2[1]?.identity as Record<string, unknown>)?.fields === 'g1', 'after consent: both answered')
  const r3 = await raw(h.port, [M(6, 'sign', { purpose: 'invite', payload: 'inv.' + W.pub + '.writer.5' }), M(7, 'sign', { purpose: 'revoke', payload: 'rev.' + W.pub })])
  ok(r3.every((m) => (m.result as Record<string, unknown>)?.reason === 'unavailable') && !h.calls.some((c) => c.op === 'sign' && ['invite', 'revoke'].includes(c.args[0] as string)),
    'invite and revoke: unavailable, never asked (phase 1)')
  const r4 = await raw(h.port, [M(8, 'sign', { purpose: 'prove', payload: 'dlg.' + W.pub })])
  ok((r4[0]?.result as Record<string, unknown>)?.reason === 'purpose' && h.calls.filter((c) => c.op === 'sign').length === 1, 'a payload that does not match its purpose: refused, never asked')
  h.close()
  const hd = open({ agent: { whoami: () => null } })
  await raw(hd.port, [M(1, 'whoami')])
  const rd = await raw(hd.port, [M(2, 'whoami'), M(3, 'sign', { purpose: 'prove', payload: goodPayload }), M(4, 'resolve', { pub: W.pub, proof: identity.proof })])
  ok(rd[0]?.identity === null && (rd[1]?.result as Record<string, unknown>)?.reason === 'declined' && rd[2]?.identity === null, 'after "Not here": whoami null, sign declined, resolve null')
  ok(hd.calls.length === 1, `a declined whoami is final: the agent was asked once (${hd.calls.length})`)
  hd.close()
  const ht = open({ agent: { whoami: () => { throw new Error('host broke') } } })
  const rt = await raw(ht.port, [M(1, 'whoami'), M(2, 'sign', { purpose: 'prove', payload: goodPayload })])
  ok(rt[0]?.identity === null && (rt[1]?.result as Record<string, unknown>)?.reason === 'declined', 'a whoami that throws is a null whoami, not a consent')
  ht.close()
}

section('[K4 filter]', 'every answer is type-checked on the way out')
{
  const full = { ...resolved, revoked: 'signout', unconfirmedSince: T + 9, resetAt: T + 8, rosterChangedAt: T + 7, tier: 'native', fields: 'g1' }
  const hf = open({ agent: { resolve: () => full } })
  await raw(hf.port, [M(1, 'whoami')])
  const rf = (await raw(hf.port, [M(2, 'resolve', { pub: W.pub })]))[0]?.identity as Record<string, unknown>
  const same = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(a).length === Object.keys(b).length && Object.keys(b).every((k) => a[k] === b[k])
  ok(rf && same(rf, full), `revoked signout, unconfirmedSince and every G field survive the port hop with fields g1 (${JSON.stringify(rf)?.slice(0, 60)}…)`)
  for (const rv of ['incident', 'deleted']) {
    const hr = open({ agent: { resolve: () => ({ ...resolved, revoked: rv }) } })
    await raw(hr.port, [M(1, 'whoami')])
    const got = (await raw(hr.port, [M(2, 'resolve', { pub: W.pub })]))[0]?.identity as Record<string, unknown>
    ok(got?.revoked === rv && got?.fields === 'g1', `revoked ${rv} survives the port hop with the marker`)
    hr.close()
  }
  hf.close()
  const leaky = { ...resolved, fields: 'g1', revoked: null, extra: 'x', devicePub: W.pub }
  const h = open({ agent: { resolve: () => leaky } })
  await raw(h.port, [M(1, 'whoami')])
  const r = (await raw(h.port, [M(2, 'resolve', { pub: W.pub, proof: identity.proof })]))[0]?.identity as Record<string, unknown>
  ok(r && r.fields === undefined && !('revoked' in r) && !('extra' in r) && !('devicePub' in r), 'a resolve answer with a malformed G field: marker and field dropped, unknown keys dropped')
  ok(h.s.stats.malformed === 0, 'a partly bad answer is still an answer (not counted malformed)')
  h.close()
  const hb = open({ agent: { resolve: () => ({ ...resolved, accountPub: pubOf('pk1') }) } })
  await raw(hb.port, [M(1, 'whoami')])
  const rb = (await raw(hb.port, [M(2, 'resolve', { pub: W.pub })]))[0]?.identity as Record<string, unknown>
  ok(rb && rb.fields === undefined, 'a g1 answer whose accountPub is no anchor: forwarded without the marker')
  ok(JSON.stringify(hb.calls[1]?.args[0]) === JSON.stringify({ pub: W.pub }), '[K7 absent] a resolve without a proof reaches the agent as {pub} alone')
  hb.close()
  const hx = open({ agent: { resolve: () => ({ name: 5 }), sign: () => ({ ok: true, sig: 'short', pub: W.pub }), whoami: () => identity } })
  await raw(hx.port, [M(1, 'whoami')])
  const rx = await raw(hx.port, [M(2, 'resolve', { pub: W.pub }), M(3, 'sign', { purpose: 'prove', payload: goodPayload })])
  ok(rx[0]?.identity === null && (rx[1]?.result as Record<string, unknown>)?.reason === 'unavailable' && hx.s.stats.malformed === 2, 'a malformed resolve is null, a malformed sign is unavailable, both counted')
  hx.close()
  const hs = open({ agent: { sign: () => ({ ok: false, reason: 'reauth', extra: 1 }) } })
  await raw(hs.port, [M(1, 'whoami')])
  const rs = (await raw(hs.port, [M(2, 'sign', { purpose: 'prove', payload: goodPayload })]))[0]?.result as Record<string, unknown>
  ok(rs?.reason === 'reauth' && !('extra' in rs), 'a refusal keeps its reason and loses anything else')
  hs.close()
  // whoami
  const bigProof = structuredClone(identity.proof); (bigProof.chain[0] as Record<string, unknown>).ros = 'x'.repeat(I.PROOF_MAX_BYTES)
  const hw = open({ agent: { whoami: () => ({ ...identity, proof: bigProof, secret: 'k' }) } })
  const rw = (await raw(hw.port, [M(1, 'whoami')]))[0]?.identity as Record<string, unknown>
  ok(rw && rw.devicePub === W.pub && rw.proof === undefined && hw.s.stats.proofCapped === 1, 'a whoami proof over the cap: the identity without it, counted')
  ok(rw && !('secret' in rw), 'whoami: unknown keys dropped')
  hw.close()
  const hp = open()
  const rp = (await raw(hp.port, [M(1, 'whoami')]))[0]?.identity as Record<string, unknown>
  ok(rp && JSON.stringify(rp.proof) === JSON.stringify(identity.proof), 'a whoami proof under the cap is carried whole')
  hp.close()
  const hn = open({ agent: { whoami: () => { const { proof: _p, ...rest } = identity; return rest } } })
  const rn = (await raw(hn.port, [M(1, 'whoami')]))[0]?.identity as Record<string, unknown>
  ok(rn && !('proof' in rn) && hn.s.stats.proofCapped === 0, '[K7 absent] a whoami without a proof: no proof, nothing counted')
  hn.close()
  const hm = open({ agent: { whoami: () => ({ ...identity, devicePub: 'x' }) } })
  ok((await raw(hm.port, [M(1, 'whoami')]))[0]?.identity === null && hm.s.stats.malformed === 1, 'a malformed whoami answer is null, counted')
  hm.close()
  // a proof over the cap on resolve never reaches the agent
  const hc = open()
  await raw(hc.port, [M(1, 'whoami')])
  const rc = await raw(hc.port, [M(2, 'resolve', { pub: W.pub, proof: bigProof })])
  ok(rc[0]?.identity === null && hc.s.stats.gated['proof-cap'] === 1 && !hc.calls.some((c) => c.op === 'resolve'), 'resolve with a proof over the cap: null, counted, the agent never asked')
  hc.close()
}

section('[R1b resolve]', 'end to end: the port serving the real resolver')
{
  clock = NOW
  const rv = resolver()
  const h = open({ agent: { resolve: (q: unknown) => rv.resolve(q) } })
  await raw(h.port, [M(1, 'whoami')])
  const r = await raw(h.port, [M(2, 'resolve', { pub: W.pub, proof: identity.proof }), M(3, 'resolve', { pub: W2.pub, proof: identity.proof }), M(4, 'resolve', { pub: W.pub })], 400)
  ok((r[0]?.identity as Record<string, unknown>)?.fields === 'g1' && (r[0]?.identity as Record<string, unknown>)?.name === ADDRESS, 'a real proof resolves through the port')
  ok(r[1]?.identity === null && r[2]?.identity === null, 'another pub, and no proof: null')
  ok(rv.stats.nulls['no-proof'] === 1 && rv.stats.nulls.pub === 1, `misses counted (${JSON.stringify(rv.stats.nulls)})`)
  h.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
