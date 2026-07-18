#!/usr/bin/env node
// The guestbook daemon's one command. Two modes:
//
//   node scripts/guestbook-roll.mjs --snapshot-only
//     → join the live room read-only, archive what people actually signed
//       (working/guestbook-epochs/epoch-N-content-*.bento.html). No publish.
//
//   node scripts/guestbook-roll.mjs
//     → full epoch roll: content archive, then mint epoch N+1 with FRESH
//       room+key (kill switch semantics — the published file stops pointing
//       at the old room), publish to bento-site AND refresh site/ staging.
//
// Scheduling: a Claude Code scheduled task runs --snapshot-only daily.
// Rolls are run on demand (or schedule this same command for launch week).

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const live = join(root, 'working/guestbook-live/guestbook.bento.html')
const siteRepo = join(root, '../bento-site')
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })

if (!existsSync(live)) {
  console.error('guestbook is not armed (working/guestbook-live/ empty) — nothing to do')
  process.exit(1)
}

// 1 · capture what the room actually holds (read-only join + replay)
run('node', [join(root, 'scripts/guestbook-archivist.ts')])

if (process.argv.includes('--snapshot-only')) process.exit(0)

// 2 · mint the next epoch (archives the pristine file, fresh credentials)
run('node', [join(root, 'scripts/build-guestbook.mjs')])

// 3 · publish: the live site repo directly (fast path), plus site/ staging
//     so the next full release carries the same epoch
copyFileSync(live, join(siteRepo, 'guestbook.bento.html'))
copyFileSync(join(root, 'site-src/guestbook.html'), join(siteRepo, 'guestbook/index.html'))
if (existsSync(join(root, 'site/guestbook.bento.html'))) copyFileSync(live, join(root, 'site/guestbook.bento.html'))
run('git', ['add', 'guestbook.bento.html', 'guestbook/index.html'], siteRepo)
run('git', ['commit', '-m', 'Guestbook: roll epoch'], siteRepo)
run('git', ['push'], siteRepo)
console.log('epoch rolled and published — old room orphaned from the published file')
