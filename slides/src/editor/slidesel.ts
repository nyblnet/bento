// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Selecting several slides in the sidebar, and moving them as a block.
// Pure — arrays and indices in, arrays out — so scripts/test-slides-
// multiselect.ts drives it in node; editor.ts does the clicks and the drag.
//
// THE UNIT IS A PARENT WITH ITS STATES. A slide's interactive states
// (`stateOf`) live right after it in the deck and render nested under it;
// they are reachable only through it. So every operation here is on UNITS:
// selecting a parent selects its states, and moving it carries them. The
// single-slide drag this replaces spliced ONE index, so dragging a parent
// left its states where they were — nested, in the sidebar, under whatever
// slide now sat before them (measured; requirement 3 of discussion #514).
//
// Indices are positions in `slides` as it is NOW; a move returns a new
// array and the caller commits it as one 'slides' change.

export interface SlideLike { id: string; stateOf?: string }

/** The parent index of a unit: the slide itself, or a state's parent. */
export function parentOf(slides: SlideLike[], i: number): number {
  const s = slides[i]
  if (!s) return -1
  if (!s.stateOf) return i
  const p = slides.findIndex((x) => x.id === s.stateOf)
  return p >= 0 ? p : i
}

/** The indices of a unit, parent first: the parent and the states that
 *  follow it. States that drifted elsewhere still belong to it. */
export function unitOf(slides: SlideLike[], parent: number): number[] {
  const p = slides[parent]
  if (!p || p.stateOf) return parent >= 0 && parent < slides.length ? [parent] : []
  const out = [parent]
  slides.forEach((s, i) => { if (i !== parent && s.stateOf === p.id) out.push(i) })
  return out
}

/** Normalise a selection to parent indices, unique, in deck order. */
export function parents(slides: SlideLike[], selected: Iterable<number>): number[] {
  const set = new Set<number>()
  for (const i of selected) { const p = parentOf(slides, i); if (p >= 0) set.add(p) }
  return [...set].sort((a, b) => a - b)
}

/** Every index a selection covers (parents and their states), in deck order. */
export function expand(slides: SlideLike[], selected: Iterable<number>): number[] {
  const out = new Set<number>()
  for (const p of parents(slides, selected)) for (const i of unitOf(slides, p)) out.add(i)
  return [...out].sort((a, b) => a - b)
}

/** The parents between two indices inclusive (a Shift-click range). */
export function range(slides: SlideLike[], a: number, b: number): number[] {
  const lo = Math.min(a, b), hi = Math.max(a, b)
  const out: number[] = []
  slides.forEach((s, i) => { if (i >= lo && i <= hi && !s.stateOf) out.push(i) })
  if (!out.length) return parents(slides, [a])
  return out
}

/** Toggle one unit in a selection (a Cmd/Ctrl-click). */
export function toggle(slides: SlideLike[], selected: Iterable<number>, i: number): number[] {
  const p = parentOf(slides, i)
  const cur = new Set(parents(slides, selected))
  if (cur.has(p)) cur.delete(p); else cur.add(p)
  return [...cur].sort((a, b) => a - b)
}

/**
 * Move the selected units as one block so that the block starts where the
 * slide at `drop` is now (the sidebar's "insert before this thumb", as the
 * single-slide drag did). Relative order kept. `drop === slides.length`
 * appends. A drop onto the selection itself, or one that would change
 * nothing, returns the same array (the caller commits nothing).
 */
export function moveBlock<T extends SlideLike>(slides: T[], selected: Iterable<number>, drop: number): T[] {
  const moving = new Set(expand(slides, selected))
  if (!moving.size) return slides
  const dropParent = drop >= slides.length ? slides.length : parentOf(slides, drop)
  if (moving.has(dropParent)) return slides
  const block = slides.filter((_, i) => moving.has(i))
  const rest: T[] = []
  let at = -1
  slides.forEach((s, i) => {
    if (i === dropParent) at = rest.length
    if (!moving.has(i)) rest.push(s)
  })
  if (at < 0) at = rest.length
  const out = [...rest.slice(0, at), ...block, ...rest.slice(at)]
  return out.every((s, i) => s === slides[i]) ? slides : out
}

/**
 * What deleting a selection removes and what it breaks: the doomed ids
 * (units), the element links into them, and whether a linear slide
 * survives — the same three the single delete checks.
 */
export function deletePlan(slides: Array<SlideLike & { elements?: Array<{ link?: string }> }>, selected: Iterable<number>): { doomed: Set<string>; states: number; links: number; survives: boolean } {
  const idx = expand(slides, selected)
  const doomed = new Set(idx.map((i) => slides[i].id))
  const states = idx.filter((i) => !!slides[i].stateOf).length
  let links = 0
  for (const s of slides) {
    if (doomed.has(s.id)) continue
    for (const el of s.elements ?? []) if (el.link && doomed.has(el.link)) links++
  }
  const survives = slides.some((s) => !s.stateOf && !doomed.has(s.id))
  return { doomed, states, links, survives }
}
