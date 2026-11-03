#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/connect on iOS: the account setup flow, driven end to end against a LOCAL
 * directory (home/ios/IdentitySetup.swift).
 *
 *   BENTO_WRANGLER=/path/to/wrangler node scripts/test-home-id-setup.mjs
 *
 * WHAT RUNS. The real Swift (HostDocStore, IdentityKeys, IdentityStatements,
 * IdentityRecovery, Argon2id, RecoveryFlow, IdentitySetup) is compiled and run
 * against the real directory Worker under `wrangler dev` on localhost, with its
 * development mailer on. This script reads the mailed code from the Worker's own
 * log (never the live service, never real mail) and hands it to the Swift process
 * as the person would type it. Then it checks the result a SECOND way: kernel's
 * verifiers (WebCrypto) accept the bind./dev. the Swift wrote, and the directory
 * itself serves that binding as active under the pinned key.
 *
 * Rows: O1 (a managed-config key present refuses start, with the control), a
 * blind store mints nothing, a wrong code is refused and counted, an attestation
 * under an unpinned key or an unknown kid is NOT recorded as bound, no recovery
 * on a device without Argon2id memory, the code is shown once and never kept, a
 * wrong code does not confirm and the right one OPENS the blob to the account and
 * recovery-kx scalars, the directory's recovery store is not served so the flow
 * stops there and never says "complete", and the dev. carries its own kx beside
 * the bind.'s recovery kx (mode C).
 *
 * Needs an Apple toolchain, a directory worker (server/directory, from the
 * directory PR) and wrangler (BENTO_WRANGLER). Without any of them it SKIPS.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// the tree holding the directory worker (and a kernel at kx mode C); the directory PR's own tree once it lands
const DIRROOT = process.env.BENTO_DIRECTORY_ROOT ? resolve(process.env.BENTO_DIRECTORY_ROOT) : ROOT
const DIRDIR = join(DIRROOT, 'server/directory')
const SRC = ['HostDocStore.swift', 'Argon2id.swift', 'IdentityKeys.swift', 'IdentityDisplayTable.swift', 'IdentityStatements.swift', 'IdentityRecovery.swift',
  'RecoveryFlow.swift', 'IdentitySetup.swift'].map((f) => join(ROOT, 'home/ios', f))
const skip = (why) => { console.log(`home id setup: SKIPPED — ${why}`); process.exit(0) }
try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe' }) } catch { skip('needs an Apple toolchain (CryptoKit, Security).') }
if (!existsSync(join(DIRDIR, 'src/worker.js'))) skip('this tree has no server/directory (the directory PR has not landed).')
const WRANGLER = process.env.BENTO_WRANGLER
if (!WRANGLER || !existsSync(WRANGLER)) skip('set BENTO_WRANGLER to an installed wrangler (no network install from a rig).')

const free = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const tmp = mkdtempSync(join(tmpdir(), 'bento-idsetup-'))
const mailDir = join(tmp, 'mail'); mkdirSync(mailDir)
const b64u = (u8) => Buffer.from(u8).toString('base64url')

// the directory's development signing key: made here, pinned by the client under test as `dev-1`
const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const dirJwk = JSON.stringify(await webcrypto.subtle.exportKey('jwk', kp.privateKey))
const dirPub = b64u(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey)))
const otherKp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const otherPub = b64u(new Uint8Array(await webcrypto.subtle.exportKey('raw', otherKp.publicKey)))

const port = await free()
const base = `http://127.0.0.1:${port}`
let log = ''
const wr = spawn(WRANGLER, ['dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', join(tmp, 'state'),
  '--var', 'DEV:1', '--var', 'MAILER:log', '--var', 'DIR_KID:dev-1', '--var', `DIR_KEY_JWK:${dirJwk}`,
  '--var', 'CHALLENGE_KEY:0123456789abcdef0123456789abcdef'], { cwd: DIRDIR, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
let ready; const readyP = new Promise((r) => { ready = r })
let pending = ''
const onData = (d) => {
  const s = d.toString(); log += s; pending += s
  let i
  while ((i = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, i); pending = pending.slice(i + 1)
    if (line.includes('Ready on')) ready()
    const m = line.match(/\{"devmail":.*\}\}/)
    if (m) {
      try {
        const { to, body } = JSON.parse(m[0]).devmail
        const code = /Your code: ([A-Z0-9]{8})/.exec(body)?.[1]
        if (code) writeFileSync(join(mailDir, encodeURIComponent(to)), code)
      } catch {}
    }
  }
}
wr.stdout.on('data', onData); wr.stderr.on('data', onData)
if (process.env.BENTO_RIG_DEBUG) wr.stdout.on('data', (d) => process.stderr.write('[wr] ' + d))
const stop = () => { try { wr.kill('SIGTERM') } catch {}; if (process.env.BENTO_RIG_DEBUG) writeFileSync(process.env.BENTO_RIG_DEBUG, log) }
process.on('exit', stop)
const up = await Promise.race([readyP.then(() => true), new Promise((r) => setTimeout(() => r(false), 90_000))])
if (!up) { console.error('wrangler dev did not come up:\n' + log.slice(-2000)); stop(); process.exit(2) }

const main = String.raw`
import CryptoKit
import Foundation
final class Mem: HostDocStore.Secrets {
  var d: [String: Data] = [:]; var failReads = false
  func get(_ a: String) -> HostDocStore.Read { failReads ? .unavailable : (d[a].map { .found($0) } ?? .absent) }
  func set(_ a: String, _ v: Data) -> Bool { d[a] = v; return true }
  func delete(_ a: String) { d[a] = nil }
}
setvbuf(stdout, nil, _IONBF, 0)
func emit(_ k: String, _ v: Any) { print("\(k)=\(v)") }
let args = CommandLine.arguments
let base = URL(string: args[1])!, pin = args[2], other = args[3], mailDir = args[4]
let transport = DirectoryHTTP.transport(base: base)
var posts: [String] = []
let counting: IdentitySetup.Transport = { p, b in posts.append(p); return transport(p, b) }
let pins = ["dev-1": pin]
func mail(_ to: String) -> String {
  // the rig script names the file with encodeURIComponent
  let alt = mailDir + "/" + to.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()")))!
  for _ in 0..<150 {
    for p in [alt] { if let s = try? String(contentsOfFile: p, encoding: .utf8), !s.isEmpty { return s } }
    Thread.sleep(forTimeInterval: 0.2)
  }
  return "NOMAIL000"
}
var tick = 1_800_000_000_000
func mk(_ m: Mem, pins: [String: String] = pins, managed: Bool = false) -> IdentitySetup {
  IdentitySetup(store: m, post: counting, directoryKeys: pins, managed: { managed },
                now: { Int(Date().timeIntervalSince1970 * 1000) }, enclave: false)
}
let aliceAddr = "alice@example.com", bobAddr = "bob@example.com"
let full: () -> Int? = { nil }
let old: () -> Int? = { 48 << 20 }
Argon2id.availableMemory = full

// --- O1: a managed-config key present → no identity operation; the control proceeds
let mm = Mem()
posts = []
emit("managed.start", "\(mk(mm, managed: true).start(address: aliceAddr, name: nil))")
emit("managed.verify", "\(mk(mm, managed: true).verify(code: "ABCDEFGH"))")
emit("managed.prepare", "\(mk(mm, managed: true).prepareRecovery())")
emit("managed.mint", "\(mk(mm, managed: true).mintDevice(label: nil))")
emit("managed.posts", posts.count)
emit("managed.store", mm.d.count)

// --- a blind store mints nothing
let blind = Mem(); blind.failReads = true
emit("blind.start", "\(mk(blind).start(address: aliceAddr, name: nil))")
emit("blind.store", blind.d.count)
emit("blind.posts", posts.count)

// --- an address that cannot be bound is refused before anything is minted
let bad = Mem()
emit("bad.start", "\(mk(bad).start(address: "not an address", name: nil))")
emit("bad.store", bad.d.count)

// --- the real flow
let st = Mem()
let s = mk(st)
emit("stage.none", "\(s.stage()!)")
emit("early.verify", "\(s.verify(code: "ABCDEFGH"))")
emit("early.prepare", "\(s.prepareRecovery())")
emit("early.mint", "\(s.mintDevice(label: nil))")
posts = []
emit("start", "\(s.start(address: "  Alice@Example.COM ", name: "Alice"))")
emit("start.posts", posts.joined(separator: ","))
emit("stage.mailed", "\(s.stage()!)")
guard case .found(let rec0) = st.get(IdentitySetup.recordItem), let r0 = try? JSONDecoder().decode(IdentitySetup.Record.self, from: rec0) else { fatalError("no record") }
emit("bind.text", r0.bindText); emit("bind.sig", r0.bindSig)
let bv = IdentityStatements.verifyBind(r0.bindText, r0.bindSig, now: Int(Date().timeIntervalSince1970 * 1000))
emit("bind.valid", bv.value != nil)
emit("bind.kxpresent", bv.value.map { !$0.kx.isEmpty && IdentityStatements.isKxKey($0.kx) } ?? false)
emit("start.again.other", "\(s.start(address: bobAddr, name: nil))")
emit("start.again.same", "\(s.start(address: aliceAddr, name: "Alice"))")
let code = mail(aliceAddr)
emit("verify.junk", "\(s.verify(code: "12"))")
let wrongCode = code == "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA"
emit("verify.wrong", "\(s.verify(code: wrongCode))")
emit("stage.afterwrong", "\(s.stage()!)")
emit("verify.right", "\(s.verify(code: code))")
emit("stage.bound", "\(s.stage()!)")
emit("verify.again", "\(s.verify(code: code))")

// --- recovery
Argon2id.availableMemory = old
emit("rc.nomem", "\(s.prepareRecovery())")
emit("rc.nomem.stage", "\(s.stage()!)")
Argon2id.availableMemory = full
var printed = ""
if case .code(let c) = s.prepareRecovery() { printed = c }
emit("rc.code.len", printed.count)
emit("rc.again", "\(s.prepareRecovery())")
guard case .found(let rec1) = st.get(IdentitySetup.recordItem), let r1 = try? JSONDecoder().decode(IdentitySetup.Record.self, from: rec1) else { fatalError("no record") }
let raw1 = String(data: rec1, encoding: .utf8)!
emit("rc.codeKept", raw1.contains(printed) || raw1.contains(printed.replacingOccurrences(of: "-", with: "")))
emit("rc.kxKept", !r1.recoveryKx.isEmpty)
emit("rc.stage", "\(s.stage()!)")
emit("rc.enrol.early", "\(s.enrolRecovery())")
var other1 = Array(printed); other1[0] = other1[0] == "A" ? "B" : "A"
emit("rc.confirm.typo", "\(s.confirmRecovery(typed: String(other1)))")
var shown = IdentityRecovery.parseCode(printed)
var wrongBytes: [UInt8] = []
if case .ok(var cb) = shown { cb[9] ^= 0x5a; wrongBytes = cb }
emit("rc.confirm.wrong", "\(s.confirmRecovery(typed: IdentityRecovery.formatCode(wrongBytes)!))")
emit("rc.confirm.nomem", { Argon2id.availableMemory = old; defer { Argon2id.availableMemory = full }; return "\(s.confirmRecovery(typed: printed))" }())
emit("rc.confirm.right", "\(s.confirmRecovery(typed: printed))")
emit("rc.stage2", "\(s.stage()!)")
emit("rc.enrol", "\(s.enrolRecovery())")
// the blob opens, with the code, to the account scalar AND the recovery kx the bind names
guard case .ok(let codeBytes) = IdentityRecovery.parseCode(printed),
      let wrap = IdentityRecovery.recoveryWrapKey(code: codeBytes, salt: IdentityRecovery.b64uDec(r1.recovery!.salt)!) else { fatalError("wrap") }
let acct = try! IdentityKeys.account(in: st)
switch IdentityRecovery.openRecoveryInner(IdentityRecovery.b64uDec(r1.recovery!.ct)!, wrapKey: wrap, iv: IdentityRecovery.b64uDec(r1.recovery!.iv)!,
                                          accountPub: bv.value!.accountPub, kxPub: bv.value!.kx) {
case .ok(let k): emit("rc.blob", k.account == Array(acct.rawRepresentation) && k.kx.count == 32)
case .no(let w): emit("rc.blob", "no:\(w)")
}

// --- this device's dev. under mode C
emit("mint", "\(s.mintDevice(label: "This iPhone") != .unavailable)")
guard case .found(let rec2) = st.get(IdentitySetup.recordItem), let r2 = try? JSONDecoder().decode(IdentitySetup.Record.self, from: rec2), let dv = r2.dev else { fatalError("no dev") }
let dparts = dv.components(separatedBy: "\n")
emit("dev.text", dparts[0]); emit("dev.sig", dparts[1])
let dd = IdentityStatements.verifyDev(dparts[0], dparts[1], now: Int(Date().timeIntervalSince1970 * 1000)).value
emit("dev.valid", dd != nil)
emit("dev.sameAccount", dd?.accountPub == bv.value?.accountPub)
emit("dev.kxDistinct", dd.map { $0.kx != bv.value!.kx && IdentityStatements.isKxKey($0.kx) } ?? false)
emit("mint.again", "\(s.mintDevice(label: "x") == .minted(dparts[0]))")
emit("final.stage", "\(s.stage()!)")

// --- a directory answer under a key the client does not pin is NOT recorded as bound
for (tag, p) in [("wrongkey", ["dev-1": other]), ("unknownkid", ["dir-9": pin])] {
  let m = Mem(); let t = mk(m, pins: p)
  emit("pin.\(tag).start", "\(t.start(address: bobAddr.replacingOccurrences(of: "bob", with: "bob-\(tag)"), name: nil))")
  let a = bobAddr.replacingOccurrences(of: "bob", with: "bob-\(tag)")
  emit("pin.\(tag).verify", "\(t.verify(code: mail(a)))")
  emit("pin.\(tag).stage", "\(t.stage()!)")
}
`

const dir = join(tmp, 'swift'); mkdirSync(dir)
let out
try {
  writeFileSync(join(dir, 'main.swift'), main)
  execFileSync('swiftc', ['-O', '-D', 'DEBUG', '-D', 'BENTO_SOFTWARE_DEVICE_KEYS', '-D', 'BENTO_WIPE_PROBE', '-o', join(dir, 'a'), ...SRC, join(dir, 'main.swift')], { stdio: 'pipe' })
  // ASYNC on purpose: this process must keep reading the Worker's log (the mailed codes) while the Swift runs
  const text = await new Promise((res, rej) => {
    const p = spawn(join(dir, 'a'), [base, dirPub, otherPub, mailDir], { stdio: ['ignore', 'pipe', 'inherit'] })
    let o = ''; p.stdout.on('data', (d) => { o += d })
    const t = setTimeout(() => { p.kill('SIGKILL'); rej(Object.assign(new Error('timed out'), { stdout: o })) }, 300_000)
    p.on('close', (code, sig) => { clearTimeout(t); code === 0 ? res(o) : rej(Object.assign(new Error('exit ' + code), { signal: sig, status: code, stdout: o })) })
  })
  out = Object.fromEntries(text.trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)))
} catch (err) { console.error('swiftc or run failed (' + (err.signal ?? err.status) + '):\n' + (err.stderr?.toString() || '') + (err.stdout?.toString() || '') + err.message + '\n--- worker log (mail lines) ---\n' + log.split('\n').filter((l) => !/explorer|^\s*(GET|POST)|^If the/.test(l)).slice(-25).join('\n').slice(0, 2500)); stop(); process.exit(2) }

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }

// O1
ok(out['managed.start'] === 'managed' && out['managed.verify'] === 'managed' && out['managed.prepare'] === 'managed' && out['managed.mint'] === 'managed',
  'a managed-config key present refuses start, verify, recovery and the device cert (O1)')
ok(out['managed.posts'] === '0' && out['managed.store'] === '0', 'and it sent nothing to the directory and minted nothing')
ok(out['blind.start'] === 'unavailable' && out['blind.store'] === '0', 'a store that cannot be read mints no account key')
ok(out['bad.start'].startsWith('badAddress') && out['bad.store'] === '0', 'an address that cannot be bound is refused before a key is minted')
ok(out['stage.none'] === 'none' && out['early.verify'] === 'notStarted' && out['early.prepare'] === 'notBound' && out['early.mint'] === 'notBound',
  'before start there is nothing to verify, recover or mint')
// start
ok(out['start'] === 'mailed' && out['start.posts'] === '/v1/bind/start' && out['stage.mailed'] === 'mailed',
  'start (control: same build, no managed key) posts one bind. and reports it mailed')
const NOW = Date.now()
const K = await import(join(ROOT, 'kernel/src/statements.ts'))
const bind = await K.verifyBind(out['bind.text'], out['bind.sig'], { now: NOW })
ok(bind.ok && bind.value.address === 'alice@example.com' && bind.value.kx && out['bind.valid'] === 'true' && out['bind.kxpresent'] === 'true',
  "kernel's verifier accepts the bind. the Swift made, normalised, with a valid recovery kx (mode C)")
ok(out['start.again.other'] === 'alreadySetUp' && out['start.again.same'] === 'mailed', 'a second address is refused while one setup is under way; the same address resumes')
// verify
ok(out['verify.junk'] === 'notACode', 'a malformed code is refused before any request')
ok(out['verify.wrong'] === 'refused(attemptsLeft: 4)' && out['stage.afterwrong'] === 'mailed', 'a wrong code is refused by the directory, counted, and binds nothing')
ok(out['verify.right'] === 'bound' && out['stage.bound'] === 'bound' && out['verify.again'] === 'bound', 'the mailed code binds, under the pinned directory key (positive control)')
for (const t of ['wrongkey', 'unknownkid']) {
  ok(out[`pin.${t}.start`] === 'mailed' && out[`pin.${t}.verify`].startsWith('untrusted') && out[`pin.${t}.stage`] === 'mailed',
    `an attestation ${t === 'wrongkey' ? 'signed by a key that is not the pinned one' : 'under a kid the client does not pin'} is refused and not recorded as bound`)
}
// the directory's own answer, independently
const look = await (await fetch(`${base}/v1/lookup?e=alice%40example.com`)).json().catch(() => null)
ok(look && look.binding === out['bind.text'] && /^att\./.test(look.attestation ?? '') && look.attestationSig && look.state === 'active', 'the directory itself now serves that exact binding as active')
// recovery
ok(out['rc.nomem'] === 'noMemory' && out['rc.nomem.stage'] === 'bound', 'with 48 MiB free no recovery is made, and nothing is recorded')
ok(Number(out['rc.code.len']) >= 16 && out['rc.again'] === 'already', 'the recovery code is made once (with memory)')
ok(out['rc.codeKept'] === 'false' && out['rc.kxKept'] === 'false', 'the code is never stored, and the recovery kx scalar is no longer kept in the clear once sealed')
ok(out['rc.enrol.early'] === 'notConfirmed', 'nothing is offered to the directory before the person has typed the code back')
ok(out['rc.confirm.typo'].startsWith('notACode') && out['rc.confirm.wrong'] === 'wrong' && out['rc.confirm.nomem'] === 'noMemory',
  'a typo is not a code, a wrong code does not confirm, and no memory is not a wrong code')
ok(out['rc.confirm.right'] === 'confirmed' && out['rc.stage2'] === 'recoveryConfirmed', 'the right code confirms (positive control)')
ok(out['rc.blob'] === 'true', 'the blob opens with the code to the account scalar and the recovery kx the bind. names')
ok(out['rc.enrol'] === 'recoveryNotServed' && out['final.stage'] === 'recoveryConfirmed', 'the directory has no recovery store yet: the flow stops there and never says complete')
// dev.
const dev = await K.verifyDev(out['dev.text'], out['dev.sig'], { now: NOW })
ok(dev.ok && out['dev.valid'] === 'true' && out['dev.sameAccount'] === 'true', "kernel's verifier accepts the dev. the Swift made, under the same account key as the bind.")
ok(out['dev.kxDistinct'] === 'true' && dev.ok && dev.value.kx && dev.value.kx !== bind.value.kx, "the dev. carries the device's own kx, distinct from the bind.'s recovery kx (mode C)")
ok(out['mint.again'] === 'true', 'minting again returns the same dev.')

stop(); rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? `\n${checks}/${checks} checks passed` : `\n${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)
