// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The one test every document colour passes before it is drawn.
 *
 * A colour in a dash file is author data — a conditional-format stop, a data
 * bar, a chart series, a cell's fill — and the file is untrusted input
 * (docs/PLATFORM.md). Most of the places that paint one build markup as a
 * string: a `style="…"` attribute in the grid's paint loop, an SVG `fill="…"`
 * in a dashboard tile. In an attribute a `"` ends the attribute and what
 * follows is markup; inside the CSS a `;` or `}` starts a declaration somebody
 * else wrote, and `url(` makes a file the reader believed self-contained fetch
 * from the network. Escaping the quote alone stops the first and not the rest.
 *
 * So: an allowlist of the characters colour notations actually use — hex,
 * names, `rgb()`/`hsl()` with commas, spaces, slashes and percents, and
 * `var(--x)` — no `url`, no `expression`, no `@` or backslash, and a length
 * cap. Anything else is NOT a colour and is refused (null), never "cleaned":
 * a colour we cannot recognise is not worth guessing at, and the caller
 * decides what absence paints (usually nothing).
 *
 * preview.ts and print.ts carried this exact rule before it lived here; it is
 * one rule in one place now so a new paint site has one thing to call.
 */
export function safeColor(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || s.length > 32) return null
  if (!/^[#a-zA-Z0-9(),.%\s/-]+$/.test(s)) return null
  if (/url|expression|@|\\/i.test(s)) return null
  return s
}
