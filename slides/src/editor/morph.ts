// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Morph pairing, made visible in the editor.
//
// A morph pairs elements by key (model.ts morphKey) between the slide the show
// arrives FROM and a slide whose transition is 'morph' — present.ts runMorph.
// In the editor that pairing was invisible: you found out in the show. This
// file answers "which elements will travel, and from where" for three views:
// the ↔ badge on a layer row, the dashed ghost + curve on the canvas, and the
// Preview scrubber in the Animate tab. Nothing here writes the model.

import { inLinearFlow, morphKey, type BentoDoc, type Slide, type SlideElement } from '../model'
import { mixColor, shapePaintSteps } from '../present'
import { isFrame, morphClip } from '../layout'
import { fieldContext, renderElement } from '../render'

/** The slide the show morphs from into `slide`, or null when it does not
 *  morph: a state morphs from its parent, any other slide from the slide the
 *  linear walk shows before it (states and hidden slides are not on it). */
export function morphSource(doc: BentoDoc, slide: Slide): Slide | null {
  return slide.transition === 'morph' ? walkSource(doc, slide) : null
}

/** The slide the show arrives at `slide` from, whatever its transition: a
 *  state's parent, else the slide before it in the linear walk. */
export function walkSource(doc: BentoDoc, slide: Slide): Slide | null {
  if (slide.stateOf) return doc.slides.find((s) => s.id === slide.stateOf) ?? null
  const i = doc.slides.indexOf(slide)
  for (let j = i - 1; j >= 0; j--) if (inLinearFlow(doc.slides[j])) return doc.slides[j]
  return null
}

/** Pairs between `src` and `slide` by morph key, keyed by `slide`'s element id. */
function partnersFrom(src: Slide | null, slide: Slide): Map<string, SlideElement> {
  const out = new Map<string, SlideElement>()
  if (!src) return out
  const byKey = new Map(src.elements.map((e) => [morphKey(e), e]))
  for (const el of slide.elements) {
    const from = byKey.get(morphKey(el))
    if (from) out.set(el.id, from)
  }
  return out
}

/** Each element of `slide` that morphs from an element of the source, by id —
 *  the one answer the checkbox, the layer badge and the ghost all read. */
export function morphPartners(doc: BentoDoc, slide: Slide): Map<string, SlideElement> {
  return partnersFrom(morphSource(doc, slide), slide)
}

/** The pairs `slide` WOULD morph if its transition were Morph. */
export function wouldPair(doc: BentoDoc, slide: Slide): Map<string, SlideElement> {
  return partnersFrom(walkSource(doc, slide), slide)
}

/** Ids on `slide` that morph from the slide before — the layer badges. */
export function morphPairs(doc: BentoDoc, slide: Slide): Set<string> {
  return new Set(morphPartners(doc, slide).keys())
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** The paint the show tweens on a pair — a shape's fill and stroke layers,
 *  gradients included (the show's own steppers), a text's colour — at `t`. */
function previewColours(node: HTMLElement, from: SlideElement, el: SlideElement, t: number) {
  if (from.type === 'shape' && el.type === 'shape') {
    const svg = node.querySelector(':scope > svg')
    if (svg) for (const step of shapePaintSteps(svg, from, el)) step(t)
  }
  if (from.type === 'text' && el.type === 'text' && from.color !== el.color) {
    const inner = node.querySelector<HTMLElement>('.bento-text-inner')
    if (inner) inner.style.color = mixColor(from.color, el.color, t)
  }
}

/**
 * The editor canvas at `t` of the way through the morph (0 = the source
 * slide's frames, 1 = this slide's): paired elements are moved and scaled
 * about their top-left as the show does (translate + scale, PowerPoint's
 * scale mode), unpaired ones fade in. Pure DOM on the rendered nodes; the
 * caller re-renders to restore.
 * Solid fills, strokes and text colours mix as the show mixes them.
 */
export function applyMorphPreview(surface: HTMLElement, doc: BentoDoc, slide: Slide, t: number) {
  const pairs = morphPartners(doc, slide)
  const byId = new Map(slide.elements.map((e) => [e.id, e]))
  // what leaves: source elements nothing here pairs with fade out, drawn over
  // the slide the way the show cross-fades them (removed by the re-render)
  const src = morphSource(doc, slide)
  const kept = new Set([...pairs.values()].map((e) => e.id))
  for (const gone of src?.elements ?? []) {
    if (kept.has(gone.id) || gone.hidden) continue
    let node = surface.querySelector<HTMLElement>(`[data-morph-leaving="${CSS.escape(gone.id)}"]`)
    if (!node) {
      node = renderElement(gone, doc, { fields: fieldContext(doc, src!) })
      node.removeAttribute('data-el-id')
      node.dataset.morphLeaving = gone.id
      node.style.pointerEvents = 'none'
      surface.appendChild(node)
    }
    node.style.opacity = String(gone.opacity * (1 - t))
  }
  for (const el of slide.elements) {
    const node = surface.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
    if (!node) continue
    const from = pairs.get(el.id)
    if (!from) { node.style.opacity = String(el.opacity * t); continue }
    const x = lerp(from.x, el.x, t), y = lerp(from.y, el.y, t)
    const sx = el.w ? lerp(from.w, el.w, t) / el.w : 1
    const sy = el.h ? lerp(from.h, el.h, t) / el.h : 1
    const r = lerp(from.rotation ?? 0, el.rotation ?? 0, t)
    // the show's own transform (present.ts runMorph): top-left scale, rotation about the resting centre
    const cx = el.w / 2, cy = el.h / 2
    node.style.transformOrigin = '0 0'
    node.style.transform = `translate(${x - el.x}px, ${y - el.y}px) scale(${sx}, ${sy})` +
      (r ? ` translate(${cx}px, ${cy}px) rotate(${r}deg) translate(${-cx}px, ${-cy}px)` : '')
    node.style.opacity = String(lerp(from.opacity, el.opacity, t))
    // a child of a clipping frame stays clipped by the frame as both travel
    const f = el.parentId ? byId.get(el.parentId) : undefined
    if (isFrame(f) && f.layout.clip) {
      const ff = pairs.get(f.id) ?? f
      node.style.clipPath = morphClip(
        { x: lerp(ff.x, f.x, t), y: lerp(ff.y, f.y, t), w: lerp(ff.w, f.w, t), h: lerp(ff.h, f.h, t) },
        x, y, sx, sy, r, el.w, el.h)
    }
    previewColours(node, from, el, t)
  }
}

/** The dashed ghost of `el`'s source frame and the curve it travels along,
 *  as an svg in slide coordinates; null when it does not morph. */
export function morphGhost(doc: BentoDoc, slide: Slide, el: SlideElement, scale: number): SVGSVGElement | null {
  const from = morphPartners(doc, slide).get(el.id)
  if (!from) return null
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'ed-morph-ghost')
  svg.setAttribute('width', String(doc.size.width))
  svg.setAttribute('height', String(doc.size.height))
  const inv = 1 / (scale || 1)
  const rect = document.createElementNS(NS, 'rect')
  for (const [k, v] of Object.entries({ x: from.x, y: from.y, width: from.w, height: from.h })) rect.setAttribute(k, String(v))
  if (from.rotation) rect.setAttribute('transform', `rotate(${from.rotation} ${from.x + from.w / 2} ${from.y + from.h / 2})`)
  const a = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
  const b = { x: el.x + el.w / 2, y: el.y + el.h / 2 }
  // a gentle arc: control points pulled off the straight line, perpendicular to it
  const dx = b.x - a.x, dy = b.y - a.y
  const bow = 0.2
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', `M${a.x} ${a.y} C${a.x + dx / 3 - dy * bow} ${a.y + dy / 3 + dx * bow} ${a.x + (2 * dx) / 3 - dy * bow} ${a.y + (2 * dy) / 3 + dx * bow} ${b.x} ${b.y}`)
  for (const n of [rect, path]) {
    n.setAttribute('stroke-width', String(1.5 * inv))
    n.setAttribute('stroke-dasharray', `${5 * inv} ${4 * inv}`)
  }
  svg.append(rect, path)
  return svg
}
