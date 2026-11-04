// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Export, at the foot of the Format tab: the selection — or the slide, when
// nothing is selected — as a PNG (1× or 2×), an SVG, or the Bento clipboard
// JSON. The pixels come from the slide-image export's renderer
// (editor/exportimages.ts); the JSON is exactly what ⌘C writes (clipboard.ts).
import { section, field, labeledSelect, opBtn } from './fields'
import { ICONS } from '../../icons'
import { openCtxMenu } from '../ctxmenu'
import { labelIn } from '../layerrows'
import { t } from '../../i18n'
import type { PropsPanel } from '../panels'
import type { Slide, SlideElement } from '../../model'
import { measureContrast, type Area } from './contrast'
import { rasterizeSlide, downloadBlob, type Box } from '../exportimages'
import type { ImageScale } from '../../exportimages'
import { nativeSlideSvg } from '../svgexport'
import { exportBase } from '../../exportimages'
import { serializeElements, serializeSlides } from '../clipboard'
import { withDescendants } from '../../layout'
import { ALT_TYPES } from '../../render'

/**
 * How far an element's paint spills past its box, per side [left, top, right,
 * bottom]: a shadow (filter: drop-shadow() — its blur IS the Gaussian's σ,
 * and 3σ is where it fades out, shifted by the offset),
 * a layer blur (σ = blur, 3σ), and a stroke drawn centred or outside.
 */
export function overflowOf(e: SlideElement): [number, number, number, number] {
  let [l, t, r, b] = [0, 0, 0, 0]
  const grow = (dl: number, dt: number, dr: number, db: number) => { l = Math.max(l, dl); t = Math.max(t, dt); r = Math.max(r, dr); b = Math.max(b, db) }
  for (const s of Array.isArray(e.shadow) ? e.shadow : e.shadow ? [e.shadow] : []) {
    const k = 3 * (s.blur || 0), dx = s.x ?? 0, dy = s.y ?? 0
    grow(k - dx, k - dy, k + dx, k + dy)
  }
  const sw = e.type === 'shape' ? Math.max(e.strokeWidth || 0, ...(e.strokes ?? []).filter((x) => !x.hidden).map((x) => x.width || 0)) : 0
  if (sw && e.type === 'shape') {
    const pad = e.shape === 'line' ? sw * 2 : e.strokeAlign === 'outside' ? sw : e.strokeAlign === 'inside' ? 0 : sw / 2 // a line's tips reach ~2 widths
    l += pad; t += pad; r += pad; b += pad
  }
  if (e.blur) { const k = 3 * e.blur; l += k; t += k; r += k; b += k }
  return [l, t, r, b].map((v) => Math.max(0, v)) as [number, number, number, number]
}

/** The box the elements cover on the slide — rotation included, and their shadows, blur and strokes. */
export function coverBox(els: SlideElement[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const e of els) {
    const a = ((e.rotation || 0) * Math.PI) / 180
    const cx = e.x + e.w / 2, cy = e.y + e.h / 2
    const hw = (Math.abs(Math.cos(a)) * e.w + Math.abs(Math.sin(a)) * e.h) / 2
    const hh = (Math.abs(Math.sin(a)) * e.w + Math.abs(Math.cos(a)) * e.h) / 2
    // ponytail: the spill is added in slide axes after turning, so a turned element's shadow pad is generous, never short
    const [l, t, r, b] = overflowOf(e)
    const m = a ? Math.max(l, t, r, b) : 0
    x0 = Math.min(x0, cx - hw - (m || l)); y0 = Math.min(y0, cy - hh - (m || t))
    x1 = Math.max(x1, cx + hw + (m || r)); y1 = Math.max(y1, cy + hh + (m || b))
  }
  return { x: Math.floor(x0), y: Math.floor(y0), w: Math.max(1, Math.ceil(x1) - Math.floor(x0)), h: Math.max(1, Math.ceil(y1) - Math.floor(y0)) }
}

/** The export setting: Figma's row — a scale and a format. */
interface ExportSetting { scale: ImageScale; format: 'png' | 'jpeg' | 'svg' }
const SCALES: ImageScale[] = [0.5, 1, 1.5, 2, 3, 4]
/** The last setting used, for the session — editor state, never written into
 *  the file. One setting, not a list: rows that could be added and removed
 *  only made a way to end up with no export at all. */
const setting: ExportSetting = { scale: 1, format: 'png' }

export function buildExport(p: PropsPanel, els: SlideElement[]) {
  const doc = p.store.doc
  const slide = p.store.slide
  // Figma's Export, fixed: one setting row (scale · format · ⋯) and one
  // full-width button that exports it
  section(p, t('Export'))
  // the selection alone, on no background, cropped to what it covers. A
  // frame is its contents too (withDescendants, as ⌘C copies it).
  const ids = new Set(withDescendants(slide, els).map((e) => e.id))
  // A child of a clipping frame exports clipped: its frame rides along at 0%
  // (renderSlide resolves clips through every element). Not `hidden`: a
  // hidden frame hides what is inside it, which was the whole export.
  const riders = new Map(slide.elements.filter((f) => !ids.has(f.id) && slide.elements.some((e) => ids.has(e.id) && e.parentId === f.id)).map((f) => [f.id, { ...f, opacity: 0 }]))
  // in the slide's paint order: the selection's own order (the order it was
  // picked in) would draw a card's text under the card
  const unit = slide.elements.filter((e) => ids.has(e.id) || riders.has(e.id)).map((e) => riders.get(e.id) ?? e)
  const subject = (opaque: boolean) => els.length ? { ...slide, background: opaque ? slide.background : 'transparent', elements: unit } : slide
  const box = els.length ? coverBox(els) : undefined
  const what = els.length === 1 ? labelIn(slide, els[0], t) : els.length ? t('{n} elements', { n: els.length }) : t('Slide {n}', { n: p.store.currentIndex + 1 })
  const fileBase = `${exportBase(doc)}${els.length ? `-${els.length === 1 ? (els[0].name || els[0].type) : 'selection'}` : ''}`
  const name = (s: ExportSetting) => `${fileBase}${s.format !== 'svg' && s.scale !== 1 ? `@${s.scale}x` : ''}.${s.format === 'jpeg' ? 'jpg' : s.format}`
  const failed = (e: unknown) => {
    if ((e as { name?: string }).name === 'SecurityError') p.toast(t('This slide links to an image on the web, which cannot be drawn into a file'))
    else throw e
  }
  const one = async (s: ExportSetting) => s.format === 'svg'
    // native vectors (svgexport.ts): opens as editable shapes and text in Figma, Illustrator, Inkscape
    ? downloadBlob(new Blob([await nativeSlideSvg(doc, subject(false), box)], { type: 'image/svg+xml' }), name(s))
    // a JPEG has no transparency: the selection sits on its slide's background
    : downloadBlob(await rasterizeSlide(doc, subject(s.format === 'jpeg'), s.format, s.scale, box), name(s))

  const rows = document.createElement('div')
  rows.className = 'ed-export-rows'
  {
    const s = setting
    const row = document.createElement('div')
    row.className = 'ed-export-row'
    const scale = labeledSelect(SCALES.map((k) => [String(k), `${k}x`]), String(s.scale), (v) => { s.scale = Number(v) as ImageScale; p.rebuild(true) })
    scale.setAttribute('aria-label', t('Scale'))
    scale.disabled = s.format === 'svg' // a vector has no scale
    const format = labeledSelect([['png', 'PNG'], ['jpeg', 'JPG'], ['svg', 'SVG']], s.format, (v) => { s.format = v as ExportSetting['format']; p.rebuild(true) })
    format.setAttribute('aria-label', t('Format'))
    const more = opBtn(ICONS.more, t('More export options'), () => {
      const r = more.getBoundingClientRect()
      openCtxMenu(r.left, r.bottom + 4, [
        { label: t('Copy as JSON'), run: () => { void copyJson() } },
      ])
    })
    more.setAttribute('aria-haspopup', 'menu')
    row.append(scale, format, more)
    rows.appendChild(row)
  }
  const copyJson = async () => {
    await navigator.clipboard.writeText(els.length ? serializeElements(withDescendants(slide, els), doc) : serializeSlides([slide], doc))
    p.toast(t('Copied — ⌘V pastes it into any Bento deck'))
  }
  {
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'ed-btn ed-export-btn'
    go.textContent = t('Export {what}', { what })
    go.addEventListener('click', () => { void one(setting).catch(failed) })
    // nothing visible to draw: say so instead of handing over an empty picture
    if (els.length && els.every((e) => e.hidden)) { go.disabled = true; go.title = t('Hidden elements are not drawn — show one in Layers to export it') }
    rows.appendChild(go)
  }
  p.host.appendChild(rows)
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
  if (!ALT_TYPES.has(el.type)) return
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
