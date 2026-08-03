#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Build and sign the LANGUAGE PACK INDEX — releases/slides/packs.json.
//
//   node scripts/sign-packs.mjs <packs-dir> [--out packs.json]
//     [--version 1.0.11] [--url-base packs] [--key ~/.bento/release-key.json]
//     [--dry]
//
// The index is `{ payload: "<json string>", sig: "<base64>" }` — the SAME
// envelope, the same offline key and the same signing code as the update
// manifest (scripts/sign-payload.mjs). The shell already verifies that shape.
//
// WHY THE INDEX IS SIGNED AND THE PACKS ARE NOT. A pack is a bag of UI
// strings, so a forged one is not code execution — but it is a lie shown in
// the user's own interface ("Anyone can edit this deck" where the app said the
// opposite), which is quite bad enough. Signing each pack separately would
// mean N signatures to verify, N chances to get an edge case wrong, and a
// forged pack could still be swapped in by omitting it from an unsigned list.
// So: ONE signature over the whole index, and every listing PINS its pack's
// sha256. The client verifies the index once, then hashes each download
// against its signed hash — exactly the two-step the shell already performs
// for its own update (manifest signature, then shell hash). Adding a pack, or
// changing one byte of one, changes the index and needs the offline key.
//
// WHY A SEPARATE ARTIFACT FROM manifest.json. Packs are published on their own
// clock: a corrected translation is not a new app version, and shipped files
// refuse a manifest that is not strictly NEWER than themselves (downgrade-
// replay protection). Pack hashes carried in the manifest could therefore
// never be updated BETWEEN releases — the correction would be invisible to
// every file already on the current version. A separate signed index is
// re-issuable at any time, and the manifest keeps meaning exactly one thing:
// "here is the app shell".
//
// The private key never leaves the maintainer's machine; there is no CI
// signing step (docs/RELEASING.md).

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultKeyPath, envelopeJson, haveKey, releasePublicKey, signPayload, verifyEnvelope } from './sign-payload.mjs'

/** The app id in the SIGNED INDEX — same value the update manifest uses. */
const INDEX_APP = 'bento-slides'
/** The app id inside a PACK file, as build-i18n.mjs writes it. */
const PACK_APP = 'slides'

/**
 * Read a directory of *.pack.json and describe each one for the index.
 * Hex sha256 is lowercase — the client compares it lowercased, and a mixed
 * case index would fail with a message no user could act on.
 */
export function listPacks(packsDir, { urlBase = 'packs' } = {}) {
  const files = readdirSync(packsDir).filter((f) => f.endsWith('.pack.json')).sort()
  const packs = []
  const seen = new Map()
  for (const name of files) {
    const bytes = readFileSync(join(packsDir, name))
    let pack
    try {
      pack = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new Error(`${name} is not valid JSON — refusing to index it`)
    }
    if (pack.app && pack.app !== PACK_APP) throw new Error(`${name} is for app "${pack.app}", not "${PACK_APP}"`)
    if (!pack.lang || !pack.label) throw new Error(`${name} is missing lang and/or label`)
    if (!pack.strings || typeof pack.strings !== 'object') throw new Error(`${name} has no strings`)
    if (seen.has(pack.lang)) throw new Error(`two packs claim "${pack.lang}": ${seen.get(pack.lang)} and ${name}`)
    seen.set(pack.lang, name)
    packs.push({
      lang: pack.lang,
      label: pack.label,
      version: pack.version,
      // RELATIVE to the channel by default. The client resolves a relative url
      // against channel(), so a local channel (localStorage 'bento-packs-url')
      // serves its OWN packs instead of silently reaching back to bento.page —
      // and the whole tree can be mirrored to another host unchanged. Pass
      // --url-base <absolute> if a release ever needs absolute urls; the
      // signed sha256 is what pins the bytes either way.
      url: `${urlBase.replace(/\/$/, '')}/${name}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      strings: Object.keys(pack.strings).length,
    })
  }
  return packs.sort((a, b) => a.lang.localeCompare(b.lang))
}

/** The exact string that gets signed. Deterministic given the same packs. */
export const indexPayload = (packs, version) =>
  JSON.stringify({
    app: INDEX_APP,
    version,
    packs: packs.map(({ strings, ...listing }) => listing), // `strings` is a build stat, not a contract
    at: new Date().toISOString(),
  })

/**
 * GATE — an index must describe the packs actually sitting beside it.
 * Called by publish-site.mjs before anything is pushed: signed bytes are
 * served bytes, and that has to hold for the index too, not just the shell.
 */
export function gatePackIndex(indexPath, packsDir, publicJwk = releasePublicKey()) {
  const payload = verifyEnvelope(readFileSync(indexPath, 'utf8'), publicJwk)
  if (payload.app !== INDEX_APP) throw new Error(`GATE: pack index is for "${payload.app}"`)
  if (!Array.isArray(payload.packs)) throw new Error('GATE: pack index has no packs array')
  for (const listing of payload.packs) {
    const file = join(packsDir, basename(listing.url))
    if (!existsSync(file)) throw new Error(`GATE: ${listing.lang} is indexed but ${basename(listing.url)} is not published`)
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
    if (actual !== listing.sha256) throw new Error(`GATE: ${basename(listing.url)} does not match its SIGNED hash — re-sign before publishing`)
  }
  const indexed = new Set(payload.packs.map((p) => basename(p.url)))
  const orphans = readdirSync(packsDir).filter((f) => f.endsWith('.pack.json') && !indexed.has(f))
  if (orphans.length) throw new Error(`GATE: pack file(s) published but NOT in the signed index: ${orphans.join(', ')}`)
  console.log(`pack index gate: ${payload.packs.length} pack(s) signed and matching ✓`)
  return payload
}

// ---- CLI -------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback
  }
  const packsDir = args.find((a) => !a.startsWith('--'))
  if (!packsDir) {
    console.error('usage: node scripts/sign-packs.mjs <packs-dir> [--out packs.json] [--version V] [--url-base B] [--key K] [--dry]')
    process.exit(2)
  }
  const dry = args.includes('--dry')
  const outPath = opt('out', join(packsDir, '..', 'packs.json'))
  const keyPath = opt('key', defaultKeyPath())

  if (!existsSync(packsDir)) {
    // Not an error: a release before any pack language exists simply has no
    // index, and the client treats a missing index as "nothing on offer".
    console.log(`no packs at ${packsDir} — no index written`)
    process.exit(0)
  }

  const packs = listPacks(packsDir, { urlBase: opt('url-base', 'packs') })
  if (!packs.length) {
    console.log(`no *.pack.json in ${packsDir} — no index written`)
    process.exit(0)
  }
  const version = opt('version', packs[0].version ?? '0.0.0')
  const payload = indexPayload(packs, version)

  const total = packs.reduce((n, p) => n + p.bytes, 0)
  console.log(`${dry ? 'DRY RUN — ' : ''}pack index v${version}: ${packs.length} pack(s), ${(total / 1024).toFixed(0)} KB`)
  for (const p of packs)
    console.log(`  ${p.lang.padEnd(8)} ${p.label.padEnd(12)} ${String(p.strings).padStart(4)} strings  ${(p.bytes / 1024).toFixed(0).padStart(3)} KB  ${p.sha256.slice(0, 16)}…  ${p.url}`)

  if (dry) {
    console.log(`\npayload (${Buffer.byteLength(payload)} B, this is the exact string that gets signed):\n${payload}`)
    console.log(haveKey(keyPath)
      ? `\nwould sign with the offline key and write ${outPath} — nothing written (--dry)`
      : `\nno signing key at ${keyPath} — nothing written (--dry). Releases are signed on the maintainer's machine only.`)
    process.exit(0)
  }

  writeFileSync(outPath, envelopeJson(signPayload(payload, keyPath)))
  console.log(`  out     ${outPath}`)
}
