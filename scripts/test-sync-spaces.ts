#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/spaces under the shared CRDT engine — convergence, and the format's
// own invariants after convergence.
//
//   node scripts/test-sync-spaces.ts
//   SEEDS=300 STEPS=80 ACTORS=4 node scripts/test-sync-spaces.ts
//
// TWO DIFFERENT QUESTIONS, and only the first is what a CRDT rig usually asks.
//
//  1. DO REPLICAS CONVERGE? Standard, and the engine's own property.
//
//  2. IS WHAT THEY CONVERGE ON A LEGAL bento/spaces DOCUMENT? This is the one
//     that matters here, and it has no slides equivalent. `page.blocks` is
//     FLAT AND IN PRE-ORDER — the format's guarantee is "a child always
//     follows its parent, so one forward pass rebuilds the tree" — while the
//     engine stores order as fractional position keys and `parent` as an
//     ordinary last-writer-wins register. Those are two independent merge
//     domains describing one visual tree. Two perfectly legal concurrent edits
//     (you indent a block, I move one) can therefore converge on a state every
//     replica agrees about and no renderer can draw correctly.
//
//     If that is real, it is a FORMAT-LEVEL decision and it has to be made
//     before any spaces file carries collaboration state — which is why this
//     rig reports it as data rather than asserting a verdict it cannot know.
//
// The engine is the kernel's, bound to ('pages','blocks'). Nothing here is
// spaces app code: this is the shape binding and its evidence.

import { SyncEngine, shape } from '../kernel/src/sync/crdt.ts'
import { mulberry32, baseDoc, randomMutation, type Doc } from './lib/sync-fixtures-spaces.ts'
import { effectiveParents, descendantsOf } from '../spaces/src/model.ts'

export const SPACES_SHAPE = shape('pages', 'blocks')
class SpacesSync extends SyncEngine {
  constructor(actor: string) { super(actor, SPACES_SHAPE) }
}

const SEEDS = parseInt(process.env.SEEDS ?? '120', 10)
const STEPS = parseInt(process.env.STEPS ?? '60', 10)
const ACTORS = parseInt(process.env.ACTORS ?? '3', 10)

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

class Replica {
  doc: Doc
  state: SpacesSync
  shadow: string
  constructor(actor: string, doc: Doc) {
    this.doc = doc
    this.state = new SpacesSync(actor)
    this.state.adopt(this.doc as never)
    this.shadow = JSON.stringify(this.doc)
  }
  mutate(fn: (d: Doc) => void) {
    fn(this.doc)
    return this.flush()
  }
  flush() {
    const ops = this.state.diff(JSON.parse(this.shadow), this.doc as never, { text: true })
    this.shadow = JSON.stringify(this.doc)
    return ops
  }
  receive(ops: unknown[]) {
    this.state.apply(this.doc as never, ops as never)
    this.shadow = JSON.stringify(this.doc)
  }
}

// ---------------------------------------------------------------------------
// the format's invariants, checked on a MERGED document
// ---------------------------------------------------------------------------

interface Violations {
  preorderBlocks: number   // a block whose parent appears later, or not at all
  danglingBlock: number    // parent names a block not in this page
  preorderPages: number
  danglingPage: number
  pageCycle: number
  dupBlockId: number       // the same block id on two pages
}

function inspect(doc: Doc): Violations {
  const v: Violations = { preorderBlocks: 0, danglingBlock: 0, preorderPages: 0, danglingPage: 0, pageCycle: 0, dupBlockId: 0 }
  const seenBlock = new Map<string, string>()
  for (const p of doc.pages) {
    const at = new Map<string, number>()
    p.blocks.forEach((b, i) => at.set(b.id, i))
    p.blocks.forEach((b, i) => {
      if (seenBlock.has(b.id) && seenBlock.get(b.id) !== p.id) v.dupBlockId++
      seenBlock.set(b.id, p.id)
      if (b.parent === undefined) return
      const j = at.get(String(b.parent))
      if (j === undefined) v.danglingBlock++
      else if (j >= i) v.preorderBlocks++     // parent at or after the child
    })
  }
  const pageAt = new Map<string, number>()
  doc.pages.forEach((p, i) => pageAt.set(p.id, i))
  doc.pages.forEach((p, i) => {
    if (p.parent === undefined) return
    const j = pageAt.get(String(p.parent))
    if (j === undefined) v.danglingPage++
    else if (j >= i) v.preorderPages++
  })
  // page cycles: walk up from every page with a hop cap
  for (const p of doc.pages) {
    const seen = new Set<string>()
    let up: string | undefined = p.id
    while (up && !seen.has(up)) {
      seen.add(up)
      up = doc.pages.find((q) => q.id === up)?.parent as string | undefined
      if (up && seen.has(up)) { v.pageCycle++; break }
    }
  }
  return v
}

const total = (v: Violations) => Object.values(v).reduce((a, b) => a + b, 0)

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

console.log('bento/spaces under the shared CRDT engine\n')

const worst: Violations = { preorderBlocks: 0, danglingBlock: 0, preorderPages: 0, danglingPage: 0, pageCycle: 0, dupBlockId: 0 }
let seedsWithViolations = 0
let diverged = 0
let opsTotal = 0
let soloBroken = 0
let measured = 0
let ruleBroken = 0
let ruleChecked = 0

for (let seed = 1; seed <= SEEDS; seed++) {
  const rnd = mulberry32(seed * 7919)
  const base = baseDoc()
  const reps = Array.from({ length: ACTORS }, (_, i) => new Replica(`a${i}`, clone(base)))
  // a lone replica running actor 0's edits and receiving nothing
  const solo = new Replica('solo', clone(base))
  const queues = new Map<string, unknown[][]>()
  for (let f = 0; f < ACTORS; f++) for (let t = 0; t < ACTORS; t++) if (f !== t) queues.set(`${f}>${t}`, [])

  for (let s = 0; s < STEPS; s++) {
    if (rnd() < 0.6) {
      const a = Math.floor(rnd() * ACTORS)
      const mseed = (seed * 1_000_003 + s * 7919) >>> 0
      if (a === 0) solo.mutate(randomMutation(solo.doc, mulberry32(mseed)))
      const ops = reps[a].mutate(randomMutation(reps[a].doc, mulberry32(mseed)))
      opsTotal += ops.length
      if (ops.length) for (let t = 0; t < ACTORS; t++) if (t !== a) queues.get(`${a}>${t}`)!.push(ops)
    } else {
      const keys = [...queues.keys()].filter((k) => queues.get(k)!.length)
      if (!keys.length) continue
      const k = keys[Math.floor(rnd() * keys.length)]
      const to = parseInt(k.split('>')[1], 10)
      reps[to].receive(queues.get(k)!.shift()!)
    }
  }
  // drain everything
  let guard = 0
  for (;;) {
    const k = [...queues.keys()].find((x) => queues.get(x)!.length)
    if (!k || guard++ > 10000) break
    reps[parseInt(k.split('>')[1], 10)].receive(queues.get(k)!.shift()!)
  }

  const first = JSON.stringify(reps[0].doc)
  for (let i = 1; i < ACTORS; i++) {
    if (JSON.stringify(reps[i].doc) !== first) {
      diverged++
      if (diverged === 1) console.log(`  FAIL  seed ${seed}: replicas a0 and a${i} disagree`)
      break
    }
  }

  // THE CONTROL, and the rig is worthless without it. If the generator itself
  // produced illegal documents, every violation below would be its fault
  // rather than the merge's. So each replica is inspected BEFORE it receives
  // anything (soloDoc, driven by the same edits), and that must be spotless.
  // A seed whose SOLO document is already illegal proves nothing about
  // merging, so it is excluded from the statistic rather than counted. The
  // measurement is then over seeds where the generator is provably clean —
  // which is a stronger basis than "every generator bug we happened to find
  // has been fixed".
  if (total(inspect(solo.doc)) > 0) { soloBroken++; continue }
  measured++

  // THE TREE RULE, on a document the merge actually produced. The violations
  // below are real and expected; what must never happen is the RULE failing on
  // one of them — a parent that is not strictly earlier, a walk that cycles, or
  // a subtree that contains its own root (which is what makes a delete take
  // blocks nobody selected).
  for (const page of reps[0].doc.pages) {
    const at = new Map<string, number>()
    page.blocks.forEach((b, i) => at.set(b.id, i))
    const eff = effectiveParents(page as never)
    for (const b of page.blocks) {
      const par = eff.get(b.id)
      if (par !== undefined && (at.get(par) ?? 1e9) >= (at.get(b.id) ?? -1)) ruleBroken++
      if (par === b.id) ruleBroken++
      const walked = new Set<string>()
      for (let up = par; up; up = eff.get(up)) {
        if (walked.has(up)) { ruleBroken++; break }
        walked.add(up)
      }
      if (descendantsOf(page as never, b.id).has(b.id)) ruleBroken++
      ruleChecked++
    }
  }

  const v = inspect(reps[0].doc)
  if (total(v) > 0) {
    seedsWithViolations++
    for (const k of Object.keys(worst) as Array<keyof Violations>) worst[k] = Math.max(worst[k], v[k])
  }
}

ok(diverged === 0, `all replicas converge (${diverged} seed(s) diverged)`)
ok(ruleBroken === 0,
  `the effective-parent rule holds on every merged document ` +
  `(${ruleBroken} failure(s) across ${ruleChecked} blocks) — no cycle, no late parent, ` +
  'no subtree containing its own root')
// The control is REPORTED, not asserted: a seed the generator got wrong is
// excluded from the measurement, so it cannot contaminate the finding. What
// would invalidate the rig is excluding most of them, so that IS asserted.
console.log(`  ok    control: ${measured}/${SEEDS} seeds had a provably legal solo document ` +
  `(${soloBroken} excluded — the generator, not the merge)`)
ok(measured > SEEDS * 0.9,
  `the control excluded too much to measure anything (${measured}/${SEEDS} usable)`)
console.log(`  ok    convergence: ${SEEDS} seeds × ${STEPS} steps × ${ACTORS} actors, ${opsTotal} ops`)

// ---- the format report ------------------------------------------------------
console.log('')
console.log('  bento/spaces format invariants on the MERGED document:')
console.log(`    seeds producing at least one violation: ${seedsWithViolations}/${measured} ` +
  `(${(seedsWithViolations / Math.max(1, measured) * 100).toFixed(1)}%)`)
for (const [k, n] of Object.entries(worst)) {
  console.log(`      ${k.padEnd(16)} worst-case in one document: ${n}`)
}
console.log('')

// ---------------------------------------------------------------------------
// WHAT IS ASSERTED, AND WHY IT IS ONLY CONVERGENCE
//
// Convergence is the ENGINE's property, and it holds. Everything in the table
// above is a property of the FORMAT meeting the engine, and every one of them
// is an open design question this rig exists to have discovered rather than to
// have pre-judged:
//
//  · pre-order vs `parent` — two independent merge domains for one visual
//    tree. The fix is a rule (derive the tree at render time and tolerate any
//    array order, or repair after apply), and a repair that COMMITS would mint
//    ord ops and can ping-pong between replicas forever.
//  · page cycles — `Store.tree()` recurses from the root with no visited set,
//    so a cycle makes pages vanish from the sidebar AND from the markdown
//    export, while still being in the file.
//  · duplicate block ids — the engine duplicates a node on concurrent moves to
//    two different parents, BY DESIGN (docs/collab-design.md). In slides that
//    is the morph idiom and it is correct. In spaces, block ids are unique
//    document-wide (parseDoc's `seen` set spans pages and blocks),
//    `buildIndex` keys blocks by bare id, and `#p/<page>/<block>` anchors
//    assume it — so the same behaviour is a defect.
//
// Failing the build on any of those would be asserting an answer nobody has
// chosen. STRICT=1 turns them into assertions — flip it in CI the moment the
// decisions land, and this rig becomes their enforcement.
// ---------------------------------------------------------------------------
const STRICT = process.env.STRICT === '1'
if (STRICT) {
  ok(worst.dupBlockId === 0, `no merge produced the same block id on two pages (worst ${worst.dupBlockId})`)
  ok(worst.preorderBlocks === 0, `no merge broke block pre-order (worst ${worst.preorderBlocks})`)
  ok(worst.danglingBlock === 0, `no merge left a dangling block parent (worst ${worst.danglingBlock})`)
  ok(worst.preorderPages === 0, `no merge broke page pre-order (worst ${worst.preorderPages})`)
  ok(worst.danglingPage === 0, `no merge left a dangling page parent (worst ${worst.danglingPage})`)
  ok(worst.pageCycle === 0, `no merge produced a page cycle (worst ${worst.pageCycle})`)
} else if (seedsWithViolations) {
  console.log('  OPEN — merged documents violate the flat pre-order invariant, and')
  console.log('  that is the expected consequence of `parent` being an ordinary')
  console.log('  register while order is a position key. Two legal concurrent edits')
  console.log('  meet, every replica agrees, and no forward pass can rebuild the tree.')
  console.log('  These are FORMAT decisions and they must be settled before a spaces')
  console.log('  file carries collaboration state. Re-run with STRICT=1 to hold the')
  console.log('  line once they are. See docs/DECISIONS.md.')
  console.log('')
}

console.log(`${checks - failures}/${checks} assertions passed`)
if (failures) process.exit(1)
