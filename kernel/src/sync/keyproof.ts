// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Presence key proof. A presence beat may name the key its sender uses (`pub`).
// A beat that also carries a key proof `kp = {t, g}` is signed by that key over
//
//   pres.v1.<roomId>.<actor>.<pub>.<t>
//
// and the receiving session tracks, per actor, whether the key it names is
// proven (KeyProofs below). The app asks SyncSession.keyProven(actor, pub); the
// answer is the session's own verification state and is never read from a
// field a peer sent.
//
// The rules, per actor:
//   · every beat that names a pub is checked; a beat with no proof, a bad
//     signature, a stale or non-increasing t, or a different pub than the one
//     proven leaves the actor unproven until a later beat proves it afresh;
//   · t must be within PROOF_SKEW_MS of this clock and strictly greater than
//     the last accepted t for that actor;
//   · a key this session has seen revoked is never proven again this session;
//   · the beat's `role` plays no part.
// A client that sends no proof keeps working; its key is simply never proven.

/** How far a proof's timestamp may sit from this clock (either direction). */
export const PROOF_SKEW_MS = 90_000

export interface KeyProof {
  /** ms since the epoch, as the signer's clock read it */
  t: number
  /** ECDSA P-256 / SHA-256 signature (IEEE P1363, base64url) over proofText */
  g: string
}

export const proofText = (roomId: string, actor: string, pub: string, t: number): string =>
  `pres.v1.${roomId}.${actor}.${pub}.${t}`

/** The room's id as it appears in the proof: the last path segment of collab.room. */
export function roomIdOf(room: string | undefined): string | null {
  if (typeof room !== 'string' || !room) return null
  const seg = room.split('?')[0].split('/').filter(Boolean).pop()
  return seg && /^[A-Za-z0-9_-]+$/.test(seg) ? seg : null
}

const b64uDec = (s: string): Uint8Array | null => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch { return null }
}
const b64uEnc = (b: Uint8Array): string => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const
const ALG = { name: 'ECDSA', hash: 'SHA-256' } as const
const te = new TextEncoder()

/** Sign a proof with an imported signing key. */
export async function signProof(key: CryptoKey, roomId: string, actor: string, pub: string, t: number): Promise<KeyProof> {
  const sig = new Uint8Array(await crypto.subtle.sign(ALG, key, te.encode(proofText(roomId, actor, pub, t))))
  return { t, g: b64uEnc(sig) }
}

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

/** Does `kp` prove `pub` for this room and actor? Shape, signature only; freshness is KeyProofs'. */
export async function verifyProof(kp: unknown, roomId: string, actor: string, pub: string): Promise<boolean> {
  if (!kp || typeof kp !== 'object') return false
  const { t, g } = kp as { t?: unknown; g?: unknown }
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t <= 0 || typeof g !== 'string') return false
  const sig = b64uDec(g)
  if (!sig || sig.length !== 64) return false
  const key = await importVerify(pub)
  if (!key) return false
  try {
    return await crypto.subtle.verify(ALG, key, sig as BufferSource, te.encode(proofText(roomId, actor, pub, t)))
  } catch { return false }
}

interface ActorState {
  /** the key this actor's last beat named */
  pub?: string
  /** that key is proven: the latest beat for it carried a valid, fresh proof */
  proven: boolean
  /** the last ACCEPTED proof timestamp; never moves back */
  lastT: number
}

/** Per-actor proof state for one session. Beats are judged in arrival order. */
export class KeyProofs {
  private actors = new Map<string, ActorState>()
  private revoked = new Set<string>()
  private queues = new Map<string, Promise<void>>()

  constructor(private now: () => number = () => Date.now()) {}

  /**
   * Judge one beat. `after` runs once the verdict is recorded, in the order
   * beats arrived for that actor (verification is async, so a later beat must
   * never overtake an earlier one).
   */
  accept(actor: string, roomId: string | null, pub: unknown, kp: unknown, after?: () => void): Promise<void> {
    const pending = this.queues.get(actor)
    if (!pending && !kp) {
      // nothing to verify and nothing ahead of it: judged at once, as presence
      // always was (a client that sends no proof sees no change in timing)
      const st = this.actors.get(actor) ?? { proven: false, lastT: 0 }
      this.actors.set(actor, st)
      st.proven = false
      st.pub = typeof pub === 'string' && pub ? pub : undefined
      after?.()
      return Promise.resolve()
    }
    const prev = pending ?? Promise.resolve()
    const next = prev.then(async () => {
      const st = this.actors.get(actor) ?? { proven: false, lastT: 0 }
      this.actors.set(actor, st)
      st.proven = false // until THIS beat proves it
      if (typeof pub !== 'string' || !pub) { st.pub = undefined; return }
      st.pub = pub
      if (!roomId || this.revoked.has(pub) || !kp) return
      const t = (kp as { t?: unknown }).t
      if (typeof t !== 'number' || t <= st.lastT || Math.abs(this.now() - t) > PROOF_SKEW_MS) return
      if (!(await verifyProof(kp, roomId, actor, pub))) return
      // re-check after the await: a revocation or a newer beat may have landed
      if (this.revoked.has(pub) || st.pub !== pub || t <= st.lastT) return
      st.lastT = t
      st.proven = true
    }).catch(() => { /* a verdict that throws is simply unproven */ }).then(() => { after?.() })
    this.queues.set(actor, next)
    void next.then(() => { if (this.queues.get(actor) === next) this.queues.delete(actor) })
    return next
  }

  /** Run `fn` after every beat already queued for `actor` (keeps bye in order). */
  queue(actor: string, fn: () => void): Promise<void> {
    const next = (this.queues.get(actor) ?? Promise.resolve()).then(fn)
    this.queues.set(actor, next)
    void next.then(() => { if (this.queues.get(actor) === next) this.queues.delete(actor) })
    return next
  }

  /** The actor left: unproven, but its last timestamp is kept so an old beat can't re-prove it. */
  drop(actor: string) {
    const st = this.actors.get(actor)
    if (st) st.proven = false
  }

  /** A revocation for `pub` was seen: never proven again this session. */
  revoke(pub: string) {
    if (typeof pub !== 'string' || !pub) return
    this.revoked.add(pub)
    for (const st of this.actors.values()) if (st.pub === pub) st.proven = false
  }

  isRevoked(pub: string): boolean { return this.revoked.has(pub) }

  proven(actor: string, pub: string): boolean {
    const st = this.actors.get(actor)
    return !!st && st.proven && typeof pub === 'string' && st.pub === pub && !this.revoked.has(pub)
  }

  /** A different document (another room): forget every actor and every revocation. */
  reset() {
    this.actors.clear()
    this.revoked.clear()
    this.queues.clear()
  }
}
