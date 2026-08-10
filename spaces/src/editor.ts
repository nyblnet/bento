// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/spaces editor.
//
// The keyboard IS the interface here, so the keymap is specified rather than
// discovered, and every block is its own contentEditable host — never one big
// editable container. That is what keeps Selection block-scoped, so splitting
// and merging blocks can never re-mint an id, and ids are what links,
// backlinks and (later) collaboration key on.

import { type Block, newBlock, newPage, effectiveParents } from './model'
import { Store } from './store'
import { renderPage, toneLabel, paintCode } from './render'
import { CODE_LANGS, langLabel, normLang } from './highlight'
import { canonicalize, escText, sanitizeInline, textOf } from './sanitize'
import { MENU_SPECS, MD_SPECS, SPEC, CALLOUT_TONES } from './blocks'
import {
  fieldByKey, fieldsOf, propHtml, propBlock, propBlockOf, isIssue, headerLength,
  reorderPages, columnMoves, ISSUE_FIELDS, type DropAim, type FieldSpec, type ViewFilter,
} from './fields'
import { planImport, type SourceFile } from './markdown'
import { countOutsideTags, replaceOutsideTags } from './findreplace'
import { t } from './i18n'
import { openAbout } from './about'
import { canWriteInPlace } from '../../kernel/src/save.ts'
import { ICONS, type IconName } from './icons'
import { internAsset, prepareImage, humanBytes, IMAGE_EMBED_BUDGET, blobToDataUri } from './assets'

const CTRL = navigator.platform.toLowerCase().includes('mac') ? 'metaKey' : 'ctrlKey'

// Markdown autoformat and the / menu both come from the block registry
// (blocks.ts), so a type cannot end up with a menu entry and no trigger, or a
// trigger that no menu mentions.
const AUTOFORMAT = MD_SPECS

const SLASH_ITEMS = MENU_SPECS
/** What counts as a note when a folder is dropped on the app. */
const NOTE_EXT = /\.(md|markdown|mdown|mkd)$/i

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


export class Editor {
  readonly store: Store
  private root: HTMLElement
  private main!: HTMLElement
  private sidebar!: HTMLElement
  private statusEl!: HTMLElement
  private overlay: HTMLElement | null = null
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
  onSave: (() => void) | null = null
  onSaveAs: ((suffix: string) => void) | null = null
  onPrint: (() => void) | null = null

  constructor(root: HTMLElement, store: Store) {
    this.root = root
    this.store = store
    // the reader's panel, restored — never the document's
    try {
      const w = Number(localStorage.getItem('bento-sp-pane'))
      if (Number.isFinite(w) && w > 0) this.paneW = Math.min(Editor.PANE_MAX, Math.max(Editor.PANE_MIN, w))
      this.paneClosed = localStorage.getItem('bento-sp-pane-closed') === '1'
    } catch { /* storage throws on a locked-down origin; the defaults are fine */ }
    this.build()
    if (this.paneClosed) this.sidebar.classList.add('sp-pane-closed')
    this.store.on('tree', () => this.paintTree())
    this.store.on('page', () => { this.paintPage(); this.paintTree() })
    this.store.on('doc', () => { this.status(t('Edited')); this.syncHistoryButtons(); this.syncDirty() })
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
    mark.title = t('About bento/spaces — version, updates, language, password')
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
          else if (item.type === 'image') void this.pickImage(fresh.id)
          else this.focusBlock(fresh.id)
        }))
      }
    })

    this.undoB = iconBtn('undo', t('Undo (⌘Z)'), () => { this.store.undo(); this.repaint() })
    this.redoB = iconBtn('redo', t('Redo (⇧⌘Z)'), () => { this.store.redo(); this.repaint() })
    const search = iconBtn('search', t('Search all pages (⌘K)'), () => this.openSearch())

    // SECONDARY ACTIONS, declared ONCE.
    //
    // Measured at 375px before this existed: the bar wanted 678px, so seven of
    // eleven controls sat off the right edge — including Save. On a phone the
    // file could not be saved at all.
    //
    // Below the breakpoint these collapse into the ⋯ menu and the inline copies
    // are hidden. One list feeds both, because a phone menu maintained by hand
    // as a copy of the desktop row drifts the first time either one changes.
    const secondary: Array<{
      icon: IconName
      label: string
      hint: string
      run: () => void
      keep?: (b: HTMLButtonElement) => void
    }> = [
      { icon: 'page', label: t('New page'), hint: '⌘⌥N', run: () => this.newPage() },
      { icon: 'board', label: t('New issue'), hint: '⌘⇧I', run: () => this.newIssue() },
      { icon: 'tag', label: t('Make this page an issue'), hint: t('Adds status, priority, assignee, estimate'),
        run: () => this.makeIssue() },
      { icon: 'eye', label: t('Reading view'), hint: t('The pages without the editing tools'),
        run: () => this.toggleReading(),
        keep: (b) => { this.readB = b } },
      { icon: 'print', label: t('Print or save as PDF'), hint: '⌘P', run: () => this.openPrint() },
      { icon: 'info', label: t('About this space'), hint: t('Version, language, password, exports'),
        run: () => this.openAbout() },
    ]

    const inlineSecondary = secondary.map((a) => {
      const b = iconBtn(a.icon, a.hint && a.hint.length < 12 ? `${a.label} (${a.hint})` : a.label, a.run)
      b.classList.add('sp-sec')
      a.keep?.(b)
      return b
    })

    const more = this.dropdown('more', '', t('More'), (menu, close) => {
      for (const a of secondary) {
        menu.append(this.menuItem(a.icon, a.label, a.hint, () => { close(); a.run() }))
      }
    })
    more.classList.add('sp-more', 'sp-dd-end')

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
      menu.append(this.menuItem('print', t('Print / PDF…'), t('The whole space, or just this page'), () => {
        close(); this.openPrint()
      }))
      menu.append(this.menuItem('lock', t('Password…'), t('Encrypt the document inside this file'), () => {
        close(); this.openAbout()
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
    const right = el('div', 'sp-group sp-group-right')
    right.append(insert, search, ...inlineSecondary, more, saveGroup)

    bar.append(pagesB, mark, title, this.statusEl, history, right)

    this.sidebar = el('nav', 'sp-side')
    this.sidebar.setAttribute('aria-label', t('Pages'))
    this.main = el('main', 'sp-main')

    const body = el('div', 'sp-body')
    body.append(this.sidebar, this.makeResizer(), this.main)
    this.root.append(bar, body)
    this.applyPaneWidth()
    this.syncPaneChevron()

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
    if (label) b.append(document.createTextNode(label))
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

  private menuItem(icon: IconName, label: string, hint: string, onClick: () => void): HTMLElement {
    const b = document.createElement('button')
    b.className = 'sp-dditem'
    b.type = 'button'
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

  status(msg: string): void {
    this.statusEl.textContent = msg
    this.statusEl.classList.add('sp-on')
    clearTimeout((this.statusEl as any)._t)
    ;(this.statusEl as any)._t = setTimeout(() => this.statusEl.classList.remove('sp-on'), 1800)
  }

  // ---- the page tree ------------------------------------------------------
  private paintTree(): void {
    const s = this.store
    this.sidebar.innerHTML = ''
    const head = el('div', 'sp-side-head')
    head.append(el('span', 'sp-side-title', t('Pages')))
    // import sits beside "new page" because that is where pages come from,
    // and because the moment someone wants it is the moment they see an empty
    // sidebar next to a folder of notes they already have
    head.append(iconBtn('markdown', t('Import Markdown files or a folder…'), () => this.openImport()))
    head.append(iconBtn('plus', t('New page (⌘⌥N)'), () => this.newPage()))
    this.sidebar.append(head)

    const list = el('ul', 'sp-tree')
    for (const { page, depth } of s.tree()) {
      if (page.archived) continue
      const li = document.createElement('li')
      li.style.paddingInlineStart = `${depth * 14}px`
      const a = document.createElement('a')
      a.href = `#p/${page.id}`
      a.className = 'sp-treelink' + (page.id === s.pageId ? ' sp-here' : '')
      const ico = el('span', 'sp-tree-ico')
      ico.innerHTML = pageIcon(page.icon)
      const label = document.createElement('span')
      label.textContent = page.title || t('Untitled')
      a.append(ico, label)
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
        a.className = 'sp-treelink sp-arch-row' + (page.id === s.pageId ? ' sp-here' : '')
        const ico = el('span', 'sp-tree-ico')
        ico.innerHTML = pageIcon(page.icon)
        const label = document.createElement('span')
        label.textContent = page.title || t('Untitled')
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
    add.className = 'sp-ghost'
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
      { icon: 'text', label: t('Turn into…'), hint: t('Change this block’s type'),
        run: () => this.openSlash(id) },
      { icon: 'plus', label: t('Add below'), hint: '⏎', run: () => this.insertAfter(id) },
      { icon: 'up', label: t('Move up'), hint: '', off: si <= 0,
        run: () => { if (si > 0) this.moveBefore(id, sibs[si - 1].id) } },
      { icon: 'down', label: t('Move down'), hint: '', off: si < 0 || si >= sibs.length - 1,
        run: () => { if (si >= 0 && si < sibs.length - 1) this.moveBlock(id, sibs[si + 1].id) } },
      { icon: 'copy', label: t('Duplicate'), hint: '', run: () => this.duplicateBlock(id) },
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

  private openFieldPicker(blockId: string, anchor: HTMLElement): void {
    const s = this.store
    if (s.readOnly || this.reading) return
    const b = s.block(blockId)
    const f = b && fieldByKey(s.doc, String((b as { key?: unknown }).key ?? ''))
    if (!b || !f) return
    this.closeOverlay()

    const pop = el('div', this.isDrawer() ? 'sp-pop sp-sheet' : 'sp-pop')
    pop.setAttribute('role', 'menu')
    this.trapAndClose(pop)

    if (f.vt === 'select' && f.options?.length) {
      const cur = String((b as { value?: unknown }).value ?? '')
      for (const o of f.options) {
        const item = document.createElement('button')
        item.className = 'sp-dditem' + (o.id === cur ? ' sp-sel' : '')
        item.type = 'button'
        const dot = el('span', 'sp-prop-dot')
        if (o.color) dot.style.background = o.color
        const name = document.createElement('span')
        name.textContent = o.label
        item.append(dot, name)
        item.addEventListener('click', () => { this.closeOverlay(); this.setField(blockId, o.id) })
        pop.append(item)
      }
    } else {
      // free text, a number or a date: one field, committed on Enter
      const input = document.createElement('input')
      input.className = 'sp-find'
      input.type = f.vt === 'number' ? 'number' : f.vt === 'date' ? 'date' : 'text'
      input.value = String((b as { value?: unknown }).value ?? '')
      input.placeholder = f.label
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          const raw = input.value.trim()
          this.closeOverlay()
          this.setField(blockId, f.vt === 'number' ? (raw === '' ? '' : Number(raw)) : raw)
        }
      })
      pop.append(input)
      afterPaint(() => input.focus())
    }

    this.overlay = pop
    document.body.append(pop)
    if (this.isDrawer()) pop.classList.add('sp-sheet-in')
    else place(pop, anchor)
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

      for (const btn of v.querySelectorAll<HTMLElement>('[data-set-field]')) {
        btn.addEventListener('click', (e) => {
          e.preventDefault()
          this.openFieldPicker(btn.dataset.setField!, btn)
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
          const aim = this.aimAt(col, e.clientY)
          col.classList.add('sp-drop')
          if (aim.before) col.querySelector(`[data-issue="${CSS.escape(aim.before)}"]`)?.classList.add('sp-dropbefore')
          else col.classList.add('sp-dropend')
        })
        col.addEventListener('drop', (e) => {
          const moved = e.dataTransfer?.getData('text/bento-issue')
          if (!moved) return
          e.preventDefault()
          const aim = this.aimAt(col, e.clientY)
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
  private dropIssue(pageId: string, key: string, optId: string, aim: DropAim): void {
    const s = this.store
    const page = s.index.page.get(pageId)
    const f = fieldByKey(s.doc, key)
    if (!page || !f || s.readOnly) return
    const own = propBlockOf(page, key)
    const setting = !own || String((own as { value?: unknown }).value ?? '') !== optId
    // The no-op test is about the COLUMN, not the page array — those are
    // different orders the moment a board has two columns, and judging by page
    // adjacency let a drop that visibly did nothing rewrite doc.pages.
    const cards = [...document.querySelectorAll<HTMLElement>(`.sp-col[data-group="${CSS.escape(optId)}"] .sp-issue[data-issue]`)]
      .map((c) => c.dataset.issue!)
    const moves = columnMoves(cards, pageId, aim)
    const order = moves ? reorderPages(s.doc.pages, pageId, aim) : null
    if (!setting && !order) return

    s.commit(() => {
      if (setting) {
        if (own) this.applyField(own, f, optId)
        // A page can reach a column without carrying that field at all (a board
        // grouped by something an issue never had). It gains the value, in the
        // header strip where the others are — through propBlock, so the
        // readable form is written with it.
        else page.blocks.splice(headerLength(page), 0, propBlock(f, optId, newBlock('prop').id))
      }
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
    this.closeOverlay()
    const pop = el('div', this.isDrawer() ? 'sp-pop sp-sheet' : 'sp-pop')
    pop.setAttribute('role', 'menu')
    this.trapAndClose(pop)
    const cur = ((b as { filter?: ViewFilter }).filter ?? {}) as ViewFilter

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
    const clear = this.menuItem('trash', t('Clear filter'), '', () => {
      this.closeOverlay()
      // unknown keys survive: this clears what this build put there
      this.editViewFilter(blockId, (f) => { delete f.is; delete f.open })
    })
    pop.append(clear)

    this.overlay = pop
    document.body.append(pop)
    if (this.isDrawer()) pop.classList.add('sp-sheet-in')
    else place(pop, anchor)
    const away = (ev: MouseEvent) => {
      if (!pop.contains(ev.target as Node)) { this.closeOverlay(); document.removeEventListener('mousedown', away) }
    }
    setTimeout(() => document.addEventListener('mousedown', away), 0)
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
      })
      host.addEventListener('blur', () => {
        if (this.painting) return
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
        void this.imageFromTransfer(e.clipboardData, cur?.id)
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
      void this.imageFromTransfer(e.dataTransfer, near?.dataset.blockId)
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

    if (mod && e.key.toLowerCase() === 'k' && !e.shiftKey) { e.preventDefault(); this.openSearch(); return }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.onSave?.(); return }
    if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); this.openPrint(); return }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); this.openFind(); return }
    if (mod && e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); this.newPage(); return }
    // `[` collapses the page list, as in slides. Bare, not modified: it only
    // reaches here when nothing is being edited (the text path returns above,
    // where `[` is the page-link trigger).
    if (!mod && e.key === '[') { e.preventDefault(); this.togglePane(); return }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); this.newIssue(); return }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) s.redo(); else s.undo()
      this.paintPage(); this.paintTree()
      return
    }
    if (e.key === 'Escape' && this.reading && !this.overlay) { e.preventDefault(); this.toggleReading(false); return }
    if (this.overlay) return // the overlay owns the keyboard while it is open

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
      if (mod && ['b', 'i', 'u'].includes(e.key.toLowerCase())) { e.preventDefault(); return }
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
    if (mod && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault()
      document.execCommand(({ b: 'bold', i: 'italic', u: 'underline' } as any)[e.key.toLowerCase()])
      s.runEdit(cur.id, () => { const bb = s.block(cur.id); if (bb) bb.html = cur.host.innerHTML })
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
    this.focusBlock(id)
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

  private closeOverlay(): void {
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

  /** Drop or paste an image straight onto the page. */
  private async imageFromTransfer(dt: DataTransfer | null, afterId?: string): Promise<boolean> {
    const file = [...(dt?.files ?? [])].find((f) => f.type.startsWith('image/'))
      ?? [...(dt?.items ?? [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile())[0]
    if (!file) return false
    if (!this.store.page) return false
    await this.placeImage(null, file, { insertAfter: afterId ?? null })
    return true
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
    this.openOverlay(t('Import Markdown'), (card, close) => {
      card.append(el('h2', 'sp-card-h', t('Import Markdown')))

      const what = document.createElement('p')
      what.className = 'sp-note'
      what.textContent = t('Each .md file becomes a page, folders become the page tree, and [[wikilinks]] become real links. Pages are added — nothing here is replaced.')
      card.append(what)

      const zone = el('div', 'sp-dropzone', t('Drop .md files or a folder here'))
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('sp-drop') })
      zone.addEventListener('dragleave', () => zone.classList.remove('sp-drop'))
      zone.addEventListener('drop', (e) => {
        e.preventDefault()
        e.stopPropagation()
        zone.classList.remove('sp-drop')
        const picked = collectDrop(e.dataTransfer)
        close()
        void picked.then((files) => this.importFiles(files))
      })
      card.append(zone)

      const pick = (folder: boolean) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        if (folder) input.webkitdirectory = true
        else input.accept = '.md,.markdown,.mdown,.mkd,image/*'
        input.addEventListener('change', () => {
          close()
          // webkitRelativePath is the folder tree; a plain multi-select has
          // none, and those files import as a flat set of pages
          void this.importFiles([...(input.files ?? [])]
            .map((file) => ({ path: file.webkitRelativePath || file.name, file })))
        })
        input.click()
      }

      const acts = el('div', 'sp-actions')
      acts.append(
        plainBtn(t('Choose .md files…'), () => pick(false), true),
        plainBtn(t('Choose a folder…'), () => pick(true)),
      )
      card.append(acts)

      const imgs = document.createElement('p')
      imgs.className = 'sp-note'
      // said BEFORE the import, because it is the one thing a browser cannot
      // do for them: it has no way to open `../attachments/x.png` itself
      imgs.textContent = t('Include the image files and they are embedded too. An image this browser cannot open is kept as its path rather than as a broken picture.')
      card.append(imgs)
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
  async importFiles(picked: PickedFile[]): Promise<void> {
    const s = this.store
    if (s.readOnly) { this.status(t('This file is open read-only')); return }
    const notes = picked.filter((p) => NOTE_EXT.test(p.path))
    if (!notes.length) { this.status(t('No Markdown files in that selection')); return }
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
        lines.push(t('{n} table(s) kept as text: there is no table block in this format yet.', { n: plan.stats.tables }))
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

  /** One About, one copy path — both entry points route through saveAs('copy'). */
  private openAbout(): void {
    openAbout({
      store: this.store,
      onRepaint: () => this.build(),
      onSaveCopy: () => { void this.saveAs('copy') },
      onImport: () => this.openImport(),
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

// ---- small dom helpers ------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  n.className = cls
  if (text) n.textContent = text
  return n
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
  if ([...dt.files].some((f) => NOTE_EXT.test(f.name))) return true
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

/** Place a popover near an anchor without letting it leave the viewport. */
function place(pop: HTMLElement, anchor: HTMLElement | DOMRect): void {
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor
  const w = pop.offsetWidth || 260
  const h = pop.offsetHeight || 260
  let left = r.left
  let top = r.bottom + 6
  if (left + w > innerWidth - 8) left = Math.max(8, innerWidth - w - 8)
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6)
  pop.style.left = `${Math.max(8, left)}px`
  pop.style.top = `${top}px`
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
