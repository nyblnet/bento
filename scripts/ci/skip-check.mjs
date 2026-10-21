// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// node skip-check.mjs <step script> <step output>: bento-step's verdict.
// Exits 1 on any skip the allowlist does not cover. See ../lib/ci-skips.mjs.
import { readFileSync } from 'node:fs'
import { check } from '../lib/ci-skips.mjs'

const [scriptPath, outPath] = process.argv.slice(2)
const found = check(readFileSync(scriptPath, 'utf8'), readFileSync(outPath, 'utf8'))
const bad = found.filter((f) => !f.entry)
for (const f of found.filter((x) => x.entry)) console.log(`::notice::allowed skip (${f.entry.rig}): ${f.line} — ${f.entry.why}`)
if (bad.length) {
  for (const f of bad) console.log(`::error::a rig skipped under CI: ${f.line}`)
  console.log(`\n${bad.length} skip(s) under CI. A skipped rig checked nothing, so this step fails.`)
  console.log('Give the rig what it needs in CI (install it, build it), or, if CI genuinely cannot,')
  console.log('add an entry with the reason to ALLOWED_SKIPS in scripts/lib/ci-skips.mjs.')
  process.exit(1)
}
