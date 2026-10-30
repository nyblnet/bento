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
import { measureContrast, type Area } from './contrast'
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

/**
 * The boxes a text's glyphs fill, one per rendered line, in slide px of the
 * element's own frame — read off the canvas render. A turned text's line
 * boxes come back as screen-axis bounds, so it is measured unturned: the
 * canvas node is un-rotated for the read and restored at once (no paint).
 */
function glyphAreas(el: SlideElement, slideW: number): Area[] | undefined {
  const node = document.querySelector<HTMLElement>(`.ed-stage-scale [data-el-id="${CSS.escape(el.id)}"]`)
  const stage = document.querySelector<HTMLElement>('.ed-stage-scale')
  if (!node || !stage) return undefined
  const prev = node.style.transform
  node.style.transform = 'none'
  try {
    const box = node.getBoundingClientRect()
    const k = box.width / (el.w || 1) || stage.getBoundingClientRect().width / slideW
    // text nodes only: a range over the whole node also returns its block
    // wrappers' full-width boxes, which are exactly the empty corners
    const rects: DOMRect[] = []
    const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      if (!t.textContent?.trim()) continue
      range.selectNodeContents(t)
      rects.push(...range.getClientRects())
    }
    const areas = rects
      .filter((r) => r.width > 0.5 && r.height > 0.5)
      .map((r) => ({ x: el.x + (r.left - box.left) / k, y: el.y + (r.top - box.top) / k, w: r.width / k, h: r.height / k }))
    return areas.length ? areas : undefined
  } finally {
    node.style.transform = prev
  }
}

/** Where the weakest point sits: rows top → bottom, columns left → right. Translated at render. */
const WHERE = [
  ['top left', 'top', 'top right'],
  ['left', 'centre', 'right'],
  ['bottom left', 'bottom', 'bottom right'],
]

/** The selection's contrast against what is behind it, graded, and its alt text. */
function accessibility(p: PropsPanel, el: SlideElement, slide: Slide) {
  const reading = measureContrast(el, slide, 5, el.type === 'text' ? glyphAreas(el, p.store.doc.size.width) : undefined)
  if (reading) {
    const ratio = reading.ratio
    // WCAG 2.2: text 4.5 (AA) / 7 (AAA), large text (≥24px, or ≥18.66px bold) 3 / 4.5; graphics 3 (AA)
    const large = el.type === 'text' && (el.fontSize >= 24 || (el.fontSize >= 18.66 && el.fontWeight >= 700))
    const [aa, aaa] = el.type !== 'text' ? [3, Infinity] : large ? [3, 4.5] : [4.5, 7]
    const grade = ratio >= aaa ? 'AAA' : ratio >= aa ? 'AA' : t('Fails')
    const out = document.createElement('div')
    out.className = 'ed-a11y'
    const value = document.createElement('span')
    // the weakest of a 5×5 grid of points, and where it is when the element is not uniform
    value.textContent = t('Contrast {ratio}:1', { ratio: ratio.toFixed(2) })
    const spread = Math.max(...reading.samples) - ratio > 0.05
    if (spread) value.textContent += ` · ${t(WHERE[reading.at[1]][reading.at[0]])}`
    const badge = document.createElement('span')
    badge.className = `ed-a11y-badge ${ratio >= aa ? 'is-pass' : 'is-fail'}`
    badge.textContent = grade
    out.title = el.type === 'text'
      ? t('The weakest point against what is behind it, opacity and gradients included. Text needs {aa}:1 for AA and {aaa}:1 for AAA.', { aa, aaa })
      : t('The weakest point against what is behind it, opacity and gradients included. Shapes and icons need 3:1.')
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
