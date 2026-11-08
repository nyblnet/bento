#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Under CI, a rig that reports a skip fails its step (scripts/lib/ci-skips.mjs,
// enforced by scripts/ci/bento-step). This rig is that rule's positive control.
//
//   node scripts/test-ci-skips.mjs
//
// A rule that fails on skips can itself pass vacuously, in three ways, and
// each has a section here:
//   1. the detector misses a skip shape. Fixtures are the EXACT lines the rigs
//      printed in a real main run (39144711453), plus lines that only mention
//      skipping and must stay green;
//   2. the wrapper does not actually turn a skip red. It is run end to end on
//      scripts that skip, and must exit non-zero;
//   3. a step is not run through the wrapper at all. Every rig step in every
//      CI file must be.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALLOWED_SKIPS, MAC_JOB, check, isSkipLine } from './lib/ci-skips.mjs'
import { ciFiles } from './lib/ci-files.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

console.log('the detector: every skip shape the rigs actually printed in CI')
const REAL = [
  ['scripts/test-enc-title.ts', '— skipped: jsdom is not installed —'],
  ['scripts/test-type-preview.ts', '— skipped: jsdom is not installed —'],
  ['scripts/test-type-font.ts', '  --    skipped: jsdom is not installed (the browser check below covers it)'],
  ['scripts/test-tray-releases.mjs', 'tray releases: SKIPPED — no CryptoKit on this machine (Apple platforms only).'],
  ['scripts/test-home-origin.mjs', 'home origin: SKIPPED — no CryptoKit on this machine (Apple platforms only).'],
  ['scripts/test-home-docstore-ios.mjs', 'home docstore (iOS): SKIPPED — no Swift toolchain with the Security framework here.'],
  ['scripts/test-home-id-keys.mjs', 'home id keys: SKIPPED — needs an Apple toolchain (CryptoKit, Security).'],
  ['scripts/test-dash-zip.ts', '  SKIP  no real .xlsx on this machine to read'],
  ['scripts/test-dash-xlsx.ts', '  SKIP  LibreOffice is not installed — the "does it open" check needs it'],
  ['scripts/test-dash-xlsx.ts', '  SKIP  no real .xlsx to import'],
]
for (const [, line] of REAL) ok(isSkipLine(line), `flagged: ${line.trim()}`)
// Other shapes in the rigs' source, not seen in CI today.
for (const line of [
  '  ⚠ SKIPPED — no Chrome found. Set BENTO_CHROME to a binary to run this section;',
  '  skip  needs Chrome (BENTO_CHROME) and the built shell (spaces/dist-single/Bento_Spaces.bento.html)',
  '  ..    skipped real-shell checks (no dist-single build present)',
  '0/0 checks passed (skipped)',
]) ok(isSkipLine(line), `flagged: ${line.trim()}`)

console.log('\nthe detector: lines ABOUT skipping are checks, not skips (all from that run)')
for (const line of [
  '  ok    a lapsed folder is skipped rather than throwing, so one bad grant cannot empty the list',
  '  ok    next, from ON a change, SKIPS it and finds the next one — so pressing next twice always advances',
  '=== a SKIPPED level numbers with a zero, and is not promoted ===',
  '  ✓ an ARCHIVED page is skipped, as the sidebar leaves it out',
  '  ok    the sync shape skips trail (and revisions) outright',
  'docContentKey: counts content + history, excludes capability + bookkeeping, skips absent',
  '    (planted builder that skips projectForCopy — these rows MUST fail:)',
  'indentTarget — Tab, including every case a happy path skips',
  '=== the skipDoc floor is checked first at the gate too (defence in depth) ===',
]) ok(!isSkipLine(line), `not flagged: ${line.trim()}`)

console.log('\nthe allowlist: who may skip, and only with their own rig')
const mac = process.platform === 'darwin'
for (const [rig, line] of REAL) {
  const [f] = check(`node ${rig}`, line)
  const allowed = /dash-(xlsx|zip)/.test(rig) || (!mac && /tray-releases|home-origin|home-docstore-ios|home-id-|home-spotlight/.test(rig))
  ok(!!f && !!f.entry === allowed, `${allowed ? 'allowed' : 'REFUSED'}: ${rig} — ${line.trim().slice(0, 50)}`)
}
const [borrowed] = check('node scripts/test-enc-title.ts', '  SKIP  LibreOffice is not installed — the "does it open" check needs it')
ok(!!borrowed && !borrowed.entry, "a dash rig's allowed skip line, printed by ANOTHER rig's step, is refused")
for (const a of ALLOWED_SKIPS) {
  // An entry whose rig is gone, or whose rig no longer prints the line, is a
  // hole with no reason left. Both are checked rather than trusted.
  const p = join(root, a.rig)
  ok(existsSync(p), `${a.rig} still exists, so its entry is about something`)
  ok(existsSync(p) && a.line.test(readFileSync(p, 'utf8')), `${a.rig} still prints ${a.line}`)
  ok(typeof a.why === 'string' && a.why.length > 40, `${a.rig}: the entry says why CI cannot provide what it needs`)
}

// An Apple-only rig may skip on Linux ONLY because the macOS job runs it for
// real. If it is not in that job, it runs nowhere, and its entry is a hole.
const macJob = existsSync(join(root, MAC_JOB)) ? readFileSync(join(root, MAC_JOB), 'utf8') : ''
for (const a of ALLOWED_SKIPS.filter((x) => x.when)) {
  const base = a.rig.replace(/^scripts\//, '')
  ok(/runs-on: macos/.test(macJob) && macJob.includes(base), `${base} may skip off macOS because ${MAC_JOB} runs it on macOS`)
}

console.log('\nthe wrapper: a skip turns the step red, end to end')
const step = join(root, 'scripts/ci/bento-step')
const tmp = mkdtempSync(join(tmpdir(), 'ci-skips-'))
function runStep(body) {
  const f = join(tmp, `step-${checks}.sh`)
  writeFileSync(f, body)
  return spawnSync('bash', [step, f], { encoding: 'utf8', cwd: root })
}
try {
  let r = runStep('echo "  ok    a check"\necho "1/1 checks passed"\n')
  ok(r.status === 0, `a clean step passes (exit ${r.status})`)
  r = runStep('# node scripts/test-enc-title.ts\necho "— skipped: jsdom is not installed —"\n')
  ok(r.status === 1, `a step whose rig skipped FAILS (exit ${r.status})`)
  ok(/::error::a rig skipped under CI/.test(r.stdout), 'and says so as a CI error annotation')
  r = runStep('# node scripts/test-dash-xlsx.ts\necho "  SKIP  LibreOffice is not installed — the \\"does it open\\" check needs it"\n')
  ok(r.status === 0, `an allowlisted skip passes (exit ${r.status})`)
  ok(/::notice::allowed skip/.test(r.stdout), 'and is still reported, as a notice')
  r = runStep('echo "  SKIP  unexplained"\nexit 3\n')
  ok(r.status === 3, `a failing step keeps its own exit code (exit ${r.status})`)
  r = runStep('false | true\necho "  ok    reached"\n')
  ok(r.status !== 0, `pipefail holds, as under shell: bash (exit ${r.status})`)
  r = runStep('false\necho "  ok    reached"\n')
  ok(r.status !== 0 && !/reached/.test(r.stdout), `-e holds: the first failing command ends the step (exit ${r.status})`)
  // The real thing, when a rig can be made to skip: the encrypted-title rig with
  // jsdom made unresolvable (its import is caught and it prints the skip).
  // Driven through the same wrapper.
  r = runStep('node --import "data:text/javascript,import{registerHooks}from\'node:module\';registerHooks({resolve(s,c,n){if(s===\'jsdom\')throw new Error(\'hidden\');return n(s,c)}})" scripts/test-enc-title.ts\n')
  ok(/skipped: jsdom is not installed/.test(r.stdout), 'the encrypted-title rig, with jsdom hidden, prints its skip line')
  ok(r.status === 1, `and the wrapper turns that real rig's step RED (exit ${r.status})`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log('\nthe wiring: every rig step runs through the wrapper')
const files = ciFiles(root)
for (const a of files.usedActions) {
  const steps = a.text.split(/\n(?=    - )/).filter((s) => /^      run:/m.test(s))
  const bare = steps.filter((s) => !/^      shell: bento-step \{0\}$/m.test(s))
  ok(steps.length > 0 && bare.length === 0,
    `${a.path}: all ${steps.length} run steps use shell: bento-step {0}${bare.length ? ` (not: ${bare.map((s) => (s.match(/name: (.*)/) || [])[1]).join(', ')})` : ''}`)
}
const ci = files.workflows.find((w) => w.path.endsWith('/ci.yml'))
ok(!!ci && /echo "\$GITHUB_WORKSPACE\/scripts\/ci" >> "\$GITHUB_PATH"/.test(ci.text) &&
  ci.text.indexOf('scripts/ci" >> "$GITHUB_PATH"') < ci.text.indexOf('uses: ./.github/actions/validate-'),
  'ci.yml puts scripts/ci on PATH before the first validate slice')
ok(!!ci && /jsdom@\d+\.\d+\.\d+/.test(ci.text), 'ci.yml installs a pinned jsdom for the DOM halves')
for (const w of files.workflows) {
  if (!/^name: CI \(/m.test(w.text) || !/node scripts\//.test(w.text)) continue
  if (w.path.endsWith('ci-home-android.yml')) continue // Gradle prints SKIPPED as a task outcome; see that file
  if (w.path.endsWith('ci-home-ios.yml')) continue // macOS jobs with their own skip check (#777), where nothing may skip
  ok(/^defaults:\n  run:\n(?:    #.*\n)*    shell: bash scripts\/ci\/bento-step \{0\}$/m.test(w.text) && !/^\s+shell: bash\s*$/m.test(w.text),
    `${w.path}: its jobs run through bento-step`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
