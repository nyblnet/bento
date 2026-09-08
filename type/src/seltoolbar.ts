// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE SELECTION TOOLBAR — formatting where the words are.
//
// Select text and a small bar appears over it: the character marks, a link, a
// comment. What Notion, Medium and Google Docs all do, and what a word
// processor wants most, because formatting is a thing you do TO a selection
// and the selection is where your eyes already are.
//
// It renders MARK_TOOLS and the registered link/comment tools rather than
// listing buttons of its own — the same set the properties panel shows. Adding
// a sixth mark means editing one array.
//
// THE ONE RULE THAT MAKES IT WORK: never take the selection away. Every button
// preventDefaults on mousedown, because a focus change collapses the range and
// the bar would act on nothing — the same reason the toolbar buttons do it.

import { t } from './i18n.ts';
import { registerReady, tools, type FeatureContext } from './features.ts';
import { MARK_TOOLS } from './marks.ts';
import type { MarkType } from './inline.ts';

/** Registered tools that act on a SELECTION. Find does not; it acts on the document. */
const SELECTION_TOOLS = ['link', 'comment'];

let bar: HTMLElement | null = null;
let pointerDown = false;

/**
 * Run after the current event has settled.
 *
 * A TIMER, not requestAnimationFrame. What is needed here is "once the
 * selection has finished changing", not "on the next painted frame" — and rAF
 * does not fire at all while the document is hidden, so on a background tab
 * the bar would queue a callback that never ran and then appear, stale, at
 * whatever the selection used to be when the tab came back. The timer is both
 * the more honest description of the wait and the one that cannot get stuck.
 */
const soon = (fn: () => void) => { setTimeout(fn, 0); };

const paperEl = () => document.getElementById('paper');

/** Is the selection a real range inside the document? */
function selectionRange(): Range | null {
  const sel = getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  const paper = paperEl();
  if (!paper || !paper.contains(r.commonAncestorContainer)) return null;
  if (!String(sel).trim()) return null;         // a whitespace-only drag
  return r;
}

function hide(): void {
  bar?.remove();
  bar = null;
}

function build(ctx: FeatureContext): HTMLElement {
  const el = document.createElement('div');
  el.className = 't-selbar';
  // never captured by a save — kernel save.ts strips marked nodes from the clone
  el.setAttribute('data-bento-transient', '');
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', t('Formatting'));

  const active = ctx.editor.activeMarks() as Set<string>;
  for (const m of MARK_TOOLS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 't-selbtn';
    b.innerHTML = m.icon;
    b.title = m.title();
    b.setAttribute('aria-label', m.title());
    b.setAttribute('aria-pressed', String(active.has(m.t)));
    b.classList.toggle('on', active.has(m.t));
    // mousedown, NOT click: a focus change collapses the selection, and the
    // bar would then format nothing.
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', e => {
      e.stopPropagation();
      // NO ctx.refresh() here. editor.toggle already re-renders the block and
      // restores the selection it acted on, and then fires onChange, which is
      // what schedules re-pagination. Calling refresh() on top re-rendered the
      // body a second time and destroyed the restored range — the selection
      // vanished, the bar went with it, and a second click could not reach the
      // words the first one had just formatted. The properties panel's toggles
      // never called it either; this was mine.
      ctx.editor.toggle(m.t as MarkType);
      // re-place it: the block was re-rendered, so the old rects are stale
      soon(() => show(ctx));
    });
    el.appendChild(b);
  }

  const rest = [...tools('format'), ...tools('review')].filter(s => SELECTION_TOOLS.includes(s.id));
  if (rest.length) {
    const sep = document.createElement('span');
    sep.className = 't-selsep';
    el.appendChild(sep);
    for (const spec of rest) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 't-selbtn';
      b.innerHTML = spec.icon;
      const title = typeof spec.title === 'function' ? spec.title() : spec.title;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', e => { e.stopPropagation(); hide(); spec.run(ctx); });
      el.appendChild(b);
    }
  }
  return el;
}

/** Put the bar above the selection, or below it when there is no room. */
function place(el: HTMLElement, r: Range): void {
  const rect = r.getBoundingClientRect();
  if (!rect.width && !rect.height) { hide(); return; }
  const w = el.offsetWidth, h = el.offsetHeight;
  const GAP = 9;

  let top = rect.top + window.scrollY - h - GAP;
  // A selection at the very top of the viewport would put the bar off-screen,
  // so it flips under the text rather than being clipped.
  if (rect.top < h + GAP + 4) top = rect.bottom + window.scrollY + GAP;

  let left = rect.left + window.scrollX + rect.width / 2 - w / 2;
  const min = window.scrollX + 8;
  const max = window.scrollX + document.documentElement.clientWidth - w - 8;
  left = Math.max(min, Math.min(left, max));

  el.style.top = `${Math.round(top)}px`;
  el.style.insetInlineStart = `${Math.round(left)}px`;
}

function show(ctx: FeatureContext): void {
  const r = selectionRange();
  if (!r) { hide(); return; }
  hide();
  bar = build(ctx);
  document.body.appendChild(bar);
  place(bar, r);
}

registerReady(ctx => {
  // While the mouse is down the selection is still being dragged out, and a
  // bar that tracked it would flicker under the cursor and land in the way of
  // the gesture that is creating it.
  document.addEventListener('pointerdown', () => { pointerDown = true; hide(); }, true);
  document.addEventListener('pointerup', () => {
    pointerDown = false;
    soon(() => show(ctx));
  }, true);

  document.addEventListener('selectionchange', () => {
    if (pointerDown) return;
    soon(() => show(ctx));
  });

  // Typing dismisses it: the selection it described is gone the moment a key
  // replaces it.
  paperEl()?.addEventListener('beforeinput', hide);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') hide();
  });

  // Keep it with the words when the page moves under it.
  const reflow = () => { if (bar) { const r = selectionRange(); if (r) place(bar, r); else hide(); } };
  window.addEventListener('scroll', reflow, true);
  window.addEventListener('resize', reflow);
});
