// The Bento Slides document model. This JSON is what lives inside the
// <script type="application/bento+json"> block of a .bento.html file.

export const FORMAT = 'bento/slides'
export const FORMAT_VERSION = 1

export type TransitionKind = 'none' | 'fade' | 'slide' | 'zoom' | 'morph'

export interface ElementBase {
  /** Stable id. Elements sharing an id across adjacent slides morph into each other. */
  id: string
  x: number
  y: number
  w: number
  h: number
  /** degrees, clockwise */
  rotation: number
  opacity: number
  /**
   * Drop shadow(s), rendered with CSS drop-shadow so they follow the
   * element's alpha shape (rounded corners, ellipses, glyphs, image
   * cutouts). An array stacks: e.g. a dark elevation shadow plus a soft
   * white glow.
   */
  shadow?: ShadowSpec | ShadowSpec[]
  /** presentation effects, run in present mode only */
  fx?: {
    /** entrance animation when the slide is shown */
    enter?: 'fade-up' | 'fade'
    /** stagger step within the entrance sequence; equal values enter together */
    order?: number
    /** animate numeric parts of the text from 0 to their final value */
    countUp?: boolean
    /** continuous ambient motion (slow zoom, for full-bleed photos) */
    ambient?: 'kenburns'
    /**
     * Ken-burns tuning. dir 'drift' (default) is the endless slow yoyo zoom;
     * 'out' and 'in' play ONCE per slide entry — 'out' starts zoomed by
     * `scale` and settles to rest (the classic title-photo effect).
     * `scale` is the far end of the zoom (e.g. 1.06), `duration` in seconds.
     */
    ken?: { dir?: 'drift' | 'out' | 'in'; scale?: number; duration?: number }
    /** continuous looping animation */
    loop?:
      | { type: 'dash-march'; distance?: number; duration?: number }
      | { type: 'motion-path'; path: string; duration: number; delay?: number }
  }
  /** while presenting, clicking this element jumps to the slide with this id */
  link?: string
  /** semantic group tag — hover focus and multi-element behaviours target it */
  group?: string
  /**
   * Editor grouping: elements sharing a groupId select and move as one
   * (click any member → whole group; Alt-click digs to the individual).
   * Distinct from `group`, which carries presentation semantics.
   */
  groupId?: string
  /**
   * In-slide hover reveal: this element is only visible while an element
   * whose `group` equals this value is hovered (slide.hover type 'reveal').
   * The slide's hover.default set is shown when nothing is hovered.
   */
  showOnHover?: string
  /**
   * Layout role — what this element IS on the slide ('title', 'subtitle',
   * 'body', 'kicker'). Applying a different layout moves content between
   * same-role elements, PowerPoint-placeholder style. Free-form string;
   * those four are the conventions the built-in layouts use.
   */
  role?: string
}

export interface ShadowSpec {
  x?: number
  y?: number
  blur: number
  color: string
}

export interface TextElement extends ElementBase {
  type: 'text'
  /** Rich text as sanitized inline HTML (b/i/u/br/span only). */
  html: string
  fontSize: number
  fontFamily: string
  fontWeight: number
  color: string
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  lineHeight: number
  /** px; optional tracking for letter-spaced caps labels */
  letterSpacing?: number
  /**
   * Layout placeholder prompt ("Click to add title"). While the element's
   * html is empty: the editor shows this dimmed; present and print hide the
   * element entirely. Cleared content brings the prompt back.
   */
  placeholder?: string
}

export type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'line' | 'path'

/** Linear gradient fill. Colors are any CSS color, including rgba(). */
export interface GradientFill {
  /** degrees, CSS convention: 0 = bottom→top, 90 = left→right */
  angle: number
  /** ordered stops; `at` is 0..1 along the gradient line */
  stops: Array<{ at: number; color: string }>
}

/** Decoration at a line's tip. Sized relative to the stroke width. */
export type LineEnding = 'none' | 'arrow' | 'dot' | 'bar'

export interface ShapeElement extends ElementBase {
  type: 'shape'
  shape: ShapeKind
  fill: string
  /** when set, wins over `fill` (which is kept as the solid fallback) */
  fillGradient?: GradientFill
  stroke: string
  strokeWidth: number
  /** corner radius, rect only */
  radius: number
  /** dash length in px; 0/undefined = solid stroke (legacy — see strokeStyle) */
  strokeDash?: number
  /** stroke pattern; wins over strokeDash when set */
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  /** line shape only: tip decorations */
  lineStart?: LineEnding
  lineEnd?: LineEnding
  /** path only: SVG path data in the coordinate space given by pathBox */
  d?: string
  /** path only: [x, y, w, h] viewBox the path was authored in */
  pathBox?: [number, number, number, number]
}

export interface ImageElement extends ElementBase {
  type: 'image'
  /** data: URI, or "asset:<key>" referencing doc.assets */
  src: string
  fit: 'contain' | 'cover' | 'fill'
  radius: number
}

export interface SvgElement extends ElementBase {
  type: 'svg'
  /** key into doc.assets holding raw SVG markup (preferred: dedupes) */
  asset?: string
  /** raw inline SVG markup, used when asset is unset */
  markup?: string
  /**
   * CSS injected inside the svg — hover states, focus dims, and animations
   * live here and stay self-contained (svg <style> scopes to its svg).
   */
  css?: string
}

/**
 * Data chart rendered by ECharts. `option` is a PURE-JSON ECharts option
 * (template-string formatters only — never functions): static SVG snapshots
 * on the editor canvas/thumbnails/print, a live interactive instance
 * (tooltips, dataZoom) while presenting.
 */
export interface ChartElement extends ElementBase {
  type: 'chart'
  /** preset key the panel offers to re-seed from (bar/line/pie/scatter) */
  preset?: string
  option: Record<string, unknown>
}

export type SlideElement = TextElement | ShapeElement | ImageElement | SvgElement | ChartElement

/**
 * A review comment thread. Editor-only metadata: never rendered while
 * presenting or printing, but saved in the file so it travels with the
 * document when people pass it around.
 */
export interface Comment {
  id: string
  /** element the thread is anchored to; absent (or dangling) = the slide */
  elementId?: string
  /** point anchor in slide coordinates — used when no elementId is set */
  x?: number
  y?: number
  author: string
  text: string
  /** ISO datetime */
  at: string
  resolved?: boolean
  replies?: Array<{ id: string; author: string; text: string; at: string }>
}

export interface Slide {
  id: string
  background: string
  transition: TransitionKind
  elements: SlideElement[]
  notes: string
  /** optional friendly name (link pickers, state badges) */
  name?: string
  /**
   * Interactive state: this slide is a variant of the slide with the given
   * id. It is hidden from linear navigation — reachable only via element
   * links (and morphs smoothly when element ids are shared with its parent).
   * While on a state: ArrowLeft returns to the parent, ArrowRight continues
   * after the parent.
   */
  stateOf?: string
  /**
   * present-mode hover behaviour:
   * - focus-group: dim every element outside the hovered element's group
   * - reveal: show the showOnHover set matching the hovered group
   *   (`default` names the set visible when nothing is hovered)
   */
  hover?: { type: 'focus-group' | 'reveal'; dim?: number; default?: string }
  /** review comment threads (editor-only; see Comment) */
  comments?: Comment[]
}

export interface BentoDoc {
  format: typeof FORMAT
  version: number
  /**
   * Stable per-document identity (uuid), minted at creation and preserved
   * for the document's whole life — the rendezvous key for future
   * sync / share / merge features. Never derived from content.
   */
  docId: string
  title: string
  /** slide coordinate space, px */
  size: { width: number; height: number }
  theme: {
    background: string
    color: string
    accent: string
    fontFamily: string
  }
  /** present-mode chrome; decks with built-in chrome can turn Reveal's off */
  present?: {
    slideNumber?: boolean
    controls?: boolean
    progress?: boolean
  }
  /** shared assets (raw SVG markup or data URIs), referenced by key */
  assets?: Record<string, string>
  /**
   * embedded fonts: each entry becomes an @font-face at boot, with the font
   * data living in assets (data: URI). Elements then use `family` normally.
   */
  fonts?: Array<{ family: string; asset: string; weight?: string; style?: string }>
  /**
   * Slide layouts: slide-shaped templates that live outside slides[].
   * Instantiating one deep-copies its elements KEEPING their ids — slides
   * born from the same layout share ids, so their common chrome morphs
   * across transitions and stays traceable for a future re-apply merge.
   * When absent, the editor offers its built-in starter layouts.
   */
  layouts?: Slide[]
  /**
   * Live-collaboration credentials (bento-sync), minted AT CREATION so any
   * copy of the file can join once sharing is turned on ("send the file
   * first, share later" just works). `room` is the relay WebSocket URL
   * (random id — never derived from docId), `key` the base64url AES-GCM
   * room key. `on` gates auto-join: absent = true (v0.8.0 files only carried
   * collab while actively shared). Possession of a copy IS the capability;
   * "Rotate keys" re-mints both to cut old copies off. `sync` is the saved
   * CRDT state (registers/liveness/text) stamped at save-time on shared
   * documents — it is what lets an offline-edited copy rejoin as a true
   * fork and merge both ways. Never transmitted as sync ops.
   */
  collab?: {
    room: string
    key: string
    on?: boolean
    sync?: import('./sync/crdt').SyncStateJSON
  }
  /**
   * Template file (.dotx-style): every OPEN instantiates a fresh document —
   * parseDoc strips this flag, mints a new docId and drops collab, so each
   * person who opens the template gets an independent deck with its own
   * identity and credentials. The template file itself never changes (there
   * is no file handle until the user's first save-as).
   */
  template?: boolean
  /**
   * A read-only PLAYER file: boots straight into the presentation and never
   * shows the editor. Honor-system (the JSON is right there), but it makes a
   * hand-out copy present-only for everyone who doesn't go digging.
   */
  readonly?: boolean
  slides: Slide[]
  modified: string
}

let counter = 0
export const uid = (prefix = 'el') =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

export function defaultText(partial: Partial<TextElement> = {}): TextElement {
  return {
    id: uid('t'),
    type: 'text',
    x: 340, y: 300, w: 600, h: 120,
    rotation: 0, opacity: 1,
    html: 'Double-click to edit',
    fontSize: 32,
    fontFamily: FONT_STACK,
    fontWeight: 400,
    color: '#1E2A3A',
    align: 'center',
    valign: 'middle',
    lineHeight: 1.25,
    ...partial,
  }
}

export function defaultChart(option: Record<string, unknown>, partial: Partial<ChartElement> = {}): ChartElement {
  return {
    id: uid('c'),
    type: 'chart',
    x: 400, y: 190, w: 800, h: 520,
    rotation: 0, opacity: 1,
    preset: 'bar',
    option,
    ...partial,
  }
}

export function defaultShape(shape: ShapeKind, partial: Partial<ShapeElement> = {}): ShapeElement {
  return {
    id: uid('s'),
    type: 'shape',
    shape,
    x: 490, y: 260, w: 300, h: 200,
    rotation: 0, opacity: 1,
    fill: '#F7A600',
    stroke: 'transparent',
    strokeWidth: 0,
    radius: shape === 'rect' ? 12 : 0,
    ...partial,
  }
}

export function defaultImage(src: string, partial: Partial<ImageElement> = {}): ImageElement {
  return {
    id: uid('i'),
    type: 'image',
    x: 440, y: 210, w: 400, h: 300,
    rotation: 0, opacity: 1,
    src,
    fit: 'contain',
    radius: 0,
    ...partial,
  }
}

export function emptySlide(partial: Partial<Slide> = {}): Slide {
  return {
    id: uid('slide'),
    background: '#FFFFFF',
    transition: 'fade',
    elements: [],
    notes: '',
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// Layouts. A layout is a Slide that lives in doc.layouts (or the built-in
// set below). Element ids are deterministic per layout and are KEPT when a
// layout is instantiated: slides born from the same layout share ids, so
// their common chrome morphs across transitions.

const ph = (
  id: string,
  placeholder: string,
  frame: { x: number; y: number; w: number; h: number },
  type: Partial<TextElement> = {},
): TextElement => ({
  id,
  type: 'text',
  ...frame,
  rotation: 0, opacity: 1,
  html: '',
  placeholder,
  fontSize: 32,
  fontFamily: FONT_STACK,
  fontWeight: 400,
  color: '#1E2A3A',
  align: 'left',
  valign: 'top',
  lineHeight: 1.25,
  ...type,
})

const bar = (id: string, frame: { x: number; y: number; w: number; h: number }): ShapeElement => ({
  id, type: 'shape', shape: 'rect', ...frame,
  rotation: 0, opacity: 1, fill: '#F7A600', stroke: 'transparent', strokeWidth: 0, radius: 2,
})

/** The layouts every document offers out of the box (not persisted until edited). */
export function builtinLayouts(): Slide[] {
  return [
    {
      id: 'layout-title', name: 'Title', background: '#FFFFFF', transition: 'fade', notes: '', elements: [
        bar('lt-bar', { x: 160, y: 380, w: 72, h: 8 }),
        ph('lt-title', 'Click to add title', { x: 160, y: 404, w: 1280, h: 140 },
          { fontSize: 76, fontWeight: 700, valign: 'middle', role: 'title' }),
        ph('lt-sub', 'Click to add subtitle', { x: 160, y: 556, w: 1100, h: 60 },
          { fontSize: 28, color: '#45566B', valign: 'middle', role: 'subtitle' }),
      ],
    },
    {
      id: 'layout-title-content', name: 'Title + content', background: '#FFFFFF', transition: 'fade', notes: '', elements: [
        ph('ltc-title', 'Click to add title', { x: 120, y: 72, w: 1360, h: 84 },
          { fontSize: 44, fontWeight: 700, valign: 'middle', role: 'title' }),
        bar('ltc-rule', { x: 120, y: 168, w: 1360, h: 3 }),
        ph('ltc-body', 'Click to add content', { x: 120, y: 208, w: 1360, h: 600 },
          { fontSize: 26, color: '#586A80', valign: 'top', lineHeight: 1.5, role: 'body' }),
      ],
    },
    {
      id: 'layout-two-col', name: 'Two columns', background: '#FFFFFF', transition: 'fade', notes: '', elements: [
        ph('l2c-title', 'Click to add title', { x: 120, y: 72, w: 1360, h: 84 },
          { fontSize: 44, fontWeight: 700, valign: 'middle', role: 'title' }),
        bar('l2c-rule', { x: 120, y: 168, w: 1360, h: 3 }),
        ph('l2c-left', 'Left column', { x: 120, y: 208, w: 660, h: 600 },
          { fontSize: 24, valign: 'top', lineHeight: 1.5, role: 'body' }),
        ph('l2c-right', 'Right column', { x: 820, y: 208, w: 660, h: 600 },
          { fontSize: 24, valign: 'top', lineHeight: 1.5, role: 'body' }),
      ],
    },
    {
      id: 'layout-section', name: 'Section divider', background: '#1E2A3A', transition: 'fade', notes: '', elements: [
        bar('lsec-bar', { x: 160, y: 396, w: 72, h: 8 }),
        ph('lsec-title', 'Section title', { x: 160, y: 420, w: 1280, h: 120 },
          { fontSize: 64, fontWeight: 700, color: '#FFFFFF', valign: 'middle', role: 'title' }),
        ph('lsec-kicker', 'PART 1', { x: 160, y: 350, w: 800, h: 40 },
          { fontSize: 18, fontWeight: 600, color: '#F7A600', letterSpacing: 3, valign: 'middle', role: 'kicker' }),
      ],
    },
    { id: 'layout-blank', name: 'Blank', background: '#FFFFFF', transition: 'fade', notes: '', elements: [] },
  ]
}

/** A fresh slide from a layout — new slide id, element ids KEPT (lineage). */
export function instantiateLayout(layout: Slide): Slide {
  const copy: Slide = JSON.parse(JSON.stringify(layout))
  return { ...copy, id: uid('slide'), name: undefined, stateOf: undefined, notes: '' }
}

const textHasContent = (e: SlideElement) =>
  e.type !== 'text' || !!e.html.replace(/<br\s*\/?>/gi, '').replace(/\u200B/g, '').trim()

/**
 * Apply a layout to an existing slide's elements. The matching ladder:
 *   1. by id     — re-applying the slide's own layout resets frames/typography
 *                  while keeping content
 *   2. by role   — cross-layout: the slide's 'title' moves into the new
 *                  layout's 'title' frame (same element type required;
 *                  donors consumed in document order)
 * Content (text html, link) rides along; the layout provides frame and
 * typography. Leftover slide elements that belong to some KNOWN layout
 * (old chrome, unfilled placeholders) are dropped; everything else is user
 * content and survives on top of the new layout's elements.
 */
export function applyLayout(
  slide: Slide,
  layout: Slide,
  knownLayoutElementIds: Set<string>,
): SlideElement[] {
  const donors = slide.elements
  const consumed = new Set<SlideElement>()
  const findDonor = (lel: SlideElement): SlideElement | undefined => {
    const byId = donors.find((e) => !consumed.has(e) && e.id === lel.id)
    if (byId) return byId
    if (!lel.role) return undefined
    return donors.find(
      (e) => !consumed.has(e) && e.role === lel.role && e.type === lel.type && textHasContent(e),
    )
  }
  const out: SlideElement[] = layout.elements.map((lel) => {
    const copy = JSON.parse(JSON.stringify(lel)) as SlideElement
    const d = findDonor(lel)
    if (d) {
      consumed.add(d)
      if (copy.type === 'text' && d.type === 'text' && textHasContent(d)) copy.html = d.html
      if (d.link) copy.link = d.link
    }
    return copy
  })
  for (const e of donors) {
    if (consumed.has(e)) continue
    // layout-owned leftovers: drop chrome and EMPTY placeholders, but text
    // someone actually wrote is never silently lost — it rides along as-is
    if (knownLayoutElementIds.has(e.id) && !(e.type === 'text' && textHasContent(e))) continue
    out.push(e) // survives, painted above the layout
  }
  return out
}

/** Every element id owned by any known layout (built-ins + the document's). */
export function layoutElementIds(doc: BentoDoc): Set<string> {
  const ids = new Set<string>()
  for (const ly of [...builtinLayouts(), ...(doc.layouts ?? [])]) {
    for (const e of ly.elements) ids.add(e.id)
  }
  return ids
}

export const newDocId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : uid('doc')

export function newDoc(): BentoDoc {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    docId: newDocId(),
    title: 'Untitled',
    size: { width: 1280, height: 720 },
    theme: {
      background: '#FFFFFF',
      color: '#1E2A3A',
      accent: '#F7A600',
      fontFamily: FONT_STACK,
    },
    slides: [emptySlide()],
    modified: new Date().toISOString(),
  }
}

export function parseDoc(json: string): BentoDoc | null {
  try {
    const doc = JSON.parse(json)
    if (doc && doc.format === FORMAT && Array.isArray(doc.slides) && doc.slides.length > 0) {
      // Documents from before docId existed get one minted here; it persists
      // on the next save and stays stable from then on.
      if (typeof doc.docId !== 'string' || !doc.docId) doc.docId = newDocId()
      if (doc.template) {
        // template instantiation: this open IS a new document
        delete doc.template
        doc.docId = newDocId()
        delete doc.collab
      }
      return doc as BentoDoc
    }
  } catch {
    /* fall through */
  }
  return null
}
