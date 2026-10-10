# What breaks when an Excel user opens dash

A bounce test, 2026-08-18, branch `dash-bounce` off `worktree-bento-dash`
(`37dbf9a`), against `dash/dist-single/Bento_Dash.bento.html` built from that
commit — v0.3.0, 361KB compressed. Four `.xlsx` files were authored by hand
(a Node script emitting OOXML into a ZIP, deliberately not dash's exporter) and
four ordinary jobs were done end to end in the browser: a monthly budget, a
sales pipeline report, a timesheet, and a messy-data clean-up.

Everything below was observed in the running application unless it says
otherwise. Where a finding is a reading of the source rather than of the
screen, it says so.

## The instrument, and what it got wrong

Two instrument failures happened before any finding did, and both would have
been filed as defects by a less careful pass.

The first: the browser pane's `type` action inserts text without dispatching
`keydown`, so typing over a selected cell appeared to do nothing. dash's
`typeInto` (`dash/src/grid.ts:2983`) is wired correctly and fires on a real key.
The second is worse: the pane's key action does not deliver `Return` as `Enter`.
For half an hour the grid looked as though pressing Enter left an edit in limbo
— painted in the cell, absent from the document, absent from every total, and
absent from `window.bento.serialize()`, which is to say lost on ⌘S. It was the
key name. With `Enter`, commit, recalculation, footer aggregate and repaint all
land synchronously and correctly. **There is no such defect.** It is recorded
here because the false version of it was more alarming than anything real in
this document, and because the next person driving this app from a harness will
hit the same wall.

Two further limits, neither a dash defect: the pane cannot drive a native file
picker, so files were delivered through the drop path (`dropopen.ts`) rather
than "Import Excel…"; and it denies File System Access, so ⌘S write-back was
not exercised.

The fixture generator was sanity-checked before use: all four archives pass
`unzip -t`, and all four import through `importXlsx` headlessly. No finding
below rests on a malformed file.

The console was read after every job. **It is empty. Nothing in dash threw
once, in any of the four jobs.** That is worth saying before the list.

---

## BROKEN

### 1. ~~A dataset column of imported numbers totals to zero~~ — FIXED (`7772e81`, `f62080b`)

This is the heaviest thing here, and it is a wrong number rather than a missing
feature.

`messy.xlsx` has an Amount column mixing real numbers with numbers Excel stored
as text (`"1,240.00"`, `"  742.10 "`). Import types the column `text` and says
so, helpfully: *"Imported as text so nothing is lost — set the column type once
you have decided what it is."*

Follow that instruction. Set the column to Number. The grid immediately
right-aligns every value and formats it — `"  742.10 "` renders as `742.10`,
`980.5` as `980.50`. The column now looks, in every respect, like a column of
numbers.

Then ask for its total. The status bar for the whole column reads `Cells 10` —
no Sum, no Avg, not even Count. Set Column ▸ Total ▸ sum and the footer prints,
in the same type it uses for every other total in the product:

    SUM 0

The true total is 10,308.85. dash knows it: promote the same rows to a
spreadsheet sheet and `=SUM(D2:D10)` returns **10,308.85** immediately. Two
surfaces in one workbook, on the same data, disagree — and the confident one is
wrong.

The cause is one line. `aggregate` (`dash/src/grid.ts:299-316`) reads the
stored value and skips anything that is not already a number:

    if (typeof v !== 'number') continue

Changing a column's type reinterprets the column for *display* but never
converts what is stored; the model still holds the string `"  742.10 "`
(verified against `window.bento.doc`). The renderer coerces through the column
type, the aggregate does not, and nothing reconciles them. Either the type
change converts the stored values, or the aggregate reads through the same
coercion the renderer uses — but the two cannot keep disagreeing, because the
disagreement is printed as a number.

Note how this compounds: the import finding is what sends the person to the
type switcher in the first place. dash gives good advice and then punishes it.

### 2. ~~A formula column that returns text is typed Number~~ — FIXED (`dash-uireach`)

Splitting `"Lastname, Firstname"` with a formula column —
`TRIM(LEFT(Name, FIND(",", Name) - 1))` — works, and handles the blank rows
without spraying errors. The resulting column of surnames is created with
`type: "number"`: header badge NUMBER, values right-aligned, and (by finding 1)
aggregating to nothing.

`dash/src/main.ts:1702` hardcodes it:

    column: { id, name: …, type: 'number', formula: got.expr }

The type is never inferred from what the expression returns or from the values
it produced. Downstream this picks the wrong filter operators, the wrong sort,
and the wrong export type for every text-valued computed column.

### 3. ~~A merged title makes the whole sheet text~~ — FIXED (`70bfa35`)

`budget.xlsx` has an ordinary spanning title in `A1:C1` and its real header in
row 2. dash takes row 1 as the header. Column A becomes "Jan 2026 budget";
B and C become "Column 2" and "Column 3"; "Category / Budget / Actual" becomes
data row 1; and because each numeric column now contains one text value, every
column is typed **text**. A three-column budget arrives with no numbers in it.

dash emits all the right facts and never joins them. The merged-range sentence
is the best writing in the product. The `empty-header` and `mixed-types`
findings that follow are the *consequences* of that same merge, and they read as
three unrelated complaints. Nothing says "the header looks like it is in row 2".
Nothing offers to use it: `XlsxImportOpts` (`dash/src/xlsx.ts:739-741`) has a
`header` boolean — has one or hasn't — not "which row", and no UI reaches it
anyway. There is no "use this row as the header" in the cell menu.

This is a repair, not a feature: dash already knows there is a merge in row 1
and already knows row 2 is the only row where every column is text.

### 4. ~~A defined name passes the live-formula gate~~ — FIXED (`01ffff1`, `43398cf`)

`budget.xlsx`'s Summary sheet has `=SUM(RentCells)/B5`, where `RentCells` is a
`definedName`. dash imports it **live** and the cell renders **`#NAME?`** in
red. Excel's cached 0.61 is gone, and no finding mentions it.

`liveFormula` (`dash/src/xlsx.ts:721-735`) screens for three things: a `!`
(another sheet), a `[` (external or structured reference), and function names it
does not know. A bare identifier is none of those, so it sails through. The
irony is exact — the `formula-not-live` message printed elsewhere on the same
screen promises this will not happen: *"a live formula dash cannot evaluate
would replace real numbers with #NAME?."*

Named ranges themselves are in flight and are not the finding. The finding is
that the gate has no fourth check, so the one class of formula it lets through
by accident is the one that loses data. A bare identifier that is not a known
function should fail the gate and take a `formula-not-live` finding, exactly
like `SUBTOTAL` does.

### 5. ~~Four of six conditional-format rules are unreachable~~ — FIXED (`dash-uireach`)

Job 3 asks to flag anyone over 40 hours. Right-click a cell and conditional
formatting offers **Colour scale** and **Data bars**. That is all there is.

`condfmt.ts` implements six rule kinds. `CellValueRule` (lines 93-102) supports
`>`, `>=`, `<`, `<=`, `=`, `<>`, `between`, `contains`, `startsWith`,
`endsWith`, `blank`, `notBlank`. There are also `topN`, `duplicates`, and a
`formula` rule evaluated vectorised. `validate.ts:676` accepts all six.

The UI creates two. `dash/src/main.ts:2047-2049` writes exactly three buttons,
and `main.ts:2089-2090` constructs exactly `colorScale` and `dataBar`, with
hardcoded colours. Nothing anywhere else in `src/` constructs a `cellValue`,
`topN`, `duplicates` or `formula` rule.

So the most-used conditional format in the world — "highlight cells greater
than N" — is missing from an application that has already built it and already
persists it. `duplicates` is the same story, and it is Job 4's other half.
This is a dialog over a finished engine, not a feature.

---

## BLOCK

### 6. ~~Cross-sheet references work in one sheet kind~~ — FIXED (`dash-xsheet`, `00b59dd`)

Job 1 asks for a formula on one sheet totalling another. In a **dataset**
sheet, typing `=SUM(Jan!B1:B6)` gives **`#REF!`**. The job cannot be done.

But in a **spreadsheet** sheet, in the same workbook, `=Contacts!D2` resolves
and returns 980.5. So this is not "unimplemented" — it is implemented, and one
of the two kinds does not reach it.

`#REF!` is the wrong word regardless. To an Excel user `#REF!` means *you
deleted the thing this pointed at* — their mistake, their broken file. The
honest answer is "a dataset sheet cannot reference another sheet yet; a
spreadsheet sheet can". dash's import findings already say that sentence well
(*"they point at other sheets or external data"*). The formula engine says
`#REF!`.

One more trap sits underneath: the same A1 address means different rows in the
two kinds. `Contacts!D2` returned the dataset's second **data** row, while D2 in
the spreadsheet copy of that dataset is the second row *including the header*.
Both are internally consistent; side by side on one screen they are not.

### 7. ~~Frozen panes, per-cell formatting, validation and the totals row dropped in silence~~ — FIXED (`b155131`, `cfa0fcb`)

Measured on the imported documents. Every fixture froze its header
(`<pane ySplit="1" state="frozen"/>`); every imported sheet reports
`frozenRows: 0`. Every fixture bolded its header and totals rows; not one cell
override carries `bold`. `pipeline.xlsx` carries a `dataValidation` list on
Stage and two `definedName`s; neither appears in the document or in the
findings.

dash's import vocabulary is fourteen codes (`grep "code: '" dash/src/xlsx.ts`):
`merged-cells`, `no-header`, `leading-blanks`, `duplicate-header`,
`empty-header`, `mixed-types`, `coerce-failed`, `date-1900-bug`, `time-of-day`,
`formula-not-live`, `sheet-skipped`, `chart-dropped`, `hidden-sheet`,
`date-system`. There is no code for a dropped freeze, a dropped format, a
dropped validation list, a dropped defined name, a dropped conditional format,
or a totals row flattened into data.

The freeze and the bold are the ones that sting, because **dash already
supports both**. The sheet panel has Frozen rows and Frozen columns. Cells take
bold, colour, background and borders. The file said so and dash threw it away
without a word, then made the person do it again by hand.

The totals row is the consequential one. Excel's totals row imports as an
ordinary data row. Sort `pipeline.xlsx` by Value descending and the row labelled
"Total", holding 869,050, sorts to the **top of the deals list**. It will also
be caught by filters and counted by aggregates. `docs/dash-sheet-kinds.md`
already worked out the correct mapping — `totalsRowFunction="sum"` ⇄
`totals: {value:'sum'}` — and dash's column panel already has that control.

---

## FRICTION

### 8. ~~Right-click on a row number or a column letter does nothing~~ — FIXED (`86fa750`)

The cell context menu is good: insert row above/below, delete row, insert and
delete column, fill down, clear contents, the two conditional formats, remove
formatting. Right-click a **cell** and it appears.

Right-click the row-number gutter, or the column-letter header, and nothing
happens at all. In Excel those two gutters are where row and column work
*lives* — it is the first thing a hand reaches for. dash selects the row and
shows no menu, so the person concludes there is no insert. Measured on both
gutters, twice.

The menu is also missing Copy, Cut and Paste, which is the other reason people
right-click a cell.

### 9. ~~⌘Z after a sort undoes the wrong thing~~ — FIXED (`dash-honesty`)

Sorting is view state and is deliberately not a document edit — `store.ts`
(around line 950) says so and flags the mismatch as an open question. Measured:
after clicking a column header to sort, ⌘Z left the sort in place and instead
undid the **number format applied two actions earlier**. The person loses work
they wanted kept and keeps the thing they wanted reversed, with no indication
either way.

"Sort is not undoable" would be defensible. Silently undoing something else is
not.

### 10. ~~The filter has no list of values, and one operator per column~~ — FIXED (`084da64`, `d3bf3ba`)

Excel's autofilter is a checklist of every distinct value. dash's text filter is
a single free-text **Contains** box: to filter Stage to "Open" you must already
know the word and spell it. On a column with forty distinct values you cannot
see what is in it. A number column offers exactly **Greater than** — no less
than, no between, no top-10.

The filtering that *is* there works well and composes across columns (Stage
contains Open + Value greater than 50000 gave "4 of 11 rows", correct), and the
status line naming the view is better than Excel's. It is the reach that is
narrow.

### 11. ~~An imported per-cell formula does not extend to a new row~~ — FIXED (`86fa750`)

`timesheet.xlsx` has `=SUM(B2:F2)` down a Total column. Add a person: the Total
cell for the new row is **empty**. Excel's table would have filled it.

dash's answer is a column formula, which does propagate, and which is genuinely
better (see below). But an imported sheet's per-cell formulas stay per-cell
forever, and nothing says so at the moment the hole appears. The same applies to
the day-total row, which does not include the new person and does not say it
does not.

Adding the row also placed it *below* the imported "Day total" row, which is
finding 7 again: dash cannot know that row is a total, because the import did
not tell it.

### 12. ~~Fifteen findings arrive as one unbroken paragraph~~ — FIXED (`e10f762`)

`budget.xlsx` produced a wall of amber text 224px tall — 31% of a 720px window —
with no bullets, no grouping by sheet, no link to the column concerned, and no
dismiss. It survives every edit.

`showFindings` (`dash/src/main.ts:1571`) is written to render one bullet per
finding, and the menu import path (`main.ts:1977`) passes the array, so it does.
The **drop** path flattens them first — `dash/src/dropopen.ts:248-250`:

    const findings = (…).map((f) => f.message)
    host.notice([t('Imported {n} sheet(s) from “{name}”.', …), ...findings].join(' '))

Two doors into one feature, and the one people actually use — dragging a file
onto the window — is the one that destroys the structure. Confirmed from the
other side: promoting to a spreadsheet renders its three findings as three
readable lines. The drop path is the odd one out, and the fix is to pass the
array.

### 13. Smaller things, measured — MOSTLY FIXED (see the note at the end of this section)

- A number **pattern** typed against a `text` column is accepted, displayed as
  set, and does nothing. The panel's own line — *"The column decides what these
  cells ARE. A pattern here only changes how they print."* — is exactly right
  and is the sentence that should also appear when the column is Text and the
  pattern is numeric.
- Setting a column to **Date** on messy text (`03/04/2026`, `Mar 7, 2026`,
  `12-05-2026`) is a silent no-op: the badge changes, no value parses, nothing
  is said. Setting the same column to Number *does* convert and reformat, so
  the person has every reason to expect Date to work the same way. Date is also
  where an unstated guess would be dangerous — `03/04/2026` is two different
  days — so a refusal is right; the silence is not.
- **Escape does not close the cell context menu.**
- **⌘H** does nothing. ⌘F opens Find, and its Replace… / Replace all works
  correctly ("1 replaced", verified across the sheet). ⌘H is Windows Excel's
  muscle memory and costs one line in the key map.
- The **column appender is invisible**: rows have a `+` row at the bottom,
  columns have nothing at the right edge — Insert column exists only in the
  cell right-click.
- **Print** offers sheets, paper, orientation, a wide-sheet strategy and a live
  page estimate, which is better than Excel's equivalent. It has no repeat-header
  rows, no margins, and no header/footer, so a printed budget carries no page
  number, date or file name.
- **`TEXT()`, `VALUE()` and `DATEVALUE()` are absent** from the 91 functions in
  `formula.ts`. Those three are the standard Excel repair for exactly the mess
  in Job 4, so the person who reaches for the formula answer to
  numbers-stored-as-text finds nothing there either. Also absent: `SUBTOTAL`
  (which Excel writes into *every* table totals row, so every imported Excel
  table arrives with a dead total — measured on `pipeline.xlsx`), `SEARCH`,
  `SUMPRODUCT`, `LARGE`/`SMALL`, `ROW`/`COLUMN`, `CHOOSE`, `HLOOKUP`,
  `TRANSPOSE`, `REPLACE`. `VLOOKUP`, `XLOOKUP`, `INDEX`, `MATCH`, `SUMIFS`,
  `COUNTIFS`, `MAXIFS` and `AVERAGEIFS` are all present.


**Finding 13 outcomes.** Fixed: the Date-on-messy-text silent no-op (`setColumnType`
refuses and names the value); pattern-on-a-text-column (a persistent panel note,
not a toast — a display pattern destroys nothing, so a refusal would be the wrong
shape); Escape closing the cell menu; the invisible column appender; and 12 of the
14 missing functions, `SUBTOTAL` among them, which is what made every imported
Excel table arrive with a dead total.

NOT done, deliberately: `ROW`/`COLUMN`, because registering a function is what
admits it through the xlsx liveness gate (`FN_SET` is built from `FUNCTIONS`), so
a `ROW()` that cannot answer without an anchor would import LIVE and paint
`#VALUE!` over the number Excel had cached. And ⌘H, which is still open.

Two of the three print complaints were STALE when written: `thead {
display: table-header-group }` already repeated column names and `@page{margin:12mm}`
already existed. What was real was the sheet caption printing on page one only —
now the first row of that `thead`, carrying the date — plus margin choices. Page
numbers stay out, and the reasoning was re-argued rather than overridden: margin
boxes are unimplemented in every browser and a second set disagreeing with the
system dialog's is worse than none. The dialog now says where they come from.

---

## DELIBERATE DIFFERENCE

Checked against `docs/dash-sheet-kinds.md` and `docs/DECISIONS.md` before being
put here. For each of these the question is not whether to build it, but
whether the product says so where the person is standing.

### 14. A dataset has exactly the columns and rows it has

There is no unbounded grid to the right of the last column, and no cell below
the last row to put `=SUM(` in. This is the whole point of the kind, and dash's
answer is the other kind. **This one is said well.** The tab chip reads
DATASET, "Open as a spreadsheet" sits permanently in the top-right, and the
popover states the terms *before* the action: *"A COPY, as the dataset is right
now. Editing it does not change the dataset, and the dataset does not update
it."* That is the pattern the rest of this document keeps asking for.

The spreadsheet kind is real and works — unbounded grid, per-cell formulas
including `SUM` below a column, cross-sheet references, per-cell format and
pattern, and "Make A1:F3 a dataset" offered back in the top-right.
`docs/dash-sheet-kinds.md` still describes it as "Not built"; that is stale.

### 15. Number format lives on the column, not the cell

So a totals row cannot carry a currency format that its data column does not.
This is `docs/dash-sheet-kinds.md`'s central position and the panel states it
plainly. It is correct and it is said.

Where it is *not* said is at the edge described in finding 13: when the column
is Text and the pattern is a number pattern, the field accepts it silently.

### 16. One formula per column, not one per row

Adding the Commission column took one dialog: the formula was pre-filled as
`Value * Rate`, the available columns and functions were listed under the box,
and the result computed for every row at once with an `fx` badge on the header.
No fill-down, no drag handle, no chance of the formula stopping at row 200.
This is better than Excel and should be sold as such — but it is the reason
finding 11 bites, and nothing connects the two when the hole appears.

---

## What is already better, and should not be traded away

Worth recording, because a gap list read on its own suggests a product in
worse shape than this one is.

- **Leading zeros survive.** `"00417"` imported as `00417`. Excel destroys
  those routinely.
- **Numbers stored as text convert in one click** — commas, stray whitespace
  and all. In Excel that is Text-to-Columns or a `VALUE()` column. Finding 1 is
  the tragedy here: the conversion is the good part and the total is the bug.
- **The chart honours the filter and says so**, printing *"4 of 11 rows — a
  filter is hiding the rest"* beneath itself. Excel does not tell you that.
- **The status line names the view**: "4 of 11 rows · Sorted by Value ▼".
- **The status bar's selection summary** matched Excel exactly (Sum 519,700 ·
  Avg 129,925 · Count 4 · Cells 4) and was the only way to read the filtered
  total, which is the same way an Excel user would do it.
- **Import reads types well when the header is where it says it is.**
  `pipeline.xlsx` landed with Number, Date and Percent inferred correctly,
  dates as dates, and clean findings. `timesheet.xlsx` landed with every
  formula live and every total right, and produced **no findings at all** —
  which is the correct output for a clean file and is harder than it looks.
- **The merged-cells message** remains the best sentence in the product.
- **Nothing threw.** Four jobs, four imports, dozens of edits: the console
  stayed empty.

---

## The two judgements

**Which single absence would make the most Excel users quit in the first ten
minutes.** Not an absence — finding 1. A column that displays as numbers and
totals to `SUM 0` is worse than any missing feature, because the person cannot
tell whether the tool is broken or they are, and the number is printed with the
same confidence as a correct one. Every other item on this list costs time;
this one costs trust, and it costs it in the first ten minutes because
"import a file, total a column" *is* the first ten minutes. It sits behind the
advice dash's own import findings give.

If the question is restricted to a genuine absence, it is finding 5 —
"highlight cells greater than 40". People reach for it constantly, it is the
proof that a grid is a spreadsheet rather than a table viewer, and dash has
already written the engine. Two colour ramps in its place reads as a product
that has not started.

**Which "missing feature" is actually a deliberate difference that just needs
saying.** Cross-sheet references (finding 6). It presents as a hole and is
really a boundary: the spreadsheet kind resolves `Sheet!A1` today, the dataset
kind does not, and that split follows directly from what the two kinds are.
What the product does instead is print `#REF!` — a code that in Excel means the
user broke something. dash already knows how to say this properly; its import
findings do it in the same session, in the same amber banner. The dataset grid
should answer a cross-sheet reference the way the popover answers "Open as a
spreadsheet": name the boundary, and point at the kind that crosses it.

Running it a close second: the totals row (finding 7). "Excel's totals row is a
property of a table, and dash keeps it as one" is a *better* position than
Excel's, already written down in `docs/dash-sheet-kinds.md` — but until it is
implemented and stated, what the person sees is their Total row sorting itself
into the middle of their deals.


### 17. `AVG` over an empty view reports 0, and there is no average of nothing

Found while adding `SUBTOTAL`, by comparing it against the footer rather than
against a hand-worked number — the two disagreed and the formula was right.

`grid.ts aggregate()` ends `spec === 'avg' ? (seen ? acc / seen : 0) : …`, so a
view whose filter has hidden every row shows **AVG 0**. `SUBTOTAL(101, …)` over
the same rows answers `#DIV/0!`, which is the true answer: an average of nothing
is not zero.

Same class as finding 1 — a confident number where there is none — and much
smaller, because the view is visibly empty above it. `sum` of nothing IS legitimately
0; `avg`, `min` and `max` of nothing are not, and `min`/`max` should be checked
at the same time.

Left open deliberately: `grid.ts` was owned by another agent when this was
found, and `SUBTOTAL`'s rig asserts the divergence as a DIFFERENCE rather than
quietly matching the formula to the grid — matching would have buried it.


### 18. OPEN DECISION — should `SUBTOTAL` in a cell formula see the viewer's filter?

Not a defect. A decision that fell out of adding `SUBTOTAL`, and it is recorded
rather than taken because it crosses a boundary the formula engine has kept.

`SUBTOTAL(109, …)`'s whole meaning is *ignore rows a filter has hidden* — a
`SUBTOTAL` that ignores the filter is just `SUM`, which makes the function
pointless in the use it exists for. So it wants the view.

But in dash the filter is **view state**: `store.ts:952` — *"never in the
document, never synced, never undoable by default"*. `cellformula.ts` takes a
DOCUMENT. Wiring the reported hook (`CellSource.hiddenRow`, filled from
`store.order`) makes the formula engine view-aware, and then two collaborators
with different filters compute different numbers for the same cell.

Two things make that less alarming than it sounds, both checked rather than
assumed: a computed value is **never persisted** (`CellOverride.v` is a hand
correction, `f` is what is stored, and the CRDT syncs `f`), so nothing diverges
in the FILE; and Excel behaves the same way — the difference is only that
Excel's filters are shared document state and dash's are not.

**The case that already works needs none of this.** Every imported Excel table
arrived with a dead total because `SUBTOTAL` was not implemented at all; it is
implemented now and goes live through the import gate. An unmarked range means
nothing is hidden, which is correct on an unfiltered sheet and correct for a
freshly imported one. What is open is only `SUBTOTAL` inside a cell formula on a
sheet the reader has filtered.

Left unwired deliberately. The engine half is done and exported (`markHidden`,
`Shaped.__hidden`); what is missing is the decision, not the code.

---

## Status, 2026-08-18

All seven BROKEN and BLOCK findings are fixed and each is pinned by a rig.
**Findings 8–13 (FRICTION) and 14–16 (DELIBERATE DIFFERENCE) are open**, and
the friction tier is where the next pass should start — #12 especially, because
it is a defect in a door rather than in a feature: fifteen import findings
render as bullets through the menu and as one unbroken paragraph through the
drop door, and the drop door is the one people use.

Three of the seven needed a CALLER change in a file the agent fixing them did
not own — per-cell appearance, array spill, and the cross-sheet recalc. In every
case the rig was green while the feature was invisible on screen. That is the
characteristic failure of splitting work by file ownership, and it is now caught
by an explicit check on the call site each time rather than by whoever
remembered to look.
