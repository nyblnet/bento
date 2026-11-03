#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

/**
 * Do the Android identity-call rigs notice when the host's rules are wrong?
 *
 * Applies one mutation at a time to IdentityHost.kt (and the session gate it relies on,
 * RoutineGate.kt), runs IdentityHostTest + RoutineGateTest, and requires the run to FAIL.
 * A mutation that leaves the rigs green is a hole in the rigs. Each run first checks the
 * mutation landed (the `from` text is in the file exactly once) and that the unmutated build
 * is green (the control), and always restores the file. Gradle runs with --rerun-tasks so a
 * cached result cannot stand in for a run.
 *
 *   node scripts/qa-home-android-identity-mutants.mjs [--only N]
 *
 * Not a CI rig: one Gradle run per mutant. Run it when IdentityHost.kt or RoutineGate.kt changes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'home/android/app/src/main/java/page/bento/home')
const H = 'IdentityHost.kt', G = 'RoutineGate.kt'
const MUTANTS = [
  [H, 'an unverified load is served', 'private fun blocked(c: Caller) = !c.genuine || managed()', 'private fun blocked(c: Caller) = managed()'],
  [H, 'a managed device is served', 'private fun blocked(c: Caller) = !c.genuine || managed()', 'private fun blocked(c: Caller) = !c.genuine'],
  [H, 'sign does not check the purpose lock', 'if (!Consent.payloadMatchesPurpose(purpose, payload)) return Out.Refuse("purpose")', ''],
  [H, 'invite and revoke are signed', 'val ROUTINE = setOf("frame", "prove", "delegate", "show")', 'val ROUTINE = setOf("frame", "prove", "delegate", "show", "invite", "revoke")'],
  [H, 'sign does not need the document\'s consent', 'if (consent.state(c.doc) != State.GRANTED) return Out.Refuse("declined")', ''],
  [H, 'sign does not check the session', 'if (!gate.allow(now())) return Out.Refuse("reauth")', ''],
  [H, 'a lapsed Keystore floor is not reauth', 'gate.lock(); return Out.Refuse("reauth")', 'return Out.Refuse("unavailable")'],
  [H, 'a lapsed Keystore floor leaves the session open', 'gate.lock(); return Out.Refuse("reauth")', 'return Out.Refuse("reauth")'],
  [H, 'whoami answers without asking', 'State.UNASKED -> Out.NeedConsent', 'State.UNASKED -> Out.Ok(identity(r))'],
  [H, 'whoami answers a document that was declined', 'State.DECLINED -> Out.Refuse("declined")', 'State.DECLINED -> Out.Ok(identity(r))'],
  [H, 'sign names the wrong key', '"pub" to part(r.devText, 1))', '"pub" to part(r.bindText, 2))'],
  [H, 'resolve answers for any key', 'if (pub != id["accountPub"] && pub != id["devicePub"]) return Out.Ok(null)', ''],
  [H, 'resolve does not need consent', 'if (blocked(c) || consent.state(c.doc) != State.GRANTED) return Out.Ok(null)', 'if (blocked(c)) return Out.Ok(null)'],
  [H, 'the capability ignores a managed device', 'if (genuine && !managed) listOf("store", "seal", "identity")', 'if (genuine) listOf("store", "seal", "identity")'],
  [H, 'the capability ignores gate 1', 'if (genuine && !managed) listOf("store", "seal", "identity")', 'if (!managed) listOf("store", "seal", "identity")'],
  [H, 'a decline is forgotten', 'declined.add(doc); sessionGrants.remove(doc)', 'sessionGrants.remove(doc)'],
  [H, 'a grant is not kept', 'file.parentFile?.mkdirs(); file.appendText(doc + "\\n")', 'file.parentFile?.mkdirs()'],
  [H, 'a stored grant needs no valid key', 'if (file == null || !key.matches(doc))', 'if (file == null)'],
  [G, 'the idle limit is off by one', 'now - lastUse >= idleMs', 'now - lastUse > idleMs'],
  [G, 'the overall limit is off by one', 'now - authenticatedAt >= overallMs', 'now - authenticatedAt > overallMs'],
  [G, 'steady use does not refresh the idle clock', 'lastUse = now\n        return true', 'return true'],
  [G, 'a backwards clock is allowed', 'if (now < lastUse || now < authenticatedAt) { lock(); return false }', ''],
  [G, 'no session still signs', 'if (authenticatedAt < 0) return false', ''],
]
const only = process.argv.includes('--only') ? Number(process.argv[process.argv.indexOf('--only') + 1]) : null
const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME || '/opt/homebrew/opt/openjdk@17', ANDROID_HOME: process.env.ANDROID_HOME || '/opt/homebrew/share/android-commandlinetools' }
const run = () => spawnSync('./gradlew', ['--no-daemon', '--offline', '--rerun-tasks', '-q', 'testDebugUnitTest', '--tests', 'page.bento.home.IdentityHostTest', '--tests', 'page.bento.home.RoutineGateTest'],
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
  if (hits !== 1) { say(false, `#${i} ${name}: the line to mutate appears ${hits} times, not once`); continue }
  try {
    writeFileSync(path, orig.replace(from, () => to))
    const r = run()
    say(r.status !== 0, `#${i} ${name}: ${r.status !== 0 ? 'caught' : 'SURVIVED — the rigs did not notice'}`)
  } finally { writeFileSync(path, orig) }
}
console.log(bad ? `\n${bad} problem(s)` : `\nall ${only === null ? MUTANTS.length : 1} mutants caught`)
process.exit(bad ? 1 : 0)
