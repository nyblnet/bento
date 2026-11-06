#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/connect on iOS and the Mac: the release history the app holds
 * (home/ios/ReleaseHistory.swift). Anti-rollback and the bundled floor, driven
 * with histories signed by a throwaway key.
 *
 *   node scripts/test-home-release-history.mjs
 *
 * - nothing held: no history (gate 1 then calls everything unknown)
 * - the bundled copy is the floor
 * - a newer superset is kept; the same one again changes nothing
 * - REFUSED, and the held copy untouched: an older history (rollback), a changed
 *   entry, another app's, a tampered payload, another key's signature
 * - a held copy tampered on disk, older than the bundled floor, or not its
 *   successor: the floor wins (the bytes are re-verified on every read)
 *
 * Apple platforms only; skips elsewhere.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = ['Gate1.swift', 'ReleaseKeys.swift', 'Releases.swift', process.env.HISTORY_SRC || 'ReleaseHistory.swift']
  .map((f) => (f.includes('/') ? f : join(ROOT, 'home/ios', f)))
try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe' }) } catch { console.log('home release history: SKIPPED — needs an Apple toolchain (CryptoKit).'); process.exit(0) }

const work = mkdtempSync(join(tmpdir(), 'bento-relhist-'))
const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }), other = generateKeyPairSync('ec', { namedCurve: 'P-256' })
writeFileSync(join(work, 'key.json'), JSON.stringify(key.publicKey.export({ format: 'jwk' })))
const hex = () => randomBytes(32).toString('hex')
const entry = (version) => ({ version, sha256: hex(), at: '2026-10-21T00:00:00Z', pins: { v: 1, blocks: { 'bento-rt': hex(), 'bento-rt-css': hex(), loader: hex(), remover: hex() }, scriptSrc: ['sha256-' + randomBytes(32).toString('base64')] } })
const e100 = entry('1.0.0'), e110 = entry('1.1.0'), e120 = entry('1.2.0')
const env = (payload, k = key) => JSON.stringify({ payload, sig: sign('sha256', Buffer.from(payload), { key: k.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') })
// the payload names the app by its appId (scripts/apps.mjs), as the real history does
const hist = (releases, app = 'bento-slides') => JSON.stringify({ app, v: 1, releases })
const files = {
  v1: env(hist([e100])),
  v2: env(hist([e110, e100])),
  v3: env(hist([e120, e110, e100])),
  changed: env(hist([e110, { ...e100, sha256: hex() }])),
  otherApp: env(hist([e110, e100], 'bento-dash')),
  // the directory's name, not the appId: what the real history does NOT carry
  bareName: env(hist([e110, e100], 'slides')),
  tampered: JSON.stringify({ ...JSON.parse(env(hist([e110, e100]))), payload: hist([e110, e100]).replace('1.1.0', '1.1.1') }),
  otherKey: env(hist([e120, e110, e100]), other),
}
for (const [n, t] of Object.entries(files)) writeFileSync(join(work, `${n}.json`), t)

const main = String.raw`
import Foundation
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
func f(_ n: String) -> Data { try! Data(contentsOf: dir.appendingPathComponent("\(n).json")) }
let key = Gate1.publicKey(jwk: f("key"))!
let verify: (Data, Data) -> Bool = { sig, msg in
  (try? P256Sig(sig)).map { key.isValidSignature($0, for: msg) } ?? false
}
var checks = 0, fails = 0
func ok(_ c: Bool, _ m: String) { checks += 1; if !c { fails += 1 }; print("  \(c ? "ok  " : "FAIL")  \(m)") }
func newest(_ h: JSON?) -> String { h?["releases"]?.array?.first?["version"]?.string ?? "none" }
func store(bundled: String?, held: String) -> ReleaseHistory.Store {
  let hd = dir.appendingPathComponent(held, isDirectory: true)
  try? FileManager.default.createDirectory(at: hd, withIntermediateDirectories: true)
  return ReleaseHistory.Store(bundled: { _ in bundled.map(f) }, heldDir: hd, verify: verify)
}

print("what's held")
ok(ReleaseHistory.current("slides", in: store(bundled: nil, held: "empty")) == nil, "nothing bundled or held: no history")
var s = store(bundled: "v1", held: "a")
ok(newest(ReleaseHistory.current("slides", in: s)) == "1.0.0", "the bundled copy is the floor (1.0.0)")

print("refreshing: only a valid successor is kept")
ok(ReleaseHistory.accept(f("v2"), app: "slides", in: s) == .updated && newest(ReleaseHistory.current("slides", in: s)) == "1.1.0", "a newer superset is kept (1.1.0)")
ok(ReleaseHistory.accept(f("v2"), app: "slides", in: s) == .unchanged, "the same one again changes nothing")
for (n, why) in [("v1", "an OLDER history (rollback)"), ("changed", "a history that changes a held entry"), ("otherApp", "another app's history"),
                 ("tampered", "a tampered payload"), ("otherKey", "a history signed by another key"),
                 ("bareName", "a history naming the app \"slides\" instead of its appId \"bento-slides\"")] {
  let r = ReleaseHistory.accept(f(n), app: "slides", in: s)
  var refused = false; if case .refused = r { refused = true }
  ok(refused && newest(ReleaseHistory.current("slides", in: s)) == "1.1.0", "\(why): refused, and 1.1.0 is still held (\(r))")
}

print("the held copy is re-verified on every read")
let heldFile = s.held("slides")!
var bytes = try! Data(contentsOf: heldFile); bytes[bytes.count / 2] ^= 0x01
try! bytes.write(to: heldFile)
ok(newest(ReleaseHistory.current("slides", in: s)) == "1.0.0", "a held copy tampered on disk is ignored: back to the floor")
// an app update ships a newer floor than the copy held
let b = store(bundled: "v3", held: "b")
try! f("v2").write(to: b.held("slides")!)
ok(newest(ReleaseHistory.current("slides", in: b)) == "1.2.0", "a held copy OLDER than the bundled floor is ignored (1.2.0)")
let c = store(bundled: "v2", held: "c")
try! f("changed").write(to: c.held("slides")!)
ok(newest(ReleaseHistory.current("slides", in: c)) == "1.1.0" && ReleaseHistory.current("slides", in: c)!["releases"]!.array![1] == (try! JSON.parse(Data(String(decoding: f("v2"), as: UTF8.self).utf8)))["payload"].flatMap { try? JSON.parse(Data($0.string!.utf8)) }!["releases"]!.array![1],
   "a held copy that isn't the floor's successor (a changed entry) is ignored: the floor's own 1.0.0 stands")

print("\n\(checks - fails)/\(checks) checks passed")
exit(fails == 0 ? 0 : 1)
`
let code = 0
try {
  writeFileSync(join(work, 'main.swift'), main.replace('P256Sig(sig)', 'P256.Signing.ECDSASignature(rawRepresentation: sig)').replace('import Foundation', 'import CryptoKit\nimport Foundation'))
  execFileSync('swiftc', ['-O', '-o', join(work, 'h'), ...SRC, join(work, 'main.swift')], { stdio: 'pipe' })
  try { process.stdout.write(execFileSync(join(work, 'h'), [work])) } catch (e) { process.stdout.write(e.stdout ?? ''); code = e.status || 1 }
} catch (err) { console.error('swiftc failed:\n' + (err.stderr?.toString() ?? err.message)); code = 2 }
finally { rmSync(work, { recursive: true, force: true }) }
process.exit(code)
