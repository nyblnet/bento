#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Clipboard transport is plain JSON, so this regression rig needs no DOM — but
// it is BUNDLED, not run directly, because render.ts imports './model'
// extensionless (same as scripts/test-sanitize.ts):
//
//   slides/node_modules/.bin/esbuild scripts/test-clipboard.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-clipboard.mjs" \
//     && node "$TMPDIR/test-clipboard.mjs"
//
// render.ts is imported on purpose. The point of the validator is that what it
// emits is renderable, and the three renderer entry points that used to throw
// on its output — renderTableHtml, resolveFields, resolveAsset — are all pure
// string functions, so the rig can call them for real instead of asserting
// about them.

import { insertElements, insertSlides, parseClip, serializeElements, serializeSlides } from '../slides/src/editor/clipboard.ts'
import {
  defaultChart, defaultImage, defaultMedia, defaultShape, defaultTable, defaultText,
  newDoc, type BentoDoc, type SlideElement, type TableElement,
} from '../slides/src/model.ts'
import { MODEL_KEYS } from '../slides/src/modelkeys.generated.ts'
import { cssColor, renderTableHtml, resolveAsset, resolveFields } from '../slides/src/render.ts'
import { CHECKED_KEYS, LIMITS, REQUIRED_KEYS, sanitizeElement, sanitizeSlide } from '../slides/src/untrusted.ts'

let checks = 0
let failures = 0

function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ✓ ${message}`)
  else {
    failures++
    console.error(`  ✗ ${message}`)
  }
}

function sourceDoc(): BentoDoc {
  const doc = newDoc()
  doc.assets = { 'font-acme': 'data:font/woff2;base64,U09VUkNF', unused: 'data:font/woff2;base64,VU5VU0VE' }
  doc.fonts = [
    { family: 'Acme', asset: 'font-acme' },
    { family: 'Unused', asset: 'unused' },
  ]
  doc.slides[0].elements = [defaultText({ id: 'text-acme', html: 'A', fontFamily: "'Acme', sans-serif" })]
  return doc
}

function targetDoc(): BentoDoc {
  const doc = newDoc()
  doc.assets = { 'font-acme': 'data:font/woff2;base64,VEFSR0VU' }
  return doc
}

function remappedFont(doc: BentoDoc) {
  return doc.fonts?.find((font) => font.family === 'Acme')
}

console.log('\nelement clipboard')
{
  const source = sourceDoc()
  const payload = parseClip(serializeElements(source.slides[0].elements, source))!
  ok(payload.fonts?.length === 1 && payload.fonts[0].family === 'Acme', 'copies only the embedded face used by pasted elements')
  ok(payload.assets?.['font-acme'] === source.assets!['font-acme'], 'copies bytes for an embedded element font')

  const target = targetDoc()
  insertElements(payload, target, target.slides[0])
  const font = remappedFont(target)
  ok(font?.asset !== 'font-acme', 'remaps a colliding font asset for pasted elements')
  ok(target.assets!['font-acme'] === 'data:font/woff2;base64,VEFSR0VU', 'keeps target asset bytes on collision')
  ok(font != null && target.assets![font.asset] === source.assets!['font-acme'], 'pasted element font points at its source bytes')
}

console.log('\nslide clipboard')
{
  const source = sourceDoc()
  const payload = parseClip(serializeSlides(source.slides, source))!
  ok(payload.fonts?.length === 1 && payload.fonts[0].family === 'Acme', 'copies only the embedded face used by pasted slides')
  ok(payload.assets?.['font-acme'] === source.assets!['font-acme'], 'copies bytes for an embedded slide font')

  const target = targetDoc()
  insertSlides(payload, target, 1)
  const font = remappedFont(target)
  ok(font?.asset !== 'font-acme', 'remaps a colliding font asset for pasted slides')
  ok(target.assets!['font-acme'] === 'data:font/woff2;base64,VEFSR0VU', 'keeps target slide asset bytes on collision')
  ok(font != null && target.assets![font.asset] === source.assets!['font-acme'], 'pasted slide font points at its source bytes')
}

// --- the clipboard is a public channel ---------------------------------------
// Any page with a Copy button can leave a `__bento:"clip"` payload on it, so
// parseClip rebuilds one through untrusted.ts instead of trusting its shape.
// Everything below FAILS against the pre-check parseClip, which handed the
// parsed JSON straight to insertElements/insertSlides.

/** Key-order-independent deep compare — the rebuild re-emits type and id first. */
function canon(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort)
    if (x && typeof x === 'object') {
      return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as any)[k])]))
    }
    return x
  }
  return JSON.stringify(sort(v))
}

/** One of every element type, with the optional properties a real deck uses. */
function richElements(): SlideElement[] {
  return [
    defaultText({
      id: 'text-1', html: '<b>Bold</b> &amp; fine', fontFamily: "'Acme', sans-serif",
      letterSpacing: 1.5, role: 'title', placeholder: 'Click to add title',
      // color(srgb …) is what a deck converted from a design tool actually
      // carries — the longest colour notation in OneMarket, at 45 characters
      color: 'color(srgb 0.156863 0.188235 0.227451 / 0.55)',
      colorGradient: { angle: 90, stops: [{ at: 0, color: '#FFFFFF' }, { at: 1, color: 'rgba(0,0,0,0.5)' }] },
      textStroke: { width: 2, color: '#000000', fill: 'none' },
      shadow: [{ x: 0, y: 2, blur: 8, color: 'rgba(0,0,0,0.3)' }],
      fx: { enter: 'fade-up', enterDur: 0.6, order: 1, countUp: true, ken: { dir: 'out', scale: 1.06, duration: 8 } },
    }),
    defaultShape('path', {
      id: 'shape-1', d: 'M0,0 C10,10 20,-5 30,0 Z', pathBox: [0, 0, 30, 10],
      // an svg paint may reference a gradient/filter in the document's own
      // markup, quotes and all: OneMarket_Commercial_Architecture slide 21,
      // element `topo-0`. Dropping it left render.ts writing fill="undefined",
      // which paints the shape BLACK.
      fill: 'url("#core-glow")',
      strokeStyle: 'dashed', lineStart: 'arrow', lineEnd: 'dot', strokeDash: 6,
      fillGradient: { angle: 45, stops: [{ at: 0, color: '#F7A600' }] },
      from: { el: 'text-1', side: 'auto' }, to: { el: 'img-1', side: 'left' },
      fx: { loop: { type: 'motion-path', path: 'M0,0 L10,10', duration: 4, ease: 'sine-in-out', speeds: [1, 2] } },
    }),
    defaultImage('asset:pic', { id: 'img-1', fit: 'cover', radius: 8, blend: 'multiply', blur: 2, backdropFilter: 6 }),
    defaultChart({ series: [{ type: 'bar', data: [1, 2, 3] }], xAxis: { data: ['a', 'b', 'c'] } },
      { id: 'chart-1', source: { tableId: 'table-1' } }),
    defaultTable({ id: 'table-1' }),
    { id: 'svg-1', type: 'svg', x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1,
      markup: '<svg><circle r="4"/></svg>', css: '.a{fill:red}', group: 'era-1', showOnHover: 'era-1' },
    defaultMedia('video', 'https://example.com/clip.mp4', { id: 'media-1', autoplay: true, poster: 'asset:pic' }),
  ]
}

console.log('\nlegitimate payloads survive the check')
{
  const doc = newDoc()
  doc.slides[0].elements = richElements()
  const payload = parseClip(serializeElements(doc.slides[0].elements, doc))!
  ok(canon(payload.elements) === canon(richElements()), 'every element type round-trips property-for-property')

  doc.slides[0].notes = 'speaker notes'
  doc.slides[0].hover = { type: 'focus-group', dim: 0.3 }
  doc.slides[0].comments = [{ id: 'c1', author: 'Ada', text: 'tighten this', at: '2026-01-01T00:00:00Z', x: 10, y: 20, replies: [{ id: 'r1', author: 'Bob', text: 'ok', at: '2026-01-02T00:00:00Z' }] }]
  const slideClip = parseClip(serializeSlides(doc.slides, doc))!
  ok(canon(slideClip.slides) === canon(doc.slides), 'a whole slide round-trips, comments and hover included')
}

console.log('\nhostile clipboard payloads')
{
  const clip = (elements: unknown[]) => parseClip(JSON.stringify({ __bento: 'clip', kind: 'elements', elements }))
  const one = (el: Record<string, unknown>) => clip([el])!.elements![0] as any

  ok(parseClip(JSON.stringify({ __bento: 'clip', kind: 'evil', elements: [] })) === null,
    'rejects a payload whose kind is neither literal')
  ok(parseClip(JSON.stringify({ __bento: 'clip', kind: 'elements', elements: { length: 1 } })) === null,
    'rejects an elements payload that is not an array')
  ok(clip([{ type: 'script', id: 'x', src: 'evil.js' }]) === null, 'drops an element whose type is not in the format')
  ok(clip([{ type: 'text' }]) === null, 'drops an element with no usable id')

  // renderTableHtml interpolates cell colours into style="" with no escaping,
  // so a quote in one closes the attribute and the rest is an event handler.
  const table = one({
    type: 'table', id: 'tbl-1', x: 0, y: 0, w: 100, h: 100, columns: [{ w: 1 }],
    rows: [{ cells: [{ html: 'hi', color: 'red" onmouseover="alert(1)', align: 'left" onclick="x()' }] }],
    style: { borderColor: '#000;}</style><script>x()</script>', fontSize: 18 },
  })
  ok(table.rows[0].cells[0].html === 'hi', 'keeps the cell content beside a rejected colour')
  ok(table.rows[0].cells[0].color === undefined, 'drops a cell colour that would close the style attribute')
  ok(table.rows[0].cells[0].align === undefined, 'drops a cell alignment that is not one of the three literals')
  ok(table.style.borderColor === undefined && table.style.fontSize === 18, 'drops a table border colour carrying markup, keeps the rest of the style')

  const img = one({
    type: 'image', id: 'img-2', x: '40', y: 12, w: 100, h: 100, opacity: 3,
    src: 'asset:pic', fit: 'cover;position:fixed;inset:0', onload: 'alert(1)',
  })
  ok(img.fit === undefined, 'drops a fit that would inject extra declarations into the <img> cssText')
  ok(img.x === 40 && img.y === 12, 'coerces a numeric string, keeps a real number')
  ok(!('onload' in img), 'drops a key the format does not define')
  ok(img.opacity === undefined, 'drops an out-of-range opacity')
  ok(clip([{ type: 'image', id: 'img-3', x: 0, y: 0, w: 1, h: 1, src: 'javascript:alert(1)' }]) === null,
    'a javascript: src takes the whole image with it — an <img> has nothing left to be')

  const svg = one({ type: 'svg', id: 'svg-2', x: 0, y: 0, w: 10, h: 10, markup: { toString: 1 }, css: 'x'.repeat(LIMITS.css + 1) })
  ok(svg.markup === undefined && svg.css === undefined, 'drops non-string markup and oversized css')
  ok(clip([{ type: 'text', id: 't-2', html: 'x'.repeat(LIMITS.html + 1) }]) === null, 'drops rich text past the size ceiling')

  let deep: unknown = { v: 1 }
  for (let i = 0; i < 40; i++) deep = { a: deep }
  ok(clip([{ type: 'chart', id: 'ch-2', option: deep }]) === null, 'drops a chart option nested past the depth ceiling')
  ok(one({ type: 'chart', id: 'ch-3', option: { series: [{ type: 'bar', data: [1, 2] }] } }).option !== undefined, 'keeps an ordinary chart option')

  const poisoned = parseClip('{"__bento":"clip","kind":"elements","elements":[{"type":"text","id":"p1","html":"x","__proto__":{"pwned":true}}]}')
  ok(poisoned !== null && ({} as any).pwned === undefined, 'a __proto__ key in a pasted element never reaches Object.prototype')

  const fontClip = parseClip(JSON.stringify({
    __bento: 'clip', kind: 'elements', elements: [{ type: 'text', id: 'f1', html: 'a', x: 0, y: 0, w: 1, h: 1 }],
    // fonts.ts interpolates weight/style RAW into an @font-face rule
    fonts: [{ family: 'Acme', asset: 'a1', weight: 'normal;}body{display:none' }, { family: 'NoBytes' }],
    assets: { a1: 'data:font/woff2;base64,QUJD', 'bad"key': 'data:,x' },
  }))!
  ok(fontClip.fonts!.length === 1 && (fontClip.fonts![0] as any).weight === undefined, 'drops a font weight that would inject CSS rules, and a font with no asset')
  ok(fontClip.assets!.a1 != null && fontClip.assets!['bad"key'] === undefined, 'drops an asset key that could break out of an attribute')

  const target = newDoc()
  insertElements(fontClip, target, target.slides[0])
  ok(target.fonts!.length === 1 && target.assets!.a1 != null, 'the checked payload still merges its font and bytes')
}

// --- what the validator emits must be RENDERABLE ----------------------------
// A rebuilt element used to be allowed out with its mandatory keys missing,
// which is worse than a hostile value: renderTableHtml/resolveFields/
// resolveAsset throw on it, and a throw inside renderSlide takes down the whole
// slide, not just the paste. Each case below is measured twice — the renderer
// really does throw on the pre-fix shape, and the validator really does refuse
// to produce it.

console.log('\nthe validator never emits an element the renderer throws on')
{
  const doc = newDoc()
  const clip = (elements: unknown[]) => parseClip(JSON.stringify({ __bento: 'clip', kind: 'elements', elements }))
  const throws = (fn: () => unknown) => { try { fn(); return false } catch { return true } }
  const fields = { page: 1, pages: 1, title: '', date: new Date(), author: '', company: '', subject: '', event: '' }

  const box = { x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1 }
  const crashers: Array<[string, Record<string, unknown>, () => unknown]> = [
    ['a table row whose cells are not an array',
      { type: 'table', id: 'c-1', ...box, columns: [{ w: 1 }], rows: [{ cells: 'x' }] },
      () => renderTableHtml({ ...box, type: 'table', id: 'c-1', columns: [{ w: 1 }], rows: [{}] } as unknown as TableElement, doc)],
    ['a table whose columns are not an array',
      { type: 'table', id: 'c-2', ...box, columns: 'x', rows: [{ cells: [{ html: 'a' }] }] },
      () => renderTableHtml({ ...box, type: 'table', id: 'c-2', rows: [{ cells: [{ html: 'a' }] }] } as unknown as TableElement, doc)],
    ['a table with no columns at all',
      { type: 'table', id: 'c-3', ...box },
      () => renderTableHtml({ ...box, type: 'table', id: 'c-3' } as unknown as TableElement, doc)],
    ['a text element with no html',
      { type: 'text', id: 'c-4', ...box },
      () => resolveFields(undefined as unknown as string, fields)],
    ['an image with no src',
      { type: 'image', id: 'c-5', ...box },
      () => resolveAsset(doc, undefined as unknown as string)],
  ]
  for (const [label, payload, preFix] of crashers) {
    ok(throws(preFix), `render.ts still throws on ${label} (the shape this drops)`)
    ok(clip([payload]) === null, `drops ${label}`)
  }

  // gradients: cssLinearGradient/gradientRef both walk `stops` with no guard
  ok(sanitizeElement({ type: 'text', id: 'g-1', ...box, html: 'h', colorGradient: { angle: 90 } })?.type === 'text',
    'a gradient with no stops loses the GRADIENT, not the text element')
  ok((sanitizeElement({ type: 'text', id: 'g-1', ...box, html: 'h', colorGradient: { angle: 90 } }) as any).colorGradient === undefined,
    'and the stop-less gradient itself is gone')
  ok((sanitizeElement({ type: 'text', id: 'g-2', ...box, html: 'h', shadow: { x: 1, y: 1 } }) as any).shadow === undefined,
    'a shadow with no blur or colour is dropped whole, not left to write drop-shadow(undefined)')

  // every name in the required table must be a real key of that element type
  const bogus = Object.entries(REQUIRED_KEYS).flatMap(([type, keys]) =>
    keys.filter((k) => !(MODEL_KEYS.element as Record<string, readonly string[]>)[type]?.includes(k)).map((k) => `${type}.${k}`))
  ok(bogus.length === 0, `every required key names a real format property (bogus: ${bogus.join(', ') || 'none'})`)

  // and each one, removed on its own, must cost the element
  const minimal: Record<string, Record<string, unknown>> = {
    text: { html: 'hi' },
    shape: { shape: 'rect', fill: '#fff' },
    image: { src: 'asset:pic' },
    chart: { option: { series: [] } },
    table: { columns: [{ w: 1 }], rows: [{ cells: [{ html: 'a' }] }] },
    media: { kind: 'video', src: 'https://example.com/a.mp4' },
  }
  for (const [type, keys] of Object.entries(REQUIRED_KEYS)) {
    ok(sanitizeElement({ type, id: `m-${type}`, ...box, ...minimal[type] }) !== null,
      `a minimal ${type} with only its mandatory keys survives`)
    for (const key of keys) {
      const without = { type, id: `m-${type}`, ...box, ...minimal[type] }
      delete without[key]
      ok(sanitizeElement(without) === null, `a ${type} missing ${key} is dropped`)
    }
  }
}

console.log('\ncolours are judged by the same rule in both layers')
{
  const box = { x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1 }
  const el = (p: Record<string, unknown>) => sanitizeElement({ type: 'shape', id: 's', ...box, shape: 'rect', fill: '#fff', ...p }) as any

  // CSS_BREAKOUT alone allows '(' ')' and ':', so a colour could append CSS
  // functions to whatever declaration it lands in. render.ts:applyElementFrame
  // interpolates shadow colours straight into style.filter.
  ok(el({ shadow: { blur: 4, color: 'red) url(https://evil.example/f.svg#f' } }).shadow === undefined,
    'drops a shadow colour that would smuggle a url() into style.filter')
  ok(el({ fill: 'url(https://evil.example/track.svg#g)' }) === null,
    'a remote url() paint is not a colour — and fill is mandatory, so the shape goes with it')
  ok(el({ fill: 'url("#core-glow")' }).fill === 'url("#core-glow")',
    'keeps a quoted reference to a gradient defined in this document')
  ok(el({ fill: "url('#core-glow')" }).fill === "url('#core-glow')" && el({ fill: 'url(#core-glow)' }).fill === 'url(#core-glow)',
    'keeps the single-quoted and bare forms too')
  ok(el({ stroke: 'color(srgb 0.98 0.68 0.25 / 0.55)' }).stroke === 'color(srgb 0.98 0.68 0.25 / 0.55)',
    'keeps a modern color() notation')
  ok(el({ fill: 'expression(alert(1))' }) === null && el({ stroke: 'x'.repeat(LIMITS.color + 1) }).stroke === undefined,
    'drops an expression() colour and one past the length ceiling')

  // the two layers must AGREE: anything untrusted.ts keeps as a colour,
  // render.ts must also accept, or the document holds a value that renders as
  // a fallback and the stricter layer is the one nobody can see.
  const FB = ' fallback'
  const disagreements = [
    '#fff', 'rgba(0,0,0,0.5)', 'color(srgb 0.98 0.68 0.25 / 0.55)', 'transparent', 'none', 'burlywood',
  ].filter((v) => {
    const kept = (sanitizeElement({ type: 'table', id: 'tc', ...box, columns: [{ w: 1 }], rows: [{ cells: [{ html: 'a', bg: v }] }] }) as any)
      .rows[0].cells[0].bg
    return kept !== undefined && cssColor(kept, FB) === FB
  })
  ok(disagreements.length === 0, `no colour survives here that render.ts would reject (${disagreements.join(', ') || 'none'})`)

  ok(sanitizeSlide({ id: 'sl', background: 'linear-gradient(180deg, rgba(15,20,27,1) 0%, rgba(30,42,58,1) 100%)', elements: [] })?.background != null,
    'a slide background may still be a multi-stop gradient')
  ok(sanitizeSlide({ id: 'sl', background: 'url(https://evil.example/beacon.png)', elements: [] })?.background === undefined,
    'but not a remote url() that fetches on paste')
}

console.log('\nkey coverage')
{
  // A field added to model.ts without a check here would be dropped from every
  // paste — silently, which is the failure mode this whole file exists to stop.
  const missing = [
    ...new Set(Object.values(MODEL_KEYS.element).flat().filter((k) => !CHECKED_KEYS.element.includes(k))),
  ]
  ok(missing.length === 0, `every element property in the format has a check (missing: ${missing.join(', ') || 'none'})`)
  const slideMissing = MODEL_KEYS.slide.filter((k) => !CHECKED_KEYS.slide.includes(k))
  ok(slideMissing.length === 0, `every slide property in the format has a check (missing: ${slideMissing.join(', ') || 'none'})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
