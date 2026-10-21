#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// BACKFILL the release history (K4, security §36c) from every release already
// published: each version with a SIGNED manifest, its shell checked against
// that manifest's own sha256 first.
//
//   node scripts/backfill-history.mjs --site ../bento-site --dir slides --app bento-slides --out entries.json
//
// Walks the site repository's git history of releases/<dir>/manifest.json. For
// each publication it verifies the manifest's signature against the release
// public key, checks the app id, reads the shell from the SAME commit and
// checks its sha256 against the manifest, and only then derives the pins, by
// booting that shell and saving through its own ⌘S fallback. Nothing historic
// is trusted on its own say-so.
//
// Not every verified release can be pinned. A shell from before the runtime
// shipped compressed has no bento-rt block (slides < 0.7.0), and those stay
// UNKNOWN to hosts, as security ruled. They are listed, never signed. A version
// published more than once (a re-signed manifest) has one shell (measured);
// the first publication's date is kept.
//
// Writes UNSIGNED entries: sign-history.mjs --seed turns them into the first
// signed history, on the maintainer's machine, on an explicit release go.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releasePublicKey, verifyEnvelope } from './sign-payload.mjs'
import { derivePins, checkAgainstPins, scanBlocks, executableScripts } from './lib/release-pins.mjs'
import { savedBy } from './lib/saved-by.mjs'

const args = process.argv.slice(2)
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }
const site = opt('site'), dir = opt('dir'), app = opt('app'), out = opt('out')
if (!site || !dir || !app || !out) { console.error('usage: backfill-history.mjs --site <bento-site> --dir <slides> --app <bento-slides> --out entries.json'); process.exit(2) }

const git = (...a) => execFileSync('git', ['-C', site, ...a], { maxBuffer: 1 << 28 })
const pub = releasePublicKey()
const commits = git('log', '--reverse', '--format=%H', '--', `releases/${dir}/manifest.json`).toString().trim().split('\n').filter(Boolean)

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const work = mkdtempSync(join(tmpdir(), 'bento-backfill-'))
const entries = new Map(), refused = [], unpinnable = []
try {
  for (const c of commits) {
    let payload
    try {
      payload = verifyEnvelope(git('show', `${c}:releases/${dir}/manifest.json`).toString(), pub)
    } catch (e) { refused.push(`${c.slice(0, 8)}: manifest signature (${e.message})`); continue }
    if (payload.app !== app) { refused.push(`${c.slice(0, 8)}: manifest is for ${payload.app}`); continue }
    if (entries.has(payload.version) || unpinnable.some((u) => u.startsWith(`${payload.version}:`))) continue // a re-signed manifest
    const file = payload.url.split('/').pop()
    let shell
    try { shell = git('show', `${c}:releases/${dir}/${file}`) } catch { refused.push(`${payload.version}: no shell ${file} in ${c.slice(0, 8)}`); continue }
    const sha256 = createHash('sha256').update(shell).digest('hex')
    if (sha256 !== payload.sha256) { refused.push(`${payload.version}: shell sha256 does not match its signed manifest`); continue }
    const html = shell.toString('utf8')
    const blocks = scanBlocks(html)
    const pinnable = ['bento-rt', 'bento-rt-css'].every((id) => blocks.filter((b) => b.id === id).length === 1) && executableScripts(blocks).length === 1
    if (!pinnable) { unpinnable.push(`${payload.version}: no compressed runtime blocks`); continue }
    const path = join(work, `${payload.version}.html`)
    writeFileSync(path, shell)
    const saved = await savedBy(browser, path)
    const pins = derivePins(html, saved, { historic: true })
    const self = await checkAgainstPins(saved, pins)
    if (self.length) { refused.push(`${payload.version}: its own save does not match its pins (${self[0]})`); continue }
    entries.set(payload.version, { version: payload.version, sha256, at: payload.at, pins })
    console.log(`  ${payload.version.padEnd(8)} pinned  (remover ${pins.blocks.remover ? 'yes' : 'none'})`)
  }
} finally {
  await browser.close()
}
writeFileSync(out, JSON.stringify([...entries.values()], null, 2) + '\n')
console.log(`\n${commits.length} publications; ${entries.size} versions pinned; ${unpinnable.length} unpinnable; ${refused.length} refused`)
if (unpinnable.length) console.log(`  unpinnable: ${unpinnable[0].split(':')[0]} … ${unpinnable.at(-1).split(':')[0]} (${unpinnable.length}): no compressed runtime blocks, so UNKNOWN to hosts`)
for (const r of refused) console.log(`  REFUSED: ${r}`)
process.exit(refused.length ? 1 : 0)
