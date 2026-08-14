// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The toolbar popup: says whether a save will land in place, BEFORE one is
// attempted. Both preconditions fail silently otherwise — a lapsed folder grant
// and a file-URL permission nothing can request — and a user who cannot see
// them reads "the extension is broken".

import { getGrants, putGrants, status, setLapsedBadge } from './status.js'

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

const row = (state, title, detail) =>
  `<div class="row"><div class="dot ${state}"></div><div class="t"><b>${esc(title)}</b><span>${detail}</span></div></div>`

const s = await status()

const files = s.files === true
  ? row('ok', 'Local files', 'This extension may read pages opened from disk.')
  : s.files === false
    ? row('bad', 'Local files — off',
        'Turn on <b>Allow access to file URLs</b> on this extension’s card in <code>chrome://extensions</code>. Nothing works without it, and no extension can turn it on for you.')
    : row('meh', 'Local files — unknown',
        'This browser will not say. If saves still prompt, check <b>Allow access to file URLs</b>.')

// One row per folder. The rows must not promise in-place saving while the OTHER
// precondition is failing: "saves in place, with no dialog" directly under
// "nothing works until file access is on" is two green-ish signals
// contradicting each other, and the reassuring one is the false one.
//
// And with several folders, a summary would hide the thing worth knowing —
// whether saves land depends on WHICH document, so each folder answers for
// itself rather than being averaged into one verdict.
const folders = !s.folders.length
  ? row('meh', 'No folders yet', 'Choose the folder your documents live in. You can add several.')
  : s.folders.map((f) => f.permission === 'granted'
    ? row(s.files === false ? 'meh' : 'ok', esc(f.name),
        s.files === false
          ? 'Ready, but nothing saves in place until local file access is on.'
          : 'Documents in here save in place, with no dialog.')
    : row('bad', `${esc(f.name)} — needs renewing`,
        '<b>Renew</b> in Settings restores it in one click — the folder is still remembered. Choose <b>Allow on every visit</b> and Chrome stops asking.')).join('')

document.getElementById('rows').innerHTML = files + folders

/**
 * Reconnect from HERE, not from the options page.
 *
 * `requestPermission` needs a user gesture, and the service worker has none —
 * so the dialog can only be raised from an extension PAGE. A deck is a `file://`
 * page in another origin and cannot hold the handle at all, which rules out
 * asking from where the user actually is.
 *
 * The popup is the closest thing to that: it is one click from any tab, it is
 * where the toolbar badge sends people, and a click in it IS the gesture. Making
 * this a trip to Settings turned a one-click repair into a navigation, a page,
 * and a hunt for the right button.
 */
const lapsed = document.getElementById('renew')
const hint = document.getElementById('hint')
const needsWork = s.folders.some((f) => f.permission !== 'granted')
lapsed.hidden = !needsWork
hint.hidden = !needsWork
lapsed.addEventListener('click', async () => {
  lapsed.disabled = true
  const dirs = await getGrants()
  let ok = 0
  for (const dir of dirs) {
    try {
      if (await dir.queryPermission({ mode: 'readwrite' }) === 'granted') { ok++; continue }
      if (await dir.requestPermission({ mode: 'readwrite' }) === 'granted') ok++
    } catch { /* declined, or the handle is gone — the row will say so */ }
  }
  if (ok) await putGrants(dirs)
  await setLapsedBadge()

  // A renew that restores NOTHING is the state Chrome cannot get you out of:
  // "Don't allow" empties its record of the granted folders, and three
  // dismissals embargo the restore prompt so it stops appearing at all. Both
  // observed 2026-08-14. Re-picking the folder is a different permission and
  // still works, but it needs the folder chooser, which belongs in Settings.
  //
  // Saying so beats reloading into an unchanged list, which reads as "the
  // button is broken" and invites the extra dismissals that cause the embargo.
  if (!ok) {
    document.getElementById('rows').innerHTML = row('bad', 'Chrome would not restore the folder',
      'It can stop offering to, and gives no way to turn that back on. Choosing the folder '
      + 'again in Settings works instead — it is a different permission.')
    lapsed.hidden = true
    hint.hidden = true
    return
  }
  location.reload()
})

document.getElementById('open').addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
  window.close()
})
