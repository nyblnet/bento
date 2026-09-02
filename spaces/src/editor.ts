// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/spaces editor.
//
// The keyboard IS the interface here, so the keymap is specified rather than
// discovered, and every block is its own contentEditable host — never one big
// editable container. That is what keeps Selection block-scoped, so splitting
// and merging blocks can never re-mint an id, and ids are what links,
// backlinks and (later) collaboration key on.

import {
  type Block, type Page, type TableShape, type SpacesDoc, newBlock, newPage, effectiveParents, isRemote,
  tableOf, writeTable, TABLE_MAX_COLS, TABLE_MAX_ROWS, linkCard, linkCardHtml, unresolvedOn,
  parseDoc, uid,
} from './model'
import { CommentsUi, commentBadge } from './comments.ts'
import * as collabUi from './collabui.ts'
import { syncNoticeText } from './syncnotice.ts'
import { Store } from './store'
import { renderPage, toneLabel, paintCode } from './render'
import { wireCanvas, placeNewCard } from './canvas.ts'
import { CODE_LANGS, langLabel, normLang } from './highlight'
import { canonicalize, escText, sanitizeInline, textOf } from './sanitize'
import { FormatBar } from './formatbar'
import type { MarkTag } from './marks'
import { MENU_SPECS, MD_SPECS, SPEC, CALLOUT_TONES } from './blocks'
import {
  fieldByKey, fieldsOf, propHtml, propBlock, propBlockOf, isIssue, headerLength,
  reorderPages, columnMoves, ISSUE_FIELDS, withField, freeFieldKey, fieldTypeLabel, FIELD_TYPES,
  cycleSort, nextLayout,
  type DropAim, type FieldSpec, type ViewFilter, type ViewSort,
} from './fields'
import { planImport, type SourceFile } from './markdown'
import { extractSpace, planGraft } from './portable'
import { countOutsideTags, replaceOutsideTags } from './findreplace'
import { asksForAnswer, evaluate, format, pageContext } from './calc'
import { t, locale } from './i18n'
import { openAbout } from './about'
import { openGraphView } from './graph.ts'
import {
  todayISO, stepDay, journalLabel, journalShort, isJournal, planJournal,
} from './journal'
import { canWriteInPlace, parseEnvelope } from '../../kernel/src/save.ts'
import { offlineEnabled } from '../../kernel/src/net.ts'
import { startSharing } from '../../kernel/src/sync/online.ts'
import * as shareModule from './share.ts'
import { ICONS, type IconName } from './icons'
import { PropsPanel } from './props'
import {
  internAsset, prepareImage, humanBytes, IMAGE_EMBED_BUDGET, MEDIA_EMBED_BUDGET, blobToDataUri,
} from './assets'

const CTRL = navigator.platform.toLowerCase().includes('mac') ? 'metaKey' : 'ctrlKey'

// Markdown autoformat and the / menu both come from the block registry
// (blocks.ts), so a type cannot end up with a menu entry and no trigger, or a
// trigger that no menu mentions.
const AUTOFORMAT = MD_SPECS

const SLASH_ITEMS = MENU_SPECS
/** What counts as a note when a folder is dropped on the app. */
const NOTE_EXT = /\.(md|markdown|mdown|mkd)$/i
/** …and what counts as another SPACE: a saved shell, or the bare document JSON
 *  the AI round-trip hands around. Both carry the same `#bento-doc` payload. */
const SPACE_EXT = /\.(html|htm|json)$/i

/**
 * When an import stops embedding images by itself and ASKS.
 *
 * A vault's attachment folder is unbounded — 400MB of screenshots is ordinary
 * — and a space is something you mail. But the house rule for size is warn,
 * never block (assets.ts SPACE_WEIGHT_WARN), so this is one question at one
 * threshold, not a ceiling: answer yes and the rest embed too.
 */
const IMPORT_IMAGE_BUDGET = 12 * 1024 * 1024

/** A picked or dropped file, with the path it had on disk. */
interface PickedFile { path: string; file: File }


/**
 * This reader's preferred page width, or undefined for the built-in default.
 *
 * VIEWER-SCOPED, in localStorage beside the language and the pane width, and
 * never in the document: it describes the screen somebody is sitting at, not
 * anything about the space. Two people opening one file on a laptop and a
 * 27-inch monitor should each get their own answer, and neither should write
 * theirs into a file the other opens.
 */
export function readerWidth(): 'wide' | 'full' | undefined {
  try {
    const v = localStorage.getItem('bento-sp-width')
    return v === 'wide' || v === 'full' ? v : undefined
  } catch { return undefined }
}

export function setReaderWidth(v: 'wide' | 'full' | undefined): void {
  try {
    if (v) localStorage.setItem('bento-sp-width', v)
    else localStorage.removeItem('bento-sp-width')
  } catch { /* a locked-down origin just gets the default */ }
}

export class Editor {
  readonly store: Store
  private root: HTMLElement
  private main!: HTMLElement
  private sidebar!: HTMLElement
  private statusEl!: HTMLElement
  private overlay: HTMLElement | null = null
  /** undo whatever the open popover attached to the window */
  private overlayReflow: (() => void) | null = null
  /** set while the editor is writing the DOM, so input handlers stand down */
  private painting = false
  /** reading view: the document without the machinery for changing it */
  private reading = false
  /**
   * Remote image urls this READER has agreed to load, this session only.
   *
   * Never persisted and never written to the document: consent belongs to the
   * person opening the file, and saving it would carry one reader's decision to
   * everyone the file is forwarded to. Re-opening asks again, which is the
   * correct default for something that leaks an IP address.
   */
  private allowedRemote = new Set<string>()
  private undoB: HTMLButtonElement | null = null
  private readB: HTMLButtonElement | null = null
  private redoB!: HTMLButtonElement
  private dirtyDot!: HTMLElement
  private paneTab: HTMLButtonElement | null = null
  private static readonly PANE_MIN = 150
  private static readonly PANE_MAX = 420
  private static readonly PANE_DEFAULT = 244
  private paneW = Editor.PANE_DEFAULT
  private paneClosed = false

  // The properties panel — the reader's, like the page list, and CLOSED unless
  // this reader has opened it. See props.ts on why the default is that way
  // round.
  private inspector!: HTMLElement
  private inspTab: HTMLButtonElement | null = null
  private inspRz: HTMLElement | null = null
  private props: PropsPanel | null = null
  private static readonly INSP_MIN = 200
  private static readonly INSP_MAX = 420
  private static readonly INSP_DEFAULT = 280
  private inspW = Editor.INSP_DEFAULT
  private inspClosed = true
  /** the block the panel is describing: the last one the caret or a click was in */
  private inspOn: string | null = null
  /** review threads — markers in the end margin, badges in the tree */
  private comments: CommentsUi
  private format!: FormatBar
  onSave: (() => void) | null = null
  onSaveAs: ((suffix: string) => void) | null = null
  /**
   * Write a DIFFERENT document out as its own file — the page extract.
   *
   * Supplied by main.ts, because serializing a shell is a boot-time concern
   * (the pristine capture) and the editor has no business holding it. It is
   * separate from `onSaveAs` on purpose: every suffix there writes THIS
   * document, and an export that went through it would have to smuggle the
   * extract in through a global.
   */
  onExportSpace: ((doc: SpacesDoc) => Promise<boolean>) | null = null
  /**
   * Write a SHARE copy — a different document, under this space's name plus a
   * suffix that says which kind of copy it is.
   *
   * Separate from `onExportSpace` (which names the file after the extracted
   * page) and from `onSaveAs` (every suffix there serializes THIS document,
   * credentials and all — which is precisely how "Invite someone…" came to
   * hand out the owner key). A share copy is always a derived document, so it
   * needs a writer that takes one.
   */
  onShareCopy: ((doc: SpacesDoc, suffix: string) => Promise<boolean>) | null = null
  onPrint: (() => void) | null = null

  constructor(root: HTMLElement, store: Store) {
    this.root = root
    this.store = store
    // the reader's panel, restored — never the document's
    try {
      const w = Number(localStorage.getItem('bento-sp-pane'))
      if (Number.isFinite(w) && w > 0) this.paneW = Math.min(Editor.PANE_MAX, Math.max(Editor.PANE_MIN, w))
      this.paneClosed = localStorage.getItem('bento-sp-pane-closed') === '1'
      const iw = Number(localStorage.getItem('bento-sp-insp'))
      if (Number.isFinite(iw) && iw > 0) this.inspW = Math.min(Editor.INSP_MAX, Math.max(Editor.INSP_MIN, iw))
      // ABSENT MEANS CLOSED. Only an explicit '0' — this reader opened it once —
      // gives the panel any width, so a fresh file opens as the page and nothing
      // else.
      this.inspClosed = localStorage.getItem('bento-sp-insp-closed') !== '0'
    } catch { /* storage throws on a locked-down origin; the defaults are fine */ }
    this.build()
    // AFTER build(): `main` exists by then, and the marker layer is painted
    // into whatever the page paint just produced.
    this.comments = new CommentsUi({
      store: this.store,
      main: () => this.main,
      popover: (anchor, build) => this.popover(anchor, (pop) => build(pop, () => this.closeOverlay())),
      paintTree: () => this.paintTree(),
    })
    // Also after build(). `editable()` is asked on every selectionchange, and
    // it is the ONE place the bar is kept out of the reading view, out of a
    // readonly/reader-role file, and out from under an open modal.
    this.format = new FormatBar({
      store: this.store,
      main: () => this.main,
      editable: () => !this.store.readOnly && !this.reading && !this.overlay,
    })
    if (this.paneClosed) this.sidebar.classList.add('sp-pane-closed')
    this.props = new PropsPanel(this.inspector, {
      store: this.store,
      target: () => this.inspOn,
      locked: () => this.store.readOnly || this.reading,
      repaint: () => this.paintPage(),
      pickPoster: (id) => void this.pickPoster(id),
      pickCover: (pageId) => void this.pickCover(pageId),
      removeCover: (pageId) => this.removeCover(pageId),
      pickMedia: (id) => void this.pickMedia(id),
      openIconPicker: (pageId, anchor) => this.openIconPicker(pageId, anchor),
      openAddProperty: (pageId, anchor) => this.openAddProperty(pageId, anchor),
      pageIcon: (icon) => pageIcon(icon),
      openLinkCard: (id) => this.openLinkCard(id),
      addTableRow: (id, at) => this.addTableRow(id, at),
      removeTableRow: (id, at) => this.removeTableRow(id, at),
      addTableCol: (id, at) => this.addTableCol(id, at),
      removeTableCol: (id, at) => this.removeTableCol(id, at),
    })
    this.store.on('tree', () => this.paintTree())
    this.store.on('page', () => { this.paintPage(); this.paintTree() })
    this.store.on('doc', () => { this.status(t('Edited')); this.syncHistoryButtons(); this.syncDirty() })
    // A REMOTE change moves the unsaved dot without claiming you made it —
    // 'doc' paints "Edited", 'dirty' paints only the dot. See store.setDirty.
    this.store.on('dirty', () => this.syncDirty())
    window.addEventListener('popstate', () => this.fromHash())
    this.fromHash()
  }

  // ---- chrome -------------------------------------------------------------
  private build(): void {
    this.root.innerHTML = ''
    this.root.className = 'sp-app'

    const bar = el('header', 'sp-bar')
    // THE SUITE'S MARK, and the way into About — the same control slides has.
    // A wordmark that is only decoration wastes the one place everyone looks
    // for "what is this file, and what version": there was no route to About
    // except a ⋯ menu nobody opens.
    const mark = el('button', 'sp-mark')
    ;(mark as HTMLButtonElement).type = 'button'
    mark.innerHTML =
      '<svg class="sp-mark-svg" viewBox="0 0 32 32" width="20" height="20" aria-hidden="true">' +
      '<rect width="32" height="32" rx="7" fill="#16273E"/>' +
      '<rect x="5" y="5" width="7" height="22" rx="2.5" fill="#5E7699"/>' +
      '<rect x="14" y="5" width="13" height="10" rx="2.5" fill="#FF9E8A"/>' +
      '<rect x="14" y="17" width="13" height="10" rx="2.5" fill="#F0EBE0"/>' +
      '</svg><b class="sp-mark-word">bento<span>/</span>spaces</b>'
    mark.title = t('About this space')
    mark.addEventListener('click', () => this.openAbout())

    // Pages panel toggle — on every width, like slides' Slides/Format toggles.
    // A sidebar you cannot put away is a sidebar you resent on a laptop.
    const pagesB = iconBtn('panelLeft', t('Pages — show or hide the page list'), () => this.toggleSidebar())
    pagesB.classList.add('sp-panel-toggle')

    const title = document.createElement('input')
    title.className = 'sp-doctitle'
    title.value = this.store.doc.title
    title.setAttribute('aria-label', t('Space name'))
    title.addEventListener('input', () => {
      this.store.runEdit('__title', () => { this.store.doc.title = title.value })
      document.title = `${title.value} — bento/spaces`
    })
    this.statusEl = el('span', 'sp-status')

    // insert — the block menu, reachable without knowing "/" exists
    const insert = this.dropdown('plus', t('Insert'), t('Insert a block — text, headings, lists, code, images'), (menu, close) => {
      for (const item of SLASH_ITEMS) {
        menu.append(this.menuItem(item.icon, t(item.label), t(item.hint), () => {
          close()
          const page = this.store.page
          if (!page) return
          const fresh = newBlock(item.type === 'pagelink' ? 'p' : item.type)
          SPEC.get(fresh.type)?.init?.(fresh)
          this.store.commit(() => { page.blocks.push(fresh) })
          this.paintPage()
          if (item.type === 'pagelink') this.insertPageCard(fresh.id)
          // the block is already a `link` — dismissing the dialog leaves an
          // empty card with its own way back in, never a half-made block
          else if (item.type === 'link') this.openLinkCard(fresh.id)
          else if (item.type === 'image') void this.pickImage(fresh.id)
          // a table has no block-level host to focus — the caret belongs in the
          // first cell, which is also where a person starts typing
          else if (item.type === 'table') this.focusCell(fresh.id, 0, 0)
          // straight to the picker, exactly like Image. Cancelling is not a
          // dead end: the block renders its own chooser (render.ts 'media'),
          // which is also the only route the / menu needs.
          else if (item.type === 'media') void this.pickMedia(fresh.id)
          else this.focusBlock(fresh.id)
        }))
      }
    })

    this.undoB = iconBtn('undo', t('Undo (⌘Z)'), () => { this.store.undo(); this.repaint() })
    this.redoB = iconBtn('redo', t('Redo (⇧⌘Z)'), () => { this.store.redo(); this.repaint() })
    const search = iconBtn('search', t('Search all pages (⌘K)'), () => this.openSearch())

    // WHERE A COMMAND LIVES. One rule, because the bar used to have none and it
    // showed: eight secondary buttons sat in the bar AND were repeated verbatim
    // in the ⋯ menu at the same time, so half of ⋯ pointed at things already on
    // screen. Print and Password each had two homes. About had three entry
    // points under two different names — all calling one dialog.
    //
    //   · The bar carries what you reach for WHILE WRITING.
    //   · ⋯ carries the rest, plus whatever the bar has had to drop.
    //   · Save ▾ is only about writing THIS file somewhere.
    //   · Nothing is listed in two places at the same width.
    //
    // The measurement that produced the fold still holds: at 375px the old bar
    // wanted 678px, so seven of eleven controls — Save included — sat off the
    // right edge. Below the breakpoint the inline copies hide and ⋯ picks them
    // up, one list feeding both, because a phone menu maintained by hand as a
    // copy of the desktop row drifts the first time either one changes.
    type BarAction = {
      icon: IconName
      label: string
      hint: string
      run: () => void
      keep?: (b: HTMLButtonElement) => void
    }

    // Reached while writing, so it stays in the bar until the bar runs out of
    // room. Reading view is a MODE — you leave and re-enter it while working,
    // and a mode you cannot see the state of is a mode you lose track of.
    const barActions: BarAction[] = [
      { icon: 'eye', label: t('Reading view'), hint: t('The pages without the editing tools'),
        run: () => this.toggleReading(),
        keep: (b) => { this.readB = b } },
    ]

    // Reached once a session or less. A button in the bar for something you do
    // once is a button in the way of everything you do constantly, so these
    // live in ⋯ at every width — findable, out of the road, and each with the
    // keyboard shortcut printed beside it.
    const menuActions: BarAction[] = [
      { icon: 'page', label: t('New page'), hint: '⌘⌥N', run: () => this.newPage() },
      { icon: 'book', label: t("Today's journal"), hint: '⌘⇧J', run: () => this.openJournal() },
      { icon: 'board', label: t('New issue'), hint: '⌘⇧I', run: () => this.newIssue() },
      { icon: 'tag', label: t('Make this page an issue'), hint: t('Adds status, priority, assignee, estimate'),
        run: () => this.makeIssue() },
      { icon: 'markdown', label: t('Import Markdown…'), hint: t('A folder of notes, or another space'),
        run: () => this.openImport() },
      { icon: 'graph', label: t('Graph'), hint: t('Every page, and what links to what'),
        run: () => this.openGraph() },
      { icon: 'print', label: t('Print or save as PDF'), hint: '⌘P', run: () => this.openPrint() },
      { icon: 'info', label: t('About this space'), hint: t('Version, language, password, exports'),
        run: () => this.openAbout() },
      // A help screen only reachable by pressing the key it documents is a
      // help screen for people who did not need it.
      { icon: 'help', label: t('Keyboard shortcuts'), hint: '?', run: () => this.openHelp() },
    ]

    const inlineSecondary = barActions.map((a) => {
      const b = iconBtn(a.icon, a.hint && a.hint.length < 12 ? `${a.label} (${a.hint})` : a.label, a.run)
      b.classList.add('sp-sec')
      a.keep?.(b)
      return b
    })

    const more = this.dropdown('more', '', t('More'), (menu, close) => {
      // On a PHONE the ⋯ menu also carries the history pair and the other ways
      // to save. Measured at 390px with a coarse pointer: eleven bar controls
      // wanted 467px of a 390px viewport, and Save — the one action that must
      // never be off-screen — ended at x = 426. Undo/redo (84px), the wordmark
      // (35px) and the save caret (48px) are what a phone gives up so that the
      // document title beside them is still wide enough to read. Nothing is
      // lost: they are all one tap away, here.
      // THE PROPERTIES PANEL, ONCE THE BAR HAS FOLDED. Its inline button is a
      // 40px control, and measured at 375px it took the document title from
      // 70px to 26px — a title nobody can read, to reach a panel that is one
      // more row in a menu that is already open. So below the fold it comes
      // here, the way undo/redo and the other ways to save already do.
      if (this.isFolded()) {
        menu.append(this.menuItem('panelRight', t('Properties'),
          t('This block’s settings, and the page’s'), () => {
            close(); this.toggleInsp()
          }))
      }
      if (this.isFolded()) {
        menu.append(this.menuItem('undo', t('Undo (⌘Z)'), '', () => {
          close(); this.store.undo(); this.repaint()
        }, { off: !this.store.canUndo }))
        menu.append(this.menuItem('redo', t('Redo (⇧⌘Z)'), '', () => {
          close(); this.store.redo(); this.repaint()
        }, { off: !this.store.canRedo }))
      }
      for (const a of menuActions) {
        menu.append(this.menuItem(a.icon, a.label, a.hint, () => { close(); a.run() }))
      }
      // …and only THEN what the bar itself has had to give up. Listing these
      // unconditionally is what made ⋯ a duplicate of the visible row.
      if (this.isFolded()) {
        for (const a of barActions) {
          menu.append(this.menuItem(a.icon, a.label, a.hint, () => { close(); a.run() }))
        }
      }
      if (this.isFolded()) {
        menu.append(this.menuItem('copy', t('Save a copy…'), t('A second file — the original is left alone'), () => {
          close(); void this.saveAs('copy')
        }))
        menu.append(this.menuItem('markdown', t('Export as Markdown…'), t('Every page, as one .md file'), () => {
          close(); this.exportMarkdown()
        }))
        menu.append(this.menuItem('page', t('Export page as a space…'), t('One page and what is under it, as its own file'), () => {
          close(); this.openExportSpace()
        }))
      }
    })
    more.classList.add('sp-more', 'sp-dd-end')

    // The live control sits BEFORE ⋯ and is replaced in place once the session
    // exists (connectSync). A placeholder rather than a conditional build, so
    // the bar's widths do not shift when a document turns out to be shared.
    this.liveSlot = el('span', 'sp-live-slot')

    // save is a split control, as in slides: the common action, and the
    // less-common ways of writing this document somewhere else
    const saveB = iconBtn('save', t('Save (⌘S)'), () => this.onSave?.())
    saveB.classList.add('sp-primary')
    const saveLabel = document.createElement('span')
    saveLabel.className = 'sp-savelabel'
    saveLabel.textContent = t('Save')
    saveB.append(saveLabel)
    // The unsaved dot lives ON Save, as in slides: the place you look to find
    // out whether you need to press it is the button itself.
    this.dirtyDot = el('span', 'sp-dirty')
    this.dirtyDot.title = canWriteInPlace()
      ? t('Unsaved changes — ⌘S rewrites this file')
      : t('Unsaved changes — ⌘S downloads an updated copy')
    saveB.append(this.dirtyDot)
    const saveMore = this.dropdown('chevronDown', '', t('Other ways to save'), (menu, close) => {
      menu.append(this.menuItem('copy', t('Save a copy…'), t('A second file — the original is left alone'), () => {
        close(); void this.saveAs('copy')
      }))
      menu.append(this.menuItem('markdown', t('Export as Markdown…'), t('Every page, as one .md file'), () => {
        close(); this.exportMarkdown()
      }))
      menu.append(this.menuItem('page', t('Export page as a space…'), t('One page and what is under it, as its own file'), () => {
        close(); this.openExportSpace()
      }))
    })
    saveMore.classList.add('sp-caret', 'sp-dd-end')

    // LEFT = the document (mark · title · save state · history), RIGHT = doing
    // things with it. Same grouping as slides, so the two apps do not teach two
    // different toolbars.
    const history = el('div', 'sp-group sp-group-history')
    history.append(this.undoB, this.redoB)
    const saveGroup = el('div', 'sp-split')
    saveGroup.append(saveB, saveMore)
    const inspB = iconBtn('panelRight', t('Properties — show or hide this block’s settings'),
      () => this.toggleInsp())
    inspB.classList.add('sp-insp-toggle')

    const right = el('div', 'sp-group sp-group-right')
    right.append(insert, search, ...inlineSecondary, inspB, this.liveSlot, more, saveGroup)

    // The status goes AFTER undo/redo, never before. It is transient text that
    // grows from nothing to a whole sentence, and anything downstream of it in
    // the flex flow gets shoved sideways every time it changes — measured at
    // 36px on a plain edit and 246px entering reading view, which is more than
    // a button's width, so undo lands where redo just was. Past the history
    // group it grows into the slack the right group's margin-auto already
    // holds, and nothing before it can move. Reported against slides as #300.
    bar.append(pagesB, mark, title, history, this.statusEl, right)

    // Drive the fit now, and again whenever the bar's size or its CONTENT
    // changes. The ResizeObserver is the primary width signal — it fires for
    // every viewport change, including a phone rotating, where matchMedia
    // change events are unreliable under a driven viewport. The MutationObserver
    // catches the constant-width case: the people count appearing when someone
    // joins, the "Saved" tag flashing, the update chip arriving. Each of those
    // clipped the end of the bar under the old breakpoints.
    this.topbar = bar
    this.barRO?.disconnect()
    this.barRO = new ResizeObserver(() => this.fitTopbar())
    this.barRO.observe(bar)
    this.barMO?.disconnect()
    this.barMO = new MutationObserver(() => this.fitTopbar())
    this.barMO.observe(bar, {
      childList: true, subtree: true, characterData: true,
      // NOT 'class': fitTopbar's own tier flips are class changes on this very
      // element, and observing them makes the fix for the loop (takeRecords)
      // the only thing standing between here and a spin. Slides omits it for
      // the same reason.
      attributes: true, attributeFilter: ['style', 'hidden'],
    })
    // …and once the bar is actually in the document and has a width to measure
    queueMicrotask(() => this.fitTopbar())

    this.sidebar = el('nav', 'sp-side')
    this.sidebar.setAttribute('aria-label', t('Pages'))
    this.main = el('main', 'sp-main')

    this.inspector = el('aside', 'sp-insp')
    this.inspector.setAttribute('aria-label', t('Properties'))
    if (this.inspClosed) this.inspector.classList.add('sp-pane-closed')

    const body = el('div', 'sp-body')
    body.append(this.sidebar, this.makeResizer(), this.main, this.makeInspResizer(), this.inspector)
    this.root.append(bar, body)
    this.applyPaneWidth()
    this.syncPaneChevron()
    this.applyInspWidth()
    this.syncInspChevron()

    // WHICH BLOCK THE PANEL MEANS. Capture-phase on the page, because the
    // interesting blocks are the ones with no editable host to focus — a table,
    // an image, a clip, a card. `focusin` alone would answer for text and stay
    // silent for exactly the types that have settings worth a panel.
    //
    // `mousedown` rather than `pointerdown`: a real click fires both, so the
    // two are the same to a user, but only the mouse event is reliably what a
    // driven click produces — CLAUDE.md's testing note records the same wall in
    // slides, where synthetic pointer events never reach Gesto. Choosing the
    // one both a hand and a rig emit costs nothing.
    for (const ev of ['focusin', 'mousedown'] as const) {
      this.main.addEventListener(ev, (e: Event) => {
        const n = e.target as Node | null
        const host = (n instanceof HTMLElement ? n : n?.parentElement)
          ?.closest<HTMLElement>('[data-block-id]')
        this.inspOn = host?.dataset.blockId ?? null
        this.props?.retarget()
      }, true)
    }

    this.paintTree()
    this.paintPage()
    this.syncHistoryButtons()
    this.syncDirty()
    document.addEventListener('keydown', (e) => this.onKey(e), true)

    // Dropping notes anywhere on the app imports them — the sidebar, the
    // topbar, the grey around the page. The page's own drop handler takes
    // images and stands down for markdown, so the two never both fire.
    this.root.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    })
    this.root.addEventListener('drop', (e) => {
      if (!isImportDrop(e.dataTransfer)) return
      e.preventDefault()
      const picked = collectDrop(e.dataTransfer)
      void picked.then((files) => this.importFiles(files))
    })
  }

  /**
   * Reading view.
   *
   * Not a separate renderer — the SAME renderer with `editable` off, so what a
   * reader sees is what an editor sees minus the machinery. A second read-only
   * renderer would drift, and the drift would only show up in the view nobody
   * develops in.
   *
   * It is a VIEW, never a document state: nothing about it is written to the
   * file, so a space does not arrive locked because its author was reading when
   * they saved.
   */
  private toggleReading(force?: boolean): void {
    this.reading = force ?? !this.reading
    this.root.classList.toggle('sp-reading', this.reading)
    this.readB?.classList.toggle('sp-on', this.reading)
    this.readB?.setAttribute('aria-pressed', String(this.reading))
    document.querySelector('.sp-findbar')?.remove()
    this.paintPage()
    this.props?.refresh()
    this.status(this.reading ? t('Reading view — press Esc or the eye to edit') : t('Editing'))
  }

  /** Undo/redo must LOOK unavailable when they are, or they read as broken. */
  /** The dot on Save, and the only place the file's state is visible. */
  syncDirty(): void {
    this.dirtyDot?.classList.toggle('sp-on', this.store.dirty)
  }

  private syncHistoryButtons(): void {
    if (this.undoB) this.undoB.disabled = !this.store.canUndo
    if (this.redoB) this.redoB.disabled = !this.store.canRedo
  }

  /** A topbar dropdown: button + menu, closed by choosing, Esc, or clicking away. */
  private dropdown(
    icon: IconName, label: string, tip: string,
    fill: (menu: HTMLElement, close: () => void) => void,
  ): HTMLElement {
    const wrap = el('div', 'sp-dd')
    const b = document.createElement('button')
    b.className = 'sp-btn'
    b.type = 'button'
    b.innerHTML = ICONS[icon]
    // The word is a SPAN, not a bare text node, so a narrow bar can drop it and
    // keep the icon — slides' rule, and the only way to collapse a labelled
    // control without also losing it.
    if (label) b.append(el('span', 'sp-btnlabel', label))
    b.title = tip
    b.setAttribute('aria-label', tip)
    b.setAttribute('aria-haspopup', 'menu')
    const menu = el('div', 'sp-ddmenu')
    menu.setAttribute('role', 'menu')
    const close = () => { wrap.classList.remove('sp-open'); b.setAttribute('aria-expanded', 'false') }
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const open = !wrap.classList.contains('sp-open')
      for (const other of document.querySelectorAll('.sp-dd.sp-open')) other.classList.remove('sp-open')
      wrap.classList.toggle('sp-open', open)
      b.setAttribute('aria-expanded', String(open))
      if (open) { menu.innerHTML = ''; fill(menu, close) }
    })
    document.addEventListener('click', close)
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
    wrap.append(b, menu)
    return wrap
  }

  /**
   * One row in a dropdown menu.
   *
   * `state` carries BOTH meanings the menus need, because they arrived from
   * two directions and mean different things: `off` is a command that exists
   * but cannot run right now (folded undo/redo on a phone — disabled, not
   * hidden, so the menu does not change shape as you edit), and `selected` is
   * the choice a view is currently on (layout, group-by, sort). A row can be
   * neither; nothing yet is both. They were separate 5th parameters on two
   * branches, which is exactly the collision an options object avoids.
   */
  private menuItem(
    icon: IconName,
    label: string,
    hint: string,
    onClick: () => void,
    state: { off?: boolean; selected?: boolean } = {},
  ): HTMLElement {
    const b = document.createElement('button')
    b.className = 'sp-dditem' + (state.off ? ' sp-off' : '') + (state.selected ? ' sp-sel' : '')
    b.type = 'button'
    if (state.off) b.setAttribute('aria-disabled', 'true')
    if (state.selected) b.setAttribute('aria-current', 'true')
    b.setAttribute('role', 'menuitem')
    b.innerHTML = `<span class="sp-result-ico">${ICONS[icon]}</span>` +
      `<span class="sp-result-txt"><strong>${escapeHtml(label)}</strong>` +
      (hint ? `<span>${escapeHtml(hint)}</span>` : '') + `</span>`
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick() })
    return b
  }

  /** Open/close the page drawer on narrow screens, with a scrim to tap away. */
  /**
   * The strip between the page list and the page: drag to resize, chevron to
   * collapse, double-click to reset. Slides' pattern, and its reasoning — the
   * control that hides a panel belongs ON the panel's edge, where you are
   * already looking, not in a toolbar across the room.
   *
   * The width is the reader's, so it lives in localStorage, never the document.
   */
  private makeResizer(): HTMLElement {
    const handle = el('div', 'sp-resizer')
    handle.title = t('Drag to resize · double-click to reset')

    const tab = document.createElement('button')
    tab.className = 'sp-pane-tab'
    tab.type = 'button'
    tab.addEventListener('click', (e) => { e.stopPropagation(); this.togglePane() })
    this.paneTab = tab
    handle.append(tab)

    handle.addEventListener('mousedown', (down) => {
      if (down.target === tab) return          // the chevron is a click, not a drag
      if (this.paneClosed) return
      down.preventDefault()
      const startX = down.clientX
      const startW = this.paneW
      this.sidebar.classList.add('sp-noanim')
      document.body.classList.add('sp-col-resizing')
      const move = (ev: MouseEvent) => {
        // clientX is physical; which way widens depends on the edge the panel
        // is docked to, and RTL swaps that over.
        const dx = ev.clientX - startX
        const widens = document.dir === 'rtl' ? -dx : dx
        this.paneW = Math.min(Editor.PANE_MAX, Math.max(Editor.PANE_MIN, startW + widens))
        this.applyPaneWidth()
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        this.sidebar.classList.remove('sp-noanim')
        document.body.classList.remove('sp-col-resizing')
        try { localStorage.setItem('bento-sp-pane', String(this.paneW)) } catch { /* storage can throw */ }
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })

    handle.addEventListener('dblclick', () => {
      this.paneW = Editor.PANE_DEFAULT
      this.applyPaneWidth()
      try { localStorage.setItem('bento-sp-pane', String(this.paneW)) } catch { /* storage can throw */ }
    })
    return handle
  }

  private applyPaneWidth(): void {
    this.sidebar.style.setProperty('--sp-panew', `${this.paneW}px`)
  }

  /**
   * The properties panel's edge — the page list's strip, mirrored.
   *
   * Deliberately a second small method rather than a parameterised one: the two
   * differ in which direction widens (the panel is docked to the END edge, so a
   * drag toward the start makes it bigger) and in which way the chevron points,
   * and a `side` flag threaded through both would be harder to read than this.
   */
  private makeInspResizer(): HTMLElement {
    const handle = el('div', 'sp-resizer sp-insp-rz')
    handle.title = t('Drag to resize · double-click to reset')
    if (this.inspClosed) handle.classList.add('sp-shut')
    this.inspRz = handle

    const tab = document.createElement('button')
    tab.className = 'sp-pane-tab'
    tab.type = 'button'
    tab.addEventListener('click', (e) => { e.stopPropagation(); this.toggleInsp() })
    this.inspTab = tab
    handle.append(tab)

    handle.addEventListener('mousedown', (down) => {
      if (down.target === tab) return
      if (this.inspClosed) return
      down.preventDefault()
      const startX = down.clientX
      const startW = this.inspW
      this.inspector.classList.add('sp-noanim')
      document.body.classList.add('sp-col-resizing')
      const move = (ev: MouseEvent) => {
        // the panel is on the END edge, so dragging toward the START widens it
        const dx = startX - ev.clientX
        const widens = document.dir === 'rtl' ? -dx : dx
        this.inspW = Math.min(Editor.INSP_MAX, Math.max(Editor.INSP_MIN, startW + widens))
        this.applyInspWidth()
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        this.inspector.classList.remove('sp-noanim')
        document.body.classList.remove('sp-col-resizing')
        try { localStorage.setItem('bento-sp-insp', String(this.inspW)) } catch { /* storage can throw */ }
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })

    handle.addEventListener('dblclick', () => {
      this.inspW = Editor.INSP_DEFAULT
      this.applyInspWidth()
      try { localStorage.setItem('bento-sp-insp', String(this.inspW)) } catch { /* storage can throw */ }
    })
    return handle
  }

  private applyInspWidth(): void {
    this.inspector.style.setProperty('--sp-inspw', `${this.inspW}px`)
  }

  private syncInspChevron(): void {
    if (!this.inspTab) return
    const rtl = document.dir === 'rtl'
    // points the way it will MOVE the panel
    const closing = this.inspClosed === rtl
    this.inspTab.innerHTML = closing ? ICONS.chevronRight : ICONS.chevronLeft
    this.inspTab.title = this.inspClosed ? t('Show properties (])') : t('Hide properties (])')
    this.inspTab.setAttribute('aria-label', this.inspTab.title)
    this.inspTab.setAttribute('aria-expanded', String(!this.inspClosed))
  }

  /** Collapse or restore the properties panel. On a phone it is an overlay. */
  toggleInsp(force?: boolean): void {
    if (this.isDrawer()) {
      const open = force !== undefined ? force : !this.inspector.classList.contains('sp-open')
      this.inspector.classList.toggle('sp-open', open)
      // The same scrim the page list gets, for the same reason: an overlay you
      // can only close from the menu you opened it from is one people leave
      // open over the page they wanted to read.
      document.querySelector('.sp-scrim')?.remove()
      if (open) {
        const scrim = el('div', 'sp-scrim')
        scrim.addEventListener('click', () => this.toggleInsp(false))
        document.body.append(scrim)
      }
      return
    }
    this.inspector.classList.remove('sp-open')
    this.inspClosed = force !== undefined ? !force : !this.inspClosed
    this.inspector.classList.toggle('sp-pane-closed', this.inspClosed)
    this.inspRz?.classList.toggle('sp-shut', this.inspClosed)
    this.syncInspChevron()
    // '0' means OPEN. Absent is closed, which is what a reader who has never
    // touched this gets — see the constructor.
    try { localStorage.setItem('bento-sp-insp-closed', this.inspClosed ? '1' : '0') } catch { /* storage can throw */ }
  }

  private syncPaneChevron(): void {
    if (!this.paneTab) return
    // points the way it will MOVE the panel, which is the only thing a chevron
    // can usefully mean
    const rtl = document.dir === 'rtl'
    const closing = this.paneClosed !== rtl
    this.paneTab.innerHTML = closing ? ICONS.chevronRight : ICONS.chevronLeft
    this.paneTab.title = this.paneClosed ? t('Show the page list ([)') : t('Hide the page list ([)')
    this.paneTab.setAttribute('aria-label', this.paneTab.title)
    this.paneTab.setAttribute('aria-expanded', String(!this.paneClosed))
  }

  /** Collapse or restore the page list. On a phone it is a drawer instead. */
  togglePane(force?: boolean): void {
    if (this.isDrawer()) { this.toggleSidebar(force); return }
    this.paneClosed = force !== undefined ? !force : !this.paneClosed
    this.sidebar.classList.toggle('sp-pane-closed', this.paneClosed)
    this.syncPaneChevron()
    try { localStorage.setItem('bento-sp-pane-closed', this.paneClosed ? '1' : '0') } catch { /* storage can throw */ }
  }

  private isDrawer(): boolean {
    return window.matchMedia('(max-width: 820px)').matches
  }

  /**
   * Has the bar FOLDED — are undo/redo and the save caret currently inside ⋯
   * rather than in the bar?
   *
   * This used to be `matchMedia('(max-width: 600px)')`, with a comment saying
   * the number was duplicated from the stylesheet on purpose. It is not needed
   * at all now: fitTopbar puts the tier on the bar as a class, so the menu can
   * ASK what is on screen instead of re-deriving it from a width and hoping
   * the two agree. When they disagreed the symptom was a menu offering Undo
   * while Undo sat in the bar two centimetres away.
   */
  private isFolded(): boolean {
    return !!this.topbar?.classList.contains('sp-bar-fold')
  }

  /**
   * Size the topbar by MEASURING it, not by width breakpoints.
   *
   * A px guess cannot answer the question being asked. The same buttons need
   * different room at the same viewport width depending on browser zoom, OS
   * text scaling, and how long the labels are in the reader's language — eight
   * catalogs ship inside every file, and "Insert" is 76px in English and
   * nothing like that in German. The bar's own CONTENT changes width too, at a
   * fixed viewport: the people count appears when somebody joins a session.
   * Each of those cases clipped the end of the bar under the old 820/600
   * breakpoints. Slides settled this first (#239); this is its pattern.
   *
   * Start from the widest layout, step down a tier while the bar still
   * overflows its own box.
   */
  private fitTopbar(): void {
    const bar = this.topbar
    if (!bar || !bar.isConnected) return
    const tiers = ['sp-bar-compact', 'sp-bar-tight', 'sp-bar-fold']
    // Re-fitting starts by UNFOLDING, which would slam shut a menu somebody is
    // reading — and the ⋯ menu's contents depend on the tier, so rebuilding it
    // mid-read would change it under them. The next resize runs this again.
    if (this.overlay) return
    // scrollWidth counts content sticking out of the padding box even with
    // overflow visible, so this IS the clipped-controls condition. 1px of
    // slack absorbs subpixel rounding at fractional zoom.
    const overflow = () => bar.scrollWidth - bar.clientWidth > 1
    // The title is the only shrinkable thing in the bar, so flexbox crushes it
    // toward its floor before anything overflows. Waiting for hard overflow
    // would mean full labels beside an unreadable document title.
    const title = bar.querySelector<HTMLElement>('.sp-doctitle')
    const cramped = () => overflow() || (!!title && title.getBoundingClientRect().width < 110)
    bar.classList.remove(...tiers)
    if (cramped()) bar.classList.add('sp-bar-compact')
    if (cramped()) bar.classList.add('sp-bar-tight')
    if (cramped()) bar.classList.add('sp-bar-fold')
    // the class flips above queued mutation records of their own; drop them,
    // or the observer re-runs this forever
    this.barMO?.takeRecords()
  }

  /**
   * Dismiss the PHONE DRAWER after navigating. On anything wider this does
   * nothing, deliberately.
   *
   * Following a page link used to call `toggleSidebar(false)` directly, which
   * reads as "close the sidebar" and is right on a phone — the drawer covers
   * the page you just asked for. But above the drawer breakpoint
   * `toggleSidebar` delegates to `togglePane`, so on a desktop it collapsed the
   * page-list COLUMN on every click, and `togglePane` persists that to
   * localStorage: the list stayed shut on the next open, and on every open
   * after it. The column is not in the way of anything, and a list you have to
   * reopen to use twice is not a list.
   */
  private closeDrawer(): void {
    if (this.isDrawer()) this.toggleSidebar(false)
  }

  private toggleSidebar(force?: boolean): void {
    // Below the drawer breakpoint the panel is an overlay, not a column: the
    // page needs the whole width, so collapsing to a 0px column would leave
    // nothing to reopen it from.
    if (!this.isDrawer()) { this.togglePane(force); return }
    const open = force ?? !this.sidebar.classList.contains('sp-open')
    this.sidebar.classList.toggle('sp-open', open)
    document.querySelector('.sp-scrim')?.remove()
    if (open) {
      const scrim = el('div', 'sp-scrim')
      scrim.addEventListener('click', () => this.toggleSidebar(false))
      document.body.append(scrim)
    }
  }

  /**
   * Bind the live session to the UI.
   *
   * Called once from main.ts with the session that already exists — the
   * session is constructed whether or not anyone shares, because two tabs of
   * one file sync locally regardless; what this adds is the ability to SEE it.
   */
  connectSync(session: import('./sync/session.ts').SyncSession): void {
    const { CollabUi } = collabUi
    this.session = session
    this.collab = new CollabUi({
      store: this.store,
      session,
      status: (m) => this.status(m),
      paintTree: () => this.paintTree(),
      popover: (anchor, build) => this.popover(anchor, (pop) => build(pop, () => this.closeOverlay())),
      goToPage: (id) => { this.store.goToPage(id); this.closeDrawer() },
      shareCopy: (kind) => { void this.shareCopy(kind) },
      goLive: () => this.goLive(),
    })
    session.onPeers(() => this.collab?.onPeersChanged())
    // The relay refuses things the user can act on — too large, room full. For
    // the permanent codes their change stays in this copy and reaches nobody,
    // which they must be told rather than left to discover.
    session.onNotice((n) => this.status(syncNoticeText(n)))
    this.collab.tryJoin()
    // a document REPLACED under us (Replace-from-JSON, a restored version) may
    // be a different document with different credentials
    this.store.on('doc', () => this.collab?.tryJoin())
    if (this.liveSlot) this.liveSlot.replaceWith(this.collab.button())
  }

  status(msg: string): void {
    this.statusEl.textContent = msg
    this.statusEl.classList.add('sp-on')
    clearTimeout((this.statusEl as any)._t)
    ;(this.statusEl as any)._t = setTimeout(() => {
      this.statusEl.classList.remove('sp-on')
      // The word must LEAVE the bar, not just fade out of it. This span is
      // nowrap, so once "Edited" had been written once it held ~40px of the
      // topbar for the rest of the session — and on a phone that width came
      // out of the controls beside it. Cleared after the fade, never during.
      setTimeout(() => {
        if (!this.statusEl.classList.contains('sp-on')) this.statusEl.textContent = ''
      }, 260)
    }, 1800)
  }

  // ---- the page tree ------------------------------------------------------
  private paintTree(): void {
    const s = this.store
    this.sidebar.innerHTML = ''
    const head = el('div', 'sp-side-head')
    head.append(el('span', 'sp-side-title', t('Pages')))
    // Import used to sit here, beside "new page", on the reasoning that the
    // moment somebody wants it is the moment they see an empty sidebar next to
    // a folder of notes. Two things undid that: a fresh space is not empty any
    // more (the starter fills it), and About now has a "Bring notes in"
    // section beside the ways out — so this was a second copy of a control, in
    // the header of the page LIST, reading as a way to add a page. It lives
    // with the other secondary actions instead, which puts it in the ⋯ menu on
    // a phone from one list rather than two. Dropping a folder on the window
    // still works and is how most people will actually find it.
    head.append(iconBtn('plus', t('New page (⌘⌥N)'), () => this.newPage()))
    this.sidebar.append(head)

    const list = el('ul', 'sp-tree')
    for (const { page, depth } of s.tree()) {
      if (page.archived) continue
      const li = document.createElement('li')
      li.style.paddingInlineStart = `${depth * 14}px`
      const a = document.createElement('a')
      a.href = `#p/${page.id}`
      const here = page.id === s.pageId
      a.className = 'sp-treelink' + (here ? ' sp-here' : '')
      // WEIGHT IS NOT AN ANNOUNCEMENT. sp-here says "you are here" in 600
      // against 400, which a sighted reader gets for free and a screen reader
      // is told nothing about — the tree reads as a flat list of links with no
      // indication of which one you are on. aria-current is the one attribute
      // that carries it.
      if (here) a.setAttribute('aria-current', 'page')
      const ico = el('span', 'sp-tree-ico')
      ico.innerHTML = pageIcon(page.icon)
      const label = document.createElement('span')
      label.textContent = this.pageLabel(page)
      a.append(ico, label)
      // who else is reading this page. A space is a TREE, so "where is
      // everyone" is a question about pages, not about carets — this is the
      // spaces answer to the cursors slides paints on its canvas.
      const dots = this.collab?.dotsFor(page.id)
      if (dots) a.append(dots)
      // Unresolved threads badge the page they are on: the tree is the only
      // place you can see that another page is waiting on you.
      const badge = commentBadge(unresolvedOn(page))
      if (badge) a.append(badge)
      a.draggable = true
      a.addEventListener('click', (e) => { e.preventDefault(); s.goToPage(page.id); this.closeDrawer() })
      a.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/bento-page', page.id))
      a.addEventListener('dragover', (e) => {
        // a sidebar row accepts PAGES; a card dragged over it lit up and
        // promised a nesting it would never perform
        if (!e.dataTransfer?.types.includes('text/bento-page')) return
        e.preventDefault(); a.classList.add('sp-drop')
      })
      a.addEventListener('dragleave', () => a.classList.remove('sp-drop'))
      a.addEventListener('drop', (e) => {
        e.preventDefault(); a.classList.remove('sp-drop')
        const moved = e.dataTransfer?.getData('text/bento-page')
        if (moved && moved !== page.id) this.reparentPage(moved, page.id)
      })
      const more = document.createElement('button')
      more.className = 'sp-rowmore'
      more.type = 'button'
      more.innerHTML = ICONS.more
      more.title = t('Page options')
      more.setAttribute('aria-label', t('Page options'))
      more.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.openPageMenu(page.id, more) })
      a.append(more)

      li.append(a)
      list.append(li)
    }
    if (!list.childElementCount) list.append(el('li', 'sp-side-empty', t('No pages yet')))
    this.sidebar.append(list)

    // Archived pages are OUT OF THE WAY, never invisible: they are still
    // searchable and linkable, and someone about to share the file needs to be
    // able to see what is going with it.
    const archived = s.doc.pages.filter((p) => p.archived)
    if (archived.length) {
      const det = document.createElement('details')
      det.className = 'sp-archived'
      const sum = document.createElement('summary')
      sum.textContent = t('Archived ({n})', { n: archived.length })
      det.append(sum)
      const al = el('ul', 'sp-tree')
      for (const page of archived) {
        const li = document.createElement('li')
        const a = document.createElement('a')
        a.href = `#p/${page.id}`
        const hereA = page.id === s.pageId
        a.className = 'sp-treelink sp-arch-row' + (hereA ? ' sp-here' : '')
        if (hereA) a.setAttribute('aria-current', 'page')
        const ico = el('span', 'sp-tree-ico')
        ico.innerHTML = pageIcon(page.icon)
        const label = document.createElement('span')
        label.textContent = this.pageLabel(page)
        a.append(ico, label)
        a.addEventListener('click', (e) => { e.preventDefault(); s.goToPage(page.id); this.closeDrawer() })
        const un = document.createElement('button')
        un.className = 'sp-rowmore'
        un.type = 'button'
        un.innerHTML = ICONS.unarchive
        un.title = t('Restore to the page list')
        un.setAttribute('aria-label', t('Restore to the page list'))
        un.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation()
          s.commit(() => { const p = s.index.page.get(page.id); if (p) delete p.archived })
        })
        a.append(un)
        li.append(a)
        al.append(li)
      }
      det.append(al)
      this.sidebar.append(det)
    }

    // dropping on the empty area below the tree makes a page top-level again
    list.addEventListener('dragover', (e) => e.preventDefault())
    this.sidebar.addEventListener('drop', (e) => {
      if ((e.target as HTMLElement).closest('.sp-treelink')) return
      e.preventDefault()
      const moved = e.dataTransfer?.getData('text/bento-page')
      if (moved) this.reparentPage(moved, '')
    })
  }

  /** Re-parent a page, refusing a move that would make it its own ancestor. */
  private reparentPage(id: string, parent: string): void {
    if (id === parent) return
    for (let p: string | undefined = parent; p; p = this.store.index.page.get(p)?.parent) {
      if (p === id) { this.status(t('A page cannot contain itself')); return }
    }
    this.store.commit(() => {
      const page = this.store.index.page.get(id)
      if (!page) return
      if (parent) page.parent = parent
      else delete page.parent
    })
  }

  /**
   * The reader's own name for a page.
   *
   * An entry stores its title as the ISO date — locale-neutral in the file, the
   * same for every reader, and what search and the Markdown export see. The
   * SIDEBAR shows it in the reader's own format, because "2026-08-06" is a key
   * and "Thu 6 Aug" is a date. An entry the author has RENAMED keeps its name:
   * the rename was the point.
   */
  pageLabel(page: { title: string; journal?: unknown }): string {
    if (isJournal(page as never) && page.title === page.journal) {
      return journalShort(String(page.journal), locale())
    }
    return page.title || t('Untitled')
  }

  /**
   * Open a day's entry, creating it if this is the first note of the day.
   *
   * ONE COMMIT for the whole plan (the Journal page and the entry, when both
   * are new), so ⌘Z takes back "I opened today's journal" in a single step
   * rather than leaving a stray empty parent behind.
   */
  openJournal(iso = todayISO()): void {
    const s = this.store
    if (s.readOnly) return
    const plan = planJournal(s.doc, iso)
    if (plan.add.length) {
      s.commit(() => {
        for (const { page, after } of plan.add) {
          const at = after ? s.doc.pages.findIndex((p) => p.id === after) : -1
          if (at >= 0) s.doc.pages.splice(at + 1, 0, page)
          else s.doc.pages.push(page)
        }
      })
    }
    s.goToPage(plan.page.id)
    this.status(journalLabel(iso, locale()))
  }

  /** The day before or after the entry in view. */
  stepJournal(n: number): void {
    const cur = this.store.page
    if (!cur || !isJournal(cur)) return
    this.openJournal(stepDay(String(cur.journal), n))
  }

  newPage(parent?: string): void {
    const page = newPage(t('Untitled'))
    if (parent) page.parent = parent
    this.store.commit(() => { this.store.doc.pages.push(page) })
    this.store.goToPage(page.id)
    afterPaint(() => {
      const h = this.main.querySelector<HTMLElement>('[data-page-title]')
      h?.focus()
      if (h) selectAll(h)
    })
  }

  // ---- the page -----------------------------------------------------------
  private paintPage(): void {
    const s = this.store
    const page = s.page
    // The bar holds a reference to the block host it is floating over, and this
    // is about to replace every one of them.
    this.format?.close()
    this.main.innerHTML = ''
    if (!page) { this.main.append(el('p', 'sp-empty', t('This space has no pages.'))); return }

    this.painting = true
    const trail: string[] = []
    for (let p = page.parent; p; p = s.index.page.get(p)?.parent) {
      const owner = s.index.page.get(p)
      if (!owner) break
      trail.unshift(owner.id)
      if (trail.length > 4) break
    }
    const view = renderPage(page, s.doc, {
      editable: !s.readOnly && !this.reading,
      titleOf: (id) => s.index.page.get(id)?.title,
      allowRemote: (src) => this.allowedRemote.has(src),
      readerWidth: readerWidth(),
    })
    // the icon lives beside the title, where changing it is discoverable
    const inner = view.querySelector('.sp-page-inner')
    if (inner && !s.readOnly && !this.reading) {
      const pick = document.createElement('button')
      pick.className = 'sp-pageicon'
      pick.type = 'button'
      pick.innerHTML = pageIcon(page.icon)
      pick.title = t('Change this page\'s icon')
      pick.setAttribute('aria-label', t('Change this page\'s icon'))
      pick.addEventListener('click', () => this.openIconPicker(page.id, pick))
      inner.prepend(pick)
    }

    // A DAY HAS A DAY EITHER SIDE OF IT. Without this, reaching yesterday means
    // finding it in the sidebar, which is the one navigation a journal should
    // never need. The strip carries the reader's own long-form date because the
    // title above it is the ISO key, and a date nobody can read at a glance is
    // not much of a journal.
    if (inner && isJournal(page)) {
      const iso = String(page.journal)
      const nav = el('div', 'sp-jnav')
      const step = (n: number, glyph: string, title: string) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'sp-jstep'
        b.textContent = glyph
        b.title = title
        b.setAttribute('aria-label', title)
        b.addEventListener('click', () => this.stepJournal(n))
        return b
      }
      nav.append(step(-1, '‹', t('The day before')), step(1, '›', t('The day after')))
      if (iso !== todayISO()) {
        const today = document.createElement('button')
        today.type = 'button'
        today.className = 'sp-jstep sp-jtoday'
        today.textContent = t('Today')
        today.addEventListener('click', () => this.openJournal())
        nav.append(today)
      }
      inner.prepend(nav)

      // THE HEADING READS AS A DATE, not as a key. The title is stored as the
      // ISO string so the file is locale-neutral and sorts — but "2026-08-01"
      // as a page's own H1 is a filename, not a day.
      //
      // Slides solves the same shape for dynamic fields by swapping the RAW
      // token back while editing, and that is deliberately NOT copied here: a
      // `{{page}}` token is something the author means to keep, whereas an ISO
      // date is a key nobody wants to type. Someone renaming an entry starts
      // from the date they can read and appends to it — which is the rename
      // they were going to make anyway. The date itself lives in `journal` and
      // is untouched by any of it, so a renamed entry is still that day's.
      const h = inner.querySelector<HTMLElement>('[data-page-title]')
      if (h && page.title === iso) h.textContent = journalLabel(iso, locale())
    }

    if (trail.length) {
      const crumb = el('nav', 'sp-crumb')
      crumb.setAttribute('aria-label', t('Breadcrumb'))
      trail.forEach((id, i) => {
        if (i) crumb.append(Object.assign(document.createElement('span'), { textContent: '›' }))
        const a = document.createElement('a')
        a.href = `#p/${id}`
        a.textContent = s.index.page.get(id)?.title || t('Untitled')
        a.addEventListener('click', (e) => { e.preventDefault(); s.goToPage(id) })
        crumb.append(a)
      })
      view.querySelector('.sp-page-inner')?.prepend(crumb)
    }
    this.main.append(view)
    this.wire(view)
    view.querySelector('.sp-page-inner')?.append(this.backlinks(page.id))
    // Comments are EDITOR-ONLY. The gate is here rather than in comments.ts
    // because this is the object that knows which view it is in — and the
    // renderer, which print and the reading view share, has never heard of
    // them at all.
    if (!this.reading) this.comments?.refresh()
    this.painting = false
  }

  /**
   * The hover gutter.
   *
   * A block editor with no visible affordances is a guessing game: nothing on
   * screen says a block can be moved or that a new one can go here. These sit
   * OUTSIDE the text column so they never reflow the prose, and only appear on
   * hover so a page at rest is just the writing.
   */
  private addGutter(node: HTMLElement, blockId: string): void {
    const g = el('div', 'sp-gutter')
    const add = document.createElement('button')
    // Named, because a phone drops it: there is only room for ONE control in a
    // 44px margin, and "Add below" is the second item of the grip's own menu.
    add.className = 'sp-ghost sp-ghost-add'
    add.type = 'button'
    add.innerHTML = ICONS.plus
    add.title = t('Add a block below')
    add.setAttribute('aria-label', t('Add a block below'))
    add.addEventListener('click', () => this.insertAfter(blockId))

    const grip = document.createElement('button')
    grip.className = 'sp-ghost'
    grip.type = 'button'
    grip.draggable = true
    grip.innerHTML = ICONS.grip
    grip.title = t('Drag to move, click for block options')
    grip.setAttribute('aria-label', t('Block options'))
    grip.addEventListener('click', () => this.openBlockMenu(blockId, grip))
    grip.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/bento-block', blockId)
      node.classList.add('sp-dragging')
    })
    grip.addEventListener('dragend', () => node.classList.remove('sp-dragging'))

    node.addEventListener('dragover', (e) => {
      // ONLY a block drag. A view block is a block node, so an issue card
      // dragged across the board lit the blue "block moves here" bar under the
      // whole view at the same time as the column's outline — two things
      // claiming one drop, from different owners. The payload says which
      // gesture this is; ask it.
      if (!e.dataTransfer?.types.includes('text/bento-block')) return
      e.preventDefault()
      node.classList.add('sp-dropline')
    })
    node.addEventListener('dragleave', () => node.classList.remove('sp-dropline'))
    node.addEventListener('drop', (e) => {
      e.preventDefault()
      node.classList.remove('sp-dropline')
      const moved = e.dataTransfer?.getData('text/bento-block')
      if (moved && moved !== blockId) this.moveBlock(moved, blockId)
    })

    g.append(add, grip)
    node.prepend(g)
  }

  private insertAfter(blockId: string): void {
    const s = this.store
    const page = s.page
    if (!page) return
    const fresh = newBlock('p')
    const owner = s.block(blockId)
    if (owner?.parent) fresh.parent = owner.parent
    // a block born inside a canvas is born somewhere ON it
    placeNewCard(page, fresh)
    s.commit(() => {
      page.blocks.splice(page.blocks.findIndex((b) => b.id === blockId) + 1, 0, fresh)
    })
    this.paintPage()
    this.focusBlock(fresh.id)
  }

  /** Move a block (and anything nested under it) to sit after another. */
  /**
   * What you can do to a block, declared ONCE.
   *
   * Four of these existed NOWHERE, on any device: move up, move down,
   * duplicate, delete. Deletion was Backspace-into-the-previous-block and
   * reordering was drag-only — and the drag gutter is hidden on touch, so on a
   * phone a block could not be reordered or removed at all.
   *
   * One list, so the desktop menu and the touch sheet cannot drift — the same
   * reasoning as the topbar's secondary actions.
   */
  private blockActions(id: string): Array<{ icon: IconName; label: string; hint: string; run: () => void; off?: boolean }> {
    const s = this.store
    const page = s.page
    const blocks = page?.blocks ?? []
    const at = blocks.findIndex((b) => b.id === id)
    // a block moves past its SIBLINGS; a child cannot jump out of its parent by
    // stepping, which would silently re-home it
    const owner = blocks[at]?.parent
    const sibs = blocks.filter((b) => b.parent === owner)
    const si = sibs.findIndex((b) => b.id === id)

    return [
      // FIRST, and only for a link card. The card's own edit button appears on
      // hover, which is a gesture a touch screen does not have — this menu is
      // the touch sheet too, so without an entry here a card could be made on a
      // phone and never changed.
      ...(blocks[at]?.type === 'link'
        ? [{ icon: 'globe' as const, label: t('Edit this link card'), hint: '',
          run: () => this.openLinkCard(id) }]
        : []),
      { icon: 'text', label: t('Turn into…'), hint: t('Change this block’s type'),
        run: () => this.openSlash(id) },
      { icon: 'plus', label: t('Add below'), hint: '⏎', run: () => this.insertAfter(id) },
      { icon: 'up', label: t('Move up'), hint: '', off: si <= 0,
        run: () => { if (si > 0) this.moveBefore(id, sibs[si - 1].id) } },
      { icon: 'down', label: t('Move down'), hint: '', off: si < 0 || si >= sibs.length - 1,
        run: () => { if (si >= 0 && si < sibs.length - 1) this.moveBlock(id, sibs[si + 1].id) } },
      { icon: 'copy', label: t('Duplicate'), hint: '', run: () => this.duplicateBlock(id) },
      // The gutter holds two controls and a phone fits one, so commenting
      // lives in the menu BOTH of them open — which is also the touch sheet.
      { icon: 'comment', label: t('Comment'), hint: '', run: () => this.comments.openNew(id) },
      { icon: 'trash', label: t('Delete'), hint: '⌫', run: () => this.deleteBlock(id) },
    ]
  }

  /**
   * Change one field's value.
   *
   * Writes `value` AND `html` together, always. The readable form is what an
   * older build, a thumbnailer, a grep and the markdown export see, so a value
   * written without it is a value those readers cannot see at all — which is
   * the entire reason field values are blocks rather than page keys.
   */
  private setField(blockId: string, value: unknown): void {
    const s = this.store
    const at = s.index.block.get(blockId)
    if (!at) return
    const f = fieldByKey(s.doc, String((at.block as { key?: unknown }).key ?? ''))
    if (!f) return
    // PAGE SCOPE ONLY WHEN THE VALUE IS ON THE PAGE IN VIEW. The store's page
    // entry snapshots `store.pageId` by definition (store.ts entry()), and a
    // status changed from a BOARD lives on another page — so a page-scoped
    // checkpoint would record the board, and undo would restore the board while
    // leaving the changed status exactly where it was. Cheap when it is right,
    // silently wrong when it is not.
    const scope = at.pageId === s.pageId ? 'page' : 'doc'
    s.commit(() => this.applyField(at.block, f, value), { scope })
    this.paintPage()
  }

  /**
   * THE ONE WRITER for a field value. `value` and `html` move together, always,
   * because the readable form is the only thing an older build, a thumbnailer,
   * a grep and the markdown export can see. Every path that sets a value —
   * the header chip, the board's card button, a drag between columns — goes
   * through here, so there is one place for the two to fall out of step and it
   * is three lines long.
   */
  private applyField(b: Block, f: FieldSpec, value: unknown): void {
    ;(b as Record<string, unknown>).value = value
    b.html = propHtml(f, value)
  }

  /**
   * Set a field ON A PAGE, adding the prop block when the page does not carry
   * one — the case a board drop already had and a table cell now has too.
   *
   * A page can be in a view without carrying every field the view shows: a
   * board grouped by something an issue never had, or a table column that
   * exists because SOME other row has it. The value arrives in the header strip
   * where the others are, through propBlock, so the readable `html` is written
   * with it. A value written without its readable form is a value an older
   * build, a thumbnailer, a grep and the markdown export all see as nothing.
   *
   * Not a commit of its own: the caller decides what one user action was.
   */
  private putField(page: Page, f: FieldSpec, value: unknown): void {
    const own = propBlockOf(page, f.key)
    if (own) this.applyField(own, f, value)
    else page.blocks.splice(headerLength(page), 0, propBlock(f, value, newBlock('prop').id))
  }

  /**
   * A TABLE CELL, opened for editing. The same picker the page's own header
   * strip opens, over the same writer a board drop uses.
   *
   * Addressed by PAGE AND KEY rather than by block id, because the interesting
   * cell is the empty one: the page has no prop block for that column, and the
   * edit is what creates it. Looking the block up here — after the value is
   * chosen, in setCell — also means an opened-and-dismissed picker writes
   * nothing at all.
   */
  private openCellPicker(pageId: string, key: string, anchor: HTMLElement): void {
    const s = this.store
    if (s.readOnly || this.reading) return
    const page = s.index.page.get(pageId)
    const f = fieldByKey(s.doc, key)
    if (!page || !f) return
    const own = propBlockOf(page, key)
    this.fieldPicker(f, own ? (own as { value?: unknown }).value : undefined, anchor,
      (v) => this.setCell(pageId, key, v))
  }

  /**
   * Write one cell. Nothing happens when the value did not change: a picker
   * opened and closed on the value already there must not be a step you press
   * ⌘Z past.
   *
   * PAGE SCOPE ONLY WHEN THE ROW IS THE PAGE IN VIEW, for the reason setField
   * carries: a page-scoped checkpoint snapshots `store.pageId`, and a cell in a
   * table almost always belongs to ANOTHER page — undo would restore the page
   * holding the view and leave the changed value exactly where it was.
   */
  private setCell(pageId: string, key: string, value: unknown): void {
    const s = this.store
    const page = s.index.page.get(pageId)
    const f = fieldByKey(s.doc, key)
    if (!page || !f || s.readOnly || this.reading) return
    const own = propBlockOf(page, key)
    if (own && (own as { value?: unknown }).value === value) return
    const scope = pageId === s.pageId ? 'page' : 'doc'
    s.commit(() => this.putField(page, f, value), { scope })
    this.paintPage()
  }

  private openFieldPicker(blockId: string, anchor: HTMLElement): void {
    const s = this.store
    if (s.readOnly || this.reading) return
    const b = s.block(blockId)
    const f = b && fieldByKey(s.doc, String((b as { key?: unknown }).key ?? ''))
    if (!b || !f) return
    this.fieldPicker(f, (b as { value?: unknown }).value, anchor, (v) => this.setField(blockId, v))
  }

  /**
   * THE ONE PICKER for a field value: a list of options for a select, one input
   * for anything else.
   *
   * Takes a WRITER rather than a block id, and that is the whole reason it was
   * split out of openFieldPicker. A table cell can stand for a value that does
   * not exist yet — the page carries no such prop block — so there is no id to
   * hand it. Everything else about choosing a value has to stay identical
   * across the header strip, the board's card chip and a cell, or the same
   * gesture reads as three different controls.
   */
  private fieldPicker(
    f: FieldSpec, cur: unknown, anchor: HTMLElement, write: (v: unknown) => void,
  ): void {
    this.closeOverlay()

    const pop = el('div', this.isDrawer() ? 'sp-pop sp-sheet' : 'sp-pop')
    pop.setAttribute('role', 'menu')
    this.trapAndClose(pop)

    if (f.vt === 'select' && f.options?.length) {
      const now = String(cur ?? '')
      for (const o of f.options) {
        const item = document.createElement('button')
        item.className = 'sp-dditem' + (o.id === now ? ' sp-sel' : '')
        item.type = 'button'
        const dot = el('span', 'sp-prop-dot')
        if (o.color) dot.style.background = o.color
        const name = document.createElement('span')
        name.textContent = o.label
        item.append(dot, name)
        item.addEventListener('click', () => { this.closeOverlay(); write(o.id) })
        pop.append(item)
      }
    } else {
      // free text, a number or a date: one field, committed on Enter
      const input = document.createElement('input')
      input.className = 'sp-find'
      input.type = f.vt === 'number' ? 'number' : f.vt === 'date' ? 'date' : 'text'
      input.value = String(cur ?? '')
      input.placeholder = f.label
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          const raw = input.value.trim()
          this.closeOverlay()
          write(f.vt === 'number' ? (raw === '' ? '' : Number(raw)) : raw)
        }
      })
      pop.append(input)
      afterPaint(() => input.focus())
    }

    this.overlay = pop
    document.body.append(pop)
    if (this.isDrawer()) pop.classList.add('sp-sheet-in')
    else this.placed(pop, anchor)
    const away = (ev: MouseEvent) => {
      if (!pop.contains(ev.target as Node)) { this.closeOverlay(); document.removeEventListener('mousedown', away) }
    }
    setTimeout(() => document.addEventListener('mousedown', away), 0)
  }

  /**
   * THE BOARD, made to work — with a mouse and with a finger.
   *
   * Three affordances over one writer:
   *   · DRAG a card to another column — that column's option becomes the value.
   *   · DRAG within a column — the pages move, because the order of the board
   *     IS the order of `doc.pages`. No stored per-view order: that would be a
   *     new permanent format field, and a drag handler is not the place to
   *     settle one (docs/DECISIONS.md, 2026-08-05).
   *   · TAP the status on a card — a phone cannot drag an HTML5 draggable at
   *     all, and the board is the tracker's main screen. It opens the SAME
   *     picker the issue's own header strip opens.
   *
   * Everything here is wired only when the document is editable: the renderer
   * emits no card button in reading view, in a locked space or on paper, and
   * this is not called there, so there is no half-live board anywhere.
   */
  private wireBoard(root: HTMLElement): void {
    const s = this.store
    if (s.readOnly || this.reading) return
    for (const v of root.querySelectorAll<HTMLElement>('.sp-view')) {
      const vb = s.block(v.dataset.blockId ?? '')
      const groupKey = String((vb as { groupBy?: unknown } | undefined)?.groupBy ?? 'status')

      v.querySelector<HTMLElement>('[data-view-open]')?.addEventListener('click', () => {
        this.editViewFilter(v.dataset.blockId!, (f) => { if (f.open) delete f.open; else f.open = true })
      })
      const fb = v.querySelector<HTMLElement>('[data-view-filter]')
      fb?.addEventListener('click', () => this.openViewFilter(v.dataset.blockId!, fb))
      const lb = v.querySelector<HTMLElement>('[data-view-layout]')
      lb?.addEventListener('click', () => this.toggleViewLayout(v.dataset.blockId!))
      const gb = v.querySelector<HTMLElement>('[data-view-group]')
      gb?.addEventListener('click', () => this.openViewGroup(v.dataset.blockId!, gb))
      const sb = v.querySelector<HTMLElement>('[data-view-sort]')
      sb?.addEventListener('click', () => this.openViewSort(v.dataset.blockId!, sb))
      const srcB = v.querySelector<HTMLElement>('[data-view-source]')
      srcB?.addEventListener('click', () => this.openViewSource(v.dataset.blockId!, srcB))

      // A SORTED BOARD HAS NO HAND ORDER TO DROP INTO. The sort decides where a
      // card sits, so offering a drop position would write an order into
      // doc.pages that the very next paint discards — a gesture that appears to
      // do nothing, and a stray undo step. The column still accepts the card;
      // only the position within it stops being a question.
      const sorted = Array.isArray((vb as { sort?: unknown } | undefined)?.sort)
        && ((vb as { sort?: unknown[] }).sort!).length > 0

      for (const btn of v.querySelectorAll<HTMLElement>('[data-set-field]')) {
        btn.addEventListener('click', (e) => {
          e.preventDefault()
          this.openFieldPicker(btn.dataset.setField!, btn)
        })
      }

      // THE TABLE, made to work. A header is a control and a cell is a control,
      // both real <button>s from the renderer, so the keyboard reaches them and
      // Enter fires this same click — there is no second key path to keep in
      // step with the pointer one.
      for (const h of v.querySelectorAll<HTMLElement>('[data-sort-col]')) {
        h.addEventListener('click', () => {
          // ascending -> descending -> none, written into the view's OWN sort.
          // The third state deletes the key rather than storing an empty array,
          // so a table sorted and unsorted is byte-identical to one nobody
          // touched — the rule filter, source and layout all follow.
          const now = this.store.block(v.dataset.blockId ?? '')
          this.editView(v.dataset.blockId!, 'sort',
            cycleSort((now as { sort?: unknown } | undefined)?.sort, h.dataset.sortCol!))
        })
      }
      for (const c of v.querySelectorAll<HTMLElement>('[data-cell-field]')) {
        c.addEventListener('click', (e) => {
          e.preventDefault()
          this.openCellPicker(c.dataset.cellPage!, c.dataset.cellField!, c)
        })
      }

      // NO BOARD, NO DRAG. A list has cards but no columns, so a draggable card
      // there is an affordance that promises something nothing can accept.
      const board = v.querySelector('.sp-board')
      if (!board) continue

      const marks = () => {
        for (const n of v.querySelectorAll('.sp-drop, .sp-dropend, .sp-dropbefore')) {
          n.classList.remove('sp-drop', 'sp-dropend', 'sp-dropbefore')
        }
      }
      for (const card of v.querySelectorAll<HTMLElement>('.sp-issue[data-issue]')) {
        card.draggable = true
        // A LINK DRAGS ITSELF, carrying its href, and that gesture would beat
        // the card's. Told not to, the drag belongs to the nearest draggable
        // ancestor, which is the card.
        card.querySelector('a')?.setAttribute('draggable', 'false')
        card.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData('text/bento-issue', card.dataset.issue!)
          card.classList.add('sp-dragging')
        })
        card.addEventListener('dragend', () => { card.classList.remove('sp-dragging'); marks() })
      }

      // THE COLUMN UNDER THE POINTER, never a guess — cleared on the way DOWN
      // (capture, on the board) and re-marked on the way up (the column the
      // pointer is actually inside). So the mark is where the pointer is and
      // nowhere else, including over the "Other" column, which accepts no drop
      // and must therefore not leave the last real column looking like a target.
      //
      // `dragleave` cannot do this: it bubbles from every child, so moving
      // across a card inside a column reports leaving the column.
      board.addEventListener('dragover', (e) => {
        if ((e as DragEvent).dataTransfer?.types.includes('text/bento-issue')) marks()
      }, true)
      for (const col of v.querySelectorAll<HTMLElement>('.sp-col[data-group]')) {
        col.addEventListener('dragover', (e) => {
          if (!e.dataTransfer?.types.includes('text/bento-issue')) return
          e.preventDefault()
          col.classList.add('sp-drop')
          if (sorted) return
          const aim = this.aimAt(col, e.clientY)
          if (aim.before) col.querySelector(`[data-issue="${CSS.escape(aim.before)}"]`)?.classList.add('sp-dropbefore')
          else col.classList.add('sp-dropend')
        })
        col.addEventListener('drop', (e) => {
          const moved = e.dataTransfer?.getData('text/bento-issue')
          if (!moved) return
          e.preventDefault()
          const aim = sorted ? null : this.aimAt(col, e.clientY)
          marks()
          this.dropIssue(moved, groupKey, col.dataset.group!, aim)
        })
      }
    }
  }

  /** Where in this column a drop at `y` lands: before a card, or after the last. */
  private aimAt(col: HTMLElement, y: number): DropAim {
    const cards = [...col.querySelectorAll<HTMLElement>('.sp-issue[data-issue]')]
    for (const c of cards) {
      const r = c.getBoundingClientRect()
      if (y < r.top + r.height / 2) return { before: c.dataset.issue }
    }
    return { after: cards[cards.length - 1]?.dataset.issue }
  }

  /**
   * A card landed. Set its value, move its page, or — if it landed where it
   * already was — do NOTHING: no commit, no undo entry, no dirty flag. A drag
   * that changes nothing must not be a step you have to press ⌘Z past.
   *
   * Both halves are ONE commit, because one drag is one user action.
   */
  private dropIssue(pageId: string, key: string, optId: string, aim: DropAim | null): void {
    const s = this.store
    const page = s.index.page.get(pageId)
    const f = fieldByKey(s.doc, key)
    if (!page || !f || s.readOnly) return
    const own = propBlockOf(page, key)
    const setting = !own || String((own as { value?: unknown }).value ?? '') !== optId
    // The no-op test is about the COLUMN, not the page array — those are
    // different orders the moment a board has two columns, and judging by page
    // adjacency let a drop that visibly did nothing rewrite doc.pages.
    //
    // A null aim is a SORTED board: there is no position to land in, so the
    // drop is only ever the value change.
    const cards = [...document.querySelectorAll<HTMLElement>(`.sp-col[data-group="${CSS.escape(optId)}"] .sp-issue[data-issue]`)]
      .map((c) => c.dataset.issue!)
    const moves = !!aim && columnMoves(cards, pageId, aim)
    const order = moves && aim ? reorderPages(s.doc.pages, pageId, aim) : null
    if (!setting && !order) return

    s.commit(() => {
      if (setting) this.putField(page, f, optId)
      if (order) s.doc.pages = order
    })
    this.repaint()
  }

  /**
   * Narrow a view. The filter lives on the `view` block, so it is saved, shared
   * and permanent.
   *
   * Rules an edit here must not break: unknown keys are a NEWER build's and are
   * never touched, and a filter that narrows nothing is DELETED rather than
   * stored empty — so a view someone filtered and unfiltered is byte-identical
   * to one that never was.
   */
  private editViewFilter(blockId: string, edit: (f: ViewFilter) => void): void {
    const s = this.store
    const b = s.block(blockId)
    if (!b || s.readOnly || this.reading) return
    s.commit(() => {
      const next = { ...((b as { filter?: ViewFilter }).filter ?? {}) }
      edit(next)
      if (Object.keys(next).length) (b as { filter?: ViewFilter }).filter = next
      else delete (b as { filter?: ViewFilter }).filter
    }, { scope: 'page' })
    this.paintPage()
  }

  /**
   * A small menu anchored to a button — a bottom sheet on a phone.
   *
   * Four of these had grown the same twelve lines of boilerplate (build, trap,
   * sheet-or-place, dismiss on a click away), which is three copies too many
   * for something whose dismissal behaviour has to be identical everywhere:
   * a menu that closes differently from the one beside it reads as a bug.
   */
  private popover(anchor: HTMLElement, build: (pop: HTMLElement) => void): void {
    this.closeOverlay()
    const pop = el('div', this.isDrawer() ? 'sp-pop sp-sheet' : 'sp-pop')
    pop.setAttribute('role', 'menu')
    this.trapAndClose(pop)
    build(pop)
    this.overlay = pop
    document.body.append(pop)
    if (this.isDrawer()) pop.classList.add('sp-sheet-in')
    else this.placed(pop, anchor)
    const away = (ev: MouseEvent) => {
      if (!pop.contains(ev.target as Node)) { this.closeOverlay(); document.removeEventListener('mousedown', away) }
    }
    setTimeout(() => document.addEventListener('mousedown', away), 0)
  }

  /**
   * Edit a key on a `view` block — layout, groupBy, sort.
   *
   * The same discipline as editViewFilter: an edit that says "the default"
   * DELETES the key rather than storing it, so a view somebody switched to a
   * list and back is byte-identical to one that was never touched, and a file
   * written before this control existed stays that way.
   */
  private editView(blockId: string, key: 'layout' | 'groupBy' | 'sort' | 'source', value: unknown): void {
    const s = this.store
    const b = s.block(blockId)
    if (!b || s.readOnly || this.reading) return
    s.commit(() => {
      const rec = b as unknown as Record<string, unknown>
      if (value === undefined || value === null) delete rec[key]
      else rec[key] = value
    }, { scope: 'page' })
    this.paintPage()
  }

  /** Board ⇄ list. `board` is the default, so it is stored as an ABSENT key. */
  /**
   * WHICH PAGES A VIEW HOLDS.
   *
   * The answer used to be one thing — every page carrying a `status` — which
   * is why a space could hold a backlog and nothing else. Two selectors now,
   * and only two: the pages carrying a given property, or the pages under a
   * given page. With a flat vocabulary where each page carries only the fields
   * it uses, "has an Author" IS "is a book".
   *
   * Issues stays the ABSENT key, so every view written before this keeps
   * showing the backlog and a view set back to Issues is byte-identical to one
   * that never moved.
   */
  private openViewSource(blockId: string, anchor: HTMLElement): void {
    const s = this.store
    const b = s.block(blockId)
    if (!b) return
    this.popover(anchor, (pop) => {
      const set = (src: { has?: string; under?: string } | undefined) => {
        this.editView(blockId, 'source', src)
        this.closeOverlay()
      }
      pop.append(el('div', 'sp-pop-title', t('Which pages')))
      pop.append(this.menuItem('board', t('Issues'), t('Every page with a status'), () => set(undefined)))

      // A property somebody invented is the interesting case, so it comes
      // first among the fields and lists every one the vocabulary has.
      for (const f of fieldsOf(s.doc)) {
        pop.append(this.menuItem('tag', f.label, t('Pages that have this property'),
          () => set({ has: f.key })))
      }

      // Nesting is how a space is already organised, so the current page and
      // its ancestors are the ones worth offering rather than every page.
      const here = s.page
      if (here) {
        pop.append(el('div', 'sp-pop-title', t('Nested under')))
        pop.append(this.menuItem('page', here.title || t('Untitled'),
          t('Pages nested under this one'), () => set({ under: here.id })))
      }
    })
  }

  private toggleViewLayout(blockId: string): void {
    const b = this.store.block(blockId)
    // Board -> list -> table -> gallery -> board, from fields.ts — the ONE
    // place the cycle is written. It used to be written here and again in
    // render.ts, and when the prototype-lookup bug was found only this copy was
    // hardened, so the button went on rendering
    // `function toString() { [native code] }` as its label from the other one.
    //
    // `board` is the ABSENT key, never a stored 'board': a view cycled all the
    // way round is byte-identical to one nobody ever touched, which is the same
    // rule filter and source follow. nextLayout returns the WORD; turning
    // 'board' back into a deletion is the writer's job, and this is the writer.
    const to = nextLayout((b as { layout?: unknown } | undefined)?.layout)
    this.editView(blockId, 'layout', to === 'board' ? undefined : to)
  }

  /**
   * Which field the columns come from.
   *
   * Only fields with declared options are offered. A board's columns ARE the
   * option list — grouping by a free-text field would make one column per
   * distinct string, which is a pivot table wearing a board's clothes.
   */
  private openViewGroup(blockId: string, anchor: HTMLElement): void {
    const s = this.store
    const b = s.block(blockId)
    if (!b || s.readOnly || this.reading) return
    const now = String((b as { groupBy?: unknown }).groupBy ?? 'status')
    const groupable = fieldsOf(s.doc).filter((f) => f.options?.length)
    this.popover(anchor, (pop) => {
      for (const f of groupable) {
        pop.append(this.menuItem('board', f.label, '', () => {
          this.closeOverlay()
          // `status` is the default the renderer assumes, so choosing it clears
          // the key instead of writing what absence already means
          this.editView(blockId, 'groupBy', f.key === 'status' ? undefined : f.key)
        }, { selected: f.key === now }))
      }
      if (!groupable.length) pop.append(el('div', 'sp-fgroup', t('No field here has options to group by')))
    })
  }

  /**
   * The order. One key, though the format holds a list — see fields.ts.
   *
   * "Manual order" is the ABSENCE of a sort, not a sort called manual: it is
   * the page order, which is the order somebody arranged by dragging, and it
   * has to be reachable from here or a board is one click away from being
   * un-arrangeable forever.
   */
  private openViewSort(blockId: string, anchor: HTMLElement): void {
    const s = this.store
    const b = s.block(blockId)
    if (!b || s.readOnly || this.reading) return
    const cur = (Array.isArray((b as { sort?: unknown }).sort)
      ? ((b as { sort?: ViewSort[] }).sort ?? [])[0] : undefined) as ViewSort | undefined
    this.popover(anchor, (pop) => {
      pop.append(this.menuItem('grip', t('Manual order'), '', () => {
        this.closeOverlay()
        this.editView(blockId, 'sort', undefined)
      }, { selected: !cur }))
      pop.append(el('div', 'sp-fgroup', t('Sort')))
      for (const f of fieldsOf(s.doc)) {
        const mine = cur?.key === f.key
        // clicking the field you are already sorted by REVERSES it — the second
        // thing you want after "sort by priority" is "…the other way", and a
        // separate direction control for a one-key sort is a control nobody
        // finds
        const dir: 'asc' | 'desc' = mine && cur?.dir !== 'desc' ? 'desc' : 'asc'
        const hint = mine ? (cur?.dir === 'desc' ? t('Ascending') : t('Descending')) : ''
        pop.append(this.menuItem('arrowDown', f.label, hint, () => {
          this.closeOverlay()
          this.editView(blockId, 'sort', [dir === 'asc' ? { key: f.key } : { key: f.key, dir }])
        }, { selected: mine }))
      }
    })
  }

  /** Toggle one value of one field in a view's filter. */
  private toggleViewValue(blockId: string, key: string, id: string): void {
    this.editViewFilter(blockId, (f) => {
      const is: Record<string, string[]> = { ...(f.is ?? {}) }
      const had = is[key] ?? []
      const next = had.filter((v) => v !== id)
      if (next.length === had.length) next.push(id)
      if (next.length) is[key] = next
      else delete is[key]
      if (Object.keys(is).length) f.is = is
      else delete f.is
    })
  }

  /**
   * The filter picker: every option of every select field, as toggles.
   *
   * Deliberately NOT a query builder — no operators, no and/or, no nesting.
   * A list of values you can switch on is the whole of what a board needs, it
   * fits a phone sheet, and it cannot grow a language that then has to be
   * supported forever.
   */
  private openViewFilter(blockId: string, anchor: HTMLElement): void {
    const s = this.store
    const b = s.block(blockId)
    if (!b || s.readOnly || this.reading) return
    const cur = ((b as { filter?: ViewFilter }).filter ?? {}) as ViewFilter
    this.popover(anchor, (pop) => {
    for (const f of fieldsOf(s.doc)) {
      if (!f.options?.length) continue
      pop.append(el('div', 'sp-fgroup', f.label))
      for (const o of f.options) {
        const on = (cur.is?.[f.key] ?? []).includes(o.id)
        const item = document.createElement('button')
        item.className = 'sp-dditem' + (on ? ' sp-sel' : '')
        item.type = 'button'
        item.setAttribute('aria-pressed', String(on))
        const dot = el('span', 'sp-prop-dot')
        if (o.color) dot.style.background = o.color
        const name = document.createElement('span')
        name.textContent = o.label
        item.append(dot, name)
        // the popover STAYS OPEN: picking three labels is one thought, and
        // reopening a menu between each is the thing that makes filters
        // unusable. Each toggle is still its own undo step.
        item.addEventListener('click', () => {
          const next = !item.classList.contains('sp-sel')
          item.classList.toggle('sp-sel', next)
          item.setAttribute('aria-pressed', String(next))
          this.toggleViewValue(blockId, f.key, o.id)
        })
        pop.append(item)
      }
    }
    pop.append(this.menuItem('trash', t('Clear filter'), '', () => {
      this.closeOverlay()
      // unknown keys survive: this clears what this build put there
      this.editViewFilter(blockId, (f) => { delete f.is; delete f.open })
    }))
    })
  }

  /**
   * Turn the current page into an issue, or make a new one.
   *
   * There is no "issue type" — a page WITH A STATUS is an issue, so this adds
   * the fields and nothing else. Remove the status later and it is a document
   * again, with its body, links and history intact.
   */
  makeIssue(pageId?: string): void {
    const s = this.store
    const page = pageId ? s.index.page.get(pageId) : s.page
    if (!page || s.readOnly) return
    if (isIssue(page)) { this.status(t('Already an issue')); return }
    const fields = fieldsOf(s.doc).filter((f) => ISSUE_FIELDS.includes(f.key))
    s.commit(() => {
      page.blocks.unshift(...fields.map((f) => propBlock(f, f.def ?? '', newBlock('prop').id)))
    })
    this.paintPage()
    this.status(t('Now an issue'))
  }

  /** A new issue: a page that starts with its fields, ready to be titled. */
  newIssue(): void {
    const s = this.store
    if (s.readOnly) return
    const page = newPage(t('New issue'))
    const fields = fieldsOf(s.doc).filter((f) => ISSUE_FIELDS.includes(f.key))
    page.blocks = [
      ...fields.map((f) => propBlock(f, f.def ?? '', newBlock('prop').id)),
      newBlock('p'),
    ]
    s.commit(() => { s.doc.pages.push(page) })
    s.goToPage(page.id)
    this.repaint()
    // the title is what you actually want to type first
    afterPaint(() => {
      const h = this.main.querySelector<HTMLElement>('[data-page-title]')
      h?.focus()
      if (h) { const r = document.createRange(); r.selectNodeContents(h); getSelection()?.removeAllRanges(); getSelection()?.addRange(r) }
    })
  }

  /** The block actions, as a menu. Anchored on a wide screen, a sheet on a phone. */
  private openBlockMenu(id: string, anchor: HTMLElement): void {
    if (this.store.readOnly || this.reading) return
    this.closeOverlay()
    const sheet = this.isDrawer()
    const pop = el('div', sheet ? 'sp-pop sp-sheet' : 'sp-pop')
    pop.setAttribute('role', 'menu')
    this.trapAndClose(pop, () => this.focusBlock(id))
    for (const a of this.blockActions(id)) {
      const item = this.menuItem(a.icon, a.label, a.hint, () => { this.closeOverlay(); a.run() })
      if (a.off) { item.setAttribute('aria-disabled', 'true'); item.classList.add('sp-off') }
      pop.append(item)
    }
    this.overlay = pop
    document.body.append(pop)
    if (sheet) pop.classList.add('sp-sheet-in')
    else place(pop, anchor)
    const away = (ev: MouseEvent) => {
      if (!pop.contains(ev.target as Node)) { this.closeOverlay(); document.removeEventListener('mousedown', away) }
    }
    setTimeout(() => document.addEventListener('mousedown', away), 0)
  }

  /** Move `id` to sit BEFORE `target` — the inverse of moveBlock's "after". */
  private moveBefore(id: string, target: string): void {
    const page = this.store.page
    if (!page) return
    const before = page.blocks.findIndex((b) => b.id === target)
    // the block that precedes the target is what `after` needs; at the top of a
    // sibling run there is none, so splice to the front instead
    const prev = page.blocks.slice(0, before).reverse().find((b) => b.parent === page.blocks[before]?.parent)
    if (prev) this.moveBlock(id, prev.id)
    else this.moveToFront(id)
  }

  private duplicateBlock(id: string): void {
    const s = this.store
    const page = s.page
    if (!page) return
    const at = page.blocks.findIndex((b) => b.id === id)
    if (at < 0) return
    // the SUBTREE, with fresh ids and the parent links rewritten to match, or a
    // duplicated toggle's copy would adopt the original's children
    const remap = new Map<string, string>()
    const group: Block[] = []
    const take = (owner: string) => {
      for (const b of page.blocks) {
        if (b.parent !== owner) continue
        group.push(b)
        take(b.id)
      }
    }
    group.push(page.blocks[at])
    take(id)
    const copies = group.map((b) => {
      const fresh = { ...JSON.parse(JSON.stringify(b)), id: newBlock(b.type).id } as Block
      remap.set(b.id, fresh.id)
      return fresh
    })
    for (const c of copies) if (c.parent && remap.has(c.parent)) c.parent = remap.get(c.parent)
    s.commit(() => { page.blocks.splice(at + group.length, 0, ...copies) })
    this.paintPage()
    this.focusBlock(copies[0].id)
  }

  private deleteBlock(id: string): void {
    const s = this.store
    const page = s.page
    if (!page) return
    const at = page.blocks.findIndex((b) => b.id === id)
    if (at < 0) return
    // children go with their owner, or they re-home at the top of the page and
    // reappear in a document the author believed they had emptied
    const doomed = new Set([id])
    let grew = true
    while (grew) {
      grew = false
      for (const b of page.blocks) {
        if (b.parent && doomed.has(b.parent) && !doomed.has(b.id)) { doomed.add(b.id); grew = true }
      }
    }
    const before = page.blocks[at - 1]?.id
    s.commit(() => {
      page.blocks = page.blocks.filter((b) => !doomed.has(b.id))
      // a page is never left with nothing to type into
      if (!page.blocks.length) page.blocks.push(newBlock('p'))
    })
    this.paintPage()
    this.focusBlock(before ?? page.blocks[0]?.id)
  }

  private moveToFront(id: string): void {
    const page = this.store.page
    if (!page) return
    const at = page.blocks.findIndex((b) => b.id === id)
    if (at <= 0) return
    this.store.commit(() => {
      const [b] = page.blocks.splice(at, 1)
      page.blocks.unshift(b)
    })
    this.paintPage()
  }

  private moveBlock(moved: string, after: string): void {
    const s = this.store
    const page = s.page
    if (!page) return
    const from = page.blocks.findIndex((b) => b.id === moved)
    if (from < 0) return
    // a subtree travels with its owner, or its children would be orphaned
    const kids: string[] = []
    const collect = (id: string) => {
      for (const b of page.blocks) if (b.parent === id) { kids.push(b.id); collect(b.id) }
    }
    collect(moved)
    if (kids.includes(after)) return // never drop a block inside its own subtree
    s.commit(() => {
      const group = [moved, ...kids].map((id) => page.blocks.find((b) => b.id === id)!).filter(Boolean)
      for (const b of group) page.blocks.splice(page.blocks.indexOf(b), 1)
      // AFTER the target's whole SUBTREE, not merely after the target.
      // Landing immediately after a container put the block between that
      // container and its children — the array stayed pre-order but the child
      // no longer followed its parent contiguously, so the renderer's forward
      // pass popped the open container and drew the child at root. Measured:
      // moving the first block down past a toggle un-nested the toggle's body.
      const tgt = page.blocks.findIndex((b) => b.id === after)
      let at = tgt + 1
      if (tgt >= 0) {
        const under = new Set([after])
        while (at < page.blocks.length) {
          const p = page.blocks[at].parent
          if (!p || !under.has(p)) break
          under.add(page.blocks[at].id)
          at++
        }
      }
      page.blocks.splice(at, 0, ...group)
    })
    this.paintPage()
  }

  /** the block whose ghost answer is currently showing, if any */
  private ghostFor: string | null = null

  private clearGhost(): void {
    this.main.querySelectorAll('.sp-preview').forEach((n) => n.remove())
    this.ghostFor = null
  }

  /**
   * While you type, show what the answer WOULD be.
   *
   * The answer is not in the document yet and must not look as though it is:
   * it renders muted, beside the line, and says how to keep it. Pressing Tab
   * appends the `=` — so committing is one keystroke, and ignoring it is none,
   * which is the right balance for something that appears while you are
   * writing prose.
   *
   * Nothing is shown for a line that already asks (the real answer is there),
   * for a line that does not fully parse, or for a bare number — `42` on its
   * own is not a calculation anybody needs confirming.
   */
  private ghost(id: string, host: HTMLElement): void {
    const s = this.store
    if (this.ghostFor && this.ghostFor !== id) this.clearGhost()
    const block = s.block(id)
    const page = s.page
    if (!block || !page) return
    const line = textOf(host.innerHTML)
    const holder = host.parentElement
    if (!holder) return
    holder.querySelectorAll('.sp-preview').forEach((n) => n.remove())
    this.ghostFor = null
    if (asksForAnswer(line) || !/[-+*/^%=]|\bin\b|\bof\b/.test(line)) return

    const ctx = pageContext(page.blocks.map((x) => ({ id: x.id, text: textOf(x.html ?? '') })), id)
    const v = evaluate(line, ctx)
    // a bare number is not a calculation; neither is a line that only names a
    // value already defined
    if (!v || /^\s*[\d.,_]+\s*$/.test(line)) return

    const g = document.createElement('span')
    g.className = 'sp-preview'
    g.contentEditable = 'false'
    g.setAttribute('aria-hidden', 'true')
    g.textContent = `= ${format(v, locale())}`
    const kbd = document.createElement('kbd')
    kbd.textContent = 'Tab'
    g.appendChild(kbd)
    holder.appendChild(g)
    this.ghostFor = id
  }

  /**
   * Keep the ghost answer: append the `=` that asks for it.
   *
   * The ANSWER is not written — only the question. That is the whole design:
   * the document holds `budget * 0.3 =` and the number is derived every time
   * the page is drawn, so changing `budget` above updates this line too.
   * Writing the number here would freeze it, and a frozen number that no
   * longer matches its own expression is worse than no number at all.
   */
  private commitAnswer(id: string): boolean {
    const s = this.store
    const b = s.block(id)
    if (!b || s.readOnly) return false
    const html = `${(b.html ?? '').replace(/\s+$/, '')} =`
    s.commit(() => { b.html = html })
    this.clearGhost()
    this.paintPage()
    afterPaint(() => {
      const h = this.main.querySelector<HTMLElement>(`[data-edit="${CSS.escape(id)}"]`)
      // caret at the END, not selecting the line: you asked for the answer,
      // you did not ask to replace what you wrote
      if (!h) return
      h.focus()
      const r = document.createRange()
      r.selectNodeContents(h)
      r.collapse(false)
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
    })
    return true
  }

  /** Attach behaviour to a freshly painted page. */
  private wire(view: HTMLElement): void {
    const s = this.store

    const title = view.querySelector<HTMLElement>('[data-page-title]')
    if (title) {
      title.dataset.ph = t('Untitled')
      if (!title.textContent?.trim()) title.dataset.empty = '1'
      title.addEventListener('input', () => { if (title.textContent?.trim()) delete title.dataset.empty; else title.dataset.empty = '1' })
    }
    title?.addEventListener('input', () => {
      if (this.painting) return
      const id = title.dataset.pageTitle!
      s.runEdit(`title:${id}`, () => {
        const p = s.index.page.get(id)
        if (p) p.title = title.textContent ?? ''
      })
      this.paintTreeSoon()
    })

    for (const node of view.querySelectorAll<HTMLElement>('[data-block-id]')) {
      if (!s.readOnly && !this.reading) this.addGutter(node, node.dataset.blockId!)
    }

    for (const host of view.querySelectorAll<HTMLElement>('[data-edit]')) {
      const id = host.dataset.edit!
      // A code block's host holds TEXT, not inline html, and carries colour
      // that must never reach the model. It gets its own wiring.
      if (s.block(id)?.type === 'code') { this.wireCode(id, host); continue }
      host.dataset.ph = t('Type / for blocks, [[ to link a page')
      host.addEventListener('input', () => {
        if (this.painting) return
        delete host.dataset.empty
        s.runEdit(id, () => {
          const b = s.block(id)
          if (b) b.html = host.innerHTML
        })
        this.autoformat(id, host)
        this.ghost(id, host)
      })
      host.addEventListener('blur', () => {
        if (this.painting) return
        this.clearGhost()
        s.endRun()
        const b = s.block(id)
        if (b && b.html !== undefined) {
          const clean = canonicalize(b.html)
          if (clean !== b.html) { b.html = clean; host.innerHTML = clean }
        }
      })
    }

    for (const box of view.querySelectorAll<HTMLInputElement>('.sp-check')) {
      box.addEventListener('change', () => {
        const id = (box.closest('[data-block-id]') as HTMLElement).dataset.blockId!
        s.commit(() => { const b = s.block(id); if (b) b.done = box.checked }, { structure: false })
        box.closest('[data-block-id]')!.classList.toggle('sp-done', box.checked)
      })
    }

    // the callout's own mark and name ARE the control that changes them — a
    // tone buried in a menu is a tone nobody ever changes
    // Reading view is READ-ONLY, and this loop is the one that forgot: the
    // renderer already emits an inert <span> when !opts.editable, so the wiring
    // contradicted the renderer's own intent and a click in reading view
    // committed a tone change — undo entry, dirty flag and all. The gutter and
    // language loops guard the same way.
    if (!this.store.readOnly && !this.reading) {
      for (const chip of view.querySelectorAll<HTMLElement>('.sp-callout-chip')) {
        chip.addEventListener('click', (e) => {
          e.preventDefault()
          const id = (chip.closest('[data-block-id]') as HTMLElement).dataset.blockId!
          this.openTonePicker(id, chip)
        })
      }
    }

    for (const tw of view.querySelectorAll<HTMLElement>('.sp-twist')) {
      tw.addEventListener('click', () => {
        const id = (tw.closest('[data-block-id]') as HTMLElement).dataset.blockId!
        s.commit(() => { const b = s.block(id); if (b) b.open = !b.open })
        this.paintPage()
      })
    }

    // FIELD CHIPS. Changing a status is the loop a tracker exists for, so it is
    // one click from the issue and one from the board — never a form.
    if (!this.store.readOnly && !this.reading) {
      for (const chip of view.querySelectorAll<HTMLElement>('[data-edit-field]')) {
        chip.addEventListener('click', (e) => {
          e.preventDefault()
          const id = (chip.closest('[data-block-id]') as HTMLElement).dataset.blockId!
          this.openFieldPicker(id, chip)
        })
      }
      this.wireBoard(view)
      this.wireTables(view)
      // The canvas keeps its own wiring in its own file: the drag, the cards
      // and the shape button are one feature and touch nothing else here.
      wireCanvas(view, {
        block: (id) => this.store.block(id),
        page: () => this.store.page,
        commit: (fn, opts) => this.store.commit(fn, opts),
        repaint: () => this.paintPage(),
        pickPage: (then) => this.openPagePicker('', null, then),
      })
    }

    // "Load this image" — the reader's consent to contact one remote host.
    // NOT a commit: nothing about the document changed, so this must not touch
    // undo, the dirty flag or autosave. It is view state, and it dies with the
    // session (see allowedRemote).
    for (const btn of view.querySelectorAll<HTMLElement>('[data-load-remote]')) {
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        this.allowedRemote.add(btn.dataset.loadRemote!)
        this.paintPage()
      })
    }

    // an image can arrive by paste or by drop, not only through a menu
    view.addEventListener('paste', (e) => {
      const cur = this.blockAt(document.activeElement)
      if (e.clipboardData?.files?.length) {
        e.preventDefault()
        void this.fileFromTransfer(e.clipboardData, cur?.id)
      }
    })
    view.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); view.classList.add('sp-filedrop') }
    })
    view.addEventListener('dragleave', () => view.classList.remove('sp-filedrop'))
    view.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      view.classList.remove('sp-filedrop')
      // markdown (or a folder) is an IMPORT: leave it for the app-level
      // handler rather than rummaging through it for an image
      if (isImportDrop(e.dataTransfer)) return
      e.preventDefault()
      const near = (e.target as HTMLElement)?.closest?.('[data-block-id]') as HTMLElement | null
      void this.fileFromTransfer(e.dataTransfer, near?.dataset.blockId)
    })

    // The language chip. It belongs to the EDITOR, not the renderer: a reader
    // and a printed page get the colours, not the control that changes them.
    if (!s.readOnly && !this.reading) {
      for (const node of view.querySelectorAll<HTMLElement>('.sp-b-code')) {
        const id = node.dataset.blockId!
        const chip = document.createElement('button')
        chip.className = 'sp-btn sp-langchip'
        chip.type = 'button'
        // the RAW tag when this build cannot highlight it, so a `rust` block
        // says "rust" and its plain rendering reads as a gap, not a bug
        chip.textContent = langLabel(s.block(id)?.lang) || t('Plain text')
        chip.title = t('Language — what this block is highlighted as')
        chip.setAttribute('aria-label', t('Language — what this block is highlighted as'))
        chip.addEventListener('click', () => this.openLangPicker(id, chip))
        node.append(chip)
      }
    }

    for (const fig of view.querySelectorAll<HTMLElement>('.sp-b-image')) {
      const id = fig.dataset.blockId!
      const b = s.block(id)
      const tools = el('div', 'sp-imgtools')
      const sizeBtn = document.createElement('button')
      sizeBtn.className = 'sp-btn'
      sizeBtn.type = 'button'
      sizeBtn.textContent = `${b?.width ?? 100}%`
      sizeBtn.title = t('Width in the text column')
      sizeBtn.addEventListener('click', () => {
        const steps = [100, 75, 50, 33]
        const cur = Number(b?.width ?? 100)
        const next = steps[(steps.indexOf(cur) + 1) % steps.length]
        s.commit(() => { const bb = s.block(id); if (bb) bb.width = next })
        this.paintPage()
      })
      tools.append(sizeBtn)
      // a re-encoded image says so, and offers the untouched bytes back
      if (b && b.original === false) {
        const badge = document.createElement('button')
        badge.className = 'sp-btn sp-badge'
        badge.type = 'button'
        badge.textContent = t('Resized')
        badge.title = t('This image was resized to keep the file small. Click to replace it with the original.')
        badge.addEventListener('click', () => void this.pickImage(id))
        tools.append(badge)
      }
      fig.append(tools)
    }

    // VIDEO AND AUDIO. The chooser on an empty block, and the playback
    // switches on a full one. All of it is editor chrome, deliberately: the
    // renderer draws the clip, and a reader, a printout and a locked space get
    // the clip without the switches that change it — the same rule the callout
    // chip and the language chip follow.
    for (const node of view.querySelectorAll<HTMLElement>('.sp-b-media')) {
      const id = node.dataset.blockId!
      for (const btn of node.querySelectorAll<HTMLElement>('[data-pick-media]')) {
        btn.addEventListener('click', () => void this.pickMedia(id))
      }
      for (const btn of node.querySelectorAll<HTMLElement>('[data-link-media]')) {
        btn.addEventListener('click', () => this.linkMedia(id))
      }
      const b = s.block(id)
      if (s.readOnly || this.reading || !b || !b.src) continue
      const kind = String(b.kind ?? 'video') === 'audio' ? 'audio' : 'video'
      const tools = el('div', 'sp-mediatools')
      const flip = (label: string, title: string, on: boolean, set: (v: boolean) => void) => {
        const btn = document.createElement('button')
        btn.className = 'sp-btn' + (on ? ' sp-on' : '')
        btn.type = 'button'
        btn.textContent = label
        btn.title = title
        btn.setAttribute('aria-pressed', String(on))
        btn.addEventListener('click', () => {
          s.commit(() => { const bb = s.block(id); if (bb) set(!on) })
          this.paintPage()
        })
        tools.append(btn)
      }

      // WIDTH IS A VIDEO QUESTION. An <audio> is a control bar of the
      // browser's own height; a percentage of the measure would only make it
      // a shorter control bar.
      if (kind === 'video') {
        const sizeBtn = document.createElement('button')
        sizeBtn.className = 'sp-btn'
        sizeBtn.type = 'button'
        sizeBtn.textContent = `${b.width ?? 100}%`
        sizeBtn.title = t('Width in the text column')
        sizeBtn.addEventListener('click', () => {
          const steps = [100, 75, 50, 33]
          const cur = Number(b.width ?? 100)
          const next = steps[(steps.indexOf(cur) + 1) % steps.length]
          s.commit(() => { const bb = s.block(id); if (bb) bb.width = next })
          this.paintPage()
        })
        tools.append(sizeBtn)

        const poster = document.createElement('button')
        poster.className = 'sp-btn' + (b.poster ? ' sp-on' : '')
        poster.type = 'button'
        poster.textContent = t('Poster…')
        poster.title = t('A still frame, shown before play — and what a printout or a file preview shows')
        poster.addEventListener('click', () => void this.pickPoster(id))
        tools.append(poster)

        flip(t('Muted'), t('Start silent'), b.muted === true,
          (v) => { const bb = s.block(id); if (bb) bb.muted = v })
      }
      flip(t('Loop'), t('Repeat when it reaches the end'), b.loop === true,
        (v) => { const bb = s.block(id); if (bb) bb.loop = v })
      // absent means shown, so the OFF state is the one that is written down
      flip(t('Controls'), t('Show playback controls to the reader'), b.controls !== false,
        (v) => { const bb = s.block(id); if (bb) { if (v) delete bb.controls; else bb.controls = false } })

      const replace = document.createElement('button')
      replace.className = 'sp-btn'
      replace.type = 'button'
      replace.textContent = t('Replace…')
      replace.title = t('Choose a different file')
      replace.addEventListener('click', () => void this.pickMedia(id))
      tools.append(replace)

      // a linked clip says so, because it is the one that stops working on a
      // train — and the badge is the only place that fact is visible
      if (typeof b.src === 'string' && isRemote(b.src)) {
        const badge = document.createElement('span')
        badge.className = 'sp-btn sp-badge'
        badge.textContent = t('Linked')
        badge.title = t('Not in this file: it needs the network, and the site is told when someone opens the page')
        tools.append(badge)
      }
      node.append(tools)
    }
    // A link card OPENS its link, so its editing control is a separate button —
    // rendered only where there is an editor (render.ts), wired here.
    view.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-edit-link]')
      if (!btn) return
      e.preventDefault()
      this.openLinkCard(btn.dataset.editLink!)
    })

    // intra-space links navigate without leaving the document
    view.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a')
      if (!a) return
      const href = a.getAttribute('href') ?? ''
      if (!href.startsWith('#p/')) return
      // through the same resolver as the address bar, so a block anchor
      // navigates to its page instead of doing nothing at all
      e.preventDefault()
      const id = this.resolveAnchor(href)
      if (id) s.goToPage(id)
    })
  }

  /**
   * A code block's editable host.
   *
   * TWO THINGS DIFFER from every other block, and both are load-bearing.
   *
   * The MODEL takes `textContent`, not `innerHTML`. The host now contains
   * colour spans; reading innerHTML would write them into `b.html` and the
   * document would carry presentation — a format change, permanent, for a
   * feature that is supposed to be render-only. What is stored is the same
   * html-escaped plain text a code block has always stored, so files written
   * before highlighting existed and files written after are indistinguishable.
   *
   * The COLOUR is repainted synchronously on input, and `paintCode` reconciles
   * rather than replacing — see its comment. Measured on the built shell: an
   * insertion in the middle of a line changes no token boundary, so the paint
   * performs zero DOM mutations and the caret is untouched. Only a keystroke
   * that restructures the token stream costs a caret restore, and then the
   * offset is exact because the reconcile is the only thing that moved it.
   *
   * Canonicalization is deliberately NOT run here (the generic host runs it on
   * blur): it exists to tidy inline markup, and a code block has none.
   */
  private wireCode(id: string, host: HTMLElement): void {
    const s = this.store
    // An IME composition lives in nodes the engine owns; re-tokenising
    // mid-composition destroys them and drops the half-typed word. The model
    // keeps up regardless — only the colour waits for compositionend.
    let composing = false
    const sync = (paint: boolean): void => {
      const text = host.textContent ?? ''
      s.runEdit(id, () => { const b = s.block(id); if (b) b.html = escText(text) })
      if (!paint) return
      const at = caretIndexIn(host)
      if (paintCode(host, text, s.block(id)?.lang) && at !== null) caretToOffset(host, at)
    }
    host.addEventListener('compositionstart', () => { composing = true })
    host.addEventListener('compositionend', () => { composing = false; sync(true) })
    host.addEventListener('input', () => { if (!this.painting) sync(!composing) })
    host.addEventListener('blur', () => { if (!this.painting) s.endRun() })
  }

  // ---- tables -------------------------------------------------------------
  //
  // A block editor edits a table differently from a canvas: there is no
  // properties panel to put row and column controls in, and the block IS the
  // table, so the controls ride on the block the way the image tools do. What
  // is copied from slides is the MODEL (fractional weights, rows of cells, a
  // header flag, whole-value LWW under collab); what is not is any of this.

  /** The cell the caret is in — `data-cell` is the block, `data-r`/`data-c` the
   *  seat. Deliberately NOT `data-edit`: that name means "this element's html
   *  IS the block's html", and the generic input handler would then write one
   *  cell over the whole table. */
  private cellAt(node: Node | null): { id: string; r: number; c: number; td: HTMLElement } | null {
    const td = (node instanceof HTMLElement ? node : node?.parentElement)?.closest<HTMLElement>('[data-cell]')
    if (!td) return null
    return { id: td.dataset.cell!, r: Number(td.dataset.r), c: Number(td.dataset.c), td }
  }

  private focusCell(id: string, r: number, c: number): void {
    afterPaint(() => {
      const td = this.main.querySelector<HTMLElement>(
        `[data-cell="${CSS.escape(id)}"][data-r="${r}"][data-c="${c}"]`)
      if (!td) return
      td.focus()
      caretToEnd(td)
    })
  }

  /**
   * Change a table's shape, then put the caret back where the change means it
   * should be.
   *
   * Every table write goes through here and through model.writeTable, so the
   * derived `html` fallback — the thing a build that predates tables shows —
   * can never drift from the cells. It is a `commit`, so it is one undo step.
   */
  private editTable(id: string, fn: (t: TableShape) => { r: number; c: number } | void): void {
    const s = this.store
    const b = s.block(id)
    if (!b || s.readOnly || this.reading) return
    let seat: { r: number; c: number } | undefined
    const shape = tableOf(b)
    s.commit(() => { seat = fn(shape) || undefined; writeTable(b, shape) })
    this.paintPage()
    // where the change means the caret should be, or where it already was —
    // clamped, because the row it was in may be the row that just went
    const here = this.cell?.id === id ? this.cell : null
    const to = seat ?? here
    if (!to) return
    const t = tableOf(b)
    this.focusCell(id, Math.min(to.r, t.h - 1), Math.min(to.c, t.w - 1))
  }

  /** The last cell the caret was in, so a toolbar button knows which row and
   *  column it means. A toolbar click blurs the cell, so this cannot be read
   *  from the Selection at the moment the button fires. */
  private cell: { id: string; r: number; c: number } | null = null

  /** A fresh row or column of the right width. */
  private static blank(n: number): string[] { return Array<string>(n).fill('') }

  addTableRow(id: string, at?: number): void {
    this.editTable(id, (t) => {
      if (t.h >= TABLE_MAX_ROWS) return
      const r = at === undefined ? t.h : at + 1
      t.rows.splice(r, 0, Editor.blank(t.w))
      return { r, c: 0 }
    })
  }

  addTableCol(id: string, at?: number): void {
    this.editTable(id, (t) => {
      if (t.w >= TABLE_MAX_COLS) return
      const c = at === undefined ? t.w : at + 1
      for (const row of t.rows) row.splice(c, 0, '')
      t.cols.splice(c, 0, t.cols[Math.min(c, t.cols.length - 1)] ?? 1)
      t.colAlign.splice(c, 0, '')
      return { r: 0, c }
    })
  }

  /** A table always keeps one row and one column: a table with none is not an
   *  empty table, it is a block with nothing to click on and no way back. */
  removeTableRow(id: string, at: number): void {
    this.editTable(id, (t) => {
      if (t.h <= 1) return
      t.rows.splice(Math.min(at, t.h - 1), 1)
      return { r: Math.max(0, Math.min(at, t.rows.length - 1)), c: 0 }
    })
  }

  removeTableCol(id: string, at: number): void {
    this.editTable(id, (t) => {
      if (t.w <= 1) return
      const c = Math.min(at, t.w - 1)
      for (const row of t.rows) row.splice(c, 1)
      t.cols.splice(c, 1)
      t.colAlign.splice(c, 1)
      return { r: 0, c: Math.max(0, c - 1) }
    })
  }

  /**
   * Attach a table's editing behaviour: the cells, the tools, the grips.
   *
   * Called only when the document is editable — the renderer already emits
   * inert `<td>`s in the reading view and in print, so wiring them anyway would
   * contradict it, which is the exact mistake the callout chip made once.
   */
  private wireTables(view: HTMLElement): void {
    const s = this.store

    for (const td of view.querySelectorAll<HTMLElement>('[data-cell]')) {
      const id = td.dataset.cell!
      const r = Number(td.dataset.r), c = Number(td.dataset.c)
      td.addEventListener('focus', () => { this.cell = { id, r, c } })
      td.addEventListener('input', () => {
        if (this.painting) return
        // ONE RUN PER CELL, not per block: the run key carries the seat, so
        // moving to the next cell closes the run and Tab-typing across a row is
        // five undo steps rather than one that swallows the whole row.
        s.runEdit(`${id}:${r}:${c}`, () => {
          const b = s.block(id)
          if (!b) return
          const t = tableOf(b)
          if (!t.rows[r]) return
          t.rows[r][c] = td.innerHTML
          writeTable(b, t)
        })
      })
      td.addEventListener('blur', () => {
        if (this.painting) return
        s.endRun()
        const b = s.block(id)
        if (!b) return
        const t = tableOf(b)
        const clean = canonicalize(t.rows[r]?.[c] ?? '')
        if (clean === t.rows[r]?.[c]) return
        t.rows[r][c] = clean
        writeTable(b, t)
        td.innerHTML = clean
      })
    }

    for (const node of view.querySelectorAll<HTMLElement>('.sp-b-table')) {
      const id = node.dataset.blockId!
      const b = s.block(id)
      if (!b) continue
      const shape = tableOf(b)
      const tools = el('div', 'sp-tb-tools')
      const btn = (label: string, title: string, run: () => void, on = false) => {
        const x = document.createElement('button')
        x.type = 'button'
        x.className = 'sp-btn' + (on ? ' sp-on' : '')
        x.textContent = label
        x.title = title
        x.setAttribute('aria-label', title)
        // mousedown, not click: a click would first blur the cell, and `this.cell`
        // is read to decide WHICH row the button means. Blur still runs (the
        // cell's own handler closes its typing run) — it just runs after the
        // seat has been used.
        x.addEventListener('mousedown', (e) => { e.preventDefault(); run() })
        return x
      }
      const seat = () => (this.cell?.id === id ? this.cell : null)
      tools.append(
        btn('＋', t('Add a row below'), () => this.addTableRow(id, seat()?.r)),
        btn('＋|', t('Add a column after'), () => this.addTableCol(id, seat()?.c)),
        btn('－', t('Remove this row'), () => this.removeTableRow(id, seat()?.r ?? shape.h - 1)),
        btn('－|', t('Remove this column'), () => this.removeTableCol(id, seat()?.c ?? shape.w - 1)),
        btn('H', t('Header row'), () => this.editTable(id, (x) => { x.header = !x.header }), shape.header),
      )
      node.append(tools)

      // COLUMN GRIPS on the first row's cells, all but the last: a boundary
      // moves two columns, and there is no boundary after the last one.
      // COLUMN GRIPS. They live in the WRAPPER, absolutely positioned over each
      // boundary — NOT inside the first row's cells, which is where they went
      // first and which was wrong in two ways at once, both measured in the
      // browser: the cell's `innerHTML` is the model, so every grip was written
      // into the document as the cell's content; and `caretToEnd` put the caret
      // INSIDE the trailing <button>, so the first word typed into a column
      // landed in the button and was then eaten by the sanitizer on blur (a
      // <button> is not on the inline allowlist, so it goes with its text).
      // Editor chrome never belongs inside an editable host. The image tools and
      // the language chip sit outside theirs for the same reason.
      const wrap = node.querySelector<HTMLElement>('.sp-tb-wrap')
      const table = node.querySelector<HTMLElement>('.sp-tb')
      if (!wrap || !table || shape.w < 2) continue
      const grips: HTMLElement[] = []
      // `offsetLeft` is measured against the WRAP (the nearest positioned
      // ancestor), which is also what the grips are positioned in — so the two
      // agree inside the horizontal scroller as well, and scroll together.
      const place = () => {
        const row = [...node.querySelectorAll<HTMLElement>('[data-cell][data-r="0"]')]
        grips.forEach((g, c) => {
          const td = row[c]
          if (!td) return
          // physical `left`, to match the physical `offsetLeft` it comes from
          g.style.left = `${td.offsetLeft + td.offsetWidth - 3}px`
          g.style.height = `${table.offsetHeight}px`
        })
      }
      for (let c = 0; c < shape.w - 1; c++) {
        const grip = document.createElement('button')
        grip.type = 'button'
        grip.className = 'sp-tb-grip'
        grip.tabIndex = -1
        grip.setAttribute('aria-label', t('Drag to resize this column'))
        grip.addEventListener('mousedown', (down) => this.startColResize(down, id, c, node, place))
        grips.push(grip)
        wrap.append(grip)
      }
      place()
      // the column boundaries move when the window does, and a grip that is no
      // longer over its boundary is worse than no grip
      new ResizeObserver(place).observe(table)
    }
  }

  /**
   * Drag a column boundary.
   *
   * The DOM is updated live and the model ONLY on release — a commit per
   * mousemove would be sixty undo steps for one drag, and repainting the page
   * under the cursor would drop the pointer capture on the first frame.
   *
   * Two adjacent weights are traded so the total is unchanged: `cols` are
   * fractions of the table's own width (model.ts), so a drag can never make a
   * table that does not add up.
   */
  private startColResize(down: MouseEvent, id: string, c: number, node: HTMLElement, place: () => void): void {
    down.preventDefault()
    const table = node.querySelector<HTMLElement>('.sp-tb')
    const b = this.store.block(id)
    if (!table || !b) return
    const shape = tableOf(b)
    const cols = [...table.querySelectorAll<HTMLElement>('col')]
    const width = table.getBoundingClientRect().width || 1
    const total = shape.cols.reduce((s, n) => s + n, 0) || shape.w
    const startX = down.clientX
    const a0 = shape.cols[c], b0 = shape.cols[c + 1]
    // a column never shrinks past a width you could still grab
    const min = (total * 40) / width
    document.body.classList.add('sp-col-resizing')

    const move = (m: MouseEvent) => {
      const d = ((m.clientX - startX) / width) * total
      const a = Math.max(min, Math.min(a0 + b0 - min, a0 + d))
      shape.cols[c] = a
      shape.cols[c + 1] = a0 + b0 - a
      for (let i = 0; i < cols.length; i++) {
        cols[i].style.width = `${((shape.cols[i] / total) * 100).toFixed(3)}%`
      }
      // the grips follow the boundaries they ARE; the table's own size does not
      // change during a column drag, so the ResizeObserver never fires for this
      place()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('sp-col-resizing')
      this.store.commit(() => { writeTable(b, shape) }, { structure: false })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /**
   * The keymap INSIDE a cell. Returns true when it handled the key.
   *
   * Tab and Enter walk the grid, and Tab off the last cell appends a row —
   * exactly what slides' canvas table does, because it is what every table in
   * every application does and muscle memory is not a thing to be clever with.
   * Shift+Enter is the line break, since plain Enter is spent on navigation.
   */
  private tableKey(e: KeyboardEvent, at: { id: string; r: number; c: number }): boolean {
    const b = this.store.block(at.id)
    if (!b) return false
    const t = tableOf(b)
    const go = (r: number, c: number) => { e.preventDefault(); this.focusCell(at.id, r, c) }

    if (e.key === 'Tab') {
      const next = at.c + (e.shiftKey ? -1 : 1)
      if (next >= 0 && next < t.w) { go(at.r, next); return true }
      if (e.shiftKey) {
        if (at.r === 0) { e.preventDefault(); return true }
        go(at.r - 1, t.w - 1)
        return true
      }
      if (at.r + 1 < t.h) { go(at.r + 1, 0); return true }
      // off the end: a new row, which is how a table is filled in
      e.preventDefault()
      this.addTableRow(at.id)
      return true
    }
    if (e.key === 'Enter') {
      if (e.shiftKey) {
        // the browser inserts a <div> or a <p> into a td left to itself, and
        // block structure is never markup here — insertLineBreak is a <br>
        e.preventDefault()
        document.execCommand('insertLineBreak')
        return true
      }
      if (at.r + 1 < t.h) { go(at.r + 1, at.c); return true }
      e.preventDefault()
      this.addTableRow(at.id)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      ;(document.activeElement as HTMLElement | null)?.blur()
      return true
    }
    return false
  }

  /** Choose what a code block is highlighted as. */
  private openLangPicker(blockId: string, anchor: HTMLElement): void {
    const s = this.store
    if (s.readOnly || this.reading) return
    this.closeOverlay()
    const pop = el('div', 'sp-pop sp-langpop')
    pop.setAttribute('role', 'menu')
    this.trapAndClose(pop, () => this.focusBlock(blockId))
    // An UNKNOWN tag matches NO row. `rust` renders plain, but it is not the
    // same thing as plain: ticking "Plain text" for it would say the tag is
    // already gone, and the next click would quietly delete it.
    const raw = String(s.block(blockId)?.lang ?? '').trim()
    const cur = normLang(raw)
    const unknown = !!raw && !cur
    for (const { id, label } of CODE_LANGS) {
      const b = document.createElement('button')
      b.className = 'sp-dditem' + (!unknown && id === cur ? ' sp-sel' : '')
      b.type = 'button'
      b.setAttribute('role', 'menuitem')
      b.append(Object.assign(document.createElement('strong'), {
        textContent: label || t('Plain text'),
      }))
      b.addEventListener('click', () => {
        this.closeOverlay()
        s.commit(() => {
          const blk = s.block(blockId)
          if (!blk) return
          if (id) blk.lang = id
          else delete blk.lang
        })
        this.paintPage()
      })
      pop.append(b)
    }
    document.body.append(pop)
    this.overlay = pop
    place(pop, anchor)
    setTimeout(() => {
      const away = (ev: MouseEvent) => {
        if (!pop.contains(ev.target as Node)) { this.closeOverlay(); document.removeEventListener('mousedown', away) }
      }
      document.addEventListener('mousedown', away)
    }, 0)
  }

  private collab: import('./collabui.ts').CollabUi | null = null
  /** the live session, once main.ts has handed it over (connectSync) */
  private session: import('./sync/session.ts').SyncSession | null = null
  private liveSlot!: HTMLElement
  private topbar: HTMLElement | null = null
  private barRO: ResizeObserver | null = null
  private barMO: MutationObserver | null = null
  private treeTimer: ReturnType<typeof setTimeout> | undefined
  private paintTreeSoon(): void {
    clearTimeout(this.treeTimer)
    this.treeTimer = setTimeout(() => this.paintTree(), 250)
  }

  /** What links here — derived, never stored. */
  private backlinks(pageId: string): HTMLElement {
    const s = this.store
    const refs = s.index.backlinks.get(pageId) ?? []
    const box = el('section', 'sp-backlinks')
    if (!refs.length) return box
    box.append(el('h2', 'sp-backlinks-h', t('Linked from')))
    const seen = new Set<string>()
    const ul = el('ul', 'sp-backlink-list')
    for (const r of refs) {
      if (seen.has(r.pageId)) continue
      seen.add(r.pageId)
      const from = s.index.page.get(r.pageId)
      if (!from) continue
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.href = `#p/${from.id}`
      a.textContent = from.title || t('Untitled')
      a.addEventListener('click', (e) => { e.preventDefault(); s.goToPage(from.id) })
      const snippet = textOf(s.index.block.get(r.blockId)?.block.html).slice(0, 120)
      li.append(a)
      if (snippet) li.append(el('span', 'sp-snippet', snippet))
      ul.append(li)
    }
    box.append(ul)
    return box
  }

  // ---- editing ------------------------------------------------------------
  private blockAt(node: Node | null): { id: string; host: HTMLElement } | null {
    const host = (node instanceof HTMLElement ? node : node?.parentElement)?.closest<HTMLElement>('[data-edit]')
    return host ? { id: host.dataset.edit!, host } : null
  }

  private focused(): { id: string; host: HTMLElement } | null {
    return this.blockAt(document.activeElement)
  }

  /**
   * Markdown prefixes convert the block as they are typed.
   *
   * THE TRAILING SPACE IS NOT A SPACE. A space typed at the end of a
   * contenteditable line is inserted by the engine as U+00A0, so that it does
   * not collapse — measured in Chrome on the built shell: after typing "## ",
   * `host.textContent` is `['#','#',160]` and `/^## $/` does not match it.
   * Every space-completed trigger in the table above was therefore dead, which
   * is most of them. Normalising here (never in the model — the block's html is
   * cleared by the conversion anyway) fixes all of them at once.
   */
  private autoformat(id: string, host: HTMLElement): void {
    // A trailing space typed at the end of a contentEditable line is inserted
    // by the browser as U+00A0, not U+0020 — otherwise it would collapse and
    // the caret would appear not to move. So `/^## $/` never matched anything a
    // person typed, and every markdown trigger in this app was dead from the
    // first release: measured in the built shell, `# `, `## `, `- `, `1. `,
    // `> ` and `[] ` all arrived as [.., 160] and converted nothing.
    //
    // It survived a test because the test assigned `host.textContent` directly
    // — with a real space, which is a path no keystroke takes. Drive
    // autoformat with execCommand('insertText'), or it proves nothing.
    //
    // Normalised for the TEST only. The model keeps whatever the browser put
    // there; rewriting the author's text to make a pattern match would be a
    // cure worse than the disease.
    const text = (host.textContent ?? '').replace(/\u00a0/g, ' ')
    for (const [re, type, extra] of AUTOFORMAT) {
      // the MATCH, not just a test: a trigger may name a value, as
      // `[!warning] ` names the tone the callout is about to have
      const m = re.exec(text)
      if (!m) continue
      const s = this.store
      const b = s.block(id)
      // `b.type === type` alone would stop `[!caution] ` from re-toning a
      // callout that is already a callout
      if (!b) return
      if (b.type === type && m.length < 2) return
      s.commit(() => { b.type = type; b.html = ''; extra(b, m) })
      this.paintPage()
      this.focusBlock(id)
      return
    }
  }

  private focusBlock(id: string, atEnd = true): void {
    afterPaint(() => {
      const host = this.main.querySelector<HTMLElement>(`[data-edit="${CSS.escape(id)}"]`)
      if (!host) return
      host.focus()
      if (atEnd) caretToEnd(host)
    })
  }

  private onKey(e: KeyboardEvent): void {
    const s = this.store
    const mod = (e as any)[CTRL] as boolean

    // ⌘K IS TWO COMMANDS, decided by whether anything is selected — the same
    // split Notion and Confluence make, and the reason it is not a second
    // shortcut: on a selection it is "link these words", and with nothing
    // selected there is nothing to link, so it stays the quick-open it has
    // always been. `link()` answers false when the selection is not markable,
    // and the search opens as before.
    if (mod && e.key.toLowerCase() === 'k' && !e.shiftKey) {
      e.preventDefault()
      if (!this.format?.link()) this.openSearch()
      return
    }
    // `!e.shiftKey`: ⇧⌘S is strikethrough, and this branch had no shift test,
    // so without it the save dialog opened every time someone struck text out.
    if (mod && e.key.toLowerCase() === 's' && !e.shiftKey) { e.preventDefault(); this.onSave?.(); return }
    if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); this.openPrint(); return }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); this.openFind(); return }
    if (mod && e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); this.newPage(); return }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'j') { e.preventDefault(); this.openJournal(); return }
    // `[` collapses the page list, `]` opens the properties panel — the pair
    // slides uses. BOTH ask the same question first.
    //
    // `[` did not, and the comment beside it claimed it did not need to
    // because "the text path returns above". The text path is ~90 lines BELOW
    // it, so every bare `[` was caught here, preventDefault()ed, and turned
    // into a sidebar toggle: `[[`, the way this app makes links and the thing
    // the starter space tells you to type, could not be typed at all. Shipped
    // since #237.
    //
    // ONE guard for both, not two. The panel work arrived with its own
    // `isTyping()` while this was being fixed with an `editingText()` — same
    // question, two names, and a second copy is how the two answers start to
    // differ. `isTyping` is the survivor because it also covers SELECT, which
    // takes a keystroke as readily as an input does.
    if (!mod && e.key === '[' && !isTyping()) { e.preventDefault(); this.togglePane(); return }
    if (!mod && e.key === ']' && !isTyping()) { e.preventDefault(); this.toggleInsp(); return }
    // Same guard as [ and ]: '?' is a character somebody is entitled to type.
    if (!mod && e.key === '?' && !isTyping()) { e.preventDefault(); this.openHelp(); return }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); this.newIssue(); return }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) s.redo(); else s.undo()
      this.paintPage(); this.paintTree()
      return
    }
    if (e.key === 'Escape' && this.reading && !this.overlay) { e.preventDefault(); this.toggleReading(false); return }
    if (this.overlay) return // the overlay owns the keyboard while it is open

    // A TABLE CELL IS NOT A BLOCK HOST, so the block keymap below does not
    // apply to it — the same ruling a code block gets, one level earlier.
    // ⏎ walks the grid rather than splitting a block, ⇥ walks it rather than
    // re-parenting, and neither has any meaning for a cell. This must come
    // before `focused()`, which looks for `[data-edit]` and finds nothing in a
    // cell — so without it every key here fell through to the browser, and ⏎
    // inserted a `<div>` into the cell's html.
    const inCell = this.cellAt(document.activeElement)
    if (inCell && !s.readOnly && !this.reading) {
      if (this.tableKey(e, inCell)) return
    }

    const cur = this.focused()
    if (!cur) return
    const b = s.block(cur.id)
    if (!b) return

    // native undo must never diverge from the store's history
    if (mod && (e.key.toLowerCase() === 'y')) { e.preventDefault(); s.redo(); this.paintPage(); return }

    // A CODE BLOCK IS TEXT, so the block-editor keymap does not apply to it.
    // Enter is a newline (not a block split), Tab is an indent (not a
    // re-parent — indenting the block in the page tree is never what someone
    // pressing Tab inside source code meant), and /, [[ and ⌘B are off.
    //
    // Enter is handled EXPLICITLY rather than left to the engine: what the
    // browser inserts into a contenteditable varies (a `\n`, a `<br>`, a
    // wrapping `<div>`), and only the first survives reading the host's
    // textContent, which is now how the model is written. execCommand keeps
    // the caret and fires the `input` event that repaints the colour.
    if (b.type === 'code') {
      // Shift is not a modifier here: there is no "soft break" in source code,
      // so both Enters are the same newline.
      if (e.key === 'Enter') { e.preventDefault(); insertText('\n'); return }
      if (e.key === 'Tab') { e.preventDefault(); if (!e.shiftKey) insertText('  '); return }
      if (e.key === '/' || e.key === '[') return
      if (markKey(e, mod)) { e.preventDefault(); return }
    }

    if (e.key === 'Enter' && !e.shiftKey && b.type !== 'code') {
      e.preventDefault()
      this.splitBlock(cur.id, cur.host)
      return
    }
    if (e.key === 'Backspace' && atStart(cur.host)) {
      const empty = !(cur.host.textContent ?? '').trim()
      if (b.type !== 'p' && empty) { e.preventDefault(); this.setType(cur.id, 'p'); return }
      // …and the way OUT of a container is the same key that got you in.
      // Without this, ⏎ puts a line inside a callout and backspace merges it
      // into the callout's own text, so the only exit is Shift-Tab — which
      // nobody finds. Empty line + backspace = out, as in every outliner.
      if (empty && b.parent && SPEC.get(s.block(b.parent)?.type ?? '')?.container === 'always') {
        e.preventDefault()
        this.indent(cur.id, false)
        return
      }
      e.preventDefault()
      this.mergeBack(cur.id)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      // A GHOST ANSWER CLAIMS TAB, and only while it is showing. Committing is
      // then the keystroke your hand is already on, and ignoring it costs
      // nothing — you carry on typing and it goes away. Shift+Tab still
      // outdents, so the one gesture people use constantly is never stolen.
      if (!e.shiftKey && this.ghostFor === cur.id && this.commitAnswer(cur.id)) return
      this.indent(cur.id, !e.shiftKey)
      return
    }
    if (e.key === '/' && !(cur.host.textContent ?? '').trim()) {
      // a slash on an empty block opens the block menu
      setTimeout(() => this.openSlash(cur.id), 0)
      return
    }
    if (e.key === '[' && cur.host.textContent?.endsWith('[')) {
      setTimeout(() => this.openPagePicker(cur.id, cur.host), 0)
      return
    }
    const mark = markKey(e, mod)
    if (mark) {
      // ALWAYS preventDefault, even with nothing selected. ⌘B is a browser
      // command too, and letting it through would put contentEditable's own
      // `<b>` into the block — the exact non-canonical markup, from the exact
      // engine, that §2.4(b) forbids and that this replaced.
      e.preventDefault()
      this.format?.toggle(mark)
      return
    }
  }

  private splitBlock(id: string, host: HTMLElement): void {
    const s = this.store
    const b = s.block(id)
    if (!b) return
    const [before, after] = splitAtCaret(host)
    const heading = b.type === 'h1' || b.type === 'h2' || b.type === 'h3'
    // ⏎ INSIDE AN ALWAYS-OPEN CONTAINER GOES IN, not after.
    //
    // A callout's second line belongs in the callout; making a second empty
    // callout instead is what everyone who has used one expects not to happen,
    // and it is also the only thing that makes nesting discoverable without
    // knowing that Tab does it. Deliberately NOT extended to `toggle`: a fold
    // can be shut, and putting the caret inside a shut fold loses the line.
    const into = SPEC.get(b.type)?.container === 'always'
    const fresh = newBlock(heading || into ? 'p' : b.type, { html: after })
    SPEC.get(fresh.type)?.init?.(fresh)
    if (into) fresh.parent = b.id
    else if (b.parent) fresh.parent = b.parent
    if (s.page) placeNewCard(s.page, fresh)
    s.commit(() => {
      b.html = before
      const page = s.page!
      page.blocks.splice(page.blocks.indexOf(b) + 1, 0, fresh)
    })
    this.paintPage()
    this.focusBlock(fresh.id, false)
  }

  private mergeBack(id: string): void {
    const s = this.store
    const page = s.page
    if (!page) return
    const i = page.blocks.findIndex((x) => x.id === id)
    if (i <= 0) return
    const prev = page.blocks[i - 1]
    const b = page.blocks[i]
    if (prev.type === 'divider') { s.commit(() => { page.blocks.splice(i - 1, 1) }); this.paintPage(); this.focusBlock(id); return }
    const at = (prev.html ?? '').length
    s.commit(() => {
      prev.html = (prev.html ?? '') + (b.html ?? '')
      // a merged-away parent would orphan its children — re-home them
      for (const child of page.blocks) if (child.parent === b.id) child.parent = prev.id
      page.blocks.splice(i, 1)
    })
    this.paintPage()
    afterPaint(() => {
      const host = this.main.querySelector<HTMLElement>(`[data-edit="${CSS.escape(prev.id)}"]`)
      if (host) { host.focus(); caretToOffset(host, at) }
    })
  }

  /** Tab sets `parent` to the previous sibling — one field write. */
  private indent(id: string, deeper: boolean): void {
    const s = this.store
    const page = s.page
    if (!page) return
    const i = page.blocks.findIndex((x) => x.id === id)
    const b = page.blocks[i]
    if (!b) return
    s.commit(() => {
      if (!deeper) {
        // by the EFFECTIVE parent (model.ts), not by whatever `parent` names:
        // on a merged document `parent` can point at a block that is absent or
        // that sits LATER, and outdenting through it would move this block
        // under something the renderer never nested it under
        const eff = effectiveParents(page)
        const owner = eff.get(b.id)
        if (!owner) { delete b.parent; return }
        const grand = eff.get(owner)
        if (grand) b.parent = grand
        else delete b.parent
        return
      }
      // the nearest preceding block at the same level becomes the owner
      for (let j = i - 1; j >= 0; j--) {
        if (page.blocks[j].parent === b.parent) { b.parent = page.blocks[j].id; return }
      }
    })
    this.paintPage()
    this.focusBlock(id)
  }

  setType(id: string, type: string): void {
    this.store.commit(() => {
      const b = this.store.block(id)
      if (!b) return
      b.type = type
      // the registry seeds the type's own fields (blocks.ts `init`), so a new
      // block type does not need a line here as well — this was the fifth place
      // a type had to be added, and the one that was easiest to forget
      SPEC.get(type)?.init?.(b)
    })
    this.paintPage()
    // a table's text is in its cells, so there is no block host to put the
    // caret in — the first cell is the equivalent place
    if (type === 'table') this.focusCell(id, 0, 0)
    else this.focusBlock(id)
  }

  // ---- overlays -----------------------------------------------------------
  private openOverlay(title: string, build: (body: HTMLElement, close: () => void) => void): void {
    this.closeOverlay()
    const back = el('div', 'sp-overlay')
    const card = el('div', 'sp-card')
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', title)
    const close = () => this.closeOverlay()
    build(card, close)
    back.append(card)
    back.addEventListener('mousedown', (e) => { if (e.target === back) close() })
    document.body.append(back)
    this.overlay = back
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
    back.addEventListener('keydown', onEsc)
    card.querySelector<HTMLElement>('input,button,[tabindex]')?.focus()
  }

  /**
   * The shortcut list.
   *
   * Every shortcut here was read off the keydown handler rather than off the
   * documentation, because a help screen that lists a key the app does not
   * bind is worse than no help screen: it makes the reader doubt the keyboard
   * rather than the page. The starter space describes the same keys in prose,
   * but the starter is a document — the first thing many people do is delete
   * it, and the reference should not go with it.
   *
   * Built on .sp-overlay/.sp-card, the About dialog's shell, so it inherits
   * the dialog's scrim, escape handling and focus return rather than growing a
   * second set.
   */
  /**
   * The space as a picture: pages, and the links between them.
   *
   * The DRAWING lives in graph.ts; what is here is only what an overlay is in
   * this editor — one at a time, and it owns the keyboard while it is open
   * (`this.overlay`). Teardown rides on `overlayReflow`, which is the hook
   * `closeOverlay` already calls before it removes the node: the graph has
   * observers and an animation frame to give back, and there is no second
   * teardown path to forget about.
   */
  openGraph(): void {
    this.closeOverlay()
    const returnFocus = document.activeElement as HTMLElement | null
    const view = openGraphView({
      doc: this.store.doc,
      index: this.store.index,
      currentId: this.store.pageId,
      open: (id) => { close(); this.store.goToPage(id); this.repaint() },
      close: () => close(),
    })
    const close = () => {
      this.closeOverlay()
      document.removeEventListener('keydown', onKey, true)
      returnFocus?.focus?.()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
    }
    document.addEventListener('keydown', onKey, true)
    this.overlay = view.el
    this.overlayReflow = () => view.destroy()
    document.body.append(view.el)
    view.el.tabIndex = -1
    view.el.focus()
  }

  openHelp(): void {
    this.closeOverlay()
    const returnFocus = document.activeElement as HTMLElement | null
    const back = el('div', 'sp-overlay')
    const card = el('div', 'sp-card sp-keys')
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-modal', 'true')
    card.setAttribute('aria-label', t('Keyboard shortcuts'))

    const close = () => {
      back.remove()
      document.removeEventListener('keydown', onKey, true)
      returnFocus?.focus?.()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
    }

    const h = el('h2', 'sp-card-h', t('Keyboard shortcuts'))
    card.append(h)

    const groups: Array<[string, Array<[string, string]>]> = [
      [t('Writing'), [
        ['↵', t('A new block')],
        ['Tab / ⇧Tab', t('Indent, or move back out')],
        ['/', t('The block menu, on an empty line')],
        ['[[', t('Link to another page')],
        ['⌘Z / ⇧⌘Z', t('Undo, redo')],
      ]],
      [t('Formatting'), [
        ['⌘B', t('Bold')],
        ['⌘I', t('Italic')],
        ['⌘U', t('Underline')],
        ['⇧⌘S', t('Strikethrough')],
        ['⌘E', t('Code')],
        ['⇧⌘H', t('Highlight')],
        ['⌘K', t('Link the selected words')],
      ]],
      [t('Getting around'), [
        ['⌘K', t('Search all pages, with nothing selected')],
        ['⌘F', t('Find and replace')],
        ['⌘⌥N', t('New page')],
        ['⌘⇧J', t("Today's journal")],
        ['⌘⇧I', t('New issue')],
      ]],
      [t('The workspace'), [
        ['[', t('Show or hide the page list')],
        [']', t('Show or hide properties')],
        ['⌘S', t('Save')],
        ['⌘P', t('Print or save as PDF')],
        ['?', t('This list')],
        ['Esc', t('Leave the reading view')],
      ]],
    ]

    // Two columns where there is room. In one column the four groups run to
    // 23 rows and the last three fall off the bottom of the card — a help
    // screen that hides the help, which is the same defect this pass just took
    // out of the share panel. The grid collapses to one column on a phone,
    // where scrolling a list is what you expect anyway.
    const grid = el('div', 'sp-keys-grid')
    for (const [title, rows] of groups) {
      const g = el('section', 'sp-keys-g')
      g.append(el('h3', 'sp-keys-h', title))
      const list = el('dl', 'sp-keys-list')
      for (const [key, what] of rows) {
        const dt = el('dt', '', '')
        dt.append(el('kbd', 'sp-kbd', key))
        list.append(dt, el('dd', '', what))
      }
      g.append(list)
      grid.append(g)
    }
    card.append(grid)

    back.append(card)
    back.addEventListener('click', (e) => { if (e.target === back) close() })
    document.addEventListener('keydown', onKey, true)
    document.body.append(back)
    card.tabIndex = -1
    card.focus()
  }

  /**
   * Place a popover AND keep it placed.
   *
   * place() sizes a popover to the room the window has right now, so its answer
   * stops being true the moment the window changes. Stale in the small-to-large
   * direction merely misplaces a box; stale the other way CLIPS it, which is
   * the bug this change exists to remove — the 44vh it replaces at least
   * tracked the viewport. Both popover call sites go through here so neither
   * can forget.
   */
  private placed(pop: HTMLElement, anchor: HTMLElement): void {
    place(pop, anchor)
    const reflow = () => place(pop, anchor)
    addEventListener('resize', reflow)
    this.overlayReflow = () => removeEventListener('resize', reflow)
  }

  /**
   * Put a property on this page — and define it, if it does not exist yet.
   *
   * THE SCHEMA IS EDITED WHERE IT IS USED. `doc.fields` has been a per-document
   * vocabulary since the tracker shipped, and nothing has ever written it: the
   * only way to give a page a property was "Make this page an issue", which
   * adds Status, Priority, Assignee and Estimate together or not at all. So the
   * schema was configurable in the format and fixed in the app.
   *
   * A separate schema editor would have been the obvious fix and the wrong one.
   * DEFAULT_FIELDS says it in its own comment — "a tracker you have to design
   * before you can use it is the thing everybody hates about the alternatives"
   * — so a property is created in passing, at the moment somebody wants one,
   * and the vocabulary grows as a side effect of use. That is what lets one
   * space hold a reading list, a film log and a backlog at once: the fields are
   * a flat vocabulary and each page carries only the ones it uses.
   */
  openAddProperty(pageId: string, anchor: HTMLElement): void {
    const s = this.store
    if (s.readOnly) return
    const page = s.index.page.get(pageId)
    if (!page) return

    this.popover(anchor, (pop) => {
      const has = new Set(page.blocks
        .filter((b) => b.type === 'prop')
        .map((b) => String((b as { key?: unknown }).key ?? '')))

      const put = (f: FieldSpec, fields?: FieldSpec[]) => {
        s.commit(() => {
          if (fields) (s.doc as { fields?: FieldSpec[] }).fields = fields
          const p = s.index.page.get(pageId)
          if (!p) return
          p.blocks.splice(headerLength(p), 0, propBlock(f, f.def ?? '', newBlock('prop').id))
        })
        this.closeOverlay()
        this.repaint()
        this.status(t('Added {name}', { name: f.label }))
      }

      const spare = fieldsOf(s.doc).filter((f) => !has.has(f.key))
      if (spare.length) {
        pop.append(el('div', 'sp-pop-title', t('Add a property')))
        for (const f of spare) {
          pop.append(this.menuItem('tag', f.label, fieldTypeLabel(f.vt), () => put(f)))
        }
      }

      pop.append(el('div', 'sp-pop-title', t('New property')))
      const form = el('div', 'sp-newprop')
      const name = document.createElement('input')
      name.type = 'text'
      name.className = 'sp-input'
      name.placeholder = t('Name')
      const type = document.createElement('select')
      type.className = 'sp-select'
      for (const vt of FIELD_TYPES) {
        const o = document.createElement('option')
        o.value = vt
        o.textContent = fieldTypeLabel(vt)
        type.append(o)
      }
      type.value = 'text'
      const add = el('button', 'sp-btn sp-primary', t('Add'))
      const submit = () => {
        const label = name.value.trim()
        if (!label) { name.focus(); return }
        const spec: FieldSpec = { key: freeFieldKey(s.doc, label), label, vt: type.value as FieldSpec['vt'] }
        put(spec, withField(s.doc, spec))
      }
      add.addEventListener('click', submit)
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } })
      form.append(name, type, add)
      pop.append(form)
      afterPaint(() => name.focus())
    })
  }

  private closeOverlay(): void {
    this.overlayReflow?.()
    this.overlayReflow = null
    this.overlay?.remove()
    this.overlay = null
  }

  /**
   * Make a popover dismissible and reachable from the keyboard.
   *
   * The tone and language pickers set `this.overlay` and installed only a
   * mousedown-away listener — and `onKey` early-returns while an overlay is
   * open, so Escape did nothing and Tab walked off into the page behind. That
   * is a keyboard trap: a menu you can open without a mouse and cannot close
   * without one. The slash menu got this right by focusing its own input; these
   * two have no input, so the popover itself takes focus.
   */
  private trapAndClose(pop: HTMLElement, returnTo?: () => void): void {
    pop.tabIndex = -1
    pop.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      this.closeOverlay()
      returnTo?.()
    })
    // focus AFTER the browser has laid the popover out, or the focus is lost to
    // the element the click came from
    afterPaint(() => pop.focus())
  }

  /** Anchor a popover to a rect, kept inside the viewport. */

  /** ⌘K — search every page, including collapsed toggles and archived pages. */
  openSearch(): void {
    const s = this.store
    this.openOverlay(t('Search'), (card, close) => {
      const input = document.createElement('input')
      input.className = 'sp-find'
      input.placeholder = t('Search all pages…')
      const results = el('ul', 'sp-results')
      const run = () => {
        const q = input.value.trim().toLowerCase()
        results.innerHTML = ''
        if (!q) return
        let n = 0
        for (const p of s.doc.pages) {
          const hits: string[] = []
          if (p.title.toLowerCase().includes(q)) hits.push(p.title)
          for (const b of p.blocks) {
            const text = textOf(b.html)
            if (text.toLowerCase().includes(q)) hits.push(text)
            if (hits.length > 2) break
          }
          if (!hits.length) continue
          if (++n > 30) break
          const li = document.createElement('li')
          const a = document.createElement('button')
          a.className = 'sp-result'
          a.innerHTML =
            `<span class="sp-result-ico">${ICONS.page}</span>` +
            `<span class="sp-result-txt"><strong>${escapeHtml(p.title || t('Untitled'))}` +
            (p.archived ? ` <em class="sp-arch">${t('archived')}</em>` : '') + `</strong>` +
            `<span>${escapeHtml(hits.slice(0, 2).join(' · ').slice(0, 140))}</span></span>`
          a.addEventListener('click', () => { close(); s.goToPage(p.id) })
          li.append(a)
          results.append(li)
        }
        if (!results.childElementCount) results.append(el('li', 'sp-noresult', t('Nothing found')))
      }
      input.addEventListener('input', run)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') results.querySelector<HTMLElement>('.sp-result')?.click()
      })
      card.append(el('h2', 'sp-card-h', t('Search this space')), input, results)
    })
  }

  /**
   * The block menu, anchored where you are.
   *
   * A centred modal for "turn this line into a heading" loses the thing you
   * were pointing at. This opens beside the caret (or the gutter button that
   * summoned it), is driven entirely by the keyboard, and filters as you type
   * so `/h2` reaches a heading without the hand leaving the keys.
   */
  private openSlash(blockId: string, anchor?: HTMLElement): void {
    this.closeOverlay()
    const pop = el('div', 'sp-pop')
    pop.setAttribute('role', 'listbox')
    const find = document.createElement('input')
    find.className = 'sp-find'
    find.placeholder = t('Filter blocks…')
    const list = el('ul', 'sp-results')
    pop.append(find, list)

    let items = SLASH_ITEMS
    let sel = 0
    const commit = (item: typeof SLASH_ITEMS[number]) => {
      this.closeOverlay()
      const blk = this.store.block(blockId)
      // the "/" that opened the menu is a command, not content
      if (blk && (blk.html ?? '').trim() === '/') blk.html = ''
      if (item.type === 'pagelink') this.insertPageCard(blockId)
      else if (item.type === 'link') { this.setType(blockId, 'link'); this.openLinkCard(blockId) }
      else this.setType(blockId, item.type)
    }
    const paint = () => {
      list.innerHTML = ''
      items.forEach((item, i) => {
        const li = document.createElement('li')
        const b = document.createElement('button')
        b.className = 'sp-result' + (i === sel ? ' sp-sel' : '')
        b.type = 'button'
        b.setAttribute('role', 'option')
        b.innerHTML =
          `<span class="sp-result-ico">${ICONS[item.icon]}</span>` +
          `<span class="sp-result-txt"><strong>${escapeHtml(t(item.label))}</strong>` +
          `<span>${escapeHtml(t(item.hint))}</span></span>`
        b.addEventListener('click', () => commit(item))
        li.append(b)
        list.append(li)
      })
      if (!items.length) list.append(el('li', 'sp-noresult', t('No block matches')))
    }
    find.addEventListener('input', () => {
      const q = find.value.trim().toLowerCase()
      items = SLASH_ITEMS.filter((i) => t(i.label).toLowerCase().includes(q) || i.type.includes(q))
      sel = 0
      paint()
    })
    find.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); paint() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint() }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) commit(items[sel]) }
      else if (e.key === 'Escape') { e.preventDefault(); this.closeOverlay(); this.focusBlock(blockId) }
    })
    paint()

    document.body.append(pop)
    this.overlay = pop
    place(pop, anchor ?? caretRect())
    find.focus()

    // clicking anywhere else dismisses, but not the first click that opened it
    setTimeout(() => {
      const away = (ev: MouseEvent) => {
        if (!pop.contains(ev.target as Node)) { this.closeOverlay(); document.removeEventListener('mousedown', away) }
      }
      document.addEventListener('mousedown', away)
    }, 0)
  }

  private insertPageCard(blockId: string): void {
    this.openPagePicker(blockId, null, (pageId) => {
      this.store.commit(() => {
        const b = this.store.block(blockId)
        if (b) { b.type = 'pagelink'; b.page = pageId; b.html = '' }
      })
      this.paintPage()
    })
  }

  /**
   * THE ONE WRITER for a link card's fields.
   *
   * Fields and `html` move together, always — the same rule as a field value
   * (applyField above), for the same reason: `html` is what a build that has
   * never heard of `link` renders, and format additivity is a promise about
   * what OLD builds do. A card whose fields were written without it is a card
   * that vanishes when the file is opened in last year's shell.
   */
  private applyLinkCard(b: Block, next: Partial<Block>): void {
    b.type = 'link'
    for (const k of ['url', 'title', 'desc', 'site', 'icon', 'image'] as const) {
      const v = next[k]
      // an EMPTY field is an absent field: a card carrying `"desc": ""` is
      // bytes in every copy of the file that say nothing
      if (typeof v === 'string' && v.trim()) (b as Record<string, unknown>)[k] = v.trim()
      else delete (b as Record<string, unknown>)[k]
    }
    b.html = linkCardHtml(linkCard(b))
  }

  /**
   * The link card's editor — and the whole of this feature's honesty.
   *
   * A link card in Notion or Slack is a SERVER fetching the url and reading its
   * OpenGraph tags. There is no server here, and a fetch on this path would
   * break the one promise the format is built on. So the author fills the card
   * in, the dialog says so plainly, and nothing about opening a space ever
   * contacts the site it links to.
   */
  private openLinkCard(blockId: string): void {
    const s = this.store
    if (s.readOnly || this.reading) return
    const at = s.block(blockId)
    if (!at) return
    // a draft, so Escape leaves the block exactly as it was
    const draft: Record<string, string> = {
      url: String(at.url ?? ''), title: String(at.title ?? ''),
      desc: String(at.desc ?? ''), site: String(at.site ?? ''),
      icon: String(at.icon ?? ''), image: String(at.image ?? ''),
    }

    this.openOverlay(t('Link card'), (card, close) => {
      card.append(el('h2', 'sp-card-h', t('Link card')))

      const why = document.createElement('p')
      why.className = 'sp-note'
      why.textContent = t('Nothing is fetched. A card shows what you type here — opening this space never contacts the site.')
      card.append(why)

      const field = (key: string, label: string, hint?: string): HTMLInputElement => {
        const wrap = el('div', 'sp-field')
        wrap.append(el('label', 'sp-field-lbl', label))
        const input = document.createElement('input')
        input.className = 'sp-input'
        input.value = draft[key]
        if (hint) input.placeholder = hint
        input.addEventListener('input', () => { draft[key] = input.value })
        wrap.append(input)
        card.append(wrap)
        return input
      }

      const url = field('url', t('Web address'), 'https://example.com')
      url.type = 'url'
      field('title', t('Title'), t('What this is'))
      field('desc', t('Description'), t('One line about what is there'))
      // the host is what shows when this is blank, so the placeholder is the
      // answer rather than an example
      field('site', t('Site name'), t('Taken from the address if blank'))
      field('icon', t('Icon'), t('One emoji'))

      // THE THUMBNAIL IS EMBEDDED, never linked. `prepareImage` downscales and
      // `internAsset` stores the bytes in the file, exactly as an image block
      // does — which is why a card can carry a picture at all without becoming
      // a request on open.
      const row = el('div', 'sp-actions')
      const pick = document.createElement('button')
      pick.className = 'sp-btn'
      pick.type = 'button'
      const paintPick = () => {
        pick.textContent = draft.image ? t('Replace picture') : t('Add a picture')
        drop.hidden = !draft.image
      }
      pick.addEventListener('click', () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.addEventListener('change', () => {
          const file = input.files?.[0]
          if (!file) return
          void (async () => {
            try {
              const prepared = await prepareImage(file)
              draft.image = await internAsset(s.doc, prepared.dataUri)
            } catch { this.status(t('That file could not be read as an image')); return }
            paintPick()
          })()
        })
        input.click()
      })
      const drop = document.createElement('button')
      drop.className = 'sp-btn'
      drop.type = 'button'
      drop.textContent = t('Remove the picture')
      drop.addEventListener('click', () => { draft.image = ''; paintPick() })
      paintPick()
      row.append(pick, drop)
      card.append(row)

      const done = el('div', 'sp-actions')
      const save = document.createElement('button')
      save.className = 'sp-btn sp-primary'
      save.type = 'button'
      save.textContent = t('Save')
      save.addEventListener('click', () => {
        close()
        s.commit(() => { const b = s.block(blockId); if (b) this.applyLinkCard(b, draft) })
        this.paintPage()
      })
      done.append(save)
      card.append(done)
      url.focus()
    })
  }

  /** `[[` — pick a page, or make one, and link it inline. */
  private openPagePicker(blockId: string, host: HTMLElement | null, then?: (pageId: string) => void): void {
    const s = this.store
    this.openOverlay(t('Link to page'), (card, close) => {
      const input = document.createElement('input')
      input.className = 'sp-find'
      input.placeholder = t('Find or create a page…')
      const list = el('ul', 'sp-results')
      const choose = (pageId: string, title: string) => {
        close()
        if (then) { then(pageId); return }
        if (!host) return
        // the two "[" that opened the picker are not content
        const html = (host.innerHTML ?? '').replace(/\[?\[$/, '')
        const link = `<a href="#p/${pageId}">${escapeHtml(title)}</a>&nbsp;`
        s.commit(() => { const b = s.block(blockId); if (b) b.html = sanitizeInline(html + link) })
        this.paintPage()
        this.focusBlock(blockId)
      }
      const run = () => {
        const q = input.value.trim().toLowerCase()
        list.innerHTML = ''
        for (const p of s.doc.pages) {
          if (q && !p.title.toLowerCase().includes(q)) continue
          const li = document.createElement('li')
          const b = document.createElement('button')
          b.className = 'sp-result'
          b.type = 'button'
          b.innerHTML =
            `<span class="sp-result-ico">${ICONS.page}</span>` +
            `<span class="sp-result-txt"><strong>${escapeHtml(p.title || t('Untitled'))}</strong></span>`
          b.addEventListener('click', () => choose(p.id, p.title || t('Untitled')))
          li.append(b)
          list.append(li)
          if (list.childElementCount > 20) break
        }
        if (input.value.trim()) {
          const li = document.createElement('li')
          const b = document.createElement('button')
          b.className = 'sp-result sp-new'
          b.type = 'button'
          b.innerHTML =
            `<span class="sp-result-ico">${ICONS.plus}</span>` +
            `<span class="sp-result-txt"><strong>${escapeHtml(t('Create “{name}”', { name: input.value.trim() }))}</strong></span>`
          b.addEventListener('click', () => {
            const page = newPage(input.value.trim())
            s.commit(() => { s.doc.pages.push(page) })
            choose(page.id, page.title)
          })
          li.append(b)
          list.append(li)
        }
      }
      input.addEventListener('input', run)
      card.append(input, list)
      run()
    })
  }

  /** Pick a page icon from the stylised set. */
  private openIconPicker(pageId: string, anchor: HTMLElement): void {
    this.closeOverlay()
    const pop = el('div', 'sp-pop sp-iconpop')
    for (const name of PAGE_ICONS) {
      const b = document.createElement('button')
      b.className = 'sp-iconopt'
      b.type = 'button'
      b.innerHTML = ICONS[name]
      b.title = name
      b.setAttribute('aria-label', name)
      b.addEventListener('click', () => {
        this.closeOverlay()
        this.store.commit(() => {
          const p = this.store.index.page.get(pageId)
          if (p) p.icon = name
        })
        this.paintPage()
      })
      pop.append(b)
    }
    document.body.append(pop)
    this.overlay = pop
    place(pop, anchor)
    setTimeout(() => {
      const away = (ev: MouseEvent) => {
        if (!pop.contains(ev.target as Node)) { this.closeOverlay(); document.removeEventListener('mousedown', away) }
      }
      document.addEventListener('mousedown', away)
    }, 0)
  }

  /**
   * Which kind of callout this is, and (optionally) a glyph of your own.
   *
   * Five tones and one field, anchored on the chip you clicked. The icon is a
   * plain text box rather than an emoji grid: the system emoji picker is one
   * keystroke away on every platform this runs on, and a grid of our own would
   * be a few KB to ship a worse one.
   */
  private openTonePicker(blockId: string, anchor: HTMLElement): void {
    const s = this.store
    const b = s.block(blockId)
    if (!b || s.readOnly || this.reading) return
    this.closeOverlay()
    const pop = el('div', 'sp-pop sp-tonepop')
    pop.setAttribute('role', 'menu')
    this.trapAndClose(pop, () => this.focusBlock(blockId))

    const current = String(b.tone ?? 'note')
    for (const tone of CALLOUT_TONES) {
      const btn = document.createElement('button')
      btn.className = 'sp-dditem sp-toneopt' + (tone.tone === current ? ' sp-sel' : '')
      btn.type = 'button'
      btn.setAttribute('role', 'menuitemradio')
      btn.setAttribute('aria-checked', String(tone.tone === current))
      btn.innerHTML =
        `<span class="sp-result-ico sp-tone-${tone.tone}">${ICONS[tone.icon]}</span>` +
        `<span class="sp-result-txt"><strong>${escapeHtml(toneLabel(tone.tone))}</strong></span>`
      btn.addEventListener('click', () => {
        this.closeOverlay()
        s.commit(() => { const bb = s.block(blockId); if (bb) bb.tone = tone.tone })
        this.paintPage()
      })
      pop.append(btn)
    }

    const row = el('label', 'sp-tonerow')
    const icon = document.createElement('input')
    icon.className = 'sp-find sp-toneicon'
    icon.value = typeof b.icon === 'string' ? b.icon : ''
    icon.maxLength = 16
    icon.placeholder = t('Leave it empty to use the tone mark')
    icon.setAttribute('aria-label', t('Callout icon'))
    // `change`, not `input`: one commit when the field is done with, rather
    // than one undo entry per keystroke of a pasted emoji
    icon.addEventListener('change', () => {
      const v = icon.value.trim()
      s.commit(() => {
        const bb = s.block(blockId)
        if (!bb) return
        if (v) bb.icon = v
        else delete bb.icon
      })
      this.paintPage()
    })
    icon.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); icon.blur(); this.closeOverlay() }
    })
    row.append(el('span', 'sp-tonelabel', t('Icon')), icon)
    pop.append(row)

    document.body.append(pop)
    this.overlay = pop
    place(pop, anchor)
    setTimeout(() => {
      const away = (ev: MouseEvent) => {
        if (!pop.contains(ev.target as Node)) { this.closeOverlay(); document.removeEventListener('mousedown', away) }
      }
      document.addEventListener('mousedown', away)
    }, 0)
  }

  /** Rename, archive, or delete one page. */
  private openPageMenu(pageId: string, anchor: HTMLElement): void {
    const s = this.store
    const page = s.index.page.get(pageId)
    if (!page) return
    this.closeOverlay()
    const pop = el('div', 'sp-pop')
    pop.setAttribute('role', 'menu')

    pop.append(this.menuItem('edit', t('Rename'), '', () => {
      this.closeOverlay()
      s.goToPage(pageId)
      afterPaint(() => {
        const h = this.main.querySelector<HTMLElement>('[data-page-title]')
        if (h) { h.focus(); selectAll(h) }
      })
    }))

    pop.append(this.menuItem('plus', t('New page inside'), '', () => {
      this.closeOverlay()
      this.newPage(pageId)
    }))

    // A thread about the PAGE — the second and last anchor. It is offered
    // where the page's own actions are, and only for the page in view,
    // because a thread is written into the page you are looking at.
    if (pageId === s.pageId && !s.readOnly) {
      pop.append(this.menuItem('comment', t('Comment on this page'), '', () => {
        this.closeOverlay()
        this.comments.openNew()
      }))
    }

    pop.append(this.menuItem(page.archived ? 'unarchive' : 'archive',
      page.archived ? t('Restore to the page list') : t('Archive'),
      page.archived ? '' : t('Out of the sidebar, still searchable and linkable'), () => {
        this.closeOverlay()
        s.commit(() => {
          const p = s.index.page.get(pageId)
          if (!p) return
          if (p.archived) delete p.archived
          else p.archived = true
        })
      }))

    // HOW WIDE THIS PAGE IS. The renderer already varied it — a page carrying a
    // board jumped to 1500px — but it decided for you silently. Measured at a
    // 1600px viewport: the default column is 720px with 631px of the page left
    // empty beside it, and nothing on the starter pages even reaches the limit
    // (0 of 15 blocks wrap). The line length was never the problem; having no
    // say was.
    pop.append(el('div', 'sp-menu-label', t('Width')))
    const current: 'normal' | 'wide' | 'full' =
      page.width === 'wide' ? 'wide' : page.width === 'full' ? 'full' : 'normal'
    const setWidth = (v: 'normal' | 'wide' | 'full') => {
      this.closeOverlay()
      s.commit(() => {
        const pg = s.index.page.get(pageId)
        if (!pg) return
        // THE DEFAULT IS AN ABSENT KEY, never a stored 'normal'. A page somebody
        // set to wide and back is then byte-identical to one never touched, and
        // a file written before this control existed stays that way.
        if (v === 'normal') delete pg.width
        else pg.width = v
      }, { scope: 'doc' })
      this.paintPage()
    }
    pop.append(this.menuItem('widthNarrow', t('Column'), t('Comfortable for reading'),
      () => setWidth('normal'), { selected: current === 'normal' }))
    pop.append(this.menuItem('widthWide', t('Wide'), t('Room for a board or a table'),
      () => setWidth('wide'), { selected: current === 'wide' }))
    pop.append(this.menuItem('widthFull', t('Full width'), t('Fills the window'),
      () => setWidth('full'), { selected: current === 'full' }))

    // AND THE SAME CHOICE, FOR EVERY PAGE. Setting a width page by page answers
    // "this page needs the room"; it does not answer "I have a wide screen",
    // which is one fact about one person and was costing a visit to every page
    // in the space. This one is a VIEWER preference — localStorage, never the
    // file — so it follows the reader rather than the document, and somebody
    // opening the same space on a laptop is unaffected.
    const pref = readerWidth()
    const applyAll = (v: 'wide' | 'full' | undefined) => {
      this.closeOverlay()
      setReaderWidth(v)
      this.paintPage()
      this.status(v ? t('Every page opens wide on this screen from now on')
                    : t('Pages open at their normal width again'))
    }
    pop.append(this.menuItem(pref ? 'widthNarrow' : 'widthWide',
      pref ? t('Stop widening every page') : t('Use this width for every page'),
      pref ? t('Only pages that ask for it') : t('On this screen only — it is not saved in the file'),
      () => applyAll(pref ? undefined : (current === 'full' ? 'full' : 'wide'))))

    pop.append(this.menuItem('trash', t('Delete…'), t('Links to it become dead'), () => {
      this.closeOverlay()
      this.deletePage(pageId)
    }))

    document.body.append(pop)
    this.overlay = pop
    place(pop, anchor)
    setTimeout(() => {
      const away = (ev: MouseEvent) => {
        if (!pop.contains(ev.target as Node)) { this.closeOverlay(); document.removeEventListener('mousedown', away) }
      }
      document.addEventListener('mousedown', away)
    }, 0)
  }

  /**
   * Delete a page.
   *
   * Its children are re-homed to ITS parent rather than deleted with it —
   * removing a middle page should not silently take a subtree the author was
   * not looking at. Inbound links are counted in the confirmation, because
   * "this will break 4 links" is the fact that decides it.
   */
  private deletePage(pageId: string): void {
    const s = this.store
    const page = s.index.page.get(pageId)
    if (!page) return
    if (s.doc.pages.length <= 1) { this.status(t('A space needs at least one page')); return }
    const inbound = (s.index.backlinks.get(pageId) ?? []).length
    const kids = s.doc.pages.filter((p) => p.parent === pageId).length
    const parts = [t('Delete “{name}”?', { name: page.title || t('Untitled') })]
    if (inbound) parts.push(t('{n} link(s) to it will stop working.', { n: inbound }))
    if (kids) parts.push(t('{n} page(s) inside it move up a level.', { n: kids }))
    if (!confirm(parts.join('\n'))) return
    s.commit(() => {
      for (const p of s.doc.pages) if (p.parent === pageId) {
        if (page.parent) p.parent = page.parent
        else delete p.parent
      }
      s.doc.pages.splice(s.doc.pages.findIndex((p) => p.id === pageId), 1)
      if (s.doc.home === pageId) delete s.doc.home
    })
    this.repaint()
  }

  // ---- images --------------------------------------------------------------
  /** Choose a file and put it in the document. */
  async pickImage(blockId: string): Promise<void> {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file) void this.placeImage(blockId, file)
    })
    input.click()
  }

  /**
   * Embed one image.
   *
   * Everything slow and asynchronous — reading, decoding, re-encoding, hashing
   * — happens BEFORE the commit, so the bytes and the reference land in ONE
   * synchronous mutation. That is what makes an image insert a single undo
   * step instead of a half-inserted block if something throws in between.
   */
  async placeImage(
    blockId: string | null,
    file: File | Blob,
    opts: { keepOriginal?: boolean; insertAfter?: string | null } = {},
  ): Promise<void> {
    const s = this.store
    this.status(t('Reading image…'))
    let prepared
    try {
      prepared = opts.keepOriginal
        ? { dataUri: await blobToDataUri(file), w: 0, h: 0, original: true, wasBytes: file.size }
        : await prepareImage(file)
    } catch {
      this.status(t('That file could not be read as an image'))
      return
    }

    if (prepared.dataUri.length > IMAGE_EMBED_BUDGET) {
      const ok = confirm(t(
        'This image is {size} and travels inside the file, making it that much bigger for everyone you send it to. Embed it anyway?',
        { size: humanBytes(prepared.dataUri.length) },
      ))
      if (!ok) { this.status(''); return }
    }

    const ref = await internAsset(s.doc, prepared.dataUri)
    const fill = (b: Block) => {
      b.type = 'image'
      b.src = ref
      b.html = ''
      if (prepared.w) { b.w = prepared.w; b.h = prepared.h }
      if (!prepared.original) b.original = false
      else delete b.original
    }
    // ONE commit, whether the block already exists or is being created here.
    // Creating it in a separate commit would make an inserted image take TWO
    // undos, the second of which removes a block the author never saw.
    s.commit(() => {
      if (blockId) { const b = s.block(blockId); if (b) fill(b) ; return }
      const page = s.page
      if (!page) return
      const fresh = newBlock('image')
      fill(fresh)
      const at = opts.insertAfter ? page.blocks.findIndex((b) => b.id === opts.insertAfter) + 1 : page.blocks.length
      page.blocks.splice(at < 1 ? page.blocks.length : at, 0, fresh)
    })
    this.paintPage()
    this.status(prepared.original
      ? t('Image added ({size})', { size: humanBytes(prepared.dataUri.length) })
      : t('Image added, resized to fit ({from} → {to})', {
        from: humanBytes(prepared.wasBytes), to: humanBytes(prepared.dataUri.length),
      }))
  }

  /**
   * Drop or paste an image — or a clip — straight onto the page.
   *
   * Images win a tie. A drag that carries both (a screenshot alongside a
   * screen recording, which is what a Finder multi-select of a bug report
   * looks like) takes the image, because that is the one an author is far more
   * often reaching for and the one that costs nothing to be wrong about.
   */
  private async fileFromTransfer(dt: DataTransfer | null, afterId?: string): Promise<boolean> {
    const pick = (kind: string): File | undefined =>
      [...(dt?.files ?? [])].find((f) => f.type.startsWith(kind))
      ?? [...(dt?.items ?? [])].filter((i) => i.type.startsWith(kind)).map((i) => i.getAsFile())[0]
      ?? undefined
    if (!this.store.page) return false
    const img = pick('image/')
    if (img) { await this.placeImage(null, img, { insertAfter: afterId ?? null }); return true }
    const clip = pick('video/') ?? pick('audio/')
    if (!clip) return false
    await this.placeMedia(null, clip, { insertAfter: afterId ?? null })
    return true
  }

  // ---- video and audio -------------------------------------------------------
  /**
   * Choose a clip and put it in the document.
   *
   * `accept` names both kinds and the KIND IS READ BACK OFF THE FILE, never
   * asked for. A picker that made you say "video" first would be a question
   * the file already answers, and answers correctly for the odd cases — an
   * .m4a that a phone wrote as video/mp4 plays either way.
   */
  async pickMedia(blockId: string): Promise<void> {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'video/*,audio/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file) void this.placeMedia(blockId, file)
    })
    input.click()
  }

  /**
   * Embed one clip.
   *
   * Shaped like placeImage and for the same reason: everything asynchronous —
   * reading the bytes, hashing them — happens BEFORE the commit, so the asset
   * and the reference land in one synchronous mutation and one undo step.
   *
   * NOTHING IS RE-ENCODED. prepareImage exists because a phone photo is 4000px
   * wide in a 720px column and the detail is invisible; there is no equivalent
   * cheap win for video, and transcoding in a browser tab means shipping an
   * encoder and taking minutes over it. So a clip is either small enough to
   * embed or a link — which is what MEDIA_EMBED_BUDGET asks about.
   */
  async placeMedia(
    blockId: string | null,
    file: File | Blob,
    opts: { insertAfter?: string | null } = {},
  ): Promise<void> {
    const s = this.store
    this.status(t('Reading file…'))
    let dataUri: string
    try {
      dataUri = await blobToDataUri(file)
    } catch {
      this.status(t('That file could not be read'))
      return
    }
    const kind = (file as File).type?.startsWith('audio/') ? 'audio' : 'video'

    if (dataUri.length > MEDIA_EMBED_BUDGET) {
      // A browser file picker hands over BYTES, never a path, so "keep it on
      // disk and point at it" is not a thing this can offer. The honest
      // alternatives are: embed it anyway, or paste a URL — which is what the
      // block's own chooser offers, and where a no lands you.
      const go = confirm(t(
        'This clip is {size} and travels inside the file, making it that much bigger for everyone you send it to. Embed it anyway?',
        { size: humanBytes(dataUri.length) },
      ))
      if (!go) { this.status(''); return }
    }

    const ref = await internAsset(s.doc, dataUri)
    this.writeMedia(blockId, opts.insertAfter ?? null, (b) => { b.src = ref; b.kind = kind })
    this.status(t('Clip added ({size})', { size: humanBytes(dataUri.length) }))
  }

  /**
   * The escape hatch: a clip that lives somewhere else.
   *
   * The only way to have a small file with a big video in it, and the reason
   * `src` is hybrid at all. It is a real trade and it is stated at the point of
   * the decision — a linked clip needs the network to play, and asking for it
   * tells that host somebody opened the space, which is why the READER is
   * asked before it loads (render.ts).
   */
  linkMedia(blockId: string | null, insertAfter: string | null = null): void {
    const url = prompt(t('Address of a video or audio file'))?.trim()
    if (!url) return
    // http(s) only, and checked HERE as well as in the sanitizer: `src` is not
    // inline html, so it never passes through sanitize.ts at all — a
    // `javascript:` typed into this box would be written straight onto the
    // element. The allowlist is the test, never a `javascript:` blocklist.
    if (!/^https?:\/\//i.test(url)) { this.status(t('That needs to be an http or https address')); return }
    const kind = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)(\?|#|$)/i.test(url) ? 'audio' : 'video'
    this.writeMedia(blockId, insertAfter, (b) => { b.src = url; b.kind = kind })
    this.status('')
  }

  /** ONE commit, whether the block exists already or is being created here —
   *  the placeImage rule: an inserted clip must not cost two undos. */
  private writeMedia(blockId: string | null, insertAfter: string | null, fill: (b: Block) => void): void {
    const s = this.store
    const apply = (b: Block) => {
      b.type = 'media'
      b.html = ''
      fill(b)
    }
    s.commit(() => {
      if (blockId) { const b = s.block(blockId); if (b) apply(b); return }
      const page = s.page
      if (!page) return
      const fresh = newBlock('media')
      apply(fresh)
      const at = insertAfter ? page.blocks.findIndex((b) => b.id === insertAfter) + 1 : page.blocks.length
      page.blocks.splice(at < 1 ? page.blocks.length : at, 0, fresh)
    })
    this.paintPage()
  }

  /** A still frame for a video — the same pipeline an image goes through, so
   *  it is downscaled and content-addressed like any other picture. */
  private async pickPoster(blockId: string): Promise<void> {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      void (async () => {
        this.status(t('Reading image…'))
        let prepared
        try { prepared = await prepareImage(file) } catch {
          this.status(t('That file could not be read as an image')); return
        }
        const ref = await internAsset(this.store.doc, prepared.dataUri)
        this.store.commit(() => { const b = this.store.block(blockId); if (b) b.poster = ref })
        this.paintPage()
        this.status('')
      })()
    })
    input.click()
  }

  /**
   * The picture across the top of a page.
   *
   * The IMAGE pipeline, not a second one: prepareImage downscales a phone photo
   * before it travels, internAsset content-addresses the bytes so two pages
   * with the same cover store it once, and the same budget asks the same
   * question at the same size. A cover is the field most likely to be given a
   * 6MB photograph — inventing a separate policy for it is how one app ends up
   * with two answers to "how big is too big".
   */
  private async pickCover(pageId: string): Promise<void> {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      void (async () => {
        const s = this.store
        if (s.readOnly) return
        this.status(t('Reading image…'))
        let prepared
        try { prepared = await prepareImage(file) } catch {
          this.status(t('That file could not be read as an image')); return
        }
        if (prepared.dataUri.length > IMAGE_EMBED_BUDGET) {
          const okay = confirm(t(
            'This image is {size} and travels inside the file, making it that much bigger for everyone you send it to. Embed it anyway?',
            { size: humanBytes(prepared.dataUri.length) },
          ))
          if (!okay) { this.status(''); return }
        }
        // hashed and interned BEFORE the commit, so the bytes and the reference
        // land in one synchronous mutation — one undo step, exactly as an image
        // block does it
        const ref = await internAsset(s.doc, prepared.dataUri)
        s.commit(() => {
          const p = s.index.page.get(pageId)
          if (p) p.cover = ref
        }, { scope: 'doc' })
        this.repaint()
        this.status(prepared.original
          ? t('Image added ({size})', { size: humanBytes(prepared.dataUri.length) })
          : t('Image added, resized to fit ({from} → {to})', {
            from: humanBytes(prepared.wasBytes), to: humanBytes(prepared.dataUri.length),
          }))
      })()
    })
    input.click()
  }

  /** No cover DELETES the key. A page whose cover was set and removed is
   *  byte-identical to one that never had one. The bytes stay in the asset
   *  table until nothing points at them — orphanAssets is what reports that,
   *  and it counts covers. */
  private removeCover(pageId: string): void {
    const s = this.store
    if (s.readOnly) return
    s.commit(() => {
      const p = s.index.page.get(pageId)
      if (p) delete p.cover
    }, { scope: 'doc' })
    this.repaint()
  }

  // ---- importing existing notes ---------------------------------------------
  /**
   * The way in.
   *
   * Two pickers rather than one, because a browser input is EITHER
   * `multiple` files OR `webkitdirectory` — there is no control that offers
   * both — and a folder is what a vault actually is. Dropping works for both
   * and is the gesture most people reach for first, so it is stated here
   * rather than left to be discovered.
   */
  openImport(): void {
    this.openOverlay(t('Bring notes in'), (card, close) => {
      card.append(el('h2', 'sp-card-h', t('Bring notes in')))

      const what = document.createElement('p')
      what.className = 'sp-note'
      what.textContent = t('Each .md file becomes a page, folders become the page tree, and [[wikilinks]] become real links. Pages are added — nothing here is replaced.')
      card.append(what)

      // WHERE the arriving pages land, and it governs BOTH ways in. An import
      // that can only append at the root is an import into a pile: the point of
      // a space is the tree, and "under the page I am reading" is what somebody
      // taking a second set of notes into a working space actually means.
      const under = document.createElement('select')
      under.className = 'sp-select'
      const top = document.createElement('option')
      top.value = ''
      top.textContent = t('Top level')
      under.append(top)
      for (const { page, depth } of this.store.tree()) {
        const o = document.createElement('option')
        o.value = page.id
        o.textContent = `${'· '.repeat(depth)}${page.title || t('Untitled')}`
        if (page.id === this.store.pageId) o.selected = true
        under.append(o)
      }
      const whereRow = el('div', 'sp-row')
      whereRow.append(el('span', '', t('Add pages under')), under)
      card.append(whereRow)
      const where = () => under.value || undefined

      const zone = el('div', 'sp-dropzone', t('Drop .md files or a folder here'))
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('sp-drop') })
      zone.addEventListener('dragleave', () => zone.classList.remove('sp-drop'))
      zone.addEventListener('drop', (e) => {
        e.preventDefault()
        e.stopPropagation()
        zone.classList.remove('sp-drop')
        const picked = collectDrop(e.dataTransfer)
        const at = where()
        close()
        void picked.then((files) => this.importFiles(files, { under: at }))
      })
      card.append(zone)

      const pick = (folder: boolean) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        if (folder) input.webkitdirectory = true
        else input.accept = '.md,.markdown,.mdown,.mkd,image/*'
        const at = where()
        input.addEventListener('change', () => {
          close()
          // webkitRelativePath is the folder tree; a plain multi-select has
          // none, and those files import as a flat set of pages
          void this.importFiles([...(input.files ?? [])]
            .map((file) => ({ path: file.webkitRelativePath || file.name, file })), { under: at })
        })
        input.click()
      }

      const pickSpace = () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.html,text/html,application/json'
        const at = where()
        input.addEventListener('change', () => {
          close()
          const file = input.files?.[0]
          if (file) void this.importSpace(file, at)
        })
        input.click()
      }

      const acts = el('div', 'sp-actions')
      acts.append(
        plainBtn(t('Choose .md files…'), () => pick(false), true),
        plainBtn(t('Choose a folder…'), () => pick(true)),
        plainBtn(t('Choose a space…'), pickSpace),
      )
      card.append(acts)

      const spaces = document.createElement('p')
      spaces.className = 'sp-note'
      spaces.textContent = t('Another bento/spaces file arrives as pages under the one you choose — its images come too, and the links inside it keep working.')
      card.append(spaces)

      const imgs = document.createElement('p')
      imgs.className = 'sp-note'
      // said BEFORE the import, because it is the one thing a browser cannot
      // do for them: it has no way to open `../attachments/x.png` itself
      imgs.textContent = t('Include the image files and they are embedded too. An image this browser cannot open is kept as its path rather than as a broken picture.')
      card.append(imgs)
    })
  }

  /**
   * Another space, grafted into this one — the way IN that answers the page
   * extract's way out.
   *
   * The file is UNTRUSTED and takes the ordinary load path, with no friendlier
   * door beside it: the document block is read out of an INERT parse (DOMParser
   * builds no browsing context, so no script runs and no resource loads),
   * `parseDoc` decides whether it is a space at all — refusing rather than
   * degrading, the same load contract main.ts boots under — and
   * `sanitizeInline` runs over every arriving block before any of it reaches
   * the document.
   */
  async importSpace(file: File, under?: string): Promise<void> {
    const s = this.store
    if (s.readOnly) { this.status(t('This file is open read-only')); return }
    let text: string
    try { text = await file.text() } catch { this.status(t('That file could not be read')); return }

    const body = spaceBlockOf(text)
    if (body === 'encrypted') {
      // The password is not ours to ask for, and the honest instruction is the
      // one that works: open the file where the password already is.
      this.status(t('That space is password-protected. Open it, then export the pages you want.'))
      return
    }
    const res = parseDoc(body ?? '')
    if (!res.ok) {
      this.status(res.err === 'format'
        ? t('That file is not a bento/spaces document')
        : t('That file could not be read'))
      return
    }

    const plan = planGraft(s.doc, res.doc, { under })
    // THE security gate, in the same place the Markdown import puts it.
    for (const page of plan.pages) {
      for (const b of page.blocks) if (b.html) b.html = sanitizeInline(b.html)
    }

    // ONE step: pages, images and fonts land together or not at all.
    s.commit(() => {
      s.doc.pages.push(...plan.pages)
      if (Object.keys(plan.assets).length) Object.assign((s.doc.assets ??= {}), plan.assets)
      if (plan.fonts.length) (s.doc.fonts ??= []).push(...plan.fonts)
    })
    if (plan.pages[0]) s.goToPage(plan.pages[0].id)
    this.repaint()

    this.openOverlay(t('Imported a space'), (card, close) => {
      card.append(el('h2', 'sp-card-h', t('Imported a space')))
      const lines = [
        t('{pages} page(s) and {blocks} block(s) added from that space.',
          { pages: plan.stats.pages, blocks: plan.stats.blocks }),
      ]
      // Renaming is the outcome a reader cannot see for themselves, and the one
      // that would break every link if it were done carelessly — so it is
      // reported together with the repair that keeps the links pointing right.
      if (plan.stats.renamed) {
        lines.push(t('{n} id(s) were renamed because this space already used them, and the links inside the import follow them.',
          { n: plan.stats.renamed }))
      }
      if (plan.stats.dropped) {
        lines.push(t('{n} link(s) named pages that were not in that file, and are kept as text.', { n: plan.stats.dropped }))
      }
      if (plan.stats.assets) lines.push(t('{n} image(s) came too.', { n: plan.stats.assets }))
      lines.push(t('⌘Z removes the imported pages again.'))
      for (const line of lines) {
        const p = document.createElement('p')
        p.className = 'sp-note'
        p.textContent = line
        card.append(p)
      }
      card.append(plainBtn(t('Close'), close, true))
    })
  }

  /**
   * A page — and, by choice, what is under it — leaves as its own space.
   *
   * The counts come from the REAL extract and move as the choices do, rather
   * than being described in the abstract: how much travels, and how many links
   * point out of the selection and will become text. Those two facts are what
   * decide whether this is the extract somebody meant.
   */
  openExportSpace(): void {
    const s = this.store
    this.openOverlay(t('Export a page as a space'), (card, close) => {
      card.append(el('h2', 'sp-card-h', t('Export a page as a space')))

      const what = document.createElement('p')
      what.className = 'sp-note'
      what.textContent = t('The page becomes a new file of its own: a whole space, with a new document id and none of this one’s sharing keys.')
      card.append(what)

      const pick = document.createElement('select')
      pick.className = 'sp-select'
      for (const { page, depth } of s.tree()) {
        const o = document.createElement('option')
        o.value = page.id
        o.textContent = `${'· '.repeat(depth)}${page.title || t('Untitled')}`
        if (page.id === s.pageId) o.selected = true
        pick.append(o)
      }
      const pageRow = el('div', 'sp-row')
      pageRow.append(el('span', '', t('Page')), pick)
      card.append(pageRow)

      const kids = document.createElement('input')
      kids.type = 'checkbox'
      kids.checked = true
      const kidsRow = el('div', 'sp-row')
      kidsRow.append(el('span', '', t('Include the pages nested under it')), kids)
      card.append(kidsRow)

      const summary = document.createElement('p')
      summary.className = 'sp-note'
      const recount = () => {
        const r = extractSpace(s.doc, pick.value, { subtree: kids.checked, docId: 'preview', now: '' })
        const parts = [t('{pages} page(s) and {blocks} block(s) will travel.',
          { pages: r.stats.pages, blocks: r.stats.blocks })]
        if (r.stats.unlinked) {
          parts.push(t('{n} link(s) point outside them and are kept as text naming the page they meant.',
            { n: r.stats.unlinked }))
        }
        if (r.stats.assets) parts.push(t('{n} image(s) go with them; the rest stay here.', { n: r.stats.assets }))
        summary.textContent = parts.join(' ')
      }
      pick.addEventListener('change', recount)
      kids.addEventListener('change', recount)
      recount()
      card.append(summary)

      const acts = el('div', 'sp-actions')
      acts.append(
        plainBtn(t('Export'), () => {
          const out = extractSpace(s.doc, pick.value, { subtree: kids.checked, docId: uid('doc') })
          close()
          void this.onExportSpace?.(out.doc).then((ok) => {
            if (ok) this.status(t('Exported {n} page(s) as a new space', { n: out.stats.pages }))
          })
        }, true),
        plainBtn(t('Close'), close),
      )
      card.append(acts)
    })
  }

  /**
   * Import, in ONE undoable step.
   *
   * Everything slow or asynchronous — reading files, decoding and re-encoding
   * images, hashing them — happens BEFORE the commit, so the pages, the blocks
   * and the asset references land in one synchronous mutation. The same reason
   * `placeImage` is shaped this way: a half-applied import is not something a
   * single ⌘Z could put back.
   */
  async importFiles(picked: PickedFile[], opts: { under?: string } = {}): Promise<void> {
    const s = this.store
    if (s.readOnly) { this.status(t('This file is open read-only')); return }
    const notes = picked.filter((p) => NOTE_EXT.test(p.path))
    if (!notes.length) {
      // A space is a legitimate thing to drop on the import, and it arrives by
      // the same gesture: one route in, whatever kind of notes they are.
      const space = picked.find((p) => SPACE_EXT.test(p.path))
      if (space) { await this.importSpace(space.file, opts.under); return }
      this.status(t('No Markdown files in that selection'))
      return
    }
    if (notes.length > 500 &&
      !confirm(t('That is {n} files — importing them all may take a moment. Continue?', { n: notes.length }))) return

    this.status(t('Reading {n} file(s)…', { n: notes.length }))
    let files: SourceFile[]
    try {
      files = await Promise.all(notes.map(async (p) => ({ path: p.path, text: await p.file.text() })))
    } catch {
      this.status(t('Those files could not be read'))
      return
    }

    // pages this space already has, so an incremental import links INTO it
    const existing = new Map<string, string>()
    for (const page of s.doc.pages) {
      const key = page.title.trim().toLowerCase()
      if (key && !existing.has(key)) existing.set(key, page.id)
    }
    const plan = planImport(files, {
      rootTitle: t('Imported notes'),
      resolveExisting: (target) => existing.get(target),
    })

    // ---- images ------------------------------------------------------------
    // A relative path in a .md file names a file on the author's disk, and a
    // browser cannot open it — no filesystem access, and the space will be
    // mailed away from that disk anyway. So it is resolved against what was
    // ACTUALLY selected, and when that fails the reference becomes visible
    // text instead of an <img> that can only ever be broken.
    const media = new Map<string, File>()
    const byName = new Map<string, File>()
    for (const p of picked) {
      if (NOTE_EXT.test(p.path)) continue
      const key = normPath(p.path)
      if (!media.has(key)) media.set(key, p.file)
      const name = key.slice(key.lastIndexOf('/') + 1)
      if (!byName.has(name)) byName.set(name, p.file)
    }

    let embedded = 0
    let embeddedBytes = 0
    let unresolved = 0
    let declined = 0
    let keepEmbedding = true
    let asked = false
    for (const img of plan.images) {
      const ref = decodePath(img.ref)
      const file = media.get(joinPath(img.dir, ref)) ?? byName.get(ref.slice(ref.lastIndexOf('/') + 1).toLowerCase())
      if (file && keepEmbedding && embeddedBytes > IMPORT_IMAGE_BUDGET && !asked) {
        asked = true
        keepEmbedding = confirm(t(
          'The images in these notes come to {size} so far, and they all travel inside the file. Keep embedding them?',
          { size: humanBytes(embeddedBytes) },
        ))
      }
      if (file && keepEmbedding) {
        try {
          const prepared = await prepareImage(file)
          img.block.src = await internAsset(s.doc, prepared.dataUri)
          if (prepared.w) { img.block.w = prepared.w; img.block.h = prepared.h }
          if (!prepared.original) img.block.original = false
          embedded++
          embeddedBytes += prepared.dataUri.length
          continue
        } catch { /* not a decodable image — fall through and say so */ }
      }
      // the two ways to arrive here are different facts, and the report says
      // which: we could not find/read it, or you asked us to stop
      if (file && !keepEmbedding) declined++
      else unresolved++
      img.block.type = 'p'
      delete img.block.src
      delete img.block.alt
      img.block.html = `<em>${escapeHtml(t('Image not imported'))}: </em><code>${escapeHtml(img.ref)}</code>`
    }

    // THE security gate. Everything above builds html from someone's files;
    // this is the app's real policy, with a real parser, run once over every
    // block before any of it reaches the document (see markdown.ts's header).
    for (const page of plan.pages) {
      for (const b of page.blocks) if (b.html) b.html = sanitizeInline(b.html)
    }

    // The import already lands under exactly one root (planImport wraps a mixed
    // selection); re-homing that root is the whole of "add these under this
    // page", and it keeps the one-root, one-⌘Z shape intact.
    const under = opts.under && s.index.page.has(opts.under) ? opts.under : undefined
    if (under) {
      const arrived = new Set(plan.pages.map((p) => p.id))
      for (const page of plan.pages) if (!page.parent || !arrived.has(page.parent)) page.parent = under
    }

    s.commit(() => { s.doc.pages.push(...plan.pages) })
    if (plan.pages[0]) s.goToPage(plan.pages[0].id)
    this.repaint()
    this.status(t('Imported'))

    this.openOverlay(t('Import Markdown'), (card, close) => {
      card.append(el('h2', 'sp-card-h', t('Imported')))
      const lines: string[] = [
        t('{pages} page(s) and {blocks} block(s) added from {files} file(s).',
          { pages: plan.stats.pages, blocks: plan.stats.blocks, files: plan.stats.files }),
      ]
      if (plan.stats.linked || plan.stats.dangling) {
        lines.push(t('{n} of {total} wikilink(s) resolved.',
          { n: plan.stats.linked, total: plan.stats.linked + plan.stats.dangling }))
        // two sentences, not one: "1 of 1 resolved, the rest are text" is a
        // sentence about nothing
        if (plan.stats.dangling) lines.push(t('The rest name notes that were not in the selection, and are left as text.'))
      }
      // A shared NAME is the one import outcome the reader cannot see for
      // themselves: the links look fine and point at the wrong note.
      if (plan.stats.duplicateNames) {
        lines.push(t('{n} note name(s) appear more than once, so links naming them all went to the first.',
          { n: plan.stats.duplicateNames }))
      }
      if (plan.stats.frontmatter) {
        lines.push(t('{n} page(s) had frontmatter, kept verbatim in a folded block.', { n: plan.stats.frontmatter }))
      }
      if (plan.stats.tables) {
        lines.push(t('{n} table(s) imported, with their column alignment.', { n: plan.stats.tables }))
      }
      if (embedded) lines.push(t('{n} image(s) embedded ({size}).', { n: embedded, size: humanBytes(embeddedBytes) }))
      if (unresolved) {
        lines.push(t('{n} image(s) could not be opened, so their paths are kept as text. Import again with the image files included.', { n: unresolved }))
      }
      if (declined) {
        lines.push(t('{n} image(s) were left as paths because embedding stopped there.', { n: declined }))
      }
      if (plan.stats.remoteImages) {
        lines.push(t('{n} image(s) point at the web. Nothing loads until a reader asks.', { n: plan.stats.remoteImages }))
      }
      // "removes the pages", NOT "puts the space back exactly as it was".
      // Measured: after ⌘Z the pages are byte-identical to before, but the
      // image bytes stay — undo snapshots deliberately exclude `assets`
      // (store.ts), and pruning them on undo would break REDO, which
      // re-inserts blocks pointing at those very keys.
      lines.push(t('⌘Z removes the imported pages again.'))
      for (const line of lines) {
        const p = document.createElement('p')
        p.className = 'sp-note'
        p.textContent = line
        card.append(p)
      }
      card.append(plainBtn(t('Close'), close, true))
    })
  }

  // ---- find and replace ----------------------------------------------------
  /**
   * ⌘F is OURS, not the browser's.
   *
   * Native find cannot see a collapsed toggle's body, cannot see a page that is
   * not currently rendered, and cannot see an archived page at all — which is
   * most of a space. So this searches the MODEL, jumps to each hit, expands
   * whatever was folded around it, and can replace across every page in one
   * undoable step.
   */
  openFind(): void {
    const s = this.store
    document.querySelector('.sp-findbar')?.remove()
    const bar = el('div', 'sp-findbar')
    bar.setAttribute('role', 'search')

    const q = document.createElement('input')
    q.className = 'sp-find'
    q.placeholder = t('Find in this space…')
    q.setAttribute('aria-label', t('Find'))

    const rep = document.createElement('input')
    rep.className = 'sp-find'
    rep.placeholder = t('Replace with…')
    rep.setAttribute('aria-label', t('Replace with'))

    const count = el('span', 'sp-findcount')
    const mk = (icon: IconName, label: string, fn: () => void) => {
      const b = document.createElement('button')
      b.className = 'sp-btn'
      b.type = 'button'
      b.innerHTML = ICONS[icon]
      b.title = label
      b.setAttribute('aria-label', label)
      b.addEventListener('click', fn)
      return b
    }

    // ONE ENTRY PER OCCURRENCE, not per block. The readout, the stepper and the
    // replace-all confirmation then all quote the same number — and it is the
    // number of things that will actually change, because it comes from the
    // routine that changes them (countOutsideTags / replaceOutsideTags share
    // mapTextChunks). Counting blocks meant "2 found" above a dialog offering
    // to replace 2, which then replaced 4.
    let hits: Array<{ pageId: string; blockId: string }> = []
    let at = -1

    const scan = () => {
      const needle = q.value
      hits = []
      at = -1
      if (needle) {
        for (const p of s.doc.pages) {
          for (const b of p.blocks) {
            const n = countOutsideTags(b.html, needle)
            for (let i = 0; i < n; i++) hits.push({ pageId: p.id, blockId: b.id })
          }
        }
      }
      count.textContent = hits.length ? t('{n} found', { n: hits.length }) : (needle ? t('none') : '')
    }

    const jump = (dir: 1 | -1) => {
      if (!hits.length) return
      at = (at + dir + hits.length) % hits.length
      const hit = hits[at]
      count.textContent = t('{i} of {n}', { i: at + 1, n: hits.length })

      // Unfold FIRST, then navigate — one paint, and no dependence on when a
      // repaint happens to land. Doing it the other way round meant reveal ran
      // against whichever page the store had reached by the next frame, and
      // the fold stayed shut.
      const opened = this.revealBlock(hit.pageId, hit.blockId)
      if (hit.pageId !== s.pageId) s.goToPage(hit.pageId)
      else if (opened) this.paintPage()

      afterPaint(() => {
        const node = this.main.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(hit.blockId)}"]`)
        node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        // two occurrences in one block are two stops: restart the flash, or
        // the second step looks like the stepper did nothing
        node?.classList.remove('sp-hit')
        void node?.offsetWidth
        node?.classList.add('sp-hit')
        setTimeout(() => node?.classList.remove('sp-hit'), 1400)
      })
    }

    const replaceAll = () => {
      const needle = q.value
      if (!needle || !hits.length) return
      if (!confirm(t('Replace {n} occurrence(s) across the whole space?', { n: hits.length }))) return
      // ONE commit for the whole sweep: a replace-all a user has to undo forty
      // times is not undoable in any sense they care about
      s.commit(() => {
        for (const p of s.doc.pages) {
          for (const b of p.blocks) {
            if (!countOutsideTags(b.html, needle)) continue
            b.html = replaceOutsideTags(b.html!, needle, rep.value)
          }
        }
      })
      this.repaint()
      scan()
      this.status(t('Replaced'))
    }

    q.addEventListener('input', scan)
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); jump(e.shiftKey ? -1 : 1) }
      if (e.key === 'Escape') { e.preventDefault(); bar.remove() }
    })
    rep.addEventListener('keydown', (e) => { if (e.key === 'Escape') bar.remove() })

    bar.append(q, mk('arrowUp', t('Previous (⇧⏎)'), () => jump(-1)),
      mk('arrowDown', t('Next (⏎)'), () => jump(1)), count,
      rep, mk('replace', t('Replace all'), replaceAll),
      mk('close', t('Close'), () => bar.remove()))
    this.root.append(bar)
    q.focus()
    scan()
  }

  /**
   * Open every toggle between a block and the top of its page, so a hit is
   * actually visible when we arrive at it.
   *
   * Takes the page id EXPLICITLY rather than reading the current page: the
   * caller may not have navigated yet, and depending on that ordering is what
   * broke this the first time. Returns whether anything changed, so the caller
   * can decide whether a repaint is owed.
   */
  private revealBlock(pageId: string, blockId: string): boolean {
    const s = this.store
    const page = s.index.page.get(pageId)
    if (!page) return false
    let changed = false
    let cur = page.blocks.find((b) => b.id === blockId)
    const guard = new Set<string>()
    while (cur?.parent && !guard.has(cur.parent)) {
      guard.add(cur.parent)
      const owner = page.blocks.find((b) => b.id === cur!.parent)
      if (!owner) break
      // ANY fold, from the registry — not a `type === 'toggle'` test. The
      // merge commit claimed containers were registry data; this one survived,
      // latent only because toggle is the sole 'fold' today. A ⌘K or ⌘F hit
      // inside the second fold type would land on a block nobody could see.
      if (SPEC.get(owner.type)?.container === 'fold' && !owner.open) { owner.open = true; changed = true }
      cur = owner
    }
    // a fold opened to show a search hit is a VIEW change, not an edit: it is
    // mutated directly rather than through commit(), so searching never lands
    // on the undo stack or marks the document modified
    return changed
  }

  // ---- print ---------------------------------------------------------------
  /**
   * Printing is the ONLY export-to-PDF path, so it is a contract rather than a
   * stylesheet: what goes in, in what order, and what happens to the things a
   * screen can hide.
   *
   * Collapsed toggles print EXPANDED, always. Silently omitting content from a
   * printed handbook is a data-loss-shaped bug — the reader has no way to know
   * a paragraph was folded away.
   */
  openPrint(): void {
    const s = this.store
    this.openOverlay(t('Print'), (card, close) => {
      card.append(el('h2', 'sp-card-h', t('Print or save as PDF')))

      const scope = document.createElement('div')
      scope.className = 'sp-choices'
      let whole = true
      const choice = (label: string, hint: string, on: boolean, pick: () => void) => {
        const b = document.createElement('button')
        b.className = 'sp-choice' + (on ? ' sp-sel' : '')
        b.type = 'button'
        b.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(hint)}</span>`
        b.addEventListener('click', () => {
          pick()
          for (const o of scope.querySelectorAll('.sp-choice')) o.classList.remove('sp-sel')
          b.classList.add('sp-sel')
        })
        return b
      }
      const pageCount = s.doc.pages.filter((p) => !p.archived).length
      scope.append(
        choice(t('The whole space'), t('{n} pages, in sidebar order, with a contents page', { n: pageCount }), true, () => { whole = true }),
        choice(t('This page only'), s.page?.title || t('Untitled'), false, () => { whole = false }),
      )
      card.append(scope)

      const opts = document.createElement('div')
      opts.className = 'sp-optlist'
      const check = (label: string, hint: string, on: boolean) => {
        const l = document.createElement('label')
        l.className = 'sp-opt'
        const i = document.createElement('input')
        i.type = 'checkbox'
        i.checked = on
        l.append(i, Object.assign(document.createElement('span'), {
          innerHTML: `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(hint)}</span>`,
        }))
        opts.append(l)
        return i
      }
      const wantArchived = check(t('Include archived pages'), t('Off by default — they were archived for a reason'), false)
      const wantContents = check(t('Contents page'), t('A list of every page, in order'), true)
      card.append(opts)

      const note = document.createElement('p')
      note.className = 'sp-note'
      note.textContent = t('Collapsed toggles always print open. Your browser\'s print dialog has the "Save as PDF" option.')
      card.append(note)

      const go = document.createElement('button')
      go.className = 'sp-btn sp-primary'
      go.textContent = t('Print…')
      go.addEventListener('click', () => {
        close()
        this.printNow({ whole, archived: wantArchived.checked, contents: wantContents.checked })
      })
      card.append(go)
    })
  }

  /**
   * Build a print-only rendering, print it, and take it away again.
   *
   * The screen shows ONE page; print needs all of them, so this renders a
   * separate tree rather than trying to make the editor's DOM serve both. It
   * is removed in `afterprint`, so nothing about the editor is left changed.
   */
  private printNow(opts: { whole: boolean; archived: boolean; contents: boolean }): void {
    const s = this.store
    const host = el('div', 'sp-printroot')
    host.style.direction = 'ltr'

    const pages = opts.whole
      ? s.tree().map((n) => n.page).filter((p) => opts.archived || !p.archived)
      : (s.page ? [s.page] : [])

    if (opts.whole && opts.contents) {
      const toc = el('section', 'sp-toc')
      toc.append(el('h1', 'sp-toc-h', s.doc.title || t('Contents')))
      const ul = el('ul', 'sp-toc-list')
      for (const { page, depth } of s.tree()) {
        if (!opts.archived && page.archived) continue
        const li = document.createElement('li')
        li.style.paddingInlineStart = `${depth * 16}px`
        li.textContent = page.title || t('Untitled')
        ul.append(li)
      }
      toc.append(ul)
      host.append(toc)
    }

    for (const page of pages) {
      host.append(renderPage(page, s.doc, {
        editable: false, forceOpen: true, printing: true,
        titleOf: (id) => s.index.page.get(id)?.title,
        allowRemote: (src) => this.allowedRemote.has(src),
      }))
    }

    document.body.append(host)
    document.body.classList.add('sp-printing')
    const cleanup = () => {
      host.remove()
      document.body.classList.remove('sp-printing')
      window.removeEventListener('afterprint', cleanup)
    }
    window.addEventListener('afterprint', cleanup)
    // some engines return from print() before afterprint fires
    setTimeout(() => { if (document.body.contains(host)) cleanup() }, 60000)
    print()
  }

  private exportMarkdown(): void {
    this.onSaveAs?.('__markdown')
  }

  private async saveAs(suffix: string): Promise<void> {
    this.onSaveAs?.(suffix)
  }

  /**
   * Save a copy that carries a SCOPED capability — the two ways to let someone
   * into this space.
   *
   * Both go live first, because a copy that follows a session needs there to
   * be one, and because "share" should be one action rather than a session to
   * start and then a file to send.
   *
   * Both also write a DERIVED document (share.ts), never `store.doc`. That is
   * the whole of the fix: `saveAs('copy')` serializes the open document, so
   * inviting somebody used to hand them `collab.ownerPriv` — the root key of
   * the room, which writes AND revokes, the inviter included.
   */
  private async shareCopy(kind: import('./share.ts').ShareKind): Promise<void> {
    await this.goLive()
    // Committed first for the same reason slides commits its text edit: a
    // half-typed block that only exists in the DOM is not in the copy.
    this.store.endRun()
    // Copies rejoin as true FORKS: the stamped CRDT state is what lets an
    // offline edit on either side merge two-way rather than clobber.
    this.session?.stampInto(this.store.doc)
    const out = kind === 'invite'
      ? await shareModule.inviteCopy(this.store.doc)
      : shareModule.readerCopy(this.store.doc)
    if (!out) {
      this.status(kind === 'invite'
        ? t('Only the owner of this space can invite people')
        : t('This space has no live session to follow'))
      return
    }
    const ok = await this.onShareCopy?.(out, kind)
    if (ok) {
      this.status(kind === 'invite'
        ? t('Editor copy saved — recipients join live with edit access')
        : t('Read-only copy saved — it follows the live session, view only'))
    }
  }

  /** Turn the live session on (idempotent). Sharing a copy calls this first. */
  async goLive(): Promise<void> {
    if (!this.session || offlineEnabled()) return
    this.session.enableSharing()
    await startSharing(this.session, this.store)
    // A transport made just now is a NEW object with its own callback slot —
    // the one the boot-time watch was attached to no longer exists.
    this.collab?.watchStatus()
    this.collab?.sync()
  }

  /** One About, one copy path — both entry points route through saveAs('copy'). */
  private openAbout(): void {
    openAbout({
      store: this.store,
      onRepaint: () => this.build(),
      onSaveCopy: () => { void this.saveAs('copy') },
      onImport: () => this.openImport(),
      onExportSpace: () => this.openExportSpace(),
      // "Duplicate as a new space…" writes a DIFFERENT document, so it takes
      // the extract's writer rather than the copy path: that one keeps no file
      // handle, which is what leaves you editing this space afterwards.
      onWriteCopy: (out) => this.onExportSpace?.(out) ?? Promise.resolve(false),
      onStatus: (msg) => this.status(msg),
    })
  }

  // ---- routing ------------------------------------------------------------
  /**
   * `#p/<page>` today, and `#p/<page>/<block>` tolerated for later.
   *
   * The allowlist in sanitize.ts already ADMITS the two-segment form (its
   * pattern is `#p/`), so links of that shape can be written into a file right
   * now — and this resolver silently did nothing with them: `index.page.has`
   * failed on the whole string and the click did not even fall back to the
   * page. Every block link written by any future build would be dead in every
   * file saved before that build existed.
   *
   * Tolerance costs three lines and cannot be added later on the sender's
   * behalf: sanitize.ts records why a NEW fragment form is a one-way hazard —
   * an href written under a permissive build gets STRIPPED by a stricter one on
   * the next edit that touches the block. So it is accepted now and addressed
   * (scrolling to the block) whenever that ships.
   *
   * Prefer the WHOLE remainder as a page id: minted ids never contain a slash,
   * but an author-supplied one may.
   */
  private resolveAnchor(hash: string): string | null {
    const m = hash.match(/^#p\/(.+)$/)
    if (!m) return null
    const whole = m[1]
    if (this.store.index.page.has(whole)) return whole
    const cut = whole.lastIndexOf('/')
    if (cut > 0) {
      const page = whole.slice(0, cut)
      if (this.store.index.page.has(page)) return page
    }
    return null
  }

  private fromHash(): void {
    const id = this.resolveAnchor(location.hash)
    if (id) this.store.goToPage(id, { push: false })
  }

  repaint(): void { this.paintTree(); this.paintPage() }
}

/**
 * The mark a keystroke means, or null.
 *
 * ⌘B/⌘I/⌘U/⇧⌘S/⌘E/⇧⌘H, which is Notion's set — the only set most people who
 * will ever type them already have in their fingers. ⌘K is not here because it
 * is two commands (see onKey).
 *
 * `e.key` and not `e.code`: on a non-QWERTY layout the letter the person is
 * looking at is the one they mean, and ⌘B has to be the key marked B.
 */
function markKey(e: KeyboardEvent, mod: boolean): MarkTag | null {
  if (!mod || e.altKey) return null
  const k = e.key.toLowerCase()
  if (e.shiftKey) return k === 's' ? 's' : k === 'h' ? 'mark' : null
  return k === 'b' ? 'strong' : k === 'i' ? 'em' : k === 'u' ? 'u' : k === 'e' ? 'code' : null
}

// ---- small dom helpers ------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  n.className = cls
  if (text) n.textContent = text
  return n
}

/**
 * Is a bare keystroke going to land in something the reader is writing in?
 *
 * The block hosts are contenteditable, the topbar title and the panel's own
 * fields are inputs, and every one of them takes `]` as a character. A
 * bare-key panel shortcut has to ask this first.
 */
function isTyping(): boolean {
  const a = document.activeElement as HTMLElement | null
  if (!a) return false
  return a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'
}

function iconBtn(name: IconName, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'sp-btn'
  b.type = 'button'
  b.innerHTML = ICONS[name]
  b.title = label
  b.setAttribute('aria-label', label)
  b.addEventListener('click', onClick)
  return b
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Type text at the caret, through the engine, so the caret and `input` follow. */
const insertText = (s: string): void => { document.execCommand('insertText', false, s) }

/** Where the caret is inside a host, as a character offset. Null if it is not. */
function caretIndexIn(host: HTMLElement): number | null {
  const sel = getSelection()
  if (!sel || !sel.rangeCount) return null
  const r = sel.getRangeAt(0)
  if (!r.collapsed || !host.contains(r.startContainer)) return null
  const probe = r.cloneRange()
  probe.selectNodeContents(host)
  probe.setEnd(r.startContainer, r.startOffset)
  return probe.toString().length
}

function plainBtn(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'sp-btn' + (primary ? ' sp-primary' : '')
  b.type = 'button'
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

// ---- dropped files ----------------------------------------------------------

const normPath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/').toLowerCase()

/** `dir` + a relative reference, with `..` and `.` collapsed. Lowercased: the
 *  case in a markdown link and the case on disk disagree often enough that
 *  matching exactly would fail for reasons nobody could see. */
function joinPath(dir: string, ref: string): string {
  const parts = (ref.startsWith('/') ? ref.slice(1) : `${dir}/${ref}`).split('/')
  const out: string[] = []
  for (const seg of parts) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/').toLowerCase()
}

/**
 * The `#bento-doc` payload inside another Bento file.
 *
 * INERT: `DOMParser` builds a document with no browsing context, so nothing in
 * that html runs and nothing it references is fetched — the same reasoning
 * sanitize.ts records for `inertBody`, and the reason the file can be read
 * before anyone has decided to trust it. A bare `{` is the document JSON
 * itself (the AI round-trip's interchange unit), which needs no parse at all.
 *
 * An ENCRYPTED space is reported rather than guessed at: the bytes are there,
 * the password is not, and asking for one here would be asking for a password
 * to a file this space has no business holding.
 */
function spaceBlockOf(text: string): string | null | 'encrypted' {
  const body = /^\s*\{/.test(text)
    ? text
    : new DOMParser().parseFromString(text, 'text/html')
      .getElementById('bento-doc')?.textContent ?? null
  if (!body) return null
  return parseEnvelope(body) ? 'encrypted' : body
}

/** `my%20photo.png` is one file name, not two — editors percent-encode spaces. */
function decodePath(ref: string): string {
  try { return decodeURI(ref) } catch { return ref }
}

/**
 * Everything under a drop, including whole folders.
 *
 * `dataTransfer.items` is EMPTIED the moment this handler yields, so every
 * entry is taken synchronously and only then walked. `dataTransfer.files`
 * carries a dropped folder as one nameless entry, which is why the entry API
 * is used at all: without it, dragging a vault onto the window does nothing.
 */
async function collectDrop(dt: DataTransfer | null): Promise<PickedFile[]> {
  if (!dt) return []
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.() ?? null).filter(Boolean) as FileSystemEntry[]
  // the fallback takes its path the same way the picker does, so the two
  // routes into importFiles cannot disagree about where a path comes from
  if (!entries.length) return [...dt.files].map((file) => ({ path: file.webkitRelativePath || file.name, file }))
  const out: PickedFile[] = []
  for (const entry of entries) await walkEntry(entry, '', out, 0)
  return out
}

async function walkEntry(entry: FileSystemEntry, base: string, out: PickedFile[], depth: number): Promise<void> {
  // .obsidian, .git, .trash: configuration and deleted notes, never the notes
  // someone means to import
  if (entry.name.startsWith('.')) return
  const path = base ? `${base}/${entry.name}` : entry.name
  if (entry.isFile) {
    const file = await new Promise<File | null>((res) =>
      (entry as FileSystemFileEntry).file(res, () => res(null)))
    if (file) out.push({ path, file })
    return
  }
  if (depth > 12) return   // a symlink loop is not worth hanging the tab for
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  for (;;) {
    // readEntries hands back at most 100 at a time and signals the end with an
    // empty batch — reading it once silently truncates a folder of 300 notes
    const batch = await new Promise<FileSystemEntry[]>((res) =>
      reader.readEntries(res, () => res([])))
    if (!batch.length) break
    for (const child of batch) await walkEntry(child, path, out, depth + 1)
  }
}

/** Is this drop an IMPORT (markdown, or any folder) rather than an image? */
function isImportDrop(dt: DataTransfer | null): boolean {
  if (!dt) return false
  if ([...dt.files].some((f) => NOTE_EXT.test(f.name) || SPACE_EXT.test(f.name))) return true
  return [...dt.items].some((i) => i.webkitGetAsEntry?.()?.isDirectory)
}

function atStart(host: HTMLElement): boolean {
  const sel = getSelection()
  if (!sel || !sel.rangeCount) return false
  const r = sel.getRangeAt(0)
  if (!r.collapsed) return false
  const probe = r.cloneRange()
  probe.selectNodeContents(host)
  probe.setEnd(r.startContainer, r.startOffset)
  return probe.toString().length === 0
}

function caretToEnd(host: HTMLElement): void {
  const r = document.createRange()
  r.selectNodeContents(host)
  r.collapse(false)
  const sel = getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}

function caretToOffset(host: HTMLElement, offset: number): void {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  let seen = 0
  let node: Node | null
  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0
    if (seen + len >= offset) {
      const r = document.createRange()
      r.setStart(node, offset - seen)
      r.collapse(true)
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
      return
    }
    seen += len
  }
  caretToEnd(host)
}

function selectAll(host: HTMLElement): void {
  const r = document.createRange()
  r.selectNodeContents(host)
  const sel = getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}

/** Split a block's html at the caret, returning [before, after]. */
function splitAtCaret(host: HTMLElement): [string, string] {
  const sel = getSelection()
  if (!sel || !sel.rangeCount) return [host.innerHTML, '']
  const r = sel.getRangeAt(0)
  const after = r.cloneRange()
  after.selectNodeContents(host)
  after.setStart(r.endContainer, r.endOffset)
  const tail = after.cloneContents()
  const before = r.cloneRange()
  before.selectNodeContents(host)
  before.setEnd(r.startContainer, r.startOffset)
  const head = before.cloneContents()
  const wrap = (f: DocumentFragment) => { const d = document.createElement('div'); d.append(f); return d.innerHTML }
  return [sanitizeInline(wrap(head)), sanitizeInline(wrap(tail))]
}

/** Where the caret is, in viewport coordinates. */
function caretRect(): DOMRect {
  const sel = getSelection()
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0).getBoundingClientRect()
    if (r.width || r.height || r.top) return r
  }
  return new DOMRect(80, 120, 0, 0)
}

/**
 * Place a popover near an anchor without letting it leave the viewport.
 *
 * THE HEIGHT IS THE ROOM IT ACTUALLY HAS, not a fraction of the window. The
 * CSS capped every popover at 44vh, which on a 900px-tall window is 396px —
 * and the share panel wants 543. Measured before this: 149px clipped, with
 * "Start live session" and "Reset access…" both below the fold. The primary
 * action of the sharing panel was reachable only by noticing that a box with
 * no visible scrollbar scrolls. A laptop at 800px fares worse.
 *
 * So the cap is computed per placement: pick the side with more room, give the
 * popover that room, and only then measure to position it. The floor is 160px
 * because a popover squeezed under a control near the bottom edge should flip
 * rather than become a slot.
 */
function place(pop: HTMLElement, anchor: HTMLElement | DOMRect): void {
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor
  const GAP = 6, EDGE = 8
  const below = innerHeight - r.bottom - GAP - EDGE
  const above = r.top - GAP - EDGE
  const useBelow = below >= above || below >= 320
  pop.style.maxHeight = `${Math.max(160, useBelow ? below : above)}px`
  // measured AFTER the cap, so a flip decides on the height the popover will
  // actually have rather than the one CSS would have forced on it
  const w = pop.offsetWidth || 260
  const h = pop.offsetHeight || 260
  let left = r.left
  if (left + w > innerWidth - EDGE) left = Math.max(EDGE, innerWidth - w - EDGE)
  pop.style.left = `${Math.max(EDGE, left)}px`
  pop.style.top = `${useBelow ? r.bottom + GAP : Math.max(EDGE, r.top - h - GAP)}px`
}

/**
 * A page's icon.
 *
 * `icon` is a NAME from the stylised set. Older documents (and anything an
 * agent writes) may carry an emoji instead, so that still renders — but the
 * set is what the app offers, because a sidebar of twelve colour emoji reads
 * as a row of stickers rather than one interface.
 */
export function pageIcon(icon: string | undefined): string {
  if (!icon) return ICONS.page
  // hasOwn, not `in`: `'toString' in ICONS` is TRUE and resolves to a
  // FUNCTION, so an icon name of "toString" or "constructor" in a mailed file
  // returned native source text and skipped the escape below. Not markup, so
  // not an injection — but it is author-supplied data reaching the page
  // unescaped, and the next lookup table indexed this way might not be so lucky.
  if (Object.hasOwn(ICONS, icon)) return ICONS[icon as IconName]
  return escapeHtml(icon)   // an emoji, or anything else the file carried
}

/** The icons a page may choose from. */
export const PAGE_ICONS: IconName[] = [
  'page', 'note', 'book', 'folder', 'inbox', 'star', 'tag', 'hash',
  'compass', 'pen', 'scale', 'link', 'todo', 'code', 'image', 'archive',
]

/**
 * Replace text without touching markup.
 *
 * A naive string replace over `html` would happily rewrite a tag name or an
 * href — searching for "a" and replacing it would destroy every link on the
 * page. This walks the string and only substitutes OUTSIDE angle brackets.
 */

/**
 * Run after the next paint — but run REGARDLESS.
 *
 * `requestAnimationFrame` does not fire at all in a hidden tab, so anything
 * whose CORRECTNESS depends on it silently never happens: search a space,
 * switch tabs before the frame lands, come back, and the jump was never
 * completed. rAF is right when the page is visible (it is the only way to act
 * after layout); a timeout is the fallback that always arrives.
 */
export function afterPaint(fn: () => void): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { setTimeout(fn, 0); return }
  let done = false
  const once = () => { if (!done) { done = true; fn() } }
  requestAnimationFrame(once)
  setTimeout(once, 120)   // rAF starved (throttled tab, background window)
}
