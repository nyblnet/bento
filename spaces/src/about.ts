// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The About surface: what this file is, what is in it, updating it, its
// language, its password, and the ways in and out of it.
//
// PLATFORM §10 requires a signed self-update path, an encryption story and an
// AI round-trip. All three live behind one button, because a self-contained
// document has nowhere else to put them.
//
// BUILT FROM SLIDES' DIALOG, deliberately. Two apps in one suite must not
// teach two different dialogs: same opening mark, same section order (what
// this is → what is in it → updates → viewer preferences → the document →
// the ways out), same register, same restraint. What differs is only what the
// app IS — a space is measured in pages, blocks and words where a deck is
// measured in slides.
//
// TWO LAYOUT RULES THIS DIALOG LIVES UNDER (CLAUDE.md, hard-won #9 and #10):
//   · The card SCROLLS (`overflow: auto`), and `overflow-y: auto` clips
//     HORIZONTALLY too — there is no such thing as scrolling one axis while
//     the other overflows visibly. So nothing in here may be a floating
//     popover: everything that opens (the update card, the replace-from-JSON
//     panel, every confirmation) opens IN FLOW as a block of the list, and the
//     card scrolls to it. A 250px popover anchored inside a scrolling menu is
//     the bug that cost this project a day in slides' phone chrome.
//   · `.sp-overlay` carries z-index 60, which is a CEILING on every descendant
//     rather than merely an order. Nothing in this dialog tries to escape it,
//     and nothing added later can be made to by raising its own z-index.

import {
  checkForUpdates, applyUpdate, applyUpdateInPlace, canUpdateInPlace,
  autoCheckEnabled, setAutoCheck, compareVersions,
  APP_VERSION, type ReleaseInfo, type UpdateCheck,
} from '../../kernel/src/update.ts'
import {
  setEncryptionPassword, isEncryptionActive,
  canWriteInPlace, openedFileName,
} from '../../kernel/src/save.ts'
import { clearVersions, clearRecovery, listVersions, type Snapshot } from '../../kernel/src/autosave.ts'
import { t, localeChoices, locale, setLocale } from './i18n'
import { appearanceSection } from './appearance'
import { esc, textOf } from './sanitize'
import { docForExport } from './model'
import { htmlToMd } from './marks.ts'
import { humanBytes } from './assets'
import { SPEC, mdLayout, type MdCtx } from './blocks'
import { parseDoc, uid } from './model'
import {
  issuesOf, passesFilter, sortRows, fieldByKey, optionOf, fieldsOf,
} from './fields'
import type { Store } from './store'
import type { Block, SpacesDoc } from './model'

export interface AboutHooks {
  store: Store
  onRepaint: () => void
  /**
   * "Save a copy…", supplied by the caller.
   *
   * NOT saveFile(doc, true) here. That path assigns the picked handle to the
   * kernel's in-place handle, so every later ⌘S writes to the copy — the bug
   * fixed in the topbar's copy button, which this second button then kept
   * alive because the guard only read main.ts. One implementation, two
   * buttons, and the assertion now reads every file.
   */
  onSaveCopy: () => void
  /** open the importer — the way IN, opposite the ways out below */
  onImport?: () => void
  /** take ONE page out as a space of its own */
  onExportSpace?: () => void
  /**
   * Write a DIFFERENT document out as its own file, leaving this one open.
   * The same writer the page extract uses (keepHandle false), so a duplicate
   * never becomes the ⌘S target.
   */
  onWriteCopy?: (doc: SpacesDoc) => Promise<boolean>
  /** the editor's status line, for the confirmations that outlive the dialog */
  onStatus?: (message: string) => void
}

/**
 * The launch check's result, for the line the dialog opens on.
 *
 * Module-level and not in the doc: whether this READER checked for updates is
 * no business of the document, exactly as the locale is not.
 */
let lastAutoCheck: UpdateCheck | null = null

/**
 * Check at launch, if the reader left that on.
 *
 * The preference (`bento-auto-check`, kernel/src/update.ts) is the one slides
 * uses, so a person who turned it off in one app has turned it off in both.
 * Nothing about the reader or the document goes out with the request — it is a
 * plain GET of a signed manifest — and the dialog says so where the switch is.
 */
export async function launchUpdateCheck(): Promise<void> {
  if (!autoCheckEnabled()) return
  lastAutoCheck = await checkForUpdates()
}

export function openAbout(hooks: AboutHooks): void {
  const { store, onRepaint, onSaveCopy, onImport, onExportSpace, onWriteCopy, onStatus } = hooks
  const doc = store.doc
  const returnFocus = document.activeElement as HTMLElement | null

  const back = document.createElement('div')
  back.className = 'sp-overlay sp-overlay-about'
  const card = document.createElement('div')
  card.className = 'sp-card sp-about'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-label', t('About this space'))

  const close = () => {
    back.remove()
    document.removeEventListener('keydown', onKey, true)
    returnFocus?.focus?.()
  }
  // Capture-phase and on the DOCUMENT, as slides does: a dialog whose Escape
  // handler hangs off its own element stops working the moment focus leaves it
  // — which a <select> dropdown does on every platform.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close() }
  }

  // ---- small builders ----------------------------------------------------
  const h = (text: string) => {
    const n = document.createElement('h2')
    n.className = 'sp-card-h'
    n.textContent = text
    return n
  }
  /** A section with a real heading, not one more control in a flat stack. */
  const section = (title: string, ...kids: Array<Node | null>) => {
    const s = document.createElement('section')
    s.className = 'sp-ab-sec'
    s.append(h(title))
    for (const k of kids) if (k) s.append(k)
    card.append(s)
    return s
  }
  const note = (text: string, cls = '') => {
    const p = document.createElement('p')
    p.className = 'sp-note' + (cls ? ' ' + cls : '')
    p.textContent = text
    return p
  }
  const row = (label: string, node: HTMLElement) => {
    const r = document.createElement('div')
    r.className = 'sp-row'
    const s = document.createElement('span')
    s.textContent = label
    r.append(s, node)
    return r
  }
  const button = (label: string, fn: () => void, primary = false) => {
    const b = document.createElement('button')
    b.className = 'sp-btn' + (primary ? ' sp-primary' : '')
    b.textContent = label
    b.addEventListener('click', fn)
    return b
  }
  const actions = (...kids: HTMLElement[]) => {
    const d = document.createElement('div')
    d.className = 'sp-actions'
    d.append(...kids)
    return d
  }
  const mono = (s: string) => {
    const n = document.createElement('span')
    n.className = 'sp-mono'
    n.textContent = s
    return n
  }
  const check = (label: string, on: boolean, fn: (v: boolean) => void) => {
    const l = document.createElement('label')
    l.className = 'sp-ab-check'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = on
    cb.addEventListener('change', () => fn(cb.checked))
    l.append(cb, document.createTextNode(' ' + label))
    return l
  }
  const say = (message: string) => { onStatus?.(message) }

  // ---- what this is ------------------------------------------------------
  // The same head slides uses: the suite's mark, the app, the version, and a
  // gentle route back to the site. A dialog that opens with a section heading
  // does not tell you what you are looking at.
  const head = document.createElement('div')
  head.className = 'sp-about-head'
  head.innerHTML =
    '<a class="sp-about-logo" href="https://bento.page" target="_blank" rel="noopener">' +
    '<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">' +
    '<rect width="32" height="32" rx="7" fill="#16273E"/>' +
    '<rect x="5" y="5" width="7" height="22" rx="2.5" fill="#5E7699"/>' +
    '<rect x="14" y="5" width="13" height="10" rx="2.5" fill="#FF9E8A"/>' +
    '<rect x="14" y="17" width="13" height="10" rx="2.5" fill="#F0EBE0"/>' +
    '</svg><div><b>bento<span style="color:#FF9E8A">/</span>spaces</b>' +
    `<span>v${esc(APP_VERSION)} · ${esc(t('format v{v}', { v: String(doc.version ?? 1) }))}</span></div></a>`
  head.querySelector('a')?.setAttribute('title', t('Visit bento.page (opens in a new tab)'))
  card.append(head)

  const promo = document.createElement('p')
  promo.className = 'sp-ab-promo'
  // The one innerHTML with markup in it, and the markup is OURS: two anchors
  // built here and interpolated into a translated sentence. Nothing from the
  // document, the network or a catalog's placeholder value reaches it.
  promo.innerHTML = t(
    'New to Bento? Find templates, the gallery and the AI editing guide at {home} — or ⭐ it on {gh}.',
    {
      home: '<a href="https://bento.page" target="_blank" rel="noopener">bento.page</a>',
      gh: '<a href="https://github.com/nyblnet/bento" target="_blank" rel="noopener">GitHub</a>',
    },
  )
  card.append(promo)

  // ---- what is in it -----------------------------------------------------
  // The numbers a person actually wants, and then the one that explains the
  // others: where the weight is. A space is big because of its images, always,
  // and a readout that says "4.2 MB" without saying that has told you nothing
  // you can act on.
  const pages = doc.pages.length
  const blocks = doc.pages.reduce((n, p) => n + p.blocks.length, 0)
  let words = 0
  for (const p of doc.pages) {
    words += countWords(p.title)
    for (const b of p.blocks) words += countWords(textOf(b.html))
  }
  const assetBytes = Object.values(doc.assets ?? {}).reduce((n, v) => n + v.length, 0)
  const assetCount = Object.keys(doc.assets ?? {}).length
  const docBytes = byteLength(doc)

  const stats = document.createElement('div')
  stats.className = 'sp-ab-stats'
  for (const [value, label] of [
    [String(pages), t('Pages')],
    [String(blocks), t('Blocks')],
    [String(words), t('Words')],
    [humanBytes(docBytes), t('Document')],
  ] as Array<[string, string]>) {
    const s = document.createElement('div')
    s.className = 'sp-ab-stat'
    const b = document.createElement('b')
    b.textContent = value
    const l = document.createElement('span')
    l.textContent = label
    s.append(b, l)
    stats.append(s)
  }

  const weight = note(
    assetCount
      ? t('{n} embedded image(s) and clip(s) account for {size} of that — {pct}%. Everything else is text.', {
        n: assetCount, size: humanBytes(assetBytes),
        pct: docBytes ? Math.round((assetBytes / docBytes) * 100) : 0,
      })
      : t('All text. Nothing is embedded, so this file is as small as a space gets.'),
  )
  const fileName = openedFileName()
  const sec1 = section(t('This file'), stats, weight)
  if (fileName) sec1.append(row(t('File'), mono(fileName)))
  sec1.append(note(t('The document, the editor and the search are all in this one file. Opening it needs nothing else — no server, no account, no install.')))
  if (!canWriteInPlace()) {
    // stated up front rather than discovered on the first save
    sec1.append(note(t('This browser cannot write back to the file, so every save makes a new copy. Chrome and Edge on a computer can save in place.')))
  }

  // ---- the document itself ------------------------------------------------
  // Its name is the one property of a space anybody edits here; the rest are
  // facts about it, shown because a file you cannot identify is a file you
  // cannot support.
  const titleIn = document.createElement('input')
  titleIn.type = 'text'
  titleIn.className = 'sp-input'
  titleIn.value = doc.title
  titleIn.disabled = store.readOnly
  titleIn.addEventListener('change', () => {
    const next = titleIn.value.trim() || 'Untitled'
    titleIn.value = next
    store.runEdit('__title', () => { store.doc.title = next })
    onRepaint()
  })
  const props = section(t('Document properties'))
  const titleRow = document.createElement('div')
  titleRow.className = 'sp-ab-field'
  const titleLbl = document.createElement('label')
  titleLbl.textContent = t('Title')
  titleRow.append(titleLbl, titleIn)
  props.append(titleRow)
  props.append(row(t('Document id'), mono(doc.docId)))
  if (doc.modified) props.append(row(t('Last saved'), mono(shortStamp(doc.modified))))

  // ---- updates -----------------------------------------------------------
  const upSec = section(t('Updates'))
  const upStatus = document.createElement('div')
  upStatus.className = 'sp-ab-status'
  const upLine = document.createElement('p')
  upLine.className = 'sp-note'
  upStatus.append(upLine)
  upLine.textContent =
    lastAutoCheck?.status === 'current'
      ? t("Checked automatically at launch — you're on the latest version (v{v}).", { v: APP_VERSION })
      : lastAutoCheck?.status === 'error'
        ? t("Launch check couldn't reach the release server ({m}). Check manually below.", { m: lastAutoCheck.message })
        : t('This file carries its own app — it works offline, forever, as is.')

  const checkBtn = button(t('Check for updates'), () => { void runCheck() })
  upSec.append(actions(checkBtn), upStatus)
  upSec.append(check(t('Check for updates automatically at launch'), autoCheckEnabled(), (on) => setAutoCheck(on)))
  upSec.append(note(t('An update check is the only network this app makes on its own. It asks the release server for a signed manifest and sends nothing about you or this document — no ids, no telemetry.')))

  async function runCheck(): Promise<void> {
    checkBtn.disabled = true
    upStatus.textContent = ''
    upStatus.append(upLine)
    upLine.textContent = t('Checking…')
    const res = await checkForUpdates()
    lastAutoCheck = res
    checkBtn.disabled = false
    if (res.status === 'current') {
      upLine.textContent = t('You have the newest version ({v}).', { v: APP_VERSION })
      return
    }
    if (res.status === 'error') {
      upLine.textContent = t('Could not reach the update channel.')
      return
    }
    upLine.textContent = ''
    upStatus.append(updateCard(res.release))
  }

  /**
   * One card for the one moment in this dialog with a decision in it.
   *
   * Grouped rather than left as five loose children of the status block — the
   * layout lesson slides paid for, where a heading, the notes and three
   * buttons squeezed between the section above and the controls below and a
   * five-bullet changelog read as one line plus two scrollbars.
   */
  function updateCard(rel: ReleaseInfo): HTMLElement {
    const box = document.createElement('div')
    box.className = 'sp-ab-update'
    const line = document.createElement('div')
    line.className = 'sp-ab-new'
    line.textContent = t('Version {v} is available.', { v: rel.version })
    box.append(line)

    // Per-version notes filtered to what THIS file actually skipped: a reader
    // two versions behind should see both, and one version behind should not
    // see the older one again. `notes` is the fallback for a manifest that
    // predates the field.
    const skipped = rel.notesFrom
      ? Object.keys(rel.notesFrom)
        .filter((v) => compareVersions(v, APP_VERSION) > 0)
        .sort((a, b) => compareVersions(b, a))
      : []
    if (skipped.length) {
      const lines = skipped.flatMap((v) =>
        (rel.notesFrom![v] ?? []).map((n) => (skipped.length > 1 ? `• ${n}  (${v})` : `• ${n}`)))
      box.append(releaseNotes(lines.join('\n')))
    } else if (rel.notes) {
      box.append(releaseNotes(rel.notes))
    }

    const link = document.createElement('a')
    link.className = 'sp-btn sp-ab-link'
    link.href = `https://github.com/nyblnet/bento/releases/tag/v${encodeURIComponent(rel.version)}`
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = t('What’s new →')
    link.title = t('Read the release notes for v{v} (opens in a new tab)', { v: rel.version })

    const inPlace = button(canUpdateInPlace() ? t('Update this file') : t('Update this file…'), () => {
      void (async () => {
        inPlace.disabled = true
        inPlace.textContent = t('Verifying…')
        try {
          const written = await applyUpdateInPlace(rel, store.doc)
          if (written) {
            box.replaceChildren(updatedCard(rel, written.backup))
          } else {
            inPlace.disabled = false
            inPlace.textContent = t('Update this file…')
          }
        } catch (err) {
          inPlace.disabled = false
          inPlace.textContent = t('Update this file…')
          upLine.textContent = t('Update failed: {m}', { m: String((err as Error)?.message ?? err) })
        }
      })()
    }, true)
    inPlace.title = canUpdateInPlace()
      ? t('Downloads a backup of the current version, then rewrites this file on disk as the new version — document untouched.')
      : t('Verifies and builds the new version with this document inside, then asks where to save it — pick the file you have open to update it.')

    const get = button(t('Download updated copy'), () => {
      void (async () => {
        get.disabled = true
        get.textContent = t('Verifying…')
        try {
          // the update writes a NEW file and leaves this one untouched, so a
          // bad update is undone by deleting the download
          await applyUpdate(rel, store.doc)
          get.textContent = t('Downloaded ✓')
          box.append(note(t('This window keeps running v{v} until you open the downloaded file.', { v: APP_VERSION })))
        } catch (err) {
          get.disabled = false
          get.textContent = t('Download updated copy')
          upLine.textContent = t('Update failed: {m}', { m: String((err as Error)?.message ?? err) })
        }
      })()
    })

    box.append(actions(link, inPlace, get))
    return box
  }

  function updatedCard(rel: ReleaseInfo, backup: 'beside' | 'downloaded' | 'none'): HTMLElement {
    const done = document.createElement('div')
    done.className = 'sp-ab-update'
    const ok = document.createElement('div')
    ok.className = 'sp-ab-new'
    ok.textContent = t('Updated to v{v} on disk.', { v: rel.version })
    done.append(ok)
    // Say where the rollback went. A backup nobody can find is not a backup.
    done.append(note(
      backup === 'beside'
        ? t('This window is still running v{v} — reload to finish. A v{v} backup was saved beside this file.', { v: APP_VERSION })
        : backup === 'downloaded'
          ? t('This window is still running v{v} — reload to finish. A v{v} backup was downloaded.', { v: APP_VERSION })
          : t("This window is still running v{v}. If you overwrote the file that's open here, reload; otherwise open the file you saved.", { v: APP_VERSION }),
    ))
    done.append(actions(button(t('Reload into new version'), () => {
      store.dirty = false // disk already holds this exact document
      location.reload()
    }, true)))
    return done
  }

  // ---- appearance --------------------------------------------------------
  // Beside Language, because they are the same kind of thing: preferences that
  // belong to whoever opened the file, not to the file.
  card.append(...appearanceSection())

  // ---- language ----------------------------------------------------------
  const sel = document.createElement('select')
  sel.className = 'sp-select'
  for (const c of localeChoices()) {
    const o = document.createElement('option')
    o.value = c.code
    o.textContent = c.label
    if (c.code === locale()) o.selected = true
    sel.append(o)
  }
  sel.addEventListener('change', () => {
    setLocale(sel.value)
    close()
    onRepaint()
  })
  section(
    t('Language'),
    row(t('Interface language'), sel),
    // the same rule as slides: language follows the READER, never the document
    note(t('Language follows whoever opens the file. It is never written into the document.')),
  )

  // ---- password ----------------------------------------------------------
  const pwSec = section(t('Password'))
  const pwNote = note(isEncryptionActive()
    ? t('This space is encrypted. Saves stay encrypted.')
    : t('A password encrypts the document inside the file. There is no recovery — lose it and the space is gone.'))
  pwSec.append(pwNote)

  const setPw = async (): Promise<void> => {
    const pw = prompt(t('Choose a password. There is no way to recover it.'))
    if (!pw) return
    setEncryptionPassword(pw)
    // Plaintext snapshots written BEFORE encryption was turned on would defeat
    // the encryption the author just enabled. Both stores: the version timeline
    // and the single recovery snapshot. From here on main.ts writes neither.
    await clearVersions(doc.docId)
    await clearRecovery(doc.docId)
    pwNote.textContent = t('Password set. Save to write the space encrypted.')
    say(t('Password set. Save to write the space encrypted.'))
  }

  const pwActions = actions()
  if (isEncryptionActive()) {
    pwActions.append(button(t('Change password…'), () => { void setPw() }))
    pwActions.append(danger(t('Remove password…'), pwSec, {
      what: t('Remove the password?'),
      why: t('The next save writes this space as plain, readable JSON — anybody who opens the file can read every page.'),
      go: t('Remove the password'),
      run: () => {
        setEncryptionPassword(null)
        pwNote.textContent = t('Password removed. Save to write the space unencrypted.')
        say(t('Password removed. Save to write the space unencrypted.'))
      },
    }))
  } else {
    pwActions.append(button(t('Set a password…'), () => { void setPw() }))
  }
  pwSec.append(pwActions)

  // ---- the way in ---------------------------------------------------------
  // Beside the ways out on purpose: a format that can only be left is a
  // format nobody arrives in.
  if (onImport) {
    section(
      t('Bring notes in'),
      actions(button(t('Import Markdown…'), () => { close(); onImport() })),
      note(t('A folder of .md files becomes pages, with the folder tree and the [[wikilinks]] intact.')),
      // Said HERE because this is where somebody looks for it, and because the
      // same dialog claims below that a space is never a dead end. A promise
      // made in one direction only is half a promise.
      note(t('Another bento/spaces file can arrive the same way, nested under any page.')),
    )
  }

  // ---- ways out ----------------------------------------------------------
  // ---- the local timeline --------------------------------------------------
  //
  // Undo dies with the tab and the recovery snapshot only ever holds the last
  // few seconds, so before this section the honest answer to "give me back what
  // I wrote this morning" was that there wasn't one. The timeline lives in this
  // browser's IndexedDB — never in the file, never online — which is why the
  // note says so plainly: a space carried to another machine does not bring its
  // history, and that is a property worth stating rather than discovering.
  //
  // Rendered ASYNC into a placeholder. Reading IndexedDB cannot be allowed to
  // hold up the dialog opening, and a space with no versions yet is the common
  // case on a first run — it says so rather than showing an empty box.
  const histSec = section(t('History'))
  const histBody = document.createElement('div')
  histBody.className = 'sp-ab-versions'
  histSec.append(histBody)
  histSec.append(note(t('Versions are kept in this browser only — never in the file, never online. Restoring is undoable.')))

  const renderVersions = (versions: Snapshot[]): void => {
    histBody.textContent = ''
    if (!versions.length) {
      histBody.append(note(isEncryptionActive()
        ? t('This space is encrypted, so no versions are kept.')
        : t('No versions yet — they build up as you write and save.')))
      return
    }
    for (const [i, v] of versions.entries()) {
      const when = new Date(v.at).toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'sp-ab-version'
      const left = document.createElement('span')
      left.className = 'sp-ab-when'
      left.textContent = when
      const tag = document.createElement('span')
      tag.className = 'sp-ab-vtag'
      tag.textContent = i === 0 ? t('most recent') : ''
      const doIt = document.createElement('span')
      doIt.className = 'sp-ab-vdo'
      doIt.textContent = t('Restore')
      b.append(left, tag, doIt)
      b.addEventListener('click', () => {
        let restored: SpacesDoc
        try { restored = JSON.parse(v.json) as SpacesDoc } catch {
          say(t('That version could not be read')); return
        }
        // replaceDoc checkpoints undo first, so ⌘Z walks this back — the same
        // contract the recovery banner's Restore already honours.
        store.replaceDoc(restored)
        onRepaint()
        close()
        say(t('Restored the version from {when} — ⌘Z undoes it', { when }))
      })
      histBody.append(b)
    }
  }
  renderVersions([])
  void listVersions(doc.docId).then(renderVersions).catch(() => { /* no store, no history */ })

  const outSec = section(t('Take it elsewhere'))
  const copyJson = button(t('Copy document JSON'), () => {
    // The clipboard copy is a HAND-OUT. Every field under `collab` is a bearer
    // capability — the room, the read key and the private halves that grant
    // writing and revoking — so the copy strips the block outright, the way
    // the page extract does. It used to copy the live document whole.
    //
    // Through model.docForExport, not a local clone-and-delete: this landed on
    // main independently while this dialog was being rebuilt, and two strippers
    // for one rule is how the two of them start to disagree. The shared one
    // also strips by REMOVING, so a private field added to the credentials
    // later is covered without either call site being touched.
    navigator.clipboard?.writeText(JSON.stringify(docForExport(store.doc), null, 2))
      .then(() => { copyJson.textContent = t('Copied ✓'); say(t('Document JSON copied')) })
      .catch(() => { copyJson.textContent = t('Couldn’t access the clipboard') })
      .finally(() => { setTimeout(() => { copyJson.textContent = t('Copy document JSON') }, 1800) })
  })
  outSec.append(actions(
    copyJson,
    button(t('Export as Markdown'), () => downloadMarkdown(store)),
    ...(onExportSpace ? [button(t('Export page as a space…'), () => { close(); onExportSpace() })] : []),
    button(t('Save a copy…'), () => { close(); onSaveCopy() }),
    ...(onWriteCopy ? [button(t('Duplicate as a new space…'), () => {
      // A DUPLICATE, not a copy: a fresh docId and no collaboration
      // credentials, so it can never sync with the space it came from. You
      // keep editing this one — the writer holds no handle (portable.ts).
      const clone = JSON.parse(JSON.stringify(store.doc)) as SpacesDoc
      clone.docId = uid('doc')
      delete clone.collab
      clone.modified = new Date().toISOString()
      close()
      void onWriteCopy(clone)
    })] : []),
  ))
  outSec.append(note(t('A space is never a dead end: the whole document is plain JSON in this file, and every page exports as Markdown.')))

  // ---- the two that cannot be taken back -----------------------------------
  // Its own section, its own weight, and every action here says what it will
  // do before it does it. Replace-from-JSON is the one control in this dialog
  // that can lose a document.
  if (!store.readOnly) {
    const risky = section(t('Careful'))
    risky.classList.add('sp-ab-risky')
    risky.append(danger(t('Replace from JSON…'), risky, {
      what: t('Replace every page from pasted JSON?'),
      why: t('Everything in this space is replaced by what you paste. ⌘Z undoes it, but only while this window stays open.'),
      go: t('Replace'),
      form: replaceForm,
    }))
    risky.append(note(t('The counterpart of Copy document JSON: edit a space in another tool, then bring it back.')))
  }

  /**
   * The paste box, IN FLOW.
   *
   * Not a popover, and not a second overlay: the card scrolls, so a floating
   * child of it would be clipped on both axes (CLAUDE.md #10). It is a block
   * of the list that pushes the rest down, and the card scrolls to it.
   */
  function replaceForm(host: HTMLElement, dismiss: () => void): HTMLElement {
    const wrap = document.createElement('div')
    const ta = document.createElement('textarea')
    ta.className = 'sp-ab-json'
    ta.rows = 7
    ta.placeholder = t('Paste document JSON here…')
    const apply = button(t('Replace'), () => {
      const res = parseDoc(ta.value)
      if (!res.ok) {
        ta.classList.add('sp-ab-bad')
        apply.textContent = t('That is not a bento/spaces document')
        setTimeout(() => { apply.textContent = t('Replace') }, 2000)
        return
      }
      // The live session belongs to THIS document, not to the pasted text.
      // Content is imported; identity and capability are not — adopting the
      // pasted `collab` would either wipe the room credentials or silently
      // move this space into somebody else's room.
      const keep = store.doc.collab
      if (keep) res.doc.collab = keep
      else delete res.doc.collab
      store.replaceDoc(res.doc)
      onRepaint()
      close()
      say(t('Document replaced — ⌘Z undoes'))
    })
    apply.classList.add('sp-ab-go')
    wrap.append(ta, actions(apply, button(t('Cancel'), dismiss)))
    host.append(wrap)
    ta.focus()
    return wrap
  }

  /**
   * A weightier control: it states the consequence, then asks again.
   *
   * The confirmation is a BLOCK, not a `confirm()` and not a popover — see the
   * header. The button that finally does the thing is the second one you
   * press, and it is labelled with the verb rather than "OK".
   */
  function danger(
    label: string,
    host: HTMLElement,
    opts: {
      what: string
      why: string
      go?: string
      run?: () => void
      form?: (host: HTMLElement, dismiss: () => void) => HTMLElement
    },
  ): HTMLElement {
    let open: HTMLElement | null = null
    const b = button(label, () => {
      if (open) { open.remove(); open = null; b.setAttribute('aria-expanded', 'false'); return }
      const panel = document.createElement('div')
      panel.className = 'sp-ab-confirm'
      const what = document.createElement('strong')
      what.textContent = opts.what
      panel.append(what, note(opts.why))
      const dismiss = () => { panel.remove(); open = null; b.setAttribute('aria-expanded', 'false'); b.focus() }
      if (opts.form) opts.form(panel, dismiss)
      else {
        const go = button(opts.go ?? label, () => { opts.run?.(); dismiss() })
        go.classList.add('sp-ab-go')
        panel.append(actions(go, button(t('Cancel'), dismiss)))
      }
      host.append(panel)
      open = panel
      b.setAttribute('aria-expanded', 'true')
      panel.scrollIntoView({ block: 'nearest' })
    })
    b.classList.add('sp-ab-danger')
    b.setAttribute('aria-expanded', 'false')
    return b
  }

  // ---- fine print ---------------------------------------------------------
  const fine = document.createElement('p')
  fine.className = 'sp-ab-fine'
  fine.textContent = t('bento/spaces is MIT-licensed and carries no third-party runtime — the full notices travel in this file’s source.')
  card.append(fine)

  const foot = document.createElement('div')
  foot.className = 'sp-ab-foot'
  foot.append(button(t('Close'), close, true))
  card.append(foot)

  // ---- focus ---------------------------------------------------------------
  // Trapped, because this is a modal: Tab off either end wraps rather than
  // walking into an editor the reader cannot see.
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return
    const f = [...card.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea')]
      .filter((el) => el.offsetParent !== null)
    if (!f.length) return
    const first = f[0]
    const last = f[f.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  })

  back.append(card)
  back.addEventListener('mousedown', (e) => { if (e.target === back) close() })
  document.addEventListener('keydown', onKey, true)
  document.body.append(back)
  checkBtn.focus()
}

/**
 * Release notes → a real list.
 *
 * The manifest carries them as PLAIN TEXT, one "• " bullet per line, capped at
 * five plus an "…and N more" tail (scripts/release.mjs). A pre-wrap block gave
 * every wrapped bullet a flush-left second line, which at 375px is most of them
 * — so one item read as two and the box looked like a wall. Split per line and
 * hang the indent instead.
 *
 * Always textContent, never innerHTML: the manifest is signed, but a signature
 * says who wrote a string, not that it is safe to run.
 */
function releaseNotes(notes: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'sp-ab-release'
  for (const raw of notes.split('\n')) {
    const text = raw.trim()
    if (!text) continue
    const bullet = /^[•*-]\s+/.test(text)
    const item = document.createElement('div')
    item.className = bullet ? 'sp-ab-note' : 'sp-ab-more'
    item.textContent = bullet ? text.replace(/^[•*-]\s+/, '') : text
    box.append(item)
  }
  return box
}

/**
 * Words, in a way that is not wrong outside Europe.
 *
 * Splitting on whitespace counts a whole Japanese paragraph as one word. CJK
 * has no inter-word space, so its characters are counted individually — the
 * convention every word processor uses — and the rest splits on whitespace.
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g
function countWords(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK)?.length ?? 0
  const rest = text.replace(CJK, ' ').trim()
  return cjk + (rest ? rest.split(/\s+/).length : 0)
}

/** Real UTF-8 bytes of the document, not characters — MB is a promise. */
function byteLength(doc: SpacesDoc): number {
  const json = JSON.stringify(doc)
  try { return new Blob([json]).size } catch { return json.length }
}

/** A timestamp a person can read, in the reader's own locale. */
function shortStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try {
    return d.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })
  } catch { return d.toISOString().slice(0, 16).replace('T', ' ') }
}

/**
 * Every page as one Markdown file.
 *
 * The renderer already emits semantic tags, so the mapping is direct — which
 * is the payoff for having refused divs-with-classes in the first place.
 */
export function toMarkdown(store: Store): string {
  const out: string[] = []
  const ctx: MdCtx = {
    titleOf: (id) => store.index.page.get(id)?.title,
    // THE SAME converter every other block's text goes through, handed to the
    // one type whose text is not a single string. A table with its own inline
    // rules would be the second place `**bold**` is decided.
    inline: htmlToMd,
    // DERIVED THE SAME WAY THE SCREEN DERIVES IT — same filter, same sort, same
    // grouping — so the file you download is the board you were looking at. A
    // second traversal here is how an export starts quietly disagreeing with
    // the app.
    rowsOf: (b: Block) => {
      const doc = store.doc
      const groupKey = String((b as { groupBy?: unknown }).groupBy ?? 'status')
      const grouped = String((b as { layout?: unknown }).layout ?? 'board') !== 'list'
      const field = fieldByKey(doc, groupKey)
      const rows = sortRows(
        doc,
        issuesOf(doc).filter((r) => passesFilter(doc, r.values, (b as { filter?: unknown }).filter)),
        (b as { sort?: unknown }).sort)
      // the board's column order, so an export reads top-to-bottom the way the
      // board reads left-to-right
      const order = new Map((field?.options ?? []).map((o, i) => [o.id, i]))
      const seat = (r: (typeof rows)[number]) =>
        order.get(String(r.values.get(groupKey) ?? '')) ?? Number.MAX_SAFE_INTEGER
      const ordered = grouped
        ? rows.map((r, i) => ({ r, i })).sort((a, c) => (seat(a.r) - seat(c.r)) || (a.i - c.i)).map((x) => x.r)
        : rows
      return ordered.map((r) => ({
        id: r.page.id,
        title: r.page.title,
        group: grouped
          ? (optionOf(field, r.values.get(groupKey))?.label ?? t('Other'))
          : undefined,
        // the same chips the card shows, in the same words
        fields: fieldsOf(doc)
          .filter((f) => f.key !== groupKey)
          .map((f) => {
            const v = r.values.get(f.key)
            if (v === undefined || v === null || v === '') return ''
            return optionOf(f, v)?.label ?? (Array.isArray(v) ? v.join(', ') : String(v))
          })
          .filter(Boolean).join(' · '),
      }))
    },
  }
  // ONE traversal, store.tree() — not a second walk over index.children.
  // That second walk is how a page-tree CYCLE dropped pages out of the export
  // while they sat in the file: neither page is reachable from the root, so
  // neither was ever visited. Store.tree() carries the visited set and surfaces
  // what a cycle orphans, and this now inherits both. Measured before the fix:
  // 13 pages in the file, 11 in the export.
  const walk = () => {
    for (const { page, depth } of store.tree()) {
      out.push(`${'#'.repeat(Math.min(depth + 1, 6))} ${page.title}`, '')
      // Indent, blockquote markers and what separates one block from the next
      // are properties of the TREE, not of a block, so they come from the
      // registry in one pass (blocks.ts mdLayout).
      const layout = mdLayout(page.blocks)
      page.blocks.forEach((b, i) => {
        const { quote, indent, sep } = layout[i]
        const text = htmlToMd(b.html ?? '')
        // From the block registry, so a new type exports correctly the moment
        // it is declared. An UNKNOWN type — a file written by a newer build —
        // falls through to its text, which is the honest default.
        const spec = SPEC.get(b.type)
        const lines = spec?.toMd ? spec.toMd(b, text, indent, ctx) : [text]
        // PER LINE, not per returned element. A spec returns ELEMENTS, and an
        // element can hold newlines: a code block's body is one multi-line
        // string, and htmlToMd turns <br> into a newline in ordinary text. Any
        // such child inside a callout left its 2nd..nth lines unquoted, which
        // ENDS the blockquote — the GitHub alert stops there, a nested fence is
        // left unterminated, and the rest of the callout falls out of the box
        // as broken prose. The callout's own toMd split on \n; nothing else did.
        //
        // An empty line inside a quote must be a bare '>', never '> ' and never
        // blank: a blank line closes the blockquote.
        out.push(...lines.flatMap((l) => l.split('\n')).map((l) => (l ? quote + l : quote.trimEnd())))
        out.push(sep)
      })
    }
  }
  walk()
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * Inline html → inline markdown.
 *
 * Lives in marks.ts now, with the mark table it has to agree with. It used to
 * be a DOM walk here, which meant it could not be tested — the rigs are plain
 * node — so "does every mark survive an export" was a question only a human
 * with a browser could answer. Four of them did not: `u`, `mark`, `sub` and
 * `sup` fell through to their text. It is a pure function over the same run
 * list the canonicaliser uses, so a mark the model can hold and the exporter
 * cannot spell is now a rig failure.
 */

export function downloadMarkdown(store: Store): void {
  const blob = new Blob([toMarkdown(store)], { type: 'text/markdown' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${(store.doc.title || 'space').replace(/[^\w.-]+/g, '-')}.md`
  a.click()
  URL.revokeObjectURL(a.href)
}
