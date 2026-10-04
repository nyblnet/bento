#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// maths-lite against Temml's WHOLE vocabulary, offline.
//
//   node scripts/test-maths-coverage.ts            # the gate
//   node scripts/test-maths-coverage.ts --update   # raise the floor after adding commands
//   node scripts/test-maths-coverage.ts --list     # print what still falls back
//
// WHAT THIS PROVES. scripts/fixtures/maths-coverage.json holds one minimal
// form of every command and environment Temml 0.13.3 knows, with Temml's
// normalised tree (frozen by scripts/maths-freeze-coverage.ts). Against it:
//
//   1. NO REGRESSION. Every command in `covered` still renders. This is the
//      check that would have caught #540: 1.2.0 dropped 57 commands Temml drew
//      and a percentage over a hand-picked sample never noticed.
//   2. A FLOOR THAT ONLY RISES. The number that render and the number that are
//      tree-identical to Temml may not fall below the recorded floor. After
//      adding commands, `--update` records the new floor and covered list.
//   3. THE COMMON TIER IS COMPLETE. scripts/fixtures/maths-common.json lists
//      the commands and formulas people actually type (the #551 gaps page);
//      every one must render, whatever the totals say.
//
// Since #551 every one of the 1,237 renders. A few render as their nearest
// sensible meaning rather than Temml's: \ref/\eqref as plain text (a slide
// has no labels to point at), the TeX primitives (\expandafter, \relax) as
// nothing. `--list` prints whatever falls back if that ever changes.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { renderMath } from '../slides/src/maths/index.ts'
import { treeKey } from './lib/mathml-tree.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const path = join(root, 'scripts/fixtures/maths-coverage.json')
const fix = JSON.parse(readFileSync(path, 'utf8')) as {
  temml: string; frozen: string; floor: { renders: number; identical: number }; covered: string[]
  forms: Array<{ cmd: string; src: string; display: boolean; tree: string }>
}
const common = JSON.parse(readFileSync(join(root, 'scripts/fixtures/maths-common.json'), 'utf8')) as { mustRender: Array<{ src: string; display?: boolean }> }

const results = fix.forms.map((f) => {
  const ml = renderMath(f.src, { display: f.display })
  // a DRAWN arrow (#551: → ↔ ↦ = ⇌ … Chrome will not stretch, so they are
  // an inline svg) differs from Temml's mover on purpose; it counts with the
  // identical ones, and is reported on its own line
  const drawn = !!ml && ml.includes('<svg role="img" aria-label=')
  return { ...f, ours: ml, drawn, same: !!ml && (drawn || treeKey(ml) === f.tree) }
})
const renders = results.filter((r) => r.ours).length
const identical = results.filter((r) => r.same).length

if (process.argv.includes('--list')) {
  for (const r of results.filter((r) => !r.ours)) console.log(`${r.cmd}\t${r.src}`)
  process.exit(0)
}
if (process.argv.includes('--update')) {
  fix.floor = { renders, identical }
  fix.covered = results.filter((r) => r.ours).map((r) => r.cmd)
  writeFileSync(path, JSON.stringify(fix, null, 1) + '\n')
  console.log(`floor raised to ${renders} rendering, ${identical} tree-identical, of ${results.length}`)
  process.exit(0)
}

console.log(`Temml ${fix.temml}'s vocabulary (${results.length} commands and environments, frozen ${fix.frozen})\n`)
const lost = fix.covered.filter((c) => !results.find((r) => r.cmd === c)?.ours)
ok(lost.length === 0, `no covered command falls back to raw text${lost.length ? ' — lost: ' + lost.join(' ') : ''} (${fix.covered.length} covered)`)
ok(renders >= fix.floor.renders, `renders ${renders} of ${results.length}, floor ${fix.floor.renders}`)
ok(identical >= fix.floor.identical, `tree-identical to Temml ${identical} (${results.filter((r) => r.drawn).length} of them arrows drawn in svg on purpose), floor ${fix.floor.identical}`)
if (renders > fix.floor.renders || identical > fix.floor.identical) console.log('        (above the floor — run with --update to raise it)')

console.log('\nthe common tier (scripts/fixtures/maths-common.json)\n')
const nulls = common.mustRender.filter((f) => renderMath(f.src, { display: !!f.display }) === null)
ok(nulls.length === 0, `every commonly typed formula renders (${common.mustRender.length - nulls.length}/${common.mustRender.length})${nulls.length ? '\n        null: ' + nulls.map((f) => f.src).join('\n              ') : ''}`)

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
