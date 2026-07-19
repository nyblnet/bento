#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// Keep the LIVE guestbook daemon on the current shell.
//
// bento.page/guestbook.bento.html is served by the Cloudflare daemon from its
// KV store (server/guestbook-daemon), NOT from GitHub Pages. release.mjs
// re-shells the *static* site/guestbook.bento.html (the KV-empty fallback), but
// the daemon keeps serving whatever deck sits in KV — so after a shell release
// the served guestbook stays on the OLD runtime until the daemon is re-seeded.
//
// This script closes that gap: it fetches the daemon's OWN current deck (so the
// live room + walls are preserved — the walls live in the relay room, the KV
// deck only carries the shell + creds), re-shells that doc onto the freshly
// built shell, and PUTs it back to /guestbook-admin/seed. Idempotent: if the
// daemon already serves the fresh shell it does nothing.
//
//   node scripts/reseed-guestbook.mjs [--shell <file>] [--base <url>] [--dry]
//
//   --shell   the fresh shell to re-shell onto
//             (default: site/releases/slides/Bento_Slides.bento.html,
//              then slides/dist-single/Bento_Slides.bento.html)
//   --base    daemon origin (default https://bento.page)
//   --dry     report what would change; don't seed.
//
// Auth: the Bearer key in working/guestbook-admin-key.txt (gitignored). Absent
// key or unreachable daemon is a WARNING, not an error — callers (publish-site)
// treat guestbook re-seeding as best-effort.

import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spliceDoc, extractDoc } from './guestbook-deck.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const dry = args.includes('--dry')

const warn = (m) => { console.warn(`⚠ guestbook re-seed skipped: ${m}`) }

// App payload fingerprint — the deflate-b64 runtime blocks. Two decks with the
// same hash embed the same shell (identical runtime), whatever their doc holds.
const appHash = (html) => {
  const blocks = [...html.matchAll(/type="bento\/deflate-b64"[^>]*>([A-Za-z0-9+/=]+)</g)].map((m) => m[1])
  return blocks.length ? createHash('sha256').update(blocks.join('')).digest('hex') : null
}

const shellFile = opt('shell', null) ?? [
  join(root, 'site/releases/slides/Bento_Slides.bento.html'),
  join(root, 'slides/dist-single/Bento_Slides.bento.html'),
].find(existsSync)
if (!shellFile || !existsSync(shellFile)) { warn('no fresh shell found (run a build/release first)'); process.exit(0) }

const keyFile = join(root, 'working/guestbook-admin-key.txt')
if (!existsSync(keyFile)) { warn(`no admin key at ${keyFile.slice(root.length + 1)}`); process.exit(0) }
const adminKey = readFileSync(keyFile, 'utf8').trim()
if (!adminKey) { warn('admin key file is empty'); process.exit(0) }

const base = (opt('base', 'https://bento.page')).replace(/\/$/, '')
const freshShell = readFileSync(shellFile, 'utf8')
const freshHash = appHash(freshShell)

try {
  // 1 · the daemon's OWN current deck (carries the live room creds + walls seed)
  const curResp = await fetch(`${base}/guestbook.bento.html`, { headers: { 'cache-control': 'no-cache' } })
  if (!curResp.ok) { warn(`daemon GET returned ${curResp.status}`); process.exit(0) }
  const curHtml = await curResp.text()
  const curHash = appHash(curHtml)

  if (curHash && curHash === freshHash) {
    console.log(`✓ guestbook daemon already on the current shell (${freshHash.slice(0, 12)}…) — nothing to do`)
    process.exit(0)
  }

  // 2 · re-shell the daemon's doc onto the fresh shell (SAME room, SAME walls)
  const doc = extractDoc(curHtml)
  const reshelled = spliceDoc(freshShell, doc)
  const room = doc.collab?.room?.split('/').pop() ?? '?'
  console.log(`• guestbook daemon on ${curHash?.slice(0, 12) ?? '?'}… → re-shelling to ${freshHash.slice(0, 12)}… (room ${room}, epoch ${doc.guestbookEpoch ?? '?'})`)
  if (dry) { console.log('(dry run — not seeding)'); process.exit(0) }

  // 3 · seed it back (walls untouched: they live in the relay, not this deck)
  const put = await fetch(`${base}/guestbook-admin/seed`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${adminKey}`, 'content-type': 'text/html' },
    body: reshelled,
  })
  const bodyText = await put.text()
  if (!put.ok) { warn(`seed PUT returned ${put.status}: ${bodyText.slice(0, 200)}`); process.exit(0) }
  console.log(`✓ guestbook daemon re-seeded onto the current shell — ${bodyText.replace(/\s+/g, ' ').trim()}`)
} catch (e) {
  warn(String(e))
  process.exit(0)
}
