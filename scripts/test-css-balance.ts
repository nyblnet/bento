// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Every tracked stylesheet's braces balance.
//
//   node scripts/test-css-balance.ts
//
// A merge that keeps both sides of an append conflict can drop the one line the
// two sides shared — and in CSS that line is often a lone `}`. The build does not
// mind: a stylesheet with an unclosed `@media print {` parses, and every rule
// after it quietly applies only when PRINTING. That shipped into a spaces branch
// on 2026-10-09 (the footnotes print block lost its brace) and the app looked
// unstyled — menus with no corners or shadow — while tsc, the build and the
// shell gate all passed. Only a browser rig that happened to measure menu
// corners noticed. This rig catches the class directly, for every app.
//
// The scan skips comments, quoted strings and url(...) bodies, so a brace inside
// `content: "{"` or a data: URL does not count. It fails on a `}` with nothing
// open (depth below zero) and on anything still open at end of file, naming the
// line where the unclosed block began.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0, checks = 0
function ok(cond: boolean, what: string): void {
  checks++
  if (cond) console.log(`  ok    ${what}`)
  else { failures++; console.error(`  FAIL  ${what}`) }
}

export interface Balance { ok: boolean; problem?: string }

/** Brace balance of one stylesheet, ignoring comments, strings and url(). */
export function balance(css: string): Balance {
  const open: number[] = []          // line of each unclosed `{`
  let line = 1
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (c === '\n') { line++; continue }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      const stop = end === -1 ? css.length : end + 2
      for (let j = i; j < stop; j++) if (css[j] === '\n') line++
      i = stop - 1
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < css.length && css[j] !== c && css[j] !== '\n') { if (css[j] === '\\') j++; j++ }
      i = j
      continue
    }
    if ((c === 'u' || c === 'U') && /^url\(/i.test(css.slice(i, i + 4))) {
      const end = css.indexOf(')', i + 4)
      if (end !== -1) { for (let j = i; j < end; j++) if (css[j] === '\n') line++; i = end; continue }
    }
    if (c === '{') open.push(line)
    else if (c === '}') {
      if (!open.length) return { ok: false, problem: `a \`}\` on line ${line} closes nothing` }
      open.pop()
    }
  }
  if (open.length) return { ok: false, problem: `${open.length} block(s) never closed; the first opens on line ${open[0]}` }
  return { ok: true }
}

console.log('\nthe checker itself (negative controls)\n')
{
  // The exact 2026-10-09 regression: a print block whose `}` a merge ate.
  const eaten = '@media print {\n  .a { color: #000; }\n/* next section */\n.menu { border-radius: 10px; }\n'
  const r1 = balance(eaten)
  ok(!r1.ok && /line 1/.test(r1.problem ?? ''), `an unclosed @media print is caught, at the line it opens (${r1.problem})`)
  const r2 = balance('.a { color: red; }\n}\n')
  ok(!r2.ok && /line 2/.test(r2.problem ?? ''), `a stray \`}\` is caught (${r2.problem})`)
  const r3 = balance('.a::before { content: "{"; }\n.b { background: url(data:image/svg+xml;utf8,<svg>{</svg>); }\n/* { */\n')
  ok(r3.ok, 'braces inside strings, url() and comments do not count')
}

console.log('\nevery tracked stylesheet\n')
{
  const files = execFileSync('git', ['ls-files', '*.css'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter((f) => f && !/(^|\/)(node_modules|dist|dist-single|vendor)\//.test(f))
  ok(files.length >= 10, `found the app stylesheets (${files.length})`)
  for (const f of files) {
    const r = balance(readFileSync(join(root, f), 'utf8'))
    ok(r.ok, r.ok ? `${f} balances` : `${f}: ${r.problem}`)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
