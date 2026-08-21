#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash comments rig.
//
//   node scripts/test-dash-comments.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. A comment is the one thing in a workbook that a computer
// cannot check: it is a sentence, and whether it is right is a question for a
// person. So the only thing worth testing is whether it still points at what
// its author was pointing at — and every way of getting that wrong produces a
// grid that looks perfectly fine:
//
//   1. AN ANCHOR THAT MOVES WITH THE VIEW. Sorting and filtering are view
//      state, so a comment stored against a row POSITION reads as attached to
//      a different number the moment somebody clicks a column header, with the
//      re-sorted grid hiding the evidence. This is the same class as the
//      canonical-vs-visible row bug that deleted the wrong row.
//   2. AN ANCHOR THAT MOVES WITH THE STRUCTURE. Insert a row above and every
//      A1 reference below it means something else. "£22,750 looks wrong" then
//      hangs off £12,400, and is still signed by the person who never said it.
//   3. A DELETE THAT TAKES THE ARGUMENT WITH IT. `deleteRowsAt` takes a row's
//      overrides with it, which is right for a correction; doing the same to a
//      comment destroys somebody's unanswered objection as a side effect of a
//      structural edit — and undo would have to restore it exactly, from a
//      patch nobody minted.
//   4. A ROUND TRIP THAT IS NOT ONE. Resolve then reopen, or add then delete,
//      has to leave the file BYTE-identical. A `resolved: false` left behind,
//      or a `"comments": []`, is a document that no longer matches its own
//      collaborators over an operation that ended where it started.
//   5. A COMMENT THAT IS DATA. If a comment can reach `sheet.cells`, it can
//      reach the formula engine, the totals row, a chart binding and the
//      static preview — and a remark becomes a number.
//
// Every section below therefore asserts the WRONG answer is refused, and the
// NEGATIVE CONTROLS at the foot re-run the same checks against deliberately
// broken implementations to prove each one can actually fail.

import { registerHooks } from 'node:module'

// comments.ts imports its stylesheet, which is Vite's job and not Node's —
// panels.ts and its rig settled this pattern; co-locating a component with its
// styles is not something a rig gets to break.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const {
  sheetComments, unresolvedCount, resolveAnchor, rowOfRid, ridOfRow,
  anchorRef, anchorValue, anchorLabel, flatComments,
  newComment, addCommentPatch, replyPatch, setResolvedPatch, deleteCommentPatch,
} = await import('../dash/src/comments.ts')
type Comment = import('../dash/src/comments.ts').Comment
type CommentAnchor = import('../dash/src/comments.ts').CommentAnchor

const { parseDoc } = await import('../dash/src/model.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type TableSheet = import('../dash/src/model.ts').TableSheet

const { Store, readCell } = await import('../dash/src/store.ts')
type Patch = import('../dash/src/store.ts').Patch
const {
  insertRowsAt, deleteRowsAt, deleteColumn, moveColumn,
} = await import('../dash/src/rowcol.ts')
const { buildOrder } = await import('../dash/src/filter.ts')
const { previewMarkup } = await import('../dash/src/preview.ts')
const { recalc } = await import('../dash/src/formula.ts')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string): void {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --------------------------------------------------------------- fixtures

/**
 * Four rows, three stored columns and one formula column.
 *
 * The formula column is here for one check and it is the sharpest one: adding a
 * comment must not change a single computed number, because the moment it can,
 * a remark is an input.
 */
const fresh = (): DashDoc => {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1',
    docId: 'd', title: 'test',
    sheets: [{
      id: 'sh1', name: 'Sales', kind: 'table',
      rids: [[1, 4]],
      columns: [
        { id: 'region', name: 'Region', type: 'text' },
        { id: 'amount', name: 'Amount', type: 'number' },
        { id: 'prob', name: 'Probability', type: 'percent' },
        { id: 'wtd', name: 'Weighted', type: 'number', formula: 'Amount * Probability' },
      ],
      data: {
        region: { enc: 'dict', dict: ['North', 'South'], idx: [0, 1, 0, 1] },
        amount: { enc: 'raw', v: [10, 20, 30, 40] },
        prob: { enc: 'raw', v: [0.5, 0.5, 0.5, 0.5] },
      },
      cells: { 'amount:2': { v: 21, was: 20, by: 'andy', why: 'invoice 4471' } },
      steps: [{ op: 'import', from: 'q3.csv', at: '2026-08-03T00:00:00Z', rows: 4 }],
    }],
  }))
  if (!r.ok) throw new Error('fixture does not parse')
  return r.doc
}

const sheetOf = (d: DashDoc): TableSheet => d.sheets[0] as TableSheet

/**
 * The document minus `modified`, keys sorted — the only honest "unchanged".
 *
 * `nextRid` is droppable because the rid watermark is the ONE field store.ts
 * declares must survive an undo: "insert and delete are the ops whose
 * apply→undo is not byte-identical, and the watermark is precisely the part
 * that must survive". Dropping it silently would hide a real regression, so
 * every caller that drops it also asserts the mark went UP.
 */
function canon(doc: DashDoc, dropWatermark = false): string {
  const seen = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(seen)
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {}
      for (const k of Object.keys(v as object).sort()) {
        if (k === 'modified') continue
        if (dropWatermark && k === 'nextRid') continue
        o[k] = seen((v as Record<string, unknown>)[k])
      }
      return o
    }
    return v
  }
  return JSON.stringify(seen(doc))
}

/** The comment every section starts from: on the SECOND row of Amount. */
const ANCHOR: CommentAnchor = { kind: 'cell', col: 'amount', rid: 2 }

const commented = (): { store: InstanceType<typeof Store>; id: string } => {
  const store = new Store(fresh())
  const c = newComment(sheetOf(store.doc), ANCHOR, 'andy', 'Is this net of intercompany?')
  store.commit(addCommentPatch(sheetOf(store.doc), c))
  return { store, id: c.id }
}

/** What the grid would read at a canonical row — value precedence, overrides on top. */
const valueAt = (s: TableSheet, col: string, row: number): unknown => {
  const rid = ridOfRow(s, row)
  const over = s.cells?.[`${col}:${rid}`]
  return over && 'v' in over ? over.v : readCell(s.data[col], row)
}

const value = (s: TableSheet, c: Comment): string =>
  anchorValue(s, resolveAnchor(s, c.anchor))

const find = (s: TableSheet, id: string): Comment =>
  sheetComments(s).find((c) => c.id === id)!

// --------------------------------------------------------------- the model

console.log('\nthe field is additive')
{
  const { store } = commented()
  const round = parseDoc(JSON.stringify(store.doc))
  ok(round.ok && sheetComments(sheetOf(round.doc)).length === 1,
    'a workbook carrying comments parses, and keeps them')

  // The additivity that matters is a build that has never heard of a KIND. It
  // must round-trip, and it must not be drawn on a cell it does not understand.
  const s = sheetOf(store.doc)
  const exotic: Comment = {
    id: 'cmt-future', anchor: { kind: 'range', from: 'a', to: 'b' } as CommentAnchor,
    author: 'someone', at: '2026-08-06T00:00:00Z', text: 'from a newer build',
    mood: 'urgent',
  }
  store.commit(addCommentPatch(s, exotic))
  const again = parseDoc(JSON.stringify(store.doc))
  const back = again.ok ? find(sheetOf(again.doc), 'cmt-future') : undefined
  ok(!!back && (back.anchor as { to?: string }).to === 'b' && back.mood === 'urgent',
    'an anchor KIND and a field this build has never seen both survive a round trip')
  ok(resolveAnchor(sheetOf(store.doc), exotic.anchor).state === 'unknown',
    'and it resolves to `unknown` rather than being guessed at or dropped')

  // THE SHARP EDGE OF WRITING A WHOLE ARRAY. `sheetComments` skips what it
  // cannot read; a factory that mapped the READ list back over the field would
  // delete a newer build's entries as a side effect of somebody clicking
  // Reply. This is the additivity invariant failing where nobody would look.
  const s2 = sheetOf(store.doc)
  ;(s2 as unknown as { comments: unknown[] }).comments.push(
    { id: 'cmt-alien', shape: 'nothing this build knows' })
  ok(sheetComments(s2).length === 2, 'an unreadable entry is skipped by the reader…')
  const c2 = newComment(s2, ANCHOR, 'andy', 'another')
  store.commit(addCommentPatch(s2, c2))
  store.commit(replyPatch(sheetOf(store.doc), c2.id, 'sam', 'noted')!)
  store.commit(deleteCommentPatch(sheetOf(store.doc), c2.id)!)
  const kept = (sheetOf(store.doc) as unknown as { comments: unknown[] }).comments
  ok(kept.some((x) => (x as { id?: string }).id === 'cmt-alien'),
    '…and add, reply and delete all carry it through untouched')
}

console.log('\na comment is not data')
{
  const plain = fresh()
  const before = recalc(sheetOf(plain), plain.modified)
  const { store } = commented()
  const after = recalc(sheetOf(store.doc), plain.modified)
  ok(JSON.stringify([...before.values]) === JSON.stringify([...after.values]),
    'adding a comment changes no computed value — a remark can never be an input')
  ok(JSON.stringify(sheetOf(store.doc).cells) === JSON.stringify(sheetOf(plain).cells),
    'and it writes nothing into `cells`, which is what formulas, totals, charts and the preview read')

  const html = previewMarkup(store.doc) ?? ''
  ok(html.length > 0 && !html.includes('intercompany') && !html.includes('andy'),
    'the static preview of a commented workbook contains neither the text nor the author')
}

// ------------------------------------------------------- the anchor holds

console.log('\nthe anchor survives the VIEW')
{
  const { store, id } = commented()
  const s = sheetOf(store.doc)
  const c = find(s, id)
  const r0 = resolveAnchor(s, c.anchor)
  ok(r0.state === 'live' && r0.row === 1 && anchorRef(s, r0) === 'B2',
    'the comment resolves to canonical row 1, which is B2')
  ok(value(s, c) === '21', 'and reads 21 — the hand correction, not the imported 20')

  // A DESCENDING SORT. The visible position moves; the anchor does not.
  const get = (col: string, row: number): unknown => valueAt(s, col, row)
  const desc = buildOrder(4, get, [], [{ col: 'amount', dir: 'desc' }])
  const visible = desc.indexOf(1)
  ok(visible === 2, `the row is drawn at visible position ${visible} under a descending sort`)
  ok(value(s, c) === '21',
    'and the comment still names 21 — sorting moved the row, not the comment')
  // The discriminator: a POSITIONAL anchor would now be looking at another
  // number entirely, so this check is not vacuous.
  ok(String(valueAt(s, 'amount', desc[1])) !== '21',
    'while a positional anchor on visible row 1 would now name a different number')

  // A FILTER that hides the anchored row. Live, and correctly unreachable.
  const filtered = buildOrder(4, get, [{ col: 'amount', pred: { op: 'greater', v: 25 } }], [])
  ok(filtered.indexOf(1) === -1, 'a filter can hide the anchored row from the view')
  ok(resolveAnchor(s, c.anchor).state === 'live' && value(s, c) === '21',
    'and the comment stays LIVE while hidden — a filter is the reader\'s, not the document\'s')
}

console.log('\nthe anchor survives STRUCTURE')
{
  const { store, id } = commented()
  store.commit(insertRowsAt(sheetOf(store.doc), 0, 1))
  let s = sheetOf(store.doc)
  let r = resolveAnchor(s, find(s, id).anchor)
  ok(r.state === 'live' && r.row === 2 && value(s, find(s, id)) === '21',
    'a row inserted ABOVE shifts the comment down a row and changes nothing it names')
  ok(anchorRef(s, r) === 'B3', 'its A1 handle moves with it (B2 → B3) because the ref is DERIVED')

  store.commit(deleteRowsAt(s, 0, 1))
  s = sheetOf(store.doc)
  ok(value(s, find(s, id)) === '21', 'deleting a different row leaves it naming 21')

  // A column MOVE. The stored anchor cannot move, so the ref has to.
  store.commit(moveColumn(s, 'amount', 0))
  s = sheetOf(store.doc)
  r = resolveAnchor(s, find(s, id).anchor)
  ok(r.state === 'live' && value(s, find(s, id)) === '21' && anchorRef(s, r) === 'A2',
    'moving the column leaves the comment on the same cell and moves only its ref (B2 → A2)')

  // A column RENAME. Identity is the id; the name is display.
  store.commit({ op: 'setColumn', sheet: s.id, col: 'amount', patch: { name: 'Value' } })
  s = sheetOf(store.doc)
  ok(resolveAnchor(s, find(s, id).anchor).state === 'live',
    'renaming the column does not orphan anything — the anchor names the id')
}

// ------------------------------------------------------------- orphaning

console.log('\nwhen the row or the column goes')
{
  const { store, id } = commented()
  const before = canon(store.doc)
  store.commit(deleteRowsAt(sheetOf(store.doc), 1, 1))
  let s = sheetOf(store.doc)
  let c = find(s, id)
  let r = resolveAnchor(s, c.anchor)
  ok(r.state === 'orphan' && r.why === 'row', 'deleting the anchored row ORPHANS the comment')
  ok(c.text === 'Is this net of intercompany?' && c.author === 'andy',
    'the words are still in the file — a structural edit may not delete an argument')
  ok(c.was?.value === '21' && c.was?.row === 2,
    'and `was` still names what it was about: row 2, which read 21')
  ok(anchorLabel(s, r, c.was).includes('deleted row'),
    'the label says the row was deleted rather than naming a rid nobody recognises')

  ok(store.undo(), 'the delete undoes')
  s = sheetOf(store.doc)
  ok(resolveAnchor(s, find(s, id).anchor).state === 'live' && value(s, find(s, id)) === '21',
    'and the comment re-attaches BYTE-IDENTICALLY, because it never moved')
  ok(canon(store.doc, true) === canon(JSON.parse(before) as DashDoc, true),
    'delete → undo leaves the workbook as it was found, watermark aside')
  ok(typeof s.nextRid === 'number' && s.nextRid > 2,
    'and the rid watermark is the only thing that rose — the deleted rid stays spent, so nothing can be minted onto this comment')
}

{
  // THE PAYOFF OF NOT REWRITING ANYTHING. A row can come back by more routes
  // than undo — a re-import, a collaborator's undo, a hand-edited file, a
  // restore from the version timeline — and none of them can be decorated with
  // a "put the comments back" step. Resolving at read time means none of them
  // has to be.
  const { store, id } = commented()
  store.commit(deleteRowsAt(sheetOf(store.doc), 1, 1))
  const reopened = parseDoc(JSON.stringify(store.doc))     // saved, closed, reopened
  if (!reopened.ok) throw new Error('round trip failed')
  const back = new Store(reopened.doc)
  ok(resolveAnchor(sheetOf(back.doc), find(sheetOf(back.doc), id).anchor).state === 'orphan',
    'after a save and a reopen the orphan is still an orphan (undo does not survive a reload)')
  back.commit({
    op: 'insertRows', sheet: 'sh1', rids: [2], at: [1], values: { amount: [21] },
  } as Patch)
  const s2 = sheetOf(back.doc)
  const r2 = resolveAnchor(s2, find(s2, id).anchor)
  ok(r2.state === 'live' && r2.kind === 'cell' && anchorValue(s2, r2) === '21',
    'and the moment anything restores that rid the comment re-attaches itself, to the cell')
}

{
  const { store, id } = commented()
  const s0 = sheetOf(store.doc)
  ok(!!s0.cells?.['amount:2'], 'the fixture has a hand correction on the same cell')
  store.commit(deleteColumn(s0, 'amount'))
  const s = sheetOf(store.doc)
  const r = resolveAnchor(s, find(s, id).anchor)
  ok(r.state === 'orphan' && r.why === 'column', 'deleting the column orphans it too')
  ok(s.cells?.['amount:2'] === undefined,
    'the column delete DID take the override with it — that is the right policy for a correction')
  ok(find(s, id).text.length > 0,
    'and did NOT take the comment: an override rewrites a number, a comment is a sentence a person reads')
}

// ------------------------------------------------------------ the threads

console.log('\nreply, resolve, delete')
{
  const { store, id } = commented()
  ok(unresolvedCount(sheetOf(store.doc)) === 1, 'one thread is open')

  store.commit(replyPatch(sheetOf(store.doc), id, 'sam', 'Yes — checked with finance.')!)
  ok(find(sheetOf(store.doc), id).replies?.length === 1, 'a reply lands on the thread')
  ok(replyPatch(sheetOf(store.doc), 'cmt-nope', 'sam', 'hello') === null,
    'a reply to a thread that is not there returns NOTHING, so no empty undo entry is pushed')

  const beforeResolve = canon(store.doc)
  store.commit(setResolvedPatch(sheetOf(store.doc), id, true)!)
  ok(unresolvedCount(sheetOf(store.doc)) === 0 && find(sheetOf(store.doc), id).resolved === true,
    'resolving marks it resolved')
  ok(setResolvedPatch(sheetOf(store.doc), id, true) === null,
    'resolving an already-resolved thread is a no-op, not a second identical entry')
  store.commit(setResolvedPatch(sheetOf(store.doc), id, false)!)
  ok(!('resolved' in find(sheetOf(store.doc), id)),
    'reopening DELETES the key rather than writing false')
  ok(canon(store.doc) === beforeResolve,
    'so resolve → reopen leaves the workbook byte-identical')
}

console.log('\nadding and removing leave no residue')
{
  const store = new Store(fresh())
  const before = canon(store.doc)
  ok(sheetOf(store.doc).comments === undefined, 'a fresh workbook has no `comments` key')
  const c = newComment(sheetOf(store.doc), ANCHOR, 'andy', 'check this')
  store.commit(addCommentPatch(sheetOf(store.doc), c))
  ok(Array.isArray(sheetOf(store.doc).comments), 'adding one creates the array')
  store.commit(deleteCommentPatch(sheetOf(store.doc), c.id)!)
  ok(sheetOf(store.doc).comments === undefined,
    'deleting the last one DROPS the key — an additive field meaning "none" must be absent')
  ok(canon(store.doc) === before, 'add → delete is a true round trip')

  const store2 = new Store(fresh())
  const before2 = canon(store2.doc)
  const c2 = newComment(sheetOf(store2.doc), { kind: 'sheet' }, 'andy', 'whole sheet')
  store2.commit(addCommentPatch(sheetOf(store2.doc), c2))
  ok(store2.undo() && canon(store2.doc) === before2,
    'and UNDO of an add is byte-identical too — the inverse carries the displaced array')
}

console.log('\nthe agent surface')
{
  const { store, id } = commented()
  store.commit(replyPatch(sheetOf(store.doc), id, 'sam', 'net of it')!)
  store.commit(addCommentPatch(sheetOf(store.doc),
    newComment(sheetOf(store.doc), { kind: 'column', col: 'prob' }, 'sam', 'these are guesses')))
  const flat = flatComments(store.doc)
  ok(flat.length === 2, 'window.bento.comments() returns every thread in the workbook')
  const cell = flat.find((f) => f.kind === 'cell')!
  ok(cell.sheet === 'sh1' && cell.sheetName === 'Sales' && cell.ref === 'B2'
    && cell.row === 2 && cell.column === 'Amount' && cell.value === '21' && cell.live,
    'a cell thread carries sheet, ref, row, column and the value the cell reads NOW')
  ok(cell.replies.length === 1 && cell.replies[0].author === 'sam',
    'replies come flattened with it')
  const col = flat.find((f) => f.kind === 'column')!
  ok(col.ref === 'C:C' && col.row === undefined,
    'a column thread spells its ref the way a spreadsheet does, and has no row')

  store.commit(deleteRowsAt(sheetOf(store.doc), 1, 1))
  const orphan = flatComments(store.doc).find((f) => f.kind === 'cell')!
  ok(orphan.live === false && orphan.was?.value === '21',
    'an orphan says so, and still reports what it was about — an agent must not act on it as if live')
}

// ------------------------------------------------------- negative controls
//
// Each of these is a PLAUSIBLE wrong implementation, run against the very check
// that is supposed to catch it. `broken` passes when the check FAILS, which is
// what proves the check discriminates rather than merely being satisfiable.

console.log('\nnegative controls')
function broken(name: string, checkStillPasses: () => boolean): void {
  checks++
  let held: boolean
  try {
    held = checkStillPasses()
  } catch {
    held = false            // a throw is a failed check, which is a caught break
  }
  if (held) { failures++; console.log(`  FAIL  ${name} — the break was NOT caught`) }
  else console.log(`  ok    ${name} — caught`)
}

// 1. THE ANCHOR IS A ROW POSITION. The obvious first implementation, and the
//    one every spreadsheet-shaped bug in dash so far has been an instance of.
broken('an anchor stored as a row POSITION', () => {
  const s = sheetOf(fresh())
  const positional = { row: 1 }
  const get = (col: string, row: number): unknown => valueAt(s, col, row)
  const desc = buildOrder(4, get, [], [{ col: 'amount', dir: 'desc' }])
  // what the reader sees at "row 1" once sorted
  return String(valueAt(s, 'amount', desc[positional.row])) === '21'
})

// 2. THE ANCHOR IS AN A1 REFERENCE ("B2"). Survives a sort (A1 names the
//    document, not the view) and dies on structure, which is the harder half.
broken('an anchor stored as the A1 ref "B2"', () => {
  const store = new Store(fresh())
  store.commit(insertRowsAt(sheetOf(store.doc), 0, 1))
  const s = sheetOf(store.doc)
  // "B2" now resolves to the freshly inserted blank row
  return String(valueAt(s, 'amount', 1)) === '21'
})

// 3. THE COMMENT IS DELETED WITH ITS ROW, the way an override is.
broken('a comment taken with its row by deleteRows', () => {
  const { store, id } = commented()
  const s0 = sheetOf(store.doc)
  const rid = 2
  // the policy under test: drop any comment naming a doomed rid, in the same
  // commit, exactly as deleteRowsAt drops that row's overrides
  const kept = sheetComments(s0).filter((c) =>
    !(c.anchor.kind === 'cell' && (c.anchor as { rid: number }).rid === rid))
  store.commit([
    { op: 'setSheetProps', sheet: s0.id, props: {}, drop: ['comments'] } as Patch,
    ...deleteRowsAt(s0, 1, 1),
  ])
  void kept
  // the orphan check asks for the words to still be in the file
  return sheetComments(sheetOf(store.doc)).some((c) => c.id === id)
})

// 4. REOPENING WRITES `resolved: false` instead of removing the key.
broken('reopening spelled as `resolved: false`', () => {
  const { store, id } = commented()
  const before = canon(store.doc)
  const write = (v: boolean): Patch => ({
    op: 'setSheetProps', sheet: 'sh1',
    props: { comments: sheetComments(sheetOf(store.doc)).map((c) => c.id === id ? { ...c, resolved: v } : c) },
  })
  store.commit(write(true))
  store.commit(write(false))
  return canon(store.doc) === before
})

// 5. THE EMPTY ARRAY IS LEFT BEHIND.
broken('deleting the last comment leaving `comments: []`', () => {
  const { store, id } = commented()
  const before = canon(fresh())
  store.commit({
    op: 'setSheetProps', sheet: 'sh1',
    props: { comments: sheetComments(sheetOf(store.doc)).filter((c) => c.id !== id) },
  } as Patch)
  return canon(store.doc) === before
})

// 6. THE COMMENT RIDES ON `CellOverride.note` — the field that already exists,
//    and the tempting shortcut. It is data, so it is deleted with the row AND
//    it is one string with no author, no time and no thread.
broken('a comment stored as `cells[…].note`', () => {
  const store = new Store(fresh())
  store.commit({
    op: 'setOverrides', sheet: 'sh1', keys: ['amount:2'],
    v: [{ ...sheetOf(store.doc).cells!['amount:2'], note: 'Is this net of intercompany?' }],
  } as Patch)
  store.commit(deleteRowsAt(sheetOf(store.doc), 1, 1))
  return JSON.stringify(sheetOf(store.doc).cells ?? {}).includes('intercompany')
})

// 7. THE MARKER IS KEYED BY COLUMN ONLY, so a cell comment marks every row of
//    its column. The grouping in `paintMarkers` is what this is about.
broken('markers grouped by column instead of by (column, row)', () => {
  const s = sheetOf(commented().store.doc)
  const c = sheetComments(s)[0]
  const r = resolveAnchor(s, c.anchor)
  // the wrong implementation ignores the rid; the right one carries it
  return r.kind === 'cell' && r.rid === undefined
})

// 8. THE FACTORIES REWRITE FROM THE READ LIST rather than the raw one, so an
//    entry this build cannot parse is deleted by an unrelated Reply.
broken('a factory that rewrites the array from `sheetComments`', () => {
  const { store } = commented()
  const s = sheetOf(store.doc)
  ;(s as unknown as { comments: unknown[] }).comments.push({ id: 'cmt-alien', shape: 'unknown' })
  store.commit({
    op: 'setSheetProps', sheet: 'sh1',
    props: { comments: sheetComments(s).map((c) => ({ ...c })) },   // the break
  } as Patch)
  const kept = (sheetOf(store.doc) as unknown as { comments: unknown[] }).comments
  return kept.some((x) => (x as { id?: string }).id === 'cmt-alien')
})

// 9. THE ANCHOR IS RE-TARGETED TO THE SHEET ON DELETE. It reads tidier — no
//    orphan state, no badge — and it is one-way. Undo hides that inside a
//    session; a save and a reopen do not, and nothing else that restores the
//    row (a re-import, a version restore, a collaborator) can put the anchor
//    back, because the (col, rid) pair it named is no longer in the file.
broken('re-targeting an orphan to the sheet instead of resolving at read time', () => {
  const { store, id } = commented()
  store.commit([
    ...deleteRowsAt(sheetOf(store.doc), 1, 1),
    {
      op: 'setSheetProps', sheet: 'sh1',
      props: {
        comments: sheetComments(sheetOf(store.doc)).map((c) =>
          c.id === id ? { ...c, anchor: { kind: 'sheet' } } : c),
      },
    } as Patch,
  ])
  const reopened = parseDoc(JSON.stringify(store.doc))
  if (!reopened.ok) return false
  const back = new Store(reopened.doc)
  back.commit({
    op: 'insertRows', sheet: 'sh1', rids: [2], at: [1], values: { amount: [21] },
  } as Patch)
  const s = sheetOf(back.doc)
  // the check this is run against: "the moment anything restores that rid the
  // comment re-attaches itself, to the cell". A sheet anchor is always `live`,
  // which is exactly how this failure would pass a lazier check.
  const r = resolveAnchor(s, find(s, id).anchor)
  return r.state === 'live' && r.kind === 'cell'
})

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
