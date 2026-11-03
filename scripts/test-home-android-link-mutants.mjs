#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

/**
 * Do the Android link rigs notice when the link code is wrong?
 *
 * Applies one mutation at a time to home/android's Link.kt / LinkFlow.kt, runs LinkTest and
 * LinkFlowTest, and requires the run to FAIL. A mutation that leaves the rigs green is a hole in
 * the rigs. Each run first checks the mutation actually landed (the `from` text is in the file
 * exactly once) and that the unmutated build is green (the control), and always restores the file.
 * Gradle runs with --rerun-tasks so a cached result cannot stand in for a run.
 *
 *   node scripts/test-home-android-link-mutants.mjs [--only N]
 *
 * Not a CI rig: one Gradle run per mutant. Run it when Link.kt or LinkFlow.kt changes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'home/android/app/src/main/java/page/bento/home')
const L = 'Link.kt', F = 'LinkFlow.kt'
const MUTANTS = [
  [L, 'a scanner proceeds whatever the roles are', 'if (roleD == Role.H) !scannerHoldsAccount else scannerHoldsAccount', 'true'],
  [L, 'N does not check the dev. names its own device key', 'if (n.devicePub != offer.devicePub) return no("device-mismatch")', ''],
  [L, 'N does not check the dev. names its consent key', 'if (n.consentPub != offer.consentPub) return no("consent-mismatch")', ''],
  [L, 'the AAD drops the message number', 'fun aad(t: String, n: Int) = "lnka.v1.$t.$n"', 'fun aad(t: String, n: Int) = "lnka.v1.$t"'],
  [L, 'the SAS reads the wrong bytes', '(sasKey[0].toLong() and 0xff) shl 24', '(sasKey[1].toLong() and 0xff) shl 24'],
  [L, 'h2n and n2h swap', 'private fun keyFor(k: Keys, n: Int) = if (n == 2) k.n2h else k.h2n', 'private fun keyFor(k: Keys, n: Int) = if (n == 2) k.h2n else k.n2h'],
  [L, 'the offer\'s proof of possession is not checked', 'if (!Statements.verifySig(devicePub, popDevice, pop)) return no("pop-device")', ''],
  [L, 'the transcript leaves out the displayer role', '"lnkt.v1.$id.$eD.$eS.${roleD.word}"', '"lnkt.v1.$id.$eD.$eS"'],
  [F, 'H is told the SAS', 'if (role == Link.Role.N && (state == S.PAIRED || state == S.OFFERED)) keys?.sas else null', 'keys?.sas'],
  [F, 'any digits pass the SAS check', 'if (!Link.sasMatches(typed, keys!!.sas)) return fail(Why.SAS)', ''],
  [F, 'a mismatched SAS leaves the slot alive', 'private fun fail(why: Why, detail: String = ""): Step.Fail { kill(abort = why != Why.OFFLINE && why != Why.STATE)', 'private fun fail(why: Why, detail: String = ""): Step.Fail { kill(abort = false)'],
  [F, 'a second scanner is reported as a plain failure', 'LinkDirectory.R.Contended -> fail(Why.CONTENDED)', 'LinkDirectory.R.Contended -> fail(Why.GONE)'],
  [F, 'roles are not checked against the device\'s own state (display)', 'if (!roleFits()) return fail(Why.ROLE)\n        val code', 'val code'],
  [F, 'roles are not checked against the device\'s own state (scan)', 'if (!Link.scannerMayProceed(msg0.value.roleD, holdsAccount()) || msg0.value.roleD == role || !roleFits()) return fail(Why.ROLE)', ''],
  [F, 'N accepts a completion with no pinned directory key', 'if (pins.isEmpty()) return fail(Why.UNVERIFIED, "no-pinned-key")', ''],
  [F, 'N accepts a binding that is not active', 'if (v.att.state != "active") return fail(Why.UNVERIFIED, "state-${v.att.state}")', 'if (false) return fail(Why.UNVERIFIED, "state-${v.att.state}")'],
  [F, 'N does not check the attestation at all', 'is Statements.Verdict.No -> return fail(Why.UNVERIFIED, v.reason)', 'is Statements.Verdict.No -> {}'],
  [F, 'N shows the label it offered, not the one H wrote', 'val chosen = label?.takeIf', 'val chosen = o.label?.takeIf'],
  [F, 'H with no consent key links anyway', 'if (!holder.hasConsentKey) return fail(Why.NO_CONSENT)', ''],
  [F, 'the consent is stamped over something other than N\'s dev.', 'Consent.stamp(Consent.Purpose.LINK, null, challenge, nDev, now())', 'Consent.stamp(Consent.Purpose.LINK, null, challenge, holder.devText, now())'],
]
const only = process.argv.includes('--only') ? Number(process.argv[process.argv.indexOf('--only') + 1]) : null
const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME || '/opt/homebrew/opt/openjdk@17', ANDROID_HOME: process.env.ANDROID_HOME || '/opt/homebrew/share/android-commandlinetools' }
const run = () => spawnSync('./gradlew', ['--no-daemon', '--rerun-tasks', '-q', 'testDebugUnitTest', '--tests', 'page.bento.home.LinkTest', '--tests', 'page.bento.home.LinkFlowTest'],
  { cwd: join(root, 'home/android'), env, encoding: 'utf8' })

let bad = 0
const say = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }
const control = run()
say(control.status === 0, 'CONTROL: the unmutated code passes both rigs')
if (control.status !== 0) { console.log((control.stdout + control.stderr).slice(-1500)); process.exit(1) }
for (const [i, [file, name, from, to]] of MUTANTS.entries()) {
  if (only !== null && only !== i) continue
  const path = join(src, file), orig = readFileSync(path, 'utf8')
  const hits = orig.split(from).length - 1
  if (hits !== 1) { say(false, `mutant ${i} (${name}): the text to mutate occurs ${hits} times, not once`); continue }
  try {
    writeFileSync(path, orig.replace(from, () => to))
    if (readFileSync(path, 'utf8') === orig) { say(false, `mutant ${i} (${name}): did not apply`); continue }
    const r = run()
    const compiled = !/Compilation error|e: file:/.test(r.stdout + r.stderr)
    say(r.status !== 0 && compiled, `mutant ${i} (${name}): ${r.status === 0 ? 'SURVIVED' : compiled ? 'caught' : 'did not compile (not a test of anything)'}`)
  } finally { writeFileSync(path, orig) }
}
process.exit(bad ? 1 : 0)
