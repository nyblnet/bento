// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Granting happens here and nowhere else: `showDirectoryPicker` needs a user
// gesture, and a save is the wrong moment to discover there isn't one. The
// service worker only ever reads the grant it finds.

const DB = 'bento-tray'
const STORE = 'grant'
const open = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1)
  r.onupgradeneeded = () => r.result.createObjectStore(STORE)
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
})
const put = async (v) => { const d = await open(); return new Promise((res, rej) => {
  const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(v, 'dir')
  t.oncomplete = res; t.onerror = () => rej(t.error) }) }
const get = async () => { const d = await open(); return new Promise((res, rej) => {
  const t = d.transaction(STORE, 'readonly'); const q = t.objectStore(STORE).get('dir')
  q.onsuccess = () => res(q.result ?? null); q.onerror = () => rej(q.error) }) }

const el = document.getElementById('state')
const show = (s) => { el.textContent = s }

async function report() {
  const dir = await get()
  if (!dir) return show('No folder granted yet.')
  const perm = await dir.queryPermission({ mode: 'readwrite' })
  show(`folder: ${dir.name}\npermission: ${perm}` +
    (perm === 'granted' ? '\n\nDecks in this folder save in place.'
                        : '\n\nNeeds renewing — choose the folder again.'))
}

document.getElementById('pick').onclick = async () => {
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' })
    await dir.requestPermission({ mode: 'readwrite' })
    await put(dir)
    await report()
  } catch (e) { show(`${e.name}: ${e.message}`) }
}
document.getElementById('check').onclick = report
void report()
