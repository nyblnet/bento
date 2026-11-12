#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Build bento.page/id/privacy (the bento/id privacy notice) and
// bento.page/id/delete (how to delete an account without any app, which the
// app stores ask for). Both are TEXT: no script, no form, nothing to type.
// The deletion page that was built here before asked for a code typed from an
// email, against routes the directory has retired; this one only explains,
// and points to the sign-in host's deletion page.
//
//   node scripts/build-id-pages.mjs --facts <facts.json> [--out site]
//   node scripts/build-id-pages.mjs --preview <dir>      (placeholders left visible; never into site/)
//
// facts.json supplies what only the maintainer can state: the controller, the
// contact address, the effective date, the legal basis, the processors,
// rights wording, children, and the sentences that wait on code not built yet
// (what stays after a deletion, the deletion page's address, how long setup
// send times are kept). Every one is a __PLACEHOLDER__ in the sources, and a
// normal build REFUSES to write a page that still contains one: a privacy
// notice that says "__CONTROLLER__" must never be published.
//
// A part of the notice that is not running yet is marked `data-planned`, and
// must open with its visible "Planned" label, so it can never read as live.
//
// Publishing is the maintainer's, when the directory is live.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const FACT_KEYS = [
  'CONTROLLER', 'CONTACT_EMAIL', 'EFFECTIVE_DATE', 'LEGAL_BASIS', 'RIGHTS_JURISDICTION', 'CHILDREN',
  'PROCESSORS', 'DELETION_RETENTION', 'DELETE_URL', 'SETUP_TIMES_RETENTION',
]
/** page name → source in site-src/ and the path it is published at */
export const PAGES = Object.freeze({
  privacy: { src: 'site-src/id-privacy.html', out: 'id/privacy/index.html' },
  delete: { src: 'site-src/id-delete.html', out: 'id/delete/index.html' },
})
const PLACEHOLDER = /__[A-Z0-9_]+__/
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The page rules a source must meet whatever the facts are. Throws naming the page and the rule. */
export function checkPage(name, html) {
  if (/\bsrc\s*=/i.test(html)) throw new Error(`${name}: no external resources on this page`)
  const active = html.match(/<(script|form|input|textarea|select|button|iframe|object|embed)\b/i)
  if (active) throw new Error(`${name}: these pages are text, refusing <${active[1].toLowerCase()}>`)
  if (/\son[a-z]+\s*=/i.test(html)) throw new Error(`${name}: no event-handler attributes`)
  // every planned part opens with its visible label, so it never reads as running
  for (const m of html.matchAll(/<([a-z0-9]+)\b[^>]*\bdata-planned\b[^>]*>([\s\S]{0,60})/gi)) {
    if (!/^\s*<span class="planned">Planned<\/span>/.test(m[2])) throw new Error(`${name}: a data-planned <${m[1]}> must open with its "Planned" label`)
  }
}

export function build({ facts = {}, preview = false, sources = {} } = {}) {
  for (const k of FACT_KEYS) {
    const v = facts[k]
    if (v === undefined) continue
    if (typeof v !== 'string' || !v.trim() || PLACEHOLDER.test(v)) throw new Error(`fact ${k} must be non-empty text`)
  }
  for (const k of Object.keys(facts)) if (!FACT_KEYS.includes(k)) throw new Error(`unknown fact ${k}`)
  if (facts.DELETE_URL !== undefined && !/^https:\/\/[a-z0-9.-]+\.bento\.page\/[^\s"<>]*$/.test(facts.DELETE_URL)) throw new Error('fact DELETE_URL must be an https:// address on bento.page')
  const out = {}
  for (const [name, page] of Object.entries(PAGES)) {
    let html = sources[name] ?? readFileSync(join(root, page.src), 'utf8')
    checkPage(name, html)
    for (const k of FACT_KEYS) if (facts[k] !== undefined) html = html.split(`__${k}__`).join(esc(facts[k]))
    if (!preview) {
      const left = html.match(PLACEHOLDER)
      if (left) throw new Error(`${name} page still contains ${left[0]} — refusing to build it for publishing`)
    }
    out[name] = html
  }
  return out
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const previewDir = arg('--preview')
  const outDir = previewDir ?? arg('--out') ?? join(root, 'site')
  if (previewDir && /(^|\/)site\/?$/.test(previewDir)) throw new Error('--preview never writes into site/')
  const facts = arg('--facts') ? JSON.parse(readFileSync(arg('--facts'), 'utf8')) : {}
  const pages = build({ facts, preview: !!previewDir })
  for (const [name, page] of Object.entries(PAGES)) {
    const file = join(outDir, page.out)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, pages[name])
    console.log(`bento/id ${name} page → ${file}${previewDir ? ' (PREVIEW: placeholders visible)' : ''}`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)) } catch (e) { console.error(String(e.message || e)); process.exit(1) }
}
