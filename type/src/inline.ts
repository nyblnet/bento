// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Inline formatting for bento/type.
//
// THE DECISION, AND WHY IT IS THIS ONE.
//
// A block stores PLAIN TEXT plus a separate list of marks over character
// ranges — not an HTML string, and not an array of styled inline nodes.
//
//   { text: "Payment is due in 30 days.", marks: [{ t:'b', from:19, to:26 }] }
//
// The alternative (an `html` string, which is what bento/slides does for its
// text elements) is the obvious choice and it is the wrong one HERE, because
// four things this app has already proved all depend on a plain-text spine:
//
//   1. REDLINING diffs plain text, word by word. That engine exists and is
//      tested. Against HTML it would report a formatting change as a rewritten
//      sentence, which is exactly the failure that makes line diffs useless on
//      prose.
//   2. SIGNATURES sign a canonical form. Canonicalizing HTML means deciding
//      about attribute order, tag case, whitespace and entity spelling —
//      every one an opportunity for two honest parties to produce different
//      bytes for the same document, which is precisely the failure mode a
//      signature cannot survive. Text + a sorted mark list has one form.
//   3. THE CARET is a model position (blockId, offset into the text). That was
//      forced on us by measurement: with hyphenation on, the renderer inserts
//      characters, so any address in rendered space drifts. Offsets into an
//      HTML string are worse still — they move when a tag opens.
//   4. FOOTNOTE ANCHORS are already `{id, at}` offsets into the same text, and
//      the code that keeps them correct across an edit already exists. Marks
//      use the identical rule, so there is one concept, not two.
//
// So HTML is what we RENDER, never what we store. The cost is this file: mark
// arithmetic is fiddlier than string concatenation, and it is fiddly in one
// place instead of leaking into four.

/** The formatting a run of text can carry. Deliberately small. */
export type MarkType = 'b' | 'i' | 'u' | 's' | 'code' | 'link' | 'math' | 'ins' | 'del' | 'font';

export interface Mark {
  t: MarkType;
  /** inclusive character offset into the block's text */
  from: number;
  /** exclusive */
  to: number;
  /** link target — only for t:'link' */
  href?: string;
  /**
   * Who made this tracked change, and when — only for t:'ins' and t:'del'.
   *
   * TRACKED CHANGES ARE MARKS, and that decision is worth stating here because
   * every other word processor keeps a parallel revision log beside the text.
   * A mark is a range over the same string everything else is a range over, so
   * it moves when the text moves (spliceText already does it), merges under the
   * CRDT like any other mark, survives save and reopen, prints, and needs no
   * second thing to keep in step. A revision log would need all of that written
   * again, and would drift the first time someone edited offline.
   *
   * A deletion does NOT remove the characters: it marks them. That is what
   * makes a rejection possible, and it is why `del` text must be skipped by
   * anything that reads a block as prose — see textOf() in track.ts.
   */
  by?: string;
  at?: string;
  /**
   * Typeface and size for a RUN of characters — only for t:'font'.
   *
   * A font is a character property, which is why it is a mark and not a block
   * field: "make these three words Verdana" is the request, and a paragraph is
   * the wrong unit for it. doc.type stays the document's DEFAULT, and a run
   * without a font mark inherits it.
   *
   * Both are optional and independent. A mark may carry only a family, only a
   * size, or both — which is what lets a size applied over part of a
   * differently-fonted run do the obvious thing: the two render as nested
   * spans and CSS inheritance resolves them, with no special case here.
   */
  family?: string;
  size?: number;
}

/** The tag each mark renders as. `link` is special-cased (it carries an href). */
const TAG: Record<Exclude<MarkType, 'link'>, string> = {
  b: 'strong', i: 'em', u: 'u', s: 's', code: 'code',
  // a styled span; openTag builds the style attribute itself
  font: 'span',
  // <ins>/<del> are the elements HTML already has for exactly this, so a
  // printed or pasted tracked change carries its meaning outside Bento too.
  ins: 'ins', del: 'del',
  // `math` never reaches here: a math range is replaced wholesale by `ranges`
  // below, so its source characters are never emitted as text inside a tag.
  // The entry exists because the type demands one, and a wrong tag would be a
  // silent fallback rather than an error.
  math: 'span',
};
const BY_TAG: Record<string, MarkType> = {
  strong: 'b', b: 'b', em: 'i', i: 'i', u: 'u', s: 's', strike: 's', del: 's',
  code: 'code', a: 'link',
};

/**
 * The canonical form of a mark list: clamped to the text, empty ranges dropped,
 * touching or overlapping marks of the same kind merged, then sorted.
 *
 * Everything that mutates marks ends by calling this, so there is exactly one
 * representation of any given formatting — which is what lets the canonical
 * document form be stable, and what stops `normalize` being a place bugs hide.
 */
export function normalize(marks: Mark[], len: number): Mark[] {
  const out: Mark[] = [];
  for (const m of marks) {
    const from = Math.max(0, Math.min(m.from, len));
    const to = Math.max(0, Math.min(m.to, len));
    if (to - from <= 0) continue;
    // Rebuilt field by field rather than spread, so an unknown key can never
    // ride along into the canonical form. `by`/`at` are listed EXPLICITLY: a
    // tracked change whose author was dropped here would still render as a
    // change, so nothing would look broken — it would just stop being able to
    // say who made it, which is the entire point of tracking.
    const n: Mark = { t: m.t, from, to };
    if (m.href !== undefined) n.href = m.href;
    if (m.by !== undefined) n.by = m.by;
    if (m.at !== undefined) n.at = m.at;
    if (m.family !== undefined) n.family = m.family;
    if (m.size !== undefined) n.size = m.size;
    out.push(n);
  }
  // Merge PER KIND, not against whatever happens to sort next to it.
  //
  // Merging against the immediate predecessor looks right and is wrong: with
  // marks [s 0–35, u 15–35, i 19–48, u 35–48] the two `u` pieces are separated
  // in sort order by an `i`, so they never merge and a run that was authored as
  // one 15–48 underline comes back as two. Rendering splits marks whenever they
  // overlap, so this happens on ordinary text — a fuzz pass hit it 423 times in
  // 2,000 random mark sets, and none of the hand-written cases did.
  const byKind = new Map<string, Mark[]>();
  for (const m of out) {
    // NUL separates the kind from the href so a mark type can never collide
    // with an href prefix. Written as an ESCAPE: a literal control character
    // in source makes git and grep treat the whole file as binary, which hid
    // it from ordinary tooling — the same trap this repo hit in DECISIONS.md,
    // and it cost a debugging cycle here before anyone noticed.
    // The AUTHOR is part of the key: two people's insertions that happen to
    // abut are two changes, and merging them would attribute both to whoever
    // sorted first. Untracked marks have no `by`, so they key exactly as before.
    // The FONT is part of the key as well. Two adjacent runs, one Verdana and
    // one Georgia, are not one run: merging by type alone would join them and
    // give both whichever sorted first — the same bug two authors' insertions
    // had before `by` joined this key.
    const key = `${m.t}\u0000${m.href ?? ''}\u0000${m.by ?? ''}\u0000${m.family ?? ''}\u0000${m.size ?? ''}`;
    (byKind.get(key) ?? byKind.set(key, []).get(key)!).push(m);
  }
  const merged: Mark[] = [];
  for (const group of byKind.values()) {
    group.sort((a, b) => a.from - b.from || a.to - b.to);
    let cur = { ...group[0] };
    for (const m of group.slice(1)) {
      if (m.from <= cur.to) cur.to = Math.max(cur.to, m.to);
      else { merged.push(cur); cur = { ...m }; }
    }
    merged.push(cur);
  }
  merged.sort((a, b) => a.from - b.from || a.to - b.to || a.t.localeCompare(b.t)
                        || (a.href ?? '').localeCompare(b.href ?? '')
                        || (a.by ?? '').localeCompare(b.by ?? '')
                        || (a.family ?? '').localeCompare(b.family ?? '')
                        || (a.size ?? 0) - (b.size ?? 0));
  return merged;
}

/** Does this mark type cover the WHOLE of [from,to)? */
export function coversAll(marks: Mark[], from: number, to: number, t: MarkType): boolean {
  if (to <= from) return false;
  let at = from;
  for (const m of marks.filter(x => x.t === t).sort((a, b) => a.from - b.from)) {
    if (m.from > at) return false;
    at = Math.max(at, m.to);
    if (at >= to) return true;
  }
  return at >= to;
}

/** Marks active at a caret position — what a toolbar shows as "on". */
export function activeAt(marks: Mark[], at: number): Set<MarkType> {
  const s = new Set<MarkType>();
  for (const m of marks) if (at > m.from && at <= m.to) s.add(m.t);
  return s;
}

export function addMark(marks: Mark[], len: number, m: Mark): Mark[] {
  return normalize([...marks, m], len);
}

/** Remove a mark type across [from,to), splitting any mark that straddles it. */
export function removeMark(marks: Mark[], len: number, from: number, to: number, t: MarkType): Mark[] {
  const out: Mark[] = [];
  for (const m of marks) {
    if (m.t !== t || m.to <= from || m.from >= to) { out.push(m); continue; }
    if (m.from < from) out.push({ ...m, to: from });     // head survives
    if (m.to > to) out.push({ ...m, from: to });         // tail survives
  }
  return normalize(out, len);
}

export interface FontAttrs { family?: string | null; size?: number | null }

/**
 * Set a typeface and/or size across [from,to).
 *
 * Not addMark. A font mark REPLACES the one under it rather than nesting —
 * choosing Verdana over a Georgia run must leave one mark, not two whose
 * winner depends on render order.
 *
 * But the two attributes are INDEPENDENT, and that is the whole subtlety:
 * setting a size across a run that is already Verdana must keep Verdana. So
 * the range is cut at the existing marks' boundaries and each piece keeps what
 * it had, with the new attribute laid over the top. A version that simply
 * dropped the old marks lost the typeface every time someone changed a size.
 *
 * `null` means CLEAR — go back to the document's default — as distinct from
 * `undefined`, which means leave this attribute alone.
 */
export function setFont(marks: Mark[], len: number, from: number, to: number, attrs: FontAttrs): Mark[] {
  if (to <= from) return marks;

  // boundaries of every existing font mark that overlaps the range
  const cuts = new Set<number>([from, to]);
  for (const m of marks) {
    if (m.t !== 'font' || m.to <= from || m.from >= to) continue;
    if (m.from > from) cuts.add(m.from);
    if (m.to < to) cuts.add(m.to);
  }
  const edges = [...cuts].sort((a, b) => a - b);

  // strip the old font marks inside the range, keeping the parts outside it
  const kept = removeMark(marks, len, from, to, 'font');

  const added: Mark[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i], b = edges[i + 1];
    if (b <= a) continue;
    const under = marks.find(m => m.t === 'font' && m.from <= a && m.to >= b);
    const family = attrs.family === undefined ? under?.family : (attrs.family ?? undefined);
    const size = attrs.size === undefined ? under?.size : (attrs.size ?? undefined);
    // a mark carrying neither is not worth storing — the run simply inherits
    if (family === undefined && size === undefined) continue;
    const m: Mark = { t: 'font', from: a, to: b };
    if (family !== undefined) m.family = family;
    if (size !== undefined) m.size = size;
    added.push(m);
  }
  return normalize([...kept, ...added], len);
}

/** The font in force at an offset, if any — what the picker shows. */
export const fontAt = (marks: Mark[], at: number): Mark | undefined =>
  marks.filter(m => m.t === 'font' && m.from <= at && m.to > at).pop();

/**
 * The font across a range: the value if every character agrees, else 'mixed'.
 *
 * A picker that showed the first character's font would silently relabel a
 * three-font selection, and then apply that label to all of it on the next
 * click.
 */
export function fontAcross(marks: Mark[], from: number, to: number):
    { family: string | 'mixed' | undefined; size: number | 'mixed' | undefined } {
  if (to <= from) {
    const m = fontAt(marks, Math.max(0, from - 1));
    return { family: m?.family, size: m?.size };
  }
  let family: string | 'mixed' | undefined;
  let size: number | 'mixed' | undefined;
  for (let i = from; i < to; i++) {
    const m = fontAt(marks, i);
    if (i === from) { family = m?.family; size = m?.size; continue; }
    if (family !== 'mixed' && m?.family !== family) family = 'mixed';
    if (size !== 'mixed' && m?.size !== size) size = 'mixed';
  }
  return { family, size };
}

/** ⌘B semantics: on if any of the range is unmarked, off if all of it is marked. */
export function toggleMark(marks: Mark[], len: number, from: number, to: number,
                           t: MarkType, href?: string): Mark[] {
  if (coversAll(marks, from, to, t)) return removeMark(marks, len, from, to, t);
  return addMark(marks, len, href !== undefined ? { t, from, to, href } : { t, from, to });
}

/**
 * Move marks to follow an edit that replaced [at, at+removed) with `added`
 * characters — the same rule footnote anchors use, deliberately.
 *
 * A mark wholly inside the replaced span is dropped: the text it described is
 * gone. A mark that straddles the edit is clipped rather than dropped, because
 * bolding a sentence and then rewriting three words of it should leave the rest
 * of the sentence bold.
 */
export function shift(marks: Mark[], at: number, removed: number, added: number, len: number): Mark[] {
  const end = at + removed;
  const delta = added - removed;
  const move = (p: number) => p <= at ? p : p >= end ? p + delta : at + Math.min(p - at, added);
  return normalize(marks.map(m => ({ ...m, from: move(m.from), to: move(m.to) })), len);
}

// ─────────────────────────────────────────────────────────── model → HTML

const ESC: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;',
  // `"` MUST be here. Without it an href could close the attribute and open
  // another: a document carrying   href: 'https://x" onmouseover="alert(1)'
  // rendered as <a href="https://x" onmouseover="alert(1)"> — a live event
  // handler, straight out of document data, through the innerHTML in
  // render.ts. Every document is untrusted input, so this needed no user of
  // the link feature at all: a hand-written #bento-doc block, a pasted <a>
  // (fromDom copies the attribute verbatim), or a sync op would do.
  '"': '&quot;', "'": '&#39;',
};
// TEXT and ATTRIBUTE are different contexts and need different escaping.
// Widening the text escaper to cover quotes was wrong: it turned a plain `"`
// in a sentence into `&quot;` in the output, which the round-trip rig caught
// immediately. Text needs & < > ; an attribute value needs the quotes as well,
// because those are what end it.
const esc = (s: string) => s.replace(/[&<>]/g, c => ESC[c]);
const escAttr = (s: string) => s.replace(/[&<>"']/g, c => ESC[c]);

/**
 * An href safe to put in the document's HTML.
 *
 * The check belongs HERE, at the render boundary, not only in whatever UI made
 * the mark: a mark carrying `javascript:alert(1)` rendered as a live
 * javascript: anchor, and the UI is not the only way a mark enters a document.
 *
 * Allowed: http(s), mailto, tel, a fragment, and relative paths. Anything else
 * renders with NO href at all, so the words survive and only the navigation is
 * lost — refusing beats guessing.
 */
const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|#|\/|\.{1,2}\/|[^:]*$)/i;
export const safeHref = (raw: string): string | null => {
  // Control characters are stripped first: they are how a tab inside
  // "java<tab>script:" slips past a check that only looks at the start.
  const flat = raw.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return SAFE_HREF.test(flat) ? flat : null;
};

/**
 * A font stack safe to put in a `style` attribute.
 *
 * This is the SAME class of hole as a link href, and it arrives the same way:
 * `family` is document data, a document is untrusted input, and it is being
 * written into CSS rather than into text. A family of
 *
 *   Georgia; background: url(https://tracker/x.png
 *
 * would close the declaration and open another — an off-document fetch from
 * opening a file. So this is an ALLOW-LIST of what a font stack can contain:
 * letters, digits, spaces, hyphens, underscores, commas and quotes. No
 * semicolons, no parentheses, no colons, so neither another declaration nor a
 * url() can be formed. Anything else and the family is dropped and the run
 * renders in the document's default, which loses a typeface and nothing more.
 */
const SAFE_FAMILY = /^[\w \-,'"]{1,120}$/;
export const safeFamily = (raw: string | undefined): string | null => {
  const f = (raw ?? '').trim();
  return f && SAFE_FAMILY.test(f) ? f : null;
};

/** A size in px, or null. Clamped rather than refused — 0.5px is not an attack. */
export const safeSize = (raw: number | undefined): number | null => {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const n = Math.round(raw * 10) / 10;
  return n >= 4 && n <= 200 ? n : null;
};

/** The style attribute for a font mark — '' when it would carry nothing. */
export function fontStyle(m: Mark): string {
  const parts: string[] = [];
  const fam = safeFamily(m.family);
  if (fam) parts.push(`font-family:${fam}`);
  const size = safeSize(m.size);
  if (size !== null) parts.push(`font-size:${size}px`);
  return parts.join(';');
}

const openTag = (m: Mark) => {
  if (m.t === 'font') {
    const style = fontStyle(m);
    // A font mark carrying nothing usable still renders its span, so the text
    // inside it is never lost — only its styling.
    // The VALUES ride as data attributes as well as in the style. fromDom reads
    // them back on every keystroke, and recovering a family by parsing the CSS
    // it just wrote would be a second, lossier parser for data this module
    // already has.
    const fam = safeFamily(m.family);
    const size = safeSize(m.size);
    const data = (fam ? ` data-family="${escAttr(fam)}"` : '') + (size !== null ? ` data-size="${size}"` : '');
    return style ? `<span class="t-font"${data} style="${escAttr(style)}">` : `<span class="t-font"${data}>`;
  }
  if (m.t === 'ins' || m.t === 'del') {
    // The author and time ride on the element so the UI can group changes and
    // show whose they are without a second lookup. escAttr, not esc: `by` is
    // document data, and a name containing a quote would otherwise close the
    // attribute — the same hole that link hrefs had.
    const who = m.by ? ` data-by="${escAttr(m.by)}"` : '';
    const when = m.at ? ` data-at="${escAttr(m.at)}"` : '';
    const title = m.by ? ` title="${escAttr(m.t === 'ins' ? `Inserted by ${m.by}` : `Deleted by ${m.by}`)}"` : '';
    return `<${TAG[m.t]} class="t-trk"${who}${when}${title}>`;
  }
  if (m.t !== 'link') return `<${TAG[m.t]}>`;
  const href = safeHref(m.href ?? '');
  return href === null ? '<a>' : `<a href="${escAttr(href)}">`;
};
const closeTag = (m: Mark) => m.t === 'link' ? '</a>' : `</${TAG[m.t]}>`;

/**
 * Render text + marks as HTML.
 *
 * Marks are ranges and may overlap partially (bold from 0–10, italic from 5–15),
 * which HTML cannot express without splitting. The walk keeps a stack of open
 * tags and only closes what actually ends, so properly nested marks produce
 * minimal markup and partially overlapping ones are split — correct either way.
 *
 * `inject` lets the caller drop non-text atoms (footnote markers) at exact
 * offsets without them entering the text or the mark arithmetic.
 */
/** A span of the text replaced WHOLESALE by ready-made HTML. */
export interface HtmlRange { from: number; to: number; html: string }

export function toHtml(
  text: string,
  marks: Mark[] = [],
  inject?: Map<number, string>,
  ranges?: HtmlRange[],
): string {
  const ms = normalize(marks, text.length);
  const cuts = new Set<number>([0, text.length]);
  for (const m of ms) { cuts.add(m.from); cuts.add(m.to); }
  if (inject) for (const k of inject.keys()) cuts.add(Math.max(0, Math.min(k, text.length)));
  // A replaced range must start and end on a cut, or its boundary would fall
  // inside a segment and the replacement would land mid-tag.
  const reps = (ranges ?? [])
    .filter(r => r.from >= 0 && r.to <= text.length && r.to > r.from)
    .sort((a, b) => a.from - b.from);
  for (const r of reps) { cuts.add(r.from); cuts.add(r.to); }
  const points = [...cuts].sort((a, b) => a - b);

  // The nesting order a segment WANTS: outermost is the mark that began
  // earliest, then the one that runs longest. Deterministic, so the same
  // formatting always renders the same bytes — which the signature relies on.
  const wanted = (at: number) => ms
    .filter(m => m.from <= at && m.to > at)
    .sort((a, b) => a.from - b.from || b.to - a.to || a.t.localeCompare(b.t));

  let out = '';
  let open: Mark[] = [];
  for (let i = 0; i < points.length; i++) {
    const at = points[i];
    const want = i === points.length - 1 ? [] : wanted(at);
    // Reconcile the open stack with the wanted one: keep the common prefix,
    // close the rest, open what is missing.
    //
    // The first version instead closed a tag whenever a longer-running mark
    // needed to go outside it, and never reopened it — so bold 0–12 under
    // italic 6–20 rendered as bold 0–6, silently truncating the author's
    // formatting on every re-render. Reconciling against a wanted stack cannot
    // lose a mark: anything still active is either kept or reopened.
    let k = 0;
    while (k < open.length && k < want.length && open[k] === want[k]) k++;
    while (open.length > k) out += closeTag(open.pop()!);
    for (; k < want.length; k++) { out += openTag(want[k]); open.push(want[k]); }
    if (inject?.has(at)) out += inject.get(at)!;
    if (i === points.length - 1) break;
    // A REPLACED range emits its ready-made HTML instead of its characters.
    // Its marks are still open around it, so `\frac12` inside a bold run is
    // typeset and bold — the source is never shown and never escaped as text.
    const rep = reps.find(r => r.from === at);
    out += rep ? rep.html : esc(text.slice(at, points[i + 1]));
  }
  while (open.length) out += closeTag(open.pop()!);
  return out;
}

// ─────────────────────────────────────────────────────────── HTML → model

export interface Parsed { text: string; marks: Mark[]; atoms: Array<{ at: number; el: Element }>; }

/**
 * Read a rendered block back into text + marks.
 *
 * Only tags this module emits are understood; anything else contributes its
 * text and no formatting. That is the security posture as well as the
 * simplicity one — pasted markup cannot introduce a construct the model has no
 * word for, because there is nowhere to put it.
 *
 * `isAtom` marks elements (footnote references) that are not text at all: their
 * position is recorded and they contribute no characters.
 */
export function fromDom(root: Node, isAtom: (el: Element) => boolean = () => false): Parsed {
  let text = '';
  const marks: Mark[] = [];
  const atoms: Array<{ at: number; el: Element }> = [];

  const walk = (node: Node, active: Array<{ t: MarkType; href?: string; from: number }>) => {
    for (const child of Array.from(node.childNodes)) {
      // numeric node types, not Node.TEXT_NODE: `Node` is a browser global and
      // this module has to run under `node` for the round-trip rig to be a CI
      // gate at all. (A module that only works in one of the two environments
      // passes every test in the other — that has already cost this project a
      // release-blocking bug once.)
      if (child.nodeType === 3) { text += child.nodeValue ?? ''; continue; }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      if (isAtom(el)) { atoms.push({ at: text.length, el }); continue; }
      const tag = el.tagName.toLowerCase();
      // A mark that carries a PAYLOAD has to be recognised here or the payload
      // is lost the moment anyone types in the paragraph — the editor reads a
      // block back out of the DOM on every keystroke.
      //
      // This was a live bug for tracked changes before fonts existed: <ins>
      // was in no map at all and vanished, and <del> mapped to a plain
      // strikethrough, so a tracked deletion came back as ordinary struck text
      // with its author and timestamp gone. `data-*` is checked rather than
      // the tag alone so that a <del> PASTED from elsewhere still means
      // strikethrough, which is what it means everywhere else on the web.
      const trk = el.classList?.contains('t-trk') && (tag === 'ins' || tag === 'del');
      const isFont = tag === 'span' && el.classList?.contains('t-font');
      const t = trk ? (tag as 'ins' | 'del') : isFont ? 'font' : BY_TAG[tag];
      if (!t) { walk(el, active); continue; }
      const start = text.length;
      const href = t === 'link' ? (el.getAttribute('href') ?? '') : undefined;
      walk(el, active);
      if (text.length > start) {
        const m: Mark = { t, from: start, to: text.length };
        if (href !== undefined) m.href = href;
        if (trk) {
          const by = el.getAttribute('data-by');
          const at = el.getAttribute('data-at');
          if (by) m.by = by;
          if (at) m.at = at;
        }
        if (isFont) {
          const fam = el.getAttribute('data-family');
          const size = Number(el.getAttribute('data-size'));
          if (fam) m.family = fam;
          if (Number.isFinite(size) && size > 0) m.size = size;
          // a span carrying neither is not a font mark, just a span
          if (m.family === undefined && m.size === undefined) continue;
        }
        marks.push(m);
      }
    }
  };
  walk(root, []);
  return { text, marks: normalize(marks, text.length), atoms };
}

/** Plain text of a block, for diffing, measuring and search. */
export const plain = (text: string) => text;
