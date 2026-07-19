#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// Sign a Bento Slides release: produce the manifest.json that shipped files
// poll (on user request only) to learn about updates.
//
//   node scripts/sign-release.mjs slides/dist-single/Bento_Slides.bento.html \
//     [--url https://bento.page/releases/slides/Bento_Slides.bento.html] \
//     [--version 0.2.0] [--notes "What changed"] [--key ~/.bento/release-key.json] \
//     [--out manifest.json]
//
// The manifest is { payload: "<json string>", sig: "<base64>" } — the
// signature covers the exact payload string bytes (no canonicalization
// games), ECDSA P-256 / SHA-256 in IEEE P1363 form so browsers can verify
// it with WebCrypto. The payload carries the shell's sha256, so the shipped
// app verifies BOTH the manifest signature and the downloaded shell hash.
// Version defaults to slides/package.json — keep them in lockstep.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const args = process.argv.slice(2)
const shellPath = args.find((a) => !a.startsWith('--'))
if (!shellPath) {
  console.error('Usage: node scripts/sign-release.mjs <shell.html> [--url U] [--version V] [--notes N] [--key K] [--out O]')
  process.exit(1)
}
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const version = opt('version', JSON.parse(readFileSync(join(root, 'slides/package.json'), 'utf8')).version)
const url = opt('url', 'https://bento.page/releases/slides/Bento_Slides.bento.html')
const notes = opt('notes', '')
const keyPath = opt('key', join(homedir(), '.bento', 'release-key.json'))
const outPath = opt('out', join(dirname(shellPath), 'manifest.json'))

const shell = readFileSync(shellPath)
const sha256 = createHash('sha256').update(shell).digest('hex')

const payload = JSON.stringify({
  app: 'bento-slides',
  version,
  sha256,
  url,
  ...(notes ? { notes } : {}),
  at: new Date().toISOString(),
})

const keyFile = JSON.parse(readFileSync(keyPath, 'utf8'))
const privateKey = createPrivateKey({ key: keyFile.private, format: 'jwk' })
const sig = sign('sha256', Buffer.from(payload, 'utf8'), {
  key: privateKey,
  dsaEncoding: 'ieee-p1363', // WebCrypto's raw r||s format
})

// Self-check against the public half before writing anything.
const publicKey = createPublicKey({ key: keyFile.public, format: 'jwk' })
if (!verify('sha256', Buffer.from(payload, 'utf8'), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig)) {
  console.error('Self-verification failed — manifest NOT written.')
  process.exit(1)
}

writeFileSync(outPath, JSON.stringify({ payload, sig: sig.toString('base64') }, null, 2) + '\n')
console.log(`Signed release v${version}`)
console.log(`  shell   ${shellPath} (${(shell.length / 1024).toFixed(0)} KB, sha256 ${sha256.slice(0, 16)}…)`)
console.log(`  url     ${url}`)
console.log(`  out     ${outPath}`)
