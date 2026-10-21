#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Sign an app's release HISTORY (K4): the held history plus this release.
//
//   node scripts/sign-history.mjs --app bento-slides --version 1.2.10 \
//     --shell site/releases/slides/Bento_Slides.bento.html --pins pins.json \
//     [--held site/releases/slides/history.json] [--seed entries.json] \
//     [--key ~/.bento/release-key.json] --out site/releases/slides/history.json
//
// --held is the history currently published. Its signature is VERIFIED against
// the release public key before anything is built on it, so a tampered held
// file can't be laundered into a fresh signature. --seed takes the unsigned
// entries backfill-history.mjs produced, for the FIRST history only.
//
// The history only grows (scripts/lib/release-history.mjs nextHistory): a
// release that isn't newer than everything held is refused, as is a changed
// entry for a version already held. Signing uses the same offline key and
// envelope as the manifest (scripts/sign-payload.mjs), and like the manifest
// it is signed ONLY on the maintainer's machine, on an explicit release go.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { defaultKeyPath, envelopeJson, releasePublicKey, signPayload, verifyEnvelope } from './sign-payload.mjs'
import { nextHistory, historyProblems, cmpVersion, HISTORY_V } from './lib/release-history.mjs'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const need = (name) => { const v = opt(name); if (!v) { console.error(`sign-history: --${name} is required`); process.exit(2) } return v }

const app = need('app'), version = need('version'), shellPath = need('shell'), pinsPath = need('pins'), out = need('out')
const heldPath = opt('held'), seedPath = opt('seed'), keyPath = opt('key') ?? defaultKeyPath()
const publicJwk = opt('public') ? JSON.parse(readFileSync(opt('public'), 'utf8')) : releasePublicKey()

let held = null
if (heldPath && existsSync(heldPath)) {
  held = verifyEnvelope(readFileSync(heldPath, 'utf8'), publicJwk) // throws on a bad signature
  const problems = historyProblems(held)
  if (problems.length) { console.error(`sign-history: the held history is malformed: ${problems.join('; ')}`); process.exit(1) }
} else if (seedPath) {
  const entries = JSON.parse(readFileSync(seedPath, 'utf8'))
  entries.sort((a, b) => cmpVersion(b.version, a.version))
  held = { app, v: HISTORY_V, releases: entries }
  const problems = historyProblems(held)
  if (problems.length) { console.error(`sign-history: the seed is malformed: ${problems.join('; ')}`); process.exit(1) }
}

const shell = readFileSync(shellPath)
const entry = {
  version,
  sha256: createHash('sha256').update(shell).digest('hex'),
  at: new Date().toISOString(),
  pins: JSON.parse(readFileSync(pinsPath, 'utf8')),
}

let history
try {
  history = nextHistory(app, held, entry)
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
// signPayload self-verifies against the key file's own public half, as the
// manifest's signing does. The HELD history was verified against the shipped
// release key above, which is the check that guards against laundering.
const envelope = signPayload(JSON.stringify(history), keyPath)
writeFileSync(out, envelopeJson(envelope))
console.log(`Signed ${app} history: ${history.releases.length} release(s), newest ${history.releases[0].version} → ${out}`)
