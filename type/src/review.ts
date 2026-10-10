// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE REVIEW EXPERIENCE — turning the marks track.ts records into something a
// reviewer can actually get through.
//
// track.ts proved the engine: a tracked change is a mark, accepting or
// rejecting one is a pure function, and a document with eighty of them still
// round-trips both ways. None of that is usable on an eighty-change document
// without three more things, and this file is exactly those three:
//
//   1. NAVIGATION. Next / previous change, from wherever the caret is —
//      `changeAt`/`stepChange` in track.ts do the arithmetic; this file wires
//      it to the caret, the keyboard and the scroll position.
//   2. ACCEPT/REJECT AT THE CARET. Not only from a card in a list — a
//      reviewer reads top to bottom and decides as they go.
//   3. DISPLAY MODE. All markup (today's default), No markup (as if every
//      change were accepted) and Original (as if every change were
//      rejected). A VIEWER preference, in localStorage — never the document,
//      for the exact reason comments.ts keeps `commentsHidden` out of it: how
//      a person chooses to read a document is not a term of the agreement.
//      It is CSS only: `<ins>`/`<del>` already carry a `.t-trk` class
//      (inline.ts openTag), so a class on <html> is enough to make either
//      kind read as plain text or vanish. Nothing here calls `resolve` —
//      that is the one function that is allowed to touch the model, and nav,
//      accept-at-caret and display mode all leave it to the reviewer.
//
// The compact review surface (requirement 4) replaces the flat list
// `buildTracked` used to paint directly in main.ts — it is now a PanelSpec
// mounted into the same `reviewPanel` host, so main.ts owns none of this.

import './review.css';
import { registerPanel, registerKey, registerSelection, registerReady, type FeatureContext } from './features.ts';
import { t } from './i18n.ts';
import {
  changes, resolve, resolveAll, changeAt, stepChange, parseTrackView,
  type Change, type TrackView,
} from './track.ts';

// ═══════════════════════════════════════════════════════ display mode

const VIEW_KEY = 'bento-type-track-view';

/** The remembered choice. Never read the document for this — see the header. */
export const trackView = (): TrackView => {
  try { return parseTrackView(localStorage.getItem(VIEW_KEY)); } catch { return 'all'; }
};

export function setTrackView(mode: TrackView): void {
  try {
    if (mode === 'all') localStorage.removeItem(VIEW_KEY);
    else localStorage.setItem(VIEW_KEY, mode);
  } catch { /* private mode — the class below still applies for this session */ }
  applyTrackView();
}

/**
 * Paint the choice as two classes on <html>, mutually exclusive.
 *
 * 'final' hides `del` and strips `ins` styling — a document that reads as if
 * every change were already accepted. 'original' is the mirror: hides `ins`,
 * strips `del` styling — as if every change were rejected. 'all' (the
 * default) needs no class: today's `.t-trk` styling in styles.css already IS
 * "show every mark", which is why that file needed no edit for this feature.
 */
export function applyTrackView(): void {
  const v = trackView();
  document.documentElement.classList.toggle('t-track-final', v === 'final');
  document.documentElement.classList.toggle('t-track-original', v === 'original');
}

registerReady(() => applyTrackView());

// ═══════════════════════════════════════════════════════════ navigation

/**
 * The "current" change for display and for accept/reject-at-caret: the one
 * the caret sits inside, or — if the caret is not on one — the next one
 * coming up, so "3 of 17" means something even while just reading.
 */
function currentIndex(list: readonly Change[], doc: Parameters<typeof stepChange>[0],
                      caret: { id: string; at: number } | null): number | null {
  if (!list.length || !caret) return null;
  const at = changeAt(list, caret.id, caret.at);
  if (at >= 0) return at;
  return stepChange(doc, list, caret.id, caret.at, 1);
}

/** Select the change's range and scroll it into view — nav's other half. */
function gotoChange(ctx: FeatureContext, ch: Change): void {
  ctx.editor.setCaret({ id: ch.block, at: ch.mark.from, to: ch.mark.to });
  ctx.editor.host.querySelector<HTMLElement>(`[data-id="${CSS.escape(ch.block)}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  repaintSurface?.();
}

function step(ctx: FeatureContext, dir: 1 | -1): void {
  const list = changes(ctx.store.doc);
  if (!list.length) { ctx.toast(t('No tracked changes')); return; }
  const caret = ctx.editor.caret();
  const idx = stepChange(ctx.store.doc, list, caret?.id ?? null, caret?.at ?? 0, dir);
  if (idx === null) return;
  gotoChange(ctx, list[idx]);
}

/** Accept or reject whichever change the caret is on (or, failing that, next up). */
function resolveCurrent(ctx: FeatureContext, accept: boolean): void {
  const list = changes(ctx.store.doc);
  if (!list.length) { ctx.toast(t('No tracked changes')); return; }
  const caret = ctx.editor.caret();
  const idx = currentIndex(list, ctx.store.doc, caret);
  if (idx === null) { ctx.toast(t('Put the caret on a tracked change first')); return; }
  const ch = list[idx];
  ctx.store.commit(d => {
    const i = d.body.findIndex(x => x.id === ch.block);
    if (i >= 0) d.body[i] = resolve(d.body[i], ch.mark, accept);
  });
  ctx.refresh();
  // Land on whatever is next, Word-style, so a reviewer can keep going
  // without reaching for the mouse. `ch.mark.from` is still a valid position
  // in the SAME block: resolving only ever changes text at or after it.
  const after = changes(ctx.store.doc);
  const nextIdx = stepChange(ctx.store.doc, after, ch.block, ch.mark.from, 1);
  if (nextIdx !== null) gotoChange(ctx, after[nextIdx]);
  else repaintSurface?.();
}

// mod+alt — the same modifier xref.ts already uses for a shortcut with no
// menu-driven equivalent (⌥⌘R), and Cmd/Ctrl being held stops macOS composing
// Option into an accented character, so this is safe on both platforms without
// blockgrip's ctrl/alt PLATFORM SPLIT. That split exists there because Word
// genuinely binds "move this paragraph" to different keys per platform; there
// is no such prior art for stepping through tracked changes, so one binding
// serves both rather than inventing a difference nobody asked for.
registerKey({ key: 'n', mod: true, alt: true, run: ctx => step(ctx, 1) });
registerKey({ key: 'p', mod: true, alt: true, run: ctx => step(ctx, -1) });
registerKey({ key: 'a', mod: true, alt: true, run: ctx => resolveCurrent(ctx, true) });
registerKey({ key: 'd', mod: true, alt: true, run: ctx => resolveCurrent(ctx, false) });

// ═══════════════════════════════════════════════════ the compact surface

const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

const NEXT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" '
  + 'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
  + '<polyline points="9 6 15 12 9 18"/></svg>';
const PREV_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" '
  + 'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
  + '<polyline points="15 6 9 12 15 18"/></svg>';
const CHECK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" '
  + 'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
  + '<polyline points="20 6 9 17 4 12"/></svg>';
const CROSS_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" '
  + 'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
  + '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

function iconBtn(icon: string, title: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 't-trk-icon';
  b.innerHTML = icon;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', run);
  return b;
}

let repaintSurface: (() => void) | null = null;

function paintSurface(host: HTMLElement, ctx: FeatureContext): void {
  host.replaceChildren();
  const doc = ctx.store.doc;
  const list = changes(doc);

  if (!list.length) {
    const hint = document.createElement('p');
    hint.className = 't-hint';
    hint.textContent = doc.track
      ? t('Tracking is on. Edits you make from now on are recorded here.')
      : t('Turn on "Track changes" in the properties panel, or take a Snapshot from ⋯ and use Review changes.');
    host.appendChild(hint);
    return;
  }

  const caret = ctx.editor.caret();
  const idx = currentIndex(list, doc, caret);

  // ---- the compact surface: current position, step, resolve
  const bar = document.createElement('div');
  bar.className = 't-trk-nav';
  bar.appendChild(iconBtn(PREV_ICON, t('Previous change (⌘⌥P)'), () => step(ctx, -1)));
  const count = document.createElement('span');
  count.className = 't-trk-count';
  count.textContent = idx !== null
    ? t('{n} of {m}', { n: String(idx + 1), m: String(list.length) })
    : (list.length === 1 ? t('1 change') : t('{m} changes', { m: String(list.length) }));
  bar.appendChild(count);
  bar.appendChild(iconBtn(NEXT_ICON, t('Next change (⌘⌥N)'), () => step(ctx, 1)));
  bar.appendChild(iconBtn(CHECK_ICON, t('Accept (⌘⌥A)'), () => resolveCurrent(ctx, true)));
  bar.appendChild(iconBtn(CROSS_ICON, t('Reject (⌘⌥D)'), () => resolveCurrent(ctx, false)));
  host.appendChild(bar);

  const all = document.createElement('div');
  all.className = 't-trk-row';
  for (const [label, accept] of [[t('Accept all'), true], [t('Reject all'), false]] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => {
      ctx.store.commit(d => resolveAll(d, accept));
      ctx.refresh();
    });
    all.appendChild(b);
  }
  host.appendChild(all);

  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    const card = document.createElement('div');
    card.className = 't-card' + (i === idx ? ' on' : '');
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = `${ch.mark.by ?? t('Someone')} · ${ch.mark.t === 'ins' ? t('inserted') : t('deleted')}`;
    const what = document.createElement('div');
    what.className = 'what';
    // the CHANGED TEXT ONLY, in the same ins/del styling the page uses, so the
    // card and the paragraph it points at read as the same thing
    what.innerHTML = ch.mark.t === 'ins' ? `<ins>${esc(ch.text)}</ins>` : `<del>${esc(ch.text)}</del>`;
    card.append(who, what);
    const row = document.createElement('div');
    row.className = 't-trk-row';
    for (const [label, accept] of [[t('Accept'), true], [t('Reject'), false]] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', e => {
        e.stopPropagation();
        ctx.store.commit(d => {
          const bi = d.body.findIndex(x => x.id === ch.block);
          if (bi >= 0) d.body[bi] = resolve(d.body[bi], ch.mark, accept);
        });
        ctx.refresh();
      });
      row.appendChild(b);
    }
    card.appendChild(row);
    card.addEventListener('click', e => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      gotoChange(ctx, ch);
    });
    host.appendChild(card);
  }
}

registerPanel({
  id: 'trackedChanges',
  get label() { return t('Tracked changes'); },
  // a SECTION of the Review tab, beside comments and signatures — the same
  // reasoning comments.ts gives for its own `host`
  host: 'reviewPanel',
  order: 20,
  mount(host, ctx) {
    repaintSurface = () => paintSurface(host, ctx);
    repaintSurface();
  },
  update(host, ctx) { paintSurface(host, ctx); },
});

registerSelection(() => repaintSurface?.());

// ═══════════════════════════════════════════════════ the display-mode control
//
// A VALUE, so it lives on the right — the panel's own rule (features.ts
// PanelSpec.side, and props.ts's header explains why). It cannot join
// props.ts's `documentSection` (this app's boundary keeps that file to one
// owner), so it is its OWN small right-hand panel, stacked below Properties.
// Reusing the panel's own class names (`t-section`, `t-sec-body`, `t-row`) so
// it reads as one more section of the same panel rather than a different
// control entirely — styles.css already defines them, generically, for
// exactly this.

function buildViewPanel(host: HTMLElement, ctx: FeatureContext): void {
  host.replaceChildren();
  const head = document.createElement('div');
  head.className = 't-section';
  head.textContent = t('Review');
  const body = document.createElement('div');
  body.className = 't-sec-body';
  host.append(head, body);

  const row = document.createElement('div');
  row.className = 't-row';
  const label = document.createElement('span');
  label.textContent = t('Display');
  const sel = document.createElement('select');
  const OPTIONS: Array<[TrackView, string]> = [
    ['all', t('All markup')],
    ['final', t('No markup')],
    ['original', t('Original')],
  ];
  for (const [value, text] of OPTIONS) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    if (value === trackView()) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    setTrackView(sel.value as TrackView);
    // Hiding/un-hiding `<ins>`/`<del>` changes the flow's height, so the pages
    // need re-measuring — the same reason a picture finishing decoding does.
    ctx.refresh();
  });
  row.append(label, sel);
  body.appendChild(row);

  const note = document.createElement('p');
  note.className = 't-note';
  note.textContent = t('How you view a document, not a change to it — nothing here is saved into the file.');
  body.appendChild(note);
}

registerPanel({
  id: 'trackView',
  get label() { return t('Review'); },
  side: 'right',
  // below Properties (order 10 in props.ts) — always visible, not contextual
  // on the selection, which is right for a VIEWER preference about the whole
  // document rather than a fact about whatever the caret is in
  order: 90,
  mount(host, ctx) { buildViewPanel(host, ctx); },
});
