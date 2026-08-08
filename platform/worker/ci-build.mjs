#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The "Build command" for Cloudflare Workers Builds (platform/README.md
// "Automatic deploys"). Workers Builds clones the whole repo, runs this from
// platform/worker/ (the configured root directory), then runs its own
// "Deploy command" (`npx wrangler deploy`) — which bundles src/index.ts with
// wrangler's built-in bundler. So this script's only job is making sure
// src/generated/shell.ts exists and is fresh before that deploy step runs:
//
//   1. build the slides app (its own separate npm project)
//   2. split the built shell into SHELL_HEAD/SHELL_TAIL
//
// Unlike the manual "paste dist/worker.js" path (build.mjs), this does NOT
// run our own esbuild bundle — wrangler bundles src/index.ts itself, so
// there is exactly one bundling implementation per deploy mechanism, not two
// competing ones for the same mechanism.
//
// Local dry run: `node ci-build.mjs` from platform/worker/, then
// `npx wrangler deploy --dry-run` to confirm it packages cleanly without
// actually deploying (needs wrangler.toml's placeholders filled in, or at
// least present — see platform/README.md).

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const slidesDir = join(repoRoot, 'slides')
const shellPath = join(slidesDir, 'dist-single', 'Bento_Slides.bento.html')

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// shell:true on win32 only — execFileSync can't invoke a .cmd shim directly
// (EINVAL); harmless on the Linux containers Workers Builds actually runs on.
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })

console.log('• building slides shell…')
run(npm, ['ci'], { cwd: slidesDir })
run(npm, ['run', 'build:single'], { cwd: slidesDir })
if (!existsSync(shellPath)) {
  console.error(`✗ expected a built shell at ${shellPath}, found none`)
  process.exit(1)
}

console.log('• splitting shell…')
run('node', [join(repoRoot, 'platform', 'build', 'split-shell.mjs')])

console.log('✓ ci-build.mjs done — ready for `wrangler deploy` to bundle src/index.ts')
