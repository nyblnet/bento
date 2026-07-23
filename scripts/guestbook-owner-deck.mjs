#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// Build an OWNER deck for the CURRENT live guestbook epoch, on demand — open it
// to moderate (People panel → Remove). The daemon mints epochs server-side and
// stashes the owner key in KV; this fetches it (admin-gated) and splices it into
// the live public deck.
//
// LAUNCH NOTE: with the daemon auto-rolling every 15 min, an owner deck is valid
// only until the next roll — after that the room it moderates is orphaned. Just
// re-run this to get a deck for the new epoch. (At that cadence spam auto-clears
// anyway, so you rarely need this.)
//
//   node scripts/guestbook-owner-deck.mjs [--base <url>] [--out <file>]
//
// Auth: Bearer key in working/guestbook-admin-key.txt (gitignored).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractDoc, spliceDoc } from './guestbook-deck.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const opt = (n, fb) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : fb }
const base = opt('base', 'https://bento.page').replace(/\/$/, '')
const out = opt('out', join(root, 'working/guestbook-live/guestbook-owner-live.bento.html'))

const keyFile = join(root, 'working/guestbook-admin-key.txt')
if (!existsSync(keyFile)) { console.error('no admin key at working/guestbook-admin-key.txt'); process.exit(1) }
const adminKey = readFileSync(keyFile, 'utf8').trim()

// Owner creds and the public deck are two fetches; if a roll lands between them
// the rooms won't match — retry a few times.
async function attempt() {
  const credRes = await fetch(`${base}/guestbook-admin/owner`, { headers: { Authorization: `Bearer ${adminKey}` } })
  if (!credRes.ok) throw new Error(`owner creds → ${credRes.status}: ${(await credRes.text()).slice(0, 200)}`)
  const creds = await credRes.json()
  const publicHtml = await (await fetch(`${base}/guestbook.bento.html?cb=${Date.now()}`, { cache: 'no-store' })).text()
  const doc = extractDoc(publicHtml)
  if (doc.collab?.room !== creds.room) return null // rolled between the two fetches
  // owner collab: same room + read key, carrying ownerPriv; no public invite
  doc.collab = { room: creds.room, key: creds.key, on: true, v: 2, owner: creds.owner, ownerPriv: creds.ownerPriv }
  return { html: spliceDoc(publicHtml, doc), epoch: creds.epoch, room: creds.room }
}

let built = null
for (let i = 0; i < 4 && !built; i++) built = await attempt()
if (!built) { console.error('the epoch kept rolling mid-build — run it again'); process.exit(2) }

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, built.html)
console.log(`✓ owner deck for epoch ${built.epoch} → ${out}`)
console.log(`  room: …${built.room.slice(-16)}`)
console.log('  open it in Chrome → People panel → Remove. Valid ONLY until the next 15-min roll.')
