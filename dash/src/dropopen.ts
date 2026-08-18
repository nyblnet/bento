// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Opening things by dropping them on the window.
//
// WHY THIS IS A DATA-SAFETY FEATURE AND NOT A CONVENIENCE ONE. Before this
// file, dash had no drag handlers at all — so a file dropped anywhere on the
// window hit the BROWSER's default, which is to navigate to it. Drop a CSV on
// your workbook and the tab becomes that CSV: every unsaved edit gone, no
// prompt, no undo. (The `beforeunload` guard in main.ts fires for a navigation,
// so there is a dialog — one that most people click through, and which does not
// say what is about to happen.) Preventing the default on EVERY file drop,
// including the ones we refuse, is therefore the first job here; routing it is
// the second.
//
// WHAT IS TAKEN, and why exactly these three:
//   · `.bento.html` / `.html` — a workbook. Opened into this window, with a
//     WRITABLE handle where the browser hands one over (Chromium), which is the
//     only route to in-place ⌘S for a file that arrived from disk.
//   · `.csv` / `.tsv` — imported as a new sheet, through the same `applyImport`
//     the Import button uses. Not a replacement: a delimited file is DATA and
//     the workbook is the thing it goes into.
//   · `.xlsx` — imported through xlsx.ts, one dash sheet per worksheet.
// Anything else is REFUSED OUT LOUD, naming the file. Silence would be the
// worst outcome of the three: the file vanishes from the drag, nothing appears,
// and the reader cannot tell "unsupported" from "broken".
//
// THREE GUARDS THIS FILE EXISTS TO HOLD:
//
//  1. A DROP MUST NOT LAND INSIDE A CELL EDITOR. Grid cells edit via
//     `contentEditable` (grid.ts), and a contentEditable accepts a file drop
//     natively — it inserts the file's NAME as cell text. The handlers below are
//     on the document in the CAPTURE phase and `preventDefault()` before the
//     cell ever sees the event, so an editor that happens to be open under the
//     cursor is inert rather than a place data gets typed by accident.
//  2. TEXT DRAGS ARE NOT OURS. Only drags carrying `Files` are intercepted;
//     dragging selected text within an input or a cell keeps the browser's own
//     behaviour, and main.ts's `paste` listener — which routes clipboard text
//     into the grid — is untouched. This module never listens for `paste`.
//  3. NOTHING IS OPENED INTO A WORKBOOK THIS BUILD WILL NOT WRITE. A read-only
//     or frozen document refuses the import rather than mutating a document the
//     app has promised not to touch; an encrypted session refuses a dropped
//     WORKBOOK, because the held password would silently become the new
//     workbook's password at the first ⌘S.

// NOTE the asymmetry, and it is deliberate: the CSV path is NOT called from
// here. `importDelimited` (import.ts) is reached through the host's
// `importText`, which is main.ts's `applyImport` — the same function the Import
// button calls, so a dropped file and a picked one produce the same sheet, the
// same findings and the same single undo checkpoint. The xlsx path has no such
// shared function to borrow (main.ts's lives inside its file picker), so it is
// spelled out below.
import { importXlsx, installNames } from './xlsx.ts'
import { parseDoc } from './model.ts'
import { swapWorkbook, type WorkbookHost } from './recovery.ts'
import { adoptFileHandle, hasFileHandle, isEncryptionActive } from '../../kernel/src/save.ts'
import { toast, forkTemplate, applyDocLock } from './saveui.ts'
import { t } from './i18n.ts'

// --- routing (pure) ----------------------------------------------------------

export type DropKind = 'workbook' | 'delimited' | 'xlsx'

/**
 * What a dropped file NAME says it is, or null for "not ours".
 *
 * By extension, not by MIME type, and that is deliberate: a `.csv` arrives as
 * `text/csv`, `application/vnd.ms-excel`, `text/plain` or `''` depending on the
 * operating system that produced it, and a `.bento.html` dragged out of an
 * archive often has no type at all. The extension is the one thing the user can
 * see and correct.
 *
 * `.xls` is NOT `.xlsx`: the legacy format is an OLE compound document and
 * xlsx.ts reads a ZIP, so accepting it would fail deep inside the reader with a
 * container error. It is refused here, where the message can say why.
 */
export function classifyDrop(name: string): DropKind | null {
  const n = name.toLowerCase().trim()
  if (n.endsWith('.bento.html') || n.endsWith('.html') || n.endsWith('.htm')) return 'workbook'
  if (n.endsWith('.csv') || n.endsWith('.tsv') || n.endsWith('.tab')) return 'delimited'
  if (n.endsWith('.xlsx') || n.endsWith('.xlsm')) return 'xlsx'
  return null
}

/**
 * The refusal, naming the file. `.xls` and `.numbers` get their own line
 * because "dash cannot open this" is unhelpful when the answer is one Save As
 * away, and because both are things people genuinely have.
 */
export function refusalFor(name: string): string {
  const shown = name || t('That file')
  const n = name.toLowerCase()
  if (n.endsWith('.xls')) {
    return t('“{name}” is the older Excel format. Open it in Excel and save it as .xlsx, and dash will read it.', { name: shown })
  }
  if (n.endsWith('.numbers') || n.endsWith('.ods')) {
    return t('“{name}” is a spreadsheet dash cannot read. Export it as .xlsx or .csv first.', { name: shown })
  }
  return t('“{name}” is not something dash can open. Drop a .bento.html workbook, a .csv or .tsv, or an .xlsx.', { name: shown })
}

// --- the surface -------------------------------------------------------------

export interface DropHost extends WorkbookHost {
  /**
   * main.ts's `applyImport` — the CSV path the Import button already uses, so a
   * dropped file and a picked one produce the same sheet, the same findings and
   * the same one undo checkpoint. Reimplementing it here would be a second
   * answer to "what does importing do".
   */
  importText: (text: string, source: string) => void
  /**
   * What opening this file decided, for the findings strip.
   *
   * Takes an ARRAY as well as a string, and that is the whole of finding 12.
   * `showFindings` renders one bullet per entry and the MENU import path passes
   * it the array, so it does. This path could only hand over one string, so it
   * had to `.join(' ')` first — and `budget.xlsx` arrived as a wall of amber
   * text 224px tall, 31% of a 720px window, with no bullets, no grouping and no
   * link to the column concerned.
   *
   * Two doors into one feature, and the door people actually use — dragging the
   * file onto the window — was the one that destroyed the structure.
   */
  notice: (message: string | ReadonlyArray<{ message: string }>) => void
  /** Unsaved edits in the OPEN workbook — main.ts owns the flag. */
  dirty?: () => boolean
}

/**
 * Wire the window for drops. Idempotent per call site; call once at boot.
 *
 * Returns a teardown, which nothing in the app uses today — it exists so a DOM
 * rig can mount and unmount this without leaking handlers onto the document.
 */
export function mountDropOpen(host: DropHost): () => void {
  let depth = 0   // dragenter/dragleave fire per ELEMENT crossed, not per window
  let overlay: HTMLElement | null = null

  const carriesFiles = (ev: DragEvent): boolean =>
    !!ev.dataTransfer && Array.from(ev.dataTransfer.types).includes('Files')

  const show = () => {
    if (overlay) return
    overlay = document.createElement('div')
    overlay.className = 'dxr-drop'
    const card = document.createElement('div')
    card.className = 'dxr-drop-card'
    const head = document.createElement('strong')
    head.textContent = t('Drop to open')
    const sub = document.createElement('span')
    sub.textContent = t('A .bento.html workbook opens here; a .csv, .tsv or .xlsx is imported as new sheets.')
    card.append(head, sub)
    overlay.append(card)
    document.body.append(overlay)
  }
  const hide = () => { depth = 0; overlay?.remove(); overlay = null }

  const onEnter = (ev: DragEvent) => {
    if (!carriesFiles(ev)) return
    depth++
    show()
  }
  const onOver = (ev: DragEvent) => {
    if (!carriesFiles(ev)) return
    // BOTH halves matter: preventDefault marks this a valid drop target (so the
    // drop event fires at all), and dropEffect makes the cursor say "copy"
    // rather than "move", which is what the gesture actually is.
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
    if (!overlay) show()
  }
  const onLeave = (ev: DragEvent) => {
    if (!carriesFiles(ev)) return
    if (--depth <= 0) hide()
  }
  const onDrop = (ev: DragEvent) => {
    if (!carriesFiles(ev)) return
    // Guard 1 and the navigation guard, in one line and before anything else
    // can throw: whatever this file turns out to be, the browser must not
    // navigate to it and no cell editor may receive it.
    ev.preventDefault()
    hide()
    void handleDrop(host, ev)
  }

  const opts = { capture: true } as const
  document.addEventListener('dragenter', onEnter, opts)
  document.addEventListener('dragover', onOver, opts)
  document.addEventListener('dragleave', onLeave, opts)
  document.addEventListener('drop', onDrop, opts)
  // A drag that ends outside the window (Esc, or a drop on another app) fires
  // neither drop nor a final dragleave in every browser — without this the
  // overlay can be left covering the app.
  window.addEventListener('dragend', hide)
  window.addEventListener('blur', hide)

  return () => {
    document.removeEventListener('dragenter', onEnter, opts)
    document.removeEventListener('dragover', onOver, opts)
    document.removeEventListener('dragleave', onLeave, opts)
    document.removeEventListener('drop', onDrop, opts)
    window.removeEventListener('dragend', hide)
    window.removeEventListener('blur', hide)
    hide()
  }
}

async function handleDrop(host: DropHost, ev: DragEvent): Promise<void> {
  const items = Array.from(ev.dataTransfer?.items ?? []).filter((i) => i.kind === 'file')
  const files = Array.from(ev.dataTransfer?.files ?? [])
  const name = files[0]?.name ?? ''
  if (!files.length) {
    // A drag that advertised `Files` and delivered none: a folder on some
    // platforms, or a drag from an app that only offers a promise.
    host.notice(t('That drop had no file in it. Drag a file from a folder, not from another app’s preview.'))
    return
  }
  if (files.length > 1) {
    host.notice(t('One file at a time — opening “{name}” and ignoring the other {n}.',
      { name, n: files.length - 1 }))
  }

  const kind = classifyDrop(name)
  if (!kind) { host.notice(refusalFor(name)); return }

  if (host.store.readOnly) {
    host.notice(t('This workbook is open read-only, so “{name}” was not opened into it.', { name }))
    return
  }

  try {
    if (kind === 'workbook') await openWorkbook(host, items[0], files[0])
    else if (kind === 'delimited') host.importText(await files[0].text(), name)
    else await openXlsx(host, files[0])
  } catch (e) {
    // A refusal, never a crash: the file on disk is untouched and so is the
    // workbook on screen — the message says which file failed, because by now
    // the drag is over and the user has nothing else to go on.
    host.notice(t('“{name}” could not be opened. {why}',
      { name, why: e instanceof Error ? e.message : String(e) }))
  }
}

/** A dropped .xlsx: every worksheet arrives as its own sheet, exactly as the
 *  Import Excel button does. */
async function openXlsx(host: DropHost, file: File): Promise<void> {
  const buf = await file.arrayBuffer()
  // `names: true` is the caller's half of a two-part contract, and the gate
  // TRUSTS it: `liveFormula` lets a formula go live when every bare word it
  // mentions is a name the import carried. Ask for the names and then fail to
  // install them, and `=B4*TaxRate` paints #NAME? over a real number — which is
  // the exact bug this opt-in exists to prevent. So the two lines belong
  // together, and both import doors get them in the same commit.
  const r = await importXlsx(new Uint8Array(buf), {
    source: file.name,
    at: new Date().toISOString(),
    idPrefix: `xl-${Math.floor(Date.now() % 1e8).toString(36)}`,
    names: true,
  })
  if (!r.sheets.length) {
    host.notice(t('“{name}” has no worksheet dash could read.', { name: file.name }))
    return
  }
  host.store.doc.sheets.push(...r.sheets)
  installNames(host.store.doc, r.names)
  host.store.replaceDoc(host.store.doc)
  host.showSheet(r.sheets[0].id)
  // The array, unflattened. One bullet per finding, the same as the menu path.
  host.notice([
    { message: t('Imported {n} sheet(s) from “{name}”.', { n: r.sheets.length, name: file.name }) },
    ...(r.findings as Array<{ message: string }>),
  ])
}

/**
 * A dropped workbook: this window BECOMES that file.
 *
 * ORDER MATTERS and it is the same lesson slides learned: `requestPermission()`
 * needs a live user gesture and the drop is it, so the handle is asked for
 * FIRST. Reading a multi-megabyte shell before asking spends the activation,
 * the request throws, and the workbook opens without write-back — meaning every
 * ⌘S re-runs the save picker for a file the user already has open, which is
 * precisely what dropping it was meant to avoid.
 */
async function openWorkbook(host: DropHost, item: DataTransferItem | undefined, file: File): Promise<void> {
  const name = file.name
  // The held password belongs to the workbook that is open, not to this one. A
  // swap would leave it applied, and the first ⌘S would encrypt somebody else's
  // workbook with a password they never chose for it.
  if (isEncryptionActive()) {
    host.notice(t('This window has an encrypted workbook open. Open “{name}” in a new window instead.', { name }))
    return
  }
  if (host.dirty?.() && !window.confirm(
    t('Open “{name}”? Unsaved changes in this workbook will be lost.', { name }))) return

  const anyItem = item as unknown as { getAsFileSystemHandle?: () => Promise<unknown> } | undefined
  let handle: unknown = null
  try { handle = (await anyItem?.getAsFileSystemHandle?.()) ?? null } catch { /* not supported — opens read-only */ }
  let writable = false
  const perm = handle as { requestPermission?: (o: { mode: string }) => Promise<string> } | null
  if (perm?.requestPermission) {
    try { writable = await perm.requestPermission({ mode: 'readwrite' }) === 'granted' }
    catch { /* denied, or the activation was already spent — read-only open */ }
  }

  const html = await file.text()
  // THESE TWO CASES ARE DIFFERENT and telling them apart is the whole reason
  // this reads the element rather than just its text. `readEmbeddedDoc` in the
  // kernel flattens them (`text || null`), and main.ts's boot dispatcher has
  // its own note about the same trap. Measured here with an ordinary web page:
  // treating "no block" as "empty block" told the user their holiday-photos
  // page was "an empty copy of dash", which is nonsense dressed as diagnosis.
  const el = new DOMParser().parseFromString(html, 'text/html').querySelector('#bento-doc')
  const block = el?.textContent?.trim() ?? ''
  if (!el) {
    host.notice(t('“{name}” is an HTML file, but not a Bento document — it carries no document block.', { name }))
    return
  }
  if (!block) {
    // A pristine, never-saved shell ships an EMPTY block — the starter workbook
    // is generated at runtime, not stored. That is a perfectly good bento/dash
    // file with nothing in it yet, and calling it foreign would be wrong.
    host.notice(t('“{name}” has no workbook in it — it is an empty copy of dash. Open it on its own to start one.', { name }))
    return
  }
  let head: { format?: string } | null = null
  try { head = JSON.parse(block) as { format?: string } } catch { /* reported below */ }
  if (head?.format === 'bento/enc') {
    // The password gate lives in boot (main.ts) and there is nothing here to
    // prompt with; half-opening it would mean showing an unlocked-looking
    // window over a document we never decrypted.
    host.notice(t('“{name}” is password-protected. Open it directly to unlock it.', { name }))
    return
  }
  const res = parseDoc(block)
  if (!res.ok) {
    host.notice(t('“{name}” is not a bento/dash workbook: {why}',
      { name, why: 'detail' in res ? res.detail : res.err }))
    return
  }
  // A DROPPED WORKBOOK IS A FOREIGN DOCUMENT ENTERING THIS WINDOW, so it goes
  // through the same adoption boot does. It did not, and that was an
  // enforcement gap rather than a missing nicety: `adoptOpenedDoc` is what
  // applies `readonly` and forks a template's identity, and it was called from
  // exactly one place — `main.ts`, the boot path. Dropping a read-only workbook
  // onto an editable one therefore handed you an editable copy of a file whose
  // author had marked it read-only, and dropping a template kept the template's
  // own docId, which is the key recovery and sync are stored under.
  //
  // Split across the swap because the halves disagree about ordering: see
  // `forkTemplate` / `applyDocLock` in saveui.ts. Neither `swapWorkbook`
  // caller in recovery.ts needs this — those restore the SAME workbook, not a
  // foreign one.
  forkTemplate(res.doc)
  if (!swapWorkbook(host, res.doc)) {
    host.notice(t('“{name}” has no table sheet to show, so it was not opened.', { name }))
    return
  }
  applyDocLock(res.doc, host.store)
  // AFTER the swap, and only on success: the handle decides where ⌘S writes,
  // so touching it earlier would aim the next save at a file whose contents are
  // not what is on screen.
  //
  // THE `else` IS THE DANGEROUS HALF, and it is silent data loss if it is left
  // out. The held handle is module state in the kernel and belongs to the
  // workbook being REPLACED: if this window was saving to A and B is dropped
  // without a writable handle (Chromium offers one and the permission prompt is
  // declined), then the next ⌘S writes B's contents straight over A — a file
  // the user never named in this gesture, with no picker and no warning.
  // Clearing it puts ⌘S back on the picker, which is merely inconvenient.
  //
  // The cast is a KERNEL GAP, not a trick: `adoptFileHandle` types its argument
  // non-null because nothing needed to release a handle until now, and the
  // implementation is a bare assignment. The right fix is a `releaseFileHandle()`
  // beside it in kernel/src/save.ts; until that exists, this is the same
  // assignment spelled where the reason for it is written down.
  if (writable) adoptFileHandle(handle as never)
  else adoptFileHandle(null as never)
  toast(hasFileHandle()
    ? t('Opened “{name}” — ⌘S writes it back', { name })
    : t('Opened “{name}” — ⌘S will save a copy', { name }))
}
