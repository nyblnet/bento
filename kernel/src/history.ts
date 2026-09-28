// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/** Field-level, identity-addressed history. Document assets are immutable strings:
 * copying containers preserves their sharing instead of serializing them per edit.
 * A reversal is conditional: a later value on the same field wins. */
import { copy, equal } from './documentvalue.ts'
export { copy, equal } from './documentvalue.ts'

export interface HistoryOptions {
  /** App-owned metadata excluded from ordinary edits. Only root keys are ignored. */
  ignoreRootKeys?: readonly string[]
}
export type Path = (string | { id: string })[]
export type Change =
  | { kind: 'value'; path: Path; before: unknown; after: unknown; index?: number; neighbors?: { before: string[]; after: string[] } }
  | { kind: 'order'; path: Path; before: string[]; after: string[] }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const keyed = (v: unknown[]): boolean => v.every(x => object(x) && typeof x.id === 'string') && new Set(v.map(x => (x as any).id)).size === v.length
export function changes(before: unknown, after: unknown, options: HistoryOptions = {}): Change[] {
  return diff(before, after, [], new Set(options.ignoreRootKeys))
}
function diff(before: any, after: any, path: Path, ignored: Set<string>): Change[] {
  if (equal(before, after)) return []
  if (Array.isArray(before) && Array.isArray(after) && keyed(before) && keyed(after)) {
    const out: Change[] = []
    const old = new Map(before.map(x => [x.id, x])), next = new Map(after.map(x => [x.id, x]))
    before.forEach((x, index) => { if (!next.has(x.id)) out.push({ kind: 'value', path: [...path, { id: x.id }], before: copy(x), after: undefined, index, neighbors: { before: before.slice(0, index).map(v => v.id), after: before.slice(index + 1).map(v => v.id) } }) })
    after.forEach((x, index) => {
      if (!old.has(x.id)) out.push({ kind: 'value', path: [...path, { id: x.id }], before: undefined, after: copy(x), index, neighbors: { before: after.slice(0, index).map(v => v.id), after: after.slice(index + 1).map(v => v.id) } })
      else out.push(...diff(old.get(x.id), x, [...path, { id: x.id }], ignored))
    })
    const a = before.filter(x => next.has(x.id)).map(x => x.id), b = after.filter(x => old.has(x.id)).map(x => x.id)
    if (!equal(a, b)) out.push({ kind: 'order', path, before: a, after: b })
    return out
  }
  if (object(before) && object(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(k => {
      if (!path.length && ignored.has(k)) return []
      return diff(Object.hasOwn(before, k) ? before[k] : undefined, Object.hasOwn(after, k) ? after[k] : undefined, [...path, k], ignored)
    })
  }
  return [{ kind: 'value', path, before: copy(before), after: copy(after) }]
}
function get(root: any, path: Path): any {
  let v = root
  for (const key of path) {
    if (v == null) return undefined
    v = typeof key === 'string' ? (Object.hasOwn(v, key) ? v[key] : undefined) : Array.isArray(v) ? v.find(x => object(x) && x.id === key.id) : undefined
  }
  return v
}
/** Return the actual inverses, so redo never overwrites a skipped collaborator change. */
export function reverse(root: any, delta: Change[], force = false): Change[] {
  const applied: Change[] = []
  for (const c of [...delta].reverse()) {
    const value = get(root, c.path)
    if (c.kind === 'order') {
      if (!Array.isArray(value) || !keyed(value)) continue
      const ids = new Set(c.after)
      const present = value.filter(x => ids.has(x.id)).map(x => x.id)
      const expected = c.after.filter(id => present.includes(id))
      if (!force && !equal(present, expected)) continue
      const byId = new Map(value.map(x => [x.id, x]))
      const wanted = c.before.filter(id => byId.has(id)).map(id => byId.get(id))
      let i = 0
      for (let n = 0; n < value.length; n++) if (ids.has(value[n].id)) value[n] = wanted[i++]
      applied.push({ ...c, before: c.after, after: c.before })
      continue
    }
    if ((!force && !equal(value, c.after)) || !c.path.length) continue
    const parent = get(root, c.path.slice(0, -1)), key = c.path.at(-1)!
    if (!parent) continue // a remotely deleted parent must never be resurrected
    let neighbors = c.neighbors
    if (typeof key === 'string') {
      if (!object(parent)) continue // a newer scalar replaced this container
      if (c.before === undefined) delete parent[key]
      else Object.defineProperty(parent, key, { value: copy(c.before), writable: true, enumerable: true, configurable: true })
    } else {
      if (!Array.isArray(parent) || !keyed(parent)) continue
      const at = parent.findIndex(x => x.id === key.id)
      if (at >= 0) neighbors = { before: parent.slice(0, at).map(x => x.id), after: parent.slice(at + 1).map(x => x.id) }
      if (c.before === undefined) { if (at >= 0) parent.splice(at, 1) }
      else if (at >= 0) parent[at] = copy(c.before)
      else {
        const next = c.neighbors?.after.find(id => parent.some(x => x.id === id))
        const prev = c.neighbors?.before.slice().reverse().find(id => parent.some(x => x.id === id))
        const insertAt = next ? parent.findIndex(x => x.id === next) : prev ? parent.findIndex(x => x.id === prev) + 1 : Math.min(c.index ?? parent.length, parent.length)
        parent.splice(insertAt, 0, copy(c.before))
      }
    }
    applied.push({ ...c, before: copy(value), after: c.before, neighbors })
  }
  return applied
}
