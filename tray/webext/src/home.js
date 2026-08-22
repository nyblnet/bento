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
import { learnPrefix, GRANT, get, put } from './db.js'
import { checkForUpdate, pendingUpdate, isSelfManaged, autoCheckEnabled, setAutoCheck } from './update.js'
import { t, localize, LOCALES, localeLabel, localeOverride, setLocale, initI18n }
  from './i18n.js'

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
  if (m < 1) return t('agoJustNow')
  if (m < 60) return t('agoMinutes', m)
  const h = Math.round(m / 60)
  if (h < 24) return t(h === 1 ? 'agoHour' : 'agoHours', h)
  const d = Math.round(h / 24)
  if (d < 30) return t(d === 1 ? 'agoDay' : 'agoDays', d)
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

// `view` is which SCREEN is showing (docs/settings/help); `layout` is how the
// documents are drawn within it. Two different words on purpose — they were
// briefly the same one, and "view" then meant two things one line apart.
const state = { docs: [], folder: null, q: '', sort: 'recent', view: 'docs', layout: 'icons' }

/**
 * Settings is a VIEW here, not a separate page.
 *
 * It used to be `options.html`: its own document, its own stylesheet, 16
 * hardcoded colours and no dark mode — the same product in a second costume,
 * reached by leaving the one you were in. Folding it into this shell means one
 * design system, one back-and-forth-free navigation, and one place that knows
 * what a folder is.
 */
function show(view) {
  state.view = view
  const docs = view === 'docs'
  $('searchWrap').hidden = !docs
  $('sort').hidden = !docs
  $('new').hidden = !docs
  // How documents are DRAWN is meaningless where none are: Settings and Help
  // replace the scroller entirely, so the toggle would sit over a page it
  // cannot affect.
  $('layout').hidden = !docs
  $('settings').setAttribute('aria-current', String(view === 'settings'))
  $('help').setAttribute('aria-current', String(view === 'help'))
  $('navAll').setAttribute('aria-current', String(docs && state.folder === null))
  if (docs) { renderSidebar(); renderGrid() }
  else if (view === 'settings') renderSettings()
  else renderHelp()
}

function toast(text) {
  const t = document.createElement('div')
  t.className = 'toast'
  t.textContent = text
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 2600)
}

// ------------------------------------------------------------------ loading
async function load() {
  const s = await status()
  state.grants = s.folders.length
  state.fileAccess = s.files
  state.selfManaged = await isSelfManaged()
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
    b.innerHTML = `<span class="dot"></span> ${esc(folder)} <span class="n">${n}</span>`
    b.addEventListener('click', () => { state.folder = folder; show('docs') })
    host.appendChild(b)
  }
}

$('navAll').addEventListener('click', () => { state.folder = null; show('docs') })

// --------------------------------------------------------------------- grid
function visible() {
  const q = state.q.trim().toLowerCase()
  let docs = state.docs.filter((d) => state.folder === null || d.folder === state.folder)
  if (q) {
    // Match the TITLE once it is known, and the file name always — a document
    // whose thumbnail has not loaded yet is still findable by what it is called
    // on disk, which is what the user typed if they came from Finder.
    // Title, file name, folder — and the document's own words once they have
    // been read. `text` arrives with the thumbnail, so a cold list matches on
    // names and gets deeper as it decorates, rather than making anyone wait.
    docs = docs.filter((d) => (d.title ?? d.base).toLowerCase().includes(q)
      || d.base.toLowerCase().includes(q) || d.folder.toLowerCase().includes(q)
      || (d.text ?? '').toLowerCase().includes(q))
  }
  const by = {
    recent: (a, b) => b.modified - a.modified,
    name: (a, b) => (a.title ?? a.base).localeCompare(b.title ?? b.base),
    folder: (a, b) => a.folder.localeCompare(b.folder) || b.modified - a.modified,
  }[state.sort]
  return docs.sort(by)
}

/**
 * The first run, as steps rather than an apology.
 *
 * Installing used to land you on an empty page with a sentence. Both things
 * that must happen are outside this extension's power — a folder you choose,
 * and a Chrome switch no extension may touch — so the honest presentation is a
 * short list that shows which are done, not a paragraph explaining why nothing
 * works.
 */
function firstRun() {
  const el = document.createElement('div')
  el.className = 'empty'
  el.innerHTML = `<h2>${t('setupTitle')}</h2><p>${t('setupLead')}</p>`

  const steps = document.createElement('div')
  steps.className = 'steps'
  const step = (n, done, title, note, btn) => {
    const s = document.createElement('div')
    s.className = `step${done ? ' done' : ''}`
    s.innerHTML = `<span class="num">${done ? '✓' : n}</span>`
      + `<span class="txt"><b>${esc(title)}</b><small>${note}</small></span>`
    if (btn && !done) s.querySelector('.txt').appendChild(btn)
    steps.appendChild(s)
  }

  const pick = document.createElement('button')
  pick.className = 'btn primary'
  pick.textContent = t('chooseFolder')
  pick.onclick = () => $('addFolder').click()
  step(1, !!state.grants, t('setupStep1'), t('setupStep1Note'), pick)

  step(2, state.fileAccess === true, t('setupStep2'), t('setupStep2Note'))

  el.appendChild(steps)

  // An unpacked install with no folders is ALSO what a botched upgrade looks
  // like: extract the new version to a new directory, load unpacked from there,
  // and Chrome gives it a different id — a different origin with an empty
  // store. Everything is intact under the old id, which is still installed.
  // Nothing here can detect that, but this is the exact screen it produces, so
  // it is the right place to say so.
  if (state.selfManaged) {
    const note = document.createElement('p')
    note.className = 'sub'
    note.style.marginTop = '14px'
    note.innerHTML = t('setupUpgradeNote')
    el.appendChild(note)
  }
  return el
}

/** A small mark on a card's picture. Never in the body, where it would push the
 *  title around and make two cards with the same title look different lengths. */
function badge(card, text, why) {
  const host = card.querySelector('[data-badges]')
  if (!host) return
  const s = document.createElement('span')
  s.textContent = text
  if (why) s.title = why
  host.appendChild(s)
}

function renderGrid() {
  // The settings view replaces the scroller's contents, so the grid is rebuilt
  // rather than assumed to still be there.
  const scroll = document.querySelector('.scroll')
  scroll.innerHTML = '<div class="grid" id="grid"></div>'
  const grid = $('grid')
  if (state.layout === 'list') grid.classList.add('as-list')
  const docs = visible()
  $('heading').textContent = state.folder ?? t('navAll')

  if (!docs.length) {
    // Three different emptinesses, and telling them apart is the whole job of
    // an empty state. Nothing installed yet is a set-up problem; nothing found
    // is a search problem; an empty folder is neither.
    if (state.q) {
      grid.innerHTML = `<div class="empty"><h2>${esc(t('noMatches', state.q))}</h2>`
        + `<p>${t('searchScope')}</p></div>`
    } else if (!state.grants) {
      grid.appendChild(firstRun())
    } else {
      grid.innerHTML = `<div class="empty"><h2>${t('folderEmpty')}</h2>`
        + `<p>${t('folderEmptyHint')}</p></div>`
    }
    return
  }

  for (const d of docs) {
    const card = document.createElement('button')
    card.className = 'card'
    // TWO different absences looked identical, and one of them is not a
    // problem. A document with no thumbnail has simply never been saved — a
    // shell only gets its page-one render written into it on the first save —
    // while a document with no path cannot be opened at all. Both used to be a
    // pale card with a grey glyph, so five perfectly good documents read as
    // broken. The states now say which they are, in words.
    if (!d.path) {
      card.disabled = true
      card.classList.add('unplaced')
      card.title = t('cardUnplacedTip', d.folder)
    }
    // Found by its CONTENT rather than its name. It lists and opens like any
    // other, but the bridge that saves in place is a content script matching
    // `file:///*.bento.html`, so this one will still ask where to put itself.
    // Listing it without saying that would be a trap: the tray would look like
    // it fully supports a document it half supports.
    if (!d.named) {
      card.classList.add('renamed')
      card.title = t('cardRenamedTip', d.name)
    }
    card.innerHTML =
      `<span class="shot"><span class="glyph">${d.path ? '▤' : '⤺'}</span></span>` +
      '<span class="badges" data-badges></span>' +
      `<span class="cardbody"><span class="txt">` +
      `<b>${esc(d.title ?? d.base)}</b>` +
      `<span>${esc(d.folder)} · ${esc(ago(d.modified))}</span>` +
      `</span><span class="more" title="More">⋯</span></span>`
    if (!d.named) badge(card, '.html', t('badgeRenamed'))

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
    d.app = meta.app
    d.text = meta.text
    card.querySelector('b').textContent = meta.title
    // Which Bento this is. Three apps write .bento.html now, and without this a
    // folder of decks, notes and sheets is one undifferentiated pile. Absent on
    // a document nobody has saved, which has no format field yet — and that is
    // already said by "Not saved yet" rather than twice.
    if (meta.app) {
      const known = APPS.find((a) => a.id === meta.app)
      badge(card, known?.name ?? meta.app, known?.blurb)
    }
    const shot = card.querySelector('.shot')
    if (meta.encrypted) {
      shot.innerHTML = `<span class="glyph" title="${t('encrypted')}">🔒</span>`
      return
    }
    if (!meta.preview) {
      // Not a failure, and it should not look like one. A shell has its
      // page-one render written in on the FIRST SAVE, so a document that has
      // never been saved — including every one `+ New document` creates — has
      // nothing to show yet, and says so instead of sitting there blank.
      if (d.path) shot.innerHTML = `<span class="label">${t('notSavedYet')}</span>`
      return
    }
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

  if (d.path) item(t('menuOpen'), () => openDoc(d))
  item(t('menuDuplicate'), async () => {
    const made = await duplicate(d)
    toast(t('duplicatedAs', made.base))
    await load()
  })
  item(t('menuRename'), async () => {
    const next = prompt(t('renamePrompt'), d.title ?? d.base)
    if (next == null) return
    const made = await rename(d, next)
    toast(t('renamedTo', made.base))
    await load()
  })
  if (d.path) {
    item(t('menuCopyPath'), async () => {
      await navigator.clipboard.writeText(d.path)
      toast(t('pathCopied'))
    })
  }
  // No Delete. A file manager that can destroy documents needs an undo, a trash
  // and a confirmation people actually read; Finder has all three and is one
  // keystroke away. Duplicating and renaming are recoverable, deleting is not.
  m.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }))
  const note = document.createElement('div')
  note.className = 'note'
  note.textContent = d.path ? `${d.folder}/${d.name}` : t('folderNotOpenedYet', d.folder)
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
    // One sentence, then where to go. The reason it cannot be automated is
    // interesting to us and not to someone trying to save a document.
    say('bad', t('noticeFileAccessOff'))
  }
  // An update, for installs that will never fetch one themselves. Deliberately
  // NOT on the badge: the badge means "something is broken and saving will
  // prompt", and being a version behind is neither.
  const upd = await pendingUpdate()
  if (upd?.version) {
    // THE STEPS MATTER, and the wrong ones lose everything.
    //
    // An unpacked extension's ID comes from its DIRECTORY PATH. Extract the new
    // version somewhere else and "Load unpacked" from there, and Chrome treats
    // it as a different extension: a different origin, an empty IndexedDB, no
    // granted folders, no learned paths, no preferences — and the old copy
    // still installed beside it. The user lands on the first-run screen
    // wondering where their folders went, having done the obvious thing.
    //
    // Replacing the files in the SAME folder keeps the id, so everything
    // survives. That is the whole instruction, and it has to be said or the
    // obvious path is the destructive one.
    say('', t('updateAvailable', esc(upd.version))
      + '<ol style="margin:8px 0 0;padding-left:18px">'
      + `<li><a href="${esc(upd.url)}" target="_blank" rel="noopener">${t('updateStep1')}</a></li>`
      + `<li>${t('updateStep2')}</li>`
      + `<li>${t('updateStep3')}</li>`
      + '</ol>')
  }

  const lapsed = s.folders.filter((f) => f.permission !== 'granted')
  if (lapsed.length) {
    say('bad', t('noticeLapsed', lapsed.length))
  }
  // The one that unlocks opening. Said here in full, because the page has room
  // for the reason and the popup does not.
  const unplaced = [...new Set(state.docs.filter((d) => !d.path).map((d) => d.folder))]
  if (unplaced.length) {
    const el = document.createElement('div')
    el.className = 'notice'
    el.innerHTML = t('noticeUnplaced', esc(unplaced.join(', ')))
    const go = document.createElement('button')
    go.className = 'btn primary'
    go.style.marginTop = '9px'
    go.textContent = t('findFolders')
    go.addEventListener('click', async () => {
      go.disabled = true
      go.textContent = t('looking')
      try {
        const { learned, declined } = await locateFolders()
        if (declined) {
          go.disabled = false
          go.textContent = t('findFolders')
          // Declining is a legitimate answer, not an error. The manual route
          // still works and costs one trip to Finder, so say so plainly rather
          // than asking again.
          el.innerHTML = t('findDeclined', esc(unplaced.join(' or ')))
          return
        }
        await load()
        await renderNotice()
        toast(learned
          ? t(learned === 1 ? 'foundFolder' : 'foundFolders', learned)
          : t('foundNothing'))
      } catch (e) {
        go.disabled = false
        go.textContent = t('findFolders')
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

// ------------------------------------------------------------------- about
//
// A dialog rather than a view, opened from the wordmark — the idiom bento/slides
// already uses, so the same question is asked the same way across the suite.
// <dialog> is used for what it gives free: Esc closes it, focus is trapped and
// restored, and the backdrop is inert without a click-outside handler of ours.
function openAbout() {
  const dlg = $('aboutDlg')
  const body = $('aboutBody')
  const mine = chrome.runtime.getManifest().version
  body.innerHTML = `<p>${t('helpAboutSub', esc(mine))}</p>`

  const links = document.createElement('div')
  links.className = 'links'
  for (const [label, href] of [
    ['bento.page', 'https://bento.page'],
    [t('linkSource'), 'https://github.com/nyblnet/bento'],
    [t('linkIssues'), 'https://github.com/nyblnet/bento/issues'],
    [t('linkReleases'), 'https://github.com/nyblnet/bento/releases'],
  ]) {
    const a = document.createElement('a')
    a.className = 'btn'
    a.href = href
    a.target = '_blank'
    a.rel = 'noopener'
    a.textContent = label
    links.appendChild(a)
  }
  body.appendChild(links)
  dlg.showModal()
}

$('brand').addEventListener('click', openAbout)
$('aboutClose').addEventListener('click', () => $('aboutDlg').close())
// Clicking the backdrop closes it. The dialog's own box is a child, so a click
// that lands on the element itself and not on any descendant IS the backdrop.
$('aboutDlg').addEventListener('click', (e) => { if (e.target === $('aboutDlg')) $('aboutDlg').close() })

// ------------------------------------------------------------- icons / list
//
// Stored per DEVICE rather than per folder. Finder remembers per directory,
// but Finder's folders are a place you furnish; these are a flat list of
// grants that the user rarely revisits and never arranges, so a per-folder
// memory would mostly be a setting that appears to forget itself.
//
// Kept in the same IndexedDB store as every other preference (update.js does
// the same with `autoCheck`) so there is one place a preference lives.
const LAYOUTS = ['icons', 'list']

function paintLayout() {
  for (const b of $('layout').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.layout === state.layout))
  }
}

async function setLayout(next) {
  if (!LAYOUTS.includes(next) || next === state.layout) return
  state.layout = next
  paintLayout()
  renderGrid()
  try { await put(GRANT, 'layout', next) } catch { /* the view still changed */ }
}

$('layout').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-layout]')
  if (b) void setLayout(b.dataset.layout)
})

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
      btn.textContent = t('fetchingApp', app.name)
      try {
        // The signed release, fetched now, rather than a copy bundled in the
        // extension: a document made here is the same build everyone else has
        // today, and the extension never needs re-reviewing to keep up.
        const made = await newDocument(target, 'Untitled', { app: app.id })
        toast(t('createdIn', made.base, `${made.app} ${made.version}`, target.name))
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
  note.textContent = t('intoFolder', target.name)
  m.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }))
  m.appendChild(note)

  document.body.appendChild(m)
  menuEl = m
})

$('settings').addEventListener('click', () => show('settings'))
$('help').addEventListener('click', () => show('help'))

/**
 * What this gives you, what it needs, and where it came from — in one place.
 *
 * Onboarding, help and about are the same three questions asked at different
 * moments: "what is this", "how do I use it", "who made it". Three separate
 * surfaces would repeat each other and drift; one view answers all three, and
 * a fresh install is simply sent here.
 *
 * It shows LIVE state, not a leaflet. The setup steps tick themselves off, so
 * this is also the page to come back to when something has stopped working —
 * which is when people actually look for help.
 */
async function renderHelp() {
  $('heading').textContent = t('navHelp')
  const s = await status()
  const wrap = document.createElement('div')
  wrap.className = 'panel'

  const section = (title, sub) => {
    const el = document.createElement('section')
    el.innerHTML = `<h2>${esc(title)}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}`
    wrap.appendChild(el)
    return el
  }

  // --- what it is for
  const what = section(t('helpWhatTitle'), t('helpWhatSub'))
  const tour = document.createElement('div')
  tour.className = 'tour'
  for (const [title, body] of [
    [t('tourSaveTitle'), t('tourSaveBody')],
    [t('tourFindTitle'), t('tourFindBody')],
    [t('tourSwitchTitle'), t('tourSwitchBody')],
    [t('tourNewTitle'), t('tourNewBody')],
  ]) {
    const c = document.createElement('div')
    c.className = 'card'
    c.innerHTML = `<b>${esc(title)}</b><p>${body}</p>`
    tour.appendChild(c)
  }
  what.appendChild(tour)

  // --- what it needs, live
  const needs = section(t('helpNeedsTitle'), t('helpNeedsSub'))
  const step = (done, title, note) => {
    const el = document.createElement('div')
    el.className = `row${done ? '' : ''}`
    el.innerHTML = `<span class="dot ${done ? 'ok' : 'bad'}"></span><b>${esc(title)}</b>`
      + `<span class="note">${note}</span>`
    needs.appendChild(el)
    return el
  }
  const folderRow = step(s.folders.length > 0, t('helpFolder'),
    s.folders.length ? t('helpFolderGranted', s.folders.length) : t('helpFolderNone'))
  if (!s.folders.length) {
    const b = document.createElement('button')
    b.className = 'btn'
    b.textContent = t('chooseFolder')
    b.onclick = () => $('addFolder').click()
    folderRow.appendChild(b)
  }
  step(s.files !== false, t('setAccessTitle'),
    s.files === false ? t('helpAccessOff')
      : s.files === null ? t('helpAccessUnknown') : t('helpAccessOn'))

  // --- what it never does
  section(t('helpNeverTitle'), t('helpNeverSub'))

  // Where it came from is NOT repeated here. It lives in the About dialog on
  // the wordmark (openAbout) — one answer in one place, reachable without
  // leaving whatever you were doing.

  const scroll = document.querySelector('.scroll')
  scroll.innerHTML = ''
  scroll.appendChild(wrap)
}

/**
 * Settings: the folders, and the two permissions that both fail silently.
 *
 * Everything here was prose in the old options page. It is now rows, because a
 * folder is a thing with a state and an action, and a paragraph about it is
 * neither.
 */
async function renderSettings() {
  $('heading').textContent = t('navSettings')
  const s = await status()
  const dirs = await getGrants()
  const wrap = document.createElement('div')
  wrap.className = 'panel'

  const section = (title, sub) => {
    const el = document.createElement('section')
    el.innerHTML = `<h2>${esc(title)}</h2><p class="sub">${sub}</p>`
    wrap.appendChild(el)
    return el
  }

  // --- folders
  const folders = section(t('navFolders'), t('setFoldersSub'))
  if (!dirs.length) {
    const p = document.createElement('p')
    p.className = 'dim'
    p.textContent = t('noneYet')
    folders.appendChild(p)
  }
  dirs.forEach((dir, i) => {
    const granted = s.folders[i]?.permission === 'granted'
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `<span class="dot ${granted ? 'ok' : 'bad'}"></span><b>${esc(dir.name)}</b>`
      + `<span class="note">${granted ? t('savesInPlace') : t('needsReconnecting')}</span>`
    if (!granted) {
      const renew = document.createElement('button')
      renew.className = 'btn'
      renew.textContent = t('reconnect')
      renew.title = t('reconnectTip')
      renew.onclick = () => act(async () => {
        if (await dir.requestPermission({ mode: 'readwrite' }) === 'granted') await putGrants(dirs)
      })
      row.appendChild(renew)
    }
    const drop = document.createElement('button')
    drop.className = 'btn'
    drop.textContent = t('remove')
    // This list is the only place access can be withdrawn — Chrome offers no
    // control for extension origins — so Remove is a real revoke: with no
    // folder stored there is nothing to write through.
    drop.title = t('removeTip')
    drop.onclick = () => act(async () => {
      const next = [...dirs]; next.splice(i, 1); await putGrants(next)
    })
    row.appendChild(drop)
    folders.appendChild(row)
  })
  const add = document.createElement('button')
  add.className = 'btn'
  add.textContent = t('addFolder')
  add.onclick = () => $('addFolder').click()
  folders.appendChild(add)

  // --- the language, which Chrome will not let you change on macOS
  //
  // `chrome.i18n` follows the browser's UI language and cannot be redirected,
  // and on macOS that language comes from the SYSTEM — so without this the only
  // way to read the extension in Japanese was to run the whole computer in it.
  // bento/slides has had a picker in its About dialog all along; this is the
  // same control, in the place a tray preference belongs.
  const lang = section(t('setLangTitle'), t('setLangSub'))
  const lrow = document.createElement('div')
  lrow.className = 'row'
  const sel = document.createElement('select')
  const auto = document.createElement('option')
  auto.value = ''
  auto.textContent = t('langAutomatic')
  sel.appendChild(auto)
  // Sorted by what each language calls ITSELF, in that language's own
  // collation — the order an English speaker would impose is not the order the
  // reader is scanning in.
  for (const code of [...LOCALES].sort((a, b) => localeLabel(a).localeCompare(localeLabel(b)))) {
    const o = document.createElement('option')
    o.value = code
    o.textContent = localeLabel(code)
    sel.appendChild(o)
  }
  sel.value = localeOverride() ?? ''
  sel.addEventListener('change', async () => {
    await setLocale(sel.value || null)
    // Everything on screen is now in the wrong language, including the static
    // markup filled at load, so both are redone rather than just this view.
    localize()
    show('settings')
  })
  lrow.appendChild(sel)
  const lnote = document.createElement('span')
  lnote.className = 'note'
  lnote.textContent = t('setLangNote')
  lrow.appendChild(lnote)
  lang.appendChild(lrow)

  // --- the permission nothing can request
  const access = section(t('setAccessTitle'), t('setAccessSub'))
  const row = document.createElement('div')
  row.className = 'row'
  const ok = s.files === true
  row.innerHTML = `<span class="dot ${ok ? 'ok' : s.files === false ? 'bad' : 'meh'}"></span>`
    + `<b>${ok ? t('stateOn') : s.files === false ? t('stateOff') : t('stateUnknown')}</b>`
    + `<span class="note">${ok
      ? t('accessOnNote')
      : s.files === false ? t('accessOffNote') : t('accessUnknownNote')}</span>`
  access.appendChild(row)

  // --- version, and whether this copy can update itself
  const mine = chrome.runtime.getManifest().version
  const selfManaged = await isSelfManaged()
  const upd = await pendingUpdate()
  const ver = section(t('setVersionTitle'),
    selfManaged ? t('setVersionUnpacked') : t('setVersionStore'))
  const vrow = document.createElement('div')
  vrow.className = 'row'
  vrow.innerHTML = `<span class="dot ${upd?.version ? 'meh' : 'ok'}"></span><b>${esc(mine)}</b>`
    + `<span class="note">${upd?.version
      ? t('versionAvailable', esc(upd.version))
      : selfManaged ? t('versionUpToDate') : t('versionManaged')}</span>`
  if (upd?.version) {
    const link = document.createElement('a')
    link.className = 'btn'
    link.href = upd.url
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = t('getIt')
    vrow.appendChild(link)
  }
  if (selfManaged) {
    const now = document.createElement('button')
    now.className = 'btn'
    now.textContent = t('checkNow')
    // `force`: pressing a button IS consent, whatever the preference says.
    now.onclick = () => act(async () => { await checkForUpdate({ force: true }) })
    vrow.appendChild(now)
  }
  ver.appendChild(vrow)

  // The switch for the one outbound request this extension makes.
  //
  // THIS WAS CLAIMED AND NOT DELIVERED. The commit that argued for "on by
  // default, switchable, disclosed" shipped the preference in update.js, the
  // rig that covers it, and no way for anyone to change it — a script's anchor
  // text did not match, `String.replace` no-opped, and nothing asserted. The
  // argument for the default rests entirely on this control existing.
  if (selfManaged) {
    const on = await autoCheckEnabled()
    const pref = document.createElement('label')
    pref.className = 'row'
    pref.style.cursor = 'pointer'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = on
    box.onchange = () => act(async () => { await setAutoCheck(box.checked) })
    const txt = document.createElement('span')
    txt.className = 'note'
    txt.innerHTML = t('autoCheckPref')
    pref.append(box, txt)
    ver.appendChild(pref)
  }
  // The package is byte-reproducible, so a published digest is checkable by the
  // person doing the install — which is the only verification available when
  // the browser is not doing the updating.
  if (upd?.sha256) {
    const sum = document.createElement('p')
    sum.className = 'sub'
    sum.style.marginTop = '8px'
    sum.innerHTML = t('expectedSha', `<code>${esc(upd.sha256)}</code>`)
    ver.appendChild(sum)
  }

  // --- what the extension will never do
  const about = section(t('setReachTitle'), t('setReachSub'))
  void about

  const scroll = document.querySelector('.scroll')
  scroll.innerHTML = ''
  scroll.appendChild(wrap)
}

/** Run a settings action, then redraw both the settings view and the library —
 *  adding or removing a folder changes what documents exist. */
async function act(fn) {
  try {
    await fn()
    await load()
    await renderSettings()
    await renderNotice()
  } catch (e) {
    if (e?.name !== 'AbortError') toast(e.message)
  }
}

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

// A fresh install is sent here by the worker (`#welcome`), because the first
// question is "what did I just install and what does it want" — and a grid of
// documents it cannot see yet answers none of it.
// Before ANY painting: a saved language choice has to be in hand, or the page
// renders in the browser's language and visibly re-renders a moment later.
await initI18n()
localize()

// Read BEFORE the first grid render, so someone who chose list mode never
// watches it boot into icons and reflow a frame later.
try {
  const saved = await get(GRANT, 'layout')
  if (LAYOUTS.includes(saved)) state.layout = saved
} catch { /* the default is a perfectly good answer */ }
paintLayout()

// Which screen the window was ASKED for. `#welcome` is the worker's post-install
// landing; `#settings` is what `options_page` points at, because Chrome's
// "Options" entry means "configure this extension" and answering it with a grid
// of documents ignores the question. Applied twice on purpose — once before the
// documents load so the right screen paints immediately, once after, because
// `load()` finishes by showing the grid.
const routeHash = () => {
  const view = { '#welcome': 'help', '#help': 'help', '#settings': 'settings' }[location.hash]
  if (view) show(view)
  return !!view
}

routeHash()

await load()
await renderNotice()
routeHash()

// A hash change while the page is already open (Chrome reuses an existing
// options tab rather than opening a second one) must still move the view.
addEventListener('hashchange', routeHash)
