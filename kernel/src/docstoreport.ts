// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// DocStore over a MessagePort: the per-document store (docstore.ts) for a
// document that runs in a host's sandboxed frame, where the HOST is the page
// that framed it (bento/home in a browser) and the only channel between the two
// is a MessagePort the host transferred at boot.
//
// Why a port and nothing else. The frame is an opaque origin, so a message's
// `origin` says nothing ('null' for every sandboxed frame), and its WindowProxy
// stays the same object after the frame navigates itself. The capability is
// POSSESSION of the transferred port: the host created the channel, kept one
// end, and handed the other to the frame it was serving. Neither side ever
// posts to a window, and neither side reads `event.origin`.
//
// Everything in the frame belongs to the document once it is written (the
// realm is shared), so every rule is enforced HERE, on the host's end:
//   - a closed op list (get, set, list, delete) and a closed name list
//     (recovery, memberkey), an exact key set per op, request ids that only go
//     up, bytes only as a plain Uint8Array over an ArrayBuffer of about its own
//     size, and no value over its name's cap;
//   - anything else is DROPPED, not answered, and counted by reason; past a
//     limit of drops the host closes the session;
//   - the partition is the host's: it binds each session to an ENTRY it minted
//     and the docId it read from the file it verified. Nothing in a request can
//     name either. A record is returned only to a session bound to the docId it
//     was written under;
//   - per-entry byte caps (a document filling the host origin's quota would
//     starve every other entry: browsers evict a whole origin at once), a cap on
//     requests in flight and on the request rate;
//   - closing a session closes the port: a stashed or transferred port reaches
//     nothing afterwards, and a new session is always a new channel.
//
// Wire, version 1 (structured clone; a message is a plain object):
//   request   {t:'bento-store', v:1, id, op:'get'|'delete', name}
//             {t:'bento-store', v:1, id, op:'list'}
//             {t:'bento-store', v:1, id, op:'set', name, bytes: Uint8Array}
//   response  {t:'bento-store', v:1, id, ok:true}                   set, delete
//             {t:'bento-store', v:1, id, ok:true, bytes: Uint8Array|null}  get
//             {t:'bento-store', v:1, id, ok:true, names: string[]}         list
//             {t:'bento-store', v:1, id, ok:false, reason}
//   reasons   'too-large' (over the name's cap), 'quota' (over the entry's),
//             'unavailable' (the host has no verified docId for this session,
//             or its storage failed)
// Saving the FILE is not on this channel and never will be: the document's
// writes reach the host through its save path, where the host re-splices the
// data into the shell it verified. This channel holds side data only.

import type { DocStore, DocStoreName, SetOutcome } from './docstore.ts'

export const STORE_T = 'bento-store'
export const STORE_V = 1
const NAMES: readonly DocStoreName[] = ['recovery', 'memberkey']
const OPS = ['get', 'set', 'list', 'delete'] as const
type Op = typeof OPS[number]

export interface StoreLimits {
  /** Per name: the largest value. */
  maxBytes: Record<DocStoreName, number>
  /** All of one entry's values together. */
  maxEntryBytes: number
  /** Requests accepted but not yet answered. */
  maxInFlight: number
  /** At most rateMax requests per rateWindowMs. */
  rateWindowMs: number
  rateMax: number
  /** Dropped messages before the host closes the session. */
  maxDrops: number
}
export const STORE_LIMITS: StoreLimits = {
  maxBytes: { recovery: 32 * 1024 * 1024, memberkey: 16 * 1024 },
  maxEntryBytes: 40 * 1024 * 1024,
  maxInFlight: 16,
  rateWindowMs: 10_000,
  rateMax: 240,
  maxDrops: 256,
}

export type StoreRequest =
  | { id: number; op: 'get'; name: DocStoreName }
  | { id: number; op: 'delete'; name: DocStoreName }
  | { id: number; op: 'list' }
  | { id: number; op: 'set'; name: DocStoreName; bytes: Uint8Array }

export type DropReason = 'shape' | 'version' | 'keys' | 'id' | 'op' | 'name' | 'bytes' | 'rate' | 'in-flight'

const KEYS: Record<Op, string> = {
  get: 'id,name,op,t,v', delete: 'id,name,op,t,v', list: 'id,op,t,v', set: 'bytes,id,name,op,t,v',
}

const isPlain = (m: unknown): m is Record<string, unknown> => {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return false
  const p = Object.getPrototypeOf(m)
  return p === Object.prototype || p === null
}

/** How much larger than its value a value's buffer may be. A view over a big
 *  buffer costs the host the whole buffer (structured clone copies all of it). */
export const BUFFER_SLACK = 64 * 1024

/**
 * One message from the port, judged against the schema: the request, or why it
 * is dropped. `lastId` is the highest id this session has accepted; an id must
 * exceed it. A value over its name's cap is still a well-formed request (the
 * host answers 'too-large', so the document can stop trying); a value that is
 * a view over a much larger buffer is dropped.
 */
export function parseStoreRequest(m: unknown, lastId: number): StoreRequest | DropReason {
  if (!isPlain(m) || m.t !== STORE_T) return 'shape'
  if (m.v !== STORE_V) return 'version'
  const op = m.op
  if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) return 'op'
  if (Object.keys(m).sort().join(',') !== KEYS[op as Op] || Object.getOwnPropertySymbols(m).length) return 'keys'
  const id = m.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= lastId) return 'id'
  if (op === 'list') return { id, op }
  const name = m.name
  if (typeof name !== 'string' || !(NAMES as readonly string[]).includes(name)) return 'name'
  const n = name as DocStoreName
  if (op === 'set') {
    const b = m.bytes
    if (!(b instanceof Uint8Array) || Object.getPrototypeOf(b) !== Uint8Array.prototype ||
        !(b.buffer instanceof ArrayBuffer) || b.buffer.byteLength - b.length > BUFFER_SLACK) return 'bytes'
    return { id, op, name: n, bytes: b }
  }
  return op === 'get' ? { id, op, name: n } : { id, op: 'delete', name: n }
}

// ---------------------------------------------------------------- host side

/** What the host keeps per (entry, name): the value and the docId it was written under. */
export interface StoredRecord { docId: string; bytes: Uint8Array }

/** The host's storage, keyed by strings it builds; never by anything a document sends. */
export interface StoreBackend {
  get(key: string): Promise<StoredRecord | undefined>
  put(key: string, rec: StoredRecord): Promise<void>
  delete(key: string): Promise<void>
}

/** A backend in memory, for a host that keeps nothing past the page. */
export function memoryBackend(): StoreBackend & { dropEntry(entry: string): void; size(): number } {
  const m = new Map<string, StoredRecord>()
  return {
    get: async (k) => m.get(k),
    put: async (k, r) => { m.set(k, r) },
    delete: async (k) => { m.delete(k) },
    dropEntry: (entry) => { for (const k of [...m.keys()]) if (k.startsWith(entry + SEP)) m.delete(k) },
    size: () => m.size,
  }
}

const SEP = '\u001f'
/** The backend key for one of an entry's names. */
export const entryKey = (entry: string, name: DocStoreName): string => entry + SEP + name

export interface PortLike {
  postMessage(m: unknown): void
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void
  removeEventListener(type: 'message', fn: (e: MessageEvent) => void): void
  start?(): void
  close?(): void
}

export interface StoreStats {
  served: number
  refused: number
  dropped: number
  byReason: Partial<Record<DropReason, number>>
}
export interface StoreSession {
  readonly stats: StoreStats
  readonly closed: boolean
  /** Stop answering and close the port. Idempotent. */
  close(): void
}

export interface ServeOptions {
  /** The entry the host minted for this open: the partition. Never derived from the document. */
  entry: string
  /** The docId the host read from the file it verified, or null when it has none (then every op is 'unavailable'). */
  docId: string | null
  backend: StoreBackend
  limits?: Partial<StoreLimits>
  now?: () => number
  /** Told of every drop and of the session closing itself, for the host's counters. */
  onEvent?: (e: { kind: 'served' | 'refused' | 'dropped' | 'closed'; reason?: string }) => void
}

/** Answer one frame's store requests on its port, bound to one entry and docId. */
export function serveDocStore(port: PortLike, o: ServeOptions): StoreSession {
  if (typeof o.entry !== 'string' || !o.entry || o.entry.includes(SEP)) throw new Error('serveDocStore: a host-minted entry is required')
  const L: StoreLimits = { ...STORE_LIMITS, ...o.limits, maxBytes: { ...STORE_LIMITS.maxBytes, ...o.limits?.maxBytes } }
  const now = o.now ?? Date.now
  const docId = typeof o.docId === 'string' && o.docId.length > 0 && o.docId.length <= 200 ? o.docId : null
  const stats: StoreStats = { served: 0, refused: 0, dropped: 0, byReason: {} }
  let closed = false
  let lastId = 0
  let inFlight = 0
  let windowStart = now()
  let inWindow = 0
  let chain: Promise<void> = Promise.resolve()

  const send = (m: Record<string, unknown>) => { if (!closed) port.postMessage({ t: STORE_T, v: STORE_V, ...m }) }
  const drop = (reason: DropReason) => {
    stats.dropped++
    stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1
    o.onEvent?.({ kind: 'dropped', reason })
    if (stats.dropped >= L.maxDrops) session.close()
  }
  const refuse = (id: number, reason: string) => { stats.refused++; o.onEvent?.({ kind: 'refused', reason }); send({ id, ok: false, reason }) }
  const served = (m: Record<string, unknown>) => { stats.served++; o.onEvent?.({ kind: 'served' }); send(m) }

  const handle = async (r: StoreRequest): Promise<void> => {
    if (docId === null) return refuse(r.id, 'unavailable')
    const key = (n: DocStoreName) => entryKey(o.entry, n)
    const mine = (rec: StoredRecord | undefined) => (rec && rec.docId === docId ? rec : undefined)
    try {
      if (r.op === 'get') {
        const rec = mine(await o.backend.get(key(r.name)))
        return served({ id: r.id, ok: true, bytes: rec ? rec.bytes.slice() : null })
      }
      if (r.op === 'list') {
        const names: DocStoreName[] = []
        for (const n of NAMES) if (mine(await o.backend.get(key(n)))) names.push(n)
        return served({ id: r.id, ok: true, names })
      }
      if (r.op === 'delete') {
        if (mine(await o.backend.get(key(r.name)))) await o.backend.delete(key(r.name))
        return served({ id: r.id, ok: true })
      }
      // set
      if (r.bytes.length > L.maxBytes[r.name]) return refuse(r.id, 'too-large')
      let others = 0
      for (const n of NAMES) if (n !== r.name) others += (await o.backend.get(key(n)))?.bytes.length ?? 0
      if (others + r.bytes.length > L.maxEntryBytes) return refuse(r.id, 'quota')
      await o.backend.put(key(r.name), { docId, bytes: r.bytes.slice() })
      return served({ id: r.id, ok: true })
    } catch {
      return refuse(r.id, 'unavailable')
    }
  }

  const onMessage = (e: MessageEvent) => {
    if (closed) return
    const t = now()
    if (t - windowStart >= L.rateWindowMs) { windowStart = t; inWindow = 0 }
    if (++inWindow > L.rateMax) return drop('rate')
    const r = parseStoreRequest(e.data, lastId)
    if (typeof r === 'string') return drop(r)
    if (inFlight >= L.maxInFlight) return drop('in-flight')
    lastId = r.id
    inFlight++
    // one at a time, in arrival order: a get after a set sees the set
    chain = chain.then(() => (closed ? undefined : handle(r))).finally(() => { inFlight-- })
  }

  const session: StoreSession = {
    stats,
    get closed() { return closed },
    close() {
      if (closed) return
      closed = true
      port.removeEventListener('message', onMessage)
      try { port.close?.() } catch { /* already gone */ }
      o.onEvent?.({ kind: 'closed' })
    },
  }
  port.addEventListener('message', onMessage)
  port.start?.()
  return session
}

// -------------------------------------------------------------- document side

export interface PortTimeouts { get: number; set: number; small: number }
export const PORT_TIMEOUTS: PortTimeouts = { get: 30_000, set: 30_000, small: 10_000 }
const TIMEOUT = 'timeout'
type Answer = { ok: boolean; reason?: string; bytes?: unknown; names?: unknown }

/** Is this something the document can speak the store protocol over? */
export const isPortLike = (p: unknown): p is PortLike =>
  !!p && typeof p === 'object' && typeof (p as PortLike).postMessage === 'function' &&
  typeof (p as PortLike).addEventListener === 'function' && typeof (p as PortLike).removeEventListener === 'function'

/** The DocStore a document uses when its host handed it a store port. */
export class PortBackend implements DocStore {
  // explicit fields, not parameter properties: node rigs run strip-only TS
  private readonly port: PortLike
  private readonly t: PortTimeouts
  private seq = 0
  private readonly pending = new Map<number, (a: Answer) => void>()
  constructor(port: PortLike, timeouts: Partial<PortTimeouts> = {}) {
    this.port = port
    this.t = { ...PORT_TIMEOUTS, ...timeouts }
    port.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as Record<string, unknown> | null
      if (!isPlain(d) || d.t !== STORE_T || d.v !== STORE_V || typeof d.id !== 'number' || typeof d.ok !== 'boolean') return
      const done = this.pending.get(d.id)
      if (!done) return
      this.pending.delete(d.id)
      done({ ok: d.ok, reason: typeof d.reason === 'string' ? d.reason : undefined, bytes: d.bytes, names: d.names })
    })
    port.start?.()
  }

  private ask(m: Record<string, unknown>, ms: number): Promise<Answer> {
    const id = ++this.seq
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, reason: TIMEOUT }) }, ms)
      this.pending.set(id, (a) => { clearTimeout(timer); resolve(a) })
      try { this.port.postMessage({ t: STORE_T, v: STORE_V, id, ...m }) } catch { this.pending.delete(id); clearTimeout(timer); resolve({ ok: false, reason: 'unavailable' }) }
    })
  }

  async get(name: DocStoreName): Promise<Uint8Array | null> {
    const r = await this.ask({ op: 'get', name }, this.t.get)
    if (!r.ok) throw new Error(`DocStore get ${name}: ${r.reason ?? 'refused'}`)
    if (r.bytes === null) return null
    if (r.bytes instanceof Uint8Array) return r.bytes
    throw new Error(`DocStore get ${name}: malformed answer`)
  }

  async set(name: DocStoreName, bytes: Uint8Array): Promise<SetOutcome> {
    const r = await this.ask({ op: 'set', name, bytes }, this.t.set)
    if (r.ok) return 'stored'
    if (r.reason === TIMEOUT) return 'unanswered'
    if (r.reason === 'superseded') return 'superseded'
    return 'refused'
  }

  async list(): Promise<DocStoreName[]> {
    const r = await this.ask({ op: 'list' }, this.t.small)
    if (!r.ok || !Array.isArray(r.names)) throw new Error(`DocStore list: ${r.reason ?? 'malformed answer'}`)
    return r.names.filter((n): n is DocStoreName => n === 'recovery' || n === 'memberkey')
  }

  async delete(name: DocStoreName): Promise<boolean> {
    const r = await this.ask({ op: 'delete', name }, this.t.small)
    return r.ok
  }
}
