// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * What a paste into a text box or table cell inserts (discussion #503).
 *
 * The clipboard carries the selection twice: as `text/html` — the browser's
 * own serialisation of what was copied, formatting and all — and as
 * `text/plain`. Until now only the plain flavour was read, so copying bold,
 * italic or bullets from one box and pasting into another lost everything.
 * The html flavour is preferred now, through the ONE sanitizer (render.ts
 * sanitizeHtml: an allowlist of tags, every attribute dropped, an anchor's
 * href kept only when it is a web URL, nested markup walked before it is
 * lifted). Plain text stays the fallback and keeps its markdown conversion.
 *
 * Browser clipboards are not tidy. Chrome writes `<meta charset>` first, wraps
 * the selection in `<span style="…">` soup with the computed font, and marks
 * a NOT-bold run inside a bold context as `<b style="font-weight:normal">` —
 * a `<b>` that means "not bold". The sanitizer drops attributes, which would
 * turn that into a real bold. So the quirks are handled before it runs: meta
 * and style elements removed, a `<b>`/`<strong>` whose inline style says
 * `font-weight: normal` (or ≤ 400) unwrapped. Spans survive the sanitizer as
 * bare `<span>`s, which render as nothing.
 *
 * Everything above happens in a document of its own, made by DOMParser and
 * never attached to the page: untrusted nodes are parsed, tidied and
 * serialised there, and only the resulting STRING reaches sanitizeHtml. A
 * node adopted into the live document starts loading what it names (img,
 * source, poster, input type=image) and fires its load and error handlers
 * before any sanitizer has run — measured — so nothing here is ever created
 * in or appended to `document`.
 */

import { sanitizeHtml } from '../render'

/** The html to insert for this clipboard, or '' when the plain-text path
 *  should run instead (no html flavour, or nothing left after cleaning). */
export function clipboardToHtml(dt: DataTransfer | null | undefined): string {
  const html = dt?.getData('text/html')
  if (!html || typeof DOMParser === 'undefined') return ''
  // an inert document: no loads, no scripts, no handlers ever fire in it
  const inert = new DOMParser().parseFromString(html, 'text/html')
  const body = inert.body
  for (const junk of Array.from(body.querySelectorAll('meta, style, script, title, link, head'))) junk.remove()
  for (const b of Array.from(body.querySelectorAll('b, strong'))) {
    const w = (b as HTMLElement).style.fontWeight.trim().toLowerCase()
    const light = w === 'normal' || w === 'lighter' || (/^\d+$/.test(w) && Number(w) <= 400)
    if (light) {
      const parent = b.parentNode
      if (!parent) continue
      while (b.firstChild) parent.insertBefore(b.firstChild, b)
      b.remove()
    }
  }
  const clean = sanitizeHtml(body.innerHTML)
  // nothing but whitespace/empty tags → let the plain path decide. Checked
  // in an inert document too: the cleaned string is parsed back there.
  const check = new DOMParser().parseFromString(clean, 'text/html').body
  return check.textContent?.trim() || check.querySelector('br, li') ? clean : ''
}
