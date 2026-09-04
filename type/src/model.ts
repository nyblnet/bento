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
import { readThreadsRaw, reconcileThreads } from './comments.ts';

export const FORMAT = 'bento/type';
export const VERSION = 1;

/** The kinds of block a document is made of. */
export type BlockKind = 'para' | 'h1' | 'h2' | 'h3' | 'quote' | 'ul' | 'ol' | 'cell' | 'image' | 'caption' | 'toc' | 'math' | 'embed';

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

/**
 * A citation: an atom at an offset, like a footnote anchor.
 *
 * `keys` is a LIST because "(Knuth 1984; Lamport 1994)" is one citation at one
 * position, not two adjacent ones.
 */
export interface CiteRef { at: number; keys: string[]; locator?: string; suppressAuthor?: boolean }

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

/**
 * A review comment: a thread anchored to a RANGE of a block's text.
 *
 * Doc-level and keyed by id, like `footnotes`, because a thread must be able to
 * outlive the block it points at — the conversation about a deleted clause is
 * exactly the conversation you still need.
 */
export interface CommentMsg { id: string; author: string; at: string; text: string }
export interface CommentThread {
  id: string; block: string; from: number; to: number;
  quote: string; messages: CommentMsg[];
  resolved?: boolean; orphan?: boolean;
}

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
  /** citations, by offset into `text` — atoms, like `notes` */
  cites?: CiteRef[];

  /**
   * A named style this block carries BY REFERENCE — see docstyles.ts.
   *
   * Absent means "whatever `kind` implies by default", which is itself a named
   * style (docstyles.ts's built-ins, keyed by kind) rather than special-cased —
   * so editing "Heading 1" restyles every h1 that never set this field, which
   * is the whole point of a styles system. A block that sets `styleId` opts
   * INTO a different named look than its kind's default; it does not opt out
   * of styling altogether.
   */
  styleId?: string;

  // ---- paragraph layout. ABSENT MEANS "the document's default", never a
  // value: a paragraph with no `align` is justified because the DOCUMENT says
  // so, and setting the current default deletes the field rather than writing
  // it. That is what keeps a restyled document from carrying ten thousand
  // copies of its own defaults.
  align?: 'left' | 'center' | 'right' | 'justify';
  /** space before, px */   sb?: number;
  /** space after, px */    sa?: number;
  /** line spacing, a multiple of the font size */ lh?: number;
  /** first-line indent, px */ ind?: number;
  keepNext?: true; keepTogether?: true; breakBefore?: true;

  /** Unknown fields ride through untouched — format additivity, PLATFORM §3. */
  [extra: string]: unknown;
}

/** Page geometry, in CSS px at 96dpi. US Letter by default. */
export interface PageSpec {
  width: number; height: number;
  marginX: number; marginTop: number; marginBottom: number;
  /** absent means `marginX`, so a symmetric page keeps writing one field */
  marginLeft?: number; marginRight?: number;
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

/**
 * A named paragraph style — what Word calls "Heading 1": a bundle of
 * typography a block can carry BY REFERENCE (`Block.styleId`) instead of by
 * repeating every property on itself. See docstyles.ts for resolution
 * (built-ins, kind defaults, the panel that edits these) and render.ts /
 * print.ts for where the bundle becomes CSS.
 *
 * `align`/`sb`/`sa`/`lh`/`ind` are the SAME vocabulary `Block` already has —
 * a style is those five properties stored once and shared, not a parallel
 * dialect. `family`/`size`/`weight`/`italic`/`color` are new: nothing before
 * this let a document say what a heading looks like at all.
 */
export interface DocStyle {
  id: string;
  name: string;
  /** the block kind this style is FOR — informs the panel, never enforced:
   *  nothing stops a style meant for h2 being applied to a quote */
  kind: BlockKind;
  /** a CSS font stack, like `TypeDoc.type.family` — no font files, no downloads */
  family?: string;
  /** px */ size?: number;
  /** 100–900, CSS `font-weight` */ weight?: number;
  italic?: boolean;
  /** a CSS colour — hex, rgb()/rgba(), hsl()/hsla(), or a named colour */
  color?: string;
  align?: Block['align'];
  /** space before, px */   sb?: number;
  /** space after, px */    sa?: number;
  /** line spacing, a multiple of the font size */ lh?: number;
  /** first-line indent, px */ ind?: number;
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
  /** review threads, by id — see CommentThread */
  comments?: Record<string, CommentThread>;
  /** document-wide paragraph defaults; absent means the built-in ones */
  layout?: { align?: Block['align']; sb?: number; sa?: number; lh?: number; ind?: number };
  /**
   * Named styles, by id — see DocStyle.
   *
   * Absent means every kind renders through docstyles.ts's built-in table,
   * which is derived from styles.css exactly, so a document that never opened
   * the Styles panel prints byte-for-byte what it always did. An entry here
   * OVERRIDES the built-in of the same id (materialized the first time a
   * built-in is edited); a document may also define ids the built-ins do not.
   */
  styles?: Record<string, DocStyle>;
  /**
   * The document's typeface and base size.
   *
   * A DOCUMENT property, not a viewer preference: a contract is typeset, and
   * the person who wrote it chose how it reads on paper. The theme follows the
   * reader; the typeface does not.
   *
   * `family` is a CSS font stack, not a single name, and the choices are stacks
   * that resolve on every platform without shipping a font file — a
   * self-contained document cannot rely on a download, and an embedded face is
   * the separate `fonts` field. `size` is px, the unit the page geometry is
   * already in.
   */
  type?: { family?: string; size?: number };
  revisions: Revision[];
  signatures: Signature[];
  /**
   * Is the document recording edits as tracked changes?
   *
   * DOCUMENT-level, not a viewer preference — unlike the locale, reduced motion
   * or hidden comments. Whether edits are recorded is a property of the
   * agreement everyone is working on: if it were per-viewer, one collaborator
   * would silently make untracked edits to a document another believes is
   * fully tracked, which is the one failure a tracked document cannot have.
   *
   * Absent means off, so every file written before this existed is untracked
   * and reads identically.
   */
  track?: boolean;
  fonts?: Array<{ family: string; asset: string; weight?: string; style?: string }>;
  assets?: Record<string, string>;
  readonly?: boolean;
  template?: boolean;
  /** volatile, never signed */
  modified?: string;
  /**
   * Live-collaboration credentials (bento-sync), minted AT CREATION so any
   * copy of the file can join once sharing is turned on. `room` is the relay
   * WebSocket URL (a random id committed to the owner pubkey — never derived
   * from docId), `key` the base64url AES-GCM room read key. `on` gates
   * auto-join: absent = true. `sync` is the saved CRDT state, stamped at
   * save-time on shared documents, so an offline-edited copy rejoins as a
   * true fork. See docs/collab-design.md and type/src/sync/session.ts.
   *
   * type mints v2 (fine-grained access) credentials ONLY — there is no
   * pre-v2 history to carry forward, unlike bento/slides. The room commits to
   * an OWNER pubkey; a shared copy carries an owner-signed INVITE instead of
   * `ownerPriv`, and each device mints its own member identity (kept in
   * localStorage, never in the file).
   */
  collab?: {
    room: string;
    key: string;
    on?: boolean;
    sync?: import('./sync/crdt.ts').SyncStateJSON;
    v?: number;
    owner?: string;
    ownerPriv?: string;
    /** 'reader' = this copy is a live viewer: receives updates, never sends. */
    role?: 'writer' | 'reader';
    invite?: {
      pub: string;
      priv: string;
      role: 'writer' | 'commenter';
      /** unix ms expiry; 0/absent = no expiry */
      exp?: number;
      /** owner's signature over `inv.${pub}.${role}.${exp||0}` */
      sig: string;
    };
  };
  /** unknown fields are PRESERVED — format additivity (PLATFORM §3) */
  [extra: string]: unknown;
}

/**
 * The document as it should leave this app — WITHOUT its collaboration
 * credentials.
 *
 * `doc.collab` carries `ownerPriv`, `writerPriv` and the room key: private
 * keys and a read capability. Anything that leaves the app as text — the
 * clipboard, an agent hand-off — must not carry them, or pasting "the
 * document JSON" into a chat hands over write access to a live room, which is
 * not revocable by deleting the message.
 *
 * It strips by REMOVING the field rather than by listing the fields to keep,
 * deliberately: a private field added to CollabCreds later is then covered
 * without anyone remembering to update this. scripts/test-export-secrets.ts
 * asserts that shape across every app that has a clipboard export.
 */
export function docForExport(doc: TypeDoc): TypeDoc {
  const { collab, ...rest } = doc as TypeDoc & { collab?: unknown };
  void collab;
  return rest as TypeDoc;
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
    const kind: BlockKind = ['para', 'h1', 'h2', 'h3', 'quote', 'ul', 'ol', 'cell', 'image', 'caption', 'toc', 'math', 'embed'].includes(b.kind as string)
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

    // START FROM THE INCOMING BLOCK, then overwrite what we validate.
    //
    // This used to be `{ id, kind, text }`, which silently DROPPED every
    // block-level field this build does not know about — while doc-level
    // unknowns survived on the object spread above. That breaks format
    // additivity (PLATFORM §3) exactly where a word processor's additive
    // fields land: a document written by a newer build, opened and saved by an
    // older one, came back with its paragraph alignment, its page-break hints
    // and anything else newer quietly deleted. Nothing announced it.
    //
    // Known fields are still validated and repaired below; unknown ones ride
    // through untouched, which is the whole promise.
    const out: Block = { ...(b as Partial<Block>), id, kind, text } as Block;
    if (marks?.length) out.marks = marks; else delete out.marks;
    if (notes?.length) out.notes = notes; else delete out.notes;
    if (typeof b.role !== 'string') delete out.role;
    // Now that these are KNOWN fields they are clamped like `level`, rather
    // than riding through as unknowns. A generator can emit any of them.
    const num = (v: unknown, lo: number, hi: number) =>
      typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;
    if (!['left', 'center', 'right', 'justify'].includes(out.align as string)) delete out.align;
    for (const k of ['sb', 'sa', 'ind'] as const) {
      const v = num(out[k], 0, 2000);
      if (v === undefined) delete out[k]; else out[k] = v;
    }
    const lh = num(out.lh, 0.5, 4);
    if (lh === undefined) delete out.lh; else out.lh = lh;
    for (const k of ['keepNext', 'keepTogether', 'breakBefore'] as const) {
      if (out[k] !== true) delete out[k];
    }
    // A styleId that resolves to nothing (a style since deleted, or a typo from
    // hand-edited JSON) is kept rather than dropped, deliberately unlike a
    // dangling footnote: docstyles.ts falls back to the block's KIND default
    // when the id does not resolve, so an unknown id is never a rendering
    // failure — only a "this named style no longer exists" the panel can show.
    if (typeof b.styleId === 'string' && b.styleId) out.styleId = b.styleId; else delete out.styleId;
    delete out.level; delete out.cell; delete out.image; delete out.caption; delete out.refs; delete out.cites;
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
    // No dangling-key sweep, deliberately, and for the same reason a dangling
    // cross-reference is kept: a citation whose entry is missing must render
    // visibly as [?key] so somebody fixes the bibliography. Dropping it deletes
    // the author's claim to a source.
    const cites = Array.isArray(b.cites)
      ? (b.cites as CiteRef[])
          .filter(c => isObj(c) && typeof c.at === 'number' && Array.isArray(c.keys))
          .map(c => ({
            at: Math.max(0, Math.min(c.at, text.length)),
            keys: c.keys.filter((k): k is string => typeof k === 'string' && !!k),
            ...(typeof c.locator === 'string' && c.locator ? { locator: c.locator } : {}),
            ...(c.suppressAuthor === true ? { suppressAuthor: true } : {}),
          }))
          .filter(c => c.keys.length)
          .sort((x, y) => x.at - y.at)
      : undefined;
    if (cites?.length) out.cites = cites;
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

  // Named styles (DocStyle) — same repair philosophy as everything above:
  // validate and clamp what is known, drop what is not, never let a bad style
  // definition reach docstyles.ts, which trusts the shape it is handed.
  //
  // `color` is document data written straight into a `style` attribute
  // (render.ts, print.ts) — the same class of hole `safeHref`/`safeFamily`
  // guard in inline.ts. This is an ALLOW-LIST for the same reason theirs is:
  // no `;`, no `(` beyond a bare `rgb(`/`hsl(` function, so neither a second
  // declaration nor a `url()` can be formed.
  const SAFE_STYLE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\)|[a-zA-Z]{1,30})$/;
  const numClamp = (v: unknown, lo: number, hi: number): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;
  const styles: Record<string, DocStyle> = {};
  if (isObj(json.styles)) {
    const usedIds = new Set<string>();
    for (const [key, raw0] of Object.entries(json.styles)) {
      if (!isObj(raw0)) continue;
      const raw = raw0 as Record<string, unknown>;
      let id = typeof raw.id === 'string' && raw.id ? raw.id : key;
      if (usedIds.has(id)) id = `${id}~${key}`;
      usedIds.add(id);
      const kind: BlockKind = ['para', 'h1', 'h2', 'h3', 'quote', 'ul', 'ol', 'cell', 'image', 'caption', 'toc', 'math', 'embed']
        .includes(raw.kind as string) ? raw.kind as BlockKind : 'para';
      const s: DocStyle = { id, name: typeof raw.name === 'string' && raw.name ? raw.name : id, kind };
      if (typeof raw.family === 'string' && raw.family.trim()) s.family = raw.family.trim();
      const size = numClamp(raw.size, 6, 96); if (size !== undefined) s.size = size;
      const weight = numClamp(raw.weight, 100, 900); if (weight !== undefined) s.weight = Math.round(weight / 100) * 100;
      if (raw.italic === true) s.italic = true;
      if (typeof raw.color === 'string' && SAFE_STYLE_COLOR.test(raw.color.trim())) s.color = raw.color.trim();
      if (['left', 'center', 'right', 'justify'].includes(raw.align as string)) s.align = raw.align as Block['align'];
      const sb = numClamp(raw.sb, 0, 2000); if (sb !== undefined) s.sb = sb;
      const sa = numClamp(raw.sa, 0, 2000); if (sa !== undefined) s.sa = sa;
      const ind = numClamp(raw.ind, 0, 2000); if (ind !== undefined) s.ind = ind;
      const lh = numClamp(raw.lh, 0.5, 4); if (lh !== undefined) s.lh = lh;
      styles[id] = s;
    }
  }

  const doc: TypeDoc = {
    ...(json as object) as TypeDoc,          // unknown fields ride along
    format: FORMAT,
    version: typeof json.version === 'number' ? json.version : VERSION,
    docId: typeof json.docId === 'string' && json.docId ? json.docId : newDocId(),
    title: typeof json.title === 'string' ? json.title : 'Untitled',
    page: isObj(json.page) ? { ...LETTER, ...(json.page as object) } as PageSpec : { ...LETTER },
    body, footnotes,
    revisions: Array.isArray(json.revisions) ? json.revisions as Revision[] : [],
    ...(json.track === true ? { track: true } : {}),
    signatures: Array.isArray(json.signatures) ? json.signatures as Signature[] : [],
  };
  if (Object.keys(styles).length) doc.styles = styles; else delete doc.styles;
  if (typeof json.docId !== 'string' || !json.docId) repaired.push('minted a missing docId');
  // Comment threads: parse totally, THEN repair. The order matters and the
  // feature's note says why — repairing before an anchor moves would clamp it
  // against a body that has already changed.
  const threads = reconcileThreads(readThreadsRaw(doc), body);
  if (threads.length) doc.comments = Object.fromEntries(threads.map(t => [t.id, t]));
  else delete doc.comments;

  return { ok: true, doc, repaired };
}

/** The document's text, in order — what gets measured, searched and diffed. */
export const plainText = (doc: TypeDoc): string => doc.body.map(b => b.text).join('\n');

/**
 * Words as a READER would count them: insertions in, tracked deletions out.
 *
 * A tracked deletion leaves its characters in `b.text` — that is what makes it
 * rejectable — so counting the raw string reports words the document no longer
 * says. Deleting a sentence would make the count go UP, since the struck text
 * stays and the count has no way to know it is struck.
 *
 * This is the general hazard of the representation, and every other place that
 * reads a block as prose has the same decision to make.
 */
export const wordCount = (doc: TypeDoc): number =>
  doc.body.reduce((n, b) => {
    const t = readerText(b).trim();
    return n + (t ? t.split(/\s+/).length : 0);
  }, 0);

/**
 * `b.text` with tracked deletions removed — the prose a reader sees.
 *
 * It lives HERE, the module with no dependencies, rather than in track.ts,
 * because track.ts imports this one and the reverse would be a cycle. track.ts
 * re-exports it as textOf(). One implementation: a second copy would be two
 * answers to "what does this document say", and they would diverge.
 */
export function readerText(b: Block): string {
  const dels = (b.marks ?? []).filter(m => m.t === 'del').sort((x, y) => x.from - y.from);
  if (!dels.length) return b.text;
  let out = '', at = 0;
  for (const d of dels) {
    if (d.from > at) out += b.text.slice(at, d.from);
    at = Math.max(at, d.to);
  }
  return out + b.text.slice(at);
}

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
  if (block.cites?.length) {
    const end = at + removed, delta = added.length - removed;
    const c = block.cites
      .filter(x => !(x.at > at && x.at < end))
      .map(x => (x.at >= end ? { ...x, at: x.at + delta } : x));
    if (c.length) out.cites = c; else delete out.cites;
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
