#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Generates kernel/fixtures/device-v1.json: the conformance rows for bento/id
// option G's device certificates (kernel/src/devices.ts): wdev. and dev2.
// certified by a passkey assertion, the directory's watt. countersign, the head
// rule, and the tier (G1). wren. rows check the directory's renewal request.
//
//   node scripts/gen-device-vectors.ts [--out <file>] [--check]
//
// Keys are deterministic (scripts/lib/roster-build.ts, the same keys and
// chains as roster-v2.json); signatures are random, so an unchanged row keeps
// its committed bytes, and --check writes nothing and fails on a stale file.
// Every accepted row carries its tier, written by hand below, and the mb its
// watt. carries (from the spec, never parsed back).

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { b64uEnc, sha256b64u, signStatement } from '../kernel/src/statements.ts'
import { ROSTER_WEB_ORIGINS } from '../kernel/src/roster.ts'
import { buildDeviceCert, buildWatt, buildWren, buildWret, buildInc, type CertKind } from '../kernel/src/devices.ts'
import { linkKeysFromShared, linkTranscript, buildFinalG, type LinkOffer } from '../kernel/src/link.ts'
import {
  ADDRESS, CONSENT_RP, DIRECTORY_KEYS, H, K, NOW, RP, T, assertion, chainOf, cosign, ecdsa, highS, nonce, pubOf,
  type AssertOpts, type CnsOpts, type Link, type Spec,
} from './lib/roster-build.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outArg = process.argv.indexOf('--out')
const OUT = outArg > 0 ? process.argv[outArg + 1] : join(root, 'kernel/fixtures/device-v1.json')
const CHECK = process.argv.includes('--check')

const SEC = 1000, MIN = 60 * SEC, DAY = 24 * H

// device keys: the browser's or device's signing key, its kx, a second device
const W = await ecdsa('device/w1'), W2 = await ecdsa('device/w2'), KX = await ecdsa('device/kx1')

// --- the roster chains the rows name ----------------------------------------------
//
//   L0  T              setup {pk1}
//   L1  T+1h → +73h    pk1 adds pk2
//   L2  T+80h → +152h  pk2 adds rk1
//   L3  T+160h → 232h  rk1 adds ck1

const S0: Spec = { members: [['pk', 'pk1']], req: T, rip: T }
const S1: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2']], req: T + 1 * H, rip: T + 73 * H, signer: 'pk1' }
const S2: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 80 * H, rip: T + 152 * H, signer: 'pk2' }
const S3: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1'], ['ck', 'ck1']], req: T + 160 * H, rip: T + 232 * H, signer: 'rk1' }
const B3 = [S0, S1, S2]
const VOIDED = { members: [['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3'], ['rk', 'rk1']] as Spec['members'], signer: 'pk2' }
const QS: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['rk', 'rk1']], req: T + 160 * H, rip: T + 160 * H, auth: 'q', voided: VOIDED }
const US: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 170 * H, rip: T + 170 * H, auth: 'u' }

type Chain = { links: Link[]; pinned?: string }
const chains: Record<string, Chain> = {}
const ros: Record<string, string[]> = {}
async function chain(name: string, specs: Spec[], pinAt?: number) {
  const links = await chainOf(specs)
  ros[name] = links.map((l) => l.ros)
  chains[name] = pinAt === undefined ? { links } : { links: links.slice(pinAt), pinned: await sha256b64u(links[pinAt].ros) }
}

await chain('base', [S0, S1, S2, S3])
await chain('removed', [S0, S1, S2, S3, { members: [['pk', 'pk1'], ['rk', 'rk1'], ['ck', 'ck1']], req: T + 240 * H, rip: T + 240 * H, signer: 'pk2' }])
await chain('readded', [S0, S1, { members: [['pk', 'pk1']], req: T + 80 * H, rip: T + 152 * H, signer: 'pk1' },
  { members: [['pk', 'pk1'], ['pk', 'pk2']], req: T + 160 * H, rip: T + 232 * H, signer: 'pk1' }])
await chain('reset-same-key', [...B3, { members: [['pk', 'pk1']], req: T + 160 * H, rip: T + 232 * H, reset: true }])
await chain('quarantined', [...B3, QS])
await chain('undone', [...B3, QS, US])
await chain('pinned-l2', [S0, S1, S2, S3], 2)
await chain('fork', [S0, { ...S1, dirNonce: nonce(40) }])
// a consent key 73 hours a member (it never signs here: the tier stays passkey)
const PK2_LEAVES: Spec = { members: [['pk', 'pk1'], ['rk', 'rk1'], ['ck', 'ck1']], req: T + 240 * H, rip: T + 240 * H, signer: 'pk2' }
await chain('ck-exact', [S0, S1, S2, S3, PK2_LEAVES])
// consent keys that certify (KG3): ck1 removed and added again; ck1 quarantined; a pin past ck1's join
await chain('ck-readded', [S0, S1, S2, S3, { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 240 * H, rip: T + 312 * H, signer: 'pk1' },
  { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1'], ['ck', 'ck1']], req: T + 320 * H, rip: T + 392 * H, signer: 'pk1' }])
await chain('ck-quarantined', [S0, S1, S2, S3, { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1'], ['ck', 'ck1', 'q']], req: T + 240 * H, rip: T + 240 * H, auth: 'q',
  voided: { members: [['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3'], ['rk', 'rk1'], ['ck', 'ck1']], signer: 'ck1' } }])
await chain('ck-pinned', [S0, S1, S2, S3, PK2_LEAVES], 4)

// --- certificates -------------------------------------------------------------------

type WattSpec = { loggedAt?: number; expires?: number; ob?: 0 | 1; mb?: number; kid?: string; by?: string; highS?: boolean; over?: string; raw?: string }
interface CertSpec {
  kind?: CertKind
  chain: string
  head: number                        // index into the chain's ros texts (the full chain, pin or not)
  signer?: string                     // label
  ceremonyAt: number
  label?: string | null
  via?: string
  consent?: string | null             // label (dev2.)
  address?: string
  devicePub?: string
  kx?: string
  rosHash?: string
  rawCert?: string
  assert?: AssertOpts & { by?: string }
  cns?: CnsOpts                       // via cns / ck: the co-sign (honest by default)
  shape?: 'assertion' | 'consent' | 'both'   // which proof travels (default: the one via names)
  watt?: WattSpec
}
type Proof = { cert: string; signer: string; assertion?: Awaited<ReturnType<typeof assertion>>; consent?: { cns: string; sig: string }; watt: string; wattSig: string }

async function proof(s: CertSpec): Promise<Proof> {
  const kind = s.kind ?? 'wdev'
  const cert = s.rawCert ?? buildDeviceCert({
    kind, devicePub: s.devicePub ?? W.pub, consentPub: kind === 'dev2' ? (s.consent === null ? null : pubOf(s.consent ?? 'ck1')) : null,
    kx: s.kx ?? KX.pub, address: s.address ?? ADDRESS, rosHash: s.rosHash ?? await sha256b64u(ros[s.chain][s.head]),
    label: s.label === undefined ? 'Firefox on this Mac' : s.label, via: s.via ?? 'passkey', ceremonyAt: s.ceremonyAt, dirNonce: nonce(90),
  })
  const signer = s.signer ?? 'pk1'
  const w = s.watt ?? {}
  const loggedAt = w.loggedAt ?? s.ceremonyAt
  const watt = w.raw ?? buildWatt({ certHash: await sha256b64u(w.over ?? cert), ob: w.ob ?? 1, mb: w.mb ?? 0, loggedAt, expires: w.expires ?? loggedAt + 24 * H, kid: w.kid ?? 'dir-1' })
  let wattSig = await signStatement(K[w.by ?? 'dir1'].key, watt)
  if (w.highS) wattSig = highS(wattSig)
  const shape = s.shape ?? ((s.via ?? 'passkey') === 'passkey' ? 'assertion' : 'consent')
  const out: Proof = { cert, signer: pubOf(signer), watt, wattSig }
  if (shape !== 'consent') out.assertion = await assertion(s.assert?.by ?? signer, cert, s.assert)
  if (shape !== 'assertion') out.consent = await cosign(signer, cert, nonce(90), s.ceremonyAt, { purpose: kind === 'wdev' ? 'web-add' : 'roster', ...s.cns })
  return out
}

type Row = { name: string; about: string; chain: string; now?: number; proof: Proof; expect: 'accept' | 'reject'; reason?: string; tier?: 'passkey' | 'native'; mb?: number }
const rows: Row[] = []
// every accepted row carries the mb its watt. holds (written from the spec, never parsed back), so a port that
// drops or misreads mb fails a row instead of passing them all (security-ruling-949, host item 5)
const accept = async (name: string, about: string, s: CertSpec, tier: 'passkey' | 'native', now?: number) => {
  if (s.watt?.raw !== undefined) throw new Error(`${name}: an accepted row builds its watt.`)
  rows.push({ name, about, chain: s.chain, ...(now !== undefined ? { now } : {}), proof: await proof(s), expect: 'accept', tier, mb: s.watt?.mb ?? 0 })
}
const reject = async (name: string, about: string, s: CertSpec, reason: string, now?: number) =>
  rows.push({ name, about, chain: s.chain, ...(now !== undefined ? { now } : {}), proof: await proof(s), expect: 'reject', reason })

const C = NOW - 2 * H   // a ceremony two hours ago; the default watt. runs 24 h from it

// accepts ---------------------------------------------------------------------------------
await accept('ok/wdev', 'a browser key certified by pk1 naming the current head, with its first watt.', { chain: 'base', head: 3, ceremonyAt: C }, 'passkey')
await accept('ok/wdev-older-head', 'naming an earlier head the signer is still in with no break: later roster changes do not kill it',
  { chain: 'base', head: 1, ceremonyAt: C }, 'passkey')
await accept('ok/wdev-signer-joined-at-head', 'pk2 joined AT the head it names (its since equals that head\'s ripenedAt)', { chain: 'base', head: 1, signer: 'pk2', ceremonyAt: C }, 'passkey')
await accept('ok/wdev-no-label', 'the label is optional', { chain: 'base', head: 3, ceremonyAt: C, label: null }, 'passkey')
await accept('ok/wdev-label-40', 'a 40-character label', { chain: 'base', head: 3, ceremonyAt: C, label: 'x'.repeat(40) }, 'passkey')
await accept('ok/watt-24h-exactly', 'a watt. of exactly 24 hours', { chain: 'base', head: 3, ceremonyAt: C, watt: { loggedAt: C, expires: C + 24 * H } }, 'passkey')
await accept('ok/watt-ob-0', 'ob 0 (the request did not come from bento/home): informative only', { chain: 'base', head: 3, ceremonyAt: C, watt: { ob: 0 } }, 'passkey')
await accept('ok/watt-second-kid', 'countersigned by the second pinned directory key', { chain: 'base', head: 3, ceremonyAt: C, watt: { kid: 'dir-2', by: 'dir2' } }, 'passkey')
{
  // a renewal on day 6: a NEW watt. over the SAME wdev. text, reaching exactly to the 7-day cap
  const c6 = NOW - 6 * DAY - 12 * H
  await accept('ok/watt-renewal-at-cap', 'a renewal 6.5 days after the ceremony: a new watt. over the same certificate, expiring exactly 7 days after the ORIGINAL ceremony',
    { chain: 'base', head: 3, ceremonyAt: c6, watt: { loggedAt: NOW - 1 * H, expires: c6 + 7 * DAY } }, 'passkey')
  await reject('watt/past-cap', 'a renewal whose expiry reaches one millisecond past 7 days after the original ceremony',
    { chain: 'base', head: 3, ceremonyAt: c6, watt: { loggedAt: NOW - 1 * H, expires: c6 + 7 * DAY + 1 } }, 'watt-cap')
  await reject('watt/original-expired', 'the same certificate with only its ORIGINAL watt., long expired',
    { chain: 'base', head: 3, ceremonyAt: c6, watt: { loggedAt: c6, expires: c6 + 24 * H } }, 'expired')
}
await accept('ok/undo-revives', 'pk2 quarantined then undone: its certificate naming a head before the quarantine verifies again',
  { chain: 'undone', head: 1, signer: 'pk2', ceremonyAt: C }, 'passkey')
await accept('ok/pinned-head', 'from a pin of L2, a certificate naming L2 itself (since is the pin\'s ripenedAt)', { chain: 'pinned-l2', head: 2, ceremonyAt: C }, 'passkey')
await accept('ok/readded-names-readd-head', 'pk2 removed and added again: a certificate naming the head that re-added it', { chain: 'readded', head: 3, signer: 'pk2', ceremonyAt: C }, 'passkey')
await accept('ok/after-reset', 'a certificate naming the reset head, by the passkey the reset installed', { chain: 'reset-same-key', head: 3, ceremonyAt: C }, 'passkey')

// the head rule ------------------------------------------------------------------------------
await reject('head/signer-removed', 'pk2 removed itself after the head the certificate names', { chain: 'removed', head: 1, signer: 'pk2', ceremonyAt: C }, 'signer-removed')
await reject('head/removed-and-readded', 'pk2 removed and added again; the certificate names a head before the removal', { chain: 'readded', head: 1, signer: 'pk2', ceremonyAt: C }, 'signer-break')
await reject('head/before-reset', 'a reset installed pk1 again; the certificate names a head before the reset', { chain: 'reset-same-key', head: 1, ceremonyAt: C }, 'signer-break')
await reject('head/signer-quarantined-now', 'pk2 is quarantined in the current head', { chain: 'quarantined', head: 1, signer: 'pk2', ceremonyAt: C }, 'signer-quarantined')
await reject('head/signer-quarantined-in-head', 'pk2 was quarantined IN the head the certificate names, and is clear now', { chain: 'undone', head: 3, signer: 'pk2', ceremonyAt: C }, 'signer-quarantined')
await reject('head/fork', 'the certificate names a fork head (another genuine L1) the verified chain does not contain', { chain: 'base', head: 1, ceremonyAt: C,
  rosHash: await sha256b64u(ros['fork'][1]) }, 'roster-head')
await reject('head/older-than-pin', 'from a pin of L2, a certificate naming L1: unplaceable, the device makes a new ceremony', { chain: 'pinned-l2', head: 1, ceremonyAt: C }, 'roster-head')
await reject('head/signer-joined-after', 'pk2 is a member now but was not in the head named (L0)', { chain: 'base', head: 0, signer: 'pk2', ceremonyAt: C }, 'signer')
await reject('head/ceremony-before-head', 'ceremonyAt one millisecond before the named head ripened', { chain: 'base', head: 3, ceremonyAt: T + 232 * H - 1 }, 'ceremony', T + 240 * H)
await accept('ok/ceremony-at-head', 'ceremonyAt equal to the named head\'s ripenedAt', { chain: 'base', head: 3, ceremonyAt: T + 232 * H }, 'passkey', T + 240 * H)
await reject('head/recovery-key-signer', 'a recovery key as the signer (passkeys only)', { chain: 'base', head: 3, signer: 'rk1', ceremonyAt: C }, 'signer-kind')
await reject('head/consent-key-signer', 'a consent key as the signer (its purpose is the next kernel change)', { chain: 'base', head: 3, signer: 'ck1', ceremonyAt: C }, 'signer-kind')
await reject('head/signer-not-member', 'a passkey that was never a member', { chain: 'base', head: 3, signer: 'pk4', ceremonyAt: C }, 'signer')
await reject('head/other-address', 'the certificate names another address', { chain: 'base', head: 3, ceremonyAt: C, address: 'bob@example.com' }, 'address')
await reject('head/ceremony-future', 'ceremonyAt more than the skew allowance after now', { chain: 'base', head: 3, ceremonyAt: NOW + 6 * MIN, watt: { loggedAt: NOW + 6 * MIN } }, 'not-yet-valid')

// the assertion -------------------------------------------------------------------------------
await reject('assertion/other-text', 'the assertion covers another statement', { chain: 'base', head: 3, ceremonyAt: C, assert: { over: 'wdev.other' } }, 'assertion-challenge')
await reject('assertion/origin-library', 'asserted from https://home.bento.page (the library cannot use the passkeys)', { chain: 'base', head: 3, ceremonyAt: C, assert: { origin: 'https://home.bento.page' } }, 'assertion-origin')
await reject('assertion/rp-parent', 'asserted for the parent rp bento.page', { chain: 'base', head: 3, ceremonyAt: C, assert: { rpId: 'bento.page' } }, 'assertion-rp')
await reject('assertion/uv-clear', 'user verification flag clear', { chain: 'base', head: 3, ceremonyAt: C, assert: { flags: 0x01 } }, 'assertion-uv')
await reject('assertion/other-key', 'the assertion is by pk2 while pk1 is named', { chain: 'base', head: 3, ceremonyAt: C, assert: { by: 'pk2' } }, 'assertion-signature')

// the watt. -----------------------------------------------------------------------------------
await reject('watt/longer-than-24h', 'a watt. of 24 hours and one millisecond', { chain: 'base', head: 3, ceremonyAt: C, watt: { loggedAt: C, expires: C + 24 * H + 1 } }, 'watt-lifetime')
await reject('watt/empty-life', 'expires equal to loggedAt', { chain: 'base', head: 3, ceremonyAt: C, watt: { loggedAt: C, expires: C } }, 'watt-lifetime')
await reject('watt/logged-before-ceremony', 'loggedAt one millisecond before the ceremony (a forward-dated ceremonyAt would stretch the cap)',
  { chain: 'base', head: 3, ceremonyAt: C, watt: { loggedAt: C - 1, expires: C + 20 * H } }, 'watt-order')
await reject('watt/other-certificate', 'the watt. names another certificate\'s hash', { chain: 'base', head: 3, ceremonyAt: C, watt: { over: 'wdev.something.else' } }, 'watt-mismatch')
await reject('watt/unknown-kid', 'countersigned under a kid nobody pinned', { chain: 'base', head: 3, ceremonyAt: C, watt: { kid: 'dir-9', by: 'dirOther' } }, 'watt-unknown-kid')
await reject('watt/wrong-key', 'countersigned by another key under the pinned kid', { chain: 'base', head: 3, ceremonyAt: C, watt: { by: 'dirOther' } }, 'watt-signature')
await reject('watt/other-pinned-kid', 'signed by dir-2\'s key, naming kid dir-1: the kid picks the key', { chain: 'base', head: 3, ceremonyAt: C, watt: { by: 'dir2' } }, 'watt-signature')
await reject('watt/high-s', 'the countersign in high-S form', { chain: 'base', head: 3, ceremonyAt: C, watt: { highS: true } }, 'watt-signature')
await reject('watt/expired', 'now equals expires', { chain: 'base', head: 3, ceremonyAt: C, watt: { loggedAt: C, expires: NOW } }, 'expired')
await reject('watt/logged-in-future', 'loggedAt more than the skew allowance after now', { chain: 'base', head: 3, ceremonyAt: C, watt: { loggedAt: NOW + 6 * MIN, expires: NOW + 10 * H } }, 'not-yet-valid')
await reject('watt/ob-not-a-bit', 'ob is 0 or 1', { chain: 'base', head: 3, ceremonyAt: C, watt: { raw: `watt.${'A'.repeat(43)}.2.0.${C}.${C + H}.dir-1` } }, 'watt-grammar')
// mb: the mailbox state (org-identity §3a, shape (a))
await accept('ok/watt-mb-lapsed', 'the mailbox went unconfirmed a day before the watt.: the certificate stands, the address is qualified',
  { chain: 'base', head: 3, ceremonyAt: C, watt: { mb: C - 24 * H } }, 'passkey')
await accept('ok/watt-mb-at-logged', 'mb equal to loggedAt', { chain: 'base', head: 3, ceremonyAt: C, watt: { mb: C } }, 'passkey')
await reject('watt/mb-after-logged', 'mb one millisecond after loggedAt', { chain: 'base', head: 3, ceremonyAt: C, watt: { mb: C + 1 } }, 'watt-grammar')
await reject('watt/mb-leading-zero', 'mb is 0 or a canonical integer', { chain: 'base', head: 3, ceremonyAt: C, watt: { raw: `watt.${'A'.repeat(43)}.1.01.${C}.${C + H}.dir-1` } }, 'watt-grammar')
await reject('watt/mb-empty', 'mb is never empty', { chain: 'base', head: 3, ceremonyAt: C, watt: { raw: `watt.${'A'.repeat(43)}.1..${C}.${C + H}.dir-1` } }, 'watt-grammar')
await reject('watt/six-fields', 'the six-field watt. merged in #941 (no mb) is refused', { chain: 'base', head: 3, ceremonyAt: C, watt: { raw: `watt.${'A'.repeat(43)}.1.${C}.${C + H}.dir-1` } }, 'watt-grammar')

// the certificate's grammar -------------------------------------------------------------------
await reject('wdev/via-cns-with-assertion', 'via cns carries the co-sign, not a passkey assertion', { chain: 'base', head: 3, ceremonyAt: C, via: 'cns', signer: 'ck1', shape: 'assertion' }, 'proof')
await reject('wdev/via-unknown', 'via is passkey or cns', { chain: 'base', head: 3, ceremonyAt: C, via: 'pk' }, 'grammar')
await reject('wdev/kx-is-device-key', 'the kx repeats the device key', { chain: 'base', head: 3, ceremonyAt: C, kx: W.pub }, 'kx')
await reject('wdev/label-41', 'a 41-character label', { chain: 'base', head: 3, ceremonyAt: C, label: 'x'.repeat(41) }, 'label')
await reject('wdev/label-bidi', 'a label with a bidi override', { chain: 'base', head: 3, ceremonyAt: C, label: 'Safari‮evil' }, 'label')
await reject('wdev/address-not-normal', 'the address is in normal form', { chain: 'base', head: 3, ceremonyAt: C, address: 'Alice@Example.com' }, 'address')
{
  const ok = buildDeviceCert({ kind: 'wdev', devicePub: W.pub, consentPub: null, kx: KX.pub, address: ADDRESS, rosHash: await sha256b64u(ros.base[3]), label: null, via: 'passkey', ceremonyAt: C, dirNonce: nonce(90) })
  await reject('wdev/extra-field', 'an extra field', { chain: 'base', head: 3, ceremonyAt: C, rawCert: ok + '.x' }, 'grammar')
  await reject('wdev/nonce-short', 'the directory nonce is 16 to 64 bytes', { chain: 'base', head: 3, ceremonyAt: C,
    rawCert: ok.slice(0, ok.lastIndexOf('.') + 1) + b64uEnc(new Uint8Array(15)) }, 'grammar')
}
await reject('dev2/via-ck-with-assertion', 'via ck carries the co-sign, not a passkey assertion', { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: C, via: 'ck', signer: 'ck1', shape: 'assertion' }, 'proof')
await reject('dev2/consent-is-device-key', 'the consent key repeats the device key', { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: C, devicePub: K.ck1.pub }, 'consent-key')
await reject('dev2/kx-is-consent-key', 'the kx repeats the consent key', { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: C, kx: K.ck1.pub }, 'kx')

// the tier (G1) --------------------------------------------------------------------------------
// ck1 joined at L3 (T+232h). A dev2. made by pk1 for the device whose consent key is ck1. Every passkey-made
// certificate is (passkey sign-in): the consentPub is a claim until the consent key signs it (security's F1 on
// #937), so a ripe ck never promotes one by its age. The age rows (72 h, 72 h − 1 s, re-added, quarantined, from a
// pin) arrive with the consent key's own signature, in the change that defines it.
const TC = T + 300 * H
await accept('tier/ck-ripe-exactly-72h', 'the consent key has been a member exactly 72 hours, but it never signed: still (passkey sign-in)',
  { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: TC }, 'passkey', T + 304 * H)
await accept('tier/ck-exact', 'the consent key joined 73 hours ago, but never signed: (passkey sign-in)', { kind: 'dev2', chain: 'ck-exact', head: 4, ceremonyAt: T + 300 * H }, 'passkey', T + 305 * H)
await accept('tier/no-consent-key', 'a dev2. with no consent key is (passkey sign-in)', { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: TC, consent: null }, 'passkey', T + 304 * H)
await accept('tier/consent-key-not-member', 'a dev2. whose consent key is not on the roster', { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: TC, consent: 'ck2' }, 'passkey', T + 304 * H)
await accept('tier/consent-key-is-a-passkey', 'a dev2. naming a roster PASSKEY as its consent key', { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: TC, consent: 'pk2' }, 'passkey', T + 304 * H)
await accept('tier/wdev-never-native', 'a wdev. on a roster with a ripe consent key is still (passkey sign-in)', { chain: 'base', head: 3, ceremonyAt: TC }, 'passkey', T + 304 * H)

// --- security's rows (#937 review) ---------------------------------------------------------------
// F1: a page with ONE passkey prompt mints a dev2. for ITS OWN device key, naming the victim's ripe consent key
await accept('sec/tier-consent-key-not-proven', 'a passkey-made dev2. for another device key, naming a ripe consent key it never proved it holds: (passkey sign-in)',
  { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: TC, devicePub: W2.pub, label: 'attacker' }, 'passkey', T + 304 * H)
await accept('sec/tier-ck-absent-old-ceremony', 'consent key not on the roster, ceremony 100 h ago (a renewed watt.): (passkey sign-in)',
  { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: TC, consent: 'ck2', watt: { loggedAt: TC + 99 * H, expires: TC + 110 * H } }, 'passkey', TC + 100 * H)
await reject('sec/renewal-past-original-cap', 'a renewal logged 6.5 days after the ceremony running 24 h: past the original cap',
  { chain: 'base', head: 3, ceremonyAt: TC, watt: { loggedAt: TC + 156 * H, expires: TC + 180 * H } }, 'watt-cap', TC + 157 * H)
await reject('sec/watt-logged-1s-before-ceremony', 'a watt. logged one second before the ceremony',
  { chain: 'base', head: 3, ceremonyAt: C, watt: { loggedAt: C - 1000, expires: C + 20 * H } }, 'watt-order')
await reject('sec/head-from-fork-signer-current', 'the named head is the fork\'s L1 (pk2 is a member of both); not placeable',
  { chain: 'base', head: 1, rosHash: await sha256b64u(ros.fork[1]), signer: 'pk2', ceremonyAt: C }, 'roster-head')
await reject('sec/head-is-voided-request', 'the named head is the request the q link voided (pk1 is in it and current): not a head',
  { chain: 'quarantined', head: 3, rosHash: await sha256b64u(chains.quarantined.links[3].voided!.ros), ceremonyAt: C }, 'roster-head')
await reject('sec/watt-expires-now', 'now is exactly the watt.\'s expiry', { chain: 'base', head: 3, ceremonyAt: C, watt: { loggedAt: C, expires: C + 3 * H } }, 'expired', C + 3 * H)

// --- consent keys certify (KG3): dev2. via ck is native; wdev. via cns is route D --------------
// ck1 joined at L3 (T+232h): ripe from T+304h. The new device's own consent key is ck2 (a claim).
{
  const C2 = T + 310 * H, N2 = T + 312 * H, R4 = T + 304 * H
  const byCk = (more: Partial<CertSpec> = {}): CertSpec => ({ kind: 'dev2', chain: 'base', head: 3, ceremonyAt: C2, via: 'ck', signer: 'ck1', consent: 'ck2', ...more })
  const route = (more: Partial<CertSpec> = {}): CertSpec => ({ chain: 'base', head: 3, ceremonyAt: C2, via: 'cns', signer: 'ck1', ...more })
  await accept('ok/dev2-by-ck', 'a dev2. co-signed by a ripe consent key (purpose roster): native', byCk(), 'native', N2)
  await accept('tier/ck-signed-exactly-72h', 'the co-signing consent key is exactly 72 h a member at ceremonyAt: native', byCk({ ceremonyAt: R4 }), 'native', R4 + 2 * H)
  await reject('ck/unripe-one-second', 'the co-signing consent key is 72 h less one second a member at ceremonyAt', byCk({ ceremonyAt: R4 - 1000 }), 'signer-unripe', R4 + 2 * H)
  await reject('ck/readded-age-restarts', 'ck1 removed and added again: it names the re-add head, 10 h later, unripe', byCk({ chain: 'ck-readded', head: 5, ceremonyAt: T + 402 * H }), 'signer-unripe', T + 404 * H)
  await reject('ck/quarantined', 'ck1 is quarantined in the head it names', byCk({ chain: 'ck-quarantined', head: 4, ceremonyAt: T + 310 * H }), 'signer-quarantined', N2)
  await reject('ck/pinned-age-lower-bound', 'from a pin of L4 (T+240h) ck1 counts as a member since then: unripe at T+310h', byCk({ chain: 'ck-pinned', head: 4 }), 'signer-unripe', N2)
  await accept('ok/ck-pinned-ripe', 'from the same pin, 72 h after it: native', byCk({ chain: 'ck-pinned', head: 4, ceremonyAt: T + 312 * H }), 'native', T + 314 * H)
  await reject('ck/not-member', 'ck2 co-signs but is not on the roster', byCk({ signer: 'ck2', consent: null }), 'signer', N2)
  await reject('ck/passkey-signer', 'via ck, but the signer named is a passkey', byCk({ signer: 'pk1' }), 'signer-kind', N2)
  await reject('ck/both-proofs', 'a co-sign and an assertion: one proof only', byCk({ shape: 'both' }), 'proof', N2)
  await reject('passkey/with-consent', 'via passkey with a co-sign instead of the assertion', { chain: 'base', head: 3, ceremonyAt: C2, shape: 'consent' }, 'proof', N2)
  await reject('passkey/both-proofs', 'via passkey with an assertion and a co-sign', { chain: 'base', head: 3, ceremonyAt: C2, shape: 'both' }, 'proof', N2)
  await reject('ck/cns-other-text', 'the co-sign covers another certificate (for another device key)', byCk({ cns: { over: 'dev2.another' } }), 'consent-transcript', N2)
  await reject('ck/cns-purpose-web-add', 'a dev2. co-sign under purpose web-add', byCk({ cns: { purpose: 'web-add' } }), 'consent-purpose', N2)
  await reject('ck/cns-purpose-link', 'a dev2. co-sign under K2\'s purpose link', byCk({ cns: { purpose: 'link' } }), 'consent-purpose', N2)
  await reject('ck/cns-expired-at-ceremony', 'the co-sign expired at ceremonyAt', byCk({ cns: { exp: C2 } }), 'consent-expired', N2)
  await reject('ck/cns-long-life', 'the co-sign lives over 5 minutes plus the skew past ceremonyAt', byCk({ cns: { life: 10 * 60_000 + 1 } }), 'consent-lifetime', N2)
  await reject('ck/cns-other-challenge', 'the co-sign is bound to another challenge than the certificate\'s dirNonce', byCk({ cns: { challenge: nonce(91) } }), 'consent-transcript', N2)
  await reject('ck/cns-wrong-key', 'ck1 named, ck2 signed', byCk({ cns: { by: 'ck2' } }), 'consent-signature', N2)
  await reject('ck/cns-other-rp', 'the co-sign names another rp', byCk({ cns: { rp: 'vault-acme' } }), 'consent-rp', N2)
  // item 2 of org-identity §5.4: a native certificate still stands only beside a current 24 h watt.
  await reject('ck/native-watt-expired', 'a native dev2. whose watt. expired', byCk({ watt: { loggedAt: C2, expires: C2 + H } }), 'expired', C2 + H)
  await reject('ck/native-watt-over-24h', 'a native dev2. with a watt. of 24 h and one millisecond', byCk({ watt: { loggedAt: C2, expires: C2 + 24 * H + 1 } }), 'watt-lifetime', N2)
  await reject('ck/native-watt-past-cap', 'a native dev2. renewed past 7 days after its ceremony', byCk({ watt: { loggedAt: C2 + 160 * H, expires: C2 + 169 * H } }), 'watt-cap', C2 + 161 * H)
  // route D: a phone approves this browser
  await accept('ok/wdev-route-d', 'a wdev. co-signed by a ripe consent key (purpose web-add): still a browser, (passkey sign-in)', route(), 'passkey', N2)
  await reject('wdev/route-d-unripe', 'route D by a consent key 68 h a member', route({ ceremonyAt: T + 300 * H }), 'signer-unripe', N2)
  await reject('wdev/route-d-purpose-roster', 'a wdev. co-sign under purpose roster', route({ cns: { purpose: 'roster' } }), 'consent-purpose', N2)
  await reject('wdev/route-d-passkey-signer', 'via cns but a passkey named', route({ signer: 'pk1' }), 'signer-kind', N2)
}

// --- wren. (the directory's check) ----------------------------------------------------------
type WrenRow = { name: string; about: string; text: string; sig: string; expect: 'accept' | 'reject'; reason?: string }
const wren: WrenRow[] = []
{
  const text = buildWren({ devicePub: W.pub, address: ADDRESS, challenge: nonce(91) })
  wren.push({ name: 'ok/wren', about: 'the device key asks for a fresh watt.', text, sig: await signStatement(W.key, text), expect: 'accept' })
  wren.push({ name: 'wren/other-key', about: 'signed by another device key', text, sig: await signStatement(W2.key, text), expect: 'reject', reason: 'signature' })
  wren.push({ name: 'wren/high-s', about: 'the signature in high-S form', text, sig: highS(await signStatement(W.key, text)), expect: 'reject', reason: 'signature' })
  const short = buildWren({ devicePub: W.pub, address: ADDRESS, challenge: b64uEnc(new Uint8Array(15)) })
  wren.push({ name: 'wren/challenge-short', about: 'the challenge is 16 to 64 bytes', text: short, sig: await signStatement(W.key, short), expect: 'reject', reason: 'grammar' })
  const addr = buildWren({ devicePub: W.pub, address: 'Alice@Example.com', challenge: nonce(91) })
  wren.push({ name: 'wren/address-not-normal', about: 'the address is in normal form', text: addr, sig: await signStatement(W.key, addr), expect: 'reject', reason: 'address' })
}

// --- wret. (the directory's check at a new ceremony: the old key retires itself) -----------------
const wret: Array<WrenRow & { newPub?: string | null }> = []
{
  const text = buildWret({ oldPub: W.pub, newPub: W2.pub, address: ADDRESS, dirNonce: nonce(92) })
  wret.push({ name: 'ok/wret', about: 'the old browser key W retires itself in favour of W2 at the new ceremony', text, sig: await signStatement(W.key, text), expect: 'accept', newPub: W2.pub })
  wret.push({ name: 'wret/signed-by-new-key', about: 'signed by the NEW key: only the old key can retire itself', text, sig: await signStatement(W2.key, text), expect: 'reject', reason: 'signature' })
  wret.push({ name: 'wret/high-s', about: 'the signature in high-S form', text, sig: highS(await signStatement(W.key, text)), expect: 'reject', reason: 'signature' })
  const same = buildWret({ oldPub: W.pub, newPub: W.pub, address: ADDRESS, dirNonce: nonce(92) })
  wret.push({ name: 'wret/same-key', about: 'a key cannot retire itself in favour of itself', text: same, sig: await signStatement(W.key, same), expect: 'reject', reason: 'key' })
  const short = buildWret({ oldPub: W.pub, newPub: W2.pub, address: ADDRESS, dirNonce: b64uEnc(new Uint8Array(15)) })
  wret.push({ name: 'wret/nonce-short', about: 'the directory nonce is 16 to 64 bytes', text: short, sig: await signStatement(W.key, short), expect: 'reject', reason: 'grammar' })
  const addr = buildWret({ oldPub: W.pub, newPub: W2.pub, address: 'Alice@Example.com', dirNonce: nonce(92) })
  wret.push({ name: 'wret/address-not-normal', about: 'the address is in normal form', text: addr, sig: await signStatement(W.key, addr), expect: 'reject', reason: 'address' })
  // R2: a retirement without a successor (newPub empty), over a challenge the directory issued for it
  const alone = buildWret({ oldPub: W.pub, newPub: null, address: ADDRESS, dirNonce: nonce(95) })
  wret.push({ name: 'ok/wret-no-successor', about: 'W retires itself with no new key (the library is dropping it): no ceremony, no passkey', text: alone, sig: await signStatement(W.key, alone), expect: 'accept', newPub: null })
  wret.push({ name: 'wret/no-successor-other-key', about: 'a retirement without a successor, signed by another key', text: alone, sig: await signStatement(W2.key, alone), expect: 'reject', reason: 'signature' })
  const aloneShort = buildWret({ oldPub: W.pub, newPub: null, address: ADDRESS, dirNonce: b64uEnc(new Uint8Array(15)) })
  wret.push({ name: 'wret/no-successor-nonce-short', about: 'without a successor the challenge is still 16 to 64 bytes', text: aloneShort, sig: await signStatement(W.key, aloneShort), expect: 'reject', reason: 'grammar' })
  const kxNew = buildWret({ oldPub: W.pub, newPub: 'A'.repeat(87), address: ADDRESS, dirNonce: nonce(92) })
  wret.push({ name: 'wret/new-not-a-key', about: 'a newPub that is not a P-256 point (only EMPTY means no successor)', text: kxNew, sig: await signStatement(W.key, kxNew), expect: 'reject', reason: 'key' })
  const noOld = `wret..${W2.pub}.${b64uEnc(new TextEncoder().encode(ADDRESS))}.${nonce(92)}`
  wret.push({ name: 'wret/old-empty', about: 'the OLD key is never empty', text: noOld, sig: await signStatement(W.key, noOld), expect: 'reject', reason: 'key' })
  wret.push({ name: 'wret/as-wren', about: 'a wren. text is not a retirement', text: buildWren({ devicePub: W.pub, address: ADDRESS, challenge: nonce(92) }), sig: await signStatement(W.key, buildWren({ devicePub: W.pub, address: ADDRESS, challenge: nonce(92) })), expect: 'reject', reason: 'grammar' })
}

// --- inc. (the directory's incident record) ----------------------------------------------------
type IncRow = { name: string; about: string; text: string; sig: string; now?: number; expect: 'accept' | 'reject'; reason?: string; inside?: Array<[number, boolean]> }
const inc: IncRow[] = []
{
  const F0 = NOW - 48 * H, F1 = NOW - 24 * H
  const one = async (name: string, about: string, t: string, by = 'dir1', more: Partial<IncRow> = {}) =>
    inc.push({ name, about, text: t, sig: await signStatement(K[by].key, t), expect: more.reason ? 'reject' : 'accept', ...more })
  await one('ok/inc-closed', 'a closed window: from inclusive, to exclusive', buildInc({ id: '2027-03-incident-1', from: F0, to: F1, issuedAt: NOW - H, kid: 'dir-1' }), 'dir1',
    { inside: [[F0 - 1, false], [F0, true], [F1 - 1, true], [F1, false]] })
  await one('ok/inc-open', 'an open window (to empty): still going', buildInc({ id: 'open-1', from: F0, to: null, issuedAt: NOW - H, kid: 'dir-1' }), 'dir1',
    { inside: [[F0 - 1, false], [F0, true], [NOW + 1000 * H, true]] })
  await one('ok/inc-second-kid', 'signed by the second pinned key', buildInc({ id: 'k2', from: F0, to: F1, issuedAt: NOW - H, kid: 'dir-2' }), 'dir2')
  await one('inc/empty-window', 'to equal to from', buildInc({ id: 'x', from: F0, to: F0, issuedAt: NOW - H, kid: 'dir-1' }), 'dir1', { reason: 'grammar' })
  await one('inc/issued-before-from', 'issued before the window opens', buildInc({ id: 'x', from: F0, to: F1, issuedAt: F0 - 1, kid: 'dir-1' }), 'dir1', { reason: 'grammar' })
  await one('inc/id-upper', 'the id is [a-z0-9-]{1,64}', buildInc({ id: 'Incident', from: F0, to: F1, issuedAt: NOW - H, kid: 'dir-1' }), 'dir1', { reason: 'grammar' })
  await one('inc/future', 'issued more than the skew after now', buildInc({ id: 'x', from: F0, to: null, issuedAt: NOW + 6 * 60_000, kid: 'dir-1' }), 'dir1', { reason: 'not-yet-valid' })
  await one('inc/unknown-kid', 'a kid nobody pinned', buildInc({ id: 'x', from: F0, to: F1, issuedAt: NOW - H, kid: 'dir-9' }), 'dirOther', { reason: 'unknown-kid' })
  await one('inc/other-pinned-kid', 'dir-2\'s key, naming dir-1', buildInc({ id: 'x', from: F0, to: F1, issuedAt: NOW - H, kid: 'dir-1' }), 'dir2', { reason: 'signature' })
  await one('inc/extra-field', 'an extra field', buildInc({ id: 'x', from: F0, to: F1, issuedAt: NOW - H, kid: 'dir-1' }) + '.x', 'dir1', { reason: 'grammar' })
}

// --- reserved prefixes: refused as statements today (org-identity §5.4 item 4) ------------------
// Each text is shaped like a plausible statement under the reserved prefix; every verifier refuses it.
const reserved = ['mgd', 'vch', 'ojn', 'dvc'].map((prefix) => ({ prefix, text: `${prefix}.${b64uEnc(new TextEncoder().encode(ADDRESS))}.${'A'.repeat(43)}.${T}.${T + H}.dir-1` }))

// --- the link final under option G (link.ts lnkg): H's ripe ck co-signs N's dev2. --------------------
type FinalRow = { name: string; about: string; t: string; h2n: string; offer: LinkOffer; final: { dev2: string; ck: string; cns: string; cnsSig: string; seal: string } | null
  edit?: { line: number; value: string }; expect: 'accept' | 'reject'; reason?: string; watt?: string; wattSig?: string
  release?: { challenge: string; spent?: boolean; chain?: string; expect: 'accept' | 'reject'; reason?: string } }
const linkFinal: FinalRow[] = []
{
  const NDEV = await ecdsa('device/n1'), NCK = await ecdsa('device/nck'), NKX = await ecdsa('device/nkx')
  const enc = new TextEncoder()
  const shaB = async (l: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(l)))
  const eD = (await ecdsa('device/eD')).pub, eS = (await ecdsa('device/eS')).pub
  const t = (await linkTranscript(b64uEnc(await shaB('slot')), eD, eS, 'H'))!
  const keys = await linkKeysFromShared(await shaB('bento/id/test/link-g/z'), await shaB('bento/id/test/link-g/salt'), t)
  const otherKeys = await linkKeysFromShared(await shaB('bento/id/test/link-g/z2'), await shaB('bento/id/test/link-g/salt'), t)
  const IV = new Uint8Array(12).fill(7)
  const offer: LinkOffer = { devicePub: NDEV.pub, consentPub: NCK.pub, kx: NKX.pub, label: 'Pixel', platform: 'android' }
  const CG = T + 310 * H
  const head = await sha256b64u(ros.base[3])
  const dev2Of = (o: Partial<{ devicePub: string; consentPub: string | null; kx: string; via: string; rosHash: string; ceremonyAt: number }> = {}) => buildDeviceCert({ kind: 'dev2',
    devicePub: o.devicePub ?? NDEV.pub, consentPub: o.consentPub === undefined ? NCK.pub : o.consentPub, kx: o.kx ?? NKX.pub, address: ADDRESS, rosHash: o.rosHash ?? head,
    label: 'Pixel', via: o.via ?? 'ck', ceremonyAt: o.ceremonyAt ?? CG, dirNonce: nonce(93) })
  type G = { name: string; about: string; dev2?: string; ck?: string; by?: string; cns?: CnsOpts; keys?: typeof keys; edit?: (lines: string[]) => { line: number; value: string }; reason?: string
    release?: FinalRow['release']; watt?: boolean; offer?: LinkOffer }
  const g = async (x: G) => {
    const dev2 = x.dev2 ?? dev2Of()
    const ckLabel = x.by ?? 'ck1'
    const ck = x.ck ?? pubOf(ckLabel)
    const c = await cosign(ckLabel, dev2, nonce(93), Number(dev2.split('.')[8]), x.cns)
    const text = await buildFinalG({ dev2, ck, cns: c.cns, cnsSig: c.sig }, x.keys ?? keys, t, IV)
    const l = text.split('\n')
    const row: FinalRow = { name: x.name, about: x.about, t, h2n: b64uEnc(keys.h2n), offer: x.offer ?? offer, final: { dev2: l[1], ck: l[2], cns: l[3], cnsSig: l[4], seal: l[5] },
      expect: x.reason ? 'reject' : 'accept', ...(x.reason ? { reason: x.reason } : {}) }
    if (x.edit) row.edit = x.edit(l)
    if (x.release) row.release = x.release
    if (x.watt) { row.watt = buildWatt({ certHash: await sha256b64u(dev2), ob: 0, mb: 0, loggedAt: CG, expires: CG + 24 * H, kid: 'dir-1' }); row.wattSig = await signStatement(K.dir1.key, row.watt) }
    linkFinal.push(row)
  }
  await g({ name: 'ok/final-g', about: 'H\'s ripe ck1 co-signs N\'s dev2.: N opens it, and with the directory\'s watt. it verifies native', watt: true,
    release: { challenge: nonce(93), expect: 'accept' } })
  await g({ name: 'final-g/release-unripe', about: 'the directory refuses a co-sign by a consent key 68 h a member', dev2: dev2Of({ ceremonyAt: T + 300 * H }),
    release: { challenge: nonce(93), expect: 'reject', reason: 'signer-unripe' } })
  await g({ name: 'final-g/release-other-challenge', about: 'the dev2. names another challenge than the one the directory issued to H',
    release: { challenge: nonce(94), expect: 'reject', reason: 'challenge' } })
  await g({ name: 'final-g/release-spent', about: 'the challenge was already spent', release: { challenge: nonce(93), spent: true, expect: 'reject', reason: 'replay' } })
  await g({ name: 'final-g/release-old-head', about: 'the dev2. names a head other than the current one', dev2: dev2Of({ rosHash: await sha256b64u(ros.base[2]) }),
    release: { challenge: nonce(93), expect: 'reject', reason: 'roster-head' } })
  await g({ name: 'final-g/release-ck-not-member', about: 'ck2 co-signs; it is not on the roster', by: 'ck2', release: { challenge: nonce(93), expect: 'reject', reason: 'signer' } })
  // security-ruling-949 C3: the directory's release check, at the rules no other row reaches
  await g({ name: 'final-g/release-quarantined', about: 'ck1 was quarantined (its own request voided): the directory refuses to release its co-sign',
    dev2: dev2Of({ rosHash: await sha256b64u(ros['ck-quarantined'][4]) }), release: { challenge: nonce(93), chain: 'ck-quarantined', expect: 'reject', reason: 'signer-quarantined' } })
  {
    // pk1 signs the cns. with its own key: N opens it (N does not know the roster), the directory refuses the signer's kind
    await g({ name: 'final-g/release-by-passkey', about: 'the co-signer named is a passkey (pk1 signed the cns.): N opens it, the directory refuses it',
      ck: pubOf('pk1'), by: 'pk1', release: { challenge: nonce(93), expect: 'reject', reason: 'signer-kind' } })
  }
  await g({ name: 'final-g/release-exactly-72h', about: 'ck1 has been a member exactly 72 h at ceremonyAt: released (72 h inclusive)',
    dev2: dev2Of({ ceremonyAt: T + 304 * H }), release: { challenge: nonce(93), expect: 'accept' } })
  await g({ name: 'final-g/release-one-second-short', about: 'ck1 72 h less one second a member at ceremonyAt: refused',
    dev2: dev2Of({ ceremonyAt: T + 304 * H - 1000 }), release: { challenge: nonce(93), expect: 'reject', reason: 'signer-unripe' } })
  {
    // N offered ck1's key as its own consent key: the co-signer IS N's consent key, a roster ck, ripe; only ck-is-n refuses it
    const nOffer: LinkOffer = { ...offer, consentPub: pubOf('ck1') }
    await g({ name: 'final-g/release-ck-is-n', about: 'the co-signer is the consent key the dev2. names for N (a ripe ck1): refused at the directory too',
      dev2: dev2Of({ consentPub: pubOf('ck1') }), offer: nOffer, reason: 'ck-is-n', release: { challenge: nonce(93), expect: 'reject', reason: 'ck-is-n' } })
  }
  await g({ name: 'final-g/other-keys', about: 'sealed under another h2n (not the SAS-confirmed session)', keys: otherKeys, reason: 'decrypt' })
  await g({ name: 'final-g/line-swapped', about: 'the directory swaps the dev2. line for one naming another device key (seal no longer matches)',
    edit: (l) => ({ line: 1, value: l[1].replace(NDEV.pub, W.pub) }), reason: 'seal' })
  await g({ name: 'final-g/device-mismatch', about: 'H sealed honestly a dev2. for another device key', dev2: dev2Of({ devicePub: W.pub }), reason: 'device-mismatch' })
  await g({ name: 'final-g/consent-mismatch', about: 'the dev2. names another consent key than N offered', dev2: dev2Of({ consentPub: null }), reason: 'consent-mismatch' })
  await g({ name: 'final-g/kx-mismatch', about: 'the dev2. names another kx', dev2: dev2Of({ kx: KX.pub }), reason: 'kx-mismatch' })
  await g({ name: 'final-g/via-passkey', about: 'the dev2. says via passkey: the G final carries a co-sign', dev2: dev2Of({ via: 'passkey' }), reason: 'via' })
  await g({ name: 'final-g/ck-is-n', about: 'the co-signer is N\'s own consent key', ck: NCK.pub, by: 'ck1', reason: 'ck-is-n' })
  await g({ name: 'final-g/cns-web-add', about: 'the co-sign carries purpose web-add', cns: { purpose: 'web-add' }, reason: 'cns-purpose' })
  await g({ name: 'final-g/cns-wrong-key', about: 'ck1 named, ck2 signed', cns: { by: 'ck2' }, reason: 'cns-signature' })
  await g({ name: 'final-g/v1-label', about: 'the same lines under v1\'s lnk3 label', edit: () => ({ line: 0, value: 'lnk3' }), reason: 'grammar' })
  await g({ name: 'final-g/seal-long', about: 'a seal of 61 bytes', edit: () => ({ line: 5, value: b64uEnc(new Uint8Array(61)) }), reason: 'grammar' })
  await g({ name: 'final-g/extra-line', about: 'a seventh line', edit: () => ({ line: 6, value: 'x' }), reason: 'grammar' })
}

// ---------------------------------------------------------------------------------------------

const out = {
  version: 1,
  about: 'Conformance rows for bento/id option G device certificates (kernel/src/devices.ts): wdev. and dev2. certified by a passkey assertion, the directory\'s watt. countersign, the head rule and the tier (G1). For each row, verify chains[row.chain] with verifyRosterChain (roster-v2.json\'s rules) at now = row.now ?? now, then verifyDevice(row.proof, { roster, directoryKeys, rpId, origins, now }). Match the verdict, the reason where you can, and for accepted rows the tier. wren rows: verifyWren(text, sig). TEST KEYS ONLY.',
  rpId: RP,
  origins: [...ROSTER_WEB_ORIGINS],
  now: NOW,
  directoryKeys: DIRECTORY_KEYS,
  chains,
  // the rp a consent key's cns. names (DeviceOpts.consentRp)
  consentRp: CONSENT_RP,
  rows,
  wren,
  // wret rows: verifyWret(text, sig). inc rows: verifyInc(text, sig, { directoryKeys, now: row.now ?? now }); `inside` pairs are insideIncident(at, record)
  wret,
  inc,
  // every verifier refuses each: parseDeviceCert, parseWatt, verifyWren, verifyWret, verifyInc, parseRos, parseRip (and RESERVED_PREFIXES lists the prefix)
  reserved,
  // the link final under option G (link.ts): openFinalG(the lines lnkg, dev2, ck, cns, cnsSig, seal joined by \n, with `edit` applied: line i set to value, { keys: { h2n }, t, offer, consentRp }); release rows:
  // verifyLinkReleaseG(text, { roster: chains.base at now, challenge, spend: () => !spent, consentRp, now }); a `watt` row also passes verifyDevice as native
  linkFinal,
}

const SIGS = new Set(['ripSig', 'sig', 'signature', 'wattSig', 'cnsSig', 'seal'])
const masked = (v: unknown) => JSON.stringify(v, (k, x) => (SIGS.has(k) ? '' : x))
const before = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
const keep = <T extends { name: string }>(fresh: T[], committed: T[] | undefined) => {
  const old = new Map((committed ?? []).map((r) => [r.name, r]))
  return fresh.map((r) => {
    const o = old.get(r.name)
    if (!o) return r
    if (masked(o) === masked(r)) return o
    // a field added to every row (mb on the accepted rows) keeps the row's committed signatures
    const added = Object.fromEntries(Object.entries(r).filter(([k]) => !(k in o)))
    const grown = { ...o, ...added } as T
    return Object.keys(added).length && masked(grown) === masked(r) ? grown : r
  })
}
for (const [n, c] of Object.entries(chains)) { const o = before?.chains?.[n]; if (o && masked(o) === masked(c)) chains[n] = o }
out.rows = keep(rows, before?.rows)
out.wren = keep(wren, before?.wren)
out.wret = keep(wret, before?.wret)
out.inc = keep(inc, before?.inc)
out.linkFinal = keep(linkFinal, before?.linkFinal)
const text = JSON.stringify(out, null, 2) + '\n'
if (CHECK) {
  const same = before !== null && text === readFileSync(OUT, 'utf8')
  const all = [...out.rows, ...out.wren, ...out.wret, ...out.inc, ...out.linkFinal]
  const was = [...(before?.rows ?? []), ...(before?.wren ?? []), ...(before?.wret ?? []), ...(before?.inc ?? []), ...(before?.linkFinal ?? [])]
  const changed = all.filter((r) => !was.includes(r)).map((r) => r.name)
  console.log(same ? `${OUT} is current: ${rows.length} rows, ${wren.length} wren rows` : `${OUT} is stale: ${changed.length} rows new or changed${changed.length ? ` (${changed.join(', ')})` : ''}`)
  process.exit(same ? 0 : 1)
}
writeFileSync(OUT, text)
console.log(`wrote ${OUT}: ${rows.length} rows (${rows.filter((r) => r.expect === 'accept').length} accept), ${wren.length} wren rows`)
