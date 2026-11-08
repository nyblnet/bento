#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The iOS release build's history check (scripts/check-ios-release-history.mjs)
 * FAILS CLOSED. Driven against a throwaway site clone and bundle folder, with
 * histories signed by a throwaway key.
 *
 *   node scripts/test-check-ios-release-history.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = join(ROOT, 'scripts/check-ios-release-history.mjs')
const work = mkdtempSync(join(tmpdir(), 'bento-histcheck-'))
const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }), other = generateKeyPairSync('ec', { namedCurve: 'P-256' })
writeFileSync(join(work, 'key.json'), JSON.stringify(key.publicKey.export({ format: 'jwk' })))
const hex = () => randomBytes(32).toString('hex')
const entry = (version) => ({ version, sha256: hex(), at: '2026-10-21T00:00:00Z', pins: { v: 1, blocks: { 'bento-rt': hex(), 'bento-rt-css': hex(), loader: hex(), remover: null }, scriptSrc: ['sha256-x'] } })
const e1 = entry('1.0.0'), e2 = entry('1.1.0')
const env = (releases, { app = 'bento-slides', k = key } = {}) => {
  const payload = JSON.stringify({ app, v: 1, releases })
  return JSON.stringify({ payload, sig: sign('sha256', Buffer.from(payload), { key: k.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') })
}

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
let n = 0
/** a site with slides published (manifest + optional history) and a bundle folder */
function run({ published, bundled, warn = false }) {
  const d = join(work, `c${n++}`), site = join(d, 'site'), bundle = join(d, 'bundle')
  mkdirSync(join(site, 'releases/slides'), { recursive: true }); mkdirSync(bundle, { recursive: true })
  writeFileSync(join(site, 'releases/slides/manifest.json'), '{}')
  if (published) writeFileSync(join(site, 'releases/slides/history.json'), published)
  if (bundled) writeFileSync(join(bundle, 'slides.json'), bundled)
  try {
    const out = execFileSync('node', [CHECK, ...(warn ? ['--warn'] : [])], { env: { ...process.env, BENTO_SITE_DIR: site, BENTO_BUNDLED_HISTORY_DIR: bundle, BENTO_HISTORY_CHECK_KEY: join(work, 'key.json') }, stdio: 'pipe' }).toString()
    return { code: 0, out }
  } catch (e) { return { code: e.status, out: e.stdout.toString() } }
}

console.log('a release build fails unless the current history is bundled')
let r = run({})
ok(r.code === 1 && /no published release history for slides; publish a release first/.test(r.out), `nothing published: fails ("${r.out.trim()}")`)
r = run({ published: env([e1]) })
ok(r.code === 1 && /no bundled release history for slides/.test(r.out), 'published but not bundled: fails')
r = run({ published: env([e2, e1]), bundled: env([e1]) })
ok(r.code === 1 && /older than the published one/.test(r.out), 'bundled OLDER than published: fails')
r = run({ published: env([e2, e1]), bundled: env([e2, { ...e1, sha256: hex() }]) })
ok(r.code === 1 && /lacks or changes 1\.0\.0/.test(r.out), 'bundled changes a published entry: fails')
r = run({ published: env([e1]), bundled: env([e1], { k: other }) })
ok(r.code === 1 && /does not verify/.test(r.out), 'bundled signed by another key: fails')
r = run({ published: env([e1]), bundled: env([e1], { app: 'bento-dash' }) })
ok(r.code === 1 && /not a v1 history for bento-slides/.test(r.out), "bundled is another app's: fails")
r = run({ published: env([e1]), bundled: env([e1], { app: 'slides' }) })
ok(r.code === 1 && /not a v1 history for bento-slides/.test(r.out), 'bundled names the app by its directory, not its appId: fails')
r = run({ published: env([e1]), bundled: env([e1]) })
ok(r.code === 0 && /current \(1\.0\.0\)/.test(r.out), 'bundled IS the published one: passes')
r = run({ published: env([e1]), bundled: env([e2, e1]) })
ok(r.code === 0 && /current \(1\.1\.0\)/.test(r.out), 'bundled is a valid newer successor: passes')
console.log('a debug build only warns')
r = run({ warn: true })
ok(r.code === 0 && /^warning: no published release history for slides/m.test(r.out), 'nothing published, --warn: a warning, and the build goes on')

rmSync(work, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
