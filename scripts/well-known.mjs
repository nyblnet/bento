#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Fill the passkey association files for id.bento.page, the bento/id relying
// party, and write them into a staging directory for that host.
//
//   node scripts/well-known.mjs [--apple-team TEAMID] [--play-sha256 AA:BB:…] --out DIR
//
// They let passkeys created for the relying party id.bento.page be used by the
// bento/home apps: Apple reads /.well-known/apple-app-site-association
// (`webcredentials`), Android reads /.well-known/assetlinks.json
// (`get_login_creds`). A platform fetches these files only from the rp host
// itself, so they belong on id.bento.page (the bento/id directory host), and
// NEVER on bento.page: the apex is not the relying party, and an association
// file there would hand the apps a second rp nobody verifies against.
// The templates in site-src/id-host/well-known/ carry PLACEHOLDERS: the Apple
// developer team id and the Play app-signing certificate fingerprint exist
// only once those accounts do.
//
// A placeholder must never be published: a wrong association file is worse
// than none, because the platform caches it. So this script writes ONLY the
// files whose value was given, validates the value's shape, and refuses any
// output that still contains a placeholder. Run with neither flag to check the
// templates and write nothing. It also refuses to write into the bento.page
// site staging tree (`site/`, or any directory carrying the apex's host files).
//
// Publishing and deploying are the maintainer's: this writes into a local
// directory, and the id.bento.page host is what serves it.
//
// Serving notes for whoever deploys id.bento.page:
//   · both files must be served over HTTPS at exactly
//     https://id.bento.page/.well-known/<name>, with no redirect, as
//     application/json (the Apple file has no extension, so set the type).
//   · Apple's CDN fetches the AASA for the devices; confirm it has picked the
//     file up at https://app-site-association.cdn-apple.com/a/v1/id.bento.page
//     before relying on it.
//   · scripts/check-id-hosting.mjs --live checks the hosting rules around
//     them (no /.well-known/webauthn on the rp host, nothing on the apex).

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = join(root, 'site-src/id-host/well-known')

/** The host these files are for: the passkey relying party. One constant. */
export const RP_HOST = 'id.bento.page'
export const APPLE_CDN_URL = `https://app-site-association.cdn-apple.com/a/v1/${RP_HOST}`

export const FILES = {
  apple: { name: 'apple-app-site-association', placeholder: '__APPLE_TEAM_ID__', valid: /^[A-Z0-9]{10}$/ },
  play: { name: 'assetlinks.json', placeholder: '__PLAY_APP_SIGNING_SHA256__', valid: /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/ },
}
const ANY_PLACEHOLDER = /__[A-Z0-9_]+__/

/** Fill one template. Returns the text, or throws with a reason. */
export function fill(kind, value) {
  const f = FILES[kind]
  const tpl = readFileSync(join(TEMPLATES, f.name), 'utf8')
  JSON.parse(tpl) // the template itself must be valid JSON
  if (!tpl.includes(f.placeholder)) throw new Error(`${f.name}: template has no ${f.placeholder}`)
  if (!f.valid.test(value)) throw new Error(`${f.name}: "${value}" is not a valid ${kind === 'apple' ? 'Apple team id (10 characters, A–Z 0–9)' : 'SHA-256 fingerprint (32 uppercase hex bytes, colon-separated)'}`)
  const out = tpl.split(f.placeholder).join(value)
  if (ANY_PLACEHOLDER.test(out)) throw new Error(`${f.name}: a placeholder is still present after filling — refusing`)
  JSON.parse(out)
  return out
}

/** Why `dir` is the bento.page site staging tree, or '' when it is not. */
export function apexReason(dir) {
  const real = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }
  const d = real(dir)
  if (d === real(join(root, 'site'))) return 'it is the bento.page staging directory (site/)'
  for (const marker of ['CNAME', '_redirects', 'slides']) {
    if (existsSync(join(d, marker))) return `it carries ${marker}, a bento.page site file`
  }
  return ''
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const out = arg('--out')
  const given = { apple: arg('--apple-team'), play: arg('--play-sha256')?.toUpperCase() }
  // always check every template, so a broken one is caught even when unused
  for (const f of Object.values(FILES)) {
    const tpl = readFileSync(join(TEMPLATES, f.name), 'utf8')
    JSON.parse(tpl)
    if (!tpl.includes(f.placeholder)) throw new Error(`${f.name}: template has no ${f.placeholder}`)
  }
  const kinds = Object.keys(FILES).filter((k) => given[k] !== undefined)
  if (!kinds.length) { console.log('templates OK; nothing written (no values given)'); return }
  if (!out) throw new Error(`--out is required: the staging directory for ${RP_HOST} (there is no default, so these files can never land in the bento.page site by accident)`)
  const apex = apexReason(out)
  if (apex) throw new Error(`refusing to write into ${out}: ${apex}. These files belong on ${RP_HOST}, never on bento.page.`)
  const texts = kinds.map((k) => [k, fill(k, given[k])]) // fill all first: a bad value writes nothing
  const dir = join(out, '.well-known')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  for (const [k, text] of texts) writeFileSync(join(dir, FILES[k].name), text)
  console.log(`wrote ${kinds.map((k) => FILES[k].name).join(', ')} into ${dir} (for https://${RP_HOST}/.well-known/)`)
}

// realpath both sides: through a symlinked path (macOS /var → /private/var) a
// plain compare is false, main never runs, and the script exits 0 having
// written nothing.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try { main(process.argv.slice(2)) } catch (e) { console.error(String(e.message || e)); process.exit(1) }
}
