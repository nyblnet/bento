// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The offer window: a ⌘S in a document nothing covers opened this. The
// person either picks the file in the OS dialog — the handle is proven to be
// the bytes at that path, stored in the extension's own IndexedDB, and the
// waiting save completes through it — or says "just this once", and the
// document's own Save dialog appears as it would without any extension.
//
// The picker runs HERE, in the extension's context and gesture, which is the
// whole point: a handle obtained by the page would live in the page's
// origin, which every local document shares.

import { t, localize, initI18n } from './i18n.js'
import { addFileGrant, handleIsPath, decline, listFileGrants } from './filegrant.js'

const q = new URLSearchParams(location.search)
const path = q.get('path') ?? ''
const token = q.get('token') ?? ''
const lapsed = q.get('lapsed') === '1'
const name = path.split('/').filter(Boolean).pop() ?? path

await initI18n()
localize()
document.getElementById('name').textContent = name
document.getElementById('path').textContent = path
// literal keys, so the catalogue rig can see every one is used
document.getElementById('title').textContent = lapsed ? t('fgTitleLapsed', name) : t('fgTitle', name)
document.getElementById('lead').textContent = lapsed ? t('fgLeadLapsed') : t('fgLead')
const choose = document.getElementById('choose')
choose.textContent = lapsed ? t('fgReconnect') : t('fgChoose')
const status = document.getElementById('status')

// A port whose disconnect is this window closing unanswered: the worker then
// resolves the waiting save as declined instead of holding it for two minutes.
try { chrome.runtime.connect({ name: `filegrant:${token}` }) } catch { /* fine */ }

/** The picked file's mtime equals the mtime at the path (to the second — file:// rounds). */
async function sameMtime(handle, path) {
  try {
    const r = await fetch(`file://${path.split('/').map(encodeURIComponent).join('/')}`, { headers: { range: 'bytes=0-0' } })
    const disk = Date.parse(r.headers.get('last-modified') ?? '')
    const mine = (await handle.getFile()).lastModified
    if (!disk || !mine) return true // no mtime to compare: the bytes were the proof
    return Math.abs(disk - mine) < 2000
  } catch { return true }
}

const answer = async (chosen) => {
  try { await chrome.runtime.sendMessage({ op: 'filegrant.answered', token, chosen }) } catch { /* worker gone */ }
  window.close()
}

/** Where the OS picker opens: the well-known folder the path is under, else Documents. */
const startIn = /\/Downloads\//.test(path) ? 'downloads' : /\/Desktop\//.test(path) ? 'desktop' : 'documents'

choose.onclick = async () => {
  choose.disabled = true
  try {
    if (lapsed) {
      // the handle is here already; only a gesture in THIS window can renew it
      for (const g of await listFileGrants()) {
        if (g.name !== name) continue
        if (await g.handle.requestPermission({ mode: 'readwrite' }) === 'granted' && await handleIsPath(g.handle, path)) { await answer(true); return }
      }
      status.textContent = t('fgNotSame', name)
      choose.disabled = false
      return
    }
    const [handle] = await window.showOpenFilePicker({ startIn, multiple: false, types: [{ description: 'Bento', accept: { 'text/html': ['.html'] } }] })
    if (!handle) { choose.disabled = false; return }
    if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') { status.textContent = t('fgDenied'); choose.disabled = false; return }
    // THE PROOF: the picked file must be the bytes at the path that asked —
    // and, because a byte-identical copy elsewhere would pass that, its
    // modification time must match the file at that path too (a Range fetch
    // answers with Last-Modified). A twin then fails here and is refused.
    if (!(await handleIsPath(handle, path)) || !(await sameMtime(handle, path))) { status.textContent = t('fgNotSame', name); choose.disabled = false; return }
    await addFileGrant(handle, path)
    await answer(true)
  } catch (e) {
    if (e?.name !== 'AbortError') status.textContent = e?.message || String(e)
    choose.disabled = false
  }
}
document.getElementById('once').onclick = async () => { await decline(path); await answer(false) }
addEventListener('keydown', (e) => { if (e.key === 'Escape') void answer(false) })
choose.focus()
