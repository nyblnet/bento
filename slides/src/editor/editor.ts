// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Editor shell: topbar, slide sidebar, canvas, properties panel, keyboard
// shortcuts, save & present wiring.

import type { Store } from '../store'
import {
  FORMAT_VERSION,
  MEDIA_EMBED_BUDGET,
  applyChartPalette, applyLayout, builtinLayouts, defaultChart, defaultImage, defaultMedia, defaultShape, defaultTable, defaultText,
  instantiateLayout, isLightBg, layoutElementIds, newDocId, parseDoc, readableInk, syncLinkedChart, uid,
  type ChartElement, type ShapeKind, type Slide, type SlideElement, type TableElement,
} from '../model'
import { APP_VERSION, applyUpdate, applyUpdateInPlace, autoCheckEnabled, canUpdateInPlace, checkForUpdates, compareVersions, offlineEnabled, setAutoCheck, setOffline } from '../update'
import { CHART_PRESETS } from '../charts'
import { renderSlide, renderThumbnail } from '../render'
import { SlideCanvas } from './canvas'
import { PropsPanel } from './panels'
import { startPresentation } from '../present'
import { adoptFileHandle, canWriteInPlace, currentFileName, fileBase, hasFileHandle, isEncryptionActive, openedFileName, saveFile, serializeAuto, serializeFile, setEncryptionPassword, writeUpdatedFile, writeUpdatedFileAs } from '../save'
import { addVersion, clearRecovery, clearVersions, docContentKey, getRecovery, listVersions, pruneOld, putRecovery, type Snapshot } from '../autosave'
import { insertElements, insertSlides, parseClip, serializeElements, serializeSlides } from './clipboard'
import { openSpeakerWindow, speakerIdleBody } from '../screens'
import { borderPoint, boxCenter, lineEndpoints, setLineEndpoints, sideMidpoint } from './lineedit'
import { ICONS } from '../icons'
import { t, setLocale, locale, localeChoices, LOCALE_CHOICES, applyDirection, isRtl } from '../i18n'
import { availablePacks, fetchPack, markFileSaved, packCoverage, packsInFile, stageForFile, unstageFromFile } from '../packs'
import { injectFonts } from '../fonts'
import { appConfig } from '../../../kernel/src/app.ts'
import { disconnectOnline, joinFromDoc, mintCollab, mintInvite, onlineTransport, rotateKeys, sharingOn, startSharing, stopSharing } from '../sync/online'
import { lsGet, lsJson, lsSet } from '../../../kernel/src/storage.ts'

const i18nT = t

/** Per-BROWSER, not per-deck: whether the "this browser can't rewrite files"
 *  notice has been acknowledged. It is a property of the browser. */
const SAVE_NOTICE_KEY = 'bento-save-notice'

/** sessionStorage: set just before the post-update reload, read once by the
 *  version that boots next. Deliberately NOT localStorage — see
 *  noticeIfJustUpdated. */
const JUST_UPDATED_KEY = 'bento-just-updated'

/** Show the language search once the available list outgrows a glance. */
const SEARCH_FROM = 8

const SHAPE_MENU: Array<{ kind: ShapeKind; label: string; icon: string; draw?: 'line' | 'path' | 'connector' | 'free' | 'poly'; tip: string }> = [
  { kind: 'rect', label: 'Rectangle', icon: ICONS.rect, tip: 'A rectangle — rounded corners, fills, gradients and shadows in the panel' },
  { kind: 'ellipse', label: 'Ellipse', icon: ICONS.ellipse, tip: 'An ellipse or circle' },
  { kind: 'triangle', label: 'Triangle', icon: ICONS.triangle, tip: 'A triangle' },
  { kind: 'arrow', label: 'Arrow', icon: ICONS.arrow, tip: 'A solid arrow shape' },
  { kind: 'line', label: 'Line', icon: ICONS.line, draw: 'line', tip: 'Drag on the slide to draw a straight line — drag its endpoints to adjust' },
  { kind: 'path', label: 'Curved line', icon: ICONS.curve, draw: 'path', tip: 'Drag to draw a curve — then drag its points; double-click to add or remove one' },
  { kind: 'line', label: 'Connector', icon: ICONS.connector, draw: 'connector', tip: 'Drag between two elements — the ends snap on and re-route when they move' },
  { kind: 'path', label: 'Freeform', icon: ICONS.freeform, draw: 'free', tip: 'Draw by hand — the stroke smooths into an editable curve' },
  { kind: 'path', label: 'Polygon', icon: ICONS.polygon, draw: 'poly', tip: 'Click to place corners; click the first point (or double-click) to close the shape' },
]

export class Editor {
  private canvas!: SlideCanvas
  private panel!: PropsPanel
  private sidebar!: HTMLElement
  private props!: HTMLElement
  private dirtyDot!: HTMLElement
  private fileChip?: HTMLElement
  /** Name of a deck opened by DROP when no writable handle came with it. */
  private openedAs?: string
  private thumbTimer = 0
  private presenting = false
  private updatesB!: HTMLElement
  private avatarsBox!: HTMLElement
  private shareB!: HTMLElement
  private shareWrap!: HTMLElement
  private session: import('../sync/session').SyncSession | null = null
  private updateFound: string | null = null
  private lastAutoCheck: import('../update').UpdateCheck | null = null
  /** side panel widths (px) — user-resizable, persisted per browser */
  private panelW = { left: 188, right: 236 }

  constructor(
    private root: HTMLElement,
    private store: Store,
  ) {
    this.build()
    this.wireKeyboard()
    store.on('slides', () => this.rebuildSidebar())
    store.on('current', () => this.highlightSidebar())
    store.on('doc', () => this.scheduleThumbs())
    store.on('dirty', () => {
      this.dirtyDot.classList.toggle('on', store.dirty)
    })
    window.addEventListener('beforeunload', (ev) => {
      if (store.dirty) ev.preventDefault()
    })
    this.wireAutosave()
    this.wirePaste()
    store.on('doc', () => this.syncLinkedCharts())
    store.on('doc', () => this.syncConnectors())
    document.addEventListener('bento:apply-layout', ((ev: CustomEvent) => {
      this.openLayoutPicker(ev.detail.anchor as HTMLElement, { kind: 'apply' })
    }) as EventListener)
    this.rebuildSidebar()
  }

  /** wire the live-collaboration session (avatars, remote selections, relay) */
  connectSync(session: import('../sync/session').SyncSession) {
    this.session = session
    let known = new Map(session.peers().map((p) => [p.actor, p.name]))
    session.onPeers(() => {
      this.renderAvatars()
      this.canvas.setRemotePeers(session.peers())
      if (this.shareWrap.classList.contains('open')) this.renderSharePanel()
      // presence arrivals/departures get a quiet heads-up — but in a crowded
      // room (or when joining one, where every existing peer looks like a fresh
      // arrival), the per-peer toasts would storm. Stay silent past a threshold.
      const now = new Map(session.peers().map((p) => [p.actor, p.name]))
      if (now.size <= 8) {
        for (const [actor, name] of now) {
          if (!known.has(actor)) this.toast(t('{name} joined', { name }))
        }
        for (const [actor, name] of known) {
          if (!now.has(actor)) this.toast(t('{name} left', { name }))
        }
      }
      known = now
    })
    // the relay refused something (too big, room full, throttled) — the user
    // needs to know, because for the permanent codes their change stays in
    // this copy and never reaches anyone else
    session.onNotice((n) => this.toast(syncNoticeText(n)))
    this.canvas.onTextEditChange = (elId) => session.setEditing(elId)
    this.store.on('current', () => this.canvas.setRemotePeers(session.peers()))
    // a document that carries collab config joins its relay session — at
    // boot AND whenever one is loaded (Replace-from-JSON, update splice…),
    // but only when it is share-eligible (arrived with creds, or the user
    // opted in). A never-saved demo/template stays off the relay.
    this.tryJoin()
    this.store.on('doc', () => this.tryJoin())
  }

  /** Connect to the relay if the current doc is live AND share-eligible. */
  private tryJoin() {
    if (!this.session) return
    if (sharingOn(this.store) && this.session.shareEligible() && !onlineTransport()) {
      joinFromDoc(this.session, this.store)
      this.wireOnlineStatus()
    }
  }

  private wireOnlineStatus() {
    const tr = onlineTransport()
    if (!tr) {
      this.shareB.classList.remove('ed-btn-live', 'ed-btn-connecting')
      this.shareB.title = t('Not sharing yet — click to start a live session')
      return
    }
    tr.onStatus = () => this.wireOnlineStatus()
    this.shareB.classList.toggle('ed-btn-live', tr.status === 'open')
    this.shareB.classList.toggle('ed-btn-connecting', tr.status !== 'open')
    this.shareB.title = tr.status === 'open'
      ? t('Live — this deck is being shared')
      : t('Connecting to the live session…')
    if (this.shareWrap.classList.contains('open')) this.renderSharePanel()
  }

  private renderAvatars() {
    if (!this.session) return
    this.avatarsBox.innerHTML = ''
    const peers = this.session.peers()
    // cap the strip so a crowded room can't blow out the topbar — show a few
    // overlapping avatars, then a "+N" pill that opens the Live panel (which
    // lists everyone, scrollable). Without this, N peers = N×28px of hard width.
    // MAX=3 keeps the strip < 100px so even a 1280px laptop topbar never
    // overflows (4+ clips the corner controls at that width — measured).
    const MAX = 3
    for (const peer of peers.slice(0, MAX)) {
      const chip = document.createElement('button')
      chip.className = 'ed-avatar'
      chip.style.background = peer.color
      chip.textContent = (peer.name || '?').trim().charAt(0).toUpperCase() || '?'
      const idx = this.store.doc.slides.findIndex((s) => s.id === peer.slide)
      chip.title =
        idx >= 0
          ? t('{name} — on slide {n} (click to follow)', { name: peer.name, n: idx + 1 })
          : peer.name
      chip.addEventListener('click', () => {
        const i = this.store.doc.slides.findIndex((s) => s.id === peer.slide)
        if (i >= 0) this.store.goTo(i)
      })
      this.avatarsBox.appendChild(chip)
    }
    const extra = peers.length - MAX
    if (extra > 0) {
      const more = document.createElement('button')
      more.className = 'ed-avatar ed-avatar-more'
      more.textContent = `+${extra}`
      more.title = t('{n} more — click to see everyone', { n: extra })
      more.addEventListener('click', () => {
        this.shareWrap.classList.add('open')
        this.renderSharePanel()
      })
      this.avatarsBox.appendChild(more)
    }
  }

  // --- DOM ----------------------------------------------------------------

  private build() {
    this.root.innerHTML = ''
    this.root.className = 'ed-root'

    // topbar
    const bar = div('ed-topbar')
    const logo = div('ed-logo')
    logo.innerHTML =
      `<svg class="ed-logo-mark" viewBox="0 0 32 32" width="20" height="20" aria-hidden="true">` +
      `<rect width="32" height="32" rx="7" fill="#16273E"/>` +
      `<rect x="5" y="5" width="7" height="22" rx="2.5" fill="#5E7699"/>` +
      `<rect x="14" y="5" width="13" height="10" rx="2.5" fill="#FF9E8A"/>` +
      `<rect x="14" y="17" width="13" height="10" rx="2.5" fill="#F0EBE0"/>` +
      `</svg> <b>bento<span style="color:#FF9E8A">/</span>slides</b>`
    logo.title = t('About bento/slides — version, updates, licenses')
    logo.style.cursor = 'pointer'
    logo.addEventListener('click', () => this.openAbout())
    const title = document.createElement('input')
    title.className = 'ed-title'
    title.title = t('Deck title — shown in the tab, on {{title}} fields, and as the suggested file name')
    title.value = this.store.doc.title
    title.spellcheck = false
    title.addEventListener('change', () => {
      this.store.commit(() => { this.store.doc.title = title.value || 'Untitled' })
      this.syncWindowTitle()
    })
    // remote/programmatic title changes reflect live (unless being typed in)
    this.store.on('doc', () => {
      if (document.activeElement !== title && title.value !== this.store.doc.title) {
        title.value = this.store.doc.title
        this.syncWindowTitle()
      }
    })

    // The FILE this deck is open as — deliberately separate from the deck
    // title above, because the two drift apart constantly (rename the deck and
    // the file on disk keeps its old name) and only one of them answers "what
    // does ⌘S overwrite?". Absent until the answer is knowable: a never-saved
    // deck has no file, and saying so would be noise.
    this.fileChip = div('ed-filechip')
    this.fileChip.hidden = true
    this.dirtyDot = div('ed-dirty')
    // Capability-aware: on Safari/Firefox (and every iOS browser) there is no
    // File System Access API, so ⌘S CANNOT rewrite this file — it hands back a
    // copy. Promising in-place saving and retracting it in a toast after the
    // first save is worse than saying the true thing before any work is lost.
    this.dirtyDot.title = canWriteInPlace()
      ? t('Unsaved changes — ⌘S saves this file in place')
      : t('Unsaved changes — ⌘S downloads an updated copy (this browser can’t rewrite the file)')

    const insert = div('ed-group ed-insert')
    insert.append(
      btn(ICONS.text, t('Text'), () => this.canvas.insert(defaultText({ color: readableInk(this.store.slide.background), y: 120 + Math.random() * 200 }), true),
        t('Add a text box — double-click it to edit; **bold**, *italic*, `code` and “- ” bullets format as you type')),
      this.shapeDropdown(),
      btn(ICONS.image, t('Image'), () => this.pickImage(),
        t('Add an image — or just paste one (⌘V) straight onto the slide')),
      this.mediaDropdown(),
      btn(ICONS.table, t('Table'), () => this.canvas.insert(this.newTable()),
        t('Add a table — edit cells inline; turn it into a live chart from the panel')),
      btn(ICONS.chart, t('Chart'), () => this.canvas.insert(defaultChart(applyChartPalette(CHART_PRESETS.bar(), this.store.doc.theme))),
        t('Add a chart — edit it visually or link it to a table so it updates live')),
    )
    const commentB = btn(ICONS.comment, t('Comment'), () => this.canvas.toggleCommentMode(),
      t('Comment (C) — click an element or a spot on the slide'))
    insert.appendChild(commentB)

    const actions = div('ed-group ed-group-right')
    // the update chip sits beside the wordmark and exists ONLY when an
    // update is available (manual checks live in the About dialog)
    this.updatesB = btn(ICONS.sync, '', () => this.openAbout(true), t('Check for updates'))
    this.updatesB.style.display = 'none'
    setTimeout(async () => {
      if (!autoCheckEnabled() || offlineEnabled()) return
      const r = await checkForUpdates()
      this.lastAutoCheck = r
      if (r.status === 'update') {
        this.updateFound = r.release.version
        this.updatesB.style.display = ''
        this.updatesB.classList.add('ed-btn-update')
        this.updatesB.innerHTML = `${ICONS.sync}<span>v${r.release.version}</span>`
        this.updatesB.title = t('Version {v} is available — click to update', { v: r.release.version })
        this.toast(t('Update available: v{v} — click the peach button to update', { v: r.release.version }))
      } else if (r.status === 'current') {
        this.toast(t('Up to date — v{v}', { v: APP_VERSION }))
      }
    }, 1500)
    const undoB = btn(ICONS.undo, '', () => this.store.undo(), t('Undo (⌘Z)'))
    const redoB = btn(ICONS.redo, '', () => this.store.redo(), t('Redo (⇧⌘Z)'))
    const saveB = btn(ICONS.save, t('Save'), () => this.save(false), canWriteInPlace()
      ? t('Save — rewrite this file in place (⌘S)')
      : t('Save — download an updated copy (⌘S). This browser can’t rewrite the open file.'))
    saveB.appendChild(this.dirtyDot) // the amber unsaved-changes dot lives ON Save
    const pdfB = btn(ICONS.pdf, '', () => this.exportPdf(), t('Export PDF (print)'))
    const helpB = btn('<b class="ed-help-q">?</b>', '', () => this.openHelp(), t('Shortcuts & tips (?)'))
    helpB.classList.add('ed-btn-help')
    this.avatarsBox = div('ed-avatars')
    // Intuitive grouping: LEFT = the document (identity · title · save-state ·
    // undo/redo history) · CENTRE = insert tools · RIGHT = output & sharing
    // (print · collaborators · Live · Save · more) with help pinned to the corner.
    const history = div('ed-group ed-group-history')
    history.append(undoB, redoB)
    const saveGroup = div('ed-split')
    saveGroup.append(saveB, this.saveDropdown())
    const shareD = this.shareDropdown()
    const langD = this.languageDropdown()
    actions.append(pdfB, this.avatarsBox, shareD, saveGroup, langD, helpB)

    // Phone chrome: two menus that stay EMPTY on a wide screen. Nothing is
    // duplicated — applyPhoneChrome moves the real buttons in and out, so every
    // listener, tooltip and live reference (dirtyDot, updatesB, the comment
    // button's armed state) keeps working wherever the button currently sits.
    const insertMenu = div('ed-menu')
    const insertD = div('ed-dropdown ed-phone-only')
    insertD.append(
      btn(ICONS.plus, t('Insert'), () => insertD.classList.toggle('open'), t('Insert — text, shapes, images, media, tables, charts')),
      insertMenu)
    const moreMenu = div('ed-menu')
    const moreD = div('ed-dropdown ed-phone-only')
    moreD.append(
      btn('<b>⋯</b>', t('More'), () => {
        // Fill BEFORE opening: the save-as list reflects live state (is this
        // file encrypted?) and must be current the moment it becomes visible.
        if (!moreD.classList.contains('open')) this.fillPhoneSaveAs(moreMenu, moreD)
        moreD.classList.toggle('open')
      }, t('More actions')),
      moreMenu)
    const slidesB = btn(ICONS.panelLeft, t('Slides'), () => this.togglePanel('left'), t('Slides — show or hide the slide list'))
    slidesB.classList.add('ed-phone-only')
    const formatB = btn(ICONS.panelRight, t('Format'), () => this.togglePanel('right'), t('Format — show or hide the properties panel'))
    formatB.classList.add('ed-phone-only')

    this.syncWindowTitle()

    this.phoneChrome = {
      insertD, insertMenu, moreD, moreMenu, slidesB, formatB, insert, actions, history,
      // order matters: this is the order they appear in the ⋯ menu
      demote: [redoB, commentB, pdfB, shareD, langD, helpB],
    }

    bar.append(logo, this.updatesB, title, this.fileChip, slidesB, insertD, history, insert, actions, moreD)

    // main area
    const main = div('ed-main')
    this.sidebar = div('ed-sidebar')
    const canvasWrap = div('ed-canvas-wrap')
    // presenting lives in ONE split pill beside the zoom control: the main
    // half starts the fullscreen show; its menu holds tab-fill and speaker view.
    const pill = div('ed-dropdown ed-present-pill')
    const showB = btn(ICONS.slideshow, t('Slideshow'), () => this.present(false, true),
      t('Start the slideshow fullscreen — F toggles fullscreen, S opens speaker view, Esc ends'))
    showB.classList.add('ed-pill-main')
    // Nudge: newcomers don't always spot how to start a show — run the neon
    // runner around the Slideshow pill on EVERY editor load until they've
    // actually started a slideshow once (flag set in present(), not when the
    // hint merely plays — so it keeps nudging until it's used). Hover replays it
    // any time (CSS :hover). When the laps finish fading, just drop the class so
    // hover takes over cleanly (a lingering class would replay on mouse-out).
    if (!lsGet('bento-slideshow-started')) pill.classList.add('ed-hint-pulse')
    pill.addEventListener('animationend', (e) => {
      if ((e as AnimationEvent).animationName !== 'ed-runner-fade') return
      pill.classList.remove('ed-hint-pulse')
    })
    const caret = btn('<span class="ed-caret">▴</span>', '', () => pill.classList.toggle('open'),
      t('More ways to present'))
    caret.classList.add('ed-pill-caret')
    const pmenu = div('ed-menu')
    const pItem = (icon: string, label: string, title: string, onClick: () => void) => {
      const b = btn(icon, label, () => { pill.classList.remove('open'); onClick() }, title)
      pmenu.appendChild(b)
    }
    pItem(ICONS.window, t('Present in this tab'), t('Fills this tab instead of going fullscreen — handy for testing or sharing a window'), () => this.present(false, false))
    pItem(ICONS.presenter, t('Open speaker view'), t('Notes, controls and slide thumbnails in a separate window — drag it to a second screen. On macOS, open it before going fullscreen.'), () => this.openSpeakerView())
    pill.append(showB, caret, pmenu)
    document.addEventListener('pointerdown', (ev) => {
      if (!pill.contains(ev.target as Node)) pill.classList.remove('open')
    })
    // shared bottom-right cluster: [Slideshow pill] [zoom pill] — the canvas
    // appends its zoombar to canvasWrap; we adopt it into the cluster below.
    const corner = div('ed-corner-br')
    corner.appendChild(pill)
    canvasWrap.appendChild(corner)
    queueMicrotask(() => {
      const zb = canvasWrap.querySelector('.ed-zoombar')
      if (zb) corner.appendChild(zb)
    })
    this.props = div('ed-props')
    main.append(this.sidebar, this.makeResizer('left'), canvasWrap, this.makeResizer('right'), this.props)

    this.root.append(bar, main)

    // phones/small windows: start with both panels collapsed so the CANVAS
    // is what you see — the topbar toggles (and [ / ]) bring them back
    if (window.innerWidth < 700) {
      this.sidebar.classList.add('ed-collapsed')
      this.props.classList.add('ed-collapsed')
    }

    actions.insertBefore(formatB, saveGroup)

    // drive it now and whenever the query flips
    // Held on `this` deliberately: a MediaQueryList that nothing references can
    // be collected along with its listener, and the bar then never unfolds when
    // the window grows — the CSS flips but the JS half silently stops.
    this.phoneQuery = window.matchMedia('(max-width: 700px)')
    // build() has just re-authored the bar, so whatever folding state a PREVIOUS
    // bar was in no longer describes this DOM. Without this reset a rebuild on a
    // phone (switching language, say) would early-return on `true === true` and
    // leave the freshly authored DESKTOP bar in place — overflowing, with Save
    // off-screen again.
    this.phoneChromeOn = null
    this.applyPhoneChrome(this.phoneQuery.matches)
    this.phoneQuery.addEventListener('change', (e) => this.applyPhoneChrome(e.matches))
    // ...and on plain resize as well. matchMedia's change event is the correct
    // signal but not a universally reliable one — it does not fire at all under
    // CDP-driven viewport changes, and a phone ROTATING is exactly this path.
    // applyPhoneChrome early-returns when the state is unchanged, so calling it
    // on every resize costs a comparison.
    window.addEventListener('resize', () => this.applyPhoneChrome(window.innerWidth <= 700))

    this.restorePanelWidths()
    this.canvas = new SlideCanvas(canvasWrap, this.store)
    this.canvas.onCommentModeChange = (on) => commentB.classList.toggle('ed-btn-armed', on)
    this.canvas.onSlideNav = (dir) => this.store.goToLinear(dir)
    this.panel = new PropsPanel(this.props, this.store)

    if (this.store.doc.collab?.role === 'reader') this.enterReaderMode()
  }

  /** Live viewer: block user edits (store.readOnly), hide editing chrome, and
   *  show a banner. Remote ops still apply — the deck updates as others edit. */
  private enterReaderMode() {
    this.store.readOnly = true
    document.body.classList.add('ed-reader')
    const banner = div('ed-reader-banner')
    banner.innerHTML = `<span class="ed-reader-dot"></span>${t('Read-only — viewing this live session. You can watch and present, but not edit.')}`
    document.body.appendChild(banner)
  }

  // --- resizable side panels ------------------------------------------------

  private static PANEL_BOUNDS = { left: [110, 400], right: [190, 520] } as const
  private static PANEL_DEFAULTS = { left: 188, right: 236 } as const

  private restorePanelWidths() {
    try {
      const saved = lsJson<Record<string, number>>('bento-ed-panels', {})
      for (const side of ['left', 'right'] as const) {
        const [min, max] = Editor.PANEL_BOUNDS[side]
        if (typeof saved[side] === 'number') this.panelW[side] = Math.min(max, Math.max(min, saved[side]))
      }
    } catch { /* corrupt storage — keep defaults */ }
    this.applyPanelWidths()
  }

  private applyPanelWidths() {
    this.sidebar.style.setProperty('--panew', `${this.panelW.left}px`)
    this.props.style.setProperty('--panew', `${this.panelW.right}px`)
  }

  private panelToggles: { left?: HTMLElement; right?: HTMLElement } = {}

  private updatePanelChevrons() {
    const glyph = (side: 'left' | 'right') => {
      const collapsed = (side === 'left' ? this.sidebar : this.props).classList.contains('ed-collapsed')
      // chevron points where clicking will move the boundary. 'left'/'right'
      // name the DOM order, not the screen: under an RTL chrome the slide list
      // sits on the right, so the arrow that means "open me" turns around too.
      const g = side === 'left' ? (collapsed ? '›' : '‹') : (collapsed ? '‹' : '›')
      return isRtl() ? (g === '›' ? '‹' : '›') : g
    }
    for (const side of ['left', 'right'] as const) {
      const b = this.panelToggles[side]
      if (b) {
        b.textContent = glyph(side)
        const collapsed = (side === 'left' ? this.sidebar : this.props).classList.contains('ed-collapsed')
        b.title = collapsed
          ? side === 'left' ? t('Show slide list ([)') : t('Show properties (])')
          : side === 'left' ? t('Hide slide list ([)') : t('Hide properties (])')
      }
    }
  }

  private makeResizer(side: 'left' | 'right'): HTMLElement {
    const handle = div('ed-resizer')
    handle.title = t('Drag to resize · double-click to reset')
    const toggle = document.createElement('button')
    toggle.className = 'ed-panel-toggle'
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.togglePanel(side)
    })
    this.panelToggles[side] = toggle
    handle.appendChild(toggle)
    queueMicrotask(() => this.updatePanelChevrons())
    const commit = () => {
      lsSet('bento-ed-panels', JSON.stringify(this.panelW))
      // thumbnails render at a width derived from the sidebar — refit them
      if (side === 'left') this.rebuildSidebar()
    }
    handle.addEventListener('mousedown', (down) => {
      if (down.target === toggle) return // the chevron is a click, not a drag
      const panel = side === 'left' ? this.sidebar : this.props
      if (panel.classList.contains('ed-collapsed')) return
      down.preventDefault()
      const startX = down.clientX
      const startW = this.panelW[side]
      const [min, max] = Editor.PANEL_BOUNDS[side]
      panel.classList.add('ed-noanim')
      document.body.classList.add('ed-col-resizing')
      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - startX
        // clientX is physical; which way widens the panel depends on which
        // screen edge it is docked to, and RTL swaps the two panels over.
        const widens = (side === 'left') !== isRtl() ? dx : -dx
        this.panelW[side] = Math.min(max, Math.max(min, startW + widens))
        this.applyPanelWidths()
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        panel.classList.remove('ed-noanim')
        document.body.classList.remove('ed-col-resizing')
        commit()
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
    handle.addEventListener('dblclick', () => {
      this.panelW[side] = Editor.PANEL_DEFAULTS[side]
      this.applyPanelWidths()
      commit()
    })
    return handle
  }

  /** Collapse/expand the slide list or the properties panel. */
  private phoneChrome: {
    insertD: HTMLElement; insertMenu: HTMLElement
    moreD: HTMLElement; moreMenu: HTMLElement
    slidesB: HTMLElement; formatB: HTMLElement
    insert: HTMLElement; actions: HTMLElement; history: HTMLElement
    demote: HTMLElement[]
  } | null = null

  /**
   * Fold the topbar into menus on a phone, and unfold it again on a wide
   * window. REPARENTS the existing buttons rather than building phone copies:
   * a duplicate would need its own listeners and would desync from live state
   * (the dirty dot lives ON the save button; the comment button carries an
   * armed class). Moving a node keeps all of that by construction.
   */
  private applyPhoneChrome(on: boolean) {
    const p = this.phoneChrome
    if (!p || this.phoneChromeOn === on) return
    // A FRESH bar is already in its authored desktop order, so there is nothing
    // to put back — and running the restore below anyway does not just waste
    // work, it REORDERS: every demoted button lands before formatB regardless
    // of where it started, so Comment and Export PDF jumped groups and Save
    // ended up after Help. Switching language then *fixed* it, because build()
    // re-authors the bar and this call early-returns second time around, which
    // is why the bug read as "the order changes when I switch language" when it
    // was the first load that was wrong.
    const fresh = this.phoneChromeOn === null
    this.phoneChromeOn = on
    if (on) {
      // the six insert tools + comment go under ＋
      while (p.insert.firstChild) p.insertMenu.appendChild(p.insert.firstChild)
      for (const b of p.demote) {
        if (!b.parentElement) continue
        // Undo/redo/PDF are icon-only BY DESIGN in the bar (no <span> at all),
        // so the menu's label rule has nothing to reveal and they would sit in
        // ⋯ as mystery glyphs. Borrow the tooltip, minus its shortcut: "Redo
        // (⇧⌘Z)" -> "Redo". No new strings, and desktop is untouched.
        // A demoted DROPDOWN is a wrapper, so label its TRIGGER and ask the
        // trigger alone whether it already has one. Asking the wrapper always
        // answers yes — it contains the menu it hides, and that menu is full of
        // spans. Language lost its label to exactly that: it sat in ⋯ as a bare
        // globe while everything around it was captioned.
        const face = b.classList.contains('ed-dropdown')
          ? (b.firstElementChild as HTMLElement | null)
          : b
        if (face && !face.querySelector('span') && face.title) {
          const lab = document.createElement('span')
          lab.dataset.phoneLabel = '1'
          // "Redo (⇧⌘Z)" -> "Redo"; "Not sharing yet — click…" -> "Not sharing yet"
          lab.textContent = face.title.split('(')[0].split('—')[0].trim()
          face.appendChild(lab)
        }
        p.moreMenu.appendChild(b)
      }
    } else if (!fresh) {
      while (p.insertMenu.firstChild) p.insert.appendChild(p.insertMenu.firstChild)
      for (const lab of p.moreMenu.querySelectorAll('[data-phone-label]')) lab.remove()
      // The save-as rows are a phone-only copy; on a wide screen the split
      // button's caret is back and owns that list again.
      for (const row of p.moreMenu.querySelectorAll('[data-phone-saveas]')) row.remove()
      // back to their original homes, in their original order
      for (const b of p.demote) {
        if (b === p.demote[0]) p.history.appendChild(b)
        else p.actions.insertBefore(b, p.formatB)
      }
      p.moreD.classList.remove('open')
      p.insertD.classList.remove('open')
    }
  }

  private phoneChromeOn: boolean | null = null
  private phoneQuery: MediaQueryList | null = null

  togglePanel(side: 'left' | 'right') {
    const el = side === 'left' ? this.sidebar : this.props
    el.classList.toggle('ed-collapsed')
    this.updatePanelChevrons()
    // the canvas wrap resizes; its ResizeObserver re-fits the stage
  }

  // --- Save dropdown: copy / new deck / template -----------------------------

  private saveDropdown(): HTMLElement {
    const wrap = div('ed-dropdown')
    const menu = div('ed-menu ed-save-menu')
    const trigger = btn('<span class="ed-caret">▾</span>', '', () => {
      wrap.classList.toggle('open')
      if (wrap.classList.contains('open')) rebuild()
    }, t('Save as… — copy, new deck, password'))
    trigger.classList.add('ed-split-caret')
    const rebuild = () => {
      menu.textContent = ''
      this.buildSaveAsItems(menu, () => wrap.classList.remove('open'))
    }
    wrap.append(trigger, menu)
    document.addEventListener('pointerdown', (ev) => {
      if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
    })
    return wrap
  }

  /**
   * The Save-as list, built into `into`.
   *
   * Rebuilt on every open because it reflects live state: an encrypted file
   * offers Change/Remove password where a plain one offers Encrypt.
   *
   * It takes a container so ONE list can serve two homes — the desktop split
   * button's dropdown, and the ⋯ menu on a phone, where the caret that opens
   * this list does not fit beside a 44px Save button. `mark` tags what it
   * creates so the phone copy can be torn down again without disturbing the
   * real toolbar buttons parked in that same menu.
   */
  private buildSaveAsItems(into: HTMLElement, close: () => void, mark = false) {
    const tag = <T extends HTMLElement>(el: T): T => {
      if (mark) el.dataset.phoneSaveas = '1'
      return el
    }
    const item = (icon: string, label: string, title: string, onClick: () => void) => {
      const b = document.createElement('button')
      b.className = 'ed-btn'
      if (icon) b.innerHTML = icon
      b.appendChild(Object.assign(document.createElement('span'), { textContent: label }))
      b.title = title
      b.addEventListener('click', () => {
        close()
        onClick()
      })
      into.appendChild(tag(b))
    }
    {
      // FILE operations only — everything that goes to OTHER PEOPLE lives in
      // the Share panel (one mental model: Save = for me, Share = for others).
      item(ICONS.copy, t('Save a copy…'),
        t('A backup of this deck for yourself — same deck, same live session.'),
        () => void this.save(true))
      item(ICONS.plus, t('Duplicate as new deck…'),
        t('A separate deck for you — same content, new identity; it never syncs with this one.'),
        () => this.saveAsNewDeck())
      if (isEncryptionActive()) {
        item(ICONS.lock, t('Change password…'),
          t('Pick a new password for this file — takes effect on the next save.'),
          () => void this.setFilePassword())
        item(ICONS.lock, t('Remove password'),
          t('Stop encrypting this file — the next save writes it as plain, readable JSON again.'),
          () => {
            setEncryptionPassword(null)
            this.toast(t('Password removed — the next save writes an unencrypted file'))
            void this.save(false)
          })
      } else {
        item(ICONS.lock, t('Encrypt with password…'),
          t('Protect this file with a password: the document (collaboration keys included) is encrypted at rest with AES-256. The password cannot be recovered.'),
          () => void this.setFilePassword())
      }
      // the document AS DATA — history and the AI/JSON round-trip live with
      // the other file operations now (they were buried in the About dialog)
      into.appendChild(tag(div('ed-menu-sep')))
      item(ICONS.history, t('Version history…'),
        t('Restore an earlier auto-saved version of this deck (kept locally in this browser).'),
        () => void this.openVersionHistory())
      item(ICONS.code, t('Copy document JSON'),
        t('Copies this deck as plain JSON — paste it into an AI chat or any tool, then bring the edited JSON back here.'),
        () => void this.copyDocJson())
      item(ICONS.code, t('Replace from JSON…'),
        t('Paste edited document JSON to replace this deck’s content — ⌘Z undoes.'),
        () => this.openReplaceJson())
      item(ICONS.template, t('Start from scratch…'),
        t('Replace every slide with one blank slide. Keeps the deck’s theme, name and live session — ⌘Z undoes.'),
        () => this.startFromScratch())
    }
  }

  /**
   * Put the save-as list at the bottom of ⋯ on a phone.
   *
   * The split button's caret is hidden there — it does not fit beside a 44px
   * Save target — which left Save a copy, Duplicate as new deck, every password
   * action, Version history and the whole JSON round-trip with NO route on a
   * phone at all. They are file operations, so ⋯ ("everything occasional") is
   * where they belong rather than a second nested dropdown, which on glass is
   * a worse answer than a long list.
   *
   * Rebuilt on each open (the list is state-dependent) and torn down BY TAG:
   * the buttons sharing this menu are the real toolbar nodes on loan from the
   * bar, and clearing the container would destroy them.
   */
  private fillPhoneSaveAs(menu: HTMLElement, wrap: HTMLElement) {
    for (const stale of Array.from(menu.querySelectorAll('[data-phone-saveas]'))) stale.remove()
    if (!this.phoneChromeOn) return
    // `el.dataset.x = …`, never Object.assign(el, {dataset}) — dataset is a
    // getter-only accessor, so assigning it wholesale THROWS. It type-checks
    // either way, and the throw here landed before the menu's own toggle, so
    // the symptom was ⋯ refusing to open at all rather than anything about
    // save-as.
    const sep = div('ed-menu-sep')
    sep.dataset.phoneSaveas = '1'
    menu.appendChild(sep)
    this.buildSaveAsItems(menu, () => wrap.classList.remove('open'), true)
  }

  /**
   * Clear the deck back to a single blank slide (issue #31). Starting a fresh
   * presentation meant deleting every slide by hand, then stripping the one
   * the deck refuses to delete.
   *
   * CONTENT ONLY: docId, theme, size, layouts and the live session all stay.
   * "Duplicate as new deck…" (above) is the action that changes IDENTITY, and
   * conflating the two here would be the surprising choice — under collab this
   * lands as an ordinary edit everyone sees, which is what "let's start over
   * on this deck" means. One commit, so ⌘Z brings the whole deck back.
   */
  private startFromScratch() {
    const n = this.store.doc.slides.length
    if (!window.confirm(t('Replace all {n} slides with one blank slide? ⌘Z undoes this.', { n: String(n) }))) return
    const blank = builtinLayouts().find((l) => l.id === 'layout-blank')
    if (!blank) return
    this.canvas.commitTextEdit() // a live text edit would commit ONTO the new slide
    this.store.select([])
    this.store.commit(() => {
      this.store.doc.slides = [instantiateLayout(blank)]
    }, 'slides')
    this.store.goTo(0)
    this.store.emit('current')
  }

  /** A sealed hand-out: present-only player file, no editor, no live session. */
  private async savePresentationPackage() {
    const clone = JSON.parse(JSON.stringify(this.store.doc)) as import('../model').BentoDoc
    clone.readonly = true
    delete clone.collab // a sealed package must not join (or leak) the live room
    try {
      const ok = await writeUpdatedFileAs(await serializeAuto(clone), clone, { suffix: 'presentonly' })
      if (ok) this.toast(t('Presentation package saved — it opens straight into the show'))
    } catch {
      this.toast(t('Saving failed'))
    }
  }

  /** A live viewer: follows the shared session read-only. Keeps the room + read
   *  key + writer PUBKEY (so the relay knows the room's writer) but drops the
   *  writer PRIVATE key — the relay then rejects any op it tries to send. */
  private async saveReaderCopy() {
    await this.goLive() // a viewer copy follows the live session — make sure there is one
    const c = this.store.doc.collab
    if (!c?.room || !c.key) {
      this.toast(t('This deck has no live session to follow'))
      return
    }
    const clone = JSON.parse(JSON.stringify(this.store.doc)) as import('../model').BentoDoc
    clone.collab = { ...c, role: 'reader', on: true, sync: undefined }
    delete clone.collab.writerPriv // the muzzle — no write capability travels
    delete clone.collab.ownerPriv // v2: neither the owner key…
    delete clone.collab.invite //    …nor any invite (delegation) material
    try {
      const ok = await writeUpdatedFileAs(await serializeAuto(clone), clone, { suffix: 'viewonly' })
      if (ok) this.toast(t('Read-only copy saved — it follows the live session, view only'))
    } catch {
      this.toast(t('Saving failed'))
    }
  }

  /** v2 share-with-edit-access: the copy carries an owner-signed INVITE (a
   *  delegation keypair) instead of the owner's private key. Every device that
   *  opens it mints its OWN member key and joins via the owner→invite→member
   *  chain — so the owner can later revoke this invite (cutting off every copy
   *  descended from it) or a single member key, without re-keying the room. */
  private async saveEditorCopy() {
    await this.goLive()
    const c = this.store.doc.collab
    if (!(c?.room && c.key && c.v === 2 && c.ownerPriv)) {
      this.toast(t('Only the deck owner can mint editor invites'))
      return
    }
    this.canvas.commitTextEdit()
    this.session?.stampInto(this.store.doc) // copies rejoin as true forks
    const clone = JSON.parse(JSON.stringify(this.store.doc)) as import('../model').BentoDoc
    clone.collab!.invite = await mintInvite(c.ownerPriv, 'writer')
    delete clone.collab!.ownerPriv
    clone.collab!.on = true
    try {
      const ok = await writeUpdatedFileAs(await serializeAuto(clone), clone, { suffix: 'invite' })
      if (ok) this.toast(t('Editor copy saved — recipients join live with edit access'))
    } catch {
      this.toast(t('Saving failed'))
    }
  }

  private async copyDocJson() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(this.store.doc))
      this.toast(t('Document JSON copied'))
    } catch {
      this.toast(t('Couldn’t access the clipboard'))
    }
  }

  /** Paste-and-apply document JSON (the counterpart of Copy document JSON). */
  private openReplaceJson() {
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about')
    const h = document.createElement('div')
    h.className = 'ed-about-h'
    h.textContent = t('Replace from JSON')
    const ta = document.createElement('textarea')
    ta.className = 'ed-about-json'
    ta.rows = 8
    ta.placeholder = t('Paste document JSON here…')
    const row = div('ed-about-row')
    const applyB = document.createElement('button')
    applyB.className = 'ed-btn ed-btn-primary'
    applyB.textContent = t('Apply')
    applyB.addEventListener('click', () => {
      const ok = (window as unknown as { bento?: { loadDoc?: (j: string) => boolean } }).bento?.loadDoc?.(ta.value)
      if (ok) {
        this.toast(t('Document replaced — ⌘Z undoes'))
        overlay.remove()
      } else {
        ta.style.borderColor = '#C0392B'
        applyB.textContent = t('Invalid document JSON')
        setTimeout(() => { applyB.textContent = t('Apply') }, 1800)
      }
    })
    const cancelB = document.createElement('button')
    cancelB.className = 'ed-btn'
    cancelB.textContent = t('Cancel')
    cancelB.addEventListener('click', () => overlay.remove())
    row.append(applyB, cancelB)
    box.append(h, ta, row)
    overlay.appendChild(box)
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove() })
    document.body.appendChild(overlay)
    ta.focus()
  }

  /** Set or change the encryption password (double-entry dialog). */
  private async setFilePassword() {
    const pass = await this.promptPassword()
    if (pass === null) return
    setEncryptionPassword(pass)
    // Purge any plaintext snapshots already written to IndexedDB before encryption
    // was enabled — otherwise up to MAX_VERSIONS version snapshots + a recovery copy
    // (full plaintext JSON, incl. collab keys) would linger ~30 days, defeating the
    // encryption the user just turned on.
    const docId = this.store.doc.docId
    await clearRecovery(docId)
    await clearVersions(docId)
    this.toast(t('Encrypted — remember this password; it cannot be recovered'))
    void this.save(true)
  }

  private promptPassword(): Promise<string | null> {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog')
      dlg.className = 'ed-dialog ed-pwdialog'
      dlg.innerHTML =
        `<h2>${t('Encrypt with password…').replace(/…$/, '')}</h2>` +
        `<p>${t('The password cannot be recovered — if it is lost, the file is lost.')}</p>` +
        `<label>${t('Password')}<input type="password" class="pw1" autocomplete="new-password"></label>` +
        `<label>${t('Confirm password')}<input type="password" class="pw2" autocomplete="new-password"></label>` +
        `<div class="ed-pwerr"></div>` +
        `<div class="ed-dialog-actions"><button class="cancel">${t('Cancel')}</button>` +
        `<button class="ok ed-primary">${t('Set password')}</button></div>`
      document.body.appendChild(dlg)
      const pw1 = dlg.querySelector<HTMLInputElement>('.pw1')!
      const pw2 = dlg.querySelector<HTMLInputElement>('.pw2')!
      const err = dlg.querySelector<HTMLElement>('.ed-pwerr')!
      const done = (v: string | null) => {
        dlg.close()
        dlg.remove()
        resolve(v)
      }
      dlg.querySelector('.cancel')!.addEventListener('click', () => done(null))
      dlg.querySelector('.ok')!.addEventListener('click', () => {
        if (!pw1.value) {
          err.textContent = t('Password')
          return
        }
        if (pw1.value !== pw2.value) {
          err.textContent = t('Passwords do not match')
          return
        }
        done(pw1.value)
      })
      dlg.addEventListener('cancel', () => done(null))
      dlg.showModal()
      pw1.focus()
    })
  }

  private async saveAsNewDeck() {
    const clone = JSON.parse(JSON.stringify(this.store.doc)) as import('../model').BentoDoc
    clone.docId = newDocId()
    clone.collab = await mintCollab()
    this.store.replaceDoc(clone)
    this.toast(t('This is now a new deck — save it under a new name'))
    void this.save(true)
  }

  private async saveAsTemplate() {
    const clone = JSON.parse(JSON.stringify(this.store.doc)) as import('../model').BentoDoc
    clone.template = true
    delete clone.collab // instances mint their own credentials
    delete (clone as { docId?: string }).docId
    try {
      const ok = await writeUpdatedFileAs(serializeFile(clone), clone, { suffix: 'template' })
      if (ok) this.toast(t('Template saved — every open of it starts a fresh deck'))
    } catch (err) {
      console.error(err)
      this.toast(t('Save failed — see console'))
    }
  }

  // --- live-collaboration Share popover ------------------------------------

  private shareDropdown(): HTMLElement {
    const wrap = div('ed-dropdown')
    this.shareWrap = wrap
    this.shareB = btn(ICONS.share, t('Share'), () => {
      wrap.classList.toggle('open')
      if (wrap.classList.contains('open')) this.renderSharePanel()
    }, t('Share — invite people to edit, send view-only copies, see who’s here'))
    // stable hook for the status dot (grey dormant / amber connecting / green live)
    this.shareB.classList.add('ed-btn-share')
    this.shareB.title = t('Not sharing yet — click to start a live session')
    const panel = div('ed-menu ed-share-pop')
    wrap.append(this.shareB, panel)
    document.addEventListener('pointerdown', (ev) => {
      if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
    })
    return wrap
  }

  private renderSharePanel() {
    const panel = this.shareWrap.querySelector<HTMLElement>('.ed-share-pop')!
    panel.innerHTML = ''
    const note = (txt: string, cls = 'ed-share-note') => {
      const e = div(cls)
      e.textContent = txt
      panel.appendChild(e)
      return e
    }
    const action = (icon: string, label: string, primary: boolean, onClick: () => void, title = '') => {
      const b = document.createElement('button')
      b.className = primary ? 'ed-btn ed-btn-primary ed-share-btn' : 'ed-btn ed-share-btn'
      if (icon) b.innerHTML = icon
      b.appendChild(Object.assign(document.createElement('span'), { textContent: label }))
      if (title) b.title = title
      b.addEventListener('click', onClick)
      panel.appendChild(b)
      return b
    }
    // your display name — self-managed, stored in this browser only, shown
    // to collaborators via presence (shared with the comments feature)
    const nameRow = div('ed-share-name')
    const nameLabel = document.createElement('label')
    nameLabel.textContent = t('Your name')
    nameRow.title = t('Shown next to your cursor and in the People list — stored only in this browser.')
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.placeholder = t('Guest')
    try {
      nameInput.value = lsGet('bento-author') ?? ''
    } catch {
      /* storage unavailable */
    }
    nameInput.addEventListener('change', () => {
      try {
        lsSet('bento-author', nameInput.value.trim())
      } catch {
        /* storage unavailable */
      }
      this.session?.hello() // push the new name to peers right away
    })
    nameRow.append(nameLabel, nameInput)
    panel.appendChild(nameRow)

    // People: colored dot, key-bound name, role, slide; click follows. The
    // OWNER (v2) also gets a Remove button per member — a signed revocation of
    // that device's key: the relay drops its writes and refuses its reconnects,
    // nobody else is disturbed (see docs/collab-design.md roadmap).
    const peers = this.session?.peers() ?? []
    const cme = this.store.doc.collab
    const iAmOwner = !!(cme?.v === 2 && cme.ownerPriv && cme.owner)
    const roleLabel = (r?: string) => r === 'owner' ? t('Owner') : r === 'viewer' ? t('Viewer') : r === 'editor' ? t('Editor') : ''
    // short, readable key fingerprint — the same rendering everywhere, so two
    // people can compare codes over a call to verify an identity out-of-band
    const fp = (pub?: string) => pub ? pub.slice(0, 4) + '·' + pub.slice(4, 8) + '·' + pub.slice(8, 12) : ''
    // YOUR identity on this device: which key this copy signs with + its role.
    // Per-device by design — the same person on another machine is a separate
    // key (and roster entry) the owner can admit or remove independently.
    if (cme) {
      let myPub: string | undefined
      let myRole: 'owner' | 'editor' | 'viewer' | undefined
      if (cme.role === 'reader') myRole = 'viewer'
      else if (cme.v === 2 && cme.ownerPriv) { myRole = 'owner'; myPub = cme.owner }
      else if (cme.v === 2 && cme.invite) {
        myRole = 'editor'
        myPub = lsJson<{ pub?: string } | null>(`bento-member-${this.store.doc.docId}`, null)?.pub
      } else if (cme.writerPriv) { myRole = 'editor'; myPub = cme.writerPub }
      if (myRole) {
        const label = div('ed-share-label')
        label.textContent = t('People')
        panel.appendChild(label)
        const me = div('ed-share-peer ed-share-me')
        const who = document.createElement('span')
        who.className = 'who'
        let myName = t('Guest')
        myName = lsGet('bento-author') || myName
        who.textContent = `${myName} (${t('you')})`
        const where = document.createElement('span')
        where.className = 'where'
        where.textContent = [roleLabel(myRole), fp(myPub)].filter(Boolean).join(' · ')
        me.title = myPub
          ? t('Your key on THIS device: {fp}. Another device counts as a new person until the owner removes it.', { fp: fp(myPub) })
          : t('View-only copy — it holds no signing key.')
        me.append(who, where)
        panel.appendChild(me)
      }
    }
    if (peers.length) {
      const list = div('ed-share-peers')
      for (const peer of peers) {
        const row = document.createElement('button')
        row.className = 'ed-share-peer'
        const dot = document.createElement('span')
        dot.className = 'dot'
        dot.style.background = peer.color
        const who = document.createElement('span')
        who.className = 'who'
        who.textContent = peer.editing ? `${peer.name} ✏️` : peer.name
        // a pub-carrying peer's name is bound to its signing key, not just typed
        if (peer.pub) who.title = t('Key-verified identity') + ` · ${fp(peer.pub)}`
        const where = document.createElement('span')
        where.className = 'where'
        const idx = this.store.doc.slides.findIndex((s) => s.id === peer.slide)
        where.textContent = [roleLabel(peer.role), idx >= 0 ? t('slide {n}', { n: idx + 1 }) : ''].filter(Boolean).join(' · ')
        row.append(dot, who, where)
        row.title = t('{name} — on slide {n} (click to follow)', { name: peer.name, n: idx + 1 })
        row.addEventListener('click', () => {
          if (idx >= 0) this.store.goTo(idx)
        })
        if (iAmOwner && peer.pub && peer.pub !== cme!.owner) {
          const kick = document.createElement('span')
          kick.className = 'kick'
          kick.textContent = '✕'
          kick.title = t('Remove {name} — revokes this device’s access; everyone else is unaffected', { name: peer.name })
          kick.addEventListener('click', async (ev) => {
            ev.stopPropagation()
            if (!confirm(t('Remove {name} from this deck? Their copy drops to read-only.', { name: peer.name }))) return
            const tr = onlineTransport()
            const ok = tr && (await tr.revokeKey(peer.pub!, cme!.owner!, cme!.ownerPriv!))
            this.toast(ok ? t('{name} was removed', { name: peer.name }) : t('Couldn’t reach the live session'))
          })
          row.appendChild(kick)
        }
        list.appendChild(row)
      }
      panel.appendChild(list)
    }

    if (offlineEnabled()) {
      note(t('Offline mode is on — nothing leaves this computer.'))
      note(t('Tabs on this machine still sync; turn offline mode off in the About dialog to collaborate online.'))
      return
    }

    // status line: one glance = am I live, with how many people
    const tr = onlineTransport()
    const on = sharingOn(this.store) && !!tr
    const status = note('', 'ed-share-status')
    if (on) {
      const n = (this.session?.peers().length ?? 0) + 1
      status.textContent = tr!.status === 'open'
        ? `● ${t('Live')} — ${t('{n} connected', { n })}`
        : `● ${t('Connecting…')}`
      status.classList.toggle('ok', tr!.status === 'open')
    } else {
      status.textContent = `○ ${t('Not live — turns on when you share')}`
    }

    // SHARE ACTIONS — sharing IS files: each button saves a copy to send, and
    // turns the live session on. Labels stay short; the tooltips explain.
    const canWrite = !!cme && cme.role !== 'reader'
    if (canWrite) {
      const label = div('ed-share-label')
      label.textContent = t('Share a copy')
      panel.appendChild(label)
      action(ICONS.share, t('Invite to edit…'), true, () => void this.inviteToEdit(),
        t('Saves a copy to send. Whoever opens it edits this deck live with you (end-to-end encrypted); you stay the owner and can remove them from the People list.'))
      action(ICONS.eye, t('View-only copy…'), false, () => void this.saveReaderCopy(),
        t('A live viewer: follows every edit as it happens but can never change the deck — the relay enforces it.'))
      action(ICONS.slideshow, t('Present-only file…'), false, () => void this.savePresentationPackage(),
        t('A sealed hand-out that opens straight into the show — no editor, no live connection.'))
      action(ICONS.template, t('Template…'), false, () => void this.saveAsTemplate(),
        t('A reusable starter: everyone who opens it gets their own fresh, independent deck.'))
    } else {
      note(t('This is a view-only copy — it follows the live session but can’t change the deck.'))
    }

    // advanced session controls, deliberately quiet at the bottom
    if (canWrite) {
      panel.appendChild(div('ed-share-sep'))
      if (on) {
        action(ICONS.stop, t('Stop sharing'), false, () => {
          if (!this.session) return
          stopSharing(this.session, this.store)
          this.wireOnlineStatus()
          this.renderSharePanel()
        }, t('Disconnect this deck from the live session. Copies keep their last state and can rejoin if you go live again.'))
      } else {
        action(ICONS.live, t('Go live'), false, () => void this.goLive().then(() => this.renderSharePanel()),
          t('Connect to the live session without saving a new copy — copies you sent earlier will meet you there.'))
      }
      action(ICONS.key, t('Reset access…'), false, async () => {
        if (!this.session) return
        if (!confirm(t('Reset access? Every copy you’ve sent stops syncing; only copies saved after this can join.'))) return
        await rotateKeys(this.session, this.store)
        this.toast(t('Access reset — only copies saved from now on can join'))
        this.renderSharePanel()
      }, t('Mints brand-new keys. Every previously sent copy stops syncing for good; share fresh copies afterwards.'))
    }
  }

  /** Turn the live session on (idempotent). Sharing a copy calls this first, so
   *  "share" is one action for users — no separate start-a-session step. */
  private async goLive() {
    if (!this.session || offlineEnabled()) return
    this.session.enableSharing()
    await startSharing(this.session, this.store)
    this.wireOnlineStatus()
  }

  /** "Invite to edit": ONE button for every copy type. v2 owners mint a
   *  revocable invite; legacy decks and member copies pass their own
   *  capability along (a copy of the file IS the invite there). */
  private async inviteToEdit() {
    await this.goLive()
    const c = this.store.doc.collab
    if (c?.v === 2 && c.ownerPriv) return this.saveEditorCopy()
    await this.save(true)
  }

  /**
   * Languages dialog, organised by WHERE a language lives — because that is
   * the only thing about it a user actually has to decide:
   *
   *   In this file          travels with the deck; everyone who opens it has it
   *   On this computer      this browser only; every deck you open here
   *   Available to add      published, not here yet
   *
   * The two scopes behave very differently and used to be explained in one
   * buried sentence. Naming them as sections makes the consequence — "will the
   * person I send this to see it?" — readable at a glance instead of inferred.
   *
   * "In this file" today means the languages compiled into the build. Packs
   * spliced into a saved file will list there too, under the same heading,
   * which is why the section is worded around the FILE rather than around
   * "built in".
   */
  private async openLanguages() {
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about')
    const h = div('ed-about-h')
    h.textContent = t('Languages')
    box.appendChild(h)

    const listHost = div('ed-lang-manage')
    box.appendChild(listHost)

    const paint = async () => {
      listHost.textContent = ''
      const bundled = LOCALE_CHOICES.filter((c) => c.code !== 'en')

      const section = (label: string, blurb: string) => {
        const s = div('ed-lang-sec')
        s.textContent = label
        listHost.appendChild(s)
        const b = div('ed-lang-blurb')
        b.textContent = blurb
        listHost.appendChild(b)
      }
      const row = (label: string, sub: string, actions: HTMLElement[] = [], host: HTMLElement = listHost) => {
        const r = div('ed-lang-row')
        const txt = div('ed-lang-txt')
        const n = document.createElement('b')
        n.textContent = label
        const s = document.createElement('span')
        s.textContent = sub
        txt.append(n, s)
        r.appendChild(txt)
        if (actions.length) {
          const acts = div('ed-lang-acts')
          for (const a of actions) acts.appendChild(a)
          r.appendChild(acts)
        }
        host.appendChild(r)
      }

      section(t('In this file'), t('Travels with the deck — anyone you send it to gets these too.'))
      row('English, ' + bundled.map((c) => c.label).join(', '), t('Included in every Bento'))
      for (const p of packsInFile()) {
        const rm = document.createElement('button')
        rm.className = 'ed-btn'
        rm.textContent = t('Remove')
        rm.title = t('Take out of the file — applies when you next save')
        rm.addEventListener('click', () => {
          unstageFromFile(p.lang)
          this.build()
          this.rebuildSidebar()
          void paint()
        })
        row(
          p.label || p.lang,
          p.pending ? t('Added when you next save') : t('Saved in this file'),
          [rm],
        )
        // Say how much English this pack will actually show. A pack is frozen
        // at the version it was built for while the app keeps gaining strings,
        // so a translated deck slowly reverts — silently, per string. Naming
        // the number turns "why is some of this English?" into a fact, and the
        // sentence says it fixes itself so nobody goes hunting for a button.
        const cov = packCoverage(p)
        if (cov.missing > 0) {
          const warn = div('ed-lang-warn')
          warn.textContent = t(
            'Built for v{v} — {n} phrases still show in English. Updating Bento refreshes it.',
            { v: p.version ?? '?', n: String(cov.missing) },
          )
          listHost.appendChild(warn)
        }
      }

      const all = await availablePacks()
      section(t('Available to add'), t('Goes into the deck itself, so it travels with the file. Written when you next save.'))
      if (!all.length) {
        const none = div('ed-hint')
        none.textContent = t('Nothing new right now.')
        listHost.appendChild(none)
      }
      // Search + a scrolling list: this section is the one that grows without
      // bound as more languages ship, while the two above stay short. Matching
      // on the endonym AND the code means someone who knows "nl" but not
      // "Nederlands" (or the reverse) finds it either way.
      if (all.length > SEARCH_FROM) {
        const search = document.createElement('input')
        search.type = 'search'
        search.className = 'ed-lang-search'
        search.placeholder = t('Search languages')
        search.addEventListener('input', () => renderAvail(search.value))
        listHost.appendChild(search)
      }
      const scroller = div(all.length > SEARCH_FROM ? 'ed-lang-scroll' : '')
      listHost.appendChild(scroller)

      const renderAvail = (q = '') => {
        scroller.textContent = ''
        // Nothing on offer at all is already stated above — saying it twice,
        // once as 'No language matches ""', is worse than saying it once.
        if (!all.length) return
        const needle = q.trim().toLowerCase()
        const hits = needle
          ? all.filter((p) => p.label.toLowerCase().includes(needle) || p.lang.toLowerCase().includes(needle))
          : all
        if (!hits.length) {
          const none = div('ed-hint')
          none.textContent = t('No language matches “{q}”.', { q: q.trim() })
          scroller.appendChild(none)
          return
        }
        for (const p of hits) addRow(p, scroller)
      }

      // One destination. A pack lives in the FILE — see packs.ts for why the
      // "on this computer" option was removed rather than kept alongside.
      const addRow = (p: import('../packs').PackListing, host: HTMLElement) => {
        const add = document.createElement('button')
        add.className = 'ed-btn'
        add.textContent = t('Add')
        add.title = t('Put it in the deck — written when you next save.')
        add.addEventListener('click', async () => {
          add.disabled = true
          add.textContent = t('Adding…')
          const got = await fetchPack(p)
          if (typeof got === 'string') {
            this.toast(languageInstallError(got))
            add.disabled = false
            add.textContent = t('Add')
            return
          }
          stageForFile(got)
          this.toast(t('{lang} will be saved with this deck', { lang: p.label }))
          this.build()
          this.rebuildSidebar()
          void paint()
        })
        row(p.label, p.lang, [add], host)
      }

      renderAvail()
    }
    await paint()

    const row = div('ed-about-row')
    const close = document.createElement('button')
    close.className = 'ed-btn'
    close.textContent = t('Done')
    close.addEventListener('click', () => overlay.remove())
    row.appendChild(close)
    box.appendChild(row)

    overlay.appendChild(box)
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove() })
    document.body.appendChild(overlay)
  }

  /** Globe → locale picker. UI language follows the VIEWER, never the file. */
  private languageDropdown(): HTMLElement {
    const wrap = div('ed-dropdown')
    const trigger = btn(ICONS.globe, '', () => wrap.classList.toggle('open'), t('Language'))
    const menu = div('ed-menu ed-lang-menu')
    // localeChoices(), NOT the frozen LOCALE_CHOICES const: installing a pack
    // appends a language at runtime, and a static list could never show it.
    for (const c of localeChoices()) {
      const b = btn('', c.label, () => {
        wrap.classList.remove('open')
        setLocale(c.code)
        // switching to (or away from) Arabic/Hebrew/… turns the chrome around
        applyDirection()
        this.build()
        this.rebuildSidebar()
      })
      if (c.code === locale()) b.classList.add('ed-lang-on')
      menu.appendChild(b)
    }
    menu.appendChild(div('ed-menu-sep'))
    menu.appendChild(btn('', t('Manage languages…'), () => {
      wrap.classList.remove('open')
      void this.openLanguages()
    }))
    // end-anchored so the menu never overflows the window edge — as a class,
    // not inline left/right, so it follows the chrome's direction (.ed-lang-menu
    // in styles.css, alongside the Save menu's identical rule)
    wrap.append(trigger, menu)
    document.addEventListener('pointerdown', (ev) => {
      if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
    })
    return wrap
  }

  private shapeDropdown(): HTMLElement {
    const wrap = div('ed-dropdown')
    const trigger = btn(ICONS.shapes, t('Shape'), () => wrap.classList.toggle('open'))
    const menu = div('ed-menu')
    for (const item of SHAPE_MENU) {
      const b = btn(item.icon, t(item.label), () => {
        wrap.classList.remove('open')
        // line / curve / connector arm a draw tool — drag on the canvas to draw
        // (or click to drop a default); other shapes insert straight away.
        if (item.draw) { this.canvas.armDraw(item.draw); return }
        this.canvas.insert(defaultShape(item.kind))
      }, t(item.tip))
      menu.appendChild(b)
    }
    wrap.append(trigger, menu)
    document.addEventListener('pointerdown', (ev) => {
      if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
    })
    return wrap
  }

  // --- sidebar -----------------------------------------------------------------

  private makeThumb(slide: import('../model').Slide, i: number, isState: boolean): HTMLElement {
    const item = div('ed-thumb')
    item.dataset.index = String(i)
    item.draggable = !isState
    const num = div('ed-thumb-num')
    if (isState) {
      const parentIdx = this.store.doc.slides.findIndex((s) => s.id === slide.stateOf)
      num.textContent = slide.name ?? `⤷ ${parentIdx + 1}`
      num.title = `Interactive state of slide ${parentIdx + 1} — reached via links while presenting`
    } else {
      num.textContent = String(this.linearNumber(i))
    }
    // thumb width tracks the (resizable) sidebar; states render smaller
    const base = Math.max(96, this.panelW.left - 52)
    const surface = renderThumbnail(slide, this.store.doc, isState ? Math.round(base * 0.84) : base)
    if (slide.comments?.some((c) => !c.resolved)) {
      const badge = div('ed-thumb-cmt')
      badge.title = `${slide.comments.filter((c) => !c.resolved).length} open comment(s)`
      item.appendChild(badge)
    }
    const tools = div('ed-thumb-tools')
    tools.append(
      btn(ICONS.copy, '', (ev) => { ev.stopPropagation(); this.duplicateSlide(i) }, t('Duplicate slide')),
      btn(ICONS.trash, '', (ev) => { ev.stopPropagation(); this.deleteSlide(i) }, t('Delete slide')),
    )
    item.append(num, surface, tools)
    item.addEventListener('click', () => this.store.goTo(i))
    if (!isState) this.wireThumbDrag(item, i)
    return item
  }

  /** 1-based position among non-state slides (what the audience counts). */
  private linearNumber(i: number): number {
    return this.store.doc.slides.slice(0, i + 1).filter((s) => !s.stateOf).length
  }

  private rebuildSidebar() {
    // States sit in doc order right after their parent and render nested —
    // smaller, indented, dimmed — so the structure reads at a glance.
    const scroll = this.sidebar.scrollTop
    this.sidebar.innerHTML = ''
    const slides = this.store.doc.slides
    slides.forEach((slide, i) => {
      // hover gap = insert here; never between a parent and its states
      if (!slide.stateOf) this.sidebar.appendChild(this.insertGap(i))
      const item = this.makeThumb(slide, i, !!slide.stateOf)
      if (slide.stateOf) item.classList.add('ed-thumb-state')
      this.sidebar.appendChild(item)
    })
    this.sidebar.appendChild(this.insertGap(slides.length))
    const add = btn(ICONS.plus, t('New slide'), () => this.openLayoutPicker(add))
    add.classList.add('ed-add-slide')
    add.title = t('New slide from a layout')
    this.sidebar.appendChild(add)
    this.sidebar.scrollTop = scroll
    this.highlightSidebar()
  }

  // --- layouts ---------------------------------------------------------------

  /** Layout popover. Serves three flows: the New-slide button, the
   *  insert-gaps (both insert at a position), and Apply-to-current-slide. */
  private openLayoutPicker(
    anchor: HTMLElement,
    action: { kind: 'insert'; at: number } | { kind: 'apply' } = { kind: 'insert', at: this.store.currentIndex + 1 },
  ) {
    document.querySelector('.ed-layoutpick')?.remove()
    const pick = div('ed-layoutpick')
    const doc = this.store.doc
    if (action.kind === 'apply') {
      const t = div('ed-layoutpick-title')
      t.textContent = i18nT('Apply layout to this slide')
      pick.appendChild(t)
    }
    const sections: Array<[string, Slide[], boolean]> = [[t('Built-in'), builtinLayouts(doc.size), false]]
    if (doc.layouts?.length) sections.push([t('This document'), doc.layouts, true])
    for (const [label, layouts, custom] of sections) {
      const h = div('ed-layoutpick-h')
      h.textContent = label
      pick.appendChild(h)
      const grid = div('ed-layoutpick-grid')
      for (const ly of layouts) {
        const item = div('ed-layoutpick-item')
        item.appendChild(renderThumbnail(ly, doc, 104))
        const name = div('ed-layoutpick-name')
        name.textContent = ly.name ?? t('Untitled')
        item.appendChild(name)
        item.addEventListener('click', () => {
          pick.remove()
          if (action.kind === 'insert') this.insertSlideFromLayout(ly, action.at)
          else this.applyLayoutToCurrent(ly)
        })
        if (custom) {
          const del = document.createElement('button')
          del.className = 'ed-layoutpick-del'
          del.textContent = '✕'
          del.title = t('Delete this layout')
          del.addEventListener('click', (ev) => {
            ev.stopPropagation()
            this.store.commit(() => {
              doc.layouts = doc.layouts!.filter((l) => l.id !== ly.id)
              if (!doc.layouts.length) delete doc.layouts
            })
            pick.remove()
          })
          item.appendChild(del)
        }
        grid.appendChild(item)
      }
      pick.appendChild(grid)
    }
    const r = anchor.getBoundingClientRect()
    if (anchor.classList.contains('ed-add-slide')) {
      // bottom-of-sidebar button: open upward from it
      pick.style.left = `${Math.max(8, r.left)}px`
      pick.style.bottom = `${window.innerHeight - r.top + 8}px`
    } else {
      // insert-gap or panel button: open beside the anchor, clamped on-screen
      pick.style.left = `${Math.max(8, Math.min(r.right + 10, window.innerWidth - 440))}px`
      pick.style.top = `${Math.max(8, Math.min(r.top - 40, window.innerHeight - 460))}px`
    }
    document.body.appendChild(pick)
    const close = (ev: PointerEvent) => {
      if (!pick.contains(ev.target as Node)) {
        pick.remove()
        document.removeEventListener('pointerdown', close, true)
      }
    }
    setTimeout(() => document.addEventListener('pointerdown', close, true))
  }

  private insertSlideFromLayout(layout: Slide, at: number) {
    const slide = instantiateLayout(layout)
    this.store.commit(() => {
      this.store.doc.slides.splice(at, 0, slide)
    }, 'slides')
    this.store.goTo(at)
  }

  /** Re-arrange the current slide onto a layout: content matched by id, then
   *  by role; the layout brings frame + typography; extras are kept on top. */
  private applyLayoutToCurrent(layout: Slide) {
    const known = layoutElementIds(this.store.doc)
    this.store.commit(() => {
      const s = this.store.slide
      s.elements = applyLayout(s, layout, known)
      s.background = layout.background
    })
    this.store.select([])
  }

  /** Slim hover strip between thumbnails — click inserts a blank slide there. */
  private insertGap(at: number): HTMLElement {
    const gap = div('ed-insertgap')
    gap.title = t('Insert slide here')
    const plus = document.createElement('button')
    plus.className = 'ed-insertgap-btn'
    plus.textContent = '＋'
    plus.tabIndex = -1
    gap.appendChild(plus)
    gap.addEventListener('click', () => this.openLayoutPicker(gap, { kind: 'insert', at }))
    return gap
  }

  private wireThumbDrag(item: HTMLElement, index: number) {
    item.addEventListener('dragstart', (ev) => {
      ev.dataTransfer!.setData('text/bento-slide', String(index))
      ev.dataTransfer!.effectAllowed = 'move'
    })
    item.addEventListener('dragover', (ev) => {
      ev.preventDefault()
      item.classList.add('drop')
    })
    item.addEventListener('dragleave', () => item.classList.remove('drop'))
    item.addEventListener('drop', (ev) => {
      ev.preventDefault()
      item.classList.remove('drop')
      const from = parseInt(ev.dataTransfer!.getData('text/bento-slide'))
      if (Number.isNaN(from) || from === index) return
      this.store.commit(() => {
        const [moved] = this.store.doc.slides.splice(from, 1)
        this.store.doc.slides.splice(index, 0, moved)
      }, 'slides')
      this.store.currentIndex = index
      this.store.emit('current')
    })
  }

  private highlightSidebar() {
    let active: HTMLElement | undefined
    this.sidebar.querySelectorAll<HTMLElement>('.ed-thumb').forEach((n) => {
      const isActive = Number(n.dataset.index) === this.store.currentIndex
      n.classList.toggle('active', isActive)
      if (isActive) active = n
    })
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  private scheduleThumbs() {
    clearTimeout(this.thumbTimer)
    this.thumbTimer = window.setTimeout(() => {
      const thumbs = this.sidebar.querySelectorAll<HTMLElement>('.ed-thumb')
      if (thumbs.length !== this.store.doc.slides.length) return this.rebuildSidebar()
      const base = Math.max(96, this.panelW.left - 52)
      thumbs.forEach((item) => {
        const slide = this.store.doc.slides[Number(item.dataset.index)]
        if (!slide) return
        const w = slide.stateOf ? Math.round(base * 0.84) : base
        item.querySelector('.bento-thumb-surface')?.replaceWith(renderThumbnail(slide, this.store.doc, w))
        // comment badge tracks doc-level changes too (comments emit 'doc')
        const open = slide.comments?.some((c) => !c.resolved)
        const badge = item.querySelector('.ed-thumb-cmt')
        if (open && !badge) {
          const b = div('ed-thumb-cmt')
          b.title = t('Open comment(s)')
          item.appendChild(b)
        } else if (!open && badge) {
          badge.remove()
        }
      })
    }, 150)
  }

  // --- slide ops ------------------------------------------------------------------

  private duplicateSlide(i: number) {
    // Duplicated slides keep element ids → set transition to morph and you
    // get PowerPoint-Morph behaviour for free.
    const clone = JSON.parse(JSON.stringify(this.store.doc.slides[i]))
    clone.id = uid('slide')
    this.store.commit(() => {
      this.store.doc.slides.splice(i + 1, 0, clone)
    }, 'slides')
    this.store.goTo(i + 1)
  }

  private deleteSlide(i: number) {
    const target = this.store.doc.slides[i]
    if (!target) return
    // dependents: states of this slide, and element links pointing at it
    const states = this.store.doc.slides.filter((s) => s.stateOf === target.id)
    const doomedIds = new Set([target.id, ...states.map((s) => s.id)])
    // "A deck needs at least one slide" has to be checked against what will
    // SURVIVE, not against the current count: deleting a parent takes its
    // interactive states with it, so one slide + one state (length 2) sailed
    // past a `length <= 1` test and then deleted BOTH — leaving a deck with
    // zero slides and an editor with nothing to render (issue #30). States
    // don't count as survivors: they're unreachable except through a parent.
    const survivesLinear = this.store.doc.slides.some((s) => !s.stateOf && !doomedIds.has(s.id))
    if (!survivesLinear) return this.toast(t('A deck needs at least one slide'))
    let linkCount = 0
    for (const s of this.store.doc.slides) {
      if (doomedIds.has(s.id)) continue
      for (const el of s.elements) if (el.link && doomedIds.has(el.link)) linkCount++
    }
    if (states.length || linkCount) {
      const parts = [
        states.length ? `${states.length} interactive state${states.length > 1 ? 's' : ''} will be deleted with it` : '',
        linkCount ? `${linkCount} element link${linkCount > 1 ? 's' : ''} will be cleared` : '',
      ].filter(Boolean).join('; ')
      if (!window.confirm(t('Delete this slide? {parts}.', { parts }))) return
    }
    this.store.commit(() => {
      this.store.doc.slides = this.store.doc.slides.filter((s) => !doomedIds.has(s.id))
      for (const s of this.store.doc.slides) {
        for (const el of s.elements) {
          if (el.link && doomedIds.has(el.link)) delete el.link
        }
      }
    }, 'slides')
    this.store.goTo(Math.min(i, this.store.doc.slides.length - 1))
    this.store.emit('current')
  }

  /**
   * Export the deck to PDF via the browser's print pipeline: every linear
   * slide becomes one exact 1600×900 page (states are reachable only through
   * interaction, so they stay out of the paper trail).
   */
  exportPdf() {
    this.canvas.commitTextEdit()
    document.getElementById('bento-print')?.remove()
    const box = div('')
    box.id = 'bento-print'
    // page geometry follows the deck's aspect (width normalised to 1600)
    const pageH = Math.round((1600 * this.store.doc.size.height) / this.store.doc.size.width)
    const pageCss = document.createElement('style')
    pageCss.textContent = `@page { size: 1600px ${pageH}px; margin: 0; } #bento-print .bp-page { height: ${pageH}px; }`
    box.appendChild(pageCss)
    for (const slide of this.store.doc.slides) {
      if (slide.stateOf) continue
      const page = div('bp-page')
      const surface = renderSlide(slide, this.store.doc, { svgAsImage: true, hidePlaceholders: true })
      // normalise to the print page size regardless of doc size
      const s = 1600 / this.store.doc.size.width
      surface.style.transformOrigin = '0 0'
      if (s !== 1) surface.style.transform = `scale(${s})`
      page.appendChild(surface)
      box.appendChild(page)
    }
    document.body.appendChild(box)
    const cleanup = () => {
      box.remove()
      window.removeEventListener('afterprint', cleanup)
    }
    window.addEventListener('afterprint', cleanup)
    // give the freshly-inserted images a beat to decode before printing
    setTimeout(() => window.print(), 250)
  }

  // --- insert image ------------------------------------------------------------------

  private pickImage() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const src = String(reader.result)
        const img = new Image()
        img.onload = () => {
          const { width: dw, height: dh } = this.store.doc.size
          const scale = Math.min((dw * 0.5) / img.width, (dh * 0.5) / img.height, 1)
          const w = Math.round(img.width * scale)
          const h = Math.round(img.height * scale)
          this.canvas.insert(defaultImage(src, { w, h, x: (dw - w) / 2, y: (dh - h) / 2 }))
        }
        img.src = src
      }
      reader.readAsDataURL(file)
    })
    input.click()
  }

  // --- insert media (video / audio) --------------------------------------------------

  /** Media insert menu: a file (embeds) or a link (stays a URL — keeps the
   *  deck small; good for big clips that shouldn't ride inside the file). */
  private mediaDropdown(): HTMLElement {
    const wrap = div('ed-dropdown')
    const trigger = btn(ICONS.media, t('Media'), () => wrap.classList.toggle('open'),
      t('Add video or audio — from a file (embeds it) or a link (stays a URL)'))
    const menu = div('ed-menu')
    const item = (label: string, onClick: () => void) => {
      menu.appendChild(btn(ICONS.media, t(label), () => { wrap.classList.remove('open'); onClick() }))
    }
    item('Video or audio file…', () => this.pickMedia())
    item('Video from a link…', () => this.promptMediaUrl('video'))
    item('Audio from a link…', () => this.promptMediaUrl('audio'))
    wrap.append(trigger, menu)
    document.addEventListener('pointerdown', (ev) => {
      if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
    })
    return wrap
  }

  /** Insert a media element that REFERENCES a URL (not embedded). */
  private promptMediaUrl(kind: 'video' | 'audio') {
    // t(kind), not kind: 'video'/'audio' are model words here, and dropping
    // them raw into a translated sentence leaves one English noun in it.
    const url = window.prompt(t('Paste the {kind} URL — it stays a link, the file is not embedded:', { kind: t(kind) }))?.trim()
    if (!url) return
    this.insertMedia(kind, url)
  }

  private pickMedia() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'video/*,audio/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      const kind: 'video' | 'audio' = file.type.startsWith('audio') ? 'audio' : 'video'
      if (file.size > MEDIA_EMBED_BUDGET) {
        const mb = Math.round(file.size / (1024 * 1024))
        const ok = confirm(t(
          'This {kind} is {mb} MB. Embedding keeps it inside the .bento.html but makes the file large and slow to open and save.\n\nEmbed anyway? (Cancel, then paste a hosted URL in the panel to keep the deck small.)',
          { kind: t(kind), mb }, // localise the noun — see promptMediaUrl
        ))
        if (!ok) { this.insertMedia(kind, ''); return } // empty element → panel URL field
      }
      const reader = new FileReader()
      reader.onload = () => this.insertMedia(kind, String(reader.result))
      reader.readAsDataURL(file)
    })
    input.click()
  }

  /** Insert a media element, sizing video to its intrinsic aspect when known. */
  private insertMedia(kind: 'video' | 'audio', src: string) {
    const { width: dw, height: dh } = this.store.doc.size
    if (kind === 'audio' || !src) {
      const w = kind === 'audio' ? 460 : 560
      const h = kind === 'audio' ? 56 : 315
      this.canvas.insert(defaultMedia(kind, src, { w, h, x: (dw - w) / 2, y: (dh - h) / 2 }))
      return
    }
    const probe = document.createElement('video')
    const place = (w: number, h: number) =>
      this.canvas.insert(defaultMedia('video', src, { w: Math.round(w), h: Math.round(h), x: (dw - w) / 2, y: (dh - h) / 2 }))
    probe.preload = 'metadata'
    probe.onloadedmetadata = () => {
      const ar = probe.videoWidth && probe.videoHeight ? probe.videoWidth / probe.videoHeight : 16 / 9
      const w = Math.min(dw * 0.6, 640)
      place(w, w / ar)
    }
    probe.onerror = () => place(560, 315)
    probe.src = src
  }

  /** A themed table adapted to the current slide. Dark backgrounds need light
   *  body text and separators; the theme still owns the header treatment. */
  private newTable(): TableElement {
    const tbl = defaultTable({}, this.store.doc.theme)
    if (!isLightBg(this.store.slide.background)) {
      tbl.style.color = readableInk(this.store.slide.background)
      tbl.style.zebra = 'rgba(255,255,255,0.06)'
      tbl.style.borderColor = 'rgba(255,255,255,0.16)'
    }
    return tbl
  }

  // --- present & save ------------------------------------------------------------------

  /** Open the speaker view now (a launcher twin of the Slide-panel button) so it
   *  can be placed on a second screen before presenting — present mode adopts it. */
  openSpeakerView() {
    const w = openSpeakerWindow(
      `${this.store.doc.title} — ${t('Speaker view')}`,
      speakerIdleBody(this.store.doc.title, t('Notes, controls and slide thumbnails appear here when you start presenting. Drag this window to your second display.')),
    )
    if (!w) this.toast(t('Couldn’t open the speaker view — allow pop-ups for this site.'))
  }

  present(fromStart = false, fullscreen = true) {
    if (this.presenting) return
    // They've started a slideshow — retire the first-run nudge for good.
    lsSet('bento-slideshow-started', '1')
    document.querySelector('.ed-hint-pulse')?.classList.remove('ed-hint-pulse')
    this.canvas.commitTextEdit()
    this.presenting = true
    startPresentation(this.store.doc, fromStart ? 0 : this.store.currentIndex, (last) => {
      this.presenting = false
      this.store.goTo(last)
      this.canvas.render()
    }, { fullscreen })
  }

  // --- paste: external objects + cross-deck elements/slides ---------------------

  private wirePaste() {
    // A dropped .bento.html OPENS as a deck (and adopts a writable handle);
    // anything else falls through to the existing image/media drop behaviour.
    document.addEventListener('dragover', (ev: DragEvent) => {
      if ([...(ev.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) ev.preventDefault()
    })
    document.addEventListener('drop', (ev: DragEvent) => { void this.openDroppedDeck(ev) })

    document.addEventListener('paste', (ev: ClipboardEvent) => {
      if (this.presenting) return
      const a = document.activeElement as HTMLElement | null
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return // text edit owns it
      const dt = ev.clipboardData
      if (!dt) return
      // 1) an image from the OS clipboard (screenshot, copied picture…)
      const imgItem = [...dt.items].find((it) => it.kind === 'file' && it.type.startsWith('image/'))
      if (imgItem) {
        const file = imgItem.getAsFile()
        if (file) { ev.preventDefault(); this.pasteImageFile(file); return }
      }
      const text = dt.getData('text/plain')
      // 2) Bento elements / slides copied from this or another deck
      const clip = parseClip(text)
      if (clip?.kind === 'elements') {
        ev.preventDefault()
        let added: SlideElement[] = []
        this.store.commit(() => { added = insertElements(clip, this.store.doc, this.store.slide) })
        if (clip.fonts?.length) injectFonts(this.store.doc)
        this.store.select(added.map((e) => e.id))
        this.toast(added.length === 1 ? t('Pasted 1 item') : t('Pasted {n} items', { n: added.length }))
        return
      }
      if (clip?.kind === 'slides') {
        ev.preventDefault()
        const at = this.store.currentIndex + 1
        let made: Slide[] = []
        this.store.commit(() => { made = insertSlides(clip, this.store.doc, at) }, 'slides')
        if (clip.fonts?.length) injectFonts(this.store.doc)
        this.rebuildSidebar()
        this.store.goTo(at)
        this.toast(made.length === 1 ? t('Pasted 1 slide') : t('Pasted {n} slides', { n: made.length }))
        return
      }
      // 3) plain text → a text element
      if (text && text.trim()) {
        ev.preventDefault()
        const esc = text.trim().slice(0, 4000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
        const { width } = this.store.doc.size
        const el = defaultText({ html: esc, color: readableInk(this.store.slide.background), x: Math.round(width / 2 - 300), y: 260, w: 600 })
        this.store.commit(() => this.store.slide.elements.push(el))
        this.store.select([el.id])
        this.toast(t('Text pasted'))
      }
    })
  }

  private pasteImageFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      const src = String(reader.result)
      const place = (w: number, h: number) => {
        const { width, height } = this.store.doc.size
        const el = defaultImage(src, { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h, fit: 'contain' })
        // via canvas.insert, so a pasted photo is interned into doc.assets on
        // the same path as every other embed — otherwise it stays inline and
        // live collab can never send it.
        this.canvas.insert(el)
        this.toast(t('Image pasted'))
      }
      const img = new Image()
      img.onload = () => {
        let w = img.naturalWidth || 400, h = img.naturalHeight || 300
        const sc = Math.min(1, 640 / w, 480 / h); place(Math.round(w * sc), Math.round(h * sc))
      }
      img.onerror = () => place(400, 300)
      img.src = src
    }
    reader.readAsDataURL(file)
  }

  // --- live table→chart binding -------------------------------------------------

  private tableSig = ''
  /** Re-derive any chart linked to a table on the current slide when that
   *  table's content changes. Guarded by a content signature so it can't loop,
   *  and skipped when nothing is linked. */
  private syncLinkedCharts() {
    const slide = this.store.slide
    const linked = slide.elements.filter((e): e is ChartElement => e.type === 'chart' && !!(e as ChartElement).source)
    if (!linked.length) { this.tableSig = ''; return }
    const tables = slide.elements.filter((e): e is TableElement => e.type === 'table')
    const sig = slide.id + '|' + tables.map((tb) => `${tb.id}:${tb.columns.length}:${JSON.stringify(tb.rows)}`).join('|')
    if (sig === this.tableSig) return
    this.tableSig = sig
    let changed = false
    for (const chart of linked) {
      const table = tables.find((tb) => tb.id === chart.source!.tableId)
      if (table && syncLinkedChart(chart, table)) changed = true
    }
    // the triggering table edit already dirtied the doc + drives collab/autosave;
    // each replica derives identically from the synced table, so just re-render.
    if (changed) this.canvas.render()
  }

  /** Re-route connectors (line shapes anchored to elements via from/to) when
   *  anything on the slide moves. Derived, not committed — every replica computes
   *  the same endpoints from the element boxes (mirrors syncLinkedCharts). */
  private syncConnectors() {
    const slide = this.store.slide
    const byId = new Map(slide.elements.map((e) => [e.id, e]))
    let changed = false
    for (const el of slide.elements) {
      if (el.type !== 'shape' || el.shape !== 'line') continue
      const c = el as import('../model').ShapeElement
      if (!c.from && !c.to) continue
      if (c.from && !byId.has(c.from.el)) { delete c.from; changed = true }
      if (c.to && !byId.has(c.to.el)) { delete c.to; changed = true }
      if (!c.from && !c.to) continue
      const [a, b] = lineEndpoints(c)
      const fromBox = c.from ? byId.get(c.from.el) : null
      const toBox = c.to ? byId.get(c.to.el) : null
      // explicit side → pin to that side's midpoint; 'auto' → nearest border
      const end = (box: SlideElement, side: 'auto' | 'top' | 'right' | 'bottom' | 'left' | undefined, toward: { x: number; y: number }) =>
        side && side !== 'auto' ? sideMidpoint(box, side) : borderPoint(box, toward)
      const na = fromBox ? end(fromBox, c.from?.side, toBox ? boxCenter(toBox) : b) : a
      const nb = toBox ? end(toBox, c.to?.side, fromBox ? boxCenter(fromBox) : a) : b
      if (Math.hypot(na.x - a.x, na.y - a.y) > 0.5 || Math.hypot(nb.x - b.x, nb.y - b.y) > 0.5) {
        setLineEndpoints(c, na, nb)
        changed = true
      }
    }
    if (changed) this.canvas.render()
  }

  // --- auto-save + crash recovery -----------------------------------------------

  private autosaveTimer = 0
  private lastVersionAt = 0
  private lastBackupAt = 0

  private wireAutosave() {
    if (this.store.doc.readonly) return // player file — nothing to autosave
    void pruneOld()
    void this.checkRecovery()
    this.noticeIfCannotWriteInPlace()
    this.noticeIfJustUpdated()
    this.store.on('doc', () => this.scheduleAutosave())
  }

  private scheduleAutosave() {
    if (this.store.doc.readonly) return
    clearTimeout(this.autosaveTimer)
    this.autosaveTimer = window.setTimeout(() => { void this.runAutosave() }, 2500)
  }

  private async runAutosave() {
    const doc = this.store.doc
    if (doc.readonly) return
    // Never write an encrypted deck's plaintext to IndexedDB; its file
    // write-back below stays encrypted via serializeAuto.
    let snapshotted = false
    if (!isEncryptionActive()) {
      // only true if it REALLY stored — see putRecovery; no IndexedDB (Safari
      // private browsing, some file:// contexts) must not read as "backed up"
      snapshotted = await putRecovery(doc)
      if (Date.now() - this.lastVersionAt > 120_000) { this.lastVersionAt = Date.now(); await addVersion(doc) }
    }
    // Silent file write-back once we hold a writable handle (Chrome/Edge).
    if (hasFileHandle()) {
      try {
        this.session?.stampInto(doc)
        await writeUpdatedFile(await serializeAuto(doc))
        this.store.setDirty(false)
        markFileSaved() // the packs went out with those bytes too
        this.flashSaved()
        return
      } catch { /* keep dirty; the IndexedDB snapshot is the backstop */ }
    }
    // No handle (Safari/Firefox/iOS) or the write failed: the file on disk is
    // STALE and the deck stays dirty — saying "Saved" here would be a lie. But
    // the snapshot means the work is not lost, and that was previously
    // invisible: nothing was shown at all, so the only signal was an amber dot
    // that never cleared. Say what is actually true.
    //
    // Deliberately silent for an ENCRYPTED deck: those are never snapshotted to
    // IndexedDB (plaintext-to-disk), so on a browser that cannot write back
    // there is no backstop, and claiming one would be the worst kind of wrong.
    if (snapshotted) {
      this.lastBackupAt = Date.now()
      this.flashSaved(t('Backed up in this browser'))
      this.refreshDirtyHint()
    }
  }

  /** Keep the dirty dot's tooltip honest about the backstop — the file is still
   *  stale, but the work is recoverable, and the user should be able to find
   *  that out by hovering the thing that is worrying them. */
  private refreshDirtyHint() {
    if (canWriteInPlace() || !this.lastBackupAt) return
    const when = new Date(this.lastBackupAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    this.dirtyDot.title = t('Unsaved changes — kept in this browser at {when} and offered back if you reopen. ⌘S downloads an updated copy.', { when })
  }

  private async checkRecovery() {
    const doc = this.store.doc
    const snap = await getRecovery(doc.docId)
    if (!snap) return
    let recovered: import('../model').BentoDoc
    try { recovered = JSON.parse(snap.json) } catch { return }
    if (docContentKey(recovered) === docContentKey(doc)) return // the file already has these edits
    this.showRecoveryBanner(snap, recovered)
  }

  /**
   * Say ONCE, before any work is at risk, that this browser cannot rewrite the
   * open file. Shown on Safari/Firefox and every iOS browser (all WebKit, none
   * of which ship the File System Access API).
   *
   * Timing is the point. The editor used to state the opposite in its tooltips
   * and only correct itself in a toast AFTER the first save — by which time the
   * author had already trusted "⌘S rewrites this file" and, on a deck opened
   * from disk, had no idea their edits were going to Downloads instead.
   *
   * Once per browser, not per deck: it is a property of the browser, and
   * repeating it every time a file opens would be nagging.
   */
  /**
   * Say what changed, once, right after an upgrade lands.
   *
   * The moment matters: before the upgrade the notes are decision support (and
   * now ride inline in the signed manifest); AFTER it the user is inside the
   * editor, where the features actually are. "You can write $x^2$ in any text
   * box" means something different with a text box in front of you.
   *
   * Keyed on sessionStorage, NOT a stored last-seen version, because those
   * answer different questions. We want "did this reload just follow an
   * upgrade?", not "has this browser seen 1.0.11?". The difference is
   * recipients: most people who open a .bento.html never upgraded anything, and
   * a version comparison would greet them with release notes for a version they
   * never had. They cannot reach this path — they never clicked Reload.
   *
   * localStorage would also be wrong mechanically: it is per ORIGIN, and in
   * bento/tray every document gets its own origin, so a "seen" flag would be
   * per document — five decks, five notices.
   *
   * Only fires when the reload actually landed on the version it promised, so a
   * failed update never claims success. One shot: read and clear.
   */
  private noticeIfJustUpdated() {
    let just: string | null = null
    try {
      just = sessionStorage.getItem(JUST_UPDATED_KEY)
      sessionStorage.removeItem(JUST_UPDATED_KEY)
    } catch { return /* private mode — no note, no harm */ }
    if (!just || just !== APP_VERSION) return
    if (this.store.doc.readonly) return // player file: not this person's upgrade

    const bar = div('ed-recover')
    const msg = document.createElement('span')
    msg.textContent = t('Updated to v{v}.', { v: APP_VERSION })
    const what = document.createElement('a')
    what.className = 'ed-btn'
    what.href = `https://github.com/nyblnet/bento/releases/tag/v${APP_VERSION}`
    what.target = '_blank'
    what.rel = 'noopener'
    what.textContent = t('What’s new →')
    const ok = document.createElement('button')
    ok.className = 'ed-btn ed-btn-primary'
    ok.textContent = t('Got it')
    ok.addEventListener('click', () => bar.remove())
    bar.append(msg, what, ok)
    document.body.appendChild(bar)
  }

  /**
   * Tab title = deck title, plus the FILE name once one is known.
   *
   * `openedFileName()` answers this from the handle, or from the URL when a
   * `.bento.html` was opened directly — so it is right for a dropped file, a
   * saved file, and a double-clicked one alike, and null for the hosted demo.
   */
  private syncWindowTitle() {
    // Order matters. A handle is the truth. Failing that, a deck opened by drop
    // is named by the file it came from — the URL is stale the moment a drop
    // replaces the document, and would otherwise label this deck with the name
    // of the file still sitting in the address bar.
    const file = currentFileName() ?? this.openedAs ?? openedFileName()
    const named = file && fileBase(file) !== this.store.doc.title
    // Two segments, never three: a tab is narrow, and once a file name is
    // shown the app name is the least informative thing competing for it.
    document.title = named
      ? `${this.store.doc.title} — ${file}`
      : `${this.store.doc.title} — ${appConfig().appName}`
    if (!this.fileChip) return
    this.fileChip.hidden = !named
    if (!file) return
    this.fileChip.textContent = fileBase(file)
    // Three states, because two would lie: with the API but no handle yet, ⌘S
    // asks first and only then owns a file.
    this.fileChip.title = !canWriteInPlace()
      ? t('⌘S saves a copy — this browser can’t rewrite the file in place')
      : hasFileHandle()
        ? t('⌘S rewrites this file in place')
        : t('⌘S asks where to save, then rewrites that file in place')
  }

  /**
   * Open a `.bento.html` dropped onto the editor, adopting a WRITABLE handle
   * where the browser offers one.
   *
   * This is the only route to in-place saving for a deck that arrived from
   * disk. A file double-clicked in Finder opens on `file://` with no handle, so
   * every ⌘S re-runs the save picker and asks the user to navigate to the file
   * they already have open. `getAsFileSystemHandle()` returns a real handle for
   * a dropped file (Chromium only), so one permission prompt converts that deck
   * into one Bento can rewrite.
   *
   * Guards, in order: images and everything else keep their existing paste/drop
   * behaviour; an encrypted deck is refused rather than half-opened, because the
   * password gate lives in boot and there is nothing here to prompt with; and
   * unsaved work is confirmed before being replaced, since this is destructive
   * in a way dropping a picture is not.
   */
  private async openDroppedDeck(ev: DragEvent): Promise<boolean> {
    const item = [...(ev.dataTransfer?.items ?? [])].find((i) => i.kind === 'file')
    const named = ev.dataTransfer?.files?.[0]?.name ?? ''
    if (!item || !/\.bento\.html$/i.test(named)) return false
    ev.preventDefault()

    if (this.store.dirty && !confirm(t('Open {name}? Unsaved changes in this deck will be lost.', { name: named }))) return true

    // The handle is the prize; a plain File still opens, just without write-back.
    //
    // ORDER MATTERS: requestPermission() needs a live user gesture, and the drop
    // is it. Reading the file first (600KB+ of text(), then DOMParser and
    // JSON.parse) spends the activation, so the request throws SecurityError and
    // the deck opens read-only — ⌘S then re-runs the save picker, which is the
    // whole thing this feature exists to avoid. So: handle, permission, THEN read.
    const anyItem = item as unknown as { getAsFileSystemHandle?: () => Promise<any> }
    let handle: any = null
    try { handle = await anyItem.getAsFileSystemHandle?.() } catch { /* not supported — read-only open */ }

    let writable = false
    if (handle?.requestPermission) {
      try { writable = await handle.requestPermission({ mode: 'readwrite' }) === 'granted' }
      catch { /* denied, or activation already spent — opens read-only */ }
    }

    const file: File | null = handle ? await handle.getFile() : (ev.dataTransfer?.files?.[0] ?? null)
    if (!file) return true

    const html = await file.text()
    const el = new DOMParser().parseFromString(html, 'text/html').querySelector('#bento-doc')
    const block = el?.textContent?.trim() ?? ''
    // A pristine, never-saved shell ships an EMPTY block — the starter deck is
    // generated at runtime, not stored. That file is a perfectly good Bento
    // document; it just has nothing in it yet, so say that rather than call it
    // a foreign file.
    if (el && !block) { alert(t('{name} is an empty copy of Bento, not a saved deck. Open it on its own to start one.', { name: named })); return true }
    let parsed: unknown
    try { parsed = JSON.parse(block) } catch { alert(t('{name} isn’t a Bento document.', { name: named })); return true }
    if ((parsed as { format?: string })?.format === 'bento/enc') {
      alert(t('{name} is password-protected. Open it directly to unlock it.', { name: named }))
      return true
    }
    const next = parseDoc(JSON.stringify(parsed))
    if (!next) { alert(t('{name} isn’t a Bento document.', { name: named })); return true }

    if (writable) adoptFileHandle(handle)
    this.openedAs = named
    this.store.replaceDoc(next)
    this.canvas.render()
    this.syncWindowTitle()
    this.flashSaved(hasFileHandle() ? t('Opened {name}', { name: named }) : t('Opened {name} — ⌘S will save a copy', { name: named }))
    return true
  }

  private noticeIfCannotWriteInPlace() {
    if (canWriteInPlace()) return
    if (lsGet(SAVE_NOTICE_KEY) === 'seen') return
    const bar = div('ed-recover')
    const msg = document.createElement('span')
    msg.textContent = t('This browser can’t rewrite files in place. ⌘S will download an updated copy instead — your work is also kept in this browser and offered back if you reopen.')
    const ok = document.createElement('button')
    ok.className = 'ed-btn ed-btn-primary'
    ok.textContent = t('Got it')
    ok.addEventListener('click', () => { lsSet(SAVE_NOTICE_KEY, 'seen'); bar.remove() })
    bar.append(msg, ok)
    document.body.appendChild(bar)
  }

  private showRecoveryBanner(snap: Snapshot, recovered: import('../model').BentoDoc) {
    document.querySelector('.ed-recover')?.remove()
    const bar = div('ed-recover')
    const when = new Date(snap.at).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
    const msg = document.createElement('span')
    msg.textContent = t('Unsaved changes from {when} were found.', { when })
    const restore = document.createElement('button')
    restore.className = 'ed-btn ed-btn-primary'
    restore.textContent = t('Restore')
    restore.addEventListener('click', () => {
      this.store.replaceDoc(recovered)
      this.canvas.render()
      bar.remove()
      this.toast(t('Restored your unsaved changes'))
    })
    const dismiss = document.createElement('button')
    dismiss.className = 'ed-btn'
    dismiss.textContent = t('Discard')
    dismiss.addEventListener('click', () => { void clearRecovery(this.store.doc.docId); bar.remove() })
    bar.append(msg, restore, dismiss)
    document.body.appendChild(bar)
  }

  /** Browse and restore the locally-kept auto-save timeline for this deck. */
  private async openVersionHistory() {
    const versions = await listVersions(this.store.doc.docId)
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about ed-version-box')
    const h = document.createElement('h2')
    h.textContent = t('Version history')
    box.appendChild(h)
    if (!versions.length) {
      const empty = document.createElement('p')
      empty.className = 'ed-about-fine'
      empty.textContent = t('No saved versions yet — they accumulate as you edit and save.')
      box.appendChild(empty)
    } else {
      const list = div('ed-version-list')
      versions.forEach((v, i) => {
        const rowEl = document.createElement('button')
        rowEl.className = 'ed-version-row'
        const when = new Date(v.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        rowEl.innerHTML = `<span class="vh-when">${when}</span>` +
          `<span class="vh-tag">${i === 0 ? t('most recent') : ''}</span>` +
          `<span class="vh-do">${t('Restore')}</span>`
        rowEl.addEventListener('click', () => {
          try {
            this.store.replaceDoc(JSON.parse(v.json))
            this.canvas.render()
            overlay.remove()
            this.toast(t('Restored the version from {when} — ⌘Z undoes', { when }))
          } catch { this.toast(t('That version could not be read')) }
        })
        list.appendChild(rowEl)
      })
      box.appendChild(list)
    }
    const fine = div('ed-about-fine')
    fine.textContent = t('Versions are stored only in this browser, never in the file or online. Restoring is undoable.')
    box.appendChild(fine)
    overlay.appendChild(box)
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
  }

  /** Shortcuts + tips overlay (press ? or the topbar help button). */
  private openHelp() {
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about ed-help-box')
    const h = document.createElement('h2')
    h.textContent = t('Shortcuts & tips')
    box.appendChild(h)
    // Two explicit columns, placed by hand for balance + theme: LEFT = general
    // shortcuts & tips, RIGHT = the line/curve/path pointer-editing features.
    // (Auto column-count balanced poorly with these chunky, unsplittable sections.)
    const cols = div('ed-help-cols')
    box.appendChild(cols)
    const colL = div('ed-help-col')
    const colR = div('ed-help-col')
    cols.append(colL, colR)
    const mod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'
    const section = (col: HTMLElement, title: string, rows: Array<[string, string]>) => {
      const sec = div('ed-help-sec')
      const st = document.createElement('h3'); st.textContent = title; sec.appendChild(st)
      for (const [k, d] of rows) {
        const r = div('ed-help-row')
        r.innerHTML = `<kbd></kbd><span></span>`
        r.querySelector('kbd')!.textContent = k
        r.querySelector('span')!.textContent = d
        sec.appendChild(r)
      }
      col.appendChild(sec)
    }
    section(colL, t('Editing'), [
      [`${mod}S`, t('Save')],
      [`${mod}Z · ${mod}⇧Z`, t('Undo · redo')],
      [`${mod}C · ${mod}V`, t('Copy · paste — elements, or the whole slide when nothing is selected')],
      [`${mod}D`, t('Duplicate selection')],
      [`${mod}G · ${mod}⇧G`, t('Group · ungroup')],
      ['C', t('Comment mode')],
      ['?', t('This help')],
    ])
    section(colL, t('Canvas'), [
      [t('Space-drag'), t('Pan the canvas, including past the edges of the slide')],
      [t('Middle-drag'), t('Pan as well, if your mouse has a middle button')],
      [`${mod}-${t('scroll')}`, t('Zoom in and out')],
    ])
    section(colR, t('Lines & curves'), [
      [t('Shape ▾'), t('Draw a line, curved line or connector — then drag on the canvas')],
      [t('Drag a point'), t('Move an endpoint or anchor; drag the body to move the whole line')],
      [t('Click a point'), t('Reveal its bézier handles for a precise curve')],
      [`${t('Alt')}-${t('drag')}`, t('Break a smooth point into a sharp corner')],
      [t('Double-click'), t('Add a point on the line; double-click a point to remove it')],
    ])
    section(colR, t('Motion paths'), [
      [t('Presenting ▸ Loop'), t('Give an element a motion-path loop, then Edit path on canvas')],
      [t('Drag points'), t('Shape the trajectory — the first point is the element’s rest spot')],
      [t('Click a point'), t('Reveal bézier handles; Alt-drag one for a sharp corner')],
      [t('Double-click'), t('Add a point on the path; double-click a point to remove it')],
      [t('Scroll a point'), t('Set how fast the element moves through that point')],
    ])
    section(colL, t('Presenting'), [
      ['F5', t('Present')],
      ['F', t('Toggle fullscreen while presenting')],
      ['S', t('Speaker view — notes on a second screen if you have one')],
      ['L', t('Toggle laser pointer while presenting')],
      ['M', t('Reduce motion — pause animations (also honours your OS setting)')],
      ['← · →', t('Previous · next slide')],
      ['Esc', t('End the show')],
    ])
    const tips = div('ed-help-sec')
    const tt = document.createElement('h3'); tt.textContent = t('Good to know'); tips.appendChild(tt)
    const ul = document.createElement('ul'); ul.className = 'ed-help-tips'
    for (const tip of [
      t('Paste an image or text straight onto the canvas with ⌘V.'),
      t('Copy a slide (⌘C with nothing selected) and paste it into another Bento deck.'),
      t('Make a chart from a table and it stays linked — edit the table, the chart updates.'),
      t('Your work auto-saves; restore earlier versions from Save → Version history.'),
    ]) { const li = document.createElement('li'); li.textContent = tip; ul.appendChild(li) }
    tips.appendChild(ul); colL.appendChild(tips)
    const more = div('ed-help-more')
    const link = document.createElement('a')
    link.href = 'https://bento.page/help'
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = t('Full guide at bento.page/help →')
    more.appendChild(link)
    box.appendChild(more)
    overlay.appendChild(box)
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
  }

  private savedTimer = 0
  private flashSaved(message = t('Saved')) {
    let tag = document.querySelector<HTMLElement>('.ed-autosaved')
    if (!tag) { tag = div('ed-autosaved'); document.querySelector('.ed-topbar .ed-title')?.after(tag) }
    tag.textContent = message
    tag.classList.add('show')
    clearTimeout(this.savedTimer)
    this.savedTimer = window.setTimeout(() => tag!.classList.remove('show'), 1400)
  }

  async save(forcePicker: boolean) {
    this.canvas.commitTextEdit()
    // shared docs persist their CRDT state so the saved copy can rejoin
    // as a true fork later (offline edits merge both ways)
    this.session?.stampInto(this.store.doc)
    try {
      const result = await saveFile(this.store.doc, forcePicker)
      if (result === 'cancelled') return
      this.store.setDirty(false)
      // the file name is knowable from here on — put it in the tab and the chip
      this.syncWindowTitle()
      // staged language packs are in the bytes now — stop calling them pending
      markFileSaved()
      // record a recovery baseline + a version checkpoint at each manual save
      if (!isEncryptionActive()) { void putRecovery(this.store.doc); void addVersion(this.store.doc); this.lastVersionAt = Date.now() }
      // Saving is the opt-in: a named, saved deck is "live by default" from
      // now on (the recipient of a copy already joins on open). Connect this
      // session too so author and recipient meet without another click.
      this.session?.enableSharing()
      this.tryJoin()
      this.toast(result === 'downloaded'
        ? t('This browser can’t rewrite files in place — a fresh copy went to Downloads')
        : t('Saved'))
    } catch (err) {
      console.error(err)
      this.toast(t('Save failed — see console'))
    }
  }

  // --- keyboard ------------------------------------------------------------------

  private wireKeyboard() {
    document.addEventListener('keydown', (ev) => {
      if (this.presenting) return
      const mod = ev.metaKey || ev.ctrlKey
      const inField =
        ev.target instanceof Element &&
        ev.target.closest('input, textarea, select, [contenteditable="true"]') != null

      if (mod && ev.key.toLowerCase() === 's') {
        ev.preventDefault()
        this.save(false)
        return
      }
      if (mod && (ev.key === '=' || ev.key === '+')) {
        ev.preventDefault()
        this.canvas.zoomIn()
        return
      }
      if (mod && ev.key === '-') {
        ev.preventDefault()
        this.canvas.zoomOut()
        return
      }
      if (mod && ev.key === '0') {
        ev.preventDefault()
        this.canvas.zoomReset()
        return
      }
      if (ev.key === 'F5') {
        ev.preventDefault()
        this.present(!ev.shiftKey)
        return
      }
      if (inField) return

      if (!mod && (ev.key === '?' || (ev.key === '/' && ev.shiftKey))) {
        ev.preventDefault()
        this.openHelp()
        return
      }
      if (!mod && ev.key.toLowerCase() === 'c') {
        ev.preventDefault()
        this.canvas.toggleCommentMode()
        return
      }
      if (mod && ev.key.toLowerCase() === 'g') {
        ev.preventDefault()
        const els = this.store.selectedElements
        if (ev.shiftKey) this.panel.ungroup(els)
        else this.panel.group(els)
        return
      }
      if (mod && ev.key.toLowerCase() === 'z') {
        ev.preventDefault()
        ev.shiftKey ? this.store.redo() : this.store.undo()
        return
      }
      if (mod && ev.key.toLowerCase() === 'y') {
        ev.preventDefault()
        this.store.redo()
        return
      }
      if (mod && ev.key.toLowerCase() === 'd') {
        ev.preventDefault()
        this.duplicateSelection()
        return
      }
      if (mod && ev.key.toLowerCase() === 'c') {
        // Copy to BOTH the in-app clipboard (fast, same session) and the system
        // clipboard as a Bento payload (works across decks/tabs). Elements when
        // any are selected; otherwise the current slide.
        if (this.store.selection.length) {
          void navigator.clipboard?.writeText?.(serializeElements(this.store.selectedElements, this.store.doc)).catch(() => {})
        } else {
          void navigator.clipboard?.writeText?.(serializeSlides([this.store.slide], this.store.doc)).catch(() => {})
          this.toast(t('Slide copied — ⌘V in any deck to paste it'))
        }
        return
      }
      // ⌘V is handled by the document 'paste' listener (wirePaste) so it can
      // also receive images and cross-deck payloads.
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (this.store.selection.length) {
          ev.preventDefault()
          const ids = new Set(this.store.selection)
          this.store.commit(() => {
            this.store.slide.elements = this.store.slide.elements.filter((e) => !ids.has(e.id))
          })
          this.store.select([])
        }
        return
      }
      // nothing selected → arrows walk slides (Left/Up = prev, Right/Down = next);
      // when an element IS selected they nudge it (branch below). inField already
      // returned above, so this never fires mid text/cell edit.
      if (ev.key.startsWith('Arrow') && !this.store.selection.length && !this.canvas.isPathEditing) {
        ev.preventDefault()
        this.store.goToLinear(ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 1)
        return
      }
      if (ev.key.startsWith('Arrow') && this.store.selection.length) {
        ev.preventDefault()
        const step = ev.shiftKey ? 10 : 1
        const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0
        const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0
        this.store.commit(() => {
          for (const el of this.store.selectedElements) {
            el.x += dx
            el.y += dy
          }
        })
        return
      }
      if (ev.key === '[') {
        this.togglePanel('left')
        return
      }
      if (ev.key === ']') {
        this.togglePanel('right')
        return
      }
      if (ev.key === 'Escape') {
        if (this.canvas.isDrawing) this.canvas.cancelDraw()
        else if (this.canvas.isPathEditing) this.canvas.stopPathEdit(true)
        else this.store.select([])
        return
      }
      if (ev.key === 'PageDown') {
        ev.preventDefault()
        this.store.goToLinear(1)
        return
      }
      if (ev.key === 'PageUp') {
        ev.preventDefault()
        this.store.goToLinear(-1)
      }
    })
  }

  private duplicateSelection() {
    const els = this.store.selectedElements
    if (!els.length) return
    const clones = els.map((el) => cloneElement(el))
    this.store.commit(() => this.store.slide.elements.push(...clones))
    this.store.select(clones.map((c) => c.id))
  }

  // --- toast ------------------------------------------------------------------

  // --- about & updates ------------------------------------------------------

  /** About dialog: version, user-initiated update check, licenses. */
  private openAbout(runCheck = false) {
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about')

    const head = div('ed-about-head')
    // The logo/wordmark links home (new tab) — a gentle route back to the site.
    head.innerHTML =
      `<a class="ed-about-logo" href="https://bento.page" target="_blank" rel="noopener">` +
      `<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">` +
      `<rect width="32" height="32" rx="7" fill="#16273E"/>` +
      `<rect x="5" y="5" width="7" height="22" rx="2.5" fill="#5E7699"/>` +
      `<rect x="14" y="5" width="13" height="10" rx="2.5" fill="#FF9E8A"/>` +
      `<rect x="14" y="17" width="13" height="10" rx="2.5" fill="#F0EBE0"/>` +
      `</svg><div><b>bento<span style="color:#FF9E8A">/</span>slides</b><span>v${APP_VERSION} · format v${FORMAT_VERSION}</span></div>` +
      `</a>`
    head.querySelector('a')?.setAttribute('title', t('Visit bento.page (opens in a new tab)'))
    box.appendChild(head)

    // Engagement nudge back to the site (templates / gallery / agent guide).
    const promo = div('ed-about-promo')
    promo.innerHTML = t(
      'New to Bento? Find templates, the gallery and the AI editing guide at {home} — or ⭐ it on {gh}.',
      {
        home: '<a href="https://bento.page" target="_blank" rel="noopener">bento.page</a>',
        gh: '<a href="https://github.com/nyblnet/bento" target="_blank" rel="noopener">GitHub</a>',
      },
    )
    box.appendChild(promo)

    const status = div('ed-about-status')
    status.textContent =
      this.lastAutoCheck?.status === 'current'
        ? t("Checked automatically at launch — you're on the latest version (v{v}).", { v: APP_VERSION })
        : this.lastAutoCheck?.status === 'error'
          ? t("Launch check couldn't reach the release server ({m}). Check manually below.", { m: this.lastAutoCheck.message })
          : t('This file carries its own app — it works offline, forever, as is.')

    const row = div('ed-about-row')
    const checkB = document.createElement('button')
    checkB.className = 'ed-btn'
    checkB.textContent = t('Check for updates')
    checkB.addEventListener('click', async () => {
      checkB.disabled = true
      status.textContent = t('Checking…')
      const result = await checkForUpdates()
      checkB.disabled = false
      if (result.status === 'current') {
        status.textContent = t("You're on the latest version (v{v}).", { v: result.version })
      } else if (result.status === 'error') {
        status.textContent = t("Couldn't check: {m}", { m: result.message })
      } else {
        const { release } = result
        status.textContent = ''
        // One card: version, what changed, and the ways to take it. Grouping
        // them is the layout fix — as five loose children of the status block
        // the notes were squeezed between the heading and a vertical stack of
        // three buttons, in a dialog that also has to hold Document properties
        // and the toggles. The card stretches full width and owns its scroll.
        const card = div('ed-about-update')
        status.appendChild(card)
        const line = div('ed-about-new')
        line.textContent = t('Version {v} is available.', { v: release.version })
        card.appendChild(line)
        // Prefer per-version notes filtered to what THIS file actually skipped:
        // releases land days apart, so a reader two versions behind should see
        // both, and a reader one version behind should not see the older one
        // again. `notes` is the fallback for a manifest that predates the field.
        const skipped = release.notesFrom
          ? Object.keys(release.notesFrom)
              .filter((v) => compareVersions(v, APP_VERSION) > 0)
              .sort((a, b) => compareVersions(b, a))
          : []
        if (skipped.length) {
          const lines = skipped.flatMap((v) =>
            (release.notesFrom![v] ?? []).map((h) => (skipped.length > 1 ? `• ${h}  (${v})` : `• ${h}`)))
          card.appendChild(releaseNotes(lines.join('\n')))
        } else if (release.notes) {
          card.appendChild(releaseNotes(release.notes))
        }
        const actions = div('ed-about-actions')
        const fail = (err: any) => { status.textContent = t('Update failed: {m}', { m: String(err?.message ?? err) }) }
        const done = () => {
          status.textContent = ''
          const after = div('ed-about-update')
          status.appendChild(after)
          const ok = div('ed-about-new')
          ok.textContent = t('Updated to v{v} on disk.', { v: release.version })
          after.appendChild(ok)
          const note = div('ed-about-notes')
          note.textContent = canUpdateInPlace()
            ? t('This window is still running v{v} — reload to finish. A v{v} backup was downloaded.', { v: APP_VERSION })
            : t("This window is still running v{v}. If you overwrote the file that's open here, reload; otherwise open the file you saved.", { v: APP_VERSION })
          after.appendChild(note)
          const reloadB = document.createElement('button')
          reloadB.className = 'ed-btn ed-btn-primary'
          reloadB.textContent = t('Reload into new version')
          reloadB.addEventListener('click', () => {
            this.store.setDirty(false) // disk already holds this exact document
            // Hand a note to the version we are about to become. sessionStorage
            // because the lifetime is exactly right: it survives this reload and
            // dies with the tab. See noticeIfJustUpdated.
            try { sessionStorage.setItem(JUST_UPDATED_KEY, release.version) } catch { /* private mode */ }
            location.reload()
          })
          const row2 = div('ed-about-actions')
          row2.appendChild(reloadB)
          after.appendChild(row2)
        }

        // The inline notes above are the signed manifest's summary — the first
        // five CHANGELOG lead-ins (scripts/release.mjs). This is the rest of
        // them: the per-version release page, which publish-site.mjs creates
        // for every release, so the link cannot dangle. First in the action
        // row deliberately: reading before deciding is the point.
        const notesLink = document.createElement('a')
        notesLink.className = 'ed-btn'
        notesLink.href = `https://github.com/nyblnet/bento/releases/tag/v${release.version}`
        notesLink.target = '_blank'
        notesLink.rel = 'noopener'
        notesLink.textContent = t('What’s new →')
        notesLink.title = t('Read the release notes for v{v} (opens in a new tab)', { v: release.version })
        actions.appendChild(notesLink)

        const inPlaceB = document.createElement('button')
        inPlaceB.className = 'ed-btn ed-btn-primary'
        inPlaceB.textContent = canUpdateInPlace() ? t('Update this file') : t('Update this file…')
        inPlaceB.title = canUpdateInPlace()
          ? t('Downloads a backup of the current version, then rewrites this file on disk as the new version — document untouched.')
          : t('Verifies and builds the new version with this document inside, then asks where to save it — pick the file you have open to update it.')
        inPlaceB.addEventListener('click', async () => {
          inPlaceB.disabled = true
          inPlaceB.textContent = t('Verifying…')
          try {
            this.session?.stampInto(this.store.doc)
            const written = await applyUpdateInPlace(release, this.store.doc)
            if (written) done()
            else { inPlaceB.disabled = false; inPlaceB.textContent = t('Update this file…') }
          } catch (err: any) { fail(err) }
        })
        actions.appendChild(inPlaceB)

        const getB = document.createElement('button')
        getB.className = 'ed-btn'
        getB.textContent = t('Download updated copy')
        getB.title = t('Downloads the new version with this document inside. The file you have now is not touched.')
        getB.addEventListener('click', async () => {
          getB.disabled = true
          getB.textContent = t('Verifying…')
          try {
            this.session?.stampInto(this.store.doc)
            await applyUpdate(release, this.store.doc)
            getB.textContent = t('Downloaded ✓')
            const note = div('ed-about-notes')
            note.textContent = t('This window keeps running v{v} until you open the downloaded file.', { v: APP_VERSION })
            card.appendChild(note)
          } catch (err: any) { fail(err) }
        })
        actions.appendChild(getB)
        card.appendChild(actions)
      }
    })
    row.appendChild(checkB)
    box.append(row, status)

    const autoRow = document.createElement('label')
    autoRow.className = 'ed-about-auto'
    const autoCb = document.createElement('input')
    autoCb.type = 'checkbox'
    autoCb.checked = autoCheckEnabled()
    autoCb.addEventListener('change', () => setAutoCheck(autoCb.checked))
    autoRow.append(autoCb, document.createTextNode(' ' + t('Check for updates automatically at launch')))
    box.appendChild(autoRow)

    // the hard no-network switch: blocks update checks AND online
    // collaboration for this browser. Same-machine tab sync is not
    // networking and stays on.
    const offRow = document.createElement('label')
    offRow.className = 'ed-about-auto'
    const offCb = document.createElement('input')
    offCb.type = 'checkbox'
    offCb.checked = offlineEnabled()
    offCb.addEventListener('change', () => {
      setOffline(offCb.checked)
      if (offCb.checked) {
        if (this.session) disconnectOnline(this.session)
      } else {
        this.tryJoin() // re-enabling network re-connects only if share-eligible
      }
      this.wireOnlineStatus()
      this.toast(
        offCb.checked
          ? t('Offline mode on — nothing leaves this computer')
          : t('Offline mode off — online features re-enabled'),
      )
    })
    offRow.append(offCb, document.createTextNode(' ' + t('Offline mode — block all network features (updates, online collaboration)')))
    box.appendChild(offRow)

    // Document properties → fillable {{author}} {{company}} {{subject}} {{event}} fields
    const metaWrap = div('ed-about-row ed-about-meta-wrap')
    const metaTitle = document.createElement('div')
    metaTitle.className = 'ed-about-h'
    metaTitle.textContent = t('Document properties')
    metaWrap.appendChild(metaTitle)
    const metaHint = document.createElement('p')
    metaHint.className = 'ed-hint'
    metaHint.innerHTML = t('Type <b>{{author}}</b>, <b>{{company}}</b>, <b>{{subject}}</b> or <b>{{event}}</b> in any text box and it fills in from here — everywhere at once. Handy for title slides and footers.')
    metaWrap.appendChild(metaHint)
    const ensureMeta = () => (this.store.doc.meta ??= {})
    const metaField = (label: string, get: () => string, set: (v: string) => void) => {
      const row = div('ed-about-meta')
      const l = document.createElement('label')
      l.textContent = label
      const inp = document.createElement('input')
      inp.type = 'text'
      inp.value = get()
      inp.addEventListener('change', () => this.store.commit(() => set(inp.value.trim())))
      row.append(l, inp)
      metaWrap.appendChild(row)
    }
    metaField(t('Title'), () => this.store.doc.title, (v) => { this.store.doc.title = v || 'Untitled' })
    metaField(t('Author'), () => this.store.doc.meta?.author ?? '', (v) => { ensureMeta().author = v })
    metaField(t('Company'), () => this.store.doc.meta?.company ?? '', (v) => { ensureMeta().company = v })
    metaField(t('Subject'), () => this.store.doc.meta?.subject ?? '', (v) => { ensureMeta().subject = v })
    metaField(t('Event'), () => this.store.doc.meta?.event ?? '', (v) => { ensureMeta().event = v })
    metaField(t('Keywords'), () => this.store.doc.meta?.keywords ?? '', (v) => { ensureMeta().keywords = v })
    box.appendChild(metaWrap)

    const fine = div('ed-about-fine')
    fine.innerHTML =
      `${t('Checks contact the release server and send nothing about you or this document — no ids, no telemetry.')}<br>` +
      t('Includes reveal.js, Moveable, Selecto (MIT) · Fraunces + Instrument Sans typefaces (OFL-1.1) — full notices travel in this file’s source.')
    box.appendChild(fine)

    overlay.appendChild(box)
    const close = () => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        close()
      }
    }
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close()
    })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
    if (runCheck || this.updateFound) checkB.click()
  }

  toast(message: string) {
    document.querySelector('.ed-toast')?.remove()
    const t = div('ed-toast')
    t.textContent = message
    document.body.appendChild(t)
    setTimeout(() => t.classList.add('show'))
    setTimeout(() => {
      t.classList.remove('show')
      setTimeout(() => t.remove(), 300)
    }, 2200)
  }
}

/**
 * Turn a relay refusal into a sentence. Honest about the consequence: for the
 * permanent codes the change lives on in THIS copy only — collaborators will
 * never receive it, and no later sync repairs that. Built at display time
 * because t() must never be frozen into a module-level const.
 */
/**
 * Turn a pack-install failure into a sentence. Built at display time because
 * t() must never be frozen into a module-level const.
 */
function languageInstallError(code: import('../packs').PackError): string {
  switch (code) {
    case 'offline':
      return t('Couldn’t download that language — check your connection and try again.')
    case 'bad-pack':
      return t('That language pack couldn’t be read.')
    case 'wrong-app':
      return t('That language pack was built for a different Bento app.')
    // Says what happened and what was done about it, without pretending to
    // know whether it was an attack or a bungled upload — we cannot tell, and
    // the answer is the same either way: it was not installed.
    case 'unverified':
      return t('That language pack failed its security check, so it wasn’t added.')
  }
}

function syncNoticeText(n: import('../sync/session').SyncNotice): string {
  switch (n.code) {
    case 'too-large':
      return n.media
        ? t('That image is too large to share live (about 1 MB max). It’s saved in your copy, but collaborators won’t see it.')
        : t('That change is too large to share live (about 1 MB max). It’s saved in your copy, but collaborators won’t see it.')
    case 'room-full':
      return t('This live session has run out of room. Your change is saved in your copy, but collaborators won’t see it.')
    case 'storage-failed':
      return t('The live session couldn’t store that change. It’s saved in your copy, but collaborators won’t see it.')
    case 'rate-limited':
      return t('Too many changes at once — live sync is catching up.')
  }
}

/**
 * Release notes → a real list.
 *
 * The manifest carries them as PLAIN TEXT, one "• " bullet per line, capped at
 * five plus an "…and N more" tail (scripts/release.mjs). A pre-wrap block gave
 * every wrapped bullet a flush-left second line, which at 320px was most of
 * them — so one item read as two and the box looked like a wall. Split per line
 * and hang the indent instead.
 *
 * Always textContent, never innerHTML: the manifest is signed, but a signature
 * says who wrote a string, not that it is safe to run.
 */
function releaseNotes(notes: string): HTMLElement {
  const box = div('ed-about-release')
  for (const raw of notes.split('\n')) {
    const text = raw.trim()
    if (!text) continue
    const bullet = /^[•*-]\s+/.test(text)
    const item = div(bullet ? 'ed-about-note' : 'ed-about-more')
    item.textContent = bullet ? text.replace(/^[•*-]\s+/, '') : text
    box.appendChild(item)
  }
  return box
}

/** Deep-clone an element with a fresh id (same-slide duplicates must not share ids). */
function cloneElement(el: SlideElement): SlideElement {
  return { ...JSON.parse(JSON.stringify(el)), id: uid(el.type[0]), x: el.x + 24, y: el.y + 24 }
}

// tiny DOM helpers
function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}

function btn(
  icon: string,
  label: string,
  onClick: (ev: MouseEvent) => void,
  title?: string,
): HTMLElement {
  const b = document.createElement('button')
  b.className = 'ed-btn'
  b.innerHTML = label ? `${icon}<span>${label}</span>` : icon
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}
