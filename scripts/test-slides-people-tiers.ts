// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// What the People panel may say about a collaborator (bento/id P1, option G tiers).
//
//   node scripts/test-slides-people-tiers.ts
//
// Rows over slides/src/editor/vouchstate.ts, the decision behind every label:
// "(passkey sign-in)", "new account" (14 days), "account changed on <date>"
// (7 days; 30 after a reset), "this sign-in was revoked" (no ✓; an incident flags the
// row), the name's tick and invisible-character strip, and vouchedBy's 80-character cut, which drops "managed by" before it
// drops "unconfirmed since". A MISSING field always reads as the weaker claim.
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

const bind = (extra: Record<string, unknown> = {}) => ({
  name: 'Alice Real', email: 'alice@example.com', vouchedBy: 'id.bento.page', accountPub: 'A', firstSeen: 1, changed: false, ...extra,
})
const st = (m: Mod, a: unknown) => m.stateFromAnswer(a, NOW) as Record<string, unknown>
const LONG_DOM = 'engineering-and-operations.subsidiary.example-corporation.co.uk'
const UNCONF = 'unconfirmed since 3 Mar 2027'

const ROWS: Row[] = [
  ['null answer -> not verified', (m) => st(m, null).kind === 'unverified'],
  ['a non-object answer -> failed', (m) => st(m, 'yes').kind === 'failed'],
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
  ['a recent change after an old reset shows the recent date',
    (m) => st(m, bind({ resetAt: NOW - 400 * DAY, rosterChangedAt: NOW - 2 * DAY })).changedOn === NOW - 2 * DAY],

  ['revoked -> no ✓, "this sign-in was revoked"', (m) => { const s = st(m, bind({ revoked: true })); return s.kind === 'revoked' && s.incident === false }],
  ['revoked by signing out everywhere -> revoked, no flag', (m) => { const s = st(m, bind({ revoked: 'signout' })); return s.kind === 'revoked' && s.incident === false }],
  ['revoked by the incident lever -> revoked and flagged', (m) => { const s = st(m, bind({ revoked: 'incident' })); return s.kind === 'revoked' && s.incident === true }],
  ['revoked outranks a full verified binding', (m) => st(m, bind({ revoked: 'incident', tier: 'native', accountSince: 1 })).kind === 'revoked'],
  ['revoked with an unknown value -> failed, never a ✓', (m) => st(m, bind({ revoked: 'maybe' })).kind === 'failed'],
  ['revoked false -> verified as normal', (m) => st(m, bind({ revoked: false })).kind === 'verified'],

  // vouchedBy and the 80-character cut
  ['the cut is the kernel\'s VOUCHED_BY_MAX, 80', (m) => m.VIA_MAX === 80],
  ['a short vouchedBy is kept whole', (m) => st(m, bind({ vouchedBy: `id.bento.page, ${UNCONF}` })).via === `id.bento.page, ${UNCONF}`],
  ['over 80: "managed by" goes, "unconfirmed" stays',
    (m) => m.cutVia(`id.bento.page, managed by ${LONG_DOM}, ${UNCONF}`) === `id.bento.page, ${UNCONF}`],
  ['over 80: "managed by" goes even when the agent put it last',
    (m) => m.cutVia(`id.bento.page, ${UNCONF}, managed by ${LONG_DOM}`) === `id.bento.page, ${UNCONF}`],
  ['over 80: a localised "managed by" goes when managedBy names its domain',
    (m) => m.cutVia(`id.bento.page, verwaltet von ${LONG_DOM}, unbestätigt seit 3. März 2027`, LONG_DOM) === 'id.bento.page, unbestätigt seit 3. März 2027'],
  ['over 80 with no managed segment: a middle qualifier goes, the last stays',
    (m) => { const v = m.cutVia(`id.bento.page, ${'x'.repeat(60)}, ${UNCONF}`); return v === `id.bento.page, ${UNCONF}` }],
  ['a long voucher is shortened, the last qualifier kept whole, within 80',
    (m) => { const v = m.cutVia(`${LONG_DOM}.voucher.example.org, ${UNCONF}`); return v.length <= 80 && v.endsWith(`…, ${UNCONF}`) }],
  ['the cut never exceeds 80, whatever the input',
    (m) => [`id.bento.page, managed by ${LONG_DOM}, ${UNCONF}`, 'x'.repeat(300), `a, ${'y'.repeat(200)}`, `${'z'.repeat(90)}, ${UNCONF}`]
      .every((s) => m.cutVia(s).length <= 80)],
  ['a qualifier too long to keep whole is cut at the end', (m) => { const v = m.cutVia(`a, ${'y'.repeat(200)}`); return v.length === 80 && v.endsWith('…') }],

  ['bidi and zero-width characters leave the name and the voucher',
    (m) => { const s = st(m, bind({ name: '‮evil​ name', vouchedBy: 'id.bento⁦.page' })); return s.name === 'evil name' && s.via === 'id.bento.page' }],
  // C3: the account's own display name cannot draw a tick either; the wider list
  ['a verified name cannot carry a tick',
    (m) => { const s = st(m, bind({ name: 'Alice \u2713 via bigcorp.com' })); return s.kind === 'verified' && s.name === 'Alice via bigcorp.com' }],
  ['\u221A \u{1F5F9} \u237B \u{10102} and \u{1FBB1} are stripped as ticks',
    (m) => m.claimedName('A\u221A B\u{1F5F9} C\u237B D\u{10102} E\u{1FBB1}') === 'A B C D E'],
  // C4: a throwing answer is a failure, not "checking…" for ever
  ['an answer whose field read throws -> failed',
    (m) => st(m, { get name() { throw new Error('boom') }, vouchedBy: 'id.bento.page', changed: false }).kind === 'failed' &&
      st(m, new Proxy({}, { get() { throw new Error('trap') } })).kind === 'failed'],
  // C5: managedBy only as a whole domain
  ['managedBy "." never drops a German "unbestätigt seit" lapse',
    (m) => m.cutVia(`id.bento.page, ${'x'.repeat(40)}, unbestätigt seit 3. März 2027`, '.') === 'id.bento.page, unbestätigt seit 3. März 2027'],
  ['managedBy that is not a domain ("seit") matches nothing',
    (m) => m.cutVia(`id.bento.page, ${'y'.repeat(50)}, unbestätigt seit 3. März 2027`, 'seit') === 'id.bento.page, unbestätigt seit 3. März 2027'],
  ['managedBy matches only on word boundaries',
    (m) => { const v = m.cutVia(`id.bento.page, notexample.com and more text here, verwaltet von example.com ${'z'.repeat(20)}`, 'example.com'); return v.includes('notexample.com') && !v.includes('verwaltet') }],
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
  ['changed binding ticked', "if (a.changed) return { kind: 'changed', name, via }", "if (false) return { kind: 'changed', name, via }"],
  ['managed-by not dropped first', 'if (quals.length && !fits(head, quals)) quals = quals.filter', 'if (false) quals = quals.filter'],
  ['last qualifier dropped', 'quals.splice(quals.length - 2, 1)', 'quals.splice(quals.length - 1, 1)'],
  ['plain prefix cut', 'if (full.length <= max) return full', 'return cleanText(full, max)'],
  ['invisible characters kept', "s.replace(INVISIBLE, '')", 's'],
  ['ticks kept in verified names', 'const name = claimedName(a.name)', 'const name = cleanText(a.name, NAME_MAX)'],
  ['a throwing answer escapes', "try { return decide(r, now) } catch { return { kind: 'failed' } }", 'return decide(r, now)'],
  ['managedBy matched as a substring', 'domRe !== null && domRe.test(q)', "dom.length > 0 && q.toLowerCase().includes(dom)"],
  ['invisible list down to controls', '[\\p{Cc}\\p{Cf}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}\\u115F\\u1160\\u3164\\uFFA0\\u2800]', '[\\p{Cc}]'],
  ['default-ignorables and Hangul fillers kept', '\\p{Default_Ignorable_Code_Point}\\u115F\\u1160\\u3164\\uFFA0\\u2800]', ']'],
  ['new tick marks kept', '\\u221A\\u237B\\u{1F5F8}\\u{1F5F9}\\u{10102}\\u{1FBB1}]', '\\u{1F5F8}]'],
  ['ticks kept in typed names', "cleanText(s.replace(TICKS, ''), NAME_MAX)", 'cleanText(s, NAME_MAX)'],
]

let failures = 0
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'people-tiers-')))
try {
  const orig = readFileSync(SRC, 'utf8')
  let n = 0
  // the copy lives in a scratch dir, so its one import (the kernel's
  // VOUCHED_BY_MAX) is pointed back at the real file
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
