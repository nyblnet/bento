// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// TOUCH: the gestures a finger needs and a mouse already had.
//
// This file exists because three of this app's most ordinary actions were
// reachable ONLY with a mouse, and the measurement is the argument:
//
//   · reordering a block         — `grip.draggable = true`, HTML5 dnd
//   · nesting a page in the tree — `a.draggable = true`, HTML5 dnd
//   · moving an issue card       — `card.draggable = true`, HTML5 dnd
//   · moving a card on a canvas  — `grip.addEventListener('mousedown', …)`
//
// HTML5 drag-and-drop does not exist on a touch screen. Not "is awkward" —
// `dragstart` never fires from a finger on iOS or Android, so those three
// gestures were not degraded on a phone, they were ABSENT. Two of them had a
// documented fallback (Move up / Move down in the block menu; tap the status
// chip on a card), and the page tree had none at all: nesting a page was
// impossible on a phone, by any route.
//
// THE SHAPE OF THE FIX: REPLAY, DON'T REIMPLEMENT.
//
// The obvious version of this file is a second drag engine that knows what a
// block, a page row and an issue card each mean. That is three copies of logic
// that already exists and works, kept in step by hand forever. So instead the
// touch gesture SYNTHESISES THE EVENTS THE EXISTING HANDLERS ALREADY LISTEN
// FOR — a real `DataTransfer`, a real `dragstart` on the source, `dragover` /
// `dragleave` on whatever is under the finger, `drop`, `dragend`. Every drop
// rule, every "only a block drag" payload check, every `.sp-drop` /
// `.sp-dropline` / `.sp-dropbefore` highlight in editor.ts is reached
// unchanged and unaware. Adding a fourth draggable thing to the editor gets
// touch support with no edit here.
//
// `new DataTransfer()` is what makes that honest rather than a mock: the
// source's own `dragstart` handler calls `setData` on it, so `types` and
// `getData` in the drop handler answer with the real payload the real gesture
// would have carried.
//
// A LONG PRESS, NOT A DRAG THRESHOLD. A finger that moves is scrolling — that
// is the whole vocabulary of a touch screen, and a page you cannot scroll
// because you started on a card is worse than a card you cannot drag. So the
// gesture is: press, hold HOLD_MS without moving more than SLOP, and only then
// does the surface become a drag. Move first and the drag is cancelled and the
// scroll is left completely alone (nothing is preventDefault-ed until the hold
// has fired). This is the same bargain a phone's home screen makes, and it is
// why press-and-hold is also what opens a context menu: it is the gesture that
// means "this thing, specifically" rather than "the page".
//
// DESKTOP IS NOT TOUCHED. Every listener here is a `touch*` listener. A mouse
// emits none of them, so a machine driven by a mouse runs not one line of this
// file — which is the only reason a change this broad can be made to four
// mouse-driven surfaces at once without a desktop regression to argue about.

/** How long a finger must sit still before a press becomes a drag. */
const HOLD_MS = 320
/** How far it may drift in that time and still count as sitting still. */
const SLOP = 10

/** How close to a scroller's edge the finger has to be to drag the view along. */
const EDGE = 44
/** Pixels per frame at the very edge. Gentle: this runs at 60Hz. */
const EDGE_SPEED = 12

const point = (e: TouchEvent): Touch | null => e.touches[0] ?? e.changedTouches[0] ?? null

/**
 * Drag the view when the finger reaches the edge of what it can see.
 *
 * WITHOUT THIS THE BOARD DRAG IS A RIG TRICK. Measured on the built shell at
 * 390px: the board holds six columns 232px wide in a 328px box, so exactly one
 * column and a sliver of the next are on screen. Every drop target worth
 * dragging to is therefore OUTSIDE the viewport, `elementFromPoint` returns
 * null there, and a gesture that cannot reach its target is not a feature. The
 * finger is also holding the card, so it cannot scroll the board itself.
 *
 * The scroller is found per frame rather than once, because a drag crosses
 * between them — out of a board sideways, down a sidebar, down the page.
 */
function edgeScroll(x: number, y: number): void {
  let el: Element | null = document.elementFromPoint(x, y)
  while (el) {
    const s = el as HTMLElement
    const canX = s.scrollWidth - s.clientWidth > 2
    const canY = s.scrollHeight - s.clientHeight > 2
    if (canX || canY) {
      const r = s.getBoundingClientRect()
      if (canX) {
        if (x < r.left + EDGE) s.scrollLeft -= EDGE_SPEED
        else if (x > r.right - EDGE) s.scrollLeft += EDGE_SPEED
      }
      if (canY) {
        if (y < r.top + EDGE) s.scrollTop -= EDGE_SPEED
        else if (y > r.bottom - EDGE) s.scrollTop += EDGE_SPEED
      }
      return
    }
    el = s.parentElement
  }
  // Nothing between the finger and the root scrolls: the page itself might.
  const root = document.scrollingElement as HTMLElement | null
  if (!root) return
  if (y < EDGE) root.scrollTop -= EDGE_SPEED
  else if (y > innerHeight - EDGE) root.scrollTop += EDGE_SPEED
}

/**
 * Give every `[draggable="true"]` inside `root` a press-and-hold drag.
 *
 * Returns its own teardown, so a caller that rebuilds the app can let go of it.
 */
export function enableTouchDrag(root: HTMLElement): () => void {
  let src: HTMLElement | null = null
  let data: DataTransfer | null = null
  let over: Element | null = null
  let hold = 0
  let startX = 0
  let startY = 0
  let live = false
  let atX = 0
  let atY = 0
  let creep = 0

  const fire = (type: string, on: EventTarget, x: number, y: number): boolean => {
    // A real DragEvent, carrying a real DataTransfer: the handlers downstream
    // read `dataTransfer.types` to decide whether this drag is theirs, and a
    // CustomEvent could not answer that question.
    const ev = new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, dataTransfer: data,
    })
    return on.dispatchEvent(ev)
  }

  const cancelHold = (): void => { if (hold) { clearTimeout(hold); hold = 0 } }

  /** Re-aim at whatever is under the finger now — after a move, or after the
   *  edge scroll has slid new content beneath a finger that has not moved. */
  const aim = (): void => {
    const under = document.elementFromPoint(atX, atY)
    if (under !== over) {
      if (over) fire('dragleave', over, atX, atY)
      over = under
    }
    if (over) fire('dragover', over, atX, atY)
  }

  // `setInterval`, not `requestAnimationFrame`: a finger PARKED at the edge
  // must keep scrolling, and rAF is throttled to zero in a hidden or occluded
  // tab (CLAUDE.md's testing note — the same trap that makes an unfocused rig
  // report "it does not animate"). A timer degrades to slow rather than to
  // nothing, which is also what makes this measurable off a phone.
  const stopCreep = (): void => { if (creep) { clearInterval(creep); creep = 0 } }
  const startCreep = (): void => {
    stopCreep()
    creep = window.setInterval(() => {
      if (!live) { stopCreep(); return }
      edgeScroll(atX, atY)
      aim()
    }, 16)
  }

  const finish = (x: number, y: number, dropIt: boolean): void => {
    const from = src
    const target = over
    src = null; over = null; live = false
    cancelHold()
    stopCreep()
    document.body.classList.remove('sp-touchdrag')
    if (!from) return
    if (dropIt && target) fire('drop', target, x, y)
    else if (target) fire('dragleave', target, x, y)
    fire('dragend', from, x, y)
    data = null
  }

  const onStart = (e: TouchEvent): void => {
    if (e.touches.length !== 1) { finish(0, 0, false); return }
    const t = point(e)
    if (!t) return
    const at = t.target instanceof Element ? t.target : null
    const cand = at?.closest<HTMLElement>('[draggable="true"]')
    if (!cand || !root.contains(cand)) return
    // A button inside a draggable row is its own control — the ⋯ on a page row,
    // the status chip on a card. Pressing one must never drag its container.
    const btn = at?.closest('button')
    if (btn && btn !== cand) return
    src = cand
    startX = atX = t.clientX
    startY = atY = t.clientY
    hold = window.setTimeout(() => {
      hold = 0
      if (!src) return
      live = true
      startCreep()
      data = new DataTransfer()
      document.body.classList.add('sp-touchdrag')
      // The long press has already armed the OS text-selection gesture on some
      // browsers; the drag owns the finger from here.
      getSelection()?.removeAllRanges()
      navigator.vibrate?.(8)
      fire('dragstart', src, startX, startY)
    }, HOLD_MS)
  }

  const onMove = (e: TouchEvent): void => {
    if (!src) return
    const t = point(e)
    if (!t) return
    if (!live) {
      // Still deciding. A finger that has travelled is scrolling, and this
      // listener has not called preventDefault, so the scroll already started
      // and is none of our business.
      if (Math.abs(t.clientX - startX) + Math.abs(t.clientY - startY) > SLOP) {
        cancelHold(); src = null
      }
      return
    }
    e.preventDefault()
    atX = t.clientX
    atY = t.clientY
    aim()
  }

  const onEnd = (e: TouchEvent): void => {
    const t = point(e)
    finish(t?.clientX ?? 0, t?.clientY ?? 0, live)
  }

  const onCancel = (): void => { finish(0, 0, false) }

  // `passive: false` on the move listener because a live drag must be able to
  // stop the page scrolling under it. touchstart stays passive: it never
  // prevents anything, and the decision has not been made yet.
  root.addEventListener('touchstart', onStart, { passive: true })
  root.addEventListener('touchmove', onMove, { passive: false })
  root.addEventListener('touchend', onEnd, { passive: true })
  root.addEventListener('touchcancel', onCancel, { passive: true })

  return () => {
    finish(0, 0, false)
    root.removeEventListener('touchstart', onStart)
    root.removeEventListener('touchmove', onMove)
    root.removeEventListener('touchend', onEnd)
    root.removeEventListener('touchcancel', onCancel)
  }
}

/**
 * Let a finger drive a handle that was written for a mouse.
 *
 * The canvas card grip (canvas.ts) is a deliberate MOUSE drag rather than dnd:
 * a free surface needs a continuous coordinate, and dnd reports a drop target.
 * Its reasoning is sound and none of it is touch-specific, so rather than
 * fork it, a touch on the handle is replayed as the mousedown/mousemove/mouseup
 * stream it already listens for. One gesture, one implementation, one set of
 * clamps and one commit.
 *
 * No long press here: a grip is an explicit handle whose only purpose is to be
 * dragged, so there is nothing to disambiguate and nothing to wait for.
 */
export function touchDragAsMouse(handle: HTMLElement): void {
  let on = false

  const send = (type: string, to: EventTarget, t: Touch): void => {
    to.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: t.clientX, clientY: t.clientY, button: 0,
    }))
  }

  const move = (e: TouchEvent): void => {
    const t = point(e)
    if (!t || !on) return
    e.preventDefault()
    send('mousemove', window, t)
  }

  const end = (e: TouchEvent): void => {
    if (!on) return
    on = false
    const t = point(e)
    if (t) send('mouseup', window, t)
    window.removeEventListener('touchmove', move)
    window.removeEventListener('touchend', end)
    window.removeEventListener('touchcancel', end)
  }

  handle.addEventListener('touchstart', (e: TouchEvent) => {
    if (e.touches.length !== 1) return
    const t = point(e)
    if (!t) return
    e.preventDefault()
    on = true
    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend', end, { passive: true })
    window.addEventListener('touchcancel', end, { passive: true })
    send('mousedown', handle, t)
  }, { passive: false })
}

/** What a pinch reports back to the surface it is zooming. */
export interface PinchHost {
  /** the surface's camera, right now */
  get(): { scale: number; panX: number; panY: number }
  /** the camera it should have; the surface redraws */
  set(scale: number, panX: number, panY: number): void
  /** the narrowest and widest the surface will go */
  limits: [number, number]
}

/**
 * Two fingers: pinch to zoom, and drag to pan.
 *
 * The graph could already be panned with one finger (its `pointerdown` path is
 * pointer events, which a touch drives) — but zoom was on `wheel` alone, and a
 * phone has no wheel. So a graph on a phone could be moved and never scaled:
 * the one operation a crowded picture actually needs.
 *
 * Zoom is about the MIDPOINT of the two fingers, the same rule the wheel path
 * uses about the cursor — the thing between your fingers is the thing you are
 * looking at, and it should stay where it is.
 */
export function enablePinchZoom(el: HTMLElement, host: PinchHost): void {
  let d0 = 0
  let mid0 = { x: 0, y: 0 }
  let cam0 = { scale: 1, panX: 0, panY: 0 }

  const pair = (e: TouchEvent): { d: number; x: number; y: number } | null => {
    const [a, b] = [e.touches[0], e.touches[1]]
    if (!a || !b) return null
    const r = el.getBoundingClientRect()
    const dx = a.clientX - b.clientX
    const dy = a.clientY - b.clientY
    return {
      d: Math.hypot(dx, dy),
      x: (a.clientX + b.clientX) / 2 - r.left,
      y: (a.clientY + b.clientY) / 2 - r.top,
    }
  }

  el.addEventListener('touchstart', (e: TouchEvent) => {
    const p = pair(e)
    if (!p) { d0 = 0; return }
    d0 = p.d || 1
    mid0 = { x: p.x, y: p.y }
    cam0 = host.get()
  }, { passive: true })

  el.addEventListener('touchmove', (e: TouchEvent) => {
    if (!d0) return
    const p = pair(e)
    if (!p) return
    e.preventDefault()
    const [lo, hi] = host.limits
    const next = Math.max(lo, Math.min(hi, cam0.scale * (p.d / d0)))
    // Zoom about the starting midpoint, then follow wherever that midpoint has
    // travelled since — so a pinch that also slides pans at the same time,
    // which is what a hand does whether or not it means to.
    const panX = p.x - ((mid0.x - cam0.panX) / cam0.scale) * next
    const panY = p.y - ((mid0.y - cam0.panY) / cam0.scale) * next
    host.set(next, panX, panY)
  }, { passive: false })

  const stop = (e: TouchEvent): void => { if (e.touches.length < 2) d0 = 0 }
  el.addEventListener('touchend', stop, { passive: true })
  el.addEventListener('touchcancel', stop, { passive: true })
}
