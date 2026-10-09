// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The save-as window (saveas.js has the whole story). It reads the record the
// worker made, offers "Save next to <document>" when the extension reaches
// the document's folder, and "Choose a folder…" — a picker that opens in that
// folder, or the nearest one the extension holds. The picker runs HERE, in
// this window's click: a page cannot be given a handle, and the page's own
// picker has nowhere better to start than Downloads.

import { t, localize, initI18n } from './i18n.js'
import { idb, readRecord, choose, besideName, EXT } from './saveas.js'
import { startInFor } from './grantflow.js'

const q = new URLSearchParams(location.search)
const token = q.get('token') ?? ''
const db = idb()

await initI18n()
localize()
const rec = await readRecord(token, db)
const status = document.getElementById('status')
const file = document.getElementById('file')
const besideBtn = document.getElementById('beside')
const chooseBtn = document.getElementById('choose')

// A port whose disconnect is this window closing unanswered: the worker then
// answers the waiting page "cancelled" instead of holding it.
try { chrome.runtime.connect({ name: `saveas:${token}` }) } catch { /* fine */ }
const answer = async (chosen) => {
  try { await chrome.runtime.sendMessage({ op: 'saveas.answered', token, chosen }) } catch { /* worker gone */ }
  window.close()
}

if (!rec) {
  status.textContent = t('saGone')
  besideBtn.hidden = true
  chooseBtn.disabled = true
} else {
  const original = rec.path.split('/').pop()
  // literal keys, so the catalogue rig can see every one is used
  document.getElementById('title').textContent = rec.purpose === 'copy' ? t('saTitleCopy') : t('saTitleShare')
  document.getElementById('name').textContent = original
  document.getElementById('path').textContent = rec.path
  file.value = rec.name
  // select the stem, like the browser's own dialog, so typing replaces the name only
  const stem = rec.name.toLowerCase().endsWith(EXT) ? rec.name.length - EXT.length : rec.name.length
  file.focus()
  file.setSelectionRange(0, stem)
  if (rec.dir) {
    besideBtn.hidden = false
    besideBtn.textContent = t('saBeside', original)
  }
  let confirmReplace = null // the name the person was warned about
  const nameOrSay = () => {
    const r = besideName(file.value, original)
    if (!r.ok) status.textContent = r.reason === 'is-original' ? t('saIsOriginal') : t('saBadName')
    return r.ok ? r.name : null
  }
  file.addEventListener('input', () => { status.textContent = ''; confirmReplace = null })

  besideBtn.onclick = async () => {
    const name = nameOrSay()
    if (!name) return
    besideBtn.disabled = true
    try {
      if (await rec.dir.queryPermission({ mode: 'readwrite' }) !== 'granted'
        && await rec.dir.requestPermission({ mode: 'readwrite' }) !== 'granted') {
        status.textContent = t('saLapsed')
        besideBtn.disabled = false
        return
      }
      let exists = true
      try { await rec.dir.getFileHandle(name) } catch (e) { exists = e?.name !== 'NotFoundError' }
      if (exists && confirmReplace !== name) {
        confirmReplace = name
        status.textContent = t('saExists', name)
        besideBtn.disabled = false
        return
      }
      if (await choose(token, { kind: 'beside', name }, db)) await answer(true)
      else status.textContent = t('saGone')
    } catch (e) { status.textContent = e?.message || String(e) }
    besideBtn.disabled = false
  }

  chooseBtn.onclick = async () => {
    const name = nameOrSay() ?? rec.name
    chooseBtn.disabled = true
    try {
      const startIn = rec.dir ?? await startInFor(rec.path)
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        startIn,
        // the browser remembers the last folder per id; copies and exports apart
        id: rec.purpose === 'copy' ? 'bento-copy' : 'bento-share',
        types: [{ description: 'Bento', accept: { 'text/html': [EXT] } }],
      })
      if (await choose(token, { kind: 'handle', handle, name: handle.name }, db)) await answer(true)
      else status.textContent = t('saGone')
    } catch (e) {
      if (e?.name !== 'AbortError') status.textContent = e?.message || String(e)
    }
    chooseBtn.disabled = false
  }
  // Enter = the primary action
  file.addEventListener('keydown', (e) => { if (e.key === 'Enter') (rec.dir ? besideBtn : chooseBtn).click() })
}
document.getElementById('cancel').onclick = () => void answer(false)
addEventListener('keydown', (e) => { if (e.key === 'Escape') void answer(false) })
