// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Shared fixture machinery for the bento-sync rigs.
//
// Extracted VERBATIM from scripts/test-sync.ts so the convergence rig
// (test-sync.ts) and the equivalence rig (test-sync-equiv.ts) generate the
// SAME documents and the SAME mutations from the same seed. Two rigs with two
// generators would be two different opinions about what "an edit" is, and the
// equivalence rig's whole job is to be the convergence rig's stricter twin.
//
// Engine-free on purpose: nothing here imports crdt.ts, because the
// equivalence rig loads TWO engines and neither may be baked into a fixture.

export type Doc = any

/** Anything the mutation generator needs from a replica. */
export interface Mutator {
  actor: string
  counter: number
}

/** deterministic PRNG */
export function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/** key-order-independent serialization (for "same value, different bytes") */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

export function baseDoc(): Doc {
  return {
    format: 'bento/slides',
    version: 1,
    docId: 'doc-1',
    title: 'Rig deck',
    size: { width: 1600, height: 900 },
    theme: { background: '#0D1B2E', color: '#F2F0EA', accent: '#FF9E8A', fontFamily: 'x' },
    assets: { logo: '<svg/>' },
    slides: [
      {
        id: 's1',
        background: '#0D1B2E',
        transition: 'none',
        notes: '',
        elements: [
          { id: 's1-t1', type: 'text', x: 100, y: 100, w: 600, h: 80, rotation: 0, opacity: 1, html: 'Hello <b>world</b>', fontSize: 40, fontFamily: 'x', fontWeight: 700, color: '#fff', align: 'left', valign: 'top', lineHeight: 1.2 },
          { id: 's1-r1', type: 'shape', shape: 'rect', x: 200, y: 300, w: 200, h: 120, rotation: 0, opacity: 1, fill: '#FF9E8A', stroke: 'none', strokeWidth: 0, radius: 8 },
          { id: 's1-r2', type: 'shape', shape: 'ellipse', x: 500, y: 300, w: 90, h: 90, rotation: 0, opacity: 1, fill: '#5E7699', stroke: 'none', strokeWidth: 0, radius: 0 },
          // 'cast' appears on s1 AND s2 — the id-continuity morph idiom
          // (starterdeck's sd-tile-*). Every random run exercises it.
          { id: 'cast', type: 'text', x: 900, y: 100, w: 300, h: 60, rotation: 0, opacity: 1, html: 'Morph <b>me</b>', fontSize: 28, fontFamily: 'x', fontWeight: 700, color: '#fff', align: 'left', valign: 'top', lineHeight: 1.2 },
        ],
      },
      {
        id: 's2',
        background: '#F2F0EA',
        transition: 'morph',
        notes: 'second',
        elements: [
          { id: 's2-t1', type: 'text', x: 120, y: 120, w: 500, h: 60, rotation: 0, opacity: 1, html: 'Numbers &amp; facts', fontSize: 30, fontFamily: 'x', fontWeight: 400, color: '#111', align: 'left', valign: 'top', lineHeight: 1.3 },
          { id: 'cast', type: 'text', x: 200, y: 500, w: 600, h: 120, rotation: 0, opacity: 1, html: 'Morph <b>me</b>', fontSize: 56, fontFamily: 'x', fontWeight: 700, color: '#111', align: 'left', valign: 'top', lineHeight: 1.2 },
        ],
      },
      { id: 's3', background: '#16273E', transition: 'fade', notes: '', elements: [] },
    ],
    modified: 'never',
  }
}

/** mutation menu — mirrors what the editor's commit sites do */
export function randomMutation(r: Mutator, rnd: () => number): (doc: Doc) => void {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
  const kind = Math.floor(rnd() * 13)
  return (doc: Doc) => {
    const slides = doc.slides
    const sl = pick(slides)
    if (!sl && kind !== 8) return // remote deletes can empty the deck
    switch (kind) {
      case 0: // doc prop
        doc.title = `Deck ${Math.floor(rnd() * 1000)}`
        break
      case 1: // theme (nested doc prop)
        doc.theme = { ...doc.theme, accent: `#${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0')}` }
        break
      case 2: // slide prop
        sl.background = `#${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0')}`
        break
      case 3: {
        // element prop
        const els = slides.flatMap((s: any) => s.elements)
        if (!els.length) break
        const el = pick(els)
        el.x = Math.floor(rnd() * 1600)
        el.y = Math.floor(rnd() * 900)
        break
      }
      case 12: {
        // REMOVE a property. The generator has never done this, and that gap
        // is not hypothetical: a `set` op with `v` ABSENT crashed every
        // receiving replica in a shipped release (scripts/test-crdt-delprop.ts),
        // and 300 seeds of this rig missed it for months because assigning is
        // the only mutation it knew. A property-based rig explores exactly the
        // mutations it was taught, so an untaught one is a permanent blind spot
        // rather than an unlikely one.
        const els = slides.flatMap((s: any) => s.elements)
        if (!els.length) break
        const el = pick(els)
        // optional properties only: deleting a required one is not a document
        // any editor could produce, so it would be testing an impossible input
        // OPTIONAL properties only. `rotation` and `opacity` are required in
        // model.ts, so deleting them would test a document no editor could
        // produce — an impossible input, whose failures teach nothing.
        const removable = ['radius', 'shadow', 'link', 'group', 'morphId']
          .filter((k) => el[k] !== undefined)
        if (!removable.length) break
        delete el[pick(removable)]
        break
      }
      case 4: {
        // insert element
        const id = `${r.actor}-e${r.counter++}`
        sl.elements.push({ id, type: 'shape', shape: 'rect', x: Math.floor(rnd() * 1000), y: Math.floor(rnd() * 700), w: 120, h: 80, rotation: 0, opacity: 1, fill: '#8FA3BF', stroke: 'none', strokeWidth: 0, radius: 4 })
        break
      }
      case 5: {
        // delete element
        const s = pick(slides.filter((x: any) => x.elements.length)) as any
        if (!s) break
        s.elements.splice(Math.floor(rnd() * s.elements.length), 1)
        break
      }
      case 6: {
        // move element across slides. Target must not already carry the
        // element's id: bare ids are unique WITHIN a slide (format
        // invariant the editor upholds); duplication ACROSS slides is the
        // morph idiom and legal.
        const from = pick(slides.filter((x: any) => x.elements.length)) as any
        if (!from || slides.length < 2) break
        const i = Math.floor(rnd() * from.elements.length)
        const to = pick(
          slides.filter((x: any) => x !== from && !x.elements.some((e: any) => e.id === from.elements[i].id)),
        ) as any
        if (!to) break
        const [el] = from.elements.splice(i, 1)
        to.elements.splice(Math.floor(rnd() * (to.elements.length + 1)), 0, el)
        break
      }
      case 7: {
        // reorder elements (z-order)
        if (sl.elements.length < 2) break
        const i = Math.floor(rnd() * sl.elements.length)
        const [el] = sl.elements.splice(i, 1)
        sl.elements.splice(Math.floor(rnd() * (sl.elements.length + 1)), 0, el)
        break
      }
      case 8: {
        // insert slide
        const id = `${r.actor}-s${r.counter++}`
        slides.splice(Math.floor(rnd() * (slides.length + 1)), 0, {
          id, background: '#123', transition: 'none', notes: '',
          elements: [{ id: `${id}-t`, type: 'text', x: 50, y: 50, w: 300, h: 50, rotation: 0, opacity: 1, html: 'new', fontSize: 20, fontFamily: 'x', fontWeight: 400, color: '#fff', align: 'left', valign: 'top', lineHeight: 1.2 }],
        })
        break
      }
      case 9: // delete slide
        if (slides.length > 1) slides.splice(Math.floor(rnd() * slides.length), 1)
        break
      case 10: {
        // reorder slides
        if (slides.length < 2) break
        const i = Math.floor(rnd() * slides.length)
        const [s] = slides.splice(i, 1)
        slides.splice(Math.floor(rnd() * (slides.length + 1)), 0, s)
        break
      }
      case 11: {
        // text edit
        const els = slides.flatMap((s: any) => s.elements).filter((e: any) => typeof e.html === 'string')
        if (!els.length) break
        const el = pick(els)
        const h: string = el.html
        if (rnd() < 0.5 && h.length > 2) {
          const i = Math.floor(rnd() * (h.length - 1))
          el.html = h.slice(0, i) + h.slice(i + 1 + Math.floor(rnd() * Math.min(3, h.length - i - 1)))
        } else {
          const i = Math.floor(rnd() * (h.length + 1))
          el.html = h.slice(0, i) + pick(['X', 'yz', ' q', '<i>!</i>', '&amp;']) + h.slice(i)
        }
        break
      }
    }
  }
}
