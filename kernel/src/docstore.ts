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

export interface DocStore {
  /** The stored bytes, or null when the entry is absent. THROWS if the host
   *  could not answer, so a caller can tell "nothing kept" from "host down". */
  get(name: DocStoreName): Promise<Uint8Array | null>
  /** Whether the host stored it. */
  set(name: DocStoreName, bytes: Uint8Array): Promise<boolean>
  /** Names present for this document. THROWS if the host could not answer. */
  list(): Promise<DocStoreName[]>
  /** Whether the host removed it (true also when it was already absent). */
  delete(name: DocStoreName): Promise<boolean>
}

const CH = '__bento_tray__'
// Distinct from the extension's own page-bridge ids, which share the channel.
const ID_PREFIX = 'bento-docstore-'
let seq = 0

type HostResult = { ok?: boolean; reason?: string; bytes?: unknown; names?: unknown } | undefined

/** The extension-backed store. One round trip per call; a host that never
 *  answers resolves as a failure after `timeoutMs` instead of hanging. */
export class ExtensionBackend implements DocStore {
  // an explicit field, not a parameter property: node rigs run strip-only TS
  private readonly timeoutMs: number
  constructor(timeoutMs = 4000) { this.timeoutMs = timeoutMs }

  private ask(op: string, payload: object): Promise<HostResult> {
    return new Promise((resolve) => {
      const id = `${ID_PREFIX}${Date.now()}-${seq++}`
      const onMessage = (ev: MessageEvent) => {
        const d = ev.data as Record<string, unknown> | null
        if (ev.source !== window || !d || d[CH] !== true || d.dir !== 'res' || d.id !== id) return
        window.removeEventListener('message', onMessage)
        clearTimeout(timer)
        resolve(d.result as HostResult)
      }
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage)
        resolve({ ok: false, reason: 'timeout' })
      }, this.timeoutMs)
      window.addEventListener('message', onMessage)
      window.postMessage({ [CH]: true, dir: 'req', id, op, payload }, '*')
    })
  }

  async get(name: DocStoreName): Promise<Uint8Array | null> {
    const r = await this.ask('store.get', { name })
    if (!r?.ok) throw new Error(`DocStore get ${name}: ${r?.reason ?? 'no answer'}`)
    return r.bytes instanceof Uint8Array ? r.bytes : null
  }

  async set(name: DocStoreName, bytes: Uint8Array): Promise<boolean> {
    const r = await this.ask('store.set', { name, bytes })
    return r?.ok === true
  }

  async list(): Promise<DocStoreName[]> {
    const r = await this.ask('store.list', { prefix: '' })
    if (!r?.ok || !Array.isArray(r.names)) throw new Error(`DocStore list: ${r?.reason ?? 'no answer'}`)
    return r.names.filter((n): n is DocStoreName => n === 'recovery' || n === 'memberkey')
  }

  async delete(name: DocStoreName): Promise<boolean> {
    const r = await this.ask('store.delete', { name })
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

/** Store a JSON value; whether the host stored it. */
export function setJSON(store: DocStore, name: DocStoreName, value: unknown): Promise<boolean> {
  return store.set(name, enc.encode(JSON.stringify(value)))
}
