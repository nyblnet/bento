// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Which trailing parentheses the hint turns into key chips.
//
//   node scripts/test-slides-hint-keys.ts
//
// WHAT THIS PROVES: a tooltip's trailing "(…)" becomes key chips when it is
// keys — modifier chords, and since the speaker view's "(L)" and "(→)" also a
// lone key — and stays text when it is a word or a sentence ("(PDF)",
// "(⇧Tab while editing)").
import { SHORTCUT } from '../slides/src/editor/hints.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const cases: Array<[string, string | null]> = [
  ['Laser pointer (L)', 'L'], ['Next (→)', '→'], ['Shortcuts (?)', '?'], ['Group (⌘G)', '⌘G'],
  ['Undo · redo (⌘Z · ⌘⇧Z)', '⌘Z · ⌘⇧Z'], ['Prev · next (← · →)', '← · →'], ['Start over (Home)', 'Home'],
  ['Export (PDF)', null], ['Indent (⇧Tab while editing)', null], ['Accent (A1)', null],
]
for (const [s, want] of cases) {
  const got = SHORTCUT.exec(s)?.[1] ?? null
  ok(got === want, `"${s}" → ${got === null ? 'text' : `keys ${got}`}`)
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
