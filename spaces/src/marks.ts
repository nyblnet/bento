// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Inline MARKS — the canonical form of a block's html, and the engine that
// toggles a mark over a range of it.
//
// WHY THIS IS A STRING ENGINE AND NOT A DOM ONE.
//
// §2.4(b) forbids `document.execCommand`, so every mark this app applies has to
// be produced by us. The obvious shape is DOM surgery over a live Range —
// split the boundary text nodes, walk the covered ones, wrap or unwrap. That
// works, and it is untestable here: the rigs are plain `node` with no DOM (see
// sanitize.ts's `typeof document === 'undefined'` fallback, which exists for
// exactly that reason), so a DOM engine could only ever be checked by hand in a
// browser. The partial-selection case — unbolding half of a bold run — is the
// one that goes wrong quietly and the one a rig has to pin.
//
// So the engine is a PURE FUNCTION over (inline html, plain-text offsets):
// parse to a flat run list, edit the runs, serialize back. The DOM appears only
// in `offsetsOf`/`rangeAt` at the bottom, which convert a live Range to those
// offsets and back — twenty lines with no policy in them.
//
// It also gets the canonicaliser for free. §2.3 requires "fixed mark nesting
// order, adjacent runs coalesced, no style", and a serializer that always emits
// marks in one order and never emits two adjacent identical wrappers IS that
// canonicaliser. `canonicalMarks` is just `serializeRuns(parseRuns(html))`, so
// the form the toolbar produces and the form a commit normalises to cannot
// drift apart: they are the same function.

/** The marks the model has. Every one is an allowlisted tag in sanitize.ts. */
export type MarkTag = 'a' | 'mark' | 'span' | 'strong' | 'em' | 'u' | 's' | 'sub' | 'sup' | 'code'

/**
 * THE COLOUR VOCABULARY — Notion's shape, and its shape is what makes it safe.
 *
 * A FIXED PALETTE, never a colour picker. A closed vocabulary is the difference
 * between a sanitizer that matches a name and a sanitizer that has to parse
 * CSS, and between a colour that adapts to the surface it is drawn on and a hex
 * value that is wrong the first time the surface changes.
 *
 * ONE palette in TWO roles: `sp-fg-<name>` on a SPAN is the ink,
 * `sp-bg-<name>` on a MARK is the band behind it. `<mark>` with no class stays
 * the plain accent highlight it already was, so nothing written before this
 * existed changes meaning.
 */
export const PALETTE = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const
export type PaletteName = (typeof PALETTE)[number]

/**
 * The class names a block's html may carry — the ONLY attribute value in this
 * format besides `A.href`.
 *
 * A PATTERN, DELIBERATELY, AND NOT AN ENUMERATION OF THE NINE ABOVE. Format
 * additivity (PLATFORM §3) is the whole argument: there is no server to migrate
 * anything, so a build that strips what it does not recognise DESTROYS
 * documents written by a later one. Enumerate today's palette and a tenth
 * colour added in two years is deleted — silently, on the next edit that
 * touches the block — by every build shipped before it. With a pattern, an old
 * build keeps the class, round-trips it byte-for-byte and simply renders it
 * unstyled: degraded, which is recoverable, rather than lost, which is not.
 *
 * Safe because a class NAME cannot execute and the stylesheet is ours, not the
 * document's — the class selects a rule we wrote, or it selects nothing. That
 * is exactly what `style="…"` would not be: a style attribute makes the
 * sanitizer a CSS parser, and CSS is a language with `url()` in it.
 */
export const CLASS_OK = /^sp-(fg|bg)-[a-z0-9-]{1,16}$/

/** The `class` attribute text worth keeping, or '' — the sanitizer's rule,
 *  applied per TOKEN so `class="sp-fg-red something-else"` loses only the
 *  second one. */
export function keepClasses(value: string): string {
  const kept = value.split(/\s+/).filter((c) => CLASS_OK.test(c))
  return kept.length ? kept.join(' ') : ''
}

/**
 * THE CANONICAL NESTING ORDER, outermost first.
 *
 * Any fixed order would satisfy §2.3; this one is chosen so that the nesting a
 * reader ends up with is also the nesting they would have wanted:
 *
 *   · `a` outermost, because a link is the thing you click. A link broken in
 *     two by a bold boundary is two links, two hover targets and two entries in
 *     a screen reader's link list, for one link's worth of meaning.
 *   · `mark` next: a highlight is a band of background behind the words, and a
 *     band interrupted by an emphasis boundary shows as two bands with a seam.
 *   · `span` (the ink colour) inside `mark` and outside everything else, for
 *     the same reason one step down: colour applies to a phrase, and the phrase
 *     is the outer thing.
 *   · the emphasis marks in a stable arbitrary order — nothing observable
 *     depends on `strong` outside `em` rather than the reverse, only on the
 *     choice never changing.
 *   · `code` innermost, so the monospace box hugs the text rather than the
 *     other marks' boundaries.
 *
 * `b`/`i` fold to `strong`/`em` on parse: the allowlist has both spellings, the
 * markdown importer emits the semantic pair, and Chrome's contentEditable used
 * to emit the presentational one, so files already carry a mix. One spelling
 * per mark means one diff and one CRDT node key per mark, and both spellings
 * render identically, so folding costs a reader nothing.
 */
const ORDER: MarkTag[] = ['a', 'mark', 'span', 'strong', 'em', 'u', 's', 'sub', 'sup', 'code']

/** Tag name (lower case) → the mark it means. Anything absent is not a mark. */
const FOLD: Record<string, MarkTag> = {
  a: 'a', mark: 'mark', span: 'span',
  b: 'strong', strong: 'strong',
  i: 'em', em: 'em',
  u: 'u', s: 's', strike: 's',
  sub: 'sub', sup: 'sup', code: 'code',
}

/** Marks the floating toolbar can toggle, in the order it shows them. */
export const TOOLBAR_MARKS: MarkTag[] = ['strong', 'em', 'u', 's', 'code', 'mark']

/** One mark on a run. `attrs` is the verbatim attribute text, `a`'s href only. */
export interface Mark { tag: MarkTag; attrs: string }

/**
 * One stretch of text (or one `<br>`) carrying a set of marks.
 *
 * A `<br>` is a run of LENGTH ONE with no text. It has to occupy an offset or
 * the DOM side and the string side would count a block's characters
 * differently, and every mark applied after a line break would land one
 * character out.
 */
export interface Run { text: string; br?: true; marks: Mark[] }

// ---- entities ---------------------------------------------------------------
//
// Decode on parse, re-encode on serialize, and the encode side is EXACTLY the
// html spec's text-node serialization (`&`, U+00A0, `<`, `>` and nothing else)
// — which is what `Element.innerHTML` hands back. The model's html is read
// straight off `innerHTML` on every keystroke, so an encoder that differed from
// the browser's by one character would make every canonicalisation report a
// change and every save differ from the last for no reason.

const decode = (s: string): string =>
  s.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
    }
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
    return named[body] ?? m
  })

const encode = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/\u00a0/g, '&nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ---- parse ------------------------------------------------------------------

/**
 * Attribute text worth keeping — the same two rules sanitize.ts applies, so a
 * canonicalisation can never re-introduce something the sanitizer removed.
 *
 * `A` keeps its attributes verbatim (href, and the rel/target sanitizeInline
 * pins on an outward link); SPAN and MARK keep a palette class and nothing
 * else. Every other tag keeps nothing at all.
 */
function attrsOf(tag: MarkTag, raw: string): string {
  if (tag === 'a') return raw.trim() ? ` ${raw.trim()}` : ''
  if (tag !== 'span' && tag !== 'mark') return ''
  const m = /class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw)
  const kept = keepClasses(m ? (m[1] ?? m[2] ?? m[3] ?? '') : '')
  return kept ? ` class="${kept}"` : ''
}

/** The palette name a mark carries, or '' for the plain/default form. */
export function colourOf(attrs: string): string {
  const m = /sp-(?:fg|bg)-([a-z0-9-]{1,16})/.exec(attrs)
  return m ? m[1] : ''
}

/** The attribute text for one palette choice. '' means "the default". */
export const colourAttrs = (role: 'fg' | 'bg', name: string): string =>
  name ? ` class="sp-${role}-${name}"` : ''

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g

/**
 * Inline html → a flat list of runs.
 *
 * Tolerant by construction. This reads html that a browser's contentEditable
 * wrote, that a paste left behind, or that a person hand-edited in the JSON
 * round trip, so an unmatched `</b>` is skipped and an unclosed `<b>` simply
 * runs to the end. Refusing to parse would mean refusing to canonicalise, which
 * is the opposite of what a canonicaliser is for.
 *
 * A bare `<span>` is DROPPED rather than kept. It is not information loss:
 * sanitize.ts strips every attribute from every tag but `A.href`, so a span in
 * a block's html carries nothing at all by the time it reaches here — it is
 * debris from contentEditable, and keeping it would mean two byte-different
 * spellings of identical content.
 */
export function parseRuns(html: string): Run[] {
  const runs: Run[] = []
  // one entry per open tag, so `</span>` pops the span and not the `<b>` under
  // it; `mark: null` is an open tag that is not a mark
  const stack: Array<{ name: string; mark: Mark | null }> = []
  const marksNow = (): Mark[] => {
    const out: Mark[] = []
    for (const e of stack) if (e.mark && !out.some((m) => m.tag === e.mark!.tag)) out.push(e.mark)
    return out
  }
  const pushText = (raw: string) => {
    if (!raw) return
    runs.push({ text: decode(raw), marks: marksNow() })
  }

  let at = 0
  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(html))) {
    pushText(html.slice(at, m.index))
    at = TAG_RE.lastIndex
    const name = m[2].toLowerCase()
    const close = m[1] === '/'
    if (name === 'br') { if (!close) runs.push({ text: '', br: true, marks: marksNow() }); continue }
    if (close) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) { stack.splice(i, 1); break }
      }
      continue
    }
    const tag = FOLD[name]
    const attrs = tag ? attrsOf(tag, m[3]) : ''
    // A SPAN IS ONLY A MARK WHEN IT CARRIES A PALETTE CLASS. Without one it
    // says nothing — sanitize.ts allows no other attribute on it — so it is
    // contentEditable debris, and keeping it would mean two byte-different
    // spellings of identical content.
    const real = !!tag && (tag !== 'span' || !!attrs)
    stack.push({ name, mark: real ? { tag: tag as MarkTag, attrs } : null })
  }
  pushText(html.slice(at))
  return runs
}

// ---- serialize --------------------------------------------------------------

const rank = (m: Mark): number => ORDER.indexOf(m.tag)
const sortMarks = (marks: Mark[]): Mark[] => [...marks].sort((a, b) => rank(a) - rank(b))
const same = (a: Mark, b: Mark): boolean => a.tag === b.tag && a.attrs === b.attrs

/**
 * Runs → canonical inline html.
 *
 * Marks are opened in ORDER and closed innermost-first, and a mark is only
 * closed when the next run does not carry it — which is what coalesces adjacent
 * identical runs, without a separate pass and without the fixed-point loop the
 * old string canonicaliser needed. Empty runs never open anything, so
 * `<b></b>` cannot be emitted.
 */
export function serializeRuns(runs: Run[]): string {
  let out = ''
  let open: Mark[] = []
  for (const run of runs) {
    if (!run.br && !run.text) continue
    const want = sortMarks(run.marks)
    let keep = 0
    while (keep < open.length && keep < want.length && same(open[keep], want[keep])) keep++
    for (let i = open.length - 1; i >= keep; i--) out += `</${open[i].tag}>`
    for (let i = keep; i < want.length; i++) out += `<${want[i].tag}${want[i].attrs}>`
    open = want
    out += run.br ? '<br>' : encode(run.text)
  }
  for (let i = open.length - 1; i >= 0; i--) out += `</${open[i].tag}>`
  return out
}

/**
 * The canonical form of a block's inline html — §2.3's "fixed mark nesting
 * order, adjacent runs coalesced, no style".
 *
 * IDEMPOTENT, and structurally so rather than by luck: `parseRuns` of canonical
 * html yields runs that differ from the originals only by having been split at
 * tag boundaries, and `serializeRuns` re-merges exactly those.
 */
export function canonicalMarks(html: string): string {
  return serializeRuns(parseRuns(html))
}

// ---- markdown ---------------------------------------------------------------

/**
 * The markdown spelling of each mark, open and close.
 *
 * EVERY MARK HAS ONE. A control that produces something the exporter silently
 * drops is worse than not having the control, because the loss only shows up
 * in a file somebody already sent — and `u`, `mark`, `sub` and `sup` were all
 * dropped before this table existed.
 *
 * The four that markdown has no syntax for are written in the form THIS APP'S
 * OWN IMPORTER reads back as the same mark, so export→import is the identity
 * function and needs no second table to stay honest — the same reason callout
 * tones are spelled `> [!NOTE]`, exactly as GitHub spells it.
 *
 *   · `mark` → `==x==`, Obsidian's and Pandoc's spelling, which markdown.ts's
 *     `inlineHtml` already parses. Readable as plain text where it is not.
 *   · `u`, `sub`, `sup` → raw inline html, which GFM permits and markdown.ts's
 *     raw-tag sweep keeps (its INLINE_OK list). GitHub's own documentation
 *     tells you to write `<sub>`/`<sup>` this way because there is no other
 *     way. `_x_` for underline was rejected outright: it re-imports as ITALIC,
 *     and a mark that comes back as a DIFFERENT mark is worse than one that
 *     comes back as nothing. `~x~`/`^x^` were rejected as a Pandoc extension
 *     almost nothing else parses — the round trip would hold inside this app
 *     and read as literal tildes and carets everywhere else.
 */
const MD: Record<MarkTag, [string, string]> = {
  a: ['[', ']'],
  mark: ['==', '=='],
  span: ['<span>', '</span>'],
  strong: ['**', '**'],
  em: ['*', '*'],
  u: ['<u>', '</u>'],
  s: ['~~', '~~'],
  sub: ['<sub>', '</sub>'],
  sup: ['<sup>', '</sup>'],
  code: ['`', '`'],
}

const hrefOf = (m: Mark): string => {
  const found = /href\s*=\s*"([^"]*)"/i.exec(m.attrs)
  return found ? decode(found[1]) : ''
}

/**
 * Inline html → inline markdown.
 *
 * Runs, not a DOM walk. The DOM version could not be tested — the rigs are
 * plain node — so "does every mark the toolbar applies survive an export" was
 * a question only a human with a browser could answer, which is how `u`,
 * `mark`, `sub` and `sup` came to be dropped without anyone noticing. This is
 * `serializeRuns` with a different pair of brackets per mark, so the export
 * inherits the canonical nesting order for free: a link is always outermost,
 * which is the only nesting markdown can express anyway.
 */
export function htmlToMd(html: string): string {
  const runs = parseRuns(html)
  let out = ''
  let open: Mark[] = []
  // A COLOURED mark is raw html, because markdown has no colour at all; the
  // PLAIN highlight stays `==x==`, which is native Obsidian syntax and a
  // Pandoc extension, so it round-trips outside this app as well as inside it.
  const open1 = (m: Mark): string =>
    (m.tag === 'span' || (m.tag === 'mark' && m.attrs)) ? `<${m.tag}${m.attrs}>` : MD[m.tag][0]
  const close = (m: Mark): string =>
    m.tag === 'a' ? `](${hrefOf(m)})`
      : (m.tag === 'span' || (m.tag === 'mark' && m.attrs)) ? `</${m.tag}>` : MD[m.tag][1]
  for (const run of runs) {
    if (!run.br && !run.text) continue
    const want = sortMarks(run.marks)
    let keep = 0
    while (keep < open.length && keep < want.length && same(open[keep], want[keep])) keep++
    for (let i = open.length - 1; i >= keep; i--) out += close(open[i])
    for (let i = keep; i < want.length; i++) out += open1(want[i])
    open = want
    out += run.br ? '\n' : run.text
  }
  for (let i = open.length - 1; i >= 0; i--) out += close(open[i])
  return out.trim()
}

// ---- offsets ----------------------------------------------------------------

const runLen = (r: Run): number => (r.br ? 1 : r.text.length)

/** Total characters, `<br>` counting as one. */
export function textLength(runs: Run[]): number {
  let n = 0
  for (const r of runs) n += runLen(r)
  return n
}

/**
 * Split runs so that `at` falls on a run boundary; returns the run index there.
 *
 * This is the whole partial-selection case. Selecting the middle of a bold run
 * and unbolding splits one run into three, of which the engine then edits the
 * middle — no DOM surgery, no stale offsets, and the serializer re-merges the
 * two outer thirds' `<b>`s only if nothing came between them.
 */
function splitAt(runs: Run[], at: number): number {
  let n = 0
  for (let i = 0; i < runs.length; i++) {
    const len = runLen(runs[i])
    if (n === at) return i
    if (at < n + len) {
      // a <br> is one indivisible character: an offset inside it is either side
      if (runs[i].br) return at - n === 0 ? i : i + 1
      const cut = at - n
      const r = runs[i]
      runs.splice(i, 1,
        { text: r.text.slice(0, cut), marks: r.marks },
        { text: r.text.slice(cut), marks: r.marks })
      return i + 1
    }
    n += len
  }
  return runs.length
}

/** Does every text-bearing run in the range already carry `tag`? */
function allHave(runs: Run[], i0: number, i1: number, tag: MarkTag): boolean {
  let seen = false
  for (let i = i0; i < i1; i++) {
    if (runs[i].br) continue
    if (!runs[i].text) continue
    seen = true
    if (!runs[i].marks.some((m) => m.tag === tag)) return false
  }
  return seen
}

/** Is `tag` active across [start,end) of `html`? What the toolbar shades. */
export function markActive(html: string, start: number, end: number, tag: MarkTag): boolean {
  const runs = parseRuns(html)
  const i0 = splitAt(runs, Math.min(start, end))
  const i1 = splitAt(runs, Math.max(start, end))
  return allHave(runs, i0, i1, tag)
}

/** The `href` of a link covering the whole range, or '' — what ⌘K pre-fills. */
export function linkAt(html: string, start: number, end: number): string {
  const runs = parseRuns(html)
  const i0 = splitAt(runs, Math.min(start, end))
  const i1 = splitAt(runs, Math.max(start, end))
  let href = ''
  for (let i = i0; i < i1; i++) {
    if (runs[i].br || !runs[i].text) continue
    const a = runs[i].marks.find((m) => m.tag === 'a')
    if (!a) return ''
    const m = /href\s*=\s*"([^"]*)"/i.exec(a.attrs)
    const h = m ? decode(m[1]) : ''
    if (href && href !== h) return ''
    href = h
  }
  return href
}

export type MarkOp = 'toggle' | 'on' | 'off'

/**
 * Apply, remove or toggle one mark over [start,end) of a block's inline html.
 *
 * Returns canonical html. Offsets are unchanged by construction — this only
 * ever moves TAGS, never a character of text — so the caller can restore the
 * selection with the same numbers it passed in, which is how the whole
 * "selection offsets go stale after DOM surgery" family of bugs is avoided
 * rather than worked around.
 */
export function applyMark(
  html: string, start: number, end: number, tag: MarkTag,
  opts: { op?: MarkOp; attrs?: string } = {},
): string {
  const runs = parseRuns(html)
  const a = Math.max(0, Math.min(start, end))
  const b = Math.min(textLength(runs), Math.max(start, end))
  const i0 = splitAt(runs, a)
  const i1 = splitAt(runs, b)
  const op = opts.op ?? 'toggle'
  const on = op === 'on' || (op === 'toggle' && !allHave(runs, i0, i1, tag))
  const attrs = opts.attrs ?? ''
  for (let i = i0; i < i1; i++) {
    const rest = runs[i].marks.filter((m) => m.tag !== tag)
    runs[i] = { ...runs[i], marks: on ? [...rest, { tag, attrs }] : rest }
  }
  return serializeRuns(runs)
}

/** Strip every mark from [start,end). The toolbar's "Clear formatting". */
export function clearMarks(html: string, start: number, end: number): string {
  const runs = parseRuns(html)
  const i0 = splitAt(runs, Math.max(0, Math.min(start, end)))
  const i1 = splitAt(runs, Math.min(textLength(runs), Math.max(start, end)))
  for (let i = i0; i < i1; i++) runs[i] = { ...runs[i], marks: [] }
  return serializeRuns(runs)
}

/**
 * The `<a>` attribute text for a url, spelled EXACTLY as sanitize.ts would
 * leave it.
 *
 * Not "close enough": the block is re-canonicalised on every commit, and if the
 * sanitizer had to add `rel`/`target` afterwards then the html the toolbar
 * wrote and the html the next blur produces would differ, so every link would
 * report itself as an edit once more than it was one.
 */
export function linkAttrs(url: string): string {
  const href = url.replace(/"/g, '&quot;').replace(/&(?!#|[a-zA-Z]+;)/g, '&amp;')
  return url.startsWith('#')
    ? ` href="${href}"`
    : ` href="${href}" rel="noopener noreferrer" target="_blank"`
}

// ---- the DOM bridge ---------------------------------------------------------
//
// Everything above is pure. These two convert a live Range to the offsets it
// takes and back, and they are the only place a browser is required.

/**
 * Characters in a subtree, counted the way `parseRuns` counts them.
 *
 * THE FRAGMENT CASE IS NOT AN EDGE CASE — it is the only case. This is called
 * on `cloneContents()`, whose result is a DOCUMENT_FRAGMENT (nodeType 11), so
 * an "element or nothing" test returns 0 for every input it ever receives and
 * the toolbar simply never appears. Measured in the built shell: `start` and
 * `end` both 0 for a four-character selection, `markable()` null, no bar,
 * nothing in the console.
 */
function lenOf(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? '').length
  if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') return 1
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return 0
  let n = 0
  for (const child of node.childNodes) n += lenOf(child)
  return n
}

/**
 * A range's boundaries as plain-text offsets into `host`.
 *
 * MEASURED BY CLONING, not by walking to the boundary node. A Range boundary
 * can sit in a text node, between two element children, or at the end of an
 * element with no children, and a hand-written walk has to get all three right
 * every time it is touched. `cloneContents()` of "host start → boundary"
 * answers all three with one rule, and the clone is discarded immediately.
 */
export function offsetsOf(host: HTMLElement, range: Range): { start: number; end: number } | null {
  if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null
  const upto = (container: Node, offset: number): number => {
    const probe = host.ownerDocument.createRange()
    probe.setStart(host, 0)
    probe.setEnd(container, offset)
    return lenOf(probe.cloneContents())
  }
  return { start: upto(range.startContainer, range.startOffset), end: upto(range.endContainer, range.endOffset) }
}

/** The reverse: a Range over [start,end) of `host`'s text. */
export function rangeAt(host: HTMLElement, start: number, end: number): Range {
  const range = host.ownerDocument.createRange()
  let n = 0
  let doneStart = false
  let doneEnd = false
  const walk = (node: Node): void => {
    if (doneEnd) return
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.nodeValue ?? '').length
      if (!doneStart && start <= n + len) { range.setStart(node, start - n); doneStart = true }
      if (!doneEnd && end <= n + len) { range.setEnd(node, end - n); doneEnd = true }
      n += len
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    if ((node as Element).tagName === 'BR') {
      const parent = node.parentNode!
      const at = [...parent.childNodes].indexOf(node as ChildNode)
      if (!doneStart && start <= n) { range.setStart(parent, at); doneStart = true }
      if (!doneEnd && end <= n) { range.setEnd(parent, at); doneEnd = true }
      n += 1
      return
    }
    for (const child of [...node.childNodes]) walk(child)
  }
  walk(host)
  if (!doneStart) { range.selectNodeContents(host); range.collapse(false) }
  if (!doneEnd) range.setEnd(host, host.childNodes.length)
  return range
}
