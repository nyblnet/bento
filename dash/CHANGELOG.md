# Changelog

All notable changes to **bento/dash**. The app version is baked into every
shell as `APP_VERSION` (from `dash/package.json`) and checked against the
signed release manifest; a shipped file updates itself through that channel.

The format (`bento/dash`, version `1`) is additive and stable — every version
below opens files from every earlier version, and unknown fields are preserved.
There is no server, so a break here would be permanent.

**dash has not been released.** No version below has been published on
bento.page; the versions are tagged development milestones, and the README's
status is the authority. The first published version will say so here.

## [0.3.0] — unreleased

The version that came out of watching somebody use 0.2.0.

- **Pivot tables have a field editor, and open like any sheet.** Click a
  pivot's tab and it shows where the grid was, with its fields in the
  properties panel: drag a column (or pick it) into Rows, Columns, Values or
  Filters, choose Sum, Average, Count, Min, Max, Median or Distinct for each
  value, tick which values a filter keeps, and switch subtotals, grand totals
  and (blank) groups. Values print in their column's format, so money stays
  £. The pivot tab used to say "open it from ＋ Pivot" and the Grand total
  column was cut off at the edge of a side panel.
- **Chart charts what you selected, and has an editor.** Select the columns
  first: the numbers become the series and the first text column the
  categories (it used to chart the first three numeric columns whatever was
  selected). Click the chart, or its Edit button, and the properties panel
  edits it: type, title, categories, how rows are summed, legend, and a series
  list with a colour each. The value axis wears the column's format (£, %).
  A line through categories with no order (Region) is drawn as bars and says
  why; "Draw a line anyway" draws it.
- **3D is off the toolbar.** It is a developer tool for now; a story step that
  already holds a 3D view still plays it.
- **The column filter lists values the way the column shows them** — £4,300,
  not 4300 — and a search for "4,300" finds it.
- **Typing into a spreadsheet cell reads what you meant, and sums add up.**
  `15%` is stored as 0.15 and shown as 15%; `$5`, `£1,234` and `€3,50` are
  numbers that keep their currency symbol; `(5)` is −5; `2026-03-04` and
  `Mar 4 2026` are dates. `3/4/2026` still stays as text, because it could be
  either day. Pasting text into a spreadsheet reads it the same way. Before,
  all of these were stored as text, and formulas then read the text `15%` as
  15: a SUM over 10, $5 and 15% said 30 instead of 15.15. Formulas now treat
  text as Excel does. A range in SUM, AVERAGE or COUNT skips text, arithmetic
  on text that is not a number gives #VALUE!, and `=10*15%` is 1.5. `SUM(1, 2, 3)`
  now adds every argument; it used to stop at the first one.
- **The formula bar shows what you typed.** A cell reading 100% shows `100%`,
  not `1`, and a currency cell shows `$300.50`.
- **A formula with a mistake in it is not entered.** `=A11+` used to go in and
  show #VALUE!. Now the cell stays open, the problem is shown under it, and Esc
  cancels. The formula bar does the same.
- **CSV export no longer lets a cell run as a formula.** Text starting with `=`, `+`, `-`, `@`, a tab or a return is written with a leading `'`, so opening the CSV in Excel or Sheets shows it as text.
- **Neutral title while sealed, matching the saved file's title.**
- **A sealed workbook deletes this browser's earlier plaintext recovery copy and version history of itself** on open; other workbooks' copies are untouched.

- **Password-protected workbooks open again.** The file showed its password
  prompt and then failed with "This file could not start" over it, because the
  file's loader took the prompt for an app that had not started. Dash now tells
  the loader it is waiting for a password, and the same for a file it cannot
  open.

- **Every field looks the same, in light and dark.** Text fields, selects,
  text areas and colour wells across dash share one look: the same border,
  fill, corners and height, and the same focus ring. It matches slides. Before,
  each panel and dialog styled its own fields, so they drifted apart. The
  formula bar, tab rename and story captions were boxless until hovered, and
  are now ordinary fields.

- **Save a copy keeps you on the original.** The copy is written and you go
  on editing the file you opened: ⌘S, the automatic save and the unsaved dot
  all stay with the original, and the message says so. Before, the copy quietly
  became the file you were editing.

- **A recovered copy that looks older than the file says so.** When the copy
  kept in this browser predates the file you opened, the banner warns you and
  makes "Keep the file" the default, with "Restore anyway" beside it. It is
  still offered, because two devices' clocks can disagree, and keeping the file
  does not delete the copy.

- **When crash recovery is off for a large workbook, dash tells you.** If the
  workbook is too large to keep a backup copy, a message says so once and asks
  you to save often, instead of the message about a browser that keeps no
  backups.

- **Portuguese.** dash's interface is available in Portuguese, the eighth
  language beside English, Japanese, Simplified and Traditional Chinese,
  Spanish, French, German and Italian. The translation rig now finds the
  languages from the catalogs on disk instead of a fixed list, so it can no
  longer report a set complete while a language it was never told about is
  missing strings. The type label in a column header now stops short of the
  column letter, which longer type names in Italian and Portuguese used to
  overlap.

- **Renaming a sheet renames it everywhere.** `=SUM(Pipeline!D1:D8)` names the
  sheet by name, and renaming the tab used to leave it pointing at a sheet that
  no longer existed — the starter workbook's own cross-sheet totals read
  `#REF!` after the first rename. Now every formula, column expression and
  defined name that named the sheet is respelled in the same edit, and one undo
  takes the name and the formulas back together.

- **Inserting or deleting rows moves the other sheets' references too.** A row
  added inside Pipeline now widens `Pipeline!D1:D8` on Scratch to `D1:D9`,
  exactly as it already moved Pipeline's own formulas; before, the range stayed
  put and the total quietly summed eight of nine deals. A reference to a deleted
  row becomes `#REF!` on every sheet, never the row that slid into its place.

- **Enter after a Tab run comes home.** Type Widget⇥12⇥4.50⏎ and the cursor
  lands on the next row's first column, not diagonally two columns over. The
  selection model already knew how; the editor's commit never asked it, and a
  document change mid-run forgot the run. A new rig drives the real editor.

- **A word in a number column is marked, not hidden.** A dataset column typed
  Number used to accept "hello" and say nothing; the total silently left it out
  and a formula reading it gave `#VALUE!`. The cell now wears the same ring a
  validation failure wears, with the reason on hover, and the column header
  counts it.

- **The formula bar follows a paste and a right-click.** Both moved the cursor
  without re-reading the cell, so the bar described the value from before.

- **Restoring unsaved changes or an old version keeps this workbook's own
  sharing room, keys and identity.** A restore brings back the CONTENT of a
  snapshot; the snapshot's copies of the docId, the room and its keys, and the
  read-only and template flags are now ignored, the same way slides' restore
  gate treats them. Snapshots share one browser store on file://, so any page
  opened there could have filed one under this workbook's id, and Restore
  would have moved the workbook into that page's room.
- **Stopping sharing or rotating its keys now marks the workbook unsaved.**
  Rotating the keys is how you cut off everyone you sent a copy to, and it only
  takes effect once the file holds the new keys. It used to change the workbook
  without lighting the unsaved dot, so closing the window threw the rotation
  away with no warning and no automatic save. Turning sharing back on after
  stopping it does the same.

- **A live-show audience copy no longer presents itself as an editor.** Its
  role was checked as "anything but reader", so it offered its show ticket to
  the relay as write access and appeared as an Editor to everyone else. Only a
  writer copy now does either.

- **An edit made while a save is writing is no longer marked saved.** Every
  save — ⌘S, the automatic save to the file, Save a copy, Save as new workbook
  and the in-place update — now goes through one queue that writes a snapshot
  and clears the unsaved dot only if nothing changed while it was writing.
  Before, the dot went out when the write finished, so a keystroke made in that
  second was missing from the file and nothing said so.

- **Dropping a workbook onto the window can no longer write the old one into
  it.** An automatic save that was mid-write when the file was dropped used to
  finish into the NEW file's handle. The swap now waits for it.

- **After "Update this file", this window stops saving to it.** The page is
  still the old version, and its next automatic save would have put the old
  version back. ⌘S now says to reload first.

- **Save a copy clears the unsaved dot** when the copy holds everything — it is
  the file you carry on working in — and a failed copy says so instead of
  failing silently.

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

- **Dark theme works the way it does in every other Bento app.** Dash was
  themed through a mechanism of its own — the only one of the four apps that
  was — and it meant a stylesheet shared across the suite could not have
  themed dash at all. The palette is unchanged, light and dark, value for
  value; the switch underneath it is now the shared one. An existing theme
  preference carries over. Controls (buttons, inputs, chips) take the shared
  10px radius rather than dash's 7px, so a button looks the same here as in
  slides, spaces and type.
- **A value too wide for its column can be read by hovering it.** Cells clip
  with an ellipsis, and until now the rest of the value was simply gone — the
  only way to recover it was to click the cell and read the formula bar, once
  per cell, down a column you were trying to scan. Hovering now shows the whole
  value.

  Only where it is actually needed: whether a cell clips depends on the
  rendered glyphs, the column width and the font the reader got, so it is
  measured on hover rather than guessed when the grid is drawn. A value that
  fits gets no tooltip, and dragging a column wider takes the tooltip away
  again.

- **The 3D view answers to the filter, says what it is showing, and no longer
  opens on a plot of one column against itself.** Three faults, and the third
  is the one that made the other two hard to see.

  Filtering the sheet changed the grid, the status bar, the footer and the 2D
  chart, and left the 3D plot drawing every row — filter the starter workbook
  to one region and three readouts said "3 of 8 rows, £50,750" beside a picture
  of all eight. It subscribes to view changes now, and reads the same vector the
  footer totals do, so the plot cannot describe a different population from the
  numbers beside it.

  Axis titles, the colour legend and the count of rows dropped for having no
  value existed, and were drawn only by the no-WebGL fallback — so the browser
  that could not render in 3D got the labelled picture and every ordinary
  browser got an unlabelled one. They are drawn over the plot now. The dropped
  count is the part that matters: values with no number are left out rather than
  plotted as zero, which is right, and until now nothing said so.

  And the default binding took the first three numeric columns, which on the
  starter workbook meant Value, Probability, and Weighted — a column defined as
  Value × Probability. The third axis was a function of the other two, so the
  cloud was a surface and told you nothing. A column with a formula is no longer
  used as an axis while a stored one is available; and where a sheet has only
  two independent measures, it opens as 3D bars over two categories instead,
  which is both true to the data and the view a spreadsheet cannot draw.

- **The top bar is laid out like slides' and spaces'.** Undo and redo sit
  beside the title, then the tools, then Share, Save, 🌐 and ?. Save is the
  dark primary button. The version number and the settings button left the
  bar: click the bento/dash mark for About, and Settings is in About.

- **Sharing has a Share button with a panel, as in spaces.** It shows your
  name, who is here, and three copies to send: a reading copy, an invite to
  edit, and a view-only copy that follows along live. Nothing connects until
  you press Go live, or send a live copy. The button says "Share", or "Live"
  while you are connected, at every window width. Before, one click on "Start
  live session" went live with no panel, and on a narrow window the control was
  an unlabelled dot. A workbook that was saved while shared now reconnects when
  it is opened, so an invite or view-only copy works for the person you send it
  to.

- **The Save ▾ menu is one line per item**, with an icon; the explanation is
  the tooltip. Version history, Copy document JSON and Replace from JSON moved
  here from About, and **Start from scratch…** replaces every sheet with one
  blank sheet (⌘Z brings the workbook back). "Save read-only copy…" is now
  "Save a reading copy…" in the Share panel.

- **🌐 changes the language at once**, without reopening the file.
  Portuguese is now offered in the list.

- **Comment is a button in the bar**, beside the other tools (⌘⌥M still
  works). Comments use the app's one accent colour instead of purple.

- **Phones get a bar that fits.** The bar measures itself and folds the tools
  under ＋ and the rest under ⋯, which holds About, Settings, the language,
  help, Share and the Save list. On the narrowest phones the bar scrolls, never
  the page. The properties panel opens from a Format button and has a close
  button, and a tap outside it closes it too.

- **A stored language setting can no longer stop a workbook opening.** The
  language choice is shared by every Bento file in the browser, and an odd value
  in it — including the `x-pseudo` translation-check language — made dash fail
  with "This file could not start". Numbers now fall back to the browser's own
  language, then English.

- **The properties panel shows only what applies to what you selected.** A Text,
  Date, Yes/No or Category column no longer shows a number format, a Total, or
  an empty Formula field with another column's expression as its placeholder;
  Formula appears on a formula column, Total on the number types.
- **One Number format control.** A cell used to show a format dropdown, a
  Pattern field and a "Shows as" box, and a dataset showed a cell Pattern and a
  column Format as well. Now there is one dropdown (General, Number, Currency,
  Percent, Date, Time, Text, Custom…) with a live sample under it. The pattern
  field appears only for Custom…. On a dataset, "Apply to" chooses this column
  or just these cells. Time is new: `2:30 pm` becomes `14:30`.
- **An unset colour shows as an empty well.** Text colour and Background used
  to show a grey or cream swatch when nothing was set, so an unformatted cell
  looked formatted. They are struck-through empty wells now.
- **Checkboxes in the panel are plain checkboxes**, not full-width boxes that
  looked like empty text fields.
- **A formula over money is money.** `Value * 2` on a £ column makes a Money
  column with the same £ format. A plain number column no longer prints `8600`
  beside `24,800`: without a pattern it does not group thousands (as Excel's
  General does not), and a `#,##0` pattern groups every value.

- **The formula dialog says what is wrong as you type.** `Value * 2 +` now says
  "Something has to follow “+”" and keeps Add off, as do a missing bracket, a
  stray `%`, an unknown function or a leading `=`. Below the field: the sheet's
  columns to click in, and every function with its arguments, narrowing to the
  name you are typing (↓ and Enter insert one). Editing the starter's Weighted
  formula no longer reports its columns as unknown.

- **Clicking a column header selects the column; it no longer sorts.**
  Shift-click extends the selection and ⌘-click (Ctrl-click) adds a column,
  on datasets and on spreadsheet column letters alike. Sorting is in the
  header's ▾ menu and the right-click menu. After a sort or filter, the
  selected cell stays on the same record instead of the same screen position.

- **Double-click a column name to rename it** right on the grid. Enter keeps
  the new name (one undo step), Escape leaves it as it was.

- **＋ Add a column asks for the type** as well as the name. The type label on
  each column header is larger (11px) and no longer crowds the column letter.

- **Copying shows what was copied.** ⌘C or ⌘X draws a moving dashed border
  around the range until you press Escape, make the next edit, or paste.

- **Click a cell to put it in a formula.** While typing a formula, after `=`,
  an operator, `(` or `,`, clicking a cell or pressing an arrow key inserts
  its address instead of finishing the edit. Shift-click, shift-arrow or a
  drag makes a range, shown highlighted on the grid. Clicking another sheet's
  tab inserts a reference to that sheet (`Pipeline!A1`), which the arrow keys
  then move. Enter finishes the formula. This works in spreadsheet cells and in
  a dataset's per-cell formulas, where a sorted view still refers to the right
  row.

- **Escape closes the Story panel.** A pivot is a sheet now, so Escape does
  not leave it — its tab strip does, as in Excel.

- **New sheets are called Sheet3, Sheet4…** (Hoja3, Tabelle3…), whichever kind
  you add, instead of "Spreadsheet".

- **The keyboard reaches the whole window.** Tab goes through the top bar, the
  grid, the panel and the sheet tabs, each with the same focus ring slides uses;
  Enter presses a focused button. Inside the grid Tab still moves cell to cell,
  and leaves the grid at the last column; F6 jumps between the areas. The kind
  word on a sheet tab is 11px, up from 9.5.

- **More of dash speaks your language:** the Total choices (Sum, Average…) and
  the footer's SUM/AVG, the 3D kind button and messages, and every
  note from importing or exporting an Excel or CSV file — rewritten to say what
  happened and what to do, in all eight languages.

## [0.2.0] — 2026-08-03 (tagged, not published)

The first tagged version — a development milestone, never published. A workbook is one self-contained HTML file: the data, the grid,
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
