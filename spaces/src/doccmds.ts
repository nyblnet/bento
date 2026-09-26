// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE DOCUMENT'S OWN COMMANDS — the Save menu, in slides' order.
//
// Slides keeps every command that acts on the file as a whole under Save's
// caret: save a copy, duplicate as new, export, encrypt, then (after a rule)
// version history and the JSON round trip. Spaces had the same commands in
// three places — three rows under the caret, the rest in ⋯ and in the About
// dialog's Password, History, "Take it elsewhere" and "Careful" sections — so
// the question "how do I encrypt this?" had a different answer in each app.
// Now the answer is the same: Save ▾. About keeps what slides' About keeps
// (the version, updates, viewer preferences, the document's properties).
//
// One list for both homes: the caret on a wide bar, the foot of ⋯ once the bar
// has folded, exactly as slides' buildSaveAsItems serves both.
//
// What slides has and spaces does not (Copy compact JSON, Start from scratch)
// is not invented here; what spaces has and slides does not (Markdown in and
// out, a page as its own space) sits in the slot of its KIND — exports with
// the export, Import beside Replace from JSON, the two ways a document arrives.

import { setEncryptionPassword, isEncryptionActive } from '../../kernel/src/save.ts'
import { clearVersions, clearRecovery, listVersions, type Snapshot } from '../../kernel/src/autosave.ts'
import type { Dialog } from '../../kernel/src/ui/dialog.ts'
import { t } from './i18n'
import { ICONS } from './icons'
import { row, type Menu } from './menus.ts'
import { docForExport, parseDoc, uid, type SpacesDoc } from './model'
import type { Store } from './store'

export interface DocHost {
  store: Store
  openOverlay(title: string, build: (body: HTMLElement, close: () => void) => void, o?: { wide?: boolean; top?: boolean; className?: string }): Dialog
  repaint(): void
  notice(msg: string): void
  saveCopy(): void
  exportMarkdown(): void
  exportSpace(): void
  /** a DIFFERENT document written as its own file; keeps no handle */
  writeCopy(doc: SpacesDoc): Promise<boolean>
  importMarkdown(): void
  /** extra export rows a build carries (the tour's page-as-slides), in order */
  moreExports?: (m: Menu) => void
}

/**
 * The rows, into `m`. A CONSEQUENCE menu (D2): a row whose effect you should
 * read before you press it says so on the row; every row also carries its
 * description as a tooltip, which is where slides keeps all of them.
 */
export function saveRows(m: Menu, h: DocHost): void {
  const ro = h.store.readOnly
  const tip = (b: HTMLElement, s: string) => { b.title = s; return b }

  tip(row(m, { icon: ICONS.copy, label: t('Save a copy…'), run: () => h.saveCopy() }),
    t('A second file — the original is left alone'))
  row(m, { icon: ICONS.plus, label: t('Duplicate as a new space…'),
    hint: t('Same pages, new identity — it never syncs with this one'),
    run: () => duplicate(h) })
  tip(row(m, { icon: ICONS.markdown, label: t('Export as Markdown…'), run: () => h.exportMarkdown() }),
    t('Every page, as one .md file'))
  tip(row(m, { icon: ICONS.page, label: t('Export page as a space…'), run: () => h.exportSpace() }),
    t('One page and what is under it, as its own file'))
  h.moreExports?.(m)
  if (isEncryptionActive()) {
    row(m, { icon: ICONS.lock, label: t('Change password…'), off: ro, run: () => openPassword(h) })
    row(m, { icon: ICONS.lock, label: t('Remove password…'),
      hint: t('The next save writes plain, readable JSON'), off: ro, run: () => openRemovePassword(h) })
  } else {
    row(m, { icon: ICONS.lock, label: t('Encrypt with password…'),
      hint: t('No recovery — lose the password and the space is gone'), off: ro, run: () => openPassword(h) })
  }

  // the document AS DATA — the timeline and the round trips
  m.separator()
  tip(row(m, { icon: ICONS.history, label: t('Version history…'), run: () => openHistory(h) }),
    t('Versions are kept in this browser only — never in the file, never online. Restoring is undoable.'))
  row(m, { icon: ICONS.code, label: t('Copy document JSON'), run: () => copyJson(h) })
  row(m, { icon: ICONS.code, label: t('Replace from JSON…'), hint: t('Replaces every page — ⌘Z undoes'),
    off: ro, run: () => openReplaceJson(h) })
  tip(row(m, { icon: ICONS.markdown, label: t('Import Markdown…'), off: ro, run: () => h.importMarkdown() }),
    t('A folder of .md files becomes pages, with the folder tree and the [[wikilinks]] intact.'))
}

/** The labels, in order — what the chrome rig holds the menu to. */
export const SAVE_ORDER = [
  'Save a copy…', 'Duplicate as a new space…', 'Export as Markdown…', 'Export page as a space…',
  'Encrypt with password…', 'Version history…', 'Copy document JSON', 'Replace from JSON…', 'Import Markdown…',
]

// ---- the commands ---------------------------------------------------------

/**
 * A DUPLICATE, not a copy: a fresh docId and no collaboration credentials, so
 * it can never sync with the space it came from. You keep editing this one —
 * the writer holds no handle (portable.ts).
 */
function duplicate(h: DocHost): void {
  const clone = JSON.parse(JSON.stringify(h.store.doc)) as SpacesDoc
  clone.docId = uid('doc')
  delete clone.collab
  clone.modified = new Date().toISOString()
  void h.writeCopy(clone)
}

/**
 * The clipboard copy is a HAND-OUT: every field under `collab` is a bearer
 * capability, so model.docForExport strips the block outright.
 */
function copyJson(h: DocHost): void {
  const text = JSON.stringify(docForExport(h.store.doc), null, 2)
  const p = navigator.clipboard?.writeText(text)
  if (!p) { h.notice(t('Couldn’t access the clipboard')); return }
  p.then(() => h.notice(t('Document JSON copied'))).catch(() => h.notice(t('Couldn’t access the clipboard')))
}

/** slides' 440px card, as its Version history and Replace from JSON */
const narrow = (d: Dialog): void => { d.card.classList.add('sp-dlg-narrow') }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text) n.textContent = text
  return n
}
const button = (label: string, fn: () => void, primary = false): HTMLButtonElement => {
  const b = el('button', 'sp-btn' + (primary ? ' sp-primary' : ''), label)
  b.type = 'button'
  b.addEventListener('click', fn)
  return b
}
const actions = (...kids: HTMLElement[]): HTMLElement => {
  const d = el('div', 'sp-actions sp-dlg-actions')
  d.append(...kids)
  return d
}

/**
 * Set or change the password — two fields, as slides asks, instead of a
 * native prompt() that echoed nothing back and could not be confirmed.
 * Plaintext snapshots written BEFORE encryption was turned on would defeat it,
 * so both local stores are cleared; main.ts writes neither from here on.
 */
function openPassword(h: DocHost): void {
  narrow(h.openOverlay(t('Encrypt with password…').replace(/…$/, ''), (body, close) => {
    body.append(el('p', 'sp-note', t('The password cannot be recovered — if it is lost, the file is lost.')))
    const field = (label: string) => {
      const l = el('label', 'sp-ab-field')
      l.append(el('span', '', label))
      const i = el('input', 'sp-input')
      i.type = 'password'
      i.autocomplete = 'new-password'
      l.append(i)
      body.append(l)
      return i
    }
    const a = field(t('Password'))
    const b = field(t('Confirm password'))
    const err = el('p', 'sp-note sp-dlg-err')
    err.setAttribute('role', 'alert')
    body.append(err)
    const go = async () => {
      if (!a.value) { err.textContent = t('Password'); a.focus(); return }
      if (a.value !== b.value) { err.textContent = t('Passwords do not match'); b.focus(); return }
      setEncryptionPassword(a.value)
      await clearVersions(h.store.doc.docId)
      await clearRecovery(h.store.doc.docId)
      close()
      h.notice(t('Password set. Save to write the space encrypted.'))
    }
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter') void go() })
    body.append(actions(button(t('Cancel'), close), button(t('Set password'), () => { void go() }, true)))
    queueMicrotask(() => a.focus())
  }))
}

function openRemovePassword(h: DocHost): void {
  narrow(h.openOverlay(t('Remove the password?'), (body, close) => {
    body.append(el('p', 'sp-note', t('The next save writes this space as plain, readable JSON — anybody who opens the file can read every page.')))
    body.append(actions(button(t('Cancel'), close), button(t('Remove the password'), () => {
      setEncryptionPassword(null)
      close()
      h.notice(t('Password removed. Save to write the space unencrypted.'))
    }, true)))
  }))
}

/**
 * The local timeline, as its own dialog (slides' "Version history…"). It lives
 * in this browser's IndexedDB — never in the file, never online — and the note
 * says so, because a space carried to another machine does not bring it.
 */
function openHistory(h: DocHost): void {
  narrow(h.openOverlay(t('Version history'), (body, close) => {
    const list = el('div', 'sp-ab-versions')
    body.append(list, el('p', 'sp-note', t('Versions are kept in this browser only — never in the file, never online. Restoring is undoable.')))
    const render = (versions: Snapshot[]): void => {
      list.textContent = ''
      if (!versions.length) {
        list.append(el('p', 'sp-note', isEncryptionActive()
          ? t('This space is encrypted, so no versions are kept.')
          : t('No versions yet — they build up as you write and save.')))
        return
      }
      for (const [i, v] of versions.entries()) {
        const when = new Date(v.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        const b = el('button', 'sp-ab-version')
        b.type = 'button'
        b.append(el('span', 'sp-ab-when', when), el('span', 'sp-ab-vtag', i === 0 ? t('most recent') : ''), el('span', 'sp-ab-vdo', t('Restore')))
        b.addEventListener('click', () => {
          let restored: SpacesDoc
          try { restored = JSON.parse(v.json) as SpacesDoc } catch { h.notice(t('That version could not be read')); return }
          // replaceDoc checkpoints undo first, so ⌘Z walks this back
          h.store.replaceDoc(restored)
          h.repaint()
          close()
          h.notice(t('Restored the version from {when} — ⌘Z undoes it', { when }))
        })
        list.append(b)
      }
    }
    render([])
    void listVersions(h.store.doc.docId).then(render).catch(() => { /* no store, no history */ })
  }))
}

/**
 * Paste-and-apply (the counterpart of Copy document JSON). The live session
 * belongs to THIS document, not to the pasted text: content is imported,
 * identity and capability are not.
 */
function openReplaceJson(h: DocHost): void {
  narrow(h.openOverlay(t('Replace from JSON'), (body, close) => {
    body.append(el('p', 'sp-note', t('Everything in this space is replaced by what you paste. ⌘Z undoes it, but only while this window stays open.')))
    const ta = el('textarea', 'sp-ab-json')
    ta.rows = 8
    ta.placeholder = t('Paste document JSON here…')
    body.append(ta)
    const apply = button(t('Replace'), () => {
      const res = parseDoc(ta.value)
      if (!res.ok) {
        ta.classList.add('sp-ab-bad')
        apply.textContent = t('That is not a bento/spaces document')
        setTimeout(() => { apply.textContent = t('Replace') }, 2000)
        return
      }
      const keep = h.store.doc.collab
      if (keep) res.doc.collab = keep
      else delete res.doc.collab
      h.store.replaceDoc(res.doc)
      h.repaint()
      close()
      h.notice(t('Document replaced — ⌘Z undoes'))
    }, true)
    body.append(actions(button(t('Cancel'), close), apply))
    queueMicrotask(() => ta.focus())
  }))
}
