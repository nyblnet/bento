#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Sign bento/home's status manifest, releases/home/status.json: the kill
// switch. Every load of the library (home/web) fetches it and stops, removing
// its worker and caches, if its own build is listed as withdrawn.
//
//   node scripts/sign-home-status.mjs --served releases/home-web/served.json
//     --withdraw <build> [--withdraw <build>…]
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
// --served is the bento/home release list as published (the tripwire's list,
// scripts/sign-home-web-served.mjs). It is the ONE source of what is
// withdrawn: the two lists name a release differently (served.json by its
// `at`, the status by its build id), so this tool ties them and refuses
// (exit 2, nothing written) when they disagree:
//   - a release the list marks withdrawn whose build id the status leaves out;
//   - a status that withdraws a build the list still serves as current (its
//     newest release): publish the list naming the new release, and deploy,
//     first;
//   - a status that withdraws a build the list carries but does not mark
//     withdrawn: withdraw it in the list first (sign-home-web-served.mjs
//     --withdraw <its at>).
// A build the list no longer carries (an old one that fell off) may still be
// withdrawn. A release's build id is the sha256 of the library page's one
// inline script: `scripts[0].sha256` of the library origin's `/` entry, the
// same number build.json carries as offline.build.
// The list's signature is verified first, against the release key, or, when
// --key is not the release key (a rig or a rehearsal), against that key's own
// public half. Signing with the release key REQUIRES --served.
//
// Publish order, every release (home/web/README.md):
//   1. sign and publish served.json naming the new release;
//   2. deploy the library;
//   3. sign and publish the status that withdraws the old build (with the
//      list from step 1 as --served, the old release withdrawn in it).
// A status published before the deploy stops every tab of a build the host
// still serves: it fails closed, but it is loud for nothing.
//
// Same envelope, key and signing code as every release artifact
// (scripts/sign-payload.mjs). The payload's `app` is bento-home-status, so no
// other signed artifact can be served in its place.

import { readFileSync, writeFileSync } from 'node:fs'
import { defaultKeyPath, envelopeJson, releasePublicKey, signPayload, verifyEnvelope } from './sign-payload.mjs'
import { SERVED_TYPE, SERVED_V } from './lib/home-web-served.mjs'

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

// --- the one withdrawal source: the release list --------------------------------
const keyPath = opt('key', defaultKeyPath())
const keyFile = JSON.parse(readFileSync(keyPath, 'utf8'))
const rk = releasePublicKey()
const isRelease = ['kty', 'crv', 'x', 'y'].every((k) => keyFile.public?.[k] === rk[k])
const servedPath = opt('served')
if (args.includes('--served') && !servedPath) die('--served is missing its value')
if (isRelease && !servedPath) die('--served <the published releases/home-web/served.json> is required with the release key: it is the one source of what is withdrawn')
if (servedPath) {
  let list
  try { list = verifyEnvelope(readFileSync(servedPath, 'utf8'), isRelease ? rk : keyFile.public) } catch (e) { die(`${servedPath}: ${e.message}`) }
  if (list?.type !== SERVED_TYPE || list.v !== SERVED_V || !Array.isArray(list.releases) || !list.releases.length) die(`${servedPath} is not a v${SERVED_V} bento/home release list`)
  const buildOf = (r) => {
    const lib = Object.values(r.origins ?? {}).filter((o) => o?.role === 'library')
    const scripts = lib.length === 1 ? lib[0].files?.['/']?.scripts : null
    const id = Array.isArray(scripts) && scripts.length === 1 ? scripts[0]?.sha256 : null
    if (!/^[0-9a-f]{64}$/.test(id ?? '')) die(`${servedPath}: the release signed at ${r.at} has no build id (one library origin whose / carries exactly one inline script)`)
    return id
  }
  const missing = [], current = [], unmarked = []
  list.releases.forEach((r, i) => {
    const id = buildOf(r)
    if (r.withdrawn === true && !withdrawn.has(id)) missing.push(`${id} (the release signed at ${r.at})`)
    if (r.withdrawn !== true && withdrawn.has(id)) (i === 0 ? current : unmarked).push(`${id} (the release signed at ${r.at})`)
  })
  if (missing.length) die(`the release list withdraws ${missing.length === 1 ? 'a release' : 'releases'} this status does not: ${missing.join(', ')}. Pass --withdraw for each.`)
  if (current.length) die(`this status withdraws the build the release list serves as current: ${current.join(', ')}. Sign and publish the list naming the new release, and deploy it, first.`)
  if (unmarked.length) die(`this status withdraws ${unmarked.length === 1 ? 'a build' : 'builds'} the release list carries but does not withdraw: ${unmarked.join(', ')}. Withdraw it in the list first (sign-home-web-served.mjs --withdraw <its at>).`)
}

const payload = JSON.stringify({ app: 'bento-home-status', seq, at: new Date().toISOString(), withdrawn: [...withdrawn].sort() })
const text = envelopeJson(signPayload(payload, keyPath))
const out = opt('out')
if (out) writeFileSync(out, text)
else process.stdout.write(text)
console.error(`sign-home-status: seq ${seq}, ${withdrawn.size} withdrawn build${withdrawn.size === 1 ? '' : 's'}`)
