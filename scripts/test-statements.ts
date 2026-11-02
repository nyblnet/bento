#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id statements rig: kernel/src/statements.ts + kernel/src/address.ts
// against the conformance vectors in kernel/fixtures/identity-v1.json.
//
//   node scripts/test-statements.ts
//
// WHAT THIS PROVES. Every host (Swift, Kotlin, Rust, the extension and the
// directory) is told to pass the fixture. That instruction is only worth
// something if the REFERENCE passes it too, row by row, for the stated reason.
// Beyond the rows, every accepted statement is tampered with three ways
// (signature, an extra field, one byte of text) and must then be refused, and
// every builder must reproduce the exact text it was parsed from.
// It also pins that the attack rows security's §22/§24 check runs (replay,
// relay, payload swap, docId swap, expiry) and the grammar refusals exist, so
// deleting a row cannot quietly shrink the contract. The directory requests
// (dreq.), rotation vouches (rot.) and their consents run the same way, from
// their own fixture sections.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  verifyDev, verifyBind, verifyAtt, verifyTomb, verifyDel, verifyCmp, verifyConsent,
  buildDev, buildBind, buildAtt, buildTomb, buildDel, buildCmp, buildConsent,
  consentTranscript, webauthnChallengeFor, lowS, verifyStatementSig, payloadMatchesPurpose,
  b64uDec, b64uEnc, KX_MODE, RESERVED_PREFIXES, DISPLAY_FORBIDDEN_RANGES, DISPLAY_FORBIDDEN_UNICODE,
  displayForbidden, type Verdict, type KxMode,
  verifyDreq, buildDreq, dreqArg, dreqNeedsConsent, verifyRotation, buildRot, sha256b64u,
  type AttState, type DreqOp, type DreqSubject,
} from '../kernel/src/statements.ts'
import { normalizeAddress } from '../kernel/src/address.ts'
import type { SignPurpose } from '../kernel/src/identity.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const F = JSON.parse(readFileSync(join(root, 'kernel/fixtures/identity-v1.json'), 'utf8'))
type Row = Record<string, unknown> & { name: string; type: string; text: string; sig: string; expect: 'accept' | 'reject'; reason?: string; spendCalled?: boolean }

let spendCalls = 0
async function check(r: Row, text = r.text, sig = r.sig): Promise<Verdict<unknown>> {
  const now = (r.now as number) ?? F.now
  const kxMode = (r.kxMode as KxMode) ?? F.kxModeDefault
  switch (r.type) {
    case 'dev': return verifyDev(text, sig, { now, kxMode })
    case 'bind': return verifyBind(text, sig, { now, kxMode })
    case 'att': return verifyAtt(text, sig, { directoryKeys: F.directoryKeys, bindText: r.bindText as string, now, maxAgeMs: r.maxAgeMs as number })
    case 'tomb': return verifyTomb(text, sig, { directoryKeys: F.directoryKeys, now })
    case 'del': return verifyDel(text, sig, { accountPub: F.keys.account, now })
    case 'cmp': return verifyCmp(text, sig, { accountPub: F.keys.account, bindText: r.bindText as string })
    case 'cns': return verifyConsent(text, sig, {
      consentPub: F.keys.consent, rp: r.rp as string, audience: r.audience as string, challenge: r.challenge as string,
      payloadText: r.payloadText as string, docId: (r.docId as string | null) ?? null, now,
      spend: () => { spendCalls++; return !r.challengeSpent },
    })
    default: throw new Error(`unknown row type ${r.type}`)
  }
}

function rebuild(type: string, v: unknown): string | null {
  const x = v as never
  switch (type) {
    case 'dev': return buildDev(x)
    case 'bind': return buildBind(x)
    case 'att': return buildAtt(x)
    case 'tomb': return buildTomb(x)
    case 'del': { const d = v as { address: string; ts: number }; return buildDel(d.address, d.ts) }
    case 'cmp': { const c = v as { bindHash: string; code: string }; return buildCmp(c.bindHash, c.code) }
    case 'cns': return buildConsent(x)
    default: return null
  }
}

console.log(`\nthe reference passes every statement row (${F.statements.length})`)
for (const r of F.statements as Row[]) {
  spendCalls = 0
  const v = await check(r)
  const got = v.ok ? 'accept' : `reject:${v.reason}`
  const want = r.expect === 'accept' ? 'accept' : `reject:${r.reason}`
  ok(got === want, `${r.name} → ${want}${got === want ? '' : ` (got ${got})`}`)
  if (r.type === 'cns') {
    ok((spendCalls > 0) === r.spendCalled,
      `${r.name}: the challenge was ${r.spendCalled ? '' : 'NOT '}consumed (spend called ${spendCalls}×)`)
  }
}

console.log('\nevery accepted statement round-trips, and refuses tampering')
for (const r of (F.statements as Row[]).filter((r) => r.expect === 'accept')) {
  const v = await check(r)
  if (!v.ok) continue
  ok(rebuild(r.type, v.value) === r.text, `${r.type}: the builder reproduces the exact text (${r.name})`)
  const sig = b64uDec(r.sig)!
  sig[10] ^= 0x01
  ok(!(await check(r, r.text, b64uEnc(sig))).ok, `${r.type}: a flipped signature bit is refused`)
  ok(!(await check(r, r.text + '.x', r.sig)).ok, `${r.type}: an extra field is refused`)
  const i = r.text.length - 2
  const flipped = r.text.slice(0, i) + (r.text[i] === '1' ? '2' : '1') + r.text.slice(i + 1)
  ok(!(await check(r, flipped, r.sig)).ok, `${r.type}: one changed byte of text is refused`)
}

console.log('\nthe contract cannot quietly shrink: required rows are present')
{
  const names = (F.statements as Row[]).map((r) => r.name)
  const has = (needle: string) => names.some((n) => n.includes(needle))
  for (const attack of ['REPLAY', 'RELAY', 'PAYLOAD SWAP', 'DOCID SWAP', 'EXPIRED']) ok(has(attack), `cns attack row present: ${attack}`)
  for (const g of ['high-S', 'DER', 'an extra field', 'a field missing', 'raw (unencoded) email', 'dotted rp', 'padded base64url'])
    ok(has(g), `grammar/signature row present: ${g}`)
  for (const t of ['dev', 'bind', 'att', 'tomb', 'del', 'cmp', 'cns'])
    ok((F.statements as Row[]).some((r) => r.type === t && r.expect === 'accept') &&
      (F.statements as Row[]).some((r) => r.type === t && r.expect === 'reject'), `${t}: at least one accept and one reject row`)
  ok(F.kxModeDefault === 'unruled' && KX_MODE === 'unruled', 'kx placement is unruled: both slots must be empty until §6b is decided')
}

console.log(`\ndreq.: the reference passes every directory-request row (${F.dreq.length})`)
type DreqRow = Row & { bindText: string; state: AttState; challenge: string; subject: Record<string, string>; challengeSpent?: boolean }
const bytesOf = (s: string) => b64uDec(s)!
function subjectOf(j: Record<string, string>): DreqSubject {
  switch (j.op) {
    case 'contest': return { op: 'contest', pendingBindText: j.pendingBindText }
    case 'freeze': return { op: 'freeze' }
    case 'status': return { op: 'status' }
    case 'cred-add': return { op: 'cred-add', attestationObject: bytesOf(j.attestationObject), clientDataJSON: bytesOf(j.clientDataJSON) }
    case 'cred-del': return { op: 'cred-del', credentialId: bytesOf(j.credentialId) }
    case 'rc-enrol': return { op: 'rc-enrol', body: bytesOf(j.body) }
    default: throw new Error(`unknown subject op ${j.op}`)
  }
}
async function checkDreq(r: DreqRow, text = r.text, sig = r.sig, spent = !!r.challengeSpent) {
  return verifyDreq(text, sig, {
    bindText: r.bindText, state: r.state, challenge: r.challenge, subject: subjectOf(r.subject),
    spend: () => { spendCalls++; return !spent },
  })
}
for (const r of F.dreq as DreqRow[]) {
  spendCalls = 0
  const v = await checkDreq(r)
  const got = v.ok ? 'accept' : `reject:${v.reason}`
  const want = r.expect === 'accept' ? 'accept' : `reject:${r.reason}`
  ok(got === want, `${r.name} → ${want}${got === want ? '' : ` (got ${got})`}`)
  ok(spendCalls === (r.spendCalled ? 1 : 0), `${r.name}: the challenge was ${r.spendCalled ? 'consumed once' : 'NOT consumed'} (spend called ${spendCalls}×)`)
}
for (const r of (F.dreq as DreqRow[]).filter((r) => r.expect === 'accept')) {
  const v = await checkDreq(r)
  if (!v.ok) continue
  ok(buildDreq(v.value) === r.text, `dreq: the builder reproduces the exact text (${r.name})`)
  ok(v.value.arg === (await dreqArg(subjectOf(r.subject))), `dreq: arg = dreqArg(subject) (${r.subject.op})`)
  const sig = b64uDec(r.sig)!; sig[10] ^= 0x01
  ok(!(await checkDreq(r, r.text, b64uEnc(sig))).ok, `dreq: a flipped signature bit is refused (${r.subject.op}, ${r.state})`)
  ok(!(await checkDreq(r, r.text + '.x')).ok, `dreq: an extra field is refused (${r.subject.op}, ${r.state})`)
  ok(!(await checkDreq(r, r.text, r.sig, true)).ok, `dreq: the same request against a spent challenge is refused (${r.subject.op}, ${r.state})`)
}
{
  const rows = F.dreq as DreqRow[]
  const ops: DreqOp[] = ['contest', 'freeze', 'status', 'cred-add', 'cred-del', 'rc-enrol']
  for (const op of ops) ok(rows.some((r) => r.subject.op === op && r.expect === 'accept'), `dreq: an accept row for ${op}`)
  for (const op of ['freeze', 'contest', 'cred-add'] as const) ok(rows.some((r) => r.subject.op === op && r.state === 'frozen' && r.reason === 'state'), `dreq: ${op} refused while frozen`)
  for (const op of ['cred-add', 'cred-del', 'rc-enrol'] as const) ok(rows.some((r) => r.subject.op === op && r.state === 'pending' && r.reason === 'state'), `dreq: ${op} refused while pending`)
  for (const needle of ['REPLAY', 'OP SWAP', 'PENDING key', 'credentialId alone', 'changed in transit', 'high-S', 'DER', 'raw (unencoded) email'])
    ok(rows.some((r) => r.name.includes(needle)), `dreq: required row present: ${needle}`)
  ok(ops.every((op) => dreqNeedsConsent(op) === (op === 'cred-add' || op === 'cred-del' || op === 'rc-enrol')),
    'dreq: exactly cred-add, cred-del and rc-enrol also need a cns.')
}

console.log(`\nrot.: verifyRotation passes every rotation row (${F.rot.length})`)
type RotRow = { name: string; prevBindText: string; nextBindText: string; nextSig: string; rotText: string; rotSig: string; expect: string; reason?: string }
const checkRot = (r: RotRow, o: Partial<RotRow> = {}) => {
  const x = { ...r, ...o }
  return verifyRotation(x.prevBindText, x.nextBindText, x.nextSig, x.rotText, x.rotSig, { now: F.now, kxMode: F.kxModeDefault })
}
for (const r of F.rot as RotRow[]) {
  const v = await checkRot(r)
  const got = v.ok ? 'accept' : `reject:${v.reason}`
  const want = r.expect === 'accept' ? 'accept' : `reject:${r.reason}`
  ok(got === want, `${r.name} → ${want}${got === want ? '' : ` (got ${got})`}`)
}
for (const r of (F.rot as RotRow[]).filter((r) => r.expect === 'accept')) {
  const v = await checkRot(r)
  if (!v.ok) continue
  ok(buildRot(await sha256b64u(r.nextBindText), await sha256b64u(r.prevBindText)) === r.rotText, `rot: the builder reproduces the exact text (${r.name})`)
  const sig = b64uDec(r.rotSig)!; sig[10] ^= 0x01
  ok(!(await checkRot(r, { rotSig: b64uEnc(sig) })).ok, 'rot: a flipped rot. signature bit is refused')
  const nsig = b64uDec(r.nextSig)!; nsig[10] ^= 0x01
  ok(!(await checkRot(r, { nextSig: b64uEnc(nsig) })).ok, 'rot: a flipped next-binding signature bit is refused')
  ok(!(await checkRot(r, { prevBindText: r.nextBindText, nextBindText: r.prevBindText })).ok, 'rot: prev and next swapped is refused')
}
for (const needle of ['SWAPPED HASHES', 'SEQ SKIP', 'ADDRESS CHANGE', 'SIGNED BY THE NEW KEY', 'OVER A DIFFERENT NEXT', 'bare next bind.'])
  ok((F.rot as RotRow[]).some((r) => r.name.includes(needle) && r.expect === 'reject'), `rot: required negative row present: ${needle}`)

console.log(`\ncns. over dreq.: the three op-specific consent purposes (${F.dreqConsent.length})`)
for (const r of F.dreqConsent as Row[]) {
  spendCalls = 0
  const v = await check(r)
  const got = v.ok ? 'accept' : `reject:${v.reason}`
  const want = r.expect === 'accept' ? 'accept' : `reject:${r.reason}`
  ok(got === want, `${r.name} → ${want}${got === want ? '' : ` (got ${got})`}`)
  ok((spendCalls > 0) === r.spendCalled, `${r.name}: the challenge was ${r.spendCalled ? '' : 'NOT '}consumed`)
  if (v.ok) ok(buildConsent(v.value as never) === r.text, `cns: the builder reproduces the exact text (${r.name})`)
}
for (const p of ['cred-add', 'cred-del', 'rc-enrol'])
  ok((F.dreqConsent as Row[]).some((r) => r.expect === 'accept' && r.text.split('.')[2] === p), `cns: an accept row for purpose ${p}`)
ok((F.dreqConsent as Row[]).filter((r) => r.reason === 'payload-family').length >= 3, 'cns: a consent for one dreq. op never authorises another (payload-family rows)')

console.log('\nderivations: the consent transcript and the WebAuthn challenge')
for (const t of F.transcripts) {
  const got = await consentTranscript(t.audience, t.challenge, t.payload)
  ok(got === t.transcript, `transcript(${t.audience}) ${t.transcript === null ? `→ refused (${t.note})` : '→ the fixture value'}`)
}
for (const w of F.webauthn) ok((await webauthnChallengeFor(w.cns)) === w.challenge, 'clientDataJSON.challenge = b64u(SHA-256(exact cns. bytes))')

console.log('\nlow-S: verifiers refuse high-S, signers fold it')
for (const [i, p] of (F.lowS as { high: string; low: string }[]).entries()) {
  const text = `dev.lows.${i}`
  ok(await verifyStatementSig(F.keys.account, p.low, text), `pair ${i}: the low-S signature verifies`)
  ok(!(await verifyStatementSig(F.keys.account, p.high, text)), `pair ${i}: its high-S twin (equally valid ECDSA) is refused`)
  ok(b64uEnc(lowS(b64uDec(p.high)!)) === p.low && b64uEnc(lowS(b64uDec(p.low)!)) === p.low, `pair ${i}: lowS folds high to low and leaves low alone`)
}

console.log('\nroutine signing: each SignPurpose signs only its own statement shape')
for (const p of F.purposes as { purpose: SignPurpose; payload: string; match: boolean; note?: string }[]) {
  ok(payloadMatchesPurpose(p.purpose, p.payload) === p.match,
    `${p.purpose} ${p.match ? 'accepts' : 'refuses'} ${p.payload.slice(0, 24)}${p.payload.length > 24 ? '…' : ''}${p.note ? ` (${p.note})` : ''}`)
}

console.log('\naddresses: one normal form for every host (ASCII-only, phase 1)')
for (const a of F.addresses as { input: string; address?: string; reason?: string; note?: string }[]) {
  const r = normalizeAddress(a.input)
  const want = a.address !== undefined ? `ok:${a.address}` : `refused:${a.reason}`
  const got = r.ok ? `ok:${r.address}` : `refused:${r.reason}`
  ok(got === want, `${JSON.stringify(a.input).slice(0, 40)} → ${want}${got === want ? '' : ` (got ${got})`}`)
}

console.log('\nstrict base64url')
{
  ok(b64uDec('QQ') !== null && b64uDec('QQ==') === null, 'padding is refused')
  ok(b64uDec('QR') === null, 'non-zero trailing bits (a non-canonical spelling of "A") are refused')
  ok(b64uDec('Q') === null, 'an impossible length is refused')
  ok(b64uDec('Q+8') === null && b64uDec('Q/8') === null, 'the standard alphabet (+ /) is refused')
  ok(b64uDec('') !== null && b64uDec('')!.length === 0, 'the empty string is zero bytes')
}

console.log('\nreserved prefixes')
ok(RESERVED_PREFIXES.includes('pk'), 'pk. is reserved for the phase-2 passkey statement')
ok(RESERVED_PREFIXES.includes('drev'), 'drev. is reserved for device revocation (arrives with per-device kx)')

console.log('\nthe display refusal set is FROZEN, not read from the platform\'s Unicode tables')
{
  ok(JSON.stringify(F.displayForbidden.ranges) === JSON.stringify(DISPLAY_FORBIDDEN_RANGES) &&
    F.displayForbidden.unicode === DISPLAY_FORBIDDEN_UNICODE, `the fixture carries the same table (Unicode ${DISPLAY_FORBIDDEN_UNICODE})`)
  const ascending = DISPLAY_FORBIDDEN_RANGES.every(([a, b], i, r) => a <= b && (i === 0 || a > r[i - 1][1] + 1))
  ok(ascending, 'ranges are sorted, disjoint and non-adjacent (one canonical table)')
  // The categories it was frozen from. Compared only on a runtime whose tables ARE
  // that version; on another Node the categories may differ, which is the point.
  const re = /[\p{Cc}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0]|(?![\u200C\u200D])\p{Cf}/u
  if (process.versions.unicode === DISPLAY_FORBIDDEN_UNICODE) {
    let same = true
    for (let c = 0; c <= 0x10ffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue
      if (re.test(String.fromCodePoint(c)) !== displayForbidden(c)) { same = false; break }
    }
    ok(same, `on Unicode ${process.versions.unicode} the frozen table equals the categories it was built from`)
  } else {
    console.log(`  note  runtime is Unicode ${process.versions.unicode}; the frozen table (${DISPLAY_FORBIDDEN_UNICODE}) is authoritative, category check skipped`)
  }
  ok(!displayForbidden(0x200c) && !displayForbidden(0x200d), 'ZWNJ and ZWJ are not in the table (refused only at either end)')
  const nonchars = [...Array.from({ length: 32 }, (_, i) => 0xfdd0 + i), ...Array.from({ length: 17 }, (_, p) => [p * 0x10000 + 0xfffe, p * 0x10000 + 0xffff]).flat()]
  ok(nonchars.length === 66 && nonchars.every(displayForbidden), 'all 66 noncharacters are refused')
  ok(displayForbidden(0x0378) && displayForbidden(0x3ffff), 'unassigned code points (U+0378, U+3FFFF) are refused')
  ok(!displayForbidden(0x1f469) && !displayForbidden(0x06cc) && !displayForbidden(0x0041), 'assigned letters and emoji are not')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
