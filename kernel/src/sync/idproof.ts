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
/** Most actors whose identity state one session keeps. */
export const ID_MAX_ACTORS = 256

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
  /** the exact (t, g, idk, idh) last verified, so a re-sent ik is not verified again */
  lastKey?: string
  /** after the actor left, the next ik must be strictly newer than lastT */
  strict: boolean
  /** proofs held for this actor, by their own hash (at most two) */
  proofs: Map<string, IdentityProof>
  /** when an ask for a hash was last sent */
  asked: Map<string, number>
}

/** Per-actor identity state for one session (one open of one document). */
export class IdProofs {
  private actors = new Map<string, ActorId>()
  private queues = new Map<string, Promise<void>>()

  constructor(private now: () => number = () => Date.now()) {}

  private state(actor: string): ActorId {
    let st = this.actors.get(actor)
    if (!st) {
      if (this.actors.size >= ID_MAX_ACTORS) this.actors.delete(this.actors.keys().next().value!)
      st = { proven: false, lastT: 0, strict: false, proofs: new Map(), asked: new Map() }
      this.actors.set(actor, st)
    }
    return st
  }

  /**
   * Judge one frame's identity fields, in arrival order per actor. `after`
   * runs once the verdict is recorded with whether anything an app sees
   * changed, and the hash to ask `actor` for (proven, but its proof not held,
   * and not asked within ID_ASK_RETRY_MS), if any.
   */
  accept(actor: string, roomId: string | null, f: IdFields, after?: (changed: boolean, ask: string | null) => void): Promise<void> {
    const pending = this.queues.get(actor)
    if (!pending && f.idk === undefined && f.idp === undefined) {
      // nothing to verify and nothing ahead of it: judged at once
      const st = this.actors.get(actor)
      const changed = !!st && (st.proven || st.idk !== undefined)
      if (st) { st.proven = false; st.idk = undefined; st.idh = undefined }
      after?.(changed, null)
      return Promise.resolve()
    }
    const prev = pending ?? Promise.resolve()
    let changed = false
    let ask: string | null = null
    const next = prev.then(async () => {
      const st = this.state(actor)
      const before = `${st.proven}.${st.idk}.${st.idh}.${st.proofs.size}`
      try {
        // the proof, kept under its OWN hash; a frame's idh that disagrees voids it
        if (f.idp !== undefined) {
          const h = await proofHash(f.idp)
          if (h && (f.idh === undefined || f.idh === h)) {
            st.proofs.delete(h)
            st.proofs.set(h, structuredClone(f.idp) as IdentityProof)
            while (st.proofs.size > 2) st.proofs.delete(st.proofs.keys().next().value!)
          }
        }
        st.proven = false // until THIS beat proves it
        const idk = f.idk, idh = f.idh
        if (typeof idk !== 'string' || !PUB_RE.test(idk) || typeof idh !== 'string' || !HASH_RE.test(idh)) {
          st.idk = undefined; st.idh = undefined
          return
        }
        st.idk = idk; st.idh = idh
        if (!roomId || !f.ik || typeof f.ik !== 'object') return
        const { t, g } = f.ik as { t?: unknown; g?: unknown }
        if (typeof t !== 'number' || Math.abs(this.now() - t) > PROOF_SKEW_MS) return
        if (t < st.lastT || (st.strict && t === st.lastT)) return
        const key = `${t}.${String(g)}.${idk}.${idh}`
        if (t === st.lastT && key !== st.lastKey) return
        if (key !== st.lastKey && !(await verifyIdKey(f.ik, roomId, actor, idk, idh))) return
        // a newer beat for another key or proof may have been judged meanwhile: it is queued behind us, so not
        if (st.idk !== idk || st.idh !== idh) return
        st.lastT = t
        st.lastKey = key
        st.strict = false
        st.proven = true
        if (!st.proofs.has(idh)) {
          const at = st.asked.get(idh)
          if (at === undefined || this.now() - at >= ID_ASK_RETRY_MS) {
            st.asked.set(idh, this.now())
            ask = idh
          }
        }
      } finally {
        changed = before !== `${st.proven}.${st.idk}.${st.idh}.${st.proofs.size}`
      }
    }).catch(() => { /* a verdict that throws is simply unproven */ }).then(() => { after?.(changed, ask) })
    this.queues.set(actor, next)
    void next.then(() => { if (this.queues.get(actor) === next) this.queues.delete(actor) })
    return next
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

  /** The actor left: unproven, and only a strictly newer ik proves it again. */
  drop(actor: string) {
    const st = this.actors.get(actor)
    if (st) { st.proven = false; st.strict = true }
  }

  /** A different document (another open): forget everything. */
  reset() {
    this.actors.clear()
    this.queues.clear()
  }
}
