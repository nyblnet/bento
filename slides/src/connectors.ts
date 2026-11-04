// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Connector routing — pure model work, no DOM, so the boot path (main.ts) and
// the rigs can run it without the editor (#493). The editor re-routes through
// it on every 'doc' event; lineedit.ts re-exports the path-endpoint helpers so
// its import sites are unchanged.

import type { ShapeElement, Slide } from './model'
import { movePathEnds, pathEnds } from './tips.ts'
import { boxCenter, connectorEndpoint, lineEndpoints, setLineEndpoints, type Pt } from '../../kernel/src/geom.ts'

const rnd = (v: number) => Math.round(v * 100) / 100

/** First and last on-curve points of an open path shape, in slide coords —
 *  exact (parsed, not sampled), for connector re-routing. */
export function pathEndpoints(el: ShapeElement): [Pt, Pt] | null {
  const ends = pathEnds(el.d ?? '')
  if (!ends) return null
  const [px, py, pw, ph] = el.pathBox ?? [0, 0, el.w || 1, el.h || 1]
  const sx = el.w / (pw || 1)
  const sy = el.h / (ph || 1)
  const out = (p: Pt): Pt => ({ x: el.x + (p.x - px) * sx, y: el.y + (p.y - py) * sy })
  return [out(ends[0]), out(ends[1])]
}

/** Move an open path's ends to new slide-coord points (connector re-route,
 *  #302): interior anchors keep their positions exactly; the box and pathBox
 *  are renormalised to the on-curve points, the way setPathAnchors does. */
export function setPathEndpoints(el: ShapeElement, a: Pt, b: Pt): void {
  const [px, py, pw, ph] = el.pathBox ?? [0, 0, el.w || 1, el.h || 1]
  const sx = el.w / (pw || 1)
  const sy = el.h / (ph || 1)
  // slide → current path units
  const toPath = (p: Pt): Pt => ({ x: px + (p.x - el.x) / sx, y: py + (p.y - el.y) / sy })
  const moved = movePathEnds(el.d ?? '', toPath(a), toPath(b))
  // renormalise: pathBox [0,0,w,h] over the on-curve points, at scale 1
  const nodes = parseBezierPoints(moved)
  if (!nodes.length) return
  const abs = nodes.map((p) => ({ x: el.x + (p.x - px) * sx, y: el.y + (p.y - py) * sy }))
  const minX = Math.min(...abs.map((p) => p.x))
  const minY = Math.min(...abs.map((p) => p.y))
  const w = Math.max(Math.max(...abs.map((p) => p.x)) - minX, 1)
  const h = Math.max(Math.max(...abs.map((p) => p.y)) - minY, 1)
  // re-express every coordinate (points AND handles) in the new box
  const re = moved.replace(/-?\d*\.?\d+(?:e-?\d+)?/g, (() => {
    let i = 0
    return (tok: string) => {
      const v = Number(tok)
      const isX = i++ % 2 === 0
      const s = isX ? rnd(el.x + (v - px) * sx - minX) : rnd(el.y + (v - py) * sy - minY)
      return String(s)
    }
  })())
  el.x = minX
  el.y = minY
  el.w = w
  el.h = h
  el.pathBox = [0, 0, w, h]
  el.d = re
}

/**
 * Route one slide's connectors — line and open-path shapes anchored to
 * elements by from/to — onto their elements' borders, in place. Returns true
 * if anything moved (or a dangling ref was dropped).
 *
 * DERIVED, never committed: every replica computes the same endpoints from the
 * element boxes, so it is never an edit, never dirties the deck and never makes
 * an undo step. A line moves its two endpoints; a curve (#302) moves its
 * first/last anchor and keeps every interior point (tips.movePathEnds).
 * Pure model work — no DOM — so the boot path routes a whole deck with it
 * before anything renders (#493: a file authored outside the editor arrives
 * with refs but stale endpoints, and nothing else would ever route it).
 */
export function routeConnectors(slide: Slide): boolean {
  const byId = new Map(slide.elements.map((e) => [e.id, e]))
  let changed = false
  for (const el of slide.elements) {
    if (el.type !== 'shape' || (el.shape !== 'line' && el.shape !== 'path')) continue
    const c = el as ShapeElement
    if (!c.from && !c.to) continue
    if (c.from && !byId.has(c.from.el)) { delete c.from; changed = true }
    if (c.to && !byId.has(c.to.el)) { delete c.to; changed = true }
    if (!c.from && !c.to) continue
    const isPath = c.shape === 'path'
    const pathEnds = isPath ? pathEndpoints(c) : null
    if (isPath && !pathEnds) continue
    const [a, b] = isPath ? pathEnds! : lineEndpoints(c)
    const fromBox = c.from ? byId.get(c.from.el) : null
    const toBox = c.to ? byId.get(c.to.el) : null
    // explicit side → pin to that side's midpoint; 'auto' → ride the border
    // toward the other end (kernel geom: connectorEndpoint)
    const na = fromBox ? connectorEndpoint(fromBox, c.from?.side, toBox ? boxCenter(toBox) : b) : a
    const nb = toBox ? connectorEndpoint(toBox, c.to?.side, fromBox ? boxCenter(fromBox) : a) : b
    if (Math.hypot(na.x - a.x, na.y - a.y) > 0.5 || Math.hypot(nb.x - b.x, nb.y - b.y) > 0.5) {
      if (isPath) setPathEndpoints(c, na, nb)
      else setLineEndpoints(c, na, nb)
      changed = true
    }
  }
  return changed
}

/** Route every slide's connectors (and every layout's) — see routeConnectors. */
export function routeAllConnectors(doc: { slides: Slide[]; layouts?: Slide[] }): boolean {
  let changed = false
  for (const s of [...doc.slides, ...(doc.layouts ?? [])]) if (routeConnectors(s)) changed = true
  return changed
}

/** On-curve points of an M/C path string (path units). */
function parseBezierPoints(d: string): Pt[] {
  const out: Pt[] = []
  const re = /([MC])\s*((?:-?\d*\.?\d+(?:e-?\d+)?[\s,]*)+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(d))) {
    const nums = m[2].trim().split(/[\s,]+/).map(Number)
    if (m[1] === 'M') out.push({ x: nums[0], y: nums[1] })
    else out.push({ x: nums[4], y: nums[5] })
  }
  return out
}
