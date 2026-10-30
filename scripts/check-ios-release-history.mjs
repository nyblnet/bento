#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The release build of the iOS/Mac app must carry, for EVERY app published in
 * the site clone, the CURRENT signed release history. Gate 1 checks documents
 * against it, and the bundled copy is the anti-rollback floor. An app without
 * one would leave every document UNKNOWN, so the release build FAILS CLOSED.
 *
 *   node scripts/check-ios-release-history.mjs          # release: errors fail the build
 *   node scripts/check-ios-release-history.mjs --warn   # debug: warnings only
 *
 * For each document app (scripts/apps.mjs) with releases/<app>/manifest.json in the site clone
 * (BENTO_SITE_DIR, or bento-site beside the repo):
 *   - releases/<app>/history.json must be published
 *   - home/ios/release-history/<app>.json must be bundled, verify with a key
 *     pinned in home/ios/ReleaseKeys.swift (the one place), and be for <app>
 *   - the bundled copy must be the published one, or a valid successor of it:
 *     every published entry present and unchanged, and not older
 * To update: copy the site's releases/<app>/history.json into
 * home/ios/release-history/<app>.json after a release.
 *
 * Xcode runs this as a build phase; it prints Xcode's `error:` / `warning:` lines.
 * BENTO_HISTORY_CHECK_KEY (a JWK file) replaces the pinned key, for its rig only.
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicKey, verify } from 'node:crypto'
import { APPS } from './apps.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const warn = process.argv.includes('--warn')
const say = (m) => console.log(`${warn ? 'warning' : 'error'}: ${m}`)
const BUNDLED = process.env.BENTO_BUNDLED_HISTORY_DIR || join(ROOT, 'home/ios/release-history')

/** the site clone: BENTO_SITE_DIR, or bento-site beside the repo (beside the MAIN checkout, from a worktree) */
function siteDir() {
  if (process.env.BENTO_SITE_DIR) return resolve(process.env.BENTO_SITE_DIR)
  const near = resolve(ROOT, '..', 'bento-site')
  if (existsSync(near)) return near
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, stdio: 'pipe' }).toString().trim()
    return resolve(dirname(common), '..', 'bento-site')
  } catch { return near }
}

/** the pinned keys, read from ReleaseKeys.swift so they live in one place */
function keys() {
  if (process.env.BENTO_HISTORY_CHECK_KEY) return [createPublicKey({ key: JSON.parse(readFileSync(process.env.BENTO_HISTORY_CHECK_KEY, 'utf8')), format: 'jwk' })]
  const src = readFileSync(join(ROOT, 'home/ios/ReleaseKeys.swift'), 'utf8')
  const pinned = [...src.matchAll(/\("([A-Za-z0-9_-]{43})",\s*"([A-Za-z0-9_-]{43})"\)/g)]
  return pinned.map(([, x, y]) => createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' }))
}

function open(path, app, ks) {
  let env
  try { env = JSON.parse(readFileSync(path, 'utf8')) } catch { return { err: `${path} is not JSON` } }
  if (typeof env.payload !== 'string' || typeof env.sig !== 'string') return { err: `${path} is not a signed history` }
  const ok = ks.some((k) => { try { return verify('sha256', Buffer.from(env.payload, 'utf8'), { key: k, dsaEncoding: 'ieee-p1363' }, Buffer.from(env.sig, 'base64')) } catch { return false } })
  if (!ok) return { err: `${path} does not verify with a pinned release key` }
  let h
  try { h = JSON.parse(env.payload) } catch { return { err: `${path} has a payload that is not JSON` } }
  if (h.v !== 1 || h.app !== (appIdOf[app] ?? app) || !Array.isArray(h.releases) || !h.releases.length) return { err: `${path} is not a v1 history for ${appIdOf[app] ?? app}` }
  return { h }
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const cmp = (a, b) => { const x = SEMVER.exec(a), y = SEMVER.exec(b); for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d) return d } return 0 }

const site = siteDir()
if (!existsSync(join(site, 'releases'))) {
  say(`no site clone at ${site} to check the bundled release history against (clone bento-site beside the repo, or set BENTO_SITE_DIR)`)
  process.exit(warn ? 0 : 1)
}
const ks = keys()
let bad = 0
if (!ks.length) { say('no release key is pinned in home/ios/ReleaseKeys.swift'); process.exit(warn ? 0 : 1) }

// the DOCUMENT apps K4 signs histories for (scripts/apps.mjs), once published;
// the tray's own manifest is the app binary's, not a document runtime
const apps = Object.values(APPS).map((a) => a.dir).filter((dir) => existsSync(join(site, 'releases', dir, 'manifest.json'))).sort()
// a history names its app by appId; ReleaseHistory.historyApp derives it as "bento-" + dir
const appIdOf = Object.fromEntries(Object.values(APPS).map((a) => [a.dir, a.appId]))
for (const a of Object.values(APPS)) if (a.appId !== `bento-${a.dir}`) { say(`scripts/apps.mjs names ${a.dir} "${a.appId}", but ReleaseHistory.historyApp expects "bento-${a.dir}"`); bad++ }
for (const app of apps) {
  const pubPath = join(site, 'releases', app, 'history.json')
  if (!existsSync(pubPath)) { say(`no published release history for ${app}; publish a release first`); bad++; continue }
  const pub = open(pubPath, app, ks)
  if (pub.err) { say(pub.err); bad++; continue }
  const bPath = join(BUNDLED, `${app}.json`)
  if (!existsSync(bPath)) { say(`no bundled release history for ${app}: copy ${pubPath} to home/ios/release-history/${app}.json`); bad++; continue }
  const b = open(bPath, app, ks)
  if (b.err) { say(b.err); bad++; continue }
  if (cmp(b.h.releases[0].version, pub.h.releases[0].version) < 0) { say(`the bundled release history for ${app} (${b.h.releases[0].version}) is older than the published one (${pub.h.releases[0].version}): copy ${pubPath} again`); bad++; continue }
  const missing = pub.h.releases.find((e) => { const t = b.h.releases.find((x) => x.version === e.version); return !t || JSON.stringify(t) !== JSON.stringify(e) })
  if (missing) { say(`the bundled release history for ${app} lacks or changes ${missing.version}, which is published`); bad++; continue }
  console.log(`${app}: the bundled release history is current (${b.h.releases[0].version})`)
}
if (!apps.length) console.log('no published apps in the site clone')
process.exit(bad && !warn ? 1 : 0)
