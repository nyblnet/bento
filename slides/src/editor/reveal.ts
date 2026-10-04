// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Reveal authoring — the decisions behind "Reveal in order", "Reveal
 * together", "Remove reveal" and the canvas step badges. Editor UI only: the
 * format keeps a single number, `fx.step` (steps.ts says what it means while
 * presenting). Nothing here touches the DOM, so scripts/test-slides-reveal-ui.ts
 * drives it without one.
 *
 * READING ORDER. "Reveal in order" numbers a selection the way a reader would
 * scan it: top-to-bottom, then left-to-right within a row. Rows are found by
 * vertical overlap, not by a pixel band — an element joins the row that is
 * open when its vertical centre falls inside the row's extent, so a bullet
 * list numbers down the page while a row of three cards numbers across, and
 * a card that is a few pixels taller than its neighbours is still their
 * neighbour. Ties break by x, then id, so the order is a pure function of the
 * elements and two runs give the same numbers.
 */

import { stepOf, maxStep, type Stepped } from '../steps.ts'

export type Placed = Stepped & { x: number; y: number; w: number; h: number }

/** The selection sorted as a reader scans it. */
export function readingOrder<E extends Placed>(els: ReadonlyArray<E>): E[] {
  const byY = [...els].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
  const rows: { top: number; bottom: number; items: E[] }[] = []
  for (const el of byY) {
    const cy = el.y + el.h / 2
    const row = rows[rows.length - 1]
    if (row && cy >= row.top && cy <= row.bottom) {
      row.items.push(el)
      row.bottom = Math.max(row.bottom, el.y + el.h)
    } else rows.push({ top: el.y, bottom: el.y + el.h, items: [el] })
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id)))
}

/** One `fx.step` assignment; `step` 0 clears it. */
export type StepPatch = { id: string; step: number }

/**
 * "Reveal in order": the selection gets consecutive steps in reading order,
 * starting AFTER the slide's last step among elements outside the selection —
 * so ordering a second batch continues the sequence rather than restarting it,
 * and re-ordering the same batch renumbers it from the same start.
 */
export function revealInOrder(slide: ReadonlyArray<Placed>, selected: ReadonlyArray<Placed>): StepPatch[] {
  const chosen = new Set(selected.map((e) => e.id))
  const base = maxStep(slide.filter((e) => !chosen.has(e.id)))
  return readingOrder(selected).map((el, i) => ({ id: el.id, step: base + 1 + i }))
}

/** "Reveal together": the whole selection on ONE step — the next one after
 *  the rest of the slide, so it lands as a group at the end of the sequence. */
export function revealTogether(slide: ReadonlyArray<Placed>, selected: ReadonlyArray<Placed>): StepPatch[] {
  const chosen = new Set(selected.map((e) => e.id))
  const step = maxStep(slide.filter((e) => !chosen.has(e.id))) + 1
  return selected.map((el) => ({ id: el.id, step }))
}

/** "Remove reveal": the selection is shown with the slide again. */
export const removeReveal = (selected: ReadonlyArray<Stepped>): StepPatch[] =>
  selected.filter((el) => stepOf(el) > 0).map((el) => ({ id: el.id, step: 0 }))

/**
 * A click on a step badge walks the element through the slide's steps:
 * 1, 2, … up to one past the last step anyone else has, then back to 1.
 * Never to 0 — removing is a deliberate verb, not a click too many.
 */
export function cycleStep(slide: ReadonlyArray<Stepped>, el: Stepped): number {
  const others = slide.filter((e) => e.id !== el.id)
  const top = maxStep(others) + 1
  const cur = stepOf(el)
  return cur >= top ? 1 : cur + 1
}

/** Does the canvas show badges for this slide? Only when there is a step to
 *  show — a fresh slide carries no chrome for a feature it does not use. */
export const hasSteps = (slide: ReadonlyArray<Stepped>): boolean => maxStep(slide) > 0
