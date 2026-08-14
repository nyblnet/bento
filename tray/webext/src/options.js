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
  } else if (s.folders.every((f) => f.permission === 'granted')) {
    // This list is the user's only control, so it has to say so. Chrome's own
    // revoke UI is not reachable from an extension page, and someone looking for
    // it in Chrome's settings will not find it — better to learn that here than
    // to go hunting and conclude the access cannot be withdrawn at all.
    lines.push('<span style="color:#586a80"><b>Remove</b> takes access away — with no folder ' +
      'stored here, there is nothing for this extension to write to. This list is the only ' +
      'place that access can be withdrawn; Chrome does not offer its own control for ' +
      'extension pages.</span>')
  } else if (s.folders.some((f) => f.permission !== 'granted')) {
    // The one instruction worth giving: Chrome asks "Allow this time" or "Allow
    // on every visit", and only the second survives a restart. Someone clicking
    // the obvious first button re-grants forever without knowing there was a
    // choice.
    // Both branches of the dialog are worth spelling out, because Chrome's own
    // wording gives no clue about either. "Allow this time" costs a repeat next
    // session; "Don't allow" costs the folder outright.
    lines.push('When Chrome asks, choose <b>Allow on every visit</b> — ' +
      '<b>Allow this time</b> lapses when you quit the browser, and ' +
      '<b>Don’t allow</b> removes the folder entirely, so you would have to choose it again.')
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
        : 'needs renewing — choose <b>Allow on every visit</b> to stop being asked'}</span>`

    if (!granted) {
      const renew = document.createElement('button')
      renew.textContent = 'Renew'
      // Chrome's own dialog gives no hint of what refusing costs, and the cost
      // is the whole grant: ONE "Don't allow" empties `chosen-objects` and the
      // folder has to be chosen again. Measured 2026-08-14 — a single refusal,
      // dismiss_count 1, no embargo yet, folders already gone. Since the dialog
      // cannot be changed, the warning has to sit on the button that raises it.
      renew.title = 'Chrome will ask to restore this folder. Choosing "Don\'t allow" '
        + 'removes it — you would have to pick the folder again.'
      // The HANDLE is still here — that is how we know the folder's name. Only
      // the permission lapsed, and Chrome takes that back with one confirmation
      // on the handle we already hold. Sending people back through
      // showDirectoryPicker made them re-find the folder to answer yes/no.
      //
      // Chrome's own dialog offers "Allow on every visit" alongside "Allow this
      // time", and the copy below points at it: choosing it is the difference
      // between granting once and granting every session. We cannot pick for
      // them — the choice is the browser's to offer and the user's to make —
      // so the only thing we can do is say which one ends the chore.
      renew.onclick = () => guard(async () => {
        const dirs = await getGrants()
        const dir = dirs[i]
        if (!dir) return
        if (await dir.requestPermission({ mode: 'readwrite' }) === 'granted') {
          await putGrants(dirs)
          return
        }
        // RENEW CAN BECOME PERMANENTLY IMPOSSIBLE, silently. Two ways, both
        // observed 2026-08-14:
        //
        //   · "Don't allow" empties Chrome's `chosen-objects` for this
        //     extension, so the stored handle refers to a grant that no longer
        //     exists and there is nothing left to restore.
        //   · Chrome's permission auto-blocker EMBARGOES the restore prompt
        //     after three dismissals
        //     (permission_autoblocking_data.FileSystemAccessRestorePermission),
        //     after which requestPermission returns without showing anything.
        //
        // Either way the button appears to do nothing, for good, and Chrome
        // offers no UI to undo it. Re-PICKING is a different flow — a
        // user-initiated chooser rather than a restore prompt — and it still
        // works under embargo. So a failed renew is not an error, it is a
        // signal to ask for the folder again.
        // Do not offer Renew again for this folder. It has already failed once,
        // and each attempt spends one of the three dismissals that trigger a
        // seven-day embargo — while re-picking costs nothing and always works.
        // Retrying the losing move is exactly what runs the budget down.
        renew.hidden = true
        pickInstead.hidden = false
        el.innerHTML = '<p><b class="bad">Chrome would not restore that folder.</b> ' +
          'After three refusals it stops asking for seven days, and there is no setting ' +
          'anywhere that turns it back on.</p>' +
          '<p><b>Choose again</b> still works — picking a folder is a different permission — ' +
          'but it grants access for this session only. The option to make it permanent ' +
          '(<b>Allow on every visit</b>) appears solely on the prompt that has stopped ' +
          'appearing, so until it resumes the folder must be chosen again each time Chrome ' +
          'restarts.</p>'
      })
      row.appendChild(renew)

      // Shown only after a renew has actually failed, because until then it is
      // the more confusing of the two buttons.
      const pickInstead = document.createElement('button')
      pickInstead.textContent = 'Choose again…'
      pickInstead.hidden = true
      pickInstead.onclick = () => guard(async () => {
        const picked = await window.showDirectoryPicker({ mode: 'readwrite' })
        await picked.requestPermission({ mode: 'readwrite' })
        const dirs = await getGrants()
        dirs[i] = picked // replace in place: it is the same slot, re-granted
        await putGrants(dirs)
      })
      row.appendChild(pickInstead)
    }

    const drop = document.createElement('button')
    drop.textContent = 'Remove'
    // THIS BUTTON IS THE REVOKE, and as far as we can tell it is the only one.
    //
    // Chrome's documented ways to withdraw File System Access — the address-bar
    // icon's "Remove access", and the per-site File editing list — hang off the
    // site-settings surface for an ORIGIN, and that surface is not offered for
    // `chrome-extension://` pages: the chip there reports only "You're viewing
    // an extension page" (observed 2026-08-14). Chrome's own documentation
    // demonstrates the feature on a website and does not mention extension
    // origins.
    //
    // What saves this is that the permission is not the capability. The HANDLE
    // is: without one stored here there is no object to write through, and
    // another can only come from the user picking a folder. So deleting it
    // takes the access away for real. Chrome's remembered permission means only
    // that re-picking that same folder may not ask again — a convenience, not
    // standing access.
    //
    // Which makes this list the whole of the user's control, and that is a
    // responsibility rather than a boast.
    drop.title = 'Takes access to this folder away. Chrome may still remember the ' +
      'permission, so adding the folder back may not ask again.'
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
