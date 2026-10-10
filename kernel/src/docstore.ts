// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// DocStore: a document's side data, held by the HOST, per document.
//
// A document opened from disk shares one browser storage origin with every
// other local file, so anything it keeps in localStorage or IndexedDB is
// readable by any other document opened the same way. When the page runs
// under the bento/home browser extension (home/webext), the extension offers a
// small store kept in ITS origin and partitioned by the file path the browser
// reports for this page. The page never names a partition; the extension
// derives it, so one document can't reach another's entries.
//
// Exactly two entries, by name:
//   'recovery'  — the crash-recovery copy of unsaved work (autosave.ts)
//   'memberkey' — this device's member key for the document (sync/online.ts)
// Values are opaque bytes. With no such host, every caller keeps the storage
// it always used, unchanged.
//
// Wire: the page-world request/response protocol the extension's relay speaks
// (home/webext/src/relay.js) — `{__bento_tray__, dir:'req', id, op, payload}`
// answered by `{dir:'res', id, result}`, ops store.get / set / list / delete,
// bytes as Uint8Array.

export type DocStoreName = 'recovery' | 'memberkey'

/** What became of a write: the host STORED it; the host answered and REFUSED
 *  it (e.g. too large); a NEWER write to the same name was committed first, so
 *  this older one was dropped (SUPERSEDED — the newer value is what's kept, so
 *  this is not a refusal of the document); or it never answered in time. A
 *  write that went unanswered may still complete on the host's side. */
export type SetOutcome = 'stored' | 'refused' | 'superseded' | 'unanswered'

export interface DocStore {
  /** The stored bytes, or null when the entry is absent. THROWS if the host
   *  did not answer or refused, so a caller can tell "nothing kept" apart. */
  get(name: DocStoreName): Promise<Uint8Array | null>
  set(name: DocStoreName, bytes: Uint8Array): Promise<SetOutcome>
  /** Names present for this document. THROWS if the host did not answer. */
  list(): Promise<DocStoreName[]>
  /** Whether the host removed it (true also when it was already absent). */
  delete(name: DocStoreName): Promise<boolean>
}
// While a host with this store is present, callers do NOT fall back to the
// storage origin every local file shares when a request fails: a host that
// didn't answer in time may still complete the write. See autosave.ts and
// sync/online.ts deviceIdentity.

/** How long to wait, by kind of request (ms). */
export interface DocStoreTimeouts {
  /** Until the host has answered once. The first request of a page also waits
   *  on the host reading this document's file from disk, on a worker that may
   *  be starting cold. */
  firstProbe: number
  get: number
  /** A write: a base, plus a share per transfer chunk (large values travel as
   *  several runtime round trips and a commit). */
  setBase: number
  setPerChunk: number
  /** list / delete. */
  small: number
}
export const DEFAULT_TIMEOUTS: DocStoreTimeouts = { firstProbe: 15_000, get: 60_000, setBase: 10_000, setPerChunk: 2_000, small: 10_000 }
/** The transfer chunk the extension relay uses for a large value. */
const CHUNK = 3 * 1024 * 1024

const CH = '__bento_tray__'
// Distinct from the extension's own page-bridge ids, which share the channel.
const ID_PREFIX = 'bento-docstore-'
let seq = 0

type HostResult = { ok?: boolean; reason?: string; bytes?: unknown; names?: unknown } | undefined
const TIMEOUT = 'timeout'

/** The extension-backed store. One round trip per call; a host that never
 *  answers resolves as a failure after a bounded wait instead of hanging. */
export class ExtensionBackend implements DocStore {
  // explicit fields, not parameter properties: node rigs run strip-only TS
  private readonly t: DocStoreTimeouts
  private answered = false
  constructor(timeouts: Partial<DocStoreTimeouts> = {}) { this.t = { ...DEFAULT_TIMEOUTS, ...timeouts } }

  private ask(op: string, payload: object, ms: number): Promise<HostResult> {
    // until the host has answered once, every request may be the slow first one
    const wait = this.answered ? ms : Math.max(ms, this.t.firstProbe)
    return new Promise((resolve) => {
      const id = `${ID_PREFIX}${Date.now()}-${seq++}`
      const onMessage = (ev: MessageEvent) => {
        const d = ev.data as Record<string, unknown> | null
        if (ev.source !== window || !d || d[CH] !== true || d.dir !== 'res' || d.id !== id) return
        window.removeEventListener('message', onMessage)
        clearTimeout(timer)
        this.answered = true
        resolve(d.result as HostResult)
      }
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage)
        resolve({ ok: false, reason: TIMEOUT })
      }, wait)
      window.addEventListener('message', onMessage)
      window.postMessage({ [CH]: true, dir: 'req', id, op, payload }, '*')
    })
  }

  async get(name: DocStoreName): Promise<Uint8Array | null> {
    const r = await this.ask('store.get', { name }, this.t.get)
    if (!r?.ok) throw new Error(`DocStore get ${name}: ${r?.reason ?? 'no answer'}`)
    return r.bytes instanceof Uint8Array ? r.bytes : null
  }

  async set(name: DocStoreName, bytes: Uint8Array): Promise<SetOutcome> {
    const ms = this.t.setBase + this.t.setPerChunk * Math.ceil(bytes.length / CHUNK)
    const r = await this.ask('store.set', { name, bytes }, ms)
    if (r?.ok === true) return 'stored'
    if (r?.reason === TIMEOUT) return 'unanswered'
    // two overlapping writes: the host keeps the newer and drops this one
    if (r?.reason === 'superseded') return 'superseded'
    return 'refused'
  }

  async list(): Promise<DocStoreName[]> {
    const r = await this.ask('store.list', { prefix: '' }, this.t.small)
    if (!r?.ok || !Array.isArray(r.names)) throw new Error(`DocStore list: ${r?.reason ?? 'no answer'}`)
    return r.names.filter((n): n is DocStoreName => n === 'recovery' || n === 'memberkey')
  }

  async delete(name: DocStoreName): Promise<boolean> {
    const r = await this.ask('store.delete', { name }, this.t.small)
    return r?.ok === true
  }
}

let cached: DocStore | null | undefined

/** The host's DocStore for this page, or null when there is none — in which
 *  case the caller uses the storage it always did. Decided once per page: the
 *  host announces its capabilities (`window.__bentoHost.ops`) before the
 *  document's runtime boots. */
export function docStore(): DocStore | null {
  if (cached !== undefined) return cached
  const host = (globalThis as { __bentoHost?: { ops?: readonly string[] } }).__bentoHost
  const can = typeof window !== 'undefined' && typeof window.postMessage === 'function' &&
    Array.isArray(host?.ops) && host.ops.includes('store')
  cached = can ? new ExtensionBackend() : null
  return cached
}

/** Forget the decision above. For rigs that toggle the host between cases. */
export function resetDocStoreForTest(store?: DocStore | null): void {
  cached = store
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** A JSON value from the store, or null when absent or unreadable. THROWS if
 *  the host could not answer. */
export async function getJSON<T>(store: DocStore, name: DocStoreName): Promise<T | null> {
  const bytes = await store.get(name)
  if (!bytes) return null
  try { return JSON.parse(dec.decode(bytes)) as T } catch { return null }
}

/** Store a JSON value. */
export function setJSON(store: DocStore, name: DocStoreName, value: unknown): Promise<SetOutcome> {
  return store.set(name, enc.encode(JSON.stringify(value)))
}
