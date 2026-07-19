#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// U2: the public guestbook deck — one live-collab file anyone can open and
// sign. Minting fresh credentials IS the reset mechanism ("epochs, not
// moderation" — see working/guestbook-design.md). The deck definition lives
// in scripts/guestbook-deck.mjs, shared with the Cloudflare daemon
// (server/guestbook-daemon/) which is the SUSTAINABLE home of rolls and
// snapshots — this local builder remains for seeding and as a fallback.
//
//   node scripts/build-guestbook.mjs [--host wss://sync.bento.page] [--out <file>]
//
// If the out file exists it is archived to working/guestbook-epochs/ and the
// new build gets epoch N+1 with FRESH room + key.

import { webcrypto as crypto } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGuestbookDoc, spliceDoc } from './guestbook-deck.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const host = opt('host', 'wss://sync.bento.page')
const out = opt('out', join(root, 'working/guestbook-live/guestbook.bento.html'))

const shell = readFileSync(join(root, 'slides/dist-single/Bento_Slides.bento.html'), 'utf8')
const fontSrc = readFileSync(join(root, 'slides/src/fontdata.ts'), 'utf8')
const font = (n) => fontSrc.match(new RegExp(`export const ${n}\\s*=\\s*'(data:[^']+)'`))[1]

const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const rnd = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b }
const collab = { room: `${host}/d/r${b64u(rnd(12))}`, key: b64u(rnd(32)), on: true }

let epoch = 1
if (existsSync(out)) {
  const prev = readFileSync(out, 'utf8')
  const m = prev.match(/"guestbookEpoch":(\d+)/)
  epoch = m ? Number(m[1]) + 1 : 2
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const archiveDir = join(root, 'working/guestbook-epochs')
  mkdirSync(archiveDir, { recursive: true })
  copyFileSync(out, join(archiveDir, `epoch-${epoch - 1}-${stamp}.bento.html`))
  console.log(`archived epoch ${epoch - 1} → working/guestbook-epochs/`)
}

const doc = buildGuestbookDoc({
  epoch, docId: crypto.randomUUID(), collab,
  fonts: { fraunces: font('FRAUNCES_900'), instrument: font('INSTRUMENT_VAR') },
})

const spliced = spliceDoc(shell, doc)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, spliced)
console.log(`guestbook epoch ${epoch} → ${out} (${Math.round(spliced.length / 1024)} KB)`)
console.log(`room: ${collab.room}`)
console.log('note: the Cloudflare daemon (server/guestbook-daemon) is authoritative once seeded —')
console.log('      seed it via PUT /guestbook-admin/seed after building locally')
