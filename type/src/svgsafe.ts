// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// An embed's picture (an SVG from another Bento app) made safe by ALLOWLIST.
//
// Modelled on bento/slides' sanitizeSvg (slides/src/render.ts), which is
// released and has held up — parse inert, walk every element, keep a tag or an
// attribute only if its NAME is on a list — and kept STRICTER than it, because
// an embed's picture needs less: no <style> element or attribute (so no CSS to
// police beyond presentation values), no <a>, no remote reference of any kind.
// To be replaced by a shared kernel module when slides' sanitizer is lifted.
//
// WHY A WALK, NOT A PATTERN. The earlier check (embed.ts safeView) looked for
// an event handler as whitespace + "on…=". The HTML tokenizer also begins an
// attribute name after `/` and after a closed quote, so `<circle/onmouseover=…>`
// passed and ran (measured, in the editor). Reading `el.attributes` after the
// browser parsed the markup is right whatever the separators were, and an on*
// attribute is never kept because it was never on the list.
//
// Guarded by scripts/test-type-sinks-browser.mjs.

const TAGS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'switch', 'desc', 'title', 'metadata', 'view',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'image',
  'lineargradient', 'radialgradient', 'stop', 'pattern', 'solidcolor',
  'clippath', 'mask', 'marker',
  'filter', 'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite',
  'feconvolvematrix', 'fediffuselighting', 'fedisplacementmap', 'fedistantlight',
  'fedropshadow', 'feflood', 'fefunca', 'fefuncb', 'fefuncg', 'fefuncr',
  'fegaussianblur', 'feimage', 'femerge', 'femergenode', 'femorphology',
  'feoffset', 'fepointlight', 'fespecularlighting', 'fespotlight', 'fetile',
  'feturbulence',
  'animate', 'animatemotion', 'animatetransform', 'set', 'mpath',
]);

/** SMIL elements WRITE an attribute later, so they are judged by their target. */
const ANIM = new Set(['animate', 'set', 'animatetransform', 'animatemotion']);

const ATTRS = new Set([
  'id', 'class', 'lang', 'xml:lang', 'xml:space', 'xmlns', 'xmlns:xlink', 'role', 'version',
  'href', 'xlink:href',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height',
  'd', 'points', 'pathlength', 'dx', 'dy', 'rotate', 'textlength', 'lengthadjust',
  'transform', 'transform-origin', 'transform-box', 'viewbox', 'preserveaspectratio',
  'refx', 'refy', 'markerwidth', 'markerheight', 'markerunits', 'orient',
  'gradientunits', 'gradienttransform', 'spreadmethod', 'fx', 'fy', 'fr', 'offset',
  'patternunits', 'patterncontentunits', 'patterntransform', 'clippathunits',
  'maskunits', 'maskcontentunits', 'primitiveunits', 'filterunits',
  'startoffset', 'method', 'spacing', 'side',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-opacity', 'opacity', 'color', 'display', 'visibility', 'overflow',
  'shape-rendering', 'text-rendering', 'image-rendering', 'vector-effect', 'paint-order',
  'font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing', 'word-spacing',
  'text-anchor', 'text-decoration', 'dominant-baseline', 'alignment-baseline', 'baseline-shift',
  'writing-mode', 'direction', 'clip', 'clip-path', 'clip-rule', 'mask', 'marker',
  'marker-start', 'marker-mid', 'marker-end', 'filter', 'stop-color', 'stop-opacity',
  'flood-color', 'flood-opacity', 'lighting-color',
  'in', 'in2', 'result', 'mode', 'values', 'tablevalues', 'slope', 'intercept',
  'amplitude', 'exponent', 'operator', 'k1', 'k2', 'k3', 'k4', 'order', 'kernelmatrix',
  'divisor', 'bias', 'targetx', 'targety', 'edgemode', 'kernelunitlength', 'preservealpha',
  'surfacescale', 'diffuseconstant', 'specularconstant', 'specularexponent', 'scale',
  'xchannelselector', 'ychannelselector', 'stddeviation', 'radius', 'basefrequency',
  'numoctaves', 'seed', 'stitchtiles', 'azimuth', 'elevation', 'pointsatx', 'pointsaty',
  'pointsatz', 'limitingconeangle', 'z',
  'attributename', 'attributetype', 'from', 'to', 'by', 'dur', 'begin', 'end', 'min',
  'max', 'restart', 'repeatcount', 'repeatdur', 'calcmode', 'keytimes', 'keysplines',
  'keypoints', 'path', 'additive', 'accumulate', 'origin',
]);

/** Exported for the rig: a pure decision. */
export const attrAllowed = (name: string): boolean => {
  const n = name.toLowerCase();
  return n.startsWith('aria-') || ATTRS.has(n);
};

/** href: a same-document `#ref` anywhere; an inline raster only on image/feImage. */
function hrefAllowed(value: string, tag: string): boolean {
  const v = value.replace(/[\u0000- ]/g, '').toLowerCase();
  if (v.startsWith('#')) return true;
  return (tag === 'image' || tag === 'feimage') && /^data:image\/(png|jpe?g|gif|webp);base64,/.test(v);
}

/**
 * A presentation or SMIL value: no CSS escape (a backslash is how `url(` and
 * friends are spelled past a naive check, and a picture never needs one), and
 * every url() a same-document `#ref`. `values`/`from`/`to`/`by` are checked
 * too: an animation's values are written into its target later.
 */
function valueAllowed(value: string): boolean {
  if (value.includes('\\')) return false;
  if (/javascript:|vbscript:|data:(?!image\/(png|jpe?g|gif|webp);base64,)/i.test(value.replace(/[\u0000- ]/g, ''))) return false;
  for (const m of value.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    if (!m[2].trim().startsWith('#')) return false;
  }
  return !/@import|expression\s*\(|image-set\s*\(|-webkit-image-set/i.test(value);
}

/**
 * The sanitized <svg>, as an element of an INERT document — the caller imports
 * it (never re-parses a string), or null when the markup is not an svg at all.
 */
export function sanitizeEmbedSvg(markup: string): Element | null {
  if (typeof DOMParser === 'undefined' || typeof markup !== 'string') return null;
  const parsed = new DOMParser().parseFromString(markup.trim(), 'text/html');
  const root = parsed.body.firstElementChild;
  if (!root || root.localName.toLowerCase() !== 'svg') return null;
  const clean = (el: Element): boolean => {      // false = remove this element
    const tag = el.localName.toLowerCase();
    if (!TAGS.has(tag)) return false;
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!attrAllowed(name)) { el.removeAttribute(attr.name); continue; }
      if (ANIM.has(tag) && name === 'attributename') {
        const target = attr.value.trim().toLowerCase();
        if (!attrAllowed(target) || /(^|:)(href|style)$/.test(target)) return false;
        continue;
      }
      if (name === 'href' || name === 'xlink:href') {
        if (hrefAllowed(attr.value, tag)) continue;
        if (tag === 'use') return false;          // a <use> IS its href
        el.removeAttribute(attr.name);
        continue;
      }
      if (!valueAllowed(attr.value)) el.removeAttribute(attr.name);
    }
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) continue;            // text
      if (child.nodeType !== 1 || !clean(child as Element)) child.remove();
    }
    return true;
  };
  if (!clean(root)) return null;
  // nothing outside the one <svg> survives
  for (const n of Array.from(parsed.body.childNodes)) if (n !== root) n.remove();
  return root;
}

/** The same, serialized — for the string-built print and preview documents. */
export function sanitizeEmbedSvgHtml(markup: string): string | null {
  const el = sanitizeEmbedSvg(markup);
  return el ? el.outerHTML : null;
}
