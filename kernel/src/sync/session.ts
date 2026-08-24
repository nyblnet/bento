// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
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

import {
  SyncEngine,
  SYNC_V,
  BLOB_INLINE_MAX,
  type BlobRef,
  type CollabCreds,
  type Op,
  type SyncDoc,
  type SyncStateJSON,
} from './crdt.ts'

// Re-exported: these are DOCUMENT-FORMAT types and live with the engine, but
// every consumer meets them through the session.
export type { BlobRef, CollabCreds, SyncDoc }
import { putBlob, getBlob, dataUriToBytes, bytesToDataUri, encodedSize, MAX_BLOB } from './blobs.ts'
import { mintCollab } from './online.ts'
import { lsGet, lsJson } from '../storage.ts'

/**
 * The store the session drives, reduced to what it actually touches.
 *
 * Every app already has this: bento/slides' Store satisfies it as written.
 * Stated structurally rather than imported so the kernel does not reach into
 * an app — kernel/README.md's rule.
 */
export interface HostStore {
  doc: SyncDoc
  readOnly?: boolean
  on(event: string, fn: () => void): unknown
  emit(event: string): void
  commit(fn: () => void): void
  setDirty(v: boolean): void
}

/**
 * The app-shaped decisions the session cannot make for itself.
 *
 * This is deliberately SMALL. Of 727 lines, five places knew what a slide was:
 * repairing an emptied document, clamping the current position, pruning a
 * selection of ids that no longer exist, saying where this person is for
 * presence, and recognising embedded media in a refused batch. Everything else
 * — the differ, the shadow, catch-up, gap recovery, blobs, the fork snapshot
 * exchange — was already generic and moved unchanged.
 *
 * A word processor answers all five differently: "empty" is a document with no
 * blocks, "where you are" is a block and a caret rather than a slide and a
 * selection.
 */
export interface SyncHost {
  readonly store: HostStore
  /**
   * Repair the document after a remote change — an emptied container, say.
   * Return true if it mutated the doc.
   *
   * THE REPAIR DOES NOT CONVERGE BY ITSELF. Returning true makes the session
   * mint the change as an ordinary local op, and an op is all it is: two
   * replicas that heal concurrently mint TWO nodes and the CRDT faithfully
   * keeps both. Nothing here deduplicates them.
   *
   * So any id the repair creates MUST be derived from stable document data —
   * `docId`, or the content — and never freshly generated, so that concurrent
   * healers produce the SAME node and the merge collapses it. bento/slides
   * gets away with a random id because a spare blank slide is visible and
   * harmless; a spare page in a space is a phantom in the sidebar, and a spare
   * paragraph is one somebody has to notice and delete.
   *
   * This comment previously said the session "mints the repair as a local op
   * so every replica converges on one healer's version", which reads as though
   * convergence were handled for you. It is not, and that belief is exactly
   * what produces a random-id heal. (Caught by the bento/spaces session, which
   * hit the race while writing its own adapter.)
   */
  heal(): boolean
  /**
   * Snapshot per-tab view state BEFORE a remote change is applied. Optional:
   * a shape whose view survives any edit does not need one.
   *
   * It exists because clamping after the fact is not enough. Keeping the user
   * on the same slide when someone else deletes a different one requires
   * knowing which slide they were on by IDENTITY, and after the apply that
   * information is gone — the index now points at whatever moved into the gap.
   * bento/slides fixed exactly this upstream (#262) and the fix is unavailable
   * to a post-hoc clamp.
   */
  captureView?(): unknown
  /**
   * Reconcile per-tab view state (current position, selection) with a document
   * that changed underneath it, given whatever `captureView` returned. Return
   * true if the SELECTION changed, which is the only part the session has to
   * announce.
   */
  clampView(view?: unknown): boolean
  /** Where this replica is, for presence. */
  presence(): { at: string; sel: string[] }
  /**
   * Store events fired after EVERY remote change.
   *
   * Was hard-coded to `'doc'`, which is what bento/slides calls "something in
   * the document changed, repaint". It is not universal: in bento/spaces the
   * same name is the DIRTY/STATUS signal and repainting goes through 'tree'
   * and 'page', so emitting it for a remote op would label a colleague's edit
   * "Edited" in this user's chrome. Which events a remote change should raise
   * is the app's to say — the kernel knowing one app's vocabulary is exactly
   * what this seam exists to stop.
   *
   * (Raised by the bento/spaces session reviewing this interface. The kernel
   * had shipped its own app's habit as a default.)
   */
  readonly changeEvents: readonly string[]
  /** Extra events a STRUCTURAL remote change needs, on top of changeEvents. */
  readonly structureEvents: readonly string[]
  /** Events that should push a fresh presence frame when the app emits them. */
  readonly presenceEvents: readonly string[]
  /** Structural probe: does this refused batch carry embedded media? */
  carriesMedia(ops: Op[]): boolean
  /**
   * The engine BOUND to this app's document shape.
   *
   * Passed as the class, not an instance, because the session constructs one
   * per attach and restores one from saved state — and `fromJSON` on a bound
   * subclass returns that subclass (pinned by scripts/test-sync-shape.ts).
   * A session that built a bare `SyncEngine` here would silently hold slides'
   * shape for every app.
   */
  readonly engine: {
    new (actor: string): SyncEngine
    fromJSON(actor: string, json: SyncStateJSON): SyncEngine
  }
}

export interface PresenceInfo {
  name: string
  color: string
  /**
   * WHERE THIS PERSON IS — a slide id in bento/slides, a page id in
   * bento/spaces, a block id in bento/type.
   *
   * The NAME is wrong for three of the four apps and is kept anyway, because
   * it is on the wire: deployed clients read this field, and the relay stores
   * frames containing it. Renaming it to `at` would fork presence between
   * versions for no user-visible gain — a live session would show colleagues
   * as nowhere. The app-side name IS `at` (SyncHost.presence returns `{at,
   * sel}`), so the honest name is used everywhere it costs nothing, and the
   * frozen one only where it is load-bearing.
   */
  slide: string
  /** selected element ids */
  sel: string[]
  /** element id currently being text-edited (in-text presence) */
  editing?: string
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
/** state-based fork merge: a rejoining offline-edited copy announces itself */
interface SnapFrame {
  t: 'snap'
  a: string
  doc: SyncDoc
  state: SyncStateJSON
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

/**
 * Why the relay refused a frame (`{ctl:'refused', code, …}` — see
 * server/sync-worker). Everything but 'rate-limited' is PERMANENT for the
 * frame that drew it: retrying can only reproduce the refusal.
 */
export type RefusalCode = 'too-large' | 'storage-failed' | 'room-full' | 'rate-limited'

/**
 * Something the user deserves to know about the live session. The transport
 * detects it, the session records the consequence, the editor renders the
 * sentence (t() must run at display time, so no text crosses this boundary).
 */
export interface SyncNotice {
  code: RefusalCode
  /** true = the change will never reach collaborators; false = retrying */
  permanent: boolean
  /** how many ops were abandoned (0 when the refused frame wasn't ours to name) */
  ops: number
  /** the abandoned ops carried embedded media — lets the UI say "that image" */
  media?: boolean
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
  state!: SyncEngine
  private shadow = ''
  private docId = ''
  private log: Op[] = []
  private transports: Transport[] = []
  private peersMap = new Map<string, Peer>()
  private applying = false
  private diffTimer: number | null = null
  private heartbeat: number | null = null
  private peerListeners = new Set<() => void>()
  private noticeListeners = new Set<(n: SyncNotice) => void>()
  private editingEl: string | undefined
  /** extra transports (the online relay) get plugged in here */
  private makeExtraTransports: Array<(docId: string, onFrame: (f: Frame) => void) => Transport> = []

  private readonly host: SyncHost
  /** the app's store — every call site below predates the host and still reads
   *  `this.store`, which is exactly the point: the move changed the seam, not
   *  the session's logic */
  private get store(): HostStore { return this.host.store }

  constructor(host: SyncHost) {
    this.host = host
    const store = host.store
    this.actor = tabActor()
    this.attach()
    store.on('doc', () => this.onLocalChange())
    for (const ev of host.presenceEvents) store.on(ev, () => this.pushPresence())
    window.addEventListener('beforeunload', () => this.broadcast({ t: 'bye', a: this.actor }))
  }

  // --- lifecycle -----------------------------------------------------------

  /** a restored offline fork still owes the room its snapshot */
  private forkPending = false

  /** the loaded doc arrived carrying collab creds (was saved/shared) */
  private bornWithCollab = false
  /** the user opted in this session (saved, or hit "Start live session") */
  private explicitShare = false

  /** Should this doc auto-connect to the relay on open? See attach(). */
  shareEligible(): boolean {
    return this.bornWithCollab || this.explicitShare
  }

  /** Mark that the user opted into sharing (save / explicit Start live). */
  enableSharing() {
    this.explicitShare = true
  }

  private attach() {
    this.docId = this.store.doc.docId
    const doc = this.store.doc
    // Auto-connect eligibility: a doc that ARRIVED carrying collab creds was
    // saved/shared by someone — it should go live on open. A doc we mint creds
    // for right now (the anonymous starter demo, a fresh template instance) is
    // NOT auto-connected — it phones home only after the user saves or clicks
    // "Start live session" (enableSharing). This keeps casual visitors off the
    // relay and honours "nothing phones home unless you ask".
    this.bornWithCollab = !!doc.collab
    this.explicitShare = false
    // credentials are minted AT CREATION: any copy of the file can join once
    // it is live (on:true by default). Minting is async now (the writer
    // keypair) — fine because a freshly-minted doc is never auto-connected, so
    // the sub-frame gap before collab lands touches nothing. See eligibility.
    if (!doc.collab) void this.ensureCollab()
    const saved = doc.collab?.sync
    if (saved && saved.v === SYNC_V) {
      // this file was saved during/after a shared session: restore the CRDT
      // state so our offline edits carry real registers, remote replay
      // dedups by version vector, and a state-based snapshot exchange can
      // merge the fork BOTH ways (see docs/collab-design.md)
      this.state = this.host.engine.fromJSON(this.actor, JSON.parse(JSON.stringify(saved)))
      this.forkPending = true
    } else {
      // no saved state, or state from the pre-composite-key era (v1) — that
      // scheme collapsed same-id-on-many-slides, so it is discarded and the
      // file joins as a never-synced adopt (deterministic keys from the doc)
      this.state = new this.host.engine(this.actor)
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

  /** Mint collab credentials (incl. the writer keypair) for a doc created
   *  without them. Direct mutation (no undo entry), guarded against a race with
   *  a real collab arriving via loadDoc. */
  private async ensureCollab() {
    if (this.store.doc.collab) return
    const creds = await mintCollab()
    if (!this.store.doc.collab) this.store.doc.collab = creds
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
  /**
   * Assets too large for an op (docs/blob-offload.md) are uploaded to the
   * relay's blob store and published as a small `blobs.<key>` reference, which
   * IS small enough to sync. Runs after a local edit; the reference lands on
   * the next flush like any other change.
   *
   * The bytes are always cached locally even when the upload fails, because
   * the cache is per-ORIGIN: same-machine tabs syncing over BroadcastChannel
   * resolve from it with no relay involved at all.
   */
  private async offloadAssets() {
    const doc = this.store.doc
    const assets = doc.assets ?? {}
    const creds = this.blobCreds()
    for (const [k, v] of Object.entries(assets)) {
      if (typeof v !== 'string' || v.length <= BLOB_INLINE_MAX) continue
      if (doc.blobs?.[k]) continue // already published
      const parsed = dataUriToBytes(v)
      if (!parsed) continue // raw SVG markup, not binary — leave it inline
      if (encodedSize(parsed.bytes.length) > MAX_BLOB) {
        this.notify('blob-too-large', k)
        continue
      }
      if (!creds) continue // no relay yet; retry on the next edit
      const res = await putBlob(
        { base: creds.base, room: creds.room, tok: creds.tok }, creds.rawKey, parsed.bytes,
      )
      if (!res.ok) {
        // 'unsupported' = relay has no blob storage. Not an error: small assets
        // still inline, and same-origin tabs resolve from the local cache.
        if (res.reason !== 'unsupported') this.notify(`blob-${res.reason}`, k)
        continue
      }
      this.store.commit(() => {
        const d = this.store.doc
        ;(d.blobs ??= {})[k] = { key: res.key, mime: parsed.mime, size: parsed.bytes.length }
      })
    }
  }

  /**
   * The other direction: a peer published a reference we have no bytes for.
   * Fetch, decrypt and materialise it into `assets` so the renderer can use it
   * exactly as if it had arrived inline.
   *
   * A blob that never arrives leaves the asset ABSENT rather than blank —
   * `assetRef()` in render.ts resolves a missing key to '', which the UI shows
   * as a visibly empty element. Silent-but-wrong is the failure mode we are
   * avoiding everywhere in this system.
   */
  private async resolveBlobs() {
    const doc = this.store.doc
    const refs = doc.blobs ?? {}
    const creds = this.blobCreds()
    for (const [k, ref] of Object.entries(refs)) {
      if (doc.assets?.[k]) continue // already have the bytes
      if (this.fetching.has(ref.key)) continue
      this.fetching.add(ref.key)
      try {
        // cache-first, so same-origin tabs need no relay at all
        const bytes = creds
          ? await getBlob({ base: creds.base, room: creds.room, tok: creds.tok }, creds.rawKey, ref.key)
          : null
        if (!bytes) { this.notify('blob-unavailable', k); continue }
        this.store.commit(() => {
          const d = this.store.doc
          ;(d.assets ??= {})[k] = bytesToDataUri(bytes, ref.mime)
        })
      } finally {
        this.fetching.delete(ref.key)
      }
    }
  }

  private fetching = new Set<string>()
  /** set by the editor when an online transport exists */
  /** Credentials the blob layer needs, taken from whichever transport can
   *  reach a relay.
   *
   *  Resolved ON DEMAND, deliberately. The obvious shape — a hook assigned when
   *  the online transport connects — is what shipped broken: nothing ever
   *  assigned it, so `creds` was always null, every upload was skipped by the
   *  `if (!creds) continue` guard, and the whole offload was inert with no
   *  error anywhere. Transports are also torn down and rebuilt on reconnect and
   *  on rejoin, so even a correctly-assigned hook goes stale. Asking the live
   *  transport list each time cannot drift. */
  private blobCreds(): { base: string; room: string; tok: string; rawKey: Uint8Array } | null {
    for (const tr of this.transports) {
      const f = (tr as { blobCreds?: () => { base: string; room: string; tok: string; rawKey: Uint8Array } | null }).blobCreds
      if (typeof f !== 'function') continue
      const c = f.call(tr)
      if (c) return c
    }
    return null
  }
  private notify(code: string, detail?: string) {
    // routed through the existing notice channel so the editor can toast it
    try { (this as unknown as { noticeFn?: (c: string, d?: string) => void }).noticeFn?.(code, detail) } catch { /* none */ }
  }

  flush() {
    if (this.applying) return
    const before = JSON.parse(this.shadow) as SyncDoc
    let ops: Op[]
    try {
      ops = this.state.diff(before, this.store.doc, { text: true })
    } catch (err) {
      this.recoverFromDiffFailure(err)
      return
    }
    this.shadow = JSON.stringify(this.store.doc)
    // Any large asset the differ just skipped needs its bytes offloaded; the
    // resulting reference syncs on the next flush like an ordinary change.
    void this.offloadAssets()
    if (!ops.length) return
    this.log.push(...ops)
    this.broadcast({ t: 'ops', a: this.actor, ops })
  }

  /**
   * A differ bug must not WEDGE the session. The shadow is only advanced after
   * a successful diff, so an uncaught throw here poisons every later flush:
   * the same delta is re-diffed, throws again, and nothing syncs for the rest
   * of the session — on any slide, not just the element that broke. That
   * amplifier is what turned the ~200KB-text stack overflow (fixed in crdt.ts:
   * splice-without-spread) into total, silent collab failure. The trigger is
   * gone; the amplifier stays armed for the next differ bug, so disarm it.
   *
   * Recovery, best-effort in this order:
   *  - Advance the shadow past the poison delta. Re-diffing it would just
   *    re-throw, and a wedged differ is strictly worse than one lost delta.
   *  - Ship a state snapshot. diff() mints ops and advances its registers as
   *    it goes, so a mid-diff throw leaves some changes stamped but never
   *    broadcast — they now live only in our doc VALUES. That is exactly the
   *    offline-fork case, and a snapshot is how those travel (see hello()).
   *    forkPending re-sends it on the next reconnect too.
   *
   * Deliberately not a SyncNotice: those name conditions a user can act on
   * (too large, room full). This path is a bug — console is the right surface.
   */
  private recoverFromDiffFailure(err: unknown) {
    console.error('[bento-sync] diff failed; recovering via snapshot', err)
    this.shadow = JSON.stringify(this.store.doc)
    this.forkPending = true
    try {
      // inlined rather than this.snapshot() — that calls flush(), and flush()
      // is our caller
      this.broadcast({
        t: 'snap',
        a: this.actor,
        doc: JSON.parse(JSON.stringify(this.store.doc)) as SyncDoc,
        state: JSON.parse(JSON.stringify(this.state.toJSON())),
      })
    } catch (e2) {
      // snapshot itself failed (state unserializable) — the shadow is still
      // advanced, so editing continues and the next reconnect retries
      console.error('[bento-sync] snapshot recovery failed', e2)
    }
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
    // Before the document moves, not after: see captureView on the host shape.
    const view = this.host.captureView?.()
    try {
      const res = this.state.apply(this.store.doc, ops)
      if (res.changed) this.afterRemoteChange(res.structure, view)
    } finally {
      this.applying = false
    }
    if (this.state.gappedActors.length) {
      this.send({ t: 'need', a: this.actor, vv: this.state.vv })
    }
  }

  private afterRemoteChange(structure: boolean, view?: unknown) {
    void this.resolveBlobs()
    const store = this.store
    // A delete-everything race can leave a document with no content at all,
    // which no editor can render. What "empty" means and what repairs it are
    // the app's to say.
    if (this.host.heal()) {
      // mint the repair as a local op so every replica converges on ONE
      // healer's version (LWW keeps all healers'; harmless duplicates)
      this.applying = false
      this.flush()
      this.applying = true
    }
    const selChanged = this.host.clampView(view)
    this.shadow = JSON.stringify(store.doc)
    store.doc.modified = new Date().toISOString()
    store.setDirty(true)
    for (const ev of this.host.changeEvents) store.emit(ev)
    if (structure) for (const ev of this.host.structureEvents) store.emit(ev)
    if (selChanged) store.emit('selection')
  }

  // --- presence -------------------------------------------------------------

  private presence(): PresenceInfo {
    let name = 'Guest'
    try {
      name = lsGet('bento-author') || 'Guest'
    } catch {
      /* storage unavailable */
    }
    // key-bound identity (v2): which key this copy signs with + its capability.
    // The device key is minted by the transport on first connect; until then a
    // member's pub is simply absent from presence (it fills in on reconnect).
    const c = this.store.doc.collab
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
    const where = this.host.presence()
    return {
      name,
      color: actorColor(this.actor),
      // `slide` is the WIRE name and is frozen — deployed clients and the
      // relay both read it. It means "where this person is", which for a word
      // processor is a block rather than a slide.
      slide: where.at,
      sel: where.sel,
      ...(this.editingEl ? { editing: this.editingEl } : {}),
      ...(pub ? { pub } : {}),
      ...(role ? { role } : {}),
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

  // --- relay refusals -------------------------------------------------------

  /** the editor subscribes here to toast what the relay refused */
  onNotice(fn: (n: SyncNotice) => void): () => void {
    this.noticeListeners.add(fn)
    return () => this.noticeListeners.delete(fn)
  }

  private emitNotice(n: SyncNotice) {
    this.noticeListeners.forEach((fn) => fn(n))
  }

  /**
   * A transport reports that the relay refused a frame. For the PERMANENT
   * codes the named ops can never be delivered, so they leave the resend log.
   *
   * Why dropping is the right call, and why it is narrow: `missingFor` answers
   * every peer `need` (and `onRelayReady`) out of `log`, so an op the relay
   * will always refuse would be re-offered, re-sent, re-refused — forever.
   * That loop is the bug this exists to break. The price is real and cannot be
   * undone: the local document KEEPS the change, remote replicas never see it,
   * and nothing reconciles it later (short of the file being re-opened, which
   * re-adopts the doc wholesale). Because it is a permanent divergence we drop
   * ONLY the exact ops the refused frame carried — never a range, never the
   * rest of the log, and never anything when the frame couldn't be identified.
   */
  refused(code: RefusalCode, ops: Op[] | null) {
    const doomed = ops ?? []
    if (doomed.length) {
      const keys = new Set(doomed.map((o) => `${o.a}:${o.s}`))
      this.log = this.log.filter((o) => !keys.has(`${o.a}:${o.s}`))
    }
    this.emitNotice({
      code,
      permanent: code !== 'rate-limited',
      ops: doomed.length,
      ...(this.host.carriesMedia(doomed) ? { media: true } : {}),
    })
  }

  // --- snapshots (online catch-up + file-fork merge) ------------------------

  /** current (doc, sync-state) pair for an encrypted relay snapshot */
  snapshot(): { doc: SyncDoc; state: SyncStateJSON } {
    this.flush()
    return {
      doc: JSON.parse(JSON.stringify(this.store.doc)) as SyncDoc,
      state: JSON.parse(JSON.stringify(this.state.toJSON())),
    }
  }

  /** merge a remote snapshot (relay replay for far-behind joiners) */
  applySnapshot(rdoc: SyncDoc, rstate: SyncStateJSON) {
    if (!rstate || rstate.v !== SYNC_V) return // pre-v2 room snapshot — unusable
    this.flush()
    this.applying = true
    const view = this.host.captureView?.()
    try {
      const res = this.state.mergeSnapshot(this.store.doc, rdoc, rstate)
      if (res.changed) this.afterRemoteChange(true, view)
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
  stampInto(doc: SyncDoc) {
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

