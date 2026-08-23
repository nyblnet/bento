// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Slide image export — PNG/JPEG for one slide, a ZIP for the linear flow.
//
// Verified by:
//   scripts/test-slide-image-export.ts          (pure: selection/naming/size/time)
//   scripts/test-slide-image-export-browser.ts  (raster, from a real file:// page)
//
// The first half of this file holds the decisions an export makes BEFORE it
// allocates anything — pure on purpose, so node can hold them to account. The
// second half is the raster path, which needs a browser and is proven with
// pixels and a request log by the browser rig.
//
// THE ONE RULE THAT SHAPES EVERYTHING BELOW: an exported image must be a
// function of the document alone. It fetches nothing (a self-contained file
// that phones home while you export it is the bug this whole feature could
// most easily introduce), it renders no private data, and it mutates nothing.

import type { BentoDoc, MediaElement, Slide, SlideElement, SvgElement } from './model'
import { inLinearFlow } from './model'
import {
  fieldContext, renderElement, renderSlide, svgHrefAllowed,
  type FieldContext,
} from './render'
import { SlideImageExportError, type SlideImageExportCode } from './image-export-errors'
import { writeStoreZip, type StoreZipEntry } from './image-export-zip'

export type SlideImageFormat = 'png' | 'jpeg'
export type SlideImageScope = 'current' | 'all-main'
export type SlideImageScale = 1 | 2

export interface SlideImageExportOptions {
  scope: SlideImageScope
  format: SlideImageFormat
  scale: SlideImageScale
}

export interface PlannedSlideImage {
  slide: Slide
  /** Zero-based position in doc.slides; never display this directly. */
  documentIndex: number
  /** One-based document position used in filenames and user-facing errors. */
  slideNumber: number
  /** One-based ordinal within the selected export set. */
  exportIndex: number
  entryName: string
}

export interface SlideImageExportPlan {
  slides: PlannedSlideImage[]
  mime: 'image/png' | 'image/jpeg'
  extension: 'png' | 'jpg'
  artifactName: string
  capturedAt: Date
}

// Re-exported so every caller keeps importing it from here, and so `instanceof`
// still narrows: this is the SAME class object, not a copy.
export { SlideImageExportError }
export type { SlideImageExportCode }

/** Checked raster bounds, supplied by the caller rather than assumed. */
export interface RasterLimits {
  maxDimension: number
  maxPixels: number
}

// --- naming -----------------------------------------------------------------

/**
 * Windows refuses these as filenames whatever extension follows, and a browser
 * download named CON is a download that silently does not happen.
 */
// The extension is part of it: Windows refuses CON.txt exactly as it refuses
// CON, and a bare-name check misses the half people actually type.
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * A conservative budget for ONE filesystem path component, in UTF-8 BYTES.
 *
 * BYTES, not characters: APFS and ext4 cap a component at 255 *bytes*, so a
 * 96-character title is fine in English and 288 bytes — over the limit — in
 * Japanese. 200 leaves room for the browser's own " (1)" de-duplication suffix
 * on a second download.
 */
export const MAX_FILENAME_BYTES = 200

/** What a title that sanitizes away is called. */
const FALLBACK_BASE = 'Untitled'

const utf8 = new TextEncoder()
export function utf8Length(s: string): number {
  return utf8.encode(s).length
}

/**
 * Truncate to a UTF-8 byte budget without ever splitting a code point.
 *
 * `String.slice` counts UTF-16 units, so it can cut an emoji in half and leave
 * a LONE SURROGATE — which is not representable in UTF-8 and comes back out of
 * any encoder as U+FFFD. Iterating the string yields code points, so the worst
 * this can do is drop a whole character.
 */
function truncateToBytes(s: string, budget: number): string {
  if (budget <= 0) return ''
  if (utf8Length(s) <= budget) return s
  let out = ''
  let used = 0
  for (const codePoint of s) {
    const n = utf8Length(codePoint)
    if (used + n > budget) break
    out += codePoint
    used += n
  }
  return out
}

/**
 * A deck title, turned into something a filesystem will actually accept.
 *
 * Deliberately NOT kernel `suggestedFileName`, which maps everything outside
 * `[\w\d-]` to "_" — that is ASCII-only, so a deck called 決算報告 saves as
 * "Untitled". An image export is the one artifact people file away by name, so
 * this keeps every letter a language uses and removes only what a filesystem
 * genuinely refuses.
 *
 * `budgetBytes` is the space left for the BASE after its suffix: the caller
 * knows whether "-slides.zip" or "-slide-05.png" is about to be appended, and
 * the whole filename is what has to fit.
 */
export function exportBaseName(title: string, budgetBytes: number = MAX_FILENAME_BYTES): string {
  let s = String(title ?? '')
  // control characters: never legal in a name, never meaningful in a title
  s = s.replace(new RegExp('[\\u0000-\\u001F\\u007F]', 'g'), '')
  // Path separators plus the set Windows rejects. Replaced with a SPACE, not a
  // dash: "Q3 // Ergebnis" should read as words, not as punctuation.
  s = s.replace(/[<>:"/\\|?*]/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  // A leading dot makes a hidden file; a trailing dot or space is dropped by
  // Windows without telling anyone, which turns "a." and "a" into one name.
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '').trim()
  s = truncateToBytes(s, Math.max(0, budgetBytes))
  // truncation can expose a NEW trailing dot or space
  s = s.replace(/[. ]+$/, '').trim()
  if (!s) return FALLBACK_BASE
  // The "_" costs a byte, so re-fit rather than quietly overrunning the budget.
  return RESERVED_DEVICE.test(s) ? truncateToBytes(`_${s}`, Math.max(0, budgetBytes)) : s
}

// --- the plan ---------------------------------------------------------------

/**
 * Decide what will be exported, under what names, at what moment.
 *
 * Pure: it reads the document and returns a description. Nothing here touches
 * the DOM, allocates a raster, or mutates `doc` — which is what lets the whole
 * selection contract be tested in node.
 */
export function buildSlideImageExportPlan(
  doc: BentoDoc,
  currentSlideId: string,
  options: SlideImageExportOptions,
  capturedAt: Date,
): SlideImageExportPlan {
  const extension = options.format === 'jpeg' ? 'jpg' : 'png'
  const mime = options.format === 'jpeg' ? 'image/jpeg' : 'image/png'
  const all = doc.slides ?? []

  const selected: Array<{ slide: Slide; documentIndex: number }> = []
  if (options.scope === 'current') {
    const documentIndex = all.findIndex((s) => s.id === currentSlideId)
    if (documentIndex < 0) {
      throw new SlideImageExportError('missing-current',
        'The slide being exported is no longer in this deck.')
    }
    selected.push({ slide: all[documentIndex], documentIndex })
  } else {
    all.forEach((slide, documentIndex) => {
      if (inLinearFlow(slide)) selected.push({ slide, documentIndex })
    })
    if (!selected.length) {
      throw new SlideImageExportError('no-slides',
        'This deck has no slides in the linear flow to export.')
    }
  }

  // A single image is filed next to the deck, so it carries the number the
  // author sees in the sidebar. Archive entries carry their own contiguous
  // ordinal, because an unzipped folder is read as a sequence and a gap in it
  // looks like a failed export.
  const padTo = options.scope === 'current'
    ? Math.max(2, String(all.length).length)
    : Math.max(2, String(selected.length).length)

  const slides: PlannedSlideImage[] = selected.map((sel, i) => {
    const slideNumber = sel.documentIndex + 1
    const exportIndex = i + 1
    const ordinal = options.scope === 'current' ? slideNumber : exportIndex
    return {
      slide: sel.slide,
      documentIndex: sel.documentIndex,
      slideNumber,
      exportIndex,
      entryName: `slide-${String(ordinal).padStart(padTo, '0')}.${extension}`,
    }
  })

  // The SUFFIX is known before the base is, so the base gets exactly the space
  // the whole filename can spare — a title trimmed to the budget and THEN given
  // a suffix would push the component back over it.
  const suffix = options.scope === 'current' ? `-${slides[0].entryName}` : '-slides.zip'
  const base = exportBaseName(doc.title, MAX_FILENAME_BYTES - utf8Length(suffix))
  const artifactName = base + suffix

  return { slides, mime, extension, artifactName, capturedAt }
}

// --- time -------------------------------------------------------------------

/**
 * The field context an exported slide renders against.
 *
 * `fieldContext` mints `new Date()` per call, which is right on screen and
 * wrong here: a 40-slide export that straddles midnight would print two dates
 * into one carousel. Every slide in a batch gets the SAME captured instant.
 *
 * `page`/`pages` are deliberately left alone. They are the audience's numbers
 * (`paginates()`, honouring `doc.present.numberHidden`) and must not silently
 * become the export ordinal just because both count slides.
 */
export function fieldContextForExport(doc: BentoDoc, slide: Slide, capturedAt: Date): FieldContext {
  return { ...fieldContext(doc, slide), date: capturedAt }
}

// --- sizing -----------------------------------------------------------------

/**
 * The backing-store dimensions for one slide, checked before anything is
 * allocated. `doc.size` came out of a document, and a document is untrusted
 * input: a fractional, negative or absurd size must fail as a message, not as
 * an out-of-memory tab.
 */
export function rasterSize(
  size: { width: number; height: number },
  scale: SlideImageScale,
  limits: RasterLimits,
): { width: number; height: number; pixels: number } {
  for (const axis of ['width', 'height'] as const) {
    const v = size?.[axis]
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
      throw new SlideImageExportError('size',
        `This deck's ${axis} (${String(v)}) is not a whole number of pixels, so it cannot be exported as an image.`)
    }
  }
  if (scale !== 1 && scale !== 2) {
    throw new SlideImageExportError('size', `Unsupported export scale: ${String(scale)}.`)
  }

  const width = size.width * scale
  const height = size.height * scale
  // AFTER the scale: 2x is what actually allocates, so 2x is what is checked.
  // The messages describe OUR budget, not a capability of the reader's browser.
  // We have measured one engine; promising anything about theirs would be a
  // claim this app has not earned.
  if (width > limits.maxDimension || height > limits.maxDimension) {
    throw new SlideImageExportError('size',
      `${width}×${height} is larger than this app will export (the limit is ` +
      `${limits.maxDimension} pixels per side).`)
  }
  const pixels = width * height
  if (pixels > limits.maxPixels) {
    throw new SlideImageExportError('size',
      `${width}×${height} is more pixels than this app will export in one image.`)
  }
  return { width, height, pixels }
}

// ============================================================================
// The raster half. Everything below needs a browser, and every claim it makes
// is measured by scripts/test-slide-image-export-browser.ts from a real
// file:// page — not by reading this code.
// ============================================================================

// --- measured limits --------------------------------------------------------
//
// MEASURED, Chrome 151.0.7922.138 (macOS arm64), by
// `scripts/test-slide-image-export-browser.ts --characterize`:
//
//   per side, thin rectangles:  4096 / 8192 / 10000 / 16384 / 22000 / 32768 all
//                               drew, read back and encoded (≤19ms each)
//   area, squares:              4 MP 39ms · 17 MP 149ms · 38 MP 297ms ·
//                               67 MP (8192²) 554ms — 67 MP is where the SCAN
//                               was capped, not where Chrome failed
//   product shapes:             1080² @2x 41ms · 1280×720 @2x 30ms ·
//                               4000² @1x 109ms
//
// The constants below are FAR under all of that, and deliberately so.
//
// CHROME IS THE ONLY ENGINE THESE NUMBERS COME FROM. No other browser has been
// measured for this feature, so the shipped budget is not derived from what
// Chrome managed — it is a deliberately conservative PRODUCT POLICY chosen to
// leave a wide margin for engines nobody here has tested yet. Two reasons to
// prefer a policy to a measurement:
//
//   · a limit that is generous on the one engine we measured could still be a
//     cliff on one we did not, and this code cannot tell the difference; and
//   · the failure we most need to avoid is not a refusal but a WRONG IMAGE. If
//     any engine responds to an over-large canvas by producing something blank
//     or truncated instead of throwing, our own check is the only thing between
//     the user and an export that silently is not what they asked for.
//
// So these numbers should be READ as "what we are willing to promise", not as
// "what browsers can do". Raising them is a product decision that needs
// measurements from the engines being promised — see the residual risk noted
// with this feature.
//
// What this budget allows and refuses, stated so nobody has to derive it:
//
//   allowed   2160×2160 (the acceptance floor)      4.7 MP
//             1080×1080 @2x — the carousel case     4.7 MP
//             1280×720 and 1600×900 @2x             3.7 / 5.8 MP
//             4000×4000 @1x                        16.0 MP  (just inside)
//   refused   4000×4000 @2x                        64.0 MP
//
// That last line is a real product limitation, surfaced rather than hidden: a
// 4000px deck cannot be exported at 2x. It is refused before allocation with a
// message naming the size, never silently downscaled.

export const EXPORT_LIMITS: RasterLimits = {
  maxDimension: 8192,
  maxPixels: 4096 * 4096,
}

/**
 * Every budget an export is held to, in one place so they can be reasoned about
 * together and injected small by tests.
 *
 * All of them are POLICY. Each exists to refuse an allocation rather than to
 * survive one, which is why every check below is performed against a LENGTH or
 * a header field — never by doing the thing and catching the failure.
 */
export interface ExportBudgets {
  /**
   * One embedded resource, in URI CHARACTERS.
   *
   * Characters, not bytes, and the name says so. This bound is checked BEFORE
   * any decode — that is its entire purpose — so a byte count is not available
   * to it, and base64 runs about 4/3 the size of what it encodes. A field
   * called "bytes" holding characters is how a budget silently becomes a third
   * larger than whoever set it believed.
   */
  maxResourceUriChars: number
  /** All DISTINCT selected resources together, same unit. */
  maxTotalResourceUriChars: number
  /** Longest side an embedded image may declare in its header. */
  maxImageDimension: number
  /** Intrinsic pixels an embedded image may declare in its header. */
  maxImagePixels: number
  /**
   * Intrinsic pixels of all DISTINCT images on ONE slide, added up.
   *
   * The bound no single-resource limit can express: twelve different 4000x4000
   * photographs are each perfectly legal and each compress to a few hundred KB,
   * and decoding them onto one surface is three quarters of a gigabyte.
   */
  maxSlideImagePixels: number
  /** Raw author SVG markup, in characters, checked before it is parsed. */
  maxAuthorMarkupChars: number
  /** Raw author CSS, in characters, checked before it is scanned. */
  maxAuthorCssChars: number
  /**
   * A decoded resource, in real bytes. Separately named because it is a
   * separate question, answered after the decode the bounds above gate.
   */
  maxDecodedResourceBytes: number
  /** The serialized outer SVG, in UTF-8 bytes. */
  maxSerializedBytes: number
  /** Its percent-encoded data URI, in characters. */
  maxDataUriChars: number
  /** Encoded images held while a batch accumulates, in bytes. */
  maxEncodedBatchBytes: number
}

export const EXPORT_BUDGETS: ExportBudgets = {
  maxResourceUriChars: 32 * 1024 * 1024,
  maxTotalResourceUriChars: 96 * 1024 * 1024,
  // BOTH bounds, because either one alone has a hole in it. 40 megapixels
  // covers any photograph anyone puts on a slide; 32768 per side covers any
  // shape one comes in. A pixel budget alone waves through 1 x 16,000,000 —
  // sixteen megapixels, and a sixteen-million-row bitmap. A side budget alone
  // waves through 40000 x 40000. A 33-byte PNG header can ask for either.
  maxImageDimension: 32768,
  maxImagePixels: 40_000_000,
  // Four of the largest single image we allow. Generous for real decks, and
  // still far short of a slide that asks for a gigabyte of decoded bitmap.
  maxSlideImagePixels: 160_000_000,
  maxAuthorMarkupChars: 4 * 1024 * 1024,
  maxAuthorCssChars: 1024 * 1024,
  maxDecodedResourceBytes: 24 * 1024 * 1024,
  maxSerializedBytes: 24 * 1024 * 1024,
  maxDataUriChars: 48 * 1024 * 1024,
  // Deliberately modest. Building the archive holds the encoded images, then a
  // buffer of the same size, then a Blob copy — roughly THREE times this at the
  // peak. 192 MiB keeps that peak under 1 GiB, which is the number that matters
  // on a laptop with a browser and a deck already open.
  maxEncodedBatchBytes: 192 * 1024 * 1024,
}

/** How long a download's object URL stays alive. */
export const DOWNLOAD_REVOKE_MS = 60_000

/**
 * Refuse a distinct set of resources on LENGTH alone, before anything decodes.
 *
 * DEDUPLICATED, because the export embeds each payload once however many slides
 * use it: charging a logo twelve times would refuse a deck that is perfectly
 * fine. Pure, so the guard can be exercised with small injected limits instead
 * of by allocating what it exists to prevent.
 */
export function assertResourceBudgets(
  uris: readonly string[],
  budgets: ExportBudgets = EXPORT_BUDGETS,
): { distinct: number; uriChars: number } {
  const seen = new Set<string>()
  let uriChars = 0
  for (const uri of uris) {
    if (seen.has(uri)) continue
    seen.add(uri)
    if (uri.length > budgets.maxResourceUriChars) {
      throw new SlideImageExportError('size',
        'One of this deck\'s embedded images or fonts is larger than this app will export.')
    }
    uriChars += uri.length
    if (uriChars > budgets.maxTotalResourceUriChars) {
      throw new SlideImageExportError('size',
        'The images and fonts these slides use come to more than this app will export at once. ' +
        'Try exporting the current slide instead.')
    }
  }
  return { distinct: seen.size, uriChars }
}

/**
 * Pool the intrinsic pixels of the DISTINCT images on each slide.
 *
 * Distinct per slide, because one picture used four times is one decode. Per
 * slide rather than per document, because a slide is what gets rendered onto a
 * surface all at once.
 */
export function assertSlideImagePixelBudget(
  entries: ReadonlyArray<{ slideNumber: number; uri: string; pixels: number }>,
  budgets: ExportBudgets = EXPORT_BUDGETS,
): void {
  const perSlide = new Map<number, { seen: Set<string>; pixels: number }>()
  for (const entry of entries) {
    let slot = perSlide.get(entry.slideNumber)
    if (!slot) { slot = { seen: new Set(), pixels: 0 }; perSlide.set(entry.slideNumber, slot) }
    if (slot.seen.has(entry.uri)) continue
    slot.seen.add(entry.uri)
    slot.pixels += entry.pixels
    if (slot.pixels > budgets.maxSlideImagePixels) {
      throw new SlideImageExportError('size',
        `The images on slide ${entry.slideNumber} come to ${slot.pixels} pixels together, ` +
        'which is more than this app will decode for one slide.', entry.slideNumber)
    }
  }
}

/**
 * Bound raw author input BEFORE a parser touches it.
 *
 * A megabyte of markup is a megabyte of DOM, and a scanner that walks a
 * pathological stylesheet is a scanner that does not return. Both are cheap to
 * refuse and expensive to survive.
 */
export function assertAuthorInputBudget(
  kind: 'markup' | 'css',
  text: string,
  slideNumber: number,
  budgets: ExportBudgets = EXPORT_BUDGETS,
): void {
  assertAuthorInputLength(kind, text.length, slideNumber, budgets)
}

/**
 * The same bound, expressed over a LENGTH.
 *
 * The cumulative first pass adds up every string on a slide without
 * concatenating them — building the joined string to measure it would be the
 * allocation this check exists to avoid.
 */
function assertAuthorInputLength(
  kind: 'markup' | 'css',
  chars: number,
  slideNumber: number,
  budgets: ExportBudgets = EXPORT_BUDGETS,
): void {
  const limit = kind === 'markup' ? budgets.maxAuthorMarkupChars : budgets.maxAuthorCssChars
  if (chars > limit) {
    throw new SlideImageExportError('size',
      `The drawings on slide ${slideNumber} carry ${chars} characters of ` +
      `${kind === 'markup' ? 'markup' : 'stylesheet'}, which is more than this app will export.`,
      slideNumber)
  }
}

/**
 * The candidates in a `srcset`.
 *
 * `srcset` is a LIST — `a.png 1x, http://evil/b.png 2x` is two URLs in one
 * attribute — and the browser picks whichever it likes. Reading the value as a
 * single reference checks the first candidate and lets every other one through.
 *
 * Splitting on commas is not enough either: a `data:` URI contains commas. So
 * this walks candidates, and only treats a comma as a separator once the URL
 * has ended at whitespace.
 */
export function srcsetCandidates(value: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < value.length) {
    // leading separators
    while (i < value.length && /[\s,]/.test(value[i])) i++
    if (i >= value.length) break
    // The URL runs to the next whitespace. A comma inside it is only a
    // separator once the URL has ENDED — which is what keeps a data: URI, full
    // of commas, from being shredded into fragments.
    let url = ''
    while (i < value.length && !/\s/.test(value[i])) { url += value[i]; i++ }
    // "a.png, b.png" — no descriptor at all, so the comma is stuck to the URL
    // and has to come back off. Only trailing commas: an interior one is data.
    let trailing = 0
    while (url.endsWith(',')) { url = url.slice(0, -1); trailing++ }
    if (url) out.push(url)
    // With a trailing comma this candidate is already finished. Without one,
    // skip its descriptor up to the comma that ends it.
    if (trailing === 0) while (i < value.length && value[i] !== ',') i++
  }
  return out
}

// --- reading CSS the way a browser does -------------------------------------
//
// The audit that decides "would this fetch" reads CSS, and CSS is a TOKEN
// GRAMMAR, not a string. `url(` may be spelled `u\72l(`, `\75rl(` or `URL(` —
// all the same function to every browser, all different strings to every
// regex. scripts/test-sanitize.ts already measured that exact class of bypass
// FETCHING for `@\69mport`, so this scans with the grammar's own rules:
// comments are skipped, strings are skipped, and every identifier is unescaped
// before it is compared.

interface CssScan {
  urls: string[]
  atKeywords: string[]
}

/**
 * Resolve one CSS escape, per CSS Syntax \u00A74.3.7.
 *
 * Zero, a surrogate, and anything above the maximum code point all become
 * U+FFFD. That is the spec's answer AND the conservative one: `\110000rl` is
 * "\uFFFDrl", which is not `url`, so a hostile escape cannot synthesize a
 * function name. It also cannot throw \u2014 `String.fromCodePoint` raises
 * RangeError above 0x10FFFF, and an audit that throws is an audit that did not
 * run.
 *
 * U+FFFD is written as an ESCAPE below, never as a literal: it is invisible in
 * an editor, and a security check is a bad place for an invisible character to
 * hide.
 */
function cssEscapedCodePoint(value: number): string {
  if (!Number.isFinite(value) || value === 0 || value > 0x10FFFF) return '\uFFFD'
  if (value >= 0xD800 && value <= 0xDFFF) return '\uFFFD'
  return String.fromCodePoint(value)
}

/** Read one CSS identifier, resolving hex and identity escapes. */
function readCssIdent(css: string, at: number): { name: string; next: number } {
  let name = ''
  let i = at
  while (i < css.length) {
    const ch = css[i]
    if (ch === '\\') {
      const hex = /^\\([0-9a-fA-F]{1,6})(\r\n|[ \t\r\n\f])?/.exec(css.slice(i))
      if (hex) {
        name += cssEscapedCodePoint(parseInt(hex[1], 16))
        i += hex[0].length
        continue
      }
      if (i + 1 < css.length) { name += css[i + 1]; i += 2; continue }
      break
    }
    if (!/[-_a-zA-Z0-9\u0080-\uFFFF]/.test(ch)) break
    name += ch
    i++
  }
  return { name, next: i }
}

/**
 * Functions whose arguments include bare STRINGS that are image candidates.
 *
 * `image-set("http://\u2026" 1x)` fetches, and there is no `url()` anywhere in it.
 * Measured: the browser rig's request log showed exactly this reaching the
 * network from an SvgElement.css field and from an author style block.
 *
 * Deliberately only these two. `cross-fade()`, `image()` and the rest may or
 * may not accept a bare string; no measurement here says they do, and guessing
 * would refuse decks over a policy nobody verified.
 */
const STRING_CANDIDATE_FNS = new Set(['image-set', '-webkit-image-set'])

function scanCss(css: string): CssScan {
  const urls: string[] = []
  const atKeywords: string[] = []
  // A stack of "is this paren an image-candidate function". A bare string is a
  // URL only when it is a DIRECT argument of one — the innermost open paren.
  // `image-set("a.png" type("image/png"))` has a string inside type(), and that
  // one is a MIME name, not a candidate; treating it as a URL would refuse a
  // perfectly ordinary declaration.
  const parenStack: boolean[] = []
  const inCandidate = () => parenStack.length > 0 && parenStack[parenStack.length - 1]
  let i = 0
  while (i < css.length) {
    const ch = css[i]
    // comments carry no tokens: a url() inside one is not a fetch, and
    // reporting it as one would refuse decks over their own documentation
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end < 0 ? css.length : end + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      const start = i + 1
      i++
      let text = ''
      while (i < css.length && css[i] !== ch) {
        if (css[i] === '\\') { text += css[i + 1] ?? ''; i += 2; continue }
        text += css[i]
        i++
      }
      i++
      // A DIRECT argument of image-set() is an image candidate — a fetch with
      // no url() anywhere in it. Anywhere else it is content: a font family, a
      // ::after, a MIME name inside type(), and reporting those would refuse
      // decks over their own text.
      if (inCandidate() && start <= css.length) urls.push(text.trim())
      continue
    }
    if (ch === '(') { parenStack.push(false); i++; continue }
    if (ch === ')') { parenStack.pop(); i++; continue }
    if (ch === '@') {
      const { name, next } = readCssIdent(css, i + 1)
      if (name) atKeywords.push(name.toLowerCase())
      i = next > i ? next : i + 1
      continue
    }
    if (/[-_a-zA-Z\\\u0080-\uFFFF]/.test(ch)) {
      const { name, next } = readCssIdent(css, i)
      if (name && css[next] === '(') {
        if (name.toLowerCase() === 'url') {
          // the url token: quoted, or raw up to the closing paren
          let j = next + 1
          while (j < css.length && /[ \t\r\n\f]/.test(css[j])) j++
          let target = ''
          if (css[j] === '"' || css[j] === "'") {
            const quote = css[j]
            j++
            while (j < css.length && css[j] !== quote) { target += css[j]; j++ }
            j++
          } else {
            while (j < css.length && css[j] !== ')') { target += css[j]; j++ }
          }
          urls.push(target.trim())
          const close = css.indexOf(')', j - 1)
          i = close < 0 ? css.length : close + 1
          continue
        }
        // Any other function — image-set(), var(), calc(): step INSIDE it, so a
        // url() nested in there is found by the ordinary walk. Image-candidate
        // functions additionally make bare strings count while we are in them.
        parenStack.push(STRING_CANDIDATE_FNS.has(name.toLowerCase()))
        i = next + 1
        continue
      }
      i = next > i ? next : i + 1
      continue
    }
    i++
  }
  return { urls, atKeywords }
}

/** Every `url()` target in a stylesheet, however it is spelled. */
export function cssUrlTargets(css: string): string[] {
  return scanCss(css).urls
}

/** Every at-rule keyword, with escapes resolved. `@\69mport` is `import`. */
export function cssAtKeywords(css: string): string[] {
  return scanCss(css).atKeywords
}

// --- data URIs and signatures ----------------------------------------------
//
// A MIME type in a data URI is a claim the document makes about itself, and
// the document is untrusted input. Everything below checks the BYTES, and
// treats a mismatch between the two as hostile rather than as a typo.

type RasterKind = 'jpeg' | 'png' | 'gif' | 'webp'

/** The only image types a static export will draw. */
const RASTER_MIME: Record<string, RasterKind> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

interface ParsedDataUri { mime: string; bytes: Uint8Array }

function parseDataUri(uri: string): ParsedDataUri | null {
  if (!/^data:/i.test(uri)) return null
  const comma = uri.indexOf(',')
  if (comma < 0) return null
  const params = uri.slice(5, comma).split(';')
  const mime = (params[0] ?? '').trim().toLowerCase()
  const base64 = params.some((p) => p.trim().toLowerCase() === 'base64')
  const body = uri.slice(comma + 1)
  try {
    if (!base64) return { mime, bytes: utf8.encode(decodeURIComponent(body)) }
    const bin = atob(body)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { mime, bytes }
  } catch {
    return null
  }
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0))
const startsWith = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v)

/** APNG: an `acTL` chunk BEFORE the first `IDAT` makes a still PNG a movie. */
function pngIsAnimated(b: Uint8Array): boolean {
  let at = 8
  // A malformed length walks us off the end; that is a decode problem, not a
  // policy one, so the walk simply stops and the file is called "not animated".
  while (at + 8 <= b.length) {
    const len = (b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8 | b[at + 3]) >>> 0
    const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7])
    if (type === 'acTL') return true
    if (type === 'IDAT') return false
    if (len > b.length) return false
    at += 12 + len
  }
  return false
}

/** GIF: more than one image descriptor, or a NETSCAPE/ANIMEXTS loop block. */
function gifIsAnimated(b: Uint8Array): boolean {
  let at = 6
  if (at + 7 > b.length) return false
  const packed = b[at + 4]
  at += 7
  if (packed & 0x80) at += 3 * (1 << ((packed & 7) + 1))
  let frames = 0
  while (at < b.length) {
    const marker = b[at]
    if (marker === 0x3B) return false                  // trailer
    if (marker === 0x21) {                             // extension
      const label = b[at + 1]
      at += 2
      if (label === 0xFF && at + 11 <= b.length) {
        // Application extension: only NETSCAPE2.0 and ANIMEXTS1.0 loop
        // extensions signal animation. Other application extensions (e.g.
        // XMP metadata, ICC profiles) are benign metadata.
        const blockSize = b[at]
        if (blockSize === 11) {
          const id = String.fromCharCode(
            b[at + 1], b[at + 2], b[at + 3], b[at + 4],
            b[at + 5], b[at + 6], b[at + 7], b[at + 8],
            b[at + 9], b[at + 10], b[at + 11],
          )
          if (id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') return true
        }
      }
      while (at < b.length && b[at] !== 0) at += b[at] + 1
      at += 1
      continue
    }
    if (marker === 0x2C) {                             // image descriptor
      frames++
      if (frames > 1) return true
      const local = b[at + 9]
      at += 10
      if (local & 0x80) at += 3 * (1 << ((local & 7) + 1))
      at += 1                                          // LZW minimum code size
      while (at < b.length && b[at] !== 0) at += b[at] + 1
      at += 1
      continue
    }
    return false                                       // malformed: stop
  }
  return false
}

/** WebP: an ANIM/ANMF chunk, or the VP8X animation flag. */
function webpIsAnimated(b: Uint8Array): boolean {
  let at = 12
  while (at + 8 <= b.length) {
    const type = String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
    const size = (b[at + 4] | b[at + 5] << 8 | b[at + 6] << 16 | b[at + 7] << 24) >>> 0
    if (type === 'ANIM' || type === 'ANMF') return true
    if (type === 'VP8X' && at + 9 <= b.length && (b[at + 8] & 0x02) !== 0) return true
    at += 8 + size + (size & 1)
  }
  return false
}

/**
 * The dimensions an image DECLARES, read from its header.
 *
 * This is the difference between refusing a 33-byte file and asking the browser
 * for a 14 GB decode: a PNG header can claim 60000x60000 in the same number of
 * bytes it takes to claim 8x8, and nothing about the file's SIZE reveals which.
 * So the numbers are read here, before any image element exists to be handed
 * one, and the walk stays inside the fixed-position header fields of each
 * format rather than parsing the whole container.
 *
 * `null` means "no opinion" — an unrecognised or truncated header. The caller
 * still has the signature check and the decode step behind this.
 */
export function imageIntrinsicSize(b: Uint8Array): { width: number; height: number } | null {
  const be32 = (at: number) =>
    ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
  const le16 = (at: number) => b[at] | (b[at + 1] << 8)

  // PNG: IHDR is always the first chunk, at a fixed offset
  if (startsWith(b, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) && b.length >= 24 &&
    startsWith(b, ascii('IHDR'), 12)) {
    return { width: be32(16), height: be32(20) }
  }
  // GIF: the logical screen descriptor, little-endian, right after the magic
  if ((startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) && b.length >= 10) {
    return { width: le16(6), height: le16(8) }
  }
  // JPEG: walk the marker segments to the first frame header
  if (startsWith(b, [0xFF, 0xD8, 0xFF])) {
    let at = 2
    while (at + 1 < b.length) {
      if (b[at] !== 0xFF) { at++; continue }
      // FILL BYTES. A marker may be preceded by any number of 0xFF octets —
      // that is legal JPEG, and reading the marker at a fixed at+1 reads 0xFF
      // as if it were the marker, then takes a length from the wrong offset and
      // walks off into the entropy-coded data.
      let markerAt = at + 1
      while (markerAt < b.length && b[markerAt] === 0xFF) markerAt++
      if (markerAt >= b.length) break
      const marker = b[markerAt]
      // standalone markers: no length field follows
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
        at = markerAt + 1
        continue
      }
      if (markerAt + 2 >= b.length) break
      const len = (b[markerAt + 1] << 8) | b[markerAt + 2]
      // SOF0..SOF15, minus the ones that are not frame headers
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        if (markerAt + 7 >= b.length) return null
        return {
          height: (b[markerAt + 4] << 8) | b[markerAt + 5],
          width: (b[markerAt + 6] << 8) | b[markerAt + 7],
        }
      }
      if (len < 2) break
      at = markerAt + 1 + len
    }
    return null
  }
  // WebP: VP8X carries the canvas size; VP8 and VP8L carry their own
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8) && b.length >= 20) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (chunk === 'VP8X' && b.length >= 30) {
      const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1
      const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1
      return { width: w, height: h }
    }
    if (chunk === 'VP8L' && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      return { width: (bits & 0x3FFF) + 1, height: ((bits >>> 14) & 0x3FFF) + 1 }
    }
    if (chunk === 'VP8 ' && b.length >= 30) {
      return { width: le16(26) & 0x3FFF, height: le16(28) & 0x3FFF }
    }
    return null
  }
  return null
}

function sniffRaster(b: Uint8Array): { kind: RasterKind; animated: boolean } | null {
  if (startsWith(b, [0xFF, 0xD8, 0xFF])) return { kind: 'jpeg', animated: false }
  if (startsWith(b, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) {
    return { kind: 'png', animated: pngIsAnimated(b) }
  }
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) {
    return { kind: 'gif', animated: gifIsAnimated(b) }
  }
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) {
    return { kind: 'webp', animated: webpIsAnimated(b) }
  }
  return null
}

/** woff2 / woff / OpenType / TrueType / TrueType collection. */
function isFontBytes(b: Uint8Array): boolean {
  return startsWith(b, ascii('wOF2')) || startsWith(b, ascii('wOFF')) ||
    startsWith(b, ascii('OTTO')) || startsWith(b, ascii('true')) ||
    startsWith(b, ascii('ttcf')) || startsWith(b, [0x00, 0x01, 0x00, 0x00])
}

const clip = (v: string) => (v.length > 60 ? `${v.slice(0, 57)}…` : v)

function resourceError(message: string, slideNumber?: number): never {
  throw new SlideImageExportError('resource', message, slideNumber)
}

/**
 * The image whitelist, applied to one reference.
 *
 * Note what this does NOT do: it does not check that the bytes decode. A
 * truncated PNG passes here and fails later as a typed `decode` error, and that
 * split is deliberate — this is a POLICY gate (is this a format we will draw,
 * and is it a still?), and conflating it with an integrity check would make a
 * corrupt file look like a forbidden one.
 */
function assertStaticImageUri(
  uri: string, what: string, slideNumber: number, budgets: ExportBudgets = EXPORT_BUDGETS,
): { pixels: number } {
  // URI LENGTH FIRST, before atob or decodeURIComponent. Decoding is the
  // allocation this guard exists to prevent, so it cannot be what discovers
  // the problem — and characters is the only unit available this early.
  if (uri.length > budgets.maxResourceUriChars) {
    throw new SlideImageExportError('size',
      `${what} on slide ${slideNumber} is larger than this app will export.`, slideNumber)
  }
  const parsed = parseDataUri(uri)
  if (!parsed) {
    resourceError(
      `${what} on slide ${slideNumber} is not embedded in this deck (${clip(uri) || 'it is empty'}). ` +
      'Exported images must be self-contained, so embed it and try again.', slideNumber)
  }
  if (parsed.mime === 'image/svg+xml') {
    resourceError(
      `${what} on slide ${slideNumber} is an SVG carried as an image. ` +
      'An SVG can reference further resources, so add it as a drawing instead.', slideNumber)
  }
  const declared = RASTER_MIME[parsed.mime]
  if (!declared) {
    resourceError(`${what} on slide ${slideNumber} is a ${parsed.mime || 'nameless'} image, ` +
      'which cannot be exported. Use PNG, JPEG, GIF or WebP.', slideNumber)
  }
  // A separate question in a separate unit: real bytes, now that they exist.
  if (parsed.bytes.length > budgets.maxDecodedResourceBytes) {
    throw new SlideImageExportError('size',
      `${what} on slide ${slideNumber} is larger than this app will export.`, slideNumber)
  }

  // What the header CLAIMS, checked before the DOM is asked to make it real.
  // BOTH bounds: pixels catches 60000x60000, the per-side bound catches
  // 1 x 16,000,000, and neither catches the other.
  // The size has to be PROVEN, never assumed. An unreadable header used to
  // fall through as "no opinion" and be charged ZERO pixels — so a payload
  // whose dimensions could not be established was the cheapest thing on the
  // slide, and the per-slide pixel budget could not see it at all. If the
  // dimensions cannot be read, the payload is refused.
  const intrinsic = imageIntrinsicSize(parsed.bytes)
  if (!intrinsic) {
    resourceError(`${what} on slide ${slideNumber} does not declare a readable size, ` +
      'so it cannot be exported.', slideNumber)
  }
  const { width, height } = intrinsic
  const positive = Number.isFinite(width) && Number.isFinite(height) &&
    Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
  if (!positive) {
    throw new SlideImageExportError('resource',
      `${what} on slide ${slideNumber} declares a size of ${width}×${height}, which is not an image.`,
      slideNumber)
  }
  if (width > budgets.maxImageDimension || height > budgets.maxImageDimension ||
    width * height > budgets.maxImagePixels) {
    throw new SlideImageExportError('size',
      `${what} on slide ${slideNumber} declares ${width}×${height} pixels, which is more than ` +
      'this app will export.', slideNumber)
  }
  const pixels = width * height

  const sniffed = sniffRaster(parsed.bytes)
  if (!sniffed) {
    resourceError(`${what} on slide ${slideNumber} does not contain ${parsed.mime} data.`, slideNumber)
  }
  if (sniffed.kind !== declared) {
    resourceError(`${what} on slide ${slideNumber} says it is ${parsed.mime} but carries ` +
      `${sniffed.kind} data.`, slideNumber)
  }
  if (sniffed.animated) {
    resourceError(`${what} on slide ${slideNumber} is animated, and an exported image is a still.`,
      slideNumber)
  }
  // Handed BACK rather than re-derived. The caller needs the intrinsic size to
  // attribute pixels per slide, and parsing the same payload twice to learn
  // something this function already knew is the decode the budgets exist to
  // avoid.
  return { pixels }
}

/**
 * CSS `url()` may also legitimately carry an embedded FONT.
 *
 * Length before parse here too, and the decoded-byte cap applies to a font
 * exactly as it does to an image — the earlier shape checked neither for this
 * path, so a font reached through CSS was the one payload with no bound on it.
 */
function assertEmbeddedCssUrl(
  uri: string, what: string, slideNumber: number, budgets: ExportBudgets = EXPORT_BUDGETS,
): void {
  if (uri.length > budgets.maxResourceUriChars) {
    throw new SlideImageExportError('size',
      `${what} on slide ${slideNumber} is larger than this app will export.`, slideNumber)
  }
  const parsed = parseDataUri(uri)
  if (parsed && (parsed.mime.startsWith('font/') || parsed.mime.startsWith('application/'))) {
    if (parsed.bytes.length > budgets.maxDecodedResourceBytes) {
      throw new SlideImageExportError('size',
        `${what} on slide ${slideNumber} is larger than this app will export.`, slideNumber)
    }
    if (!isFontBytes(parsed.bytes)) {
      resourceError(`${what} on slide ${slideNumber} claims to be a font and is not.`, slideNumber)
    }
    return
  }
  // The injected budgets, not the defaults: a test driving this with a tiny
  // cap was silently getting the shipped one.
  assertStaticImageUri(uri, what, slideNumber, budgets)
}

// --- preflight --------------------------------------------------------------

/**
 * Every eager resource assignment this slide would make, checked against the
 * model BEFORE any DOM exists.
 *
 * This runs first because some assignments FETCH the moment they happen — a
 * detached `<video>` whose `src` is set reaches the network before anything can
 * replace it. Auditing the rendered DOM (below) is the second, wider net; it
 * cannot help with a request that the act of rendering already made.
 */
export function assertEmbeddedSlideResources(
  doc: BentoDoc, slide: Slide, slideNumber: number, budgets: ExportBudgets = EXPORT_BUDGETS,
): void {
  preflightExportResources(doc, [{ slide, slideNumber }], budgets, { includeFonts: false })
}

/** One use of one embedded payload, discovered without decoding anything. */
interface ExportResourceUse {
  uri: string
  what: string
  /** absent for document-level resources (fonts) */
  slideNumber?: number
  /** only image-shaped uses are weighed for intrinsic pixels */
  isImage: boolean
  /** fonts only: the family this payload is registered under */
  fontFamily?: string
}

/**
 * ONE walk over everything the selected slides will carry, decoding NOTHING.
 *
 * The single source for both halves of the resource contract. The previous
 * shape had two walks — one to weigh payloads and one to police them — and two
 * walks over the same model is a policy waiting to drift: anything the second
 * one knew about, the first one silently did not charge for.
 *
 * Only references the sanitizer and renderer will actually RETAIN are listed,
 * so a deck is never refused for something that was going to be dropped anyway.
 */
function collectResourceUses(
  doc: BentoDoc,
  slides: ReadonlyArray<{ slide: Slide; slideNumber: number }>,
  budgets: ExportBudgets,
  opts: { includeFonts: boolean },
): ExportResourceUse[] {
  const uses: ExportResourceUse[] = []
  const resolve = (ref: string): string =>
    ref.startsWith('asset:') ? (doc.assets?.[ref.slice(6)] ?? '') : ref

  if (opts.includeFonts) {
    for (const font of doc.fonts ?? []) {
      uses.push({
        uri: doc.assets?.[font.asset] ?? '',
        what: `The font "${font.family}"`,
        isImage: false,
        fontFamily: font.family,
      })
    }
  }

  for (const { slide, slideNumber } of slides) {
    // The slide's own background is a CSS value the renderer assigns straight
    // to style.background — a real sink, and one no element walk would find.
    for (const target of cssUrlTargets(slide.background ?? '')) {
      if (isDataUri(target)) uses.push({ uri: target, what: 'A slide background image', slideNumber, isImage: true })
    }

    // PASS ONE — pure lengths, no parsing, CUMULATIVE across the slide.
    //
    // A per-element check lets a slide carry fifty drawings that are each just
    // under the cap, and it interleaves with parsing: element one reaches
    // DOMParser before element two's length is ever looked at. Totalling every
    // string on the slide first means a pathological slide never reaches a
    // parser at all.
    {
      let markupChars = 0
      let cssChars = 0
      for (const el of slide.elements ?? []) {
        if (el.type !== 'svg') continue
        const svg = el as SvgElement
        if (svg.asset) {
          if (typeof doc.assets?.[svg.asset] !== 'string') {
            resourceError(`The drawing element's asset "${clip(svg.asset)}" is missing.`, slideNumber)
          }
          markupChars += doc.assets![svg.asset].length
        } else {
          markupChars += (svg.markup ?? '').length
        }
        cssChars += (svg.css ?? '').length
      }
      assertAuthorInputLength('markup', markupChars, slideNumber, budgets)
      assertAuthorInputLength('css', cssChars, slideNumber, budgets)
    }

    // PASS TWO — every length fits, so now look at the content.
    for (const el of slide.elements ?? []) {
      if (el.type === 'image') {
        uses.push({ uri: resolve(el.src), what: 'An image', slideNumber, isImage: true })
        continue
      }
      if (el.type === 'media') {
        // `src` is deliberately absent: the static export renders a poster or a
        // chip and never touches it. The inert clone is what guarantees that.
        const media = el as MediaElement
        if (media.kind === 'video' && media.poster) {
          uses.push({ uri: resolve(media.poster), what: 'A video poster', slideNumber, isImage: true })
        }
        continue
      }
      if (el.type === 'shape') {
        // shapeSvg copies `fill` into a paint attribute unfiltered, and a line
        // takes its stroke from the same field.
        for (const value of [(el as { fill?: string }).fill, (el as { stroke?: string }).stroke]) {
          for (const target of cssUrlTargets(value ?? '')) {
            if (isDataUri(target)) uses.push({ uri: target, what: 'A shape paint image', slideNumber, isImage: true })
          }
        }
        continue
      }
      if (el.type !== 'svg') continue
      const svg = el as SvgElement
      const markup = svg.asset ? (doc.assets![svg.asset]) : (svg.markup ?? '')
      for (const target of cssUrlTargets(svg.css ?? '')) {
        if (isDataUri(target)) uses.push({ uri: target, what: 'An image in a drawing stylesheet', slideNumber, isImage: true })
      }
      if (!markup) continue
      // Inert parse, never sanitizeSvg: that one ADOPTS into the live document
      // and an <image href="http…"> fetches the instant it is adopted.
      const inert = new DOMParser().parseFromString(markup, 'text/html')
      for (const node of Array.from(inert.querySelectorAll('image, feimage'))) {
        const tag = node.localName.toLowerCase()
        // BOTH attributes, INDEPENDENTLY.
        //
        // Reading href with a ?? fallback to xlink:href examines only one of
        // them: a present-but-empty href is the string "", not null, so the ??
        // never falls through — while the RENDERER falls back to xlink:href
        // for exactly that reason, because an empty href is invalid. The
        // attribute nobody looked at was the one that loaded.
        //
        // Measured, not theorised: with the ?? version, a fixture carrying
        // href="" beside a remote xlink:href appeared in the CDP request log.
        // The audit did refuse the slide afterwards — but sanitizeSvg's
        // importNode had already adopted the node and the fetch was away, so
        // catching it downstream was catching it too late.
        for (const attribute of ['href', 'xlink:href']) {
          const raw = node.getAttribute(attribute)
          if (raw === null) continue
          const href = raw.trim()
          if (!href || href.startsWith('#')) continue
          if (!svgHrefAllowed(href, tag)) continue // the renderer drops it anyway
          uses.push({ uri: href, what: 'An image inside a drawing', slideNumber, isImage: true })
        }
      }
      for (const style of Array.from(inert.querySelectorAll('style'))) {
        const text = style.textContent ?? ''
        for (const target of cssUrlTargets(text)) {
          if (isDataUri(target)) uses.push({ uri: target, what: 'An image in a drawing stylesheet', slideNumber, isImage: true })
        }
      }
      // Every OTHER surface in the drawing that can name a picture: an inline
      // style attribute, and the SVG paint, filter, mask, clip-path and marker
      // attributes — each of which takes a url(). These are real decodes on a
      // real slide, so they belong in the inventory and under the same budgets
      // as everything else; collecting only <image> and the model's css field
      // left five distinct pictures on one slide entirely unweighed.
      for (const node of Array.from(inert.querySelectorAll('*'))) {
        for (const attribute of Array.from(node.attributes)) {
          const name = attribute.name.toLowerCase()
          if (name !== 'style' && !PAINT_ATTRS.has(name)) continue
          for (const target of cssUrlTargets(attribute.value)) {
            if (!isDataUri(target)) continue
            uses.push({
              uri: target,
              what: name === 'style' ? 'An image in a drawing style' : 'A paint image in a drawing',
              slideNumber,
              isImage: true,
            })
          }
        }
      }
    }
  }
  return uses
}

/** A `data:` scheme, whatever case it is written in. */
const isDataUri = (value: string): boolean => /^data:/i.test(value.trim())

/**
 * What a data URI CLAIMS to be, from its header alone.
 *
 * Header only — the part before the comma — so this costs a substring and
 * nothing else. It is a ROUTING decision, not a validation: it decides which
 * question to ask of a payload, and the real check (signature, dimensions,
 * animation) still happens in the validator. Getting the role wrong would
 * matter, though: a generated `@font-face` URL classified as an image would be
 * refused for not being a picture, and an image classified as a font would
 * skip every image bound there is.
 *
 * `null` means "not a role this export knows", and the callers fail closed on
 * it rather than guessing.
 */
function dataUriRole(uri: string): 'image' | 'font' | null {
  const trimmed = uri.trim()
  const comma = trimmed.indexOf(',')
  if (comma < 0) return null
  const mime = trimmed.slice(5, comma).split(';')[0].trim().toLowerCase()
  if (RASTER_MIME[mime]) return 'image'
  // Same split assertEmbeddedCssUrl uses: font/* plus the application/* family
  // browsers have historically served faces under.
  if (mime.startsWith('font/') || mime.startsWith('application/')) return 'font'
  return null
}

/**
 * The cache key for "this payload, in this role".
 *
 * ONE helper used by both the store and the lookup, on purpose. Building the
 * key twice is how the two sides drift: they did, by an invisible separator
 * character, and every lookup silently returned nothing — so every image
 * contributed zero pixels and the per-slide budget could never fire. A guard
 * that always passes looks exactly like a guard that works.
 *
 * Role AND uri, because the same bytes may legitimately be an image on one
 * slide and a font in a stylesheet, and those are different questions.
 */
function resourceValidationKey(role: 'image' | 'font', uri: string): string {
  // TRIMMED, so the same payload written with stray whitespace in one place and
  // without it in another is one entry rather than two — a mismatch here would
  // make the TOCTOU re-check reject an unchanged slide.
  return `${role} ${uri.trim()}`
}

/**
 * The whole resource contract, in the one order that keeps its promises.
 *
 * Nothing here decodes until every LENGTH has been checked, because decoding is
 * the allocation the lengths exist to refuse. Then each distinct payload is
 * validated exactly once — the same picture on twelve slides is one decode —
 * and only then are intrinsic pixels attributed back to the slides that use
 * them.
 */
function preflightExportResources(
  doc: BentoDoc,
  slides: ReadonlyArray<{ slide: Slide; slideNumber: number }>,
  budgets: ExportBudgets,
  opts: { includeFonts: boolean },
): { uses: ExportResourceUse[]; validated: ReadonlyMap<string, { pixels: number }> } {
  // 1. discover, decoding nothing
  const uses = collectResourceUses(doc, slides, budgets, opts)

  // 2. LENGTHS, per resource and in aggregate, before a single atob
  assertResourceBudgets(uses.map((use) => use.uri), budgets)

  // 3. Validate each distinct ROLE+URI exactly once.
  //
  // Role AND uri, not uri alone: the same bytes can legitimately appear as an
  // image on one slide and as a font in a stylesheet, and those are different
  // questions with different answers. Keying on the payload alone would let
  // whichever role was seen first vouch for the other.
  //
  // The validators hand back what they learned, so a payload is parsed once
  // here and never re-parsed to re-derive something already known.
  const validated = new Map<string, { pixels: number }>()
  for (const use of uses) {
    const key = resourceValidationKey(use.isImage ? 'image' : 'font', use.uri)
    if (validated.has(key)) continue
    if (!use.isImage) {
      validateFontUse(use, budgets)
      validated.set(key, { pixels: 0 })
      continue
    }
    validated.set(key, assertStaticImageUri(use.uri, use.what, use.slideNumber ?? 0, budgets))
  }

  // 4. attribute those pixels back per slide, deduplicated
  assertSlideImagePixelBudget(
    uses
      .filter((use) => use.isImage && use.slideNumber !== undefined)
      .map((use) => {
        const record = validated.get(resourceValidationKey('image', use.uri))
        // NO `?? 0`: every image reaching here was validated a step earlier, so
        // a missing record is a broken invariant and must not be charged as a
        // free image.
        if (!record) {
          throw new SlideImageExportError('resource',
            `${use.what} was never validated, so its size is unknown.`, use.slideNumber)
        }
        return { slideNumber: use.slideNumber as number, uri: use.uri, pixels: record.pixels }
      }),
    budgets)

  return { uses, validated }
}

/**
 * What preflight approved, in the form the render path can re-check cheaply.
 *
 * A normalized role+URI allow set. Preflight validates a SNAPSHOT; rendering
 * happens later, one slide at a time, and anything that can edit the document
 * in between — a collab op, a stray handler, a progress callback — means what
 * was approved is not necessarily what is about to be drawn.
 */
interface ValidatedInventory {
  /** normalized role+URI keys that preflight approved */
  keys: ReadonlySet<string>
  /**
   * The intrinsic pixels each approved image turned out to have.
   *
   * Carried, not recomputed. Membership alone is not enough for the re-check
   * below: every image on a two-slide deck can be individually approved and
   * then all be MOVED ONTO ONE SLIDE, where together they exceed the per-slide
   * pool that was never re-evaluated. The pixels have to travel with the keys
   * so the aggregate can be recomputed against what is actually there now.
   */
  pixels: ReadonlyMap<string, number>
}

function inventoryOf(
  uses: readonly ExportResourceUse[],
  validated: ReadonlyMap<string, { pixels: number }>,
): ValidatedInventory {
  const keys = new Set<string>()
  const pixels = new Map<string, number>()
  for (const use of uses) {
    const key = resourceValidationKey(use.isImage ? 'image' : 'font', use.uri)
    keys.add(key)
    if (!use.isImage) continue
    const record = validated.get(key)
    // NO `?? 0`. A missing record means an image reached the inventory without
    // being validated, and charging it zero pixels would make the one payload
    // nobody checked also the one the per-slide pool cannot see.
    if (!record) {
      throw new SlideImageExportError('resource',
        `${use.what} was never validated, so its size is unknown and it cannot be exported.`,
        use.slideNumber)
    }
    pixels.set(key, record.pixels)
  }
  return { keys, pixels }
}

/**
 * Re-collect ONE slide immediately before it renders, and require every use to
 * be something preflight already approved.
 *
 * Fails CLOSED: an unknown reference is refused, never re-validated here. The
 * point is to notice that the document moved, and re-validating would quietly
 * bless the new value instead — which is exactly the hole. Measured: a fixture
 * whose progress callback swapped slide 2's image for an https one reached the
 * network, because the only thing checking was the audit that runs after the
 * render that had already fetched it.
 */
function assertSlideUnchangedSincePreflight(
  doc: BentoDoc,
  slide: Slide,
  slideNumber: number,
  inventory: ValidatedInventory,
  budgets: ExportBudgets,
): void {
  const now = collectResourceUses(doc, [{ slide, slideNumber }], budgets, { includeFonts: false })
  for (const use of now) {
    const key = resourceValidationKey(use.isImage ? 'image' : 'font', use.uri)
    if (inventory.keys.has(key)) continue
    throw new SlideImageExportError('resource',
      `Slide ${slideNumber} changed while it was being exported and now refers to something ` +
      'that was not checked. Nothing was exported — try again.', slideNumber)
  }
  // RECOMPUTE the per-slide pool against what this slide holds NOW. Every one
  // of these payloads was approved — but approval was per payload, and moving
  // already-approved images onto one slide is a redistribution the original
  // aggregate never saw.
  assertSlideImagePixelBudget(
    now
      .filter((use) => use.isImage)
      .map((use) => {
        const known = inventory.pixels.get(resourceValidationKey('image', use.uri))
        // NO `?? 0`. Membership was checked a few lines above, so a missing
        // pixel record here is an invariant break, not a zero-cost image.
        if (known === undefined) {
          throw new SlideImageExportError('resource',
            `Slide ${slideNumber} refers to an image whose size was never established. ` +
            'Nothing was exported — try again.', slideNumber)
        }
        return { slideNumber, uri: use.uri, pixels: known }
      }),
    budgets)
}

/**
 * Prove every distinct payload can actually be TURNED INTO PIXELS.
 *
 * Everything above this is policy: the right magic, the right MIME, a sane
 * declared size, not animated. All of that is satisfied by a PNG whose header
 * is perfect and whose image data is missing, and by a woff2 that starts with
 * "wOF2" and continues with noise. Neither can render, and neither says so:
 * the image comes out as a hole in the slide and the font comes out as a
 * substituted face. The user cannot see what they did not get, so the export
 * has to be the one that notices.
 *
 * Once per DISTINCT payload per export, which is why `verified` is threaded in
 * rather than rebuilt — a sixty-slide deck sharing one logo decodes it once.
 */
async function verifyResourcesDecodable(
  uses: readonly ExportResourceUse[],
  verified: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  for (const use of uses) {
    // Around EVERY await, not just at the top: a deck with forty distinct
    // pictures decodes forty times, and a user who has already pressed Cancel
    // should not wait for the other thirty-nine.
    throwIfAborted(signal)
    const key = resourceValidationKey(use.isImage ? 'image' : 'font', use.uri)
    if (verified.has(key)) continue
    verified.add(key)
    const fail = (why: unknown): never => {
      throw new SlideImageExportError('decode',
        `${use.what}${use.slideNumber === undefined ? '' : ` on slide ${use.slideNumber}`} ` +
        `could not be decoded (${String(why)}). It may be damaged — replace it and export again.`,
        use.slideNumber)
    }
    const parsed = parseDataUri(use.uri)
    if (!parsed) continue // policy already refused anything that is not embedded

    if (use.isImage) {
      // createImageBitmap is the cheapest honest answer: it decodes, and it
      // rejects when it cannot. An <img> that merely fails to load would leave
      // the same silent hole this exists to prevent.
      // Wrapped with abortable() so cancellation during decode is prompt.
      try {
        const bitmapPromise = createImageBitmap(new Blob([parsed.bytes as unknown as BlobPart],
          { type: parsed.mime }))
        const bitmap = await abortable(bitmapPromise, signal, () => {
          // Best-effort: close the bitmap if the decode finishes after the abort,
          // so the decoded pixel data is released rather than leaked.
          bitmapPromise.then((b) => b.close()).catch(() => {})
        })
        bitmap.close()
      } catch (err) {
        // A cancellation keeps its own code — relabelling it 'decode' would
        // tell the user their image is damaged when they just pressed Cancel.
        if (err instanceof SlideImageExportError) throw err
        fail(err)
      }
      continue
    }

    // A font is only real once a font parser has accepted it. FontFace.load()
    // is that parser, and it rejects on a malformed face.
    // Wrapped with abortable() so cancellation during font parsing is prompt.
    try {
      const face = new FontFace(use.fontFamily ?? 'bento-export-probe', `url(${JSON.stringify(use.uri)})`)
      await abortable(face.load(), signal)
    } catch (err) {
      // A cancellation keeps its own code.
      if (err instanceof SlideImageExportError) throw err
      fail(err)
    }
  }
}

/**
 * Every declared document font, checked once per export.
 *
 * Conservatively ALL of them, not only the families an element names: a font
 * stack can reach a face through inheritance, a fallback, or a rule in an
 * author stylesheet, so "unused" is not a property this code can establish.
 */
export function assertEmbeddedFonts(doc: BentoDoc, budgets: ExportBudgets = EXPORT_BUDGETS): void {
  for (const font of doc.fonts ?? []) {
    const src = doc.assets?.[font.asset]
    if (!src) {
      resourceError(`The embedded font "${font.family}" is missing its data (${clip(font.asset)}).`)
    }
    validateFontUse({ uri: src, what: `The font "${font.family}"`, isImage: false }, budgets)
  }
}

/** One font payload: length, then decode, then signature. */
function validateFontUse(use: ExportResourceUse, budgets: ExportBudgets): void {
  if (!use.uri) resourceError(`${use.what} is missing its data.`)
  // URI characters before the decode, real bytes after it — two questions, two
  // units, both named for what they actually hold.
  if (use.uri.length > budgets.maxResourceUriChars) {
    throw new SlideImageExportError('size', `${use.what} is larger than this app will export.`)
  }
  const parsed = parseDataUri(use.uri)
  if (!parsed) {
    resourceError(`${use.what} is not embedded in this deck, so it cannot be exported.`)
  }
  if (parsed.bytes.length > budgets.maxDecodedResourceBytes) {
    throw new SlideImageExportError('size', `${use.what} is larger than this app will export.`)
  }
  if (!isFontBytes(parsed.bytes)) {
    resourceError(`${use.what} does not contain font data.`)
  }
}

// --- the rendered-DOM audit -------------------------------------------------

/** Attributes whose value a browser will FETCH. */
const FETCH_ATTRS = new Set(['src', 'poster', 'srcset', 'data'])
/** Reference attributes — a fetch on <image>, mere navigation on <a>. */
const REF_ATTRS = new Set(['href', 'xlink:href'])
/** SVG paint/filter sinks, each of which takes a url(). */
const PAINT_ATTRS = new Set([
  'fill', 'stroke', 'filter', 'mask', 'clip-path', 'clippath',
  // `marker` is the SHORTHAND — a real presentation attribute that sets all
  // three at once. Listing only the long forms left a url() sink with no check
  // on it at all.
  'marker', 'marker-start', 'marker-mid', 'marker-end',
  'background', 'background-image',
  'stroke-linecap', 'cursor',
])

/**
 * The complete detached render, audited before it is ever mounted.
 *
 * BEFORE MOUNT is the whole point. A staging surface in the document is a
 * surface that fetches, and the browser rig measured exactly that: an author
 * SVG's remote `<image>` reaches the network the moment the render is attached.
 * By then an audit is a post-mortem.
 */
/**
 * The APPLICATION's own stylesheet, checked for SELF-CONTAINMENT only.
 *
 * A different question from the one asked of document content, because it is a
 * different trust relationship. This sheet is compiled into the shell, covered
 * by the release gate, and no deck author can put anything in it. What matters
 * is only that it does not reach off the file: no `@import`, and no URL that is
 * not either a same-document fragment or already inline.
 *
 * Its bundled `data:` URLs are therefore allowed as they are — not whitelisted,
 * not budgeted against the document's images, not decoded. Applying the deck
 * rule to them refused EVERY export in the shipped build, because the runtime
 * stylesheet carries `data:image/svg+xml` decorations; and charging the app's
 * own chrome to the author's pixel budget would have been wrong even if it had
 * happened to pass.
 */
export function assertAppCssSelfContained(cssText: string, slideNumber?: number): void {
  for (const target of cssUrlTargets(cssText)) {
    if (!target || target.startsWith('#') || isDataUri(target)) continue
    throw new SlideImageExportError('resource',
      `The app stylesheet would fetch ${clip(target)} while exporting. ` +
      'An exported image has to be made from this file alone.', slideNumber)
  }
  if (cssAtKeywords(cssText).includes('import')) {
    throw new SlideImageExportError('resource',
      'The app stylesheet contains an @import, which an exported image cannot follow.',
      slideNumber)
  }
}

export function assertNoExternalRenderedResources(
  surface: HTMLElement, cssText: string, slideNumber: number,
  budgets: ExportBudgets = EXPORT_BUDGETS,
  // MEMBERSHIP ONLY here — a plain Set satisfies this, and so does the richer
  // inventory's `keys`. The audit asks one question and does not need the
  // pixel metadata the raster path re-checks with.
  inventory?: { has(key: string): boolean },
): void {
  const refuse = (what: string, value: string): never =>
    resourceError(
      `Slide ${slideNumber} would fetch ${what} while exporting (${clip(value)}). ` +
      'An exported image has to be made from this file alone, so embed it first.', slideNumber)

  /**
   * A data URI is accepted here ONLY because preflight already validated it —
   * by exact normalized role+URI membership, with no parse, no atob and no
   * decode. Re-validating would be a second policy in a second place, and it
   * would charge nothing to any budget, so an unknown payload fails CLOSED.
   *
   * The ROLE is part of the key: a payload validated as a font has not been
   * checked as an image, and vice versa.
   *
   * Without an inventory the audit falls back to validating. That path exists
   * for callers using it standalone (the srcset checks drive it directly); the
   * product path always passes one.
   */
  const checkEmbedded = (uri: string, role: 'image' | 'font' | null, what: string) => {
    if (!inventory) {
      if (role === 'image') assertStaticImageUri(uri, 'An embedded image', slideNumber, budgets)
      else assertEmbeddedCssUrl(uri, 'An embedded resource', slideNumber, budgets)
      return
    }
    if (role === null) refuse(`${what} of an unknown kind`, uri)
    if (!inventory.has(resourceValidationKey(role as 'image' | 'font', uri))) {
      refuse(`${what} that preflight never validated`, uri)
    }
  }

  const checkRef = (value: string, what: string) => {
    const v = value.trim()
    if (!v || v.startsWith('#')) return
    // A src/href/poster sink paints a PICTURE. A font there is not a role
    // mix-up to tolerate, it is a reference that would never have rendered.
    if (isDataUri(v)) {
      const role = dataUriRole(v)
      if (role !== 'image') refuse(`${what} that is not an image`, v)
      checkEmbedded(v, 'image', 'an embedded image')
      return
    }
    refuse(what, v)
  }

  const checkCss = (css: string, where: string) => {
    for (const target of cssUrlTargets(css)) {
      if (!target || target.startsWith('#')) continue
      // CSS legitimately carries both: url() in a background is an image, url()
      // in @font-face src is a face. The header says which.
      if (isDataUri(target)) { checkEmbedded(target, dataUriRole(target), 'an embedded resource'); continue }
      refuse(where, target)
    }
    if (cssAtKeywords(css).includes('import')) refuse(`${where} (@import)`, css.slice(0, 60))
  }

  const nodes: Element[] = [surface, ...Array.from(surface.querySelectorAll('*'))]
  for (const node of nodes) {
    const tag = node.tagName.toLowerCase()
    if (tag === 'style') { checkCss(node.textContent ?? '', 'a stylesheet inside the slide'); continue }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase()
      if (name === 'style') { checkCss(attr.value, 'an inline style'); continue }
      if (PAINT_ATTRS.has(name)) { checkCss(attr.value, 'a paint reference'); continue }
      if (REF_ATTRS.has(name)) {
        // A hyperlink is navigation the reader may choose later, not a fetch
        // this export performs. Allowing it is what keeps linked diagrams whole.
        if (tag === 'a') continue
        checkRef(attr.value, 'a linked resource')
        continue
      }
      if (name === 'srcset') {
        // A LIST, not a reference. `#local 1x, http://evil/b.png 2x` passes any
        // check that reads the whole value as one URL, and the browser is free
        // to pick the second candidate.
        for (const candidate of srcsetCandidates(attr.value)) {
          checkRef(candidate, 'a linked resource in a srcset')
        }
        continue
      }
      if (FETCH_ATTRS.has(name)) checkRef(attr.value, 'a linked resource')
    }
  }
  // The app's own sheet is a SELF-CONTAINMENT question, not an inventory one:
  // its bundled decorations are ours, and holding them to the deck's image
  // whitelist refused every export in the shipped build.
  assertAppCssSelfContained(cssText, slideNumber)
}

// --- export CSS -------------------------------------------------------------

/**
 * Strip every `cursor` declaration.
 *
 * NOT a split on ';': a cursor value may be `url(data:image/svg+xml;base64,…)`,
 * and that data URI carries its own semicolons. Issue #261's reporter broke XML
 * parsing on exactly this shape, so the scan respects url() and quoting.
 *
 * They go because a static image has no pointer, and because a raw `<svg>`
 * inside a `url()` is the single most awkward thing to carry across an XML
 * boundary — removing it is cheaper than escaping it.
 */
export function stripCursorDecls(css: string): string {
  /** Skip whitespace and comments — both may sit between a property and its colon. */
  const skipTrivia = (from: number): number => {
    let i = from
    for (;;) {
      while (i < css.length && /[\s]/.test(css[i])) i++
      if (css[i] === '/' && css[i + 1] === '*') {
        const end = css.indexOf('*/', i + 2)
        i = end < 0 ? css.length : end + 2
        continue
      }
      return i
    }
  }

  let out = ''
  let i = 0
  let copiedTo = 0
  while (i < css.length) {
    const ch = css[i]
    // Never look for a property inside a string or a comment: `content:"cursor:"`
    // is text, and cutting from inside it would take the rest of the rule out.
    if (ch === '"' || ch === "'") {
      i++
      while (i < css.length && css[i] !== ch) i += css[i] === '\\' ? 2 : 1
      i++
      continue
    }
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end < 0 ? css.length : end + 2
      continue
    }
    // A declaration begins after `{`, `;` or `}` (or at the very start).
    const startsDecl = i === 0 || css[i - 1] === '{' || css[i - 1] === ';' || css[i - 1] === '}'
    if (!startsDecl) { i++; continue }
    const declAt = skipTrivia(i)
    // The property name is an IDENT, so it takes escapes: `cur\73or` and
    // `\63ursor` are both `cursor` to every browser and to neither a
    // case-insensitive indexOf nor a regex over the literal word.
    const { name, next } = readCssIdent(css, declAt)
    if (!name || name.toLowerCase() !== 'cursor') { i = Math.max(declAt + 1, i + 1); continue }
    // A custom property called --cursor is a different thing entirely.
    if (css.slice(declAt, declAt + 2) === '--') { i = next; continue }
    const colon = skipTrivia(next)
    if (css[colon] !== ':') { i = next; continue }

    // Consume the value, honouring strings, comments and nesting, so a `;` or
    // `}` inside a url() or a quoted string does not end it early.
    let j = colon + 1
    let depth = 0
    for (; j < css.length; j++) {
      const c = css[j]
      if (c === '"' || c === "'") {
        j++
        while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1
        continue
      }
      if (c === '/' && css[j + 1] === '*') {
        const end = css.indexOf('*/', j + 2)
        j = end < 0 ? css.length : end + 1
        continue
      }
      if (c === '\\') { j++; continue }
      if (c === '(') { depth++; continue }
      if (c === ')') { depth--; continue }
      if (depth === 0 && (c === ';' || c === '}')) break
    }
    out += css.slice(copiedTo, declAt)
    if (css[j] === ';') j++
    copiedTo = j
    i = j
  }
  out += css.slice(copiedTo)
  return out
}

/**
 * Wrap CSS as an XML CDATA section.
 *
 * The sheet is full of `>` (child combinators) and `&`, which an XML parser
 * would otherwise read as markup. A CDATA section says "this is text" — except
 * that the sheet may itself contain the terminator, so every `]]>` is split
 * across a close/reopen pair. That is not theoretical: `content: "]]>"` is legal
 * CSS, and the browser rig paints a box with a rule that contains one.
 */
function xmlCdata(text: string): string {
  const term = ']]' + '>'
  return `/*<![CDATA[*/${text.split(term).join(`]]${term}<![CDATA[>`)}/*${term}*/`
}

/** True only for stylesheet nodes created by bento's own build/dev runtime. */
function isAppStylesheetOwner(owner: Element | null): boolean {
  if (!owner || !document.head.contains(owner) || owner.localName.toLowerCase() !== 'style') return false
  if (owner.id === 'bento-rt-style' || owner.hasAttribute('data-bento-app-style')) return true
  // Vite's dev client identifies every imported sheet this way. In a
  // single-file build Vite instead emits one <style rel="stylesheet">; the
  // post-build compressor replaces that node with #bento-rt-style above.
  if (owner.hasAttribute('data-vite-dev-id')) return true
  return (owner.getAttribute('rel') ?? '').split(/\s+/).some((token) => token.toLowerCase() === 'stylesheet')
}

/**
 * The app's own stylesheet, read from the live document.
 *
 * Provenance is part of the contract. Author SVG <style> nodes also appear in
 * document.styleSheets — including on a live hidden/state slide that "all"
 * does not select — so readability alone can never make a sheet trusted.
 *
 * An unreadable app sheet is an ERROR, never a silent skip: skipping one is how
 * an export loses its layout rules and comes out as a pile of unpositioned text
 * that nobody notices until a user files it.
 */
export function collectExportCss(): string {
  let out = ''
  for (const sheet of Array.from(document.styleSheets)) {
    const owner = sheet.ownerNode as Element | null
    // The runtime's own font sheet is REPLACED, not collected: fonts.ts writes
    // it with `font-display: swap`, and this export writes the same families
    // again with `block`. Carrying both would put two @font-face rules for one
    // family in the sheet, and the swap-flavoured one is the wrong answer.
    if (owner?.id === 'bento-fonts') continue
    if (sheet.href) {
      throw new SlideImageExportError('resource',
        `This document links an external stylesheet (${clip(sheet.href)}), which a self-contained ` +
        'deck cannot have. Export cannot guarantee it would render the same.')
    }
    if (!isAppStylesheetOwner(owner)) continue
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch (err) {
      throw new SlideImageExportError('resource',
        `A stylesheet in this page cannot be read (${String(err)}), so the export could not be ` +
        'sure it looks right.')
    }
    for (const rule of Array.from(rules)) out += `${rule.cssText}\n`
  }
  return stripCursorDecls(out)
}

/** @font-face for every declared font, BLOCKING rather than swapping. */
function fontFaceCss(doc: BentoDoc): string {
  let out = ''
  for (const font of doc.fonts ?? []) {
    const src = doc.assets?.[font.asset]
    if (!src) continue // assertEmbeddedFonts has already refused this document
    // font.weight and font.style are document-controlled. Interpolating them
    // raw would let a malicious document inject arbitrary CSS into the export
    // stylesheet. Undefined values take the CSS initial value; a present value
    // that is too long or outside the descriptor grammar fails closed.
    const weight = validFontWeight(font.weight)
    const style = validFontStyle(font.style)
    // `font-display: block`, unlike the runtime's `swap`: swap PAINTS the
    // fallback first, and in a one-shot raster the fallback is what you get.
    out += `@font-face{font-family:${JSON.stringify(font.family)};src:url(${JSON.stringify(src)});` +
      `font-weight:${weight};font-style:${style};font-display:block}\n`
  }
  return out
}

/**
 * CSS @font-face font-weight descriptor values the export accepts.
 *
 * The descriptor grammar permits `normal | bold | <number>{1,2}` where each
 * `<number>` is an integer 1–1000, and a two-value range requires ascending
 * order (e.g. '100 900', '400 700').
 *
 * `bolder` and `lighter` are NOT valid @font-face descriptors — they are only
 * valid in the `font-weight` property. Anything that does not match the grammar
 * — including strings with semicolons, braces, or CSS injection payloads — is
 * rejected. A present but invalid value throws a typed `resource` error so the
 * export fails closed rather than silently rendering with the wrong weight.
 * `undefined`/`null` defaults to `'normal'` (the CSS initial value).
 */
function validFontWeight(v: unknown): string {
  if (v === undefined || v === null) return 'normal'
  const s = String(v).trim()
  if (s.length > 64) resourceError('The font-weight descriptor is too long.')
  if (s === 'normal' || s === 'bold') return s
  // One or two space-separated integers 1–1000
  const parts = s.split(/\s+/)
  if (parts.length < 1 || parts.length > 2) {
    resourceError(`Invalid font-weight descriptor: ${clip(s)}`)
  }
  for (const p of parts) {
    if (!/^[1-9]\d{0,3}$/.test(p)) {
      resourceError(`Invalid font-weight descriptor: ${clip(s)}`)
    }
    const n = Number(p)
    if (n < 1 || n > 1000) {
      resourceError(`Invalid font-weight descriptor: ${clip(s)}`)
    }
  }
  if (parts.length === 2 && Number(parts[0]) >= Number(parts[1])) {
    resourceError(`Invalid font-weight range (must be ascending): ${clip(s)}`)
  }
  return s
}

/**
 * CSS @font-face font-style descriptor values the export accepts.
 *
 * `normal | italic | oblique` (with an optional angle we do not use).
 * A present but invalid value throws a typed `resource` error so the export
 * fails closed rather than silently rendering with the wrong style.
 */
function validFontStyle(v: unknown): string {
  if (v === undefined || v === null) return 'normal'
  const s = String(v).trim()
  if (s.length > 64) resourceError('The font-style descriptor is too long.')
  if (s === 'normal' || s === 'italic' || s === 'oblique') return s
  resourceError(`Invalid font-style descriptor: ${clip(s)}`)
}

/**
 * Export-only overrides. A still frame has no motion, no caret and no hover.
 */
const EXPORT_OVERRIDES =
  '*,*::before,*::after{animation:none !important;transition:none !important;' +
  'caret-color:transparent !important;pointer-events:none !important}\n' +
  '::selection{background:transparent}\n'

/**
 * The complete stylesheet an export renders against.
 *
 * A pure string builder. `fontFaceCss` validates document-controlled
 * font-weight and font-style descriptors before interpolating them. Resource
 * presence, signatures and decodability are validated by the following
 * preflight before any staging surface is mounted or rendered; a missing face
 * is omitted here only so that preflight can report the typed resource error.
 */
export function buildExportCss(doc: BentoDoc, _budgets: ExportBudgets = EXPORT_BUDGETS): string {
  return collectExportCss() + fontFaceCss(doc) + EXPORT_OVERRIDES
}

// --- making the render static ----------------------------------------------

/**
 * A copy of the slide whose media cannot fetch.
 *
 * Blanking happens in the MODEL, before renderSlide ever runs: assigning `src`
 * to a detached `<video>` is already a request, so there is no later point at
 * which this could be fixed.
 */
function inertSlideClone(slide: Slide): Slide {
  const copy = JSON.parse(JSON.stringify(slide)) as Slide
  for (const el of copy.elements ?? []) {
    if (el.type !== 'media') continue
    const media = el as MediaElement
    media.src = ''
    if (media.poster) media.poster = ''
  }
  return copy
}

/** Put each media element's existing poster/icon still back where its inert
 *  placeholder is — the same still thumbnails already use. */
function replaceMediaWithStills(
  surface: HTMLElement, slide: Slide, doc: BentoDoc, fields: FieldContext,
): void {
  for (const el of slide.elements ?? []) {
    if (el.type !== 'media') continue
    const stub = surface.querySelector(`[data-el-id="${CSS.escape(el.id)}"]`)
    if (!stub) continue
    stub.replaceWith(renderElement(el as SlideElement, doc, {
      svgAsImage: true, hidePlaceholders: true, fields,
    }))
  }
}

/**
 * Take every `cursor` out of the RENDERED slide, not just out of the app sheet.
 *
 * A still image has no pointer, so a cursor is never a resource this export
 * needs — and treating one as a forbidden fetch would refuse a deck over
 * something harmless. Removing it is both kinder and stricter than auditing it:
 * an author's `cursor: url(…)`, however it is spelled, simply stops existing
 * before anything can ask whether it would load.
 */
function stripCursorFromRendered(surface: HTMLElement): void {
  for (const style of Array.from(surface.querySelectorAll('style'))) {
    style.textContent = stripCursorDecls(style.textContent ?? '')
  }
  for (const node of Array.from(surface.querySelectorAll<HTMLElement>('[style]'))) {
    const own = node.getAttribute('style') ?? ''
    const lean = stripCursorDecls(own)
    if (lean !== own) node.setAttribute('style', lean)
  }
  // SVG also takes `cursor` as a presentation ATTRIBUTE.
  for (const node of Array.from(surface.querySelectorAll('[cursor]'))) node.removeAttribute('cursor')
}

/** Remove SMIL so an author SVG resolves to its DEFINED initial frame. */
function freezeAuthorSvg(surface: HTMLElement): void {
  for (const node of Array.from(
    surface.querySelectorAll('animate, animateTransform, animateMotion, set, mpath'),
  )) node.remove()
}

/** Show only the slide's DEFAULT hover-reveal set, exactly as present.ts does. */
function applyDefaultHoverState(surface: HTMLElement, slide: Slide): void {
  if (slide.hover?.type !== 'reveal') return
  const active = slide.hover.default ?? null
  for (const node of Array.from(surface.querySelectorAll<HTMLElement>('[data-show-on-hover]'))) {
    node.style.opacity = node.dataset.showOnHover === active ? '' : '0'
  }
}

/**
 * Wait for fonts and images.
 *
 * A failed decode is NOT swallowed. A corrupt embedded image would otherwise
 * export as a silent hole in the slide, and a silently wrong image is worse
 * than a refused export — the user cannot see what they did not get.
 */
async function waitForRenderedAssets(
  surface: HTMLElement, slideNumber: number, signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  await abortable(document.fonts.ready, signal)
  throwIfAborted(signal)
  await Promise.all(Array.from(surface.querySelectorAll('img')).map(async (img) => {
    try {
      await abortable(img.decode(), signal)
    } catch (err) {
      // A cancellation is not a damaged picture, and must keep its own code.
      if (err instanceof SlideImageExportError) throw err
      throw new SlideImageExportError('decode',
        `Slide ${slideNumber} contains an image that could not be decoded (${String(err)}). ` +
        'It may be damaged — replace it and export again.', slideNumber)
    }
  }))
  throwIfAborted(signal)
}

// --- serialization and raster ----------------------------------------------

function svgDocument(xhtml: string, cssText: string, w: number, h: number, scale: number): string {
  // width/height carry the SCALE; the viewBox stays in slide units, so the
  // browser re-renders the vectors at the larger size instead of magnifying a
  // bitmap. That difference is what the rig's hairline fixture measures.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" ` +
    `viewBox="0 0 ${w} ${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
    // dir="ltr" on the wrapper: the document never mirrors (PLATFORM §8), and
    // each text node keeps the dir="auto" the renderer gave it.
    `<div xmlns="http://www.w3.org/1999/xhtml" dir="ltr" style="width:${w}px;height:${h}px">` +
    '<sty' + 'le>' + xmlCdata(cssText) + '</sty' + 'le>' +
    xhtml +
    '</div></foreignObject></svg>'
}

const DATA_URI_PREFIX = 'data:image/svg+xml;charset=utf-8,'

/**
 * How long `encodeURIComponent` WOULD make this, without making it.
 *
 * Counted straight off the UTF-16 code units — no TextEncoder, so nothing is
 * allocated to answer a question about size. That is the whole point: encoding
 * a 40 MB SVG to discover it was too big builds the 100 MB answer first.
 *
 * The cost of each code point is fixed by its UTF-8 length, since every byte
 * either survives as one character or becomes "%XX":
 *
 *   ASCII unreserved (A-Z a-z 0-9 - _ . ! ~ * ' ( ))  1 byte  →  1
 *   any other ASCII                                   1 byte  →  3
 *   U+0080..U+07FF                                    2 bytes →  6
 *   the rest of the BMP                               3 bytes →  9
 *   a surrogate PAIR                                  4 bytes → 12
 *
 * A LONE surrogate is not a code point at all, and `encodeURIComponent` throws
 * URIError on one. This throws the same thing at the same point, so the caller
 * can map it to the typed encode error BEFORE the size comparison rather than
 * discovering it later from a different call.
 */
function percentEncodedLength(text: string): number {
  let total = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) {
      const unreserved =
        (unit >= 0x41 && unit <= 0x5A) || (unit >= 0x61 && unit <= 0x7A) ||
        (unit >= 0x30 && unit <= 0x39) ||
        unit === 0x2D || unit === 0x5F || unit === 0x2E || unit === 0x21 ||
        unit === 0x7E || unit === 0x2A || unit === 0x27 || unit === 0x28 || unit === 0x29
      total += unreserved ? 1 : 3
      continue
    }
    if (unit < 0x800) { total += 6; continue }
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const low = text.charCodeAt(i + 1)
      if (Number.isNaN(low) || low < 0xDC00 || low > 0xDFFF) throw new URIError('URI malformed')
      total += 12
      i++
      continue
    }
    if (unit >= 0xDC00 && unit <= 0xDFFF) throw new URIError('URI malformed')
    total += 9
  }
  return total
}

function decodeSvgImage(
  uri: string, slideNumber: number, signal?: AbortSignal,
): Promise<HTMLImageElement> {
  // BEFORE the src assignment, not just before the await: assigning src starts
  // the decode, and `abortable` only sees the promise after the executor has
  // already run.
  throwIfAborted(signal)
  const img = new Image()
  const load = new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => resolve(img)
    img.onerror = () => reject(new SlideImageExportError('decode',
      `Slide ${slideNumber} could not be turned into an image.`, slideNumber))
    img.src = uri
  })
  // On abandon: drop the handlers and the src, so a load that lands after the
  // abort cannot resolve into a dead export or keep the data URI alive.
  return abortable(load, signal, () => {
    img.onload = null
    img.onerror = null
    img.removeAttribute('src')
  })
}

function canvasToBlob(
  canvas: HTMLCanvasElement, format: SlideImageFormat, slideNumber: number, signal?: AbortSignal,
): Promise<Blob> {
  // BEFORE toBlob is called: the executor runs synchronously, so an
  // already-aborted export would otherwise start an encode it will discard.
  throwIfAborted(signal)
  const expectedMime = format === 'jpeg' ? 'image/jpeg' : 'image/png'
  const blobPromise = new Promise<Blob>((resolve, reject) => {
    const fail = (why: string) => reject(new SlideImageExportError('encode',
      `Slide ${slideNumber} could not be encoded as ${format.toUpperCase()}${why}.`, slideNumber))
    try {
      // toBlob can THROW as well as hand back null — encoding a large canvas is
      // an allocation. Both are the same story to the user, and both need the
      // slide number attached or the message is unactionable.
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : fail('')),
        expectedMime,
        JPEG_QUALITY,
      )
    } catch (err) {
      fail(` (${String(err)})`)
    }
  })
  return abortable(blobPromise, signal).then(async (blob) => {
    // Fail closed: the blob's MIME and file signature must match the requested
    // format. A canvas implementation that returns the wrong type or corrupt
    // magic bytes would silently produce an unusable export.
    if (blob.type !== expectedMime) {
      throw new SlideImageExportError('encode',
        `Slide ${slideNumber} encoded as ${blob.type} instead of ${expectedMime}.`, slideNumber)
    }
    const readSignature = async (part: Blob, which: string): Promise<Uint8Array> => {
      try {
        return new Uint8Array(await abortable(part.arrayBuffer(), signal))
      } catch (err) {
        if (err instanceof SlideImageExportError) throw err
        throw new SlideImageExportError('encode',
          `Slide ${slideNumber}'s ${which} could not be read (${String(err)}).`, slideNumber)
      }
    }
    if (format === 'png') {
      // Full 8-byte PNG signature: 89 50 4E 47 0D 0A 1A 0A
      const head = await readSignature(blob.slice(0, 8), 'PNG signature')
      if (head.length < 8 ||
          head[0] !== 0x89 || head[1] !== 0x50 || head[2] !== 0x4E || head[3] !== 0x47 ||
          head[4] !== 0x0D || head[5] !== 0x0A || head[6] !== 0x1A || head[7] !== 0x0A) {
        throw new SlideImageExportError('encode',
          `Slide ${slideNumber} does not carry the full 8-byte PNG signature.`, slideNumber)
      }
    } else {
      // JPEG: SOI marker (FF D8 FF) at head
      const head = await readSignature(blob.slice(0, 3), 'JPEG header')
      if (head.length < 3 || head[0] !== 0xFF || head[1] !== 0xD8 || head[2] !== 0xFF) {
        throw new SlideImageExportError('encode',
          `Slide ${slideNumber} does not carry the JPEG SOI marker.`, slideNumber)
      }
      // EOI marker (FF D9) at tail
      const tail = await readSignature(blob.slice(blob.size - 2), 'JPEG trailer')
      if (tail.length < 2 || tail[0] !== 0xFF || tail[1] !== 0xD9) {
        throw new SlideImageExportError('encode',
          `Slide ${slideNumber} is missing the JPEG EOI marker.`, slideNumber)
      }
    }
    return blob
  })
}

/** Fixed, not a setting: one more slider earns less than it costs to explain. */
const JPEG_QUALITY = 0.92

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SlideImageExportError('cancelled', 'Export cancelled.')
}

/**
 * Race one async boundary against the signal.
 *
 * Checking the flag before and after an await makes cancellation eventual, not
 * prompt: on a slide whose images take two seconds to decode, a user who
 * pressed Cancel still waits the two seconds. None of these boundaries —
 * `document.fonts.ready`, `img.decode()`, an image load, `canvas.toBlob`,
 * `Blob.arrayBuffer` — accepts a signal of its own, so the wait is raced
 * instead and the underlying operation is simply abandoned.
 *
 * The listener is ALWAYS removed, and the underlying promise always gets a
 * handler attached, so an operation that settles after the abort cannot
 * surface as an unhandled rejection.
 */
function abortable<T>(work: Promise<T>, signal?: AbortSignal, onAbandon?: () => void): Promise<T> {
  if (!signal) return work
  if (signal.aborted) {
    onAbandon?.()
    return Promise.reject(new SlideImageExportError('cancelled', 'Export cancelled.'))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }
    function onAbort() {
      if (settled) return
      settled = true
      cleanup()
      // let the caller drop whatever the abandoned operation was holding
      onAbandon?.()
      reject(new SlideImageExportError('cancelled', 'Export cancelled.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => { if (settled) return; settled = true; cleanup(); resolve(value) },
      (err) => { if (settled) return; settled = true; cleanup(); reject(err) },
    )
  })
}

/** Measurements the caller cannot otherwise see. Test seam. */
export interface RasterDiagnostics {
  svgBytes: number
  uriBytes: number
  width: number
  height: number
}

export interface RasterizeSlideImageOptions {
  doc: BentoDoc
  plannedSlide: PlannedSlideImage
  format: SlideImageFormat
  scale: SlideImageScale
  capturedAt: Date
  cssText: string
  /** Reused across a batch: one backing store instead of N. */
  canvas: HTMLCanvasElement
  signal?: AbortSignal
  limits?: RasterLimits
  /** Injectable so every guard can be driven without allocating what it refuses. */
  budgets?: ExportBudgets
  onDiagnostics?: (d: RasterDiagnostics) => void
}

/**
 * What the raster core needs on top of the public options.
 *
 * PRIVATE, and the inventory is REQUIRED. It used to be an optional field on
 * the exported options, which made the TOCTOU re-check conditional: any path
 * that forgot to pass one skipped it silently, and a caller could disable it
 * from outside simply by not supplying it. Making it required and unexported
 * means there is no way to reach the render without it — the compiler is what
 * enforces that now, rather than a comment.
 */
interface RasterizeSlideImageCoreOptions extends RasterizeSlideImageOptions {
  inventory: ValidatedInventory
}

/**
 * One slide → one encoded image.
 *
 * The ORDER of the steps is the design. Resource policy and size are settled
 * before any DOM exists or any memory is claimed; the render is audited while
 * still detached; only then is it mounted, and only long enough to load what it
 * needs.
 */
export async function rasterizeSlideImage(opts: RasterizeSlideImageOptions): Promise<Blob> {
  const budgets = opts.budgets ?? EXPORT_BUDGETS

  // ORDER MATTERS AND IS THE POINT OF THIS WRAPPER.
  //
  // The deck's own size is a handful of integer comparisons; preflight decodes
  // every embedded payload. So the cheap refusal goes first — a deck that can
  // never be allocated must not spend a single decode learning that, and a
  // wrapper that preflighted first would silently undo the guarantee.
  rasterSize(opts.doc.size, opts.scale, opts.limits ?? EXPORT_LIMITS)

  // Then the whole resource contract. The PUBLIC entrypoint always runs it: a
  // caller arriving here directly has made no promises about what it checked.
  // The batch below validates its whole selection in one pass and calls the
  // core instead, so nothing is decoded twice — and there is deliberately no
  // "skip" flag, which would make the safe path the one a caller has to
  // remember to ask for.
  // Capture the explicitly app-owned sheet once. Author CSS comes from the
  // selected slide model below and is validated through the resource inventory.
  const cssText = opts.cssText ?? buildExportCss(opts.doc, budgets)
  const { uses, validated } = preflightExportResources(
    opts.doc, [{ slide: opts.plannedSlide.slide, slideNumber: opts.plannedSlide.slideNumber }],
    budgets, { includeFonts: true })

  // Policy passed; now prove the bytes can become pixels. A corrupt payload
  // that satisfies every header check still cannot render, and rendering it
  // anyway produces a hole nobody is told about.
  await verifyResourcesDecodable(uses, new Set(), opts.signal)

  return rasterizeSlideImageCore({ ...opts, cssText, inventory: inventoryOf(uses, validated) })
}

/**
 * The raster path, on the assumption that preflight has already run.
 *
 * It repeats `rasterSize` — deliberately. Recomputing a few integer bounds
 * costs nothing and means the dimensions used to allocate the canvas are
 * derived here, next to the allocation, rather than trusted from a caller.
 */
async function rasterizeSlideImageCore(opts: RasterizeSlideImageCoreOptions): Promise<Blob> {
  const { doc, plannedSlide, format, scale, capturedAt, cssText, canvas, signal } = opts
  const limits = opts.limits ?? EXPORT_LIMITS
  const budgets = opts.budgets ?? EXPORT_BUDGETS
  const n = plannedSlide.slideNumber

  throwIfAborted(signal)
  // 1. the same cheap bound the wrapper checked, recomputed where it is used
  const size = rasterSize(doc.size, scale, limits)

  // 2. THE DOCUMENT MAY HAVE MOVED. Re-collect this slide and require every
  // reference to be one preflight already approved — the render below is what
  // fetches, so this is the last moment the check is worth anything.
  // UNCONDITIONAL. The inventory is required, so there is no branch here that
  // could skip the check — which is exactly what the optional field allowed.
  assertSlideUnchangedSincePreflight(doc, plannedSlide.slide, n, opts.inventory, budgets)

  // 3. one captured instant for every field on the slide
  const fields = fieldContextForExport(doc, plannedSlide.slide, capturedAt)

  // 4-6. render an INERT clone, then restore each media still from the original
  const surface = renderSlide(inertSlideClone(plannedSlide.slide), doc,
    { hidePlaceholders: true, fields })
  replaceMediaWithStills(surface, plannedSlide.slide, doc, fields)

  // 7. cursors go BEFORE the audit: a still has no pointer, so a cursor is
  // never a resource to weigh — removing it is both kinder and stricter.
  stripCursorFromRendered(surface)

  // 8. audit while still detached — mounting is what fetches
  assertNoExternalRenderedResources(surface, cssText, n, budgets, opts.inventory.keys)

  // 9. a still frame: no SMIL, no hover but the default set
  freezeAuthorSvg(surface)
  applyDefaultHoverState(surface, plannedSlide.slide)

  // 10. SERIALIZE WHILE DETACHED, and check the payload budgets here. Both
  // happen before the staging mount and before any image decode, so a slide
  // that is too big to export never costs a mount to find out.
  let svg: string
  try {
    const xhtml = new XMLSerializer().serializeToString(surface)
    svg = svgDocument(xhtml, cssText, doc.size.width, doc.size.height, scale)
  } catch (err) {
    throw new SlideImageExportError('encode',
      `Slide ${n} could not be written out as XML (${String(err)}).`, n)
  }
  const svgBytes = utf8Length(svg)
  if (svgBytes > budgets.maxSerializedBytes) {
    throw new SlideImageExportError('size',
      `Slide ${n} is too complex to export as an image.`, n)
  }
  // The percent-encoded length is KNOWN before encoding: every UTF-8 byte
  // costs either 1 character or 3, and which one depends only on the byte.
  // Counting first refuses an oversized slide without ever building the string
  // — encodeURIComponent on a 40 MB SVG allocates the 100 MB result before
  // anyone can look at how big it got.
  let encodedChars: number
  try {
    encodedChars = percentEncodedLength(svg)
  } catch (err) {
    // A lone surrogate — one paste away in any text box. It surfaces HERE,
    // named to the slide, rather than as an uncaught URIError from
    // encodeURIComponent further down.
    throw new SlideImageExportError('encode',
      `Slide ${n} contains text that cannot be encoded (${String(err)}). ` +
      'An unpaired special character is the usual cause.', n)
  }
  if (DATA_URI_PREFIX.length + encodedChars > budgets.maxDataUriChars) {
    throw new SlideImageExportError('size',
      `Slide ${n} is too complex to export as an image.`, n)
  }
  // Only now, with the exact length known to fit, is the string built.
  const uri = DATA_URI_PREFIX + encodeURIComponent(svg)
  opts.onDiagnostics?.({ svgBytes, uriBytes: uri.length, width: size.width, height: size.height })

  // 11. mount off-screen, only for as long as loading takes
  const staging = document.createElement('div')
  staging.setAttribute('style',
    `position:fixed;left:-99999px;top:0;width:${doc.size.width}px;height:${doc.size.height}px;` +
    'pointer-events:none;opacity:0')
  staging.setAttribute('aria-hidden', 'true')
  staging.appendChild(surface)
  document.body.appendChild(staging)
  try {
    await waitForRenderedAssets(surface, n, signal)
    throwIfAborted(signal)

    // 12. a data: URI, never a blob: URL — a blob TAINTS the canvas on file://,
    // which is the one place a bento document is most often opened.
    const img = await decodeSvgImage(uri, n, signal)
    throwIfAborted(signal)
    try {
      // A COURTESY decode: onload already proved the image, so a plain failure
      // here is tolerable. A cancellation is not — it is raced like every other
      // boundary and rethrown with its own code rather than swallowed, or
      // pressing Cancel here would sit until the decode finished on its own.
      await abortable(img.decode(), signal)
    } catch (err) {
      if (err instanceof SlideImageExportError) throw err
      /* onload already resolved; the decode was only a courtesy */
    }
    throwIfAborted(signal)

    // 13. draw at checked backing dimensions. Sizing a canvas is an allocation
    // and can throw; a raw RangeError here would surface as "something went
    // wrong" with no slide attached to it.
    try {
      canvas.width = size.width
      canvas.height = size.height
    } catch (err) {
      throw new SlideImageExportError('canvas',
        `Slide ${n} needs a ${size.width}×${size.height} drawing surface, which could not be ` +
        `created (${String(err)}).`, n)
    }
    // getContext can THROW as well as return null on a surface this large.
    let ctx: CanvasRenderingContext2D | null
    try {
      ctx = canvas.getContext('2d')
    } catch (err) {
      throw new SlideImageExportError('canvas',
        `Slide ${n} could not get a drawing surface (${String(err)}).`, n)
    }
    if (!ctx) throw new SlideImageExportError('canvas', `Slide ${n} got no drawing surface.`, n)
    if (format === 'jpeg') {
      // JPEG has no alpha. Without this, everything transparent encodes BLACK.
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, size.width, size.height)
    }
    try {
      ctx.drawImage(img, 0, 0, size.width, size.height)
    } catch (err) {
      throw new SlideImageExportError('canvas',
        `Slide ${n} could not be drawn (${String(err)}).`, n)
    }

    // 14. encode
    return await canvasToBlob(canvas, format, n, signal)
  } finally {
    // 15. the staging surface never outlives the slide, and the canvas gives
    // its backing store back rather than holding megabytes until the next one.
    staging.remove()
    canvas.width = 0
    canvas.height = 0
  }
}

// --- the batch --------------------------------------------------------------

export interface ExportProgress {
  completed: number
  total: number
  /** One-based document position, ready for localized UI copy. */
  slideNumber: number
}

export interface ExportArtifact {
  blob: Blob
  filename: string
}

export interface ExportHooks {
  signal?: AbortSignal
  onProgress?: (progress: ExportProgress) => void
  /** Test seam; production defaults to () => new Date(). */
  now?: () => Date
  /** Injectable so every budget can be driven without allocating what it refuses. */
  budgets?: ExportBudgets
}

/**
 * The whole operation: plan, preflight, render, and ONE artifact.
 *
 * ALL-OR-NOTHING, which is a narrower promise than "nothing happens until
 * everything is checked". Everything that can be decided from the MODEL — the
 * deck's size, every resource's format and declared dimensions, every font, the
 * aggregate payload — is settled before the first slide renders. But some
 * failures only a real raster can find: a policy-legal image that turns out to
 * be damaged fails at DECODE, which is necessarily after earlier slides have
 * already encoded and reported progress.
 *
 * What is guaranteed is the OUTPUT: when anything fails, at any point, this
 * returns nothing at all. Half a carousel is worse than none, because the gap
 * is invisible until someone has already posted it.
 *
 * `docSnapshot` is never mutated: it is a deep clone the caller took, and
 * export is a read.
 */
export async function exportSlideImages(
  docSnapshot: BentoDoc,
  currentSlideId: string,
  options: SlideImageExportOptions,
  hooks: ExportHooks = {},
): Promise<ExportArtifact> {
  const now = hooks.now ?? (() => new Date())
  const budgets = hooks.budgets ?? EXPORT_BUDGETS
  const capturedAt = now()
  const plan = buildSlideImageExportPlan(docSnapshot, currentSlideId, options, capturedAt)
  throwIfAborted(hooks.signal)

  // Preflight everything the MODEL can answer, in cost order. A batch that
  // cannot finish should not start: rendering four slides and then refusing the
  // fifth wastes the user's time and leaves them guessing which one was wrong.
  //
  // The deck's own size comes first because it is free and decides the rest.
  rasterSize(docSnapshot.size, options.scale, EXPORT_LIMITS)
  // ONE inventory walk covers fonts, every slide's resources, the aggregate
  // URI budget and the per-slide pixel pool — in that order, and with nothing
  // decoded until every length has been checked.
  // Capture the explicitly app-owned sheet once. Author CSS comes only from
  // the selected snapshot slides and is validated through the inventory.
  const cssText = buildExportCss(docSnapshot, budgets)
  const { uses, validated } = preflightExportResources(
    docSnapshot,
    plan.slides.map((p) => ({ slide: p.slide, slideNumber: p.slideNumber })),
    budgets,
    { includeFonts: true })
  // Once for the whole batch: a sixty-slide deck sharing one logo decodes it
  // once, and the per-slide core below is called instead of the public wrapper
  // so nothing repeats this.
  throwIfAborted(hooks.signal)
  await verifyResourcesDecodable(uses, new Set(), hooks.signal)
  throwIfAborted(hooks.signal)
  const inventory = inventoryOf(uses, validated)

  const canvas = document.createElement('canvas')
  let entries: StoreZipEntry[] = []
  try {
    let encoded = 0
    for (const planned of plan.slides) {
      throwIfAborted(hooks.signal)
      // The CORE, not the public wrapper: the whole selection was preflighted
      // above in one pass, and going through the wrapper would re-decode every
      // payload once per slide.
      const blob = await rasterizeSlideImageCore({
        doc: docSnapshot,
        plannedSlide: planned,
        format: options.format,
        scale: options.scale,
        capturedAt,
        cssText,
        canvas,
        signal: hooks.signal,
        budgets,
        inventory,
      })
      throwIfAborted(hooks.signal)

      if (options.scope === 'current') {
        hooks.onProgress?.({ completed: 1, total: 1, slideNumber: planned.slideNumber })
        return { blob, filename: plan.artifactName }
      }

      let bytes: Uint8Array
      throwIfAborted(hooks.signal)
      try {
        bytes = new Uint8Array(await abortable(blob.arrayBuffer(), hooks.signal))
      } catch (err) {
        // A cancellation keeps its own code. Relabelling it "encode" would tell
        // the user their image failed when in fact they stopped it.
        if (err instanceof SlideImageExportError) throw err
        throw new SlideImageExportError('encode',
          `Slide ${planned.slideNumber}'s image could not be read back (${String(err)}).`,
          planned.slideNumber)
      }
      throwIfAborted(hooks.signal)
      encoded += bytes.length
      if (encoded > budgets.maxEncodedBatchBytes) {
        throw new SlideImageExportError('archive',
          'These slides are too large to export in one archive. Try 1x, or JPEG.',
          planned.slideNumber)
      }
      entries.push({ name: planned.entryName, data: bytes })
      hooks.onProgress?.({
        completed: planned.exportIndex,
        total: plan.slides.length,
        slideNumber: planned.slideNumber,
      })
    }

    throwIfAborted(hooks.signal)
    // Both of these allocate a copy of everything collected so far, and both
    // can fail on a machine that is already tight. Neither may surface as a
    // bare RangeError with no idea what the user was doing.
    let zip: Uint8Array
    try {
      zip = writeStoreZip(entries, capturedAt)
    } catch (err) {
      if (err instanceof SlideImageExportError) throw err
      throw new SlideImageExportError('archive',
        `The archive could not be built (${String(err)}). Try exporting fewer slides, or JPEG.`)
    }
    try {
      return {
        blob: new Blob([zip as unknown as BlobPart], { type: 'application/zip' }),
        filename: plan.artifactName,
      }
    } catch (err) {
      throw new SlideImageExportError('archive',
        `The archive could not be assembled for download (${String(err)}).`)
    }
  } finally {
    // Whatever happened, let the images go: a refused 60-slide batch must not
    // keep half a gigabyte alive until something else triggers a collection.
    entries = []
    canvas.width = 0
    canvas.height = 0
  }
}

/**
 * Hand the artifact to the browser's download machinery, and nothing else.
 *
 * Deliberately NOT the save path. It does not touch kernel save.ts, does not
 * take or change a File System Access handle, and does not mark the deck dirty
 * — an image is a derivative, and exporting one must never put the user's
 * actual document at risk.
 */
export function downloadExportArtifact(artifact: ExportArtifact): void {
  const url = URL.createObjectURL(artifact.blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = artifact.filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    // BOTH of these belong in the finally. If click() throws — a policy block,
    // an extension, a browser that refuses a synthetic activation — the anchor
    // would otherwise stay in the document forever and the object URL would
    // never be revoked, leaking the whole blob for the life of the tab.
    anchor.remove()
    // Revoking immediately races the download in some browsers; revoking never
    // leaks. Once, on a delay.
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_MS)
  }
}
