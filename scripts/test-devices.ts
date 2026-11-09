#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id option G: the device certificates (kernel/src/devices.ts) against
// kernel/fixtures/device-v1.json.
//
//   node scripts/test-devices.ts   [DEVICE_FIXTURE=<file>]
//
// WHAT THIS PROVES. Every row's roster chain verifies (roster.ts), then every
// certificate reaches its stated verdict for its stated reason, and every
// accepted one its stated tier, which the generator writes by hand. The rows
// the contract depends on must EXIST. scripts/test-devices-mutants.ts proves
// each check in devices.ts is needed.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyRosterChain, ROSTER_PREFIXES, ROSTER_RP_ID, ROSTER_WEB_ORIGINS, type RosterLink } from '../kernel/src/roster.ts'
import {
  verifyDevice, verifyWren, parseDeviceCert, tierOf, buildDeviceCert, parseWatt, buildWatt,
  DEVICE_PREFIXES, WATT_MAX_MS, CEREMONY_CAP_MS, CK_RIPE_MS, MAX_LABEL, type DeviceProof,
} from '../kernel/src/devices.ts'
import { RESERVED_PREFIXES, LINK_PREFIXES } from '../kernel/src/statements.ts'

let failures = 0, checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const F = JSON.parse(readFileSync(process.env.DEVICE_FIXTURE || join(root, 'kernel/fixtures/device-v1.json'), 'utf8'))
type Chain = { links: RosterLink[]; pinned?: string }
type Row = { name: string; chain: string; now?: number; proof: DeviceProof; expect: 'accept' | 'reject'; reason?: string; tier?: string }
const rows: Row[] = F.rows
const H = 3_600_000

async function roster(chainName: string, now: number, extra: Record<string, unknown> = {}) {
  const c: Chain = F.chains[chainName]
  return verifyRosterChain(c.links, { directoryKeys: F.directoryKeys, rpId: F.rpId, origins: F.origins, now,
    ...(c.pinned !== undefined ? { pinned: c.pinned } : {}), ...extra })
}
async function run(r: Row, extra: Record<string, unknown> = {}, chainExtra: Record<string, unknown> = {}) {
  try {
    const now = (extra.now as number | undefined) ?? r.now ?? F.now
    const ro = await roster(r.chain, now, chainExtra)
    if (!ro.ok) return { ok: false as const, reason: `chain: ${ro.reason}` }
    return await verifyDevice(r.proof, { roster: ro.value, directoryKeys: F.directoryKeys, rpId: F.rpId, origins: F.origins, now, ...extra })
  } catch (e) { return { ok: false as const, reason: `threw: ${(e as Error).message}` } }
}

console.log(`fixture: rp id ${F.rpId}, origins ${JSON.stringify(F.origins)}, ${rows.length} rows, ${F.wren.length} wren rows`)
ok(F.rpId === ROSTER_RP_ID && JSON.stringify(F.origins) === JSON.stringify(ROSTER_WEB_ORIGINS), 'fixture names the pinned rp id and origin list')
ok(F.version === 1, 'fixture version 1')
ok(WATT_MAX_MS === 24 * H && CEREMONY_CAP_MS === 7 * 24 * H && CK_RIPE_MS === 72 * H && MAX_LABEL === 40, 'constants: watt. 24 h, cap 7 days from the ceremony, consent key ripe at 72 h, label 40')

console.log('\nevery chain a row names verifies')
for (const n of Object.keys(F.chains)) {
  const used = rows.filter((r) => r.chain === n)
  for (const now of new Set(used.map((r) => r.now ?? F.now))) {
    const v = await roster(n, now)
    ok(v.ok, `chain ${n} at ${now}${v.ok ? '' : `: ${v.reason}`}`)
  }
}

console.log('\nevery row reaches its verdict for its reason, and its tier')
for (const r of rows) {
  const v = await run(r)
  const got = v.ok ? 'accept' : `reject (${v.reason})`
  const want = r.expect === 'accept' ? 'accept' : `reject (${r.reason})`
  ok(got === want, `${r.name}: ${got}${got === want ? '' : `, want ${want}`}`)
  if (v.ok) ok(v.value.tier === r.tier, `${r.name}: tier ${r.tier}${v.value.tier === r.tier ? '' : `, got ${v.value.tier}`}`)
}

console.log('\nwren. (the directory\'s renewal request)')
for (const w of F.wren) {
  const v = await verifyWren(w.text, w.sig)
  const got = v.ok ? 'accept' : `reject (${v.reason})`
  const want = w.expect === 'accept' ? 'accept' : `reject (${w.reason})`
  ok(got === want, `${w.name}: ${got}${got === want ? '' : `, want ${want}`}`)
}

console.log('\nthe rows the contract depends on exist')
const byName = new Map(rows.map((r) => [r.name, r]))
const REQUIRED: Array<[string, string]> = [
  ['ok/wdev', 'passkey'], ['ok/wdev-older-head', 'passkey'], ['ok/wdev-signer-joined-at-head', 'passkey'], ['ok/watt-24h-exactly', 'passkey'],
  ['ok/watt-renewal-at-cap', 'passkey'], ['ok/undo-revives', 'passkey'], ['ok/pinned-head', 'passkey'], ['ok/readded-names-readd-head', 'passkey'],
  ['ok/after-reset', 'passkey'], ['ok/ceremony-at-head', 'passkey'], ['ok/wdev-label-40', 'passkey'],
  // the head rule (security's ruling on #925, item 5)
  ['head/signer-removed', 'signer-removed'], ['head/removed-and-readded', 'signer-break'], ['head/before-reset', 'signer-break'],
  ['head/signer-quarantined-now', 'signer-quarantined'], ['head/signer-quarantined-in-head', 'signer-quarantined'], ['head/fork', 'roster-head'],
  ['head/older-than-pin', 'roster-head'], ['head/signer-joined-after', 'signer'], ['head/ceremony-before-head', 'ceremony'],
  ['head/recovery-key-signer', 'signer-kind'], ['head/consent-key-signer', 'signer-kind'], ['head/other-address', 'address'], ['head/ceremony-future', 'not-yet-valid'],
  // the assertion
  ['assertion/other-text', 'assertion-challenge'], ['assertion/origin-library', 'assertion-origin'], ['assertion/rp-parent', 'assertion-rp'],
  ['assertion/uv-clear', 'assertion-uv'], ['assertion/other-key', 'assertion-signature'],
  // the watt.
  ['watt/past-cap', 'watt-cap'], ['watt/original-expired', 'expired'], ['watt/longer-than-24h', 'watt-lifetime'], ['watt/empty-life', 'watt-lifetime'],
  ['watt/logged-before-ceremony', 'watt-order'], ['watt/other-certificate', 'watt-mismatch'], ['watt/unknown-kid', 'watt-unknown-kid'],
  ['watt/wrong-key', 'watt-signature'], ['watt/other-pinned-kid', 'watt-signature'], ['watt/high-s', 'watt-signature'], ['watt/expired', 'expired'],
  ['watt/logged-in-future', 'not-yet-valid'], ['watt/ob-not-a-bit', 'watt-grammar'],
  // grammar
  ['wdev/via-cns', 'via'], ['wdev/via-unknown', 'grammar'], ['wdev/kx-is-device-key', 'kx'], ['wdev/label-41', 'label'], ['wdev/label-bidi', 'label'],
  ['wdev/address-not-normal', 'address'], ['wdev/extra-field', 'grammar'], ['wdev/nonce-short', 'grammar'],
  ['dev2/via-ck', 'via'], ['dev2/consent-is-device-key', 'consent-key'], ['dev2/kx-is-consent-key', 'kx'],
  // the tier (G1)
  ['tier/ck-ripe-exactly-72h', 'passkey'], ['tier/ck-exact', 'passkey'], ['tier/no-consent-key', 'passkey'], ['tier/consent-key-not-member', 'passkey'],
  ['tier/consent-key-is-a-passkey', 'passkey'], ['tier/wdev-never-native', 'passkey'],
  // security's rows from the review of #937 (F1 and the rest)
  ['sec/tier-consent-key-not-proven', 'passkey'], ['sec/tier-ck-absent-old-ceremony', 'passkey'], ['sec/renewal-past-original-cap', 'watt-cap'],
  ['sec/watt-logged-1s-before-ceremony', 'watt-order'], ['sec/head-from-fork-signer-current', 'roster-head'], ['sec/head-is-voided-request', 'roster-head'],
  ['sec/watt-expires-now', 'expired'],
]
for (const [n, want] of REQUIRED) {
  const r = byName.get(n)
  ok(!!r && (want === 'passkey' || want === 'native' ? r.expect === 'accept' && r.tier === want : r.expect === 'reject' && r.reason === want), `required row ${n} (${want})`)
}
ok(rows.filter((r) => r.expect === 'accept').every((r) => r.tier === 'passkey' || r.tier === 'native'), 'every accepted row states its tier')
const wrenNames = new Set(F.wren.map((w: { name: string }) => w.name))
ok(['ok/wren', 'wren/other-key', 'wren/high-s', 'wren/challenge-short', 'wren/address-not-normal'].every((n) => wrenNames.has(n)), 'the wren. rows exist')

console.log('\npositive controls: a refusal flips when only its cause changes')
{
  const old = byName.get('head/older-than-pin')!
  const placed = await (async () => {
    const ro = await verifyRosterChain(F.chains.base.links, { directoryKeys: F.directoryKeys, rpId: F.rpId, origins: F.origins, now: F.now })
    return ro.ok ? verifyDevice(old.proof, { roster: ro.value, directoryKeys: F.directoryKeys, rpId: F.rpId, origins: F.origins, now: F.now }) : ro
  })()
  ok(placed.ok, 'head/older-than-pin verifies once the verifier places L1 by verifying the same chain from setup (the pin is a trust floor, not a knowledge limit)')
  const lib = byName.get('assertion/origin-library')!
  ok((await run(lib, { origins: [...F.origins, 'https://home.bento.page'] })).ok, 'assertion/origin-library verifies once the caller lists https://home.bento.page (the closed list decides)')
  const exp = byName.get('watt/expired')!
  ok((await run(exp, { now: F.now - 1 })).ok, 'watt/expired verifies one millisecond earlier')
  // F1: the ripe ck in tier/ck-ripe-exactly-72h really is ripe, so its passkey tier is the rule, not the data
  const ripe = byName.get('tier/ck-ripe-exactly-72h')!
  const rr = await roster(ripe.chain, ripe.now!)
  const rc = await parseDeviceCert(ripe.proof.cert)
  const ck = rr.ok && rc.ok ? rr.value.members.find((m) => m.pub === rc.value.consentPub) : undefined
  ok(!!ck && ck.kind === 'ck' && !ck.quarantined && ripe.now! - ck.since === CK_RIPE_MS,
    'tier/ck-ripe-exactly-72h names an unquarantined ck member exactly 72 h old: the age alone does not promote it')
  const forged = byName.get('sec/tier-consent-key-not-proven')!
  const fc = await parseDeviceCert(forged.proof.cert)
  ok(fc.ok && rc.ok && fc.value.consentPub === rc.value.consentPub && fc.value.devicePub !== rc.value.devicePub,
    "sec/tier-consent-key-not-proven names the same ripe consent key for ANOTHER device key")
}

console.log('\ncaller parameters are required, never defaulted; junk is a refusal, not a throw')
{
  const r = byName.get('ok/wdev')!
  ok((await run(r)).ok, 'control: accepts with the fixture parameters')
  for (const [what, extra] of [['an empty origin list', { origins: [] }], ['an empty rp id', { rpId: '' }], ['a non-integer now', { now: Number.NaN }]] as const) {
    const ro = await roster(r.chain, F.now)
    const v = ro.ok ? await verifyDevice(r.proof, { roster: ro.value, directoryKeys: F.directoryKeys, rpId: F.rpId, origins: F.origins, now: F.now, ...extra } as never) : ro
    ok(!v.ok && v.reason === 'grammar', `${what} is refused as a caller error (grammar)`)
  }
  ok(!(await verifyDevice(null as never, {} as never)).ok, 'a missing proof is a refusal')
  const ro = await roster(r.chain, F.now)
  if (ro.ok) {
    const v = await verifyDevice({ ...r.proof, assertion: undefined } as never, { roster: ro.value, directoryKeys: F.directoryKeys, rpId: F.rpId, origins: F.origins, now: F.now })
    ok(!v.ok && v.reason === 'grammar', 'a proof without its assertion is grammar')
    const noDir = await verifyDevice(r.proof, { roster: ro.value, directoryKeys: {}, rpId: F.rpId, origins: F.origins, now: F.now })
    ok(!noDir.ok && noDir.reason === 'watt-unknown-kid', 'no pinned directory key: watt-unknown-kid')
  }
}

console.log('\nthe exported pieces hold on their own (the directory calls them without a roster)')
{
  const bad = byName.get('wdev/address-not-normal')!
  const p = await parseDeviceCert(bad.proof.cert)
  ok(!p.ok && p.reason === 'address', 'parseDeviceCert refuses an address not in normal form (address), before any roster compares it')
  const wd = await parseDeviceCert(byName.get('ok/wdev')!.proof.cert)
  const ck1 = await parseDeviceCert(byName.get('tier/ck-ripe-exactly-72h')!.proof.cert)
  if (wd.ok && ck1.ok) {
    ok(tierOf(ck1.value) === 'passkey', 'tierOf: a passkey-made dev2. naming a ripe consent key is (passkey sign-in)')
    ok(tierOf({ ...wd.value, consentPub: ck1.value.consentPub }) === 'passkey', 'tierOf: a wdev. is never native, even handed a ripe consent key')
  } else ok(false, 'tierOf inputs parse')
}

console.log('\nthe builders write the one spelling')
for (const r of rows.filter((x) => x.expect === 'accept')) {
  const c = await parseDeviceCert(r.proof.cert)
  const w = parseWatt(r.proof.watt)
  ok(c.ok && buildDeviceCert(c.value) === r.proof.cert && w.ok && buildWatt(w.value) === r.proof.watt, `${r.name}: parse → build round-trips the certificate and the watt.`)
}

console.log('\nthe roster gives every head it verified')
{
  const c: Chain = F.chains.base
  const v = await roster('base', F.now)
  const sha = async (t: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))).toString('base64url')
  ok(v.ok && v.value.heads.length === c.links.length, 'one head per link')
  if (v.ok) {
    let same = true
    for (let i = 0; i < c.links.length; i++) {
      const h = v.value.heads[i]
      if (h.hash !== (await sha(c.links[i].ros)) || h.ripenedAt !== Number(c.links[i].rip.split('.')[3]) || h.seq !== i) same = false
    }
    ok(same, 'each head: the hash of its ros. text, its seq and its ripenedAt, in chain order')
    ok(v.value.heads.at(-1)!.hash === v.value.headHash, 'the last head is the head')
  }
}

console.log('\nprefixes')
ok(DEVICE_PREFIXES.length === 4 && ['wdev', 'dev2', 'watt', 'wren'].every((p) => DEVICE_PREFIXES.includes(p)), 'devices.ts defines wdev. dev2. watt. wren.')
ok(DEVICE_PREFIXES.every((p) => RESERVED_PREFIXES.includes(p)), 'statements.ts still reserves them, so no other family takes them')
ok(DEVICE_PREFIXES.every((p) => !ROSTER_PREFIXES.includes(p) && !LINK_PREFIXES.includes(p)), 'no collision with ros. rip. or a link prefix')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
