#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A backslash the author typed survives a commit, and committing twice is the
// same as committing once (#697).
//
//   node scripts/test-slides-backslash.ts
//
// WHAT THIS PROVES. The commit stripped `\` before ANY of * _ ~ ` -, so `a\-b`
// lost its backslash on blur, and `a\\-b` lost one on each later edit. A
// backslash is an escape only before a marker that would have acted (one half
// of a pair, or a bullet at a line start); everywhere else it is text.
// Same rule for pasted plain text (markdownToHtml).

import { markdownToHtml, stripMarkerEscapes } from '../slides/src/editor/markdown.ts'

let failures = 0
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const S = stripMarkerEscapes

console.log('\ncommit keeps typed backslashes\n')
ok(S('a\\-b') === 'a\\-b', 'a\\-b keeps its backslash (scenario 1)')
ok(S('a\\\\-b') === 'a\\\\-b', 'a\\\\-b is untouched (scenario 2, first blur)')
ok(S(S('a\\\\-b')) === 'a\\\\-b', 'and untouched on the second edit (scenario 2, step 5)')
ok(S('C:\\_x') === 'C:\\_x', 'a lone \\_ is text')
ok(S('a\\*b') === 'a\\*b', 'a lone \\* is text')
ok(S('1\\~2') === '1\\~2', 'a lone \\~ is text')
ok(S('path\\`x') === 'path\\`x', 'a lone backtick escape is text')

console.log('\nreal escapes still work, once\n')
ok(S('\\*not bold\\*') === '*not bold*', '\\*x\\* → *x*')
ok(S('\\_a\\_') === '_a_', '\\_a\\_ → _a_')
ok(S('\\~~x~~') === '~~x~~', 'one escaped marker of a pair')
ok(S('\\- item') === '- item', 'escaped bullet at line start')
ok(S('\\* item') === '* item', 'escaped star bullet at line start')
ok(S('x<br>\\- item') === 'x<br>- item', 'escaped bullet after a line break')
ok(S('<div>\\- item</div>') === '<div>- item</div>', 'escaped bullet inside a div line')
ok(S('<b>\\*x\\*</b>') === '<b>*x*</b>', 'inside inline tags')
ok(S(S('\\*not bold\\*')) === '*not bold*', 'idempotent on an escape')
ok(S('a\\*b<br>c*') === 'a\\*b<br>c*', 'a marker on ANOTHER line is not a pair')
ok(S('a - \\- b') === 'a - \\- b', 'a dash mid-line is not a bullet')
ok(S('$x\\_1$') === '$x\\_1$', 'formulas keep theirs')

console.log('\npaste keeps typed backslashes\n')
ok(markdownToHtml('a\\-b') === 'a\\-b', 'pasted a\\-b keeps the backslash')
ok(markdownToHtml('\\- not a bullet') === '- not a bullet', 'pasted escaped bullet')
ok(markdownToHtml('\\*x\\*') === '*x*', 'pasted escaped pair')
ok(markdownToHtml('C:\\_x') === 'C:\\_x', 'pasted lone \\_')

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
