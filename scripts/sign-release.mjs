#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Sign a bento/slides release: produce the manifest.json that shipped files
// poll (on user request only) to learn about updates.
//
//   node scripts/sign-release.mjs slides/dist-single/Bento_Slides.bento.html \
//     [--url https://bento.page/releases/slides/Bento_Slides.bento.html] \
//     [--version 0.2.0] [--notes "What changed"] [--notes-from '{"1.0.13":[…]}'] [--key ~/.bento/release-key.json] \
//     [--out manifest.json]
//
// The manifest is { payload: "<json string>", sig: "<base64>" } — the
// signature covers the exact payload string bytes (no canonicalization
// games), ECDSA P-256 / SHA-256 in IEEE P1363 form so browsers can verify
// it with WebCrypto. The payload carries the shell's sha256, so the shipped
// app verifies BOTH the manifest signature and the downloaded shell hash.
// Version defaults to slides/package.json — keep them in lockstep.
//
// LANGUAGE PACKS are NOT listed here. They are published on their own clock
// (a corrected translation is not a new app version, and shipped files ignore
// a manifest that isn't strictly newer than themselves — so a hash carried
// here could never be corrected between releases). They get their own signed
// index, same envelope and same key: scripts/sign-packs.mjs.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultKeyPath, envelopeJson, signPayload } from './sign-payload.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const args = process.argv.slice(2)
const shellPath = args.find((a) => !a.startsWith('--'))
if (!shellPath) {
  console.error('Usage: node scripts/sign-release.mjs <shell.html> [--app A] [--url U] [--version V] [--notes N] [--key K] [--out O]')
  process.exit(1)
}
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

// The app this manifest is FOR. A shipped shell rejects a manifest signed for
// another app even though the signing key is shared platform-wide
// (kernel/src/update.ts checks it against appConfig().appId), so getting this
// wrong ships an update channel that every file silently refuses.
const app = opt('app', 'bento-slides')
const version = opt('version', JSON.parse(readFileSync(join(root, 'slides/package.json'), 'utf8')).version)
// Kept as the slides URL rather than derived from `app`: release.mjs passes
// --url explicitly for every app, so a derivation here would be untested
// cleverness on the one field a shipped file uses to FETCH its own update.
const url = opt('url', 'https://bento.page/releases/slides/Bento_Slides.bento.html')
const notes = opt('notes', '')
// Per-version lead-ins, so a client can show exactly the versions it skipped.
// ADDITIVE: `notes` stays a plain string for every already-shipped file, whose
// update code is frozen and reads only that.
const notesFromRaw = opt('notes-from', '')
let notesFrom = null
if (notesFromRaw) {
  try { notesFrom = JSON.parse(notesFromRaw) }
  catch { console.error('sign-release: --notes-from is not valid JSON'); process.exit(1) }
}
const keyPath = opt('key', defaultKeyPath())
const outPath = opt('out', join(dirname(shellPath), 'manifest.json'))

const shell = readFileSync(shellPath)
const sha256 = createHash('sha256').update(shell).digest('hex')

const payload = JSON.stringify({
  app,
  version,
  sha256,
  url,
  ...(notes ? { notes } : {}),
  ...(notesFrom ? { notesFrom } : {}),
  at: new Date().toISOString(),
})

// Signing (and its self-check against the public half) lives in
// scripts/sign-payload.mjs — shared verbatim with the pack index, so the two
// signed artifacts can never drift apart in how they are constructed.
let envelope
try {
  envelope = signPayload(payload, keyPath)
} catch (err) {
  console.error(`Signing failed — manifest NOT written: ${err.message}`)
  process.exit(1)
}

writeFileSync(outPath, envelopeJson(envelope))
console.log(`Signed release v${version}`)
console.log(`  shell   ${shellPath} (${(shell.length / 1024).toFixed(0)} KB, sha256 ${sha256.slice(0, 16)}…)`)
console.log(`  url     ${url}`)
console.log(`  out     ${outPath}`)
