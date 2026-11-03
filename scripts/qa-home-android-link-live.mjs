#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

/**
 * Two Android link agents linking through the REAL directory worker.
 *
 * Starts `wrangler dev` for server/directory with LINKING=1 (a throwaway directory signing key,
 * DEV mailer that prints the emailed code), then runs LinkLiveTest under Gradle against it. The
 * unit rig (LinkFlowTest) uses a MODEL of the directory; this one is the directory's own
 * verifyLinkRelease, challenge spend, slot rules and attestations.
 *
 *   BENTO_DIRECTORY_SRC=<checkout holding server/directory with link routes> \
 *   WRANGLER=<path to wrangler> node scripts/qa-home-android-link-live.mjs
 *
 * Not a CI rig: it needs the directory branch and wrangler. No emulator is involved.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.env.BENTO_DIRECTORY_SRC
const WRANGLER = process.env.WRANGLER || 'wrangler'
const PORT = Number(process.env.PORT || 8791)
if (!SRC || !existsSync(join(SRC, 'server/directory/wrangler.toml'))) {
  console.error('set BENTO_DIRECTORY_SRC to a checkout of the directory branch (it holds server/directory)'); process.exit(2)
}
const b64u = (u8) => Buffer.from(u8).toString('base64url')
const dirKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', dirKey.privateKey))
const dirPub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', dirKey.publicKey)))
const state = mkdtempSync(join(tmpdir(), 'bento-link-dir-'))
const logPath = join(state, 'worker.log')
const out = []
const w = spawn(WRANGLER, ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state,
  '--var', 'DEV:1', '--var', 'MAILER:log', '--var', 'DIR_KID:dev-1', '--var', `DIR_KEY_JWK:${jwk}`, '--var', 'LINKING:1',
  '--var', `CHALLENGE_KEY:${b64u(crypto.getRandomValues(new Uint8Array(32)))}`],
  { cwd: join(SRC, 'server/directory'), stdio: ['ignore', 'pipe', 'pipe'] })
const flush = () => writeFileSync(logPath, out.join(''))
for (const s of [w.stdout, w.stderr]) s.on('data', (d) => { out.push(d.toString()); flush() })
process.on('exit', () => { try { w.kill('SIGTERM') } catch {} })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 120 && !/Ready on/.test(out.join('')); i++) await sleep(500)
if (!/Ready on/.test(out.join(''))) { console.error('wrangler did not start:\n' + out.join('').slice(-1500)); process.exit(2) }
console.log(`local directory up on 127.0.0.1:${PORT} (kid dev-1, LINKING=1)`)

// ASYNC on purpose: a blocking spawn would stop this process reading the worker's output, which is where the mailer prints
const g = spawn('./gradlew', ['--no-daemon', '--rerun-tasks', 'testDebugUnitTest', '--tests', 'page.bento.home.LinkLiveTest', '-i'], {
  cwd: join(root, 'home/android'),
  env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME || '/opt/homebrew/opt/openjdk@17',
    ANDROID_HOME: process.env.ANDROID_HOME || '/opt/homebrew/share/android-commandlinetools',
    BENTO_LINK_DIRECTORY: `http://127.0.0.1:${PORT}`, BENTO_LINK_MAILLOG: logPath, BENTO_LINK_PIN: `dev-1=${dirPub}` } })
const gout = []
for (const s of [g.stdout, g.stderr]) s.on('data', (d) => gout.push(d.toString()))
const r = { status: await new Promise((res) => g.on('close', res)) }
r.stdout = gout.join(''); r.stderr = ''
// the verdict is Gradle's own result file: ONE test, run, not skipped, not failed
const xml = join(root, 'home/android/app/build/test-results/testDebugUnitTest/TEST-page.bento.home.LinkLiveTest.xml')
const m = existsSync(xml) ? /tests="(\d+)" skipped="(\d+)" failures="(\d+)" errors="(\d+)"/.exec(readFileSync(xml, 'utf8')) : null
const ran = !!m && m[1] === '1' && m[2] === '0' && m[3] === '0' && m[4] === '0'
if (!ran) console.log(r.stdout.split('\n').filter((l) => /FAILED|AssertionError|expected|got /.test(l)).slice(0, 12).join('\n'))
const ok = r.status === 0 && ran
console.log(m ? `LinkLiveTest: ${m[1]} test, ${m[2]} skipped, ${m[3]} failed, ${m[4]} errors` : 'no result file')
console.log(ok ? 'ok   the live directory linked, refused and contended as the unit rig does' : 'FAIL live link rig (a SKIPPED test is not a pass)')
process.exit(ok ? 0 : 1)
