#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Generates kernel/fixtures/roster-v1.json: the conformance rows for the bento/id
// option G roster chain (kernel/src/roster.ts): ros. heads, the directory's rip.
// countersign, and the member proofs (passkey assertions, recovery-key signatures).
//
//   node scripts/gen-roster-vectors.ts [--out <file>]
//
// Keys are DETERMINISTIC (scalars from SHA-256 of a label), so a key keeps its
// public point across regenerations. ECDSA signatures are random, so a
// regeneration changes signature bytes, never verdicts. Passkey assertions come
// from a software authenticator here; real browser assertions are the contract
// of webauthn-v1.json, which roster.ts reuses unchanged.
//
// Every accepted row also carries the state the chain must yield, written by
// hand below (not read back from the verifier).

import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { b64uEnc, sha256b64u, signStatement } from '../kernel/src/statements.ts'
import { publicKeyOf } from '../kernel/src/recovery.ts'
import { buildRos, buildRip, ROSTER_RP_ID, ROSTER_WEB_ORIGINS, type MemberKind } from '../kernel/src/roster.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outArg = process.argv.indexOf('--out')
const OUT = outArg > 0 ? process.argv[outArg + 1] : join(root, 'kernel/fixtures/roster-v1.json')

const te = new TextEncoder()
const sha = async (b: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest('SHA-256', (typeof b === 'string' ? te.encode(b) : b) as BufferSource))
const unb = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

// --- keys ------------------------------------------------------------------------

type Key = { pub: string; key: CryptoKey }
async function ecdsa(label: string): Promise<Key> {
  const d = await sha(`bento/id/roster/v1/test/${label}`)
  const pub = publicKeyOf(d)
  if (!pub) throw new Error(`scalar ${label} out of range`)
  const raw = unb(pub)
  const jwk = { kty: 'EC', crv: 'P-256', d: b64uEnc(d), x: b64uEnc(raw.slice(1, 33)), y: b64uEnc(raw.slice(33)), ext: true }
  return { pub, key: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) }
}
const LABELS = ['pk1', 'pk2', 'pk3', 'pk4', 'ck1', 'ck2', 'rk1', 'rk2', 'dir1', 'dirOther',
  ...Array.from({ length: 17 }, (_, i) => `m${i}`)]
const K: Record<string, Key> = {}
for (const l of LABELS) K[l] = await ecdsa(l)
const pubOf = (l: string) => K[l].pub
// a point off the curve: the last byte of a real one, changed
const OFF_CURVE = (() => { const r = unb(K.pk4.pub); r[64] ^= 1; return b64uEnc(r) })()

const DIRECTORY_KEYS = { 'dir-1': K.dir1.pub }
const RP = ROSTER_RP_ID
const ORIGIN = ROSTER_WEB_ORIGINS[0]

// --- the software authenticator -----------------------------------------------

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const big = (u: Uint8Array) => BigInt('0x' + (Buffer.from(u).toString('hex') || '0'))
const be32 = (x: bigint) => Uint8Array.from(Buffer.from(x.toString(16).padStart(64, '0'), 'hex'))
const minInt = (v: Uint8Array) => { let i = 0; while (i < v.length - 1 && v[i] === 0) i++; v = v.slice(i); return v[0] & 0x80 ? Uint8Array.from([0, ...v]) : v }
function rawToDer(raw: Uint8Array): Uint8Array {
  const r = minInt(raw.slice(0, 32)), s = minInt(raw.slice(32))
  const body = [0x02, r.length, ...r, 0x02, s.length, ...s]
  return Uint8Array.from([0x30, body.length, ...body])
}
type AssertOpts = { rpId?: string; origin?: string; flags?: number; over?: string }
async function assertion(label: string, text: string, o: AssertOpts = {}) {
  const ad = new Uint8Array(37)
  ad.set(await sha(o.rpId ?? RP))
  ad[32] = o.flags ?? 0x05                                  // UP | UV
  const cdj = te.encode(JSON.stringify({ type: 'webauthn.get', challenge: b64uEnc(await sha(o.over ?? text)), origin: o.origin ?? ORIGIN, crossOrigin: false }))
  const signed = new Uint8Array(37 + 32)
  signed.set(ad); signed.set(await sha(cdj), 37)
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, K[label].key, signed as BufferSource))
  return { authenticatorData: b64uEnc(ad), clientDataJSON: b64uEnc(cdj), signature: b64uEnc(rawToDer(raw)) }
}
/** the high-S twin of a low-S raw signature (verifies under WebCrypto, refused by bento's rule) */
const highS = (sig: string) => { const r = unb(sig); return b64uEnc(Uint8Array.from([...r.slice(0, 32), ...be32(N - big(r.slice(32)))])) }

// --- link builder -----------------------------------------------------------------

const ADDRESS = 'alice@example.com'
const H = 3_600_000
const T = 1_800_000_000_000
const NOW = T + 2000 * H
const nonce = (i: number) => b64uEnc(new Uint8Array(32).fill(i + 1))

type M = [MemberKind, string] | [MemberKind, string, 'q']
interface Spec {
  members: M[]
  req: number
  rip: number
  reset?: boolean
  signer?: string                     // label
  proof?: 'assertion' | 'sig' | 'both' | 'none'
  assert?: AssertOpts & { by?: string }
  sigHighS?: boolean
  sigBy?: string                      // label signing the rk sig instead of the signer
  // overrides of the ros. text
  seq?: number; prev?: string | null; address?: string; dirNonce?: string; created?: number
  rawMembers?: string                 // the members field verbatim (unsorted, malformed...)
  rosText?: string                    // the whole ros. text verbatim
  // overrides of the rip.
  ripOver?: string; kid?: string; ripBy?: string; ripHighS?: boolean; ripText?: string
}
type Link = { ros: string; rip: string; ripSig: string; signer?: string; assertion?: Awaited<ReturnType<typeof assertion>>; sig?: string }

async function link(s: Spec, prev: { text: string; seq: number } | null, i: number): Promise<Link> {
  const seq = s.seq ?? (prev ? prev.seq + 1 : 0)
  const prevHash = s.prev !== undefined ? s.prev : prev ? await sha256b64u(prev.text) : null
  let ros = s.rosText ?? buildRos({ address: s.address ?? ADDRESS, seq, prev: prevHash,
    members: s.members.map(([kind, l, q]) => ({ kind, pub: l === 'OFF' ? OFF_CURVE : pubOf(l), quarantined: q === 'q' })),
    dirNonce: s.dirNonce ?? nonce(i), created: s.created ?? s.req })
  if (s.rawMembers !== undefined) { const p = ros.split('.'); p[4] = s.rawMembers; ros = p.join('.') }
  const rip = s.ripText ?? buildRip({ rosHash: await sha256b64u(s.ripOver ?? ros), requestedAt: s.req, ripenedAt: s.rip, reset: !!s.reset, kid: s.kid ?? 'dir-1' })
  let ripSig = await signStatement(K[s.ripBy ?? 'dir1'].key, rip)
  if (s.ripHighS) ripSig = highS(ripSig)
  const l: Link = { ros, rip, ripSig }
  if (s.signer) {
    l.signer = pubOf(s.signer)
    const kind = s.proof ?? (s.signer.startsWith('rk') ? 'sig' : 'assertion')
    if (kind === 'assertion' || kind === 'both') l.assertion = await assertion(s.assert?.by ?? s.signer, ros, s.assert)
    if (kind === 'sig' || kind === 'both') {
      l.sig = await signStatement(K[s.sigBy ?? s.signer].key, ros)
      if (s.sigHighS) l.sig = highS(l.sig)
    }
  } else if (s.proof === 'assertion') {
    l.assertion = await assertion('pk1', ros)
  }
  return l
}
async function chainOf(specs: Spec[], start: { text: string; seq: number } | null = null): Promise<Link[]> {
  const out: Link[] = []
  let prev = start
  for (let i = 0; i < specs.length; i++) {
    const l = await link(specs[i], prev, i)
    out.push(l)
    const seq = Number(l.ros.split('.')[2])
    prev = { text: l.ros, seq: Number.isSafeInteger(seq) ? seq : (prev ? prev.seq + 1 : 0) }
  }
  return out
}

// --- the base chain ------------------------------------------------------------------
//
//   L0  T              setup {pk1}
//   L1  T+1h → +73h    pk1 adds pk2
//   L2  T+80h → +152h  pk2 adds rk1
//   L3  T+160h → 232h  rk1 adds ck1                        (a recovery-key signature)
//   L4  T+240h → 240h  pk2 removes ITSELF, immediately      (pk1 remains)
//   L5  T+300h → 372h  reset to {pk3}                       (the directory alone)
//   L6  T+400h → 472h  pk3 adds pk4

const S0: Spec = { members: [['pk', 'pk1']], req: T, rip: T }
const S1: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2']], req: T + 1 * H, rip: T + 73 * H, signer: 'pk1' }
const S2: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 80 * H, rip: T + 152 * H, signer: 'pk2' }
const S3: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1'], ['ck', 'ck1']], req: T + 160 * H, rip: T + 232 * H, signer: 'rk1' }
const S4: Spec = { members: [['pk', 'pk1'], ['rk', 'rk1'], ['ck', 'ck1']], req: T + 240 * H, rip: T + 240 * H, signer: 'pk2' }
const S5: Spec = { members: [['pk', 'pk3']], req: T + 300 * H, rip: T + 372 * H, reset: true }
const S6: Spec = { members: [['pk', 'pk3'], ['pk', 'pk4']], req: T + 400 * H, rip: T + 472 * H, signer: 'pk3' }
const BASE = [S0, S1, S2, S3, S4, S5, S6]

type St = { seq: number; ripenedAt: number; members: Array<{ kind: MemberKind; key: string; quarantined: boolean; since: number }>; createdAt: number | null; lastResetAt: number | null; sinceExact: boolean }
type Row = { name: string; about: string; links: Link[]; pinned?: string; expect: 'accept' | 'reject'; reason?: string; state?: St }
const rows: Row[] = []
const accept = (name: string, about: string, links: Link[], state: St, pinned?: string) => rows.push({ name, about, links, ...(pinned ? { pinned } : {}), expect: 'accept', state })
const reject = (name: string, about: string, links: Link[], reason: string, pinned?: string) => rows.push({ name, about, links, ...(pinned ? { pinned } : {}), expect: 'reject', reason })
const mem = (kind: MemberKind, key: string, since: number, quarantined = false) => ({ kind, key, quarantined, since })
/** base links 0..n−1, then `last` built on them */
async function upTo(n: number, last?: Spec): Promise<Link[]> {
  const specs = BASE.slice(0, n)
  return chainOf(last ? [...specs, last] : specs)
}

// accepts -----------------------------------------------------------------------------
accept('ok/setup', 'the setup head alone: one passkey, countersigned at once', await upTo(1),
  { seq: 0, ripenedAt: T, members: [mem('pk', 'pk1', T)], createdAt: T, lastResetAt: null, sinceExact: true })
const full = await upTo(7)
accept('ok/full-chain', 'add a passkey, add a recovery key, the recovery key adds a consent key, a passkey removes itself at once, a reset, a passkey adds another',
  full, { seq: 6, ripenedAt: T + 472 * H, members: [mem('pk', 'pk3', T + 372 * H), mem('pk', 'pk4', T + 472 * H)], createdAt: T, lastResetAt: T + 372 * H, sinceExact: true })
accept('ok/before-reset', 'members keep the time they joined: pk1 since setup, rk1 and ck1 since their links',
  await upTo(5), { seq: 4, ripenedAt: T + 240 * H,
    members: [mem('ck', 'ck1', T + 232 * H), mem('pk', 'pk1', T), mem('rk', 'rk1', T + 152 * H)], createdAt: T, lastResetAt: null, sinceExact: true })
accept('ok/wait-exactly-72h', 'ripened exactly 72 hours after the request', await upTo(1, { ...S1, req: T + 1 * H, rip: T + 73 * H }),
  { seq: 1, ripenedAt: T + 73 * H, members: [mem('pk', 'pk1', T), mem('pk', 'pk2', T + 73 * H)], createdAt: T, lastResetAt: null, sinceExact: true })
accept('ok/requester-clock-late', "the requester's created is 1 h before ripening, but the DIRECTORY's requestedAt is 72 h before: accepted",
  await upTo(1, { ...S1, req: T + 1 * H, rip: T + 73 * H, created: T + 72 * H }),
  { seq: 1, ripenedAt: T + 73 * H, members: [mem('pk', 'pk1', T), mem('pk', 'pk2', T + 73 * H)], createdAt: T, lastResetAt: null, sinceExact: true })
accept('ok/rk-replaced', 'the recovery key replaced by a new one: one removal and one addition, both rk',
  await upTo(3, { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk2']], req: T + 160 * H, rip: T + 232 * H, signer: 'pk1' }),
  { seq: 3, ripenedAt: T + 232 * H, members: [mem('pk', 'pk1', T), mem('pk', 'pk2', T + 73 * H), mem('rk', 'rk2', T + 232 * H)], createdAt: T, lastResetAt: null, sinceExact: true })
accept('ok/remove-other-after-wait', 'pk1 removes pk2, after the wait',
  await upTo(2, { members: [['pk', 'pk1']], req: T + 80 * H, rip: T + 152 * H, signer: 'pk1' }),
  { seq: 2, ripenedAt: T + 152 * H, members: [mem('pk', 'pk1', T)], createdAt: T, lastResetAt: null, sinceExact: true })
accept('ok/rk-removes-itself-at-once', 'a recovery key may remove itself at once too',
  await upTo(3, { members: [['pk', 'pk1'], ['pk', 'pk2']], req: T + 160 * H, rip: T + 160 * H, signer: 'rk1' }),
  { seq: 3, ripenedAt: T + 160 * H, members: [mem('pk', 'pk1', T), mem('pk', 'pk2', T + 73 * H)], createdAt: T, lastResetAt: null, sinceExact: true })
accept('ok/pinned-midway', 'starting from a pinned head (L2): its members carry the pin time as a lower bound',
  full.slice(2, 5), { seq: 4, ripenedAt: T + 240 * H,
    members: [mem('ck', 'ck1', T + 232 * H), mem('pk', 'pk1', T + 152 * H), mem('rk', 'rk1', T + 152 * H)], createdAt: null, lastResetAt: null, sinceExact: false },
  await sha256b64u(full[2].ros))
accept('ok/pinned-setup', 'pinning the setup head keeps exact times',
  full.slice(0, 2), { seq: 1, ripenedAt: T + 73 * H, members: [mem('pk', 'pk1', T), mem('pk', 'pk2', T + 73 * H)], createdAt: T, lastResetAt: null, sinceExact: true },
  await sha256b64u(full[0].ros))
accept('ok/pinned-head-only', 'a chain of just the pinned head', full.slice(6, 7),
  { seq: 6, ripenedAt: T + 472 * H, members: [mem('pk', 'pk3', T + 472 * H), mem('pk', 'pk4', T + 472 * H)], createdAt: null, lastResetAt: null, sinceExact: false },
  await sha256b64u(full[6].ros))

// a pinned head that carries a QUARANTINED member (made by a directory path this
// module does not define yet), to exercise the quarantine rules from a pin
const Q0: Spec = { seq: 5, prev: await sha256b64u('an earlier head'), members: [['pk', 'pk1'], ['pk', 'pk2', 'q']], req: T + 300 * H, rip: T + 300 * H }
const qChain = async (next: Spec) => { const c = await chainOf([Q0, next]); return { links: c, pin: await sha256b64u(c[0].ros) } }
{
  const a = await qChain({ members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['pk', 'pk3']], req: T + 310 * H, rip: T + 382 * H, signer: 'pk1' })
  accept('ok/quarantine-carried', 'an unquarantined member adds a key; the quarantined one stays marked',
    a.links, { seq: 6, ripenedAt: T + 382 * H, members: [mem('pk', 'pk1', T + 300 * H), mem('pk', 'pk2', T + 300 * H, true), mem('pk', 'pk3', T + 382 * H)], createdAt: null, lastResetAt: null, sinceExact: false }, a.pin)
  const b = await qChain({ members: [['pk', 'pk1']], req: T + 310 * H, rip: T + 382 * H, signer: 'pk1' })
  accept('ok/quarantined-removed', 'the quarantined member removed after the wait',
    b.links, { seq: 6, ripenedAt: T + 382 * H, members: [mem('pk', 'pk1', T + 300 * H)], createdAt: null, lastResetAt: null, sinceExact: false }, b.pin)
  const c = await qChain({ members: [['pk', 'pk2', 'q']], req: T + 310 * H, rip: T + 382 * H, signer: 'pk1' })
  accept('ok/last-live-member-leaves-after-wait', 'the last unquarantined member removing itself is QUEUED: accepted after the wait',
    c.links, { seq: 6, ripenedAt: T + 382 * H, members: [mem('pk', 'pk2', T + 300 * H, true)], createdAt: null, lastResetAt: null, sinceExact: false }, c.pin)
  const d = await qChain({ members: [['pk', 'pk2', 'q']], req: T + 310 * H, rip: T + 310 * H, signer: 'pk1' })
  reject('wait/last-live-member-leaves-at-once', 'the last unquarantined member may not remove itself at once', d.links, 'unripe', d.pin)
  const e = await qChain({ members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['pk', 'pk3']], req: T + 310 * H, rip: T + 382 * H, signer: 'pk2' })
  reject('signer/quarantined', 'a quarantined member may not ask for a change', e.links, 'quarantined', e.pin)
  const f = await qChain({ members: [['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3']], req: T + 310 * H, rip: T + 382 * H, signer: 'pk1' })
  reject('quarantine/lifted', 'a member link may not lift a quarantine', f.links, 'quarantine', f.pin)
  const g = await qChain({ members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['pk', 'pk3', 'q']], req: T + 310 * H, rip: T + 382 * H, signer: 'pk1' })
  reject('quarantine/new-member-quarantined', 'a new member is never quarantined', g.links, 'quarantine', g.pin)
  const h = await qChain({ members: [['pk', 'pk2', 'q']], req: T + 310 * H, rip: T + 382 * H, signer: 'pk2' })
  reject('signer/quarantined-self-removal', 'a quarantined member may not even remove itself', h.links, 'quarantined', h.pin)
}
{
  const c = await upTo(2, { members: [['pk', 'pk1'], ['pk', 'pk2', 'q']], req: T + 80 * H, rip: T + 152 * H, signer: 'pk1' })
  reject('quarantine/added', 'a member link may not quarantine another member', c, 'quarantine')
}
{
  // 16 members at a pin, one removed: accepted; 17 at a pin: refused
  const sixteen: M[] = Array.from({ length: 16 }, (_, i) => ['pk', `m${i}`] as M)
  const c = await chainOf([{ seq: 9, prev: await sha256b64u('x'), members: sixteen, req: T, rip: T },
    { members: sixteen.slice(1), req: T + 1 * H, rip: T + 73 * H, signer: 'm1' }])
  const st = sixteen.slice(1).map(([, l]) => mem('pk', l, T)).sort((a, b) => (pubOf(a.key) < pubOf(b.key) ? -1 : 1))
  accept('ok/sixteen-members', 'a head may name 16 members', c, { seq: 10, ripenedAt: T + 73 * H, members: st, createdAt: null, lastResetAt: null, sinceExact: false }, await sha256b64u(c[0].ros))
  const c17 = await chainOf([{ seq: 9, prev: await sha256b64u('x'), members: Array.from({ length: 17 }, (_, i) => ['pk', `m${i}`] as M), req: T, rip: T }])
  reject('members/seventeen', 'a head may name at most 16 members', c17, 'members', await sha256b64u(c17[0].ros))
}

// the chain ---------------------------------------------------------------------------
reject('chain/empty', 'no links at all', [], 'grammar')
reject('chain/prev-hash-wrong', "L1's prevHash names some other text", await upTo(1, { ...S1, prev: await sha256b64u('not the setup head') }), 'chain')
{
  // another genuine setup head for the same address (a fork): L1 chains to it, not to the L0 given
  const fork = await chainOf([{ ...S0, dirNonce: nonce(40) }])
  const c = await upTo(1, { ...S1, prev: await sha256b64u(fork[0].ros) })
  reject('chain/wrong-prev', "L1 names a DIFFERENT genuine setup head as its previous", c, 'chain')
}
reject('chain/seq-skip', 'seq jumps from 0 to 2', await upTo(1, { ...S1, seq: 2 }), 'seq')
reject('chain/seq-repeat', 'seq repeats 0', await upTo(1, { ...S1, seq: 0, prev: null }), 'seq')
reject('chain/address-changed', 'a link names another address', await upTo(1, { ...S1, address: 'mallory@example.com' }), 'address')
reject('chain/no-anchor', 'without a pin, the chain must start at setup', full.slice(1, 3), 'anchor')
{
  // the pinned head's countersign sets every member's age, so it is re-checked: a
  // forged one (older ripenedAt) would make a consent key look ripe
  const c = await chainOf([{ ...S0, req: T - 500 * H, rip: T - 500 * H, ripBy: 'dirOther' }])
  reject('chain/pinned-countersign-forged', 'the pinned head arrives with a countersign the pinned directory key did not make', c, 'rip-signature', await sha256b64u(c[0].ros))
}
reject('chain/pin-mismatch', 'the first link is not the pinned head', full.slice(1, 3), 'pin', await sha256b64u(full[2].ros))
reject('chain/reset-replayed-elsewhere', 'L6 lifted onto the chain before the reset', [...full.slice(0, 5), full[6]], 'seq')
reject('order/requested-before-previous-ripened', 'L2 was requested before L1 ripened: one change at a time',
  await upTo(2, { ...S2, req: T + 70 * H, rip: T + 142 * H }), 'order')

// the wait ----------------------------------------------------------------------------
reject('wait/one-second-short', 'ripened 72 h minus one second after the request', await upTo(1, { ...S1, rip: T + 73 * H - 1000 }), 'unripe')
reject('wait/requester-clock-early', "the requester's created is 73 h before ripening but the directory's requestedAt only 1 h: refused (the wait is the directory's)",
  await upTo(1, { ...S1, req: T + 72 * H, rip: T + 73 * H, created: T }), 'unripe')
reject('wait/countersigned-at-request', 'a change countersigned the moment it was asked for (no ripening)', await upTo(1, { ...S1, req: T + 1 * H, rip: T + 1 * H }), 'unripe')
reject('wait/remove-other-at-once', 'only removing ITSELF is immediate: pk1 removing pk2 waits', await upTo(2, { members: [['pk', 'pk1']], req: T + 80 * H, rip: T + 80 * H, signer: 'pk1' }), 'unripe')
reject('wait/add-at-once', 'an addition is never immediate', await upTo(1, { ...S1, rip: T + 1 * H }), 'unripe')
reject('wait/reset-short', 'a reset waits 72 h too', await upTo(5, { ...S5, rip: T + 371 * H }), 'unripe')

// the countersign ---------------------------------------------------------------------
reject('rip/over-other-text', 'the rip. names the hash of a different head', await upTo(1, { ...S1, ripOver: 'ros.something.else' }), 'rip-mismatch')
reject('rip/unknown-kid', 'countersigned by a kid nobody pinned', await upTo(1, { ...S1, kid: 'dir-9', ripBy: 'dirOther' }), 'unknown-kid')
reject('rip/wrong-key', 'countersigned by another key under the pinned kid', await upTo(1, { ...S1, ripBy: 'dirOther' }), 'rip-signature')
reject('rip/high-s', 'the countersign in high-S form (directory statements are low-S only)', await upTo(1, { ...S1, ripHighS: true }), 'rip-signature')
reject('rip/ripened-before-requested', 'ripenedAt before requestedAt', await upTo(1, { ...S1, req: T + 73 * H, rip: T + 1 * H }), 'rip-grammar')
reject('rip/reset-flag-2', 'reset is 0 or 1', await upTo(1, { ...S1, ripText: 'rip.' + 'A'.repeat(43) + `.${T + H}.${T + 73 * H}.2.dir-1` }), 'rip-grammar')
reject('rip/missing', 'no countersign: a queued change is not in force', await upTo(1, { ...S1, ripText: '' }), 'rip-grammar')
reject('rip/future', 'ripened more than the skew allowance after now', await upTo(1, { ...S1, req: NOW, rip: NOW + 72 * H }), 'not-yet-valid')

// setup and reset ---------------------------------------------------------------------
reject('setup/reset-flag', 'a setup head countersigned as a reset', await chainOf([{ ...S0, reset: true }]), 'reset')
reject('setup/two-members', 'setup has exactly one member', await chainOf([{ ...S0, members: [['pk', 'pk1'], ['pk', 'pk2']] }]), 'setup-members')
reject('setup/consent-key', 'the setup member is a passkey', await chainOf([{ ...S0, members: [['ck', 'ck1']] }]), 'setup-members')
reject('setup/quarantined', 'the setup member is not quarantined', await chainOf([{ ...S0, members: [['pk', 'pk1', 'q']] }]), 'setup-members')
reject('setup/with-proof', 'setup carries no member proof (its authority is the countersign)', await chainOf([{ ...S0, signer: 'pk1' }]), 'proof')
reject('reset/with-proof', 'a reset carries no member proof', await upTo(5, { ...S5, signer: 'pk1' }), 'proof')
reject('reset/two-members', 'a reset installs exactly one passkey', await upTo(5, { ...S5, members: [['pk', 'pk3'], ['pk', 'pk4']] }), 'reset-members')
reject('reset/recovery-key', 'a reset installs a passkey, not a recovery key', await upTo(5, { ...S5, members: [['rk', 'rk2']] }), 'reset-members')

// the signer ----------------------------------------------------------------------------
reject('signer/missing', 'a member change with no signer', await upTo(1, { ...S1, signer: undefined }), 'proof')
reject('signer/missing-with-assertion', 'an assertion but no signer named', await upTo(1, { ...S1, signer: undefined, proof: 'assertion' }), 'proof')
reject('signer/not-a-member', 'pk3 is not in the previous roster', await upTo(1, { ...S1, members: [['pk', 'pk1'], ['pk', 'pk3']], signer: 'pk3' }), 'signer')
reject('signer/adds-itself', 'pk2 asks to add pk2: it is not a member of the PREVIOUS head', await upTo(1, { ...S1, signer: 'pk2' }), 'signer')
reject('signer/consent-key', 'a consent key signing alone (its purpose is not defined yet)',
  await upTo(4, { members: [['ck', 'ck1'], ['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3'], ['rk', 'rk1']], req: T + 240 * H, rip: T + 312 * H, signer: 'ck1', proof: 'sig' }), 'signer-kind')
reject('proof/passkey-raw-signature', 'a passkey must sign by assertion, not a raw signature', await upTo(1, { ...S1, proof: 'sig' }), 'proof')
reject('proof/passkey-both', 'one proof only', await upTo(1, { ...S1, proof: 'both' }), 'proof')
reject('proof/recovery-key-assertion', 'a recovery key signs raw, not by assertion', await upTo(3, { ...S3, proof: 'assertion' }), 'proof')
reject('proof/recovery-key-both', 'a recovery key with its signature AND an assertion: one proof only', await upTo(3, { ...S3, proof: 'both' }), 'proof')
reject('rk/wrong-signature', 'the recovery-key signature is by another key', await upTo(3, { ...S3, sigBy: 'rk2' }), 'signature')
reject('rk/high-s', 'the recovery-key signature in high-S form', await upTo(3, { ...S3, sigHighS: true }), 'signature')

// the passkey assertion (webauthn.ts, rp id.bento.page, origin the sign-in host) --------
reject('assertion/other-text', 'the assertion covers another statement', await upTo(1, { ...S1, assert: { over: 'ros.other' } }), 'assertion-challenge')
reject('assertion/origin-rp-host', 'asserted from https://id.bento.page (the directory host runs no ceremony)', await upTo(1, { ...S1, assert: { origin: 'https://id.bento.page' } }), 'assertion-origin')
reject('assertion/origin-library', 'asserted from https://home.bento.page', await upTo(1, { ...S1, assert: { origin: 'https://home.bento.page' } }), 'assertion-origin')
reject('assertion/origin-sibling', 'asserted from another host under the rp', await upTo(1, { ...S1, assert: { origin: 'https://x.id.bento.page' } }), 'assertion-origin')
reject('assertion/rp-parent', 'asserted for the parent rp bento.page', await upTo(1, { ...S1, assert: { rpId: 'bento.page' } }), 'assertion-rp')
reject('assertion/uv-clear', 'user verification flag clear', await upTo(1, { ...S1, assert: { flags: 0x01 } }), 'assertion-uv')
reject('assertion/other-key', 'the assertion is by pk3 while pk1 is named', await upTo(1, { ...S1, assert: { by: 'pk3' } }), 'assertion-signature')

// the members grammar ---------------------------------------------------------------------
{
  const tok = (k: string, l: string) => `${k}~${pubOf(l)}`
  const sorted = (...t: string[]) => t.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const [a, b] = sorted(tok('pk', 'pk1'), tok('pk', 'pk2'))
  reject('members/unsorted', 'the same roster with its members out of order', await upTo(1, { ...S1, rawMembers: `${b},${a}` }), 'members')
  reject('members/repeated-token', 'one member written twice', await upTo(1, { ...S1, rawMembers: `${a},${a}` }), 'members')
  const dup = sorted(tok('ck', 'pk2'), tok('pk', 'pk1'), tok('pk', 'pk2'))
  reject('members/duplicate-key', 'one key as two kinds', await upTo(1, { ...S1, rawMembers: dup.join(',') }), 'members')
  reject('members/two-recovery-keys', 'at most one recovery key', await upTo(1, { ...S1, members: [['pk', 'pk1'], ['rk', 'rk1'], ['rk', 'rk2']] }), 'members')
  reject('members/unknown-kind', 'kind is pk, ck or rk', await upTo(1, { ...S1, rawMembers: sorted(tok('pk', 'pk1'), tok('xk', 'pk2')).join(',') }), 'members')
  reject('members/bad-flag', 'the only flag is q', await upTo(1, { ...S1, rawMembers: sorted(tok('pk', 'pk1'), tok('pk', 'pk2') + '~x').join(',') }), 'members')
  reject('members/empty-item', 'an empty member', await upTo(1, { ...S1, rawMembers: `${a},` }), 'members')
  reject('members/off-curve', 'a member key not on the curve', await upTo(1, { ...S1, members: [['pk', 'pk1'], ['pk', 'OFF']] }), 'key')
  reject('members/kind-changed', 'a continuing member changes kind', await upTo(1, { ...S1, members: [['ck', 'pk1'], ['pk', 'pk2']] }), 'members')
}

// one change per link ------------------------------------------------------------------------
reject('change/none', 'a link that changes nothing', await upTo(1, { ...S1, members: [['pk', 'pk1']] }), 'no-change')
reject('change/two-additions', 'two members added in one link', await upTo(1, { ...S1, members: [['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3']] }), 'multi-change')
reject('change/two-removals', 'two members removed in one link',
  await upTo(3, { members: [['pk', 'pk1']], req: T + 160 * H, rip: T + 232 * H, signer: 'pk1' }), 'multi-change')
reject('change/passkey-swapped', 'a passkey removed and another added in one link (only the recovery key is replaced)',
  await upTo(2, { members: [['pk', 'pk1'], ['pk', 'pk3']], req: T + 80 * H, rip: T + 152 * H, signer: 'pk1' }), 'multi-change')

// the ros. grammar --------------------------------------------------------------------------
reject('grammar/nonce-short', 'the directory nonce is 16 to 64 bytes', await upTo(1, { ...S1, dirNonce: b64uEnc(new Uint8Array(15)) }), 'grammar')
reject('grammar/nonce-padded', 'the nonce is canonical base64url', await upTo(1, { ...S1, dirNonce: b64uEnc(new Uint8Array(32)) + '=' }), 'grammar')
reject('grammar/address-not-normal', 'the address is in normal form', await chainOf([{ ...S0, address: 'Alice@Example.com' }]), 'address')
reject('grammar/prev-on-setup', 'a setup head has no prevHash', await chainOf([{ ...S0, prev: await sha256b64u('x') }]), 'prev')
reject('grammar/created-zero', 'created is a positive time', await chainOf([{ ...S0, created: 0 }]), 'grammar')
{
  const c = await upTo(1)
  reject('grammar/extra-field', 'an extra field', await chainOf([{ ...S0, rosText: c[0].ros + '.x' }]), 'grammar')
  reject('grammar/wrong-prefix', 'another prefix', await chainOf([{ ...S0, rosText: 'ros2' + c[0].ros.slice(3) }]), 'grammar')
}

// ---------------------------------------------------------------------------------------------

const keys: Record<string, string> = {}
for (const l of LABELS) if (!l.startsWith('dir')) keys[l] = pubOf(l)
const out = {
  version: 1,
  about: 'Conformance rows for the bento/id option G roster chain (kernel/src/roster.ts): ros. heads, the directory\'s rip. countersign, and member proofs. Verify each row\'s links with verifyRosterChain(links, { directoryKeys, rpId, origins, now, pinned }) using the values below. Match the verdict; match the reason where you can; for accepted rows, match the state (member keys are labels in `keys`). TEST KEYS ONLY.',
  rpId: RP,
  origins: [...ROSTER_WEB_ORIGINS],
  now: NOW,
  waitMs: 72 * H,
  directoryKeys: DIRECTORY_KEYS,
  // signs rip/unknown-kid under kid dir-9; for a positive control only, never pinned
  unpinnedDirectoryKey: K.dirOther.pub,
  keys,
  rows,
}
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
console.log(`wrote ${OUT}: ${rows.length} rows (${rows.filter((r) => r.expect === 'accept').length} accept)`)
