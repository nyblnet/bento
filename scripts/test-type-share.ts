#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The copies bento/type writes for someone ELSE carry no private key.
//
//   node scripts/test-type-share.ts
//
// WHAT THIS PROVES. "View-only copy…" and "Invite to edit…" (type/src/share.ts)
// write a document for another person. A view-only copy must follow the live
// session and NEVER write; an editor copy must write only through its own
// revocable invite. So neither may carry a private key it was not given:
//   1. a reader copy has NO writerPriv, ownerPriv or invite keypair — whatever
//      the source document held — while keeping the room it follows;
//   2. an editor copy has no writerPriv or ownerPriv, and its invite is a FRESH
//      one, never the source's;
//   3. the default strip removes the whole collab block;
//   4. every copy builder lives in share.ts, and collab.ts builds none inline.
//
// THE FIXTURE IS THE CASE THAT WAS MISSED. bento/type never mints a writer
// key (its rooms are v2, owner-keyed), so a copy of a document type created was
// clean all along. The gap was a document that ARRIVED holding one — an older
// file, a pasted JSON — because parseDoc carries `collab` through verbatim.
// So the source here goes through parseDoc with a legacy writer key on it.

import { register } from 'node:module'
import { readFileSync } from 'node:fs'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { readerCopy, inviteCopy } = await import('../type/src/share.ts')
const { emptyDoc, parseDoc, docForExport } = await import('../type/src/model.ts')
const { mintCollab } = await import('../kernel/src/sync/online.ts')
const { mergeDoc } = await import('../type/src/merge.ts')
const { newThread, writeThreads } = await import('../type/src/comments.ts')
const { sign, newKey, newHistorySalt, verifyAll, sigId } = await import('../type/src/canon.ts')
const { TYPE_FIELDS, HISTORY_CLASS, keepLiveHistory } = await import('../type/src/docclass.ts')
const { Store } = await import('../type/src/store.ts')
import type { TypeDoc } from '../type/src/model.ts'

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }
const read = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')

const SECRETS = ['WRITER-PRIVATE', 'OWNER-PRIVATE', 'INVITE-PRIVATE']
const arrived = (): TypeDoc => {
  const r = parseDoc(JSON.stringify({ ...emptyDoc(), body: [{ id: 'p1', kind: 'para', text: 'terms' }],
    collab: { v: 2, on: true, room: 'w-room', key: 'ROOM-READ-KEY', owner: 'OWNER-PUB', ownerPriv: 'OWNER-PRIVATE',
              writerPub: 'WRITER-PUB', writerPriv: 'WRITER-PRIVATE',
              invite: { pub: 'INV-PUB', priv: 'INVITE-PRIVATE', role: 'writer', sig: 'SIG' } } }))
  if (!r.ok) throw new Error('fixture did not parse')
  return r.doc
}

console.log('\na view-only copy carries no private key\n')
{
  const src = arrived()
  ok((src.collab as { writerPriv?: string }).writerPriv === 'WRITER-PRIVATE',
     'the source really holds a legacy writer key after parseDoc — the case that was missed')
  const r = readerCopy(src)
  const blob = JSON.stringify(r)
  for (const s of SECRETS) ok(!blob.includes(s), `the reader copy does not contain ${s}`)
  ok(!('writerPriv' in r.collab!) && !('ownerPriv' in r.collab!) && !('invite' in r.collab!),
     'writerPriv, ownerPriv and invite are absent as FIELDS, not merely emptied')
  ok(r.collab?.role === 'reader' && r.collab?.on === true, 'it is a live reader')
  ok(r.collab?.room === 'w-room' && r.collab?.key === 'ROOM-READ-KEY',
     'and keeps the room and read key it needs to follow the session')
  ok(r.collab?.sync === undefined, 'with no sync state of the source\'s')
  ok((src.collab as { writerPriv?: string }).writerPriv === 'WRITER-PRIVATE', 'and the OPEN document is untouched')

  // the ordinary case, from a room type itself mints
  const fresh = { ...emptyDoc(), collab: await mintCollab() } as TypeDoc
  const r2 = readerCopy(fresh)
  ok(!('ownerPriv' in r2.collab!) && !('writerPriv' in r2.collab!) && !('invite' in r2.collab!),
     'a copy of a document type minted itself is clean too')
}

console.log('\nan editor copy writes only through its own invite\n')
{
  const src = arrived()
  const ownerPriv = (await mintCollab()).ownerPriv as string   // a real key, so mintInvite can sign
  const e = await inviteCopy(src, ownerPriv)
  const blob = JSON.stringify(e)
  ok(!blob.includes('WRITER-PRIVATE'), 'no legacy writer key — it would be a second way in no revocation reaches')
  ok(!blob.includes('OWNER-PRIVATE'), 'no owner key')
  ok(!blob.includes('INVITE-PRIVATE') && e.collab?.invite?.pub !== 'INV-PUB',
     'and the invite is a FRESH one, never the source\'s own')
  ok(e.collab?.invite?.role === 'writer' && e.collab?.on === true, 'a live editor invite')
}

// The allowlist bar (security, 2026-10-04): every builder, from ONE source
// carrying every known secret, an unknown field and a JSON own __proto__ key —
// only the allowlist survives, nothing by name and nothing new by accident. (The
// whole-block default drop is docForExport's, pinned in test-export-secrets.ts.)
console.log('\nevery builder, from one poisoned source\n')
{
  const poisoned = arrived()
  const pc = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
  Object.assign(pc, poisoned.collab, {
    writerPriv: 'WRITER-PRIVATE',
    invite: { pub: 'SRC', priv: 'INVITE-PRIVATE', role: 'writer', sig: 's' },
    audience: { invite: { priv: 'AUD-PRIVATE' } },
    sync: { v: 2, tag: 'stamp' }, links: [{ url: 'https://pub' }], futureSecret: 'LEAK',
  })
  poisoned.collab = pc as TypeDoc['collab']

  const READER_KEYS = ['room', 'key', 'owner', 'writerPub', 'on', 'v', 'role']
  const INVITE_KEYS = ['room', 'key', 'owner', 'writerPub', 'on', 'v', 'sync', 'invite', 'role']
  const POISON = ['writerPriv', 'ownerPriv', 'audience', 'futureSecret', 'links']

  const rc = readerCopy(poisoned).collab as Record<string, unknown>
  const ic = (await inviteCopy(poisoned, (await mintCollab()).ownerPriv as string)).collab as Record<string, unknown>

  ok(Object.keys(rc).every((k) => READER_KEYS.includes(k)),
    `reader copy: ONLY reader-allowlist keys survive (${Object.keys(rc).sort().join(',')})`)
  ok(rc.role === 'reader' && rc.sync === undefined, 'reader: role forced reader, no sync stamp')
  ok(Object.keys(ic).every((k) => INVITE_KEYS.includes(k)),
    `invite copy: ONLY invite-allowlist keys survive (${Object.keys(ic).sort().join(',')})`)
  ok(ic.sync !== undefined && (ic.invite as { pub: string }).pub !== 'SRC',
    'invite: keeps sync, carries a FRESH invite not the source\'s')
  ok(ic.role === 'writer', 'invite: top-level role from the fresh writer invite (type mints writer invites only)')
  for (const f of POISON) { ok(!(f in rc), `reader drops ${f}`); ok(!(f in ic), `invite drops ${f}`) }
  ok(!Object.hasOwn(rc, '__proto__') && !Object.hasOwn(ic, '__proto__'), 'neither copy carries a __proto__ own key')
  ok(({} as Record<string, unknown>).polluted === undefined, 'and the __proto__ source key polluted nothing (Object.hasOwn)')

  // the planted bypass: rebuilding collab by SPREADING the source keeps every
  // secret; the exact-key-set check above is what turns that red.
  const bypass = { ...pc, role: 'reader' } as Record<string, unknown>
  ok('writerPriv' in bypass && !Object.keys(bypass).every((k) => READER_KEYS.includes(k)),
    'a spread-the-source bypass FAILS the reader key-set check (not vacuous)')
}

console.log('\nevery copy is minted in share.ts\n')
{
  const collab = read('type/src/collab.ts')
  ok(/inviteCopy\(/.test(collab) && /readerCopy\(/.test(collab), 'collab.ts builds its copies through share.ts')
  ok(!/JSON\.parse\(JSON\.stringify\(store\.doc\)\)/.test(collab), 'and clones none inline')
  // No other type module builds a reader or audience copy by hand.
  const { readdirSync } = await import('node:fs')
  const rogue = readdirSync(new URL('../type/src/', import.meta.url))
    .filter(f => f.endsWith('.ts') && f !== 'share.ts' && f !== 'model.ts')
    .filter(f => /role:\s*'(?:reader|audience)'/.test(read('type/src/' + f)))
  ok(rogue.length === 0, `no copy builder outside share.ts sets a reader/audience role (${rogue.join(', ') || 'none'}) — type builds no audience copies at all`)
}

console.log('\nembedded documents don\'t carry sharing keys out\n')
{
  // An embed's copy of its source document, carrying that document's FULL
  // sharing envelope plus its docId. It is put onto the live body DIRECTLY —
  // not through parseDoc, which now cleans embeds on entry — because the point
  // is a document that reached the live file by another path (a peer's sync op,
  // anything pre-dating the intake scrub). Built through parseDoc, the rows
  // below would pass whether or not the outbound strip existed.
  const ENV = { v: 2, on: true, room: 'w-src', key: 'SRC-READ-KEY', owner: 'SRC-OWNER-PUB', ownerPriv: 'SRC-OWNER-KEY',
                writerPub: 'SRC-WRITER-PUB', writerPriv: 'SRC-WRITER-KEY', invite: { pub: 'SRC-INV-PUB', priv: 'SRC-INVITE-KEY', role: 'writer', sig: 'S' } }
  const SECRETS = ['SRC-READ-KEY', 'SRC-OWNER-KEY', 'SRC-WRITER-KEY', 'SRC-INVITE-KEY']
  const withDirtyEmbed = async (): Promise<TypeDoc> => {
    const r = parseDoc(JSON.stringify({ ...emptyDoc(), body: [{ id: 'p1', kind: 'para', text: 'see the deck' }],
      collab: await mintCollab() }))
    if (!r.ok) throw new Error('fixture did not parse')
    r.doc.body.push({ id: 'e1', kind: 'embed', text: '',
      embed: { app: 'bento/slides', view: '<svg/>', doc: { format: 'bento/slides', docId: 'deck-SRC', title: 'Q3', collab: ENV } } } as never)
    return r.doc
  }
  const embedded = (d: TypeDoc) => (d.body.find(b => b.kind === 'embed') as { embed: { doc: Record<string, unknown> } }).embed.doc
  const clean = (d: TypeDoc) => { const b = JSON.stringify(d.body); return SECRETS.every(x => !b.includes(x)) }

  const src = await withDirtyEmbed()
  ok(!clean(src), 'the fixture really holds an embed carrying a full sharing envelope')

  const r = readerCopy(src)
  ok(clean(r) && !('collab' in embedded(r)), 'a VIEW-ONLY copy carries none of the embedded document\'s keys')
  ok(embedded(r).docId === 'deck-SRC' && embedded(r).title === 'Q3', 'while the embedded document and its docId are kept')

  const own = (await mintCollab()).ownerPriv as string
  const i = await inviteCopy(src, own)
  ok(clean(i) && !('collab' in embedded(i)), 'an EDITOR copy carries none of them either')

  const x = docForExport(src)
  ok(clean(x) && !('collab' in embedded(x)), '"Copy document JSON" (docForExport) carries none of them')
  ok(!('collab' in x), 'and still drops the document\'s own room, as it always has')

  ok(!clean(src) && 'collab' in embedded(src), 'none of the three mutated the OPEN document')

  // Entry: a document arriving through parseDoc (open, Replace from JSON,
  // loadDoc, restore) comes in with its embeds already clean.
  const entering = parseDoc(JSON.stringify({ ...emptyDoc(), body: [{ id: 'e1', kind: 'embed', text: '',
    embed: { app: 'bento/slides', view: '<svg/>', doc: { format: 'bento/slides', docId: 'deck-SRC', collab: ENV } } }] }))
  ok(entering.ok && clean(entering.doc), 'a document ENTERING bento/type has its embeds cleaned on the way in')

  // Leaving to disk: Save and the browser snapshots go through the same strip.
  const main = read('type/src/main.ts'), auto = read('type/src/autosave.ts')
  ok(/saveFile\(withoutEmbeddedCaps\(store\.doc\)/.test(main), 'Save writes the document with its embeds cleaned')
  ok(/putRecovery\(safe\)/.test(auto) && /addVersion\(safe\)/.test(auto) && /const safe = withoutEmbeddedCaps\(doc\)/.test(auto),
     'and so do the recovery snapshot and the version history, which any local page can read')
}

// ════════════════════════════════════════════════════════════════════════════
// WHAT EACH COPY MAY CARRY — the field-class projection.
//
// Every outward copy is built by the kernel's `projectForCopy` with type's
// field-class map (type/src/docclass.ts). This rig runs EVERY outward builder
// type has against two sources:
//
//   FULL    carries a whole earlier draft (revisions), an internal comment
//           thread, a real signature, a real owner key, and a field this build
//           does not declare. Each carries a MARKER string a leak would show.
//   BARE    carries none of the history at all (the absent-field lesson: a rule
//           can quietly skip a field the fixture never had, so every rule is
//           also run against a source that LACKS the field).
//
// The FULL fixture is built through type's own constructors — newThread /
// writeThreads, canon's sign, mintCollab — and then through parseDoc, so it is
// the shape the app actually holds. Before any "the copy does not carry X"
// check, the rig asserts the SOURCE does carry X: a fixture that silently
// lost its comment would make every "no comment in the copy" check pass for
// free, which is how a rig ends up certifying a leak.
//
// Builders (type has exactly these three; there is no duplicate or template
// copy, and print renders HTML without embedding the document):
//   readerCopy   share.ts   tier 'reader'
//   inviteCopy   share.ts   tier 'invite', with and without history
//   docForExport model.ts   tier 'copyJSON' — Copy document JSON AND mail merge
//
// Lives in this rig, not its own file, because this rig is already run by CI
// and every copy checked here is a share copy.

const H = (s: string) => console.log(`\n=== ${s} ===`)

const DRAFT = 'DELETED-DRAFT-WORDING-30-DAYS'
const NOTE = 'INTERNAL-COMMENT-WE-CAN-GO-TO-90'
const FUTURE = 'UNDECLARED-FUTURE-FIELD-VALUE'

async function full(): Promise<{ doc: TypeDoc; ownerPriv: string }> {
  const collab = await mintCollab()
  const d = { ...emptyDoc(), title: 'Services Agreement', collab } as TypeDoc
  d.body = [{ id: 'p1', kind: 'para', text: 'Payment is due within 60 days.' }]
  d.revisions = [{ id: 'rev1', at: '2026-10-01T00:00:00.000Z', label: 'Revision 1',
                   body: [{ id: 'p1', kind: 'para', text: DRAFT }] }]
  writeThreads(d, [newThread(d.body[0], 0, 7, 'Bob', NOTE)])
  d.historySalt = newHistorySalt()   // the first signature mints it, in the document
  { const sg = await sign(d, await newKey(), { name: 'Alice', prev: null }); d.signatures = { [sigId(d.docId, sg)]: sg } }
  ;(d as Record<string, unknown>).futureField = FUTURE
  const r = parseDoc(JSON.stringify(d))
  if (!r.ok) throw new Error('FULL fixture did not parse')
  return { doc: r.doc, ownerPriv: collab.ownerPriv as string }
}

async function bare(): Promise<{ doc: TypeDoc; ownerPriv: string }> {
  const collab = await mintCollab()
  const raw = { ...emptyDoc(), collab } as Record<string, unknown>
  raw.body = [{ id: 'p1', kind: 'para', text: 'Payment is due within 60 days.' }]
  delete raw.revisions; delete raw.signatures; delete raw.comments
  const r = parseDoc(JSON.stringify(raw))
  if (!r.ok) throw new Error('BARE fixture did not parse')
  return { doc: r.doc, ownerPriv: collab.ownerPriv as string }
}

const has = (o: unknown, s: string) => JSON.stringify(o).includes(s)
const carriesHistory = (o: TypeDoc) =>
  (o.revisions?.length ?? 0) > 0 || o.comments !== undefined || o.historySalt !== undefined

H('the FULL fixture really carries everything a leak would show')
const F = await full()
ok(has(F.doc, DRAFT), 'the source holds a whole earlier draft in revisions')
ok(has(F.doc, NOTE), 'the source holds an internal comment thread (it survived parseDoc)')
ok(Object.keys(F.doc.signatures).length === 1, 'the source holds a real signature')
ok(typeof F.doc.historySalt === 'string' && F.doc.historySalt.length === 22,
   'and the history salt that signature committed under (it survived parseDoc)')
ok(has(F.doc, FUTURE), 'the source holds a field this build does not declare')
ok(typeof (F.doc.collab as { ownerPriv?: string }).ownerPriv === 'string', 'the source holds a real owner private key')

H('a VIEW-ONLY copy carries no history (tier reader)')
{
  const r = readerCopy(F.doc)
  ok(!has(r, DRAFT), 'no earlier draft — the wording negotiated away stays here')
  ok(!has(r, NOTE), 'no internal comment')
  // Signatures travel WITH a view-only copy now (canon.ts v2): each signs the
  // content plus a salted commitment to the history, so the copy — no drafts,
  // no salt — verifies them. Run through the real verifyAll on the COPY.
  ok(Object.keys(r.signatures ?? {}).length === 1, 'the signature travels with the view-only copy')
  ok(!('historySalt' in r), 'but the history salt does not — without it the commitment reveals nothing')
  {
    const v = await verifyAll(r as never, r.signatures)
    ok(v.ok && v.entries[0].ok && v.entries[0].why === null,
      'and it VERIFIES on the copy: the content attested is exactly what the copy holds')
    ok(v.entries[0].history === 'not-included',
      'with the history reported NEUTRAL — a view-only copy never carries it')
  }
  for (const k of HISTORY_CLASS) ok(!(k in r), `${k} is absent as a FIELD, not merely emptied`)
  ok(!has(r, FUTURE), 'an undeclared field does not ride along')
  ok(r.readonly === true, 'the copy is read-only (set by the tier, not by the source)')
  ok(!('ownerPriv' in (r.collab as object)), 'and holds no owner key')
  ok(r.collab?.role === 'reader' && r.collab?.on === true, 'and is a live reader')
  ok(r.body[0].text === F.doc.body[0].text && r.title === F.doc.title, 'while the document itself is intact')
}
{
  const B = await bare()
  const r = readerCopy(B.doc)
  ok(r.readonly === true, 'BARE: still read-only — the mode is a property of the tier, not of the source')
  ok(!carriesHistory(r), 'BARE: invents no history')
  ok(r.body[0].text === B.doc.body[0].text, 'BARE: content intact')
}

H('Copy document JSON carries no history and no credentials (tier copyJSON)')
{
  const j = docForExport(F.doc)
  ok(!has(j, DRAFT) && !has(j, NOTE), 'no draft, no comment')
  ok(!('historySalt' in j), 'no history salt')
  ok(Object.keys(j.signatures ?? {}).length === 1, 'the signature is content now, so it travels as text too')
  ok(!('collab' in j), 'no collaboration block at all')
  ok(!has(j, FUTURE), 'no undeclared field')
  ok(j.body[0].text === F.doc.body[0].text && j.docId === F.doc.docId, 'content and identity intact')
  const B = await bare()
  ok(!carriesHistory(docForExport(B.doc)), 'BARE: invents no history')
}

H('mail merge: every letter is a new document with no history (the \'merge\' tier + a fresh identity)')
{
  const a = mergeDoc(F.doc, { Name: 'Ada' }, ['Name'], 'list.bento.html')
  const b = mergeDoc(F.doc, { Name: 'Grace' }, ['Name'], 'list.bento.html')
  ok(a.docId !== b.docId, 'two letters have distinct docIds')
  ok(a.docId !== F.doc.docId && b.docId !== F.doc.docId, 'neither reuses the source document\'s identity')
  for (const [n, m] of [['first', a], ['second', b]] as const) {
    ok(!has(m, DRAFT) && !has(m, NOTE), `the ${n} letter carries no draft and no comment`)
    ok(!Object.keys(m.signatures).length && !m.revisions.length, `the ${n} letter carries no signatures and no revisions`)
    ok(!('collab' in m), `the ${n} letter carries no collaboration block`)
  }
  const B = await bare()
  ok(!carriesHistory(mergeDoc(B.doc, { Name: 'X' }, ['Name'], 's')), 'BARE: invents no history')

  // N letters, N identities. Each is minted in the builder after the tier's
  // identity reset, so each is distinct from the moment it is written and none
  // is the template's — two letters sharing one docId would be two files
  // autosave believes are the same document.
  const N = 7
  const ids = Array.from({ length: N }, (_, i) => mergeDoc(F.doc, { Name: `R${i}` }, ['Name'], 's').docId)
  ok(new Set(ids).size === N, `${N} letters have ${N} distinct docIds`)
  ok(!ids.includes(F.doc.docId), 'and none of them is the source document\'s')
  ok(ids.every(id => typeof id === 'string' && id.length > 0), 'every letter HAS an identity — the reset was followed by a mint')
  const m0 = mergeDoc(F.doc, { Name: 'Z' }, ['Name'], 's')
  ok(m0.readonly === undefined && m0.template === undefined, 'a letter is neither locked nor a template (both modes dropped)')
  ok(m0.merge?.row?.Name === 'Z', 'and still records the row it was merged from')
}

H('mail merge: an EMBEDDED document\'s keys never reach a letter')
{
  // Built RAW, not through parseDoc: parseDoc already strips an embed's keys on
  // intake, so a parsed fixture would carry none and every check below would
  // pass for free. A document held in memory is not guaranteed to have come
  // through parseDoc, and projectForCopy works on top-level fields only — it
  // does not walk into an embed. mergeDoc's pre-strip is what covers this.
  const src = { ...emptyDoc(), title: 'Letter' } as TypeDoc
  src.body = [
    { id: 'p1', kind: 'para', text: 'See the attached figures.' },
    { id: 'e1', kind: 'embed', text: '',
      embed: { app: 'bento/dash', view: '<svg/>',
               doc: { format: 'bento/dash', title: 'Q3',
                      collab: { room: 'w-embed', key: 'EMBED-READ-CAP', ownerPriv: 'EMBED-OWNER-PRIV' } } } } as never,
  ]
  ok(has(src, 'EMBED-OWNER-PRIV') && has(src, 'EMBED-READ-CAP'),
    'the SOURCE really carries an embedded document\'s owner key and read cap')
  const letter = mergeDoc(src, { Name: 'Ada' }, ['Name'], 's')
  ok(!has(letter, 'EMBED-OWNER-PRIV'), 'the letter carries no embedded owner key')
  ok(!has(letter, 'EMBED-READ-CAP'), 'and no embedded read capability')
  ok(has(letter, 'Q3') && letter.body.some(b => b.kind === 'embed'),
    'while the embed itself — its content — is still in the letter')
}

H('an INVITE keeps history by default, and leaves it out when asked (tier invite)')
{
  const keep = await inviteCopy(F.doc, F.ownerPriv)
  ok(has(keep, DRAFT) && has(keep, NOTE) && Object.keys(keep.signatures).length === 1,
    'by default the invitee gets the history — the kernel\'s invite rule')
  ok(!('ownerPriv' in (keep.collab as object)), 'but never the owner key')
  ok(keep.collab?.on === true, 'and joins live')
  ok(!has(keep, FUTURE), 'an undeclared field stays behind even here — an invite is a file for someone else')
  ok(keep.readonly !== true, 'an editor copy is not read-only')

  const out = await inviteCopy(F.doc, F.ownerPriv, { withHistory: false })
  for (const k of HISTORY_CLASS) ok(!(k in out), `"Leave version history out" drops ${k}`)
  ok(!has(out, DRAFT) && !has(out, NOTE), 'so the earlier draft and the comment are gone')
  ok(out.body[0].text === F.doc.body[0].text, 'and the document itself is untouched')
  ok(out.collab?.on === true && !!(out.collab as { invite?: unknown }).invite, 'still a working invite')

  const B = await bare()
  ok(!carriesHistory(await inviteCopy(B.doc, B.ownerPriv)), 'BARE: invents no history')
}

H('the class map is the single source')
{
  ok(TYPE_FIELDS.revisions === 'history' && TYPE_FIELDS.comments === 'history' &&
     TYPE_FIELDS.historySalt === 'history', 'revisions, comments and the history salt are history')
  ok(TYPE_FIELDS.signatures === 'content',
     'signatures are content: they sign a commitment to the history, not the history')
  ok([...HISTORY_CLASS].sort().join() === 'comments,historySalt,revisions',
    'the invite opt-out list is DERIVED from the map, not hand-listed')
}

H('Replace from JSON brings CONTENT, never history')
{
  // Copy document JSON leaves history out (tier copyJSON), so before this rule
  // pasting it straight back silently emptied every history field: the
  // ordinary AI round trip deleted the document's revisions and comments.
  // The rule (same as bento/spaces'): a paste never installs history — every
  // history-class field keeps the LIVE value, whatever the paste carries.
  const store = new Store(JSON.parse(JSON.stringify(F.doc)))
  const liveRevs = JSON.stringify(store.doc.revisions)
  const liveNotes = JSON.stringify(store.doc.comments)
  ok(has(store.doc, DRAFT) && has(store.doc, NOTE), 'the live document has history to lose (a draft and a comment)')

  // 1. the unchanged round trip
  const pasted = parseDoc(JSON.stringify(docForExport(store.doc)))
  ok(pasted.ok && !has(pasted.doc, DRAFT), 'the pasted Copy JSON really carries no history')
  store.replace(keepLiveHistory(store.doc, (pasted as { doc: TypeDoc }).doc))
  ok(JSON.stringify(store.doc.revisions) === liveRevs, 'an unchanged round trip keeps every revision')
  ok(JSON.stringify(store.doc.comments) === liveNotes, 'and every comment thread')

  // 2. a paste carrying DIFFERENT history does not install it
  const forged = JSON.parse(JSON.stringify(docForExport(store.doc)))
  forged.revisions = [{ id: 'evil', at: 'x', label: 'Forged', body: [{ id: 'p1', kind: 'para', text: 'FORGED-DRAFT' }] }]
  forged.comments = { evil: { id: 'evil', text: 'FORGED-NOTE', author: 'Mallory', at: 'x', replies: [],
                              anchor: { block: F.doc.body[0].id, from: 0, to: 3 } } }
  forged.body[0].text = 'Payment is due within 90 days.'
  const fp = parseDoc(JSON.stringify(forged))
  ok(fp.ok && has(fp.doc, 'FORGED-DRAFT'), 'the forged paste really carries its own revisions')
  store.replace(keepLiveHistory(store.doc, (fp as { doc: TypeDoc }).doc))
  ok(!has(store.doc, 'FORGED-DRAFT') && JSON.stringify(store.doc.revisions) === liveRevs,
    'a paste cannot install or swap revisions')
  ok(!has(store.doc, 'FORGED-NOTE') && JSON.stringify(store.doc.comments) === liveNotes,
    'nor comment threads')
  ok(store.doc.body[0].text === 'Payment is due within 90 days.', 'while its CONTENT does land — that is what a paste is for')

  // 3. a document with NO history: a paste carrying some does not give it any
  const bareStore = new Store(JSON.parse(JSON.stringify((await bare()).doc)))
  const withRevs = JSON.parse(JSON.stringify(bareStore.doc))
  withRevs.revisions = [{ id: 'r', at: 'x', label: 'R', body: [] }]
  const wp = parseDoc(JSON.stringify(withRevs))
  bareStore.replace(keepLiveHistory(bareStore.doc, (wp as { doc: TypeDoc }).doc))
  ok((bareStore.doc.revisions ?? []).length === 0, 'a document with no history gets none from a paste')

  // 4. both paste paths in main.ts go through it (DOM code, so checked by source)
  const main = readFileSync(new URL('../type/src/main.ts', import.meta.url), 'utf8')
  const replaceBody = main.slice(main.indexOf('onReplaceDoc: json =>'), main.indexOf('onRestoreDoc:'))
  const loadBody = main.slice(main.indexOf('loadDoc: (json: string) =>'), main.indexOf('i18n: i18nApi'))
  ok(/store\.replace\(keepLiveHistory\(store\.doc, parsed\.doc\)\)/.test(replaceBody),
    'Replace from JSON… replaces through keepLiveHistory')
  ok(/store\.replace\(keepLiveHistory\(store\.doc, parsed\.doc\)\)/.test(loadBody),
    'and so does bento.loadDoc, its scripted twin')
  ok(!/store\.replace\(parsed\.doc\)/.test(replaceBody + loadBody), 'neither replaces with the raw paste')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
