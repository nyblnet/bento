// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The one place IndexedDB is opened.
//
// It used to be opened in two files — the service worker and the status module
// — with the database name, store name and key strings duplicated between them.
// That is a split-brain waiting to happen: if they drift, the options page
// writes grants the worker never reads, the UI looks healthy, every save
// prompts, and nothing reports a fault. A rig had to gate the two copies
// against each other. One module is better than a gate.
//
// STORES
//
//   grant   the durable, small things
//             dirs      [FileSystemDirectoryHandle]  every granted folder
//             dir       legacy single grant, still read so an upgrade does not
//                       silently drop a folder somebody already granted
//             prefixes  {folderName: '/absolute/path'} — see below
//
//   cache   derived, disposable: one entry per document, holding what was read
//           out of it (title, preview) keyed by size+mtime so a changed file
//           re-reads. Nothing here is authoritative; deleting it costs a
//           re-read and nothing else.
//
// WHY `prefixes` EXISTS. A FileSystemDirectoryHandle knows its name and never
// its path, so the extension cannot turn a document it can WRITE into a URL it
// can OPEN. But when a deck is open, the browser stamps `sender.url` with the
// absolute path, and `dir.resolve()` gives that same file's path relative to
// the grant. Subtract one from the other and the grant's absolute prefix falls
// out. That is `locateIn` run backwards, and it is what makes a document list
// clickable.

const DB = 'bento-tray'
const VERSION = 2
export const GRANT = 'grant'
export const CACHE = 'cache'

export const open = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, VERSION)
  r.onupgradeneeded = (ev) => {
    const d = r.result
    // Additive only, and version-guarded rather than existence-guarded, so the
    // path from a v1 install is explicit rather than incidental.
    if (!d.objectStoreNames.contains(GRANT)) d.createObjectStore(GRANT)
    if (!d.objectStoreNames.contains(CACHE)) d.createObjectStore(CACHE)
    void ev
  }
  r.onsuccess = () => res(r.result)
  r.onerror = () => rej(r.error)
})

export const get = async (store, key) => {
  const d = await open()
  return new Promise((res, rej) => {
    const q = d.transaction(store, 'readonly').objectStore(store).get(key)
    q.onsuccess = () => res(q.result ?? null)
    q.onerror = () => rej(q.error)
  })
}

export const put = async (store, key, value) => {
  const d = await open()
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite')
    t.objectStore(store).put(value, key)
    t.oncomplete = res
    t.onerror = () => rej(t.error)
  })
}

/**
 * Remember where a granted folder actually lives on disk.
 *
 * Keyed by folder NAME, which can collide — two grants both called `Decks`
 * would share an entry. The cost of a collision is a document link pointing at
 * a path that does not exist, so the tab opens on nothing; it can never write
 * to the wrong file, because writing does not go through here at all. That is
 * a tolerable ceiling for a convenience, and the alternative (keying by handle)
 * is not expressible — handles are not valid keys and have no stable id.
 */
export async function learnPrefix(folderName, absolutePrefix) {
  const all = (await get(GRANT, 'prefixes')) || {}
  if (all[folderName] === absolutePrefix) return // the common case: no write
  all[folderName] = absolutePrefix
  await put(GRANT, 'prefixes', all)
}

export const prefixes = async () => (await get(GRANT, 'prefixes')) || {}
