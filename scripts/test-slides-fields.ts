#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Date/time field patterns (discussion #381): {{date:…}} and {{time:…}} pin a
// shape for every viewer; bare {{date}} still follows the viewer's locale.
//
//   node scripts/test-slides-fields.ts
//
// WHAT THIS PROVES. datefmt.ts formats a fixed instant by a pattern the way
// the doc comment says: longest token wins (YYYY before YY, MMMM before MM),
// literals pass through, [brackets] protect a word that contains a token
// letter, 12-hour tokens and am/pm agree, and a pattern with no token is
// returned as written. Every preset the Text panel offers formats without
// leaving a raw token behind. And render.ts routes the argument to it — the
// picker's tokens and the resolver's regex agree on the field names.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { formatDate, DATE_PRESETS, TIME_PRESETS, OTHER_FIELDS } from '../slides/src/datefmt.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')

// 4 September 2026, 14:05:09 local — single digits where they matter
const d = new Date(2026, 8, 4, 14, 5, 9)
const f = (p: string) => formatDate(d, p, 'en-US')

console.log('date tokens\n')
ok(f('YYYY') === '2026' && f('YY') === '26', 'YYYY → 2026, YY → 26')
ok(f('M/D/YY') === '9/4/26', 'M/D/YY → 9/4/26 (no padding)')
ok(f('MM/DD/YYYY') === '09/04/2026', 'MM/DD/YYYY → 09/04/2026 (padded)')
ok(f('DD/MM/YYYY') === '04/09/2026', 'DD/MM/YYYY → 04/09/2026')
ok(f('YYYY-MM-DD') === '2026-09-04', 'YYYY-MM-DD → ISO date')
ok(f('D MMMM YYYY') === '4 September 2026', 'D MMMM YYYY → 4 September 2026')
ok(f('MMM D') === 'Sep 4', 'MMM → short month')
ok(formatDate(d, 'D MMMM YYYY', 'fr-FR') === '4 septembre 2026', 'month names follow the locale — fr: septembre')
ok(formatDate(d, 'MMMM', 'de-DE') === 'September' && formatDate(d, 'MMMM', 'es-ES') === 'septiembre', 'de: September, es: septiembre')

console.log('\ntime tokens\n')
ok(f('HH:mm') === '14:05', 'HH:mm → 14:05')
ok(f('H:mm:ss') === '14:05:09', 'H:mm:ss → seconds padded')
ok(f('h:mm a') === '2:05 pm', 'h:mm a → 2:05 pm')
ok(f('hh:mm A') === '02:05 PM', 'hh:mm A → 02:05 PM')
ok(formatDate(new Date(2026, 8, 4, 0, 30), 'h:mm a') === '12:30 am', 'midnight is 12:30 am, not 0:30')
ok(formatDate(new Date(2026, 8, 4, 12, 0), 'h A') === '12 PM', 'noon is 12 PM')

console.log('\nliterals and precedence\n')
ok(f('D MMMM YYYY [at] h:mm a') === '4 September 2026 at 2:05 pm', '[at] is literal — the a inside it is not am/pm')
ok(f('[Date:] YYYY') === 'Date: 2026', 'a bracketed word with token letters (D, a) survives')
ok(f('YYYYMMDD') === '20260904', 'adjacent tokens, longest first')
ok(f('hello') === '2ello', 'an unbracketed h IS a token — the documented reason for brackets')
ok(f('') === '', 'empty pattern → empty')
ok(f('-- / --') === '-- / --', 'no token → returned as written')
ok(formatDate(d, 'D MMMM', 'no-such-locale-zz') !== '', 'an unknown locale falls back rather than throwing')

console.log('\nthe panel presets\n')
for (const p of [...DATE_PRESETS, ...TIME_PRESETS]) {
  const m = /^\{\{(date|time)(?::(.*))?\}\}$/.exec(p.token)
  ok(!!m, `${p.token} is a well-formed field token`)
  if (m?.[2]) ok((m[1] === 'date' ? /26/ : /05/).test(f(m[2])) && !/YYYY|MM|DD|HH|mm/.test(f(m[2])), `${p.token} formats: "${f(m[2])}"`)
}
ok(OTHER_FIELDS.every((p) => /^\{\{(page|pages|title|author|company|subject|event)\}\}$/.test(p.token)), 'the other fields are the resolver\'s names')

console.log('\nthe resolver\n')
const render = read('slides/src/render.ts')
ok(/case 'date': return escapeFieldText\(arg\?\.trim\(\) \? formatDate\(ctx\.date, arg\.trim\(\)\) : ctx\.date\.toLocaleDateString\(\)\)/.test(render), '{{date:…}} goes to formatDate; bare {{date}} stays viewer-locale')
ok(/case 'time': return escapeFieldText\(arg\?\.trim\(\) \? formatDate\(ctx\.date, arg\.trim\(\)\) :/.test(render), '{{time:…}} likewise')
const names = /\(page\|pages\|title\|date\|time\|author\|company\|subject\|event\)/.exec(render)
ok(!!names, 'the field-name alternation is unchanged (no new names, the format is untouched)')
const panels = read('slides/src/editor/panels.ts')
ok(/private buildFieldPicker\(el: TextElement\)/.test(panels) && /this\.buildFieldPicker\(el\)/.test(panels), 'the Text panel builds the field picker')
ok(/Text ▸ Field/.test(read('slides/src/editor/editor.ts')), 'the ? sheet names it')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
