# One grid, tables inside it

Direction set by the maintainer, 2026-10-20: **dash replaces Excel, and better,
and does everything Airtable does, and better.** This document is the shape
that makes that one product rather than two. It refines
`docs/dash-sheet-kinds.md` (2026-08-11); read that first.

## What changes, and what does not

The 2026-08-11 decision got the storage right and the surface wrong.

- **Kept:** two storage kinds. A `canvas` sheet is sparse and typed by cell. A
  `table` is columnar and typed by column, and earns column formulas, type
  refusal on import, 100k-row speed, chart and pivot binding. Neither is a
  lesser version of the other, and nothing here merges their storage.
- **Changed:** a user no longer chooses between them before typing. Today the
  first `＋` asks "Dataset or Spreadsheet?", and most tools work on only one.
  From now on **every sheet is a grid, and a table is an object that lives in
  the grid**: the model Excel ("Format as table") and Numbers already teach.
  The bridge the old design called "the actual product" stops being a
  conversion between sheets and becomes something done in place: select a
  range, make it a table, and it stays where it was.

## Format: all additive

### A table can sit on a grid

```ts
interface TableSheet {
  // …everything it has today, unchanged…
  /** Where this table sits. Absent = it fills its own sheet (every file today). */
  placed?: { on: string /* canvas sheet id */; r: number; c: number /* 0-based anchor of the header row */ }
}
```

- **Absent `placed`**: the table renders as its own sheet, anchored at A1.
  That is what every existing Dataset is, so **no migration**: an old Dataset
  is a sheet holding one table.
- **Present**: the table is not a tab. It renders inside the host grid with its
  header row at `(r, c)`, then its rows, then its totals row when it has one.
  The rectangle's width is its visible columns and its height is
  header + rows + totals.
- `name` is the table's name. It is unique in the workbook, identifier-safe,
  and is what structured references use.
- **Old builds** keep `placed` (parseDoc spreads unknown fields; verified in
  `parseDoc`) and show the table as its own tab, as they show any table. No
  data is lost; the host grid shows an empty hole where the table sits. That
  is acceptable degradation, and the first PR proves it with the last released
  shell.
- **Collab:** `placed` is one flat last-writer-wins register on the sheet node.
  A move is one write.

### Collisions and growth

- Canvas cells under a placed table's rectangle are **kept but hidden**, never
  deleted. Moving the table away shows them again.
- When a table grows (a row is appended or inserted, or the totals row is
  turned on), canvas cells **in the table's column span** below it shift
  down. This matches Excel's table-row insert. Cells outside the span don't
  move.
- Placing or moving a table onto non-empty cells asks first (as Excel does),
  then hides them as above.
- Two tables may not overlap. A move that would overlap is refused and says
  why.

### References: one formula language

- `A1` refs keep working everywhere. An `A1` ref into a placed table's
  rectangle resolves to the table cell at that position **in stored row
  order**. A view sort or filter never changes what `A1` means, but a real sort
  (Data ▸ Sort, which reorders rows) does, exactly as in Excel.
- Structured refs, in Excel's syntax, are the preferred way in:
  - `Sales[Amount]` for a whole column;
  - `Sales[@Amount]` for this row's value, inside a table;
  - `Sales[#Totals]` and `Sales[[#Totals],[Amount]]` for the totals row;
  - `Sales[#All]` for the whole table.
  `a1.ts` already lexes `Table[Col]`.
- **Point mode** writes a structured ref when you click inside a table and an
  `A1` ref outside one, as Excel does.
- A table **column formula** stays one expression per column. Its existing bare
  column names (`Value * Probability`) are kept. Xlsx export writes them as
  `calculatedColumnFormula` with `[@…]` refs, so they round-trip natively.

### The Airtable layer: field kinds beside a base type

A column gains an optional `kind` and keeps a base `type` that every build
knows. An older build reads the column as that base type. Only a build that
knows `kind` gives it the new meaning.

This was measured. A draft that added these as new `type`s stopped a build
from the day before from opening the file at all: its header looked the type
up in a label table, got `undefined`, and boot failed. With `kind` beside a
base type, the same old build opens the workbook, shows a link as text and a
rollup as a number, and saves everything back unchanged.

| kind | base type | cell value | notes |
|---|---|---|---|
| `link` | text | array of rids in `to` | `to: tableId`. ONE side is stored. The mirror on the target (`inverseOf: {table, col}`) stores nothing and is derived on every read; editing it writes the owner. Two stored sides could diverge under collab, one cannot. |
| `lookup` | text | derived | `via` (a link column here) + `field` (a column there) |
| `rollup` | number | derived | `via` + `field` + `agg`: sum, avg, min, max, count, counta, concat, and, or |
| `multi` | text | array of option strings | `options` lists the choices |
| `attachment` | text | array of asset keys | the bytes live in `assets`/`blobs`, as images do today |
| `url`, `email`, `phone` | text | string | validated, rendered as links |
| `rating` | number | 0..max | `max` on the column |
| `duration` | number | seconds | formatted h:mm:ss |

- **List-valued cells use the existing `raw` encoding**, with an array as the
  cell value. An unknown *encoding* would break old builds' length and read
  paths. A raw array is JSON, and an old build renders it as comma-joined
  text and round-trips it unchanged.
- **Lookups and rollups are field kinds with settings**, as in Airtable, not
  formula functions. `LOOKUP` is already an Excel function, and overloading
  it would break Excel parity.
- **Collab:** a list cell is one last-writer-wins value, so two people adding
  different links to the same cell at the same moment keep one. That's
  documented, and it's the same compromise as slides' table rows.

### Views per table

```ts
interface TableView {
  id: string; name: string
  kind: 'grid' | 'kanban' | 'gallery' | 'calendar' | 'form' | (string & {})
  filter?: StoredFilter[]; sort?: SortKey[]; group?: string[]
  hidden?: string[]          // column ids
  by?: string                // kanban: the enum/multi column; calendar: the date column
  cover?: string             // gallery: the attachment column
}
interface TableSheet { tableViews?: TableView[]; view?: string /* active */ }
```

- These are not `doc.views`, which are dashboards and keep their name.
- **Grid** view = the table as it renders today, plus a saved filter, sort,
  group and hidden columns.
- **Kanban, gallery and calendar** are projections of the same rows. Dragging a
  card writes the `by` column.
- **Record card:** opening any row from any view shows Airtable's expanded
  record (every field, linked records, comments), as a panel.
- **Form** view: an editor fills it in place. Submissions from people who are
  not editors need a channel. The share zone's publish link and the relay's
  signed writes are the candidates, so that part is designed with share, and
  ships last.

## What the user sees

- `＋` adds **a sheet** (a grid). **Insert ▸ Table** (⌘T, as in Excel) makes the
  selection a table, or makes a new empty one. "Make this a dataset" becomes
  "Format as table". "Open as a spreadsheet" becomes "Convert to range",
  which keeps the values and drops the table.
- Data tools work on both:
  - Sort and Filter on a plain range act as Excel's AutoFilter: sort moves
    the data, and filter hides rows.
  - Pivot, Chart and Story bind to a table or to a range. A range is treated
    as an ad-hoc table and offers "Format as table".
- Xlsx import lands every worksheet as a grid and every Excel table
  (ListObject) as a placed table. Export writes grids as worksheets and tables
  as ListObjects with calculated columns, so nothing is dropped.

## Build order

Each item is PR-sized and guarded by a rig that fails on the old code.

1. **Already running:** the review's blockers. These are entry parsing, grid
   gestures and point mode, the properties panel, chrome and phone parity,
   pivot and chart editors, and boot and first-run fixes.
2. **The grid holds tables:**
   - `placed` in the model, with parse and the old-shell round-trip rig;
   - rendering placed tables inside a grid;
   - Format as table / Convert to range;
   - growth and collisions;
   - `A1` and structured refs, and point mode into tables;
   - the `＋`/tab simplification;
   - sync of `placed` with a convergence row;
   - xlsx import/export of grids + ListObjects;
   - sort and filter on ranges.
3. **The Airtable layer:**
   - list cells, and the old-shell round-trip rig;
   - `link` with its derived inverse;
   - lookup and rollup;
   - multi, attachment, url/email/phone, rating, duration;
   - saved grid views;
   - the record card;
   - kanban, gallery, calendar.
4. **Forms**, designed with the share zone.
5. **First run:** a starter workbook that teaches the whole model (a grid
   with a placed table, a linked table, a kanban view, a pivot and a
   dashboard), as slides' showcase deck and spaces' welcome page do.
