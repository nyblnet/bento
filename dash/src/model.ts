// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/dash document model. This JSON is what lives inside the #bento-doc
// block — the format IS the product (docs/PLATFORM.md §3).
//
// ONE FILE = ONE WORKBOOK: sheets of typed columns, stored COLUMNAR, with an
// ordered transform chain that says how the numbers were arrived at. `dash`
// contracts DAta SHeets (docs/DECISIONS.md, 2026-08-02) — the data model and
// the grid, not "dashboard".
//
// ADDITIVE FOREVER (PLATFORM §3): unknown top-level fields, unknown per-node
// fields and unknown transform OPS all survive parse → serialize. There is no
// server; a break here is permanent, in every file already on someone's disk.
//
// The encoding below is the single most expensive decision in the app and it
// cannot be migrated. Measured on a 12-column fact table: array-of-objects
// 15.9 bytes/cell, array-of-arrays 8.3, plain columnar 8.1, columnar +
// dictionary-encoded strings 4.8. Base64'd typed arrays are WORSE than JSON
// numbers (8 binary bytes become 10.67 base64 chars), and the only thing that
// beats dictionary-columnar is an opaque deflate blob that forfeits PLATFORM §7
// and reships the whole column on every edit under collab.

export const FORMAT = 'bento/dash'
export const FORMAT_VERSION = 1

/**
 * Rules that could ever CHANGE are pinned as VALUES, never inferred from
 * `version` — the SYNC_V lesson: discard what you cannot read rather than
 * misread it. The OPEN half of the union is load-bearing: an unrecognised
 * policy must PARSE, so the file opens and round-trips byte-exact with
 * canonicalization and id repair disabled.
 *
 * Copied from spaces (spaces/src/model.ts:26), which reached it independently.
 */
export type Policy = 'bento-dash-1' | (string & {})

/**
 * Transform ops this build knows. `Step.op` is `string`, NOT this union — an
 * unknown op must survive a round-trip, so the type system must not be able to
 * express "only these". Same trick as spaces' KnownBlockType.
 */
export type KnownOp =
  | 'import' | 'bind' | 'type' | 'filter' | 'derive' | 'sort'
  | 'group' | 'join' | 'union' | 'pivot' | 'unpivot' | 'limit' | 'patch'

export type ColumnType = 'text' | 'number' | 'money' | 'percent' | 'date' | 'bool' | 'enum'

/**
 * A column.
 *
 * PROPERTIES ARE FLAT, not nested under a `props` object, and that is a
 * correctness decision rather than a style one. Under collaboration each
 * (node, key) pair is one last-writer-wins register. With a nested `props` the
 * whole object is ONE register: measured in spaces, one author ticking a field
 * while another sets a second field loses one of the two edits SILENTLY.
 * Slides' elements are flat for the same reason, spaces' blocks are flat for
 * the same reason, and the shape is in every file ever saved — so it is free
 * now and unrecoverable later.
 */
export interface Column {
  /** Identity. `name` is display and position is neither — this is what
   *  formulas, overrides, tiles and CRDT ops all key off, so renaming a column
   *  or dragging it never breaks a reference. Kills the `#REF!` class and the
   *  shifted-VLOOKUP class outright. */
  id: string
  name: string
  type: ColumnType
  /** "$#,##0" — DOCUMENT data, because the author chose it. The decimal
   *  separator and grouping glyph are viewer chrome and live nowhere in here
   *  (PLATFORM §8 does not draw this line yet; see the open questions). */
  format?: string
  /** "USD". Makes unit-mismatch checkable rather than merely regrettable. */
  unit?: string
  /** Money computes in scaled integers; this is the scale. */
  scale?: number
  role?: 'key' | 'fk' | 'label'
  /** ONE expression for the WHOLE column — the largest structural improvement
   *  over Excel available here. One stored string, one dependency-graph node,
   *  one vectorised pass: a 100k-row model with 12 formula columns has a
   *  12-node graph, not a 1.2M-node one. */
  formula?: string
  /** The date/number format detected at import, kept so a re-import is
   *  reproducible and a mis-detection is visible rather than mysterious. */
  parsed?: string
  /** Values that would not coerce to `type`. Recorded, never hidden — a column
   *  that silently dropped 4% of its rows is a wrong answer wearing a right
   *  answer's clothes. */
  failed?: number
  w?: number
  [extra: string]: unknown
}

/**
 * Column storage. `dict` is the default and the reason the format fits.
 *
 * `pack` is an explicit, author-chosen ARCHIVE encoding for a frozen column:
 * 1.8 bytes/cell, but it forfeits the readable-JSON promise of PLATFORM §7 and
 * reships the whole column on every edit under collab. Never the default,
 * never chosen by the app on the author's behalf.
 */
export type ColumnData =
  | { enc: 'raw'; v: Array<number | string | boolean | null> }
  | { enc: 'dict'; dict: string[]; idx: Array<number | null> }
  | { enc: 'pack'; b64: string; n: number }

/**
 * The sparse overlay: only what DIFFERS from the column, keyed `<colId>:<rid>`.
 * Homogeneous data costs nothing; the ragged 1% costs ~40 bytes each.
 */
export interface CellOverride {
  /** A hand correction to imported data. */
  v?: unknown
  was?: unknown
  /** A per-cell formula, for the cases a column expression cannot express. */
  f?: string
  /**
   * The formula an imported .xlsx held, kept VERBATIM even when dash will not
   * evaluate it — a cross-sheet reference, an external workbook, a function we
   * lack. `f` is what dash computes; this is what the file said. Keeping both
   * is what stops an xlsx → dash → xlsx round trip from quietly deleting
   * somebody's model, and it is why an import that cannot run a formula still
   * shows the cached VALUE rather than a blank or a zero.
   */
  xlsxF?: string
  /** Volatiles (`TODAY()`): the moment this value was committed. */
  froze?: string
  /**
   * The dataset hash this override was made against.
   *
   * Row keys deliberately survive a re-import, so WITHOUT this an attributed
   * human correction silently re-applies to fresh data — and every replica
   * converges, on a wrong number. A non-matching override is SUSPENDED (kept,
   * not applied, flagged) and raises `stale-override`. Unaddable after the
   * first release, so it ships in v1.
   */
  againstHash?: string
  by?: string
  at?: string
  why?: string
  note?: string
  color?: string
  bg?: string
  bold?: boolean
  align?: string
  [extra: string]: unknown
}

export interface PatchEdit {
  col: string
  v: unknown
  was?: unknown
  why?: string
}

/**
 * One transform. `steps[0]` is ALWAYS the provenance record and is never re-run
 * by recalculation; everything after it is re-executable by anyone who opens the
 * file. That seam is exactly what `explain()` reports as its two tiers —
 * `attested` upstream of the dataset hash, `reexecutable` from it forward.
 *
 * The `bind` op is RESERVED and unimplemented, and ships as a TYPE in v1 because
 * a discriminant cannot be retrofitted. It carries a query NAME, parameters and
 * a timestamp — never query text, never an endpoint, never a broker id. Those
 * are SHELL configuration (docs/DECISIONS.md, 2026-07-28: "otherwise every deck
 * anyone opens is an exfiltration tool against the database").
 */
export type Step =
  | { op: 'import'; from: string; at: string; rows?: number; by?: string; note?: string }
  | {
      op: 'bind'; query: string; params?: Record<string, unknown>; at: string
      rows?: number; attest?: { by?: string; sig?: string; note?: string }
    }
  | { op: 'type'; col: string; as: ColumnType; fmt?: string; failed?: number }
  | { op: 'filter'; where: string }
  | { op: 'derive'; col: string; name: string; expr: string; type?: ColumnType; unit?: string }
  | { op: 'sort'; by: string; dir: 'asc' | 'desc' }
  | { op: 'group'; by: string[]; agg: Array<{ fn: string; of?: string; as: string }> }
  | { op: 'join'; with: string; on: [string, string]; card: 'one' | 'many'; fields: string[] }
  /** Hand corrections to a DERIVED sheet, keyed by a business key rather than a
   *  row position, so a re-import cannot re-apply one to the wrong row. A patch
   *  whose key vanished is a `stale-patch` finding, not a disappearance. */
  | { op: 'patch'; key: string[]; edits: PatchEdit[] }
  /** Unknown ops survive parse → serialize and mark their descendants
   *  `unresolved`. Views then show last known values with a badge, NEVER zero —
   *  an empty bar chart reads as ZERO, which is a number, which is a lie. */
  | { op: string; [k: string]: unknown }

export interface TableSheet {
  id: string
  name: string
  kind: 'table'
  /**
   * Row ids: minted at insert, never reused, run-length encoded as
   * `[start, count]`. `[[1, 4200]]` is 20 bytes for 4200 rows.
   *
   * Rows stay POSITIONAL — in a spreadsheet, order is data — but every row has
   * a stable key, which is what overrides, comments, patch edits and CRDT ops
   * attach to.
   */
  rids: Array<[number, number]>
  /**
   * The rid watermark: the next rid this sheet may mint.
   *
   * MONOTONIC, and deliberately not restored by undo. Without it the floor is
   * derived from the current maximum, so deleting the last row lowers it and
   * the next insert REUSES that rid — measured: rid 3 deleted, then minted
   * again for a different row. The header above says rids are never reused,
   * and everything that attaches to one (overrides, comments, CRDT nodes)
   * assumes it. Under collaboration it stops being untidy and becomes a
   * correctness precondition: two replicas would mint the same rid for two
   * different rows and merge them into one.
   *
   * Optional because files written before it exists have none; `nextRidFloor`
   * falls back to deriving it, which is the old behaviour.
   */
  nextRid?: number
  columns: Column[]
  /** colId → encoded column. */
  data: Record<string, ColumnData>
  /** Keyed `<colId>:<rid>`. */
  cells?: Record<string, CellOverride>
  /** The Excel *table* totals row — correct because it cannot fall out of range
   *  when someone appends, which the `=SUM(B2:B41)` idiom cannot promise. */
  totals?: Record<string, 'sum' | 'avg' | 'count' | 'min' | 'max' | { f: string }>
  steps: Step[]
  /** Derived sheet: the source sheet id. */
  from?: string
  [extra: string]: unknown
}

/**
 * The classic sparse A1 map — the right tool for an invoice or a scratch pad,
 * the wrong one for 100k rows. In the format from commit one, because an escape
 * hatch added later is permanently second-class (PLATFORM §3).
 */
export interface CanvasSheet {
  id: string
  name: string
  kind: 'canvas'
  cells: Record<string, CanvasCell>
  cols?: Record<string, number>
  rows?: Record<string, number>
  [extra: string]: unknown
}

export interface CanvasCell {
  v?: unknown
  f?: string
  format?: string
  note?: string
  color?: string
  bg?: string
  bold?: boolean
  align?: string
  [extra: string]: unknown
}

/**
 * A pivot sheet holds a SPEC and never the numbers it produces — the same rule
 * a chart tile follows, so a pivot cannot disagree with its data, go stale, or
 * double the file.
 */
export interface PivotSheet {
  id: string
  name: string
  kind: 'pivot'
  pivot: Record<string, unknown>
  [extra: string]: unknown
}

// --- rid partitioning -------------------------------------------------------
//
// TWO REPLICAS MUST NEVER MINT THE SAME RID FOR DIFFERENT ROWS. The watermark
// (`TableSheet.nextRid`) makes minting monotonic, which fixes reuse after a
// delete — but it cannot help the CONCURRENT case, where two people insert at
// the same moment, both compute "one past the highest I know about", and both
// get the same number. rid is identity: the CRDT keys a row node on it, and
// overrides and comments attach to it. Two different rows sharing one would
// merge into a single row and silently lose one of them.
//
// So under collaboration each replica mints from its OWN BLOCK of the rid
// space. `rid = base + counter`, and no two replicas share a base.
//
// THE SPLIT. JavaScript integers are exact to 2^53. That budget is divided
// 30 bits of block by 23 bits of counter: 1.07e9 blocks, and 8.4M rows per
// replica per workbook — comfortably past `docBudget`, which stops a document
// long before then. The alternative split (more rows, fewer blocks) buys
// capacity nobody reaches at the cost of the only thing that matters here.
//
// BLOCK 0 IS RESERVED and is what a solo document uses, so an unshared
// workbook still numbers its rows 1, 2, 3 and run-length encodes to
// `[[1, 4200]]`. Nothing about the common case changes; the cost is paid only
// once a second person is actually editing.
//
// THE RESIDUAL RISK, stated plainly: a block is derived from the actor id, so
// two replicas collide only if their derived blocks collide. That is the same
// assumption the engine already rests on everywhere else — actor ids are
// random per session and every register comparison assumes they differ. With
// 1.07e9 blocks the chance for ten concurrent editors is about 5e-8, and for a
// hundred about 5e-6. It is not zero, and pretending otherwise would be worse
// than saying so.

/** Rows one replica may mint in one workbook: 2^23. */
export const RID_BLOCK = 8_388_608
/** Blocks available: 2^30. Block 0 is the solo/pre-collab range. */
export const RID_BLOCKS = 1_073_741_824

/**
 * The rid block for an actor id — deterministic, and never 0.
 *
 * FNV-1a over the id. It only has to spread evenly; it is not a security
 * property, and the uniqueness it inherits is the actor id's.
 */
export function ridBlockFor(actor: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < actor.length; i++) {
    h ^= actor.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  // 1..RID_BLOCKS-1 — never block 0, which belongs to solo documents
  return (h % (RID_BLOCKS - 1)) + 1
}

/** First rid in a block. Block 0 starts at 1, so a solo file numbers from 1. */
export const ridBase = (block: number): number =>
  block <= 0 ? 1 : block * RID_BLOCK

export type Sheet = TableSheet | CanvasSheet | PivotSheet

/**
 * A named measure. Measured at 7,289 bytes for a real six-entity model — 0.13%
 * of a 5.6 MB dataset — so it is carried because it is nearly free, and because
 * grain-mismatch and join-fanout are undetectable without it.
 */
export interface Measure {
  name: string
  expr: string
  /** Sheet id — what ONE ROW of the source means. */
  grain: string
  additive: boolean | 'semi'
  unit?: string
  format?: string
  /** "Agreed with finance 2026-Q1. Ex-intercompany." The sentence that makes a
   *  number arguable rather than merely present. */
  desc?: string
  owner?: string
  since?: string
  [extra: string]: unknown
}

export interface Tile {
  /** Stable per-tile identity — a cross-filter click is attributed to its tile
   *  so a tile never filters ITSELF into a single bar. */
  id?: string
  title?: string
  kind: 'chart' | 'kpi' | 'slice' | 'text' | 'gl' | 'table'
  x: number
  y: number
  w: number
  h: number
  /** A tile NAMES a sheet and columns. Series arrays are DERIVED at render and
   *  never stored — slides' `syncLinkedChart` promoted from a special case to
   *  the rule. A chart then cannot disagree with its data, cannot go stale, and
   *  does not double the file. */
  bind?: {
    sheet: string; x?: string; by?: string; series?: string[]
    /** a single column, for a KPI or a one-column table */
    col?: string
    /** several, for a table tile */
    cols?: string[]
    measure?: string; agg?: string
  }
  /** chart kind for a chart tile — bar/line/pie, as chart.ts spells them */
  chart?: string
  /** what a KPI compares against: the whole sheet, its own column, or nothing */
  compare?: 'all' | 'column' | null
  option?: Record<string, unknown>
  /** REQUIRED on `kind:'gl'`: what to draw where WebGL is unavailable. */
  fallback?: 'heatmap' | 'scatter2d' | 'table'
  [extra: string]: unknown
}

export interface View {
  id: string
  name: string
  /** GRID UNITS — columns and rows of the tile grid, never pixels. A pixel
   *  layout would lay out differently on every reader's screen, which is the
   *  one thing a shared document must not do. */
  w: number
  h: number
  tiles: Tile[]
  [extra: string]: unknown
}

export interface Theme {
  background: string
  color: string
  accent: string
  fontFamily: string
  headingFamily?: string
  dir?: 'ltr' | 'rtl'
  [extra: string]: unknown
}

export interface DocMeta {
  author?: string
  company?: string
  subject?: string
  event?: string
  keywords?: string
  [extra: string]: unknown
}

export interface DashDoc {
  format: typeof FORMAT
  version: number
  policy?: Policy
  /** Minted once at creation/load and NEVER regenerated (PLATFORM §3). */
  docId: string
  title: string
  modified?: string
  meta?: DocMeta
  sheets: Sheet[]
  measures?: Record<string, Measure>
  /** the data story — see the Story block at the foot of this file */
  story?: Story
  names?: Record<string, { v: number | string; note?: string }>
  views?: View[]
  theme?: Theme
  /**
   * Source files kept as provenance, and images in views. NEVER column data:
   * the CRDT offloads asset strings over 64 KB and an unresolvable reference
   * renders as ''. An absent image reads as absent; an absent column of numbers
   * reads as data.
   */
  assets?: Record<string, string>
  collab?: unknown
  blobs?: Record<string, { key: string; mime: string; size: number }>
  readonly?: boolean
  template?: boolean
  [extra: string]: unknown
}

// --- Budgets. App constants, never kernel — nothing in kernel/src reads an
// app's budgets, and these are dash's alone.
//
// There is NO row cap. Rows are the wrong unit: 1M × 12 is 65 MB but 1M × 2 is
// ~10 MB and comfortable, so a row limit refuses workable files and admits
// unworkable ones (docs/DECISIONS.md, 2026-08-02, "dash budgets BYTES with
// consent, not rows with a refusal"). The budget is bytes, it scales with
// whether this browser can write in place, and past it the user is told what
// will break — never refused.

/** Where the grid starts warning. A target, not a cap. */
export const ROW_WARN = 250_000
/** Document JSON, where saving is still imperceptible with an in-place write. */
export const DOC_BUDGET_FSA = 25 * 1024 * 1024
/**
 * Without the File System Access API — Safari, Firefox, every iOS browser —
 * every save downloads the WHOLE file to ~/Downloads, so the practical ceiling
 * is far lower. `canWriteInPlace()` (kernel/src/save.ts) reports which we are in.
 */
export const DOC_BUDGET_DOWNLOAD = 8 * 1024 * 1024
/** A canvas sheet past this should have been a table sheet. */
export const CANVAS_CELL_MAX = 50_000

export const docBudget = (canWriteInPlace: boolean): number =>
  canWriteInPlace ? DOC_BUDGET_FSA : DOC_BUDGET_DOWNLOAD

// --- Parsing -------------------------------------------------------------

export interface Repair {
  what: 'sheet-id' | 'column-id' | 'duplicate-id' | 'missing-id' | 'doc-id'
  id: string
  became: string
}

/**
 * The result of reading a `#bento-doc` block.
 *
 * NEVER null-then-starter. `parseDoc` returning null let the caller fall back to
 * the starter document, which means opening a slides file — or a workbook with
 * one hand-edited typo — gave you an EMPTY workbook over live data, and the
 * first ⌘S wrote it to disk. The ONLY path to the starter is an absent or empty
 * block.
 *
 * Shape adopted from the shipped spaces implementation (spaces/src/model.ts:156)
 * rather than dash's design doc, which made `frozen` a third discriminant and so
 * forced every consumer into a three-way switch for a flag only two of them read.
 *
 * `unreadable` is dash's addition, and it exists because the kernel cannot tell
 * the two empty cases apart: `readEmbeddedDoc` (kernel/src/save.ts:42) returns
 * `text || null`, collapsing "no #bento-doc element" and "element present with
 * an empty text node" into one answer. Measured: past the parser's limit the
 * block IS present with exactly one zero-length text node and no throw — so
 * treating that as 'empty' boots the starter over live data, which is the exact
 * loss this type exists to prevent. The boot site decides it, because only the
 * boot site can still see the DOM.
 */
/**
 * A fresh document identity. Never derived from anything in the document —
 * two workbooks made from the same template must not collide.
 */
export const newDocId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `d-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`

export type ParseResult =
  | { ok: true; doc: DashDoc; repairs: Repair[]; frozen?: 'policy' | 'version' }
  | { ok: false; err: 'empty' }
  | { ok: false; err: 'unreadable'; detail: string }
  | { ok: false; err: 'json' | 'format' | 'shape'; detail: string; found?: string }

let idSeq = 0
/** Deterministic within a parse, so two readers of one file repair identically. */
const mintId = (prefix: string, seed: string): string =>
  `${prefix}-${hash32(`${seed}:${idSeq++}`)}`

/**
 * A stable 32-bit hash of the bytes. NOT Math.random (two readers of one file
 * would diverge) and NOT docId (which `template: true` re-mints on every open,
 * so a docId-derived id gives two readers DIFFERENT ids — the exact failure
 * repair exists to prevent). Copied in spirit from spaces' id repair.
 */
function hash32(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Read a `#bento-doc` body into a document, or say precisely why not.
 *
 * Never throws, never returns null, never silently discards a field it did not
 * recognise — every level spreads the source object so unknown keys survive.
 */
export function parseDoc(json: string): ParseResult {
  if (!json || !json.trim()) return { ok: false, err: 'empty' }

  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (e) {
    return { ok: false, err: 'json', detail: e instanceof Error ? e.message : String(e) }
  }
  if (!isObj(raw)) {
    return { ok: false, err: 'shape', detail: 'the document block is not a JSON object' }
  }
  if (raw.format !== FORMAT) {
    const found = typeof raw.format === 'string' ? raw.format : undefined
    return {
      ok: false,
      err: 'format',
      detail: found
        ? `this document declares ${found}, which needs its own app`
        : 'this document does not declare a bento format',
      found,
    }
  }
  if (!Array.isArray(raw.sheets)) {
    return { ok: false, err: 'shape', detail: 'a bento/dash document needs a "sheets" array' }
  }

  const version = typeof raw.version === 'number' ? raw.version : FORMAT_VERSION
  const policy = typeof raw.policy === 'string' ? raw.policy : undefined
  // Version wins if both: a future version implies rules we cannot name.
  const frozen: 'policy' | 'version' | undefined =
    version > FORMAT_VERSION ? 'version'
      : policy !== undefined && policy !== 'bento-dash-1' ? 'policy'
        : undefined

  const repairs: Repair[] = []
  idSeq = 0

  /**
   * Claim an id within one namespace, minting a replacement if it is missing or
   * already taken.
   *
   * Frozen documents are NEVER rewritten, not even a duplicate: the file
   * declares rules this build does not have, so it round-trips byte-exact.
   */
  const claimIn = (seen: Set<string>, id: unknown, prefix: string): string => {
    const s = typeof id === 'string' ? id : ''
    if (frozen) return s
    if (s && !seen.has(s)) { seen.add(s); return s }
    const became = mintId(prefix, s || prefix)
    repairs.push({ what: s ? 'duplicate-id' : 'missing-id', id: s, became })
    seen.add(became)
    return became
  }

  // Sheet ids are document-scoped. COLUMN ids are SHEET-scoped: two sheets may
  // both call a column `c1`, and that is ordinary, not a collision. A shared
  // namespace would rename the second one — and renaming a column orphans it,
  // because `data`, `cells` and `totals` are all keyed by the id it used to
  // have. Measured before this was fixed: the column kept its new id, `data`
  // kept the old key, and the column rendered EMPTY. Silent loss, of exactly
  // the kind this whole type exists to prevent.
  const sheetIds = new Set<string>()

  const sheets: Sheet[] = (raw.sheets as unknown[]).map((s) => {
    if (!isObj(s)) {
      return {
        id: claimIn(sheetIds, '', 'sh'), name: '', kind: 'table',
        rids: [], columns: [], data: {}, steps: [],
      } as unknown as Sheet
    }
    const id = claimIn(sheetIds, s.id, 'sh')
    if (s.kind === 'canvas') {
      return { ...s, id, kind: 'canvas', cells: isObj(s.cells) ? s.cells : {} } as unknown as CanvasSheet
    }

    // AN UNRECOGNISED KIND IS PRESERVED VERBATIM, not coerced to a table.
    //
    // This branch used to fall through, so every sheet that was not 'canvas'
    // came back as `kind: 'table'` with empty rids/columns/data/steps bolted
    // on. That is not a pivot-shaped problem, it is the additivity invariant
    // (PLATFORM §3) failing for EVERY future sheet kind: a build that has never
    // heard of one is required to keep the file intact, and instead it quietly
    // rewrote the sheet into a different thing and dropped what made it one.
    // Old builds are frozen code, so a file written by a newer dash has to
    // survive a round trip through them untouched.
    if (typeof s.kind === 'string' && s.kind !== 'table') {
      return { ...s, id } as unknown as Sheet
    }

    const colIds = new Set<string>()
    const renamed = new Map<string, string>()
    const columns = Array.isArray(s.columns)
      ? (s.columns as unknown[]).map((c) => {
        if (!isObj(c)) return c as unknown as Column
        const was = typeof c.id === 'string' ? c.id : ''
        const now = claimIn(colIds, c.id, 'col')
        if (was && now !== was) renamed.set(was, now)
        return { ...c, id: now } as unknown as Column
      })
      : []

    /** A repaired column id takes its data with it, or the repair is the loss. */
    const remap = <T,>(rec: unknown, keyOf: (k: string) => string): Record<string, T> => {
      const src = isObj(rec) ? rec : {}
      if (!renamed.size) return src as Record<string, T>
      const out: Record<string, T> = {}
      for (const [k, v] of Object.entries(src)) out[keyOf(k)] = v as T
      return out
    }

    return {
      ...s,
      id,
      kind: 'table',
      rids: Array.isArray(s.rids) ? s.rids : [],
      columns,
      data: remap<ColumnData>(s.data, (k) => renamed.get(k) ?? k),
      // `cells` is keyed "<colId>:<rid>" — only the column half moves.
      ...(isObj(s.cells)
        ? { cells: remap<CellOverride>(s.cells, (k) => {
          const i = k.indexOf(':')
          if (i < 0) return k
          const col = k.slice(0, i)
          return `${renamed.get(col) ?? col}:${k.slice(i + 1)}`
        }) }
        : {}),
      ...(isObj(s.totals)
        ? { totals: remap<NonNullable<TableSheet['totals']>[string]>(s.totals, (k) => renamed.get(k) ?? k) }
        : {}),
      steps: Array.isArray(s.steps) ? s.steps : [],
    } as unknown as TableSheet
  })

  // MINT A docId IF THE FILE HAS NONE. The field is declared required and was
  // not enforced, so a document block without one parsed happily and booted
  // with `docId: undefined` — and everything that keys off it (autosave
  // recovery, the version timeline, every future merge) then shares ONE slot
  // named "undefined" across every such workbook. Slides mints it here for the
  // same reason. It persists from the next save on, so a file gains an
  // identity once and keeps it.
  const docId = typeof raw.docId === 'string' && raw.docId ? raw.docId : newDocId()
  if (docId !== raw.docId) repairs.push({ what: 'doc-id', id: '', became: docId })
  const doc = { ...raw, format: FORMAT, version, docId, sheets } as unknown as DashDoc
  return frozen ? { ok: true, doc, repairs, frozen } : { ok: true, doc, repairs }
}

/**
 * Bytes this document would occupy in the file. `#bento-doc` is plaintext
 * forever (PLATFORM §2), so file size IS JSON size — there is no compression
 * between the model and the disk, which is why the budget can be checked here.
 */
export const docBytes = (doc: DashDoc): number => JSON.stringify(doc).length

/** Total rows across every table sheet, from the run-length encoded ids. */
export const rowCount = (doc: DashDoc): number =>
  doc.sheets.reduce(
    (n, s) => n + (s.kind === 'table' ? s.rids.reduce((m, [, c]) => m + c, 0) : 0),
    0,
  )

// The story references the chart and 3D binding shapes. Both imports are
// TYPE-ONLY and therefore erased, so this does not create a runtime cycle with
// chart.ts/viz3d.ts, which import model.ts back.
import type { ChartBinding } from './chart.ts'
import type { Viz3dBinding } from './viz3d.ts'

// --- data story --------------------------------------------------------------
//
// An ADDITIVE top-level field (`DashDoc.story`). A build that has never heard of
// stories keeps it on a round trip and simply does not present it — the format
// rule PLATFORM §3 states, and the reason the field can ship before the
// presenter is finished.

/**
 * A filter, in the form that survives JSON.
 *
 * filter.ts's `Predicate` carries a `Set` for the checkbox list, and a Set
 * serializes as `{}` — the filter would come back from the file matching
 * NOTHING, which reads as "this step's data vanished" rather than as a broken
 * round trip. So the stored spelling is an array and `toPredicate` /
 * `fromPredicate` are the only bridge. Everything else is passed through
 * verbatim, including a predicate op this build does not know: it is dropped at
 * USE time (`toFilters`) and kept in the document, which is the additive
 * behaviour and not the same as deleting it.
 */
export type StoredPredicate =
  | { op: 'equals' | 'notEquals' | 'greater' | 'less' | 'greaterOrEqual' | 'lessOrEqual'; v: unknown }
  | { op: 'contains' | 'notContains' | 'startsWith' | 'endsWith'; v: string }
  | { op: 'between'; lo: unknown; hi: unknown }
  | { op: 'isBlank' | 'notBlank' }
  /** the Excel checkbox list; `null` in the list is the "(Blanks)" box */
  | { op: 'isOneOf'; values: unknown[] }
  | { op: 'topN' | 'bottomN'; n: number }
  /** a predicate a future build understands. Kept, not applied. */
  | { op: string; [k: string]: unknown }

export interface StoredFilter {
  col: string
  pred: StoredPredicate
  [extra: string]: unknown
}

export interface SortKey {
  col: string
  dir: 'asc' | 'desc'
}

/**
 * Where the 3D camera stands. Angles in radians, matching gl.ts's `Orbit`, so
 * capture and restore are a field copy rather than a conversion nobody can
 * check. `distance` is optional because `frameCamera` derives a sensible one
 * from the scene radius, and a stored distance from a differently-sized slice
 * of the data would frame the next step wrong.
 */
export interface StoryCamera {
  azimuth: number
  elevation: number
  distance?: number
  [extra: string]: unknown
}

/**
 * The subset the step is ABOUT — category values on the chart's x axis.
 *
 * Carried in the format from commit one even though the renderer cannot paint
 * it yet (see KNOWN GAPS): a field added later is permanently second-class,
 * which is the same argument model.ts makes for `CanvasSheet` and for the
 * reserved `bind` op.
 */
export interface StoryHighlight {
  values: unknown[]
  label?: string
  [extra: string]: unknown
}

/**
 * How to get here from the step before.
 *
 * An OPEN union, like model.ts's `Policy`. A value this build does not know
 * must PARSE and must degrade to a cut — a story from a newer build has to
 * play, less prettily, rather than throw in front of an audience.
 */
export type StoryTransition = 'morph' | 'cut' | (string & {})

/** One saved view of the data. */
export interface StoryStep {
  id: string
  /** sheet id. A step whose sheet was deleted is SKIPPED, never guessed at. */
  sheet: string
  caption?: string
  filters?: StoredFilter[]
  sorts?: SortKey[]
  /** the same binding shape chart.ts uses — columns, not numbers */
  chart?: ChartBinding
  /** a 3D step. `chart` and `viz` are alternatives; `viz` wins if both are set. */
  viz?: Viz3dBinding
  camera?: StoryCamera
  highlight?: StoryHighlight
  transition?: StoryTransition
  /** seconds. Clamped at use; a story that hangs for a minute is not a story. */
  duration?: number
  [extra: string]: unknown
}

export interface Story {
  steps: StoryStep[]
  [extra: string]: unknown
}
