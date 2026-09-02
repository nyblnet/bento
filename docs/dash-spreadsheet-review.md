# The spreadsheet kind, reviewed as a spreadsheet

What someone who has used Excel, Numbers or Sheets reaches for on a
`kind: 'canvas'` sheet, and what happens when they do.

**What this was measured against.** A `npm run build:single` of commit
`19a82a4` ("dash: the spreadsheet kind opens, and =SUM below the data lands")
with a clean working tree, served from a private copy so nothing could
overwrite it mid-measurement. Every "today" below is an observation from that
build, not a reading of the source, unless it says *code-verified* — which
means I read the branch and could not exercise it through the UI (a download I
could not open, a print I could not trigger).

**Work in flight — read this before acting on §2.1.** While this review was
being written, `dash/src/cellprops.ts`, `dash/src/cellprops.css` and
`scripts/test-dash-cellprops.ts` appeared untracked in the tree, and
`panels.ts` gained a `buildCellProps` call in the spreadsheet arm. That is the
per-cell formatting panel — format kind (general/number/currency/percent/date/
text), decimals, thousands separator, currency symbol, custom pattern, live
preview, bold, align, text colour, background, and a typed-input reader that
keeps leading zeros in a text-formatted cell. Items 2.1 and 1.2 below are
therefore **probably already answered by somebody else's uncommitted work**.
They are still described, because the shipped build does not have them and
because the parts that pass carry over: that panel does *not* add italic,
underline, borders, wrap, merged cells, or a way to read a cell note.

---

## The one-paragraph answer

The engine is better than the surface. Formulas work, including cross-sheet
references, ~90 functions with XLOOKUP/SUMIFS/VLOOKUP, correct cut-versus-copy
reference translation on paste, a real unbounded frontier, sparse storage, a
complete keyboard set and clean per-edit undo. What is missing is almost
entirely *reach*: nothing on a spreadsheet can be formatted, no row can be
inserted, ⌘F finds nothing, six of the eight toolbar buttons throw into the
console and show the user nothing, and every export path either drops the sheet
or exports a different one. Two of those are silent data loss and should be
fixed before anything else on this list.

---

## 1 · Loses or misstates data

### 1.1 Fill down destroys the formula and writes alternating blanks

**Today.** `E4` holds `=B4*C4`. Select `E4:E7`, press ⌘D (or drag the fill
handle — same code path). Measured result:

```
before   E4 {"f":"=B4*C4"}   E5 —   E6 —   E7 —
after    E4 {"v":37.5}       E5 —   E6 {"v":37.5}   E7 —
```

The source formula is **replaced by its last computed value**, and the fill
lands on every *other* row. With a plain constant it is the same: `G4` = 1,
select `G4:G8`, ⌘D → `G4 1, G5 blank, G6 1, G7 blank, G8 1`.

The cause is in `Grid.fillDownSelection` (grid.ts:1349): it seeds
`fillSeries` with the top **two** rows of the selection unconditionally, so a
lone value at the top pairs with the blank beneath it and repeats the pair;
and the seeds come from `valueAt`, which returns the *computed* number for a
formula cell, so the formula never travels.

**Cost.** The highest on this page. This is the second-most-used gesture in a
spreadsheet, it is silent, it hardcodes numbers over live formulas, and the
alternating blanks are easy to miss in a long column. It is destructive in a
way undo will not save you from a week later.

**Format?** Nothing needed. `writeCanvasClip` already translates references
correctly — a copy/paste of `E4` down does the right thing today. Fill should
route through the same translation.

**Files.** `dash/src/grid.ts` (`fillDownSelection`, and the canvas fill-handle
wiring in `wireCanvas`); possibly `dash/src/select.ts` (`fillSeries` seed
contract). **Size:** half a day. Note this bug is in code shared with the
dataset kind and is very likely present there too — I did not measure it there.

### 1.2 A leading zero is destroyed on entry, with no escape hatch

**Today.** Typed or pasted, measured:

| typed | stored | shown |
|---|---|---|
| `007` | `{v: 7}` | `7` |
| `00123` | `{v: 123}` | `123` |
| `0044` | `{v: 44}` | `44` |
| `'007` | `{v: "'007"}` | `'007` |

The apostrophe prefix — the universal "keep this as text" convention — is not
recognised, so it is stored and displayed as a literal character. There is no
per-cell text type to set instead (see 2.1), so **there is no way at all to
enter a zero-padded code**: part numbers, UK phone prefixes, US zips, GL
account codes.

**Cost.** Data loss on typing, immediately visible but unrecoverable without
retyping the whole column somewhere else. Ranked below 1.1 only because it is
visible.

**Format?** Supported: `CanvasCell.format` exists, and `'@'` is the Excel text
mask. This is a `canvasValue` rule plus a format to consult.

**Files.** `dash/src/grid.ts` (`canvasValue`, `canvasCellEdit`), plus the
formatting UI. **Size:** hours, once 2.1 exists. **Probably already done** in
the untracked `cellprops.ts` (`readTypedNumber`, `isTextFormat`, `TEXT_PATTERN
= '@'`).

### 1.3 Export Excel silently drops every spreadsheet sheet

**Today.** *Code-verified.* `exportXlsx` (xlsx.ts:1314) begins
`doc.sheets.filter((s): s is TableSheet => s.kind === 'table')`. A spreadsheet
sheet is not in that list and produces **no finding** — the only
`sheet-skipped` finding fires when there are *no* table sheets at all. I ran
Data ▸ Export Excel from a workbook containing my invoice and got no banner, no
warning, no findings panel.

So: workbook with one dataset and three spreadsheets → a .xlsx with one
worksheet, and nothing said. This is the reverse of the app's stated principle
that a lossy export must name what it flattened.

**Cost.** Data loss on the path people use to hand work to a colleague, with a
plausible-looking file as the evidence. Silent.

**Format?** Not a format question — a spreadsheet sheet maps to an ordinary
xlsx worksheet almost exactly (this is what `docs/dash-sheet-kinds.md` §Export
already argues). `CanvasCell` already carries value, formula, format, bold,
colour, bg, align; `StyleBook` already writes number formats and fills.

**Files.** `dash/src/xlsx.ts` (a `writeCanvasSheet` beside `writeSheet`).
**Size:** two to three days for a good first cut. A one-line finding
("`Invoice` was not exported — spreadsheet sheets are not written yet") is
**one hour** and should land immediately regardless.

### 1.4 Export CSV exports a different sheet than the one on screen

**Today.** *Code-verified* (main.ts:1026): `exportCsv` takes
`store.doc.sheets.find((s) => s.kind === 'table')` — the **first table sheet in
the workbook**, never the sheet you are looking at. On a spreadsheet you get a
CSV of some other sheet's data under your workbook's filename; on a workbook
with no table sheet at all you get a silent no-op.

Already logged in `docs/dash-release.md` §3, but its cost rises on this kind:
there it exports the wrong tab, here it exports a tab you are not on and the
one you *are* on cannot be exported at all.

**Format?** No. CSV of a spreadsheet needs a stated convention — Excel's is
"the used range, values only", and `canvasUsed` already computes the used
range.

**Files.** `dash/src/main.ts` (`exportCsv`). **Size:** an hour for the
wrong-sheet bug; half a day to add the canvas case with a dialog line saying
which range is going.

### 1.5 An imported .xlsx worksheet always becomes a dataset

**Today.** *Code-verified* (xlsx.ts:1080): every imported worksheet is built
`kind: 'table'`. An ordinary Excel worksheet — cell-typed, per-cell formats,
formulas anywhere — is forced through a column model that must guess a type per
column and cannot hold a format per cell. `CellOverride.xlsxF` exists precisely
because import meets formulas the column model cannot place.

**Cost.** Every Excel file anyone brings arrives in the wrong kind, and the
kind that would have held it faithfully is the one this review is about.
Ranked here rather than higher because the loss is visible on arrival.

**Format?** No — both kinds exist. This is a routing decision at import, plus
the honest converse of §1.3.

**Files.** `dash/src/xlsx.ts`. **Size:** two days, and it should wait until
export (1.3) exists so the round trip can be tested as a pair.

---

## 2 · Cannot be done at all

### 2.1 There is no way to format a cell — but the format and the renderer already do it

**Today.** The properties panel on a spreadsheet is one paragraph: *"A
spreadsheet types each cell on its own, so there are no column properties to
set here. Formatting follows the cell."* ⌘B does nothing (measured: `A3` stayed
`{v:"Item"}`). There is no context menu, no format menu, no toolbar affordance.
An invoice reads `12.50 / 4.25 / 99 / 278 / 333.60` — no currency, no aligned
decimals, no bold header row.

**But the format and the paint are both finished.** I committed styled cells
straight into the document and the grid drew every one of them:

- `bold: true`, `bg: '#FFE9B0'`, `color`, `align: 'center'` — all rendered
  (grid.ts:1818–1823, which even carries a comment saying "setting them is a
  later pass").
- `format` masks resolved through `formatValue`: `'£#,##0.00'` → `£12.50`,
  `£99.00`, `£333.60`; `'0.0%'` on `0.5` → `50.0%`; `'0%'` → `50%`.
- The document validated clean afterwards.

So this is **UI-only work**. Nothing about the file format has to change.

**Cost.** "Looks unfinished" for a scratch pad; "cannot be sent to anyone" for
an invoice, a budget or a board pack. Everything a spreadsheet is *for* ends in
somebody reading it.

**Files.** `dash/src/panels.ts` (the spreadsheet arm of `renderProps`), a new
`cellprops.ts`, `dash/src/main.ts` (⌘B and friends), `dash/src/store.ts` (a
`setCanvasCells` style patch that touches style without touching value).
**Size:** two to three days — **and this appears to be in progress right now**
(see the note at the top).

Not covered by that in-flight panel, and still absent afterwards: **italic,
underline, font size/family, per-cell borders, and text wrap**. `CanvasCell` is
open (`[extra: string]: unknown`) so these are additive; borders and wrap need
render work, the rest are one CSS declaration each. Rough: a day for
italic/underline/size, two days for borders done properly (adjacent-cell
resolution is the hard part).

### 2.2 Six of eight toolbar buttons are enabled, do nothing, and throw

**Today.** Every one of these is fully enabled on a spreadsheet, gives the
normal hover treatment, and on click throws `Uncaught Error: grid needs a table
sheet` out of `Grid.sheet` (grid.ts:555) with **nothing shown to the user**.
Measured, one console throw per click, at four distinct call sites:

| button | what happens today |
|---|---|
| Formula | `Uncaught (in promise) grid needs a table sheet`; no dialog |
| Chart | throws; nothing appears |
| 3D | throws; nothing appears |
| Pivot | throws; nothing appears |
| Story ▸ Capture current view | throws; the panel says "Filter, sort and chart the sheet" — a spreadsheet can do none of the three |
| Dashboard | **works, and shows a different sheet's data** — the canvas is replaced by tiles about `Pipeline` while the tab strip, the cell reference box and the properties panel all still say you are on the spreadsheet |
| Import CSV / Excel | **fine as-is** — always adds a new sheet and switches to it; nothing about the current sheet is implied |
| Export CSV / Excel | broken, see §1.3 and §1.4 |

`Grid.sheet`'s own comment says every caller guards the throw in a `try`. Six of
them do not.

**Cost.** Not data loss, but it is the thing the owner noticed first and it is
what makes the kind read as unfinished. A button that is bright, enabled and
inert is worse than one that is greyed with a reason — the app already does the
greyed-with-a-reason thing correctly one control away, in the tab menu:
*"Rename — Only a table sheet can be renamed in this build."*

**What each should do.** The honest answer for most of them is that a
spreadsheet has no typed columns, and chart/pivot/3D/story all need typed
columns. `docs/dash-sheet-kinds.md` already names the bridge that fixes this
and **it does not exist** — I searched: there is no "Make this a dataset", no
range promotion, and no "open a dataset as a spreadsheet". Without it a
spreadsheet is a dead end: no chart, no pivot, no filter, no sort, no
conditional format, no SQL, ever.

- **Chart** — *work differently, and this is the real product question.* "Chart
  a spreadsheet range" should be: select `A3:D6`, click Chart, and dash reads
  the first row as labels and each numeric column as a series — the same rule
  `tableToChart` already uses in slides. Do **not** silently promote to a
  dataset behind their back and do not require it first; a person charting a
  block of numbers has not agreed to a schema. The honest middle is to chart
  the range live and offer "Make this a dataset" in the chart's own panel for
  anyone who wants filters and pivots on it. Until that exists, Chart should be
  **disabled with the reason** "Select a range and make it a dataset to chart
  it" — not silently thrown.
- **Pivot** — *disabled with a reason.* A pivot needs typed columns and a
  grain; promoting first is the correct extra step and the one that makes the
  pivot trustworthy. Say so on the button.
- **3D** — *disabled with a reason*, same argument, plus it needs three numeric
  columns it cannot identify without types.
- **Formula** — *hidden.* It means "add a formula **column**", which does not
  exist on this kind. The cell formula is already the better answer here and it
  is reachable by typing `=`. Leaving a button labelled Formula on the one
  sheet where formulas are per-cell teaches the wrong model.
- **Dashboard** — *work differently.* A dashboard is workbook-scoped, so
  showing it from a spreadsheet is defensible — but it must say whose numbers
  these are at the top, not only in a tile caption, and it should not silently
  replace the sheet you were editing.
- **Story** — *disabled with a reason.* A story step captures a view (filters +
  sorts + chart); a spreadsheet has no view to capture.
- **Import** — *works as-is.* No change.
- **Export CSV / Excel** — *work differently*, per §1.3/§1.4. Both should
  export the sheet you are on, and say what they left behind.

**Files.** `dash/src/main.ts` (button enablement + reasons, driven off
`grid.isCanvas`), `dash/src/grid.ts` (a range-to-series reader for the chart
case), `dash/src/tabs.ts` (the promote command). **Size:** disabling with
reasons and hiding Formula, **one day** and it removes the whole complaint.
Chart-a-range, three days. The promotion bridge, a week.

### 2.3 ⌘F finds nothing on a spreadsheet, and says nothing

**Today.** ⌘F opens the find bar normally — scope pickers, Aa, Whole cell,
Replace and all. Typing `Widget` on a sheet whose `A4` is `Widget` highlights
nothing, reports no count, and throws `grid needs a table sheet` into the
console. `FindUI.targets` (find.ts:751) calls `this.grid.sheet`, which throws
for this kind; `find.ts:761` and `:884` also filter to `kind === 'table'`.

**Cost.** High, and specifically ironic: find.ts's own header explains that a
windowed grid which does not claim ⌘F is a grid that lies. The spreadsheet is
windowed in *both* axes and is unbounded, so it is the kind where the browser's
own find is most useless — and it is the kind where dash's find is broken.
Replace is gone with it, so there is no bulk edit of any sort.

**Format?** No.

**Files.** `dash/src/find.ts` (a `SearchTarget` built from the sparse cell map
— it is a walk over `Object.keys(cells)`, cheaper than the dataset case).
**Size:** one to two days including Replace.

### 2.4 No insert or delete of rows and columns, and no context menu at all

**Today.** Right-clicking a cell on a spreadsheet does nothing — the browser's
own menu appears, the selection does not even move. This is deliberate
(grid.ts:2008 explains that `openCellMenu` is a menu about a dataset and would
crash), but the consequence is that **a row cannot be inserted or deleted at
all**, by any gesture: no menu, no keyboard binding (⌘⇧+ and ⌘− are unbound —
confirmed against the shortcut card), no panel control. Same for columns.

Half the machinery is already written and unused: `Grid.shiftFormulas`
(grid.ts:470) exists precisely to renumber canvas cell formulas across an
insert or delete, with a comment about committing it in the same step as the
structural patch. Nothing calls it for this kind, because `rowcol.ts` is
`TableSheet` throughout.

**Cost.** Very high for real use. "I need another line on this invoice" is the
first thing anyone does, and today the only answer is to select the block below
and move it by cut-and-paste — which does *not* update formulas elsewhere that
pointed into it (`writeClip`'s own comment admits this).

**Format?** No. A canvas insert is a re-key of the sparse map plus
`shiftFormulas`, plus the same shift over `cols` / `rows` size maps.

**Files.** `dash/src/rowcol.ts` (canvas variants), `dash/src/store.ts` (the
patch op), `dash/src/main.ts` (`openCellMenu` for this kind),
`dash/src/select.ts` (the keys). **Size:** three days, and it is the single
largest usability win after §2.1.

While that menu is being built, it is also the natural home for: **clear
contents / clear formats**, **paste special** (values only, formats only — no
form of paste-special exists today), **hide row/column**, and **insert note**.

### 2.5 Dates are inert text — no arithmetic, no formats, no sorting

**Today.** `canvasValue` deliberately stores `2026-01-14` as a string (the
comment says so, and says storing text is the answer that cannot be wrong).
Measured consequences on a spreadsheet:

- `=A18-A19` between two date cells → `#VALUE!`
- `=A18+1` → `#VALUE!`
- `format: 'yyyy-mm-dd'` on a serial `45678` → renders `45678`; `formatValue`
  has no date branch at all (`if (t === 'date') return String(v)`)
- `TEXT()` is not implemented → `#NAME?`, so there is no workaround

`TODAY()` works and returns an ISO string, which cannot then be added to.

**Cost.** "Due date = invoice date + 30" is not expressible. Neither is "days
outstanding", ageing buckets, or a month rollup. For anyone doing invoices,
budgets or plans this is a hard wall, and the wall is invisible until you hit
it.

**Format?** Partly. The *storage* decision (ISO string vs Excel serial) is a
format decision and worth making explicitly — ISO strings are more honest and
diff better; Excel serials are what round-trips. My reading is that ISO strings
plus date-aware arithmetic in `formula.ts` is the right answer and does not
change the format at all; `EDATE`, `EOMONTH`, `DAYS`, `WEEKDAY`, `YEAR/MONTH/
DAY` and `DATE` are already implemented and already speak this shape.

**Files.** `dash/src/formula.ts` (date coercion in the arithmetic operators),
`dash/src/format.ts` (a date branch). **Size:** two days. **Uncertain:** I did
not test what the existing date functions accept, so the coercion may already
be half-present.

### 2.6 Freeze panes: absent, and the model has no place for it

**Today.** A dataset sheet's panel offers Frozen rows and Frozen columns (I can
see both on the Pipeline tab). The spreadsheet panel offers nothing, and
`CanvasSheet` has no field for it — `freezeAt` / `readFrozen` in `rowcol.ts`
are `TableSheet` only. A spreadsheet, being the unbounded kind, is exactly
where a header row scrolls away first.

**Format?** Yes — a small additive one: `CanvasSheet.frozen?: {rows, cols}`.

**Files.** `dash/src/model.ts`, `dash/src/grid.ts` (the canvas paint already
computes `colLefts` and `rowSizes`, so a frozen band is layout not
architecture), `dash/src/panels.ts`. **Size:** two days.

### 2.7 Merged cells: absent, and the model cannot express one

**Today.** Nothing in the model mentions merging; `docs/dash-sheet-kinds.md`
explicitly puts it out of scope for the first cut, which was the right call.

**Cost.** Low for correctness, real for presentation — a title across `A1:D1`
is the first thing on every invoice ever made, and today it simply spills.

**Format?** **Yes, a real format decision** — a merge is a range that behaves
as one cell, and it touches selection, navigation, paint, formulas, copy/paste
and xlsx. `CanvasSheet.merges?: string[]` (A1 ranges) is the cheap shape.

**Size:** a week done properly. Worth deferring; worth deciding the field name
now so it does not arrive as an escape hatch later (PLATFORM §3).

### 2.8 Conditional formatting cannot reach a spreadsheet

**Today.** Rules live at `sheet.condfmt[colId]` (grid.ts:869) — keyed by column
id. A spreadsheet has no columns, so the whole feature is inapplicable, and
there is no UI entry point.

**Format?** **Yes.** A spreadsheet needs range-keyed rules, e.g.
`CanvasSheet.condfmt?: Array<{ range: string; rule: Rule }>`. `condfmt.ts`'s
evaluation (`evaluateRules`, `colorScale`, data bars, top-N, duplicates) is
already pure over a value vector and would be reused unchanged.

**Files.** `dash/src/model.ts`, `dash/src/grid.ts`, a UI. **Size:** three days
once the cell panel (2.1) exists to hang it off.

### 2.9 Data validation and named ranges do not exist anywhere in dash

**Today.** I searched the whole of `dash/src`: no data-validation concept (the
`validate.ts` in the tree is *document* validation — findings about a corrupt
file, not a rule on a cell), and no named ranges. `a1.ts` lexes qualified names
like `Sheet1!A1` and `Table1[Col]` but there is no name table.

**Cost.** Moderate. Validation is what stops a shared budget filling with
"n/a"; named ranges are what makes a model readable (`=Revenue-Costs`). Neither
is a first-week item, but both are format additions and so worth naming early.

**Format?** Yes, both. `CanvasSheet.validations?` (range → rule) and
`DashDoc.names?: Record<string, string>` are the obvious shapes; the second is
workbook-scoped and would serve the dataset kind too.

**Size:** three days each.

### 2.10 A cell note is a stripe you cannot read or write

**Today.** `CanvasCell.note` renders as `dg-noted` → a 2px accent stripe down
the cell's left edge (styles.css:830). There is **no `title` attribute, no
hover, no popover, and no way to enter one**. I set a note through the document
API and got the stripe with no way to read the text back.

Separately, the **comments** feature refuses this kind honestly: the 💬 panel
says *"No table sheet is open."* — which is at least a refusal, though it names
a wire word and denies that the sheet you are looking at is open.

**Cost.** Low today (nobody can create one), but it will become
misinformation the moment an imported .xlsx brings comments in.

**Files.** `dash/src/grid.ts` (a `title`, two lines, ship it now),
`dash/src/comments.ts` (canvas anchors keyed by A1 rather than rid). **Size:**
ten minutes for the tooltip; two days for real threads.

### 2.11 No point-and-click reference building

**Today.** Measured: press `=` in `F13`, then click `D4` to pick up the
reference. The edit **commits**, `F13` is stored as `{v: "="}` — a text value,
not even a formula — and the selection moves to `D4`.

There is also no function autocomplete, and no highlight of the cells a formula
being edited refers to.

**Cost.** High, and easy to underrate. Most people do not type `B4*C4`; they
type `=`, click, type `*`, click. Without it, the 90-function library is
reachable only by someone who already knows A1 notation, and dash's own
shortcut card has to teach `=` as a keystroke because there is no other door.

**Format?** No.

**Files.** `dash/src/grid.ts` (`editCanvas` — while an edit is open, a click on
a cell inserts its reference instead of moving the cursor; a drag inserts a
range). **Size:** two days, three with the referenced-range highlight.

### 2.12 No sort, no filter, no hide, no grouping

**Today.** `canvasHeader` (grid.ts:1854) emits a letter and a resize grip and
nothing else — measured DOM confirms: no caret, no menu. Its comment says so
plainly ("a spreadsheet's columns are not typed and cannot be"). There is no
row/column hide and no outline grouping on either kind.

**Cost.** Moderate. Sorting a block of rows is a normal spreadsheet act and
does not need column types — Excel sorts a selected range by a chosen column
without knowing what anything is. The typed-column argument justifies leaving
*filter* out; it does not justify leaving *sort* out.

**Format?** No — a range sort rewrites cells in place.

**Files.** `dash/src/grid.ts`, plus the context menu of §2.4. **Size:** two
days for sort-a-range, and it should be a menu item, not a header caret.

### 2.13 No print, no PDF, no page setup

**Today.** *Code-verified*: `grep '@media print\|@page'` across `dash/src/*.css`
returns nothing. Already in `docs/dash-release.md` §2 for the app as a whole.
For a spreadsheet the specific need is repeated header rows, page breaks, and a
print area — and the print area matters more here than on a dataset, because
the sheet is unbounded and "print everything" has no meaning.

**Format?** A print area would be a small addition
(`CanvasSheet.printArea?: string`), the rest is CSS and a page builder.

**Size:** a week, shared with the dataset kind.

### 2.14 A spreadsheet sheet cannot be renamed

**Today.** Tab menu ▸ Rename is disabled, with the reason shown: *"Only a table
sheet can be renamed in this build."* `applySheetProps` narrows through
`table(doc, id)` and throws otherwise. Duplicate, Move left/right and Delete
all work.

**Cost.** Low in isolation, high in aggregate — every spreadsheet in a workbook
is called "Spreadsheet". Cheap to fix and it is the last of the
kind-discrimination bugs.

**Files.** `dash/src/store.ts` (`applySheetProps`), `dash/src/tabs.ts`.
**Size:** an hour or two. Already logged in `docs/dash-release.md` §3.

---

## 3 · Takes more steps than it should, or reads as unfinished

- **The help card tells two lies on this kind.** The "Good to know" panel says
  *"Right-click a cell for rows, columns, fill and conditional formatting"* and
  *"a column header's caret to sort or filter"*. Neither exists on a
  spreadsheet. `dash/src/help.ts`, one hour.
- **The kind chooser truncates its own explanation.** Measured: `+` ▸ menu is
  220px wide, `.dx-tab-menu-title` and `.dx-tab-menu-why` are both inline on
  one line, and the "why" needs 322px — so the one place the two kinds are
  explained renders as `SpreadsheetTyped cells — for a scr`. The Save menu one
  control away gets this right with `<span>` + `<small>` on two lines.
  `dash/src/tabs.css`, ten minutes.
- **The fill handle's tooltip promises something it does not do.** It reads
  *"Drag to fill the selection down or across"*; the canvas handler
  (`wireCanvas`) only ever extends rows, and there is no fill-right (⌘R is
  unbound). Either implement across or change the string.
- **`#,##0` shows two decimals.** `readPattern` (format.ts:49) only reads a
  decimal count from an explicit `.0` group, so a mask asking for whole numbers
  falls through to the type default: measured `1234567.891` with `#,##0` →
  `1,234,567.89`. Half a day.
- **Negative currency renders `£-1,234.50`**, where every spreadsheet writes
  `-£1,234.50`. Ten minutes.
- **A cross-sheet reference loses the source's format.** `=Pipeline!D2` shows
  `8200` where the source column shows `£8,200.00`. Arguably correct (a
  reference carries a value, not a format) — Excel agrees. Noting it because it
  will be reported as a bug.
- **`TRUE` displays as `✓`.** Consistent with the dataset kind's boolean
  column, surprising on a spreadsheet where the user typed the word. Worth a
  decision, not a fix.
- **`=` alone is stored as the text `"="`.** Harmless, and a symptom of 2.11.

---

## 4 · Genuinely fine, and one thing dash does better

These do not need work and should not be padded onto a backlog.

- **The keyboard set is complete and good.** Arrows, ⌘arrows to the edge of the
  block, PgUp/PgDn, Home/End, ⌘Home/⌘End, every shift-extension, ⌘Space /
  ⇧Space for column and row, ⌘A, F2, Enter/⇧Enter, Tab/⇧Tab with block-aware
  wrap, ⌘D and ⌘Enter, Del, Esc, ⌘C/X/V, ⌘Z/⌘Y, ⌘S, ⌘PgUp/PgDn between sheets.
  This is better than most web spreadsheets ship with.
- **Undo granularity is right.** Measured: a cell edit is one entry (keystrokes
  within one cell coalesce via `runEdit`/`endRun`), a paste is one entry, a
  resize is one entry, and redo restores exactly. No complaints.
- **The status bar aggregate works on this kind.** Selecting `D4:D6` gives
  `Sum 278 · Avg 92.67 · Count 3 · Cells 3`, and it is capped so ⌘A on an
  unbounded sheet cannot freeze the tab.
- **Copy/paste of formulas is correct, including the hard part.** A copied
  formula's references translate; a **cut** formula's do not. Excel's rule,
  easy to get backwards, got right. (The documented gap — formulas elsewhere
  that pointed at cut cells do not follow them — is real but rarer.)
- **`fillSeries` itself is good** where it is reached: ISO dates step by day,
  months clamp correctly (31 Jan + 1 month = 28 Feb), `Q1`→`Q2`, trailing
  numbers increment, and a lone number sensibly repeats rather than counting.
  It is the *caller* that is broken (§1.1), not this.
- **Row height and column width drag live and commit once**, keyed by letter
  and 1-based number so the JSON reads like an address. Stored sparsely.
- **The unbounded frontier is exactly right**, and it is the thing that fixes
  the complaint in `docs/dash-release.md` §2: rows past the data are real,
  selectable and typeable, `=SUM(D4:D6)` below a block works, and the file
  stays sparse (measured: my whole invoice was a 2.7 KB document, and clearing
  never-written cells writes nothing).
- **The document validator passes** on a spreadsheet with formulas, formats and
  styles.
- **Cross-sheet references work** (`=Pipeline!D2` → `8200`), which
  `docs/dash-sheet-kinds.md` correctly called a requirement of the kind rather
  than a later nicety.
- **The function library is strong**: ~90 functions including `XLOOKUP`,
  `VLOOKUP`, `INDEX`, `MATCH`, `SUMIFS`, `COUNTIFS`, `MINIFS`, `IRR`, `NPV`,
  `PMT`, `PERCENTILE`, `CORREL`. Verified live: `VLOOKUP` → `42.50`, `SUMIF` →
  `80`, `COUNTIF` → `1`, `TODAY()` → `2026-08-14`, `=D8/0` → `#DIV/0!`.

**Better than Excel:** the tab menu's *refusal* pattern — a disabled Rename
that says **why** it is disabled — is better than Excel's greyed-out silence,
and it is the model the toolbar in §2.2 should copy verbatim. Also
`fillSeries`'s deliberate asymmetry (a lone number repeats, a lone date counts)
is documented reasoning that Excel has but never explains.

---

## Suggested order

1. **§1.1 fill down** — silent, destructive, half a day.
2. **§1.3 / §1.4 export findings** — an hour each to stop the silence, even
   before the real export exists.
3. **§2.2 toolbar** — one day to disable-with-reasons and hide Formula. This is
   the complaint that prompted the review and it is the cheapest thing here.
4. **§2.1 cell formatting** — appears to be in flight; check before starting.
5. **§2.4 insert/delete rows and columns + a context menu** — three days, and
   the largest remaining usability win.
6. **§2.3 find and replace** — one to two days.
7. **§2.11 point-and-click references** — two days; it is what makes the
   formula engine reachable.
8. **§1.3 real xlsx export of a spreadsheet sheet** — the first thing that
   makes the kind shareable.

Everything below that (dates, freeze, sort-a-range, conditional formats, print,
merges, validation, named ranges) is a real backlog rather than a defect list,
and the format decisions among them — merges, range-keyed conditional formats,
validations, named ranges, a print area — are worth naming in
`docs/DECISIONS.md` before any of them is built, so the field names are not
chosen twice.

---

## What I could not verify, stated as uncertain

- **§1.3 export** is code-verified only: I clicked Data ▸ Export Excel and saw
  no warning, but I could not open the resulting file to confirm the sheet is
  absent. The filter at `xlsx.ts:1314` is unambiguous; the *absence of a
  finding* is what I am inferring.
- **§2.13 print** is code-verified only (no `@media print` rules exist); I did
  not trigger a print preview.
- **§1.1** almost certainly affects the **dataset** kind too, since
  `fillDownSelection` is shared. I did not measure it there.
- **§2.5 dates**: I tested arithmetic and formatting, not the existing date
  functions' input tolerance, so the coercion work may be smaller than stated.
- Everything in this document describes **commit `19a82a4`**. Three other
  agents were editing this tree while it was written, and at least one of them
  is building the cell-properties panel. Re-check §2.1 and §1.2 against the
  tree before acting on them.
