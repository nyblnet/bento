#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Asset-pruning rig for bento/slides (#442).
//
//   node scripts/test-slides-assets.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. A save writes `pruneUnusedAssets(doc)`, not `doc`. That
// function must drop what nothing refers to and keep EVERYTHING that is
// referred to, in every form the format has — and the two halves are not
// equally easy to get wrong. Dropping too little is the old bug (a deck only
// ever grew; the report was an empty deck of 20 MB). Dropping too much is a
// worse one: an image that vanishes from a file on save, with nothing on
// screen to say so. So the cases below are weighted toward "kept", one per
// reference form, and each is asserted individually rather than as a count —
// a count of six would pass if the wrong six survived.
//
// The prune is pure and runs in node, which is why this rig can exist. The
// facade wiring (slides/src/save.ts) is one line per serializer and is checked
// by reading the file, since exercising it needs a DOM.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pruneUnusedAssets, referencedAssetKeys } from '../slides/src/assets.ts'
import type { BentoDoc } from '../slides/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const el = (o: Record<string, unknown>) => ({ id: 'e', x: 0, y: 0, w: 10, h: 10, ...o })
const doc = (o: Partial<BentoDoc>): BentoDoc =>
  ({ format: 'bento/slides', version: 1, title: 't', slides: [], ...o } as unknown as BentoDoc)

console.log('every reference form keeps its asset')
{
  const d = doc({
    assets: {
      'img': PNG, 'poster': PNG, 'vid': PNG, 'svg': '<svg/>',
      'gram': '{}', 'thm': '{}', 'font': PNG, 'layout-img': PNG,
    },
    slides: [{ id: 's1', elements: [
      el({ id: 'i', type: 'image', src: 'asset:img' }),
      el({ id: 'm', type: 'media', kind: 'video', src: 'asset:vid', poster: 'asset:poster' }),
      el({ id: 'v', type: 'svg', asset: 'svg' }),
      el({ id: 'c', type: 'code', grammarAssetId: 'gram', themeAssetId: 'thm' }),
    ] } as never],
    layouts: [{ id: 'L', elements: [el({ id: 'li', type: 'image', src: 'asset:layout-img' })] } as never],
    fonts: [{ family: 'F', asset: 'font' }],
  })
  const out = pruneUnusedAssets(d)
  ok(out === d, 'nothing to drop → the SAME object comes back (no copy, no allocation)')
  const used = referencedAssetKeys(d)
  for (const k of ['img', 'poster', 'vid', 'svg', 'gram', 'thm', 'font', 'layout-img']) {
    ok(used.has(k), `referenced: ${k}`)
  }
  ok(used.size === 8, `exactly the eight referenced keys, no strays (got ${used.size})`)
}

console.log('\nthe report: delete everything, save, and the deck is empty for real')
{
  const d = doc({
    assets: { a: PNG, b: PNG, c: PNG },
    slides: [{ id: 's1', elements: [el({ id: 'i', type: 'image', src: 'asset:a' })] } as never],
  })
  // the user deletes every slide ("Start from scratch…")
  const emptied = { ...d, slides: [] }
  const out = pruneUnusedAssets(emptied)
  ok(out !== emptied, 'something dropped → a copy comes back, not the live object')
  ok(out.assets === undefined, 'no assets remain, and the empty map is removed rather than left as {}')
  ok(emptied.assets !== undefined && Object.keys(emptied.assets).length === 3, 'the LIVE document still has all three (undo needs them)')
}

console.log('\npartial: only the unreferenced ones go')
{
  const d = doc({
    assets: { keep: PNG, drop1: PNG, drop2: '<svg/>' },
    slides: [{ id: 's1', elements: [el({ id: 'i', type: 'image', src: 'asset:keep' })] } as never],
  })
  const out = pruneUnusedAssets(d)
  ok(!!out.assets && 'keep' in out.assets, 'keep survives')
  ok(!!out.assets && !('drop1' in out.assets) && !('drop2' in out.assets), 'drop1 and drop2 are gone')
  ok(out.assets?.keep === PNG, 'the surviving value is byte-identical')
  ok(out.slides === d.slides, 'slides array is shared, not deep-copied (the prune only touches assets)')
}

console.log('\nblobs follow assets')
{
  const d = doc({
    assets: { keep: PNG, drop: PNG },
    blobs: { keep: { key: 'k', mime: 'image/png', size: 9 }, drop: { key: 'd', mime: 'image/png', size: 9 } },
    slides: [{ id: 's1', elements: [el({ id: 'i', type: 'image', src: 'asset:keep' })] } as never],
  })
  const out = pruneUnusedAssets(d)
  ok(!!out.blobs && 'keep' in out.blobs && !('drop' in out.blobs), 'a blob ref for a dropped asset is dropped too')
  const d2 = doc({ assets: { drop: PNG }, blobs: { drop: { key: 'd', mime: 'image/png', size: 9 } }, slides: [] })
  ok(pruneUnusedAssets(d2).blobs === undefined, 'an emptied blobs map is removed, like assets')
}

console.log('\ninline data: URIs are not assets and are left alone')
{
  const d = doc({
    assets: { orphan: PNG },
    slides: [{ id: 's1', elements: [el({ id: 'i', type: 'image', src: PNG })] } as never],
  })
  const out = pruneUnusedAssets(d)
  ok(out.assets === undefined, 'orphan dropped; the inline image was never an asset ref')
  ok((out.slides[0] as { elements: Array<{ src: string }> }).elements[0].src === PNG, 'the inline src is untouched')
}

console.log('\na document with no assets map is handed back untouched')
{
  const d = doc({ slides: [] })
  ok(pruneUnusedAssets(d) === d, 'no assets → same object')
}

console.log('\nthe facade actually routes through the prune')
{
  const here = dirname(fileURLToPath(import.meta.url))
  const facade = readFileSync(join(here, '../slides/src/save.ts'), 'utf8')
  ok(/export function serializeAuto\([^)]*\)[^{]*\{[^}]*pruneUnusedAssets/.test(facade),
    'serializeAuto is shadowed and calls pruneUnusedAssets')
  ok(/export function serializeFile\([^)]*\)[^{]*\{[^}]*pruneUnusedAssets/.test(facade),
    'serializeFile is shadowed and calls pruneUnusedAssets')
  ok(/export \* from '\.\.\/\.\.\/kernel\/src\/save\.ts'/.test(facade),
    'everything else still comes from the kernel')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
