# Two kinds of sheet: spreadsheets and datasets

Proposal, 2026-08-11. Not built. Settles the tension found when someone asked
why the footer's `SUM` was not a formula in D9: dash ships the *table* model
while painting the *canvas* model, with nothing saying which you are in.

## The decision

A workbook holds two kinds of sheet, and the difference is **where the type
lives**.

| | **Spreadsheet** | **Dataset** |
|---|---|---|
| Typed by | the **cell** | the **column** |
| Extent | unbounded — rows and columns past the data | exactly the rows there are |
| `=SUM(...)` | in any cell, including below the data | per-cell, plus one expression down a whole column |
| Storage | sparse: only cells someone touched | columnar, dictionary-encoded, typed arrays |
| Good at | modelling, one-off arithmetic, a shape nobody planned | volume, joins, group-bys, refusing to guess |
| Bad at | 100k rows | being a scratchpad |

Neither is a lesser version of the other. A spreadsheet is a *canvas that
happens to hold numbers*; a dataset is *a table that knows what it is*.

## Why not just one

Making the dataset unbounded would mean a type per cell, which loses the column
type — and the column type is what earns the column formula, the refusal to
guess on import, the conditional formats, the chart binding, and a kernel that
group-bys 10M rows in 11.5 ms from `file://`.

Making everything a spreadsheet loses all of that and gives back Excel, which
is not worth building again.

So: both, named, with an honest conversion between them.

## What already exists

More than expected. This is not a from-scratch feature.

- **`cellformula.ts` is the spreadsheet engine, already written**: `cellKey(row,
  col)`, `bindRefs`, `cellDeps`, `evalCell`, and `recalcCells` with dependency
  ordering. It exists because "a spreadsheet that cannot put a number in one
  cell is not a spreadsheet" — its own words.
- **`CellOverride` already carries per-cell value and formula**, plus `xlsxF`,
  the formula an imported .xlsx held verbatim even when dash cannot evaluate it.
- **The format already tolerates a new kind.** `parseDoc` preserves an
  unrecognised `kind` VERBATIM rather than coercing it to a table — the
  additivity invariant (PLATFORM §3), already fixed and commented. Old builds
  round-trip a spreadsheet sheet without damaging it.
- **`a1.ts` already lexes `Sheet1!A1` and `Table1[Col]`** as qualified names.
- The tab strip already renders non-table kinds with a chip and a tooltip.

## Model shape — it is already in the format

**Correction to the first draft of this document, which proposed a new
`kind: 'grid'`.** It is not needed. `CanvasSheet` already IS the spreadsheet
kind, has been since commit one, and says so in its own header:

> The classic sparse A1 map — the right tool for an invoice or a scratch pad,
> the wrong one for 100k rows. In the format from commit one, because an escape
> hatch added later is permanently second-class (PLATFORM §3).

That decision was made before this conversation and was right. It carries
exactly what a cell-typed sheet needs:

```ts
export interface CanvasSheet {
  kind: 'canvas'
  cells: Record<string, CanvasCell>   // sparse
  cols?: Record<string, number>       // column widths
  rows?: Record<string, number>       // row heights
}
export interface CanvasCell {
  v?: unknown; f?: string             // value, formula
  format?: string; note?: string
  color?: string; bg?: string; bold?: boolean; align?: string
}
```

Note what `CanvasCell` already models: **per-cell colour, background, bold and
alignment.** `docs/dash-release.md` lists "no cell formatting at all" as a gap —
it is a gap in the dataset kind, and the format has always had the answer on
this one.

`kind: 'table'` stays the dataset. Adding a third kind when the second was put
there for this purpose would leave two half-built spreadsheet kinds, which is
worse than the problem.

**What is missing is the implementation.** The tab strip greys a canvas sheet
with "not editable in this build"; nothing renders or edits one. `validate.ts`,
`preview.ts` and `pivot.ts` already branch on the kind, so the seams exist.

**UI wording.** "Canvas" is the wire word and does not change (PLATFORM §3).
The label a reader sees is **Spreadsheet**, the same way `select()` localises
display labels while values stay model words. The tab chip stops saying
"Canvas".

## The bridge, which is the actual product

Two sheet kinds is a feature. The **conversion between them** is the thing
neither Excel nor a BI tool does well:

- **Promote a range to a dataset.** Select A1:F400 on a spreadsheet → "Make this
  a dataset". dash infers a type per column and *refuses where it cannot decide*,
  which is the behaviour import already has. The result is a dataset sheet, so
  it gets column formulas, conditional formats, charts, pivots and — when it
  lands — SQL.
- **Open a dataset as a spreadsheet.** A flat, cell-typed copy for the one
  awkward calculation the pipeline cannot express. It is a copy, and it says so;
  the live thing is the dataset.

That round trip is the answer to "I have a table but I need one weird number in
the corner", which is why people abandon BI tools for Excel in the first place.

## Consequences worth stating before building

- **Storage.** A spreadsheet with A1 and Z10000 filled must not allocate 10,000
  rows. Sparse map, and `extent` bounds the rendered frontier.
- **Collaboration.** The CRDT keys dataset rows by `rid` (`r␟<sheet>␟<rid>`).
  A spreadsheet has no rids: its cells are keyed by position, so a node is
  `g␟<sheet>␟<col>,<row>` and inserting a row *moves* cells rather than
  renumbering identities. That is a real difference and needs its own
  convergence rig, not a reused one.
- **Cross-sheet references.** `a1.ts` lexes `Sheet1!A1` but nothing resolves it.
  A spreadsheet without cross-sheet refs is half a spreadsheet, so this is in
  scope for the kind, not a later nicety.
- **SQL / database mode** (`docs/dash-sql.md`) operates on **datasets**. That is
  now a clean statement rather than a limitation: a query needs typed columns,
  and this is the kind that has them.
- **Charts and pivots** bind to datasets. From a spreadsheet you promote a range
  first — one extra step, and it is the step that makes the chart trustworthy.
- **The starter workbook** should open with one of each, because the difference
  is the thing to teach in the first ten seconds.
- **`.xlsx` import** currently lands as a dataset and guesses types. It should
  land as a **spreadsheet** — that is what an xlsx *is* — and offer promotion.
  This probably improves fidelity: `xlsxF` exists precisely because import meets
  formulas it cannot place in a column model.

## Export, and why Excel already agrees with this split

**Excel has both kinds too, and has for fifteen years.** An ordinary worksheet
is cell-typed. An Excel *Table* (a `ListObject`) is column-typed: it has named
columns, CALCULATED COLUMNS where one formula fills the column and structured
references address it (`Table1[Value]`), a header row, autofilter state, and a
totals row driven by a table PROPERTY — `totalsRowFunction="sum"` — rather than
by a formula someone typed.

That is dash's dataset, described in Microsoft's own schema. So the mapping is
not a compromise, it is a translation:

| dash | xlsx |
|---|---|
| spreadsheet sheet | an ordinary worksheet — cells, formulas, per-cell formats |
| dataset sheet | a worksheet carrying **one `ListObject`** |
| column formula | a calculated column, structured refs |
| `totals: {value:'sum'}` | `totalsRowFunction="sum"` |
| filters / sorts | the table's autofilter state |
| conditional formats | `<conditionalFormatting>` |
| comments | threaded comments |

One detail that vindicates a fix made this week: Excel renders a table's totals
row as `SUBTOTAL(109, …)`, and **`SUBTOTAL` ignores rows the filter has
hidden.** dash's footer now totals the filtered view. That is not dash
deviating from Excel — it is dash matching Excel's *table* semantics, which is
the right thing for the kind.

**And the same rule runs the import**, which is what makes a round trip stable:
an xlsx worksheet becomes a spreadsheet; an xlsx Table becomes a dataset.
`dataset → Table → dataset` and `spreadsheet → worksheet → spreadsheet` both
return what went in. Today neither does, because everything imports as a table
sheet and everything exports as loose cells.

### What today's export does, and what changes

The exporter writes `<f>SUM(D2:D9)</f>` into the totals row — a real cell
formula. Excel users therefore already get the formula that dash's own UI could
not offer. It works, and it is lossy in a precise way: re-importing gives back a
formula cell, not a totals property, so the dataset comes home as something
flatter than it left. Emitting a `ListObject` fixes that without changing what
Excel shows.

### What stays lossy, and should say so

- **Pipeline steps** (`join`, `group`, `union`, `derive`). Excel's equivalent is
  Power Query, a different language (M). Export materialises the RESULT — which
  is honest and is what happens today — and the finding should name what was
  flattened, because a colleague opening the file sees numbers with no way to
  know how they were derived. Emitting M is a later option, not a first cut.
- **Row identity (`rid`).** No xlsx home. It matters because comments, hand
  corrections and per-cell formulas all anchor to rids, so a re-import cannot
  reattach them to the same rows. A hidden column or a custom XML part could
  carry it; until then the finding should say the anchors will not survive.
- **dash-only functions.** `liveFormula` already classifies what Excel will not
  run; the reverse check is owed.

### CSV

A dataset is a CSV — one header row, one row per row, formulas flattened to
values. A spreadsheet is not: CSV has no answer to "which range", and Excel's
own convention (the used range, values only) is the one to copy, stated in the
export dialog rather than assumed.

Note a defect to fix alongside: `exportCsv` currently exports
`sheets.find(kind === 'table')` — the FIRST table sheet in the workbook, not the
one on screen. With one sheet that looked correct; with tabs it is simply wrong.

## Settled while building: which kind may reach another sheet, and what row 1 means

2026-08-18, after a bounce test. Two questions the section above left open, and
the second one had no answer written down anywhere.

### A dataset resolves cross-sheet references in a CELL formula

`=SUM(Jan!B1:B6)` returned `#REF!` on a dataset sheet and the right number on a
spreadsheet sheet **in the same workbook**. That reads as an unimplemented
feature and was not one: `recalcWorkbook` had crossed sheets since the workbook
graph landed, the spreadsheet's grid called it, and the dataset's grid called
the one-sheet entry point beside it. A kind is not a place to keep an accident.

So: **yes, from a per-cell formula.** A `CellOverride.f` is the CELLULAR escape
hatch inside the columnar kind — addressed by position, bound by `cellformula.ts`,
which is already workbook-wide. The boundary that actually separates the kinds is
where the TYPE lives, and a cell override sits on the cellular side of it either
way. A spreadsheet has been able to read `Pipeline!A1` all along, so refusing
only the outbound direction made the dataset the lesser kind, which the top of
this document says in as many words it is not.

### A COLUMN formula still may not, and now says so

Rejected, and not on cost — the refusal is the feature. A column expression is
defined over the columns of ONE sheet by identity, which is the whole structural
claim `formula.ts` makes: no positions, so no `#REF!` class, and inserting a row
changes nothing. Reaching another sheet hands that back in the two worst ways:

- **another sheet's CELL** (`Rates!B2`) puts back exactly the address that moves
  when somebody inserts a row on a tab the author is not looking at — inside the
  one expression that has *n* rows depending on it;
- **another sheet's COLUMN** is a **join**, and pairing row *i* with row *i* is a
  join with no key, no cardinality answer and no opinion about two sheets of
  different lengths. `join` is already in the step vocabulary and asks all three
  questions. A second, worse join hidden inside an arithmetic expression is not
  a feature; it is next year's bug report saying the numbers changed when
  somebody sorted a different tab.

Note this keeps ONE rule rather than inventing a second: defined names do not
reach a column formula either (`recalc` takes a sheet, not a document). The
column language is closed over its own sheet, and that is now true without
exception.

### What the reader sees instead of `#REF!`

`#REF!` means *the thing this pointed at was deleted* — the reader's file, the
reader's mistake. It was being spent on two things that are not that:

| typed | said | says now |
|---|---|---|
| `Jan!A1` in a column formula | `#NAME?` *unknown name "Jan"* | `#NAME?` *"Jan" is another sheet. This expression is computed over the columns of its own sheet only — a formula in a single CELL can reference another sheet, and a join step brings another sheet's rows across.* |
| `Jan!A1` evaluated outside a workbook | `#REF!` *there is no sheet called "Jan" in this workbook* | `#REF!` *"Jan" is another sheet, and this formula is being computed on its own — outside the workbook that would resolve it* |
| `Feb!A1` where Feb really is gone | `#REF!` *there is no sheet called "Feb" in this workbook* | unchanged — this one was always true |

The first was false twice over: the name is not unknown, it is a sheet in the
tab strip, and the reason it cannot be used is a boundary rather than a typo, so
the old wording sent the reader to fix a spelling that was already right. The
codes stay Excel's, because the grid has one cell of space to say it in; the
whole difference is in `FormulaError.why`, which is what the panel shows.

### The trap underneath: what an A1 row number counts

`Contacts!D2` is the dataset's second **data** row. `D2` in the spreadsheet
**copy** of that same dataset is the second row *including the header* — the
first data row. Both are internally consistent; side by side they are off by one.

THE RULE, and it is one rule rather than two:

> **An A1 row number is the row number the addressed sheet paints in its own
> gutter.**

Both kinds already satisfy it, and it is the only rule a reader can *check* —
look at the sheet, read the number beside the row. A dataset's gutter counts
data rows because a dataset has exactly the rows it has and its header is chrome
(`docs/dash-excel-gap.md` files that under DELIBERATE DIFFERENCE). A
spreadsheet's counts every row because a spreadsheet has no headers, only cells,
one of which happens to hold a word.

**The Excel-shaped alternative was rejected.** Making a dataset's A1 count the
header would make the two kinds agree with each other and with Excel — and would
put a formula's row numbers out of step with the row numbers printed down the
side of the very same sheet. That is the worse mismatch: the cross-kind one
needs two sheets in front of you to notice, this one needs none. It would also
silently change what every `Pipeline!A2` in every saved file already means.

**So the offset is not removed, it is owned.** What makes the two bases safe to
coexist is already true and was only unwritten: `flattenToSpreadsheet` shifts a
copy's LOCAL references by the header row (the cells moved) and leaves QUALIFIED
references exactly as written (that sheet did not move), so no reference is
re-pointed at a different row by the conversion. `cellformula.rowMeaning(sheet)`
is the sentence for the other half — the reader with both sheets on screen, about
to type an address at one of them. Both halves are pinned by
`scripts/test-dash-xsheet.ts`, which measures the one-row offset against both
sheets rather than asserting it, because that is the part that would rot in
silence.

## Not in scope for the first cut

Merged cells, per-cell borders and fills (dash has no manual cell formatting at
all yet — its own backlog item), array formulas, and iterative/circular
calculation.

## Sequencing

The honest order, given `docs/dash-release.md` §0 is now clear:

1. **Ship a release first.** It is a day of changelog and a version bump, and it
   makes the second release able to prove the update path, which nothing else
   can.
2. **Spreadsheet kind**, because it fixes something people hit in the first
   minute and most of the engine is written.
3. **Step engine**, owed regardless — `applySteps` currently throws.
4. **SQL surface** on top of it, which is small once 3 exists.

Doing 4 before 2 would ship a query language for an app whose grid still cannot
take `=SUM(` below a column.
