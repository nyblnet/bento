// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Follow mode — the pure half of the audience side of a live broadcast.
 *
 * present.ts owns the DOM; this owns the decisions, so a rig can drive them in
 * node: which slide a presenter's `nav` names, whether the viewer is following
 * or browsing, what the presenter's lock does to that, and when a laser sample
 * is due. docs/broadcast-design.md.
 */

/** What a presenter's nav carries: slide ID first, visible index as fallback. */
export type NavPayload = { id?: string; i?: number; lock?: boolean }

/**
 * Resolve a nav to a slide index, or -1. The ID wins — an insert or reorder
 * mid-talk changes every index and no ID. The visible index (1-based, states
 * uncounted, exactly what the presenter's counter shows) is only for a copy
 * that somehow lacks the slide.
 */
export function resolveNav(slides: ReadonlyArray<{ id: string; stateOf?: string }>, p: NavPayload): number {
  if (p.id) {
    const byId = slides.findIndex((s) => s.id === p.id)
    if (byId >= 0) return byId
  }
  if (typeof p.i === 'number' && p.i > 0) {
    let n = 0
    for (let i = 0; i < slides.length; i++) {
      if (slides[i].stateOf) continue
      n++
      if (n === p.i) return i
    }
  }
  return -1
}

/**
 * The viewer's follow toggle and the presenter's lock, as one small machine.
 *
 * - following: the overlay tracks the presenter's slide
 * - locked: the presenter has held the audience; following is forced on and
 *   the toggle is inert. Lock is a UX constraint, not a security one — the
 *   viewer holds the whole deck — so nothing here hides anything.
 * - presenterIndex: the last slide the presenter named, so snapping back to
 *   follow lands there without waiting for the next nav
 */
export class FollowState {
  following: boolean
  locked = false
  presenterIndex: number | null = null
  constructor(following = true) { this.following = following }

  /** The viewer clicked the chip. Returns the index to jump to, or null. */
  toggle(): number | null {
    if (this.locked) return null
    this.following = !this.following
    return this.following ? this.presenterIndex : null
  }

  /** A nav arrived. Returns the index to jump to, or null (browsing / unknown). */
  nav(slides: ReadonlyArray<{ id: string; stateOf?: string }>, p: NavPayload): number | null {
    this.applyLock(p.lock)
    const idx = resolveNav(slides, p)
    if (idx < 0) return null
    this.presenterIndex = idx
    return this.following ? idx : null
  }

  /** The lock flag rides on nav and black. Locking forces follow on. */
  applyLock(lock: boolean | undefined) {
    this.locked = !!lock
    if (this.locked) this.following = true
  }

  /** What the chip should say — one of three states, never a fourth. */
  label(): 'locked' | 'following' | 'browsing' {
    return this.locked ? 'locked' : this.following ? 'following' : 'browsing'
  }
}

/** Laser samples leave at most every `minMs`; pen-up (null) always goes. */
export function laserDue(p: string | null, now: number, last: number, minMs = 50): boolean {
  return p === null || now - last >= minMs
}
