// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Runs: a type block's plain text plus range marks → w:r, w:hyperlink, w:ins
// and w:del.
//
// type stores text and marks separately (type/src/inline.ts explains why), and
// Word stores runs: maximal stretches with one set of properties. So the text
// is cut at every mark boundary, and each piece becomes a run carrying the
// marks over it. Two marks need a CONTAINER rather than a property:
//
//   - a link wraps its runs in w:hyperlink (an External rel, http/https/mailto
//     only, the same allowlist as the PowerPoint writer);
//   - a tracked change wraps its runs in w:ins or w:del with author and date,
//     and deleted text is written as w:delText, which is how Word knows the
//     characters are still there to be rejected. A deletion is NOT removed
//     here, for the reason inline.ts gives: it is what makes a rejection
//     possible.
//
// Nesting follows the schema: a w:hyperlink may hold w:ins/w:del, never the
// reverse, so the link is the outer container.

import { scrubC0, x, type XChild, type XNode } from '../xmlout.ts'
import { rPr, type RunProps } from './parts.ts'

export interface MarkIn {
  t: string
  from: number
  to: number
  href?: string
  by?: string
  at?: string
  family?: string
  size?: number
}

export interface RunCtx {
  /** a CSS font stack → the Word font name (and whether it was a substitute) */
  font(stack: string): string
  /** an external hyperlink target → its rel id, or null when it is refused */
  link(href: string): string | null
  /** a loss, reported once per (code, where) by the caller's Report */
  note(code: string, verdict: 'approximated' | 'dropped', detail: string): void
  /** the next revision id; unique across the document part */
  revisionId(): number
}

/** The run property a mark contributes, or nothing (containers and unknowns). */
function markProps(m: MarkIn, ctx: RunCtx, into: RunProps): void {
  switch (m.t) {
    case 'b': into.bold = true; break
    case 'i': into.italic = true; break
    case 'u': into.underline = true; break
    case 's': into.strike = true; break
    case 'code': into.rStyle = 'Code'; break
    case 'math':
      // until LaTeX → OMML lands, an inline formula travels as its source
      into.font = 'Cambria Math'
      ctx.note('math-as-source', 'approximated', 'equations are written as their LaTeX source, not as Word equations')
      break
    case 'font':
      if (m.family) into.font = ctx.font(m.family)
      if (typeof m.size === 'number' && Number.isFinite(m.size) && m.size > 0) into.sz = Math.max(1, Math.round(m.size * 1.5))
      break
  }
}

/** w:t / w:delText for a piece of text, with tabs and line breaks as their
 *  own elements. Leading or trailing space needs xml:space="preserve". */
function textKids(text: string, deleted: boolean): XChild[] {
  const out: XChild[] = []
  const tag = deleted ? 'w:delText' : 'w:t'
  for (const piece of text.split(/(\t|\n)/)) {
    if (piece === '\t') out.push(x('w:tab'))
    else if (piece === '\n') out.push(x('w:br'))
    else if (piece) out.push(x(tag, /^\s|\s$/.test(piece) ? { 'xml:space': 'preserve' } : undefined, [piece]))
  }
  return out
}

/** A run, given its text, its properties, and whether it is deleted text. */
export function run(text: string, props: RunProps, deleted = false): XNode {
  const r = rPr(props)
  return x('w:r', undefined, [...(r ? [r] : []), ...textKids(text, deleted)])
}

/**
 * The paragraph content for one block: runs, grouped into hyperlinks and
 * tracked changes.
 *
 * `base` carries properties every run of this paragraph has (a math block's
 * font, say). Marks of an unknown type are ignored, as type's renderer does.
 */
export function runs(text: string, marks: MarkIn[] | undefined, ctx: RunCtx, base: RunProps = {}): XChild[] {
  // Cut on the ORIGINAL offsets (the marks are offsets into it), scrub each
  // piece afterwards: scrubbing first would shift every mark after a control
  // character.
  const clean = text
  const ms = (marks ?? []).filter((m) => m.to > m.from)
  const cuts = new Set<number>([0, clean.length])
  for (const m of ms) { cuts.add(Math.max(0, Math.min(m.from, clean.length))); cuts.add(Math.max(0, Math.min(m.to, clean.length))) }
  const points = [...cuts].sort((a, b) => a - b)

  interface Piece { text: string; props: RunProps; link: MarkIn | null; track: MarkIn | null }
  const pieces: Piece[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i]
    const to = points[i + 1]
    if (to <= from) continue
    const props: RunProps = { ...base }
    let link: MarkIn | null = null
    let track: MarkIn | null = null
    for (const m of ms) {
      if (m.from > from || m.to < to) continue
      if (m.t === 'link') link = m
      else if (m.t === 'ins' || m.t === 'del') track = m
      else markProps(m, ctx, props)
    }
    pieces.push({ text: scrubC0(clean.slice(from, to)), props, link, track })
  }

  // Group: consecutive pieces under the SAME link mark share one w:hyperlink;
  // inside it (or outside any link), consecutive pieces under the same track
  // mark share one w:ins/w:del.
  const out: XChild[] = []
  let i = 0
  while (i < pieces.length) {
    const link = pieces[i].link
    let j = i
    while (j < pieces.length && pieces[j].link === link) j++
    const group = pieces.slice(i, j)
    const rid = link ? (typeof link.href === 'string' ? ctx.link(link.href) : null) : null
    if (link && !rid) ctx.note('hyperlink-dropped', 'dropped', 'links other than http, https and mailto are kept as plain text')
    if (rid) {
      // the Hyperlink character style gives Word's own look (blue, underlined)
      out.push(x('w:hyperlink', { 'r:id': rid }, tracked(group.map((p) => ({ ...p, props: { rStyle: 'Hyperlink', ...p.props } })))))
    } else out.push(...tracked(group))
    i = j
  }
  return out

  function tracked(ps: Piece[]): XChild[] {
    const res: XChild[] = []
    let a = 0
    while (a < ps.length) {
      const tr = ps[a].track
      let b = a
      while (b < ps.length && ps[b].track === tr) b++
      const del = tr?.t === 'del'
      const rs = ps.slice(a, b).map((p) => run(p.text, p.props, del))
      if (tr) {
        const attrs: Record<string, string | number> = { 'w:id': ctx.revisionId(), 'w:author': scrubC0(tr.by || 'Unknown') }
        if (tr.at && /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)?$/.test(tr.at)) attrs['w:date'] = tr.at
        res.push(x(del ? 'w:del' : 'w:ins', attrs, rs))
      } else res.push(...rs)
      a = b
    }
    return res
  }
}
