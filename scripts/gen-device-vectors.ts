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
// Every accepted row carries its tier, written by hand below.

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { b64uEnc, sha256b64u, signStatement } from '../kernel/src/statements.ts'
import { ROSTER_WEB_ORIGINS } from '../kernel/src/roster.ts'
import { buildDeviceCert, buildWatt, buildWren, type CertKind } from '../kernel/src/devices.ts'
import {
  ADDRESS, DIRECTORY_KEYS, H, K, NOW, RP, T, assertion, chainOf, ecdsa, highS, nonce, pubOf,
  type AssertOpts, type Link, type Spec,
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
const cite = (c: Link[], i: number) => ({ prevRos: c[i - 1].ros, ros: c[i].ros, rip: c[i].rip, ripSig: c[i].ripSig })

await chain('base', [S0, S1, S2, S3])
await chain('removed', [S0, S1, S2, S3, { members: [['pk', 'pk1'], ['rk', 'rk1'], ['ck', 'ck1']], req: T + 240 * H, rip: T + 240 * H, signer: 'pk2' }])
await chain('readded', [S0, S1, { members: [['pk', 'pk1']], req: T + 80 * H, rip: T + 152 * H, signer: 'pk1' },
  { members: [['pk', 'pk1'], ['pk', 'pk2']], req: T + 160 * H, rip: T + 232 * H, signer: 'pk1' }])
await chain('reset-same-key', [...B3, { members: [['pk', 'pk1']], req: T + 160 * H, rip: T + 232 * H, reset: true }])
await chain('quarantined', [...B3, QS])
await chain('undone', [...B3, QS, US])
await chain('pinned-l2', [S0, S1, S2, S3], 2)
await chain('fork', [S0, { ...S1, dirNonce: nonce(40) }])
// consent-key ripeness
const RM_CK: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 240 * H, rip: T + 312 * H, signer: 'pk1' }
const READD_CK: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1'], ['ck', 'ck1']], req: T + 320 * H, rip: T + 392 * H, signer: 'pk1' }
await chain('ck-readded', [S0, S1, S2, S3, RM_CK, READD_CK])
{
  const base = await chainOf([S0, S1, S2, S3])
  await chain('ck-quarantined', [S0, S1, S2, S3,
    { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1'], ['ck', 'ck1', 'q']], req: T + 300 * H, rip: T + 300 * H, auth: 'l', cited: cite(base, 3) }])
}
const PK2_LEAVES: Spec = { members: [['pk', 'pk1'], ['rk', 'rk1'], ['ck', 'ck1']], req: T + 240 * H, rip: T + 240 * H, signer: 'pk2' }
await chain('ck-exact', [S0, S1, S2, S3, PK2_LEAVES])
await chain('ck-pinned', [S0, S1, S2, S3, PK2_LEAVES], 4)

// --- certificates -------------------------------------------------------------------

type WattSpec = { loggedAt?: number; expires?: number; ob?: 0 | 1; kid?: string; by?: string; highS?: boolean; over?: string; raw?: string }
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
  watt?: WattSpec
}
type Proof = { cert: string; signer: string; assertion: Awaited<ReturnType<typeof assertion>>; watt: string; wattSig: string }

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
  const watt = w.raw ?? buildWatt({ certHash: await sha256b64u(w.over ?? cert), ob: w.ob ?? 1, loggedAt, expires: w.expires ?? loggedAt + 24 * H, kid: w.kid ?? 'dir-1' })
  let wattSig = await signStatement(K[w.by ?? 'dir1'].key, watt)
  if (w.highS) wattSig = highS(wattSig)
  return { cert, signer: pubOf(signer), assertion: await assertion(s.assert?.by ?? signer, cert, s.assert), watt, wattSig }
}

type Row = { name: string; about: string; chain: string; now?: number; proof: Proof; expect: 'accept' | 'reject'; reason?: string; tier?: 'passkey' | 'native' }
const rows: Row[] = []
const accept = async (name: string, about: string, s: CertSpec, tier: 'passkey' | 'native', now?: number) =>
  rows.push({ name, about, chain: s.chain, ...(now !== undefined ? { now } : {}), proof: await proof(s), expect: 'accept', tier })
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
await reject('watt/ob-not-a-bit', 'ob is 0 or 1', { chain: 'base', head: 3, ceremonyAt: C, watt: { raw: `watt.${'A'.repeat(43)}.2.${C}.${C + H}.dir-1` } }, 'watt-grammar')

// the certificate's grammar -------------------------------------------------------------------
await reject('wdev/via-cns', 'route D (a native consent co-signature, purpose web-add) is not defined yet', { chain: 'base', head: 3, ceremonyAt: C, via: 'cns' }, 'via')
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
await reject('dev2/via-ck', 'a dev2. signed by a consent key (the roster purpose is the next kernel change)', { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: C, via: 'ck' }, 'via')
await reject('dev2/consent-is-device-key', 'the consent key repeats the device key', { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: C, devicePub: K.ck1.pub }, 'consent-key')
await reject('dev2/kx-is-consent-key', 'the kx repeats the consent key', { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: C, kx: K.ck1.pub }, 'kx')

// the tier (G1) --------------------------------------------------------------------------------
// ck1 joined at L3 (T+232h). A dev2. made by pk1 for the device whose consent key is ck1.
const TC = T + 300 * H
await accept('tier/ck-ripe-exactly-72h', 'the consent key has been a member exactly 72 hours: native',
  { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: TC }, 'native', T + 304 * H)
await accept('tier/ck-72h-less-1s', '72 hours less one second: still (passkey sign-in)',
  { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: TC }, 'passkey', T + 304 * H - SEC)
await accept('tier/ck-readded', 'the consent key was removed and added again 18 hours ago: its age restarts, so (passkey sign-in)',
  { kind: 'dev2', chain: 'ck-readded', head: 5, ceremonyAt: T + 400 * H }, 'passkey', T + 410 * H)
await accept('tier/ck-quarantined', 'the consent key has been a member 168 hours but is quarantined (the lever reverted its addition)',
  { kind: 'dev2', chain: 'ck-quarantined', head: 4, ceremonyAt: T + 390 * H }, 'passkey', T + 400 * H)
await accept('tier/ck-exact', 'unpinned: the consent key joined 73 hours ago: native', { kind: 'dev2', chain: 'ck-exact', head: 4, ceremonyAt: T + 300 * H }, 'native', T + 305 * H)
await accept('tier/ck-from-pin', 'the same roster from a pin of the head after the consent key joined: its age is a lower bound (65 h), so (passkey sign-in)',
  { kind: 'dev2', chain: 'ck-pinned', head: 4, ceremonyAt: T + 300 * H }, 'passkey', T + 305 * H)
await accept('tier/no-consent-key', 'a dev2. with no consent key is (passkey sign-in)', { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: TC, consent: null }, 'passkey', T + 304 * H)
await accept('tier/consent-key-not-member', 'a dev2. whose consent key is not on the roster', { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: TC, consent: 'ck2' }, 'passkey', T + 304 * H)
await accept('tier/consent-key-is-a-passkey', 'a dev2. naming a roster PASSKEY as its consent key', { kind: 'dev2', chain: 'base', head: 3, ceremonyAt: TC, consent: 'pk2' }, 'passkey', T + 304 * H)
await accept('tier/wdev-never-native', 'a wdev. on a roster with a ripe consent key is still (passkey sign-in)', { chain: 'base', head: 3, ceremonyAt: TC }, 'passkey', T + 304 * H)

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

// ---------------------------------------------------------------------------------------------

const out = {
  version: 1,
  about: 'Conformance rows for bento/id option G device certificates (kernel/src/devices.ts): wdev. and dev2. certified by a passkey assertion, the directory\'s watt. countersign, the head rule and the tier (G1). For each row, verify chains[row.chain] with verifyRosterChain (roster-v2.json\'s rules) at now = row.now ?? now, then verifyDevice(row.proof, { roster, directoryKeys, rpId, origins, now }). Match the verdict, the reason where you can, and for accepted rows the tier. wren rows: verifyWren(text, sig). TEST KEYS ONLY.',
  rpId: RP,
  origins: [...ROSTER_WEB_ORIGINS],
  now: NOW,
  directoryKeys: DIRECTORY_KEYS,
  chains,
  rows,
  wren,
}

const SIGS = new Set(['ripSig', 'sig', 'signature', 'wattSig'])
const masked = (v: unknown) => JSON.stringify(v, (k, x) => (SIGS.has(k) ? '' : x))
const before = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
const keep = <T extends { name: string }>(fresh: T[], committed: T[] | undefined) => {
  const old = new Map((committed ?? []).map((r) => [r.name, r]))
  return fresh.map((r) => { const o = old.get(r.name); return o && masked(o) === masked(r) ? o : r })
}
for (const [n, c] of Object.entries(chains)) { const o = before?.chains?.[n]; if (o && masked(o) === masked(c)) chains[n] = o }
out.rows = keep(rows, before?.rows)
out.wren = keep(wren, before?.wren)
const text = JSON.stringify(out, null, 2) + '\n'
if (CHECK) {
  const same = before !== null && text === readFileSync(OUT, 'utf8')
  const changed = [...out.rows, ...out.wren].filter((r) => ![...(before?.rows ?? []), ...(before?.wren ?? [])].includes(r)).map((r) => r.name)
  console.log(same ? `${OUT} is current: ${rows.length} rows, ${wren.length} wren rows` : `${OUT} is stale: ${changed.length} rows new or changed${changed.length ? ` (${changed.join(', ')})` : ''}`)
  process.exit(same ? 0 : 1)
}
writeFileSync(OUT, text)
console.log(`wrote ${OUT}: ${rows.length} rows (${rows.filter((r) => r.expect === 'accept').length} accept), ${wren.length} wren rows`)
