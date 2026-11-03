#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/connect on iOS: the recovery flow's decisions (home/ios/RecoveryFlow.swift).
 *
 *   node scripts/test-home-id-recovery-flow.mjs
 *
 * The rule under test: a device that cannot afford Argon2id's 64 MiB answers
 * "unavailable" and the attempt is NEVER counted as a wrong code; only a code
 * that was stretched and did not open the blob is a wrong guess. Each row runs the
 * real Argon2id and the real blob, and the low-memory rows use the rig seam
 * (Argon2id.availableMemory, DEBUG/rig builds only) to stand in an old phone.
 * Positive controls: with memory restored the same code restores the keys, and a
 * wrong code on a device with memory IS counted, so "not counted" is not just a
 * counter that never moves. Apple platforms only; skips elsewhere.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = ['Argon2id.swift', 'IdentityRecovery.swift', 'RecoveryFlow.swift'].map((f) => join(ROOT, 'home/ios', f))
try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe' }) } catch { console.log('home id recovery-flow: SKIPPED — needs an Apple toolchain (CryptoKit).'); process.exit(0) }

const main = String.raw`
import CryptoKit
import Foundation
typealias R = IdentityRecovery
func emit(_ k: String, _ v: Any) { print("\(k)=\(v)") }
let full: () -> Int? = { nil }                    // no limit: the simulator, the Mac
let old: () -> Int? = { 48 << 20 }                // 48 MiB free: needs 96

let code = (0..<10).map { _ in UInt8.random(in: 0...255) }
var other = code; other[9] ^= 0x5a
let printed = R.formatCode(code)!, printedOther = R.formatCode(other)!
let salt = (0..<16).map { _ in UInt8.random(in: 0...255) }, iv = (0..<12).map { _ in UInt8.random(in: 0...255) }
let key = P256.Signing.PrivateKey(), stranger = P256.Signing.PrivateKey()
func pub(_ k: P256.Signing.PrivateKey) -> String { R.b64uEnc(Array(k.publicKey.x963Representation)) }
Argon2id.availableMemory = full
let wrap = R.recoveryWrapKey(code: code, salt: salt)!
let kxKey = P256.Signing.PrivateKey()   // the recovery kx (mode C): required, sealed beside the account scalar
func material(sealing k: P256.Signing.PrivateKey, binding: String, kx: P256.Signing.PrivateKey? = nil, kxBinding: String? = nil) -> RecoveryFlow.Material {
    let kxk = kx ?? kxKey
    let ct = R.sealRecoveryInner(wrapKey: wrap, iv: iv, accountPub: binding, keys: .init(account: Array(k.rawRepresentation), kx: Array(kxk.rawRepresentation)))!
    return .init(salt: salt, iv: iv, ct: ct, accountPub: binding, kxPub: kxBinding ?? pub(kxk))
}
let m = material(sealing: key, binding: pub(key))

func tag(_ o: RecoveryFlow.Outcome) -> String {
    switch o {
    case .unavailable: return "unavailable"
    case .notACode(let w): return "notACode:" + w
    case .wrongCode: return "wrongCode"
    case .blobRejected(let w): return "blobRejected:" + w
    case .restored(let k): return k.account == Array(key.rawRepresentation) ? "restored" : "restored-WRONG-KEY"
    }
}

// a device with memory: the right code restores, a wrong one is counted
var f = RecoveryFlow()
emit("ok.available", f.available)
emit("ok.right", tag(f.attempt(printed, m))); emit("ok.rightCount", f.wrongCodes)
emit("ok.wrong1", tag(f.attempt(printedOther, m))); emit("ok.wrong1Count", f.wrongCodes)
emit("ok.wrong2", tag(f.attempt(printedOther, m))); emit("ok.wrong2Count", f.wrongCodes)

// an old phone: the RIGHT code, five times, then a WRONG code: none is a guess
var g = RecoveryFlow()
var probes = 0
Argon2id.availableMemory = { probes += 1; return old() }
emit("low.available", g.available)
probes = 0
var low: [String] = []
for _ in 0..<5 { low.append(tag(g.attempt(printed, m))) }
low.append(tag(g.attempt(printedOther, m)))
emit("low.outcomes", low.joined(separator: ","))
emit("low.count", g.wrongCodes)
emit("low.probes", probes)   // one probe each: refused before the derivation was even asked

// memory that vanishes between the check and the derivation: still not a guess
var h = RecoveryFlow()
var calls = 0
Argon2id.availableMemory = { calls += 1; return calls == 1 ? nil : 48 << 20 }
emit("race.outcome", tag(h.attempt(printedOther, m)))
emit("race.count", h.wrongCodes)
emit("race.calls", calls)   // 2: the flow's check passed and Argon2id's own refused, so the derivation WAS reached

// the same flow, memory back: the same code restores (the low rows were about memory)
Argon2id.availableMemory = full
emit("back.right", tag(h.attempt(printed, m)))
emit("back.count", h.wrongCodes)

// a typo is caught by its check symbol before any work, and is not a guess
var t = RecoveryFlow()
var typo = Array(printed); typo[3] = typo[3] == "A" ? "B" : "A"
emit("typo.outcome", tag(t.attempt(String(typo), m)))
emit("typo.short", tag(t.attempt("ABCD", m)))
emit("typo.count", t.wrongCodes)

// the code is right but the blob is around another key than the signed binding names
var b = RecoveryFlow()
emit("swap.outcome", tag(b.attempt(printed, material(sealing: stranger, binding: pub(key)))))
emit("swap.count", b.wrongCodes)
// mode C: the same for the recovery kx the binding names
var c = RecoveryFlow()
emit("kxswap.outcome", tag(c.attempt(printed, material(sealing: key, binding: pub(key), kx: stranger, kxBinding: pub(kxKey)))))
emit("kxswap.count", c.wrongCodes)
`

const dir = mkdtempSync(join(tmpdir(), 'bento-rcflow-'))
let out
try {
  writeFileSync(join(dir, 'main.swift'), main)
  execFileSync('swiftc', ['-O', '-D', 'BENTO_WIPE_PROBE', '-o', join(dir, 'a'), ...SRC, join(dir, 'main.swift')], { stdio: 'pipe' })
  out = Object.fromEntries(execFileSync(join(dir, 'a'), { maxBuffer: 1 << 24 }).toString().trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)))
} catch (err) { console.error('swiftc or run failed:\n' + (err.stderr?.toString() ?? err.message)); process.exit(2) }
finally { rmSync(dir, { recursive: true, force: true }) }

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }

ok(out['ok.available'] === 'true' && out['ok.right'] === 'restored' && out['ok.rightCount'] === '0',
  'with memory, the right code restores the account key and counts nothing')
ok(out['ok.wrong1'] === 'wrongCode' && out['ok.wrong1Count'] === '1' && out['ok.wrong2Count'] === '2',
  'with memory, a wrong code IS a wrong code and is counted (positive control)')
ok(out['low.available'] === 'false', 'with 48 MiB free, the screen is told recovery is unavailable before asking for anything')
ok(out['low.outcomes'] === 'unavailable,unavailable,unavailable,unavailable,unavailable,unavailable' && out['low.count'] === '0',
  'on that device the right code five times and a wrong code once are all "unavailable", and none counts as a wrong code')
ok(out['low.probes'] === '6', `memory is asked before the code is tried: one probe per attempt (${out['low.probes']})`)
ok(out['race.outcome'] === 'unavailable' && out['race.count'] === '0' && out['race.calls'] === '2',
  `memory that vanishes after the check is "unavailable", not a wrong code (the derivation was reached: ${out['race.calls']} probes)`)
ok(out['back.right'] === 'restored' && out['back.count'] === '0', 'with memory back, the same code restores the keys: the refusals were about memory')
ok(out['typo.outcome'] === 'notACode:check' && out['typo.short'] === 'notACode:length' && out['typo.count'] === '0',
  'a typo (check symbol) and a short code are "not a code", caught before any work, and not counted')
ok(out['swap.outcome'] === 'blobRejected:key-mismatch' && out['swap.count'] === '0',
  'a right code that opens a blob around another key is refused as a swap, and not counted as a wrong code')
ok(out['kxswap.outcome'] === 'blobRejected:key-mismatch' && out['kxswap.count'] === '0',
  'a blob whose recovery kx is not the one the binding names is refused (mode C), and not counted')

console.log(failures === 0 ? `\n${checks}/${checks} checks passed` : `\n${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)
