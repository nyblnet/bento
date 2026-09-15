// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Crop mode for a picture (discussion #319): double-click an image and the
 * frame becomes a window onto the whole picture. The full picture shows
 * dimmed around the frame; drag pans it, wheel or pinch zooms about the
 * pointer, Enter (or a click outside the frame) commits ONE undo step, Esc
 * puts back what was there on entry. The model is `ImageCrop` (model.ts);
 * the numbers are written live into the element while the gesture runs and
 * the <img> restyled through crop.ts — the same mapping the renderer uses —
 * so what you see while dragging is exactly what commits. Mirrors the path
 * editor's lifecycle (patheditor.ts): start / commit / cancel, `active`,
 * an overlay in the scaled stage, Moveable hidden while it runs.
 */

import type { Store } from '../store'
import type { ImageCrop, ImageElement } from '../model'
import { CROP_MAX_SCALE, cropImgStyle, normalizeCrop } from '../crop'
import { resolveAsset } from '../render'
import { t } from '../i18n'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export class CropEditor {
  private overlay: HTMLElement | null = null
  private ghost: HTMLImageElement | null = null
  private hint: HTMLElement | null = null
  private elId = ''
  private entry: ImageCrop | undefined
  private crop: ImageCrop = { x: 0.5, y: 0.5, scale: 1 }
  /** the picture's natural size, once known (the ghost needs it) */
  private nat: { w: number; h: number } | null = null
  private pointers = new Map<number, { x: number; y: number }>()
  private pinch: { dist: number; scale: number } | null = null
  private keyHandler = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.cancel() }
    else if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); this.commit() }
  }

  constructor(
    private scaleHost: HTMLElement,
    private store: Store,
    private scaleOf: () => number,
    private onDone: () => void,
  ) {}

  get active() { return !!this.overlay }
  get editingId() { return this.active ? this.elId : null }

  start(elId: string) {
    this.cancel()
    const el = this.store.element(elId)
    if (!el || el.type !== 'image') return
    this.elId = elId
    this.entry = el.crop ? { ...el.crop } : undefined
    this.crop = normalizeCrop(el.crop) ?? { x: 0.5, y: 0.5, scale: 1 }
    this.nat = null

    const { width, height } = this.store.doc.size
    const ov = document.createElement('div')
    ov.className = 'ed-cropedit'
    ov.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;z-index:50;touch-action:none;cursor:grab`
    // the dimmed whole picture, placed by geometry() once the size is known
    const ghost = document.createElement('img')
    ghost.className = 'ed-cropedit-ghost'
    ghost.draggable = false
    ghost.style.cssText = 'position:absolute;opacity:0.45;pointer-events:none;display:none;max-width:none'
    const src = resolveAsset(this.store.doc, el.src)
    ghost.addEventListener('load', () => {
      this.nat = { w: ghost.naturalWidth || 1, h: ghost.naturalHeight || 1 }
      this.draw()
    })
    if (src) ghost.src = src
    ov.appendChild(ghost)
    // the frame outline
    const frame = document.createElement('div')
    frame.className = 'ed-cropedit-frame'
    frame.style.cssText = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;` +
      `transform:${el.rotation ? `rotate(${el.rotation}deg)` : 'none'};box-shadow:0 0 0 2px #5B8DEF;pointer-events:none;box-sizing:border-box`
    ov.appendChild(frame)

    ov.addEventListener('pointerdown', (ev) => this.onDown(ev))
    ov.addEventListener('pointermove', (ev) => this.onMove(ev))
    ov.addEventListener('pointerup', (ev) => this.onUp(ev))
    ov.addEventListener('pointercancel', (ev) => this.onUp(ev))
    ov.addEventListener('wheel', (ev) => this.onWheel(ev), { passive: false })
    ov.addEventListener('dblclick', (ev) => { ev.preventDefault(); ev.stopPropagation(); this.commit() })
    document.addEventListener('keydown', this.keyHandler, true)
    this.scaleHost.appendChild(ov)
    this.overlay = ov
    this.ghost = ghost

    this.hint = document.createElement('div')
    this.hint.className = 'ed-setbar ed-pathbar'
    this.hint.innerHTML = `<span class="ed-setbar-label">${t('Crop — drag to move the picture inside its frame · scroll or pinch to zoom · Enter to keep · Esc to put it back')}</span>`
    const done = document.createElement('button')
    done.className = 'ed-setchip active'
    done.textContent = t('Done')
    done.addEventListener('click', () => this.commit())
    this.hint.appendChild(done)
    this.scaleHost.closest('.ed-canvas-wrap')?.appendChild(this.hint)
    this.apply()
    this.draw()
  }

  /** One undo step carrying the final numbers; identity = no field. */
  commit() {
    if (!this.overlay) return
    const el = this.store.element(this.elId)
    const final = { ...this.crop }
    const entry = this.entry
    this.teardown()
    if (!el || el.type !== 'image') return
    // put the live element back to what it was, then commit the change once
    if (entry) el.crop = entry; else delete el.crop
    const identity = final.scale === 1 && final.x === 0.5 && final.y === 0.5
    const same = identity ? !entry : !!entry && entry.x === final.x && entry.y === final.y && entry.scale === final.scale
    if (!same) {
      this.store.commit(() => {
        const cur = this.store.element(this.elId)
        if (!cur || cur.type !== 'image') return
        if (identity) delete cur.crop
        else cur.crop = final
      })
    }
    this.onDone()
  }

  /** Esc: what was there on entry comes back; nothing is committed. */
  cancel() {
    if (!this.overlay) return
    const el = this.store.element(this.elId)
    const entry = this.entry
    this.teardown()
    if (el && el.type === 'image') {
      if (entry) el.crop = entry; else delete el.crop
      this.restyle(el)
    }
    this.onDone()
  }

  private teardown() {
    document.removeEventListener('keydown', this.keyHandler, true)
    this.overlay?.remove()
    this.hint?.remove()
    this.overlay = null
    this.ghost = null
    this.hint = null
    this.pointers.clear()
    this.pinch = null
  }

  // --- geometry ---------------------------------------------------------------

  /** The enlarged picture's box in slide px, relative to the frame's top-left. */
  private geometry(el: ImageElement) {
    const nat = this.nat ?? { w: el.w, h: el.h }
    const k = Math.max(el.w / nat.w, el.h / nat.h) * this.crop.scale // cover, then zoom
    const pw = nat.w * k
    const ph = nat.h * k
    return { pw, ph, left: -(pw - el.w) * this.crop.x, top: -(ph - el.h) * this.crop.y }
  }

  private draw() {
    const el = this.store.element(this.elId)
    if (!this.ghost || !el || el.type !== 'image' || !this.nat) return
    const g = this.geometry(el)
    this.ghost.style.display = 'block'
    this.ghost.style.left = `${el.x + g.left}px`
    this.ghost.style.top = `${el.y + g.top}px`
    this.ghost.style.width = `${g.pw}px`
    this.ghost.style.height = `${g.ph}px`
    this.ghost.style.transform = el.rotation ? `rotate(${el.rotation}deg)` : ''
    this.ghost.style.transformOrigin = `${-g.left + el.w / 2}px ${-g.top + el.h / 2}px`
  }

  /** Write the live numbers into the element and restyle its <img>. */
  private apply() {
    const el = this.store.element(this.elId)
    if (!el || el.type !== 'image') return
    el.crop = { ...this.crop }
    this.restyle(el)
  }

  private restyle(el: ImageElement) {
    const node = this.scaleHost.querySelector<HTMLElement>(`.bento-el[data-el-id="${CSS.escape(el.id)}"]`)
    const img = node?.querySelector('img')
    if (!node || !img) return
    const identity = !el.crop || (el.crop.scale === 1 && el.crop.x === 0.5 && el.crop.y === 0.5)
    if (identity) {
      node.style.overflow = ''
      node.style.borderRadius = ''
      img.style.cssText = `width:100%;height:100%;object-fit:${el.fit};border-radius:${el.radius}px;display:block`
    } else {
      node.style.overflow = 'hidden'
      node.style.borderRadius = `${el.radius}px`
      img.style.cssText = cropImgStyle(el.crop!)
    }
  }

  // --- gestures ---------------------------------------------------------------

  private slidePoint(ev: PointerEvent | WheelEvent) {
    const r = this.overlay!.getBoundingClientRect()
    const s = this.scaleOf()
    return { x: (ev.clientX - r.left) / s, y: (ev.clientY - r.top) / s }
  }

  private inFrame(p: { x: number; y: number }, el: ImageElement) {
    return p.x >= el.x && p.x <= el.x + el.w && p.y >= el.y && p.y <= el.y + el.h
  }

  private onDown(ev: PointerEvent) {
    const el = this.store.element(this.elId)
    if (!el || el.type !== 'image' || !this.overlay) return
    const p = this.slidePoint(ev)
    // a click outside the frame is "done" (like clicking away from a text edit)
    if (this.pointers.size === 0 && !this.inFrame(p, el) && ev.pointerType !== 'touch') { this.commit(); return }
    ev.preventDefault()
    this.overlay.setPointerCapture(ev.pointerId)
    this.pointers.set(ev.pointerId, p)
    this.overlay.style.cursor = 'grabbing'
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: this.crop.scale }
    }
  }

  private onMove(ev: PointerEvent) {
    const prev = this.pointers.get(ev.pointerId)
    const el = this.store.element(this.elId)
    if (!prev || !el || el.type !== 'image') return
    const p = this.slidePoint(ev)
    this.pointers.set(ev.pointerId, p)
    if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      this.zoomTo(el, this.pinch.scale * (d / this.pinch.dist), mid)
      return
    }
    this.pan(el, p.x - prev.x, p.y - prev.y)
  }

  private onUp(ev: PointerEvent) {
    this.pointers.delete(ev.pointerId)
    if (this.pointers.size < 2) this.pinch = null
    if (this.pointers.size === 0 && this.overlay) this.overlay.style.cursor = 'grab'
  }

  private onWheel(ev: WheelEvent) {
    const el = this.store.element(this.elId)
    if (!el || el.type !== 'image') return
    ev.preventDefault()
    ev.stopPropagation()
    const factor = Math.exp(-ev.deltaY * 0.0025)
    this.zoomTo(el, this.crop.scale * factor, this.slidePoint(ev))
  }

  /** Move the picture by (dx, dy) slide px: the frame's edge fractions move
   *  the opposite way, by the pan range on each axis. */
  private pan(el: ImageElement, dx: number, dy: number) {
    const g = this.geometry(el)
    const rx = g.pw - el.w
    const ry = g.ph - el.h
    if (rx > 0) this.crop.x = clamp(this.crop.x - dx / rx, 0, 1)
    if (ry > 0) this.crop.y = clamp(this.crop.y - dy / ry, 0, 1)
    this.apply(); this.draw()
  }

  /** Zoom to `scale` keeping the picture point under `at` (slide coords) still. */
  private zoomTo(el: ImageElement, scale: number, at: { x: number; y: number }) {
    const before = this.geometry(el)
    const px = clamp(at.x - el.x, 0, el.w)
    const py = clamp(at.y - el.y, 0, el.h)
    // the picture point under the pointer, as a fraction of the picture
    const u = (px - before.left) / before.pw
    const v = (py - before.top) / before.ph
    this.crop.scale = clamp(scale, 1, CROP_MAX_SCALE)
    const after = this.geometry(el)
    const rx = after.pw - el.w
    const ry = after.ph - el.h
    // solve left = px − u·pw for x: left = −rx·x
    this.crop.x = rx > 0 ? clamp((u * after.pw - px) / rx, 0, 1) : 0.5
    this.crop.y = ry > 0 ? clamp((v * after.ph - py) / ry, 0, 1) : 0.5
    this.apply(); this.draw()
  }
}
