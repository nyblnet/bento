// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The toolbar popup: says whether a save will land in place, BEFORE one is
// attempted. Both preconditions fail silently otherwise — a lapsed folder grant
// and a file-URL permission nothing can request — and a user who cannot see
// them reads "the extension is broken".

import { status } from './status.js'

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
document.getElementById('open').addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
  window.close()
})
