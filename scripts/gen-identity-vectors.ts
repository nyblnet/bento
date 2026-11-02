#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Generates kernel/fixtures/identity-v1.json — the bento/id conformance vectors.
//
//   node scripts/gen-identity-vectors.ts
//
// Every host's statement code (Swift, Kotlin, Rust, the extension's JS and the
// directory) must reach the same verdict as the kernel reference on every row.
// The keys are minted fresh for each run and are TEST KEYS ONLY. Signatures are
// random (ECDSA), so regenerating changes the file; that is fine — the rig checks
// verdicts, not bytes. Regenerate only when the rules change, and commit the result.

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  b64uEnc, signStatement, sha256b64u, buildDev, buildBind, buildAtt, buildTomb, buildDel, buildCmp,
  buildConsent, consentTranscript, webauthnChallengeFor, lowS, CONSENT_MAX_TTL_MS,
  buildDreq, dreqArg, buildRot, type DreqSubject, type DreqOp,
  DISPLAY_FORBIDDEN_RANGES, DISPLAY_FORBIDDEN_UNICODE,
} from '../kernel/src/statements.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'kernel/fixtures/identity-v1.json')

const NOW = 1_800_000_000_000 // 2027-01-15, fixed so the rows are stable in time
const DAY = 86_400_000
const created = NOW - DAY
const expires = NOW + 300 * DAY

type KP = { pub: string; key: CryptoKey }
async function signer(): Promise<KP> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  return { pub: b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))), key: kp.privateKey }
}
async function kxKey(): Promise<string> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  return b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
}

const account = await signer(), device = await signer(), consent = await signer()
const directory = await signer(), stranger = await signer()
const kx = await kxKey(), kx2 = await kxKey()
const KID = 'dir-2027a'
const directoryKeys = { [KID]: directory.pub }
const ROOM = 'w' + b64uEnc(new Uint8Array(32).fill(7))     // a room NAME, 43 chars after 'w'
const CHALLENGE = b64uEnc(new Uint8Array(24).map((_, i) => i * 11 + 3))
const enc = (s: string) => b64uEnc(new TextEncoder().encode(s))

/** A signature in high-S form (valid ECDSA, refused here) and a DER encoding. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const dec = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0))
const big = (b: Uint8Array) => b.reduce((x, v) => (x << 8n) | BigInt(v), 0n)
function highS(sig: string): string {
  const b = dec(sig), s = big(b.subarray(32)), hs = N - s
  const out = new Uint8Array(64); out.set(b.subarray(0, 32))
  for (let i = 63, x = hs; i >= 32; i--) { out[i] = Number(x & 0xffn); x >>= 8n }
  return b64uEnc(out)
}
function der(sig: string): string {
  const b = dec(sig)
  const int = (x: Uint8Array) => { let i = 0; while (i < x.length - 1 && x[i] === 0) i++; let v = x.subarray(i); if (v[0] & 0x80) v = Uint8Array.of(0, ...v); return Uint8Array.of(0x02, v.length, ...v) }
  const r = int(b.subarray(0, 32)), s = int(b.subarray(32))
  return b64uEnc(Uint8Array.of(0x30, r.length + s.length, ...r, ...s))
}

const rows: Record<string, unknown>[] = []
const row = (r: Record<string, unknown>) => rows.push(r)
const sign = (k: KP, t: string) => signStatement(k.key, t)

// --- dev. -----------------------------------------------------------------------
{
  const base = { devicePub: device.pub, consentPub: consent.pub, accountPub: account.pub, kx: null, label: 'Café laptop', created, expires }
  const t = buildDev(base)
  const s = await sign(account, t)
  row({ name: 'dev: a native device (routine + consent key)', type: 'dev', text: t, sig: s, expect: 'accept' })
  const light = buildDev({ ...base, consentPub: null, label: null })
  row({ name: 'dev: a light-tier device (no consent key)', type: 'dev', text: light, sig: await sign(account, light), expect: 'accept' })
  const withKx = buildDev({ ...base, kx })
  const sKx = await sign(account, withKx)
  row({ name: 'dev: kx filled while placement is unruled', type: 'dev', text: withKx, sig: sKx, expect: 'reject', reason: 'kx' })
  row({ name: 'dev: kx filled under mode B (per device)', type: 'dev', kxMode: 'B', text: withKx, sig: sKx, expect: 'accept' })
  row({ name: 'dev: kx filled under mode A (it belongs in bind.)', type: 'dev', kxMode: 'A', text: withKx, sig: sKx, expect: 'reject', reason: 'kx' })
  row({ name: 'dev: kx missing under mode C', type: 'dev', kxMode: 'C', text: t, sig: s, expect: 'reject', reason: 'kx' })
  const kxIsDevice = buildDev({ ...base, kx: device.pub })
  row({ name: 'dev: kx equal to the device key', type: 'dev', kxMode: 'B', text: kxIsDevice, sig: await sign(account, kxIsDevice), expect: 'reject', reason: 'kx' })
  const kxIsConsent = buildDev({ ...base, kx: consent.pub })
  row({ name: 'dev: kx equal to the consent key', type: 'dev', kxMode: 'B', text: kxIsConsent, sig: await sign(account, kxIsConsent), expect: 'reject', reason: 'kx' })
  const sameKeys = buildDev({ ...base, consentPub: device.pub })
  row({ name: 'dev: consent key equal to the routine key', type: 'dev', text: sameKeys, sig: await sign(account, sameKeys), expect: 'reject', reason: 'consent-key' })
  const old = buildDev({ ...base, created: NOW - 300 * DAY, expires: NOW - DAY })
  row({ name: 'dev: expired', type: 'dev', text: old, sig: await sign(account, old), expect: 'reject', reason: 'expired' })
  const long = buildDev({ ...base, expires: created + 420 * DAY })
  row({ name: 'dev: lifetime over 13 months + 1 day', type: 'dev', text: long, sig: await sign(account, long), expect: 'reject', reason: 'lifetime' })
  const bidi = buildDev({ ...base, label: 'laptop‮gnp.exe' })
  row({ name: 'dev: label with a bidi override', type: 'dev', text: bidi, sig: await sign(account, bidi), expect: 'reject', reason: 'label' })
  row({ name: 'dev: signed by the device key, not the account key', type: 'dev', text: t, sig: await sign(device, t), expect: 'reject', reason: 'signature' })
  row({ name: 'dev: high-S signature', type: 'dev', text: t, sig: highS(s), expect: 'reject', reason: 'signature' })
  row({ name: 'dev: DER signature (a host forgot to convert)', type: 'dev', text: t, sig: der(s), expect: 'reject', reason: 'signature' })
  row({ name: 'dev: an extra field', type: 'dev', text: t + '.x', sig: s, expect: 'reject', reason: 'grammar' })
  row({ name: 'dev: a field missing', type: 'dev', text: t.slice(0, t.lastIndexOf('.')), sig: s, expect: 'reject', reason: 'grammar' })
  const padded = t.replace(device.pub, device.pub + '=')
  row({ name: 'dev: a padded base64url key', type: 'dev', text: padded, sig: await sign(account, padded), expect: 'reject', reason: 'key' })
  row({ name: 'dev: a space in the text', type: 'dev', text: t.replace('dev.', 'dev. '), sig: s, expect: 'reject', reason: 'grammar' })
}

// --- bind. ----------------------------------------------------------------------
let bind1 = ''
{
  const base = { address: 'alice@example.com', accountPub: account.pub, kx: null, name: 'Alice', seq: 1, prev: null, created, expires }
  bind1 = buildBind(base)
  row({ name: 'bind: first binding (seq 1, no prev)', type: 'bind', text: bind1, sig: await sign(account, bind1), expect: 'accept' })
  const b2 = buildBind({ ...base, seq: 2, prev: await sha256b64u(bind1) })
  row({ name: 'bind: a rotation (seq 2, prev = hash of seq 1)', type: 'bind', text: b2, sig: await sign(account, b2), expect: 'accept' })
  const noName = buildBind({ ...base, name: null })
  row({ name: 'bind: no display name (empty field)', type: 'bind', text: noName, sig: await sign(account, noName), expect: 'accept' })
  const seq1Prev = buildBind({ ...base, prev: await sha256b64u(bind1) })
  row({ name: 'bind: seq 1 with a prev', type: 'bind', text: seq1Prev, sig: await sign(account, seq1Prev), expect: 'reject', reason: 'prev' })
  const seq2NoPrev = buildBind({ ...base, seq: 2 })
  row({ name: 'bind: seq 2 without a prev', type: 'bind', text: seq2NoPrev, sig: await sign(account, seq2NoPrev), expect: 'reject', reason: 'prev' })
  const upper = buildBind({ ...base, address: 'Alice@Example.com' })
  row({ name: 'bind: an address not in normal form', type: 'bind', text: upper, sig: await sign(account, upper), expect: 'reject', reason: 'address' })
  const raw = ['bind', 'alice@example.com', account.pub, '', enc('Alice'), 1, '', created, expires].join('.')
  row({ name: 'bind: a raw (unencoded) email breaks the field count', type: 'bind', text: raw, sig: await sign(account, raw), expect: 'reject', reason: 'grammar' })
  const longName = buildBind({ ...base, name: 'x'.repeat(65) })
  row({ name: 'bind: a display name over 64 characters', type: 'bind', text: longName, sig: await sign(account, longName), expect: 'reject', reason: 'name' })
  // display names: invisible and layout characters refused (security, #764)
  for (const [c, what] of [
    ['\u200B', 'zero-width space'], ['\u2060', 'word joiner'], ['\uFEFF', 'byte-order mark'],
    ['\u061C', 'Arabic letter mark (bidi)'], ['\u200E', 'left-to-right mark'], ['\u202E', 'right-to-left override'],
    ['\u2028', 'line separator'], ['\u2029', 'paragraph separator'], ['\u180E', 'Mongolian vowel separator'],
    ['\u00AD', 'soft hyphen'], ['\u0007', 'a control character'], ['\uE000', 'private use'],
    ['\u3164', 'Hangul filler (renders blank)'], ['\u115F', 'Hangul choseong filler'],
    ['\u0378', 'an unassigned code point'], ['\uFFFF', 'a noncharacter (U+FFFF)'], ['\uFDD0', 'a noncharacter (U+FDD0)'],
    ['\u{3FFFF}', 'a noncharacter in plane 3'],
  ] as const) {
    const t = buildBind({ ...base, name: `Al${c}ice` })
    row({ name: `bind: a name containing ${what} is refused`, type: 'bind', text: t, sig: await sign(account, t), expect: 'reject', reason: 'name' })
  }
  for (const [n, what] of [
    ['\u200CAlice', 'ZWNJ at the start'], ['Alice\u200D', 'ZWJ at the end'], ['Ame\u0301lie', 'not in NFC (a decomposed é)'],
  ] as const) {
    const t = buildBind({ ...base, name: n })
    row({ name: `bind: a name with ${what} is refused`, type: 'bind', text: t, sig: await sign(account, t), expect: 'reject', reason: 'name' })
  }
  for (const [n, what] of [
    ['\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645', 'a Persian name with a mid-word ZWNJ'],
    ['\u{1F469}\u200D\u{1F4BB} Dev', 'an emoji ZWJ sequence'], ['Améli', 'an NFC accented name'],
  ] as const) {
    const t = buildBind({ ...base, name: n })
    row({ name: `bind: ${what} is accepted`, type: 'bind', text: t, sig: await sign(account, t), expect: 'accept' })
  }
  const withKx = buildBind({ ...base, kx })
  const sKx = await sign(account, withKx)
  row({ name: 'bind: kx filled while placement is unruled', type: 'bind', text: withKx, sig: sKx, expect: 'reject', reason: 'kx' })
  row({ name: 'bind: kx filled under mode A (shared)', type: 'bind', kxMode: 'A', text: withKx, sig: sKx, expect: 'accept' })
  row({ name: 'bind: kx filled under mode C (recovery kx)', type: 'bind', kxMode: 'C', text: withKx, sig: sKx, expect: 'accept' })
  row({ name: 'bind: kx filled under mode B (it belongs in dev.)', type: 'bind', kxMode: 'B', text: withKx, sig: sKx, expect: 'reject', reason: 'kx' })
  const kxIsKey = buildBind({ ...base, kx: account.pub })
  row({ name: 'bind: kx equal to the account key', type: 'bind', kxMode: 'A', text: kxIsKey, sig: await sign(account, kxIsKey), expect: 'reject', reason: 'kx' })
  row({ name: 'bind: signed by a stranger', type: 'bind', text: bind1, sig: await sign(stranger, bind1), expect: 'reject', reason: 'signature' })
}

// --- att. -----------------------------------------------------------------------
{
  const h = await sha256b64u(bind1)
  const base = { bindHash: h, verifiedAt: NOW - 3600_000, issuedAt: NOW - 60_000, kid: KID, state: 'active' as const }
  const t = buildAtt(base)
  const ctx = { bindText: bind1, maxAgeMs: 10 * 60_000 }
  row({ name: 'att: an active attestation', type: 'att', ...ctx, text: t, sig: await sign(directory, t), expect: 'accept' })
  const frozen = buildAtt({ ...base, state: 'frozen' })
  row({ name: 'att: a frozen binding (state is signed)', type: 'att', ...ctx, text: frozen, sig: await sign(directory, frozen), expect: 'accept' })
  const stale = buildAtt({ ...base, issuedAt: NOW - 3600_000 })
  row({ name: 'att: an answer too old to trust (replay)', type: 'att', ...ctx, text: stale, sig: await sign(directory, stale), expect: 'reject', reason: 'stale' })
  row({ name: 'att: for a different binding', type: 'att', ...ctx, bindText: bind1 + 'x', text: t, sig: await sign(directory, t), expect: 'reject', reason: 'bind-mismatch' })
  const otherKid = buildAtt({ ...base, kid: 'dir-unknown' })
  row({ name: 'att: an unknown key id', type: 'att', ...ctx, text: otherKid, sig: await sign(directory, otherKid), expect: 'reject', reason: 'unknown-kid' })
  const protoKid = t.replace(KID, '__proto__')
  row({ name: 'att: a prototype key as kid', type: 'att', ...ctx, text: protoKid, sig: await sign(directory, protoKid), expect: 'reject', reason: 'grammar' })
  const badState = t.replace('.active', '.revoked')
  row({ name: 'att: a state outside the closed set', type: 'att', ...ctx, text: badState, sig: await sign(directory, badState), expect: 'reject', reason: 'grammar' })
  row({ name: 'att: signed by the release key, not the directory key', type: 'att', ...ctx, text: t, sig: await sign(stranger, t), expect: 'reject', reason: 'signature' })
}

// --- tomb. / del. / cmp. -----------------------------------------------------------
{
  const t = buildTomb({ lastBindHash: await sha256b64u(bind1), seq: 2, deletedAt: NOW - 1000, by: 'holder', kid: KID })
  row({ name: 'tomb: a holder deletion', type: 'tomb', text: t, sig: await sign(directory, t), expect: 'accept' })
  const none = buildTomb({ lastBindHash: null, seq: 1, deletedAt: NOW - 1000, by: 'operator', kid: KID })
  row({ name: 'tomb: no previous binding text (empty hash)', type: 'tomb', text: none, sig: await sign(directory, none), expect: 'accept' })
  const by = t.replace('.holder.', '.admin.')
  row({ name: 'tomb: "by" outside the closed set', type: 'tomb', text: by, sig: await sign(directory, by), expect: 'reject', reason: 'grammar' })

  const d = buildDel('alice@example.com', NOW - 60_000)
  row({ name: 'del: a delete request within ±5 min', type: 'del', text: d, sig: await sign(account, d), expect: 'accept' })
  const late = buildDel('alice@example.com', NOW - 6 * 60_000)
  row({ name: 'del: a delete request 6 min old', type: 'del', text: late, sig: await sign(account, late), expect: 'reject', reason: 'expired' })
  row({ name: 'del: signed by a stranger', type: 'del', text: d, sig: await sign(stranger, d), expect: 'reject', reason: 'signature' })

  const c = buildCmp(await sha256b64u(bind1), 'K7Q3MZ2P')
  row({ name: 'cmp: completing this binding with the typed code', type: 'cmp', bindText: bind1, text: c, sig: await sign(account, c), expect: 'accept' })
  row({ name: 'cmp: for a different binding', type: 'cmp', bindText: bind1 + 'x', text: c, sig: await sign(account, c), expect: 'reject', reason: 'bind-mismatch' })
  for (const [code, why] of [
    ['k7q3mz2p', 'lowercase (the agent uppercases before signing)'],
    ['K7Q3MZ2L', 'contains L'], ['K7Q3MZ20', 'contains 0'], ['K7Q3MZ2I', 'contains I'],
    ['K7Q3MZ2', 'seven characters'], ['K7Q3MZ2PP', 'nine characters'], ['K7Q3 Z2P', 'a space'],
  ] as const) {
    const bad = buildCmp(await sha256b64u(bind1), code)
    row({ name: `cmp: a code refused — ${why}`, type: 'cmp', bindText: bind1, text: bad, sig: await sign(account, bad), expect: 'reject', reason: 'grammar' })
  }
}

// --- cns. — security §24's five attacks, and the grammar ---------------------------
{
  const phone = { devicePub: (await signer()).pub, consentPub: (await signer()).pub, accountPub: account.pub, kx: null, label: 'Phone', created, expires }
  const linkPayload = buildDev(phone)
  const otherPayload = buildDev({ ...phone, label: 'Tablet' }) // a different statement, same keys
  const tLink = await consentTranscript('dir', CHALLENGE, linkPayload)
  const link = buildConsent({ rp: 'bento', purpose: 'link', docId: null, transcript: tLink!, exp: NOW + 60_000 })
  const ctx = { rp: 'bento', audience: 'dir', challenge: CHALLENGE, payloadText: linkPayload, docId: null }
  const sLink = await sign(consent, link)
  row({ name: 'cns: link a device (account-scoped, audience dir)', type: 'cns', ...ctx, text: link, sig: sLink, expect: 'accept' })
  row({ name: 'cns: REPLAY — the challenge was already spent', type: 'cns', ...ctx, challengeSpent: true, text: link, sig: sLink, expect: 'reject', reason: 'replay' })
  row({ name: 'cns: RELAY — presented to a different audience', type: 'cns', ...ctx, audience: `room:${ROOM}`, text: link, sig: sLink, expect: 'reject', reason: 'transcript' })
  row({ name: 'cns: PAYLOAD SWAP — authorising a different statement', type: 'cns', ...ctx, payloadText: otherPayload, text: link, sig: sLink, expect: 'reject', reason: 'transcript' })
  row({ name: 'cns: EXPIRED', type: 'cns', ...ctx, now: NOW + 120_000, text: link, sig: sLink, expect: 'reject', reason: 'expired' })
  const longTtl = buildConsent({ rp: 'bento', purpose: 'link', docId: null, transcript: tLink!, exp: NOW + CONSENT_MAX_TTL_MS + 60_000 })
  row({ name: 'cns: valid for longer than 5 minutes', type: 'cns', ...ctx, text: longTtl, sig: await sign(consent, longTtl), expect: 'reject', reason: 'lifetime' })
  row({ name: 'cns: signed by the routine device key, not the consent key', type: 'cns', ...ctx, text: link, sig: await sign(device, link), expect: 'reject', reason: 'signature' })
  row({ name: 'cns: for another relying party', type: 'cns', ...ctx, rp: 'vault-acme', text: link, sig: sLink, expect: 'reject', reason: 'rp' })
  // the transcript genuinely covers this inv. payload, so ONLY the family rule can refuse it
  const invForLink = 'inv.' + account.pub + '.writer.0'
  const tMismatch = await consentTranscript('dir', CHALLENGE, invForLink)
  const linkOverInv = buildConsent({ rp: 'bento', purpose: 'link', docId: null, transcript: tMismatch!, exp: NOW + 60_000 })
  row({ name: 'cns: purpose "link" over an inv. payload', type: 'cns', ...ctx, payloadText: invForLink, text: linkOverInv, sig: await sign(consent, linkOverInv), expect: 'reject', reason: 'payload-family' })
  const withDoc = buildConsent({ rp: 'bento', purpose: 'link', docId: 'doc-1', transcript: tLink!, exp: NOW + 60_000 })
  row({ name: 'cns: an account-scoped purpose carrying a docId', type: 'cns', ...ctx, text: withDoc, sig: await sign(consent, withDoc), expect: 'reject', reason: 'docid' })
  const grant = link.replace('.link.', '.grant.')
  row({ name: 'cns: a reserved purpose (grant, phase 2)', type: 'cns', ...ctx, text: grant, sig: await sign(consent, grant), expect: 'reject', reason: 'reserved-purpose' })
  const dotted = link.replace('cns.bento.', 'cns.bento.page.')
  row({ name: 'cns: a dotted rp ("bento.page") breaks the field count', type: 'cns', ...ctx, text: dotted, sig: await sign(consent, dotted), expect: 'reject', reason: 'grammar' })

  // a document-scoped consent, audience = the room
  const invPayload = `inv.${(await signer()).pub}.writer.0`
  const tInv = await consentTranscript(`room:${ROOM}`, CHALLENGE, invPayload)
  const inv = buildConsent({ rp: 'bento', purpose: 'invite', docId: 'doc-abc_123', transcript: tInv!, exp: NOW + 60_000 })
  const ictx = { rp: 'bento', audience: `room:${ROOM}`, challenge: CHALLENGE, payloadText: invPayload, docId: 'doc-abc_123' }
  const sInv = await sign(consent, inv)
  row({ name: 'cns: invite (document-scoped, audience room)', type: 'cns', ...ictx, text: inv, sig: sInv, expect: 'accept' })
  row({ name: 'cns: DOCID SWAP — applied to another document', type: 'cns', ...ictx, docId: 'doc-other', text: inv, sig: sInv, expect: 'reject', reason: 'docid' })
  const noDoc = buildConsent({ rp: 'bento', purpose: 'invite', docId: null, transcript: tInv!, exp: NOW + 60_000 })
  row({ name: 'cns: a document-scoped purpose with no docId', type: 'cns', ...ictx, text: noDoc, sig: await sign(consent, noDoc), expect: 'reject', reason: 'docid' })
}

// --- dreq. — account-signed requests the directory verifies ----------------------
// Their own sections, so a host runner that dispatches `statements` rows by type
// meets nothing it does not know; each host adopts these in its own change.
const dreqRows: Record<string, unknown>[] = []
const rotRows: Record<string, unknown>[] = []
const dreqConsentRows: Record<string, unknown>[] = []
{
  const newAccount = await signer()
  const live = bind1, liveHash = await sha256b64u(bind1)
  const bindBase = { address: 'alice@example.com', accountPub: newAccount.pub, kx: null, name: 'Alice', seq: 2, prev: liveHash, created, expires }
  const pendingBind = buildBind(bindBase)
  const bytes = (n: number, k: number) => new Uint8Array(n).map((_, i) => (i * k + 5) & 0xff)
  const te = new TextEncoder()
  // stand-ins for the WebAuthn registration bytes: the arg hashes the exact bytes, whatever they hold
  const attestationObject = Uint8Array.of(0xa3, ...te.encode('fmt'), ...bytes(60, 7))
  const clientDataJSON = te.encode('{"type":"webauthn.create","challenge":"' + CHALLENGE + '","origin":"https://id.bento.page"}')
  const credentialId = bytes(32, 13)
  const enrolBody = bytes(80, 17)
  const subjects: Record<DreqOp, DreqSubject> = {
    contest: { op: 'contest', pendingBindText: pendingBind },
    freeze: { op: 'freeze' },
    status: { op: 'status' },
    'cred-add': { op: 'cred-add', attestationObject, clientDataJSON },
    'cred-del': { op: 'cred-del', credentialId },
    'rc-enrol': { op: 'rc-enrol', body: enrolBody },
  }
  /** a subject as JSON: bytes as base64url */
  const json = (x: DreqSubject) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v instanceof Uint8Array ? b64uEnc(v) : v]))
  const req = async (op: DreqOp, over: Partial<{ address: string; bindHash: string; challenge: string; arg: string }> = {}) =>
    buildDreq({ op, address: 'alice@example.com', bindHash: liveHash, challenge: CHALLENGE, arg: await dreqArg(subjects[op]), ...over })
  const push = async (name: string, state: string, subject: DreqSubject, text: string, sig: string, expect: 'accept' | 'reject',
    reason?: string, extra: Record<string, unknown> = {}) => {
    dreqRows.push({ name: `dreq: ${name}`, bindText: live, state, challenge: CHALLENGE, subject: json(subject),
      text, sig, expect, ...(reason ? { reason } : {}), ...extra })
  }
  const dr = async (name: string, op: DreqOp, state: string, text: string, by: KP, expect: 'accept' | 'reject', reason?: string,
    extra: Record<string, unknown> = {}) => push(name, state, subjects[op], text, await sign(by, text), expect, reason, extra)

  // every op, in a state that allows it
  await dr('contest a pending rotation (signed by the OLD key, which the directory still serves)', 'contest', 'pending', await req('contest'), account, 'accept')
  await dr('freeze (lost or stolen)', 'freeze', 'active', await req('freeze'), account, 'accept')
  await dr('freeze during a pending rotation', 'freeze', 'pending', await req('freeze'), account, 'accept')
  await dr('status read', 'status', 'active', await req('status'), account, 'accept')
  await dr('status read while frozen', 'status', 'frozen', await req('status'), account, 'accept')
  await dr('status read during a pending rotation', 'status', 'pending', await req('status'), account, 'accept')
  await dr('cred-add over the exact registration bytes', 'cred-add', 'active', await req('cred-add'), account, 'accept')
  await dr('cred-del', 'cred-del', 'active', await req('cred-del'), account, 'accept')
  await dr('rc-enrol over the exact enrolment body', 'rc-enrol', 'active', await req('rc-enrol'), account, 'accept')

  // the challenge
  const freeze = await req('freeze')
  await dr('REPLAY — the challenge was already spent', 'freeze', 'active', freeze, account, 'reject', 'replay', { challengeSpent: true })
  await dr('a challenge the directory did not issue to this session', 'freeze', 'active',
    await req('freeze', { challenge: b64uEnc(bytes(24, 29)) }), account, 'reject', 'challenge')
  await dr('a challenge under 16 bytes', 'freeze', 'active', await req('freeze', { challenge: b64uEnc(bytes(8, 3)) }), account, 'reject', 'grammar')
  await dr('a padded challenge', 'freeze', 'active', await req('freeze', { challenge: CHALLENGE + '=' }), account, 'reject', 'grammar')
  // op, endpoint and state
  const status = await req('status')
  await push('OP SWAP — a status request presented to the freeze endpoint', 'active', subjects.freeze, status, await sign(account, status), 'reject', 'op')
  await dr('an op outside the closed set', 'freeze', 'active', freeze.replace('dreq.freeze.', 'dreq.unfreeze.'), account, 'reject', 'grammar')
  await dr('a freeze while frozen (only status is accepted)', 'freeze', 'frozen', freeze, account, 'reject', 'state')
  await dr('a contest while frozen', 'contest', 'frozen', await req('contest'), account, 'reject', 'state')
  await dr('a contest with nothing pending', 'contest', 'active', await req('contest'), account, 'reject', 'state')
  await dr('cred-add while frozen', 'cred-add', 'frozen', await req('cred-add'), account, 'reject', 'state')
  await dr('cred-add during a pending rotation', 'cred-add', 'pending', await req('cred-add'), account, 'reject', 'state')
  await dr('cred-del during a pending rotation', 'cred-del', 'pending', await req('cred-del'), account, 'reject', 'state')
  await dr('rc-enrol during a pending rotation', 'rc-enrol', 'pending', await req('rc-enrol'), account, 'reject', 'state')
  // the arg: exact per op
  await dr('a freeze carrying an arg', 'freeze', 'active', await req('freeze', { arg: liveHash }), account, 'reject', 'grammar')
  await dr('a status read carrying an arg', 'status', 'active', await req('status', { arg: liveHash }), account, 'reject', 'grammar')
  await dr('a contest with an empty arg', 'contest', 'pending', await req('contest', { arg: '' }), account, 'reject', 'grammar')
  await dr('a cred-add arg that is not a SHA-256', 'cred-add', 'active', await req('cred-add', { arg: b64uEnc(bytes(16, 3)) }), account, 'reject', 'grammar')
  await dr('cred-add over the credentialId alone (the key under it could be swapped)', 'cred-add', 'active',
    await req('cred-add', { arg: await dreqArg({ op: 'cred-del', credentialId }) }), account, 'reject', 'arg')
  const credAdd = await req('cred-add'), sCredAdd = await sign(account, credAdd)
  const swappedAtt = Uint8Array.from(attestationObject); swappedAtt[20] ^= 0x01
  await push('cred-add whose attestationObject was changed in transit', 'active', { op: 'cred-add', attestationObject: swappedAtt, clientDataJSON },
    credAdd, sCredAdd, 'reject', 'arg')
  const contest = await req('contest')
  await push('a contest naming a different pending binding', 'pending', { op: 'contest', pendingBindText: buildBind({ ...bindBase, name: 'Mallory' }) },
    contest, await sign(account, contest), 'reject', 'arg')
  const rcEnrol = await req('rc-enrol')
  await push('rc-enrol over a different enrolment body', 'active', { op: 'rc-enrol', body: bytes(80, 19) }, rcEnrol, await sign(account, rcEnrol), 'reject', 'arg')
  const credDel = await req('cred-del')
  await push('cred-del naming a different credential', 'active', { op: 'cred-del', credentialId: bytes(32, 11) }, credDel, await sign(account, credDel), 'reject', 'arg')
  // the binding and the signer
  await dr('signed by the PENDING key (a pending key signs no request)', 'contest', 'pending', contest, newAccount, 'reject', 'signature')
  await dr('naming the pending binding instead of the authoritative one', 'freeze', 'pending',
    await req('freeze', { bindHash: await sha256b64u(pendingBind) }), newAccount, 'reject', 'bind-mismatch')
  await dr('another address than the binding\'s', 'freeze', 'active', await req('freeze', { address: 'bob@example.com' }), account, 'reject', 'address')
  await dr('an address not in normal form', 'freeze', 'active', await req('freeze', { address: 'Alice@example.com' }), account, 'reject', 'address')
  await dr('a raw (unencoded) email breaks the field count', 'freeze', 'active',
    ['dreq', 'freeze', 'alice@example.com', liveHash, CHALLENGE, ''].join('.'), account, 'reject', 'grammar')
  await dr('signed by a stranger', 'freeze', 'active', freeze, stranger, 'reject', 'signature')
  const sFreeze = await sign(account, freeze)
  await push('high-S signature', 'active', subjects.freeze, freeze, highS(sFreeze), 'reject', 'signature')
  await push('DER signature (a host forgot to convert)', 'active', subjects.freeze, freeze, der(sFreeze), 'reject', 'signature')
  await push('an extra field', 'active', subjects.freeze, freeze + '.x', sFreeze, 'reject', 'grammar')
  await push('a field missing', 'active', subjects.freeze, freeze.slice(0, freeze.lastIndexOf('.')), sFreeze, 'reject', 'grammar')
  // every attempt that parses consumes its challenge, as for cns.
  for (const r of dreqRows) r.spendCalled = !(r.expect === 'reject' && r.reason === 'grammar')

  // --- rot. — the OLD key vouching for a rotation (client-verifiable offline) -------
  const next = pendingBind, nextSig = await sign(newAccount, next), nextHash = await sha256b64u(next)
  const rot = buildRot(nextHash, liveHash), rotSig = await sign(account, rot)
  type RotIn = { prevBindText: string; nextBindText: string; nextSig: string; rotText: string; rotSig: string }
  const rr = (name: string, o: Partial<RotIn>, expect: 'accept' | 'reject', reason?: string) =>
    rotRows.push({ name: `rot: ${name}`, prevBindText: live, nextBindText: next, nextSig, rotText: rot, rotSig, ...o, expect, ...(reason ? { reason } : {}) })
  /** a successor `b` of the live binding, fully and correctly vouched for */
  const vouched = async (b: string, prevText = live): Promise<Partial<RotIn>> => {
    const r = buildRot(await sha256b64u(b), await sha256b64u(prevText))
    return { prevBindText: prevText, nextBindText: b, nextSig: await sign(newAccount, b), rotText: r, rotSig: await sign(account, r) }
  }
  rr('a rotation vouched for by the old key', {}, 'accept')
  // the pinned binding may have expired by the time a client walks the chain
  const oldPinned = buildBind({ address: 'alice@example.com', accountPub: account.pub, kx: null, name: 'Alice', seq: 1, prev: null, created: NOW - 400 * DAY, expires: NOW - DAY })
  rr('the pinned binding has since expired (it was checked when it was pinned)', await vouched(buildBind({ ...bindBase, prev: await sha256b64u(oldPinned) }), oldPinned), 'accept')
  const swapped = buildRot(liveHash, nextHash)
  rr('SWAPPED HASHES', { rotText: swapped, rotSig: await sign(account, swapped) }, 'reject', 'rot-mismatch')
  rr('rot. SIGNED BY THE NEW KEY', { rotSig: await sign(newAccount, rot) }, 'reject', 'rot-signature')
  const rotB = buildRot(await sha256b64u(buildBind({ ...bindBase, name: 'Alicia' })), liveHash)
  rr('rot. OVER A DIFFERENT NEXT binding', { rotText: rotB, rotSig: await sign(account, rotB) }, 'reject', 'rot-mismatch')
  rr('SEQ SKIP (seq 1 → 3)', await vouched(buildBind({ ...bindBase, seq: 3 })), 'reject', 'seq')
  rr('ADDRESS CHANGE', await vouched(buildBind({ ...bindBase, address: 'bob@example.com' })), 'reject', 'address')
  rr('next.prev is not the hash of the pinned binding', await vouched(buildBind({ ...bindBase, prev: await sha256b64u(live + 'x') })), 'reject', 'chain')
  rr('the next binding is not self-signed (signed by the old key)', { nextSig: await sign(account, next) }, 'reject', 'next-signature')
  rr('the next binding has expired', await vouched(buildBind({ ...bindBase, created: NOW - 300 * DAY, expires: NOW - DAY })), 'reject', 'next-expired')
  rr('the old key signing the bare next bind. bytes is NOT a vouch', { rotText: next, rotSig: await sign(account, next) }, 'reject', 'rot-grammar')
  rr('rot. with an extra field', { rotText: rot + '.x', rotSig: await sign(account, rot + '.x') }, 'reject', 'rot-grammar')
  rr('rot. with a high-S signature', { rotSig: highS(rotSig) }, 'reject', 'rot-signature')
  rr('a pinned binding that does not parse', { prevBindText: live + '.x' }, 'reject', 'prev')

  // --- cns. for the three dreq. ops that change who can recover the account ---------
  const ctx = { rp: 'bento', audience: 'dir', challenge: CHALLENGE, docId: null }
  const cn = async (name: string, purpose: string, payloadText: string, expect: 'accept' | 'reject', reason?: string, docId: string | null = null) => {
    const t = buildConsent({ rp: 'bento', purpose: purpose as never, docId, transcript: (await consentTranscript('dir', CHALLENGE, payloadText))!, exp: NOW + 60_000 })
    dreqConsentRows.push({ name: `cns: ${name}`, type: 'cns', ...ctx, payloadText, text: t, sig: await sign(consent, t), expect, ...(reason ? { reason } : {}) })
  }
  await cn('cred-add consents to a dreq.cred-add', 'cred-add', credAdd, 'accept')
  await cn('cred-del consents to a dreq.cred-del', 'cred-del', credDel, 'accept')
  await cn('rc-enrol consents to a dreq.rc-enrol', 'rc-enrol', rcEnrol, 'accept')
  await cn('purpose cred-add over a dreq.cred-del (one consent never authorises another op)', 'cred-add', credDel, 'reject', 'payload-family')
  await cn('purpose cred-del over a dreq.cred-add', 'cred-del', credAdd, 'reject', 'payload-family')
  await cn('purpose rc-enrol over a dreq.cred-add', 'rc-enrol', credAdd, 'reject', 'payload-family')
  await cn('purpose cred-add over a dreq.freeze', 'cred-add', freeze, 'reject', 'payload-family')
  await cn('purpose rotate over a dreq.cred-add', 'rotate', credAdd, 'reject', 'payload-family')
  await cn('a bare "dreq" purpose is not in the set', 'dreq', credAdd, 'reject', 'grammar')
  await cn('cred-add carrying a docId (account-scoped)', 'cred-add', credAdd, 'reject', 'docid', 'doc-1')
  // every row parses as a cns., so every one consumes its challenge (an unknown purpose is checked after the spend)
  for (const r of dreqConsentRows) r.spendCalled = true
}

// --- derivations ------------------------------------------------------------------
const transcripts = []
for (const [audience, payload] of [['dir', 'dev.example'], [`room:${ROOM}`, 'inv.example']] as const) {
  transcripts.push({ audience, challenge: CHALLENGE, payload, transcript: await consentTranscript(audience, CHALLENGE, payload) })
}
transcripts.push({ audience: 'id.bento.page', challenge: CHALLENGE, payload: 'x', transcript: null, note: 'a dotted audience is refused' })
transcripts.push({ audience: 'dir', challenge: b64uEnc(new Uint8Array(8)), payload: 'x', transcript: null, note: 'a challenge under 16 bytes is refused' })
transcripts.push({ audience: 'dir', challenge: CHALLENGE + '=', payload: 'x', transcript: null, note: 'a padded challenge is refused' })

const sampleCns = rows.find((r) => r.type === 'cns' && r.expect === 'accept')!.text as string
const webauthn = [{ cns: sampleCns, challenge: await webauthnChallengeFor(sampleCns) }]

const lowSPairs = []
for (let i = 0; i < 3; i++) {
  const t = `dev.lows.${i}`
  const s = await sign(account, t)
  lowSPairs.push({ high: highS(s), low: s })
}
// lowS() must be the identity on a low-S input and must fold a high-S one
for (const p of lowSPairs) if (b64uEnc(lowS(dec(p.high))) !== p.low) throw new Error('lowS fold mismatch')

// --- routine sign purposes (identity.ts SignPurpose) --------------------------------
const iv = b64uEnc(new Uint8Array(12).fill(1)), ct = b64uEnc(new Uint8Array(40).fill(2))
const purposes = [
  { purpose: 'frame', payload: `${iv}.${ct}`, match: true },
  { purpose: 'frame', payload: `${iv}.${ct}.x`, match: false },
  { purpose: 'frame', payload: `rev.${account.pub}`, match: false },
  { purpose: 'prove', payload: `prove.${CHALLENGE}.${ROOM}`, match: true },
  { purpose: 'prove', payload: `prove.short.${ROOM}`, match: false },
  { purpose: 'delegate', payload: `dlg.${device.pub}`, match: true },
  { purpose: 'show', payload: 'live', match: true },
  { purpose: 'show', payload: 'end', match: true },
  { purpose: 'show', payload: `nav.aud.${iv}.${ct}`, match: true },
  { purpose: 'show', payload: `laser.aud.${iv}.${ct}`, match: false },
  { purpose: 'invite', payload: `inv.${device.pub}.writer.0`, match: true },
  { purpose: 'invite', payload: `inv.${device.pub}.owner.0`, match: false },
  { purpose: 'revoke', payload: `rev.${device.pub}`, match: true },
  { purpose: 'revoke', payload: `inv.${device.pub}.writer.0`, match: false, note: 'a revoke prompt can never sign an invite' },
  { purpose: 'frame', payload: `inv.${device.pub}.writer.0`, match: false, note: 'a routine frame can never sign an invite' },
]

// --- addresses (share's rows; ASCII-only phase 1) -------------------------------------
const L64 = 'a'.repeat(64), L65 = 'a'.repeat(65)
const addresses = [
  { input: 'Alice@Example.COM', address: 'alice@example.com' },
  { input: 'first.last+tag@gmail.com', address: 'first.last+tag@gmail.com', note: 'no provider folding' },
  { input: 'a@xn--bcher-kva.example', address: 'a@xn--bcher-kva.example', note: 'an ASCII xn-- domain, as typed' },
  { input: '  bob@example.org  ', address: 'bob@example.org', note: 'surrounding space is trimmed' },
  { input: `${L64}@example.com`, address: `${L64}@example.com` },
  { input: 'ü@x.de', reason: 'not-ascii' },
  { input: 'a@bü.de', reason: 'not-ascii' },
  { input: '"q"@x.com', reason: 'local-part', note: 'a quoted local part (the quote is printable ASCII, so it fails dot-atom)' },
  { input: 'a(c)@x.com', reason: 'local-part' },
  { input: 'a@[1.2.3.4]', reason: 'domain' },
  { input: 'a@1.2.3.4', reason: 'numeric-tld' },
  { input: 'a..b@x.com', reason: 'local-part' },
  { input: '.a@x.com', reason: 'local-part' },
  { input: 'a.@x.com', reason: 'local-part' },
  { input: 'a@x', reason: 'domain', note: 'a single label' },
  { input: 'a@-x.com', reason: 'domain' },
  { input: 'a@x-.com', reason: 'domain' },
  { input: `${L65}@example.com`, reason: 'too-long' },
  { input: `a@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.${'e'.repeat(61)}`, reason: 'too-long', note: '255 characters' },
  { input: 'a b@x.com', reason: 'not-ascii', note: 'an inner space' },
  { input: 'a@b@x.com', reason: 'at-sign' },
  { input: '@x.com', reason: 'at-sign' },
  { input: 'a@', reason: 'at-sign' },
]

// Every cns. attempt that gets past the grammar check must CONSUME its challenge,
// including one refused for rp, docId, transcript, expiry or signature — otherwise
// a refused attempt's challenge stays live to be retried. A verdict alone cannot
// show the order, so each row states whether the verifier must have called spend().
// (home-desktop found the gap: a late spend passed every row.)
for (const r of rows) if (r.type === 'cns') r.spendCalled = !(r.expect === 'reject' && r.reason === 'grammar')

const fixture = {
  version: 1,
  note: 'bento/id conformance vectors. TEST KEYS ONLY — never use them for anything real. ' +
    'Every host must reach the stated verdict on every row; the reason is informative. ' +
    'Generated by scripts/gen-identity-vectors.ts, checked by scripts/test-statements.ts.',
  now: NOW,
  kxModeDefault: 'unruled',
  keys: { account: account.pub, device: device.pub, consent: consent.pub, directory: directory.pub, kx, kx2 },
  directoryKeys,
  statements: rows,
  dreq: dreqRows,
  rot: rotRows,
  dreqConsent: dreqConsentRows,
  transcripts,
  webauthn,
  lowS: lowSPairs,
  purposes,
  addresses,
  // the frozen display-text refusal table: embed THIS, not your platform's \p{} tables
  displayForbidden: { unicode: DISPLAY_FORBIDDEN_UNICODE, ranges: DISPLAY_FORBIDDEN_RANGES.map(([a, b]) => [a, b]) },
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n')
console.log(`wrote ${OUT}: ${rows.length} statement rows, ${dreqRows.length} dreq, ${rotRows.length} rot, ${dreqConsentRows.length} dreq consent rows, ${addresses.length} address rows, ${purposes.length} purpose rows`)
