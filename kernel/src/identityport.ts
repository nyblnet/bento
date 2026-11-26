// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/id over a MessagePort: the identity agent (identity.ts) for a document
// that runs in a host's sandboxed frame, where the HOST is the page that framed
// it (bento/home in a browser). The twin of docstoreport.ts, with the same
// reasons: the frame is an opaque origin, so a message's `origin` says nothing,
// and its WindowProxy survives the frame navigating itself. The capability is
// POSSESSION of the transferred port. Neither side posts to a window, and
// neither side reads `event.origin`.
//
// Everything in the frame belongs to the document once it is written, so every
// rule is enforced HERE, on the host's end:
//   - a closed op list (whoami, sign, resolve), an exact key set per op, symbol
//     keys and non-plain prototypes refused, request ids that only go up;
//   - anything else is DROPPED, not answered, and counted by reason; past a
//     limit of drops the host closes the session;
//   - the session is bound to the ENTRY the host minted for this open and the
//     docId it read from the file it verified. Nothing in a request can name
//     either; the host's agent receives them from here, never from the page;
//   - consent first: sign and resolve answer only after whoami returned an
//     identity in THIS session (before it, sign is 'declined' and resolve null,
//     without asking the agent). A whoami that answered null is final for the
//     session. invite and revoke are 'unavailable' in phase 1;
//   - every answer is type-checked on the way out: resolve answers go through
//     identity.ts checkResolved (the one type-checked relay), whoami answers
//     through checkPublic (a proof over PROOF_MAX_BYTES is dropped, counted),
//     sign answers through their own closed shape;
//   - caps on requests in flight and on the request rate; closing a session
//     closes the port.
//
// Wire, version 1 (structured clone; a message is a plain object):
//   request   {t:'bento-id', v:1, id, op:'whoami'}
//             {t:'bento-id', v:1, id, op:'sign', purpose, payload}
//             {t:'bento-id', v:1, id, op:'resolve', pub}
//             {t:'bento-id', v:1, id, op:'resolve', pub, proof}
//   response  {t:'bento-id', v:1, id, identity: PublicIdentity|null}     whoami
//             {t:'bento-id', v:1, id, result: SignResult}                sign
//             {t:'bento-id', v:1, id, identity: ResolvedIdentity|null}   resolve
// Every failure is an answer of the op's own kind (null, or a refusal); nothing
// throws across the port.
//
// The second half of this file is the PEER RESOLVER (security-ruling ID3,
// R1b): how an agent answers resolve({pub, proof}) offline, in one fixed order.

import {
  checkResolved, composeResolved, isVoucher, ACCOUNT_ANCHOR_RE, PROOF_MAX_BYTES,
  type IdentityProof, type PublicIdentity, type ResolvedIdentity, type SignPurpose, type SignResult,
} from './identity.ts'
import { payloadMatchesPurpose } from './statements.ts'
import { verifyRosterChain, accountAnchor, rosterChangedAt, MAX_CHAIN, type RosterLink, type RosterState } from './roster.ts'
import { verifyDevice, verifyInc, leverCovers, type DeviceProof, type Incident } from './devices.ts'
import type { PortLike } from './docstoreport.ts'

export const IDENTITY_T = 'bento-id'
export const IDENTITY_V = 1
const OPS = ['whoami', 'sign', 'resolve'] as const
type Op = typeof OPS[number]
const PURPOSES: readonly SignPurpose[] = ['frame', 'prove', 'delegate', 'show', 'invite', 'revoke']
/** Purposes no phase-1 agent signs: the owner key still lives in the file. */
const PHASE2_PURPOSES: readonly SignPurpose[] = ['invite', 'revoke']
const REFUSALS = ['declined', 'reauth', 'purpose', 'no-identity', 'unavailable'] as const

/** The longest payload a sign request carries: statements.ts's statement cap. */
export const SIGN_PAYLOAD_MAX = 4096
/** A raw P-256 point in base64url (65 bytes). */
const PUB_RE = /^[A-Za-z0-9_-]{87}$/

export interface IdentityLimits {
  maxInFlight: number
  rateWindowMs: number
  rateMax: number
  /** Dropped messages before the host closes the session. */
  maxDrops: number
}
export const IDENTITY_LIMITS: IdentityLimits = { maxInFlight: 16, rateWindowMs: 10_000, rateMax: 240, maxDrops: 64 }

export type IdentityRequest =
  | { id: number; op: 'whoami' }
  | { id: number; op: 'sign'; purpose: SignPurpose; payload: string }
  | { id: number; op: 'resolve'; pub: string; proof?: IdentityProof | 'cap' }

export type IdentityDropReason = 'shape' | 'version' | 'keys' | 'id' | 'op' | 'purpose' | 'payload' | 'pub' | 'proof' | 'rate' | 'in-flight'

const KEYS: Record<Op, readonly string[]> = {
  whoami: ['id,op,t,v'],
  sign: ['id,op,payload,purpose,t,v'],
  resolve: ['id,op,pub,t,v', 'id,op,proof,pub,t,v'],
}

const isPlain = (m: unknown): m is Record<string, unknown> => {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return false
  const p = Object.getPrototypeOf(m)
  return p === Object.prototype || p === null
}
/** A plain object whose own string keys are exactly `required` plus any of `optional`, no symbols. */
function exact(m: unknown, required: readonly string[], optional: readonly string[] = []): m is Record<string, unknown> {
  if (!isPlain(m) || Object.getOwnPropertySymbols(m).length) return false
  const keys = Object.keys(m)
  for (const k of required) if (!Object.hasOwn(m, k)) return false
  for (const k of keys) if (!required.includes(k) && !optional.includes(k)) return false
  // own data properties only: structured clone makes these, a getter is not one
  for (const k of keys) { const d = Object.getOwnPropertyDescriptor(m, k); if (!d || !('value' in d)) return false }
  return true
}

// --- the proof's shape ---------------------------------------------------------------

const ASSERTION_KEYS = ['authenticatorData', 'clientDataJSON', 'signature'] as const
const LINK_REQUIRED = ['ros', 'rip', 'ripSig'] as const
const LINK_OPTIONAL = ['signer', 'assertion', 'sig', 'cns', 'cosign', 'voided', 'cited'] as const

/**
 * Judge a proof's SHAPE and SIZE: the IdentityProof (plain objects with exact
 * key sets, strings at every leaf, a chain of 1..MAX_CHAIN links), 'cap' when it
 * is over PROOF_MAX_BYTES as UTF-8 JSON, or null when it is not a proof at all.
 * Signatures are not checked here (resolveProof does that).
 */
export function parseProof(p: unknown): IdentityProof | 'cap' | null {
  try {
    let total = 0
    let over = false
    const s = (v: unknown): boolean => {
      if (typeof v !== 'string') return false
      total += v.length
      if (total > PROOF_MAX_BYTES) over = true
      return true
    }
    const assertion = (a: unknown) => exact(a, ASSERTION_KEYS) && ASSERTION_KEYS.every((k) => s(a[k]))
    if (!exact(p, ['chain', 'device'])) return null
    const d = p.device
    if (!exact(d, ['cert', 'signer', 'watt', 'wattSig'], ['assertion', 'consent'])) return null
    if (![d.cert, d.signer, d.watt, d.wattSig].every(s)) return null
    if (d.assertion !== undefined && !assertion(d.assertion)) return null
    if (d.consent !== undefined && !(exact(d.consent, ['cns', 'sig']) && s(d.consent.cns) && s(d.consent.sig))) return null
    const c = p.chain
    if (!Array.isArray(c) || Object.getPrototypeOf(c) !== Array.prototype || c.length === 0 || c.length > MAX_CHAIN) return null
    if (Object.getOwnPropertySymbols(c).length) return null
    for (const l of c) {
      if (over) return 'cap'
      if (!exact(l, LINK_REQUIRED, LINK_OPTIONAL)) return null
      if (![l.ros, l.rip, l.ripSig].every(s)) return null
      if (l.signer !== undefined && !s(l.signer)) return null
      if (l.sig !== undefined && !s(l.sig)) return null
      if (l.cns !== undefined && !s(l.cns)) return null
      if (l.assertion !== undefined && !assertion(l.assertion)) return null
      if (l.cosign !== undefined && !(exact(l.cosign, ['signer', 'cns', 'sig']) && s(l.cosign.signer) && s(l.cosign.cns) && s(l.cosign.sig))) return null
      if (l.voided !== undefined) {
        const v = l.voided
        if (!exact(v, ['ros', 'signer'], ['assertion', 'sig', 'cns']) || !s(v.ros) || !s(v.signer)) return null
        if (v.assertion !== undefined && !assertion(v.assertion)) return null
        if (v.sig !== undefined && !s(v.sig)) return null
        if (v.cns !== undefined && !s(v.cns)) return null
      }
      if (l.cited !== undefined && !(exact(l.cited, ['prevRos', 'ros', 'rip', 'ripSig']) &&
        s(l.cited.prevRos) && s(l.cited.ros) && s(l.cited.rip) && s(l.cited.ripSig))) return null
    }
    // the running total is a lower bound on the JSON's UTF-8 size; under the cap the exact size is cheap to take
    if (over || new TextEncoder().encode(JSON.stringify(p)).length > PROOF_MAX_BYTES) return 'cap'
    return p as unknown as IdentityProof
  } catch {
    return null
  }
}

/**
 * One message from the port, judged against the schema: the request, or why it
 * is dropped. `lastId` is the highest id this session has accepted.
 */
export function parseIdentityRequest(m: unknown, lastId: number): IdentityRequest | IdentityDropReason {
  if (!isPlain(m) || m.t !== IDENTITY_T) return 'shape'
  if (m.v !== IDENTITY_V) return 'version'
  const op = m.op
  if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) return 'op'
  if (Object.getOwnPropertySymbols(m).length || !KEYS[op as Op].includes(Object.keys(m).sort().join(','))) return 'keys'
  const id = m.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= lastId) return 'id'
  if (op === 'whoami') return { id, op }
  if (op === 'sign') {
    if (typeof m.purpose !== 'string' || !(PURPOSES as readonly string[]).includes(m.purpose)) return 'purpose'
    if (typeof m.payload !== 'string' || m.payload.length > SIGN_PAYLOAD_MAX) return 'payload'
    return { id, op, purpose: m.purpose as SignPurpose, payload: m.payload }
  }
  if (typeof m.pub !== 'string' || !PUB_RE.test(m.pub)) return 'pub'
  if (!Object.hasOwn(m, 'proof')) return { id, op: 'resolve', pub: m.pub }
  const proof = parseProof(m.proof)
  if (proof === null) return 'proof'
  return { id, op: 'resolve', pub: m.pub, proof }
}

/** A whoami answer, type-checked: the five fields, and the proof only when it
 *  parses and is under the cap. `capped` says the proof was dropped for size. */
export function checkPublic(r: unknown): { identity: PublicIdentity | null; capped: boolean } {
  try {
    if (!isPlain(r)) return { identity: null, capped: false }
    const get = (k: string) => { const d = Object.getOwnPropertyDescriptor(r, k); return d && 'value' in d ? d.value : undefined }
    const name = get('name'), email = get('email'), vouchedBy = get('vouchedBy'), accountPub = get('accountPub'), devicePub = get('devicePub')
    if (typeof name !== 'string' || name === '' || name.length > 320 || typeof email !== 'string' || email.length > 320 ||
      !isVoucher(vouchedBy) || typeof accountPub !== 'string' || accountPub === '' || accountPub.length > 200 ||
      typeof devicePub !== 'string' || !PUB_RE.test(devicePub)) return { identity: null, capped: false }
    const identity: PublicIdentity = { name, email, vouchedBy, accountPub, devicePub }
    const raw = get('proof')
    if (raw === undefined) return { identity, capped: false }
    const p = parseProof(raw)
    if (p !== null && p !== 'cap') identity.proof = p
    return { identity, capped: p === 'cap' }
  } catch {
    return { identity: null, capped: false }
  }
}

/** A sign answer, type-checked: the result, or null when it is malformed. */
export function checkSign(r: unknown): SignResult | null {
  try {
    if (isPlain(r) && r.ok === true && typeof r.sig === 'string' && /^[A-Za-z0-9_-]{86}$/.test(r.sig) &&
      typeof r.pub === 'string' && PUB_RE.test(r.pub)) return { ok: true, sig: r.sig, pub: r.pub }
    if (isPlain(r) && r.ok === false && typeof r.reason === 'string' && (REFUSALS as readonly string[]).includes(r.reason))
      return { ok: false, reason: r.reason as typeof REFUSALS[number] }
  } catch { /* fall through */ }
  return null
}

// ---------------------------------------------------------------- host side

/** Who is asking, as the HOST knows it: never from a request. */
export interface IdentityContext { entry: string; docId: string | null }

/** The host's agent, behind the port. Its answers are checked again here. */
export interface IdentityHost {
  whoami(ctx: IdentityContext): Promise<unknown>
  sign(ctx: IdentityContext, purpose: SignPurpose, payload: string): Promise<unknown>
  resolve(ctx: IdentityContext, query: { pub: string; proof?: IdentityProof }): Promise<unknown>
}

export interface IdentityStats {
  served: number
  dropped: number
  byReason: Partial<Record<IdentityDropReason, number>>
  /** answers given without asking the agent, by why */
  gated: Partial<Record<'before-consent' | 'declined-final' | 'phase-2' | 'purpose' | 'proof-cap' | 'no-proof', number>>
  /** answers the agent gave that failed their type check */
  malformed: number
  /** whoami answers whose proof was dropped for size */
  proofCapped: number
}
export interface IdentitySession {
  readonly stats: IdentityStats
  readonly closed: boolean
  close(): void
}

export interface ServeIdentityOptions {
  /** The entry the host minted for this open. Never derived from the document. */
  entry: string
  /** The docId the host read from the file it verified, or null. */
  docId: string | null
  agent: IdentityHost
  limits?: Partial<IdentityLimits>
  now?: () => number
  onEvent?: (e: { kind: 'served' | 'dropped' | 'gated' | 'malformed' | 'closed'; reason?: string }) => void
}

/** Answer one frame's identity requests on its port, bound to one entry and docId. */
export function serveIdentity(port: PortLike, o: ServeIdentityOptions): IdentitySession {
  if (typeof o.entry !== 'string' || !o.entry) throw new Error('serveIdentity: a host-minted entry is required')
  if (!o.agent || typeof o.agent.whoami !== 'function' || typeof o.agent.sign !== 'function' || typeof o.agent.resolve !== 'function')
    throw new Error('serveIdentity: an agent is required')
  const L: IdentityLimits = { ...IDENTITY_LIMITS, ...o.limits }
  const now = o.now ?? Date.now
  const ctx: IdentityContext = Object.freeze({
    entry: o.entry,
    docId: typeof o.docId === 'string' && o.docId.length > 0 && o.docId.length <= 200 ? o.docId : null,
  })
  const agent = o.agent
  const stats: IdentityStats = { served: 0, dropped: 0, byReason: {}, gated: {}, malformed: 0, proofCapped: 0 }
  let closed = false
  let lastId = 0
  let inFlight = 0
  let windowStart = now()
  let inWindow = 0
  /** whoami returned an identity in this session */
  let consented = false
  /** whoami returned null in this session: final */
  let declined = false
  let chain: Promise<void> = Promise.resolve()

  const send = (m: Record<string, unknown>) => { if (!closed) port.postMessage({ t: IDENTITY_T, v: IDENTITY_V, ...m }) }
  const drop = (reason: IdentityDropReason) => {
    stats.dropped++
    stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1
    o.onEvent?.({ kind: 'dropped', reason })
    if (stats.dropped >= L.maxDrops) session.close()
  }
  const gate = (why: keyof IdentityStats['gated']) => { stats.gated[why] = (stats.gated[why] ?? 0) + 1; o.onEvent?.({ kind: 'gated', reason: why }) }
  const served = (m: Record<string, unknown>) => { stats.served++; o.onEvent?.({ kind: 'served' }); send(m) }
  const bad = () => { stats.malformed++; o.onEvent?.({ kind: 'malformed' }) }

  const handle = async (r: IdentityRequest): Promise<void> => {
    if (r.op === 'whoami') {
      if (declined) { gate('declined-final'); return served({ id: r.id, identity: null }) }
      let a: unknown
      try { a = await agent.whoami(ctx) } catch { a = null }
      const c = a === null ? { identity: null, capped: false } : checkPublic(a)
      if (a !== null && c.identity === null) bad()
      if (c.capped) { stats.proofCapped++; gate('proof-cap') }
      if (c.identity) consented = true
      else declined = true
      return served({ id: r.id, identity: c.identity })
    }
    if (r.op === 'sign') {
      if (!consented) { gate('before-consent'); return served({ id: r.id, result: { ok: false, reason: 'declined' } }) }
      if (PHASE2_PURPOSES.includes(r.purpose)) { gate('phase-2'); return served({ id: r.id, result: { ok: false, reason: 'unavailable' } }) }
      if (!payloadMatchesPurpose(r.purpose, r.payload)) { gate('purpose'); return served({ id: r.id, result: { ok: false, reason: 'purpose' } }) }
      let a: unknown
      try { a = await agent.sign(ctx, r.purpose, r.payload) } catch { a = { ok: false, reason: 'unavailable' } }
      const res = checkSign(a)
      if (res === null) bad()
      return served({ id: r.id, result: res ?? { ok: false, reason: 'unavailable' } })
    }
    // resolve
    if (!consented) { gate('before-consent'); return served({ id: r.id, identity: null }) }
    if (r.proof === 'cap') { gate('proof-cap'); return served({ id: r.id, identity: null }) }
    let a: unknown
    try { a = await agent.resolve(ctx, r.proof === undefined ? { pub: r.pub } : { pub: r.pub, proof: r.proof }) } catch { a = null }
    const res = a === null ? null : checkResolved(a)
    if (a !== null && res === null) bad()
    return served({ id: r.id, identity: res })
  }

  const onMessage = (e: MessageEvent) => {
    if (closed) return
    const t = now()
    if (t - windowStart >= L.rateWindowMs) { windowStart = t; inWindow = 0 }
    if (++inWindow > L.rateMax) return drop('rate')
    const r = parseIdentityRequest(e.data, lastId)
    if (typeof r === 'string') return drop(r)
    if (inFlight >= L.maxInFlight) return drop('in-flight')
    lastId = r.id
    inFlight++
    // one at a time, in arrival order: a sign after whoami sees its consent
    chain = chain.then(() => (closed ? undefined : handle(r))).catch(() => undefined).finally(() => { inFlight-- })
  }

  const session: IdentitySession = {
    stats,
    get closed() { return closed },
    close() {
      if (closed) return
      closed = true
      port.removeEventListener('message', onMessage)
      try { port.close?.() } catch { /* already gone */ }
      o.onEvent?.({ kind: 'closed' })
    },
  }
  port.addEventListener('message', onMessage)
  port.start?.()
  return session
}

// ---------------------------------------------------------------- the peer resolver

/** A record the host holds, as the directory signed it. */
export interface SignedRecord { text: string; sig: string }

export interface ResolverOptions {
  /** the PINNED directory keys by kid: the only keys any check uses */
  directoryKeys: Readonly<Record<string, string>>
  /** the passkeys' rp id and the closed origin list (roster.ts) */
  rpId: string
  origins: readonly string[]
  /** the rp a consent key's cns. names; needed only for ck-signed links */
  consentRp?: string
  now: () => number
  /** the directory's incident records the agent holds (verified here, under the pinned kids) */
  incidents?: () => readonly SignedRecord[]
  /** the agent's OWN account: its anchor and its standing (wout., rdel.), as
   *  the agent verified them. Applied only to answers for that anchor (A7). */
  own?: () => { anchor: string; revoked: false | 'signout' | 'deleted' } | null
}

export type ResolveMiss = 'no-proof' | 'proof' | 'cap' | 'chain' | 'anchor' | 'fork' | 'device' | 'pub' | 'compose' | 'error'

export interface ProofResolver {
  /** resolve({pub, proof}) for this open: an answer, or null. Never throws. */
  resolve(query: unknown): Promise<ResolvedIdentity | null>
  readonly stats: { answered: number; nulls: Partial<Record<ResolveMiss, number>>; forks: number }
}

type Best = { hashes: string[]; state: RosterState; links: RosterLink[]; forked: boolean }

/**
 * The peer resolver for ONE OPEN (security-ruling ID3, R1b, A3, A5-A7). State
 * lives as long as the object: make one per open, never share one between
 * documents (cross-document state is refused, R3). The order is fixed:
 *   1. the chain, FROM SEQ 0, under the pinned keys only (verifyRosterChain
 *      with no pin), and its anchor;
 *   2. the LONGEST verified chain this open holds for that anchor: a shorter
 *      one is judged against the longer, so a removal or quarantine any proof
 *      in the room carries reaches every device of that account; two chains
 *      where neither is a prefix of the other are a FORK, and every later
 *      answer for that anchor is null (counted);
 *   3. the device certificate against that chain (verifyDevice: pinned kid,
 *      the head rule, a current watt.), and cert.devicePub === the queried pub;
 *   4. the lever's predicate (devices.ts leverCovers) under each incident
 *      record verifyInc accepts;
 *   5. own-account status, ONLY for the agent's own anchor;
 *   6. composeResolved.
 * Every failure is null. It makes no network request: a peer's sign-out or
 * deletion reaches it as watt. expiry, within 24 h (R1c).
 */
export function createProofResolver(o: ResolverOptions): ProofResolver {
  const best = new Map<string, Best>()
  const seenPub = new Map<string, { firstSeen: number; anchor: string }>()
  const seenAddress = new Map<string, string>()
  const stats = { answered: 0, nulls: {} as Partial<Record<ResolveMiss, number>>, forks: 0 }
  const miss = (why: ResolveMiss): null => { stats.nulls[why] = (stats.nulls[why] ?? 0) + 1; return null }

  const run = async (q: unknown): Promise<ResolvedIdentity | null> => {
    if (!isPlain(q) || typeof q.pub !== 'string' || !PUB_RE.test(q.pub)) return miss('proof')
    if (q.proof === undefined) return miss('no-proof')
    const proof = parseProof(q.proof)
    if (proof === null) return miss('proof')
    if (proof === 'cap') return miss('cap')
    const pub = q.pub
    const now = o.now()
    const common = { directoryKeys: o.directoryKeys, rpId: o.rpId, origins: o.origins, now, ...(o.consentRp ? { consentRp: o.consentRp } : {}) }

    // 1. the chain from seq 0, pinned keys only
    const ch = await verifyRosterChain(proof.chain, common)
    if (!ch.ok) return miss('chain')
    const anchor = accountAnchor(ch.value)
    if (anchor === null || !ACCOUNT_ANCHOR_RE.test(anchor)) return miss('anchor')

    // 2. the longest chain for this anchor in this open; a fork poisons the anchor
    const hashes = ch.value.heads.map((h) => h.hash)
    let b = best.get(anchor)
    if (b?.forked) return miss('fork')
    if (!b) best.set(anchor, b = { hashes, state: ch.value, links: proof.chain, forked: false })
    else {
      const prefix = (a: string[], c: string[]) => a.length <= c.length && a.every((h, i) => h === c[i])
      if (prefix(b.hashes, hashes)) { if (hashes.length > b.hashes.length) Object.assign(b, { hashes, state: ch.value, links: proof.chain }) }
      else if (!prefix(hashes, b.hashes)) { b.forked = true; stats.forks++; return miss('fork') }
    }

    // 3. the device, against that chain, for exactly this pub
    const dv = await verifyDevice(proof.device as DeviceProof, { ...common, roster: b.state })
    if (!dv.ok) return miss('device')
    if (dv.value.cert.devicePub !== pub) return miss('pub')

    // 4. the lever's predicate, under records signed by pinned kids
    let revoked: false | 'signout' | 'incident' | 'deleted' = false
    for (const rec of o.incidents?.() ?? []) {
      if (!rec || typeof rec.text !== 'string' || typeof rec.sig !== 'string') continue
      const inc = await verifyInc(rec.text, rec.sig, { directoryKeys: o.directoryKeys, now })
      if (inc.ok && leverCovers(dv.value.cert, dv.value.watt, inc.value as Incident)) { revoked = 'incident'; break }
    }

    // 5. own-account status, own anchor only
    const mine = o.own?.() ?? null
    if (mine && mine.anchor === anchor && mine.revoked !== false && revoked === false) revoked = mine.revoked

    // trust on first use, for this open only
    const address = b.state.address
    const prevPub = seenPub.get(pub)
    const prevAddr = seenAddress.get(address)
    const changed = (prevPub !== undefined && prevPub.anchor !== anchor) || (prevAddr !== undefined && prevAddr !== anchor)
    const firstSeen = prevPub?.firstSeen ?? now
    if (!prevPub) seenPub.set(pub, { firstSeen, anchor })
    if (prevAddr === undefined) seenAddress.set(address, anchor)

    // 6. compose
    const out = composeResolved({
      address, anchor, tier: dv.value.tier, accountSince: b.state.createdAt,
      rosterChangedAt: rosterChangedAt(b.links, b.state), resetAt: b.state.lastResetAt,
      revoked, mb: dv.value.watt.mb, firstSeen, changed,
    })
    if (!out) return miss('compose')
    stats.answered++
    return out
  }

  return {
    stats,
    async resolve(q: unknown) {
      try { return await run(q) } catch { return miss('error') }
    },
  }
}
