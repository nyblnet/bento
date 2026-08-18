// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The About surface: what this file is, who wrote it, how it updates, what
// language it speaks, and every way back out of it.
//
// A self-contained document has nowhere else to put any of this. PLATFORM §6
// (signed update), §7 (the JSON round-trip), §8 (viewer-scoped language) and
// §3 (identity, and the one sanctioned way to change it) all need a surface,
// and one dialog behind the wordmark is the whole of it.
//
// TWO THINGS HERE ARE NOT COSMETIC and are the reason this is a module rather
// than a slab of markup in main.ts:
//
//   · REPLACING THE WORKBOOK CAN CRASH THE GRID. `Grid.sheet` throws when the
//     sheet id it holds is not in the document, and it reads it from a `doc`
//     listener registered before every other one — so a workbook arriving with
//     different sheet ids takes down the dirty flag and the chart with it.
//     `planReplace` below is the fix.
//   · THE DIALOG SITS INSIDE TWO DOCUMENT-LEVEL HANDLERS. main.ts routes bare
//     keystrokes into the grid and sniffs every paste for CSV; both would fire
//     while someone is typing an author name or pasting JSON in here.

import './about.css'
import {
  APP_VERSION, applyUpdate, applyUpdateInPlace, canUpdateInPlace, checkForUpdates,
  offlineEnabled, type ReleaseInfo,
} from '../../kernel/src/update.ts'
import {
  canWriteInPlace, isEncryptionActive, openedFileName, saveFile, setEncryptionPassword,
} from '../../kernel/src/save.ts'
import {
  addVersion, clearRecovery, clearVersions, listVersions,
} from '../../kernel/src/autosave.ts'
import { t, locale, localeChoices, setLocale } from './i18n.ts'
import { docBudget, docBytes, parseDoc, rowCount, type DashDoc, type DocMeta } from './model.ts'
import type { Store } from './store.ts'

export interface AboutHooks {
  store: Store
  /** The sheet the grid is showing. Not derivable here — the grid owns it. */
  showingSheet: () => string
  /** Point the grid at another sheet (and repaint it). */
  showSheet: (id: string) => void
  /**
   * The document changed outside `Store.commit`. Document properties are
   * written straight onto `doc.meta` (see setMeta), so nothing emits `doc` for
   * them and the dirty flag would never light — which means "close the tab and
   * lose it" for a field the author just typed.
   */
  onDirty: () => void
}

// --- pure decisions, testable without a DOM ---------------------------------

/** What a workbook swap has to do to survive the grid. */
export interface ReplacePlan {
  /** the sheet the grid must be showing afterwards */
  show: string
  /**
   * Carry the sheet the grid is CURRENTLY showing through an intermediate
   * document. `Store.replaceDoc` emits `doc` synchronously and the grid's
   * listener — first in line, registered in its constructor — immediately
   * reads `grid.sheet`, which THROWS when the incoming workbook has no sheet
   * with that id. The throw escapes mid-emit, so every listener registered
   * after the grid (the chart, the 3D panel, the dirty flag) never runs, and
   * the workbook is left swapped with the app half-updated.
   *
   * There is no way to point the grid somewhere safe first: `setSheet` paints
   * immediately, and the destination does not exist in the outgoing document.
   * So the swap goes through a document containing BOTH — the new sheets plus
   * the one being left — which is a valid workbook that neither the grid nor
   * anything else can trip over, and is replaced again before it can be saved.
   */
  carry: boolean
}

/**
 * Decide how to swap in `next` while the grid is showing `showing`.
 * Null means the incoming document has no table sheet — nothing to show, so
 * the swap is refused rather than performed into an empty screen.
 */
export function planReplace(next: DashDoc, showing: string): ReplacePlan | null {
  const tables = next.sheets.filter((s) => s.kind === 'table')
  if (!tables.length) return null
  // Keeping the reader where they were matters more than it looks: the common
  // case is an agent handing back the SAME workbook edited, which keeps every
  // sheet id, and jumping to sheet one on every round trip would be a tell
  // that something was rebuilt underneath.
  if (tables.some((s) => s.id === showing)) return { show: showing, carry: false }
  return { show: tables[0].id, carry: true }
}

const newDocId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/**
 * A fork: same content, new identity (PLATFORM §3 — the ONLY sanctioned way a
 * docId changes).
 *
 * The docId keys autosave recovery and the local version timeline, so a
 * duplicate that kept it would inherit the original's history and overwrite
 * its recovery snapshot — two files racing to restore each other's work.
 */
export function duplicateWorkbook(doc: DashDoc, docId: string = newDocId()): DashDoc {
  const clone = JSON.parse(JSON.stringify(doc)) as DashDoc
  clone.docId = docId
  // The FILE is the capability (PLATFORM §5): a copy carrying `collab` joins
  // the original's session and writes into it. dash mints no credentials yet,
  // but the field is in the model and a hand-written or imported workbook can
  // arrive with one — dropping it now costs nothing and cannot be retrofitted
  // into copies already made.
  delete clone.collab
  // `template: true` means "every open starts a fresh document". A duplicate is
  // a document, not a template.
  delete clone.template
  return clone
}

export interface WorkbookStats {
  sheets: number
  tables: number
  rows: number
  columns: number
  bytes: number
}

export function workbookStats(doc: DashDoc): WorkbookStats {
  let tables = 0
  let columns = 0
  for (const s of doc.sheets) {
    if (s.kind !== 'table') continue
    tables++
    columns += s.columns.length
  }
  return { sheets: doc.sheets.length, tables, rows: rowCount(doc), columns, bytes: docBytes(doc) }
}

// --- theme: a VIEWER preference, never the document's --------------------------
//
// The same shape as story.ts's reduced-motion switch and the interface
// language: this is ONE PERSON's preference about their own screen, so it
// lives in localStorage and never enters the format (PLATFORM §8). Two people
// opening the same workbook may sit in different themes exactly as they may
// read it in different languages, and a file that carried a theme would be a
// file that changed everyone's screen because of what one author preferred.
//
// `doc.theme` in model.ts is a DIFFERENT thing and must not be confused with
// this: that is the document's own palette, it travels in the file, and it
// colours the charts and the static preview. Nothing here reads or writes it.
//
// THE MECHANISM IS A TRANSIENT <style>, AND IT HAD TO BE. The obvious
// implementation — `data-theme` on <html>, matched by `:root[data-theme=…]` in
// styles.css — QUIETLY WRITES THE PREFERENCE INTO EVERY SAVED FILE.
// `capturePristine()` (kernel/src/save.ts) clones the LIVE document at boot, so
// anything sitting on the root element by then is in the shell every ⌘S
// produces: measured, `bento.serialize()` came back with
// `<html lang="en" data-theme="light">`, and that file would then force one
// reader's choice on everyone who opened it. Exactly the bug this whole design
// exists to avoid, arriving through the back door.
//
// A node carrying `data-bento-transient` is stripped from every serialized
// shell (kernel save.ts TRANSIENT_SELECTOR) — the same mechanism the
// compressed shell uses for its inflated stylesheet. So the override is a
// <style> element carrying that attribute, and it declares `color-scheme`
// rather than any colour: styles.css writes the palette as `light-dark()`
// pairs, which resolve against the used `color-scheme`, so pinning that one
// property flips every token at once. 'auto' REMOVES the element — the absence
// of an override is what "follow the OS" means.
//
// `:root:root` for specificity (0,2,0), not `!important` and not a reliance on
// document order: this <style> is appended at module load, while the app's own
// stylesheet arrives from the deflate loader in the built shell and from Vite's
// injector in dev, and those two orders are not the same.
//
// --bar-opacity rides along because `light-dark()` is colour-only; see the
// note beside it in styles.css.

export type ThemePref = 'auto' | 'light' | 'dark'

const THEME_KEY = 'bento-theme'
const THEME_STYLE_ID = 'dx-theme'

/** The dark ground's data-bar opacity, kept in step with styles.css. */
const BAR_OPACITY: Record<'light' | 'dark', string> = { light: '0.55', dark: '0.45' }

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' ? v : 'auto'
  } catch { return 'auto' }
}

export function applyTheme(pref: ThemePref = readThemePref()): void {
  const existing = document.getElementById(THEME_STYLE_ID)
  if (pref === 'auto') { existing?.remove(); return }
  const style = existing ?? document.createElement('style')
  style.id = THEME_STYLE_ID
  // Never let this reach a saved file (see above). Set before the node is in
  // the document, so there is no window in which an unmarked style exists.
  style.setAttribute('data-bento-transient', '')
  style.textContent =
    `:root:root{color-scheme:${pref};--bar-opacity:${BAR_OPACITY[pref]}}`
  if (!existing) document.head.append(style)
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'auto') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, pref)
  } catch { /* private mode — the choice still holds for this session */ }
  applyTheme(pref)
}

// AT MODULE LOAD, and deliberately not from `mountAbout`: main.ts imports this
// module while it is booting and mounts About near the END of that boot, so
// waiting for the hook would paint the whole workspace in the wrong theme
// first. Here the rule lands before the app is built and while the splash is
// still covering the screen — which is also what lets the splash itself follow
// an explicit choice (index.html gives it `light-dark()` colours and nothing
// else). Guarded because scripts/test-dash-about.ts imports this module in
// Node, where there is no document to touch.
if (typeof document !== 'undefined') applyTheme()

// --- the local version timeline ---------------------------------------------

/** Roughly one kept version per this much editing. Slides' number. */
const VERSION_EVERY_MS = 120_000
let lastVersionAt = 0

/**
 * Add this workbook to the local timeline the About dialog restores from,
 * at most once per VERSION_EVERY_MS.
 *
 * NEVER for an encrypted workbook: a snapshot is the document as plain JSON,
 * so writing one puts in IndexedDB exactly what the password exists to keep off
 * the disk. The kernel does not guard this — every app has to, and dash already
 * remembers it for `putRecovery`; this is the second store and the same rule.
 */
export async function rememberVersion(doc: DashDoc): Promise<void> {
  if (isEncryptionActive()) return
  if (Date.now() - lastVersionAt < VERSION_EVERY_MS) return
  lastVersionAt = Date.now()
  await addVersion(doc)
}

// --- the dialog ---------------------------------------------------------------

/** Wire the ways in. The wordmark and the version chip are already in the top
 *  bar and neither does anything else, which is how slides does it too. */
export function mountAbout(app: HTMLElement, hooks: AboutHooks): void {
  for (const el of app.querySelectorAll<HTMLElement>('.dx-mark, .dx-ver')) {
    el.dataset.about = '1'
    el.tabIndex = 0
    el.setAttribute('role', 'button')
    el.title = t('About this workbook')
    el.addEventListener('click', () => openAbout(hooks))
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAbout(hooks) }
    })
  }
}

export function openAbout(hooks: AboutHooks): void {
  const { store } = hooks
  document.querySelector('.dx-about-back')?.remove()

  const back = document.createElement('div')
  back.className = 'dx-about-back'
  const card = document.createElement('div')
  card.className = 'dx-about'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-label', t('About this workbook'))
  const close = () => back.remove()

  // --- small builders
  const h = (label: string) => {
    const n = document.createElement('h2')
    n.textContent = label
    return n
  }
  const note = (text: string) => {
    const n = document.createElement('p')
    n.className = 'dx-about-note'
    n.textContent = text
    return n
  }
  const value = (text: string) => {
    const n = document.createElement('span')
    n.className = 'dx-about-val'
    n.textContent = text
    return n
  }
  const row = (label: string, node: HTMLElement) => {
    const r = document.createElement('div')
    r.className = 'dx-about-row'
    const s = document.createElement('span')
    s.textContent = label
    r.append(s, node)
    return r
  }
  const button = (label: string, fn: () => void) => {
    const b = document.createElement('button')
    b.className = 'dx-btn'
    b.textContent = label
    b.addEventListener('click', fn)
    return b
  }
  const actions = (...nodes: HTMLElement[]) => {
    const wrap = document.createElement('div')
    wrap.className = 'dx-about-actions'
    wrap.append(...nodes)
    return wrap
  }

  // --- what this is ---------------------------------------------------------
  const stats = workbookStats(store.doc)
  const lede = document.createElement('p')
  lede.className = 'dx-about-lede'
  lede.textContent = t(
    'bento/dash {version} · {sheets} sheet(s), {rows} row(s), {columns} column(s). The workbook, the grid and the formula engine are all in this one file.',
    { version: APP_VERSION, sheets: stats.sheets, rows: stats.rows, columns: stats.columns },
  )
  card.append(h(t('This file')), lede)

  const opened = openedFileName()
  if (opened) card.append(row(t('File'), value(opened)))
  card.append(row(t('Size'), value(t('{size} of a {budget} budget', {
    size: bytes(stats.bytes), budget: bytes(docBudget(canWriteInPlace())),
  }))))
  // The docId is the identity every restore, recovery and future merge keys
  // off, and the only place a reader can see it is here.
  card.append(row(t('Document id'), value(store.doc.docId ?? t('(none — this workbook has no id)'))))
  if (!canWriteInPlace()) {
    card.append(note(t('This browser cannot write back to the file, so every save makes a new copy. Chrome and Edge on a computer can save in place.')))
  }
  if (store.readOnly) {
    card.append(note(t('This workbook is open read-only, so nothing here writes to it.')))
  }

  // --- document properties --------------------------------------------------
  //
  // These go STRAIGHT onto doc.meta and are not undoable, which is a deliberate
  // gap rather than an oversight: the patch union has no op that writes above
  // the sheet except setTitle, and faking one (commit a setTitle with the
  // current title) would put an entry in the undo stack whose undo visibly does
  // nothing. Better a property that ⌘Z ignores than a ⌘Z that lies.
  card.append(h(t('Document properties')))
  const setMeta = (key: string, v: string) => {
    if (store.readOnly) return
    const meta: DocMeta = store.doc.meta ?? (store.doc.meta = {})
    if (v) meta[key] = v
    else delete meta[key]
    // an empty object is noise in a file whose bytes are the budget
    if (!Object.keys(meta).length) delete store.doc.meta
    store.touch()
    hooks.onDirty()
  }
  const META: Array<[string, string]> = [
    ['author', t('Author')],
    ['company', t('Company')],
    ['subject', t('Subject')],
    ['keywords', t('Keywords')],
  ]
  for (const [key, label] of META) {
    const input = document.createElement('input')
    input.className = 'dx-about-in'
    input.value = String(store.doc.meta?.[key] ?? '')
    input.disabled = store.readOnly
    input.addEventListener('change', () => setMeta(key, input.value.trim()))
    card.append(row(label, input))
  }
  // The title is edited in the top bar and only there — a second field for it
  // here would have to be kept in step with that input, and the loser of that
  // race silently overwrites the winner.
  card.append(note(t('Properties travel in the file. The title is edited in the top bar.')))

  // --- updates --------------------------------------------------------------
  card.append(h(t('Updates')))
  const upStatus = note(t('An update is verified before anything is rewritten: the release manifest is signed, and its signature is checked against a key inside this file.'))
  card.append(upStatus)
  const upActions = actions()
  card.append(upActions)
  upActions.append(button(t('Check for updates'), () => {
    if (offlineEnabled()) {
      upStatus.textContent = t('Offline mode is on, so nothing was contacted.')
      return
    }
    upStatus.textContent = t('Checking…')
    void checkForUpdates().then((res) => {
      if (res.status === 'current') {
        upStatus.textContent = t('You have the newest version ({v}).', { v: APP_VERSION })
        return
      }
      if (res.status !== 'update') {
        upStatus.textContent = t('Could not check for updates: {why}', { why: res.message })
        return
      }
      const rel: ReleaseInfo = res.release
      upStatus.textContent = t('Version {v} is available.', { v: rel.version })
      upActions.append(button(t('Update this file'), () => {
        upStatus.textContent = t('Downloading and verifying…')
        // Two shapes, and the difference is worth stating because one of them
        // leaves the file on disk untouched and the other does not.
        const run = canUpdateInPlace()
          ? applyUpdateInPlace(rel, store.doc).then((ok) => ok
            ? t('Updated. A backup of the old version was downloaded beside it — reload to run {v}.', { v: rel.version })
            : t('Cancelled — nothing was changed.'))
          : applyUpdate(rel, store.doc).then(() =>
            t('Downloaded. Open the new file — this one is unchanged.'))
        void run
          .then((msg) => { upStatus.textContent = msg })
          .catch((err: unknown) => {
            upStatus.textContent = t('The update was refused: {why}', {
              why: err instanceof Error ? err.message : String(err),
            })
          })
      }))
    })
  }))

  // --- language -------------------------------------------------------------
  card.append(h(t('Language')))
  const choices = localeChoices()
  const sel = document.createElement('select')
  for (const c of choices) {
    const o = document.createElement('option')
    o.value = c.code
    o.textContent = c.label
    if (c.code === locale()) o.selected = true
    sel.append(o)
  }
  sel.addEventListener('change', () => {
    setLocale(sel.value)
    close()
    // NOT a repaint: main.ts builds the top bar, the grid chrome and the status
    // bar from one template string with no way back in, so there is nothing to
    // call. Menus, dialogs and findings built after this point are localized;
    // the chrome catches up on the next open.
    openAbout(hooks)
  })
  card.append(row(t('Interface language'), sel))
  card.append(note(choices.length > 1
    // the same rule as slides and spaces: language follows the READER
    ? t('Language follows whoever opens the file. It is never written into the document, so a workbook reads in each reader’s own language. The rest of the interface catches up next time this file is opened.')
    : t('Only English so far. Language follows whoever opens the file and is never written into the document.')))

  // --- appearance -----------------------------------------------------------
  // Beside Language, because it is the same KIND of setting: both follow the
  // reader, neither is in the file. Applied live — the palette is custom
  // properties, so the running app re-resolves without a rebuild, and unlike
  // the language picker this one does not have to close and reopen the dialog.
  card.append(h(t('Appearance')))
  const themes: Array<[ThemePref, string]> = [
    ['auto', t('Match my system')],
    ['light', t('Light')],
    ['dark', t('Dark')],
  ]
  const themeSel = document.createElement('select')
  const current = readThemePref()
  for (const [v, label] of themes) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = label
    if (v === current) o.selected = true
    themeSel.append(o)
  }
  themeSel.addEventListener('change', () => setThemePref(themeSel.value as ThemePref))
  card.append(row(t('Theme'), themeSel))
  card.append(note(t('The theme follows whoever opens the file and is kept in this browser only — it is never written into the workbook, so one file can be light on your screen and dark on someone else’s.')))

  // --- password -------------------------------------------------------------
  card.append(h(t('Password')))
  const pwNote = note(isEncryptionActive()
    ? t('This workbook is encrypted. Every save stays encrypted.')
    : t('A password encrypts the workbook inside the file. There is no recovery — lose it and the data is gone.'))
  card.append(pwNote)
  card.append(actions(button(
    isEncryptionActive() ? t('Remove password…') : t('Set a password…'),
    () => {
      if (isEncryptionActive()) {
        if (!confirm(t('Remove the password? The next save writes the workbook in the clear.'))) return
        setEncryptionPassword(null)
        pwNote.textContent = t('Password removed. Save to write the workbook unencrypted.')
        return
      }
      const pw = prompt(t('Choose a password. There is no way to recover it.'))
      if (!pw) return
      setEncryptionPassword(pw)
      // Snapshots written BEFORE this moment are plaintext copies of the very
      // thing now being encrypted, sitting in IndexedDB. Both stores: the
      // single recovery snapshot and the whole version timeline.
      void clearRecovery(store.doc.docId)
      void clearVersions(store.doc.docId)
      pwNote.textContent = t('Password set. Save to write the workbook encrypted, and keep the password somewhere safe.')
    },
  )))

  // --- version history ------------------------------------------------------
  card.append(h(t('Version history')))
  const versions = document.createElement('div')
  versions.className = 'dx-about-vers'
  card.append(versions)
  card.append(note(t('Versions are kept in this browser only — never in the file, never online. Restoring replaces the whole workbook and cannot be undone.')))
  void listVersions(store.doc.docId).then((list) => {
    if (!list.length) {
      versions.replaceChildren(note(t('No versions kept yet — they accumulate as you edit.')))
      return
    }
    versions.replaceChildren(...list.map((snap, i) => {
      const b = document.createElement('button')
      b.className = 'dx-about-ver'
      b.disabled = store.readOnly
      const when = document.createElement('span')
      when.textContent = new Date(snap.at).toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }) + (i === 0 ? ` · ${t('most recent')}` : '')
      const doIt = document.createElement('span')
      doIt.textContent = t('Restore')
      b.append(when, doIt)
      b.addEventListener('click', () => {
        // A snapshot is this app's own JSON, but it is still parsed rather than
        // trusted: it may predate an id repair, or a sheet this build refuses.
        const res = parseDoc(snap.json)
        if (!res.ok) { alert(t('That version could not be read.')); return }
        if (!confirm(t('Restore this version? The current workbook is replaced and this cannot be undone.'))) return
        if (replaceWorkbook(hooks, res.doc)) close()
        else alert(t('That version has no table sheet to show.'))
      })
      return b
    }))
  })

  // --- ways out -------------------------------------------------------------
  card.append(h(t('Take it elsewhere')))
  const outNote = note(t('The whole workbook is plain JSON inside this file — copy it into any tool or AI, and bring the edited JSON back.'))
  const replaceBtn = button(t('Replace from JSON…'), () => openPaste())
  const duplicateBtn = button(t('Duplicate as new workbook…'), () => {
    // Identity fork, and this window BECOMES the copy: the save below points
    // ⌘S at the new file, so leaving the old document loaded would mean the
    // next save wrote the ORIGINAL workbook into it.
    const clone = duplicateWorkbook(store.doc)
    if (!replaceWorkbook(hooks, clone)) return
    close()
    void saveFile(clone, true)
  })
  // Both of these load a document into the running app, which is the one thing
  // a frozen workbook must not do — see replaceWorkbook. Disabled rather than
  // silently refused; the read-only note at the top of the dialog says why.
  replaceBtn.disabled = store.readOnly
  duplicateBtn.disabled = store.readOnly
  card.append(actions(
    button(t('Copy document JSON'), () => {
      void navigator.clipboard?.writeText(JSON.stringify(store.doc, null, 2))
        .then(() => { outNote.textContent = t('Copied — {size} of JSON.', { size: bytes(stats.bytes) }) })
        .catch(() => { outNote.textContent = t('This browser refused clipboard access.') })
    }),
    replaceBtn,
    duplicateBtn,
    button(t('Save a copy…'), () => { void saveFile(store.doc, true) }),
  ))
  card.append(outNote)

  /** The paste panel. A textarea, not `prompt()`: this is a whole workbook. */
  function openPaste(): void {
    if (store.readOnly) { outNote.textContent = t('This workbook is open read-only.'); return }
    if (card.querySelector('.dx-about-paste')) return
    const ta = document.createElement('textarea')
    ta.className = 'dx-about-paste'
    ta.spellcheck = false
    ta.placeholder = t('Paste bento/dash document JSON here')
    const go = button(t('Replace workbook'), () => {
      if (!ta.value.trim()) { ta.focus(); return }
      const res = parseDoc(ta.value)
      if (!res.ok) {
        outNote.textContent = t('That is not a bento/dash workbook: {why}',
          { why: 'detail' in res ? res.detail : res.err })
        return
      }
      // Undo does NOT reach across this. Store.replaceDoc empties both stacks,
      // so unlike slides there is no ⌘Z back — say so before, not after.
      if (!confirm(t('Replace this workbook with the pasted JSON? This cannot be undone.'))) return
      if (!replaceWorkbook(hooks, res.doc)) {
        outNote.textContent = t('That workbook has no table sheet to show.')
        return
      }
      close()
    })
    const bar = actions(go, button(t('Cancel'), () => { ta.remove(); bar.remove() }))
    // BEFORE the Close button, not appended to the card: `append` puts it after
    // Close, which on a dialog this tall means the panel opens below the fold
    // and the click reads as "nothing happened".
    card.insertBefore(ta, closeBtn)
    card.insertBefore(bar, closeBtn)
    ta.focus()
    ta.scrollIntoView({ block: 'nearest' })
  }

  const closeBtn = button(t('Close'), close)
  closeBtn.classList.add('dx-about-close')
  card.append(closeBtn)

  // main.ts owns two DOCUMENT-level handlers that this dialog sits inside:
  //   · a keydown that routes any bare printable key into the selected cell —
  //     and its guard is `INPUT || isContentEditable`, so a TEXTAREA is not
  //     covered: typing JSON in here would have typed into the grid as well.
  //   · a paste sniffer that treats any clipboard text with a comma or a tab as
  //     a CSV import, and calls preventDefault — so pasting a workbook, or an
  //     author name with a comma in it, imported a junk sheet instead.
  // Both are stopped at the backdrop, which contains everything in the dialog.
  // ⌘S is stopped with them, deliberately: saving from behind a modal that may
  // be mid-edit is not a gesture worth preserving.
  back.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close()
    e.stopPropagation()
  })
  back.addEventListener('paste', (e) => e.stopPropagation())
  back.addEventListener('mousedown', (e) => { if (e.target === back) close() })

  back.append(card)
  document.body.append(back)
  card.querySelector('button')?.focus()
}

/**
 * Swap the whole workbook in, keeping the grid on its feet. False when the
 * incoming document has nothing the grid can show.
 */
function replaceWorkbook(hooks: AboutHooks, next: DashDoc): boolean {
  const { store } = hooks
  // replaceDoc does NOT check store.readOnly — it is the load/restore path, not
  // an edit path — so a workbook frozen by an unknown policy or a future format
  // version has to be defended here or About becomes the way to write to it.
  if (store.readOnly) return false
  const showing = hooks.showingSheet()
  const plan = planReplace(next, showing)
  if (!plan) return false
  if (plan.carry) {
    const carried = store.doc.sheets.find((s) => s.id === showing)
    // Never saved and never autosaved: the second replaceDoc lands in the same
    // turn, and the recovery snapshot is 2.5s behind on a timer.
    store.replaceDoc(carried ? { ...next, sheets: [...next.sheets, carried] } : next)
    hooks.showSheet(plan.show)
  }
  store.replaceDoc(next)
  return true
}

const bytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
