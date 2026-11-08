// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// An embed's picture (an SVG from another Bento app) made safe by ALLOWLIST.
//
// Built on the kernel's shared sanitizer (kernel/src/svgsafe.ts — bento/slides'
// sanitizeSvg, which is released and has held up, lifted so both apps audit
// one walk): parse inert, walk every element, keep a tag or an attribute only
// if its NAME is on a list. An embed's picture needs less than a slide's
// diagram, so EMBED_POLICY TIGHTENS slides' default — a policy can only
// tighten — to no <style> element or attribute, no <a>, no data-*, and no
// remote reference of any kind.
//
// WHY A WALK, NOT A PATTERN. The earlier check (embed.ts safeView) looked for
// an event handler as whitespace + "on…=". The HTML tokenizer also begins an
// attribute name after `/` and after a closed quote, so `<circle/onmouseover=…>`
// passed and ran (measured, in the editor). Reading `el.attributes` after the
// browser parsed the markup is right whatever the separators were, and an on*
// attribute is never kept because it was never on the list.
//
// Guarded by scripts/test-type-sinks-browser.mjs (and, for the shared walk,
// scripts/test-sanitize.ts and scripts/test-svgsafe-policy-browser.mjs).

import { cleanSvgElement, type SvgPolicy } from '../../kernel/src/svgsafe.ts';

/** An embed's picture needs less than a slide's diagram, so type TIGHTENS slides' default. */
export const EMBED_POLICY: SvgPolicy = {
  scopeStyle: null,              // no <style> element, no style attribute
  refuseTags: ['a'],             // no navigation out of a picture
  refuseAttrs: [
    'baseprofile', 'color-interpolation', 'color-interpolation-filters', 'cursor', 'enable-background',
    'font', 'font-size-adjust', 'font-stretch', 'font-variant', 'isolation', 'media', 'mix-blend-mode',
    'pointer-events', 'requiredextensions', 'requiredfeatures', 'systemlanguage', 'tabindex', 'target',
    'title', 'type', 'unicode-bidi', 'white-space', 'zoomandpan',
  ],                             // hygiene, not a boundary: 'title' is the ATTRIBUTE (the <title> element stays)
  dataAttrs: false,
  remoteHref: false,             // #refs, and inline rasters on image/feImage only
  strictValues: true,            // no escapes, no foreign schemes, url(#…) only (defence in depth: the base walk decodes escapes before judging url())
};

/**
 * The sanitized <svg>, as an element of an INERT document — the caller imports
 * it (never re-parses a string), or null when the markup is not an svg at all.
 */
export function sanitizeEmbedSvg(markup: string): Element | null {
  if (typeof DOMParser === 'undefined' || typeof markup !== 'string') return null;
  const parsed = new DOMParser().parseFromString(markup.trim(), 'text/html');
  const root = parsed.body.firstElementChild;
  if (!root || root.localName.toLowerCase() !== 'svg') return null;
  if (!cleanSvgElement(root, EMBED_POLICY)) return null;
  // nothing outside the one <svg> survives
  for (const n of Array.from(parsed.body.childNodes)) if (n !== root) n.remove();
  return root;
}

/** The same, serialized — for the string-built print and preview documents. */
export function sanitizeEmbedSvgHtml(markup: string): string | null {
  const el = sanitizeEmbedSvg(markup);
  return el ? el.outerHTML : null;
}
