#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Sign bento/home's status manifest, releases/home/status.json: the kill
// switch. Every load of the library (home/web) fetches it and stops, removing
// its worker and caches, if its own build is listed as withdrawn.
//
//   node scripts/sign-home-status.mjs --withdraw <build> [--withdraw <build>…]
//     [--from releases/home/status.json] [--seq N] [--key ~/.bento/release-key.json]
//     [--out status.json]
//
// <build> is the hex sha256 of the library's script, which home/web/build.mjs
// prints ("home/web: build …") and writes to build.json (offline.build).
//
// --from keeps every build an earlier status withdrew and takes its seq + 1.
// A withdrawal is never undone by leaving it out: start from the published
// file. seq must only grow: a browser that has seen seq N refuses any status
// with a smaller one (a replayed older status cannot un-withdraw a build).
//
// Same envelope, key and signing code as every release artifact
// (scripts/sign-payload.mjs). The payload's `app` is bento-home-status, so no
// other signed artifact can be served in its place.

import { readFileSync, writeFileSync } from 'node:fs'
import { defaultKeyPath, envelopeJson, signPayload } from './sign-payload.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.lastIndexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback }
const many = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []))
const die = (m) => { console.error(`sign-home-status: ${m}`); process.exit(2) }

const withdrawn = new Set()
let seq = 0
const from = opt('from')
if (from) {
  const prev = JSON.parse(JSON.parse(readFileSync(from, 'utf8')).payload)
  if (prev.app !== 'bento-home-status' || !Number.isSafeInteger(prev.seq) || !Array.isArray(prev.withdrawn)) die(`${from} is not a bento/home status`)
  for (const b of prev.withdrawn) withdrawn.add(b)
  seq = prev.seq + 1
}
for (const b of many('withdraw')) {
  if (!/^[0-9a-f]{64}$/.test(b ?? '')) die(`--withdraw takes a build id (64 hex characters): ${b}`)
  withdrawn.add(b)
}
if (opt('seq') !== undefined) {
  const n = Number(opt('seq'))
  if (!Number.isSafeInteger(n) || n < 1) die('--seq must be a positive integer')
  if (n < seq) die(`--seq ${n} is older than ${from}'s (${seq - 1})`)
  seq = n
}
if (seq < 1) seq = 1

const payload = JSON.stringify({ app: 'bento-home-status', seq, at: new Date().toISOString(), withdrawn: [...withdrawn].sort() })
const text = envelopeJson(signPayload(payload, opt('key', defaultKeyPath())))
const out = opt('out')
if (out) writeFileSync(out, text)
else process.stdout.write(text)
console.error(`sign-home-status: seq ${seq}, ${withdrawn.size} withdrawn build${withdrawn.size === 1 ? '' : 's'}`)
