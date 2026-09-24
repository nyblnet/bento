// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Finding the formulas in a text element's HTML. DOM-free — the caller
 * (render.ts) passes the renderer — so scripts/test-slides-math-delims.ts
 * drives this exact code.
 *
 * FOUR DELIMITERS. `$$…$$` and `\[…\]` are display; `$…$` and `\(…\)` are
 * inline. The backslash pair is what ChatGPT, Claude and Markdown emit, so a
 * pasted formula used to show raw (#540). An escaped opener is literal:
 * `\$` shows a dollar, `\\(` and `\\[` show `\(` and `\[`.
 *
 * TEXT RUNS ONLY (#465). The input is sanitized HTML and a `$` can sit inside
 * an attribute — `<a href="https://x.example/$a$b">`. So the HTML is split on
 * tags and each text run is searched on its own: a formula never enters or
 * spans a tag. ONE EXCEPTION, for display formulas: pressing Enter in a text
 * box puts `<br>` or `<div>` between the lines, and a `$$ … $$` typed over
 * several lines used to stay raw. A display formula may span LINE-BREAK tags
 * — `<br>`, `<div>`, `</div>` (or `<p>`, `</p>`, never both kinds in one
 * span) — and nothing else: the lines are joined, rendered as one, and the
 * whole span is replaced. The opens and closes it swallowed are put back
 * around the formula (opens before, closes after), so the markup stays
 * balanced whatever the lines looked like.
 *
 * The inline `$` rule stays fussy so prose survives: no whitespace just
 * inside the delimiters, no digit straight after the closer ("it costs $5 and
 * $10" is prose). `$ x^2 $` stays prose by design; in the editor it gets a
 * hint instead (below).
 *
 * HINTS (editor only). When `hint` is passed, a formula-shaped run that did
 * NOT render is wrapped in a span the editor styles with a dotted underline
 * and a title naming why — the first unknown command, or "no spaces just
 * inside the $ signs". Thumbnails, present, print and the file-manager
 * preview never pass it, and nothing here reaches the document: the model
 * keeps the author's text.
 */

export type RenderFn = (src: string, display: boolean) => string | null
/** why `src` did not render (the editor's hint title), or null for no hint */
export type HintFn = (src: string, display: boolean, spaced?: boolean) => string | null

/** placeholders for rendered MathML while the other rules run, so no rule
 *  can see inside a formula already rendered (an `<mi>$</mi>` pairing with a
 *  later `$` would be the bug) */
const HOLD = ''
const holdRe = /(\d+)/g

/** a line-break tag a display formula may span: <br>, <div>, </div>, <p>, </p> */
const BREAK = /^<(?:br\s*\/?|\/?(div|p))>$/i

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function resolveMathHtml(html: string, render: RenderFn, hint?: HintFn): string {
  if (html.indexOf('$') < 0 && html.indexOf('\\(') < 0 && html.indexOf('\\[') < 0) return html
  const held: string[] = []
  const hold = (s: string) => `${HOLD}${held.push(s) - 1}${HOLD}`
  const parts = html.split(/(<[^>]*>)/) // even = text, odd = tag
  spanDisplay(parts, render, hold)
  const out = parts.map((p, i) => (i % 2 ? p : resolveRun(p, render, hold, hint))).join('')
  return out.replace(holdRe, (_m, n: string) => held[Number(n)])
}

/** the unescaped display opener left open at the end of a text run, if any */
function openDisplay(text: string): { at: number; kind: '$$' | '\\[' } | null {
  // walk the run: complete $$…$$ and \[…\] pairs close themselves
  let open: { at: number; kind: '$$' | '\\[' } | null = null
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '\\') { i++; continue } // \\ is an escaped backslash
    if (text[i] === '\\' && text[i + 1] === '$') { i++; continue }
    if (!open) {
      if (text.startsWith('$$', i)) { open = { at: i, kind: '$$' }; i++ }
      else if (text.startsWith('\\[', i)) { open = { at: i, kind: '\\[' }; i++ }
    } else if (open.kind === '$$' && text.startsWith('$$', i)) { open = null; i++ }
    else if (open.kind === '\\[' && text.startsWith('\\]', i)) { open = null; i++ }
  }
  return open
}

/** where the display formula opened in an earlier run closes in this one */
function closeDisplay(text: string, kind: '$$' | '\\['): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && (text[i + 1] === '\\' || text[i + 1] === '$')) { i++; continue }
    if (kind === '$$' ? text.startsWith('$$', i) : text.startsWith('\\]', i)) return i
    if (kind === '\\[' && text.startsWith('\\[', i)) return -1 // a second opener: not ours
  }
  return -1
}

const MAX_SPAN = 40 // parts: twenty lines is a formula, more is a document

/** Display formulas that span line-break tags, rendered in place. */
function spanDisplay(parts: string[], render: RenderFn, hold: (s: string) => string) {
  for (let i = 0; i < parts.length; i += 2) {
    const open = openDisplay(parts[i])
    if (!open) continue
    let src = parts[i].slice(open.at + 2)
    const tags: string[] = []
    const kinds = new Set<string>()
    for (let k = i + 1; k < parts.length && k - i <= MAX_SPAN; k += 2) {
      const m = BREAK.exec(parts[k])
      if (!m) break // any other tag: a formula never crosses it
      if (m[1]) kinds.add(m[1].toLowerCase())
      if (kinds.size > 1) break
      tags.push(parts[k])
      const next = parts[k + 1] ?? ''
      const close = closeDisplay(next, open.kind)
      if (close < 0) { src += '\n' + next; continue }
      const ml = render(src + '\n' + next.slice(0, close), true)
      if (!ml) break
      const opens = tags.filter((t) => /^<(div|p)>$/i.test(t)).join('')
      const closes = tags.filter((t) => /^<\/(div|p)>$/i.test(t)).join('')
      // before the opener stays text; the formula, with the tags it swallowed
      // balanced around it, is held; after the closer continues as text
      parts[i] = parts[i].slice(0, open.at) + hold(opens + ml + closes)
      parts.splice(i + 1, k + 1 - i, '', next.slice(close + 2))
      break // the loop visits the remainder (now i + 2) next
    }
  }
}

/** looks like maths someone meant: a command, a script */
const MATHY = /[\\^_]/

/** One text run: $$…$$ and \[…\] display, then \(…\) and $…$ inline. */
function resolveRun(text: string, render: RenderFn, hold: (s: string) => string, hint?: HintFn): string {
  if (text.indexOf('$') < 0 && text.indexOf('\\(') < 0 && text.indexOf('\\[') < 0) return text
  // a marked miss is held whole, so no later rule pairs a dollar inside it
  const mark = (raw: string, why: string | null) =>
    why ? hold(`<span class="bento-math-miss" title="${esc(why)}">${unescapeDelims(raw)}</span>`) : raw
  // `sure`: the delimiters alone say this was meant as maths. A failed $…$
  // could be prose that happens to hold two dollars, so it is only marked
  // when it looks mathematical.
  const rule = (display: boolean, sure: boolean) => (m: string, pre: string, src: string) => {
    const ml = render(src, display)
    if (ml) return pre + hold(ml)
    const raw = m.slice(pre.length)
    return pre + (hint && (sure || MATHY.test(src)) ? mark(raw, hint(src, display)) : raw)
  }
  let out = text.replace(/(^|[^\\])\$\$([^$]+?)\$\$/g, rule(true, true))
  // lookbehind, not a consumed prefix, so \(a\)\(b\) back to back both match
  out = out.replace(/(?<!\\)()\\\[([\s\S]+?)\\\]/g, rule(true, true))
  out = out.replace(/(?<!\\)()\\\(([\s\S]+?)\\\)/g, rule(false, true))
  out = out.replace(/(^|[^\\$])\$(\S(?:[^$\n]*?\S)?)\$(?!\d)/g, rule(false, false))
  // `$ x^2 $`: prose by design. What is left paired after the rules above
  // did not render; the maths-shaped ones with a space inside get a hint
  if (hint) {
    out = out.replace(/(^|[^\\$])\$([^$\n]+?)\$(?!\d)/g, (m, pre: string, src: string) =>
      /^\s|\s$/.test(src) && MATHY.test(src) ? pre + mark(m.slice(pre.length), hint(src, false, true)) : m)
  }
  return unescapeDelims(out)
}

/** the escapes have done their job: \$ is a dollar, \\( and \\[ are \( and \[ */
const unescapeDelims = (s: string) => s.replace(/\\\$/g, '$').replace(/\\\\([()[\]])/g, '\\$1')
