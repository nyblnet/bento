#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/id B1 on iOS and the Mac — the shared bridge's identity calls
 * (home/bridge.js) answered by the iOS host (home/ios/IdentityBridge.swift).
 *
 *   node scripts/test-home-id-bridge.mjs
 *
 * The iOS counterpart of the desktop host's `sign` scenario, run in real WebKit
 * on macOS: the real bridge.js, a script-message handler that routes exactly as
 * EditorViewController does, and the real agent and key code behind it. Only the
 * prompts (consent, re-authentication) and the clock are stand-ins.
 *
 *   - an UNKNOWN document gets no agent object, and a forged id.* message from
 *     it is refused by the host even with a live session (the bridge is a
 *     courtesy, the host is the authority)
 *   - the host's own idle limit (1 s here; 1 h shipped) inside and past, the
 *     overall limit at the boundary (signs one ms short, refuses AT it: a limit ends the session AT the limit),
 *     a lock, and a refusal that raises ONE prompt (coalesced; a cancel is not
 *     re-raised at once); the real clock for the idle row
 *   - purpose lock: a payload of the wrong shape is refused before any session
 *     is consulted; invite/revoke are not served in phase 1
 *   - whoami: nothing before the person consents for THIS document, one prompt
 *     however many calls, a "no" is not re-asked, the person's own keys resolve
 *     only after consent
 *   - resolve: only a binding the host already holds; an email never leaves
 *   - lock(): sceneDidEnterBackground and applicationProtectedDataWillBecomeUnavailable still call it
 *     (source pins, each with a delete-the-line mutant)
 *   - O1 deferred: any identity managed-config key stops every identity op, even
 *     one added after load; CONTROL: key absent proceeds
 *
 * MUTANTS: each deletes or weakens one line of IdentityBridge.swift; the rig must
 * go red on the row that line exists for. A replacement that does not apply
 * exactly once fails the rig (a mutant that was never applied proves nothing).
 *
 * Apple platforms only (WebKit, CryptoKit); skips elsewhere.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe' }) } catch { console.log('home id bridge: SKIPPED — needs an Apple toolchain (WebKit, CryptoKit).'); process.exit(0) }

const SRC = ['HostDocStore.swift', 'IdentityKeys.swift', 'IdentityDisplayTable.swift', 'IdentityStatements.swift', 'IdentityAgent.swift']
const BRIDGE_SRC = join(ROOT, 'home/ios/IdentityBridge.swift')
const work = mkdtempSync(join(tmpdir(), 'bento-idbridge-'))
let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }

function build(name, bridgeText) {
  const dir = join(work, name)
  execFileSync('mkdir', ['-p', dir])
  writeFileSync(join(dir, 'IdentityBridge.swift'), bridgeText)
  copyFileSync(join(ROOT, 'scripts/lib/id-bridge-rig.swift'), join(dir, 'main.swift'))
  const bin = join(dir, 'rig')
  execFileSync('swiftc', ['-D', 'DEBUG', '-D', 'BENTO_SOFTWARE_DEVICE_KEYS', '-o', bin, join(dir, 'main.swift'), join(dir, 'IdentityBridge.swift'), ...SRC.map((f) => join(ROOT, 'home/ios', f))],
    { stdio: 'pipe', maxBuffer: 1 << 26, timeout: 600000 })
  return bin
}
function run(bin) {
  let out = ''
  try { out = execFileSync(bin, [join(ROOT, 'home/bridge.js')], { timeout: 240000, maxBuffer: 1 << 24 }).toString() } catch (e) { out = (e.stdout || '').toString() }
  const rows = {}
  for (const l of out.split('\n')) { const m = /^row\.([^=]+)=(true|false)$/.exec(l); if (m) rows[m[1]] = m[2] === 'true' }
  return { rows, done: /^done=1$/m.test(out), out }
}

const text = readFileSync(BRIDGE_SRC, 'utf8')
console.log('baseline')
let base
try { base = run(build('base', text)) } catch (e) { console.error('build failed:\n' + (e.stderr || e.message).toString().split('\n').filter((l) => /error/.test(l)).join('\n')); process.exit(2) }
const names = Object.keys(base.rows)
ok(base.done && names.length >= 40, `the rig ran to the end and reported ${names.length} rows`)
for (const n of names) ok(base.rows[n], n)

// [name, exact text in IdentityBridge.swift, replacement, rows that must go red]
const MUTANTS = [
  ['session gate removed', `guard session.live() else { raiseReauth(); return .refuse("reauth") }`, `_ = session.live()`,
    ['sign.nosession.reauth', 'sign.idle.past.reauth', 'sign.overall.at-limit.reauth', 'sign.lock.reauth', 'realtime.idle.past.reauth']],
  ['idle boundary off by one', `t - w.last < policy.idleMs`, `t - w.last <= policy.idleMs`, ['sign.idle.at-limit.reauth']],
  ['idle limit ignored', `t - w.last < policy.idleMs, `, ``, ['sign.idle.past.reauth', 'realtime.idle.past.reauth']],
  ['overall limit ignored', `, t - w.start < policy.overallMs`, ``, ['sign.overall.at-limit.reauth']],
  ['overall boundary off by one', `t - w.start < policy.overallMs`, `t - w.start <= policy.overallMs`, ['sign.overall.at-limit.reauth']],
  ['clock moved backwards stays live', `t >= w.last, `, ``, ['sign.clock.back-one-ms.reauth']],
  ['use renews the overall clock', `window = (w.start, clock())`, `window = (clock(), clock())`, ['sign.overall.at-limit.reauth']],
  ['use does not renew idle', `if let w = window { window = (w.start, clock()) }`, `_ = window`, ['sign.idle.again.ok']],
  ['unknown document served', `guard genuine, !docKey.isEmpty else`, `guard !docKey.isEmpty else`,
    ['agent.unknown.forged-sign', 'agent.unknown.forged-sign-live-session', 'agent.unknown.forged-whoami']],
  ['identity declared for every load', `genuine ? ["store", "identity"] : ["store"]`, `["store", "identity"]`, ['agent.unknown.none']],
  ['purpose lock removed', `guard IdentityStatements.payloadMatchesPurpose(purpose, payload) else { return .refuse("purpose") }`, ``,
    // IdentityAgent.sign checks the shape again, so with a live session the answer is the same: what this line
    // owns is ORDER, a mismatch is refused before the session is consulted
    ['purpose.mismatch.no-session-needed']],
  ['routine-only gate removed', `guard Self.routinePurposes.contains(purpose) else { return .refuse("unavailable") }`,
    `guard Self.routinePurposes.contains(purpose) || purpose == "invite" else { return .refuse("unavailable") }`,
    // the agent would refuse an invite anyway (no verifier), but only AFTER minting a consent key
    ['purpose.invite.mints-no-consent-key']],
  ['mismatch consults the session first', `// the shape first: a mismatch is refused before any key or session is looked at`,
    `if !session.live() { raiseReauth() }`, ['purpose.mismatch.no-session-needed']],
  ['whoami without consent', `switch consent.state(docKey) {\n        case .granted: reply(whoamiReply(p))`,
    `switch ConsentBook.State.granted {\n        case .granted: reply(whoamiReply(p))`, ['whoami.declined.null', 'whoami.per-document']],
  ['a no is asked again', `consent.record(docKey, allow: allow)`, `if allow { consent.record(docKey, allow: allow) }`, ['whoami.declined.not-asked-again']],
  ['one prompt per call', `if waitingConsent != nil { waitingConsent!.append(reply); return }`, ``, ['whoami.concurrent.one-prompt']],
  ['own key resolves without consent', `guard consent.state(docKey) == .granted, let p = profile() else { return .okNull }`,
    `guard let p = profile() else { return .okNull }`, ['whoami.before-consent.resolve-own-nothing', 'whoami.declined.resolve-own-nothing']],
  ['managed key ignored', `guard !managed() else {`, `guard !managed() || true else {`,
    ['managed.present.sign-refused', 'managed.present.whoami-null', 'managed.present.resolve-null']],
  ['reauth prompts not coalesced', `if reauthPending { return }`, ``, ['reauth.coalesced']],
  ['reauth cancel re-raised at once', `if let c = reauthCancelledAt, now() - c < Self.reauthCooldownMs { return }`, ``, ['reauth.cancel.cooldown']],
  ['reauth never opens a session', `if ok { reauthCancelledAt = nil; session.begin() }`, `if ok { reauthCancelledAt = nil }`,
    ['sign.after-reauth.ok', 'reauth.confirmed.opens-session']],
  ['resolve returns anything asked', `guard let k = known(pub) else { return .okNull }`, `let k = known(pub) ?? Known(name: "x", email: "x@x", vouchedBy: "x", accountPub: pub, firstSeen: 0, changed: false)`, ['resolve.unknown-key.null']],
]
for (const [name, from, to, expect] of MUTANTS) {
  const n = text.split(from).length - 1
  if (n !== 1) { ok(false, `mutant "${name}": the line to mutate occurs ${n} times (must be exactly 1)`); continue }
  let r
  try { r = run(build('m-' + name.replace(/\W+/g, '-'), text.replace(from, () => to))) } catch (e) { ok(false, `mutant "${name}" did not build: ${(e.stderr || e.message).toString().split('\n').filter((l) => /error/.test(l)).slice(0, 3).join(' | ')}`); continue }
  const red = expect.filter((row) => r.rows[row] === false)
  ok(red.length === expect.length, `mutant "${name}" goes red on ${expect.join(', ')}${red.length === expect.length ? '' : ` (red: ${red.join(', ') || 'none'})`}`)
}

// The editor's wiring (a shape check: the app itself is built and driven by the simulator job).
// The order is the point: gate 1 judges, THEN the bridge is re-installed with the caps that verdict
// allows, THEN the document loads; and the caps come from the one function the rig above exercised.
const evc = readFileSync(join(ROOT, 'home/ios/EditorViewController.swift'), 'utf8')
const iGate = evc.indexOf('gate = Self.gate(document.html)')
const iInstall = evc.indexOf('installBridge(into: webView.configuration.userContentController)', iGate)
const iLoad = evc.indexOf('webView.load(', iGate)
ok(iGate > 0 && iInstall > iGate && iLoad > iInstall, 'editor: gate 1 judges, then the bridge is reinstalled, then the document loads')
ok(/IdentityBridgeHost\.hostCaps\(genuine: isGenuine\)/.test(evc) && !/__bentoHostCaps = \['store', 'identity'\]/.test(evc), "editor: 'identity' is declared only through hostCaps(genuine:)")
ok(/IdentityBridgeHost\.ops\.contains\(op\)/.test(evc) && /genuine: isGenuine, docKey: originHost/.test(evc), 'editor: id.* ops reach the host, built from the gate verdict and the document origin')

// lock() has a host caller (security §2e B): backgrounding and a device lock end the signing session.
// The behaviour is UIKit's to trigger, so the pin is on source: the named callback must still contain
// the call, and deleting that line must turn the pin red (a mutant applied exactly once, then re-judged).
const LOCK_CALL = /EditorViewController\.identitySession\.lock\(\)/
function bodyOf(src, sig) {
  const i = src.indexOf(sig)
  if (i < 0) return null
  const open = src.indexOf('{', i)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1)
  }
  return null
}
const LOCK_SITES = [
  ['home/ios/SceneDelegate.swift', 'func sceneDidEnterBackground(_ scene: UIScene)', 'sceneDidEnterBackground'],
  ['home/ios/AppDelegate.swift', 'func applicationProtectedDataWillBecomeUnavailable(_ application: UIApplication)', 'applicationProtectedDataWillBecomeUnavailable'],
]
for (const [file, sig, label] of LOCK_SITES) {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const body = bodyOf(src, sig)
  ok(body !== null && LOCK_CALL.test(body), `lock: ${label} ends the signing session`)
  const lines = src.split('\n')
  const hits = lines.map((l, i) => (LOCK_CALL.test(l) ? i : -1)).filter((i) => i >= 0)
  const inBody = body ? hits.filter((i) => body.includes(lines[i].trim())) : []
  ok(inBody.length === 1, `lock mutant "${label} stops calling lock()": the call occurs ${inBody.length} times in the callback (must be exactly 1)`)
  if (inBody.length === 1) {
    const mutated = lines.filter((_, i) => i !== inBody[0]).join('\n')
    const mb = bodyOf(mutated, sig)
    ok(mb !== null && !LOCK_CALL.test(mb), `lock mutant "${label} stops calling lock()" turns the pin red`)
  }
}

rmSync(work, { recursive: true, force: true })
console.log(`\nhome id bridge: ${checks - failures}/${checks} passed`)
process.exit(failures ? 1 : 0)
