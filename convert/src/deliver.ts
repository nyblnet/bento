// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Delivery: a converted document, into a verified shell, safely.
//
// Shared by the CLI (convert/cli.mjs) and the public import page
// (site-src/import/), so the two can never disagree about what makes a
// converted file safe to hand someone. Three steps, each refusing rather than
// degrading:
//
// 1. A SHELL WE CAN VOUCH FOR. The current slides release, fetched the way the
//    home hosts fetch one for a new document: the signed manifest verified with
//    `verifySigned` (kernel/src/update.ts — its own comment calls it the ONLY
//    release-channel crypto in the kernel, and a second implementation "a
//    second thing to get wrong", so this reuses it rather than mirroring it the
//    way the unbundled webext must), then the shell's bytes checked against the
//    signed sha256 pin by `fetchPinned`. A shell that fails anything is
//    REFUSED. There is no "use it anyway".
//
// 2. A DOCUMENT GATED LIKE ANY FOREIGN ONE. A .pptx is attacker-controlled
//    input — typeface names, text, slide names and notes all flow from it into
//    the document. The converted document meets the SAME gate slides applies to
//    every other foreign document, composed exactly as the existing intakes do:
//    slides through `sanitizeSlide` with the drop report (compactload.ts),
//    `sanitizeAssets` and `sanitizeFonts` (editor/clipboard.ts), then the top
//    level through `parseDoc` (compactload.ts again). No new rule is invented
//    here — a second copy of a security rule is how the two drift.
//
// 3. A SPLICE THAT HONOURS THE CONTRACT. The document goes into the shell's
//    empty #bento-doc block with every `<` escaped (`<`), exactly as
//    kernel/src/save.ts writes it, and the <title> is set the same way.
//
//    NOT `serializeWith`, and deliberately. serializeWith also renders a
//    first-page thumbnail, which needs slides' renderer and a DOM: the CLI has
//    no DOM, and dragging the renderer onto the public page would multiply the
//    code security has to review for a thumbnail. And it is what the hosts do
//    for a new document anyway — home/webext writes the raw verified shell
//    bytes, preview-less. The app writes the thumbnail on the first save, as it
//    does for every new document.

import { configureApp } from '../../kernel/src/app.ts'
import { verifySigned, fetchPinned, compareVersions } from '../../kernel/src/update.ts'
import { parseDoc, type BentoDoc, type Slide } from '../../slides/src/model.ts'
import {
  sanitizeAssets, sanitizeFonts, sanitizeSlide, withDropReport, withPathSegment, type Dropped,
} from '../../slides/src/untrusted.ts'

export const SLIDES_MANIFEST = 'https://bento.page/releases/slides/manifest.json'

/**
 * THE OLDEST SHELL A CONVERTED FILE MAY BE BUILT ON. A converted deck carries
 * its shell for good, so a shell with a fixed security hole must never be
 * handed out again, even by a validly signed manifest (a stale mirror or a
 * cached manifest still verifies). Bump this in the release that ships a
 * security fix, to that release's version. scripts/release.mjs refuses a
 * release older than this floor, so the page can never refuse its own release.
 */
export const MIN_SHELL_VERSION = '1.2.5'
const APP_ID = 'bento-slides'

// verifySigned reads the app identity (and a fork's key override) from
// configureApp. Calling it here makes this module self-sufficient; the values
// are the upstream slides identity, the same ones slides/src/main.ts sets.
configureApp({ appId: APP_ID, appName: 'bento/slides', manifestUrl: SLIDES_MANIFEST })

export interface VerifiedShell {
  version: string
  html: string
}

/**
 * The current slides shell, or an Error that says which link of the chain
 * failed. Signature over the pin, pin over the bytes — both, or nothing.
 */
export async function fetchVerifiedShell(
  manifestUrl = SLIDES_MANIFEST,
  net: typeof fetch = fetch,
  /**
   * Map the signed shell URL to the one actually fetched. The public page uses
   * this to fetch from its OWN origin, so its `connect-src 'self'` CSP holds.
   * Safe by construction: trust comes from the signature over the pin and the
   * pin over the bytes, never from the URL, so a resolved URL that serves
   * different bytes is refused by fetchPinned exactly as a tampered CDN would be.
   */
  resolve: (url: string) => string = (u) => u,
): Promise<VerifiedShell> {
  const res = await net(manifestUrl, { cache: 'no-store' })
  if (!res.ok) throw new Error(`could not reach the release server (${res.status})`)
  // The payload shape, restated from kernel/src/update.ts's (private)
  // verifyManifest. The CRYPTO is verifySigned's alone; this is only "is the
  // signed payload a slides release".
  const info = (await verifySigned(await res.text(), 'release manifest')) as Record<string, unknown>
  if (
    info?.app !== APP_ID ||
    typeof info.version !== 'string' ||
    typeof info.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(info.sha256) ||
    typeof info.url !== 'string'
  ) throw new Error('the release manifest payload is malformed — refusing it')
  // Before the shell is fetched: an old release is refused without downloading
  // it. A version that is not plain dotted numbers is refused outright, because
  // compareVersions would read its non-numeric parts as 0.
  if (!/^\d+(\.\d+)*$/.test(info.version))
    throw new Error(`the release server offered a bento/slides version this converter does not recognise ("${info.version.slice(0, 40)}") — refusing it.`)
  if (compareVersions(info.version, MIN_SHELL_VERSION) < 0)
    throw new Error(`the release server offered bento/slides ${info.version}, which is older than ${MIN_SHELL_VERSION}, the oldest version this converter will build on — refusing it. Try again later.`)
  const bytes = await fetchPinned(resolve(info.url), info.sha256)
  if (!bytes) throw new Error('the downloaded shell does not match its signed pin — refusing it')
  return { version: info.version, html: new TextDecoder().decode(bytes) }
}

export interface GateResult {
  doc: BentoDoc
  dropped: Dropped[]
}

/** The untrusted-input gate over a whole converted document (see header §2). */
export function gateDoc(raw: unknown): GateResult {
  if (!raw || typeof raw !== 'object') throw new Error('not a document')
  const src = raw as Record<string, unknown>
  const { result: slides, dropped } = withDropReport(() =>
    ((Array.isArray(src.slides) ? src.slides : []) as unknown[])
      .map((s, i) => withPathSegment('slides', () => withPathSegment(String(i), () => sanitizeSlide(s))))
      .filter((s): s is Slide => s !== null))
  const gated = { ...src, slides, assets: sanitizeAssets(src.assets), fonts: sanitizeFonts(src.fonts) }
  const doc = parseDoc(JSON.stringify(gated))
  if (!doc) throw new Error('the converted document did not pass the format check')
  return { doc, dropped }
}

const BLOCK_OPEN = '<script type="application/bento+json" id="bento-doc">'
// assembled so this source never contains the literal close tag (PLATFORM
// hard-won detail #4 — the same reason save.ts builds it by concatenation)
const SCRIPT_CLOSE = '</' + 'script>'

/**
 * Splice `doc` into a shell's #bento-doc block, the way save.ts writes it.
 * Refuses a shell without exactly one block, and verifies the result by
 * reading the block back.
 */
export function spliceIntoShell(shellHtml: string, doc: BentoDoc): string {
  const first = shellHtml.indexOf(BLOCK_OPEN)
  if (first < 0 || shellHtml.indexOf(BLOCK_OPEN, first + 1) >= 0)
    throw new Error('the shell does not carry exactly one #bento-doc block')
  const start = first + BLOCK_OPEN.length
  const end = shellHtml.indexOf(SCRIPT_CLOSE, start)
  if (end < 0) throw new Error('the #bento-doc block is not closed')
  const body = '\n' + JSON.stringify(doc).replace(/</g, '\\u003c') + '\n'
  let out = shellHtml.slice(0, start) + body + shellHtml.slice(end)
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  out = out.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(doc.title)} — bento/slides</title>`)
  // Belt: the close-tag count must not change, and the block must read back
  // as exactly the document we wrote.
  if (out.split(SCRIPT_CLOSE).length !== shellHtml.split(SCRIPT_CLOSE).length)
    throw new Error('splice changed the script-close count — refusing the output')
  if (JSON.stringify(extractDoc(out)) !== JSON.stringify(doc))
    throw new Error('the spliced document does not read back identically')
  return out
}

/** Read the #bento-doc block of a saved file, parsed. */
export function extractDoc(html: string): unknown {
  const first = html.indexOf(BLOCK_OPEN)
  if (first < 0) throw new Error('not a Bento file (no #bento-doc block)')
  const start = first + BLOCK_OPEN.length
  const end = html.indexOf(SCRIPT_CLOSE, start)
  if (end < 0) throw new Error('the #bento-doc block is not closed')
  const text = html.slice(start, end).trim()
  if (!text) throw new Error('the #bento-doc block is empty — a fresh shell, not a deck')
  try { return JSON.parse(text) } catch { throw new Error('the #bento-doc block is not valid JSON') }
}
