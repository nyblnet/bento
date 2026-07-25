// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
//
// Per-symbol ("manim style") morphing between two baked equations.
//
// The generic element morph in present.ts moves a whole box: it translates and
// scales the node from the outgoing frame to the incoming one. For a formula
// that reads as a crossfade of two pictures. What an audience wants to see is
// the SYMBOLS move — `a²` sliding across the `=` to the other side, a cancelled
// term fading out where it stood, a new factor appearing in place.
//
// That is only possible because a baked formula is stored as SVG MARKUP rather
// than an opaque <img>: every glyph is an addressable node carrying `data-c`
// (its unicode codepoint). The algorithm is:
//
//   1. Walk both formulas' markup, accumulating SVG transforms, to get a flat
//      list of glyph "atoms" — codepoint + outline + the exact matrix placing
//      it in SLIDE coordinates (derived from the element frame, so no DOM
//      measuring is needed; both frames are already in the document model,
//      which is the same discipline the rest of runMorph follows).
//   2. Pair atoms: author-supplied tag runs first (`data-bento-tag`, baked from
//      MathElement.morphTags), then a longest-common-subsequence diff over the
//      codepoint sequence for everything still unpaired.
//   3. Draw every atom as a plain <path> into one transient overlay SVG spanning
//      the slide, and tween each path's matrix. Paired atoms travel; dropped
//      atoms fade out where they were; new atoms fade in where they land.
//
// Working in an overlay (rather than transforming the live glyph nodes) keeps
// the real elements untouched, needs no id-scoping games, and means a failure
// anywhere degrades to "no overlay" — the caller falls back to the ordinary box
// morph and nothing is worse than before.

import { anim } from './anim'
import type { MathElement } from './model'
import { mathAlignX } from './render'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 2D affine matrix, SVG order: [a, b, c, d, e, f]. */
type Mat = [number, number, number, number, number, number]

const IDENT: Mat = [1, 0, 0, 1, 0, 0]

function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

/** Parse an SVG `transform` attribute (the translate/scale/matrix subset
 *  MathJax emits) into a single matrix. */
function parseTransform(src: string | null): Mat {
  if (!src) return IDENT
  let out = IDENT
  const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const n = m[2].split(/[\s,]+/).filter(Boolean).map(Number)
    if (n.some((v) => !Number.isFinite(v))) continue
    switch (m[1]) {
      case 'matrix':
        if (n.length === 6) out = mul(out, n as unknown as Mat)
        break
      case 'translate':
        out = mul(out, [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0])
        break
      case 'scale':
        out = mul(out, [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0])
        break
      case 'rotate': {
        const r = ((n[0] ?? 0) * Math.PI) / 180
        const cos = Math.cos(r)
        const sin = Math.sin(r)
        // rotate(a, cx, cy) — translate to the pivot, rotate, translate back
        if (n.length >= 3) out = mul(out, [1, 0, 0, 1, n[1], n[2]])
        out = mul(out, [cos, sin, -sin, cos, 0, 0])
        if (n.length >= 3) out = mul(out, [1, 0, 0, 1, -n[1], -n[2]])
        break
      }
    }
  }
  return out
}

/** Rotation by `deg` about a pivot, in slide coordinates. */
function rotateAbout(deg: number, cx: number, cy: number): Mat {
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return mul(mul([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]), [1, 0, 0, 1, -cx, -cy])
}

/** One drawable glyph: its outline, where it sits, and how to pair it. */
interface Atom {
  /** unicode codepoint hex from `data-c` — the identity used for matching */
  c: string
  /** path outline data */
  d: string
  /** glyph-space → slide-space matrix */
  m: Mat
  /** optional author tag (`data-bento-tag`) — pairs before the LCS pass */
  tag?: string
}

interface Frame { x: number; y: number; w: number; h: number }

/** A glyph reference, whatever prefix the markup happens to use. Baking
 *  normalizes these to plain `href`, but decks baked by an older build (or by
 *  a serializer that invented a prefix) must still resolve. */
function hrefOf(el: Element): string {
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.toLowerCase().replace(/^[^:]*:/, '') === 'href') return attr.value
  }
  return ''
}

/**
 * Reproduce the `<preserveAspectRatio> meet` viewBox mapping render.ts applies
 * (the SVG is sized `width:100%;height:100%` inside the element box), as a
 * matrix taking viewBox coordinates to slide coordinates.
 *
 * `alignX` must match what render.ts wrote on the node — it is derived from the
 * same `mathAlignX` helper, which is why that one is exported.
 */
function viewBoxToSlide(svg: SVGSVGElement, frame: Frame, alignX: 'xMin' | 'xMid' | 'xMax'): Mat | null {
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).filter(Boolean).map(Number)
  if (vb.length !== 4 || vb.some((v) => !Number.isFinite(v))) return null
  const [minX, minY, vw, vh] = vb
  if (vw <= 0 || vh <= 0) return null
  const k = Math.min(frame.w / vw, frame.h / vh)
  const slack = frame.w - vw * k
  const dx = frame.x + (alignX === 'xMin' ? 0 : alignX === 'xMax' ? slack : slack / 2)
  const dy = frame.y + (frame.h - vh * k) / 2 // always YMid
  // translate(dx,dy) · scale(k) · translate(-minX,-minY)
  return mul(mul([1, 0, 0, 1, dx, dy], [k, 0, 0, k, 0, 0]), [1, 0, 0, 1, -minX, -minY])
}

/**
 * Flatten one baked formula into positioned glyph atoms.
 * Returns null when the markup is not a usable MathJax SVG — callers then fall
 * back to the ordinary box morph.
 */
export function glyphAtoms(el: MathElement, frame: Frame): Atom[] | null {
  if (!el.baked) return null
  // Parsed as HTML, deliberately. Strict XML parsing rejects the whole document
  // on any well-formedness slip — a stray duplicate xmlns from whichever
  // serializer baked the deck is enough — and a rejected parse would silently
  // downgrade every formula to a box morph. The HTML parser is lenient, applies
  // the SVG foreign-content rules (so `viewBox` keeps its casing), and is the
  // same path sanitizeMath already takes.
  let svg: SVGSVGElement | null
  try {
    const tpl = document.createElement('template')
    tpl.innerHTML = el.baked
    svg = tpl.content.querySelector('svg')
  } catch {
    return null
  }
  if (!svg) return null

  const root = viewBoxToSlide(svg, frame, mathAlignX(el.align || 'center'))
  if (!root) return null

  // glyph outlines live in <defs> and are referenced by <use href="#id">
  const paths = new Map<string, string>()
  svg.querySelectorAll('path[id]').forEach((p) => {
    const d = p.getAttribute('d')
    if (d) paths.set(p.getAttribute('id')!, d)
  })

  const atoms: Atom[] = []
  let bail = false
  const walk = (node: Element, acc: Mat, tag: string | undefined) => {
    for (const child of Array.from(node.children)) {
      if (bail) return
      const name = child.tagName.toLowerCase()
      if (name === 'defs') continue
      const here = mul(acc, parseTransform(child.getAttribute('transform')))
      const childTag = child.getAttribute('data-bento-tag') || tag
      if (name === 'use') {
        const href = hrefOf(child)
        const d = paths.get(href.replace(/^#/, ''))
        const c = child.getAttribute('data-c')
        if (d && c) atoms.push({ c, d, m: here, tag: childTag })
        continue
      }
      if (name === 'rect') {
        // MathJax draws fraction bars, radicals and \overline as filled rects;
        // synthesize an outline so they travel with everything else.
        // The identity below is the rounded SIZE, so a bar only pairs with one
        // of the same width: a fraction whose numerator gains a term gets a
        // wider bar, and that bar fades out/in while the symbols around it
        // travel. Pairing bars of different widths instead would tween a
        // rectangle into a visibly different rectangle, which reads worse than
        // the fade — so this stays deliberate, not an oversight.
        const x = Number(child.getAttribute('x') || 0)
        const y = Number(child.getAttribute('y') || 0)
        const w = Number(child.getAttribute('width') || 0)
        const h = Number(child.getAttribute('height') || 0)
        if (w > 0 && h > 0) {
          atoms.push({
            c: `rect:${Math.round(w)}x${Math.round(h)}`,
            d: `M${x} ${y}h${w}v${h}h${-w}Z`,
            m: here,
            tag: childTag,
          })
        }
        continue
      }
      // A drawable this walker cannot turn into an atom. That is NOT survivable
      // by ignoring it: the real element is hidden for the whole morph, so ink
      // missing from the overlay simply vanishes mid-transition. Give up and let
      // the caller fall back to the box morph, which is always correct.
      if (UNSUPPORTED.has(name)) { bail = true; return }
      walk(child, here, childTag)
    }
  }
  walk(svg, root, undefined)
  if (bail) return null
  return atoms.length ? atoms : null
}

/** Ink-producing SVG elements with no atom representation. `path` counts: glyph
 *  outlines live in <defs> (skipped above) and are drawn via <use>, so a path
 *  reached by the walk is a directly-drawn mark — what MathJax emits when it is
 *  configured with fontCache:'none' rather than our 'local'. */
const UNSUPPORTED = new Set([
  'path', 'line', 'polygon', 'polyline', 'circle', 'ellipse', 'text', 'image', 'foreignobject',
])

/**
 * Pair atoms between two formulas.
 *
 * Author tags win: glyphs the author marked with the same tag on both sides are
 * zipped in order, so "this term becomes that term" survives even when the
 * shapes share no characters. Everything left over is matched by a longest
 * common subsequence over codepoints, which is what makes the common case —
 * rearranging an equation — line up with no authoring at all, and then by a
 * greedy nearest-first pass that catches the symbols LCS had to drop.
 */
export function pairAtoms(a: Atom[], b: Atom[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  const usedA = new Set<number>()
  const usedB = new Set<number>()

  const byTag = (list: Atom[]) => {
    const m = new Map<string, number[]>()
    list.forEach((at, i) => {
      if (!at.tag) return
      const arr = m.get(at.tag)
      if (arr) arr.push(i)
      else m.set(at.tag, [i])
    })
    return m
  }
  const tagsA = byTag(a)
  const tagsB = byTag(b)
  for (const [tag, idxA] of tagsA) {
    const idxB = tagsB.get(tag)
    if (!idxB) continue
    // zip positionally; a longer run on either side leaves the remainder to
    // fade, which reads correctly for "this expands into that"
    for (let i = 0; i < Math.min(idxA.length, idxB.length); i++) {
      pairs.push([idxA[i], idxB[i]])
      usedA.add(idxA[i])
      usedB.add(idxB[i])
    }
  }

  // LCS over the remaining codepoint sequences
  const ra = a.map((_, i) => i).filter((i) => !usedA.has(i))
  const rb = b.map((_, i) => i).filter((i) => !usedB.has(i))
  const n = ra.length
  const m = rb.length
  if (n && m) {
    // classic DP table; formulas are tens of glyphs, so this stays trivial
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[ra[i]].c === b[rb[j]].c
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[ra[i]].c === b[rb[j]].c) {
        pairs.push([ra[i], rb[j]])
        usedA.add(ra[i])
        usedB.add(rb[j])
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
      else j++
    }
  }

  // LCS is order-preserving, so symbols that SWAP sides can never both be kept:
  // in `a² + b² = c²` → `c² − b² = a²` it pairs the shared middle and gives up
  // on `a` and `c`, which would then fade out and in rather than trading places
  // — losing precisely the effect this whole module exists for. A final pass
  // therefore pairs the leftovers WITHOUT regard to order: still same-glyph
  // only (a codepoint never morphs into a different one — that would read as a
  // mistake, not a move), but greedy nearest-first, so each symbol travels to
  // the closest place the same symbol ends up. That is what makes a swap
  // visible. Distance is between the atoms' translation components, which is
  // where the glyph sits — the linear part is uniform scaling from the viewBox
  // mapping, so it cannot reorder the candidates.
  const leftA = a.map((_, i) => i).filter((i) => !usedA.has(i))
  const leftB = b.map((_, i) => i).filter((i) => !usedB.has(i))
  if (leftA.length && leftB.length) {
    const cand: Array<[number, number, number]> = []
    for (const i of leftA) {
      for (const j of leftB) {
        if (a[i].c !== b[j].c) continue
        const dx = a[i].m[4] - b[j].m[4]
        const dy = a[i].m[5] - b[j].m[5]
        cand.push([dx * dx + dy * dy, i, j])
      }
    }
    cand.sort((p, q) => p[0] - q[0])
    for (const [, i, j] of cand) {
      if (usedA.has(i) || usedB.has(j)) continue
      pairs.push([i, j])
      usedA.add(i)
      usedB.add(j)
    }
  }
  return pairs
}

export interface MathMorphOpts {
  duration: number
  ease: string
}

/**
 * Morph one baked equation into another, symbol by symbol.
 *
 * `toNode` is the incoming element's rendered node; `mount` is the slide-space
 * container both frames are expressed in. Returns a teardown function, or null
 * when the pair cannot be morphed this way (unbaked, unparseable, or nothing
 * matched) — the caller then leaves the element to the ordinary box morph.
 */
export function morphMath(
  from: MathElement,
  to: MathElement,
  toNode: HTMLElement,
  mount: HTMLElement,
  size: { width: number; height: number },
  opts: MathMorphOpts,
): (() => void) | null {
  // Each element IS its own frame — MathElement extends ElementBase, so it
  // already carries the {x,y,w,h} that glyphAtoms needs to place glyphs in
  // slide coordinates. Both sides come straight from the model; nothing is
  // measured off the DOM.
  const atomsA = glyphAtoms(from, from)
  const atomsB = glyphAtoms(to, to)
  if (!atomsA || !atomsB) return null

  const pairs = pairAtoms(atomsA, atomsB)
  if (!pairs.length) return null

  const inkFrom = from.color || '#1E2A3A'
  const inkTo = to.color || '#1E2A3A'
  // The overlay replaces the element for the duration, so it has to honour the
  // element's own opacity too — otherwise a half-faded equation pops to full
  // ink for the length of the morph and snaps back.
  const alphaFrom = from.opacity ?? 1
  const alphaTo = to.opacity ?? 1

  // Rotation is deliberately kept OUT of the atom matrices. Component-wise lerp
  // of two matrices — what the travel tween does — is exact for translate+scale
  // and ONLY for that: blend two rotations that way and 0°→180° passes through
  // the zero matrix (every glyph collapses to a point and re-expands mirrored),
  // 0°→90° through a 45° turn scaled by cos45°. So placement stays unrotated and
  // the turn is re-applied per frame about the interpolated centre — rigid at
  // every t, exact at both ends. The pivot is the box CENTRE because that is
  // what applyElementFrame uses at rest, and the overlay has to coincide with
  // the real element the instant it hands back.
  //
  // The angle is lerped LINEARLY rather than along the shortest arc, matching
  // runMorph — a rotated equation and a rotated rectangle on the same slide must
  // turn together. Change both or neither.
  const rotA = from.rotation ?? 0
  const rotB = to.rotation ?? 0
  const spin = rotA !== 0 || rotB !== 0
  const cAx = from.x + from.w / 2
  const cAy = from.y + from.h / 2
  const cBx = to.x + to.w / 2
  const cBy = to.y + to.h / 2
  const spinA = spin ? rotateAbout(rotA, cAx, cAy) : null
  const spinB = spin ? rotateAbout(rotB, cBx, cBy) : null

  const overlay = document.createElementNS(SVG_NS, 'svg')
  // Spans the whole slide so glyphs travelling between two element boxes are
  // never clipped by either one.
  overlay.setAttribute('class', 'bento-math-morph')
  overlay.style.cssText =
    'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:5'
  // The mount is the `.bento-slide` surface: exactly size.width × size.height
  // CSS px before Reveal's own scaling, so a 100%/100% overlay with a matching
  // viewBox maps 1:1 onto slide coordinates.
  overlay.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`)
  overlay.setAttribute('preserveAspectRatio', 'none')

  const matched = new Set<number>()
  const matchedB = new Set<number>()
  // Every tween target, so teardown can kill ALL of them. The travel tweens
  // drive plain state objects (not the nodes), so killing by node alone would
  // leave them ticking against a detached overlay after a fast slide change.
  const targets: unknown[] = []
  const setMat = (node: SVGElement, m: Mat) =>
    node.setAttribute('transform', `matrix(${m.map((v) => +v.toFixed(4)).join(' ')})`)

  const path = (d: string, m: Mat, fill: string, opacity: number) => {
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    p.setAttribute('fill', fill)
    p.setAttribute('stroke', 'none')
    p.style.opacity = String(opacity)
    setMat(p, m)
    overlay.appendChild(p)
    return p
  }

  // 1. paired glyphs travel from their old placement to their new one
  for (const [ia, ib] of pairs) {
    matched.add(ia)
    matchedB.add(ib)
    const A = atomsA[ia]
    const B = atomsB[ib]
    // Draw the INCOMING outline the whole way: the shapes are the same glyph,
    // and starting from the outgoing one would pop on any font-size change.
    const node = path(B.d, spinA ? mul(spinA, A.m) : A.m, inkFrom, alphaFrom)
    const state = { p: 0 }
    targets.push(node, state)
    anim.to(state, {
      p: 1,
      duration: opts.duration,
      ease: opts.ease,
      onUpdate() {
        const t = state.p
        const m = A.m.map((v, k) => v + (B.m[k] - v) * t) as Mat
        setMat(node, spin
          ? mul(rotateAbout(
              rotA + (rotB - rotA) * t,
              cAx + (cBx - cAx) * t,
              cAy + (cBy - cAy) * t,
            ), m)
          : m)
      },
    })
    // ink travels with the glyph — the `attr` channel interpolates colours
    if (inkFrom !== inkTo) {
      anim.fromTo(node, { attr: { fill: inkFrom } }, {
        attr: { fill: inkTo }, duration: opts.duration, ease: opts.ease,
      })
    }
    if (alphaFrom !== alphaTo) {
      anim.fromTo(node, { opacity: alphaFrom }, { opacity: alphaTo, duration: opts.duration, ease: opts.ease })
    }
  }

  // 2. dropped glyphs fade out where they stood
  atomsA.forEach((A, i) => {
    if (matched.has(i)) return
    const node = path(A.d, spinA ? mul(spinA, A.m) : A.m, inkFrom, alphaFrom)
    targets.push(node)
    anim.to(node, { opacity: 0, duration: opts.duration * 0.55, ease: 'power2.out' })
  })

  // 3. new glyphs fade in where they land, after the travellers have settled
  atomsB.forEach((B, i) => {
    if (matchedB.has(i)) return
    const node = path(B.d, spinB ? mul(spinB, B.m) : B.m, inkTo, 0)
    targets.push(node)
    anim.to(node, {
      opacity: alphaTo,
      duration: opts.duration * 0.5,
      delay: opts.duration * 0.5,
      ease: 'power2.out',
    })
  })

  // The real element stays hidden until the overlay finishes, then takes over.
  const inner = toNode.firstElementChild as HTMLElement | null
  if (inner) inner.style.visibility = 'hidden'
  mount.appendChild(overlay)

  let done = false
  const finish = () => {
    if (done) return
    done = true
    for (const t of targets) anim.killTweensOf(t)
    overlay.remove()
    if (inner) inner.style.visibility = ''
  }
  const timer = window.setTimeout(finish, opts.duration * 1000 + 60)
  return () => { window.clearTimeout(timer); finish() }
}

/** True when this pair should morph symbol-by-symbol rather than as a box. */
export function canMorphMath(a: unknown, b: unknown): a is MathElement {
  const ma = a as MathElement
  const mb = b as MathElement
  return !!ma && !!mb &&
    ma.type === 'math' && mb.type === 'math' &&
    ma.mode === 'equation' && mb.mode === 'equation' &&
    !!ma.baked && !!mb.baked &&
    // Hover-revealed elements are shown/hidden by writing opacity onto the
    // NODE (present.applyRevealSet), which the overlay knows nothing about — a
    // hidden formula would paint all its glyphs across the transition. The box
    // morph handles those correctly because it animates the node itself.
    !ma.showOnHover && !mb.showOnHover
}
