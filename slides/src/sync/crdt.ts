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

import type { BentoDoc, Slide, SlideElement } from '../model'

export const DOC_NODE = '@doc'

/**
 * Sync format version — stamped into SyncStateJSON (`v`) and every wire
 * frame (`pv`). v1 keyed elements by bare id, which collapsed the same id
 * appearing on multiple slides (the morph idiom); v2 state/ops are keyed
 * by composite element keys and are NOT interoperable, so v1 saved state
 * and v1 frames are discarded on sight.
 */
export const SYNC_V = 2

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
  /** composite element key */
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
  txt: Record<string, TxtState>
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

export class SyncState {
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

  constructor(actor: string) {
    this.actor = actor
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

  toJSON(): SyncStateJSON {
    return {
      v: SYNC_V,
      lamport: this.lamport,
      vv: this.vv,
      regs: this.regs,
      pos: this.pos,
      births: this.births,
      tombs: this.tombs,
      txt: this.txt,
      stash: this.stash,
      limbo: this.limbo,
    }
  }

  static fromJSON(actor: string, j: SyncStateJSON): SyncState {
    const s = new SyncState(actor)
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
    const ns = doc.slides.length
    doc.slides.forEach((sl, i) => {
      if (!this.pos[sl.id]) this.pos[sl.id] = { p: DOC_NODE, o: spreadKey(i, ns), r: [0, ''] }
      const ne = sl.elements.length
      sl.elements.forEach((el, j) => {
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
    const SKIP_DOC = new Set(['slides', 'modified', 'collab', 'format', 'version'])
    const b = before as unknown as Record<string, unknown>
    const a = after as unknown as Record<string, unknown>
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (SKIP_DOC.has(k)) continue
      if (k === 'assets') {
        const ba = (b.assets ?? {}) as Record<string, unknown>
        const aa = (a.assets ?? {}) as Record<string, unknown>
        for (const ak of new Set([...Object.keys(ba), ...Object.keys(aa)])) {
          if (JSON.stringify(ba[ak]) === JSON.stringify(aa[ak])) continue
          const o = push<SetOp>({ ...this.stamp(), op: 'set', k: `assets.${ak}`, v: clone(aa[ak]) })
          this.regs[`${DOC_NODE} assets.${ak}`] = [o.l, o.a]
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
    const bSlides = new Map(before.slides.map((s) => [s.id, s]))
    const aSlides = new Map(after.slides.map((s) => [s.id, s]))
    const bEls = new Map<string, { sl: string; el: SlideElement }>()
    const aEls = new Map<string, { sl: string; el: SlideElement }>()
    before.slides.forEach((s) => s.elements.forEach((el) => bEls.set(elKey(s.id, el.id), { sl: s.id, el })))
    after.slides.forEach((s) => s.elements.forEach((el) => aEls.set(elKey(s.id, el.id), { sl: s.id, el })))

    // deleted slides (cascade the elements the deleter saw, minus survivors)
    for (const [id, sl] of bSlides) {
      if (aSlides.has(id)) continue
      const cas = sl.elements.map((e) => elKey(id, e.id)).filter((k) => !aEls.has(k))
      const o = push<DelOp>({ ...this.stamp(), op: 'del', kind: 'slide', id, cas })
      this.tombs[id] = [o.l, o.a]
      this.stashNode(sl as unknown as Record<string, unknown>, id)
      cas.forEach((ek) => {
        this.tombs[ek] = [o.l, o.a]
        const node = sl.elements.find((e) => elKey(id, e.id) === ek)
        if (node) this.stashNode(node as unknown as Record<string, unknown>, ek)
        delete this.limbo[ek]
        delete this.txt[ek] // local tomb is the freshest stamp — always out-ranks
      })
    }
    // inserted (or resurrected) slides
    const afterIds = after.slides.map((s) => s.id)
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
      const ne = sl.elements.length
      sl.elements.forEach((el, j) => {
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
        if (k === 'elements' || k === 'id') continue
        if (JSON.stringify(bp[k]) === JSON.stringify(ap[k])) continue
        const o = push<SetOp>({ ...this.stamp(), op: 'set', sl: id, k, v: clone(ap[k]) })
        this.regs[`${id} ${k}`] = [o.l, o.a]
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
        const sib = aSlides.get(sl)!.elements.map((e) => elKey(sl, e.id))
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
          if (k === 'html' && opts.text && typeof bp.html === 'string' && typeof ap.html === 'string') {
            const t = this.diffText(id, bp.html as string, ap.html as string)
            if (t) {
              push(t)
              continue
            }
          }
          const o = push<SetOp>({ ...this.stamp(), op: 'set', sl, el: id, k, v: clone(ap[k]) })
          this.regs[`${id} ${k}`] = [o.l, o.a]
          if (k === 'html') delete this.txt[id] // LWW reset wins over RGA state
        }
      }
      // no cross-slide move branch: the composite key IS (slide, id), so a
      // moved element always lands in the delete/insert passes above
    }
    // element order within each surviving slide (all ids — see slide pass)
    for (const [id, sl] of aSlides) {
      if (!bSlides.has(id)) continue
      this.diffOrder(sl.elements.map((e) => elKey(id, e.id)), id, 'element', push)
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
        Math.max(this.regs[`${el} html`]?.[0] ?? 0, this.births[el]?.[0] ?? 0),
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
    return doc.slides.find((s) => s.id === id)
  }
  /** composite-key lookup: an element node only ever lives on its key's
   * slide (or in limbo) — the same bare id on other slides is other nodes */
  private findEl(doc: BentoDoc, key: string): SlideElement | undefined {
    const s = this.findSlide(doc, keySlide(key))
    const bare = keyEl(key)
    return s?.elements.find((e) => e.id === bare) ?? this.limbo[key]
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
      if (op.k.startsWith('assets.')) {
        const assets = ((doc.assets ??= {}) as Record<string, string>)
        const ak = op.k.slice(7)
        if (op.v === undefined) delete assets[ak]
        else assets[ak] = op.v as string
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
    dbg(nodeId, `set ${op.k}@${op.l},${op.a} APPLY ${JSON.stringify(op.v).slice(0, 40)}`)
    if (op.el && op.k === 'html') {
      const gen = this.txt[op.el]
      if (gen && cmpReg([op.l, op.a], gen.sd) < 0) {
        // a live text generation outranks this set — value loses, reg advances
        this.regs[rk] = [op.l, op.a]
        return
      }
      dbg(op.el, `set-html@${op.l},${op.a} RESET kills gen`)
      delete this.txt[op.el] // the set out-stamps the generation: reset
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
      const ne = src.elements.length
      src.elements.forEach((e, j) => this.insertElement(doc, elKey(op.id, e.id), op.id, spreadKey(j, ne), e, stamp, res))
      this.drainPending(doc, op.id)
      src.elements.forEach((e) => this.drainPending(doc, elKey(op.id, e.id)))
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
      this.assignNode(existing as unknown as Record<string, unknown>, src as unknown as Record<string, unknown>, id, stamp, ['id', 'elements'])
    } else {
      const sl = clone(src)
      sl.elements = [] // members materialize separately via insertElement
      doc.slides.push(sl)
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
      if (sl && !this.dead(p)) sl.elements.push(el)
      else this.limbo[id] = el
      this.replayStash(el as unknown as Record<string, unknown>, id, stamp)
      live = el
    }
    // a text generation that survived the node's death (it out-ranked the
    // tomb) is the html authority — re-materialize over the ins payload
    const g = this.txt[id]
    if (g && 'html' in live) (live as { html: string }).html = materialize(g)
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
      if (k === 'html' && this.txt[id]) {
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
      dbg(id, `assign ${k} := ${JSON.stringify(payload[k]).slice(0, 40)}`)
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
      dbg(id, `stash-replay ${k} := ${JSON.stringify(ent.v).slice(0, 40)}`)
      if ('v' in ent) node[k] = clone(ent.v)
      else delete node[k]
      if (k === 'html') delete this.txt[id]
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
      const i = s ? s.elements.findIndex((e) => e.id === bare) : -1
      if (s && i >= 0) {
        this.stashNode(s.elements[i] as unknown as Record<string, unknown>, key)
        s.elements.splice(i, 1)
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
        const i = doc.slides.findIndex((s) => s.id === op.id)
        if (i >= 0) {
          const [gone] = doc.slides.splice(i, 1)
          this.stashNode(gone as unknown as Record<string, unknown>, op.id)
          // survivors (concurrently inserted) park in limbo under their key
          for (const el of gone.elements) {
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
    const rr = this.regs[`${op.el} html`]
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
        const node = this.findEl(doc, op.el)
        const html = node && 'html' in node ? ((node as { html: string }).html as string) : undefined
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
    const el = this.findEl(doc, op.el)
    if (el && 'html' in el) {
      ;(el as { html: string }).html = materialize(st!)
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
    doc.slides.sort((s1, s2) => cmp(s1.id, s2.id))
    const slideById = new Map(doc.slides.map((s) => [s.id, s]))
    for (const [key, el] of Object.entries(this.limbo)) {
      const p = this.pos[key]?.p
      if (p && slideById.has(p) && !this.dead(p) && !this.dead(key)) {
        const dest = slideById.get(p)!
        if (!dest.elements.some((e) => e.id === el.id)) dest.elements.push(el)
        else dbg(key, `limbo-restore DROP dup x=${(el as any).x}`)
        delete this.limbo[key]
        this.drainPending(doc, key)
      }
    }
    // elements never relocate across slides (the composite key pins them to
    // one slide for life) — only sort by pos key and dedupe within the slide
    // (a node whose data travelled two routes can transiently duplicate)
    for (const sl of doc.slides) {
      sl.elements.sort((e1, e2) => cmp(elKey(sl.id, e1.id), elKey(sl.id, e2.id)))
      sl.elements = sl.elements.filter((e, i) => {
        const dup = i > 0 && e.id === sl.elements[i - 1].id
        if (dup) dbg(elKey(sl.id, e.id), `remat dedupe DROP x=${(e as any).x}`)
        return !dup
      })
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
    for (let i = doc.slides.length - 1; i >= 0; i--) {
      const sl = doc.slides[i]
      if (this.dead(sl.id)) {
        doc.slides.splice(i, 1)
        this.stashNode(sl as unknown as Record<string, unknown>, sl.id)
        for (const el of sl.elements) {
          const k = elKey(sl.id, el.id)
          if (!this.dead(k)) this.limbo[k] = el
          else this.stashNode(el as unknown as Record<string, unknown>, k)
        }
        res.structure = true
        res.changed = true
      } else {
        for (let j = sl.elements.length - 1; j >= 0; j--) {
          const k = elKey(sl.id, sl.elements[j].id)
          if (this.dead(k)) {
            this.stashNode(sl.elements[j] as unknown as Record<string, unknown>, k)
            sl.elements.splice(j, 1)
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
    rdoc.slides.forEach((s) => s.elements.forEach((e) => rEls.set(elKey(s.id, e.id), e)))
    for (const [key, el] of Object.entries(rstate.limbo ?? {})) if (!rEls.has(key)) rEls.set(key, el)
    for (const sl of rdoc.slides) {
      if (this.dead(sl.id) || this.findSlide(doc, sl.id)) continue
      const copy = clone(sl)
      copy.elements = copy.elements
        .filter((e) => !this.dead(elKey(sl.id, e.id)))
        .map((e) => {
          const lb = this.limbo[elKey(sl.id, e.id)]
          if (lb) {
            delete this.limbo[elKey(sl.id, e.id)]
            return lb
          }
          return e
        })
      doc.slides.push(copy)
      res.changed = true
      res.structure = true
    }
    for (const [key, el] of rEls) {
      if (this.dead(key) || this.findEl(doc, key)) continue
      const p = this.pos[key]?.p
      const host = p ? this.findSlide(doc, p) : undefined
      if (host && !this.dead(host.id)) host.elements.push(clone(el))
      else this.limbo[key] = clone(el)
      res.changed = true
      res.structure = true
    }
    // property registers: the winning side's value lives in its doc
    const rSlides = new Map(rdoc.slides.map((s) => [s.id, s]))
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
      this.assignNode(dst, src, id, this.births[id], isSlide ? ['id', 'elements'] : ['id'])
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
      if (key === 'html') {
        const gen = this.txt[nodeId]
        if (gen && cmpReg(rr, gen.sd) < 0) continue // generation outranks the set
        if (gen) delete this.txt[nodeId]
      }
      if (nodeId === DOC_NODE && key.startsWith('assets.')) {
        const ak = key.slice(7)
        const ra = (rdoc.assets ?? {}) as Record<string, string>
        const la = ((doc.assets ??= {}) as Record<string, string>)
        if (ra[ak] === undefined) delete la[ak]
        else la[ak] = ra[ak]
      } else if (src[key] === undefined) delete dst[key]
      else dst[key] = clone(src[key])
      res.changed = true
      if (nodeId === DOC_NODE || rSlides.has(nodeId)) res.structure = true
    }
    // text RGA union (generations void when out-ranked by births or sets)
    for (const el of Object.keys(this.txt)) {
      const b = this.births[el]
      const rr = this.regs[`${el} html`]
      if ((b && this.txt[el].sd[0] < b[0]) || (rr && cmpReg(this.txt[el].sd, rr) < 0))
        delete this.txt[el]
    }
    for (const [el, rt] of Object.entries(rstate.txt ?? {})) {
      if (this.dead(el)) continue
      const b = this.births[el]
      if (b && rt.sd[0] < b[0]) continue
      const rr = this.regs[`${el} html`]
      if (rr && cmpReg(rt.sd, rr) < 0) continue
      const lt = this.txt[el]
      const c = lt ? cmpReg(rt.sd, lt.sd) : 1
      if (c > 0) this.txt[el] = clone(rt)
      else if (c === 0) mergeToks(lt!, rt)
      else continue
      const node = this.findEl(doc, el)
      if (node && 'html' in node) (node as { html: string }).html = materialize(this.txt[el])
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
    st.toks.splice(idx, 0, ...toks)
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
