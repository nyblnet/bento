// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// UNTRUSTED SVG, made safe by allowlist: ONE sanitizer every app imports.
// Lifted verbatim from bento/slides' renderer (released, and held to
// scripts/test-sanitize.ts and the browser egress rigs), so there is one
// implementation to audit instead of one per app.
//
// What stays with each app is what is not security: how it parses its input
// into an inert document, and how it SCOPES a kept <style> sheet (slides'
// scopeCss, hard-won detail #7). Both come in through the policy.
//
// THE POLICY ONLY TIGHTENS. Slides' lists and rules are the default: a caller
// that passes nothing extra gets exactly slides' behaviour, and every option
// refuses MORE (a tag, an attribute, data-* names, remote hrefs, escapes or
// foreign schemes in a value). No option can add a name to a list. The one
// required field is `scopeStyle`, because there is no safe default scope: a
// caller either says how its kept sheets are scoped or refuses <style> outright.
// It is handed CSS the walk has ALREADY sanitized, so it can only scope: an app
// passing `css => css` keeps a sanitized, unscoped sheet, never a raw one
// (security, 2026-10-24).
//
// cssDecodeIdentEscapes is exported because slides' colour gate (render.ts,
// the themed-value sink) reads values through the SAME decoder. The two gates
// must agree on what an escaped `u\72l(` says, or one spelling slips past one.
//
// DOM-only where it walks or probes (DOMParser output, CSSStyleSheet); the pure
// decisions (svgAttrAllowed, svgHrefAllowed, svgUrlRefsAllowed, sanitizeSvgCss
// without a CSSOM) run in node, which is how the rigs pin them.

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
  // structure. `style` stays: it cannot execute, its text is run through
  // sanitizeSvgCss, and sanitizeSvg SCOPES it to the element instance (hard-won
  // detail #7) so its rules cannot leak into every other svg on the page.
  // That scoping is passed IN — the sanitizer has no element to name on its
  // own. An earlier version of this comment credited scopeCss directly, which
  // was false: scopeCss's only caller took `el.css`, the model field, and the
  // markup path below was never scoped at all.
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
  return Array.from(cssDecodeIdentEscapes(value).matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi))
    .map((m) => m[2].replace(/[\u0000-\u0020]/g, '').toLowerCase())
}


/**
 * CSS escapes that spell IDENTIFIER characters, decoded: `\75 ` is `u`, `\72`
 * is `r`, `\l` is `l`. The browser decodes escapes inside an ident before it
 * decides what the token is, so a check over the raw text has to read the
 * letters the browser will read. Escapes for anything else (`\28` for a
 * paren, `\22` for a quote) are left as they are: inside an ident they are
 * just part of the name, never syntax, and decoding them here would invent
 * syntax the browser never sees.
 */
export function cssDecodeIdentEscapes(css: string): string {
  return css.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([^\n\r\f0-9a-fA-F])/g, (m, hexs: string | undefined, ch: string | undefined) => {
    const c = hexs ? String.fromCodePoint(Math.min(parseInt(hexs, 16), 0x10ffff)) : ch!
    return /^[-\w]$/.test(c) || c.codePointAt(0)! >= 0x80 ? c : m
  })
}

/**
 * The CSS functions an untrusted svg sheet or style value may call, as an
 * ALLOWLIST, for the reason the at-rules below are one. A function that takes
 * an image can fetch, and some take the address as a bare string with no
 * `url(` in it; a list of the dangerous ones would be one browser release from
 * incomplete. Everything a diagram draws with is here: colour, maths,
 * transforms, gradients, filters, shapes, easing, grid sizing, font-face
 * descriptors, custom properties. `url` is policed on its own (in-document
 * `#` and `data:image/` targets only).
 */
const CSS_FN_ALLOWED = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark',
  'calc', 'min', 'max', 'clamp', 'round', 'mod', 'rem', 'abs', 'sign', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'pow', 'sqrt', 'hypot', 'log', 'exp',
  'var', 'env',
  'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d',
  'scale', 'scalex', 'scaley', 'scalez', 'scale3d', 'skew', 'skewx', 'skewy', 'matrix', 'matrix3d', 'perspective',
  'cubic-bezier', 'steps', 'linear',
  'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
  '-webkit-linear-gradient', '-webkit-radial-gradient', '-webkit-repeating-linear-gradient', '-webkit-repeating-radial-gradient',
  'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia',
  'circle', 'ellipse', 'inset', 'polygon', 'path', 'rect', 'xywh', 'ray',
  'counter', 'counters', 'minmax', 'repeat', 'fit-content', 'local', 'format', 'tech', 'selector',
  'url',
])

/** A function call in CSS text: a name (letters, escapes, non-ASCII) then `(`.
 *  `pre` is the character before it, so a caller can tell a call written
 *  straight after a colon. */
const CSS_FN_CALL = /(^|[^\w\\-])((?:[-\w]|\\[\s\S]|[^\x00-\x7f])+)\(/g

/**
 * Selector pseudo-classes and pseudo-elements that take an argument. After a
 * colon, a name on THIS list is a selector (`:not(`, `::part(`), not a value;
 * none of them can fetch. Every other call after a colon is a value
 * (`fill:rgb(`, `width:calc(`) and is judged by CSS_FN_ALLOWED like any other.
 * The text pass used to spare EVERY colon-preceded call, which left
 * `prop:fn(` with no space to the CSSOM check alone — caught there in every
 * browser, but this pass is meant to fail closed on its own.
 */
const CSS_PSEUDO_FNS = new Set([
  'not', 'is', 'where', 'has', 'matches', '-webkit-any', '-moz-any',
  'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'nth-col', 'nth-last-col',
  'lang', 'dir', 'host', 'host-context', 'state', 'active-view-transition-type',
  'slotted', 'part', 'cue', 'cue-region', 'highlight',
  'view-transition-group', 'view-transition-image-pair', 'view-transition-old', 'view-transition-new',
])

/** May this sheet call `name`? `pre` is the character in front of it. */
function cssCallAllowed(pre: string, name: string): boolean {
  if (name.includes('\\')) return false
  const n = name.toLowerCase()
  return CSS_FN_ALLOWED.has(n) || (pre === ':' && CSS_PSEUDO_FNS.has(n))
}

/**
 * Neutralise every function call a sheet may not make: RENAMED to one no
 * browser implements, so the declaration it sits in is invalid and CSS drops
 * it (the same fail-closed move as the at-rules). A name still holding an
 * escape after decoding is refused on sight.
 */
function cssRefuseFunctions(css: string): string {
  return css.replace(CSS_FN_CALL, (m, pre: string, name: string) =>
    cssCallAllowed(pre, name) ? m : `${pre}bento-refused(`)
}

/** Does this CSS text carry a fetch — an off-list function, or a url() to
 *  anything but `#…` / `data:image/…`? Escapes are decoded first. */
function cssFetches(text: string): boolean {
  const t = cssDecodeIdentEscapes(text)
  if (urlTargets(t).some((u) => !(u.startsWith('#') || u.startsWith('data:image/')))) return true
  return Array.from(t.matchAll(CSS_FN_CALL)).some((m) => !cssCallAllowed(m[1], m[2]))
}

/**
 * The browser's own reading of a sheet, where there is a browser. A
 * constructed CSSStyleSheet is parsed but never applied, so nothing in it
 * loads, and its rules serialise CANONICALLY: escapes decoded, a bare-string
 * image function written with `url(…)`. Every top-level rule's cssText (which
 * carries its nested rules: @media, @supports, @layer, nesting) is checked for
 * a fetch the text filter missed. There should never be one; if there is, the
 * whole sheet is dropped rather than trusted. `null` = no CSSOM here (the node
 * rigs), where the text filter, which fails closed on its own, is the answer.
 */
function cssomFindsFetch(css: string): boolean | null {
  if (typeof CSSStyleSheet === 'undefined') return null
  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(css)
    return Array.from(sheet.cssRules).some((r) => cssFetches(r.cssText))
  } catch {
    return true // the browser would not parse it: keep none of it
  }
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
export function svgUrlRefsAllowed(value: string, attr = ''): boolean {
  const n = attr.toLowerCase()
  const allowed = (t: string) => t.startsWith('#') || t.startsWith('data:image/')
  // aria-* and data-* are text, never parsed as CSS: an accessible label that
  // reads "f(x) = 2" is not a function call, so only a url() is looked at
  if (n.startsWith('aria-') || n.startsWith('data-')) return urlTargets(value).every(allowed)
  if (cssFetches(value)) return false
  // `style` is a declaration block: where there is a browser, its own parse
  // (on a detached element, which loads nothing) is checked too
  if (n === 'style' && typeof document !== 'undefined') {
    const probe = document.createElement('div')
    probe.style.cssText = value
    if (cssFetches(probe.style.cssText)) return false
  }
  return true
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
  // Function names are read the way the browser reads them — escapes decoded —
  // before anything is judged, then every function off the allowlist is
  // refused, then url() targets are checked on the decoded text.
  const fnFiltered = cssRefuseFunctions(cssDecodeIdentEscapes(atFiltered))
  const out = fnFiltered.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, _q: string, target: string) => {
    const v = String(target).replace(/[\u0000-\u0020]/g, '').toLowerCase()
    return v.startsWith('#') || v.startsWith('data:image/') ? m : 'none'
  })
  // …and where there is a browser, its own parse is the last word
  return cssomFindsFetch(out) === true ? '' : out
}

// --- the walk, and the per-app policy ------------------------------------------------

/**
 * How an app tightens the walk. Every field but `scopeStyle` is optional and
 * defaults to slides' behaviour; each one only ever refuses more.
 */
export interface SvgPolicy {
  /**
   * The app's SCOPING for a kept `<style>` element (slides: `css =>
   * scopeCss(css, scope)`). The walk runs sanitizeSvgCss first and hands this
   * the result, so it never sees, and can never keep, unsanitized CSS. `null`
   * refuses `<style>` elements AND `style` attributes outright.
   */
  scopeStyle: ((sanitizedCss: string) => string) | null
  /** Tags refused on top of SVG_TAGS. */
  refuseTags?: Iterable<string>
  /** Attributes refused on top of svgAttrAllowed. */
  refuseAttrs?: Iterable<string>
  /** `false` refuses every `data-*` attribute (default: the open, reserved-aware door). */
  dataAttrs?: boolean
  /**
   * `false` keeps an href only if it is a same-document `#ref`, or an inline
   * raster (`data:image/png|jpeg|gif|webp;base64,`) on `<image>`/`<feImage>`:
   * no http(s), no svg-as-data, no `<a>` navigation.
   */
  remoteHref?: boolean
  /**
   * `true` also refuses any non-href value carrying a CSS escape, a
   * `javascript:`/`vbscript:` or non-raster `data:` scheme anywhere, a url()
   * that is not a `#ref`, `@import`, `expression(` or an image-set.
   */
  strictValues?: boolean
}

interface Rules {
  tag: (t: string) => boolean
  attr: (n: string) => boolean
  scopeStyle: ((sanitizedCss: string) => string) | null
  remoteHref: boolean
  strictValues: boolean
}

function rulesOf(p: SvgPolicy): Rules {
  const tags = new Set(Array.from(p.refuseTags ?? [], (t) => t.toLowerCase()))
  const attrs = new Set(Array.from(p.refuseAttrs ?? [], (a) => a.toLowerCase()))
  if (p.scopeStyle === null) { tags.add('style'); attrs.add('style') }
  const data = p.dataAttrs !== false
  return {
    tag: (t) => SVG_TAGS.has(t) && !tags.has(t),
    attr: (n) => svgAttrAllowed(n) && !attrs.has(n) && (data || !n.startsWith('data-')),
    scopeStyle: p.scopeStyle,
    remoteHref: p.remoteHref !== false,
    strictValues: p.strictValues === true,
  }
}

const RASTER_DATA = /^data:image\/(png|jpe?g|gif|webp);base64,/

/** remoteHref:false: a `#ref` anywhere, an inline raster only on image/feImage. */
function localHrefAllowed(value: string, tag: string): boolean {
  const v = value.replace(/[\u0000-\u0020]/g, '').toLowerCase()
  if (v.startsWith('#')) return true
  return (tag === 'image' || tag === 'feimage') && RASTER_DATA.test(v)
}

/** strictValues: a presentation or SMIL value a picture needs, and no more. */
function strictValueAllowed(value: string): boolean {
  if (value.includes('\\')) return false
  if (/javascript:|vbscript:|data:(?!image\/(png|jpe?g|gif|webp);base64,)/i.test(value.replace(/[\u0000-\u0020]/g, ''))) return false
  for (const m of value.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    if (!m[2].trim().startsWith('#')) return false
  }
  return !/@import|expression\s*\(|image-set\s*\(|-webkit-image-set/i.test(value)
}

/**
 * Judge one element of an INERT parsed document, and everything under it.
 * `false` = the caller removes it. An element not on the list is removed WHOLE,
 * never unwrapped (see SVG_TAGS).
 */
function cleanElement(el: Element, r: Rules): boolean {
  const tag = el.localName.toLowerCase()
  if (!r.tag(tag)) return false

  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    if (!r.attr(name)) { el.removeAttribute(attr.name); continue }
    if (SVG_ANIM.has(tag) && name === 'attributename') {
      // An animation WRITES an attribute, and it writes it long after this
      // walk has finished — so it is judged by its target. Anything off the
      // allowlist (`onclick`, `formaction`) is refused here even though
      // Blink declines to apply an on* through SMIL today: the refusal must
      // not rest on a browser's restraint. `href`/`style` ARE on the
      // allowlist and still refused, because their values are policed once,
      // below, and an animation is a second chance to set them.
      const target = attr.value.trim().toLowerCase()
      if (!r.attr(target) || /(^|:)(href|style)$/.test(target)) return false
      continue
    }
    if (!svgUrlRefsAllowed(attr.value, name) || (name === 'style' && /@import|expression\s*\(/i.test(attr.value))) {
      el.removeAttribute(attr.name)
      continue
    }
    if (name !== 'href' && name !== 'xlink:href') {
      if (r.strictValues && !strictValueAllowed(attr.value)) el.removeAttribute(attr.name)
      continue
    }
    if (r.remoteHref ? svgHrefAllowed(attr.value, tag) : localHrefAllowed(attr.value, tag)) continue
    // a <use> IS its href, and one that cannot be resolved in-document
    // instances a subtree from a document that is not ours to trust; a dead
    // <a> or <image> is merely inert, so it keeps its place in the layout.
    if (tag === 'use') return false
    el.removeAttribute(attr.name)
  }

  if (tag === 'style') {
    // Assigning textContent also discards any element children, which the
    // html parser really does build here: inside foreign content the
    // tokenizer stays in the data state, so `<svg><style><img src=x
    // onerror=…></style>` parses that img as an ELEMENT, not as css text.
    // Sanitized HERE, always; the app's hook only scopes the result. (r.tag
    // refused 'style' already when scopeStyle is null.)
    el.textContent = r.scopeStyle!(sanitizeSvgCss(el.textContent ?? ''))
    return true
  }
  cleanChildren(el, r)
  return true
}

function cleanChildren(node: Node, r: Rules): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) continue
    if (child.nodeType !== Node.ELEMENT_NODE || !cleanElement(child as Element, r)) child.remove()
  }
}

/**
 * Sanitize every child of `node` (an inert parsed document's body, say) in
 * place: refused elements, comments and processing instructions are removed,
 * text is kept. The caller imports the survivors; it never re-parses a string.
 */
export function cleanSvgChildren(node: Node, policy: SvgPolicy): void {
  cleanChildren(node, rulesOf(policy))
}

/** The same for one element itself. `false` = the caller removes it. */
export function cleanSvgElement(el: Element, policy: SvgPolicy): boolean {
  return cleanElement(el, rulesOf(policy))
}
