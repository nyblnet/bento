// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Pictures PowerPoint cannot take (WebP and kin) and the host's rasteriser.
// The real rasteriser is a browser canvas (convert/page/rasterise.ts, driven
// in the page's browser test); here a stand-in records what it was asked.
//
//   node scripts/test-convert/pptx-raster.ts

import { exportDeck, deck, frame, type Exported } from './_export-harness.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='
const WEBP2 = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAB=='
const SVG = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='
const img = (id: string, src: string) => ({ id, type: 'image', ...frame(80, 80, 200, 150), src, fit: 'fill' })

function twoSlides() {
  const d = deck([img('a', WEBP), img('b', PNG), img('c', 'asset:w')], { assets: { w: WEBP2 } })
  d.slides.push({ id: 's2', background: '#ffffff', elements: [img('d', WEBP) as never,
    { id: 'm', type: 'media', kind: 'video', src: 'data:video/mp4;base64,AAAA', poster: WEBP2, ...frame(300, 80, 200, 150) } as never,
    img('e', SVG) as never] })
  return d
}
const pics = (r: Exported, n: number) => (new TextDecoder().decode(r.parts.get(`ppt/slides/slide${n}.xml`)!).match(/<p:pic>/g) ?? []).length
const where = (r: Exported, code: string) => r.report.entries.filter((e) => e.code === code).map((e) => e.where).sort()

console.log('with a rasteriser')
{
  const asked: string[] = []
  const r = await exportDeck(twoSlides(), { rasterise: async (u) => { asked.push(u); return PNG } })
  ok(asked.length === 2 && asked.includes(WEBP) && asked.includes(WEBP2), `each distinct WebP is converted once (${asked.length} calls for 4 uses)`)
  ok(!asked.some((u) => u.startsWith('data:image/png') || u.startsWith('data:image/svg')), 'PNG and SVG are never sent to the rasteriser')
  ok(r.problems.length === 0 && pics(r, 1) === 3 && pics(r, 2) === 3, `every picture lands, package clean (slide 1: ${pics(r, 1)}, slide 2: ${pics(r, 2)})`)
  ok(!r.codes.has('missing-image'), 'nothing is dropped')
  ok(JSON.stringify(where(r, 'image-converted-png')) === '["slide 1","slide 2"]', `the conversion is reported on the slides it happened on (${where(r, 'image-converted-png')})`)
  ok(![...r.parts.keys()].some((k) => /\.webp$/i.test(k)), 'no WebP part enters the package')
}
for (const [label, fn] of [
  ['returns null', async () => null],
  ['throws', async () => { throw new Error('decode failed') }],
  ['returns something that is not a PNG', async () => 'data:image/jpeg;base64,AAAA'],
] as Array<[string, (u: string) => Promise<string | null>]>) {
  const r = await exportDeck(deck([img('a', WEBP)]), { rasterise: fn })
  const e = r.report.entries.find((x) => x.code === 'missing-image')
  ok(r.problems.length === 0 && pics(r, 1) === 0 && !!e && /could not be converted/.test(e.detail), `a rasteriser that ${label}: the picture is reported dropped, never written`)
}

console.log('without one (the CLI)')
{
  const r = await exportDeck(deck([img('a', WEBP)]))
  const e = r.report.entries.find((x) => x.code === 'missing-image')
  ok(r.problems.length === 0 && pics(r, 1) === 0 && !!e && /need converting to PNG/.test(e.detail) && /bento\.page\/convert/.test(e.detail),
    `WebP is reported dropped, with where it can be converted ("${e?.detail}")`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
