// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Who else is in this space, and how to let them in.
//
// The engine has been wired since sync/session.ts; what was missing is any way
// to SEE it. A live session nobody can observe is indistinguishable from a
// broken one — you cannot tell "nobody is here" from "sync is down", and the
// first thing anyone does when a colleague's edit does not appear is save a
// copy, which is how two files start.
//
// Three surfaces, in the order they matter:
//
//  1. THE PAGE TREE. This is the one that is not a copy of slides. A deck is a
//     single canvas, so slides paints cursors on it; a space is a TREE, and
//     the useful question is not "where is your caret" but "which page is
//     everyone in". A dot on the page in the sidebar answers it at a glance,
//     costs one span per person, and is the thing that makes a shared space
//     feel inhabited rather than merely synced.
//
//  2. A LIVE BUTTON that reports state honestly, including "off".
//
//  3. A PANEL behind it: your name, who is here, and the way to invite someone.
//
// Notices and arrivals go through the topbar's existing status line rather
// than a new toast system — it already exists, it already clears itself, and a
// second transient-message mechanism in one app is one too many.

import { t } from './i18n.ts'
import { ICONS } from './icons.ts'
import type { Store } from './store.ts'
import type { SyncSession } from './sync/session.ts'
import { sharingOn, onlineTransport, joinFromDoc, startSharing, stopSharing } from '../../kernel/src/sync/online.ts'
import type { ShareKind } from './share.ts'

export interface Peerish {
  actor: string
  name: string
  color: string
  /** the page this person is on — `slide` on the wire, for the reason the kernel records */
  slide: string
}

const el = (tag: string, cls = '', text = ''): HTMLElement => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text) n.textContent = text
  return n
}

/** First letter of a name, for the dot. Grapheme-safe enough for one glyph. */
export const initial = (name: string): string => [...(name || '?').trim()][0] ?? '?'

/**
 * The people on a given page, for the sidebar.
 *
 * Exported and pure so it can be tested without a DOM: this is the only piece
 * of the UI with logic worth pinning.
 */
export function peersOnPage(peers: Peerish[], pageId: string): Peerish[] {
  return peers.filter((p) => p.slide === pageId)
}

/** Host hooks the editor provides; keeps this module out of editor internals. */
export interface CollabUiHost {
  store: Store
  session: SyncSession
  /** the topbar's transient message line */
  status(msg: string): void
  /** repaint the page tree (presence dots live there) */
  paintTree(): void
  /** open a popover anchored to a control */
  popover(anchor: HTMLElement, build: (pop: HTMLElement, close: () => void) => void): void
  /** navigate, for "click a person to go where they are" */
  goToPage(id: string): void
  /**
   * Save a copy that carries a SCOPED capability — an owner-signed invite,
   * never the open document. See share.ts for why that distinction is the
   * whole of this change.
   */
  shareCopy(kind: ShareKind): void
}

export class CollabUi {
  private host: CollabUiHost
  private btn: HTMLButtonElement | null = null
  private known = new Map<string, string>()

  constructor(host: CollabUiHost) {
    this.host = host
  }

  /** every peer except this replica */
  peers(): Peerish[] {
    return this.host.session.peers() as unknown as Peerish[]
  }

  /** Presence dots for one page, or null when nobody is there. */
  dotsFor(pageId: string): HTMLElement | null {
    const here = peersOnPage(this.peers(), pageId)
    if (!here.length) return null
    // NOT `sp-here` — the tree already uses that class for the page you are
    // ON, and reusing it would style the wrong thing in the one place both
    // appear. (The same collision cost an afternoon with `sp-ghost`.)
    const wrap = el('span', 'sp-presence')
    // Three, then a count. A page everybody happens to be on must not push the
    // page title out of a 220px sidebar.
    for (const p of here.slice(0, 3)) {
      const d = el('span', 'sp-dot', initial(p.name))
      d.style.background = p.color
      d.title = p.name
      wrap.append(d)
    }
    if (here.length > 3) wrap.append(el('span', 'sp-dot sp-dot-more', `+${here.length - 3}`))
    return wrap
  }

  /** The topbar control. Its LOOK is the state; its label never lies. */
  button(): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'sp-live'
    b.innerHTML = `<span class="sp-ico">${ICONS.people}</span><span class="sp-live-n"></span>`
    b.addEventListener('click', () => this.openPanel(b))
    this.btn = b
    this.sync()
    return b
  }

  /** Reflect connection + population onto the button. Cheap; called often. */
  sync(): void {
    const b = this.btn
    if (!b) return
    const tr = onlineTransport()
    const n = this.peers().length
    // THREE states, not two. Same-machine tabs sync over BroadcastChannel with
    // no relay at all, so "has peers" and "is online" are different facts — the
    // first version reported a peer count of 1 under the words "Not sharing
    // yet", which is the button contradicting itself in one glance.
    const online = !!tr && sharingOn(this.host.store)
    b.classList.toggle('sp-live-on', online)
    b.classList.toggle('sp-live-off', !online)
    const count = b.querySelector('.sp-live-n')
    if (count) count.textContent = n > 0 ? String(n) : ''
    b.title = online
      ? (n > 0
          ? t('Live — {n} other people are here', { n: String(n) })
          : t('Live — nobody else is here yet'))
      : n > 0
        ? t('Also open in another window on this computer — not shared online')
        : t('Not sharing yet — click to start a live session')
  }

  /**
   * Announce arrivals and departures, and keep the tree honest.
   *
   * Silent past a crowd, for the reason slides found: joining a busy room makes
   * every existing peer look like a fresh arrival, and the announcements storm.
   */
  onPeersChanged(): void {
    this.sync()
    this.host.paintTree()
    const now = new Map(this.peers().map((p) => [p.actor, p.name]))
    if (now.size <= 8) {
      for (const [actor, name] of now) {
        if (!this.known.has(actor)) this.host.status(t('{name} joined', { name }))
      }
      for (const [actor, name] of this.known) {
        if (!now.has(actor)) this.host.status(t('{name} left', { name }))
      }
    }
    this.known = now
  }

  private openPanel(anchor: HTMLElement): void {
    this.host.popover(anchor, (pop, close) => {
      pop.classList.add('sp-people')
      const store = this.host.store
      const live = !!onlineTransport() && sharingOn(store)

      const peers = this.peers()
      // The LIST follows who is actually here; the ACTIONS follow whether this
      // copy is on the relay. Gating the list on the relay too was the same
      // mistake as the button: another window of this file is a person in this
      // space, and the panel claimed there was nobody while their dot was
      // visible in the tree two inches away.
      pop.append(el('div', 'sp-pop-title', peers.length ? t('People in this space') : t('Share this space')))

      // YOUR NAME, first — it is the thing that shows up on everyone else's
      // screen, and the only field here that is about you rather than them.
      const row = el('label', 'sp-field')
      row.append(el('span', 'sp-field-lbl', t('Your name')))
      const name = document.createElement('input')
      name.type = 'text'
      name.className = 'sp-input'
      try { name.value = localStorage.getItem('bento-author') || '' } catch { /* locked-down origin */ }
      name.placeholder = t('Guest')
      name.addEventListener('input', () => {
        try { localStorage.setItem('bento-author', name.value) } catch { /* no storage */ }
      })
      row.append(name)
      pop.append(row)

      if (peers.length) {
        const list = el('div', 'sp-plist')
        for (const p of peers) {
          const item = document.createElement('button')
          item.type = 'button'
          item.className = 'sp-pitem'
          const d = el('span', 'sp-dot', initial(p.name))
          d.style.background = p.color
          item.append(d, el('span', 'sp-pname', p.name))
          const page = store.index.page.get(p.slide)
          if (page) item.append(el('span', 'sp-ppage', page.title || t('Untitled')))
          // clicking a person GOES to them — the whole reason to list where
          // they are rather than merely that they exist
          item.addEventListener('click', () => { close(); if (page) this.host.goToPage(page.id) })
          list.append(item)
        }
        pop.append(list)
      }

      const acts = el('div', 'sp-pacts')
      if (live) {
        // The label and the hint are bento/slides', word for word. They are
        // exact about the consequence — "you stay the owner and can remove
        // them" — where the old pair ("Invite someone…" / "Saves a copy that
        // joins this session") was true about the mechanism and silent about
        // the power it handed over. Two apps must not describe one guarantee
        // in two ways.
        acts.append(this.action(t('Invite to edit…'),
          t('Saves a copy to send. Whoever opens it edits this space live with you (end-to-end encrypted); you stay the owner and can remove them from the People list.'),
          () => { close(); this.host.shareCopy('invite') }))
        acts.append(this.action(t('Stop sharing'), t('This copy goes offline; the others carry on'), () => {
          close()
          stopSharing(this.host.session, store)
          this.sync(); this.host.paintTree()
          this.host.status(t('Stopped sharing'))
        }))
      } else {
        pop.append(el('div', 'sp-pnote', peers.length
          ? t('These windows are on this computer. Start a session to work with someone elsewhere.')
          : t('Nothing leaves this file until you start a session.')))
        acts.append(this.action(t('Start live session'), t('Then send someone the file'), () => {
          close()
          void startSharing(this.host.session, store).then(() => {
            this.sync(); this.host.paintTree()
            this.host.status(t('Live — send someone the file to bring them in'))
          })
        }))
      }
      pop.append(acts)
    })
  }

  private action(label: string, hint: string, run: () => void): HTMLElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'sp-paction'
    b.append(el('strong', '', label))
    if (hint) b.append(el('span', '', hint))
    b.addEventListener('click', run)
    return b
  }

  /**
   * Join the relay if this document is live AND share-eligible.
   *
   * The eligibility test is the kernel's, and it is the whole of the "a space
   * does not phone home when it is opened" promise: a fresh starter and a
   * template stay off the relay until somebody saves or starts a session.
   */
  tryJoin(): void {
    const s = this.host.session
    if (sharingOn(this.host.store) && s.shareEligible() && !onlineTransport()) {
      joinFromDoc(s, this.host.store)
    }
    this.sync()
  }
}
