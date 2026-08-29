// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// EMBEDDED BENTO ARTIFACTS — a Dash chart, a Slides deck, a Spaces page,
// sitting inside a document.
//
// The shape is settled in docs/DECISIONS.md (2026-08-19) and is deliberately
// the same in every app and in both directions. It belongs in the kernel; that
// is a serialized kernel change of its own, so this is the consumer side
// written against the agreed shape, and lifting it later is a move rather than
// a redesign.
//
//   { kind:'embed', app:'bento/dash', doc:{…}|'asset:…', view:'<svg…>', w, h }
//
// THE ORDER OF THE THREE TIERS IS THE WHOLE DESIGN:
//
//   view  a static render, ALWAYS present. Paints with no extra code, in any
//         app, including ones that have never heard of `app`. Thumbnails and
//         prints. This is what keeps a self-contained file self-contained.
//   doc   the source, ALWAYS present. Round-trips: open it in Dash, edit,
//         come back. This is what stops the embed being a screenshot.
//   live  a sandboxed iframe. OPT-IN per embed, because a Bento file is a
//         runnable page and embedding one costs a whole shell.
//
// The alternative — compiling the other apps' renderers in — means shipping
// every renderer in every file to cover the matrix, and version skew between
// the embedded copy and the real app.

import { uid, type Block } from './model.ts';
import { t } from './i18n.ts';
import { registerTool, type FeatureContext } from './features.ts';

// 24×24, 16px, stroke currentColor at width 2 — icons.ts's recipe, which is
// what must not drift between apps.
const EMBED_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"'
  + ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 20h8"/>'
  + '<path d="M8 13l2.5-3 2 2.2L15 8.5"/></svg>';

/** Apps whose artifacts can be embedded. Unknown values are RENDERED, not rejected. */
export const APPS: Record<string, string> = {
  'bento/dash': 'Bento Dash',
  'bento/slides': 'Bento Slides',
  'bento/spaces': 'Bento Spaces',
  'bento/type': 'Bento Type',
};

export interface EmbedData {
  app: string;
  view: string;
  doc?: unknown;
  w?: number;
  h?: number;
  live?: boolean;
}

export const embedOf = (b: Block): EmbedData | undefined => {
  const e = (b as { embed?: EmbedData }).embed;
  return e && typeof e.app === 'string' && typeof e.view === 'string' ? e : undefined;
};

/**
 * Is this SVG safe to drop into the page?
 *
 * The static render arrives as markup from a document, and a document is
 * untrusted input — the same rule that made link hrefs and mark authors get
 * escaped. An embed is the most attractive place in the format to hide a
 * script, because its whole purpose is to carry markup someone else produced.
 *
 * So: it must BE an svg, and it must contain no script, no foreign content, no
 * event handler and no external reference. Refusing beats sanitising — a
 * rejected embed still shows its placeholder and its source is still there, so
 * nothing is lost but the picture.
 */
const BANNED = /<\s*(script|iframe|object|embed|foreignObject|link|meta|style)\b/i;
const HANDLER = /\son[a-z]+\s*=/i;
// ALLOW-LIST, not a block-list. The first version enumerated the schemes to
// refuse — https:, //, a non-image data: — and so let `javascript:alert(1)`
// straight through, because it was not on the list. Naming the bad things is a
// losing game: there is always another scheme. This permits a same-document
// fragment and an inline raster image, and refuses everything else, including
// relative paths (an embed has no business fetching anything).
const REMOTE = /\b(?:href|xlink:href|src)\s*=\s*["']?(?!#|data:image\/(?:png|jpe?g|gif|webp);base64,)/i;

export function safeView(svg: string): string | null {
  const s = svg.trim();
  if (!/^<svg[\s>]/i.test(s)) return null;
  if (BANNED.test(s) || HANDLER.test(s) || REMOTE.test(s)) return null;
  return s;
}

const esc = (x: string) => x.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * Render an embed.
 *
 * `data-atomic` because it is a box with height and no text pagination can
 * measure — the same treatment images and display equations get, and without it
 * the paginator would put a page break through the middle of a chart.
 */
export function renderEmbed(b: Block): HTMLElement {
  const host = document.createElement('figure');
  host.className = 't-embed';
  host.dataset.id = b.id;
  host.dataset.atomic = '1';

  const e = embedOf(b);
  if (!e) {
    host.append(placeholder(t('This embed is missing its data.')));
    return host;
  }
  if (e.w) host.style.setProperty('--embed-w', `${e.w}px`);

  const view = safeView(e.view);
  if (view === null) {
    // An embed whose picture was refused still says what it is and still
    // carries its source, so a person can open it in the app that made it.
    host.append(placeholder(t('This embed could not be displayed safely.')));
  } else {
    const box = document.createElement('div');
    box.className = 't-embed-view';
    box.innerHTML = view;
    host.appendChild(box);
  }

  // The PROVENANCE line, not a caption. A caption is a `caption` BLOCK with a
  // CaptionRef pointing at this one — the same mechanism tables and figures
  // already use, and the reason it is a block is that a caption needs its own
  // stable id for cross-references and for the redline to align on. An earlier
  // version of this read `b.caption` as a string; that field is a CaptionRef,
  // so the embed would have invented a second, weaker way to caption things
  // and silently mistyped the format doing it.
  //
  // An unknown app is NAMED rather than hidden: format additivity means a file
  // from a newer app must still make sense here, and "From Bento Whatever"
  // tells the reader where to go and open it.
  const cap = document.createElement('figcaption');
  cap.textContent = t('From {app}').replace('{app}', APPS[e.app] ?? e.app);
  host.appendChild(cap);
  return host;
}

function placeholder(text: string): HTMLElement {
  const p = document.createElement('div');
  p.className = 't-embed-missing';
  p.textContent = text;
  return p;
}

/** The embed as plain HTML — for print and for the static first-page preview. */
export function embedHtml(b: Block): string {
  const e = embedOf(b);
  if (!e) return '';
  const view = safeView(e.view);
  const cap = `From ${APPS[e.app] ?? e.app}`;
  return `<figure class="t-embed" data-id="${esc(b.id)}" data-atomic="1">`
    + (view === null ? `<div class="t-embed-missing">${esc('This embed could not be displayed safely.')}</div>`
                     : `<div class="t-embed-view">${view}</div>`)
    + `<figcaption>${esc(cap)}</figcaption></figure>`;
}

// ─────────────────────────────────────────────────────────────── inserting

/**
 * Insert an embed from a file the user picks.
 *
 * A Bento artifact is a whole HTML file, so what is read out of it is the
 * `#bento-doc` block — the splice contract (PLATFORM §2) guarantees it is
 * plaintext JSON at a known id, which is precisely what makes one app able to
 * read another's file without linking its code.
 */
export async function insertEmbed(ctx: FeatureContext): Promise<void> {
  const file = await pickFile();
  if (!file) return;
  const html = await file.text();
  const parsed = readArtifact(html);
  if (!parsed) {
    ctx.toast(t('That file does not look like a Bento document.'));
    return;
  }
  const caret = ctx.editor.caret();
  const block: Block = {
    id: uid(), kind: 'embed', text: '',
    embed: parsed,
  } as Block;
  ctx.store.commit(d => {
    const i = caret ? d.body.findIndex(b => b.id === caret.id) : -1;
    d.body.splice(i >= 0 ? i + 1 : d.body.length, 0, block);
  });
  ctx.editor.render();
  ctx.refresh();
  ctx.toast(t('Embedded from {app}').replace('{app}', APPS[parsed.app] ?? parsed.app));
}

/**
 * Pull the document, and a still of it, out of another app's file.
 *
 * The STILL is the interesting part: `preview.ts` in slides writes a static
 * first-page render into every saved shell so file managers can thumbnail it
 * with JS off. That render is exactly the picture an embed needs, already in
 * the file, already static, already safe to show without running anything —
 * so an embed of a saved Bento file costs no new rendering anywhere.
 */
const DOC_BLOCK = /<script[^>]*\bid=["']bento-doc["'][^>]*>([\s\S]*?)<\/script>/i;
const PREVIEW = /data-bento-preview[^>]*>[\s\S]*?(<svg[\s\S]*?<\/svg>)/i;

export function readArtifact(html: string): EmbedData | null {
  // Extracted by PATTERN rather than by DOMParser, and this is a narrow licence
  // rather than a general habit: the splice contract (PLATFORM §2) guarantees
  // #bento-doc is plaintext JSON at a known id in every Bento file ever
  // written, which is the only reason a pattern is sound here. It must not grow
  // into an HTML parser. The gain is that the whole boundary runs — and is
  // tested — without a DOM, and safeView still validates whatever comes out, so
  // a mis-extraction can produce a wrong picture but never an unsafe one.
  const block = DOC_BLOCK.exec(html);
  if (!block) return null;
  let parsed: { format?: string };
  try { parsed = JSON.parse(block[1]); } catch { return null; }
  const app = typeof parsed?.format === 'string' ? parsed.format : '';
  if (!app.startsWith('bento/')) return null;

  // slides/src/preview.ts writes a static first-page render into every saved
  // shell so file managers can thumbnail it with JS off. That render is exactly
  // the picture an embed wants: already static, already in the file, and safe
  // to show without running anything.
  const still = PREVIEW.exec(html);
  const view = still && safeView(still[1]) ? still[1] : fallbackView(app);
  return { app, view, doc: parsed };
}

/** When a file carries no preview, the embed still says what it is. */
const fallbackView = (app: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180">`
  + `<rect width="320" height="180" rx="8" fill="#eef2f7"/>`
  + `<text x="160" y="94" text-anchor="middle" font-family="system-ui" font-size="13"`
  + ` fill="#5b6675">${(APPS[app] ?? app).replace(/[<&>]/g, '')}</text></svg>`;

async function pickFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.html,text/html';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.click();
  });
}

registerTool({
  id: 'embed',
  icon: EMBED_ICON,
  get title() { return t('Embed a Bento chart, deck or page'); },
  group: 'insert',
  label: () => t('Bento artifact'),
  order: 50,
  run: ctx => { void insertEmbed(ctx); },
});
