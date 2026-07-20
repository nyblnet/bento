// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
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
    /** entrance animation when the slide is shown. fade-* nudge ~16px; slide-*
     *  sweep ~120px in from an edge (slide-left starts to the right, etc.) */
    enter?: 'fade-up' | 'fade' | 'fade-down' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down'
    /** entrance duration in seconds; omitted = the per-kind default
     *  (slide-* 0.75s, fade-* 0.55s). Lower = snappier, higher = more languid. */
    enterDur?: number
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
      | {
          type: 'motion-path'
          path: string
          duration: number
          delay?: number
          /** easing over each lap (default 'none' = constant tempo) */
          ease?: string
          /** per-anchor speed multipliers (1 = normal, <1 dwells, >1 rushes);
           *  length matches the path's anchor count. Warps the arc-length map
           *  so the element can linger at some points and rush between others. */
          speeds?: number[]
        }
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
  /** live data binding: xAxis labels + series values track this table element */
  source?: { tableId: string }
}

/** One cell of a table. `html` is the same sanitized inline subset as text. */
export interface TableCell {
  html: string
  align?: 'left' | 'center' | 'right'
  /** per-cell overrides (default from the table's style) */
  color?: string
  bg?: string
  bold?: boolean
}

export interface TableRow {
  cells: TableCell[]
}

/** Table-wide look. Cohesion lives here; cells carry only overrides. */
export interface TableStyle {
  headerBg: string
  headerColor: string
  /** stripe colour for alternate body rows; absent = no zebra */
  zebra?: string
  borderColor: string
  borderWidth: number
  cellPadX: number
  cellPadY: number
  fontSize: number
  fontFamily?: string
  /** default body-cell text colour */
  color: string
  /** outer corner radius (px) */
  radius: number
}

/**
 * A data table rendered as a real HTML <table> (table-layout: fixed) by the
 * shared renderer — identical on the editor canvas, thumbnails, present and
 * print. Column widths are fractional weights, normalised at render. Morphs
 * as a box (position/size + style colours); cell CONTENT does not morph.
 */
export interface TableElement extends ElementBase {
  type: 'table'
  /** fractional column weights; length = column count */
  columns: Array<{ w: number }>
  rows: TableRow[]
  /** treat row 0 as a styled header row */
  header: boolean
  style: TableStyle
}

/**
 * Audio or video. Hybrid storage: `src` is a data: URI (embedded — travels
 * inside the .bento.html), an external URL / relative path (referenced — keeps
 * the file small but needs the network / a sibling file), or "asset:<key>".
 * The editor embeds small clips and warns above MEDIA_EMBED_BUDGET, offering a
 * URL instead. Autoplay only fires in PRESENT mode (never on the canvas or in
 * thumbnails).
 */
export interface MediaElement extends ElementBase {
  type: 'media'
  kind: 'video' | 'audio'
  src: string
  /** video only: a still shown before playback (data:/asset:/URL) */
  poster?: string
  /** video only: fit within the element box */
  fit?: 'contain' | 'cover' | 'fill'
  radius?: number
  autoplay?: boolean
  loop?: boolean
  muted?: boolean
  controls?: boolean
}

export type SlideElement =
  | TextElement | ShapeElement | ImageElement | SvgElement | ChartElement | TableElement | MediaElement

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
    /** ordered series colours for new charts; derived from accent when absent */
    chartPalette?: string[]
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
    /**
     * Signed writes (v0.9.18+): the WRITE capability is an ECDSA P-256 keypair,
     * distinct from the symmetric `key` (the READ capability). `writerPub`
     * (raw, base64url) travels in EVERY copy so the relay can verify authorship;
     * `writerPriv` (PKCS#8, base64url) travels ONLY in writer copies. A
     * read-only copy is a writer copy with `writerPriv` stripped — the relay
     * (for `w`-scheme rooms) then drops any op it tries to send. Absent on
     * legacy `r`-scheme rooms, which stay permissive. See docs/collab-design.md.
     */
    writerPub?: string
    writerPriv?: string
    /** 'reader' = this copy is a live viewer: receives updates, never sends. */
    role?: 'writer' | 'reader'
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

// --- chart palette -----------------------------------------------------------
// New charts should wear the deck's colours, not a stock palette. A deck can
// declare theme.chartPalette; otherwise we synthesise a harmonious set from the
// single accent (accent + a cool structural counterpart, each with a light and
// deep tint) so any deck gets on-brand charts out of the box.

function hexToHsl(hex: string): [number, number, number] {
  const m = hex.replace('#', '')
  const r = parseInt(m.slice(0, 2), 16) / 255
  const g = parseInt(m.slice(2, 4), 16) / 255
  const b = parseInt(m.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0; const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return [h, s * 100, l * 100]
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const mm = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c } else { r = c; b = x }
  const to = (v: number) => Math.round((v + mm) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

export function deriveChartPalette(accent: string): string[] {
  let h: number, s: number, l: number
  try { [h, s, l] = hexToHsl(accent) } catch { return ['#5470c6', '#91cc75', '#fac858', '#ee6666'] }
  const coolH = h + 190
  return [
    accent,
    hslToHex(coolH, Math.max(20, s * 0.5), Math.min(56, Math.max(44, l))),        // cool counterpart
    hslToHex(h, s * 0.92, Math.min(84, l + 14)),                                  // accent light
    hslToHex(coolH, Math.max(16, s * 0.38), Math.min(74, l + 20)),               // cool light
    hslToHex(h, s, Math.max(28, l - 16)),                                         // accent deep
    hslToHex(coolH, Math.max(24, s * 0.55), Math.max(26, l - 6)),                // cool deep
  ]
}

// --- table → chart data extraction (shared by creation + live binding) -------

const stripCell = (html: string) =>
  html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, '').replace(/,/g, '').trim()

/** First column = x labels; each mostly-numeric column after = a data series. */
export function tableChartColumns(table: TableElement): { labels: string[]; cols: Array<{ name: string; data: number[]; isPct: boolean }> } {
  const bodyRows = table.header ? table.rows.slice(1) : table.rows
  const headerRow = table.header ? table.rows[0] : null
  const labels = bodyRows.map((r) => stripCell(r.cells[0]?.html ?? ''))
  const cols: Array<{ name: string; data: number[]; isPct: boolean }> = []
  for (let c = 1; c < table.columns.length; c++) {
    const raw = bodyRows.map((r) => r.cells[c]?.html ?? '')
    const parsed = raw.map((h) => parseFloat(stripCell(h)))
    if (parsed.filter((n) => !Number.isNaN(n)).length < Math.ceil(bodyRows.length / 2)) continue
    cols.push({
      name: headerRow ? stripCell(headerRow.cells[c]?.html ?? '') : '',
      data: parsed.map((n) => (Number.isNaN(n) ? 0 : n)),
      isPct: /%/.test(headerRow ? stripCell(headerRow.cells[c]?.html ?? '') : '') ||
        raw.filter((h) => /%/.test(h)).length >= Math.ceil(bodyRows.length / 2),
    })
  }
  return { labels, cols }
}

/**
 * Push a linked table's current values into a chart's option IN PLACE,
 * preserving the chart's styling/axis config (only xAxis labels + each series'
 * data change). Returns true if anything changed. Series map to numeric columns
 * by position; extra series/columns are left untouched.
 */
export function syncLinkedChart(chart: ChartElement, table: TableElement): boolean {
  const before = JSON.stringify(chart.option)
  const { labels, cols } = tableChartColumns(table)
  const opt = chart.option as { xAxis?: any; series?: any }
  if (opt.xAxis && !Array.isArray(opt.xAxis) && typeof opt.xAxis === 'object') opt.xAxis.data = labels
  const series: any[] = Array.isArray(opt.series) ? opt.series : opt.series ? [opt.series] : []
  series.forEach((s, i) => {
    if (!s || !cols[i]) return
    if (s.type === 'pie') s.data = labels.map((name, j) => ({ name, value: cols[i].data[j] ?? 0 }))
    else s.data = cols[i].data
  })
  return JSON.stringify(chart.option) !== before
}

export function chartColorsFor(theme: BentoDoc['theme']): string[] {
  return theme.chartPalette?.length ? theme.chartPalette.slice() : deriveChartPalette(theme.accent)
}

/** Give a chart option the deck's palette unless it already sets explicit colours. */
export function applyChartPalette<T extends Record<string, unknown>>(option: T, theme: BentoDoc['theme']): T {
  const cur = (option as { color?: unknown }).color
  if (!Array.isArray(cur) || cur.length === 0) (option as { color?: string[] }).color = chartColorsFor(theme)
  return option
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

export function defaultTable(partial: Partial<TableElement> = {}): TableElement {
  const cell = (html: string): TableCell => ({ html })
  return {
    id: uid('tbl'),
    type: 'table',
    x: 240, y: 220, w: 800, h: 260,
    rotation: 0, opacity: 1,
    header: true,
    columns: [{ w: 1 }, { w: 1 }, { w: 1 }],
    rows: [
      { cells: [cell('Column A'), cell('Column B'), cell('Column C')] },
      { cells: [cell('Row 1'), cell('—'), cell('—')] },
      { cells: [cell('Row 2'), cell('—'), cell('—')] },
    ],
    style: {
      headerBg: '#1E2A3A',
      headerColor: '#FFFFFF',
      zebra: 'rgba(30,42,58,0.05)',
      borderColor: 'rgba(30,42,58,0.14)',
      borderWidth: 1,
      cellPadX: 16,
      cellPadY: 11,
      fontSize: 18,
      color: '#1E2A3A',
      radius: 10,
    },
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

/** Soft ceiling for embedding media as a data URI (bytes). Above this the
 *  editor warns — a big embed makes the .bento.html slow to open and save. */
export const MEDIA_EMBED_BUDGET = 8 * 1024 * 1024 // 8 MB

export function defaultMedia(
  kind: 'video' | 'audio',
  src: string,
  partial: Partial<MediaElement> = {},
): MediaElement {
  const audio = kind === 'audio'
  return {
    id: uid('m'),
    type: 'media',
    kind,
    x: 440, y: 210,
    w: audio ? 460 : 560, h: audio ? 56 : 315,
    rotation: 0, opacity: 1,
    src,
    fit: 'contain',
    radius: audio ? 12 : 8,
    controls: true,
    // video defaults muted so present-mode autoplay is permitted by browsers
    muted: !audio,
    loop: false,
    autoplay: false,
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
