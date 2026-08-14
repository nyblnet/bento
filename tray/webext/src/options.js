// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Granting happens here and nowhere else: `showDirectoryPicker` needs a user
// gesture, and a save is the wrong moment to discover there isn't one. The
// service worker only ever reads the grant it finds.
//
// The popup and this page read the SAME status module, so they cannot tell the
// user different stories about whether a save will land.

import { getGrant, putGrant, status } from './status.js'

const el = document.getElementById('state')
const renewB = document.getElementById('renew')
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

async function report() {
  const s = await status()
  const lines = []

  if (s.files === false) {
    lines.push('<b class="bad">Local file access is off.</b> Open <code>chrome://extensions</code>, ' +
      'find <b>Bento Tray</b>, and turn on <b>Allow access to file URLs</b>. ' +
      'No extension can enable this for you, and nothing works until it is on.')
  } else if (s.files === null) {
    lines.push('<b>Local file access: unknown.</b> This browser will not report it. ' +
      'If saves still prompt for a destination, check <b>Allow access to file URLs</b> ' +
      'on this extension in <code>chrome://extensions</code>.')
  } else {
    lines.push('<b class="ok">Local file access is on.</b>')
  }

  if (!s.folder) {
    lines.push('<b>No folder granted yet.</b> Choose the folder your decks live in.')
  } else if (s.permission === 'granted') {
    // Do not promise in-place saving while file access is off — that promise is
    // false, and printing it under "nothing works until it is on" is worse than
    // saying nothing.
    lines.push(s.files === false
      ? `<b>Folder: ${esc(s.folder)}</b> — ready, but nothing saves in place until file access is on.`
      : `<b class="ok">Folder: ${esc(s.folder)}</b> — decks in here save in place, with no dialog.`)
  } else {
    // The HANDLE is still here — that is how we know the folder's name. Only
    // the permission lapsed, and Chrome takes that back with one confirmation
    // on the handle we already hold. Sending people back through
    // showDirectoryPicker made them re-find the folder every time, which is a
    // filesystem browse to answer a yes/no question.
    lines.push(`<b class="bad">Folder: ${esc(s.folder)} — needs renewing.</b> ` +
      'Chrome drops the permission when the extension restarts. ' +
      '<b>Renew</b> restores it in one click — you do not have to find the folder again.')
  }
  renewB.hidden = !(s.folder && s.permission !== 'granted')

  el.innerHTML = lines.map((l) => `<p>${l}</p>`).join('')
}

document.getElementById('pick').onclick = async () => {
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' })
    await dir.requestPermission({ mode: 'readwrite' })
    await putGrant(dir)
    await report()
  } catch (e) {
    el.innerHTML = `<p><b class="bad">${esc(e.name)}</b>: ${esc(e.message)}</p>`
  }
}
/**
 * Take the permission back on the folder we already hold.
 *
 * `requestPermission` needs a user gesture, which is why this is a button and
 * not something `report()` does on load — and why the service worker must never
 * attempt it (`background.js resolve` queries only). A click here is the
 * gesture; Chrome shows one Allow/Block confirmation naming the folder.
 *
 * The handle is re-put afterwards for the same reason it is stored at all: the
 * grant that matters is the one the service worker reads, and re-writing it is
 * cheap insurance against a handle that has been replaced rather than renewed.
 */
renewB.onclick = async () => {
  try {
    const dir = await getGrant()
    if (!dir) return report() // nothing to renew — the pick button is the answer
    const perm = await dir.requestPermission({ mode: 'readwrite' })
    if (perm === 'granted') await putGrant(dir)
    await report()
  } catch (e) {
    el.innerHTML = `<p><b class="bad">${esc(e.name)}</b>: ${esc(e.message)}</p>`
  }
}
document.getElementById('check').onclick = report
void report()
