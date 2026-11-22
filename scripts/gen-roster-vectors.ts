#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Generates kernel/fixtures/roster-v2.json: the conformance rows for the bento/id
// option G roster chain (kernel/src/roster.ts): ros. heads, the directory's rip.
// countersign, and the member proofs (passkey assertions, recovery-key signatures).
//
//   node scripts/gen-roster-vectors.ts [--out <file>] [--check]
//
// Keys are DETERMINISTIC (scalars from SHA-256 of a label), so a key keeps its
// public point across regenerations. ECDSA signatures are random, so a row is
// compared with the committed one with its signatures blanked: a row that is
// unchanged but for them KEEPS its committed bytes, so adding a row leaves every
// other row's bytes alone. --check writes nothing: it exits 1 when the file on
// disk is not what this generator would write (a row added, removed or
// changed), and names the rows. Passkey assertions come
// from a software authenticator here; real browser assertions are the contract
// of webauthn-v1.json, which roster.ts reuses unchanged.
//
// Every accepted row also carries the state the chain must yield, written by
// hand below (not read back from the verifier).

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { b64uEnc, sha256b64u } from '../kernel/src/statements.ts'
import { buildRos, buildVrs, buildWout, buildAdel, buildUserHandle, ROSTER_WEB_ORIGINS, NEW_ACCOUNT_MS, DELETE_WAIT_MS, USER_HANDLE_LABEL, type MemberKind } from '../kernel/src/roster.ts'
import { signStatement } from '../kernel/src/statements.ts'
import {
  ADDRESS, CONSENT_RP, DIRECTORY_KEYS, H, K, LABELS, N, NOW, OFF_CURVE, ORIGIN, RP, T, assertion, be32, big, chainOf, cosign, ecdsa, highS, link, minInt, nonce, pubOf, rawToDer, sha, te, unb,
  type Spec, type M, type Link, type CnsOpts,
} from './lib/roster-build.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outArg = process.argv.indexOf('--out')
const OUT = outArg > 0 ? process.argv[outArg + 1] : join(root, 'kernel/fixtures/roster-v2.json')
const CHECK = process.argv.includes('--check')

// keys, the software authenticator and the link builder (shared with gen-device-vectors.ts)
// --- the base chain ------------------------------------------------------------------
//
//   L0  T              setup {pk1}
//   L1  T+1h → +73h    pk1 adds pk2
//   L2  T+80h → +152h  pk2 adds rk1
//   L3  T+160h → 232h  rk1 adds ck1                        (a recovery-key signature)
//   L4  T+240h → 240h  pk2 removes ITSELF, immediately      (pk1 remains)
//   L5  T+300h → 372h  reset to {pk3}                       (the directory alone)
//   L6  T+400h → 472h  pk3 adds pk4

const S0: Spec = { members: [['pk', 'pk1']], req: T, rip: T }
const S1: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2']], req: T + 1 * H, rip: T + 73 * H, signer: 'pk1' }
const S2: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 80 * H, rip: T + 152 * H, signer: 'pk2' }
const S3: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1'], ['ck', 'ck1']], req: T + 160 * H, rip: T + 232 * H, signer: 'rk1' }
const S4: Spec = { members: [['pk', 'pk1'], ['rk', 'rk1'], ['ck', 'ck1']], req: T + 240 * H, rip: T + 240 * H, signer: 'pk2' }
const S5: Spec = { members: [['pk', 'pk3']], req: T + 300 * H, rip: T + 372 * H, reset: true }
const S6: Spec = { members: [['pk', 'pk3'], ['pk', 'pk4']], req: T + 400 * H, rip: T + 472 * H, signer: 'pk3' }
const BASE = [S0, S1, S2, S3, S4, S5, S6]

type St = { seq: number; ripenedAt: number; members: Array<{ kind: MemberKind; key: string; quarantined: boolean; since: number }>; createdAt: number | null; lastResetAt: number | null; sinceExact: boolean }
type Row = { name: string; about: string; links: Link[]; pinned?: string; expect: 'accept' | 'reject'; reason?: string; state?: St }
const rows: Row[] = []
const accept = (name: string, about: string, links: Link[], state: St, pinned?: string) => rows.push({ name, about, links, ...(pinned ? { pinned } : {}), expect: 'accept', state })
const reject = (name: string, about: string, links: Link[], reason: string, pinned?: string) => rows.push({ name, about, links, ...(pinned ? { pinned } : {}), expect: 'reject', reason })
const mem = (kind: MemberKind, key: string, since: number, quarantined = false) => ({ kind, key, quarantined, since })
/** base links 0..n−1, then `last` built on them */
async function upTo(n: number, last?: Spec): Promise<Link[]> {
  const specs = BASE.slice(0, n)
  return chainOf(last ? [...specs, last] : specs)
}

// accepts -----------------------------------------------------------------------------
accept('ok/setup', 'the setup head alone: one passkey, countersigned at once', await upTo(1),
  { seq: 0, ripenedAt: T, members: [mem('pk', 'pk1', T)], createdAt: T, lastResetAt: null, sinceExact: true })
const full = await upTo(7)
accept('ok/full-chain', 'add a passkey, add a recovery key, the recovery key adds a consent key, a passkey removes itself at once, a reset, a passkey adds another',
  full, { seq: 6, ripenedAt: T + 472 * H, members: [mem('pk', 'pk3', T + 372 * H), mem('pk', 'pk4', T + 472 * H)], createdAt: T, lastResetAt: T + 372 * H, sinceExact: true })
accept('ok/before-reset', 'members keep the time they joined: pk1 since setup, rk1 and ck1 since their links',
  await upTo(5), { seq: 4, ripenedAt: T + 240 * H,
    members: [mem('ck', 'ck1', T + 232 * H), mem('pk', 'pk1', T), mem('rk', 'rk1', T + 152 * H)], createdAt: T, lastResetAt: null, sinceExact: true })
accept('ok/wait-exactly-72h', 'ripened exactly 72 hours after the request', await upTo(1, { ...S1, req: T + 1 * H, rip: T + 73 * H }),
  { seq: 1, ripenedAt: T + 73 * H, members: [mem('pk', 'pk1', T), mem('pk', 'pk2', T + 73 * H)], createdAt: T, lastResetAt: null, sinceExact: true })
accept('ok/requester-clock-late', "the requester's created is 1 h before ripening, but the DIRECTORY's requestedAt is 72 h before: accepted",
  await upTo(1, { ...S1, req: T + 1 * H, rip: T + 73 * H, created: T + 72 * H }),
  { seq: 1, ripenedAt: T + 73 * H, members: [mem('pk', 'pk1', T), mem('pk', 'pk2', T + 73 * H)], createdAt: T, lastResetAt: null, sinceExact: true })
accept('ok/rk-replaced', 'the recovery key replaced by a new one: one removal and one addition, both rk',
  await upTo(3, { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk2']], req: T + 160 * H, rip: T + 232 * H, signer: 'pk1' }),
  { seq: 3, ripenedAt: T + 232 * H, members: [mem('pk', 'pk1', T), mem('pk', 'pk2', T + 73 * H), mem('rk', 'rk2', T + 232 * H)], createdAt: T, lastResetAt: null, sinceExact: true })
accept('ok/remove-other-after-wait', 'pk1 removes pk2, after the wait',
  await upTo(2, { members: [['pk', 'pk1']], req: T + 80 * H, rip: T + 152 * H, signer: 'pk1' }),
  { seq: 2, ripenedAt: T + 152 * H, members: [mem('pk', 'pk1', T)], createdAt: T, lastResetAt: null, sinceExact: true })
accept('ok/rk-removes-itself-at-once', 'a recovery key may remove itself at once too',
  await upTo(3, { members: [['pk', 'pk1'], ['pk', 'pk2']], req: T + 160 * H, rip: T + 160 * H, signer: 'rk1' }),
  { seq: 3, ripenedAt: T + 160 * H, members: [mem('pk', 'pk1', T), mem('pk', 'pk2', T + 73 * H)], createdAt: T, lastResetAt: null, sinceExact: true })
accept('ok/pinned-midway', 'starting from a pinned head (L2): its members carry the pin time as a lower bound',
  full.slice(2, 5), { seq: 4, ripenedAt: T + 240 * H,
    members: [mem('ck', 'ck1', T + 232 * H), mem('pk', 'pk1', T + 152 * H), mem('rk', 'rk1', T + 152 * H)], createdAt: null, lastResetAt: null, sinceExact: false },
  await sha256b64u(full[2].ros))
accept('ok/pinned-setup', 'pinning the setup head keeps exact times',
  full.slice(0, 2), { seq: 1, ripenedAt: T + 73 * H, members: [mem('pk', 'pk1', T), mem('pk', 'pk2', T + 73 * H)], createdAt: T, lastResetAt: null, sinceExact: true },
  await sha256b64u(full[0].ros))
accept('ok/pinned-head-only', 'a chain of just the pinned head', full.slice(6, 7),
  { seq: 6, ripenedAt: T + 472 * H, members: [mem('pk', 'pk3', T + 472 * H), mem('pk', 'pk4', T + 472 * H)], createdAt: null, lastResetAt: null, sinceExact: false },
  await sha256b64u(full[6].ros))

// a pinned head that carries a QUARANTINED member (made by a directory path this
// module does not define yet), to exercise the quarantine rules from a pin
const Q0: Spec = { seq: 5, prev: await sha256b64u('an earlier head'), members: [['pk', 'pk1'], ['pk', 'pk2', 'q']], req: T + 300 * H, rip: T + 300 * H }
const qChain = async (next: Spec) => { const c = await chainOf([Q0, next]); return { links: c, pin: await sha256b64u(c[0].ros) } }
{
  const a = await qChain({ members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['pk', 'pk3']], req: T + 310 * H, rip: T + 382 * H, signer: 'pk1' })
  accept('ok/quarantine-carried', 'an unquarantined member adds a key; the quarantined one stays marked',
    a.links, { seq: 6, ripenedAt: T + 382 * H, members: [mem('pk', 'pk1', T + 300 * H), mem('pk', 'pk2', T + 300 * H, true), mem('pk', 'pk3', T + 382 * H)], createdAt: null, lastResetAt: null, sinceExact: false }, a.pin)
  const b = await qChain({ members: [['pk', 'pk1']], req: T + 310 * H, rip: T + 382 * H, signer: 'pk1' })
  accept('ok/quarantined-removed', 'the quarantined member removed after the wait',
    b.links, { seq: 6, ripenedAt: T + 382 * H, members: [mem('pk', 'pk1', T + 300 * H)], createdAt: null, lastResetAt: null, sinceExact: false }, b.pin)
  const c = await qChain({ members: [['pk', 'pk2', 'q']], req: T + 310 * H, rip: T + 382 * H, signer: 'pk1' })
  accept('ok/last-live-member-leaves-after-wait', 'the last unquarantined member removing itself is QUEUED: accepted after the wait',
    c.links, { seq: 6, ripenedAt: T + 382 * H, members: [mem('pk', 'pk2', T + 300 * H, true)], createdAt: null, lastResetAt: null, sinceExact: false }, c.pin)
  const d = await qChain({ members: [['pk', 'pk2', 'q']], req: T + 310 * H, rip: T + 310 * H, signer: 'pk1' })
  reject('wait/last-live-member-leaves-at-once', 'the last unquarantined member may not remove itself at once', d.links, 'unripe', d.pin)
  const e = await qChain({ members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['pk', 'pk3']], req: T + 310 * H, rip: T + 382 * H, signer: 'pk2' })
  reject('signer/quarantined', 'a quarantined member may not ask for a change', e.links, 'quarantined', e.pin)
  const f = await qChain({ members: [['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3']], req: T + 310 * H, rip: T + 382 * H, signer: 'pk1' })
  reject('quarantine/lifted', 'a member link may not lift a quarantine', f.links, 'quarantine', f.pin)
  const g = await qChain({ members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['pk', 'pk3', 'q']], req: T + 310 * H, rip: T + 382 * H, signer: 'pk1' })
  reject('quarantine/new-member-quarantined', 'a new member is never quarantined', g.links, 'quarantine', g.pin)
  const h = await qChain({ members: [['pk', 'pk2', 'q']], req: T + 310 * H, rip: T + 382 * H, signer: 'pk2' })
  reject('signer/quarantined-self-removal', 'a quarantined member may not even remove itself', h.links, 'quarantined', h.pin)
}
{
  const c = await upTo(2, { members: [['pk', 'pk1'], ['pk', 'pk2', 'q']], req: T + 80 * H, rip: T + 152 * H, signer: 'pk1' })
  reject('quarantine/added', 'a member link may not quarantine another member', c, 'quarantine')
}
{
  // 16 members at a pin, one removed: accepted; 17 at a pin: refused
  const sixteen: M[] = Array.from({ length: 16 }, (_, i) => ['pk', `m${i}`] as M)
  const c = await chainOf([{ seq: 9, prev: await sha256b64u('x'), members: sixteen, req: T, rip: T },
    { members: sixteen.slice(1), req: T + 1 * H, rip: T + 73 * H, signer: 'm1' }])
  const st = sixteen.slice(1).map(([, l]) => mem('pk', l, T)).sort((a, b) => (pubOf(a.key) < pubOf(b.key) ? -1 : 1))
  accept('ok/sixteen-members', 'a head may name 16 members', c, { seq: 10, ripenedAt: T + 73 * H, members: st, createdAt: null, lastResetAt: null, sinceExact: false }, await sha256b64u(c[0].ros))
  const c17 = await chainOf([{ seq: 9, prev: await sha256b64u('x'), members: Array.from({ length: 17 }, (_, i) => ['pk', `m${i}`] as M), req: T, rip: T }])
  reject('members/seventeen', 'a head may name at most 16 members', c17, 'members', await sha256b64u(c17[0].ros))
}

// the chain ---------------------------------------------------------------------------
reject('chain/empty', 'no links at all', [], 'grammar')
reject('chain/prev-hash-wrong', "L1's prevHash names some other text", await upTo(1, { ...S1, prev: await sha256b64u('not the setup head') }), 'chain')
{
  // another genuine setup head for the same address (a fork): L1 chains to it, not to the L0 given
  const fork = await chainOf([{ ...S0, dirNonce: nonce(40) }])
  const c = await upTo(1, { ...S1, prev: await sha256b64u(fork[0].ros) })
  reject('chain/wrong-prev', "L1 names a DIFFERENT genuine setup head as its previous", c, 'chain')
}
reject('chain/seq-skip', 'seq jumps from 0 to 2', await upTo(1, { ...S1, seq: 2 }), 'seq')
reject('chain/seq-repeat', 'seq repeats 0', await upTo(1, { ...S1, seq: 0, prev: null }), 'seq')
reject('chain/address-changed', 'a link names another address', await upTo(1, { ...S1, address: 'mallory@example.com' }), 'address')
reject('chain/no-anchor', 'without a pin, the chain must start at setup', full.slice(1, 3), 'anchor')
{
  // the pinned head's countersign sets every member's age, so it is re-checked: a
  // forged one (older ripenedAt) would make a consent key look ripe
  const c = await chainOf([{ ...S0, req: T - 500 * H, rip: T - 500 * H, ripBy: 'dirOther' }])
  reject('chain/pinned-countersign-forged', 'the pinned head arrives with a countersign the pinned directory key did not make', c, 'rip-signature', await sha256b64u(c[0].ros))
}
reject('chain/pin-mismatch', 'the first link is not the pinned head', full.slice(1, 3), 'pin', await sha256b64u(full[2].ros))
reject('chain/reset-replayed-elsewhere', 'L6 lifted onto the chain before the reset', [...full.slice(0, 5), full[6]], 'seq')
reject('order/requested-before-previous-ripened', 'L2 was requested before L1 ripened: one change at a time',
  await upTo(2, { ...S2, req: T + 70 * H, rip: T + 142 * H }), 'order')

// the wait ----------------------------------------------------------------------------
reject('wait/one-second-short', 'ripened 72 h minus one second after the request', await upTo(1, { ...S1, rip: T + 73 * H - 1000 }), 'unripe')
reject('wait/requester-clock-early', "the requester's created is 73 h before ripening but the directory's requestedAt only 1 h: refused (the wait is the directory's)",
  await upTo(1, { ...S1, req: T + 72 * H, rip: T + 73 * H, created: T }), 'unripe')
reject('wait/countersigned-at-request', 'a change countersigned the moment it was asked for (no ripening)', await upTo(1, { ...S1, req: T + 1 * H, rip: T + 1 * H }), 'unripe')
reject('wait/remove-other-at-once', 'only removing ITSELF is immediate: pk1 removing pk2 waits', await upTo(2, { members: [['pk', 'pk1']], req: T + 80 * H, rip: T + 80 * H, signer: 'pk1' }), 'unripe')
reject('wait/add-at-once', 'an addition is never immediate', await upTo(1, { ...S1, rip: T + 1 * H }), 'unripe')
reject('wait/reset-short', 'a reset waits 72 h too', await upTo(5, { ...S5, rip: T + 371 * H }), 'unripe')

// the countersign ---------------------------------------------------------------------
reject('rip/over-other-text', 'the rip. names the hash of a different head', await upTo(1, { ...S1, ripOver: 'ros.something.else' }), 'rip-mismatch')
reject('rip/unknown-kid', 'countersigned by a kid nobody pinned', await upTo(1, { ...S1, kid: 'dir-9', ripBy: 'dirOther' }), 'unknown-kid')
reject('rip/wrong-key', 'countersigned by another key under the pinned kid', await upTo(1, { ...S1, ripBy: 'dirOther' }), 'rip-signature')
reject('rip/high-s', 'the countersign in high-S form (directory statements are low-S only)', await upTo(1, { ...S1, ripHighS: true }), 'rip-signature')
reject('rip/ripened-before-requested', 'ripenedAt before requestedAt', await upTo(1, { ...S1, req: T + 73 * H, rip: T + 1 * H }), 'rip-grammar')
reject('rip/auth-unknown', 'the authority is one of m r q l x u', await upTo(1, { ...S1, ripText: 'rip.' + 'A'.repeat(43) + `.${T + H}.${T + 73 * H}.z.${'A'.repeat(43)}.dir-1` }), 'rip-grammar')
reject('rip/reset-flag-old-form', 'the old reset flag (0|1) is no longer a word', await upTo(1, { ...S1, ripText: 'rip.' + 'A'.repeat(43) + `.${T + H}.${T + 73 * H}.0.dir-1` }), 'rip-grammar')
reject('rip/cause-on-member-change', 'm and r carry an empty cause', await upTo(1, { ...S1, cause: 'A'.repeat(43) }), 'rip-grammar')
reject('rip/cause-not-a-hash', 'q l x u carry a hash as their cause', await upTo(1, { ...S1, auth: 'u', cause: 'short' }), 'rip-grammar')
reject('rip/missing', 'no countersign: a queued change is not in force', await upTo(1, { ...S1, ripText: '' }), 'rip-grammar')
reject('rip/future', 'ripened more than the skew allowance after now', await upTo(1, { ...S1, req: NOW, rip: NOW + 72 * H }), 'not-yet-valid')

// setup and reset ---------------------------------------------------------------------
reject('setup/auth-reset', 'a setup head countersigned as a reset', await chainOf([{ ...S0, reset: true }]), 'auth')
reject('setup/auth-quarantine', 'a setup head countersigned under any word but m', await chainOf([{ ...S0, auth: 'u', cause: await sha256b64u('x') }]), 'auth')
reject('setup/two-members', 'setup has exactly one member', await chainOf([{ ...S0, members: [['pk', 'pk1'], ['pk', 'pk2']] }]), 'setup-members')
reject('setup/consent-key', 'the setup member is a passkey', await chainOf([{ ...S0, members: [['ck', 'ck1']] }]), 'setup-members')
reject('setup/quarantined', 'the setup member is not quarantined', await chainOf([{ ...S0, members: [['pk', 'pk1', 'q']] }]), 'setup-members')
reject('setup/with-proof', 'setup carries no member proof (its authority is the countersign)', await chainOf([{ ...S0, signer: 'pk1' }]), 'proof')
reject('reset/with-proof', 'a reset carries no member proof', await upTo(5, { ...S5, signer: 'pk1' }), 'proof')
reject('reset/two-members', 'a reset installs exactly one passkey', await upTo(5, { ...S5, members: [['pk', 'pk3'], ['pk', 'pk4']] }), 'reset-members')
reject('reset/recovery-key', 'a reset installs a passkey, not a recovery key', await upTo(5, { ...S5, members: [['rk', 'rk2']] }), 'reset-members')

// the signer ----------------------------------------------------------------------------
reject('signer/missing', 'a member change with no signer', await upTo(1, { ...S1, signer: undefined }), 'proof')
reject('signer/missing-with-assertion', 'an assertion but no signer named', await upTo(1, { ...S1, signer: undefined, proof: 'assertion' }), 'proof')
reject('signer/not-a-member', 'pk3 is not in the previous roster', await upTo(1, { ...S1, members: [['pk', 'pk1'], ['pk', 'pk3']], signer: 'pk3' }), 'signer')
reject('signer/adds-itself', 'pk2 asks to add pk2: it is not a member of the PREVIOUS head', await upTo(1, { ...S1, signer: 'pk2' }), 'signer')
reject('signer/consent-key', 'a consent key signing with a bare signature over the ros. text: a ck signs only a cns. (purpose roster)',
  await upTo(4, { members: [['ck', 'ck1'], ['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3'], ['rk', 'rk1']], req: T + 240 * H, rip: T + 312 * H, signer: 'ck1', proof: 'sig' }), 'proof')
reject('proof/passkey-raw-signature', 'a passkey must sign by assertion, not a raw signature', await upTo(1, { ...S1, proof: 'sig' }), 'proof')
reject('proof/passkey-both', 'one proof only', await upTo(1, { ...S1, proof: 'both' }), 'proof')
reject('proof/recovery-key-assertion', 'a recovery key signs raw, not by assertion', await upTo(3, { ...S3, proof: 'assertion' }), 'proof')
reject('proof/recovery-key-both', 'a recovery key with its signature AND an assertion: one proof only', await upTo(3, { ...S3, proof: 'both' }), 'proof')
reject('rk/wrong-signature', 'the recovery-key signature is by another key', await upTo(3, { ...S3, sigBy: 'rk2' }), 'signature')
reject('rk/high-s', 'the recovery-key signature in high-S form', await upTo(3, { ...S3, sigHighS: true }), 'signature')

// the passkey assertion (webauthn.ts, rp id.bento.page, origin the sign-in host) --------
reject('assertion/other-text', 'the assertion covers another statement', await upTo(1, { ...S1, assert: { over: 'ros.other' } }), 'assertion-challenge')
reject('assertion/origin-rp-host', 'asserted from https://id.bento.page (the directory host runs no ceremony)', await upTo(1, { ...S1, assert: { origin: 'https://id.bento.page' } }), 'assertion-origin')
reject('assertion/origin-library', 'asserted from https://home.bento.page', await upTo(1, { ...S1, assert: { origin: 'https://home.bento.page' } }), 'assertion-origin')
reject('assertion/origin-sibling', 'asserted from another host under the rp', await upTo(1, { ...S1, assert: { origin: 'https://x.id.bento.page' } }), 'assertion-origin')
reject('assertion/rp-parent', 'asserted for the parent rp bento.page', await upTo(1, { ...S1, assert: { rpId: 'bento.page' } }), 'assertion-rp')
reject('assertion/uv-clear', 'user verification flag clear', await upTo(1, { ...S1, assert: { flags: 0x01 } }), 'assertion-uv')
reject('assertion/other-key', 'the assertion is by pk3 while pk1 is named', await upTo(1, { ...S1, assert: { by: 'pk3' } }), 'assertion-signature')

// the members grammar ---------------------------------------------------------------------
{
  const tok = (k: string, l: string) => `${k}~${pubOf(l)}`
  const sorted = (...t: string[]) => t.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const [a, b] = sorted(tok('pk', 'pk1'), tok('pk', 'pk2'))
  reject('members/unsorted', 'the same roster with its members out of order', await upTo(1, { ...S1, rawMembers: `${b},${a}` }), 'members')
  reject('members/repeated-token', 'one member written twice', await upTo(1, { ...S1, rawMembers: `${a},${a}` }), 'members')
  const dup = sorted(tok('ck', 'pk2'), tok('pk', 'pk1'), tok('pk', 'pk2'))
  reject('members/duplicate-key', 'one key as two kinds', await upTo(1, { ...S1, rawMembers: dup.join(',') }), 'members')
  reject('members/two-recovery-keys', 'at most one recovery key', await upTo(1, { ...S1, members: [['pk', 'pk1'], ['rk', 'rk1'], ['rk', 'rk2']] }), 'members')
  reject('members/unknown-kind', 'kind is pk, ck or rk', await upTo(1, { ...S1, rawMembers: sorted(tok('pk', 'pk1'), tok('xk', 'pk2')).join(',') }), 'members')
  reject('members/bad-flag', 'the only flag is q', await upTo(1, { ...S1, rawMembers: sorted(tok('pk', 'pk1'), tok('pk', 'pk2') + '~x').join(',') }), 'members')
  reject('members/empty-item', 'an empty member', await upTo(1, { ...S1, rawMembers: `${a},` }), 'members')
  reject('members/off-curve', 'a member key not on the curve', await upTo(1, { ...S1, members: [['pk', 'pk1'], ['pk', 'OFF']] }), 'key')
  reject('members/kind-changed', 'a continuing member changes kind', await upTo(1, { ...S1, members: [['ck', 'pk1'], ['pk', 'pk2']] }), 'members')
}

// one change per link ------------------------------------------------------------------------
reject('change/none', 'a link that changes nothing', await upTo(1, { ...S1, members: [['pk', 'pk1']] }), 'no-change')
reject('change/two-additions', 'two members added in one link', await upTo(1, { ...S1, members: [['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3']] }), 'multi-change')
reject('change/two-removals', 'two members removed in one link',
  await upTo(3, { members: [['pk', 'pk1']], req: T + 160 * H, rip: T + 232 * H, signer: 'pk1' }), 'multi-change')
reject('change/passkey-swapped', 'a passkey removed and another added in one link (only the recovery key is replaced)',
  await upTo(2, { members: [['pk', 'pk1'], ['pk', 'pk3']], req: T + 80 * H, rip: T + 152 * H, signer: 'pk1' }), 'multi-change')

// the ros. grammar --------------------------------------------------------------------------
reject('grammar/nonce-short', 'the directory nonce is 16 to 64 bytes', await upTo(1, { ...S1, dirNonce: b64uEnc(new Uint8Array(15)) }), 'grammar')
reject('grammar/nonce-padded', 'the nonce is canonical base64url', await upTo(1, { ...S1, dirNonce: b64uEnc(new Uint8Array(32)) + '=' }), 'grammar')
reject('grammar/address-not-normal', 'the address is in normal form', await chainOf([{ ...S0, address: 'Alice@Example.com' }]), 'address')
reject('grammar/prev-on-setup', 'a setup head has no prevHash', await chainOf([{ ...S0, prev: await sha256b64u('x') }]), 'prev')
reject('grammar/created-zero', 'created is a positive time', await chainOf([{ ...S0, created: 0 }]), 'grammar')
{
  const c = await upTo(1)
  reject('grammar/extra-field', 'an extra field', await chainOf([{ ...S0, rosText: c[0].ros + '.x' }]), 'grammar')
  reject('grammar/wrong-prefix', 'another prefix', await chainOf([{ ...S0, rosText: 'ros2' + c[0].ros.slice(3) }]), 'grammar')
}

// --- security's rows from the review of the first roster change ------------------------------
{
  const rm: Spec = { members: [['pk', 'pk1']], req: T + 80 * H, rip: T + 152 * H, signer: 'pk1' }
  const readd: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2']], req: T + 160 * H, rip: T + 232 * H, signer: 'pk1' }
  accept('since/readded-age-restarts', 'pk2 removed then added again: its age restarts at the second addition, never its first', await chainOf([S0, S1, rm, readd]),
    { seq: 3, ripenedAt: T + 232 * H, members: [mem('pk', 'pk1', T), mem('pk', 'pk2', T + 232 * H)], createdAt: T, lastResetAt: null, sinceExact: true })
  reject('chain/reset-prev-wrong', 'a reset whose prevHash names another head (a reset is chained like any link)', await upTo(5, { ...S5, prev: await sha256b64u('another head') }), 'chain')
  accept('order/requested-at-previous-ripening', 'requested in the same millisecond the previous change ripened: allowed',
    await upTo(2, { ...S2, req: T + 73 * H, rip: T + 145 * H }),
    { seq: 2, ripenedAt: T + 145 * H, members: [mem('pk', 'pk1', T), mem('pk', 'pk2', T + 73 * H), mem('rk', 'rk1', T + 145 * H)], createdAt: T, lastResetAt: null, sinceExact: true })
  accept('assertion/sign-counts-not-tracked', 'pk1 signs with count 10, later with count 5: a peer sees links out of signing order, so no stored count is kept',
    await chainOf([S0, { ...S1, assert: { count: 10 } }, { ...rm, assert: { count: 5 } }]),
    { seq: 2, ripenedAt: T + 152 * H, members: [mem('pk', 'pk1', T)], createdAt: T, lastResetAt: null, sinceExact: true })
  const bob = await chainOf([{ ...S0, address: 'bob@example.com' }, { ...S1, address: 'bob@example.com' }])
  reject('chain/link-from-other-account', "another account's genuine ripened link spliced after this setup", [(await upTo(1))[0], bob[1]], 'address')
  accept('rip/second-kid', 'countersigned by the second pinned key under its own kid', await upTo(1, { ...S1, kid: 'dir-2', ripBy: 'dir2' }),
    { seq: 1, ripenedAt: T + 73 * H, members: [mem('pk', 'pk1', T), mem('pk', 'pk2', T + 73 * H)], createdAt: T, lastResetAt: null, sinceExact: true })
  reject('rip/other-pinned-kid', "signed by dir-2's key but naming kid dir-1: the kid picks the key", await upTo(1, { ...S1, ripBy: 'dir2' }), 'rip-signature')
}

// --- the directory's acts on the mailbox's authority: q l x u --------------------------------
//
// From L2 ({pk1, pk2, rk1}, ripened T+152h): pk2 asks to add pk3; the person voids it with
// "Cancel, and remove the passkey that asked" (q, immediate), the removal ripens 72 h later (x),
// or the person undoes it from the removal's own mail (u).
const B3 = BASE.slice(0, 3)
const VOIDED = { members: [['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3'], ['rk', 'rk1']] as M[], signer: 'pk2' }
const QS: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['rk', 'rk1']], req: T + 160 * H, rip: T + 160 * H, auth: 'q', voided: VOIDED }
const XS: Spec = { members: [['pk', 'pk1'], ['rk', 'rk1']], req: T + 160 * H, rip: T + 232 * H, auth: 'x' }
const US: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 170 * H, rip: T + 170 * H, auth: 'u' }
const fromB3 = (...more: Spec[]) => chainOf([...B3, ...more])
const afterQ = { pk1: mem('pk', 'pk1', T), pk2q: mem('pk', 'pk2', T + 73 * H, true), rk1: mem('rk', 'rk1', T + 152 * H) }
{
  accept('ok/q-quarantine', 'a void quarantines the member that asked, at once; it carries the voided request',
    await fromB3(QS), { seq: 3, ripenedAt: T + 160 * H, members: [afterQ.pk1, afterQ.pk2q, afterQ.rk1], createdAt: T, lastResetAt: null, sinceExact: true })
  accept('ok/q-voided-by-recovery-key', 'the voided request was signed by the recovery key',
    await fromB3({ ...QS, members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1', 'q']], voided: { members: [['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3'], ['rk', 'rk1']], signer: 'rk1' } }),
    { seq: 3, ripenedAt: T + 160 * H, members: [afterQ.pk1, mem('pk', 'pk2', T + 73 * H), mem('rk', 'rk1', T + 152 * H, true)], createdAt: T, lastResetAt: null, sinceExact: true })
  accept('ok/q-then-x', 'the quarantined member is removed 72 h after the quarantine, as queued in the same step',
    await fromB3(QS, XS), { seq: 4, ripenedAt: T + 232 * H, members: [afterQ.pk1, afterQ.rk1], createdAt: T, lastResetAt: null, sinceExact: true })
  accept('ok/q-then-u', 'the undo lifts the quarantine; the member keeps the time it joined',
    await fromB3(QS, US), { seq: 4, ripenedAt: T + 170 * H, members: [afterQ.pk1, mem('pk', 'pk2', T + 73 * H), afterQ.rk1], createdAt: T, lastResetAt: null, sinceExact: true })
  const qx = await fromB3(QS, XS)
  accept('ok/pinned-q-then-x', 'from a pin of the quarantine link: its word is re-read, so the removal may follow',
    qx.slice(3), { seq: 4, ripenedAt: T + 232 * H, members: [mem('pk', 'pk1', T + 160 * H), mem('rk', 'rk1', T + 160 * H)], createdAt: null, lastResetAt: null, sinceExact: false },
    await sha256b64u(qx[3].ros))

  reject('q/no-voided-request', 'a quarantine that does not carry the request it voided', await fromB3({ ...QS, voided: undefined, cause: await sha256b64u('x') }), 'voided')
  reject('q/cause-wrong', 'the cause names another text than the voided request', await fromB3({ ...QS, cause: await sha256b64u('some other request') }), 'cause')
  reject('q/voided-prev-wrong', 'the voided request was asked against another head', await fromB3({ ...QS, voided: { ...VOIDED, prev: await sha256b64u('another head') } }), 'voided-prev')
  reject('q/voided-signer-not-member', 'the voided request is signed by a key outside the previous roster',
    await fromB3({ ...QS, voided: { ...VOIDED, signer: 'pk4' } }), 'voided-signer')
  reject('q/voided-bad-proof', 'the voided request carries an assertion by another key', await fromB3({ ...QS, voided: { ...VOIDED, assert: { by: 'pk3' } } }), 'voided-assertion-signature')
  reject('q/voided-other-origin', 'the voided request was asserted from the library, not the sign-in host',
    await fromB3({ ...QS, voided: { ...VOIDED, assert: { origin: 'https://home.bento.page' } } }), 'voided-assertion-origin')
  reject('q/wrong-target', 'pk2 asked, but the link quarantines pk1', await fromB3({ ...QS, members: [['pk', 'pk1', 'q'], ['pk', 'pk2'], ['rk', 'rk1']] }), 'target')
  reject('q/also-removes', 'the quarantine also removes the recovery key', await fromB3({ ...QS, members: [['pk', 'pk1'], ['pk', 'pk2', 'q']] }), 'target')
  reject('q/also-adds', 'the quarantine also adds the key the voided request asked for', await fromB3({ ...QS, members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['pk', 'pk3'], ['rk', 'rk1']] }), 'target')
  reject('q/with-member-proof', 'a directory act carries no member proof of its own', await fromB3({ ...QS, signer: 'pk1' }), 'proof')
  reject('q/carries-cited', 'a quarantine carries the voided request only', await fromB3({ ...QS, cited: { prevRos: 'a', ros: 'b', rip: 'c', ripSig: 'd' } }), 'proof')
  reject('q/voided-consent-key', 'a voided request signed by a consent key with a bare signature, not a cns.',
    await chainOf([...BASE.slice(0, 4), { members: [['ck', 'ck1', 'q'], ['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 240 * H, rip: T + 240 * H, auth: 'q',
      voided: { members: [['ck', 'ck1'], ['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3'], ['rk', 'rk1']], signer: 'ck1', proof: 'sig' } }]), 'voided-proof')
  {
    const tok = (k: string, l: string, q = '') => `${k}~${pubOf(l)}${q}`
    const raw = [tok('ck', 'pk2', '~q'), tok('pk', 'pk1'), tok('rk', 'rk1')].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',')
    reject('q/kind-changed', 'the quarantined member also changes kind', await fromB3({ ...QS, rawMembers: raw }), 'members')
  }
  const a = await qChain({ members: [['pk', 'pk1'], ['pk', 'pk2', 'q']], req: T + 310 * H, rip: T + 310 * H, auth: 'q',
    voided: { members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['pk', 'pk3']], signer: 'pk2' } })
  reject('q/voided-quarantined-signer', 'the voided request is by a member already quarantined', a.links, 'voided-quarantined', a.pin)
  const b = await qChain({ members: [['pk', 'pk1', 'q'], ['pk', 'pk2', 'q']], req: T + 310 * H, rip: T + 310 * H, auth: 'q',
    voided: { members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['pk', 'pk3']], signer: 'pk1' } })
  reject('q/last-live', 'quarantining the last unquarantined member', b.links, 'last-live', b.pin)
  reject('m/carries-voided', 'a member change carries no voided request', await fromB3({ ...S3, members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1'], ['ck', 'ck1']], signer: 'pk1', voided: VOIDED }), 'proof')

  // x and u
  reject('x/after-member-change', 'a removal on the directory word must follow a q or l link', await upTo(3, { members: [['pk', 'pk1'], ['pk', 'pk2']], req: T + 152 * H, rip: T + 224 * H, auth: 'x' }), 'auth')
  reject('x/cause-wrong', 'the removal cites another head', await fromB3(QS, { ...XS, cause: await sha256b64u('another head') }), 'cause')
  reject('x/short', 'the removal ripened 72 h minus one second after the quarantine', await fromB3(QS, { ...XS, rip: T + 232 * H - 1000 }), 'unripe')
  reject('x/requested-later', 'the removal was not queued in the same step as the quarantine', await fromB3(QS, { ...XS, req: T + 161 * H, rip: T + 233 * H }), 'order')
  reject('x/removes-unquarantined', 'the removal takes a member that is not quarantined', await fromB3(QS, { ...XS, members: [['pk', 'pk2', 'q'], ['rk', 'rk1']] }), 'target')
  reject('x/adds', 'the directory adds a member in place of the one it removes (never on its own authority)', await fromB3(QS, { ...XS, members: [['pk', 'pk1'], ['pk', 'pk3'], ['rk', 'rk1']] }), 'target')
  reject('x/with-member-proof', 'a removal carries no member proof', await fromB3(QS, { ...XS, signer: 'pk1' }), 'proof')
  reject('x/carries-voided', 'a removal carries no voided request', await fromB3(QS, { ...XS, voided: VOIDED }), 'proof')
  reject('u/carries-cited', 'an undo carries no cited change', await fromB3(QS, { ...US, cited: { prevRos: 'a', ros: 'b', rip: 'c', ripSig: 'd' } }), 'proof')
  reject('u/after-member-change', 'an undo must follow a q or l link', await upTo(3, { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 152 * H, rip: T + 152 * H, auth: 'u' }), 'auth')
  reject('u/after-removal', 'an undo after the removal ripened: too late (the member is gone)', await fromB3(QS, XS, { members: [['pk', 'pk1'], ['rk', 'rk1']], req: T + 240 * H, rip: T + 240 * H, auth: 'u' }), 'auth')
  reject('u/adds-member', 'an undo that adds a member instead (the directory never adds)', await fromB3(QS, { ...US, members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['pk', 'pk3'], ['rk', 'rk1']] }), 'target')
  reject('u/clears-and-removes', 'an undo that also removes the recovery key', await fromB3(QS, { ...US, members: [['pk', 'pk1'], ['pk', 'pk2']] }), 'target')
  reject('u/cause-wrong', 'the undo cites another head', await fromB3(QS, { ...US, cause: await sha256b64u('another head') }), 'cause')
}
{
  // l: the incident lever reverts L1 (pk1 added pk2) by quarantining pk2. The cited link is
  // self-contained, so it verifies from any pin.
  const base = await upTo(3)
  const cite = (i: number, c: Link[] = base) => ({ prevRos: c[i - 1].ros, ros: c[i].ros, rip: c[i].rip, ripSig: c[i].ripSig })
  const LS: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['rk', 'rk1']], req: T + 160 * H, rip: T + 160 * H, auth: 'l', cited: cite(1) }
  accept('ok/l-revert', 'the lever quarantines the member a ripened change ADDED, citing that change',
    await fromB3(LS), { seq: 3, ripenedAt: T + 160 * H, members: [afterQ.pk1, afterQ.pk2q, afterQ.rk1], createdAt: T, lastResetAt: null, sinceExact: true })
  accept('ok/l-then-x', 'and removes it 72 h later', await fromB3(LS, XS),
    { seq: 4, ripenedAt: T + 232 * H, members: [afterQ.pk1, afterQ.rk1], createdAt: T, lastResetAt: null, sinceExact: true })
  accept('ok/l-then-u', 'or undoes it', await fromB3(LS, US),
    { seq: 4, ripenedAt: T + 170 * H, members: [afterQ.pk1, mem('pk', 'pk2', T + 73 * H), afterQ.rk1], createdAt: T, lastResetAt: null, sinceExact: true })
  reject('l/no-cited', 'a revert that cites nothing', await fromB3({ ...LS, cited: undefined, cause: await sha256b64u('x') }), 'cited')
  reject('l/cause-wrong', 'the cause names another text than the cited change', await fromB3({ ...LS, cause: await sha256b64u('x') }), 'cause')
  const forged = await chainOf([S0, { ...S1, ripBy: 'dirOther' }])
  reject('l/cited-not-countersigned', 'the cited change carries a countersign no pinned key made', await fromB3({ ...LS, cited: cite(1, forged) }), 'cited-rip-signature')
  const bob = await chainOf([{ ...S0, address: 'bob@example.com' }, { ...S1, address: 'bob@example.com' }])
  reject('l/cited-other-account', "the cited change added the same key on ANOTHER account", await fromB3({ ...LS, cited: cite(1, bob) }), 'cited-address')
  reject('l/cited-not-chained', 'the cited previous head is not the one the change names', await fromB3({ ...LS, cited: { ...cite(1), prevRos: base[1].ros } }), 'cited-chain')
  const full5 = await upTo(5)
  reject('l/cited-removal', 'the cited change removed a member rather than adding one', await fromB3({ ...LS, cited: cite(4, full5) }), 'cited-change')
  reject('l/cited-setup', 'the setup head is not a change that added a member', await fromB3({ ...LS, cited: { prevRos: base[0].ros, ros: base[0].ros, rip: base[0].rip, ripSig: base[0].ripSig } }), 'cited-chain')
  reject('l/wrong-target', 'the cited change added pk2, but the link quarantines pk1', await fromB3({ ...LS, members: [['pk', 'pk1', 'q'], ['pk', 'pk2'], ['rk', 'rk1']] }), 'target')
  reject('l/also-removes', 'the revert also removes a member', await fromB3({ ...LS, members: [['pk', 'pk1'], ['pk', 'pk2', 'q']] }), 'target')
  reject('l/carries-voided', 'a revert carries the cited change only', await fromB3({ ...LS, voided: VOIDED }), 'proof')
}

// --- security's rows from the review of the authority word (#925): C1′, the x/u target rule (C4), nits -------
{
  const base = await upTo(3)
  const cite = (i: number, c: Link[] = base) => ({ prevRos: c[i - 1].ros, ros: c[i].ros, rip: c[i].rip, ripSig: c[i].ripSig })
  const LS: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['rk', 'rk1']], req: T + 160 * H, rip: T + 160 * H, auth: 'l', cited: cite(1) }
  const withCited = (cited: Spec['cited'], members?: M[]): Spec => ({ ...LS, cited, ...(members ? { members } : {}) })

  // C1′: the cited change is genuine, ripe and for this account, and says only "one member added"
  const unk = await chainOf([S0, { ...S1, kid: 'dir-9', ripBy: 'dirOther' }])
  reject('l/cited-unknown-kid', 'the cited change is countersigned under a kid nobody pinned', await fromB3(withCited(cite(1, unk))), 'cited-unknown-kid')
  const fut = await chainOf([S0, { ...S1, req: NOW, rip: NOW + 72 * H }])
  reject('l/cited-future', 'the cited change ripens after now', await fromB3(withCited(cite(1, fut))), 'cited-not-yet-valid')
  const am = await chainOf([{ seq: 7, prev: await sha256b64u('x'), members: [['pk', 'pk1']], req: T, rip: T },
    { members: [['pk', 'pk1', 'q'], ['pk', 'pk2']], req: T + H, rip: T + 73 * H }])
  reject('l/cited-adds-and-marks', 'the cited change adds a member and also marks another', await fromB3(withCited(cite(1, am))), 'cited-change')
  {
    const bros = await chainOf([{ ...S1, seq: 1, address: 'bob@example.com', prev: await sha256b64u(base[0].ros) }])
    reject('l/cited-ros-other-account', "the cited ros. names bob, though its previous head is alice's (the address is read from the cited head)",
      await fromB3(withCited({ prevRos: base[0].ros, ros: bros[0].ros, rip: bros[0].rip, ripSig: bros[0].ripSig })), 'cited-address')
  }
  const kc = await chainOf([{ seq: 7, prev: await sha256b64u('y'), members: [['pk', 'pk1'], ['rk', 'rk1']], req: T, rip: T },
    { members: [['ck', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + H, rip: T + 73 * H }])
  reject('l/cited-kind-changed', 'the cited change adds pk2 and also changes a continuing member\'s kind', await fromB3(withCited(cite(1, kc))), 'cited-change')
  const cu = await chainOf([S0, { ...S1, signer: undefined, auth: 'u', cause: 'prev' }])
  reject('l/cited-not-member-change', 'the cited link was countersigned under the word u, not m: only a member\'s change is reverted',
    await fromB3(withCited(cite(1, cu))), 'cited-auth')

  // nits: the voided request is for this account and the next seq
  reject('q/voided-other-address', 'the voided request names another address (with the right previous hash)',
    await fromB3({ ...QS, voided: { ...VOIDED, address: 'bob@example.com' } }), 'voided-address')
  reject('q/voided-seq-wrong', 'the voided request names a seq other than the previous head\'s + 1 (with the right previous hash)',
    await fromB3({ ...QS, voided: { ...VOIDED, seq: 4 } }), 'voided-seq')

  // the second quarantine: after q(pk2), rk1's request is voided too, so two marks stand
  const Q2: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['rk', 'rk1', 'q']], req: T + 165 * H, rip: T + 165 * H, auth: 'q',
    voided: { members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['pk', 'pk4'], ['rk', 'rk1']], signer: 'rk1' } }
  const X2: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2', 'q']], req: T + 165 * H, rip: T + 237 * H, auth: 'x' }

  // C1′: x and u change their target and nothing else
  reject('x/also-clears', 'the removal of the target also lifts another (stale) quarantine', await fromB3(QS, Q2, { ...X2, members: [['pk', 'pk1'], ['pk', 'pk2']] }), 'target')
  reject('x/also-marks', 'a removal that also quarantines another member', await fromB3(QS, { ...XS, members: [['pk', 'pk1', 'q'], ['rk', 'rk1']] }), 'target')
  reject('u/also-marks', 'an undo that also quarantines another member', await fromB3(QS, { ...US, members: [['pk', 'pk1', 'q'], ['pk', 'pk2'], ['rk', 'rk1']] }), 'target')
  reject('u/signed-by-quarantined', 'the quarantined member signs its own undo (a directory act carries no member proof)', await fromB3(QS, { ...US, signer: 'pk2' }), 'proof')

  // C4: x removes, and u clears, exactly the member the previous q or l marked
  accept('ok/q-then-q-then-x', 'two quarantines in a row are legal; the removal takes the LATEST one\'s target, the older mark stands',
    await fromB3(QS, Q2, X2), { seq: 5, ripenedAt: T + 237 * H, members: [afterQ.pk1, afterQ.pk2q], createdAt: T, lastResetAt: null, sinceExact: true })
  reject('u/clears-stale-mark', 'q(pk2), q(rk1), then an undo clears pk2: not the member the previous link marked',
    await fromB3(QS, Q2, { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1', 'q']], req: T + 170 * H, rip: T + 170 * H, auth: 'u' }), 'target')
  reject('x/removes-stale-mark', 'q(pk2), q(rk1), then a removal takes pk2: not the member the previous link marked',
    await fromB3(QS, Q2, { members: [['pk', 'pk1'], ['rk', 'rk1', 'q']], req: T + 165 * H, rip: T + 237 * H, auth: 'x' }), 'target')
  {
    const c = await fromB3(QS, Q2, { members: [['pk', 'pk1'], ['rk', 'rk1', 'q']], req: T + 165 * H, rip: T + 237 * H, auth: 'x' })
    reject('x/pinned-removes-stale-mark', 'from a pin of q(rk1): the removal takes pk2; the pinned link\'s evidence names rk1', c.slice(4), 'target', await sha256b64u(c[4].ros))
    const ok = await fromB3(QS, Q2, X2)
    accept('ok/pinned-q-then-x-target', 'from a pin of q(rk1): the removal of rk1, the target its evidence names',
      ok.slice(4), { seq: 5, ripenedAt: T + 237 * H, members: [mem('pk', 'pk1', T + 165 * H), mem('pk', 'pk2', T + 165 * H, true)], createdAt: null, lastResetAt: null, sinceExact: false },
      await sha256b64u(ok[4].ros))
    // the pinned q(rk1) link carries q(pk2)'s voided request instead of its own: the cause does not match
    const swapped = [{ ...c[4], voided: ok[3].voided }, c[5]]
    reject('x/pinned-evidence-cause-wrong', 'the pinned q(rk1) link carries ANOTHER voided request (naming pk2), and the removal takes pk2: evidence not matching the cause names no target',
      swapped, 'evidence', await sha256b64u(c[4].ros))
  }
  {
    // C4′: from a pin, every part of the evidence that names the target is re-bound, not just the cause
    const c = await fromB3(QS, Q2, { members: [['pk', 'pk1'], ['rk', 'rk1', 'q']], req: T + 165 * H, rip: T + 237 * H, auth: 'x' })
    const swapped = [{ ...c[4], voided: { ...c[4].voided!, signer: pubOf('pk2') } }, c[5]]
    reject('x/pinned-q-signer-swapped', "the pinned q(rk1) link's voided.signer (a field the cause does not cover) rewritten to pk2; the removal takes pk2: its proof does not verify, so no target",
      swapped, 'evidence', await sha256b64u(c[4].ros))
    // a well-formed voided request by pk2 for the same head, but not the one the cause names
    const other = await fromB3(QS, { ...Q2, voided: { members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['pk', 'pk3'], ['rk', 'rk1']], signer: 'pk2' } })
    reject('x/pinned-evidence-other-request', 'the pinned q(rk1) link carries a well-formed request by pk2 for the same head and seq, not the one its cause names; the removal takes pk2',
      [{ ...c[4], voided: other[4].voided }, c[5]], 'evidence', await sha256b64u(c[4].ros))
    // q(pk2), then l(rk1) citing L1→L2 (which added rk1); pin the l link; the undo clears the stale pk2
    const LQ: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['rk', 'rk1', 'q']], req: T + 161 * H, rip: T + 161 * H, auth: 'l', cited: cite(2) }
    const UQ: Spec = { members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1', 'q']], req: T + 162 * H, rip: T + 162 * H, auth: 'u' }
    const lq = await fromB3(QS, LQ, UQ)
    reject('u/pinned-l-clears-stale-mark', 'from a pin of l(rk1), with honest evidence, the undo clears the stale pk2', lq.slice(4), 'target', await sha256b64u(lq[4].ros))
    const forged = buildRos({ address: ADDRESS, seq: 1, prev: await sha256b64u(lq[0].ros),
      members: [['pk', 'pk1'], ['rk', 'rk1']].map(([k, l]) => ({ kind: k as MemberKind, pub: pubOf(l), quarantined: false })), dirNonce: nonce(99), created: T })
    reject('u/pinned-l-prevros-swapped', "the pinned l(rk1) link's cited.prevRos (a field the cause does not cover) swapped so the cited diff 'adds' pk2; the undo clears pk2: the prevRos does not chain, so no target",
      [{ ...lq[4], cited: { ...lq[4].cited!, prevRos: forged } }, lq[5]], 'evidence', await sha256b64u(lq[4].ros))
  }
  {
    const qx = await fromB3(QS, XS)
    const bare = { ...qx[3] }; delete bare.voided
    reject('x/pinned-q-without-evidence', 'from a pin of the quarantine link stored WITHOUT its voided request: the removal cannot be placed (refetch the link whole)',
      [bare, qx[4]], 'evidence', await sha256b64u(qx[3].ros))
    const lu = await fromB3(LS, US)
    accept('ok/pinned-l-then-u', 'from a pin of the revert link: its target comes from the cited change it carries, so the undo may follow',
      lu.slice(3), { seq: 4, ripenedAt: T + 170 * H, members: [mem('pk', 'pk1', T + 160 * H), mem('pk', 'pk2', T + 160 * H), mem('rk', 'rk1', T + 160 * H)], createdAt: null, lastResetAt: null, sinceExact: false },
      await sha256b64u(lu[3].ros))
    const lbare = { ...lu[3] }; delete lbare.cited
    reject('u/pinned-l-without-evidence', 'from a pin of the revert link stored WITHOUT its cited change: the undo cannot be placed',
      [lbare, lu[4]], 'evidence', await sha256b64u(lu[3].ros))
    // a pinned l whose cited change adds a DIFFERENT member than the one marked: the undo of pk2 has no target
    const lwrong = { ...lu[3], cited: cite(2) }
    // q(pk2) stands; then the lever reverts L2 (which added rk1): the undo must clear rk1, the l link's target, not the stale pk2
    accept('ok/q-then-l-then-u', 'a stale mark stands (pk2) when the lever marks rk1; the undo clears rk1, the revert\'s target',
      await fromB3(QS, { members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['rk', 'rk1', 'q']], req: T + 165 * H, rip: T + 165 * H, auth: 'l', cited: cite(2) },
        { members: [['pk', 'pk1'], ['pk', 'pk2', 'q'], ['rk', 'rk1']], req: T + 170 * H, rip: T + 170 * H, auth: 'u' }),
      { seq: 5, ripenedAt: T + 170 * H, members: [afterQ.pk1, afterQ.pk2q, afterQ.rk1], createdAt: T, lastResetAt: null, sinceExact: true })
    // a pinned q link whose head does NOT mark the member its evidence names (a link no verifier would have pinned,
    // countersigned by the directory key): the removal of that unquarantined member is still refused
    const qbad = await fromB3({ ...QS, members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1', 'q']] }, { ...XS, members: [['pk', 'pk1'], ['rk', 'rk1', 'q']] })
    reject('x/pinned-target-not-quarantined', 'a pinned q link names pk2 as its target but its head left pk2 unmarked: the removal of pk2 is refused',
      qbad.slice(3), 'target', await sha256b64u(qbad[3].ros))
    reject('u/pinned-l-evidence-cause-wrong', 'the pinned revert link carries another cited change (L2 added rk1), so its cause does not match',
      [lwrong, lu[4]], 'evidence', await sha256b64u(lu[3].ros))
  }
}

// --- consent keys (KG3): a ck as the requester, and the co-sign that skips the wait ----------
//
// B4 = L0..L3: ck1 joined at L3 (ripened T+232h), so it is ripe from T+304h on.
{
  const B4 = BASE.slice(0, 4)
  const on = (...more: Spec[]) => chainOf([...B4, ...more])
  const PLUS_PK3: M[] = [['ck', 'ck1'], ['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3'], ['rk', 'rk1']]
  const atL3 = { pk1: mem('pk', 'pk1', T), pk2: mem('pk', 'pk2', T + 73 * H), rk1: mem('rk', 'rk1', T + 152 * H), ck1: mem('ck', 'ck1', T + 232 * H) }
  const st = (seq: number, at: number, extra: ReturnType<typeof mem>[], base = [atL3.pk1, atL3.pk2, atL3.rk1, atL3.ck1]) =>
    ({ seq, ripenedAt: at, members: [...base, ...extra], createdAt: T, lastResetAt: null, sinceExact: true })
  const ck = (req: number, rip: number, more: Partial<Spec> = {}): Spec => ({ members: PLUS_PK3, req, rip, signer: 'ck1', ...more })
  const co = (req: number, rip: number, more: Partial<Spec> = {}): Spec => ({ members: PLUS_PK3, req, rip, signer: 'pk1', co: { signer: 'ck1' }, ...more })
  const R4 = T + 304 * H   // ck1 exactly 72 h a member

  // the ck as the requester
  accept('ok/ck-requests-with-wait', 'an unripe consent key (8 h a member) asks to add pk3; the change waits 72 h like any other',
    await on(ck(T + 240 * H, T + 312 * H)), st(4, T + 312 * H, [mem('pk', 'pk3', T + 312 * H)]))
  reject('ck/unripe-at-once', 'the same unripe consent key, ripened at once: the wait is not skipped', await on(ck(T + 240 * H, T + 240 * H)), 'unripe')
  accept('ok/ck-ripe-at-once', 'a consent key exactly 72 h a member (at the directory\'s requestedAt) asks: no wait',
    await on(ck(R4, R4)), st(4, R4, [mem('pk', 'pk3', R4)]))
  reject('ck/ripe-one-second-short', 'the consent key is 72 h less one second a member at the request: the wait applies', await on(ck(R4 - 1000, R4 - 1000)), 'unripe')
  reject('ck/cns-and-assertion', 'a ck proof is its cns. alone, never with an assertion', await on(ck(R4, R4, { proof: 'cns+assertion' })), 'proof')
  reject('ck/cns-expired', 'the cns. expired at the directory\'s requestedAt', await on(ck(R4, R4, { cns: { exp: R4 } })), 'consent-expired')
  reject('ck/cns-long-life', 'the cns. lives longer than 5 minutes plus the skew from the request', await on(ck(R4, R4, { cns: { life: 10 * 60_000 + 1 } })), 'consent-lifetime')
  reject('ck/cns-other-purpose', 'the cns. carries purpose web-add (a browser approval), not roster', await on(ck(R4, R4, { cns: { purpose: 'web-add' } })), 'consent-purpose')
  reject('ck/cns-link-purpose', 'the cns. carries K2\'s purpose link', await on(ck(R4, R4, { cns: { purpose: 'link' } })), 'consent-purpose')
  reject('ck/cns-reserved-purpose', 'the cns. carries the reserved purpose grant', await on(ck(R4, R4, { cns: { purpose: 'grant' } })), 'consent-reserved-purpose')
  reject('ck/cns-other-rp', 'the cns. names another rp', await on(ck(R4, R4, { cns: { rp: 'vault-acme' } })), 'consent-rp')
  reject('ck/cns-other-text', 'the cns. covers another ros. text', await on(ck(R4, R4, { cns: { over: 'ros.another' } })), 'consent-transcript')
  reject('ck/cns-other-audience', 'the cns. was made for a room, not the directory', await on(ck(R4, R4, { cns: { audience: 'room:w' + 'A'.repeat(43) } })), 'consent-transcript')
  reject('ck/cns-other-challenge', 'the cns. is bound to another challenge than the head\'s dirNonce', await on(ck(R4, R4, { cns: { challenge: nonce(77) } })), 'consent-transcript')
  reject('ck/cns-doc-scoped', 'the cns. names a document', await on(ck(R4, R4, { cns: { docId: 'doc-1' } })), 'consent-grammar')
  reject('ck/cns-wrong-key', 'the cns. is signed by ck2 while ck1 asks', await on(ck(R4, R4, { cns: { by: 'ck2' } })), 'consent-signature')
  reject('ck/cns-high-s', 'the cns. signature in high-S form', await on(ck(R4, R4, { cns: { highS: true } })), 'consent-signature')

  // the co-sign (security's ruling on #917, item 4)
  accept('ok/cosign-skips-wait', 'pk1 asks to add pk3 and ripe ck1 co-signs: in force at once',
    await on(co(T + 310 * H, T + 310 * H)), st(4, T + 310 * H, [mem('pk', 'pk3', T + 310 * H)]))
  accept('ok/cosign-exactly-72h', 'the co-signer is exactly 72 h a member at the request', await on(co(R4, R4)), st(4, R4, [mem('pk', 'pk3', R4)]))
  accept('ok/cosign-rk-requester', 'the recovery key asks and ripe ck1 co-signs: at once', await on(co(R4, R4, { signer: 'rk1' })), st(4, R4, [mem('pk', 'pk3', R4)]))
  reject('cosign/unripe', 'the co-signer is 68 h a member', await on(co(T + 300 * H, T + 300 * H)), 'cosign-unripe')
  reject('cosign/one-second-short', 'the co-signer is 72 h less one second a member', await on(co(R4 - 1000, R4 - 1000)), 'cosign-unripe')
  reject('cosign/age-from-requester-clock', 'the requester\'s created says 168 h after ck1 joined, the directory\'s requestedAt only 68 h: the age is the directory\'s',
    await on(co(T + 300 * H, T + 300 * H, { created: T + 400 * H })), 'cosign-unripe')
  reject('cosign/by-passkey', 'a passkey cannot co-sign (a browser never skips the wait)', await on(co(R4, R4, { co: { signer: 'pk2' } })), 'cosign-kind')
  reject('cosign/by-recovery-key', 'a recovery key cannot co-sign', await on(co(R4, R4, { co: { signer: 'rk1' } })), 'cosign-kind')
  reject('cosign/by-requester', 'the requesting ck co-signs its own request', await on(co(R4, R4, { signer: 'ck1' })), 'cosign')
  reject('cosign/not-member', 'ck2 is not on the roster', await on(co(R4, R4, { co: { signer: 'ck2' } })), 'cosign-signer')
  reject('cosign/adds-itself', 'the change adds ck2, and ck2 co-signs it: not a member of the PREVIOUS head',
    await on(co(R4, R4, { members: [['ck', 'ck1'], ['ck', 'ck2'], ['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], co: { signer: 'ck2' } })), 'cosign-signer')
  reject('cosign/quarantined', 'ck1 was quarantined (its own request voided) before it co-signs',
    await on({ members: [['ck', 'ck1', 'q'], ['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 240 * H, rip: T + 240 * H, auth: 'q',
      voided: { members: PLUS_PK3, signer: 'ck1' } },
    { members: [['ck', 'ck1', 'q'], ['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3'], ['rk', 'rk1']], req: T + 310 * H, rip: T + 310 * H, signer: 'pk1', co: { signer: 'ck1' } }), 'cosign-quarantined')
  reject('cosign/other-text', 'the co-sign covers another ros. text', await on(co(R4, R4, { co: { signer: 'ck1', over: 'ros.another' } })), 'cosign-consent-transcript')
  reject('cosign/expired', 'the co-sign expired at the request', await on(co(R4, R4, { co: { signer: 'ck1', exp: R4 } })), 'cosign-consent-expired')
  reject('cosign/wrong-key', 'the co-sign names ck1 but ck2 signed it', await on(co(R4, R4, { co: { signer: 'ck1', by: 'ck2' } })), 'cosign-consent-signature')
  reject('cosign/other-purpose', 'the co-sign carries purpose web-add', await on(co(R4, R4, { co: { signer: 'ck1', purpose: 'web-add' } })), 'cosign-consent-purpose')
  reject('cosign/on-reset', 'a reset carries no member proof, a co-sign included',
    await on({ members: [['pk', 'pk3']], req: T + 240 * H, rip: T + 312 * H, reset: true, co: { signer: 'ck1' } }), 'proof')
  reject('cosign/on-quarantine', 'a directory act carries no co-sign',
    await on({ members: [['ck', 'ck1'], ['pk', 'pk1'], ['pk', 'pk2', 'q'], ['rk', 'rk1']], req: T + 310 * H, rip: T + 310 * H, auth: 'q',
      voided: { members: PLUS_PK3, signer: 'pk2' }, co: { signer: 'ck1' } }), 'proof')
  {
    // from a pin of L4 (T+240h), ck1's since is the pin's ripenedAt: a lower bound on its age, so the check only refuses more
    const c = await chainOf([...BASE.slice(0, 5), { members: [['ck', 'ck1'], ['pk', 'pk1'], ['pk', 'pk3'], ['rk', 'rk1']], req: T + 310 * H, rip: T + 310 * H, signer: 'pk1', co: { signer: 'ck1' } }])
    reject('cosign/pinned-age-lower-bound', 'from a pin of L4, ck1 counts as a member since T+240h: at T+310h it is not ripe (truly it is, since T+304h)',
      c.slice(4), 'cosign-unripe', await sha256b64u(c[4].ros))
    const d = await chainOf([...BASE.slice(0, 5), { members: [['ck', 'ck1'], ['pk', 'pk1'], ['pk', 'pk3'], ['rk', 'rk1']], req: T + 312 * H, rip: T + 312 * H, signer: 'pk1', co: { signer: 'ck1' } }])
    accept('ok/cosign-pinned-ripe', 'from the same pin, at T+312h (72 h after the pin): ripe', d.slice(4),
      { seq: 5, ripenedAt: T + 312 * H, members: [mem('ck', 'ck1', T + 240 * H), mem('pk', 'pk1', T + 240 * H), mem('pk', 'pk3', T + 312 * H), mem('rk', 'rk1', T + 240 * H)],
        createdAt: null, lastResetAt: null, sinceExact: false }, await sha256b64u(d[4].ros))
  }
  reject('cosign/readded-age-restarts', 'ck1 removed and added again 8 h before it co-signs: its age restarts at the re-add',
    await on({ members: [['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 240 * H, rip: T + 312 * H, signer: 'pk1' },
      { members: [['ck', 'ck1'], ['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 320 * H, rip: T + 392 * H, signer: 'pk1' },
      { members: PLUS_PK3, req: T + 400 * H, rip: T + 400 * H, signer: 'pk1', co: { signer: 'ck1' } }), 'cosign-unripe')

  // security-ruling-949 C2: the directory may ripen a change LATER than it was asked (ripenedAt > requestedAt).
  // Ripeness and the co-sign's life are both measured at requestedAt, never at ripenedAt.
  reject('cosign/unripe-at-request-ripe-at-ripening', 'ck1 is 71 h a member at requestedAt and 73 h at ripenedAt, 2 h later: the co-sign does not count',
    await on(co(T + 303 * H, T + 305 * H)), 'cosign-unripe')
  reject('ck/unripe-at-request-ripe-at-ripening', 'ck1 asks at 71 h a member, ripened 2 h later at 73 h: the 72 h wait applies', await on(ck(T + 303 * H, T + 305 * H)), 'unripe')
  accept('ok/cosign-ripened-late', 'the co-sign is alive at requestedAt and long expired at ripenedAt, one hour later: it counts',
    await on(co(R4, R4 + H)), st(4, R4 + H, [mem('pk', 'pk3', R4 + H)]))
  accept('ok/ck-ripened-late', 'ck1 asks, ripe at requestedAt; its cns. is long expired at ripenedAt, one hour later: no wait',
    await on(ck(R4, R4 + H)), st(4, R4 + H, [mem('pk', 'pk3', R4 + H)]))

  // a consent key's request as a quarantine's evidence
  accept('ok/q-voided-by-consent-key', 'ck1 asked (by its cns.), the mailbox voided it and quarantined ck1',
    await on({ members: [['ck', 'ck1', 'q'], ['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 240 * H, rip: T + 240 * H, auth: 'q', voided: { members: PLUS_PK3, signer: 'ck1' } }),
    st(4, T + 240 * H, [mem('ck', 'ck1', T + 232 * H, true)], [atL3.pk1, atL3.pk2, atL3.rk1]))
  accept('ok/q-voided-ck-cns-old', 'the voided request\'s cns. is long expired: evidence of who asked has no time check',
    await on({ members: [['ck', 'ck1', 'q'], ['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 240 * H, rip: T + 240 * H, auth: 'q',
      voided: { members: PLUS_PK3, signer: 'ck1', cns: { exp: T + 1 * H } } }),
    st(4, T + 240 * H, [mem('ck', 'ck1', T + 232 * H, true)], [atL3.pk1, atL3.pk2, atL3.rk1]))
  reject('q/voided-ck-cns-other-text', 'the voided request\'s cns. covers another text', await on({ members: [['ck', 'ck1', 'q'], ['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']],
    req: T + 240 * H, rip: T + 240 * H, auth: 'q', voided: { members: PLUS_PK3, signer: 'ck1', cns: { over: 'ros.another' } } }), 'voided-consent-transcript')
}

// --- vrs.: a member stops a reset (the directory's check; security's C4/C5 on #944) ---------
//
// The account was set up at T. L4 (T+240h) is the head the reset would replace: pk1, rk1, ck1.
type StopRow = { name: string; about: string; links: Link[]; pinned?: string; resetRos: string; resetRequestedAt: number; challenge: string
  now: number; text: string; signer: string; proof: { assertion?: unknown; sig?: string; cns?: string }; spent?: boolean; expect: 'accept' | 'reject'; reason?: string }
const resetStops: StopRow[] = []
{
  const L = await chainOf(BASE.slice(0, 5))
  const DAY14 = T + NEW_ACCOUNT_MS
  const resetOf = async (on: string, o: { members?: M[]; seq?: number; prev?: string } = {}) => buildRos({ address: ADDRESS, seq: o.seq ?? 5, prev: o.prev ?? await sha256b64u(on),
    members: (o.members ?? [['pk', 'pk3']]).map(([k, l]) => ({ kind: k, pub: pubOf(l), quarantined: false })), dirNonce: nonce(60), created: DAY14 })
  const RESET = await resetOf(L[4].ros)
  const CH = nonce(61)
  type StopSpec = { name: string; about: string; links?: Link[]; pinned?: string; resetRos?: string; resetRequestedAt?: number; now?: number; signer?: string
    vrs?: { address?: string; reset?: string; nonce?: string }; text?: string; proof?: 'assertion' | 'sig' | 'cns'; over?: string; sigBy?: string; cns?: CnsOpts; spent?: boolean; reason?: string }
  const stop = async (x: StopSpec) => {
    const resetRos = x.resetRos ?? RESET
    const text = x.text ?? buildVrs({ address: x.vrs?.address ?? ADDRESS, resetHash: x.vrs?.reset ?? await sha256b64u(resetRos), dirNonce: x.vrs?.nonce ?? CH })
    const signer = x.signer ?? 'pk1'
    const now = x.now ?? DAY14 + 4 * H
    const kind = x.proof ?? (signer.startsWith('pk') ? 'assertion' : signer.startsWith('ck') ? 'cns' : 'sig')
    const proof: StopRow['proof'] = {}
    if (kind === 'assertion') proof.assertion = await assertion(signer, x.over ?? text)
    else if (kind === 'sig') proof.sig = await signStatement(K[x.sigBy ?? signer].key, x.over ?? text)
    else { const c = await cosign(signer, text, CH, now, x.cns); proof.cns = c.cns; proof.sig = c.sig }
    resetStops.push({ name: x.name, about: x.about, links: x.links ?? L, ...(x.pinned ? { pinned: x.pinned } : {}), resetRos, resetRequestedAt: x.resetRequestedAt ?? DAY14,
      challenge: CH, now, text, signer: pubOf(signer), proof, ...(x.spent ? { spent: true } : {}), expect: x.reason ? 'reject' : 'accept', ...(x.reason ? { reason: x.reason } : {}) })
  }
  await stop({ name: 'ok/stop-by-passkey', about: 'the reset was requested exactly 14 days after setup; pk1 stops it' })
  await stop({ name: 'ok/stop-by-recovery-key', about: 'the recovery key stops it (a raw signature)', signer: 'rk1' })
  await stop({ name: 'ok/stop-by-consent-key', about: 'the consent key stops it (a roster cns. over the vrs. text, alive now)', signer: 'ck1' })
  await stop({ name: 'stop/new-account', about: 'the reset was requested one second before day 14', resetRequestedAt: DAY14 - 1000, reason: 'new-account' })
  await stop({ name: 'stop/age-at-request-not-at-stop', about: 'requested on day 12.5, stopped on day 16.7: the age is judged when the reset was REQUESTED (security C4 on #944)',
    resetRequestedAt: T + 300 * H, now: T + 400 * H, reason: 'new-account' })
  await stop({ name: 'stop/pinned-age-unknown', about: 'a chain read from a pin has no creation time: the stop is refused (the directory holds the whole chain)',
    links: L.slice(4), pinned: await sha256b64u(L[4].ros), reason: 'age-unknown' })
  await stop({ name: 'stop/signer-not-member', about: 'pk4 is not on the roster', signer: 'pk4', reason: 'signer' })
  {
    const q = await chainOf([...BASE.slice(0, 4), { members: [['ck', 'ck1', 'q'], ['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 240 * H, rip: T + 240 * H, auth: 'q',
      voided: { members: [['ck', 'ck1'], ['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3'], ['rk', 'rk1']], signer: 'ck1' } }])
    await stop({ name: 'stop/signer-quarantined', about: 'ck1 is quarantined', links: q, resetRos: await resetOf(q[4].ros), signer: 'ck1', reason: 'quarantined' })
  }
  await stop({ name: 'stop/other-reset', about: 'the vrs. names another reset request', vrs: { reset: await sha256b64u(await resetOf(L[4].ros, { members: [['pk', 'pk4']] })) }, reason: 'reset-mismatch' })
  {
    const offHead = await resetOf(L[3].ros, { seq: 4 })
    await stop({ name: 'stop/reset-not-on-head', about: 'the reset request names an earlier head as its previous', resetRos: offHead, reason: 'reset' })
    const two = await resetOf(L[4].ros, { members: [['pk', 'pk3'], ['pk', 'pk4']] })
    await stop({ name: 'stop/reset-two-members', about: 'what it stops is not a reset (two members)', resetRos: two, reason: 'reset' })
  }
  await stop({ name: 'stop/requested-before-head', about: 'the reset was requested before the head it replaces ripened', resetRequestedAt: T + 240 * H - 1, reason: 'order' })
  await stop({ name: 'stop/other-address', about: 'the vrs. names another account', vrs: { address: 'bob@example.com' }, reason: 'address' })
  await stop({ name: 'stop/other-challenge', about: 'the vrs. carries another challenge than the one issued', vrs: { nonce: nonce(62) }, reason: 'challenge' })
  await stop({ name: 'stop/spent', about: 'the challenge was already spent', spent: true, reason: 'replay' })
  await stop({ name: 'stop/assertion-other-text', about: 'the assertion covers another text', over: 'vrs.another', reason: 'assertion-challenge' })
  await stop({ name: 'stop/rk-wrong-key', about: 'the recovery-key signature is by another key', signer: 'rk1', sigBy: 'rk2', reason: 'signature' })
  await stop({ name: 'stop/ck-cns-expired', about: 'the consent key\'s cns. expired before now', signer: 'ck1', cns: { exp: DAY14 + 4 * H }, reason: 'consent-expired' })
  await stop({ name: 'stop/ck-cns-web-add', about: 'the consent key\'s cns. carries purpose web-add', signer: 'ck1', cns: { purpose: 'web-add' }, reason: 'consent-purpose' })
  await stop({ name: 'stop/passkey-raw-signature', about: 'a passkey stops by assertion only', proof: 'sig', reason: 'proof' })
  await stop({ name: 'stop/extra-field', about: 'an extra field', text: buildVrs({ address: ADDRESS, resetHash: await sha256b64u(RESET), dirNonce: CH }) + '.x', reason: 'grammar' })
  await stop({ name: 'stop/address-not-normal', about: 'the address is in normal form', vrs: { address: 'Alice@Example.com' }, reason: 'grammar' })
}

// --- wout. and adel.: a member signs every browser out, or asks to delete the account (the directory's checks) ---
//
// As for resetStops: L4 (T+240h) is the account's head: pk1, rk1, ck1 (pk2 left at L4).
type ActRow = { name: string; about: string; links: Link[]; challenge: string; challengeAt?: number; now: number; text: string; signer: string
  proof: { assertion?: unknown; sig?: string; cns?: string }; spent?: boolean; expect: 'accept' | 'reject'; reason?: string }
const signOuts: ActRow[] = [], deletions: ActRow[] = []
{
  const L = await chainOf(BASE.slice(0, 5))
  const Q = await chainOf([...BASE.slice(0, 4), { members: [['ck', 'ck1', 'q'], ['pk', 'pk1'], ['pk', 'pk2'], ['rk', 'rk1']], req: T + 240 * H, rip: T + 240 * H, auth: 'q',
    voided: { members: [['ck', 'ck1'], ['pk', 'pk1'], ['pk', 'pk2'], ['pk', 'pk3'], ['rk', 'rk1']], signer: 'ck1' } }])
  const NOW_ACT = T + 400 * H
  type ActSpec = { name: string; about: string; links?: Link[]; signer?: string; text?: string; proof?: 'assertion' | 'sig' | 'cns'; over?: string; sigBy?: string
    cns?: CnsOpts; spent?: boolean; reason?: string; challengeAt?: number }
  const act = async (into: ActRow[], text: string, challenge: string, x: ActSpec, challengeAt?: number) => {
    const signer = x.signer ?? 'pk1'
    const kind = x.proof ?? (signer.startsWith('pk') ? 'assertion' : signer.startsWith('ck') ? 'cns' : 'sig')
    const proof: ActRow['proof'] = {}
    if (kind === 'assertion') proof.assertion = await assertion(signer, x.over ?? text)
    else if (kind === 'sig') proof.sig = await signStatement(K[x.sigBy ?? signer].key, x.over ?? text)
    else { const c = await cosign(signer, text, challenge, NOW_ACT, x.cns); proof.cns = c.cns; proof.sig = c.sig }
    into.push({ name: x.name, about: x.about, links: x.links ?? L, challenge, ...(challengeAt !== undefined ? { challengeAt: x.challengeAt ?? challengeAt } : {}), now: NOW_ACT,
      text, signer: pubOf(signer), proof, ...(x.spent ? { spent: true } : {}), expect: x.reason ? 'reject' : 'accept', ...(x.reason ? { reason: x.reason } : {}) })
  }

  // wout.: `at` is the time the directory issued the challenge
  const CH = nonce(63), AT = NOW_ACT - 2 * 60_000
  const wout = (o: { address?: string; at?: number; nonce?: string } = {}) => buildWout({ address: o.address ?? ADDRESS, at: o.at ?? AT, dirNonce: o.nonce ?? CH })
  const so = (x: ActSpec) => act(signOuts, x.text ?? wout(), CH, x, AT)
  await so({ name: 'ok/wout-by-passkey', about: 'pk1 signs every browser out (an assertion over the wout. text)' })
  await so({ name: 'ok/wout-by-recovery-key', about: 'the recovery key signs every browser out (a raw signature)', signer: 'rk1' })
  await so({ name: 'ok/wout-by-consent-key', about: 'the consent key signs every browser out from its app (a roster cns., alive now)', signer: 'ck1' })
  await so({ name: 'wout/signer-not-member', about: 'pk4 is not on the roster', signer: 'pk4', reason: 'signer' })
  await so({ name: 'wout/signer-removed', about: 'pk2 left the roster at the current head', signer: 'pk2', reason: 'signer' })
  await so({ name: 'wout/signer-quarantined', about: 'ck1 is quarantined', links: Q, signer: 'ck1', reason: 'quarantined' })
  await so({ name: 'wout/other-address', about: 'the wout. names another account', text: wout({ address: 'bob@example.com' }), reason: 'address' })
  await so({ name: 'wout/address-not-normal', about: 'the address is in normal form, the one the account name hashes (security-ruling-953 D8)', text: wout({ address: 'Alice@Example.com' }), reason: 'grammar' })
  await so({ name: 'wout/other-challenge', about: 'the wout. carries another challenge than the one issued', text: wout({ nonce: nonce(65) }), reason: 'challenge' })
  await so({ name: 'wout/at-not-challenge-time', about: 'the wout. says another time than the challenge was issued at', text: wout({ at: AT + 1000 }), reason: 'at' })
  await so({ name: 'wout/spent', about: 'the challenge was already spent', spent: true, reason: 'replay' })
  await so({ name: 'wout/assertion-other-text', about: 'the assertion covers another text', over: 'wout.another', reason: 'assertion-challenge' })
  await so({ name: 'wout/assertion-over-adel', about: 'an assertion made for a deletion request is not a sign-out', over: buildAdel({ address: ADDRESS, headHash: await sha256b64u(L[4].ros), dirNonce: CH }), reason: 'assertion-challenge' })
  await so({ name: 'wout/rk-wrong-key', about: 'the recovery-key signature is by another key', signer: 'rk1', sigBy: 'rk2', reason: 'signature' })
  await so({ name: 'wout/ck-cns-web-add', about: 'the consent key\'s cns. carries purpose web-add', signer: 'ck1', cns: { purpose: 'web-add' }, reason: 'consent-purpose' })
  await so({ name: 'wout/ck-cns-expired', about: 'the consent key\'s co-sign is dead at now (security-ruling-962 C3)', signer: 'ck1', cns: { exp: NOW_ACT }, reason: 'consent-expired' })
  await so({ name: 'wout/at-before-challenge-time', about: 'the wout. says a time one second BEFORE the challenge was issued', text: wout({ at: AT - 1000 }), reason: 'at' })
  await so({ name: 'wout/passkey-raw-signature', about: 'a passkey signs by assertion only', proof: 'sig', reason: 'proof' })
  await so({ name: 'wout/extra-field', about: 'an extra field', text: wout() + '.x', reason: 'grammar' })
  await so({ name: 'wout/at-zero', about: 'at is a positive time', text: `wout.${b64uEnc(te.encode(ADDRESS))}.0.${CH}`, reason: 'grammar' })
  await so({ name: 'wout/nonce-short', about: 'the challenge is 16 to 64 bytes', text: wout({ nonce: b64uEnc(new Uint8Array(15)) }), reason: 'grammar' })

  // adel.: names the head it was asked against, which must be the current one
  const CD = nonce(64), HEAD = await sha256b64u(L[4].ros)
  const adel = (o: { address?: string; head?: string; nonce?: string } = {}) => buildAdel({ address: o.address ?? ADDRESS, headHash: o.head ?? HEAD, dirNonce: o.nonce ?? CD })
  const de = (x: ActSpec) => act(deletions, x.text ?? adel(), CD, x)
  await de({ name: 'ok/adel-by-passkey', about: 'pk1 asks to delete the account (queued 72 h, with a void link to the address)' })
  await de({ name: 'ok/adel-by-recovery-key', about: 'the recovery key asks (a raw signature)', signer: 'rk1' })
  await de({ name: 'ok/adel-by-consent-key', about: 'the consent key asks from its app (a roster cns., alive now)', signer: 'ck1' })
  await de({ name: 'adel/old-head', about: 'the request names an earlier head: the roster changed under it', text: adel({ head: await sha256b64u(L[3].ros) }), reason: 'roster-head' })
  await de({ name: 'adel/signer-not-member', about: 'pk4 is not on the roster', signer: 'pk4', reason: 'signer' })
  await de({ name: 'adel/signer-removed', about: 'pk2 left the roster at the current head', signer: 'pk2', reason: 'signer' })
  await de({ name: 'adel/signer-quarantined', about: 'ck1 is quarantined', links: Q, signer: 'ck1', text: adel({ head: await sha256b64u(Q[4].ros) }), reason: 'quarantined' })
  await de({ name: 'adel/other-address', about: 'the request names another account', text: adel({ address: 'bob@example.com' }), reason: 'address' })
  await de({ name: 'adel/address-not-normal', about: 'the address is in normal form', text: adel({ address: 'Alice@Example.com' }), reason: 'grammar' })
  await de({ name: 'adel/other-challenge', about: 'the request carries another challenge than the one issued', text: adel({ nonce: nonce(66) }), reason: 'challenge' })
  await de({ name: 'adel/spent', about: 'the challenge was already spent', spent: true, reason: 'replay' })
  await de({ name: 'adel/assertion-other-text', about: 'the assertion covers another text', over: 'adel.another', reason: 'assertion-challenge' })
  await de({ name: 'adel/assertion-over-wout', about: 'an assertion made for a sign-out is not a deletion request', over: buildWout({ address: ADDRESS, at: AT, dirNonce: CD }), reason: 'assertion-challenge' })
  await de({ name: 'adel/ck-cns-web-add', about: 'the consent key\'s cns. carries purpose web-add', signer: 'ck1', cns: { purpose: 'web-add' }, reason: 'consent-purpose' })
  await de({ name: 'adel/ck-cns-expired', about: 'the consent key\'s co-sign is dead at now (security-ruling-962 C3)', signer: 'ck1', cns: { exp: NOW_ACT }, reason: 'consent-expired' })
  await de({ name: 'adel/passkey-raw-signature', about: 'a passkey signs by assertion only', proof: 'sig', reason: 'proof' })
  await de({ name: 'adel/extra-field', about: 'an extra field', text: adel() + '.x', reason: 'grammar' })
  await de({ name: 'adel/head-not-a-hash', about: 'the head is a sha256, base64url', text: adel({ head: 'B'.repeat(43) }), reason: 'grammar' })
  await de({ name: 'adel/vrs-text', about: 'a vrs. text is not a deletion request', text: buildVrs({ address: ADDRESS, resetHash: HEAD, dirNonce: CD }), reason: 'grammar' })
}

// --- the passkey user handle: SHA-256(label ‖ address in normal form) ‖ 16 random bytes -------------------------
//
// The sign-in host makes every passkey with this user.id, and a native host making a passkey for the same rp id
// must too, or its passkeys cannot sign in there. Deterministic: the tails stand in for the 16 random bytes.
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const userHandles: { label: string; bytes: number; rows: Array<Record<string, unknown>> } = { label: USER_HANDLE_LABEL, bytes: 48, rows: [] }
{
  for (const [name, address, fill] of [['ok/alice', ADDRESS, 0xa5], ['ok/alice-other-passkey', ADDRESS, 0x5a], ['ok/plus-tag', 'bob+bento@example.org', 0x01]] as const) {
    const tail = new Uint8Array(16).fill(fill)
    const h = await buildUserHandle(address, tail)
    if (!h) throw new Error(name)
    userHandles.rows.push({ name, address, tailHex: hex(tail), handle: b64uEnc(h), accountHex: hex(h.slice(0, 32)) })
  }
  // a host never hashes an address that is not in normal form (it would name another account's storage)
  for (const [name, address] of [['refuse/upper-case', 'Alice@Example.com'], ['refuse/spaces', ' alice@example.com'], ['refuse/not-an-address', 'alice']] as const)
    userHandles.rows.push({ name, address, tailHex: hex(new Uint8Array(16)), handle: null })
}

// ---------------------------------------------------------------------------------------------

const keys: Record<string, string> = {}
for (const l of LABELS) if (!l.startsWith('dir')) keys[l] = pubOf(l)
const out = {
  version: 2,
  about: 'Conformance rows for the bento/id option G roster chain (kernel/src/roster.ts): ros. heads, the directory\'s rip. countersign, and member proofs. Version 2: the rip. carries an authority word and a cause (m r q l x u) where version 1 had a reset flag; version 1 is retired. Verify each row\'s links with verifyRosterChain(links, { directoryKeys, rpId, origins, now, pinned }) using the values below. Match the verdict; match the reason where you can; for accepted rows, match the state (member keys are labels in `keys`). TEST KEYS ONLY.',
  rpId: RP,
  origins: [...ROSTER_WEB_ORIGINS],
  now: NOW,
  waitMs: 72 * H,
  directoryKeys: DIRECTORY_KEYS,
  // signs rip/unknown-kid under kid dir-9; for a positive control only, never pinned
  unpinnedDirectoryKey: K.dirOther.pub,
  // the rp a consent key's cns. names (verifyRosterChain's consentRp)
  consentRp: CONSENT_RP,
  keys,
  rows,
  // vrs.: verifyResetStop(text, signer, proof, { roster (this row's chain), resetRos, resetRequestedAt, challenge, spend: () => !spent, rpId, origins, consentRp, now })
  resetStops,
  // wout.: verifyWout(text, signer, proof, { roster (this row's chain at now), challenge, challengeAt, spend: () => !spent, rpId, origins, consentRp, now })
  signOuts,
  // adel.: verifyAdel(text, signer, proof, { roster (this row's chain at now), challenge, spend: () => !spent, rpId, origins, consentRp, now }); accepted = queued
  // for deleteWaitMs on the directory's clock, carried out only if not voided and the head is still the one it names
  deleteWaitMs: DELETE_WAIT_MS,
  deletions,
  // the passkey user handle: label, then for each row SHA-256(label ‖ address) ‖ tail = handle (null: refuse to hash a non-normal address);
  // a returned handle routes by its first 32 bytes (accountHex) and is exactly 48 bytes
  userHandles,
}
// keep the committed bytes of every row that differs only in its (random) signatures
const SIGS = new Set(['ripSig', 'sig', 'signature'])
const masked = (v: unknown) => JSON.stringify(v, (k, x) => (SIGS.has(k) ? '' : x))
const before = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
const old = new Map<string, Row>((before?.rows ?? []).map((r: Row) => [r.name, r]))
out.rows = rows.map((r) => { const o = old.get(r.name); return o && masked(o) === masked(r) ? o : r })
const oldStops = new Map<string, StopRow>((before?.resetStops ?? []).map((r: StopRow) => [r.name, r]))
out.resetStops = resetStops.map((r) => { const o = oldStops.get(r.name); return o && masked(o) === masked(r) ? o : r })
for (const k of ['signOuts', 'deletions'] as const) {
  const was = new Map<string, ActRow>((before?.[k] ?? []).map((r: ActRow) => [r.name, r]))
  out[k] = out[k].map((r) => { const o = was.get(r.name); return o && masked(o) === masked(r) ? o : r })
}
const text = JSON.stringify(out, null, 2) + '\n'
if (CHECK) {
  const changed = out.rows.filter((r) => old.get(r.name) !== r).map((r) => r.name)
  const gone = [...old.keys()].filter((n) => !rows.some((r) => r.name === n))
  const same = before !== null && text === readFileSync(OUT, 'utf8')
  if (!same) console.log(`${OUT} is stale: ${changed.length} rows new or changed${changed.length ? ` (${changed.join(', ')})` : ''}, ${gone.length} removed${gone.length ? ` (${gone.join(', ')})` : ''}${changed.length + gone.length ? '' : ', top-level fields differ'}`)
  else console.log(`${OUT} is current: ${rows.length} rows`)
  process.exit(same ? 0 : 1)
}
writeFileSync(OUT, text)
console.log(`wrote ${OUT}: ${rows.length} rows (${rows.filter((r) => r.expect === 'accept').length} accept, ${rows.filter((r) => old.get(r.name) === out.rows[rows.indexOf(r)]).length} kept byte for byte)`)
