#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/convert suite runner — every rig in scripts/test-convert/, each in its
// own node process (a rig that crashes at import must fail ITS run, not take
// the suite's reporting down with it).
//
//   node scripts/test-convert.ts
//
// Underscore-prefixed files are shared fixtures/helpers, not rigs. Order is
// alphabetical and deliberate: load.ts (the loadability gate) runs among the
// rest, and any child's non-zero exit fails the suite.

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'test-convert')
const rigs = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
  .sort()

const failed: string[] = []
for (const rig of rigs) {
  console.log(`\n== ${rig} ==`)
  const r = spawnSync(process.execPath, [join(dir, rig)], { stdio: 'inherit' })
  if (r.status !== 0) failed.push(rig)
}

console.log(failed.length
  ? `\n${failed.length}/${rigs.length} rigs FAILED: ${failed.join(', ')}`
  : `\nall ${rigs.length} rigs passed`)
if (failed.length) process.exit(1)
