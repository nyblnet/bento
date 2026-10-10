// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The placeholder / inheritance resolver — the reason converted shapes have
// frames and text has sizes at all.
//
// The census is blunt about where the values live: ~513 shapes carry no
// geometry element, 100+ carry no a:xfrm, and 10,503 a:defRPr against 4,200
// a:rPr means 71% of run properties are inherited defaults. A converter that
// reads slide XML alone emits unstyled text at 0,0 and it looks like a
// rendering bug, not a missing resolver. Everything here walks the
// slide → layout placeholder → master placeholder chain (plus the master's
// p:txStyles tables for text), and every resolved value records which level
// supplied it, because each hop fails SILENTLY — a wrong match still renders,
// just wrong.
//
// MATCHING IS IDX-FIRST, AND ABSENT idx MEANS "0". The trap: slide-level
// placeholders in real decks carry NO type="title" — the census's p:ph@type
// table has no title row at all. A slide title is written `<p:ph/>`; the type
// lives on the LAYOUT's `<p:ph type="title"/>`. Both sides' idx defaults to 0,
// so idx pairing finds the title; a type-only matcher normalizes the bare
// slide ph to 'body' and grabs the layout's body box instead. Type matching is
// only the fallback for when no candidate shares the idx (a slide ph copied
// against a re-numbered layout).

import { kid, kids, attr, intAttr, NS } from './xml.ts'
import type { XElem } from './xml.ts'
import type { InheritCtx } from './types.ts'
import type { Provenance } from './report.ts'

// --- the chain ---------------------------------------------------------------

export interface ChainLink {
  el: XElem
  from: Provenance
  ph?: XElem
}

/** The shape's p:ph, wherever its nv*Pr flavour keeps it (sp, pic, frame). */
function phOf(shape: XElem): XElem | undefined {
  for (const c of kids(shape)) {
    const nv = kid(c, NS.p, 'nvPr')
    if (nv) return kid(nv, NS.p, 'ph')
  }
  return undefined
}

/** Report `where` for one shape: its cNvPr name when it has one. */
function whereOf(shape: XElem): string {
  for (const c of kids(shape)) {
    const cnv = kid(c, NS.p, 'cNvPr')
    if (cnv) {
      const name = attr(cnv, 'name')
      return name ? `sp "${name}"` : `sp ${attr(cnv, 'id') ?? '?'}`
    }
  }
  return 'sp'
}

/** 'body' and absent type are one thing; ctrTitle pairs with title. */
const normType = (t: string | undefined): string =>
  t === undefined || t === 'body' ? 'body' : t === 'ctrTitle' ? 'title' : t

const effIdx = (ph: XElem): string => attr(ph, 'idx') ?? '0'

/** Every placeholder-bearing shape in a layout/master tree, document order.
 *  A hand walker rather than three descendants() calls so mixed sp/pic
 *  candidates keep their order — first-match must mean first-in-document. */
function phCandidates(root: XElem): Array<{ el: XElem; ph: XElem }> {
  const out: Array<{ el: XElem; ph: XElem }> = []
  const walk = (e: XElem) => {
    for (const c of e.children) {
      if (typeof c === 'string') continue
      if (c.ns === NS.p && (c.local === 'sp' || c.local === 'pic' || c.local === 'graphicFrame')) {
        const ph = phOf(c)
        if (ph) out.push({ el: c, ph })
      }
      walk(c)
    }
  }
  walk(root)
  return out
}

function matchPh(root: XElem, want: XElem): { el: XElem; ph: XElem } | undefined {
  const cands = phCandidates(root)
  const idx = effIdx(want)
  for (const c of cands) if (effIdx(c.ph) === idx) return c
  const t = normType(attr(want, 'type'))
  for (const c of cands) if (normType(attr(c.ph, 'type')) === t) return c
  return undefined
}

/**
 * The chain with provenance labels: the shape itself, then the layout's
 * matching placeholder, then the master's. The master hop matches against the
 * LAYOUT's ph when one was found — that is where the type actually lives —
 * falling back to the slide's own ph when the layout is silent.
 */
export function labeledChain(sp: XElem, ctx: InheritCtx): ChainLink[] {
  const own = phOf(sp)
  const out: ChainLink[] = [own ? { el: sp, from: 'own', ph: own } : { el: sp, from: 'own' }]
  if (!own) return out
  let want = own
  if (ctx.layout) {
    const m = matchPh(ctx.layout, want)
    if (m) {
      out.push({ el: m.el, from: 'layout', ph: m.ph })
      want = m.ph
    }
  }
  if (ctx.master) {
    const m = matchPh(ctx.master, want)
    if (m) out.push({ el: m.el, from: 'master', ph: m.ph })
  }
  return out
}

/** The chain as bare elements — shape, layout match, master match. */
export function placeholderChain(sp: XElem, ctx: InheritCtx): XElem[] {
  return labeledChain(sp, ctx).map((l) => l.el)
}

/**
 * The placeholder type callers should reason with (and pass to textDefaults):
 * first explicit type along the chain — a bare slide ph inherits 'title' from
 * the layout side. '' = not a placeholder; typeless everywhere = 'body'.
 */
export function effectivePhType(sp: XElem, ctx: InheritCtx): string {
  const chain = labeledChain(sp, ctx)
  if (!chain[0].ph) return ''
  for (const link of chain) {
    const t = link.ph ? attr(link.ph, 'type') : undefined
    if (t) return t
  }
  return 'body'
}

// --- frame -------------------------------------------------------------------

export interface ResolvedFrame {
  x: number
  y: number
  w: number
  h: number
  /** degrees (xfrm rot is 60,000ths of a degree) */
  rotation: number
  flipH: boolean
  flipV: boolean
  from: Provenance
}

const flag = (v: string | undefined): boolean => v === '1' || v === 'true'

/** sp/pic keep xfrm under p:spPr; graphicFrame carries a bare p:xfrm. */
function xfrmOf(el: XElem): XElem | undefined {
  const spPr = kid(el, NS.p, 'spPr')
  if (spPr) {
    const x = kid(spPr, NS.a, 'xfrm')
    if (x) return x
  }
  return kid(el, NS.p, 'xfrm')
}

/**
 * The shape's frame in EMU (callers divide by EMU_PER_PX), from the first
 * chain level carrying a COMPLETE a:xfrm — off and ext both; a partial xfrm
 * pins nothing and mixing halves from two levels would fabricate a box no
 * file specifies. rot/flip ride with the winning xfrm for the same reason.
 * No xfrm anywhere is reported and returned as a zero frame, never invented.
 */
export function resolveFrame(sp: XElem, ctx: InheritCtx): ResolvedFrame {
  for (const link of labeledChain(sp, ctx)) {
    const x = xfrmOf(link.el)
    if (!x) continue
    const off = kid(x, NS.a, 'off')
    const ext = kid(x, NS.a, 'ext')
    if (!off || !ext) continue
    ctx.report.trace('frame', link.from)
    return {
      x: intAttr(off, 'x'),
      y: intAttr(off, 'y'),
      w: intAttr(ext, 'cx'),
      h: intAttr(ext, 'cy'),
      rotation: intAttr(x, 'rot') / 60000,
      flipH: flag(attr(x, 'flipH')),
      flipV: flag(attr(x, 'flipV')),
      from: link.from,
    }
  }
  ctx.report.add('dropped', 'frame-missing', whereOf(sp),
    'no a:xfrm on the shape, its layout placeholder or its master placeholder — emitted at 0,0 with zero size')
  ctx.report.trace('frame', 'default')
  return { x: 0, y: 0, w: 0, h: 0, rotation: 0, flipH: false, flipV: false, from: 'default' }
}

// --- text defaults -----------------------------------------------------------

export interface TextBullet {
  kind: 'none' | 'char' | 'autoNum'
  char?: string
  /** buFont typeface — read only from the SAME source as its buChar */
  font?: string
  /** buAutoNum numbering scheme, e.g. 'arabicPeriod' */
  scheme?: string
}

export interface TextDefaults {
  /** points (a:defRPr sz is centipoints: sz="1800" = 18pt) */
  fontSize: number
  bold: boolean
  /** typeface name, +mj-lt/+mn-lt already resolved through the theme */
  font: string
  /** the colour element (a:srgbClr/a:schemeClr/…) for theme.resolveColor */
  color?: XElem
  align: 'left' | 'center' | 'right'
  /** set when algn was something bento cannot say (just/dist) — align above
   *  is the left approximation, and the caller should report this */
  alignRaw?: string
  /** multiplier (a:lnSpc spcPct val="100000" = 1.0; spcPts converts via fontSize) */
  lineHeight: number
  /** presence only — bento has no paragraph spacing, callers report the drop */
  hasSpcBef: boolean
  hasSpcAft: boolean
  bullet: TextBullet
}

function lstStyleOf(shape: XElem): XElem | undefined {
  const tb = kid(shape, NS.p, 'txBody')
  return tb ? kid(tb, NS.a, 'lstStyle') : undefined
}

/**
 * Resolved paragraph + run defaults for one indent level (0-based here;
 * lvl1pPr..lvl9pPr in the XML). Sources, nearest first: the shape's own
 * lstStyle → layout placeholder lstStyle → master placeholder lstStyle →
 * master p:txStyles (titleStyle for title/ctrTitle, bodyStyle for
 * body/subTitle, otherStyle else — pass phType from effectivePhType) → hard
 * defaults (18pt, minor font, left; colour stays undefined for the caller's
 * default ink). Each property takes the FIRST source that speaks; levels
 * never borrow from other levels.
 *
 * THE PRECEDENCE TRAP, guarded by the rig: bullets resolve as one unit. A
 * buNone at a nearer level is a declaration that SILENCES an inherited
 * buChar — the first source carrying ANY of buNone/buAutoNum/buChar wins
 * whole, and buFont is only ever read beside its own buChar. A per-property
 * merge would resurrect the master's bullet under a shape that turned
 * bullets off (the census carries 4,542 a:buNone doing exactly that).
 */
export function textDefaults(sp: XElem, ctx: InheritCtx, level: number, phType: string): TextDefaults {
  const lvlName = `lvl${Math.min(Math.max(level, 0), 8) + 1}pPr`
  const srcs: Array<{ pPr: XElem; from: Provenance }> = []
  for (const link of labeledChain(sp, ctx)) {
    const style = lstStyleOf(link.el)
    const p = style ? kid(style, NS.a, lvlName) : undefined
    if (p) srcs.push({ pPr: p, from: link.from })
  }
  if (ctx.master) {
    const table = phType === 'title' || phType === 'ctrTitle' ? 'titleStyle'
      : phType === 'body' || phType === 'subTitle' ? 'bodyStyle' : 'otherStyle'
    const styles = kid(ctx.master, NS.p, 'txStyles')
    const tbl = styles ? kid(styles, NS.p, table) : undefined
    const p = tbl ? kid(tbl, NS.a, lvlName) : undefined
    if (p) srcs.push({ pPr: p, from: 'master' })
  }

  const first = <T>(get: (pPr: XElem) => T | undefined): { v: T; from: Provenance } | undefined => {
    for (const s of srcs) {
      const v = get(s.pPr)
      if (v !== undefined) return { v, from: s.from }
    }
    return undefined
  }
  const defRPr = (p: XElem) => kid(p, NS.a, 'defRPr')

  const szHit = first((p) => {
    const rp = defRPr(p)
    const v = rp ? attr(rp, 'sz') : undefined
    if (v === undefined) return undefined
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : undefined
  })
  const fontSize = szHit ? szHit.v / 100 : 18
  ctx.report.trace('font-size', szHit ? szHit.from : 'default')

  const bHit = first((p) => {
    const rp = defRPr(p)
    return rp ? attr(rp, 'b') : undefined
  })
  const bold = bHit ? flag(bHit.v) : false

  const fHit = first((p) => {
    const rp = defRPr(p)
    const lat = rp ? kid(rp, NS.a, 'latin') : undefined
    return lat ? attr(lat, 'typeface') : undefined
  })
  const raw = fHit ? fHit.v : '+mn-lt'
  const font = raw === '+mj-lt' ? ctx.theme.majorFont : raw === '+mn-lt' ? ctx.theme.minorFont : raw
  ctx.report.trace('font', fHit ? fHit.from : 'default')

  const cHit = first((p) => {
    const rp = defRPr(p)
    const sf = rp ? kid(rp, NS.a, 'solidFill') : undefined
    return sf ? kids(sf)[0] : undefined
  })
  ctx.report.trace('text-color', cHit ? cHit.from : 'default')

  const aHit = first((p) => attr(p, 'algn'))
  const algn = aHit?.v
  const align = algn === 'ctr' ? 'center' as const : algn === 'r' ? 'right' as const : 'left' as const

  const lHit = first((p) => kid(p, NS.a, 'lnSpc'))
  let lineHeight = 1
  if (lHit) {
    const pct = kid(lHit.v, NS.a, 'spcPct')
    const pts = kid(lHit.v, NS.a, 'spcPts')
    if (pct) lineHeight = intAttr(pct, 'val', 100000) / 100000
    else if (pts && fontSize > 0) lineHeight = intAttr(pts, 'val', fontSize * 100) / 100 / fontSize
  }

  const buHit = first<TextBullet>((p) => {
    if (kid(p, NS.a, 'buNone')) return { kind: 'none' }
    const auto = kid(p, NS.a, 'buAutoNum')
    if (auto) return { kind: 'autoNum', scheme: attr(auto, 'type') ?? 'arabicPeriod' }
    const ch = kid(p, NS.a, 'buChar')
    if (ch) {
      const out: TextBullet = { kind: 'char', char: attr(ch, 'char') ?? '•' }
      const bf = kid(p, NS.a, 'buFont')
      const face = bf ? attr(bf, 'typeface') : undefined
      if (face) out.font = face
      return out
    }
    return undefined
  })
  const bullet: TextBullet = buHit ? buHit.v : { kind: 'none' }
  ctx.report.trace('bullet', buHit ? buHit.from : 'default')

  const out: TextDefaults = {
    fontSize, bold, font, align, lineHeight,
    hasSpcBef: first((p) => kid(p, NS.a, 'spcBef')) !== undefined,
    hasSpcAft: first((p) => kid(p, NS.a, 'spcAft')) !== undefined,
    bullet,
  }
  if (cHit) out.color = cHit.v
  if (algn !== undefined && algn !== 'l' && algn !== 'ctr' && algn !== 'r') out.alignRaw = algn
  return out
}

// --- body insets -------------------------------------------------------------

export interface BodyInsets { l: number; t: number; r: number; b: number }

/**
 * Text-box insets in EMU from a:bodyPr, walked up the chain PER ATTRIBUTE (a
 * nearer bodyPr that only sets lIns does not reset the others). OOXML
 * defaults: 91440 left/right, 45720 top/bottom — the spike measured that
 * ignoring them silently costs every box ~19px of width, which then moves
 * every wrap point.
 */
export function bodyInsets(sp: XElem, ctx: InheritCtx): BodyInsets {
  const bodies: XElem[] = []
  for (const link of labeledChain(sp, ctx)) {
    const tb = kid(link.el, NS.p, 'txBody')
    const bp = tb ? kid(tb, NS.a, 'bodyPr') : undefined
    if (bp) bodies.push(bp)
  }
  const pick = (name: string, dflt: number): number => {
    for (const bp of bodies) {
      const v = attr(bp, name)
      if (v !== undefined) {
        const n = parseInt(v, 10)
        if (Number.isFinite(n)) return n
      }
    }
    return dflt
  }
  return {
    l: pick('lIns', 91440),
    t: pick('tIns', 45720),
    r: pick('rIns', 91440),
    b: pick('bIns', 45720),
  }
}
