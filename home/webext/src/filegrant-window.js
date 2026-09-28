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
import { handleIsPath, decline, listFileGrants } from './filegrant.js'
import { inBlockedFolder, folderOf, grantFolderFor, grantFileFor } from './grantflow.js'

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
// A document in a subfolder is offered its FOLDER (every sibling then saves
// without asking — one dialog per folder); only one directly in home,
// Documents, Desktop or Downloads, which Chrome will not grant, gets a file.
const folderPath = folderOf(path)
const folderName = folderPath.split('/').filter(Boolean).pop() ?? folderPath
const byFolder = !lapsed && !inBlockedFolder(path)
document.getElementById('title').textContent = lapsed ? t('fgTitleLapsed', name) : t('fgTitle', name)
document.getElementById('lead').textContent = lapsed ? t('fgLeadLapsed') : byFolder ? t('fgLeadFolder', folderName) : t('fgLead')
const choose = document.getElementById('choose')
choose.textContent = lapsed ? t('fgReconnect') : byFolder ? t('fgChooseFolder', folderName) : t('fgChoose')
const onlyFile = document.getElementById('onlyFile')
onlyFile.hidden = !byFolder
onlyFile.textContent = t('fgOnlyFile')
const status = document.getElementById('status')

// A port whose disconnect is this window closing unanswered: the worker then
// resolves the waiting save as declined instead of holding it for two minutes.
try { chrome.runtime.connect({ name: `filegrant:${token}` }) } catch { /* fine */ }

const say = (r) => {
  status.textContent = r.reason === 'denied' ? t('fgDenied')
    : r.reason === 'not-containing' ? t('fgNotContaining', r.name ?? '', folderName)
    : r.reason === 'cancelled' ? '' : t('fgNotSame', name)
}

const answer = async (chosen) => {
  try { await chrome.runtime.sendMessage({ op: 'filegrant.answered', token, chosen }) } catch { /* worker gone */ }
  window.close()
}


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
    // THE PROOF is in grantflow.js: a folder must really contain this
    // document (the grant resolves the path); a picked file must be its
    // bytes and mtime. The picker opens near the document either way.
    const r = byFolder ? await grantFolderFor(path) : await grantFileFor(path)
    if (!r.ok) { say(r); choose.disabled = false; return }
    await answer(true)
  } catch (e) {
    if (e?.name !== 'AbortError') status.textContent = e?.message || String(e)
    choose.disabled = false
  }
}
onlyFile.onclick = async () => {
  onlyFile.disabled = true
  try {
    const r = await grantFileFor(path)
    if (r.ok) { await answer(true); return }
    say(r)
  } catch (e) { if (e?.name !== 'AbortError') status.textContent = e?.message || String(e) }
  onlyFile.disabled = false
}
document.getElementById('once').onclick = async () => { await decline(path); await answer(false) }
addEventListener('keydown', (e) => { if (e.key === 'Escape') void answer(false) })
choose.focus()
