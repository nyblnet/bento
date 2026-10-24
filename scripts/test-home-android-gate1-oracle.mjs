// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// GATE 1's BROWSER ORACLE on Android WebView (security, after #825): the
// Android port's twin of scripts/test-gate1-oracle.mjs. Different engine,
// different tokenizer: Chromium agreeing with the reference says nothing about
// what Android's WebView runs.
//
// It takes kernel's mutant generator VERBATIM, lifted from
// test-gate1-oracle.mjs at run time so the two can never drift, and runs the
// same fixed seed plus a printed random one. Every mutant goes to the device
// with the REFERENCE's verdict. The debug-only Gate1OracleActivity then gives
// Gate1.kt's verdict for each, and loads every GENUINE one in a WebView with NO
// CSP, recording what ran. Three checks:
//   - every file Gate1.kt calls GENUINE runs exactly the loader and remover;
//   - Gate1.kt agrees with the reference on every mutant (a differential check);
//   - the controls: the oracle SEES an extra script and an executing data block.
//
//   node scripts/test-home-android-gate1-oracle.mjs [--cases N] [--random N] [--seed N]
//
// Needs a connected emulator or device, with the DEBUG build installed
// (./gradlew installDebug in home/android). CI's runners have no Android
// device, so it skips there (scripts/lib/ci-skips.mjs).

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyServed } from '../kernel/src/gate1.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d }
const FIXED_SEED = opt('seed', 20261021), CASES = opt('cases', 400), RANDOM = opt('random', 100)
const PKG = 'page.bento.home'

const adb = (...a) => execFileSync('adb', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let devices = ''
try { devices = adb('devices').split('\n').slice(1).filter((l) => /\tdevice$/.test(l)).join('\n') } catch {}
if (!devices) {
  console.log('android gate1 oracle: SKIPPED — no Android device or emulator connected')
  process.exit(0)
}
if (!adb('shell', 'pm', 'path', PKG).includes('package:')) {
  console.log(`android gate1 oracle: FAIL — ${PKG} is not installed; run ./gradlew installDebug in home/android`)
  process.exit(1)
}

// --- kernel's generator, verbatim ---------------------------------------------------
const oracleSrc = readFileSync(join(root, 'scripts/test-gate1-oracle.mjs'), 'utf8')
const from = oracleSrc.indexOf('// --- a synthetic release'), to = oracleSrc.indexOf('// --- the browser')
if (from < 0 || to < 0) { console.log('android gate1 oracle: FAIL — cannot find the generator in test-gate1-oracle.mjs'); process.exit(1) }
const work = mkdtempSync(join(tmpdir(), 'bento-gate1-oracle-'))
writeFileSync(join(work, 'gen.mjs'), `import { createHash } from 'node:crypto'\n${oracleSrc.slice(from, to)}\nexport { genuine, history, mutant, rng, LOADER, S }\n`)
const { genuine, history, mutant, rng, S } = await import(pathToFileURL(join(work, 'gen.mjs')).href)

// --- the cases ----------------------------------------------------------------------
const cases = []
const add = async (name, html, control = false) => {
  const v = await verifyServed(html, history)
  writeFileSync(join(work, `${name}.html`), html)
  cases.push({ file: `${name}.html`, ref: v.verdict, control })
}
await add('control-genuine', genuine(), true)
await add('control-extra', genuine().replace('</body>', `<${S}>window.__ran.push('extra')</${S}></body>`), true)
await add('control-data-executes', genuine().replace('type="bento/deflate-b86" id="bento-rt"', 'id="bento-rt"'), true)
const randomSeed = Math.floor(Math.random() * 2 ** 31)
for (const [seed, n] of [[FIXED_SEED, CASES], [randomSeed, RANDOM]]) {
  const r = rng(seed)
  for (let k = 0; k < n; k++) await add(`seed-${seed}-case-${k}`, mutant(r, k).html)
}
writeFileSync(join(work, 'index.json'), JSON.stringify(cases))
writeFileSync(join(work, 'history.json'), JSON.stringify(history))
console.log(`android gate1 oracle: ${cases.length} cases (fixed seed ${FIXED_SEED} × ${CASES}, random seed ${randomSeed} × ${RANDOM})`)

// --- to the device, run, collect ---------------------------------------------------
const dev = '/data/local/tmp/bento-gate1-oracle'
adb('shell', 'rm', '-rf', dev)
adb('push', work, dev)
const pushed = dev // a push to a path that doesn't exist yet copies the folder's CONTENTS there
adb('shell', `run-as ${PKG} sh -c 'rm -rf files/oracle; mkdir -p files/oracle'`)
adb('shell', `cd ${pushed} && for f in *; do cat "$f" | run-as ${PKG} sh -c "cat > files/oracle/$f"; done`)
adb('shell', 'am', 'force-stop', PKG)
adb('shell', 'am', 'start', '-n', `${PKG}/.Gate1OracleActivity`)
let out = ''
for (let i = 0; i < 600 && !out; i++) {
  try { out = adb('shell', 'run-as', PKG, 'cat', 'files/oracle/results.json') } catch {}
  if (!out) execFileSync('sleep', ['1'])
}
adb('shell', 'am', 'force-stop', PKG)
if (!out) { console.log('android gate1 oracle: FAIL — no results from the device within 10 minutes'); process.exit(1) }
const results = JSON.parse(out)

let failures = 0, checks = 0
const ok = (c, m) => { checks++; if (c) console.log('  ok    ' + m); else { failures++; console.log('  FAIL  ' + m) } }
const onlyPinned = (r) => r.errors === 0 && r.ran?.length === 2 && r.ran.includes('loader') && r.ran.includes('remover')
const get = (f) => results.find((r) => r.file === f)

console.log('\ncontrols: the oracle can see both kinds of extra execution')
ok(onlyPinned(get('control-genuine.html')), `a genuine file runs exactly the loader and the remover (${JSON.stringify(get('control-genuine.html'))})`)
ok(get('control-extra.html')?.ran?.includes('extra'), 'an extra script is SEEN running')
ok(get('control-data-executes.html')?.errors > 0, 'a data block that executes is SEEN (its text throws)')
ok(get('control-genuine.html')?.kotlin === 'genuine', 'Gate1.kt calls the genuine file genuine')

const mutants = results.filter((r) => !r.control)
const disagree = mutants.filter((r) => r.kotlin !== r.ref)
for (const d of disagree.slice(0, 5)) console.log(`        disagreement: ${d.file}: reference ${d.ref}, Gate1.kt ${d.kotlin}`)
ok(disagree.length === 0, `Gate1.kt agrees with the reference on all ${mutants.length} mutants`)
const genuineRows = mutants.filter((r) => r.kotlin === 'genuine')
const bad = genuineRows.filter((r) => !onlyPinned(r))
for (const b of bad.slice(0, 5)) {
  mkdirSync(join(root, 'home/fixtures/gate1/oracle-failures'), { recursive: true })
  writeFileSync(join(root, 'home/fixtures/gate1/oracle-failures', `android-${b.file}`), readFileSync(join(work, b.file)))
  console.log(`        WebView ran ${JSON.stringify(b.ran)} (errors ${b.errors}) for ${b.file}`)
}
ok(bad.length === 0, `every one of the ${genuineRows.length} GENUINE verdicts ran only the loader and remover in Android WebView`)
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
