// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento-sync M0 — the CRDT engine. Pure data, no DOM, no imports beyond the
// model types: the same file runs in the browser session layer and in the
// node convergence rig (scripts/test-sync.ts, node --experimental-strip-types).
//
// Design: docs/collab-design.md. Summary of the algebra:
//   - identity: slides key by their id; ELEMENTS key by the composite
//     `slideId U+001F elementId` (elKey) — the same element id on many
//     slides is the format's core morph idiom (data-flip-id pairing), so
//     each per-slide copy must be its own CRDT node. The doc format never
//     sees composite keys (element `id` stays the bare morph id); they
//     live in this layer's registers and on the wire. A cross-slide move
//     changes the key, so the differ emits del(old)+ins(new) — concurrent
//     moves of one element to two slides duplicate it (both users keep
//     their copy) instead of racing. `@doc` is the document's namespace.
//   - per-(node, key) LWW registers ordered by (lamport, actorId).
//   - order + parentage: one `pos` register per node (fractional base-62 key
//     + parent id) — arrays in the doc are always *materialized* pos-order.
//   - liveness: `births[id]` (stamped by ins) vs `tombs[id]` (stamped by del),
//     highest (l,a) wins. Delete beats concurrent edits; undo-of-delete is a
//     fresh ins carrying the full node, which resurrects by out-stamping the
//     tomb. A slide delete cascades to the elements the deleter saw (listed
//     in the op); concurrently inserted/moved-in elements survive in `limbo`
//     until re-parented.
//   - delivery: ops carry a per-actor contiguous sequence `s`; the version
//     vector is per-actor max-contiguous-seq, gaps are buffered in `gap`.
//   - text (M3): element.html upgrades to a token RGA on first concurrent
//     text edit ("seed" travels with the first txt op); plain `set html`
//     with a newer (l,a) resets the RGA (LWW compat with old clients).
//
// Convergence argument: every mutation is a join-semilattice merge (register
// max by (l,a), liveness max, RGA insert) applied under causal-enough
// delivery (per-actor FIFO via `s`, cross-actor buffering via `pending`).
// The rig replays random op interleavings across replicas and asserts
// identical materialized documents.

/**
 * The three shapes the engine touches, structurally.
 *
 * The kernel may not import an app's model (kernel/README.md, PLATFORM §9) —
 * and it does not need to. What the engine actually requires of a document is
 * this and nothing more: a container of parented nodes, each with an `id`,
 * under two keys named by the DocShape below. Every app's model satisfies it.
 */
type BentoDoc = object
type Slide = { id: string }
type SlideElement = { id: string }

// ---------------------------------------------------------------------------
// document shape
// ---------------------------------------------------------------------------

/**
 * WHICH KEYS HOLD THE TWO CONTAINER LEVELS.
 *
 * The engine's algebra — composite node keys, fractional position keys,
 * per-(node,key) registers, the token RGA over `html` — has nothing to do with
 * slides. Only the two property names do: the doc key holding the parent array
 * (`slides`) and the parent key holding the child array (`elements`).
 * bento/spaces has the same two levels under different names (`pages`,
 * `blocks`), so naming them is the whole of what it takes for one engine to
 * serve both apps.
 *
 * BOUND AT MODULE LEVEL, NEVER SERIALIZED, NEVER ON THE WIRE. A room is
 * single-app by construction (the room id is minted per file), so no frame
 * ever has to say which shape it came from — and putting a shape tag in
 * SyncStateJSON would change the bytes of every bento/slides file already on
 * a disk. That constraint is not a style preference: scripts/test-sync-equiv.ts
 * asserts byte-identity against the engine as shipped, and a `state-key-order`
 * mutant exists precisely to prove the comparator notices.
 *
 * The WIRE VOCABULARY is deliberately not parameterized. Ops keep saying
 * `kind:'slide'|'element'` and carrying `sl`/`el` for every app: renaming them
 * per app buys prettier debug output and costs a second binding on the
 * highest-consequence bytes in the system.
 */
export interface DocShape {
  /** doc-level key holding the PARENT array: 'slides' | 'pages' */
  readonly parents: string
  /**
   * Parent-level key holding the CHILD array: 'elements' | 'blocks' — or
   * `null` for a FLAT document, one level deep.
   *
   * bento/type is flat: a block IS the paragraph, so there is nothing beneath
   * it. Rather than make such an app invent an empty child array on every
   * node, the engine treats a childless shape as having no element layer at
   * all — `C()` reads as empty and the differ therefore never mints an element
   * op. See the guard in `applyEffect` for the receiving side.
   */
  readonly children: string | null
  /**
   * The property carrying collaboratively-edited TEXT, which gets the token
   * RGA rather than a last-writer-wins register.
   *
   * Named rather than hard-coded because it is the one property whose merge
   * behaviour decides whether two people can type in the same paragraph at
   * once. It was `'html'` in both existing apps, so the default keeps every
   * shipped file byte-identical; an app whose text lives elsewhere says so.
   */
  readonly text: string
  /**
   * Doc-level keys the differ never syncs.
   *
   * MUST contain `parents`, which is why `shape()` below DERIVES it rather
   * than taking it: the container is synced structurally — per node, with its
   * own position key — so listing it as an ordinary doc property instead would
   * collapse the whole document into ONE last-writer-wins register, and every
   * concurrent edit would destroy every other. Deriving it means no caller can
   * get it wrong; when this becomes a constructor argument, that has to become
   * an assertion instead.
   */
  readonly skipDoc: ReadonlySet<string>
  /**
   * Doc-level keys that are MAPS, merged per key rather than as one value.
   *
   * `assets` and `blobs` were hard-coded for this, with the right reason
   * attached: two people adding different assets concurrently must both keep
   * theirs. Any id-keyed map wants the same treatment, and an app has no way
   * to ask for it while the names are baked in — bento/type's `footnotes` is
   * one (note id → note text), and as a whole-value register it loses a note
   * BODY while both references survive, leaving a marker pointing at nothing.
   */
  readonly maps: ReadonlySet<string>
}

/** Derived, never authored: the volatile set is the same for every app apart
 *  from the container name, so writing it out twice invites them to drift. */
export const shape = (
  parents: string,
  children: string | null,
  text = 'html',
  maps: readonly string[] = [],
): DocShape => {
  const skipDoc = new Set([parents, 'modified', 'collab', 'format', 'version'])
  // `assets` and `blobs` are per-key for every app and always have been —
  // unioned rather than defaulted so an app naming its own map cannot drop them.
  return { parents, children, text, skipDoc, maps: new Set(['assets', 'blobs', ...maps]) }
}

/** The parent array of a document, and the child array of a parent. Indexed
 *  access through the descriptor: `d['slides']` is the same lookup `d.slides`
 *  was, so these are byte-neutral by construction. */
const P = (S: DocShape, d: BentoDoc): Slide[] => (d as unknown as Record<string, Slide[]>)[S.parents]
/**
 * A parent's children — empty, and FROZEN, when the shape is flat.
 *
 * Frozen on purpose: every mutating call site is supposed to be unreachable
 * without an element layer, and a throw says so at once. Silently swallowing a
 * push is how a replica ends up quietly missing content.
 */
const NO_CHILDREN: SlideElement[] = Object.freeze([]) as unknown as SlideElement[]
const C = (S: DocShape, p: Slide): SlideElement[] =>
  S.children === null ? NO_CHILDREN : (p as unknown as Record<string, SlideElement[]>)[S.children]
/**
 * …and the write-back form for the child array.
 *
 * There is deliberately no `setP`. The engine mutates the PARENT array only in
 * place (push/splice/sort), never by assignment — worth knowing, because a
 * future edit that reassigns it would be replacing the array the caller's
 * document still points at.
 */
const setC = (S: DocShape, p: Slide, v: SlideElement[]): void => {
  if (S.children === null) return // a flat document has no child array to write
  ;(p as unknown as Record<string, SlideElement[]>)[S.children] = v
}

/**
 * Collaboration credentials, as they live in the file.
 *
 * PLATFORM-level, not app-level (§2): every Bento document carries `docId` and
 * may carry `collab`, and the relay, the invite chain and the fork-merge all
 * work purely in these terms. The shape is documented at length in
 * bento/slides' model.ts, which is where it was written, and in
 * docs/collab-design.md.
 */
export interface CollabCreds {
  room: string
  key: string
  on?: boolean
  sync?: SyncStateJSON
  writerPub?: string
  writerPriv?: string
  role?: 'writer' | 'reader'
  v?: number
  owner?: string
  ownerPriv?: string
  invite?: { pub: string; priv: string; role: 'writer' | 'commenter'; exp?: number; sig: string }
}

/** A blob the document references but does not inline. */
export interface BlobRef { key: string; mime: string; size: number }

/**
 * The document, as the SESSION needs to see it.
 *
 * crdt.ts keeps `SyncDoc` deliberately opaque (`object`) because the ENGINE
 * genuinely does not care what is in a document — it is told the shape. The
 * session is a different layer and does care about a few fields, but only the
 * ones PLATFORM §2 guarantees EVERY Bento document has, so each app's own
 * document type already satisfies it structurally — no conversion, and no
 * index signature, which would have forced every app to declare one.
 */
export interface SyncDoc {
  docId: string
  collab?: CollabCreds
  assets?: Record<string, string>
  blobs?: Record<string, BlobRef>
  modified?: string
}

export const DOC_NODE = '@doc'

/**
 * Sync format version — stamped into SyncStateJSON (`v`) and every wire
 * frame (`pv`). v1 keyed elements by bare id, which collapsed the same id
 * appearing on multiple slides (the morph idiom); v2 state/ops are keyed
 * by composite element keys and are NOT interoperable, so v1 saved state
 * and v1 frames are discarded on sight.
 */
export const SYNC_V = 2

/**
 * Largest asset value that may travel INSIDE an op, in characters of its data
 * URI. Above this the session offloads the bytes to the relay's blob store and
 * syncs a `blobs.<key>` reference instead — a Durable Object storage value
 * caps near 2MB, so a big asset simply cannot be an op at any frame size.
 * Small assets stay inline: the round trip is not worth it for an icon.
 */
export const BLOB_INLINE_MAX = 64 * 1024

/** composite element node key: slide id + separator + element id. U+001F
 * never appears in model ids (uid() emits [a-z0-9-]; generators use ASCII). */
const SEP = '\u001f'
export const elKey = (sl: string, el: string): string => sl + SEP + el
export const keySlide = (key: string): string => key.slice(0, key.indexOf(SEP))
export const keyEl = (key: string): string => key.slice(key.indexOf(SEP) + 1)

/* eslint-disable no-console */
const dbg = (id: string, msg: string) => {
  const g = globalThis as unknown as { __dbgEl?: string; __dbgTag?: string }
  if (g.__dbgEl && g.__dbgEl === id) console.log(`      [dbg ${g.__dbgTag ?? ''} ${msg}]`)
}

// ---------------------------------------------------------------------------
// fractional order keys — base-62 midstrings, lexicographic, ASCII-sorted
// ---------------------------------------------------------------------------

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const D = (c: string) => DIGITS.indexOf(c)

/**
 * A key strictly between `a` and `b` ('' = unbounded on that side).
 * Classic midstring: walk digits; equal → copy; gap ≥ 2 → midpoint; adjacent
 * → keep low digit and continue against the open top. Never returns a key
 * ending in '0' (which would leave no room below it on extension).
 */
export function keyBetween(a: string, b: string): string {
  let out = ''
  for (let i = 0; ; i++) {
    const da = i < a.length ? D(a[i]) : 0
    const db = i < b.length ? D(b[i]) : 62
    if (da === db) {
      out += DIGITS[da]
      continue
    }
    if (db - da > 1) return out + DIGITS[Math.floor((da + db) / 2)]
    // adjacent digits: take the low one, then bisect a's tail against the top
    out += DIGITS[da]
    for (let j = i + 1; ; j++) {
      const ta = j < a.length ? D(a[j]) : 0
      if (62 - ta > 1) return out + DIGITS[Math.floor((ta + 62) / 2)]
      out += DIGITS[ta]
    }
  }
}

/** Deterministic evenly-spread key for index i of n (file adoption). */
export function spreadKey(i: number, n: number): string {
  let v = (i + 1) / (n + 1)
  let out = ''
  const need = Math.max(2, Math.ceil(Math.log(n + 2) / Math.log(62)) + 1)
  for (let k = 0; k < need; k++) {
    v *= 62
    const d = Math.min(61, Math.floor(v))
    out += DIGITS[d]
    v -= d
  }
  while (out.length > 1 && out.endsWith('0')) out = out.slice(0, -1)
  return out === '0' ? '1' : out
}

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

export type Reg = [number, string] // [lamport, actor]

const newer = (l: number, a: string, r: Reg | undefined): boolean =>
  !r || l > r[0] || (l === r[0] && a > r[1])
const regNewer = (x: Reg, y: Reg | undefined): boolean => newer(x[0], x[1], y)

export interface OpBase {
  a: string // actor
  s: number // per-actor contiguous sequence (delivery/vv)
  l: number // lamport (conflict order)
}
export interface SetOp extends OpBase {
  op: 'set'
  /** node id: composite element key (elKey), slide id, or absent → @doc */
  el?: string
  sl?: string
  /** property key; doc-level supports dotted sub-keys 'assets.<k>' */
  k: string
  /** undefined/absent = delete the key */
  v?: unknown
}
export interface InsOp extends OpBase {
  op: 'ins'
  kind: 'slide' | 'element'
  /** slide id, or composite element key (its slide part = `sl`) */
  id: string
  /** parent: slide id for elements, ignored for slides */
  sl?: string
  ord: string
  /** doc-shaped payload — element ids inside stay bare (the format never
   * sees composite keys) */
  node: Slide | SlideElement
}
export interface DelOp extends OpBase {
  op: 'del'
  kind: 'slide' | 'element'
  /** slide id, or composite element key */
  id: string
  /** slide delete: composite keys of the elements the deleter saw inside
   * (cascade tombstones) */
  cas?: string[]
}
export interface OrdOp extends OpBase {
  op: 'ord'
  kind: 'slide' | 'element'
  /** slide id, or composite element key */
  id: string
  ord: string
  /** elements: the parent slide (constant for a given key — moves across
   * slides change the key itself via del+ins) */
  sl?: string
}
/** M3 — text RGA delta for one element's html. */
export interface TxtOp extends OpBase {
  op: 'txt'
  /**
   * The node the text lives on: a composite element key, or a bare parent id
   * for an app whose text sits on the parent (bento/type's blocks). The field
   * keeps its name because it is on the wire in every shipped file.
   */
  el: string
  /** seed reference: (l,a) of the RGA base this delta applies to */
  sd: Reg
  /** present on the op that CREATES the seed: the base html it tokenized */
  base?: string
  /** deletions: token ids */
  del?: string[]
  /** insertions: after-anchor token id ('^' = start) + tokens */
  ins?: Array<{ at: string; toks: string[] }>
}
export type Op = SetOp | InsOp | DelOp | OrdOp | TxtOp

// ---------------------------------------------------------------------------
// sync state (per document, serializable)
// ---------------------------------------------------------------------------

interface PosEntry {
  p: string // parent node id (@doc for slides)
  o: string // fractional key
  r: Reg
}

export interface TxtTok {
  id: string
  t: string
  d?: 1
}
export interface TxtState {
  sd: Reg
  toks: TxtTok[]
  /** deletes that overtook their token's insert — resolved on arrival */
  pd?: string[]
}

export interface SyncStateJSON {
  /** sync format version (SYNC_V) — mismatched saved state is discarded */
  v: number
  lamport: number
  vv: Record<string, number>
  regs: Record<string, Reg>
  pos: Record<string, PosEntry>
  births: Record<string, Reg>
  tombs: Record<string, Reg>
  /**
   * Per-character token history for every text node — the structure that lets
   * two people type into one paragraph without either clobbering the other.
   *
   * OPTIONAL, and an app may choose not to stamp it. Measured: identical prose
   * costs ×0.2 of its own size when it arrives as one write (a paste, an
   * import, an agent) and ×25.8 when it is TYPED, because a typing run mints a
   * token per character and a deletion cannot remove one — a tombstone is how
   * "delete" is expressed to a replica that has not caught up yet, so the
   * history only ever grows. An emptied paragraph still carries everything ever
   * typed into it.
   *
   * bento/slides stamps it: slide text is titles and bullets. bento/spaces
   * does NOT — a space is typed prose, which is the whole app, and the state
   * would outweigh the document many times over inside the plaintext
   * #bento-doc block, re-serialized on every save and re-parsed on every open.
   *
   * ABSENT MEANS BLOCK-LEVEL MERGING, not breakage: `fromJSON` restores a
   * state with no token history, the differ falls back to a whole-value `set`
   * for that node's text, and the merge resolves last-writer-wins per block
   * instead of per character. A LIVE session is unaffected — both replicas hold
   * the tokens in memory for as long as they are connected; what degrades is
   * two offline forks reunited later, editing the SAME paragraph.
   *
   * Garbage-collecting the tombstones instead (what Yjs does by default) needs
   * to know every replica has seen the delete. A file that people mail to each
   * other has no closed set of peers and no moment at which that becomes true —
   * a copy can come back out of a mailbox a year later — so the causal cutoff
   * that makes GC safe never arrives here.
   */
  txt?: Record<string, TxtState>
  /** values set during a node's dead window — replayed on resurrection.
   * `r` is the register stamp the value belongs to: replay only while it
   * is still the current winner (a newer applied set invalidates it). */
  stash: Record<string, Record<string, { v?: unknown; r: Reg }>>
  /** live nodes whose winning parent is dead/absent (invisible but kept) */
  limbo: Record<string, SlideElement>
}

export interface ApplyResult {
  /** anything changed at all */
  changed: boolean
  /** slide list / element structure changed (sidebar + canvas rebuild) */
  structure: boolean
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

/**
 * The engine, shape-injected. Not exported as the app-facing name — see
 * `SyncState` below.
 */
export class SyncEngine {
  actor: string
  lamport = 0
  /** per-actor max contiguous sequence applied */
  vv: Record<string, number> = {}
  private seq = 0
  regs: Record<string, Reg> = {}
  pos: Record<string, PosEntry> = {}
  births: Record<string, Reg> = {}
  tombs: Record<string, Reg> = {}
  txt: Record<string, TxtState> = {}
  /** dead-window set values, replayed if the node resurrects */
  stash: Record<string, Record<string, { v?: unknown; r: Reg }>> = {}
  /** live nodes whose winning parent is dead/absent — data parked here */
  limbo: Record<string, SlideElement> = {}
  /** ops targeting nodes we haven't seen yet, keyed by node id */
  private pending: Record<string, Op[]> = {}
  /** out-of-order ops per actor awaiting their gap to fill */
  private gap: Record<string, Op[]> = {}

  /** The document shape. NO DEFAULT, deliberately: a default is how a spaces
   *  call site silently gets slides' shape and corrupts a room that then has
   *  no way to be repaired in the field. */
  readonly S: DocShape

  constructor(actor: string, shape: DocShape) {
    // A hand-built DocShape that omits `text` disables the token RGA SILENTLY:
    // every property comparison against `undefined` fails, so collaborative
    // text quietly degrades to last-writer-wins and two people typing in one
    // paragraph destroy each other's work. Measured — a literal missing this
    // field turned four passing checks red with no other symptom. Build shapes
    // with `shape()`; if you must hand-build one, this says so immediately.
    if (!shape.text) throw new Error('DocShape.text is required — build it with shape()')
    // Same reasoning for `maps`, which arrived later: a literal without it
    // does not degrade quietly, it throws deep inside the differ on the first
    // doc-property diff. Failing here names the actual cause.
    if (!shape.maps) throw new Error('DocShape.maps is required — build it with shape()')

    this.actor = actor
    this.S = shape
  }

  /** actors with buffered out-of-order ops → catch-up should be requested */
  get gappedActors(): string[] {
    return Object.keys(this.gap).filter((a) => this.gap[a].length)
  }

  /** dead iff the latest delete out-stamps the latest insert */
  dead(id: string): boolean {
    const t = this.tombs[id]
    if (!t) return false
    const b = this.births[id]
    return !b || !regNewer(b, t)
  }

  /**
   * The state, as it is stamped into a saved file.
   *
   * `opts.text: false` OMITS the token history — see the note on
   * SyncStateJSON.txt. The default is unchanged and always will be: every
   * bento/slides file in the field was written with `txt` present, and
   * scripts/test-sync-equiv.ts compares these bytes against the engine as
   * shipped.
   *
   * KEY ORDER IS PART OF THE FORMAT. `txt` is emitted in its original position
   * rather than appended, so a state WITH text is byte-identical whichever
   * call site produced it.
   */
  toJSON(opts: { text?: boolean } = {}): SyncStateJSON {
    return {
      v: SYNC_V,
      lamport: this.lamport,
      vv: this.vv,
      regs: this.regs,
      pos: this.pos,
      births: this.births,
      tombs: this.tombs,
      ...(opts.text === false ? {} : { txt: this.txt }),
      stash: this.stash,
      limbo: this.limbo,
    }
  }

  /**
   * `new this(actor)`, not `new SyncState(actor)`.
   *
   * The literal construction meant a SUBCLASS could not be produced through
   * fromJSON — it silently handed back the base class. That is why
   * scripts/test-sync-equiv.ts re-points prototypes to build its mutants, a
   * harness liberty its own comment flags; with this, a mutant (and every
   * app binding) restores as itself.
   */
  static fromJSON<T extends SyncEngine>(this: new (actor: string) => T, actor: string, j: SyncStateJSON): T {
    const s = new this(actor)
    if (j.v !== SYNC_V) return s // pre-v2 state keyed elements by bare id — unusable
    s.lamport = j.lamport
    s.vv = j.vv ?? {}
    s.seq = s.vv[actor] ?? 0
    s.regs = j.regs ?? {}
    s.pos = j.pos ?? {}
    s.births = j.births ?? {}
    s.tombs = j.tombs ?? {}
    s.txt = j.txt ?? {}
    s.stash = j.stash ?? {}
    s.limbo = j.limbo ?? {}
    return s
  }

  // --- local op minting ----------------------------------------------------

  private stamp(): OpBase {
    this.lamport++
    this.seq++
    this.vv[this.actor] = this.seq
    return { a: this.actor, s: this.seq, l: this.lamport }
  }

  /**
   * Adopt a document that has never synced: assign deterministic pos entries
   * from current array order (both replicas of the same file derive the same
   * keys) with the null register [0,''] that loses to every real op.
   */
  adopt(doc: BentoDoc) {
    const ns = P(this.S, doc).length
    P(this.S, doc).forEach((sl, i) => {
      if (!this.pos[sl.id]) this.pos[sl.id] = { p: DOC_NODE, o: spreadKey(i, ns), r: [0, ''] }
      const ne = C(this.S, sl).length
      C(this.S, sl).forEach((el, j) => {
        const k = elKey(sl.id, el.id)
        if (!this.pos[k]) this.pos[k] = { p: sl.id, o: spreadKey(j, ne), r: [0, ''] }
      })
    })
  }

  // --- diffing (local mutations → ops) ------------------------------------

  /**
   * Structural diff between two document snapshots → ops, updating our own
   * registers as it mints (own ops are "pre-applied"; apply() skips them).
   */
  diff(before: BentoDoc, after: BentoDoc, opts: { text?: boolean } = {}): Op[] {
    const ops: Op[] = []
    this.seededInDiff.length = 0
    const push = <T extends Op>(o: T): T => {
      ops.push(o)
      return o
    }

    // ---- doc-level props
    const SKIP_DOC = this.S.skipDoc
    const b = before as unknown as Record<string, unknown>
    const a = after as unknown as Record<string, unknown>
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (SKIP_DOC.has(k)) continue
      // `assets` and `blobs` are per-KEY registers, not whole-map ones, so two
      // people adding different assets concurrently both keep theirs.
      if (this.S.maps.has(k)) {
        const ba = (b[k] ?? {}) as Record<string, unknown>
        const aa = (a[k] ?? {}) as Record<string, unknown>
        for (const ak of new Set([...Object.keys(ba), ...Object.keys(aa)])) {
          if (JSON.stringify(ba[ak]) === JSON.stringify(aa[ak])) continue
          // An asset too big to ride in an op is skipped here and travels as a
          // blob instead: the session uploads it and publishes a reference
          // under `blobs.<key>`, which IS small enough. Deletions still sync
          // (v === undefined), so removing an asset is never stranded.
          if (k === 'assets' && typeof aa[ak] === 'string' && (aa[ak] as string).length > BLOB_INLINE_MAX) continue
          const o = push<SetOp>({ ...this.stamp(), op: 'set', k: `${k}.${ak}`, v: clone(aa[ak]) })
          this.regs[`${DOC_NODE} ${k}.${ak}`] = [o.l, o.a]
        }
        continue
      }
      if (JSON.stringify(b[k]) === JSON.stringify(a[k])) continue
      const o = push<SetOp>({ ...this.stamp(), op: 'set', k, v: clone(a[k]) })
      this.regs[`${DOC_NODE} ${k}`] = [o.l, o.a]
    }

    // ---- slides by id; elements by COMPOSITE key (slide + bare id) — the
    // same element id on many slides is the morph idiom, each copy is its
    // own node. A cross-slide move therefore diffs as del(old)+ins(new).
    const bSlides = new Map(P(this.S, before).map((s) => [s.id, s]))
    const aSlides = new Map(P(this.S, after).map((s) => [s.id, s]))
    const bEls = new Map<string, { sl: string; el: SlideElement }>()
    const aEls = new Map<string, { sl: string; el: SlideElement }>()
    P(this.S, before).forEach((s) => C(this.S, s).forEach((el) => bEls.set(elKey(s.id, el.id), { sl: s.id, el })))
    P(this.S, after).forEach((s) => C(this.S, s).forEach((el) => aEls.set(elKey(s.id, el.id), { sl: s.id, el })))

    // deleted slides (cascade the elements the deleter saw, minus survivors)
    for (const [id, sl] of bSlides) {
      if (aSlides.has(id)) continue
      const cas = C(this.S, sl).map((e) => elKey(id, e.id)).filter((k) => !aEls.has(k))
      const o = push<DelOp>({ ...this.stamp(), op: 'del', kind: 'slide', id, cas })
      this.tombs[id] = [o.l, o.a]
      this.stashNode(sl as unknown as Record<string, unknown>, id)
      cas.forEach((ek) => {
        this.tombs[ek] = [o.l, o.a]
        const node = C(this.S, sl).find((e) => elKey(id, e.id) === ek)
        if (node) this.stashNode(node as unknown as Record<string, unknown>, ek)
        delete this.limbo[ek]
        delete this.txt[ek] // local tomb is the freshest stamp — always out-ranks
      })
    }
    // inserted (or resurrected) slides
    const afterIds = P(this.S, after).map((s) => s.id)
    for (let i = 0; i < afterIds.length; i++) {
      const id = afterIds[i]
      if (bSlides.has(id)) continue
      const sl = aSlides.get(id)!
      const ord = this.keyAround(DOC_NODE, afterIds, i)
      const o = push<InsOp>({ ...this.stamp(), op: 'ins', kind: 'slide', id, ord, node: clone(sl) })
      this.births[id] = [o.l, o.a]
      this.pos[id] = { p: DOC_NODE, o: ord, r: [o.l, o.a] }
      delete this.txt[id]
      delete this.stash[id] // fresh birth voids parked values (receivers do this in replayStash)
      const ne = C(this.S, sl).length
      C(this.S, sl).forEach((el, j) => {
        const k = elKey(id, el.id)
        this.births[k] = [o.l, o.a]
        this.pos[k] = { p: id, o: spreadKey(j, ne), r: [o.l, o.a] }
        delete this.txt[k] // rebirth voids stale text generations
        delete this.stash[k]
      })
    }
    // kept slides: prop diffs
    for (const [id, sl] of aSlides) {
      const prev = bSlides.get(id)
      if (!prev || prev === sl) continue
      const bp = prev as unknown as Record<string, unknown>
      const ap = sl as unknown as Record<string, unknown>
      for (const k of new Set([...Object.keys(bp), ...Object.keys(ap)])) {
        if (k === this.S.children || k === 'id') continue
        if (JSON.stringify(bp[k]) === JSON.stringify(ap[k])) continue
        // Text on a PARENT gets the same token RGA as text on a child. An app
        // whose text lives one level up (bento/type: a block IS the paragraph)
        // would otherwise get a last-writer-wins register here, and two people
        // typing in one paragraph would silently destroy each other's work.
        if (k === this.S.text && opts.text && typeof bp[k] === 'string' && typeof ap[k] === 'string') {
          const t = this.diffText(id, bp[k] as string, ap[k] as string)
          if (t) {
            push(t)
            continue
          }
        }
        const o = push<SetOp>({ ...this.stamp(), op: 'set', sl: id, k, v: clone(ap[k]) })
        this.regs[`${id} ${k}`] = [o.l, o.a]
        if (k === this.S.text) delete this.txt[id] // LWW reset wins over RGA state
      }
    }
    // slide order: minimal ord ops (keep the longest already-ordered run).
    // ALL ids participate — fresh inserts got keys above, but the reorder
    // pass must see them or its re-keying can leapfrog their positions
    this.diffOrder(afterIds, DOC_NODE, 'slide', push)

    // ---- elements
    for (const [id, rec] of bEls) {
      if (aEls.has(id)) continue
      if (this.tombs[id] && this.dead(id)) continue // died with its slide above
      const o = push<DelOp>({ ...this.stamp(), op: 'del', kind: 'element', id })
      this.tombs[id] = [o.l, o.a]
      this.stashNode(rec.el as unknown as Record<string, unknown>, id)
      delete this.limbo[id]
      delete this.txt[id]
    }
    for (const [id, { sl, el }] of aEls) {
      const prev = bEls.get(id)
      if (!prev) {
        if (this.births[id] && !this.dead(id) && this.pos[id]?.p === sl) continue // came with a fresh slide ins above
        const sib = C(this.S, aSlides.get(sl)!).map((e) => elKey(sl, e.id))
        const ord = this.keyAround(sl, sib, sib.indexOf(id))
        const o = push<InsOp>({ ...this.stamp(), op: 'ins', kind: 'element', id, sl, ord, node: clone(el) })
        this.births[id] = [o.l, o.a]
        this.pos[id] = { p: sl, o: ord, r: [o.l, o.a] }
        delete this.txt[id] // rebirth voids stale text generations
        delete this.stash[id]
        continue
      }
      if (prev.el !== el || JSON.stringify(prev.el) !== JSON.stringify(el)) {
        const bp = prev.el as unknown as Record<string, unknown>
        const ap = el as unknown as Record<string, unknown>
        for (const k of new Set([...Object.keys(bp), ...Object.keys(ap)])) {
          if (k === 'id') continue
          if (JSON.stringify(bp[k]) === JSON.stringify(ap[k])) continue
          if (k === this.S.text && opts.text && typeof bp[this.S.text] === 'string' && typeof ap[this.S.text] === 'string') {
            const t = this.diffText(id, bp[this.S.text] as string, ap[this.S.text] as string)
            if (t) {
              push(t)
              continue
            }
          }
          const o = push<SetOp>({ ...this.stamp(), op: 'set', sl, el: id, k, v: clone(ap[k]) })
          this.regs[`${id} ${k}`] = [o.l, o.a]
          if (k === this.S.text) delete this.txt[id] // LWW reset wins over RGA state
        }
      }
      // no cross-slide move branch: the composite key IS (slide, id), so a
      // moved element always lands in the delete/insert passes above
    }
    // element order within each surviving slide (all ids — see slide pass)
    for (const [id, sl] of aSlides) {
      if (!bSlides.has(id)) continue
      this.diffOrder(C(this.S, sl).map((e) => elKey(id, e.id)), id, 'element', push)
    }

    // remote ops that pended awaiting a seed can resolve against seeds this
    // diff just created — drained AFTER diffing so comparisons stay stable
    for (const el of this.seededInDiff) this.drainPending(after, el)
    this.seededInDiff.length = 0

    return ops
  }

  private seededInDiff: string[] = []

  /** ord key for position i within the id list `ids` under parent `p`. */
  private keyAround(p: string, ids: string[], i: number): string {
    const ordOf = (id: string | undefined) =>
      id && this.pos[id] && this.pos[id].p === p ? this.pos[id].o : undefined
    let lo = ''
    for (let k = i - 1; k >= 0; k--) {
      const o = ordOf(ids[k])
      if (o) {
        lo = o
        break
      }
    }
    let hi = ''
    for (let k = i + 1; k < ids.length; k++) {
      const o = ordOf(ids[k])
      if (o && (!lo || o > lo)) {
        hi = o
        break
      }
    }
    return keyBetween(lo, hi)
  }

  /**
   * Emit ord ops for ids whose relative order changed: keep a longest
   * increasing run (by current pos key) untouched, re-key the rest.
   */
  private diffOrder(
    ids: string[],
    parent: string,
    kind: 'slide' | 'element',
    push: <T extends Op>(o: T) => T,
  ) {
    if (ids.some((id) => !this.pos[id])) return // unknown ids — keyed this diff
    const keys = ids.map((id) => this.pos[id].o + ' ' + id)
    const keep = new Set(longestIncreasing(keys))
    for (let i = 0; i < ids.length; i++) {
      if (keep.has(i) && this.pos[ids[i]].p === parent) continue
      const id = ids[i]
      let lo = ''
      for (let k = i - 1; k >= 0; k--) {
        const e = this.pos[ids[k]]
        if (e && e.p === parent) {
          lo = e.o
          break
        }
      }
      let hi = ''
      for (let k = i + 1; k < ids.length; k++) {
        if (!keep.has(k)) continue
        const e = this.pos[ids[k]]
        if (e && e.p === parent && e.o > lo) {
          hi = e.o
          break
        }
      }
      const ord = keyBetween(lo, hi)
      const o = push<OrdOp>({
        ...this.stamp(),
        op: 'ord',
        kind,
        id,
        ord,
        ...(kind === 'element' ? { sl: parent } : {}),
      })
      this.pos[id] = { p: parent, o: ord, r: [o.l, o.a] }
    }
  }

  // --- text RGA (M3) -------------------------------------------------------

  /** local html edit → txt op (or null → caller falls back to set-html) */
  private diffText(el: string, oldHtml: string, newHtml: string): TxtOp | null {
    const had = !!this.txt[el]
    let st = this.txt[el]
    if (!st) {
      // Deterministic seed: (current html-register/birth lamport, content
      // hash). Concurrent first-editors of the same base derive the SAME
      // seed, so both their edits merge; after a set-html reset or a node
      // rebirth the lamport has grown, so fresh seeds out-rank stale ones.
      const sd: Reg = [
        Math.max(this.regs[`${el} ${this.S.text}`]?.[0] ?? 0, this.births[el]?.[0] ?? 0),
        contentHash(oldHtml),
      ]
      st = this.txt[el] = { sd, toks: seedTokens(sd, oldHtml) }
      this.seededInDiff.push(el)
    }
    if (materialize(st) !== oldHtml) {
      delete this.txt[el] // RGA drifted from the model — heal via LWW reset
      return null
    }
    const vis = st.toks.filter((t) => !t.d)
    const oldT = vis.map((t) => t.t)
    const newT = tokenize(newHtml)
    let p = 0
    while (p < oldT.length && p < newT.length && oldT[p] === newT[p]) p++
    let sOld = oldT.length
    let sNew = newT.length
    while (sOld > p && sNew > p && oldT[sOld - 1] === newT[sNew - 1]) {
      sOld--
      sNew--
    }
    const del = vis.slice(p, sOld).map((t) => t.id)
    const insToks = newT.slice(p, sNew)
    const op: TxtOp = {
      ...this.stamp(),
      op: 'txt',
      el,
      sd: st.sd,
      ...(had ? {} : { base: oldHtml }),
      ...(del.length ? { del } : {}),
      ...(insToks.length ? { ins: [{ at: p > 0 ? vis[p - 1].id : '^', toks: insToks }] } : {}),
    }
    applyTxtToState(st, op)
    if (materialize(st) !== newHtml) {
      delete this.txt[el]
      return null // self-heal: fall back to whole-value set
    }
    return op
  }

  // --- applying remote ops -------------------------------------------------

  apply(doc: BentoDoc, ops: Op[]): ApplyResult {
    const res: ApplyResult = { changed: false, structure: false }
    for (const op of ops) this.applyOne(doc, op, res)
    if (res.structure) this.rematerialize(doc)
    return res
  }

  private applyOne(doc: BentoDoc, op: Op, res: ApplyResult) {
    if (op.a === this.actor) return // own ops are pre-applied at diff time
    const seen = this.vv[op.a] ?? 0
    if (op.s <= seen) return // duplicate
    if (op.s > seen + 1) {
      // gap — buffer until the missing ops arrive (catch-up fills them)
      const g = (this.gap[op.a] ??= [])
      if (!g.some((o) => o.s === op.s)) {
        g.push(op)
        g.sort((x, y) => x.s - y.s)
      }
      return
    }
    this.vv[op.a] = op.s
    this.lamport = Math.max(this.lamport, op.l)
    this.applyEffect(doc, op, res)
    const g = this.gap[op.a]
    while (g && g.length && g[0].s === this.vv[op.a] + 1) {
      const next = g.shift()!
      this.vv[op.a] = next.s
      this.lamport = Math.max(this.lamport, next.l)
      this.applyEffect(doc, next, res)
    }
  }

  private applyEffect(doc: BentoDoc, op: Op, res: ApplyResult) {
    // A FLAT document has no element layer, so an element-scoped op has
    // nowhere to land. It should never arrive — peers in a room share a shape
    // — but the frame came off the wire, and materializing it would either
    // throw against the frozen child array or invent a key the format does not
    // have. Dropping is the only safe reading, and the version vector still
    // advanced in applyOne, so delivery does not stall behind it.
    const scope = op as Partial<{ el: string; kind: string; id: string }>
    // `el` does NOT mean "element" on a txt op — there it is the NODE key,
    // which for a flat document is the block's own id. Reading it as an
    // element key here dropped every collaborative keystroke type would ever
    // send, while structure ops kept converging: the rig saw one author's
    // edits land and the other's silently vanish.
    const elementScoped = scope.kind === 'element' ||
      (op.op === 'txt' ? String(scope.el).includes(SEP) : scope.el !== undefined)
    if (this.S.children === null && elementScoped) {
      dbg(scope.el ?? scope.id ?? '?', `${op.op} DROP no element layer in this shape`)
      return
    }
    switch (op.op) {
      case 'set':
        this.applySet(doc, op, res)
        break
      case 'ins':
        this.applyIns(doc, op, res)
        break
      case 'del':
        this.applyDel(doc, op, res)
        break
      case 'ord':
        this.applyOrd(doc, op, res)
        break
      case 'txt':
        this.applyTxt(doc, op, res)
        break
    }
  }

  private findSlide(doc: BentoDoc, id: string): Slide | undefined {
    return P(this.S, doc).find((s) => s.id === id)
  }
  /** composite-key lookup: an element node only ever lives on its key's
   * slide (or in limbo) — the same bare id on other slides is other nodes */
  private findEl(doc: BentoDoc, key: string): SlideElement | undefined {
    const s = this.findSlide(doc, keySlide(key))
    const bare = keyEl(key)
    return (s ? C(this.S, s) : undefined)?.find((e) => e.id === bare) ?? this.limbo[key]
  }

  /**
   * Split a doc-level property key into (map, entry) if it addresses a
   * declared map — `assets.logo` → ['assets','logo'].
   *
   * Matched against the SHAPE rather than by looking for a dot: an ordinary
   * property whose name happens to contain one must not be mistaken for a map
   * entry and quietly written into a sub-object.
   */
  private mapKey(k: string): [string, string] | undefined {
    const i = k.indexOf('.')
    if (i <= 0) return undefined
    const field = k.slice(0, i)
    return this.S.maps.has(field) ? [field, k.slice(i + 1)] : undefined
  }

  /** either level: composite keys carry SEP, parent ids never do */
  private findNode(doc: BentoDoc, id: string): Record<string, unknown> | undefined {
    return (id.includes(SEP) ? this.findEl(doc, id) : this.findSlide(doc, id)) as
      | Record<string, unknown>
      | undefined
  }

  private applySet(doc: BentoDoc, op: SetOp, res: ApplyResult) {
    const nodeId = op.el ?? op.sl ?? DOC_NODE
    const rk = `${nodeId} ${op.k}`
    if (!newer(op.l, op.a, this.regs[rk])) return
    // birth gate: an ins is a whole-node assignment — sets older than the
    // node's (re)birth are superseded everywhere (register still advances)
    const birth = nodeId !== DOC_NODE ? this.births[nodeId] : undefined
    if (birth && !newer(op.l, op.a, birth)) {
      dbg(nodeId, `set ${op.k}@${op.l},${op.a} GATED by birth ${JSON.stringify(birth)}`)
      this.regs[rk] = [op.l, op.a]
      return
    }
    if (nodeId !== DOC_NODE && this.dead(nodeId)) {
      // register still advances (state convergence) and the value parks in
      // the stash — a resurrecting ins replays stashed values whose regs
      // outrank it, so every replica lands on the same post-resurrect state
      dbg(nodeId, `set ${op.k}@${op.l},${op.a} DEAD-STASH`)
      this.regs[rk] = [op.l, op.a]
      ;(this.stash[nodeId] ??= {})[op.k] =
        op.v === undefined ? { r: [op.l, op.a] } : { v: clone(op.v), r: [op.l, op.a] }
      return
    }
    if (nodeId === DOC_NODE) {
      this.regs[rk] = [op.l, op.a]
      const dot = this.mapKey(op.k)
      if (dot) {
        const [field, ak] = dot
        const map = ((doc as unknown as Record<string, Record<string, unknown>>)[field] ??= {})
        if (op.v === undefined) delete map[ak]
        else map[ak] = clone(op.v)
      } else {
        const d = doc as unknown as Record<string, unknown>
        if (op.v === undefined) delete d[op.k]
        else d[op.k] = clone(op.v)
      }
      res.changed = true
      res.structure = true
      return
    }
    const target = (op.el ? this.findEl(doc, op.el) : this.findSlide(doc, op.sl!)) as
      | Record<string, unknown>
      | undefined
    if (!target) {
      dbg(nodeId, `set ${op.k}@${op.l},${op.a} PEND no-target`)
      ;(this.pending[nodeId] ??= []).push(op)
      return
    }
    // NB: v === undefined means "delete the key" (handled below), and
    // JSON.stringify(undefined) is undefined — String() keeps this debug
    // line from throwing on every property REMOVAL.
    dbg(nodeId, `set ${op.k}@${op.l},${op.a} APPLY ${String(JSON.stringify(op.v)).slice(0, 40)}`)
    if (nodeId !== DOC_NODE && op.k === this.S.text) {
      const gen = this.txt[nodeId]
      if (gen && cmpReg([op.l, op.a], gen.sd) < 0) {
        // a live text generation outranks this set — value loses, reg advances
        this.regs[rk] = [op.l, op.a]
        return
      }
      dbg(nodeId, `set-text@${op.l},${op.a} RESET kills gen`)
      delete this.txt[nodeId] // the set out-stamps the generation: reset
    }
    this.regs[rk] = [op.l, op.a]
    if (op.v === undefined) delete target[op.k]
    else target[op.k] = clone(op.v)
    res.changed = true
    if (!op.el) res.structure = true // slide props show in the sidebar
  }

  private applyIns(doc: BentoDoc, op: InsOp, res: ApplyResult) {
    const stamp: Reg = [op.l, op.a]
    if (op.kind === 'slide') {
      // a slide ins = one slide-level assignment + an independent element
      // ins per member. Member processing must NOT be skipped when the
      // slide-level record loses its LWW race — replicas that saw this op
      // first ran it, so everyone must.
      const src = op.node as Slide
      this.insertSlideLevel(doc, op.id, op.ord, src, stamp, res)
      const ne = C(this.S, src).length
      C(this.S, src).forEach((e, j) => this.insertElement(doc, elKey(op.id, e.id), op.id, spreadKey(j, ne), e, stamp, res))
      this.drainPending(doc, op.id)
      C(this.S, src).forEach((e) => this.drainPending(doc, elKey(op.id, e.id)))
    } else {
      this.insertElement(doc, op.id, op.sl!, op.ord, op.node as SlideElement, stamp, res)
      this.drainPending(doc, op.id)
    }
  }

  private insertSlideLevel(doc: BentoDoc, id: string, ord: string, src: Slide, stamp: Reg, res: ApplyResult) {
    const birth = this.births[id]
    if (birth && !newer(stamp[0], stamp[1], birth)) return // an older create
    this.births[id] = stamp
    if (!this.pos[id] || regNewer(stamp, this.pos[id].r)) this.pos[id] = { p: DOC_NODE, o: ord, r: stamp }
    if (this.txt[id] && this.txt[id].sd[0] < stamp[0]) {
      dbg(id, `slide-ins@${stamp[0]},${stamp[1]} voids gen`)
      delete this.txt[id]
    }
    res.changed = true
    res.structure = true
    if (this.dead(id)) return // a delete still out-stamps this insert
    const existing = this.findSlide(doc, id)
    if (existing) {
      this.assignNode(existing as unknown as Record<string, unknown>, src as unknown as Record<string, unknown>, id, stamp, this.S.children === null ? ['id'] : ['id', this.S.children])
    } else {
      const sl = clone(src)
      setC(this.S, sl, []) // members materialize separately via insertElement
      P(this.S, doc).push(sl)
      this.replayStash(sl as unknown as Record<string, unknown>, id, stamp)
    }
  }

  private insertElement(doc: BentoDoc, id: string, parent: string, ord: string, node: SlideElement, stamp: Reg, res: ApplyResult) {
    const birth = this.births[id]
    dbg(id, `insertElement stamp=${JSON.stringify(stamp)} birth=${JSON.stringify(birth)} accepted=${!birth || newer(stamp[0], stamp[1], birth)}`)
    if (birth && !newer(stamp[0], stamp[1], birth)) return // an older create
    this.births[id] = stamp
    if (!this.pos[id] || regNewer(stamp, this.pos[id].r)) this.pos[id] = { p: parent, o: ord, r: stamp }
    // rebirth voids STALE generations only — a late-arriving old ins must
    // not kill a generation seeded above its lamport
    if (this.txt[id] && this.txt[id].sd[0] < stamp[0]) {
      dbg(id, `el-ins@${stamp[0]},${stamp[1]} voids gen`)
      delete this.txt[id]
    }
    res.changed = true
    res.structure = true
    if (this.dead(id)) return // a delete still out-stamps this insert
    const existing = this.findEl(doc, id)
    let live: SlideElement
    if (existing) {
      // the live copy (doc or limbo) keeps applied set-values; the payload
      // assigns over properties whose registers are older than the birth
      this.assignNode(existing as unknown as Record<string, unknown>, node as unknown as Record<string, unknown>, id, stamp, ['id'])
      live = existing
    } else {
      const el = clone(node)
      const p = this.pos[id].p
      const sl = this.findSlide(doc, p)
      if (sl && !this.dead(p)) C(this.S, sl).push(el)
      else this.limbo[id] = el
      this.replayStash(el as unknown as Record<string, unknown>, id, stamp)
      live = el
    }
    // a text generation that survived the node's death (it out-ranked the
    // tomb) is the html authority — re-materialize over the ins payload
    const g = this.txt[id]
    if (g && this.S.text in live) (live as unknown as Record<string, string>)[this.S.text] = materialize(g)
  }

  /**
   * Whole-node assignment from an ins payload: every property whose register
   * is OLDER than the (re)birth takes the payload's value; properties with
   * newer registers keep the set-winner (value present locally, or parked in
   * the stash). Runs identically on every replica — including ones where the
   * node never died — which is what makes resurrection convergent.
   */
  private assignNode(node: Record<string, unknown>, payload: Record<string, unknown>, id: string, birth: Reg, skip: string[]) {
    for (const k of new Set([...Object.keys(node), ...Object.keys(payload)])) {
      if (skip.includes(k)) continue
      if (k === this.S.text && this.txt[id]) {
        if (this.txt[id].sd[0] < birth[0]) {
          // the RGA's seed predates this rebirth — void it; the assignment
          // wins even over higher-lamport deltas (they drop on every replica)
          delete this.txt[id]
          if (payload[k] === undefined) delete node[k]
          else node[k] = clone(payload[k])
        }
        // else: the generation outranks the assignment — keep its text
        continue
      }
      const r = this.regs[`${id} ${k}`]
      if (r && regNewer(r, birth)) {
        dbg(id, `assign ${k} KEEP (reg ${JSON.stringify(r)} > birth ${JSON.stringify(birth)})`)
        continue // a newer set beats the assignment
      }
      // String(...) is NOT belt-and-braces: `k` comes from the union of the
      // local node's keys and the payload's, so `payload[k]` is undefined
      // exactly on the property-REMOVAL path two lines below — and
      // JSON.stringify(undefined) is undefined, not "undefined". dbg() builds
      // its argument eagerly, so this threw whether or not anyone was
      // debugging. Third occurrence of this one bug in this file; the other
      // two already carry the same guard.
      dbg(id, `assign ${k} := ${String(JSON.stringify(payload[k])).slice(0, 40)}`)
      if (payload[k] === undefined) delete node[k]
      else node[k] = clone(payload[k])
    }
    this.replayStash(node, id, birth)
  }

  /**
   * Park a to-be-removed node's registered property values: a register newer
   * than an eventual rebirth must win over the rebirth payload, so its value
   * has to survive the removal (replayStash decides at rebirth time).
   */
  private stashNode(node: Record<string, unknown>, id: string) {
    const pref = `${id} `
    for (const rk of Object.keys(this.regs)) {
      if (!rk.startsWith(pref)) continue
      const k = rk.slice(pref.length)
      const r = clone(this.regs[rk])
      const st = (this.stash[id] ??= {})
      // overwrite entries whose register is stale — the current register's
      // value (living on this node) is the authoritative parked value
      if (!(k in st) || cmpReg(st[k].r, r) !== 0)
        st[k] = node[k] === undefined ? { r } : { v: clone(node[k]), r }
    }
  }

  /** replay dead-window values that out-rank a resurrecting ins, then drop the stash */
  private replayStash(node: Record<string, unknown>, id: string, birth: Reg) {
    const st = this.stash[id]
    if (!st) return
    for (const [k, ent] of Object.entries(st)) {
      const r = this.regs[`${id} ${k}`]
      if (!r || !regNewer(r, birth)) continue
      // stale guard: the parked value must belong to the CURRENT register —
      // a newer set that applied elsewhere supersedes it
      if (cmpReg(ent.r, r) !== 0) continue
      // String(): a REMOVAL parks an entry with no `v`, and
      // JSON.stringify(undefined) is undefined — `.slice` on that throws, and
      // dbg's argument is built eagerly whether or not debugging is on. This is
      // the SAME defect fixed at the `set` site above, in the second place it
      // occurs: the fix went where the bug was found rather than everywhere the
      // pattern was, and the rig covered the found site only. Reached whenever a
      // property removal is stashed during a node's dead window and replayed on
      // resurrection.
      dbg(id, `stash-replay ${k} := ${String(JSON.stringify(ent.v)).slice(0, 40)}`)
      if ('v' in ent) node[k] = clone(ent.v)
      else delete node[k]
      if (k === this.S.text) delete this.txt[id]
    }
    delete this.stash[id]
  }

  private drainPending(doc: BentoDoc, id: string) {
    const ps = this.pending[id]
    if (!ps) return
    delete this.pending[id]
    const r: ApplyResult = { changed: false, structure: false }
    for (const p of ps) this.applyEffect(doc, p, r)
  }

  private applyDel(doc: BentoDoc, op: DelOp, res: ApplyResult) {
    const bump = (id: string) => {
      if (!this.tombs[id] || newer(op.l, op.a, this.tombs[id])) this.tombs[id] = [op.l, op.a]
    }
    const removeElement = (key: string) => {
      dbg(key, `removeElement (tomb ${JSON.stringify(this.tombs[key])})`)
      const lb = this.limbo[key]
      if (lb) this.stashNode(lb as unknown as Record<string, unknown>, key)
      delete this.limbo[key]
      // a tombstone kills only generations it out-ranks; an out-ranking gen
      // survives the node's death (pend-on-dead replicas rebuild it on
      // resurrection from their buffered ops — this side keeps it directly)
      const g = this.txt[key]
      if (g && cmpReg(this.tombs[key] ?? [0, ''], g.sd) > 0) delete this.txt[key]
      const s = this.findSlide(doc, keySlide(key))
      const bare = keyEl(key)
      const i = s ? C(this.S, s).findIndex((e) => e.id === bare) : -1
      if (s && i >= 0) {
        this.stashNode(C(this.S, s)[i] as unknown as Record<string, unknown>, key)
        C(this.S, s).splice(i, 1)
      }
    }
    bump(op.id)
    if (op.kind === 'slide') {
      for (const eid of op.cas ?? []) {
        bump(eid)
        // the cascaded element may have been concurrently moved elsewhere —
        // delete-wins removes it wherever it currently lives
        if (this.dead(eid)) removeElement(eid)
      }
      if (this.dead(op.id)) {
        const i = P(this.S, doc).findIndex((s) => s.id === op.id)
        if (i >= 0) {
          const [gone] = P(this.S, doc).splice(i, 1)
          this.stashNode(gone as unknown as Record<string, unknown>, op.id)
          // survivors (concurrently inserted) park in limbo under their key
          for (const el of C(this.S, gone)) {
            const k = elKey(op.id, el.id)
            if (!this.dead(k)) this.limbo[k] = el
          }
        }
      }
    } else if (this.dead(op.id)) {
      removeElement(op.id)
    }
    // a tombstone is a liveness record: buffered ops resolve against it
    this.drainPending(doc, op.id)
    for (const eid of op.cas ?? []) this.drainPending(doc, eid)
    res.changed = true
    res.structure = true
  }

  private applyOrd(doc: BentoDoc, op: OrdOp, res: ApplyResult) {
    const cur = this.pos[op.id]
    if (cur && !newer(op.l, op.a, cur.r)) return
    const p = op.kind === 'slide' ? DOC_NODE : (op.sl ?? cur?.p)
    if (!p) {
      ;(this.pending[op.id] ??= []).push(op)
      return
    }
    this.pos[op.id] = { p, o: op.ord, r: [op.l, op.a] }
    if (this.dead(op.id)) return // moves never resurrect — data may be gone
    if (op.kind === 'element' && !this.findEl(doc, op.id)) {
      ;(this.pending[op.id] ??= []).push(op)
      return
    }
    res.changed = true
    res.structure = true
  }

  private applyTxt(doc: BentoDoc, op: TxtOp, res: ApplyResult) {
    // Text generations: the html REGISTER holds plain-set stamps only; a
    // generation (seed) duels sets AS A UNIT. Void whenever the generation
    // predates a rebirth or a winning set-reset — even for deltas with
    // higher lamports (a delta needs its base; the base was reassigned).
    // txt ops never touch regs, so registers converge by construction.
    const birth = this.births[op.el]
    if (birth && op.sd[0] < birth[0]) {
      dbg(op.el, `txt@${op.l},${op.a} DROP birth ${JSON.stringify(birth)} > sd ${op.sd[0]}`)
      return
    }
    const rr = this.regs[`${op.el} ${this.S.text}`]
    if (rr && cmpReg(op.sd, rr) < 0) {
      dbg(op.el, `txt@${op.l},${op.a} DROP reg ${JSON.stringify(rr)}`)
      return
    }
    if (this.dead(op.el)) {
      // dead is a TRANSIENT local view (a resurrect may be in flight) — pend
      // rather than drop, so survival depends only on converged state
      dbg(op.el, `txt@${op.l},${op.a} PEND dead`)
      ;(this.pending[op.el] ??= []).push(op)
      return
    }
    let st = this.txt[op.el]
    dbg(op.el, `txt@${op.l},${op.a} apply st=${st ? JSON.stringify(st.sd) : 'none'} base=${op.base !== undefined}`)
    const c = st ? cmpReg(op.sd, st.sd) : 1
    if (c > 0) {
      if (op.base === undefined) {
        // seeds are deterministic (lamport + content hash): if our current
        // html IS the seed's base we can rebuild it without the base op
        const node = this.findNode(doc, op.el)
        const html = node && this.S.text in node ? ((node as unknown as Record<string, string>)[this.S.text] as string) : undefined
        if (html !== undefined && contentHash(html) === op.sd[1]) {
          dbg(op.el, `txt@${op.l},${op.a} RECONSTRUCT from html`)
          st = this.txt[op.el] = { sd: clone(op.sd), toks: seedTokens(op.sd, html) }
        } else {
          dbg(op.el, `txt@${op.l},${op.a} PEND`)
          ;(this.pending[op.el] ??= []).push(op) // seed def hasn't arrived
          return
        }
      } else {
        dbg(op.el, `txt@${op.l},${op.a} REBUILD from base`)
        st = this.txt[op.el] = { sd: clone(op.sd), toks: seedTokens(op.sd, op.base) }
      }
      this.drainPending(doc, op.el) // ops that pended awaiting this seed
    } else if (c < 0) {
      return // op against a superseded seed — dropped everywhere
    }
    // same-seed unknown anchor = the anchor's insert is still in flight
    // (cross-actor delivery race) — pend until it lands
    if (op.ins && op.ins.some((g) => g.at !== '^' && !st!.toks.some((t) => t.id === g.at))) {
      dbg(op.el, `txt@${op.l},${op.a} PEND anchor`)
      ;(this.pending[op.el] ??= []).push(op)
      return
    }
    const advanced = applyTxtToState(st!, op)
    const el = this.findNode(doc, op.el)
    if (el && this.S.text in el) {
      ;(el as unknown as Record<string, string>)[this.S.text] = materialize(st!)
      res.changed = true
    } else if (!el) {
      ;(this.pending[op.el] ??= []).push(op)
    }
    // this op's tokens may be the anchor a pended op was waiting for —
    // drain only on real progress (a replayed no-op must not re-drain)
    if (advanced) this.drainPending(doc, op.el)
  }

  /** rebuild array orders (and limbo restores) from pos registers */
  private rematerialize(doc: BentoDoc) {
    const ord = (id: string) => (this.pos[id] ? this.pos[id].o : '')
    const cmp = (x: string, y: string) => {
      const a = ord(x)
      const b = ord(y)
      if (a !== b) return a < b ? -1 : 1
      return x < y ? -1 : 1
    }
    P(this.S, doc).sort((s1, s2) => cmp(s1.id, s2.id))
    const slideById = new Map(P(this.S, doc).map((s) => [s.id, s]))
    for (const [key, el] of Object.entries(this.limbo)) {
      const p = this.pos[key]?.p
      if (p && slideById.has(p) && !this.dead(p) && !this.dead(key)) {
        const dest = slideById.get(p)!
        if (!C(this.S, dest).some((e) => e.id === el.id)) C(this.S, dest).push(el)
        else dbg(key, `limbo-restore DROP dup x=${(el as any).x}`)
        delete this.limbo[key]
        this.drainPending(doc, key)
      }
    }
    // elements never relocate across slides (the composite key pins them to
    // one slide for life) — only sort by pos key and dedupe within the slide
    // (a node whose data travelled two routes can transiently duplicate)
    for (const sl of P(this.S, doc)) {
      C(this.S, sl).sort((e1, e2) => cmp(elKey(sl.id, e1.id), elKey(sl.id, e2.id)))
      setC(this.S, sl, C(this.S, sl).filter((e, i) => {
        const dup = i > 0 && e.id === C(this.S, sl)[i - 1].id
        if (dup) dbg(elKey(sl.id, e.id), `remat dedupe DROP x=${(e as any).x}`)
        return !dup
      }))
    }
  }

  // --- state-based merge (snapshots, file forks, catch-up beyond the log) --

  /**
   * Merge a remote (doc, state) snapshot into ours. Register-wise LWW with
   * value adoption from the winning side; liveness max; RGA token union.
   * merge(A←B) then merge(B←A) leaves both sides identical.
   */
  mergeSnapshot(doc: BentoDoc, rdoc: BentoDoc, rstate: SyncStateJSON): ApplyResult {
    const res: ApplyResult = { changed: false, structure: false }
    if (rstate.v !== SYNC_V) return res // pre-v2 snapshot: bare-id keys, unusable
    this.lamport = Math.max(this.lamport, rstate.lamport)
    for (const [a, s] of Object.entries(rstate.vv ?? {})) {
      if ((this.vv[a] ?? 0) < s) {
        this.vv[a] = s
        if (a === this.actor) this.seq = s
        this.gap[a] = (this.gap[a] ?? []).filter((o) => o.s > s)
        res.changed = true
      }
    }
    // liveness records (order matters: births before tombs use of dead())
    const rebirths: string[] = []
    for (const [id, r] of Object.entries(rstate.births ?? {})) {
      if (!this.births[id] || regNewer(r, this.births[id])) {
        this.births[id] = clone(r)
        rebirths.push(id) // remote saw a newer whole-node assignment
      }
    }
    for (const [id, r] of Object.entries(rstate.tombs ?? {})) {
      if (!this.tombs[id] || regNewer(r, this.tombs[id])) {
        this.tombs[id] = clone(r)
        if (this.dead(id)) {
          const g = this.txt[id]
          if (g && cmpReg(r, g.sd) > 0) delete this.txt[id]
          const lb = this.limbo[id]
          if (lb) this.stashNode(lb as unknown as Record<string, unknown>, id)
          delete this.limbo[id]
        }
        res.changed = true
      }
    }
    // pos registers
    for (const [id, rp] of Object.entries(rstate.pos ?? {})) {
      const cur = this.pos[id]
      if (!cur || regNewer(rp.r, cur.r)) {
        this.pos[id] = clone(rp)
        res.changed = true
        res.structure = true
      }
    }
    // drop nodes that are dead under merged liveness
    for (let i = P(this.S, doc).length - 1; i >= 0; i--) {
      const sl = P(this.S, doc)[i]
      if (this.dead(sl.id)) {
        P(this.S, doc).splice(i, 1)
        this.stashNode(sl as unknown as Record<string, unknown>, sl.id)
        for (const el of C(this.S, sl)) {
          const k = elKey(sl.id, el.id)
          if (!this.dead(k)) this.limbo[k] = el
          else this.stashNode(el as unknown as Record<string, unknown>, k)
        }
        res.structure = true
        res.changed = true
      } else {
        for (let j = C(this.S, sl).length - 1; j >= 0; j--) {
          const k = elKey(sl.id, C(this.S, sl)[j].id)
          if (this.dead(k)) {
            this.stashNode(C(this.S, sl)[j] as unknown as Record<string, unknown>, k)
            C(this.S, sl).splice(j, 1)
            res.structure = true
            res.changed = true
          }
        }
      }
    }
    for (const id of Object.keys(this.limbo)) {
      if (this.dead(id)) {
        this.stashNode(this.limbo[id] as unknown as Record<string, unknown>, id)
        delete this.limbo[id]
      }
    }
    // adopt remote nodes we don't have (slides first, then elements, both
    // keyed composite; remote limbo nodes count — they're invisible but
    // their data is real)
    const rEls = new Map<string, SlideElement>()
    P(this.S, rdoc).forEach((s) => C(this.S, s).forEach((e) => rEls.set(elKey(s.id, e.id), e)))
    for (const [key, el] of Object.entries(rstate.limbo ?? {})) if (!rEls.has(key)) rEls.set(key, el)
    for (const sl of P(this.S, rdoc)) {
      if (this.dead(sl.id) || this.findSlide(doc, sl.id)) continue
      const copy = clone(sl)
      setC(this.S, copy, C(this.S, copy)
        .filter((e) => !this.dead(elKey(sl.id, e.id)))
        .map((e) => {
          const lb = this.limbo[elKey(sl.id, e.id)]
          if (lb) {
            delete this.limbo[elKey(sl.id, e.id)]
            return lb
          }
          return e
        }))
      P(this.S, doc).push(copy)
      res.changed = true
      res.structure = true
    }
    for (const [key, el] of rEls) {
      if (this.dead(key) || this.findEl(doc, key)) continue
      const p = this.pos[key]?.p
      const host = p ? this.findSlide(doc, p) : undefined
      if (host && !this.dead(host.id)) C(this.S, host).push(clone(el))
      else this.limbo[key] = clone(el)
      res.changed = true
      res.structure = true
    }
    // property registers: the winning side's value lives in its doc
    const rSlides = new Map(P(this.S, rdoc).map((s) => [s.id, s]))
    const rNode = (id: string): Record<string, unknown> | undefined =>
      id === DOC_NODE
        ? (rdoc as unknown as Record<string, unknown>)
        : ((rSlides.get(id) ?? rEls.get(id)) as unknown as Record<string, unknown> | undefined)
    const lNode = (id: string): Record<string, unknown> | undefined =>
      id === DOC_NODE
        ? (doc as unknown as Record<string, unknown>)
        : ((this.findSlide(doc, id) ?? this.findEl(doc, id)) as unknown as
            | Record<string, unknown>
            | undefined)
    // whole-node assignments the remote saw and we didn't: their node value
    // supersedes our properties whose registers are older than the birth
    for (const id of rebirths) {
      if (this.dead(id)) continue
      const src = rNode(id)
      const dst = lNode(id)
      if (!src || !dst) continue
      const isSlide = rSlides.has(id) || !!this.findSlide(doc, id)
      this.assignNode(dst, src, id, this.births[id], isSlide ? this.S.children === null ? ['id'] : ['id', this.S.children] : ['id'])
      res.changed = true
      if (isSlide) res.structure = true
    }
    for (const [rk, rr] of Object.entries(rstate.regs ?? {})) {
      const sp = rk.indexOf(' ')
      const nodeId = rk.slice(0, sp)
      const key = rk.slice(sp + 1)
      if (!regNewer(rr, this.regs[rk])) continue
      this.regs[rk] = clone(rr) // registers advance even for dead nodes
      if (nodeId !== DOC_NODE) {
        const b = this.births[nodeId]
        if (b && !regNewer(rr, b)) continue // superseded by a whole-node assignment
      }
      if (nodeId !== DOC_NODE && this.dead(nodeId)) {
        // park the winning value for a potential resurrection
        const src = rNode(nodeId)
        const rstash = rstate.stash?.[nodeId]?.[key]
        if (src && src[key] !== undefined)
          (this.stash[nodeId] ??= {})[key] = { v: clone(src[key]), r: clone(rr) }
        else if (rstash) (this.stash[nodeId] ??= {})[key] = clone(rstash)
        continue
      }
      const src = rNode(nodeId)
      const dst = lNode(nodeId)
      if (!src || !dst) continue
      if (key === this.S.text) {
        const gen = this.txt[nodeId]
        if (gen && cmpReg(rr, gen.sd) < 0) continue // generation outranks the set
        if (gen) delete this.txt[nodeId]
      }
      const mk = nodeId === DOC_NODE ? this.mapKey(key) : undefined
      if (mk) {
        const [field, ak] = mk
        const rm = ((rdoc as unknown as Record<string, Record<string, unknown>>)[field] ?? {})
        const lm = ((doc as unknown as Record<string, Record<string, unknown>>)[field] ??= {})
        if (rm[ak] === undefined) delete lm[ak]
        else lm[ak] = clone(rm[ak])
      } else if (src[key] === undefined) delete dst[key]
      else dst[key] = clone(src[key])
      res.changed = true
      if (nodeId === DOC_NODE || rSlides.has(nodeId)) res.structure = true
    }
    // text RGA union (generations void when out-ranked by births or sets)
    for (const el of Object.keys(this.txt)) {
      const b = this.births[el]
      const rr = this.regs[`${el} ${this.S.text}`]
      if ((b && this.txt[el].sd[0] < b[0]) || (rr && cmpReg(this.txt[el].sd, rr) < 0))
        delete this.txt[el]
    }
    for (const [el, rt] of Object.entries(rstate.txt ?? {})) {
      if (this.dead(el)) continue
      const b = this.births[el]
      if (b && rt.sd[0] < b[0]) continue
      const rr = this.regs[`${el} ${this.S.text}`]
      if (rr && cmpReg(rt.sd, rr) < 0) continue
      const lt = this.txt[el]
      const c = lt ? cmpReg(rt.sd, lt.sd) : 1
      if (c > 0) this.txt[el] = clone(rt)
      else if (c === 0) mergeToks(lt!, rt)
      else continue
      const node = this.findNode(doc, el)
      if (node && this.S.text in node) (node as unknown as Record<string, string>)[this.S.text] = materialize(this.txt[el])
      res.changed = true
    }
    if (res.structure) this.rematerialize(doc)
    return res
  }

  /** ops from our log that this version vector is missing (peer catch-up) */
  missingFor(log: Op[], vv: Record<string, number>): Op[] {
    return log.filter((o) => o.s > (vv[o.a] ?? 0))
  }
}

const cmpReg = (x: Reg, y: Reg): number => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0)

/** FNV-1a — deterministic content hash for RGA seed identity */
export function contentHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 'h' + (h >>> 0).toString(36)
}

// ---------------------------------------------------------------------------
// text RGA internals
// ---------------------------------------------------------------------------

/** html → tokens: tags and entities are atomic, everything else per-char */
export function tokenize(html: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < html.length) {
    const c = html[i]
    if (c === '<') {
      const j = html.indexOf('>', i)
      if (j >= 0) {
        out.push(html.slice(i, j + 1))
        i = j + 1
        continue
      }
    }
    if (c === '&') {
      const j = html.indexOf(';', i)
      if (j >= 0 && j - i <= 10) {
        out.push(html.slice(i, j + 1))
        i = j + 1
        continue
      }
    }
    out.push(c)
    i++
  }
  return out
}

function seedTokens(sd: Reg, html: string): TxtTok[] {
  return tokenize(html).map((t, i) => ({ id: `s${sd[0]}.${sd[1]}.${i}`, t }))
}

export function materialize(st: TxtState): string {
  let out = ''
  for (const t of st.toks) if (!t.d) out += t.t
  return out
}

/** (lamport, actor, i) comparison for token ids `<l>.<a>.<i>` / `s<l>.<a>.<i>` */
function tokCmp(x: string, y: string): number {
  const px = x.split('.')
  const py = y.split('.')
  const lx = parseInt(px[0].replace(/^s/, ''), 10)
  const ly = parseInt(py[0].replace(/^s/, ''), 10)
  if (lx !== ly) return lx - ly
  if (px[1] !== py[1]) return px[1] < py[1] ? -1 : 1
  return parseInt(px[2], 10) - parseInt(py[2], 10)
}

function applyTxtToState(st: TxtState, op: TxtOp): boolean {
  let changed = false
  if (op.del) {
    const dead = new Set(op.del)
    for (const t of st.toks)
      if (dead.has(t.id)) {
        if (!t.d) changed = true
        t.d = 1
        dead.delete(t.id)
      }
    // deletes can overtake their token's insert (cross-actor) — park them
    if (dead.size) {
      const before = (st.pd ?? []).length
      st.pd = [...new Set([...(st.pd ?? []), ...dead])].sort()
      if (st.pd.length !== before) changed = true
    }
  }
  for (const grp of op.ins ?? []) {
    let idx = 0
    if (grp.at !== '^') {
      idx = st.toks.findIndex((t) => t.id === grp.at) + 1
      if (idx === 0) continue // anchor unknown (older-seed remnant) — drop
    }
    if (st.toks.some((t) => t.id === `${op.l}.${op.a}.0`)) continue // replayed
    changed = true
    const newId = `${op.l}.${op.a}.0`
    // RGA skip rule: pass over tokens with a greater id (concurrent inserts
    // at one anchor order newest-first; causality guarantees descendants
    // carry higher lamports than their anchors)
    while (idx < st.toks.length && tokCmp(st.toks[idx].id, newId) > 0) idx++
    const toks: TxtTok[] = grp.toks.map((t, i) => ({ id: `${op.l}.${op.a}.${i}`, t }))
    // NOT splice(idx, 0, ...toks): tokenize is per-character, so a large text
    // element is hundreds of thousands of tokens, and spreading them as call
    // ARGUMENTS overflows the stack (~200KB of text was enough). That threw
    // inside diff(), so session.flush() failed and NOTHING synced for the rest
    // of the session — not just the oversized element. Splice in place without
    // a spread instead; cost is one array copy.
    st.toks = idx === st.toks.length
      ? st.toks.concat(toks)
      : st.toks.slice(0, idx).concat(toks, st.toks.slice(idx))
    if (st.pd?.length) {
      const pend = new Set(st.pd)
      for (const t of toks)
        if (pend.has(t.id)) {
          t.d = 1
          pend.delete(t.id)
        }
      if (pend.size) st.pd = [...pend].sort()
      else delete st.pd
    }
  }
  return changed
}

/** same-seed token union for snapshot merges */
function mergeToks(dst: TxtState, src: TxtState) {
  const have = new Map(dst.toks.map((t, i) => [t.id, i]))
  for (let i = 0; i < src.toks.length; i++) {
    const t = src.toks[i]
    const at = have.get(t.id)
    if (at !== undefined) {
      if (t.d) dst.toks[at].d = 1
      continue
    }
    // insert after the nearest preceding src token we do have (RGA order)
    let anchorIdx = -1
    for (let k = i - 1; k >= 0; k--) {
      const a = have.get(src.toks[k].id)
      if (a !== undefined) {
        anchorIdx = a
        break
      }
    }
    let idx = anchorIdx + 1
    while (idx < dst.toks.length && tokCmp(dst.toks[idx].id, t.id) > 0) idx++
    dst.toks.splice(idx, 0, { ...t })
    have.clear()
    dst.toks.forEach((x, j) => have.set(x.id, j))
  }
  // union pending deletes, resolving any that now have their token
  const pend = new Set([...(dst.pd ?? []), ...(src.pd ?? [])])
  if (pend.size) {
    for (const t of dst.toks)
      if (pend.has(t.id)) {
        t.d = 1
        pend.delete(t.id)
      }
  }
  if (pend.size) dst.pd = [...pend].sort()
  else delete dst.pd
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** indices of a longest strictly-increasing subsequence */
function longestIncreasing(keys: string[]): number[] {
  const tails: number[] = []
  const prev = new Array<number>(keys.length).fill(-1)
  for (let i = 0; i < keys.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (keys[tails[mid]] < keys[i]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    tails[lo] = i
  }
  const out: number[] = []
  let k = tails.length ? tails[tails.length - 1] : -1
  while (k >= 0) {
    out.push(k)
    k = prev[k]
  }
  return out.reverse()
}
