#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Build bento.page/id/privacy, the bento/id privacy notice.
//
// The web account-deletion page that was built here asked for a code typed
// from an email, against routes the directory has retired (410). Deletion
// returns as a mailed link to the sign-in host; its page will be built there.
//
//   node scripts/build-id-pages.mjs --facts <facts.json> [--out site]
//   node scripts/build-id-pages.mjs --preview <dir>      (placeholders left visible; never into site/)
//
// facts.json supplies what only the maintainer can state — the controller, the
// contact address, the effective date, the legal basis, rights wording and
// the tombstone retention. Every one is a __PLACEHOLDER__ in the source, and a
// normal build REFUSES to write a page that still contains one: a privacy
// notice that says "__CONTROLLER__" must never be published.
//
// Publishing is the maintainer's, when the directory is live.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const FACT_KEYS = ['CONTROLLER', 'CONTACT_EMAIL', 'EFFECTIVE_DATE', 'LEGAL_BASIS', 'RIGHTS_JURISDICTION', 'CHILDREN', 'TOMBSTONE_RETENTION']
const PLACEHOLDER = /__[A-Z0-9_]+__/
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function build({ facts = {}, preview = false } = {}) {
  let privacy = readFileSync(join(root, 'site-src/id-privacy.html'), 'utf8')
  for (const k of FACT_KEYS) {
    const v = facts[k]
    if (v === undefined) continue
    if (typeof v !== 'string' || !v.trim() || PLACEHOLDER.test(v)) throw new Error(`fact ${k} must be non-empty text`)
    privacy = privacy.split(`__${k}__`).join(esc(v))
  }
  if (/\bsrc=/.test(privacy)) throw new Error('no external resources on this page')
  if (!preview) {
    const left = privacy.match(PLACEHOLDER)
    if (left) throw new Error(`privacy page still contains ${left[0]} — refusing to build it for publishing`)
  }
  return { privacy }
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const previewDir = arg('--preview')
  const out = previewDir ?? arg('--out') ?? join(root, 'site')
  if (previewDir && /(^|\/)site\/?$/.test(previewDir)) throw new Error('--preview never writes into site/')
  const facts = arg('--facts') ? JSON.parse(readFileSync(arg('--facts'), 'utf8')) : {}
  const pages = build({ facts, preview: !!previewDir })
  mkdirSync(join(out, 'id', 'privacy'), { recursive: true })
  writeFileSync(join(out, 'id', 'privacy', 'index.html'), pages.privacy)
  console.log(`bento/id privacy notice → ${join(out, 'id', 'privacy')}${previewDir ? ' (PREVIEW: placeholders visible)' : ''}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)) } catch (e) { console.error(String(e.message || e)); process.exit(1) }
}
