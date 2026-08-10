// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Boot sequence. Order matters: capture the pristine document BEFORE any DOM
// mutation — the captured copy is what gets re-serialized on save.

import './styles.css'
import { anim } from './anim'
import { configureApp, appConfig } from '../../kernel/src/app.ts'
import { startTheme } from '../../kernel/src/theme.ts'
import {
  capturePristine, readEmbeddedDoc, serializeFile, serializeAuto, downloadFile,
  suggestedFileName, parseEnvelope, decryptEnvelope, setEncryptionPassword,
  registerPreview,
} from './save'
import { buildSlidePreview } from './preview'
import { APP_VERSION, checkForUpdates, buildUpdatedFile, applyUpdate } from './update'
import { i18nApi, t, applyDirection } from './i18n'
import { parseDoc, type BentoDoc, type TextElement } from './model'
import { validateDoc, type ValidateOpts } from './validate'
import { measureText, measureElement, type TextMeasureSpec } from './measure'
import { starterDoc } from './starterdeck'
import { injectFonts } from './fonts'
import { Store } from './store'
import { Editor } from './editor/editor'
import { startPresentation } from './present'
import { SyncSession } from './sync/session'
import { onlineTransport, startSharing, stopSharing, disconnectOnline, BroadcastSocket, broadcastTok, syncHost, joinFromDoc } from './sync/online'

// Tell the kernel who this app is — must precede any kernel module use
// (window title suffix, save-picker label, update manifest + its `app` check).
configureApp({
  appId: 'bento-slides',
  appName: 'bento/slides',
  manifestUrl: 'https://bento.page/releases/slides/manifest.json',
})

// Every save writes a static rendering of page one into the shell, so file
// managers thumbnail the deck instead of the boot splash (src/preview.ts).
// Registered before capturePristine only for tidiness — nothing serializes
// this early — but it must be registered before the first save.
registerPreview((doc) => buildSlidePreview(doc as BentoDoc))

capturePristine()

// Theme: after capturePristine, before the first paint.
//
// AFTER, because capturePristine clones the LIVE document and saves
// re-serialize that clone — so `data-theme` and `color-scheme` on <html> must
// not exist yet, or a viewer's preference would travel inside every file they
// save. Same rule applyDirection follows two lines below for dir/lang.
//
// BEFORE the paint, because applying it later renders the interface light and
// then flips it, which reads as a bug rather than a preference. Nothing here
// lays anything out — it sets two attributes on the root element.
startTheme()

// Chrome direction follows the VIEWER's language (Arabic/Hebrew/… get an RTL
// interface). Deliberately AFTER capturePristine: saves re-serialize the
// pristine clone, so the dir/lang attributes never reach a saved file — the
// same viewer-scoped rule as 'bento-lang' and reduced motion. The DOCUMENT
// never mirrors; styles.css pins every slide surface back to direction: ltr.
applyDirection()

// --- boot gates: password-encrypted files, read-only player files -----------

const embedded = readEmbeddedDoc()
const envelope = embedded ? parseEnvelope(embedded) : null
if (envelope) {
  void passwordGate()
} else {
  bootWith((embedded && parseDoc(embedded)) || starterDoc())
}

/** Encrypted file: ask for the password (looping on failure), then boot. */
async function passwordGate() {
  const gate = document.createElement('div')
  gate.className = 'ed-pwgate'
  gate.innerHTML =
    `<div class="ed-pwcard"><div class="ed-pwmark">🔒</div>` +
    `<h1>${t('This file is encrypted.')}</h1>` +
    `<p>${t('Enter password to open this deck')}</p>` +
    `<input type="password" autocomplete="current-password">` +
    `<button>${t('Unlock')}</button><div class="ed-pwerr"></div></div>`
  document.body.appendChild(gate)
  document.getElementById('bento-splash')?.remove()
  const input = gate.querySelector('input')!
  const button = gate.querySelector('button')!
  const err = gate.querySelector<HTMLElement>('.ed-pwerr')!
  const tryUnlock = async () => {
    const pass = input.value
    if (!pass) return
    button.setAttribute('disabled', '')
    const json = await decryptEnvelope(envelope!, pass)
    button.removeAttribute('disabled')
    if (json === null) {
      err.textContent = t('Wrong password — try again')
      input.select()
      return
    }
    const doc = parseDoc(json)
    if (!doc) {
      err.textContent = t('Wrong password — try again')
      return
    }
    setEncryptionPassword(pass) // saves + updates keep writing encrypted
    gate.remove()
    bootWith(doc)
  }
  button.addEventListener('click', () => void tryUnlock())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void tryUnlock()
  })
  input.focus()
}

function bootWith(doc: BentoDoc) {
  if (doc.collab?.broadcast) void broadcastMode(doc)
  else if (doc.readonly) playerMode(doc)
  else editorMode(doc)
}

/**
 * Broadcast copies boot straight into a locked follow-mode: the embedded
 * document renders through the real present overlay, and a read-only broadcast
 * socket drives navigation from the presenter's speaker view.
 */
async function broadcastMode(doc: BentoDoc) {
  document.title = `${doc.title} — ${appConfig().appName}`
  if (doc.fonts?.length) injectFonts(doc)
  document.getElementById('bento-splash')?.remove()

  // The broadcast copy carries only the room name and relay — the connect
  // token is DERIVED from the room name (broadcastTok), so the file never
  // embeds a secret.
  let creds = doc.collab!.broadcast!
  const relay = (creds.relay ?? syncHost()).replace(/\/+$/, '')
  // ?room=<name> re-points this copy at another broadcaster's room on the
  // SAME relay — the hosted-client flow: any presenter's deck mints this
  // link (hostedLink), the client opens it, same copy, new driver.
  const q = new URLSearchParams(location.search)
  const r = q.get('room')
  if (r) creds = { room: `${relay}/d/${r}`, relay }
  const roomName = creds.room.startsWith('wss://') || creds.room.startsWith('ws://')
    ? creds.room.split('/').pop() || ''
    : creds.room
  const tok = await broadcastTok(roomName)
  const roomUrl = creds.room.startsWith('wss://') || creds.room.startsWith('ws://')
    ? creds.room
    : `${relay}/d/${creds.room}`

  let viewers = 0
  let firstNav = false
  let exited = false
  let lastState: import('./sync/online').BroadcastSocketState = 'connecting'

  const chip = document.createElement('div')
  chip.className = 'bento-broadcast-chip'
  chip.style.cssText =
    `position:fixed; top:12px; right:12px; z-index:100000;` +
    `background:rgba(15,19,24,0.78); color:#e8eaed;` +
    `backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);` +
    `border:1px solid rgba(255,255,255,0.08); border-radius:8px;` +
    `padding:8px 12px; font-family:system-ui,sans-serif;` +
    `font-size:13px; line-height:1.35; pointer-events:none;` +
    `text-align:right; max-width:min(50vw,260px);`
  const statusLine = document.createElement('div')
  statusLine.style.fontWeight = '500'
  const titleLine = document.createElement('div')
  titleLine.style.cssText = 'opacity:0.72; font-size:11px; margin-top:2px;'
  titleLine.textContent = doc.title
  chip.append(statusLine, titleLine)

  const updateChip = () => {
    if (lastState === 'connecting') {
      statusLine.textContent = t('Connecting…')
    } else if (lastState === 'closed') {
      statusLine.textContent = t('Broadcast ended')
    } else if (!firstNav) {
      statusLine.textContent = t('Waiting for presenter')
    } else {
      statusLine.textContent = t('Live · N viewers').replace('N', String(viewers))
    }
    const overlay = document.querySelector<HTMLElement>('.bento-present-overlay')
    if (overlay && chip.parentElement !== overlay) overlay.appendChild(chip)
  }

  // Map a 1-based presenter-visible slide number to the index of the n-th
  // non-state slide. If n is stale/out of range, clamp to the last slide;
  // a non-positive number clamps to the first slide.
  const slideIndexFromVisible = (n: number): number => {
    if (n <= 0) return 0
    let seen = 0
    let lastNonState = 0
    for (let i = 0; i < doc.slides.length; i++) {
      if (!doc.slides[i].stateOf) {
        lastNonState = i
        seen++
        if (seen === n) return i
      }
    }
    // stale copy: clamp to the last non-state slide (never a hidden state)
    return lastNonState
  }

  const exitCard = (lastIndex: number) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void lastIndex
    if (exited) return
    exited = true
    socket?.destroy()
    if (liveSession) disconnectOnline(liveSession)
    unsubscribeDoc?.()
    const card = document.createElement('div')
    card.className = 'ed-player'
    card.innerHTML =
      `<div class="ed-playercard"><h1>${doc.title.replace(/</g, '&lt;')}</h1>` +
      `<p>${t('Broadcast ended')}</p></div>`
    document.body.appendChild(card)
  }

  // Live content (hosted client): the copy carries reader collab creds — join
  // the deck's collab room as a reader replica so slide content updates in
  // real time as the deck is edited. Navigation still rides the broadcast
  // socket above; the session ignores ctl frames (onFrame has no default).
  const c = doc.collab
  let liveStore: Store | null = null
  let liveSession: SyncSession | null = null
  if (c?.room && c.key && c.on !== false) {
    liveStore = new Store(doc)
    liveSession = new SyncSession(liveStore)
    joinFromDoc(liveSession, liveStore)
  }
  let unsubscribeDoc: (() => void) | null = null
  const session = startPresentation(doc, 0, exitCard, {
    onDocChange: ({ slidesEl, deck, buildSection }) => {
      const visibleIndexOf = (i: number) => doc.slides.slice(0, i + 1).filter((s) => !s.stateOf).length
      const applyDoc = () => {
        if (doc.slides.length !== slidesEl.children.length) {
          // structural change: rebuild the section list and re-settle on the
          // same visible slide (the presenter's nav is 1-based visible numbers)
          const cur = deck.getIndices().h
          slidesEl.replaceChildren(...doc.slides.map(buildSection))
          deck.sync()
          session.goTo(slideIndexFromVisible(visibleIndexOf(cur)))
        } else {
          // content change: re-render the current slide in place (no fx replay —
          // the slide is already shown; entrance fx run on slidechange only)
          const cur = deck.getIndices().h
          const section = slidesEl.children[cur] as HTMLElement | undefined
          const slide = doc.slides[cur]
          if (section && slide) section.replaceChildren(buildSection(slide))
        }
      }
      unsubscribeDoc = liveStore?.on('doc', applyDoc) ?? null
      applyDoc()
    },
  })
  updateChip()

  const socket = new BroadcastSocket(roomUrl, tok, {
    onNav: (n) => {
      firstNav = true
      session.goTo(slideIndexFromVisible(n))
      updateChip()
    },
    onPresence: (n) => {
      viewers = n
      updateChip()
    },
    onLaser: (p) => {
      session.setRemoteLaser(p)
    },
    onBlack: (on) => {
      session.setBlack(on)
    },
    onState: (s) => {
      lastState = s
      if (s === 'closed') {
        // A re-present will send a fresh lastNav replay on reconnect; until then
        // the copy should read "Waiting for presenter" rather than stale "Live".
        firstNav = false
        viewers = 0
        session.setRemoteLaser(null)
        session.setBlack(false)
      }
      updateChip()
    },
  })
  socket.connect()

  ;(window as any).bento = { format: doc.format, doc }
}

/**
 * Read-only files are PLAYER files: they open straight into the show and
 * never expose the editor. Leaving the presentation lands on a minimal card.
 */
function playerMode(doc: BentoDoc) {
  document.title = `${doc.title} — ${appConfig().appName}`
  if (doc.fonts?.length) injectFonts(doc)
  document.getElementById('bento-splash')?.remove()
  const card = document.createElement('div')
  card.className = 'ed-player'
  card.innerHTML =
    `<div class="ed-playercard"><h1>${doc.title.replace(/</g, '&lt;')}</h1>` +
    `<p>${t('This is a presentation package — view and present only.')}</p>` +
    `<button class="ed-playgo">▶&nbsp; ${t('Present')}</button>` +
    `<button class="ed-playcopy">⤓&nbsp; ${t('Save a copy')}</button></div>`
  document.body.appendChild(card)
  const start = () => {
    card.style.display = 'none'
    startPresentation(doc, 0, () => {
      card.style.display = ''
    })
  }
  card.querySelector('.ed-playgo')!.addEventListener('click', start)
  card.querySelector('.ed-playcopy')!.addEventListener('click', () => {
    void serializeAuto(doc).then((html) => downloadFile(html, suggestedFileName(doc)))
  })
  ;(window as any).bento = { format: doc.format, doc, readonly: true }
  start()
}

function editorMode(doc: BentoDoc) {

document.title = `${doc.title} — ${appConfig().appName}`

// Embedded fonts: register @font-face rules from the asset table so text
// elements can use bundled families in the editor, presenter and thumbnails.
if (doc.fonts?.length) injectFonts(doc)

const store = new Store(doc)
const editor = new Editor(document.getElementById('app')!, store)

// Live collaboration (bento-sync): same-machine tabs sync automatically over
// BroadcastChannel; the online relay transport joins via the Share UI.
const session = new SyncSession(store)
editor.connectSync(session)

// Opening a link ending in #present starts the show immediately (player mode).
if (location.hash === '#present') {
  editor.present(true)
}

// Dismiss the boot splash (inline in index.html so it paints before this
// bundle parses). Hold it briefly so the assemble animation reads as a
// brand moment instead of a flicker; the pristine capture ran before this,
// so saved files keep the splash for their own next boot.
{
  const splash = document.getElementById('bento-splash')
  if (splash) {
    const wait = Math.max(0, 1250 - performance.now())
    setTimeout(() => {
      splash.classList.add('done')
      setTimeout(() => splash.remove(), 550)
    }, wait)
  }
}

// Small scripting surface for tooling and automation: read/replace the
// document model and serialize the full .bento.html file.
;(window as any).bento = {
  format: doc.format,
  get doc() {
    return store.doc
  },
  serialize: () => {
    session.stampInto(store.doc)
    return serializeFile(store.doc)
  },
  undo: () => store.undo(),
  redo: () => store.redo(),
  get selection() {
    return store.selection.slice()
  },
  /** animation engine, exposed for scripting/diagnostics */
  anim,
  /** i18n: t/locale/setLocale/choices — setLocale('x-pseudo') audits the sweep */
  i18n: i18nApi,
  /** live-collaboration session: actor id, connected peers, force a diff-flush */
  sync: {
    get actor() {
      return session.actor
    },
    peers: () => session.peers(),
    flush: () => session.flush(),
    transports: () => session.transportKinds,
    /** start an online session (mints doc.collab, connects the relay) */
    share: () => {
      void startSharing(session, store)
      return store.doc.collab
    },
    unshare: () => stopSharing(session, store),
    online: () => onlineTransport()?.status ?? 'off',
  },
  /**
   * AI/tooling round-trip: replace the whole document from a JSON string
   * (the contents of #bento-doc). Validates via parseDoc; returns false and
   * changes nothing on invalid input. Undoable in the editor.
   */
  loadDoc(json: string): boolean {
    const next = parseDoc(json)
    if (!next) return false
    store.replaceDoc(next)
    return true
  },
  /**
   * Report what the runtime would otherwise swallow: unknown keys, text that
   * overflows its box, elements off the canvas, effects that can never run,
   * broken links and asset refs, chart options charts-lite ignores. Read-only
   * — it never changes the document. Pass a doc to check one you have not
   * loaded; defaults to the open one.
   */
  validate(target?: BentoDoc, opts?: ValidateOpts) {
    return validateDoc(target ?? store.doc, opts)
  },
  /**
   * How tall does this text need to be? The format is absolute pixels, so
   * without a screen the height of a string is a guess — this answers it by
   * rendering through the real renderer.
   *
   * Pass an element id to measure one that exists, or a spec
   * ({html, w, fontSize, …}) to size text BEFORE creating the element, which
   * is the point: an agent can lay a slide out correctly the first time
   * instead of writing it, checking, and correcting.
   *
   * Returns {height, width, lines} — plus {fits, overflow} when you supply `h`.
   */
  measure(target: string | TextMeasureSpec, opts?: { doc?: BentoDoc }) {
    const doc = opts?.doc ?? store.doc
    if (typeof target !== 'string') return measureText(target, doc)
    for (const s of doc.slides) {
      const el = s.elements.find((e) => e.id === target && e.type === 'text')
      if (el) return measureElement(el as TextElement, doc)
    }
    return null
  },
  /**
   * Self-update surface (all user/tooling-initiated, never automatic):
   * check() fetches + signature-verifies the release manifest; build()
   * returns the updated file's html (this doc inside the new shell);
   * apply() downloads it. check(url) accepts an override for testing.
   */
  updates: {
    version: APP_VERSION,
    check: (url?: string) => checkForUpdates(url),
    build: (release: any) => {
      session.stampInto(store.doc)
      return buildUpdatedFile(release, store.doc)
    },
    apply: (release: any) => {
      session.stampInto(store.doc)
      return applyUpdate(release, store.doc)
    },
  },
  /**
   * Flat list of every review comment thread — the entry point for tooling
   * and AI agents processing the deck ("fix everything people flagged"):
   * each item carries the slide, a typed anchor (element / point / slide),
   * author, text, replies and resolved state.
   */
  comments() {
    return store.doc.slides.flatMap((s, slideIndex) =>
      (s.comments ?? []).map((c) => ({
        slideId: s.id,
        slideIndex,
        id: c.id,
        anchor: c.elementId
          ? { type: 'element' as const, elementId: c.elementId }
          : typeof c.x === 'number'
            ? { type: 'point' as const, x: c.x, y: c.y }
            : { type: 'slide' as const },
        author: c.author,
        at: c.at,
        text: c.text,
        replies: c.replies ?? [],
        resolved: !!c.resolved,
      })),
    )
  },
}

} // editorMode
