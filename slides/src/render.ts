// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Shared model → DOM renderer. One code path draws slides everywhere:
// editor canvas, sidebar thumbnails, and Reveal.js sections.

import type { BentoDoc, ShapeElement, Slide, SlideElement, SvgElement, TableElement } from './model'
import { morphKey, paginates } from './model'
import { chartSnapshotSvg } from './charts'
import temml from 'temml'

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface RenderOpts {
  /** render svg elements as <img> (cheap DOM) — used by thumbnails */
  svgAsImage?: boolean
  /** hide empty placeholder text entirely — present mode and print */
  hidePlaceholders?: boolean
  /** media (video/audio) accepts pointer input — PRESENT only. On the editor
   *  canvas it stays inert so its native controls don't swallow selection. */
  liveMedia?: boolean
  /** dynamic-field values ({{page}} etc.) for this slide; auto-filled by renderSlide */
  fields?: FieldContext
}

/** Values dynamic field tokens resolve against, computed per slide. */
export interface FieldContext {
  page: number; pages: number; title: string; date: Date
  author: string; company: string; subject: string; event: string
}

/** Field context for a slide: page = 1-based position among non-state slides. */
export function fieldContext(doc: BentoDoc, slide: Slide): FieldContext {
  const idx = doc.slides.indexOf(slide)
  const upto = idx < 0 ? doc.slides : doc.slides.slice(0, idx + 1)
  const m = doc.meta ?? {}
  return {
    page: upto.filter((s) => paginates(s, doc)).length,
    pages: doc.slides.filter((s) => paginates(s, doc)).length,
    title: doc.title,
    date: new Date(),
    author: m.author ?? '',
    company: m.company ?? '',
    subject: m.subject ?? '',
    event: m.event ?? '',
  }
}

const escapeFieldText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Resolve dynamic field tokens in text: {{page}}, {{pages}}, {{title}},
 * {{date}}, {{time}}, plus the document-property fields {{author}}, {{company}},
 * {{subject}}, {{event}}. page/pages take an optional zero-pad width — {{page:2}}
 * → "06". The MODEL stores the raw token; only rendered output is resolved, so
 * inserting/removing slides re-numbers everything and editing doc properties
 * updates every slide automatically. Groundwork for the wider office suite.
 */
export function resolveFields(html: string, ctx?: FieldContext): string {
  if (!ctx || html.indexOf('{{') < 0) return html
  const pad = (n: number, arg?: string) => { const w = parseInt(arg ?? '', 10); return w > 0 ? String(n).padStart(w, '0') : String(n) }
  return html.replace(/\{\{\s*(page|pages|title|date|time|author|company|subject|event)(?::([^}]*))?\s*\}\}/gi, (_m, name: string, arg?: string) => {
    switch (name.toLowerCase()) {
      case 'page': return pad(ctx.page, arg)
      case 'pages': return pad(ctx.pages, arg)
      case 'title': return escapeFieldText(ctx.title)
      case 'date': return escapeFieldText(ctx.date.toLocaleDateString())
      case 'time': return escapeFieldText(ctx.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      case 'author': return escapeFieldText(ctx.author)
      case 'company': return escapeFieldText(ctx.company)
      case 'subject': return escapeFieldText(ctx.subject)
      case 'event': return escapeFieldText(ctx.event)
      default: return ''
    }
  })
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
  const shadows = Array.isArray(el.shadow) ? el.shadow : el.shadow ? [el.shadow] : []
  const parts = shadows.map((s) => `drop-shadow(${s.x ?? 0}px ${s.y ?? 0}px ${s.blur}px ${s.color})`)
  if (el.blur) parts.push(`blur(${el.blur}px)`)
  node.style.filter = parts.length ? parts.join(' ') : ''
  node.style.mixBlendMode = el.blend || ''
  if (el.backdropFilter) {
    const bf = `blur(${el.backdropFilter}px)`
    node.style.backdropFilter = bf
    node.style.setProperty('-webkit-backdrop-filter', bf)
  } else {
    node.style.backdropFilter = ''
  }
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

/** CSS linear-gradient() from a GradientFill. CSS angle convention matches the
 *  model (0deg = bottom->top, 90deg = left->right), so pass angle straight. */
export function cssLinearGradient(g: NonNullable<ShapeElement['fillGradient']>): string {
  const stops = g.stops
    .map((s) => `${s.color} ${Math.round(Math.min(Math.max(s.at, 0), 1) * 100)}%`)
    .join(', ')
  return `linear-gradient(${g.angle}deg, ${stops})`
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

// --- math ($…$ → MathML) -----------------------------------------------------

/**
 * LaTeX math in text, resolved at RENDER time — the same trick resolveFields
 * uses for {{page}}. The MODEL stores the raw source (`$E=mc^2$`), so the
 * format gains nothing to version: an older build opening a newer file shows
 * the literal `$E=mc^2$` — degraded, legible, and nothing is lost.
 *
 * MathML, not HTML+CSS, is what makes this affordable. Temml emits MathML and
 * the browser lays it out with its own math fonts; KaTeX would have to ship a
 * layout engine AND ~20 webfont faces (measured: +421KB against Temml's +64KB).
 *
 * MUST run AFTER sanitizeHtml, never before: the sanitizer unwraps every tag
 * outside its allowlist and strips all attributes, so it would demolish the
 * MathML. Running after is also why the allowlist needs no widening — this
 * markup is GENERATED by us from LaTeX source, never accepted from the author.
 * Temml runs with trust off, so \href and friends are inert.
 */
const mathCache = new Map<string, string>()

/** Undo the entity escaping sanitizeHtml applied, so `x &lt; y` reaches TeX as `x < y`. */
function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s
  const ta = document.createElement('textarea')
  ta.innerHTML = s
  return ta.value
}

/**
 * Tag each MathML token with a key that identifies "the same symbol" across
 * two slides, so present.ts can morph a formula symbol by symbol instead of
 * crossfading it — a term crossing the equals sign visibly travels there.
 *
 * The key is the token's own text plus its occurrence index (`x#0`, `x#1`),
 * which is what makes rearrangement work: the second `x` in one formula pairs
 * with the second `x` in the next, wherever each has moved to. Purely a
 * RENDER-time attribute — nothing about it enters the document.
 */
function tagSymbols(mathml: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = mathml
  const seen = new Map<string, number>()
  for (const leaf of Array.from(tpl.content.querySelectorAll('mi, mn, mo'))) {
    const txt = (leaf.textContent ?? '').trim()
    if (!txt) continue
    const n = seen.get(txt) ?? 0
    seen.set(txt, n + 1)
    ;(leaf as HTMLElement).dataset.sym = `${txt}#${n}`
  }
  return tpl.innerHTML
}

function renderMath(src: string, display: boolean): string | null {
  const key = (display ? 'D' : 'I') + src
  const hit = mathCache.get(key)
  if (hit !== undefined) return hit || null
  let out: string | null = null
  try {
    out = tagSymbols(
      temml.renderToString(decodeEntities(src), { displayMode: display, throwOnError: true, trust: false }),
    )
  } catch {
    out = null // not valid TeX — leave the author's text exactly as typed
  }
  mathCache.set(key, out ?? '')
  return out
}

export function resolveMath(html: string): string {
  if (html.indexOf('$') < 0) return html
  // $$…$$ first (display), then $…$ (inline). The inline form is deliberately
  // fussy so ordinary prose survives: no whitespace just inside the delimiters
  // and no digit straight after the closer, which is what keeps "it costs $5
  // and $10" from parsing as math. A backslash-escaped \$ is a literal dollar.
  let out = html.replace(/(^|[^\\])\$\$([^$]+?)\$\$/g, (m, pre: string, src: string) => {
    const ml = renderMath(src, true)
    return ml ? pre + ml : m
  })
  out = out.replace(/(^|[^\\$])\$(\S(?:[^$\n]*?\S)?)\$(?!\d)/g, (m, pre: string, src: string) => {
    const ml = renderMath(src, false)
    return ml ? pre + ml : m
  })
  return out.replace(/\\\$/g, '$') // the escape has done its job
}

const ALLOWED_TAGS = new Set(['B', 'I', 'U', 'BR', 'SPAN', 'DIV', 'P', 'STRONG', 'EM', 'S', 'CODE'])

/** Keep pasted/edited rich text down to a safe inline subset. */
export function sanitizeHtml(html: string): string {
  if (typeof document === 'undefined') return stripAllTags(html)
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

/** No-DOM fallback (node rigs): drop every tag, keep the words. */
function stripAllTags(html: string): string {
  return String(html).replace(/<[^>]*>/g, '')
}

// --- untrusted svg ----------------------------------------------------------
//
// An `svg` element's markup is opaque author content that goes into the page as
// markup — the one element type whose content is not text we lay out but nodes
// the browser builds. Every deck is untrusted input: mailed, pasted, or
// delivered as a collab op. Script running in this page holds `doc.collab.key`,
// `ownerPriv`/`writerPriv`, the plaintext IndexedDB autosave store and the File
// System Access handle ⌘S writes through, so "the document can run script" is
// the document AND the file on disk.

/**
 * The svg vocabulary an untrusted diagram may use. AN ALLOWLIST, and that is
 * the whole point of this rewrite.
 *
 * The first version of this sanitizer named five tags and three attributes,
 * and a verifier walked through the gap five ways in Chrome 141 (2026-08-09):
 * `<form action="javascript:…">` under a full-slide transparent submit button
 * (ONE click anywhere on the slide), `<button formaction="javascript:…">`,
 * `<meta http-equiv="refresh">` — which actually navigated the reader's page
 * off to an attacker host, and which the html parser lets break out of foreign
 * content so `<svg><rect/><meta …></svg>` reaches the body too — `<base href>`
 * (a media `src` is documented as possibly relative, so retargeting resolution
 * is a live fetch), and `<link rel=stylesheet>`. Not one of those is on this
 * list, so not one of them had to be named, and neither does whatever the next
 * browser ships.
 *
 * Sized against the content that exists: every svg asset in `starterdeck.ts`
 * (userSpaceOnUse patterns, feTurbulence + feColorMatrix grain, feGaussianBlur
 * bokeh, radialGradient auroras) draws unchanged through it. NO html tag is on
 * the list — an svg element's markup is svg, and the html tags that reach it
 * are exactly the carriers: `foreignObject` children, and the foreign-content
 * breakout list, which is where `meta` came from. A diagram that wants a name
 * added here is a one-line change; a diagram that wants `<form>` is not a
 * diagram. An element not on the list is REMOVED WHOLE rather than unwrapped:
 * unwrapping would spill a refused element's text onto the slide, and "refuse"
 * is the rule this list exists to state.
 *
 * `template` is on nobody's list twice over — its children live in `.content`,
 * not `childNodes`, so the walk below would never have seen them while
 * `importNode(n, true)` copied them wholesale.
 */
export const SVG_TAGS = new Set([
  // structure. `style` stays: it cannot execute, and scopeCss (hard-won detail
  // #7) is what keeps its rules from leaking into every other svg on the page.
  'svg', 'g', 'defs', 'symbol', 'use', 'switch', 'desc', 'title', 'metadata', 'style', 'view', 'a',
  // shapes and text
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'image',
  // paint servers, clipping, masking
  'lineargradient', 'radialgradient', 'stop', 'pattern', 'solidcolor',
  'clippath', 'mask', 'marker',
  // filters
  'filter', 'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite',
  'feconvolvematrix', 'fediffuselighting', 'fedisplacementmap', 'fedistantlight',
  'fedropshadow', 'feflood', 'fefunca', 'fefuncb', 'fefuncg', 'fefuncr',
  'fegaussianblur', 'feimage', 'femerge', 'femergenode', 'femorphology',
  'feoffset', 'fepointlight', 'fespecularlighting', 'fespotlight', 'fetile',
  'feturbulence',
  // SMIL — judged by what they WRITE, see the attributeName rule below
  'animate', 'animatemotion', 'animatetransform', 'set', 'mpath',
])

/** SMIL: these can WRITE an attribute, so they are judged by their target. */
const SVG_ANIM = new Set(['animate', 'set', 'animatetransform', 'animatemotion'])

/**
 * Attributes an untrusted svg may keep. Same argument as SVG_TAGS: `action`,
 * `formaction`, `http-equiv`, `srcdoc` and every `on*` are refused because they
 * were never permitted, not because a list enumerates them.
 *
 * Matched case-INSENSITIVELY, which is what makes the html parser's foreign-
 * content case fixups (`viewBox`, `attributeName`, `stdDeviation`,
 * `patternUnits`) line up with the lowercase entries here.
 */
const SVG_ATTRS = new Set([
  // core
  'id', 'class', 'style', 'lang', 'xml:lang', 'xml:space', 'xmlns', 'xmlns:xlink',
  'role', 'title', 'version', 'baseprofile', 'tabindex', 'media', 'type', 'target',
  'href', 'xlink:href',
  // geometry
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height',
  'd', 'points', 'pathlength', 'dx', 'dy', 'rotate', 'textlength', 'lengthadjust',
  'transform', 'transform-origin', 'transform-box', 'viewbox', 'preserveaspectratio', 'zoomandpan',
  // coordinate systems, paint servers, markers
  'refx', 'refy', 'markerwidth', 'markerheight', 'markerunits', 'orient',
  'gradientunits', 'gradienttransform', 'spreadmethod', 'fx', 'fy', 'fr', 'offset',
  'patternunits', 'patterncontentunits', 'patterntransform', 'clippathunits',
  'maskunits', 'maskcontentunits', 'primitiveunits', 'filterunits',
  'startoffset', 'method', 'spacing', 'side',
  'systemlanguage', 'requiredfeatures', 'requiredextensions',
  // presentation
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-opacity', 'opacity', 'color', 'color-interpolation', 'color-interpolation-filters',
  'display', 'visibility', 'overflow', 'cursor', 'pointer-events', 'shape-rendering',
  'text-rendering', 'image-rendering', 'vector-effect', 'paint-order', 'mix-blend-mode',
  'isolation', 'font', 'font-family', 'font-size', 'font-size-adjust', 'font-stretch',
  'font-style', 'font-variant', 'font-weight', 'letter-spacing', 'word-spacing',
  'text-anchor', 'text-decoration', 'dominant-baseline', 'alignment-baseline',
  'baseline-shift', 'writing-mode', 'direction', 'unicode-bidi', 'white-space',
  'clip', 'clip-path', 'clip-rule', 'mask', 'marker', 'marker-start', 'marker-mid',
  'marker-end', 'filter', 'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity',
  'lighting-color', 'enable-background',
  // filter primitives
  'in', 'in2', 'result', 'mode', 'values', 'tablevalues', 'slope', 'intercept',
  'amplitude', 'exponent', 'operator', 'k1', 'k2', 'k3', 'k4', 'order', 'kernelmatrix',
  'divisor', 'bias', 'targetx', 'targety', 'edgemode', 'kernelunitlength', 'preservealpha',
  'surfacescale', 'diffuseconstant', 'specularconstant', 'specularexponent', 'scale',
  'xchannelselector', 'ychannelselector', 'stddeviation', 'radius', 'basefrequency',
  'numoctaves', 'seed', 'stitchtiles', 'azimuth', 'elevation', 'pointsatx', 'pointsaty',
  'pointsatz', 'limitingconeangle', 'z',
  // SMIL timing
  'attributename', 'attributetype', 'from', 'to', 'by', 'dur', 'begin', 'end', 'min',
  'max', 'restart', 'repeatcount', 'repeatdur', 'calcmode', 'keytimes', 'keysplines',
  'keypoints', 'path', 'additive', 'accumulate', 'origin',
])

/**
 * `data-*` names this renderer, its editor and the kernel read. An author svg
 * carrying one would answer a `[data-el-id="…"]` lookup that is already
 * ambiguous between the canvas and the sidebar thumbnails (hard-won detail #3),
 * so the open `data-*` door below stops short of them.
 *
 * `data-bento` is reserved as a PREFIX, not as one name: the shell's own marks
 * are `data-bento-transient` (kernel `serializeBody` deletes those nodes from
 * the clone it saves) and `data-bento-preview` (which save.ts removes
 * unconditionally, replace-never-append). Reserving the exact string only would
 * have left an author element able to answer either query.
 */
const SVG_DATA_RESERVED = /^data-(el-id|flip-id|slide-id|autoplay|r|c)$|^data-bento/

/**
 * `aria-*` is open-ended by design and inert; `data-*` is how a diagram's own
 * `<style>` selects its parts. Everything else is the list.
 *
 * Exported for `scripts/test-sanitize.ts` — this is a pure decision, so it is
 * pinned in node while the walk that applies it is measured in a browser.
 */
export function svgAttrAllowed(name: string): boolean {
  const n = name.toLowerCase()
  if (n.startsWith('aria-')) return true
  if (n.startsWith('data-')) return !SVG_DATA_RESERVED.test(n)
  return SVG_ATTRS.has(n)
}

/**
 * Tags whose href may leave this document. An `<image>` or `<feImage>` paints
 * a picture and an `<a>` navigates on a click the reader made; every other
 * href in svg (`use`, `pattern`, gradient inheritance, `mpath`, `textPath`)
 * pulls a SUBTREE out of the target document, which is both a fetch and a
 * trust boundary.
 */
const SVG_HREF_REMOTE = new Set(['a', 'image', 'feimage'])

/**
 * May an untrusted svg keep this href?
 *
 * Same-document fragments must survive — gradients, markers and `<use>` all
 * paint through `url(#…)`, and dropping those refs is what would render a
 * diagram blank. Beyond that only the tags above, and only http(s) or a
 * `data:image/` (which the browser loads script-disabled). Everything else
 * goes: `javascript:` obviously, but the bare relative form too, because
 * `//host/x` is relative as well and is a network fetch out of a file the
 * reader believes is self-contained (PLATFORM §1).
 *
 * ASCII whitespace and control characters come out before the test, because a
 * browser ignores them inside a scheme: `java&#9;script:alert(1)` navigates.
 *
 * Exported for `scripts/test-sanitize.ts`: the walk below needs a DOM, this
 * decision does not. `tag` defaults to the permissive case so a caller asking
 * only "is this url shape allowed anywhere" gets that answer.
 */
export function svgHrefAllowed(value: string, tag = 'image'): boolean {
  const v = value.replace(/[\u0000-\u0020]/g, '').toLowerCase()
  if (v.startsWith('#')) return true
  if (!SVG_HREF_REMOTE.has(tag.toLowerCase())) return false
  return /^https?:/.test(v) || v.startsWith('data:image/')
}

/** Every `url(…)` target in a CSS-ish string, quotes and padding removed. */
function urlTargets(value: string): string[] {
  return Array.from(value.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi))
    .map((m) => m[2].replace(/[\u0000-\u0020]/g, '').toLowerCase())
}

/**
 * `url(#grad)` is the gradient/marker idiom every diagram is built on;
 * `url(https://…)` in the same attribute is a live fetch out of a self-
 * contained file, and a read receipt for a mailed deck. So attribute values
 * are checked for their url targets, not just their scheme — `fill`,
 * `filter`, `clip-path`, `mask` and `style` all take one.
 *
 * Exported for `scripts/test-sanitize.ts`.
 */
export function svgUrlRefsAllowed(value: string): boolean {
  return urlTargets(value).every((t) => t.startsWith('#') || t.startsWith('data:image/'))
}

/**
 * At-rules an untrusted sheet may keep — layout, motion and typography, which
 * is what a diagram's own CSS is for.
 *
 * An ALLOWLIST, and the reason is measured. The first pass cut `@import` by
 * name; Chrome 141 fetched anyway (2026-08-09 — the probe server logged the
 * request), because a CSS at-keyword is an IDENT and an ident may be written
 * with escapes: `@\69mport "https://…";` is the same at-rule and matches no
 * regex spelling `import`. `@im\port` and `@\49MPORT` are two more spellings of
 * it, and there is no end to that list — so the question asked here is which
 * at-rules are WANTED.
 *
 * It also covers the fetch spelled as a bare string, which the url() rewrite
 * below cannot see: `@import "https://…"` has no `url(` in it.
 */
const CSS_AT_ALLOWED = new Set([
  'media', 'supports', 'layer', 'container', 'scope', 'page', 'starting-style',
  'font-face', 'font-feature-values', 'counter-style', 'property',
  'keyframes', '-webkit-keyframes', '-moz-keyframes',
])

/**
 * CSS an untrusted svg may carry, in a `<style>` element or in the model's
 * `css` field. Neutralised rather than refused: a diagram's rules are how it
 * draws, so dropping the sheet costs the artwork, while dropping one fetch
 * costs nothing that was legitimate.
 *
 * A refused at-rule is RENAMED to one no browser implements rather than cut
 * out. CSS error recovery discards an unknown at-rule whole — its prelude, and
 * its block if it has one — so the payload goes and the rest of the sheet still
 * parses, and this stays a string rewrite with no brace matching in it. It is
 * also what makes the missing-semicolon form (`@import "x.css"` with a newline
 * where the `;` should be) a non-case: the parser, not this regex, decides
 * where the at-rule ends.
 *
 * An external `url()` is the same fetch with different syntax (`@font-face`
 * src, `background-image`, `fill`) — rewritten to `none`, which is a valid
 * value everywhere url() is legal, so a sheet stays parseable. Both are the
 * no-CDN rule (PLATFORM §1) and, for a deck sent by mail, a read receipt with
 * the reader's IP on it.
 *
 * The at-keyword scan requires the `@` to start a token, so an `@` inside a
 * value (`content:"a@b"`) is left alone.
 */
export function sanitizeSvgCss(css: string): string {
  const atFiltered = css.replace(/(^|[\s{};,)])@([-\w\\]+)/g, (_m, pre: string, kw: string) =>
    // Written plainly AND wanted. An escape inside the keyword is refused on
    // sight: nobody spells `@media` as `@\6dedia`, so decoding one would only
    // be a second chance to disagree with the browser about what the ident says.
    (/^-?[a-zA-Z][-\w]*$/.test(kw) && CSS_AT_ALLOWED.has(kw.toLowerCase())
      ? `${pre}@${kw}`
      : `${pre}@bento-refused `))
  return atFiltered.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, _q: string, target: string) => {
    const v = String(target).replace(/[\u0000-\u0020]/g, '').toLowerCase()
    return v.startsWith('#') || v.startsWith('data:image/') ? m : 'none'
  })
}

/**
 * Author svg markup → nodes this document can safely hold.
 *
 * AT RENDER, EVERY RENDER — not on the load path. An svg element also arrives
 * from a clipboard paste and from a collab op, and rendering is the one place
 * all three meet. Sanitizing here also keeps the FORMAT additive: nothing is
 * stamped on the model, so a file cleaned by this build is byte-identical to
 * one an older build wrote.
 *
 * Parsed INERT. `div.innerHTML = hostile` looks safe because the div is
 * detached and is not: the elements it creates belong to the live document, so
 * their resources load and `<img src=x onerror=…>` fires from a div that was
 * never inserted (measured for spaces, 2026-08-03 — same reason
 * spaces/src/sanitize.ts parses through DOMParser). `text/html`, not
 * `image/svg+xml`: the XML parser is FATAL on the first unclosed tag, and
 * refusing to draw a slightly sloppy diagram is a worse answer than drawing it.
 * The HTML parser applies the browser's own foreign-content rules, so
 * `foreignObject`, `clipPath`, `viewBox` and `xlink:href` come back correctly
 * cased and namespaced.
 *
 * `id` is deliberately never stripped: svg gradients and markers resolve
 * through document-global `url(#…)`, so an id sweep blanks the artwork.
 */
export function sanitizeSvg(markup: string): DocumentFragment {
  const out = document.createDocumentFragment()
  if (!markup) return out
  const parsed = new DOMParser().parseFromString(markup, 'text/html')

  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) continue
      if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue }
      const el = child as Element
      const tag = el.localName.toLowerCase()
      if (!SVG_TAGS.has(tag)) { el.remove(); continue }

      let gone = false
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase()
        if (!svgAttrAllowed(name)) { el.removeAttribute(attr.name); continue }
        if (SVG_ANIM.has(tag) && name === 'attributename') {
          // An animation WRITES an attribute, and it writes it long after this
          // walk has finished — so it is judged by its target. Anything off the
          // allowlist (`onclick`, `formaction`) is refused here even though
          // Blink declines to apply an on* through SMIL today: the refusal must
          // not rest on a browser's restraint. `href`/`style` ARE on the
          // allowlist and still refused, because their values are policed once,
          // below, and an animation is a second chance to set them.
          const target = attr.value.trim().toLowerCase()
          if (!svgAttrAllowed(target) || /(^|:)(href|style)$/.test(target)) { gone = true; break }
          continue
        }
        if (!svgUrlRefsAllowed(attr.value) || (name === 'style' && /@import|expression\s*\(/i.test(attr.value))) {
          el.removeAttribute(attr.name)
          continue
        }
        if (name !== 'href' && name !== 'xlink:href') continue
        if (svgHrefAllowed(attr.value, tag)) continue
        // a <use> IS its href, and one that cannot be resolved in-document
        // instances a subtree from a document that is not ours to trust; a dead
        // <a> or <image> is merely inert, so it keeps its place in the layout.
        if (tag === 'use') { gone = true; break }
        el.removeAttribute(attr.name)
      }
      if (gone) { el.remove(); continue }

      if (tag === 'style') {
        // Assigning textContent also discards any element children, which the
        // html parser really does build here: inside foreign content the
        // tokenizer stays in the data state, so `<svg><style><img src=x
        // onerror=…></style>` parses that img as an ELEMENT, not as css text.
        el.textContent = sanitizeSvgCss(el.textContent ?? '')
        continue
      }
      walk(el)
    }
  }
  walk(parsed.body)
  // importNode, not a bare append: the nodes live in the inert parsed document,
  // and relying on DOM4's implicit adopt is a trap for the next edit.
  for (const n of Array.from(parsed.body.childNodes)) out.appendChild(document.importNode(n, true))
  return out
}

const VALIGN: Record<string, string> = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }

/** The three alignments the format defines. Anything else is data, not a value. */
const ALIGN: Record<string, string> = { left: 'left', center: 'center', right: 'right' }

/**
 * A colour string safe to paste into a `style` attribute, or the fallback.
 *
 * A table's colours are ordinary untrusted input — the rows of a mailed deck, a
 * paste, a collab op — so the model's `string` says nothing about the value, and
 * escaping for markup does not cover where it lands. Inside `style="…"` the
 * dangerous characters are `"` (which ends the attribute and lets the next word
 * be an event handler) and `;`/`}` (which start a new declaration); `<` means
 * nothing there. A cell whose `bg` read `x" onmouseover="…` used to mint a real
 * handler on the canvas, in present, in print AND in every thumbnail.
 *
 * So: an allowlist of the characters colour notations actually use, no `url(`,
 * and a length cap. Anything else falls back rather than being "cleaned" — a
 * colour we do not recognise is not worth guessing at. Same rule and same
 * reasons as dash's preview (`dash/src/preview.ts` cssColor); `url` is matched
 * as `url(` rather than as a word because `burlywood` is a colour.
 *
 * Exported for `scripts/test-sanitize.ts`.
 */
export function cssColor(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  const s = v.trim()
  if (!s || s.length > 48) return fallback
  if (!/^[#a-zA-Z0-9(),.%\s/-]+$/.test(s)) return fallback
  if (/url\s*\(|expression|@|\\/i.test(s)) return fallback
  return s
}

/** A model number as a CSS length: finite and in range, or the fallback. */
export function cssNum(v: unknown, fallback: number, max = 4096): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : fallback
}

/**
 * An author font stack, reduced to what a stylesheet can hold. Rejected by
 * CHARACTER rather than by allowlist, unlike cssColor: font names are ordinary
 * words in any script (`ヒラギノ角ゴ` is a font family), so the test is for the
 * few characters that end a declaration or start a fetch.
 */
function cssFont(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  const s = v.trim()
  if (!s || s.length > 160) return fallback
  return /[;{}<>()\\]/.test(s) ? fallback : s
}

/**
 * Render a table element as a real HTML <table> string (table-layout: fixed).
 * Column widths are fractional weights normalised to %. Cells carry data-r /
 * data-c so the editor can target them for in-cell editing.
 *
 * Every author value is escaped for the attribute AND validated for the CSS it
 * lands in (cssColor/cssNum/cssFont/ALIGN) — see cssColor for what that stops.
 * Markup as a string, not DOM built and serialized, is kept deliberately: it is
 * what makes this whole function testable in node with no DOM at all, which is
 * what `scripts/test-sanitize.ts` exercises.
 */
export function renderTableHtml(el: TableElement, doc: BentoDoc): string {
  const st = el.style ?? ({} as TableElement['style'])
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  const totalW = el.columns.reduce((s, c) => s + cssNum(c.w, 0), 0) || 1
  const cols = el.columns
    .map((c) => `<col style="width:${((cssNum(c.w, 0) / totalW) * 100).toFixed(4)}%">`)
    .join('')
  const font = esc(cssFont(st.fontFamily || doc.theme.fontFamily, 'inherit'))
  const bw = cssNum(st.borderWidth, 0, 64)
  const border = bw ? `border:${bw}px solid ${cssColor(st.borderColor, 'transparent')};` : ''
  const padY = cssNum(st.cellPadY, 0, 512)
  const padX = cssNum(st.cellPadX, 0, 512)
  const rowsHtml = el.rows
    .map((row, r) => {
      const isHeader = el.header && r === 0
      const bodyIndex = el.header ? r - 1 : r
      const stripe = !isHeader && st.zebra && bodyIndex % 2 === 1 ? st.zebra : ''
      const cells = row.cells
        .map((cell, c) => {
          const align = ALIGN[cell.align as string] ?? 'left'
          const bg = cssColor(cell.bg || (isHeader ? st.headerBg : stripe || 'transparent'), 'transparent')
          const color = cssColor(cell.color || (isHeader ? st.headerColor : st.color), 'inherit')
          const weight = cell.bold || isHeader ? 700 : 400
          return (
            `<td data-r="${r}" data-c="${c}" style="${border}padding:${padY}px ${padX}px;` +
            `text-align:${align};vertical-align:middle;color:${color};background:${bg};` +
            `font-weight:${weight};overflow:hidden;word-break:break-word;">` +
            // dir="auto" per cell for the same reason text elements carry it:
            // a table of Arabic terms is otherwise laid out as if it were
            // English. Per cell, so a bilingual table stays correct in both
            // columns.
            `<div class="bento-cell-inner" dir="auto">${sanitizeHtml(String(cell.html ?? '')) || '<br>'}</div></td>`
          )
        })
        .join('')
      return `<tr data-r="${r}">${cells}</tr>`
    })
    .join('')
  const rad = cssNum(st.radius, 0, 512)
  const radius = rad ? `border-radius:${rad}px;overflow:hidden;` : ''
  return (
    `<div class="bento-table-wrap" style="width:100%;height:100%;${radius}">` +
    `<table class="bento-table" style="width:100%;height:100%;border-collapse:collapse;` +
    `table-layout:fixed;font-family:${font};font-size:${cssNum(st.fontSize, 16, 512)}px;line-height:1.3;">` +
    `<colgroup>${cols}</colgroup>${rowsHtml}</table></div>`
  )
}

/**
 * Render one element. The wrapper carries data-el-id (edit-time selection)
 * and data-flip-id (morph matching across slides). The flip id is the
 * element's `morphId` when set, else its `id` — so morph pairing can be
 * re-targeted without disturbing the stable identity used everywhere else.
 */
export function renderElement(el: SlideElement, doc: BentoDoc, opts: RenderOpts = {}): HTMLElement {
  const node = document.createElement('div')
  node.className = `bento-el bento-el-${el.type}`
  node.dataset.elId = el.id
  node.dataset.flipId = morphKey(el)
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
      // Base direction from the text itself. Without it every box is LTR, and
      // Arabic/Hebrew/Persian/Urdu render with their neutral characters in the
      // wrong place — a trailing full stop jumps to the head of the line, and
      // mixed-language runs reorder. PER ELEMENT, not per document: one deck
      // can hold an Arabic heading and an English caption and both are right.
      // This is about the CONTENT the author typed; it says nothing about the
      // editor's own language.
      inner.dir = 'auto'
      inner.style.fontSize = `${el.fontSize}px`
      inner.style.fontFamily = el.fontFamily || doc.theme.fontFamily
      inner.style.fontWeight = String(el.fontWeight)
      const cg = el.colorGradient
      if (cg && cg.stops && cg.stops.length) {
        inner.style.backgroundImage = cssLinearGradient(cg)
        inner.style.setProperty('-webkit-background-clip', 'text')
        inner.style.setProperty('background-clip', 'text')
        inner.style.color = 'transparent'
      } else {
        inner.style.color = el.color
      }
      // text-stroke composes on top: outline the glyphs (over gradient or solid fill)
      const ts = el.textStroke
      if (ts && ts.width) {
        inner.style.setProperty('-webkit-text-stroke', `${ts.width}px ${ts.color}`)
        if (ts.fill === 'none') inner.style.color = 'transparent'
      }
      inner.style.textAlign = el.align
      inner.style.lineHeight = String(el.lineHeight)
      if (el.letterSpacing) inner.style.letterSpacing = `${el.letterSpacing}px`
      inner.style.width = '100%'
      inner.innerHTML = resolveMath(sanitizeHtml(resolveFields(el.html, opts.fields)))
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
    case 'table':
      node.dataset.table = '1'
      node.innerHTML = renderTableHtml(el, doc)
      break
    case 'image': {
      const img = document.createElement('img')
      img.src = resolveAsset(doc, el.src)
      img.draggable = false
      img.style.cssText = `width:100%;height:100%;object-fit:${el.fit};border-radius:${el.radius}px;display:block`
      node.appendChild(img)
      break
    }
    case 'media': {
      const radius = el.radius ?? 0
      if (opts.svgAsImage) {
        // thumbnails: a cheap still — poster (video) or an icon chip, never a
        // live media element.
        const still = document.createElement('div')
        still.style.cssText = `width:100%;height:100%;border-radius:${radius}px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:${el.kind === 'video' ? '#0b0f14' : '#e7edf4'}`
        if (el.kind === 'video' && el.poster) {
          const img = document.createElement('img')
          img.src = resolveAsset(doc, el.poster)
          img.style.cssText = `width:100%;height:100%;object-fit:${el.fit ?? 'contain'};display:block`
          still.appendChild(img)
        } else {
          still.style.color = el.kind === 'video' ? '#ffffff' : '#5e7699'
          still.style.fontSize = '24px'
          still.textContent = el.kind === 'video' ? '▶' : '♪'
        }
        node.appendChild(still)
        break
      }
      const inert = opts.liveMedia ? '' : ';pointer-events:none'
      if (el.kind === 'audio') {
        // Render the browser's native <audio controls> AS-IS: it's already a
        // self-contained pill with its own surface. We add nothing behind it
        // and don't clip it to a radius (that just cut the control's own shape
        // and looked odd) — only centre it in the element box. Size the box to
        // the control's ~54px intrinsic height (defaultMedia audio uses 56).
        const audio = document.createElement('audio')
        if (el.src) audio.src = resolveAsset(doc, el.src)
        audio.controls = el.controls !== false
        audio.loop = !!el.loop
        audio.preload = 'metadata'
        audio.dataset.autoplay = el.autoplay ? '1' : ''
        audio.style.cssText = 'width:100%;display:block' + inert
        const wrap = document.createElement('div')
        wrap.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center'
        if (!el.src) {
          wrap.style.cssText += ';background:#eef2f7;border-radius:10px;color:#93a2b6;font-size:13px'
          wrap.textContent = '♪ ' + 'No audio source'
        } else wrap.appendChild(audio)
        node.appendChild(wrap)
        break
      }
      const video = document.createElement('video')
      if (el.src) video.src = resolveAsset(doc, el.src)
      if (el.poster) video.poster = resolveAsset(doc, el.poster)
      video.controls = el.controls !== false
      video.loop = !!el.loop
      video.muted = el.muted !== false
      video.playsInline = true
      video.preload = 'metadata'
      video.dataset.autoplay = el.autoplay ? '1' : ''
      video.style.cssText = `width:100%;height:100%;object-fit:${el.fit ?? 'contain'};border-radius:${radius}px;display:block;background:#0b0f14` + inert
      if (!el.src) {
        const ph = document.createElement('div')
        ph.style.cssText = `width:100%;height:100%;border-radius:${radius}px;display:flex;align-items:center;justify-content:center;background:#0b0f14;color:#8fa0b6;font-size:14px`
        ph.textContent = '▶ No video source'
        node.appendChild(ph)
      } else {
        node.appendChild(video)
      }
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
      // NOT innerHTML: this markup is author content, and assigning it ran
      // whatever the deck carried in a <script> or an onload — see sanitizeSvg.
      // The <img> branch above is inert already (an image is script-disabled),
      // which is why only this path changes.
      node.appendChild(sanitizeSvg(markup))
      const svg = node.querySelector('svg')
      if (svg) {
        svg.style.width = '100%'
        svg.style.height = '100%'
        svg.style.display = 'block'
        if (el.css) {
          const style = document.createElementNS(SVG_NS, 'style')
          // Same sheet, same policy: this lands in the very `<style>` element
          // sanitizeSvg cleans, so leaving `css` unfiltered would have left an
          // @import sitting beside the one that was just removed.
          style.textContent = scopeCss(sanitizeSvgCss(el.css), `[data-el-id="${CSS.escape(el.id)}"]`)
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
  const fields = opts.fields ?? fieldContext(doc, slide)
  for (const el of slide.elements) surface.appendChild(renderElement(el, doc, { ...opts, fields }))
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
