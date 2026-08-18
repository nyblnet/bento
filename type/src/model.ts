// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The bento/type document model. This JSON is what lives inside the #bento-doc
// block — the format IS the product (docs/PLATFORM.md §3).
//
// The shape of a document here is deliberately narrow: a flat, ordered list of
// blocks, each holding PLAIN TEXT plus marks over character ranges (see
// inline.ts for why that spine and not HTML). No nesting, no inline nodes, no
// tree. A word processor's document is a stream of prose that gets poured into
// pages; the structure lives in the block kinds and in the pagination, not in
// the container.

import { normalize, shift as shiftMarks, type Mark } from './inline.ts';
// value import is safe: xref.ts imports only TYPES from this module, precisely
// so the core can call into it without a cycle
import { shiftRefs } from './xref.ts';

export const FORMAT = 'bento/type';
export const VERSION = 1;

/** The kinds of block a document is made of. */
export type BlockKind = 'para' | 'h1' | 'h2' | 'h3' | 'quote' | 'ul' | 'ol' | 'cell' | 'image' | 'caption';

/**
 * Where a table cell sits. Carried on EVERY cell of the table, not on a table
 * block — because there is no table block.
 *
 * A CELL IS A BLOCK, for the same reason a list item is one, and here the
 * reason is sharper: the redline aligns on block ids, so per-cell blocks give
 * per-cell review. A table as a single block would report "the payment table
 * changed" when one figure moved — which is precisely the failure that makes
 * line diffs useless on prose, and the limitation bento/slides documents for
 * its own tables. For an app whose differentiator is redlining contracts, that
 * is the wrong trade.
 *
 * `cols` is repeated on every cell rather than stored once. It is redundant and
 * that is the point: there is no header block to lose, so a grid can always be
 * rebuilt from any run of cells, and a file that disagrees with itself is
 * repaired to the majority rather than being unreadable.
 */
export interface CellRef {
  /** which table this cell belongs to — consecutive cells sharing it group */
  table: string;
  /** the table's column count */
  cols: number;
  /** cells of the first row, rendered as <th> */
  head?: boolean;
}

/**
 * A picture in the document.
 *
 * `src` is a data: URI (embedded, so the file stays self-contained) or an
 * external URL (referenced, so the file stays small). Embedding is the default
 * because the whole promise is that one file IS the document — a reference that
 * breaks when the document is emailed is a worse failure than a large file.
 *
 * `w` is a fraction of the text measure (0–1), not pixels: the page size is a
 * document property that can change, and an image sized in pixels would stop
 * fitting the moment somebody switched to A4.
 */
export interface ImageRef {
  src: string;
  alt?: string;
  /** width as a fraction of the text column, default 1 */
  w?: number;
  align?: 'left' | 'center' | 'right';
}

/**
 * A caption, and what it captions.
 *
 * A BLOCK, not a field on the table — because there IS no table block to hang
 * one on (a table is a run of `cell` blocks sharing an id), and a caption needs
 * its own stable id anyway: that id is what a reference points at, and what the
 * redline aligns on so an edited caption reports as an edited caption.
 */
export interface CaptionRef { kind: 'table' | 'figure'; of?: string }

/** A cross-reference: an atom at an offset, exactly like a footnote anchor. */
export interface XrefRef { to: string; at: number; style?: 'label' | 'page' | 'both' }

/** Above this an embedded image is refused, and a URL offered instead. */
export const IMAGE_EMBED_BUDGET = 4 * 1024 * 1024;

/**
 * Sources an image may have.
 *
 * A document is UNTRUSTED INPUT (docs/DECISIONS.md), and `src` goes straight
 * into an <img>. `javascript:` is the obvious attack and is not the only one —
 * anything that is not plainly an image reference is refused rather than
 * guessed at.
 */
export const SAFE_IMG = /^(data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]|https?:\/\/|\.{0,2}\/)/i;

/** The list kinds, which are the ones that carry `level` and group when rendered. */
export const LIST_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>(['ul', 'ol']);
export const isList = (k: BlockKind): boolean => LIST_KINDS.has(k);

/** How deep a list item may be nested. Beyond this the indents stop reading as
 *  structure and start reading as a mistake. */
export const MAX_LIST_LEVEL = 5;

/** Columns beyond this stop being a table and start being a spreadsheet. */
export const MAX_TABLE_COLS = 20;

/** A footnote reference anchored INTO a block's text, by character offset. */
export interface NoteRef { id: string; at: number }

export interface Block {
  /** stable identity: the redline aligns on it, so it must never be re-minted
   *  for a block the author considers the same paragraph */
  id: string;
  kind: BlockKind;
  /** the block's text, with no markup of any kind in it */
  text: string;
  /** formatting over character ranges; absent means none */
  marks?: Mark[];
  /** footnote references, by offset into `text` */
  notes?: NoteRef[];
  /** authoring role, for restyling and for a table of contents */
  role?: string;
  /**
   * Nesting depth for a list item, 0-based. Absent means 0, and it means
   * nothing on a block that is not a list.
   *
   * A LIST ITEM IS A BLOCK, and the list itself is not in the model at all —
   * runs of adjacent `ul`/`ol` blocks are grouped into real <ul>/<ol> elements
   * at RENDER time. That keeps the document flat, which is not a stylistic
   * preference: the redline aligns on block ids, the caret is (blockId,
   * offset), and pagination measures line boxes through a tree walker. A
   * nested list model would have put a tree under all three, and each of them
   * is correct today because there is no tree.
   */
  level?: number;
  /** table placement; only meaningful on a `cell` block */
  cell?: CellRef;
  /** the picture; only meaningful on an `image` block */
  image?: ImageRef;
  /** caption placement; only meaningful on a `caption` block */
  caption?: CaptionRef;
  /** cross-references, by offset into `text` — atoms, like `notes` */
  refs?: XrefRef[];
}

/** Page geometry, in CSS px at 96dpi. US Letter by default. */
export interface PageSpec {
  width: number; height: number;
  marginX: number; marginTop: number; marginBottom: number;
}
export const LETTER: PageSpec = {
  width: 816, height: 1056, marginX: 104, marginTop: 104, marginBottom: 104,
};

export interface Signature {
  alg: 'ES256';
  /** raw P-256 public key, base64url — the identity. The name is only a claim. */
  pub: string;
  /** self-asserted, shown beside the signature and NOT proof of anything */
  name: string;
  /** digest of the canonical content at the moment of signing */
  content: string;
  /** the signature this one commits to, chaining the order */
  prev: string;
  sig: string;
  /** self-asserted wall clock. Display only — order comes from `prev`. */
  at?: string;
}

/** A recorded revision, kept so a redline can be produced with no server. */
export interface Revision {
  id: string; at: string; label: string;
  body: Block[];
}

export interface TypeDoc {
  format: typeof FORMAT;
  version: number;
  /** minted once at creation, NEVER regenerated (PLATFORM §3) */
  docId: string;
  title: string;
  subtitle?: string;
  meta?: { author?: string; company?: string; subject?: string; keywords?: string };
  page: PageSpec;
  body: Block[];
  /** note id → note text. Kept out of the blocks so a note can outlive a
   *  re-flow of the paragraph that references it. */
  footnotes: Record<string, string>;
  revisions: Revision[];
  signatures: Signature[];
  fonts?: Array<{ family: string; asset: string; weight?: string; style?: string }>;
  assets?: Record<string, string>;
  readonly?: boolean;
  template?: boolean;
  /** volatile, never signed */
  modified?: string;
  /** unknown fields are PRESERVED — format additivity (PLATFORM §3) */
  [extra: string]: unknown;
}

export const uid = (p = 'b'): string => {
  const r = globalThis.crypto?.randomUUID?.();
  return r ? `${p}-${r.slice(0, 8)}` : `${p}-${Math.random().toString(36).slice(2, 10)}`;
};
export const newDocId = (): string => globalThis.crypto?.randomUUID?.() ?? uid('doc');

export function emptyDoc(): TypeDoc {
  return {
    format: FORMAT, version: VERSION, docId: newDocId(),
    title: 'Untitled', page: { ...LETTER },
    body: [{ id: uid(), kind: 'para', text: '' }],
    footnotes: {}, revisions: [], signatures: [],
  };
}

/**
 * Parse result — TAGGED, never null.
 *
 * Following bento/spaces, which learned this the hard way: a `parseDoc` that
 * returns null lets the caller fall back to the starter document, so opening a
 * file from another app, or one with a single hand-edited typo, silently
 * presents an EMPTY document over live data — and the first ⌘S writes it to
 * disk. The only path to a starter is an absent or empty block.
 */
export type ParseResult =
  | { ok: true; doc: TypeDoc; repaired: string[] }
  | { ok: false; err: 'empty' }
  | { ok: false; err: 'json' | 'format' | 'shape'; detail: string; found?: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Read a document, repairing what can be repaired from the BYTES ALONE.
 *
 * Repairs are deterministic so that two readers of one file agree on every id —
 * the redline aligns blocks by id, and two parties whose copies disagree would
 * see phantom changes.
 */
export function parseDoc(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, err: 'empty' };

  let json: unknown;
  try { json = JSON.parse(trimmed); }
  catch (e) { return { ok: false, err: 'json', detail: (e as Error).message }; }
  if (!isObj(json)) return { ok: false, err: 'shape', detail: 'the document is not an object' };

  const found = typeof json.format === 'string' ? json.format : undefined;
  if (found !== FORMAT) {
    return { ok: false, err: 'format',
             detail: `this file is ${found ? `a ${found} document` : 'not a Bento document'}`, found };
  }
  if (!Array.isArray(json.body)) return { ok: false, err: 'shape', detail: 'body is missing' };

  const repaired: string[] = [];
  const seen = new Set<string>();
  const body: Block[] = [];
  (json.body as unknown[]).forEach((b, i) => {
    if (!isObj(b)) { repaired.push(`dropped a block at ${i} that was not an object`); return; }
    const kind: BlockKind = ['para', 'h1', 'h2', 'h3', 'quote', 'ul', 'ol', 'cell', 'image', 'caption'].includes(b.kind as string)
      ? b.kind as BlockKind : 'para';
    if (kind !== b.kind) repaired.push(`block ${i}: unknown kind ${JSON.stringify(b.kind)} read as a paragraph`);
    const text = typeof b.text === 'string' ? b.text : '';
    // ids must be unique: the redline aligns on them, so a duplicate makes one
    // paragraph invisible to review. Derive the replacement from position, so
    // every reader of these bytes repairs it identically.
    let id = typeof b.id === 'string' && b.id ? b.id : `b${i}`;
    if (seen.has(id)) { id = `${id}~${i}`; repaired.push(`block ${i}: duplicate id repaired to ${id}`); }
    seen.add(id);

    const marks = Array.isArray(b.marks)
      ? normalize((b.marks as Mark[]).filter(m => isObj(m) && typeof m.from === 'number'
                                                 && typeof m.to === 'number' && typeof m.t === 'string'), text.length)
      : undefined;
    const notes = Array.isArray(b.notes)
      ? (b.notes as NoteRef[]).filter(n => isObj(n) && typeof n.id === 'string' && typeof n.at === 'number')
          .map(n => ({ id: n.id, at: Math.max(0, Math.min(n.at, text.length)) }))
          .sort((x, y) => x.at - y.at)
      : undefined;

    const out: Block = { id, kind, text };
    if (marks?.length) out.marks = marks;
    if (notes?.length) out.notes = notes;
    if (typeof b.role === 'string') out.role = b.role;
    // `level` is clamped and only kept on list kinds. A level on a paragraph
    // would be silently meaningless, and a level of 40 would render as a list
    // indented off the page — both are files a generator can produce.
    if (isList(kind) && typeof b.level === 'number' && Number.isFinite(b.level)) {
      const lv = Math.max(0, Math.min(MAX_LIST_LEVEL, Math.floor(b.level)));
      if (lv !== b.level) repaired.push(`block ${i}: list level ${b.level} clamped to ${lv}`);
      if (lv > 0) out.level = lv;
    }
    // A cell without a usable `cell` ref is not a cell — it becomes a paragraph
    // rather than a block the renderer has to guess about. Repaired loudly:
    // silently dropping a table is worse than saying the table was lost.
    if (kind === 'cell') {
      const c = isObj(b.cell) ? b.cell as Partial<CellRef> : undefined;
      const cols = typeof c?.cols === 'number' && c.cols >= 1 ? Math.min(Math.floor(c.cols), MAX_TABLE_COLS) : 0;
      if (c && typeof c.table === 'string' && c.table && cols) {
        out.cell = { table: c.table, cols };
        if (c.head === true) out.cell.head = true;
        if (cols !== c.cols) repaired.push(`block ${i}: table columns ${c.cols} clamped to ${cols}`);
      } else {
        out.kind = 'para';
        repaired.push(`block ${i}: table cell with no usable placement read as a paragraph`);
      }
    }
    // An image with no usable src is not an image. Repaired to a paragraph
    // carrying its alt text, so the words survive even when the picture does
    // not — a silently vanished figure is the worse outcome.
    if (kind === 'image') {
      const im = isObj(b.image) ? b.image as Partial<ImageRef> : undefined;
      if (im && typeof im.src === 'string' && im.src && SAFE_IMG.test(im.src)) {
        out.image = { src: im.src };
        if (typeof im.alt === 'string') out.image.alt = im.alt;
        if (typeof im.w === 'number' && im.w > 0 && im.w <= 1) out.image.w = im.w;
        else if (im.w !== undefined) {
          // Dropped rather than clamped: `w` is a FRACTION of the measure, so a
          // value outside 0–1 is not a big number, it is a different unit —
          // most likely pixels — and guessing which would be worse than
          // falling back to full width. Reported, because a silent repair is
          // one the author cannot learn from.
          repaired.push(`block ${i}: image width ${JSON.stringify(im.w)} is not a fraction of the measure — using full width`);
        }
        if (im.align === 'left' || im.align === 'center' || im.align === 'right') out.image.align = im.align;
      } else {
        out.kind = 'para';
        if (!out.text && typeof im?.alt === 'string') out.text = im.alt;
        repaired.push(`block ${i}: image with no usable source read as a paragraph`);
      }
    }
    if (kind === 'caption') {
      const c = isObj(b.caption) ? b.caption as Partial<CaptionRef> : undefined;
      out.caption = { kind: c?.kind === 'figure' ? 'figure' : 'table',
                      ...(typeof c?.of === 'string' && c.of ? { of: c.of } : {}) };
    }
    // A dangling REFERENCE is kept, deliberately unlike a dangling note. A
    // marker with no note behind it renders as a number pointing at nothing, so
    // notes are dropped. A reference is the opposite case: the author wrote
    // "see <that table>" and the table was deleted. Dropping it silently
    // deletes the sentence's meaning and leaves prose reading "see ." Keeping
    // it renders a visible ?? that says something must be fixed — the LaTeX
    // behaviour, and the only safe one.
    const refs = Array.isArray(b.refs)
      ? (b.refs as XrefRef[]).filter(r => isObj(r) && typeof r.to === 'string' && typeof r.at === 'number')
          .map(r => ({ to: r.to, at: Math.max(0, Math.min(r.at, text.length)),
                       ...(r.style === 'page' || r.style === 'both' ? { style: r.style } : {}) }))
          .sort((x, y) => x.at - y.at)
      : undefined;
    if (refs?.length) out.refs = refs;
    body.push(out);
  });
  if (!body.length) body.push({ id: uid(), kind: 'para', text: '' });

  const footnotes: Record<string, string> = {};
  if (isObj(json.footnotes)) {
    for (const [k, v] of Object.entries(json.footnotes)) if (typeof v === 'string') footnotes[k] = v;
  }
  // a reference to a note that is not there would render as a marker with
  // nothing behind it — drop the reference, keep the text
  let dangling = 0;
  for (const b of body) {
    if (!b.notes) continue;
    const keep = b.notes.filter(n => footnotes[n.id] !== undefined);
    if (keep.length !== b.notes.length) dangling += b.notes.length - keep.length;
    if (keep.length) b.notes = keep; else delete b.notes;
  }
  if (dangling) repaired.push(`dropped ${dangling} footnote reference(s) with no note behind them`);

  const doc: TypeDoc = {
    ...(json as object) as TypeDoc,          // unknown fields ride along
    format: FORMAT,
    version: typeof json.version === 'number' ? json.version : VERSION,
    docId: typeof json.docId === 'string' && json.docId ? json.docId : newDocId(),
    title: typeof json.title === 'string' ? json.title : 'Untitled',
    page: isObj(json.page) ? { ...LETTER, ...(json.page as object) } as PageSpec : { ...LETTER },
    body, footnotes,
    revisions: Array.isArray(json.revisions) ? json.revisions as Revision[] : [],
    signatures: Array.isArray(json.signatures) ? json.signatures as Signature[] : [],
  };
  if (typeof json.docId !== 'string' || !json.docId) repaired.push('minted a missing docId');
  return { ok: true, doc, repaired };
}

/** The document's text, in order — what gets measured, searched and diffed. */
export const plainText = (doc: TypeDoc): string => doc.body.map(b => b.text).join('\n');

export const wordCount = (doc: TypeDoc): number =>
  doc.body.reduce((n, b) => n + (b.text.trim() ? b.text.trim().split(/\s+/).length : 0), 0);

/**
 * Replace [at, at+removed) of a block's text with `added`, keeping marks and
 * footnote anchors pointing at the same words.
 *
 * One function, because these two must move together: they are offsets into the
 * same string, and a version of this that updated only one of them is exactly
 * the bug that put a footnote marker in the middle of a word during the spike.
 */
export function spliceText(block: Block, at: number, removed: number, added: string): Block {
  const text = block.text.slice(0, at) + added + block.text.slice(at + removed);
  const out: Block = { ...block, text };
  if (block.marks?.length) {
    const m = shiftMarks(block.marks, at, removed, added.length, text.length);
    if (m.length) out.marks = m; else delete out.marks;
  }
  if (block.refs?.length) {
    const r = shiftRefs(block.refs, at, removed, added.length);
    if (r.length) out.refs = r; else delete out.refs;
  }
  if (block.notes?.length) {
    const end = at + removed;
    const delta = added.length - removed;
    const n = block.notes
      .filter(x => !(x.at > at && x.at < end))          // its anchor text is gone
      .map(x => x.at >= end ? { ...x, at: x.at + delta } : x);
    if (n.length) out.notes = n; else delete out.notes;
  }
  return out;
}
