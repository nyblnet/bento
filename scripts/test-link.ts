#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id link v1 rig: kernel/src/link.ts against the `link` section of
// kernel/fixtures/identity-v1.json.
//
//   node scripts/test-link.ts
//
// WHAT THIS PROVES. Every agent that links a device (Swift, Kotlin, Rust, the
// extension) and the directory that relays it is told to pass the `link`
// section. That is only worth something if the reference passes it: the
// deterministic rows (code → slot, the transcript, Z, the direction keys, the
// SAS, the exact msg2 and sealed ciphertexts) are RECOMPUTED here from their
// inputs and compared byte for byte, and every verdict row (msg0/msg1, the
// offer, the directory's release check, N's final check) must reach the stated
// verdict for the stated reason. The release rows also pin spend-first: the
// directory's challenge is consumed by every attempt that parses. Finally the
// attack rows security's §39.1 run-it list names must exist, so deleting one
// cannot quietly shrink the contract.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { b64uEnc, b64uDec, verifyBind, RESERVED_PREFIXES, LINK_PREFIXES } from '../kernel/src/statements.ts'
import { publicKeyOf, packScalars } from '../kernel/src/recovery.ts'
import {
  linkSlot, linkTokHash, parseLinkCode, formatLinkCode, linkTranscript, linkKeys, linkKeysFromShared, sasDigits, sasMatches,
  scannerMayProceed, buildMsg0, buildMsg1, parseMsg0, parseMsg1, linkAad, sealLinkMsg, openLinkMsg, verifyOffer, openOffer,
  buildOffer, verifyLinkRelease, openFinal, buildFinal, linkPopText, type LinkKeys, type LinkRole, type LinkOffer,
} from '../kernel/src/link.ts'
import type { AttState } from '../kernel/src/statements.ts'

let failures = 0, checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const F = JSON.parse(readFileSync(join(root, 'kernel/fixtures/identity-v1.json'), 'utf8'))
const L = F.link
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'))
const te = new TextEncoder()
const keysOf = (r: { h2n: string; n2h: string }): LinkKeys => ({ h2n: unhex(r.h2n), n2h: unhex(r.n2h), sasKey: new Uint8Array(32), sas: '' })
type V = { ok: boolean; reason?: string }
const verdict = (v: V, r: { expect: string; reason?: string }) =>
  r.expect === 'accept' ? v.ok : !v.ok && (r.reason === undefined || v.reason === r.reason)
const show = (v: V) => (v.ok ? 'accept' : `reject (${v.reason})`)
/** A verifier must answer, never throw: a throw is reported as the verdict `threw`. */
async function caught<T extends V>(f: () => Promise<T>): Promise<V> {
  try { return await f() } catch (e) { return { ok: false, reason: `threw: ${(e as Error).message}` } }
}

async function ecdhFrom(dHex: string) {
  const d = unhex(dHex), pub = publicKeyOf(d)!, raw = b64uDec(pub)!
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: b64uEnc(d), x: b64uEnc(raw.slice(1, 33)), y: b64uEnc(raw.slice(33)) },
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  return { pub, key }
}

console.log(`link code → slot (${L.codes.length})`)
for (const c of L.codes) {
  const code = unhex(c.codeHex)
  ok(formatLinkCode(code) === c.printed, `printed in the recovery-code format: ${c.printed}`)
  const p = parseLinkCode(c.printed.toLowerCase())
  ok(p.ok && hex(p.code) === c.codeHex, `${c.printed}: parses back to its 10 bytes`)
  const s = await linkSlot(code)
  ok(s.id === c.id && s.tok === c.tok && hex(s.salt) === c.saltHex, `${c.printed}: id, tok and salt by HKDF`)
  ok((await linkTokHash(s.tok)) === c.tokHash, `${c.printed}: the directory stores sha256(tok bytes)`)
}
ok(new Set(L.codes.flatMap((c: { id: string; tok: string; saltHex: string }) => [c.id, c.tok, b64uEnc(unhex(c.saltHex))])).size === 3 * L.codes.length,
  'id, tok and salt are distinct values (distinct HKDF infos)')

console.log(`\nsessions: transcript, Z, keys, SAS (${L.sessions.length})`)
for (const s of L.sessions) {
  const eD = await ecdhFrom(s.eDScalarHex), eS = await ecdhFrom(s.eSScalarHex)
  ok(eD.pub === s.eD && eS.pub === s.eS, `${s.name}: the ephemerals are d·G of the stated scalars`)
  ok(buildMsg0(s.eD, s.roleD) === s.msg0 && buildMsg1(s.eS) === s.msg1, `${s.name}: msg0 and msg1 bytes`)
  const m0 = await parseMsg0(s.msg0), m1 = await parseMsg1(s.msg1)
  ok(m0.ok && m0.value.eD === s.eD && m0.value.roleD === s.roleD && m1.ok && m1.value.eS === s.eS, `${s.name}: msg0 and msg1 parse`)
  const slot = await linkSlot(unhex(s.codeHex))
  const t = await linkTranscript(slot.id, s.eD, s.eS, s.roleD as LinkRole)
  ok(t === s.t, `${s.name}: t = sha256("lnkt.v1." id E_D E_S roleD)`)
  const z1 = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: await crypto.subtle.importKey('raw', b64uDec(s.eS)!, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, eD.key, 256))
  ok(hex(z1) === s.zHex, `${s.name}: Z is the ECDH x-coordinate`)
  const k = await linkKeysFromShared(unhex(s.zHex), slot.salt, s.t)
  ok(hex(k.h2n) === s.h2n && hex(k.n2h) === s.n2h && hex(k.sasKey) === s.sasKeyHex && k.sas === s.sas, `${s.name}: h2n, n2h, sasKey, SAS ${s.sas}`)
  const kD = (await linkKeys(eD.key, s.eS, slot.salt, s.t))!, kS = (await linkKeys(eS.key, s.eD, slot.salt, s.t))!
  ok(hex(kD.h2n) === s.h2n && hex(kS.h2n) === s.h2n && kD.sas === s.sas && kS.sas === s.sas, `${s.name}: both sides derive the same keys and SAS`)
  ok(hex(k.h2n) !== hex(k.n2h), `${s.name}: the two directions use different keys`)
  // the code is in the salt: the directory knows E_D, E_S and id, but a session with
  // any other salt (here: the empty salt) yields other keys and another SAS
  const noSalt = await linkKeysFromShared(unhex(s.zHex), new Uint8Array(32), s.t)
  ok(hex(noSalt.h2n) !== s.h2n && noSalt.sas !== s.sas, `${s.name}: without the code's salt, other keys and another SAS`)
}
const r = L.reflected
ok((await linkTranscript(r.id, r.eD, r.eS, r.roleD)) === null && r.t === null, 'a reflected ephemeral (E_S = E_D) gets no transcript')

console.log(`\nSAS digits (${L.sas.length}), typed SAS (${L.sasMatch.length}), roles (${L.roles.length})`)
for (const s of L.sas) ok(sasDigits(unhex(s.sasKeyHex)) === s.sas, `first 4 bytes ${s.sasKeyHex.slice(0, 8)} → ${s.sas}`)
ok(L.sas.some((s: { sas: string }) => s.sas.startsWith('0000')), 'a row whose SAS needs zero padding')
for (const m of L.sasMatch) ok(sasMatches(m.typed, m.sas) === m.match, `typed "${m.typed}" vs ${m.sas} → ${m.match}${m.note ? ` (${m.note})` : ''}`)
for (const x of L.roles) ok(scannerMayProceed(x.roleD, x.scannerHoldsAccount) === x.proceed, `D claims ${x.roleD}, S ${x.scannerHoldsAccount ? 'holds' : 'holds no'} account → ${x.proceed ? 'proceed' : 'abort'}`)

console.log(`\nmsg0 / msg1 grammar (${L.msgs.length})`)
for (const m of L.msgs) {
  ok(m.kind === 'msg0' || m.kind === 'msg1', `${m.name}: names its parser`)
  const v = await caught(() => (m.kind === 'msg1' ? parseMsg1(m.msg) : parseMsg0(m.msg)))
  ok(verdict(v, m), `${m.name}: ${show(v)}`)
}

console.log('\nmsg2: the exact ciphertext')
{
  const m = L.msg2, K = keysOf(m)
  ok(linkAad(m.t, 2) === m.aad, `AAD = ${m.aad.slice(0, 12)}…${m.aad.slice(-3)}`)
  ok((await sealLinkMsg(K, 2, m.t, unhex(m.ivHex), te.encode(m.plaintext))) === m.wire, 'msg2 = iv ‖ AES-GCM(n2h, offer, AAD) byte for byte')
  const o = await openOffer(K, m.t, m.wire)
  ok(o.ok, `H opens and accepts the offer: ${show(o)}`)
}

console.log(`\nthe offer, as H checks it (${L.offers.length})`)
for (const x of L.offers) {
  const v = await verifyOffer(x.text, x.t)
  ok(verdict(v, x), `${x.name}: ${show(v)}`)
  if (x.expect === 'accept' && v.ok) {
    const p = x.text.split('.')
    ok(buildOffer(v.value as LinkOffer, p[6], p[7] || null) === x.text, `${x.name}: rebuilds to the same bytes`)
    const flipped = x.text.slice(0, -2) + (x.text.at(-2) === 'A' ? 'B' : 'A') + x.text.at(-1)
    ok(!(await verifyOffer(x.text, x.t.slice(0, -1) + (x.t.at(-1) === 'A' ? 'Q' : 'A'))).ok, `${x.name}: refused under another transcript`)
    ok(!(await verifyOffer(flipped, x.t)).ok, `${x.name}: refused with its last PoP changed`)
  }
}
for (const x of L.offerWire) {
  const v = await openOffer(keysOf(x), x.t, x.wire)
  ok(verdict(v, x), `${x.name}: ${show(v)}`)
}

console.log('\nmsg3: the sealed key release')
{
  const m = L.msg3, K = keysOf(m)
  ok(hex(packScalars({ account: unhex(L.bind.accountScalarHex), kx: unhex(L.bind.kxScalarHex) })) === m.sealedPlaintextHex, 'the sealed plaintext is packScalars(account, recovery kx): 64 bytes')
  ok(m.sealedPlaintextHex.length === 128, 'mode C: the released blob is exactly 64 bytes')
  ok(linkAad(m.t, 3) === m.aad, 'AAD for message 3')
  ok((await sealLinkMsg(K, 3, m.t, unhex(m.ivHex), unhex(m.sealedPlaintextHex))) === m.sealed, 'SEALED = iv ‖ AES-GCM(h2n, blob, AAD) byte for byte')
  ok(m.text.split('\n')[7] === m.sealed, 'msg3 carries SEALED as its last line')
  const pt = await openLinkMsg(K, 3, m.t, m.sealed)
  ok(!!pt && hex(pt) === m.sealedPlaintextHex, 'opens back to the blob')
  const b = await verifyBind(L.bind.text, L.bind.sig, { now: F.now })
  ok(b.ok && b.value.accountPub === publicKeyOf(unhex(L.bind.accountScalarHex)) && b.value.kx === publicKeyOf(unhex(L.bind.kxScalarHex)),
    "the binding names the released scalars' public keys")
}

console.log(`\nthe directory's release check (${L.release.length})`)
type RelRow = { name: string; text: string; bindText: string; state: AttState; challenge: string; challengeSpent?: boolean; now?: number; expect: string; reason?: string; spendCalled: boolean }
for (const x of L.release as RelRow[]) {
  let calls = 0
  const v = await caught(() => verifyLinkRelease(x.text, { bindText: x.bindText, state: x.state, challenge: x.challenge, now: x.now ?? F.now,
    spend: () => { calls++; return !x.challengeSpent } }))
  ok(verdict(v, x), `${x.name}: ${show(v)}`)
  ok(calls === (x.spendCalled ? 1 : 0), `${x.name}: spend called ${calls}× (want ${x.spendCalled ? 1 : 0})`)
}
{
  const honest = (L.release as RelRow[]).find((x) => x.expect === 'accept')!
  const v = await verifyLinkRelease(honest.text, { bindText: honest.bindText, state: 'active', challenge: honest.challenge, now: F.now, spend: () => true })
  ok(v.ok && v.value.sealed === L.msg3.sealed, 'an accepted release hands back exactly SEALED')
  ok(buildFinal({ hDev: '', hDevSig: '', cns: '', cnsSig: '', nDev: '', nDevSig: '', sealed: '' }).split('\n').length === 8, 'msg3 is eight lines')
}

console.log(`\nN's final check (${L.final.length})`)
for (const x of L.final) {
  const v = await caught(() => openFinal(x.text, { keys: keysOf(x), t: x.t, offer: x.offer, binding: x.binding, now: x.now ?? F.now }))
  ok(verdict(v, x), `${x.name}: ${show(v)}`)
  if (x.expect === 'accept' && v.ok) {
    ok(hex(v.value.keys.account) === L.bind.accountScalarHex && hex(v.value.keys.kx) === L.bind.kxScalarHex, `${x.name}: N recovers the account and recovery kx scalars`)
    ok(v.value.device.devicePub === x.offer.devicePub, `${x.name}: N's own dev. certificate`)
  }
}

console.log('\nthe contract holds its attack rows (security §39.1 run-it list, K6)')
{
  const names = [...L.release, ...L.final, ...L.offers, ...L.offerWire].map((x: { name: string }) => x.name)
  const has = (needle: string) => names.some((n) => n.includes(needle))
  for (const needle of ['REPLAY', 'RELAY', 'ANOTHER CHALLENGE', 'PAYLOAD SWAP', 'FROZEN', 'PENDING', 'ANOTHER devicePub', 'ANOTHER consentPub',
    'ANOTHER kx', 'WRONG DIRECTION', 'ANOTHER transcript', 'OFFERED WITHOUT ITS PoP', 'ANOTHER account key', 'pre-mode-C',
    'MALFORMED served binding', "H's OWN devicePub", 'a space inside a line', 'a control character inside a line'])
    ok(has(needle), `attack row present: ${needle}`)
  ok(L.release.filter((x: RelRow) => x.reason === 'grammar').every((x: RelRow) => !x.spendCalled) &&
    L.release.filter((x: RelRow) => x.reason !== 'grammar').every((x: RelRow) => x.spendCalled), 'release: every refusal before the spend is grammar')
  for (const k of ['msg0', 'msg1']) ok(L.msgs.some((x: { kind: string; reason?: string }) => x.kind === k && x.reason === 'key'), `${k} has an invalid-point row`)
  for (const v of ['accept', 'reject']) for (const sec of ['offers', 'release', 'final', 'msgs'])
    ok(L[sec].some((x: { expect: string }) => x.expect === v), `${sec} has ${v === 'accept' ? 'an accept' : 'a reject'} row`)
}

console.log('\nprefixes')
{
  const families = ['dev', 'bind', 'att', 'tomb', 'del', 'cmp', 'dreq', 'rot', 'cns', 'cnst', 'inv', 'rev', 'dlg', 'prove']
  ok(LINK_PREFIXES.every((p) => !families.includes(p) && !RESERVED_PREFIXES.includes(p)), 'link prefixes collide with no statement family and no reserved prefix')
  ok(linkPopText('T') === 'lnkp.v1.T' && linkAad('T', 2) === 'lnka.v1.T.2', 'PoP and AAD texts')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
