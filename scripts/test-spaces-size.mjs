#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The shell-size ceiling, enforced.
//
//   node scripts/test-spaces-size.mjs [--update]
//
// WHY THIS EXISTS. docs/DECISIONS.md set a 100KB ceiling for bento/spaces and
// the round finished at 108KB. That is not the failure — features were worth
// their bytes and the ceiling was raised deliberately. The failure is that the
// same entry said "the ceiling is checked per feature from here" and shipped NO
// MECHANISM, so the breach was found by a reviewer reading the number, weeks of
// features later, rather than by the build that caused it.
//
// A budget nobody measures is a wish. This measures it.
//
// TWO MODES, because a ceiling and a measurement are different tools.
//
// enforce:true is a CEILING: a feature that needs bytes takes them and raises
// `max` in the same commit, which is a two-line diff a reviewer can see and
// argue with.
//
// enforce:false is a WATERMARK: the size and its drift from `reference` are
// printed every run, and nothing fails. bento/spaces is here by the
// maintainer's decision — at 98.6% of the old 256 KiB ceiling the app had
// started declining worthwhile fixes over a few hundred bytes, which is the
// ceiling costing more than it saves.
//
// What BOTH modes stop is the drift nobody chose — forty commits each costing
// 300 bytes. That never needed the failure to work; it needed the number to be
// in front of somebody. Only the block is gone.
//
// THE NUMBER IS ENVIRONMENT-SENSITIVE, and CI's is the one that counts.
// Most of the shell is a zlib-deflated block, and zlib's output differs
// slightly between node versions: measured on one commit, node 26 locally
// produced 130,095 B where CI's node 24 produced 131,246 B — 1.1 KB apart for
// identical input. So a ceiling set tight against a local build fails in CI for
// reasons that have nothing to do with the change. Leave a few KB of headroom,
// and when the two disagree, believe CI.
//
// Spaces ships in ONE file that people mail to each other, and every byte is
// paid on every open, on every phone, forever. Slides is 560KB because it grew
// for a year without one of these.

import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const BUDGETS = join(root, 'scripts/size-budgets.json')

const budgets = JSON.parse(readFileSync(BUDGETS, 'utf8'))
const update = process.argv.includes('--update')

let failures = 0
for (const [name, b] of Object.entries(budgets.shells)) {
  const path = join(root, b.path)
  let bytes
  try { bytes = statSync(path).size } catch {
    console.log(`  skip  ${name} — not built (${b.path})`)
    continue
  }
  // A tracked shell reports its drift and never fails.
  if (b.enforce === false) {
    const ref = b.reference ?? bytes
    const drift = bytes - ref
    const sign = drift > 0 ? '+' : ''
    const since = drift === 0 ? 'at reference' : `${sign}${drift} B since reference`
    if (update) {
      b.reference = bytes
      console.log(`  set   ${name.padEnd(8)} ${String(bytes).padStart(7)} B → new reference`)
      continue
    }
    console.log(`  track ${name.padEnd(8)} ${String(bytes).padStart(7)} B  (${since}, no ceiling)`)
    continue
  }

  const pct = ((bytes / b.max) * 100).toFixed(1)
  const head = `${name.padEnd(8)} ${String(bytes).padStart(7)} B  of ${b.max} B  (${pct}%)`

  if (update) {
    b.max = bytes
    console.log(`  set   ${head} → new ceiling`)
    continue
  }
  if (bytes > b.max) {
    failures++
    console.log(`  FAIL  ${head}`)
    console.log(`        over by ${bytes - b.max} B. Either give the bytes back, or raise`)
    console.log(`        "${name}".max in scripts/size-budgets.json IN THIS COMMIT and say`)
    console.log(`        in the message what bought them. Do not raise it silently.`)
  } else {
    console.log(`  ok    ${head}`)
  }
}

if (update) {
  writeFileSync(BUDGETS, `${JSON.stringify(budgets, null, 2)}\n`)
  console.log('\nbudgets rewritten to the current sizes')
  process.exit(0)
}

console.log(failures ? `\n${failures} shell(s) over budget` : '\nall shells within their limits')
process.exit(failures ? 1 : 0)
