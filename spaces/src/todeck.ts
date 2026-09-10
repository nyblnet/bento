// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// PAGE → DECK: one `bento/spaces` page as a `bento/slides` DOCUMENT.
//
// ————— WHAT THIS EMITS, AND WHAT IT DELIBERATELY DOES NOT ——————————————————
//
// This produces the deck's DOCUMENT JSON — the thing that goes inside a slides
// file's `#bento-doc` block — and nothing else. It does NOT produce a
// `.bento.html` deck, and that is a scope decision rather than an omission:
// a self-contained deck is a document spliced into a slides SHELL, spaces has
// no shell but its own, and there are only three ways to get one. Bundling it
// would put ~560KB of another app inside every space; fetching it breaks
// PLATFORM §1 (opening a document touches nothing); asking the maintainer to
// build a joint shell is a change in two zones this one may not edit. So the
// hand-off is the interchange path slides already documents and already
// supports — "Replace from JSON…" in its About dialog, or
// `window.bento.loadDoc(json)` for a script. The Markdown exporter is the
// precedent: it writes another format faithfully and hands it over.
//
// ————— THE COUPLING, SAID OUT LOUD ————————————————————————————————————————
//
// `bento/slides` is ANOTHER ZONE's format and this file is not allowed to
// change it. What guards against drift is the type import below: `BentoDoc`,
// `Slide` and `SlideElement` come from `slides/src/model.ts`, so a field
// renamed or narrowed over there is a compile error HERE. The types are erased
// at build time, so this costs the spaces shell nothing. What it does NOT
// guard is behaviour — a renderer that stops honouring `valign`, say — and
// there is no rig on the slides side that knows this exporter exists. That is
// a real, accepted cost, not a solved problem.
//
// ————— WHAT MUST NEVER LEAK OUT OF HERE ———————————————————————————————————
//
//   · NO NETWORK (PLATFORM §1). A deck that references `asset:` keys of the
//     SPACE it came from would arrive with holes, and a deck carrying an
//     `http:` image would fetch on open. So every picture is resolved through
//     `assetValue` to its bytes and embedded as a data: URI; anything that
//     would still reach the network is DROPPED and reported.
//   · NO UNTRUSTED MARKUP. A page's `html` came out of a file somebody mailed
//     you. It is re-serialized from the parsed RUN LIST (marks.ts), never
//     passed through, and every text run is escaped — so the deck's html is
//     built by this file out of an allowlist of tags, not filtered out of the
//     input.
//   · NO PROTOTYPE LOOKUPS. Anything keyed by a string from the document goes
//     through `Object.hasOwn` or a `Map`, never a bare index.
//
// ————— LOSS IS REPORTED, NEVER SILENT ————————————————————————————————————
//
// A page is prose and a deck is slides; some of a page has no slide shape at
// all. Every such block produces a `DeckNote`, which the editor shows before
// the download and which is also written into the affected slide's SPEAKER
// NOTES, so the honesty survives the hand-off. Notes carry a machine `code`
// and never an English sentence: the UI turns a code into a literal `t()`
// call, because the i18n sweep only ever sees literals.
//
// SPEAKER NOTES: a page has no speaker-notes concept, and nothing here invents
// one. Mapping review comments onto them was considered and rejected — a
// comment is workspace, it is addressed to a named person, and quietly moving
// it into a file people present from is a disclosure the author never made.
// So the notes channel carries the export's own account of what did not come
// across, which is the one thing a presenter genuinely needs to know.

import type { SpacesDoc, Page, Block } from './model.ts'
import {
  effectiveParents, tableOf, linkCard, assetValue, loadsRemotely, coverSrc, isRemote,
} from './model.ts'
import { parseRuns } from './marks.ts'
import type { Run } from './marks.ts'
import { SPEC } from './blocks.ts'
import { cardPos } from './canvas.ts'
import {
  viewRows, sortRows, passesFilter, fieldsOf, fieldByKey, optionOf,
} from './fields.ts'
import { esc } from './sanitize.ts'
// TYPE-ONLY, and that is the whole cross-zone contract — see the header.
import type {
  BentoDoc, Slide, SlideElement, TextElement, ShapeElement, ImageElement,
  MediaElement, TableElement, TableRow, TableCell,
} from '../../slides/src/model.ts'

// --- the deck's coordinate space --------------------------------------------
// slides' own canonical 16:9 (its model default). Everything below is in these
// pixels, because the format is absolute px and a deck with a different size
// would need every number here recomputed.
const W = 1280
const H = 720
/**
 * Side margin.
 *
 * 96, because that is what bento/slides' own starter deck uses AND what its
 * `validate()` measures against — at 72 every body element on every slide came
 * back as a `past-margin` finding when the emitted deck was loaded into a real
 * built slides shell. Twenty-four pixels of prose room is not worth a deck that
 * reports twenty-five notes the moment its owner validates it.
 */
const M = 96
const BODY_W = W - M * 2

const TITLE_Y = 52
const TITLE_H = 92
const TITLE_FS = 42

const BODY_TOP = 168
const BODY_BOTTOM = H - 56
const BODY_H = BODY_BOTTOM - BODY_TOP

const BODY_FS = 24
const LH = 1.35
/** space between two chunks on a slide */
const GAP = 18
/** width a list loses to its indent, its markers and its monospace runs */
const LIST_INSET = 140

/**
 * How tall a run of text will be, WITHOUT a DOM.
 *
 * A guess, and it is only ever used to decide where to break a slide — never
 * written into the document as a promise. slides' own `validate()` reports
 * real overflow once the deck is open there, which is the measurement; this is
 * the estimate that keeps a page of prose from landing as one 3000px box.
 *
 * 0.58em per character, TUNED AGAINST THE REAL THING: the emitted decks were
 * loaded into a built bento/slides shell and put through its `validate()`,
 * which measures with the actual renderer. At 0.52 two boxes on the starter
 * space's home page came back overflowing by 10px and 15px — six lines of text
 * in a box sized for five. 0.58 is the first value at which all four sample
 * pages report zero overflow. It is still an estimate and always will be;
 * `validate()` in slides remains the measurement. CJK is roughly twice that, so full-width characters count
 * double — otherwise a Japanese page under-estimates by half and every slide
 * overflows.
 */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/
function widthUnits(s: string): number {
  let n = 0
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1
  return n
}
function linesFor(text: string, w: number, fs: number): number {
  const per = Math.max(6, Math.floor(w / (fs * 0.58)))
  let lines = 0
  for (const para of text.split('\n')) lines += Math.max(1, Math.ceil(widthUnits(para) / per))
  return lines
}
const textHeight = (text: string, w: number, fs: number): number =>
  Math.ceil(linesFor(text, w, fs) * fs * LH)

// --- what did not come across ------------------------------------------------

/**
 * A machine code for one kind of loss. NEVER an English sentence: the i18n
 * extractor sweeps `t()` calls with a LITERAL argument out of the source, so a
 * message living in a data table here would ship English in all eight locales.
 * `editor.ts` turns each of these into its own literal `t()` call.
 */
export type DeckNoteCode =
  | 'image-remote'      // a picture that would have to be fetched
  | 'media-remote'      // a clip that would have to be fetched
  | 'media-embedded'    // a clip carried as bytes (big — worth saying)
  | 'link-flattened'    // an inline link kept its words, lost its address
  | 'pagelink'          // a card that opened another page; the deck has no page
  | 'toggle-open'       // a fold cannot fold on a slide
  | 'callout-plain'     // a callout kept its words and tone label, lost its box
  | 'canvas-flattened'  // a canvas became a slide of placed cards, sized by us
  | 'table-split'       // a table too tall for one slide, continued on the next
  | 'view-derived'      // a board became a table of the rows it stood for
  | 'unknown-block'     // a type this build has never heard of
  | 'empty-block'       // a block with nothing in it to carry
  | 'rtl'               // the space is right-to-left; a deck has no such switch
  | 'comments'          // review threads stay behind
  | 'icon-glyph'        // a page icon from the app's own set, not an emoji

export interface DeckNote {
  code: DeckNoteCode
  /** how many blocks this note is about */
  n: number
  /** the slide title it happened under, for the report ('' = the title slide) */
  where: string
}

export interface DeckResult {
  /** the `bento/slides` document — this is what gets handed to slides */
  doc: BentoDoc
  /** one line per kind of loss, aggregated */
  notes: DeckNote[]
  /** slides emitted, including the title slide */
  slides: number
}

// --- inline html: spaces' runs → the subset slides renders -------------------

/**
 * slides' render-time allowlist is `B I U BR SPAN DIV P STRONG EM S CODE UL OL
 * LI H1 H2` and it strips EVERY attribute. So the honest conversion of a
 * spaces mark is: keep the ones that survive, unwrap the ones that do not, and
 * report the one whose meaning is lost.
 *
 * `a` is the case that matters. slides has no inline link — its `link` field
 * jumps to a slide — so an `<a>` is unwrapped by slides' own sanitizer. Keeping
 * the words and saying the address is gone is the only truthful option.
 * `mark` and `span` carry their colour in a `class`, which is stripped, so they
 * unwrap silently; no meaning is lost, only decoration.
 */
const KEEP: Record<string, string> = {
  strong: 'strong', em: 'em', u: 'u', s: 's', code: 'code',
}

interface Inline { html: string; text: string; links: number }

export function inlineForDeck(html: string | undefined): Inline {
  const runs: Run[] = parseRuns(String(html ?? ''))
  let out = ''
  let plain = ''
  let links = 0
  let open: string[] = []
  const close = (): void => { while (open.length) out += `</${open.pop()!}>` }
  for (const run of runs) {
    if (run.br) { close(); out += '<br>'; plain += '\n'; continue }
    const want: string[] = []
    for (const m of run.marks) {
      if (m.tag === 'a') links++
      // hasOwn, never a bare index: `marks` comes out of a document and
      // `KEEP['constructor']` is a function, which is truthy.
      if (Object.hasOwn(KEEP, m.tag)) want.push(KEEP[m.tag])
    }
    // reopen only what changed, so `<strong>a b</strong>` stays one element
    let same = 0
    while (same < open.length && same < want.length && open[same] === want[same]) same++
    while (open.length > same) out += `</${open.pop()!}>`
    for (let i = same; i < want.length; i++) { out += `<${want[i]}>`; open.push(want[i]) }
    out += esc(run.text)
    plain += run.text
  }
  close()
  return { html: out, text: plain, links }
}

/** Wrap already-inline html so a whole chunk reads as one emphasised line. */
const bold = (h: string): string => `<strong>${h}</strong>`

// --- element factories -------------------------------------------------------
// Written out rather than imported from slides/src/model.ts on purpose: the
// TYPES are the contract (a renamed field is a compile error), and building the
// objects here keeps another app's runtime out of the spaces shell.

/** Set once per export, so every element factory below can reach the deck's
 *  body face without threading it through every call. */
let DECK_FAMILY = ''

let seq = 0
/** Deterministic within one export, so two runs over one page differ only in
 *  the doc id — which makes the rig's job possible and a diff readable. */
const eid = (p: string): string => `sp-${p}-${++seq}`

function text(partial: Partial<TextElement> & Pick<TextElement, 'x' | 'y' | 'w' | 'h' | 'html'>): TextElement {
  return {
    id: eid('t'), type: 'text',
    rotation: 0, opacity: 1,
    fontSize: BODY_FS,
    fontFamily: DECK_FAMILY,
    fontWeight: 400,
    color: '#1E2A3A',
    align: 'left', valign: 'top',
    lineHeight: LH,
    ...partial,
  }
}

function rect(partial: Partial<ShapeElement> & Pick<ShapeElement, 'x' | 'y' | 'w' | 'h' | 'fill'>): ShapeElement {
  return {
    id: eid('s'), type: 'shape', shape: 'rect',
    rotation: 0, opacity: 1,
    stroke: 'transparent', strokeWidth: 0, radius: 0,
    ...partial,
  }
}

// --- colour helpers ----------------------------------------------------------

/** Is this background light? Same luminance test slides uses for readable ink. */
function isLight(bg: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(bg).trim().replace(/^#/, '#'))
  if (!m) return true
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55
}

/** `#rrggbb` → `rgba(r,g,b,a)`. Anything else is returned as a safe fallback,
 *  because the colour came out of a document. */
function tint(hex: string, a: number, fallback: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!m) return fallback
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

/** Only a value slides' colour policy will accept — a document can say anything. */
const safeColor = (v: unknown, fallback: string): string =>
  typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : fallback

/** A font family from a document reaches a CSS declaration, so it is capped and
 *  stripped of everything a font list never contains. */
const safeFamily = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/[^\w\s,'"-]/g, '').slice(0, 200) : ''

// --- the chunk model ---------------------------------------------------------
// A chunk is a measured piece of body content that knows how to place itself at
// a given y. Packing is then one greedy pass with a single rule.

interface Chunk {
  h: number
  make: (y: number, ink: string, accent: string) => SlideElement[]
}

interface Ctx {
  doc: SpacesDoc
  page: Page
  note: (code: DeckNoteCode, where: string) => void
  where: () => string
}

// --- lists -------------------------------------------------------------------

const LIST_TYPES = new Set(['bullet', 'number', 'todo'])

/** `☐`/`☑` for a to-do; slides renders a `ul` marker for the rest. */
function listItemHtml(b: Block, inline: Inline): string {
  if (b.type === 'todo') return `${b.done === true ? '☑' : '☐'} ${inline.html}`
  return inline.html
}

// --- the exporter ------------------------------------------------------------

export interface DeckOpts {
  /** the deck's docId. Passed in so a rig can pin the output; the editor mints. */
  docId?: string
  /** the deck's `modified` stamp. Passed in so a rig's output is byte-stable. */
  now?: string
}

/**
 * One page → one deck.
 *
 * SLIDE BREAKS, and why these three:
 *   · `h1` and `h2` each start a slide and become its title. That is the
 *     convention every markdown-to-slides tool has converged on, and it is the
 *     one an author can already see in the outline they wrote.
 *   · a `divider` starts a slide with no title — the explicit break, for a page
 *     that has no headings or wants two slides under one.
 *   · `h3` stays in the body as a bold lead-in, because a deck whose every
 *     sub-sub-heading is a slide is a deck nobody wrote.
 * Anything too tall for the slide it is on continues on the next one, with the
 * same title. Silence there is the failure mode: the text would be in the file,
 * off the bottom of the canvas, and the JSON would look perfect.
 */
export function pageToDeck(doc: SpacesDoc, pageId: string, opts: DeckOpts = {}): DeckResult {
  seq = 0
  const page = doc.pages.find((p) => p.id === pageId)
  const theme = doc.theme ?? {}
  const bg = safeColor(theme.background, '#FFFFFF')
  const ink = safeColor(theme.color, isLight(bg) ? '#1E2A3A' : '#F5F7FA')
  const accent = safeColor(theme.accent, '#F7A600')
  // slides' own FONT_STACK, written out rather than imported: importing it
  // would pull that app's runtime into this shell for one string. A space with
  // no family (a hand-written file) must still produce a deck with a real one —
  // an empty `fontFamily` reaches a CSS declaration as nothing at all.
  const family = safeFamily(theme.fontFamily)
    || "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
  const headFamily = safeFamily(theme.headingFamily) || family
  DECK_FAMILY = family

  const tally = new Map<string, DeckNote>()
  const note = (code: DeckNoteCode, where: string): void => {
    const key = `${code}${where}`
    const had = tally.get(key)
    if (had) had.n++
    else tally.set(key, { code, n: 1, where })
  }

  const slides: Slide[] = []
  const deck: BentoDoc = {
    format: 'bento/slides',
    version: 1,
    docId: opts.docId ?? mintId(),
    title: (page?.title || doc.title || 'Untitled').slice(0, 300),
    modified: opts.now ?? new Date().toISOString(),
    size: { width: W, height: H },
    theme: {
      background: bg,
      color: ink,
      accent,
      fontFamily: family,
      ...(headFamily && headFamily !== family ? { headingFamily: headFamily } : {}),
    },
    slides,
    assets: {},
  }

  if (!page) {
    // Not an error the caller can act on differently, and an empty deck would
    // not LOAD (slides' parseDoc requires a non-empty slides array), so the
    // deck says so on its one slide.
    slides.push(titleSlide(deck, 'Untitled', '', '', ink, accent, headFamily))
    return { doc: deck, notes: [], slides: 1 }
  }

  if (theme.dir === 'rtl') note('rtl', '')

  // --- the title slide
  // THE RAW FIELD is what decides whether there was a cover at all, and
  // `coverSrc` is what decides whether it may be shown. Asking only the second
  // question loses the report entirely: `coverSrc` already returns '' for a
  // remote cover, so `if (cover && …)` could never fire and a page whose cover
  // lived on the web exported with no cover and NOTHING SAID. Caught by the
  // rig's count, which is why it counts rather than asserting "some".
  const rawCover = typeof page.cover === 'string' ? page.cover : ''
  const cover = coverSrc(page)
  const coverData = cover ? assetValue(cover, doc) : ''
  const coverOk = !!coverData && !isRemote(coverData)
  if (rawCover && !coverOk) note('image-remote', '')
  // A PAGE ICON IS NOT ALWAYS AN EMOJI. `Page.icon` is documented as one, and
  // the app ALSO accepts a name from its own icon set (render.ts pageIconInto)
  // — the starter space's own pages use those. Written onto a slide as text, a
  // named icon reads as the word "image" above the title, which is what the
  // first end-to-end render showed. Only a glyph travels; a name is reported.
  const rawIcon = typeof page.icon === 'string' ? page.icon.slice(0, 8) : ''
  const icon = rawIcon && !/[A-Za-z0-9]/.test(rawIcon) ? rawIcon : ''
  if (rawIcon && !icon) note('icon-glyph', '')
  slides.push(titleSlide(
    deck,
    page.title || doc.title || 'Untitled',
    icon,
    coverOk ? coverData : '',
    ink, accent, headFamily,
  ))

  // --- walk the page
  const ctx: Ctx = { doc, page, note, where: () => current.title }
  const eff = effectiveParents(page)
  const byId = new Map(page.blocks.map((b) => [b.id, b]))
  /** the nearest ancestor that OWNS its descendants (callout, toggle, canvas) */
  const containerOf = (b: Block): Block | undefined => {
    for (let id = eff.get(b.id); id; id = eff.get(id)) {
      const owner = byId.get(id)
      if (!owner) break
      if (SPEC.get(owner.type)?.container) return owner
    }
    return undefined
  }
  /** list nesting depth, counting only list ancestors */
  const listDepth = (b: Block): number => {
    let d = 0
    for (let id = eff.get(b.id); id; id = eff.get(id)) {
      const owner = byId.get(id)
      if (!owner) break
      if (LIST_TYPES.has(owner.type)) d++
    }
    return Math.min(d, 4)
  }

  let current = { title: '', chunks: [] as Chunk[], own: [] as Slide[] }
  const flush = (): void => {
    if (!current.chunks.length) return
    pack(deck, slides, current.title, current.chunks, ink, accent, headFamily)
    current.chunks = []
  }
  const start = (title: string): void => { flush(); current.title = title }

  // Blocks a container owns are drawn by the container, and a nested list item
  // is drawn by the list run it belongs to.
  const top = page.blocks.filter((b) => {
    if (containerOf(b)) return false
    const parent = b.parent ? byId.get(eff.get(b.id) ?? '') : undefined
    if (parent && LIST_TYPES.has(parent.type) && LIST_TYPES.has(b.type)) return false
    return true
  })

  for (let i = 0; i < top.length; i++) {
    const b = top[i]
    const inline = inlineForDeck(b.html)
    if (inline.links) note('link-flattened', current.title)

    if (b.type === 'h1' || b.type === 'h2') { start(inline.text.trim() || 'Untitled'); continue }
    if (b.type === 'divider') { start(''); continue }

    // whole-slide blocks: they get the current title and the body continues
    // under the same title on the slide after.
    if (b.type === 'table') { flush(); tableSlides(deck, slides, current.title, b, ctx, ink, accent, headFamily); continue }
    if (b.type === 'view') { flush(); viewSlides(deck, slides, current.title, b, ctx, ink, accent, headFamily); continue }
    if (b.type === 'image') { flush(); imageSlide(deck, slides, current.title, b, ctx, ink, accent, headFamily); continue }
    if (b.type === 'media') { flush(); mediaSlide(deck, slides, current.title, b, ctx, ink, accent, headFamily); continue }
    if (b.type === 'canvas') { flush(); canvasSlide(deck, slides, current.title, b, page, eff, byId, ctx, ink, accent, headFamily); continue }

    // a run of adjacent list items becomes ONE text element with real <ul>/<ol>
    if (LIST_TYPES.has(b.type)) {
      const run: Block[] = []
      const ordered = b.type === 'number'
      while (i < top.length && LIST_TYPES.has(top[i].type) && (top[i].type === 'number') === ordered) {
        run.push(top[i])
        i++
      }
      i--
      current.chunks.push(listChunk(run, ordered, listDepth, page, eff, byId, ctx))
      continue
    }

    const chunk = blockChunk(b, inline, ctx)
    if (chunk) current.chunks.push(chunk)
  }
  flush()

  // Nothing but a title? The title slide already carries it; do not emit an
  // empty second slide.
  if (slides.length === 0) slides.push(titleSlide(deck, deck.title, '', '', ink, accent, headFamily))

  // review threads never travel — say so once
  const threads = page.blocks.reduce((n, b) => n + (Array.isArray(b.comments) ? b.comments.length : 0), 0)
    + (Array.isArray(page.comments) ? page.comments.length : 0)
  if (threads) note('comments', '')

  const notes = [...tally.values()]
  writeSlideNotes(slides, notes)
  return { doc: deck, notes, slides: slides.length }
}

function mintId(): string {
  const r = globalThis.crypto?.randomUUID?.()
  return r ?? `deck-${Math.random().toString(36).slice(2, 10)}`
}

// --- slides ------------------------------------------------------------------

function titleSlide(
  deck: BentoDoc, title: string, icon: string, coverData: string,
  ink: string, accent: string, headFamily: string,
): Slide {
  const els: SlideElement[] = []
  let color = ink
  if (coverData) {
    const key = intern(deck, coverData)
    const img: ImageElement = {
      id: eid('i'), type: 'image', x: 0, y: 0, w: W, h: H,
      rotation: 0, opacity: 1, src: key, fit: 'cover', radius: 0,
    }
    els.push(img)
    // A scrim, so the title is legible over a photograph nobody chose for its
    // contrast. Not a backdrop filter: print and PDF drop those.
    els.push(rect({ x: 0, y: 0, w: W, h: H, fill: 'rgba(12,16,22,0.52)' }))
    color = '#FFFFFF'
  }
  if (icon) {
    els.push(text({
      x: M, y: 232, w: BODY_W, h: 92, html: esc(icon),
      fontSize: 64, align: 'left', valign: 'middle', color,
    }))
  }
  els.push(text({
    x: M, y: icon ? 322 : 268, w: BODY_W, h: 200,
    html: esc(title),
    fontSize: 60, fontWeight: 700, fontFamily: headFamily,
    color, align: 'left', valign: 'top', role: 'title',
  }))
  els.push(rect({ x: M, y: icon ? 300 : 246, w: 96, h: 5, fill: accent, radius: 3 }))
  return {
    id: eid('slide'), background: deck.theme.background, transition: 'fade',
    elements: els, notes: '',
  }
}

/** A body slide's chrome: the title and its accent rule, plus the first free y. */
function chrome(title: string, ink: string, accent: string, headFamily: string): { els: SlideElement[]; top: number } {
  if (!title) return { els: [], top: BODY_TOP - 56 }
  return {
    els: [
      text({
        x: M, y: TITLE_Y, w: BODY_W, h: TITLE_H, html: esc(title),
        fontSize: TITLE_FS, fontWeight: 700, fontFamily: headFamily,
        color: ink, valign: 'top', role: 'title',
      }),
      rect({ x: M, y: TITLE_Y + TITLE_H + 4, w: 64, h: 4, fill: accent, radius: 2 }),
    ],
    top: BODY_TOP,
  }
}

const newSlide = (deck: BentoDoc, els: SlideElement[]): Slide => ({
  id: eid('slide'), background: deck.theme.background, transition: 'fade',
  elements: els, notes: '',
})

/** Greedy pack: fill a slide, then continue under the same title. */
function pack(
  deck: BentoDoc, out: Slide[], title: string, chunks: Chunk[],
  ink: string, accent: string, headFamily: string,
): void {
  let open = chrome(title, ink, accent, headFamily)
  let y = open.top
  // COUNTED, not inferred from `els.length`: a titled slide's chrome is already
  // two elements, so "has anything landed here" cannot be read off the array.
  // Inferring it emitted an empty titled slide after every break.
  let placed = 0
  const close = (): void => {
    if (placed) out.push(newSlide(deck, open.els))
    open = chrome(title, ink, accent, headFamily)
    y = open.top
    placed = 0
  }
  for (const c of chunks) {
    // a chunk taller than a whole slide still has to go somewhere: it goes on
    // its own slide and slides' validate() reports the overflow honestly
    if (placed && y + c.h > BODY_BOTTOM) close()
    open.els.push(...c.make(y, ink, accent))
    y += c.h + GAP
    placed++
  }
  if (placed) out.push(newSlide(deck, open.els))
}

// --- chunks ------------------------------------------------------------------

function blockChunk(b: Block, inline: Inline, ctx: Ctx): Chunk | null {
  const spec = SPEC.get(b.type)

  if (b.type === 'h3') {
    const h = textHeight(inline.text, BODY_W, 30)
    return { h, make: (y, ink) => [text({ x: M, y, w: BODY_W, h, html: bold(inline.html), fontSize: 30, color: ink })] }
  }

  if (b.type === 'quote') {
    const h = Math.max(40, textHeight(inline.text, BODY_W - 28, BODY_FS))
    return {
      h,
      make: (y, ink, accent) => [
        rect({ x: M, y, w: 4, h, fill: accent, radius: 2 }),
        text({ x: M + 24, y, w: BODY_W - 24, h, html: `<em>${inline.html}</em>`, color: ink }),
      ],
    }
  }

  if (b.type === 'code') {
    const body = inline.text || ''
    const fs = 20
    const h = Math.max(48, textHeight(body, BODY_W - 40, fs) + 28)
    // A `text` element with the monospace stack rather than slides' `code`
    // element: a CodeElement's highlighting hangs off `grammarAssetId` /
    // `themeAssetId`, which are keys into the DECK's assets and which this
    // exporter has no grammar to put there. Plain monospace on a panel renders
    // identically everywhere and loses nothing but colour.
    const html = esc(body).replace(/\n/g, '<br>')
    return {
      h,
      make: (y, ink) => [
        rect({ x: M, y, w: BODY_W, h, fill: tint(ink, 0.06, 'rgba(30,42,58,0.06)'), radius: 8 }),
        text({
          x: M + 20, y: y + 14, w: BODY_W - 40, h: h - 28, html,
          fontSize: fs, color: ink,
          fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
        }),
      ],
    }
  }

  if (b.type === 'callout' || b.type === 'toggle') {
    if (b.type === 'toggle') ctx.note('toggle-open', ctx.where())
    else ctx.note('callout-plain', ctx.where())
    const kids = childLines(b, ctx)
    const label = b.type === 'callout'
      ? String(b.tone ?? 'note').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24).toUpperCase() || 'NOTE'
      : ''
    const head = label ? `${bold(esc(label))}<br>${inline.html}` : bold(inline.html)
    const bodyHtml = [head, ...kids.map((k) => k.html)].join('<br>')
    const plain = [label, inline.text, ...kids.map((k) => k.text)].filter(Boolean).join('\n')
    const h = Math.max(56, textHeight(plain, BODY_W - 48, BODY_FS) + 32)
    return {
      h,
      make: (y, ink, accent) => [
        rect({ x: M, y, w: BODY_W, h, fill: tint(accent, 0.12, 'rgba(247,166,0,0.12)'), radius: 10 }),
        rect({ x: M, y, w: 4, h, fill: accent, radius: 2 }),
        text({ x: M + 24, y: y + 16, w: BODY_W - 48, h: h - 32, html: bodyHtml, color: ink }),
      ],
    }
  }

  if (b.type === 'pagelink') {
    ctx.note('pagelink', ctx.where())
    const target = ctx.doc.pages.find((p) => p.id === String(b.page ?? ''))
    const label = `→ ${target?.title ?? '?'}`
    const h = textHeight(label, BODY_W, BODY_FS)
    return { h, make: (y, ink) => [text({ x: M, y, w: BODY_W, h, html: bold(esc(label)), color: ink })] }
  }

  if (b.type === 'link') {
    const card = linkCard(b)
    if (!card.url) ctx.note('empty-block', ctx.where())
    const line = [card.title, card.desc].filter(Boolean).join(' — ')
    const plain = card.url ? `${line}\n${card.url}` : line
    const h = Math.max(40, textHeight(plain, BODY_W, BODY_FS))
    const html = card.url
      ? `${bold(esc(line))}<br><span>${esc(card.url)}</span>`
      : bold(esc(line))
    return { h, make: (y, ink) => [text({ x: M, y, w: BODY_W, h, html, color: ink })] }
  }

  if (!inline.text.trim() && !inline.html) {
    // Nothing to carry. A block that is deliberately empty (a spacer paragraph)
    // is the common case, so it is only reported for a type that should have
    // had content.
    if (b.type !== 'p') ctx.note('empty-block', ctx.where())
    return null
  }

  if (!spec) ctx.note('unknown-block', ctx.where())

  const h = textHeight(inline.text, BODY_W, BODY_FS)
  return { h, make: (y, ink) => [text({ x: M, y, w: BODY_W, h, html: inline.html, color: ink })] }
}

/** A container's descendants, flattened to lines in document order. */
function childLines(owner: Block, ctx: Ctx): Array<{ html: string; text: string }> {
  const eff = effectiveParents(ctx.page)
  const out: Array<{ html: string; text: string }> = []
  for (const b of ctx.page.blocks) {
    let inside = false
    for (let id = eff.get(b.id); id; id = eff.get(id)) if (id === owner.id) { inside = true; break }
    if (!inside) continue
    const inline = inlineForDeck(b.html)
    if (!inline.text.trim()) continue
    const bullet = LIST_TYPES.has(b.type) ? '• ' : ''
    const tick = b.type === 'todo' ? (b.done === true ? '☑ ' : '☐ ') : ''
    out.push({ html: `${esc(bullet + tick)}${inline.html}`, text: bullet + tick + inline.text })
  }
  return out
}

function listChunk(
  run: Block[], ordered: boolean, depthOf: (b: Block) => number,
  page: Page, eff: Map<string, string | undefined>, byId: Map<string, Block>,
  ctx: Ctx,
): Chunk {
  // nested items are drawn by their run, so collect the whole subtree in order
  const all: Block[] = []
  const ids = new Set(run.map((b) => b.id))
  for (const b of page.blocks) {
    if (ids.has(b.id)) { all.push(b); continue }
    if (!LIST_TYPES.has(b.type)) continue
    for (let id = eff.get(b.id); id; id = eff.get(id)) {
      if (ids.has(id)) { all.push(b); break }
      if (!byId.get(id) || !LIST_TYPES.has(byId.get(id)!.type)) break
    }
  }
  const base = Math.min(...all.map(depthOf))
  const tag = ordered ? 'ol' : 'ul'
  let html = ''
  let plain = ''
  let depth = -1
  for (const b of all) {
    const inline = inlineForDeck(b.html)
    if (inline.links) ctx.note('link-flattened', ctx.where())
    const d = depthOf(b) - base
    while (depth < d) { html += `<${tag}>`; depth++ }
    while (depth > d) { html += `</${tag}>`; depth-- }
    html += `<li>${listItemHtml(b, inline)}</li>`
    plain += `${'  '.repeat(d)}• ${inline.text}\n`
  }
  while (depth >= 0) { html += `</${tag}>`; depth-- }
  // A LIST IS NARROWER THAN ITS BOX. The `<ul>` indents, the marker takes room,
  // and `<code>` runs inside an item are monospace and wider than the average
  // this estimate is built on. Measured in a built bento/slides shell: at a
  // 40px allowance two of the starter space's lists overflowed their boxes by
  // 10px and 15px; 140 is what makes every sample list fit. Still an estimate.
  const h = textHeight(plain.trimEnd(), BODY_W - LIST_INSET, BODY_FS) + 8
  return { h, make: (y, ink) => [text({ x: M, y, w: BODY_W, h, html, color: ink })] }
}

// --- whole-slide blocks ------------------------------------------------------

/**
 * A table row's height, measured rather than guessed.
 *
 * The first end-to-end render into a built bento/slides shell showed the table
 * CLIPPED — three of five rows and the fourth cut through the middle — because
 * the element box is a fixed height and 36px was smaller than a row actually
 * draws. With `fontSize: 18`, `cellPadY: 9` and a 1px rule, one line of cell
 * text occupies about 45px, so the base is 46 and a wrapping cell adds a line.
 * Erring high costs white space; erring low hides rows.
 */
const ROW_H = 46
const CELL_FS = 18

/** How tall this row draws, allowing for cells whose text wraps. */
function rowHeight(cells: string[], columns: Array<{ w: number }>): number {
  const total = columns.reduce((a, c) => a + c.w, 0) || 1
  let lines = 1
  cells.forEach((html, i) => {
    const w = ((columns[i]?.w ?? 1) / total) * BODY_W - 28
    lines = Math.max(lines, linesFor(inlineForDeck(html).text, Math.max(40, w), CELL_FS))
  })
  return ROW_H + (lines - 1) * Math.ceil(CELL_FS * LH)
}

function deckTableStyle(ink: string, accent: string): TableElement['style'] {
  return {
    headerBg: accent,
    headerColor: isLight(accent) ? '#1E2A3A' : '#FFFFFF',
    zebra: tint(ink, 0.05, 'rgba(30,42,58,0.05)'),
    borderColor: tint(ink, 0.16, 'rgba(30,42,58,0.16)'),
    borderWidth: 1,
    cellPadX: 14, cellPadY: 9,
    fontSize: CELL_FS,
    color: ink,
    radius: 8,
  }
}

function tableEl(
  rows: TableRow[], columns: Array<{ w: number }>, header: boolean,
  y: number, h: number, ink: string, accent: string,
): TableElement {
  return {
    id: eid('tbl'), type: 'table', x: M, y, w: BODY_W, h,
    rotation: 0, opacity: 1,
    columns, rows, header,
    style: deckTableStyle(ink, accent),
  }
}

const cell = (html: string, align?: TableCell['align']): TableCell =>
  align ? { html, align } : { html }

function tableSlides(
  deck: BentoDoc, out: Slide[], title: string, b: Block, ctx: Ctx,
  ink: string, accent: string, headFamily: string,
): void {
  const t = tableOf(b)
  const align = (i: number): TableCell['align'] | undefined => {
    const a = t.colAlign[i]
    return a === 'left' || a === 'center' || a === 'right' ? a : undefined
  }
  const toRow = (r: string[]): TableRow => ({ cells: r.map((c, i) => cell(inlineForDeck(c).html, align(i))) })
  const columns = t.cols.map((w) => ({ w }))
  const head = t.header ? t.rows[0] : null
  const body = t.header ? t.rows.slice(1) : t.rows
  // HEIGHT-DRIVEN, not row-count-driven: one row of long prose is two rows of
  // labels, and a fixed rows-per-slide either clips the first or wastes the
  // second.
  const headH = head ? rowHeight(head, columns) : 0
  const parts: string[][][] = []
  let part: string[][] = []
  let used = headH
  for (const r of body) {
    const rh = rowHeight(r, columns)
    if (part.length && used + rh > BODY_H) { parts.push(part); part = []; used = headH }
    part.push(r)
    used += rh
  }
  if (part.length || !parts.length) parts.push(part)
  if (parts.length > 1) ctx.note('table-split', title)
  for (const chunk of parts) {
    const rows = [...(head ? [toRow(head)] : []), ...chunk.map(toRow)]
    const h = headH + chunk.reduce((a, r) => a + rowHeight(r, columns), 0)
    const c = chrome(title, ink, accent, headFamily)
    c.els.push(tableEl(rows, columns, !!head, c.top, Math.min(h, BODY_H), ink, accent))
    out.push(newSlide(deck, c.els))
  }
}

/**
 * A board or list becomes a TABLE of the rows it stands for.
 *
 * The rows are DERIVED — same source, same filter, same sort, same grouping as
 * the screen — so the deck agrees with the board it came from. Exporting the
 * word "Issues" and nothing else was the Markdown exporter's original bug and
 * is not worth repeating.
 */
function viewSlides(
  deck: BentoDoc, out: Slide[], title: string, b: Block, ctx: Ctx,
  ink: string, accent: string, headFamily: string,
): void {
  ctx.note('view-derived', title)
  const doc = ctx.doc
  const groupKey = String((b as { groupBy?: unknown }).groupBy ?? 'status')
  const grouped = String((b as { layout?: unknown }).layout ?? 'board') !== 'list'
  const field = fieldByKey(doc, groupKey)
  const rows = sortRows(
    doc,
    viewRows(doc, (b as { source?: unknown }).source)
      .filter((r) => passesFilter(doc, r.values, (b as { filter?: unknown }).filter)),
    (b as { sort?: unknown }).sort)
  const order = new Map((field?.options ?? []).map((o, i) => [o.id, i]))
  const seat = (r: (typeof rows)[number]): number =>
    order.get(String(r.values.get(groupKey) ?? '')) ?? Number.MAX_SAFE_INTEGER
  const ordered = grouped
    ? rows.map((r, i) => ({ r, i })).sort((a, c) => (seat(a.r) - seat(c.r)) || (a.i - c.i)).map((x) => x.r)
    : rows
  const others = fieldsOf(doc).filter((f) => f.key !== groupKey)
  const lines = ordered.map((r) => ({
    title: r.page.title,
    group: grouped ? (optionOf(field, r.values.get(groupKey))?.label ?? '—') : '',
    fields: others.map((f) => {
      const v = r.values.get(f.key)
      if (v === undefined || v === null || v === '') return ''
      return optionOf(f, v)?.label ?? (Array.isArray(v) ? v.join(', ') : String(v))
    }).filter(Boolean).join(' · '),
  }))
  const heading = title || inlineForDeck(b.html).text.trim()
  const columns = grouped ? [{ w: 1.5 }, { w: 1 }, { w: 1.6 }] : [{ w: 1.7 }, { w: 2 }]
  const header: TableRow = {
    cells: grouped
      ? [cell('<strong>Page</strong>'), cell(`<strong>${esc(field?.label ?? groupKey)}</strong>`), cell('<strong>Fields</strong>')]
      : [cell('<strong>Page</strong>'), cell('<strong>Fields</strong>')],
  }
  const body = lines.map((l): TableRow => ({
    cells: grouped
      ? [cell(esc(l.title)), cell(esc(l.group)), cell(esc(l.fields))]
      : [cell(esc(l.title)), cell(esc(l.fields))],
  }))
  const perSlide = Math.max(1, Math.floor((BODY_H - ROW_H) / ROW_H))
  if (!body.length) {
    const c = chrome(heading, ink, accent, headFamily)
    c.els.push(text({ x: M, y: c.top, w: BODY_W, h: 60, html: '<em>—</em>', color: ink }))
    out.push(newSlide(deck, c.els))
    return
  }
  if (body.length > perSlide) ctx.note('table-split', heading)
  for (let i = 0; i < body.length; i += perSlide) {
    const rows2 = [header, ...body.slice(i, i + perSlide)]
    const c = chrome(heading, ink, accent, headFamily)
    c.els.push(tableEl(rows2, columns, true, c.top, rows2.length * ROW_H, ink, accent))
    out.push(newSlide(deck, c.els))
  }
}

function imageSlide(
  deck: BentoDoc, out: Slide[], title: string, b: Block, ctx: Ctx,
  ink: string, accent: string, headFamily: string,
): void {
  const src = String(b.src ?? '')
  const c = chrome(title, ink, accent, headFamily)
  const capText = inlineForDeck(typeof b.caption === 'string' ? b.caption : '').text.trim()
  const capH = capText ? textHeight(capText, BODY_W, 18) + 8 : 0
  if (!src || loadsRemotely(src, ctx.doc)) {
    // THE RULE: no network, ever. A deck that referenced this would either
    // fetch on open or arrive with a hole; both are worse than saying so.
    ctx.note(src ? 'image-remote' : 'empty-block', title)
    const label = String(b.alt ?? '') || capText
    c.els.push(text({
      x: M, y: c.top, w: BODY_W, h: 80,
      html: `<em>${esc(label || '—')}</em>`, color: ink,
    }))
    out.push(newSlide(deck, c.els))
    return
  }
  const data = assetValue(src, ctx.doc)
  const key = intern(deck, data)
  const h = BODY_BOTTOM - c.top - capH
  const img: ImageElement = {
    id: eid('i'), type: 'image', x: M, y: c.top, w: BODY_W, h,
    rotation: 0, opacity: 1, src: key, fit: 'contain', radius: 6,
  }
  c.els.push(img)
  if (capText) {
    c.els.push(text({
      x: M, y: c.top + h + 8, w: BODY_W, h: capH, html: `<em>${inlineForDeck(b.caption as string).html}</em>`,
      fontSize: 18, align: 'center', color: ink,
    }))
  }
  out.push(newSlide(deck, c.els))
}

function mediaSlide(
  deck: BentoDoc, out: Slide[], title: string, b: Block, ctx: Ctx,
  ink: string, accent: string, headFamily: string,
): void {
  const src = String(b.src ?? '')
  const c = chrome(title, ink, accent, headFamily)
  if (!src || loadsRemotely(src, ctx.doc)) {
    ctx.note(src ? 'media-remote' : 'empty-block', title)
    c.els.push(text({
      x: M, y: c.top, w: BODY_W, h: 80,
      html: `<em>${esc(String(b.alt ?? '') || '—')}</em>`, color: ink,
    }))
    out.push(newSlide(deck, c.els))
    return
  }
  ctx.note('media-embedded', title)
  const data = assetValue(src, ctx.doc)
  const poster = typeof b.poster === 'string' && b.poster && !loadsRemotely(b.poster, ctx.doc)
    ? assetValue(b.poster, ctx.doc) : ''
  const el: MediaElement = {
    id: eid('m'), type: 'media',
    kind: String(b.kind ?? 'video') === 'audio' ? 'audio' : 'video',
    x: M, y: c.top, w: BODY_W, h: BODY_BOTTOM - c.top,
    rotation: 0, opacity: 1,
    src: intern(deck, data),
    ...(poster ? { poster: intern(deck, poster) } : {}),
    fit: 'contain', radius: 6,
    controls: b.controls !== false,
    loop: b.loop === true,
    muted: b.muted === true,
    // NEVER autoplay. blocks.ts mediaPlayback() states the rule for a space;
    // an export must not hand a surface a flag the source refused to honour.
    autoplay: false,
  }
  c.els.push(el)
  out.push(newSlide(deck, c.els))
}

/**
 * A canvas becomes a SLIDE, which is the one mapping in here that gains
 * something: a spaces canvas stores each card as a percentage across and down
 * a surface of a known aspect ratio, and a slide is a surface of a known aspect
 * ratio. So the arrangement the author made survives, scaled — the only thing
 * invented is the card WIDTH, which the format does not carry yet (canvas.ts
 * reserves `cw`/`ch` for it).
 */
function canvasSlide(
  deck: BentoDoc, out: Slide[], title: string, b: Block, page: Page,
  eff: Map<string, string | undefined>, byId: Map<string, Block>, ctx: Ctx,
  ink: string, accent: string, headFamily: string,
): void {
  ctx.note('canvas-flattened', title)
  const name = inlineForDeck(b.html).text.trim()
  const c = chrome(title || name, ink, accent, headFamily)
  const cards = page.blocks.filter((x) => {
    for (let id = eff.get(x.id); id; id = eff.get(id)) {
      if (id === b.id) return true
      if (!byId.has(id)) break
    }
    return false
  })
  const top = c.top
  const h = BODY_BOTTOM - top
  // CARD_W in canvas.ts is 22% of the surface; the same fraction of the slide
  // keeps a storyboard reading as a storyboard.
  const cw = Math.round(BODY_W * 0.22)
  cards.forEach((card, i) => {
    const p = cardPos(card, i)
    const inline = inlineForDeck(card.html)
    const x = M + Math.round((p.x / 100) * BODY_W)
    const y = top + Math.round((p.y / 100) * h)
    const boxH = Math.max(56, textHeight(inline.text, cw - 24, 17) + 24)
    c.els.push(rect({
      x: Math.min(x, W - M - cw), y: Math.min(y, BODY_BOTTOM - boxH),
      w: cw, h: boxH, fill: tint(ink, 0.07, 'rgba(30,42,58,0.07)'), radius: 8,
    }))
    c.els.push(text({
      x: Math.min(x, W - M - cw) + 12, y: Math.min(y, BODY_BOTTOM - boxH) + 12,
      w: cw - 24, h: boxH - 24,
      html: inline.html || esc('—'), fontSize: 17, color: ink,
    }))
  })
  if (!cards.length) {
    c.els.push(text({ x: M, y: top, w: BODY_W, h: 60, html: `<em>${esc(name || '—')}</em>`, color: ink }))
  }
  out.push(newSlide(deck, c.els))
}

// --- assets ------------------------------------------------------------------

/**
 * Park a data: URI in the DECK's own asset table and return an `asset:` ref.
 *
 * Identical bytes reuse one key, exactly as slides' own `internAsset` does, so
 * a logo on six slides travels once. The key is derived from the bytes so two
 * exports of one page produce the same table.
 */
function intern(deck: BentoDoc, dataUri: string): string {
  const table = (deck.assets ??= {})
  let h = 0x811c9dc5
  for (let i = 0; i < dataUri.length; i++) {
    h ^= dataUri.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  let key = `a${h.toString(36)}`
  // A collision would silently show the wrong picture, so walk until the slot
  // is free or already holds these exact bytes.
  let salt = 0
  while (Object.hasOwn(table, key) && table[key] !== dataUri) key = `a${h.toString(36)}-${++salt}`
  table[key] = dataUri
  return `asset:${key}`
}

// --- honesty, in the file ----------------------------------------------------

/**
 * The drop report, written into the deck's own speaker notes.
 *
 * The editor shows the same list before the download, and a toast is gone in
 * four seconds. A presenter opening this deck a week later has no other way to
 * learn that the page it came from had a video on it.
 */
function writeSlideNotes(slides: Slide[], notes: DeckNote[]): void {
  if (!notes.length || !slides.length) return
  const byTitle = new Map<string, DeckNote[]>()
  for (const n of notes) {
    const list = byTitle.get(n.where)
    if (list) list.push(n)
    else byTitle.set(n.where, [n])
  }
  const line = (n: DeckNote): string => `${NOTE_TEXT[n.code]}${n.n > 1 ? ` (×${n.n})` : ''}`
  // Deck-wide notes ('' where) go on the title slide; the rest go on the first
  // slide carrying that title.
  for (const [where, list] of byTitle) {
    const target = where
      ? slides.find((s) => s.elements.some((e) => e.type === 'text' && e.role === 'title' && e.html === esc(where)))
      : slides[0]
    const slide = target ?? slides[0]
    const head = 'From the page this deck came from:'
    slide.notes = [slide.notes, slide.notes ? '' : '', head, ...list.map(line)]
      .filter((s, i) => s !== '' || i > 0).join('\n').trim()
  }
}

/**
 * ENGLISH, DELIBERATELY, and only here.
 *
 * These strings go into the DOCUMENT, not into the UI: they are written once,
 * into a file that then travels to readers whose locale nobody knows. The UI's
 * copy of the same list is eight translated `t()` calls in editor.ts. A
 * document is not localized by the reader's browser — its words are the words
 * its author saved — so a viewer-locale string in a saved artefact would be a
 * lie the first time the file changed hands.
 */
const NOTE_TEXT: Record<DeckNoteCode, string> = {
  'image-remote': 'a picture that lives on the web was left out (a deck never fetches)',
  'media-remote': 'a clip that lives on the web was left out (a deck never fetches)',
  'media-embedded': 'a clip travelled as embedded bytes — this deck is large',
  'link-flattened': 'a link kept its words; a slide has nowhere to put the address',
  'pagelink': 'a card that opened another page became its title',
  'toggle-open': 'a fold is shown open — a slide cannot fold',
  'callout-plain': 'a callout kept its words and its kind, in a plain panel',
  'canvas-flattened': 'a canvas became a slide; card sizes were chosen here',
  'table-split': 'a table was too tall for one slide and continues on the next',
  'view-derived': 'a board became a table of the rows it stood for',
  'unknown-block': 'a block this build does not know became its text',
  'empty-block': 'a block with nothing in it was left out',
  rtl: 'this space reads right-to-left; a deck has no such setting',
  comments: 'review comments stayed behind, on purpose',
  'icon-glyph': 'the page’s icon is one of this app’s own glyphs and did not travel',
}
