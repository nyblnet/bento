// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// "Who vouched" for a collaborator, as data: what the People panel may say
// about a person, decided from the identity agent's answer. No DOM; it imports
// two pure things from the kernel, the marker value RESOLVED_FIELDS and the
// voucher shape isVoucher, and never the agent (the identity import pin in
// scripts/test-identity.ts allows exactly that line here), so
// scripts/test-slides-people-tiers.ts runs it under plain node. The painting is
// vouch.ts.
//
// The agent (kernel/src/identity.ts `resolve`) verified everything it reports:
// the roster chain (roster.ts verifyRosterChain), the device certificate and
// its countersign (devices.ts verifyDevice), and the directory's status. This
// file only turns that report into labels, and it never claims more than the
// report says.
//
// NO ✓ WITHOUT THE MARKER. Four fields are the STRONGER claim when missing
// (revoked, resetAt, rosterChangedAt, unconfirmedSince), and a missing one may
// be one a relay dropped on the way. So an answer earns a ✓ only when it says
// it carries every field that applies: its own `fields === RESOLVED_FIELDS`. Without it
// the row reads "couldn't check" (failed, why 'incomplete'), never ✓; a relay
// that copies a fixed list of the original six fields drops the marker too, so
// every older host fails closed. A revocation and a changed binding, which
// only ever take the ✓ away, are shown with or without it.
//
// With the marker, each field below reads like this:
//
//   tier             'native' drops "(passkey sign-in)"; anything else keeps it
//                    (G1: every certificate a passkey made is shown that way)
//   accountSince     "new account" until 14 days after it; missing or
//                    malformed = new (the weaker claim)
//   rosterChangedAt  "account changed on <date>" for 7 days after it
//   resetAt          a reset by the directory: "account changed on <date>" for
//                    30 days after it
//   unconfirmedSince the ✓ is qualified "unconfirmed since <date>" for as long
//                    as the agent sends it (the address, not the account)
//   revoked          no ✓ at all: "this sign-in was revoked"; 'incident' (the
//                    post-compromise lever) also flags the row for the owner
//   managedBy        not shown (organisation identity is later); never parsed
//
// The three time fields above that are stronger when missing must be ABSENT or
// a time (a positive integer a Date can hold): any other value present (null, a
// string, 0, a fraction, past 8.64e15) is "couldn't check", never read as
// absent. vouchedBy is the voucher alone (isVoucher); any other text in it is
// "couldn't check": no qualifier is ever parsed out of it.

import { RESOLVED_FIELDS, isVoucher } from '../../../kernel/src/identity.ts'

export type Tier = 'passkey' | 'native'

export type VouchState =
  | { kind: 'checking' }
  | {
      kind: 'verified'
      name: string
      /** vouchedBy, a bare voucher (isVoucher) */
      via: string
      tier: Tier
      newAccount: boolean
      /** when the account last changed, if the panel should say so */
      changedOn: number | null
      /** since when the address is unconfirmed, while the agent says so */
      unconfirmedOn: number | null
    }
  | { kind: 'changed'; name: string; via: string }
  | { kind: 'revoked'; incident: boolean }
  | { kind: 'unverified' }
  | { kind: 'unproven' }
  /** 'incomplete': the answer lacks the marker, so it may have lost fields */
  | { kind: 'failed'; why?: 'incomplete' }

const DAY = 86_400_000
/** "new account" is shown for this long after setup (G5). */
export const NEW_ACCOUNT_MS = 14 * DAY
/** "account changed on <date>" is shown for this long after a roster change. */
export const CHANGED_SHOWN_MS = 7 * DAY
/** ... and this long after a reset by the directory (maintainer, 2026-11-12). */
export const RESET_SHOWN_MS = 30 * DAY
/** The longest name the panel shows. */
export const NAME_MAX = 80

// Nothing shown may reorder, hide or blank out text: by Unicode category, not a
// list of known characters. Controls (Cc), format characters (Cf: bidi marks,
// zero-width, soft hyphen, tag characters), private use (Co), unassigned (Cn),
// line and paragraph separators, every default-ignorable code point, and the
// Hangul fillers, letters that render as blank space (default-ignorable
// already; listed so the intent survives a change to that property), and the
// Braille blank, which renders blank too.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u115F\u1160\u3164\uFFA0\u2800]/gu
// tick-like marks (escaped, so they survive editing): no name, typed or verified, may draw its own
const TICKS = /[\u2713\u2714\u2705\u2611\u2612\u2757\u221A\u237B\u{1F5F8}\u{1F5F9}\u{10102}\u{1FBB1}]/gu

const tidy = (s: string) => s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()

/** Agent-supplied text made safe to show: no invisible or bidi characters, bounded. */
export function cleanText(s: unknown, max: number): string {
  if (typeof s !== 'string') return ''
  const c = tidy(s)
  return c.length > max ? c.slice(0, max - 1) + '…' : c
}

/** A name, typed or the account's own display name, with any tick marks
 *  removed so it can't pose as a ✓. */
export function claimedName(s: unknown): string {
  return typeof s === 'string' ? cleanText(s.replace(TICKS, ''), NAME_MAX) : ''
}

/** the latest instant a Date can hold; a larger number would render "Invalid Date" */
const MAX_TIME = 8.64e15
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_TIME
/** present and not a time: a field whose absence is the stronger claim cannot
 *  be read as absent when it holds something else */
const malformed = (v: unknown) => v !== undefined && !isTime(v)

/** the marker, read as the answer's own data property: an inherited one (a
 *  polluted Object.prototype, an answer built on a prototype that carries it)
 *  or an accessor never counts, since this is the one gate meant to fail closed */
const ownMarker = (a: object) => { const d = Object.getOwnPropertyDescriptor(a, 'fields'); return d !== undefined && 'value' in d && d.value === RESOLVED_FIELDS }

/**
 * Validate an agent answer: anything malformed is a failure, never a ✓.
 * `now` is this device's clock (the windows are display windows; the agent
 * already enforced every validity rule on the directory's clock).
 */
export function stateFromAnswer(r: unknown, now: number): VouchState {
  // an answer whose field read throws (a getter, a Proxy) is a failure, never
  // a row stuck on "checking…"
  try { return decide(r, now) } catch { return { kind: 'failed' } }
}

function decide(r: unknown, now: number): VouchState {
  if (r === null) return { kind: 'unverified' }
  if (!r || typeof r !== 'object') return { kind: 'failed' }
  const a = r as Record<string, unknown>
  // revocation outranks everything: a revoked sign-in never shows a ✓
  // `revoked` is typed here and nowhere else (the kernel passes the host's
  // answer through), so anything but absent or false, null and 0 included, is
  // read as present: a known value is a revocation, anything else couldn't check
  const rv = a.revoked
  if (rv !== undefined && rv !== false) {
    if (rv === true || rv === 'signout') return { kind: 'revoked', incident: false }
    if (rv === 'incident') return { kind: 'revoked', incident: true }
    return { kind: 'failed' }
  }
  const name = claimedName(a.name)
  const via = a.vouchedBy
  // a changed binding is one of the original six fields and only ever takes
  // the ✓ away, so like a revocation it is shown with or without the marker
  if (a.changed === true) return name && isVoucher(via) ? { kind: 'changed', name, via } : { kind: 'failed' }
  // a ✓ needs an answer that says it carries every field that applies, as its
  // OWN data property: never inherited, never a getter
  if (!ownMarker(a)) return { kind: 'failed', why: 'incomplete' }
  if (!name || !isVoucher(via) || a.changed !== false) return { kind: 'failed' }
  if (malformed(a.resetAt) || malformed(a.rosterChangedAt) || malformed(a.unconfirmedSince)) return { kind: 'failed' }
  const tier: Tier = a.tier === 'native' ? 'native' : 'passkey'
  const since = a.accountSince
  const newAccount = !isTime(since) || now - since < NEW_ACCOUNT_MS
  let changedOn: number | null = null
  if (isTime(a.resetAt) && now - a.resetAt < RESET_SHOWN_MS) changedOn = a.resetAt
  if (isTime(a.rosterChangedAt) && now - a.rosterChangedAt < CHANGED_SHOWN_MS &&
    (changedOn === null || a.rosterChangedAt > changedOn)) changedOn = a.rosterChangedAt
  const unconfirmedOn = isTime(a.unconfirmedSince) ? a.unconfirmedSince : null
  return { kind: 'verified', name, via, tier, newAccount, changedOn, unconfirmedOn }
}
