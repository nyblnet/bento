#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id option G: the roster chain verifier (kernel/src/roster.ts) against
// kernel/fixtures/roster-v2.json.
//
//   node scripts/test-roster.ts   [ROSTER_FIXTURE=<file>]
//
// WHAT THIS PROVES. Every row reaches its stated verdict for its stated reason,
// and every accepted row yields its stated state (head, members with the time
// each joined, account creation, last reset), which the generator writes by
// hand, never by asking the verifier. The rows the contract depends on must
// EXIST, so deleting one cannot quietly shrink it. scripts/test-roster-mutants.ts
// proves each check in roster.ts is needed.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  verifyRosterChain, parseRos, buildRos, ROSTER_PREFIXES, ROSTER_RP_ID, ROSTER_WEB_ORIGINS, ROSTER_WAIT_MS,
  type RosterLink, type RosterHead,
} from '../kernel/src/roster.ts'
import { RESERVED_PREFIXES, LINK_PREFIXES, b64uEnc } from '../kernel/src/statements.ts'

let failures = 0, checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const F = JSON.parse(readFileSync(process.env.ROSTER_FIXTURE || join(root, 'kernel/fixtures/roster-v2.json'), 'utf8'))
type St = { seq: number; ripenedAt: number; members: Array<{ kind: string; key: string; quarantined: boolean; since: number }>; createdAt: number | null; lastResetAt: number | null; sinceExact: boolean }
type Row = { name: string; links: RosterLink[]; pinned?: string; expect: 'accept' | 'reject'; reason?: string; state?: St }
const rows: Row[] = F.rows
const opts = (r: Row, extra: Record<string, unknown> = {}) => ({ directoryKeys: F.directoryKeys, rpId: F.rpId, origins: F.origins, now: F.now,
  ...(r.pinned !== undefined ? { pinned: r.pinned } : {}), ...extra })
async function run(r: Row, extra: Record<string, unknown> = {}) {
  try { return await verifyRosterChain(r.links, opts(r, extra)) } catch (e) { return { ok: false as const, reason: `threw: ${(e as Error).message}` } }
}

console.log(`fixture: rp id ${F.rpId}, origins ${JSON.stringify(F.origins)}, ${rows.length} rows`)
ok(F.rpId === ROSTER_RP_ID && JSON.stringify(F.origins) === JSON.stringify(ROSTER_WEB_ORIGINS), 'fixture names the pinned rp id (id.bento.page) and origin list (the sign-in host)')
ok(F.version === 2, 'fixture version 2 (the rip. authority word; version 1 is retired)')
ok(F.waitMs === ROSTER_WAIT_MS && ROSTER_WAIT_MS === 72 * 3_600_000, 'the wait is 72 hours, in the fixture and the code')

console.log('\nevery row reaches its verdict for its reason')
const keyOf = (pub: string) => Object.keys(F.keys).find((k) => F.keys[k] === pub) ?? pub
const memberKey = (m: { kind: string; key: string; quarantined: boolean; since: number }) => `${m.kind}~${m.key}~${m.quarantined ? 'q' : ''}~${m.since}`
for (const r of rows) {
  const v = await run(r)
  const got = v.ok ? 'accept' : `reject (${v.reason})`
  const want = r.expect === 'accept' ? 'accept' : `reject (${r.reason})`
  ok(got === want, `${r.name}: ${got}${got === want ? '' : `, want ${want}`}`)
  if (v.ok && r.state) {
    const s = v.value, w = r.state
    ok(s.seq === w.seq && s.ripenedAt === w.ripenedAt, `${r.name}: head seq ${w.seq}, ripened ${w.ripenedAt}`)
    ok(s.address === 'alice@example.com', `${r.name}: address`)
    ok(s.headHash === b64uEnc(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(r.links[r.links.length - 1].ros)))),
      `${r.name}: headHash is sha256 of the last ros. text`)
    const gotM = s.members.map((m) => memberKey({ kind: m.kind, key: keyOf(m.pub), quarantined: m.quarantined, since: m.since })).sort()
    const wantM = w.members.map(memberKey).sort()
    ok(JSON.stringify(gotM) === JSON.stringify(wantM), `${r.name}: members and the time each joined${JSON.stringify(gotM) === JSON.stringify(wantM) ? '' : ` — got ${gotM.join(' ')}`}`)
    ok(s.createdAt === w.createdAt && s.lastResetAt === w.lastResetAt && s.sinceExact === w.sinceExact,
      `${r.name}: createdAt ${w.createdAt}, lastResetAt ${w.lastResetAt}, sinceExact ${w.sinceExact}`)
  }
}

console.log('\nthe rows the contract depends on exist')
const byName = new Map(rows.map((r) => [r.name, r]))
const REQUIRED: Array<[string, string]> = [
  ['ok/setup', 'accept'], ['ok/full-chain', 'accept'], ['ok/wait-exactly-72h', 'accept'], ['ok/requester-clock-late', 'accept'],
  ['ok/rk-replaced', 'accept'], ['ok/rk-removes-itself-at-once', 'accept'], ['ok/pinned-midway', 'accept'], ['ok/quarantine-carried', 'accept'],
  ['ok/last-live-member-leaves-after-wait', 'accept'], ['ok/sixteen-members', 'accept'],
  ['chain/prev-hash-wrong', 'chain'], ['chain/wrong-prev', 'chain'], ['chain/seq-skip', 'seq'], ['chain/seq-repeat', 'seq'],
  ['chain/address-changed', 'address'], ['chain/pinned-countersign-forged', 'rip-signature'], ['chain/no-anchor', 'anchor'], ['chain/pin-mismatch', 'pin'], ['chain/empty', 'grammar'],
  ['order/requested-before-previous-ripened', 'order'],
  ['wait/one-second-short', 'unripe'], ['wait/requester-clock-early', 'unripe'], ['wait/countersigned-at-request', 'unripe'],
  ['wait/remove-other-at-once', 'unripe'], ['wait/reset-short', 'unripe'], ['wait/last-live-member-leaves-at-once', 'unripe'],
  ['rip/over-other-text', 'rip-mismatch'], ['rip/unknown-kid', 'unknown-kid'], ['rip/wrong-key', 'rip-signature'], ['rip/high-s', 'rip-signature'],
  ['rip/ripened-before-requested', 'rip-grammar'], ['rip/missing', 'rip-grammar'], ['rip/future', 'not-yet-valid'],
  ['setup/auth-reset', 'auth'], ['setup/auth-quarantine', 'auth'], ['setup/two-members', 'setup-members'], ['setup/consent-key', 'setup-members'], ['setup/quarantined', 'setup-members'],
  ['setup/with-proof', 'proof'], ['reset/with-proof', 'proof'], ['reset/two-members', 'reset-members'], ['reset/recovery-key', 'reset-members'],
  ['signer/missing', 'proof'], ['signer/not-a-member', 'signer'], ['signer/adds-itself', 'signer'], ['signer/quarantined', 'quarantined'],
  ['signer/consent-key', 'signer-kind'], ['proof/passkey-raw-signature', 'proof'], ['proof/recovery-key-assertion', 'proof'], ['proof/recovery-key-both', 'proof'],
  ['rk/wrong-signature', 'signature'], ['rk/high-s', 'signature'],
  ['assertion/other-text', 'assertion-challenge'], ['assertion/origin-rp-host', 'assertion-origin'], ['assertion/origin-library', 'assertion-origin'],
  ['assertion/rp-parent', 'assertion-rp'], ['assertion/uv-clear', 'assertion-uv'], ['assertion/other-key', 'assertion-signature'],
  ['members/unsorted', 'members'], ['members/duplicate-key', 'members'], ['members/two-recovery-keys', 'members'], ['members/seventeen', 'members'],
  ['members/off-curve', 'key'], ['members/kind-changed', 'members'],
  ['quarantine/lifted', 'quarantine'], ['quarantine/added', 'quarantine'], ['quarantine/new-member-quarantined', 'quarantine'],
  ['change/none', 'no-change'], ['change/two-additions', 'multi-change'], ['change/two-removals', 'multi-change'], ['change/passkey-swapped', 'multi-change'],
  ['grammar/nonce-short', 'grammar'], ['grammar/address-not-normal', 'address'], ['grammar/prev-on-setup', 'prev'],
  // security's rows from the review of the first roster change
  ['since/readded-age-restarts', 'accept'], ['chain/reset-prev-wrong', 'chain'], ['order/requested-at-previous-ripening', 'accept'],
  ['assertion/sign-counts-not-tracked', 'accept'], ['chain/link-from-other-account', 'address'], ['rip/second-kid', 'accept'], ['rip/other-pinned-kid', 'rip-signature'],
  // the authority word
  ['rip/auth-unknown', 'rip-grammar'], ['rip/reset-flag-old-form', 'rip-grammar'], ['rip/cause-on-member-change', 'rip-grammar'], ['rip/cause-not-a-hash', 'rip-grammar'],
  ['ok/q-quarantine', 'accept'], ['ok/q-voided-by-recovery-key', 'accept'], ['ok/q-then-x', 'accept'], ['ok/q-then-u', 'accept'], ['ok/pinned-q-then-x', 'accept'],
  ['q/no-voided-request', 'voided'], ['q/cause-wrong', 'cause'], ['q/voided-prev-wrong', 'voided-prev'], ['q/voided-signer-not-member', 'voided-signer'],
  ['q/voided-bad-proof', 'voided-assertion-signature'], ['q/voided-other-origin', 'voided-assertion-origin'], ['q/voided-quarantined-signer', 'voided-quarantined'],
  ['q/voided-consent-key', 'voided-signer-kind'], ['q/wrong-target', 'target'], ['q/also-removes', 'target'], ['q/also-adds', 'target'], ['q/kind-changed', 'members'],
  ['q/last-live', 'last-live'], ['q/with-member-proof', 'proof'], ['q/carries-cited', 'proof'], ['m/carries-voided', 'proof'],
  ['x/after-member-change', 'auth'], ['x/cause-wrong', 'cause'], ['x/short', 'unripe'], ['x/requested-later', 'order'], ['x/removes-unquarantined', 'target'],
  ['x/adds', 'target'], ['x/with-member-proof', 'proof'], ['x/carries-voided', 'proof'], ['u/carries-cited', 'proof'],
  ['u/after-member-change', 'auth'], ['u/after-removal', 'auth'], ['u/adds-member', 'target'], ['u/clears-and-removes', 'target'], ['u/cause-wrong', 'cause'],
  ['ok/l-revert', 'accept'], ['ok/l-then-x', 'accept'], ['ok/l-then-u', 'accept'], ['l/no-cited', 'cited'], ['l/cause-wrong', 'cause'],
  ['l/cited-not-countersigned', 'cited-rip-signature'], ['l/cited-other-account', 'cited-address'], ['l/cited-not-chained', 'cited-chain'],
  ['l/cited-removal', 'cited-change'], ['l/cited-setup', 'cited-chain'], ['l/wrong-target', 'target'], ['l/also-removes', 'target'], ['l/carries-voided', 'proof'],
  // security's rows from the review of the authority word (#925): C1′, the nits, the x/u target rule (C4)
  ['l/cited-unknown-kid', 'cited-unknown-kid'], ['l/cited-future', 'cited-not-yet-valid'], ['l/cited-adds-and-marks', 'cited-change'],
  ['l/cited-ros-other-account', 'cited-address'], ['x/also-clears', 'target'], ['x/also-marks', 'target'], ['u/also-marks', 'target'], ['u/signed-by-quarantined', 'proof'],
  ['l/cited-kind-changed', 'cited-change'], ['l/cited-not-member-change', 'cited-auth'], ['q/voided-other-address', 'voided-address'], ['q/voided-seq-wrong', 'voided-seq'],
  ['ok/q-then-q-then-x', 'accept'], ['u/clears-stale-mark', 'target'], ['x/removes-stale-mark', 'target'], ['x/pinned-removes-stale-mark', 'target'],
  ['ok/pinned-q-then-x-target', 'accept'], ['x/pinned-evidence-cause-wrong', 'evidence'], ['x/pinned-q-without-evidence', 'evidence'],
  ['ok/pinned-l-then-u', 'accept'], ['u/pinned-l-without-evidence', 'evidence'], ['u/pinned-l-evidence-cause-wrong', 'evidence'],
  ['ok/q-then-l-then-u', 'accept'], ['x/pinned-target-not-quarantined', 'target'],
  // C4′: the pinned link's evidence is re-bound (security's P10, P11c)
  ['x/pinned-q-signer-swapped', 'evidence'], ['x/pinned-evidence-other-request', 'evidence'], ['u/pinned-l-clears-stale-mark', 'target'], ['u/pinned-l-prevros-swapped', 'evidence'],
]
for (const [n, want] of REQUIRED) {
  const r = byName.get(n)
  ok(!!r && (want === 'accept' ? r.expect === 'accept' && !!r.state : r.expect === 'reject' && r.reason === want), `required row ${n} (${want})`)
}
ok(rows.filter((r) => r.expect === 'accept').every((r) => !!r.state), 'every accepted row states the chain\'s outcome')

console.log('\nthe two clocks: a row differs from its accepted twin ONLY in which clock is 72 h old')
{
  const early = byName.get('wait/requester-clock-early')!, late = byName.get('ok/requester-clock-late')!
  const tail = (r: Row) => r.links[r.links.length - 1]
  const reqOf = (r: Row) => Number(tail(r).rip.split('.')[2]), ripOf = (r: Row) => Number(tail(r).rip.split('.')[3]), createdOf = (r: Row) => Number(tail(r).ros.split('.')[6])
  ok(ripOf(early) - createdOf(early) >= ROSTER_WAIT_MS && ripOf(early) - reqOf(early) < ROSTER_WAIT_MS,
    'requester-clock-early: 72 h by the requester\'s created, under 72 h by the directory\'s requestedAt')
  ok(ripOf(late) - createdOf(late) < ROSTER_WAIT_MS && ripOf(late) - reqOf(late) >= ROSTER_WAIT_MS,
    'requester-clock-late: the reverse')
}

console.log('\npositive controls: a refusal flips when only its cause changes')
{
  const lib = byName.get('assertion/origin-library')!
  const v = await run(lib, { origins: [...F.origins, 'https://home.bento.page'] })
  ok(v.ok, 'assertion/origin-library verifies once the caller lists https://home.bento.page (the closed list decides)')
  const kid = byName.get('rip/unknown-kid')!
  const v2 = await run(kid, { directoryKeys: { ...F.directoryKeys, 'dir-9': F.unpinnedDirectoryKey } })
  ok(v2.ok, 'rip/unknown-kid verifies once dir-9 is pinned (only the kid was wrong)')
  const pin = byName.get('chain/pin-mismatch')!
  const v3 = await run(pin, { pinned: undefined })
  ok(!v3.ok && v3.reason === 'anchor', 'chain/pin-mismatch without its pin is refused as unanchored, not as a pin mismatch')
  const vo = byName.get('q/voided-other-origin')!
  const v5 = await run(vo, { origins: [...F.origins, 'https://home.bento.page'] })
  ok(v5.ok, "q/voided-other-origin verifies once the caller lists the library's origin (the voided request is checked against the caller's list)")
  const other = byName.get('rip/other-pinned-kid')!, twin = byName.get('rip/second-kid')!
  const kidOf = (r: Row) => r.links[1].rip.split('.').pop()
  ok(kidOf(other) === 'dir-1' && kidOf(twin) === 'dir-2' && other.links[1].ros === twin.links[1].ros,
    "rip/other-pinned-kid and its accepted twin rip/second-kid differ in the kid named (same head, same signing key dir-2)")
  const nc = byName.get('l/cited-not-countersigned')!
  const v7 = await run(nc, { directoryKeys: { ...F.directoryKeys, 'dir-1': F.unpinnedDirectoryKey } })
  ok(!v7.ok && v7.reason === 'rip-signature', 'l/cited-not-countersigned: with the forger pinned instead, the cited link passes and the chain itself fails (the refusal was the citation)')
  const midway = byName.get('ok/pinned-midway')!
  const v4 = await verifyRosterChain(midway.links, { directoryKeys: F.directoryKeys, rpId: F.rpId, origins: F.origins, now: F.now })
  ok(!v4.ok && v4.reason === 'anchor', 'ok/pinned-midway WITHOUT the pin is refused (anchor): a mid-chain head is never trusted on its own')
}

console.log('\ncaller parameters are required, never defaulted')
{
  const r = byName.get('ok/full-chain')!
  ok((await run(r)).ok, 'control: accepts with the fixture parameters')
  for (const [what, extra] of [['an empty origin list', { origins: [] }], ['an empty rp id', { rpId: '' }], ['a non-integer now', { now: Number.NaN }]] as const) {
    const v = await run(r, extra as Record<string, unknown>)
    ok(!v.ok && v.reason === 'grammar', `${what} is refused as a caller error (grammar)`)
  }
  const other = await run(r, { rpId: 'other.example' })
  ok(!other.ok && other.reason === 'assertion-rp', 'another rp id parameter refuses the passkey links (assertion-rp)')
  const noDir = await run(r, { directoryKeys: {} })
  ok(!noDir.ok && noDir.reason === 'unknown-kid', 'no pinned directory key: unknown-kid')
  const junk = await verifyRosterChain(null as never, opts(r))
  ok(!junk.ok && junk.reason === 'grammar', 'a missing chain is grammar, not a throw')
  const junk2 = await verifyRosterChain([null as never], opts(r))
  ok(!junk2.ok && junk2.reason === 'grammar', 'a null link is grammar, not a throw')
  const before = await run(r, { now: Number(r.links[6].rip.split('.')[3]) - 6 * 60_000 })
  ok(!before.ok && before.reason === 'not-yet-valid', 'a chain whose head ripened after now (beyond the skew) is not-yet-valid')
}

console.log('\nthe builder writes the one spelling')
{
  const r = byName.get('ok/full-chain')!
  for (const l of r.links) {
    const h = await parseRos(l.ros)
    ok(h.ok && buildRos(h.value) === l.ros, `parse → build round-trips seq ${l.ros.split('.')[2]}`)
    if (h.ok) {
      const shuffled: RosterHead = { ...h.value, members: [...h.value.members].reverse() }
      ok(buildRos(shuffled) === l.ros, `members given in another order build the same text (seq ${h.value.seq})`)
    }
  }
}

console.log('\nprefixes')
{
  const K1K2 = ['bind', 'dev', 'rot', 'att', 'tomb', 'del', 'cmp', 'dreq', 'cns', 'cnst', 'inv', 'rev', 'dlg', 'prove']
  ok(ROSTER_PREFIXES.length === 2 && ROSTER_PREFIXES.includes('ros') && ROSTER_PREFIXES.includes('rip'), 'roster.ts defines ros. and rip.')
  ok(ROSTER_PREFIXES.every((p) => !RESERVED_PREFIXES.includes(p) && !LINK_PREFIXES.includes(p) && !K1K2.includes(p)),
    'ros. and rip. collide with no existing family, reserved prefix or link prefix')
  ok(['wdev', 'watt', 'wren', 'dev2'].every((p) => RESERVED_PREFIXES.includes(p)), 'wdev. watt. wren. dev2. are reserved for the device certificates')
  ok(RESERVED_PREFIXES.includes('pk') && RESERVED_PREFIXES.includes('drev'), 'pk. and drev. stay reserved')
  ok(RESERVED_PREFIXES.every((p) => !LINK_PREFIXES.includes(p) && !K1K2.includes(p)), 'no reserved prefix collides with a defined family')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
