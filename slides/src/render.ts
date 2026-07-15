// Shared model → DOM renderer. One code path draws slides everywhere:
// editor canvas, sidebar thumbnails, and Reveal.js sections.

import type { BentoDoc, ShapeElement, Slide, SlideElement } from './model'

const SVG_NS = 'http://www.w3.org/2000/svg'

export function applyElementFrame(node: HTMLElement, el: SlideElement) {
  node.style.left = `${el.x}px`
  node.style.top = `${el.y}px`
  node.style.width = `${el.w}px`
  node.style.height = `${el.h}px`
  node.style.transform = el.rotation ? `rotate(${el.rotation}deg)` : ''
  node.style.opacity = String(el.opacity)
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
      node.setAttribute('x1', '0')
      node.setAttribute('y1', String(h / 2))
      node.setAttribute('x2', String(w))
      node.setAttribute('y2', String(h / 2))
      node.setAttribute('stroke', el.fill)
      node.setAttribute('stroke-width', String(Math.max(sw, 2)))
      node.setAttribute('stroke-linecap', 'round')
      svg.appendChild(node)
      return svg
    }
  }
  node.setAttribute('fill', el.fill)
  if (el.stroke && el.stroke !== 'transparent' && sw > 0) {
    node.setAttribute('stroke', el.stroke)
    node.setAttribute('stroke-width', String(sw))
    if (el.strokeDash) node.setAttribute('stroke-dasharray', `${el.strokeDash} ${el.strokeDash}`)
  }
  svg.appendChild(node)
  return svg
}

const ALLOWED_TAGS = new Set(['B', 'I', 'U', 'BR', 'SPAN', 'DIV', 'P', 'STRONG', 'EM'])

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
export function renderElement(el: SlideElement, doc: BentoDoc): HTMLElement {
  const node = document.createElement('div')
  node.className = `bento-el bento-el-${el.type}`
  node.dataset.elId = el.id
  node.dataset.flipId = el.id
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
      node.appendChild(inner)
      break
    }
    case 'shape':
      node.appendChild(shapeSvg(el))
      break
    case 'image': {
      const img = document.createElement('img')
      img.src = el.src
      img.draggable = false
      img.style.cssText = `width:100%;height:100%;object-fit:${el.fit};border-radius:${el.radius}px;display:block`
      node.appendChild(img)
      break
    }
  }
  return node
}

/** Render a full slide surface (background + elements) at model coordinates. */
export function renderSlide(slide: Slide, doc: BentoDoc): HTMLElement {
  const surface = document.createElement('div')
  surface.className = 'bento-slide'
  surface.dataset.slideId = slide.id
  surface.style.width = `${doc.size.width}px`
  surface.style.height = `${doc.size.height}px`
  surface.style.background = slide.background
  for (const el of slide.elements) surface.appendChild(renderElement(el, doc))
  return surface
}

/** Scaled-down live preview used for sidebar thumbnails. */
export function renderThumbnail(slide: Slide, doc: BentoDoc, width: number): HTMLElement {
  const scale = width / doc.size.width
  const box = document.createElement('div')
  box.className = 'bento-thumb-surface'
  box.style.width = `${width}px`
  box.style.height = `${doc.size.height * scale}px`
  const inner = renderSlide(slide, doc)
  inner.style.transformOrigin = '0 0'
  inner.style.transform = `scale(${scale})`
  box.appendChild(inner)
  return box
}
