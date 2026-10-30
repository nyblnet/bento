// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Export, at the foot of the Format tab: the selection — or the slide, when
// nothing is selected — as a PNG (1× or 2×), an SVG, or the Bento clipboard
// JSON. The pixels come from the slide-image export's renderer
// (editor/exportimages.ts); the JSON is exactly what ⌘C writes (clipboard.ts).
import { section, field } from './fields'
import { t } from '../../i18n'
import type { PropsPanel } from '../panels'
import type { Slide, SlideElement } from '../../model'
import { parseColor } from './controls'
import { rasterizeSlide, slideSvg, downloadBlob, type Box } from '../exportimages'
import { exportBase } from '../../exportimages'
import { serializeElements, serializeSlides } from '../clipboard'

/** The box the elements cover on the slide, rotation included. */
export function coverBox(els: SlideElement[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const e of els) {
    const a = ((e.rotation || 0) * Math.PI) / 180
    const cx = e.x + e.w / 2, cy = e.y + e.h / 2
    const hw = (Math.abs(Math.cos(a)) * e.w + Math.abs(Math.sin(a)) * e.h) / 2
    const hh = (Math.abs(Math.sin(a)) * e.w + Math.abs(Math.cos(a)) * e.h) / 2
    x0 = Math.min(x0, cx - hw); y0 = Math.min(y0, cy - hh)
    x1 = Math.max(x1, cx + hw); y1 = Math.max(y1, cy + hh)
  }
  // ponytail: shadows and blur that spill past the box are cut; pad here if that matters
  return { x: Math.floor(x0), y: Math.floor(y0), w: Math.max(1, Math.ceil(x1) - Math.floor(x0)), h: Math.max(1, Math.ceil(y1) - Math.floor(y0)) }
}

export function buildExport(p: PropsPanel, els: SlideElement[]) {
  section(p, t('Export'))
  const doc = p.store.doc
  const slide = p.store.slide
  // the selection alone, on no background, cropped to what it covers
  const subject = els.length ? { ...slide, background: 'transparent', elements: els } : slide
  const box = els.length ? coverBox(els) : undefined
  const name = (ext: string) => `${exportBase(doc)}${els.length ? `-${els.length === 1 ? (els[0].name || els[0].type) : 'selection'}` : ''}.${ext}`
  const failed = (e: unknown) => {
    if ((e as { name?: string }).name === 'SecurityError') p.toast(t('This slide links to an image on the web, which cannot be drawn into a file'))
    else throw e
  }
  const button = (label: string, run: () => void | Promise<void>) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-btn ed-export-btn'
    b.textContent = label
    b.addEventListener('click', () => { void Promise.resolve(run()).catch(failed) })
    return b
  }
  const png = (scale: 1 | 2) => button(`PNG ${scale}×`, async () =>
    downloadBlob(await rasterizeSlide(doc, subject, 'png', scale, box), name(scale === 2 ? '2x.png' : 'png')))
  // ponytail: the SVG wraps the render in a foreignObject (browsers draw it;
  // vector editors may not) — emit native shapes if someone needs to edit it
  const svg = button('SVG', () => {
    const v = box ?? { x: 0, y: 0, w: doc.size.width, h: doc.size.height }
    downloadBlob(new Blob([slideSvg(doc, subject, v.w, v.h, box)], { type: 'image/svg+xml' }), name('svg'))
  })
  const json = button(t('Copy as JSON'), async () => {
    await navigator.clipboard.writeText(els.length ? serializeElements(els, doc) : serializeSlides([slide], doc))
    p.toast(t('Copied — ⌘V pastes it into any Bento deck'))
  })
  const row = field(p, png(1), png(2), svg, json)
  row.classList.add('ed-export')
  if (els.length === 1) accessibility(p, els[0], slide)
}

/** WCAG 2 relative luminance of a #rrggbb. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}
/** The first solid colour in a paint (a gradient is judged by its first stop). */
const solid = (paint: string | undefined): string | null => {
  if (!paint || paint === 'transparent' || paint === 'none') return null
  const hex = /#[0-9a-f]{6}\b/i.exec(paint)?.[0]
  return hex ?? (parseColor(paint).a > 0 ? parseColor(paint).hex : null)
}

/**
 * What sits behind `el`: the topmost filled shape below it in paint order whose
 * box holds its centre (a card, a frame), else the slide background.
 * ponytail: one sample at the centre, opacity ignored — a deck-wide audit is test-slides-accent-contrast
 */
export function backdropOf(el: SlideElement, slide: Slide): string | null {
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2
  const below = slide.elements.slice(0, slide.elements.findIndex((e) => e.id === el.id)).reverse()
  for (const e of below) {
    if (e.hidden || e.type !== 'shape' || cx < e.x || cx > e.x + e.w || cy < e.y || cy > e.y + e.h) continue
    const c = solid(e.fillGradient?.stops[0]?.color ?? e.fill)
    if (c) return c
  }
  return solid(slide.background)
}

/** The selection's contrast against what is behind it, graded, and its alt text. */
function accessibility(p: PropsPanel, el: SlideElement, slide: Slide) {
  const fg = el.type === 'text' ? solid(el.colorGradient?.stops[0]?.color ?? el.color)
    : el.type === 'shape' ? solid(el.fillGradient?.stops[0]?.color ?? (el.fill === 'none' ? el.stroke : el.fill))
    : null
  const bg = backdropOf(el, slide)
  if (fg && bg) {
    const ratio = contrastRatio(fg, bg)
    // WCAG 2.2: text 4.5 (AA) / 7 (AAA), large text (≥24px, or ≥18.66px bold) 3 / 4.5; graphics 3 (AA)
    const large = el.type === 'text' && (el.fontSize >= 24 || (el.fontSize >= 18.66 && el.fontWeight >= 700))
    const [aa, aaa] = el.type !== 'text' ? [3, Infinity] : large ? [3, 4.5] : [4.5, 7]
    const grade = ratio >= aaa ? 'AAA' : ratio >= aa ? 'AA' : t('Fails')
    const out = document.createElement('div')
    out.className = 'ed-a11y'
    const value = document.createElement('span')
    value.textContent = t('Contrast {ratio}:1', { ratio: ratio.toFixed(2) })
    const badge = document.createElement('span')
    badge.className = `ed-a11y-badge ${ratio >= aa ? 'is-pass' : 'is-fail'}`
    badge.textContent = grade
    out.title = el.type === 'text'
      ? t('Against what is behind it. Text needs {aa}:1 for AA and {aaa}:1 for AAA.', { aa, aaa })
      : t('Against what is behind it. Shapes and icons need 3:1.')
    out.append(value, badge)
    p.host.appendChild(out)
  }
  if (el.type === 'text') return
  const alt = document.createElement('input')
  alt.type = 'text'
  alt.className = 'ed-a11y-alt'
  alt.value = el.alt ?? ''
  alt.placeholder = t('Describe it for screen readers')
  alt.setAttribute('aria-label', t('Alternative text'))
  alt.addEventListener('change', () => p.mutate(el.id, (e) => {
    const v = alt.value.trim()
    if (v) e.alt = v
    else delete e.alt
  }, true))
  field(p, alt)
}
