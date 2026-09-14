#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Built-in fonts rig for bento/slides.
//
//   node scripts/test-slides-fonts.ts
//
// WHAT THIS PROVES. The shell carries two faces (fontdata.ts); a deck may
// NAME them (`builtin:…`) instead of embedding their bytes. Measured before
// this change on three real decks: the two woff2 files were 86 KB of every
// saved deck — 80% of a typical text deck's document block — and the same
// bytes were already in the shell. So:
//
//   - the starter deck names the faces and embeds no font bytes
//   - resolveFontSrc answers a built-in key from the shell, an asset key
//     from the deck, and nothing for a key that is neither
//   - at save, a deck that embeds bytes IDENTICAL to a built-in face is
//     rewritten to name it and the bytes leave the file; a deck carrying a
//     DIFFERENT font keeps it; the live document is never touched; the
//     result is idempotent
//   - the saving is real: a deck that embedded both faces serialises ~86 KB
//     smaller through the facade, with the same fonts resolving
//
// The one thing this cannot measure is an OLDER shell opening a new deck:
// its injectFonts looks the key up in assets, finds nothing, and skips the
// rule — the family renders in its fallback stack. A degrade, stated in
// fonts.ts, and short-lived because the shell updates itself.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { BUILTIN_FONTS, adoptBuiltinFonts, resolveFontSrc } from '../slides/src/fonts.ts'
import { FRAUNCES_900, INSTRUMENT_VAR } from '../slides/src/fontdata.ts'
import { starterDoc } from '../slides/src/starterdeck.ts'
import type { BentoDoc } from '../slides/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const deck = (o: Partial<BentoDoc>): BentoDoc =>
  ({ format: 'bento/slides', version: 1, docId: 'd', title: 't', slides: [], ...o } as unknown as BentoDoc)
const OTHER = 'data:font/woff2;base64,AAAAotherfontbytes=='

console.log('the shell\'s faces\n')
ok(BUILTIN_FONTS['builtin:fraunces-900'] === FRAUNCES_900 && BUILTIN_FONTS['builtin:instrument-sans'] === INSTRUMENT_VAR,
  'BUILTIN_FONTS names the two faces fontdata.ts carries')
ok(Object.keys(BUILTIN_FONTS).every((k) => k.startsWith('builtin:')), 'every built-in key carries the builtin: prefix (no asset table holds one)')

console.log('\nthe starter deck\n')
const starter = starterDoc()
ok((starter.fonts ?? []).length === 2 && starter.fonts!.every((f) => f.asset.startsWith('builtin:')), 'the starter deck names both faces')
ok(!Object.values(starter.assets ?? {}).some((v) => v.startsWith('data:font/')), 'and embeds no font bytes at all')
ok(starter.fonts!.every((f) => resolveFontSrc(starter, f.asset) !== undefined), 'both resolve from the shell')

console.log('\nresolveFontSrc\n')
const own = deck({ fonts: [{ family: 'Other', asset: 'font-other' }], assets: { 'font-other': OTHER } })
ok(resolveFontSrc(own, 'font-other') === OTHER, 'a deck\'s own font resolves from its assets')
ok(resolveFontSrc(own, 'builtin:fraunces-900') === FRAUNCES_900, 'a built-in key resolves from the shell even in a deck that has assets')
ok(resolveFontSrc(own, 'font-missing') === undefined && resolveFontSrc(own, 'builtin:nope') === undefined, 'an unknown key resolves to nothing')
ok(resolveFontSrc(deck({ assets: { 'builtin:fraunces-900': OTHER } }), 'builtin:fraunces-900') === OTHER, 'a deck\'s own asset under a builtin: key would still win (the table is asked first)')

console.log('\nadoptBuiltinFonts at save\n')
const legacy = deck({
  fonts: [
    { family: 'Fraunces', asset: 'font-fraunces-900', weight: '900' },
    { family: 'Instrument Sans', asset: 'font-instrument', weight: '400 700' },
    { family: 'Other', asset: 'font-other' },
  ],
  assets: { 'font-fraunces-900': FRAUNCES_900, 'font-instrument': INSTRUMENT_VAR, 'font-other': OTHER, pic: 'data:image/png;base64,AAAA' },
})
const before = JSON.stringify(legacy)
const adopted = adoptBuiltinFonts(legacy)
ok(JSON.stringify(legacy) === before, 'the live document is untouched')
ok(adopted !== legacy, 'a deck with byte-identical faces gets a copy back')
ok(adopted.fonts![0].asset === 'builtin:fraunces-900' && adopted.fonts![0].weight === '900', 'Fraunces is rewritten to the built-in key, weight kept')
ok(adopted.fonts![1].asset === 'builtin:instrument-sans', 'Instrument Sans likewise')
ok(adopted.fonts![2].asset === 'font-other' && adopted.assets!['font-other'] === OTHER, 'a different font keeps its bytes')
ok(!('font-fraunces-900' in adopted.assets!) && !('font-instrument' in adopted.assets!), 'the built-in bytes leave the file')
ok(adopted.assets!.pic === 'data:image/png;base64,AAAA', 'other assets are untouched')
ok(adopted.fonts!.every((f) => resolveFontSrc(adopted, f.asset) !== undefined), 'every font still resolves after adoption')
ok(adoptBuiltinFonts(adopted) === adopted, 'idempotent: a second pass returns the same object')
ok(adoptBuiltinFonts(own) === own, 'a deck with only its own fonts is returned as-is')
ok(adoptBuiltinFonts(deck({})) !== undefined, 'a deck with no fonts is fine')
const renamed = deck({ fonts: [{ family: 'Fraunces', asset: 'my-cut' }], assets: { 'my-cut': FRAUNCES_900 } })
ok(adoptBuiltinFonts(renamed).fonts![0].asset === 'builtin:fraunces-900', 'adoption is by BYTES, whatever the key was')
const different = deck({ fonts: [{ family: 'Fraunces', asset: 'my-cut' }], assets: { 'my-cut': OTHER } })
ok(adoptBuiltinFonts(different) === different, '…and not by family name: a deck\'s own Fraunces cut is kept')

console.log('\nthe saving, measured\n')
const embedded = deck({
  fonts: [{ family: 'Fraunces', asset: 'f', weight: '900' }, { family: 'Instrument Sans', asset: 'i' }],
  assets: { f: FRAUNCES_900, i: INSTRUMENT_VAR },
})
const sizeBefore = JSON.stringify(embedded).length
const sizeAfter = JSON.stringify(adoptBuiltinFonts(embedded)).length
ok(sizeBefore - sizeAfter > 80_000, `a deck embedding both faces shrinks by ${sizeBefore - sizeAfter} bytes (${((1 - sizeAfter / sizeBefore) * 100).toFixed(1)}%)`)

console.log('\nthe facade\n')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const save = readFileSync(join(root, 'slides/src/save.ts'), 'utf8')
ok(/function prepareForSave[\s\S]*pruneUnusedAssets\(adoptBuiltinFonts\(doc\)\)/.test(save) &&
  /kernelSerializeAuto\(prepareForSave\(doc\)\)/.test(save) &&
  /kernelSerializeFile\(prepareForSave\(doc\)\)/.test(save) &&
  /kernelSaveFile\(prepareForSave\(doc\), forcePicker\)/.test(save),
  'save.ts: save entry point and serializers share built-in-font adoption and asset pruning')
ok(/resolveFontSrc\(doc, f\.asset\)/.test(readFileSync(join(root, 'slides/src/fonts.ts'), 'utf8')), 'injectFonts resolves through resolveFontSrc')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
