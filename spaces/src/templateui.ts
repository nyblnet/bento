// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The surfaces for page templates: save this page as one, start a page from
// one, and the small manager that lists them.
//
// SEPARATE FROM editor.ts on purpose. editor.ts is 5,500 lines and five
// branches are editing it at once; a feature that can live behind a narrow host
// interface should. `TemplateHost` is the whole contract — the store operations
// this needs and nothing else — so this file never sees the editor's internals
// and the editor's diff for the feature is a handful of lines.
//
// The dialogs are built the way openHelp() builds its: an `sp-overlay`
// backdrop, an `sp-card` with role=dialog, Escape and backdrop-click to close,
// and focus returned where it came from. No new CSS — every class used here
// already exists in styles.css, which is another file this zone should not be
// racing five branches for.

import { type Page, type SpacesDoc, newPage } from './model.ts'
import { t, locale } from './i18n.ts'
import { isJournal } from './journal.ts'
import {
  type PageTemplate, applyTemplate, makeTemplate, putTemplate, removeTemplate,
  setJournalTemplate, templatesOf, templateById,
} from './templates.ts'

/**
 * What this module needs from the editor, and all it may have.
 *
 * `commit` is the important one: every mutation below goes through exactly one
 * of these, so saving a template, deleting one, or making a page from one is a
 * single ⌘Z each.
 */
export interface TemplateHost {
  readonly doc: SpacesDoc
  readonly readOnly: boolean
  readonly page: Page | undefined
  commit(mutate: () => void): void
  goToPage(id: string): void
  status(msg: string): void
  /** repaint, then put the caret in the new page's title */
  afterCreate(): void
  /**
   * A page icon as SVG markup.
   *
   * Supplied by the editor rather than imported, because `pageIcon` lives in
   * editor.ts and editor.ts imports this file — importing it back would close a
   * module cycle for one label. It also matters that this is not `icon ?? ''`:
   * a page icon here is usually a NAME from the stylised set ('compass'), not
   * an emoji, so pasting the raw field into a label reads "compass Daily log".
   * Measured in the built shell, which is how it was found.
   */
  pageIcon(icon: string | undefined): string
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text) n.textContent = text
  return n
}

/** A modal card. Returns the card to fill and the close function. */
function card(label: string): { card: HTMLElement; close: () => void } {
  const back = el('div', 'sp-overlay')
  const box = el('div', 'sp-card')
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  box.setAttribute('aria-label', label)
  const returnFocus = document.activeElement as HTMLElement | null
  const close = () => {
    back.remove()
    document.removeEventListener('keydown', onKey, true)
    returnFocus?.focus?.()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close() }
  }
  back.append(box)
  back.addEventListener('click', (e) => { if (e.target === back) close() })
  document.addEventListener('keydown', onKey, true)
  document.body.append(back)
  box.tabIndex = -1
  return { card: box, close }
}

function button(label: string, run: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = primary ? 'sp-btn sp-on' : 'sp-btn'
  b.textContent = label
  b.addEventListener('click', run)
  return b
}

// ---- save a page as a template ---------------------------------------------

/**
 * Capture the page in view.
 *
 * The name field starts as the page's title, because that is right nearly every
 * time and a dialog that makes you type what it already knows is a dialog
 * people stop using.
 */
export function savePageAsTemplate(host: TemplateHost, page: Page): void {
  if (host.readOnly) return
  const { card: box, close } = card(t('Save as template'))
  box.append(el('h2', 'sp-card-h', t('Save as template')))
  box.append(el('p', 'sp-note', t('New pages can start as a copy of this one. The page itself is not changed.')))

  const field = el('div', 'sp-field')
  const lbl = el('label', 'sp-field-lbl', t('Template name'))
  const input = document.createElement('input')
  input.type = 'text'
  input.value = page.title || ''
  input.id = 'sp-tpl-name'
  lbl.htmlFor = input.id
  field.append(lbl, input)
  box.append(field)

  box.append(el('p', 'sp-note', t('Write {{date}} anywhere and each new page gets its own date there.')))

  const save = () => {
    const name = input.value.trim() || page.title || t('Template')
    const tpl = makeTemplate(page, name)
    host.commit(() => { putTemplate(host.doc, tpl) })
    close()
    host.status(t('Saved as a template'))
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save() }
  })

  const row = el('div', 'sp-row')
  row.append(button(t('Cancel'), close), button(t('Save template'), save, true))
  box.append(row)
  input.focus()
  input.select()
}

// ---- start a page from one -------------------------------------------------

/**
 * A new page built from a template, as ONE commit.
 *
 * The page is pushed at the end of `doc.pages` exactly as `newPage` does, so
 * nothing here has an opinion about ordering that the plain path does not.
 */
export function newPageFromTemplate(host: TemplateHost, tplId: string, parent?: string): void {
  if (host.readOnly) return
  const tpl = templateById(host.doc, tplId)
  if (!tpl) { host.status(t('That template is no longer in this space')); return }
  const page = newPage(t('Untitled'))
  if (parent) page.parent = parent
  applyTemplate(page, tpl, { locale: locale() })
  host.commit(() => { host.doc.pages.push(page) })
  host.goToPage(page.id)
  host.afterCreate()
}

// ---- the manager -----------------------------------------------------------

/**
 * Every template, with what you can do to each.
 *
 * "Use for daily notes" is a RADIO across the list rather than a per-row
 * toggle, because `doc.journalTemplate` holds one id: showing it as eight
 * independent switches would let the UI depict a state the document cannot
 * hold. Clicking the one that is on turns it off (back to a blank entry), which
 * is the only way to reach "none" without a ninth control.
 */
export function openTemplates(host: TemplateHost): void {
  const { card: box, close } = card(t('Templates'))
  const paint = () => {
    box.innerHTML = ''
    box.append(el('h2', 'sp-card-h', t('Templates')))
    const list = templatesOf(host.doc)
    const journalId = typeof host.doc.journalTemplate === 'string' ? host.doc.journalTemplate : ''

    if (!list.length) {
      box.append(el('p', 'sp-note',
        t('No templates yet. Open a page you would like to reuse and choose “Save as template”.')))
    }

    for (const tpl of list) {
      const row = el('div', 'sp-row')
      // NOT `sp-result-ico`: that class is `display: flex`, so it is a block
      // inside a plain span and the name wrapped under its own icon. Measured
      // in the built shell. `sp-tpl-name` is the flex parent it needed.
      const name = el('span', 'sp-tpl-name')
      name.innerHTML = `<span>${host.pageIcon(tpl.icon)}</span><span>${escapeHtml(tpl.name)}</span>`
      const acts = el('span', '')
      // A READER sees the list and no controls. `store.commit` no-ops in a
      // read-only copy, so every one of these would have been a button that
      // silently did nothing — which is worse than not offering it, because the
      // reader concludes the file is broken rather than that it is read-only.
      const isJ = journalId === tpl.id
      if (!host.readOnly) {
        acts.append(button(t('New page'), () => { close(); newPageFromTemplate(host, tpl.id) }))
        acts.append(button(isJ ? t('Daily note ✓') : t('Use for daily notes'), () => {
          host.commit(() => { setJournalTemplate(host.doc, isJ ? undefined : tpl.id) })
          paint()
        }, isJ))
        acts.append(button(t('Delete'), () => {
          if (!confirm(t('Delete the template “{name}”? Pages already made from it are not touched.', { name: tpl.name }))) return
          host.commit(() => { removeTemplate(host.doc, tpl.id) })
          paint()
        }))
      }
      row.append(name, acts)
      box.append(row)
    }

    const cur = host.page
    if (cur && !host.readOnly) {
      box.append(el('p', 'sp-note', isJournal(cur)
        ? t('A daily entry can be saved as a template too — its date is not saved with it.')
        : t('Saving a page keeps its blocks, its icon and its width.')))
      const foot = el('div', 'sp-row')
      foot.append(button(t('Save this page as a template'), () => {
        close()
        savePageAsTemplate(host, cur)
      }, true), button(t('Close'), close))
      box.append(foot)
    } else {
      const foot = el('div', 'sp-row')
      foot.append(button(t('Close'), close))
      box.append(foot)
    }
    box.focus()
  }
  paint()
}

/** The templates a "new page" menu should offer, empty when there are none. */
export const pickable = (doc: SpacesDoc): PageTemplate[] => templatesOf(doc)

/**
 * The "＋" in the page list, once templates exist.
 *
 * WITH NO TEMPLATES IT DOES NOT APPEAR — it returns false and the caller makes
 * a blank page exactly as it always did. A picker whose only entry is "Blank
 * page" adds a click to the most-used control in the app in exchange for
 * nothing, and every space starts with no templates, so that would be the
 * default experience of this feature for everyone who never uses it.
 *
 * Positioned against the anchor by MEASUREMENT and flipped when the room below
 * runs out. A popover hanging off the bottom of a short window is a failure
 * this app has already written down twice.
 */
export function openNewPagePicker(
  host: TemplateHost, anchor: HTMLElement, blank: () => void, parent?: string,
): boolean {
  const list = templatesOf(host.doc)
  if (!list.length) return false

  const pop = el('div', 'sp-pop')
  pop.setAttribute('role', 'menu')
  const close = () => {
    pop.remove()
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('mousedown', away, true)
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
  const away = (e: MouseEvent) => { if (!pop.contains(e.target as Node)) close() }

  const item = (icon: string | undefined, label: string, run: () => void) => {
    const b = document.createElement('button')
    b.className = 'sp-dditem'
    b.type = 'button'
    b.setAttribute('role', 'menuitem')
    b.innerHTML = `<span class="sp-result-ico">${host.pageIcon(icon)}</span>` +
      `<span class="sp-result-txt"><strong>${escapeHtml(label)}</strong></span>`
    b.addEventListener('click', (e) => { e.stopPropagation(); close(); run() })
    return b
  }

  pop.append(item('plus', t('Blank page'), blank))
  pop.append(el('div', 'sp-menu-label', t('From a template')))
  for (const tpl of list) {
    pop.append(item(tpl.icon, tpl.name, () => newPageFromTemplate(host, tpl.id, parent)))
  }

  document.body.append(pop)
  const r = anchor.getBoundingClientRect()
  const h = pop.getBoundingClientRect().height
  const below = window.innerHeight - r.bottom - 8
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 268))}px`
  if (h > below && r.top > below) pop.style.top = `${Math.max(8, r.top - h - 6)}px`
  else { pop.style.top = `${r.bottom + 6}px`; pop.style.maxHeight = `${Math.max(120, below)}px` }

  document.addEventListener('keydown', onKey, true)
  setTimeout(() => document.addEventListener('mousedown', away, true), 0)
  return true
}
