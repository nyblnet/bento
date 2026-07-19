// Boot sequence. Order matters: capture the pristine document BEFORE any DOM
// mutation — the captured copy is what gets re-serialized on save.

import './styles.css'
import { anim } from './anim'
import {
  capturePristine, readEmbeddedDoc, serializeFile, serializeAuto, downloadFile,
  suggestedFileName, parseEnvelope, decryptEnvelope, setEncryptionPassword,
} from './save'
import { APP_VERSION, checkForUpdates, buildUpdatedFile, applyUpdate } from './update'
import { i18nApi, t } from './i18n'
import { parseDoc, type BentoDoc } from './model'
import { starterDoc } from './starterdeck'
import { injectFonts } from './fonts'
import { Store } from './store'
import { Editor } from './editor/editor'
import { startPresentation } from './present'
import { SyncSession } from './sync/session'
import { onlineTransport, startSharing, stopSharing } from './sync/online'

capturePristine()

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
  if (doc.readonly) playerMode(doc)
  else editorMode(doc)
}

/**
 * Read-only files are PLAYER files: they open straight into the show and
 * never expose the editor. Leaving the presentation lands on a minimal card.
 */
function playerMode(doc: BentoDoc) {
  document.title = `${doc.title} — Bento Slides`
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

document.title = `${doc.title} — Bento Slides`

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
