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
import { registerKey, registerPaginated, type FeatureContext } from './features.ts';
import { moveUnit, units, canMove } from './move.ts';
import type { Block } from './model.ts';

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
    g.title = isMac() ? t('Move this block (⌃⇧↑ / ⌃⇧↓)') : t('Move this block (Alt+Shift+↑ / ↓)');
    g.setAttribute('aria-label', t('Move this block'));
    g.dataset.for = first.id;
    g.style.top = `${r.top - paperRect.top + 1}px`;
    g.style.insetInlineStart = `${x}px`;
    // mousedown, not click: the caret must survive pressing it, exactly as the
    // toolbar buttons do
    g.addEventListener('mousedown', e => e.preventDefault());
    g.addEventListener('click', e => { e.stopPropagation(); gripMenu(ctx, first.id, g); });
    frag.appendChild(g);
  }
  layer.appendChild(frag);
}

registerPaginated(paintGrips as never);
