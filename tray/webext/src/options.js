// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Granting happens here and nowhere else: `showDirectoryPicker` and
// `requestPermission` both need a user gesture, and a save is the wrong moment
// to discover there isn't one. The service worker only ever READS the grants it
// finds — it never prompts, because it cannot.
//
// The popup and this page read the SAME status module, so they cannot tell the
// user different stories about whether a save will land.
//
// WHY A LIST. One folder was never the shape of anyone's work — decks live
// under clients, under projects, on the Desktop. Since `background.js` resolves
// by ROUTE rather than by searching, a grant's size and the number of grants
// both stop mattering, so there is no longer a reason to allow only one. The
// same change is what makes granting a home directory reasonable: "everywhere"
// is just a big folder.

import { getGrants, putGrants, status } from './status.js'

const el = document.getElementById('state')
const listEl = document.getElementById('folders')
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

  if (!s.folders.length) {
    lines.push('<b>No folders yet.</b> Choose the folder your documents live in. ' +
      'You can add more than one, and a folder covers everything inside it.')
  }
  el.innerHTML = lines.map((l) => `<p>${l}</p>`).join('')

  // One row per folder. The per-folder state is the point: with several grants,
  // a single lapsed one must not read as "the extension is broken".
  listEl.innerHTML = ''
  s.folders.forEach((f, i) => {
    const row = document.createElement('div')
    row.className = 'row'
    const granted = f.permission === 'granted'
    row.innerHTML =
      `<span class="dot ${granted ? 'ok' : 'bad'}"></span>` +
      `<b>${esc(f.name)}</b> ` +
      `<span class="note">${granted
        ? (s.files === false ? 'ready — waiting on file access' : 'saves in place, no dialog')
        : 'needs renewing'}</span>`

    if (!granted) {
      const renew = document.createElement('button')
      renew.textContent = 'Renew'
      // The HANDLE is still here — that is how we know the folder's name. Only
      // the permission lapsed, and Chrome takes that back with one confirmation
      // on the handle we already hold. Sending people back through
      // showDirectoryPicker made them re-find the folder to answer yes/no.
      renew.onclick = () => guard(async () => {
        const dirs = await getGrants()
        const dir = dirs[i]
        if (!dir) return
        if (await dir.requestPermission({ mode: 'readwrite' }) === 'granted') await putGrants(dirs)
      })
      row.appendChild(renew)
    }

    const drop = document.createElement('button')
    drop.textContent = 'Remove'
    drop.onclick = () => guard(async () => {
      const dirs = await getGrants()
      dirs.splice(i, 1)
      await putGrants(dirs)
    })
    row.appendChild(drop)
    listEl.appendChild(row)
  })
}

/** Run an action, then re-report. Errors land in the status block rather than
 *  the console, because a permission failure here is the user's to act on. */
async function guard(fn) {
  try {
    await fn()
    await report()
  } catch (e) {
    if (e?.name === 'AbortError') return report() // they closed the picker
    el.innerHTML = `<p><b class="bad">${esc(e.name)}</b>: ${esc(e.message)}</p>`
  }
}

document.getElementById('pick').onclick = () => guard(async () => {
  const dir = await window.showDirectoryPicker({ mode: 'readwrite' })
  await dir.requestPermission({ mode: 'readwrite' })
  const dirs = await getGrants()
  // Adding the same folder twice is a no-op rather than an error — it is an
  // easy thing to do with several folders, and two entries for one folder would
  // then need removing twice.
  for (const existing of dirs) {
    if (await existing.isSameEntry(dir)) return
  }
  await putGrants([...dirs, dir])
})
document.getElementById('check').onclick = report
void report()
