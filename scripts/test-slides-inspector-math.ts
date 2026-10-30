// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Arithmetic typed into an inspector field means what it says, and nothing else gets in.
//
//   node scripts/test-slides-inspector-math.ts
//
// WHAT THIS PROVES: slides/src/editor/inspector/numexpr.ts evaluates the
// arithmetic a numeric field accepts — precedence, parentheses, the relative
// forms that start from the current value (+24, *2, /2), a typed unit — and
// REFUSES everything else (names, calls, a trailing operator, division by
// zero), so a field never runs or keeps junk. It is a hand-written parser,
// never eval; the last check holds the source to that.
import { readFileSync } from 'node:fs'
import { evalNumber } from '../slides/src/editor/inspector/numexpr.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const is = (text: string, prev: number, v: number | null, rel?: number) => {
  const r = evalNumber(text, prev)
  const good = v === null ? r === null : !!r && Math.abs(r.v - v) < 1e-9 && (rel === undefined ? r.rel === undefined : Math.abs((r.rel ?? NaN) - rel) < 1e-9)
  ok(good, `"${text}" from ${prev} → ${v === null ? 'refused' : v}${rel !== undefined ? ` (relative ${rel})` : ''} (${JSON.stringify(r)})`)
}

console.log('\nabsolute\n')
is('360/2', 0, 180)
is('1920 - 96*2', 0, 1728)
is('(1920-96)/3', 0, 608)
is('-10', 50, -10) // a leading minus is a negative number, not "subtract 10"
is('2.5', 0, 2.5)
is('.5', 0, 0.5)
is('1,5', 0, 1.5) // a decimal comma, as half the world types it
is('-(4+6)', 0, -10)
is('2*-3', 0, -6)
is('24px', 0, 24)
is('45°', 0, 45)
is('80%', 0, 80)
is('1e3', 0, 1000)

console.log('\nrelative to the current value\n')
is('+24', 100, 124, 24)
is('*2', 100, 200, 100)
is('/4', 100, 25, -75)
is('+10/2', 100, 105, 5)

console.log('\nrefused\n')
for (const junk of ['', '   ', 'abc', 'alert(1)', 'Math.PI', '2+', '(2', '2)', '1/0', '/0', '2**3', '3 4', 'constructor', '0x10', '1;2']) is(junk, 7, null)

console.log('\nnever eval\n')
const src = readFileSync(new URL('../slides/src/editor/inspector/numexpr.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
ok(!/\beval\s*\(|new Function|Function\(/.test(src), 'numexpr.ts calls neither eval nor Function')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
