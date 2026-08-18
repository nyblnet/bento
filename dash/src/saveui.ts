// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The Save split button: save, copy, new workbook, template, read-only copy.
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
// READ-ONLY IS ENFORCED HERE TOO, not merely offered: `adoptOpenedDoc` locks
// the store when a file arrives carrying `readonly`. A tier you can mint and
// nobody honours is worse than no tier at all.

import './saveui.css'
import {
  saveFile, serializeAuto, writeUpdatedFileAs, canWriteInPlace,
} from '../../kernel/src/save.ts'
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
  if (doc.template) {
    delete doc.template
    doc.docId = newDocId()
  }
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
  caret.title = t('Save as… — copy, new workbook, template, read-only')
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
        const next = clone(store.doc)
        next.docId = newDocId()
        // A fork must not inherit a live room: the file IS the capability
        // (PLATFORM §5), so a copied credential is a copied invitation.
        delete next.collab
        store.replaceDoc(next)
        const r = await saveFile(store.doc, true)
        toast(r === 'cancelled'
          ? t('This is now a new workbook — save it under a new name')
          : t('Saved as a new workbook'))
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
