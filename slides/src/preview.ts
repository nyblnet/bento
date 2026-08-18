// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The static first-page preview: what a Bento deck looks like to something
// that renders its HTML but never runs its JavaScript.
//
// WHY THIS EXISTS. Thumbnailers — iOS Files, macOS QuickLook/Finder, the Bento
// Tray app — render HTML with scripting off. Until our runtime boots, every
// deck is the same bytes plus the same boot splash, so every deck thumbnailed
// as the same dark box. The kernel (kernel/src/save.ts) parks what we build
// here inside a `<noscript>` on every save, which is rendered by exactly that
// population and by nobody else. See that file for the placement rules, the
// encryption veto and the output-safety check.
//
// WHY IT REUSES render.ts. A second renderer would drift from the first, and
// a preview that disagrees with the deck is worse than no preview. `svgAsImage`
// (the mode sidebar thumbnails already use) does most of the static-ifying for
// free: svg elements collapse to one <img>, and media renders as a poster or
// an icon chip instead of a live <video>/<audio>. What is left is stripping the
// runtime's DOM hooks, inlining the handful of rules the (absent) runtime
// stylesheet would have supplied, and fitting 1280×720 into an unknown
// viewport without JavaScript.
//
// HOW IT SCALES. `transform: scale(calc(min(100vw, <aspect>vh) / <width>px))`.
// CSS Values 4 length-over-length division yields the plain <number> that
// scale() needs, so the whole page scales as ONE unit and every inline px the
// renderer emitted stays untouched. Measured in the real macOS thumbnailer
// (`qlmanage -t`) and pixel-exact there.
//
// WHAT DID NOT WORK, so nobody re-tries it: `<svg viewBox><foreignObject>`,
// the textbook way to fit HTML into a box. Chrome renders it correctly, and
// QuickLook's WebKit does not — absolutely-positioned children vanished and
// the content scaled non-uniformly. It is not usable for the one renderer this
// feature exists to serve.

import { renderSlide } from './render'
import { PREVIEW_BUDGET, type BentoDoc, type Slide, inLinearFlow } from './model'

/** Elements that must never reach a static preview (active or external). */
const BANNED = 'script,style,noscript,iframe,object,embed,link,video,audio,canvas,form,input,button'

/**
 * Runtime-only attributes: selection ids, morph keys, editing hooks. Dead
 * weight in a preview, and every one of them is paid for in every saved file.
 *
 * `id` is deliberately NOT on this list, however useless it looks. svg paints
 * gradients, markers and clip paths through document-global `url(#…)`
 * references, so stripping ids silently voids every fill that uses one — the
 * starter deck's tiles rendered as nothing at all until this was caught.
 * render.ts already mints those ids from a counter, so they are unique.
 */
const DROP_ATTRS = [
  'data-el-id', 'data-flip-id', 'data-slide-id', 'data-link', 'data-group',
  'data-show-on-hover', 'data-chart', 'data-table', 'data-autoplay',
  'data-r', 'data-c', 'data-sym', 'contenteditable', 'draggable', 'tabindex',
]

/**
 * Generic families appended to every inline font-family.
 *
 * `doc.fonts[]` are injected as @font-face at boot from the asset table — which
 * is to say, by JavaScript, which is not running. Embedding the font data here
 * instead would cost hundreds of KB for a thumbnail. So the preview renders in
 * a system face; a fallback chain makes that a deliberate substitution rather
 * than whatever the UA picks for an unresolvable family name (usually Times).
 */
const FONT_FALLBACK = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`

/** Inline the rules `.bento-*` classes get from styles.css, which is compressed
 *  into a payload the preview's audience never decompresses. */
function inlineRuntimeCss(root: HTMLElement) {
  prepend(root, 'position:relative;overflow:hidden')
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.bento-el'))) {
    prepend(el, 'position:absolute')
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.bento-el-text .bento-text-inner'))) {
    prepend(el, 'overflow-wrap:break-word')
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.bento-el-table'))) {
    prepend(el, 'overflow:visible')
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.bento-cell-inner'))) {
    prepend(el, 'min-height:1em')
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('code'))) {
    prepend(el, 'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:0.9em;' +
      'background:rgb(127 127 127 / 0.16);padding:0 0.28em;border-radius:3px')
  }
}

/** Put `css` in front of the element's existing inline style (which wins). */
function prepend(el: HTMLElement, css: string) {
  const own = el.getAttribute('style') ?? ''
  el.setAttribute('style', own ? `${css};${own}` : css)
}

/**
 * Turn the live render into inert markup: drop anything active, drop the
 * runtime's hooks, and (when `keepImages` is false) drop raster payloads whose
 * data URIs would otherwise be carried twice in the file.
 */
function staticize(root: HTMLElement, doc: BentoDoc, keepImages: boolean) {
  for (const el of Array.from(root.querySelectorAll(BANNED))) el.remove()

  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    for (const attr of Array.from(el.attributes)) {
      // on* handlers can only arrive via sanitizeHtml's allowlist (which
      // strips every attribute) or our own code, so this is defence in depth.
      if (attr.name.startsWith('on') || DROP_ATTRS.includes(attr.name)) el.removeAttribute(attr.name)
    }
    const family = el.style?.fontFamily
    if (family && !family.includes(FONT_FALLBACK)) el.style.fontFamily = `${family},${FONT_FALLBACK}`
  }

  if (!keepImages) {
    for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
      // Keep the BOX — an empty rectangle where the photo was reads as
      // composition; removing it collapses the page into floating text.
      const tint = document.createElement('div')
      tint.setAttribute('style',
        `width:100%;height:100%;border-radius:${img.style.borderRadius || '0'};` +
        `background:linear-gradient(135deg,${doc.theme.accent}2E,${doc.theme.accent}12)`)
      img.replaceWith(tint)
    }
  }

  inlineRuntimeCss(root)
}

/** A background string safe to repeat behind the page: a flat colour repeats
 *  invisibly, a gradient or an embedded image does not (and a data: URI would
 *  be paid for twice). */
const flatBackground = (css: string) => (/url\(|gradient|data:/i.test(css) ? null : css)

/** Wrap a rendered page in the fixed, viewport-fitting overlay. */
function overlay(page: HTMLElement, doc: BentoDoc, slide: Slide): HTMLElement {
  const { width: w, height: h } = doc.size
  const surround = flatBackground(slide.background) ?? flatBackground(doc.theme.background) ?? '#0D1B2E'

  const box = document.createElement('div')
  // z-index above the splash (9999) and the loader's failure card (99999).
  box.setAttribute('style',
    `position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483000;` +
    `overflow:hidden;background:${surround}`)

  const fit = document.createElement('div')
  // Two `transform` declarations on purpose. calc() length-over-length is CSS
  // Values 4; a renderer that rejects it drops the second declaration and
  // keeps the first, showing the page centred at 1:1 (cropped, but the deck)
  // instead of nothing at all.
  const aspect = ((w / h) * 100).toFixed(4)
  fit.setAttribute('style',
    `position:absolute;left:50%;top:50%;width:${w}px;height:${h}px;` +
    `transform:translate(-50%,-50%);` +
    `transform:translate(-50%,-50%) scale(calc(min(100vw, ${aspect}vh) / ${w}px))`)

  fit.appendChild(page)
  box.appendChild(fit)
  return box
}

/** Last resort: the deck's identity in the deck's colours, a few hundred bytes. */
function titleCard(doc: BentoDoc): HTMLElement {
  const page = document.createElement('div')
  const { width: w, height: h } = doc.size
  page.setAttribute('style',
    `position:relative;overflow:hidden;width:${w}px;height:${h}px;` +
    `background:${flatBackground(doc.theme.background) ?? '#0D1B2E'};` +
    `display:flex;flex-direction:column;justify-content:center;padding:0 ${Math.round(w * 0.075)}px;` +
    `box-sizing:border-box;font-family:${FONT_FALLBACK}`)

  const rule = document.createElement('div')
  rule.setAttribute('style',
    `width:${Math.round(w * 0.07)}px;height:${Math.round(h * 0.011)}px;background:${doc.theme.accent};margin-bottom:${Math.round(h * 0.05)}px`)

  const title = document.createElement('div')
  title.setAttribute('style',
    `font-size:${Math.round(h * 0.1)}px;font-weight:800;line-height:1.1;color:${doc.theme.color};overflow-wrap:break-word`)
  title.textContent = doc.title

  page.append(rule, title)
  return page
}

// --- slimming ---------------------------------------------------------------
//
// A preview is paid for in every saved file, and it cannot be compressed: the
// shell's deflate trick is unavailable to an audience that never runs the
// loader. What it CAN be is non-repetitive. Measured on the starter deck, 25.6KB
// of preview was 6.2KB of data: URIs inlined 3-8 times over and 6.1KB of
// declarations repeated across elements (`position:absolute` x40, `width:100%`
// x39, a 65-byte font stack x8). Both collapse losslessly.
//
// The floor is the content's entropy — that same preview deflates to 2.7KB — so
// there is no point contorting this further.

/** Split a style attribute into declarations. Not `split(';')`: a data: URI
 *  carries its own semicolons (`;charset=utf-8,`) inside url(). */
function splitDecls(css: string): string[] {
  const out: string[] = []
  let depth = 0, quote = '', start = 0
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (quote) { if (c === quote && css[i - 1] !== '\\') quote = '' ; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ';' && depth === 0) { out.push(css.slice(start, i)); start = i + 1 }
  }
  out.push(css.slice(start))
  return out.map((d) => d.trim()).filter(Boolean)
}

const propOf = (decl: string) => decl.slice(0, decl.indexOf(':')).trim().toLowerCase()

/** Shorthands that can swallow a longhand we might hoist out from under them. */
const SHORTHANDS = new Set([
  'background', 'font', 'border', 'margin', 'padding', 'flex', 'grid',
  'transition', 'animation', 'inset', 'outline', 'overflow', 'list-style',
  'text-decoration', 'place-items', 'place-content', 'gap',
])

const FIT_TO_SIZE: Record<string, string> = {
  contain: 'contain', cover: 'cover', fill: '100% 100%',
  none: 'auto', 'scale-down': 'contain',
}

/**
 * `<img src=data:…>` becomes a div painting the same bytes as a background.
 *
 * Only so the URI becomes a DECLARATION, which hoistRepeats can then share
 * between every element using it. The starter deck's two bokeh sprites are
 * inlined eight times each; as a background they are written once. object-fit
 * maps onto background-size exactly, and `center`/`no-repeat` reproduce an
 * img's default placement.
 */
function imagesToBackgrounds(root: HTMLElement) {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src')
    // A quote in the URI would need escaping inside url("…"); percent-encoded
    // payloads never contain one, so skipping is free insurance.
    if (!src || src.includes('"')) continue

    const kept: string[] = []
    let size = 'contain'
    for (const d of splitDecls(img.getAttribute('style') ?? '')) {
      const p = propOf(d)
      if (p === 'object-fit') { size = FIT_TO_SIZE[d.slice(d.indexOf(':') + 1).trim()] ?? 'contain'; continue }
      if (p === 'object-position') continue
      kept.push(d)
    }
    kept.push(`background-image:url("${src}")`, 'background-repeat:no-repeat',
              'background-position:center', `background-size:${size}`)

    const div = document.createElement('div')
    div.setAttribute('style', kept.join(';'))
    for (const c of Array.from(img.classList)) div.classList.add(c)
    img.replaceWith(div)
  }
}

/**
 * Move declarations that repeat across elements into one stylesheet.
 *
 * An inline style always beats a class rule, so a declaration is only movable
 * when its property appears EXACTLY ONCE on that element — otherwise hoisting
 * one of a pair silently flips which of the two wins. Same reason a longhand is
 * left alone whenever its shorthand is present on the same element.
 *
 * Moving these is not just cheaper but more faithful: the rules being inlined
 * are what `.bento-*` classes get from styles.css, and they are supposed to sit
 * BELOW the element's own inline style in the cascade, which is exactly where a
 * class rule sits.
 */
function hoistRepeats(root: HTMLElement) {
  const parsed = Array.from(root.querySelectorAll<HTMLElement>('[style]'))
    .map((el) => ({ el, decls: splitDecls(el.getAttribute('style') ?? '') }))

  const movable = ({ decls }: { decls: string[] }, i: number) => {
    const props = decls.map(propOf)
    const p = props[i]
    // A `<` in a declaration must stay inline. The stylesheet is raw text, so a
    // hoisted `</style>` would close it early and the rest would parse as live
    // markup (kernel previewIsSafe/styleIsInert refuses the whole preview for
    // exactly that). Inline, the same bytes are attribute text and get escaped.
    // Not only hardening: imagesToBackgrounds writes background-image:url("<src>"),
    // and a single-quoted `data:image/svg+xml,<svg xmlns='…'>` image is a legal
    // src containing `<` — hoisting it cost that deck its thumbnail outright.
    if (decls[i].includes('<')) return false
    if (props.indexOf(p) !== props.lastIndexOf(p)) return false
    const root_ = p.slice(0, p.indexOf('-') < 0 ? p.length : p.indexOf('-'))
    if (p !== root_ && SHORTHANDS.has(root_) && props.includes(root_)) return false
    return true
  }

  const freq = new Map<string, number>()
  for (const rec of parsed) {
    rec.decls.forEach((d, i) => { if (movable(rec, i)) freq.set(d, (freq.get(d) ?? 0) + 1) })
  }

  // Worth a class only if the rule costs less than the copies it replaces.
  const name = (n: number) => '_' + n.toString(36)
  const names = new Map<string, string>()
  const rules: string[] = []
  const ranked = [...freq].sort((a, b) => b[1] * b[0].length - a[1] * a[0].length)
  for (const [decl, count] of ranked) {
    const cls = name(names.size)
    const inline = count * (decl.length + 1)
    const hoisted = count * (cls.length + 1) + `.${cls}{${decl}}`.length
    if (hoisted >= inline) continue
    names.set(decl, cls)
    rules.push(`.${cls}{${decl}}`)
  }
  if (!rules.length) return

  for (const rec of parsed) {
    const keep: string[] = []
    const add: string[] = []
    rec.decls.forEach((d, i) => {
      const cls = movable(rec, i) ? names.get(d) : undefined
      if (cls) add.push(cls)
      else keep.push(d)
    })
    if (!add.length) continue
    for (const c of add) rec.el.classList.add(c)
    if (keep.length) rec.el.setAttribute('style', keep.join(';'))
    else rec.el.removeAttribute('style')
  }

  const style = document.createElement('style')
  style.textContent = rules.join('')
  root.insertBefore(style, root.firstChild)
}

/** Sub-pixel precision no thumbnailer can resolve, at ~10 bytes a number. */
function roundNumbers(root: HTMLElement) {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[style]'))) {
    const css = el.getAttribute('style') ?? ''
    // Not inside url(): a percent-encoded payload is not ours to rewrite.
    if (css.includes('url(')) continue
    const lean = css.replace(/(\d+\.\d{3,})/g, (m) => String(Math.round(Number(m) * 100) / 100))
    if (lean !== css) el.setAttribute('style', lean)
  }
}

function slim(built: HTMLElement) {
  imagesToBackgrounds(built)
  roundNumbers(built)
  hoistRepeats(built)
}

const byteLength = (el: HTMLElement) => new TextEncoder().encode(el.outerHTML).length

/**
 * Build the static preview of the deck's first page, or null when there is
 * nothing to show. Registered with the kernel from main.ts.
 *
 * Three tiers, cheapest acceptable one wins, all bounded by PREVIEW_BUDGET:
 *   1. the page as it renders, images and all;
 *   2. the same page with raster payloads replaced by tinted boxes — layout
 *      and text survive, the megabytes do not;
 *   3. a title card in the deck's own colours.
 * Tier 3 cannot exceed the budget, so this always terminates with something.
 */
export function buildSlidePreview(doc: BentoDoc): HTMLElement | null {
  // The first page a reader sees. Nothing outside the linear flow can be it:
  // a state is a variant reachable only by clicking, and a hidden slide is
  // deliberately out of the show — neither should become the deck's face in a
  // file manager.
  const slide = doc.slides.find(inLinearFlow) ?? doc.slides[0]
  if (!slide) return null

  for (const keepImages of [true, false]) {
    const page = renderSlide(slide, doc, { svgAsImage: true, hidePlaceholders: true })
    staticize(page, doc, keepImages)
    if (!keepImages) page.style.background = flatBackground(slide.background) ?? doc.theme.background
    const built = overlay(page, doc, slide)
    // Slim BEFORE measuring, so the budget is spent on content rather than on
    // repetition — which also lets richer pages stay in tier 1.
    slim(built)
    if (byteLength(built) <= PREVIEW_BUDGET) return built
  }
  const card = overlay(titleCard(doc), doc, slide)
  slim(card)
  return card
}
