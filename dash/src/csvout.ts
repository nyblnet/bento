// One CSV field, as dash writes it.
//
// TWO jobs, and the second is the one that matters:
//
//   1. RFC 4180 quoting — a comma, quote, CR or LF puts the field in quotes and
//      doubles its quotes.
//   2. FORMULA INJECTION. A spreadsheet that opens a CSV evaluates any field
//      beginning with `=`, `+`, `-`, `@`, a tab or a CR as a formula — so a
//      text cell holding `=HYPERLINK("http://x","click")` (typed, pasted, or
//      submitted through a form by a stranger) becomes a live link, or worse,
//      the moment someone opens the export in Excel. TEXT that starts that way
//      gets a leading `'`, the convention Excel and Sheets both read as "this
//      is text". A NUMBER is never touched: `-5` stored as a number is data,
//      and prefixing it would turn every negative into a string.

const TRIGGER = /^[=+\-@\t\r]/

export function csvField(v: unknown): string {
  if (v === null || v === undefined) return ''
  let s = typeof v === 'string' ? v : String(v)
  if (typeof v === 'string' && TRIGGER.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
