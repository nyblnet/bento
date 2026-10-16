// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Autosave + crash recovery for bento/type.
//
// Today, closing the tab or crashing loses everything since the last manual
// ⌘S — for a word processor that is the worst gap on the list. The STORAGE
// already exists in the shared kernel (kernel/src/autosave.ts: IndexedDB, two
// stores — a single latest-per-docId `recovery` and a capped `versions`
// timeline). This module is the app-side wiring: when to snapshot, what
// counts as "the same content", and the Restore/Discard banner on boot.
// Modelled directly on slides/src/autosave.ts — read that file's header
// before changing the shape of this one.
//
// docContentKey stays HERE, not in the kernel, for the same reason slides
// keeps its own: "what counts as content" is a per-app model question the
// kernel must never see. It reuses canon.ts's `canonicalize` for the
// SERIALIZATION — canonical key order, NFC, volatile fields dropped at every
// level — but NOT canon.ts's VOLATILE set, and that distinction is the whole
// point of `NOT_EDIT` below.
//
// This file used to reuse VOLATILE too, on the argument that "one notion of
// same content" beats two that could drift. But they are not one notion.
// VOLATILE answers "what may a SIGNATURE not cover?", and a signature must
// exclude itself. NOT_EDIT answers "what may the recovery snapshot hold that
// is NOT work the file on disk lacks?" — and a signature is work. Sharing the
// set made every signature invisible to recovery: sign, crash before anything
// wrote the file, reload, and the snapshot holding it was silently discarded.
//
// Feature registration: this module is wired through the feature registry
// (features.ts registerReady), not main.ts — see registry.ts for the one
// import line that switches it on. It never touches main.ts.
//
// Registered once, at import time, mirroring every other feature module.

import { isEncryptionActive } from '../../kernel/src/save.ts';
import {
  putRecovery, getRecovery, clearRecovery, addVersion, listVersions, pruneOld,
  clearVersions, recoveryLooksOlder, onRecoveryOff, type Snapshot,
} from '../../kernel/src/autosave.ts';
import { canonicalize } from './canon.ts';
import { registerReady, type FeatureContext } from './features.ts';
import { withoutEmbeddedCaps, type TypeDoc } from './model.ts';
import { gateRestored } from './restoregate.ts';
import { t } from './i18n.ts';

export { putRecovery, getRecovery, clearRecovery, addVersion, listVersions, pruneOld, clearVersions };
export type { Snapshot };

/**
 * What a recovery snapshot may differ in WITHOUT holding any unsaved work.
 *
 * Bookkeeping — a save stamps `modified`, a save rewrites the cached
 * `preview`, autosave tags its own `autosave`. These three are the set kernel
 * agreed to use for a shared NOT_EDIT when it adds a shared docContentKey
 * (not on main as of this commit), so type lines up if it ever moves onto that
 * helper. Capability — `collab`, and the CRDT `sync` state
 * that lives inside it — churns on every round-trip and is never something to
 * offer back.
 *
 * Deliberately NOT here: `signatures`, `comments`, `revisions`. Each is work an
 * author did that the file on disk can lack, so each must trip the banner.
 * This is a denylist on purpose, for the reason canon.ts gives for its own: a
 * field added to TypeDoc later is counted as work by default, and the failure
 * that default buys is an extra Restore banner rather than lost work.
 */
export const NOT_EDIT: ReadonlySet<string> = new Set([
  'modified', 'preview', 'autosave',   // bookkeeping
  'collab', 'sync',                    // capability
]);

/** The content that matters for "is the snapshot different from the file". */
export function docContentKey(doc: TypeDoc): string {
  return canonicalize(doc, { volatile: NOT_EDIT });
}

/**
 * May the CURRENT document's plaintext touch IndexedDB right now?
 *
 * bento/type has no encryption feature yet — `isEncryptionActive()` can
 * never return true today — but the guard costs nothing and is the one line
 * that must already be correct the day encryption ships, exactly as it is in
 * slides/src/autosave.ts. Never remove this without confirming that day has
 * not arrived. Exported (rather than kept as a private `if`) so the rig can
 * assert the guard directly against the kernel's real encryption state,
 * instead of trusting that the call site was written correctly.
 */
export function canSnapshot(): boolean {
  return !isEncryptionActive();
}

const AUTOSAVE_DEBOUNCE_MS = 2500;
const VERSION_THROTTLE_MS = 120_000; // one version snapshot per 2 minutes of edits, like slides

let autosaveTimer: ReturnType<typeof setTimeout> | 0 = 0;
let lastVersionAt = 0;

function scheduleAutosave(ctx: FeatureContext) {
  if (ctx.store.doc.readonly) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { void runAutosave(ctx); }, AUTOSAVE_DEBOUNCE_MS);
}

async function runAutosave(ctx: FeatureContext): Promise<void> {
  const doc = ctx.store.doc;
  if (doc.readonly) return;
  // Never write an encrypted document's plaintext to IndexedDB — that would
  // put a legible copy on disk beside a file whose whole purpose is that it
  // is not legible. See canSnapshot() above.
  if (!canSnapshot()) return;
  // A snapshot lands in IndexedDB, which on file:// any local page can read —
  // so embeds go in without another document's sharing keys.
  const safe = withoutEmbeddedCaps(doc);
  const stored = await putRecovery(safe);
  if (!stored) return; // no usable IndexedDB here (private browsing, some file:// contexts)
  if (Date.now() - lastVersionAt > VERSION_THROTTLE_MS) {
    lastVersionAt = Date.now();
    await addVersion(safe);
  }
}

async function checkRecovery(ctx: FeatureContext): Promise<void> {
  const doc = ctx.store.doc;
  const snap = await getRecovery(doc.docId);
  if (!snap) return;
  // A snapshot is foreign input (restoregate.ts): format-checked, and never
  // allowed to bring its own identity. Anything parseDoc refuses is simply
  // not offered — the file on disk is still the file.
  const recovered = gateRestored(snap.json, doc);
  if (!recovered) return;
  // The file on disk already has these edits (this save cycle wrote both) —
  // nothing to offer back. Compared with the shared content key, not a
  // byte comparison, so volatile churn (modified timestamps, sync state)
  // never trips a false banner.
  if (docContentKey(recovered) === docContentKey(doc)) return;
  showRecoveryBanner(ctx, snap);
}

let styleInjected = false;
function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.t-recover {
  position: fixed; left: 50%; top: 14px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px;
  background: var(--field); color: var(--ink);
  border: 1px solid var(--line); border-radius: 10px;
  padding: 9px 12px; font-size: 13px;
  box-shadow: 0 10px 34px rgb(0 0 0 / .28), 0 2px 8px rgb(0 0 0 / .12);
  z-index: 210; max-width: min(560px, calc(100vw - 32px));
}
.t-recover > span:first-child { flex: 1 1 auto; }
`;
  document.head.appendChild(style);
}

/**
 * What the recovery banner offers — maintainer ruling (9), 2026-10-15.
 *
 * When the recovered copy LOOKS OLDER than the file just opened (kernel
 * recoveryLooksOlder: the snapshot's time is before the file's `modified`), it
 * WARNS and makes keeping the file the default. It never hides the copy: the
 * two clocks come from different devices, and hiding a copy that was really
 * newer would lose work, which is the worse failure. When the age is unknown
 * (either time missing or unparseable) there is no warning — and the ordinary
 * banner makes no claim that the copy is newer or safe either.
 */
export function recoveryBanner(snap: Snapshot, doc: TypeDoc): { older: boolean; defaultAction: 'keep' | 'restore' } {
  const older = recoveryLooksOlder(snap, doc);
  return { older, defaultAction: older ? 'keep' : 'restore' };
}

function showRecoveryBanner(ctx: FeatureContext, snap: Snapshot): void {
  ensureStyle();
  document.querySelector('.t-recover')?.remove();
  const bar = document.createElement('div');
  bar.className = 't-recover';
  bar.setAttribute('role', 'alert');
  const plan = recoveryBanner(snap, ctx.store.doc);
  const when = new Date(snap.at).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  const msg = document.createElement('span');
  msg.textContent = plan.older
    ? t('This recovered copy looks older than the file you opened. Keep the file unless you know it’s newer.')
    : t('Unsaved changes from {when} were found.', { when });
  const restore = document.createElement('button');
  restore.className = plan.older ? 't-btn' : 't-btn t-primary';
  restore.type = 'button';
  restore.textContent = plan.older ? t('Restore anyway') : t('Restore');
  restore.addEventListener('click', () => {
    // Gated AGAIN, against the document open at the click: identity comes from
    // the live document, and that can change while this banner is up (Stop
    // sharing, Reset access). Through the store, so this is one ⌘Z away from
    // undone — never a silent, un-undoable swap of the document under the author.
    const gated = gateRestored(snap.json, ctx.store.doc);
    // Never fall back to the copy gated when the banner appeared: its identity
    // was the document's THEN, which is the staleness this re-gate exists for.
    if (!gated) { bar.remove(); return; }
    // RECOVER: the person chose this copy over the file, so its content AND its
    // history come back together — revisions and the signatures over them are
    // one unit and are never split (restorerules.ts).
    ctx.store.restore(gated, 'recover');
    ctx.refresh();
    bar.remove();
    ctx.toast(t('Restored your unsaved changes'));
  });
  const dismiss = document.createElement('button');
  dismiss.className = plan.older ? 't-btn t-primary' : 't-btn';
  dismiss.type = 'button';
  // Keeping the file and discarding the recovered copy are the same act; when
  // the copy looks older, it is named for what the person is choosing.
  dismiss.textContent = plan.older ? t('Keep the file') : t('Discard');
  dismiss.addEventListener('click', () => { void clearRecovery(ctx.store.doc.docId); bar.remove(); });
  // The DEFAULT is first in the bar and takes focus: keep the file when the copy
  // looks older, restore otherwise.
  if (plan.defaultAction === 'keep') bar.append(msg, dismiss, restore);
  else bar.append(msg, restore, dismiss);
  document.body.appendChild(bar);
  (plan.defaultAction === 'keep' ? dismiss : restore).focus();
}

/**
 * Crash recovery switched off for this document — ruling (9). The kernel's
 * per-document store refuses a recovery copy it cannot keep (too large), and
 * says so once through onRecoveryOff. Shown once, dismissible, never a modal:
 * the advice is to save often, and the person should be able to keep working.
 */
let recoveryOffShown = false;
function showRecoveryOff(): void {
  if (recoveryOffShown) return;
  recoveryOffShown = true;
  ensureStyle();
  const bar = document.createElement('div');
  bar.className = 't-recover t-recover-off';
  bar.setAttribute('role', 'status');
  const msg = document.createElement('span');
  msg.textContent = t('Crash recovery is off for this document — it’s too large to keep a backup copy. Save often.');
  const close = document.createElement('button');
  close.className = 't-btn';
  close.type = 'button';
  close.textContent = t('Close');
  close.addEventListener('click', () => bar.remove());
  bar.append(msg, close);
  document.body.appendChild(bar);
}

function wireAutosave(ctx: FeatureContext): void {
  if (ctx.store.doc.readonly) return; // a player file has nothing to protect
  void pruneOld();
  void checkRecovery(ctx);
  onRecoveryOff(docId => { if (docId === ctx.store.doc.docId) showRecoveryOff(); });
  ctx.store.on(() => scheduleAutosave(ctx));
}

registerReady(wireAutosave);
