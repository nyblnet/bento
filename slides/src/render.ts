// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Shared model → DOM renderer. One code path draws slides everywhere:
// editor canvas, sidebar thumbnails, and Reveal.js sections.

import { offlineEnabled, isRemoteUrl, remoteSrcBlocked } from '../../kernel/src/net.ts'
import type { BentoDoc, EmbedElement, Slide, SlideElement, SvgElement, TableElement } from './model'
import { morphKey, paginates, isWebUrl } from './model'
import { chartSnapshotSvg } from './charts'
import { renderMath as mathsLite, mathError } from './maths/index.ts'
import { resolveMathHtml } from './maths/delimiters.ts'
import { renderCodeInto } from './code'
import { formatDate } from './datefmt'
import { cropImgStyle, isIdentityCrop } from './crop'
// the shared svg sanitizer (kernel/src/svgsafe.ts, lifted from here): names
// re-exported so callers and rigs keep importing them from the renderer, and
// cssDecodeIdentEscapes is the SAME decoder the colour gate below reads with
import { SVG_TAGS, svgAttrAllowed, svgHrefAllowed, svgUrlRefsAllowed, sanitizeSvgCss, cssDecodeIdentEscapes, cleanSvgChildren } from '../../kernel/src/svgsafe.ts'
export { SVG_TAGS, svgAttrAllowed, svgHrefAllowed, svgUrlRefsAllowed, sanitizeSvgCss }

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
  /** EDITOR CANVAS only: mark a formula that did not render (dotted
   *  underline + a title from this, given what went wrong — `\\foo`, or
   *  "spaces" for `$ x^2 $`). Thumbnails, present, print and the static
   *  preview never pass it, so the hint never leaves the editor. */
  mathHint?: (what: string) => string
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
 * → "06"; date/time take an optional PATTERN — {{date:M/D/YY}} pins the shape
 * for every viewer (datefmt.ts), bare {{date}} follows the viewer's locale.
 * The MODEL stores the raw token; only rendered output is resolved, so
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
      case 'date': return escapeFieldText(arg?.trim() ? formatDate(ctx.date, arg.trim()) : ctx.date.toLocaleDateString())
      case 'time': return escapeFieldText(arg?.trim() ? formatDate(ctx.date, arg.trim()) : ctx.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
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

/**
 * The src to actually put on an element, or '' when offline mode must not let
 * it out. Media and images are loaded by the BROWSER from a src attribute,
 * not by us from a fetch — so no wrapper around fetch() can see them, and a
 * deck's remote <video> sailed straight through the offline switch
 * (GHSA-5c3x-xqp6-g94r: measured, 4 requests). A remote src in a document is
 * also a tracking beacon, and offline mode is exactly what a careful reader
 * turns on before opening a deck they do not trust.
 *
 * Callers must OMIT the attribute rather than set it to '', because
 * `video.src = ''` resolves against the page and makes browsers request the
 * document's own URL — a blank src is a request, not the absence of one.
 */
export function assetSrc(doc: BentoDoc, ref: string): string {
  const url = resolveAsset(doc, ref)
  return remoteSrcBlocked(url) ? '' : url
}

/** Attributes a browser will go to the network for, all element types. */
const URL_ATTRS = ['src', 'href', 'xlink:href', 'poster', 'srcset', 'data'] as const

/**
 * Last line of defence for offline mode: strip every remote reference from a
 * rendered subtree.
 *
 * assetSrc covers the srcs the RENDERER emits, but author content is markup —
 * an svg's `<image href="https://…">` (which the sanitizer allows on purpose,
 * because it is a legitimate picture), an `<img>` inside a text box or a table
 * cell — and that markup is injected as HTML without passing through any of
 * our src helpers. A browser fetches those the moment they are in the
 * document. No wrapper around fetch() can see it and no allowlist can, since
 * the markup is perfectly legitimate; the only question offline mode asks is
 * where it POINTS.
 *
 * A remote reference in a document you were sent is also the cheapest tracking
 * beacon there is, and offline mode is precisely what a careful reader turns
 * on before opening one.
 */
export function stripRemoteRefs(node: HTMLElement): void {
  if (!offlineEnabled()) return
  const all = [node, ...node.querySelectorAll<HTMLElement>('*')]
  for (const e of all) {
    for (const a of URL_ATTRS) {
      const v = e.getAttribute?.(a)
      if (v && isRemoteUrl(v)) {
        e.removeAttribute(a)
        e.dataset.bentoOffline = '1'
      }
    }
  }
}

function svgMarkup(el: SvgElement, doc: BentoDoc): string {
  return (el.asset ? doc.assets?.[el.asset] : el.markup) ?? ''
}

// --- embed -----------------------------------------------------

/** The only url a live frame will load. Judged here as well as at the paste
 *  boundary, because a deck opened from disk never passes through untrusted.ts. */

/**
 * May this embed get a live iframe right now?
 *
 * Two different kinds of offline, one answer. Bento's offline switch is a
 * privacy promise ("nothing leaves this computer") and is asked through
 * net.ts, the one place that knows it; a missing network is `navigator.onLine`.
 * Both fall back to `view`, which is what makes the deck presentable on
 * conference wifi and what keeps the switch honest. Pure, so the rig can
 * inspect the decision without a DOM (scripts/test-embed.ts).
 */
export function liveFrameAllowed(el: EmbedElement): boolean {
  if (el.live !== true || el.app !== 'web') return false
  const url = typeof el.url === 'string' ? el.url.trim() : ''
  if (!isWebUrl(url) || remoteSrcBlocked(url)) return false
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  return !nav || nav.onLine !== false
}

/**
 * The live frame. Sandboxed with NO `allow-same-origin` and no top
 * navigation: every deck is untrusted input, and a page of someone else's
 * choosing gets a screen, never this document. `error` swaps back to the
 * view underneath; the view is never removed, so a frame that fails to paint
 * still leaves a picture.
 */
function liveFrame(el: EmbedElement, opts: RenderOpts): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts allow-forms')
  frame.referrerPolicy = 'no-referrer'
  frame.title = el.url ?? ''
  frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:transparent'
    + (opts.liveMedia ? '' : ';pointer-events:none') // inert on the canvas, same reason as media
  frame.addEventListener('error', () => frame.remove(), { once: true })
  frame.src = el.url!.trim()
  return frame
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

// The shape renderer moved to the kernel (kernel/src/shape.ts) so bento/spaces
// diagrams render shapes through one engine. Re-exported here so render.ts stays
// the import site (present.ts imports gradientLineCoords; renderElement below uses
// shapeSvg and cssLinearGradient) and the pixels are unchanged.
import { cssLinearGradient, shapeSvg } from '../../kernel/src/shape.ts'
export { cssLinearGradient, gradientLineCoords, shapeSvg } from '../../kernel/src/shape.ts'

// --- math ($…$ → MathML) -----------------------------------------------------

/**
 * LaTeX math in text, resolved at RENDER time — the same trick resolveFields
 * uses for {{page}}. The MODEL stores the raw source (`$E=mc^2$`), so the
 * format gains nothing to version: an older build opening a newer file shows
 * the literal `$E=mc^2$` — degraded, legible, and nothing is lost.
 *
 * MathML, not HTML+CSS, is what makes this affordable: the engine emits MathML
 * and the browser lays it out with its own math fonts; KaTeX would have to
 * ship a layout engine AND ~20 webfont faces (measured: +421KB). Temml did
 * this at +64KB until 2026-09-15; src/maths does it at ~8KB and adds Typst.
 *
 * MUST run AFTER sanitizeHtml, never before: the sanitizer unwraps every tag
 * outside its allowlist and strips all attributes, so it would demolish the
 * MathML. Running after is also why the allowlist needs no widening — this
 * markup is GENERATED by us from LaTeX source, never accepted from the author.
 * The engine emits only attributes it constructs itself — no \href, no
 * handlers, no author-supplied style — so trust is not a setting here.
 */
// A small LRU (Map keeps insertion order): a deck's formulas are few and
// re-rendered often; an unbounded cache would grow with every keystroke
// while a formula is being typed.
const MATH_CACHE_MAX = 256
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
      ; (leaf as HTMLElement).dataset.sym = `${txt}#${n}`
  }
  // Scaffolding gets its own key, on a SEPARATE attribute. A fraction bar and
  // a radical are drawn by the mfrac/msqrt box itself, not by any token, so
  // they carry no data-sym and used to be the one part of a formula that
  // neither travelled nor faded — they were simply there from frame one while
  // everything around them animated. They must never enter the symbol morph:
  // transforming a container would move its children a second time, on top of
  // their own travel. Keyed by tag occurrence so scaffolding that SURVIVES a
  // step (the outer fraction of a rearranged equation) is recognised and left
  // alone, while genuinely new scaffolding can be faded in.
  const struct = new Map<string, number>()
  for (const box of Array.from(tpl.content.querySelectorAll('mfrac, msqrt, mroot, menclose, mover, munder, munderover'))) {
    const tag = box.tagName.toLowerCase()
    const n = struct.get(tag) ?? 0
    struct.set(tag, n + 1)
      ; (box as HTMLElement).dataset.msx = `${tag}#${n}`
  }
  return tpl.innerHTML
}

// Bento's own maths engine (src/maths, 2026-09-15; it replaced Temml — see
// docs/DECISIONS.md). THE SYNTAX MARKER: `$typst: …$` (and `$$typst: …$$`)
// is Typst maths — `typst:` immediately after the opening delimiter,
// optional whitespace after the colon, case-sensitive; anything else is
// LaTeX exactly as before. Nothing in the file format changes: the marker is
// part of the text the author typed, and an older shell shows it as typed.
function renderMath(src: string, display: boolean): string | null {
  const key = (display ? 'D' : 'I') + src
  const hit = mathCache.get(key)
  if (hit !== undefined) { mathCache.delete(key); mathCache.set(key, hit); return hit || null }
  let out: string | null = null
  try {
    const tex = decodeEntities(src)
    const m = /^typst:\s*/.exec(tex)
    // lenient (#551): an unknown command shows as its name, the rest renders
    const ml = mathsLite(m ? tex.slice(m[0].length) : tex, { display, syntax: m ? 'typst' : 'latex', lenient: true })
    out = ml ? tagSymbols(ml) : null // not valid maths — leave the author's text exactly as typed
  } catch {
    out = null
  }
  mathCache.set(key, out ?? '')
  if (mathCache.size > MATH_CACHE_MAX) mathCache.delete(mathCache.keys().next().value!)
  return out
}

// Where the formulas are — the four delimiters, text runs only (#465), and
// display formulas across line breaks (#540) — lives in maths/delimiters.ts,
// DOM-free so its rigs drive the code itself.
export function resolveMath(html: string, hint?: (what: string) => string): string {
  return resolveMathHtml(html, renderMath, hint && ((src, display, spaced) => {
    if (spaced) return hint('spaces')
    const tex = decodeEntities(src)
    const m = /^typst:\s*/.exec(tex)
    const why = mathError(m ? tex.slice(m[0].length) : tex, { display, syntax: m ? 'typst' : 'latex' })
    return why ? hint(why) : null
  }))
}

/**
 * The rich-text vocabulary a text element (and a table cell) may use.
 *
 * Every tag here is ATTRIBUTE-FREE by construction — the sanitizer strips all
 * attributes unconditionally, so a tag can only ever mean what its name means.
 * That is why formatting is expressed as semantic tags rather than styled
 * spans: a `<span style>` route would need the sanitizer to start reasoning
 * about declarations, and this format's whole defence is that it does not.
 *
 * The block tags (UL/OL/LI, H1/H2) are newer than the inline ones. An older
 * shell that has not heard of them UNWRAPS them and keeps the words, so a deck
 * with lists opens everywhere — it simply loses the bullets until the reader
 * updates. Sanitizing happens at RENDER time, so that degradation is visual
 * only; the model keeps the markup unless that box is edited in the old shell.
 */
const ALLOWED_TAGS = new Set([
  'B', 'I', 'U', 'BR', 'SPAN', 'DIV', 'P', 'STRONG', 'EM', 'S', 'CODE',
  'UL', 'OL', 'LI', 'H1', 'H2', 'A',
])

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
          // unwrap unknown elements, keep their text — walking what they held
          // first, so lifted children are held to the same rule as siblings
          walk(elChild)
          while (elChild.firstChild) node.insertBefore(elChild.firstChild, elChild)
          elChild.remove()
          continue
        }
        // No attribute survives — except an anchor's href when it is a web
        // URL (isWebUrl: http/https only, so javascript:/data: never land in
        // a document). target/rel are decided at click time, never stored.
        const href = elChild.tagName === 'A' ? elChild.getAttribute('href') : null
        for (const attr of Array.from(elChild.attributes)) elChild.removeAttribute(attr.name)
        if (elChild.tagName === 'A') {
          if (isWebUrl(href)) elChild.setAttribute('href', href)
          else { walk(elChild); while (elChild.firstChild) node.insertBefore(elChild.firstChild, elChild); elChild.remove(); continue }
        }
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
/**
 * `scope` is REQUIRED, not optional. The bug this signature exists to prevent
 * was precisely a markup path that never got scoped, so an optional parameter
 * would leave the leak one omission away and make the unsafe call the shorter
 * one. There is one caller; costing it a selector is free.
 */
export function sanitizeSvg(markup: string, scope: string): DocumentFragment {
  const out = document.createDocumentFragment()
  if (!markup) return out
  const parsed = new DOMParser().parseFromString(markup, 'text/html')
  // Scoped as well as sanitized. An svg <style> applies DOCUMENT-WIDE, so one
  // diagram's rules would reach every other svg on the page — the exact hazard
  // scopeCss exists for, which once only `el.css` got.
  // (the walk sanitizes each sheet itself; this hook only scopes it)
  cleanSvgChildren(parsed.body, { scopeStyle: (css) => scopeCss(css, scope) })
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
  if (/expression|@|\\/i.test(s) || CSS_NOT_A_COLOUR.test(s)) return fallback
  return s
}

/**
 * Functions a colour never needs and a fetch or an indirection does: url() and
 * the image functions load, var()/env()/attr() pull a value the gate never saw,
 * paint()/element() reach outside the value. A colour written with any of them
 * is not a colour, so it never reaches a sink.
 */
const CSS_NOT_A_COLOUR = /\b(url|image-set|-webkit-image-set|image|cross-fade|element|paint|env|attr|var)\s*\(/i

/**
 * An svg paint (`fill`, `stroke`, `stop-color`) from the document. The only
 * url() a paint may carry is a LOCAL paint server, `url(#id)` (gradients and
 * patterns are drawn that way); anything else goes through cssColor, so an
 * external paint server, which the browser fetches, never reaches the
 * attribute.
 */
export function svgPaint(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  const s = v.trim()
  if (/^url\(\s*#[-\w.:]+\s*\)$/.test(s) || s === 'none') return s
  return cssColor(s, fallback)
}

/**
 * A shape's paint, gated: what the shape sinks (render, and present's morph,
 * which tweens fill/stroke/stop-color straight into attributes) receive
 * instead of the model's own strings. A copy; the model is untouched.
 */
export function paintSafeShape<T extends { fill?: unknown; stroke?: unknown; fillGradient?: { stops?: Array<{ color?: unknown }> } }>(el: T): T {
  const out = { ...el }
  if ('fill' in el) out.fill = svgPaint(el.fill, 'transparent')
  if ('stroke' in el) out.stroke = svgPaint(el.stroke, 'transparent')
  if (el.fillGradient?.stops) {
    out.fillGradient = { ...el.fillGradient, stops: el.fillGradient.stops.map((s) => ({ ...s, color: cssColor(s.color, 'transparent') })) }
  }
  return out
}

/**
 * A chart option for the engine, with every string that could load something
 * removed (the engine writes option colours into svg fill/stroke attributes).
 * A copy; labels, names and template formatters pass unchanged unless they
 * carry a fetching function, which no legitimate one does.
 */
export function fetchFreeOption<T>(v: T): T {
  // judged as the svg attribute's CSS parser will read it: escapes decoded, so
  // `u\rl(` and `\75 rl(` are the url( they spell
  if (typeof v === 'string') return (CSS_NOT_A_COLOUR.test(cssDecodeIdentEscapes(v)) ? '' : v) as T
  if (Array.isArray(v)) return v.map(fetchFreeOption) as T
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fetchFreeOption(x)])) as T
  return v
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
  // A radius rounds the corners by CLIPPING, so the clip must follow the table,
  // not the box: a wrapper held at the box's height cut off every row the box
  // was too short for, with nothing on screen saying so (#494). As a flex column
  // with min-height the table still fills a short box (it grows into it) and a
  // long one makes the wrapper taller — rows overflow visibly, exactly as they
  // do without a radius, and the rounded corners sit on the real bottom.
  // validate()'s `table-overflow` reports the box being too short.
  const wrap = rad
    ? `min-height:100%;display:flex;flex-direction:column;border-radius:${rad}px;overflow:hidden;`
    : 'height:100%;'
  const tableH = rad ? 'flex:1 0 auto;' : 'height:100%;'
  return (
    `<div class="bento-table-wrap" style="width:100%;${wrap}">` +
    `<table class="bento-table" style="width:100%;${tableH}border-collapse:collapse;` +
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
      // List markers need to know. `outside` hangs a marker at the box's start
      // edge, which is only where it belongs when the line starts there too —
      // centre or right the text and the markers stay pinned to the left,
      // detached from the words they belong to (styles.css keys off this).
      inner.dataset.align = el.align
      inner.style.lineHeight = String(el.lineHeight)
      if (el.letterSpacing) inner.style.letterSpacing = `${el.letterSpacing}px`
      inner.style.width = '100%'
      inner.innerHTML = resolveMath(sanitizeHtml(resolveFields(el.html, opts.fields)), opts.mathHint)
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
      node.appendChild(shapeSvg(paintSafeShape(el)))
      break
    case 'table':
      node.dataset.table = '1'
      node.innerHTML = renderTableHtml(el, doc)
      break
    case 'image': {
      const img = document.createElement('img')
      const imgSrc = assetSrc(doc, el.src)
      if (imgSrc) img.src = imgSrc
      else img.dataset.bentoOffline = '1'
      img.draggable = false
      if (el.crop && !isIdentityCrop(el.crop)) {
        // A crop: the frame clips and carries the radius; the picture inside
        // is enlarged and offset by the one mapping in crop.ts (canvas,
        // thumbnails, present, print and the preview all come through here).
        node.style.overflow = 'hidden'
        node.style.borderRadius = `${el.radius}px`
        img.style.cssText = cropImgStyle(el.crop)
      } else {
        img.style.cssText = `width:100%;height:100%;object-fit:${el.fit};border-radius:${el.radius}px;display:block`
      }
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
          const posterSrc = assetSrc(doc, el.poster)
          if (posterSrc) img.src = posterSrc
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
        const audioSrc = assetSrc(doc, el.src)
        if (audioSrc) audio.src = audioSrc
        audio.controls = el.controls !== false
        audio.loop = !!el.loop
        audio.preload = 'metadata'
        // OMITTED, not emptied, when autoplay is off. Reveal decides autoplay
        // with hasAttribute('data-autoplay') — presence, not value — so
        // data-autoplay="" made it play a clip the author had switched OFF
        // (reported 2026-08-22). Our own startMediaIn reads [data-autoplay="1"]
        // and was never the problem; Reveal simply gets there first.
        if (el.autoplay) audio.dataset.autoplay = '1'
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
      const videoSrc = assetSrc(doc, el.src)
      if (videoSrc) video.src = videoSrc
      else if (el.src) video.dataset.bentoOffline = '1'
      const posterUrl = assetSrc(doc, el.poster ?? '')
      if (posterUrl) video.poster = posterUrl
      video.controls = el.controls !== false
      video.loop = !!el.loop
      video.muted = el.muted !== false
      video.playsInline = true
      video.preload = 'metadata'
      if (el.autoplay) video.dataset.autoplay = '1' // presence is the flag — see the audio case
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
      node.innerHTML = chartSnapshotSvg({ ...el, option: fetchFreeOption(el.option) })
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
      node.appendChild(sanitizeSvg(markup, `[data-el-id="${CSS.escape(el.id)}"]`))
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
    case 'embed': {
      // The view ALWAYS paints, by the svg element's own two
      // paths: an inert data-URI <img> for thumbnails, sanitizeSvg live. An
      // unknown `app` is rendered, not rejected: its view is still a picture.
      // The live frame is layered on top only when liveFrameAllowed says so,
      // and never in a thumbnail, which must not reach the network for a
      // sidebar.
      node.dataset.embed = '1'
      node.style.overflow = 'hidden' // .bento-el is already positioned; the frame sits over the view
      const markup = resolveAsset(doc, el.view ?? '')
      let painted = false
      if (markup) {
        if (opts.svgAsImage) {
          const img = document.createElement('img')
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup)
          img.draggable = false
          img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block'
          node.appendChild(img)
          painted = true
        } else {
          node.appendChild(sanitizeSvg(markup, `[data-el-id="${CSS.escape(el.id)}"]`))
          const svg = node.querySelector('svg')
          if (svg) {
            svg.style.width = '100%'
            svg.style.height = '100%'
            svg.style.display = 'block'
            painted = true
          }
        }
      }
      if (!painted) {
        // Never an empty box: a view that is missing or was refused still
        // says what it is, and its source is still there to open elsewhere.
        const ph = document.createElement('div')
        ph.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#eef2f7;color:#93a2b6;font-size:14px'
        ph.textContent = el.app === 'web' && el.url ? el.url : `⧉ ${el.app || 'embed'}`
        node.appendChild(ph)
      }
      // ...and only on a LIVE surface (present mode passes liveMedia). The
      // editor canvas re-renders on every edit; a frame there would navigate
      // to the author's URL on each repaint, inert or not.
      if (!opts.svgAsImage && opts.liveMedia && liveFrameAllowed(el)) node.appendChild(liveFrame(el, opts))
      break
    }
    case 'code': {
      node.style.display = 'flex'
      node.style.flexDirection = 'column'
      node.style.justifyContent = VALIGN[el.valign]
      // Clip at the ELEMENT box — the size the author chose — and never at the
      // <pre> (see below). Code sets `white-space: pre`, so a long line does
      // not wrap and would otherwise run across the slide over whatever sits
      // beside it; bounding it to its own box keeps the author's layout
      // contract. The box is normally far larger than the lines inside it,
      // which is exactly the room a morphing token needs.
      node.style.overflow = 'hidden'
      const inner = document.createElement('pre')
      inner.className = 'bento-text-inner'
      inner.dir = 'auto'
      inner.style.fontSize = `${el.fontSize}px`
      inner.style.fontFamily = el.fontFamily || doc.theme.fontFamily
      inner.style.textAlign = el.align
      inner.style.lineHeight = String(el.lineHeight)
      inner.style.width = '100%'
      inner.style.color = el.color
      inner.classList.add('bento-code')
      inner.style.whiteSpace = 'pre'
      inner.style.margin = '0'
      // NOT overflow:hidden here. A <pre> is only as tall as its own lines,
      // and a morphing token starts at its position on the OTHER slide —
      // outside those bounds whenever the block gets shorter. Clipping at this
      // level painted a travelling token 48px below the box and cut it away:
      // it vanished for the first half of its journey and popped into view
      // mid-flight, and only in the direction where the code got shorter,
      // since the taller side had room for the same motion. That asymmetry is
      // what made it read as a pairing bug rather than a painting one.
      // Found in a screenshot — the DOM reported opacity 1, a correct 80px
      // transform and a sensible rect, all true, all outside a clipping box.
      if (!renderCodeInto(inner, el, doc)) {
        // Fallback to unformatted text
        inner.innerText = el.content
      }
      node.appendChild(inner)
      break
    }
  }
  // Every element type funnels through here, so this is the one place that
  // sees author markup after it has been built into DOM.
  stripRemoteRefs(node)
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
