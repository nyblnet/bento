// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The tray: your documents first, plumbing at the bottom.
//
// This was a permissions panel — "local file access is on, folder: documents" —
// which is true and useless. tray/ios is a document browser: you see your
// documents and tap one. Same shape here. Permission state still has to be
// visible, because both of its failures are silent, but it belongs in a strip
// that stays quiet while things work.

import { getGrants, putGrants, status, setLapsedBadge } from './status.js'
import { listDocuments, describe, newDocument } from './library.js'

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d < 30 ? `${d}d ago` : new Date(ms).toLocaleDateString()
}

// ---------------------------------------------------------------- documents
/**
 * Render names FIRST, then fill in titles and thumbnails as they arrive.
 *
 * The list has to appear immediately. Reading a document for its title is cheap
 * (a 300KB head), but its preview sits past the document block — a quarter of
 * the way into a 900KB file — so a folder of twenty decks is twenty megabytes.
 * Waiting for all of that before showing anything would make the popup feel
 * broken every time the cache is cold.
 */
async function renderDocs() {
  const docs = await listDocuments()
  $('count').textContent = docs.length ? `${docs.length} document${docs.length === 1 ? '' : 's'}` : ''

  if (!docs.length) {
    $('empty').hidden = false
    $('empty').textContent = 'No Bento documents in your folders yet.'
    return
  }

  // Newest first: the one you want is almost always the one you just had open.
  const withTimes = await Promise.all(docs.map(async (d) => {
    try { return { d, modified: (await d.handle.getFile()).lastModified } } catch { return { d, modified: 0 } }
  }))
  withTimes.sort((a, b) => b.modified - a.modified)

  const list = $('docs')
  list.innerHTML = ''
  // Folders we can list but not yet open. A dim row with a tooltip is not an
  // explanation — nobody hovers a thing that looks broken — so if any exist,
  // the list says once, in plain words, what unlocks them.
  const unplaced = new Set()
  for (const { d, modified } of withTimes) {
    const row = document.createElement('button')
    row.className = 'doc'
    // A document whose folder has never taught us its absolute path can be
    // listed but not opened — a directory handle has no path, and the prefix is
    // only learned when a document from that folder is saved. Say so on the row
    // rather than having a click do nothing.
    if (!d.path) {
      row.disabled = true
      row.title = `Open any document in ${d.folder} once from Finder, and everything in `
        + 'that folder becomes openable from here.'
      unplaced.add(d.folder)
    }
    row.innerHTML =
      `<span class="thumb" data-thumb></span>` +
      `<span class="meta"><b>${esc(d.base)}</b>` +
      `<span>${esc(d.folder)} · ${esc(ago(modified))}</span></span>`
    row.addEventListener('click', () => {
      if (!d.path) return
      chrome.tabs.create({ url: `file://${d.path.split('/').map(encodeURIComponent).join('/')}` })
      window.close()
    })
    list.appendChild(row)

    // Lazily, one at a time, so a cold cache does not read every document at
    // once and stall the popup it is decorating.
    void (async () => {
      try {
        const meta = await describe(d)
        row.querySelector('b').textContent = meta.title
        const thumb = row.querySelector('[data-thumb]')
        if (meta.encrypted) {
          thumb.innerHTML = '<span class="lock" title="Password-protected">🔒</span>'
        } else if (meta.preview) {
          // The preview block scales itself to whatever viewport it lands in —
          // that is what it was written for — so a fixed-size sandboxed frame
          // is all it needs. `sandbox` with no allow-scripts: this is somebody
          // else's document and it renders inert.
          const f = document.createElement('iframe')
          f.setAttribute('sandbox', '')
          f.srcdoc = meta.preview
          thumb.appendChild(f)
        } else {
          // No preview and not encrypted: a document that has never been saved,
          // which is exactly what "+ New document" just made. A page glyph says
          // "nothing rendered yet"; blank white says "this is broken".
          thumb.innerHTML = '<span class="blank" title="Not saved yet">▤</span>'
        }
      } catch { /* a row without a picture is still a row */ }
    })()
  }

  if (unplaced.size) {
    const note = $('empty')
    note.hidden = false
    const names = [...unplaced]
    note.innerHTML = 'Open one document in '
      + `<b>${esc(names.slice(0, 2).join('</b>, <b>'))}</b>`
      + (names.length > 2 ? ` and ${names.length - 2} more` : '')
      + ' from Finder once — Chrome does not tell an extension where a folder is, '
      + 'so opening a document is how Bento Tray learns. After that the whole folder '
      + 'opens from here.'
  }
}

// ------------------------------------------------------------------ plumbing
async function renderStatus() {
  const s = await status()
  const lapsed = s.folders.some((f) => f.permission !== 'granted')
  const dot = $('dot')
  const text = $('statusText')

  if (s.files === false) {
    dot.className = 'dot bad'
    text.innerHTML = '<span class="warn">Local file access is off</span>'
  } else if (!s.folders.length) {
    dot.className = 'dot meh'
    text.textContent = 'No folders yet'
  } else if (lapsed) {
    dot.className = 'dot bad'
    text.innerHTML = `<span class="warn">${s.folders.filter((f) => f.permission !== 'granted').length} `
      + 'folder needs reconnecting</span>'
  } else {
    dot.className = 'dot ok'
    const n = s.folders.length
    text.textContent = `${n} folder${n === 1 ? '' : 's'} · saves in place`
  }

  $('renew').hidden = !lapsed
  // Prime BEFORE the prompt, never after. "Allow on every visit" is offered
  // only on Chrome's restore dialog, that dialog cannot be summoned on demand,
  // and its three near-identical options say nothing about what they cost. So
  // the one thing worth doing is making sure the user recognises the middle
  // button before they see it.
  $('prime').hidden = !lapsed
  return s
}

$('renew').addEventListener('click', async () => {
  const btn = $('renew')
  btn.disabled = true
  const dirs = await getGrants()
  let ok = 0
  // ONE PROMPT PER CLICK, and stop at the first refusal. Chromium embargoes a
  // permission after kDefaultDismissalsBeforeBlock = 3 dismissals for
  // kDefaultEmbargoDays = 7, and FILE_SYSTEM_ACCESS_RESTORE_PERMISSION is on
  // that list. Those counts never reset — not on a grant, not over time — so
  // the budget is per-origin and lifetime. This loop used to raise a prompt per
  // folder, spending two of three on one impatient click.
  for (const dir of dirs) {
    try {
      if (await dir.queryPermission({ mode: 'readwrite' }) === 'granted') { ok++; continue }
      if (await dir.requestPermission({ mode: 'readwrite' }) !== 'granted') break
      ok++
    } catch { break }
  }
  if (ok) await putGrants(dirs)
  await setLapsedBadge()

  if (!ok) {
    // A silent refusal is "not yet", not "never": Chrome only offers the
    // restore prompt while the grant is dormant-and-eligible, so it can be
    // unavailable for a session or two and then return by itself.
    $('statusText').innerHTML = '<span class="warn">Chrome did not offer to restore it</span>'
    $('prime').hidden = true
    btn.textContent = 'Try again after restarting Chrome'
    return
  }
  location.reload()
})

$('new').addEventListener('click', async () => {
  const btn = $('new')
  const grants = await getGrants()
  if (!grants.length) { chrome.runtime.openOptionsPage(); window.close(); return }
  btn.disabled = true
  btn.textContent = 'Fetching the latest Bento…'
  try {
    // Into the first granted folder. Choosing between folders is a dialog this
    // popup does not need: the common case is one folder, and a document in the
    // wrong place is a drag away.
    const made = await newDocument(grants[0])
    btn.textContent = `Created ${made.base}`
    await renderDocs()
    btn.disabled = false
    btn.textContent = '+ New document'
  } catch (e) {
    btn.disabled = false
    btn.textContent = '+ New document'
    $('statusText').innerHTML = `<span class="warn">${esc(e.message)}</span>`
  }
})

$('open').addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
  window.close()
})

await renderStatus()
await renderDocs()
