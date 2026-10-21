// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The Share button and its popover: who is in this workbook, and how to let
// somebody in.
//
// SPACES' POPOVER, SECTION FOR SECTION (spaces/src/collabui.ts), which is
// itself slides' (.ed-share-pop): your name on one line, PEOPLE, one status
// line, SHARE A COPY, the actions as one-line rows, then — set apart — the
// session controls. Reused rather than reinvented, because the maintainer's
// rule is that slides is the reference for chrome in look, organisation and
// wording, and a reader moving between the apps should find the same panel.
//
// WHAT THIS REPLACED, and why it was a blocker rather than polish. The bar used
// to carry a bare "Start live session" button that went live on ONE click — no
// name, no list of who has the file, no scoped copies — and turned into "Stop
// sharing", one mis-click from ending the session. Below 900px it collapsed to
// an unlabelled grey dot, and on a phone it vanished, so a phone could not
// share at all. Now:
//
//   · NOTHING CONNECTS until the reader says "Go live" (or shares a live copy,
//     which goes live on the way out — the copy is useless otherwise). A fresh
//     workbook stays off the network (PLATFORM §5).
//   · The button is LABELLED at every width — "Share", or "Live" while
//     connected — and stays in the bar on a phone. A dot alone said nothing.
//   · Copies for other people are built in share.ts through the kernel's copy
//     table, never from `store.doc` whole.

import { t } from './i18n.ts'
import { ICONS, menuLabel } from './icons.ts'
import type { Store } from './store.ts'
import type { SyncSession, Peer } from './sync/session.ts'
import { sharingOn, onlineTransport, joinFromDoc, startSharing, stopSharing, rotateKeys, collabOf } from './sync/online.ts'
import { offlineEnabled } from '../../kernel/src/net.ts'
import { canWrite, fingerprint, isOwner, isReaderCopy, type ShareKind } from './share.ts'
import { lsGet, lsSet } from '../../kernel/src/storage.ts'

export interface ShareUiHost {
  store: Store
  session: SyncSession
  /** a transient message the reader must not miss */
  toast(msg: string): void
  /** write a copy for someone else (share.ts builds it) */
  shareCopy(kind: ShareKind): Promise<void>
  /** go to the sheet a collaborator is on */
  goToSheet(id: string): void
}

export type ShareState = 'offline' | 'viewer' | 'live' | 'connecting' | 'off'

const el = (tag: string, cls = '', text = ''): HTMLElement => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text) n.textContent = text
  return n
}

/** First letter of a name, for the dot. */
const initial = (name: string): string => [...(name || '?').trim()][0] ?? '?'

export class ShareUi {
  private host: ShareUiHost
  /** the dropdown: `.dx-dd` wrapper, trigger and panel */
  readonly wrap: HTMLElement
  private btn: HTMLButtonElement
  private pop: HTMLElement
  private known = new Map<string, string>()
  private watched: unknown = null

  constructor(host: ShareUiHost) {
    this.host = host
    this.wrap = el('div', 'dx-dd dx-share-dd')
    this.btn = document.createElement('button')
    this.btn.type = 'button'
    this.btn.className = 'dx-btn dx-share'
    this.btn.dataset.act = 'share'
    this.btn.innerHTML = `${ICONS.share}<span class="dx-share-lab"></span><span class="dx-share-n"></span>`
    this.pop = el('div', 'dx-menu dx-share-pop')
    this.wrap.append(this.btn, this.pop)
    this.btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const opening = !this.wrap.classList.contains('open')
      // the bar's other menus shut, exactly as a dropdown trigger does in main.ts
      // …but never one it sits INSIDE: on a phone Share lives in ⋯
      for (const dd of document.querySelectorAll('.dx-dd.open')) {
        if (dd !== this.wrap && !dd.contains(this.wrap)) dd.classList.remove('open')
      }
      if (opening) this.render()
      this.wrap.classList.toggle('open', opening)
    })
    host.session.onPeers(() => this.onPeersChanged())
    this.sync()
  }

  private close = (): void => { this.wrap.classList.remove('open') }

  peers(): Peer[] {
    return this.host.session.peers()
  }

  /**
   * What this copy's connection actually is. FIVE states, because each one is
   * a different thing to do next (spaces' reasoning, verbatim in effect).
   */
  state(): ShareState {
    if (offlineEnabled()) return 'offline'
    if (isReaderCopy(this.host.store.doc)) return 'viewer'
    const tr = onlineTransport()
    if (!tr || !sharingOn(this.host.store)) return 'off'
    return tr.status === 'open' ? 'live' : 'connecting'
  }

  /** Reflect state onto the button. Cheap; called often. */
  sync(): void {
    const b = this.btn
    const n = this.peers().length
    const st = this.state()
    const on = st === 'live' || st === 'viewer'
    b.classList.toggle('dx-share-live', on)
    b.classList.toggle('dx-share-wait', st === 'connecting')
    // THE WORD IS THE STATE, at every width — never a dot on its own.
    const lab = b.querySelector('.dx-share-lab')!
    lab.textContent = st === 'live' || st === 'connecting' || st === 'viewer' ? t('Live') : t('Share')
    b.querySelector('.dx-share-n')!.textContent = n > 0 ? String(n) : ''
    b.title = this.buttonTitle(st, n)
    b.setAttribute('aria-label', `${lab.textContent} — ${b.title}`)
  }

  private buttonTitle(st: ShareState, n: number): string {
    switch (st) {
      case 'offline': return t('Offline mode is on — nothing leaves this computer.')
      case 'viewer': return t('View-only copy — it follows the live session but can’t change this workbook.')
      case 'connecting': return t('Connecting…')
      case 'live': return n > 0
        ? t('Live — {n} other people are here', { n: String(n) })
        : t('Live — nobody else is here yet')
      default: return n > 0
        ? t('Also open in another window on this computer — not shared online')
        : t('Share — invite people to edit, send view-only copies, see who’s here')
    }
  }

  /** Arrivals and departures, quiet past a crowd (a busy room's join storm). */
  onPeersChanged(): void {
    this.sync()
    if (this.wrap.classList.contains('open')) this.render()
    const now = new Map(this.peers().map((p) => [p.actor, p.name]))
    if (now.size <= 8) {
      for (const [actor, name] of now) if (!this.known.has(actor)) this.host.toast(t('{name} joined', { name }))
      for (const [actor, name] of this.known) if (!now.has(actor)) this.host.toast(t('{name} left', { name }))
    }
    this.known = now
  }

  /** This device's identity in the room: the key it signs with, and its role. */
  private me(): { role?: 'owner' | 'editor' | 'viewer'; pub?: string } {
    const doc = this.host.store.doc
    const c = collabOf(doc)
    if (!c) return {}
    if (isReaderCopy(doc)) return { role: 'viewer' }
    if (isOwner(doc)) return { role: 'owner', pub: c.owner }
    if (c.v === 2 && c.invite) {
      let pub: string | undefined
      try { pub = JSON.parse(lsGet(`bento-member-${doc.docId}`) || 'null')?.pub } catch { /* no storage */ }
      return { role: 'editor', pub }
    }
    if (c.writerPriv) return { role: 'editor', pub: c.writerPub }
    return {}
  }

  private roleLabel(r?: string): string {
    return r === 'owner' ? t('Owner') : r === 'editor' ? t('Editor') : r === 'viewer' ? t('Viewer') : ''
  }

  /** Build the panel. Rebuilt on every open, because everything in it is live state. */
  render(): void {
    const pop = this.pop
    pop.textContent = ''
    const { store } = this.host
    const doc = store.doc
    const st = this.state()
    const peers = this.peers()
    const mine = this.me()
    const iAmOwner = isOwner(doc)

    // YOUR NAME, first: it is what shows up on everyone else's screen.
    const row = el('label', 'dx-share-name')
    row.append(el('span', '', t('Your name')))
    const name = document.createElement('input')
    name.type = 'text'
    name.className = 'dx-share-in'
    name.value = lsGet('bento-author') || ''
    name.placeholder = t('Guest')
    name.title = t('Shown next to your cursor and in the People list — stored only in this browser.')
    name.addEventListener('input', () => lsSet('bento-author', name.value))
    name.addEventListener('change', () => this.host.session.hello())
    row.append(name)
    pop.append(row)

    if (mine.role || peers.length) pop.append(el('div', 'dx-share-label', t('People')))
    if (mine.role) {
      const meRow = el('div', 'dx-pitem dx-pme')
      const myName = lsGet('bento-author') || t('Guest')
      meRow.append(el('span', 'dx-pname', `${myName} (${t('you')})`))
      meRow.append(el('span', 'dx-pwhere', [this.roleLabel(mine.role), fingerprint(mine.pub)].filter(Boolean).join(' · ')))
      meRow.title = mine.pub
        ? t('Your key on THIS device: {fp}. Another device counts as a new person until the owner removes it.', { fp: fingerprint(mine.pub) })
        : t('View-only copy — it holds no signing key.')
      pop.append(meRow)
    }
    if (peers.length) {
      const list = el('div', 'dx-plist')
      for (const p of peers) {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'dx-pitem'
        const d = el('span', 'dx-pdot', initial(p.name))
        d.style.background = p.color
        item.append(d, el('span', 'dx-pname', p.name))
        const sheet = doc.sheets.find((s) => s.id === p.sheet)
        const where = [this.roleLabel(p.role), sheet ? sheet.name : ''].filter(Boolean).join(' · ')
        if (where) item.append(el('span', 'dx-pwhere', where))
        if (p.pub) item.title = `${t('Key-verified identity')} · ${fingerprint(p.pub)}`
        item.addEventListener('click', () => { this.close(); if (sheet) this.host.goToSheet(sheet.id) })
        // Remove is the OWNER's: a signed revocation of ONE device key.
        const c = collabOf(doc)
        if (iAmOwner && p.pub && p.pub !== c?.owner) {
          const kick = el('span', 'dx-pkick', '✕')
          kick.title = t('Remove {name} — revokes this device’s access; everyone else is unaffected', { name: p.name })
          kick.addEventListener('click', (ev) => {
            ev.stopPropagation()
            if (!confirm(t('Remove {name} from this workbook? Their copy drops to read-only.', { name: p.name }))) return
            this.close()
            const tr = onlineTransport()
            void Promise.resolve(tr && c?.owner && c.ownerPriv ? tr.revokeKey(p.pub!, c.owner, c.ownerPriv) : false)
              .then((done) => this.host.toast(done
                ? t('{name} was removed', { name: p.name })
                : t('Couldn’t reach the live session')))
          })
          item.append(kick)
        }
        list.append(item)
      }
      pop.append(list)
    }

    // The one export every copy can make — it hands over no capability, so
    // even an offline or view-only copy may make it.
    const readingAct = () => this.action(ICONS.book, t('Save a reading copy…'),
      t('A locked copy for handing out: it opens read-only, carries none of this workbook’s keys, and never joins the live session.'),
      () => { this.close(); void this.host.shareCopy('reading') }, 'reading')

    if (st === 'offline') {
      pop.append(el('div', 'dx-pnote', t('Offline mode is on — nothing leaves this computer.')))
      pop.append(el('div', 'dx-pnote', t('Windows on this computer still sync; turn offline mode off in Settings to work with someone elsewhere.')))
      pop.append(el('div', 'dx-share-label', t('Share a copy')), readingAct())
      return
    }
    const status = el('div', 'dx-pstatus')
    status.dataset.state = st
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

    if (!canWrite(doc)) {
      pop.append(el('div', 'dx-pnote', t('This is a view-only copy — it follows the live session but can’t change this workbook.')))
      pop.append(el('div', 'dx-share-label', t('Share a copy')), readingAct())
      return
    }
    if (st === 'off') {
      pop.append(el('div', 'dx-pnote', peers.length
        ? t('These windows are on this computer. Start a session to work with someone elsewhere.')
        : t('Nothing leaves this file until you start a session.')))
    }

    pop.append(el('div', 'dx-share-label', t('Share a copy')))
    pop.append(readingAct())
    pop.append(this.action(ICONS.people, t('Invite to edit…'),
      t('Saves a copy to send. Whoever opens it edits this workbook live with you (end-to-end encrypted); you stay the owner and can remove them from the People list.'),
      () => { this.close(); void this.host.shareCopy('invite') }, 'invite'))
    pop.append(this.action(ICONS.eye, t('View-only copy…'),
      t('A live viewer: follows every edit as it happens but can never change this workbook — the relay enforces it.'),
      () => { this.close(); void this.host.shareCopy('viewonly') }, 'viewonly'))

    pop.append(el('div', 'dx-menu-sep'))
    if (st === 'off') {
      pop.append(this.action(ICONS.broadcast, t('Go live'),
        t('Connect to the live session without saving a new copy — copies you sent earlier will meet you there.'), () => {
          this.close()
          void this.goLive().then(() => this.host.toast(t('Live — send someone the file to bring them in')))
        }, 'golive'))
    } else {
      pop.append(this.action(ICONS.stop, t('Stop sharing'), t('This copy goes offline; the others carry on'), () => {
        this.close()
        stopSharing(this.host.session, store)
        this.sync()
        this.host.toast(t('Stopped sharing'))
      }, 'stop'))
    }
    // Quiet at the bottom, because it is the nuclear option: every copy already
    // sent stops syncing for good. Remove (above) is the scalpel.
    if (iAmOwner) {
      const reset = this.action(ICONS.lock, t('Reset access…'),
        t('Mints brand-new keys. Every previously sent copy stops syncing for good; share fresh copies afterwards.'),
        () => {
          if (!confirm(t('Reset access? Every copy you’ve sent stops syncing; only copies saved after this can join.'))) return
          this.close()
          void rotateKeys(this.host.session, store).then(() => {
            this.sync()
            this.host.toast(t('Access reset — only copies saved from now on can join'))
          })
        }, 'reset')
      reset.classList.add('dx-paction-danger')
      pop.append(reset)
    }
  }

  /** One row: icon and name on one line; what it does is the tooltip and the
   *  accessible description (the Save menu's row shape). */
  private action(icon: string, label: string, hint: string, run: () => void, key = ''): HTMLElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'dx-btn dx-paction'
    if (key) b.dataset.share = key
    b.innerHTML = icon
    b.append(menuLabel(label, hint, b))
    b.addEventListener('click', run)
    return b
  }

  /** Turn the live session on (idempotent). Sharing a live copy calls it first. */
  async goLive(): Promise<void> {
    if (offlineEnabled()) return
    this.host.session.enableSharing()
    await startSharing(this.host.session, this.host.store)
    this.watchStatus()
    this.sync()
  }

  /**
   * Join the relay if this workbook ARRIVED shared (or was shared this
   * session). The eligibility test is the session's: a fresh workbook and a
   * template stay off the network until somebody chooses to share.
   */
  tryJoin(): void {
    const s = this.host.session
    if (sharingOn(this.host.store) && s.shareEligible() && !onlineTransport()) joinFromDoc(s, this.host.store)
    this.watchStatus()
    this.sync()
  }

  /** Repaint when the CONNECTION changes, not only when the room's population does. */
  watchStatus(): void {
    const tr = onlineTransport()
    if (!tr || tr === this.watched) return
    this.watched = tr
    const prev = tr.onStatus
    tr.onStatus = (s) => { prev?.(s); this.sync() }
  }
}
