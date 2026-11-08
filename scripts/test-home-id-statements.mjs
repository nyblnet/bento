#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/connect on iOS and the Mac — the Swift statements against the conformance
 * contract, kernel/fixtures/identity-v1.json.
 *
 *   node scripts/test-home-id-statements.mjs        (ID_FIXTURE=<path> to point elsewhere)
 *
 * WHY. Every host's statement code must reach the stated verdict on every row
 * (kernel/fixtures/README.md); two hosts reading the same bytes differently
 * would make one signature mean two things. This compiles the real
 * home/ios/IdentityStatements.swift and runs the same checks as the kernel's
 * own runner (scripts/test-statements.ts):
 *   - verdict AND reason on every statement row
 *   - accepted rows rebuild to the exact text and refuse a flipped signature
 *     bit, an extra field and a changed byte
 *   - the consent transcripts and the WebAuthn challenge
 *   - low-S pairs, routine purposes, and address normal forms
 * It re-reads the fixture every run and pins nothing: a regeneration changes
 * signatures, not verdicts.
 *
 * Apple platforms only (CryptoKit); skips elsewhere.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = process.env.ID_FIXTURE || join(ROOT, 'kernel/fixtures/identity-v1.json')
const SRC = ['HostDocStore.swift', 'IdentityKeys.swift', 'IdentityDisplayTable.swift', process.env.ID_STATEMENTS_SRC || 'IdentityStatements.swift'].map((f) => f.includes('/') ? f : join(ROOT, 'home/ios', f))
if (!existsSync(FIXTURE)) { console.log(`home id statements: the fixture is missing (${FIXTURE}) — it lands with K2.`); process.exit(1) }
// A floor on the fixture: a shrunken or truncated file must not pass quietly
// with fewer rows to fail. These are the counts the fixture had when this rig
// was written; raise them as it grows, never lower them.
{
  const F = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const n = {
    statements: F.statements?.length ?? 0,
    cns: (F.statements ?? []).filter((r) => r.type === 'cns').length,
    transcripts: F.transcripts?.length ?? 0,
    purposes: F.purposes?.length ?? 0,
    addresses: F.addresses?.length ?? 0,
    displayRanges: F.displayForbidden?.ranges?.length ?? 0,
  }
  const FLOOR = { statements: 95, cns: 15, transcripts: 5, purposes: 15, addresses: 23, displayRanges: 746 }
  const short = Object.entries(FLOOR).filter(([k, min]) => n[k] < min)
  if (short.length) {
    console.log(`home id statements: the fixture is SHORT: ${short.map(([k, min]) => `${k} ${n[k]} < ${min}`).join(', ')}`)
    process.exit(1)
  }
  console.log(`fixture floor met: ${Object.entries(n).map(([k, v]) => `${k} ${v}`).join(', ')}`)
}
// Apple platforms only: the Linux CI runner has swiftc but no CryptoKit, Security
// or LocalAuthentication, so probe for xcrun, which only Apple toolchains ship.
try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe' }) } catch { console.log('home id statements: SKIPPED — needs an Apple toolchain (CryptoKit, Security).'); process.exit(0) }

const main = String.raw`
import Foundation
typealias S = IdentityStatements
let F = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let keys = F["keys"] as! [String: String], dirKeys = F["directoryKeys"] as! [String: String]
let fNow = (F["now"] as! NSNumber).intValue
var checks = 0, fails = 0
var spendCalled = false
func ok(_ c: Bool, _ m: String) { checks += 1; if !c { fails += 1 }; print("\(c ? "  ok  " : "  FAIL")  \(m)") }
ok(S.kxMode == "C" && (F["kxMode"] as? String) == "C" && F["kxModeDefault"] == nil, "kx placement is mode C: both slots required, no other mode")
func check(_ r: [String: Any], _ text: String, _ sig: String) -> (Bool, String?, String?) {
  let now = (r["now"] as? NSNumber)?.intValue ?? fNow
  precondition(r["kxMode"] == nil, "no row selects a kx mode: mode C is the only one")
  switch r["type"] as! String {
  case "dev": let v = S.verifyDev(text, sig, now: now); return (v.ok, v.reason, v.value.map(S.buildDev))
  case "bind": let v = S.verifyBind(text, sig, now: now); return (v.ok, v.reason, v.value.map(S.buildBind))
  case "att": let v = S.verifyAtt(text, sig, directoryKeys: dirKeys, bindText: r["bindText"] as! String, now: now, maxAgeMs: (r["maxAgeMs"] as! NSNumber).intValue); return (v.ok, v.reason, v.value.map(S.buildAtt))
  case "tomb": let v = S.verifyTomb(text, sig, directoryKeys: dirKeys, now: now); return (v.ok, v.reason, v.value.map(S.buildTomb))
  case "del": let v = S.verifyDel(text, sig, accountPub: keys["account"]!, now: now); return (v.ok, v.reason, v.value.map { S.buildDel(address: $0.address, ts: $0.ts) })
  case "cmp": let v = S.verifyCmp(text, sig, accountPub: keys["account"]!, bindText: r["bindText"] as! String); return (v.ok, v.reason, v.value.map { S.buildCmp(bindHash: $0.bindHash, code: $0.code) })
  case "cns":
    let spent = (r["challengeSpent"] as? Bool) ?? false
    spendCalled = false
    let v = S.verifyConsent(text, sig, consentPub: keys["consent"]!, rp: r["rp"] as! String, audience: r["audience"] as! String,
      challenge: r["challenge"] as! String, payloadText: r["payloadText"] as! String, docId: r["docId"] as? String, now: now,
      spend: { _ in spendCalled = true; return !spent })
    return (v.ok, v.reason, v.value.map(S.buildConsent))
  default: return (false, "unknown-type", nil)
  }
}
let rows = F["statements"] as! [[String: Any]]
print("every statement row: verdict and reason (\(rows.count))")
for r in rows {
  let (accepted, reason, _) = check(r, r["text"] as! String, r["sig"] as! String)
  let want = (r["expect"] as! String) == "accept" ? "accept" : "reject:\(r["reason"] as? String ?? "?")"
  let got = accepted ? "accept" : "reject:\(reason ?? "?")"
  ok(got == want, "\(r["name"] as! String) → \(want)\(got == want ? "" : " (got \(got))")")
  if let wantSpend = r["spendCalled"] as? Bool {
    ok(spendCalled == wantSpend, "\(r["name"] as! String): the challenge is \(wantSpend ? "" : "NOT ")spent")
  }
}
print("the embedded display table is the fixture's, exactly")
let tbl = F["displayForbidden"] as! [String: Any]
let fixtureFlat = (tbl["ranges"] as! [[Int]]).flatMap { $0 }.map(UInt32.init)
ok(IdentityDisplayTable.flat == fixtureFlat && IdentityDisplayTable.unicode == (tbl["unicode"] as! String), "IdentityDisplayTable matches displayForbidden (\(fixtureFlat.count / 2) ranges, Unicode \(IdentityDisplayTable.unicode))")
ok(S.platformUnicodeIs17, "this platform's normaliser has Unicode 17.0 data (where it doesn't, display text is refused)")
print("accepted rows round-trip and refuse tampering")
for r in rows where (r["expect"] as! String) == "accept" {
  let text = r["text"] as! String, sig = r["sig"] as! String, t = r["type"] as! String
  let (a, _, rebuilt) = check(r, text, sig)
  guard a else { continue }
  ok(rebuilt == text, "\(t): the builder reproduces the exact text")
  var s = S.b64uDec(sig)!; s[10] ^= 0x01
  ok(!check(r, text, S.b64uEnc(s)).0, "\(t): a flipped signature bit is refused")
  ok(!check(r, text + ".x", sig).0, "\(t): an extra field is refused")
  var cs = Array(text); let i = cs.count - 2; cs[i] = cs[i] == "1" ? "2" : "1"
  ok(!check(r, String(cs), sig).0, "\(t): one changed byte of text is refused")
}
print("derivations")
for t in F["transcripts"] as! [[String: Any]] {
  let got = S.consentTranscript(audience: t["audience"] as! String, challenge: t["challenge"] as! String, payloadText: t["payload"] as! String)
  ok(got == (t["transcript"] as? String), "transcript(\(t["audience"] as! String)) \(t["transcript"] is NSNull ? "→ refused (\(t["note"] as? String ?? ""))" : "→ the fixture value")")
}
for w in F["webauthn"] as! [[String: String]] { ok(S.webauthnChallenge(for: w["cns"]!) == w["challenge"]!, "WebAuthn challenge = b64u(SHA-256(exact cns. bytes))") }
print("low-S")
for (i, p) in (F["lowS"] as! [[String: String]]).enumerated() {
  let text = "dev.lows.\(i)"
  ok(S.verifyStatementSig(keys["account"]!, p["low"]!, text), "pair \(i): the low-S signature verifies")
  ok(!S.verifyStatementSig(keys["account"]!, p["high"]!, text), "pair \(i): its high-S twin is refused")
  ok(S.b64uEnc(S.lowS(S.b64uDec(p["high"]!)!)) == p["low"]! && S.b64uEnc(S.lowS(S.b64uDec(p["low"]!)!)) == p["low"]!, "pair \(i): lowS folds high to low and leaves low alone")
}
print("routine purposes")
for p in F["purposes"] as! [[String: Any]] {
  let pl = p["payload"] as! String, m = p["match"] as! Bool
  ok(S.payloadMatchesPurpose(p["purpose"] as! String, pl) == m, "\(p["purpose"] as! String) \(m ? "accepts" : "refuses") \(pl.prefix(24))")
}
print("addresses")
for a in F["addresses"] as! [[String: Any]] {
  let want: S.Address = (a["address"] as? String).map { .ok($0) } ?? .refused(a["reason"] as! String)
  let got = S.normalizeAddress(a["input"] as! String)
  ok(got == want, "\(String(describing: a["input"]!).prefix(40)) → \(want)\(got == want ? "" : " (got \(got))")")
}
print("\n\(checks - fails)/\(checks) checks passed")
exit(fails == 0 ? 0 : 1)
`
const dir = mkdtempSync(join(tmpdir(), 'bento-idstmt-'))
try {
  writeFileSync(join(dir, 'main.swift'), main)
  execFileSync('swiftc', ['-O', '-o', join(dir, 's'), ...SRC, join(dir, 'main.swift')], { stdio: 'pipe' })
} catch (e) { console.error('swiftc failed:\n' + (e.stderr?.toString() ?? e.message)); rmSync(dir, { recursive: true, force: true }); process.exit(2) }
let code = 0
try { process.stdout.write(execFileSync(join(dir, 's'), [FIXTURE], { maxBuffer: 1 << 26 })) }
catch (e) { process.stdout.write(e.stdout?.toString() ?? ''); code = 1 }
finally { rmSync(dir, { recursive: true, force: true }) }
process.exit(code)
