// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A person's bento/id identity in presence (ID3, K-ID3b). The identity agent
// (identity.ts) hands this copy its own IdentityProof once the person agreed,
// in this open, to use their identity here (whoami answered). The session then
// carries it to the room so another person's agent can resolve them OFFLINE
// (identityport.ts createProofResolver): no lookup route, nothing from the
// network.
//
// Four optional fields on hello and presence frames, beside the frame's `kp`
// and never inside `p` (the peer record an app reads is `p`):
//   idk  the identity device key the sender names (raw P-256, base64url): the
//        `devicePub` whoami returned, the key the proof certifies
//   idh  base64url(sha256(UTF-8 JSON of the proof)): every beat carries it
//   idp  the proof itself: on hello, on the first beat after it changes, and
//        in answer to an ask; never on an ordinary beat
//   ik   {t, g}: possession of idk in THIS room, by THIS actor, for THIS proof.
//        `g` is the agent's signature with idk, purpose 'prove', over
//
//          prove.<nonce>.<roomId>
//          nonce = base64url(first 16 bytes of
//                  sha256("idpres.v1.<roomId>.<actor>.<idk>.<idh>.<t>"))
//
//        The agent's sign purpose 'prove' is the one routine possession
//        statement there is (statements.ts payloadMatchesPurpose), and the
//        receiver recomputes the nonce from what it already knows. The relay's
//        own `prove.<nonce>.<room>` challenge uses a nonce the RELAY draws at
//        random per socket, so a presence signature can never answer it.
// and one new frame, {t:'idq', a, to, h}: `a` asks `to` for the proof whose
// hash is `h`. Older clients ignore all of it.
//
// THE PROOF RULE (security-ruling ID3, A4). A proof is public certificates, so
// anyone in the room can copy one and name its key. A peer's identity is
// handed to the app (SyncSession.peerIdentity / resolvePeer) ONLY while:
//   - that actor is present,
//   - its latest beat named idk with an `ik` that verifies under idk for this
//     room, this actor and this idh, within PROOF_SKEW_MS of this clock and
//     not older than the last accepted one (a beat without one, or with a bad
//     one, leaves the actor unproven until a later beat proves it afresh),
//   - and this session holds a proof whose OWN hash is that idh.
// The resolver then binds the proof to idk (cert.devicePub === pub), so a
// proof presented with another key resolves to null.
//
// REPLAY BOUND, stated. An ik names its actor, so it never proves another
// actor. Actor ids are self-declared, though, so anyone in the room (readers
// included) can re-send a beat it saw UNDER THE SAME ACTOR:
//   - an ik this session never accepted is good until PROOF_SKEW_MS (90 s)
//     past its own t, like the presence key proof;
//   - an ik this session already accepted is taken again only within
//     ID_RESEND_WINDOW_MS (45 s) of first accepting it, on this clock;
//   - once the actor has left (bye, or the presence sweep), only an ik strictly
//     newer than the last accepted one proves it again. Departed actors' state
//     is never evicted (only proofs are capped), and the drop is queued behind
//     any beat still being verified for that actor.
// So after a silent drop a replayer can keep the person shown present and
// proven for at most those bounds after their last real beat. While they are
// present a replay gains nothing over the presence spoofing `p` already allows.
// The ask bound sits beside it: a holder re-sends its proof at most once per
// SyncSession.ID_ANSWER_COOLDOWN_MS (5 s) IN ALL, whoever and however many ask
// (asks inside the cooldown share one answer), so at most once per 5 s per
// asker too; any member, readers included, can make it send that one.
//
// What a session keeps: per-actor state only for actors that PROVED a key
// (an unproven frame never creates state), and a proof only for a proven
// (actor, idh) whose own hash matches, at most ID_MAX_PROOFS in all. Asks go
// out only after a proven beat (the ask bound is above); one proven beat for a
// new (actor, hash) makes each receiver send one ask.
//
// The proof sent is whoami's, verbatim, and is never sent over
// PROOF_MAX_BYTES. A host's agent must type-check it before handing it over
// (identityport.ts checkPublic does, on the web); a native host's must too.
//
// PRIVACY. The proof exposes the address and the account's member history
// (passkey pubs, reset and change times) to every room member, readers
// included. That is the design (web-identity-tier §3.4): it is sent only after
// whoami consent in this open, and is cleared when the session moves to another
// document.

import { PROOF_MAX_BYTES, type IdentityProof } from '../identity.ts'
import { PROOF_SKEW_MS } from './keyproof.ts'

/** The possession proof a beat carries for its identity key. */
export interface IdKeyProof {
  /** ms since the epoch, as the signer's clock read it */
  t: number
  /** the agent's signature (raw r‖s, base64url) over idProveText */
  g: string
}

/** A sender re-signs its possession proof once it is this old (well inside PROOF_SKEW_MS). */
export const ID_PROOF_REFRESH_MS = 30_000
/** An unanswered ask for one (actor, hash) is repeated no sooner than this. */
export const ID_ASK_RETRY_MS = 30_000
/** A receiver takes the SAME ik again (a sender re-sends it between re-signs)
 *  only this long after it first accepted it: the refresh plus a margin, on the
 *  receiver's own clock, so no clock skew widens it. */
export const ID_RESEND_WINDOW_MS = ID_PROOF_REFRESH_MS + 15_000
/** Most proofs one session holds, across every actor (each at most PROOF_MAX_BYTES). */
export const ID_MAX_PROOFS = 64

/** A raw P-256 point in base64url (65 bytes). */
const PUB_RE = /^[A-Za-z0-9_-]{87}$/
const HASH_RE = /^[A-Za-z0-9_-]{43}$/
const SIG_RE = /^[A-Za-z0-9_-]{86}$/

const te = new TextEncoder()
const b64uEnc = (b: Uint8Array): string => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64uDec = (s: string): Uint8Array | null => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch { return null }
}
const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s) as BufferSource))

/** The text a proof is hashed as, or null when it is not a plain proof-shaped object under the cap. */
function proofJson(p: unknown): string | null {
  try {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null
    const o = p as Record<string, unknown>
    if (!o.device || typeof o.device !== 'object' || !Array.isArray(o.chain)) return null
    const s = JSON.stringify(p)
    // UTF-8 length: the same measure as identityport.ts parseProof
    return typeof s === 'string' && te.encode(s).length <= PROOF_MAX_BYTES ? s : null
  } catch { return null }
}

/** idh for a proof: base64url(sha256(its JSON)), or null when it is not one or is over PROOF_MAX_BYTES. */
export async function proofHash(p: unknown): Promise<string | null> {
  const s = proofJson(p)
  return s === null ? null : b64uEnc(await sha256(s))
}

/** The 16-byte nonce that ties one possession proof to its room, actor, key, proof and time. */
export async function idNonce(roomId: string, actor: string, idk: string, idh: string, t: number): Promise<string> {
  return b64uEnc((await sha256(`idpres.v1.${roomId}.${actor}.${idk}.${idh}.${t}`)).slice(0, 16))
}

export const idProveText = (nonce: string, roomId: string): string => `prove.${nonce}.${roomId}`

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const
const ALG = { name: 'ECDSA', hash: 'SHA-256' } as const
const verifyKeys = new Map<string, Promise<CryptoKey | null>>()
function importVerify(pub: string): Promise<CryptoKey | null> {
  let k = verifyKeys.get(pub)
  if (!k) {
    const raw = b64uDec(pub)
    k = raw && raw.length === 65 && raw[0] === 4
      ? crypto.subtle.importKey('raw', raw as BufferSource, EC, false, ['verify']).catch(() => null)
      : Promise.resolve(null)
    if (verifyKeys.size > 256) verifyKeys.clear()
    verifyKeys.set(pub, k)
  }
  return k
}

/** Does `ik` prove possession of `idk` for this room, actor and proof hash? Shape and signature only. */
export async function verifyIdKey(ik: unknown, roomId: string, actor: string, idk: string, idh: string): Promise<boolean> {
  if (!ik || typeof ik !== 'object') return false
  const { t, g } = ik as { t?: unknown; g?: unknown }
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t <= 0 || typeof g !== 'string' || !SIG_RE.test(g)) return false
  if (!PUB_RE.test(idk) || !HASH_RE.test(idh)) return false
  const sig = b64uDec(g)
  if (!sig || sig.length !== 64) return false
  const key = await importVerify(idk)
  if (!key) return false
  try {
    const text = idProveText(await idNonce(roomId, actor, idk, idh, t), roomId)
    return await crypto.subtle.verify(ALG, key, sig as BufferSource, te.encode(text))
  } catch { return false }
}

/** The identity fields of one incoming frame, as received (top level only). */
export interface IdFields { idk?: unknown; idh?: unknown; ik?: unknown; idp?: unknown }

interface ActorId {
  idk?: string
  idh?: string
  proven: boolean
  /** the last ACCEPTED ik: its t never moves back */
  lastT: number
  /** the exact (t, g, idk, idh) last verified, and when this clock first accepted it */
  lastKey?: string
  lastKeyAt: number
  /** after the actor left, the next ik must be strictly newer than lastT */
  strict: boolean
  /** proofs held for this actor, by their own hash */
  proofs: Map<string, IdentityProof>
  /** when an ask for a hash was last sent */
  asked: Map<string, number>
}

const fresh = (): ActorId => ({ proven: false, lastT: 0, lastKeyAt: 0, strict: false, proofs: new Map(), asked: new Map() })
const view = (st: ActorId | undefined) => st ? `${st.proven}.${st.idk}.${st.idh}.${st.proofs.size}` : '-'

/** Per-actor identity state for one session (one open of one document). */
export class IdProofs {
  private actors = new Map<string, ActorId>()
  private queues = new Map<string, Promise<void>>()
  /** proofs held, oldest first, across actors */
  private held: Array<[string, string]> = []
  /** bumped by reset(): a verdict begun for an earlier open is discarded */
  private epoch = 0

  constructor(private now: () => number = () => Date.now()) {}

  private keep(actor: string, st: ActorId, h: string, p: unknown) {
    st.proofs.set(h, structuredClone(p) as IdentityProof)
    this.held = this.held.filter(([a, x]) => !(a === actor && x === h))
    this.held.push([actor, h])
    while (st.proofs.size > 2) { const old = st.proofs.keys().next().value!; st.proofs.delete(old); this.held = this.held.filter(([a, x]) => !(a === actor && x === old)) }
    while (this.held.length > ID_MAX_PROOFS) { const [a, x] = this.held.shift()!; this.actors.get(a)?.proofs.delete(x) }
  }

  /** Run `fn` after every verdict already queued for `actor`, unless the open changed meanwhile. */
  private enqueue(actor: string, fn: () => Promise<void> | void): Promise<void> {
    const ep = this.epoch
    const next = (this.queues.get(actor) ?? Promise.resolve()).then(() => (ep === this.epoch ? fn() : undefined)).catch(() => { /* simply unproven */ })
    this.queues.set(actor, next)
    void next.then(() => { if (this.queues.get(actor) === next) this.queues.delete(actor) })
    return next
  }

  /**
   * Judge one frame's identity fields, in arrival order per actor. `after`
   * runs once the verdict is recorded with whether anything an app sees
   * changed, and the hash to ask `actor` for (proven, but its proof not held,
   * and not asked within ID_ASK_RETRY_MS), if any.
   */
  accept(actor: string, roomId: string | null, f: IdFields, after?: (changed: boolean, ask: string | null) => void): Promise<void> {
    if (!this.queues.has(actor) && f.idk === undefined && f.idp === undefined) {
      // nothing to verify and nothing ahead of it: judged at once
      const st = this.actors.get(actor)
      const changed = !!st && (st.proven || st.idk !== undefined)
      if (st) { st.proven = false; st.idk = undefined; st.idh = undefined }
      after?.(changed, null)
      return Promise.resolve()
    }
    const ep = this.epoch
    let changed = false
    let ask: string | null = null
    return this.enqueue(actor, async () => {
      const before = view(this.actors.get(actor))
      try {
        const st0 = this.actors.get(actor)
        if (st0) st0.proven = false // until THIS beat proves it
        const idk = f.idk, idh = f.idh
        if (typeof idk !== 'string' || !PUB_RE.test(idk) || typeof idh !== 'string' || !HASH_RE.test(idh)) {
          if (st0) { st0.idk = undefined; st0.idh = undefined }
          return
        }
        if (st0) { st0.idk = idk; st0.idh = idh }
        if (!roomId || !f.ik || typeof f.ik !== 'object') return
        const { t, g } = f.ik as { t?: unknown; g?: unknown }
        const now = this.now()
        if (typeof t !== 'number' || Math.abs(now - t) > PROOF_SKEW_MS) return
        const lastT = st0?.lastT ?? 0
        if (t < lastT || (st0?.strict && t === lastT)) return
        const key = `${t}.${String(g)}.${idk}.${idh}`
        const resent = !!st0 && key === st0.lastKey
        if (t === lastT && !resent) return
        if (resent && now - st0!.lastKeyAt > ID_RESEND_WINDOW_MS) return
        if (!resent && !(await verifyIdKey(f.ik, roomId, actor, idk, idh))) return
        const h = f.idp === undefined ? null : await proofHash(f.idp)
        if (ep !== this.epoch) return
        let st = this.actors.get(actor)
        if (!st) this.actors.set(actor, st = fresh())
        st.idk = idk; st.idh = idh
        st.lastT = t
        if (!resent) { st.lastKey = key; st.lastKeyAt = now }
        st.strict = false
        st.proven = true
        // the proof, kept under its OWN hash, and only the one this proven beat names
        if (h !== null && h === idh) this.keep(actor, st, h, f.idp)
        if (!st.proofs.has(idh)) {
          const at = st.asked.get(idh)
          if (at === undefined || now - at >= ID_ASK_RETRY_MS) {
            st.asked.set(idh, now)
            ask = idh
          }
        }
      } finally {
        changed = before !== view(this.actors.get(actor))
      }
    }).then(() => { after?.(changed, ask) })
  }

  /** The identity `actor` has proven in this session, with the proof for it, or null. */
  peer(actor: string): { pub: string; proof: IdentityProof } | null {
    const st = this.actors.get(actor)
    if (!st || !st.proven || !st.idk || !st.idh) return null
    const proof = st.proofs.get(st.idh)
    return proof ? { pub: st.idk, proof: structuredClone(proof) } : null
  }

  /** Has `actor` proven, in this session, that it holds the identity key `pub`? */
  proven(actor: string, pub: string): boolean {
    const st = this.actors.get(actor)
    return !!st && st.proven && typeof pub === 'string' && st.idk === pub
  }

  /** The actor left: unproven, and only a strictly newer ik proves it again.
   *  Queued behind any beat of that actor still being verified. */
  drop(actor: string): Promise<void> {
    return this.enqueue(actor, () => {
      const st = this.actors.get(actor)
      if (st) { st.proven = false; st.strict = true }
    })
  }

  /** A different document (another open): forget everything, including verdicts in flight. */
  reset() {
    this.epoch++
    this.actors.clear()
    this.queues.clear()
    this.held = []
  }
}
