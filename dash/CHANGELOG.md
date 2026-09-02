# Changelog

All notable changes to **bento/dash**. The app version is baked into every
shell as `APP_VERSION` (from `dash/package.json`) and checked against the
signed release manifest; a shipped file updates itself through that channel.

The format (`bento/dash`, version `1`) is additive and stable — every version
below opens files from every earlier version, and unknown fields are preserved.
There is no server, so a break here would be permanent.

## [0.3.0] — unreleased

The release that came out of watching somebody use 0.2.0.

- **Sheet tabs along the bottom**, where every spreadsheet has kept them since
  Excel 5. They were a list inside the left panel; that panel is gone, and the
  grid is about 200px wider at every window size. Drag to reorder — and because
  sheet order is part of the document, one undo puts a dragged tab back where it
  was rather than at the end.

- **The totals row is a control.** It used to display `SUM` and `AVG` while the
  only way to set one was a dropdown in the properties panel, one column at a
  time — a readout with no way in. Click the cell and choose. Making it
  reachable immediately surfaced two things nobody could see before: `count`
  was borrowing the column's money format and reading `count £8.00`, and a
  custom-formula total rendered as `[object Object]`.

- **Totals, the chart and the status bar now agree with the grid.** Filter a
  column and every one of them follows. Before this they disagreed: four rows
  worth £69,050 sat under a footer reading £97,050, beside a chart still drawing
  a bar for two of the rows the filter had removed. This is the same rule
  Excel's own tables use — a table's totals row is `SUBTOTAL`, which ignores
  hidden rows.

- **The chart stays with the sheet it was made from.** Switching sheets used to
  leave it painting the sheet you had left, and the next edit blanked it to an
  empty axis with no explanation. It now names its sheet and offers to follow.

- **Find** — ⌘F. The grid only ever holds about forty rows in the page at once,
  so the browser's own find reports values that are plainly in your file as not
  there. This one searches the file, scrolls to the match and selects it. It
  searches what the filter leaves showing, so it will never jump to a row you
  have hidden. Replace refuses computed columns and formulas, and counts every
  refusal out loud.

- **Saving tells you what happened.** Every outcome now says so — including the
  one that matters: on a browser without in-place file writing (Firefox,
  Safari, iOS) a save is a *download*, and the file you have open is left
  untouched. Same keystroke, completely different outcome, and previously
  nothing distinguished them. The first save of a new workbook also used to
  leave the unsaved dot lit after writing the file.

- **Formulas are written in a dialog**, not a browser prompt. Native prompts do
  not exist in embedded webviews, sandboxed frames, or a tab where you have
  blocked extra dialogs — the Formula button was simply dead in all of them. The
  replacement lists the columns you can name and checks the expression as you
  type.

- **Redo has a button.** The shortcut always worked; a mouse user who over-undid
  had no way back.

- **Eight interface languages** — English, 日本語, 简体中文, 繁體中文, Español,
  Français, Italiano, Deutsch. Numbers follow the language you pick, so a
  workbook formatted `#,##0.00` reads 1,234.50 in London and 1.234,50 in Berlin
  from the same bytes. The language never enters the file.

- **Opens in about a tenth of the time** — measured 952ms to 93ms on the starter
  workbook. And a file that did not finish downloading now says so, in a message
  that needs no JavaScript, because a truncated file cannot run any.

- **A crash no longer loses the work.** Recovery snapshots were being written
  and never read back. If this browser cannot keep a local backup at all — some
  private-browsing modes — it now says so rather than implying a safety net.

- **Read-only workbooks refuse writes.** An `.xlsx` import could previously add
  sheets to a workbook the format version had declared unwritable.

- Comment threads on cells that survive sorting and say so when their row is
  deleted; a validator that reports damage rather than refusing to open;
  drag-and-drop to open a file, which used to navigate away from your workbook
  and take unsaved edits with it; a `?` shortcut card generated from the key map
  itself; and ⇧Space selects the row, which had never worked.

## [0.2.0] — 2026-08-03

First release. A workbook is one self-contained HTML file: the data, the grid,
the formulas and the charts, opening from `file://` with no backend.

- **One formula for a whole column.** A spreadsheet stores an expression per
  cell, so a 100,000-row model with twelve computed columns carries 1.2 million
  of them, each with range references that shift when you insert a row. Here it
  is twelve strings. `#REF!` and the shifted-VLOOKUP cannot happen, because
  there is no range to shift. About fifty functions, including `SUMIF`,
  `COUNTIF` and aggregates you can mix into a row expression —
  `Value / SUM(Value)` is a share-of-total column.

- **Errors stay visible.** A division by zero reads `#DIV/0!`, a circular
  reference reads `#CYCLE!`, and neither is quietly a zero — a total containing
  silent zeros is wrong and looks right.

- **Charts are bound to columns, never to a copy of the numbers.** Edit a cell
  and the chart moves; nothing in the file can disagree with the table beside
  it. A category with no data is drawn as a gap rather than as zero, because
  "we sold nothing" and "we do not know" are different claims.

- **Import the CSV somebody emailed you, and see what it decided.** Comma,
  semicolon or tab, quoted fields with commas and newlines inside them, a BOM,
  CRLF, ragged rows. Column types are inferred from the whole column and shown
  in the header, where one click changes them.

- **It refuses to guess a date order.** `03/04/2026` is 3 April or 4 March, and
  a column where every day is 12 or under cannot be decided from the data.
  Excel and every CSV library guess from your machine's locale, which moves
  dates by up to eleven months without saying so. This says so, imports the
  column as text, and waits for you.

- **The decimal comma is read per column, not per cell.** `1.234` is 1234 in
  Germany and 1.234 in Britain; deciding cell by cell reads half a column each
  way and the total is then wrong by a factor of a thousand.

- **Undo costs what the edit costs.** History is a log of typed inverses rather
  than copies of the workbook, so a ten-thousand-cell paste is one entry of ten
  thousand values. On a large sheet a snapshot costs 10 ms per keystroke; this
  costs bytes.

- **Sorting does not change your file.** It sorts a view, so clicking a column
  header leaves the document untouched and the file unmodified.

- **A file that cannot be read is never overwritten.** If the document block is
  damaged, or belongs to another Bento app, the workbook refuses to open,
  explains what it found, and offers the original bytes back — rather than
  showing an empty grid over your data and saving it.
