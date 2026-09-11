// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// What a fresh bento/spaces file opens with.
//
// The brief slides set: the product demo, the launch asset and the feature
// tour in one — every claim it makes is proven by the feature making it. So
// the page that describes links CONTAINS a link, the page that describes
// tables IS one, the page about archiving is the archived page, and the limits
// page says the awkward things out loud rather than letting them be
// discovered.
//
// A FEATURE THE STARTER DOES NOT DEMONSTRATE IS A FEATURE THE STARTER DENIES.
// That is the rule this file is judged by, and it is a rule with a maintenance
// cost: everything that ships has to be walked back through here, or the first
// document every user reads quietly says the app cannot do it. The tracker was
// the first thing to arrive that way — a fresh space opened on the notes tour
// while the board, the fields and ⌘⇧I existed only for someone who already
// knew to look. Tables, clips, link cards, comments, calculating lines, daily
// notes, page width, export-a-page, subtree import, the mark palette, live
// collaboration and the properties panel all arrived the same way afterwards,
// and are here now.
//
// So did the twelve after those, and they are named here because the rule
// above is only worth anything if somebody can check it: transclusion (the
// `embed` block), page templates and the daily-note template, the calendar
// layout, the phone's press-and-hold drag, page → deck export, the reading
// view and the reading copy, view filters that ask a real question, `#tag`,
// footnotes, page aliases and unlinked mentions, in-file version history, and
// the table view's click-to-sort and edit-in-place. Every one of them is
// demonstrated by a page that USES it — three of them (the reading view, the
// deck export and version history) are chrome rather than content and can only
// be pointed at, so they are pointed at from a page whose own shape is the
// thing they act on, and never from a page about them.
//
// And so did the round after THOSE: the Gantt and workload view layouts, the
// `start` date field they schedule from, the burndown/burnup/cumulative-flow
// chart blocks with `doc.trail` and `doc.periods` behind them, and the block
// bar (⌘/) with the indent and outdent controls that existed on no surface at
// any width before it.
//
// THE BLOCK BAR IS THE INTERESTING ONE, because it is pure chrome — it has no
// document surface at all, so by the pointing-at rule above it would get a
// paragraph saying "press ⌘/" and nothing else. It does not. It gets a list
// that is WRONG ON PURPOSE (Writing → "A list in the wrong shape"), where the
// nesting is obviously implied and obviously absent, plus two paragraphs
// sitting among the Inbox's to-dos in the wrong block type. The control is the
// natural way to finish the page, so the reader ends up having USED the
// gesture rather than having read about it — which is the difference between a
// demonstration and a manual, and it is available for any chrome whose effect
// is visible in a document at all. The same trick carries the indent REFUSAL
// (a first item you are invited to press Tab on, so the thing that changed —
// that it now says why — is the thing you meet) and caret-crosses-blocks (a
// run of short lines and "hold ↓ from the top", which is the only length at
// which the new behaviour is noticeable).
//
// TOUCH IS STILL ONLY POINTED AT, and honestly so: a coarse pointer cannot be
// simulated by anything a page may contain (block `html` goes through
// sanitize.ts with a CLASS_OK allowlist, so a page cannot even carry its own
// media-query CSS). Welcome says what to do with a finger and stops there.
//
// WHAT THIS IS NOT is a manual. A feature tour that lists features is a
// reference nobody reads twice; this should be a space somebody would keep and
// write in, where the demonstration is the page rather than an aside on it.
//
// ENGLISH ONLY, deliberately, and unlike every string in the interface around
// it. The UI follows the READER (PLATFORM §8); a document is written in a
// language and this one is written in English. Translating the starter would
// mean nine starters to keep in step with nine feature sets, and a space
// somebody wrote in would be the only one of the ten that was not translated.

import { FORMAT, FORMAT_VERSION, defaultTheme, writeTable, type SpacesDoc, type Block, type Page } from './model.ts'
import { DEFAULT_FIELDS, ISSUE_FIELDS, propBlock } from './fields.ts'
import { STARTER_DIAGRAM, STARTER_TONE } from './starterdata.ts'

const nextId = (): string => `sd-${(seq++).toString(36)}`

const b = (type: string, html = '', extra: Partial<Block> = {}): Block =>
  ({ id: nextId(), type, html, ...extra })

let seq = 0

/** The one picture, in the asset table every picked image goes into. */
const DIAGRAM = 'sd-diagram'

/** When the demonstration comment thread was written. A FIXED date, not
 *  `new Date()`: `starterDoc()` has to emit the same document twice. */
const AT = '2026-08-20T09:14:00.000Z'

/**
 * DOES THE STARTER SHIP A SEEDED `doc.trail`? YES — ONE SERIES, QUARANTINED
 * AND LABELLED — AND ALSO A CHART WITH NO PERIOD AT ALL. Both, on purpose.
 *
 * This is the hardest call in the file, so the argument is written out rather
 * than left to be re-derived by whoever reads the numbers below and assumes
 * they are a convenience.
 *
 * THE CASE AGAINST SEEDING IS REAL AND IT IS NOT SQUEAMISHNESS. `trail.ts`
 * states the rule the field exists for — *store an observation the current
 * document cannot reproduce* — and `charts.ts` goes further at the one place a
 * reader can start recording: "No past trail key is ever fabricated: the days
 * before the record existed are gaps." A starter that fabricates a fortnight
 * would be the only document in the world doing the exact thing the feature
 * declines to do on the reader's behalf, and the first person to notice is by
 * definition the person deciding whether to trust the charts.
 *
 * WHY IT SHIPS ANYWAY. `chartData` returns `empty: !runs.length`, and a
 * starter period is a FIXED window (every date in this file is fixed, because
 * `starterDoc()` must emit the same bytes twice) — so it is always in the past,
 * the live today-point never falls inside it, and a chart of an unseeded period
 * draws NOTHING, forever, in every copy. That is not the version-history
 * compromise it would be mistaken for: version history has no versions in a
 * fresh space and points at a control in About that DOES something. An empty
 * burndown points at nothing and teaches nothing.
 *
 * And the part that decides it: everything these three charts are actually
 * clever about only exists over a real span. A gap drawn as a gap rather than
 * as zero, the "recording starts here" left edge, a thinned sample drawn
 * differently from a daily reading, the ideal guide, scope that grew mid-sprint,
 * four stacked CFD bands — charts.ts opens by explaining that it draws its own
 * SVG rather than calling charts-lite for precisely these properties. One live
 * point demonstrates not one of them.
 *
 * SO THE FICTION IS QUARANTINED RATHER THAN MIXED IN, and that is what makes
 * it defensible rather than merely convenient:
 *
 *  · IT IS ITS OWN SERIES. The keys are `sample/2026-08-17`, not `2026-08-17`.
 *    `recordTrail` only ever writes the DEFAULT series, so the reader's own
 *    record starts empty and can never be contaminated by, confused with, or
 *    averaged against these rows. The series mechanism already exists for
 *    exactly this ("the only mechanism by which two different scopes can ever
 *    be charted") — it is not being bent.
 *  · IT IS LABELLED WHERE IT IS MET, three times over: the period's own label
 *    reads "Sample sprint (invented numbers)", which is the string the chart
 *    header prints and the string the period picker offers; the page's first
 *    paragraph says it; and the page says which sprint it is NOT (these numbers
 *    are not the five demo cards, and could not be — a trail row holds counts
 *    and no page ids, by design).
 *  · IT IS INERT. The period is `closed`, so nothing protects it from pruning
 *    and nothing recomputes it; it never claims to be about this document.
 *
 * AND THE REAL MECHANISM IS DEMONSTRATED TOO, which is the half a seeded
 * series cannot do. The third chart on that page carries NO period. It renders
 * "This chart has no period yet" and the working "Choose a period…" button, and
 * the page tells the reader to press it: `startPeriod` takes a baseline from
 * their live board and backfills TODAY's row (periods.ts), so one press turns
 * that chart into a true observation of their own space, made by them, today.
 * The reader gets the shapes from the sample and the act from the real one.
 *
 * WHAT IT COSTS, measured rather than estimated — see the changelog entry for
 * the numbers this build produced. Ten rows plus one period is low single-digit
 * KB of document JSON before compression, and the shell ships deflated. It is
 * the largest thing in this file that is not the audio clip.
 *
 * ONE LOSS, SAID OUT LOUD. `clearTrail()` exists in trail.ts and has no UI
 * wired to it yet, so a reader who wants these rows gone must delete the page
 * (which does not remove them) or edit the JSON. That is a gap, it is filed,
 * and it is the strongest remaining argument for the other answer.
 */
const SAMPLE_SERIES = 'sample'
const SPRINT = { id: 'sd-sprint', from: '2026-08-17', to: '2026-08-28' }

/**
 * The invented fortnight, as a table rather than as ten literal rows.
 *
 * `[dayOffset, todo, doing, review, done, ptTodo, ptDoing, ptReview, ptDone]`.
 * 2026-08-17 is a Monday and 2026-08-28 the Friday twelve days later, so the
 * two MISSING offsets (5 and 6) are a Saturday and a Sunday — which is what
 * puts a real gap in the middle of the drawn line, and a gap is the one thing
 * charts.ts says must never be allowed to look like a zero.
 *
 * Nine issues and 24 points on the Monday; on the second Monday a tenth issue
 * arrives and scope becomes 27, which is the scope-creep story a burnup exists
 * to tell and a burndown cannot (there, it is only a line that stops falling).
 * It ends at 9 points remaining — a sprint that nearly finished, not one that
 * landed on zero, because a guide line the reality meets exactly is the one
 * picture a burndown never actually draws.
 *
 * The REVIEW band swells through the second week and is drained on the last
 * day. That is the CFD's whole reason to exist — a widening band is a queue
 * before anybody has called it one — and it has to be IN the numbers, because
 * prose beside a flat chart claiming a queue is the starter denying a feature
 * while appearing to demonstrate it.
 *
 * Zero-valued options are omitted from the row, per `TrailRow`.
 */
const SAMPLE_DAYS: ReadonlyArray<readonly number[]> = [
  [0, 8, 1, 0, 0, 21, 3, 0, 0],
  [1, 6, 2, 1, 0, 16, 5, 3, 0],
  [2, 5, 2, 1, 1, 13, 5, 3, 3],
  [3, 4, 2, 2, 1, 11, 5, 5, 3],
  [4, 3, 2, 2, 2, 8, 5, 5, 6],
  // 5, 6 — Saturday and Sunday. Nobody opened the file, so there is no row.
  [7, 3, 2, 3, 2, 9, 5, 7, 6],
  [8, 2, 2, 3, 3, 6, 5, 7, 9],
  [9, 1, 2, 4, 3, 4, 4, 10, 9],
  [10, 1, 1, 4, 4, 3, 3, 9, 12],
  [11, 0, 1, 3, 6, 0, 3, 6, 18],
]

/** `2026-08-17` + n, by UTC ordinal arithmetic on the LABEL — the discipline
 *  trail.ts sets and journal.ts's rig runs under six timezones. No local `Date`
 *  is constructed, so no DST boundary and no reader's timezone can move a key. */
function sampleDay(offset: number): string {
  const [y, m, d] = SPRINT.from.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d) + offset * 86400000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}

/** The sample series, as the `doc.trail` map the charts read. */
function sampleTrail(): Record<string, { n: Record<string, number>; e: Record<string, number> }> {
  const out: Record<string, { n: Record<string, number>; e: Record<string, number> }> = {}
  for (const [off, todo, doing, review, done, pTodo, pDoing, pReview, pDone] of SAMPLE_DAYS) {
    const n: Record<string, number> = {}
    const e: Record<string, number> = {}
    const put = (id: string, c: number, p: number) => {
      if (c > 0) n[id] = c
      if (p > 0) e[id] = p
    }
    put('todo', todo, pTodo)
    put('doing', doing, pDoing)
    put('review', review, pReview)
    put('done', done, pDone)
    out[`${SAMPLE_SERIES}/${sampleDay(off)}`] = { n, e }
  }
  return out
}

/**
 * A starter ISSUE — a page whose first blocks are its fields.
 *
 * Built through `propBlock` and `DEFAULT_FIELDS` rather than written out as
 * literal blocks, for one reason: `value` and the readable `html` beside it
 * have to agree, and hand-written starter blocks are exactly the copy that
 * silently stops agreeing the first time an option is renamed. The starter is
 * the one document every new space is judged by; it should be generated by the
 * same rule the app enforces at runtime.
 *
 * Seeded from `ISSUE_FIELDS`, so a starter issue carries the same fields as one
 * made with ⌘⇧I or `bento.newIssue()` — an issue here missing `assignee` would
 * be an issue with nowhere to put one.
 *
 * PLUS whatever else `values` names, in SCHEMA order. `ISSUE_FIELDS` is the
 * four a new issue starts with, not a ceiling — a page carries the fields it
 * uses, which is the whole premise the tracker rests on. The Planning page
 * needs `due`, `estimate` and `project` to have anything to ask about, and a
 * card the author gave a due date is an ordinary page with one more prop block
 * on it. `Object.hasOwn`, not `in` or truthiness: `values` is a plain record
 * and a key named `constructor` must not silently add a field.
 */
function issue(title: string, parent: string, values: Record<string, string>, body: string): Page {
  const props = DEFAULT_FIELDS
    .filter((f) => ISSUE_FIELDS.includes(f.key) || Object.hasOwn(values, f.key))
    .map((f) => propBlock(f, values[f.key] ?? f.def ?? '', nextId()))
  return { id: nextId(), title, parent, blocks: [...props, b('p', body)] }
}

/** Deterministic ids: a generator must emit the same document twice. */
export function starterDoc(): SpacesDoc {
  seq = 0
  const P = {
    home: 'sd-home',
    writing: 'sd-writing',
    media: 'sd-media',
    links: 'sd-links',
    tracker: 'sd-tracker',
    planning: 'sd-planning',
    progress: 'sd-progress',
    journal: 'sd-journal',
    inbox: 'sd-inbox',
    handover: 'sd-handover',
    limits: 'sd-limits',
    archive: 'sd-archive',
  }

  // The dates the starter's own cards carry. FIXED, like `AT`, and all in ONE
  // month on purpose: `calendar.defaultMonth` opens on today's month when
  // anything falls in it and otherwise on the month of the dated row NEAREST
  // today — so three dates in one month means the grid always opens showing
  // all three, in 2026 and in 2036. Scattering them across three months would
  // open on whichever was nearest and show one.
  //
  // They are also all in the PAST, which is what makes the "Overdue" view on
  // the Planning page hold rows permanently rather than on the day it was
  // written. `{ op: 'in', v: 'past' }` is resolved against the reader's today
  // (query.ts), so a date behind us stays behind us; `week` or `future` would
  // have been an empty view for every reader after the first.
  const DUE = { a: '2026-08-24', b: '2026-08-26', c: '2026-08-28' }

  // START dates, so the Gantt on the Planning page draws BARS and not a column
  // of hairlines. Deliberately not on every card: `fields.ts` names the fact
  // that "every issue in every file already written has a due date and no
  // start", so one card here has a due date and no start and is drawn as the
  // milestone diamond that case renders as — the installed-base shape, in the
  // one document everybody sees. A fourth card has neither date and is the
  // "undated: not drawn, counted" line the Gantt prints underneath itself.
  const START = { a: '2026-08-17', b: '2026-08-18', c: '2026-08-24' }

  // Through `writeTable`, not by hand, for the reason `propBlock` is used for
  // the issues: it is the ONE writer, and the fallback `html` it keeps in step
  // with the cells is what an older build renders AND what the backlink index
  // reads. A hand-written `rows` with no fallback would put a link on the page
  // that works when clicked and appears in nobody's "Linked from" — the starter
  // claiming a feature the starter then fails to prove.
  const table = b('table')
  writeTable(table, {
    rows: [
      ['Block', 'What it is for', 'On paper'],
      ['Callout', 'A note, a tip, a warning', 'kept, box and all'],
      ['Toggle', 'Detail folded away — see <a href="#p/sd-writing">Writing</a>', 'expanded'],
      ['Comment', 'A remark for a person, not the reader', 'never'],
    ],
    cols: [1, 2.2, 1.4],
    colAlign: ['', '', 'right'],
    header: true,
  })

  // Container blocks are built FIRST so their children can name a real id — a
  // parent pointing at an id that does not exist renders the child at top level.
  const callout = b('callout', 'A callout. Click the mark to make it a note, a tip, an important, a warning or a caution — or to give it an emoji of your own.', { tone: 'tip' })
  const toggle = b('toggle', 'A toggle, and this one starts folded', { open: false })

  // THE ONE TRANSCLUSION, and it points at a SECTION rather than a whole page
  // because that is the case the feature was built for: one canonical
  // statement of something, shown where it is needed. Saving is the thing a
  // new reader most needs to know and the thing most tempting to explain twice
  // — so Welcome shows the paragraph the limits page owns instead of keeping a
  // second copy that would drift.
  //
  // `anchor` is matched by heading NAME (embed.ts `headingKey`), never by
  // position, so it keeps finding `## Saving` wherever that section moves to.
  // `html` is the additivity fallback rather than a copy of the content: a
  // build that predates embeds renders an ordinary link to the page, which is
  // a readable sentence instead of a blank box. It is exactly what the
  // editor's own `applyEmbed` writes.
  const embed = b('embed', `<a href="#p/${P.limits}">Sharing &amp; limits</a>`, {
    page: P.limits, anchor: 'saving',
  })

  // The thread this space ships with. Two people, unresolved, so the page list
  // badges it and the marker is in the margin where the remark belongs.
  const commented = b('p', 'A comment is a remark for a person, not for the reader. Block options → <strong>Comment</strong>, or a page’s ⋯ → <strong>Comment on this page</strong>. There is a thread on this paragraph: the marker is out in the margin, so it never moves the writing, and the page list counts the ones nobody has settled.', {
    comments: [{
      id: nextId(),
      author: 'Ada',
      at: AT,
      text: 'Does a comment go out with the file when I send it?',
      replies: [{
        id: nextId(),
        author: 'Bo',
        at: AT,
        text: 'Yes — it is saved in the file. It stays out of the reading view and off the printout, but anyone you send the file to can read it. Resolve or delete it first if that matters.',
      }],
    }],
  })

  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    docId: '', // minted at boot; a template mints a fresh one every open
    title: 'My space',
    home: P.home,
    theme: defaultTheme(),
    assets: { [DIAGRAM]: STARTER_DIAGRAM },

    // THE SAMPLE SPRINT AND ITS RECORD. The whole argument for shipping these
    // at all — and for shipping them as their own SERIES rather than as the
    // default one — is at `SAMPLE_SERIES` above; do not reduce it to a shorter
    // comment here, because the short version reads as a convenience and it is
    // not one.
    //
    // `closed`, `series`, and a `base` taken on the first day: `base.e` is what
    // the burndown's ideal guide descends from and what the burnup draws as the
    // committed line, and scope growing past it on the second Monday is the
    // only story a burnup tells that a burndown cannot.
    //
    // The LABEL is load-bearing. It is what `renderChartBlock` prints in every
    // chart header and what the period picker offers a reader who later adds a
    // chart of their own, so it is the one place the fiction is guaranteed to
    // be met — it says so there rather than only in the prose beside it.
    periods: {
      [SPRINT.id]: {
        // "Sample sprint (invented numbers)" and not "Sample sprint — invented
        // numbers": `renderChartBlock` prints `${kind} — ${label}`, so an
        // em-dash in the label gives every chart header two of them.
        label: 'Sample sprint (invented numbers)',
        from: SPRINT.from,
        to: SPRINT.to,
        series: SAMPLE_SERIES,
        base: { at: SPRINT.from, n: 9, e: 24 },
        closed: true as const,
      },
    },
    trail: sampleTrail(),

    // THE NOTES, keyed by label, doc-level. Numbering is NOT here and is not
    // anywhere — it is order of appearance on a page, worked out at render
    // time — so these are identifiers rather than positions and can be read.
    //
    // Every one of them must be referenced from a block in `doc.pages`, and
    // every `[^x]` in those blocks must be defined here: validate() reports an
    // orphan note (info) and a dangling reference (warning), and the starter is
    // asserted to produce NO findings at any severity. A reference living only
    // inside a `PageTemplate` does not count — templates are not pages.
    footnotes: {
      label: 'The label is an identifier, never the number — this one is called <code>label</code> and it prints as a “1”.',
      room: 'A new one, and a random one — a room is never derived from the document, so a space you fork or re-share cannot collide with the room it came from, and the relay in the middle is told nothing about either.',
      hist: 'An encrypted space keeps its history encrypted with everything else. A readable list of what you used to be writing, sitting in clear beside the ciphertext, would be exactly the leak the password was set to prevent.',
    },

    // TWO TEMPLATES, and the daily one is wired up as the journal's, because a
    // template nobody has chosen demonstrates only that the collection exists.
    // Written as literals rather than through `makeTemplate`, which stamps
    // `created: new Date()` and a random id — `starterDoc()` has to emit the
    // same bytes twice.
    //
    // Their block ids are re-minted at instantiation, so these are only ever
    // placeholders. The blank paragraphs are the point: a template is a shape
    // to write into, and one that arrives with prose already in it is a page
    // you have to delete before you can start.
    templates: [
      {
        id: 'sd-tpl-daily',
        name: 'Daily note',
        icon: 'book',
        blocks: [
          b('h2', 'What happened'), b('p', ''),
          b('h2', 'What got decided'), b('p', ''),
          b('h2', 'Tomorrow'), b('todo', '', { done: false }),
        ],
      },
      {
        id: 'sd-tpl-meeting',
        name: 'Meeting',
        // A token, expanded when the page is made — so the title carries the
        // day it was made rather than the day the template was written.
        title: '{{date}} — meeting',
        icon: 'people',
        blocks: [
          b('h2', 'Who was there'), b('p', ''),
          b('h2', 'What got decided'), b('p', ''),
          b('h2', 'Who is doing what'), b('todo', '', { done: false }),
        ],
      },
    ],
    journalTemplate: 'sd-tpl-daily',

    pages: [
      {
        id: P.home,
        title: 'Welcome',
        icon: 'compass',
        blocks: [
          b('p', 'This whole space — every page, the editor, the search — is <strong>one HTML file</strong>. No account, no server, nothing installed.'),
          b('h2', 'Try it'),
          b('todo', 'Type something on this line', { done: false }),
          b('todo', 'Press <code>⏎</code> to make a new block, <code>Tab</code> to indent it', { done: false }),
          b('todo', 'Press <code>/</code> on an empty line for headings, lists, tables, quotes and code', { done: false }),
          b('todo', 'Select any words — a formatting bar appears above them', { done: false }),
          b('todo', 'Press <code>⌘K</code>, type <em>archived</em>, and open the page that is not in the sidebar', { done: false }),
          b('p', 'Then press <code>⌘S</code>. The file on your disk now contains everything you just wrote.'),
          b('p', 'What pressing it actually does depends on your browser, and rather than say so in two places, this page shows you the paragraph that says it:'),
          embed,
          b('p', 'That box is the <strong>Saving</strong> section of <a href="#p/sd-limits">Sharing &amp; limits</a>, live. Edit it there and it changes here, because there is only one of it. <code>/</code> → <strong>Embed a page</strong> puts one anywhere, holding a whole page or a single section of it.'),
          b('h2', 'If you are holding a phone'),
          b('p', 'The two chevrons at the edges of the screen are the page list and the properties panel; on a phone both start out of the way. Anything you would drag with a mouse — a block by its grip, a page onto another page to nest it, a card to the next column — moves if you <strong>press and hold it still for a moment first</strong> and then drag. Move straight away and the page scrolls, which is what you meant the other nine times.'),
          b('h2', 'What is here'),
          b('p', 'Ten more pages. Each one demonstrates the thing it describes, and every one of them is yours to rewrite or delete. Two of them are left deliberately unfinished, and say so — finishing them is how you meet the controls that do it.'),
          b('bullet', '<a href="#p/sd-writing">Writing</a> — the blocks you can make, and the marks you can put on them'),
          b('bullet', '<a href="#p/sd-media">Tables, pictures and clips</a> — the things that are not paragraphs'),
          b('bullet', '<a href="#p/sd-links">Pages and links</a> — how a space holds more than one page'),
          b('bullet', '<a href="#p/sd-tracker">Tracker</a> — the same pages, on a board'),
          b('bullet', '<a href="#p/sd-planning">Planning</a> — the same pages again, by date, on a schedule, and shared out between people'),
          b('bullet', '<a href="#p/sd-progress">How it is going</a> — three charts of what the file remembers'),
          b('bullet', '<a href="#p/sd-journal">Journal</a> — a page per day, when you want one'),
          b('bullet', '<a href="#p/sd-inbox">Inbox</a> — somewhere to put things you have not filed'),
          b('bullet', '<a href="#p/sd-handover">Handing it over</a> — reading it, sending it, presenting it, printing it'),
          b('bullet', '<a href="#p/sd-limits">Sharing &amp; limits</a> — what this file can and cannot do'),
          b('p', 'The sidebar holds the whole tree; drag a page onto another to nest it. <code>[</code> gets the sidebar out of the way, and <code>]</code> opens the properties panel on the other side — one place that answers what you can change about the block the caret is in.'),
        ],
      },
      {
        id: P.writing,
        title: 'Writing',
        icon: 'pen',
        blocks: [
          b('p', 'Markdown shortcuts convert as you type them. What is stored is the block, never the markdown — so a heading is a heading rather than a line that starts with a hash.'),
          b('h2', 'Headings and lists'),
          b('p', 'Type <code># </code>, <code>## </code> or <code>### </code> at the start of a line.'),
          b('bullet', '<code>- </code> makes a bullet'),
          b('bullet', 'and <code>Tab</code> nests it'),
          b('number', '<code>1. </code> makes a numbered list'),
          b('todo', '<code>[] </code> makes a checkbox', { done: false }),
          // ── THE PAGE THAT IS UNFINISHED ON PURPOSE ────────────────────────
          // The block bar is chrome: ⌘/ has no document surface, so by the
          // rule at the top of this file it would get a paragraph telling you
          // to press it. Instead the list below is WRONG — flat, with the
          // nesting obviously implied — and the reader fixes it. They end up
          // having used indent, the bar, or Tab, whichever they reached for.
          //
          // THE REFUSAL IS NOT DEMONSTRATED HERE, and the reason is worth
          // keeping because it was found by pressing the key rather than by
          // reading `indentTarget`. This section first said "now press Tab on
          // Bag itself and watch it refuse" — and Bag INDENTS. `indentTarget`
          // refuses `{why:'first'}` for the first block AT ITS LEVEL, and Bag
          // has the paragraph above it, so Tab nests the bullet under that
          // paragraph exactly as asked. The only block that refuses is the
          // FIRST BLOCK ON A PAGE, so the invitation lives on the Inbox, whose
          // first block is a to-do at the top of the page. Writing a starter
          // claim about a control without operating the control is how the
          // starter ends up denying a feature while appearing to prove one.
          //
          // AND IT IS LONG ENOUGH TO WALK. Arrow keys crossing a block
          // boundary is new and is unnoticeable on one block; six short lines
          // is the shortest run where holding ↓ demonstrates it.
          b('h2', 'A list in the wrong shape'),
          b('p', 'This list is flat and should not be. Put the caret on <strong>passport</strong> and press <code>Tab</code> — or open <code>⌘/</code> and use the indent arrow, which is the same thing with a button on it. Four of these six lines belong under the one above them.'),
          b('bullet', 'Bag'),
          b('bullet', 'passport'),
          b('bullet', 'charger'),
          b('bullet', 'Kitchen'),
          b('bullet', 'turn the boiler down'),
          b('bullet', 'bins out'),
          b('p', 'Nesting here is <em>parenthood</em> — a block belongs to the one above it — and not a number stored on the line. That is why <code>Tab</code> puts <strong>passport</strong> under <strong>Bag</strong> and never anywhere else, why moving <strong>Bag</strong> takes everything under it along, and why the very first block on a page has nothing to indent under and is told so out loud rather than having the key swallowed. There is a line at the top of the <a href="#p/sd-inbox">Inbox</a> you can try that on.'),
          b('p', 'While you are in there: <code>⌘/</code> is the whole block menu for the block the caret is in — text, three headings, bullet, number, to-do, quote, and indent both ways. It is the one route that does not need a mouse to find the grip out in the margin, and on a phone it is the same sheet the grip opens. And hold <code>↓</code> from <strong>Bag</strong>: the caret walks out of one block and into the next instead of stopping at the end of the line.'),
          b('h2', 'Marks'),
          b('p', 'Select any words and a small bar appears above them: <strong>bold</strong>, <em>italic</em>, <u>underline</u>, <s>strikethrough</s>, <code>inline code</code>, <mark>highlight</mark>, colour, a link, and one button that clears the lot.'),
          b('p', 'The shortcuts are ⌘B, ⌘I, ⌘U, ⇧⌘S, ⌘E and ⇧⌘H — and ⌘K makes a link out of whatever is selected. With nothing selected, ⌘K is still the search.'),
          b('p', 'Colour is nine names in two roles: <span class="sp-fg-red">the ink</span>, or <mark class="sp-bg-blue">the band behind the words</mark>. A fixed palette rather than a picker, so a colour can be chosen to stay readable on the page and on a printout — and it does print, because unlike a callout a coloured phrase has no second cue to fall back on.'),
          b('h2', 'Blocks that are not paragraphs'),
          b('quote', 'A quote — type <code>&gt; </code>.'),
          b('code',
            '// type ```js and a SPACE — the language is yours to pick\n' +
            'const space = { file: 1, pages: 14 }\n' +
            'console.log(`one file, ${space.pages} pages`)',
            { lang: 'js' }),
          b('p', 'Eight languages are highlighted and anything else is kept exactly as written, so <code>```rust</code> round-trips and lights up by itself the day the lexer learns it. Hover the block for its language chip, or press <code>]</code> and change it in the properties panel.'),
          callout,
          b('p', 'Press <code>⏎</code> in a callout and the next line goes inside it. Empty line, <code>⌫</code>, and you are out. The kind is named in words as well as coloured, so it survives a black-and-white printout.', { parent: callout.id }),
          toggle,
          b('p', 'Anything indented under a toggle folds away with it — and a toggle always <strong>prints expanded</strong>, because a handbook that silently omits what somebody folded is a data-loss-shaped bug.', { parent: toggle.id }),
          b('divider'),
          b('h2', 'An aside that would break the sentence'),
          b('p', 'Type <code>[^</code>, a short label, then <code>]</code>, and the aside goes to the foot of the page instead of into the middle of what you were saying[^label]. The note itself is written down there and belongs to the whole document, so moving this paragraph to another page takes the reference with it and nothing else.'),
          b('p', 'No number is stored anywhere. What you see is worked out from the order the references appear in, so writing a new one above this paragraph renumbers everything below it without touching a word. While you are editing, the reference stays as the text you typed — a superscript inside a line you are still writing is one keystroke from being typed over — so switch to the reading view (the eye in the toolbar) to see it as a number.'),
          b('divider'),
          b('h2', 'Lines that work things out'),
          b('p', 'End a line with <code>=</code> and it answers. The answer is never stored — change a number above and every line below follows.'),
          b('p', 'budget = 2400'),
          b('p', 'flights = 780'),
          b('p', 'budget - flights ='),
          b('p', '20% of budget ='),
          b('p', '940 km in miles ='),
          b('p', 'today + 3 weeks ='),
          b('p', 'It understands arithmetic, percentages, units, dates, times, names you define, and <code>sum above</code>. Type a sum without the <code>=</code> and it shows you the answer first — press <code>Tab</code> to keep it. A line it cannot fully work out gets nothing at all, so "Meet Ana at 3" stays a sentence.'),
        ],
      },
      {
        id: P.media,
        title: 'Tables, pictures and clips',
        icon: 'image',
        width: 'wide',
        blocks: [
          b('p', 'This page is set to <strong>Wide</strong> in the page menu, because a table wants room a paragraph does not. Column, Wide and Full are chosen per page and travel in the file; how much room the window itself gives a column is remembered for your screen and never written down.'),
          b('h2', 'Tables'),
          table,
          b('p', '<code>/</code> → Table, then type. <code>Tab</code> walks the cells and appends a row when it runs off the end; rows and columns come from the bar above the table, column widths drag, and the header row can be turned off. A cell holds ordinary rich text, so the link in the Toggle row is a real link — and it shows up in that page’s backlinks like any other.'),
          b('p', 'It leaves as a GitHub pipe table, alignment included, and a Markdown table you import arrives as one. What it is not is a spreadsheet: no formulas, nothing that recalculates. That is a different app.'),
          b('h2', 'Pictures'),
          b('image', '', {
            src: `asset:${DIAGRAM}`,
            alt: 'A space drawn as the one file it is: a window with the page list down the left, the page being written on the right, and a label saying the editor is inside.',
            caption: 'Drawn rather than photographed, which is why it costs 632 bytes.',
            w: 640, h: 300, width: 100,
          }),
          b('p', 'Drop a picture on the page, or <code>/</code> → Image. A photograph off a phone is downscaled to fit the column before it is embedded — measured, a 4.9 MB picture goes in at 33 KB — and the space says so, with the original one click away. Two copies of the same picture are stored once. Alt text and the width are in the properties panel.'),
          b('p', 'A picture that points at an address on the web is <em>not</em> loaded until you say so; the placeholder names the site first. Opening a file somebody mailed you should not tell them that you opened it.'),
          b('h2', 'Clips'),
          b('media', '', {
            kind: 'audio',
            src: STARTER_TONE,
            alt: 'A 1.2-second test tone',
            controls: true,
          }),
          b('p', 'A real audio block, embedded, ordinary. Video is the same block with a picture in it, and it takes a poster still into the printout and into the file-manager preview, where a player would be nothing at all.'),
          b('p', 'Nothing here plays by itself, and there is no setting that will make it. A space is an editor, a reading view, a printout and a thumbnail, and a clip that starts on its own is wrong in all four.'),
          b('p', 'Clips are also what makes a file too heavy to mail. This one is a test tone — 9 KB of sound, and by some way the largest thing in this space.'),
          b('h2', 'Cards for things on the web'),
          b('link', '<a href="https://bento.page">Bento — self-contained office documents</a>', {
            url: 'https://bento.page',
            title: 'Bento — self-contained office documents',
            desc: 'The project this space came out of: one HTML file that is the document, the viewer and the editor at once.',
            site: 'bento.page',
          }),
          b('p', '<code>/</code> → Link to the web. Nothing is fetched — not when you make the card and not when somebody opens the space. Other apps build this card on a server that reads the address’s tags; there is no server here and there is not going to be one, so the card shows what you type, and the dialog says so.'),
        ],
      },
      {
        id: P.links,
        title: 'Pages and links',
        icon: 'link',
        blocks: [
          b('p', 'A space is a <strong>tree of pages</strong>, not one long scroll. New page: the ＋ in the sidebar, or <code>⌘⌥N</code>. Drag a page onto another to nest it.'),
          b('h2', 'Linking'),
          b('p', 'Type <code>[[</code> anywhere to search your pages and drop a link in. If the page does not exist yet, the picker offers to make it.'),
          b('p', 'That link back to <a href="#p/sd-home">Welcome</a> was made exactly that way.'),
          b('p', 'A link can also be a card of its own — <code>/</code> → Link to page:'),
          b('pagelink', '', { page: P.tracker }),
          b('h2', 'Backlinks'),
          b('p', 'Scroll to the bottom of any page and it tells you what links <em>to</em> it. Nothing to maintain: it is derived from the links themselves, every time the page opens.'),
          b('p', 'This page links to <a href="#p/sd-writing">Writing</a>, so Writing lists this page underneath — and so does <a href="#p/sd-media">Tables, pictures and clips</a>, because the link in that page’s table is a link like any other.'),
          b('h2', 'Other names for the same page'),
          b('p', 'A page can answer to more than one name. <a href="#p/sd-tracker">Tracker</a> also answers to <strong>the board</strong>, which is what anybody actually calls it — type <code>[[</code> and either name reaches it, and so does <code>⌘K</code>. The list lives in the properties panel (<code>]</code>) under <strong>Also known as</strong>, comma separated. Nothing downstream learns that aliases exist: what gets written into your sentence is an ordinary link to a page id.'),
          b('p', 'The second thing a name buys you is at the foot of the page it belongs to. Open the tracker and look under the backlinks: it lists every place in this space where somebody wrote the board in plain prose and did not link it, with a <strong>Link</strong> button beside each one. Nothing is rewritten for you — it is a suggestion, taken one at a time, and the paragraph you are reading now is one of them.'),
          b('h2', 'Finding things'),
          b('p', '<code>⌘K</code> searches every page at once — titles and the words inside blocks, including the ones folded away in a toggle and the pages you have archived. <code>⌘F</code> finds and replaces across the whole space, not only the page you are looking at.'),
          b('h2', 'Why one file'),
          b('p', 'Links are page ids inside this document, so they resolve with the wifi off, from a mail attachment, on a phone, and in ten years. A link between separate files could not do any of that.'),
        ],
      },
      {
        id: P.tracker,
        title: 'Tracker',
        icon: 'board',
        // The alias that makes the unlinked-mentions section on this page hold
        // something. Three characters at least, or the scanner will not look
        // for it, and it must collide with no other page's title or alias —
        // validate() reports `alias-collision` and the starter is asserted to
        // produce no findings at all.
        aliases: ['the board'],
        blocks: [
          b('p', 'An <strong>issue is a page</strong>. The cards below are the pages nested under this one — open one and you are in a document you can write anything in, with its fields along the top.'),
          b('p', 'Nothing here is a second kind of thing: issues search, link, print, export and back-link like every other page. A page becomes an issue when it has a status, and stops being one when it does not.'),
          b('view', 'Issues', { layout: 'board', groupBy: 'status' }),
          b('h2', 'Making them'),
          b('p', '<code>⌘⇧I</code> makes an issue. The tag button in the toolbar turns the page you are already on into one — useful when a note turns out to be work.'),
          b('p', 'Drag a card to another column to change its status; change the field at the top of a card’s page and watch the card move instead. On a phone, press and hold the card still for a moment before you drag — otherwise the board scrolls, which is the other thing a finger on a board usually means.'),
          // SEVEN, not five. `VIEW_LAYOUTS` grew by two and this sentence was
          // the starter denying both of them — the maintenance cost the rule
          // at the top of this file names, arriving exactly as predicted.
          b('p', 'The button above the board that says <strong>Board</strong> is a cycle, not a switch: it steps through the seven shapes the same pages can take — board, list, table, gallery, calendar, timeline and workload — and always names the one you are looking at. <strong>Group</strong> picks the field the columns come from, <strong>Sort</strong> orders by any field (clicking the one you are already sorted by reverses it), <strong>Pages</strong> chooses which pages the view holds at all, <strong>Open only</strong> hides what is finished, and <strong>Filter</strong> asks a real question — <a href="#p/sd-planning">Planning</a> is three views that do. <strong>Manual order</strong> is always first in the Sort menu, because a board somebody arranged by dragging should be one click from getting that order back.'),
          b('h2', 'The same five, as a table'),
          b('view', 'Every issue', { layout: 'table' }),
          b('p', 'The columns are whichever fields these pages actually carry. Click a heading to sort by it, again to reverse it, a third time to put the manual order back — and click any cell to change the value right here, without opening the page. A cell that is empty still takes a click: that is how the field gets onto a page that never had it.'),
          b('p', 'This page is not set to Wide and is still wide: a board takes the room it needs unless the page menu says otherwise.'),
        ],
      },
      // ASSIGNEES, which the cards did not carry before. Two names and one
      // blank, because a workload chart of five cards all held by nobody is one
      // "Unassigned" bar, which is not a picture of anything. Ada and Bo are
      // the two people already in this space — they are the comment thread on
      // the Sharing & limits page — rather than two more invented names.
      ...[
        issue('Open this card — it is an ordinary page', P.tracker,
          { status: 'doing', priority: 'high', assignee: 'Ada', estimate: '3', start: START.b, due: DUE.a, project: 'Starter tour' },
          'You are in it. The row above is fields; everything from here down is a page — write notes, paste a picture, nest a toggle. That is the whole trick: the tracker did not invent a new thing to hold work in, it put fields on the thing you already had.'),
        issue('Drag me to another column', P.tracker,
          { status: 'todo', priority: 'medium', assignee: 'Bo', estimate: '1', start: START.c, due: DUE.b, project: 'Starter tour' },
          'Dragging a card writes the new status onto this page. Go the other way too: change the field at the top and watch the card move on the board.'),
        // NO START, on purpose: the milestone case. See `START` above.
        issue('Press ⌘⇧I to make your own', P.tracker,
          { status: 'todo', priority: 'urgent', assignee: 'Ada', estimate: '5', due: DUE.c, project: 'Starter tour' },
          'A new issue arrives with status, priority, assignee and estimate already on it, and the caret in the body waiting for you. It has no <strong>Start</strong> until you give it one — which is why this card is a diamond rather than a bar on the <a href="#p/sd-planning">Planning</a> page: a date with no duration is what the file actually says.'),
        // NEITHER DATE, on purpose: the Gantt's "undated" line.
        issue('Delete all of this once you have seen it', P.tracker,
          { status: 'backlog', project: 'Starter tour' },
          'These five are a demonstration, not a template. Delete them and the board is empty and yours — it shows whatever pages in this space have a status, wherever they live in the tree.'),
        issue('This one is finished', P.tracker,
          { status: 'done', assignee: 'Bo', estimate: '2', start: START.a, due: DUE.a, project: 'Starter tour' },
          'Done and cancelled are <em>phases</em>, not just names, which is what lets <strong>Open only</strong> mean something without anyone configuring a filter.'),
      ],
      {
        id: P.planning,
        title: 'Planning',
        icon: 'todo',
        blocks: [
          b('p', 'The same pages as the board next door, asked three different questions. None of these is a new kind of thing and none of them stores a copy of anything: a view is a question, answered from the pages themselves every time it is drawn.'),
          b('h2', 'What has a date'),
          b('view', 'By date', { layout: 'calendar' }),
          b('p', 'A page sits on the day it has, and which day that is follows a fixed rule rather than a setting: a journal entry sits on its own date, and anything else on the first date field it has filled in — here that is <strong>Due</strong>. A page with no date at all is not dropped from the view, because a view that quietly holds fewer pages than it says it does is worse than an untidy one; it is listed underneath, saying so.'),
          b('p', 'The arrows walk months, and the grid opens on the month that has something in it rather than on an empty one. The button beside them turns the month into a <strong>timeline</strong> — the same pages in order, which is the shape you want when the dates are years apart instead of days.'),
          b('h2', 'Overdue, and not finished'),
          b('view', 'Overdue', {
            layout: 'table',
            filter: { where: [{ key: 'due', op: 'in', v: 'past' }, { key: 'status', op: 'ne', v: 'done' }] },
            sort: [{ key: 'due', dir: 'asc' }],
          }),
          b('p', 'Two conditions, and both are the kind that could not be asked before. <strong>Due is in the past</strong> is a relative window: the word <em>past</em> is what is stored, and it is worked out against your today every time the view is drawn — a stored date would have answered the question once, on the day it was written, and been wrong every day after. <strong>Status is not Done</strong> is the negation; the finished card is in the calendar above and is not here.'),
          b('p', 'Open <strong>Filter</strong> above the view to see them written out, and to add your own: is, is not, before, after, contains, does not contain, empty, not empty, and the five windows — today, this week, this month, past, future. They are ANDed unless you say otherwise.'),
          b('h2', 'One project, big enough to plan'),
          b('view', 'Sized', {
            layout: 'list',
            filter: { where: [{ key: 'project', op: 'contains', v: 'starter' }, { key: 'estimate', op: 'gte', v: 2 }] },
          }),
          b('p', '<strong>Project contains “starter”</strong> matches the words you would see on the screen, not an id hidden behind them, and it does not care about capitals. <strong>Estimate is 2 or more</strong> is the other half of a range — pair it with <em>is at most</em> and you have one. The card with no estimate is not swept in on a technicality: an unset value is the absence of a value, not a small one.'),
          // ── THE GANTT ──────────────────────────────────────────────────────
          // A view layout, not a chart block, and it lives on THIS page rather
          // than on "How it is going" because that split is the whole point:
          // everything here is derived from the pages, live, every time it is
          // drawn; everything there is read from a record. Putting a schedule
          // beside a burndown would blur the one distinction gantt.ts and
          // charts.ts both open by making.
          //
          // `groupBy: 'status'` so the bars take their colour from the board's
          // own columns — the same five colours, so a reader recognises them
          // without a key. Every date here is fixed and in the past, so the
          // "today" marker sits outside the span for every reader after the
          // first, which is a state the renderer handles (`todayX: null`) and
          // is honest: this is last fortnight's schedule.
          b('h2', 'When it all runs'),
          b('view', 'Schedule', { layout: 'gantt', groupBy: 'status' }),
          b('p', 'The same five cards again, drawn between their <strong>Start</strong> and their <strong>Due</strong> — one bar each, coloured by the column they are in on the board. This is the <strong>Timeline</strong> stop on the shape button above any view; nothing is stored to make it, and a bar moves the moment somebody changes a date on the page it came from.'),
          b('p', 'Two of the cards are not bars, and both are telling you something true. <strong>Press ⌘⇧I to make your own</strong> has a due date and no start, so it is a <em>diamond</em> — a date with no duration is what the file actually says, and drawing it as a zero-width bar would be a hairline pretending to be a schedule. That is not an edge case: every issue written before <strong>Start</strong> existed is in exactly that shape. <strong>Delete all of this once you have seen it</strong> has neither date, so it is not drawn at all — and is counted underneath instead, because a chart that quietly holds fewer rows than it says it does is worse than an untidy one.'),
          b('p', 'Give the diamond a start date and watch it become a bar. There are no dependency arrows and no critical path: pointing one task at another needs a way to name a page in a field, and this space has exactly one way to point at a page — a link in a sentence — so rather than invent a second one that would be permanent, there is none.'),
          // ── THE WORKLOAD ───────────────────────────────────────────────────
          // No `groupBy`: `bucketField` finds the person field by itself, which
          // is the behaviour worth demonstrating — the block stores nothing and
          // the chart still buckets by the right thing. The cards carry Ada,
          // Bo and one blank on purpose (see the issues above).
          b('h2', 'Who is holding what'),
          b('view', 'Workload', { layout: 'workload' }),
          b('p', 'The last shape on the button: the same pages again, with their estimates added up per person. Ada is holding eight points across two cards and Bo three across two, which is the only question this picture is for. Nothing says <strong>Assignee</strong> anywhere on this block — a workload chart bucketed by status would not be a workload chart, so an absent <strong>Group</strong> means the person field, and it finds that field from the schema rather than from its name.'),
          b('p', 'The bar with nobody on it is the card in the backlog, and it is flat rather than missing: it holds one page and no estimate, and the view says so under the chart. An unset estimate is the absence of a number and never a zero that quietly makes somebody\'s column look lighter — and a value that is not a number at all is excluded and counted out loud, for the same reason.'),
          b('p', 'Somewhere to put the ones that are not work yet: a view that only shows what I could finish before lunch #idea.'),
        ],
      },
      {
        id: P.progress,
        title: 'How it is going',
        icon: 'graph',
        blocks: [
          b('p', 'The <a href="#p/sd-planning">Planning</a> page asks the pages questions and they answer from what they say today. This page cannot do that, and the difference is the whole subject: <strong>no amount of looking at a board tells you what it looked like last Tuesday</strong>. So the file writes a line down each day it is edited — how many issues were in each column, how many points — and these three charts read it back.'),
          b('p', 'Which means one honest warning before you read them, and it is the reason this paragraph is second and not last:'),
          b('callout', 'The first two charts below are drawn from <strong>invented numbers</strong>. They are a made-up fortnight called “Sample sprint”, kept in a record of its own so it can never mix with what this file records about you, and they are here because an empty chart teaches nobody what a burndown is. The third chart is real, empty, and yours to start.', { tone: 'important' }),
          b('h2', 'Burndown — how much is left'),
          b('chart', 'Burndown — Sample sprint (17–28 August 2026)', { kind: 'burndown', period: SPRINT.id }),
          b('p', 'Work remaining, day by day, with a straight guide from what was committed on the first morning down to nothing on the last. Real work does not follow the guide, which is the only reason to draw it.'),
          b('p', 'Look at the middle of the line: there is a <strong>gap</strong>, not a dip. That Saturday and Sunday nobody opened the file, so nothing was observed, and an unobserved day is drawn as a hole rather than as a zero — a chart that joined it up would be showing you a number nobody ever wrote down. It is the same refusal as a calculating line that will not guess: absent is a real answer and it is not the same answer as none.'),
          b('p', 'The line also goes back <em>up</em> on the Monday after that gap, which no amount of working harder can cause. Something arrived. A burndown can only show you that as a week where nothing seemed to happen, which is why there is a second chart.'),
          b('h2', 'Burnup — and the work that arrived late'),
          b('chart', 'Burnup — Sample sprint (17–28 August 2026)', { kind: 'burnup', period: SPRINT.id }),
          b('p', 'The same fortnight with the question turned over: how much is <em>done</em>, against how much there is to do. The upper line is the scope, and it <strong>steps up on the second Monday</strong> — three more points arrived after the sprint had started. A burndown cannot show you that; the line just stops falling and it looks like a bad week.'),
          b('p', 'What is <em>not</em> recorded, deliberately: which issues those were. A day\'s line holds counts and totals and no page ids at all, so nobody can ever ask this file who closed what and when. That is a privacy decision rather than a byte-saving one, and the cost is real — there is no per-issue account of what arrived mid-sprint, and there is not going to be one.'),
          b('h2', 'Cumulative flow — where the work is sitting'),
          b('chart', 'Cumulative flow — Sample sprint (17–28 August 2026)', { kind: 'cfd', period: SPRINT.id }),
          b('p', 'Every column of the board, stacked. The band that keeps widening is the one where work is piling up — here it is <strong>In review</strong>, swelling right through the second week and only drained on the last day, which is what a queue looks like before anybody has called it one. The bands are the board\'s own columns in the board\'s own colours, so rename a column or recolour it and last month\'s chart follows. Delete one, and old days keep their band and it says it no longer knows the name, rather than quietly losing the work that was in it.'),
          b('h2', 'And now a real one'),
          b('p', 'This chart is about <strong>your</strong> space and it is empty, because nothing has been recorded yet — there is no history of a file before somebody started keeping one, and this app will not make one up.'),
          b('chart', 'Burnup — no period yet', { kind: 'burnup' }),
          b('p', 'Press <strong>Choose a period…</strong> and then <strong>New two-week period from today</strong>. It takes a baseline from the board next door as it stands right now, writes today\'s line, and points this chart at it — and from then on every day you edit this file adds another. Come back in a week and there is a line; that line will be true, which is the only thing that separates it from the two above.'),
          b('h2', 'What this costs you'),
          b('p', 'A day is about 170 bytes, so a year of them is around 60 KB — and it is capped against the size of the space itself rather than by a flat number, because 60 KB of record beside a 40 KB document is absurd and beside a 2 MB one is nothing. Past the cap the oldest days are thinned to one a week, then one a month, then dropped, and a thinned point is drawn differently from a daily one so you can see which is which. Thinning always keeps a day somebody actually observed; it never averages two into a third that nobody did.'),
          b('p', 'And it does not travel. A <strong>reading copy</strong> carries none of this — see <a href="#p/sd-handover">Handing it over</a>, where you can check that claim in about thirty seconds. What a record like this quietly discloses is not the numbers, it is the <em>cadence</em>: which days the file was touched, which weeks nothing moved, who works on a Sunday. That is worth a sentence before you send one.'),
        ],
      },
      {
        id: P.journal,
        title: 'Journal',
        icon: 'book',
        journalHome: true,
        // The second alias, and the one that shows the rule is about NAMES
        // rather than about the tracker: nothing in this space is titled
        // "daily notes" and several pages call it that.
        aliases: ['daily notes'],
        blocks: [
          b('p', 'Press <code>⌘⇧J</code> and today’s entry appears under this page.'),
          b('p', 'It does not arrive empty. It starts from the <strong>Daily note</strong> template this space ships with — the three questions an entry is usually answering — and the date it writes at the top is the entry’s own, not the day the template was made. Rewrite one entry into the shape you actually want, choose <strong>Save as template</strong> from its ⋯ menu, and say <strong>Use for daily notes</strong>; every entry after that starts from yours. ⋯ → <strong>Templates…</strong> is where they all live, and there is a second one there — <strong>Meeting</strong> — which is what the ＋ above the page list now offers you instead of going straight to a blank page.'),
          b('p', 'There is no entry for today yet, and there will not be one until you write in it. Other apps make a page for every day you happen to open them; on a filesystem that is a cheap empty file, and in a document somebody mails around it is permanent weight for nothing.'),
          b('p', 'Arrows either side of the date walk to yesterday and tomorrow. Entries nest here, newest first, however out of order you wrote them.'),
          b('p', 'The date is stored as <code>2026-08-06</code> and shown in your own language: a reader in Tokyo sees 2026年8月6日木曜日 out of the same file. The <em>date</em> is what makes an entry that day’s, not the title — so rename one to “Monday — sprint kickoff” and it stays exactly where it belongs.'),
          b('p', 'An entry is an ordinary page. It searches, links, back-links, prints and exports like everything else here.'),
        ],
      },
      {
        id: P.inbox,
        title: 'Inbox',
        icon: 'inbox',
        blocks: [
          b('todo', 'Type here; file it later', { done: false }),
          b('todo', 'Ask whether the second screen ever arrived', { done: false }),
          // TWO PARAGRAPHS AMONG THE TO-DOS, on purpose — the second half of
          // the block-bar demonstration that Writing starts. The inconsistency
          // is visible at a glance (no checkbox), the intent is obviously the
          // same as the lines around them, and ⌘/ → To-do is the one gesture
          // that fixes it. Nothing on this page explains the bar; the page is
          // simply wrong in a way the bar is the natural way to put right.
          b('p', 'Chase the invoice — this line and the one under it are not to-dos yet'),
          b('p', 'Book the room for the retro'),
          b('todo', 'A page that lists what I owe people #idea', { done: false }),
          b('todo', 'The piece Ada sent, before it goes stale #read', { done: false }),
          b('p', 'Two of the lines above have no checkbox. Put the caret in one and press <code>⌘/</code> — the row that opens turns a block into whatever it should have been: a to-do, a bullet, a heading, a quote. It is the same row the grip in the margin opens, and the same sheet a phone gets from the bottom of the screen, so there is one place for "what kind of thing is this line" rather than three.'),
          // THE REFUSAL, demonstrated rather than described — and it has to be
          // THIS page, because the only block `indentTarget` refuses is the
          // first one on a page and this page's first block is a to-do at the
          // very top. (Writing's list cannot do it: its first item has a
          // paragraph above it, so Tab nests under the paragraph. Found by
          // pressing the key.)
          b('p', 'One more, on the <em>first</em> line of this page — <strong>Type here; file it later</strong>. Put the caret in it and press <code>Tab</code>. Nothing indents, and the app says why along the bottom of the window instead of quietly eating the key: a block nests under the one above it, and that one has nothing above it. The indent arrow in <code>⌘/</code> is greyed for the same reason and carries the same sentence, so the answer is there before you press anything as well as after.'),
          b('p', 'Somewhere to throw things before they are worth a page of their own. Nothing is special about this one — it is an inbox because you decided it is.'),
          b('p', 'When a line turns out to be work, the tag button makes it an issue. When it belongs to a particular day rather than to a subject, it goes in your daily notes. When it turns out to be a subject, <code>[[</code> gives it a page. When it turns out to be neither and you are not stopping to decide, put a <code>#</code> in front of a word and carry on writing — that is a tag, and it is the only classification most notes ever get. It is not filed anywhere: it lives in the sentence you wrote it in, and everything else is derived from that. <code>⌘K</code> finds it, the graph draws it, and tags nest with a slash, so #project catches #project/bento too.'),
          b('p', 'And a view can hold every page carrying one, wherever in the tree it ended up:'),
          b('view', 'Marked #idea', { layout: 'list', source: { tag: 'idea' } }),
          b('p', 'That is <strong>Pages</strong>, above the view, set to a tag instead of to the backlog — which is also how a view holds “everything under this page” or “everything with an Author”. When a subject outgrows a tag, give it a page; the tag stays where it was, in the prose, and costs nothing.'),
        ],
      },
      {
        id: P.handover,
        title: 'Handing it over',
        icon: 'people',
        blocks: [
          b('p', 'Four ways a space stops being only yours. This page is deliberately built out of four headings and nothing else above them, because the third one turns each heading into a slide — so the page is the demonstration, and you can watch it happen to the words you are reading.'),
          b('h2', 'Reading it'),
          b('p', 'The eye in the toolbar is the <strong>reading view</strong>: the same pages with the editing tools taken away, footnotes as numbers rather than as the text you typed, no comment markers, and a link to the previous and next page at the foot. <code>Esc</code> comes back. It is a view and not a state of the document — nothing is saved, nobody else is affected, and it is the honest way to find out what somebody else will see.'),
          b('h2', 'Sending it to somebody who will only read it'),
          b('p', '<strong>Save a reading copy…</strong>, in the popover beside ⋯, writes a different file: the pages with no editing tools, no comment threads, and none of this space’s keys, so it can never join the live session this one may be in. It opens saying what it is. That is the only one of these four that changes a document at all — the copy carries a flag the original does not, which is why it is a copy and not a setting.'),
          // A CLAIM THE READER CAN DISPROVE IN THIRTY SECONDS beats three they
          // have to take on trust. Both of these name a specific artefact in
          // THIS file, by page, so "strips workspace content" stops being an
          // assertion and becomes an experiment — and if either ever stops
          // being true, the starter says something checkably false rather than
          // something vaguely reassuring.
          b('p', 'Do not take that on trust — it is checkable, and it takes half a minute. Save a reading copy of this space and open it. Go to <a href="#p/sd-limits">Sharing &amp; limits</a>: the comment thread Ada and Bo are having under <strong>Comments</strong> is not there, marker and all. Then go to <a href="#p/sd-progress">How it is going</a>: the three charts are blank, because the daily record they read is not in that file either. A record of which days a file was worked on is not something to hand out with a document somebody only needed to read.'),
          b('h2', 'Putting it on a screen'),
          b('p', '<strong>Export page as slides…</strong> — beside <strong>Save</strong>, with the other ways of writing this document somewhere else — turns one page into a <em>bento/slides</em> deck. Every <code>#</code> and <code>##</code> heading starts a slide and becomes its title, so a page written in sections is already a talk: this one comes out as six.'),
          b('p', 'The dialog counts them before you commit, and lists what did not survive the trip. It will tell you, for instance, that this page’s icon stayed behind, because it is one of this app’s own glyphs rather than an emoji. A page is prose and a deck is slides, and some of a page has no slide shape at all — so the losses are named here rather than discovered by you in front of a room. What you get is the deck’s JSON; Bento Slides takes it with <strong>Replace from JSON…</strong> in its About dialog.'),
          b('h2', 'Putting it on paper'),
          b('p', '<code>⌘P</code> prints, or saves a PDF. Toggles print open, because a handbook that silently leaves out whatever somebody folded away is a bug wearing a feature’s coat. Footnotes land at the foot of the page they belong to. Comment threads never print at all.'),
        ],
      },
      {
        id: P.limits,
        title: 'Sharing & limits',
        icon: 'scale',
        blocks: [
          b('p', 'Worth knowing before you rely on this.'),
          b('h2', 'The file is the sharing'),
          b('p', 'Sending someone this file sends them <strong>the whole space</strong> — every page, including the archived one. There is no per-page permission, because there is no server to enforce one. The file <em>is</em> the capability: whoever has it can read it and can edit it.'),
          b('h2', 'Working live'),
          b('p', 'Two tabs of the same space, or two people with the same file, edit it together: changes merge per character, and the file you save carries the state, so a copy edited on a plane rejoins as a fork rather than overwriting anybody. A coloured initial sits on the page each person is reading; click somebody in the people panel to go to where they are.'),
          b('p', 'A space goes live only when it arrived carrying a session — a file that was saved or shared — or when you start one from the button beside ⋯. A fresh space and a template stay offline. That button says which of the three situations you are in, including the usual one, which is that nothing is shared at all.'),
          b('p', 'The awkward part: a session is a room whose keys live in the file. Whoever holds a copy holds the room, and there are no accounts to take it back from them. <strong>Reset access…</strong> is what revocation looks like here — it mints a new room[^room] and leaves the old copies talking to nobody.'),
          b('h2', 'Comments'),
          commented,
          b('h2', 'Sending one page out'),
          b('p', '<strong>Export page as a space…</strong> writes the page you choose — and, if you want, the pages under it — as its own file: a whole space, not an attachment. It gets a new document id and none of this file’s keys, so it is a new document rather than a fork that would try to join this one’s session. Only the pictures those pages use travel with it, and a link pointing at a page that stayed behind becomes text naming that page rather than a link to nowhere.'),
          b('h2', 'Bringing pages in'),
          b('p', 'The same trip backwards: choose a space, or drop one on the window, and its pages arrive under any page you pick. Ids this space already uses are renamed and the links inside the import follow them, so nothing arrives pre-broken. A folder of Markdown files comes in the same way, folder tree and <code>[[wikilinks]]</code> intact. Either one is a single <code>⌘Z</code>.'),
          b('h2', 'Saving'),
          // NO FOOTNOTE IN THIS SECTION, deliberately, and it is not a matter
          // of taste. Welcome embeds this section, and a reference inside an
          // embedded body renders its number on the HOST page while the note
          // itself stays on this one — the marker is drawn, and the anchor it
          // points at is not there to jump to. Measured on the built shell:
          // `#spfn-sd-limits-fsa` on the Welcome page resolved to nothing.
          // Until embeds and footnotes agree about that, the starter keeps its
          // notes out of any section it also transcludes.
          b('p', 'On Chrome and Edge, <code>⌘S</code> writes back to the file you opened. Everywhere else — Safari, Firefox, and every browser on iOS — the browser gives a page no way to write to its own file, so each save downloads a <strong>new copy</strong>. That is a browser limitation, not a setting: every browser on iOS is the same engine underneath whatever name is on it.'),
          b('h2', 'What you saved before'),
          b('p', 'Every save keeps a version <em>inside the file</em>. ⋯ → <strong>About this space</strong> → <strong>Versions in this file</strong> is the list, with <strong>Changes</strong> beside each row to see what moved and <strong>Restore</strong> to go back — and <code>⌘Z</code> undoes a restore, so it is not a decision you have to be sure about. Because they live in the document rather than in this browser, they are still there on another machine, and still there for whoever you send the file to, and sealed inside the password when there is one[^hist].'),
          b('p', 'Which is the awkward part, and the reason it is on this page rather than a happier one: a version holds text you have since deleted. Anyone you send the file to can read it back out. <strong>Clear history</strong> sits in the same dialog, next to the number telling you how much of the file the versions are currently taking; the list stops at sixty, oldest first, so it cannot grow without limit.'),
          b('h2', 'What it remembers about how you work'),
          b('p', 'If this space is tracking work, it writes one line a day into the file: how many issues sat in each column, how many points. That is what <a href="#p/sd-progress">How it is going</a> draws, and it exists because no amount of looking at today\'s board tells you what last Tuesday\'s looked like. It holds counts and totals and never a page id, so this file can never be asked who closed what and when.'),
          b('p', 'The awkward part is not the numbers, it is the <strong>cadence</strong>. A row exists for each day the file was edited and no row exists for the days it was not — so the record quietly says which weeks nothing moved and who was working at the weekend. That is why a reading copy carries none of it, and why it is named here rather than left to be discovered. It is also why this space ships a made-up fortnight rather than a real one: the sample on that page is labelled as invented, kept in a record of its own, and is not an observation of anybody.'),
          b('h2', 'Archived is not deleted'),
          b('p', 'This space ships one archived page, called <strong>The archived page</strong>. Archiving takes a page out of the sidebar and leaves it in the file: still found by <code>⌘K</code>, still linkable, still there when you send the file to somebody. Archiving is the delete this app offers, because the file is the only copy there is.'),
          b('h2', 'Two copies and no session'),
          b('p', 'If two people edit their own copy with no session between them, there is no merge. They are two files. Putting them back together means importing one into the other and reading the result — which works, and is not the same as it having merged.'),
          b('h2', 'Size'),
          b('p', 'Text is essentially free: hundreds of pages of prose stay a small file. Pictures and clips are what make it big, because they travel inside it rather than beside it.'),
        ],
      },
      {
        id: P.archive,
        title: 'The archived page',
        icon: 'note',
        archived: true,
        blocks: [
          b('p', 'You found this with <code>⌘K</code>. Nothing in this space links here, and it is not in the page list.'),
          b('p', 'It is archived: out of the sidebar, still in the file, still searchable, still linkable. The page list keeps an <strong>Archived</strong> group at the bottom to restore from, and a page’s ⋯ menu is what puts one here.'),
          b('p', 'Which is why <a href="#p/sd-limits">Sharing &amp; limits</a> names this page by name. Archived is not deleted, and it is not private — send the file and this goes with it.'),
        ],
      },
    ],
  }
}
