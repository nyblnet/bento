// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Inline-html sanitizer + canonicalizer for block content.
//
// A block's `html` is INLINE ONLY. Block structure is `Block.type`, and the
// renderer emits the semantic tag — so a `<p>` or `<div>` inside a block's html
// is always a mistake, either a paste that smuggled structure in or a browser
// that inserted one during editing.
//
// This is a fork of slides' sanitizer, not a parameterisation, because the
// policies differ in BOTH directions: spaces must reject DIV/P (slides permits
// them) and spaces adds the suite's first attribute allowlist.

import { canonicalMarks, keepClasses } from './marks.ts'

/** Inline tags a block may contain. Nothing here can carry block structure. */
const ALLOWED = new Set([
  'B', 'I', 'U', 'S', 'EM', 'STRONG', 'CODE', 'BR', 'SPAN', 'MARK', 'SUB', 'SUP', 'A',
])

/**
 * The href test. One of the format's TWO attributes — the other is a palette
 * `class` on SPAN/MARK, whose pattern lives in marks.ts (CLASS_OK).
 *
 * MATCHED AGAINST `getAttribute('href')`, NEVER the `.href` IDL property.
 *
 * `.href` returns the RESOLVED ABSOLUTE url, so from file:// the stored
 * `#p/abc` reads back as `file:///…/space.html#p/abc` and fails this test —
 * stripping every internal link — while on a static host it becomes
 * `https://…#p/abc` and passes. Measured. The bug would be invisible in the
 * environment an author develops in and total in the two environments the
 * format exists for (file://, and bento/home on iOS).
 *
 * `#p/` is an intra-space page link. There is deliberately no second fragment
 * form: an undefined entry in this list is a one-way data hazard, because an
 * href written under a permissive build gets STRIPPED by a stricter later one,
 * silently, on the next edit that touches the block.
 */
const HREF_OK = /^(https?:|mailto:|#p\/)/i

/**
 * The OUTWARD half of HREF_OK, for an href that is not inline html.
 *
 * A link card's `url` is a block FIELD, so it never passes through
 * sanitizeInline — and a block field out of a mailed file is exactly as
 * untrusted as an attribute in one. Returns the url to use, or '' for anything
 * that is not an outward link, so the caller's test is "did I get a string
 * back" rather than a boolean it can forget to act on.
 *
 * ALLOWLIST, and on the RAW string, for both of sanitizeInline's reasons. A
 * blocklist of `javascript:` loses to the parser's own leniency: `ja&#9;vascript:x`
 * and ` javascript:x` are both `javascript:` by the time an href is followed,
 * because the URL parser strips tabs, newlines and leading whitespace from a
 * scheme. Neither one starts with `https:`, so both fail this test — an
 * allowlist fails CLOSED against a normalisation nobody has thought of yet.
 *
 * `#p/` is deliberately NOT here. An internal page link is a pagelink block,
 * which is a different type with a different renderer; letting a link card hold
 * one would be a second way to say the same thing, differing only in which of
 * the two a future build fixes a bug in.
 */
export function externalHref(raw: unknown): string {
  const url = typeof raw === 'string' ? raw.trim() : ''
  return /^(https?:|mailto:)/i.test(url) ? url : ''
}

/**
 * Tags whose CONTENT should survive when the tag itself is dropped.
 *
 * Exported because validate() tells an agent which block-level tags get
 * unwrapped out of inline html. A second copy of this list would go stale the
 * first time this one changes, and validate() would then advise an agent to
 * "fix" markup that is actually fine — or stay silent about markup that is not.
 */
export const UNWRAP = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'PRE', 'FONT'])

/**
 * Parse untrusted html into an INERT document, and never into a live element.
 *
 * `document.createElement('div').innerHTML = hostile` looks safe because the
 * div is detached. It is not: the elements it creates belong to the live
 * document, so their resources LOAD. `<img src="404" onerror="…">` runs its
 * handler from a div that was never inserted anywhere.
 *
 * Measured in the browser, 2026-08-03: detached div FIRES; `DOMParser`,
 * `<template>` and `createHTMLDocument` do not, and the markup survives intact
 * for cleaning either way.
 *
 * That made the sanitizer its own vector — it has to parse hostile markup
 * before it can strip it, so the payload ran BEFORE the strip, at render time,
 * on opening a space someone sent you. Every entry point for untrusted html
 * goes through here, which is why it is exported: `render.ts` needs it too.
 */
export function inertBody(html: string): HTMLElement {
  return new DOMParser().parseFromString(html, 'text/html').body
}

/**
 * Strip everything outside the allowlist, in place.
 *
 * Structure-carrying tags are UNWRAPPED (their text survives) rather than
 * deleted — losing a paragraph's words because it arrived wrapped in a `<p>`
 * would be the worst possible reading of "inline only".
 */
export function sanitizeInline(html: string): string {
  if (typeof document === 'undefined') return stripAllTags(html)
  const host = inertBody(html)

  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue
      if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue }
      const el = child as HTMLElement
      const tag = el.tagName

      if (!ALLOWED.has(tag)) {
        walk(el)
        if (UNWRAP.has(tag)) {
          // a block boundary inside inline content becomes a space, not a join:
          // "<p>a</p><p>b</p>" must not become "ab"
          const needsGap = el.nextSibling || el.previousSibling
          while (el.firstChild) el.parentNode!.insertBefore(el.firstChild, el)
          // el.ownerDocument, not `document`: the host lives in the inert
          // parsed document now. Cross-document insert would work (DOM4 adopts
          // implicitly) but relying on that is a trap for the next edit.
          if (needsGap) el.parentNode!.insertBefore(el.ownerDocument.createTextNode(' '), el)
        }
        el.remove()
        continue
      }

      for (const attr of [...el.attributes]) {
        if (tag === 'A' && attr.name === 'href' && HREF_OK.test(attr.value)) continue
        // THE SECOND ATTRIBUTE THIS FORMAT HAS: a palette class on SPAN or
        // MARK, and only a name matching CLASS_OK (marks.ts). Filtered per
        // TOKEN, so `class="sp-fg-red onclick-bait"` keeps the first and drops
        // the second rather than failing whole and losing the colour.
        //
        // A CLASS, NOT A `style`. A style attribute would make this function a
        // CSS parser — and CSS is a language with `url()` in it — while a class
        // name can only ever select a rule in OUR stylesheet or select nothing.
        if (tag === 'SPAN' || tag === 'MARK') {
          if (attr.name === 'class') {
            const kept = keepClasses(attr.value)
            if (kept) { el.setAttribute('class', kept); continue }
          }
        }
        el.removeAttribute(attr.name)
      }
      // an <a> that lost its href is no longer a link — unwrap it
      if (tag === 'A' && !el.getAttribute('href')) {
        walk(el)
        while (el.firstChild) el.parentNode!.insertBefore(el.firstChild, el)
        el.remove()
        continue
      }
      // external links open away from the document; internal ones must not
      if (tag === 'A') {
        const href = el.getAttribute('href')!
        if (!href.startsWith('#')) { el.setAttribute('rel', 'noopener noreferrer'); el.setAttribute('target', '_blank') }
      }
      walk(el)
    }
  }
  walk(host)
  return host.innerHTML
}

/** No-DOM fallback (node tooling): drop every tag, keep the words. */
function stripAllTags(html: string): string {
  return html
    .replace(/<(p|div|br|li|h[1-6]|blockquote|pre)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Canonical form, run at typing-run close (never mid-run — it would move the
 * caret).
 *
 * MUST BE IDEMPOTENT. A future materialize → DOM → re-serialize round trip
 * runs this again, and a canonicalizer that keeps changing its own output
 * would re-trip text merging on every keystroke.
 */
export function canonicalize(html: string): string {
  // TWO STAGES, and only the first one needs a browser. sanitizeInline decides
  // what is ALLOWED to be here (a DOM question — it has to parse hostile markup
  // inertly to answer it); canonicalMarks decides what SHAPE the allowed marks
  // take, which is a string question and therefore one a rig can test.
  //
  // This used to be a fixed-point loop of `</b><b>` → `''` string replacements.
  // It coalesced adjacent runs and dropped empty ones, and it could do nothing
  // at all about §2.3's other half — nesting order — because "is this <i>
  // inside or outside that <b>" is not a question a replaceAll can ask. So
  // `<b><i>x</i></b>` and `<i><b>x</b></i>` were both canonical, which makes
  // every diff and every CRDT merge of the same visible text a conflict.
  return canonicalMarks(sanitizeInline(html))
}

/** Plain text of a block, for search and for markdown export. */
export function textOf(html: string | undefined): string {
  if (!html) return ''
  if (typeof document === 'undefined') return stripAllTags(html)
  return inertBody(html).textContent ?? ''
}

/** Escape for safe insertion as text. */
export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * A `code` block's text, as `Block.html` stores it.
 *
 * `&`, `<`, `>` and NOTHING ELSE — exactly what an html serializer emits for a
 * text node, which is what `code.innerHTML` produced before syntax colouring
 * made that read unusable (the host now holds `<span>`s). So a code block typed
 * today serializes byte-identically to one typed before highlighting existed,
 * and `render.ts`'s `textFromHtml` decodes both.
 *
 * `esc()` above escapes `"` as well, correctly, because it writes ATTRIBUTE
 * values. Doing that here would not round-trip: the parser hands back a bare
 * quote, so the next save would differ from the last for no reason, forever.
 */
export const escText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
