#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The audience projection rig (live broadcast).
//
//   node scripts/test-audience-projection.ts
//   node scripts/test-audience-projection.ts --mutate   (must FAIL: the negative control)
//
// WHAT THIS PROVES. Everything a broadcast audience receives — the handout
// file, the join snapshot the relay serves, every op streamed mid-show — goes
// through slides/src/audience.ts, and that module keeps back exactly two
// things: speaker notes and review comments. Security's finding on the design
// (2026-09-12) was that no export path stripped either, so as first written
// the audience would have received the presenter's notes in the handout, in
// the snapshot, and LIVE as they were typed. This rig pins all three surfaces:
//
//   projectDoc — no notes text and no `comments` key on any slide, state or
//                layout; hidden slides KEPT (reachable by link, part of the
//                deck — the judgement is recorded, not implied); `blobs`
//                dropped and bytes inline; collab.key IS the show key and is
//                NOT the room key; the invite is the audience one; no private
//                halves; readonly/template cleared.
//   projectOp  — a slide-level `set notes` / `set comments` never leaves the
//                presenter (null); a slide `ins` arrives with its node
//                projected; element ops and everything else pass unchanged.
//                This is the one that keeps a stripped snapshot from being
//                repaired by the next keystroke in the notes panel.
//   carriesHidden — the predicate test-export-secrets uses on an audience
//                copy answers the same way as the assertions above.
//
// NEGATIVE CONTROL. `--mutate` empties AUDIENCE_HIDDEN before running (the
// module reads it at call time), and the run must go red. A projection rig
// that stays green with the boundary removed is checking nothing.

import { AUDIENCE_HIDDEN, projectDoc, projectOp, carriesHidden } from '../slides/src/audience.ts'
import { SyncState } from '../slides/src/sync/crdt.ts'
import type { BentoDoc, Slide } from '../slides/src/model.ts'
import type { Op } from '../kernel/src/sync/crdt.ts'

const MUTATE = process.argv.includes('--mutate')
if (MUTATE) (AUDIENCE_HIDDEN as unknown as string[]).length = 0

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const slide = (o: Partial<Slide> & { id: string }): Slide =>
  ({ background: '#fff', transition: 'fade', elements: [], notes: '', ...o } as Slide)
const comment = { id: 'c1', author: 'A', text: 'fix the number', at: '2026-09-13T00:00:00Z' }

const ROOM_KEY = 'ROOMKEY-b64u-not-for-the-audience'
const SHOW_KEY = 'SHOWKEY-b64u-per-show'
const ticket = {
  invite: { pub: 'AUDPUB', priv: 'AUDPRIV', role: 'audience' as const, sig: 'OWNERSIG' },
  key: SHOW_KEY,
}

const presenter: BentoDoc = {
  format: 'bento/slides', version: 1, docId: 'd1', title: 'Talk',
  size: { width: 1280, height: 720 },
  theme: { background: '#fff', color: '#000', accent: '#f00', fontFamily: 'sans' },
  slides: [
    slide({ id: 's1', notes: 'remember to breathe', comments: [comment] }),
    slide({ id: 's2', notes: 'skip if short on time', elements: [{ id: 'img', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'asset:big' } as never] }),
    slide({ id: 's2b', stateOf: 's2', notes: 'state notes', comments: [comment] }),
    slide({ id: 's3', hidden: true, notes: 'backup numbers' } as Partial<Slide> & { id: string }),
  ],
  layouts: [slide({ id: 'lay', name: 'Custom', notes: 'layout notes', comments: [comment] })],
  assets: { big: PNG, small: PNG },
  blobs: { big: { key: 'blobkey', mime: 'image/png', size: 9 }, gone: { key: 'k2', mime: 'image/png', size: 9 } },
  readonly: true,
  template: true,
  collab: {
    room: 'wROOM', key: ROOM_KEY, on: true, v: 2, owner: 'OWNERPUB',
    ownerPriv: 'OWNERPRIV', writerPub: 'WPUB', writerPriv: 'WPRIV',
    invite: { pub: 'WINV', priv: 'WINVPRIV', role: 'writer', sig: 'S' },
    audience: ticket,
  },
} as unknown as BentoDoc

const before = JSON.stringify(presenter)

console.log('projectDoc — the handout and the join snapshot\n')
const { doc: aud, missingAssets } = projectDoc(presenter, ticket)
ok(JSON.stringify(presenter) === before, 'the presenter document is untouched')
for (const s of aud.slides) {
  ok(s.notes === '', `slide ${s.id}: notes are empty`)
  ok(!('comments' in s), `slide ${s.id}: no comments key`)
}
ok(aud.layouts!.every((l) => l.notes === '' && !('comments' in l)), 'custom layouts are projected too')
ok(aud.slides.some((s) => s.id === 's2b' && s.stateOf === 's2'), 'the interactive state slide is kept')
ok(aud.slides.some((s) => s.id === 's3' && (s as { hidden?: boolean }).hidden === true), 'the HIDDEN slide is kept (reachable by link; part of the deck)')
ok(aud.blobs === undefined, 'blobs are dropped (a show-key copy cannot open room-key blobs)')
ok(aud.assets?.big === PNG, 'the offloaded asset is still inline')
ok(missingAssets.length === 1 && missingAssets[0] === 'gone', 'a blob with no inline bytes is reported, not silently lost')
ok(aud.readonly === undefined && aud.template === undefined, 'readonly/template are cleared')
const c = aud.collab!
ok(c.room === 'wROOM', 'same room')
ok(c.key === SHOW_KEY, 'collab.key IS the show key')
ok(c.key !== ROOM_KEY && JSON.stringify(aud).indexOf(ROOM_KEY) === -1, 'the room key appears nowhere in the audience copy')
ok((c.role as string) === 'audience', 'role is the distinct, client-visible \'audience\' (never \'reader\': every reader check would join the room path)')
ok(c.invite?.role === 'audience' && c.invite.pub === 'AUDPUB', 'the invite is the audience one')
ok(c.ownerPriv === undefined && c.writerPriv === undefined, 'no private halves')
ok((c as { audience?: unknown }).audience === undefined, 'the presenter\'s ticket store does not travel')
ok(c.owner === 'OWNERPUB' && c.writerPub === 'WPUB', 'public keys travel (the relay verifies the chain against them)')
ok(carriesHidden(aud).length === 0, `carriesHidden(audience copy) is empty (${carriesHidden(aud).join(', ') || 'nothing'})`)
ok(carriesHidden(presenter).length >= 6, `carriesHidden(presenter) names what would leak: ${carriesHidden(presenter).length} items`)

console.log('\nprojectOp — the live stream\n')
const base = { a: 'actor', s: 1, l: 1 }
const setNotes: Op = { ...base, op: 'set', sl: 's1', k: 'notes', v: 'new notes' }
const setComments: Op = { ...base, op: 'set', sl: 's1', k: 'comments', v: [comment] }
const setBg: Op = { ...base, op: 'set', sl: 's1', k: 'background', v: '#000' }
const setEl: Op = { ...base, op: 'set', sl: 's1', el: 's1e1', k: 'x', v: 5 }
const docSet: Op = { ...base, op: 'set', k: 'title', v: 'New title' }
const insSlide: Op = { ...base, op: 'ins', kind: 'slide', id: 's9', ord: 'm', node: slide({ id: 's9', notes: 'secret', comments: [comment] }) }
const insEl: Op = { ...base, op: 'ins', kind: 'element', id: 's1e2', sl: 's1', ord: 'm', node: { id: 'e2', type: 'text', x: 0, y: 0, w: 1, h: 1, html: 'hi' } as never }
const del: Op = { ...base, op: 'del', kind: 'slide', id: 's1' }
const txt: Op = { ...base, op: 'txt', el: 's1e1', sd: [1, 'actor'], ins: [{ at: '^', toks: ['x'] }] }

ok(projectOp(setNotes) === null, 'a notes edit never leaves the presenter')
ok(projectOp(setComments) === null, 'a comment never leaves the presenter')
ok(projectOp(setBg) === setBg, 'a slide background edit passes unchanged')
ok(projectOp(setEl) === setEl, 'an element edit passes unchanged')
ok(projectOp(docSet) === docSet, 'a document-level edit passes unchanged')
const projectedIns = projectOp(insSlide)
ok(projectedIns !== null && projectedIns.op === 'ins' && projectedIns.kind === 'slide', 'an inserted slide still arrives')
ok(projectedIns !== null && (projectedIns as typeof insSlide).node.notes === '' && !('comments' in (projectedIns as typeof insSlide).node),
  '…with its notes and comments stripped')
ok((insSlide.node as Slide).notes === 'secret', '…and the presenter\'s own op object is untouched')
ok(projectOp(insEl) === insEl, 'an inserted element passes unchanged')
ok(projectOp(del) === del && projectOp(txt) === txt, 'deletes and text deltas pass unchanged')

// The property the lead asked for by name: a batch that carries a notes op
// loses exactly that op, and the survivors are byte-identical.
const batch = [setBg, setNotes, setEl, setComments, docSet]
const streamed = batch.map(projectOp).filter((o): o is Op => o !== null)
ok(streamed.length === 3 && streamed.every((o) => (o as { k?: string }).k !== 'notes' && (o as { k?: string }).k !== 'comments'),
  'a mixed batch streams without its notes/comments ops and with nothing else changed')

// ---------------------------------------------------------------------------
// Engine-driven: ask the CRDT which op shapes each hidden-carrying edit
// actually produces, rather than trusting hand-built ops. Content-agnostic —
// a SENTINEL string is planted in every hidden field the edit touches and the
// projected wire must never contain it, while a VISIBLE marker planted in a
// public field must arrive (so an empty stream cannot pass). This is what
// caught `layouts`: the engine diffs doc.layouts as ONE whole-value register,
// which no slide-scoped rule saw (security, 2026-09-13).
console.log('\nengine-driven — every hidden-carrying edit the editor can make\n')
const SENTINEL = 'ZZ-HIDDEN-SENTINEL-ZZ'
const VISIBLE = 'ZZ-VISIBLE-MARKER-ZZ'
function baseDoc(): BentoDoc {
  return {
    format: 'bento/slides', version: 1, docId: 'd', title: 't',
    size: { width: 1280, height: 720 },
    theme: { background: '#fff', color: '#000', accent: '#f00', fontFamily: 'sans' },
    slides: [
      slide({ id: 'p1', elements: [{ id: 'e1', type: 'text', x: 0, y: 0, w: 10, h: 10, html: 'hello' } as never] }),
      slide({ id: 'p2' }),
    ],
    layouts: [slide({ id: 'l1', name: 'L' })],
    assets: {},
  } as unknown as BentoDoc
}
function driven(name: string, edit: (d: BentoDoc) => void, expectVisible = true) {
  const before = baseDoc()
  const engine = new SyncState('presenter')
  engine.adopt(before)
  const after: BentoDoc = JSON.parse(JSON.stringify(before))
  edit(after)
  const ops = engine.diff(before, after, { text: true })
  ok(ops.length > 0, `${name}: the engine minted ${ops.length} op(s)`)
  const wire = JSON.stringify(ops.map(projectOp).filter((o) => o !== null))
  ok(!wire.includes(SENTINEL), `${name}: the sentinel never reaches the wire`)
  if (expectVisible) ok(wire.includes(VISIBLE), `${name}: the visible edit in the same batch DOES arrive`)
  ok(JSON.stringify(ops).includes(SENTINEL), `${name}: (control) the unprojected ops did carry the sentinel`)
}
driven('edit speaker notes', (d) => { d.slides[0].notes = SENTINEL; d.slides[0].background = VISIBLE })
driven('add a comment with a reply', (d) => {
  d.slides[0].comments = [{ ...comment, text: SENTINEL, replies: [{ id: 'r', author: 'B', text: SENTINEL, at: comment.at }] }]
  d.slides[0].background = VISIBLE
})
driven('duplicate a slide that has notes', (d) => {
  d.slides.push(slide({ id: 'p3', notes: SENTINEL, comments: [{ ...comment, text: SENTINEL }], background: VISIBLE }))
})
driven('new interactive state from a slide with notes', (d) => {
  d.slides.splice(1, 0, slide({ id: 'p1b', stateOf: 'p1', notes: SENTINEL, background: VISIBLE }))
})
driven('save slide as layout (doc-level register)', (d) => {
  d.layouts!.push(slide({ id: 'l2', name: VISIBLE, notes: SENTINEL, comments: [{ ...comment, text: SENTINEL }] }))
})
driven('edit an existing layout\'s notes', (d) => { d.layouts![0].notes = SENTINEL; d.layouts![0].name = VISIBLE })
driven('sync a state from its parent (content + notes together)', (d) => {
  d.slides.push(slide({ id: 'p1c', stateOf: 'p1', notes: SENTINEL, elements: [{ id: 'e1', type: 'text', x: 0, y: 0, w: 10, h: 10, html: VISIBLE } as never] }))
})
driven('replace the whole layouts list', (d) => { d.layouts = [slide({ id: 'l9', name: VISIBLE, notes: SENTINEL })] })

console.log(`\n${checks - failures}/${checks} checks passed${MUTATE ? ' (MUTATED — this run must be red)' : ''}`)
process.exit(failures ? 1 : 0)
