// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Shape validation for document fragments that arrive from OUTSIDE the deck.
//
// WHY THIS EXISTS. The system clipboard is not a trusted channel: any web page
// with a Copy button can put a Bento clip payload on it, and one ⌘V into an
// open editor used to splice whatever it carried straight into the document.
// That is worse than junk data, because model values are interpolated into
// markup and CSS all over the renderer.
//
// This is the SECOND layer, not the only one. render.ts now escapes and
// validates every value renderTableHtml writes into a `style` attribute
// (cssColor/cssNum/cssFont — see scripts/test-sanitize.ts), so the specific
// `red" onmouseover="…` cell colour no longer mints a handler. But that gate
// covers one function and one field family: `fit` still lands raw in an
// <img>'s cssText, a font's `weight` raw in an @font-face rule (fonts.ts),
// and every renderer written after this one inherits whatever the model was
// allowed to hold. A value that cannot BE in the document cannot be
// mis-rendered by code nobody has written yet, so the model itself is held to
// a shape here — and where the two layers judge the same kind of value, they
// judge it by the same rule (see `color` below).
//
// So a foreign fragment is REBUILT here, key by key, against the format's own
// key table (modelkeys.generated.ts — derived from model.ts and pinned by CI,
// so it cannot drift the way a hand-written list would). An unknown element
// type, an unknown key, an enum that is not one of the literals, a string
// where a number belongs: DROPPED, never repaired. Repairing an attacker's
// value keeps it in the document with our blessing; dropping it costs a paste
// one property, which renders as a plain element. The single exception is
// numeric coercion ("12" → 12), which cannot smuggle anything.
//
// Dropping a property is not always enough, though: an element the format
// requires a key for is not a plain element without it, it is one the renderer
// throws on. Those keys are named in REQUIRED_ELEMENT_KEYS and take the whole
// element with them; nested objects do the same through `shape`'s `required`.
//
// Deliberately DOM-free and with no idea what a clipboard is: the other
// untrusted intake — remote CRDT ops off the relay — can adopt the same
// checks, key by key, through `checkElementProp`.

import type { Slide, SlideElement } from './model'
import { parseThemeRef } from './palette.ts'
import { MODEL_KEYS } from './modelkeys.generated'

/** Reject. JSON has no `undefined`, so it can never collide with a real value. */
const DROP = undefined
type Check = (v: unknown) => unknown

/**
 * Assigning `out['__proto__'] = x` on a plain object walks the setter and
 * changes the prototype — so this key is skipped everywhere a foreign object
 * is copied, including inside a chart option's free-form JSON.
 */
const PROTO = '__proto__'

/**
 * Ceilings. None of these is a security boundary on its own; they exist so a
 * payload that passes every shape check still cannot be a denial of service —
 * an editor that hangs on ⌘V is as lost as one that runs a script.
 */
export const LIMITS = {
  /** ids, group tags, asset keys, a slide's `background` shorthand */
  scalar: 200,
  /** one colour notation. The longest in a real deck (OneMarket, 21 slides,
   *  ~1400 colour-typed values) is 45: `color(srgb 0.156863 0.188235 … / 0.55)`.
   *  render.ts:cssColor caps at 48 — it FALLS BACK past that, this DROPS, so a
   *  little more headroom here costs a degraded colour rather than a lost one. */
  color: 64,
  /** palette references on one element — far above any real element */
  themeRefs: 64,
  /** a CSS font stack names several families */
  fontStack: 300,
  /** placeholder prompts and comment prose */
  prose: 4_000,
  /** rich text of one text element or table cell */
  html: 64 * 1024,
  /** raw <svg> markup of one svg element (a detailed map runs to ~1MB) */
  markup: 4 * 1024 * 1024,
  /** css injected inside one svg element */
  css: 128 * 1024,
  /** one asset: a data: URI (image, font, embedded clip) or raw svg markup */
  asset: 32 * 1024 * 1024,
  assets: 2_000,
  /** the whole clipboard string, before it is even parsed. Sized off what a
   *  legitimate copy can reach, not off a round number: one embedded clip is
   *  MEDIA_EMBED_BUDGET (8MB) → ~10.7MB of base64, so five media slides is
   *  ~54MB. Costs nothing at that size — JSON.parse of a 64MB payload measured
   *  21ms (node 24, M-series, 2026-08-09) — and the 40MB it replaces turned an
   *  oversized-but-real slide copy into 4000 characters of raw JSON pasted as
   *  a text element (editor.ts's plain-text fallback). */
  clipText: 64 * 1024 * 1024,
  elements: 5_000,
  slides: 500,
  rows: 2_000,
  cols: 200,
  comments: 500,
  stops: 64,
  speeds: 2_000,
  /** a chart option is free-form JSON — bounded, not typed */
  optionNodes: 20_000,
  optionDepth: 12,
}

/**
 * Characters that end a CSS value or an HTML attribute early. A colour, a
 * blend mode or a font weight never needs one; a payload that carries one is
 * aiming at the unescaped interpolations in render.ts / fonts.ts.
 */
const CSS_BREAKOUT = /["'<>{};]/
/** Path data is numbers and command letters. Nothing else is a path. */
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9\s,.+\-eE]*$/
/** A scheme we know how to serve; anything else (javascript:, …) is dropped. */
const SAFE_SCHEME = /^(?:data|asset|blob|https?):/i
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Finite number, or a numeric string coerced to one. Out of range = DROP. */
const num = (min: number, max: number): Check => (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? n : DROP
}
const bool: Check = (v) => (typeof v === 'boolean' ? v : DROP)
const oneOf = (...allowed: string[]): Check => (v) =>
  typeof v === 'string' && allowed.includes(v) ? v : DROP
/** Free text that reaches the DOM as text, never as markup. */
const str = (max: number): Check => (v) => (typeof v === 'string' && v.length <= max ? v : DROP)
/** A value that ends up inside a CSS declaration or an HTML attribute. */
const cssValue = (max = LIMITS.scalar): Check => (v) =>
  typeof v === 'string' && v.length <= max && !CSS_BREAKOUT.test(v) ? v : DROP
/**
 * A COLOUR, judged by exactly the rule render.ts:cssColor applies when it
 * writes one into markup — same allowlist, same `url(`/`expression`/`@`/`\`
 * rejection. Kept in step deliberately: CSS_BREAKOUT alone permits `(`, `)`
 * and `:`, which is strictly weaker, and the weaker of two layers is the one
 * that decides. Measured on the pre-change validator: a shadow colour of
 * `red) url(https://evil/f.svg#f` passed here and reached `style.filter`
 * through render.ts:applyElementFrame, which interpolates it raw — a paste
 * that fetches a remote file. Colours are the one model field that reaches
 * CSS in a dozen places, so they get one rule rather than a per-site one.
 */
const COLOR_CHARS = /^[#a-zA-Z0-9(),.%\s/-]+$/
const COLOR_TRICKS = /url\s*\(|expression|@|\\/i
const color = (max = LIMITS.color): Check => (v) => {
  if (typeof v !== 'string') return DROP
  const s = v.trim()
  return s && s.length <= max && COLOR_CHARS.test(s) && !COLOR_TRICKS.test(s) ? v : DROP
}
/**
 * An svg PAINT (`fill` / `stroke`): a colour, or a reference to a gradient or
 * filter defined inside this document's own markup. The quoted form is what
 * real files carry — OneMarket_Commercial_Architecture slide 21, element
 * `topo-0`, paints `fill: url("#core-glow")`, and the pre-change validator
 * dropped it (CSS_BREAKOUT rejects `"`), leaving render.ts:shapeSvg to write
 * `fill="undefined"` and paint the shape BLACK. Only a bare fragment id is
 * allowed: `url(https://evil/track.svg#g)` is a network fetch the paste never
 * asked for, and it is a colour rule that would otherwise wave it through.
 */
const LOCAL_PAINT_REF = /^url\(\s*(?:"#[\w.:-]+"|'#[\w.:-]+'|#[\w.:-]+)\s*\)$/
const paint: Check = (v) =>
  typeof v === 'string' && v.length <= LIMITS.color && LOCAL_PAINT_REF.test(v.trim()) ? v : color()(v)
/**
 * A font stack, which legitimately quotes multi-word families ('Segoe UI').
 * Quotes are therefore allowed here — renderTableHtml escapes them, and
 * injectFonts passes the family through JSON.stringify — but a brace or a
 * semicolon still ends a declaration, so those are not.
 */
const fontStack: Check = (v) =>
  typeof v === 'string' && v.length <= LIMITS.fontStack && !/[<>{};]/.test(v) ? v : DROP
const pathData: Check = (v) =>
  typeof v === 'string' && v.length <= LIMITS.html && PATH_DATA.test(v) ? v : DROP
/**
 * src / poster: a data: URI, an asset: key, a URL, or a relative path.
 *
 * A schemed value is NOT held to CSS_BREAKOUT — a data: URI legitimately
 * carries quotes and semicolons, so demanding they be absent would reject the
 * embedded-image case this field exists for. That means `https://evil/a">…`
 * survives, and it is safe only because of a property of the CONSUMERS: every
 * one of them assigns it as a DOM property (`img.src`, `video.src`,
 * resolveAsset → the same), where the string is a value and never re-parsed as
 * markup. A renderer that string-builds `<img src="${el.src}">` would turn
 * this into an attribute breakout, so it must escape or re-check — noted here
 * because the safety lives at the call site, not in this value.
 */
const mediaRef: Check = (v) => {
  if (typeof v !== 'string' || v.length > LIMITS.asset) return DROP
  if (HAS_SCHEME.test(v)) return SAFE_SCHEME.test(v) ? v : DROP
  return CSS_BREAKOUT.test(v) ? DROP : v // a bare path still lands in an attribute
}

/**
 * Rebuild an object from a key table, dropping every key and value it fails.
 *
 * `required` names the keys the format does not make optional. Without it a
 * nested object whose every key failed came back as `{}` — a shadow with no
 * blur, a gradient with no stops — and the renderer then interpolated
 * `undefined` into a CSS declaration or called `.map` on nothing. Measured:
 * `colorGradient:{angle:90}` survived the pre-change validator and
 * render.ts:cssLinearGradient threw "Cannot read properties of undefined
 * (reading 'map')". A half-object is not a repairable object.
 */
function shape(
  keys: readonly string[], checks: Record<string, Check>, required: readonly string[] = [],
): Check {
  return (v) => {
    if (!isPlainObject(v)) return DROP
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(v)) {
      if (key === PROTO || !keys.includes(key)) continue
      const val = checks[key]?.(v[key])
      if (val !== DROP) out[key] = val
    }
    return required.every((key) => out[key] !== DROP) ? out : DROP
  }
}

/**
 * A homogeneous array. One bad entry drops the WHOLE array, because these
 * arrays are positional — a table's cells line up with its columns, a chart's
 * data with its labels — and silently closing a hole would misalign the rest.
 */
const list = (max: number, item: Check): Check => (v) => {
  if (!Array.isArray(v) || v.length > max) return DROP
  const out: unknown[] = []
  for (const entry of v) {
    const val = item(entry)
    if (val === DROP) return DROP
    out.push(val)
  }
  return out
}

const gradient = shape(MODEL_KEYS.gradient, {
  angle: num(-3600, 3600),
  stops: list(LIMITS.stops, shape(
    ['at', 'color'], { at: num(0, 1), color: color() }, ['at', 'color'],
  )),
}, ['stops'])

const shadowSpec = shape(MODEL_KEYS.shadow, {
  x: num(-1e4, 1e4), y: num(-1e4, 1e4), blur: num(0, 1e4), color: color(),
}, ['blur', 'color'])

const fx = shape(MODEL_KEYS.fx, {
  enter: oneOf('fade-up', 'fade', 'fade-down', 'slide-left', 'slide-right', 'slide-up', 'slide-down'),
  enterDur: num(0, 600),
  order: num(-1e4, 1e4),
  countUp: bool,
  ambient: oneOf('kenburns'),
  ken: shape(MODEL_KEYS.fxKen, {
    dir: oneOf('drift', 'out', 'in'), scale: num(0, 100), duration: num(0, 3600),
  }),
  loop: shape(MODEL_KEYS.fxLoop, {
    type: oneOf('dash-march', 'motion-path'),
    path: pathData,
    duration: num(0, 3600),
    delay: num(0, 3600),
    distance: num(-1e5, 1e5),
    ease: cssValue(64),
    speeds: list(LIMITS.speeds, num(0.001, 1000)),
  }, ['type']), // anim.ts dispatches on it; a loop with no type animates nothing
})

const tableStyle = shape(MODEL_KEYS.tableStyle, {
  headerBg: color(), headerColor: color(), zebra: color(),
  borderColor: color(), borderWidth: num(0, 1e3),
  cellPadX: num(0, 1e3), cellPadY: num(0, 1e3),
  fontSize: num(0, 4000), fontFamily: fontStack, color: color(), radius: num(0, 1e5),
})

// `cells` is required: renderTableHtml walks `row.cells.map` with no guard
const tableRows = list(LIMITS.rows, shape(MODEL_KEYS.tableRow, {
  cells: list(LIMITS.cols, shape(MODEL_KEYS.tableCell, {
    html: str(LIMITS.html),
    align: oneOf('left', 'center', 'right'),
    color: color(), bg: color(), bold: bool,
  })),
}, ['cells']))

/**
 * A chart option is free-form ECharts-shaped JSON that charts-lite interprets
 * key by key, so there is no key table to check it against. What CAN be
 * checked is that it IS plain, bounded JSON — nothing exotic, nothing so deep
 * or so large that drawing it hangs the editor. Anything unexpected anywhere
 * inside drops the WHOLE option (a chart without one renders as an empty svg;
 * chartSnapshotSvg already catches), because a half-pruned option is still an
 * attacker's shape, kept.
 */
const chartOption: Check = (v) => {
  if (!isPlainObject(v)) return DROP
  let nodes = LIMITS.optionNodes
  const pure = (node: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth < 0) return false
    if (node === null) return true
    switch (typeof node) {
      case 'boolean': return true
      case 'number': return Number.isFinite(node)
      case 'string': return node.length <= LIMITS.html
      case 'object': break
      default: return false // functions and symbols never survive JSON anyway
    }
    if (Array.isArray(node)) return node.every((entry) => pure(entry, depth - 1))
    if (!isPlainObject(node)) return false
    return Object.keys(node).every(
      (key) => key !== PROTO && key.length <= LIMITS.scalar && pure(node[key], depth - 1),
    )
  }
  return pure(v, LIMITS.optionDepth) ? v : DROP
}

// `el` is required: a connector end with no element to anchor to is dangling,
// and editor.syncConnectors drops those anyway
const connectorEnd = shape(MODEL_KEYS.connectorEnd, {
  el: cssValue(), side: oneOf('auto', 'top', 'right', 'bottom', 'left'),
}, ['el'])

/**
 * One check per property the format defines on an element, keyed by property
 * name — the names do not collide across element types (`loop` is a media
 * boolean; the animation loop lives under `fx`, checked by its own table).
 *
 * Every name in MODEL_KEYS.element must appear here or it is dropped as if it
 * were unknown; scripts/test-clipboard.ts asserts the coverage, so adding a
 * field to model.ts fails the rig until it is taught here too.
 */
/**
 * Palette references: a map of property PATH → palette token.
 *
 * Two reasons this cannot be waved through. The paths are WALKED by
 * palette.ts to write a resolved colour, so a path segment of `__proto__` or
 * `constructor` is reaching for the prototype chain — the writer refuses to
 * create anything that is not already a string, which blocks it, but a paste
 * boundary should not be relying on a downstream guard. And a token that does
 * not parse is dead weight the validator will report forever, so it is dropped
 * here rather than carried.
 */
const themeRefs: Check = (v) => {
  if (!isPlainObject(v)) return DROP
  const out: Record<string, string> = {}
  let n = 0
  for (const key of Object.keys(v)) {
    if (++n > LIMITS.themeRefs) break
    const token = v[key]
    if (typeof token !== 'string' || token.length > LIMITS.scalar) continue
    if (key.length > LIMITS.scalar) continue
    // path segments: identifiers and array indices only
    const segs = key.split('.')
    if (!segs.length || !segs.every((sg) => /^[A-Za-z_$][A-Za-z0-9_$]*$|^\d+$/.test(sg))) continue
    if (segs.some((sg) => sg === PROTO || sg === 'constructor' || sg === 'prototype')) continue
    if (!parseThemeRef(token)) continue
    out[key] = token
  }
  return Object.keys(out).length ? out : DROP
}

const ELEMENT_CHECKS: Record<string, Check> = {
  themeRefs,
  // identity + geometry
  id: cssValue(), morphId: cssValue(), role: cssValue(), group: cssValue(),
  groupId: cssValue(), showOnHover: cssValue(), link: cssValue(),
  x: num(-1e6, 1e6), y: num(-1e6, 1e6), w: num(0, 1e6), h: num(0, 1e6),
  rotation: num(-3600, 3600), opacity: num(0, 1),
  shadow: (v) => (Array.isArray(v) ? list(16, shadowSpec)(v) : shadowSpec(v)),
  blur: num(0, 1000), backdropFilter: num(0, 1000), blend: cssValue(64),
  fx,
  // text
  html: str(LIMITS.html), placeholder: str(LIMITS.prose),
  fontSize: num(0, 4000), fontFamily: fontStack, fontWeight: num(1, 1000),
  lineHeight: num(0, 100), letterSpacing: num(-1000, 1000),
  color: color(), colorGradient: gradient,
  align: oneOf('left', 'center', 'right'), valign: oneOf('top', 'middle', 'bottom'),
  textStroke: shape(['width', 'color', 'fill'], {
    width: num(0, 1e3), color: color(), fill: color(),
  }, ['width', 'color']),
  // shape
  shape: oneOf('rect', 'ellipse', 'triangle', 'arrow', 'line', 'path'),
  fill: paint, fillGradient: gradient, stroke: paint,
  strokeWidth: num(0, 1e4), strokeDash: num(0, 1e4),
  strokeStyle: oneOf('solid', 'dashed', 'dotted'),
  lineStart: oneOf('none', 'arrow', 'dot', 'bar'), lineEnd: oneOf('none', 'arrow', 'dot', 'bar'),
  radius: num(0, 1e5), d: pathData,
  pathBox: (v) => (Array.isArray(v) && v.length === 4 ? list(4, num(-1e6, 1e6))(v) : DROP),
  from: connectorEnd, to: connectorEnd,
  // image / svg / media
  src: mediaRef, poster: mediaRef, asset: cssValue(),
  fit: oneOf('contain', 'cover', 'fill'),
  markup: str(LIMITS.markup), css: str(LIMITS.css),
  kind: oneOf('video', 'audio'),
  autoplay: bool, loop: bool, muted: bool, controls: bool,
  // chart / table
  preset: cssValue(), option: chartOption,
  source: shape(['tableId'], { tableId: cssValue() }, ['tableId']),
  columns: list(LIMITS.cols, shape(['w'], { w: num(0, 1e6) }, ['w'])),
  rows: tableRows, header: bool, style: tableStyle,
  type: oneOf(...Object.keys(MODEL_KEYS.element)),
}

/**
 * The keys each element type cannot render WITHOUT. Hand-written because
 * modelkeys.generated.ts records names, not optionality; scripts/test-clipboard.ts
 * pins every entry to a measured failure and asserts each name is real.
 *
 * All six were reproduced against the pre-change validator, which emitted the
 * element anyway (`{type:'table',id:'t'}` came back as `{type:'table',id:'t'}`):
 *
 *   table   columns → renderTableHtml "…(reading 'reduce')" on el.columns
 *           rows    → same, "…(reading 'map')" once columns is supplied
 *   text    html    → resolveFields (render.ts) "…(reading 'indexOf')"
 *   image   src     → resolveAsset "…(reading 'startsWith')"
 *   shape   shape   → shapeSvg's switch matches nothing, node stays undefined
 *           fill    → shapeSvg writes fill="undefined" and the shape paints
 *                     BLACK — the same corruption a rejected `url("#core-glow")`
 *                     used to cause, arriving by the other door
 *   chart   option  → charts-lite has no series to read
 *   media   kind    → the poster/icon still branches on it
 *           src     → nothing to play
 *
 * Not listed, deliberately: values that only DEGRADE. Geometry
 * (x/y/w/h/rotation/opacity) and strokeWidth stringify to "undefinedpx"/"NaN",
 * which CSS and SVG ignore, so the element lands at a default frame instead of
 * throwing — losing a whole pasted element over a defaultable number is the
 * worse trade. `svg` is absent for a different reason: its content comes from
 * `markup` OR `asset` (2 of the 4780 elements in a real deck use the asset
 * form), and svgMarkup already falls back to ''.
 */
const REQUIRED_ELEMENT_KEYS: Record<string, readonly string[]> = {
  text: ['html'],
  shape: ['shape', 'fill'],
  image: ['src'],
  chart: ['option'],
  table: ['columns', 'rows'],
  media: ['kind', 'src'],
}

/** Exported so the rig can prove each name is a real key of that element type. */
export const REQUIRED_KEYS: Readonly<Record<string, readonly string[]>> = REQUIRED_ELEMENT_KEYS

/**
 * Check ONE element property in isolation — the entry point for property-level
 * intake such as remote CRDT ops, where a whole element is never in hand.
 * Returns the value to store; `ok:false` means the op must be ignored.
 */
export function checkElementProp(
  type: string, key: string, value: unknown,
): { ok: boolean; value?: unknown } {
  const known = (MODEL_KEYS.element as Record<string, readonly string[]>)[type]
  if (!known || !known.includes(key) || key === PROTO) return { ok: false }
  const val = ELEMENT_CHECKS[key]?.(value)
  return val === DROP ? { ok: false } : { ok: true, value: val }
}

/** Rebuild a foreign element, or null if it is not one. */
export function sanitizeElement(value: unknown): SlideElement | null {
  if (!isPlainObject(value)) return null
  const type = value.type
  if (typeof type !== 'string') return null
  const known = (MODEL_KEYS.element as Record<string, readonly string[]>)[type]
  if (!known) return null
  // Identity is not optional: ids anchor selection, morph, comments and the
  // CRDT node key, and a slide paste keeps them (only slide ids are reminted).
  const id = ELEMENT_CHECKS.id(value.id)
  if (typeof id !== 'string' || !id) return null
  const out: Record<string, unknown> = { type, id }
  for (const key of Object.keys(value)) {
    if (key === 'type' || key === 'id' || key === PROTO || !known.includes(key)) continue
    const val = ELEMENT_CHECKS[key]?.(value[key])
    if (val !== DROP) out[key] = val
  }
  // An element missing what its type needs is not a degraded element, it is one
  // the format cannot express — and the renderer throws on it (see above), which
  // takes the whole slide down, not just the paste.
  if (!(REQUIRED_ELEMENT_KEYS[type] ?? []).every((key) => out[key] !== DROP)) return null
  return out as unknown as SlideElement
}


const SLIDE_CHECKS: Record<string, Check> = {
  id: cssValue(), name: str(LIMITS.prose), stateOf: cssValue(), themeRefs,
  // background is a CSS `background` shorthand, so it gets the colour rule at
  // the shorthand's length — wide enough for a multi-stop linear-gradient(),
  // still no url() reaching for the network from a pasted slide
  background: color(LIMITS.scalar), notes: str(LIMITS.html),
  hidden: bool,
  transition: oneOf('none', 'fade', 'slide', 'zoom', 'morph'),
  hover: shape(['type', 'dim', 'default'], {
    type: oneOf('focus-group', 'reveal'), dim: num(0, 1), default: cssValue(),
  }, ['type']),
  comments: list(LIMITS.comments, shape(MODEL_KEYS.comment, {
    id: cssValue(), elementId: cssValue(), x: num(-1e6, 1e6), y: num(-1e6, 1e6),
    author: str(LIMITS.prose), text: str(LIMITS.prose), at: str(LIMITS.scalar), resolved: bool,
    replies: list(LIMITS.comments, shape(['id', 'author', 'text', 'at'], {
      id: cssValue(), author: str(LIMITS.prose), text: str(LIMITS.prose), at: str(LIMITS.scalar),
    })),
  })),
  // elements are dropped INDIVIDUALLY: one hostile element must not cost the
  // author the rest of a legitimately copied slide
  elements: (v) => (Array.isArray(v) && v.length <= LIMITS.elements
    ? v.map(sanitizeElement).filter((el): el is SlideElement => el !== null)
    : DROP),
}

/**
 * The property names checked above. scripts/test-clipboard.ts asserts that
 * every name in MODEL_KEYS covers one — a field added to model.ts and not
 * taught here would be dropped from every paste, silently, which is exactly
 * the class of failure this file exists to stop.
 */
export const CHECKED_KEYS = {
  element: Object.keys(ELEMENT_CHECKS),
  slide: Object.keys(SLIDE_CHECKS),
}

/** Rebuild a foreign slide, or null if it is not one. */
export function sanitizeSlide(value: unknown): Slide | null {
  if (!isPlainObject(value)) return null
  const id = SLIDE_CHECKS.id(value.id)
  if (typeof id !== 'string' || !id) return null
  const out = shape(MODEL_KEYS.slide, SLIDE_CHECKS)(value) as Record<string, unknown>
  if (!Array.isArray(out.elements)) out.elements = []
  return out as unknown as Slide
}

/**
 * Rebuild a foreign asset table. Keys become `asset:` references and object
 * keys; values are opaque bytes (a data: URI) or raw svg markup, so they are
 * checked for type and size only — what the renderer does with markup is the
 * renderer's business.
 */
export function sanitizeAssets(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isPlainObject(value)) return out
  let n = 0
  for (const key of Object.keys(value)) {
    if (key === PROTO || !key || key.length > LIMITS.scalar || CSS_BREAKOUT.test(key)) continue
    const v = value[key]
    if (typeof v !== 'string' || v.length > LIMITS.asset) continue
    if (++n > LIMITS.assets) break
    out[key] = v
  }
  return out
}

/**
 * Rebuild a foreign font table. `weight` and `style` are interpolated RAW into
 * an @font-face rule by fonts.ts, so they get the CSS-value treatment; family
 * and asset must both be present or the record cannot load anything.
 */
export function sanitizeFonts(value: unknown): Array<{ family: string; asset: string }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ family: string; asset: string }> = []
  for (const entry of value.slice(0, LIMITS.assets)) {
    const font = shape(['family', 'asset', 'weight', 'style'], {
      family: fontStack, asset: cssValue(), weight: cssValue(64), style: cssValue(64),
    })(entry) as Record<string, unknown> | undefined
    if (typeof font?.family === 'string' && typeof font.asset === 'string' && font.asset) {
      out.push(font as unknown as { family: string; asset: string })
    }
  }
  return out
}
