#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Bundles src/index.ts into ONE plain-JS file, so it can be pasted whole into
// the Cloudflare dashboard's Worker "Quick Edit" editor — no wrangler, no
// multi-file module upload. Requires the shell to have been split first
// (`node ../build/split-shell.mjs` from here, or `node platform/build/split-shell.mjs`
// from the repo root), since index.ts transitively imports the generated
// shell constants. Lives inside worker/ (not platform/build/) so plain `node
// build.mjs` resolves esbuild from this package's own node_modules.
//
// Usage: node build.mjs   (from platform/worker/), or `npm run build`
// Output: platform/worker/dist/worker.js

import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, 'src', 'index.ts')
const generatedShell = join(here, 'src', 'generated', 'shell.ts')
const outfile = join(here, 'dist', 'worker.js')

if (!existsSync(generatedShell)) {
  console.error('✗ no generated shell — run `node platform/build/split-shell.mjs` first')
  process.exit(1)
}

await build({
  entryPoints: [entry],
  bundle: true,
  outfile,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  conditions: ['worker', 'browser'],
  minify: true,
  legalComments: 'none',
})

console.log(`✓ bundled → platform/worker/dist/worker.js`)
console.log('  paste this file into the CF dashboard Worker "Quick Edit" editor (see platform/README.md)')
