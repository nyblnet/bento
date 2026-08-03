#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// App-registry rig.
//
//   node scripts/test-release-apps.mjs
//
// WHAT THIS PROVES. `scripts/apps.mjs` tells the release pipeline what to
// build, what the built file is called, and which app id to sign the manifest
// with. None of it can be checked by running a release: a release SIGNS, and
// the signing key never leaves the maintainer's machine (docs/RELEASING.md),
// so the pipeline is deliberately not CI-testable.
//
// The registry drifting from the tree is, and each field fails differently:
//
//   · `dir` wrong        → the release cannot find package.json. Loud, harmless.
//   · `shell` wrong      → the build succeeds and staging copies a file that is
//                          not there. Discovered mid-release.
//   · `appId` wrong      → the WORST case, and silent. A shipped shell verifies
//                          the manifest's `app` against its own configureApp()
//                          id (kernel/src/update.ts), so a mismatch signs and
//                          publishes an update channel every file quietly
//                          declines. Nothing errors; updates simply stop.
//
// So the registry is pinned against the app's own source of truth: its
// package.json build script, and the configureApp() call in its main.ts.

import { APPS } from './apps.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

let failures = 0
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

ok(Object.keys(APPS).length > 0, 'the registry is not empty')

for (const [key, app] of Object.entries(APPS)) {
  const pkgPath = join(root, app.dir, 'package.json')
  ok(existsSync(pkgPath), `${key}: ${app.dir}/package.json exists`)
  if (!existsSync(pkgPath)) continue

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const build = pkg.scripts?.['build:single'] ?? ''
  ok(!!build, `${key}: has a build:single script`)
  ok(build.includes(app.shell),
    `${key}: build:single produces ${app.shell} (the name the release stages)`)

  // appId is the silent one — pin it to the app's own configureApp() call.
  const mainPath = join(root, app.dir, 'src/main.ts')
  ok(existsSync(mainPath), `${key}: ${app.dir}/src/main.ts exists`)
  if (existsSync(mainPath)) {
    const main = readFileSync(mainPath, 'utf8')
    const m = main.match(/appId:\s*'([^']+)'/)
    ok(m?.[1] === app.appId,
      `${key}: appId "${app.appId}" matches configureApp() in main.ts (found "${m?.[1] ?? 'none'}")`)
    // The manifest URL is frozen into every file ever saved, so the path
    // segment the release publishes to must match what the shell will fetch.
    const url = main.match(/manifestUrl:\s*'([^']+)'/)?.[1] ?? ''
    ok(url.includes(`/releases/${app.dir}/`),
      `${key}: shell fetches /releases/${app.dir}/ (found "${url}")`)
  }

  // Exactly one app may own the shared bento.page content, or a release either
  // regenerates it from a shell it did not build, or nobody ever rebuilds it.
  ok(typeof app.ownsSiteContent === 'boolean', `${key}: declares ownsSiteContent`)
  ok(typeof app.packs === 'boolean', `${key}: declares whether it has a pack channel`)
}

const owners = Object.entries(APPS).filter(([, a]) => a.ownsSiteContent).map(([k]) => k)
ok(owners.length === 1,
  `exactly one app owns the site content (got ${owners.length}: ${owners.join(', ') || 'none'})`)

const ids = Object.values(APPS).map((a) => a.appId)
ok(new Set(ids).size === ids.length, 'app ids are unique')
const dirs = Object.values(APPS).map((a) => a.dir)
ok(new Set(dirs).size === dirs.length, 'app directories are unique')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
