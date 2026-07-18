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

/**
 * Fresh collaboration credentials, minted at DOCUMENT CREATION and dormant
 * (on:false) until sharing starts. The room id is random — never derived
 * from docId — so distinct sharing lineages can never collide on a room
 * (and the relay learns nothing about document identity). Everyone else
 * READS the room from the file; only minting is random.
 */
export function mintCollab(): { room: string; key: string; on: boolean } {
  const id = new Uint8Array(12)
  crypto.getRandomValues(id)
  return { room: `${syncHost()}/d/r${b64u.enc(id)}`, key: mintRoomKey(), on: false }
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
  private queue: string[] = []
  private closed = false
  private backoff = 800
  private url = ''
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
    this.url = `${room}?tok=${tok}`
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
      this.hooks.onOpen()
    }
    ws.onmessage = (ev) => {
      this.onEnvelope(String(ev.data)).catch(() => {})
    }
    const drop = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.setStatus('closed')
      this.retry()
    }
    ws.onclose = drop
    ws.onerror = drop
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
        this.ws.send(JSON.stringify({ snap: 1, q, i: text.i, d: text.d }))
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
      const env = frame.t === 'ops' ? { p: 1, ...enc } : enc
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
    active = new OnlineTransport(collab.room, collab.key, docId, onFrame, {
      onSnap: (doc, state) => session.applySnapshot(doc, state),
      getSnapshot: () => session.snapshot(),
      onOpen: () => session.hello(),
      onReady: (seen) => session.onRelayReady(seen),
    })
    return active
  })
  return active
}

/** flip sharing on and connect — the "Start live session" action.
 * Credentials already exist (minted at creation); this only arms them. */
export function startSharing(session: SyncSession, store: Store): OnlineTransport | null {
  if (offlineEnabled()) return null
  if (active) return active
  store.commit(() => {
    if (!store.doc.collab) store.doc.collab = mintCollab()
    store.doc.collab.on = true
  })
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
export function rotateKeys(session: SyncSession, store: Store) {
  stopSharing(session, store)
  store.commit(() => {
    const fresh = mintCollab()
    const sync = store.doc.collab?.sync
    store.doc.collab = sync ? { ...fresh, sync } : fresh
  })
}
