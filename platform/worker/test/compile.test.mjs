#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Bundles compile.spec.ts (TS, imports compile.ts/schema.ts and — through
// them — slides/src/model.ts) into a plain ESM file and runs it as a child
// process, so its own process.exit() propagates the pass/fail status. Same
// shape as the main repo's scripts/test-*.ts rigs (see .github/workflows/ci.yml,
// e.g. "Spaces undo rig"). Uses esbuild's JS API (like build.mjs) rather than
// shelling out to its CLI — sidesteps the Windows `.cmd`-shim/shell-quoting
// mess entirely, not just papers over it.
//
//   node test/compile.test.mjs

import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, 'compile.spec.ts')
const outfile = join(mkdtempSync(join(tmpdir(), 'bento-platform-test-')), 'compile.spec.mjs')

const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
writeFileSync(outfile, result.outputFiles[0].text)

execFileSync(process.execPath, [outfile], { stdio: 'inherit' })
