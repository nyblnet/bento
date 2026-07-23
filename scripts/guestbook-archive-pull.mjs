#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// Pull the daemon's KV archives down to disk so nothing is lost to the 90-cap.
//
// The daemon prunes KV `archives/` to the newest 90. At the launch 15-min roll
// cadence that's only ~11h of history, so signatures older than that would be
// pruned before anyone saw them. This mirrors every archive into
// working/guestbook-archives/ (idempotent — skips ones already on disk), so a
// periodic run (cron every ~30 min) captures the full launch permanently.
//
//   node scripts/guestbook-archive-pull.mjs [--base <url>]
//
// Auth: Bearer key in working/guestbook-admin-key.txt (gitignored).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const opt = (n, fb) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : fb }
const base = opt('base', 'https://bento.page').replace(/\/$/, '')

const keyFile = join(root, 'working/guestbook-admin-key.txt')
if (!existsSync(keyFile)) { console.error('no admin key at working/guestbook-admin-key.txt'); process.exit(1) }
const adminKey = readFileSync(keyFile, 'utf8').trim()
const auth = { Authorization: `Bearer ${adminKey}` }

const outDir = join(root, 'working/guestbook-archives')
mkdirSync(outDir, { recursive: true })
const onDisk = new Set(readdirSync(outDir))

// 1 · list archives the daemon currently holds
const statusRes = await fetch(`${base}/guestbook-admin/status`, { headers: auth })
if (!statusRes.ok) { console.error(`status → ${statusRes.status}: ${(await statusRes.text()).slice(0, 200)}`); process.exit(1) }
const status = await statusRes.json()
const keys = status.archives ?? [] // e.g. ["archives/epoch-8-2026-07-22-19-15.bento.html", …]

// 2 · download any we don't already have
let pulled = 0
for (const key of keys) {
  const localName = key.replace(/^archives\//, '')
  if (onDisk.has(localName)) continue
  const res = await fetch(`${base}/guestbook-admin/${key}`, { headers: auth })
  if (!res.ok) { console.warn(`⚠ ${key} → ${res.status} (skipped)`); continue }
  writeFileSync(join(outDir, localName), Buffer.from(await res.arrayBuffer()))
  pulled++
}

const total = readdirSync(outDir).filter((f) => f.endsWith('.bento.html')).length
console.log(`archive pull: ${pulled} new · ${keys.length} on daemon · ${total} total on disk → working/guestbook-archives/`)
