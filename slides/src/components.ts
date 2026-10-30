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
// they do not override. Position is the same rule per member: a member moved
// alone inside its copy overrides x/y; the copy moved whole just has a new
// offset, kept on its members as `component.off` so a reload (or another
// replica) reads the same instance position the live session had.

import type { BentoDoc, SlideElement } from './model.ts'

type Comp = NonNullable<SlideElement['component']>
type El = SlideElement & Record<string, unknown> & { component?: Comp }

/** Keys a copy never takes from its main. x/y follow the main as an offset. */
const OWN = new Set(['id', 'groupId', 'groupName', 'name', 'component', 'x', 'y', 'morphId'])  // x/y: see the per-instance offset

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
        // The instance's offset from its main, kept on its members
        // (`component.off`). A member whose offset alone differs was moved by
        // hand: its position becomes an override ('x'/'y' in `over`) and the
        // rest of the copy stays put. All members moved together = the copy
        // was moved, and only the offset changes.
        const free = els.filter((el) => !el.component!.over?.includes('x'))
        const delta = (el: El) => { const m = byKey.get(el.component!.key)!; return [(el.x as number) - (m.x as number), (el.y as number) - (m.y as number)] }
        const prev = els.find((el) => el.component!.off)?.component!.off
        let off: number[] | undefined = prev
        const moved = new Set<El>()
        if (!mainMoved && free.length) {
          const ds = free.map(delta)
          const same = (a: number[], b: number[] | undefined) => !!b && Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01
          if (!prev || ds.every((d) => same(d, ds[0]))) off = ds.every((d) => same(d, ds[0])) ? ds[0] : majority(ds)
          for (let i = 0; i < free.length; i++) if (!same(ds[i], off)) moved.add(free[i])
        }
        for (const el of els) {
          if (off && !eq(el.component!.off, off)) { el.component!.off = [off[0], off[1]]; changed = true }
          const m = byKey.get(el.component!.key)!
          const over = new Set(el.component!.over ?? [])
          if (moved.has(el)) { over.add('x'); over.add('y'); changed = true }
          const keys = new Set([...Object.keys(m), ...Object.keys(el)].filter((k) => !OWN.has(k)))
          for (const k of keys) {
            if (over.has(k) || eq(el[k], m[k])) continue
            if (mainMoved) {
              if (m[k] === undefined) delete el[k]
              else el[k] = clone(m[k])
            } else over.add(k) // the copy was edited by hand: keep its value
            changed = true
          }
          // the main moved: members that do not override their position keep the instance's offset
          if (mainMoved && off && !over.has('x')) {
            const x = (m.x as number) + off[0], y = (m.y as number) + off[1]
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

/** The offset most members share (first wins a tie): at boot, with no memory, the odd one out is the one moved. */
function majority(ds: number[][]): number[] {
  let best = ds[0], n = 0
  for (const d of ds) {
    const c = ds.filter((e) => Math.abs(e[0] - d[0]) < 0.01 && Math.abs(e[1] - d[1]) < 0.01).length
    if (c > n) { best = d; n = c }
  }
  return best
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
    el.component = { id: comp.id, key: m.component!.key, off: [dx, dy] }
    return el
  })
}

/** Detach: the elements keep every value and stop following anything. */
export function detach(els: SlideElement[]): void {
  for (const el of els) delete el.component
}

/**
 * Elements arriving in a deck by paste or duplicate keep their component only
 * where it still means something: a copy whose main is not in the deck is
 * detached (it has nothing to follow); a main whose component already has a
 * main in the deck becomes a copy of it (one main per component — Penpot's
 * duplicate); a main arriving in a deck without one stays a main there.
 * Call before the elements join the deck.
 */
export function adoptComponents(els: SlideElement[], doc: BentoDoc): void {
  const mains = new Map<string, El>()
  for (const s of doc.slides) for (const e of s.elements as El[]) if (e.component?.main) mains.set(`${e.component.id}|${e.component.key}`, e)
  const has = (id: string) => [...mains.keys()].some((k) => k.startsWith(id + '|'))
  const bringsMain = new Set(els.filter((e) => e.component?.main).map((e) => e.component!.id))
  for (const el of els as El[]) {
    const c = el.component
    if (!c) continue
    if (has(c.id)) {
      if (!c.main) continue
      // a second main: it becomes a copy, its offset measured from the main
      const m = mains.get(`${c.id}|${c.key}`)
      delete c.main
      if (m) c.off = [(el.x as number) - (m.x as number), (el.y as number) - (m.y as number)]
    } else if (!bringsMain.has(c.id)) delete el.component
  }
}
