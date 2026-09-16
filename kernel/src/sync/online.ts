// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento-sync online transport — E2EE WebSocket to the blind relay
// (server/sync-worker). Every session frame is AES-GCM encrypted with the
// room key from doc.collab.key; the relay sees ciphertext, fan-out routing,
// and nothing else. Auth is possession-proof: ?tok= is a hash of the key.
//
// Reconnects with backoff; frames queue while disconnected; op frames are
// persisted server-side (envelope {p:1}) and replayed to joiners from their
// last acked seq, with client-produced encrypted snapshots capping replay
// length. See docs/collab-design.md.

import type { Op, SyncStateJSON } from './crdt.ts'
import type { Frame, HostStore, RefusalCode, SyncDoc, SyncSession, Transport } from './session.ts'
import { lsGet, lsSet } from '../storage.ts'
import { offlineEnabled } from '../update.ts'
// Every request in the app goes through the one chokepoint (kernel/src/net.ts)
// so the offline switch cannot be forgotten — see GHSA-5c3x-xqp6-g94r.
import { netWebSocket, SandboxedError } from '../net.ts'
import { appConfig } from '../app.ts'

/** the app's store, structurally — see session.ts HostStore */
type Store = HostStore

export const DEFAULT_SYNC_HOST = 'wss://sync.bento.page'
const SNAP_EVERY = 200 // ops between encrypted snapshot uploads

const b64u = {
  enc(bytes: Uint8Array): string {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  dec(s: string): Uint8Array {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    const out = new Uint8Array(b.length)
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
    return out
  },
}

export function mintRoomKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return b64u.enc(bytes)
}

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const

/** Import a writer private key (PKCS#8, base64url) for signing op frames. */
export async function importSignKey(privB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', b64u.dec(privB64) as BufferSource, EC, false, ['sign'])
}

/** ECDSA-P256/SHA-256 signature over `${i}.${d}`, base64url. */
export async function signFrame(key: CryptoKey, i: string, d: string): Promise<string> {
  const sig = await crypto.subtle.sign(SIGN_ALG, key, new TextEncoder().encode(`${i}.${d}`))
  return b64u.enc(new Uint8Array(sig))
}

/** Sign an arbitrary string with an already-imported signing key. */
export async function signWith(key: CryptoKey, text: string): Promise<string> {
  const sig = await crypto.subtle.sign(SIGN_ALG, key, new TextEncoder().encode(text))
  return b64u.enc(new Uint8Array(sig))
}

/** Sign an arbitrary string with a b64url PKCS#8 private key (cert chains). */
export async function signText(privB64: string, text: string): Promise<string> {
  return signWith(await importSignKey(privB64), text)
}

async function mintKeypair(): Promise<{ pub: string; priv: string }> {
  const kp = (await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair
  return {
    pub: b64u.enc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))),
    priv: b64u.enc(new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))),
  }
}

export type CollabInvite = { pub: string; priv: string; role: 'writer' | 'commenter' | 'audience'; exp?: number; sig: string }

/** Owner-signed invite: a delegation keypair whose private half rides in the
 *  shared copy. Chain: owner signs `inv.${pub}.${role}.${exp||0}`; a joining
 *  device later signs its own pubkey with the invite key (`dlg.${memberPub}`).
 *  The relay verifies both signatures and never sees private material — so a
 *  blind relay still cannot certify its own key. */
export async function mintInvite(ownerPrivB64: string, role: 'writer' | 'commenter' | 'audience' = 'writer', exp = 0): Promise<CollabInvite> {
  const kp = await mintKeypair()
  const sig = await signText(ownerPrivB64, `inv.${kp.pub}.${role}.${exp}`)
  return { pub: kp.pub, priv: kp.priv, role, ...(exp ? { exp } : {}), sig }
}

/** This device's member identity for a doc — minted once, kept in localStorage,
 *  NEVER in the file (the file travels; a device key must not). */
export async function deviceIdentity(docId: string): Promise<{ pub: string; priv: string }> {
  const k = `bento-member-${docId}`
  try {
    const saved = lsGet(k)
    if (saved) return JSON.parse(saved)
  } catch { /* storage unavailable → ephemeral identity */ }
  const id = await mintKeypair()
  lsSet(k, JSON.stringify(id))
  return id
}

/** Auth material for the relay connection. Exactly one shape applies:
 *  direct (owner or legacy shared-writer key) or chain (member via invite). */
export type AuthSpec =
  | { kind: 'direct'; pub: string; priv?: string }
  | { kind: 'chain'; owner: string; invite: CollabInvite; docId: string }

export type CollabCreds = {
  room: string
  key: string
  on: boolean
  v: number
  owner: string
  ownerPriv: string
  role: 'writer'
}

/**
 * Fresh collaboration credentials, minted at DOCUMENT CREATION and LIVE by
 * default (on:true): the moment identity and keys exist, any copy of the
 * file joins the same room — "send first" needs no ceremony. "Stop sharing"
 * in the Live popover turns it off; Offline mode hard-blocks regardless.
 *
 * Signed-writes scheme (v0.9.18+): the room id is the COMMITMENT to a fresh
 * ECDSA writer pubkey — `w` + base64url(SHA-256(writerPubRaw)) — so the relay
 * can pin the writer key trustlessly (a viewer holds the room id but can't
 * substitute their own key). `key` is the separate symmetric READ capability.
 * Async because keypair generation is. See docs/collab-design.md.
 */
export async function mintCollab(): Promise<CollabCreds> {
  // v2 (fine-grained): the room id commits to the OWNER's pubkey. The creator's
  // copy holds ownerPriv; shared copies carry owner-signed INVITES instead, and
  // each joining device mints its own member key (see mintInvite/deviceIdentity).
  const kp = await mintKeypair()
  const commit = new Uint8Array(await crypto.subtle.digest('SHA-256', b64u.dec(kp.pub) as BufferSource))
  return {
    room: `${syncHost()}/d/w${b64u.enc(commit)}`,
    key: mintRoomKey(),
    on: true,
    v: 2,
    owner: kp.pub,
    ownerPriv: kp.priv,
    role: 'writer',
  }
}

/** The relay host: the localStorage dev override (e.g. ws://localhost:8787),
 *  else the host the app configured (a fork running its own relay), else the
 *  platform default. Rigs that never call configureApp() get the default.
 *
 *  A file's collab capability is complete only WITHIN the publisher that
 *  minted it. `CollabCreds` carries the room and the key and no host, which
 *  was total while every build had one relay; with per-publisher relays, the
 *  same file opened in another publisher's build joins that publisher's
 *  relay, where the room id is a valid commitment and is simply created
 *  fresh. Both sides are live, on two relays, and never meet — a silent
 *  split, not a leak (the relay is blind and the payloads are E2EE). This is
 *  accepted and consistent with the update channel refusing another
 *  publisher's manifests: a fork is its own trust domain. Cross-publisher
 *  collaboration would need the host stamped into `collab` — an additive
 *  format change, and its own serialized kernel PR. */
export function syncHost(): string {
  let configured: string | undefined
  try { configured = appConfig().syncHost } catch { /* not configured: platform default */ }
  try {
    return lsGet('bento-sync-url') || configured || DEFAULT_SYNC_HOST
  } catch {
    return configured || DEFAULT_SYNC_HOST
  }
}

export type OnlineStatus = 'connecting' | 'open' | 'closed'

/** A frame written to (or parked for) the relay. `ops` is set for persisted op
 *  batches — the only frames the relay acks, and the only ones whose refusal
 *  has to reach the session (an unsendable op must leave the resend log). */
type Outbound = { id: string; text: string; ops: Op[] | null; bytes: number; tries: number }

let frameSeq = 0
/** Short opaque per-frame id. Emitted FIRST in the envelope so the relay can
 *  recover it with a bounded regex from an OVERSIZE frame — one it refuses
 *  before parsing, since parsing an attacker-sized string is a CPU abuse
 *  vector. Relay contract: docs/relay-design.md. */
const nextFrameId = (): string => `f${(++frameSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** `{ctl:'refused'}` from the relay. Modern relays echo our frame id (`k`),
 *  which is exact; older ones don't, and then the sizes are the only evidence
 *  of WHICH frame it names (see matchRefused). */
type RefusedEnv = {
  code?: string
  /** our frame id, echoed back — authoritative when present */
  k?: string
  /** too-large: the relay's ceiling and the frame length it measured */
  max?: number
  got?: number
  /** storage-failed: i.length + d.length of the frame it tried to store */
  bytes?: number
  /** rate-limited: how long until the socket's byte window rolls over */
  retryInMs?: number
}

export class OnlineTransport implements Transport {
  readonly kind = 'online'
  status: OnlineStatus = 'connecting'
  onStatus: ((s: OnlineStatus) => void) | null = null
  private ws: WebSocket | null = null
  private key: CryptoKey | null = null
  /** writer signing key — null for readers (they can decrypt but not author). */
  private signKey: CryptoKey | null = null
  private queue: Outbound[] = []
  /** persisted frames written but not yet acked. The relay handles one
   *  socket's frames in order and acks every stored one, so the head of this
   *  list is the frame a `refused` reply is talking about. Purely a
   *  correlation window — delivery is still guaranteed by the log + `need`. */
  private awaitingAck: Outbound[] = []
  /** rate-limit backoff deadline: sending into a refusing relay only burns the
   *  next window too, so frames park until it passes */
  private paused = false
  private pauseTimer: ReturnType<typeof setTimeout> | null = null
  private lastLimitNotice = 0
  private static readonly ACK_WINDOW = 64
  private static readonly MAX_RETRIES = 4
  private closed = false
  private backoff = 800
  private url = ''
  // heartbeat: ping the relay (which auto-responds "pong" without waking the DO)
  // so idle connections stay alive; if a pong doesn't come back before the next
  // tick, treat the socket as dead and reconnect instead of waiting for a TCP
  // timeout that can take minutes.
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private awaitingPong = false
  private static readonly PING_MS = 25_000
  /** the key THIS socket signs with (owner / legacy writer / device) — used to
   *  recognise our own revocation and to attribute presence */
  myPub: string | null = null
  /**
   * Replay bookmark — MEMORY ONLY, deliberately: it is valid only alongside
   * the in-memory CRDT state it was earned with. A fresh join replays from
   * the room's snapshot (or 0); reconnects of THIS session resume from here.
   */
  private seq = 0

  constructor(
    room: string,
    private keyB64: string,
    docId: string,
    private onFrame: (f: Frame) => void,
    private hooks: {
      onSnap: (doc: SyncDoc, state: SyncStateJSON) => void
      getSnapshot: () => { doc: SyncDoc; state: SyncStateJSON }
      onOpen: () => void
      /** replay done: (actor,seq) pairs the room holds; return true to upload a snapshot */
      onReady: (seen: Set<string>, seq: number) => boolean
      /** the relay refused a frame; `ops` are the ones it will never accept
       *  (null when the refusal couldn't be pinned to a frame we sent) */
      onRefused?: (code: RefusalCode, ops: Op[] | null) => void
      // ——— broadcast reception (audience side, and the presenter's own
      // checkpoint/count signals). All optional: a session with no show wires
      // none of them and nothing below fires. ———
      /** an aud op batch (audience): apply through the reader path */
      onShowOps?: (ops: Op[]) => void
      /** an aud snapshot (audience): the whole show document under Ke */
      onShowSnap?: (doc: SyncDoc, state: SyncStateJSON) => void
      /** a control verb (audience): nav/black/laser with its decrypted payload */
      onShowVerb?: (kind: 'nav' | 'black' | 'laser', payload: unknown) => void
      /** the relay asks the presenter to checkpoint (soft cap or show-full) */
      onShowCheckpoint?: () => void
      /** coarse audience count, to the presenter */
      onShowCount?: (n: number) => void
      /** an audience socket was closed by the relay (4001 end/grace, 4002
       *  not-live, 4003 show-full, 1008 revoked) */
      onShowClosed?: (code: number) => void
    },
    private auth?: AuthSpec,
  ) {
    this.docId = docId
    this.writeReadyP = new Promise<void>((r) => { this.resolveWriteReady = r })
    // Known before init's async work: an audience socket is a chain whose
    // invite the owner signed with role 'audience'. Set here so startShow and
    // the send guards see it immediately.
    this.audienceMode = auth?.kind === 'chain' && auth.invite.role === 'audience'
    this.init(room)
  }

  private docId = ''

  /** (actor,seq) pairs seen in the current connection's replay */
  private replaySeen = new Set<string>()

  /** Credentials the blob layer needs: the relay origin, the room name, the
   *  possession-proof token, and the raw room key it encrypts blobs with.
   *  Null until init() has derived the token. */
  blobCreds(): { base: string; room: string; tok: string; rawKey: Uint8Array } | null {
    if (!this.roomName || !this.tokValue) return null
    // The write ticket (relay: Room.writeTicket) when this socket earned one,
    // else the read token. Uploads authorized by the token alone let any
    // read-only copy fill the room's blob quota, so the relay hands writers a
    // separate credential over the certified socket; reads accept either.
    return {
      base: this.originValue,
      room: this.roomName,
      tok: this.writeTicket || this.tokValue,
      rawKey: b64u.dec(this.keyB64),
    }
  }
  /** True once this socket can upload: it holds the write ticket, or the relay
   *  finished `ready` without offering one (an older relay, or a reader — either
   *  way the room token is what uploads take there). Callers that PUT before this
   *  resolves would send the token into a ticket-latched room and 403. */
  writeReady(): Promise<void> {
    return this.writeReadyP
  }
  private writeReadyP: Promise<void>
  private resolveWriteReady: () => void = () => {}
  private roomName = ''
  private tokValue = ''
  private originValue = ''
  /** relay-issued blob write ticket; null until a PROVEN socket is handed one */
  private writeTicket: string | null = null
  /** `w`-room: the relay verifies writer signatures, so its stamps mean
   *  something and unstamped content-bearing frames can be refused. Legacy
   *  `r` rooms sign nothing — gating there would drop every legitimate frame. */
  private signedRoom = false
  /** An audience socket: connects on the audience path (ivr=audience) and is
   *  RECEIVE-ONLY — it sends no protocol frame, only the transport keepalive.
   *  The relay drops anything else it sent, but a client that does not send it
   *  in the first place cannot leak presence or an op it should not have. */
  private audienceMode = false
  /** True when this transport is an audience socket — receive-only. The session
   *  refuses startShow on it, and every show sender below no-ops. */
  get audience(): boolean { return this.audienceMode }

  private async init(room: string) {
    const raw = b64u.dec(this.keyB64)
    this.key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ])
    const tokDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw as BufferSource))
    const tok = b64u.enc(tokDigest.slice(0, 18))
    // Blob endpoints live on the same origin as the socket and use the same
    // room + token, so derive them here rather than duplicating the rule.
    try {
      const u = new URL(room.replace(/^ws/, 'http'))
      this.originValue = u.origin
      this.roomName = u.pathname.replace(/^\/d\//, '')
      this.tokValue = tok
      this.signedRoom = this.roomName[0] === 'w'
    } catch { /* malformed room url — blobs simply stay unavailable */ }
    // Writers sign op frames; readers omit auth and the relay drops their
    // writes. Two writer shapes: DIRECT (the presented `w` key hash-matches the
    // room commitment — the owner, or a legacy shared-writer copy) and CHAIN
    // (a member: `w` = this device's key, plus the owner-signed invite and the
    // invite-signed delegation of the device key — verified by the relay).
    const a = this.auth
    if (a?.kind === 'direct') {
      if (a.priv) { try { this.signKey = await importSignKey(a.priv) } catch { this.signKey = null } }
      this.myPub = a.pub
      // bt=1: we understand the blob write ticket. The relay only starts
      // REQUIRING it for uploads once a PROVEN writer has said so, which is
      // what lets the relay ship ahead of clients without 403ing their asset
      // offload. Sent by every writer shape; honoured only after `prove`.
      this.url = `${room}?tok=${tok}&bt=1&w=${a.pub}`
    } else if (a?.kind === 'chain') {
      const id = await deviceIdentity(this.docId)
      try { this.signKey = await importSignKey(id.priv) } catch { this.signKey = null }
      this.myPub = id.pub
      const iv = a.invite
      const dg = await signText(iv.priv, `dlg.${id.pub}`)
      // An audience member connects on the audience path: ivr=audience (which
      // the owner signed into the invite), no bt (it never proves, never gets a
      // ticket), and receive-only. audienceMode was set in the constructor.
      const bt = this.audienceMode ? '' : '&bt=1'
      this.url = `${room}?tok=${tok}${bt}&w=${id.pub}&o=${a.owner}` +
        `&ivp=${iv.pub}&ivr=${iv.role}&ive=${iv.exp ?? 0}&ivs=${iv.sig}&dg=${dg}`
    } else {
      this.url = `${room}?tok=${tok}`
    }
    this.connect()
  }

  private lastSeq(): number {
    return this.seq
  }

  private saveSeq(q: number) {
    if (q > this.seq) this.seq = q
  }

  private setStatus(s: OnlineStatus) {
    this.status = s
    this.onStatus?.(s)
  }

  private connect() {
    if (this.closed) return
    this.setStatus('connecting')
    let ws: WebSocket
    try {
      ws = netWebSocket(`${this.url}&since=${this.lastSeq()}`)
    } catch (e) {
      // A sandboxed embed (Teams/SharePoint preview) refuses every socket at
      // the net chokepoint, permanently and identically — retrying would only
      // flap 'connecting' forever. Treat it as TERMINAL, exactly as drop()
      // treats close codes 4001/1008: stop, schedule no reconnect. (The offline
      // switch is different — it can flip back off, so it stays retryable.)
      if (e instanceof SandboxedError) { this.closed = true; this.setStatus('closed'); return }
      this.retry()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 800
      this.inReplay = true
      this.replaySeen = new Set()
      // acks don't survive the socket: whatever was un-acked is unknowable now,
      // and a stale entry would mis-name a later refusal. Delivery of those ops
      // is the log's job anyway (session.onRelayReady re-sends what the room lacks).
      this.awaitingAck = []
      this.setStatus('open')
      for (const out of this.queue.splice(0)) this.write(out)
      this.startHeartbeat(ws)
      this.hooks.onOpen()
    }
    ws.onmessage = (ev) => {
      const data = String(ev.data)
      if (data === 'pong') { this.awaitingPong = false; return } // keepalive reply
      this.onEnvelope(data).catch(() => {})
    }
    const drop = (ev?: { code?: number }) => {
      if (this.ws !== ws) return
      this.stopHeartbeat()
      this.ws = null
      this.setStatus('closed')
      // Broadcast close codes carry meaning: the relay closed an audience
      // socket deliberately. 4001 end/grace and 1008 revoked are TERMINAL —
      // the show is over or access is gone, so do not reconnect into a wall;
      // 4002 not-live and 4003 show-full are transient (the presenter has not
      // gone live yet, or the show is momentarily full), so reconnect with
      // backoff — that IS the "waiting for the presenter" state.
      const code = ev?.code
      if (code && code >= 4001 && code <= 4003 || code === 1008) this.hooks.onShowClosed?.(code!)
      if (code === 4001 || code === 1008) { this.closed = true; return }
      this.retry()
    }
    ws.onclose = drop
    ws.onerror = () => drop()
  }

  private startHeartbeat(ws: WebSocket) {
    this.stopHeartbeat()
    this.awaitingPong = false
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
      if (this.awaitingPong) {
        // no pong since the last ping → the socket is dead (half-open); force a
        // close so onclose fires and we reconnect, rather than hanging silently.
        try { ws.close() } catch { /* already gone */ }
        return
      }
      this.awaitingPong = true
      try { ws.send('ping') } catch { /* send failed → onclose will handle it */ }
    }, OnlineTransport.PING_MS)
  }

  private stopHeartbeat() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    this.awaitingPong = false
  }

  private retry() {
    if (this.closed) return
    setTimeout(() => this.connect(), this.backoff)
    this.backoff = Math.min(this.backoff * 1.8, 30000)
  }

  // --- refusals -------------------------------------------------------------

  /**
   * The relay refused a frame. Handling this is not optional politeness: when
   * the relay dropped oversize/over-quota frames SILENTLY, the sender got no
   * ack, the peer stayed behind, its `need`/vv catch-up asked for the very
   * same op, and the sender re-sent the identical doomed frame forever.
   *
   * 'rate-limited' is transient — back off and retry. Everything else is
   * permanent for that frame: it goes up to the session, which forgets the ops
   * so the loop cannot restart, and tells the user what they just lost.
   */
  private handleRefusal(env: RefusedEnv) {
    if (env.code === 'rate-limited') {
      this.throttle(typeof env.retryInMs === 'number' ? env.retryInMs : 10_000)
      return
    }
    // Not in RefusalCode on purpose: it never reaches SyncNotice (nothing was
    // lost, so there is nothing to tell the user), and widening the exported
    // union would make every app's notice switch non-exhaustive for a code it
    // will never see.
    if ((env.code as string) === 'snap-ahead') {
      // We uploaded a snapshot claiming to cover a seq the room has not reached.
      // The relay refused it rather than prune ops it still needs — nothing was
      // lost, the op log is intact, and the next snapshot cadence will retry
      // with a `q` the room agrees with. Loud, because it means this copy's
      // sequence counter drifted ahead of the room, which is a bug to find.
      console.warn('[bento-sync] relay refused a snapshot ahead of the room’s seq — nothing lost', env)
      return
    }
    if (env.code !== 'too-large' && env.code !== 'storage-failed' && env.code !== 'room-full') {
      // a code from a newer relay: no recovery we can invent is better than
      // leaving the op in the log, where `need` will retry it honestly
      console.warn('[bento-sync] relay refused a frame:', env.code)
      return
    }
    const culprit = this.matchRefused(env)
    if (culprit) this.awaitingAck = this.awaitingAck.filter((o) => o !== culprit)
    console.warn(`[bento-sync] relay refused a frame (${env.code})`, env)
    this.hooks.onRefused?.(env.code, culprit?.ops ?? null)
  }

  /**
   * Which frame does this refusal name? The relay quotes no id, so: head of
   * the ack queue by protocol order, CONFIRMED against the size it reported.
   * A mismatch means the refusal was for a frame we don't track — snapshots
   * are never acked, so they never enter the queue — and we must not hand the
   * session somebody else's ops to drop on a guess. Ambiguity → null → the
   * ops stay in the log (retried, at worst refused again and reported again),
   * because a wrong drop is silent permanent data divergence.
   */
  private matchRefused(env: RefusedEnv): Outbound | null {
    // Exact when the relay echoed our id. Everything below is the legacy
    // fallback for relays that don't (and a self-hoster's relay may be a year
    // old) — inferential, so it stays deliberately conservative.
    if (env.k) return this.awaitingAck.find((o) => o.id === env.k) ?? null
    // too-large measures the whole envelope; storage-failed measures i+d only
    const byText = typeof env.got === 'number'
    const want = byText ? env.got! : typeof env.bytes === 'number' ? env.bytes : null
    const size = (o: Outbound) => (byText ? o.text.length : o.bytes)
    const head = this.awaitingAck[0] ?? null
    if (want === null) return head // room-full carries no size — order is all we have
    if (head && size(head) === want) return head
    return this.awaitingAck.find((o) => size(o) === want) ?? null
  }

  /** Rate limited: hold everything for the window, then replay what we sent
   *  into it. Un-acked frames may or may not have landed — re-sending is safe
   *  (the CRDT dedups by actor:seq) and losing them silently is not. */
  private throttle(ms: number) {
    const wait = Math.min(Math.max(ms, 1000), 60_000)
    const retryable = this.awaitingAck.filter((o) => ++o.tries <= OnlineTransport.MAX_RETRIES)
    // past the retry cap we stop re-sending, but the op is NOT dropped: it
    // stays in the session log for the next `need`/reconnect to carry.
    this.awaitingAck = []
    this.queue = [...retryable, ...this.queue]
    if (this.pauseTimer) clearTimeout(this.pauseTimer)
    this.paused = true
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null
      this.paused = false
      for (const out of this.queue.splice(0)) this.write(out)
    }, wait)
    // transient and self-healing, so say it at most once a minute
    const now = Date.now()
    if (now - this.lastLimitNotice > 60_000) {
      this.lastLimitNotice = now
      this.hooks.onRefused?.('rate-limited', null)
    }
  }

  /** write now, or park it (disconnected, or inside a rate-limit backoff) */
  private write(out: Outbound) {
    if (!this.paused && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(out.text)
      } catch {
        this.park(out) // send threw → onclose will reconnect and flush
        return
      }
      if (out.ops) {
        this.awaitingAck.push(out)
        if (this.awaitingAck.length > OnlineTransport.ACK_WINDOW) this.awaitingAck.shift()
      }
      return
    }
    this.park(out)
  }

  private park(out: Outbound) {
    this.queue.push(out)
    if (this.queue.length > 500) this.queue.shift()
  }

  private async onEnvelope(text: string) {
    let env: {
      i?: string; d?: string; q?: number; snap?: number; ctl?: string; p?: string
      /** the writer signature the relay VERIFIED before fanning this out */
      g?: string
      /** blob write ticket — only ever sent to a socket that proved its key */
      wt?: string
      /** possession nonce on `ready`: sign it to prove the `?w=` key is ours */
      c?: string
      /** broadcast: the audience stream tag, the verb name, the count */
      s?: string
      n?: number
    } & RefusedEnv
    try {
      env = JSON.parse(text)
    } catch {
      return
    }
    // the owner revoked a key; if it's OURS, stand down for good (the relay
    // refuses our reconnects anyway — don't retry into a wall of 403s)
    if (env.ctl === 'revoked') {
      if (env.p && env.p === this.myPub) {
        console.info('[bento-sync] this copy’s access was revoked by the owner')
        this.close()
        return
      }
      // a removal re-mints the room's blob ticket (the removed copy still holds
      // the old one); the relay sends the replacement to PROVEN sockets only
      if (typeof env.wt === 'string') this.writeTicket = env.wt
      return
    }
    // The ticket arrives on its own frame, after `prove` — never on `ready`.
    // Presenting the owner's PUBLIC key hash-matches the room name, and every
    // reader copy carries that key; a ticket issued on the hash-match alone
    // would go to any reader. Only a socket that signed the relay's nonce with
    // the matching PRIVATE key is handed one.
    if (env.ctl === 'wt') {
      if (typeof env.wt === 'string') this.writeTicket = env.wt
      this.resolveWriteReady()
      return
    }
    // the relay would not take a frame and said so (v1.0.9 relay and later;
    // older relays never send this, which is why every path here is additive)
    if (env.ctl === 'refused') {
      this.handleRefusal(env)
      return
    }
    // ——— broadcast control, no encrypted body ———
    if (env.ctl === 'audckpt') { this.hooks.onShowCheckpoint?.(); return }
    if (env.ctl === 'audcount') { if (typeof env.n === 'number') this.hooks.onShowCount?.(env.n); return }
    if (env.ctl === 'ack' || env.ctl === 'ready') {
      // one ack = the oldest un-acked persisted frame landed
      if (env.ctl === 'ack') this.awaitingAck.shift()
      if (typeof env.q === 'number') {
        this.saveSeq(env.q)
        this.maybeSnapshot(env.q)
      }
      if (env.ctl === 'ready' && typeof env.q !== 'number') {
        // An AUDIENCE ready: `bc`/`v`, no `q`. The audience is receive-only and
        // has no op log to replay or snapshot — running the collab path below
        // would make it try to upload one. It is simply live now.
        this.inReplay = false
        this.resolveWriteReady()
        return
      }
      if (env.ctl === 'ready') {
        // `c` is the relay's possession challenge, present only for a socket
        // whose `?w=` hash-matched the room. Answer it and the ticket follows on
        // its own `wt` frame; a reader (no signing key) cannot answer and never
        // gets one. No `c` at all = an older relay, or we joined as a reader —
        // in both cases uploads take the room token and there is nothing to
        // wait for, so writes are released now.
        if (typeof env.c === 'string' && this.signKey && this.roomName) {
          void this.prove(env.c)
        } else {
          this.resolveWriteReady()
        }
        this.inReplay = false
        const wantSnap = this.hooks.onReady(this.replaySeen, env.q ?? 0)
        this.replaySeen = new Set()
        // fresh rooms and just-merged forks get a snapshot immediately so
        // late joiners converge without needing the full op log
        if (wantSnap || env.q === 0) void this.uploadSnapshot(env.q ?? 0)
      }
      return
    }
    if (!env.i || !env.d || !this.key) return
    let payload: unknown
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64u.dec(env.i) as BufferSource },
        this.key,
        b64u.dec(env.d) as BufferSource,
      )
      payload = JSON.parse(new TextDecoder().decode(pt))
    } catch {
      return // wrong key / corrupted — ignore
    }
    if (typeof env.q === 'number') this.saveSeq(env.q)
    // ——— broadcast reception (audience side). These arrive pre-routed by the
    // relay, which only fans them to audience sockets and verified every
    // signed one; the payload is under Ke, which only show participants hold.
    // So they do not go through vouched() — that is the ROOM's read-only
    // guarantee, a different trust path from the relay-routed show stream. ———
    if (env.s === 'aud' && !env.ctl) {
      const f = payload as { ops?: Op[] }
      if (f?.ops) this.hooks.onShowOps?.(f.ops)
      return
    }
    if (env.ctl === 'audsnap') {
      const sn = payload as { doc: SyncDoc; state: SyncStateJSON }
      if (sn?.doc && sn.state) this.hooks.onShowSnap?.(sn.doc, sn.state)
      return
    }
    if (env.ctl === 'nav' || env.ctl === 'black' || env.ctl === 'laser') {
      this.hooks.onShowVerb?.(env.ctl, payload)
      return
    }
    if (env.snap === 1) {
      if (!this.vouched(env)) return
      const s = payload as { doc: SyncDoc; state: SyncStateJSON }
      if (s && s.doc && s.state) this.hooks.onSnap(s.doc, s.state)
      return
    }
    const frame = payload as Frame
    // Decrypting a frame proves the sender holds the READ key — which every
    // copy carries, read-only ones included. Authorship is a separate question
    // and only the relay can answer it, so content-bearing frames are refused
    // without its stamp.
    if ((frame.t === 'ops' || frame.t === 'snap') && !this.vouched(env)) return
    if (this.inReplay && frame.t === 'ops') {
      for (const op of frame.ops) this.replaySeen.add(`${op.a}:${op.s}`)
    }
    this.onFrame(frame)
  }

  private inReplay = true

  /**
   * Did the relay vouch for this envelope? In a signed room it stamps exactly
   * what it checked: `q` on a frame it persisted (verified before storage) and
   * an echoed `g` on a signed frame it fanned out. An unstamped frame reached
   * us because someone encrypted it with the room key — a read-only copy can
   * do that, and a blind relay cannot tell the ciphertext of an op batch from
   * the ciphertext of a presence beat, so it forwards both. Refusing the
   * unstamped ones HERE is what makes read-only hold for live peers and not
   * just for the persisted log.
   *
   * Legacy `r` rooms have no signatures at all: gating them would drop every
   * frame, so they stay on the pre-signing trust model.
   */
  private vouched(env: { q?: number; g?: string }): boolean {
    return !this.signedRoom || typeof env.q === 'number' || typeof env.g === 'string'
  }

  /** Answer the relay's possession challenge: sign `prove.<nonce>.<room>` with
   *  the key we presented as `?w=`. The room name is in the signed text so a
   *  signature can never be replayed into another room, and the nonce is
   *  per-socket and single-use so it cannot be replayed into this one. */
  private async prove(nonce: string) {
    if (!this.signKey || !this.ws) return
    try {
      const g = await signWith(this.signKey, `prove.${nonce}.${this.roomName}`)
      this.ws.send(JSON.stringify({ ctl: 'prove', g }))
    } catch {
      // cannot sign → we are effectively a reader; do not hold writes forever
      this.resolveWriteReady()
    }
  }

  private snapInFlight = false

  /** every SNAP_EVERY persisted ops, upload a fresh encrypted snapshot */
  private maybeSnapshot(q: number) {
    if (q === 0 || q % SNAP_EVERY !== 0) return
    void this.uploadSnapshot(q)
  }

  /** encrypt + store the current (doc, state) as the room's snapshot */
  async uploadSnapshot(q: number) {
    if (this.snapInFlight) return
    this.snapInFlight = true
    try {
      const snap = this.hooks.getSnapshot()
      const text = await this.encrypt(JSON.stringify(snap))
      if (text && this.ws && this.ws.readyState === WebSocket.OPEN) {
        const env: Record<string, unknown> = { snap: 1, q, i: text.i, d: text.d }
        if (this.signKey) env.g = await signFrame(this.signKey, text.i, text.d)
        this.ws.send(JSON.stringify(env))
      }
    } finally {
      this.snapInFlight = false
    }
  }

  private async encrypt(plain: string, key: CryptoKey | null = this.key): Promise<{ i: string; d: string } | null> {
    if (!key) return null
    const iv = new Uint8Array(12)
    crypto.getRandomValues(iv)
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plain),
    )
    return { i: b64u.enc(iv), d: b64u.enc(new Uint8Array(ct)) }
  }

  // ——— BROADCAST: the presenter's audience stream ———
  // The presenter's socket carries the room key (this.key). A show's audience
  // holds a SEPARATE show key Ke; the presenter encrypts a second copy of each
  // op batch and each control frame under Ke, tagged s:'aud', and the relay
  // routes those to audience sockets only. Only the presenter side needs this:
  // an audience copy's own this.key already IS Ke (its collab.key is the show
  // key), so it decrypts s:'aud' frames on the ordinary path below.
  private showKey: CryptoKey | null = null

  /** Install (or clear) the show key. Raw AES-GCM key, base64url. */
  async setShowKey(rawB64: string | null): Promise<void> {
    if (this.audienceMode) return
    this.showKey = rawB64
      ? await crypto.subtle.importKey('raw', b64u.dec(rawB64) as BufferSource, 'AES-GCM', false, ['encrypt'])
      : null
  }

  /** One op batch to the audience: sealed under Ke, tagged s:'aud'. NEVER
   *  persisted by the relay (it ignores p on this stream), so it does not join
   *  the resend log — a dropped aud batch is recovered by the next audsnap, not
   *  by replay. Silent no-op if there is no show key or the socket is gone. */
  async sendAud(ops: Op[]): Promise<void> {
    if (this.audienceMode) return
    const enc = await this.encrypt(JSON.stringify({ t: 'ops', a: 'show', ops }), this.showKey)
    if (!enc || !this.ws) return
    try { this.ws.send(JSON.stringify({ s: 'aud', i: enc.i, d: enc.d })) } catch { /* gone */ }
  }

  /** The whole (already app-projected) document to the audience, under Ke. */
  async sendAudSnap(doc: SyncDoc, state: SyncStateJSON): Promise<void> {
    if (this.audienceMode) return
    const enc = await this.encrypt(JSON.stringify({ doc, state }), this.showKey)
    if (!enc || !this.ws) return
    try { this.ws.send(JSON.stringify({ ctl: 'audsnap', i: enc.i, d: enc.d })) } catch { /* gone */ }
  }

  /** A control verb. live/end sign the literal; nav/black encrypt their payload
   *  under Ke and sign the ciphertext with the stream in the text (so a
   *  room-stream signature cannot be replayed as the audience's); laser is
   *  unsigned. The relay checks all of this against the socket's proven key. */
  async sendVerb(kind: 'live' | 'end' | 'nav' | 'black' | 'laser', payload?: unknown): Promise<void> {
    if (this.audienceMode || !this.ws) return
    try {
      if (kind === 'live' || kind === 'end') {
        const g = this.signKey ? await signWith(this.signKey, kind) : undefined
        this.ws.send(JSON.stringify({ ctl: kind, g }))
        return
      }
      const enc = await this.encrypt(JSON.stringify(payload ?? null), this.showKey)
      if (!enc) return
      if (kind === 'laser') {
        this.ws.send(JSON.stringify({ ctl: 'laser', s: 'aud', i: enc.i, d: enc.d }))
        return
      }
      const g = this.signKey ? await signFrame(this.signKey, `${kind}.aud.${enc.i}`, enc.d) : undefined
      this.ws.send(JSON.stringify({ ctl: kind, s: 'aud', i: enc.i, d: enc.d, g }))
    } catch { /* gone */ }
  }

  send(frame: Frame) {
    // An audience socket is receive-only: it never puts a protocol frame on the
    // wire (the relay would drop it, but not sending it is the guarantee). The
    // keepalive ping is not a protocol frame and is left alone.
    if (this.audienceMode) return
    void (async () => {
      const enc = await this.encrypt(JSON.stringify(frame))
      if (!enc) return
      let env: Record<string, unknown> = enc
      let ops: Op[] | null = null
      const id = nextFrameId()
      if (frame.t === 'ops') {
        env = { k: id, p: 1, ...enc }
        // sign the ciphertext so the relay verifies authorship while blind.
        if (this.signKey) env.g = await signFrame(this.signKey, enc.i, enc.d)
        ops = frame.ops
      } else if (frame.t === 'snap' && this.signKey) {
        // A rejoining fork's snapshot is ephemeral (never persisted) but it
        // REPLACES what every live peer holds — the same authority as an op
        // batch, and it used to travel unsigned. Sign it so the relay can
        // vouch for it; peers now refuse a `snap` it hasn't stamped.
        env = { ...enc, g: await signFrame(this.signKey, enc.i, enc.d) }
      }
      // remember what rode in the frame so a refusal can name it
      this.write({ id, text: JSON.stringify(env), ops, bytes: enc.i.length + enc.d.length, tries: 0 })
    })()
  }

  close() {
    this.closed = true
    if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null }
    this.stopHeartbeat()
    this.ws?.close()
    this.ws = null
    this.setStatus('closed')
  }

  /** OWNER action: revoke one member key (or an invite key — cutting off every
   *  copy descended from that invite). Signed `rev.${pub}`; the relay stores it,
   *  drops that key's future writes/joins, and fans out a `revoked` note. */
  async revokeKey(pub: string, ownerPub: string, ownerPriv: string): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    const g = await signText(ownerPriv, `rev.${pub}`)
    this.ws.send(JSON.stringify({ ctl: 'revoke', p: pub, o: ownerPub, g }))
    return true
  }
}

// --- share/join glue --------------------------------------------------------

let active: OnlineTransport | null = null

export function onlineTransport(): OnlineTransport | null {
  return active
}

/** inert stand-in when a re-keyed document has no collab config */
class NullTransport implements Transport {
  readonly kind = 'off'
  send() {}
  close() {}
}

/** does this document want its relay connected? (absent `on` = true: v0.8.0
 * files only carried collab while actively shared) */
export function sharingOn(store: Store): boolean {
  const c = store.doc.collab
  return !!c?.room && !!c.key && c.on !== false
}

/** connect the session to the relay in doc.collab (no-op unless sharing is on) */
export function joinFromDoc(session: SyncSession, store: Store): OnlineTransport | null {
  if (offlineEnabled()) return null // the hard no-network switch wins over everything
  if (active) return active
  if (!sharingOn(store)) return null
  session.addTransport((docId, onFrame) => {
    // re-invoked whenever the session re-keys (doc replaced): consult the
    // CURRENT document — its collab config may differ or be off
    const collab = store.doc.collab
    if (!collab?.room || !collab.key || collab.on === false || store.doc.docId !== docId) {
      active = null
      return new NullTransport()
    }
    active?.close()
    // Auth shape per copy: reader → none (unsigned, relay drops writes);
    // v2 owner → direct with ownerPriv; v2 member → invite chain (device key
    // minted per-machine); legacy → the shared writer key pair.
    let auth: AuthSpec | undefined
    if (collab.role === 'audience') {
      // An AUDIENCE copy: its collab.key is the show key Ke, its invite is the
      // owner-signed `audience` ticket. It joins on the chain (ivr=audience,
      // set from the invite role) and the transport makes it receive-only. No
      // audience invite, no join — there is nothing to fall back to.
      if (collab.owner && collab.invite) {
        auth = { kind: 'chain', owner: collab.owner, invite: collab.invite, docId }
      }
    } else if (collab.role !== 'reader') {
      if (collab.v === 2 && collab.owner && collab.ownerPriv) {
        auth = { kind: 'direct', pub: collab.owner, priv: collab.ownerPriv }
      } else if (collab.v === 2 && collab.owner && collab.invite) {
        auth = { kind: 'chain', owner: collab.owner, invite: collab.invite, docId }
      } else if (collab.writerPub) {
        auth = { kind: 'direct', pub: collab.writerPub, priv: collab.writerPriv }
      }
    }
    active = new OnlineTransport(collab.room, collab.key, docId, onFrame, {
      onSnap: (doc, state) => session.applySnapshot(doc, state),
      getSnapshot: () => session.snapshot(),
      onOpen: () => session.hello(),
      onReady: (seen) => session.onRelayReady(seen),
      onRefused: (code, ops) => {
        // show-full is a broadcast refusal: it means "checkpoint now", handled
        // by the show path, not the collab resend log.
        if ((code as string) === 'show-full') { session.showCheckpoint(); return }
        session.refused(code, ops)
      },
      onShowOps: (ops) => session.applyShowOps(ops),
      onShowSnap: (doc, state) => session.applyShowSnap(doc, state),
      onShowVerb: (kind, payload) => session.showVerb(kind, payload),
      onShowCheckpoint: () => session.showCheckpoint(),
      onShowCount: (n) => session.showCount(n),
      onShowClosed: (code) => session.showClosed(code),
    }, auth)
    return active
  })
  return active
}

/** flip sharing on and connect — the "Start live session" action.
 * Credentials already exist (minted at creation); this only arms them. */
export async function startSharing(session: SyncSession, store: Store): Promise<OnlineTransport | null> {
  if (offlineEnabled()) return null
  if (active) return active
  if (!store.doc.collab) {
    const creds = await mintCollab()
    store.commit(() => { store.doc.collab = creds })
  }
  store.commit(() => { store.doc.collab!.on = true })
  return joinFromDoc(session, store)
}

/**
 * Offline-mode disconnect: drop the relay WITHOUT touching doc.collab.on —
 * the document's sharing intent is unchanged; this viewer just won't
 * network. Turning offline mode off re-joins via the normal path.
 */
export function disconnectOnline(session: SyncSession) {
  if (active) {
    session.removeTransport(active)
    active = null
  }
}

/** flip sharing off and disconnect. Credentials stay — copies saved during
 * the session can rejoin if sharing is turned back on. */
export function stopSharing(session: SyncSession, store: Store) {
  if (active) {
    session.removeTransport(active)
    active = null
  }
  if (store.doc.collab && store.doc.collab.on !== false) {
    store.commit(() => {
      store.doc.collab!.on = false
    })
  }
}

/** revocation: mint a fresh room + key. Every previously sent copy loses
 * access; only copies saved AFTER this can join future sessions. */
export async function rotateKeys(session: SyncSession, store: Store) {
  stopSharing(session, store)
  const fresh = await mintCollab()
  store.commit(() => {
    const sync = store.doc.collab?.sync
    store.doc.collab = sync ? { ...fresh, sync } : fresh
  })
}
