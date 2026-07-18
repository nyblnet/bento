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
    },
  ) {
    void docId
    this.init(room)
  }

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
    this.onFrame(payload as Frame)
  }

  private snapInFlight = false

  /** every SNAP_EVERY persisted ops, upload a fresh encrypted snapshot */
  private async maybeSnapshot(q: number) {
    if (q === 0 || q % SNAP_EVERY !== 0 || this.snapInFlight) return
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

/** connect the session to the relay named in doc.collab (no-op without it) */
export function joinFromDoc(session: SyncSession, store: Store): OnlineTransport | null {
  if (active) return active
  if (!store.doc.collab?.room || !store.doc.collab.key) return null
  session.addTransport((docId, onFrame) => {
    // re-invoked whenever the session re-keys (doc replaced): consult the
    // CURRENT document — its collab config may differ or be absent
    const collab = store.doc.collab
    if (!collab?.room || !collab.key || store.doc.docId !== docId) {
      active = null
      return new NullTransport()
    }
    active?.close()
    active = new OnlineTransport(collab.room, collab.key, docId, onFrame, {
      onSnap: (doc, state) => session.applySnapshot(doc, state),
      getSnapshot: () => session.snapshot(),
      onOpen: () => session.hello(),
    })
    return active
  })
  return active
}

/** mint a key, stamp doc.collab, connect — the "Start live session" action */
export function startSharing(session: SyncSession, store: Store): OnlineTransport {
  if (active) return active
  const room = `${syncHost()}/d/${encodeURIComponent(store.doc.docId)}`
  const key = mintRoomKey()
  store.commit(() => {
    store.doc.collab = { room, key }
  })
  return joinFromDoc(session, store)!
}

/** drop doc.collab and disconnect — the "Stop sharing" action */
export function stopSharing(session: SyncSession, store: Store) {
  if (active) {
    session.removeTransport(active)
    active = null
  }
  if (store.doc.collab) {
    store.commit(() => {
      delete store.doc.collab
    })
  }
}
