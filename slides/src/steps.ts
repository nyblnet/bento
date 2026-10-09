// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Reveal steps — "animate on click" within one slide (discussion #282).
 *
 * An element with `fx.step = n` (n ≥ 1) is hidden when the slide appears and
 * revealed on the n-th press of →, running its entrance then; ← hides the
 * last revealed step again; only when every step is shown does → move on to
 * the next slide. Elements without a step (or step 0) are there from the
 * start. Arriving BACKWARD lands with every step shown, the way PowerPoint and
 * reveal.js do, so ← walks a talk back through the same frames it went
 * forward through.
 *
 * This is presentation STATE, not slides: the deck stays one slide, the page
 * number stays one number, morph pairing and `stateOf` see one slide. An
 * older shell that does not know `fx.step` shows every element at once —
 * the same slide, fully revealed — which is what additivity promises.
 *
 * present.ts owns the DOM (hide/show, the entrance tween); this owns the
 * decisions, so scripts/test-slides-steps.ts can drive them without a DOM.
 */

export type Stepped = { id: string; fx?: { step?: number } }

/** The element's step: 0 = shown with the slide. Non-integers and negatives
 *  are treated as 0 rather than trusted — the shape gate bounds the value,
 *  but a hand-written file may carry anything. */
export const stepOf = (el: Stepped): number => {
  const s = el.fx?.step
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? Math.floor(s) : 0
}

/** The last step on the slide — 0 when nothing is stepped. Steps need not be
 *  contiguous (1, 2, 5 is fine: the gaps are pressed through in one go). */
export const maxStep = (elements: ReadonlyArray<Stepped>): number =>
  elements.reduce((m, el) => Math.max(m, stepOf(el)), 0)

/** The steps actually present, ascending — what → walks through. */
export const stepsOf = (elements: ReadonlyArray<Stepped>): number[] =>
  [...new Set(elements.map(stepOf).filter((s) => s > 0))].sort((a, b) => a - b)

/** Is this element visible at the given step? */
export const shownAt = (el: Stepped, step: number): boolean => stepOf(el) <= step

/**
 * The step counter for the slide on screen. `next()`/`prev()` answer what a
 * keypress does: advance within the slide ('step', with the elements that
 * just appeared or disappeared) or leave it ('slide').
 */
export class StepState<E extends Stepped = Stepped> {
  step = 0
  private steps: number[] = []
  private elements: ReadonlyArray<E> = []

  /** A slide arrived. Forward = start hidden; backward = everything shown. */
  enter(elements: ReadonlyArray<E>, forward: boolean) {
    this.elements = elements
    this.steps = stepsOf(elements)
    this.step = forward ? 0 : (this.steps[this.steps.length - 1] ?? 0)
  }

  /** Jump to an exact step (the audience following a presenter's nav). */
  set(step: number) {
    const max = this.steps[this.steps.length - 1] ?? 0
    this.step = Math.max(0, Math.min(max, Math.floor(step)))
  }

  hasNext(): boolean { return this.steps.some((s) => s > this.step) }
  hasPrev(): boolean { return this.step > 0 }

  next(): { kind: 'slide' } | { kind: 'step'; step: number; reveal: E[] } {
    const to = this.steps.find((s) => s > this.step)
    if (to === undefined) return { kind: 'slide' }
    const from = this.step
    this.step = to
    // everything between the old step and the new one appears together
    return { kind: 'step', step: to, reveal: this.elements.filter((el) => stepOf(el) > from && stepOf(el) <= to) }
  }

  prev(): { kind: 'slide' } | { kind: 'step'; step: number; hide: E[] } {
    if (this.step === 0) return { kind: 'slide' }
    const below = this.steps.filter((s) => s < this.step)
    const to = below[below.length - 1] ?? 0
    const from = this.step
    this.step = to
    return { kind: 'step', step: to, hide: this.elements.filter((el) => stepOf(el) > to && stepOf(el) <= from) }
  }
}
