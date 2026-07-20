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

// v2 room (fine-grained): the room commits to an OWNER key (moderation — the
// owner can remove a vandal's device key from the People panel), and the PUBLIC
// deck carries an owner-signed INVITE so anyone who opens it can write. The
// owner's private key never enters the public file — it lands in a separate
// gitignored owner deck next to the admin token. Rolls are MANUAL now
// (daemon ROLL_HOURS=0): a re-mint would invalidate the held owner file.
const EC = { name: 'ECDSA', namedCurve: 'P-256' }
const SIG = { name: 'ECDSA', hash: 'SHA-256' }
const keypair = async () => {
  const kp = await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])
  return {
    pub: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))),
    priv: b64u(new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))),
    key: kp.privateKey,
  }
}
const ownerKp = await keypair()
const inviteKp = await keypair()
const inviteSig = b64u(new Uint8Array(await crypto.subtle.sign(
  SIG, ownerKp.key, new TextEncoder().encode(`inv.${inviteKp.pub}.writer.0`))))
const commit = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', Buffer.from(ownerKp.pub, 'base64url'))))
const readKey = b64u(rnd(32))
const collab = {
  room: `${host}/d/w${commit}`, key: readKey, on: true, v: 2, owner: ownerKp.pub,
  invite: { pub: inviteKp.pub, priv: inviteKp.priv, role: 'writer', sig: inviteSig },
}
const ownerCollab = { room: collab.room, key: readKey, on: true, v: 2, owner: ownerKp.pub, ownerPriv: ownerKp.priv }

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

// the OWNER deck: same document, owner credentials — open THIS file to
// moderate (People panel → Remove). Keep it with the admin token; never public.
const ownerOut = join(dirname(out), 'guestbook-owner.bento.html')
writeFileSync(ownerOut, spliceDoc(shell, { ...doc, collab: ownerCollab }))
writeFileSync(join(dirname(out), 'guestbook-owner-keys.json'),
  JSON.stringify({ epoch, room: collab.room, key: readKey, owner: ownerKp.pub, ownerPriv: ownerKp.priv, invitePub: inviteKp.pub }, null, 2))

console.log(`guestbook epoch ${epoch} → ${out} (${Math.round(spliced.length / 1024)} KB)`)
console.log(`owner deck    → ${ownerOut}`)
console.log(`room: ${collab.room} (v2, owner-moderated)`)
console.log('note: the Cloudflare daemon (server/guestbook-daemon) is authoritative once seeded —')
console.log('      seed it via PUT /guestbook-admin/seed after building locally')
