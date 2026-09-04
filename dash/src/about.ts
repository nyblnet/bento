// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// About: what THIS FILE is — its identity, its size, its properties, its
// history, and the JSON it is made of.
//
// A self-contained document has nowhere else to put any of this. PLATFORM §3
// (identity, and the one sanctioned way to change it) and §7 (the JSON round
// trip) both need a surface, and this is it.
//
// THE SPLIT, AND WHY. This dialog used to hold everything: what the file is,
// its properties, updates, language, appearance, password, version history and
// the JSON round trip — eight sections, 1361px tall in a 429px viewport, which
// is three and a bit screens of scroll. Nothing in it was wrong; they were
// simply not one thing, and a reader looking for "what language is this in"
// scrolled past their own password to find it.
//
// The seam is one the codebase had already drawn. Language, theme and the
// update check follow the READER and are kept in this browser (PLATFORM §8);
// everything here travels in the FILE. So:
//
//   · settings.ts — language, appearance, updates, the network switch. Yours.
//   · about.ts    — identity, properties, history, the document as JSON. The
//                   file's.
//   · saveui.ts   — the password, with the other decisions about how this
//                   workbook gets WRITTEN (a template, a read-only copy, a
//                   fork). It is not a fact about the file and it is not a
//                   preference of the reader's: it is an instruction about
//                   every save from now on, and rule 3 of that file already
//                   reasons about encryption on every export path.
//
// The test for a new control is which of those three sentences it finishes.
// There is no fourth.
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
//     while someone is typing an author name or pasting JSON in here. Both are
//     stopped in dialog.ts, for both surfaces at once.

import { openDialog } from './dialog.ts'
import { openSettings, updateWaiting, type SettingsHooks } from './settings.ts'
import { APP_VERSION } from '../../kernel/src/update.ts'
import { canWriteInPlace, isEncryptionActive, openedFileName } from '../../kernel/src/save.ts'
import { addVersion, listVersions } from '../../kernel/src/autosave.ts'
// CIRCULAR, DELIBERATELY, and safe: recovery.ts imports `planReplace` from
// here. Both directions are used only inside function bodies — nothing at
// the time either is called, under Node's loader and Vite's bundler alike.
// The alternative was a third module for one banner, or a hook wired through
// main.ts that a future edit could quietly forget to pass, which would put the
// two restore paths straight back into disagreeing about reversibility.
import { offerUndoRestore } from './recovery.ts'
import { t } from './i18n.ts'
import { docBudget, docBytes, parseDoc, rowCount, type DashDoc, type DocMeta , docForExport } from './model.ts'

// The update check and the theme moved to settings.ts with the surface that
// shows them. They are re-exported because main.ts calls `checkAtLaunch` from
// here — that import is boot code owned by another module, and a rename that
// buys nothing is a merge conflict that buys nothing.
export { shouldCheckAtLaunch, checkAtLaunch, openSettings } from './settings.ts'

export interface AboutHooks extends SettingsHooks {
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
 *
 * THE ONE COPY OF THIS RULE. About used to offer "Duplicate as new workbook…"
 * beside the Save menu's "Save as new workbook…", which was the same fork
 * written twice — and the two spellings had already drifted (the menu's kept
 * `template: true`, so a fork of a template was a template). The button is gone
 * from the dialog; this function stayed, and the menu calls it.
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
 *  bar and neither does anything else, which is how slides does it too.
 *
 *  THE CHIP GOES TO SETTINGS, not here. It reads `v0.3.0`, and when the launch
 *  check finds something it reads `v0.3.0 → v0.4.0` — the question it raises is
 *  "am I running the newest app", which is now a Settings question. The ⓘ
 *  button and the mark, which say *this workbook*, open this dialog. That is
 *  the whole of the promise that you can tell which surface holds what from
 *  the name of the thing you clicked.
 *
 *  A `[data-act="settings"]` button is wired if the top bar has one. It is
 *  optional because the top bar is another module's, and About's own footer
 *  reaches Settings either way. */
export function mountAbout(app: HTMLElement, hooks: AboutHooks): void {
  const arm = (el: HTMLElement, title: string, open: () => void) => {
    el.dataset.about = '1'
    el.tabIndex = 0
    el.setAttribute('role', 'button')
    el.title = title
    el.addEventListener('click', open)
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
    })
  }
  for (const el of app.querySelectorAll<HTMLElement>('.dx-mark')) {
    arm(el, t('About this workbook'), () => openAbout(hooks))
  }
  for (const el of app.querySelectorAll<HTMLElement>('.dx-ver')) {
    arm(el, t('Settings — language, appearance and updates'), () => openSettings(hooks))
  }
  for (const el of app.querySelectorAll<HTMLElement>('[data-act="settings"]')) {
    el.addEventListener('click', () => openSettings(hooks))
  }
}

export function openAbout(hooks: AboutHooks): void {
  const { store } = hooks
  const d = openDialog(t('About this workbook'))
  const { card, note, close } = d

  // --- what this is ---------------------------------------------------------
  const stats = workbookStats(store.doc)
  const lede = document.createElement('p')
  lede.className = 'dx-about-lede'
  lede.textContent = t(
    'bento/dash {version} · {sheets} sheet(s), {rows} row(s), {columns} column(s). The workbook, the grid and the formula engine are all in this one file.',
    { version: APP_VERSION, sheets: stats.sheets, rows: stats.rows, columns: stats.columns },
  )
  card.append(d.h(t('This file')), lede)

  const opened = openedFileName()
  if (opened) card.append(d.row(t('File'), d.value(opened)))
  card.append(d.row(t('Size'), d.value(t('{size} of a {budget} budget', {
    size: bytes(stats.bytes), budget: bytes(docBudget(canWriteInPlace())),
  }))))
  // The docId is the identity every restore, recovery and future merge keys
  // off, and the only place a reader can see it is here.
  card.append(d.row(t('Document id'), d.value(store.doc.docId ?? t('(none — this workbook has no id)'))))
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
  card.append(d.h(t('Document properties')))
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
    card.append(d.row(label, input))
  }
  // The title is edited in the top bar and only there — a second field for it
  // here would have to be kept in step with that input, and the loser of that
  // race silently overwrites the winner.
  card.append(note(t('Properties travel in the file. The title is edited in the top bar.')))

  // --- version history ------------------------------------------------------
  card.append(d.h(t('Version history')))
  const versions = document.createElement('div')
  versions.className = 'dx-about-vers'
  card.append(versions)
  card.append(note(t('Versions are kept in this browser only — never in the file, never online. Restoring replaces the whole workbook, and offers one undo.')))
  void listVersions(store.doc.docId).then((list) => {
    if (!list.length) {
      versions.replaceChildren(note(t('No versions kept yet — they accumulate as you edit.')))
      return
    }
    versions.replaceChildren(...list.map((snap, i) => {
      const b = document.createElement('button')
      b.className = 'dx-about-ver'
      b.disabled = store.readOnly
      const stamp = new Date(snap.at).toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
      const when = document.createElement('span')
      when.textContent = stamp + (i === 0 ? ` · ${t('most recent')}` : '')
      const doIt = document.createElement('span')
      doIt.textContent = t('Restore')
      b.append(when, doIt)
      b.addEventListener('click', () => {
        // A snapshot is this app's own JSON, but it is still parsed rather than
        // trusted: it may predate an id repair, or a sheet this build refuses.
        const res = parseDoc(snap.json)
        if (!res.ok) { alert(t('That version could not be read.')); return }
        // Held BEFORE the swap: `replaceDoc` empties both undo stacks, so this
        // object is the only route back to the workbook on screen right now.
        const before = store.doc
        if (!replaceWorkbook(hooks, res.doc)) {
          alert(t('That version has no table sheet to show.'))
          return
        }
        close()
        // THE SAME OFFER THE RECOVERY BANNER MAKES, from the same function.
        // This was a `confirm()` reading "this cannot be undone" — which was a
        // second answer to a question the app had already answered one way, and
        // the weaker one: it asks BEFORE, when the reader cannot yet see what
        // they would be agreeing to, instead of handing them a way back AFTER,
        // when they can.
        offerUndoRestore(hooks, before, t('Restored the version from {when}.', { when: stamp }))
      })
      return b
    }))
  })

  // --- ways out -------------------------------------------------------------
  //
  // TWO BUTTONS NOW, not five. This section used to carry "Save a copy…" and
  // "Duplicate as new workbook…" as well, both of which the Save menu already
  // offers — "Save a copy…" under the identical label, and the fork as "Save as
  // new workbook…". Two doors to one action in one app is how they drift, and
  // these two had: the menu's fork kept `template: true` and About's did not.
  // The Save menu keeps them (it is where a reader looks for a file to come out
  // of the app, and it handles the released file handle and the size
  // confirmation properly); what stayed here is the thing that is NOT a save at
  // all — the document as text, for an AI or another tool.
  card.append(d.h(t('Take it elsewhere')))
  const outNote = note(t('The whole workbook is plain JSON inside this file — copy it into any tool or AI, and bring the edited JSON back.'))
  const replaceBtn = d.button(t('Replace from JSON…'), () => openPaste())
  // Loads a document into the running app, which is the one thing a frozen
  // workbook must not do — see replaceWorkbook. Disabled rather than silently
  // refused; the read-only note at the top of the dialog says why.
  replaceBtn.disabled = store.readOnly
  card.append(d.actions(
    d.button(t('Copy document JSON'), () => {
      // stripped — this lands on a clipboard and then, often, in a chat window
      void navigator.clipboard?.writeText(JSON.stringify(docForExport(store.doc), null, 2))
        .then(() => { outNote.textContent = t('Copied — {size} of JSON.', { size: bytes(stats.bytes) }) })
        .catch(() => { outNote.textContent = t('This browser refused clipboard access.') })
    }),
    replaceBtn,
  ))
  card.append(outNote)
  card.append(note(t('A copy, a template or a read-only copy: the ▾ beside Save.')))

  /** The paste panel. A textarea, not `prompt()`: this is a whole workbook. */
  function openPaste(): void {
    if (store.readOnly) { outNote.textContent = t('This workbook is open read-only.'); return }
    if (card.querySelector('.dx-about-paste')) return
    const ta = document.createElement('textarea')
    ta.className = 'dx-about-paste'
    ta.spellcheck = false
    ta.placeholder = t('Paste bento/dash document JSON here')
    const go = d.button(t('Replace workbook'), () => {
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
      // THE ROOM BELONGS TO THIS FILE, NOT TO THE PASTED TEXT. Content is
      // replaced; the collaboration credentials are this workbook's and stay.
      //
      // Both directions were wrong, and #338 turned the first from rare into
      // routine by stripping `collab` out of "Copy document JSON":
      //
      //   · a STRIPPED paste — now the ordinary AI round trip — carried no
      //     credentials, so replacing silently ENDED the live session. Measured:
      //     sharing on / room `w-abc` before, sharing off / room gone after,
      //     with nothing on screen saying so while peers kept editing.
      //   · a paste carrying SOMEBODY ELSE'S credentials silently JOINED their
      //     room. Measured: my room became `w-THEIRS` and my next edit went out
      //     under their key, with them holding the owner key that can revoke.
      //
      // The line is the one #338 draws itself — a saved FILE carrying its own
      // capability is the design, and pasted text is not a file. So a dropped
      // or opened workbook still adopts its own room; this does not.
      //
      // Not folded into `replaceWorkbook`: the Save menu's fork goes through it
      // too and mints fresh credentials ON PURPOSE.
      const keep = (store.doc as { collab?: unknown }).collab
      const merged = keep === undefined
        ? res.doc
        : { ...res.doc, collab: keep } as DashDoc
      if (!replaceWorkbook(hooks, merged)) {
        outNote.textContent = t('That workbook has no table sheet to show.')
        return
      }
      close()
    })
    const bar = d.actions(go, d.button(t('Cancel'), () => { ta.remove(); bar.remove() }))
    // BEFORE the footer, not appended to the card: `append` puts it after the
    // Close button, which means the panel opens below everything and the click
    // reads as "nothing happened".
    card.insertBefore(ta, foot)
    // SAY WHAT IT KEEPS. The paste replaces the content and not the room, which
    // is the right answer in both directions but is invisible either way — and
    // a live session quietly ending or quietly moving is exactly the class of
    // thing this app states rather than leaves to be discovered.
    if ((store.doc as { collab?: { on?: boolean } }).collab?.on) {
      card.insertBefore(
        note(t('Sharing stays with this workbook: the pasted JSON replaces the content, not the live session or its keys.')),
        foot,
      )
    }
    card.insertBefore(bar, foot)
    ta.focus()
    ta.scrollIntoView({ block: 'nearest' })
  }

  // --- the footer -----------------------------------------------------------
  // The way ACROSS, beside the way out. About and Settings are two halves of
  // one question people ask in one breath ("what is this thing / how do I make
  // it speak French"), and a reader who guessed wrong should be one click from
  // right rather than back in the top bar hunting.
  const toSettings = d.button(t('Settings'), () => openSettings(hooks))
  toSettings.title = t('Settings — language, appearance and updates')
  // …and it carries the update dot, because the badge that brought the reader
  // to ⓘ has to lead somewhere. The release itself is offered in Settings.
  if (updateWaiting()) toSettings.classList.add('dx-update-badge')
  const foot = d.actions(toSettings, d.button(t('Close'), close))
  foot.classList.add('dx-about-foot')
  card.append(foot)
  d.mount()
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
