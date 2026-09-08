#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Daily notes — the date arithmetic, and the shape of an entry.
//
//   node scripts/test-spaces-journal.ts
//   TZ=Pacific/Kiritimati node scripts/test-spaces-journal.ts
//
// WHY A RIG FOR SOMETHING THIS SMALL. Every part of a journal that can be
// wrong is wrong QUIETLY, and on someone else's machine:
//
//  · "Today" computed in UTC is the wrong day for hours at a time, for
//    everyone who does not live in Greenwich. The writer notices when their
//    evening notes land on tomorrow's page.
//  · Adding 86,400,000 milliseconds is not adding a day. Twice a year it skips
//    one or repeats one, and only in timezones that observe DST — so it passes
//    every test run in UTC and fails in March in Berlin.
//  · `new Date('2026-08-06')` is UTC midnight BY SPEC, which is the 5th for
//    every reader in the Americas.
//
// This file is run under several TZ values in CI for exactly that reason: a
// date test that only ever runs in one timezone is a date test that has not
// been run.

import { todayISO, stepDay, journalLabel, journalShort, isJournal, journalsOf, journalFor, planJournal, journalHome } from '../spaces/src/journal.ts'
import { parseDoc, FORMAT } from '../spaces/src/model.ts'
import type { SpacesDoc, Page } from '../spaces/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

console.log(`bento/spaces journals   (TZ=${process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone})\n`)

// ---- today is the READER'S today -------------------------------------------
{
  // 23:30 local on 6 August. In UTC+14 that is already the 7th in UTC terms
  // going one way, and in UTC-11 the 5th going the other — the exact window
  // where toISOString() lies.
  const late = new Date(2026, 7, 6, 23, 30, 0)
  ok(todayISO(late) === '2026-08-06',
    `late-evening local time is still today (got ${todayISO(late)})`)
  const early = new Date(2026, 7, 6, 0, 15, 0)
  ok(todayISO(early) === '2026-08-06',
    `just-after-midnight local time is today (got ${todayISO(early)})`)

  // the control: this is what the naive implementation would have produced
  const naive = late.toISOString().slice(0, 10)
  console.log(`        (toISOString would have said ${naive} for 23:30 on the 6th)`)
}

// ---- a day is a calendar day, not 86,400,000 ms ----------------------------
{
  ok(stepDay('2026-08-06', 1) === '2026-08-07', 'forward one day')
  ok(stepDay('2026-08-06', -1) === '2026-08-05', 'back one day')
  ok(stepDay('2026-08-31', 1) === '2026-09-01', 'over a month end')
  ok(stepDay('2026-12-31', 1) === '2027-01-01', 'over a year end')
  ok(stepDay('2026-01-01', -1) === '2025-12-31', 'back over a year end')
  ok(stepDay('2024-02-28', 1) === '2024-02-29', 'into a leap day')
  ok(stepDay('2024-03-01', -1) === '2024-02-29', 'back into a leap day')
  ok(stepDay('2025-02-28', 1) === '2025-03-01', 'and past it in a common year')

  // THE DST CASES. In Europe/London the clocks go forward on 2026-03-29 and
  // back on 2026-10-25; those days are 23 and 25 hours long. Epoch arithmetic
  // lands mid-day and truncates to the wrong date.
  ok(stepDay('2026-03-28', 1) === '2026-03-29', 'across a spring-forward boundary')
  ok(stepDay('2026-03-29', 1) === '2026-03-30', '…and off it again')
  ok(stepDay('2026-10-24', 1) === '2026-10-25', 'across an autumn-back boundary')
  ok(stepDay('2026-10-25', 1) === '2026-10-26', '…and off it again')

  // stepping out and back is the identity, every day of a year
  let roundTrips = true
  let cur = '2026-01-01'
  for (let i = 0; i < 365; i++) {
    if (stepDay(stepDay(cur, 1), -1) !== cur) { roundTrips = false; break }
    cur = stepDay(cur, 1)
  }
  ok(roundTrips, 'forward-then-back is the identity for every day of a year')
  ok(cur === '2027-01-01', `365 steps from 2026-01-01 lands on 2027-01-01 (got ${cur})`)
}

// ---- the label is the reader's, and never stored ---------------------------
{
  const en = journalLabel('2026-08-06', 'en-GB')
  const ja = journalLabel('2026-08-06', 'ja-JP')
  const de = journalLabel('2026-08-06', 'de-DE')
  ok(en.includes('2026') && /august/i.test(en), `en-GB reads as a date (${en})`)
  ok(ja !== en && ja.includes('2026'), `ja-JP differs from en-GB (${ja})`)
  ok(de !== en && /august/i.test(de), `de-DE differs too (${de})`)
  ok(journalLabel('2026-08-06', 'en-GB') === en, 'and is deterministic')
  ok(journalShort('2026-08-06', 'en-GB').length < en.length, 'the short form is shorter')

  // a value that is not a date is handed back untouched rather than becoming
  // "Invalid Date" — this string came out of a file someone sent you
  ok(journalLabel('not a date') === 'not a date', 'a non-date label falls back to itself')
  ok(journalLabel('') === '', 'and so does an empty one')
  ok(journalShort('2026-13-99') === '2026-13-99', 'an impossible date is not reformatted')
}

// ---- an entry is a page with a date ----------------------------------------
{
  const page = (extra: Record<string, unknown>): Page =>
    ({ id: 'p', title: 't', blocks: [], ...extra } as Page)
  ok(isJournal(page({ journal: '2026-08-06' })), 'a page with an ISO date is an entry')
  ok(!isJournal(page({})), 'a page without one is not')
  ok(!isJournal(page({ journal: '6 August 2026' })), 'a formatted date is NOT a date — only ISO counts')
  ok(!isJournal(page({ journal: 12345 })), 'and neither is a number')
  ok(!isJournal(page({ journal: '2026-8-6' })), 'nor an unpadded one, which would sort wrong')
  // digit-shaped but not a date: every Date-based formatter rolls this over
  // into some OTHER real day, so it must be rejected rather than displayed as
  // a confident wrong answer
  ok(!isJournal(page({ journal: '2026-13-99' })), 'and an impossible date is not a date')
  ok(!isJournal(page({ journal: '2025-02-29' })), 'nor 29 February in a common year')
  ok(isJournal(page({ journal: '2024-02-29' })), '…which IS a date in a leap year')
}

// ---- planning: idempotent, ordered, and pre-order safe ----------------------
const load = (pages: unknown[]): SpacesDoc => {
  const r = parseDoc(JSON.stringify({
    format: FORMAT, version: 1, docId: 'd', title: 'S', home: (pages[0] as { id: string })?.id,
    theme: { background: '#fff', color: '#000', accent: '#f00', measure: 720 }, pages,
  }))
  if (!r.ok) throw new Error('fixture did not parse')
  return r.doc
}
const apply = (doc: SpacesDoc, plan: ReturnType<typeof planJournal>) => {
  for (const { page, after } of plan.add) {
    const at = after ? doc.pages.findIndex((p) => p.id === after) : -1
    if (at >= 0) doc.pages.splice(at + 1, 0, page)
    else doc.pages.push(page)
  }
}
{
  const doc = load([{ id: 'p1', title: 'Welcome', blocks: [{ id: 'b1', type: 'p', html: 'hi' }] }])
  const first = planJournal(doc, '2026-08-06')
  ok(first.add.length === 2, 'the first entry brings its Journal page with it')
  apply(doc, first)
  ok(!!journalHome(doc), 'the Journal page is marked as the home for entries')
  ok(journalFor(doc, '2026-08-06')?.id === first.page.id, 'and the entry is findable by date')

  // idempotent: the button, the shortcut and the agent verb all land here
  const again = planJournal(doc, '2026-08-06')
  ok(again.add.length === 0 && again.page.id === first.page.id,
    'planning the same day twice adds nothing and returns the same page')

  const second = planJournal(doc, '2026-08-07')
  ok(second.add.length === 1, 'a later entry reuses the existing Journal page')
  apply(doc, second)

  // newest first — the order a journal is read in
  ok(journalsOf(doc).map((p) => p.journal).join(',') === '2026-08-07,2026-08-06',
    'entries list newest first')

  // …and so does doc.pages ITSELF, which is what the sidebar renders. Writing
  // the days out of order is the normal case — you backfill yesterday — and
  // inserting each new entry straight after the Journal page would give
  // reverse-CREATION order, which looks sorted until it is not.
  const back = planJournal(doc, '2026-08-04')
  apply(doc, back)
  const mid = planJournal(doc, '2026-08-06')      // already exists
  ok(mid.add.length === 0, 'backfilling a day that exists adds nothing')
  const later = planJournal(doc, '2026-08-09')
  apply(doc, later)
  const order = doc.pages.filter((p) => p.journal).map((p) => p.journal).join(',')
  ok(order === '2026-08-09,2026-08-07,2026-08-06,2026-08-04',
    `doc.pages holds entries newest-first however they were written (got ${order})`)

  // PRE-ORDER: a child must follow its parent, or the sidebar cannot be built
  const at = new Map(doc.pages.map((p, i) => [p.id, i]))
  const broken = doc.pages.filter((p) => p.parent && (at.get(p.parent) ?? 1e9) >= (at.get(p.id) ?? -1))
  ok(broken.length === 0, `every entry follows the Journal page in doc.pages (${broken.length} out of order)`)

  // the title is the ISO date: locale-neutral in the file, and the same for
  // every reader who opens it
  ok(first.page.title === '2026-08-06', 'the stored title is the ISO date, not a localized string')
  // …and renaming it does NOT stop the page being that day's entry
  first.page.title = 'Monday — sprint kickoff'
  ok(isJournal(first.page) && journalFor(doc, '2026-08-06')?.id === first.page.id,
    'renaming an entry does not unmake it — the date is the truth, the title is display')
}

// ---- an archived entry leaves the list, not the file -----------------------
{
  const doc = load([{ id: 'p1', title: 'W', blocks: [{ id: 'b1', type: 'p', html: '' }] }])
  const plan = planJournal(doc, '2026-08-06')
  apply(doc, plan)
  ;(journalFor(doc, '2026-08-06') as Page).archived = true
  ok(journalsOf(doc).length === 0, 'an archived entry drops out of the journal list')
  ok(!!journalFor(doc, '2026-08-06'), '…but is still in the file, and still findable by date')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
