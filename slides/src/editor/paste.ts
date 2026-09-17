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
 */

import { sanitizeHtml } from '../render'

/** The html to insert for this clipboard, or '' when the plain-text path
 *  should run instead (no html flavour, or nothing left after cleaning). */
export function clipboardToHtml(dt: DataTransfer | null | undefined): string {
  const html = dt?.getData('text/html')
  if (!html || typeof document === 'undefined') return ''
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const root = tpl.content
  // a full document on the clipboard: keep the body's children only
  const body = root.querySelector('body')
  const scope: ParentNode = body ?? root
  for (const junk of Array.from(scope.querySelectorAll('meta, style, script, title, link, head'))) junk.remove()
  for (const b of Array.from(scope.querySelectorAll('b, strong'))) {
    const w = (b as HTMLElement).style.fontWeight.trim().toLowerCase()
    const light = w === 'normal' || w === 'lighter' || (/^\d+$/.test(w) && Number(w) <= 400)
    if (light) {
      const parent = b.parentNode
      if (!parent) continue
      while (b.firstChild) parent.insertBefore(b.firstChild, b)
      b.remove()
    }
  }
  const box = document.createElement('div')
  for (const child of Array.from(scope.childNodes)) box.appendChild(child.cloneNode(true))
  const clean = sanitizeHtml(box.innerHTML)
  // nothing but whitespace/empty tags → let the plain path decide
  const probe = document.createElement('div')
  probe.innerHTML = clean
  return probe.textContent?.trim() || probe.querySelector('br, li') ? clean : ''
}
