// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The still in the splash (spike-still-splash, option A: "still-copy").
 *
 * The file already carries a static render of page one for thumbnailers
 * (preview.ts → kernel writePreview): `[data-bento-preview]` right after the
 * splash, deleted by a parser-blocking remover before the browser paints, so
 * a reader never sees it. That deletion is the guarantee thumbnails depend on
 * and it is NOT touched here. This module puts a SECOND copy of the same
 * markup INSIDE the splash element, which precedes the preview in byte order
 * and is not swept by the remover — so the first frame a reader paints is
 * page one instead of the blue splash, and the app fades it out on mount.
 *
 * Rules, mirrored from the kernel's preview rules:
 *   - REPLACE, NEVER APPEND: the pristine shell was captured with last save's
 *     copy inside the splash; it is stripped before a new one is written.
 *   - ABSENT for an encrypted deck (previewAllowed) — page one in plaintext
 *     beside the ciphertext is the leak the password exists to prevent.
 *   - FULL TIER ONLY: when preview.ts had to drop images for tinted boxes
 *     or fall back to a title card, the reader would see that degraded page
 *     for a moment before the real one — the blue splash is better than a
 *     wrong-looking page. The tier is decided at save time, so the copy is
 *     simply not written.
 *   - The markup passes the kernel's previewIsSafe like the preview does.
 *
 * Applied as string surgery on the serialized file by the slides save facade
 * (save.ts), the same layer that prunes assets: the kernel is untouched.
 */

import type { BentoDoc } from './model'
import { buildSlidePreview } from './preview'
import { previewAllowed, previewIsSafe } from '../../kernel/src/save.ts'

export const STILL_ATTR = 'data-bento-still'
const STILL_END = '<!--bento-still-end-->'
// Built by concatenation, all of them: the compressor (postbuild-compress.mjs)
// finds the splash and the doc block in the built HTML by regex, and the
// bundle is inline in that HTML — a literal splash opener or script opener
// inside this module's source would be found FIRST and the
// compressor would carry 1.6 MB of bundle as "the splash" (measured).
// CLAUDE.md hard-won #4 is the same rule for `</script>`.
// (Array.join, not `+`: esbuild constant-folds a `+` of two literals back
// into the one literal the compressor greps for — measured, it did.)
const SPLASH_TAG = ['<div id="bento-', 'splash"'].join('')
const SPLASH_OPEN = new RegExp(SPLASH_TAG + '([^>]*)>')
const DOC_BLOCK = new RegExp(['<scr', 'ipt type="application\\/bento\\+json" id="bento-doc">\\s*([\\s\\S]*?)\\s*<\\/scr', 'ipt>'].join(''))

/** Strip a still written by a previous save (replace-never-append). */
export function stripStill(html: string): string {
  const re = new RegExp(`<div ${STILL_ATTR}="1">[\\s\\S]*?${STILL_END}`, 'g')
  let out = html
  for (let prev = ''; prev !== out;) { prev = out; out = out.replace(re, '') }
  return out.replace(SPLASH_OPEN, (_m, attrs: string) =>
    `${SPLASH_TAG}${attrs.replace(new RegExp(` ${STILL_ATTR}="1"`, 'g'), '')}>`)
}

/**
 * Which tier did preview.ts land on? It returns the element without saying;
 * the tiers leave fingerprints that survive `slim`: a rendered page is a
 * `.bento-slide`; tier 2 replaced every image with the accent-tinted box
 * gradient; tier 3 is a title card with no `.bento-slide` at all.
 */
export function previewTier(el: HTMLElement, doc: BentoDoc): 1 | 2 | 3 {
  const html = el.outerHTML
  if (!/class="[^"]*\bbento-slide\b/.test(html)) return 3
  const tint = `linear-gradient(135deg,${doc.theme.accent}2E,${doc.theme.accent}12)`
  return html.includes(tint) ? 2 : 1
}

/**
 * Write page one into the splash of a serialized file, or leave the splash
 * blue. `encrypted` is the session's password flag; the body is re-checked
 * for an envelope too (previewAllowed), the way the kernel does.
 */
export function withStillCopy(html: string, doc: BentoDoc, encrypted: boolean): string {
  const out = stripStill(html)
  const open = SPLASH_OPEN.exec(out)
  if (!open) return out
  const body = DOC_BLOCK.exec(out)?.[1] ?? ''
  if (!previewAllowed(body, encrypted)) return out
  let el: HTMLElement | null = null
  try { el = buildSlidePreview(doc) } catch { return out }
  if (!el || previewTier(el, doc) !== 1) return out
  const markup = el.outerHTML
  if (!previewIsSafe(markup)) return out
  const copy = `<div ${STILL_ATTR}="1">${markup}</div>${STILL_END}`
  return out.replace(SPLASH_OPEN, (_m, attrs: string) => `${SPLASH_TAG}${attrs} ${STILL_ATTR}="1">${copy}`)
}
