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
//   · `changelog` wrong  → also silent, and it ships. The notes ride in the
//                          SIGNED manifest and are rendered inline by every
//                          file that finds an update, so an app pointed at
//                          another app's changelog tells all of its users about
//                          a product they do not have. (Every app read the root
//                          CHANGELOG until 2026-08-03.)
//   · `appId` wrong      → the WORST case, and silent. A shipped shell verifies
//                          the manifest's `app` against its own configureApp()
//                          id (kernel/src/update.ts), so a mismatch signs and
//                          publishes an update channel every file quietly
//                          declines. Nothing errors; updates simply stop.
//
// So the registry is pinned against the app's own source of truth: its
// package.json build script, and the configureApp() call in its main.ts.

import { APPS, tagFor } from './apps.mjs'
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

  // ---- release notes -------------------------------------------------------
  // The notes are lifted from the section matching THIS version and signed
  // into the manifest, so both halves have to line up before a release runs.
  // Resolved exactly as release.mjs resolves it: registry, then the
  // <dir>/CHANGELOG.md convention, then the root. The root is slides' file, so
  // reaching it from another app is the failure — these checks are what keep it
  // unreachable.
  const resolved = app.changelog
    ?? (existsSync(join(root, `${app.dir}/CHANGELOG.md`)) ? `${app.dir}/CHANGELOG.md` : 'CHANGELOG.md')
  const clPath = join(root, resolved)
  ok(existsSync(clPath), `${key}: resolves to a changelog that exists (${resolved})`)
  if (existsSync(clPath)) {
    const cl = readFileSync(clPath, 'utf8')
    // A section for the version being released, with at least one bold lead-in
    // — release.mjs harvests exactly those, so a section of prose signs EMPTY
    // notes and the reader gets a bare version number.
    const re = new RegExp(`^## \\[${pkg.version.replace(/\./g, '\\.')}\\][^\n]*$`, 'm')
    const m = re.exec(cl)
    ok(!!m, `${key}: the changelog has a section for the version being released (${pkg.version})`)
    if (m) {
      const next = cl.slice(m.index + m[0].length)
      const body = next.split(/^## \[/m)[0]
      ok(/^- \*\*(.+?)\*\*/ms.test(body.trim()),
        `${key}: that section has bold lead-ins (what release.mjs signs as the notes)`)
    }
  }

  // The agent guide is published at /<dir>/agents.md by that app's release.
  if (app.agents) ok(existsSync(join(root, app.agents)), `${key}: agent guide exists (${app.agents})`)
  ok(typeof app.packs === 'boolean', `${key}: declares whether it has a pack channel`)

  // ---- tag and title -------------------------------------------------------
  // publish-site.mjs creates the GitHub release FOR a tag and attaches this
  // app's shell to it. Both fail QUIETLY when the app is wrong: a dash publish
  // that looked up slides' tag would find the release already there, print
  // "already published", and exit 0 having created nothing.
  ok(typeof app.tagPrefix === 'string', `${key}: declares a tagPrefix`)
  ok(!!app.label, `${key}: declares a release title (${app.label})`)
  ok(key === 'slides' ? app.tagPrefix === '' : app.tagPrefix === `${key}-`,
    `${key}: tags are ${tagFor(app, pkg.version)} (slides keeps the bare form it has used for 23 releases; every other app is prefixed)`)
}

// The actual 2026-08-03 bug: two apps reading one file. Distinctness is the
// property, and it is one line — the wrongness was never visible in either
// app's own checks, only in the pair.
const cls = Object.entries(APPS).map(([k, a]) => [k, a.changelog
  ?? (existsSync(join(root, `${a.dir}/CHANGELOG.md`)) ? `${a.dir}/CHANGELOG.md` : 'CHANGELOG.md')])
ok(new Set(cls.map(([, c]) => c)).size === cls.length,
  `each app has its OWN changelog (${cls.map(([k, c]) => `${k}→${c}`).join(', ')})`)

const owners = Object.entries(APPS).filter(([, a]) => a.ownsSiteContent).map(([k]) => k)
ok(owners.length === 1,
  `exactly one app owns the site content (got ${owners.length}: ${owners.join(', ') || 'none'})`)

const ids = Object.values(APPS).map((a) => a.appId)
ok(new Set(ids).size === ids.length, 'app ids are unique')
const dirs = Object.values(APPS).map((a) => a.dir)
ok(new Set(dirs).size === dirs.length, 'app directories are unique')

// Tags are the one namespace all three apps share. Slides is at 1.0.x and the
// others start at 0.x, so an unprefixed second app would sort into the middle
// of slides' history and claim a version slides can never use again.
const prefixes = Object.values(APPS).map((a) => a.tagPrefix)
ok(new Set(prefixes).size === prefixes.length, 'tag prefixes are unique — two apps cannot mint the same tag')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
