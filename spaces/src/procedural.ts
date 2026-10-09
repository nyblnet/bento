// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Procedural covers: what a page with no `cover` shows where a cover would go.
//
// A RENDER-TIME DEFAULT, NEVER DOCUMENT DATA. Nothing here is written into the
// file: `page.cover` absent stays absent, an older build sees exactly what it
// saw before (no cover), and the bytes of a saved space do not change by one.
// The gallery already did this for its coverless cards — a tinted panel on a
// hue derived from the page id — and this is that idea carried one step
// further: a gradient plus a geometric figure, seeded from the same id.
//
// DETERMINISTIC FROM THE ID, for the reason the gallery hue is and the reason
// repaired ids come from the id rather than from Math.random: every reader of
// one file, on every machine, on every reload, sees the same cover on the same
// page. A page keeps its cover when it is renamed and loses it only when it
// gains a real one. Two calls with one id return the same string, byte for
// byte; the model rig asserts it.
//
// WHERE IT DRAWS, AND WHERE IT DELIBERATELY DOES NOT. Two surfaces, both of
// which already single a page out:
//   · every coverless card in a GALLERY — the surface that exists so a set of
//     pages reads as a set of distinct things, and the one that already drew a
//     procedural tint there;
//   · the HOME page in the page view — the one page the format itself names
//     (`doc.home`), the page a reader lands on, the front door.
// NOT every page. A cover is a full-bleed band of 150–320px that pushes the
// title down and lifts the icon into a disc; on a space of two hundred plain
// notes that is two hundred posters, and a daily journal entry under a banner
// is wrong in a way no restraint in the artwork fixes. The gallery hue was
// accepted precisely because it is a card in a grid; the same figure at the
// top of every note would be the loud default this rule exists to refuse.
// Opt-in per page would need a field, which is a format change for a thing that
// is not document data; so the surfaces are chosen structurally instead.
//
// NEVER ON PAPER, NEVER IN THE THUMBNAIL. Both go through `printing: true`
// and the renderer draws nothing procedural under it. Print: 5cm of toner for
// a figure nobody chose. The preview (preview.ts) is a still of the AUTHOR's
// document for a file manager, and a default the app invents is not in that
// document — the same reason the gallery's tint was never in it either, and
// it keeps every saved file from growing by the SVG on each save.
//
// RESTRAINED BY CONSTRUCTION. The gradient is the gallery's existing tint
// exactly (hue → hue+40°, at the same alphas) and the figure sits on it at
// 6–14% alpha, in the same two hues. Everything is ALPHA over the surface's
// own ground (`--chrome-2`), which is what makes one SVG right in both themes:
// a pale wash on the light ground and a muted one on the dark, as the gallery
// card already is. No hard edge in the figure exceeds the tint the card had.

import { type SpacesDoc, type Page, coverSrc, homePage } from './model.ts'

/** Eight stops, spaced around the wheel and chosen to be distinguishable at
 *  30% alpha on both grounds — see `hueOf`. */
export const CARD_HUES = [210, 265, 320, 8, 32, 48, 152, 186]

/** FNV-1a over the id: the same cheap hash assets.ts falls back to. */
export function hashId(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}

/**
 * A stable hue for a page with no cover.
 *
 * A CURATED SET, not 360 free hues. Free hue was measured drawing 61 and 54 in
 * the same grid — the same dirty chartreuse twice — and five cards as
 * peach/pink/pink/lavender/lavender: two near-duplicate pairs out of five. It
 * also lands on olive and mustard, which no amount of alpha rescues, and goes
 * muddy in the dark theme. Neighbours in a grid differ because the stops
 * differ, not because the hash happened to spread.
 */
export function hueOf(id: string): number {
  return CARD_HUES[hashId(id) % CARD_HUES.length]
}

/** mulberry32: a 32-bit seed in, the same sequence out on every engine. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fixed-point to one decimal, so the string is short and never locale-shaped. */
const n = (v: number): string => String(Math.round(v * 10) / 10)
/** …and two for an alpha, where one decimal would flatten 0.07 and 0.14 alike. */
const a = (v: number): string => String(Math.round(v * 100) / 100)

/** `hsl(h,s%,l%)` — the comma form, which every SVG presentation attribute
 *  parser accepts; alpha travels separately as `fill-opacity`. */
const hsl = (h: number, s: number, l: number): string => `hsl(${n(h)},${n(s)}%,${n(l)}%)`

/** The two surfaces, and the one number that differs between them: the page
 *  cover is a larger, less busy field with a white disc riding its lower edge,
 *  so its wash is a step stronger than the card's — measured, not guessed
 *  (see the contrast numbers in the changelog). */
export type CoverSurface = 'card' | 'page'

export const VIEW_W = 600
export const VIEW_H = 240

/**
 * The SVG for a page with no cover, as a string.
 *
 * A string rather than an element so the model rig can pin its properties in
 * plain node, and so the renderer inserts it with one `innerHTML` on a wrapper
 * it created itself. Nothing in the string comes from the document except the
 * id, and the id only ever reaches it as a number.
 */
export function proceduralCoverSvg(id: string, surface: CoverSurface = 'card'): string {
  const seed = hashId(id)
  const h = hueOf(id)
  const h2 = (h + 40) % 360
  const r = rng(seed)
  const page = surface === 'page'
  // the gallery's own two stops, verbatim; the page wash one step stronger
  const a1 = page ? 0.44 : 0.30
  const a2 = page ? 0.26 : 0.16
  const gid = `sp-g${seed.toString(36)}`

  const parts: string[] = []
  parts.push(
    `<svg class="sp-gen" viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="xMidYMid slice" ` +
    `aria-hidden="true" focusable="false">`,
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${hsl(h, 62, 62)}" stop-opacity="${a(a1)}"/>` +
    `<stop offset="1" stop-color="${hsl(h2, 62, 58)}" stop-opacity="${a(a2)}"/>` +
    `</linearGradient></defs>`,
    `<rect width="${VIEW_W}" height="${VIEW_H}" fill="url(#${gid})"/>`,
  )

  // THE FIGURE. Six families; the seed picks one and then places it. Every
  // figure is a handful of elements — a lattice goes through <pattern> so a
  // field of dots costs two elements, not a hundred and sixty.
  const ink = (i: number) => hsl(i % 2 ? h2 : h, 58, 44)
  const fig = Math.floor(r() * 6)
  const W = VIEW_W, H = VIEW_H
  if (fig === 0) {
    // orbs: three to five discs, large, overlapping the edges
    const k = 3 + Math.floor(r() * 3)
    for (let i = 0; i < k; i++) {
      const cx = r() * W, cy = r() * H, rad = 50 + r() * 100
      parts.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(rad)}" fill="${ink(i)}" fill-opacity="${a(0.06 + r() * 0.06)}"/>`)
    }
  } else if (fig === 1) {
    // bands: a rotated group of four to six stripes
    const ang = -50 + r() * 100
    const k = 4 + Math.floor(r() * 3)
    parts.push(`<g transform="rotate(${n(ang)} ${W / 2} ${H / 2})">`)
    let x = -W * 0.4 + r() * 80
    for (let i = 0; i < k; i++) {
      const w = 18 + r() * 60
      parts.push(`<rect x="${n(x)}" y="-${H}" width="${n(w)}" height="${H * 3}" fill="${ink(i)}" fill-opacity="${a(0.07 + r() * 0.06)}"/>`)
      x += w + 30 + r() * 90
    }
    parts.push('</g>')
  } else if (fig === 2) {
    // lattice: a dot field through <pattern>, and one disc to anchor it
    const step = 22 + Math.floor(r() * 14)
    const pid = `${gid}p`
    parts.push(
      `<defs><pattern id="${pid}" width="${step}" height="${step}" patternUnits="userSpaceOnUse">` +
      `<circle cx="${step / 2}" cy="${step / 2}" r="${n(1.6 + r() * 1.6)}" fill="${ink(0)}" fill-opacity="0.2"/>` +
      `</pattern></defs>`,
      `<rect width="${W}" height="${H}" fill="url(#${pid})"/>`,
      `<circle cx="${n(W * (0.55 + r() * 0.35))}" cy="${n(H * (0.2 + r() * 0.6))}" r="${n(60 + r() * 60)}" fill="${ink(1)}" fill-opacity="${a(0.08 + r() * 0.05)}"/>`,
    )
  } else if (fig === 3) {
    // rings: concentric strokes from a point near one corner
    const cx = r() < 0.5 ? r() * W * 0.3 : W - r() * W * 0.3
    const cy = r() < 0.5 ? r() * H * 0.3 : H - r() * H * 0.3
    const k = 4 + Math.floor(r() * 3)
    const gap = 26 + r() * 22
    for (let i = 0; i < k; i++) {
      parts.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(gap * (i + 1))}" fill="none" stroke="${ink(i)}" stroke-width="${n(6 + r() * 8)}" stroke-opacity="${a(0.08 + r() * 0.06)}"/>`)
    }
  } else if (fig === 4) {
    // facets: three or four triangles fanned from the edges
    const k = 3 + Math.floor(r() * 2)
    for (let i = 0; i < k; i++) {
      const x0 = r() * W, y0 = r() < 0.5 ? -20 : H + 20
      const x1 = r() * W, y1 = r() * H
      const x2 = r() * W, y2 = r() < 0.5 ? -20 : H + 20
      parts.push(`<polygon points="${n(x0)},${n(y0)} ${n(x1)},${n(y1)} ${n(x2)},${n(y2)}" fill="${ink(i)}" fill-opacity="${a(0.06 + r() * 0.06)}"/>`)
    }
  } else {
    // waves: three stacked curves filled to the bottom edge
    const k = 3
    for (let i = 0; i < k; i++) {
      const base = H * (0.45 + i * 0.16) + r() * 20
      const amp = 16 + r() * 26
      const c1 = W * (0.2 + r() * 0.2), c2 = W * (0.6 + r() * 0.2)
      parts.push(
        `<path d="M0,${n(base)} C${n(c1)},${n(base - amp)} ${n(c2)},${n(base + amp)} ${W},${n(base - amp * 0.5)} ` +
        `L${W},${H} L0,${H} Z" fill="${ink(i)}" fill-opacity="${a(0.07 + r() * 0.05)}"/>`,
      )
    }
  }
  parts.push('</svg>')
  return parts.join('')
}

/**
 * THE DECISION, as one pure function: the SVG for this page in the page view,
 * or '' when it must draw nothing. render.ts asks this and nothing else, so
 * the rig can pin every branch without a DOM:
 *   · a page with a usable cover of its own draws no procedural one;
 *   · only the home page gets one (the argument is at the top of this file);
 *   · nothing procedural under `printing` — paper and the thumbnail.
 * A REMOTE cover counts as none: coverSrc refuses it (PLATFORM §1), so the
 * page renders coverless today and is treated as coverless here.
 */
export function proceduralCoverFor(page: Page, doc: SpacesDoc, printing: boolean): string {
  if (printing) return ''
  if (coverSrc(page)) return ''
  if (homePage(doc)?.id !== page.id) return ''
  return proceduralCoverSvg(page.id, 'page')
}
