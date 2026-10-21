#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Every whole-document restore in bento/spaces, by DIRECTION.
//
//   node scripts/test-spaces.mjs restore
//
// (Bundled: store.ts imports './model' extensionless — the runner does what CI
// does. Run from the repo root; the last section reads main.ts and doccmds.ts.)
//
// WHAT THIS PROVES. Spaces restores a whole document from six places, and all
// of them now resolve field-by-field through ONE kernel call
// (kernel/src/docfields.ts applyRestore) over ONE rule set (store.ts
// RESTORE_RULES). What differs is the DIRECTION each passes:
//
//   'back'    undo, redo, a version restore (this browser's timeline and the
//             one inside the file), Replace from JSON, bento.loadDoc;
//   'recover' the crash-recovery banner.
//
// Each section drives the REAL entry point (Store.undo/redo, restoreVersion,
// replaceFromJson, recoverInto) and checks the three things a direction
// decides: identity/mode/capability (always live), history (live on 'back';
// on 'recover', revisions follow the snapshot when it has them and the trail
// unions by day through trail.ts trailRecover), and content (follows).
//
// THE ASSETS TRAP. Undo checkpoints omit `assets` for size, and applyRestore on
// 'back' reads an absent content field as dropped. store.ts keeps the pool live
// on the undo path only (UNDO_RULES); section 4 is what goes red without it.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store, RESTORE_RULES, RECOVER_RULES, rulesFor, restoreAt } from '../spaces/src/store.ts'
import { parseDoc, FORMAT, type SpacesDoc } from '../spaces/src/model.ts'
import { recoverInto, restoreVersion, replaceFromJson, recoveryOffered, gateRestored } from '../spaces/src/restoregate.ts'
import { trailRecover, pruneTrail, TRAIL_BUDGET, TRAIL_MAX, spanOf, dayIndex, parseTrailKey, type Trail, type TrailRow } from '../spaces/src/trail.ts'
import { recordRevision, restoredDoc, revisionsOf, revisionsRecover, clearHistory } from '../spaces/src/history.ts'
import { recoveryBanner, wireRecoveryOff, type RecoveryBanner } from '../spaces/src/recoverynotice.ts'
import { putRecovery, recoveryOff } from '../kernel/src/autosave.ts'
import { resetDocStoreForTest, type DocStore } from '../kernel/src/docstore.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const J = (v: unknown) => JSON.stringify(v)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
type Obj = Record<string, any>

const LIVE_COLLAB = { v: 2, room: 'wLIVE', key: 'live-key', on: true }
const PHOTO = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(40)
const LIVE_MODIFIED = '2026-09-15T12:00:00.000Z'
const LIVE_MS = Date.parse(LIVE_MODIFIED)
const HOUR = 3600_000

const row = (todo: number, extra: Partial<TrailRow> = {}): TrailRow => ({ n: { todo }, ...extra })

function mk(over: Obj = {}): SpacesDoc {
  const r = parseDoc(J({
    format: FORMAT, version: 1, docId: 'space-R', title: 'R', home: 'p1', modified: LIVE_MODIFIED,
    theme: { background: '#fff', color: '#1E2A3A', accent: '#F7A600', measure: 720 },
    pages: [
      { id: 'p1', title: 'One', blocks: [{ id: 'b1', type: 'p', html: 'live text' }] },
      { id: 'p2', title: 'Two', parent: 'p1', blocks: [{ id: 'b2', type: 'p', html: 'two' }] },
    ],
    assets: { photo: PHOTO },
    collab: LIVE_COLLAB,
    trail: { '2026-09-10': row(5), '2026-09-11': row(6) },
    ...over,
  }))
  if (!r.ok) throw new Error('fixture did not parse')
  return r.doc
}
/** What autosave files (kernel contentOnly): the document minus collab. */
const snapOf = (doc: SpacesDoc): Obj => { const { collab: _c, ...rest } = clone(doc) as Obj; void _c; return rest }
const text = (d: SpacesDoc) => String(d.pages[0]?.blocks[0]?.html ?? '')
/** identity, modes and capability are exactly the live ones */
const identityLive = (d: SpacesDoc) =>
  d.docId === 'space-R' && J(d.collab) === J(LIVE_COLLAB) && d.readonly === undefined && d.template === undefined
/** a forged identity block a snapshot / paste / version might carry */
const FORGED = { docId: 'space-R', collab: { v: 2, room: 'wEVIL', key: 'evil', on: true }, readonly: true, template: true }

console.log('bento/spaces whole-document restore, by direction\n')

// ---------------------------------------------------------------------------
console.log('0. the rules\n')
{
  ok(RESTORE_RULES.recover !== undefined && Object.keys(RESTORE_RULES.recover).sort().join() === 'revisions,trail',
    'two recover hooks are bound: trail and revisions')
  ok(RESTORE_RULES.recover!.trail === trailRecover && RESTORE_RULES.recover!.revisions === revisionsRecover,
    '…trail.ts trailRecover and history.ts revisionsRecover')
  ok(RECOVER_RULES.recover === RESTORE_RULES.recover, '…and the recovery rules carry the same hooks')
  ok(!RESTORE_RULES.keepLive, 'no keepLive override in the shared rules (the undo-only assets override lives beside undo)')
  ok(J(RECOVER_RULES.keepLiveWhenAbsent) === J(['trail']),
    'RECOVER_RULES.keepLiveWhenAbsent is EXACTLY [\'trail\'] — never revisions (cleared history stays cleared)')
  ok(RESTORE_RULES.keepLiveWhenAbsent === undefined, '…and the \'back\' rules carry no such list')
  ok(RECOVER_RULES.wholeSnapshot === true && rulesFor('recover') === RECOVER_RULES,
    'the recovery banner passes wholeSnapshot: true EXPLICITLY (a recovery snapshot is the whole document)')
  ok(rulesFor('back') === RESTORE_RULES && RESTORE_RULES.wholeSnapshot === undefined, '\'back\' paths use the shared rules, where the flag does not apply')
  const a = restoreAt(mk(), 123)
  ok(a.live === LIVE_MS && a.incoming === 123, 'restoreAt: live = Date.parse(modified), incoming = the snapshot\'s ms')
  const noMod = mk(); delete noMod.modified
  ok(restoreAt(noMod, 5).live === undefined, 'restoreAt: no modified → live undefined')
  const badMod = mk(); badMod.modified = 'not a date'
  ok(restoreAt(badMod, 5).live === undefined, 'restoreAt: an unparseable modified → live undefined, never NaN')
}

// ---------------------------------------------------------------------------
console.log('\n1. undo / redo go BACK: content follows, identity and history stay live\n')
{
  const s = new Store(mk({ revisions: [{ id: 'r0', at: '2026-09-01T00:00:00Z', body: { full: 1 } }] }))
  s.commit(() => { s.doc.pages[0].blocks[0].html = 'edited' })
  // since the checkpoint: Stop sharing, a mode, and history written outside any commit
  ;(s.doc.collab as Obj).on = false
  const collabNow = J(s.doc.collab)
  ;(s.doc.trail as Obj)['2026-09-12'] = row(7)
  ;(s.doc.revisions as Obj[]).push({ id: 'r1', at: '2026-09-12T00:00:00Z', body: { full: 2 } })
  const histNow = J([s.doc.trail, s.doc.revisions])
  s.undo()
  ok(text(s.doc) === 'live text', 'undo: content follows the checkpoint')
  ok(J(s.doc.collab) === collabNow && s.doc.docId === 'space-R', 'undo: identity and capability are the live ones (Stop sharing survives ⌘Z)')
  ok(J([s.doc.trail, s.doc.revisions]) === histNow, 'undo: history (trail AND revisions) is the live one')
  ok(s.doc.assets?.photo === PHOTO, 'undo: the asset pool is intact')
  s.redo()
  ok(text(s.doc) === 'edited' && J(s.doc.collab) === collabNow && J([s.doc.trail, s.doc.revisions]) === histNow,
    'redo: content follows, identity and history stay live')
}

// ---------------------------------------------------------------------------
console.log('\n2. version restore goes BACK (both timelines)\n')
{
  // the timeline inside the file (history.ts)
  const s = new Store(mk())
  recordRevision(s.doc)
  s.commit(() => { s.doc.pages[0].blocks[0].html = 'this week' })
  recordRevision(s.doc)
  ;(s.doc.trail as Obj)['2026-09-12'] = row(9)
  const hist = J([s.doc.trail, s.doc.revisions])
  const v = restoredDoc(s.doc, 0)!
  Object.assign(v, FORGED, { trail: { '2020-01-01': row(1) }, revisions: [] })
  ok(restoreVersion(s, J(v)), 'Versions in this file: restores')
  ok(text(s.doc) === 'live text', '…content is the version\'s')
  ok(identityLive(s.doc), '…identity, modes and capability are the live ones')
  ok(J([s.doc.trail, s.doc.revisions]) === hist, '…history is the live one (a version never installs or drops history)')
  ok(revisionsOf(s.doc).length === 2, '…both revisions still there')
}
{
  // this browser's timeline: a stored snapshot (the same verb)
  const s = new Store(mk())
  const older = snapOf(mk()); older.pages[0].blocks[0].html = 'an hour ago'
  older.trail = { '2026-09-01': row(1) }; older.revisions = [{ id: 'x', at: 't', body: {} }]
  Object.assign(older, { collab: FORGED.collab, readonly: true, template: true })
  ok(restoreVersion(s, J(older)), 'Version history (this browser): restores')
  ok(text(s.doc) === 'an hour ago' && identityLive(s.doc), '…content follows, identity live')
  ok(J(s.doc.trail) === J(mk().trail) && s.doc.revisions === undefined, '…history live: no trail swap, no revisions installed')
  // 'back': an ABSENT content field is dropped — a version is the whole document
  const s2 = new Store(mk({ footnotes: { 1: 'live note' } }))
  const noNotes = snapOf(mk())
  ok(restoreVersion(s2, J(noNotes)) && s2.doc.footnotes === undefined, '…and content absent from the version is absent after it')
  ok(s2.doc.assets?.photo === PHOTO, '…a version carries its own pool, so assets follow it')
  s2.undo()
  ok(J(s2.doc.footnotes) === J({ 1: 'live note' }), '⌘Z walks the version restore back')
}

// ---------------------------------------------------------------------------
console.log('\n3. Replace from JSON (and bento.loadDoc) go BACK\n')
{
  const s = new Store(mk({ revisions: [{ id: 'r0', at: '2026-09-01T00:00:00Z', body: { full: 1 } }] }))
  const hist = J([s.doc.trail, s.doc.revisions])
  // Copy document JSON's output: no history, no collab
  const pasted = snapOf(s.doc); delete pasted.trail; delete pasted.revisions
  pasted.pages[0].blocks[0].html = 'pasted'
  ok(replaceFromJson(s, J(pasted)), 'Copy JSON\'s output replaces')
  ok(text(s.doc) === 'pasted' && identityLive(s.doc), '…content follows, identity live')
  ok(J([s.doc.trail, s.doc.revisions]) === hist, '…a paste never DELETES history')
  const forged = { ...snapOf(s.doc), ...FORGED, docId: 'other-space', trail: { '2020-01-01': row(1) }, revisions: [{ id: 'f', at: 't', body: {} }] }
  ok(replaceFromJson(s, J(forged)), 'a paste carrying forged identity and history replaces content')
  ok(identityLive(s.doc), '…but never brings docId, collab, readonly or template')
  ok(J([s.doc.trail, s.doc.revisions]) === hist, '…and never INSTALLS a history')
  ok(!replaceFromJson(s, 'not json') && text(s.doc) === 'pasted', 'text that is not a document applies nothing')
  const ro = new Store(mk()); ro.readOnly = true
  ok(!replaceFromJson(ro, J(pasted)) && text(ro.doc) === 'live text', 'a read-only store is never replaced')
}

// ---------------------------------------------------------------------------
console.log('\n4. the assets trap: undo checkpoints omit the pool\n')
{
  // an image inserted the way editor.ts does it: internAsset writes the bytes,
  // ONE commit writes the block
  const s = new Store(mk({ assets: {} }))
  const IMG = 'data:image/png;base64,' + 'QUJD'.repeat(64)
  s.doc.assets!.img = IMG
  s.commit(() => { s.doc.pages[0].blocks.push({ id: 'bi', type: 'image', src: 'asset:img' } as never) })
  s.commit(() => { s.doc.pages[0].blocks[0].html = 'a later edit' })
  s.undo()
  ok(text(s.doc) === 'live text' && s.doc.pages[0].blocks.some((b) => b.id === 'bi'),
    'undo of a LATER edit leaves the image block')
  ok(s.doc.assets?.img === IMG, '…and the image\'s BYTES (a checkpoint has no pool; it must not empty it)')
  s.undo()
  ok(!s.doc.pages[0].blocks.some((b) => b.id === 'bi'), 'undo of the image insert removes the reference')
  ok(s.doc.assets?.img === IMG, '…but not the bytes (the pool is pruned on save, never by undo)')
  s.redo()
  const back = s.doc.pages[0].blocks.find((b) => b.id === 'bi')
  ok(back?.src === 'asset:img' && s.doc.assets?.img === IMG, 'redo: the image is back WITH its bytes')
}
{
  // the same bytes used on two pages: undoing the second insert keeps the first
  const s = new Store(mk())
  s.commit(() => { s.doc.pages[1].blocks.push({ id: 'bp', type: 'image', src: 'asset:photo' } as never) })
  s.commit(() => { s.doc.pages[0].blocks.push({ id: 'bq', type: 'image', src: 'asset:photo' } as never) })
  s.undo()
  ok(!s.doc.pages[0].blocks.some((b) => b.id === 'bq') && s.doc.pages[1].blocks.some((b) => b.src === 'asset:photo'),
    'undo of a second use removes that reference only')
  ok(s.doc.assets?.photo === PHOTO, '…and the bytes the other page still uses stay')
  s.undo()
  ok(s.doc.assets?.photo === PHOTO, 'undo of the first use too: bytes stay (unchanged from before the kernel took over)')
}

// ---------------------------------------------------------------------------
console.log('\n5. crash recovery goes RECOVER\n')
{
  // identity, modes and capability: still live
  const s = new Store(mk())
  const snap = { ...snapOf(mk()), ...FORGED }
  snap.pages[0].blocks[0].html = 'lost in the crash'
  ok(recoverInto(s, { json: J(snap), at: LIVE_MS + HOUR }), 'the banner\'s Restore applies')
  ok(text(s.doc) === 'lost in the crash', '…content follows the snapshot')
  ok(identityLive(s.doc), '…identity, modes and capability stay live')
  s.undo()
  ok(text(s.doc) === 'live text', '⌘Z walks a recovery back')
}
{
  // revisions: follow the snapshot when present
  const live = mk({ revisions: [{ id: 'r0', at: '2026-09-01T00:00:00Z', body: { a: 1 } }] })
  const snap = snapOf(live)
  snap.revisions = [{ id: 'r0', at: '2026-09-01T00:00:00Z', body: { a: 1 } }, { id: 'r1', at: '2026-09-15T13:00:00Z', body: { a: 2 } }]
  snap.pages[0].blocks[0].html = 'x'
  const s = new Store(live)
  ok(recoverInto(s, { json: J(snap), at: LIVE_MS + HOUR }) && J(s.doc.revisions) === J(snap.revisions),
    'revisions FOLLOW the snapshot when it carries a READABLE list')
  const live2 = mk({ revisions: [{ id: 'r0', at: '2026-09-01T00:00:00Z', body: { a: 1 } }] })
  const snap2 = snapOf(live2); delete snap2.revisions; snap2.pages[0].blocks[0].html = 'y'
  const s2 = new Store(live2)
  ok(recoverInto(s2, { json: J(snap2), at: LIVE_MS + HOUR }) && !Object.hasOwn(s2.doc, 'revisions'),
    'revisions ABSENT from the (whole) snapshot were CLEARED: the key is removed')
}
{
  // a recovery snapshot is foreign input: a list with ONE entry this build
  // cannot read must not replace the live, readable log (revisionsRecover)
  const LIVE_REVS = [{ id: 'r0', at: '2026-09-01T00:00:00Z', body: { a: 1 } }, { id: 'r1', at: '2026-09-02T00:00:00Z', body: { a: 2 } }]
  const good = (id: string, at: string) => ({ id, at, body: { a: 3 } })
  const cases: Array<[string, unknown]> = [
    ['ONE entry missing its body beside valid ones', [...LIVE_REVS, good('r2', '2026-09-15T13:00:00Z'), { id: 'bad', at: '2026-09-15T14:00:00Z' }]],
    ['ONE entry with a bad `at` beside valid ones', [good('r2', '2026-09-15T13:00:00Z'), { id: 'bad', at: 42, body: {} }]],
    ['ONE entry with an unreadable page patch', [good('r2', '2026-09-15T13:00:00Z'), { id: 'bad', at: '2026-09-15T14:00:00Z', body: { pages: [{ put: 'x' }] } }]],
    ['`revisions` that is not an array', { r0: good('r0', '2026-09-15T13:00:00Z') }],
  ]
  for (const [what, revs] of cases) {
    const live = mk({ revisions: clone(LIVE_REVS), trail: { '2026-09-10': row(5) } })
    const before = J(live.revisions)
    const snap = snapOf(live)
    snap.revisions = revs
    snap.trail = { '2026-09-12': row(7) }
    snap.pages[0].blocks[0].html = 'recovered anyway'
    const s = new Store(live)
    ok(recoverInto(s, { json: J(snap), at: LIVE_MS + HOUR }), `foreign revisions (${what}): the recovery still applies`)
    ok(J(s.doc.revisions) === before, `…the LIVE list is kept byte-for-byte`)
    ok(text(s.doc) === 'recovered anyway' && J(Object.keys(s.doc.trail as Obj).sort()) === J(['2026-09-10', '2026-09-12']),
      '…while the content and the trail merge still apply')
  }
  {
    // no live list + a foreign incoming one: nothing is installed
    const live = mk()
    const snap = snapOf(live)
    snap.revisions = [{ id: 'bad', at: 7 }]
    snap.pages[0].blocks[0].html = 'no history here'
    const s = new Store(live)
    ok(recoverInto(s, { json: J(snap), at: LIVE_MS + HOUR }) && text(s.doc) === 'no history here', 'live with no revisions + a foreign recovered list: the recovery applies')
    ok(!Object.hasOwn(s.doc, 'revisions'), '…and the revisions key stays ABSENT')
  }
  ok(revisionsRecover(undefined, [{ id: 'x' }]) === undefined && revisionsRecover(LIVE_REVS, 'junk') === LIVE_REVS,
    'revisionsRecover refuses a foreign list WHOLE and never merges')
}
{
  // CLEARED STAYS CLEARED. Clear history deletes the key; autosave then files
  // the doc without it (kernel contentOnly = the doc minus collab); the file
  // on disk still carries the old drafts. Restore must not bring them back.
  const DRAFTS = [{ id: 'r0', at: '2026-09-01T00:00:00Z', body: { a: 1 } }, { id: 'r1', at: '2026-09-02T00:00:00Z', body: { a: 2 } }]
  const session = new Store(mk({ revisions: clone(DRAFTS) }))
  ok(clearHistory(session.doc) && !('revisions' in session.doc), 'the real clearHistory deletes the key')
  session.commit(() => { session.doc.pages[0].blocks[0].html = 'edited after clearing' })
  const contentOnly = (d: SpacesDoc) => { const { collab: _c, ...rest } = d as Obj; void _c; return J(rest) }
  const snapJson = contentOnly(session.doc)
  const reopened = new Store(mk({ revisions: clone(DRAFTS) }))  // the file still has them
  ok(recoveryOffered(snapJson, reopened.doc, LIVE_MS + HOUR), 'the banner is offered for the crash copy')
  ok(recoverInto(reopened, { json: snapJson, at: LIVE_MS + HOUR }), 'Restore applies')
  ok(!('revisions' in reopened.doc), 'CLEARED STAYS CLEARED: after Restore there is NO revisions key')
  ok(text(reopened.doc) === 'edited after clearing' && J(Object.keys(reopened.doc.trail as Obj).sort()) === J(Object.keys(mk().trail as Obj).sort()),
    '…and the content and the trail come back as usual')
  // an explicit [] means the same
  const s2 = new Store(mk({ revisions: clone(DRAFTS) }))
  const withEmpty = snapOf(mk()); withEmpty.revisions = []; withEmpty.pages[0].blocks[0].html = 'e'
  ok(recoverInto(s2, { json: J(withEmpty), at: LIVE_MS + HOUR }) && !('revisions' in s2.doc), 'an incoming [] is cleared too: no key, never `revisions: []`')
  // THE GUARD, MEASURED. Spaces no longer normalises an absent `revisions`
  // itself; the kernel (#726) removes it from a whole snapshot unless the
  // field is listed in keepLiveWhenAbsent. So RECOVER_RULES' list is the one
  // thing between a cleared history and its resurrection. Plant the mistake —
  // a variant listing 'revisions' — on the REAL rules object and run the REAL
  // recovery path: the cleared drafts come BACK. That is the failure the
  // exact-list pin above exists to prevent; the real rules must not do it.
  {
    const realList = RECOVER_RULES.keepLiveWhenAbsent
    const runRecovery = (): SpacesDoc => {
      const st = new Store(mk({ revisions: clone(DRAFTS) }))  // the file still has the drafts
      recoverInto(st, { json: snapJson, at: LIVE_MS + HOUR })    // the snapshot was taken after Clear history
      return st.doc
    }
    let planted: SpacesDoc
    try {
      ;(RECOVER_RULES as { keepLiveWhenAbsent?: readonly string[] }).keepLiveWhenAbsent = ['trail', 'revisions']
      planted = runRecovery()
    } finally {
      ;(RECOVER_RULES as { keepLiveWhenAbsent?: readonly string[] }).keepLiveWhenAbsent = realList
    }
    ok(J(planted.revisions) === J(DRAFTS),
      'PLANTED BUG: rules listing \'revisions\' in keepLiveWhenAbsent RESURRECT the cleared drafts (the bug the list guards against)')
    const real = runRecovery()
    ok(!('revisions' in real), '…while the REAL RECOVER_RULES leave cleared history cleared')
    ok(J(RECOVER_RULES.keepLiveWhenAbsent) === J(['trail']), '…and the plant was undone (the list is exactly [\'trail\'] again)')
  }
  // a FOREIGN LIVE list is never written over by a readable recovered one
  const foreignLive = [{ id: 'future', at: '2026-09-01T00:00:00Z', body: { v9: true, pages: 'a newer shape' } }]
  const s3 = new Store(mk({ revisions: clone(foreignLive) }))
  const before3 = J(s3.doc.revisions)
  const readableSnap = snapOf(mk()); readableSnap.revisions = clone(DRAFTS); readableSnap.pages[0].blocks[0].html = 'f'
  ok(recoverInto(s3, { json: J(readableSnap), at: LIVE_MS + HOUR }) && J(s3.doc.revisions) === before3,
    'a FOREIGN live list + a readable recovered one → the live list is kept byte-for-byte')
  // readable over readable still follows
  const s4 = new Store(mk({ revisions: [DRAFTS[0]] }))
  ok(recoverInto(s4, { json: J({ ...snapOf(mk()), revisions: DRAFTS }), at: LIVE_MS + HOUR }) && J(s4.doc.revisions) === J(DRAFTS),
    'a readable recovered list over a readable live one still FOLLOWS')
  // the hook's order, directly
  ok(revisionsRecover(DRAFTS, []) === undefined, 'hook rule 1: [] → undefined (key removed)')
  ok(revisionsRecover(foreignLive, DRAFTS) === foreignLive, 'hook rule 3: a foreign live list → live')
  // 'back' is unaffected: history stays live, and a paste after a clear
  // resurrects nothing
  const b = new Store(mk({ revisions: clone(DRAFTS) }))
  clearHistory(b.doc)
  const pasted = snapOf(mk({ revisions: clone(DRAFTS) })); pasted.pages[0].blocks[0].html = 'pasted'
  ok(replaceFromJson(b, J(pasted)) && !('revisions' in b.doc), 'Replace from JSON after a clear does not resurrect the drafts (history stays live: none)')
  const v = new Store(mk({ revisions: clone(DRAFTS) }))
  const noRevs = snapOf(mk()); noRevs.pages[0].blocks[0].html = 'version'
  ok(restoreVersion(v, J(noRevs)) && J(v.doc.revisions) === J(DRAFTS), 'a version restore with no revisions keeps the live history (\'back\' is untouched)')
  v.commit(() => { v.doc.pages[0].blocks[0].html = 'after' }); v.undo()
  ok(J(v.doc.revisions) === J(DRAFTS), '…and undo keeps it too')
}
{
  // trail through the real banner path: the hook unions by day
  const live = mk({ trail: { '2026-09-10': row(5), '2026-09-11': row(6), '2026-09-14': row(9) } })
  const snap = snapOf(live)
  snap.trail = { '2026-09-11': row(60), '2026-09-12': row(7) }
  const s = new Store(live)
  ok(recoveryOffered(J(snap), live, LIVE_MS + HOUR), 'a snapshot whose trail adds a day raises the banner')
  ok(recoverInto(s, { json: J(snap), at: LIVE_MS + HOUR }), 'and Restore applies')
  ok(J(Object.keys(s.doc.trail as Obj).sort()) === J(['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-14']),
    'the trail is the per-day UNION through recoverInto (both sides\' days)')
  ok((s.doc.trail as Obj)['2026-09-11'].n.todo === 60, '…a newer snapshot wins the shared day')
  // a snapshot whose trail is a SUBSET of the file's, nothing else different
  const sub = snapOf(live); sub.trail = { '2026-09-10': row(5) }
  ok(!recoveryOffered(J(sub), live, LIVE_MS - HOUR), 'an older snapshot holding only days the file has raises no banner')
}

// ---------------------------------------------------------------------------
console.log('\n5b. a recovery removes what was removed (wholeSnapshot)\n')
{
  // the file still has a design, footnotes, a journal template and a key from
  // a newer build; the crash copy (taken after the person removed all four)
  // has none of them, and carries no history at all
  const live = mk({
    design: 'ledger', footnotes: { 1: 'a note' }, journalTemplate: 't1', futureKey: { from: 'newer' },
    revisions: [{ id: 'r0', at: '2026-09-01T00:00:00Z', body: { a: 1 } }],
  })
  const snap = snapOf(mk())
  delete snap.trail; delete snap.revisions
  snap.pages[0].blocks[0].html = 'after removing them'
  Object.assign(snap, { readonly: true, template: true, collab: FORGED.collab })
  const s = new Store(live)
  const histBefore = J([s.doc.trail, s.doc.revisions])
  ok(recoverInto(s, { json: J(snap), at: LIVE_MS + HOUR }), 'recoverInto applies the crash copy')
  const d = s.doc as SpacesDoc & Obj
  ok(!('design' in d) && !('footnotes' in d) && !('journalTemplate' in d),
    'a design, footnotes and journal template REMOVED after the last save stay removed after recovery')
  ok(!('futureKey' in d), 'an UNKNOWN top-level key absent from the snapshot is removed too')
  ok(J(d.trail) === J(JSON.parse(histBefore)[0]), 'an absent trail in the snapshot KEEPS the live rows')
  ok(!('revisions' in d), 'an absent revisions in the snapshot means cleared: no key')
  ok(identityLive(d), 'the identity / mode / capability floor is unchanged')
  ok(!recoveryOffered(J(snapOf(live)), live, LIVE_MS + HOUR), 'a snapshot identical to the file still raises no banner')
  ok(recoveryOffered(J(snap), live, LIVE_MS + HOUR), 'a snapshot that removed fields raises it')
}

// ---------------------------------------------------------------------------
console.log('\n6. trailRecover: the four rows, and the edges\n')
{
  const L: Trail = { '2026-09-10': row(5), '2026-09-11': row(6), '2026-09-14': row(9) }
  // 1. an OLDER snapshot keeps the live later days (and live wins shared ones)
  const older = trailRecover(L, { '2026-09-10': row(50), '2026-09-11': row(60) }, { live: LIVE_MS, incoming: LIVE_MS - HOUR }) as Trail
  ok(older['2026-09-14']?.n.todo === 9, 'row 1: an OLDER snapshot keeps the live later days')
  ok(older['2026-09-10'].n.todo === 5 && older['2026-09-11'].n.todo === 6, 'row 1: …and the live side wins every shared day')
  // 2. a NEWER snapshot wins its shared days
  const newer = trailRecover(L, { '2026-09-11': row(60), '2026-09-15': row(10) }, { live: LIVE_MS, incoming: LIVE_MS + HOUR }) as Trail
  ok(newer['2026-09-11'].n.todo === 60, 'row 2: a NEWER snapshot wins its shared days')
  ok(newer['2026-09-10'].n.todo === 5 && newer['2026-09-14'].n.todo === 9 && newer['2026-09-15'].n.todo === 10,
    'row 2: …and every day on one side only is kept')
  // 3. a snapshot WITHOUT trail leaves live intact (through the real path:
  //    since kernel #726 a whole snapshot removes an absent history key, and
  //    RECOVER_RULES opts trail out — keepLiveWhenAbsent: ['trail'])
  const live = mk({ trail: clone(L) })
  const snap = snapOf(live); delete snap.trail; snap.pages[0].blocks[0].html = 'z'
  const s = new Store(live)
  ok(recoverInto(s, { json: J(snap), at: LIVE_MS + HOUR }) && J(s.doc.trail) === J(L),
    'row 3: a snapshot WITHOUT a trail leaves the live trail intact')
  // the opt-out is trail's ONLY: in the SAME whole snapshot, absent revisions
  // are still removed (cleared), and the trail is kept byte-for-byte
  {
    const live2 = mk({ trail: clone(L), revisions: [{ id: 'r0', at: '2026-09-01T00:00:00Z', body: { a: 1 } }] })
    const trailBytes = J(live2.trail)
    const snap2 = snapOf(live2); delete snap2.trail; delete snap2.revisions; snap2.pages[0].blocks[0].html = 'whole, no history'
    const s2 = new Store(live2)
    ok(recoverInto(s2, { json: J(snap2), at: LIVE_MS + HOUR }), 'a whole recovery snapshot with NO trail and NO revisions applies')
    ok(J(s2.doc.trail) === trailBytes, '…the live trail is kept byte-for-byte (keepLiveWhenAbsent: trail)')
    ok(!Object.hasOwn(s2.doc, 'revisions'), '…while the absent revisions are still REMOVED (cleared stays cleared)')
  }
  // tie → live
  const tie = trailRecover(L, { '2026-09-11': row(60) }, { live: LIVE_MS, incoming: LIVE_MS }) as Trail
  ok(tie['2026-09-11'].n.todo === 6, 'a TIE keeps live')
  // live time unknown, incoming known → incoming
  const unknownLive = trailRecover(L, { '2026-09-11': row(60) }, { live: undefined, incoming: LIVE_MS }) as Trail
  ok(unknownLive['2026-09-11'].n.todo === 60, 'live with no modified vs a defined snapshot time → incoming wins shared days')
  const bothUnknown = trailRecover(L, { '2026-09-11': row(60) }, {}) as Trail
  ok(bothUnknown['2026-09-11'].n.todo === 6, '…and with neither time known, live keeps them')
  // and through the real path, a live space with no modified
  const nm = mk({ trail: clone(L) }); delete nm.modified
  const nmSnap = snapOf(nm); nmSnap.trail = { '2026-09-11': row(60) }; nmSnap.pages[0].blocks[0].html = 'q'
  const s2 = new Store(nm)
  ok(recoverInto(s2, { json: J(nmSnap), at: LIVE_MS }) && (s2.doc.trail as Obj)['2026-09-11'].n.todo === 60,
    '…through recoverInto too (a file with no modified is OLDER than its snapshot)')
}
{
  // 4. bucket rows vs single days: never count a day twice
  const covered = (t: Trail, series = '') => {
    const days = new Map<number, number>()
    for (const k of Object.keys(t)) {
      const a = parseTrailKey(k); if (!a || a.series !== series) continue
      const end = dayIndex(a.day)
      for (let d = end - spanOf(t[k]) + 1; d <= end; d++) days.set(d, (days.get(d) ?? 0) + 1)
    }
    return days
  }
  const once = (t: Trail, series = '') => [...covered(t, series).values()].every((n) => n === 1)
  // live thinned the week of 2026-09-07..13 to its last row (s = 7); the
  // snapshot (older) still holds three single days inside that week
  const liveT: Trail = { '2026-09-13': row(20, { s: 7 }), '2026-09-14': row(21) }
  const snapT: Trail = { '2026-09-08': row(1), '2026-09-09': row(2), '2026-09-12': row(3), '2026-09-01': row(9) }
  const a = trailRecover(liveT, snapT, { live: LIVE_MS, incoming: LIVE_MS - HOUR }) as Trail
  ok(once(a), `row 4: a live bucket + snapshot single days inside it count every day ONCE (${J(Object.keys(a).sort())})`)
  ok(a['2026-09-13']?.s === 7 && !a['2026-09-08'] && !a['2026-09-09'] && !a['2026-09-12'],
    'row 4: …the bucket stands, the single days inside its span are dropped')
  ok(a['2026-09-01']?.n.todo === 9 && a['2026-09-14']?.n.todo === 21, 'row 4: …days outside the span are kept')
  // the mirror: the bucket arrives from the snapshot, singles are live's
  const b = trailRecover({ '2026-09-08': row(1), '2026-09-12': row(3) }, { '2026-09-13': row(20, { s: 7 }) },
    { live: LIVE_MS, incoming: LIVE_MS + HOUR }) as Trail
  ok(once(b) && b['2026-09-13']?.s === 7 && !b['2026-09-08'] && !b['2026-09-12'], 'row 4: …and the same from the other side')
  // two overlapping buckets (a weekly and a monthly thinning) never double-count either
  const c = trailRecover({ '2026-09-30': row(30, { s: 30 }) }, { '2026-09-13': row(20, { s: 7 }), '2026-10-02': row(1) },
    { live: LIVE_MS, incoming: LIVE_MS + HOUR }) as Trail
  ok(once(c) && !!c['2026-09-30'] && !c['2026-09-13'] && !!c['2026-10-02'], 'row 4: overlapping buckets resolve to one claim per day')
  // within budget: a union of two full trails is pruned
  const big = (from: number, n: number, todo: number): Trail => {
    const t: Trail = {}
    for (let i = 0; i < n; i++) {
      const d = new Date(Date.UTC(2025, 0, 1) + (from + i) * 86400000).toISOString().slice(0, 10)
      t[d] = { n: { todo: todo + i, doing: 3, done: i }, e: { todo: 13, doing: 5, done: 8 }, x: 1 }
    }
    return t
  }
  const bl = pruneTrail(big(0, 300, 0)), bi = pruneTrail(big(150, 300, 1000))
  const u = trailRecover(bl, bi, { live: LIVE_MS, incoming: LIVE_MS + HOUR }) as Trail
  ok(J(u).length <= TRAIL_BUDGET && Object.keys(u).length <= TRAIL_MAX,
    `row 4: the union of two full trails is within budget (${J(u).length} B ≤ ${TRAIL_BUDGET}, ${Object.keys(u).length} rows)`)
  ok(once(u), 'row 4: …and after pruning still counts every day once')
}
{
  // series keys never cross-match
  const liveT: Trail = { '2026-09-11': row(6), 'sprint/2026-09-13': row(20, { s: 7 }) }
  const snapT: Trail = { 'sprint/2026-09-11': row(66), '2026-09-12': row(7) }
  const r = trailRecover(liveT, snapT, { live: LIVE_MS, incoming: LIVE_MS + HOUR }) as Trail
  ok(r['2026-09-11']?.n.todo === 6 && r['2026-09-12']?.n.todo === 7,
    'a sprint bucket never drops a DEFAULT-series day inside its span')
  ok(!r['sprint/2026-09-11'] && !!r['sprint/2026-09-13'], '…while it does drop its own series\' single day')
  const r2 = trailRecover({ '2026-09-11': row(6) }, { 'sprint/2026-09-11': row(66) }, { live: LIVE_MS, incoming: LIVE_MS + HOUR }) as Trail
  ok(r2['2026-09-11'].n.todo === 6 && r2['sprint/2026-09-11'].n.todo === 66, 'the same day in two series is two keys, both kept')
}
{
  // edges: foreign shapes, unknown keys, prototype keys
  const L: Trail = { '2026-09-11': row(6) }
  ok(trailRecover(undefined, L, {}) === L, 'live has no trail → the snapshot\'s is taken')
  ok(trailRecover('a future shape', L, { incoming: LIVE_MS + HOUR }) === 'a future shape', 'a foreign live trail is never written over')
  ok(trailRecover(L, ['x'], { incoming: LIVE_MS + HOUR }) === L, 'a foreign incoming trail never replaces a readable one')
  const fut = trailRecover(L, { 'a/b/2026-09-11': row(1), '2026-09-11': row(60) }, { live: LIVE_MS, incoming: LIVE_MS + HOUR }) as Obj
  ok(fut['a/b/2026-09-11']?.n.todo === 1 && fut['2026-09-11'].n.todo === 60, 'a key this build cannot read rides along untouched')
  const evil = JSON.parse('{"__proto__":{"polluted":true},"2026-09-12":{"n":{"todo":1}}}')
  const pe = trailRecover(L, evil, { incoming: LIVE_MS + HOUR }) as Obj
  ok(Object.getPrototypeOf(pe) === Object.prototype && ({} as Obj).polluted === undefined && pe['2026-09-12'], 'a __proto__ key is never assigned')
}

// ---------------------------------------------------------------------------
console.log('\n7. the gate still runs first, in both directions\n')
{
  const live = mk()
  const other = snapOf(live); other.docId = 'someone-else'
  ok(!gateRestored(J(other), live, 'recover', LIVE_MS).ok && !gateRestored(J(other), live, 'back').ok,
    'a snapshot naming another space is refused before any merge')
  const s = new Store(mk())
  ok(!recoverInto(s, { json: J(other), at: LIVE_MS + HOUR }) && !s.canUndo, '…and recoverInto applies nothing')
  const hostile = snapOf(live); hostile.pages[0].blocks[0].html = 'hi<img src=x onerror="alert(1)">'
  ok(recoverInto(s, { json: J(hostile), at: LIVE_MS + HOUR }) && !/onerror/.test(text(s.doc)), 'recovered html is sanitized')
}

// ---------------------------------------------------------------------------
console.log('\n8. every entry point names its direction\n')
{
  const root = process.cwd()
  const src = (f: string) => readFileSync(join(root, f), 'utf8')
  const gate = src('spaces/src/restoregate.ts')
  const main = src('spaces/src/main.ts')
  const cmds = src('spaces/src/doccmds.ts')
  const store = src('spaces/src/store.ts')
  ok(/function recoverInto\([^)]*\)[^{]*\{\s*return restoreInto\(store, snap\.json, 'recover', snap\.at\)/.test(gate), 'recoverInto → \'recover\', timed by the snapshot')
  ok(/function restoreVersion\([^)]*\)[^{]*\{\s*return restoreInto\(store, json, 'back'\)/.test(gate), 'restoreVersion → \'back\'')
  ok(/function replaceFromJson[\s\S]{0,400}?store\.replaceDoc\(res\.doc, 'back'\)/.test(gate), 'replaceFromJson → \'back\'')
  const offer = main.slice(main.indexOf('async function offerRecovery('))
  ok(/recoverInto\(store, snap\)/.test(offer), 'the recovery banner restores through recoverInto')
  ok(/loadDoc: \(json: string\)[\s\S]{0,300}?replaceFromJson\(store, json\)/.test(main), 'bento.loadDoc goes through replaceFromJson')
  ok(/replaceFromJson\(h\.store, ta\.value\)/.test(cmds), 'Replace from JSON goes through replaceFromJson')
  ok((cmds.match(/restoreVersion\(h\.store, /g) ?? []).length === 2, 'both version timelines go through restoreVersion')
  const calls = (main + cmds).match(/\.replaceDoc\(/g) ?? []
  ok(calls.length === 0, 'no app file calls replaceDoc directly (only restoregate.ts does)')
  ok(!/keepLiveIdentity|keepLiveHistory/.test(store + gate), 'no hand-rolled keep-live remains in store.ts or restoregate.ts')
  ok(/applyRestore\(this\.doc, JSON\.parse\(entry\.json\) as SpacesDoc, 'back', UNDO_RULES\)/.test(store), 'undo/redo: one applyRestore, \'back\', with the undo-only rules')
  ok(/keepLive: \{ assets: 'live' \}/.test(store), '…whose only override is the assets pool')
  ok(/RECOVER_RULES: RestoreRules = \{\s*\.\.\.RESTORE_RULES,\s*wholeSnapshot: true,[\s\S]{0,800}?keepLiveWhenAbsent: \['trail'\],\s*\}/.test(store),
    'the recovery rules state wholeSnapshot: true and keepLiveWhenAbsent: [\'trail\'] in source')
  ok(/recover: \{ trail: trailRecover, revisions: revisionsRecover \}/.test(store), 'both recover hooks are bound in source')
}

// ---------------------------------------------------------------------------
// The maintainer's two recovery notices (2026-10-15, shared with slides and
// type): an older-looking snapshot WARNS but is still offered, with "Keep the
// file" the default; a refused recovery copy is said ONCE per space, never for
// an encrypted one. recoverynotice.ts decides both; the kernel supplies the
// signals (recoveryLooksOlder, onRecoveryOff). The browser half — focus, the
// planted snapshot, a refusing host — is test-spaces-recovery-browser.mjs.
console.log('\n9. the recovery banner\'s words, and the recovery-off notice\n')
{
  const OLDER = 'This recovered copy looks older than the file you opened. Keep the file unless you know it’s newer.'
  const PLAIN = 'Unsaved changes from a previous session were found.'
  const snapAt = (at: number) => ({ docId: 'space-R', at, title: 'R', json: J(snapOf(mk())) })
  const live = mk()
  const labels = (b: RecoveryBanner) => b.buttons.map((x) => x.label).join(' · ')

  const o = recoveryBanner(snapAt(LIVE_MS - HOUR), live)
  ok(o.older && o.text === OLDER, `an older snapshot: the banner warns ("${o.text}")`)
  ok(labels(o) === 'Keep the file · Restore anyway', `…offering "Keep the file" then "Restore anyway" (${labels(o)})`)
  const prim = o.buttons.filter((b) => b.primary)
  ok(prim.length === 1 && prim[0].action === 'keep', `…with "Keep the file" the ONE default (${prim.map((b) => b.label).join(', ') || 'none'})`)
  const foc = o.buttons.filter((b) => b.focus)
  ok(foc.length === 1 && foc[0].action === 'keep', `…and "Keep the file" the ONE button that takes focus, as in slides (${foc.map((b) => b.label).join(', ') || 'none'})`)
  ok(o.buttons.find((b) => b.label === 'Restore anyway')?.action === 'restore', '…and "Restore anyway" still restores: the older snapshot is never hidden')
  ok(!o.buttons.some((b) => b.action === 'discard'), '…and nothing on it deletes the snapshot (a skewed clock must never cost work)')
  {
    // through the real restore: "Restore anyway" installs the snapshot's text
    const s = new Store(mk())
    const old = snapOf(mk()); old.pages[0].blocks[0].html = 'from the crash'
    ok(recoverInto(s, { json: J(old), at: LIVE_MS - HOUR }) && text(s.doc) === 'from the crash', '"Restore anyway" → recoverInto installs the older snapshot')
  }

  for (const [at, what] of [[LIVE_MS + HOUR, 'a newer'], [LIVE_MS, 'an equal-time']] as const) {
    const b = recoveryBanner(snapAt(at), live)
    ok(!b.older && b.text === PLAIN, `${what} snapshot: the plain banner ("${b.text}")`)
    ok(!/newer|older|safe/i.test(b.text + ' ' + labels(b)), `…claiming nothing about newer, older or safe (${labels(b)})`)
    ok(labels(b) === 'Restore · Discard', `…with spaces' own buttons, Restore then Discard (${labels(b)})`)
    // slides' default (lead ruling 2026-10-16): Restore is the one primary
    const bp = b.buttons.filter((x) => x.primary)
    ok(bp.length === 1 && bp[0].action === 'restore' && !b.buttons.find((x) => x.action === 'discard')?.primary,
      `…Restore is the ONE default, Discard is not (${bp.map((x) => x.label).join(', ') || 'none'})`)
    // …but, as in slides, nothing on the plain banner takes focus
    ok(!b.buttons.some((x) => x.focus), `…and no button takes focus, as in slides (${b.buttons.filter((x) => x.focus).map((x) => x.label).join(', ') || 'none'})`)
  }
  // #705's rule: unknown either side says nothing
  const noMod = mk(); delete (noMod as Obj).modified
  const nm = recoveryBanner(snapAt(LIVE_MS - 1000 * HOUR), noMod)
  ok(!nm.older && nm.text === PLAIN, 'a file with no `modified`: no warning, the plain banner (kernel: unknown → false)')
  const badMod = recoveryBanner(snapAt(LIVE_MS - HOUR), mk({ modified: 'not a date' }))
  ok(!badMod.older && badMod.text === PLAIN, 'an unreadable `modified`: no warning either')
}
{
  // the notice, fired by the REAL kernel: a host whose per-document store
  // refuses the recovery copy (docstore.ts), as bento/home does when too large
  const said: string[] = []
  let docId = 'space-off', encrypted = false
  const refusing: DocStore = {
    async get() { return null },
    async set() { return 'refused' as const },
    async list() { return [] },
    async delete() { return true },
  }
  resetDocStoreForTest(refusing)
  const off = wireRecoveryOff({ docId: () => docId, encrypted: () => encrypted, say: (m) => said.push(m) })
  const NOTICE = 'Crash recovery is off for this space — it’s too large to keep a backup copy. Save often.'
  const kdoc = (id: string) => ({ ...snapOf(mk()), docId: id }) as unknown as Parameters<typeof putRecovery>[0]
  await putRecovery(kdoc('space-off'))
  ok(said.length === 1 && said[0] === NOTICE, `a refused recovery copy: the notice, in the save status ("${said[0] ?? ''}")`)
  ok(recoveryOff('space-off'), '…and the kernel agrees recovery is off for the space')
  await putRecovery(kdoc('space-off'))
  ok(said.length === 1, `…said ONCE: the next autosave stays quiet (${said.length})`)
  await putRecovery(kdoc('space-other'))
  ok(said.length === 1, `another space's refusal says nothing here (${said.length})`)
  off()
  resetDocStoreForTest(null)

  // the app's own guard, fired twice for the same space (the kernel fires once,
  // so this is what holds if it ever fires again)
  type Fn = (id: string, reason: string) => void
  const fns: Fn[] = []
  const sub = (fn: Fn) => { fns.push(fn); return () => {} }
  const twice: string[] = []
  docId = 'space-twice'
  wireRecoveryOff({ docId: () => docId, encrypted: () => encrypted, say: (m) => twice.push(m), subscribe: sub })
  ok(fns.length === 1, 'the notice registers a listener')
  fns.forEach((f) => f('space-twice', 'r')); fns.forEach((f) => f('space-twice', 'r'))
  ok(twice.length === 1, `fired twice for one space: said once (${twice.length})`)
  fns.forEach((f) => f('space-elsewhere', 'r'))
  ok(twice.length === 1, 'fired for another docId: nothing')
  const enc: string[] = []
  const fns2: Fn[] = []
  encrypted = true; docId = 'space-enc'
  wireRecoveryOff({ docId: () => docId, encrypted: () => encrypted, say: (m) => enc.push(m), subscribe: (fn: Fn) => { fns2.push(fn); return () => {} } })
  fns2.forEach((f) => f('space-enc', 'r'))
  ok(enc.length === 0, 'an encrypted space: nothing (it was never snapshotted)')

  const main = readFileSync(join(process.cwd(), 'spaces/src/main.ts'), 'utf8')
  ok(/wireRecoveryOff\(\{\s*docId: \(\) => store\.doc\.docId,\s*encrypted: isBodySealed,\s*say: \(msg\) => editor\.status\(msg, 8000\),?\s*\}\)/.test(main),
    'main.ts registers the notice for the open space, seal-aware (isBodySealed), in the save status for 8s')
  ok(/const spec = recoveryBanner\(snap, store\.doc\)[\s\S]{0,1200}?banner\(spec\.text, spec\.buttons\.map\(\(b\) => \[b\.label, run\[b\.action\], b\.primary, b\.focus\]\)\)/.test(main),
    'the recovery banner shows what recoveryBanner says, primary and focus and all')
  ok(/keep: \(\) => \{\}/.test(main), '"Keep the file" deletes nothing')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
