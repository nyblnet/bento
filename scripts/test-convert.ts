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

import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'test-convert')
const rigs = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
  .sort()

const failed: string[] = []
for (const rig of rigs) {
  console.log(`\n== ${rig} ==`)
  // A rig that reaches slides' untrusted-input gate cannot run under plain
  // node: the gate's own imports are extensionless. Such a rig says `// @bundle`
  // near its top and is bundled with the repo's esbuild first — the same move
  // scripts/bento-check.mjs and the clipboard rig make.
  let target = join(dir, rig)
  let tmp = ''
  if (/^\/\/ @bundle\b/m.test(readFileSync(target, 'utf8').slice(0, 2000))) {
    tmp = mkdtempSync(join(tmpdir(), 'convert-rig-'))
    const out = join(tmp, rig.replace(/\.ts$/, '.mjs'))
    const b = spawnSync(join(dir, '../../slides/node_modules/.bin/esbuild'),
      [target, '--bundle', '--platform=node', '--format=esm', '--log-level=error', `--outfile=${out}`],
      { stdio: 'inherit' })
    if (b.status !== 0) { failed.push(rig); rmSync(tmp, { recursive: true, force: true }); continue }
    target = out
  }
  const r = spawnSync(process.execPath, [target], { stdio: 'inherit' })
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  if (r.status !== 0) failed.push(rig)
}

console.log(failed.length
  ? `\n${failed.length}/${rigs.length} rigs FAILED: ${failed.join(', ')}`
  : `\nall ${rigs.length} rigs passed`)
if (failed.length) process.exit(1)
