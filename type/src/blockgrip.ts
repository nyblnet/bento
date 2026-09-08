// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE BLOCK GRIP — the handle in the margin that moves a block.
//
// Adapted from bento/spaces, which puts a hover gutter beside every block
// (`.sp-gutter`: a + and a drag grip). Three things had to change on the way,
// and each is a fact about this app rather than a preference:
//
// 1. IT IS AN OVERLAY, NOT PART OF THE BLOCK. spaces nests its gutter inside a
//    `.sp-b` wrapper. Here the block element IS the editable node, and the
//    editor reads text back out of it (render.ts readBlock, called on every
//    keystroke). A button inside it would be read as document text — the
//    grip's own glyph would end up in the paragraph. So the grips live in a
//    positioned layer, exactly as comment highlights already do.
//
// 2. ONE PER UNIT, NOT PER BLOCK. A list item and a table cell are blocks
//    here. A grip on every `td` says a cell can be dragged, which it cannot.
//    move.ts owns that grouping.
//
// 3. NO "+" BUTTON. spaces has one; this app has a single Insert menu driven
//    by the caret, and a second inserter in the margin would put one action in
//    two places — the thing scripts/test-type-chrome.ts exists to prevent.
//
// The layer is marked `data-bento-transient` so kernel save.ts strips it from
// the clone. Without that it would be serialised into the file and re-appear,
// doubled, on every save.

import { t } from './i18n.ts';
import { registerKey, registerPaginated, tools, type FeatureContext } from './features.ts';
import { moveUnit, moveUnitTo, units, canMove, boundaries } from './move.ts';
import type { Block } from './model.ts';

const PLUS_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none"'
  + ' stroke="currentColor" stroke-width="2" stroke-linecap="round">'
  + '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

const GRIP_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">'
  + '<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/>'
  + '<circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>'
  + '<circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

/** Move the unit containing `id`, and keep the caret with it. */
export function move(ctx: FeatureContext, id: string, dir: -1 | 1): boolean {
  const next = moveUnit(ctx.store.doc.body, id, dir);
  if (!next) return false;
  const caret = ctx.editor.caret();
  ctx.store.commit(d => { d.body = next; });
  ctx.editor.render();
  // The caret follows the text, not the position — a move that dumped the
  // caret wherever the old offset now points would put it in a different
  // paragraph, which is how you keep typing into the wrong block.
  if (caret) ctx.editor.setCaret(caret);
  ctx.refresh();
  return true;
}

/** Drop the unit before `target`, which the engine snaps to a unit boundary. */
function moveTo(ctx: FeatureContext, id: string, target: number): boolean {
  const next = moveUnitTo(ctx.store.doc.body, id, target);
  if (!next) return false;
  ctx.store.commit(d => { d.body = next; });
  ctx.editor.render();
  ctx.refresh();
  return true;
}

/** The block the caret is in — what the keyboard shortcut acts on. */
const caretBlock = (ctx: FeatureContext): Block | undefined => {
  const c = ctx.editor.caret();
  return c ? ctx.store.block(c.id) : undefined;
};

/**
 * "Move paragraph up/down" — Word's shortcut, and Word's PLATFORM SPLIT.
 *
 * Windows and Linux: Alt+Shift+Arrow. macOS: Ctrl+Shift+Arrow.
 *
 * Not a nicety. On macOS Option+Shift+Arrow is the system gesture for
 * extending a selection to the previous or next paragraph, and this handler
 * calls preventDefault — so a single binding of Alt+Shift would silently eat a
 * standard text-selection gesture on the platform this is being written on.
 * Word made exactly this split for exactly this reason.
 *
 * The grip is mouse-only, so a keyboard path is not optional: a hover-only
 * affordance with no shortcut is unreachable for anyone who does not use a
 * mouse.
 */
export const isMac = (): boolean =>
  /mac/i.test((navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
              ?? navigator.platform ?? '');

for (const [key, dir] of [['arrowup', -1], ['arrowdown', 1]] as const) {
  registerKey({
    key,
    ...(isMac() ? { ctrl: true } : { alt: true }),
    shift: true,
    run(ctx) {
      const b = caretBlock(ctx);
      if (!b) return;
      if (!move(ctx, b.id, dir)) ctx.toast(dir < 0 ? t('Already at the top.') : t('Already at the end.'));
    },
  });
}

// ───────────────────────────────────────────────────────────── the layer

let openMenu: HTMLElement | null = null;
const closeMenu = () => { openMenu?.remove(); openMenu = null; };
document.addEventListener('click', closeMenu);

/**
 * The margin's + — insert a block after this one.
 *
 * It renders `tools('insert')`, which is the SAME registry the toolbar's
 * Insert menu renders. Not a second menu with its own list: one home, two
 * triggers, so the tenth insert appears in both without anybody remembering
 * to add it twice.
 *
 * The insert tools all act at the CARET, so this puts the caret at the end of
 * the block it belongs to first. That means every one of them works here
 * unmodified — including any added later, which is the point of going through
 * the registry rather than calling the four we happen to know about.
 */
function plusMenu(ctx: FeatureContext, blockId: string, at: HTMLElement): void {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 't-menu t-grip-menu';
  for (const spec of tools('insert')) {
    const b = document.createElement('button');
    b.type = 'button';
    const label = typeof spec.label === 'function' ? spec.label()
      : (spec.label ?? (typeof spec.title === 'function' ? spec.title() : spec.title));
    b.innerHTML = spec.icon + `<span>${label}</span>`;
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', e => {
      e.stopPropagation();
      closeMenu();
      const blk = ctx.store.block(blockId);
      if (blk) ctx.editor.setCaret({ id: blockId, at: blk.text.length });
      spec.run(ctx);
    });
    menu.appendChild(b);
  }
  const r = at.getBoundingClientRect();
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  menu.style.insetInlineStart = `${r.left + window.scrollX}px`;
  document.body.appendChild(menu);
  openMenu = menu;
}

function gripMenu(ctx: FeatureContext, id: string, at: HTMLElement): void {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 't-menu t-grip-menu';
  const items: Array<[string, () => void, boolean]> = [
    [t('Move up'), () => move(ctx, id, -1), canMove(ctx.store.doc.body, id, -1)],
    [t('Move down'), () => move(ctx, id, 1), canMove(ctx.store.doc.body, id, 1)],
  ];
  for (const [label, run, enabled] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.disabled = !enabled;
    b.addEventListener('click', e => { e.stopPropagation(); closeMenu(); run(); });
    menu.appendChild(b);
  }
  const r = at.getBoundingClientRect();
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  menu.style.left = `${r.left + window.scrollX}px`;
  document.body.appendChild(menu);
  openMenu = menu;
}

/**
 * ONE grip at a time — the block under the pointer.
 *
 * Revealing every grip on page hover put a column of handles down the margin
 * of a document at rest, which is noise: nine of them beside a nine-paragraph
 * contract, only ever one of which is wanted. bento/spaces reveals per BLOCK
 * (.sp-b:hover > .sp-gutter) and that is the right behaviour; it is only
 * expressed differently here because the grips live in an overlay rather than
 * inside the block, so CSS cannot do it and this listener must.
 */
function trackPointer(paper: HTMLElement): void {
  if ((paper as HTMLElement & { _gripTracked?: boolean })._gripTracked) return;
  (paper as HTMLElement & { _gripTracked?: boolean })._gripTracked = true;

  const wrap = paper.parentElement;
  wrap?.addEventListener('pointermove', e => {
    if (dragging) return;                       // a drag owns the pointer
    const node = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const block = node?.closest('[data-id]') as HTMLElement | null;
    // While the pointer is IN the margin the nearest grip stays lit, or moving
    // towards a grip to press it would put it out.
    const overGrip = node?.closest('.t-grip') as HTMLElement | null;
    const want = overGrip?.dataset.for ?? blockUnitId(block?.dataset.id);
    for (const g of wrap.querySelectorAll<HTMLElement>('.t-grip')) {
      g.classList.toggle('on', !!want && g.dataset.for === want);
    }
  });
  wrap?.addEventListener('pointerleave', () => {
    if (dragging) return;
    for (const g of wrap.querySelectorAll<HTMLElement>('.t-grip')) g.classList.remove('on');
  });
}

/** The id the grip for this block carries — a unit's FIRST block. */
let unitOf: (id: string | undefined) => string | undefined = () => undefined;
const blockUnitId = (id: string | undefined) => unitOf(id);

// ────────────────────────────────────────────────────────────────── drag

let dragging: { id: string; from: number } | null = null;

/** Where a drop at this y would go, and the y to draw the line at. */
function dropAt(ctx: FeatureContext, paper: HTMLElement, clientY: number):
    { target: number; y: number } | null {
  const body = ctx.store.doc.body;
  const top0 = paper.getBoundingClientRect().top;
  const points: Array<{ target: number; y: number }> = [];
  for (const b of boundaries(body)) {
    if (b < body.length) {
      const el = paper.querySelector<HTMLElement>(`[data-id="${CSS.escape(body[b].id)}"]`);
      if (el) points.push({ target: b, y: el.getBoundingClientRect().top });
    } else {
      const last = body[body.length - 1];
      const el = paper.querySelector<HTMLElement>(`[data-id="${CSS.escape(last.id)}"]`);
      if (el) points.push({ target: b, y: el.getBoundingClientRect().bottom });
    }
  }
  if (!points.length) return null;
  const best = points.reduce((a, b) => Math.abs(b.y - clientY) < Math.abs(a.y - clientY) ? b : a);
  return { target: best.target, y: best.y - top0 };
}

function startDrag(e: PointerEvent, ctx: FeatureContext, grip: HTMLElement,
                   id: string, paper: HTMLElement): void {
  e.preventDefault();
  const startY = e.clientY;
  const layer = grip.parentElement;
  let line: HTMLElement | null = null;
  let moved = false;

  const onMove = (ev: PointerEvent) => {
    // A few pixels of slop before it is a drag, so a click that wobbles still
    // opens the menu rather than starting a move nobody asked for.
    if (!moved && Math.abs(ev.clientY - startY) < 4) return;
    if (!moved) {
      moved = true;
      dragging = { id, from: 0 };
      grip.classList.add('t-grip-dragging');
      document.body.classList.add('t-dragging');
      line = document.createElement('div');
      line.className = 't-droptip';
      layer?.appendChild(line);
    }
    const at = dropAt(ctx, paper, ev.clientY);
    if (at && line) line.style.top = `${at.y}px`;
  };

  const onUp = (ev: PointerEvent) => {
    try { grip.releasePointerCapture?.(ev.pointerId); } catch { /* never captured */ }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    grip.classList.remove('t-grip-dragging');
    document.body.classList.remove('t-dragging');
    line?.remove();
    const wasDrag = moved;
    dragging = null;
    if (!wasDrag) {
      // A click, not a drag — but the `click` event that follows this
      // pointerup bubbles to the document listener that closes menus, so
      // opening synchronously here opened and shut it in one gesture. The
      // timeout puts the open AFTER that click has been dispatched.
      setTimeout(() => gripMenu(ctx, id, grip), 0);
      return;
    }
    const at = dropAt(ctx, paper, ev.clientY);
    if (at) moveTo(ctx, id, at.target);
  };

  // LISTENERS FIRST, capture second and best-effort. setPointerCapture throws
  // NotFoundError when the pointer is not active — always for a synthetic
  // event, and possible for a real one that was released or captured
  // elsewhere. Calling it first meant one throw took the whole gesture with
  // it: no drag AND no menu, because the pointerup handler was never attached
  // either. The drag does not need capture — every listener is on `window` —
  // so a failure here should cost nothing.
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  try { grip.setPointerCapture?.(e.pointerId); } catch { /* not an active pointer */ }
}

/**
 * Paint a grip beside every unit.
 *
 * Runs from the PAGINATED hook: positions are only knowable once the paginator
 * has laid the column out, and this is the same signal footnote sidenotes and
 * page numbers already repaint on.
 */
function paintGrips(ctx: FeatureContext, _metrics: unknown, paper: HTMLElement): void {
  // Into the DECORATIONS layer, which already holds the page rules, the page
  // numbers and the footnote sidenotes — everything that is drawn beside the
  // sheet rather than printed on it. A grip in the margin is one of those, and
  // putting it anywhere else meant inventing a second layer with the same job.
  // It is also what lets the grip use the paper's own ink: the palette gate
  // classifies `.t-deco` as document, and a handle floating over a white page
  // must not take chrome colours, which invert in dark mode while the paper
  // stays white.
  const deco = paper.parentElement?.querySelector<HTMLElement>('.t-deco');
  if (!deco) return;
  let layer = deco.querySelector<HTMLElement>('.t-grip-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 't-grip-layer';
    // stripped from the save clone by kernel save.ts — see the note at the top
    layer.setAttribute('data-bento-transient', '');
    deco.appendChild(layer);
  }
  layer.replaceChildren();

  const body = ctx.store.doc.body;
  if (body.length < 2) return;                 // nothing to reorder

  // Which unit any block belongs to — the pointer lands on a `td` or an `li`
  // and the grip it should light is the one on that unit's first block.
  const owner = new Map<string, string>();
  for (const u of units(body)) {
    for (let k = u.start; k < u.end; k++) owner.set(body[k].id, body[u.start].id);
  }
  unitOf = (id) => (id ? owner.get(id) : undefined);
  trackPointer(paper);

  const paperRect = paper.getBoundingClientRect();
  // Inside the page's own left margin. The 250px gutter this layout allocates
  // is on the RIGHT and already holds footnote sidenotes and comment cards, so
  // mirroring it would mean widening the wrap and shifting the page sideways.
  // marginX is empty by design and easily wide enough.
  const x = Math.max(4, ctx.store.doc.page.marginX - 34);
  const frag = document.createDocumentFragment();

  for (const u of units(body)) {
    const first = body[u.start];
    const node = paper.querySelector<HTMLElement>(`[data-id="${CSS.escape(first.id)}"]`);
    if (!node) continue;
    const r = node.getBoundingClientRect();
    if (!r.height) continue;

    const g = document.createElement('button');
    g.type = 'button';
    g.className = 't-grip';
    g.innerHTML = GRIP_ICON;
    g.title = t('Drag to move, click for options') + ' · '
      + (isMac() ? t('⌃⇧↑ / ⌃⇧↓') : t('Alt+Shift+↑ / ↓'));
    g.setAttribute('aria-label', t('Move this block'));
    g.dataset.for = first.id;
    g.dataset.unit = String(u.start);
    g.style.top = `${r.top - paperRect.top + 1}px`;
    g.style.insetInlineStart = `${x}px`;
    // mousedown, not click: the caret must survive pressing it, exactly as the
    // toolbar buttons do
    g.addEventListener('mousedown', e => e.preventDefault());
    g.addEventListener('pointerdown', e => startDrag(e, ctx, g, first.id, paper));

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 't-grip t-plus';
    plus.innerHTML = PLUS_ICON;
    plus.title = t('Insert below');
    plus.setAttribute('aria-label', t('Insert a block below this one'));
    plus.dataset.for = first.id;
    plus.style.top = `${r.top - paperRect.top + 1}px`;
    plus.style.insetInlineStart = `${x - 24}px`;
    plus.addEventListener('mousedown', e => e.preventDefault());
    plus.addEventListener('click', e => { e.stopPropagation(); plusMenu(ctx, first.id, plus); });

    frag.append(plus, g);
  }
  layer.appendChild(frag);
}

registerPaginated(paintGrips as never);
