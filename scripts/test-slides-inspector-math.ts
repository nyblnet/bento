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
// zero, a comma that could be a thousands separator), so a field never runs
// or keeps junk; and a relative entry reports its operation, so a
// multi-selection applies `*2` to each value rather than one shared delta. It is a hand-written parser,
// never eval; the last check holds the source to that.
import { readFileSync } from 'node:fs'
import { applyRel, evalNumber } from '../slides/src/editor/inspector/numexpr.ts'

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

console.log('\na relative entry carries its operation (Mixed applies it per element)\n')
const op = (text: string) => evalNumber(text, 0)?.op
ok(JSON.stringify(op('*2')) === '{"op":"*","x":2}' && JSON.stringify(op('+12')) === '{"op":"+","x":12}' && JSON.stringify(op('/4')) === '{"op":"/","x":4}', '*2, +12 and /4 report their operation and operand')
ok(op('+-3')?.x === -3 && op('50') === undefined, '+-3 is a step down; a plain value has no operation')
ok(applyRel({ op: '*', x: 2 }, 200) === 400 && applyRel({ op: '*', x: 2 }, 300) === 600 && applyRel({ op: '+', x: 10 }, 300) === 310, '*2 doubles 200 and 300 each; +10 adds to each')

console.log('\nthe decimal comma, only where it cannot be a thousands separator\n')
is('12,34', 0, 12.34)
is('1,0001', 0, 1.0001)
for (const ambiguous of ['1,000', '10,000', '1.000,5', '1,000.5', '+1,000']) is(ambiguous, 7, null)

console.log('\nthe interface language decides what a grouping mark is\n')
const loc = (text: string, dec: '.' | ',', v: number | null) => {
  const r = evalNumber(text, 7, dec)
  ok(v === null ? r === null : !!r && Math.abs(r.v - v) < 1e-9, `"${text}" with decimal "${dec}" → ${v === null ? 'refused' : v} (${JSON.stringify(r)})`)
}
loc('1,000', '.', 1000); loc('12,345,678', '.', 12345678); loc('1,000.5', '.', 1000.5); loc('1,5', '.', 1.5); loc('1.000,5', '.', null)
loc('1.000', ',', 1000); loc('1.000,5', ',', 1000.5); loc('1,000', ',', 1); loc('2.5', ',', 2.5); loc('1.0001', ',', 1.0001)

console.log('\nrefused\n')
for (const junk of ['', '   ', 'abc', 'alert(1)', 'Math.PI', '2+', '(2', '2)', '1/0', '/0', '2**3', '3 4', 'constructor', '0x10', '1;2']) is(junk, 7, null)

console.log('\nnever eval\n')
const src = readFileSync(new URL('../slides/src/editor/inspector/numexpr.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
ok(!/\beval\s*\(|new Function|Function\(/.test(src), 'numexpr.ts calls neither eval nor Function')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
