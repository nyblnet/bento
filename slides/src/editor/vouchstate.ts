// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// "Who vouched" for a collaborator, as data: what the People panel may say
// about a person, decided from the identity agent's answer. No DOM, no imports
// at run time, so scripts/test-slides-people-tiers.ts runs it under plain node.
// The painting is vouch.ts.
//
// The agent (kernel/src/identity.ts `resolve`) verified everything it reports:
// the roster chain (roster.ts verifyRosterChain), the device certificate and
// its countersign (devices.ts verifyDevice), and the directory's status. This
// file only turns that report into labels, and it never claims more than the
// report says. Every field below that is MISSING reads as the weaker claim:
//
//   tier            'native' drops "(passkey sign-in)"; anything else keeps it
//                   (G1: every certificate a passkey made is shown that way)
//   accountSince    "new account" until 14 days after it; missing = new
//   rosterChangedAt "account changed on <date>" for 7 days after it
//   resetAt         a reset by the directory: "account changed on <date>" for
//                   30 days after it
//   revoked         no ✓ at all: "this sign-in was revoked"; 'incident' (the
//                   post-compromise lever) also flags the row for the owner
//   managedBy       which part of vouchedBy the 80-character cut drops first
//
// These fields are OPTIONAL ADDITIONS within contract 1. The contract as it
// stands carries none of them, so until a host supplies them a verified row
// reads "(passkey sign-in)" and "new account": an under-claim, never an
// over-claim.

export type Tier = 'passkey' | 'native'

export type VouchState =
  | { kind: 'checking' }
  | {
      kind: 'verified'
      name: string
      /** vouchedBy, cleaned and cut to VIA_MAX */
      via: string
      tier: Tier
      newAccount: boolean
      /** when the account last changed, if the panel should say so */
      changedOn: number | null
    }
  | { kind: 'changed'; name: string; via: string }
  | { kind: 'revoked'; incident: boolean }
  | { kind: 'unverified' }
  | { kind: 'unproven' }
  | { kind: 'failed' }

const DAY = 86_400_000
/** "new account" is shown for this long after setup (G5). */
export const NEW_ACCOUNT_MS = 14 * DAY
/** "account changed on <date>" is shown for this long after a roster change. */
export const CHANGED_SHOWN_MS = 7 * DAY
/** ... and this long after a reset by the directory (maintainer, 2026-11-12). */
export const RESET_SHOWN_MS = 30 * DAY
/** The longest name and vouchedBy the panel shows. */
export const NAME_MAX = 80
// The kernel's identity.ts gains VOUCHED_BY_MAX = 80 (the agent's side of the
// same cut); import it here once that lands, so the two cannot drift.
export const VIA_MAX = 80

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

/**
 * vouchedBy within `max` characters. The agent writes the voucher first and
 * then its qualifiers, comma-separated: "id.bento.page, managed by example.com,
 * unconfirmed since 3 Mar 2027". When that does not fit, "managed by" goes
 * first (it says who can take the account away; "unconfirmed" says the address
 * may no longer be theirs, which matters more), then any other middle
 * qualifier, and the LAST qualifier is kept whole while the voucher is
 * shortened. Only when even that cannot fit is the end cut.
 */
export function cutVia(raw: unknown, managedBy?: unknown, max = VIA_MAX): string {
  if (typeof raw !== 'string') return ''
  const full = tidy(raw)
  if (full.length <= max) return full
  const parts = full.split(', ')
  const head = parts[0]
  let quals = parts.slice(1)
  // managedBy counts only as a whole domain, found on word boundaries: '.' or a
  // fragment must never match (and drop) the "unconfirmed since" qualifier
  const dom = typeof managedBy === 'string' ? tidy(managedBy).toLowerCase() : ''
  const domRe = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dom)
    ? new RegExp(`(^|[^a-z0-9.-])${dom.replace(/\./g, '\\.')}($|[^a-z0-9.-])`, 'i') : null
  const isManaged = (q: string) => /^managed by\b/i.test(q) || (domRe !== null && domRe.test(q))
  const fits = (h: string, qs: string[]) => [h, ...qs].join(', ').length <= max
  if (quals.length && !fits(head, quals)) quals = quals.filter((q) => !isManaged(q))
  while (quals.length > 1 && !fits(head, quals)) quals.splice(quals.length - 2, 1)
  if (fits(head, quals)) return [head, ...quals].join(', ')
  if (quals.length === 1) {
    const room = max - quals[0].length - 2 // ", "
    if (room >= 8) return `${head.slice(0, room - 1)}…, ${quals[0]}`
  }
  return cleanText([head, ...quals].join(', '), max)
}

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

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
  const rv = a.revoked
  if (rv !== undefined && rv !== false) {
    if (rv === true || rv === 'signout') return { kind: 'revoked', incident: false }
    if (rv === 'incident') return { kind: 'revoked', incident: true }
    return { kind: 'failed' }
  }
  const name = claimedName(a.name)
  const via = cutVia(a.vouchedBy, a.managedBy)
  if (!name || !via || typeof a.changed !== 'boolean') return { kind: 'failed' }
  if (a.changed) return { kind: 'changed', name, via }
  const tier: Tier = a.tier === 'native' ? 'native' : 'passkey'
  const since = a.accountSince
  const newAccount = !isTime(since) || now - since < NEW_ACCOUNT_MS
  let changedOn: number | null = null
  if (isTime(a.resetAt) && now - a.resetAt < RESET_SHOWN_MS) changedOn = a.resetAt
  if (isTime(a.rosterChangedAt) && now - a.rosterChangedAt < CHANGED_SHOWN_MS &&
    (changedOn === null || a.rosterChangedAt > changedOn)) changedOn = a.rosterChangedAt
  return { kind: 'verified', name, via, tier, newAccount, changedOn }
}
