#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// theme.codeFontFamily: the deck-wide font for code elements.
//
// BUNDLED, not run directly — render.ts imports extensionless — and run from
// the repo root (it reads render.ts from there):
//
//   slides/node_modules/.bin/esbuild scripts/test-slides-code-font.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-slides-code-font.mjs" \
//     && node "$TMPDIR/test-slides-code-font.mjs"
//
// WHAT THIS PROVES.
//   1. A code element is drawn in its own fontFamily, else the deck's
//      theme.codeFontFamily, else the deck's body font — so a deck without
//      the field (every file made before it) draws exactly as before.
//   2. theme.codeFontFamily is held to the SAME rule an element's fontFamily
//      meets on open, paste and live edit (untrusted.ts), applied where it is
//      drawn: a value the rule refuses is skipped, never drawn. The code
//      renderer goes through that one helper; nothing else in render.ts reads
//      the field.
//   3. New decks carry the monospace stack, and the restore / Replace from
//      JSON gate keeps an ordinary value (a plain string in a settings object).

import { codeFontStack } from '../slides/src/render.ts'
import { checkElementProp } from '../slides/src/untrusted.ts'
import { MONOSPACE_FONT_STACK, newDoc, type BentoDoc } from '../slides/src/model.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gateRestored } from '../slides/src/restoregate.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const BODY = 'system-ui, sans-serif'
const CODE = "'JetBrains Mono', ui-monospace, monospace"
const deck = (codeFontFamily?: unknown): Pick<BentoDoc, 'theme'> =>
  ({ theme: { background: '#FFF', color: '#111', accent: '#F7A600', fontFamily: BODY, ...(codeFontFamily === undefined ? {} : { codeFontFamily }) } } as unknown as Pick<BentoDoc, 'theme'>)

console.log('which font a code element is drawn in\n')
ok(codeFontStack("'Fira Code', monospace", deck(CODE)) === "'Fira Code', monospace", 'its own fontFamily wins')
ok(codeFontStack(undefined, deck(CODE)) === CODE, 'without one, the theme code font')
ok(codeFontStack('', deck(CODE)) === CODE, 'an empty own fontFamily counts as none')
ok(codeFontStack(undefined, deck()) === BODY, 'a deck without theme.codeFontFamily draws in the body font, as before')
ok(codeFontStack(undefined, deck('')) === BODY, 'an empty theme.codeFontFamily falls back to the body font')

console.log('\nthe theme code font meets the element font rule\n')
for (const [v, why] of [
  [42, 'not a string'],
  ['Mono; x', 'a declaration end'],
  ['Mono { x', 'a brace'],
  ['Mono < x', 'an angle bracket'],
  ['M'.repeat(301), 'longer than a font stack may be'],
] as const) {
  ok(!checkElementProp('code', 'fontFamily', v).ok, `the element rule refuses it (${why})`)
  ok(codeFontStack(undefined, deck(v)) === BODY, `so it is not drawn; the body font is (${why})`)
}
for (const v of [CODE, MONOSPACE_FONT_STACK, '"Segoe UI Mono", monospace']) {
  ok(checkElementProp('code', 'fontFamily', v).ok && codeFontStack(undefined, deck(v)) === v, `an ordinary stack is drawn (${v.split(',')[0]})`)
}

{
  const src = readFileSync(join(process.cwd(), 'slides/src/render.ts'), 'utf8')
  ok(/inner\.style\.fontFamily = codeFontStack\(el\.fontFamily, doc\)/.test(src), 'the code renderer draws through codeFontStack')
  const reads = src.split('\n').filter((l) => l.includes('codeFontFamily') && !/^\s*(\*|\/\/)/.test(l))
  ok(reads.length === 1 && reads[0].includes('const code = doc.theme?.codeFontFamily'), `render.ts reads theme.codeFontFamily only inside codeFontStack (${reads.length} read(s))`)
}

console.log('\nnew decks\n')
ok(newDoc().theme.codeFontFamily === MONOSPACE_FONT_STACK, 'a new deck carries the monospace stack')
{
  const d = newDoc()
  d.theme.codeFontFamily = CODE
  const g = gateRestored(JSON.stringify(d), d)
  ok(!!g && g.doc.theme.codeFontFamily === CODE, 'the restore / Replace from JSON gate keeps an ordinary theme.codeFontFamily')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
