// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The full page: somewhere to actually live with your documents.
//
// The popup answers "open the thing I just had" in 340px and dies when it loses
// focus. Browsing is a different job — folders, search, sorting, a thumbnail big
// enough to recognise a deck by — and it needs a page that stays open.
//
// Everything here reads through `library.js`, so the popup and this page cannot
// disagree about what a document is or where it lives. The rules that matter
// (enumeration is fine here, resolution never enumerates; the absolute path is
// learned, not derived) live there and are explained there.

import { getGrants, putGrants, status } from './status.js'
import { listDocuments, describe, newDocument, duplicate, rename, APPS } from './library.js'
import { prefixFor } from './route.js'
import { learnPrefix } from './db.js'

/**
 * Find the granted folders on disk, without sending anyone to Finder.
 *
 * THE PROBLEM. A `FileSystemDirectoryHandle` never exposes a path, so the
 * extension can read and write a folder while having no idea where it is — and
 * an absolute path is what a tab needs to open a document. Until now the only
 * source was a document loading out of the folder and its content script
 * reporting `sender.url`. Which works, and is a terrible first run: install the
 * thing, open it, and every document is greyed out with instructions to go
 * double-click something in Finder first.
 *
 * THE WAY OUT. Chrome already knows. If a document has ever been opened, its
 * `file://` URL is in history, and one search yields the absolute path of every
 * Bento document the user has. That is enough to place every folder at once.
 *
 * WHY IT IS OPTIONAL, AND HELD FOR SECONDS. "Read your browsing history" is a
 * heavy permission and a fair thing to balk at on a store listing, so it is not
 * requested at install: it is asked for by a button, at the moment it is needed,
 * with the reason on screen — and handed straight back. The extension holds it
 * for the length of one query.
 *
 * NOTHING IS TRUSTED. A history URL is a hint, not an answer. Every candidate
 * is verified by `prefixFor`, which walks the route inside the grant and makes
 * `dir.resolve()` agree with the path's own tail. A path that cannot be proven
 * to be inside a granted folder teaches nothing.
 */
async function locateFolders() {
  const granted = await chrome.permissions.request({ permissions: ['history'] })
  if (!granted) return { learned: 0, declined: true }

  let learned = 0
  try {
    const items = await chrome.history.search({
      text: '.bento.html', maxResults: 5000, startTime: 0,
    })
    const grants = await getGrants()
    const need = new Set(grants.map((g) => g.name))
    for (const it of items) {
      if (!need.size) break
      if (!it.url?.startsWith('file://')) continue
      let path
      try { path = decodeURIComponent(new URL(it.url).pathname) } catch { continue }
      for (const dir of grants) {
        if (!need.has(dir.name)) continue
        if (await dir.queryPermission({ mode: 'readwrite' }) !== 'granted') continue
        const prefix = await prefixFor(dir, path)
        if (!prefix) continue
        await learnPrefix(dir.name, prefix)
        need.delete(dir.name)
        learned++
      }
    }
  } finally {
    // Straight back. Holding history access after the question has been
    // answered would be taking more than was asked for.
    await chrome.permissions.remove({ permissions: ['history'] }).catch(() => {})
  }
  return { learned, declined: false }
}

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

const state = { docs: [], folder: null, q: '', sort: 'recent' }

function toast(text) {
  const t = document.createElement('div')
  t.className = 'toast'
  t.textContent = text
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 2600)
}

// ------------------------------------------------------------------ loading
async function load() {
  const docs = await listDocuments()
  // Read mtimes once, here, rather than per render: sorting needs them and the
  // grid is re-rendered on every keystroke of the search box.
  state.docs = await Promise.all(docs.map(async (d) => {
    let modified = 0
    try { modified = (await d.handle.getFile()).lastModified } catch { /* vanished mid-list */ }
    return { ...d, modified }
  }))
  renderSidebar()
  renderGrid()
}

// ------------------------------------------------------------------ sidebar
function renderSidebar() {
  const byFolder = new Map()
  for (const d of state.docs) byFolder.set(d.folder, (byFolder.get(d.folder) ?? 0) + 1)

  $('nAll').textContent = state.docs.length || ''
  $('navAll').setAttribute('aria-current', String(state.folder === null))

  const host = $('folders')
  host.innerHTML = ''
  for (const [folder, n] of byFolder) {
    const b = document.createElement('button')
    b.className = 'navitem'
    b.setAttribute('aria-current', String(state.folder === folder))
    b.innerHTML = `<span class="swatch"></span> ${esc(folder)} <span class="n">${n}</span>`
    b.addEventListener('click', () => { state.folder = folder; renderSidebar(); renderGrid() })
    host.appendChild(b)
  }
}

$('navAll').addEventListener('click', () => { state.folder = null; renderSidebar(); renderGrid() })

// --------------------------------------------------------------------- grid
function visible() {
  const q = state.q.trim().toLowerCase()
  let docs = state.docs.filter((d) => state.folder === null || d.folder === state.folder)
  if (q) {
    // Match the TITLE once it is known, and the file name always — a document
    // whose thumbnail has not loaded yet is still findable by what it is called
    // on disk, which is what the user typed if they came from Finder.
    docs = docs.filter((d) => (d.title ?? d.base).toLowerCase().includes(q)
      || d.base.toLowerCase().includes(q) || d.folder.toLowerCase().includes(q))
  }
  const by = {
    recent: (a, b) => b.modified - a.modified,
    name: (a, b) => (a.title ?? a.base).localeCompare(b.title ?? b.base),
    folder: (a, b) => a.folder.localeCompare(b.folder) || b.modified - a.modified,
  }[state.sort]
  return docs.sort(by)
}

function renderGrid() {
  const grid = $('grid')
  const docs = visible()
  $('heading').textContent = state.folder ?? 'All documents'
  grid.innerHTML = ''

  if (!docs.length) {
    grid.innerHTML = state.q
      ? `<div class="empty"><h2>Nothing matches “${esc(state.q)}”</h2>
         <p>Search looks at document titles, file names and folders.</p></div>`
      : `<div class="empty"><h2>No documents here yet</h2>
         <p>Bento documents are single HTML files — everything is inside them, so they
         work offline and travel by AirDrop, email or a USB stick like any other file.</p>
         <p><b>+ New document</b> fetches the current release and puts a fresh one in
         your folder.</p></div>`
    return
  }

  for (const d of docs) {
    const card = document.createElement('button')
    card.className = 'card'
    if (!d.path) {
      card.disabled = true
      card.title = `Open any document in ${d.folder} once from Finder, and everything in `
        + 'that folder opens from here.'
    }
    card.innerHTML =
      `<span class="shot"><span class="glyph">▤</span></span>` +
      `<span class="cardbody"><span class="txt">` +
      `<b>${esc(d.title ?? d.base)}</b>` +
      `<span>${esc(d.folder)} · ${esc(ago(d.modified))}</span>` +
      `</span><span class="more" title="More">⋯</span></span>`

    card.addEventListener('click', (ev) => {
      if (ev.target.closest('.more')) { ev.stopPropagation(); openMenu(d, ev); return }
      openDoc(d)
    })
    grid.appendChild(card)
    void decorate(card, d)
  }
}

/**
 * Fill in the title and the thumbnail once the document has been read.
 *
 * Progressive on purpose. The title is a 300KB head; the preview sits past the
 * document block, so a folder of twenty is twenty megabytes on a cold cache.
 * Waiting for that before drawing anything would make the page feel broken
 * every first run.
 */
async function decorate(card, d) {
  try {
    const meta = await describe(d)
    d.title = meta.title
    card.querySelector('b').textContent = meta.title
    const shot = card.querySelector('.shot')
    if (meta.encrypted) {
      shot.innerHTML = '<span class="glyph" title="Password-protected">🔒</span>'
      return
    }
    if (!meta.preview) return // never saved: the page glyph already says so
    shot.innerHTML = ''
    const f = document.createElement('iframe')
    // No scripts. This is somebody else's document and it renders inert; the
    // preview block is a still render and needs nothing to run.
    f.setAttribute('sandbox', '')
    f.srcdoc = meta.preview
    shot.appendChild(f)
    // The preview scales itself to its viewport, so give it a real one (1280
    // wide, in CSS) and scale the whole frame down to the card. Sizing the
    // iframe small instead would hand it a phone-shaped viewport and it would
    // lay page one out for that.
    const fit = () => {
      const scale = shot.clientWidth / 1280
      f.style.transform = `scale(${scale})`
    }
    fit()
    new ResizeObserver(fit).observe(shot)
  } catch { /* a card without a picture is still a card */ }
}

function openDoc(d) {
  if (!d.path) return
  chrome.tabs.create({ url: `file://${d.path.split('/').map(encodeURIComponent).join('/')}` })
}

// --------------------------------------------------------------------- menu
let menuEl = null
const closeMenu = () => { menuEl?.remove(); menuEl = null }
addEventListener('click', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu() })
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu() })

function openMenu(d, ev) {
  closeMenu()
  const m = document.createElement('div')
  m.className = 'menu'
  m.style.left = `${Math.min(ev.clientX, innerWidth - 200)}px`
  m.style.top = `${Math.min(ev.clientY, innerHeight - 200)}px`

  const item = (label, fn) => {
    const b = document.createElement('button')
    b.textContent = label
    b.addEventListener('click', async () => { closeMenu(); try { await fn() } catch (e) { toast(e.message) } })
    m.appendChild(b)
  }

  if (d.path) item('Open', () => openDoc(d))
  item('Duplicate', async () => {
    const made = await duplicate(d)
    toast(`Duplicated as ${made.base}`)
    await load()
  })
  item('Rename…', async () => {
    const next = prompt('Rename document', d.title ?? d.base)
    if (next == null) return
    const made = await rename(d, next)
    toast(`Renamed to ${made.base}`)
    await load()
  })
  if (d.path) {
    item('Copy path', async () => {
      await navigator.clipboard.writeText(d.path)
      toast('Path copied')
    })
  }
  // No Delete. A file manager that can destroy documents needs an undo, a trash
  // and a confirmation people actually read; Finder has all three and is one
  // keystroke away. Duplicating and renaming are recoverable, deleting is not.
  m.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }))
  const note = document.createElement('div')
  note.className = 'note'
  note.textContent = d.path ? `${d.folder}/${d.name}` : `${d.folder} — not opened yet`
  m.appendChild(note)

  document.body.appendChild(m)
  menuEl = m
}

// ------------------------------------------------------------------ notices
async function renderNotice() {
  const s = await status()
  const host = $('notice')
  host.innerHTML = ''
  const say = (cls, html) => {
    const el = document.createElement('div')
    el.className = `notice ${cls}`
    el.innerHTML = html
    host.appendChild(el)
  }

  if (s.files === false) {
    say('bad', '<b>Local file access is off.</b> Open <code>chrome://extensions</code>, find '
      + 'Bento Tray, and turn on <b>Allow access to file URLs</b>. Nothing works until it is on, '
      + 'and no extension can turn it on for itself.')
  }
  const lapsed = s.folders.filter((f) => f.permission !== 'granted')
  if (lapsed.length) {
    say('bad', `<b>${lapsed.length} folder needs reconnecting.</b> Chrome drops the permission when `
      + 'the extension restarts. Open Bento Tray from the toolbar to restore it — and choose '
      + '<b>Allow on every visit</b>, which is the only option that lasts.')
  }
  // The one that unlocks opening. Said here in full, because the page has room
  // for the reason and the popup does not.
  const unplaced = [...new Set(state.docs.filter((d) => !d.path).map((d) => d.folder))]
  if (unplaced.length) {
    const el = document.createElement('div')
    el.className = 'notice'
    el.innerHTML = `<b>${esc(unplaced.join(', '))}</b> — Bento Tray can read `
      + `${unplaced.length === 1 ? 'this folder' : 'these folders'} but does not know where `
      + `${unplaced.length === 1 ? 'it is' : 'they are'} on disk, so documents cannot be opened `
      + 'from here yet. Chrome never tells an extension a folder’s path. '
      + '<span style="opacity:.8">Chrome does know it from documents you have already opened — '
      + 'one search finds it. Permission is asked for now and given straight back.</span>'
    const go = document.createElement('button')
    go.className = 'btn primary'
    go.style.marginTop = '9px'
    go.textContent = 'Find my folders'
    go.addEventListener('click', async () => {
      go.disabled = true
      go.textContent = 'Looking…'
      try {
        const { learned, declined } = await locateFolders()
        if (declined) {
          go.disabled = false
          go.textContent = 'Find my folders'
          // Declining is a legitimate answer, not an error. The manual route
          // still works and costs one trip to Finder, so say so plainly rather
          // than asking again.
          el.innerHTML = '<b>No problem.</b> The other way is to open any document in '
            + `${esc(unplaced.join(' or '))} from Finder once — this page notices and unlocks `
            + 'the whole folder.'
          return
        }
        await load()
        await renderNotice()
        toast(learned
          ? `Found ${learned} folder${learned === 1 ? '' : 's'}`
          : 'Nothing in history yet — open one document from Finder')
      } catch (e) {
        go.disabled = false
        go.textContent = 'Find my folders'
        toast(e.message)
      }
    })
    el.appendChild(document.createElement('br'))
    el.appendChild(go)
    host.appendChild(el)
  }
}

// ------------------------------------------------------------------ actions
$('q').addEventListener('input', (e) => { state.q = e.target.value; renderGrid() })
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; renderGrid() })

// `/` focuses search, the convention everywhere text is listed. Not while
// typing in a field, or it eats the character.
addEventListener('keydown', (e) => {
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
    e.preventDefault(); $('q').focus()
  }
  if (e.key === 'Escape' && document.activeElement === $('q')) {
    $('q').value = ''; state.q = ''; renderGrid()
  }
})

$('addFolder').addEventListener('click', async () => {
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' })
    await dir.requestPermission({ mode: 'readwrite' })
    const dirs = await getGrants()
    for (const existing of dirs) if (await existing.isSameEntry(dir)) return
    await putGrants([...dirs, dir])
    await load()
    await renderNotice()
  } catch (e) {
    if (e?.name !== 'AbortError') toast(e.message)
  }
})

/**
 * Which Bento to make.
 *
 * Every other operation here is app-blind: `.bento.html` is the whole family,
 * they share a kernel, and a document says what it is by carrying its own
 * runtime. Creating one is the single moment that has to ask, because there is
 * no document yet to ask.
 */
$('new').addEventListener('click', async (ev) => {
  const grants = await getGrants()
  if (!grants.length) { $('addFolder').click(); return }
  // Into the folder being looked at, when one is; otherwise the first granted.
  // A new document appearing in a folder you are not looking at is a small
  // mystery, and mysteries are what a file manager exists to prevent.
  const target = state.folder
    ? grants.find((g) => g.name === state.folder) ?? grants[0]
    : grants[0]

  closeMenu()
  const m = document.createElement('div')
  m.className = 'menu'
  const r = ev.target.getBoundingClientRect()
  m.style.left = `${Math.max(12, r.right - 200)}px`
  m.style.top = `${r.bottom + 6}px`

  for (const app of APPS) {
    const b = document.createElement('button')
    b.innerHTML = `<b>${esc(app.name)}</b> <span style="color:var(--dim)">${esc(app.blurb)}</span>`
    b.addEventListener('click', async () => {
      closeMenu()
      const btn = $('new')
      btn.disabled = true
      btn.textContent = `Fetching ${app.name}…`
      try {
        // The signed release, fetched now, rather than a copy bundled in the
        // extension: a document made here is the same build everyone else has
        // today, and the extension never needs re-reviewing to keep up.
        const made = await newDocument(target, 'Untitled', { app: app.id })
        toast(`Created ${made.base} (${made.app} ${made.version}) in ${target.name}`)
        await load()
      } catch (e) {
        toast(e.message)
      } finally {
        btn.disabled = false
        btn.textContent = '+ New document'
      }
    })
    m.appendChild(b)
  }
  const note = document.createElement('div')
  note.className = 'note'
  note.textContent = `into ${target.name}`
  m.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }))
  m.appendChild(note)

  document.body.appendChild(m)
  menuEl = m
})

$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage())

/**
 * Notice when the answer arrives.
 *
 * The one unlock step happens OUTSIDE this page: a document is opened from
 * Finder, its content script says hello, and the worker records where that
 * folder lives. Nothing tells the page. Without this, the user does exactly what
 * was asked, comes back to a tab still showing greyed-out cards, and reasonably
 * concludes it did not work.
 *
 * Coming back to the tab is the signal — you cannot open a document from Finder
 * without leaving it. Cheap to act on: the document list is a directory walk and
 * the expensive part, reading each file, is cached by size and mtime.
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  void (async () => {
    const before = state.docs.filter((d) => d.path).length
    await load()
    await renderNotice()
    const after = state.docs.filter((d) => d.path).length
    if (after > before) toast(`${state.folder ?? 'Your documents'} — unlocked`)
  })()
})

await load()
await renderNotice()
