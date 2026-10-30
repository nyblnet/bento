// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Editor shell: topbar, slide sidebar, canvas, properties panel, keyboard
// shortcuts, save & present wiring.

import type { Store } from '../store'
import {
  FORMAT_VERSION,
  MEDIA_EMBED_BUDGET,
  applyChartPalette, applyLayout, builtinLayouts, defaultChart, defaultCode, defaultImage, defaultMedia, defaultShape, defaultTable, defaultText,
  instantiateLayout, isLightBg, layoutElementIds, newDocId, parseDoc, readableInk, syncLinkedChart, uid,
  paginates, inLinearFlow,
  type ChartElement, type ShapeKind, type ShapeElement, type Slide, type SlideElement, type TableElement } from '../model'
import { THEME_CHOICES, setTheme, themeChoice } from '../../../kernel/src/theme.ts'
import type { InPlaceOutcome } from '../update'
import { APP_VERSION, applyUpdate, applyUpdateInPlace, autoCheckEnabled, canUpdateInPlace, checkForUpdates, compareVersions, offlineEnabled, sandboxed, setAutoCheck, setOffline } from '../update'
import { CHART_PRESETS } from '../charts'
import { cssColor, renderSlide, renderThumbnail } from '../render'
import { openExportImagesDialog } from './exportimages'
import { adoptComponents, components, detach, mainsLost, makeComponent, promoteCopy, resetOverrides } from '../components'
import { goToMain, selectedComponent } from './inspector/component'
import { activeMode, bindToken, modesOf } from '../tokens'
import { derive, deriveMemory, type DeriveMemory } from '../derive'
import { TokensPane } from './tokenspane'
import { SlideCanvas } from './canvas'
import { PropsPanel } from './panels'
import { fitTabNames, iconTab, slidingPill, tabBarNeed } from './inspector/controls'
import { openCtxMenu, type CtxItem } from './ctxmenu'
import { mountNotesPane } from './notespane'
import { mountHints } from './hints'
import { labelIn } from './layerrows'
import { startPresentation } from '../present'
import { walkSource, wouldPair } from './morph'
// serializeFile (plain output) is deliberately NOT imported here: every path
// in this file writes a real file for a person, so all of them must inherit an
// active password. serializeAuto is the only encryption-aware serializer.
import { adoptFileHandle, canWriteInPlace, currentFileName, fileBase, hasFileHandle, hostCan, isBodySealed, isEncryptionActive, openedFileName, saveFile, serializeAuto, setEncryptionPassword, suggestedFileName, writeUpdatedFile, writeUpdatedFileAs } from '../save'
import { createSaveQueue, saveRevision } from '../saving'
import type { SaveQueue } from '../../../kernel/src/savequeue.ts'
import { noteSavedFromWeb } from './returngate'
import { addVersion, clearRecovery, clearVersions, docContentKey, getRecovery, listVersions, onRecoveryOff, pruneOld, putRecovery, recoveryLooksOlder, type Snapshot } from '../autosave'
import { freshGroups, insertElements, insertSlides, parseClip, serializeElements, serializeSlides } from './clipboard'
import { estimatedFrames, fencedElements, splitFences } from './codefence'
import { openSpeakerWindow, speakerIdleBody, speakerWindow } from '../screens'
import { neutralWindowTitle, speakerWindowTitle, titleSealed } from '../wintitle'
import { ICONS } from '../icons'
import { segmented } from './inspector/fields'
import { t, setLocale, locale, localeChoices, LOCALE_CHOICES, applyDirection, isRtl } from '../i18n'
import { MOD, dispatch, openPalette, titleFor, type Command } from './commands'
import { stepOf } from '../steps'
import { availablePacks, fetchPack, markFileSaved, packCoverage, packsInFile, stageForFile, unstageFromFile } from '../packs'
import { injectFonts } from '../fonts'
import { appConfig } from '../../../kernel/src/app.ts'
import { disconnectOnline, joinFromDoc, mintCollab, mintInvite, mintRoomKey, onlineTransport, rotateKeys, sharingOn, startSharing, stopSharing } from '../sync/online'
import { readerCopy, inviteCopy } from '../share'
import { projectDoc, projectOp, type AudienceTicket } from '../audience'
import { stripEmbeddedEnvelopes } from '../envelope'
import { compactJson } from '../compact'
import { parseDocInputReport } from '../compactload'
import { gateRestored, guardOpenedDoc } from '../restoregate'
import { lsGet, lsJson, lsSet } from '../../../kernel/src/storage.ts'
import { shrinkImageFile, shrinkEnabled, setShrinkEnabled, shrinkNote, fmtBytes, type ShrinkResult } from './shrink'
import { deletePlan, expand, moveBlock, parents as selParents, range as selRange, toggle as selToggle } from './slidesel'
import { dryRun, applyCompress, type DryRun } from './compressdeck'
import { createDialog } from '../../../kernel/src/ui/dialog.ts'
import '../../../kernel/src/ui/dialog.css'
import { PresenceToasts } from './presencetoasts'
import { BOOL_OPS, boolBlocked, boolOperands, boolUi, combine, flatten, release } from './booleans'
import { align, distribute, flip } from './inspector/arrange'
import type { NodeKind } from './beziereditor'
import { withDescendants, frameChildren, isFrame, moveInFrame } from '../layout'

const i18nT = t

/** Per-BROWSER, not per-deck: whether the "this browser can't rewrite files"
 *  notice has been acknowledged. It is a property of the browser. */
/** What owns the keyboard while it shows: the editor's sheets and dialogs,
 *  the return gate, a context menu or an open topbar menu. (The ⌘K palette
 *  keeps its keys to itself — its field stops them — and must still list
 *  the commands, so it is not one of these.) */
const MODAL = '.ed-about-overlay, .ed-gate-overlay, .ed-ctxmenu, .ed-dropdown.open, dialog[open]'

const SAVE_NOTICE_KEY = 'bento-save-notice'

/** sessionStorage: set just before the post-update reload, read once by the
 *  version that boots next. Deliberately NOT localStorage — see
 *  noticeIfJustUpdated. */
const JUST_UPDATED_KEY = 'bento-just-updated'

/** Show the language search once the available list outgrows a glance. */
const SEARCH_FROM = 8

/** How long a finger must rest before a press becomes a menu. 500ms is what
 *  iOS itself uses for the callout, so it matches the muscle memory already on
 *  the device. */
const LONG_PRESS_MS = 500
/** …and how far it may wander first. Past this it was a drag or a pan. */
const LONG_PRESS_SLOP = 10

/** Shape-menu rows that are also one-letter tools (commands.ts), by label. */
const SHAPE_TOOL: Record<string, string> = { Rectangle: 'tool-rect', Ellipse: 'tool-ellipse', Line: 'tool-line', Pen: 'tool-pen' }

const SHAPE_MENU: Array<{ kind: ShapeKind; label: string; icon: string; heads?: 2; draw?: 'line' | 'path' | 'connector' | 'curve-connector' | 'free' | 'poly' | 'pen'; tip: string }> = [
  { kind: 'rect', label: 'Rectangle', icon: ICONS.rect, tip: 'A rectangle — rounded corners, fills, gradients and shadows in the panel' },
  { kind: 'ellipse', label: 'Ellipse', icon: ICONS.ellipse, tip: 'An ellipse or circle' },
  { kind: 'triangle', label: 'Triangle', icon: ICONS.triangle, tip: 'A triangle' },
  { kind: 'arrow', label: 'Arrow', icon: ICONS.arrow, tip: 'A solid arrow shape' },
  { kind: 'arrow', label: 'Double arrow', icon: ICONS.arrow2, heads: 2, tip: 'A solid arrow with a head at both ends' },
  { kind: 'line', label: 'Line', icon: ICONS.line, draw: 'line', tip: 'Drag on the slide to draw a straight line — drag its endpoints to adjust' },
  { kind: 'path', label: 'Curved line', icon: ICONS.curve, draw: 'path', tip: 'Drag to draw a curve — then drag its points; double-click to add or remove one' },
  { kind: 'line', label: 'Connector', icon: ICONS.connector, draw: 'connector', tip: 'Drag between two elements — the ends snap on and re-route when they move' },
  { kind: 'path', label: 'Curved connector', icon: ICONS.curveConnector, draw: 'curve-connector', tip: 'A curved line between two elements — the ends snap on and re-route, the tip follows the curve' },
  { kind: 'path', label: 'Freeform', icon: ICONS.freeform, draw: 'free', tip: 'Draw by hand — the stroke smooths into an editable curve' },
  { kind: 'path', label: 'Pen', icon: ICONS.pen, draw: 'pen', tip: 'Click to place corners, drag to pull out curves (Alt breaks a handle); click the first point to close, Enter or Esc to finish' },
  { kind: 'path', label: 'Polygon', icon: ICONS.polygon, draw: 'poly', tip: 'Click to place corners; click the first point (or double-click) to close the shape' },
]

/**
 * The PowerPoint converter on the site (bento/convert's page, #589): one page,
 * in and out. LINKS, not features of this file: the conversion needs the
 * network, and a saved deck never loads anything on its own, so each entry
 * opens the page in a new tab and says so in its tooltip. Slides' release
 * carries the site, so the entries and the page ship together. Import opens
 * the page straight on its .pptx side; the old /import path still redirects
 * there for shells that predate this.
 */
export const IMPORT_PPTX_URL = 'https://bento.page/convert?from=pptx'
export const EXPORT_PPTX_URL = 'https://bento.page/convert'

/**
 * May this copy write? An ALLOWLIST that fails closed: a deck with no live
 * session, or one whose role is absent (owner and legacy writer copies) or
 * 'writer'. Every other role — 'reader', 'audience', and any role a later
 * version adds — is read-only here. It used to be `role !== 'reader'`, a
 * denylist that answered yes for the broadcast 'audience' role, so an audience
 * copy dropped onto a running editor got "Invite to edit…", "Reset access…"
 * and an Editor label. (The relay refused its writes all along; this was the
 * chrome, not the capability.)
 */
export function canWriteDeck(collab: { role?: string } | undefined): boolean {
  return !collab || collab.role === undefined || collab.role === 'writer'
}

/**
 * A menu row's label and its description (maintainer ruling D2, as revised
 * 2026-09-26: "all the extra text describing the entry can be mouseovers").
 * The row stays ONE 30px line; the description is its hover tooltip (the
 * native `title`) and, because a tooltip is not announced reliably and never
 * appears on a phone, also its accessible DESCRIPTION via aria-describedby on
 * a visually-hidden node. The name keeps an element of its own and is the
 * row's accessible NAME. The hidden node sits inside the label span so the
 * bar's compact tier, which hides and restores `.ed-btn > span`, carries it
 * along. An empty description adds nothing.
 */
let menuDescSeq = 0
function menuLabel(label: string, desc: string, row: HTMLElement): HTMLSpanElement {
  if (!desc) return Object.assign(document.createElement('span'), { textContent: label })
  const span = document.createElement('span')
  const name = Object.assign(document.createElement('span'), { className: 'ed-mi-name', textContent: label })
  const note = Object.assign(document.createElement('span'), { className: 'ed-sr-only', textContent: desc, id: `ed-mi-desc-${++menuDescSeq}` })
  span.append(name, note)
  row.title = desc
  row.setAttribute('aria-label', label)
  row.setAttribute('aria-describedby', note.id)
  return span
}

export class Editor {
  private canvas!: SlideCanvas
  private panel!: PropsPanel
  /** Sidebar multi-selection: PARENT indices (slidesel.ts). The current slide
   *  is the anchor and the canvas slide; this set is what a drag moves and
   *  Delete removes. Empty = just the current slide, as before. */
  private thumbSel: number[] = []
  private sidebar!: HTMLElement
  /** the side column's two views: slide thumbnails, and the current slide's layers */
  private thumbs!: HTMLElement
  private sideLayers!: HTMLElement
  private sideTokens!: HTMLElement
  private tokensPane!: TokensPane
  private props!: HTMLElement
  private dirtyDot!: HTMLElement
  private fileChip?: HTMLElement
  /** Name of a deck opened by DROP when no writable handle came with it. */
  private openedAs?: string
  private thumbTimer = 0
  /** The slide the list last scrolled into view (highlightSidebar). */
  private thumbRevealed = -1
  private presenting = false
  private updatesB!: HTMLElement
  private avatarsBox!: HTMLElement
  private shareB!: HTMLElement
  private shareWrap!: HTMLElement
  /** the popover's "pictures still uploading" poll — runs only while it is open */
  private uploadPoll: number | null = null
  private session: import('../sync/session').SyncSession | null = null
  private updateFound: string | null = null
  private lastAutoCheck: import('../update').UpdateCheck | null = null
  /** side panel widths (px) — user-resizable, persisted per browser */
  private panelW = { left: 188, right: 264 }

  constructor(
    private root: HTMLElement,
    private store: Store,
  ) {
    this.build()
    this.wireKeyboard()
    // a slide-list change makes the sidebar selection's indices stale: drop it
    // (a drag re-selects the moved block by id right after its commit)
    store.on('slides', () => { this.thumbSel = []; this.rebuildSidebar() })
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
    this.wireContextMenu()
    store.on('doc', () => this.syncLinkedCharts())
    // every derived value — palette, tokens, components, layout, connectors,
    // stack fallbacks — in one pass, in dependency order (derive.ts). Seeded
    // with the document as it opened, and re-seeded when another document
    // replaces it: nothing has "moved" yet, so a value edited in an older
    // shell reads as a hand edit and is kept. Undo/redo keep the memory.
    this.derived = deriveMemory(store.doc)
    derive(store.doc, this.derived)
    store.on('replace', () => { this.derived = deriveMemory(store.doc); derive(store.doc, this.derived) })
    store.on('doc', () => this.syncDerived())
    store.on('doc', () => this.offerMorph())
    this.tokensPane = new TokensPane(store, { toast: (m) => this.toast(m) })
    this.tokensPane.mount(this.sideTokens)
    store.on('doc', () => this.tokensPane.refresh())
    store.on('current', () => this.tokensPane.refresh())
    store.on('doc', () => this.syncFonts())
    this.syncFonts()
    // A document that cannot write can ARRIVE in a running editor, not only boot
    // in one — an audience or reader copy dropped onto it, or loaded by script.
    // The build-time check never sees those, so the lock follows the document.
    store.on('doc', () => { if (!store.readOnly && !canWriteDeck(store.doc.collab)) this.enterReaderMode() })
    document.addEventListener('bento:apply-layout', ((ev: CustomEvent) => {
      this.openLayoutPicker(ev.detail.anchor as HTMLElement, { kind: 'apply' })
    }) as EventListener)
    this.rebuildSidebar()
  }

  /** wire the live-collaboration session (avatars, remote selections, relay) */
  connectSync(session: import('../sync/session').SyncSession) {
    this.session = session
    // presence arrivals/departures get a quiet heads-up — said once per REAL
    // arrival and departure (presencetoasts.ts: a departure must last, a
    // return within minutes is a flap of a throttled tab, not a join), and
    // not at all in a crowded room, where the per-peer toasts would storm
    const toasts = new PresenceToasts({
      toast: (kind, name) => this.toast(kind === 'joined' ? t('{name} joined', { name }) : t('{name} left', { name })),
    }, session.peers())
    session.onPeers(() => {
      this.renderAvatars()
      this.canvas.setRemotePeers(session.peers())
      if (this.shareWrap.classList.contains('open')) this.renderSharePanel()
      toasts.update(session.peers())
    })
    // the relay refused something (too big, room full, throttled) — the user
    // needs to know, because for the permanent codes their change stays in
    // this copy and never reaches anyone else
    session.onNotice((n) => {
      let text = syncNoticeText(n)
      // pictures still uploading are informational here (see syncNoticeText)
      const pending = n.snapshot ? session.pendingBlobUploads() : 0
      if (pending > 0) text += ' ' + (pending === 1 ? t('1 picture is still uploading; it will follow.') : t('{n} pictures are still uploading; they will follow.', { n: pending }))
      this.toast(text)
    })
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
    // an embedded view blocks every connection: no relay socket, no retry loop
    if (sandboxed()) return
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
      chip.style.background = cssColor(peer.color, '#888') // a peer's colour: gated
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
    // Everything the previous build hung on window, document or the store dies
    // with its DOM. build() runs again on every language switch, and each run
    // used to add another resize listener, another ResizeObserver and eight
    // outside-press listeners that kept the old bar alive and re-fitted it.
    this.buildScope.abort()
    this.buildScope = new AbortController()
    for (const o of this.buildObservers) o.disconnect()
    this.buildObservers = []
    this.root.innerHTML = ''
    this.root.className = 'ed-root'

    // topbar
    const bar = div('ed-topbar')
    // A real button: it opens About, so it takes focus, answers Enter/Space and
    // has a name a screen reader can read (the visible word is hidden at the
    // tight tier and on phones, leaving only the mark).
    const logo = document.createElement('button')
    logo.type = 'button'
    logo.className = 'ed-logo'
    logo.setAttribute('aria-label', t('About bento/slides — version, updates, licenses'))
    logo.innerHTML =
      `<svg class="ed-logo-mark" viewBox="0 0 32 32" width="20" height="20" aria-hidden="true">` +
      `<rect width="32" height="32" rx="7" fill="#16273E"/>` +
      `<rect x="5" y="5" width="7" height="22" rx="2.5" fill="#5E7699"/>` +
      `<rect x="14" y="5" width="13" height="10" rx="2.5" fill="#FF9E8A"/>` +
      `<rect x="14" y="17" width="13" height="10" rx="2.5" fill="#F0EBE0"/>` +
      `</svg> <b>bento<span style="color:#FF9E8A">/</span>slides</b>`
    logo.title = t('About bento/slides — version, updates, licenses')
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
    const offTitle = this.store.on('doc', () => {
      if (document.activeElement !== title && title.value !== this.store.doc.title) {
        title.value = this.store.doc.title
        this.syncWindowTitle()
      }
    })
    this.buildScope.signal.addEventListener('abort', offTitle)

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
    // Each tool is a command (commands.ts): the button runs it, its tooltip
    // and letter badge come from it, and data-cmd names it.
    const tool = (id: string, icon: string, label: string, tip?: string) => this.cmdButton(id, icon, label, tip)
    insert.append(
      tool('tool-select', ICONS.cursor, '', t('Select — back to the pointer')),
      tool('tool-frame', ICONS.frameRow, t('Frame'), t('Add a frame — what you put in it lines up in a row, a column or a grid')),
      tool('insert-text', ICONS.text, t('Text'), t('Add a text box — double-click it to edit; **bold**, *italic*, `code` and “- ” bullets format as you type')),
      this.shapeDropdown(),
      tool('insert-image', ICONS.image, t('Image'), t('Add an image — or just paste one (⌘V) straight onto the slide')),
      this.mediaDropdown(),
      tool('insert-table', ICONS.table, t('Table'), t('Add a table — edit cells inline; turn it into a live chart from the panel')),
      tool('insert-chart', ICONS.chart, t('Chart'), t('Add a chart — edit it visually or link it to a table so it updates live')),
      tool('insert-code', ICONS.code, t('Code'), t('Add a code snippet')),
    )
    const commentB = tool('comment', ICONS.comment, t('Comment'), t('Comment — click an element or a spot on the slide'))
    insert.appendChild(commentB)
    // Vector booleans, Penpot's contextual bar: present only while two or more
    // closed shapes are selected — never greyed out, simply not there.
    const boolBar = div('ed-bool')
    boolBar.setAttribute('role', 'group')
    boolBar.setAttribute('aria-label', t('Combine shapes'))
    for (const op of BOOL_OPS) {
      const ui = boolUi(op)
      const b = btn(ui.icon, '', () => combine(this.store, this.store.selectedElements, op), `${ui.label} (${ui.key})`)
      b.dataset.bool = op
      b.setAttribute('aria-label', ui.label)
      boolBar.appendChild(b)
    }
    // a selection with a line or an open path in it shows the bar greyed, saying why
    const syncBool = () => {
      const els = this.store.selectedElements
      const blocked = boolBlocked(els)
      boolBar.hidden = this.store.readOnly || (!boolOperands(this.store, els) && !blocked)
      boolBar.title = blocked ?? ''
      for (const b of boolBar.querySelectorAll('button')) b.disabled = !!blocked
    }
    syncBool()
    for (const e of ['selection', 'doc', 'current'] as const) {
      const off = this.store.on(e, syncBool)
      this.buildScope.signal.addEventListener('abort', off)
    }
    insert.appendChild(boolBar)
    insert.appendChild(this.pathBar())

    const actions = div('ed-group ed-group-right')
    // the update chip sits beside the wordmark and exists ONLY when an
    // update is available (manual checks live in the About dialog)
    this.updatesB = btn(ICONS.sync, '', () => this.openAbout(true), t('Check for updates'))
    this.updatesB.style.display = 'none'
    setTimeout(async () => {
      // an embedded view (Teams, SharePoint) blocks every connection and its
      // preview pane treats a reported refusal as fatal: no request at all
      if (!autoCheckEnabled() || offlineEnabled() || sandboxed()) return
      const r = await checkForUpdates()
      this.lastAutoCheck = r
      if (r.status === 'update') {
        this.updateFound = r.release.version
        this.updatesB.style.display = ''
        this.updatesB.classList.add('ed-btn-update')
        this.updatesB.innerHTML = `${ICONS.sync}<span>v${r.release.version}</span>`
        this.updatesB.title = t('Version {v} is available — click to update', { v: r.release.version })
        this.toast(t('Update available: v{v} — click the peach button to update', { v: r.release.version }))
      } else if (r.status === 'current' && !document.querySelector(MODAL)) {
        // passive news: never over a dialog the author has opened meanwhile
        this.toast(t('Up to date — v{v}', { v: APP_VERSION }))
      }
    }, 1500)
    const undoB = this.cmdButton('undo', ICONS.undo, '')
    const redoB = this.cmdButton('redo', ICONS.redo, '')
    const saveB = btn(ICONS.save, t('Save'), () => this.save(false), canWriteInPlace()
      ? t('Save — rewrite this file in place (⌘S)')
      : t('Save — download an updated copy (⌘S). This browser can’t rewrite the open file.'))
    saveB.dataset.cmd = 'save'
    saveB.appendChild(this.dirtyDot) // the amber unsaved-changes dot lives ON Save
    const pdfB = this.cmdButton('export-pdf', ICONS.pdf, '')
    const helpB = this.cmdButton('help', '<b class="ed-help-q">?</b>', '')
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
    // These two were the only dropdowns in the bar without an outside-press
    // dismissal, and they are the two that exist ONLY on a phone — so the menus
    // hardest to escape were the ones a thumb could not escape at all. Picking
    // an item closes them; anything else left them standing over the canvas.
    this.closeOnOutsidePress(insertD)
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
    this.closeOnOutsidePress(moreD)
    const slidesB = btn(ICONS.panelLeft, t('Slides'), () => this.togglePanel('left'), t('Slides — show or hide the slide list'))
    slidesB.classList.add('ed-phone-only')
    const formatB = btn(ICONS.panelRight, t('Format'), () => this.togglePanel('right'), t('Show or hide the Format, Animate and Interact panel (])'))
    formatB.classList.add('ed-phone-only')
    const phoneTools = div('ed-phone-tools')
    phoneTools.append(slidesB, insertD, history)

    this.syncWindowTitle()

    this.phoneChrome = {
      insertD, insertMenu, moreD, moreMenu, slidesB, formatB, insert, actions, history,
      // order matters: this is the order they appear in the ⋯ menu
      demote: [redoB, commentB, pdfB, shareD, langD, helpB],
      // filled in once the bar is fully assembled (formatB lands last)
      authored: new Map(), homeOf: new Map(),
    }

    // Three zones: the document | insert | output. The document's zone and the
    // output group share the spare width equally (styles.css), which is what
    // keeps the insert tools centred whatever the deck is called.
    const docZone = div('ed-zone-doc')
    docZone.append(logo, this.updatesB, title, this.fileChip, phoneTools)
    bar.append(docZone, insert, actions, moreD)

    // main area
    const main = div('ed-main')
    this.sidebar = div('ed-sidebar')
    // Slides | Layers: navigation on the left, properties on the right, the
    // way Penpot (Pages / Layers) and Figma (Layers) lay it out. The layer
    // list used to sit at the top of the inspector, on every tab.
    this.thumbs = div('ed-thumbs')
    this.wireThumbDrop()
    this.sideLayers = div('ed-side-layers')
    this.sideTokens = div('ed-side-tokens')
    this.sidebar.append(this.sideTabs(), this.thumbs, this.sideLayers, this.sideTokens)
    const canvasWrap = div('ed-canvas-wrap')
    // presenting lives in ONE split pill beside the zoom control: the main
    // half starts the fullscreen show; its menu holds tab-fill and speaker view.
    const pill = div('ed-dropdown ed-present-pill')
    const showB = btn(ICONS.slideshow, t('Slideshow'), (ev) => ev.shiftKey ? this.playTransition() : this.present(false, true),
      t('Start the slideshow fullscreen — F toggles fullscreen, S opens speaker view, Esc ends; ⇧-click plays the transition into this slide'))
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
    const caret = btn('<span class="ed-caret" aria-hidden="true">▴</span>', '', () => pill.classList.toggle('open'),
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
    }, { signal: this.buildScope.signal })
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
    // the canvas over its speaker notes, as in every slide editor
    const centre = div('ed-centre')
    centre.appendChild(canvasWrap)
    mountNotesPane(this.store, centre, this.buildScope.signal)
    main.append(this.sidebar, this.makeResizer('left'), centre, this.makeResizer('right'), this.props)

    this.root.append(bar, main)
    requestAnimationFrame(() => this.holdPanelMins())
    // the whole page, not just the editor root: menus, the ⌘K palette and
    // dialogs are appended to <body>, and their titles were native tooltips
    mountHints(document.body, this.buildScope.signal)

    // phones/small windows: start with both panels collapsed so the CANVAS
    // is what you see — the topbar toggles (and [ / ]) bring them back
    if (window.innerWidth < 700) {
      this.sidebar.classList.add('ed-collapsed')
      this.props.classList.add('ed-collapsed')
    }

    actions.insertBefore(formatB, saveGroup)

    // The authored desktop layout, captured once the bar is fully assembled.
    // Unfolding REPLAYS this instead of guessing where each button belongs.
    // Guessing is what the old restore did — everything except demote[0] went
    // back to `actions` immediately before formatB — and it could not be right:
    // Comment is authored into the INSERT group, so it changed groups entirely,
    // and pdf/share/lang/help landed in a row after Save instead of interleaved
    // with the avatars strip, leaving Save sitting after Help.
    for (const g of [history, insert, actions]) {
      this.phoneChrome.authored.set(g, [...g.children] as HTMLElement[])
    }
    for (const [g, kids] of this.phoneChrome.authored) {
      for (const k of kids) this.phoneChrome.homeOf.set(k, g)
    }

    // drive it now and whenever the bar's size or content changes.
    // build() has just re-authored the bar, so whatever folding state a PREVIOUS
    // bar was in no longer describes this DOM. Without this reset a rebuild on a
    // phone (switching language, say) would early-return on `true === true` and
    // leave the freshly authored DESKTOP bar in place — overflowing, with Save
    // off-screen again.
    this.phoneChromeOn = null
    this.topbar = bar
    this.fitTopbar()
    // A ResizeObserver on the bar itself is the primary width signal. It fires
    // for every viewport change (matchMedia change events do not fire at all
    // under CDP-driven viewport changes, and a phone ROTATING is exactly this
    // path); the plain resize listener is belt and braces on top. fitTopbar
    // is idempotent, so the overlap costs a few reads.
    const signal = this.buildScope.signal
    this.barRO = new ResizeObserver(() => this.fitTopbar())
    this.barRO.observe(bar)
    window.addEventListener('resize', () => this.fitTopbar(), { signal })
    // The bar's CONTENT changes width too, at a constant viewport (avatars
    // join, the update chip appears, the file chip fills in, the "Saved" tag
    // flashes), and each of these used to clip the end of the bar. fitTopbar
    // drops the records its own mutations queue, so this cannot loop.
    this.barMO = new MutationObserver(() => this.fitTopbar())
    this.barMO.observe(bar, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['style', 'hidden'],
    })

    // On a narrow phone the bar scrolls sideways, which makes it a clipping
    // container — so the menus hanging off ＋ and ⋯ are positioned against the
    // VIEWPORT instead (styles.css). The one thing they cannot read from CSS is
    // where the bar ends: its height moves with the safe-area insets, which
    // differ per device and change when the phone rotates.
    const publishBarBottom = () =>
      this.root.style.setProperty('--ed-bar-bottom', `${Math.round(bar.getBoundingClientRect().bottom)}px`)
    const bottomRO = new ResizeObserver(publishBarBottom)
    bottomRO.observe(bar)
    window.addEventListener('resize', publishBarBottom, { signal })
    this.buildObservers.push(this.barRO, this.barMO, bottomRO)
    publishBarBottom()

    this.wireDrawerDismiss()
    this.restorePanelWidths()
    this.canvas = new SlideCanvas(canvasWrap, this.store, this.buildScope.signal)
    this.canvas.onCommentModeChange = (on) => commentB.classList.toggle('ed-btn-armed', on)
    this.canvas.onSlideNav = (dir) => this.store.goToLinear(dir)
    this.panel = new PropsPanel(this.props, this.store)
    this.panel.titleOf = (id, label) => titleFor(this.commands, id, label)
    this.panel.remove = () => this.deleteSelection()
    this.panel.layers.mount(this.sideLayers)
    const offs = (['doc', 'selection', 'current'] as const).map((e) => this.store.on(e, () => this.panel.layers.refresh()))
    this.buildScope.signal.addEventListener('abort', () => offs.forEach((off) => off()), { once: true })
    this.panel.onListIndent = (dir) => { this.canvas.indentList(dir) }
    this.panel.onMorphPreview = (t) => this.canvas.previewMorph(t)
    this.panel.onPlayTransition = () => this.playTransition()

    if (!canWriteDeck(this.store.doc.collab)) this.enterReaderMode()
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
  private static PANEL_DEFAULTS = { left: 188, right: 264 } as const

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

  /**
   * The narrowest a panel may be: its bound, or wider when its tab bar needs
   * the room — the chosen tab's whole name and the other tabs' glyphs, in the
   * current language (controls.ts tabBarNeed) — so dragging can never break
   * the tabs. Collapsing the panel is the chevron's job, not the resizer's.
   */
  private panelMin(side: 'left' | 'right'): number {
    const panel = side === 'left' ? this.sidebar : this.props
    const bar = panel.querySelector<HTMLElement>('.ed-icon-tabs')
    const need = bar ? tabBarNeed(bar) + (panel.getBoundingClientRect().width - bar.getBoundingClientRect().width) : 0
    return Math.max(Editor.PANEL_BOUNDS[side][0], Math.ceil(need))
  }

  /** A stored or default width under the minimum (a longer language, a
   *  file from before the minimum) is raised to it once the tabs exist. */
  private holdPanelMins() {
    let changed = false
    for (const side of ['left', 'right'] as const) {
      const min = this.panelMin(side)
      if (this.panelW[side] < min) { this.panelW[side] = min; changed = true }
    }
    if (changed) this.applyPanelWidths()
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
      const g = side === 'left' ? (collapsed ? 'right' : 'left') : (collapsed ? 'left' : 'right')
      return isRtl() ? (g === 'right' ? 'left' : 'right') : g
    }
    for (const side of ['left', 'right'] as const) {
      const b = this.panelToggles[side]
      if (b) {
        // an SVG chevron, not a ‹ › character: a glyph sits on the font's
        // baseline and never centres in the pill
        if (!b.firstElementChild) b.innerHTML = ICONS.chevron
        b.dataset.dir = glyph(side)
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
      const [, max] = Editor.PANEL_BOUNDS[side]
      const min = this.panelMin(side)
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
    /** each group's children in authored desktop order — replayed on unfold */
    authored: Map<HTMLElement, HTMLElement[]>
    /** which group each button was authored into */
    homeOf: Map<HTMLElement, HTMLElement>
  } | null = null

  /**
   * Fold the topbar into menus, and unfold it again when there is room.
   * Driven by fitTopbar (every phone, plus any window where even the icon
   * tier overflows). REPARENTS the existing buttons rather than building
   * phone copies: a duplicate would need its own listeners and would desync
   * from live state (the dirty dot lives ON the save button; the comment
   * button carries an armed class). Moving a node keeps all of that by
   * construction.
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
      // Back to their authored homes, in their authored order.
      //
      // Both halves matter. Sending each button to the group it was authored
      // into is what keeps Comment in the INSERT group instead of migrating it
      // to actions; replaying the captured order is what stops pdf/share/lang/
      // help from landing in a row and pushing Save past Help. Re-appending in
      // order is deliberately not "insert before the sibling I remember" —
      // that sibling may itself be demoted and not back yet.
      for (const b of p.demote) p.homeOf.get(b)?.appendChild(b)
      for (const [group, order] of p.authored) {
        for (const child of order) {
          if (child.parentElement === group) group.appendChild(child)
        }
      }
      p.moreD.classList.remove('open')
      p.insertD.classList.remove('open')
    }
  }

  private phoneChromeOn: boolean | null = null
  private topbar: HTMLElement | null = null
  private barRO: ResizeObserver | null = null
  private barMO: MutationObserver | null = null
  /** Scope of one build(): aborted by the next, so the window/document/store
   *  listeners the bar and its dropdowns register never outlive their DOM. */
  private buildScope = new AbortController()
  private buildObservers: (ResizeObserver | MutationObserver)[] = []

  /**
   * Size the topbar by MEASURING it, not by width breakpoints. Breakpoints
   * in px were wrong here: browser zoom, OS text scaling, wider translations
   * and live content (avatars, the update chip) all change how much room the
   * same buttons need at the same viewport width, and each of those cases
   * used to clip the end of the bar. Instead, start from the widest layout
   * and step down a tier while the bar still overflows its own box. First
   * ed-bar-compact hides the button labels, then ed-bar-tight drops the
   * wordmark, then ed-bar-fold moves buttons into menus (applyPhoneChrome).
   */
  private fitTopbar() {
    const bar = this.topbar
    if (!bar || !bar.isConnected) return
    const tiers = ['ed-bar-compact', 'ed-bar-tight', 'ed-bar-fold']
    // Phones fold unconditionally. The 700px media query is also what turns
    // the panels into overlay drawers, and the folded bar belongs with it.
    if (window.innerWidth <= 700) {
      bar.classList.add(...tiers)
      this.applyPhoneChrome(true)
      this.barMO?.takeRecords()
      return
    }
    // Re-fitting starts by unfolding, which reparents buttons and would slam
    // shut a dropdown the user is reading. Skip while one is open; the next
    // resize or content change runs this again.
    if (bar.querySelector('.ed-dropdown.open')) return
    // scrollWidth counts content that sticks out of the padding box even with
    // overflow visible, so "scrollWidth > clientWidth" IS the clipped-buttons
    // condition (ed-root clips whatever leaks). The 1px slack absorbs
    // subpixel rounding at fractional zoom levels.
    // …and the centred insert group can run over its neighbours without the
    // bar overflowing at all (at 768px it sat on Undo and Redo): two of the
    // bar's own groups overlapping is the same condition.
    // (a group's buttons spill past its own box, so compare the buttons)
    const collide = () => {
      const boxes = [...bar.querySelectorAll<HTMLElement>('button')]
        .filter((b) => !b.closest('.ed-menu'))
        .map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0).sort((a, b) => a.left - b.left)
      return boxes.some((r, i) => i > 0 && boxes[i - 1].right - r.left > 1)
    }
    const overflow = () => bar.scrollWidth - bar.clientWidth > 1 || collide()
    // The title input is the bar's only shrinkable item, so flexbox crushes
    // it toward its 48px floor before anything overflows. Waiting for hard
    // overflow would mean full button labels beside an unusable title, so
    // step down while the title is squeezed badly, not only on true overflow.
    const title = bar.querySelector<HTMLElement>('.ed-title')
    const cramped = () => overflow() || (!!title && title.getBoundingClientRect().width < 120)
    bar.classList.remove(...tiers)
    this.applyPhoneChrome(false)
    if (cramped()) bar.classList.add('ed-bar-compact')
    if (cramped()) bar.classList.add('ed-bar-tight')
    if (overflow()) {
      bar.classList.add('ed-bar-fold')
      this.applyPhoneChrome(true)
    }
    // the class flips and reparenting above queued mutation records of their
    // own; drop them, or the observer re-runs this forever
    this.barMO?.takeRecords()
  }

  togglePanel(side: 'left' | 'right') {
    const el = side === 'left' ? this.sidebar : this.props
    el.classList.toggle('ed-collapsed')
    this.updatePanelChevrons()
    // the canvas wrap resizes; its ResizeObserver re-fits the stage
  }

  /**
   * Below 700px the two side panels stop being columns and become overlay
   * DRAWERS (styles.css) — they cover the canvas rather than sitting beside it.
   * That is the width at which "leave the panel open" stops being free.
   */
  private get panelsAreDrawers(): boolean {
    // The 700px here is the SAME constant as fitTopbar()'s phone check and the
    // `@media (max-width: 700px)` block that turns the panels into drawers —
    // this asks the panel question, not the topbar one. #239 replaced the bar's
    // width-breakpoint machinery (a matchMedia `phoneQuery`) with measuring, and
    // that is why the old `phoneQuery?.matches ??` prefix that used to sit here
    // no longer compiles. It was only ever a cache of this same comparison.
    return window.innerWidth <= 700
  }

  /** Close a panel if it is open — idempotent, unlike togglePanel. */
  private closePanel(side: 'left' | 'right') {
    const el = side === 'left' ? this.sidebar : this.props
    if (el.classList.contains('ed-collapsed')) return
    el.classList.add('ed-collapsed')
    this.updatePanelChevrons()
  }

  /** Dismiss an open dropdown when a press lands outside it — the behaviour the
   *  bar's other menus already wire up one by one. */
  private closeOnOutsidePress(wrap: HTMLElement) {
    document.addEventListener('pointerdown', (ev) => {
      if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
    }, { signal: this.buildScope.signal })
  }

  /**
   * Tapping away from a drawer dismisses it — the gesture every sheet on a
   * phone answers to, and the only one available when the drawer covers the
   * control that opened it.
   *
   * Two conditions keep it honest. It only runs while the panels ARE drawers:
   * on a wide screen they are columns beside the canvas, where a click on the
   * canvas is just a click on the canvas. And a press inside the topbar is
   * exempt, because ☰ and Format must keep working as TOGGLES — closing on
   * their pointerdown would let the click that follows reopen what it just
   * closed, and the buttons would never shut anything.
   */
  private wireDrawerDismiss() {
    document.addEventListener('pointerdown', (ev) => {
      if (!this.panelsAreDrawers) return
      const target = ev.target as Node
      if (target instanceof Element && target.closest('.ed-topbar')) return
      if (!this.sidebar.contains(target)) this.closePanel('left')
      if (!this.props.contains(target)) this.closePanel('right')
    }, { capture: true, signal: this.buildScope.signal })
  }

  // --- Save dropdown: copy / new deck / template -----------------------------

  private saveDropdown(): HTMLElement {
    const wrap = div('ed-dropdown')
    const menu = div('ed-menu ed-save-menu')
    const trigger = btn('<span class="ed-caret" aria-hidden="true">▾</span>', '', () => {
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
    }, { signal: this.buildScope.signal })
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
      b.appendChild(menuLabel(label, title, b))
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
      // the dialog explains itself; a tooltip here would say the same twice
      item(ICONS.image, t('Export slides as images…'), '', () => this.exportImages())
      if (isEncryptionActive()) {
        item(ICONS.lock, t('Change password…'),
          t('Pick a new password for this file — takes effect on the next save.'),
          () => void this.setFilePassword())
        item(ICONS.lock, t('Remove password'),
          t('Stop encrypting this file — the next save writes it as plain, readable JSON again.'),
          () => {
            setEncryptionPassword(null)
            this.syncWindowTitle() // the deck title may return to the tab
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
        t('Copies this deck as plain JSON — content only, no live-session keys. Edit it in another tool, then bring it back with Replace from JSON.'),
        () => void this.copyDocJson())
      item(ICONS.code, t('Copy compact JSON (for agents)'),
        t('The same deck with every default left out — the shape an AI agent should write. Replace from JSON takes it back; the saved file is always full.'),
        () => void this.copyDocJson(true))
      item(ICONS.code, t('Replace from JSON…'),
        t('Paste edited document JSON to replace this deck’s content — ⌘Z undoes.'),
        () => this.openReplaceJson())
      // with the other import, where spaces has Import Markdown…
      item(ICONS.importDoc, t('Import PowerPoint…'),
        t('Opens the PowerPoint importer on bento.page in a new tab — it turns a .pptx into a Bento deck. Needs an internet connection.'),
        () => { window.open(IMPORT_PPTX_URL, '_blank', 'noopener,noreferrer') })
      item(ICONS.exportDoc, t('Export for PowerPoint…'),
        t('Opens the converter on bento.page in a new tab — drop this deck’s saved file there to get a .pptx. The deck is not uploaded. Needs an internet connection.'),
        () => { window.open(EXPORT_PPTX_URL, '_blank', 'noopener,noreferrer') })
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
    this.store.commit(() => {
      this.store.doc.slides = [instantiateLayout(blank)]
    }, 'slides')
  }

  /** A sealed hand-out: present-only player file, no editor, no live session. */
  private async savePresentationPackage() {
    const clone = JSON.parse(JSON.stringify(this.store.doc)) as import('../model').BentoDoc
    clone.readonly = true
    stripCollabSecrets(clone) // a sealed package must not join (or leak) the live room
    try {
      const ok = await writeUpdatedFileAs(await serializeAuto(clone), clone, { suffix: 'presentonly' })
      if (ok) this.toast(t('Presentation package saved — it opens straight into the show'))
    } catch {
      this.toast(t('Saving failed'))
    }
  }

  /**
   * The audience TICKET for live broadcast — minted once per deck, reused for
   * every show, replaced only by "Issue new tickets". An audience member is a
   * collaborator whose `collab.key` is the SHOW key, not the room key: the
   * presenter double-encrypts while live and the relay never persists that
   * stream, so between shows the ticket decrypts nothing (docs/DECISIONS.md,
   * the broadcast entry). Owner-only: the invite is owner-signed.
   */
  private async audienceTicket(): Promise<AudienceTicket | null> {
    const c = this.store.doc.collab
    if (!(c?.room && c.key && c.v === 2 && c.ownerPriv)) return null
    if (c.audience) return c.audience
    const invite = await mintInvite(c.ownerPriv, 'audience')
    const ticket: AudienceTicket = { invite: { ...invite, role: 'audience' }, key: mintRoomKey() }
    this.store.commit(() => { this.store.doc.collab!.audience = ticket })
    return ticket
  }

  /** A live broadcast hand-out: opens straight into the show and follows the
   *  presenter while they are live. Built by the audience PROJECTION
   *  (src/audience.ts) — the same function that builds the join snapshot the
   *  relay serves — so it never carries speaker notes, comments, the room key
   *  or any private half; blobs are inlined because a show-key copy cannot
   *  open room-key blobs. Between shows it is a plain, working deck. */
  private async saveAudienceCopy() {
    await this.goLive()
    const ticket = await this.audienceTicket()
    if (!ticket) {
      this.toast(t('Only the deck owner can issue audience tickets'))
      return
    }
    this.canvas.commitTextEdit()
    const { doc: copy, missingAssets } = projectDoc(this.store.doc, ticket)
    copy.docId = this.store.doc.docId // same document: the audience follows THIS deck
    if (missingAssets.length) this.toast(t('Some offloaded images are not on this machine yet and will be missing from the copy'))
    try {
      // serializeAuto, like every other copy written for a person: an active
      // password reaches the file. A viewer of an encrypted deck needs the
      // password, which is what encrypting the deck meant.
      const ok = await writeUpdatedFileAs(await serializeAuto(copy), copy, { suffix: 'audience', keepHandle: false })
      if (ok) this.toast(t('Audience copy saved — it opens into the show and follows you while you are live'))
    } catch {
      this.toast(t('Saving failed'))
    }
  }

  /** Re-mint the audience ticket. Every audience copy handed out so far is
   *  dead from this moment — cryptographically (a new show key; nothing is
   *  ever encrypted under the old one again) and at the door (the old invite
   *  is revoked at the relay). A recurring class's handouts included: say so. */
  private async issueNewTickets() {
    const c = this.store.doc.collab
    if (!(c?.v === 2 && c.ownerPriv && c.owner)) {
      this.toast(t('Only the deck owner can issue audience tickets'))
      return
    }
    const old = c.audience
    if (!old) { this.toast(t('No audience tickets have been issued for this deck')); return }
    if (!confirm(t('Issue new tickets? Every audience copy saved so far will stop working, including ones you handed out for a recurring session.'))) return
    const tr = onlineTransport()
    if (tr) await tr.revokeKey(old.invite.pub, c.owner, c.ownerPriv) // defence in depth behind the key change
    this.store.commit(() => { delete this.store.doc.collab!.audience })
    const fresh = await this.audienceTicket()
    if (fresh) this.toast(t('New tickets issued — save a new audience copy to hand out'))
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
    const clone = readerCopy(this.store.doc)
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
    // The invite is the only private material an editor copy may carry: the kernel
    // allowlist (share.ts inviteCopy) drops every private half AND a legacy
    // writerPriv, then attaches a FRESH owner-signed invite and takes the role from
    // it — a v2 room is verified through the owner→invite→member chain.
    const clone = await inviteCopy(this.store.doc, c.ownerPriv)
    try {
      const ok = await writeUpdatedFileAs(await serializeAuto(clone), clone, { suffix: 'invite' })
      if (ok) this.toast(t('Editor copy saved — recipients join live with edit access'))
    } catch {
      this.toast(t('Saving failed'))
    }
  }

  /**
   * The document as loose data (the AI/tooling round-trip). It leaves WITHOUT
   * the live session: this text is pasted into chats, tickets and scratch
   * files, and `collab` is a bearer capability — the room key decrypts every
   * frame and blob the relay holds, and the private halves grant writing and
   * member revocation on top. Nothing about the round-trip needs a room, and
   * openReplaceJson keeps THIS document's, so dropping the block costs nothing.
   */
  private async copyDocJson(compact = false) {
    const clone = JSON.parse(JSON.stringify(this.store.doc)) as import('../model').BentoDoc
    stripCollabSecrets(clone)
    try {
      await navigator.clipboard.writeText(compact ? compactJson(clone) : JSON.stringify(clone))
      this.toast(compact ? t('Compact JSON copied') : t('Document JSON copied'))
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
      // The pasted text is foreign input, full or compact (src/compact.ts):
      // the gate rebuilds it (restoregate.ts sanitizeDoc), and with `live` the
      // identity and capability stay THIS document's — its docId (recovery
      // and versions are keyed by it, on a store other local files share),
      // its live session (the copy side sends no collab, so adopting the
      // pasted one would wipe the room or move the deck into someone else's)
      // and its file mode. Decided BEFORE the swap: replaceDoc's events reach
      // the sync session synchronously and it re-attaches to whatever
      // `collab` the new document holds. Content is imported; identity is not.
      const parsed = parseDocInputReport(ta.value, { live: this.store.doc })
      if (parsed) {
        this.store.replaceDoc(parsed.doc)
        // the load report, summarised; the whole thing goes to the console
        // where an agent driving the page (or a person) can read the paths
        const r = parsed.report
        const warnings = r.findings.counts.warning + r.findings.counts.error
        if (r.dropped.length || warnings) {
          console.info('[bento] load report', r)
          this.toast(t('Loaded: {dropped} fields dropped, {warnings} warnings — see console', { dropped: String(r.dropped.length), warnings: String(warnings) }))
        } else this.toast(t('Document replaced — ⌘Z undoes'))
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
    this.syncWindowTitle() // the deck title leaves the tab now, not at the next save
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
    stripCollabSecrets(clone) // instances mint their own credentials
    delete (clone as { docId?: string }).docId
    try {
      // serializeAuto, never serializeFile: a template is the copy people hand
      // around, and a password-protected deck saved as one wrote its body in
      // PLAINTEXT while the preview veto still made the file thumbnail as
      // locked — it looked protected and was readable in any text editor.
      const ok = await writeUpdatedFileAs(await serializeAuto(clone), clone, { suffix: 'template' })
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
    }, { signal: this.buildScope.signal })
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
    // plain menu rows, as in Save as — the section heading and the icons mark
    // them as commands; boxing each one only made the panel busier
    const action = (icon: string, label: string, onClick: () => void, title = '') => {
      const b = document.createElement('button')
      b.className = 'ed-btn ed-share-btn'
      if (icon) b.innerHTML = icon
      b.appendChild(menuLabel(label, title, b))
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
      if (!canWriteDeck(cme)) myRole = 'viewer'
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
        dot.style.background = cssColor(peer.color, '#888')
        const who = document.createElement('span')
        who.className = 'who'
        who.textContent = peer.editing ? `${peer.name} ✏️` : peer.name
        // a pub-carrying peer's name is bound to its signing key, not just typed
        if (peer.pub) who.title = t('Key-verified identity') + ` · ${fp(peer.pub)}`
        const where = document.createElement('span')
        where.className = 'where'
        const idx = this.store.doc.slides.findIndex((s) => s.id === peer.slide)
        where.textContent = [roleLabel(peer.role), idx >= 0 ? t('Slide {n}', { n: idx + 1 }) : ''].filter(Boolean).join(' · ')
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
    // pictures still uploading (inline assets over the blob threshold with no
    // ref yet): polled once a second ONLY while the popover is open — the
    // interval stops itself the moment the wrap is closed. Hidden at 0.
    if (this.uploadPoll !== null) { clearInterval(this.uploadPoll); this.uploadPoll = null }
    if (on && this.session) {
      const uploading = note('', 'ed-share-uploading')
      uploading.hidden = true
      const tick = () => {
        if (!this.shareWrap.classList.contains('open')) { if (this.uploadPoll !== null) clearInterval(this.uploadPoll); this.uploadPoll = null; return }
        const k = this.session?.pendingBlobUploads() ?? 0
        uploading.hidden = k === 0
        uploading.textContent = k === 1 ? t('1 picture still uploading…') : t('{n} pictures still uploading…', { n: k })
      }
      tick()
      this.uploadPoll = window.setInterval(tick, 1000)
    }
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
    const canWrite = !!cme && canWriteDeck(cme)
    if (canWrite) {
      const label = div('ed-share-label')
      label.textContent = t('Share a copy')
      panel.appendChild(label)
      action(ICONS.share, t('Invite to edit…'), () => void this.inviteToEdit(),
        t('Saves a copy to send. Whoever opens it edits this deck live with you (end-to-end encrypted); you stay the owner and can remove them from the People list.'))
      action(ICONS.eye, t('View-only copy…'), () => void this.saveReaderCopy(),
        t('A live viewer: follows every edit as it happens but can never change the deck — the relay enforces it.'))
      action(ICONS.slideshow, t('Present-only file…'), () => void this.savePresentationPackage(),
        t('A sealed hand-out that opens straight into the show — no editor, no live connection.'))
      action(ICONS.broadcast, t('Audience copy…'), () => void this.saveAudienceCopy(),
        t('A hand-out for a live show: opens into the presentation and follows your slides while you are live. Never carries your speaker notes or comments.'))
      if (this.store.doc.collab?.audience) {
        action(ICONS.broadcast, t('Issue new tickets…'), () => void this.issueNewTickets(),
          t('Replaces the audience tickets: every audience copy saved so far stops working.'))
      }
      action(ICONS.template, t('Template…'), () => void this.saveAsTemplate(),
        t('A reusable starter: everyone who opens it gets their own fresh, independent deck.'))
    } else {
      note(t('This is a view-only copy — it follows the live session but can’t change the deck.'))
    }

    // advanced session controls, deliberately quiet at the bottom
    if (canWrite) {
      panel.appendChild(div('ed-share-sep'))
      if (on) {
        action(ICONS.stop, t('Stop sharing'), () => {
          if (!this.session) return
          stopSharing(this.session, this.store)
          this.wireOnlineStatus()
          this.renderSharePanel()
        }, t('Disconnect this deck from the live session. Copies keep their last state and can rejoin if you go live again.'))
      } else {
        action(ICONS.live, t('Go live'), () => void this.goLive().then(() => this.renderSharePanel()),
          t('Connect to the live session without saving a new copy — copies you sent earlier will meet you there.'))
      }
      action(ICONS.key, t('Reset access…'), async () => {
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
    // An audience copy holds the SHOW key, not the room key, and must never
    // mint or join a session of its own — its only path is the show (main.ts).
    if (this.store.doc.collab?.role === 'audience') return
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
    }, { signal: this.buildScope.signal })
    return wrap
  }

  private shapeDropdown(): HTMLElement {
    const wrap = div('ed-dropdown')
    const trigger = btn(ICONS.shapes, t('Shape'), () => wrap.classList.toggle('open'))
    const menu = div('ed-menu')
    for (const item of SHAPE_MENU) {
      const id = SHAPE_TOOL[item.label]
      if (id) {
        const b = this.cmdButton(id, item.icon, t(item.label), t(item.tip))
        b.addEventListener('click', () => wrap.classList.remove('open'))
        menu.appendChild(b)
        continue
      }
      const b = btn(item.icon, t(item.label), () => {
        wrap.classList.remove('open')
        // line / curve / connector arm a draw tool — drag on the canvas to draw
        // (or click to drop a default); other shapes insert straight away.
        if (item.draw) { this.canvas.armDraw(item.draw); return }
        this.canvas.insert(defaultShape(item.kind, item.heads ? { heads: item.heads } : {}))
      }, t(item.tip))
      menu.appendChild(b)
    }
    wrap.append(trigger, menu)
    document.addEventListener('pointerdown', (ev) => {
      if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
    }, { signal: this.buildScope.signal })
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
      num.title = t('Variant of slide {n} — opens when a linked element is clicked while presenting', { n: parentIdx + 1 })
    } else if (slide.hidden) {
      // The sidebar shows what the AUDIENCE would count. With the default
      // numbering a hidden slide has no number at all, so show the marker
      // alone; with office-suite numbering it keeps one, struck through — the
      // same affordance PowerPoint uses. Either way it must be obvious at a
      // glance, because a slide you forgot you hid is found mid-presentation.
      num.textContent = paginates(slide, this.store.doc) ? String(this.linearNumber(i)) : '—'
      num.title = t('Hidden — skipped while presenting and left out of PDF export')
    } else if (slide.unnumbered) {
      // In the walk but not counted: the audience's page field shows the
      // previous slide's number on it, so that is what the sidebar shows too,
      // dimmed, with the marker that says why it is not the next number.
      num.textContent = `${this.linearNumber(i)}·`
      num.classList.add('ed-num-unnumbered')
      num.title = t('Unnumbered — in the show, continues the previous page number')
    } else {
      num.textContent = String(this.linearNumber(i))
    }
    // thumb width tracks the (resizable) sidebar; states render smaller
    const base = Math.max(96, this.panelW.left - 52)
    const surface = renderThumbnail(slide, this.store.doc, isState ? Math.round(base * 0.84) : base)
    if (slide.comments?.some((c) => !c.resolved)) {
      const badge = div('ed-thumb-cmt')
      badge.title = t('Open comments: {n}', { n: slide.comments.filter((c) => !c.resolved).length })
      item.appendChild(badge)
    }
    const tools = div('ed-thumb-tools')
    tools.append(
      btn(ICONS.copy, '', (ev) => { ev.stopPropagation(); this.duplicateSlide(i) }, t('Duplicate slide')),
      btn(ICONS.trash, '', (ev) => { ev.stopPropagation(); this.deleteSlides(this.thumbTargets(i)) }, t('Delete slide')),
    )
    item.append(num, surface, tools)
    item.addEventListener('click', (ev) => {
      // Shift = a range from the current slide; Cmd/Ctrl = toggle this one;
      // plain = this one alone (as always). The canvas stays on the current
      // slide for the modified clicks — it is the anchor, not a target.
      const mod = ev.metaKey || ev.ctrlKey
      if (ev.shiftKey && !isState) { this.setThumbSel(selRange(this.store.doc.slides, this.store.currentIndex, i)); return }
      if (mod && !isState) { this.setThumbSel(selToggle(this.store.doc.slides, this.thumbSel.length ? this.thumbSel : [this.store.currentIndex], i)); return }
      this.setThumbSel([])
      this.store.goTo(i)
      // On a phone the slide list is a drawer laid OVER the canvas, so picking
      // a slide left the answer hidden behind the question — you had to find
      // and press the ☰ toggle again to see the slide you just chose. On a wide
      // screen the list is a column beside the canvas and rightly stays put.
      if (this.panelsAreDrawers) this.closePanel('left')
    })
    if (!isState) this.wireThumbDrag(item, i)
    return item
  }

  /** 1-based position among non-state slides (what the audience counts). */
  private linearNumber(i: number): number {
    return this.store.doc.slides.slice(0, i + 1).filter((s) => paginates(s, this.store.doc)).length
  }

  /** Slides | Layers, in the same tab look as the inspector's. */
  private sideTabs(): HTMLElement {
    const bar = div('ed-tabs ed-side-tabs ed-icon-tabs')
    bar.setAttribute('role', 'tablist')
    const show = (view: string) => {
      this.sidebar.dataset.view = view
      for (const b of bar.children) b.setAttribute('aria-selected', String((b as HTMLElement).dataset.view === view))
    }
    // Each tab is its glyph; the chosen one also says its name (fitTabNames)
    const glyphs = { slides: ICONS.viewSlides, layers: ICONS.viewLayers, tokens: ICONS.viewTokens }
    for (const [view, label] of [['slides', t('Slides')], ['layers', t('Layers')], ['tokens', t('Tokens')]] as const) {
      const b = iconTab(glyphs[view], label)
      b.dataset.view = view
      b.addEventListener('click', () => { show(view); lsSet('bento-side-view', view) })
      bar.appendChild(b)
    }
    fitTabNames(bar)
    const saved = lsGet('bento-side-view')
    show(saved === 'layers' || saved === 'tokens' ? saved : 'slides')
    slidingPill(bar)
    // the inspector's band (panels.ts mountTabs): sticky, edge to edge
    const band = div('ed-tabs-band ed-side-band')
    band.appendChild(bar)
    return band
  }

  private rebuildSidebar() {
    // States sit in doc order right after their parent and render nested —
    // smaller, indented, dimmed — so the structure reads at a glance.
    const scroll = this.sidebar.scrollTop
    this.thumbs.innerHTML = ''
    const slides = this.store.doc.slides
    slides.forEach((slide, i) => {
      // hover gap = insert here; never between a parent and its states
      if (!slide.stateOf) this.thumbs.appendChild(this.insertGap(i))
      const item = this.makeThumb(slide, i, !!slide.stateOf)
      if (slide.stateOf) item.classList.add('ed-thumb-state')
      if (slide.hidden) item.classList.add('ed-thumb-hidden')
      this.thumbs.appendChild(item)
    })
    this.thumbs.appendChild(this.insertGap(slides.length))
    const add = btn(ICONS.plus, t('New slide'), () => this.openLayoutPicker(add, { kind: 'insert', at: this.store.doc.slides.length }))
    add.classList.add('ed-add-slide')
    add.title = t('New slide at the end, from a layout')
    this.thumbs.appendChild(add)
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
    // Open beside the anchor, clamped on-screen. The bottom-of-sidebar button
    // used to open the picker upward from itself, which pushed a picker with
    // a handful of custom layouts above the viewport (measured: top = -7px at
    // a 600px-tall window). The height is read after appending so the clamp
    // uses the real box; the stylesheet caps it to the viewport and scrolls.
    const r = anchor.getBoundingClientRect()
    pick.style.left = `${Math.max(8, Math.min(r.right + 10, window.innerWidth - 440))}px`
    document.body.appendChild(pick)
    pick.style.top = `${Math.max(8, Math.min(r.top - 40, window.innerHeight - pick.offsetHeight - 8))}px`
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
    gap.dataset.at = String(at)
    gap.title = t('Insert slide here')
    const plus = document.createElement('button')
    plus.className = 'ed-insertgap-btn'
    plus.textContent = '＋'
    plus.tabIndex = -1
    gap.appendChild(plus)
    gap.addEventListener('click', () => this.openLayoutPicker(gap, { kind: 'insert', at }))
    return gap
  }

  /** The multi-selection, normalised to parents; the sidebar repaints. */
  private setThumbSel(sel: number[]) {
    this.thumbSel = selParents(this.store.doc.slides, sel)
    this.highlightSidebar()
  }

  /** What a sidebar action acts on: the selection when the thumb is in it,
   *  else that thumb alone. */
  private thumbTargets(index: number): number[] {
    const inSel = this.thumbSel.includes(index)
    return inSel ? this.thumbSel : [index]
  }

  private wireThumbDrag(item: HTMLElement, index: number) {
    // Select on press, before the browser starts native dragging. Waiting for
    // click/dragstart leaves Moveable's previous canvas target live while the
    // pointer crosses the workspace. A modified press (Shift/Cmd/Ctrl) is a
    // selection gesture handled on click; a press on a thumb that is already
    // in the selection keeps the selection (so it can be dragged as a block).
    item.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0 || (ev.target instanceof Element && ev.target.closest('.ed-thumb-tools'))) return
      ev.stopPropagation() // keep the canvas Moveable gesture controller out
      if (ev.shiftKey || ev.metaKey || ev.ctrlKey) return
      if (!this.thumbSel.includes(index)) { this.setThumbSel([]); this.store.goTo(index) }
    })
    item.addEventListener('dragstart', (ev) => {
      // the payload is every parent index that moves — the selection when
      // this thumb is part of it, else this one; states follow their parent
      this.dragFrom = this.thumbTargets(index)
      ev.dataTransfer!.setData('text/bento-slide', JSON.stringify(this.dragFrom))
      ev.dataTransfer!.effectAllowed = 'move'
      item.classList.add('dragging')
    })
    item.addEventListener('dragend', () => { item.classList.remove('dragging'); this.dragFrom = null; this.showDropLine(null) })
  }

  /** The slides being dragged in the list (dataTransfer is unreadable during
   *  dragover, so the drop line needs its own copy). */
  private dragFrom: number[] | null = null

  /**
   * Where dragged slides would land, drawn as a thick line in the gap: the
   * pointer above a thumbnail's middle means before its unit, below means
   * after it — never between a parent and its states, since those gaps do not
   * exist. A drop that would change nothing shows no line. One listener on the
   * list, so the line follows the pointer across thumbnails and gaps alike.
   */
  private wireThumbDrop() {
    const at = (ev: DragEvent): number | null => {
      if (!this.dragFrom) return null
      const slides = this.store.doc.slides
      for (const item of this.thumbs.querySelectorAll<HTMLElement>('.ed-thumb')) {
        const r = item.getBoundingClientRect()
        if (ev.clientY > r.bottom) continue
        const i = Number(item.dataset.index)
        const unit = expand(slides, [i])
        return ev.clientY < r.top + r.height / 2 ? unit[0] : unit[unit.length - 1] + 1
      }
      return slides.length
    }
    this.thumbs.addEventListener('dragover', (ev) => {
      const to = at(ev)
      if (to === null) return
      ev.preventDefault()
      ev.dataTransfer!.dropEffect = 'move'
      this.showDropLine(moveBlock(this.store.doc.slides, this.dragFrom!, to) === this.store.doc.slides ? null : to)
    })
    this.thumbs.addEventListener('dragleave', (ev) => {
      if (!this.thumbs.contains(ev.relatedTarget as Node | null)) this.showDropLine(null)
    })
    this.thumbs.addEventListener('drop', (ev) => {
      const to = at(ev)
      this.showDropLine(null)
      if (to === null) return
      ev.preventDefault()
      this.dropSlides(ev.dataTransfer!.getData('text/bento-slide'), to)
    })
  }

  private showDropLine(at: number | null) {
    this.thumbs.querySelectorAll('.ed-insertgap.drop').forEach((g) => { if (g.getAttribute('data-at') !== String(at)) g.classList.remove('drop') })
    if (at !== null) this.thumbs.querySelector(`.ed-insertgap[data-at="${at}"]`)?.classList.add('drop')
    this.thumbs.classList.toggle('ed-thumbs-dragging', at !== null)
  }

  /** Move the dragged units (a JSON list of parent indices, or one index
   *  from an older payload) as a block to sit where `index` is; one commit. */
  private dropSlides(payload: string, index: number) {
    let from: number[]
    try { const v = JSON.parse(payload); from = Array.isArray(v) ? v.map(Number) : [Number(v)] } catch { from = [parseInt(payload)] }
    from = from.filter((n) => Number.isInteger(n) && n >= 0)
    if (!from.length) return
    const before = this.store.doc.slides
    const after = moveBlock(before, from, index)
    if (after === before) return
    const currentId = before[this.store.currentIndex]?.id
    const movedIds = expand(before, from).map((i) => before[i].id)
    this.store.commit(() => { this.store.doc.slides = after }, 'slides')
    // the selection follows the slides, by id; the canvas stays on its slide
    const at = after.findIndex((s) => s.id === currentId)
    if (at >= 0 && at !== this.store.currentIndex) this.store.goTo(at)
    this.setThumbSel(after.map((s, i) => (movedIds.includes(s.id) ? i : -1)).filter((i) => i >= 0))
  }

  private highlightSidebar() {
    let active: HTMLElement | undefined
    // the selection paints parents AND their states (they move together)
    const selected = new Set(expand(this.store.doc.slides, this.thumbSel))
    this.sidebar.querySelectorAll<HTMLElement>('.ed-thumb').forEach((n) => {
      const idx = Number(n.dataset.index)
      const isActive = idx === this.store.currentIndex
      n.classList.toggle('active', isActive)
      n.classList.toggle('selected', selected.has(idx))
      if (isActive) active = n
    })
    // Bring the current slide into view only when it CHANGED. This also runs
    // for a selection change and after a rebuild, with the current slide where
    // it was — and a click on a thumb clears the selection BEFORE it moves the
    // current slide, so revealing then scrolled the list to the slide being
    // LEFT (often off-screen), and the click landed with a different thumb
    // under the pointer. Keyboard and show navigation still reveal: they
    // change the current slide.
    if (active && this.store.currentIndex !== this.thumbRevealed) {
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    if (active) this.thumbRevealed = this.store.currentIndex
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
    adoptComponents(clone.elements, this.store.doc) // one main per component: the duplicate's main becomes a copy
    this.store.commit(() => {
      this.store.doc.slides.splice(i + 1, 0, clone)
    }, 'slides')
    this.store.goTo(i + 1)
    if (clone.transition !== 'morph') this.morphOffer = clone.id
  }

  /** A duplicated slide, until the first time something on it moves or
   *  resizes — then Morph is offered, once (the duplicate-and-move idiom is
   *  how a morph is built, and the duplicate keeps the original's transition). */
  private morphOffer: string | null = null

  private offerMorph() {
    const slide = this.store.slide
    // Morph set from anywhere (the inspector, the transition picker, the
    // toast's own button) answers the question: the offer goes
    if (slide.transition === 'morph') document.querySelector('.ed-toast[data-kind="morph"]')?.remove()
    if (!this.morphOffer || slide.id !== this.morphOffer) return
    if (slide.transition === 'morph') { this.morphOffer = null; return }
    const pairs = wouldPair(this.store.doc, slide)
    const moved = slide.elements.some((e) => {
      const f = pairs.get(e.id)
      return f && (f.x !== e.x || f.y !== e.y || f.w !== e.w || f.h !== e.h)
    })
    if (!moved) return
    this.morphOffer = null
    this.toast(t('Things moved — morph them from the slide before?'), {
      label: t('Use Morph'),
      run: () => this.store.commit(() => { slide.transition = 'morph' }),
    }, 'morph')
  }

  /** Delete several units at once — the sidebar's multi-selection — with
   *  the same cascade and confirm as one slide (states go with parents,
   *  links into the doomed are cleared, a linear slide must survive). */
  private deleteSlides(indices: number[]) {
    if (indices.length === 1) return this.deleteSlide(indices[0])
    const plan = deletePlan(this.store.doc.slides, indices)
    if (!plan.survives) return this.toast(t('A deck needs at least one slide'))
    const n = selParents(this.store.doc.slides, indices).length
    const parts = [
      plan.states ? `${plan.states} interactive state${plan.states > 1 ? 's' : ''} will be deleted with them` : '',
      plan.links ? `${plan.links} element link${plan.links > 1 ? 's' : ''} will be cleared` : '',
    ].filter(Boolean).join('; ')
    if (!window.confirm(parts ? t('Delete {n} slides? {parts}.', { n: String(n), parts }) : t('Delete {n} slides?', { n: String(n) }))) return
    const doomed = plan.doomed
    this.store.commit(() => {
      this.store.doc.slides = this.store.doc.slides.filter((s) => !doomed.has(s.id))
      for (const s of this.store.doc.slides) for (const el of s.elements) if (el.link && doomed.has(el.link)) delete el.link
    }, 'slides')
    this.setThumbSel([])
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
  }

  /**
   * Export the deck to PDF via the browser's print pipeline: every linear
   * slide becomes one exact 1600×900 page. Anything outside the linear flow
   * stays off the paper: a state is reachable only through interaction, and a
   * hidden slide is material the audience was not meant to be handed.
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
      if (!inLinearFlow(slide)) continue
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

  /** Slides as PNG/JPEG files (discussions #243, #261) — editor/exportimages.ts. */
  exportImages() {
    this.canvas.commitTextEdit()
    openExportImagesDialog(this.store.doc, this.store.slide, (m) => this.toast(m))
  }

  // --- insert image ------------------------------------------------------------------

  private pickImage() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      void this.shrinkForInsert(file).then((r) => {
        const src = r.dataUrl
        const img = new Image()
        img.onload = () => {
          const { width: dw, height: dh } = this.store.doc.size
          const scale = Math.min((dw * 0.5) / img.width, (dh * 0.5) / img.height, 1)
          const w = Math.round(img.width * scale)
          const h = Math.round(img.height * scale)
          this.canvas.insert(defaultImage(src, { w, h, x: (dw - w) / 2, y: (dh - h) / 2 }))
        }
        img.src = src
      })
    })
    input.click()
  }

  /** Every image insert goes through here (shrink.ts): the picture is capped
   *  at 2560 px, photos re-encoded lossy, graphics kept lossless, the original
   *  kept when nothing is gained — and the author is told only when the saving
   *  is worth a line. `original` bypasses it (the panel's "original size"). */
  async shrinkForInsert(file: Blob, original = false): Promise<ShrinkResult> {
    if (original) {
      const dataUrl = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsDataURL(file) })
      return { dataUrl, width: 0, height: 0, before: file.size, after: file.size, kind: 'kept', reason: 'off' }
    }
    const r = await shrinkImageFile(file)
    const note = shrinkNote(r)
    if (note) this.toast(note.photo ? t('Photo stored at {px} px — {before} → {after}', note.vars) : t('Image stored at {px} px — {before} → {after}', note.vars))
    return r
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
    }, { signal: this.buildScope.signal })
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
      speakerWindowTitle(this.store.doc.title),
      speakerIdleBody(this.store.doc.title, t('Notes, controls and slide thumbnails appear here when you start presenting. Drag this window to your second display.')),
    )
    if (!w) this.toast(t('Couldn’t open the speaker view — allow pop-ups for this site.'))
  }

  present(fromStart = false, fullscreen = true, at = fromStart ? 0 : this.store.currentIndex) {
    if (this.presenting) return null
    // They've started a slideshow — retire the first-run nudge for good.
    lsSet('bento-slideshow-started', '1')
    document.querySelector('.ed-hint-pulse')?.classList.remove('ed-hint-pulse')
    this.canvas.commitTextEdit()
    document.querySelector('.ed-toast')?.remove() // never drawn over the show
    this.presenting = true
    return startPresentation(this.store.doc, at, (last) => {
      this.presenting = false
      this.store.goTo(last)
      this.canvas.render()
    }, { fullscreen, broadcast: this.presenterBroadcast() })
  }

  /** Check a transition without presenting the deck: start on the slide the
   *  show arrives from and step once into this one. */
  playTransition() {
    const here = this.store.currentIndex
    const src = walkSource(this.store.doc, this.store.slide)
    if (!src) return this.toast(t('Nothing comes before this slide.'))
    const show = this.present(false, false, this.store.doc.slides.indexOf(src))
    // ponytail: a fixed beat for the show to settle before stepping; a ready event if it ever jumps
    if (show) setTimeout(() => show.goTo(here), 700)
  }

  /**
   * The show's broadcast surface, presenter side. The speaker view's Live
   * toggle calls start(): make sure we are sharing (a proven writer), mint or
   * reuse the audience ticket, and hand the session the show key plus the two
   * projection functions — projectOp for every op it streams from now on,
   * projectDoc for the audsnap it seals (and re-seals on checkpoint). The
   * session does the rest; the show only sends verbs. Absent when there is no
   * session at all (offline shell), so the toggle is inert rather than broken.
   */
  private presenterBroadcast(): import('../present').PresentBroadcast | undefined {
    const session = this.session
    if (!session) return undefined
    return {
      onShow: (fn) => session.onShow(fn),
      presenter: {
        start: async () => {
          await this.goLive()
          const ticket = await this.audienceTicket()
          if (!ticket) throw new Error('only the deck owner can broadcast')
          await session.startShow({
            showKey: ticket.key,
            projectOp,
            // the PROJECTED document only — the session builds a fresh
            // adopt-shaped state itself (a saved state's internals carry
            // deleted slides' notes and the whole text history)
            snapshot: () => ({ doc: projectDoc(this.store.doc, ticket).doc }),
          })
        },
        stop: () => session.endShow(),
        verbs: () => session.show,
      },
    }
  }

  // --- paste: external objects + cross-deck elements/slides ---------------------

  /** ⌘V after ⇧⌘X: move the ghosted elements to the pointer (or leave them
   *  where they are), onto the current slide — one undo step, ids kept. */
  private moveGhost() {
    const g = this.canvas.ghost!
    this.canvas.setGhost(null)
    const source = this.store.doc.slides.find((s) => s.id === g.slideId)
    const moving = source?.elements.filter((e) => g.ids.includes(e.id)) ?? [] // only what still exists
    if (!source || !moving.length) return
    const target = this.store.slide
    const at = this.canvas.pointerOnSlide()
    const dx = at ? at.x - Math.min(...moving.map((e) => e.x)) : 0
    const dy = at ? at.y - Math.min(...moving.map((e) => e.y)) : 0
    this.store.commit(() => {
      for (const el of moving) { el.x = Math.round(el.x + dx); el.y = Math.round(el.y + dy) }
      if (source === target) return
      source.elements = source.elements.filter((e) => !moving.includes(e))
      // slides share ids on purpose (morph); two on ONE slide would collide
      for (const el of moving) if (target.elements.some((e) => e.id === el.id)) el.id = uid(el.type[0])
      target.elements.push(...moving)
    })
    this.store.select(moving.map((e) => e.id))
  }

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
      if (this.canvas.ghost) { ev.preventDefault(); this.moveGhost(); return }
      const dt = ev.clipboardData
      if (!dt) return
      // 1) an image from the OS clipboard (screenshot, copied picture…)
      const imgItem = [...dt.items].find((it) => it.kind === 'file' && it.type.startsWith('image/'))
      if (imgItem) {
        const file = imgItem.getAsFile()
        if (file) { ev.preventDefault(); this.pasteImageFile(file); return }
      }
      if (this.pasteFromText(dt.getData('text/plain'))) ev.preventDefault()
    })
  }

  /**
   * Paste from a plain-text payload: Bento elements, Bento slides, or ordinary
   * text that becomes a text box. Returns whether anything was pasted.
   *
   * Split out of the paste EVENT so the context menu's Paste is the same code
   * rather than a second, drifting copy — the menu has to fetch the clipboard
   * itself (`readText`), because a click carries no clipboardData.
   */
  private pasteFromText(text: string): boolean {
    // 2) Bento elements / slides copied from this or another deck
    const clip = parseClip(text)
    if (clip?.kind === 'elements') {
      let added: SlideElement[] = []
      this.store.commit(() => { added = insertElements(clip, this.store.doc, this.store.slide) })
      this.store.select(added.map((e) => e.id))
      this.toast(added.length === 1 ? t('Pasted 1 item') : t('Pasted {n} items', { n: added.length }))
      return true
    }
    if (clip?.kind === 'slides') {
      const at = this.store.currentIndex + 1
      let made: Slide[] = []
      this.store.commit(() => { made = insertSlides(clip, this.store.doc, at) }, 'slides')
      this.rebuildSidebar()
      this.store.goTo(at)
      this.toast(made.length === 1 ? t('Pasted 1 slide') : t('Pasted {n} slides', { n: made.length }))
      return true
    }
    // 3) plain text → a text element; a ``` fenced block in it → a Code
    // element (with any text around it as text boxes above and below)
    if (text && text.trim()) {
      const { width } = this.store.doc.size
      const parts = splitFences(text.slice(0, 20000))
      if (parts.some((p) => p.kind === 'code')) {
        const src = defaultText({ html: '', color: readableInk(this.store.slide.background), x: Math.round(width / 2 - 400), y: 120, w: 800 })
        const made = fencedElements(src, parts, estimatedFrames(src, parts))
        this.store.commit(() => this.store.slide.elements.push(...made))
        this.store.select(made.map((e) => e.id))
        this.toast(made.length === 1 ? t('Pasted 1 item') : t('Pasted {n} items', { n: made.length }))
        return true
      }
      const esc = text.trim().slice(0, 4000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
      const el = defaultText({ html: esc, color: readableInk(this.store.slide.background), x: Math.round(width / 2 - 300), y: 260, w: 600 })
      this.store.commit(() => this.store.slide.elements.push(el))
      this.store.select([el.id])
      this.toast(t('Text pasted'))
      return true
    }
    return false
  }

  private pasteImageFile(file: File) {
    void this.shrinkForInsert(file).then((r) => {
      const src = r.dataUrl
      const place = (w: number, h: number) => {
        const { width, height } = this.store.doc.size
        const el = defaultImage(src, { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h, fit: 'contain' })
        // via canvas.insert, so a pasted photo is interned into doc.assets on
        // the same path as every other embed — otherwise it stays inline and
        // live collab can never send it.
        this.canvas.insert(el)
        // the shrink toast, when there is one, already says a picture landed
        if (!shrinkNote(r)) this.toast(t('Image pasted'))
      }
      const img = new Image()
      img.onload = () => {
        let w = img.naturalWidth || 400, h = img.naturalHeight || 300
        const sc = Math.min(1, 640 / w, 480 / h); place(Math.round(w * sc), Math.round(h * sc))
      }
      img.onerror = () => place(400, 300)
      img.src = src
    })
  }

  // --- derived values ----------------------------------------------------------

  private derived!: DeriveMemory
  /** Palette and token literals, component copies, frame layout, connector
   *  endpoints and stack fallbacks, re-derived on EVERY slide after any change
   *  — a palette edit changes slide 40 as much as slide 1, and a remote op or
   *  an undo can touch any slide. Derive-not-commit: every replica computes
   *  the same values from the same document, so no operation crosses the wire
   *  and nothing is an undo step (derive.ts). */
  private syncDerived() {
    if (derive(this.store.doc, this.derived)) {
      this.canvas.render()
      this.scheduleThumbs()
      // the panel rebuilt on this same doc event BEFORE the derive pass ran
      // (it subscribed first): a bound swatch showed the token's old value and
      // W/H/X/Y the boxes before layout, until the next edit
      this.panel.rebuild()
    }
  }

  /** The selection becomes a component's main (⌘⌥K). */
  createComponent() {
    const els = this.store.selectedElements
    if (!els.length || els.some((e) => e.component)) return
    const id = uid('comp')
    // named at birth, so the toast, the inspector header and the Tokens list
    // all say the same thing ("Component 3"), and the name is the user's to change
    const name = els[0].groupName || t('Component {n}', { n: components(this.store.doc).length + 1 })
    this.store.commit(() => {
      const live = els.map((e) => this.store.element(e.id)!).filter(Boolean)
      makeComponent(live, id, live[0].groupId && live.every((e) => e.groupId === live[0].groupId) ? live[0].groupId! : uid('g'))
      for (const e of live) e.groupName = name
    })
    this.toast(t('Made {name} — rename it in its header; insert copies from Tokens', { name }))
    this.showSideView('tokens')
    this.tokensPane.showComponent(id)
  }

  /** Show one of the side column's views (Slides | Layers | Tokens). */
  showSideView(view: 'slides' | 'layers' | 'tokens') {
    this.sidebar.querySelector<HTMLElement>(`.ed-side-tabs [data-view="${view}"]`)?.click()
  }

  /** The selection stops following its component; a main's copies keep their values. */
  detachComponent() {
    const ids = new Set(this.store.selectedElements.map((e) => e.id))
    this.store.commit(() => detach(this.store.slide.elements.filter((e) => ids.has(e.id))))
  }

  /**
   * Re-inject custom font bundles when applicable.
   */
  private syncFonts() {
    injectFonts(this.store.doc)
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

  // --- auto-save + crash recovery -----------------------------------------------

  private autosaveTimer = 0
  private lastVersionAt = 0
  private lastBackupAt = 0
  /** Every write to the open file's handle — ⌘S, Save a copy, auto-save and
   *  Update this file — goes through this one queue (saving.ts). Lazy: the
   *  store arrives as a constructor parameter, after field initialisers run. */
  private saveQueueInst: SaveQueue<import('../model').BentoDoc> | null = null
  private get saveQueue(): SaveQueue<import('../model').BentoDoc> {
    return this.saveQueueInst ??= createSaveQueue(this.store)
  }

  private wireAutosave() {
    if (this.store.doc.readonly) return // player file — nothing to autosave
    void pruneOld()
    void this.checkRecovery()
    this.noticeIfCannotWriteInPlace()
    this.noticeIfJustUpdated()
    this.store.on('doc', () => this.scheduleAutosave())
    onRecoveryOff((docId) => this.noticeRecoveryOff(docId))
  }

  /** Decks told, in this page, that their crash recovery is off — once each. */
  private recoveryOffSaid = new Set<string>()

  /**
   * A host with a per-document store (bento/home) refused this deck's recovery
   * copy, so from now on there is NO crash backstop for it. Say so, once, where
   * the save status shows, and stop the unsaved dot's tooltip claiming the work
   * is "kept in this browser". Never for a sealed deck (a password, or the
   * identity seal): those are never snapshotted, so there was no backstop to lose.
   */
  private noticeRecoveryOff(docId: string) {
    if (docId !== this.store.doc.docId || isBodySealed() || this.recoveryOffSaid.has(docId)) return
    this.recoveryOffSaid.add(docId)
    this.lastBackupAt = 0
    this.dirtyDot.title = canWriteInPlace()
      ? t('Unsaved changes — ⌘S saves this file in place')
      : t('Unsaved changes — ⌘S downloads an updated copy (this browser can’t rewrite the file)')
    this.flashSaved(t('Crash recovery is off for this deck — it’s too large to keep a backup copy. Save often.'), 8000)
  }

  private scheduleAutosave() {
    if (this.store.doc.readonly) return
    clearTimeout(this.autosaveTimer)
    this.autosaveTimer = window.setTimeout(() => { void this.runAutosave() }, 2500)
  }

  private async runAutosave() {
    const doc = this.store.doc
    if (doc.readonly) return
    // Never write a sealed deck's plaintext to IndexedDB (sealed = a password
    // OR the identity seal); its file write-back below stays sealed via
    // serializeAuto.
    let snapshotted = false
    if (!isBodySealed()) {
      // only true if it REALLY stored — see putRecovery; no IndexedDB (Safari
      // private browsing, some file:// contexts) must not read as "backed up"
      snapshotted = await putRecovery(doc)
      if (Date.now() - this.lastVersionAt > 120_000) { this.lastVersionAt = Date.now(); await addVersion(doc) }
    }
    // Silent file write-back once we hold a writable handle (Chrome/Edge).
    // Through the save queue: it waits behind a ⌘S already writing, writes a
    // snapshot taken as it starts, and the dot goes out only if no edit landed
    // while the bytes were on their way — the old unconditional
    // setDirty(false) here marked such an edit saved, and it never reached disk.
    if (hasFileHandle()) {
      const out = await saveRevision(this.store, this.saveQueue,
        async (snapshot) => { await writeUpdatedFile(await serializeAuto(snapshot)); return 'saved' as const },
        () => this.session?.stampInto(this.store.doc))
      if (out.kind === 'discarded') return // another deck was opened meanwhile
      if (out.kind === 'written') {
        markFileSaved() // the packs went out with those bytes too
        // "Saved" only when the dot actually went out; an edit made during the
        // write stays dirty and its own 'doc' event has already re-armed us
        if (out.current) this.flashSaved()
        return
      }
      // failed: keep dirty; the IndexedDB snapshot is the backstop
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
    // A sealed document never offers or keeps an unsealed snapshot: anything
    // stored for this docId came from an earlier session that was not sealed,
    // so it is deleted (this docId only), never shown. Boot has already set the
    // seal (a password at the gate, the identity seal before the app ran).
    if (isBodySealed()) {
      await clearRecovery(doc.docId)
      await clearVersions(doc.docId)
      return
    }
    const snap = await getRecovery(doc.docId)
    if (!snap) return
    // A snapshot is foreign input (restoregate.ts): offered only if it is a
    // document after the untrusted gate, compared as it WOULD be restored
    const gated = gateRestored(snap.json, doc)
    if (!gated) return
    if (docContentKey(gated.doc) === docContentKey(doc)) return // the file already has these edits
    this.showRecoveryBanner(snap)
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
    // While the body is sealed the deck title stays out of the tab: browsers
    // keep tab titles in their history (wintitle.ts). The open speaker window
    // follows, so adding or removing a password retitles both at once.
    document.title = titleSealed()
      ? neutralWindowTitle(file ?? null)
      : named
        ? `${this.store.doc.title} — ${file}`
        : `${this.store.doc.title} — ${appConfig().appName}`
    const sw = speakerWindow()
    if (sw) sw.document.title = speakerWindowTitle(this.store.doc.title)
    if (!this.fileChip) return
    // out of the bar only until there IS a file; after that the chip keeps its
    // slot and goes quiet when it would repeat the title (styles.css, #546)
    this.fileChip.hidden = !file
    this.fileChip.classList.toggle('ed-filechip-quiet', !named)
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
    // a file is guarded by value only — its own identity, and no key dropped,
    // since it may come from a newer Bento (restoregate.ts guardOpenedDoc)
    const neutralised = guardOpenedDoc(next)
    if (neutralised.length) console.info('[bento] opened file: neutralised', neutralised)

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

  private showRecoveryBanner(snap: Snapshot) {
    document.querySelector('.ed-recover')?.remove()
    const bar = div('ed-recover')
    const when = new Date(snap.at).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
    // The kernel's SIGNAL (recoveryLooksOlder): the snapshot is older than the
    // file now open. It only changes the words and the default — the snapshot is
    // still offered, and a false "older" (two devices' clocks) must never cost
    // work, so "Keep the file" dismisses without deleting it. When the signal is
    // false the banner is the plain one and claims nothing ("newer", "safe").
    const older = recoveryLooksOlder(snap, this.store.doc)
    const msg = document.createElement('span')
    msg.textContent = older
      ? t('This recovered copy looks older than the file you opened. Keep the file unless you know it’s newer.')
      : t('Unsaved changes from {when} were found.', { when })
    const restore = document.createElement('button')
    restore.className = older ? 'ed-btn' : 'ed-btn ed-btn-primary'
    restore.textContent = older ? t('Restore anyway') : t('Restore')
    restore.addEventListener('click', () => {
      // gated again against the document as it is NOW: the live session may
      // have been joined or rotated since the banner appeared, and the identity
      // re-attached must be the current one
      const gated = gateRestored(snap.json, this.store.doc)
      if (!gated) { bar.remove(); return }
      if (gated.dropped.length) console.info('[bento] restore: dropped', gated.dropped)
      this.store.replaceDoc(gated.doc)
      this.canvas.render()
      bar.remove()
      this.toast(t('Restored your unsaved changes'))
    })
    if (older) {
      const keep = document.createElement('button')
      keep.className = 'ed-btn ed-btn-primary'
      keep.textContent = t('Keep the file')
      keep.addEventListener('click', () => bar.remove())
      bar.append(msg, keep, restore)
      document.body.appendChild(bar)
      keep.focus() // keeping the file is the default
      return
    }
    const dismiss = document.createElement('button')
    dismiss.className = 'ed-btn'
    dismiss.textContent = t('Discard')
    dismiss.addEventListener('click', () => { void clearRecovery(this.store.doc.docId); bar.remove() })
    bar.append(msg, restore, dismiss)
    document.body.appendChild(bar)
  }

  /** Browse and restore the locally-kept auto-save timeline for this deck. */
  private async openVersionHistory() {
    // a sealed document has no timeline here (checkRecovery deleted any)
    const versions = isBodySealed() ? [] : await listVersions(this.store.doc.docId)
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
            const gated = gateRestored(v.json, this.store.doc) // foreign input, as above
            if (!gated) throw new Error('not a document')
            if (gated.dropped.length) console.info('[bento] restore: dropped', gated.dropped)
            this.store.replaceDoc(gated.doc)
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
    // A row that IS one command reads its keys from the command list
    // (commands.ts), so the sheet cannot drift from what the keys do.
    const cmd = (id: string, desc?: string): [string, string] => {
      const c = this.commands.find((x) => x.id === id)!
      return [c.keys ?? '', desc ?? t(c.label)]
    }
    section(colL, t('Editing'), [
      cmd('save'),
      [`${mod}Z · ${mod}⇧Z`, t('Undo · redo')],
      [`${mod}C · ${mod}V`, t('Copy · paste — elements, or the whole slide when nothing is selected')],
      [`${mod}⇧X`, t('Cut to move — the selection fades until you paste it in its new place; Esc cancels')],
      cmd('duplicate', t('Duplicate selection')),
      [`${mod}G · ${mod}⇧G`, t('Group · ungroup')],
      cmd('component', t('Create component — copies inserted from the Tokens view follow it')),
      [t('Tokens'), t('Name a color or number once and bind it anywhere (Colors & tokens, or a field’s dot); a mode — Dark — switches every bound value at once')],
      [`${mod}B · ${mod}I · ${mod}U`, t('Bold · italic · underline while editing text')],
      [t('Text ▸ Field'), t('Insert the page number, date, time, title or a document property; a date can pin its format — {{date:M/D/YY}}')],
      ['[ · ]', t('Collapse · expand the side panels')],
      cmd('comment'),
      cmd('help', t('This help')),
      cmd('palette', t('Command palette — search every action by name')),
    ])
    section(colL, t('Canvas'), [
      [`⇧-${t('click')}`, t('Add an element to the selection, or take it out')],
      [`${mod}-${t('click')}`, t('Select the element under the pointer, even inside a group')],
      [`${t('Alt')}-${t('click')}`, t('Select the element behind it; click again to go deeper')],
      [`${t('Alt')}-${t('hover')}`, t('Measure from the selection to the element under the pointer')],
      [t('Right-click'), t('Lists every element under the pointer, to select one that is covered')],
      [t('Double-click'), t('Rename a layer or a group in the Layers list')],
      [t('Space-drag'), t('Pan the canvas, including past the edges of the slide')],
      [t('Middle-drag'), t('Pan as well, if your mouse has a middle button')],
      [`${mod}-${t('scroll')}`, t('Zoom in and out')],
      [`${mod}+ · ${mod}− · ${mod}0`, t('Zoom in · out · fit the slide')],
      ['← · →', t('Walk the slides when nothing is selected; nudge the selection otherwise')],
      [`${mod}-${t('click')} · ⇧-${t('click')}`, t('Select several slides in the sidebar; drag any of them to move them all, Delete removes them')],
    ])
    // the one-letter tools, straight from the command list
    section(colR, t('Tools'), [
      ...['tool-select', 'tool-frame', 'tool-rect', 'tool-ellipse', 'tool-line', 'tool-pen', 'insert-text'].map((id) => cmd(id)),
      cmd('auto-layout', t('Wrap the selection in an auto-layout frame')),
      [BOOL_OPS.map((op) => boolUi(op).key).join(' · '), BOOL_OPS.map((op) => boolUi(op).label).join(' · ')],
    ])
    section(colR, t('Inspector'), [
      [t('Drag a label'), t('Scrub the number — ⇧ ×10, Alt ×0.1; the drag never stops at the screen edge')],
      ['360/2 · +24 · *2', t('Type arithmetic into a number; a leading + * / starts from its current value')],
      ['↑ · ↓', t('Step a number; ⇧ steps by 10')],
      [t('Mixed'), t('Several elements differ: an edit moves each by the same amount')],
    ])
    section(colR, t('Lines & curves'), [
      [t('Shape ▾'), t('Draw a line, curved line or connector — then drag on the canvas')],
      [t('Drag a point'), t('Move an endpoint or anchor; drag the body to move the whole line')],
      [t('Click a point'), t('Reveal its bézier handles for a precise curve')],
      [`${t('Alt')}-${t('drag')}`, t('Break a smooth point into a sharp corner')],
      [`${t('Pen')} · P`, t('Click to place corners, drag to pull out curves (Alt breaks a handle); click the first point to close, Enter or Esc to finish')],
      [t('Path bar'), t('Corner, Smooth or Symmetric for the clicked point (or every point); Close path joins the ends')],
      [t('Double-click'), t('Add a point on the line; double-click a point to remove it')],
    ])
    section(colR, t('Motion paths'), [
      [t('Animate ▸ Loop animation'), t('Choose Follow a path, then Edit path on canvas')],
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
      ['B', t('Black screen — and back')],
      ['G', t('All slides in the speaker view — pick one to jump to')],
      ['← · →', t('Previous · next slide, or the next reveal step on a slide that has them')],
      [t('Right-click ▸ Reveal in order'), t('Hide the selected elements until → is pressed, one after another in reading order — numbered badges on the canvas show the order')],
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
  private flashSaved(message = t('Saved'), holdMs = 1400) {
    const title = document.querySelector<HTMLElement>('.ed-topbar .ed-title')
    const bar = title?.parentElement
    if (!title || !bar) return
    let tag = bar.querySelector<HTMLElement>(':scope > .ed-autosaved')
    if (!tag) { tag = div('ed-autosaved'); bar.appendChild(tag) }
    tag.textContent = message
    // An overlay at the title's right end, never a slot in the bar: as a flex
    // item it shifted Undo/Redo on every auto-save and clicks landed on Redo
    // (#546). Offsets are in the bar's content coordinates, so it rides along
    // when a too-narrow bar is scrolled.
    tag.style.left = `${Math.max(title.offsetLeft, title.offsetLeft + title.offsetWidth - tag.offsetWidth - 6)}px`
    tag.style.top = `${title.offsetTop + (title.offsetHeight - tag.offsetHeight) / 2}px`
    void tag.offsetWidth // paint a frame at opacity 0 so the fade-in runs
    tag.classList.add('show')
    clearTimeout(this.savedTimer)
    this.savedTimer = window.setTimeout(() => tag!.classList.remove('show'), holdMs)
  }

  async save(forcePicker: boolean) {
    this.canvas.commitTextEdit()
    // Through the save queue (saving.ts): serialised with auto-save and
    // Update this file, written from a snapshot taken as the write starts, and
    // the dot goes out only if nothing changed while the bytes were on their
    // way. Shared decks stamp their CRDT state in the queue's prepare step, so
    // the saved copy can rejoin as a true fork later (offline edits merge both
    // ways) and a save queued behind another carries the state of its own start.
    const out = await saveRevision(this.store, this.saveQueue,
      (snapshot) => saveFile(snapshot, forcePicker),
      () => this.session?.stampInto(this.store.doc))
    if (out.kind === 'discarded' || out.kind === 'cancelled') return
    if (out.kind === 'failed') {
      console.error(out.error)
      this.toast(t('Save failed — see console'))
      return
    }
    const result = out.result
    // "Save a copy…" wrote ANOTHER file and leaves you editing this one (#705):
    // nothing about the open deck changes — not its title, file chip, ⌘S target
    // or sharing, and its unsaved dot stays (saving.ts). Saying "Saved" here, or
    // retitling to the copy, would claim the deck had become the copy.
    if ((result as string) === 'copied') {
      this.toast(t('Copy saved — you are still editing the original'))
      return
    }
    try {
      // the file name is knowable from here on — put it in the tab and the chip
      this.syncWindowTitle()
      // staged language packs are in the bytes now — stop calling them pending
      markFileSaved()
      // The save wrote everything there was, so a pending auto-save would only
      // write it again. Cancelled ONLY here, after a save that left nothing
      // unsaved: a cancelled or failed save returns above with the timer still
      // running (it is the edit's crash-recovery copy), and an edit made while
      // the bytes were on their way keeps the deck dirty and keeps its timer.
      if (!this.store.dirty) {
        clearTimeout(this.autosaveTimer)
        this.autosaveTimer = 0
      }
      this.toast(result === 'downloaded'
        ? t('This browser can’t rewrite files in place — a fresh copy went to Downloads')
        : t('Saved'))
      // Saving is the opt-in: a named, saved deck is "live by default" from
      // now on (the recipient of a copy already joins on open). Connect this
      // session too so author and recipient meet without another click.
      if (sharingOn(this.store)) {
        this.session?.enableSharing()
        this.tryJoin()
      }
      // The recovery baseline, the version checkpoint and the web note run when
      // the page is idle, so the toast and the next paint are not held behind
      // two IndexedDB writes (a large deck stalled the compositor on Wayland).
      // The seal is asked when they run, not now: a deck sealed meanwhile
      // writes nothing.
      const doc = this.store.doc
      Editor.whenIdle(() => {
        // record a recovery baseline + a version checkpoint at each manual save
        if (!isBodySealed()) { void putRecovery(doc); void addVersion(doc); this.lastVersionAt = Date.now() }
        // A save from the WEB changes what this page is: the deck now lives in a
        // file, and this URL will hand out a fresh starter next time. Said here,
        // persistently, so the next visit is not a surprise — and deliberately
        // NOT as a block, because this tab keeps working and keeps writing.
        noteSavedFromWeb(currentFileName() ?? suggestedFileName(doc), {
          fsAccess: canWriteInPlace(), canWrite: hostCan('write'),
        })
      }, 200)
    } catch (err) {
      console.error(err)
      this.toast(t('Save failed — see console'))
    }
  }

  /** Run `task` when the page is idle, and at most `timeout` ms later. */
  private static whenIdle(task: () => void, timeout: number) {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => task(), { timeout })
    else setTimeout(task, 0)
  }

  // --- keyboard ------------------------------------------------------------------

  /**
   * Every keyed action, in dispatch order (commands.ts). `inField` ones run
   * while a text field has focus; the rest wait until it does not, and not
   * while a picture is being cropped (crop mode owns Enter/Esc/Delete).
   */
  private commandList?: Command[]
  get commands(): Command[] {
    // the deck's modes come and go, so their Switch mode commands are listed fresh
    if (this.commandList) return [...this.commandList, ...this.modeCommands()]
    const sel = () => this.store.selectedElements
    const key = (ev: KeyboardEvent) => ev.key.toLowerCase()
    // Nothing modal is up: a sheet, dialog, the palette or an open menu owns the
    // keyboard while it shows, so R or ⌘Z must not reach the slide behind it.
    const canvasFree = () => !this.canvas.isCropEditing && !document.querySelector(MODAL)
    const writable = () => canvasFree() && !this.store.readOnly
    // the tools and selection verbs also wait while a path is being edited
    const toolFree = () => writable() && !this.canvas.isPathEditing
    // A letter as the keyboard's layout writes it (Dvorak's K is K); only when
    // Option turned it into a symbol (macOS: ⌥K is ˚) does the physical key
    // decide — the one case a layout cannot answer.
    // a selection the editor may align: not a frame's child (its frame places it)
    const free = () => sel().length > 0 && !sel().some((e) => e.parentId && this.store.element(e.parentId))
    const letter = (ev: KeyboardEvent, code: string) => /^[a-z]$/i.test(ev.key) ? `Key${ev.key.toUpperCase()}` === code : ev.code === code
    // a bare letter: no modifier, so ⌘R, ⇧A and ⌥⇧O stay theirs
    const tool = (k: string) => (ev: KeyboardEvent, mod: boolean) => !mod && !ev.altKey && !ev.shiftKey && key(ev) === k
    const list: Command[] = [
      { id: 'save', label: 'Save', keys: `${MOD}S`, scope: 'always', inField: true, match: (ev, mod) => mod && key(ev) === 's', run: () => this.save(false) },
      { id: 'zoom-in', label: 'Zoom in', keys: `${MOD}+`, scope: 'canvas', inField: true, match: (ev, mod) => mod && (ev.key === '=' || ev.key === '+'), run: () => this.canvas.zoomIn() },
      { id: 'zoom-out', label: 'Zoom out', keys: `${MOD}−`, scope: 'canvas', inField: true, match: (ev, mod) => mod && ev.key === '-', run: () => this.canvas.zoomOut() },
      { id: 'zoom-fit', label: 'Fit the slide', keys: `${MOD}0`, scope: 'canvas', inField: true, match: (ev, mod) => mod && ev.key === '0', run: () => this.canvas.zoomReset() },
      { id: 'present', label: 'Present', keys: 'F5', scope: 'always', inField: true, match: (ev) => ev.key === 'F5', run: (ev) => this.present(!ev?.shiftKey) },
      { id: 'palette', label: 'Command palette', keys: `${MOD}K`, scope: 'always', when: canvasFree, match: (ev, mod) => mod && !ev.altKey && key(ev) === 'k', run: () => openPalette(this.commands) },
      { id: 'help', label: 'Shortcuts & tips', keys: '?', scope: 'always', when: canvasFree, match: (ev, mod) => !mod && (ev.key === '?' || (ev.key === '/' && ev.shiftKey)), run: () => this.openHelp() },
      // The tools, one letter each as in Figma and Penpot (C stays Comment)
      { id: 'tool-select', label: 'Select', keys: 'V', scope: 'canvas', when: canvasFree, match: tool('v'), run: () => this.selectTool() },
      { id: 'tool-frame', label: 'Frame', keys: 'F', scope: 'canvas', when: toolFree, match: tool('f'), run: () => this.placeTool(() => this.newFrame()) },
      { id: 'tool-rect', label: 'Rectangle', keys: 'R', scope: 'canvas', when: toolFree, match: tool('r'), run: () => this.placeTool(() => defaultShape('rect')) },
      { id: 'tool-ellipse', label: 'Ellipse', keys: 'O', scope: 'canvas', when: toolFree, match: tool('o'), run: () => this.placeTool(() => defaultShape('ellipse')) },
      { id: 'tool-line', label: 'Line', keys: 'L', scope: 'canvas', when: toolFree, match: tool('l'), run: () => this.canvas.armDraw('line') },
      { id: 'tool-pen', label: 'Pen', keys: 'P', scope: 'canvas', when: toolFree, match: tool('p'), run: () => this.canvas.armDraw('pen') },
      { id: 'insert-text', label: 'Add a text box', keys: 'T', scope: 'canvas', when: toolFree, match: tool('t'), run: () => this.placeTool(() => defaultText({ color: readableInk(this.store.slide.background) }), true) },
      { id: 'comment', label: 'Comment mode', keys: 'C', scope: 'canvas', when: canvasFree, match: (ev, mod) => !mod && key(ev) === 'c', run: () => this.canvas.toggleCommentMode() },
      { id: 'ungroup', label: 'Ungroup', keys: `⇧${MOD}G`, scope: 'canvas', when: () => writable() && sel().some((e) => e.groupId), match: (ev, mod) => mod && ev.shiftKey && key(ev) === 'g', run: () => this.panel.ungroup(sel()) },
      { id: 'group', label: 'Group', keys: `${MOD}G`, scope: 'canvas', when: () => writable() && sel().length > 1, match: (ev, mod) => mod && !ev.shiftKey && key(ev) === 'g', run: () => this.panel.group(sel()) },
      // ⌥⇧U/S/I/E (letter(): on a Mac, Option turns the key into a symbol)
      ...BOOL_OPS.map((op): Command => ({ id: `bool-${op}`, label: boolUi(op).label, keys: boolUi(op).key, scope: 'canvas', when: () => toolFree() && !!boolOperands(this.store, sel()), match: (ev, mod) => !mod && ev.altKey && ev.shiftKey && letter(ev, boolUi(op).code), run: () => { combine(this.store, sel(), op) } })),
      // Align and space, Figma's keys: ⌥A ⌥H ⌥D across, ⌥W ⌥V ⌥S down, ⌃⌥H ⌃⌥V even gaps.
      // A frame's child is the frame's to place, so these wait for a free selection.
      ...([['align-left', 'Align left', 'A', 'left'], ['align-center', 'Align centers', 'H', 'centerX'], ['align-right', 'Align right', 'D', 'right'],
        ['align-top', 'Align top', 'W', 'top'], ['align-middle', 'Align middles', 'V', 'middleY'], ['align-bottom', 'Align bottom', 'S', 'bottom']] as const)
        .map(([id, label, k, edge]): Command => ({ id, label, keys: `⌥${k}`, scope: 'canvas', when: () => toolFree() && free(), match: (ev, mod) => !mod && ev.altKey && !ev.shiftKey && letter(ev, `Key${k}`), run: () => align(this.panel, sel(), edge) })),
      { id: 'distribute-x', label: 'Space evenly across', keys: '⌃⌥H', scope: 'canvas', when: () => toolFree() && free() && sel().length >= 3, match: (ev) => ev.ctrlKey && ev.altKey && !ev.metaKey && !ev.shiftKey && letter(ev, 'KeyH'), run: () => distribute(this.panel, sel(), 'x') },
      { id: 'distribute-y', label: 'Space evenly down', keys: '⌃⌥V', scope: 'canvas', when: () => toolFree() && free() && sel().length >= 3, match: (ev) => ev.ctrlKey && ev.altKey && !ev.metaKey && !ev.shiftKey && letter(ev, 'KeyV'), run: () => distribute(this.panel, sel(), 'y') },
      { id: 'flip-h', label: 'Flip horizontal', keys: '⇧H', scope: 'canvas', when: () => toolFree() && sel().length > 0, match: (ev, mod) => !mod && ev.shiftKey && !ev.altKey && key(ev) === 'h', run: () => flip(this.panel, sel(), 'flipX') },
      { id: 'flip-v', label: 'Flip vertical', keys: '⇧V', scope: 'canvas', when: () => toolFree() && sel().length > 0, match: (ev, mod) => !mod && ev.shiftKey && !ev.altKey && key(ev) === 'v', run: () => flip(this.panel, sel(), 'flipY') },
      { id: 'auto-layout', label: 'Add auto layout', keys: '⇧A', scope: 'canvas', when: () => toolFree() && sel().length > 0, match: (ev, mod) => !mod && ev.shiftKey && !ev.altKey && key(ev) === 'a', run: () => this.panel.addAutoLayout(sel()) },
      { id: 'component', label: 'Create component', keys: `⌥${MOD}K`, scope: 'canvas', when: () => toolFree() && sel().length > 0, match: (ev, mod) => mod && ev.altKey && letter(ev, 'KeyK'), run: () => this.createComponent() },
      // tokens and components, for ⌘K (palette only: no keys of their own)
      { id: 'component-main', label: 'Go to main component', scope: 'canvas', when: () => canvasFree() && !!selectedComponent(this.panel, sel()) && !selectedComponent(this.panel, sel())!.main, run: () => goToMain(this.panel, sel()[0].component!.id) },
      { id: 'component-reset', label: 'Reset overrides', scope: 'canvas', when: () => writable() && sel().some((e) => e.component && !e.component.main && e.component.over?.length), run: () => this.resetSelectedOverrides() },
      { id: 'component-detach', label: 'Detach component', scope: 'canvas', when: () => writable() && sel().some((e) => e.component), run: () => this.detachComponent() },
      { id: 'token-new-color', label: 'New color token', scope: 'canvas', when: writable, run: () => { this.showSideView('tokens'); this.tokensPane.newToken('color') } },
      { id: 'token-new-number', label: 'New number token', scope: 'canvas', when: writable, run: () => { this.showSideView('tokens'); this.tokensPane.newToken('number') } },
      { id: 'token-bind', label: 'Bind to token…', scope: 'canvas', when: () => writable() && sel().length > 0, run: () => this.bindToTokenMenu() },
      { id: 'tokens-show', label: 'Show tokens and components', scope: 'always', run: () => this.showSideView('tokens') },
      { id: 'redo', label: 'Redo', keys: `⇧${MOD}Z`, scope: 'always', when: canvasFree, match: (ev, mod) => mod && ((ev.shiftKey && key(ev) === 'z') || key(ev) === 'y'), run: () => this.store.redo() },
      { id: 'undo', label: 'Undo', keys: `${MOD}Z`, scope: 'always', when: canvasFree, match: (ev, mod) => mod && key(ev) === 'z', run: () => this.store.undo() },
      { id: 'duplicate', label: 'Duplicate', keys: `${MOD}D`, scope: 'canvas', when: writable, match: (ev, mod) => mod && key(ev) === 'd', run: () => this.duplicateSelection() },
      // Ghost Cut: the selection fades where it stands and ⌘V MOVES it (same
      // ids, one undo step); Esc cancels. Also copied, so pasting elsewhere
      // works as after ⌘C. Plain ⌘X is unchanged.
      { id: 'ghost-cut', label: 'Cut to move', keys: `⇧${MOD}X`, scope: 'canvas', when: writable, match: (ev, mod) => mod && ev.shiftKey && key(ev) === 'x', run: () => {
        if (!this.store.selection.length || this.store.readOnly) return
        this.copySelection()
        const ids = withDescendants(this.store.slide, this.store.selectedElements).map((e) => e.id) // a frame moves with its contents
        this.store.select([])
        this.canvas.setGhost({ slideId: this.store.slide.id, ids })
      } },
      { id: 'toggle-left', label: 'Show or hide the slide list', keys: '[', scope: 'always', when: canvasFree, match: (ev) => ev.key === '[', run: () => this.togglePanel('left') },
      { id: 'toggle-right', label: 'Show or hide the Format panel', keys: ']', scope: 'always', when: canvasFree, match: (ev) => ev.key === ']', run: () => this.togglePanel('right') },
      { id: 'next-slide', label: 'Next slide', keys: 'PageDown', scope: 'canvas', when: canvasFree, match: (ev) => ev.key === 'PageDown', run: () => this.store.goToLinear(1) },
      { id: 'prev-slide', label: 'Previous slide', keys: 'PageUp', scope: 'canvas', when: canvasFree, match: (ev) => ev.key === 'PageUp', run: () => this.store.goToLinear(-1) },
      // palette only: what the topbar inserts, and its other one-click actions
      { id: 'insert-image', when: toolFree, label: 'Add an image', scope: 'canvas', run: () => this.pickImage() },
      { id: 'insert-table', when: toolFree, label: 'Add a table', scope: 'canvas', run: () => this.canvas.insert(this.newTable()) },
      { id: 'insert-chart', when: toolFree, label: 'Add a chart', scope: 'canvas', run: () => this.canvas.insert(defaultChart(applyChartPalette(CHART_PRESETS.bar(), this.store.doc.theme))) },
      { id: 'insert-code', when: toolFree, label: 'Add a code snippet', scope: 'canvas', run: () => this.canvas.insert(defaultCode({ color: readableInk(this.store.slide.background) }), true) },
      { id: 'copy', label: 'Copy', keys: `${MOD}C`, scope: 'canvas', when: () => sel().length > 0, run: () => this.copySelection() },
      { id: 'delete', label: 'Delete', keys: '⌫', scope: 'canvas', when: () => writable() && sel().length > 0, run: () => this.deleteSelection() },
      { id: 'slideshow', label: 'Slideshow', scope: 'always', run: () => this.present(false, true) },
      { id: 'use-morph', label: 'Use Morph', scope: 'always', when: () => writable() && this.store.slide.transition !== 'morph' && !!walkSource(this.store.doc, this.store.slide), run: () => { const sl = this.store.slide; this.store.commit(() => { sl.transition = 'morph' }) } },
      // ⌘A: every top-level element on the slide (a frame's children come with
      // it) — or, with focus in the slide list, every slide
      { id: 'select-all', label: 'Select all', keys: `${MOD}A`, scope: 'canvas', when: canvasFree, match: (ev, mod) => mod && !ev.shiftKey && !ev.altKey && key(ev) === 'a', run: () => {
        if (this.thumbs.contains(document.activeElement)) { this.setThumbSel(this.store.doc.slides.map((sl, i) => (sl.stateOf ? -1 : i)).filter((i) => i >= 0)); return }
        const ids = new Set(this.store.slide.elements.map((e) => e.id))
        this.store.select(this.store.slide.elements.filter((e) => !e.locked && !e.hidden && !(e.parentId && ids.has(e.parentId))).map((e) => e.id))
      } },
      { id: 'select-parent', label: 'Select parent', keys: 'Esc', scope: 'canvas', when: () => canvasFree() && sel().length > 0 && sel().every((e) => !!e.parentId && !!this.store.element(e.parentId)), run: () => this.store.select([...new Set(sel().map((e) => e.parentId!))]) },
      { id: 'play-transition', label: 'Play transition', scope: 'always', when: () => !!walkSource(this.store.doc, this.store.slide), run: () => this.playTransition() },
      { id: 'export-pdf', label: 'Export PDF (print)', scope: 'always', run: () => this.exportPdf() },
      { id: 'speaker', label: 'Speaker view', scope: 'always', run: () => this.openSpeakerView() },
      { id: 'about', label: 'About bento/slides', scope: 'always', run: () => this.openAbout() },
    ]
    this.commandList = list
    return [...list, ...this.modeCommands()]
  }

  /** One Switch mode command per mode the deck has, but the active one. */
  private modeCommands(): Command[] {
    const tk = this.store.doc.theme.tokens
    if (!tk || modesOf(tk).length < 2) return []
    return modesOf(tk).filter((m) => m !== activeMode(tk)).map((m): Command => ({
      id: `mode-${m}`, label: t('Switch mode → {mode}', { mode: m === 'default' ? t('Default') : m }), scope: 'canvas',
      when: () => !this.store.readOnly, run: () => this.tokensPane.switchMode(m),
    }))
  }


  private wireKeyboard() {
    document.addEventListener('keydown', (ev) => {
      if (this.presenting) return
      const mod = ev.metaKey || ev.ctrlKey
      // a number field hands ⌘Z/⇧⌘Z back to the document (controls.ts numeric)
      const numUndo = mod && /^[zy]$/i.test(ev.key) && ev.target instanceof Element && !!ev.target.closest('.ed-num')
      const inField =
        ev.target instanceof Element && !numUndo &&
        // a colour swatch opens the popover — a button, not a field for typing
        ev.target.closest('input:not([type=color]), textarea, select, [contenteditable="true"]') != null

      // A key typed at a selected text box is text, as in PowerPoint and Keynote:
      // it opens the box with the character. Before the command list, so the R
      // of "Revenue" is never the rectangle tool; a shifted key a command claims
      // (⇧A, ?) stays the command's.
      if (!inField && this.typeIntoText(ev)) return
      if (dispatch(this.commands, ev, inField)) return
      if (inField) return
      // Crop mode owns the keyboard: Enter/Esc are its (cropedit.ts), and a
      // Delete meant for the picture being cropped must not remove it.
      if (this.canvas.isCropEditing) return

      if (mod && ev.key.toLowerCase() === 'c') {
        this.canvas.ghost = null // a fresh copy is what ⌘V should paste now
        // Copy to BOTH the in-app clipboard (fast, same session) and the system
        // clipboard as a Bento payload (works across decks/tabs). Elements when
        // any are selected; otherwise the current slide.
        if (this.store.selection.length) {
          void navigator.clipboard?.writeText?.(serializeElements(withDescendants(this.store.slide, this.store.selectedElements), this.store.doc)).catch(() => {})
        } else {
          const slides = this.selectedSlides()
          void navigator.clipboard?.writeText?.(serializeSlides(slides, this.store.doc)).catch(() => {})
          if (slides.length > 1) {
            this.toast(t('Slides copied — ⌘V in any deck to paste them'))
          } else {
            this.toast(t('Slide copied — ⌘V in any deck to paste it'))
          }
        }
        return
      }
      // ⌘V is handled by the document 'paste' listener (wirePaste) so it can
      // also receive images and cross-deck payloads.
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (this.store.selection.length) {
          ev.preventDefault()
          this.deleteSelection()
        } else if (this.thumbSel.length > 1 && !inField) {
          // a sidebar multi-selection and nothing on the canvas: Delete means the slides
          ev.preventDefault()
          this.deleteSlides(this.thumbSel)
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
        // inside an auto-layout frame an arrow moves the child one slot along
        // the flow (a grid's ↑/↓ a whole row), as Figma does — the layout would
        // undo a nudge anyway
        const one = this.store.selectedElements.length === 1 ? this.store.selectedElements[0] : null
        const frame = one?.parentId ? this.store.element(one.parentId) : undefined
        if (one && isFrame(frame) && !one.locked) {
          const L = frame.layout
          const along = L.dir === 'col' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']
          const across = L.dir === 'grid' ? ['ArrowUp', 'ArrowDown'] : []
          const by = along.includes(ev.key) ? (ev.key === along[0] ? -1 : 1) : across.includes(ev.key) ? (ev.key === 'ArrowUp' ? -1 : 1) * (L.cols ?? 2) : 0
          if (by) {
            const sibs = frameChildren(this.store.slide, frame)
            const to = sibs.findIndex((e) => e.id === one.id) + by
            const slide = this.store.slide
            // at either end there is nowhere to go, and no undo step to record
            if (to >= 0 && to < sibs.length) this.store.commit(() => { moveInFrame(slide, one.id, to) })
          }
          return
        }
        const step = ev.shiftKey ? 10 : 1
        const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0
        const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0
        this.store.commit(() => {
          for (const el of this.store.selectedElements) {
            if (el.locked) continue
            el.x += dx
            el.y += dy
          }
        })
        return
      }
      if (ev.key === 'Escape') {
        if (this.canvas.ghost) { this.canvas.setGhost(null); return }
        if (this.thumbSel.length) this.setThumbSel([])
        if (this.canvas.isDrawing) this.canvas.cancelDraw()
        else if (this.canvas.isPathEditing) this.canvas.stopPathEdit(true)
        else {
          // out one level first, as in Figma: a frame's children → the frame
          const sel = this.store.selectedElements
          const up = sel[0]?.parentId
          this.store.select(up && sel.every((e) => e.parentId === up) && this.store.element(up) ? [up] : [])
        }
        return
      }
    })
  }

  /** Open the one selected text box with the key just typed: it replaces the
   *  words the edit selects on opening, or fills an empty placeholder. */
  private typeIntoText(ev: KeyboardEvent): boolean {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.isComposing || [...ev.key].length !== 1) return false
    const sel = this.store.selectedElements
    if (sel.length !== 1 || sel[0].type !== 'text' || sel[0].locked || this.store.readOnly) return false
    if (document.querySelector(MODAL) || this.canvas.isCropEditing || this.canvas.isPathEditing) return false
    if (ev.shiftKey && this.commands.some((c) => c.match?.(ev, false))) return false
    ev.preventDefault()
    this.canvas.editElement(sel[0].id)
    if (!this.canvas.isEditingText) return true
    document.execCommand('insertText', false, ev.key)
    return true
  }

  /** V: back to the plain pointer — an armed draw tool, the comment tool
   *  and a motion-path edit all stand down. */
  private selectTool() {
    if (this.canvas.isDrawing) this.canvas.cancelDraw()
    if (this.canvas.isCommenting) this.canvas.toggleCommentMode()
    if (this.canvas.isPathEditing) this.canvas.stopPathEdit(true)
  }

  /** F: an empty auto-layout frame (a rect carrying `layout`, layout.ts) —
   *  whatever is later given it as a child lines up inside. */
  private newFrame(): SlideElement {
    return defaultShape('rect', {
      fill: '#FFFFFF', stroke: '#D0D5DD', strokeWidth: 1, radius: 8,
      layout: { dir: 'row', gap: 16, pad: [16, 16, 16, 16] },
    })
  }

  /** R, O, F, T: with an auto-layout frame selected the new element goes
   *  straight into it (the frame places it); otherwise the tool arms, and a
   *  click or a drag on the slide puts it down. */
  private placeTool(make: () => SlideElement, edit = false) {
    const sel = this.store.selectedElements
    const f = sel.length === 1 && sel[0].type === 'shape' && sel[0].layout ? sel[0] : null
    if (f) {
      const el = make()
      el.parentId = f.id
      this.canvas.insert(el, edit)
      return
    }
    this.canvas.armPlace(make, edit)
  }

  private duplicateSelection() {
    const picked = this.store.selectedElements
    if (!picked.length) return
    const els = withDescendants(this.store.slide, picked)
    const clones = freshGroups(els.map((el) => cloneElement(el)), els)
    adoptComponents(clones, this.store.doc)
    this.store.commit(() => this.store.slide.elements.push(...clones))
    // the copies of what was picked; their contents ride along unselected
    const top = new Set(picked.map((e) => els.indexOf(e)))
    this.store.select(clones.filter((_, i) => top.has(i)).map((c) => c.id))
  }

  /** Remove the selected elements. Shared by ⌫ and the context menu. */
  /** Delete the selection. A main with copies asks first, and its first copy
   *  becomes the main, so the copies keep following something (one undo step).
   *  `cut` (⌘X, to paste elsewhere) moves a main rather than losing it: no question. */
  private deleteSelection(cut = false) {
    if (!this.store.selection.length) return
    const ids = new Set(withDescendants(this.store.slide, this.store.selectedElements).map((e) => e.id))
    const lost = cut ? [] : mainsLost(this.store.doc, ids)
    if (lost.length && !confirm(t('Delete the main of “{name}”? Its copies keep their look, and the first one becomes the new main.', { name: lost[0].name || t('Component') }))) return
    this.store.commit(() => {
      this.store.slide.elements = this.store.slide.elements.filter((e) => !ids.has(e.id))
      for (const c of lost) promoteCopy(this.store.doc, c.id)
    })
    this.store.select([])
  }

  /** Selected slides + parents in deck order. */
  private selectedSlides(): Slide[] {
    if (this.thumbSel.length) {
      // Ideally we use `expand` but paste is not `unit` aware at the moment.
      // Should really be done as a follow up.
      const indexes = selParents(this.store.doc.slides, this.thumbSel)
      const selected = []
      for (const i of indexes) {
        const slide = this.store.doc.slides[i]
        if (slide) {
          selected.push(slide)
        }
      }
      if (selected.length > 0) {
        return selected
      }
    }
    // Fallback to the slide that was selected.
    return [this.store.slide]
  }

  /** Put the selection (or, with nothing selected, the slides) on the system
   *  clipboard as a Bento payload. Shared by ⌘C and the context menu. */
  private copySelection() {
    const text = this.store.selection.length
      ? serializeElements(withDescendants(this.store.slide, this.store.selectedElements), this.store.doc)
      : serializeSlides(this.selectedSlides(), this.store.doc)
    void navigator.clipboard?.writeText?.(text).catch(() => {})
  }

  // --- context menu -------------------------------------------------------


  private wireContextMenu() {
    // A right-click COMMITS a live text edit — the press blurs the caret —
    // and it does so BEFORE `contextmenu` is dispatched, so asking the canvas
    // then always hears "not editing". The press is the last honest moment.
    // Geometry, not DOM containment: Moveable's control box sits ON TOP of the
    // text being edited, so a press aimed squarely at the caret is delivered to
    // a resize handle and `node.contains(target)` answers false.
    let pressInsideEdit = false
    document.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 2) return
      const node = this.canvas.editingNode
      if (!node) { pressInsideEdit = false; return }
      const r = node.getBoundingClientRect()
      pressInsideEdit =
        ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom
    }, true)

    document.addEventListener('contextmenu', (ev) => {
      const target = ev.target as HTMLElement | null
      if (pressInsideEdit) return
      if (this.openContextMenuAt(target, ev.clientX, ev.clientY)) ev.preventDefault()
    })

    this.wireLongPress()
  }

  /**
   * Open the right menu for whatever is at (x, y), or return false to say "not
   * mine" — which is how the browser's own menu survives wherever it is the
   * better one: form fields, links, and text mid-edit, where the system
   * carries spelling, dictation, look-up and a real paste.
   *
   * Shared by the right-click and the long press, so the two can never drift.
   */
  private openContextMenuAt(target: HTMLElement | null, x: number, y: number): boolean {
    if (!target?.closest) return false
    if (target.closest('input, textarea, a, [contenteditable="true"]')) return false
    if (this.store.readOnly || this.presenting) return false

    const thumb = target.closest<HTMLElement>('.ed-sidebar .ed-thumb')
    if (thumb) {
      openCtxMenu(x, y, this.slideMenuItems(Number(thumb.dataset.index), thumb))
      return true
    }
    // a layer row: the canvas's own element menu (Group, Ungroup, order,
    // delete…), on that row's element — or, on a group's row, the group
    const layer = target.closest<HTMLElement>('.ed-side-layers .ed-layer')
    if (layer) {
      const gid = layer.dataset.group
      const ids = gid ? this.store.slide.elements.filter((e) => e.groupId === gid).map((e) => e.id) : [layer.dataset.id!]
      if (!ids.every((id) => this.store.selection.includes(id))) this.store.select(ids)
      openCtxMenu(x, y, this.elementMenuItems())
      return true
    }
    if (!target.closest('.ed-scroll')) return false // not the canvas — leave it alone
    const stack = this.canvas.elementsAt(x, y)
    const id = stack[0]
    if (!id) {
      openCtxMenu(x, y, this.canvasMenuItems())
      return true
    }
    // Aiming outside the selection moves it there first — the rule every editor
    // follows, and the only way the menu's verbs can be honest about what they
    // will act on.
    if (!this.store.selection.includes(id)) this.store.select([id])
    openCtxMenu(x, y, [...this.layerPickItems(stack), ...this.elementMenuItems()])
    return true
  }

  /** With more than one element under the pointer, the menu opens with the
   *  whole stack, topmost first — the way to reach something buried, without
   *  knowing a modifier. Labels are the layers panel's own. */
  private layerPickItems(stack: string[]): CtxItem[] {
    if (stack.length < 2) return []
    const rows: CtxItem[] = []
    for (const id of stack.slice(0, 8)) { // ponytail: capped; a deeper stack is the layers panel's job
      const el = this.store.element(id)
      if (!el) continue
      const on = this.store.selection.length === 1 && this.store.selection[0] === id
      rows.push({ label: t('Select {name}', { name: labelIn(this.store.slide, el, t) }), hint: on ? '✓' : undefined, run: () => this.store.select([id]) })
    }
    return [...rows, 'sep']
  }

  /**
   * Touch: a press held in place IS the right-click.
   *
   * It has to be recognised by hand. iOS fires no `contextmenu` event for an
   * ordinary element — a long press there raises the system callout, not a
   * menu — so without this the whole feature above is mouse-only, and a phone
   * keeps having no way to reach Duplicate, Delete, Group or the z-order.
   *
   * Cancelled by movement (that press was a drag or a pan) and by an early
   * lift (that was a tap). Both matter: this listener sits on the same surface
   * Moveable drags elements on, and stealing a drag would be worse than having
   * no menu at all.
   */
  private wireLongPress() {
    // TOUCH events, not pointer events. A pointer handler runs for a mouse too
    // and has to filter itself back out by pointerType; cancelling the touchend
    // then stops the browser SYNTHESIZING the tap that ends the press, instead
    // of racing it with a listener that swallows mouse events after the fact.
    // Same reasoning as the tap-to-edit recogniser in canvas.ts.
    let press: { x: number; y: number; target: HTMLElement; timer: number; opened: boolean } | null = null
    const cancel = () => {
      if (!press) return
      clearTimeout(press.timer)
      press = null
    }
    this.root.addEventListener('touchstart', (ev) => {
      cancel()
      // a second finger is a pinch or a two-finger pan, never a press
      if (ev.touches.length !== 1) return
      const t = ev.touches[0]
      const target = ev.target as HTMLElement | null
      if (!target) return
      const x = t.clientX
      const y = t.clientY
      const p: NonNullable<typeof press> = {
        x, y, target, opened: false,
        timer: window.setTimeout(() => {
          // The element under the finger can have changed while the finger was
          // down (a remote edit, a re-render), so the target is re-read here.
          const at = (document.elementFromPoint(x, y) as HTMLElement | null) ?? target
          p.opened = this.openContextMenuAt(at, x, y)
        }, LONG_PRESS_MS),
      }
      press = p
    }, true)
    this.root.addEventListener('touchmove', (ev) => {
      const t = ev.touches[0]
      if (press && t && Math.hypot(t.clientX - press.x, t.clientY - press.y) > LONG_PRESS_SLOP) cancel()
    }, true)
    // non-passive: this is the listener that has to be able to cancel
    this.root.addEventListener('touchend', (ev) => {
      const p = press
      cancel()
      // The lift would otherwise be replayed as a click ON the menu that just
      // appeared under the finger, and the row beneath it would fire itself.
      if (p?.opened && ev.cancelable) ev.preventDefault()
    }, { passive: false })
    this.root.addEventListener('touchcancel', cancel, true)
  }

  /** A topbar button that runs a command: its tooltip and its letter badge
   *  are the command's (commands.ts), and data-cmd names it. */
  private cmdButton(id: string, icon: string, label: string, tip?: string): HTMLElement {
    const c = this.commands.find((x) => x.id === id)!
    const b = btn(icon, label, () => c.run(), titleFor(this.commands, id, tip))
    b.dataset.cmd = id
    if (c.keys && /^[A-Z]$/.test(c.keys)) {
      const k = document.createElement('kbd')
      k.className = 'ed-tool-key'
      k.textContent = c.keys
      k.setAttribute('aria-hidden', 'true') // the tooltip and aria name carry it
      b.appendChild(k)
    }
    if (!label) b.setAttribute('aria-label', tip ?? t(c.label))
    return b
  }

  /** Penpot's path bar: while one path shape is selected, its node type
   *  (on the selected anchor, or every anchor) and whether it is closed. */
  private pathBar(): HTMLElement {
    const bar = div('ed-pathbar')
    bar.setAttribute('role', 'group')
    bar.setAttribute('aria-label', t('Path'))
    const one = () => {
      const els = this.store.selectedElements
      return els.length === 1 && els[0].type === 'shape' && els[0].shape === 'path' ? els[0] : null
    }
    const kinds: Array<[NodeKind, string, string]> = [
      ['corner', ICONS.nodeCorner, t('Corner — sharp, no handles')],
      ['smooth', ICONS.nodeSmooth, t('Smooth — handles in line')],
      ['symmetric', ICONS.nodeSymmetric, t('Symmetric — handles in line and the same length')],
    ]
    const pills = kinds.map(([kind, icon, tip]) => {
      const b = btn(icon, '', () => { const el = one(); if (el) this.canvas.curves.setKind(el.id, kind) }, `${tip} — ${t('the selected point, or every point')}`)
      b.dataset.node = kind
      b.setAttribute('aria-label', tip)
      return b
    })
    const close = btn(ICONS.closePath, t('Close path'), () => { const el = one(); if (el) this.canvas.curves.toggleClosed(el.id) },
      t('Close the path — join its last point to the first; again to open it'))
    close.dataset.node = 'close'
    bar.append(...pills, close)
    const sync = () => {
      // build() runs before the canvas exists: until then there is no path to edit
      const curves = this.canvas?.curves
      const el = this.store.readOnly || !curves ? null : one()
      bar.hidden = !el
      if (!el || !curves) return
      curves.onSelect = sync
      const st = curves.pathState(el.id)
      for (const b of pills) b.setAttribute('aria-pressed', String(st?.kind === b.dataset.node))
      close.setAttribute('aria-pressed', String(!!st?.closed))
    }
    sync()
    // after the canvas has re-attached its editor for the new selection
    const later = () => requestAnimationFrame(sync)
    for (const e of ['selection', 'doc', 'current'] as const) {
      const off = this.store.on(e, later)
      this.buildScope.signal.addEventListener('abort', off)
    }
    return bar
  }

  /** A command's keys as the chrome prints them (commands.ts is the one source). */
  /** The element menu's component rows: make one, or — on a member — reach its
   *  main, reset a copy's local edits, and detach (a part of a main is removed). */
  private componentMenu(els: SlideElement[]): CtxItem[] {
    const c = selectedComponent(this.panel, els)
    if (!els.some((e) => e.component)) return [{ label: t('Create component'), hint: this.keysOf('component'), cmd: 'component', disabled: !els.length, run: () => this.createComponent() }]
    return [
      ...(c && !c.main ? [{ label: t('Go to main component'), cmd: 'component-main', run: () => goToMain(this.panel, c.info.id) }] : []),
      ...(c && !c.main && els.some((e) => e.component?.over?.length) ? [{ label: t('Reset overrides'), cmd: 'component-reset', run: () => this.resetSelectedOverrides() }] : []),
      { label: c?.main && !c.whole ? t('Remove from component') : t('Detach component'), cmd: 'component-detach', run: () => this.detachComponent() },
    ]
  }

  private resetSelectedOverrides() {
    const ids = new Set(this.store.selection)
    this.store.commit(() => resetOverrides(this.store.slide.elements.filter((e) => ids.has(e.id))))
  }

  /** ⌘K's Bind to token…: the selection's main colour (a shape's fill, a text's
   *  colour) to one of the deck's colour tokens, from a menu at the canvas centre. */
  private bindToTokenMenu() {
    const els = this.store.selectedElements
    const set = this.store.doc.theme.tokens?.set ?? {}
    const names = Object.keys(set).filter((n) => set[n].type === 'color')
    if (!els.length || !names.length) { this.toast(names.length ? t('Select an element first') : t('Make a color token in the Tokens view first')); return }
    const r = (document.querySelector('.ed-scroll') ?? document.body).getBoundingClientRect()
    openCtxMenu(r.left + r.width / 2, r.top + r.height / 3, names.map((n) => ({
      label: n,
      run: () => this.store.commit(() => {
        for (const e of els) {
          const el = this.store.element(e.id)
          if (el) bindToken(this.store.doc, el as never, el.type === 'text' || el.type === 'code' ? 'color' : 'fill', n)
        }
      }),
    })))
  }

  private keysOf(id: string): string | undefined {
    return this.commands.find((c) => c.id === id)?.keys
  }

  private elementMenuItems(): CtxItem[] {
    const els = this.store.selectedElements
    const one = els.length === 1 ? els[0] : null
    const openable = !!one && (one.type === 'text' || one.type === 'table')
    const grouped = els.some((e) => e.groupId)
    const gid = els[0]?.groupId
    const wholeGroup = els.length > 1 && gid && els.every((e) => e.groupId === gid) &&
      this.store.slide.elements.filter((e) => e.groupId === gid).length === els.length ? gid : undefined
    return [
      { label: t('Edit text'), disabled: !openable, run: () => one && this.canvas.editElement(one.id) },
      // naming happens in the layer list, so Rename shows it first; a whole
      // group selected renames the group
      { label: t('Rename'), disabled: this.store.readOnly || (!one && !wholeGroup), run: () => {
        this.sidebar.querySelector<HTMLElement>('.ed-side-tabs [data-view="layers"]')?.click()
        if (one) this.panel.layers.rename(one.id)
        else if (wholeGroup) this.panel.layers.renameGroup(wholeGroup)
      } },
      'sep',
      { label: t('Cut'), hint: '⌘X', run: () => { this.copySelection(); this.deleteSelection(true) } },
      { label: t('Copy'), hint: this.keysOf('copy'), cmd: 'copy', run: () => this.copySelection() },
      { label: t('Duplicate'), hint: this.keysOf('duplicate'), cmd: 'duplicate', run: () => this.duplicateSelection() },
      'sep',
      { label: t('Bring to front'), run: () => this.panel.reorder(els, 'front') },
      { label: t('Send to back'), run: () => this.panel.reorder(els, 'back') },
      'sep',
      grouped
        ? { label: t('Ungroup'), hint: this.keysOf('ungroup'), cmd: 'ungroup', run: () => this.panel.ungroup(els) }
        : { label: t('Group'), hint: this.keysOf('group'), cmd: 'group', disabled: els.length < 2, run: () => this.panel.group(els) },
      { label: t('Add auto layout'), hint: this.keysOf('auto-layout'), cmd: 'auto-layout', disabled: !els.length, run: () => this.panel.addAutoLayout(els) },
      ...this.componentMenu(els),
      ...(boolOperands(this.store, els)
        ? ['sep' as const, ...BOOL_OPS.map((op) => {
          const ui = boolUi(op)
          return { label: ui.label, hint: ui.key, cmd: `bool-${op}`, run: () => { combine(this.store, els, op) } }
        })]
        : []),
      ...(one?.type === 'shape' && one.bool
        ? ['sep' as const,
          { label: t('Flatten'), run: () => flatten(this.store, one as ShapeElement) },
          { label: t('Release shapes'), run: () => release(this.store, one as ShapeElement) }]
        : []),
      'sep',
      // Reveal (fx.step) from the menu — the one place a user who has never
      // opened the Presenting section will find it. In order = reading order.
      { label: t('Reveal in order'), run: () => this.panel.revealInOrder(els) },
      { label: t('Reveal together'), run: () => this.panel.revealTogether(els) },
      { label: t('Remove reveal'), disabled: !els.some((e) => stepOf(e) > 0), run: () => this.panel.removeReveal(els) },
      'sep',
      { label: t('Delete'), hint: this.keysOf('delete'), cmd: 'delete', danger: true, run: () => this.deleteSelection() },
    ]
  }

  /** The slide background: the verbs here act on the SLIDE, which is the thing
   *  that was actually right-clicked. */
  private canvasMenuItems(): CtxItem[] {
    const i = this.store.currentIndex
    return [
      { label: t('Paste'), hint: '⌘V', run: () => void this.pasteFromClipboard() },
      'sep',
      { label: t('Duplicate slide'), run: () => this.duplicateSlide(i) },
      { label: t('Delete slide'), danger: true, run: () => this.deleteSlide(i) },
    ]
  }

  private slideMenuItems(i: number, thumb: HTMLElement): CtxItem[] {
    return [
      { label: t('New slide'), run: () => this.openLayoutPicker(thumb, { kind: 'insert', at: i + 1 }) },
      { label: t('Duplicate slide'), run: () => this.duplicateSlide(i) },
      'sep',
      { label: t('Delete slide'), danger: true, run: () => this.deleteSlide(i) },
    ]
  }

  /** Menu Paste. A click carries no clipboardData, so the text has to be
   *  fetched — and asking can be refused (Safari prompts, Firefox has no
   *  readText at all), which is a real answer and not an error to swallow. */
  private async pasteFromClipboard() {
    let text = ''
    try {
      text = (await navigator.clipboard?.readText?.()) ?? ''
    } catch {
      text = ''
    }
    if (!text || !this.pasteFromText(text)) this.toast(t('Nothing to paste — use ⌘V'))
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
      sandboxed()
        ? t('Updates are not checked inside an embedded view — open the file in a browser tab to check.')
        : this.lastAutoCheck?.status === 'current'
        ? t("Checked automatically at launch — you're on the latest version (v{v}).", { v: APP_VERSION })
        : this.lastAutoCheck?.status === 'error'
          ? t("Launch check couldn't reach the release server ({m}). Check manually below.", { m: this.lastAutoCheck.message })
          : t('This file carries its own app — it works offline, forever, as is.')

    const row = div('ed-about-row')
    const checkB = document.createElement('button')
    checkB.className = 'ed-btn'
    checkB.textContent = t('Check for updates')
    checkB.disabled = sandboxed() // nothing to check from inside an embedded view
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
        const done = (outcome: InPlaceOutcome & { current: boolean }) => {
          status.textContent = ''
          const after = div('ed-about-update')
          status.appendChild(after)
          const ok = div('ed-about-new')
          ok.textContent = t('Updated to v{v} on disk.', { v: release.version })
          after.appendChild(ok)
          const note = div('ed-about-notes')
          // Say where the rollback actually went. It lands beside the document
          // with a host installed and in the downloads folder without one, and
          // a backup nobody can find is not much of a backup.
          note.textContent = outcome.backup === 'beside'
            ? t('This window is still running v{v} — reload to finish. A v{v} backup was saved beside this file.', { v: APP_VERSION })
            : outcome.backup === 'downloaded'
              ? t('This window is still running v{v} — reload to finish. A v{v} backup was downloaded.', { v: APP_VERSION })
              : t("This window is still running v{v}. If you overwrote the file that's open here, reload; otherwise open the file you saved.", { v: APP_VERSION })
          after.appendChild(note)
          const reloadB = document.createElement('button')
          reloadB.className = 'ed-btn ed-btn-primary'
          reloadB.textContent = t('Reload into new version')
          reloadB.addEventListener('click', () => {
            // The disk holds the deck as it was when the update was WRITTEN.
            // Only then is the dot honest to clear; an edit made since stays
            // dirty, so the page's unload guard still asks before it is lost.
            if (outcome.current) this.store.setDirty(false)
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
          // the same handle ⌘S and auto-save write, so the same queue: it never
          // overlaps them, and it writes the snapshot taken as it starts
          const out = await saveRevision(this.store, this.saveQueue,
            async (snapshot) => (await applyUpdateInPlace(release, snapshot)) ?? 'cancelled',
            () => this.session?.stampInto(this.store.doc))
          if (out.kind === 'written') done({ ...out.result, current: out.current })
          else if (out.kind === 'failed') fail(out.error)
          else { inPlaceB.disabled = false; inPlaceB.textContent = t('Update this file…') }
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

    // Appearance — a VIEWER preference, so it sits with the others (language,
    // auto-update) rather than anywhere near the document's own settings.
    // "Auto" is first and is the default: most people want their machine's
    // choice, and the explicit options exist for the ones who do not.
    const themeRow = document.createElement('div')
    themeRow.className = 'ed-about-auto'
    const themeCap = document.createElement('span')
    themeCap.textContent = t('Appearance')
    themeCap.id = 'ed-about-theme'
    const themeSel = segmented([...THEME_CHOICES], themeChoice(), (v) => setTheme(v as never), { auto: t('Match my system'), light: t('Light mode'), dark: t('Dark mode') },
    { auto: ICONS.window, light: ICONS.sun, dark: ICONS.moon })
    themeSel.setAttribute('aria-labelledby', themeCap.id)
    themeRow.append(themeCap, themeSel)
    box.appendChild(themeRow)

    const autoRow = document.createElement('label')
    autoRow.className = 'ed-about-auto'
    const autoCb = document.createElement('input')
    autoCb.type = 'checkbox'
    autoCb.checked = autoCheckEnabled()
    autoCb.addEventListener('change', () => setAutoCheck(autoCb.checked))
    autoRow.append(autoCb, document.createTextNode(' ' + t('Check for updates automatically at launch')))
    box.appendChild(autoRow)

    // photos shrink at insert (editor/shrink.ts) — an authoring preference for
    // this browser, like the update check; never in the document
    const shrinkRow = document.createElement('label')
    shrinkRow.className = 'ed-about-auto'
    const shrinkCb = document.createElement('input')
    shrinkCb.type = 'checkbox'
    shrinkCb.checked = shrinkEnabled()
    shrinkCb.addEventListener('change', () => setShrinkEnabled(shrinkCb.checked))
    shrinkRow.append(shrinkCb, document.createTextNode(' ' + t('Shrink photos on insert (2560 px, screenshots and logos stay sharp)')))
    shrinkRow.title = t('A pasted phone photo is stored at slide resolution instead of full size. Off: pictures are stored exactly as they come.')
    box.appendChild(shrinkRow)

    // the explicit pass over pictures already in the deck (editor/compressdeck.ts):
    // dry run → the real numbers in a confirmation → one undo step
    const compressRow = document.createElement('div')
    compressRow.className = 'ed-about-auto'
    const compressBtn = document.createElement('button')
    compressBtn.className = 'ed-btn'
    compressBtn.textContent = t('Compress pictures in this deck…')
    compressBtn.title = t('Re-encodes every photo already in the deck at up to 2560 px; screenshots and logos stay sharp. Undo restores them until you save.')
    const compressNote = document.createElement('span')
    compressNote.className = 'ed-hint'
    compressBtn.addEventListener('click', () => { void this.compressDeckPictures(compressBtn, compressNote, overlay) })
    compressRow.append(compressBtn, compressNote)
    box.appendChild(compressRow)

    // the hard no-network switch: blocks update checks AND online
    // collaboration for this browser. Same-machine tab sync is not
    // networking and stays on.
    const offRow = document.createElement('label')
    offRow.className = 'ed-about-auto'
    const offCb = document.createElement('input')
    offCb.type = 'checkbox'
    offCb.checked = offlineEnabled()
    offCb.addEventListener('change', () => {
      // setOffline reports whether the preference PERSISTED. It holds for this
      // session either way (net.ts keeps it in memory), but a switch that
      // silently forgets itself on reload has to say so — it used to show
      // "on" over a setting that had never been stored.
      const stuck = setOffline(offCb.checked)
      if (offCb.checked) {
        if (this.session) disconnectOnline(this.session)
      } else {
        this.tryJoin() // re-enabling network re-connects only if share-eligible
      }
      this.wireOnlineStatus()
      this.toast(
        !stuck
          ? t('Offline mode is on for this tab, but could not be saved — this browser is blocking site data, so it will not survive a reload')
          : offCb.checked
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

  /** About ▸ Compress pictures in this deck…: every picture runs through the
   *  insert-time shrink rules; the confirmation states the measured total; one
   *  store commit applies it. Nothing is written until Compress is clicked. */
  private async compressDeckPictures(btn: HTMLButtonElement, note: HTMLElement, aboutOverlay: HTMLElement) {
    if (this.store.readOnly) return
    btn.disabled = true
    const doc = this.store.doc
    let run: DryRun
    try {
      run = await dryRun(doc, (done, total) => { note.textContent = t('{done} of {total}…', { done: String(done), total: String(total) }) })
    } finally {
      btn.disabled = false
      note.textContent = ''
    }
    if (!run.shrunk.length) {
      this.toast(run.examined ? t('Every picture is already as small as it gets') : t('This deck has no pictures to compress'))
      return
    }
    const n = run.shrunk.length
    const pct = Math.round((1 - run.after / run.before) * 100)
    const body = document.createElement('div')
    const sum = document.createElement('p')
    sum.textContent = t('{n} pictures · {before} → {after} (−{pct}%)', { n: String(n), before: fmtBytes(run.before), after: fmtBytes(run.after), pct: String(pct) })
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.textContent = t('Graphics and logos stay lossless; photos are re-encoded at up to 2560 px. ⌘Z undoes it until you save.')
    body.append(sum, hint)
    const cancel = document.createElement('button')
    cancel.className = 'ed-btn'
    cancel.textContent = t('Cancel')
    const go = document.createElement('button')
    go.className = 'ed-btn ed-primary'
    go.textContent = t('Compress')
    const dlg = createDialog({ title: t('Compress pictures in this deck'), content: body, actions: [cancel, go] })
    cancel.addEventListener('click', () => dlg.close())
    go.addEventListener('click', () => {
      dlg.close()
      let applied = 0
      this.store.commit(() => { applied = applyCompress(this.store.doc, run) })
      aboutOverlay.remove()
      this.toast(t('{n} pictures compressed — {before} → {after}', { n: String(applied), before: fmtBytes(run.before), after: fmtBytes(run.after) }))
    })
    dlg.open()
  }

  toast(message: string, action?: { label: string; run: () => void }, kind?: string) {
    document.querySelector('.ed-toast')?.remove()
    const t = div('ed-toast')
    if (kind) t.dataset.kind = kind
    t.textContent = message
    if (action) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-toast-act'
      b.textContent = action.label
      b.addEventListener('click', () => { action.run(); t.remove() })
      t.append(' ', b)
      t.classList.add('has-act')
    }
    // dock at the top of the canvas, centred on it: the window's foot covered
    // the speaker notes, and the canvas's foot the zoom and Slideshow controls
    const canvas = document.querySelector('.ed-scroll')?.getBoundingClientRect()
    if (canvas?.height) {
      t.style.top = `${canvas.top + 12}px`
      t.style.bottom = 'auto'
      t.style.left = `${canvas.left + canvas.width / 2}px`
    }
    document.body.appendChild(t)
    setTimeout(() => t.classList.add('show'))
    setTimeout(() => {
      t.classList.remove('show')
      setTimeout(() => t.remove(), 300)
    }, action ? 8000 : 2200)
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
      // A refused whole-deck SNAPSHOT is not a change and not an image: after
      // #509 the snapshot carries no inline pictures, so this means the deck's
      // own text/tables/small assets exceed the relay's frame ceiling. Say so —
      // "that change" would blame an edit that is fine. The count of pictures
      // still uploading is informational (the transient offload window), not
      // the cause.
      if (n.snapshot) return t('This deck is too large to share live in one piece. Your changes are saved in your copy, but a collaborator joining now may not receive the whole deck.')
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

/**
 * Take the live session out of a copy that is about to leave this machine.
 * ONE list, in one place: every field under `collab` is a bearer capability,
 * so a hand-out that forgets one of them grants the recipient write access to
 * the room, the power to revoke its members, or the ability to decrypt every
 * frame and blob the relay has ever stored — and the file looks completely
 * ordinary afterwards. Divergent per-export copies of this list are how one
 * export path ends up leaking what the other three strip.
 *
 * The default is to drop the block outright (sealed packages, templates, the
 * JSON on the clipboard: none of them may join anything). `keepRoom` is for
 * the copies that are MEANT to follow the session — they keep the room, the
 * symmetric read key and the public keys, and lose only the private halves.
 */
function stripCollabSecrets(doc: import('../model').BentoDoc, opts: { keepRoom?: boolean } = {}) {
  // Embedded documents first, whether or not this copy keeps a session of
  // its own: an embed's `doc` is another deck's JSON and carries that deck's
  // envelope (collab + docId) if the file was authored with it in place. The
  // shape gate strips it on the way IN for pasted content; this strips it on
  // the way OUT for every copy — the same rule (envelope.ts).
  stripEmbeddedEnvelopes(doc)
  if (!doc.collab) return
  if (!opts.keepRoom) {
    delete doc.collab
    return
  }
  delete doc.collab.writerPriv // the muzzle — no write capability travels
  delete doc.collab.ownerPriv // v2: neither the owner key…
  delete doc.collab.invite //    …nor any invite (delegation) material
  // …nor the audience ticket store: presenter-only. It holds the show key
  // (worthless to a reader, who sees everything anyway) AND the audience
  // invite's private half, which would let a reader mint audience tickets the
  // presenter never issued. Stripped like the other private halves.
  delete doc.collab.audience
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
