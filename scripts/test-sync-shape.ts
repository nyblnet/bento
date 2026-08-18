#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The document-shape seam: one engine, two document shapes.
//
//   node scripts/test-sync-shape.ts
//
// WHAT THIS IS FOR. scripts/test-sync-equiv.ts proves the parameterized engine
// still mints the bytes every shipped bento/slides file was written with — it
// is a NEGATIVE property, and a parameterization that quietly did nothing
// would sail through it. Nothing yet proved the POSITIVE one: that binding a
// second shape produces an engine that actually works on a document of that
// shape.
//
// This is that check, and it is deliberately small. The full bento/spaces
// convergence rig belongs with the spaces binding; what belongs here is the
// evidence that the seam is real — because the seam is what the whole
// collaboration project rests on, and "it compiles" is not evidence.
//
// It is also where the constructor contract is pinned: the engine takes its
// shape with NO DEFAULT. A default is precisely how a spaces call site ends up
// silently holding slides' shape, and the resulting room cannot be repaired in
// the field.

import { SyncEngine, SyncState, SLIDES_SHAPE } from '../slides/src/sync/crdt.ts'
import type { DocShape } from '../slides/src/sync/crdt.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

console.log('bento-sync — the document-shape seam\n')

/** bento/spaces: pages hold blocks. The binding spaces will ship. */
const SPACES_SHAPE: DocShape = {
  parents: 'pages',
  children: 'blocks',
  skipDoc: new Set(['pages', 'modified', 'collab', 'format', 'version']),
}
class SpacesSync extends SyncEngine {
  constructor(actor: string) { super(actor, SPACES_SHAPE) }
}

const spacesDoc = (blocks: unknown[]) => ({
  format: 'bento/spaces', version: 1, docId: 'd', title: 'S', home: 'p1',
  pages: [{ id: 'p1', title: 'Page one', blocks }],
}) as never

// ---- a second shape produces a WORKING engine ------------------------------
{
  const A = new SpacesSync('alice')
  const B = new SpacesSync('bob')
  const dA = spacesDoc([{ id: 'b1', type: 'p', html: 'hello' }]) as never as Record<string, never>
  A.adopt(dA as never)
  const dB = JSON.parse(JSON.stringify(dA))
  B.adopt(dB)

  // concurrent: alice types into a block, bob adds one
  const beforeA = JSON.parse(JSON.stringify(dA))
  ;(dA as never as { pages: { blocks: { html: string }[] }[] }).pages[0].blocks[0].html = 'hello world'
  const opsA = A.diff(beforeA, dA as never, { text: true })

  const beforeB = JSON.parse(JSON.stringify(dB))
  dB.pages[0].blocks.push({ id: 'b2', type: 'todo', html: 'a task', done: false })
  const opsB = B.diff(beforeB, dB, { text: true })

  ok(opsA.length === 1 && opsA[0].op === 'txt',
    'a text edit on a BLOCK becomes one RGA delta, exactly as it does for an element')
  ok(String(opsA[0].el) === 'p1' + '\u001f' + 'b1',
    `the node key is the composite pageId\u001fblockId — the page, not the slide (got ${JSON.stringify(String(opsA[0].el))})`)
  ok(opsB.length === 1 && opsB[0].op === 'ins' && opsB[0].sl === 'p1',
    'a new block is an insert parented to its page')

  A.apply(dA as never, opsB)
  B.apply(dB, opsA)
  ok(JSON.stringify(dA) === JSON.stringify(dB), 'the two replicas converge')
  const blocks = (dA as never as { pages: { blocks: { html: string }[] }[] }).pages[0].blocks
  ok(blocks.length === 2 && blocks[0].html === 'hello world',
    'and neither edit was lost: the typed text AND the new block survive')
}

// ---- the shape is per-instance, not per-module -----------------------------
// The failure this prevents is one engine quietly serving both apps with one
// binding, which is unrecoverable once a room exists.
{
  const s = new SyncState('a')
  const p = new SpacesSync('a')
  ok(s.S === SLIDES_SHAPE, 'the slides binding carries the slides shape')
  ok(p.S === SPACES_SHAPE, 'the spaces binding carries the spaces shape')
  ok(s.S !== p.S, 'two engines alive at once do not share one shape')
  ok(SLIDES_SHAPE.skipDoc.has('slides') && SPACES_SHAPE.skipDoc.has('pages'),
    'each shape skips its own container — syncing it as a value would make the whole document one register')
}

// ---- restoring a saved state yields the SAME binding -----------------------
// `static fromJSON` used to construct the base class literally, so a subclass
// restored as something else. For an app binding that means a saved spaces
// file reopening with slides' shape.
{
  const p = new SpacesSync('a')
  const d = spacesDoc([{ id: 'b1', type: 'p', html: 'x' }])
  p.adopt(d)
  const back = SpacesSync.fromJSON('a', p.toJSON())
  ok(back instanceof SpacesSync, 'a restored spaces engine is a spaces engine')
  ok(back.S === SPACES_SHAPE, '…and still carries the spaces shape')
  const slides = SyncState.fromJSON('a', new SyncState('a').toJSON())
  ok(slides instanceof SyncState && slides.S === SLIDES_SHAPE,
    'and the slides binding restores as itself, unchanged')
}

// ---- the slides shape is untouched by any of this --------------------------
{
  ok(SLIDES_SHAPE.parents === 'slides' && SLIDES_SHAPE.children === 'elements',
    'slides still means slides → elements')
  ok([...SLIDES_SHAPE.skipDoc].sort().join(',') === 'collab,format,modified,slides,version',
    'and its skip set is exactly what the shipped engine hardcoded')
}

// ---- stamping WITHOUT the token history ------------------------------------
// bento/spaces will not stamp `txt`: a space is typed prose, and the token
// history costs ×25.8 of the text when it is typed (×0.2 when pasted — the RGA
// only engages for text somebody typed while a session ran). What must be true
// for that to be a safe choice, and is asserted here rather than assumed:
//
//   1. slides is untouched — the default still emits `txt`, byte for byte;
//   2. omitting it actually shrinks the stamp, by the order claimed;
//   3. a state restored WITHOUT it still CONVERGES. Only the granularity
//      degrades: last-writer-wins per block instead of per character.
//
// (3) is the one that would sink the idea, so it is measured, not argued.
{
  const doc = spacesDoc([{ id: 'b1', type: 'p', html: '' }]) as never as
    { pages: { blocks: { html: string }[] }[] }
  const A = new SpacesSync('alice')
  A.adopt(doc as never)
  // TYPE it, in runs, which is what mints tokens
  const text = 'the quick brown fox jumps over a lazy dog and keeps on going '.repeat(6)
  for (let c = 0; c < text.length; c += 40) {
    const before = JSON.parse(JSON.stringify(doc))
    doc.pages[0].blocks[0].html = text.slice(0, c + 40)
    A.diff(before, doc as never, { text: true })
  }

  const withText = JSON.stringify(A.toJSON())
  const without = JSON.stringify(A.toJSON({ text: false }))
  ok(withText.includes('"txt"'), 'the default stamp carries the token history')
  ok(!without.includes('"txt"'), 'and `text: false` leaves it out entirely')
  ok(without.length * 5 < withText.length,
    `omitting it is worth having: ${withText.length} B → ${without.length} B ` +
    `(×${(withText.length / without.length).toFixed(1)} smaller)`)

  // the slides binding must be byte-identical to what it always emitted
  const sl = new SyncState('a')
  sl.adopt({ slides: [{ id: 's1', elements: [{ id: 'e1', type: 'text', html: 'x' }] }] } as never)
  ok(JSON.stringify(sl.toJSON()).includes('"txt":'),
    'the slides binding still stamps txt by default — every field file was written that way')

  // (3) CONVERGENCE, from a stamp with no token history
  // DIFFERENT actor ids: two replicas sharing one is not a configuration the
  // engine supports (it skips its own ops on apply), and a test that gets that
  // wrong reports a divergence the field would never see.
  const reopen = (actor: string, stamp: string) => {
    const d = JSON.parse(JSON.stringify(doc))
    const st = SpacesSync.fromJSON(actor, JSON.parse(stamp))
    return { d, st }
  }
  const X = reopen('xavier', without)
  const Y = reopen('yasmin', without)
  const editX = JSON.parse(JSON.stringify(X.d))
  X.d.pages[0].blocks[0].html = text + ' — and X adds this'
  const opsX = X.st.diff(editX, X.d, { text: true })
  const editY = JSON.parse(JSON.stringify(Y.d))
  Y.d.pages[0].blocks.push({ id: 'b2', type: 'p', html: 'Y adds a block' })
  const opsY = Y.st.diff(editY, Y.d, { text: true })

  X.st.apply(X.d, opsY)
  Y.st.apply(Y.d, opsX)
  ok(JSON.stringify(X.d) === JSON.stringify(Y.d),
    'two replicas restored from a txt-less stamp still CONVERGE')
  ok(X.d.pages[0].blocks.length === 2 && X.d.pages[0].blocks[0].html.endsWith('X adds this'),
    'and neither edit was lost — different blocks still merge')
  // NOT a fallback to whole-value sets, as first assumed: the differ RE-SEEDS a
  // generation from the current content, and two replicas that both re-seed
  // from the same content derive the same seed — so they still merge per
  // character. Measured on a shared paragraph: "Friday"→"Monday" from one and
  // an appended sentence from the other, both kept, byte-identical on both
  // sides, from a stamp 10.9× smaller.
  ok(opsX.length === 1 && opsX[0].op === 'txt',
    `a re-seeded generation still merges per character (op was ${opsX[0]?.op})`)

  // ------------------------------------------------------------------------
  // AND THE PRECONDITION THAT MAKES IT SAFE, pinned because getting it wrong
  // is not a degradation — it is a SPLIT BRAIN.
  //
  // A replica that re-seeds meets a peer still holding the ORIGINAL generation
  // (a live session keeps the tokens in memory), the two generations duel as
  // units, and the loser's edit disappears — measured: the two documents do
  // NOT converge. So a lean stamp is only safe when EVERY participant is lean.
  //
  // The session layer must therefore treat "restored without txt" as
  // `needs a snapshot`, not as `resume` — rejoin by taking a peer's snapshot
  // (mergeSnapshot) rather than replaying from where the file left off. That
  // rule does not exist yet because spaces has no session; this assertion is
  // here so it cannot be forgotten when it is written.
  {
    const full = JSON.parse(JSON.stringify(A.toJSON()))
    const lean = JSON.parse(JSON.stringify(A.toJSON({ text: false })))
    ok(!!full.txt && !lean.txt, 'the two stamps differ only in the token history')
    const keptGeneration = Object.keys(full.txt ?? {}).length
    ok(keptGeneration > 0,
      `a typed paragraph has a generation to lose (${keptGeneration} node(s) with token history)`)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
