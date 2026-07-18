// bento-sync session — the bridge between the CRDT engine (crdt.ts) and the
// running editor. Owns: the differ hook on the store, transports (same-machine
// BroadcastChannel always; an online relay transport can be added), presence,
// and peer catch-up. See docs/collab-design.md.
//
// Wire protocol (one JSON frame per message; E2EE happens inside the online
// transport — this layer never knows):
//   {t:'hello', a, vv, p}    join/announce — receivers reply hello + missing ops
//   {t:'ops',   a, ops}      op batch
//   {t:'need',  a, vv}       gap catch-up request (receivers send missing ops)
//   {t:'p',     a, p}        presence heartbeat   {t:'bye', a}  leave
//
// The differ is the whole integration: every local mutation already flows
// through store.commit/touch → 'doc' event → (debounced) diff against the
// session's shadow → ops out. Remote ops apply surgically by id and re-emit
// the same store events the editor already listens to. Zero editor rewrites.

import type { Store } from '../store'
import type { BentoDoc, Slide } from '../model'
import { uid } from '../model'
import { SyncState, SYNC_V, type Op } from './crdt'
import { mintCollab } from './online'

export interface PresenceInfo {
  name: string
  color: string
  /** current slide id */
  slide: string
  /** selected element ids */
  sel: string[]
  /** element id currently being text-edited (in-text presence) */
  editing?: string
}

export interface Peer extends PresenceInfo {
  actor: string
  at: number
}

interface HelloFrame { t: 'hello'; a: string; vv: Record<string, number>; p: PresenceInfo }
interface OpsFrame { t: 'ops'; a: string; ops: Op[] }
interface NeedFrame { t: 'need'; a: string; vv: Record<string, number> }
interface PresFrame { t: 'p'; a: string; p: PresenceInfo }
interface ByeFrame { t: 'bye'; a: string }
/** state-based fork merge: a rejoining offline-edited copy announces itself */
interface SnapFrame {
  t: 'snap'
  a: string
  doc: BentoDoc
  state: import('./crdt').SyncStateJSON
}
/** every frame is stamped with the sync protocol version (`pv: SYNC_V`) by
 * send(); frames without the current pv (old builds, stale relay logs from
 * the bare-id era) are dropped in onFrame — their keys don't interoperate */
export type Frame = (HelloFrame | OpsFrame | NeedFrame | PresFrame | ByeFrame | SnapFrame) & {
  pv?: number
}

export interface Transport {
  readonly kind: string
  send(frame: Frame): void
  close(): void
}

/** Same-machine transport: every open tab/window of this document. */
class BroadcastTransport implements Transport {
  readonly kind = 'local'
  private ch: BroadcastChannel
  constructor(docId: string, onFrame: (f: Frame) => void) {
    this.ch = new BroadcastChannel(`bento-sync-${docId}`)
    this.ch.onmessage = (ev) => onFrame(ev.data as Frame)
  }
  send(frame: Frame) {
    this.ch.postMessage(frame)
  }
  close() {
    this.ch.close()
  }
}

const PEER_COLORS = ['#FF9E8A', '#8FA3BF', '#7FC8A9', '#E8C468', '#C792EA', '#6AB7D6', '#E88AB0', '#A9C77F']

const actorColor = (actor: string): string => {
  let h = 0
  for (let i = 0; i < actor.length; i++) h = (h * 31 + actor.charCodeAt(i)) >>> 0
  return PEER_COLORS[h % PEER_COLORS.length]
}

/**
 * Actor id: fresh per SESSION INSTANCE, deliberately — a reloaded tab is a
 * new replica with empty CRDT state, and the engine skips "own" ops on
 * apply, so reusing an id would make relay replay of the previous
 * incarnation's ops a no-op. Random ids sidestep the whole class.
 */
function tabActor(): string {
  return Math.random().toString(36).slice(2, 10)
}

const DIFF_DEBOUNCE_MS = 90
const HEARTBEAT_MS = 5000
const PEER_TTL_MS = 13000

export class SyncSession {
  readonly actor: string
  state!: SyncState
  private shadow = ''
  private docId = ''
  private log: Op[] = []
  private transports: Transport[] = []
  private peersMap = new Map<string, Peer>()
  private applying = false
  private diffTimer: number | null = null
  private heartbeat: number | null = null
  private peerListeners = new Set<() => void>()
  private editingEl: string | undefined
  /** extra transports (the online relay) get plugged in here */
  private makeExtraTransports: Array<(docId: string, onFrame: (f: Frame) => void) => Transport> = []

  constructor(private store: Store) {
    this.actor = tabActor()
    this.attach()
    store.on('doc', () => this.onLocalChange())
    store.on('current', () => this.pushPresence())
    store.on('selection', () => this.pushPresence())
    window.addEventListener('beforeunload', () => this.broadcast({ t: 'bye', a: this.actor }))
  }

  // --- lifecycle -----------------------------------------------------------

  /** a restored offline fork still owes the room its snapshot */
  private forkPending = false

  private attach() {
    this.docId = this.store.doc.docId
    const doc = this.store.doc
    // credentials are minted AT CREATION (Andy's call): any copy of the
    // file can join once sharing is turned on — "send first, share later"
    // just works. Dormant (on:false) until the Share button flips it.
    if (!doc.collab) doc.collab = mintCollab()
    const saved = doc.collab?.sync
    if (saved && saved.v === SYNC_V) {
      // this file was saved during/after a shared session: restore the CRDT
      // state so our offline edits carry real registers, remote replay
      // dedups by version vector, and a state-based snapshot exchange can
      // merge the fork BOTH ways (see docs/collab-design.md)
      this.state = SyncState.fromJSON(this.actor, JSON.parse(JSON.stringify(saved)))
      this.forkPending = true
    } else {
      // no saved state, or state from the pre-composite-key era (v1) — that
      // scheme collapsed same-id-on-many-slides, so it is discarded and the
      // file joins as a never-synced adopt (deterministic keys from the doc)
      this.state = new SyncState(this.actor)
    }
    this.state.adopt(doc)
    this.shadow = JSON.stringify(doc)
    this.log = []
    this.peersMap.clear()
    this.emitPeers()
    for (const tr of this.transports) tr.close()
    this.transports = [new BroadcastTransport(this.docId, (f) => this.onFrame(f))]
    for (const mk of this.makeExtraTransports) this.transports.push(mk(this.docId, (f) => this.onFrame(f)))
    this.hello() // announces + (for restored forks) broadcasts the state snapshot
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = window.setInterval(() => {
      this.pushPresence()
      this.sweepPeers()
    }, HEARTBEAT_MS)
  }

  /** register a factory for an additional transport (online relay) and connect it */
  addTransport(mk: (docId: string, onFrame: (f: Frame) => void) => Transport): Transport {
    this.makeExtraTransports.push(mk)
    const tr = mk(this.docId, (f) => this.onFrame(f))
    this.transports.push(tr)
    this.broadcast({ t: 'hello', a: this.actor, vv: this.state.vv, p: this.presence() })
    return tr
  }

  removeTransport(tr: Transport) {
    tr.close()
    this.transports = this.transports.filter((x) => x !== tr)
    this.makeExtraTransports = []
  }

  get transportKinds(): string[] {
    return this.transports.map((t) => t.kind)
  }

  // --- local mutations → ops ----------------------------------------------

  private onLocalChange() {
    if (this.applying) return
    if (this.store.doc.docId !== this.docId) {
      // replaceDoc / loadDoc swapped in a different document — re-key
      this.attach()
      return
    }
    if (this.diffTimer) return
    this.diffTimer = window.setTimeout(() => {
      this.diffTimer = null
      this.flush()
    }, DIFF_DEBOUNCE_MS)
  }

  /** diff now (also called before presence-relevant transitions) */
  flush() {
    if (this.applying) return
    const before = JSON.parse(this.shadow) as BentoDoc
    const ops = this.state.diff(before, this.store.doc, { text: true })
    this.shadow = JSON.stringify(this.store.doc)
    if (!ops.length) return
    this.log.push(...ops)
    this.broadcast({ t: 'ops', a: this.actor, ops })
  }

  // --- remote frames --------------------------------------------------------

  private onFrame(f: Frame) {
    if (f.pv !== SYNC_V) return // old-protocol frame (bare-id keys) — ignore
    if (f.a === this.actor) return
    switch (f.t) {
      case 'hello': {
        this.touchPeer(f.a, f.p)
        // answer so the newcomer learns us + catch them up from our log,
        // AND tell them our vv so ops they minted before connecting (which
        // nothing else would push) flow back to us — need→ops terminates
        this.send({ t: 'p', a: this.actor, p: this.presence() })
        this.send({ t: 'need', a: this.actor, vv: this.state.vv })
        const missing = this.state.missingFor(this.log, f.vv)
        if (missing.length) this.send({ t: 'ops', a: this.actor, ops: missing })
        break
      }
      case 'ops':
        this.applyRemote(f.ops)
        break
      case 'need': {
        const missing = this.state.missingFor(this.log, f.vv)
        if (missing.length) this.send({ t: 'ops', a: this.actor, ops: missing })
        break
      }
      case 'p':
        this.touchPeer(f.a, f.p)
        break
      case 'snap':
        this.applySnapshot(f.doc, f.state)
        break
      case 'bye':
        this.peersMap.delete(f.a)
        this.emitPeers()
        break
    }
  }

  applyRemote(ops: Op[]) {
    // make sure our own pending edits are diffed first (they pre-date the
    // remote batch locally; LWW settles the rest)
    this.flush()
    for (const op of ops) if (!this.log.some((o) => o.a === op.a && o.s === op.s)) this.log.push(op)
    this.applying = true
    try {
      const res = this.state.apply(this.store.doc, ops)
      if (res.changed) this.afterRemoteChange(res.structure)
    } finally {
      this.applying = false
    }
    if (this.state.gappedActors.length) {
      this.send({ t: 'need', a: this.actor, vv: this.state.vv })
    }
  }

  private afterRemoteChange(structure: boolean) {
    const store = this.store
    // an all-slides-deleted race leaves an empty deck — heal with a blank
    if (store.doc.slides.length === 0) {
      const blank: Slide = {
        id: uid('s'),
        background: store.doc.theme.background,
        transition: 'fade',
        elements: [],
        notes: '',
      }
      store.doc.slides.push(blank)
      // mint it as a local op so every replica converges on ONE healer's
      // slide (LWW keeps all healers' slides; harmless extra blanks)
      this.applying = false
      this.flush()
      this.applying = true
    }
    store.currentIndex = Math.min(store.currentIndex, store.doc.slides.length - 1)
    const sel = store.selection.filter((id) => store.element(id))
    const selChanged = sel.length !== store.selection.length
    store.selection = sel
    this.shadow = JSON.stringify(store.doc)
    store.doc.modified = new Date().toISOString()
    store.setDirty(true)
    store.emit('doc')
    if (structure) {
      store.emit('slides')
      store.emit('current')
    }
    if (selChanged) store.emit('selection')
  }

  // --- presence -------------------------------------------------------------

  private presence(): PresenceInfo {
    let name = 'Guest'
    try {
      name = localStorage.getItem('bento-author') || 'Guest'
    } catch {
      /* storage unavailable */
    }
    return {
      name,
      color: actorColor(this.actor),
      slide: this.store.slide?.id ?? '',
      sel: this.store.selection.slice(),
      ...(this.editingEl ? { editing: this.editingEl } : {}),
    }
  }

  /** canvas hooks this while a text element is being edited (M3 presence) */
  setEditing(elId: string | undefined) {
    if (this.editingEl === elId) return
    this.editingEl = elId
    this.pushPresence()
  }

  private pushPresence() {
    this.send({ t: 'p', a: this.actor, p: this.presence() })
  }

  private touchPeer(actor: string, p: PresenceInfo) {
    this.peersMap.set(actor, { ...p, actor, at: Date.now() })
    this.emitPeers()
  }

  private sweepPeers() {
    const cut = Date.now() - PEER_TTL_MS
    let changed = false
    for (const [a, p] of this.peersMap) {
      if (p.at < cut) {
        this.peersMap.delete(a)
        changed = true
      }
    }
    if (changed) this.emitPeers()
  }

  peers(): Peer[] {
    return [...this.peersMap.values()].sort((a, b) => (a.actor < b.actor ? -1 : 1))
  }

  onPeers(fn: () => void): () => void {
    this.peerListeners.add(fn)
    return () => this.peerListeners.delete(fn)
  }

  private emitPeers() {
    this.peerListeners.forEach((fn) => fn())
  }

  // --- snapshots (online catch-up + file-fork merge) ------------------------

  /** current (doc, sync-state) pair for an encrypted relay snapshot */
  snapshot(): { doc: BentoDoc; state: import('./crdt').SyncStateJSON } {
    this.flush()
    return {
      doc: JSON.parse(JSON.stringify(this.store.doc)) as BentoDoc,
      state: JSON.parse(JSON.stringify(this.state.toJSON())),
    }
  }

  /** merge a remote snapshot (relay replay for far-behind joiners) */
  applySnapshot(rdoc: BentoDoc, rstate: import('./crdt').SyncStateJSON) {
    if (!rstate || rstate.v !== SYNC_V) return // pre-v2 room snapshot — unusable
    this.flush()
    this.applying = true
    try {
      const res = this.state.mergeSnapshot(this.store.doc, rdoc, rstate)
      if (res.changed) this.afterRemoteChange(true)
    } finally {
      this.applying = false
    }
  }

  /** re-announce (an online transport reconnected) */
  hello() {
    this.broadcast({ t: 'hello', a: this.actor, vv: this.state.vv, p: this.presence() })
    if (this.forkPending) {
      // rejoining offline fork: our contributions live in doc values +
      // restored registers, not ops — a state snapshot is how they travel
      const s = this.snapshot()
      this.broadcast({ t: 'snap', a: this.actor, doc: s.doc, state: s.state })
    }
  }

  /**
   * Relay replay finished. `seen` holds the (actor,seq) pairs the room
   * already has; anything in our log it lacks gets (re)sent for persistence
   * — covers ops minted before the transport connected. Returns whether a
   * fresh server snapshot should be uploaded (fork just merged).
   */
  onRelayReady(seen: Set<string>): boolean {
    const missing = this.log.filter((o) => !seen.has(`${o.a}:${o.s}`))
    if (missing.length) this.send({ t: 'ops', a: this.actor, ops: missing })
    const fork = this.forkPending
    this.forkPending = false
    return fork
  }

  /**
   * Stamp the CRDT state into doc.collab.sync so the SAVED file can rejoin
   * as a true fork later. Called by the save/serialize paths; only shared
   * documents carry it (never-shared files stay clean).
   */
  stampInto(doc: BentoDoc) {
    if (!doc.collab || doc.collab.on === false) return
    this.flush()
    doc.collab.sync = JSON.parse(JSON.stringify(this.state.toJSON()))
  }

  // --- plumbing -------------------------------------------------------------

  private send(frame: Frame) {
    const stamped = { ...frame, pv: SYNC_V }
    for (const tr of this.transports) tr.send(stamped)
  }

  private broadcast(frame: Frame) {
    this.send(frame)
  }
}
