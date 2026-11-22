#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * scripts/sign-home-status.mjs against the bento/home release list: the kill
 * switch (status.json, by build id) and the tripwire's list (served.json, by
 * release time) must name the same withdrawn releases. The signer takes the
 * published list (--served) as the one source and refuses, writing nothing,
 * when the two disagree.
 *
 *   node scripts/test-home-status-sign.mjs             the rows
 *   node scripts/test-home-status-sign.mjs --mutants   each mutant must turn its row red
 *
 * Two real home/web development builds (different frame origins, which the
 * library's script names, so their build ids differ; the library origin alone
 * does not change the script, measured) are described by the same code that
 * signs served.json (scripts/lib/home-web-served.mjs); every key is a
 * throwaway made here.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { describeBuild, nextServed } = await import(path.join(ROOT, 'scripts/lib/home-web-served.mjs'))
const { envelopeJson, releasePublicKey, signPayload, verifyEnvelope } = await import(path.join(ROOT, 'scripts/sign-payload.mjs'))
const SIGNER = path.join(ROOT, 'scripts/sign-home-status.mjs')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-status-sign-'))
const cleanup = []
process.on('exit', () => { fs.rmSync(work, { recursive: true, force: true }); for (const f of cleanup) fs.rmSync(f, { force: true }) })

// --- keys -----------------------------------------------------------------------
const keyFile = (name) => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const f = path.join(work, `${name}.json`)
  const pub = publicKey.export({ format: 'jwk' })
  fs.writeFileSync(f, JSON.stringify({ public: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, private: privateKey.export({ format: 'jwk' }) }))
  return f
}
const KEY = keyFile('key'), EVIL = keyFile('evil')
// the release key's PUBLIC half with a throwaway private half: the signer recognises the
// release key by its public half, so this reaches the release-key rules (and could never sign)
const RELEASE_LOOKALIKE = path.join(work, 'release-lookalike.json')
{ const k = JSON.parse(fs.readFileSync(EVIL, 'utf8')); const rk = releasePublicKey(); fs.writeFileSync(RELEASE_LOOKALIKE, JSON.stringify({ public: { kty: rk.kty, crv: rk.crv, x: rk.x, y: rk.y }, private: k.private })) }
const pubOf = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).public

// --- two real builds --------------------------------------------------------------
function build(name, frameOrigin) {
  const out = path.join(work, name)
  execFileSync(process.execPath, [path.join(ROOT, 'home/web/build.mjs'), '--out', out, '--library-origin', 'http://127.0.0.1:1',
    '--frame-origin', frameOrigin, '--release-base', 'http://127.0.0.1:9/releases/', '--dev'], { stdio: ['ignore', 'ignore', 'inherit'] })
  return out
}
const dirA = build('A', 'http://localhost:1'), dirB = build('B', 'http://localhost:2')
const DAY = 86400e3
const relA = await describeBuild(dirA, new Date(Date.now() - 10 * DAY).toISOString())
const relB = await describeBuild(dirB, new Date().toISOString())
const idOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8')).offline.build
const idA = idOf(dirA), idB = idOf(dirB)

const writeList = (name, list, key = KEY) => { const f = path.join(work, `${name}.json`); fs.writeFileSync(f, envelopeJson(signPayload(JSON.stringify(list), key))); return f }
const list1 = nextServed(null, relA) // [A]
const list2 = nextServed(list1, relB) // [B, A]
const list2w = nextServed(list1, relB, undefined, { withdraw: [relA.at] }) // [B, A withdrawn]
const L1 = writeList('list1', list1), L2 = writeList('list2', list2), L2W = writeList('list2w', list2w)
const L2W_EVIL = writeList('list2w-evil', list2w, EVIL)
const twoScripts = structuredClone(list2w)
twoScripts.releases[1].origins[Object.keys(twoScripts.releases[1].origins).find((o) => twoScripts.releases[1].origins[o].role === 'library')].files['/'].scripts.push({ sha256: 'e'.repeat(64) })
const L2W_TWO = writeList('list2w-two-scripts', twoScripts)
const NOT_A_LIST = writeList('not-a-list', { app: 'bento-home-status', seq: 1, withdrawn: [] })

// --- rows -------------------------------------------------------------------------
let signer = SIGNER
let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; if (!quiet) console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
let quiet = false
let n = 0
/** Run the signer; returns { status, out (the file it wrote, or null), err }. */
function sign(args, key = KEY) {
  const out = path.join(work, `out-${++n}.json`)
  const r = spawnSync(process.execPath, [signer, '--key', key, '--out', out, ...args], { encoding: 'utf8' })
  return { status: r.status, out: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null, err: (r.stderr ?? '').trim() }
}
const payloadOf = (r, key = KEY) => { try { return verifyEnvelope(r.out, pubOf(key)) } catch { return null } }
const refused = (r) => r.status === 2 && r.out === null
const ROWS = {
  'build-id': () => {
    // positive control on the field the signer reads: the list's library `/` script IS the build id
    const lib = (rel) => Object.values(rel.origins).find((o) => o.role === 'library').files['/'].scripts
    ok(/^[0-9a-f]{64}$/.test(idA) && idA !== idB, `two builds, two build ids (${idA.slice(0, 12)}…, ${idB.slice(0, 12)}…)`)
    ok(lib(relA).length === 1 && lib(relA)[0].sha256 === idA && lib(relB)[0].sha256 === idB, 'served.json\'s library / scripts[0].sha256 is build.json\'s offline.build, for both')
    ok(!('withdrawn' in list2.releases[1]) && list2w.releases[1].withdrawn === true, 'the fixtures: an unwithdrawn release carries NO withdrawn field; the withdrawn one carries true')
  },
  'disagree': () => {
    const r = sign(['--served', L2W])
    ok(refused(r) && /withdraws a release this status does not/.test(r.err) && r.err.includes(idA), `the list withdraws A, the status leaves A's build out: refused, nothing written (exit ${r.status}: ${r.err.slice(0, 90)})`)
  },
  'agree': () => {
    const r = sign(['--served', L2W, '--withdraw', idA])
    const p = payloadOf(r)
    ok(r.status === 0 && p?.app === 'bento-home-status' && p.seq === 1 && p.withdrawn.length === 1 && p.withdrawn[0] === idA, `the same with A's build withdrawn: signed, and the output verifies (exit ${r.status}, ${JSON.stringify(p?.withdrawn)}) ${r.err}`)
  },
  'list-other-key': () => {
    const r = sign(['--served', L2W_EVIL, '--withdraw', idA])
    ok(refused(r) && /INVALID/.test(r.err), `a list signed by another key: refused (exit ${r.status}: ${r.err.slice(0, 90)})`)
  },
  'none-withdrawn': () => {
    const r = sign(['--served', L2])
    const p = payloadOf(r)
    ok(r.status === 0 && p?.withdrawn.length === 0, `a list with no withdrawn release (the field absent): signs an empty status (exit ${r.status}) ${r.err}`)
  },
  'from-agrees': () => {
    const prev = path.join(work, 'prev.json')
    fs.writeFileSync(prev, envelopeJson(signPayload(JSON.stringify({ app: 'bento-home-status', seq: 7, at: new Date().toISOString(), withdrawn: [idA] }), KEY)))
    const r = sign(['--served', L2W, '--from', prev])
    const p = payloadOf(r)
    ok(r.status === 0 && p?.seq === 8 && p.withdrawn.join() === idA, `--from a status that already withdraws A, and a list that agrees: seq 7 → ${p?.seq} (exit ${r.status}) ${r.err}`)
  },
  'withdraws-current': () => {
    const r = sign(['--served', L1, '--withdraw', idA])
    ok(refused(r) && /serves as current/.test(r.err), `withdrawing the build the list still serves as current: refused (exit ${r.status}: ${r.err.slice(0, 90)})`)
  },
  'withdraws-unmarked': () => {
    const r = sign(['--served', L2, '--withdraw', idA])
    ok(refused(r) && /does not withdraw/.test(r.err), `withdrawing a build the list carries but does not withdraw: refused (exit ${r.status}: ${r.err.slice(0, 90)})`)
  },
  'withdraws-unknown': () => {
    const old = 'c'.repeat(64)
    const r = sign(['--served', L2W, '--withdraw', idA, '--withdraw', old])
    ok(r.status === 0 && payloadOf(r)?.withdrawn.includes(old), `a build the list no longer carries may still be withdrawn (exit ${r.status}) ${r.err}`)
  },
  'release-key-needs-list': () => {
    const r = sign(['--withdraw', idA], RELEASE_LOOKALIKE)
    ok(refused(r) && /--served .* is required with the release key/.test(r.err), `the release key without --served: refused (exit ${r.status}: ${r.err.slice(0, 90)})`)
    const s = sign(['--served', L2W, '--withdraw', idA], RELEASE_LOOKALIKE)
    ok(refused(s) && /INVALID/.test(s.err), `the release key with a list signed by another key: refused (exit ${s.status}: ${s.err.slice(0, 90)})`)
  },
  'not-a-list': () => {
    const r = sign(['--served', NOT_A_LIST])
    ok(refused(r) && /is not a v1 bento\/home release list/.test(r.err), `a signed payload that is not a release list: refused (exit ${r.status}: ${r.err.slice(0, 90)})`)
  },
  'no-build-id': () => {
    const r = sign(['--served', L2W_TWO, '--withdraw', idA])
    ok(refused(r) && /has no build id/.test(r.err), `a release whose library page carries two scripts has no build id: refused (exit ${r.status}: ${r.err.slice(0, 90)})`)
  },
}

if (!process.argv.includes('--mutants')) {
  for (const [name, fn] of Object.entries(ROWS)) { console.log(`\n=== ${name}`); fn() }
  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

// --- mutants: each must turn its row red ----------------------------------------
const MUTANTS = [
  { name: 'the cross-check skipped', row: 'disagree', from: 'if (missing.length) die(', to: 'if (false) die(' },
  { name: 'the build id read from the wrong script', row: 'agree', from: 'scripts[0]?.sha256', to: 'scripts[1]?.sha256' },
  { name: 'the build id read from the wrong file', row: 'agree', from: "lib[0].files?.['/']?.scripts", to: "lib[0].files?.['/sw.js']?.scripts" },
  { name: 'the list\'s signature not verified', row: 'list-other-key', from: "verifyEnvelope(readFileSync(servedPath, 'utf8'), isRelease ? rk : keyFile.public)", to: "JSON.parse(JSON.parse(readFileSync(servedPath, 'utf8')).payload)" },
  { name: 'the current build may be withdrawn', row: 'withdraws-current', from: 'if (current.length) die(', to: 'if (false) die(' },
  { name: 'a build the list does not withdraw may be', row: 'withdraws-unmarked', from: 'if (unmarked.length) die(', to: 'if (false) die(' },
  { name: 'the release key signs without a list', row: 'release-key-needs-list', from: 'if (isRelease && !servedPath) die(', to: 'if (false) die(' },
  { name: 'withdrawn read as present, not true', row: 'none-withdrawn', from: "if (r.withdrawn === true && !withdrawn.has(id))", to: "if (r.withdrawn !== false && !withdrawn.has(id))" },
]
const src = fs.readFileSync(SIGNER, 'utf8')
// control: every row green unmutated
quiet = true
for (const fn of Object.values(ROWS)) fn()
if (failures) { console.log(`FAIL: ${failures} row check(s) red without a mutant`); process.exit(1) }
console.log(`  ok    control: ${checks}/${checks} unmutated`)
let bad = 0
for (const m of MUTANTS) {
  const hits = src.split(m.from).length - 1
  if (hits !== 1) { bad++; console.log(`  FAIL  ${m.name}: "${m.from}" occurs ${hits} times (NOT APPLIED)`); continue }
  // beside the real one, so its relative imports resolve
  signer = path.join(ROOT, 'scripts', `.mutant-sign-home-status-${process.pid}.mjs`)
  cleanup.push(signer)
  fs.writeFileSync(signer, src.replace(m.from, () => m.to))
  checks = 0; failures = 0
  ROWS[m.row]()
  const red = failures > 0
  if (!red) bad++
  console.log(`  ${red ? 'ok  ' : 'FAIL'}  ${m.name} → row ${m.row} ${red ? 'red' : 'GREEN'}`)
  fs.rmSync(signer, { force: true })
}
console.log(`\n${MUTANTS.length - bad}/${MUTANTS.length} mutants red on their row`)
process.exit(bad ? 1 : 0)
