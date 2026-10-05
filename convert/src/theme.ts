// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The colour and font resolver — the foundation the rest of the importer
// stands on. In the census 22,279 a:schemeClr stand against 2,092 a:srgbClr:
// ~91% of every colour in a real deck is an indirect reference, and every hop
// in the chain fails SILENTLY. A backwards clrMap still renders (dark text on
// dark section slides); a missed fillRef renders 1,727 shapes unfilled with no
// error; a transform computed in the wrong colour space renders every brand
// colour plausibly, consistently, invisibly wrong. Nothing here may guess:
// when a reference cannot be resolved the functions return undefined and the
// CALLER reports the drop — a loud undefined beats a quiet approximation.
//
// THE TWO COLOUR SPACES (the trap the spike names explicitly). PowerPoint's
// colour transforms straddle two spaces and must not be mixed:
//
//   a:shade / a:tint (1,235 / census)  — LINEAR-LIGHT RGB. Each channel is
//     linearized (c/255)^2.2, scaled — shade multiplies by val, tint
//     interpolates toward white — then re-encoded ^(1/2.2). A naive sRGB-space
//     multiply gives e.g. shade(50%) of #808080 = #404040 where PowerPoint
//     paints #5D5D5D; the rig pins both values so the spaces stay apart.
//   a:lumMod / a:lumOff / a:satMod / a:satOff (2,500+ combined) — HSL.
//     lumMod multiplies L, lumOff adds to it (negative offsets are real:
//     the census carries lumOff val="-123").
//
// Transforms apply in DOCUMENT ORDER (lumMod-then-lumOff differs from the
// reverse), channels stay floating through the whole chain, and rounding
// happens exactly once at the end — half-up, the way PowerPoint lands.
//
// What is deliberately NOT here: a:comp/a:inv/a:gray/a:gamma/a:invGamma and
// the hue transforms beyond hueMod/hueOff are 0/6 in the census and are
// skipped; a:scrgbClr (also ~0) maps percentage→channel directly rather than
// through scRGB linearization, matching the major converters.

import { NS, kid, kids, descendants, attr, intAttr, type XElem } from './xml.ts'
import type { ThemeCtx, ResolvedColor } from './types.ts'

/** One resolved colour, with the alpha the css already encodes. */
export interface ColorResult extends ResolvedColor { alpha: number }

// --- channel math ------------------------------------------------------------

/** 0..255 floats until the single final rounding. */
type Rgb = [number, number, number]

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

const toLin = (c: number): number => Math.pow(c / 255, 2.2)
const fromLin = (v: number): number => 255 * Math.pow(clamp01(v), 1 / 2.2)

function hexRgb(hex: string | undefined): Rgb | undefined {
  if (!hex) return undefined
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return undefined
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

interface Hsl { h: number; s: number; l: number }

function rgbToHsl([r, g, b]: Rgb): Hsl {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d) % 6
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hk = (((h % 360) + 360) % 360) / 360
  const chan = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [chan(hk + 1 / 3) * 255, chan(hk) * 255, chan(hk - 1 / 3) * 255]
}

function hslOp(rgb: Rgb, op: (hsl: Hsl) => void): Rgb {
  const hsl = rgbToHsl(rgb)
  op(hsl)
  hsl.s = clamp01(hsl.s)
  hsl.l = clamp01(hsl.l)
  return hslToRgb(hsl)
}

/** ST_Percentage as a fraction: modern "75000" and the transitional "75%"
 *  spelling both occur in the wild. */
function pct(el: XElem, name = 'val'): number {
  const raw = attr(el, name)
  if (raw === undefined) return 0
  if (raw.endsWith('%')) {
    const n = parseFloat(raw)
    return Number.isFinite(n) ? n / 100 : 0
  }
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n / 100000 : 0
}

// --- base colours ------------------------------------------------------------

const COLOR_LOCALS = new Set(['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr'])

/** a:sysClr with no lastClr is rare enough that only the two values real
 *  producers emit (39 windowText / 8 window in the census) get a fallback. */
const SYS_FALLBACK: Record<string, string> = { windowText: '000000', window: 'FFFFFF' }

// ST_PresetColorVal is the X11 palette camelCased. The census uses exactly one
// value (black, 618 times) so this table carries the standard names and lets
// the abbreviated spellings (dkBlue/ltGray/medPurple) normalize onto the full
// ones; an unknown name resolves to undefined so the caller reports it instead
// of painting a guess.
const PRST: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF',
  yellow: 'FFFF00', cyan: '00FFFF', magenta: 'FF00FF', gray: '808080', silver: 'C0C0C0',
  maroon: '800000', olive: '808000', navy: '000080', purple: '800080', teal: '008080',
  lime: '00FF00', aqua: '00FFFF', fuchsia: 'FF00FF', orange: 'FFA500', brown: 'A52A2A',
  pink: 'FFC0CB', gold: 'FFD700', indigo: '4B0082', violet: 'EE82EE', crimson: 'DC143C',
  chocolate: 'D2691E', coral: 'FF7F50', khaki: 'F0E68C', lavender: 'E6E6FA', plum: 'DDA0DD',
  orchid: 'DA70D6', salmon: 'FA8072', sienna: 'A0522D', tan: 'D2B48C', tomato: 'FF6347',
  turquoise: '40E0D0', wheat: 'F5DEB3', beige: 'F5F5DC', ivory: 'FFFFF0', snow: 'FFFAFA',
  azure: 'F0FFFF', aliceBlue: 'F0F8FF', ghostWhite: 'F8F8FF', whiteSmoke: 'F5F5F5',
  gainsboro: 'DCDCDC', dimGray: '696969', slateGray: '708090', steelBlue: '4682B4',
  royalBlue: '4169E1', skyBlue: '87CEEB', deepSkyBlue: '00BFFF', dodgerBlue: '1E90FF',
  cornflowerBlue: '6495ED', midnightBlue: '191970', slateBlue: '6A5ACD', blueViolet: '8A2BE2',
  forestGreen: '228B22', seaGreen: '2E8B57', springGreen: '00FF7F', limeGreen: '32CD32',
  oliveDrab: '6B8E23', yellowGreen: '9ACD32', goldenrod: 'DAA520', firebrick: 'B22222',
  indianRed: 'CD5C5C', hotPink: 'FF69B4', deepPink: 'FF1493', orangeRed: 'FF4500',
  aquamarine: '7FFFD4', cadetBlue: '5F9EA0', chartreuse: '7FFF00', honeydew: 'F0FFF0',
  mistyRose: 'FFE4E1', moccasin: 'FFE4B5', navajoWhite: 'FFDEAD', oldLace: 'FDF5E6',
  peachPuff: 'FFDAB9', peru: 'CD853F', powderBlue: 'B0E0E6', rosyBrown: 'BC8F8F',
  saddleBrown: '8B4513', sandyBrown: 'F4A460', seaShell: 'FFF5EE', thistle: 'D8BFD8',
  burlyWood: 'DEB887',
  darkBlue: '00008B', darkCyan: '008B8B', darkGoldenrod: 'B8860B', darkGray: 'A9A9A9',
  darkGreen: '006400', darkKhaki: 'BDB76B', darkMagenta: '8B008B', darkOliveGreen: '556B2F',
  darkOrange: 'FF8C00', darkOrchid: '9932CC', darkRed: '8B0000', darkSalmon: 'E9967A',
  darkSeaGreen: '8FBC8F', darkSlateBlue: '483D8B', darkSlateGray: '2F4F4F',
  darkTurquoise: '00CED1', darkViolet: '9400D3',
  lightBlue: 'ADD8E6', lightCoral: 'F08080', lightCyan: 'E0FFFF', lightGray: 'D3D3D3',
  lightGreen: '90EE90', lightPink: 'FFB6C1', lightSalmon: 'FFA07A', lightSeaGreen: '20B2AA',
  lightSkyBlue: '87CEFA', lightSlateGray: '778899', lightSteelBlue: 'B0C4DE',
  lightYellow: 'FFFFE0',
  mediumAquamarine: '66CDAA', mediumBlue: '0000CD', mediumOrchid: 'BA55D3',
  mediumPurple: '9370DB', mediumSeaGreen: '3CB371', mediumSlateBlue: '7B68EE',
  mediumSpringGreen: '00FA9A', mediumTurquoise: '48D1CC', mediumVioletRed: 'C71585',
}

/** dkBlue → darkBlue, ltGray → lightGray, medPurple → mediumPurple. */
function normPrst(name: string): string {
  if (/^dk[A-Z]/.test(name)) return `dark${name.slice(2)}`
  if (/^lt[A-Z]/.test(name)) return `light${name.slice(2)}`
  if (/^med[A-Z]/.test(name)) return `medium${name.slice(3)}`
  return name
}

// --- resolveColor ------------------------------------------------------------

/**
 * Resolve the colour inside `el` — either a container (a:solidFill, a:gs, a
 * scheme slot) holding one colour child, or the colour element itself. `phClr`
 * ('#rrggbb') substitutes for a:schemeClr val="phClr", the style-matrix
 * placeholder colour. Returns undefined for anything unresolvable — the
 * caller decides what to report; nothing here invents a value.
 */
export function resolveColor(el: XElem | undefined, theme: ThemeCtx, phClr?: string): ColorResult | undefined {
  if (!el) return undefined
  const c = el.ns === NS.a && COLOR_LOCALS.has(el.local)
    ? el
    : kids(el, NS.a).find((k) => COLOR_LOCALS.has(k.local))
  if (!c) return undefined

  let from: ResolvedColor['from'] = 'own'
  let rgb: Rgb | undefined
  switch (c.local) {
    case 'srgbClr':
      rgb = hexRgb(attr(c, 'val'))
      break
    case 'schemeClr': {
      from = 'theme'
      const v = attr(c, 'val') ?? ''
      rgb = v === 'phClr' ? hexRgb(phClr) : hexRgb(theme.scheme[v])
      break
    }
    case 'sysClr':
      // lastClr is what the producing machine actually painted; trust it over
      // any idea of what "window" means here.
      rgb = hexRgb(attr(c, 'lastClr') ?? SYS_FALLBACK[attr(c, 'val') ?? ''])
      break
    case 'prstClr':
      rgb = hexRgb(PRST[normPrst(attr(c, 'val') ?? '')])
      break
    case 'scrgbClr':
      rgb = [pct(c, 'r') * 255, pct(c, 'g') * 255, pct(c, 'b') * 255]
      break
  }
  if (!rgb) return undefined

  let alpha = 1
  for (const t of kids(c, NS.a)) {
    switch (t.local) {
      case 'alpha': alpha = clamp01(pct(t)); break
      case 'alphaMod': alpha = clamp01(alpha * pct(t)); break
      case 'alphaOff': alpha = clamp01(alpha + pct(t)); break
      case 'shade': {
        const f = pct(t)
        rgb = rgb.map((v) => fromLin(toLin(v) * f)) as Rgb
        break
      }
      case 'tint': {
        const f = pct(t)
        rgb = rgb.map((v) => fromLin(toLin(v) * f + (1 - f))) as Rgb
        break
      }
      case 'lumMod': rgb = hslOp(rgb, (h) => { h.l *= pct(t) }); break
      case 'lumOff': rgb = hslOp(rgb, (h) => { h.l += pct(t) }); break
      case 'satMod': rgb = hslOp(rgb, (h) => { h.s *= pct(t) }); break
      case 'satOff': rgb = hslOp(rgb, (h) => { h.s += pct(t) }); break
      case 'hueMod': rgb = hslOp(rgb, (h) => { h.h *= pct(t) }); break
      // hue offsets are 1/60000ths of a degree, not a percentage
      case 'hueOff': rgb = hslOp(rgb, (h) => { h.h += intAttr(t, 'val') / 60000 }); break
      default: break // comp/inv/gray/gamma/invGamma: 0/6 in the census
    }
  }

  const [r, g, b] = rgb.map((v) => Math.min(255, Math.max(0, Math.round(v))))
  if (alpha >= 1) {
    const h2 = (v: number) => v.toString(16).padStart(2, '0').toUpperCase()
    return { css: `#${h2(r)}${h2(g)}${h2(b)}`, alpha: 1, from }
  }
  const a = Math.round(alpha * 1000) / 1000
  return { css: `rgba(${r},${g},${b},${a})`, alpha: a, from }
}

// --- parseTheme --------------------------------------------------------------

const SCHEME_SLOTS = [
  'dk1', 'lt1', 'dk2', 'lt2',
  'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6',
  'hlink', 'folHlink',
] as const

// The standard master clrMap. "bg1" in a colour reference does NOT mean the
// dk/lt slot of the same name-shape — it routes through this map, and a
// converter that reads it backwards produces dark-on-dark that still renders.
const CLR_MAP_DEFAULT: Record<string, string> = {
  bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2',
  accent1: 'accent1', accent2: 'accent2', accent3: 'accent3',
  accent4: 'accent4', accent5: 'accent5', accent6: 'accent6',
  hlink: 'hlink', folHlink: 'folHlink',
}

/** The base hex of one clrScheme slot (a:dk1 … a:folHlink). Scheme slots hold
 *  a bare a:srgbClr or a:sysClr, never transforms. */
function slotHex(slot: XElem): string | undefined {
  const srgb = kid(slot, NS.a, 'srgbClr')
  if (srgb) {
    const v = attr(srgb, 'val')
    return v && /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toUpperCase()}` : undefined
  }
  const sys = kid(slot, NS.a, 'sysClr')
  if (sys) {
    const v = attr(sys, 'lastClr') ?? SYS_FALLBACK[attr(sys, 'val') ?? '']
    return v ? `#${v.toUpperCase()}` : undefined
  }
  return undefined
}

/**
 * Parse a theme part (theme1.xml root, or a themeOverride) plus the owning
 * master's p:clrMap. The returned scheme is keyed BOTH by the raw slot names
 * (dk1, lt1, … — schemeClr val="dk1" is the single most frequent colour
 * reference in the census at 5,289) and by the logical names the map produces
 * (bg1, tx1, … — 2,146 bg1 references), so resolveColor never has to know
 * which family a reference belongs to.
 */
export function parseTheme(themeXml: XElem, clrMapEl: XElem | undefined): ThemeCtx {
  const scheme: Record<string, string> = {}
  const clrScheme = descendants(themeXml, NS.a, 'clrScheme')[0]
  if (clrScheme) {
    for (const name of SCHEME_SLOTS) {
      const slot = kid(clrScheme, NS.a, name)
      const hex = slot && slotHex(slot)
      if (hex) scheme[name] = hex
    }
  }
  for (const [logical, def] of Object.entries(CLR_MAP_DEFAULT)) {
    const target = (clrMapEl && attr(clrMapEl, logical)) || def
    const hex = scheme[target]
    if (hex) scheme[logical] = hex
  }

  const fontScheme = descendants(themeXml, NS.a, 'fontScheme')[0]
  const face = (which: string): string => {
    const fam = fontScheme && kid(fontScheme, NS.a, which)
    const latin = fam && kid(fam, NS.a, 'latin')
    // Calibri is what an Office file with a broken fontScheme would actually
    // show — the least-wrong stand-in, and METRIC_SUBSTITUTES covers it.
    return (latin && attr(latin, 'typeface')) || 'Calibri'
  }

  const fmtScheme = descendants(themeXml, NS.a, 'fmtScheme')[0]
  const styleList = (name: string): XElem[] => {
    const lst = fmtScheme && kid(fmtScheme, NS.a, name)
    return lst ? kids(lst) : []
  }

  return {
    scheme,
    majorFont: face('majorFont'),
    minorFont: face('minorFont'),
    fillStyles: styleList('fillStyleLst'),
    lineStyles: styleList('lnStyleLst'),
    bgFillStyles: styleList('bgFillStyleLst'),
  }
}

// --- the format-scheme style matrix (fillRef / lnRef) ------------------------

/**
 * A fill resolved through a:fillRef. 'none' is idx 0 — an INTENTIONAL absence,
 * distinct from the undefined an out-of-range or unresolvable reference
 * returns (that one the caller must report). 'solid' is fully resolved;
 * 'other' hands the raw style entry (gradFill/blipFill/…) plus the phClr to
 * substitute back to shapes.ts, which owns gradient parsing.
 */
export type StyleFill =
  | { kind: 'none' }
  | { kind: 'solid'; color: ColorResult }
  | { kind: 'other'; el: XElem; phClr: string }

/**
 * The style matrix's fill lookup: idx 0 = none, 1..999 index fillStyleLst
 * (1-based), >=1000 index bgFillStyleLst (idx-1000, 1-based). 1,727 census
 * shapes carry NO local fill — without this walk they render unfilled with no
 * error to notice.
 */
export function resolveFillRef(idx: number, phClr: string, theme: ThemeCtx): StyleFill | undefined {
  if (idx === 0) return { kind: 'none' }
  if (idx < 0) return undefined
  const bg = idx >= 1000
  const el = (bg ? theme.bgFillStyles : theme.fillStyles)[(bg ? idx - 1000 : idx) - 1]
  if (!el) return undefined
  if (el.ns === NS.a && el.local === 'solidFill') {
    const color = resolveColor(el, theme, phClr)
    return color ? { kind: 'solid', color } : undefined
  }
  return { kind: 'other', el, phClr }
}

/**
 * A line style resolved through a:lnRef. The raw a:ln element rides along —
 * shapes.ts reads width/cap/dash from it — with its solid colour pre-resolved
 * when it has one (gradient strokes stay in `ln` for shapes.ts).
 */
export type StyleLine =
  | { kind: 'none' }
  | { kind: 'ln'; ln: XElem; phClr: string; color?: ColorResult }

export function resolveLnRef(idx: number, phClr: string, theme: ThemeCtx): StyleLine | undefined {
  if (idx === 0) return { kind: 'none' }
  if (idx < 0) return undefined
  const ln = theme.lineStyles[idx - 1]
  if (!ln) return undefined
  const color = resolveColor(kid(ln, NS.a, 'solidFill'), theme, phClr)
  return { kind: 'ln', ln, phClr, color }
}
