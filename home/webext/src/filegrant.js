// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Saving in place for a document that no granted folder covers.
//
// THE GAP. Chrome will not grant the home folder, Desktop, Documents or
// Downloads as wholes to any page or extension, so the documents most people
// keep — the ones they "just saved" — sit outside every folder grant. Three
// more doors, in the order the worker tries them after the folder grants:
//
//   1. A FILE GRANT: a real FileSystemFileHandle for that one document, held
//      in the extension's own storage (db.js FILEGRANT). Obtained by a drop
//      onto the library, or by the one-time window the first ⌘S opens. Never
//      by the page: every file:// deck shares one storage origin, so a handle
//      a deck kept would be every local deck's.
//   2. DOWNLOADS, written through `chrome.downloads`: the one folder Chrome
//      lets an extension write into by design, with `conflictAction:
//      'overwrite'` — no grant at all for a document sitting there.
//   3. The OFFER: the small window that asks, once per file (a week per
//      decline), and completes the save when the user picks the file.
//
// IDENTITY IS PROVEN, NEVER ASSUMED. A file grant is used for a path only when
// the handle's name is the path's file name AND its bytes are the bytes at
// that path (the extension can read file://). A same-named other file is
// refused; a moved file stops matching and is offered again for its new path.
// The page names nothing: the path is `sender.url`, browser-stamped.
//
// Pure where it can be: storage, fetch and the downloads API come in as
// `deps`, so scripts/test-webext-filegrant.ts drives it in node.

import { FILEGRANT, all, get, put, del } from './db.js'
import { fileUrl } from './place.js'

/** How long a "just this once" is remembered before the window may ask again. */
export const DECLINE_MS = 7 * 24 * 3600 * 1000

const basename = (p) => p.split('/').pop() || ''
const dirname = (p) => p.slice(0, Math.max(0, p.lastIndexOf('/')))

export const defaultDeps = () => ({
  all: () => all(FILEGRANT),
  get: (k) => get(FILEGRANT, k),
  put: (k, v) => put(FILEGRANT, k, v),
  del: (k) => del(FILEGRANT, k),
  fetch: (u) => fetch(u),
  storage: typeof chrome !== 'undefined' ? chrome.storage?.local : null,
  downloads: typeof chrome !== 'undefined' ? chrome.downloads : null,
  // the download bubble, off for the length of a write (permission downloads.ui)
  setUiOptions: typeof chrome !== 'undefined' && chrome.downloads?.setUiOptions ? (o) => chrome.downloads.setUiOptions(o) : null,
})

/** The grant records: `{ key, name, handle, path?, at }` — declines excluded. */
export async function listFileGrants(deps = defaultDeps()) {
  const out = []
  for (const [key, v] of await deps.all()) if (v && v.handle) out.push({ key, ...v })
  return out
}

export const declineKey = (path) => `declined:${path}`

/** Was this path declined within DECLINE_MS? */
export async function declined(path, deps = defaultDeps()) {
  const d = await deps.get(declineKey(path))
  return !!d && typeof d.at === 'number' && Date.now() - d.at < DECLINE_MS
}

export const decline = (path, deps = defaultDeps()) => deps.put(declineKey(path), { at: Date.now() })

/** Keep a handle as a file grant. `path` when known (a scan matched it, or the window knew it). */
export async function addFileGrant(handle, path, deps = defaultDeps()) {
  const key = path || `name:${handle.name}:${Math.random().toString(36).slice(2, 10)}`
  await deps.put(key, { name: handle.name, handle, path: path || null, at: Date.now() })
  if (path) await deps.del(declineKey(path)).catch(() => {})
  return key
}

const bytesEqual = (a, b) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Are the handle's bytes the bytes at this path? (The proof a grant needs.) */
export async function handleIsPath(handle, path, deps = defaultDeps()) {
  try {
    const r = await deps.fetch(fileUrl(path))
    if (!r.ok) return false
    const disk = new Uint8Array(await r.arrayBuffer())
    const mine = new Uint8Array(await (await handle.getFile()).arrayBuffer())
    return bytesEqual(disk, mine)
  } catch { return false }
}

/**
 * The file grant that serves a path, proven: name equal, permission granted,
 * bytes equal. `{ ok:true, handle, key }`, or `{ ok:false, reason:
 * 'lapsed'|'none' }` — lapsed when a candidate exists but its permission is
 * gone (only a gesture in the extension's own UI can bring it back).
 */
export async function resolveFileGrant(path, deps = defaultDeps()) {
  const name = basename(path)
  if (!name) return { ok: false, reason: 'none' }
  let lapsed = false
  const grants = await listFileGrants(deps)
  // A grant BOUND to a path serves that path and no other: two byte-identical
  // copies of a deck in two folders must never serve each other's saves (the
  // write would land in the other copy). An unbound grant — a drop whose path
  // the scan could not settle — is bound here on first use, and only when
  // the bytes say it is THIS file; `otherCopies` (paths of same-named files
  // elsewhere, from the scan) lets the caller refuse when a twin exists.
  const bound = grants.filter((g) => g.path === path)
  const unbound = grants.filter((g) => !g.path && g.name === name)
  for (const g of bound) {
    let perm = 'denied'
    try { perm = await g.handle.queryPermission({ mode: 'readwrite' }) } catch { continue }
    if (perm !== 'granted') { lapsed = true; continue }
    if (!(await handleIsPath(g.handle, path, deps))) continue // the file at that path changed under it: not this grant any more
    return { ok: true, handle: g.handle, key: g.key }
  }
  for (const g of unbound) {
    let perm = 'denied'
    try { perm = await g.handle.queryPermission({ mode: 'readwrite' }) } catch { continue }
    if (perm !== 'granted') { lapsed = true; continue }
    if (!(await handleIsPath(g.handle, path, deps))) continue
    // a twin with the same bytes elsewhere makes this ambiguous: refuse rather than guess
    const twins = deps.otherCopies ? await deps.otherCopies(path) : []
    let ambiguous = false
    for (const twin of twins) if (await handleIsPath(g.handle, twin, deps)) { ambiguous = true; break }
    if (ambiguous) continue
    await deps.put(g.key, { name: g.name, handle: g.handle, path, at: g.at }).catch(() => {})
    return { ok: true, handle: g.handle, key: g.key }
  }
  return { ok: false, reason: lapsed ? 'lapsed' : 'none' }
}

/** Forget a grant whose file is gone (NotFoundError on use). */
export const dropFileGrant = (key, deps = defaultDeps()) => deps.del(key)

// ---------------------------------------------------------------- downloads

/**
 * Where Chrome downloads to, learned from the downloads API: the most recent
 * download's absolute filename, or — on a profile with none — a one-byte
 * probe downloaded and erased. Remembered in extension storage.
 */
export async function downloadsDir(deps = defaultDeps()) {
  const kept = (await deps.storage?.get('downloadsDir'))?.downloadsDir
  if (typeof kept === 'string' && kept) return kept
  if (!deps.downloads) return null
  let dir = null
  try {
    const items = await deps.downloads.search({ limit: 1, orderBy: ['-startTime'], exists: true })
    const f = items?.[0]?.filename
    if (typeof f === 'string' && f.includes('/')) dir = dirname(f.replace(/\\/g, '/'))
    if (!dir) {
      const id = await deps.downloads.download({ url: 'data:text/plain;base64,YmVudG8=', filename: '.bento-home-probe.txt', conflictAction: 'overwrite', saveAs: false })
      const done = await waitForDownload(id, deps)
      if (typeof done?.filename === 'string') dir = dirname(done.filename.replace(/\\/g, '/'))
      try { await deps.downloads.removeFile(id) } catch { /* fine */ }
      try { await deps.downloads.erase({ id }) } catch { /* fine */ }
    }
  } catch { dir = null }
  if (dir) {
    // a Windows path from the API is `C:/Users/…`; file:// paths here are `/C:/Users/…`
    if (/^[A-Za-z]:\//.test(dir)) dir = `/${dir}`
    await deps.storage?.set({ downloadsDir: dir }).catch(() => {})
  }
  return dir
}

/** The download-relative filename for a path under the downloads folder, or null. */
export function downloadsRelative(path, dir) {
  if (!dir || !path) return null
  const base = dir.replace(/\/+$/, '')
  if (!path.startsWith(`${base}/`)) return null
  const rel = path.slice(base.length + 1)
  return rel && !rel.split('/').includes('..') ? rel : null
}

function waitForDownload(id, deps) {
  return new Promise((resolve) => {
    let settled = false
    const finish = async () => {
      if (settled) return
      settled = true
      try { deps.downloads.onChanged?.removeListener(onChanged) } catch { /* fine */ }
      const [item] = (await deps.downloads.search({ id })) ?? []
      resolve(item ?? null)
    }
    const onChanged = (delta) => {
      if (delta.id !== id || !delta.state) return
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') void finish()
    }
    deps.downloads.onChanged?.addListener(onChanged)
    // belt and braces: a download that completed before the listener attached
    setTimeout(async () => {
      const [item] = (await deps.downloads.search({ id }).catch(() => [])) ?? []
      if (item && item.state !== 'in_progress') void finish()
    }, 300)
    setTimeout(() => void finish(), 20000)
  })
}

/** Is the Downloads door switched off for this Chrome (it prompted once)? */
export const downloadsUnusable = async (deps = defaultDeps()) => !!(await deps.storage?.get('downloadsUnusable'))?.downloadsUnusable
export const setDownloadsUnusable = (v, deps = defaultDeps()) => deps.storage?.set({ downloadsUnusable: !!v })

/** Write text to a path under Downloads through the downloads API. Bytes written, or a throw. */
export async function writeViaDownloads(rel, text, deps = defaultDeps()) {
  if (!deps.downloads) throw new Error('downloads unavailable')
  const bytes = new TextEncoder().encode(text)
  let b64 = ''
  for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  const url = `data:text/html;base64,${btoa(b64)}`
  // the download bubble would flash on every autosave; quiet it for the write
  const ui = deps.setUiOptions
  if (ui) { try { await ui({ enabled: false }) } catch { /* older Chrome */ } }
  try {
    const id = await deps.downloads.download({ url, filename: rel, conflictAction: 'overwrite', saveAs: false })
    const item = await waitForDownload(id, deps)
    try { await deps.downloads.erase({ id }) } catch { /* history only */ }
    if (!item || item.state !== 'complete') {
      const e = new Error(item?.error ? `download ${item.error}` : 'download did not complete')
      // USER_CANCELED here means Chrome PROMPTED — "Ask where to save each
      // file" is on, and the downloads API honours it even with saveAs:false
      // (measured). This door cannot be silent in that Chrome.
      if (item?.error === 'USER_CANCELED') e.name = 'DownloadsPrompted'
      throw e
    }
    return bytes.length
  } finally {
    if (ui) { try { await ui({ enabled: true }) } catch { /* fine */ } }
  }
}
