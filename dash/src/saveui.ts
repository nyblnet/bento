// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The Save split button: save, copy, new workbook, template, read-only copy —
// and the password.
//
// WHY A MENU AT ALL. One Save button can only mean "write this file", and a
// workbook is the document type people fork constantly — a copy before a risky
// restructure, a blank version of the model to hand to someone else, a frozen
// snapshot for the board pack. Every one of those was previously "save, then
// find the file in Finder, then duplicate it, then reopen it", and the last two
// were not expressible at all.
//
// THE THREE RULES THIS FILE EXISTS TO HOLD, all of them learned in slides:
//
//   1. A SHARE EXPORT MUST NOT BECOME THE ⌘S TARGET. `writeUpdatedFileAs`
//      only retains the picked File System Access handle when told to
//      (`keepHandle`, kernel/src/save.ts). It used to retain it always, and the
//      consequence was measured and ugly: export a read-only copy, keep
//      working, press ⌘S — and the FULL document overwrites the locked copy you
//      just handed someone. Templates and read-only copies below pass no
//      `keepHandle`. "Save a copy" deliberately does keep it (it goes through
//      `saveFile(doc, true)`, which is the copy purpose): a copy is a file you
//      continue in, an export is a file you hand over.
//   2. IDENTITY CHANGES IN EXACTLY ONE PLACE. `docId` is minted once and never
//      regenerated (PLATFORM §3); "Save as new workbook" is the only sanctioned
//      exception, and it mints a fresh id AND drops any collaboration
//      credentials in the same breath, so the fork can never rejoin its
//      ancestor's room.
//   3. AN EXPORT PATH MUST NOT SILENTLY DECRYPT. Every write below goes through
//      `serializeAuto`, which is encryption-aware, so a password-protected
//      workbook exports as a password-protected template. (Slides' template
//      path uses the plain `serializeFile`; that is the older code and it means
//      a template of an encrypted deck ships in cleartext. A password is the
//      author's standing instruction about this content, and an export that
//      quietly countermands it is precisely the leak the preview's encryption
//      veto exists to prevent.)
//
// WHY THE PASSWORD IS IN THIS MENU. It used to be a section of the About
// dialog, which was the wrong shelf for it twice over: it is not a FACT about
// the workbook (About's half of the split — identity, size, properties,
// history) and it is not a preference of the READER's (Settings' half —
// language, theme, updates). It is a standing instruction about how this file
// gets written from now on, which is precisely what every other item in this
// menu is, and rule 3 above already makes every one of them reason about it.
// Sitting here, "Set a password…" is two items below "Save as template…", and
// the relationship between them — the template of an encrypted workbook is
// encrypted — is visible instead of being a paragraph in a different dialog.
//
// READ-ONLY IS ENFORCED HERE TOO, not merely offered: `adoptOpenedDoc` locks
// the store when a file arrives carrying `readonly`. A tier you can mint and
// nobody honours is worse than no tier at all.

import './saveui.css'
import {
  saveFile, serializeAuto, writeUpdatedFileAs, canWriteInPlace, adoptFileHandle,
  isEncryptionActive, setEncryptionPassword,
} from '../../kernel/src/save.ts'
import { clearRecovery, clearVersions } from '../../kernel/src/autosave.ts'
import { duplicateWorkbook } from './about.ts'
import { docBytes, docBudget, type DashDoc } from './model.ts'
import type { Store } from './store.ts'
import { t } from './i18n.ts'

export interface SaveMenuHost {
  /** The app's existing Save button — the caret is inserted beside it. */
  button: HTMLElement
  store: Store
  /**
   * The app's in-place save. Taken rather than reimplemented because it also
   * owns the dirty flag and the over-budget confirmation; two copies of "what
   * ⌘S does" is how the button and the keystroke drift apart.
   */
  save: () => void | Promise<void>
}

/** A uuid, with the same fallback shape starter.ts uses for old runtimes. */
const newDocId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const clone = (doc: DashDoc): DashDoc => JSON.parse(JSON.stringify(doc)) as DashDoc

let toastTimer: number | undefined

export function toast(message: string): void {
  document.querySelector('.dxs-toast')?.remove()
  const el = document.createElement('div')
  el.className = 'dxs-toast'
  el.textContent = message
  document.body.appendChild(el)
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => el.remove(), 3600)
}

/**
 * The over-budget confirmation, in the same words the app's own save uses.
 *
 * Not a refusal (model.ts: "dash budgets BYTES with consent, not rows with a
 * refusal") — the user is told what will actually break in THIS browser and
 * decides. It is repeated on the export paths because they write a whole file
 * too: a 30MB workbook exported as a template downloads 30MB just as surely.
 */
function confirmBudget(doc: DashDoc): boolean {
  const bytes = docBytes(doc)
  if (bytes <= docBudget(canWriteInPlace())) return true
  const mb = (bytes / 1024 / 1024).toFixed(1)
  const how = canWriteInPlace()
    ? t('Saving will take a moment.')
    : t('This browser has no in-place save, so every save downloads the whole file.')
  return window.confirm(
    `${t('This workbook is {mb} MB.').replace('{mb}', mb)} ${how} ${t('Save anyway?')}`)
}

/**
 * What a file carrying `template` or `readonly` means at open time.
 *
 * Call once at boot, right after the Store is constructed and BEFORE anything
 * reads `store.readOnly` or writes an autosave snapshot.
 *
 *   · `template: true` — every open starts a FRESH workbook: the flag is
 *     dropped and a new `docId` minted. Without this a template is just a file
 *     that keeps overwriting itself, and — worse — every copy anyone makes of
 *     it shares one `docId`, which is the key autosave recovery and all future
 *     sync are stored under. model.ts already documents this as the format's
 *     meaning ("`template: true` re-mints docId on every open"); this is where
 *     it becomes true.
 *   · `readonly: true` — a locked copy. The store refuses commits, which is
 *     what actually stops an edit: the grid checks `store.readOnly` on every
 *     write path, and the title field is disabled from the same flag.
 */
export function adoptOpenedDoc(doc: DashDoc, store: Store): void {
  forkTemplate(doc)
  applyDocLock(doc, store)
}

/**
 * The two halves, separately, because the DROP path needs them on opposite
 * sides of the swap and boot does not care.
 *
 * `swapWorkbook` refuses to load into a workbook that is already locked (a
 * frozen workbook has to be defended by every caller, since `replaceDoc` is
 * the load path and does not check). So on a drop, the lock can only be
 * applied AFTER the incoming document has landed — apply it first and the
 * document it was meant to protect never arrives. The template fork has the
 * opposite constraint: the identity must be re-minted BEFORE the document
 * reaches the store, or the store briefly holds — and autosaves under — the
 * template's own docId.
 *
 * Boot calls `adoptOpenedDoc` and gets both in the only order that exists
 * there. Nothing else should call these two directly without saying why.
 */
export function forkTemplate(doc: DashDoc): void {
  if (doc.template) {
    delete doc.template
    doc.docId = newDocId()
  }
}

export function applyDocLock(doc: DashDoc, store: Store): void {
  if (doc.readonly) store.readOnly = true
}

/**
 * Hang the save menu off the app's Save button.
 *
 * The Save button keeps its own click handler; this only adds the caret beside
 * it. That is deliberate — the most-used control in the header is not rewired
 * to add four occasional ones.
 */
export function installSaveMenu(host: SaveMenuHost): void {
  const { button, store } = host

  const wrap = document.createElement('span')
  wrap.className = 'dxs-wrap'
  button.replaceWith(wrap)
  wrap.appendChild(button)

  const caret = document.createElement('button')
  caret.className = 'dx-btn dxs-caret'
  caret.type = 'button'
  caret.textContent = '▾'
  caret.title = t('Save as… — copy, new workbook, template, read-only, password')
  caret.setAttribute('aria-label', caret.title)

  const menu = document.createElement('div')
  menu.className = 'dxs-menu'
  wrap.append(caret, menu)

  const close = () => wrap.classList.remove('dxs-open')
  caret.addEventListener('click', () => {
    const opening = !wrap.classList.contains('dxs-open')
    wrap.classList.toggle('dxs-open', opening)
    // Rebuilt on every open because it reflects live state — a read-only file
    // offers nothing, and the labels name the file we would actually write.
    if (opening) build()
  })
  document.addEventListener('pointerdown', (ev) => {
    if (!wrap.contains(ev.target as Node)) close()
  })
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') close()
  })

  const item = (label: string, why: string, run: () => void | Promise<void>) => {
    const b = document.createElement('button')
    b.className = 'dxs-item'
    b.type = 'button'
    b.appendChild(Object.assign(document.createElement('span'), { textContent: label }))
    b.appendChild(Object.assign(document.createElement('small'), { textContent: why }))
    if (store.readOnly) {
      b.disabled = true
      b.title = t('This workbook is open read-only, so this build will not write it.')
    } else {
      b.addEventListener('click', () => { close(); void run() })
    }
    menu.appendChild(b)
  }

  const build = () => {
    menu.textContent = ''

    item(t('Save'), t('Write this workbook back to its own file.'),
      () => host.save())

    item(t('Save a copy…'), t('A second file you carry on working in — same workbook, same identity.'),
      async () => {
        if (!confirmBudget(store.doc)) return
        const r = await saveFile(store.doc, true)
        if (r !== 'cancelled') toast(t('Copy saved'))
      })

    item(t('Save as new workbook…'), t('A separate workbook — same data, new identity. Nothing links it back to this one.'),
      async () => {
        if (!confirmBudget(store.doc)) return
        // ONE implementation of the fork, in about.ts, which is where the rig
        // that proves it lives (scripts/test-dash-about.ts). This was a second
        // copy of the same three lines and it had already drifted: it kept
        // `template: true`, so forking a template gave you another template —
        // a file that re-mints its identity on every open, which is the exact
        // opposite of "a separate workbook".
        const next = duplicateWorkbook(store.doc, newDocId())
        store.replaceDoc(next)
        const r = await saveFile(store.doc, true)
        if (r === 'cancelled') {
          // THE FORK IS ALREADY IN MEMORY and the picker was closed, so the
          // held handle still points at the ANCESTOR — a file this document is
          // no longer a version of. ⌘S would overwrite it; automatic write-back
          // (writeback.ts) would do the same thing 2.5s later with no gesture at
          // all, which is how the original quietly becomes the fork. Releasing
          // puts both back on the picker, which is merely inconvenient.
          //
          // The `null` cast is the same KERNEL GAP dropopen.ts names: nothing
          // needed to RELEASE a handle until a document could stop belonging to
          // its file, `adoptFileHandle` types its argument non-null, and the
          // implementation is a bare assignment. The fix is a
          // `releaseFileHandle()` beside it in kernel/src/save.ts.
          adoptFileHandle(null as never)
          toast(t('This is now a new workbook — save it under a new name'))
        } else {
          toast(t('Saved as a new workbook'))
        }
      })

    menu.appendChild(Object.assign(document.createElement('div'), { className: 'dxs-sep' }))

    item(t('Save as template…'), t('A starting point: every open of it becomes a fresh workbook of its own.'),
      async () => {
        if (!confirmBudget(store.doc)) return
        const next = clone(store.doc)
        next.template = true
        delete next.collab
        // No docId: `adoptOpenedDoc` mints one per open, which is what makes
        // each instance a separate workbook rather than N files fighting over
        // one recovery slot.
        delete (next as { docId?: string }).docId
        await writeExport(next, 'template',
          t('Template saved — every open of it starts a fresh workbook'))
      })

    item(t('Save read-only copy…'), t('A locked copy for handing out: it opens, it does not edit.'),
      async () => {
        if (!confirmBudget(store.doc)) return
        const next = clone(store.doc)
        next.readonly = true
        delete next.collab
        await writeExport(next, 'viewonly',
          t('Read-only copy saved — it opens locked'))
      })

    menu.appendChild(Object.assign(document.createElement('div'), { className: 'dxs-sep' }))

    // The password. Nothing is written here — it sets the standing instruction
    // that every path above then honours through `serializeAuto`.
    if (isEncryptionActive()) {
      item(t('Remove password…'), t('The next save writes the workbook in the clear.'), () => {
        if (!confirm(t('Remove the password? The next save writes the workbook in the clear.'))) return
        setEncryptionPassword(null)
        toast(t('Password removed. Save to write the workbook unencrypted.'))
      })
    } else {
      item(t('Set a password…'), t('Encrypts the workbook inside the file. There is no recovery — lose it and the data is gone.'), () => {
        const pw = prompt(t('Choose a password. There is no way to recover it.'))
        if (!pw) return
        setEncryptionPassword(pw)
        // Snapshots written BEFORE this moment are plaintext copies of the very
        // thing now being encrypted, sitting in IndexedDB. Both stores: the
        // single recovery snapshot and the whole version timeline.
        void clearRecovery(store.doc.docId)
        void clearVersions(store.doc.docId)
        toast(t('Password set. Save to write the workbook encrypted, and keep the password somewhere safe.'))
      })
    }
  }

  build()
}

/**
 * Write a share export: a NEW file, chosen by the user, that never becomes the
 * ⌘S target (rule 1 at the top of this file — no `keepHandle`).
 */
async function writeExport(doc: DashDoc, suffix: string, done: string): Promise<void> {
  try {
    const ok = await writeUpdatedFileAs(await serializeAuto(doc), doc, { suffix })
    if (ok) toast(done)
  } catch (err) {
    console.error(err)
    toast(t('Save failed — see console'))
  }
}
