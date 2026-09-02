// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Live collaboration for bento/type — the chrome nothing imported yet.
//
// type/src/sync/crdt.ts and type/src/sync/session.ts were complete facades
// over the kernel engine, but until this file nothing in the app constructed
// a SyncSession: no local edit ever became an op, no remote op was ever
// applied, and there was no way for a person to find out the feature exists.
// This is the missing wire: it builds the session, joins same-machine tabs
// over BroadcastChannel unconditionally (that transport is always on — see
// kernel/src/sync/session.ts), joins the online relay when the document is
// share-eligible, and adds a Share control + a presence strip to the topbar.
//
// DORMANCY (docs/PLATFORM.md §5, learned the hard way on bento/slides
// v0.9.0 → v0.9.1: v0.9.0 connected every visitor, including anonymous demo
// traffic). A document that never carried collab credentials and whose author
// never asked to share must not open a network connection just because it was
// opened. `SyncSession` already encodes the rule — `shareEligible()` is true
// only if the doc ARRIVED with `doc.collab` (a saved/shared file) or the user
// called `enableSharing()` this session — and this module never routes around
// it: `startSharing`/`enableSharing` are called ONLY from a click inside the
// Share popover, never from initCollab itself.
//
// type's Editor (src/editor.ts) owns its contentEditable DOM directly and
// never re-renders from a generic store event (see the caret-is-a-model-
// position design in that file's header) — so unlike bento/slides, this
// module has to explicitly ask the editor to redraw after a REMOTE change
// (never after a local one, which the editor has already painted itself).
// That is what the `onRemoteApplied` callback threaded through
// sync/session.ts's SyncSession is for.

import './collab.css';
import { serializeAuto, writeUpdatedFileAs } from '../../kernel/src/save.ts';
import { lsGet, lsSet } from '../../kernel/src/storage.ts';
import { offlineEnabled } from '../../kernel/src/net.ts';
import {
  joinFromDoc, mintInvite, onlineTransport, rotateKeys,
  sharingOn, startSharing, stopSharing,
} from './sync/online.ts';
import { SyncSession, hostStore, type Peer, type SyncNotice } from './sync/session.ts';
import type { Store } from './store.ts';
import type { Editor } from './editor.ts';
import type { TypeDoc } from './model.ts';
import { t } from './i18n.ts';

// ─────────────────────────────────────────────────────────────── small DOM

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

let toastEl: HTMLElement | null = null;
let toastT: number | undefined;
function toast(msg: string) {
  if (!toastEl) {
    toastEl = el('div', 'tc-toast');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl!.classList.remove('on'), 2400) as unknown as number;
}

function noticeText(n: SyncNotice): string {
  switch (n.code) {
    case 'too-large':
      return n.media
        ? 'That image is too large to share live (about 1 MB max). It’s saved in your copy, but collaborators won’t see it.'
        : 'That change is too large to share live (about 1 MB max). It’s saved in your copy, but collaborators won’t see it.';
    case 'room-full':
      return 'This live session has run out of room. Your change is saved in your copy, but collaborators won’t see it.';
    case 'storage-failed':
      return 'The live session couldn’t store that change. It’s saved in your copy, but collaborators won’t see it.';
    case 'rate-limited':
      return 'Too many changes at once — live sync is catching up.';
  }
}

/** A copy sent for someone else to work on must not carry the owner's keys. */
function stripCollabSecrets(doc: TypeDoc, opts: { keepRoom?: boolean } = {}) {
  if (!doc.collab) return;
  if (!opts.keepRoom) { delete doc.collab; return; }
  delete doc.collab.ownerPriv;
  delete doc.collab.invite;
}

/** Where a peer is, in terms someone reading the sidebar understands. */
function blockLabel(doc: TypeDoc, blockId: string): string {
  const i = doc.body.findIndex(b => b.id === blockId);
  if (i < 0) return '';
  return `¶ ${i + 1} of ${doc.body.length}`;
}

// ───────────────────────────────────────────────────────────────── the wire

export function initCollab(store: Store, editor: Editor): void {
  const paper = document.getElementById('paper');

  const session = new SyncSession(
    store,
    () => ({ block: editor.caret()?.id ?? '' }),
    () => { editor.render(); repaint(); },
  );

  // Connect to the relay if the current doc is live AND share-eligible.
  // Same-machine tabs already sync unconditionally (BroadcastChannel, wired
  // inside SyncSession's own constructor) — this only concerns the online
  // relay, which is the half that could phone home for an anonymous visitor.
  function tryJoin() {
    if (sharingOn(hostStore(store)) && session.shareEligible() && !onlineTransport()) {
      joinFromDoc(session, hostStore(store));
      wireOnlineStatus();
    }
  }
  tryJoin();
  store.on(() => tryJoin());

  // Sharing sends the CRDT state along with every saved copy (doc.collab.sync)
  // so an offline-edited copy can rejoin as a true fork later (PLATFORM §5).
  // Debounced rather than hooked to the Save button: this module owns no part
  // of main.ts's save() beyond the one initialisation call it was given, and
  // a stamp that is at most a beat stale is exactly as good as one taken at
  // the instant of the click — the state itself is already flushed/diffed.
  let stampT: number | undefined;
  store.on(() => {
    if (!sharingOn(hostStore(store))) return;
    clearTimeout(stampT);
    stampT = setTimeout(() => session.stampInto(store.doc), 500) as unknown as number;
  });

  // ── topbar: Share button + presence strip ────────────────────────────────

  // Mounted into `.t-right`, the bar's right-hand cluster.
  //
  // This originally anchored to `.t-spacer`, which does not exist in this
  // app's markup — and the `if (bar && spacer)` guard below turned that into a
  // SILENT no-op: the engine wired up, credentials minted, and no Share button
  // ever appeared. A lookup that returns null behind a truthiness guard is the
  // recurring way chrome goes missing here without anything looking broken.
  const bar = document.querySelector('.t-bar');
  const spacer = document.querySelector('#theme') ?? document.querySelector('#save');
  const presenceBox = el('div', 'tc-presence');
  const wrap = el('div', 'tc-wrap');
  const shareB = el('button', 'tc-share-btn');
  shareB.textContent = t('Share');
  shareB.title = t('Share — invite people to edit live, or send a view-only copy');
  const popover = el('div', 'tc-pop');
  wrap.append(shareB, popover);
  const host = spacer?.parentElement ?? bar;
  if (host && spacer) {
    host.insertBefore(presenceBox, spacer);
    host.insertBefore(wrap, spacer);
  } else {
    // Never fail silently again: if the anchor is gone, say so loudly enough
    // that the next person sees it in the console instead of wondering where
    // the Share button went.
    console.warn('[collab] topbar anchor not found — Share button not mounted');
  }

  shareB.addEventListener('click', () => {
    wrap.classList.toggle('open');
    if (wrap.classList.contains('open')) renderPanel();
  });
  document.addEventListener('pointerdown', (ev) => {
    if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open');
  });

  function wireOnlineStatus() {
    const tr = onlineTransport();
    if (!tr) {
      shareB.classList.remove('live', 'connecting');
      shareB.title = t('Not sharing yet — click to start a live session');
      return;
    }
    tr.onStatus = () => wireOnlineStatus();
    shareB.classList.toggle('live', tr.status === 'open');
    shareB.classList.toggle('connecting', tr.status !== 'open');
    shareB.title = tr.status === 'open'
      ? t('Live — this document is being shared')
      : t('Connecting to the live session…');
    if (wrap.classList.contains('open')) renderPanel();
  }

  function repaint() {
    renderPresence();
    if (wrap.classList.contains('open')) renderPanel();
  }

  function renderPresence() {
    presenceBox.replaceChildren();
    const peers = session.peers();
    const MAX = 3;
    for (const p of peers.slice(0, MAX)) {
      const chip = el('button', 'tc-avatar');
      chip.style.background = p.color;
      chip.textContent = (p.name || '?').trim().charAt(0).toUpperCase() || '?';
      chip.title = `${p.name} — ${blockLabel(store.doc, p.slide) || 'in the document'} (click to follow)`;
      chip.addEventListener('click', () => {
        const node = paper?.querySelector<HTMLElement>(`[data-id="${CSS.escape(p.slide)}"]`);
        node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      presenceBox.appendChild(chip);
    }
    const extra = peers.length - MAX;
    if (extra > 0) {
      const more = el('button', 'tc-avatar tc-avatar-more');
      more.textContent = `+${extra}`;
      more.title = `${extra} more — click to see everyone`;
      more.addEventListener('click', () => { wrap.classList.add('open'); renderPanel(); });
      presenceBox.appendChild(more);
    }
  }

  let known = new Map(session.peers().map(p => [p.actor, p.name]));
  session.onPeers(() => {
    repaint();
    const now = new Map(session.peers().map(p => [p.actor, p.name]));
    if (now.size <= 8) {
      for (const [actor, name] of now) if (!known.has(actor)) toast(`${name} joined`);
      for (const [actor, name] of known) if (!now.has(actor)) toast(`${name} left`);
    }
    known = now;
  });
  session.onNotice((n) => toast(noticeText(n)));

  // ── the popover itself ────────────────────────────────────────────────

  function action(label: string, primary: boolean, onClick: () => void, title = ''): HTMLButtonElement {
    const b = el('button', primary ? 'tc-btn tc-btn-primary' : 'tc-btn');
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    popover.appendChild(b);
    return b;
  }
  function note(text: string): HTMLElement {
    const n = el('div', 'tc-note');
    n.textContent = text;
    popover.appendChild(n);
    return n;
  }

  async function goLive() {
    if (offlineEnabled()) return;
    session.enableSharing();
    await startSharing(session, hostStore(store));
    wireOnlineStatus();
  }

  async function inviteToEdit() {
    await goLive();
    const c = store.doc.collab;
    if (!(c?.room && c.key && c.v === 2 && c.ownerPriv)) {
      toast(t('Only the document owner can mint editor invites'));
      return;
    }
    session.stampInto(store.doc);
    const clone: TypeDoc = JSON.parse(JSON.stringify(store.doc));
    stripCollabSecrets(clone, { keepRoom: true });
    clone.collab!.invite = await mintInvite(c.ownerPriv, 'writer');
    clone.collab!.on = true;
    try {
      const ok = await writeUpdatedFileAs(await serializeAuto(clone), clone, { suffix: 'invite' });
      if (ok) toast(t('Editor copy saved — recipients join live with edit access'));
    } catch {
      toast(t('Saving failed'));
    }
  }

  async function saveViewOnlyCopy() {
    await goLive();
    const c = store.doc.collab;
    if (!c?.room || !c.key) { toast(t('This document has no live session to follow')); return; }
    const clone: TypeDoc = JSON.parse(JSON.stringify(store.doc));
    clone.collab = { ...c, role: 'reader', on: true, sync: undefined };
    stripCollabSecrets(clone, { keepRoom: true });
    try {
      const ok = await writeUpdatedFileAs(await serializeAuto(clone), clone, { suffix: 'viewonly' });
      if (ok) toast(t('View-only copy saved — it follows the live session'));
    } catch {
      toast(t('Saving failed'));
    }
  }

  function renderPanel() {
    popover.replaceChildren();

    const nameRow = el('div', 'tc-name-row');
    nameRow.title = t('Shown next to your cursor and in the People list — stored only in this browser.');
    const nameLabel = el('label');
    nameLabel.textContent = t('Your name');
    const nameInput = el('input');
    nameInput.type = 'text';
    nameInput.placeholder = t('Guest');
    nameInput.value = lsGet('bento-author') ?? '';
    nameInput.addEventListener('change', () => {
      lsSet('bento-author', nameInput.value.trim());
      session.hello();
    });
    nameRow.append(nameLabel, nameInput);
    popover.appendChild(nameRow);

    const cme = store.doc.collab;
    const roleLabel = (r?: string) => r === 'owner' ? t('Owner') : r === 'viewer' ? t('Viewer') : r === 'editor' ? t('Editor') : '';

    if (cme) {
      let myRole: 'owner' | 'editor' | 'viewer' | undefined;
      if (cme.role === 'reader') myRole = 'viewer';
      else if (cme.v === 2 && cme.ownerPriv) myRole = 'owner';
      else if (cme.v === 2 && cme.invite) myRole = 'editor';
      if (myRole) {
        const label = el('div', 'tc-label');
        label.textContent = t('People');
        popover.appendChild(label);
        const me = el('div', 'tc-peer tc-me');
        const who = el('span', 'who');
        who.textContent = t('{name} (you)', { name: lsGet('bento-author') || t('Guest') });
        const where = el('span', 'where');
        where.textContent = roleLabel(myRole);
        me.append(who, where);
        popover.appendChild(me);
      }
    }

    const peers = session.peers();
    if (peers.length) {
      const list = el('div', 'tc-peers');
      for (const peer of peers as Peer[]) {
        const row = el('button', 'tc-peer');
        const dot = el('span', 'dot');
        dot.style.background = peer.color;
        const who = el('span', 'who');
        who.textContent = peer.name;
        const where = el('span', 'where');
        where.textContent = [roleLabel(peer.role), blockLabel(store.doc, peer.slide)].filter(Boolean).join(' · ');
        row.append(dot, who, where);
        row.title = t('{name} — click to follow', { name: peer.name });
        row.addEventListener('click', () => {
          const node = paper?.querySelector<HTMLElement>(`[data-id="${CSS.escape(peer.slide)}"]`);
          node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        list.appendChild(row);
      }
      popover.appendChild(list);
    }

    if (offlineEnabled()) {
      note(t('Offline mode is on — nothing leaves this computer.'));
      note(t('Tabs on this machine still sync; turn offline mode off to collaborate online.'));
      return;
    }

    const tr = onlineTransport();
    const on = sharingOn(hostStore(store)) && !!tr;
    const status = note('');
    status.classList.add('tc-status');
    if (on) {
      const n = session.peers().length + 1;
      status.textContent = tr!.status === 'open' ? t('● Live — {n} connected', { n: String(n) }) : t('● Connecting…');
      status.classList.toggle('ok', tr!.status === 'open');
    } else {
      status.textContent = t('○ Not live — turns on when you share');
    }

    const canWrite = !!cme && cme.role !== 'reader';
    if (canWrite) {
      const label = el('div', 'tc-label');
      label.textContent = t('Share a copy');
      popover.appendChild(label);
      action(t('Invite to edit…'), true, () => void inviteToEdit(),
        t('Saves a copy to send. Whoever opens it edits this document live with you; you stay the owner and can remove them from the People list.'));
      action(t('View-only copy…'), false, () => void saveViewOnlyCopy(),
        t('A live viewer: follows every edit as it happens but can never change the document.'));
    } else {
      note(t('This is a view-only copy — it follows the live session but can’t change the document.'));
    }

    if (canWrite) {
      popover.appendChild(el('div', 'tc-sep'));
      if (on) {
        action(t('Stop sharing'), false, () => {
          stopSharing(session, hostStore(store));
          wireOnlineStatus();
          renderPanel();
        }, t('Disconnect this document from the live session. Copies keep their last state and can rejoin if you go live again.'));
      } else {
        action(t('Go live'), false, () => void goLive().then(renderPanel),
          t('Connect to the live session without saving a new copy — copies you sent earlier will meet you there.'));
      }
      action(t('Reset access…'), false, async () => {
        if (!confirm(t('Reset access? Every copy you’ve sent stops syncing; only copies saved after this can join.'))) return;
        await rotateKeys(session, hostStore(store));
        toast(t('Access reset — only copies saved from now on can join'));
        renderPanel();
      }, t('Mints brand-new keys. Every previously sent copy stops syncing for good; share fresh copies afterwards.'));
    }
  }

  renderPresence();
  wireOnlineStatus();

  // scripting surface, per PLATFORM §7 (mirrors bento/slides window.bento.sync)
  const w = window as unknown as { bento?: Record<string, unknown> };
  if (w.bento) {
    w.bento.sync = {
      get actor() { return session.actor; },
      peers: () => session.peers(),
      flush: () => session.flush(),
      transports: () => session.transportKinds,
      share: () => { void goLive(); return store.doc.collab; },
      unshare: () => stopSharing(session, hostStore(store)),
      online: () => onlineTransport()?.status ?? 'off',
    };
  }
}
