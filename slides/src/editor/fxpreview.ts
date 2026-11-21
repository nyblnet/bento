// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Hover previews on the canvas: pointing at a Shadow preset or an entrance
// effect in the inspector shows it on the selected element before you choose
// it. Nothing is written: the live canvas node is restyled or animated, and
// leaving restores it. The canvas re-renders on the next edit anyway.

import type { ShadowSpec, SlideElement } from '../model'
import { renderElement } from '../render'
import { enterSpec } from '../present'
import type { BentoDoc } from '../model'

const node = (id: string) => document.querySelector<HTMLElement>(`.ed-stage-scale [data-el-id="${CSS.escape(id)}"]`)
let restore: (() => void) | null = null

/** Stop any preview and put the node back as it was. */
export function endPreview() { restore?.(); restore = null }

/** The element as it would look with this shadow: the renderer's own filter. */
export function previewShadow(el: SlideElement, doc: BentoDoc, shadow: ShadowSpec | ShadowSpec[]) {
  endPreview()
  const n = node(el.id)
  if (!n) return
  const before = n.style.filter
  n.style.filter = renderElement({ ...el, shadow } as SlideElement, doc).style.filter
  restore = () => { n.style.filter = before }
}

// anim.ts ease names → their CSS curves, for the Web Animations API
const EASE: Record<string, string> = { 'power3.out': 'cubic-bezier(0.22, 1, 0.36, 1)', 'power2.out': 'cubic-bezier(0.33, 1, 0.68, 1)' }

/** Play the entrance on the element, once, as the show would (minus the stagger). */
export function previewEnter(el: SlideElement, kind: Parameters<typeof enterSpec>[0]) {
  endPreview()
  const n = node(el.id)
  if (!n) return
  const s = enterSpec(kind, el.fx?.enterDur)
  // `translate` composes with the frame's own transform (rotation), so the
  // node's frame is never touched
  const a = n.animate(
    [{ opacity: 0, translate: `${s.from.x}px ${s.from.y}px` }, { opacity: el.opacity ?? 1, translate: '0 0' }],
    { duration: s.duration * 1000, easing: EASE[s.ease] ?? 'ease-out' },
  )
  restore = () => a.cancel()
}
