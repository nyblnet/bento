// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Components, Penpot's main/copy model, with no element type of their own.
//
// A component is a set of ordinary elements sharing `component.id`. The MAIN
// is the set marked `main`; every other set with that id is a COPY, one copy
// per groupId. `component.key` pairs each copy element with its counterpart in
// the main. A copy re-derives every property from the main except its own
// identity, its position offset, and the keys it overrides locally
// (`component.over`). An older shell sees ordinary grouped elements.
//
// Derive-not-commit, like syncConnectors: a pure function of the document,
// run on every `doc` event, so collaborating replicas agree without ops.
// Overrides are detected, not declared: a copy property that disagrees with
// its main while the MAIN has not moved since the last pass was changed by
// hand (any edit path — the inspector, a scrub, a paste, an older shell), so
// it becomes an override. When the main moves, copies follow on every key
// they do not override.

import type { BentoDoc, SlideElement } from './model.ts'

type Comp = NonNullable<SlideElement['component']>
type El = SlideElement & Record<string, unknown> & { component?: Comp }

/** Keys a copy never takes from its main. x/y follow the main as an offset. */
const OWN = new Set(['id', 'groupId', 'groupName', 'name', 'component', 'x', 'y', 'morphId'])

export interface ComponentInfo { id: string; name: string; slideId: string; main: El[] }

/** Every component in the document, by its main. */
export function components(doc: BentoDoc): ComponentInfo[] {
  const out = new Map<string, ComponentInfo>()
  for (const s of doc.slides) for (const el of s.elements as El[]) {
    const c = el.component
    if (!c?.main) continue
    const info = out.get(c.id) ?? { id: c.id, name: '', slideId: s.id, main: [] }
    info.main.push(el)
    info.name ||= el.groupName ?? el.name ?? ''
    out.set(c.id, info)
  }
  return [...out.values()]
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Bring every copy in step with its main. `lastMain` carries each main's
 * signature from the previous pass (the editor owns it; a fresh Map treats
 * every disagreement as an override, which is the safe reading at boot).
 * Returns whether anything was written.
 */
export function syncComponents(doc: BentoDoc, lastMain: Map<string, string>): boolean {
  let changed = false
  for (const comp of components(doc)) {
    const byKey = new Map(comp.main.map((m) => [m.component!.key, m]))
    const sig = JSON.stringify(comp.main.map((m) => Object.entries(m).filter(([k]) => k !== 'component')))
    const mainMoved = lastMain.has(comp.id) && lastMain.get(comp.id) !== sig
    lastMain.set(comp.id, sig)
    for (const s of doc.slides) {
      // copies of this component on this slide, one instance per groupId
      const inst = new Map<string, El[]>()
      for (const el of s.elements as El[]) {
        const c = el.component
        if (c?.id !== comp.id || c.main || !byKey.has(c.key)) continue
        const g = el.groupId ?? el.id
        inst.set(g, [...(inst.get(g) ?? []), el])
      }
      for (const els of inst.values()) {
        // the offset comes from the instance's first element that still has a counterpart
        const a = els[0], am = byKey.get(a.component!.key)!
        const dx = (a.x as number) - (am.x as number), dy = (a.y as number) - (am.y as number)
        for (const el of els) {
          const m = byKey.get(el.component!.key)!
          const over = new Set(el.component!.over ?? [])
          const keys = new Set([...Object.keys(m), ...Object.keys(el)].filter((k) => !OWN.has(k)))
          for (const k of keys) {
            if (over.has(k) || eq(el[k], m[k])) continue
            if (mainMoved) {
              if (m[k] === undefined) delete el[k]
              else el[k] = clone(m[k])
            } else over.add(k) // the copy was edited by hand: keep its value
            changed = true
          }
          // ponytail: a member nudged on its own inside a copy keeps its spot only
          // until the main next moves, then re-joins the instance's offset
          if (mainMoved && el !== a) {
            const x = (m.x as number) + dx, y = (m.y as number) + dy
            if (el.x !== x || el.y !== y) { el.x = x; el.y = y; changed = true }
          }
          const ov = [...over].sort()
          if (!eq(ov, el.component!.over ?? [])) {
            if (ov.length) el.component!.over = ov
            else delete el.component!.over
            changed = true
          }
        }
      }
    }
  }
  return changed
}

/** Mark `els` (one slide's selection) as the main of a new component. */
export function makeComponent(els: SlideElement[], id: string, groupId: string): void {
  els.forEach((el, i) => {
    el.component = { id, key: `k${i}`, main: true }
    el.groupId = groupId
  })
}

/** A fresh copy of a component's main, ids minted by `uid`, offset by (dx, dy). */
export function instanceOf(comp: ComponentInfo, uid: () => string, dx = 0, dy = 0): SlideElement[] {
  const gid = uid()
  return comp.main.map((m) => {
    const el = clone(m) as El
    el.id = uid()
    el.groupId = gid
    el.x = (m.x as number) + dx
    el.y = (m.y as number) + dy
    delete el.morphId
    el.component = { id: comp.id, key: m.component!.key }
    return el
  })
}

/** Detach: the elements keep every value and stop following anything. */
export function detach(els: SlideElement[]): void {
  for (const el of els) delete el.component
}
