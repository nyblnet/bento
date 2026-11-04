#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/connect A1 — Bento ID setup on a real Android runtime against a LOCAL directory (manual).
//
//   BENTO_DIRECTORY_SRC=<checkout with server/directory> WRANGLER=<path to wrangler> \
//     node scripts/qa-home-android-setup.mjs [--no-build]
//
// Not a CI rig: it needs an emulator (or device) and `wrangler dev`. The JVM rigs
// (IdentitySetupTest, StatementsTest) are what CI runs; this is what they cannot show —
// the real worker's verdicts, the Keystore, BiometricPrompt and R8.
//
// What it does, in order, against a worker started here with throwaway keys:
//   1. R8: builds the MINIFIED releaseCheck variant, runs SetupSelfCheck in it, expects OK
//   2. drives the debug app's setup screen with real taps: email → a WRONG code (refused) →
//      the emailed code → the recovery code is read off the screen and typed back → two
//      fingerprint prompts (consent, then sealing)
//   3. checks what the directory now serves with KERNEL's verifiers (bind., att., dev.), that
//      the record on the device agrees, and that the worker mailed the recovery-changed notice
// The worker is NEVER the live service: 127.0.0.1, in-memory-ish state under a temp dir.

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webcrypto as crypto } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const SRC = process.env.BENTO_DIRECTORY_SRC
const WRANGLER = process.env.WRANGLER || 'wrangler'
const ADB = process.env.ADB || join(process.env.ANDROID_HOME || '/opt/homebrew/share/android-commandlinetools', 'platform-tools/adb')
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554'
const PORT = 8787
const PKG = 'page.bento.home'
const noBuild = process.argv.includes('--no-build')
if (!SRC || !existsSync(join(SRC, 'server/directory/wrangler.toml'))) {
  console.error('set BENTO_DIRECTORY_SRC to a checkout of the directory branch (it holds server/directory)'); process.exit(2)
}

const S = await import(join(root, 'kernel/src/statements.ts'))
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failed++ }
const b64u = (u8) => Buffer.from(u8).toString('base64url')

// ---- the local directory -------------------------------------------------------------------
const dirKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', dirKey.privateKey))
const dirPub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', dirKey.publicKey)))
const state = mkdtempSync(join(tmpdir(), 'bento-dir-'))
const out = []
const w = spawn(WRANGLER, ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state,
  '--var', 'DEV:1', '--var', 'MAILER:log', '--var', 'DIR_KID:dev-1', '--var', `DIR_KEY_JWK:${jwk}`,
  '--var', `CHALLENGE_KEY:${b64u(crypto.getRandomValues(new Uint8Array(32)))}`,
  '--var', `PEPPER_V1:${b64u(crypto.getRandomValues(new Uint8Array(32)))}`, '--var', 'KEYSTORE:1'],
  { cwd: join(SRC, 'server/directory'), stdio: ['ignore', 'pipe', 'pipe'] })
for (const s of [w.stdout, w.stderr]) s.on('data', (d) => out.push(d.toString()))
const cleanup = () => { try { w.kill('SIGTERM') } catch {} }
process.on('exit', cleanup)
const mails = () => out.join('').split('\n').filter((l) => l.includes('"devmail"')).map((l) => JSON.parse(l.slice(l.indexOf('{'))).devmail)
for (let i = 0; i < 120 && !/Ready on/.test(out.join('')); i++) await sleep(500)
if (!/Ready on/.test(out.join(''))) { console.error('wrangler did not start:\n' + out.join('').slice(-1500)); process.exit(2) }
console.log(`local directory up on 127.0.0.1:${PORT} (kid dev-1)`)

// ---- the device ---------------------------------------------------------------------------------
const gradle = (task) => execFileSync('./gradlew', ['--offline', '--no-daemon', task], {
  cwd: join(root, 'home/android'), stdio: 'inherit',
  env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME || '/opt/homebrew/opt/openjdk@17', ANDROID_HOME: process.env.ANDROID_HOME || '/opt/homebrew/share/android-commandlinetools' } })
const apk = (v) => join(root, `home/android/app/build/outputs/apk/${v}/app-${v}.apk`)
if (!noBuild) { gradle('assembleDebug'); gradle('assembleReleaseCheck') }
const unlock = () => { try { adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); adb('shell', 'input', 'keyevent', '82'); adb('shell', 'wm', 'dismiss-keyguard') } catch {} }
unlock()

// 1. R8 --------------------------------------------------------------------------------------------
{
  adb('install', '-r', apk('releaseCheck'))
  adb('logcat', '-c')
  adb('shell', 'am', 'start', '-n', `${PKG}.releasecheck/${PKG}.SetupActivity`, '--ez', 'selfcheck', 'true')
  let line = ''
  for (let i = 0; i < 40 && !line; i++) { await sleep(500); line = adb('logcat', '-d', '-s', 'BentoSetup:I').split('\n').find((l) => /SELFCHECK/.test(l)) || '' }
  check('R8 build: the recovery derivation is correct in the minified release code', /SELFCHECK OK/.test(line), line.trim().split('BentoSetup:')[1] || 'no verdict')
}

// 2. the setup screen --------------------------------------------------------------------------------
try { adb('uninstall', PKG) } catch {}
adb('install', '-r', apk('debug'))
adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS')
const nodes = () => {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml')
  const xml = adb('shell', 'cat', '/sdcard/ui.xml')
  return [...xml.matchAll(/<node [^>]*>/g)].map((m) => {
    const a = (k) => (m[0].match(new RegExp(` ${k}="([^"]*)"`)) || [])[1] || ''
    const b = a('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    return { id: a('resource-id').replace(`${PKG}:id/`, ''), text: a('text').replace(/&amp;/g, '&').replace(/&#10;/g, '\n'), cx: b ? (+b[1] + +b[3]) / 2 : 0, cy: b ? (+b[2] + +b[4]) / 2 : 0, pkg: a('package') }
  })
}
const waitFor = async (pred, what, ms = 60000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const n = nodes(); const r = pred(n); if (r) return r; await sleep(700) }
  throw new Error('timed out waiting for ' + what + '\n' + JSON.stringify(nodes().map((n) => n.id || n.text).filter(Boolean)))
}
const byId = (n, id) => n.find((x) => x.id === id)
const tap = (n) => adb('shell', 'input', 'tap', String(Math.round(n.cx)), String(Math.round(n.cy)))
const type = async (id, text) => { tap(byId(nodes(), id)); await sleep(300); adb('shell', 'input', 'text', text); await sleep(300); adb('shell', 'input', 'keyevent', 'KEYCODE_BACK') }
const press = async () => { await sleep(300); tap(byId(nodes(), 'setup_action')) }
const promptUp = () => nodes().some((x) => x.pkg === 'com.android.systemui' && /fingerprint|Use PIN|Cancel/i.test(x.text + x.id))
/** Touch the sensor whenever a prompt is up, until setup reports done; returns how many prompts it answered. */
const answerPrompts = async () => {
  let touches = 0, wasUp = false
  for (let i = 0; i < 120; i++) {
    if (/SETUP DONE/.test(adb('logcat', '-d', '-s', 'BentoSetup:I'))) return touches
    const up = promptUp()
    if (up) { await sleep(600); try { adb('emu', 'finger', 'touch', '1') } catch {}; if (!wasUp) touches++; await sleep(1500) }
    wasUp = up
    if (!up) await sleep(500)
  }
  return touches
}

adb('logcat', '-c')
const email = `rig-${Date.now() % 1e6}@example.com`
adb('shell', 'am', 'start', '-n', `${PKG}/.SetupActivity`, '--es', 'directory', `http://10.0.2.2:${PORT}`, '--es', 'kid', 'dev-1', '--es', 'pub', dirPub)
await waitFor((n) => byId(n, 'setup_input'), 'the email field')
await type('setup_input', email); await press()
await waitFor((n) => /emailed/.test(byId(n, 'setup_status')?.text || ''), 'the code step')
let mail; for (let i = 0; i < 30 && !(mail = mails().find((m) => m.to === email)); i++) await sleep(500)
check('the worker mailed a code to the address (local stub)', !!mail)
const code = /Your code: ([A-Z0-9]{8})/.exec(mail?.body || '')?.[1]
check('the mail carries an 8-character code', !!code, code)
// a WRONG code first: refused, and the flow stays where it is (control for the honest run below)
await type('setup_input', code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA'); await press()
await waitFor((n) => /didn't work/.test(byId(n, 'setup_status')?.text || ''), 'the refusal of a wrong code')
check('a wrong emailed code is refused, with no progress', true)
await type('setup_input', code); await press()
const shown = await waitFor((n) => /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z*~$=]$/.test(byId(n, 'setup_code')?.text || '') && byId(n, 'setup_code'), 'the recovery code')
const recovery = shown.text
check('the right code verified the email, and a recovery code is shown', true, recovery)
await press()                                    // "I have written it down"
await waitFor((n) => /check it/.test(byId(n, 'setup_status')?.text || ''), 'the type-it-back step')
await type('setup_input', recovery); await press()
await answerPrompts()
const log0 = adb('logcat', '-d', '-s', 'BentoSetup:I')
// each of these logs only AFTER the Keystore accepted a person-present operation (a CryptoObject the prompt authorised)
check('the consent key signed the recovery enrolment after a prompt', /CONSENT SIGNED/.test(log0))
check('the account was sealed under the Keystore key after a prompt', /ACCOUNT SEALED/.test(log0))
const log = adb('logcat', '-d', '-s', 'BentoSetup:I')
check('the directory took the recovery enrolment', /ENROL Yes/.test(log), (log.match(/ENROL \w+( \S+)?/) || [''])[0])
check('setup finished with the recovery code registered', /SETUP DONE recoveryEnrolled=true/.test(log))

// 3. what the directory serves, checked with KERNEL's verifiers ---------------------------------------
const rec = Object.fromEntries(adb('shell', 'run-as', PKG, 'cat', 'no_backup/identity/account.record').split('\n').map((l) => l.split('\t')).filter((p) => p.length === 2))
const now = Date.now()
const bind = await S.verifyBind(rec.bind, rec.bindSig, { now })
check('on-device record: bind. verifies (kernel), mode C: a recovery kx is present', bind.ok && bind.value.kx.length > 0, bind.ok ? '' : bind.reason)
const dev = await S.verifyDev(rec.dev, rec.devSig, { now })
check('on-device record: dev. verifies (kernel) and carries its own kx', dev.ok && dev.value.kx !== bind.value?.kx, dev.ok ? '' : dev.reason)
check('dev. is certified by the same account key', dev.ok && bind.ok && dev.value.accountPub === bind.value.accountPub)
check('dev. names a consent key', dev.ok && !!dev.value.consentPub)
const att = await S.verifyAtt(rec.att, rec.attSig, { directoryKeys: { 'dev-1': dirPub }, bindText: rec.bind, now, maxAgeMs: 3_600_000 })
check('on-device record: att. verifies under the pinned key', att.ok && att.value.state === 'active', att.ok ? '' : att.reason)
const looked = await (await fetch(`http://127.0.0.1:${PORT}/v1/lookup?e=${encodeURIComponent(email)}`)).json()
check('the directory serves that binding, active', looked.binding === rec.bind && looked.state === 'active')
const att2 = await S.verifyAtt(looked.attestation, looked.attestationSig, { directoryKeys: { 'dev-1': dirPub }, bindText: looked.binding, now: Date.now(), maxAgeMs: 600_000 })
check('and its fresh attestation verifies', att2.ok, att2.ok ? '' : att2.reason)
check('the worker mailed the recovery-changed notice (it applied the enrolment)', mails().some((m) => m.to === email && /recovery code changed/.test(m.subject)))
const sealed = adb('shell', 'run-as', PKG, 'cat', 'no_backup/identity/account.sealed').trim()
check('the account is sealed on the device: iv.ciphertext, 96 bytes + 16 tag', /^[\w-]{16}\.[\w-]{150,}$/.test(sealed) && Buffer.from(sealed.split('.')[1], 'base64url').length === 112, `${sealed.length} chars`)
check('and the plaintext scalars are nowhere in the record', !Object.values(rec).some((v) => /^[A-Za-z0-9_-]{43}$/.test(v)))

// 4. the printed recovery code is the one the directory now holds a verifier for ------------------------
// Derive the verifier here from the code read off the screen and the salt the directory serves, and ask the
// directory to start a recovery with it: accepted only if the device enrolled a verifier of THIS code.
{
  const { argon2Sync } = await import('node:crypto')
  const argon2 = async (pw, salt) => new Uint8Array(argon2Sync('argon2id', { message: pw, nonce: salt, parallelism: 1, tagLength: 32, memory: 65536, passes: 3 }))
  const K = await import(join(root, 'kernel/src/recovery.ts'))
  const parsed = K.parseRecoveryCode(recovery)
  const post = async (path, body) => { const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) } }
  const salt = (await post('/v1/recovery/salt', { email })).body.saltV
  const verifier = await K.recoveryVerifier(parsed.code, new Uint8Array(Buffer.from(salt, 'base64url')), argon2)
  const wrong = verifier.slice(); wrong[0] ^= 1
  const bad = await post('/v1/recovery/start', { email, verifier: b64u(wrong) })
  check('CONTROL: a verifier of any other code is refused by the directory', bad.status === 400, `status ${bad.status}`)
  const good = await post('/v1/recovery/start', { email, verifier: b64u(verifier) })
  check('the verifier derived from the printed code starts a recovery (the directory holds THIS code\'s verifier)', good.status === 200 && !!good.body.ticket, `status ${good.status}`)
}

// 5. CONTROL: a directory key the app did not pin is not believed ---------------------------------------
{
  adb('shell', 'am', 'force-stop', PKG)
  const email2 = `rig2-${Date.now() % 1e6}@example.com`
  const stranger = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])).publicKey)))
  adb('shell', 'am', 'start', '-n', `${PKG}/.SetupActivity`, '--es', 'directory', `http://10.0.2.2:${PORT}`, '--es', 'kid', 'dev-1', '--es', 'pub', stranger)
  await waitFor((n) => byId(n, 'setup_input'), 'the email field (second run)')
  await type('setup_input', email2); await press()
  await waitFor((n) => /emailed/.test(byId(n, 'setup_status')?.text || ''), 'the code step (second run)')
  let mail2; for (let i = 0; i < 30 && !(mail2 = mails().find((m) => m.to === email2)); i++) await sleep(500)
  await type('setup_input', /Your code: ([A-Z0-9]{8})/.exec(mail2?.body || '')?.[1] || 'AAAAAAAA'); await press()
  await waitFor((n) => /couldn't be verified/.test(byId(n, 'setup_status')?.text || ''), 'the refusal to believe an unpinned key')
  check('CONTROL: with a different pinned key the same honest directory is NOT believed, and setup stops', true)
  const rec2 = await (await fetch(`http://127.0.0.1:${PORT}/v1/lookup?e=${encodeURIComponent(email2)}`)).json()
  check('(the directory did bind it: the refusal is the client\'s, not an absence)', rec2.state === 'active')
}

cleanup()
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
