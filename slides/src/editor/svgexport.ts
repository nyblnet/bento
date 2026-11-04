// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * A slide (or the part of it a selection covers) as NATIVE SVG — shapes,
 * text, pictures — that Figma, Illustrator and Inkscape open as editable
 * vectors. The raster export (exportimages.ts) wraps the HTML render in a
 * `<foreignObject>`, which a browser draws and every vector editor ignores.
 *
 * HOW. The slide is rendered by the one renderer (render.ts) into a hidden
 * host so the browser lays it out, and the layout is READ, never re-derived:
 *   - a shape, chart or svg element is already SVG: it is inlined where it sits;
 *   - text is cut into runs per rendered line (one Range per character finds
 *     where a line breaks) and each run becomes a `<text>` at the exact x and
 *     baseline the browser chose, in the run's own font, size, weight, colour,
 *     spacing and decoration; list markers are written beside their line;
 *   - an HTML box (a table cell, a code block, a picture frame) paints its
 *     background, gradient and borders as rects, with its radius; a box that
 *     clips (overflow hidden — a cropped picture's frame) becomes a clipPath;
 *   - a picture is an `<image>` with its data URI and its object-fit;
 *   - maths is the one thing with no vector form a design tool reads (MathML),
 *     so a formula is drawn by the browser and embedded as a picture.
 * Each element is measured UNTURNED and unmirrored (its transforms lifted for
 * the read, restored at once — the host is never painted) and written as a
 * group carrying the rotation and flip as SVG transforms, its opacity, blend
 * mode, its shadows and blur as SVG filters, and a frame's clip.
 *
 * The deck's embedded @font-face rules travel in a <style> for the faces the
 * export uses, so a browser shows the right type; a design tool substitutes
 * from installed fonts, as it does for any SVG.
 */
import { renderElement, renderSlide } from '../render'
import type { BentoDoc, Slide, SlideElement } from '../model'
import type { Box } from './exportimages'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** CSS in a CDATA section: a `]]>` inside it (a hostile font family) would end the section and open markup. */
const cdata = (css: string) => `<![CDATA[${css.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`
const n = (v: number) => String(Math.round(v * 100) / 100)
let uid = 0
const nextId = (p: string) => `${p}${++uid}`

/** A computed colour that paints anything (not transparent). */
const visible = (c: string) => !!c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c)

/** CSS linear-/radial-gradient (as getComputedStyle normalises it) → an SVG gradient def in the box's user space. */
function gradientDef(css: string, x: number, y: number, w: number, h: number, defs: string[]): string | null {
  const m = /^(linear|radial)-gradient\((.*)\)$/.exec(css.trim())
  if (!m) return null
  // split the argument list on top-level commas
  const parts: string[] = []
  let depth = 0, cur = ''
  for (const ch of m[2]) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && !depth) { parts.push(cur.trim()); cur = '' } else cur += ch
  }
  parts.push(cur.trim())
  let head = ''
  if (!/^(rgb|#|[a-z]+\s+\d|[a-z]+$)/i.test(parts[0]) || /deg|to |at |%.*%/.test(parts[0])) head = parts.shift()!
  const stops = parts.map((p, i) => {
    const sm = /^(.*?\))\s*([\d.]+%)?$|^(\S+)\s*([\d.]+%)?$/.exec(p)!
    const color = sm[1] ?? sm[3]
    const at = sm[2] ?? sm[4]
    return { color, at: at ? parseFloat(at) / 100 : i / Math.max(1, parts.length - 1) }
  })
  const id = nextId('g')
  const stopXml = stops.map((s) => `<stop offset="${n(s.at)}" stop-color="${esc(s.color)}"/>`).join('')
  if (m[1] === 'linear') {
    const deg = /(-?[\d.]+)deg/.exec(head)?.[1]
    const TO: Record<string, number> = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to bottom right': 135, 'to bottom left': 225, 'to top left': 315 }
    const a = ((deg !== undefined ? parseFloat(deg) : TO[head.trim()] ?? 180) * Math.PI) / 180
    const sx = Math.sin(a), sy = -Math.cos(a)
    const half = (Math.abs(w * sx) + Math.abs(h * sy)) / 2
    const cx = x + w / 2, cy = y + h / 2
    defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(cx - sx * half)}" y1="${n(cy - sy * half)}" x2="${n(cx + sx * half)}" y2="${n(cy + sy * half)}">${stopXml}</linearGradient>`)
  } else {
    // radial-gradient(RX% RY% at CX% CY%, …) — what kernel/src/shape.ts cssGradient writes
    const g = /([\d.]+)%\s+([\d.]+)%\s+at\s+([\d.]+)%\s+([\d.]+)%/.exec(head)
    const [rx, ry, cxp, cyp] = g ? g.slice(1).map((v) => parseFloat(v) / 100) : [0.5, 0.5, 0.5, 0.5]
    defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${n(x + cxp * w)} ${n(y + cyp * h)}) scale(${n(rx * w)} ${n(ry * h)})">${stopXml}</radialGradient>`)
  }
  return `url(#${id})`
}

/** A rounded rect path (per-corner radii) — what border-radius draws. */
function roundRect(x: number, y: number, w: number, h: number, r: [number, number, number, number]): string {
  const [tl, tr, br, bl] = r.map((v) => Math.min(v, w / 2, h / 2))
  if (!tl && !tr && !br && !bl) return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"`
  return `<path d="M${n(x + tl)} ${n(y)}H${n(x + w - tr)}A${n(tr)} ${n(tr)} 0 0 1 ${n(x + w)} ${n(y + tr)}V${n(y + h - br)}A${n(br)} ${n(br)} 0 0 1 ${n(x + w - br)} ${n(y + h)}H${n(x + bl)}A${n(bl)} ${n(bl)} 0 0 1 ${n(x)} ${n(y + h - bl)}V${n(y + tl)}A${n(tl)} ${n(tl)} 0 0 1 ${n(x + tl)} ${n(y)}Z"`
}
const radii = (cs: CSSStyleDeclaration): [number, number, number, number] =>
  [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => parseFloat(v) || 0) as [number, number, number, number]

/** Font metrics for a computed font: where the baseline sits in a line box of the content height. */
const metricsCtx = document.createElement('canvas').getContext('2d')!
function ascentOf(cs: CSSStyleDeclaration): { asc: number; desc: number } {
  metricsCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const m = metricsCtx.measureText('Hg')
  return { asc: m.fontBoundingBoxAscent, desc: m.fontBoundingBoxDescent }
}

const MARKERS: Record<string, (i: number) => string> = {
  disc: () => '• ', circle: () => '◦ ', square: () => '▪ ',
  decimal: (i) => `${i}. `, 'decimal-leading-zero': (i) => `${String(i).padStart(2, '0')}. `,
  'lower-alpha': (i) => `${String.fromCharCode(96 + ((i - 1) % 26) + 1)}. `, 'upper-alpha': (i) => `${String.fromCharCode(64 + ((i - 1) % 26) + 1)}. `,
  'lower-latin': (i) => `${String.fromCharCode(96 + ((i - 1) % 26) + 1)}. `, 'upper-latin': (i) => `${String.fromCharCode(64 + ((i - 1) % 26) + 1)}. `,
  'lower-roman': (i) => `${roman(i).toLowerCase()}. `, 'upper-roman': (i) => `${roman(i)}. `,
}
function roman(i: number): string {
  const t: Array<[number, string]> = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
  let s = ''
  for (const [v, r] of t) while (i >= v) { s += r; i -= v }
  return s
}

/** The attributes a run of text paints with. */
function textAttrs(cs: CSSStyleDeclaration, fill: string): string {
  const deco = cs.textDecorationLine && cs.textDecorationLine !== 'none' ? ` text-decoration="${esc(cs.textDecorationLine)}"` : ''
  const ls = parseFloat(cs.letterSpacing) ? ` letter-spacing="${n(parseFloat(cs.letterSpacing))}"` : ''
  const sw = parseFloat(cs.getPropertyValue('-webkit-text-stroke-width')) || 0
  const stroke = sw ? ` stroke="${esc(cs.getPropertyValue('-webkit-text-stroke-color'))}" stroke-width="${n(sw)}"` : ''
  const italic = cs.fontStyle !== 'normal' ? ` font-style="${esc(cs.fontStyle)}"` : ''
  return `font-family="${esc(cs.fontFamily)}" font-size="${n(parseFloat(cs.fontSize))}" font-weight="${esc(cs.fontWeight)}"${italic} fill="${fill}"${deco}${ls}${stroke}`
}

/** Draw a node with the browser (a formula) and return it as a PNG data URI at 2×. */
async function snapshot(node: Element, w: number, h: number, css: string): Promise<string> {
  const k = 2
  const xhtml = new XMLSerializer().serializeToString(node)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * k}" height="${h * k}" viewBox="0 0 ${w} ${h}"><foreignObject width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" style="font:${esc(getComputedStyle(node).font)};color:${esc(getComputedStyle(node).color)}"><style>${cdata(css)}</style>${xhtml}</div></foreignObject></svg>`
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  const c = document.createElement('canvas')
  c.width = Math.ceil(w * k); c.height = Math.ceil(h * k)
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/png')
}

interface Ctx { defs: string[]; fonts: Set<string>; css: string; ox: number; oy: number }

/** Convert one rendered element's subtree (measured in its own frame, origin ox/oy). */
async function convert(node: Element, ctx: Ctx, textFill?: (r: DOMRect) => string): Promise<string> {
  const out: string[] = []
  const cs = getComputedStyle(node)
  if (cs.display === 'none' || cs.visibility === 'hidden') return ''
  const r = node.getBoundingClientRect()
  const x = r.left - ctx.ox, y = r.top - ctx.oy
  if (node instanceof SVGSVGElement) {
    const clone = node.cloneNode(true) as SVGSVGElement
    clone.removeAttribute('style')
    clone.removeAttribute('class')
    clone.setAttribute('x', n(x)); clone.setAttribute('y', n(y))
    clone.setAttribute('width', n(r.width)); clone.setAttribute('height', n(r.height))
    if (!clone.getAttribute('viewBox') && node.viewBox.baseVal && node.viewBox.baseVal.width) {
      const v = node.viewBox.baseVal
      clone.setAttribute('viewBox', `${v.x} ${v.y} ${v.width} ${v.height}`)
    }
    clone.setAttribute('overflow', 'visible')
    return new XMLSerializer().serializeToString(clone).replace(/ xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '')
  }
  if (node.localName === 'math') {
    const href = await snapshot(node, r.width, r.height, ctx.css)
    return `<image x="${n(x)}" y="${n(y)}" width="${n(r.width)}" height="${n(r.height)}" href="${href}"/>`
  }
  if (node instanceof HTMLImageElement) {
    if (!node.currentSrc && !node.src) return ''
    const fit = cs.objectFit
    const par = fit === 'cover' ? 'xMidYMid slice' : fit === 'fill' ? 'none' : 'xMidYMid meet'
    const rr = radii(cs)
    let clip = ''
    if (rr.some(Boolean)) {
      const id = nextId('c')
      ctx.defs.push(`<clipPath id="${id}">${roundRect(x, y, r.width, r.height, rr)}/></clipPath>`)
      clip = ` clip-path="url(#${id})"`
    }
    return `<image x="${n(x)}" y="${n(y)}" width="${n(r.width)}" height="${n(r.height)}" preserveAspectRatio="${par}" href="${esc(node.src)}"${clip}/>`
  }
  if (node instanceof HTMLElement) {
    // the box: background, gradient, borders, radius
    const rr = radii(cs)
    if (visible(cs.backgroundColor)) out.push(`${roundRect(x, y, r.width, r.height, rr)} fill="${esc(cs.backgroundColor)}"/>`)
    const bgClipText = cs.getPropertyValue('-webkit-background-clip') === 'text' || cs.backgroundClip === 'text'
    let fillForText = textFill
    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      const fill = gradientDef(cs.backgroundImage, x, y, r.width, r.height, ctx.defs)
      if (fill && bgClipText) fillForText = () => fill // a text gradient paints the glyphs
      else if (fill) out.push(`${roundRect(x, y, r.width, r.height, rr)} fill="${fill}"/>`)
    }
    const sides = (['Top', 'Right', 'Bottom', 'Left'] as const).map((s) => ({ w: parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) || 0, c: cs.getPropertyValue(`border-${s.toLowerCase()}-color`), st: cs.getPropertyValue(`border-${s.toLowerCase()}-style`) }))
    const drawn = sides.filter((s) => s.w > 0 && s.st !== 'none' && s.st !== 'hidden' && visible(s.c))
    // a collapsed table shares each border between neighbours, centred on the grid line
    const collapsed = cs.borderCollapse === 'collapse' && /^(td|th)$/.test(node.localName)
    if (collapsed) {
      const [t, ri, b, l] = sides
      const line = (s: typeof t, x1: number, y1: number, x2: number, y2: number) =>
        s.w > 0 && s.st !== 'none' && visible(s.c) ? out.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${esc(s.c)}" stroke-width="${n(s.w)}"/>`) : 0
      // cells tile edge to edge and each shared line is centred on the edge (measured:
      // neighbours' boxes meet exactly; the outer boxes stop half a border inside the table)
      const L = x - l.w / 2, T = y - t.w / 2, R = x + r.width + ri.w / 2, B = y + r.height + b.w / 2
      line(t, L, y, R, y); line(b, L, y + r.height, R, y + r.height)
      line(l, x, T, x, B); line(ri, x + r.width, T, x + r.width, B)
    } else if (drawn.length === 4 && sides.every((s) => s.w === sides[0].w && s.c === sides[0].c)) {
      const w = sides[0].w
      out.push(`${roundRect(x + w / 2, y + w / 2, r.width - w, r.height - w, rr.map((v) => Math.max(0, v - w / 2)) as typeof rr)} fill="none" stroke="${esc(sides[0].c)}" stroke-width="${n(w)}"/>`)
    } else {
      const [t, ri, b, l] = sides
      const line = (s: typeof t, x1: number, y1: number, x2: number, y2: number) =>
        s.w > 0 && s.st !== 'none' && visible(s.c) ? out.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${esc(s.c)}" stroke-width="${n(s.w)}"/>`) : 0
      line(t, x, y + t.w / 2, x + r.width, y + t.w / 2)
      line(ri, x + r.width - ri.w / 2, y, x + r.width - ri.w / 2, y + r.height)
      line(b, x, y + r.height - b.w / 2, x + r.width, y + r.height - b.w / 2)
      line(l, x + l.w / 2, y, x + l.w / 2, y + r.height)
    }
    // a list item's marker sits just before its first glyph
    if (cs.display === 'list-item' && cs.listStyleType !== 'none') {
      const first = firstGlyph(node)
      if (first) {
        const idx = [...(node.parentElement?.children ?? [])].filter((c) => c.localName === 'li').indexOf(node) + 1
        const start = node.parentElement instanceof HTMLOListElement ? (node.parentElement.start || 1) - 1 : 0
        const mark = (MARKERS[cs.listStyleType] ?? MARKERS.disc)(idx + start)
        const { asc } = ascentOf(cs)
        const fill = fillForText ? fillForText(first) : esc(cs.color)
        out.push(`<text x="${n(first.left - ctx.ox)}" y="${n(first.top - ctx.oy + asc)}" text-anchor="end" xml:space="preserve" ${textAttrs(cs, fill)}>${esc(mark)}</text>`)
        ctx.fonts.add(cs.fontFamily)
      }
    }
    // children, clipped when the box clips
    const kids: string[] = []
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) kids.push(textRuns(c as Text, ctx, fillForText))
      else if (c.nodeType === Node.ELEMENT_NODE) kids.push(await convert(c as Element, ctx, fillForText))
    }
    const inner = kids.join('')
    if (inner && (cs.overflow !== 'visible' || cs.overflowX !== 'visible')) {
      const id = nextId('c')
      ctx.defs.push(`<clipPath id="${id}">${roundRect(x, y, r.width, r.height, rr)}/></clipPath>`)
      out.push(`<g clip-path="url(#${id})">${inner}</g>`)
    } else out.push(inner)
  }
  return out.join('')
}

/** The first glyph box inside a node (for list markers). */
function firstGlyph(node: Node): DOMRect | null {
  const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let t = walk.nextNode() as Text | null; t; t = walk.nextNode() as Text | null) {
    const i = t.data.search(/\S/)
    if (i < 0) continue
    range.setStart(t, i); range.setEnd(t, i + 1)
    const r = range.getClientRects()[0]
    if (r) return r
  }
  return null
}

/** One text node as `<text>` runs, one per rendered line, at the browser's own positions. */
function textRuns(t: Text, ctx: Ctx, textFill?: (r: DOMRect) => string): string {
  const parent = t.parentElement
  if (!parent || !t.data) return ''
  const cs = getComputedStyle(parent)
  if (cs.visibility === 'hidden' || cs.display === 'none') return ''
  const range = document.createRange()
  const runs: Array<{ text: string; left: number; top: number; height: number; rect: DOMRect }> = []
  // grapheme by grapheme: a line break shows as a jump in top
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  for (const g of seg.segment(t.data)) {
    range.setStart(t, g.index); range.setEnd(t, g.index + g.segment.length)
    const rr = range.getClientRects()
    const r = rr[rr.length - 1]
    if (!r || (!r.width && !/\S/.test(g.segment))) continue
    const last = runs[runs.length - 1]
    if (last && Math.abs(r.top - last.top) < r.height / 2 && r.left >= last.left - 1) last.text += g.segment
    else runs.push({ text: g.segment, left: r.left, top: r.top, height: r.height, rect: r })
  }
  if (!runs.length) return ''
  const { asc, desc } = ascentOf(cs)
  ctx.fonts.add(cs.fontFamily)
  const ws = /pre/.test(cs.whiteSpace)
  return runs.map((run) => {
    // a run's line box holds the content area; the baseline sits ascent below its top
    const baseline = run.top + (run.height - (asc + desc)) / 2 + asc - ctx.oy
    const text = ws ? run.text : run.text.replace(/\s+/g, ' ')
    if (!text.trim() && !ws) return ''
    const fill = textFill ? textFill(run.rect) : visible(cs.color) ? esc(cs.color) : 'none'
    return `<text x="${n(run.left - ctx.ox)}" y="${n(baseline)}" xml:space="preserve" ${textAttrs(cs, fill)}>${esc(text)}</text>`
  }).join('')
}

/** SVG filter for an element's shadows and blur (CSS drop-shadow/blur maths). */
function filterFor(el: SlideElement, defs: string[]): string {
  const shadows = Array.isArray(el.shadow) ? el.shadow : el.shadow ? [el.shadow] : []
  if (!shadows.length && !el.blur) return ''
  const id = nextId('f')
  const parts: string[] = []
  const merge: string[] = []
  shadows.forEach((s, i) => {
    // filter: drop-shadow()'s blur IS the Gaussian's standard deviation (Filter Effects 1;
    // unlike box-shadow, whose blur radius is twice it)
    parts.push(`<feGaussianBlur in="SourceAlpha" stdDeviation="${n(s.blur || 0)}" result="b${i}"/>`,
      `<feOffset in="b${i}" dx="${n(s.x ?? 0)}" dy="${n(s.y ?? 0)}" result="o${i}"/>`,
      `<feFlood flood-color="${esc(s.color)}" result="c${i}"/>`,
      `<feComposite in="c${i}" in2="o${i}" operator="in" result="s${i}"/>`)
    merge.unshift(`<feMergeNode in="s${i}"/>`) // CSS draws the first shadow on top
  })
  parts.push(`<feMerge result="m">${merge.join('')}<feMergeNode in="SourceGraphic"/></feMerge>`)
  if (el.blur) parts.push(`<feGaussianBlur in="m" stdDeviation="${n(el.blur)}"/>`)
  defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${parts.join('')}</filter>`)
  return ` filter="url(#${id})"`
}

/** A frame clip (render.ts frameClip: inset() or polygon() on the element box) as a clipPath in its frame. */
function frameClipPath(css: string, w: number, h: number, defs: string[]): string {
  if (!css) return ''
  const id = nextId('c')
  const ins = /^inset\(([^)]*)\)$/.exec(css)
  if (ins) {
    const v = ins[1].split(/\s+/).map(parseFloat)
    const [t, r, b, l] = v.length === 1 ? [v[0], v[0], v[0], v[0]] : v.length === 2 ? [v[0], v[1], v[0], v[1]] : v.length === 3 ? [v[0], v[1], v[2], v[1]] : v
    defs.push(`<clipPath id="${id}"><rect x="${n(l)}" y="${n(t)}" width="${n(w - l - r)}" height="${n(h - t - b)}"/></clipPath>`)
    return ` clip-path="url(#${id})"`
  }
  const poly = /^polygon\(([^)]*)\)$/.exec(css)
  if (poly) {
    const pts = poly[1].split(',').map((p) => p.trim().split(/\s+/).map((c, i) => c.endsWith('%') ? (parseFloat(c) / 100) * (i ? h : w) : parseFloat(c)))
    defs.push(`<clipPath id="${id}"><polygon points="${pts.map(([a, b]) => `${n(a)},${n(b)}`).join(' ')}"/></clipPath>`)
    return ` clip-path="url(#${id})"`
  }
  return ''
}

/**
 * The slide — or `box` of it — as a standalone native SVG document.
 * `slide` may be a selection-only copy (transparent background).
 */
export async function nativeSlideSvg(doc: BentoDoc, slide: Slide, box?: Box): Promise<string> {
  const v = box ?? { x: 0, y: 0, w: doc.size.width, h: doc.size.height }
  const host = document.createElement('div')
  // laid out, never painted: off-screen, and above nothing
  // `all: initial` — the slide inherits nothing from the editor's chrome (its ink,
  // its font), exactly as in the show, the thumbnails and the raster export
  host.style.cssText = 'all:initial;position:fixed;left:-100000px;top:0;contain:layout;pointer-events:none'
  const surface = renderSlide(slide, doc, { hidePlaceholders: true })
  host.appendChild(surface)
  document.body.appendChild(host)
  try {
    await document.fonts.ready
    const fontCss = document.getElementById('bento-fonts')?.textContent ?? ''
    const runtime = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules] } catch { return [] } })
      .filter((r) => r instanceof CSSStyleRule && r.selectorText.includes('.bento-') && !/\.ed-|\.reveal|\.sv-|\.bp-/.test(r.selectorText)).map((r) => r.cssText).join('\n')
    const defs: string[] = []
    const fonts = new Set<string>()
    const body: string[] = []
    const scs = getComputedStyle(surface)
    if (visible(scs.backgroundColor)) body.push(`<rect width="${doc.size.width}" height="${doc.size.height}" fill="${esc(scs.backgroundColor)}"/>`)
    if (scs.backgroundImage !== 'none') {
      const g = gradientDef(scs.backgroundImage, 0, 0, doc.size.width, doc.size.height, defs)
      if (g) body.push(`<rect width="${doc.size.width}" height="${doc.size.height}" fill="${g}"/>`)
    }
    const byId = new Map(slide.elements.map((e) => [e.id, e]))
    // video, audio and embeds draw as their still (poster, icon, card) — a file holds no live media
    for (const node of [...surface.children] as HTMLElement[]) {
      const el = byId.get(node.dataset.elId ?? '')
      if (el && (el.type === 'media' || el.type === 'embed')) {
        const still = renderElement(el, doc, { svgAsImage: true, hidePlaceholders: true })
        still.style.clipPath = node.style.clipPath
        node.replaceWith(still)
      }
    }
    for (const node of [...surface.children] as HTMLElement[]) {
      const el = byId.get(node.dataset.elId ?? '')
      // at 0% an element draws nothing (an export's clipping frame rides along so)
      if (!el || el.opacity === 0 || getComputedStyle(node).display === 'none') continue
      // measure unturned and unmirrored; the group puts the turn and the mirror back
      const lifted: Array<[HTMLElement | SVGElement, string]> = [[node, node.style.transform]]
      if (el.flipX || el.flipY) for (const c of node.children) lifted.push([c as HTMLElement, (c as HTMLElement).style.transform])
      for (const [e] of lifted) e.style.transform = 'none'
      const clipCss = node.style.clipPath
      try {
        const nr = node.getBoundingClientRect()
        const ctx: Ctx = { defs, fonts, css: runtime + '\n' + fontCss, ox: nr.left, oy: nr.top }
        let inner = ''
        for (const c of node.childNodes) {
          if (c.nodeType === Node.ELEMENT_NODE) inner += await convert(c as Element, ctx)
          else if (c.nodeType === Node.TEXT_NODE) inner += textRuns(c as Text, ctx)
        }
        const cx = el.w / 2, cy = el.h / 2
        if (el.flipX || el.flipY) inner = `<g transform="translate(${n(cx)} ${n(cy)}) scale(${el.flipX ? -1 : 1} ${el.flipY ? -1 : 1}) translate(${n(-cx)} ${n(-cy)})">${inner}</g>`
        const ns = getComputedStyle(node)
        // the node's own box paints too (a code block's or embed's background lives on it)
        let own = ''
        if (visible(ns.backgroundColor)) own = `${roundRect(0, 0, el.w, el.h, radii(ns))} fill="${esc(ns.backgroundColor)}"/>`
        const attrs = [
          `transform="translate(${n(el.x)} ${n(el.y)})${el.rotation ? ` rotate(${n(el.rotation)} ${n(cx)} ${n(cy)})` : ''}"`,
          `data-el-id="${esc(el.id)}"`,
          (el.opacity ?? 1) < 1 ? `opacity="${n(el.opacity)}"` : '',
          el.blend && el.blend !== 'normal' ? `style="mix-blend-mode:${esc(el.blend)}"` : '',
          el.alt ? `aria-label="${esc(el.alt)}" role="img"` : '',
        ].filter(Boolean).join(' ')
        const clip = frameClipPath(clipCss, el.w, el.h, defs)
        const filter = filterFor(el, defs)
        // filter outside, clip inside: a shadow is cast by what remains after the clip
        body.push(`<g ${attrs}${filter}><g${clip}>${own}${inner}</g></g>`)
      } finally {
        for (const [e, t] of lifted) e.style.transform = t
      }
    }
    // the deck's own faces, for the families this export uses
    const used = [...fonts].flatMap((f) => f.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '').toLowerCase()))
    const faces = [...fontCss.matchAll(/@font-face\s*{[^}]*}/g)].map((m) => m[0])
      .filter((f) => used.includes((/font-family:\s*["']?([^;"']+)/.exec(f)?.[1] ?? '').trim().toLowerCase()))
    const style = faces.length ? `<style>${cdata(faces.join('\n'))}</style>` : ''
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(v.w)}" height="${n(v.h)}" viewBox="${n(v.x)} ${n(v.y)} ${n(v.w)} ${n(v.h)}">` +
      `<title>${esc(doc.title || 'Bento slide')}</title>${style}<defs>${defs.join('')}</defs>${body.join('')}</svg>`
  } finally {
    host.remove()
  }
}
