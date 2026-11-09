#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The passkey association files for id.bento.page (the bento/id relying
// party): scripts/well-known.mjs never publishes a placeholder, writes only
// what it was given, refuses values of the wrong shape, and can never write
// into the bento.page site, because the apex is not the relying party.
//
//   node scripts/test-well-known.ts
//
// HOW. The suite runs against a throwaway copy of the script and its
// templates. The CONTROL is a byte copy: every check must pass. Each MUTANT is
// the copy with one defect planted (the old apex default, the apex guard off,
// the rp back on bento.page, any value accepted, a partial write on a bad
// value, applinks added to the rp's AASA). Each mutant must be caught by at
// least one check, and the rig proves each mutation was actually applied.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = 'scripts/well-known.mjs'
const TPL_DIR = 'site-src/id-host/well-known'
const TEAM = 'AB12CD34EF'
const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':')

type Mut = { file: string; from: string | RegExp; to: string }

/** A throwaway tree with the script and its templates, optionally mutated. */
function makeTree(muts: Mut[] = []): string {
  const t = mkdtempSync(join(tmpdir(), 'wk-tree-'))
  mkdirSync(join(t, 'scripts'))
  cpSync(join(repo, SCRIPT), join(t, SCRIPT))
  cpSync(join(repo, TPL_DIR), join(t, TPL_DIR), { recursive: true })
  for (const m of muts) {
    const p = join(t, m.file)
    const before = readFileSync(p, 'utf8')
    const after = before.replace(m.from, m.to)
    if (after === before) throw new Error(`mutation not applied to ${m.file}: ${String(m.from)}`)
    writeFileSync(p, after)
  }
  return t
}

async function suite(tree: string): Promise<{ passes: number; fails: string[] }> {
  let passes = 0
  const fails: string[] = []
  const ok = (c: unknown, n: string) => { if (c) passes++; else fails.push(n) }
  const run = (args: string[]) => {
    try { return { code: 0, out: execFileSync('node', [join(tree, SCRIPT), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } } catch (e) {
      const err = e as { status?: number; stderr?: string }
      return { code: err.status ?? 1, out: String(err.stderr ?? '') }
    }
  }
  const tmp = () => mkdtempSync(join(tmpdir(), 'wk-out-'))
  const read = (d: string, f: string) => readFileSync(join(d, '.well-known', f), 'utf8')
  const apexOut = join(tree, 'site', '.well-known')

  // templates: valid JSON, each carries its placeholder, the real app id
  for (const f of ['assetlinks.json', 'apple-app-site-association']) {
    const t = readFileSync(join(tree, TPL_DIR, f), 'utf8')
    let parsed: unknown = null
    try { parsed = JSON.parse(t) } catch { /* */ }
    ok(parsed, `${f}: template is valid JSON`)
    ok(/__[A-Z0-9_]+__/.test(t), `${f}: template is marked with a placeholder`)
    ok(t.includes('page.bento.home'), `${f}: names the bento/home app (page.bento.home)`)
  }
  // these files are the RP's and nothing else: universal links (applinks) or
  // URL handling would belong to whichever host they link, not to id.bento.page
  {
    const aasa = JSON.parse(readFileSync(join(tree, TPL_DIR, 'apple-app-site-association'), 'utf8'))
    ok(JSON.stringify(Object.keys(aasa)) === '["webcredentials"]', 'AASA template carries webcredentials only')
    const al = JSON.parse(readFileSync(join(tree, TPL_DIR, 'assetlinks.json'), 'utf8'))
    ok(al.length === 1 && JSON.stringify(al[0].relation) === '["delegate_permission/common.get_login_creds"]', 'assetlinks template carries get_login_creds only')
  }

  // the rp host is id.bento.page, in the export and in the Apple CDN URL
  {
    const mod = await import(pathToFileURL(join(tree, SCRIPT)).href + `?t=${Date.now()}`)
    ok(mod.RP_HOST === 'id.bento.page', `RP_HOST is id.bento.page (got ${mod.RP_HOST})`)
    ok(mod.APPLE_CDN_URL === 'https://app-site-association.cdn-apple.com/a/v1/id.bento.page', `Apple CDN URL is for id.bento.page (got ${mod.APPLE_CDN_URL})`)
    const src = readFileSync(join(tree, SCRIPT), 'utf8')
    ok(src.includes('cdn-apple.com/a/v1/id.bento.page') && !/cdn-apple\.com\/a\/v1\/bento\.page/.test(src), 'the serving note names the Apple CDN URL for id.bento.page, not the apex')
  }

  // no values: checks the templates, writes nothing, needs no --out
  {
    const d = tmp()
    const r = run(['--out', d])
    ok(r.code === 0 && !existsSync(join(d, '.well-known')), 'no values → nothing written')
    ok(run([]).code === 0 && !existsSync(apexOut), 'no values, no --out → templates checked, nothing written')
    rmSync(d, { recursive: true, force: true })
  }

  // both values: exact, placeholder-free, valid JSON with the right shapes
  {
    const d = tmp()
    const r = run(['--out', d, '--apple-team', TEAM, '--play-sha256', FP.toLowerCase()])
    ok(r.code === 0, `both values → success (${r.out.trim()})`)
    try {
      const aasa = JSON.parse(read(d, 'apple-app-site-association'))
      ok(JSON.stringify(aasa.webcredentials.apps) === JSON.stringify([`${TEAM}.page.bento.home`]), 'AASA: webcredentials app is TEAMID.page.bento.home')
      const al = JSON.parse(read(d, 'assetlinks.json'))
      ok(al[0].relation.includes('delegate_permission/common.get_login_creds'), 'assetlinks: get_login_creds (passkeys)')
      ok(al[0].target.package_name === 'page.bento.home', 'assetlinks: package page.bento.home')
      ok(al[0].target.sha256_cert_fingerprints[0] === FP, 'assetlinks: fingerprint normalised to uppercase')
      for (const f of ['assetlinks.json', 'apple-app-site-association']) ok(!/__[A-Z0-9_]+__/.test(read(d, f)), `${f}: no placeholder in the output`)
    } catch (e) { ok(false, `both values → files readable (${(e as Error).message})`) }
    rmSync(d, { recursive: true, force: true })
  }

  // one value: writes ONLY that file (M1 and M2 may arrive at different times)
  {
    const d = tmp()
    ok(run(['--out', d, '--apple-team', TEAM]).code === 0, 'Apple id only → success')
    ok(existsSync(join(d, '.well-known/apple-app-site-association')) && !existsSync(join(d, '.well-known/assetlinks.json')), 'Apple id only → assetlinks.json NOT written')
    rmSync(d, { recursive: true, force: true })
  }

  // wrong shapes are refused, and refusal writes nothing — even beside a good value
  for (const [flag, bad, name] of [
    ['--apple-team', 'abc', 'short team id'], ['--apple-team', '__APPLE_TEAM_ID__', 'the placeholder itself'],
    ['--play-sha256', 'AA:BB', 'short fingerprint'], ['--play-sha256', FP.replace(/:/g, ''), 'fingerprint without colons'],
    ['--play-sha256', '__PLAY_APP_SIGNING_SHA256__', 'the placeholder itself'],
  ]) {
    const d = tmp()
    const r = run(['--out', d, flag, bad])
    ok(r.code !== 0 && !existsSync(join(d, '.well-known')), `refused: ${name}`)
    rmSync(d, { recursive: true, force: true })
  }
  {
    const d = tmp()
    const r = run(['--out', d, '--apple-team', TEAM, '--play-sha256', 'AA:BB'])
    ok(r.code !== 0 && !existsSync(join(d, '.well-known')), 'a good Apple id beside a bad fingerprint → refused, NOTHING written')
    rmSync(d, { recursive: true, force: true })
  }

  // never the apex: no default output, and the bento.page site tree is refused
  {
    const r = run(['--apple-team', TEAM])
    ok(r.code !== 0 && /--out/.test(r.out) && !existsSync(apexOut), `values without --out → refused, nothing in site/ (${r.out.trim().slice(0, 60)})`)
    mkdirSync(join(tree, 'site'), { recursive: true })
    const s = run(['--out', join(tree, 'site'), '--apple-team', TEAM])
    ok(s.code !== 0 && !existsSync(apexOut), 'the site/ staging directory → refused, nothing written')
    for (const marker of ['CNAME', '_redirects', 'slides']) {
      const d = tmp()
      if (marker === 'slides') mkdirSync(join(d, marker)); else writeFileSync(join(d, marker), 'bento.page\n')
      const m = run(['--out', d, '--apple-team', TEAM])
      ok(m.code !== 0 && !existsSync(join(d, '.well-known')), `a directory carrying the apex's ${marker} → refused`)
      rmSync(d, { recursive: true, force: true })
    }
  }
  return { passes, fails }
}

const S = SCRIPT, A = `${TPL_DIR}/apple-app-site-association`
const MUTANTS: [string, Mut[]][] = [
  ['the old apex default (out = site/, no guard)', [
    { file: S, from: "const out = arg('--out')", to: "const out = arg('--out') ?? join(root, 'site')" },
    { file: S, from: 'export function apexReason(dir) {', to: "export function apexReason(dir) {\n  return ''" },
  ]],
  ['the apex guard off', [{ file: S, from: 'export function apexReason(dir) {', to: "export function apexReason(dir) {\n  return ''" }]],
  ['the rp back on bento.page', [{ file: S, from: "export const RP_HOST = 'id.bento.page'", to: "export const RP_HOST = 'bento.page'" }]],
  ['the Apple CDN note back on the apex', [{ file: S, from: 'cdn-apple.com/a/v1/id.bento.page', to: 'cdn-apple.com/a/v1/bento.page' }]],
  ['any value accepted as a team id', [{ file: S, from: 'valid: /^[A-Z0-9]{10}$/', to: 'valid: /./' }]],
  ['a partial write on a bad value', [{ file: S, from: 'const texts = kinds.map((k) => [k, fill(k, given[k])])', to: 'const texts = []; for (const k of kinds) { try { texts.push([k, fill(k, given[k])]) } catch (e) { const d0 = join(out, \'.well-known\'); mkdirSync(d0, { recursive: true }); for (const [k2, t2] of texts) writeFileSync(join(d0, FILES[k2].name), t2); throw e } }' }]],
  ['applinks added to the rp AASA', [{ file: A, from: '"webcredentials": {', to: '"applinks": { "details": [] },\n  "webcredentials": {' }]],
]

let bad = 0
const control = makeTree()
const c = await suite(control)
rmSync(control, { recursive: true, force: true })
for (const f of c.fails) console.log('FAIL control: ' + f)
console.log(`control: ${c.passes} passed, ${c.fails.length} failed`)
if (c.fails.length) bad++
if (c.passes < 30) { console.log(`FAIL control ran only ${c.passes} checks — the suite did not execute`); bad++ }

// the real tree: templates live with the rp host, not in the apex sources
const realOk = existsSync(join(repo, TPL_DIR, 'apple-app-site-association')) && !existsSync(join(repo, 'site-src/well-known'))
console.log(`${realOk ? 'ok  ' : 'FAIL'} templates are in ${TPL_DIR}, and site-src/well-known is gone`)
if (!realOk) bad++

for (const [name, muts] of MUTANTS) {
  const t = makeTree(muts)
  const r = await suite(t)
  rmSync(t, { recursive: true, force: true })
  if (r.fails.length) console.log(`ok   mutant caught (${r.fails.length} check(s)): ${name} — first: ${r.fails[0]}`)
  else { console.log(`FAIL mutant SURVIVED: ${name}`); bad++ }
}
console.log(bad ? `${bad} problem(s)` : `all good: control clean, ${MUTANTS.length}/${MUTANTS.length} mutants caught`)
process.exit(bad ? 1 : 0)
