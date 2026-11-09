// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The builders behind the bento/id option G fixtures: deterministic test keys,
// a software passkey authenticator, and the roster link builder. Shared by
// scripts/gen-roster-vectors.ts (roster-v2.json) and
// scripts/gen-device-vectors.ts (device-v1.json), so both fixtures name the
// same keys and the same chains.

import { b64uEnc, sha256b64u, signStatement } from '../../kernel/src/statements.ts'
import { publicKeyOf } from '../../kernel/src/recovery.ts'
import { buildRos, buildRip, ROSTER_RP_ID, ROSTER_WEB_ORIGINS, type MemberKind, type Authority } from '../../kernel/src/roster.ts'

export const te = new TextEncoder()
export const sha = async (b: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest('SHA-256', (typeof b === 'string' ? te.encode(b) : b) as BufferSource))
export const unb = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

// --- keys ------------------------------------------------------------------------

export type Key = { pub: string; key: CryptoKey }
export async function ecdsa(label: string): Promise<Key> {
  const d = await sha(`bento/id/roster/v1/test/${label}`)
  const pub = publicKeyOf(d)
  if (!pub) throw new Error(`scalar ${label} out of range`)
  const raw = unb(pub)
  const jwk = { kty: 'EC', crv: 'P-256', d: b64uEnc(d), x: b64uEnc(raw.slice(1, 33)), y: b64uEnc(raw.slice(33)), ext: true }
  return { pub, key: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) }
}
export const LABELS = ['pk1', 'pk2', 'pk3', 'pk4', 'ck1', 'ck2', 'rk1', 'rk2', 'dir1', 'dir2', 'dirOther',
  ...Array.from({ length: 17 }, (_, i) => `m${i}`)]
export const K: Record<string, Key> = {}
for (const l of LABELS) K[l] = await ecdsa(l)
export const pubOf = (l: string) => K[l].pub
// a point off the curve: the last byte of a real one, changed
export const OFF_CURVE = (() => { const r = unb(K.pk4.pub); r[64] ^= 1; return b64uEnc(r) })()

export const DIRECTORY_KEYS = { 'dir-1': K.dir1.pub, 'dir-2': K.dir2.pub }
export const RP = ROSTER_RP_ID
export const ORIGIN = ROSTER_WEB_ORIGINS[0]

// --- the software authenticator -----------------------------------------------

export const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
export const big = (u: Uint8Array) => BigInt('0x' + (Buffer.from(u).toString('hex') || '0'))
export const be32 = (x: bigint) => Uint8Array.from(Buffer.from(x.toString(16).padStart(64, '0'), 'hex'))
export const minInt = (v: Uint8Array) => { let i = 0; while (i < v.length - 1 && v[i] === 0) i++; v = v.slice(i); return v[0] & 0x80 ? Uint8Array.from([0, ...v]) : v }
export function rawToDer(raw: Uint8Array): Uint8Array {
  const r = minInt(raw.slice(0, 32)), s = minInt(raw.slice(32))
  const body = [0x02, r.length, ...r, 0x02, s.length, ...s]
  return Uint8Array.from([0x30, body.length, ...body])
}
export type AssertOpts = { rpId?: string; origin?: string; flags?: number; over?: string; count?: number }
export async function assertion(label: string, text: string, o: AssertOpts = {}) {
  const ad = new Uint8Array(37)
  ad.set(await sha(o.rpId ?? RP))
  ad[32] = o.flags ?? 0x05                                  // UP | UV
  if (o.count) { const c = o.count; ad[33] = (c >>> 24) & 255; ad[34] = (c >>> 16) & 255; ad[35] = (c >>> 8) & 255; ad[36] = c & 255 }
  const cdj = te.encode(JSON.stringify({ type: 'webauthn.get', challenge: b64uEnc(await sha(o.over ?? text)), origin: o.origin ?? ORIGIN, crossOrigin: false }))
  const signed = new Uint8Array(37 + 32)
  signed.set(ad); signed.set(await sha(cdj), 37)
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, K[label].key, signed as BufferSource))
  return { authenticatorData: b64uEnc(ad), clientDataJSON: b64uEnc(cdj), signature: b64uEnc(rawToDer(raw)) }
}
/** the high-S twin of a low-S raw signature (verifies under WebCrypto, refused by bento's rule) */
export const highS = (sig: string) => { const r = unb(sig); return b64uEnc(Uint8Array.from([...r.slice(0, 32), ...be32(N - big(r.slice(32)))])) }

// --- link builder -----------------------------------------------------------------

export const ADDRESS = 'alice@example.com'
export const H = 3_600_000
export const T = 1_800_000_000_000
export const NOW = T + 2000 * H
export const nonce = (i: number) => b64uEnc(new Uint8Array(32).fill(i + 1))

export type M = [MemberKind, string] | [MemberKind, string, 'q']
export interface Spec {
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
  // the authority word (default m, or r with reset) and its cause ('prev' = sha256 of the previous head)
  auth?: Authority; cause?: string | 'prev' | null
  // auth q: the request the void cancelled, built against the previous head unless prev is given
  voided?: { members: M[]; signer: string; proof?: 'assertion' | 'sig'; assert?: AssertOpts & { by?: string }; prev?: string | null; address?: string; seq?: number }
  // auth l: the cited ripened change, as built links
  cited?: { prevRos: string; ros: string; rip: string; ripSig: string }
}
export type Assn = Awaited<ReturnType<typeof assertion>>
export type Link = { ros: string; rip: string; ripSig: string; signer?: string; assertion?: Assn; sig?: string
  voided?: { ros: string; signer: string; assertion?: Assn; sig?: string }; cited?: { prevRos: string; ros: string; rip: string; ripSig: string } }

export async function link(s: Spec, prev: { text: string; seq: number } | null, i: number): Promise<Link> {
  const seq = s.seq ?? (prev ? prev.seq + 1 : 0)
  const prevHash = s.prev !== undefined ? s.prev : prev ? await sha256b64u(prev.text) : null
  let ros = s.rosText ?? buildRos({ address: s.address ?? ADDRESS, seq, prev: prevHash,
    members: s.members.map(([kind, l, q]) => ({ kind, pub: l === 'OFF' ? OFF_CURVE : pubOf(l), quarantined: q === 'q' })),
    dirNonce: s.dirNonce ?? nonce(i), created: s.created ?? s.req })
  if (s.rawMembers !== undefined) { const p = ros.split('.'); p[4] = s.rawMembers; ros = p.join('.') }
  let voided: Link['voided']
  if (s.voided) {
    const v = s.voided
    const vros = buildRos({ address: v.address ?? s.address ?? ADDRESS, seq: v.seq ?? seq, prev: v.prev !== undefined ? v.prev : prevHash,
      members: v.members.map(([kind, l, q]) => ({ kind, pub: pubOf(l), quarantined: q === 'q' })), dirNonce: nonce(i + 50), created: s.req })
    voided = { ros: vros, signer: pubOf(v.signer) }
    if ((v.proof ?? (v.signer.startsWith('pk') ? 'assertion' : 'sig')) === 'assertion') voided.assertion = await assertion(v.assert?.by ?? v.signer, vros, v.assert)
    else voided.sig = await signStatement(K[v.signer].key, vros)
  }
  const auth: Authority = s.auth ?? (s.reset ? 'r' : 'm')
  const cause = s.cause === 'prev' ? prevHash
    : s.cause !== undefined ? s.cause
    : auth === 'q' && voided ? await sha256b64u(voided.ros)
    : auth === 'l' && s.cited ? await sha256b64u(s.cited.ros)
    : (auth === 'x' || auth === 'u') ? prevHash : null
  const rip = s.ripText ?? buildRip({ rosHash: await sha256b64u(s.ripOver ?? ros), requestedAt: s.req, ripenedAt: s.rip, auth, cause, kid: s.kid ?? 'dir-1' })
  let ripSig = await signStatement(K[s.ripBy ?? 'dir1'].key, rip)
  if (s.ripHighS) ripSig = highS(ripSig)
  const l: Link = { ros, rip, ripSig }
  if (voided) l.voided = voided
  if (s.cited) l.cited = s.cited
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
export async function chainOf(specs: Spec[], start: { text: string; seq: number } | null = null): Promise<Link[]> {
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

