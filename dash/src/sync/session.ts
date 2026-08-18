// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento-sync session for dash — the bridge between the CRDT engine (crdt.ts)
// and the running workbook. Owns: the patch tap on the store, transports
// (same-machine BroadcastChannel always; an online relay can be added),
// presence, and peer catch-up. Design: docs/dash-collab.md.
//
// Wire protocol (one JSON frame per message; E2EE happens inside the online
// transport — this layer never knows), IDENTICAL to slides':
//   {t:'hello', a, vv, p}    join/announce — receivers reply hello + missing ops
//   {t:'ops',   a, ops}      op batch
//   {t:'need',  a, vv}       gap catch-up request
//   {t:'p',     a, p}        presence heartbeat   {t:'bye', a}  leave
//   {t:'snap',  a, doc, state}  state-based fork merge
//
// WHERE THIS DIFFERS FROM SLIDES, and why. Slides diffs two whole-document
// snapshots on every commit. A dash workbook is 10-25 MB, `JSON.stringify` on
// it costs ~10 ms, and the shadow copy doubles resident memory — so there is
// no shadow here. Ops are minted from the store's own `Patch` objects, which
// already describe every mutation exactly, and they are minted BEFORE the
// store applies them (crdt.ts `local()` explains why it has to be that way).

import type { Store, Patch } from '../store.ts'
import type { DashDoc } from '../model.ts'
import { DashSync, SYNC_V, committable, type Op, type SyncStateJSON } from './crdt.ts'
import { collabOf, mintCollab, type CollabBlock } from './online.ts'
import { lsGet, lsJson } from '../../../kernel/src/storage.ts'

export interface PresenceInfo {
  name: string
  color: string
  /** the sheet this person is looking at */
  sheet: string
  /** v2 fine-grained: the key this copy signs with — key-bound identity */
  pub?: string
  /** capability of this copy, derived locally from its collab material */
  role?: 'owner' | 'editor' | 'viewer'
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
interface SnapFrame { t: 'snap'; a: string; doc: DashDoc; state: SyncStateJSON }

/** Every frame is stamped with the sync protocol version (`pv`); frames
 *  without the current one are dropped, because their keys do not interoperate. */
export type Frame = (HelloFrame | OpsFrame | NeedFrame | PresFrame | ByeFrame | SnapFrame) & { pv?: number }

export interface Transport {
  readonly kind: string
  send(frame: Frame): void
  close(): void
}

/** Why the relay refused a frame. Everything but 'rate-limited' is PERMANENT
 *  for the frame that drew it: retrying can only reproduce the refusal. */
export type RefusalCode = 'too-large' | 'storage-failed' | 'room-full' | 'rate-limited'

export interface SyncNotice {
  code: RefusalCode | 'patch-refused'
  /** true = the change will never reach collaborators; false = retrying */
  permanent: boolean
  /** how many ops (or patches) were abandoned */
  ops: number
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
 * Actor id: fresh per SESSION INSTANCE, deliberately — a reloaded tab is a new
 * replica with empty CRDT state, and the engine skips "own" ops on apply, so
 * reusing an id would make relay replay of the previous incarnation's ops a
 * no-op. Random ids sidestep the whole class.
 */
const tabActor = (): string => Math.random().toString(36).slice(2, 10)

const HEARTBEAT_MS = 5000
const PEER_TTL_MS = 13000

export class SyncSession {
  readonly actor: string
  state!: DashSync
  private store: Store
  private docId = ''
  private log: Op[] = []
  private transports: Transport[] = []
  private peersMap = new Map<string, Peer>()
  private applying = false
  private heartbeat: number | null = null
  private peerListeners = new Set<() => void>()
  private noticeListeners = new Set<(n: SyncNotice) => void>()
  private makeExtraTransports: Array<(docId: string, onFrame: (f: Frame) => void) => Transport> = []
  private forkPending = false
  private bornWithCollab = false
  private explicitShare = false
  /** the current sheet, for presence — view state, never in the document */
  sheet = ''

  constructor(store: Store) {
    this.store = store
    this.actor = tabActor()
    this.attach()
    this.tapStore()
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.broadcast({ t: 'bye', a: this.actor }))
    }
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Should this workbook auto-connect on open? Only if it ARRIVED carrying
   * collab credentials (somebody saved or shared it) or the user opted in this
   * session. A freshly created workbook mints credentials but stays dormant —
   * the starter document must never phone home (PLATFORM §5).
   */
  shareEligible(): boolean {
    return this.bornWithCollab || this.explicitShare
  }

  enableSharing() {
    this.explicitShare = true
  }

  private attach() {
    this.docId = this.store.doc.docId
    const doc = this.store.doc
    this.bornWithCollab = !!doc.collab
    this.explicitShare = false
    if (!doc.collab) void this.ensureCollab()
    const saved = collabOf(doc)?.sync
    if (saved && saved.v === SYNC_V) {
      // saved during/after a shared session: restore the CRDT state so our
      // offline edits carry real registers, relay replay dedups by version
      // vector, and a snapshot exchange can merge the fork BOTH ways
      this.state = DashSync.fromJSON(this.actor, JSON.parse(JSON.stringify(saved)) as SyncStateJSON)
      this.forkPending = true
    } else {
      this.state = new DashSync(this.actor)
    }
    this.state.adopt(doc)
    this.log = []
    this.peersMap.clear()
    this.emitPeers()
    for (const tr of this.transports) tr.close()
    this.transports = [new BroadcastTransport(this.docId, (f) => this.onFrame(f))]
    for (const mk of this.makeExtraTransports) this.transports.push(mk(this.docId, (f) => this.onFrame(f)))
    this.hello()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = (globalThis as { setInterval: typeof setInterval }).setInterval(() => {
      this.pushPresence()
      this.sweepPeers()
    }, HEARTBEAT_MS) as unknown as number
  }

  private async ensureCollab() {
    if (this.store.doc.collab) return
    const creds = await mintCollab()
    if (!this.store.doc.collab) this.store.doc.collab = creds
  }

  // --- the patch tap --------------------------------------------------------

  /**
   * Intercept the store's write verbs.
   *
   * `store.beforePatch` is the real hook: called from `commit`, `runEdit` AND
   * `invert` with the patches about to be applied, and able to replace the
   * list. `afterPatch` is its other half — the CRDT mints ops from the
   * PRE-state (a delete has to be read before it displaces anything) and
   * settles once the document has moved.
   *
   * INVERT IS WHY IT EXISTS. Wrapping the two public verbs on the instance
   * covers every edit the UI makes and cannot see undo or redo, which apply
   * their inverses through a private path — so undo used to fall back to
   * broadcasting a whole state snapshot: correct, and enormously heavier than
   * the two ops it stood in for. The wrapper below is kept for a store that
   * predates the hook.
   */
  private tapStore() {
    const store = this.store as Store & {
      beforePatch?: (fn: (patches: Patch[]) => Patch[] | void) => () => void
      afterPatch?: (fn: () => void) => () => void
    }
    if (typeof store.beforePatch === 'function' && typeof store.afterPatch === 'function') {
      store.beforePatch((patches) => this.localPatches(patches))
      store.afterPatch(() => this.afterLocal())
      return
    }
    const commit = store.commit.bind(store)
    const runEdit = store.runEdit.bind(store)
    const undo = store.undo.bind(store)
    const redo = store.redo.bind(store)
    const replaceDoc = store.replaceDoc.bind(store)
    store.commit = (patches: Patch | Patch[]) => {
      const list = this.localPatches(Array.isArray(patches) ? patches : [patches])
      if (list.length) commit(list)
      this.afterLocal()
    }
    store.runEdit = (cellKey: string, patch: Patch | Patch[]) => {
      const list = this.localPatches(Array.isArray(patch) ? patch : [patch])
      if (list.length) runEdit(cellKey, list)
      this.afterLocal()
    }
    store.undo = () => {
      const ok = undo()
      if (ok) this.shipSnapshot()
      return ok
    }
    store.redo = () => {
      const ok = redo()
      if (ok) this.shipSnapshot()
      return ok
    }
    store.replaceDoc = (next: DashDoc) => {
      replaceDoc(next)
      // a wholesale replacement re-keys everything; re-adopt and tell the room
      this.attach()
      this.shipSnapshot()
    }
  }

  /**
   * Mint ops for patches the store is about to apply, and drop the ones that
   * cannot be committed into a live session (see crdt.committable — an edit
   * naming a row or column a collaborator has deleted lands here and nowhere
   * else). Returns the patches that survived.
   */
  private localPatches(patches: Patch[]): Patch[] {
    if (this.applying) return patches // remote application, not a local edit
    const doc = this.store.doc
    const list = patches.filter((p) => committable(doc, p))
    if (list.length !== patches.length) {
      this.emitNotice({ code: 'patch-refused', permanent: true, ops: patches.length - list.length })
    }
    if (!list.length) return list
    const ops = this.state.local(doc, list)
    if (ops.length) {
      this.log.push(...ops)
      this.broadcast({ t: 'ops', a: this.actor, ops })
    }
    return list
  }

  /** after the store has applied a local commit: let parked remote ops land */
  private afterLocal() {
    this.state.settle(this.store.doc)
    if (this.state.unsynced) {
      // a patch this engine cannot express as ops — ship the whole state
      // rather than let an edit the user believes landed reach nobody
      this.state.unsynced = false
      this.shipSnapshot()
    }
  }

  private shipSnapshot() {
    const s = this.snapshot()
    this.broadcast({ t: 'snap', a: this.actor, doc: s.doc, state: s.state })
  }

  /** register a factory for an additional transport (the online relay) */
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

  // --- remote frames --------------------------------------------------------

  private onFrame(f: Frame) {
    if (f.pv !== SYNC_V) return // old-protocol frame — ignore
    if (f.a === this.actor) return
    switch (f.t) {
      case 'hello': {
        this.touchPeer(f.a, f.p)
        // answer so the newcomer learns us, catch them up from our log, AND
        // tell them our vv so ops they minted before connecting flow back
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
    for (const op of ops) if (!this.log.some((o) => o.a === op.a && o.s === op.s)) this.log.push(op)
    this.applying = true
    try {
      const res = this.state.apply(this.store.doc, ops)
      if (res.changed) this.afterRemoteChange()
    } finally {
      this.applying = false
    }
    if (this.state.gappedActors.length) {
      this.send({ t: 'need', a: this.actor, vv: this.state.vv })
    }
  }

  /**
   * Remote ops are applied SURGICALLY and then the store's own events are
   * re-emitted, so the grid repaints through the path it already has. They are
   * deliberately NOT routed through `store.commit`: a collaborator's edit is
   * not an entry in your undo history.
   */
  private afterRemoteChange() {
    // `store.changedRemotely()` is the public verb for exactly this: stamp
    // modified, invalidate everything, emit what an edit emits — without
    // touching the undo stack, because a collaborator's change is not an entry
    // in your history. This used to reach through `unknown` for the PRIVATE
    // `emit`, which works right up until the event names change.
    const store = this.store as Store & { changedRemotely?: (t?: unknown) => void }
    if (typeof store.changedRemotely === 'function') { store.changedRemotely(); return }
    const legacy = this.store as unknown as {
      doc: DashDoc; lastTouched: unknown; emit?: (ev: string) => void
    }
    legacy.doc.modified = new Date().toISOString()
    legacy.lastTouched = { all: true }
    legacy.emit?.('doc')
    legacy.emit?.('view')
  }

  // --- presence -------------------------------------------------------------

  private presence(): PresenceInfo {
    let name = 'Guest'
    try {
      name = lsGet('bento-author') || 'Guest'
    } catch { /* storage unavailable */ }
    // key-bound identity (v2): which key this copy signs with + its capability
    const c = collabOf(this.store.doc)
    let pub: string | undefined
    let role: 'owner' | 'editor' | 'viewer' | undefined
    if (c) {
      if (c.role === 'reader') role = 'viewer'
      else if (c.v === 2 && c.ownerPriv) { role = 'owner'; pub = c.owner }
      else if (c.v === 2 && c.invite) {
        role = 'editor'
        pub = lsJson<{ pub?: string } | null>(`bento-member-${this.store.doc.docId}`, null)?.pub
      } else if (c.writerPriv) { role = 'editor'; pub = c.writerPub }
    }
    return {
      name,
      color: actorColor(this.actor),
      sheet: this.sheet,
      ...(pub ? { pub } : {}),
      ...(role ? { role } : {}),
    }
  }

  /** the grid calls this when the visible sheet changes */
  setSheet(id: string) {
    if (this.sheet === id) return
    this.sheet = id
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

  // --- relay refusals -------------------------------------------------------

  onNotice(fn: (n: SyncNotice) => void): () => void {
    this.noticeListeners.add(fn)
    return () => this.noticeListeners.delete(fn)
  }

  private emitNotice(n: SyncNotice) {
    this.noticeListeners.forEach((fn) => fn(n))
  }

  /**
   * The relay refused a frame. For the PERMANENT codes those ops can never be
   * delivered, so they leave the resend log — otherwise every peer `need`
   * re-offers them, they are re-sent and re-refused forever. The price is real
   * and cannot be undone: this document keeps the change, remote replicas
   * never see it. So only the exact ops of the named frame are dropped, never
   * a range, and never anything when the frame could not be identified.
   */
  refused(code: RefusalCode, ops: Op[] | null) {
    const doomed = ops ?? []
    if (doomed.length) {
      const keys = new Set(doomed.map((o) => `${o.a}:${o.s}`))
      this.log = this.log.filter((o) => !keys.has(`${o.a}:${o.s}`))
    }
    this.emitNotice({ code, permanent: code !== 'rate-limited', ops: doomed.length })
  }

  // --- snapshots (online catch-up + file-fork merge) ------------------------

  snapshot(): { doc: DashDoc; state: SyncStateJSON } {
    return {
      doc: JSON.parse(JSON.stringify(this.store.doc)) as DashDoc,
      state: JSON.parse(JSON.stringify(this.state.toJSON())) as SyncStateJSON,
    }
  }

  applySnapshot(rdoc: DashDoc, rstate: SyncStateJSON) {
    if (!rstate || rstate.v !== SYNC_V) return // pre-v1 / foreign room snapshot
    this.applying = true
    try {
      const res = this.state.mergeSnapshot(this.store.doc, rdoc, rstate)
      if (res.changed) this.afterRemoteChange()
    } finally {
      this.applying = false
    }
  }

  /** re-announce (an online transport connected or reconnected) */
  hello() {
    this.broadcast({ t: 'hello', a: this.actor, vv: this.state.vv, p: this.presence() })
    if (this.forkPending) {
      // a rejoining offline fork: its contributions live in document values +
      // restored registers, not in ops — a state snapshot is how they travel
      this.shipSnapshot()
    }
  }

  /**
   * Relay replay finished. `seen` holds the (actor,seq) pairs the room already
   * has; anything in our log it lacks gets (re)sent for persistence — covering
   * ops minted before the transport connected. Returns whether a fresh server
   * snapshot should be uploaded (a fork just merged).
   */
  onRelayReady(seen: Set<string>): boolean {
    const missing = this.log.filter((o) => !seen.has(`${o.a}:${o.s}`))
    if (missing.length) this.send({ t: 'ops', a: this.actor, ops: missing })
    const fork = this.forkPending
    this.forkPending = false
    return fork
  }

  /**
   * Stamp the CRDT state into doc.collab.sync so the SAVED file can rejoin as
   * a true fork later. Called by the save path; only shared documents carry it.
   *
   * The state is O(edits), but a long session with a big paste can still make
   * it large, and it rides inside the FILE. Past the budget it is left out:
   * the copy then rejoins as a fresh adopt, which loses two-way fork merge and
   * loses nothing else. A workbook that will not open is a worse outcome than
   * one that merges coarsely.
   */
  stampInto(doc: DashDoc, budget = SYNC_STAMP_BUDGET) {
    const c = doc.collab as CollabBlock | undefined
    if (!c || c.on === false) return
    const state = JSON.parse(JSON.stringify(this.state.toJSON())) as SyncStateJSON
    const bytes = JSON.stringify(state).length
    if (bytes > budget) {
      delete c.sync
      console.warn(`[bento-sync] sync state is ${(bytes / 1024 / 1024).toFixed(1)} MB — not stamped into the file`)
      return
    }
    c.sync = state
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

/**
 * How much sync state may ride inside the file. The whole columnar encoding
 * exists to keep a workbook small (4.8 bytes/cell); a sync blob that dwarfs it
 * would make the format pay for a feature the file does not need to open.
 */
export const SYNC_STAMP_BUDGET = 2 * 1024 * 1024
