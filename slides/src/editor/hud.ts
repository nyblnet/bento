// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Two small pieces of live feedback for the canvas, the way design tools give it:
//
// - The modifier hint: hold Alt, ⌘/Ctrl or Shift over the canvas and a line at
//   its foot says what that key does to the next click or drag. The words are
//   the canvas's real gestures (canvas.ts) — change one there, change it here.
// - The transform pill: while a move, resize or rotate is under way, or a
//   numeric field is being scrubbed, a pill beside the pointer shows the
//   numbers as they change.

import { t } from '../i18n'
import { MOD } from './commands'

/** What each modifier does on the canvas right now. */
function modHint(e: { altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, selected: number): string {
  if (e.altKey) return selected
    ? t('Alt: measure to the element under the pointer · click selects the element behind · resize from the centre')
    : t('Alt: click selects the element behind the one on top')
  if (e.metaKey || e.ctrlKey) return `${t('{mod}: click selects exactly the element under the pointer, even in a group · drag duplicates', { mod: MOD })} · ${t('held while dragging, nothing drops into a frame')}`
  if (e.shiftKey) return t('Shift: click adds to the selection or takes out · drag along one axis · resize keeps the ratio · rotate in 15° steps')
  return ''
}

/** The modifier line at the foot of the canvas. `over` is the canvas surface;
 *  `signal` ends it with the editor build that made it. Not a live region: a
 *  screen reader would read a sentence on every Shift. */
export function mountModHint(host: HTMLElement, over: HTMLElement, selected: () => number, signal?: AbortSignal) {
  const line = document.createElement('div')
  line.className = 'ed-modhint'
  line.hidden = true
  host.appendChild(line)
  let inside = false
  const update = (e: KeyboardEvent | MouseEvent) => {
    const text = inside ? modHint(e, selected()) : ''
    line.textContent = text
    line.hidden = !text
  }
  over.addEventListener('mouseenter', (e) => { inside = true; update(e) })
  over.addEventListener('mouseleave', (e) => { inside = false; update(e) })
  window.addEventListener('keydown', update, { signal })
  window.addEventListener('keyup', update, { signal })
  window.addEventListener('blur', () => { line.hidden = true }, { signal })
  return line
}

/** The pill that follows the pointer during a gesture. */
export class TransformHud {
  private pill = document.createElement('div')
  private x = 0
  private y = 0
  /** `signal` takes the pill and its listeners away with the editor build that made it. */
  constructor(signal?: AbortSignal) {
    this.pill.className = 'ed-hud'
    this.pill.hidden = true
    document.body.appendChild(this.pill)
    signal?.addEventListener('abort', () => this.pill.remove(), { once: true })
    const on = { capture: true, signal }
    window.addEventListener('pointermove', (e) => { this.x = e.clientX; this.y = e.clientY }, on)
    // A scrubbed field (fields.ts / controls.ts) fires a non-bubbling event on
    // its input; capture still sees it, so the scrub needs no hook of its own.
    document.addEventListener('ed-scrub', (e) => {
      const input = e.target as HTMLInputElement
      this.show(`${input.getAttribute('aria-label') ?? ''} ${input.value}`.trim())
    }, on)
    document.addEventListener('change', () => this.hide(), on)
    window.addEventListener('pointerup', () => this.hide(), on)
  }

  show(text: string, x = this.x, y = this.y) {
    this.pill.textContent = text
    this.pill.hidden = false
    this.pill.style.left = `${x + 14}px`
    this.pill.style.top = `${y + 18}px`
  }

  hide() { this.pill.hidden = true }
}

/** A number as the pill writes it: whole, or one decimal when it has one. */
export const hudNum = (v: number) => String(Math.round(v * 10) / 10)
