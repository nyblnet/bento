// Shared model → DOM renderer. One code path draws slides everywhere:
// editor canvas, sidebar thumbnails, and Reveal.js sections.

import type { BentoDoc, ShapeElement, Slide, SlideElement, SvgElement } from './model'
import { chartSnapshotSvg } from './charts'

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface RenderOpts {
  /** render svg elements as <img> (cheap DOM) — used by thumbnails */
  svgAsImage?: boolean
  /** hide empty placeholder text entirely — present mode and print */
  hidePlaceholders?: boolean
}

/** Resolve "asset:<key>" references against the document's asset table. */
export function resolveAsset(doc: BentoDoc, ref: string): string {
  return ref.startsWith('asset:') ? (doc.assets?.[ref.slice(6)] ?? '') : ref
}

function svgMarkup(el: SvgElement, doc: BentoDoc): string {
  return (el.asset ? doc.assets?.[el.asset] : el.markup) ?? ''
}

/**
 * Scope injected svg CSS to one element instance. svg <style> applies
 * document-wide, so unscoped rules from one diagram would leak into every
 * other svg on the page (including other slides' copies of the same asset).
 * @keyframes blocks stay top-level; everything else gets the scope prefix.
 */
export function scopeCss(css: string, scope: string): string {
  let out = ''
  let i = 0
  while (i < css.length) {
    const rest = css.slice(i)
    const at = rest.match(/^\s*@(keyframes|-webkit-keyframes)/)
    if (at) {
      // copy the whole block verbatim, tracking brace depth
      let depth = 0
      let j = i
      let seen = false
      while (j < css.length) {
        if (css[j] === '{') { depth++; seen = true }
        if (css[j] === '}') { depth--; if (seen && depth === 0) { j++; break } }
        j++
      }
      out += css.slice(i, j) + '\n'
      i = j
      continue
    }
    const open = css.indexOf('{', i)
    if (open === -1) break
    const close = css.indexOf('}', open)
    if (close === -1) break
    const selectors = css.slice(i, open).trim()
    if (selectors) {
      out += selectors.split(',').map((s) => `${scope} ${s.trim()}`).join(', ')
      out += ' ' + css.slice(open, close + 1) + '\n'
    }
    i = close + 1
  }
  return out
}

export function applyElementFrame(node: HTMLElement, el: SlideElement) {
  node.style.left = `${el.x}px`
  node.style.top = `${el.y}px`
  node.style.width = `${el.w}px`
  node.style.height = `${el.h}px`
  node.style.transform = el.rotation ? `rotate(${el.rotation}deg)` : ''
  node.style.opacity = String(el.opacity)
  node.style.filter = el.shadow
    ? `drop-shadow(${el.shadow.x ?? 0}px ${el.shadow.y ?? 0}px ${el.shadow.blur}px ${el.shadow.color})`
    : ''
}

// Gradient ids must be unique per rendered instance: the same element renders
// on the canvas, in sidebar thumbnails and in the present overlay, and svg
// url(#…) references resolve document-wide.
let gradSeq = 0

/** Gradient line endpoints (objectBoundingBox units) for a CSS-convention
 *  angle: 0deg points up, 90deg points right. Shared with morph tweening. */
export function gradientLineCoords(angle: number) {
  const rad = ((angle ?? 180) * Math.PI) / 180
  const dx = Math.sin(rad) / 2
  const dy = -Math.cos(rad) / 2
  return { x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy }
}

/** Materialize a GradientFill as a <defs> gradient; returns its url() ref. */
function gradientRef(svg: SVGSVGElement, g: NonNullable<ShapeElement['fillGradient']>): string {
  const id = `bento-grad-${gradSeq++}`
  const defs = document.createElementNS(SVG_NS, 'defs')
  const lin = document.createElementNS(SVG_NS, 'linearGradient')
  lin.setAttribute('id', id)
  const { x1, y1, x2, y2 } = gradientLineCoords(g.angle)
  lin.setAttribute('x1', String(x1))
  lin.setAttribute('y1', String(y1))
  lin.setAttribute('x2', String(x2))
  lin.setAttribute('y2', String(y2))
  for (const s of g.stops) {
    const stop = document.createElementNS(SVG_NS, 'stop')
    stop.setAttribute('offset', String(Math.min(Math.max(s.at, 0), 1)))
    stop.setAttribute('stop-color', s.color)
    lin.appendChild(stop)
  }
  defs.appendChild(lin)
  svg.appendChild(defs)
  return `url(#${id})`
}

/** stroke-dasharray for the element's line style (undefined = solid). */
function dashArray(el: ShapeElement, w: number): string | undefined {
  if (el.strokeStyle === 'dashed') return `${Math.max(w * 2.4, 7)} ${Math.max(w * 1.8, 5)}`
  if (el.strokeStyle === 'dotted') return `0.1 ${Math.max(w * 2.2, 5)}`
  if (el.strokeStyle === 'solid') return undefined
  if (el.strokeDash) return `${el.strokeDash} ${el.strokeDash}` // legacy numeric dash
  return undefined
}

let markSeq = 0

/** A line-tip marker in <defs>; sized in strokeWidth units, colored like the line. */
function markerRef(svg: SVGSVGElement, kind: NonNullable<ShapeElement['lineStart']>, color: string, start: boolean): string | null {
  if (kind === 'none') return null
  const id = `bento-mark-${markSeq++}`
  const marker = document.createElementNS(SVG_NS, 'marker')
  marker.setAttribute('id', id)
  marker.setAttribute('viewBox', '0 0 8 8')
  marker.setAttribute('refY', '4')
  marker.setAttribute('orient', start ? 'auto-start-reverse' : 'auto')
  marker.setAttribute('markerWidth', '5.5')
  marker.setAttribute('markerHeight', '5.5')
  let tip: SVGElement
  if (kind === 'arrow') {
    tip = document.createElementNS(SVG_NS, 'path')
    tip.setAttribute('d', 'M 0 0.4 L 7.6 4 L 0 7.6 Z')
    marker.setAttribute('refX', '6.4')
  } else if (kind === 'dot') {
    tip = document.createElementNS(SVG_NS, 'circle')
    tip.setAttribute('cx', '4')
    tip.setAttribute('cy', '4')
    tip.setAttribute('r', '2.6')
    marker.setAttribute('refX', '4')
  } else {
    tip = document.createElementNS(SVG_NS, 'rect')
    tip.setAttribute('x', '3.2')
    tip.setAttribute('y', '0.4')
    tip.setAttribute('width', '1.6')
    tip.setAttribute('height', '7.2')
    marker.setAttribute('refX', '4')
  }
  tip.setAttribute('fill', color)
  marker.appendChild(tip)
  let defs = svg.querySelector('defs')
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs')
    svg.appendChild(defs)
  }
  defs.appendChild(marker)
  return `url(#${id})`
}

export function shapeSvg(el: ShapeElement): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  const { w, h } = el
  const sw = el.strokeWidth
  const inset = sw / 2
  svg.setAttribute('viewBox', `0 0 ${Math.max(w, 1)} ${Math.max(h, 1)}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible'

  let node: SVGElement
  switch (el.shape) {
    case 'path': {
      // arbitrary vector data, stretched from its authored viewBox into the box
      if (el.pathBox) svg.setAttribute('viewBox', el.pathBox.join(' '))
      node = document.createElementNS(SVG_NS, 'path')
      node.setAttribute('d', el.d ?? '')
      if (sw > 0) node.setAttribute('vector-effect', 'non-scaling-stroke')
      break
    }
    case 'rect': {
      node = document.createElementNS(SVG_NS, 'rect')
      node.setAttribute('x', String(inset))
      node.setAttribute('y', String(inset))
      node.setAttribute('width', String(Math.max(w - sw, 0)))
      node.setAttribute('height', String(Math.max(h - sw, 0)))
      if (el.radius) node.setAttribute('rx', String(el.radius))
      break
    }
    case 'ellipse': {
      node = document.createElementNS(SVG_NS, 'ellipse')
      node.setAttribute('cx', String(w / 2))
      node.setAttribute('cy', String(h / 2))
      node.setAttribute('rx', String(Math.max(w / 2 - inset, 0)))
      node.setAttribute('ry', String(Math.max(h / 2 - inset, 0)))
      break
    }
    case 'triangle': {
      node = document.createElementNS(SVG_NS, 'polygon')
      node.setAttribute('points', `${w / 2},${inset} ${w - inset},${h - inset} ${inset},${h - inset}`)
      break
    }
    case 'arrow': {
      // right-pointing arrow: shaft + head, proportional to the box
      node = document.createElementNS(SVG_NS, 'polygon')
      const shaftH = h * 0.44
      const headW = Math.min(w * 0.38, h)
      const y0 = (h - shaftH) / 2
      node.setAttribute(
        'points',
        `0,${y0} ${w - headW},${y0} ${w - headW},0 ${w},${h / 2} ${w - headW},${h} ${w - headW},${y0 + shaftH} 0,${y0 + shaftH}`,
      )
      break
    }
    case 'line': {
      node = document.createElementNS(SVG_NS, 'line')
      const lw = Math.max(sw, 2)
      // inset the endpoints so tip decorations sit inside the element box
      const tipPad = (k?: string) => (k && k !== 'none' ? lw * 2.6 : 0)
      node.setAttribute('x1', String(tipPad(el.lineStart)))
      node.setAttribute('y1', String(h / 2))
      node.setAttribute('x2', String(w - tipPad(el.lineEnd)))
      node.setAttribute('y2', String(h / 2))
      node.setAttribute('stroke', el.fill)
      node.setAttribute('stroke-width', String(lw))
      node.setAttribute('stroke-linecap', el.strokeStyle === 'dashed' ? 'butt' : 'round')
      const lineDash = dashArray(el, lw)
      if (lineDash) node.setAttribute('stroke-dasharray', lineDash)
      const mStart = el.lineStart ? markerRef(svg, el.lineStart, el.fill, true) : null
      const mEnd = el.lineEnd ? markerRef(svg, el.lineEnd, el.fill, false) : null
      if (mStart) node.setAttribute('marker-start', mStart)
      if (mEnd) node.setAttribute('marker-end', mEnd)
      svg.appendChild(node)
      return svg
    }
  }
  node.setAttribute('fill', el.fillGradient?.stops.length ? gradientRef(svg, el.fillGradient) : el.fill)
  if (el.stroke && el.stroke !== 'transparent' && sw > 0) {
    node.setAttribute('stroke', el.stroke)
    node.setAttribute('stroke-width', String(sw))
    const dash = dashArray(el, sw)
    if (dash) node.setAttribute('stroke-dasharray', dash)
    if (el.strokeStyle === 'dotted') node.setAttribute('stroke-linecap', 'round')
  }
  svg.appendChild(node)
  return svg
}

const ALLOWED_TAGS = new Set(['B', 'I', 'U', 'BR', 'SPAN', 'DIV', 'P', 'STRONG', 'EM', 'S', 'CODE'])

/** Keep pasted/edited rich text down to a safe inline subset. */
export function sanitizeHtml(html: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const elChild = child as HTMLElement
        if (!ALLOWED_TAGS.has(elChild.tagName)) {
          // unwrap unknown elements, keep their text
          while (elChild.firstChild) node.insertBefore(elChild.firstChild, elChild)
          elChild.remove()
          continue
        }
        for (const attr of Array.from(elChild.attributes)) elChild.removeAttribute(attr.name)
        walk(elChild)
      } else if (child.nodeType !== Node.TEXT_NODE) {
        child.remove()
      }
    }
  }
  walk(tpl.content)
  const out = document.createElement('div')
  out.appendChild(tpl.content.cloneNode(true))
  return out.innerHTML
}

const VALIGN: Record<string, string> = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }

/**
 * Render one element. The wrapper carries data-el-id (edit-time selection)
 * and data-flip-id (GSAP Flip morph matching across slides).
 */
export function renderElement(el: SlideElement, doc: BentoDoc, opts: RenderOpts = {}): HTMLElement {
  const node = document.createElement('div')
  node.className = `bento-el bento-el-${el.type}`
  node.dataset.elId = el.id
  node.dataset.flipId = el.id
  if (el.link) node.dataset.link = el.link
  if (el.group) node.dataset.group = el.group
  if (el.showOnHover) node.dataset.showOnHover = el.showOnHover
  applyElementFrame(node, el)

  switch (el.type) {
    case 'text': {
      node.style.display = 'flex'
      node.style.flexDirection = 'column'
      node.style.justifyContent = VALIGN[el.valign]
      const inner = document.createElement('div')
      inner.className = 'bento-text-inner'
      inner.style.fontSize = `${el.fontSize}px`
      inner.style.fontFamily = el.fontFamily || doc.theme.fontFamily
      inner.style.fontWeight = String(el.fontWeight)
      inner.style.color = el.color
      inner.style.textAlign = el.align
      inner.style.lineHeight = String(el.lineHeight)
      if (el.letterSpacing) inner.style.letterSpacing = `${el.letterSpacing}px`
      inner.style.width = '100%'
      inner.innerHTML = sanitizeHtml(el.html)
      // layout placeholder: prompt while empty (editor), gone while presenting
      const isEmpty = !inner.textContent?.trim() && !el.html.includes('<img')
      if (el.placeholder && isEmpty) {
        if (opts.hidePlaceholders) {
          node.style.display = 'none'
        } else {
          inner.textContent = el.placeholder
          inner.style.opacity = '0.38'
        }
      }
      node.appendChild(inner)
      break
    }
    case 'shape':
      node.appendChild(shapeSvg(el))
      break
    case 'image': {
      const img = document.createElement('img')
      img.src = resolveAsset(doc, el.src)
      img.draggable = false
      img.style.cssText = `width:100%;height:100%;object-fit:${el.fit};border-radius:${el.radius}px;display:block`
      node.appendChild(img)
      break
    }
    case 'chart': {
      // Static SVG snapshot everywhere; present mode swaps in a live ECharts
      // instance (mountLiveCharts) for tooltips/zoom. Kept as innerHTML so
      // print and thumbnails need no chart runtime at render time.
      node.dataset.chart = '1'
      node.innerHTML = chartSnapshotSvg(el)
      const csvg = node.querySelector('svg')
      if (csvg) {
        csvg.setAttribute('preserveAspectRatio', 'none')
        csvg.style.cssText = 'width:100%;height:100%;display:block'
      }
      break
    }
    case 'svg': {
      const markup = svgMarkup(el, doc)
      if (opts.svgAsImage) {
        // thumbnails: one <img> instead of thousands of svg nodes
        const img = document.createElement('img')
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup)
        img.draggable = false
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block'
        node.appendChild(img)
        break
      }
      node.innerHTML = markup
      const svg = node.querySelector('svg')
      if (svg) {
        svg.style.width = '100%'
        svg.style.height = '100%'
        svg.style.display = 'block'
        if (el.css) {
          const style = document.createElementNS(SVG_NS, 'style')
          style.textContent = scopeCss(el.css, `[data-el-id="${CSS.escape(el.id)}"]`)
          svg.prepend(style)
        }
      }
      break
    }
  }
  return node
}

/** Render a full slide surface (background + elements) at model coordinates. */
export function renderSlide(slide: Slide, doc: BentoDoc, opts: RenderOpts = {}): HTMLElement {
  const surface = document.createElement('div')
  surface.className = 'bento-slide'
  surface.dataset.slideId = slide.id
  surface.style.width = `${doc.size.width}px`
  surface.style.height = `${doc.size.height}px`
  surface.style.background = slide.background
  for (const el of slide.elements) surface.appendChild(renderElement(el, doc, opts))
  return surface
}

/** Scaled-down live preview used for sidebar thumbnails. */
export function renderThumbnail(slide: Slide, doc: BentoDoc, width: number): HTMLElement {
  const scale = width / doc.size.width
  const box = document.createElement('div')
  box.className = 'bento-thumb-surface'
  box.style.width = `${width}px`
  box.style.height = `${doc.size.height * scale}px`
  const inner = renderSlide(slide, doc, { svgAsImage: true })
  inner.style.transformOrigin = '0 0'
  inner.style.transform = `scale(${scale})`
  box.appendChild(inner)
  return box
}
