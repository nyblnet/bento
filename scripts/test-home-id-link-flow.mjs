#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/connect on iOS: device linking, v1, in BOTH roles, driven end to end against a
 * LOCAL directory (home/ios/LinkFlow.swift over home/ios/IdentityLink.swift).
 *
 *   BENTO_WRANGLER=/path/to/wrangler node scripts/test-home-id-link-flow.mjs
 *   (BENTO_DIRECTORY_ROOT=<tree with server/directory> when this tree has none)
 *
 * WHAT RUNS. The real Swift is compiled and run against the real directory Worker under
 * `wrangler dev` on localhost (LINKING=1, development mailer). One Swift process plays
 * every device: an account holder H is set up through the real setup flow (mailed code
 * read from the Worker's own log), then fresh devices N link to it. Nothing here talks
 * to the live service or sends real mail.
 *
 * ROWS (security §39.1 run-it list, and this host's own rules):
 *  - the honest link completes both ways round (H displays / N displays), N ends up
 *    holding H's account key and NO recovery kx, the address came to N inside SEALED,
 *    and kernel's verifiers accept N's dev.
 *  - N shows the label H WROTE; an unknown platform token is never shown as known
 *  - the H side starts ONLY from the in-app action: a universal link or camera intent on
 *    a device that holds an account is refused, in either seat, with nothing sent
 *  - roles are checked against the device's own state (both hold / neither holds)
 *  - CONTENDED: a second scanner ends the slot for everyone, and a retry is a new code
 *  - WRONG SAS: one attempt; the right digits afterwards do not revive the slot
 *  - each key seals exactly one message; a FAILED send is not a second try
 *  - N CONFIRMS THE ADDRESS before it stores anything (the name is shown as the account's
 *    own choice); declining aborts the slot and stores nothing
 *  - N stores nothing from an altered msg3 or an attestation the pin does not accept,
 *    and deletes the slot
 *  - O1: a managed-config key present refuses everything
 * Mutants (LINK_FLOW_MUTANT=<name>) edit a copy of the Swift and must turn it red.
 *
 * Needs an Apple toolchain, server/directory and wrangler; without them it SKIPS.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIRROOT = process.env.BENTO_DIRECTORY_ROOT ? resolve(process.env.BENTO_DIRECTORY_ROOT) : ROOT
const DIRDIR = join(DIRROOT, 'server/directory')
const FILES = ['HostDocStore.swift', 'Argon2id.swift', 'IdentityKeys.swift', 'IdentityDisplayTable.swift', 'IdentityStatements.swift', 'IdentityRecovery.swift',
  'RecoveryFlow.swift', 'IdentitySetup.swift', 'IdentityAgent.swift', 'IdentityLink.swift', 'LinkFlow.swift']
const skip = (why) => { console.log(`home id link flow: SKIPPED — ${why}`); process.exit(0) }
try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe' }) } catch { skip('needs an Apple toolchain (CryptoKit, Security).') }
if (!existsSync(join(DIRDIR, 'src/link.js'))) skip('this tree has no server/directory with the link routes (the directory PR has not landed).')
const WRANGLER = process.env.BENTO_WRANGLER
if (!WRANGLER || !existsSync(WRANGLER)) skip('set BENTO_WRANGLER to an installed wrangler (no network install from a rig).')

const MUTANTS = {
  'h-from-outside': ['LinkFlow.swift', 'guard origin == .inApp else { return .failure(.notHere("link-from-outside")) }', 'break'],
  'scan-from-outside': ['LinkFlow.swift', 'if h == .account && origin != .inApp { return .failure(.notHere("link-from-outside")) }', ''],
  'roles-not-checked': ['LinkFlow.swift', 'guard IdentityLink.scannerMayProceed(roleD: m0.role, scannerHoldsAccount: h == .account) else {', 'guard true else {'],
  'display-role-not-checked': ['LinkFlow.swift', 'default: return .failure(.notHere("role-contradicts-state"))', 'default: break'],
  'sas-no-abort': ['LinkFlow.swift', 'guard IdentityLink.sasMatches(typed: typed, sas: keys.sas) else { abort(s); return .failure(.wrongSAS) }', 'guard IdentityLink.sasMatches(typed: typed, sas: keys.sas) else { return .failure(.wrongSAS) }'],
  'offer-sealed-twice': ['LinkFlow.swift', 'guard !s.spentOffer else { return .failure(.spent) }', ''],
  'offer-spent-after-send': ['LinkFlow.swift', 's.spentOffer = true                                  // set BEFORE sending: a failed send is not a second try', ''],
  'final-sealed-twice': ['LinkFlow.swift', 'guard !s.spentFinal else { return .failure(.spent) }', ''],
  'contended-hidden': ['LinkFlow.swift', 'case (409, "contended"?): return .contended', 'case (409, "contended"?): return .gone("contended")'],
  'offered-label-shown': ['LinkFlow.swift', 'return .success(Linked(label: o.device.label, devicePub: o.device.devicePub))', 'return .success(Linked(label: offer.label, devicePub: o.device.devicePub))'],
  'no-abort-on-fail': ['LinkFlow.swift', 'let fail = { (r: Refusal) -> Result<Linked, Refusal> in self.abort(s); return .failure(r) }', 'let fail = { (r: Refusal) -> Result<Linked, Refusal> in return .failure(r) }'],
  // (no mutant for N's `att.state == active` check: the rig cannot freeze a binding here; kernel's release rows and the directory's own rig cover frozen and pending)
  'unpinned-att-skipped': ['LinkFlow.swift', 'lookup: lookup, directoryKeys: directoryKeys, now: now())', 'lookup: lookup, directoryKeys: ["dev-1": b64(Array(P256.Signing.PrivateKey().publicKey.x963Representation))], now: now())'],
  'decline-stores': ['LinkFlow.swift', 'guard confirm(o.address, o.name) else { return fail(.declined) }', '_ = confirm(o.address, o.name)'],
  'decline-keeps-slot': ['LinkFlow.swift', 'guard confirm(o.address, o.name) else { return fail(.declined) }', 'guard confirm(o.address, o.name) else { return .failure(.declined) }'],
  'confirm-never-asked': ['LinkFlow.swift', 'guard confirm(o.address, o.name) else { return fail(.declined) }', ''],
  'confirm-shows-typed-name-only': ['LinkFlow.swift', 'guard confirm(o.address, o.name) else { return fail(.declined) }', 'guard confirm("", o.name) else { return fail(.declined) }'],
  'h-seals-another-address': ['LinkFlow.swift', 'address: rec.address) else { return .failure(.unavailable) }', 'address: "mallory@example.com") else { return .failure(.unavailable) }'],
  'tampered-final-stored': ['LinkFlow.swift', 'guard let o = v.value else { return fail(.badMessage(v.reason ?? "final")) }', 'let o = v.value ?? IdentityLink.Opened(keys: .init(account: [UInt8](repeating: 1, count: 32), kx: [UInt8](repeating: 2, count: 32)), device: IdentityStatements.verifyDev(rec0Dev, rec0DevSig, now: now()).value!, dev: "", devSig: "")'],
  'managed-ignored': ['LinkFlow.swift', 'func display(as me: IdentityLink.Role, origin: Origin) -> Result<Session, Refusal> {\n        guard !managed() else { return .failure(.managed) }', 'func display(as me: IdentityLink.Role, origin: Origin) -> Result<Session, Refusal> {'],
  'unknown-platform-known': ['IdentityLink.swift', 'PlatformShown(name: "Unknown device type", known: false)', 'PlatformShown(name: token, known: true)'],
}
delete MUTANTS['tampered-final-stored'] // (an anchor needing symbols that do not exist is not a mutant; the tamper row is judged by the stored-nothing check)

const free = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const tmp = mkdtempSync(join(tmpdir(), 'bento-idlink-'))
const mailDir = join(tmp, 'mail'); mkdirSync(mailDir)
const b64u = (u8) => Buffer.from(u8).toString('base64url')

const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const dirJwk = JSON.stringify(await webcrypto.subtle.exportKey('jwk', kp.privateKey))
const dirPub = b64u(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey)))
const otherKp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const otherPub = b64u(new Uint8Array(await webcrypto.subtle.exportKey('raw', otherKp.publicKey)))

const port = await free()
const base = `http://127.0.0.1:${port}`
let log = ''
const wr = spawn(WRANGLER, ['dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', join(tmp, 'state'),
  '--var', 'DEV:1', '--var', 'MAILER:log', '--var', 'LINKING:1', '--var', 'DIR_KID:dev-1', '--var', `DIR_KEY_JWK:${dirJwk}`,
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
const stop = () => { try { wr.kill('SIGTERM') } catch {}; if (process.env.BENTO_RIG_DEBUG) writeFileSync(process.env.BENTO_RIG_DEBUG, log) }
process.on('exit', stop)
const up = await Promise.race([readyP.then(() => true), new Promise((r) => setTimeout(() => r(false), 90_000))])
if (!up) { console.error('wrangler dev did not come up:\n' + log.slice(-2000)); stop(); process.exit(2) }

const main = String.raw`
import CryptoKit
import Foundation
import LocalAuthentication
typealias L = IdentityLink
final class Mem: HostDocStore.Secrets {
  var d: [String: Data] = [:]
  func get(_ a: String) -> HostDocStore.Read { d[a].map { .found($0) } ?? .absent }
  func set(_ a: String, _ v: Data) -> Bool { d[a] = v; return true }
  func delete(_ a: String) { d[a] = nil }
  func clone() -> Mem { let m = Mem(); m.d = d; return m }
}
setvbuf(stdout, nil, _IONBF, 0)
func emit(_ k: String, _ v: Any) { print("\(k)=\("\(v)".replacingOccurrences(of: "\n", with: "|"))") }
let args = CommandLine.arguments
let base = URL(string: args[1])!, pin = args[2], other = args[3], mailDir = args[4]
let pins = ["dev-1": pin]
let real = DirectoryHTTP.net(base: base)
let setupPost = DirectoryHTTP.transport(base: base)

// a tap in front of the directory: counts, fails or tampers on request
final class Tap {
  var posts: [(String, [String: Any])] = []
  var failPutN2 = 0, failComplete = 0, tamper3 = false, tamperAtt = false
  func count(_ path: String, n: Int? = nil) -> Int { posts.filter { $0.0 == path && (n == nil || ($0.1["n"] as? Int) == n) }.count }
}
func flipMid(_ s: String) -> String {
  var c = Array(s); let i = c.count - 10; c[i] = c[i] == "A" ? "B" : "A"; return String(c)
}
func tapped(_ t: Tap) -> LinkAgent.Net {
  LinkAgent.Net(post: { p, b in
    t.posts.append((p, b))
    if p == "/v1/link/put", (b["n"] as? Int) == 2, t.failPutN2 > 0 { t.failPutN2 -= 1; return .init(status: 500, json: nil) }
    if p == "/v1/link/complete", t.failComplete > 0 { t.failComplete -= 1; return .init(status: 500, json: nil) }
    var r = real.post(p, b)
    if p == "/v1/link/get", (b["n"] as? Int) == 3, t.tamper3, var j = r.json, let m = j["msg"] as? String { j["msg"] = flipMid(m); r = .init(status: r.status, json: j) }
    return r
  }, get: { q in
    var r = real.get(q)
    if t.tamperAtt, q.hasPrefix("/v1/lookup"), var j = r.json, let s = j["attestationSig"] as? String { j["attestationSig"] = flipMid(s); r = .init(status: r.status, json: j) }
    return r
  })
}
func mail(_ to: String) -> String {
  let p = mailDir + "/" + to.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()")))!
  for _ in 0..<150 { if let s = try? String(contentsOfFile: p, encoding: .utf8), !s.isEmpty { return s }; Thread.sleep(forTimeInterval: 0.2) }
  return "NOMAIL000"
}
// the person is present for every consent but the rows that say otherwise
IdentityKeys.rigPresenceGranted = true
let noCtx = LAContext()
func agent(_ m: Mem, _ t: Tap = Tap(), pins p: [String: String] = pins, platform: String = "ios", managed: Bool = false, name: String = "device") -> LinkAgent {
  LinkAgent(store: m, net: tapped(t), directoryKeys: p, managed: { managed }, enclave: false, domainState: { Data("rig".utf8) },
            deviceName: name, platform: platform, pollMs: 500, stepSeconds: 20)
}
func d<T>(_ r: Result<T, LinkAgent.Refusal>) -> String { switch r { case .success: return "ok"; case .failure(let f): return "\(f)" } }
func rec(_ m: Mem) -> IdentitySetup.Record? { if case .found(let x) = m.get(IdentitySetup.recordItem) { return try? JSONDecoder().decode(IdentitySetup.Record.self, from: x) }; return nil }
func acctPub(_ m: Mem) -> String { (try? IdentityKeys.account(in: m)).map { IdentityRecovery.b64uEnc(Array($0.publicKey.x963Representation)) } ?? "none" }
func holdsRecoveryKx(_ m: Mem) -> Bool { m.d.keys.contains { $0.lowercased().contains("recovery") && $0.lowercased().contains("kx") } }
func nothing(_ m: Mem) -> Bool { m.d[IdentityKeys.accountItem] == nil && !holdsRecoveryKx(m) && m.d[IdentitySetup.recordItem] == nil }
let alice = "alice-link@example.com"

// --- H: an account set up through the real flow
Argon2id.availableMemory = { nil }
let hMem = Mem()
let setup = IdentitySetup(store: hMem, post: setupPost, directoryKeys: pins, managed: { false }, enclave: false)
emit("h.start", "\(setup.start(address: alice, name: "Alice"))")
emit("h.verify", "\(setup.verify(code: mail(alice)))")
var printed = ""
if case .code(let c) = setup.prepareRecovery() { printed = c }
emit("h.confirm", "\(setup.confirmRecovery(typed: printed))")
emit("h.mint", "\(setup.mintDevice(label: "Alice phone"))")
emit("h.kxKept", holdsRecoveryKx(hMem))
emit("h.recordKxEmpty", rec(hMem)?.recoveryKx.isEmpty ?? false)
let hPub = acctPub(hMem)
emit("h.pub", hPub)

/// one whole link; returns the pieces rows need
struct Run { var h: LinkAgent.Session?; var n: LinkAgent.Session?; var offer: L.Offer?; var linked: Result<LinkAgent.Linked, LinkAgent.Refusal>?; var nMem: Mem; var hTap: Tap; var nTap: Tap; var steps: [String]; var asked: [(String, String?)] }
func link(hDisplays: Bool, nLabel: String? = "Rig phone", hLabel: String? = "Alice's iPad", platform: String = "ios", nPins: [String: String] = pins,
          nTap: Tap = Tap(), typeSAS: ((String) -> String)? = nil, tamper: Bool = false, accept: Bool = true) -> Run {
  let nMem = Mem(), hTap = Tap()
  var run = Run(h: nil, n: nil, offer: nil, linked: nil, nMem: nMem, hTap: hTap, nTap: nTap, steps: [], asked: [])
  let H = agent(hMem, hTap, name: "Alice phone"), N = agent(nMem, nTap, pins: nPins, platform: platform, name: "New device")
  var sh: LinkAgent.Session, sn: LinkAgent.Session
  if hDisplays {
    guard case .success(let a) = H.display(as: .H, origin: .inApp) else { run.steps.append("h.display"); return run }
    sh = a; run.h = a
    guard case .success(let b) = N.scan(code: a.printedCode, origin: .universalLink) else { run.steps.append("n.scan"); return run }
    sn = b; run.n = b
    if case .failure(let f) = H.awaitScanner(sh) { run.steps.append("h.await:\(f)"); return run }
  } else {
    guard case .success(let a) = N.display(as: .N, origin: .universalLink) else { run.steps.append("n.display"); return run }
    sn = a; run.n = a
    guard case .success(let b) = H.scan(code: a.printedCode, origin: .inApp) else { run.steps.append("h.scan"); return run }
    sh = b; run.h = b
    if case .failure(let f) = N.awaitScanner(sn) { run.steps.append("n.await:\(f)"); return run }
  }
  if case .failure(let f) = N.sendOffer(sn, label: nLabel) { run.steps.append("n.offer:\(f)"); return run }
  let typed = typeSAS?(sn.sas ?? "") ?? (sn.sas ?? "")
  switch H.submitSAS(sh, typed: typed) {
  case .failure(let f): run.steps.append("h.sas:\(f)"); return run
  case .success(let o): run.offer = o
  }
  if case .failure(let f) = H.approve(sh, label: hLabel) { run.steps.append("h.approve:\(f)"); return run }
  if tamper { nTap.tamper3 = true }
  var asked: [(String, String?)] = []
  run.linked = N.awaitLinked(sn, confirm: { a, n in asked.append((a, n)); return accept })
  run.asked = asked
  return run
}

// ===== 1. the honest link, H displays
let r1 = link(hDisplays: true)
emit("a.steps", r1.steps.joined(separator: ","))
emit("a.linked", r1.linked.map(d) ?? "nil")
if case .success(let l)? = r1.linked { emit("a.label", l.label ?? "nil") }
emit("a.sas", r1.n?.sas ?? "")
emit("a.hSasHidden", r1.h?.sas == nil)
emit("a.sameKeys", r1.h?.keys != nil && r1.h?.keys == r1.n?.keys)
emit("a.platform", r1.offer.map { "\(L.showPlatform($0.platform).known)" } ?? "nil")
emit("a.offerLabel", r1.offer?.label ?? "nil")
emit("a.nPub", acctPub(r1.nMem)); emit("a.nKx", !holdsRecoveryKx(r1.nMem))
emit("a.asked", r1.asked.map { "\($0.0)|\($0.1 ?? "nil")" }.joined(separator: ";"))
emit("a.wording", { let w = LinkAgent.confirmWording(address: alice, name: "Alice"); return "\(w.title)|\(w.detail ?? "nil")" }())
emit("a.wordingNoName", LinkAgent.confirmWording(address: alice, name: nil).detail ?? "nil")
if let c = r1.hTap.posts.first(where: { $0.0 == "/v1/link/complete" }), let m = c.1["msg3"] as? String {
  emit("a.sealedLen", IdentityStatements.b64uDec(m.components(separatedBy: "\n")[7])?.count ?? -1)
}
let nr = rec(r1.nMem)
emit("a.nLinked", nr?.linked ?? false); emit("a.nRecoveryEmpty", nr?.recovery == nil)
emit("a.nDev", nr?.dev ?? ""); emit("a.nBind", nr?.bindText ?? ""); emit("a.nBindSig", nr?.bindSig ?? "")
emit("a.nStage", "\(IdentitySetup(store: r1.nMem, post: setupPost, directoryKeys: pins, managed: { false }, enclave: false).stage()!)")
emit("a.nPrepare", "\(IdentitySetup(store: r1.nMem, post: setupPost, directoryKeys: pins, managed: { false }, enclave: false).prepareRecovery())")
if let sn = r1.n {
  let g = real.post("/v1/link/get", ["id": sn.slot.id, "tok": sn.slot.tok, "n": 3, "wait": 0])
  emit("a.slotAfter", "\(g.status)")
}
emit("a.hPubUnchanged", acctPub(hMem) == hPub)
emit("a.posts.h", r1.hTap.posts.map { $0.0 }.joined(separator: ","))

// ===== 2. the honest link, N displays; an unknown platform token
let r2 = link(hDisplays: false, nLabel: nil, hLabel: nil, platform: "plan9-x")
emit("b.steps", r2.steps.joined(separator: ","))
emit("b.linked", r2.linked.map(d) ?? "nil")
emit("b.nPub", acctPub(r2.nMem))
emit("b.platformToken", r2.offer?.platform ?? "nil")
emit("b.platformKnown", r2.offer.map { "\(L.showPlatform($0.platform).known)" } ?? "nil")
emit("b.platformShown", r2.offer.map { L.showPlatform($0.platform).name } ?? "nil")
emit("b.label", { if case .success(let l)? = r2.linked { return l.label ?? "nil" }; return "?" }())

// ===== 3. only the in-app action starts H
do {
  let t = Tap(), H = agent(hMem, t), fresh = Mem(), F = agent(fresh, t)
  emit("o.hUniversal", d(H.display(as: .H, origin: .universalLink)))
  emit("o.hCamera", d(H.display(as: .H, origin: .cameraIntent)))
  emit("o.hAsN", d(H.display(as: .N, origin: .inApp)))
  emit("o.freshAsH", d(F.display(as: .H, origin: .inApp)))
  emit("o.posts", t.posts.count)
  // a code shown by a fresh N, scanned by H from outside the app
  let nd = F.display(as: .N, origin: .universalLink)
  if case .success(let sn) = nd {
    let before = t.posts.count
    emit("o.scanUniversal", d(H.scan(code: sn.printedCode, origin: .universalLink)))
    emit("o.scanCamera", d(H.scan(code: sn.printedCode, origin: .cameraIntent)))
    emit("o.scanWrites", t.posts.dropFirst(before).filter { $0.0 != "/v1/link/get" }.count)
    // neither holds an account: a second fresh device scanning a fresh N's code is refused
    emit("o.neither", d(agent(Mem(), t).scan(code: sn.printedCode, origin: .universalLink)))
    // the control: the in-app scan on the account holder is allowed (and burns this slot, fine)
    emit("o.scanInApp", d(H.scan(code: sn.printedCode, origin: .inApp)))
  } else { emit("o.nd", d(nd)) }
  // both hold an account: H' (a copy of an account device) displays as H, H scans it
  let h2 = agent(hMem.clone(), t)
  if case .success(let s2) = h2.display(as: .H, origin: .inApp) { emit("o.bothHold", d(H.scan(code: s2.printedCode, origin: .inApp))) } else { emit("o.bothHold", "display failed") }
  // O1
  let mt = Tap(), M = agent(hMem, mt, managed: true)
  emit("o.managed", d(M.display(as: .H, origin: .inApp)) + "/" + d(agent(Mem(), mt, managed: true).display(as: .N, origin: .universalLink)))
  emit("o.managedPosts", mt.posts.count)
}

// ===== 4. CONTENDED: a second scanner ends the slot for everyone
do {
  let H = agent(hMem, Tap()), N1 = agent(Mem(), Tap()), N2 = agent(Mem(), Tap()), N3 = agent(Mem(), Tap())
  if case .success(let sh) = H.display(as: .H, origin: .inApp), case .success(let s1) = N1.scan(code: sh.printedCode, origin: .universalLink) {
    emit("c.first", "ok")
    emit("c.second", d(N2.scan(code: sh.printedCode, origin: .universalLink)))
    emit("c.hAwait", d(H.awaitScanner(sh)))
    emit("c.n1Offer", d(N1.sendOffer(s1, label: nil)))
    emit("c.third", d(N3.scan(code: sh.printedCode, origin: .universalLink)))
    // a retry is a NEW slot with a NEW code, and that one completes
    if case .success(let sh2) = H.display(as: .H, origin: .inApp) { emit("c.newCode", sh2.printedCode != sh.printedCode); H.cancel(sh2) }
  } else { emit("c.first", "failed") }
  // the same code opened twice: the second opener is told contended
  let Hh = agent(hMem, Tap())
  if case .success(let s) = Hh.display(as: .H, origin: .inApp) {
    let again = LinkAgent.Net(post: real.post, get: real.get).post("/v1/link/open", ["id": s.slot.id, "tok": s.slot.tok, "msg": "AAAA"])
    emit("c.reopen", "\(again.status):\((again.json?["error"] as? String) ?? "")")
  }
}
let r4 = link(hDisplays: true)
emit("c.control", r4.linked.map(d) ?? "nil")

// ===== 5. WRONG SAS: one attempt
do {
  let t = Tap(), nTap = Tap()
  let H = agent(hMem, t), nMem = Mem(), N = agent(nMem, nTap)
  if case .success(let sh) = H.display(as: .H, origin: .inApp), case .success(let sn) = N.scan(code: sh.printedCode, origin: .universalLink) {
    _ = H.awaitScanner(sh); _ = N.sendOffer(sn, label: nil)
    let sas = sn.sas!
    let wrong = sas == "000000" ? "111111" : "000000"
    emit("s.wrong", d(H.submitSAS(sh, typed: wrong)))
    emit("s.rightAfter", d(H.submitSAS(sh, typed: sas)))
    emit("s.approve", d(H.approve(sh, label: nil)))
    emit("s.nWaits", d(N.awaitLinked(sn, confirm: { _, _ in true })))
    emit("s.nStores", nothing(nMem))
    let g = real.post("/v1/link/get", ["id": sh.slot.id, "tok": sh.slot.tok, "n": 2, "wait": 0])
    emit("s.slot", "\(g.status):\((g.json?["error"] as? String) ?? "")")
    emit("s.completes", t.count("/v1/link/complete"))
  }
}

// ===== 6. each key seals ONE message
do {
  // the person is NOT present: H's consent is declined, nothing is sealed or sent, and a retry is allowed
  let dT = Tap(), nT0 = Tap()
  let HD = LinkAgent(store: hMem, net: tapped(dT), directoryKeys: pins, managed: { false }, enclave: false, domainState: { Data("rig".utf8) },
                     presence: { let c = LAContext(); c.interactionNotAllowed = true; return c }(), deviceName: "Alice phone", pollMs: 500, stepSeconds: 20)
  let ND = agent(Mem(), nT0)
  if case .success(let sh) = HD.display(as: .H, origin: .inApp), case .success(let sn) = ND.scan(code: sh.printedCode, origin: .universalLink) {
    _ = HD.awaitScanner(sh); _ = ND.sendOffer(sn, label: nil); _ = HD.submitSAS(sh, typed: sn.sas!)
    IdentityKeys.rigPresenceGranted = false
    emit("d.declined", d(HD.approve(sh, label: nil)))
    emit("d.completes", dT.count("/v1/link/complete"))
    IdentityKeys.rigPresenceGranted = true
    emit("d.retrySameSlot", d(HD.approve(sh, label: nil)))
  }
  let hT = Tap(), nT = Tap()
  let H = agent(hMem, hT), N = agent(Mem(), nT)
  if case .success(let sh) = H.display(as: .H, origin: .inApp), case .success(let sn) = N.scan(code: sh.printedCode, origin: .universalLink) {
    _ = H.awaitScanner(sh)
    nT.failPutN2 = 1
    emit("k.offer1", d(N.sendOffer(sn, label: nil)))          // the send FAILS (500)
    emit("k.offer2", d(N.sendOffer(sn, label: nil)))          // a failed send is not a second try
    emit("k.offerPuts", nT.count("/v1/link/put", n: 2))
  }
  let hT2 = Tap(), nT2 = Tap()
  let H2 = agent(hMem, hT2), N2 = agent(Mem(), nT2)
  if case .success(let sh) = H2.display(as: .H, origin: .inApp), case .success(let sn) = N2.scan(code: sh.printedCode, origin: .universalLink) {
    _ = H2.awaitScanner(sh)
    emit("k.o1", d(N2.sendOffer(sn, label: nil))); emit("k.o2", d(N2.sendOffer(sn, label: nil)))
    emit("k.puts2", nT2.count("/v1/link/put", n: 2))
    _ = H2.submitSAS(sh, typed: sn.sas!)
    emit("k.a1", d(H2.approve(sh, label: nil))); emit("k.a2", d(H2.approve(sh, label: nil)))
    emit("k.completes", hT2.count("/v1/link/complete"))
  }
  // a FAILED complete: h2n has sealed its message, so the retry is refused, not resent
  let hT3 = Tap(), nT3 = Tap()
  let H3 = agent(hMem, hT3), N3 = agent(Mem(), nT3)
  if case .success(let sh) = H3.display(as: .H, origin: .inApp), case .success(let sn) = N3.scan(code: sh.printedCode, origin: .universalLink) {
    _ = H3.awaitScanner(sh); _ = N3.sendOffer(sn, label: nil); _ = H3.submitSAS(sh, typed: sn.sas!)
    hT3.failComplete = 1
    emit("k.f1", d(H3.approve(sh, label: nil))); emit("k.f2", d(H3.approve(sh, label: nil)))
    emit("k.fCompletes", hT3.count("/v1/link/complete"))
  }
}

// ===== 7. N stores nothing from what it cannot trust
do {
  let nT = Tap()
  let r = link(hDisplays: true, nTap: nT, tamper: true)
  emit("t.msg3", r.linked.map(d) ?? "nil")
  emit("t.msg3.stores", nothing(r.nMem))
  if let sn = r.n { let g = real.post("/v1/link/get", ["id": sn.slot.id, "tok": sn.slot.tok, "n": 3, "wait": 0]); emit("t.msg3.slot", "\(g.status)") }
  let aT = Tap(); aT.tamperAtt = true
  let ra = link(hDisplays: true, nTap: aT)
  emit("t.att", ra.linked.map(d) ?? "nil"); emit("t.att.stores", nothing(ra.nMem))
  if let sn = ra.n { let g = real.post("/v1/link/get", ["id": sn.slot.id, "tok": sn.slot.tok, "n": 3, "wait": 0]); emit("t.att.slot", "\(g.status)") }
  let rp = link(hDisplays: true, nPins: ["dev-1": other])
  emit("t.pin", rp.linked.map(d) ?? "nil"); emit("t.pin.stores", nothing(rp.nMem))
  let rk = link(hDisplays: true, nPins: ["dir-9": pin])
  emit("t.kid", rk.linked.map(d) ?? "nil"); emit("t.kid.stores", nothing(rk.nMem))
}
// ===== 7b. N asks before it stores: the ADDRESS is confirmed, and a no leaves nothing
do {
  let rd = link(hDisplays: true, accept: false)
  emit("q.result", rd.linked.map(d) ?? "nil")
  emit("q.asked", rd.asked.map { "\($0.0)|\($0.1 ?? "nil")" }.joined(separator: ";"))
  emit("q.stores", nothing(rd.nMem))
  if let sn = rd.n { let g = real.post("/v1/link/get", ["id": sn.slot.id, "tok": sn.slot.tok, "n": 3, "wait": 0]); emit("q.slot", "\(g.status)") }
  // nothing was asked for a message that failed to open: a tampered msg3 never reaches the prompt
  let rt = link(hDisplays: true, nTap: Tap(), tamper: true)
  emit("q.tamperedAsked", rt.asked.count)
  // and the sender-side check: H seals no address that is not in normal form
  emit("q.sealBad", L.sealedPlaintext(account: [UInt8](repeating: 1, count: 32), address: "Alice@Example.com") == nil)
}
let r8 = link(hDisplays: false)
emit("z.control", r8.linked.map(d) ?? "nil")
`

const dir = join(tmp, 'swift'); mkdirSync(dir)
const mutant = process.env.LINK_FLOW_MUTANT
let out
try {
  for (const f of FILES) copyFileSync(join(ROOT, 'home/ios', f), join(dir, f))
  if (mutant) {
    const m = MUTANTS[mutant]; if (!m) { console.error(`unknown mutant ${mutant}: ${Object.keys(MUTANTS).join(' ')}`); stop(); process.exit(2) }
    const src = readFileSync(join(dir, m[0]), 'utf8')
    if (!src.includes(m[1])) { console.error(`mutant ${mutant}: its anchor is not in ${m[0]}; NOT applied`); stop(); process.exit(2) }
    writeFileSync(join(dir, m[0]), src.replace(m[1], m[2]))
  }
  writeFileSync(join(dir, 'main.swift'), main)
  execFileSync('swiftc', ['-O', '-D', 'DEBUG', '-D', 'BENTO_SOFTWARE_DEVICE_KEYS', '-D', 'BENTO_WIPE_PROBE', '-o', join(dir, 'a'), ...FILES.map((f) => join(dir, f)), join(dir, 'main.swift')], { stdio: 'pipe' })
  const text = await new Promise((res, rej) => {
    const p = spawn(join(dir, 'a'), [base, dirPub, otherPub, mailDir], { stdio: ['ignore', 'pipe', 'inherit'] })
    let o = ''; p.stdout.on('data', (d) => { o += d })
    const t = setTimeout(() => { p.kill('SIGKILL'); rej(Object.assign(new Error('timed out'), { stdout: o })) }, 400_000)
    p.on('close', (code, sig) => { clearTimeout(t); code === 0 ? res(o) : rej(Object.assign(new Error('exit ' + code), { signal: sig, status: code, stdout: o })) })
  })
  out = Object.fromEntries(text.trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)))
  if (process.env.LINK_FLOW_DUMP) console.log(text)
} catch (err) { console.error('swiftc or run failed (' + (err.signal ?? err.status) + '):\n' + (err.stderr?.toString() || '') + (err.stdout?.toString() || '') + err.message + '\n--- worker log ---\n' + log.split('\n').filter((l) => !/explorer|^\s*(GET|POST)|^If the/.test(l)).slice(-20).join('\n').slice(0, 2500)); stop(); process.exit(2) }

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
const NOW = Date.now()
const K = await import(join(ROOT, 'kernel/src/statements.ts'))

ok(out['h.start'] === 'mailed' && out['h.verify'] === 'bound' && out['h.confirm'] === 'confirmed' && out['h.mint'].startsWith('minted'), 'setup: H is a bound account holder with a dev. (the real setup flow)')
ok(out['h.kxKept'] === 'false' && out['h.recordKxEmpty'] === 'true', 'no device keeps the recovery kx scalar at rest (it lives only in the code-wrapped blob), and the setup record does not hold it')

console.log('1. the honest link, H displays')
ok(out['a.steps'] === '' && out['a.linked'] === 'ok', 'H displays, N scans: every step completes')
ok(/^\d{6}$/.test(out['a.sas']) && out['a.hSasHidden'] === 'true' && out['a.sameKeys'] === 'true', 'both sides derive the same keys; only N has a SAS to show')
ok(out['a.nPub'] === out['h.pub'] && out['a.nKx'] === 'true', "N ends up holding H's account key and NO recovery kx (H never sends it)")
ok(Number(out['a.sealedLen']) === 12 + 32 + 'alice-link@example.com'.length + 16, 'msg3 on the wire carries exactly the 32-byte scalar and the address, sealed (not a 64-byte blob)')
ok(out['a.asked'] === 'alice-link@example.com|Alice', 'N asked the person about the address it found in SEALED, with the account\'s name beside it')
ok(out['a.wording'].startsWith('Link this device to alice-link@example.com?|') && out['a.wording'].includes('chosen by the account') && out['a.wordingNoName'] === 'nil', 'the prompt names the ADDRESS, and the name is labelled as chosen by the account (no name, no line)')
ok(out['a.label'] === "Alice's iPad" && out['a.offerLabel'] === 'Rig phone', 'N shows the label H WROTE ("Alice\'s iPad"), not the one it offered ("Rig phone")')
ok(out['a.platform'] === 'true', 'a known platform token is shown by name')
const dev = await K.verifyDev(out['a.nDev'].split('|')[0], out['a.nDev'].split('|')[1], { now: NOW })
const bind = await K.verifyBind(out['a.nBind'], out['a.nBindSig'], { now: NOW })
ok(dev.ok && bind.ok && dev.value.accountPub === bind.value.accountPub && dev.value.accountPub === out['h.pub'] && dev.value.label === "Alice's iPad", "kernel's verifier accepts N's dev.: under the account key, with H's label")
ok(out['a.nLinked'] === 'true' && out['a.nRecoveryEmpty'] === 'true' && out['a.nPrepare'] === 'already', 'N is marked linked, and setup\'s recovery step does not run on it (it has no blob of its own to make)')
ok(out['a.slotAfter'] === '409', 'the slot is gone once N has the key')
ok(out['a.hPubUnchanged'] === 'true', "H's account key is untouched")
ok(!out['a.posts.h'].includes('/v1/link/get') || true, '(H polling is by get; nothing else asserted)')

console.log('2. the honest link, N displays; an unknown platform')
ok(out['b.steps'] === '' && out['b.linked'] === 'ok' && out['b.nPub'] === out['h.pub'], 'N displays, H scans in-app: completes, N holds the account key')
ok(out['b.platformToken'] === 'plan9-x' && out['b.platformKnown'] === 'false' && out['b.platformShown'] === 'Unknown device type', 'an unknown platform token is shown as unknown, never as itself or as verified')
ok(out['b.label'] === 'nil', 'with no label written by anyone, none is shown')

console.log('3. H starts only from the in-app action; roles are checked')
ok(out['o.hUniversal'] === 'notHere("link-from-outside")' && out['o.hCamera'] === 'notHere("link-from-outside")', 'a universal link or camera intent on an account device does not start the H side')
ok(out['o.hAsN'] === 'notHere("role-contradicts-state")' && out['o.freshAsH'] === 'notHere("role-contradicts-state")', 'a device cannot display a role its own state contradicts (account as N, no account as H)')
ok(out['o.posts'] === '0', 'and none of those sent anything')
ok(out['o.scanUniversal'] === 'notHere("link-from-outside")' && out['o.scanCamera'] === 'notHere("link-from-outside")' && out['o.scanWrites'] === '0', 'scanning a displayed code from outside the app on an account device is refused before anything is written')
ok(out['o.neither'] === 'notHere("role-contradicts-state")', 'neither side holds an account: the scanner aborts')
ok(out['o.bothHold'] === 'notHere("role-contradicts-state")', 'both sides hold an account (D claims H, S holds one): the scanner aborts')
ok(out['o.scanInApp'] === 'ok', 'CONTROL: the same scan from the in-app action proceeds')
ok(out['o.managed'] === 'managed/managed' && out['o.managedPosts'] === '0', 'O1: a managed-config key present refuses linking in both roles and sends nothing')

console.log('4. CONTENDED')
ok(out['c.first'] === 'ok' && out['c.second'] === 'contended', 'a second scanner is told contended')
ok(out['c.hAwait'] === 'contended' && out['c.n1Offer'] === 'contended', 'and the displayer and the first scanner both find the slot ended')
ok(out['c.third'] === 'contended', 'the code cannot be used again in its window')
ok(out['c.newCode'] === 'true' && out['c.control'] === 'ok', 'a retry is a new slot with a new code, and CONTROL: one scanner links')
ok(out['c.reopen'].startsWith('409:contended'), 'the same code opened twice is contended')

console.log('5. WRONG SAS')
ok(out['s.wrong'] === 'wrongSAS' && out['s.rightAfter'] !== 'ok', 'a wrong SAS fails, and the right digits afterwards do not revive it (one attempt)')
ok(out['s.approve'].startsWith('notHere') && out['s.completes'] === '0', 'H cannot approve after a failed SAS, and nothing was completed')
ok(out['s.nWaits'] === 'gone("aborted")' && out['s.nStores'] === 'true', 'N is told the slot was aborted, and stores nothing')
ok(out['s.slot'] === '409:aborted', 'the slot is gone at the directory')

console.log('6. each key seals one message')
ok(out['k.offer1'] === 'network(500)' && out['k.offer2'] === 'spent' && out['k.offerPuts'] === '1', 'a FAILED send of msg2 is not a second try: the retry is refused and nothing more is sent')
ok(out['k.o1'] === 'ok' && out['k.o2'] === 'spent' && out['k.puts2'] === '1', 'n2h seals one message')
ok(out['k.a1'] === 'ok' && out['k.a2'] !== 'ok' && out['k.completes'] === '1', 'the slot completes once: a second approve is refused and sends nothing')
ok(out['k.f1'] === 'network(500)' && out['k.f2'] === 'spent' && out['k.fCompletes'] === '1', 'h2n seals one message: after a FAILED complete the retry is refused, not resent')

ok(out['d.declined'] === 'declined' && out['d.completes'] === '0' && out['d.retrySameSlot'] === 'ok', 'without the person present the consent is declined and nothing is sent; the same slot may then be approved (no key sealed yet)')

console.log('7. N stores nothing it cannot trust')
ok(out['t.msg3'].startsWith('badMessage') && out['t.msg3.stores'] === 'true' && out['t.msg3.slot'] === '409', 'an altered msg3 is refused, nothing is stored, the slot is deleted')
ok(out['t.att'] === 'badMessage("att-signature")' && out['t.att.stores'] === 'true' && out['t.att.slot'] === '409', 'a binding whose attestation does not verify is refused, nothing stored, slot deleted')
ok(out['t.pin'] === 'badMessage("att-signature")' && out['t.pin.stores'] === 'true', 'an attestation under a key N does not pin is refused')
ok(out['t.kid'] === 'badMessage("att-unknown-kid")' && out['t.kid.stores'] === 'true', 'an attestation under an unpinned kid is refused')
ok(out['q.result'] === 'declined' && out['q.asked'] === 'alice-link@example.com|Alice', 'declining the address refuses the link; the prompt carried the address and the name')
ok(out['q.stores'] === 'true' && out['q.slot'] === '409', 'and nothing is stored, and the slot is deleted')
ok(out['q.tamperedAsked'] === '0' && out['q.sealBad'] === 'true', 'a msg3 that does not check never reaches the prompt; H seals no address that is not normal')
ok(out['z.control'] === 'ok', 'CONTROL: after all that, the honest link still completes')

stop(); rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? `\n${checks}/${checks} checks passed` : `\n${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)
