// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The still render written into every saved space, for readers with no JS.
//
// WHAT THIS IS FOR. The shell's runtime ships DEFLATED and is inflated by a
// loader at boot. With scripting off nothing inflates, nothing boots, and the
// splash is never removed — so a saved space appeared as the bento boot screen
// to macOS QuickLook, iOS Files, bento/home, and any preview pane that renders
// HTML without running it. A file whose whole promise is "this is the document"
// showed a loading animation instead of the document.
//
// So every save writes a plain, static render of the home page into the shell,
// followed IMMEDIATELY by a parser-blocking script that deletes both. A
// thumbnailer keeps it (it runs no script); a reader never sees it (the remover
// runs before the first paint). Slides established the whole mechanism —
// kernel/src/save.ts registerPreview, and the rationale in docs/DECISIONS.md;
// this is the spaces renderer for it.
//
// NOT `<noscript>`: measured on iOS, whose thumbnailer runs no script AND does
// not render noscript, so the content would be invisible in exactly the place
// this exists to fix.
//
// THE CSS PROBLEM, and why this file carries a style block. The runtime
// stylesheet is deflated too, so none of the `.sp-*` rules exist in this mode.
// Slides inlines the handful of rules its render needs; a space is a column of
// prose and needs a bit more than a handful, so the preview ships its own small
// scoped sheet. It is a SEPARATE, deliberately plain sheet rather than an
// extract of the real one: it renders the document honestly at a glance, and it
// is not trying to be pixel-identical to the editor.
//
// AND THIS SURFACE HAS NO THEME — deliberately, now that the editor has one.
//
// The app's dark interface is a VIEWER preference: localStorage, read at boot
// by kernel/src/theme.ts. Nothing here can ask for it. This render exists
// precisely for the readers that run no script, so there is no boot, no
// localStorage and no reader to hold a preference — there is a file manager
// drawing a thumbnail. A `prefers-color-scheme` block here would not be the
// reader's choice; it would be a guess made on their behalf, and it would
// fight the one thing this render legitimately does have: `doc.theme`, the
// colours the AUTHOR gave the document, which the sheet below paints.
//
// So the preview is the one surface in this app that stays the author's in
// both themes, exactly as a thumbnail of a document should. If that ever
// changes it has to change with the FORMAT, not with a media query.

import type { SpacesDoc, Page } from './model'
import { renderPage } from './render'
import { homePage } from './model'

/** Above this the preview is trimmed, then dropped to a title card. A preview
 *  is a courtesy; it must never be why a file is large. */
export const PREVIEW_BUDGET = 64 * 1024

/**
 * Anything that could run, load, or accept input has no business in a still.
 *
 * `video`/`audio` are DEFENCE IN DEPTH rather than the mechanism: the render
 * below passes `printing: true`, and render.ts draws a `media` block as a
 * poster still under that flag, so no player element is ever built here. This
 * catches one arriving by some other route — a future block type that embeds
 * one, or a hand-written document — before a file manager is asked to decode
 * video to draw an icon.
 */
const BANNED = 'script,iframe,object,embed,video,audio,canvas,form,input,textarea,select,button,link,meta'

/** Attributes the runtime uses to find things. A still has no runtime. */
const DROP_ATTRS = [
  'contenteditable', 'draggable', 'tabindex', 'role', 'href', 'src', 'srcset',
  'data-edit', 'data-block-id', 'data-type', 'data-page-title', 'data-ph',
  'data-remote-src', 'data-load-remote', 'aria-label', 'aria-expanded', 'title',
]

const FONT_STACK =
  '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif'

/**
 * The preview's own stylesheet.
 *
 * Scoped under the host so it cannot touch the live app if it ever survived
 * (it does not — the remover runs first), and written flat so a conservative
 * renderer can follow all of it.
 */
const SHEET = (doc: SpacesDoc): string => {
  const ink = flat(doc.theme?.color) ?? '#1E2A3A'
  const bg = flat(doc.theme?.background) ?? '#FFFFFF'
  const accent = flat(doc.theme?.accent) ?? '#F7A600'
  const measure = Number(doc.theme?.measure) || 720
  return [
    `.bp{position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483000;`,
    `overflow:hidden;background:${bg};color:${ink};font-family:${FONT_STACK};`,
    `-webkit-font-smoothing:antialiased}`,
    `.bp-col{max-width:${measure}px;margin:0 auto;padding:56px 28px 0;`,
    `font-size:16px;line-height:1.62}`,
    `.bp h1{font-size:33px;line-height:1.2;margin:0 0 18px;letter-spacing:-.02em}`,
    `.bp h2{font-size:22px;line-height:1.3;margin:26px 0 8px}`,
    `.bp h3{font-size:18px;margin:20px 0 6px}`,
    `.bp p{margin:0 0 12px}`,
    `.bp ul,.bp ol{margin:0 0 12px;padding-inline-start:24px}`,
    `.bp li{margin:0 0 5px}`,
    `.bp li.sp-done{color:#5B6472;text-decoration:line-through}`,
    `.bp blockquote{margin:0 0 14px;padding-inline-start:14px;`,
    `border-inline-start:3px solid ${accent};color:#5B6472}`,
    `.bp pre{margin:0 0 14px;padding:11px 13px;border-radius:8px;background:#F5F7FA;`,
    `font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden}`,
    `.bp hr{border:0;border-top:1px solid #E3E8EF;margin:20px 0}`,
    `.bp figure{margin:0 0 14px}`,
    `.bp img{max-width:100%;height:auto;border-radius:8px;display:block}`,
    `.bp figcaption{font-size:13px;color:#5B6472;margin-top:5px}`,
    `.bp aside{margin:0 0 14px;padding:12px 14px;border-radius:10px;`,
    `border:1px solid #E3E8EF;border-inline-start:3px solid ${accent};background:#F8FAFC}`,
    // A clip's still: the author's poster frame if there is one, and a quiet
    // labelled box if not. Flat rules only — QuickLook's WebKit is the
    // conservative renderer this sheet is written for, so no :has(), no
    // grid tricks, nothing that could fail to a blank rectangle.
    `.bp .sp-media-still{margin:0 0 14px;padding:12px;border-radius:8px;`,
    `border:1px solid #E3E8EF;background:#F8FAFC;text-align:center}`,
    `.bp .sp-media-still img{max-width:100%;height:auto;border-radius:6px;`,
    `display:block;margin:0 auto 8px}`,
    `.bp .sp-media-badge{font-size:13px;color:#5B6472}`,
    `.bp .sp-media-empty{margin:0 0 14px;padding:12px;border-radius:8px;`,
    `border:1px dashed #E3E8EF;color:#5B6472;font-size:13px;text-align:center}`,
    `.bp code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}`,
    `.bp a{color:inherit;text-decoration:none;border-bottom:1px solid ${accent}}`,
    // A table with no rules is four columns of words running together, which is
    // exactly the "shows a loading animation instead of the document" failure
    // this file exists to fix, one level down.
    `.bp table{width:100%;border-collapse:collapse;margin:0 0 14px;font-size:15px;table-layout:fixed}`,
    `.bp th,.bp td{border:1px solid #E3E8EF;padding:6px 9px;text-align:start;`,
    `vertical-align:top;word-break:break-word}`,
    `.bp th{background:#F5F7FA;font-weight:600}`,
  ].join('')
}

/** A colour a conservative renderer will certainly accept, or nothing. */
function flat(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return /^#[0-9a-f]{3,8}$/i.test(s) || /^rgb/i.test(s) ? s : null
}

const byteLength = (el: HTMLElement): number => new TextEncoder().encode(el.outerHTML).length

/**
 * Strip everything a still cannot honour, in place.
 *
 * `href`/`src` go too: a preview must not be a link, and it must never fetch —
 * an <img src="https://…"> here would phone home from a file manager, which is
 * the very thing the remote-image consent rule exists to prevent, in a context
 * where nobody could consent.
 */
function staticize(root: HTMLElement, keepImages: boolean, doc: SpacesDoc): void {
  // A to-do's checkbox is an <input>, and a still has no controls — but simply
  // deleting it leaves a list of oddly indented sentences with no sign they are
  // tasks, or which are done. Swap in the glyph before the ban runs.
  for (const box of Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
    const mark = document.createElement('span')
    mark.textContent = box.checked ? '☑ ' : '☐ '
    mark.setAttribute('style', 'color:#5B6472')
    box.replaceWith(mark)
  }
  for (const el of Array.from(root.querySelectorAll(BANNED))) el.remove()

  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const isImg = el.tagName === 'IMG'
    for (const attr of Array.from(el.attributes)) {
      // on* can only arrive through our own code or the sanitizer (which strips
      // every attribute) — defence in depth, and free.
      if (attr.name.startsWith('on')) { el.removeAttribute(attr.name); continue }
      if (!DROP_ATTRS.includes(attr.name)) continue
      // an embedded image is the one src worth keeping: it is already in the
      // file, so showing it costs no request
      if (isImg && attr.name === 'src' && attr.value.startsWith('data:')) continue
      el.removeAttribute(attr.name)
    }
  }

  // an <img> with no src left is a broken-image glyph — drop it
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    if (!keepImages || !img.getAttribute('src')) {
      // Keep the BOX. An empty tinted rectangle where the picture was reads as
      // layout; removing it collapses the page into floating text.
      const tint = document.createElement('div')
      const accent = flat(doc.theme?.accent) ?? '#F7A600'
      tint.setAttribute('style',
        `height:120px;border-radius:8px;margin:0 0 14px;` +
        `background:linear-gradient(135deg,${accent}2E,${accent}12)`)
      img.replaceWith(tint)
    }
  }
}

/** Last resort: the space's name, on its own background. */
function titleCard(doc: SpacesDoc): HTMLElement {
  const col = document.createElement('div')
  col.className = 'bp-col'
  const h = document.createElement('h1')
  h.textContent = doc.title || 'Untitled space'
  col.appendChild(h)
  const p = document.createElement('p')
  const pages = doc.pages?.length ?? 0
  p.textContent = `${pages} page${pages === 1 ? '' : 's'}`
  p.setAttribute('style', 'color:#5B6472')
  col.appendChild(p)
  return col
}

function wrap(inner: HTMLElement, doc: SpacesDoc): HTMLElement {
  const box = document.createElement('div')
  // z-index above the splash (9999) and the loader's failure card (99999)
  box.className = 'bp'
  const style = document.createElement('style')
  style.textContent = SHEET(doc)
  box.appendChild(style)
  box.appendChild(inner)
  return box
}

/**
 * The still for this space: its home page, rendered flat.
 *
 * Returns null when there is nothing to show — a pristine shell has an empty
 * document, and a boot splash is the honest thing to display for a file that
 * genuinely holds no document yet.
 */
export function buildSpacePreview(doc: SpacesDoc): HTMLElement | null {
  if (!doc?.pages?.length) return null
  const page: Page | undefined = homePage(doc) ?? doc.pages[0]
  if (!page) return null

  for (const keepImages of [true, false]) {
    // the SHARED renderer, so the still cannot disagree with the app about what
    // the document looks like. forceOpen: a fold that is shut in the editor
    // still has content worth previewing; printing: no controls.
    const rendered = renderPage(page, doc, {
      editable: false,
      forceOpen: true,
      printing: true,
      titleOf: (id) => doc.pages.find((p) => p.id === id)?.title,
    })
    const col = document.createElement('div')
    col.className = 'bp-col'
    while (rendered.firstChild) col.appendChild(rendered.firstChild)
    staticize(col, keepImages, doc)
    const built = wrap(col, doc)
    if (byteLength(built) <= PREVIEW_BUDGET) return built
  }
  return wrap(titleCard(doc), doc)
}
