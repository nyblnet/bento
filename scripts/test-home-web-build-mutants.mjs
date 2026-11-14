#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Mutants for scripts/test-home-web-build.mjs: each removes one refusal, and
 * the rig must go red ON THE ROW THAT GUARDS IT. Each runs in a COPY of the
 * files the rig reads (never the checkout), and a mutant whose text is not
 * found exactly once fails the run, so a mutant can never quietly stop being
 * applied. The rehearsal section is skipped in the copy (the plain rig runs
 * it). The copy carries the built slides shell, so a mutant that lets a
 * refused release go on reaches signing and is seen signing (Playwright and
 * Chromium for the pins gate, as in the plain rig).
 *
 *   node scripts/test-home-web-build-mutants.mjs [name…]
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const B = 'home/web/build.mjs', R = 'scripts/home-web-release.mjs', REL = 'scripts/release.mjs'

const MUTANTS = [
  { name: 'no-history-warns', file: B, from: "  devOnly('no --history: a production build bundles the published history of every published app')\n", to: '',
    expect: 'no --history: refused' },
  { name: 'key-allowed', file: B, from: "if (opt('key')) devOnly('--key replaces the release key')\n", to: '',
    expect: '--key (a test key): refused' },
  { name: 'mutant-allowed', file: B, from: "if (process.env.BENTO_HOME_WEB_MUTANT) devOnly('BENTO_HOME_WEB_MUTANT is set')\n", to: '',
    expect: 'BENTO_HOME_WEB_MUTANT set: refused' },
  { name: 'identity-allowed', file: B, from: "if (identity) devOnly('--identity adds the bento/id agent, whose directory keys are not pinned for release')\n", to: '',
    expect: '--identity (the bento/id agent' },
  { name: 'directory-keys-allowed', file: B, from: "if (opt('directory-keys')) devOnly('--directory-keys pins directory keys that are not the released ones')\n", to: '',
    expect: '--directory-keys alone: refused' },
  { name: 'dev-always', file: B, from: "const dev = args.includes('--dev')", to: 'const dev = true',
    expect: 'no --history: refused' },
  { name: 'histories-unchecked', file: B, from: '    if (why) die(', to: '    if (false) die(',
    expect: 'another key than the release key: refused' },
  { name: 'two-per-app', file: B, from: '    if (seen.has(app)) die(', to: '    if (false) die(',
    expect: 'two histories for the same app: refused' },
  { name: 'frame-origin-optional', file: R, from: '  if (!frameOrigin || frameOrigin.startsWith', to: '  if (false && frameOrigin.startsWith',
    expect: '--home-web without --frame-origin' },
  { name: 'out-inside-site', file: R, from: '  if (within(out, site)) throw', to: '  if (false) throw',
    expect: 'home/web output inside the site' },
  { name: 'out-may-contain-site', file: R, from: '  if (within(site, out)) throw', to: '  if (false) throw',
    expect: 'home/web output that contains the site' },
  { name: 'out-in-published', file: R, from: '  if (published && within(out, published)) throw', to: '  if (false) throw',
    expect: 'home/web output inside the published tree' },
  { name: 'out-may-contain-published', file: R, from: '  if (published && within(published, out)) throw', to: '  if (false) throw',
    expect: 'home/web output that contains the published tree' },
  { name: 'published-not-passed', file: REL, from: '    prepareHomeWebOut({ site, out: homeWeb.out, published })', to: '    prepareHomeWebOut({ site, out: homeWeb.out })',
    expect: 'home/web output inside the published tree' },
  { name: 'dangling-link-walked-past', file: R, from: '    throw new Error(`${p} runs through a symlink to nothing', to: '    cur = dirname(cur); continue; throw new Error(`${p} runs through a symlink to nothing',
    expect: 'through a symlink to a folder of the fresh site that does not exist yet' },
  { name: 'any-folder-emptied', file: R, from: '  if (readdirSync(out).length && !holdsEarlierBuild(out)) {', to: '  if (false) {',
    expect: 'home/web output holding something other than an earlier build' },
  { name: 'earlier-build-by-name', file: R, from: "    const j = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8'))", to: "    const j = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')); return true",
    expect: "home/web output whose build.json is not a build's" },
  { name: 'inside-by-path-text', file: R, from: '    if (id(cur) === target) return true', to: '    if (cur === dir) return true',
    expect: 'reaching into the site through a symlink' },
  { name: 'stale-out-kept', file: R, from: '  rmSync(out, { recursive: true, force: true })\n', to: '',
    expect: 'leaves no earlier (development, test-key) build' },
  { name: 'key-checked-before-emptying', file: REL, from: "    prepareHomeWebOut({ site, out: homeWeb.out, published })\n    homeWeb.devKey = homeWebKey({ keyPath: opt('key', null), releaseKey: releasePublicKey, dev: homeWeb.dev })\n",
    to: "    homeWeb.devKey = homeWebKey({ keyPath: opt('key', null), releaseKey: releasePublicKey, dev: homeWeb.dev })\n    prepareHomeWebOut({ site, out: homeWeb.out, published })\n",
    expect: 'the non-release-key refusal leaves no earlier' },
  { name: 'seeded-checked-after-signing', file: REL, from: 'if (homeWeb) {\n  let seeded', to: 'if (false) {\n  let seeded',
    expect: 'a published app (spaces) with a manifest and no history: refused, nothing signed' },
  { name: 'seeded-histories-unverified', file: REL, from: '  if (seeded.length) {', to: '  if (false) {',
    expect: 'a published history the build would refuse' },
  { name: 'mutant-env-late', file: REL, from: "    if (process.env.BENTO_HOME_WEB_MUTANT) throw", to: '    if (false) throw',
    expect: 'BENTO_HOME_WEB_MUTANT in the environment' },
  { name: 'esbuild-late', file: REL, from: '    if (!existsSync(esbuild)) throw', to: '    if (false) throw',
    expect: 'esbuild missing: refused, nothing signed' },
  { name: 'any-key-production', file: R, from: '  if (!same && !dev) {', to: '  if (false) {',
    expect: 'not the release key, without --home-web-dev' },
  { name: 'stray-flags-ignored', file: R, from: "    if (frameOrigin || dev || outArg) throw", to: '    if (false) throw',
    expect: '--frame-origin without --home-web' },
  { name: 'unpublished-skipped', file: R, from: '    if (!existsSync(history)) throw new Error(', to: '    if (!existsSync(history)) continue; (',
    expect: 'a published app without a history: refused' },
]

const only = process.argv.slice(2)
const esbuild = path.join(ROOT, 'slides/node_modules/.bin/esbuild')
const shell = path.join(ROOT, 'slides/dist-single/Bento_Slides.bento.html')
if (!fs.existsSync(shell)) { console.error(`no built slides shell at ${shell}: cd slides && npm run build:single`); process.exit(1) }
let killed = 0, ran = 0
for (const m of MUTANTS.filter((x) => !only.length || only.includes(x.name))) {
  ran++
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-hwb-mutant-'))
  try {
    for (const d of ['scripts', 'home/web', 'home/webext/src', 'home/fixtures/gate1', 'kernel/src', 'convert/src']) {
      fs.cpSync(path.join(ROOT, d), path.join(copy, d), { recursive: true, filter: (s) => !s.includes('node_modules') && !s.includes(`${path.sep}dist`) })
    }
    fs.mkdirSync(path.join(copy, 'slides'), { recursive: true })
    fs.cpSync(path.join(ROOT, 'slides/package.json'), path.join(copy, 'slides/package.json'))
    // a mutant that lets a refused run go on must be able to reach signing, so it can be SEEN signing
    fs.cpSync(shell, path.join(copy, 'slides/dist-single', path.basename(shell)))
    fs.cpSync(path.join(ROOT, 'CHANGELOG.md'), path.join(copy, 'CHANGELOG.md'))
    const f = path.join(copy, m.file)
    const text = fs.readFileSync(f, 'utf8')
    const n = text.split(m.from).length - 1
    if (n !== 1) { console.log(`  FAIL  ${m.name}: "${m.from.trim()}" occurs ${n} times in ${m.file} (exactly one required)`); continue }
    fs.writeFileSync(f, text.replace(m.from, () => m.to))
    const r = spawnSync(process.execPath, [path.join(copy, 'scripts/test-home-web-build.mjs')],
      { encoding: 'utf8', env: { ...process.env, ESBUILD: process.env.ESBUILD || esbuild, BENTO_HWB_NO_REHEARSAL: '1' } })
    const fails = r.stdout.split('\n').filter((l) => l.startsWith('  FAIL'))
    const onRow = fails.some((l) => l.includes(m.expect))
    if (r.status !== 0 && onRow) { killed++; console.log(`  ok    ${m.name}: red on its row ("${m.expect}"; ${fails.length} red)`) }
    else console.log(`  FAIL  ${m.name}: SURVIVED or red elsewhere (exit ${r.status}; red rows: ${fails.map((l) => l.slice(8, 70)).join(' | ') || 'none'})${r.status && !fails.length ? '\n' + r.stderr.slice(-600) : ''}`)
  } finally { fs.rmSync(copy, { recursive: true, force: true }) }
}
console.log(`\n${killed}/${ran} mutants killed`)
process.exit(killed === ran && ran > 0 ? 0 : 1)
