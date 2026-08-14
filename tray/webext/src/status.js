// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// What the extension can and cannot do right now, in one place.
//
// Two things have to be true before a deck saves in place, and BOTH fail
// silently by nature: a folder grant that lapses whenever the service worker
// restarts, and a file-URL permission that no manifest can request. Neither is
// visible until a save is attempted, which is the worst possible moment to
// discover them — so the popup and the options page read this and say so first.

const DB = 'bento-tray'
const STORE = 'grant'

const open = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1)
  r.onupgradeneeded = () => r.result.createObjectStore(STORE)
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
})

const get = async (key) => {
  const d = await open()
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, 'readonly')
    const q = t.objectStore(STORE).get(key)
    q.onsuccess = () => res(q.result ?? null); q.onerror = () => rej(q.error)
  })
}

const put = async (key, v) => {
  const d = await open()
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, 'readwrite')
    t.objectStore(STORE).put(v, key)
    t.oncomplete = res; t.onerror = () => rej(t.error)
  })
}

/**
 * Every granted folder, oldest first.
 *
 * `dirs` is the list; `dir` is the single-grant key this shipped with, still
 * read so an upgrade does not silently drop the folder someone already granted.
 * Kept byte-identical in shape to background.js `readGrants` — the two read the
 * same store and must not disagree about what is in it.
 */
export const getGrants = async () => {
  const list = await get('dirs')
  if (Array.isArray(list) && list.length) return list
  const one = await get('dir')
  return one ? [one] : []
}

/** Replace the list. `dir` is cleared once a list exists, so the legacy key
 *  cannot resurrect a folder the user has since removed. */
export const putGrants = async (list) => {
  await put('dirs', list)
  await put('dir', null)
}

/**
 * Is "Allow access to file URLs" enabled?
 *
 * No manifest permission grants it and nothing can prompt for it — the user
 * must set it by hand, per extension, and it stays off after a store install
 * too. It IS readable, which is the difference between a guided step and a
 * mystery. Returns null where the API is unavailable rather than guessing:
 * claiming it is off when it is on would send people to fix a working setting.
 */
export async function fileAccess() {
  try {
    const api = chrome.extension?.isAllowedFileSchemeAccess
    if (!api) return null
    const r = api.call(chrome.extension)
    if (r && typeof r.then === 'function') return await r
    return await new Promise((res) => chrome.extension.isAllowedFileSchemeAccess(res))
  } catch {
    return null
  }
}

/**
 * Everything the UI needs: {files, folders, ready}.
 *
 * `folders` is one row per grant — `{name, permission}` — because with more
 * than one folder the interesting state is per-folder: a single lapsed grant
 * must not read as "the extension is broken", and a single healthy one must not
 * read as "everything is fine". `ready` therefore means at least one folder can
 * be written to, which is the honest summary of "will a save land": it depends
 * on which document.
 */
export async function status() {
  const files = await fileAccess()
  let folders = []
  try {
    const dirs = await getGrants()
    folders = await Promise.all(dirs.map(async (dir) => ({
      name: dir.name,
      permission: await dir.queryPermission({ mode: 'readwrite' }).catch(() => 'unreadable'),
    })))
  } catch {
    folders = [{ name: '(unreadable)', permission: 'unreadable' }]
  }
  return {
    files,
    folders,
    ready: files !== false && folders.some((f) => f.permission === 'granted'),
  }
}
