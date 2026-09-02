// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/spaces document model. This JSON is what lives inside the
// #bento-doc block — the format IS the product (docs/PLATFORM.md §3).
//
// ONE FILE = ONE SPACE: a tree of pages, each holding a flat pre-order list of
// blocks. Links are same-document fragments (`#p/<pageId>`) resolved against a
// map built from this block, so they work from file://, from a mail
// attachment, on iOS, and in 2036 (docs/DECISIONS.md, 2026-08-03).
//
// ADDITIVE FOREVER (PLATFORM §3): unknown top-level fields, unknown per-node
// fields and unknown block TYPES all survive parse → serialize. An older build
// meeting a future 'kanban' block keeps it and renders its html fallback.
// There is no server; a break here is permanent.

import type { CollabCreds } from './sync/crdt.ts'
import { esc, externalHref } from './sanitize.ts'

export const FORMAT = 'bento/spaces'
export const FORMAT_VERSION = 1

/**
 * Rules that could ever CHANGE are pinned as VALUES, never inferred from
 * `version` — the SYNC_V lesson: discard what you cannot read rather than
 * misread it. The OPEN half of the union is load-bearing: an unrecognised
 * policy must PARSE, so the file opens and round-trips byte-exact with
 * canonicalization and id repair disabled.
 */
export type Policy = 'bento-spaces-1' | (string & {})

/**
 * A block.
 *
 * PROPERTIES ARE FLAT, not nested under a `props` object, and that is a
 * correctness decision rather than a style one. Under collaboration each
 * (node, key) pair is one last-writer-wins register. With a nested `props` the
 * whole object is ONE register: measured, one author ticking `done` while
 * another sets a second field loses one of the two edits SILENTLY. Slides'
 * elements are flat for the same reason and keep both. Flattening costs
 * nothing now and is unrecoverable later, because the shape is in every file
 * ever saved.
 *
 * `html` is inline-only rich text (see sanitize.ts). Block STRUCTURE is
 * `type`, never markup — the renderer emits the semantic tag.
 */
export interface Block {
  id: string
  type: string
  /** inline-only html; canonicalised at typing-run close */
  html?: string
  /** nesting WITHIN a page: the id of the block that owns this one */
  parent?: string

  // ---- per-type fields, deliberately flat -------------------------------
  /** todo */
  done?: boolean
  /** code */
  lang?: string
  /** toggle: fold state AS SAVED is authorial intent, so it is document data.
   *  Toggles always PRINT expanded — silently omitting content from a printed
   *  handbook is a data-loss-shaped bug. */
  open?: boolean
  /** image, media: 'asset:<key>' | data: | https: */
  src?: string
  alt?: string
  caption?: string
  /**
   * media: 'video' | 'audio'.
   *
   * ONE block type with a kind, not two types, because everything else about
   * them is identical — the same hybrid src, the same remote-consent gate, the
   * same still in print and preview, the same playback flags. Two types would
   * mean two registry entries, two renderer cases and two exporters that have
   * to be kept saying the same thing.
   *
   * An OPEN string, like `type` and `tone`: a kind a future build adds must
   * round-trip through this one. Anything that is not 'audio' is drawn as
   * video, which is the shape that degrades usefully — a video element with an
   * audio file in it plays the audio.
   */
  kind?: string
  /** media: a still frame, same three src forms. Shown before play, and it is
   *  what print and the file-manager preview draw instead of a player. */
  poster?: string
  /** media: playback controls for the reader. Absent = shown. */
  controls?: boolean
  /** media: repeat at the end. */
  loop?: boolean
  /** media: start silent. */
  muted?: boolean
  /**
   * media: RECORDED, NEVER HONOURED. See blocks.ts mediaPlayback().
   *
   * A space has no surface that owns playback the way slides' present mode
   * does — it has an editor, a reading view, a printout and a file-manager
   * still, and a clip that starts itself is wrong in all four. The field
   * exists so a document written by a build that DOES have such a surface
   * round-trips untouched (PLATFORM §3), and so that the rule has somewhere to
   * be written down. It is not read by this app.
   */
  autoplay?: boolean
  /** image width as a PERCENTAGE of the text column (10..100). No block
   *  carries absolute px — the column width is a theme concern. */
  width?: number
  /** intrinsic px at insert: holds the aspect box while the image decodes */
  w?: number
  h?: number
  /** pagelink: the target page id */
  page?: string

  /**
   * table: the cells, row-major, each one INLINE HTML.
   *
   * A cell is a bare string rather than slides' `{html, color, bg, bold}`
   * object, and that is the one real divergence from the model this is
   * otherwise copied from. Slides' cells carry presentation because a canvas
   * has no cascade — every table there paints its own colours. A space has a
   * theme and a stylesheet, so the only thing left in a cell is its content,
   * and its content is already rich: **bold** in a cell is `<b>`, exactly as in
   * every other block, through the same allowlist. Nothing is lost and the
   * whole style object goes away.
   *
   * Row 0 is the header unless `header` is false — see below.
   *
   * UNDER COLLABORATION this whole field is one last-writer-wins register, so
   * two people editing DIFFERENT cells at the same time keep only one of the
   * two edits. Slides' table has the identical limitation and documents it;
   * the fix (a node per cell) is a format change, so it is written down here
   * rather than half-built.
   */
  rows?: string[][]
  /**
   * table: fractional column weights, one per column. Absent = equal columns.
   *
   * FRACTIONS, never pixels, for the reason `Block.width` is a percentage: the
   * text column is a theme concern and the same file is read at 320px and at
   * 1600px. Dragging a column boundary changes two weights and nothing else.
   */
  cols?: number[]
  /**
   * table: per-COLUMN text alignment — '' | 'left' | 'center' | 'right'.
   *
   * Per column, not per cell, because that is what a pipe table can say: GFM
   * encodes alignment in the `:---:` rule row and nowhere else. Per-cell
   * alignment would export as a lie on every second row.
   */
  colAlign?: string[]
  /**
   * table: false when the first row is ordinary data.
   *
   * ABSENT MEANS TRUE, which is the opposite of every other boolean here and is
   * deliberate: a GFM pipe table always has a header, so the header case is
   * what a table imported from markdown, written by an agent, or hand-authored
   * with the two fields above will be — and it should be the case that needs no
   * field. A headerless table says so, and exports with an empty header row.
   */
  header?: boolean

  /**
   * link: the address the card opens. `https:`, `http:` or `mailto:` only —
   * anything else is not made clickable (see `linkCard`).
   */
  url?: string
  /** link: the headline. Absent falls back to the url itself, never to a blank
   *  box — an empty field must still leave a working link. */
  title?: string
  /** link: the author's one-line description of what is at the other end. */
  desc?: string
  /** link: the site's name. Absent is DERIVED from the url's host, which needs
   *  no network — it is string parsing, not a lookup. */
  site?: string
  /**
   * link: a thumbnail, `asset:<key>` or `data:` and NOTHING ELSE.
   *
   * A remote thumbnail is the tracking pixel of the 2026-08-03 decision wearing
   * a card for a hat: it would fire on open, in a document whose whole premise
   * is that you can mail it. `linkCard` drops one rather than deferring it
   * behind a placeholder, because an image block's placeholder stands in for
   * the block's entire content while a card's thumbnail is decoration — there
   * is nothing for a reader to consent to and nothing lost by its absence.
   */
  image?: string
  /**
   * callout: which kind of callout this is — one of blocks.ts CALLOUT_TONES.
   *
   * An OPEN string, like `type`, and for the same reason: a tone a future build
   * adds must survive this one untouched. An unrecognised tone renders with the
   * neutral treatment and spells ITSELF out as its label, so the reader is told
   * the truth rather than shown a note that is really a warning.
   */
  tone?: string
  /**
   * callout: an emoji (or a name from the icon set) REPLACING the tone's own
   * mark.
   *
   * Absent is the normal case and is not a missing value — the mark is DERIVED
   * from the tone, so every warning in a document looks like every other one,
   * and a document written today is not frozen to today's glyphs. The override
   * exists because "🎉 we shipped" is a callout too, and it never changes what
   * the tone MEANS: the tone is still the tone, in the styling and in the
   * markdown export.
   */
  icon?: string

  /**
   * Review threads anchored to THIS block. See `Comment` below for why they
   * live on the block rather than in one list on the page.
   */
  comments?: Comment[]

  [extra: string]: unknown
}

/** One message in a thread. The first one IS the thread (`Comment` extends it). */
export interface CommentEntry {
  id: string
  author: string
  /** ISO datetime */
  at: string
  /**
   * PLAIN TEXT, never html, and the only field in this format that is.
   *
   * A block's `html` earns its markup and pays for it with sanitize.ts. A
   * comment has nothing to gain from bold — and it arrives in a file somebody
   * mailed you, from a person who is by definition not the author of the
   * document. So the answer is not "sanitize it too" but "there is nothing to
   * sanitize": it is stored as a string and written to the screen with
   * `textContent`, so `<img onerror>` in a comment is four words a reader can
   * see rather than a parse this app has to be careful about.
   */
  text: string
}

/**
 * A review thread. Saved in the file so it travels with the document, and
 * EDITOR-ONLY: `render.ts` never emits one, so it cannot reach the reading
 * view or the printed page. A comment is workspace, not document.
 *
 * WHERE A THREAD LIVES IS ITS ANCHOR. A deck is a canvas, so slides can point
 * at an (x, y); a space is a tree of pages of blocks, and the block is the
 * thing that already has a durable identity — ids are unique document-wide and
 * are never reused, which is exactly what links and backlinks key on. So there
 * are two anchors and no third: `Block.comments` is a thread about that block,
 * `Page.comments` is a thread about the page. A text RANGE inside a block is
 * deliberately not one: an offset pair has no meaning after the concurrent
 * edit that moved it, and inventing one now would freeze the wrong answer into
 * every file.
 *
 * Storing a block thread ON THE BLOCK is a collaboration decision, not a
 * filing one. Under the CRDT every non-container property is one
 * last-writer-wins register (kernel/src/sync/crdt.ts), so one `Page.comments`
 * array would make every thread on a page contend for a single register: two
 * people commenting on two different paragraphs at the same moment, and one
 * comment is gone with nothing said. Per block, that case converges. What
 * remains — two people commenting on the SAME block, or on the same page,
 * concurrently — is still last-writer-wins, exactly as slides' table `rows`
 * is, and is written down rather than pretended away.
 */
export interface Comment extends CommentEntry {
  resolved?: boolean
  replies?: CommentEntry[]
}

export interface Page {
  id: string
  title: string
  /** page-tree nesting; absent = a root page */
  parent?: string
  /** one emoji, never a URL — a URL would be a network dependency */
  icon?: string
  /**
   * A picture across the top of the page.
   *
   * `asset:<key>` or a `data:` URI, and NEVER a URL — for exactly the reason
   * `icon` is not one. PLATFORM §1: opening a document must not touch the
   * network, and a cover is the field most likely to tempt someone into a
   * link, because that is how every hosted notes app does it. A file that
   * arrives carrying a remote cover keeps the field (additivity) and renders
   * NOTHING, which `coverSrc` is the single place that decides.
   *
   * Absent on every page written before this, so an older build renders the
   * page it always did and round-trips the field untouched.
   */
  cover?: string
  /** flat, pre-order; nesting via Block.parent */
  blocks: Block[]
  /**
   * This page IS the daily entry for an ISO `YYYY-MM-DD` date.
   *
   * The DATE, not the title, is what makes a journal a journal — see
   * src/journal.ts. Logseq derives the same thing from a formatted page title
   * and their tracker carries the data loss that follows when the format
   * changes; a title is display and this is data. Absent on every other page,
   * so a build that predates journals renders an ordinary page and round-trips
   * the field untouched.
   */
  journal?: string
  /**
   * How wide this page's column is: absent = the theme measure (prose),
   * 'wide' = room for a board, 'full' = the whole window.
   *
   * ON THE PAGE, not on the theme. `theme.measure` is one number for the whole
   * document, and the right answer genuinely differs per page: a page of notes
   * wants a comfortable line, a board wants the room. The renderer ALREADY
   * knew that — a page carrying a `view` block silently jumped to 1500px — but
   * it decided for you and offered no way to disagree. This makes that rule
   * explicit and overridable in one field: a board page with no `width` still
   * gets its room, and a board page set to normal now gets to be narrow.
   *
   * Additive. Absent on every page written before this, and an unknown value
   * falls back to the measure rather than to nothing.
   */
  width?: 'wide' | 'full'
  /** the one page daily entries hang from, so the sidebar stays a tree */
  journalHome?: boolean
  /** out of the sidebar, still searchable and linkable, and ENUMERATED at
   *  share time — an author archived a page precisely because it was sensitive */
  archived?: boolean
  /** review threads about the page as a whole — see `Comment` */
  comments?: Comment[]
  created?: string
  edited?: string
  [extra: string]: unknown
}

export interface Theme {
  background: string
  color: string
  accent: string
  fontFamily: string
  headingFamily?: string
  /** text column width in px — DOCUMENT data: the same for every reader */
  measure?: number
  /** BASE direction of page CONTENT (PLATFORM §8's two-layer pin) */
  dir?: 'ltr' | 'rtl'
}

export interface SpacesDoc {
  format: typeof FORMAT
  version: number
  /** absent ⇒ bento-spaces-1 */
  policy?: Policy
  /** minted once at creation/load, NEVER regenerated (PLATFORM §3) */
  docId: string
  title: string
  modified?: string
  /** flat, pre-order; nesting via Page.parent */
  pages: Page[]
  /** the page shown on open; absent ⇒ pages[0] */
  home?: string
  theme: Theme
  assets?: Record<string, string>
  fonts?: Array<{ family: string; asset: string; weight?: string; style?: string }>
  readonly?: boolean
  template?: boolean
  /**
   * Collaboration credentials (PLATFORM §2).
   *
   * Was `unknown` and marked RESERVED "unused until collab ships". It has:
   * sync/session.ts binds this app to the kernel session. The type is the
   * KERNEL's so there is one definition of what a room, a key and an invite
   * chain are — the deployed relay verifies against that shape, and a second
   * local description of it is how a client and the worker drift apart.
   * `import type` is erased, so this adds no runtime dependency.
   */
  collab?: CollabCreds
  [extra: string]: unknown
}

/**
 * The document with its collaboration SECRETS removed, for anything a person
 * copies, pastes or hands to somebody else.
 *
 * `doc.collab` is minted at creation, so EVERY space has one from its first
 * save — and it holds the read capability (`key`), the write capability
 * (`writerPriv`), the owner key that can also revoke (`ownerPriv`) and any
 * invite's private half. "Copy document JSON" put all of that on the
 * clipboard, under a note inviting exactly that copy ("the whole document is
 * plain JSON in this file"), and the natural next step is pasting it into a
 * chat window. bento/slides had this same bug, fixed it, and wrote a rig to
 * stop it coming back — the rig only ever looked at slides/.
 *
 * DERIVED BY REMOVING, not by listing what to keep: a private field added to
 * CollabCreds later is stripped by this without anyone remembering to.
 * `room` and `key` go too — together they ARE the read capability, and a room
 * id is the thing the relay keys on.
 */
export function docForExport(doc: SpacesDoc): SpacesDoc {
  const { collab, ...rest } = doc as SpacesDoc & { collab?: unknown }
  void collab
  return rest as SpacesDoc
}

export const uid = (p = 'b'): string => {
  const r = globalThis.crypto?.randomUUID?.()
  return r ? `${p}-${r.slice(0, 8)}` : `${p}-${Math.random().toString(36).slice(2, 10)}`
}

const newDocId = (): string => globalThis.crypto?.randomUUID?.() ?? uid('doc')

/**
 * Parse result — TAGGED, never null.
 *
 * `parseDoc` returning null let the caller fall back to the starter, which
 * means opening a slides file, or a document with one hand-edited typo, gave
 * you an EMPTY space over live data — and the first ⌘S wrote it to disk. The
 * only path to the starter is an absent or empty block.
 *
 * `frozen` means this build must not canonicalize html or repair ids: the file
 * declares rules this build does not have, so it round-trips byte-exact.
 * Sanitize still runs — that is a security control, not an interpretation.
 */
export type ParseResult =
  | { ok: true; doc: SpacesDoc; repaired: string[]; frozen?: 'policy' | 'version' }
  | { ok: false; err: 'empty' }
  | { ok: false; err: 'json' | 'format' | 'shape'; detail: string; found?: string }

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Deterministic id repair.
 *
 * Two readers of one file must agree on every id, so a replacement is derived
 * from the BYTES — never from `Math.random` (which diverges two readers, and
 * two future CRDT replicas on a node key) and never from `docId` (which
 * `template: true` re-mints on every open, so a docId-derived id gives two
 * readers of one file DIFFERENT ids: exactly the failure repair exists to
 * prevent).
 *
 * EXPORTED because the subtree import needs exactly this and must not invent a
 * second scheme: an arriving id that collides with one this space already uses
 * is renamed here, under the same derivation and the same reasoning
 * (src/portable.ts planGraft).
 */
export function repairId(scope: string, ordinal: number, content: string, salt = 0): string {
  let h = 0x811c9dc5
  const s = `${scope}${ordinal}${content}${salt}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `r-${h.toString(36)}`
}

export function parseDoc(json: string): ParseResult {
  if (!json || !json.trim()) return { ok: false, err: 'empty' }

  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (e) {
    return { ok: false, err: 'json', detail: (e as Error).message }
  }
  if (!isObj(raw)) return { ok: false, err: 'shape', detail: 'the document block is not a JSON object' }

  if (raw.format !== FORMAT) {
    return {
      ok: false,
      err: 'format',
      detail: `this document declares "${String(raw.format ?? '(nothing)')}"`,
      found: typeof raw.format === 'string' ? raw.format : undefined,
    }
  }
  if (!Array.isArray(raw.pages)) {
    return { ok: false, err: 'shape', detail: 'a bento/spaces document needs a "pages" array' }
  }

  const version = typeof raw.version === 'number' ? raw.version : FORMAT_VERSION
  const policy = typeof raw.policy === 'string' ? raw.policy : 'bento-spaces-1'
  const frozen: 'policy' | 'version' | undefined =
    version > FORMAT_VERSION ? 'version' : policy !== 'bento-spaces-1' ? 'policy' : undefined

  const repaired: string[] = []
  const seen = new Set<string>()
  /** first occurrence in pre-order keeps the id; later duplicates are repaired */
  const claim = (want: unknown, scope: string, ordinal: number, content: string): string => {
    const id = typeof want === 'string' && want ? want : ''
    if (id && !seen.has(id)) { seen.add(id); return id }
    if (frozen && id) return id // frozen: never rewrite, even a duplicate
    let salt = 0
    let next = repairId(scope, ordinal, content, salt)
    while (seen.has(next)) next = repairId(scope, ordinal, content, ++salt)
    seen.add(next)
    repaired.push(id || '(missing id)')
    return next
  }

  // Pages repair FIRST, in pre-order, so a block's owning page id is final
  // before its own replacement is derived from it.
  const pages: Page[] = (raw.pages as unknown[]).map((p, pi) => {
    const src = isObj(p) ? p : {}
    const title = typeof src.title === 'string' ? src.title : 'Untitled'
    const pid = claim(src.id, String(src.parent ?? ''), pi, title)
    const blocksRaw = Array.isArray(src.blocks) ? src.blocks : []
    const blocks: Block[] = blocksRaw.map((b, bi) => {
      const bs = isObj(b) ? b : {}
      const type = typeof bs.type === 'string' && bs.type ? bs.type : 'p'
      const html = typeof bs.html === 'string' ? bs.html : undefined
      return {
        ...bs,
        id: claim(bs.id, pid, bi, `${type}${html ?? ''}`),
        type,
        ...(html !== undefined ? { html } : {}),
      } as Block
    })
    return { ...src, id: pid, title, blocks } as Page
  })

  // A parent naming something that does not exist is DROPPED rather than left
  // dangling: an unreachable page is worse than a root one, and a block whose
  // owner is absent would never render at all.
  const pageIds = new Set(pages.map((p) => p.id))
  for (const p of pages) {
    if (p.parent && !pageIds.has(p.parent)) delete p.parent
    const own = new Set(p.blocks.map((b) => b.id))
    for (const b of p.blocks) if (b.parent && !own.has(b.parent)) delete b.parent
  }

  const doc: SpacesDoc = {
    ...raw,
    format: FORMAT,
    version,
    docId: typeof raw.docId === 'string' && raw.docId ? raw.docId : newDocId(),
    title: typeof raw.title === 'string' ? raw.title : 'Untitled space',
    pages,
    theme: { ...defaultTheme(), ...(isObj(raw.theme) ? raw.theme : {}) },
  } as SpacesDoc

  return { ok: true, doc, repaired, ...(frozen ? { frozen } : {}) }
}

export function defaultTheme(): Theme {
  return {
    background: '#FFFFFF',
    color: '#1E2A3A',
    accent: '#F7A600',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    measure: 720,
  }
}

export const newBlock = (type = 'p', extra: Partial<Block> = {}): Block =>
  ({ id: uid('b'), type, html: '', ...extra })

export const newPage = (title = 'Untitled', extra: Partial<Page> = {}): Page =>
  ({ id: uid('p'), title, blocks: [newBlock()], ...extra })

/** Content that matters for "did this change" — excludes volatile fields. */
export function docContentKey(doc: SpacesDoc): string {
  return JSON.stringify([doc.title, doc.home, doc.pages])
}

// ---- derived, NEVER stored -------------------------------------------------
// Stale the moment anything else writes the document (an agent editing
// #bento-doc, a version restore, a future CRDT apply). Derived at load.

export interface SpaceIndex {
  page: Map<string, Page>
  /** page id → child pages in order; '' = root */
  children: Map<string, Page[]>
  block: Map<string, { block: Block; pageId: string }>
  /** target page id → the blocks that link to it */
  backlinks: Map<string, Array<{ pageId: string; blockId: string }>>
}

/**
 * A table's cells as one string, for scanning only.
 *
 * Deliberately not `tableFallbackHtml`: this is never written anywhere, so it
 * needs no separator, no escaping and no shape — it exists so one regex can
 * find hrefs in cells the same way it finds them in prose. Tolerant of a
 * malformed `rows` because it runs on documents nobody has validated yet.
 */
function tableCellsText(rows: unknown[]): string {
  let out = ''
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    for (const cell of row) if (typeof cell === 'string') out += cell + '\n'
  }
  return out
}

/** Every `#p/<id>` href in a block's html. */
const LINK_RE = /href="#p\/([^"]+)"/g

/**
 * The PAGE a `#p/…` target names.
 *
 * `#p/<page>` today; `#p/<page>/<block>` is already admissible under
 * sanitize.ts's allowlist, so it can appear in a file this build did not write.
 * Keyed on the whole string, a block link produced a backlink on the id
 * "p1/b2" — which is no page, so the target page listed nothing and the one
 * feature that makes a wiki worth having quietly failed on exactly the links a
 * newer build would write.
 *
 * `pages` is passed so an author-supplied id CONTAINING a slash still wins:
 * minted ids never contain one, but nothing stops a hand-written file.
 */
function linkTarget(raw: string, pages: Map<string, Page>): string {
  if (pages.has(raw)) return raw
  const cut = raw.lastIndexOf('/')
  return cut > 0 ? raw.slice(0, cut) : raw
}

const pushInto = <T>(m: Map<string, T[]>, k: string, v: T) => {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

/**
 * THE ONE ANSWER to "what is this block nested under".
 *
 * A block's effective parent is `b.parent` iff that block exists in the SAME
 * page and appears STRICTLY EARLIER in the array. Anything else — a parent that
 * is absent, that is the block itself, or that sits later — resolves to the
 * root. Settled in docs/DECISIONS.md (2026-08-03) and implemented here because
 * it was previously implemented four times, differently:
 *
 *   · render.ts walked a stack, which IS this rule (positional);
 *   · blocks.ts mdLayout followed `parent` as a graph, hop-capped at 32;
 *   · agent.ts descendants swept the graph to a fixed point, explicitly
 *     "rather than trusting the order";
 *   · editor.indent looked its owner up by id, anywhere in the page.
 *
 * They agree today only because the editor keeps the array in pre-order. That
 * is exactly the invariant collaboration breaks: `parent` is a last-writer-wins
 * register and order is a fractional position key, so two legal concurrent
 * edits — you indent a block, I move one — converge on an array where a child
 * precedes its parent. Measured on the merge rig: 52.4% of merged documents.
 * At that point "the tree" means four different things, and the graph readers
 * are the dangerous ones: a merged cycle makes `descendants` return the whole
 * connected component, so deleting one block deletes blocks nobody selected.
 *
 * POSITIONAL IS THE RULE BECAUSE IT CANNOT FAIL. A parent must be earlier, so
 * the result is ACYCLIC BY CONSTRUCTION — no visited set, no hop cap, no
 * fixed-point sweep, and no document can be authored or merged into a shape
 * that makes it loop. It is a pure READ-TIME function: it mutates nothing, so
 * two replicas that agree on the array agree on the tree without exchanging a
 * single extra op. Repairing the array instead would mint `ord` ops and two
 * replicas can ping-pong over them forever.
 */
export function effectiveParents(page: Page): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>()
  const seenAt = new Map<string, number>()
  page.blocks.forEach((b, i) => {
    const p = typeof b.parent === 'string' ? b.parent : undefined
    // strictly earlier: `seenAt` only holds blocks already walked past
    out.set(b.id, p !== undefined && seenAt.has(p) ? p : undefined)
    seenAt.set(b.id, i)
  })
  return out
}

/**
 * Every block nested under `id`, at any depth — by the rule above, so it
 * terminates on any document and never reaches outside the subtree.
 */
export function descendantsOf(page: Page, id: string): Set<string> {
  const eff = effectiveParents(page)
  const out = new Set<string>()
  // one forward pass suffices: a child always follows its effective parent
  for (const b of page.blocks) {
    const p = eff.get(b.id)
    if (p !== undefined && (p === id || out.has(p))) out.add(b.id)
  }
  return out
}

export function buildIndex(doc: SpacesDoc): SpaceIndex {
  const page = new Map<string, Page>()
  const children = new Map<string, Page[]>()
  const block = new Map<string, { block: Block; pageId: string }>()
  const backlinks = new Map<string, Array<{ pageId: string; blockId: string }>>()

  for (const p of doc.pages) page.set(p.id, p)
  for (const p of doc.pages) {
    // a parent that does not resolve shows at root, never disappears
    pushInto(children, p.parent && page.has(p.parent) ? p.parent : '', p)
    for (const b of p.blocks) {
      block.set(b.id, { block: b, pageId: p.id })
      // WHERE A BLOCK'S LINKS LIVE. Normally in `html`. A table keeps its
      // content in `rows` and mirrors it into `html` as a readable fallback,
      // and `writeTable` is the one writer that keeps the two in step — so for
      // a table the editor produced, scanning `html` finds the cells' links.
      //
      // It does not for a table that arrives any other way. A hand-written
      // document, an agent calling updateBlock, an import: `rows` is set,
      // `html` is absent, and a link in a cell then WORKS WHEN CLICKED and
      // appears in no "Linked from" — the one failure a backlink index has,
      // and silent. Measured before this: 0 backlinks, against 1 for the same
      // table through writeTable.
      //
      // `rows` is read ONLY when `html` is absent. With both present they are
      // the same links by construction, and scanning both would report every
      // cell link twice — which is why extending this to always scan `rows`
      // was tried during the starter work and reverted.
      const linkSrc = b.html || (Array.isArray(b.rows) ? tableCellsText(b.rows) : '')
      if (linkSrc) {
        for (const m of linkSrc.matchAll(LINK_RE)) {
          pushInto(backlinks, linkTarget(m[1], page), { pageId: p.id, blockId: b.id })
        }
      }
      if (b.type === 'pagelink' && typeof b.page === 'string') {
        pushInto(backlinks, b.page, { pageId: p.id, blockId: b.id })
      }
    }
  }
  return { page, children, block, backlinks }
}

/** A thread, with the anchor it was found at. `blockId` absent = the page. */
export interface CommentAt {
  comment: Comment
  pageId: string
  blockId?: string
}

/**
 * Every thread on a page, page-level first, then block threads in page order.
 *
 * The ONE reader of both anchors, so the badge, the marker layer and the agent
 * report cannot disagree about what a page holds. Defensive about the shape
 * because this data arrives in a file: `comments: "yes"` must be ignored, not
 * iterated.
 */
export function commentsOn(page: Page): CommentAt[] {
  const out: CommentAt[] = []
  const take = (list: unknown, blockId?: string) => {
    if (!Array.isArray(list)) return
    for (const c of list) {
      if (c && typeof c === 'object' && typeof (c as Comment).id === 'string') {
        out.push({ comment: c as Comment, pageId: page.id, ...(blockId ? { blockId } : {}) })
      }
    }
  }
  take(page.comments)
  for (const b of page.blocks) take(b.comments, b.id)
  return out
}

/** How many threads on this page are still open — the sidebar badge. */
export const unresolvedOn = (page: Page): number =>
  commentsOn(page).reduce((n, c) => n + (c.comment.resolved ? 0 : 1), 0)

/** The page a reader lands on. */
export const homePage =(doc: SpacesDoc): Page | undefined =>
  (doc.home ? doc.pages.find((p) => p.id === doc.home) : undefined) ?? doc.pages[0]

/**
 * Would loading this src touch the network?
 *
 * `asset:` is in the file and `data:` is the bytes themselves — neither leaves
 * the machine. Everything else does, INCLUDING a relative path (which resolves
 * against the document's own URL and is a real request on a static host), and
 * `//host/x`, and any scheme this build has never heard of. So the test is an
 * allowlist of the two local forms, not a blocklist of `http`.
 */
export function isRemote(src: string): boolean {
  if (!src) return false
  return !src.startsWith('asset:') && !src.startsWith('data:')
}

/**
 * The cover a page actually shows — '' when it has none, and '' when what it
 * has would reach the network.
 *
 * ONE PLACE decides that, because the rule has to hold for the page, the
 * gallery card, the asset sweep and anything added later. A remote cover is
 * not repaired and not deleted: the field round-trips, and validate() says so
 * out loud (agent.ts) rather than the picture silently not being there.
 */
export function coverSrc(page: Page): string {
  const c = (page as { cover?: unknown }).cover
  if (typeof c !== 'string' || !c) return ''
  return isRemote(c) ? '' : c
}

/** Every asset key a PAGE references outside its blocks — today, its cover. */
export function pageAssetKeys(page: Page): string[] {
  const c = (page as { cover?: unknown }).cover
  return typeof c === 'string' && c.startsWith('asset:') ? [c.slice(6)] : []
}

/**
 * What an `asset:` src actually points at, or the src itself.
 *
 * hasOwn, not a bare index: `assets['toString']` returns a FUNCTION, which is
 * truthy, so a `?? ''` never fires and the stringified function is what gets
 * assigned. Same class as the icon lookup — an author-supplied key reaching a
 * lookup table through the prototype chain.
 */
export function assetValue(src: string, doc: SpacesDoc): string {
  if (!src.startsWith('asset:')) return src
  const key = src.slice(6)
  const table = doc.assets
  return table && Object.hasOwn(table, key) ? String(table[key] ?? '') : ''
}

/**
 * Does loading this src reach off the machine — after the asset table has had
 * its say?
 *
 * `isRemote` answers about the string an author WROTE, and that was the whole
 * test until now. It has a hole one indirection deep: `asset:k` is local by
 * inspection, and `doc.assets.k` is whatever the file says it is. A document
 * carrying
 *
 *     "assets": { "k": "http://tracker.example/p.png" }
 *
 * and an image `src: "asset:k"` fetched it on open — measured on a shipped
 * build, with the request in the network log. The consent placeholder never
 * appeared, because the gate had already decided the src was local.
 *
 * Nothing can be promised about what is INSIDE a file somebody mails you. What
 * the app owes its reader is narrower and keepable: it makes no request on a
 * document's behalf until the reader asks for it. That promise is only as good
 * as the question this function answers, so it is asked about the URL that will
 * actually be fetched rather than the one that was typed.
 */
export function loadsRemotely(src: string, doc: SpacesDoc): boolean {
  return isRemote(assetValue(src, doc))
}

// ---- tables ----------------------------------------------------------------
// A table is CONTENT (working/design/spaces-design.md §2.6): no formulas, no
// recalculation, no cross-document references. The line the suite draws is
// "would you print it → folio; does it recalculate → dash; does it link to
// pages → spaces", and a table whose cells are inline html — so a cell can
// hold a `#p/` link — is squarely on this side of it. The DATABASE case already
// shipped, as the tracker (doc.fields + prop + view blocks), and is not this.

/** The upper bound on a table's shape. A file can be hand-edited or generated,
 *  and the renderer should not be asked for a hundred thousand cells. */
export const TABLE_MAX_COLS = 32
export const TABLE_MAX_ROWS = 400

export interface TableShape {
  rows: string[][]
  cols: number[]
  colAlign: string[]
  header: boolean
  /** columns and rows, after normalisation */
  w: number
  h: number
}

/**
 * ONE answer to "what shape is this table" — for the renderer, the editor and
 * the markdown exporter alike.
 *
 * Every table field is optional in the format, and the file may have been
 * written by hand, by an agent, or by a build that is not this one. So a ragged
 * `rows`, a `cols` of the wrong length, and a `rows` that is not an array at
 * all are ordinary inputs here rather than errors.
 *
 * It normalises AT READ TIME and never by rewriting the document — the same
 * choice `effectiveParents` makes, for the same reason: two readers of one file
 * agree without exchanging an op, and merely opening a space repairs nothing.
 */
export function tableOf(b: Block): TableShape {
  const raw = Array.isArray(b.rows) ? (b.rows as unknown[]) : []
  const asRow = (r: unknown): string[] =>
    (Array.isArray(r) ? r : []).slice(0, TABLE_MAX_COLS).map((c) => (typeof c === 'string' ? c : ''))
  let rows = raw.slice(0, TABLE_MAX_ROWS).map(asRow)
  const w = Math.max(1, ...rows.map((r) => r.length))
  rows = rows.map((r) => (r.length === w ? r : [...r, ...Array(w - r.length).fill('')]))
  if (!rows.length) rows = [Array(w).fill('')]
  const num = (v: unknown): number => (typeof v === 'number' && v > 0 && Number.isFinite(v) ? v : 1)
  const src = Array.isArray(b.cols) ? (b.cols as unknown[]) : []
  const cols = Array.from({ length: w }, (_, i) => num(src[i]))
  const al = Array.isArray(b.colAlign) ? (b.colAlign as unknown[]) : []
  const colAlign = Array.from({ length: w }, (_, i) =>
    al[i] === 'left' || al[i] === 'center' || al[i] === 'right' ? String(al[i]) : '')
  return { rows, cols, colAlign, header: b.header !== false, w, h: rows.length }
}

/**
 * What a build that has never heard of a `table` block shows.
 *
 * The format is additive forever, and for a block TYPE additive means the
 * unknown type falls back to rendering its `html` (spaces/README.md). So a
 * table keeps one — derived, rewritten on every edit, never authored.
 *
 * It is the cells' OWN INLINE HTML joined, not their plain text: a `#p/` link
 * in a cell then still produces a backlink (buildIndex reads `html`), still
 * turns up in ⌘F, and still exports from an older build as a link rather than
 * as a bare word.
 *
 * It costs a second copy of the table's text in the file, and that is the price
 * of a permanent format. The alternative is a table that VANISHES when the
 * space is opened by the build someone already has, which is not a trade worth
 * making for a few hundred bytes.
 */
export function tableFallbackHtml(rows: string[][]): string {
  return rows.map((r) => r.filter((c) => c.trim()).join(' · ')).filter(Boolean).join('<br>')
}

/**
 * Write a shape back onto a block — the ONE writer, so `html` can never drift
 * from `rows`.
 *
 * Defaults are OMITTED rather than written: equal columns store no `cols`, no
 * alignment stores no `colAlign`, a header stores no `header`. A table built
 * here and a table parsed out of a pipe table are then the same bytes, and the
 * minimal hand-written `{ type: 'table', rows: [[…]] }` is a first-class
 * document rather than something this build would "fix" on the next edit.
 */
export function writeTable(b: Block, t: Pick<TableShape, 'rows' | 'cols' | 'colAlign' | 'header'>): void {
  b.rows = t.rows
  if (t.cols.some((c) => c !== t.cols[0])) b.cols = t.cols
  else delete b.cols
  if (t.colAlign.some(Boolean)) b.colAlign = t.colAlign
  else delete b.colAlign
  if (t.header) delete b.header
  else b.header = false
  b.html = tableFallbackHtml(t.rows)
}

/** A link card, with every field already decided. */
export interface LinkCard {
  /** '' when the stored url is not an outward link — then the card is not clickable */
  url: string
  /** never '' when there is a url: it falls back to the url itself */
  title: string
  desc: string
  /** stored, else the url's host */
  site: string
  /** an emoji or a short mark, capped */
  icon: string
  /** '' unless the thumbnail is local (`asset:` or `data:`) */
  image: string
}

/**
 * What a `link` block SHOWS — resolved here, once, for every surface.
 *
 * EVERYTHING IS ALREADY IN THE FILE. There is no fetch on this path and there
 * cannot be one: PLATFORM §1 says a document needs no network to open, and
 * "A space does not phone home when it is opened" (DECISIONS, 2026-08-03) says
 * it in this app's own words. A link card in Notion or Slack is a server
 * fetching OpenGraph tags; a link card here is what the author typed. So this
 * function's whole job is falling back gracefully — a card with three empty
 * fields still has to be a working link, and a card with no url at all still
 * has to be something a reader can look at without wondering what broke.
 *
 * PURE and DOM-FREE, so the fallbacks are testable in node — including the
 * negative one, that a remote `image` yields no src for a renderer to load.
 */
export function linkCard(b: Block): LinkCard {
  const url = externalHref(b.url)
  const title = String(b.title ?? '').trim()
  const site = String(b.site ?? '').trim()
  const image = String(b.image ?? '')
  return {
    url,
    // the url is the honest headline for an untitled card: a reader can see
    // where it goes, which is the one thing a link has to say
    title: title || url,
    desc: String(b.desc ?? '').trim(),
    site: site || hostOf(url),
    // capped because it is drawn in a fixed slot and it comes from a file
    // someone mailed you — a 400-character "emoji" is a layout attack
    icon: String(b.icon ?? '').trim().slice(0, 8),
    image: image && !isRemote(image) ? image : '',
  }
}

/**
 * The card's READABLE FORM, as `Block.html`.
 *
 * The same contract a `prop` block keeps, for the same reason: `html` is what a
 * build that has never heard of this type renders (render.ts's default case),
 * so a card written today is still a working link in a shell built last year.
 * Format additivity is a promise about what OLD builds do, and it is only kept
 * by writing the fallback at the same moment as the fields.
 *
 * Every path that sets a card's fields goes through the one writer that also
 * calls this (editor.applyLinkCard), so the two cannot fall out of step.
 */
export function linkCardHtml(c: LinkCard): string {
  const tail = c.desc ? ` — ${esc(c.desc)}` : ''
  if (!c.url) return esc([c.title, c.desc].filter(Boolean).join(' — '))
  return `<a href="${esc(c.url)}">${esc(c.title || c.url)}</a>${tail}`
}

/** The host part of a url, or '' — parsing, never a lookup. */
function hostOf(url: string): string {
  if (!url) return ''
  try { return new URL(url).host.replace(/^www\./, '') } catch { return '' }
}
