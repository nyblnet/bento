#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Sign the bento/home release list for a home/web build: the list the
// extension's tripwire checks home.bento.page and the frame site against.
//
//   node scripts/sign-home-web-served.mjs --build <home/web out dir> \
//     --out <site>/releases/home-web/served.json \
//     (--held <published>/releases/home-web/served.json | --first) \
//     [--withdraw <release time>]... [--key ~/.bento/release-key.json]
//
// The list lives on the RELEASE CHANNEL (https://bento.page/releases/home-web/
// served.json), never on the site it describes, and is signed with the same
// offline key and envelope as the app manifests and histories
// (scripts/sign-payload.mjs). Publish it BEFORE deploying the library: until
// the deploy, the browsers see the previous release, which the list still
// holds; after a deploy with no list, every tripwire warns.
//
// --held is the list currently published, and must exist: starting over at
// serial 1 would be refused by every extension as a rollback, and the new
// deploy judged against the old list (a false alarm for everyone). Only the
// very first list passes --first instead. --withdraw marks an older release
// (named by its `at`) as withdrawn: serving it is then a loud mismatch.
// A release lists only https://home.bento.page as the library origin.
//
// --held is the list currently published. Its signature is VERIFIED against
// the release key before anything is built on it (the same rule as
// sign-history.mjs: a tampered held list is never laundered into a fresh
// signature). A development or test-key build is refused unless --dev, and
// --dev refuses the release key: rehearsals sign with a throwaway key.
//
// Like every release signature, this runs ONLY on the maintainer's machine,
// on an explicit release go. Rigs use throwaway keys.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultKeyPath, envelopeJson, releasePublicKey, signPayload, verifyEnvelope } from './sign-payload.mjs'
import { describeBuild, nextServed } from './lib/home-web-served.mjs'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.lastIndexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const die = (m) => { console.error(`sign-home-web-served: ${m}`); process.exit(2) }
const build = opt('build') ?? die('--build <home/web out dir> is required')
const out = opt('out') ?? die('--out <file> is required')
const keyPath = opt('key') ?? defaultKeyPath()
const dev = args.includes('--dev')
const first = args.includes('--first')
const withdraw = args.flatMap((a, i) => (a === '--withdraw' ? [args[i + 1]] : []))
if ([build, out, keyPath, ...(args.includes('--held') ? [opt('held')] : []), ...withdraw].some((v) => v == null || v.startsWith('--'))) die('an option is missing its value')
if (first === !!opt('held')) die('pass --held <the published list>, or --first for the very first list (exactly one of them)')
if (first && withdraw.length) die('--withdraw needs a held list')

const info = JSON.parse(readFileSync(join(build, 'build.json'), 'utf8'))
if (!dev && (info.dev || info.testKey || info.mutant)) die('the build is a development, test-key or mutant build: a release lists only a production build (rehearsals pass --dev)')
if (!dev && info.libraryOrigin !== 'https://home.bento.page') die(`the build's library origin is ${info.libraryOrigin}: a release lists only https://home.bento.page (rehearsals pass --dev)`)
const keyFile = JSON.parse(readFileSync(keyPath, 'utf8'))
const rk = releasePublicKey()
const isRelease = ['kty', 'crv', 'x', 'y'].every((k) => keyFile.public?.[k] === rk[k])
if (!dev && !isRelease) die('--key is not the release key (a rehearsal passes --dev)')
if (dev && isRelease) die('--dev signs with a throwaway key, never the release key')
const verifyWith = isRelease ? rk : keyFile.public

let held = null
const heldPath = opt('held')
if (heldPath) {
  if (!existsSync(heldPath)) die(`no list at ${heldPath}: a held list must exist (the very first list passes --first instead)`)
  held = verifyEnvelope(readFileSync(heldPath, 'utf8'), verifyWith) // throws on a bad signature
}

const release = await describeBuild(build)
let list
try { list = nextServed(held, release, undefined, { withdraw }) } catch (e) { die(e.message) }
const envelope = signPayload(JSON.stringify(list), keyPath)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, envelopeJson(envelope))
const files = Object.values(release.origins).reduce((n, o) => n + Object.keys(o.files).length, 0)
console.log(`Signed the bento/home release list #${list.serial}: ${list.releases.length} release(s), newest with ${files} served paths over ${Object.keys(release.origins).join(' and ')} → ${out}`)
