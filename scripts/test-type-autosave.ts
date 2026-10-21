#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type autosave + crash-recovery rig.  node scripts/test-type-autosave.ts
//
// Storage mechanics (IndexedDB, per-app database naming, legacy migration)
// are already proven by scripts/test-autosave.ts against the shared kernel
// module — this rig does not re-test IndexedDB. What is app-specific, and
// what this pins instead:
//
//   1. docContentKey ignores BOOKKEEPING (modified, preview, autosave) and
//      capability (collab, and the sync state inside it), but counts every
//      piece of work the file on disk could lack — including a signature, a
//      comment and a Snapshot. So the boot-time "is this actually different
//      from what's on disk" check neither nags on every reload nor stays
//      silent when there really is unsaved work. It is NOT canon.ts's
//      signing set: see autosave.ts docContentKey for why those differ.
//   2. canSnapshot() — the encryption guard — refuses the moment the kernel's
//      encryption state goes active, and un-refuses when it clears. This is
//      the one line responsible for "never write plaintext to IndexedDB
//      beside a file whose whole purpose is that it is not legible".
//   3. Restoring a recovered snapshot through store.replace() round-trips
//      the document EXACTLY (byte-for-byte JSON) and lands as ONE undo step
//      — never a silent, un-undoable swap of the document under the author.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { configureApp } from '../kernel/src/app.ts'
import { setEncryptionPassword, setIdentitySeal, isBodySealed } from '../kernel/src/save.ts'
import { docContentKey, canSnapshot, recoveryBanner } from '../type/src/autosave.ts'
import { sign, newKey, verifyAll, sigId, newHistorySalt } from '../type/src/canon.ts'
const one = (d: { docId: string }, x: any) => ({ [sigId(d.docId, x)]: x })
const vals = (m: Record<string, any>) => Object.values(m ?? {})
import { RESTORE_RULES } from '../type/src/restorerules.ts'
import { validateRestoreRules } from '../kernel/src/docfields.ts'
import { emptyDoc, uid, type TypeDoc } from '../type/src/model.ts'
import { Store } from '../type/src/store.ts'
import { gateRestored } from '../type/src/restoregate.ts'

configureApp({ appId: 'bento-type-test', appName: 'bento/type (test)', manifestUrl: 'https://example.invalid/m.json' })

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }
const H = (s: string) => console.log(`\n=== ${s} ===`)

const doc = (): TypeDoc => {
  const d = emptyDoc()
  d.title = 'Master Services Agreement'
  d.body = [{ id: uid(), kind: 'para', text: 'Payment is due within 30 days.' }]
  d.historySalt = newHistorySalt()          // v2 signing commits to the history under it (canon.ts)
  return d
}

H('docContentKey ignores bookkeeping, which churns without any work done')
{
  const a = doc()
  const b: TypeDoc = JSON.parse(JSON.stringify(a))
  // A save stamps `modified`, a sync round-trip rewrites collab's state, and
  // neither is anything the author would want offered back on reload.
  a.modified = '2026-01-01T00:00:00.000Z'
  b.modified = '2099-12-31T23:59:59.000Z'
  ;(a as any).collab = { room: 'r1', key: 'k1' }
  ;(b as any).collab = { room: 'r2', key: 'k2', sync: { v: 1 } }
  ;(a as any).preview = '<div>old</div>'
  ;(b as any).preview = '<div>new</div>'
  ok(docContentKey(a) === docContentKey(b),
    'modified/collab/preview differ but the content key agrees')

  const c = doc()
  c.body[0].text = 'Payment is due within 45 days.'
  ok(docContentKey(a) !== docContentKey(c),
    'an actual edit to body text changes the content key')

  const d2 = doc()
  d2.title = 'A Different Title'
  ok(docContentKey(a) !== docContentKey(d2),
    'a title change changes the content key too — title is real content, not chrome')
}

H('docContentKey is stable across independent JSON round-trips')
{
  const a = doc()
  const roundTripped: TypeDoc = JSON.parse(JSON.stringify(a))
  ok(docContentKey(a) === docContentKey(roundTripped),
    'serializing and re-parsing an unedited document keeps the same key (no false "unsaved changes" banner on a clean reload)')
}

H('canSnapshot refuses while encryption is active')
{
  ok(canSnapshot(), 'snapshots are allowed with no password set (the common case today)')
  setEncryptionPassword('correct horse battery staple')
  ok(!canSnapshot(), 'encryption active — canSnapshot refuses, so runAutosave never reaches putRecovery')
  setEncryptionPassword(null)
  ok(canSnapshot(), 'clearing the password restores snapshotting')
  setIdentitySeal(new Uint8Array(32).fill(7))
  ok(isBodySealed() && !canSnapshot(), 'an identity-sealed body (no password) — canSnapshot refuses too')
  setIdentitySeal(null)
  ok(canSnapshot(), 'clearing the seal restores snapshotting')
}

H('restoring a recovered snapshot round-trips the document exactly')
{
  const original = doc()
  original.footnotes[uid('n')] = 'A footnote, so nested content round-trips too.'
  original.body[0].marks = [{ t: 'b', from: 0, to: 7 }]

  // This is exactly what checkRecovery does: JSON.stringify into a Snapshot,
  // JSON.parse back out, and hand the result to store.replace().
  const snapshotJson = JSON.stringify(original)
  const recovered: TypeDoc = JSON.parse(snapshotJson)
  ok(docContentKey(recovered) === docContentKey(original),
    'the round-tripped snapshot has the same content key as the original')

  const openDoc = doc()
  openDoc.body[0].text = 'A different document, currently open in the editor.'
  const store = new Store(openDoc) // a DIFFERENT doc is "currently open"
  const before = store.undoDepth
  store.replace(recovered)
  ok(JSON.stringify(store.doc) === snapshotJson,
    'store.doc after replace() is byte-identical to the snapshot JSON')
  ok(store.doc.body[0].text === original.body[0].text, 'restored body text matches')
  ok(Object.keys(store.doc.footnotes).length === 1, 'restored footnotes survive the round trip')
  ok(store.undoDepth === before + 1, 'replace() pushed exactly one undo step — restore is ONE ⌘Z away from undone')
  ok(store.undo(), 'undo succeeds')
  ok(store.doc.body[0].text === openDoc.body[0].text, 'undo reverts the restore back to what was open before it')
}

H('work the file on disk lacks is unsaved work — even when no text changed')
{
  // This rig USED to assert the opposite for signatures ("re-signing churns
  // these without the author having typed anything"), and so certified the
  // bug: the recovery key reused canon.ts's SIGNING set, a signature is
  // rightly outside what it signs, and that same exclusion made it invisible
  // to recovery. The question here is not "did anyone type?" but "does the
  // snapshot hold work the file lacks?" — and a signature is exactly that.
  const base = doc()
  const signed: TypeDoc = JSON.parse(JSON.stringify(base))
  signed.signatures = { k1: { alg: 'ES256', pub: 'P', name: 'Alice', content: 'C', prev: '', sig: 'S' } as any }
  ok(docContentKey(base) !== docContentKey(signed),
    'a signature added since the last write changes the content key')

  const commented: TypeDoc = JSON.parse(JSON.stringify(base))
  ;(commented as any).comments = { c1: { id: 'c1', text: 'check clause 4', author: 'Bob', at: 'x', replies: [] } }
  ok(docContentKey(base) !== docContentKey(commented),
    'a comment added since the last write changes the content key')

  const snapped: TypeDoc = JSON.parse(JSON.stringify(base))
  snapped.revisions = [{ id: 'rev1', at: 'x', label: 'Revision 1', body: JSON.parse(JSON.stringify(base.body)) }]
  ok(docContentKey(base) !== docContentKey(snapped),
    'a Snapshot taken since the last write changes the content key')
}

H('THE CRASH CASE: sign, crash before the file is written, reload')
{
  // Through the real decision path checkRecovery takes — gateRestored, then
  // the key comparison — minus IndexedDB, which test-autosave.ts already
  // proves against the kernel. The file on disk is `live`: opened, never
  // re-written. The recovery snapshot is what the crashed session last held.
  const live = doc()
  const snapshot: TypeDoc = JSON.parse(JSON.stringify(live))
  snapshot.modified = '2099-01-01T00:00:00.000Z'
  snapshot.signatures = { k1: { alg: 'ES256', pub: 'P', name: 'Alice', content: 'C', prev: '', sig: 'S' } as any }

  const recovered = gateRestored(JSON.stringify(snapshot), live)
  ok(recovered !== null, 'the snapshot passes the restore gate')
  ok(docContentKey(recovered!) !== docContentKey(live),
    'the Restore banner is OFFERED — the snapshot holds a signature the file lacks')
  ok(vals(recovered!.signatures).length === 1 && vals(recovered!.signatures)[0].name === 'Alice',
    'and restoring it brings the signature back, not just the banner')
  ok(recovered!.docId === live.docId, 'while identity still comes from the live file, never the snapshot')

  // The control: a snapshot that differs only by bookkeeping must NOT nag.
  const churn: TypeDoc = JSON.parse(JSON.stringify(live))
  churn.modified = '2099-01-01T00:00:00.000Z'
  const quiet = gateRestored(JSON.stringify(churn), live)
  ok(quiet !== null && docContentKey(quiet) === docContentKey(live),
    'a snapshot differing only in modified offers nothing — no banner on every reload')
}

H('Save a copy… (a \'copied\' result) must not clear the dot (asserted at source)')
{
  // type's save() is module-level and DOM-bound, so this is pinned at source
  // like the kernel's saveFile ordering. "Save a copy…" returns 'copied'; the
  // open document is still unsaved, so dirty must stay set and paintTitle must
  // not claim "Saved". Mutation: clearing dirty for any non-'cancelled' result
  // (the old `dirty = false`) reds this.
  const src = readFileSync(fileURLToPath(new URL('../type/src/main.ts', import.meta.url)), 'utf8')
  const save = src.slice(src.indexOf('async function save('), src.indexOf('async function save(') + 1200)
  ok(/if \(result === 'cancelled'\) return;/.test(save), 'save() returns early on cancelled')
  ok(/if \(result === 'saved' \|\| result === 'saved-as' \|\| result === 'downloaded'\) dirty = false;/.test(save),
    'save() clears dirty ONLY for saved / saved-as / downloaded — never for a copy')
  ok(!/if \(result === 'cancelled'\) return;\s*dirty = false;/.test(save),
    'and never clears dirty unconditionally after the cancelled guard')
}

H('a recovery snapshot with NO signatures never pairs its revisions with the live signatures')
{
  // Signatures cover content AND revisions, so a restore that took the
  // snapshot's revisions but kept the file's signatures would show signatures
  // over a history they never saw — every one reading "changed". The newer
  // state is genuinely unsigned, so the right outcome is NO signatures.
  //
  // What makes that true in type is parseDoc DEFAULTING an absent `signatures`
  // to [] (model.ts) before any restore logic sees the snapshot. A recovery
  // rule that keeps the live value when a field is ABSENT would otherwise keep
  // the file's signatures. That default is an implementation detail, so this
  // row pins it at type's seam: break it and this goes red.
  //
  // Through the banner's own restore path: gateRestored, then store.replace.
  const live = doc()
  live.revisions = [{ id: 'r1', at: '2026-01-01T00:00:00.000Z', label: 'Revision 1',
                      body: JSON.parse(JSON.stringify(live.body)) }]
  live.signatures = { k1: { alg: 'ES256', pub: 'P', name: 'Bob', content: 'C', prev: '', sig: 'S' } as any }
  ok(vals(live.signatures).length === 1 && vals(live.signatures)[0].name === 'Bob',
    'the FILE really is signed (Bob) — so "no signatures after restore" is a result, not a fixture')

  // The crashed session held a NEWER revision and no signatures at all — and
  // its JSON lacks the key entirely, not just an empty list.
  const newer = JSON.parse(JSON.stringify(live)) as Record<string, unknown>
  ;(newer.revisions as unknown[]).push({ id: 'r2', at: '2026-02-01T00:00:00.000Z', label: 'Revision 2',
                                         body: JSON.parse(JSON.stringify(live.body)) })
  delete newer.signatures
  ok(!('signatures' in newer), 'the snapshot JSON genuinely has no signatures key')

  const gated = gateRestored(JSON.stringify(newer), live)
  ok(gated !== null, 'the snapshot passes the restore gate')
  const store = new Store(live)
  store.replace(gated!)
  ok(store.doc.revisions.length === 2 && store.doc.revisions[1].id === 'r2',
    'the restore takes the snapshot\'s revisions')
  ok(store.doc.signatures !== null && typeof store.doc.signatures === 'object' && vals(store.doc.signatures).length === 0,
    'and NO signatures — the snapshot\'s unsigned state, not an absent field')
  ok(!JSON.stringify(store.doc.signatures ?? {}).includes('Bob'),
    'the file\'s signatures are never paired with the snapshot\'s revisions')
}

// ════════════════════════════════════════════════════════════════════════════
// RESTORE DIRECTIONS (restorerules.ts, kernel applyRestore): undo/redo and a
// version restore go BACK — content follows, history stays live; the recovery
// banner RECOVERS — content and history follow the newer copy together.
const rev = (id: string, text: string) => ({ id, at: '2026-01-01T00:00:00.000Z', label: id, body: [{ id: 'p0', kind: 'para', text }] })

H('a Snapshot is a record, not an edit — and undo can never take one back')
{
  const store = new Store(doc())
  store.commit(d => { d.body[0].text = 'Payment is due within 45 days.' })          // an ordinary edit
  store.commit(d => { d.revisions.push(rev('r1', 'draft')) }, { undoable: false })  // what ⋯ → Snapshot does
  ok(store.doc.revisions.length === 1, 'the Snapshot is recorded')
  ok(store.undo(), 'undo takes back the EDIT')
  ok(store.doc.body[0].text === 'Payment is due within 30 days.', 'the text reverts')
  ok(store.doc.revisions.length === 1 && store.doc.revisions[0].id === 'r1',
    'but the revision SURVIVES — a document-level undo keeps history live')
  ok(!store.undo(), 'and the Snapshot itself is not on the undo stack at all')
  const red = readFileSync(fileURLToPath(new URL('../type/src/redlineview.ts', import.meta.url)), 'utf8')
  const snapFn = red.slice(red.indexOf('export function takeSnapshot'), red.indexOf('export function startReview'))
  ok(/\}, \{ undoable: false \}\);/.test(snapFn), '⋯ → Snapshot really commits with undoable: false')
}

H('comments undo like any edit (comments FOLLOW a restore)')
{
  const store = new Store(doc())
  store.commit(d => { (d as any).comments = { c1: { id: 'c1', text: 'check this', author: 'Bob', at: 'x', replies: [],
                                                     anchor: { block: d.body[0].id, from: 0, to: 4 } } } })
  ok(!!(store.doc as any).comments?.c1, 'a comment is added')
  ok(store.undo() && !(store.doc as any).comments?.c1, 'and undo removes it — history-class for copying, follows for undo')
  ok(store.redo() && !!(store.doc as any).comments?.c1, 'redo brings it back')
}

H('restoring an older VERSION keeps every newer revision (back)')
{
  const store = new Store(doc())
  const older = JSON.parse(JSON.stringify(store.doc)) as TypeDoc       // the version kept earlier
  store.commit(d => { d.body[0].text = 'Payment is due within 60 days.' })
  store.commit(d => { d.revisions.push(rev('r1', 'a')); d.revisions.push(rev('r2', 'b')) }, { undoable: false })
  store.restore(older, 'back')
  ok(store.doc.body[0].text === 'Payment is due within 30 days.', 'the older version\'s content comes back')
  ok(store.doc.revisions.map(r => r.id).join() === 'r1,r2', 'and the revisions made since are KEPT, never discarded')
  ok(store.doc.docId === older.docId, 'identity stays live')
}

H('crash recovery brings content AND history back TOGETHER (recover)')
{
  // The case that motivated the direction split: trim history, re-sign, crash
  // before the file is written. The file still holds the long list; the
  // snapshot holds the trimmed list and the NEW signature over it.
  const k = await newKey()
  const file = doc()
  file.revisions = [rev('r1', 'a'), rev('r2', 'b'), rev('r3', 'c')]
  file.signatures = one(file, await sign(file, k, { name: 'Alice' }))
  const snap = JSON.parse(JSON.stringify(file)) as TypeDoc
  snap.revisions = [rev('r3', 'c')]                                     // trimmed…
  snap.signatures = one(snap, await sign({ ...snap, signatures: {} }, k, { name: 'Alice' }))  // …and re-signed

  const store = new Store(JSON.parse(JSON.stringify(file)))
  const gated = gateRestored(JSON.stringify(snap), store.doc)!
  store.restore(gated, 'recover')
  ok(store.doc.revisions.map(r => r.id).join() === 'r3', 'the TRIMMED list comes back from the snapshot')
  ok(vals(store.doc.signatures).length === 1 && vals(store.doc.signatures)[0].sig === vals(snap.signatures)[0].sig,
    'with the signature made over it — revisions and signatures are never split')
  const v = await verifyAll(store.doc, store.doc.signatures)
  ok(v.ok && v.entries[0].ok, 'so the re-signed signature VERIFIES after recovery')
  ok(store.doc.docId === file.docId, 'identity still comes from the live file')
  ok(store.undo() && store.doc.revisions.map(r => r.id).join() === 'r3',
    'undo of the restore reverts content but keeps history live — going back never discards')
}

H('what was DELETED before the crash stays deleted on Restore (recover, whole snapshot)')
{
  // The recovery snapshot is the WHOLE document as the crashed session held it,
  // so a key it lacks was removed — Restore must not bring it back from the file.
  // Each row asserts the FILE carries the thing first, so "absent after" means
  // the restore removed it, not that it was never there. Through the banner's
  // own path: gateRestored, then store.restore(…, 'recover').
  const recover = (file: TypeDoc, snap: TypeDoc) => {
    const store = new Store(JSON.parse(JSON.stringify(file)))
    const gated = gateRestored(JSON.stringify(snap), store.doc)
    ok(gated !== null, '  (the snapshot passes the restore gate)')
    store.restore(gated!, 'recover')
    return store
  }
  const thread = (block: string) => ({ c1: { id: 'c1', text: 'redact this clause', author: 'Bob', at: '2026-01-01T00:00:00.000Z',
                                            replies: [], anchor: { block, from: 0, to: 7 } } })

  // 1. a deleted comment — history-class, but FOLLOWS a restore (the #722 case)
  {
    const file = doc(); (file as any).comments = thread(file.body[0].id)
    const snap = JSON.parse(JSON.stringify(file)) as TypeDoc; delete (snap as any).comments
    const live = new Store(JSON.parse(JSON.stringify(file)))
    ok(!!(live.doc as any).comments?.c1, 'the file carries the comment')
    const s = recover(file, snap)
    ok(!(s.doc as any).comments?.c1 && !JSON.stringify(s.doc).includes('redact this clause'),
      'a comment deleted before the crash stays deleted')
  }
  // 2. a deleted paragraph
  {
    const file = doc(); file.body.push({ id: uid(), kind: 'para', text: 'Late fees accrue at 5%.' })
    const snap = JSON.parse(JSON.stringify(file)) as TypeDoc; snap.body = [snap.body[0]]
    ok(file.body.length === 2, 'the file carries the second paragraph')
    const s = recover(file, snap)
    ok(s.doc.body.length === 1 && !JSON.stringify(s.doc.body).includes('Late fees'), 'a paragraph deleted before the crash stays deleted')
  }
  // 3. a cleared field
  {
    const file = doc(); file.subtitle = 'DRAFT — privileged'
    const snap = JSON.parse(JSON.stringify(file)) as TypeDoc; delete snap.subtitle
    ok(!('subtitle' in snap), 'the snapshot genuinely lacks the subtitle key')
    const s = recover(file, snap)
    ok(!s.doc.subtitle, 'a field cleared before the crash stays cleared')
  }
  // 4. an emptied list — footnotes present-but-empty, and styles (parseDoc DROPS an empty map)
  {
    const file = doc(); file.footnotes = { f1: 'Per the side letter.' }
    ;(file as any).styles = { quote: { label: 'Quote', italic: true } }
    const snap = JSON.parse(JSON.stringify(file)) as TypeDoc; snap.footnotes = {} as any; delete (snap as any).styles
    const gatedFile = gateRestored(JSON.stringify(file), file)!
    ok(Object.keys(gatedFile.footnotes).length === 1 && !!(gatedFile as any).styles?.quote,
      'the file carries the footnote and the style through parseDoc')
    const s = recover(file, snap)
    ok(Object.keys(s.doc.footnotes).length === 0, 'footnotes emptied before the crash stay empty')
    ok(!(s.doc as any).styles?.quote, 'a style list emptied before the crash stays empty')
  }
  // 5. cleared HISTORY — no path in type empties revisions today; when one does
  // (re-sign-to-trim), a whole snapshot's [] OR missing key must mean cleared.
  // The missing case holds twice over: the kernel removes an absent history
  // field from a whole snapshot (#726), and parseDoc defaults absent revisions
  // to [] (model.ts) before the restore sees them.
  for (const how of ['[]', 'missing'] as const) {
    const file = doc(); file.revisions = [rev('r1', 'negotiated away'), rev('r2', 'b')]
    const snap = JSON.parse(JSON.stringify(file)) as TypeDoc
    if (how === '[]') snap.revisions = []; else delete (snap as any).revisions
    ok(how === '[]' || !('revisions' in snap), `  (the ${how} snapshot genuinely lacks revisions)`)
    const s = recover(file, snap)
    ok(s.doc.revisions.length === 0 && !JSON.stringify(s.doc).includes('negotiated away'),
      `history cleared before the crash stays cleared — snapshot revisions ${how}`)
  }
  // 6. …but the history SALT is the one exception. A snapshot without it was
  // autosaved BEFORE the first Sign (which mints it); a live document never
  // loses its salt. Removing it would orphan every signature made over it.
  {
    const file = doc()                                       // fixture carries a salt
    const stale = JSON.parse(JSON.stringify(file)) as TypeDoc
    delete (stale as any).historySalt                        // …autosaved before the first Sign
    ok(!!file.historySalt && !('historySalt' in stale), '  (the file has a salt, the stale snapshot genuinely lacks one)')
    const s = recover(file, stale)
    ok(s.doc.historySalt === file.historySalt,
      'a snapshot from before the first signature keeps the live history salt — signatures made over it still match')
  }
}

H('restoring an older version of a SIGNED document reports changed, and does not crash')
{
  const k = await newKey()
  const store = new Store(doc())
  const older = JSON.parse(JSON.stringify(store.doc)) as TypeDoc
  store.commit(d => { d.body[0].text = 'Payment is due within 60 days.' })
  const signed = await sign(store.doc, k, { name: 'Alice' })
  store.commit(d => { d.signatures[sigId(d.docId, signed)] = signed })
  store.restore(older, 'back')
  const v = await verifyAll(store.doc, store.doc.signatures)
  ok(v.entries.length === 1 && !v.entries[0].ok,
    'the live signature is kept and honestly reads changed — the content it signed is not what is open')
}

H('the recovery banner: warn and default to keeping the file, never hide (ruling 9)')
{
  const file = doc(); file.modified = '2026-06-01T12:00:00.000Z'
  const older = { docId: file.docId, at: Date.parse('2026-06-01T09:00:00.000Z'), title: '', json: '{}' }
  const newer = { ...older, at: Date.parse('2026-06-01T15:00:00.000Z') }
  ok(recoveryBanner(older, file).older && recoveryBanner(older, file).defaultAction === 'keep',
    'a copy that looks OLDER than the file warns, and keeping the file is the default')
  ok(!recoveryBanner(newer, file).older && recoveryBanner(newer, file).defaultAction === 'restore',
    'a newer-looking copy offers restore as before')
  const unknown = doc(); delete (unknown as any).modified
  ok(!recoveryBanner(older, unknown).older, 'an unknown age raises no warning — and nothing claims it is newer either')
  const src = readFileSync(fileURLToPath(new URL('../type/src/autosave.ts', import.meta.url)), 'utf8')
  ok(src.includes(`t('This recovered copy looks older than the file you opened. Keep the file unless you know it’s newer.')`),
    'the banner uses the ruled wording verbatim')
  ok(src.includes(`t('Keep the file')`) && src.includes(`t('Restore anyway')`), 'with the ruled button labels')
  ok(/ctx\.store\.restore\(gated, 'recover'\)/.test(src), 'and its Restore goes through the RECOVER direction')
  ok(/onRecoveryOff\(docId => \{ if \(docId === ctx\.store\.doc\.docId\) showRecoveryOff\(\); \}\)/.test(src),
    'the recovery-off notice is wired to the kernel\'s signal, for THIS document only')
  ok(src.includes(`t('Crash recovery is off for this document — it’s too large to keep a backup copy. Save often.')`),
    'with the ruled wording verbatim')
  const main = readFileSync(fileURLToPath(new URL('../type/src/main.ts', import.meta.url)), 'utf8')
  ok(/store\.restore\(doc, 'back'\)/.test(main), 'About\'s version restore goes through the BACK direction')
}

H('the restore rules themselves')
{
  for (const dir of ['back', 'recover'] as const) {
    let threw = false; try { validateRestoreRules(RESTORE_RULES[dir]) } catch { threw = true }
    ok(!threw, `the ${dir} rules pass the kernel's floor check at load`)
    ok((RESTORE_RULES[dir].keepLive as Record<string, string>).comments === 'follows', `comments follow a ${dir} restore`)
  }
  ok(Object.keys(RESTORE_RULES.back.keepLive ?? {}).sort().join() === 'comments,signatures', 'back overrides comments and signatures, nothing else')
  ok((RESTORE_RULES.back.keepLive as Record<string, string>).signatures === 'live', 'signatures stay LIVE going back')
  ok(Object.keys(RESTORE_RULES.recover.keepLive ?? {}).join() === 'comments', 'recover overrides comments only — signatures follow the snapshot')
  ok(RESTORE_RULES.recover.wholeSnapshot === true, 'and recover states its snapshot is WHOLE')
  ok(JSON.stringify(RESTORE_RULES.recover.keepLiveWhenAbsent) === '["historySalt"]',
    'the only field whose absence keeps live is historySalt — never revisions, comments or signatures')
}

H('Sign is not undoable (ruling 7)')
{
  const k = await newKey()
  const store = new Store(doc())
  store.commit(d => { d.body[0].text = 'Payment is due within 60 days.' })
  const signed = await sign(store.doc, k, { name: 'Alice' })
  store.commit(d => { d.signatures[sigId(d.docId, signed)] = signed }, { undoable: false })
  ok(store.undo(), 'undo takes back the edit made BEFORE signing')
  ok(vals(store.doc.signatures).length === 1 && vals(store.doc.signatures)[0].sig === signed.sig,
    'and the signature stays — ⌘Z never removes one')
  const main = readFileSync(fileURLToPath(new URL('../type/src/main.ts', import.meta.url)), 'utf8')
  ok(/store\.commit\(d => \{ d\.signatures\[id\] = entry; \}, \{ undoable: false \}\)/.test(main),
    'the Sign button really commits with undoable: false')
  ok(/store\.commit\(d => \{ d\.historySalt = salt; \}, \{ undoable: false \}\)/.test(main),
    'and so does minting the history salt')
}

H('type\'s recovery store is its OWN, never the legacy shared one')
{
  // The kernel names the store `${appId}-autosave`, and copies the legacy
  // shared `bento-autosave` into an EMPTY app store once. An app — or a rig —
  // configured with appId 'bento' would BE the legacy store, and a test that
  // deletes a snapshot could then pass against the wrong database.
  const kernel = readFileSync(fileURLToPath(new URL('../kernel/src/autosave.ts', import.meta.url)), 'utf8')
  ok(/const dbName = \(\) => `\$\{appConfig\(\)\.appId\}-autosave`/.test(kernel), 'the kernel derives the store name from the appId')
  const legacy = /const LEGACY_DB_NAME = '([^']+)'/.exec(kernel)?.[1]
  ok(legacy === 'bento-autosave', 'and the legacy shared store is bento-autosave')
  const main = readFileSync(fileURLToPath(new URL('../type/src/main.ts', import.meta.url)), 'utf8')
  const appId = /configureApp\(\{\s*appId: '([^']+)'/.exec(main)?.[1]
  ok(appId === 'bento-type' && `${appId}-autosave` === 'bento-type-autosave',
    'bento/type writes its recovery copies to bento-type-autosave')
  ok(`${appId}-autosave` !== legacy, 'which is NOT the legacy shared store')
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const rigId = /configureApp\(\{ appId: '([^']+)'/.exec(self)?.[1]
  ok(!!rigId && `${rigId}-autosave` !== legacy, 'and neither does this rig')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
