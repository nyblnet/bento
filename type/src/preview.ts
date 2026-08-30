// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The still render written into every saved document, for readers with no JS.
//
// WHAT THIS IS FOR (see kernel/src/save.ts registerPreview and the rationale
// in docs/DECISIONS.md — slides established the whole mechanism, this is the
// bento/type renderer for it). Thumbnailers — iOS Files, macOS QuickLook/
// Finder, the Bento Tray app — render HTML with scripting OFF. Until the
// runtime boots, every document is the same bytes plus the boot splash, so a
// folder of contracts and letters thumbnailed as a wall of identical dark
// boxes. A word processor's document is its title and opening paragraphs on a
// white page — that is what makes one contract distinguishable from another,
// and it is what this module produces.
//
// The kernel owns placement, the replace-never-append rule, the encryption
// veto and the output-safety check; this file owns the drawing.
//
// WHY REAL PAGINATION. `type` computes real page boxes (paginate.ts) over a
// continuous flow — the first page is not "the first N blocks", it is exactly
// what the reader would see on screen or on paper, footnote reservations and
// all. A preview that used a fixed block count instead would show a different
// "page one" than the document itself paginates to, which defeats the whole
// point of a first-page thumbnail: recognising THIS document among others.
//
// So: render the WHOLE body once into a hidden, detached host wearing the
// app's own `.t-paper` class (the real stylesheet is already loaded live —
// this module imports no `.css`, it borrows rules already on the page), run
// the real paginator over it, and read back which blocks landed before the
// first page's break. Only THOSE blocks are then re-rendered into the static
// markup that actually reaches the file — never the measuring host itself,
// which is thrown away. That keeps an N-page document's preview bounded by
// one page of content, not by the whole document.
//
// THE CONTENT ITSELF is built the same way print.ts builds a page: the
// PURE string renderer (render.ts's blockHtml/groupBlocks, xref.ts's
// fillXrefsHtml, embed.ts's embedHtml, math.ts's displayMathHtml) — the exact
// functions the shared renderer already uses, so this cannot disagree with
// the app about what a paragraph, a list, a table or an embed looks like.
//
// STATICIZED AFTERWARD, same discipline as spaces/dash: every element is
// walked and stripped of anything that could run, load, accept input, or leak
// through a data attribute a thumbnailer has no business reading. A `src` is
// kept only when it is an embedded `data:` URI — the file is self-contained,
// and a remote URL here would be a preview that phones home from a context
// where nobody could consent.

import { registerPreview, isEncryptionActive } from '../../kernel/src/save.ts';
import type { Block, TypeDoc } from './model.ts';
import { registerReady } from './features.ts';
import { groupBlocks, blockHtml, renderBody, TAG } from './render.ts';
import { paginate } from './paginate.ts';
import { margins, blockStyle } from './layout.ts';
import { docStyleCss } from './docstyles.ts';
import { captionIndex, docLang, fillXrefsHtml } from './xref.ts';
import { embedHtml } from './embed.ts';
import { displayMathHtml } from './math.ts';

/** Above this the preview is trimmed, then dropped to a title card. A preview
 *  is a courtesy; it must never be why a file is large. */
export const PREVIEW_BUDGET = 64 * 1024;

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FONT_STACK_FALLBACK = '"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif';

// ─────────────────────────────────────────────────── measuring page one

/** A CSS font stack value is user data (docs pick their own typeface) and
 *  reaches a `<div style="…">` attribute here, not a stylesheet — quoting
 *  matters less than making sure it cannot end the attribute early. */
function cssFontFamily(family: string): string {
  return family.replace(/["<>]/g, '');
}

/**
 * Which blocks of `doc.body` land on page one, in document order.
 *
 * Renders the WHOLE document into a hidden host wearing the real `.t-paper`
 * class (the app's real stylesheet is already loaded live; this module never
 * imports it), runs the real paginator, then reads back — via the SAME
 * `data-id` attribute every block already carries (render.ts renderBlock) —
 * which blocks' top fell before the first page's break. The host is removed
 * before this returns; nothing it built ever reaches the caller.
 */
function firstPageBlocks(doc: TypeDoc): Block[] {
  if (!doc.body.length) return [];
  const host = document.createElement('div');
  host.className = 't-paper';
  // marked transient defensively — capturePristine runs long before this, so
  // this node can never reach a save, but the convention costs nothing to
  // honour and guards against a future caller that clones the live document.
  host.setAttribute('data-bento-transient', '');
  const m = margins(doc.page);
  host.style.cssText =
    `position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;` +
    `--page-w:${doc.page.width}px;--page-h:${doc.page.height}px;` +
    `--mar-x:${doc.page.marginX}px;--mar-t:${m.top}px;--mar-b:${m.bottom}px;` +
    (doc.type?.family ? `--doc-family:${cssFontFamily(doc.type.family)};` : '') +
    (doc.type?.size ? `--doc-size:${doc.type.size}px;` : '');
  document.body.appendChild(host);
  try {
    renderBody(doc, host);
    const metrics = paginate(doc, host);
    const end = metrics.pages[0]?.end ?? Infinity;
    if (!isFinite(end)) return doc.body.slice();

    const byId = new Map(doc.body.map((b, i) => [b.id, i] as const));
    const top0 = host.getBoundingClientRect().top + m.top;
    let last = -1;
    for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-id]'))) {
      const idx = byId.get(el.dataset.id ?? '');
      if (idx === undefined) continue;
      const top = el.getBoundingClientRect().top - top0;
      if (top < end - 0.5) last = Math.max(last, idx);
    }
    return last >= 0 ? doc.body.slice(0, last + 1) : doc.body.slice(0, 1);
  } catch (err) {
    // Measuring is a nicety; a failed save is not — fall back to "however
    // much of the document fits under a generous line guess" rather than
    // giving up on a preview entirely.
    console.warn('bento/type: page-one measurement failed, using a plain guess', err);
    return doc.body.slice(0, 40);
  } finally {
    host.remove();
  }
}

// ─────────────────────────────────────────────────── content → markup

/** A table, as HTML — the string twin of render.ts renderTable/print.ts
 *  tableHtml, so a preview table cannot drift from what the app actually
 *  draws. A short last row is padded, same as both of those. */
function tableHtml(rows: Block[][]): string {
  const cols = rows[0]?.length ?? 1;
  const cell = (b: Block | undefined) => b ? `<td>${blockHtml(b)}</td>` : '<td></td>';
  const row = (r: Block[]) => `<tr>${Array.from({ length: cols }, (_, c) => cell(r[c])).join('')}</tr>`;
  return `<table class="typ-t">${rows.map(row).join('')}</table>`;
}

/**
 * The flow, as HTML, for exactly the blocks handed in — never the whole
 * document. Built from the same pure string functions print.ts uses for its
 * own page markup: groupBlocks for list/table structure, blockHtml for a
 * block's inline content (marks, notes, cross-references, citations, inline
 * math all resolved), embedHtml/displayMathHtml for the atomic kinds
 * groupBlocks passes through untouched.
 */
function flowHtml(body: Block[], doc: TypeDoc): string {
  const out: string[] = [];
  for (const tok of groupBlocks(body)) {
    if (tok.t === 'open') out.push(`<${tok.kind}>`);
    else if (tok.t === 'close') out.push(`</${tok.kind}>`);
    else if (tok.t === 'table') out.push(tableHtml(tok.rows));
    else if (tok.block.kind === 'embed') out.push(embedHtml(tok.block));
    else if (tok.block.kind === 'image') {
      const b = tok.block, im = b.image;
      if (!im) continue;
      const w = im.w ? ` style="width:${Math.round(im.w * 100)}%"` : '';
      const al = im.align === 'left' || im.align === 'right' ? ` data-align="${im.align}"` : '';
      out.push(`<figure class="typ-fig"${al}><img src="${esc(im.src)}" alt="${esc(im.alt ?? '')}"${w}></figure>`);
    } else if (tok.block.kind === 'math') {
      out.push(`<div class="typ-math">${displayMathHtml(tok.block.text)}</div>`);
    } else {
      const b = tok.block;
      const st = [docStyleCss(doc, b), blockStyle(b)].filter(Boolean).join(';');
      out.push(`<${TAG[b.kind]}${st ? ` style="${esc(st)}"` : ''}>${blockHtml(b)}</${TAG[b.kind]}>`);
    }
  }
  // Caption numbers and cross-references are filled from the FULL document's
  // numbering, not the slice's — "Figure 3" must read 3 even when only its
  // caption's page made the cut, exactly as print.ts resolves against the
  // whole body for every page it draws.
  return fillXrefsHtml(out.join(''), captionIndex(doc.body, docLang(doc)));
}

// ─────────────────────────────────────────────────── staticizing

/** Anything that could run, load, or accept input has no business in a still.
 *  `video`/`audio` are defence in depth — nothing here ever builds one. */
const BANNED = 'script,iframe,object,embed,video,audio,canvas,form,input,textarea,select,button,meta,link';

/** Attributes the runtime uses to find or drive things. A still has no
 *  runtime — kept deliberately broad (every `data-*` prefix, plus `on*`)
 *  rather than an allowlist of app features, so a future feature that adds
 *  one more does not have to remember to update this list to stay safe. */
const DROP_ATTRS_PREFIX = ['data-', 'on'];
const DROP_ATTRS = ['contenteditable', 'draggable', 'tabindex', 'role', 'href', 'src', 'srcset', 'title', 'aria-label', 'aria-expanded'];

function staticize(root: HTMLElement, keepImages: boolean): void {
  for (const el of Array.from(root.querySelectorAll(BANNED))) el.remove();

  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const isImg = el.tagName === 'IMG';
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const drop = DROP_ATTRS.includes(name) || DROP_ATTRS_PREFIX.some(p => name.startsWith(p));
      if (!drop) continue;
      if (isImg && name === 'src' && attr.value.startsWith('data:')) continue; // already in the file
      el.removeAttribute(attr.name);
    }
  }

  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    if (!keepImages || !img.getAttribute('src')) {
      const tint = document.createElement('div');
      tint.setAttribute('style',
        'height:100px;border-radius:4px;margin:0 0 10px;background:linear-gradient(135deg,#f7a6002e,#f7a60012)');
      img.replaceWith(tint);
    }
  }
}

// ─────────────────────────────────────────────────── frame + tiers

/** Fallbacks matching styles.css so a document that never set a theme still
 *  thumbnails like the app. */
const INK = '#1e2a3a';
const PAPER = '#ffffff';

function flat(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^#[0-9a-f]{3,8}$/i.test(s) || /^rgb/i.test(s) ? s : null;
}

/** The preview's own scoped stylesheet — a deliberately plain sheet, not an
 *  extract of styles.css: it renders the document honestly at a glance and is
 *  not trying to be pixel-identical to the editor (same call spaces makes). */
function sheet(doc: TypeDoc): string {
  const family = doc.type?.family ? cssFontFamily(doc.type.family) : FONT_STACK_FALLBACK;
  const size = doc.type?.size ?? 17;
  // `theme` is not a declared TypeDoc field (there is no document theme in
  // this format yet) — read defensively through the model's own additivity
  // escape hatch in case a future field or a hand-edited file carries one.
  const theme = (doc as { theme?: { color?: unknown; background?: unknown } }).theme;
  const ink = flat(theme?.color) ?? INK;
  const paper = flat(theme?.background) ?? PAPER;
  return [
    `.typ-pv{position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483000;`,
    `overflow:hidden;background:#e8ebf0;-webkit-font-smoothing:antialiased}`,
    `.typ-page{background:${paper};color:${ink};box-sizing:border-box;`,
    `font:${size}px/1.62 ${family};hyphens:auto}`,
    `.typ-page h1{font-size:26px;line-height:1.24;font-weight:600;margin:0 0 14px;hyphens:none}`,
    `.typ-page h2{font-size:15.5px;font-weight:600;margin:22px 0 8px;hyphens:none}`,
    `.typ-page h3{font-size:14px;font-weight:600;margin:16px 0 6px;hyphens:none}`,
    `.typ-page p{margin:0 0 10px;text-align:justify}`,
    `.typ-page ul,.typ-page ol{margin:0 0 10px;padding-inline-start:1.6em}`,
    `.typ-page li{margin:0 0 3px;text-align:justify}`,
    `.typ-page blockquote{margin:12px 0;padding-left:14px;border-left:2px solid #d8dce2;`,
    `color:#3a3d44;font-style:italic}`,
    `.typ-t{width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 12px;font-size:.95em}`,
    `.typ-t td{border-bottom:1px solid #c3cad4;padding:6px 10px 6px 0;vertical-align:top;`,
    `text-align:start;word-break:break-word}`,
    `.typ-fig{margin:12px 0;text-align:center}`,
    `.typ-fig[data-align="left"]{text-align:left}.typ-fig[data-align="right"]{text-align:right}`,
    `.typ-fig img{max-width:100%;height:auto}`,
    `.typ-math{margin:14px 0;text-align:center}`,
    `.typ-embed{margin:12px 0;text-align:center}`,
    `.typ-embed svg{max-width:100%;height:auto}`,
    `.typ-card{padding:64px 32px;text-align:center;color:#5b6472}`,
    `.typ-card b{display:block;font-size:28px;color:${ink};margin:12px 0 6px}`,
  ].join('');
}

function frame(inner: HTMLElement, doc: TypeDoc): HTMLElement {
  const box = document.createElement('div');
  box.className = 'typ-pv';
  const style = document.createElement('style');
  style.textContent = sheet(doc);
  box.appendChild(style);
  const p = doc.page;
  const wrap = document.createElement('div');
  wrap.setAttribute('style',
    `width:${p.width}px;transform-origin:0 0;transform:none;` +
    `transform:scale(calc(100vw / ${p.width}px));padding:24px 0`);
  const page = document.createElement('div');
  page.className = 'typ-page';
  page.setAttribute('style',
    `width:${p.width}px;min-height:${p.height}px;padding:${p.marginTop}px ${p.marginX}px ${p.marginBottom}px;` +
    `margin:0 auto;box-shadow:0 2px 24px rgba(0,0,0,.12)`);
  page.appendChild(inner);
  wrap.appendChild(page);
  box.appendChild(wrap);
  return box;
}

/** Last resort: the document's title on its own page. */
function titleCard(doc: TypeDoc): HTMLElement {
  const card = document.createElement('div');
  card.className = 'typ-card';
  const h = document.createElement('b');
  h.textContent = doc.title || 'Untitled document';
  card.appendChild(h);
  if (doc.subtitle) {
    const p = document.createElement('div');
    p.textContent = doc.subtitle;
    card.appendChild(p);
  }
  return frame(card, doc);
}

/**
 * The still for this document: page one, rendered flat, or null when there is
 * nothing to show — a pristine shell has an empty document, and a boot splash
 * is the honest thing for a file that genuinely holds none yet.
 *
 * THE ENCRYPTION CHECK HERE IS BELT AND BRACES, not the gate. The kernel's
 * `previewAllowed` is the real one (checks the in-memory flag AND re-parses
 * the block that is about to be written); this provider only ever sees the
 * document, so it repeats the flag half. The cost is one function call; the
 * failure it prevents is publishing a contract's opening paragraphs in
 * plaintext beside the ciphertext that exists to hide them.
 */
export function buildTypePreview(doc: TypeDoc): HTMLElement | null {
  if (isEncryptionActive()) return null;
  if (!doc?.body?.length) return null;

  const pageOne = firstPageBlocks(doc);
  if (!pageOne.length) return titleCard(doc);

  for (const keepImages of [true, false]) {
    const host = document.createElement('div');
    host.innerHTML = flowHtml(pageOne, doc);
    staticize(host, keepImages);
    const built = frame(host, doc);
    if (byteLength(built.innerHTML) <= PREVIEW_BUDGET) return built;
  }
  return titleCard(doc);
}

// ─────────────────────────────────────────────────── registration

const isTypeDoc = (d: unknown): d is TypeDoc =>
  typeof d === 'object' && d !== null && Array.isArray((d as { body?: unknown }).body);

registerReady(() => {
  registerPreview(doc => (isTypeDoc(doc) ? buildTypePreview(doc) : null));
});
