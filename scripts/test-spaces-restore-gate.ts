#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A space kept in this browser is gated before it replaces the open one.
//
//   node scripts/test-spaces.mjs restore-gate
//
// (Bundled: store.ts imports './model' extensionless — the runner does what CI
// does. Run from the repo root; the last section reads main.ts and about.ts.)
//
// WHAT THIS PROVES. The recovery banner's snapshot and every History entry
// live in IndexedDB under the space's docId — and on file:// that store is
// shared by every local document. Restore used to JSON.parse the stored text
// straight into store.replaceDoc. Now (spaces/src/restoregate.ts, like slides'
// restoregate.ts):
//   1. an entry that names another space is refused, whatever key it sits under;
//   2. an entry never brings identity or capability (collab, readonly,
//      template, docId) — the open space's survive;
//   3. hostile html in blocks comes out through sanitizeInline, the gate an
//      arriving file's blocks pass on import;
//   4. non-JSON, another format, a frozen (newer) document, a `__proto__` key
//      and an oversized entry are refused, and nothing is applied;
//   5. a refused entry never raises the recovery banner;
//   6. an honest recovery and an honest version restore still work, unknown
//      fields included (the spaces format is additive);
//   7. both restore paths in the app go through the gate.
//
// Rows 1–5 drive a real Store through restoreInto, so bypassing the gate
// (raw JSON → replaceDoc) turns them red.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../spaces/src/store.ts'
import { parseDoc, docContentKey, FORMAT, type SpacesDoc } from '../spaces/src/model.ts'
import { gateRestored, recoveryOffered, restoreInto, MAX_RESTORE_CHARS } from '../spaces/src/restoregate.ts'
import { sanitizeInline } from '../spaces/src/sanitize.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const LIVE_COLLAB = { v: 2, room: 'wLIVEROOM', key: 'live-key', on: true }

/** Space A, as it is open — with a live session. */
function liveA(): SpacesDoc {
  const r = parseDoc(JSON.stringify({
    format: FORMAT, version: 1, docId: 'space-A', title: 'A', home: 'pa',
    theme: { background: '#fff', color: '#1E2A3A', accent: '#F7A600', measure: 720 },
    pages: [
      { id: 'pa', title: 'Home', blocks: [{ id: 'b1', type: 'p', html: 'written in A' }] },
      { id: 'pb', title: 'Notes', parent: 'pa', blocks: [
        { id: 'b2', type: 'h2', html: 'Heading' },
        { id: 'b3', type: 'code', html: 'if (a &lt; b) return', lang: 'js' },
      ] },
    ],
    collab: LIVE_COLLAB,
  }))
  if (!r.ok) throw new Error('fixture did not parse')
  return r.doc
}
/** What autosave writes: the document minus collab (kernel contentOnly). */
const snapshotOf = (doc: SpacesDoc): Record<string, any> => {
  const { collab: _c, ...rest } = clone(doc) as SpacesDoc & { collab?: unknown }
  void _c
  return rest
}
/** A snapshot of A with its first block rewritten — an edit after the save. */
const editedA = (text = 'edited after the save'): Record<string, any> => {
  const s = snapshotOf(liveA())
  s.pages[0].blocks[0].html = text
  return s
}
const first = (s: Store) => String((s.doc.pages as SpacesDoc['pages'] | undefined)?.[0]?.blocks?.[0]?.html ?? '')
/** A restore that THROWS was not refused cleanly — the app would have applied
 *  whatever it got to before the throw — so it counts as "went through". */
const restore = (s: Store, json: unknown): boolean => { try { return restoreInto(s, json) } catch { return true } }
const offered = (json: unknown, live: SpacesDoc): boolean => { try { return recoveryOffered(json, live) } catch { return true } }

console.log('bento/spaces restore gate\n')

console.log('cross-docId forgery\n')
{
  // space B's content, filed under A's key (getRecovery/listVersions only look
  // at the KEY), still naming B
  const b = editedA('B wrote this'); b.docId = 'space-B'
  const s = new Store(liveA())
  ok(!restore(s, JSON.stringify(b)), 'an entry naming another space is refused')
  ok(first(s) === 'written in A' && s.doc.docId === 'space-A', 'and none of its content is applied')
  ok(!s.canUndo, 'nothing was applied, so there is nothing to undo')
  ok(!offered(JSON.stringify(b), liveA()), 'it never raises the recovery banner')
}
{
  const b = editedA('no id at all'); delete b.docId
  const s = new Store(liveA())
  ok(!restore(s, JSON.stringify(b)), 'an entry with no docId is refused (parseDoc would mint one)')
  ok(first(s) === 'written in A', 'and its content is not applied')
}
{
  // the check runs against the space as it is NOW: duplicated under a new
  // docId since the entry was listed, the entry is somebody else's
  const s = new Store(liveA())
  s.doc.docId = 'space-A-copy'
  ok(!restore(s, JSON.stringify(editedA())), 'an entry from before "Duplicate as a new space" is refused in the copy')
}

console.log('\nidentity and capability stay the open space\'s\n')
{
  const snap = editedA()
  snap.collab = { v: 2, room: 'wATTACKER', key: 'attacker-key', on: true }
  snap.readonly = true
  snap.template = true
  const s = new Store(liveA())
  ok(restore(s, JSON.stringify(snap)), 'an entry carrying collab/readonly/template still restores its content')
  ok(first(s) === 'edited after the save', 'the content is the entry\'s')
  ok(JSON.stringify(s.doc.collab) === JSON.stringify(LIVE_COLLAB), 'collab is the open space\'s room and key')
  ok(s.doc.readonly === undefined, 'a forged readonly does not survive')
  ok(s.doc.template === undefined, 'a forged template does not survive (it would re-mint docId on every open)')
  ok(s.doc.docId === 'space-A', 'docId is the open space\'s')
}
{
  const noCollab = liveA(); delete noCollab.collab
  const snap = editedA(); snap.collab = { v: 2, room: 'wATTACKER', key: 'k', on: true }
  const g = gateRestored(JSON.stringify(snap), noCollab)
  ok(g.ok && g.doc.collab === undefined, 'a space with no live session does not gain one from an entry')
}

console.log('\nhostile html is sanitized, as an arriving file\'s blocks are\n')
{
  const hostile = '<img src=x onerror="alert(1)">hi<script>alert(2)</script><a href="javascript:alert(3)">x</a>'
  const snap = editedA(hostile)
  const s = new Store(liveA())
  ok(restore(s, JSON.stringify(snap)), 'an entry with hostile html restores')
  const html = first(s)
  ok(html === sanitizeInline(hostile), 'its block html is exactly what sanitizeInline makes of it')
  ok(!/onerror|<script|<img|javascript:/i.test(html), `no handler, script, image or javascript: url survives (${JSON.stringify(html)})`)
}

console.log('\nnot a restorable document → refused, nothing applied\n')
{
  const cases: Array<[string, string]> = [
    ['unparseable text', 'not json {'],
    ['a JSON array', '[]'],
    ['another format', JSON.stringify({ ...editedA(), format: 'bento/slides' })],
    ['no pages array', JSON.stringify({ ...editedA(), pages: 'x' })],
    ['a newer version this build would open frozen', JSON.stringify({ ...editedA(), version: 999 })],
    ['an unknown policy this build would open frozen', JSON.stringify({ ...editedA(), policy: 'bento-spaces-9' })],
  ]
  for (const [what, json] of cases) {
    const s = new Store(liveA())
    ok(!restore(s, json) && first(s) === 'written in A', what)
  }
  {
    // a __proto__ key, top level and nested: JSON.parse makes it an own
    // property, and the next merge that treats it as the setter pollutes
    const top = JSON.stringify(editedA()).replace(/^\{/, '{"__proto__":{"polluted":true},')
    const nested = JSON.stringify(editedA()).replace('"blocks":[{', '"blocks":[{"__proto__":{"polluted":true},')
    for (const [what, json] of [['a top-level __proto__ key', top], ['a nested __proto__ key', nested]] as const) {
      const s = new Store(liveA())
      ok(!restore(s, json) && first(s) === 'written in A', what)
    }
    ok(({} as Record<string, unknown>).polluted === undefined, 'Object.prototype is untouched')
  }
  {
    const big = editedA('x'.repeat(MAX_RESTORE_CHARS))
    const s = new Store(liveA())
    ok(!restore(s, JSON.stringify(big)) && first(s) === 'written in A', `an entry over ${MAX_RESTORE_CHARS / 1024 / 1024} MiB`)
  }
  {
    const s = new Store(liveA())
    ok(!restore(s, 42 as unknown as string), 'a non-string entry')
  }
  {
    const s = new Store(liveA()); s.readOnly = true
    ok(!restore(s, JSON.stringify(editedA())) && first(s) === 'written in A', 'a read-only store is never rewritten')
  }
}

console.log('\nthe recovery banner\n')
ok(offered(JSON.stringify(editedA()), liveA()), 'an honest snapshot with lost edits raises it')
ok(!offered(JSON.stringify(snapshotOf(liveA())), liveA()), 'a snapshot identical to the file does not')
ok(!offered('garbage', liveA()), 'junk does not')
ok(!offered(JSON.stringify({ ...snapshotOf(liveA()), collab: { room: 'wX' }, readonly: true }), liveA()),
  'an entry that differs only in identity it cannot bring does not')

console.log('\nthe controls: honest restores still work\n')
{
  // recovery: an edit lost in a crash, plus a field this build does not know
  const snap = editedA(); snap.futureField = { kept: true }; snap.pages[1].futurePageField = 7
  const s = new Store(liveA())
  ok(restore(s, JSON.stringify(snap)), 'an honest recovery snapshot restores')
  ok(first(s) === 'edited after the save', 'with its edit')
  ok((s.doc as Record<string, any>).futureField?.kept === true && (s.doc.pages[1] as Record<string, any>).futurePageField === 7,
    'and unknown fields survive, as a file open keeps them')
  ok(s.doc.pages[1].blocks[1].html === 'if (a &lt; b) return', 'a code block\'s escaped text is untouched')
  s.undo()
  ok(first(s) === 'written in A', 'and ⌘Z walks it back')
}
{
  // version restore: an older version of the same space
  const live = liveA()
  const older = snapshotOf(live); older.title = 'A, an hour ago'; older.pages.pop()
  const s = new Store(live)
  ok(restore(s, JSON.stringify(older)), 'an honest version restores')
  ok(s.doc.title === 'A, an hour ago' && s.doc.pages.length === 1, 'with its content')
  ok(JSON.stringify(s.doc.collab) === JSON.stringify(LIVE_COLLAB), 'and the live session it is restored into')
}
{
  const live = liveA()
  const g = gateRestored(JSON.stringify(snapshotOf(live)), live)
  ok(g.ok && docContentKey(g.doc) === docContentKey(live) && JSON.stringify(g.doc) === JSON.stringify(live),
    'an honest snapshot of the open space comes back byte-identical')
}

console.log('\nevery restore path uses the gate\n')
{
  const root = process.cwd()
  const main = readFileSync(join(root, 'spaces/src/main.ts'), 'utf8')
  // History lives under Save ▾ (doccmds.ts, which reaches the store as h.store)
  // since the bar-parity move; About is read too so neither file can regress.
  const about = readFileSync(join(root, 'spaces/src/about.ts'), 'utf8') +
    readFileSync(join(root, 'spaces/src/doccmds.ts'), 'utf8')
  const offer = main.slice(main.indexOf('async function offerRecovery('), main.indexOf('async function offerRecovery(') + 1400)
  ok(/recoveryOffered\(snap\.json, doc\)/.test(offer), 'the recovery check gates before offering')
  ok(/restoreInto\(store, snap\.json\)/.test(offer), 'the banner\'s Restore goes through restoreInto')
  ok(/restoreInto\((h\.)?store, v\.json\)/.test(about), 'History\'s Restore goes through restoreInto')
  ok(!/JSON\.parse\((snap|v)\.json\)/.test(main + about), 'no raw JSON.parse of a stored entry remains')
  // the in-file timeline (history.ts) is the document's own, but what it
  // applies is still parsed, sanitized and given the live identity
  const fileHist = about.slice(about.indexOf('function openFileHistory('), about.indexOf('function summary('))
  ok(/restoreInto\(h\.store, JSON\.stringify\(next\)\)/.test(fileHist) && !/replaceDoc\(/.test(fileHist),
    'Versions in this file restores through restoreInto, never a bare replaceDoc')
}

console.log('\na design is content, not identity\n')
{
  // `design` / `designs` (spaces/src/designs.ts) are NOT on FROM_LIVE: a
  // restore brings the snapshot's design back, and a snapshot that differs
  // only by its design still raises the recovery banner.
  const { FROM_LIVE } = await import('../kernel/src/docfields.ts')
  const fl = FROM_LIVE as readonly string[]
  ok(!fl.includes('design') && !fl.includes('designs'), 'design and designs are not on FROM_LIVE')
  const live = liveA()
  const snap = clone(live) as SpacesDoc & { design?: string; designs?: Record<string, unknown> }
  snap.design = 'mine'
  snap.designs = { mine: { base: 'riso', label: 'Mine' } }
  const g = gateRestored(JSON.stringify(snap), live)
  ok(g.ok && (g.doc as typeof snap).design === 'mine' && JSON.stringify((g.doc as typeof snap).designs) === JSON.stringify(snap.designs),
    'the gate passes design and designs through from the snapshot')
  ok(recoveryOffered(JSON.stringify(snap), live), 'a snapshot that differs only by its design is offered for recovery')
  const designedLive = clone(live) as SpacesDoc & { design?: string }
  designedLive.design = 'ledger'
  const g2 = gateRestored(JSON.stringify(clone(live)), designedLive)
  ok(g2.ok && !Object.hasOwn(g2.doc, 'design'), 'restoring a snapshot with no design does not keep the live design (it is content, not identity)')
  // A PAGE's design (per-page designs) is content too: it lives in `pages`,
  // which the gate passes through and the content key already covers
  const paged = clone(live) as SpacesDoc
  ;(paged.pages[0] as { design?: string }).design = 'studio'
  const g3 = gateRestored(JSON.stringify(paged), live)
  ok(g3.ok && (g3.doc.pages[0] as { design?: string }).design === 'studio', 'the gate passes a page\'s own design through from the snapshot')
  ok(recoveryOffered(JSON.stringify(paged), live), 'a snapshot that differs only by one page\'s design is offered for recovery')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
