// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// What the People panel may say about a collaborator (bento/id P1, option G tiers).
//
//   node scripts/test-slides-people-tiers.ts
//
// Rows over slides/src/editor/vouchstate.ts, the decision behind every label:
// no ✓ without the completeness marker (ResolvedIdentity.fields), "unconfirmed
// since <date>", "(passkey sign-in)", "new account" (14 days), "account changed
// on <date>" (7 days; 30 after a reset), "this sign-in was revoked" (no ✓; an
// incident flags the row), vouchedBy as a bare voucher (never parsed), and the
// name's tick and invisible-character strip. The marker counts only as the
// answer's own data property; a changed binding, like a revocation, is shown
// with or without it; and a reset or roster change dated in the viewer's
// future keeps its tag (the safe direction). A field missing from a MARKED
// answer reads as what it means: tier and accountSince the weaker claim; the
// fields whose absence is the stronger claim must be absent or a time.
//
// Then MUTANTS: each is one source edit to a copy of vouchstate.ts (asserted to
// match exactly once), imported fresh; the rows must go red on every one. The
// unmutated copy is run through the same path first as the positive control.
import { readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SRC = new URL('../slides/src/editor/vouchstate.ts', import.meta.url)
const DAY = 86_400_000
const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 12, 12)

type Mod = typeof import('../slides/src/editor/vouchstate.ts')
type Row = [string, (m: Mod) => boolean]

// the six fields every host sends (what home/bridge.js relays today) ...
const six = (extra: Record<string, unknown> = {}) => ({
  name: 'Alice Real', email: 'alice@example.com', vouchedBy: 'id.bento.page', accountPub: 'A', firstSeen: 1, changed: false, ...extra,
})
// ... and a complete answer: the marker says every G field that applies is here
const bind = (extra: Record<string, unknown> = {}) => six({ fields: 'g1', ...extra })
const st = (m: Mod, a: unknown) => m.stateFromAnswer(a, NOW) as Record<string, unknown>
const UNCONF_AT = NOW - 40 * DAY
const verified = (m: Mod, a: unknown) => st(m, a).kind === 'verified'
const failed = (m: Mod, a: unknown) => st(m, a).kind === 'failed'

const ROWS: Row[] = [
  ['null answer -> not verified', (m) => st(m, null).kind === 'unverified'],
  ['a non-object answer -> failed', (m) => st(m, 'yes').kind === 'failed'],
  ['an undefined answer -> failed (only null means "not verified")', (m) => st(m, undefined).kind === 'failed'],
  ['no name -> failed, never a ✓', (m) => st(m, bind({ name: '' })).kind === 'failed'],
  ['changed not a boolean -> failed', (m) => st(m, bind({ changed: 'no' })).kind === 'failed'],
  ['changed binding -> "changed", no ✓', (m) => st(m, bind({ changed: true })).kind === 'changed'],

  // the contract as it stands: no tier fields at all -> the weaker claims
  ['no tier field -> (passkey sign-in)', (m) => st(m, bind()).tier === 'passkey'],
  ['no accountSince -> new account', (m) => st(m, bind()).newAccount === true],
  ['no roster times -> no "account changed"', (m) => st(m, bind()).changedOn === null],
  ['tier native -> no (passkey sign-in)', (m) => st(m, bind({ tier: 'native' })).tier === 'native'],
  ['tier of any other spelling -> passkey', (m) => st(m, bind({ tier: 'NATIVE' })).tier === 'passkey' && st(m, bind({ tier: true })).tier === 'passkey'],

  ['account 13 days old -> new account', (m) => st(m, bind({ accountSince: NOW - 13 * DAY })).newAccount === true],
  ['account exactly 14 days old -> not new', (m) => st(m, bind({ accountSince: NOW - 14 * DAY })).newAccount === false],
  ['account 8 days old -> still new (14, not 7)', (m) => st(m, bind({ accountSince: NOW - 8 * DAY })).newAccount === true],
  ['accountSince not a time -> new account', (m) => st(m, bind({ accountSince: String(NOW - 99 * DAY) })).newAccount === true],

  ['roster changed 6 days ago -> "account changed on" that day',
    (m) => st(m, bind({ accountSince: NOW - 99 * DAY, rosterChangedAt: NOW - 6 * DAY })).changedOn === NOW - 6 * DAY],
  ['roster changed 8 days ago -> not shown',
    (m) => st(m, bind({ accountSince: NOW - 99 * DAY, rosterChangedAt: NOW - 8 * DAY })).changedOn === null],
  ['a reset 29 d 23 h ago -> "account changed on" that day',
    (m) => st(m, bind({ accountSince: NOW - 999 * DAY, resetAt: NOW - 30 * DAY + HOUR })).changedOn === NOW - 30 * DAY + HOUR],
  ['a reset exactly 30 d ago -> not shown',
    (m) => st(m, bind({ accountSince: NOW - 999 * DAY, resetAt: NOW - 30 * DAY })).changedOn === null],
  ['a reset 20 days ago is shown (30, not 7)',
    (m) => st(m, bind({ accountSince: NOW - 999 * DAY, resetAt: NOW - 20 * DAY })).changedOn === NOW - 20 * DAY],
  // the windows run on the viewer's clock; a date in its future keeps the tag (the safe direction)
  ['a reset dated a day in the viewer\'s future -> "account changed on" that day',
    (m) => st(m, bind({ accountSince: NOW - 999 * DAY, resetAt: NOW + DAY })).changedOn === NOW + DAY],
  ['a roster change dated a day in the viewer\'s future -> "account changed on" that day',
    (m) => st(m, bind({ accountSince: NOW - 999 * DAY, rosterChangedAt: NOW + DAY })).changedOn === NOW + DAY],
  ['a recent change after an old reset shows the recent date',
    (m) => st(m, bind({ resetAt: NOW - 400 * DAY, rosterChangedAt: NOW - 2 * DAY })).changedOn === NOW - 2 * DAY],
  ['a recent reset after an older roster change shows the reset date',
    (m) => st(m, bind({ resetAt: NOW - 2 * DAY, rosterChangedAt: NOW - 5 * DAY })).changedOn === NOW - 2 * DAY],

  ['revoked -> no ✓, "this sign-in was revoked"', (m) => { const s = st(m, bind({ revoked: true })); return s.kind === 'revoked' && s.incident === false }],
  ['revoked by signing out everywhere -> revoked, no flag', (m) => { const s = st(m, bind({ revoked: 'signout' })); return s.kind === 'revoked' && s.incident === false }],
  ['revoked by the incident lever -> revoked and flagged', (m) => { const s = st(m, bind({ revoked: 'incident' })); return s.kind === 'revoked' && s.incident === true }],
  ['revoked outranks a full verified binding', (m) => st(m, bind({ revoked: 'incident', tier: 'native', accountSince: 1 })).kind === 'revoked'],
  ['revoked with an unknown value -> failed, never a ✓', (m) => st(m, bind({ revoked: 'maybe' })).kind === 'failed'],
  ['revoked false -> verified as normal', (m) => st(m, bind({ revoked: false })).kind === 'verified'],
  ['revoked deleted (not in this contract) -> couldn\'t check, never a ✓', (m) => failed(m, bind({ revoked: 'deleted' }))],
  // vouchstate is the only type check on revoked (the kernel passes the host's
  // answer through): a serialiser that writes null, 0, '' or NaN for "not
  // revoked" must not earn a ✓ on a marked answer with a good name and voucher
  ['marker, revoked null -> couldn\'t check, never a ✓', (m) => failed(m, bind({ revoked: null }))],
  ['marker, revoked 0 -> couldn\'t check, never a ✓', (m) => failed(m, bind({ revoked: 0 }))],
  ['marker, revoked \'\' -> couldn\'t check, never a ✓', (m) => failed(m, bind({ revoked: '' }))],
  ['marker, revoked NaN -> couldn\'t check, never a ✓', (m) => failed(m, bind({ revoked: NaN }))],

  // the completeness marker: no ✓ for an answer that may have lost fields on the way
  ['six fields, no marker (a relay that copies the original six) -> couldn\'t check, never ✓',
    (m) => { const s = st(m, six()); return s.kind === 'failed' && s.why === 'incomplete' }],
  ['no marker with every G field present -> still couldn\'t check', (m) => st(m, six({ tier: 'native', accountSince: 1, unconfirmedSince: UNCONF_AT })).kind === 'failed'],
  ['a marker of another value (g2, G1, true, [g1]) -> couldn\'t check',
    (m) => ['g2', 'G1', true, ['g1'], ' g1', null].every((f) => failed(m, bind({ fields: f })))],
  // a changed binding only takes the ✓ away, so it is shown with or without the marker, like a revocation
  ['no marker, changed binding -> "⚠ changed" all the same (the safe direction)', (m) => st(m, six({ changed: true })).kind === 'changed'],
  ['no marker, changed binding with a bad voucher or no name -> couldn\'t check',
    (m) => failed(m, six({ changed: true, vouchedBy: 'a b' })) && failed(m, six({ changed: true, name: '' }))],
  // the marker is the answer's OWN data property: never inherited, never an accessor
  ['a marker inherited from Object.prototype -> couldn\'t check, never ✓', (m) => {
    const P = Object.prototype as Record<string, unknown>
    P.fields = 'g1'
    try { const s = st(m, six()); return s.kind === 'failed' && s.why === 'incomplete' } finally { delete P.fields }
  }],
  ['a marker on the answer\'s prototype -> couldn\'t check, never ✓',
    (m) => { const s = st(m, Object.assign(Object.create({ fields: 'g1' }), six())); return s.kind === 'failed' && s.why === 'incomplete' }],
  ['a marker as a getter returning g1 -> couldn\'t check, never ✓',
    (m) => { const s = st(m, Object.defineProperty(six(), 'fields', { get: () => 'g1', enumerable: true })); return s.kind === 'failed' && s.why === 'incomplete' }],
  ['positive control: an own data marker defined the same way -> verified',
    (m) => verified(m, Object.defineProperty(six(), 'fields', { value: 'g1', enumerable: true }))],
  ['no marker, revoked -> revoked all the same (the safe direction)',
    (m) => st(m, six({ revoked: 'signout' })).kind === 'revoked' && (st(m, six({ revoked: 'incident' })) as { incident?: boolean }).incident === true],
  ['marker, revoked absent -> verified', (m) => verified(m, bind())],
  ['marker, revoked signout -> revoked, no flag', (m) => { const s = st(m, bind({ revoked: 'signout' })); return s.kind === 'revoked' && s.incident === false }],
  ['marker, revoked incident -> revoked and flagged', (m) => { const s = st(m, bind({ revoked: 'incident' })); return s.kind === 'revoked' && s.incident === true }],
  ['a full marked answer with every optional field ABSENT -> verified, passkey, new, nothing changed, confirmed',
    (m) => { const s = st(m, bind()); return s.kind === 'verified' && s.tier === 'passkey' && s.newAccount === true && s.changedOn === null && s.unconfirmedOn === null }],

  // unconfirmedSince: the address part of the ✓ is qualified while the agent says so
  ['unconfirmedSince a time -> verified, qualified with that date',
    (m) => { const s = st(m, bind({ accountSince: NOW - 99 * DAY, unconfirmedSince: UNCONF_AT })); return s.kind === 'verified' && s.unconfirmedOn === UNCONF_AT }],
  ['unconfirmedSince a year ago still shows (no window: it is a current state)',
    (m) => st(m, bind({ unconfirmedSince: NOW - 400 * DAY })).unconfirmedOn === NOW - 400 * DAY],
  ['unconfirmedSince in the future still shows', (m) => st(m, bind({ unconfirmedSince: NOW + DAY })).unconfirmedOn === NOW + DAY],
  ['unconfirmedSince malformed (string, 0, -1, NaN, 2^60, 1.5, null, {}) -> couldn\'t check',
    (m) => [String(UNCONF_AT), 0, -1, NaN, 2 ** 60, 1.5, null, {}, true].every((v) => failed(m, bind({ unconfirmedSince: v })))],
  ['resetAt malformed -> couldn\'t check (missing reads stronger, so present must be a time)',
    (m) => [String(NOW), 0, -5, null, NaN].every((v) => failed(m, bind({ resetAt: v })))],
  ['a time past what a Date can hold (8.64e15 + 1) -> couldn\'t check; 8.64e15 itself is a time',
    (m) => failed(m, bind({ unconfirmedSince: 8.64e15 + 1 })) && failed(m, bind({ resetAt: 8.64e15 + 1 })) &&
      failed(m, bind({ rosterChangedAt: 8.64e15 + 1 })) && st(m, bind({ unconfirmedSince: 8.64e15 })).unconfirmedOn === 8.64e15],
  ['accountSince past what a Date can hold -> new account (the weaker claim)',
    (m) => st(m, bind({ accountSince: 8.64e15 + 1 })).newAccount === true],
  ['rosterChangedAt malformed -> couldn\'t check',
    (m) => [String(NOW), 0, -5, null, 1.25].every((v) => failed(m, bind({ rosterChangedAt: v })))],
  ['managedBy is ignored, whatever it holds', (m) => [undefined, 'example.com', '.', 42, null].every((v) => verified(m, bind({ managedBy: v })))],

  // vouchedBy is the voucher alone (kernel isVoucher): nothing is parsed out of it
  ['vouchedBy a voucher -> shown as is', (m) => st(m, bind({ vouchedBy: 'example.com' })).via === 'example.com'],
  ['vouchedBy with a qualifier in it -> couldn\'t check',
    (m) => ['id.bento.page, unconfirmed since 3 Mar 2027', 'id.bento.page (passkey sign-in)', 'id.bento.page, managed by example.com',
      'a b', 'Id.Bento.Page', 'id.bento.page ✓', ''].every((v) => failed(m, bind({ vouchedBy: v })))],
  ['vouchedBy of 81 characters -> couldn\'t check; of 80 -> verified',
    (m) => failed(m, bind({ vouchedBy: 'a'.repeat(81) })) && verified(m, bind({ vouchedBy: 'a'.repeat(80) }))],
  ['vouchedBy not a string -> couldn\'t check', (m) => [undefined, null, 7, ['id.bento.page']].every((v) => failed(m, bind({ vouchedBy: v })))],

  ['bidi and zero-width characters leave the name; in the voucher they fail it',
    (m) => st(m, bind({ name: '\u202Eevil\u200B name' })).name === 'evil name' && failed(m, bind({ vouchedBy: 'id.bento\u2066.page' }))],
  // C3: the account's own display name cannot draw a tick either; the wider list
  ['a verified name cannot carry a tick',
    (m) => { const s = st(m, bind({ name: 'Alice \u2713 via bigcorp.com' })); return s.kind === 'verified' && s.name === 'Alice via bigcorp.com' }],
  ['\u221A \u{1F5F9} \u237B \u{10102} and \u{1FBB1} are stripped as ticks',
    (m) => m.claimedName('A\u221A B\u{1F5F9} C\u237B D\u{10102} E\u{1FBB1}') === 'A B C D E'],
  // C4: a throwing answer is a failure, not "checking…" for ever
  ['an answer whose field read throws -> failed',
    (m) => st(m, { get name() { throw new Error('boom') }, vouchedBy: 'id.bento.page', changed: false, fields: 'g1' }).kind === 'failed' &&
      st(m, new Proxy({}, { get() { throw new Error('trap') } })).kind === 'failed'],
  ['a throwing marker or unconfirmedSince -> failed',
    (m) => failed(m, Object.defineProperty(six(), 'fields', { get() { throw new Error('m') }, enumerable: true })) &&
      failed(m, Object.defineProperty(bind(), 'unconfirmedSince', { get() { throw new Error('u') }, enumerable: true })) &&
      failed(m, new Proxy(bind(), { get(t, k) { if (k === 'unconfirmedSince') throw new Error('p'); return Reflect.get(t, k) } }))],
  // C6: invisible by category
  ['ALM, soft hyphen, CGJ, tag characters, private use, unassigned, separators leave',
    (m) => m.cleanText('a\u061Cb\u00ADc\u034Fd\u{E0041}e\uE000f\u0378g\u2028h\u2029i', 80) === 'abcdefghi'],
  ['Hangul fillers leave (they render as blank space)',
    (m) => m.cleanText('Bob\u3164\u3164\u115F\u1160\uFFA0x', 80) === 'Bobx'],
  ['the Braille blank leaves (it renders as blank space)',
    (m) => m.cleanText('Bob\u2800\u2800x', 80) === 'Bobx'],
  ['ordinary letters, CJK, emoji and accents stay',
    (m) => m.cleanText('Zoë 山田 \u{1F600} José', 80) === 'Zoë 山田 \u{1F600} José'],
  ['a typed name cannot carry a tick', (m) => m.claimedName('Mallory ✓ via id.bento.page ✔') === 'Mallory via id.bento.page'],
]

function run(m: Mod): string[] {
  const failed: string[] = []
  for (const [name, f] of ROWS) {
    let ok = false
    try { ok = f(m) === true } catch { ok = false }
    if (!ok) failed.push(name)
  }
  return failed
}

const MUTANTS: [string, string, string][] = [
  ['revocation ignored', 'if (rv !== undefined && rv !== false) {', 'if (false) {'],
  ['incident not flagged', "return { kind: 'revoked', incident: true }", "return { kind: 'revoked', incident: false }"],
  ['tier fails open', "a.tier === 'native' ? 'native' : 'passkey'", "a.tier === 'passkey' ? 'passkey' : 'native'"],
  ['missing accountSince reads as old', '!isTime(since) || now - since', 'isTime(since) && now - since'],
  ['new-account window 7 days', 'now - since < NEW_ACCOUNT_MS', 'now - since < CHANGED_SHOWN_MS'],
  ['changed window unbounded', 'now - a.rosterChangedAt < CHANGED_SHOWN_MS &&', ''],
  ['reset ignored', 'if (isTime(a.resetAt) && now - a.resetAt', 'if (false && now - a.resetAt'],
  ['reset shown at any age', 'now - a.resetAt < RESET_SHOWN_MS', 'now - a.resetAt < Infinity'],
  ['reset window 7 days', 'now - a.resetAt < RESET_SHOWN_MS', 'now - a.resetAt < CHANGED_SHOWN_MS'],
  ['changed binding ticked', 'if (a.changed === true) return name', 'if (false) return name'],
  ['invisible characters kept', "s.replace(INVISIBLE, '')", 's'],
  ['ticks kept in verified names', 'const name = claimedName(a.name)', 'const name = cleanText(a.name, NAME_MAX)'],
  ['a throwing answer escapes', "try { return decide(r, now) } catch { return { kind: 'failed' } }", 'return decide(r, now)'],
  ['invisible list down to controls', '[\\p{Cc}\\p{Cf}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}\\u115F\\u1160\\u3164\\uFFA0\\u2800]', '[\\p{Cc}]'],
  ['default-ignorables and Hangul fillers kept', '\\p{Default_Ignorable_Code_Point}\\u115F\\u1160\\u3164\\uFFA0\\u2800]', ']'],
  ['new tick marks kept', '\\u221A\\u237B\\u{1F5F8}\\u{1F5F9}\\u{10102}\\u{1FBB1}]', '\\u{1F5F8}]'],
  ['ticks kept in typed names', "cleanText(s.replace(TICKS, ''), NAME_MAX)", 'cleanText(s, NAME_MAX)'],
  // the completeness marker and the tier fields
  ['the marker check removed', "if (!ownMarker(a)) return { kind: 'failed', why: 'incomplete' }", ''],
  ['the marker treated as optional', 'if (!ownMarker(a)) return', 'if (a.fields !== undefined && !ownMarker(a)) return'],
  ['any truthy marker accepted', 'if (!ownMarker(a)) return', 'if (!a.fields) return'],
  ['revoked read only when the marker is absent', 'if (rv !== undefined && rv !== false) {', 'if (!ownMarker(a) && rv !== undefined && rv !== false) {'],
  ['the marker checked before revocation', "  // revocation outranks everything: a revoked sign-in never shows a ✓\n", "  if (!ownMarker(a)) return { kind: 'failed' }\n"],
  ['the marker read through the prototype', "const d = Object.getOwnPropertyDescriptor(a, 'fields'); return d !== undefined && 'value' in d && d.value === RESOLVED_FIELDS", "return (a as Record<string, unknown>).fields === RESOLVED_FIELDS"],
  ['an accessor marker accepted', "d !== undefined && 'value' in d && d.value === RESOLVED_FIELDS", "d !== undefined && (a as Record<string, unknown>).fields === RESOLVED_FIELDS"],
  ['a changed binding hidden without the marker', 'if (a.changed === true) return', 'if (a.changed === true && ownMarker(a)) return'],
  ['a changed binding shown with any voucher', 'name && isVoucher(via) ? { kind: \'changed\'', 'name ? { kind: \'changed\''],
  ['a reset dated in the viewer\'s future dropped', 'if (isTime(a.resetAt) && now - a.resetAt', 'if (isTime(a.resetAt) && now >= a.resetAt && now - a.resetAt'],
  ['a roster change dated in the viewer\'s future dropped', 'isTime(a.rosterChangedAt) && now - a.rosterChangedAt', 'isTime(a.rosterChangedAt) && now >= a.rosterChangedAt && now - a.rosterChangedAt'],
  ['unconfirmedSince never read', 'const unconfirmedOn = isTime(a.unconfirmedSince) ? a.unconfirmedSince : null', 'const unconfirmedOn = null'],
  ['a malformed unconfirmedSince read as absent', ' || malformed(a.unconfirmedSince)) return', ') return'],
  ['a malformed resetAt read as absent', 'if (malformed(a.resetAt) || ', 'if ('],
  ['a malformed rosterChangedAt read as absent', ' || malformed(a.rosterChangedAt)', ''],
  ['0 counts as a time', '&& Number.isSafeInteger(v) && v > 0', '&& Number.isSafeInteger(v) && v >= 0'],
  ['any non-empty vouchedBy accepted (the old cutVia path)', '!isVoucher(via)', "!(typeof via === 'string' && via.length > 0)"],
  ['revoked read by truthiness (null, 0, \'\', NaN read as absent)', 'if (rv !== undefined && rv !== false) {', 'if (rv) {'],
  ['an undefined answer read as "not verified"', 'if (r === null) return', 'if (r == null) return'],
  ['a roster change always beats a reset for the date shown', '(changedOn === null || a.rosterChangedAt > changedOn)', 'true'],
  ['times past what a Date can hold accepted', ' && v <= MAX_TIME', ''],
  ['revoked deleted read as not revoked', '    return { kind: \'failed\' }\n  }\n  const name', '  }\n  const name'],
]

let failures = 0
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'people-tiers-')))
try {
  const orig = readFileSync(SRC, 'utf8')
  let n = 0
  // the copy lives in a scratch dir, so its one import (the kernel's marker
  // value and voucher shape) is pointed back at the real file
  const KERNEL_ID = new URL('../kernel/src/identity.ts', import.meta.url).href
  const load = async (text: string): Promise<Mod> => {
    const f = join(dir, `vouchstate-${n++}.ts`)
    const rel = "'../../../kernel/src/identity.ts'"
    if (text.split(rel).length !== 2) throw new Error('vouchstate.ts: expected exactly one kernel identity import')
    writeFileSync(f, text.replace(rel, `'${KERNEL_ID}'`))
    return import(pathToFileURL(f).href) as Promise<Mod>
  }
  const base = run(await load(orig))
  console.log(`rows: ${ROWS.length - base.length}/${ROWS.length} pass on the unmutated copy`)
  for (const b of base) { failures++; console.log(`  FAIL  ${b}`) }
  for (const [name, from, to] of MUTANTS) {
    const parts = orig.split(from)
    if (parts.length !== 2) { failures++; console.log(`  FAIL  mutant "${name}": needle found ${parts.length - 1} times`); continue }
    const red = run(await load(parts.join(to)))
    if (red.length === 0) { failures++; console.log(`  FAIL  mutant "${name}" survived`) }
    else console.log(`  ok    mutant "${name}" red (${red.length} rows, e.g. "${red[0]}")`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(`\n${ROWS.length} rows, ${MUTANTS.length} mutants, ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
