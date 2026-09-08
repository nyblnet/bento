// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Paginated output — print, and PDF through the browser's own print dialog.
//
// WHY THIS IS NOT A NICETY. Two promises in the design live entirely here:
//
//  1. DETERMINISTIC PAGINATION. A .docx repaginates differently on a different
//     machine — different font versions, different metrics, a printer driver in
//     the loop — which is why legal and academic work is exchanged as PDF, not
//     for looks but because page 14 paragraph 3 must be page 14 paragraph 3 for
//     everyone. That property is only observable in the printed artifact.
//  2. FOOTNOTES AT PAGE FEET. The editing view puts notes in the margin beside
//     their reference, because in a continuous flow nothing physically reserves
//     the space a page-foot note would need and the note lands on top of the
//     body (the spike did exactly that before it was caught). Here the space IS
//     real, so notes go where a reader expects them.
//
// The output is built by FRAGMENTING the document into real page boxes — the
// thing the editor deliberately does not do, because fragmentation is not
// transparent to editing (arrow keys stall at the seam, backspace deletes two
// characters). Nothing is edited here, so the objection does not apply, and the
// pagination is the same computation the editor already ran.

import type { Block, TypeDoc } from './model.ts';
import { blockHtml, groupBlocks, TAG } from './render.ts';
import type { Metrics } from './paginate.ts';
import { captionIndex, docLang, fillXrefsHtml } from './xref.ts';
import { blockStyle } from './layout.ts';
import { docStyleCss } from './docstyles.ts';
import { embedHtml } from './embed.ts';

export interface PrintOptions {
  /** running head text; omitted = the document title */
  header?: string;
  /** show page numbers in the footer */
  pageNumbers?: boolean;
  /** first page carries no header/footer, as a title page usually should not */
  bareFirstPage?: boolean;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * The stylesheet the printed document carries.
 *
 * `@page` is sized from the document's own geometry, so a deck set to A4 prints
 * A4 and one set to Letter prints Letter — the page size is document data, not
 * a print-time question the user is asked twice.
 *
 * Margins are handled by the page BOX, not by `@page`, because the running head
 * and the footnote area have to live inside the margin and `@page` margins are
 * unreachable from content.
 */
function printCss(doc: TypeDoc): string {
  // the document's typeface, so paper matches screen — same fallback as
  // styles.css, so a file that says nothing prints exactly as it always did
  const p = { ...doc.page,
    __fontSize: `${doc.type?.size ?? 17}px`,
    __fontFamily: doc.type?.family ?? '"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif',
  };
  return `
@page { size: ${p.width}px ${p.height}px; margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; background: #fff; }
body {
  font: ${p.__fontSize}/1.62 ${p.__fontFamily};
  color: #1a1a1a; hyphens: auto; -webkit-hyphens: auto;
}
.t-page {
  position: relative;
  width: ${p.width}px; height: ${p.height}px;
  padding: ${p.marginTop}px ${p.marginX}px ${p.marginBottom}px;
  overflow: hidden;
  /* one sheet per page, and never a stray blank one after the last */
  break-after: page; page-break-after: always;
}
.t-page:last-child { break-after: auto; page-break-after: auto; }
.t-flow { position: relative; }
/* The flow is shifted UP by the page's start offset and clipped by the page
   box. Every page therefore renders the SAME document with the same line
   breaking, and shows its own window onto it — which is what makes the printed
   pagination identical to the one the editor computed. */
.t-body { position: relative; }
h1 { font-size: 26px; line-height: 1.24; font-weight: 600; margin: 0 0 14px; hyphens: none; }
h2 { font-size: 15.5px; font-weight: 600; margin: 24px 0 8px; hyphens: none; }
h3 { font-size: 14px; font-weight: 600; margin: 16px 0 6px; color: #3a3d44; hyphens: none; }
p { margin: 0 0 10px; text-align: justify; orphans: 2; widows: 2; text-wrap: pretty; }
p + p { text-indent: 1.4em; margin-top: -10px; padding-top: 10px; }
.t-figure { margin: 12px 0; text-align: center; break-inside: avoid; page-break-inside: avoid; }
.t-figure img { max-width: 100%; height: auto; }
.t-figure[data-align="left"] { text-align: left; }
.t-figure[data-align="right"] { text-align: right; }
.t-table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 0 0 12px; font-size: .95em; }
.t-table th, .t-table td { border-bottom: 1px solid #c3cad4; padding: 6px 10px 6px 0;
                           vertical-align: top; text-align: start; text-indent: 0; hyphens: none; }
.t-table th { font-weight: 600; border-bottom-width: 1.5px; }
.t-table tr:last-child td { border-bottom: 0; }
ul, ol { margin: 0 0 10px; padding-inline-start: 1.6em; }
li { margin: 0 0 3px; text-align: justify; text-indent: 0; orphans: 2; widows: 2; }
li > ul, li > ol { margin: 3px 0 0; }
ul { list-style: disc; } ul ul { list-style: circle; } ul ul ul { list-style: square; }
ol { list-style: decimal; } ol ol { list-style: lower-alpha; } ol ol ol { list-style: lower-roman; }
blockquote { margin: 12px 0 12px 24px; padding-left: 14px; border-left: 2px solid #d8dce2;
             color: #3a3d44; font-style: italic; }
strong { font-weight: 600; }
code { font: .88em/1 ui-monospace, SFMono-Regular, Menlo, monospace;
       background: #f1f0ec; padding: 1px 4px; border-radius: 3px; }
a { color: #2d4a7a; text-decoration: none; }
sup.t-note { font: 600 9px/1 -apple-system, system-ui, sans-serif; color: #7a5200;
             vertical-align: super; padding: 0 1px; }
.t-run { position: absolute; left: ${p.marginX}px; right: ${p.marginX}px;
         font: 10px/1 -apple-system, system-ui, sans-serif; color: #8b8f97;
         letter-spacing: .06em; }
.t-run.head { top: ${Math.max(28, p.marginTop - 46)}px; }
.t-run.foot { bottom: ${Math.max(28, p.marginBottom - 46)}px; text-align: center; }
/* footnotes sit at the FOOT of the page, in the space pagination reserved */
.t-fn { position: absolute; left: ${p.marginX}px; right: ${p.marginX}px;
        border-top: 1px solid #b9bdc5; padding-top: 5px;
        font: 12px/1.4 "Iowan Old Style",Palatino,Georgia,serif; color: #333; }
.t-fn p { margin: 0 0 2px; text-align: left; text-indent: 0; padding-top: 0; }
.t-fn b { font: 600 9px/1 -apple-system, system-ui, sans-serif; color: #7a5200;
          vertical-align: super; margin-right: 4px; }
`;
}

/**
 * A table, as HTML — the string twin of render.ts renderTable, and it must stay
 * one: a table that gains a header row on screen and loses it on paper is the
 * drift this module exists to prevent. Both are driven by the same token from
 * the same grouping function, so only the emission differs.
 */
function tableHtml(rows: Block[][], head: boolean): string {
  const cols = rows[0]?.length ?? 1;
  const cell = (b: Block | undefined, tag: 'th' | 'td') =>
    b ? `<${tag} data-id="${esc(b.id)}">${blockHtml(b)}</${tag}>`
      : `<${tag}></${tag}>`;
  const row = (r: Block[], tag: 'th' | 'td') =>
    `<tr>${Array.from({ length: cols }, (_, c) => cell(r[c], tag)).join('')}</tr>`;
  const parts: string[] = ['<table class="t-table">'];
  if (head && rows.length) parts.push(`<thead>${row(rows[0], 'th')}</thead>`);
  parts.push('<tbody>');
  for (const r of rows.slice(head ? 1 : 0)) parts.push(row(r, 'td'));
  parts.push('</tbody></table>');
  return parts.join('');
}

/**
 * The body, rendered once — every page shows a window onto this same flow.
 *
 * Uses the SAME grouping as the editor (render.ts groupBlocks), so a list that
 * nests on screen nests identically on paper. Rebuilding the list structure
 * here with a second implementation is exactly how print drifts from the
 * editor, which is the failure this whole module exists to avoid.
 */
function bodyHtml(doc: TypeDoc, lang: string): string {
  const body = doc.body;
  const out: string[] = [];
  for (const tok of groupBlocks(body)) {
    if (tok.t === 'open') out.push(`<${tok.kind}>`);
    else if (tok.t === 'close') out.push(`</${tok.kind}>`);
    else if (tok.t === 'table') out.push(tableHtml(tok.rows, tok.head));
    // An embed prints as its STATIC RENDER — which is the tier that exists for
    // exactly this, and why the render is mandatory rather than a cache.
    else if (tok.block.kind === 'embed') out.push(embedHtml(tok.block));
    else if (tok.block.kind === 'image') {
      const b = tok.block, im = b.image;
      const w = im?.w ? ` style="width:${Math.round(im.w * 100)}%"` : '';
      const al = im?.align ? ` data-align="${esc(im.align)}"` : '';
      out.push(`<figure class="t-figure" data-id="${esc(b.id)}"${al}>` +
               (im ? `<img src="${esc(im.src)}" alt="${esc(im.alt ?? '')}"${w}>` : '') +
               `</figure>`);
    }
    else {
      const b = tok.block;
      // Same composition as render.ts renderBlock, same order — the named
      // style first, the block's own direct properties second, so print
      // shows exactly what the screen does: a block's own align/sb/sa/lh/ind
      // beats its style, both beat the document's plain CSS defaults.
      const st = [docStyleCss(doc, b), blockStyle(b)].filter(Boolean).join(';');
      out.push(`<${TAG[b.kind]} data-id="${esc(b.id)}"${st ? ` style="${esc(st)}"` : ''}>` +
               `${blockHtml(b)}</${TAG[b.kind]}>`);
    }
  }
  // The DOM pass (numberXrefs) and this string pass fill the SAME atoms from
  // the SAME index, which is what stops the printed numbering drifting from the
  // screen's — the drift this module exists to prevent.
  return fillXrefsHtml(out.join('\n'), captionIndex(body, lang));
}

/**
 * Build the printable document.
 *
 * Each page holds a copy of the whole flow, shifted up by that page's start
 * offset and clipped to the page box. That sounds wasteful and is the point:
 * every page lays the document out identically, so a line cannot break
 * differently on page 12 than the editor said it would. The alternative —
 * slicing the content per page — re-lays out each fragment and is exactly how
 * printed pagination drifts from what was on screen.
 */
export function buildPrintDocument(doc: TypeDoc, metrics: Metrics, opts: PrintOptions = {}): string {
  const p = doc.page;
  const head = opts.header ?? doc.title;
  // the DOCUMENT's language, not the reader's: a caption label is printed and
  // signed with the author's sentences, so it must not change per reader
  const flow = bodyHtml(doc, docLang(doc));
  const contentH = p.height - p.marginTop - p.marginBottom;

  // footnote numbering is derived, in document order, exactly as on screen
  const noteNumber = new Map<string, number>();
  let n = 0;
  for (const b of doc.body) for (const ref of b.notes ?? []) noteNumber.set(ref.id, ++n);

  const pages = metrics.pages.map((pg, i) => {
    const bare = opts.bareFirstPage && i === 0;
    const notes = pg.notes.filter(id => doc.footnotes[id] !== undefined);
    const fnHtml = notes.length
      ? `<div class="t-fn" style="bottom:${p.marginBottom + 10}px">` +
        notes.map(id => `<p><b>${noteNumber.get(id) ?? ''}</b>${esc(doc.footnotes[id]!)}</p>`).join('') +
        `</div>`
      : '';
    // The window is the page's ACTUAL extent — end minus start — not the
    // nominal content height. Clipping at a fixed height cuts the last line in
    // half, because pagination chose the break at a line boundary that is
    // almost never exactly `contentH - reserved` from the page top. The last
    // page has no end, so it gets the nominal height and simply runs out.
    const windowH = isFinite(pg.end) ? pg.end - pg.start : contentH - pg.reserved;
    const window = `<div class="t-flow" style="height:${windowH}px;overflow:hidden">` +
      `<div class="t-body" style="margin-top:${-pg.start}px">${flow}</div></div>`;
    return `<section class="t-page">` +
      (bare ? '' : `<div class="t-run head">${esc(head)}</div>`) +
      window + fnHtml +
      (bare || opts.pageNumbers === false ? '' : `<div class="t-run foot">${pg.n}</div>`) +
      `</section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(doc.title)}</title>
<style>${printCss(doc)}</style>
</head><body>${pages}</body></html>`;
}

/**
 * Open the print dialog on the paginated document.
 *
 * A hidden same-origin iframe rather than a popup: a popup is blocked without a
 * user gesture and lands in a window the user then has to close, and printing
 * the CURRENT document is not an option — the editor's DOM is one continuous
 * flow with decorations in an overlay, so it would print as one enormous page
 * with the notes in the margin.
 */
export function printDocument(doc: TypeDoc, metrics: Metrics, opts: PrintOptions = {}): void {
  const html = buildPrintDocument(doc, metrics, opts);
  const frame = document.createElement('iframe');
  frame.setAttribute('data-bento-transient', '');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0';
  document.body.appendChild(frame);
  const win = frame.contentWindow!;
  win.document.open();
  win.document.write(html);
  win.document.close();
  const go = () => {
    win.focus();
    win.print();
    // leave it a moment: removing the frame during print cancels the job in
    // some engines
    setTimeout(() => frame.remove(), 1000);
  };
  if (win.document.readyState === 'complete') setTimeout(go, 60);
  else win.addEventListener('load', () => setTimeout(go, 60));
}
