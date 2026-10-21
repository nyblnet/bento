#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/connect on iOS and the Mac: the recovery code and the key blobs
 * (home/ios/Argon2id.swift, home/ios/IdentityRecovery.swift) against every byte
 * of kernel/fixtures/recovery-v1.json.
 *
 *   node scripts/test-home-id-recovery.mjs
 *
 * Argon2id has no Apple implementation, so the Swift one is held to:
 *   - RFC 9106 §5.3 (p = 4, a secret and associated data)
 *   - the fixture's derivations, at our parameters
 *   - Node's native Argon2id on random inputs and parameters
 * Then every fixture row is reproduced (codes, parsing, derivations, both blobs,
 * the directory's pepper rows) and the blob checks are exercised: a swapped
 * key, a wrong passkey, a scalar out of range.
 *
 * The fixture is read fresh each run (REC_FIXTURE overrides the path) and
 * nothing is pinned here. Apple platforms only; skips elsewhere.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { argon2Sync, randomBytes, randomInt } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = [process.env.ARGON2_SRC || 'Argon2id.swift', process.env.ID_RECOVERY_SRC || 'IdentityRecovery.swift']
  .map((f) => f.includes('/') ? f : join(ROOT, 'home/ios', f))
const FIXTURE = process.env.REC_FIXTURE || join(ROOT, 'kernel/fixtures/recovery-v1.json')
try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe' }) } catch { console.log('home id recovery: SKIPPED — needs an Apple toolchain (CryptoKit).'); process.exit(0) }
if (!existsSync(FIXTURE)) { console.error(`no fixture at ${FIXTURE}`); process.exit(2) }

// random Argon2id cases for the cross-check, answered by Node's native implementation
const cases = Array.from({ length: Number(process.env.ARGON2_CASES || 24) }, () => {
  const p = randomInt(1, 5)
  const c = {
    password: randomBytes(randomInt(0, 80)).toString('hex'), salt: randomBytes(randomInt(8, 40)).toString('hex'),
    secret: randomInt(0, 2) ? randomBytes(randomInt(1, 33)).toString('hex') : '',
    ad: randomInt(0, 2) ? randomBytes(randomInt(1, 33)).toString('hex') : '',
    parallelism: p, memoryKiB: 8 * p + randomInt(0, 600), passes: randomInt(1, 5), tagLength: [4, 16, 32, 64, 65, 100, 128][randomInt(0, 7)],
  }
  c.tag = argon2Sync('argon2id', {
    message: Buffer.from(c.password, 'hex'), nonce: Buffer.from(c.salt, 'hex'),
    secret: Buffer.from(c.secret, 'hex'), associatedData: Buffer.from(c.ad, 'hex'),
    parallelism: c.parallelism, memory: c.memoryKiB, passes: c.passes, tagLength: c.tagLength,
  }).toString('hex')
  return c
})

const main = String.raw`
import CryptoKit
import Foundation
typealias R = IdentityRecovery
func hx(_ s: String) -> [UInt8] { var o: [UInt8] = []; var i = s.startIndex; while i < s.endIndex { let j = s.index(i, offsetBy: 2); o.append(UInt8(s[i..<j], radix: 16)!); i = j }; return o }
func hs(_ b: [UInt8]?) -> String { b.map { $0.map { String(format: "%02x", $0) }.joined() } ?? "nil" }
func emit(_ k: String, _ v: Any) { print("\(k)=\(v)") }
func code10() -> [UInt8] { hx("009e01a578034a5304ef") }
func j(_ path: String) -> Any { try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) }
func verdict<T>(_ v: R.Verdict<T>, _ show: (T) -> String) -> String { switch v { case .ok(let x): return "ok:" + show(x); case .no(let r): return "no:" + r } }
let F = j(CommandLine.arguments[1]) as! [String: Any]
let cases = j(CommandLine.arguments[2]) as! [[String: Any]]

// Argon2id: RFC 9106, then the random cross-check
let rfc = F["rfc9106"] as! [String: Any]
emit("rfc", hs(Argon2id.hash(password: hx(rfc["password"] as! String), salt: hx(rfc["salt"] as! String), secret: hx(rfc["secret"] as! String), ad: hx(rfc["ad"] as! String),
  params: .init(memoryKiB: rfc["memoryKiB"] as! Int, passes: rfc["passes"] as! Int, parallelism: rfc["parallelism"] as! Int, tagLength: rfc["tagLength"] as! Int))))
for (i, c) in cases.enumerated() {
  emit("case\(i)", hs(Argon2id.hash(password: hx(c["password"] as! String), salt: hx(c["salt"] as! String), secret: hx(c["secret"] as! String), ad: hx(c["ad"] as! String),
    params: .init(memoryKiB: c["memoryKiB"] as! Int, passes: c["passes"] as! Int, parallelism: c["parallelism"] as! Int, tagLength: c["tagLength"] as! Int))))
}
let pa = (F["params"] as! [String: Any])["argon2"] as! [String: Any]
emit("params", Argon2id.bento == .init(memoryKiB: pa["memoryKiB"] as! Int, passes: pa["passes"] as! Int, parallelism: pa["parallelism"] as! Int, tagLength: pa["tagLength"] as! Int) && pa["version"] as! Int == 0x13)

// the wipe: every buffer Argon2id frees is all zeros by then, the 64 MiB of blocks included
var released = 0, largest = 0, dirty = 0
Argon2id.probe = { p, n in released += 1; largest = max(largest, n); for i in 0..<n where p[i] != 0 { dirty += 1; break } }
_ = Argon2id.hash(password: hx("009e01a578034a5304ef"), salt: hx("101112131415161718191a1b1c1d1e1f"))
Argon2id.probe = nil
emit("wipe", "\(released)|\(largest)|\(dirty)")

// memory: refused BEFORE anything is allocated when the process can't afford it
released = 0
Argon2id.probe = { _, _ in released += 1 }
Argon2id.availableMemory = { 48 << 20 }
let low = Argon2id.hash(password: code10(), salt: hx("101112131415161718191a1b1c1d1e1f"))
let lowWrap = R.recoveryWrapKey(code: code10(), salt: hx("101112131415161718191a1b1c1d1e1f"))
emit("mem.low", "\(low == nil)|\(lowWrap == nil)|\(released)|\(Argon2id.hasMemory())")
Argon2id.availableMemory = { Argon2id.memoryNeeded(Argon2id.bento) }
emit("mem.edge", Argon2id.hash(password: code10(), salt: hx("101112131415161718191a1b1c1d1e1f")).map(hs) ?? "nil")
Argon2id.availableMemory = { Argon2id.memoryNeeded(Argon2id.bento) - 1 }
emit("mem.short1", Argon2id.hash(password: code10(), salt: hx("101112131415161718191a1b1c1d1e1f")) == nil)
Argon2id.availableMemory = { nil }
emit("mem.nolimit", Argon2id.hasMemory())
emit("mem.needed", Argon2id.memoryNeeded(Argon2id.bento))
Argon2id.probe = nil

// codes and parsing
for (i, c) in (F["codes"] as! [[String: Any]]).enumerated() { emit("fmt\(i)", R.formatCode(hx(c["bytes"] as! String)) ?? "nil") }
for (i, c) in (F["parse"] as! [[String: Any]]).enumerated() { emit("parse\(i)", verdict(R.parseCode(c["input"] as! String)) { hs($0) }) }

// derivations
let d = F["derivations"] as! [String: Any]
let code = hx(d["code"] as! String)
let s0 = Date()
emit("argon2_A", hs(Argon2id.hash(password: code, salt: hx(d["salt"] as! String))))
emit("argon2_ms", Int(Date().timeIntervalSince(s0) * 1000))
emit("wrapKey", hs(R.recoveryWrapKey(code: code, salt: hx(d["salt"] as! String))))
emit("verifier", hs(R.recoveryVerifier(code: code, saltV: hx(d["saltV"] as! String))))
let prf = d["prf"] as! [String: String]
emit("prfKek", hs(R.prfKek(prfOutput: hx(prf["output"]!), salt: hx(prf["salt"]!))))
emit("short.code", R.recoveryWrapKey(code: Array(code.dropLast()), salt: hx(d["salt"] as! String)) == nil)

// blobs: reproduce, open, and refuse
let b = F["blobs"] as! [String: Any]
let k = b["keys"] as! [String: String]
let acct = hx(k["accountD"]!), kx = hx(k["kxD"]!), other = hx(k["otherD"]!)
let pb = b["prf"] as! [String: Any], pin = pb["inputs"] as! [String: String]
func blobStr(_ x: R.PrfBlob?) -> String { x.map { "\($0.v)|\($0.cred)|\($0.salt)|\($0.iv)|\($0.ct)" } ?? "nil" }
func fixBlob(_ m: [String: Any]) -> R.PrfBlob { R.PrfBlob(v: m["v"] as! Int, cred: m["cred"] as! String, salt: m["salt"] as! String, iv: m["iv"] as! String, ct: m["ct"] as! String) }
for (name, mode, keys) in [("unruled", R.KxMode.unruled, R.BlobKeys(account: acct, kx: nil)), ("modeA", R.KxMode.A, R.BlobKeys(account: acct, kx: kx))] {
  emit("prf.\(name).seal", blobStr(R.sealPrfBlob(prfOutput: hx(pin["prfOutput"]!), credentialId: hx(pin["credentialId"]!), salt: hx(pin["salt"]!), iv: hx(pin["iv"]!), keys: keys, mode: mode)))
  emit("prf.\(name).want", blobStr(fixBlob(pb[name] as! [String: Any])))
  emit("prf.\(name).open", verdict(R.openPrfBlob(fixBlob(pb[name] as! [String: Any]), prfOutput: hx(pin["prfOutput"]!), credentialId: hx(pin["credentialId"]!), accountPub: k["accountPub"]!, kxPub: k["kxPub"]!, mode: mode)) { hs($0.account) + "+" + hs($0.kx) })
}
let ub = fixBlob(pb["unruled"] as! [String: Any])
emit("prf.otherCred", verdict(R.openPrfBlob(ub, prfOutput: hx(pin["prfOutput"]!), credentialId: hx("00"), accountPub: k["accountPub"]!)) { _ in "" })
emit("prf.otherPrf", verdict(R.openPrfBlob(ub, prfOutput: [UInt8](repeating: 9, count: 32), credentialId: hx(pin["credentialId"]!), accountPub: k["accountPub"]!)) { _ in "" })
emit("prf.swappedKey", verdict(R.openPrfBlob(ub, prfOutput: hx(pin["prfOutput"]!), credentialId: hx(pin["credentialId"]!), accountPub: k["kxPub"]!)) { _ in "" })
emit("prf.modeMismatch", verdict(R.openPrfBlob(ub, prfOutput: hx(pin["prfOutput"]!), credentialId: hx(pin["credentialId"]!), accountPub: k["accountPub"]!, kxPub: k["kxPub"]!, mode: .A)) { _ in "" })
emit("prf.v2", verdict(R.openPrfBlob(R.PrfBlob(v: 2, cred: ub.cred, salt: ub.salt, iv: ub.iv, ct: ub.ct), prfOutput: hx(pin["prfOutput"]!), credentialId: hx(pin["credentialId"]!), accountPub: k["accountPub"]!)) { _ in "" })
emit("prf.badSalt", verdict(R.openPrfBlob(R.PrfBlob(v: 1, cred: ub.cred, salt: "AAAA", iv: ub.iv, ct: ub.ct), prfOutput: hx(pin["prfOutput"]!), credentialId: hx(pin["credentialId"]!), accountPub: k["accountPub"]!)) { _ in "" })
// a blob sealed around ANOTHER key: it decrypts, and the check refuses it
let swapped = R.sealPrfBlob(prfOutput: hx(pin["prfOutput"]!), credentialId: hx(pin["credentialId"]!), salt: hx(pin["salt"]!), iv: hx(pin["iv"]!), keys: R.BlobKeys(account: other, kx: nil))!
emit("prf.swappedBlob", verdict(R.openPrfBlob(swapped, prfOutput: hx(pin["prfOutput"]!), credentialId: hx(pin["credentialId"]!), accountPub: k["accountPub"]!)) { _ in "" })

let rb = b["recovery"] as! [String: Any], rin = rb["inputs"] as! [String: String]
let wk = R.recoveryWrapKey(code: hx(rin["code"]!), salt: hx(rin["salt"]!))!
emit("rc.inner", hs(R.sealRecoveryInner(wrapKey: wk, iv: hx(rin["iv"]!), accountPub: k["accountPub"]!, keys: R.BlobKeys(account: acct, kx: nil))))
emit("rc.open", verdict(R.openRecoveryInner(hx(rb["inner"] as! String), wrapKey: wk, iv: hx(rin["iv"]!), accountPub: k["accountPub"]!)) { hs($0.account) })
emit("rc.otherAccount", verdict(R.openRecoveryInner(hx(rb["inner"] as! String), wrapKey: wk, iv: hx(rin["iv"]!), accountPub: k["kxPub"]!)) { _ in "" })
var flipped = hx(rb["inner"] as! String); flipped[3] ^= 1
emit("rc.tampered", verdict(R.openRecoveryInner(flipped, wrapKey: wk, iv: hx(rin["iv"]!), accountPub: k["accountPub"]!)) { _ in "" })

// the directory's pepper rows, from the same primitives (the host doesn't run these)
let pp = b["pepper"] as! [String: String]
let P = R.hkdf(hx(pp["secret"]!), info: "bento/id/pepper/v1.\(R.accountTag(k["accountPub"]!))")
let vk = R.hkdf(P, info: "bento/id/pepper/v1/verify"), pwk = R.hkdf(P, info: "bento/id/pepper/v1/wrap")
emit("pep.verifyKey", hs(vk)); emit("pep.wrapKey", hs(pwk))
emit("pep.tag", hs(Array(HMAC<SHA256>.authenticationCode(for: hx(d["verifier"] as! String), using: SymmetricKey(data: vk)))))
emit("pep.outer", hs(R.gcmSeal(key: pwk, iv: hx(pp["iv"]!), aad: "bento/id/rc-pepper/v1.\(R.accountTag(k["accountPub"]!))", hx(rb["inner"] as! String))))

// scalars
for (i, s) in (F["scalars"] as! [[String: String]]).enumerated() {
  emit("scalar\(i)", verdict(R.unpackScalars(hx(s["d"]!), accountPub: s["pub"]!)) { _ in "" })
}
emit("scalar.length", verdict(R.unpackScalars(Array(acct.dropLast()), accountPub: k["accountPub"]!)) { _ in "" })
`
const dir = mkdtempSync(join(tmpdir(), 'bento-idrec-'))
let out
try {
  writeFileSync(join(dir, 'main.swift'), main)
  writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases))
  execFileSync('swiftc', ['-O', '-D', 'BENTO_WIPE_PROBE', '-o', join(dir, 'a'), ...SRC, join(dir, 'main.swift')], { stdio: 'pipe' })
  out = Object.fromEntries(execFileSync(join(dir, 'a'), [FIXTURE, join(dir, 'cases.json')], { maxBuffer: 1 << 24 }).toString().trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)))
} catch (err) { console.error('swiftc or run failed:\n' + (err.stderr?.toString() ?? err.message)); process.exit(2) }
finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }

const F = JSON.parse(readFileSync(FIXTURE, 'utf8'))
let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }

console.log('Argon2id (no Apple implementation; this is ours):')
ok(out.rfc === F.rfc9106.tag, 'RFC 9106 §5.3: p = 4, with a secret and associated data')
const bad = cases.filter((c, i) => out[`case${i}`] !== c.tag)
ok(bad.length === 0, `${cases.length} random inputs and parameters agree with Node's native Argon2id` + (bad.length ? ` (${bad.length} differ, first: ${JSON.stringify(bad[0])})` : ''))
ok(out.params === 'true', "the fixture's parameters are ours: version 0x13, p = 1, 64 MiB, t = 3, 32 bytes")
console.log(`  (64 MiB, t = 3 took ${out.argon2_ms} ms here)`)

{
  const [released, largest, dirty] = (out.wipe ?? '').split('|').map(Number)
  ok(released >= 6 && largest === 65536 * 128 && dirty === 0, `every buffer is zeroed before it's freed, the 64 MiB of blocks included (${released} buffers, ${dirty} not zeroed)`)
}
console.log('memory (iOS ends a process past its limit; nothing to catch):')
{
  const [lowNil, wrapNil, released, has] = (out['mem.low'] ?? '').split('|')
  ok(lowNil === 'true' && wrapNil === 'true' && has === 'false', 'with 48 MiB free, Argon2id and the wrap key refuse, and hasMemory() says so')
  ok(released === '0', 'and nothing was allocated first (no buffer was ever released)')
  ok(out['mem.edge'] === F.derivations.argon2_A, 'with exactly 64 MiB + headroom free it runs, and gives the fixture\'s bytes')
  ok(out['mem.short1'] === 'true', 'one byte short of that: refused')
  ok(out['mem.nolimit'] === 'true', 'where there is no limit (the simulator, the Mac), it runs')
  ok(Number(out['mem.needed']) === 64 * 1024 * 1024 + 32 * 1024 * 1024, `it asks for the 64 MiB of blocks plus 32 MiB headroom (${out['mem.needed']})`)
}
console.log('the recovery code:')
F.codes.forEach((c, i) => ok(out[`fmt${i}`] === c.printed, `${c.bytes} prints as ${c.printed}`))
F.parse.forEach((p, i) => {
  const want = p.bytes ? `ok:${p.bytes}` : `no:${p.reason}`
  ok(out[`parse${i}`] === want, `"${p.input}" (${p.note}) → ${want}${out[`parse${i}`] === want ? '' : ` (got ${out[`parse${i}`]})`}`)
})

console.log('derivations:')
const dv = F.derivations
ok(out.argon2_A === dv.argon2_A, 'Argon2id(code, salt)')
ok(out.wrapKey === dv.wrapKey, 'the recovery blob\'s wrap key')
ok(out.verifier === dv.verifier, 'the verifier, under its own salt')
ok(out.prfKek === dv.prfKek, "the PRF blob's key")
ok(out['short.code'] === 'true', 'a code of the wrong length derives nothing')

console.log('the PRF blob:')
const k = F.blobs.keys
for (const [name, kxPart] of [['unruled', 'nil'], ['modeA', k.kxD]]) {
  ok(out[`prf.${name}.seal`] === out[`prf.${name}.want`], `${name}: sealed byte for byte`)
  ok(out[`prf.${name}.open`] === `ok:${k.accountD}+${kxPart}`, `${name}: opens to the account scalar${name === 'modeA' ? ' and the kx scalar' : ''}`)
}
ok(out['prf.otherCred'] === 'no:credential', 'another passkey\'s credential: refused before decrypting')
ok(out['prf.otherPrf'] === 'no:decrypt', 'a wrong PRF output: does not decrypt')
ok(out['prf.swappedKey'] === 'no:key-mismatch', 'checked against another public key: key-mismatch')
ok(out['prf.swappedBlob'] === 'no:key-mismatch', 'a blob around ANOTHER key (a malicious directory\'s swap) decrypts, and is refused')
ok(out['prf.modeMismatch'] === 'no:length', 'read under a kx mode it was not sealed for: length')
ok(out['prf.v2'] === 'no:version' && out['prf.badSalt'] === 'no:grammar', 'an unknown version or a malformed salt: refused')

console.log('the recovery-code blob:')
ok(out['rc.inner'] === F.blobs.recovery.inner, 'the inner layer, sealed byte for byte')
ok(out['rc.open'] === `ok:${k.accountD}`, 'and opened back to the account scalar')
ok(out['rc.otherAccount'] === 'no:decrypt', "bound to the account: another account's tag does not decrypt")
ok(out['rc.tampered'] === 'no:decrypt', 'one flipped bit: does not decrypt')
const pp = F.blobs.pepper
ok(out['pep.verifyKey'] === pp.verifyKey && out['pep.wrapKey'] === pp.wrapKey, "the directory's pepper subkeys (its rows, from the same primitives)")
ok(out['pep.tag'] === pp.verifierTag && out['pep.outer'] === pp.outer, 'its verifier tag and outer layer')

console.log('recovered scalars, checked through CryptoKit:')
F.scalars.forEach((s, i) => {
  const want = s.expect === 'accept' ? 'ok:' : `no:${s.reason}`
  ok(out[`scalar${i}`] === want, `${s.name} → ${want}${out[`scalar${i}`] === want ? '' : ` (got ${out[`scalar${i}`]})`}`)
})
ok(out['scalar.length'] === 'no:length', 'a plaintext of the wrong length: refused')
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
