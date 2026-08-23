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
import { sharingOn, onlineTransport, joinFromDoc, stopSharing, rotateKeys } from '../../kernel/src/sync/online.ts'
import { offlineEnabled } from '../../kernel/src/net.ts'
import { canWrite, fingerprint, isOwner, isReaderCopy, type ShareKind } from './share.ts'

export interface Peerish {
  actor: string
  name: string
  color: string
  /** the page this person is on — `slide` on the wire, for the reason the kernel records */
  slide: string
  /**
   * The public key this person's copy SIGNS with, when it has one.
   *
   * A name is a claim (localStorage, typed by its owner); a `pub` is a proof —
   * the relay verified it per socket before accepting a single op. It is also
   * what Remove revokes, which is why the roster is keyed on it and not on the
   * actor id: an actor is one tab, a key is one device.
   */
  pub?: string
  role?: 'owner' | 'editor' | 'viewer'
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
   * Save a copy that carries a SCOPED capability — an owner-signed invite, or
   * a view-only follower. Never the open document: see share.ts.
   */
  shareCopy(kind: ShareKind): void
  /**
   * Connect to the live session WITHOUT saving a new copy.
   *
   * The editor owns it rather than this module because sharing a copy has to
   * do it first, and two call sites arming the same session from two places is
   * how "Start" and "Invite" end up disagreeing about whether it is on.
   */
  goLive(): Promise<void>
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

  /**
   * What this copy's connection actually is, in one word.
   *
   * FIVE states, not two, and every one of them is a different thing to do
   * next. The button used to answer "on or off", which merges "the relay
   * refused us" into "you have not shared yet" — the one case where the user
   * must act and the one where nothing is wrong.
   *
   *   offline    the hard no-network switch is on; nothing will connect
   *   viewer     this is a view-only copy: it follows, it never sends
   *   live       connected to the relay
   *   connecting dialling, or retrying after a drop — NOT a failure yet
   *   off        not shared (peers, if any, are windows on this computer)
   */
  state(): 'offline' | 'viewer' | 'live' | 'connecting' | 'off' {
    if (offlineEnabled()) return 'offline'
    if (isReaderCopy(this.host.store.doc)) return 'viewer'
    const tr = onlineTransport()
    if (!tr || !sharingOn(this.host.store)) return 'off'
    return tr.status === 'open' ? 'live' : 'connecting'
  }

  /** Reflect connection + population onto the button. Cheap; called often. */
  sync(): void {
    const b = this.btn
    if (!b) return
    const n = this.peers().length
    const st = this.state()
    // "has peers" and "is online" remain DIFFERENT FACTS: same-machine tabs
    // sync over BroadcastChannel with no relay at all. The first version of
    // this button reported a peer count of 1 under the words "Not sharing
    // yet", which is a control contradicting itself in one glance.
    const online = st === 'live' || st === 'connecting' || st === 'viewer'
    b.classList.toggle('sp-live-on', st === 'live' || st === 'viewer')
    b.classList.toggle('sp-live-off', !online)
    b.classList.toggle('sp-live-wait', st === 'connecting')
    const count = b.querySelector('.sp-live-n')
    if (count) count.textContent = n > 0 ? String(n) : ''
    b.title = this.buttonTitle(st, n)
  }

  private buttonTitle(st: ReturnType<CollabUi['state']>, n: number): string {
    switch (st) {
      case 'offline':
        return t('Offline mode is on — nothing leaves this computer.')
      case 'viewer':
        return t('View-only copy — it follows the live session but can’t change this space.')
      case 'connecting':
        return t('Connecting…')
      case 'live':
        return n > 0
          ? t('Live — {n} other people are here', { n: String(n) })
          : t('Live — nobody else is here yet')
      default:
        return n > 0
          ? t('Also open in another window on this computer — not shared online')
          : t('Not sharing yet — click to start a live session')
    }
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

  /**
   * THIS device's identity in the room: the key it signs with, and its role.
   *
   * Per-device by design. The same person on a second machine mints a second
   * member key and shows up as a second entry the owner can admit or remove
   * independently — which is what makes Remove mean "this laptop" rather than
   * "this human, everywhere, until I re-key the room".
   */
  private me(): { role?: 'owner' | 'editor' | 'viewer'; pub?: string } {
    const doc = this.host.store.doc
    const c = doc.collab
    if (!c) return {}
    if (c.role === 'reader') return { role: 'viewer' }
    if (isOwner(doc)) return { role: 'owner', pub: c.owner }
    if (c.v === 2 && c.invite) {
      let pub: string | undefined
      try { pub = JSON.parse(localStorage.getItem(`bento-member-${doc.docId}`) || 'null')?.pub } catch { /* no storage */ }
      return { role: 'editor', pub }
    }
    if (c.writerPriv) return { role: 'editor', pub: c.writerPub }
    return {}
  }

  private roleLabel(r?: string): string {
    return r === 'owner' ? t('Owner') : r === 'editor' ? t('Editor') : r === 'viewer' ? t('Viewer') : ''
  }

  private openPanel(anchor: HTMLElement): void {
    this.host.popover(anchor, (pop, close) => {
      pop.classList.add('sp-people')
      const store = this.host.store
      const doc = store.doc
      const st = this.state()
      const peers = this.peers()
      const mine = this.me()
      const iAmOwner = isOwner(doc)

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
      name.title = t('Shown next to your cursor and in the People list — stored only in this browser.')
      name.addEventListener('input', () => {
        try { localStorage.setItem('bento-author', name.value) } catch { /* no storage */ }
      })
      // push the new name to peers right away, or it lands on their screens
      // only at the next heartbeat
      name.addEventListener('change', () => this.host.session.hello())
      row.append(name)
      pop.append(row)

      // YOU, with the key you sign with. A fingerprint is the only thing in
      // this panel two people can verify out of band, so it is rendered the
      // same way bento/slides renders it — a code grouped differently in each
      // app is a code they cannot compare over a call.
      if (mine.role) {
        const meRow = el('div', 'sp-pitem sp-pme')
        let myName = t('Guest')
        try { myName = localStorage.getItem('bento-author') || myName } catch { /* no storage */ }
        meRow.append(el('span', 'sp-pname', `${myName} (${t('you')})`))
        meRow.append(el('span', 'sp-ppage', [this.roleLabel(mine.role), fingerprint(mine.pub)].filter(Boolean).join(' · ')))
        meRow.title = mine.pub
          ? t('Your key on THIS device: {fp}. Another device counts as a new person until the owner removes it.', { fp: fingerprint(mine.pub) })
          : t('View-only copy — it holds no signing key.')
        pop.append(meRow)
      }

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
          const where = [this.roleLabel(p.role), page ? (page.title || t('Untitled')) : ''].filter(Boolean).join(' · ')
          if (where) item.append(el('span', 'sp-ppage', where))
          // a pub-carrying peer's name is bound to a key the relay verified per
          // socket, not merely typed into the field above
          if (p.pub) item.title = `${t('Key-verified identity')} · ${fingerprint(p.pub)}`
          // clicking a person GOES to them — the whole reason to list where
          // they are rather than merely that they exist
          item.addEventListener('click', () => { close(); if (page) this.host.goToPage(page.id) })
          // Remove is the OWNER's, and it is a signed revocation of ONE device
          // key: the relay drops that key's writes, refuses its reconnects and
          // tells it to stand down. Nobody else is disturbed and no file is
          // re-sent — the difference between this and Reset access.
          if (iAmOwner && p.pub && p.pub !== doc.collab!.owner) {
            const kick = el('span', 'sp-pkick', '✕')
            kick.title = t('Remove {name} — revokes this device’s access; everyone else is unaffected', { name: p.name })
            kick.addEventListener('click', (ev) => {
              ev.stopPropagation()
              if (!confirm(t('Remove {name} from this space? Their copy drops to read-only.', { name: p.name }))) return
              close()
              const tr = onlineTransport()
              void Promise.resolve(tr ? tr.revokeKey(p.pub!, doc.collab!.owner!, doc.collab!.ownerPriv!) : false)
                .then((done) => this.host.status(done
                  ? t('{name} was removed', { name: p.name })
                  : t('Couldn’t reach the live session')))
            })
            item.append(kick)
          }
          list.append(item)
        }
        pop.append(list)
      }

      // ONE status line, and it says which of the five states this is. A
      // "connecting" that reads as "off" sends people to fix a session that is
      // already dialling; a view-only copy that reads as "off" sends them to
      // press Start, which is the one thing that cannot help.
      if (st === 'offline') {
        pop.append(el('div', 'sp-pnote', t('Offline mode is on — nothing leaves this computer.')))
        pop.append(el('div', 'sp-pnote', t('Windows on this computer still sync; turn offline mode off in About to work with someone elsewhere.')))
        return
      }
      const status = el('div', 'sp-pstatus')
      if (st === 'live') {
        status.classList.add('ok')
        status.textContent = `● ${t('Live')} — ${t('{n} connected', { n: String(peers.length + 1) })}`
      } else if (st === 'connecting') {
        status.textContent = `◐ ${t('Connecting…')}`
      } else if (st === 'viewer') {
        status.classList.add('ok')
        status.textContent = `● ${t('Following — view only')}`
      } else {
        status.textContent = `○ ${t('Not live — turns on when you share')}`
      }
      pop.append(status)

      // A view-only copy holds no signing key, so there is nothing here it
      // could do. Saying why is the point: the relay refuses its writes, and a
      // person who does not know that will keep trying.
      if (!canWrite(doc)) {
        pop.append(el('div', 'sp-pnote', t('This is a view-only copy — it follows the live session but can’t change this space.')))
        return
      }

      if (st === 'off') {
        pop.append(el('div', 'sp-pnote', peers.length
          ? t('These windows are on this computer. Start a session to work with someone elsewhere.')
          : t('Nothing leaves this file until you start a session.')))
      }

      // SHARING IS FILES. Each of these saves a copy to send, and turns the
      // live session on — there is no separate start-a-session step.
      const acts = el('div', 'sp-pacts')
      acts.append(this.action(t('Invite to edit…'),
        t('Saves a copy to send. Whoever opens it edits this space live with you (end-to-end encrypted); you stay the owner and can remove them from the People list.'),
        () => { close(); this.host.shareCopy('invite') }))
      acts.append(this.action(t('View-only copy…'),
        t('A live viewer: follows every edit as it happens but can never change this space — the relay enforces it.'),
        () => { close(); this.host.shareCopy('viewonly') }))

      if (st === 'off') {
        // Reconnecting WITHOUT saving another copy. Without this the only way
        // back into a session you had stopped was to save a copy, which is how
        // one space becomes four files.
        acts.append(this.action(t('Start live session'), t('Connect to the live session without saving a new copy — copies you sent earlier will meet you there.'), () => {
          close()
          void this.host.goLive().then(() => {
            this.sync(); this.host.paintTree()
            this.host.status(t('Live — send someone the file to bring them in'))
          })
        }))
      } else {
        acts.append(this.action(t('Stop sharing'), t('This copy goes offline; the others carry on'), () => {
          close()
          stopSharing(this.host.session, store)
          this.sync(); this.host.paintTree()
          this.host.status(t('Stopped sharing'))
        }))
      }

      // Quiet at the bottom, because it is the nuclear option: rotation
      // re-mints the room, so every copy already sent stops syncing for good.
      // Remove (above) is the scalpel; this is the amputation.
      if (iAmOwner) {
        acts.append(this.action(t('Reset access…'),
          t('Mints brand-new keys. Every previously sent copy stops syncing for good; share fresh copies afterwards.'),
          () => {
            if (!confirm(t('Reset access? Every copy you’ve sent stops syncing; only copies saved after this can join.'))) return
            close()
            void rotateKeys(this.host.session, store).then(() => {
              this.sync(); this.host.paintTree()
              this.host.status(t('Access reset — only copies saved from now on can join'))
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
    this.watchStatus()
    this.sync()
  }

  /**
   * Repaint the button when the CONNECTION changes, not only when the room's
   * population does.
   *
   * Measured in a browser on a real relay: the button read "Connecting…" while
   * the panel two inches under it read "Live — 1 connected". Both call
   * `state()`; the panel is rebuilt every time it opens and the button was not
   * — it was last painted at boot, before the socket opened, and nothing since
   * had touched it. `onPeersChanged` was the only thing that called `sync()`,
   * and in a room where nobody else has arrived yet that never fires.
   *
   * Which is the exact failure the five states exist to prevent: a control
   * saying one thing while the truth is elsewhere on the same screen. Honest
   * states are worth nothing if they are painted once.
   *
   * Also called from `goLive()` via the editor, because a transport created
   * after boot is a different object with its own callback slot.
   */
  watchStatus(): void {
    const tr = onlineTransport()
    if (!tr || tr === this.watched) return
    this.watched = tr
    const prev = tr.onStatus
    tr.onStatus = (s) => { prev?.(s); this.sync() }
  }

  /** the transport whose status we are already listening to */
  private watched: unknown = null
}
