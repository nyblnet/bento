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
  /** image: 'asset:<key>' | data: | https: */
  src?: string
  alt?: string
  caption?: string
  /** image width as a PERCENTAGE of the text column (10..100). No block
   *  carries absolute px — the column width is a theme concern. */
  width?: number
  /** intrinsic px at insert: holds the aspect box while the image decodes */
  w?: number
  h?: number
  /** pagelink: the target page id */
  page?: string
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

  [extra: string]: unknown
}

export interface Page {
  id: string
  title: string
  /** page-tree nesting; absent = a root page */
  parent?: string
  /** one emoji, never a URL — a URL would be a network dependency */
  icon?: string
  /** flat, pre-order; nesting via Block.parent */
  blocks: Block[]
  /** out of the sidebar, still searchable and linkable, and ENUMERATED at
   *  share time — an author archived a page precisely because it was sensitive */
  archived?: boolean
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
  /** RESERVED — collaboration credentials, unused until collab ships */
  collab?: unknown
  [extra: string]: unknown
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
 */
function repairId(scope: string, ordinal: number, content: string, salt = 0): string {
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
      if (b.html) {
        for (const m of b.html.matchAll(LINK_RE)) {
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

/** The page a reader lands on. */
export const homePage = (doc: SpacesDoc): Page | undefined =>
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
