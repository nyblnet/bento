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
    lines.push(`<b class="ok">Folder: ${esc(s.folder)}</b> — decks in here save in place, with no dialog.`)
  } else {
    lines.push(`<b class="bad">Folder: ${esc(s.folder)} — needs renewing.</b> ` +
      'The grant lapses whenever the extension restarts. Choose it again to restore it.')
  }

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
document.getElementById('check').onclick = report
void report()
void getGrant // referenced so the import is obviously intentional
