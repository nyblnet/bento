// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE REDLINE SURFACE — comparing the live document against a chosen BASE,
// computed once per "Review changes…" click.
//
// There are two bases now. A SNAPSHOT (`startReview`) is a revision of this
// document, so the redline can be resolved — accept and reject mean something,
// and `applyDecisions` commits. A COMPARISON (`showComparison`, driven by
// compare.ts) is against another FILE, and is a VIEW only: see `resolvable`
// below for why that is not the same feature with a flag.
//
// NOT review.ts. review.ts's tracked changes are live, per-edit, and always
// current — driven by `ins`/`del` marks the document itself carries. This is
// the opposite kind of review: retrospective, computed on demand by
// redline.ts's word-level diff against a saved `doc.revisions` entry, with no
// marks in the document at all. Both are real features and both belong in the
// Review tab; they used to share ONE div (main.ts's old `buildReview` painted
// straight into review.ts's `reviewPanel` by id) and each one's repaint erased
// the other's — review.ts's panel repaints on every store event, and a
// snapshot redline's own Accept/Reject buttons commit to the store, so
// resolving one redline change wiped the redline UI showing it. This module
// gets its OWN host (`redlinePanel`, a sibling section of the Review tab,
// declared in main.ts beside `reviewPanel`) so painting one can never reach
// the other's div.
//
// Registered through the feature registry (registerPanel) rather than reached
// by id from main.ts — the whole reason the two features could collide in the
// first place was main.ts's old `buildReview` doing `getElementById` on a div
// another module also owns. A panel that only ever receives its own host
// element as an argument cannot make that mistake.

import './redlineview.css';
import { registerPanel, type FeatureContext } from './features.ts';
import { redline, apply as applyRedline, describe, type Change, type ChangeSet } from './redline.ts';
import type { Block } from './model.ts';
import { uid } from './model.ts';

const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
const el = (tag: string, cls?: string): HTMLElement => {
  const n = document.createElement(tag); if (cls) n.className = cls; return n;
};

// Module state: the in-progress redline session. `null` until the reviewer
// takes a Snapshot and runs Review — same lifecycle the old main.ts globals
// (`currentSet`/`decided`) had, just no longer reachable from outside this file.
let currentSet: ChangeSet | null = null;
let baseBody: Block[] | null = null;
let baseLabel = '';
const decided = new Map<string, boolean>();

/**
 * WHERE THE BASE CAME FROM, which decides whether the redline is RESOLVABLE.
 *
 * A snapshot redline is resolvable: the base is a revision of THIS document,
 * so "reject" means restore what this document said a moment ago, and the
 * accept/reject arithmetic in `applyDecisions` lands somewhere the author
 * meant to be. A comparison against ANOTHER FILE is not: rejecting there
 * would mean adopting a different document's text wholesale, and comparing is
 * a VIEW — the same rule the theme and the locale follow. So the buttons are
 * not merely disabled in that mode, they are not offered, and `heading`/`note`
 * say what is on screen instead.
 *
 * These are THUNKS, not strings. registerPanel's `label` learned the same
 * lesson: a string resolved when the comparison starts is frozen at that
 * locale, and the About picker rebuilds the workspace under it.
 */
let heading: (() => string) | null = null;
let note: (() => string) | null = null;
let resolvable = true;

// Set on mount, so the two actions below (which don't themselves commit to the
// store — computing a redline is a pure read) can still ask the panel to
// repaint. Accept/Reject DO commit, and every panel's `update` is already
// wired to `store.on` by main.ts's render loop, so those repaint for free —
// this ref only covers the moment nothing in the store changed yet.
let repaint: (() => void) | null = null;

/** ⋯ → Snapshot: record the document as it stands now, the base a later Review compares against. */
export function takeSnapshot(ctx: FeatureContext): void {
  const label = `Revision ${ctx.store.doc.revisions.length + 1}`;
  ctx.store.commit(d => {
    d.revisions.push({ id: uid('rev'), at: new Date().toISOString(), label,
                       body: JSON.parse(JSON.stringify(d.body)) });
  });
  ctx.toast(`${label} recorded — edit, then Review`);
}

/** ⋯ → Review changes…: redline the live document against the latest snapshot. */
export function startReview(ctx: FeatureContext): void {
  if (!ctx.store.doc.revisions.length) { ctx.toast('Take a Snapshot first, then edit, then Review'); return; }
  const base = ctx.store.doc.revisions[ctx.store.doc.revisions.length - 1];
  currentSet = redline({ docId: ctx.store.doc.docId, body: base.body },
                       { docId: ctx.store.doc.docId, body: ctx.store.doc.body },
                       { author: ctx.store.doc.meta?.author || 'you' });
  decided.clear();
  baseBody = base.body;
  baseLabel = base.label;
  heading = null;
  note = null;
  resolvable = true;
  ctx.showPanel('review');
  repaint?.();
}

/**
 * Show a redline whose base is NOT a snapshot of this document — today, another
 * file the reader picked (compare.ts).
 *
 * The caller owns the diff and every word on screen; this only paints. That
 * split is deliberate: the direction of a comparison is the one thing a reader
 * cannot recover from the cards themselves (an insertion and a deletion look
 * identical read backwards), so whoever chose the direction is also the one who
 * writes the sentence naming it, rather than this file guessing from a label.
 */
export function showComparison(ctx: FeatureContext, o: {
  base: { docId: string; body: Block[] };
  set: ChangeSet;
  /** the sentence naming the direction, e.g. “7 changes from “x.html” to this document” */
  heading: () => string;
  /** an optional caveat beneath it — a different docId, repairs made on read */
  note?: () => string;
  /** may the reader accept/reject? FALSE for anything that is only a view */
  resolvable?: boolean;
}): void {
  currentSet = o.set;
  baseBody = o.base.body;
  baseLabel = '';
  decided.clear();
  heading = o.heading;
  note = o.note ?? null;
  resolvable = o.resolvable ?? false;
  ctx.showPanel('review');
  repaint?.();
}

/**
 * Rebuild the live document from BASE plus the accepted changes.
 *
 * Rebuilding from the base rather than patching the live document is what
 * makes "reject" mean anything — the rejected text has to come back.
 * Undecided changes stay as the author left them, so nothing vanishes while
 * the reviewer is still deciding.
 */
function applyDecisions(ctx: FeatureContext): void {
  const accepted = new Set([...decided].filter(([, v]) => v).map(([k]) => k));
  const undecided = currentSet!.changes.filter(c => !decided.has(c.id)).map(c => c.id);
  const take = new Set([...accepted, ...undecided]);
  try {
    const next = applyRedline({ docId: ctx.store.doc.docId, body: baseBody! }, currentSet!, take);
    ctx.store.commit(d => { d.body = next.body; });
    ctx.refresh();
    ctx.toast(decided.size === currentSet!.changes.length
      ? 'All changes resolved' : `${decided.size}/${currentSet!.changes.length} resolved`);
  } catch (e) { ctx.toast(`Could not apply: ${(e as Error).message}`); }
}

function paint(host: HTMLElement, ctx: FeatureContext): void {
  host.replaceChildren();

  if (!currentSet) {
    const hint = el('div', 't-hint');
    hint.textContent = ctx.store.doc.revisions.length
      ? 'Snapshot recorded. Edit the document, then choose "Review changes…" from ⋯ to redline against it.'
      : 'Take a Snapshot from ⋯, edit the document, then "Review changes…" redlines it against that point.';
    host.appendChild(hint);
    return;
  }

  const head = el('div', 't-hint');
  head.textContent = heading ? heading()
    : currentSet.changes.length
      ? `${currentSet.changes.length} change${currentSet.changes.length > 1 ? 's' : ''} since ${baseLabel}`
      : `No changes since ${baseLabel}. Edit the document, then press Review again.`;
  head.style.marginBottom = note ? '4px' : '9px';
  host.appendChild(head);
  if (note) {
    const n = el('div', 't-hint t-redline-note');
    n.textContent = note();
    host.appendChild(n);
  }
  if (!currentSet.changes.length) return;

  // A view-only comparison stops here and shows the cards. Offering a disabled
  // Accept would read as "not yet", when the truth is that this base is not
  // something this document can be resolved against at all.
  if (!resolvable) {
    for (const c of currentSet.changes) host.appendChild(card(c));
    return;
  }

  const bar = el('div'); bar.style.cssText = 'display:flex;gap:6px;margin-bottom:9px';
  for (const [text, val] of [['Accept all', true], ['Reject all', false]] as const) {
    const b = el('button') as HTMLButtonElement;
    b.type = 'button';
    b.textContent = text; b.style.flex = '1';
    b.addEventListener('click', () => {
      for (const c of currentSet!.changes) decided.set(c.id, val);
      applyDecisions(ctx);
    });
    bar.appendChild(b);
  }
  host.appendChild(bar);

  for (const c of currentSet.changes) {
    const box = card(c);
    const btns = el('div', 'btns');
    for (const [text, val] of [['Accept', true], ['Reject', false]] as const) {
      const b = el('button') as HTMLButtonElement;
      b.type = 'button';
      b.textContent = text;
      b.disabled = decided.has(c.id);
      b.addEventListener('click', () => {
        decided.set(c.id, val);
        applyDecisions(ctx);
      });
      btns.appendChild(b);
    }
    box.appendChild(btns);
    host.appendChild(box);
  }
}

/** One change, as the reviewer reads it — with no decision attached to it yet. */
function card(c: Change): HTMLElement {
  const box = el('div', 't-card');
  if (decided.has(c.id)) box.classList.add('done');
  const what = c.kind === 'text'
    ? `${c.removed ? `<del>${esc(c.removed)}</del>` : ''}${c.added ? `<ins>${esc(c.added)}</ins>` : ''}`
    : esc(describe(c));
  box.innerHTML = `<div class="who">${esc(c.author)} · ${c.kind}</div><div class="what">${what}</div>`;
  return box;
}

registerPanel({
  id: 'redline',
  label: 'Snapshot redline',
  // a SECTION of the Review tab, beside tracked changes and signatures — but
  // its OWN div (see the file header): review.ts already owns `reviewPanel`
  // and repaints it on every store event, which is exactly what made the old
  // shared-host version of this feature erase itself.
  host: 'redlinePanel',
  order: 30,
  mount(host, ctx) {
    repaint = () => paint(host, ctx);
    repaint();
  },
  update(host, ctx) { paint(host, ctx); },
});
