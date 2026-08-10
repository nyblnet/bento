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

export const getGrant = async () => {
  const d = await open()
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, 'readonly')
    const q = t.objectStore(STORE).get('dir')
    q.onsuccess = () => res(q.result ?? null); q.onerror = () => rej(q.error)
  })
}

export const putGrant = async (v) => {
  const d = await open()
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, 'readwrite')
    t.objectStore(STORE).put(v, 'dir')
    t.oncomplete = res; t.onerror = () => rej(t.error)
  })
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

/** Everything the UI needs: {files, folder, permission, ready}. */
export async function status() {
  const files = await fileAccess()
  let folder = null
  let permission = 'none'
  try {
    const dir = await getGrant()
    if (dir) {
      folder = dir.name
      permission = await dir.queryPermission({ mode: 'readwrite' })
    }
  } catch {
    permission = 'unreadable'
  }
  return { files, folder, permission, ready: files !== false && permission === 'granted' }
}
