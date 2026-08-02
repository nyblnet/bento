#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Publish deletion-gate rig.
//
//   node scripts/test-publish-gate.mjs
//
// WHAT THIS PROVES. `site/` is assembled for ONE app and mirrored
// authoritatively with `rsync --delete`, so every artifact that build did not
// write is removed from bento.page. Measured against a copy of the real
// published tree, a spaces-shaped `site/` deleted 47 live files — the signed
// shell, `releases/slides/manifest.json`, all 22 language packs, the gallery,
// the guestbook landing page — with every pre-existing gate green.
//
// Shipped files check their manifest and pack channel at those exact paths.
// A deletion takes them offline permanently and cannot be repaired from the
// client side, which makes this the one publish mistake with no way back.
//
// The pre-existing gates could not catch it because they are FAIL-OPEN:
// `if (existsSync(<path in site/>))` skips the check when the artifact is
// MISSING, which is exactly the dangerous case. So the properties that matter
// here are (1) a missing artifact TRIPS the gate rather than skipping it, and
// (2) an excluded path is still not a deletion, or every ordinary publish
// without a guestbook deck would be blocked.

import { plannedDeletions, groupDeletions, walk } from './site-inventory.mjs'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// A published tree shaped like the real one: the artifacts shipped files depend on.
const PUBLISHED = [
  'index.html', 'CNAME', '.nojekyll', 'agents.md', 'LICENSE',
  'releases/slides/Bento_Slides.bento.html',
  'releases/slides/manifest.json',
  'releases/slides/packs.json',
  'releases/slides/packs/bento-slides-1.0.13-ko.pack.json',
  'releases/slides/packs/bento-slides-1.0.13-ru.pack.json',
  'slides/index.html',
  'gallery/orbital-dark-immersive.bento.html',
  'guestbook/index.html',
  'guestbook.bento.html',
  'skills/bento-slides/SKILL.md',
]

// ---- the failure this exists to stop -------------------------------------
// A spaces release: index.html is rewritten, spaces artifacts appear, and
// every slides artifact is simply absent from the staging tree.
const SPACES_STAGED = [
  'index.html', 'CNAME', '.nojekyll',
  'releases/spaces/Bento_Spaces.bento.html',
  'releases/spaces/manifest.json',
  'spaces/index.html',
]
const spacesDeletions = plannedDeletions(PUBLISHED, SPACES_STAGED, ['.git'])
ok(spacesDeletions.length === 12,
  `a spaces-shaped publish is reported as deleting 12 live files (got ${spacesDeletions.length})`)
for (const critical of [
  'releases/slides/manifest.json',
  'releases/slides/packs.json',
  'releases/slides/Bento_Slides.bento.html',
  'releases/slides/packs/bento-slides-1.0.13-ko.pack.json',
]) {
  ok(spacesDeletions.includes(critical),
    `the update/pack channel artifact ${critical} is caught`)
}

// ---- an ordinary publish must not be blocked ------------------------------
ok(plannedDeletions(PUBLISHED, PUBLISHED, ['.git']).length === 0,
  'republishing exactly what is live deletes nothing')

// Note the gate is deliberately PATH-based: a release is supposed to change
// bytes, and the one byte-change nobody can repair — a manifest going
// backwards — already has its own monotonicity gate in publish-site.mjs.

// ---- exclusions ------------------------------------------------------------
// The mirror does not touch an excluded path, so it cannot delete it. Without
// this, every release built from a clean tag checkout — which never has the
// gitignored guestbook epoch — would be blocked outright.
const noGuestbookDeck = PUBLISHED.filter((p) => p !== 'guestbook.bento.html')
ok(plannedDeletions(PUBLISHED, noGuestbookDeck, ['.git', 'guestbook.bento.html']).length === 0,
  'a path excluded from the mirror is not counted as a deletion')
ok(plannedDeletions(PUBLISHED, noGuestbookDeck, ['.git']).includes('guestbook.bento.html'),
  'the same path IS a deletion when it is not excluded — the exclusion is doing the work')

// Directory-prefix exclusions must cover their contents, and nothing else.
ok(plannedDeletions(PUBLISHED, [], ['.git', 'releases']).every((p) => !p.startsWith('releases/')),
  'excluding a directory covers everything under it')
ok(plannedDeletions(PUBLISHED, [], ['.git', 'guestbook']).includes('guestbook.bento.html'),
  'excluding "guestbook" does NOT swallow the sibling file "guestbook.bento.html"')

// ---- grouping --------------------------------------------------------------
const groups = new Map(groupDeletions(spacesDeletions))
ok(groups.get('releases') === 5, `the shell, manifest, index and 2 packs collapse into one "releases" line (got ${groups.get('releases')})`)
ok(groups.get('agents.md') === 1, 'a top-level file is its own group')

// ---- walk() ----------------------------------------------------------------
const tmp = join(tmpdir(), `bento-gate-${process.pid}`)
try {
  for (const rel of ['a.txt', 'sub/b.txt', '.git/HEAD', 'sub/deep/c.txt']) {
    mkdirSync(dirname(join(tmp, rel)), { recursive: true })
    writeFileSync(join(tmp, rel), 'x')
  }
  const found = walk(tmp).sort()
  ok(JSON.stringify(found) === JSON.stringify(['a.txt', 'sub/b.txt', 'sub/deep/c.txt']),
    `walk() returns relative paths and never enters .git (got ${JSON.stringify(found)})`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
