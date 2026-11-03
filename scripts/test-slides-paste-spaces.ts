#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Pasted plain text keeps its runs of spaces, and the PowerPoint export keeps
// them too (#750).
//
//   node scripts/test-slides-paste-spaces.ts
//
// WHAT THIS PROVES. A text box paints with white-space:normal, so a pasted
// monospace table collapsed to single spaces. markdownToHtml now spells a run
// as hard spaces plus one breakable space (what typing does), and the export's
// run walker carries the hard spaces through to PowerPoint unchanged.

import { keepSpaces, markdownToHtml } from '../slides/src/editor/markdown.ts'
import { parseInlineHtml } from '../convert/src/pptx-write/text.ts'

let failures = 0
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const N = ' '
const table = 'a    b  c\n  indented\ttab\ntrail '

console.log('\nkeepSpaces\n')
ok(keepSpaces('a    b') === `a${N}${N}${N} b`, 'a run keeps every space, the last one breakable')
ok(keepSpaces('a b') === 'a b', 'a single space is untouched')
ok(keepSpaces(' x') === `${N}x` && keepSpaces('x ') === `x${N}`, 'leading and trailing spaces survive')
ok(keepSpaces('a\tb') === `a${N.repeat(4)}b`, 'a tab is four hard spaces')

console.log('\npasted plain text\n')
const html = markdownToHtml(table)
ok(html === `a${N}${N}${N} b${N} c<br>${N}${N}indented${N.repeat(4)}tab<br>trail${N}`, `markdownToHtml keeps the runs (${JSON.stringify(html)})`)
ok(markdownToHtml('  - sub') === `${N}${N}◦${N}sub`, 'sub-bullet indentation is unchanged')
ok(markdownToHtml('**a**   b') === `<b>a</b>${N}${N} b`, 'spaces next to markup too')

console.log('\nPowerPoint export\n')
const text = parseInlineHtml(html).map((r) => r.text + (r.breakAfter ? '\n' : '')).join('')
ok(text === `a${N}${N}${N} b${N} c\n${N}${N}indented${N.repeat(4)}tab\ntrail${N}`, `the export keeps them (${JSON.stringify(text)})`)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
