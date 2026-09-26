// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Pinned date/time patterns for the `{{date:…}}` and `{{time:…}}` fields
 * (discussion #381). Bare `{{date}}` follows the VIEWER's locale — right for a
 * deck shown to different audiences, but it means an author cannot say
 * "M/D/YY" and have every viewer see M/D/YY. A pattern pins the shape.
 *
 * Tokens, longest match first:
 *   YYYY  2026        YY  26
 *   MMMM  September   MMM  Sep      MM  09   M  9
 *   DD    04          D    4
 *   HH    14  H  14   hh   02  h  2  (12-hour, with A/a for AM/PM · am/pm)
 *   mm    05          ss   09
 *   A     PM          a    pm
 * Anything else is a literal, so `D MMMM YYYY`, `M/D/YY`, `YYYY-MM-DD`,
 * `h:mm a` all read as written; a word that happens to contain a token
 * letter goes in square brackets — `D MMMM [at] h:mm a`. Month names come
 * from Intl in the viewer's language — the SHAPE is pinned, the words still
 * speak to the reader.
 *
 * Pure, no DOM: scripts/test-slides-fields.ts drives it in node.
 */

const TOKENS = ['YYYY', 'MMMM', 'MMM', 'YY', 'MM', 'DD', 'HH', 'hh', 'mm', 'ss', 'M', 'D', 'H', 'h', 'A', 'a'] as const
// bracketed literal first, so `[at]` is one match that comes back verbatim
const TOKEN_RE = new RegExp('\\[([^\\]]*)\\]|' + TOKENS.join('|'), 'g')

const two = (n: number) => String(n).padStart(2, '0')

/** Format `d` by `pattern`. `locale` picks the month names (default: the
 *  browser's). A pattern with no token at all comes back as written. */
export function formatDate(d: Date, pattern: string, locale?: string): string {
  const month = (style: 'long' | 'short') => {
    try { return new Intl.DateTimeFormat(locale, { month: style }).format(d) }
    catch { return new Intl.DateTimeFormat(undefined, { month: style }).format(d) }
  }
  const h12 = d.getHours() % 12 || 12
  return pattern.replace(TOKEN_RE, (tok, literal?: string) => {
    if (literal !== undefined) return literal
    switch (tok) {
      case 'YYYY': return String(d.getFullYear())
      case 'YY': return two(d.getFullYear() % 100)
      case 'MMMM': return month('long')
      case 'MMM': return month('short')
      case 'MM': return two(d.getMonth() + 1)
      case 'M': return String(d.getMonth() + 1)
      case 'DD': return two(d.getDate())
      case 'D': return String(d.getDate())
      case 'HH': return two(d.getHours())
      case 'H': return String(d.getHours())
      case 'hh': return two(h12)
      case 'h': return String(h12)
      case 'mm': return two(d.getMinutes())
      case 'ss': return two(d.getSeconds())
      case 'A': return d.getHours() < 12 ? 'AM' : 'PM'
      case 'a': return d.getHours() < 12 ? 'am' : 'pm'
      default: return tok
    }
  })
}

/** The presets the Text panel's field picker offers for a date. The first is
 *  the bare token (viewer's locale); the rest pin a shape. */
export const DATE_PRESETS: ReadonlyArray<{ token: string; label: string }> = [
  { token: '{{date}}', label: 'Date (viewer’s format)' },
  { token: '{{date:D MMMM YYYY}}', label: 'Date — 14 September 2026' },
  { token: '{{date:MMMM D, YYYY}}', label: 'Date — September 14, 2026' },
  { token: '{{date:M/D/YY}}', label: 'Date — 9/14/26' },
  { token: '{{date:DD/MM/YYYY}}', label: 'Date — 14/09/2026' },
  { token: '{{date:YYYY-MM-DD}}', label: 'Date — 2026-09-14' },
]

export const TIME_PRESETS: ReadonlyArray<{ token: string; label: string }> = [
  { token: '{{time}}', label: 'Time (viewer’s format)' },
  { token: '{{time:HH:mm}}', label: 'Time — 14:05' },
  { token: '{{time:h:mm a}}', label: 'Time — 2:05 pm' },
]

/** The other fields, for the same picker. */
export const OTHER_FIELDS: ReadonlyArray<{ token: string; label: string }> = [
  { token: '{{page}}', label: 'Page number' },
  { token: '{{pages}}', label: 'Page count' },
  { token: '{{title}}', label: 'Deck title' },
  { token: '{{author}}', label: 'Author' },
  { token: '{{company}}', label: 'Company' },
  { token: '{{subject}}', label: 'Subject' },
  { token: '{{event}}', label: 'Event' },
]
