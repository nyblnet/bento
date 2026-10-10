#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Field-classification rig.
//
//   node scripts/test-field-class.ts     (Node >= 23.6 strips types natively)
//
// WHAT THIS PROVES. projectForCopy builds every outward copy FROM EMPTY using
// only the typed rule tables (docfields.ts CLASS_RULES + MODE_FIELD_RULES), so a
// field is carried only if a cell says so and an UNCLASSIFIED field fails CLOSED
// (dropped from every outward copy — the writerPriv lesson). It sets one field of
// every class per tier and asserts the EXACT top-level field set each tier emits,
// plus the two load-bearing rows (a reader copy is read-only; a template copy
// stays a template) and the unknown-key rule (kept only in the file + duplicate,
// dropped from invite too).
//
// Mutations (verified by editing kernel/src/docfields.ts and re-running; each
// reds a named row, listed in the PR): reclassify readonly as capability (a
// read-only copy comes out editable); drop reader's readonly set:true cell; make
// any cell default to 'keep'; keep an unknown key in an invite. The TYPE half
// (no default cell; 'per-field' only in the mode row; a mode field with no rule)
// is pinned by kernel/src/docfields.typecheck.ts, checked by CI's standalone
// kernel tsc.

import {
  projectForCopy, docContentKey, validateRevision, TIERS,
  type FieldClass, type Tier,
} from '../kernel/src/docfields.ts'

let checks = 0, failures = 0
function ok(cond: boolean, msg: string): void {
  checks++
  if (cond) { console.log(`  ok    ${msg}`); return }
  failures++
  console.log(`  FAIL  ${msg}`)
}
const keysOf = (o: object) => Object.keys(o).sort()
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

// A live document with exactly one representative field per class, plus an
// UNCLASSIFIED ("mystery") key and the two volatile bookkeeping fields.
function liveDoc() {
  return {
    docId: 'D-1',                                   // identity
    title: 'Secret plan', slides: ['a', 'b'],       // content
    collab: {                                        // capability
      room: 'w123', key: 'K', owner: 'O', writerPub: 'WP', on: true, v: 2,
      ownerPriv: 'OWNER-SECRET', writerPriv: 'WRITER-SECRET', sync: { s: 1 },
      invite: { role: 'writer' }, role: 'writer',
    },
    readonly: false, template: false,               // mode
    revisions: [{ id: 'r1', at: 't', body: {} }], trail: [{ day: 1 }], // history
    modified: 123, preview: 'PNG', autosave: 'snap', // content, but NOT_EDIT
    mystery: 'FROM-A-NEWER-BUILD',                   // UNCLASSIFIED (absent from the map)
  }
}
const MAP: Record<string, FieldClass> = {
  docId: 'identity',
  title: 'content', slides: 'content', modified: 'content', preview: 'content', autosave: 'content',
  collab: 'capability',
  readonly: 'mode', template: 'mode',
  revisions: 'history', trail: 'history',
  // `mystery` deliberately unmapped.
}
const OPTS = { invite: { role: 'editor' }, projectAudience: (c: Record<string, unknown>) => ({ room: c.room, key: c.key, role: 'audience' }) }

// The EXACT top-level field set every tier must emit from liveDoc().
const EXPECT: Record<Tier, string[]> = {
  // everything, including the unknown key — the owner's own round-trip
  file: ['docId', 'title', 'slides', 'collab', 'readonly', 'template', 'revisions', 'trail', 'modified', 'preview', 'autosave', 'mystery'].sort(),
  // owner's own copy, new identity: docId + collab reset (absent), mystery kept
  duplicate: ['title', 'slides', 'readonly', 'template', 'revisions', 'trail', 'modified', 'preview', 'autosave', 'mystery'].sort(),
  // a file for another editor: collab projected, readonly AND template dropped
  // (template:true would make the invitee's open a roomless new doc), history kept, unknown dropped
  invite: ['docId', 'title', 'slides', 'collab', 'revisions', 'trail', 'modified', 'preview', 'autosave'].sort(),
  // read-only live viewer: readonly forced true, template dropped (would fork on open),
  // collab reader-projected, history dropped, unknown dropped
  reader: ['docId', 'title', 'slides', 'collab', 'readonly', 'modified', 'preview', 'autosave'].sort(),
  audience: ['docId', 'title', 'slides', 'collab', 'readonly', 'modified', 'preview', 'autosave'].sort(),
  // presentation package / player: collab dropped entirely, template dropped
  package: ['docId', 'title', 'slides', 'readonly', 'modified', 'preview', 'autosave'].sort(),
  // published link: reader-like
  link: ['docId', 'title', 'slides', 'collab', 'readonly', 'modified', 'preview', 'autosave'].sort(),
  // template copy: template forced true, readonly DROPPED (instances must be editable),
  // collab dropped, history dropped
  template: ['docId', 'title', 'slides', 'template', 'modified', 'preview', 'autosave'].sort(),
  // Copy document JSON: content only — collab, modes, history, unknown all gone
  copyJSON: ['docId', 'title', 'slides', 'modified', 'preview', 'autosave'].sort(),
}

console.log('projectForCopy emits exactly the ruled field set per tier')
for (const tier of TIERS) {
  const out = projectForCopy(liveDoc(), MAP, tier, OPTS)
  ok(same(keysOf(out), EXPECT[tier]), `${tier}: ${keysOf(out).join(',') || '(empty)'}`)
}

console.log('\nthe two load-bearing mode rows')
{
  const reader = projectForCopy(liveDoc(), MAP, 'reader', OPTS) as Record<string, unknown>
  ok(reader.readonly === true, 'a READER copy is read-only — readonly forced true even though the live value is false')
  const tpl = projectForCopy(liveDoc(), MAP, 'template', OPTS) as Record<string, unknown>
  ok(tpl.template === true, 'a TEMPLATE copy stays a template — template forced true')
  // the source here is read-only: a template carrying readonly would make every instance read-only
  const roSrc = { ...liveDoc(), readonly: true }
  const tplRo = projectForCopy(roSrc, MAP, 'template', OPTS) as Record<string, unknown>
  ok(!('readonly' in tplRo), 'a template copy of a READ-ONLY doc drops readonly, so instances open editable')
  const inv = projectForCopy(liveDoc(), MAP, 'invite', OPTS) as Record<string, unknown>
  ok(!('readonly' in inv), 'an INVITE copy drops readonly (absent), so the editor is not locked')
}

console.log('\ntemplate:true never rides a copy that must stay in its room')
{
  // parseDoc treats template:true as "this open IS a new document" (fresh docId,
  // collab deleted). A source that IS a template is the case that would fork.
  const tplSrc = { ...liveDoc(), template: true }
  for (const tier of ['invite', 'reader', 'audience', 'package', 'link'] as Tier[]) {
    const out = projectForCopy(tplSrc, MAP, tier, OPTS) as Record<string, unknown>
    ok(!('template' in out), `${tier} copy of a template drops template — it keeps its room instead of forking on open`)
  }
  for (const tier of ['file', 'duplicate'] as Tier[]) {
    const out = projectForCopy(tplSrc, MAP, tier, OPTS) as Record<string, unknown>
    ok(out.template === true, `${tier} keeps the source template flag (the owner's own round-trip)`)
  }
}

console.log('\ncapability is the only stripped class; secrets never ride a projected copy')
{
  const reader = projectForCopy(liveDoc(), MAP, 'reader', OPTS) as { collab: Record<string, unknown> }
  ok(!!reader.collab && reader.collab.ownerPriv === undefined && reader.collab.writerPriv === undefined,
    'reader.collab carries no ownerPriv/writerPriv')
  ok(reader.collab.role === 'reader', 'reader.collab.role is forced to reader (never the source writer role)')
  ok(reader.collab.sync === undefined, 'reader.collab drops the CRDT sync stamp')
  const dup = projectForCopy(liveDoc(), MAP, 'duplicate', OPTS) as Record<string, unknown>
  ok(!('collab' in dup) && !('docId' in dup), 'a duplicate resets identity+capability (docId and collab both omitted, re-minted at load)')
}

console.log('\nthe unknown-key rule: file + duplicate only')
{
  for (const tier of TIERS) {
    const out = projectForCopy(liveDoc(), MAP, tier, OPTS) as Record<string, unknown>
    const kept = 'mystery' in out
    const shouldKeep = tier === 'file' || tier === 'duplicate'
    ok(kept === shouldKeep, `unknown key ${shouldKeep ? 'kept in' : 'dropped from'} ${tier}`)
  }
}

console.log('\nprojectForCopy builds from empty — nothing is invented except a tier\'s {set} mode cell')
{
  const bare = { docId: 'D', title: 'only' }
  const out = projectForCopy(bare, MAP, 'reader', OPTS)
  ok(same(keysOf(out), ['docId', 'readonly', 'title']),
    'only the present fields appear, plus readonly (the reader tier sets it) — no collab fabricated')
}

console.log('\na {set} mode cell fires even when the SOURCE has no such field')
{
  // Most real documents carry neither readonly nor template. The set cells are
  // a property of the tier, so they must not depend on the source having the
  // key — a doc with no readonly must still yield a READ-ONLY reader copy.
  const noModes = () => { const d = liveDoc() as Record<string, unknown>; delete d.readonly; delete d.template; return d }
  for (const tier of ['reader', 'audience', 'package', 'link'] as Tier[]) {
    const out = projectForCopy(noModes(), MAP, tier, OPTS) as Record<string, unknown>
    ok(out.readonly === true, `${tier} copy of a doc with NO readonly key is still read-only`)
    ok(!('template' in out), `${tier} copy invents no template`)
  }
  const tpl = projectForCopy(noModes(), MAP, 'template', OPTS) as Record<string, unknown>
  ok(tpl.template === true, 'template copy of a doc with NO template key is still a template')
  ok(!('readonly' in tpl), 'and invents no readonly')
  for (const tier of ['file', 'duplicate', 'invite', 'copyJSON'] as Tier[]) {
    const out = projectForCopy(noModes(), MAP, tier, OPTS) as Record<string, unknown>
    ok(!('readonly' in out) && !('template' in out), `${tier} invents no mode field (no set cell there)`)
  }
}

console.log('\ndocContentKey: counts content + history, excludes capability + bookkeeping, skips absent')
{
  const base = liveDoc()
  const k1 = docContentKey(base, MAP)
  ok(!k1.includes('OWNER-SECRET') && !k1.includes('writerPriv'), 'capability (collab) is excluded — editing a key is not a content edit')
  ok(!k1.includes('"modified"') && !k1.includes('"preview"') && !k1.includes('"autosave"'), 'bookkeeping (modified/preview/autosave) excluded')
  ok(k1.includes('revisions') && k1.includes('trail'), 'history counts as unsaved work (so recovery keeps it) — the signature/comment loss class')
  // editing content changes the key; touching only a bookkeeping field does not
  const edited = liveDoc(); edited.title = 'changed'
  ok(docContentKey(edited, MAP) !== k1, 'a title edit changes the key')
  const touched = liveDoc(); touched.modified = 999
  ok(docContentKey(touched, MAP) === k1, 'bumping modified alone does not change the key')
  // an ABSENT field never changes the key (older build stays byte-identical)
  const withExtra = liveDoc() as Record<string, unknown>; withExtra.newField = undefined
  ok(docContentKey(withExtra, MAP) === k1, 'an undefined field is skipped, never null-padded — an older build keys identically')
}

console.log('\nvalidateRevision: envelope only, body opaque')
{
  ok(validateRevision({ id: '1', at: 't', body: { anything: true } }), 'id+at+body ok (label optional)')
  ok(validateRevision({ id: '1', at: 't', label: 'typed', body: [] }), 'label allowed when a string')
  ok(!validateRevision({ id: '1', at: 't' }), 'missing body rejected')
  ok(!validateRevision({ id: 1, at: 't', body: {} }), 'non-string id rejected')
  ok(!validateRevision({ id: '1', at: 't', label: 7, body: {} }), 'non-string label rejected')
  ok(!validateRevision(null), 'null rejected (no crash on a malformed entry)')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
