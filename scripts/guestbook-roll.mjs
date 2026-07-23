#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// The guestbook daemon's one command — a COMPLETE, load-hardened epoch roll.
//
//   node scripts/guestbook-roll.mjs --snapshot-only
//     → archive the live room's content (daemon-side snapshot to KV + a local
//       copy). No mint, no publish.
//
//   node scripts/guestbook-roll.mjs
//     → full roll: archive → mint epoch N+1 with FRESH room+key (kill-switch:
//       the published file stops pointing at the old room) → publish to
//       bento-site (Pages fallback) + site/ staging → SEED THE DAEMON (which
//       serves from KV and is what actually makes the roll go live).
//
//   flags: --base <url> (default https://bento.page) · --no-daemon (skip the
//          daemon snapshot + seed, e.g. offline/local testing)
//
// Hardening (learned the hard way during the HN #1 surge):
//  · Archiving is DAEMON-FIRST. The server-side snapshot replays the room from
//    Cloudflare and does NOT depend on THIS machine being able to join — which
//    is exactly what fails under the load a launch-day roll exists for. The
//    local archivist is a non-fatal bonus copy.
//  · The daemon SEED is part of the roll, not a manual afterthought — otherwise
//    the live guestbook keeps serving the old room after a "successful" roll.
//  · git push targets origin HEAD:main explicitly — a bare push aborts (after
//    the commit) when the site branch has no upstream, half-finishing the roll.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const live = join(root, 'working/guestbook-live/guestbook.bento.html')
const siteRepo = join(root, '../bento-site')
const args = process.argv.slice(2)
const opt = (name, fb) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fb }
const base = opt('base', 'https://bento.page').replace(/\/$/, '')
const useDaemon = !args.includes('--no-daemon')

const run = (cmd, a, cwd = root) => execFileSync(cmd, a, { cwd, stdio: 'inherit' })
const oneLine = (e) => String(e?.message ?? e).split('\n')[0]
const tryRun = (label, fn) => {
  try { fn(); return true } catch (e) { console.warn(`⚠ ${label} failed (continuing): ${oneLine(e)}`); return false }
}

if (!existsSync(live)) {
  console.error('guestbook is not armed (working/guestbook-live/ empty) — nothing to do')
  process.exit(1)
}

// Best-effort daemon admin call (Bearer key from the gitignored token file).
const keyFile = join(root, 'working/guestbook-admin-key.txt')
const adminKey = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : null
async function daemon(action, method, body = null) {
  if (!useDaemon) return { skipped: 'no-daemon' }
  if (!adminKey) throw new Error('no admin key at working/guestbook-admin-key.txt')
  const headers = { Authorization: `Bearer ${adminKey}` }
  if (body != null) headers['content-type'] = 'text/html'
  const res = await fetch(`${base}/guestbook-admin/${action}`, { method, headers, body })
  const text = await res.text()
  if (!res.ok) throw new Error(`${action} → ${res.status}: ${text.slice(0, 200)}`)
  return text.replace(/\s+/g, ' ').trim()
}

// 1 · ARCHIVE FIRST — durably, server-side.
//   (a) daemon snapshot: authoritative KV archive via server-side CRDT replay;
//       independent of this machine joining the (possibly overloaded) room.
try {
  const r = await daemon('snapshot', 'POST')
  console.log(`daemon snapshot → ${r || '(ok)'}`)
} catch (e) {
  console.warn(`⚠ daemon snapshot failed (continuing; daemon also snapshots daily): ${oneLine(e)}`)
}
//   (b) local content archive: a bonus copy in working/guestbook-epochs/. Joins
//       the room read-only — NON-FATAL, because (a) already preserved it and the
//       join is the first thing to fail under load.
tryRun('local archivist (working/guestbook-epochs/)', () =>
  run('node', [join(root, 'scripts/guestbook-archivist.ts')]))

if (args.includes('--snapshot-only')) process.exit(0)

// 2 · mint the next epoch (fatal — the core operation; archives the pristine
//     file and writes fresh room+key + owner deck into working/guestbook-live/)
run('node', [join(root, 'scripts/build-guestbook.mjs')])

// 3 · publish the static fallback: bento-site (Pages) + site/ staging
copyFileSync(live, join(siteRepo, 'guestbook.bento.html'))
copyFileSync(join(root, 'site-src/guestbook.html'), join(siteRepo, 'guestbook/index.html'))
if (existsSync(join(root, 'site/guestbook.bento.html'))) copyFileSync(live, join(root, 'site/guestbook.bento.html'))
run('git', ['add', 'guestbook.bento.html', 'guestbook/index.html'], siteRepo)
run('git', ['commit', '-m', 'Guestbook: roll epoch'], siteRepo)
run('git', ['push', 'origin', 'HEAD:main'], siteRepo)

// 4 · SEED THE DAEMON — it serves the deck from KV, so this is what makes the
//     roll actually go live. If it fails the roll is INCOMPLETE; say so loudly.
let seeded = false
if (useDaemon) {
  try {
    const r = await daemon('seed', 'PUT', readFileSync(live))
    console.log(`daemon seeded → ${r}`)
    seeded = true
  } catch (e) {
    console.error(
      `\n✗ daemon seed FAILED — the LIVE guestbook is still on the OLD epoch.\n` +
      `  reason: ${oneLine(e)}\n` +
      `  retry:  curl -X PUT ${base}/guestbook-admin/seed \\\n` +
      `            -H "Authorization: Bearer $(cat working/guestbook-admin-key.txt)" \\\n` +
      `            --data-binary @${live}\n`)
  }
} else {
  console.log('(--no-daemon: skipped seeding; run the seed PUT to go live)')
}

console.log(
  seeded
    ? '✓ epoch rolled, published, and seeded — live now; old room orphaned'
    : 'epoch rolled + published — old room orphaned, but DAEMON NOT SEEDED (see above)')
