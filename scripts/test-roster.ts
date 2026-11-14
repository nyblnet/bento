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
  verifyRosterChain, verifyResetStop, verifyWout, verifyAdel, parseRos, buildRos, buildVrs, buildWout, buildAdel, buildUserHandle, userHandleAccount, accountNameOf,
  ROSTER_PREFIXES, ROSTER_RP_ID, ROSTER_WEB_ORIGINS, ROSTER_WAIT_MS, NEW_ACCOUNT_MS, DELETE_WAIT_MS, USER_HANDLE_LABEL, USER_HANDLE_BYTES,
  type RosterLink, type RosterHead,
} from '../kernel/src/roster.ts'
import { RESERVED_PREFIXES, LINK_PREFIXES, b64uEnc, b64uDec } from '../kernel/src/statements.ts'
import { createHash } from 'node:crypto'

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
const opts = (r: Row, extra: Record<string, unknown> = {}) => ({ directoryKeys: F.directoryKeys, rpId: F.rpId, origins: F.origins, now: F.now, consentRp: F.consentRp,
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
  ['signer/consent-key', 'proof'], ['proof/passkey-raw-signature', 'proof'], ['proof/recovery-key-assertion', 'proof'], ['proof/recovery-key-both', 'proof'],
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
  ['q/voided-consent-key', 'voided-proof'], ['q/wrong-target', 'target'], ['q/also-removes', 'target'], ['q/also-adds', 'target'], ['q/kind-changed', 'members'],
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
  // KG3: a consent key as the requester (cns. purpose roster) and the co-sign that skips the wait (security's ruling on #917, item 4)
  ['ok/ck-requests-with-wait', 'accept'], ['ck/unripe-at-once', 'unripe'], ['ok/ck-ripe-at-once', 'accept'], ['ck/ripe-one-second-short', 'unripe'],
  ['ck/cns-and-assertion', 'proof'], ['ck/cns-expired', 'consent-expired'], ['ck/cns-long-life', 'consent-lifetime'], ['ck/cns-other-purpose', 'consent-purpose'],
  ['ck/cns-link-purpose', 'consent-purpose'], ['ck/cns-reserved-purpose', 'consent-reserved-purpose'], ['ck/cns-other-rp', 'consent-rp'],
  ['ck/cns-other-text', 'consent-transcript'], ['ck/cns-other-audience', 'consent-transcript'], ['ck/cns-other-challenge', 'consent-transcript'],
  ['ck/cns-doc-scoped', 'consent-grammar'], ['ck/cns-wrong-key', 'consent-signature'], ['ck/cns-high-s', 'consent-signature'],
  ['ok/cosign-skips-wait', 'accept'], ['ok/cosign-exactly-72h', 'accept'], ['ok/cosign-rk-requester', 'accept'], ['cosign/unripe', 'cosign-unripe'],
  ['cosign/one-second-short', 'cosign-unripe'], ['cosign/age-from-requester-clock', 'cosign-unripe'], ['cosign/by-passkey', 'cosign-kind'],
  ['cosign/by-recovery-key', 'cosign-kind'], ['cosign/by-requester', 'cosign'], ['cosign/not-member', 'cosign-signer'], ['cosign/adds-itself', 'cosign-signer'],
  ['cosign/quarantined', 'cosign-quarantined'], ['cosign/other-text', 'cosign-consent-transcript'], ['cosign/expired', 'cosign-consent-expired'],
  ['cosign/wrong-key', 'cosign-consent-signature'], ['cosign/other-purpose', 'cosign-consent-purpose'], ['cosign/on-reset', 'proof'], ['cosign/on-quarantine', 'proof'],
  ['cosign/pinned-age-lower-bound', 'cosign-unripe'], ['ok/cosign-pinned-ripe', 'accept'], ['cosign/readded-age-restarts', 'cosign-unripe'],
  ['ok/q-voided-by-consent-key', 'accept'], ['ok/q-voided-ck-cns-old', 'accept'], ['q/voided-ck-cns-other-text', 'voided-consent-transcript'],
  // security-ruling-949 C2: a change ripened later than it was asked is judged at requestedAt
  ['cosign/unripe-at-request-ripe-at-ripening', 'cosign-unripe'], ['ck/unripe-at-request-ripe-at-ripening', 'unripe'], ['ok/cosign-ripened-late', 'accept'], ['ok/ck-ripened-late', 'accept'],
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

console.log('\nconsent keys: positive controls')
{
  const ripe = byName.get('ok/ck-ripe-at-once')!, short = byName.get('ck/ripe-one-second-short')!
  const reqOf = (r: Row) => Number(r.links[r.links.length - 1].rip.split('.')[2])
  ok(reqOf(ripe) - reqOf(short) === 1000, 'ck/ripe-one-second-short differs from ok/ck-ripe-at-once by one second of the directory\'s requestedAt')
  for (const n of ['ok/ck-ripe-at-once', 'ok/cosign-skips-wait']) {
    const v = await run(byName.get(n)!, { consentRp: undefined })
    ok(!v.ok && v.reason === 'grammar', `${n} without the caller's consentRp: refused as a caller error (grammar), never defaulted`)
    const w = await run(byName.get(n)!, { consentRp: 'vault-acme' })
    ok(!w.ok && /consent-rp$/.test(w.reason), `${n} with another consentRp: consent-rp (the rp is the caller's)`)
  }
  const plain = byName.get('ok/full-chain')!
  ok((await run(plain, { consentRp: undefined })).ok, 'a chain no consent key signs needs no consentRp (existing callers keep working)')
  const age = byName.get('cosign/age-from-requester-clock')!
  const tail = age.links[age.links.length - 1]
  ok(Number(tail.ros.split('.')[6]) - (Number(F.rows.find((r: Row) => r.name === 'ok/full-chain').links[3].rip.split('.')[3])) >= ROSTER_WAIT_MS,
    'cosign/age-from-requester-clock: by the requester\'s created the co-signer would be ripe')
}

console.log('\nvrs.: a member stops a reset (the directory\'s check)')
type StopRow = { name: string; links: RosterLink[]; pinned?: string; resetRos: string; resetRequestedAt: number; challenge: string; now: number; text: string; signer: string
  proof: Record<string, unknown>; spent?: boolean; expect: 'accept' | 'reject'; reason?: string }
const stops: StopRow[] = F.resetStops
async function runStop(r: StopRow, extra: Record<string, unknown> = {}) {
  try {
    const ro = await verifyRosterChain(r.links, { directoryKeys: F.directoryKeys, rpId: F.rpId, origins: F.origins, consentRp: F.consentRp, now: r.now, ...(r.pinned ? { pinned: r.pinned } : {}) })
    if (!ro.ok) return { ok: false as const, reason: `chain: ${ro.reason}` }
    return await verifyResetStop(r.text, r.signer, r.proof as never, { roster: ro.value, resetRos: r.resetRos, resetRequestedAt: r.resetRequestedAt, challenge: r.challenge,
      spend: () => !r.spent, rpId: F.rpId, origins: F.origins, consentRp: F.consentRp, now: r.now, ...extra })
  } catch (e) { return { ok: false as const, reason: `threw: ${(e as Error).message}` } }
}
for (const r of stops) {
  const v = await runStop(r)
  const got = v.ok ? 'accept' : `reject (${v.reason})`
  const want = r.expect === 'accept' ? 'accept' : `reject (${r.reason})`
  ok(got === want, `${r.name}: ${got}${got === want ? '' : `, want ${want}`}`)
}
{
  const sb = new Map(stops.map((r) => [r.name, r]))
  const REQ_STOP: Array<[string, string]> = [['ok/stop-by-passkey', 'accept'], ['ok/stop-by-recovery-key', 'accept'], ['ok/stop-by-consent-key', 'accept'],
    ['stop/new-account', 'new-account'], ['stop/age-at-request-not-at-stop', 'new-account'], ['stop/pinned-age-unknown', 'age-unknown'], ['stop/signer-not-member', 'signer'],
    ['stop/signer-quarantined', 'quarantined'], ['stop/other-reset', 'reset-mismatch'], ['stop/reset-not-on-head', 'reset'], ['stop/reset-two-members', 'reset'],
    ['stop/requested-before-head', 'order'], ['stop/other-address', 'address'], ['stop/other-challenge', 'challenge'], ['stop/spent', 'replay'],
    ['stop/assertion-other-text', 'assertion-challenge'], ['stop/rk-wrong-key', 'signature'], ['stop/ck-cns-expired', 'consent-expired'],
    ['stop/ck-cns-web-add', 'consent-purpose'], ['stop/passkey-raw-signature', 'proof'], ['stop/extra-field', 'grammar'], ['stop/address-not-normal', 'grammar']]
  for (const [n, want] of REQ_STOP) {
    const r = sb.get(n)
    ok(!!r && (want === 'accept' ? r.expect === 'accept' : r.expect === 'reject' && r.reason === want), `required vrs. row ${n} (${want})`)
  }
  const ok14 = sb.get('ok/stop-by-passkey')!, c4 = sb.get('stop/age-at-request-not-at-stop')!
  const created = Number(ok14.links[0].rip.split('.')[3])
  ok(ok14.resetRequestedAt - created === NEW_ACCOUNT_MS && NEW_ACCOUNT_MS === 14 * 24 * 3_600_000, 'ok/stop-by-passkey: the reset was requested exactly 14 days after setup')
  ok(c4.resetRequestedAt - created < NEW_ACCOUNT_MS && c4.now - created >= NEW_ACCOUNT_MS,
    'stop/age-at-request-not-at-stop: under 14 days at the request, over 14 days at the stop (C4: the request time decides)')
  const v = await runStop(c4, { resetRequestedAt: created + NEW_ACCOUNT_MS })
  ok(v.ok, 'positive control: the same stop with the request at day 14 is accepted (only the request time was young)')
  const sp = sb.get('stop/spent')!
  ok((await runStop({ ...sp, spent: false })).ok, 'positive control: stop/spent is accepted with an unspent challenge')
  let spentBefore = 0
  const g = await runStop(sb.get('stop/extra-field')!, { spend: () => { spentBefore++; return true } })
  ok(!g.ok && g.reason === 'grammar' && spentBefore === 0, 'a vrs. that does not parse never spends the challenge')
  const ck = sb.get('ok/stop-by-consent-key')!
  const nr = await runStop(ck, { consentRp: undefined })
  ok(!nr.ok && nr.reason === 'grammar', 'a consent key\'s stop without consentRp is a caller error')
  ok(buildVrs({ address: 'alice@example.com', resetHash: ok14.text.split('.')[2], dirNonce: ok14.challenge }) === ok14.text, 'buildVrs writes the one spelling')
}

console.log('\nC2: the two directory clocks of one link (requestedAt vs ripenedAt)')
{
  const rip = (r: Row) => r.links[r.links.length - 1].rip.split('.')
  for (const n of ['cosign/unripe-at-request-ripe-at-ripening', 'ck/unripe-at-request-ripe-at-ripening', 'ok/cosign-ripened-late', 'ok/ck-ripened-late']) {
    const p = rip(byName.get(n)!)
    ok(Number(p[3]) > Number(p[2]), `${n}: ripenedAt is later than requestedAt`)
  }
  // in the unripe rows the ck is under 72 h at requestedAt and over it at ripenedAt, and the change waited under 72 h:
  // only the choice of clock decides them
  const since = 1_800_000_000_000 + 232 * 3_600_000
  for (const n of ['cosign/unripe-at-request-ripe-at-ripening', 'ck/unripe-at-request-ripe-at-ripening']) {
    const p = rip(byName.get(n)!)
    ok(Number(p[2]) - since < ROSTER_WAIT_MS && Number(p[3]) - since >= ROSTER_WAIT_MS && Number(p[3]) - Number(p[2]) < ROSTER_WAIT_MS,
      `${n}: unripe at requestedAt, ripe at ripenedAt, waited under 72 h`)
  }
  for (const [n, field] of [['ok/cosign-ripened-late', 'cosign'], ['ok/ck-ripened-late', 'cns']] as const) {
    const r = byName.get(n)!
    const l = r.links[r.links.length - 1] as RosterLink & { cosign?: { cns: string } }
    const cns = field === 'cosign' ? l.cosign!.cns : l.cns!
    const exp = Number(cns.split('.')[5]), p = rip(r)
    ok(exp > Number(p[2]) && exp <= Number(p[3]), `${n}: the cns. is alive at requestedAt and expired by ripenedAt`)
  }
}

console.log('\nwout. and adel.: member acts the directory checks')
type ActRow = { name: string; links: RosterLink[]; challenge: string; challengeAt?: number; now: number; text: string; signer: string
  proof: Record<string, unknown>; spent?: boolean; expect: 'accept' | 'reject'; reason?: string }
async function runAct(kind: 'wout' | 'adel', r: ActRow, extra: Record<string, unknown> = {}) {
  try {
    const ro = await verifyRosterChain(r.links, { directoryKeys: F.directoryKeys, rpId: F.rpId, origins: F.origins, consentRp: F.consentRp, now: r.now })
    if (!ro.ok) return { ok: false as const, reason: `chain: ${ro.reason}` }
    const o = { roster: ro.value, challenge: r.challenge, spend: () => !r.spent, rpId: F.rpId, origins: F.origins, consentRp: F.consentRp, now: r.now, ...extra }
    return kind === 'wout' ? await verifyWout(r.text, r.signer, r.proof as never, { ...o, challengeAt: r.challengeAt!, ...extra })
      : await verifyAdel(r.text, r.signer, r.proof as never, o)
  } catch (e) { return { ok: false as const, reason: `threw: ${(e as Error).message}` } }
}
for (const [kind, list] of [['wout', F.signOuts], ['adel', F.deletions]] as const) {
  for (const r of list as ActRow[]) {
    const v = await runAct(kind, r)
    const got = v.ok ? 'accept' : `reject (${v.reason})`
    const want = r.expect === 'accept' ? 'accept' : `reject (${r.reason})`
    ok(got === want, `${kind} ${r.name}: ${got}${got === want ? '' : `, want ${want}`}`)
  }
}
{
  const so = new Map((F.signOuts as ActRow[]).map((r) => [r.name, r])), de = new Map((F.deletions as ActRow[]).map((r) => [r.name, r]))
  const REQ_OUT: Array<[string, string]> = [['ok/wout-by-passkey', 'accept'], ['ok/wout-by-recovery-key', 'accept'], ['ok/wout-by-consent-key', 'accept'],
    ['wout/signer-not-member', 'signer'], ['wout/signer-removed', 'signer'], ['wout/signer-quarantined', 'quarantined'], ['wout/other-address', 'address'],
    ['wout/address-not-normal', 'grammar'], ['wout/other-challenge', 'challenge'], ['wout/at-not-challenge-time', 'at'], ['wout/spent', 'replay'],
    ['wout/assertion-other-text', 'assertion-challenge'], ['wout/assertion-over-adel', 'assertion-challenge'], ['wout/rk-wrong-key', 'signature'],
    ['wout/ck-cns-web-add', 'consent-purpose'], ['wout/passkey-raw-signature', 'proof'], ['wout/extra-field', 'grammar'], ['wout/at-zero', 'grammar'], ['wout/nonce-short', 'grammar']]
  const REQ_DEL: Array<[string, string]> = [['ok/adel-by-passkey', 'accept'], ['ok/adel-by-recovery-key', 'accept'], ['ok/adel-by-consent-key', 'accept'],
    ['adel/old-head', 'roster-head'], ['adel/signer-not-member', 'signer'], ['adel/signer-removed', 'signer'], ['adel/signer-quarantined', 'quarantined'],
    ['adel/other-address', 'address'], ['adel/address-not-normal', 'grammar'], ['adel/other-challenge', 'challenge'], ['adel/spent', 'replay'],
    ['adel/assertion-other-text', 'assertion-challenge'], ['adel/assertion-over-wout', 'assertion-challenge'], ['adel/ck-cns-web-add', 'consent-purpose'],
    ['adel/passkey-raw-signature', 'proof'], ['adel/extra-field', 'grammar'], ['adel/head-not-a-hash', 'grammar'], ['adel/vrs-text', 'grammar']]
  for (const [m, req] of [[so, REQ_OUT], [de, REQ_DEL]] as const)
    for (const [n, want] of req) { const r = m.get(n); ok(!!r && (want === 'accept' ? r.expect === 'accept' : r.reason === want), `required row ${n} (${want})`) }
  // positive controls: each refusal flips when only its cause changes
  const w = so.get('ok/wout-by-passkey')!
  ok((await runAct('wout', { ...so.get('wout/spent')!, spent: false })).ok, 'positive control: wout/spent is accepted with an unspent challenge')
  const late = await runAct('wout', so.get('wout/at-not-challenge-time')!, { challengeAt: Number(so.get('wout/at-not-challenge-time')!.text.split('.')[2]) })
  ok(late.ok, 'positive control: wout/at-not-challenge-time is accepted when the challenge was issued at the time it says')
  let spent = 0
  const g = await runAct('wout', so.get('wout/address-not-normal')!, { spend: () => { spent++; return true } })
  ok(!g.ok && g.reason === 'grammar' && spent === 0, 'a wout. naming a non-normal address never spends the challenge (it is grammar)')
  const nr = await runAct('wout', so.get('ok/wout-by-consent-key')!, { consentRp: undefined })
  ok(!nr.ok && nr.reason === 'grammar', 'a consent key\'s sign-out without consentRp is a caller error')
  ok(buildWout({ address: 'alice@example.com', at: w.challengeAt!, dirNonce: w.challenge }) === w.text, 'buildWout writes the one spelling')
  const d = de.get('ok/adel-by-passkey')!
  ok((await runAct('adel', { ...de.get('adel/spent')!, spent: false })).ok, 'positive control: adel/spent is accepted with an unspent challenge')
  ok(buildAdel({ address: 'alice@example.com', headHash: d.text.split('.')[2], dirNonce: d.challenge }) === d.text, 'buildAdel writes the one spelling')
  const head = d.links[d.links.length - 1].ros
  ok(d.text.split('.')[2] === b64uEnc(new Uint8Array(createHash('sha256').update(head).digest())), 'ok/adel-by-passkey names the current head (sha256 of its ros. text)')
  ok(F.deleteWaitMs === DELETE_WAIT_MS && DELETE_WAIT_MS === ROSTER_WAIT_MS, 'a deletion waits 72 h, like every change (fixture and code)')
}

console.log('\nthe passkey user handle (recomputed with node:crypto, not the reference)')
{
  const U = F.userHandles as { label: string; bytes: number; rows: Array<{ name: string; address: string; tailHex: string; handle: string | null; accountHex?: string }> }
  ok(U.label === 'bento-dir/1/addr\n' && USER_HANDLE_LABEL === U.label && U.bytes === 48 && USER_HANDLE_BYTES === 48, 'label "bento-dir/1/addr" + LF, 48 bytes, in the fixture and the code')
  for (const r of U.rows) {
    const tail = Uint8Array.from(Buffer.from(r.tailHex, 'hex'))
    const got = await buildUserHandle(r.address, tail)
    if (r.handle === null) { ok(got === null && (await accountNameOf(r.address)) === null, `${r.name}: refused (not in normal form)`); continue }
    const want = Buffer.concat([createHash('sha256').update(U.label + r.address, 'utf8').digest(), Buffer.from(tail)])
    ok(r.handle === want.toString('base64url') && r.accountHex === want.subarray(0, 32).toString('hex'), `${r.name}: independent SHA-256 matches the fixture`)
    ok(!!got && b64uEnc(got) === r.handle, `${r.name}: buildUserHandle matches the fixture`)
    const acct = userHandleAccount(b64uDec(r.handle)!)
    ok(!!acct && Buffer.from(acct).toString('hex') === r.accountHex, `${r.name}: the handle routes to its first 32 bytes`)
  }
  const [a, b] = U.rows
  ok(a.accountHex === b.accountHex && a.handle !== b.handle, 'two passkeys of one account: one account name, two handles (the random tail)')
  for (const n of [0, 32, 47, 49, 64]) ok(userHandleAccount(new Uint8Array(n)) === null, `a ${n}-byte handle routes nowhere`)
  ok((await buildUserHandle('alice@example.com', new Uint8Array(15))) === null && (await buildUserHandle('alice@example.com', new Uint8Array(17))) === null, 'the tail is exactly 16 bytes')
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
  ok(ROSTER_PREFIXES.length === 5 && ['ros', 'rip', 'vrs', 'wout', 'adel'].every((p) => ROSTER_PREFIXES.includes(p)), 'roster.ts defines ros. rip. vrs. wout. adel.')
  ok(ROSTER_PREFIXES.every((p) => !RESERVED_PREFIXES.includes(p) && !LINK_PREFIXES.includes(p) && !K1K2.includes(p)),
    'ros. rip. vrs. wout. adel. collide with no existing family, reserved prefix or link prefix')
  ok(['mgd', 'vch', 'ojn', 'dvc'].every((p) => RESERVED_PREFIXES.includes(p)), 'the organisation prefixes mgd. vch. ojn. dvc. are reserved (org-identity §5.4 item 4)')
  ok(['wdev', 'watt', 'wren', 'dev2'].every((p) => RESERVED_PREFIXES.includes(p)), 'wdev. watt. wren. dev2. are reserved for the device certificates')
  ok(RESERVED_PREFIXES.includes('pk') && RESERVED_PREFIXES.includes('drev'), 'pk. and drev. stay reserved')
  ok(RESERVED_PREFIXES.every((p) => !LINK_PREFIXES.includes(p) && !K1K2.includes(p)), 'no reserved prefix collides with a defined family')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
