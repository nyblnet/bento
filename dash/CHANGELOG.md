# Changelog

All notable changes to **bento/dash**. The app version is baked into every
shell as `APP_VERSION` (from `dash/package.json`) and checked against the
signed release manifest; a shipped file updates itself through that channel.

The format (`bento/dash`, version `1`) is additive and stable — every version
below opens files from every earlier version, and unknown fields are preserved.
There is no server, so a break here would be permanent.

## [0.1.0] — 2026-08-03

First release. A workbook is one self-contained HTML file: the data, the grid
and the editor, opening from `file://` with no backend.

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
