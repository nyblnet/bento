// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Daily notes: a journal entry is a page with a date on it.
//
// THE MODEL, and why it is not Logseq's. Logseq derives a journal from its
// PAGE TITLE, formatted by `:journal/page-title-format`. That is the one thing
// worth not copying: their own tracker carries "Changing journal filename
// format causes blank journals and data loss" (logseq/logseq#4019 and the
// discuss thread behind it), because the moment the format changes, yesterday's
// journals stop being journals. A title is display; a date is data.
//
// So `page.journal` holds an ISO `YYYY-MM-DD` and that is the truth. The title
// is an ordinary title — it starts as the same ISO string and the author may
// rename it to "Monday — sprint kickoff" without the page ceasing to be that
// day's entry. Three things fall out:
//
//  · The FILE is locale-neutral. A space written in Tokyo and opened in Lisbon
//    shows each reader their own date format, because the label is rendered
//    from `journal` through Intl at display time and never stored. Same rule as
//    every other string in this app: language follows the viewer, never the
//    document (PLATFORM §8).
//  · Search, grep and the Markdown export all see `2026-08-06`, which sorts and
//    is unambiguous in every locale — unlike "06/08/2026".
//  · An older build that has never heard of journals renders an ordinary page
//    with an ordinary title, and round-trips `journal` untouched. Additive, per
//    PLATFORM §3.
//
// A JOURNAL IS A PAGE, exactly as an issue is a page. It searches, links,
// back-links, prints, exports, undoes and (when collaboration lands) merges
// like everything else, because it IS everything else. Nothing here introduces
// a second kind of thing.
//
// CREATED ON DEMAND, NOT ONE PER DAY FOREVER. Logseq makes a journal page every
// day you open the app; on a filesystem that is a cheap empty file. This whole
// document is ONE file that people mail to each other, so a page per unopened
// day is permanent weight for nothing. Today's entry appears when you ask for
// it.

import type { SpacesDoc, Page } from './model.ts'
import { newPage } from './model.ts'

/** The page-tree parent every entry hangs from, so the sidebar stays a tree
 *  rather than a wall of dates. Mirrors the tracker's Tracker page. */
export const JOURNAL_HOME_TITLE = 'Journal'

/** A page IS an entry when it carries a date. Not a flag, not a page type —
 *  remove the date and it is an ordinary page again, with everything on it
 *  intact. */
export const isJournal = (p: Page): boolean => typeof p.journal === 'string' && isISO(p.journal)

const SHAPE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A REAL date, not merely a digit-shaped string.
 *
 * `2026-13-99` matches the shape and is not a date, and every Date-based
 * formatter will silently roll it over into some OTHER real date — so a
 * nonsense value in a hand-edited or mailed file would be displayed as a
 * confident wrong day rather than as itself. The round trip is the check:
 * build the date, ask what it thinks it is, and require the same string back.
 */
export function isISO(v: string): boolean {
  if (!SHAPE.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const at = new Date(y, m - 1, d)
  return at.getFullYear() === y && at.getMonth() === m - 1 && at.getDate() === d
}

/**
 * Today, in the READER'S OWN TIMEZONE.
 *
 * `new Date().toISOString().slice(0,10)` is the bug this exists to avoid: it
 * is UTC, so for anyone east of Greenwich after their evening cutoff — and
 * anyone west of it before theirs — "today" is the wrong day for several hours
 * out of every twenty-four. A journal is about the writer's day, not the prime
 * meridian's.
 */
export function todayISO(now: Date = new Date()): string {
  return toISO(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

const pad = (n: number) => String(n).padStart(2, '0')
const toISO = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`

/**
 * The day `n` days from `iso`, on the CALENDAR.
 *
 * Not `+ n * 86400000`: a day is not always 86,400 seconds. On the two
 * daylight-saving boundaries each year it is 23 or 25 hours, and epoch
 * arithmetic silently skips or repeats a date. Handing the components to the
 * Date constructor lets it do the rollover — month lengths, leap years and
 * DST — which is the one piece of date work worth delegating.
 *
 * Parsed component-wise for the same reason `todayISO` exists: `new
 * Date('2026-08-06')` is UTC MIDNIGHT by spec, so it is the previous day for
 * every reader west of Greenwich.
 */
export function stepDay(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const at = new Date(y, m - 1, d + n)
  return toISO(at.getFullYear(), at.getMonth() + 1, at.getDate())
}

/**
 * The reader's own name for a date — "Thursday, 6 August 2026".
 *
 * Rendered, never stored. Intl is in every browser this app supports and costs
 * nothing in the shell, where a date library would cost more than the feature.
 * A locale Intl cannot honour falls back to the ISO string, which is wrong in
 * nobody's language rather than misleading in one.
 */
export function journalLabel(iso: string, locale?: string): string {
  if (!isISO(iso)) return iso
  const [y, m, d] = iso.split('-').map(Number)
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    }).format(new Date(y, m - 1, d))
  } catch {
    return iso
  }
}

/** A short label for a tight space — "Thu 6 Aug". */
export function journalShort(iso: string, locale?: string): string {
  if (!isISO(iso)) return iso
  const [y, m, d] = iso.split('-').map(Number)
  try {
    return new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' })
      .format(new Date(y, m - 1, d))
  } catch {
    return iso
  }
}

/** Every entry, NEWEST FIRST — the order a journal is read in. */
export function journalsOf(doc: SpacesDoc): Page[] {
  return doc.pages.filter((p) => isJournal(p) && !p.archived)
    .sort((a, b) => String(b.journal).localeCompare(String(a.journal)))
}

/** The entry for a date, if the space already has one. */
export const journalFor = (doc: SpacesDoc, iso: string): Page | undefined =>
  doc.pages.find((p) => isJournal(p) && p.journal === iso)

/** The page entries hang from, if it exists. */
export const journalHome = (doc: SpacesDoc): Page | undefined =>
  doc.pages.find((p) => p.journalHome === true)

/**
 * The pages a space needs so that `iso` has an entry — as a PLAN, applied by
 * the caller inside one commit.
 *
 * Returns what already exists rather than creating a duplicate, so calling it
 * twice in a day is idempotent — which matters, because the topbar button, the
 * shortcut and the agent verb all land here.
 *
 * ORDER: an entry is inserted directly after the Journal page, so the newest
 * is first in the sidebar and `doc.pages` stays in pre-order (a child must
 * follow its parent — the invariant the whole format rests on).
 */
export interface JournalPlan {
  /** the entry — existing, or newly minted */
  page: Page
  /** pages to add, in the order they must be inserted */
  add: Array<{ page: Page; after?: string }>
}

export function planJournal(doc: SpacesDoc, iso: string): JournalPlan {
  const existing = journalFor(doc, iso)
  if (existing) return { page: existing, add: [] }

  const add: JournalPlan['add'] = []
  let home = journalHome(doc)
  if (!home) {
    home = newPage(JOURNAL_HOME_TITLE, { icon: 'book', journalHome: true })
    add.push({ page: home })
  }
  // The title starts as the ISO date: locale-neutral in the file, sortable,
  // greppable, and the same for every reader. The UI shows a localized label.
  const page = newPage(iso, { parent: home.id, journal: iso })

  // WHERE IT GOES: after the last entry NEWER than this one, so the list reads
  // newest-first whatever order the days were written in. Inserting blindly
  // after the Journal page gives reverse-CREATION order instead, which looks
  // like a sorted list until someone backfills yesterday and it silently is
  // not one. Entries stay contiguous under their parent either way, so the
  // pre-order invariant holds.
  const newer = doc.pages.filter((p) => isJournal(p) && String(p.journal) > iso)
  const anchor = newer.length ? newer[newer.length - 1].id : home.id
  add.push({ page, after: anchor })
  return { page, add }
}
