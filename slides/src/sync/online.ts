// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// bento-sync online transport — E2EE WebSocket to the blind relay
// (server/sync-worker). Every session frame is AES-GCM encrypted with the
// room key from doc.collab.key; the relay sees ciphertext, fan-out routing,
// and nothing else. Auth is possession-proof: ?tok= is a hash of the key.
//
// Reconnects with backoff; frames queue while disconnected; op frames are
// persisted server-side (envelope {p:1}) and replayed to joiners from their
// last acked seq, with client-produced encrypted snapshots capping replay
// length. See docs/collab-design.md.

import type { Store } from '../store'
import type { BentoDoc } from '../model'
import type { SyncStateJSON } from './crdt'
import type { Frame, SyncSession, Transport } from './session'
import { offlineEnabled } from '../update'

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

export type CollabCreds = {
  room: string
  key: string
  on: boolean
  writerPub: string
  writerPriv: string
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
  const kp = (await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  const privPk = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))
  const commit = new Uint8Array(await crypto.subtle.digest('SHA-256', pubRaw as BufferSource))
  return {
    room: `${syncHost()}/d/w${b64u.enc(commit)}`,
    key: mintRoomKey(),
    on: true,
    writerPub: b64u.enc(pubRaw),
    writerPriv: b64u.enc(privPk),
    role: 'writer',
  }
}

/** dev override for the relay host (e.g. ws://localhost:8787) */
export function syncHost(): string {
  try {
    return localStorage.getItem('bento-sync-url') || DEFAULT_SYNC_HOST
  } catch {
    return DEFAULT_SYNC_HOST
  }
}

export type OnlineStatus = 'connecting' | 'open' | 'closed'

export class OnlineTransport implements Transport {
  readonly kind = 'online'
  status: OnlineStatus = 'connecting'
  onStatus: ((s: OnlineStatus) => void) | null = null
  private ws: WebSocket | null = null
  private key: CryptoKey | null = null
  /** writer signing key — null for readers (they can decrypt but not author). */
  private signKey: CryptoKey | null = null
  private queue: string[] = []
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
      onSnap: (doc: BentoDoc, state: SyncStateJSON) => void
      getSnapshot: () => { doc: BentoDoc; state: SyncStateJSON }
      onOpen: () => void
      /** replay done: (actor,seq) pairs the room holds; return true to upload a snapshot */
      onReady: (seen: Set<string>, seq: number) => boolean
    },
    private writerPub?: string,
    private writerPriv?: string,
  ) {
    void docId
    this.init(room)
  }

  /** (actor,seq) pairs seen in the current connection's replay */
  private replaySeen = new Set<string>()

  private async init(room: string) {
    const raw = b64u.dec(this.keyB64)
    this.key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ])
    const tokDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw as BufferSource))
    const tok = b64u.enc(tokDigest.slice(0, 18))
    // writers sign op frames; readers omit the key and the relay drops their
    // writes. The pubkey (`w`) rides on the URL so the relay can pin+verify.
    if (this.writerPriv) {
      try { this.signKey = await importSignKey(this.writerPriv) } catch { this.signKey = null }
    }
    this.url = `${room}?tok=${tok}` + (this.writerPub ? `&w=${this.writerPub}` : '')
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
      ws = new WebSocket(`${this.url}&since=${this.lastSeq()}`)
    } catch {
      this.retry()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 800
      this.inReplay = true
      this.replaySeen = new Set()
      this.setStatus('open')
      for (const text of this.queue.splice(0)) ws.send(text)
      this.startHeartbeat(ws)
      this.hooks.onOpen()
    }
    ws.onmessage = (ev) => {
      const data = String(ev.data)
      if (data === 'pong') { this.awaitingPong = false; return } // keepalive reply
      this.onEnvelope(data).catch(() => {})
    }
    const drop = () => {
      if (this.ws !== ws) return
      this.stopHeartbeat()
      this.ws = null
      this.setStatus('closed')
      this.retry()
    }
    ws.onclose = drop
    ws.onerror = drop
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

  private async onEnvelope(text: string) {
    let env: { i?: string; d?: string; q?: number; snap?: number; ctl?: string }
    try {
      env = JSON.parse(text)
    } catch {
      return
    }
    if (env.ctl === 'ack' || env.ctl === 'ready') {
      if (typeof env.q === 'number') {
        this.saveSeq(env.q)
        this.maybeSnapshot(env.q)
      }
      if (env.ctl === 'ready') {
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
    if (env.snap === 1) {
      const s = payload as { doc: BentoDoc; state: SyncStateJSON }
      if (s && s.doc && s.state) this.hooks.onSnap(s.doc, s.state)
      return
    }
    const frame = payload as Frame
    if (this.inReplay && frame.t === 'ops') {
      for (const op of frame.ops) this.replaySeen.add(`${op.a}:${op.s}`)
    }
    this.onFrame(frame)
  }

  private inReplay = true

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

  private async encrypt(plain: string): Promise<{ i: string; d: string } | null> {
    if (!this.key) return null
    const iv = new Uint8Array(12)
    crypto.getRandomValues(iv)
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      this.key,
      new TextEncoder().encode(plain),
    )
    return { i: b64u.enc(iv), d: b64u.enc(new Uint8Array(ct)) }
  }

  send(frame: Frame) {
    void (async () => {
      const enc = await this.encrypt(JSON.stringify(frame))
      if (!enc) return
      let env: Record<string, unknown> = enc
      if (frame.t === 'ops') {
        env = { p: 1, ...enc }
        // sign the ciphertext so the relay verifies authorship while blind.
        if (this.signKey) env.g = await signFrame(this.signKey, enc.i, enc.d)
      }
      const text = JSON.stringify(env)
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(text)
      else {
        this.queue.push(text)
        if (this.queue.length > 500) this.queue.shift()
      }
    })()
  }

  close() {
    this.closed = true
    this.stopHeartbeat()
    this.ws?.close()
    this.ws = null
    this.setStatus('closed')
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
    // readers carry writerPub (to name the room's writer key) but never the
    // private half — so their op frames go unsigned and the relay drops them.
    const priv = collab.role === 'reader' ? undefined : collab.writerPriv
    active = new OnlineTransport(collab.room, collab.key, docId, onFrame, {
      onSnap: (doc, state) => session.applySnapshot(doc, state),
      getSnapshot: () => session.snapshot(),
      onOpen: () => session.hello(),
      onReady: (seen) => session.onRelayReady(seen),
    }, collab.writerPub, priv)
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
