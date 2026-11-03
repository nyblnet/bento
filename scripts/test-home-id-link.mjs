#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/connect on iOS and the Mac — the Swift link v1 against the conformance
 * contract, the `link` section of kernel/fixtures/identity-v1.json.
 *
 *   node scripts/test-home-id-link.mjs        (ID_FIXTURE=<path> to point elsewhere)
 *
 * Compiles the real home/ios/IdentityLink.swift and runs the same checks as the
 * kernel's own runner (scripts/test-link.ts): the deterministic rows (code → slot,
 * transcript, Z, direction keys, SAS, the exact msg2 and sealed ciphertexts) are
 * recomputed byte for byte; every verdict row (msg0/msg1, the offer, the
 * directory's release check, N's final check) must give the stated verdict AND
 * reason; the release rows pin spend-first. A verifier must answer, never trap.
 *
 * Mutants (LINK_MUTANT=<name>) edit a COPY of the Swift and expect red; see the
 * list at the bottom. Apple platforms only (CryptoKit); skips elsewhere.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = process.env.ID_FIXTURE || join(ROOT, 'kernel/fixtures/identity-v1.json')
const SWIFT = ['HostDocStore.swift', 'IdentityKeys.swift', 'IdentityDisplayTable.swift', 'IdentityStatements.swift', 'IdentityRecovery.swift',
  'Argon2id.swift', 'IdentityLink.swift']
if (!existsSync(FIXTURE)) { console.log(`home id link: the fixture is missing (${FIXTURE}).`); process.exit(1) }
{
  const L = JSON.parse(readFileSync(FIXTURE, 'utf8')).link
  if (!L) { console.log('home id link: the fixture has no `link` section.'); process.exit(1) }
  // a floor: a shrunken fixture must not pass with fewer rows to fail
  const n = { codes: L.codes.length, sessions: L.sessions.length, sas: L.sas.length, sasMatch: L.sasMatch.length, roles: L.roles.length,
    msgs: L.msgs.length, offers: L.offers.length, offerWire: L.offerWire.length, release: L.release.length, final: L.final.length }
  const FLOOR = { codes: 3, sessions: 2, sas: 6, sasMatch: 7, roles: 4, msgs: 12, offers: 17, offerWire: 5, release: 26, final: 15 }
  const short = Object.entries(FLOOR).filter(([k, min]) => n[k] < min)
  if (short.length) { console.log(`home id link: the fixture is SHORT: ${short.map(([k, m]) => `${k} ${n[k]} < ${m}`).join(', ')}`); process.exit(1) }
  console.log(`fixture floor met: ${Object.entries(n).map(([k, v]) => `${k} ${v}`).join(', ')}`)
}
try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe' }) } catch { console.log('home id link: SKIPPED — needs an Apple toolchain (CryptoKit, Security).'); process.exit(0) }

const main = String.raw`
import CryptoKit
import Foundation
typealias L = IdentityLink
typealias S = IdentityStatements
let F = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let LK = F["link"] as! [String: Any]
let fNow = (F["now"] as! NSNumber).intValue
var checks = 0, fails = 0
func ok(_ c: Bool, _ m: String) { checks += 1; if !c { fails += 1 }; print("\(c ? "  ok  " : "  FAIL")  \(m)") }
func unhex(_ h: String) -> [UInt8] { stride(from: 0, to: h.count, by: 2).map { UInt8(h[h.index(h.startIndex, offsetBy: $0)..<h.index(h.startIndex, offsetBy: $0 + 2)], radix: 16)! } }
func hex(_ b: [UInt8]) -> String { b.map { String(format: "%02x", $0) }.joined() }
func rows(_ k: String) -> [[String: Any]] { LK[k] as! [[String: Any]] }
func verdictOk<T>(_ v: S.Verdict<T>, _ r: [String: Any]) -> Bool {
  (r["expect"] as! String) == "accept" ? v.ok : (!v.ok && (r["reason"] == nil || v.reason == (r["reason"] as! String)))
}
func show<T>(_ v: S.Verdict<T>) -> String { v.ok ? "accept" : "reject (\(v.reason ?? "?"))" }
func keysOf(_ r: [String: Any]) -> L.Keys { L.Keys(h2n: unhex(r["h2n"] as! String), n2h: unhex(r["n2h"] as! String), sasKey: [UInt8](repeating: 0, count: 32)) }
func ecdh(_ dHex: String) -> (key: P256.KeyAgreement.PrivateKey, pub: String) {
  let k = try! P256.KeyAgreement.PrivateKey(rawRepresentation: Data(unhex(dHex)))
  return (k, S.b64uEnc(k.publicKey.x963Representation))
}
func offerOf(_ o: [String: Any]) -> L.Offer { L.Offer(devicePub: o["devicePub"] as! String, consentPub: o["consentPub"] as? String, kx: o["kx"] as! String, label: o["label"] as? String, platform: o["platform"] as! String) }

let codes = rows("codes")
print("link code → slot (\(codes.count))")
for c in codes {
  let code = unhex(c["codeHex"] as! String), printed = c["printed"] as! String
  ok(IdentityRecovery.formatCode(code) == printed, "printed in the recovery-code format: \(printed)")
  if case .ok(let p) = IdentityRecovery.parseCode(printed.lowercased()) { ok(p == code, "\(printed): parses back to its 10 bytes") } else { ok(false, "\(printed): parses") }
  let s = L.slot(code: code)!
  ok(s.id == (c["id"] as! String) && s.tok == (c["tok"] as! String) && hex(s.salt) == (c["saltHex"] as! String), "\(printed): id, tok and salt by HKDF")
  ok(L.tokHash(s.tok) == (c["tokHash"] as! String), "\(printed): the directory stores sha256(tok bytes)")
}
ok(L.slot(code: [1, 2, 3]) == nil, "a code of the wrong length derives nothing")

print("sessions: transcript, Z, keys, SAS")
for s in rows("sessions") {
  let name = s["name"] as! String, role = L.Role(rawValue: s["roleD"] as! String)!
  let eD = ecdh(s["eDScalarHex"] as! String), eS = ecdh(s["eSScalarHex"] as! String)
  ok(eD.pub == (s["eD"] as! String) && eS.pub == (s["eS"] as! String), "\(name): the ephemerals are d·G of the stated scalars")
  ok(L.buildMsg0(eD.pub, role) == (s["msg0"] as! String) && L.buildMsg1(eS.pub) == (s["msg1"] as! String), "\(name): msg0 and msg1 bytes")
  let m0 = L.parseMsg0(s["msg0"] as! String), m1 = L.parseMsg1(s["msg1"] as! String)
  ok(m0.value?.eD == eD.pub && m0.value?.role == role && m1.value == eS.pub, "\(name): msg0 and msg1 parse")
  let slot = L.slot(code: unhex(s["codeHex"] as! String))!
  let t = L.transcript(id: slot.id, eD: eD.pub, eS: eS.pub, roleD: role)
  ok(t == (s["t"] as! String), "\(name): t = sha256(lnkt.v1 id E_D E_S roleD)")
  ok(hex(L.sharedSecret(own: eD.key, otherPub: eS.pub)!) == (s["zHex"] as! String), "\(name): Z is the ECDH x-coordinate")
  let k = L.keys(z: unhex(s["zHex"] as! String), salt: slot.salt, t: s["t"] as! String)!
  ok(hex(k.h2n) == (s["h2n"] as! String) && hex(k.n2h) == (s["n2h"] as! String) && hex(k.sasKey) == (s["sasKeyHex"] as! String) && k.sas == (s["sas"] as! String), "\(name): h2n, n2h, sasKey, SAS \(k.sas)")
  let kD = L.keys(own: eD.key, otherPub: eS.pub, salt: slot.salt, t: t!)!, kS = L.keys(own: eS.key, otherPub: eD.pub, salt: slot.salt, t: t!)!
  ok(kD == kS && kD.sas == (s["sas"] as! String), "\(name): both sides derive the same keys and SAS")
  ok(k.h2n != k.n2h, "\(name): the two directions use different keys")
  let ns = L.keys(z: unhex(s["zHex"] as! String), salt: [UInt8](repeating: 0, count: 32), t: s["t"] as! String)!
  ok(ns.h2n != k.h2n && ns.sas != k.sas, "\(name): without the code's salt, other keys and another SAS")
}
let refl = LK["reflected"] as! [String: Any]
ok(L.transcript(id: refl["id"] as! String, eD: refl["eD"] as! String, eS: refl["eS"] as! String, roleD: .H) == nil, "a reflected ephemeral (E_S = E_D) gets no transcript")

print("SAS digits, typed SAS, roles")
for s in rows("sas") { ok(L.sasDigits(unhex(s["sasKeyHex"] as! String)) == (s["sas"] as! String), "sasKey \((s["sasKeyHex"] as! String).prefix(8)) → \(s["sas"] as! String)") }
for m in rows("sasMatch") { ok(L.sasMatches(typed: m["typed"] as! String, sas: m["sas"] as! String) == (m["match"] as! Bool), "typed \"\(m["typed"] as! String)\" vs \(m["sas"] as! String) → \(m["match"] as! Bool)") }
for x in rows("roles") { ok(L.scannerMayProceed(roleD: L.Role(rawValue: x["roleD"] as! String)!, scannerHoldsAccount: x["scannerHoldsAccount"] as! Bool) == (x["proceed"] as! Bool), "D claims \(x["roleD"] as! String), S \((x["scannerHoldsAccount"] as! Bool) ? "holds" : "holds no") account → \(x["proceed"] as! Bool)") }

print("msg0 / msg1 grammar")
for m in rows("msgs") {
  let msg = m["msg"] as! String
  if (m["kind"] as! String) == "msg1" { let v = L.parseMsg1(msg); ok(verdictOk(v, m), "\(m["name"] as! String): \(show(v))") }
  else { let v = L.parseMsg0(msg); ok(verdictOk(v, m), "\(m["name"] as! String): \(show(v))") }
}

print("msg2: the exact ciphertext")
do {
  let m = LK["msg2"] as! [String: Any], K = keysOf(m), t = m["t"] as! String
  ok(L.aad(t, .offer) == (m["aad"] as! String), "AAD for message 2")
  ok(L.seal(K, .offer, t: t, iv: unhex(m["ivHex"] as! String), Array((m["plaintext"] as! String).utf8)) == (m["wire"] as! String), "msg2 = iv ‖ AES-GCM(n2h, offer, AAD) byte for byte")
  let o = L.openOffer(K, t: t, wire: m["wire"] as! String)
  ok(o.ok, "H opens and accepts the offer: \(show(o))")
}

print("the offer, as H checks it")
for x in rows("offers") {
  let text = x["text"] as! String, t = x["t"] as! String
  let v = L.verifyOffer(text, t: t)
  ok(verdictOk(v, x), "\(x["name"] as! String): \(show(v))")
  if (x["expect"] as! String) == "accept", let o = v.value {
    let p = text.components(separatedBy: ".")
    ok(L.buildOffer(o, popDevice: p[6], popConsent: p[7].isEmpty ? nil : p[7]) == text, "\(x["name"] as! String): rebuilds to the same bytes")
    var flipped = Array(text); let i = flipped.count - 2; flipped[i] = flipped[i] == "A" ? "B" : "A"
    var t2 = Array(t); t2[t2.count - 1] = t2[t2.count - 1] == "A" ? "Q" : "A"
    ok(!L.verifyOffer(text, t: String(t2)).ok, "\(x["name"] as! String): refused under another transcript")
    ok(!L.verifyOffer(String(flipped), t: t).ok, "\(x["name"] as! String): refused with its last PoP changed")
  }
}
for x in rows("offerWire") {
  let v = L.openOffer(keysOf(x), t: x["t"] as! String, wire: x["wire"] as! String)
  ok(verdictOk(v, x), "\(x["name"] as! String): \(show(v))")
}

print("msg3: the sealed key release")
let bind = LK["bind"] as! [String: Any]
do {
  let m = LK["msg3"] as! [String: Any], K = keysOf(m), t = m["t"] as! String
  let blob = IdentityRecovery.packScalars(.init(account: unhex(bind["accountScalarHex"] as! String), kx: unhex(bind["kxScalarHex"] as! String)))!
  ok(hex(blob) == (m["sealedPlaintextHex"] as! String) && blob.count == 64, "the sealed plaintext is packScalars(account, recovery kx): 64 bytes")
  ok(L.aad(t, .final) == (m["aad"] as! String), "AAD for message 3")
  ok(L.seal(K, .final, t: t, iv: unhex(m["ivHex"] as! String), blob) == (m["sealed"] as! String), "SEALED = iv ‖ AES-GCM(h2n, blob, AAD) byte for byte")
  ok((m["text"] as! String).components(separatedBy: "\n")[7] == (m["sealed"] as! String), "msg3 carries SEALED as its last line")
  ok(L.open(K, .final, t: t, wire: m["sealed"] as! String).map(hex) == (m["sealedPlaintextHex"] as! String), "opens back to the blob")
  ok(L.open(K, .offer, t: t, wire: m["sealed"] as! String) == nil, "SEALED does not open as message 2 (one key, one message)")
  let b = S.parseBind(bind["text"] as! String).value
  ok(b != nil && S.verifyBind(bind["text"] as! String, bind["sig"] as! String, now: fNow).ok, "the binding verifies")
  let f = L.parseFinal(m["text"] as! String)!
  ok(L.buildFinal(f) == (m["text"] as! String), "msg3 parses and rebuilds to the same eight lines")
}

print("the directory's release check")
for x in rows("release") {
  var calls = 0
  let spent = (x["challengeSpent"] as? Bool) ?? false
  let v = L.verifyRelease(x["text"] as! String, bindText: x["bindText"] as! String, state: x["state"] as! String, challenge: x["challenge"] as! String,
    now: (x["now"] as? NSNumber)?.intValue ?? fNow, spend: { _ in calls += 1; return !spent })
  ok(verdictOk(v, x), "\(x["name"] as! String): \(show(v))")
  let want = (x["spendCalled"] as! Bool) ? 1 : 0
  ok(calls == want, "\(x["name"] as! String): spend called \(calls)× (want \(want))")
}
do {
  let h = rows("release").first { ($0["expect"] as! String) == "accept" }!
  let v = L.verifyRelease(h["text"] as! String, bindText: h["bindText"] as! String, state: "active", challenge: h["challenge"] as! String, now: fNow, spend: { _ in true })
  ok(v.value?.sealed == ((LK["msg3"] as! [String: Any])["sealed"] as! String), "an accepted release hands back exactly SEALED")
}

print("N's final check")
for x in rows("final") {
  let b = x["binding"] as! [String: String], offer = offerOf(x["offer"] as! [String: Any])
  let v = L.openFinal(x["text"] as! String, keys: keysOf(x), t: x["t"] as! String, offer: offer, accountPub: b["accountPub"]!, kxPub: b["kxPub"]!,
    now: (x["now"] as? NSNumber)?.intValue ?? fNow)
  ok(verdictOk(v, x), "\(x["name"] as! String): \(show(v))")
  if (x["expect"] as! String) == "accept", let o = v.value {
    ok(hex(o.keys.account) == (bind["accountScalarHex"] as! String) && hex(o.keys.kx) == (bind["kxScalarHex"] as! String), "\(x["name"] as! String): N recovers the account and recovery kx scalars")
    ok(o.device.devicePub == offer.devicePub, "\(x["name"] as! String): N's own dev. certificate")
  }
}

print("the platform field is context, never proof")
ok(L.showPlatform("android").known && L.showPlatform("ios").known, "known tokens are shown by name")
ok(!L.showPlatform("totally-new-os").known && L.showPlatform("totally-new-os").name == L.showPlatform("").name, "an unknown token is shown as unknown, not as itself")
ok(!L.showPlatform("android\u{202E}").known, "a token with a bidi control is not known")

print("\n\(checks - fails)/\(checks) checks passed")
exit(fails == 0 ? 0 : 1)
`
const MUTANTS = {
  // name: [file, from, to] — each edits a copy of the Swift and must turn the rig red
  'spend-after-state': ['IdentityLink.swift', 'if !spend(challenge) { return .no("replay") }\n        if state != "active" { return .no("state") }', 'if state != "active" { return .no("state") }\n        if !spend(challenge) { return .no("replay") }'],
  'frozen-accepted': ['IdentityLink.swift', 'if state != "active" { return .no("state") }', 'if state == "nothing" { return .no("state") }'],
  'skip-device-mismatch': ['IdentityLink.swift', 'if nd.devicePub != offer.devicePub { return .no("device-mismatch") }', ''],
  'skip-consent-mismatch': ['IdentityLink.swift', 'if nd.consentPub != offer.consentPub { return .no("consent-mismatch") }', ''],
  'skip-kx-mismatch': ['IdentityLink.swift', 'if nd.kx != offer.kx { return .no("kx-mismatch") }', ''],
  'one-key-both-ways': ['IdentityLink.swift', 'n == .offer ? k.n2h : k.h2n', 'k.h2n'],
  'aad-without-number': ['IdentityLink.swift', '"lnka.v1.\\(t).\\(n.rawValue)"', '"lnka.v1.\\(t)"'],
  'empty-salt': ['IdentityLink.swift', 'R.hkdf(z, salt: salt, info: "bento/id/link/v1/sas.\\(t)")', 'R.hkdf(z, salt: [], info: "bento/id/link/v1/sas.\\(t)")'],
  'role-not-checked': ['IdentityLink.swift', 'roleD == .H ? !scannerHoldsAccount : scannerHoldsAccount', 'true'],
  'n-device-is-h': ['IdentityLink.swift', 'if nd.devicePub == hd.devicePub { return .no("n-device-is-h") }', ''],
  // (a `cns-purpose` mutant is EQUIVALENT: only `link` has the dev. payload family, so verifyConsent's payload-family check already refuses every other purpose)
  'sas-not-compared': ['IdentityLink.swift', 'isDigits(a) && isDigits(b) && a == b', 'isDigits(a) && isDigits(b)'],
  'unknown-platform-shown': ['IdentityLink.swift', 'PlatformShown(name: "Unknown device type", known: false)', 'PlatformShown(name: token, known: true)'],
  'reflected-ok': ['IdentityLink.swift', 'eD == eS ? nil :', ''],
  'light-h-allowed': ['IdentityLink.swift', 'guard let hConsent = hd.consentPub else { return .no("h-no-consent") }', 'let hConsent = hd.consentPub ?? hd.devicePub'],
}
const mutant = process.env.LINK_MUTANT
const dir = mkdtempSync(join(tmpdir(), 'bento-idlink-'))
try {
  const files = SWIFT.map((f) => { const d = join(dir, f); copyFileSync(join(ROOT, 'home/ios', f), d); return d })
  if (mutant) {
    const m = MUTANTS[mutant]; if (!m) { console.error(`unknown mutant ${mutant}`); process.exit(2) }
    const p = join(dir, m[0]); const src = readFileSync(p, 'utf8')
    if (!src.includes(m[1])) { console.error(`mutant ${mutant}: its anchor is not in ${m[0]} — the mutant was NOT applied`); process.exit(2) }
    writeFileSync(p, src.replace(m[1], m[2]))
  }
  if (process.env.LINK_LIST_MUTANTS) { console.log(Object.keys(MUTANTS).join(' ')); process.exit(0) }
  writeFileSync(join(dir, 'main.swift'), main)
  execFileSync('swiftc', ['-O', '-o', join(dir, 's'), ...files, join(dir, 'main.swift')], { stdio: 'pipe' })
} catch (e) { console.error('swiftc failed:\n' + (e.stderr?.toString() ?? e.message)); rmSync(dir, { recursive: true, force: true }); process.exit(2) }
let code = 0
try { process.stdout.write(execFileSync(join(dir, 's'), [FIXTURE], { maxBuffer: 1 << 26 })) }
catch (e) { process.stdout.write(e.stdout?.toString() ?? ''); code = 1 }
finally { rmSync(dir, { recursive: true, force: true }) }
process.exit(code)
