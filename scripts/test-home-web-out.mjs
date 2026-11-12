#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Where release.mjs --home-web may put its output (scripts/home-web-release.mjs
 * within / prepareHomeWebOut): never in or around the site, never in or around
 * the published tree, decided by folder identity (device and inode), not by
 * path text.
 *
 *   node scripts/test-home-web-out.mjs
 *
 * Every spelling that reaches into a folder is tried: a symlink, a case
 * variant, a child named `..hw`, and on macOS the /System/Volumes/Data
 * firmlink, which realpath does not map back. The firmlink row exists only on
 * macOS (the ubuntu job prints a SKIPPED line, allowed in
 * scripts/lib/ci-skips.mjs; the macOS home-ios job runs it). Its mutant runs
 * here too, beside the row: the same module with identities swapped for real
 * paths must miss the firmlink, or the row proves nothing.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { within, prepareHomeWebOut, holdsEarlierBuild } from './home-web-release.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bento-home-web-out-')))
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }))
const mk = (...p) => { const d = path.join(work, ...p); fs.mkdirSync(d, { recursive: true }); return d }
const throws = (fn) => { try { fn(); return '' } catch (e) { return e.message } }

console.log('=== within: by folder identity')
const site = mk('site')
mk('elsewhere'); fs.symlinkSync(site, path.join(work, 'elsewhere', 'link'))
const caseInsensitive = fs.existsSync(path.join(work, 'SITE'))
ok(within(path.join(site, 'hw'), site) && within(site, site), 'a child of the site, and the site itself, are inside')
ok(within(path.join(site, '..hw'), site), 'a child named ..hw is inside')
ok(within(path.join(work, 'elsewhere', 'link', 'hw'), site), 'a path through a symlink to the site is inside')
ok(within(path.join(work, 'SITE', 'hw'), site) === caseInsensitive, `a case variant is inside exactly when the disk is case-insensitive (${caseInsensitive ? 'it is' : 'it is not'} here)`)
ok(!within(path.join(work, 'site.home-web'), site) && !within(path.join(work, 'sitex', 'hw'), site), 'positive control: the <site>.home-web sibling and a look-alike name are outside')
ok(within(site, work) && !within(work, site), 'containment runs one way: the parent holds the site, not the reverse')
ok(!within(path.join(work, 'x'), path.join(work, 'no-such-folder')), 'nothing is inside a folder that does not exist')

const FIRMLINK = '/System/Volumes/Data'
if (process.platform === 'darwin' && fs.existsSync(FIRMLINK)) {
  const viaFirmlink = FIRMLINK + path.join(site, 'hw')
  ok(within(viaFirmlink, site), `the macOS firmlink spelling of a path inside the site is inside (${FIRMLINK}…/site/hw)`)
  // the mutant, beside its row: identities replaced by real paths
  const src = fs.readFileSync(path.join(HERE, 'home-web-release.mjs'), 'utf8')
  const from = 'const id = (p) => { const st = statSync(p); return `${st.dev}:${st.ino}` }'
  ok(src.split(from).length === 2, 'mutant: the identity function is found exactly once')
  const copy = path.join(work, 'mutant-home-web-release.mjs')
  fs.writeFileSync(copy, src.replace(from, () => 'const id = (p) => realpathSync.native(p)'))
  const mutant = await import(pathToFileURL(copy).href)
  ok(!mutant.within(viaFirmlink, site), 'mutant: compared as real paths, the firmlink spelling is missed (so the row above is what catches it)')
} else {
  console.log('  home-web out: SKIPPED — the /System/Volumes/Data firmlink exists only on macOS (the home-ios job runs this row)')
}

console.log('\n=== prepareHomeWebOut')
const pub = mk('published')
const build = (dir, extra = {}) => { mk(dir); fs.writeFileSync(path.join(work, dir, 'build.json'), JSON.stringify({ libraryOrigin: 'x', frameOrigin: 'y', dev: true, testKey: true, histories: [] })); for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(work, dir, k), v); return path.join(work, dir) }
const prep = (out) => throws(() => prepareHomeWebOut({ site, out, published: pub }))
ok(/inside the site/.test(prep(path.join(site, 'hw'))) && !fs.existsSync(path.join(site, 'hw')), 'an output inside the site: refused, nothing created in it')
ok(/contains the site/.test(prep(work)), 'an output containing the site: refused')
ok(/inside the published tree/.test(prep(path.join(pub, 'hw'))) && !fs.existsSync(path.join(pub, 'hw')), 'an output inside the published tree: refused, nothing created in it')
{
  const site2 = mk('outer', 'site2')
  const pubInside = mk('outer', 'pubhome', 'published')
  const msg = throws(() => prepareHomeWebOut({ site: site2, out: path.join(work, 'outer', 'pubhome'), published: pubInside }))
  ok(/contains the published tree/.test(msg), 'an output containing the published tree: refused')
}
{
  const bogus = build('bogus', { CANARY: 'keep' })
  fs.writeFileSync(path.join(bogus, 'build.json'), '{}')
  ok(!holdsEarlierBuild(bogus) && /holds something other/.test(prep(bogus)) && fs.existsSync(path.join(bogus, 'CANARY')), 'a folder whose build.json is not a build\'s: refused, kept')
}
{
  const earlier = build('earlier', { 'index.html': 'old' })
  ok(holdsEarlierBuild(earlier) && prep(earlier) === '' && !fs.existsSync(earlier), 'positive control: an earlier build is accepted and removed')
  ok(prep(path.join(work, 'fresh')) === '' && !fs.existsSync(path.join(work, 'fresh')), 'positive control: a new folder is accepted, and not created here')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
